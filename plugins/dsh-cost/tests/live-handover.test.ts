/**
 * A session that ends must not be lost between the registry and the disk.
 *
 * "Today" is assembled from sources that hand a session to each other: the live registry folds a
 * session while it runs, and the durable log takes over once it has ended. The handover is the
 * fragile moment — the registry drops a session the moment it ends, but the store buffers its
 * events and flushes them to the log at a later checkpoint, so the file can hold nothing but the
 * session header for an hour or more. Evicting into that file silently loses the whole session from
 * the day total, which is the number a reader watches jump every time a session is switched.
 *
 * These cases pin the draining handover: an ended session keeps counting from the fold that watched
 * it, absorbs the disk log as checkpoints land, and is handed to the plain disk path once the log
 * demonstrably covers it.
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
import type { SessionEventLike, UsageAttempt } from '@useful-dsh/cost-core'
import { computeInstant, type BillingClock } from '@useful-dsh/tz'

import { mergeAttemptTail } from '../src/history.ts'
import { dayScope, createStore, evictEndedSessions, refreshSession } from '../src/index.ts'

const CLOCK: BillingClock = { timezone: 'Asia/Shanghai', locale: 'zh-CN' }

/** Epoch ms of a Beijing-time wall clock. */
function beijing(month: number, day: number, hour: number): number {
  return Date.UTC(2026, month - 1, day, hour - 8, 0, 0)
}

/**
 * The durable events of one turn: a step boundary per step, then one settled request inside it,
 * closed by the turn boundary. One step per request keeps each request a separate billed attempt,
 * which is what the fold reports for a log that has no retry record.
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
  const last = requests.at(-1)
  events.push({
    type: 'turn/end',
    seq: 4 + (requests.length - 1) * 2,
    time: last ? last.at + 1000 : at,
    data: { turn: 1 },
  })
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
  test('an ended session keeps counting from the draining state', () => {
    const at = beijing(9, 17, 20)
    // The store's checkpoint has not landed: the file holds only the header.
    writeLog('session-ended', [])
    const store = createStore(root)
    const liveLog: SessionEventLike[] = [
      HEADER,
      ...turnAt(at, [{ at: at + 1000, input: 1_000_000 }]),
    ]
    refreshSession(
      store,
      { id: 'session-ended', seq: liveLog.length, eventAt: (position) => liveLog[position] },
      CNY_RATE_TABLE,
      CLOCK,
    )
    const whileLive = dayScope(store, CLOCK, CNY_RATE_TABLE, at + 2000)
    expect(whileLive.summary.total).not.toBeNull()

    expect(evictEndedSessions(store, new Set())).toBe(1)
    expect(store.sessions.size).toBe(0)
    expect(store.draining.has('session-ended')).toBe(true)

    // Without the draining state the session would vanish here — the disk read sees
    // a header-only file — and the day total would drop by everything it spent.
    const afterEnd = dayScope(store, CLOCK, CNY_RATE_TABLE, at + 2000)
    expect(afterEnd.summary.total).toBe(whileLive.summary.total)
    expect(afterEnd.sources.drainingSessions).toBe(1)
    expect(afterEnd.sources.historySessions).toBe(0)
  })

  test('the checkpoint flush hands the session to the disk without double counting', () => {
    const at = beijing(9, 17, 20)
    writeLog('session-ended', [])
    const store = createStore(root)
    const events = turnAt(at, [{ at: at + 1000, input: 1_000_000 }])
    const liveLog: SessionEventLike[] = [HEADER, ...events]
    refreshSession(
      store,
      { id: 'session-ended', seq: liveLog.length, eventAt: (position) => liveLog[position] },
      CNY_RATE_TABLE,
      CLOCK,
    )
    evictEndedSessions(store, new Set())

    // The checkpoint lands with the whole session; the retained fold must be
    // replaced by the disk fold, not added to it.
    writeLog('session-ended', events)
    const merged = dayScope(store, CLOCK, CNY_RATE_TABLE, at + 2000)
    expect(merged.summary.total).toBeCloseTo(pricedLog(events), 10)

    // The next poll sweeps the covered entry and the plain disk path owns the file;
    // the total stays put through the handover.
    const handedOver = dayScope(store, CLOCK, CNY_RATE_TABLE, at + 2000)
    expect(handedOver.summary.total).toBeCloseTo(pricedLog(events), 10)
    expect(handedOver.sources.historySessions).toBe(1)
    expect(handedOver.sources.drainingSessions).toBe(0)
  })

  test('a partial checkpoint is absorbed without duplicating the retained fold', () => {
    const first = beijing(9, 17, 20)
    const second = first + 60_000
    const third = second + 60_000
    const seen = turnAt(first, [{ at: first + 1000, input: 1_000_000 }])
    const partial = turnAt(first, [
      { at: first + 1000, input: 1_000_000 },
      { at: second, input: 1_000_000 },
    ])
    const complete = turnAt(first, [
      { at: first + 1000, input: 1_000_000 },
      { at: second, input: 1_000_000 },
      { at: third, input: 1_000_000 },
    ])
    writeLog('session-ended', [])
    const store = createStore(root)
    const liveLog: SessionEventLike[] = [HEADER, ...seen]
    refreshSession(
      store,
      { id: 'session-ended', seq: liveLog.length, eventAt: (position) => liveLog[position] },
      CNY_RATE_TABLE,
      CLOCK,
    )
    evictEndedSessions(store, new Set())

    // A checkpoint that landed only part of the stream already covers the retained
    // fold: the disk side takes over at exactly what has reached disk.
    writeLog('session-ended', partial)
    const partialScope = dayScope(store, CLOCK, CNY_RATE_TABLE, third + 1000)
    expect(partialScope.summary.total).toBeCloseTo(pricedLog(partial), 10)

    // The final checkpoint carries the rest.
    writeLog('session-ended', complete)
    const completeScope = dayScope(store, CLOCK, CNY_RATE_TABLE, third + 1000)
    expect(completeScope.summary.total).toBeCloseTo(pricedLog(complete), 10)
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
    expect(afterEnd.sources.drainingSessions).toBe(1)
    expect(afterEnd.sources.liveSessions).toBe(0)
    expect(afterEnd.summary.total).toBeCloseTo(priced.total ?? 0, 10)
    expect(afterEnd.summary.total).toBeGreaterThan(whileLive.summary.total ?? 0)

    // One more poll: the disk side owns the file now.
    const handedOver = dayScope(store, CLOCK, CNY_RATE_TABLE, second + 1000)
    expect(handedOver.sources.historySessions).toBe(1)
    expect(handedOver.sources.drainingSessions).toBe(0)
    expect(handedOver.summary.total).toBeCloseTo(priced.total ?? 0, 10)
  })

  test('a revived session is not double counted', () => {
    const at = beijing(9, 17, 20)
    writeLog('session-revived', [])
    const store = createStore(root)
    const events = turnAt(at, [
      { at: at + 1000, input: 1_000_000 },
      { at: at + 2000, input: 1_000_000 },
    ])
    const liveLog: SessionEventLike[] = [HEADER, ...events]
    const revived = {
      id: 'session-revived',
      seq: liveLog.length,
      eventAt: (position: number) => liveLog[position],
    }
    refreshSession(store, revived, CNY_RATE_TABLE, CLOCK)
    evictEndedSessions(store, new Set())
    expect(store.draining.has('session-revived')).toBe(true)

    // The registry hands the session back, replaying the whole stream: merging the
    // replay with the retained fold must not count any request twice.
    refreshSession(store, revived, CNY_RATE_TABLE, CLOCK)
    const scope = dayScope(store, CLOCK, CNY_RATE_TABLE, at + 3000)
    const state = store.sessions.get('session-revived')
    expect(state?.fold.attempts).toHaveLength(2)
    expect(scope.summary.total).toBeCloseTo(pricedState(state?.fold.attempts ?? []), 10)
    expect(scope.sources.liveSessions).toBe(1)
    expect(scope.sources.drainingSessions).toBe(0)
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

/** Price what one durable log folds to, dated by its own event times. */
function pricedLog(events: readonly SessionEventLike[]): number {
  const attempts = foldAttempts([HEADER, ...events])
  return (
    summarize(
      CNY_RATE_TABLE,
      attempts.map((attempt) => ({
        attempt,
        instant: computeInstant(DEEPSEEK_PEAK_SCHEDULE, CLOCK, attempt.at),
      })),
    ).total ?? 0
  )
}

