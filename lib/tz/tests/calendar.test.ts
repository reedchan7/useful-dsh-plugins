/**
 * The two calendar facts a cost figure rests on.
 *
 * "Today" is a local calendar day, and the countdown on the panel is the next change of the billed
 * period. Both are derived from `Intl` rather than from arithmetic on the UTC day, because the
 * zones this runs in are the ones where that arithmetic is wrong: a spring-forward day whose local
 * midnight never happens, and a billed schedule that is weekdays-only.
 *
 * The cases below are the two failure modes that were live in the shipped code — a "day start" that
 * landed on 23:00 of the day before, and a countdown that claimed the rate changed right now every
 * weekend — plus the invariants that keep them from coming back.
 */

import { describe, expect, test } from 'bun:test'

import { DEEPSEEK_PEAK_SCHEDULE } from '@useful-dsh/cost-core'

import { dayKey, dayStart, dayWidthMs, hoursOfDay, nextTransition, shiftDay } from '../src/index.ts'

/** Zones whose calendar rules exercise a different branch of the day math. */
const ZONES = [
  'UTC',
  'Asia/Shanghai',
  'America/New_York',
  'Europe/London',
  'America/Santiago',
  'America/Havana',
  'Australia/Lord_Howe',
  'Pacific/Chatham',
  'Pacific/Kiritimati',
  'Asia/Kathmandu',
]

describe('dayStart', () => {
  test('reports midnight in an ordinary zone', () => {
    expect(new Date(dayStart('2026-09-11', 'Asia/Shanghai')).toISOString()).toBe(
      '2026-09-10T16:00:00.000Z',
    )
  })

  test('starts a spring-forward-at-midnight day at 01:00, not the day before', () => {
    // Santiago and Havana move their clocks forward at 00:00, so the local day
    // begins at 01:00. The naive two-probe formula bounced between the two
    // offsets and answered 23:00 of the previous day, which put the whole first
    // hour of "today" into yesterday's total.
    const santiago = dayStart('2026-09-06', 'America/Santiago')
    expect(new Date(santiago).toISOString()).toBe('2026-09-06T04:00:00.000Z')
    expect(dayKey(santiago, 'America/Santiago')).toBe('2026-09-06')

    const havana = dayStart('2026-03-08', 'America/Havana')
    expect(new Date(havana).toISOString()).toBe('2026-03-08T05:00:00.000Z')
    expect(dayKey(havana, 'America/Havana')).toBe('2026-03-08')
  })

  test('starts a spring-forward-at-01:00 day an hour before the offset changes', () => {
    // London moves its clocks forward at 01:00, so local midnight still happens —
    // but it happens under the *previous* offset. The offset formula answers
    // 00:00 UTC, an hour into the day, and its first hour is lost.
    const london = dayStart('2026-03-29', 'Europe/London')
    expect(new Date(london).toISOString()).toBe('2026-03-29T00:00:00.000Z')
    expect(dayKey(london, 'Europe/London')).toBe('2026-03-29')
    expect(dayKey(london - 1, 'Europe/London')).toBe('2026-03-28')
  })

  test('a half-hour-offset zone starts its day on the day, not a day out', () => {
    // Lord Howe shifts by 30 minutes, and its offset reverses mid-hour: an offset
    // probe there can answer with the neighbouring day entirely.
    for (const key of ['2025-04-06', '2026-04-05']) {
      const start = dayStart(key, 'Australia/Lord_Howe')
      expect(dayKey(start, 'Australia/Lord_Howe')).toBe(key)
      expect(dayKey(start - 1, 'Australia/Lord_Howe')).not.toBe(key)
    }
  })

  test('starts on the key in every zone and every day of three years', () => {
    // The invariant the caller depends on: `dayStart(key)` is an instant whose own
    // local date is the key. A start that belongs to another day silently shifts a
    // bucket of the hourly chart and an hour of the day total.
    for (const zone of ZONES) {
      let wrong = 0
      for (let offset = 0; offset < 366 * 3; offset += 1) {
        const key = shiftDay('2025-01-01', offset)
        if (dayKey(dayStart(key, zone), zone) !== key) wrong += 1
      }
      expect({ zone, wrong }).toEqual({ zone, wrong: 0 })
    }
  })

  test('is the earliest instant of its own day', () => {
    for (const zone of ZONES) {
      const key = '2026-09-06'
      const start = dayStart(key, zone)
      expect(dayKey(start - 1, zone)).not.toBe(key)
      const end = dayStart(shiftDay(key, 1), zone)
      expect(dayKey(end - 1, zone)).toBe(key)
      expect(dayKey(start, zone)).toBe(key)
    }
  })

  test('a whole local day is contiguous and 22-26 hours wide', () => {
    for (const zone of ZONES) {
      const offenders: string[] = []
      for (let offset = 0; offset < 366 * 3; offset += 1) {
        const key = shiftDay('2025-01-01', offset)
        const width = dayWidthMs(key, zone)
        if (width < 22 * 3_600_000 || width > 26 * 3_600_000) offenders.push(`${key} ${width}`)
        if (dayKey(dayStart(key, zone) + width - 1, zone) !== key) offenders.push(`${key} tail`)
      }
      expect({ zone, offenders }).toEqual({ zone, offenders: [] })
    }
  })
})

