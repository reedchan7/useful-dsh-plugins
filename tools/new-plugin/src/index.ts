/**
 * Scaffold a new plugin from `templates/plugin`.
 *
 * A plugin has to satisfy several contracts at once (bundle manifest, patch row, dependency-free
 * package, client bundle entry), and getting one wrong shows up only after an install. Copying a
 * known-good skeleton is cheaper than re-deriving it, so this tool rewrites the placeholders and
 * nothing else.
 */

import { cp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dir, '../../..')
const PLACEHOLDER = 'dsh-example'
const DISPLAY_PLACEHOLDER = 'Example'

function parseArgs(argv: readonly string[]): Map<string, string> {
  const values = new Map<string, string>()
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]?.replace(/^--/, '')
    const value = argv[index + 1]
    if (key !== undefined && value !== undefined) values.set(key, value)
  }
  return values
}

/**
 * Whether a copy failed because the destination already holds a file.
 *
 * `node:fs` reports this as `ERR_FS_CP_EEXIST` and Bun as `EEXIST`; either way the caller's next
 * move is the same, so both are treated as one condition.
 */
function isExistError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const code: unknown = Reflect.get(error, 'code')
  return code === 'ERR_FS_CP_EEXIST' || code === 'EEXIST'
}

const args = parseArgs(process.argv.slice(2))
const requested = args.get('name') ?? ''
if (!/^dsh-[a-z0-9-]+$/.test(requested)) {
  console.error('usage: new-plugin --name dsh-example [--scope @scope]')
  console.error('the name must look like dsh-<lowercase-hyphenated>')
  process.exit(2)
}
/** Validated plugin directory name. */
const name = requested
const scope = args.get('scope') ?? '@reedchan7'

/** The scope-qualified package name the skeleton declares. */
const PACKAGE_PLACEHOLDER = '@reedchan7/dsh-example'

const target = join(ROOT, 'plugins', name)
const packageName = `${scope}/${name}`
/** PascalCase form of the plugin name, for identifiers inside the skeleton. */
const title = name
  .split('-')
  .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
  .join('')

await mkdir(dirname(target), { recursive: true })
// `errorOnExist` is only honored together with `force: false`, which is not the
// default: without this pair, a second `make new NAME=dsh-cost` silently overwrote
// the plugin's own files with the skeleton.
try {
  await cp(join(ROOT, 'templates/plugin'), target, {
    recursive: true,
    errorOnExist: true,
    force: false,
  })
} catch (error: unknown) {
  if (isExistError(error)) {
    console.error(`plugins/${name} already exists; pick another name or remove it first`)
    process.exit(1)
  }
  throw error
}

async function rewrite(relative: string): Promise<void> {
  const file = join(target, relative)
  const text = await readFile(file, 'utf8')
  await writeFile(
    file,
    text
      .replaceAll(PACKAGE_PLACEHOLDER, packageName)
      .replaceAll(PLACEHOLDER, name)
      .replaceAll(DISPLAY_PLACEHOLDER, title),
  )
}

await Promise.all(
  [
    'package.json',
    'cordis.patch.yml',
    'README.md',
    'README_CN.md',
    'src/index.ts',
    'src/client/index.ts',
    'tests/placeholder.test.ts',
  ].map((relative) => rewrite(relative)),
)

console.log(`created plugins/${name}`)
console.log('next steps:')
console.log(`  1. implement src/index.ts (host half) and src/client/index.ts (browser half)`)
console.log(`  2. add ${name} to PLUGINS in the Makefile`)
console.log('  3. bun run typecheck && bun run build:plugins && make install')
