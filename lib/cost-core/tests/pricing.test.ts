/**
 * Pricing rules that must not drift.
 *
 * Each case here encodes a decision the UI depends on: reporting a price for the wrong period,
 * silently billing an unknown model at zero, or charging a cache write at the discounted rate would
 * all make the displayed cost wrong in a way a reader cannot notice.
 */

import { describe, expect, test } from 'bun:test'

import { computeInstant, type BillingClock } from '@useful-dsh/tz'

import {
  CNY_RATE_TABLE,
  DEEPSEEK_PEAK_SCHEDULE,
  PRICING_CAPTURED_AT,
  USD_RATE_TABLE,
  mergeSummaries,
  priceAttempt,
  resolveModelKey,
  selectGeneration,
  summarize,
  summarizeComposition,
  type RateBuckets,
  type UsageAttempt,
} from '../src/index.ts'

const SHENZHEN: BillingClock = { timezone: 'Asia/Shanghai', locale: 'zh-CN' }
const LOS_ANGELES: BillingClock = { timezone: 'America/Los_Angeles', locale: 'en-US' }

/** Epoch ms of a Beijing-time wall clock. */
function beijing(year: number, month: number, day: number, hour = 0, minute = 0): number {
  return Date.UTC(year, month - 1, day, hour - 8, minute, 0)
}

function attempt(
  at: number,
  model = 'deepseek-flash',
  tokens?: Partial<RateBuckets>,
): UsageAttempt {
  return {
    turn: 1,
    step: 1,
    at,
    provider: 'deepseek-official',
    model,
    tokens: { input: 0, cacheRead: 0, output: 0, ...tokens },
  }
}

/**
 * A Beijing-time instant that falls in the requested period. Cases that assert money must pin the
 * period explicitly: a hardcoded date can land on a weekend or outside the peak windows, and the
 * assertion would then check against a different published rate without anyone noticing.
 */
function instantIn(period: 'peak' | 'offpeak'): number {
  const candidates = [
    beijing(2026, 9, 17, 10), // Thursday, inside the morning window
    beijing(2026, 9, 17, 20), // Thursday, after the windows
    beijing(2026, 9, 17, 13), // Thursday, the lunch gap
  ]
  for (const candidate of candidates) {
    if (computeInstant(DEEPSEEK_PEAK_SCHEDULE, SHENZHEN, candidate).period === period) {
      return candidate
    }
  }
  throw new Error(`no probe instant lands in ${period}`)
}

/** The exact expected cost for one bucket set under an explicit price row. */
function expected(
  buckets: RateBuckets,
  prices: { input: number; cacheRead: number; cacheWrite?: number; output: number },
): number {
  return (
    (buckets.input * prices.input +
      buckets.cacheRead * prices.cacheRead +
      (buckets.cacheWrite ?? 0) * (prices.cacheWrite ?? prices.input) +
      buckets.output * prices.output) /
    1_000_000
  )
}

describe('peak schedule', () => {
  test('a weekday morning inside the peak window bills at the peak rate', () => {
    // 2026-09-17 is a Thursday.
    const instant = computeInstant(DEEPSEEK_PEAK_SCHEDULE, SHENZHEN, beijing(2026, 9, 17, 10))
    expect(instant.period).toBe('peak')
  })

  test('the lunch break between the two windows bills at the off-peak rate', () => {
    const instant = computeInstant(DEEPSEEK_PEAK_SCHEDULE, SHENZHEN, beijing(2026, 9, 17, 13))
    expect(instant.period).toBe('offpeak')
  })

  test('the window start is inclusive and the window end is exclusive', () => {
    const start = computeInstant(DEEPSEEK_PEAK_SCHEDULE, SHENZHEN, beijing(2026, 9, 17, 9, 0))
    const end = computeInstant(DEEPSEEK_PEAK_SCHEDULE, SHENZHEN, beijing(2026, 9, 17, 12, 0))
    expect(start.period).toBe('peak')
    expect(end.period).toBe('offpeak')
  })

  test('a weekend bills at the off-peak rate all day even inside a peak window', () => {
    // 2026-09-19 is a Saturday.
    const saturday = computeInstant(DEEPSEEK_PEAK_SCHEDULE, SHENZHEN, beijing(2026, 9, 19, 10))
    expect(saturday.period).toBe('offpeak')
  })

  test('a weekend is off-peak under the published weekday-only rule', () => {
    // 2026-08-22 is a Saturday; the published schedule restricts peak to Mon–Fri,
    // so the weekend needs no separate rule to be off-peak.
    const instant = computeInstant(DEEPSEEK_PEAK_SCHEDULE, SHENZHEN, beijing(2026, 8, 22, 10))
    expect(instant.period).toBe('offpeak')
  })

  test('the next transition is found exactly at the window boundary', () => {
    const instant = computeInstant(DEEPSEEK_PEAK_SCHEDULE, SHENZHEN, beijing(2026, 9, 17, 11, 59))
    expect(instant.nextTransitionAt).toBe(beijing(2026, 9, 17, 12))
    expect(instant.nextPeriod).toBe('offpeak')
  })

  test('a reader in another zone sees the same billed period for the same instant', () => {
    const at = beijing(2026, 9, 17, 10)
    const here = computeInstant(DEEPSEEK_PEAK_SCHEDULE, SHENZHEN, at)
    const abroad = computeInstant(DEEPSEEK_PEAK_SCHEDULE, LOS_ANGELES, at)
    expect(abroad.period).toBe(here.period)
    // ...while their local calendar day differs, which is why both are reported.
    expect(abroad.localDayKey).not.toBe(here.localDayKey)
    expect(abroad.billedDayKey).toBe(here.billedDayKey)
  })
})

