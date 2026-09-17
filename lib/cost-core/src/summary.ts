/**
 * Aggregation: price a batch of attempts and split the result by turn, model and billing period,
 * which are the three questions a cost display is asked.
 *
 * Attempts that cannot be priced are kept in `unpriced` and counted, never dropped: a total that
 * silently omits them is worse than a total that admits it is incomplete.
 */

import { addBuckets, billedInputTokens, priceAttempt, zeroBuckets } from './rates.ts'
import type {
  BillingInstant,
  CostComposition,
  CurrencyCode,
  ModelCost,
  PricedAttempt,
  RateBuckets,
  RatePeriod,
  RateTable,
  TurnCost,
  UnpricedReason,
  UsageAttempt,
} from './types.ts'

/** Priced totals for one session (or any attempt slice). */
export interface CostSummary {
  /**
   * Currency of {@link total}.
   *
   * Optional because summaries also arrive from the wire, where an older host omitted it. A merge
   * refuses to add totals whose currencies differ rather than producing a number in no currency at
   * all.
   */
  currency?: CurrencyCode
  /** Total cost; null when no attempt could be priced at all. */
  total: number | null
  /** Token totals across every attempt, priced or not. */
  tokens: RateBuckets
  /** Priced cost per turn, ascending. */
  byTurn: TurnCost[]
  /** Priced cost per model, descending by cost. */
  byModel: ModelCost[]
  /** Cost split by billing period. */
  byPeriod: Record<RatePeriod, number>
  /** Attempts without a price, with the reason. */
  unpriced: { attempt: UsageAttempt; reason: UnpricedReason }[]
  /** Number of attempts that produced a price. */
  pricedAttempts: number
  /** Prompt-side tokens billed at some rate, for the cache-hit denominator. */
  billedInputTokens: number
}

export interface PricedInput {
  attempt: UsageAttempt
  instant: BillingInstant
}

/** Build a summary from attempts paired with their billing instants. */
export function summarize(
  table: RateTable,
  inputs: readonly PricedInput[],
  currency: CurrencyCode = table.currency,
): CostSummary {
  const byTurn = new Map<number, TurnCost>()
  const byModel = new Map<string, ModelCost>()
  const byPeriod: Record<RatePeriod, number> = { peak: 0, offpeak: 0 }
  const unpriced: { attempt: UsageAttempt; reason: UnpricedReason }[] = []
  let tokens = zeroBuckets()
  let total = 0
  let priced = 0
  let hasPrice = false

  for (const { attempt, instant } of inputs) {
    tokens = addBuckets(tokens, attempt.tokens)
    const result: PricedAttempt = priceAttempt(table, attempt, instant)
    const turn = byTurn.get(attempt.turn) ?? { turn: attempt.turn, cost: 0, incomplete: false }

    if (result.cost === null || result.identity === null) {
      unpriced.push({ attempt, reason: result.unpriced ?? 'unknown-model' })
      turn.incomplete = true
      byTurn.set(attempt.turn, turn)
      continue
    }

    const cost = result.cost
    total += cost
    priced += 1
    hasPrice = true
    byPeriod[result.identity.period] += cost
    turn.cost += cost
    byTurn.set(attempt.turn, turn)

    const key = `${attempt.provider}/${result.identity.model}`
    const model = byModel.get(key) ?? {
      model: result.identity.model,
      provider: attempt.provider,
      cost: 0,
      tokens: zeroBuckets(),
      periods: [],
    }
    byModel.set(key, {
      ...model,
      cost: model.cost + cost,
      tokens: addBuckets(model.tokens, attempt.tokens),
      periods: model.periods.includes(result.identity.period)
        ? model.periods
        : [...model.periods, result.identity.period],
    })
  }

  return {
    currency,
    total: hasPrice ? total : null,
    tokens,
    byTurn: [...byTurn.values()].toSorted((left, right) => left.turn - right.turn),
    byModel: [...byModel.values()].toSorted((left, right) => right.cost - left.cost),
    byPeriod,
    unpriced,
    pricedAttempts: priced,
    billedInputTokens: billedInputTokens(tokens),
  }
}

/** An empty summary, for a session with no billing evidence yet. */
export function emptySummary(currency: CurrencyCode, table?: RateTable): CostSummary {
  return summarize(table ?? { currency, aliases: {}, models: {} }, [], currency)
}

