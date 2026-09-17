/**
 * Session-log folding: turn a durable event log into per-attempt token usage, the only layer that
 * carries both a timestamp and a model route and can therefore be priced by period and generation.
 *
 * Mirrors the semantics of DSH's own `dsh-token-meter` turn fold: a usage sample belongs to the
 * open step, the last sample inside one attempt replaces earlier streaming samples, and a retry
 * starts a new billed attempt. Malformed or truncated logs never throw — they yield whatever was
 * understood, and the caller decides how to present the gap.
 */

import type { CostFoldState, RateBuckets, SessionEventLike, UsageAttempt } from './types.ts'

export function emptyFoldState(): CostFoldState {
  return { attempts: [], turn: 0, step: null, sample: null, endAt: null }
}

/**
 * One event payload, flattened to its own enumerable string-keyed fields. Class instances are
 * rejected: their getters could change between reads.
 */
interface EventRecord {
  entries: ReadonlyMap<string, unknown>
}

function asRecord(value: unknown): EventRecord | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null
  const prototype: unknown = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return null
  return { entries: new Map(Object.entries(value)) }
}

function field(record: EventRecord | null, name: string): unknown {
  return record?.entries.get(name)
}

function asFiniteCount(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

function bucketsFrom(usage: EventRecord): RateBuckets | null {
  const input = asFiniteCount(field(usage, 'inputTokens') ?? field(usage, 'promptTokens'))
  const output = asFiniteCount(field(usage, 'outputTokens') ?? field(usage, 'completionTokens'))
  if (input === undefined || output === undefined) return null
  const buckets: RateBuckets = { input, cacheRead: 0, output }
  const cacheRead = asFiniteCount(field(usage, 'cacheReadTokens'))
  const cacheWrite = asFiniteCount(field(usage, 'cacheWriteTokens'))
  if (cacheRead !== undefined) buckets.cacheRead = cacheRead
  if (cacheWrite !== undefined) buckets.cacheWrite = cacheWrite
  return buckets
}

/**
 * Billed usage of one assistant message: `data.usage` in the durable log, or the last `usage` chunk
 * of `data.stream` in an in-flight message. The per-message figure wins — it is the settled one the
 * provider reported for that request.
 */
function usageFromAssistantMessage(data: unknown): EventRecord | null {
  const record = asRecord(data)
  const direct = asRecord(field(record, 'usage'))
  if (direct !== null) return direct

  const stream = field(record, 'stream')
  if (!Array.isArray(stream)) return null
  let usage: EventRecord | null = null
  for (const chunk of stream) {
    const chunkRecord = asRecord(chunk)
    if (chunkRecord === null || field(chunkRecord, 'type') !== 'usage') continue
    const candidate = asRecord(field(chunkRecord, 'usage'))
    if (candidate !== null) usage = candidate
  }
  return usage
}

/**
 * Provider and model of one assistant message: nested at `data.message.source` in the durable log,
 * or directly on a live event.
 */
function routeFromAssistantMessage(data: unknown): { provider: string; model: string } | null {
  const record = asRecord(data)
  const source =
    asRecord(field(asRecord(field(record, 'message')), 'source')) ??
    asRecord(field(record, 'source'))
  if (source === null) return null
  const provider = field(source, 'provider')
  const model = field(source, 'model')
  if (typeof provider !== 'string' || typeof model !== 'string') return null
  if (provider === '' || model === '') return null
  return { provider, model }
}

/**
 * Epoch ms carried by one event, falling back when it carries none. A non-positive stamp counts as
 * absent: the live session registry reports `time: 0` rather than a missing field, and zero once
 * dated an attempt to the epoch — outside every billing day, which is how a whole session's live
 * turns disappeared from the day total.
 */
function eventTime(event: SessionEventLike, fallback: number): number {
  for (const key of ['time', 'at'] as const) {
    const value = event[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  }
  return fallback
}

/**
 * Close the currently open attempt, when it holds a recognizable sample. Flushing on boundary
 * events (rather than only at the end of the log) is what makes a retry bill a second request: the
 * retry closes the attempt already holding a sample, so the next one starts a new entry instead of
 * overwriting it.
 */
function closeAttempt(state: CostFoldState): void {
  const step = state.step
  const sample = state.sample
  if (step !== null && sample !== null) {
    state.attempts.push({
      turn: step.turn,
      step: step.step,
      at: sample.at,
      provider: sample.provider,
      model: sample.model,
      tokens: {
        input: sample.input,
        cacheRead: sample.cacheRead,
        output: sample.output,
        ...(sample.cacheWrite === undefined ? {} : { cacheWrite: sample.cacheWrite }),
      },
    })
  }
  state.sample = null
}

/**
 * Fold one event into the cursor. Unknown event types are ignored on purpose: the session log
 * carries many event families and the cost fold only cares about turn, step and billing.
 *
 * `fallbackAt` covers the live registry, whose events do not always carry the `time` the durable
 * log stores. Without it a sample would be dated to the epoch and fall outside every billing day —
 * which is how a whole session's live turns once went missing from the day total.
 */
export function foldEvent(
  state: CostFoldState,
  event: SessionEventLike,
  fallbackAt = 0,
): CostFoldState {
  const data = asRecord(event.data)
  const at = eventTime(event, Math.max(state.endAt ?? 0, fallbackAt))
  state.endAt = at

  switch (event.type) {
    case 'turn/start': {
      closeAttempt(state)
      state.step = null
      const turn = asFiniteCount(field(data, 'turn'))
      state.turn = turn === undefined ? state.turn + 1 : turn
      return state
    }
    case 'turn/end': {
      closeAttempt(state)
      state.step = null
      return state
    }
    case 'step/start': {
      closeAttempt(state)
      const turn = asFiniteCount(field(data, 'turn')) ?? state.turn
      const step = asFiniteCount(field(data, 'step')) ?? 0
      state.step = { turn, step }
      return state
    }
    case 'assistant/message': {
      const usage = usageFromAssistantMessage(event.data)
      const route = routeFromAssistantMessage(event.data)
      // A sample outside any step belongs to no billed attempt; attributing it
      // to the previous step would double-count that step's request.
      if (usage !== null && route !== null && state.step !== null) {
        const buckets = bucketsFrom(usage)
        if (buckets !== null) {
          state.sample = { ...buckets, provider: route.provider, model: route.model, at }
        }
      }
      return state
    }
    case 'llm/retry-started': {
      // A retry bills a second request inside the same step: close the attempt
      // so the next usage sample opens a new one instead of replacing it.
      closeAttempt(state)
      return state
    }
    default:
      return state
  }
}

/** Fold a whole event list in one pass; `fallbackAt` dates events that carry no time. */
export function foldAttempts(events: readonly SessionEventLike[], fallbackAt = 0): UsageAttempt[] {
  const state = emptyFoldState()
  for (const event of events) foldEvent(state, event, fallbackAt)
  closeAttempt(state)
  return state.attempts
}