describe('model id resolution', () => {
  test('billed ids resolve to themselves', () => {
    expect(resolveModelKey(CNY_RATE_TABLE, 'deepseek-flash')).toBe('deepseek-flash')
    expect(resolveModelKey(CNY_RATE_TABLE, 'deepseek-v4-pro')).toBe('deepseek-v4-pro')
  })

  test('retired and alternative ids resolve to the routed model', () => {
    expect(resolveModelKey(CNY_RATE_TABLE, 'deepseek-v4-flash')).toBe('deepseek-flash')
    expect(resolveModelKey(CNY_RATE_TABLE, 'deepseek-chat')).toBe('deepseek-flash')
  })

  test('a dated build stamp resolves to its model', () => {
    expect(resolveModelKey(CNY_RATE_TABLE, 'deepseek-v4-flash-2026-01-31')).toBe('deepseek-flash')
  })

  test('an unrelated model is not silently aliased onto a known one', () => {
    expect(resolveModelKey(CNY_RATE_TABLE, 'deepseek-v99-flash')).toBeNull()
  })

  test('a provider-suffixed routed id resolves to the model it names', () => {
    // Seen in a real session log: the provider appends an expiry stamp, and an
    // unresolved id would show the whole session as unpriced.
    expect(resolveModelKey(CNY_RATE_TABLE, 'deepseek-v4.1-flash-expires-on-0910')).toBe(
      'deepseek-flash',
    )
  })

  test('the id a real log carried resolves, and bills at its own generation', () => {
    const at = beijing(2026, 9, 5, 20)
    const instant = computeInstant(DEEPSEEK_PEAK_SCHEDULE, SHENZHEN, at)
    const priced = priceAttempt(
      CNY_RATE_TABLE,
      attempt(at, 'deepseek-v4.1-flash-expires-on-0910', { input: 1_000_000 }),
      instant,
    )
    // 2026-09-05 falls in the generation introduced on 2026-08-17, whose
    // off-peak input rate was ¥1.5/M.
    expect(priced.identity?.model).toBe('deepseek-flash')
    expect(priced.identity?.generation).toBe(1)
    expect(priced.cost).toBeCloseTo(1.5, 10)
  })

  test('a longer name that merely starts with a model id stays unpriced', () => {
    // No separator boundary, so this is a different model rather than a suffixed
    // spelling of one we know; it must be reported instead of billed as flash.
    expect(resolveModelKey(CNY_RATE_TABLE, 'deepseek-flashback')).toBeNull()
    expect(resolveModelKey(CNY_RATE_TABLE, 'deepseek-v99')).toBeNull()
  })
})

describe('price generations', () => {
  test('the newest generation at or before the sample wins', () => {
    const before = selectGeneration(CNY_RATE_TABLE, 'deepseek-flash', beijing(2026, 9, 9, 23))
    const after = selectGeneration(CNY_RATE_TABLE, 'deepseek-flash', beijing(2026, 9, 10, 0))
    expect(before?.index).toBe(1)
    expect(after?.index).toBe(2)
  })

  test('an old sample keeps the rates that were in force then', () => {
    // 2026-08-01 is a Saturday before the first window, so it bills at the
    // pre-cutover flat rate of ¥1/M.
    const instant = computeInstant(DEEPSEEK_PEAK_SCHEDULE, SHENZHEN, beijing(2026, 8, 1, 8))
    const priced = priceAttempt(
      CNY_RATE_TABLE,
      attempt(instant.at, 'deepseek-flash', { input: 1_000_000 }),
      instant,
    )
    expect(priced.cost).toBeCloseTo(1, 10)
    expect(priced.identity?.generation).toBe(0)
  })

  test('a weekday before the cutover still bills its own flat rate', () => {
    // 2026-08-03 is a Monday, inside the published peak window.
    const instant = computeInstant(DEEPSEEK_PEAK_SCHEDULE, SHENZHEN, beijing(2026, 8, 3, 10))
    const priced = priceAttempt(
      CNY_RATE_TABLE,
      attempt(instant.at, 'deepseek-flash', { input: 1_000_000 }),
      instant,
    )
    expect(instant.period).toBe('peak')
    // The flat pre-cutover rate was ¥1/M and did not vary by period.
    expect(priced.cost).toBeCloseTo(1, 10)
  })
})

