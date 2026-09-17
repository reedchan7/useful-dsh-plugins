/**
 * Client half entry: register the cost pill on the composer's stats row.
 *
 * The entry lives on `conversation.composer.dock`, the ambient row under the composer where DSH
 * renders its own stats pills. That slot renders one row per registered id and the shipped stats
 * row declares no child slot, so the component itself renders the pill into the shipped row (see
 * `CostPill.ts`) to share its line, and falls back to the entry's own row when that row is absent.
 */

import { COST_DICTIONARIES } from '@useful-dsh/i18n'

import { CostPill } from './CostPill.ts'

/** Locale namespace the pill's dictionaries register under. */
export const NS = 'dsh-cost'

export const inject = ['slots', 'locale'] as const

/** Minimal structural view of the client context this half consumes. */
interface ClientContext {
  effect(callback: () => void | (() => void), label?: string): void
  slots: {
    inject(slot: string, callback: () => unknown): void
    register(options: Record<string, unknown>, component: unknown): unknown
  }
  locale: {
    register(namespace: string, dictionaries: Record<string, Record<string, string>>): () => void
  }
}

/** Register the stats-row entry. */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.locale.register(NS, { zh: COST_DICTIONARIES.zh, en: COST_DICTIONARIES.en }),
    'dsh-cost: dictionaries',
  )
  ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register(
      { name: 'conversation.composer.dock', id: 'cost', order: 100, locale: NS },
      CostPill,
    ),
  )
}
