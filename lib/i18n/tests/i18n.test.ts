/**
 * Dictionary contract.
 *
 * The Chinese dictionary is a translation of the English one, not an independent map: a missing key
 * would silently fall back to English inside a Chinese UI, which is exactly the kind of
 * half-translated surface this test exists to prevent.
 */

import { describe, expect, test } from 'bun:test'

import {
  COST_DICTIONARIES,
  bindTranslate,
  en,
  isCostLocaleKey,
  resolveCostLocale,
  zh,
} from '../src/index.ts'

/** Placeholder names used by one dictionary string. */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1] ?? '').toSorted()
}

describe('dictionary parity', () => {
  test('both dictionaries carry exactly the same keys', () => {
    expect(Object.keys(zh).toSorted()).toEqual(Object.keys(en).toSorted())
  })

  test('no string is left empty', () => {
    for (const [locale, dictionary] of Object.entries(COST_DICTIONARIES)) {
      for (const [key, value] of Object.entries(dictionary)) {
        expect({ locale, key, empty: value.trim() === '' }).toEqual({ locale, key, empty: false })
      }
    }
  })

  test('placeholders match between the two languages', () => {
    const keys = Object.keys(en).filter(isCostLocaleKey)
    expect(keys.length).toBe(Object.keys(en).length)
    for (const key of keys) {
      expect({ key, params: placeholders(zh[key]) }).toEqual({ key, params: placeholders(en[key]) })
    }
  })
})

describe('translate binder', () => {
  test('a Chinese tag selects the Chinese dictionary, including regional forms', () => {
    expect(resolveCostLocale('zh-Hans-CN')).toBe('zh')
    expect(resolveCostLocale('zh-TW')).toBe('zh')
  })

  test('anything else falls back to English', () => {
    expect(resolveCostLocale(undefined)).toBe('en')
    expect(resolveCostLocale('ja-JP')).toBe('en')
  })

  test('parameters are interpolated', () => {
    expect(bindTranslate('zh')('panel.oldFormatSkipped', { count: 3 })).toContain('3')
    expect(bindTranslate('en')('panel.oldFormatSkipped', { count: 3 })).toContain('3')
  })

  test('an unknown placeholder is left visible instead of printing undefined', () => {
    expect(bindTranslate('en')('panel.oldFormatSkipped')).toContain('{count}')
  })
})