describe('cost computation', () => {
  const buckets: RateBuckets = {
    input: 282_306,
    cacheRead: 121_219_712,
    output: 219_685,
  }

  test('each bucket is charged at its own rate, with no flat discount', () => {
    const at = instantIn('offpeak')
    const instant = computeInstant(DEEPSEEK_PEAK_SCHEDULE, SHENZHEN, at)
    const priced = priceAttempt(CNY_RATE_TABLE, attempt(at, 'deepseek-flash', buckets), instant)
    expect(instant.period).toBe('offpeak')
    const published = { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 }
    expect(priced.cost).toBeCloseTo(expected(buckets, published), 10)
    // Hand-computed at the published off-peak row: 0.28 + 2.42 + 0.88 = ¥3.59.
    // The cache read is the largest line despite being 430x the token volume of
    // the uncached input, which is the whole reason the display separates them.
    expect(priced.cost).toBeCloseTo(3.58544024, 8)
  })

  test('the same usage during peak costs exactly the published multiple', () => {
    const offpeak = instantIn('offpeak')
    const peak = instantIn('peak')
    const low = priceAttempt(
      CNY_RATE_TABLE,
      attempt(offpeak, 'deepseek-flash', buckets),
      computeInstant(DEEPSEEK_PEAK_SCHEDULE, SHENZHEN, offpeak),
    )
    const high = priceAttempt(
      CNY_RATE_TABLE,
      attempt(peak, 'deepseek-flash', buckets),
      computeInstant(DEEPSEEK_PEAK_SCHEDULE, SHENZHEN, peak),
    )
    expect(high.cost).toBeCloseTo((low.cost ?? 0) * 2, 10)
  })

  test('a missing cache-write line is charged at the uncached input rate', () => {
    const at = instantIn('offpeak')
    const instant = computeInstant(DEEPSEEK_PEAK_SCHEDULE, SHENZHEN, at)
    const withWrite = priceAttempt(
      CNY_RATE_TABLE,
      attempt(at, 'deepseek-flash', { cacheWrite: 1_000_000 }),
      instant,
    )
    const asInput = priceAttempt(
      CNY_RATE_TABLE,
      attempt(at, 'deepseek-flash', { input: 1_000_000 }),
      instant,
    )
    expect(withWrite.cost).toBeCloseTo(asInput.cost ?? 0, 10)
  })

  test('the USD book prices in dollars without converting the CNY one', () => {
    const at = instantIn('offpeak')
    const instant = computeInstant(DEEPSEEK_PEAK_SCHEDULE, SHENZHEN, at)
    const usd = priceAttempt(USD_RATE_TABLE, attempt(at, 'deepseek-flash', buckets), instant)
    const cny = priceAttempt(CNY_RATE_TABLE, attempt(at, 'deepseek-flash', buckets), instant)
    expect(usd.cost).not.toBeNull()
    expect(usd.cost ?? 0).toBeLessThan(cny.cost ?? 0)
  })
})

describe('unpriced attempts', () => {
  test('an unknown model reports why instead of costing zero', () => {
    const at = instantIn('offpeak')
    const instant = computeInstant(DEEPSEEK_PEAK_SCHEDULE, SHENZHEN, at)
    const priced = priceAttempt(CNY_RATE_TABLE, attempt(at, 'some-other-model'), instant)
    expect(priced.cost).toBeNull()
    expect(priced.unpriced).toBe('unknown-model')
  })

  test('unsafe token counts are rejected rather than summed', () => {
    const at = instantIn('offpeak')
    const instant = computeInstant(DEEPSEEK_PEAK_SCHEDULE, SHENZHEN, at)
    const priced = priceAttempt(
      CNY_RATE_TABLE,
      attempt(at, 'deepseek-flash', { input: Number.NaN }),
      instant,
    )
    expect(priced.cost).toBeNull()
    expect(priced.unpriced).toBe('invalid-tokens')
  })

  test('a zero-usage attempt costs zero without being called unpriced', () => {
    const at = instantIn('offpeak')
    const instant = computeInstant(DEEPSEEK_PEAK_SCHEDULE, SHENZHEN, at)
    const priced = priceAttempt(CNY_RATE_TABLE, attempt(at, 'deepseek-flash'), instant)
    expect(priced.cost).toBe(0)
    expect(priced.unpriced).toBeNull()
  })
})

