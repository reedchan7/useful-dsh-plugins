/**
 * The account-level day total.
 *
 * "Today" is the number the pill shows by default, and it is the number a reader is least able to
 * sanity-check by eye: it spans every project on the machine. These cases pin the parts that could
 * quietly be wrong — which files count, what happens to a file this build cannot read, and whether
 * a live session's turn is double counted once its log reaches disk.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { zstdCompressSync } from 'node:zlib'

import { CNY_RATE_TABLE, DEEPSEEK_PEAK_SCHEDULE } from '@useful-dsh/cost-core'
import { computeInstant } from '@useful-dsh/tz'

import {
  createHistoryCache,
  listSessionFiles,
  readSessionLog,
  scanHistory,
  summarizeHistoryDay,
} from '../src/history.ts'

const CLOCK = { timezone: 'Asia/Shanghai', locale: 'zh-CN' }

/** A Beijing-time wall clock in epoch ms. */
function beijing(year: number, month: number, day: number, hour: number): number {
  return Date.UTC(year, month - 1, day, hour - 8, 0, 0)
}

/**
 * Today's Beijing-time hour, as the harness would date it. Used where a case needs both a recent
 * file modification time and a specific local hour, which a hardcoded date cannot give once the day
 * moves on.
 */
function recentBeijingHour(hour: number): number {
  const key = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
  const [year, month, day] = key.split('-').map(Number)
  return beijing(year ?? 2026, month ?? 1, day ?? 1, hour)
}

/** One durable session log body, in the shape real logs carry. */
function sessionLog(at: number, model: string, tokens: Record<string, number>): string {
  const events = [
    { type: 'session', version: 3, id: 'session-test' },
    { type: 'turn/start', seq: 1, time: at, data: { turn: 1 } },
    { type: 'step/start', seq: 2, time: at, data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message',
      seq: 3,
      time: at + 1000,
      data: {
        turn: 1,
        step: 1,
        usage: tokens,
        message: {
          role: 'assistant',
          content: [],
          source: { kind: 'model', provider: 'deepseek-official', model },
        },
      },
    },
    { type: 'turn/end', seq: 4, time: at + 2000, data: { turn: 1 } },
  ]
  return `${events.map((event) => JSON.stringify(event)).join('\n')}\n`
}

let root = ''

