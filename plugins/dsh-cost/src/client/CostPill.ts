/**
 * Browser half of dsh-cost: the stats-row pill and its detail panel.
 *
 * Registered on DSH's `conversation.composer.dock` slot: the entry takes part in the ambient row
 * under the composer, where DSH renders its own stats pills. That slot draws one row per registered
 * id and its shipped stats row exposes no child slot, so the entry keeps a zero-footprint anchor
 * there and renders the pill into the shipped row by portal, which is what puts it on that line
 * instead of a line of its own. The component computes nothing about money itself — every figure
 * arrives from the host half's summary route, which prices the session with the shared libraries.
 */

import type { CostComposition, CurrencyCode, RatePeriod } from '@useful-dsh/cost-core'
import {
  barPercent,
  formatCacheHitPercent,
  formatClock,
  formatCountdown,
  formatMoney,
  formatTokens,
  formatTokensExact,
  percentOf,
} from '@useful-dsh/fmt'
import { bindTranslate, isCostLocaleKey } from '@useful-dsh/i18n'
import type { CostLocaleKey } from '@useful-dsh/i18n'
import { createElement as h, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { createPortal } from 'react-dom'

/** Locale namespace this half registers its dictionaries under. */
export const NS = 'dsh-cost'

// Each mark carries its own viewBox: the glyphs fill their source grid unequally, so a
// shared frame renders the dollar about a quarter taller than the yuan.
const CURRENCY_MARKS: Readonly<Record<string, { viewBox: string; path: string }>> = {
  CNY: {
    viewBox: '10.3 10.2 35.8 35.8',
    path: 'm41.47 12l-9.596 16.937h6.186v2.575h-7.454v3.625h7.454v2.576h-7.454v6.542h-4.765v-6.542h-7.453v-2.576h7.453v-3.625h-7.453v-2.575h6.186L15 12h5.333l7.847 14.634h.131L36.158 12z',
  },
  USD: {
    viewBox: '5.3 5.8 44.4 44.4',
    path: 'M29 30v10c3.519-.316 5-2.287 5-4.89c0-2.507-1.152-3.99-5-5.11m-3-5v-9c-3.273.415-5 2.33-5 4.43s1.364 3.647 5 4.57m2.84.737l1.072.277C35.784 27.423 39 29.917 39 34.836c0 5.658-4.466 8.868-10.16 9.284V48h-2.523v-3.88c-5.672-.439-10.16-3.741-10.317-9.284h4.622c.402 2.702 2.1 4.688 5.695 5.08V29.849l-.916-.231c-5.672-1.363-8.731-3.996-8.731-8.684c0-5.173 4.02-8.591 9.647-9.03V8h2.523v3.903c5.582.462 9.624 3.926 9.803 9.169h-4.645c-.29-2.91-2.3-4.596-5.158-4.966z',
  },
}

// The shipped pills draw 14px outline icons whose ink is 12.25px (gauge) and 12.9px (database)
// tall. These marks are FILLED glyphs, and a filled glyph has to be drawn about a tenth smaller
// than an outline to carry the same optical weight — at 14px the yuan's own ink stood 12.6px tall
// and its measured ink weight came out a third above the gauge's, which reads as simply bigger.
// At 12px the ink is 10.8px tall and weighs 3154 against the gauge's 3452 and the database's 5699,
// i.e. it sits inside the family instead of leading it.
const MARK_PX = 12

const REFRESH_MS = 15_000

/** Dictionary key naming each account-fetch failure the host can report. */
const ACCOUNT_ERROR_KEYS: Readonly<Record<string, CostLocaleKey>> = {
  'invalid-token': 'panel.accountErrInvalidToken',
  unreachable: 'panel.accountErrUnreachable',
  'http-error': 'panel.accountErrHttp',
  'bad-response': 'panel.accountErrBadResponse',
}

/** The console snippet that prints the platform session token on any signed-in device. */
const TOKEN_SNIPPET = "JSON.parse(localStorage.getItem('userToken')).value"

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Token buckets as the summary route sends them. */
interface WireTokens {
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
}

/** Response body of the summary route. */
interface SummaryPayload {
  ok: boolean
  error?: string
  currency: CurrencyCode
  session?: {
    total: number | null
    tokens: WireTokens
    billedInputTokens: number
    pricedAttempts: number
    unpriced: string[]
    /** Cost split by bucket, priced by the host from this session's own attempts. */
    composition: CostComposition
    byTurn: readonly { turn: number; cost: number; incomplete: boolean }[]
    byModel: readonly {
      model: string
      cost: number
      tokens: WireTokens
      periods: readonly string[]
    }[]
  }
  turn?: { total: number | null; pricedAttempts: number }
  today?: {
    total: number | null
    /** Cost of the open session, already part of `total`. */
    sessionTotal?: number | null
    tokens: number
    sessions: number
    projects: number
    dayKey: string
    hourly: readonly { hour: number; cost: number; tokens: number }[]
    /** Finished logs this build could not read. */
    skippedFiles?: number
    /** Models in this total with no published price, across every session it covers. */
    unpriced?: string[]
    /** What each source contributed; absent on a host older than this bundle. */
    sources?: {
      live: number | null
      liveSessions: number
      /** Ended sessions whose logs are still catching up, counted from memory. */
      draining?: number | null
      drainingSessions?: number
      history: number | null
      historySessions: number
    }
  }
  /** `next`/`nextAt` are absent when the host has no transition to report. */
  period?: { current: string; next?: string; nextAt?: number }
  /**
   * Account-level settled usage from the platform (all devices, billed Beijing day); absent on a
   * host that predates the block. These figures are actuals, while everything above is this
   * machine's live estimate — the panel renders the two scopes apart.
   */
  account?: {
    configured: boolean
    status: string
    currency?: CurrencyCode
    today: number | null
    tokens: { cacheHit: number; cacheMiss: number; completion: number } | null
    asOf: number | null
  }
  generatedAt: number
}

/** Translate one dictionary key; labels outside the dictionary pass through. */
type Translate = (
  key: CostLocaleKey | (string & {}),
  params?: Record<string, string | number>,
) => string

/** Props DSH supplies to a session-scoped composer-row entry. */
export interface CostPillProps {
  sessionId: string
  /** Session projection selector provided by the session controller. */
  useProjection?: (key: string) => unknown
  /** Translator bound to this entry's locale namespace. */
  t?: Translate
}

/** Token usage projection this component watches for activity. */
interface TokenUsageProjection {
  uncachedInputTokens: number
  outputTokens: number
  cacheReadTokens: number
  /** Prompt-cache writes; absent on a projection that predates the bucket. */
  cacheWriteTokens: number
}

/**
 * Whether a route response is a summary payload. The route is served by this plugin's own host
 * half, but a stale bundle talking to a newer host (or the reverse) would otherwise be read as if
 * it had today's shape, so the fields the component dereferences are checked.
 */
function isSummaryPayload(value: unknown): value is SummaryPayload {
  if (typeof value !== 'object' || value === null) return false
  const ok: unknown = Reflect.get(value, 'ok')
  const currency: unknown = Reflect.get(value, 'currency')
  if (typeof ok !== 'boolean') return false
  if (currency !== 'CNY' && currency !== 'USD') return false
  return isSessionDetail(Reflect.get(value, 'session'))
}

/**
 * Whether a route response carries the session detail this component renders. The session block is
 * rendered straight through, so a stale body whose `tokens` has a different shape would throw while
 * rendering — inside React, that blanks the entry. A body without the block at all is fine: that is
 * the `not-live` answer.
 */
function isSessionDetail(value: unknown): boolean {
  if (value === undefined) return true
  if (typeof value !== 'object' || value === null) return false
  const tokens: unknown = Reflect.get(value, 'tokens')
  if (typeof tokens !== 'object' || tokens === null) return false
  const billed: unknown = Reflect.get(value, 'billedInputTokens')
  return (
    typeof Reflect.get(tokens, 'input') === 'number' &&
    typeof Reflect.get(tokens, 'cacheRead') === 'number' &&
    typeof Reflect.get(tokens, 'output') === 'number' &&
    typeof Reflect.get(tokens, 'cacheWrite') === 'number' &&
    typeof billed === 'number'
  )
}

function asPeriod(value: string | undefined): RatePeriod {
  return value === 'peak' ? 'peak' : 'offpeak'
}

/** Narrow the untyped projection value the session controller hands back. */
function asTokenUsage(value: unknown): TokenUsageProjection | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const input: unknown = Reflect.get(value, 'uncachedInputTokens')
  const output: unknown = Reflect.get(value, 'outputTokens')
  const cacheRead: unknown = Reflect.get(value, 'cacheReadTokens')
  const cacheWrite: unknown = Reflect.get(value, 'cacheWriteTokens')
  if (typeof input !== 'number' || typeof output !== 'number' || typeof cacheRead !== 'number') {
    return undefined
  }
  return {
    uncachedInputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheWriteTokens: typeof cacheWrite === 'number' ? cacheWrite : 0,
  }
}

function readLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale || 'en'
  } catch {
    return 'en'
  }
}

function readTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    return 'UTC'
  }
}

/** Billed volume of one session, used only as a refresh trigger. */
function billedVolume(usage: TokenUsageProjection | undefined): number {
  if (usage === undefined) return 0
  return (
    usage.uncachedInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens + usage.outputTokens
  )
}

/**
 * Whether this session has billed anything at all. DSH's stats row under the composer renders
 * nothing until a session has billed a token, and this segment rides that same condition — without
 * it, a session that shows no stats would still show `¥ Cost —` alone on an otherwise empty line.
 */
export function hasBilledTokens(usage: unknown): boolean {
  return billedVolume(asTokenUsage(usage)) > 0
}

/**
 * Every model the reader should be told about, from both scopes. The session's own list covers what
 * is open; the day's covers every session on the machine, including ones this reader never opened.
 * Warning on the session alone showed a smaller "today" with no sign that part of it had no price.
 */
export function unpricedModelsOf(payload: SummaryPayload): string[] {
  return [...new Set([...(payload.session?.unpriced ?? []), ...(payload.today?.unpriced ?? [])])]
}

/**
 * The figure the pill and the panel header show for today. A day with no billed tokens at all reads
 * as zero, not "—": the dash is reserved for "usage exists but none of it could be priced", and
 * showing it for an ordinary idle day makes a healthy plugin look broken.
 */
export function todayFigureOf(payload: SummaryPayload): number | null {
  const today = payload.today
  if (today === undefined) return null
  if (today.total !== null) return today.total
  return today.tokens === 0 ? 0 : null
}

/**
 * The next rate change to render, or null when the host reported none. Both halves of the pair are
 * required: a `nextAt` without a period has nothing to name, and a fallback to the current instant
 * would render as a countdown that has already expired.
 */
export function nextSwitchOf(payload: SummaryPayload): { at: number; period: RatePeriod } | null {
  const at = payload.period?.nextAt
  const next = payload.period?.next
  if (at === undefined || next === undefined) return null
  return { at, period: asPeriod(next) }
}