describe('cost composition', () => {
  test('splits one attempt by bucket at its own rate', () => {
    const at = instantIn('offpeak')
    const instant = computeInstant(DEEPSEEK_PEAK_SCHEDULE, SHENZHEN, at)
    const buckets = { input: 1_000_000, cacheRead: 10_000_000, output: 2_000_000 }
    const row = selectGeneration(CNY_RATE_TABLE, 'deepseek-flash', at)
    expect(row).not.toBeNull()
    const composition = summarizeComposition(CNY_RATE_TABLE, [
      { attempt: attempt(at, 'deepseek-flash', buckets), instant },
    ])
    const prices = row?.prices.offpeak
    expect(composition.uncachedInput).toBeCloseTo(prices?.input ?? 0, 10)
    expect(composition.cachedInput).toBeCloseTo((prices?.cacheRead ?? 0) * 10, 10)
    expect(composition.output).toBeCloseTo((prices?.output ?? 0) * 2, 10)
    expect(composition.cacheWrite).toBe(0)
    expect(composition.total).toBeCloseTo(
      composition.uncachedInput + composition.cachedInput + composition.output,
      10,
    )
    expect(composition.unpricedAttempts).toBe(0)
  })

  test('prices each attempt at its own model instead of one representative rate', () => {
    // The panel used to multiply a whole session's buckets by one hardcoded model's
    // off-peak row, so a Pro session reported the cheap model's split — a
    // composition that contradicted the total printed above it.
    const at = instantIn('offpeak')
    const instant = computeInstant(DEEPSEEK_PEAK_SCHEDULE, SHENZHEN, at)
    const tokens = { input: 1_000_000, cacheRead: 0, output: 0 }
    const pro = summarizeComposition(CNY_RATE_TABLE, [
      { attempt: attempt(at, 'deepseek-v4-pro', tokens), instant },
    ])
    const flash = summarizeComposition(CNY_RATE_TABLE, [
      { attempt: attempt(at, 'deepseek-flash', tokens), instant },
    ])
    expect(pro.uncachedInput).toBeGreaterThan(flash.uncachedInput)
  })

  test('the same tokens cost more in peak than off-peak', () => {
    const tokens = { input: 1_000_000, cacheRead: 0, output: 0 }
    const peakAt = instantIn('peak')
    const offpeakAt = instantIn('offpeak')
    const peak = summarizeComposition(CNY_RATE_TABLE, [
      {
        attempt: attempt(peakAt, 'deepseek-flash', tokens),
        instant: computeInstant(DEEPSEEK_PEAK_SCHEDULE, SHENZHEN, peakAt),
      },
    ])
    const offpeak = summarizeComposition(CNY_RATE_TABLE, [
      {
        attempt: attempt(offpeakAt, 'deepseek-flash', tokens),
        instant: computeInstant(DEEPSEEK_PEAK_SCHEDULE, SHENZHEN, offpeakAt),
      },
    ])
    expect(peak.total).toBeCloseTo(offpeak.total * 2, 10)
  })

  test('an unpriced attempt is counted, never priced at zero', () => {
    const at = instantIn('offpeak')
    const instant = computeInstant(DEEPSEEK_PEAK_SCHEDULE, SHENZHEN, at)
    const composition = summarizeComposition(CNY_RATE_TABLE, [
      { attempt: attempt(at, 'some-other-model', { input: 1_000_000 }), instant },
    ])
    expect(composition.total).toBe(0)
    expect(composition.unpricedAttempts).toBe(1)
  })
})

describe('merging summaries', () => {
  test('adds two summaries in the same currency', () => {
    const at = instantIn('offpeak')
    const instant = computeInstant(DEEPSEEK_PEAK_SCHEDULE, SHENZHEN, at)
    const one = summarize(CNY_RATE_TABLE, [
      { attempt: attempt(at, 'deepseek-flash', { input: 1_000_000 }), instant },
    ])
    const merged = mergeSummaries([one, one], 'CNY')
    expect(merged.total).toBeCloseTo((one.total ?? 0) * 2, 10)
  })

  test('refuses to add a summary in another currency', () => {
    // CNY and USD are separate published lists. Adding them yields a number in no
    // currency at all, so a mismatched pair must fail loudly rather than render.
    const usd = summarize(USD_RATE_TABLE, [], 'USD')
    expect(() => mergeSummaries([usd], 'CNY')).toThrow(
      /cannot merge a USD summary into a CNY total/,
    )
  })
})

