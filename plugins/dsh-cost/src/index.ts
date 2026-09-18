/**
 * Host half of dsh-cost.
 *
 * The host owns everything that needs the session log or a credential: it folds each live session's
 * durable events into priced attempts, aggregates today's account-level total across the sessions
 * this process has seen, and answers two loopback-only routes for the browser half.
 *
 * All pricing and folding lives in the shared `@useful-dsh/cost-core` and `@useful-dsh/tz`
 * libraries, which the build inlines — the browser half computes nothing about money itself, so a
 * figure can never differ between the pill and the API response.
 */

import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  CNY_RATE_TABLE,
  DEEPSEEK_PEAK_SCHEDULE,
  RATE_TABLES,
  emptyFoldState,
  foldEvent,
  summarize,
  summarizeComposition,
  type CostComposition,
  type CostFoldState,
  type CostSummary,
  type CurrencyCode,
  type RateTable,
  type UsageAttempt,
} from '@useful-dsh/cost-core'
import { computeInstant, dayKey, type BillingClock } from '@useful-dsh/tz'

import {
  createHistoryCache,
  scanHistory,
  summarizeHistoryDay,
  mergeAttemptTail,
  type DrainingState,
  type HistoryCache,
  type HistoryScan,
} from './history.ts'

/** Settings namespace backing the plugin configuration. */
export const SETTINGS_NAMESPACE = 'dsh-cost'

/** Route answering the per-session and per-day summary. */
export const SUMMARY_PATH = '/api/dsh-cost/summary'

/** Route reporting the price book the host is pricing with. */
export const CONFIG_PATH = '/api/dsh-cost/config'

export const inject = ['webServer', 'sessions'] as const

export const name = 'dsh-cost'

/**
 * Composition configuration this plugin understands.
 *
 * `currency` selects which of the two published price books every figure is priced in. The host
 * resolves it once and reports it on both routes, so the browser half renders the currency it was
 * actually given instead of assuming one.
 */
export interface CostPluginConfig {
  currency?: CurrencyCode
}

/**
 * Normalize the composition row's config, or name why it cannot be used. Written by hand rather
 * than with a schema library because a plugin package ships zero runtime dependencies (see
 * AGENTS.md); the loader reaches it through {@link Config}'s standard-schema `validate`.
 *
 * @throws {TypeError} When the value is not an object, or names another currency.
 */
function parseConfig(value: unknown): CostPluginConfig {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object') throw new TypeError('dsh-cost: config must be an object')
  const currency: unknown = Reflect.get(value, 'currency')
  if (currency === undefined) return {}
  if (currency !== 'CNY' && currency !== 'USD') {
    const printed = typeof currency === 'string' ? JSON.stringify(currency) : typeof currency
    throw new TypeError(`dsh-cost: currency must be "CNY" or "USD", got ${printed}`)
  }
  return { currency }
}

/**
 * The row's config schema, in the standard-schema shape Cordis validates with.
 *
 * Cordis reads `Config['~standard'].validate(rawConfig)` and rejects the entry when it reports
 * issues, so this has to be the standard-schema shape and not a plain parser: a `parse`-only export
 * left `Config['~standard']` undefined, and the loader's read of `.validate` on it threw before
 * `apply` ever ran — the whole plugin stayed inert and every route it serves answered 404 while the
 * pill silently rendered no figure.
 */
export const Config = {
  '~standard': {
    version: 1,
    vendor: 'dsh-cost',
    validate(value: unknown): { value: CostPluginConfig } | { issues: { message: string }[] } {
      try {
        return { value: parseConfig(value) }
      } catch (error) {
        return { issues: [{ message: error instanceof Error ? error.message : String(error) }] }
      }
    },
  },
}

/**
 * The price book every figure is priced in. The currency is the account's, not the reader's: CNY
 * and USD are separate published lists and are never converted into each other, so this reads the
 * configured row and does not fall back to a guess. DSH exposes no account balance with a currency
 * of its own, so the value comes from the composition entry (`config: { currency: USD }`) and
 * defaults to the renminbi list when unset.
 */
export function tableForConfig(config: CostPluginConfig = {}): RateTable {
  return tableFor(config.currency)
}

/** One session's fold state plus the cursor that keeps folding incremental. */
interface SessionCostState {
  fold: CostFoldState
  /** Event count already folded, so a refresh only reads the new tail. */
  consumed: number
  /** Priced summary as of the last refresh. */
  summary: CostSummary
  /** Newest attempt timestamp seen, used to place the session in a local day. */
  lastAt: number
}

