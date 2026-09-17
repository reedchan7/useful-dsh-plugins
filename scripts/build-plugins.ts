/**
 * Build every plugin in the workspace.
 *
 * Each plugin emits two artifacts into its own `lib/`:
 *
 * - `lib/index.js` — the node half, ESM, with the shared workspace libraries inlined. Peer
 *   dependencies (the `@deepseek-ai/*` packages the DSH host provides) stay external, because the
 *   host resolves those from its own installation.
 * - `lib/client.js` — the browser half, CommonJS wrapped in the `window.__ModuleLoader__.load({ id,
 *   factory })` handoff DSH's client module table expects, with react, react-dom and every declared
 *   platform module left external so the browser shares one copy of each.
 *
 * Inlining the shared libraries is what keeps the published plugin free of runtime dependencies: a
 * DSH profile installs plugins with pnpm, and neither pnpm nor bun installs a linked package's
 * transitive dependencies, so a plugin that imported `@useful-dsh/cost-core` at runtime would fail
 * to resolve it.
 */

import { readdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '..')
const PLUGINS_DIR = join(ROOT, 'plugins')

/** Platform modules the browser already has, keyed by specifier. */
const CLIENT_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
] as const

interface PluginTarget {
  directory: string
  name: string
  clientExternals: readonly string[]
  hasClient: boolean
}

/** Narrow one decoded manifest to the plugin shape this build reads. */
function readManifest(value: unknown): {
  name: string
  client: { inject?: readonly string[]; external?: readonly string[] } | undefined
} | null {
  if (typeof value !== 'object' || value === null) return null
  const name: unknown = Reflect.get(value, 'name')
  if (typeof name !== 'string') return null
  const dsh: unknown = Reflect.get(value, 'dsh')
  const client: unknown =
    typeof dsh === 'object' && dsh !== null ? Reflect.get(dsh, 'client') : undefined
  if (typeof client !== 'object' || client === null) return { name, client: undefined }
  const inject: unknown = Reflect.get(client, 'inject')
  const external: unknown = Reflect.get(client, 'external')
  return {
    name,
    client: {
      inject: Array.isArray(inject)
        ? inject.filter((entry): entry is string => typeof entry === 'string')
        : [],
      external: Array.isArray(external)
        ? external.filter((entry): entry is string => typeof entry === 'string')
        : [],
    },
  }
}

function formatLog(log: unknown): string {
  if (typeof log === 'string') return log
  if (typeof log === 'object' && log !== null) {
    const message: unknown = Reflect.get(log, 'message')
    if (typeof message === 'string') return message
  }
  return String(log)
}

/** Read the plugin directories that declare a DSH bundle. */
async function discoverPlugins(): Promise<PluginTarget[]> {
  const entries = await readdir(PLUGINS_DIR, { withFileTypes: true })
  const targets: PluginTarget[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const directory = join(PLUGINS_DIR, entry.name)
    const manifestFile = Bun.file(join(directory, 'package.json'))
    // oxlint-disable-next-line no-await-in-loop -- startup probe, one file per plugin
    if (!(await manifestFile.exists())) continue
    // oxlint-disable-next-line no-await-in-loop -- startup probe, one file per plugin
    const manifest = readManifest(await manifestFile.json())
    if (manifest === null) continue
    const declared = manifest.client
    targets.push({
      directory,
      name: manifest.name,
      clientExternals: [
        ...CLIENT_EXTERNALS,
        ...(declared?.inject ?? []),
        ...(declared?.external ?? []),
      ],
      hasClient: declared !== undefined,
    })
  }
  return targets
}

/** Build one plugin, failing the run on the first error. */
async function buildPlugin(target: PluginTarget): Promise<void> {
  const label = `${target.name} (${target.directory.replace(`${ROOT}/`, '')})`

  const nodeResult = await Bun.build({
    entrypoints: [join(target.directory, 'src/index.ts')],
    outdir: join(target.directory, 'lib'),
    naming: 'index.js',
    target: 'node',
    format: 'esm',
    external: ['@deepseek-ai/*'],
    sourcemap: 'external',
  })
  if (!nodeResult.success) {
    throw new Error(`${label}: node half failed\n${nodeResult.logs.map(formatLog).join('\n')}`)
  }

  if (!target.hasClient) {
    console.log(`built ${target.name} (node half)`)
    return
  }

  const factoryOpen = `window.__ModuleLoader__.load({ id: ${JSON.stringify(target.name)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;`
  const factoryClose = 'return module.exports; } });'
  const clientResult = await Bun.build({
    entrypoints: [join(target.directory, 'src/client/index.ts')],
    outdir: join(target.directory, 'lib'),
    naming: 'client.js',
    target: 'browser',
    format: 'cjs',
    external: [...target.clientExternals],
    sourcemap: 'external',
    banner: factoryOpen,
    footer: factoryClose,
    define: {
      'process.env.NODE_ENV': JSON.stringify('production'),
      'import.meta.env.MODE': JSON.stringify('production'),
    },
  })
  if (!clientResult.success) {
    throw new Error(`${label}: client half failed\n${clientResult.logs.map(formatLog).join('\n')}`)
  }
  console.log(`built ${target.name} (node + client)`)
}

const plugins = await discoverPlugins()
if (plugins.length === 0) {
  console.error('build-plugins: no plugin package found under plugins/')
  process.exit(1)
}
// Sequential on purpose: a workspace build that interleaves plugin diagnostics
// makes a failure hard to attribute, and there is no wall-clock reason to.
for (const plugin of plugins) {
  // oxlint-disable-next-line no-await-in-loop -- sequential by design, see above
  await buildPlugin(plugin)
}
console.log(`built ${plugins.length} plugin(s)`)