describe('shipped price book', () => {
  test('the capture date is recorded so a stale book is visible in the UI', () => {
    expect(PRICING_CAPTURED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  test('the current flash row matches the published figures', () => {
    // Transcribed from the pricing page: $0.15 / $0.003 / $0.6 off-peak and
    // double that at peak, per million tokens.
    const row = USD_RATE_TABLE.models['deepseek-flash']?.updates?.at(-1)
    expect(row?.offpeak).toEqual({ input: 0.15, cacheRead: 0.003, output: 0.6 })
    expect(row?.peak).toEqual({ input: 0.3, cacheRead: 0.006, output: 1.2 })
  })

  test('the renminbi book carries the figures the Chinese page publishes', () => {
    // ¥1 / ¥0.02 / ¥4 per million off-peak, doubled at peak. These are NOT the
    // dollar rows times ten: the renminbi list is a regional price list of its
    // own, and deriving it at a single rate overstates every figure by half.
    const flash = CNY_RATE_TABLE.models['deepseek-flash']?.updates?.at(-1)
    expect(flash?.offpeak).toEqual({ input: 1, cacheRead: 0.02, output: 4 })
    expect(flash?.peak).toEqual({ input: 2, cacheRead: 0.04, output: 8 })
    const pro = CNY_RATE_TABLE.models['deepseek-v4-pro']?.updates?.at(-1)
    expect(pro?.offpeak).toEqual({ input: 4.5, cacheRead: 0.15, output: 13.5 })
    expect(pro?.peak).toEqual({ input: 9, cacheRead: 0.3, output: 27 })
  })

  test('the two books are transcribed separately, not converted from one another', () => {
    // The failure this guards: the renminbi book was the dollar book times ten,
    // which rendered ¥6.11 for usage the account is billed ¥4.07 for. A single
    // ratio cannot produce both lists, so no row may sit at exactly ten times
    // its dollar counterpart.
    const cny = CNY_RATE_TABLE.models['deepseek-flash']?.updates?.at(-1)
    const usd = USD_RATE_TABLE.models['deepseek-flash']?.updates?.at(-1)
    expect(cny?.offpeak.input).toBe(1)
    expect((cny?.offpeak.input ?? 0) / (usd?.offpeak.input ?? 1)).not.toBe(10)
  })

  test('V4-Pro keeps its own rates, as the pricing page states', () => {
    // The page's note (2) says V4-Pro continues past 2026-09-14 "with the billing
    // method remaining unchanged"; a community table claiming it moved onto Flash
    // pricing is contradicted there, and this pins the official reading.
    const pro = USD_RATE_TABLE.models['deepseek-v4-pro']?.updates?.at(-1)
    expect(pro?.offpeak).toEqual({ input: 0.66, cacheRead: 0.022, output: 1.98 })
    const flash = USD_RATE_TABLE.models['deepseek-flash']?.updates?.at(-1)
    expect(pro?.offpeak.input).not.toBe(flash?.offpeak.input)
  })

  test('peak rates are exactly twice the off-peak rates in both books', () => {
    for (const table of [CNY_RATE_TABLE, USD_RATE_TABLE]) {
      for (const [id, model] of Object.entries(table.models)) {
        const rows = [model.base, ...(model.updates ?? [])]
        for (const row of rows) {
          for (const bucket of ['input', 'cacheRead', 'cacheWrite', 'output'] as const) {
            const peak = row.peak[bucket]
            const offpeak = row.offpeak[bucket]
            if (peak === undefined || offpeak === undefined) continue
            // The pre-2026-08-17 generations are flat: one rate all day, so the
            // doubling rule only applies once a period split exists at all.
            if (peak === offpeak) continue
            // The published USD cache-read rates are rounded to three decimals
            // (0.003 / 0.006, 0.008 / 0.015), so the relation is checked to
            // within half of the last published digit rather than exactly.
            const deviation = Math.abs(peak - offpeak * 2)
            if (deviation > 0.0005) {
              throw new Error(
                `${id} ${bucket}: peak ${peak} is not twice off-peak ${offpeak} (deviation ${deviation})`,
              )
            }
          }
        }
      }
    }
  })
})
