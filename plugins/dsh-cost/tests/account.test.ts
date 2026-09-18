/**
 * The account-level reading: platform token handling, platform response parsing, billed-day
 * filtering, and the stale-while-revalidate cache the summary route answers from.
 *
 * Figures are asserted against hand-computed expectations (see AGENTS.md): the fixtures below sum
 * to cost 0.007 / cache-hit 4000 / cache-miss 300 / completion 75 inside the queried day, with
 * out-of-day buckets that must be filtered out.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { dayKey, dayStart } from '@useful-dsh/tz'

import {
  ACCOUNT_TIMEZONE,
  createAccountCache,
  deletePlatformToken,
  fetchAccountUsage,
  readPlatformToken,
  sumAccountDay,
  writePlatformToken,
  type AccountFetchResponse,
  type AccountFetcher,
} from '../src/account.ts'

/** One instant inside a fixed billed day: 2026-09-18, 10:00 Beijing. */
const REQUEST_AT = Date.parse('2026-09-18T02:00:00Z')
const DAY_START_MS = dayStart(dayKey(REQUEST_AT, ACCOUNT_TIMEZONE), ACCOUNT_TIMEZONE)
const START_SEC = DAY_START_MS / 1000

/** Platform-shaped response bodies covering two API keys and an out-of-day bucket. */
const AMOUNT_BODY = {
  data: {
    biz_data: {
      bucket: '1h',
      models: ['deepseek-flash'],
      series: [
        {
          buckets: [
            {
              time: START_SEC + 3600,
              usage: {
                PROMPT_CACHE_HIT_TOKEN: 1000,
                PROMPT_CACHE_MISS_TOKEN: 200,
                RESPONSE_TOKEN: 50,
              },
            },
          ],
        },
        {
          buckets: [
            {
              time: START_SEC + 3600,
              usage: {
                PROMPT_CACHE_HIT_TOKEN: 3000,
                PROMPT_CACHE_MISS_TOKEN: 100,
                RESPONSE_TOKEN: 25,
              },
            },
            // Yesterday's tail must not enter the day sum.
            {
              time: START_SEC - 3600,
              usage: {
                PROMPT_CACHE_HIT_TOKEN: 999,
                PROMPT_CACHE_MISS_TOKEN: 999,
                RESPONSE_TOKEN: 999,
              },
            },
          ],
        },
      ],
    },
  },
}

const COST_BODY = {
  data: {
    biz_data: {
      data: [
        {
          currency: 'CNY',
          series: [
            {
              buckets: [
                { time: START_SEC + 3600, cost: 0.005 },
                { time: START_SEC - 3600, cost: 9 },
              ],
            },
          ],
        },
        { currency: 'CNY', series: [{ buckets: [{ time: START_SEC + 3600, cost: 0.002 }] }] },
      ],
    },
  },
}

/** A fetcher answering both endpoints with the given bodies, recording its URLs. */
function fakeFetcher(
  handler: (url: string) => { status: number; body: unknown },
  calls: string[] = [],
): { fetcher: AccountFetcher; calls: string[] } {
  const fetcher = (url: string): Promise<AccountFetchResponse> => {
    calls.push(url)
    const { status, body } = handler(url)
    return Promise.resolve({
      status,
      ok: status >= 200 && status < 300,
      text: () => Promise.resolve(typeof body === 'string' ? body : JSON.stringify(body)),
    })
  }
  return { fetcher, calls }
}

function noop(): void {}

describe('the platform token file', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'dsh-cost-token-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  test('a missing or blank file means no token', () => {
    expect(readPlatformToken(join(dir, 'nope'))).toBeNull()
    const blank = join(dir, 'blank')
    writeFileSync(blank, '  \n')
    expect(readPlatformToken(blank)).toBeNull()
  })

  test('the token is read trimmed', () => {
    const path = join(dir, 'token')
    writeFileSync(path, '  platform-token-123\n')
    expect(readPlatformToken(path)).toBe('platform-token-123')
  })

  test('a written token round-trips and is readable only by this user', () => {
    const path = join(dir, 'token')
    writePlatformToken('platform-token-123', path)
    expect(readPlatformToken(path)).toBe('platform-token-123')
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  test('deleting the token clears it and tolerates a missing file', () => {
    const path = join(dir, 'token')
    writePlatformToken('platform-token-123', path)
    deletePlatformToken(path)
    expect(readPlatformToken(path)).toBeNull()
    deletePlatformToken(path)
  })
})

