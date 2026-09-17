/**
 * Public surface of the shared cost library.
 *
 * Everything here is pure: no clock reads, no I/O, no timezone database. The host plugin and the
 * browser half import this same code, so a figure shown on screen and the same figure returned by
 * the API cannot drift apart.
 */

export { emptyFoldState, foldAttempts, foldEvent } from './fold.ts'
export {
  DEEPSEEK_PEAK_SCHEDULE,
  CNY_RATE_TABLE,
  PRICING_CAPTURED_AT,
  RATE_TABLES,
  USD_RATE_TABLE,
} from './pricing.ts'
export {
  addBuckets,
  billedInputTokens,
  currentRate,
  priceAttempt,
  resolveModelKey,
  selectGeneration,
  zeroBuckets,
} from './rates.ts'
export {
  cacheHitRatio,
  emptySummary,
  mergeSummaries,
  summarize,
  summarizeComposition,
  type CostSummary,
  type PricedInput,
} from './summary.ts'
export type {
  BillingInstant,
  CostComposition,
  CostFoldState,
  CurrencyCode,
  ModelCost,
  ModelRate,
  PeakSchedule,
  PricedAttempt,
  RateBuckets,
  RateGeneration,
  RateIdentity,
  RatePeriod,
  RatePrices,
  RateTable,
  SessionEventLike,
  TurnCost,
  UnpricedReason,
  UsageAttempt,
} from './types.ts'
