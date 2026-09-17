/**
 * Folding rules for one session log.
 *
 * The fold decides how much money a turn cost, so the cases below pin the accounting identities
 * that matter: one attempt per billed request, a retry billed as a second request, streaming
 * samples replaced by the final one, and a truncated log yielding what it can instead of throwing.
 */

import { describe, expect, test } from 'bun:test'

import { foldAttempts, type SessionEventLike } from '../src/index.ts'

const T0 = Date.UTC(2026, 8, 17, 4, 0, 0)

/**
 * One assistant message in the durable log shape: settled usage at `data.usage`, route nested at
 * `data.message.source` (verified against real session files; the in-flight shape differs).
 */
function assistant(
  at: number,
  model: string,
  usage: Record<string, number>,
  streamExtra: { type: string; usage: Record<string, number> }[] = [],
): SessionEventLike {
  return {
    type: 'assistant/message',
    time: at,
    data: {
      turn: 1,
      step: 1,
      usage,
      message: {
        role: 'assistant',
        content: [],
        id: `msg-${at}`,
        source: { kind: 'model', provider: 'deepseek-official', model },
      },
      stream: streamExtra,
    },
  }
}

/** One assistant message in the in-flight shape: usage only inside the stream. */
function streamingAssistant(
  at: number,
  model: string,
  usage: Record<string, number>,
): SessionEventLike {
  return {
    type: 'assistant/message',
    time: at,
    data: {
      source: { provider: 'deepseek-official', model },
      stream: [{ type: 'usage', usage }],
    },
  }
}

function stepStart(at: number, turn: number, step: number): SessionEventLike {
  return { type: 'step/start', time: at, data: { turn, step } }
}

