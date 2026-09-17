/**
 * A session that ends must not be lost between the registry and the disk.
 *
 * "Today" is assembled from two sources that hand a session to each other: the live registry folds
 * a session while it runs, and the durable log is read once it has ended. The handover is the
 * fragile moment — a session's log keeps growing after its last poll, and the disk scan skips any
 * file whose id is still in the live map. An entry that outlives the registry therefore freezes
 * that session's cost at whatever the last poll happened to see, and does it silently, because the
 * total is still a plausible number.
 *
 * These cases pin the handover: an ended session is evicted, its file is read from disk, and the
 * day total ends up with the events written after the last fold.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CNY_RATE_TABLE,
  DEEPSEEK_PEAK_SCHEDULE,
  foldAttempts,
  summarize,
} from '@useful-dsh/cost-core'
import type { SessionEventLike } from '@useful-dsh/cost-core'
import { computeInstant, type BillingClock } from '@useful-dsh/tz'

import { dayScope, createStore, evictEndedSessions, refreshSession } from '../src/index.ts'

const CLOCK: BillingClock = { timezone: 'Asia/Shanghai', locale: 'zh-CN' }

/** Epoch ms of a Beijing-time wall clock. */
function beijing(month: number, day: number, hour: number): number {
  return Date.UTC(2026, month - 1, day, hour - 8, 0, 0)
}

/**
 * The durable events of one turn: a step boundary per step, then one settled request inside it. One
 * step per request keeps each request a separate billed attempt, which is what the fold reports for
 * a log that has no retry record.
 */
function turnAt(
  at: number,
  requests: readonly { at: number; input: number }[],
): SessionEventLike[] {
  const events: SessionEventLike[] = [{ type: 'turn/start', seq: 1, time: at, data: { turn: 1 } }]
  for (const [index, request] of requests.entries()) {
    events.push({
      type: 'step/start',
      seq: 2 + index * 2,
      time: request.at,
      data: { turn: 1, step: index + 1 },
    })
    events.push({
      type: 'assistant/message',
      seq: 3 + index * 2,
      time: request.at,
      data: {
        turn: 1,
        step: index + 1,
        usage: { inputTokens: request.input, outputTokens: 10, cacheReadTokens: 0 },
        message: {
          role: 'assistant',
          content: [],
          source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
        },
      },
    })
  }
  return events
}

/** The log's own header row, which the fold ignores. */
const HEADER = { type: 'session', version: 3, id: 'session-ended' } as SessionEventLike

/** Write one JSONL log into the store layout the scanner expects. */
function writeLog(id: string, events: readonly SessionEventLike[]): string {
  const directory = join(root, 'project-a', id)
  mkdirSync(directory, { recursive: true })
  const path = join(directory, 'session.v3.jsonl')
  writeFileSync(path, `${[HEADER, ...events].map((e) => JSON.stringify(e)).join('\n')}\n`)
  return path
}

let root = ''

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-cost-live-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('handing a session from the registry to the disk', () => {
  test('an ended session is evicted instead of being kept as a stale live entry', () => {
    const store = createStore(root)
    store.sessions.set('session-one', {
      fold: { attempts: [], turn: 0, step: null, sample: null, endAt: null },
      consumed: 0,
      summary: {
        total: null,
        tokens: { input: 0, cacheRead: 0, output: 0 },
        byTurn: [],
        byModel: [],
        byPeriod: { peak: 0, offpeak: 0 },
        unpriced: [],
        pricedAttempts: 0,
        billedInputTokens: 0,
      },
      lastAt: 0,
    })
    store.sessions.set('session-two', store.sessions.get('session-one')!)

    expect(evictEndedSessions(store, new Set(['session-two']))).toBe(1)
    expect([...store.sessions.keys()]).toEqual(['session-two'])
  })

  test('the day total picks up what the log gained after the last fold', () => {
    // Two requests inside one step: the session was folded while it was live and
    // had only seen the first, then it ended and the log grew by the second.
    const first = beijing(9, 17, 20)
    const second = first + 60_000
    const seen = turnAt(first, [{ at: first + 1000, input: 1_000_000 }])
    const complete = turnAt(first, [
      { at: first + 1000, input: 1_000_000 },
      { at: second, input: 1_000_000 },
    ])
    writeLog('session-ended', seen)

    const store = createStore(root)
    const liveLog: SessionEventLike[] = [HEADER, ...seen]
    refreshSession(
      store,
      { id: 'session-ended', seq: liveLog.length, eventAt: (position) => liveLog[position] },
      CNY_RATE_TABLE,
      CLOCK,
    )
    const whileLive = dayScope(store, CLOCK, CNY_RATE_TABLE, second + 1000)
    expect(whileLive.sessions).toBe(1)

    // The session ends: the log gains one more settled request and the registry
    // drops it. Nothing else tells the plugin, so the next poll has to notice.
    writeLog('session-ended', complete)
    evictEndedSessions(store, new Set())
    const afterEnd = dayScope(store, CLOCK, CNY_RATE_TABLE, second + 1000)

    const attempts = foldAttempts([HEADER, ...complete])
    expect(attempts).toHaveLength(2)
    const priced = summarize(
      CNY_RATE_TABLE,
      attempts.map((attempt) => ({
        attempt,
        instant: computeInstant(DEEPSEEK_PEAK_SCHEDULE, CLOCK, attempt.at),
      })),
    )
    expect(afterEnd.sessions).toBe(1)
    expect(afterEnd.sources.historySessions).toBe(1)
    expect(afterEnd.sources.liveSessions).toBe(0)
    expect(afterEnd.summary.total).toBeCloseTo(priced.total ?? 0, 10)
    expect(afterEnd.summary.total).toBeGreaterThan(whileLive.summary.total ?? 0)
  })

  test('a session still in the registry is not read from disk as well', () => {
    const at = beijing(9, 17, 20)
    writeLog('session-live', [])
    const store = createStore(root)
    const liveLog: SessionEventLike[] = [
      HEADER,
      ...turnAt(at, [{ at: at + 1000, input: 1_000_000 }]),
    ]
    refreshSession(
      store,
      { id: 'session-live', seq: liveLog.length, eventAt: (position) => liveLog[position] },
      CNY_RATE_TABLE,
      CLOCK,
    )
    const scope = dayScope(store, CLOCK, CNY_RATE_TABLE, at + 2000)
    expect(scope.sources.liveSessions).toBe(1)
    expect(scope.sources.historySessions).toBe(0)
  })
})
