/**
 * Account-level usage from the DeepSeek platform: the settled, all-devices figure.
 *
 * The session logs this plugin prices can only ever describe this machine, while the account can be
 * used anywhere — a day total that claims to be the account's is a lie on any multi-device setup.
 * The platform's own usage endpoints answer the account-level question with settled figures:
 *
 * GET
 * https://platform.deepseek.com/api/v0/usage/by_api_key/{amount,cost}?start=<sec>&end=<sec>&tz=<sec>
 *
 * Two constraints shape the module:
 *
 * - Authentication is the web console's session token (the `userToken` in the console's
 *   localStorage), NOT the `sk-` API key — the key is rejected with a 40003. The token lives in a
 *   file under `$DSH_HOME` and never crosses the summary route: only figures and status codes do.
 * - The host has a WAF in front of it, so requests carry browser-like headers.
 *
 * The account "today" is the billed day — Beijing time — because that is the day the invoice sums.
 * The reader's own timezone stays on the machine-level figures, and the panel labels which is
 * which.
 */

import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

import type { CurrencyCode } from '@useful-dsh/cost-core'
import { dayKey, dayStart } from '@useful-dsh/tz'

/** The billed day's timezone: the platform bills on Beijing time. */
export const ACCOUNT_TIMEZONE = 'Asia/Shanghai'

/** `tz` query parameter for the platform endpoints, seconds east of UTC. */
const ACCOUNT_TZ_SEC = 8 * 3600

const PLATFORM_BASE = 'https://platform.deepseek.com/api/v0/usage/by_api_key'

// The platform's WAF rejects requests that do not look like a browser.
const PLATFORM_HEADERS: Readonly<Record<string, string>> = {
  'user-agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
  accept: 'application/json, text/plain, */*',
  'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
  origin: 'https://platform.deepseek.com',
  referer: 'https://platform.deepseek.com/usage',
}

const FETCH_TIMEOUT_MS = 10_000

/** How long a successful or failed reading is served before the platform is asked again. */
export const ACCOUNT_TTL_MS = 5 * 60 * 1000

/** States the account block can be in; the client localizes each. */
export type AccountStatus =
  | 'ok'
  | 'no-token'
  | 'loading'
  | 'invalid-token'
  | 'unreachable'
  | 'http-error'
  | 'bad-response'

/** One hour's settled usage, merged across every API key on the account. */
export interface AccountRow {
  /** Bucket start, epoch seconds. */
  time: number
  cacheHit: number
  cacheMiss: number
  completion: number
  cost: number
}

/** What the platform reported for one queried day. */
export interface AccountUsage {
  /** Currency the platform settles in; null when the cost side carried none. */
  currency: CurrencyCode | null
  rows: AccountRow[]
}

export type AccountFetchError = 'invalid-token' | 'unreachable' | 'http-error' | 'bad-response'

export type AccountFetchResult =
  | { ok: true; usage: AccountUsage }
  | { ok: false; error: AccountFetchError }

/** The slice of the Fetch API this module reads; trivial to stub in tests without casts. */
export interface AccountFetchResponse {
  status: number
  ok: boolean
  text(): Promise<string>
}

export interface AccountFetchInit {
  headers: Record<string, string>
  signal: AbortSignal
}

export type AccountFetcher = (url: string, init: AccountFetchInit) => Promise<AccountFetchResponse>

/** The token file the account fetch authenticates with. */
export function platformTokenPath(): string {
  const home = process.env['DSH_HOME']
  const base = home === undefined || home === '' ? join(homedir(), '.dsh') : home
  return join(base, 'dsh-cost-platform-token')
}

/** The configured platform token, or null when none is set up. */
export function readPlatformToken(path = platformTokenPath()): string | null {
  try {
    const token = readFileSync(path, 'utf8').trim()
    return token === '' ? null : token
  } catch {
    return null
  }
}

/** Persist a validated platform token, readable only by this user. */
export function writePlatformToken(token: string, path = platformTokenPath()): void {
  writeFileSync(path, `${token}\n`, { mode: 0o600 })
}

