/**
 * Timezone and billing-calendar math.
 *
 * The provider publishes peak windows in Beijing time while a reader may sit anywhere on earth, so
 * the two questions are kept apart: which _instant_ a usage sample belongs to (absolute,
 * timezone-free), and which local calendar day or hour it falls in for a _given_ zone. Every
 * function is clock- and locale-injected so tests can pin both.
 */

import type { BillingInstant, PeakSchedule, RatePeriod } from '@useful-dsh/cost-core'

/** One caller's clock, zone and language; everything here is derived from it. */
export interface BillingClock {
  /** IANA zone the reader sees calendars in. */
  timezone: string
  /** BCP-47 tag used for month and weekday names. */
  locale: string
}

/** Wall-clock fields of one instant in one zone. */
export interface ZonedParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
  second: number
  weekday: number
}

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

/**
 * How far ahead {@link nextTransition} searches by default.
 *
 * Four days, not two: the billed schedule is weekdays-only, so the longest gap with no transition
 * at all is the 63 hours from Friday 18:00 to Monday 09:00 Beijing time. A two-day window returns
 * null for every instant in the last stretch of it, and a caller that reads null as "no change"
 * then shows a countdown to the current moment.
 */
export const DEFAULT_TRANSITION_SCAN_MS = 4 * 24 * HOUR

/** Cache of the formatters we reuse; constructing an `Intl.DateTimeFormat` is expensive. */
const formatterCache = new Map<string, Intl.DateTimeFormat>()

function partsFormatter(timezone: string): Intl.DateTimeFormat {
  const key = `parts:${timezone}`
  let formatter = formatterCache.get(key)
  if (formatter === undefined) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hour12: false,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    })
    formatterCache.set(key, formatter)
  }
  return formatter
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const

/** Wall-clock fields of one instant in one zone, with `weekday` 0 = Sunday. */
export function zonedParts(epochMs: number, timezone: string): ZonedParts {
  const parts = partsFormatter(timezone).formatToParts(new Date(epochMs))
  const read = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((part) => part.type === type)?.value ?? '0'
  const weekdayName = read('weekday')
  const weekday = WEEKDAYS.findIndex((name) => weekdayName.startsWith(name))
  return {
    year: Number(read('year')),
    month: Number(read('month')),
    day: Number(read('day')),
    hour: Number(read('hour')) % 24,
    minute: Number(read('minute')),
    second: Number(read('second')),
    weekday: weekday < 0 ? 0 : weekday,
  }
}

/** Offset of one zone at one instant, in milliseconds east of UTC. */
export function zoneOffsetMs(epochMs: number, timezone: string): number {
  const parts = zonedParts(epochMs, timezone)
  const asUtc = Date.UTC(
    parts.year,
    parts.month - 1,
    parts.day,
    parts.hour,
    parts.minute,
    parts.second,
  )
  return asUtc - Math.floor(epochMs / SECOND) * SECOND
}