/**
 * Price one attempt slice into its per-bucket cost split. Each attempt is priced with its own
 * route, generation and period; attempts with no price contribute nothing and are counted instead,
 * so a caller can say the split is short rather than present a smaller number as complete.
 */
export function summarizeComposition(
  table: RateTable,
  inputs: readonly PricedInput[],
): CostComposition {
  const composition: CostComposition = {
    cachedInput: 0,
    uncachedInput: 0,
    cacheWrite: 0,
    output: 0,
    total: 0,
    unpricedAttempts: 0,
  }
  for (const { attempt, instant } of inputs) {
    const result = priceAttempt(table, attempt, instant)
    if (result.cost === null || result.identity === null) {
      composition.unpricedAttempts += 1
      continue
    }
    const { prices } = result.identity
    const million = 1_000_000
    const writePrice = prices.cacheWrite ?? prices.input
    composition.cachedInput += (attempt.tokens.cacheRead * prices.cacheRead) / million
    composition.uncachedInput += (attempt.tokens.input * prices.input) / million
    composition.cacheWrite += ((attempt.tokens.cacheWrite ?? 0) * writePrice) / million
    composition.output += (attempt.tokens.output * prices.output) / million
  }
  composition.total =
    composition.cachedInput +
    composition.uncachedInput +
    composition.cacheWrite +
    composition.output
  return composition
}

/**
 * Merge several summaries into one account-level total (e.g. one local day). The summaries must
 * share `currency`: CNY and USD are separate published price lists, and adding them would produce a
 * number in no currency at all. A mismatch is a wiring defect, so this fails loud.
 *
 * @throws {Error} When a summary reports a different currency.
 */
export function mergeSummaries(
  summaries: readonly CostSummary[],
  currency: CurrencyCode,
): CostSummary {
  const byTurn = new Map<number, TurnCost>()
  const byModel = new Map<string, ModelCost>()
  const byPeriod: Record<RatePeriod, number> = { peak: 0, offpeak: 0 }
  const unpriced: { attempt: UsageAttempt; reason: UnpricedReason }[] = []
  let tokens = zeroBuckets()
  let total = 0
  let priced = 0
  let hasPrice = false

  for (const summary of summaries) {
    if (summary.currency !== undefined && summary.currency !== currency) {
      throw new Error(
        `cost-core: cannot merge a ${summary.currency} summary into a ${currency} total`,
      )
    }
    if (summary.total !== null) {
      total += summary.total
      hasPrice = true
    }
    priced += summary.pricedAttempts
    tokens = addBuckets(tokens, summary.tokens)
    byPeriod.peak += summary.byPeriod.peak
    byPeriod.offpeak += summary.byPeriod.offpeak
    unpriced.push(...summary.unpriced)
    for (const turn of summary.byTurn) {
      const existing = byTurn.get(turn.turn)
      byTurn.set(turn.turn, {
        turn: turn.turn,
        cost: (existing?.cost ?? 0) + turn.cost,
        incomplete: (existing?.incomplete ?? false) || turn.incomplete,
      })
    }
    for (const model of summary.byModel) {
      const key = `${model.provider}/${model.model}`
      const existing = byModel.get(key)
      byModel.set(key, {
        model: model.model,
        provider: model.provider,
        cost: (existing?.cost ?? 0) + model.cost,
        tokens: addBuckets(existing?.tokens ?? zeroBuckets(), model.tokens),
        periods: [...new Set([...(existing?.periods ?? []), ...model.periods])],
      })
    }
  }

  return {
    currency,
    total: hasPrice ? total : null,
    tokens,
    byTurn: [...byTurn.values()].toSorted((left, right) => left.turn - right.turn),
    byModel: [...byModel.values()].toSorted((left, right) => right.cost - left.cost),
    byPeriod,
    unpriced,
    pricedAttempts: priced,
    billedInputTokens: billedInputTokens(tokens),
  }
}

/** Fraction of a summary's prompt tokens served from cache, or null. */
export function cacheHitRatio(summary: CostSummary): number | null {
  return summary.billedInputTokens === 0
    ? null
    : summary.tokens.cacheRead / summary.billedInputTokens
}
