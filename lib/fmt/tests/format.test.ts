/**
 * Formatting rules the reader is expected to trust.
 *
 * The cases below are the ones a reviewer would notice: a rounded-up "100% cache hit" that claims a
 * discount that was not granted, an amount that loses its precision, or a huge token count that is
 * unreadable at a glance.
 */

import { describe, expect, test } from 'bun:test'

import {
  barPercent,
  currencySymbol,
  formatCacheHitPercent,
  formatCountdown,
  formatDuration,
  formatMoney,
  formatMoneyDelta,
  formatTokens,
  formatTokensExact,
  percentOf,
  roundToCents,
} from '../src/index.ts'

describe('money', () => {
  test('money is shown to cents, in both currencies', () => {
    // Two decimals is what a statement or a receipt uses; anything finer claims
    // an accuracy a token-derived estimate does not have.
    expect(formatMoney(2.4312, 'CNY')).toBe('¥2.43')
    expect(formatMoney(0.0117, 'USD')).toBe('$0.01')
    expect(formatMoney(2.675, 'USD')).toBe('$2.68')
  })

  test('a real but sub-cent amount says so instead of rounding to nothing', () => {
    expect(formatMoney(0.0041, 'CNY')).toBe('<¥0.01')
    expect(formatMoney(0.0000001, 'CNY')).toBe('<¥0.01')
  })

  test('zero is printed as zero, not as a sub-cent amount', () => {
    expect(formatMoney(0, 'CNY')).toBe('¥0')
  })

  test('a missing price prints an em dash instead of a fake zero', () => {
    expect(formatMoney(null, 'CNY')).toBe('—')
    expect(formatMoney(Number.NaN, 'CNY')).toBe('—')
  })

  test('grouping appears only when an amount is large enough to need it', () => {
    expect(formatMoney(12_345.6789, 'CNY')).toBe('¥12,345.68')
  })

  test('a large negative amount is grouped like its positive twin', () => {
    // Grouping keyed off the signed value left `-¥1234567.89` unseparated right
    // beside a grouped positive of the same magnitude.
    expect(formatMoney(-1_234_567.891, 'CNY')).toBe('¥-1,234,567.89')
    expect(formatMoney(-12_345.6789, 'CNY')).toBe('¥-12,345.68')
  })

  test('rounding is half-up, and applied to the decimal value', () => {
    expect(roundToCents(1.25)).toBe(1.25)
    expect(roundToCents(1.125)).toBe(1.13)
    expect(roundToCents(1.124)).toBe(1.12)
    // Half-up on the decimal representation: 1.005 shows a tie, and a tie goes up.
    expect(roundToCents(1.005)).toBe(1.01)
    expect(roundToCents(1.0049)).toBe(1)
  })

  test('deltas always carry a sign', () => {
    expect(formatMoneyDelta(0.0312, 'CNY')).toBe('+¥0.03')
    expect(formatMoneyDelta(-1.2, 'CNY')).toBe('-¥1.20')
  })

  test('a delta with no value prints a dash, never a sign on nothing', () => {
    expect(formatMoneyDelta(Number.NaN, 'CNY')).toBe('—')
    expect(formatMoneyDelta(Number.POSITIVE_INFINITY, 'CNY')).toBe('—')
  })

  test('symbols match the currency', () => {
    expect(currencySymbol('CNY')).toBe('¥')
    expect(currencySymbol('USD')).toBe('$')
  })
})

describe('tokens', () => {
  test('large counts are abbreviated', () => {
    expect(formatTokens(121_721_703)).toBe('121.7M')
    expect(formatTokens(999)).toBe('999')
    expect(formatTokens(1_500)).toBe('1.5K')
    expect(formatTokens(2_400_000_000)).toBe('2.4B')
  })

  test('exact counts stay exact for detail rows', () => {
    expect(formatTokensExact(121_721_703)).toBe('121,721,703')
  })

  test('a non-finite count is not printed as a number', () => {
    expect(formatTokens(Number.POSITIVE_INFINITY)).toBe('—')
    expect(formatTokensExact(Number.NaN)).toBe('—')
  })
})

describe('cache hit percentage', () => {
  test('a real full hit reports 100', () => {
    expect(formatCacheHitPercent(1_000, 1_000)).toBe('100%')
  })

  test('a partial hit never rounds up to a full one', () => {
    const text = formatCacheHitPercent(99_996, 100_000)
    expect(text).not.toBe('100.0%')
    expect(Number.parseFloat(text ?? '0')).toBeLessThan(100)
  })

  test('a near-total hit stays below 100 however large the prompt is', () => {
    // The real case: a 10^9-token prompt missing four tokens is 99.9999996%, and a
    // six-digit cap printed that as "100.000000%" — a claimed full cache hit.
    const text = formatCacheHitPercent(1_000_000_000 - 4, 1_000_000_000)
    expect(text).toBe('99.9999996%')
    expect(Number.parseFloat(text ?? '0')).toBeLessThan(100)
  })

  test('a partial hit keeps the requested precision when it is honest', () => {
    expect(formatCacheHitPercent(998, 1_000)).toBe('99.8%')
  })

  test('no prompt-side tokens means no percentage at all', () => {
    expect(formatCacheHitPercent(0, 0)).toBeNull()
  })
})

describe('durations and shares', () => {
  test('durations stay compact', () => {
    expect(formatDuration(48 * 60_000)).toBe('48m')
    expect(formatDuration(125 * 60_000)).toBe('2h 05m')
  })

  test('countdowns are fixed width enough to read while they tick', () => {
    expect(formatCountdown(2 * 3600_000 + 5 * 60_000 + 9_000)).toBe('2h 05m 09s')
    expect(formatCountdown(-5)).toBe('0h 00m 00s')
  })

  test('bar widths are clamped, so a stale max cannot overflow the layout', () => {
    expect(barPercent(5, 10)).toBe(50)
    expect(barPercent(50, 10)).toBe(100)
    expect(barPercent(1, 0)).toBe(0)
    expect(percentOf(1, 4)).toBe(25)
  })
})