describe('hoursOfDay', () => {
  test('buckets a spring-forward day from 01:00 to midnight', () => {
    const hours = hoursOfDay('2026-09-06', 'America/Santiago')
    expect(hours).toHaveLength(23)
    expect(hours[0]?.hour).toBe(1)
    expect(hours.at(-1)?.hour).toBe(23)
  })

  test('buckets an ordinary day from 00:00 to 23:00', () => {
    const hours = hoursOfDay('2026-09-11', 'Asia/Shanghai')
    expect(hours).toHaveLength(24)
    expect(hours[0]?.hour).toBe(0)
    expect(hours.at(-1)?.hour).toBe(23)
  })

  test('every bucket belongs to the requested day', () => {
    for (const zone of ZONES) {
      for (const key of ['2026-03-08', '2026-09-06', '2026-11-01']) {
        for (const bucket of hoursOfDay(key, zone)) {
          expect(dayKey(bucket.start, zone)).toBe(key)
        }
      }
    }
  })
})

describe('nextTransition', () => {
  test('finds the next peak window on a weekday morning', () => {
    // 2026-09-11 is a Friday; Beijing peak starts at 09:00.
    const at = Date.parse('2026-09-11T01:00:00Z') // 09:00 Beijing, peak
    const next = nextTransition(DEEPSEEK_PEAK_SCHEDULE, at)
    expect(next).not.toBeNull()
    expect(new Date(next!.at).toISOString()).toBe('2026-09-11T04:00:00.000Z') // 12:00 Beijing
    expect(next?.period).toBe('offpeak')
  })

  test('spans the weekend gap instead of reporting no change', () => {
    // Friday 18:00 Beijing ends peak; the next change is Monday 09:00, which is 63
    // hours later. A two-day scan returned null for every weekend instant in that
    // stretch, and the panel rendered the null as "next change at this moment, in
    // 0h 00m 00s" for 15 hours of every week.
    const fridayEvening = Date.parse('2026-09-11T10:00:00Z')
    const next = nextTransition(DEEPSEEK_PEAK_SCHEDULE, fridayEvening)
    expect(next).not.toBeNull()
    expect(new Date(next!.at).toISOString()).toBe('2026-09-14T01:00:00.000Z')
    expect(next?.period).toBe('peak')
    expect((next!.at - fridayEvening) / 3_600_000).toBe(63)
  })

  test('always finds the next change, whatever the instant', () => {
    // The scan window must cover the longest gap the schedule can produce; a null
    // is what the caller renders as "no countdown", so a hole here is visible.
    const monday = Date.parse('2026-09-07T00:00:00+08:00')
    for (let at = monday; at < monday + 7 * 86_400_000; at += 600_000) {
      expect(nextTransition(DEEPSEEK_PEAK_SCHEDULE, at)).not.toBeNull()
    }
  })

  test('the reported instant is the first minute of the new period', () => {
    const monday = Date.parse('2026-09-07T00:00:00+08:00')
    for (let at = monday; at < monday + 3 * 86_400_000; at += 1_800_000) {
      const next = nextTransition(DEEPSEEK_PEAK_SCHEDULE, at)
      if (next === null) continue
      expect(next.at % 60_000).toBe(0)
      expect(next.at).toBeGreaterThan(at)
    }
  })
})