/** Price a session's stored attempts under the instants their own timestamps land on. */
function pricedState(attempts: readonly UsageAttempt[]): number {
  return (
    summarize(
      CNY_RATE_TABLE,
      attempts.map((attempt) => ({
        attempt,
        instant: computeInstant(DEEPSEEK_PEAK_SCHEDULE, CLOCK, attempt.at),
      })),
    ).total ?? 0
  )
}

/** One minimal attempt for merge tests. */
function testAttempt(turn: number, step: number, input: number): UsageAttempt {
  return {
    turn,
    step,
    at: 0,
    provider: 'deepseek-official',
    model: 'deepseek-flash',
    tokens: { input, cacheRead: 0, output: 0 },
  }
}

describe('merging a draining session with its disk log', () => {
  test('a disk fold that reaches past the retained attempts covers them', () => {
    const retained = [testAttempt(1, 1, 100), testAttempt(1, 2, 200)]
    const disk = [testAttempt(1, 1, 100), testAttempt(1, 2, 200), testAttempt(2, 1, 300)]
    const merged = mergeAttemptTail(retained, disk)
    expect(merged.covered).toBe(true)
    expect(merged.attempts).toEqual(disk)
  })

  test('retries of one step pair up positionally, not by (turn, step)', () => {
    // A retry bills a second request inside the same step: both sides must list
    // the two attempts in stream order for the duplicated step to merge cleanly.
    const retained = [testAttempt(1, 1, 100), testAttempt(1, 1, 150)]
    const disk = [testAttempt(1, 1, 100), testAttempt(1, 1, 150), testAttempt(1, 2, 200)]
    const merged = mergeAttemptTail(retained, disk)
    expect(merged.covered).toBe(true)
    expect(merged.attempts).toHaveLength(3)
  })

  test('a disk fold that has not caught up leaves the retained attempts in place', () => {
    const retained = [testAttempt(1, 1, 100), testAttempt(1, 2, 200)]
    const merged = mergeAttemptTail(retained, [testAttempt(1, 1, 100)])
    expect(merged.covered).toBe(false)
    expect(merged.attempts).toEqual(retained)
  })

  test('a divergent disk fold unions instead of matching positions', () => {
    // A revived session rewritten from scratch does not share the retained
    // stream: nothing may be dropped on either side.
    const retained = [testAttempt(1, 1, 100)]
    const disk = [testAttempt(2, 1, 999)]
    const merged = mergeAttemptTail(retained, disk)
    expect(merged.covered).toBe(false)
    expect(merged.attempts).toHaveLength(2)
  })
})
