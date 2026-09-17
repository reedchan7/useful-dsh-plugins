/**
 * Browser half of dsh-example.
 *
 * This half is bundled into the `window.__ModuleLoader__.load(...)` artifact DSH
 * serves at /plugins/@reedchan7/dsh-example/client.js. Anything not in the
 * platform module table gets inlined, so keep imports to react and the modules
 * declared in `dsh.client.inject`.
 */

/** Locale namespace this half registers its dictionaries under. */
export const NS = 'dsh-example'

export const inject = ['slots'] as const

/** Minimal structural view of the client context. */
interface ClientContext {
  slots: {
    inject(slot: string, callback: () => unknown): void
    register(options: Record<string, unknown>, component: unknown): unknown
  }
}

/** Placeholder entry rendered under the composer. */
function ExampleEntry(): unknown {
  return null
}

/** Register the entry. */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('conversation.composer.dock', () =>
    ctx.slots.register(
      { name: 'conversation.composer.dock', id: 'dsh-example', order: 100, locale: NS },
      ExampleEntry,
    ),
  )
}
