/**
 * Rate resolution and attempt pricing.
 *
 * Pricing is deliberately pure and clock-injected: generation selection needs the attempt
 * timestamp, and the peak/off-peak decision is handed in as a {@link BillingInstant} from
 * `@useful-dsh/tz` so this module never touches a timezone database itself. A model the table
 * cannot place is reported as unpriced instead of being billed at zero — a silent zero is the
 * failure mode that makes a cost display lie.
 */

import type {
  BillingInstant,
  PricedAttempt,
  RateBuckets,
  RateIdentity,
  RatePrices,
  RateTable,
  UsageAttempt,
} from './types.ts'

/** Resolve a reported model id to a table key, or null when nothing matches. */
export function resolveModelKey(table: RateTable, reported: string): string | null {
  const lookup = (candidate: string): string | null => {
    if (table.models[candidate] !== undefined) return candidate
    const alias = table.aliases[candidate]
    return alias !== undefined && table.models[alias] !== undefined ? alias : null
  }

  const exact = lookup(reported)
  if (exact !== null) return exact

  // A routed id the provider later suffixed (`deepseek-v4.1-flash-expires-on-0910`)
  // still belongs to the model named by its prefix, and a dated build stamp
  // (`deepseek-v4-flash-2026-01-31`) resolves the same way. Candidate prefixes are
  // the separator-delimited truncations of the reported id, and only prefixes that
  // consume a whole segment qualify — a name that merely starts with a model id
  // (`deepseek-flashback`) matches no boundary and stays unpriced.
  const segments = reported.split(/(?<=[-._])/)
  for (let count = segments.length - 1; count >= 1; count -= 1) {
    const prefix = segments
      .slice(0, count)
      .join('')
      .replace(/[-._]$/, '')
    const resolved = lookup(prefix)
    if (resolved !== null) return resolved
  }
  return null
}

/** Select the pricing generation in force at one instant; index 0 is the base rate. */
export function selectGeneration(
  table: RateTable,
  modelKey: string,
  at: number,
): { index: number; from: number; prices: { peak: RatePrices; offpeak: RatePrices } } | null {
  const model = table.models[modelKey]
  if (model === undefined) return null
  let chosen = { index: 0, from: 0, prices: model.base }
  const updates = model.updates ?? []
  for (const [index, update] of updates.entries()) {
    if (update.from <= at && update.from >= chosen.from) {
      chosen = {
        index: index + 1,
        from: update.from,
        prices: { peak: update.peak, offpeak: update.offpeak },
      }
    }
  }
  return chosen
}

/** Price one attempt, or report the reason it has no price. */
export function priceAttempt(
  table: RateTable,
  attempt: UsageAttempt,
  instant: BillingInstant,
): PricedAttempt {
  const key = resolveModelKey(table, attempt.model)
  if (key === null) return { attempt, cost: null, identity: null, unpriced: 'unknown-model' }

  const tokens = attempt.tokens
  const counts = [tokens.input, tokens.cacheRead, tokens.cacheWrite ?? 0, tokens.output]
  if (counts.some((count) => !Number.isFinite(count) || count < 0)) {
    return { attempt, cost: null, identity: null, unpriced: 'invalid-tokens' }
  }

  const generation = selectGeneration(table, key, attempt.at)
  if (generation === null) return { attempt, cost: null, identity: null, unpriced: 'unknown-model' }

  const period = instant.period
  const prices = generation.prices[period]
  // Providers without a cache-write line bill a write at the uncached input
  // rate; charging the cheaper cache-read rate instead would understate cost.
  const cacheWritePrice = prices.cacheWrite ?? prices.input
  const million = 1_000_000
  const cost =
    (tokens.input * prices.input +
      tokens.cacheRead * prices.cacheRead +
      (tokens.cacheWrite ?? 0) * cacheWritePrice +
      tokens.output * prices.output) /
    million

  const identity: RateIdentity = {
    model: key,
    provider: attempt.provider,
    modelReported: attempt.model,
    generation: generation.index,
    generationFrom: generation.from,
    period,
    prices,
  }
  return { attempt, cost, identity, unpriced: null }
}

/**
 * The price row in force for one model at one instant — the generation that applies _now_, not the
 * base row; picking it by hand is how a display ends up quoting a retired price.
 */
export function currentRate(
  table: RateTable,
  reported: string,
  at: number,
): { prices: { peak: RatePrices; offpeak: RatePrices }; model: string; generation: number } | null {
  const key = resolveModelKey(table, reported)
  if (key === null) return null
  const generation = selectGeneration(table, key, at)
  if (generation === null) return null
  return { prices: generation.prices, model: key, generation: generation.index }
}

export function addBuckets(into: RateBuckets, from: RateBuckets): RateBuckets {
  return {
    input: into.input + from.input,
    cacheRead: into.cacheRead + from.cacheRead,
    output: into.output + from.output,
    cacheWrite: (into.cacheWrite ?? 0) + (from.cacheWrite ?? 0),
  }
}

export function zeroBuckets(): RateBuckets {
  return { input: 0, cacheRead: 0, output: 0, cacheWrite: 0 }
}

/** Prompt-side tokens that were billed at some rate. */
export function billedInputTokens(tokens: RateBuckets): number {
  return tokens.input + tokens.cacheRead + (tokens.cacheWrite ?? 0)
}