describe('fetching one billed day from the platform', () => {
  test('both endpoints are queried for the day and merged by bucket', async () => {
    const { fetcher, calls } = fakeFetcher((url) => ({
      status: 200,
      body: url.includes('/amount?') ? AMOUNT_BODY : COST_BODY,
    }))
    const result = await fetchAccountUsage({ token: 't', dayStartMs: DAY_START_MS, fetcher })
    expect(calls).toHaveLength(2)
    expect(calls[0]).toContain(`start=${START_SEC}&end=${START_SEC + 86400}&tz=28800`)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.usage.currency).toBe('CNY')
    const day = sumAccountDay(result.usage, DAY_START_MS)
    // Hand-computed: 0.005 + 0.002 cost, 1000+3000 hit, 200+100 miss, 50+25 completion.
    expect(day.cost).toBeCloseTo(0.007, 10)
    expect(day.cacheHit).toBe(4000)
    expect(day.cacheMiss).toBe(300)
    expect(day.completion).toBe(75)
  })

  test('a rejected token is named, as an HTTP 401 and as a business error code', async () => {
    const unauthorized = await fetchAccountUsage({
      token: 't',
      dayStartMs: DAY_START_MS,
      fetcher: fakeFetcher(() => ({ status: 401, body: {} })).fetcher,
    })
    expect(unauthorized).toEqual({ ok: false, error: 'invalid-token' })

    const businessCode = await fetchAccountUsage({
      token: 't',
      dayStartMs: DAY_START_MS,
      fetcher: fakeFetcher(() => ({ status: 200, body: { code: 40003, msg: 'invalid token' } }))
        .fetcher,
    })
    expect(businessCode).toEqual({ ok: false, error: 'invalid-token' })
  })

  test('the legacy completion field name is accepted as a fallback', async () => {
    const legacy = {
      data: {
        biz_data: {
          series: [
            {
              buckets: [
                {
                  time: START_SEC + 3600,
                  usage: {
                    PROMPT_CACHE_HIT_TOKEN: 0,
                    PROMPT_CACHE_MISS_TOKEN: 0,
                    COMPLETION_TOKEN: 25,
                  },
                },
              ],
            },
          ],
        },
      },
    }
    const { fetcher } = fakeFetcher((url) => ({
      status: 200,
      body: url.includes('/amount?') ? legacy : COST_BODY,
    }))
    const result = await fetchAccountUsage({ token: 't', dayStartMs: DAY_START_MS, fetcher })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(sumAccountDay(result.usage, DAY_START_MS).completion).toBe(25)
  })

  test('other failures map to their own states', async () => {
    const http = await fetchAccountUsage({
      token: 't',
      dayStartMs: DAY_START_MS,
      fetcher: fakeFetcher(() => ({ status: 500, body: 'oops' })).fetcher,
    })
    expect(http).toEqual({ ok: false, error: 'http-error' })

    const garbage = await fetchAccountUsage({
      token: 't',
      dayStartMs: DAY_START_MS,
      fetcher: fakeFetcher(() => ({ status: 200, body: 'not json' })).fetcher,
    })
    expect(garbage).toEqual({ ok: false, error: 'bad-response' })

    const shapeless = await fetchAccountUsage({
      token: 't',
      dayStartMs: DAY_START_MS,
      fetcher: fakeFetcher(() => ({ status: 200, body: { data: {} } })).fetcher,
    })
    expect(shapeless).toEqual({ ok: false, error: 'bad-response' })

    const down = await fetchAccountUsage({
      token: 't',
      dayStartMs: DAY_START_MS,
      fetcher: () => Promise.reject(new Error('ECONNREFUSED')),
    })
    expect(down).toEqual({ ok: false, error: 'unreachable' })
  })
})

