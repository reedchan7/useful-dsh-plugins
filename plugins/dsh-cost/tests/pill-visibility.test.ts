/**
 * When the cost segment is allowed on screen at all.
 *
 * A fresh session has billed nothing, so the shipped stats row under the composer is absent and a
 * `¥ Cost —` reading would be the composer row's only cost figure, saying nothing. These cases pin
 * the predicate the component gates on, so "show it always and let the dash speak for itself"
 * cannot come back unnoticed.
 */

import { describe, expect, test } from 'bun:test'

import { hasBilledTokens } from '../src/client/CostPill.ts'

const NOTHING_BILLED = {
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
}

describe('cost segment visibility', () => {
  test('a session that has billed nothing has no segment', () => {
    expect(hasBilledTokens(NOTHING_BILLED)).toBe(false)
  })

  test('no projection value at all has no segment', () => {
    expect(hasBilledTokens(undefined)).toBe(false)
    expect(hasBilledTokens(null)).toBe(false)
    expect(hasBilledTokens({})).toBe(false)
  })

  test('one token in any billed bucket shows the segment', () => {
    expect(hasBilledTokens({ ...NOTHING_BILLED, uncachedInputTokens: 1 })).toBe(true)
    expect(hasBilledTokens({ ...NOTHING_BILLED, cacheReadTokens: 1 })).toBe(true)
    expect(hasBilledTokens({ ...NOTHING_BILLED, cacheWriteTokens: 1 })).toBe(true)
    expect(hasBilledTokens({ ...NOTHING_BILLED, outputTokens: 1 })).toBe(true)
  })

  test('a projection without the cache-write bucket is still read', () => {
    const older = { uncachedInputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
    expect(hasBilledTokens(older)).toBe(false)
    expect(hasBilledTokens({ ...older, outputTokens: 7 })).toBe(true)
  })
})
