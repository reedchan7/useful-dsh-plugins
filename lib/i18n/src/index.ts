/**
 * Dictionaries and the translate binder for the cost UI.
 *
 * Both the host and the browser half import this map: the browser half registers it with DSH's
 * locale service (which is what makes the UI follow the user's DSH language setting), and the host
 * reuses it for any text it renders itself.
 */

import { en, type CostLocaleKey } from './en.ts'
import { zh } from './zh.ts'

/** Locales this library ships dictionaries for. */
export type CostLocale = 'en' | 'zh'

export const COST_DICTIONARIES: Readonly<Record<CostLocale, Record<CostLocaleKey, string>>> = {
  en,
  zh,
}

/**
 * Whether a string is a key this library ships — a real runtime guard rather than a cast over
 * `Object.keys`, so a dictionary consumer that walks its own keys narrows honestly.
 */
export function isCostLocaleKey(value: string): value is CostLocaleKey {
  return Object.hasOwn(en, value) && Object.hasOwn(zh, value)
}

/** Values interpolated into a `{placeholder}` in a dictionary string. */
export type TranslateParams = Readonly<Record<string, string | number>>

export type CostTranslate = (key: CostLocaleKey, params?: TranslateParams) => string

/** Narrow a BCP-47 tag to a shipped dictionary; English is the fallback. */
export function resolveCostLocale(tag: string | undefined): CostLocale {
  if (tag === undefined) return 'en'
  return tag.toLowerCase().startsWith('zh') ? 'zh' : 'en'
}

function interpolate(template: string, params: TranslateParams | undefined): string {
  if (params === undefined) return template
  return template.replaceAll(/\{(\w+)\}/g, (match, name: string) => {
    const value = params[name]
    return value === undefined ? match : String(value)
  })
}

/** Build a translate function bound to one locale, with `{placeholder}` interpolation. */
export function bindTranslate(locale: string | undefined): CostTranslate {
  const dictionary = COST_DICTIONARIES[resolveCostLocale(locale)]
  return (key, params) => interpolate(dictionary[key], params)
}

/** Locale tags accepted by DSH's locale service, keyed by dictionary. */
export const DSH_LOCALE_TAGS: Readonly<Record<CostLocale, string>> = { en: 'en', zh: 'zh' }

export { en, zh }
export type { CostLocaleKey }