/**
 * The cost breakdown the composition bar and its legend render, in display order. A missing
 * composition — a host that predates it — yields nothing rather than zeros, so the panel leaves the
 * section out instead of claiming every bucket cost nothing. Cache writes are dropped while zero:
 * providers without that line would otherwise show a cost that does not exist.
 */
export function compositionRows(composition: CostComposition | undefined): {
  key: 'cachedInputCost' | 'uncachedInputCost' | 'outputCost' | 'cacheWriteCost'
  value: number
}[] {
  if (composition === undefined) return []
  return [
    { key: 'cachedInputCost', value: composition.cachedInput },
    { key: 'uncachedInputCost', value: composition.uncachedInput },
    { key: 'outputCost', value: composition.output },
    ...(composition.cacheWrite === 0
      ? []
      : [{ key: 'cacheWriteCost' as const, value: composition.cacheWrite }]),
  ]
}

/** The marker DSH's composer puts on its stats row — the row this pill shares a line with. */
export const STATS_ROW_MARKER = '[data-composer-stats]'

/**
 * The shipped stats row this entry shares a line with, or null while it is absent. The row is found
 * from the entry's own anchor, never the document, so a second composer on screen cannot hand this
 * one somebody else's row. {@link STATS_ROW_MARKER} is the attribute DSH's own composer stylesheet
 * keys on; an absent marker means no row to join, and the caller then falls back to the entry's own
 * line.
 *
 * Generic over the node type so both the browser path (an `Element`) and the tests (plain objects)
 * read the same code.
 */
export function statsRowOf<T>(
  anchor: {
    parentElement: { querySelector(selector: string): T | null } | null
  } | null,
): T | null {
  const parent = anchor?.parentElement
  if (parent === null || parent === undefined) return null
  return parent.querySelector(STATS_ROW_MARKER)
}