describe('the account cache the route answers from', () => {
  test('without a token the state is no-token and the platform is never asked', async () => {
    const { fetcher, calls } = fakeFetcher(() => ({ status: 200, body: {} }))
    const cache = createAccountCache({ fetcher, readToken: () => null })
    await cache.revalidate(REQUEST_AT)
    expect(cache.snapshot().status).toBe('no-token')
    expect(calls).toHaveLength(0)
  })

  test('a fresh reading loads on revalidation and then serves from cache', async () => {
    const { fetcher, calls } = fakeFetcher((url) => ({
      status: 200,
      body: url.includes('/amount?') ? AMOUNT_BODY : COST_BODY,
    }))
    let now = REQUEST_AT
    const cache = createAccountCache({ fetcher, now: () => now, readToken: () => 't' })

    const pending = cache.revalidate(now)
    expect(cache.snapshot().status).toBe('loading')
    await pending
    const settled = cache.snapshot()
    expect(settled.status).toBe('ok')
    expect(settled.cost).toBeCloseTo(0.007, 10)
    expect(settled.tokens).toEqual({ cacheHit: 4000, cacheMiss: 300, completion: 75 })
    expect(settled.currency).toBe('CNY')
    expect(settled.asOf).toBe(now)

    // Within the TTL nothing is refetched; past it, one refresh goes out.
    await cache.revalidate(now + 60_000)
    expect(calls).toHaveLength(2)
    now += 6 * 60 * 1000
    await cache.revalidate(now)
    expect(calls).toHaveLength(4)
  })

  test('a billed-day rollover forces a refresh even inside the TTL', async () => {
    const { fetcher, calls } = fakeFetcher((url) => ({
      status: 200,
      body: url.includes('/amount?') ? AMOUNT_BODY : COST_BODY,
    }))
    let now = REQUEST_AT
    const cache = createAccountCache({ fetcher, now: () => now, readToken: () => 't' })
    await cache.revalidate(now)
    expect(calls).toHaveLength(2)

    now += 24 * 3600 * 1000
    await cache.revalidate(now)
    expect(calls).toHaveLength(4)
  })

  test('a failed refresh keeps the last good figures and names the failure', async () => {
    let failing = false
    const { fetcher } = fakeFetcher((url) =>
      failing
        ? { status: 500, body: 'oops' }
        : { status: 200, body: url.includes('/amount?') ? AMOUNT_BODY : COST_BODY },
    )
    let now = REQUEST_AT
    const cache = createAccountCache({ fetcher, now: () => now, readToken: () => 't' })
    await cache.revalidate(now)
    expect(cache.snapshot().status).toBe('ok')

    failing = true
    now += 6 * 60 * 1000
    await cache.revalidate(now)
    const stale = cache.snapshot()
    expect(stale.status).toBe('http-error')
    expect(stale.cost).toBeCloseTo(0.007, 10)
    expect(stale.tokens).toEqual({ cacheHit: 4000, cacheMiss: 300, completion: 75 })
  })

  test('concurrent revalidations share one in-flight refresh', async () => {
    let release: () => void = noop
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const fetcher: AccountFetcher = (url: string) => {
      calls += 1
      return gate.then(() => ({
        status: 200,
        ok: true,
        text: () =>
          Promise.resolve(JSON.stringify(url.includes('/amount?') ? AMOUNT_BODY : COST_BODY)),
      }))
    }
    const cache = createAccountCache({ fetcher, now: () => REQUEST_AT, readToken: () => 't' })
    const first = cache.revalidate(REQUEST_AT)
    const second = cache.revalidate(REQUEST_AT)
    expect(calls).toBe(2)
    release()
    await first
    await second
    await cache.revalidate(REQUEST_AT)
    expect(calls).toBe(2)
    expect(cache.snapshot().status).toBe('ok')
  })

  test('a reset discards a refresh started under the old token', async () => {
    let release: () => void = noop
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    let calls = 0
    const fetcher: AccountFetcher = (url: string) => {
      calls += 1
      return gate.then(() => ({
        status: 200,
        ok: true,
        text: () =>
          Promise.resolve(JSON.stringify(url.includes('/amount?') ? AMOUNT_BODY : COST_BODY)),
      }))
    }
    const cache = createAccountCache({ fetcher, now: () => REQUEST_AT, readToken: () => 't' })
    const stale = cache.revalidate(REQUEST_AT)
    expect(calls).toBe(2)

    // The token changes while the old credential's fetch is still in flight: its
    // result must land nowhere.
    cache.reset()
    release()
    await stale
    expect(cache.snapshot().status).toBe('loading')

    // The next revalidate fetches under the new token.
    await cache.revalidate(REQUEST_AT)
    expect(calls).toBe(4)
    expect(cache.snapshot().status).toBe('ok')
  })
})