describe('foldAttempts', () => {
  test('one billed request becomes one attempt carrying turn, model and tokens', () => {
    const attempts = foldAttempts([
      { type: 'turn/start', time: T0, data: { turn: 3 } },
      stepStart(T0 + 10, 3, 0),
      assistant(T0 + 20, 'deepseek-flash', {
        inputTokens: 100,
        cacheReadTokens: 900,
        outputTokens: 50,
      }),
      { type: 'turn/end', time: T0 + 30, data: { turn: 3 } },
    ])
    expect(attempts).toHaveLength(1)
    expect(attempts[0]).toEqual({
      turn: 3,
      step: 0,
      at: T0 + 20,
      provider: 'deepseek-official',
      model: 'deepseek-flash',
      tokens: { input: 100, cacheRead: 900, output: 50 },
    })
  })

  test('the final usage sample replaces streaming samples of the same attempt', () => {
    const attempts = foldAttempts([
      { type: 'turn/start', time: T0, data: { turn: 1 } },
      stepStart(T0, 1, 0),
      assistant(T0 + 5, 'deepseek-flash', { inputTokens: 10, outputTokens: 90 }, [
        { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } },
      ]),
      { type: 'turn/end', time: T0 + 9, data: { turn: 1 } },
    ])
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.tokens.output).toBe(90)
  })

  test('an in-flight message that reports usage only in its stream is still billed', () => {
    const attempts = foldAttempts([
      { type: 'turn/start', time: T0, data: { turn: 1 } },
      stepStart(T0, 1, 0),
      streamingAssistant(T0 + 5, 'deepseek-flash', { inputTokens: 7, outputTokens: 11 }),
      { type: 'turn/end', time: T0 + 9, data: { turn: 1 } },
    ])
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.tokens.output).toBe(11)
  })

  test('a retry inside one step bills a second attempt instead of replacing the first', () => {
    const attempts = foldAttempts([
      { type: 'turn/start', time: T0, data: { turn: 1 } },
      stepStart(T0, 1, 0),
      assistant(T0 + 5, 'deepseek-flash', { inputTokens: 10, outputTokens: 20 }),
      { type: 'llm/retry-started', time: T0 + 6, data: {} },
      assistant(T0 + 7, 'deepseek-flash', { inputTokens: 12, outputTokens: 25 }),
      { type: 'turn/end', time: T0 + 9, data: { turn: 1 } },
    ])
    expect(attempts).toHaveLength(2)
    expect(attempts.map((entry) => entry.tokens.output)).toEqual([20, 25])
  })

  test('a turn with two steps keeps both steps apart under the same turn', () => {
    const attempts = foldAttempts([
      { type: 'turn/start', time: T0, data: { turn: 7 } },
      stepStart(T0, 7, 0),
      assistant(T0 + 1, 'deepseek-flash', { inputTokens: 1, outputTokens: 1 }),
      stepStart(T0 + 2, 7, 1),
      assistant(T0 + 3, 'deepseek-flash', { inputTokens: 2, outputTokens: 2 }),
      { type: 'turn/end', time: T0 + 4, data: { turn: 7 } },
    ])
    expect(attempts.map((entry) => entry.turn)).toEqual([7, 7])
    expect(attempts.map((entry) => entry.step)).toEqual([0, 1])
  })

  test('mixed model routes are preserved per attempt', () => {
    const attempts = foldAttempts([
      { type: 'turn/start', time: T0, data: { turn: 1 } },
      stepStart(T0, 1, 0),
      assistant(T0 + 1, 'deepseek-flash', { inputTokens: 1, outputTokens: 1 }),
      stepStart(T0 + 2, 1, 1),
      assistant(T0 + 3, 'deepseek-v4-pro', { inputTokens: 1, outputTokens: 1 }),
      { type: 'turn/end', time: T0 + 4, data: { turn: 1 } },
    ])
    expect(attempts.map((entry) => entry.model)).toEqual(['deepseek-flash', 'deepseek-v4-pro'])
  })

  test('a usage sample outside any step is not billed', () => {
    const attempts = foldAttempts([
      { type: 'turn/start', time: T0, data: { turn: 1 } },
      assistant(T0 + 1, 'deepseek-flash', { inputTokens: 5, outputTokens: 5 }),
      { type: 'turn/end', time: T0 + 2, data: { turn: 1 } },
    ])
    expect(attempts).toEqual([])
  })

  test('a sample without a route is skipped rather than attributed to a guess', () => {
    const attempts = foldAttempts([
      { type: 'turn/start', time: T0, data: { turn: 1 } },
      stepStart(T0, 1, 0),
      {
        type: 'assistant/message',
        time: T0 + 1,
        data: { stream: [{ type: 'usage', usage: { inputTokens: 5, outputTokens: 5 } }] },
      },
      { type: 'turn/end', time: T0 + 2, data: { turn: 1 } },
    ])
    expect(attempts).toEqual([])
  })

  test('an interrupted log yields the attempts it did record', () => {
    // No turn/end: the session was killed mid-step, which must not lose the cost.
    const attempts = foldAttempts([
      { type: 'turn/start', time: T0, data: { turn: 1 } },
      stepStart(T0, 1, 0),
      assistant(T0 + 1, 'deepseek-flash', { inputTokens: 4, outputTokens: 6 }),
    ])
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.tokens.output).toBe(6)
  })

  test('folding is idempotent: the same log always yields the same attempts', () => {
    const events: SessionEventLike[] = [
      { type: 'turn/start', time: T0, data: { turn: 1 } },
      stepStart(T0, 1, 0),
      assistant(T0 + 1, 'deepseek-flash', { inputTokens: 4, outputTokens: 6, cacheReadTokens: 10 }),
      { type: 'turn/end', time: T0 + 2, data: { turn: 1 } },
      { type: 'turn/start', time: T0 + 3, data: { turn: 2 } },
      stepStart(T0 + 3, 2, 0),
      assistant(T0 + 4, 'deepseek-v4-pro', { inputTokens: 8, outputTokens: 12 }),
    ]
    expect(foldAttempts(events)).toEqual(foldAttempts(events))
  })

  test('unknown event families do not disturb the fold', () => {
    const attempts = foldAttempts([
      { type: 'request/context', time: T0, data: { provider: 'x', model: 'y' } },
      { type: 'turn/start', time: T0, data: { turn: 1 } },
      { type: 'tool/call', time: T0, data: { name: 'bash' } },
      stepStart(T0 + 1, 1, 0),
      { type: 'todo/update', time: T0 + 2, data: {} },
      assistant(T0 + 3, 'deepseek-flash', { inputTokens: 1, outputTokens: 1 }),
    ])
    expect(attempts).toHaveLength(1)
  })

  test('a second settled message in one step replaces the first, as the host folds it', () => {
    // The fold mirrors `dsh-token-meter`: inside one step a later usage sample replaces the
    // earlier one, and only `llm/retry-started` closes that slot. Keeping the last is agreement
    // with the host's accounting, not a silent merge of two bills.
    const attempts = foldAttempts([
      { type: 'turn/start', time: T0, data: { turn: 1 } },
      stepStart(T0 + 1, 1, 0),
      assistant(T0 + 2, 'deepseek-flash', { inputTokens: 4, outputTokens: 6 }),
      assistant(T0 + 3, 'deepseek-flash', { inputTokens: 4, outputTokens: 6 }),
    ])
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.at).toBe(T0 + 3)
  })

  test('a retry inside one step bills both requests', () => {
    // The mirror image of the case above, and the reason last-wins does not lose
    // money in practice: the retry event is what opens the second attempt.
    const attempts = foldAttempts([
      { type: 'turn/start', time: T0, data: { turn: 1 } },
      stepStart(T0 + 1, 1, 0),
      assistant(T0 + 2, 'deepseek-flash', { inputTokens: 4, outputTokens: 6 }),
      {
        type: 'llm/retry-started',
        time: T0 + 3,
        data: { retryId: 'r', turn: 1, step: 1, retry: 1 },
      },
      assistant(T0 + 4, 'deepseek-flash', { inputTokens: 8, outputTokens: 12 }),
    ])
    expect(attempts).toHaveLength(2)
    expect(attempts.map((attempt) => attempt.tokens.input)).toEqual([4, 8])
  })
})