/** The stats row's entry: the pill, with its panel when expanded. */
export function CostPill(props: CostPillProps): ReturnType<typeof h> | null {
  const locale = useMemo(readLocale, [])
  const timezone = useMemo(readTimezone, [])
  const t: Translate = useMemo(() => {
    const translate = bindTranslate(locale)
    const supplied = props.t
    // A key outside the shipped dictionary is echoed rather than translated: the
    // only such keys are data labels (a model id), which must never be localized.
    return (key, params) => {
      if (supplied !== undefined) return supplied(key, params)
      return isCostLocaleKey(key) ? translate(key, params) : key
    }
  }, [locale, props.t])

  const [payload, setPayload] = useState<SummaryPayload | null>(null)
  const [open, setOpen] = useState(false)
  const [now, setNow] = useState(() => Date.now())
  const [anchor, setAnchor] = useState<HTMLElement | null>(null)
  const [statsRow, setStatsRow] = useState<Element | null>(null)
  const [tokenDraft, setTokenDraft] = useState('')
  const [tokenBusy, setTokenBusy] = useState(false)
  const [tokenError, setTokenError] = useState<string | null>(null)
  const [snippetCopied, setSnippetCopied] = useState(false)
  const [editingToken, setEditingToken] = useState(false)
  const [removeArmed, setRemoveArmed] = useState(false)
  const rootRef = useRef<HTMLElement | null>(null)
  const requestEpoch = useRef(0)

  const projection: unknown =
    props.useProjection === undefined ? undefined : props.useProjection('tokenUsage')
  const usage = asTokenUsage(projection)
  const volume = billedVolume(usage)

  const load = useCallback(async () => {
    const epoch = ++requestEpoch.current
    // The currency is the host's, not this half's: the two published price lists
    // are never converted into each other, and the host is the side that knows
    // which one the account is billed in. The route reports the one it priced
    // with, and the component renders that.
    const query = new URLSearchParams({
      session: props.sessionId,
      tz: timezone,
      lang: locale,
    })
    try {
      const response = await fetch(`/api/dsh-cost/summary?${query.toString()}`, {
        headers: { accept: 'application/json' },
      })
      if (!response.ok) return
      const body: unknown = await response.json()
      // A response for an older session or an out-of-order refresh must not
      // overwrite the current reading.
      if (epoch === requestEpoch.current && isSummaryPayload(body)) setPayload(body)
    } catch {
      // A failed refresh keeps the previous reading: the pill is a readout, not
      // a liveness probe, and blanking it would be worse than showing a stale one.
    }
  }, [props.sessionId, timezone, locale])

  useEffect(() => {
    void load()
  }, [load])

  // A token-activity change refreshes early; the interval below is the floor.
  useEffect(() => {
    if (volume === 0) return undefined
    const timer = setTimeout(() => void load(), 800)
    return () => clearTimeout(timer)
  }, [volume, load])

  useEffect(() => {
    const interval = setInterval(() => void load(), REFRESH_MS)
    const tick = setInterval(() => setNow(Date.now()), 1000)
    return () => {
      clearInterval(interval)
      clearInterval(tick)
    }
  }, [load])

  // A popover is expected to close on Escape and on a click elsewhere; without
  // this the panel could only be dismissed by clicking the pill again.
  useEffect(() => {
    if (!open) return undefined
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false)
    }
    const onPointerDown = (event: Event): void => {
      const target = event.target
      if (target instanceof Node && rootRef.current?.contains(target) === true) return
      setOpen(false)
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown, true)
    }
  }, [open])

  // Follow the shipped row while it is on screen: it mounts and unmounts with the
  // session's own stats, and the entry has to move between that row and its own
  // anchor when it does. Reading the row from the anchor's parent keeps a second
  // composer's row out of the picture.
  useEffect(() => {
    if (anchor === null) return undefined
    const parent = anchor.parentElement
    if (parent === null) return undefined
    const sync = (): void => {
      const row = statsRowOf<Element>(anchor)
      setStatsRow((current) => (current === row ? current : row))
    }
    sync()
    // The row is the anchor's sibling, so watching the parent's child list alone
    // catches it mounting and unmounting without waking on every keystroke the
    // draft editor mutates.
    const observer = new MutationObserver(sync)
    observer.observe(parent, { childList: true })
    return () => {
      observer.disconnect()
    }
  }, [anchor])

  // Saving a token goes through the host, which validates it against the platform
  // before persisting: the panel only ever learns whether it was accepted.
  const saveToken = useCallback(async () => {
    const token = tokenDraft.trim()
    if (token === '' || tokenBusy) return
    setTokenBusy(true)
    setTokenError(null)
    try {
      const response = await fetch('/api/dsh-cost/account-token', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      })
      const body: unknown = await response.json()
      if (isRecord(body) && body['ok'] === true) {
        setTokenDraft('')
        setEditingToken(false)
        await load()
      } else {
        const code: unknown = isRecord(body) ? body['error'] : undefined
        setTokenError(typeof code === 'string' ? code : 'http-error')
      }
    } catch {
      setTokenError('unreachable')
    } finally {
      setTokenBusy(false)
    }
  }, [tokenDraft, tokenBusy, load])

  // Removal is a two-click gesture: the first click arms, the second confirms —
  // an accidental tap on a destructive action in a 380px popover must not count.
  const onRemoveClick = useCallback(() => {
    if (!removeArmed) {
      setRemoveArmed(true)
      return
    }
    void (async () => {
      try {
        await fetch('/api/dsh-cost/account-token', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ token: '' }),
        })
      } finally {
        setRemoveArmed(false)
        await load()
      }
    })()
  }, [removeArmed, load])

  const copySnippet = useCallback(() => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(TOKEN_SNIPPET)
        setSnippetCopied(true)
        setTimeout(() => setSnippetCopied(false), 1500)
      } catch {
        // Clipboard unavailable (permissions); the snippet stays visible for manual copy.
      }
    })()
  }, [])

  // A session that has billed nothing has no figure to show yet, so the entry
  // stays out of the row. Every hook above still runs, which is what keeps the
  // mount order stable.
  if (!hasBilledTokens(projection)) return null

  if (payload === null) return null

  const currency = payload.currency
  const sessionCost = payload.session?.total ?? null
  const turnCost = payload.turn?.total ?? null
  const unpricedModels = unpricedModelsOf(payload)
  const hasUnpriced = unpricedModels.length > 0
  const period = asPeriod(payload.period?.current)
  const nextSwitch = nextSwitchOf(payload)
  const hit = payload.session
    ? formatCacheHitPercent(payload.session.tokens.cacheRead, payload.session.billedInputTokens)
    : null

  const todayCost = todayFigureOf(payload)
  const pillStyle = {
    display: 'inline-flex',
    alignItems: 'center',
    // The shipped row is a centered flex line with a max width. A segment that can
    // shrink or wrap gets pushed onto its own line even when the row has room, so
    // this one never shrinks, never wraps, and never breaks inside.
    flex: 'none',
    whiteSpace: 'nowrap',
    // The shipped pills put 6px between a 14px icon frame and the label, and their
    // outline icons fill 12.25px of that frame — so the visible air there is ~6.9px.
    // The mark's square frame is drawn around a narrower glyph and leaves ~1.55px of
    // empty box on each side, so it needs half a pixel less gap to land on the same
    // visible air rather than reading wider than its neighbours.
    gap: 5.5,
    padding: '1px 8px',
    border: 0,
    borderRadius: 24,
    background: open ? 'var(--dsw-alias-interactive-bg-hover)' : 'transparent',
    color: 'var(--dsw-alias-label-tertiary)',
    cursor: 'pointer',
    font: 'inherit',
    fontSize: 13,
    lineHeight: '20px',
    fontVariantNumeric: 'tabular-nums',
  } as const

  const mark = CURRENCY_MARKS[currency] ?? CURRENCY_MARKS['CNY']
  if (mark === undefined) throw new Error(`dsh-cost: no currency mark for ${currency}`)
  const sources = payload.today?.sources
  const amountColor = hasUnpriced
    ? 'var(--dsw-alias-state-warn-label)'
    : 'var(--dsw-alias-state-business-primary)'

  const rowStyle = {
    display: 'flex',
    gap: 12,
    justifyContent: 'space-between',
    alignItems: 'baseline',
  } as const
  const labelStyle = { color: 'var(--dsw-alias-label-tertiary)' } as const
  const valueStyle = {
    color: 'var(--dsw-alias-label-primary)',
    fontVariantNumeric: 'tabular-nums',
  } as const

  const row = (
    label: string,
    value: string,
    color?: string,
    title?: string,
  ): ReturnType<typeof h> =>
    h(
      'div',
      { style: rowStyle, ...(title === undefined ? {} : { title }) },
      h('span', { style: labelStyle }, label),
      h('span', { style: { ...valueStyle, ...(color === undefined ? {} : { color }) } }, value),
    )

  const divider = h('div', {
    style: { height: '0.5px', background: 'var(--dsw-alias-border-l1)', margin: '10px 0' },
  })

  const hourly = payload.today?.hourly ?? []
  const maxHour = Math.max(...hourly.map((bucket) => bucket.cost), 1e-7)
  const maxTurn = Math.max(...(payload.session?.byTurn ?? []).map((turn) => turn.cost), 1e-7)
  // The split arrives priced by the host, which applies each attempt's own model
  // and period. Multiplying the session's buckets by one model's current off-peak
  // row here would report a composition that contradicts the total above it.
  const split = payload.session?.composition
  const cacheShare =
    split === undefined ? 0 : percentOf(split.cachedInput, Math.max(split.total, 1e-9))

  // The account block: settled, all-devices figures from the platform, kept visually
  // separate from this machine's live estimate above it. A host that predates the
  // block leaves it out entirely.
  const account = payload.account
  const accountCurrency = account?.currency ?? currency
  // A quiet text button, sized to sit inside a section header row.
  const linkButton = {
    border: 0,
    padding: 0,
    background: 'transparent',
    color: 'var(--dsw-alias-label-tertiary)',
    cursor: 'pointer',
    font: 'inherit',
  } as const
  const accountBlock =
    account === undefined
      ? null
      : h(
          'div',
          {},
          divider,
          h(
            'div',
            { style: { ...rowStyle, marginBottom: 6 } },
            h('span', { style: { ...valueStyle, fontWeight: 600 } }, t('panel.accountTitle')),
            // Token management lives on the header row: a configured token must be
            // replaceable and removable without hunting for a form that only shows
            // when something is wrong.
            account.configured && !editingToken
              ? h(
                  'span',
                  { style: { display: 'flex', gap: 10 } },
                  h(
                    'button',
                    {
                      type: 'button',
                      style: linkButton,
                      onClick: () => {
                        setEditingToken(true)
                        setRemoveArmed(false)
                        setTokenError(null)
                      },
                    },
                    t('panel.tokenChange'),
                  ),
                  h(
                    'button',
                    {
                      type: 'button',
                      style: {
                        ...linkButton,
                        ...(removeArmed
                          ? { color: 'var(--dsw-alias-state-warn-label)', fontWeight: 600 }
                          : {}),
                      },
                      onClick: onRemoveClick,
                    },
                    removeArmed ? t('panel.tokenRemoveConfirm') : t('panel.tokenRemove'),
                  ),
                )
              : null,
          ),
          // One grid for the whole section, so its rows keep the session block's
          // rhythm instead of stacking tight.
          h('div', { style: { display: 'grid', gap: 6 } }, ...accountContent(account)),
        )

  function accountContent(current: NonNullable<SummaryPayload['account']>): ReturnType<typeof h>[] {
    // A missing or rejected token is fixed with the form, not with prose: the
    // panel itself is where the token gets pasted, wherever it is rendered.
    if (current.status === 'no-token') return [tokenForm('form', false)]
    if (current.status === 'invalid-token') {
      return [
        h(
          'div',
          { key: 'expired', style: { ...labelStyle, color: 'var(--dsw-alias-state-warn-label)' } },
          t('panel.accountErrInvalidToken'),
        ),
        tokenForm('form-invalid', false),
      ]
    }
    if (current.status === 'loading') {
      return [h('div', { key: 'loading', style: labelStyle }, t('panel.accountLoading'))]
    }
    const parts: ReturnType<typeof h>[] = []
    const errorKey = ACCOUNT_ERROR_KEYS[current.status]
    if (errorKey !== undefined) {
      // Stale figures stay visible below the warning; an error only means the
      // last refresh failed, not that the account spent nothing.
      parts.push(
        h(
          'div',
          { key: 'error', style: { ...labelStyle, color: 'var(--dsw-alias-state-warn-label)' } },
          t(errorKey),
        ),
      )
    }
    if (current.today !== null) {
      parts.push(
        h(
          'div',
          { key: 'today', style: rowStyle, title: String(current.today) },
          h('span', { style: labelStyle }, t('panel.accountToday')),
          h('span', { style: valueStyle }, formatMoney(current.today, accountCurrency, locale)),
        ),
      )
    }
    if (current.tokens !== null) {
      const tokens = current.tokens
      parts.push(
        h(
          'div',
          { key: 'tokens', style: { display: 'grid', gap: 6 } },
          row(
            t('panel.cacheHit'),
            `${formatTokens(tokens.cacheHit)} tok`,
            undefined,
            `${formatTokensExact(tokens.cacheHit, locale)} tok`,
          ),
          row(
            t('panel.cacheMiss'),
            `${formatTokens(tokens.cacheMiss)} tok`,
            undefined,
            `${formatTokensExact(tokens.cacheMiss, locale)} tok`,
          ),
          row(
            t('panel.output'),
            `${formatTokens(tokens.completion)} tok`,
            undefined,
            `${formatTokensExact(tokens.completion, locale)} tok`,
          ),
        ),
      )
    }
    if (current.asOf !== null) {
      parts.push(
        h(
          'div',
          { key: 'asof', style: labelStyle },
          t('panel.accountAsOf', { time: formatClock(current.asOf, timezone, locale) }),
        ),
      )
    }
    parts.push(h('div', { key: 'note', style: labelStyle }, t('panel.accountNote')))
    if (editingToken) parts.push(tokenForm('form-edit', true))
    return parts
  }

  // The token setup form: instructions with a copyable console snippet, a paste
  // field and a save button. The DSH machine needs no browser session of its own —
  // the snippet runs on any device the user is signed in on, and the result is
  // pasted here, wherever this panel is rendered.
  function tokenForm(key: string, withCancel: boolean): ReturnType<typeof h> {
    const smallButton = {
      flex: 'none',
      border: 0,
      borderRadius: 6,
      padding: '4px 10px',
      background: 'var(--dsw-alias-interactive-bg-hover)',
      color: 'var(--dsw-alias-label-primary)',
      cursor: 'pointer',
      font: 'inherit',
    } as const
    return h(
      'div',
      {
        key,
        style: {
          display: 'grid',
          gap: 6,
          padding: 8,
          borderRadius: 8,
          background: 'var(--dsw-alias-bg-skeleton)',
        },
      },
      h('div', { style: labelStyle }, t('panel.accountSetupHow')),
      h(
        'div',
        { style: { display: 'flex', gap: 6, alignItems: 'flex-start' } },
        h(
          'code',
          {
            style: {
              flex: 1,
              minWidth: 0,
              wordBreak: 'break-all',
              background: 'var(--dsw-specific-menu)',
              borderRadius: 4,
              padding: '3px 6px',
              fontSize: 11,
              lineHeight: '16px',
            },
          },
          TOKEN_SNIPPET,
        ),
        h(
          'button',
          { type: 'button', style: smallButton, onClick: copySnippet },
          snippetCopied ? t('panel.tokenCopied') : t('panel.tokenCopy'),
        ),
      ),
      h(
        'div',
        { style: { display: 'flex', gap: 6 } },
        h('input', {
          type: 'password',
          value: tokenDraft,
          placeholder: t('panel.tokenPasteHere'),
          autoComplete: 'off',
          onChange: (event: ChangeEvent<HTMLInputElement>) => setTokenDraft(event.target.value),
          style: {
            flex: 1,
            minWidth: 0,
            border: '0.5px solid var(--dsw-alias-border-l1)',
            borderRadius: 6,
            padding: '4px 8px',
            background: 'var(--dsw-specific-menu)',
            color: 'var(--dsw-alias-label-primary)',
            font: 'inherit',
          },
        }),
        h(
          'button',
          {
            type: 'button',
            disabled: tokenBusy || tokenDraft.trim() === '',
            style: {
              ...smallButton,
              ...(tokenBusy || tokenDraft.trim() === '' ? { opacity: 0.5 } : {}),
            },
            onClick: () => void saveToken(),
          },
          tokenBusy ? t('panel.tokenSaving') : t('panel.tokenSave'),
        ),
        withCancel
          ? h(
              'button',
              {
                type: 'button',
                style: smallButton,
                onClick: () => {
                  setEditingToken(false)
                  setTokenDraft('')
                  setTokenError(null)
                },
              },
              t('panel.tokenCancel'),
            )
          : null,
      ),
      tokenError === null
        ? null
        : h(
            'div',
            { style: { ...labelStyle, color: 'var(--dsw-alias-state-warn-label)' } },
            tokenError === 'invalid-token'
              ? t('panel.tokenInvalid')
              : t(ACCOUNT_ERROR_KEYS[tokenError] ?? 'panel.accountErrHttp'),
          ),
    )
  }

  const panel = h(
    'div',
    {
      style: {
        position: 'absolute',
        // Opens upward, off the row's right edge: the row sits against the bottom
        // of the window, so a panel below it would leave the viewport, and one
        // anchored left would run off the right edge of a 380px reading.
        bottom: 'calc(100% + 8px)',
        right: 0,
        width: 380,
        maxWidth: 'calc(100vw - 32px)',
        background: 'var(--dsw-specific-menu)',
        color: 'var(--dsw-alias-label-secondary)',
        boxShadow: 'var(--dsw-elevation-prominent)',
        borderRadius: 12,
        padding: 16,
        fontSize: 12,
        lineHeight: '18px',
        textAlign: 'left',
        zIndex: 100,
      },
    },
    h(
      'div',
      { style: { ...rowStyle, marginBottom: 6 } },
      h('span', { style: { ...valueStyle, fontWeight: 600 } }, t('panel.title')),
      h(
        'span',
        { style: { ...valueStyle, fontSize: 15, fontWeight: 600 } },
        formatMoney(todayCost, currency, locale),
      ),
    ),
    // The top figure's scope, named right under it: this machine, live estimate —
    // the account-level actuals are their own section below.
    h('div', { style: { ...labelStyle, marginTop: -2, marginBottom: 6 } }, t('panel.machineToday')),
    h(
      'div',
      { style: rowStyle },
      h('span', { style: labelStyle }, t('panel.tokensTotal')),
      h('span', { style: valueStyle }, `${formatTokens(payload.today?.tokens ?? 0)} tok`),
    ),
    // An idle day has no chart to show: an all-zero histogram renders as a blank
    // band that reads as broken layout, so the section is skipped entirely.
    hourly.every((bucket) => bucket.cost === 0)
      ? null
      : h(
          'div',
          { style: { display: 'flex', alignItems: 'flex-end', gap: 2, height: 40, marginTop: 8 } },
          ...hourly.map((bucket, index) =>
            h('span', {
              key: index,
              title: `${bucket.hour.toString().padStart(2, '0')}:00 · ${formatMoney(bucket.cost, currency, locale)}`,
              style: {
                flex: 1,
                minHeight: 2,
                borderRadius: '2px 2px 1px 1px',
                height: `${Math.max(4, barPercent(bucket.cost, maxHour))}%`,
                background:
                  bucket.cost === 0
                    ? 'var(--dsw-alias-border-l2)'
                    : 'var(--dsw-alias-state-business-primary)',
              },
            }),
          ),
        ),
    accountBlock,
    divider,
    h(
      'div',
      { style: { ...rowStyle, marginBottom: 6 } },
      h('span', { style: { ...valueStyle, fontWeight: 600 } }, t('panel.sessionTotal')),
      h(
        'span',
        { style: { ...valueStyle, fontSize: 15, fontWeight: 600 } },
        formatMoney(sessionCost, currency, locale),
      ),
    ),
    payload.session === undefined
      ? h('div', { style: labelStyle }, t('panel.notLive'))
      : h(
          'div',
          { style: { display: 'grid', gap: 6 } },
          row(
            t('panel.tokensTotal'),
            `${formatTokens(totalOf(payload.session.tokens))} tok`,
            undefined,
            `${formatTokensExact(totalOf(payload.session.tokens), locale)} tok`,
          ),
          row(
            t('panel.cacheHit'),
            `${hit ?? '—'} · ${formatTokens(payload.session.tokens.cacheRead)} tok`,
            undefined,
            `${formatTokensExact(payload.session.tokens.cacheRead, locale)} tok`,
          ),
          row(
            t('panel.cacheMiss'),
            `${formatTokens(payload.session.tokens.input)} tok`,
            undefined,
            `${formatTokensExact(payload.session.tokens.input, locale)} tok`,
          ),
          row(
            t('panel.output'),
            `${formatTokens(payload.session.tokens.output)} tok`,
            undefined,
            `${formatTokensExact(payload.session.tokens.output, locale)} tok`,
          ),
          row(t('panel.turnCurrent'), formatMoney(turnCost, currency, locale)),
          row(
            t('panel.pricingPeriod'),
            period === 'peak' ? t('panel.periodPeak') : t('panel.periodOffpeak'),
            period === 'peak' ? 'var(--dsw-alias-state-warn-label)' : undefined,
          ),
          // A missing transition is "not known", not "now": the host omits the
          // pair when its scan cannot see the next change, and rendering the
          // current instant claimed the rate changed at this very moment.
          nextSwitch === null
            ? null
            : row(
                t('panel.nextSwitch', {
                  time: formatClock(nextSwitch.at, timezone, locale),
                  countdown: formatCountdown(nextSwitch.at - now),
                }),
                nextSwitch.period === 'peak' ? t('panel.periodPeak') : t('panel.periodOffpeak'),
              ),
        ),
    divider,
    h('div', { style: { ...valueStyle, fontWeight: 600, marginBottom: 6 } }, t('panel.byTurn')),
    h(
      'div',
      { style: { display: 'flex', alignItems: 'flex-end', gap: 2, height: 36 } },
      ...(payload.session?.byTurn ?? []).map((turn) =>
        h('span', {
          key: turn.turn,
          title: `${t('unit.turn')} ${turn.turn} · ${formatMoney(turn.cost, currency, locale)}${turn.incomplete ? ` (${t('panel.unpriced')})` : ''}`,
          style: {
            flex: 1,
            minHeight: 4,
            borderRadius: '2px 2px 1px 1px',
            height: `${Math.max(6, barPercent(turn.cost, maxTurn))}%`,
            background: turn.incomplete
              ? 'var(--dsw-alias-state-warn-label)'
              : 'var(--dsw-alias-state-business-primary)',
          },
        }),
      ),
    ),
    divider,
    h('div', { style: { ...valueStyle, fontWeight: 600, marginBottom: 6 } }, t('panel.byModel')),
    h(
      'div',
      { style: { display: 'grid', gap: 4 } },
      ...(payload.session?.byModel ?? []).map((model, index) =>
        h(
          'div',
          {
            key: index,
            style: rowStyle,
            title: `${formatTokensExact(model.tokens.cacheRead, locale)} / ${formatTokensExact(model.tokens.input, locale)} / ${formatTokensExact(model.tokens.output, locale)}`,
          },
          h('span', { style: labelStyle }, model.model),
          h(
            'span',
            { style: valueStyle },
            `${formatTokens(model.tokens.cacheRead)} / ${formatTokens(model.tokens.input)} / ${formatTokens(model.tokens.output)} · ${formatMoney(model.cost, currency, locale)}`,
          ),
        ),
      ),
      ...unpricedModels.map((model, index) =>
        h(
          'div',
          { key: `unpriced-${index}`, style: rowStyle },
          h('span', { style: { color: 'var(--dsw-alias-state-error-primary)' } }, model),
          h(
            'span',
            { style: { color: 'var(--dsw-alias-state-error-primary)' } },
            t('panel.unpriced'),
          ),
        ),
      ),
    ),
    divider,
    h(
      'div',
      { style: { ...valueStyle, fontWeight: 600, marginBottom: 2 } },
      t('panel.composition'),
    ),
    h('div', { style: { ...labelStyle, marginBottom: 6 } }, t('panel.compositionNote')),
    h(
      'div',
      {
        style: {
          display: 'flex',
          height: 8,
          borderRadius: 4,
          overflow: 'hidden',
          background: 'var(--dsw-alias-bg-skeleton)',
        },
      },
      h('span', {
        style: {
          width: `${cacheShare.toFixed(1)}%`,
          background: 'var(--dsw-alias-state-business-primary)',
        },
      }),
      h('span', {
        style: {
          width: `${(100 - cacheShare).toFixed(1)}%`,
          background: 'var(--dsw-alias-state-warn-label)',
        },
      }),
    ),
    h(
      'div',
      { style: { ...labelStyle, display: 'flex', gap: 10, marginTop: 4, marginBottom: 6 } },
      ...compositionRows(split).map((entry) =>
        h(
          'span',
          { key: entry.key },
          `● ${t(`panel.${entry.key}`)} ${formatMoney(entry.value, currency, locale)}`,
        ),
      ),
    ),
    (split?.unpricedAttempts ?? 0) === 0
      ? null
      : h(
          'div',
          { style: { ...labelStyle, marginBottom: 6, color: 'var(--dsw-alias-state-warn-label)' } },
          t('panel.compositionUnpriced', { count: split?.unpricedAttempts ?? 0 }),
        ),
    divider,
    h(
      'div',
      { style: { ...labelStyle, display: 'grid', gap: 4 } },
      h(
        'span',
        {},
        t('panel.scopeNote', {
          projects: payload.today?.projects ?? 0,
          sessions: payload.today?.sessions ?? 0,
        }),
      ),
      // Naming the two sources is what makes a partial total readable: a reader
      // who sees "live sessions" knows the finished logs are missing, instead of
      // reading a smaller number as the truth. On an idle day both are null and the
      // line is noise, so it is left out rather than rendered as "— · —".
      (sources?.live ?? null) === null && (sources?.history ?? null) === null
        ? null
        : h(
            'span',
            {},
            `${t('panel.sourceLive')} ${formatMoney(sources?.live ?? null, currency, locale)} · ` +
              `${t('panel.sourceHistory')} ${formatMoney(sources?.history ?? null, currency, locale)}`,
          ),
      // Ended sessions whose checkpoint flush has not landed yet are counted from
      // the fold that watched them; naming the state keeps the total from reading
      // as a finished-sessions figure that disagrees with the session list.
      (sources?.draining ?? 0) > 0
        ? h(
            'span',
            {},
            `${t('panel.sourceDraining')} ${formatMoney(sources?.draining ?? null, currency, locale)}`,
          )
        : null,
      // A missing history contribution only warns when no finished log was read
      // at all: logs read successfully that simply spent nothing today are the
      // normal state, and crying "not readable" there makes a correct empty day
      // look like a failure.
      (sources?.history ?? null) === null && (sources?.historySessions ?? 0) === 0
        ? h(
            'span',
            { style: { color: 'var(--dsw-alias-state-warn-label)' } },
            t('panel.dayOnlyLive'),
          )
        : null,
      // A log this build could not read is named, not silently dropped: the day
      // total is short by exactly those sessions, and only this line says so.
      (payload.today?.skippedFiles ?? 0) === 0
        ? null
        : h(
            'span',
            { style: { color: 'var(--dsw-alias-state-warn-label)' } },
            t('panel.oldFormatSkipped', { count: payload.today?.skippedFiles ?? 0 }),
          ),
      h(
        'span',
        {},
        t('pill.updatedAt', { time: formatClock(payload.generatedAt, timezone, locale) }),
      ),
      h('span', {}, t('panel.estimateNote')),
    ),
  )

  // The pill itself: a flex item of whichever row it lands in, wrapping the button
  // so the panel has a positioning context of its own.
  const pill = h(
    'div',
    {
      ref: rootRef,
      style: {
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        flex: 'none',
      },
    },
    open ? panel : null,
    h(
      'button',
      {
        type: 'button',
        style: pillStyle,
        'aria-expanded': open,
        // The label names the metric and the tooltip carries the scope, which is the
        // only place it fits: the shipped pills beside this one read `7 turns 390
        // steps` and `78.2M tok`, i.e. quantity plus unit with no category noun, so a
        // metric label matches the row's grammar where a time prefix stood out.
        title:
          account?.today !== null && account?.today !== undefined
            ? // A bare machine zero is read as "broken" when the account spent money
              // elsewhere; the tooltip is where the pill can say both at once.
              t('pill.costHintAccount', {
                account: formatMoney(account.today, accountCurrency, locale),
                session: formatMoney(sessionCost, currency, locale),
                turn: formatMoney(turnCost, currency, locale),
                period: period === 'peak' ? t('panel.periodPeak') : t('panel.periodOffpeak'),
              })
            : t('pill.costHint', {
                session: formatMoney(sessionCost, currency, locale),
                turn: formatMoney(turnCost, currency, locale),
                period: period === 'peak' ? t('panel.periodPeak') : t('panel.periodOffpeak'),
              }),
        onClick: () => setOpen((value) => !value),
      },
      h(
        'svg',
        {
          viewBox: mark.viewBox,
          width: MARK_PX,
          height: MARK_PX,
          // An inline SVG sits on the text baseline, which makes a pill taller than
          // its neighbours and pushes its own content down; the pill is a flex row,
          // so the icon must be a block that cannot shrink.
          style: { display: 'block', flex: 'none' },
          fill: 'currentColor',
          fillRule: 'evenodd',
          'aria-hidden': true,
        },
        h('path', { d: mark.path }),
      ),
      h('span', {}, t('pill.cost')),
      h(
        'span',
        { style: { color: amountColor, fontWeight: 600 } },
        formatMoney(todayCost, currency, locale),
      ),
    ),
  )

  // The anchor is the dock's own row for this entry — empty and therefore invisible
  // while the pill is portalled into the shipped stats row, and the pill's home when
  // that row is absent (no stats yet, or a DSH that moved the marker).
  return h('div', { ref: setAnchor }, statsRow === null ? pill : createPortal(pill, statsRow))
}

function totalOf(tokens: WireTokens): number {
  return tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output
}

/** Exported for the client-half contract test. */
export type { SummaryPayload }
