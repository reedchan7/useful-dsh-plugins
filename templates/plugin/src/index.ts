/**
 * Host half of dsh-example.
 *
 * Keep this half dependency-free: DSH installs plugins into a profile with pnpm,
 * which does not install a linked package's transitive dependencies, so anything
 * imported here must be inlined by the build (see scripts/build-plugins.ts).
 */

export const inject = ['webServer'] as const

export const name = 'dsh-example'

/** Minimal structural view of the services this half consumes. */
interface HostContext {
  webServer: {
    register(route: {
      kind: 'exact'
      path: string
      handler: (req: unknown, res: unknown) => void | Promise<void>
    }): () => void
  }
  effect(callback: () => () => void, label?: string): void
}

/** Plugin body. */
export function apply(ctx: HostContext): void {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: '/api/dsh-example/ping',
        handler: (_req, res) => {
          const response = res as { writeHead(status: number, headers: Record<string, string>): void; end(body: string): void }
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' })
          response.end('{"ok":true}')
        },
      }),
    'dsh-example: routes',
  )
}
