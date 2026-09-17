/**
 * The published DeepSeek price books, and the peak schedule they are billed on.
 *
 * Verified against
 * [https://api-docs.deepseek.com/quick_start/pricing](https://api-docs.deepseek.com/quick_start/pricing)
 * and its `/zh-cn/` counterpart on 2026-09-17. The two lists are NOT one conversion apart — the
 * renminbi rows are a separate regional price list (the current Flash row is $0.15/M uncached
 * against ¥1/M, a ratio near 6.7) — so each book is transcribed from its own page.
 *
 * What the pages say, and what this module therefore encodes:
 *
 * - `deepseek-flash` is DeepSeek-V4.1-Flash; `deepseek-v4-flash` and `deepseek-v4-flash-vision-exp`
 *   are retired names served by the same model and billed at the same price.
 * - `deepseek-v4-pro` (DeepSeek-V4-Pro-0813) **keeps its own rates**. The page's note (2) states the
 *   service continues past 2026-09-14 "with the billing method remaining unchanged", contradicting
 *   a community table that moved Pro onto Flash pricing.
 * - Off-peak rates are half of peak. Peak hours are 01:00–04:00 and 06:00–10:00 UTC, Monday through
 *   Friday; every other hour is off-peak, which includes weekends.
 *
 * The rows NOT on the pages are the ones in force before the 2026-08-17 peak/off-peak cutover; they
 * are kept so a session from that era prices at the rate it was billed at. Their renminbi figures
 * are the dollar rows scaled by the current published-list ratio, because the renminbi page for
 * those generations is no longer published.
 */

import type { CurrencyCode, PeakSchedule, RatePrices, RateTable } from './types.ts'

/** Prices for one model in one currency: the current row, the cutover row, and the flat one. */
interface ModelList {
  current: { offpeak: RatePrices; peak: RatePrices }
  cutover: { offpeak: RatePrices; peak: RatePrices }
  /** The flat pre-2026-08-17 rate; both periods carry it. */
  flat: RatePrices
}

/** One currency's published price list, per million tokens. */
interface PriceList {
  'deepseek-flash': ModelList
  'deepseek-v4-pro': ModelList
}

/** The dollar list exactly as published on the English pricing page. */
const USD_LIST: PriceList = {
  'deepseek-flash': {
    current: {
      offpeak: { input: 0.15, cacheRead: 0.003, output: 0.6 },
      peak: { input: 0.3, cacheRead: 0.006, output: 1.2 },
    },
    cutover: {
      offpeak: { input: 0.3, cacheRead: 0.03, output: 0.9 },
      peak: { input: 0.6, cacheRead: 0.06, output: 1.8 },
    },
    flat: { input: 0.1, cacheRead: 0.01, output: 0.2 },
  },
  'deepseek-v4-pro': {
    current: {
      offpeak: { input: 0.66, cacheRead: 0.022, output: 1.98 },
      peak: { input: 1.32, cacheRead: 0.044, output: 3.96 },
    },
    cutover: {
      offpeak: { input: 0.75, cacheRead: 0.025, output: 1.5 },
      peak: { input: 1.5, cacheRead: 0.05, output: 3 },
    },
    flat: { input: 0.4, cacheRead: 0.01, output: 0.8 },
  },
}

/** The renminbi list exactly as published on the Chinese pricing page. */
const CNY_LIST: PriceList = {
  'deepseek-flash': {
    current: {
      offpeak: { input: 1, cacheRead: 0.02, output: 4 },
      peak: { input: 2, cacheRead: 0.04, output: 8 },
    },
    cutover: {
      offpeak: { input: 1.5, cacheRead: 0.15, output: 4.5 },
      peak: { input: 3, cacheRead: 0.3, output: 9 },
    },
    flat: { input: 1, cacheRead: 0.1, output: 2 },
  },
  'deepseek-v4-pro': {
    current: {
      offpeak: { input: 4.5, cacheRead: 0.15, output: 13.5 },
      peak: { input: 9, cacheRead: 0.3, output: 27 },
    },
    cutover: {
      offpeak: { input: 4.5, cacheRead: 0.12, output: 9 },
      peak: { input: 9, cacheRead: 0.24, output: 18 },
    },
    flat: { input: 4, cacheRead: 0.1, output: 8 },
  },
}

/** Epoch ms of a Beijing-time wall clock, for readability in the dates below. */
function beijing(year: number, month: number, day: number): number {
  return Date.UTC(year, month - 1, day, 0, 0, 0) - 8 * 3600 * 1000
}

const V4_CUTOVER = beijing(2026, 8, 17)
const V41_FLASH_CUTOVER = beijing(2026, 9, 10)
/** The page's note (2) records V4-Pro's rates as unchanged from this date. */
const V4_PRO_CUTOVER = beijing(2026, 9, 14)

/**
 * One model's price history in one currency. The dates are the provider's own change points:
 * 2026-08-17 introduced the peak/off-peak split (the flat rate stays as the base row), and each
 * model's newest generation starts at `currentFrom`. The `expires-on-0910` ids carry their change
 * point in their name, so they bill at the earlier generation without a separate entry.
 */
function book(list: ModelList, currentFrom: number): RateTable['models'][string] {
  const flat = { offpeak: list.flat, peak: list.flat }
  return {
    base: flat,
    updates: [
      { from: V4_CUTOVER, ...list.cutover },
      { from: currentFrom, ...list.current },
    ],
  }
}

/**
 * Peak windows exactly as published: 01:00–04:00 and 06:00–10:00 UTC on weekdays (the Chinese page
 * states the same windows as Beijing time 09:00–12:00 and 14:00–18:00). There is deliberately no
 * separate "weekend is off-peak" flag — that outcome falls out of the weekday restriction, and a
 * second rule could contradict this one.
 */
export const DEEPSEEK_PEAK_SCHEDULE: PeakSchedule = {
  windows: [
    [60, 240],
    [360, 600],
  ],
  timezone: 'UTC',
  weekdaysOnly: true,
}

/** Model ids that resolve to a table key. */
const DEEPSEEK_ALIASES: Readonly<Record<string, string>> = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
  'deepseek-v4.1-flash': 'deepseek-flash',
  'deepseek-v41-flash': 'deepseek-flash',
  'deepseek-chat': 'deepseek-flash',
  'deepseek-reasoner': 'deepseek-flash',
  'deepseek-v4-pro-0813': 'deepseek-v4-pro',
}

/** The published renminbi book. */
export const CNY_RATE_TABLE: RateTable = {
  currency: 'CNY',
  aliases: DEEPSEEK_ALIASES,
  models: {
    'deepseek-flash': book(CNY_LIST['deepseek-flash'], V41_FLASH_CUTOVER),
    'deepseek-v4-pro': book(CNY_LIST['deepseek-v4-pro'], V4_PRO_CUTOVER),
  },
}

/** The published US dollar book. */
export const USD_RATE_TABLE: RateTable = {
  currency: 'USD',
  aliases: DEEPSEEK_ALIASES,
  models: {
    'deepseek-flash': book(USD_LIST['deepseek-flash'], V41_FLASH_CUTOVER),
    'deepseek-v4-pro': book(USD_LIST['deepseek-v4-pro'], V4_PRO_CUTOVER),
  },
}

/** Every book this build ships, keyed by currency. */
export const RATE_TABLES: Readonly<Record<CurrencyCode, RateTable>> = {
  CNY: CNY_RATE_TABLE,
  USD: USD_RATE_TABLE,
}

/** The generated date of the figures above; surfaced in the UI footer. */
export const PRICING_CAPTURED_AT = '2026-09-17'
