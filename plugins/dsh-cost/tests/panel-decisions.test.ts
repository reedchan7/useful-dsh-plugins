/**
 * What the panel decides before it renders.
 *
 * Three of the panel's rows are conditional in ways a reader notices: a partial cache hit must
 * never read as a full one, an unpriced model must be named even when it belongs to a session the
 * reader never opened, and the countdown must be left out rather than pointed at the current
 * moment. These cases pin those decisions without a DOM.
 */

import { describe, expect, test } from 'bun:test'

import {
  compositionRows,
  nextSwitchOf,
  todayFigureOf,
  unpricedModelsOf,
  type SummaryPayload,
} from '../src/client/CostPill.ts'

function payload(overrides: Partial<SummaryPayload>): SummaryPayload {
  return { ok: true, currency: 'CNY', generatedAt: 0, ...overrides }
}

describe('unpriced models on screen', () => {
  test('the day total names models the open session never used', () => {
    // "Today" spans the machine, so a model priced nowhere in it has to be named
    // even when it belongs to another session: the warning used to read only the
    // open session's list and left a short total unexplained.
    const models = unpricedModelsOf(
      payload({
        session: {
          total: 1,
          tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
          billedInputTokens: 0,
          pricedAttempts: 1,
          unpriced: [],
          composition: emptyComposition,
          byTurn: [],
          byModel: [],
        },
        today: {
          total: 1,
          sessionTotal: 1,
          tokens: 0,
          sessions: 2,
          projects: 1,
          dayKey: '2026-09-17',
          hourly: [],
          unpriced: ['some-other-model'],
        },
      }),
    )
    expect(models).toEqual(['some-other-model'])
  })

  test('a model named in both scopes is listed once', () => {
    const models = unpricedModelsOf(
      payload({
        session: {
          total: null,
          tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 },
          billedInputTokens: 0,
          pricedAttempts: 0,
          unpriced: ['mystery', 'other'],
          composition: emptyComposition,
          byTurn: [],
          byModel: [],
        },
        today: {
          total: null,
          sessionTotal: null,
          tokens: 0,
          sessions: 1,
          projects: 1,
          dayKey: '2026-09-17',
          hourly: [],
          unpriced: ['mystery'],
        },
      }),
    )
    expect(models).toEqual(['mystery', 'other'])
  })

  test('nothing unpriced is nothing to warn about', () => {
    expect(unpricedModelsOf(payload({}))).toEqual([])
  })
})

describe('the next rate change row', () => {
  test('a complete pair is rendered', () => {
    expect(
      nextSwitchOf(
        payload({ period: { current: 'peak', next: 'offpeak', nextAt: 1_700_000_000 } }),
      ),
    ).toEqual({ at: 1_700_000_000, period: 'offpeak' })
  })

  test('no reported transition means no row', () => {
    // The panel used to fall back to `now`, which renders as a countdown of
    // "0h 00m 00s" — a rate change that never happens.
    expect(nextSwitchOf(payload({ period: { current: 'peak' } }))).toBeNull()
    expect(nextSwitchOf(payload({}))).toBeNull()
  })

  test('half a pair is not a countdown either', () => {
    expect(nextSwitchOf(payload({ period: { current: 'peak', nextAt: 1 } }))).toBeNull()
    expect(nextSwitchOf(payload({ period: { current: 'peak', next: 'peak' } }))).toBeNull()
  })
})

function day(total: number | null, tokens: number): NonNullable<SummaryPayload['today']> {
  return {
    total,
    sessionTotal: null,
    tokens,
    sessions: 1,
    projects: 1,
    dayKey: '2026-09-18',
    hourly: [],
  }
}

describe('the figure the pill shows for today', () => {
  test('a priced day shows its total', () => {
    expect(todayFigureOf(payload({ today: day(1.5, 1000) }))).toBe(1.5)
  })

  test('an idle day reads as zero, not as a dash', () => {
    // Nothing billed today is an ordinary state; "—" made it look like the
    // plugin had lost the figure entirely.
    expect(todayFigureOf(payload({ today: day(null, 0) }))).toBe(0)
  })

  test('usage that priced nowhere keeps the dash', () => {
    expect(todayFigureOf(payload({ today: day(null, 5000) }))).toBeNull()
    expect(todayFigureOf(payload({}))).toBeNull()
  })
})

describe('the composition legend', () => {
  test('the three billed buckets are always named', () => {
    expect(
      compositionRows({ ...emptyComposition, cachedInput: 1, uncachedInput: 2, output: 3 }),
    ).toEqual([
      { key: 'cachedInputCost', value: 1 },
      { key: 'uncachedInputCost', value: 2 },
      { key: 'outputCost', value: 3 },
    ])
  })

  test('a cache write is named only when it cost something', () => {
    expect(compositionRows({ ...emptyComposition, cacheWrite: 0.5 }).map((e) => e.key)).toContain(
      'cacheWriteCost',
    )
    expect(compositionRows(emptyComposition).map((e) => e.key)).not.toContain('cacheWriteCost')
  })

  test('a host that sent no composition shows no rows', () => {
    // Zeros would claim every bucket cost nothing, which is not what a missing
    // field means — it means this host cannot say.
    expect(compositionRows(undefined)).toEqual([])
  })
})

const emptyComposition = {
  cachedInput: 0,
  uncachedInput: 0,
  cacheWrite: 0,
  output: 0,
  total: 0,
  unpricedAttempts: 0,
}
