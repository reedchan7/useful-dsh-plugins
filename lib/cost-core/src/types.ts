/**
 * Shared cost vocabulary: the types every plugin and shared library speaks when it talks about
 * money, token buckets and pricing generations.
 */

/** The two currencies DeepSeek publishes prices in. Never mixed by conversion. */
export type CurrencyCode = 'CNY' | 'USD'

/** Billing period of the published DeepSeek schedule (Beijing time windows). */
export type RatePeriod = 'peak' | 'offpeak'

/** The four disjoint token buckets one provider request can be billed on. */
export interface RateBuckets {
  /** Prompt tokens not served from the context cache. */
  input: number
  /** Prompt tokens served from the context cache (published discount rate). */
  cacheRead: number
  /** Tokens written into the context cache; absent when the provider has no such line. */
  cacheWrite?: number
  /** Completion tokens, reasoning tokens included. */
  output: number
}

/** Prices for one token bucket, in `currency` units per million tokens. */
export interface RatePrices {
  input: number
  cacheRead: number
  /** Absent when the provider bills cache writes like uncached input. */
  cacheWrite?: number
  output: number
}

/** How one model was priced: which table key, which generation, which rate. */
export interface RateIdentity {
  /** The model id the table matched (after alias and date-suffix resolution). */
  model: string
  /** Provider and model exactly as the session log reported them. */
  provider: string
  modelReported: string
  /** Index of the generation entry inside the model's `updates` array. */
  generation: number
  /** Epoch ms this generation starts at; 0 for the base rate. */
  generationFrom: number
  period: RatePeriod
  /** The four prices in force for this attempt, per million tokens. */
  prices: RatePrices
}

/** One model's price history: a base rate plus dated generation updates. */
export interface ModelRate {
  /** Rate in force before the first update. */
  base: { peak: RatePrices; offpeak: RatePrices }
  /** Generations effective from `from`; the last one at or before a timestamp wins. */
  updates?: readonly RateGeneration[]
}

/** One pricing generation: rates that apply from `from` until the next update. */
export interface RateGeneration {
  /** Epoch milliseconds at which this generation begins (inclusive). */
  from: number
  peak: RatePrices
  offpeak: RatePrices
}

/** One currency's price book. */
export interface RateTable {
  currency: CurrencyCode
  /** Alternative model ids that resolve to a table key. */
  aliases: Readonly<Record<string, string>>
  models: Readonly<Record<string, ModelRate>>
}

/**
 * When the published peak windows run, and in whose clock. Pricing normally consumes the period
 * `computeInstant` reports directly; `windows` local to `timezone` is mostly a display
 * convenience.
 */
export interface PeakSchedule {
  /** Minutes from midnight, `[start, end)` pairs, interpreted in the schedule timezone. */
  windows: readonly (readonly [number, number])[]
  /** IANA zone the windows are written in. */
  timezone: string
  /**
   * Whether the windows apply on weekdays only.
   *
   * Published schedules are stated as "Monday through Friday", so the weekend behaviour is an
   * outcome of the restriction rather than a second rule that could contradict it.
   */
  weekdaysOnly?: boolean
}

/** One billed request attempt, as folded from a session log. */
export interface UsageAttempt {
  /** Turn number the attempt belongs to. */
  turn: number
  step: number
  /** Epoch ms of the event that carried the usage sample. */
  at: number
  provider: string
  model: string
  tokens: RateBuckets
}

/**
 * Clock facts a price depends on, computed by `@useful-dsh/tz`.
 *
 * `@useful-dsh/cost-core` stays timezone-free: it consumes this snapshot instead of reading a zone
 * database, so pricing is deterministic in tests.
 */
