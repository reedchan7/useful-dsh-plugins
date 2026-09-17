/**
 * Display formatting for money, tokens, percentages, durations and instants.
 *
 * Every figure a reader sees goes through here, so a pill and its detail panel cannot disagree.
 * Money keeps the currency's own display precision instead of the locale default (JPY-style zero
 * decimals would erase a real cost) and large token counts are abbreviated with the locale's own
 * units.
 */

import type { CurrencyCode } from '@useful-dsh/cost-core'

/** Symbols for the currencies the DeepSeek price books use. */
const SYMBOLS: Readonly<Record<CurrencyCode, string>> = { CNY: '¥', USD: '$' }

/**
 * Display precision for money, in fraction digits. Two: a cost readout is an estimate of reported
 * token counts, and more digits would claim an accuracy the measurement does not have.
 */
const DISPLAY_DIGITS = 2

/** Unit ladder for abbreviated token counts. */
const TOKEN_UNITS = [
  { limit: 1e12, suffix: 'T' },
  { limit: 1e9, suffix: 'B' },
  { limit: 1e6, suffix: 'M' },
  { limit: 1e3, suffix: 'K' },
] as const

export function currencySymbol(currency: CurrencyCode): string {
  return SYMBOLS[currency]
}

/**
 * Round an amount to cents, half-up: the rounding a reader uses when checking a total against its
 * parts. The bias on a tie is one cent, far below the estimate's own error, while an unexplained
 * mismatch is what makes a cost display untrustworthy.
 */
export function roundToCents(amount: number): number {
  // `halfExpand` is half-away-from-zero, the rounding a reader expects. It is
  // applied to the amount's decimal representation rather than to `amount * 100`,
  // which would introduce its own binary-float error before rounding.
  const rounded = new Intl.NumberFormat('en', {
    minimumFractionDigits: DISPLAY_DIGITS,
    maximumFractionDigits: DISPLAY_DIGITS,
    roundingMode: 'halfExpand',
    useGrouping: false,
  }).format(amount)
  return Number(rounded)
}

/**
 * Format a money amount in its own currency.
 *
 * @returns E.g. `¥1.94`, `<¥0.01` for a real but sub-cent amount, `¥0` when nothing was billed, and
 *   `—` for null.
 */
export function formatMoney(amount: number | null, currency: CurrencyCode, locale = 'en'): string {
  if (amount === null || !Number.isFinite(amount)) return '—'
  const symbol = SYMBOLS[currency]
  if (amount === 0) return `${symbol}0`
  // A nonzero amount under half a cent would round to `0.00`, which reads as "no
  // cost" rather than "a cost too small to show"; say which one it is.
  if (Math.abs(amount) < 0.005) return `<${symbol}0.01`
  // One formatter does rounding, grouping and the locale's separators together, so
  // the displayed cents are the rounded cents and never a re-formatted approximation.
  // Grouping is decided by magnitude, not by the signed value: `amount >= 10_000`
  // left `-¥1234567.89` unseparated beside a grouped positive.
  return `${symbol}${new Intl.NumberFormat(locale, {
    minimumFractionDigits: DISPLAY_DIGITS,
    maximumFractionDigits: DISPLAY_DIGITS,
    roundingMode: 'halfExpand',
    useGrouping: Math.abs(amount) >= 10_000,
  }).format(amount)}`
}

/**
 * Format a money amount with the sign always shown, for deltas.
 *
 * @returns E.g. `+¥0.0312` / `-¥1.2000`, or `—` for a non-finite amount.
 */
export function formatMoneyDelta(amount: number, currency: CurrencyCode, locale = 'en'): string {
  if (!Number.isFinite(amount)) return '—'
  const sign = amount < 0 ? '-' : '+'
  return `${sign}${formatMoney(Math.abs(amount), currency, locale)}`
}

/**
 * Abbreviate a token count.
 *
 * @returns E.g. `121.7M`, `180`, `—` for a non-finite count.
 */
export function formatTokens(count: number, locale = 'en', digits = 1): string {
  if (!Number.isFinite(count)) return '—'
  const magnitude = Math.abs(count)
  for (const { limit, suffix } of TOKEN_UNITS) {
    if (magnitude >= limit) {
      return `${(count / limit).toLocaleString(locale, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
      })}${suffix}`
    }
  }
  return count.toLocaleString(locale)
}

/** Exact token count with thousands separators, for detail rows; e.g. `121,721,703`. */
export function formatTokensExact(count: number, locale = 'en'): string {
  return Number.isFinite(count) ? count.toLocaleString(locale) : '—'
}

/**
 * Share of prompt-side tokens served from cache. A full hit is reported as `100%` because it is
 * exact; every partial hit stays visibly below 100, because rounding a near-total hit up would
 * claim a cache discount that was not granted. Fraction digits therefore extend until the text
 * stops rounding to 100 — at 10^9 prompt tokens a four-token miss is 99.9999996%, and six digits
 * printed it as `100.000000%`.
 *
 * @returns The percentage text, or null when nothing was billed on the prompt side.
 */
export function formatCacheHitPercent(
  cacheReadTokens: number,
  promptTokens: number,
  digits = 1,
): string | null {
  if (!Number.isFinite(cacheReadTokens) || !Number.isFinite(promptTokens)) return null
  if (promptTokens <= 0) return null
  // Exact equality is the only full hit: token counts are integers, so this is a
  // decision the data supports rather than one a rounded ratio has to guess.
  if (cacheReadTokens === promptTokens) return '100%'
  const exact = (cacheReadTokens / promptTokens) * 100
  let places = digits
  while (Number(exact.toFixed(places)) >= 100) places += 1
  return `${exact.toFixed(places)}%`
}

/** Compact duration, e.g. `2h 05m` or `48m`. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const totalMinutes = Math.round(ms / 60_000)
  if (totalMinutes < 60) return `${totalMinutes}m`
  const hours = Math.floor(totalMinutes / 60)
  const minutes = totalMinutes % 60
  if (hours < 24) return `${hours}h ${minutes.toString().padStart(2, '0')}m`
  const days = Math.floor(hours / 24)
  return `${days}d ${(hours % 24).toString().padStart(2, '0')}h`
}

/** Countdown as `2h 05m 09s`, for the peak/off-peak switch. */
export function formatCountdown(ms: number): string {
  if (!Number.isFinite(ms)) return '—'
  const total = Math.max(0, Math.floor(ms / 1000))
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const seconds = total % 60
  return `${hours}h ${minutes.toString().padStart(2, '0')}m ${seconds.toString().padStart(2, '0')}s`
}

/** Clock time in one zone, e.g. `14:03`. */
export function formatClock(epochMs: number, timezone: string, locale = 'en'): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(epochMs))
}

/** Date and time in one zone, e.g. `Sep 17, 14:03`. */
export function formatDateTime(epochMs: number, timezone: string, locale = 'en'): string {
  return new Intl.DateTimeFormat(locale, {
    timeZone: timezone,
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(epochMs))
}

export function formatHour(hour: number): string {
  return hour.toString().padStart(2, '0')
}

/** Turn a ratio in `[0,1]` into a bar width percentage, clamped. */
export function barPercent(value: number, max: number): number {
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return 0
  return Math.max(0, Math.min(100, (value / max) * 100))
}

/** A share of a whole, as a clamped percentage number (not text). */
export function percentOf(part: number, whole: number): number {
  if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return 0
  return Math.max(0, Math.min(100, (part / whole) * 100))
}