/** Write one session log into the store layout the scanner expects. */
function writeSession(project: string, id: string, body: string, compressed = true): string {
  const directory = join(root, project, id)
  mkdirSync(directory, { recursive: true })
  const path = join(directory, compressed ? 'session.v3.jsonl.zstd' : 'session.v3.jsonl')
  writeFileSync(path, compressed ? zstdCompressSync(Buffer.from(body, 'utf8')) : body)
  return path
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-cost-history-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('reading the session store', () => {
  test('a compressed modern log is folded into priced attempts', () => {
    const at = beijing(2026, 9, 17, 20)
    const path = writeSession(
      'project-a',
      'session-one',
      sessionLog(at, 'deepseek-flash', {
        inputTokens: 1_000,
        cacheReadTokens: 999_000,
        outputTokens: 500,
      }),
    )
    const events = readSessionLog(path)
    expect(events).not.toBeNull()
    expect(events).toHaveLength(5)
  })

  test('an uncompressed log reads the same way', () => {
    const at = beijing(2026, 9, 17, 20)
    const path = writeSession(
      'project-a',
      'session-two',
      sessionLog(at, 'deepseek-flash', { inputTokens: 10, outputTokens: 5 }),
      false,
    )
    expect(readSessionLog(path)).toHaveLength(5)
  })

  test('a corrupt payload is reported as unreadable rather than throwing', () => {
    const directory = join(root, 'project-a', 'session-broken')
    mkdirSync(directory, { recursive: true })
    const path = join(directory, 'session.v3.jsonl.zstd')
    writeFileSync(path, Buffer.from('not actually zstd', 'utf8'))
    expect(readSessionLog(path)).toBeNull()
  })

  test('a log written as one frame per event reads as the whole session', () => {
    // How the store actually writes: one independently decodable frame per
    // durable append. A decoder that stops after the first frame reads only the
    // `session` header, so the session vanishes from the day total while its
    // own live figure stays right.
    const at = beijing(2026, 9, 17, 20)
    const body = sessionLog(at, 'deepseek-flash', {
      inputTokens: 1_000,
      cacheReadTokens: 999_000,
      outputTokens: 500,
    })
    const directory = join(root, 'project-a', 'session-framed')
    mkdirSync(directory, { recursive: true })
    const path = join(directory, 'session.v3.jsonl.zstd')
    writeFileSync(
      path,
      Buffer.concat(
        body
          .trimEnd()
          .split('\n')
          .map((line) => zstdCompressSync(Buffer.from(`${line}\n`, 'utf8'))),
      ),
    )
    const events = readSessionLog(path)
    expect(events).toHaveLength(5)
    const scan = scanHistory(createHistoryCache(), root, CLOCK, at + 60_000, new Set())
    expect(scan.attempts).toHaveLength(1)
    expect(scan.skipped).toBe(0)
  })

  test('a torn final line does not lose the events before it', () => {
    const at = beijing(2026, 9, 17, 20)
    const body = `${sessionLog(at, 'deepseek-flash', { inputTokens: 10, outputTokens: 5 }).trimEnd()}\n{"type":"assistant/mes`
    const path = writeSession('project-a', 'session-torn', body, false)
    expect(readSessionLog(path)).toHaveLength(5)
  })
})

describe('listing the store', () => {
  test('only files inside the requested window are listed', () => {
    // The window is applied to the file's own modification time, so the cutoffs
    // are relative to now rather than to the synthetic event timestamps.
    const at = beijing(2026, 9, 17, 20)
    writeSession(
      'project-a',
      'session-one',
      sessionLog(at, 'deepseek-flash', { inputTokens: 1, outputTokens: 1 }),
    )
    const files = listSessionFiles(root, Date.now() - 60_000)
    expect(files).toHaveLength(1)
    expect(files[0]?.project).toBe('project-a')
    // A window that starts in the future excludes everything already written.
    expect(listSessionFiles(root, Date.now() + 60_000)).toHaveLength(0)
  })

  test('a missing store root yields no files instead of throwing', () => {
    expect(listSessionFiles(join(root, 'does-not-exist'), 0)).toEqual([])
  })
})

describe('scanning for the day', () => {
  test('attempts from every project are read, and a live session is excluded', () => {
    const at = beijing(2026, 9, 17, 20)
    writeSession(
      'project-a',
      'session-live',
      sessionLog(at, 'deepseek-flash', { inputTokens: 1_000, outputTokens: 10 }),
    )
    writeSession(
      'project-b',
      'session-done',
      sessionLog(at, 'deepseek-flash', { inputTokens: 2_000, outputTokens: 20 }),
    )

    const cache = createHistoryCache()
    const all = scanHistory(cache, root, CLOCK, at + 60_000, new Set())
    expect(all.sessionsRead).toBe(2)
    expect(all.projects.toSorted()).toEqual(['project-a', 'project-b'])
    expect(all.skipped).toBe(0)

    // The live session is folded from the registry, so its file must not be read
    // again here or the day would count the same turn twice.
    const withoutLive = scanHistory(cache, root, CLOCK, at + 60_000, new Set(['session-live']))
    expect(withoutLive.sessionsRead).toBe(1)
    expect(withoutLive.attempts).toHaveLength(1)
  })

  test('an unreadable log is counted, not silently dropped', () => {
    const at = beijing(2026, 9, 17, 20)
    writeSession(
      'project-a',
      'session-good',
      sessionLog(at, 'deepseek-flash', { inputTokens: 5, outputTokens: 5 }),
    )
    const directory = join(root, 'project-b', 'session-broken')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'session.v3.jsonl.zstd'), Buffer.from('broken', 'utf8'))

    const scan = scanHistory(createHistoryCache(), root, CLOCK, at + 60_000, new Set())
    expect(scan.sessionsRead).toBe(1)
    expect(scan.skipped).toBe(1)
  })

  test('an unchanged file is reused from the cache', () => {
    const at = beijing(2026, 9, 17, 20)
    writeSession(
      'project-a',
      'session-one',
      sessionLog(at, 'deepseek-flash', { inputTokens: 5, outputTokens: 5 }),
    )
    const cache = createHistoryCache()
    const first = scanHistory(cache, root, CLOCK, at + 60_000, new Set())
    const second = scanHistory(cache, root, CLOCK, at + 60_000, new Set())
    expect(second.sessionsRead).toBe(first.sessionsRead)
    expect(second.attempts).toEqual(first.attempts)
    expect(cache.size).toBe(1)
  })

  test('a stale empty cache entry does not hide a real log', () => {
    const at = recentBeijingHour(20)
    const path = writeSession(
      'project-a',
      'session-one',
      sessionLog(at, 'deepseek-flash', { inputTokens: 1_000, outputTokens: 10 }),
    )
    const cache = createHistoryCache()
    const stat = statSync(path)
    // Simulate an entry recorded from a read that yielded nothing: same mtime, but
    // the file on disk is bigger than the entry claims it was.
    cache.set(path, { modifiedAt: stat.mtimeMs, attempts: [], size: 1 })
    const scan = scanHistory(cache, root, CLOCK, Date.now(), new Set())
    expect(scan.attempts).toHaveLength(1)
  })

  test('the day total is priced, bucketed by local hour, and excludes other days', () => {
    // Anchored to now, because the scan selects files by modification time: a
    // sample dated in the past is still priced, but its file is outside the
    // window and would never be read.
    const today = recentBeijingHour(20) // after the Beijing windows: off-peak
    const yesterday = today - 24 * 3_600_000
    writeSession(
      'project-a',
      'session-today',
      sessionLog(today, 'deepseek-flash', { inputTokens: 1_000_000, outputTokens: 0 }),
    )
    writeSession(
      'project-b',
      'session-yesterday',
      sessionLog(yesterday, 'deepseek-flash', { inputTokens: 5_000_000, outputTokens: 0 }),
    )

    const scan = scanHistory(createHistoryCache(), root, CLOCK, today + 60_000, new Set())
    const day = summarizeHistoryDay(scan.attempts, CNY_RATE_TABLE, CLOCK, today + 60_000)

    // 20:00 Beijing is off-peak, and the published renminbi off-peak input rate
    // is ¥1/M, so 1M uncached input costs ¥1.
    expect(day.summary.total).toBeCloseTo(1, 10)
    const bucket = day.hourly[20]
    expect(bucket?.cost).toBeCloseTo(1, 10)
    expect(day.summary.pricedAttempts).toBe(1)
  })

  test('a model the price book cannot place stays visible as unpriced', () => {
    const at = beijing(2026, 9, 17, 20)
    writeSession(
      'project-a',
      'session-unknown',
      sessionLog(at, 'some-other-model', { inputTokens: 1_000, outputTokens: 100 }),
    )
    const scan = scanHistory(createHistoryCache(), root, CLOCK, at + 60_000, new Set())
    const day = summarizeHistoryDay(scan.attempts, CNY_RATE_TABLE, CLOCK, at + 60_000)
    expect(day.summary.total).toBeNull()
    expect(day.summary.unpriced).toHaveLength(1)
    void computeInstant(DEEPSEEK_PEAK_SCHEDULE, CLOCK, at)
  })
})