/** Drop the configured platform token; a missing file is fine. */
export function deletePlatformToken(path = platformTokenPath()): void {
  rmSync(path, { force: true })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function asCount(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  const parsed = typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0
}

function asCurrency(value: unknown): CurrencyCode | null {
  return value === 'CNY' || value === 'USD' ? value : null
}

/**
 * Fetch and parse one billed day from both platform endpoints. The amount side carries token
 * buckets per API key (`biz_data.series[].buckets[].usage`), the cost side settled money per
 * currency (`biz_data.data[].series[].buckets[].cost`); both are merged by bucket start.
 */
export async function fetchAccountUsage(options: {
  token: string
  /** Start of the billed day, epoch ms. */
  dayStartMs: number
  fetcher?: AccountFetcher
}): Promise<AccountFetchResult> {
  const fetcher = options.fetcher ?? fetch
  const start = Math.floor(options.dayStartMs / 1000)
  const query = `start=${start}&end=${start + 86400}&tz=${ACCOUNT_TZ_SEC}`
  const init = {
    headers: { ...PLATFORM_HEADERS, authorization: `Bearer ${options.token}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }

  let amountResponse: AccountFetchResponse
  let costResponse: AccountFetchResponse
  try {
    ;[amountResponse, costResponse] = await Promise.all([
      fetcher(`${PLATFORM_BASE}/amount?${query}`, init),
      fetcher(`${PLATFORM_BASE}/cost?${query}`, init),
    ])
  } catch {
    // Network failure and the timeout land here alike; both mean "try again later".
    return { ok: false, error: 'unreachable' }
  }

  for (const response of [amountResponse, costResponse]) {
    if (response.status === 401 || response.status === 403)
      return { ok: false, error: 'invalid-token' }
    if (!response.ok) return { ok: false, error: 'http-error' }
  }
  const [amountText, costText] = await Promise.all([amountResponse.text(), costResponse.text()])

  let amountJson: unknown
  let costJson: unknown
  try {
    amountJson = JSON.parse(amountText)
    costJson = JSON.parse(costText)
  } catch {
    return { ok: false, error: 'bad-response' }
  }
  // The platform reports a rejected token as a 200 with a business error code.
  for (const body of [amountJson, costJson]) {
    const code: unknown = isRecord(body) ? body['code'] : undefined
    if (code === 40003 || code === '40003') return { ok: false, error: 'invalid-token' }
  }

  const amountBiz = digBizData(amountJson)
  const costBiz = digBizData(costJson)
  if (amountBiz === null || costBiz === null) return { ok: false, error: 'bad-response' }

  const rows = new Map<number, AccountRow>()
  const rowAt = (time: number): AccountRow => {
    const existing = rows.get(time)
    if (existing !== undefined) return existing
    const created: AccountRow = { time, cacheHit: 0, cacheMiss: 0, completion: 0, cost: 0 }
    rows.set(time, created)
    return created
  }

  const series = amountBiz['series']
  if (!Array.isArray(series)) return { ok: false, error: 'bad-response' }
  for (const entry of series) {
    if (!isRecord(entry)) continue
    const buckets = entry['buckets']
    if (!Array.isArray(buckets)) continue
    for (const bucket of buckets) {
      if (!isRecord(bucket) || typeof bucket['time'] !== 'number') continue
      const usage = bucket['usage']
      if (!isRecord(usage)) continue
      const row = rowAt(bucket['time'])
      row.cacheHit += asCount(usage['PROMPT_CACHE_HIT_TOKEN'])
      row.cacheMiss += asCount(usage['PROMPT_CACHE_MISS_TOKEN'])
      // The platform names the completion bucket RESPONSE_TOKEN; older write-ups
      // called it COMPLETION_TOKEN, so that spelling is accepted as a fallback.
      row.completion += asCount(usage['RESPONSE_TOKEN'] ?? usage['COMPLETION_TOKEN'])
    }
  }

  let currency: CurrencyCode | null = null
  const costData = costBiz['data']
  if (!Array.isArray(costData)) return { ok: false, error: 'bad-response' }
  for (const perCurrency of costData) {
    if (!isRecord(perCurrency)) continue
    currency ??= asCurrency(perCurrency['currency'])
    const costSeries = perCurrency['series']
    if (!Array.isArray(costSeries)) continue
    for (const entry of costSeries) {
      if (!isRecord(entry)) continue
      const buckets = entry['buckets']
      if (!Array.isArray(buckets)) continue
      for (const bucket of buckets) {
        if (!isRecord(bucket) || typeof bucket['time'] !== 'number') continue
        rowAt(bucket['time']).cost += asCount(bucket['cost'])
      }
    }
  }

  return { ok: true, usage: { currency, rows: [...rows.values()] } }
}

/** `data.biz_data` of one platform response, or null when the shape is not the expected one. */
function digBizData(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body)) return null
  const data = body['data']
  if (!isRecord(data)) return null
  const biz = data['biz_data']
  return isRecord(biz) ? biz : null
}

/** Sum the rows that fall inside the queried billed day. */
export function sumAccountDay(
  usage: AccountUsage,
  dayStartMs: number,
): { cost: number; cacheHit: number; cacheMiss: number; completion: number } {
  const startSec = dayStartMs / 1000
  const total = { cost: 0, cacheHit: 0, cacheMiss: 0, completion: 0 }
  for (const row of usage.rows) {
    if (row.time < startSec || row.time >= startSec + 86400) continue
    total.cost += row.cost
    total.cacheHit += row.cacheHit
    total.cacheMiss += row.cacheMiss
    total.completion += row.completion
  }
  return total
}

/** A point-in-time reading of the account block, as the summary route wires it. */
export interface AccountSnapshot {
  status: AccountStatus
  currency: CurrencyCode | null
  /** Settled cost of the billed day, or null when never fetched. */
  cost: number | null
  tokens: { cacheHit: number; cacheMiss: number; completion: number } | null
  /** Last successful fetch, epoch ms. */
  asOf: number | null
}

function emptySnapshot(): AccountSnapshot {
  return { status: 'loading', currency: null, cost: null, tokens: null, asOf: null }
}

export interface AccountCacheDeps {
  fetcher?: AccountFetcher
  now?: () => number
  readToken?: () => string | null
}

export interface AccountCache {
  /** The current reading. */
  snapshot(): AccountSnapshot
  /**
   * Ask for a fresh reading. The summary route answers from the cache on every poll; only when the
   * reading is stale (or the billed day rolled over) is the platform asked, at most once at a time.
   * Returns the in-flight refresh so a caller that must wait (the token route) can await it; the
   * poll path ignores it.
   */
  revalidate(requestAt: number): Promise<void> | null
  /**
   * Forget everything read so far. Called when the token changes: the next {@link revalidate}
   * fetches with the new credential, and a refresh started under the old one is discarded on
   * landing instead of overwriting the new token's reading.
   */
  reset(): void
}

/** A stale-while-revalidate cache over the platform usage endpoints. */
export function createAccountCache(deps: AccountCacheDeps = {}): AccountCache {
  const now = deps.now ?? (() => Date.now())
  const readToken = deps.readToken ?? (() => readPlatformToken())
  let snapshot = emptySnapshot()
  let fetchedAt = 0
  let dayStartMs = 0
  let generation = 0
  let flight: Promise<void> | null = null

  const refresh = async (token: string, start: number, expected: number): Promise<void> => {
    const result = await fetchAccountUsage({
      token,
      dayStartMs: start,
      ...(deps.fetcher === undefined ? {} : { fetcher: deps.fetcher }),
    })
    // A reset during the fetch means the credential changed underneath this request.
    if (generation !== expected) return
    fetchedAt = now()
    if (!result.ok) {
      // A failed refresh keeps the last good figures; the status names why they are stale.
      snapshot = { ...snapshot, status: result.error }
      return
    }
    const day = sumAccountDay(result.usage, start)
    snapshot = {
      status: 'ok',
      currency: result.usage.currency,
      cost: day.cost,
      tokens: { cacheHit: day.cacheHit, cacheMiss: day.cacheMiss, completion: day.completion },
      asOf: fetchedAt,
    }
  }

  return {
    snapshot: () => snapshot,
    revalidate: (requestAt: number) => {
      const token = readToken()
      if (token === null) {
        snapshot = { ...emptySnapshot(), status: 'no-token' }
        return null
      }
      const key = dayKey(requestAt, ACCOUNT_TIMEZONE)
      const start = dayStart(key, ACCOUNT_TIMEZONE)
      const fresh = start === dayStartMs && now() - fetchedAt < ACCOUNT_TTL_MS
      if (fresh) return flight
      if (flight !== null) return flight
      dayStartMs = start
      if (snapshot.status !== 'ok') snapshot = { ...snapshot, status: 'loading' }
      const expected = generation
      flight = refresh(token, start, expected).finally(() => {
        flight = null
      })
      return flight
    },
    reset: () => {
      generation += 1
      snapshot = emptySnapshot()
      fetchedAt = 0
      dayStartMs = 0
    },
  }
}