/** The live state one host process keeps. */
export interface CostStore {
  sessions: Map<string, SessionCostState>
  /** Per-file fold cache for the on-disk session store. */
  history: HistoryCache
  /** Root of the durable session store this process reads. */
  sessionsRoot: string
  /**
   * Sessions the registry handed over whose durable logs have not caught up yet. The registry drops
   * a session the moment it ends, but the store buffers its events and flushes them at a later
   * checkpoint, so the attempts folded while live are kept here and the disk log is merged in as
   * checkpoints land (see {@link scanHistory}).
   */
  draining: Map<string, DrainingState>
}

/** The slice of a DSH session the fold reads. */
interface LiveSession {
  id: string
  seq: number
  eventAt(seq: number): { type: string; data?: unknown } | undefined
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/** Minimal structural view of the services this plugin consumes. */
interface CostHostContext {
  logger: { warn(message: string): void }
  sessions: { list(): readonly unknown[] }
  webServer: {
    register(route: {
      kind: 'exact'
      path: string
      handler: (req: unknown, res: unknown) => void | Promise<void>
    }): () => void
  }
  effect(callback: () => () => void, label?: string): void
}

/** A fresh store; `sessionsRoot` defaults to `$DSH_HOME/sessions`. */
export function createStore(sessionsRoot = defaultSessionsRoot()): CostStore {
  return {
    sessions: new Map(),
    history: createHistoryCache(),
    sessionsRoot,
    draining: new Map(),
  }
}

/** The durable session store root of the running harness. */
export function defaultSessionsRoot(): string {
  const home = process.env['DSH_HOME']
  const base = home === undefined || home === '' ? join(homedir(), '.dsh') : home
  return join(base, 'sessions')
}

/**
 * Narrow one candidate from `sessions.list()` to a live session. The registry is typed as
 * `unknown[]` here because this plugin depends on a structural slice of a session, not on the whole
 * session type: a session that answers `id`, `seq` and `eventAt` is enough to fold.
 */
function asLiveSession(value: unknown): LiveSession | null {
  if (!isObject(value)) return null
  const id = value['id']
  const seq = value['seq']
  const eventAt = value['eventAt']
  if (typeof id !== 'string' || typeof seq !== 'number' || typeof eventAt !== 'function')
    return null
  return {
    id,
    seq,
    eventAt: (position: number) => {
      const raw: unknown = Reflect.apply(eventAt, value, [position])
      if (!isObject(raw)) return undefined
      const type: unknown = Reflect.get(raw, 'type')
      if (typeof type !== 'string') return undefined
      return { type, data: Reflect.get(raw, 'data') }
    },
  }
}

/** Price one session's attempts against their own billing instants. */
function summarizeSession(
  table: RateTable,
  clock: BillingClock,
  attempts: readonly UsageAttempt[],
): CostSummary {
  // scanMs 0: pricing reads only the attempt's own period, and scanning every
  // attempt for the *next* rate change costs seconds once a day has thousands
  // of attempts. Only the request's own instant needs that scan.
  return summarize(
    table,
    attempts.map((attempt) => ({
      attempt,
      instant: computeInstant(DEEPSEEK_PEAK_SCHEDULE, clock, attempt.at, 0),
    })),
  )
}

/**
 * Fold the events appended since the last refresh into the session's state. Only the new tail is
 * read: a long session would otherwise be re-folded on every refresh, and the fold is the expensive
 * half of the summary route.
 */
export function refreshSession(
  store: CostStore,
  session: LiveSession,
  table: RateTable,
  clock: BillingClock,
): SessionCostState {
  // A session the registry handed back (reopened after it ended) must not be folded
  // twice: whatever the draining state holds describes the same stream the registry
  // is about to replay or resume. Merging after the registry fold makes either
  // behaviour exact: a full replay covers the retained attempts positionally, a
  // resume only appends what the registry never delivered.
  const drained = store.draining.get(session.id)
  const existing = store.sessions.get(session.id) ?? {
    fold: emptyFoldState(),
    consumed: 0,
    summary: summarize(table, []),
    lastAt: 0,
  }
  // The live registry is read through a narrower event surface than the durable
  // log: an event it hands back may carry no `time` at all. Dating such a sample
  // to the epoch kept every live turn out of the day total — the day showed only
  // the finished sessions while the open session's own figure looked right — so
  // the fold dates it to this request's instant instead.
  const observedAt = Date.now()
  for (let seq = existing.consumed; seq < session.seq; seq += 1) {
    const event = session.eventAt(seq)
    if (event === undefined) continue
    foldEvent(existing.fold, event, observedAt)
  }
  if (drained !== undefined) {
    store.draining.delete(session.id)
    existing.fold.attempts = [
      ...mergeAttemptTail(drained.attempts, existing.fold.attempts).attempts,
    ]
  }
  const attempts = existing.fold.attempts
  const last = attempts.at(-1)
  store.sessions.set(session.id, {
    ...existing,
    consumed: session.seq,
    summary: summarizeSession(table, clock, attempts),
    lastAt: last?.at ?? existing.lastAt,
  })
  const state = store.sessions.get(session.id)
  /* c8 ignore next -- the map write above always produces a value */
  if (state === undefined) throw new Error('dsh-cost: session state vanished during refresh')
  return state
}

/** Where one session's cost falls in the reader's local day. */
export interface DayScope {
  /** Local calendar day the request is about, `YYYY-MM-DD`. */
  dayKey: string
  /** Sessions the total covers: live ones plus finished logs. */
  sessions: number
  /** Distinct projects those sessions ran in. */
  projects: number
  /** Today's account-level total. */
  summary: CostSummary
  /** Cost per local hour, for the chart. */
  hourly: { hour: number; cost: number; tokens: number }[]
  /** Session logs this build could not read. */
  skippedFiles: number
  /** Models in today's total that the price book cannot place. */
  unpriced: string[]
  /** Per-source contribution, so a missing half is visible instead of implied. */
  sources: {
    /** Cost from sessions live in this process, or null when none could be priced. */
    live: number | null
    liveSessions: number
    /**
     * Cost from sessions the registry already dropped but whose logs have not caught up, still
     * folded from memory; null when none could be priced.
     */
    draining: number | null
    drainingSessions: number
    /** Cost from finished session logs on disk, or null when none were read. */
    history: number | null
    historySessions: number
  }
}

/**
 * Hand the sessions the registry no longer holds over to their durable logs. The registry drops a
 * session the moment it ends, but the store's checkpoint flush lands later — often much later — so
 * deleting the fold now would read a log that may still hold nothing but the session header and
 * silently lose the whole session from the day total (the number a reader watches jump every time a
 * session is switched). Instead the fold moves to {@link CostStore.draining}: it keeps counting from
 * memory, absorbs the disk log as checkpoints land, and hands over to the plain disk path once the
 * log demonstrably covers it.
 */
export function evictEndedSessions(store: CostStore, liveIds: ReadonlySet<string>): number {
  let evicted = 0
  for (const [id, state] of store.sessions) {
    if (liveIds.has(id)) continue
    store.sessions.delete(id)
    if (!store.draining.has(id)) {
      store.draining.set(id, {
        attempts: state.fold.attempts,
        drainedAt: Date.now(),
        projects: [],
        covered: false,
      })
    }
    evicted += 1
  }
  return evicted
}

/**
 * Aggregate one local day across every session on this machine. Three sources, because none is
 * complete on its own: the live registry holds sessions whose log is still being appended
 * (including turns not yet flushed to disk); the draining set holds sessions the registry dropped
 * whose checkpoint flush has not landed yet, without which a switched session would vanish from the
 * total until the store caught up; and the session store holds every session whose log is already
 * durable. The scope is account-level on purpose — a reader asking "what did today cost" means
 * every project, not the one whose session happens to be open.
 */
export function dayScope(
  store: CostStore,
  clock: BillingClock,
  table: RateTable,
  now: number,
): DayScope {
  const key = dayKey(now, clock.timezone)
  const scan: HistoryScan = scanHistory(
    store.history,
    store.sessionsRoot,
    clock,
    now,
    new Set(store.sessions.keys()),
    store.draining,
  )
  const fromDisk = summarizeHistoryDay(scan.attempts, table, clock, now)

  // Live and draining sessions contribute their own attempts: a turn that is still
  // running is counted even though its log line has not been written yet, and a
  // session whose log is still catching up is counted from the fold that watched it.
  const liveAttempts = [...store.sessions.values()].flatMap((state) => state.fold.attempts)
  const live = summarizeHistoryDay(liveAttempts, table, clock, now)
  const drainingAttempts = [...store.draining.values()].flatMap((entry) => entry.attempts)
  const draining = summarizeHistoryDay(drainingAttempts, table, clock, now)

  const totals = [live.summary.total, draining.summary.total, fromDisk.summary.total]
  const total = totals.every((value) => value === null)
    ? null
    : totals.reduce((sum: number, value) => sum + (value ?? 0), 0)
  const hourly = fromDisk.hourly.map((bucket, hour) => ({
    hour,
    cost: bucket.cost + (live.hourly[hour]?.cost ?? 0) + (draining.hourly[hour]?.cost ?? 0),
    tokens: bucket.tokens + (live.hourly[hour]?.tokens ?? 0) + (draining.hourly[hour]?.tokens ?? 0),
  }))
  const drainingProjects = [...store.draining.values()].flatMap((entry) => entry.projects)

  return {
    dayKey: key,
    sessions: store.sessions.size + store.draining.size + scan.sessionsRead,
    // All three sides are project *directories*; `store.sessions` and
    // `store.draining` are keyed by session id, which used to be unioned in here
    // and counted every live session as one more project of its own.
    projects: new Set([...scan.projects, ...drainingProjects]).size,
    summary: { ...fromDisk.summary, total },
    hourly,
    skippedFiles: scan.skipped,
    unpriced: [...new Set([...fromDisk.unpriced, ...live.unpriced, ...draining.unpriced])],
    sources: {
      live: live.summary.total,
      liveSessions: store.sessions.size,
      draining: draining.summary.total,
      drainingSessions: store.draining.size,
      history: fromDisk.summary.total,
      historySessions: scan.sessionsRead,
    },
  }
}

/** Resolve the price book for a requested currency. */
export function tableFor(currency: unknown): RateTable {
  return currency === 'USD' ? RATE_TABLES['USD'] : CNY_RATE_TABLE
}

/** JSON body of the summary route. */
export interface SummaryPayload {
  ok: boolean
  /** Present when `ok` is false. */
  error?: string
  currency: CurrencyCode
  session?: {
    total: number | null
    tokens: { input: number; cacheRead: number; cacheWrite: number; output: number }
    billedInputTokens: number
    pricedAttempts: number
    unpriced: string[]
    composition: CostComposition
    byTurn: readonly { turn: number; cost: number; incomplete: boolean }[]
    byModel: readonly {
      model: string
      cost: number
      tokens: { input: number; cacheRead: number; cacheWrite: number; output: number }
      periods: readonly string[]
    }[]
  }
  /** Totals of the open session's newest turn. */
  turn?: { total: number | null; pricedAttempts: number }
  today?: {
    total: number | null
    /** Cost of the currently open session, included in {@link total}. */
    sessionTotal: number | null
    tokens: number
    /** Sessions folded into this total: live plus already-finished logs. */
    sessions: number
    projects: number
    dayKey: string
    hourly: readonly { hour: number; cost: number; tokens: number }[]
    /** Session logs this build could not read, reported rather than hidden. */
    skippedFiles: number
    /**
     * Models that appear in this total but have no price.
     *
     * Reported separately from the session's own list because the day total spans sessions the
     * reader never opened: without it a total missing an unpriced session reads as complete, just
     * smaller.
     */
    unpriced: string[]
    /**
     * What each source contributed.
     *
     * Present so a UI can say "this is only the live sessions" instead of showing a total that
     * quietly omits half the day. `draining`/`drainingSessions` are absent on a host older than
     * this bundle and stand for "ended sessions whose logs are still catching up, counted from the
     * fold that watched them".
     */
    sources?: {
      live: number | null
      liveSessions: number
      draining?: number | null
      drainingSessions?: number
      history: number | null
      historySessions: number
    }
  }
  /**
   * The billed period now, and the next change.
   *
   * `next`/`nextAt` are present only when the schedule has a transition the scan reached. A missing
   * pair means "not known", which a caller renders by leaving the countdown out; filling it with
   * the current instant would claim the rate changes right now.
   */
  period?: { current: string; next?: string; nextAt?: number }
  generatedAt: number
}

/** Serialize buckets without optional keys, so the wire shape is stable. */
function wireTokens(tokens: {
  input: number
  cacheRead: number
  output: number
  cacheWrite?: number
}): { input: number; cacheRead: number; cacheWrite: number; output: number } {
  return {
    input: tokens.input,
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite ?? 0,
    output: tokens.output,
  }
}

/**
 * Turn the schedule's reading into the period block the browser half renders. A missing transition
 * is reported as missing: filling `nextAt` with the request's own instant renders as "next change
 * <now> (0h 00m 00s)" and claims the rate changes at the moment the reader looked.
 */
export function wirePeriod(instant: {
  period: string
  nextPeriod: string | null
  nextTransitionAt: number | null
}): NonNullable<SummaryPayload['period']> {
  if (instant.nextPeriod === null || instant.nextTransitionAt === null) {
    return { current: instant.period }
  }
  return { current: instant.period, next: instant.nextPeriod, nextAt: instant.nextTransitionAt }
}

/** Build the response body for one session. */
export function buildSummary(
  store: CostStore,
  sessionId: string,
  table: RateTable,
  clock: BillingClock,
  now: number,
): SummaryPayload {
  const state = store.sessions.get(sessionId)
  const day = dayScope(store, clock, table, now)
  const instant = computeInstant(DEEPSEEK_PEAK_SCHEDULE, clock, now)
  const period = wirePeriod(instant)
  const todayBlock = (sessionTotal: number | null): NonNullable<SummaryPayload['today']> => ({
    total: day.summary.total,
    sessionTotal,
    tokens:
      day.summary.tokens.input +
      day.summary.tokens.cacheRead +
      (day.summary.tokens.cacheWrite ?? 0) +
      day.summary.tokens.output,
    sessions: day.sessions,
    projects: day.projects,
    dayKey: day.dayKey,
    hourly: day.hourly,
    skippedFiles: day.skippedFiles,
    unpriced: day.unpriced,
    sources: day.sources,
  })

  if (state === undefined) {
    return {
      ok: false,
      error: 'not-live',
      currency: table.currency,
      today: todayBlock(null),
      period,
      generatedAt: now,
    }
  }
  const attempts = state.fold.attempts
  const lastTurn = attempts.at(-1)?.turn ?? 0
  const inputs = attempts.map((attempt) => ({
    attempt,
    // See summarizeSession: the transition scan belongs to the request's own
    // instant, not to every attempt being priced.
    instant: computeInstant(DEEPSEEK_PEAK_SCHEDULE, clock, attempt.at, 0),
  }))
  const turnSummary = summarizeSession(
    table,
    clock,
    attempts.filter((attempt) => attempt.turn === lastTurn),
  )
  return {
    ok: true,
    currency: table.currency,
    session: {
      total: state.summary.total,
      tokens: wireTokens(state.summary.tokens),
      billedInputTokens: state.summary.billedInputTokens,
      pricedAttempts: state.summary.pricedAttempts,
      unpriced: state.summary.unpriced.map((entry) => entry.attempt.model),
      composition: summarizeComposition(table, inputs),
      byTurn: state.summary.byTurn,
      byModel: state.summary.byModel.map((model) => ({
        model: model.model,
        cost: model.cost,
        tokens: wireTokens(model.tokens),
        periods: model.periods,
      })),
    },
    turn: { total: turnSummary.total, pricedAttempts: turnSummary.pricedAttempts },
    today: todayBlock(state.summary.total),
    period,
    generatedAt: now,
  }
}

/** Whether a request came from this machine, and only this machine. */
export function isLoopbackRequest(request: {
  headers: { host: string | undefined } | undefined
  socket: { remoteAddress: string | undefined } | undefined
}): boolean {
  const remote = request.socket?.remoteAddress ?? ''
  const loopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1'
  if (!loopback) return false
  const host = request.headers?.host ?? ''
  return host.startsWith('127.0.0.1:') || host.startsWith('localhost:') || host.startsWith('[::1]:')
}

export function queryParam(url: string | undefined, key: string): string | null {
  if (url === undefined) return null
  try {
    return new URL(url, 'http://127.0.0.1').searchParams.get(key)
  } catch {
    return null
  }
}

/**
 * Narrow a raw `node:http` request to the fields the routes read. The route registrar types its
 * handler parameters as `unknown` because the host web server is a generic carrier; these guards
 * keep the narrowing honest instead of asserting a shape the carrier did not promise.
 */
function asHttpRequest(value: unknown): {
  url: string | undefined
  headers: { host: string | undefined } | undefined
  socket: { remoteAddress: string | undefined } | undefined
} | null {
  if (!isObject(value)) return null
  const headers = value['headers']
  const socket = value['socket']
  const url = value['url']
  return {
    url: typeof url === 'string' ? url : undefined,
    headers: isObject(headers)
      ? { host: typeof headers['host'] === 'string' ? headers['host'] : undefined }
      : undefined,
    socket: isObject(socket)
      ? {
          remoteAddress:
            typeof socket['remoteAddress'] === 'string' ? socket['remoteAddress'] : undefined,
        }
      : undefined,
  }
}

/** Narrow a raw `node:http` response to the two calls the routes make. */
function asHttpResponse(value: unknown): {
  writeHead(status: number, headers: Record<string, string>): void
  end(body: string): void
} | null {
  if (!isObject(value)) return null
  const writeHead = value['writeHead']
  const end = value['end']
  if (typeof writeHead !== 'function' || typeof end !== 'function') return null
  return {
    writeHead: (status, headers) => {
      Reflect.apply(writeHead, value, [status, headers])
    },
    end: (body) => {
      Reflect.apply(end, value, [body])
    },
  }
}

function sendJson(
  response: {
    writeHead(status: number, headers: Record<string, string>): void
    end(body: string): void
  },
  status: number,
  body: unknown,
): void {
  const text = JSON.stringify(body)
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'cache-control': 'no-store',
  })
  response.end(text)
}