/** `YYYY-MM-DD` of one instant in one zone; sorts lexicographically by day. */
export function dayKey(epochMs: number, timezone: string): string {
  const { year, month, day } = zonedParts(epochMs, timezone)
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day
    .toString()
    .padStart(2, '0')}`
}

/**
 * First instant of one local calendar day. The day key is a step function of the instant, so the
 * boundary is exactly where it steps, and bisection finds it. Deriving midnight from the zone
 * offset cannot: where a local midnight does not exist (Santiago and Havana spring forward at
 * 00:00) the offset in force at the boundary is the post-transition one, so the formula lands on
 * 23:00 of the day before; half-hour zones like Lord Howe break it a second way.
 */
export function dayStart(key: string, timezone: string): number {
  const [year, month, day] = key.split('-').map(Number)
  const target = Date.UTC(year ?? 1970, (month ?? 1) - 1, day ?? 1)
  // The window brackets the whole day: a local day starting before `target - 25h`
  // would need an offset beyond the IANA range, and 26h after `target` is past the
  // day's end whatever the zone's offset is.
  let low = target - 25 * HOUR
  let high = target + 26 * HOUR
  while (high - low > 1) {
    const middle = Math.floor((low + high) / 2)
    if (dayKey(middle, timezone) >= key) {
      high = middle
    } else {
      low = middle
    }
  }
  return high
}

/** Every hour bucket of one local day in chronological order, for an hourly chart. */
export function hoursOfDay(
  key: string,
  timezone: string,
): { hour: number; start: number; end: number }[] {
  const start = dayStart(key, timezone)
  const end = dayStart(shiftDay(key, 1), timezone)
  const hours: { hour: number; start: number; end: number }[] = []
  for (let cursor = start; cursor < end;) {
    const hour = zonedParts(cursor, timezone).hour
    const next = Math.min(cursor + HOUR, end)
    hours.push({ hour, start: cursor, end: next })
    cursor = next
  }
  return hours
}

/** Move a day key by whole (signed) local days. */
export function shiftDay(key: string, days: number): string {
  const [year, month, day] = key.split('-').map(Number)
  const shifted = new Date(Date.UTC(year ?? 1970, (month ?? 1) - 1, (day ?? 1) + days))
  return `${shifted.getUTCFullYear().toString().padStart(4, '0')}-${(shifted.getUTCMonth() + 1)
    .toString()
    .padStart(2, '0')}-${shifted.getUTCDate().toString().padStart(2, '0')}`
}

/** Whether a schedule's window list places one instant in peak. */
export function resolvePeriod(schedule: PeakSchedule, epochMs: number): RatePeriod {
  const parts = zonedParts(epochMs, schedule.timezone)
  const weekend = parts.weekday === 0 || parts.weekday === 6
  if (weekend && schedule.weekdaysOnly === true) return 'offpeak'
  const minuteOfDay = parts.hour * 60 + parts.minute
  for (const [start, end] of schedule.windows) {
    if (minuteOfDay >= start && minuteOfDay < end) return 'peak'
  }
  return 'offpeak'
}

/**
 * Everything a price needs from the clock: the instant, its local day, the billed period and the
 * next period change.
 */
export function computeInstant(
  schedule: PeakSchedule,
  clock: BillingClock,
  at: number,
  scanMs = DEFAULT_TRANSITION_SCAN_MS,
): BillingInstant {
  const period = resolvePeriod(schedule, at)
  const next = nextTransition(schedule, at, scanMs)
  return {
    at,
    period,
    billedZoned: zonedParts(at, schedule.timezone),
    localZoned: zonedParts(at, clock.timezone),
    localDayKey: dayKey(at, clock.timezone),
    billedDayKey: dayKey(at, schedule.timezone),
    nextTransitionAt: next?.at ?? null,
    nextPeriod: next?.period ?? null,
  }
}

/**
 * First instant after `from` at which the billed period differs. The schedule is minute-granular,
 * so the search steps a minute at a time and reports the exact boundary; this is what a countdown
 * reads.
 */
export function nextTransition(
  schedule: PeakSchedule,
  from: number,
  scanMs = DEFAULT_TRANSITION_SCAN_MS,
): { at: number; period: RatePeriod } | null {
  const current = resolvePeriod(schedule, from)
  const limit = from + scanMs
  const firstMinute = Math.floor(from / MINUTE) * MINUTE + MINUTE
  for (let cursor = firstMinute; cursor <= limit; cursor += MINUTE) {
    const period = resolvePeriod(schedule, cursor)
    if (period !== current) return { at: cursor, period }
  }
  return null
}

/** Load the caller's zone and locale from the runtime. */
export function loadBillingClock(): BillingClock {
  let timezone = 'UTC'
  let locale = 'en'
  try {
    timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  } catch {
    // A runtime without a resolved zone falls back to UTC; the UI marks it.
  }
  try {
    locale = Intl.DateTimeFormat().resolvedOptions().locale || 'en'
  } catch {
    // Same for the locale: English is the documented fallback.
  }
  return { timezone, locale }
}

/** Human label for a zone at one instant, e.g. `GMT+8`. */
export function zoneLabel(epochMs: number, timezone: string, locale = 'en'): string {
  const formatter = new Intl.DateTimeFormat(locale, { timeZone: timezone, timeZoneName: 'short' })
  const part = formatter
    .formatToParts(new Date(epochMs))
    .find((candidate) => candidate.type === 'timeZoneName')
  return part?.value ?? timezone
}

/** Millisecond width of one local day (23h/24h/25h across DST), for progress bars. */
export function dayWidthMs(key: string, timezone: string): number {
  return dayStart(shiftDay(key, 1), timezone) - dayStart(key, timezone)
}