describe('events without a clock reading', () => {
  test('a live event dated by the observer lands in the day it was seen', () => {
    // The live session registry hands back events with no `time`; dated to the epoch, every live
    // turn fell outside every billing day while the session's own figure stayed right.
    const withoutTime: SessionEventLike = {
      type: 'assistant/message',
      data: {
        turn: 1,
        step: 1,
        usage: { inputTokens: 1_000, outputTokens: 10 },
        message: {
          role: 'assistant',
          content: [],
          id: 'msg-live',
          source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
        },
      },
    }
    const attempts = foldAttempts(
      [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'step/start', data: { turn: 1, step: 1 } },
        withoutTime,
      ],
      T0,
    )
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.at).toBe(T0)
  })

  test('a zero time counts as no time, not as 1970', () => {
    // The registry this plugin reads spells an absent clock as `time: 0`. Treating
    // that as a real instant put every live attempt outside the billing day.
    const attempts = foldAttempts(
      [
        { type: 'turn/start', time: 0, data: { turn: 1 } },
        { type: 'step/start', time: 0, data: { turn: 1, step: 1 } },
        assistant(0, 'deepseek-flash', { inputTokens: 1_000, outputTokens: 10 }),
      ],
      T0,
    )
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.at).toBe(T0)
  })

  test('an event that carries its own time keeps it', () => {
    const attempts = foldAttempts(
      [
        { type: 'turn/start', data: { turn: 1 } },
        { type: 'step/start', data: { turn: 1, step: 1 } },
        assistant(T0 + 5, 'deepseek-flash', { inputTokens: 1_000, outputTokens: 10 }),
      ],
      T0 + 9_000,
    )
    expect(attempts[0]?.at).toBe(T0 + 5)
  })
})