/** Plugin body: register the two routes and keep the store on this fiber. */
export function apply(ctx: CostHostContext, config: CostPluginConfig = {}): void {
  const store = createStore()
  const defaultTable = tableForConfig(config)
  ctx.effect(() => {
    const disposeSummary = ctx.webServer.register({
      kind: 'exact',
      path: SUMMARY_PATH,
      handler: (rawRequest, rawResponse) => {
        const request = asHttpRequest(rawRequest)
        const response = asHttpResponse(rawResponse)
        if (request === null || response === null) return
        if (!isLoopbackRequest(request)) {
          sendJson(response, 403, { ok: false, error: 'forbidden' })
          return
        }
        try {
          const sessionId = queryParam(request.url, 'session') ?? ''
          const currency = queryParam(request.url, 'currency')
          const zone = queryParam(request.url, 'tz')
          const locale = queryParam(request.url, 'lang')
          const clock: BillingClock = {
            timezone: zone === null || zone === '' ? 'UTC' : zone,
            locale: locale === null || locale === '' ? 'en' : locale,
          }
          const table = currency === null || currency === '' ? defaultTable : tableFor(currency)
          const liveIds = new Set<string>()
          for (const candidate of ctx.sessions.list()) {
            const session = asLiveSession(candidate)
            if (session === null) continue
            liveIds.add(session.id)
            refreshSession(store, session, table, clock)
          }
          // Sessions that ended since the last poll are handed to the disk scan
          // rather than kept frozen at their last folded state.
          evictEndedSessions(store, liveIds)
          sendJson(response, 200, buildSummary(store, sessionId, table, clock, Date.now()))
        } catch (error) {
          ctx.logger.warn(`dsh-cost: summary failed: ${String(error)}`)
          sendJson(response, 500, { ok: false, error: 'internal' })
        }
      },
    })
    const disposeConfig = ctx.webServer.register({
      kind: 'exact',
      path: CONFIG_PATH,
      handler: (rawRequest, rawResponse) => {
        const request = asHttpRequest(rawRequest)
        const response = asHttpResponse(rawResponse)
        if (request === null || response === null) return
        if (!isLoopbackRequest(request)) {
          sendJson(response, 403, { ok: false, error: 'forbidden' })
          return
        }
        // Reports what the scanner can see right now: a deployed host whose
        // history root is wrong answers with a total of zero, and this is what
        // tells that apart from "nothing was spent today".
        const probe = dayScope(store, { timezone: 'UTC', locale: 'en' }, defaultTable, Date.now())
        sendJson(response, 200, {
          ok: true,
          currency: defaultTable.currency,
          currencies: Object.keys(RATE_TABLES),
          settingsNamespace: SETTINGS_NAMESPACE,
          peakWindows: DEEPSEEK_PEAK_SCHEDULE.windows,
          billedTimezone: DEEPSEEK_PEAK_SCHEDULE.timezone,
          sessionsRoot: store.sessionsRoot,
          liveSessions: store.sessions.size,
          historySessions: probe.sources.historySessions,
          historyTotal: probe.sources.history,
          skippedFiles: probe.skippedFiles,
        })
      },
    })
    return () => {
      disposeSummary()
      disposeConfig()
      store.sessions.clear()
      store.draining.clear()
    }
  }, 'dsh-cost: routes')
}