export interface BillingInstant {
  /** The instant being priced. */
  at: number
  /** Billed period at that instant. */
  period: RatePeriod
  /** Wall-clock fields in the schedule's own zone (the billed zone). */
  billedZoned: {
    year: number
    month: number
    day: number
    hour: number
    minute: number
    weekday: number
  }
  /** Wall-clock fields in the reader's zone. */
  localZoned: {
    year: number
    month: number
    day: number
    hour: number
    minute: number
    weekday: number
  }
  /** Reader-local calendar day, `YYYY-MM-DD`. */
  localDayKey: string
  /** Calendar day in the billed zone, `YYYY-MM-DD`. */
  billedDayKey: string
  /** Instant of the next billed-period change, or null when none is in range. */
  nextTransitionAt: number | null
  /** The period that starts at {@link nextTransitionAt}. */
  nextPeriod: RatePeriod | null
}

/** Why one attempt carries no price, so the UI can explain instead of showing a fake zero. */
export type UnpricedReason = 'unknown-model' | 'invalid-tokens'

/** One attempt's price, or the reason it has none. */
export interface PricedAttempt {
  attempt: UsageAttempt
  /** Null when `unpriced` is set. */
  cost: number | null
  identity: RateIdentity | null
  unpriced: UnpricedReason | null
}

/** Cost totals split by the dimension a reader asked about. */
export interface CostSubtrees {
  /** Total in `currency` units, `null` when nothing could be priced. */
  total: number | null
  currency: CurrencyCode
  /** Priced cost per turn, ascending by turn number. */
  byTurn: readonly TurnCost[]
  /** Priced cost per model, descending by cost. */
  byModel: readonly ModelCost[]
  /** Cost split by billing period. */
  byPeriod: Readonly<Record<RatePeriod, number>>
  /** Token totals across every attempt, priced or not. */
  tokens: RateBuckets
  /** Attempts that could not be priced, with the reason. */
  unpriced: readonly { attempt: UsageAttempt; reason: UnpricedReason }[]
}

/** One turn's priced cost. */
export interface TurnCost {
  turn: number
  cost: number
  /** True when at least one attempt in this turn had no price. */
  incomplete: boolean
}

/** One model's priced cost and token buckets. */
export interface ModelCost {
  model: string
  provider: string
  cost: number
  tokens: RateBuckets
  /** Periods this model was billed in; more than one after a peak transition. */
  periods: readonly RatePeriod[]
}

/**
 * Priced cost of an attempt slice, split by the bucket that produced it.
 *
 * The split is computed from the attempts' own rates and periods rather than from one
 * representative model's current price: a session can span several models and both billing periods,
 * and a figure presented as "what you paid for" has to be the sum of what was actually charged.
 */
export interface CostComposition {
  /** Cache-read tokens, at the published cache rate. */
  cachedInput: number
  /** Uncached prompt tokens. */
  uncachedInput: number
  /** Cache-write tokens; zero when the provider has no such bucket. */
  cacheWrite: number
  /** Completion tokens. */
  output: number
  /** Sum of the four buckets; zero when nothing could be priced. */
  total: number
  /** Attempts in the slice that had no price and are therefore missing from the split. */
  unpricedAttempts: number
}

/** Replay cursor carried across incremental folds of one session log. */
export interface CostFoldState {
  /** Attempts closed so far, in log order. */
  attempts: UsageAttempt[]
  /** Newest turn number the log named. */
  turn: number
  /** Step currently accepting a usage sample, or null between steps. */
  step: { turn: number; step: number } | null
  /**
   * Usage sample of the current attempt. A later sample in the same attempt replaces it (streaming
   * chunks report partial counts); a retry or a new step flushes it into {@link attempts} and starts
   * fresh.
   */
  sample: (RateBuckets & { provider: string; model: string; at: number }) | null
  /** Newest event timestamp seen, used when an event carries none. */
  endAt: number | null
}

/** A serializable session event, narrowed to the fields the fold reads. */
export interface SessionEventLike {
  type: string
  seq?: number
  time?: number
  at?: number
  data?: unknown
}
