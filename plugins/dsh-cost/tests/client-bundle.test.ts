/**
 * The built client bundle's contract with DSH.
 *
 * The browser half is not imported like an ordinary module: DSH's client module table fetches
 * `lib/client.js` and expects it to call `window.__ModuleLoader__.load({ id, factory })`, where
 * `factory(require)` resolves react and the declared platform modules from the table and returns an
 * object carrying `apply` and `inject`. A build that forgets the banner, inlines react, or drops
 * the slot registration fails at runtime in the browser — where only a manual reload would reveal
 * it — so the contract is asserted here.
 *
 * The bundle is loaded through CommonJS rather than imported, because it is not a module: it
 * installs itself on `window` as it runs.
 */

import { describe, expect, test } from 'bun:test'
import { createRequire } from 'node:module'

const BUNDLE = new URL('../lib/client.js', import.meta.url).pathname
const MANIFEST = new URL('../package.json', import.meta.url)

/** One recorded slot registration. */
interface Registration {
  options: Map<string, unknown>
  component: unknown
}

/** What one execution of the bundle produced. */
interface RunRecord {
  /** Package name the bundle declared to the loader. */
  id: string
  /** Module specifiers the bundle pulled from the module table. */
  requested: string[]
  /** Exports the factory returned. */
  exported: Map<string, unknown>
  /** Entries registered on the slot registry during boot. */
  registrations: Registration[]
  /** Slots the bundle asked to inject into. */
  injected: string[]
  /** Locale namespaces registered during boot. */
  namespaces: string[]
}

const records: RunRecord[] = []

/** React stand-in: enough of the hook surface for the component to render. */
function reactStub(): Record<string, unknown> {
  return {
    createElement: (type: unknown, props: unknown, ...children: unknown[]) => ({
      type,
      props,
      children,
    }),
    useCallback: (fn: unknown) => fn,
    useEffect: () => undefined,
    useMemo: (fn: () => unknown) => fn(),
    useRef: (value: unknown) => ({ current: value }),
    useState: (initial: unknown) => [initial, () => undefined],
  }
}

/**
 * A value the loader has validated as callable.
 *
 * `unknown[]` rather than `never[]` for the parameter list: the loader calls these with real
 * arguments, and the whole point is that it may not assume a signature.
 */
type Callable = (...args: unknown[]) => unknown

function isCallable(value: unknown): value is Callable {
  return typeof value === 'function'
}

function runBundle(): RunRecord {
  const record: RunRecord = {
    id: '',
    requested: [],
    exported: new Map(),
    registrations: [],
    injected: [],
    namespaces: [],
  }

  const loader = {
    load(entry: { id?: unknown; factory?: unknown }) {
      if (typeof entry.id !== 'string' || !isCallable(entry.factory)) {
        throw new Error('loader received a malformed entry')
      }
      record.id = entry.id
      const requireFromTable = (specifier: string): unknown => {
        record.requested.push(specifier)
        if (specifier === 'react') return reactStub()
        if (specifier === 'react/jsx-runtime') return {}
        if (specifier === 'react-dom') return { createPortal: (node: unknown) => node }
        throw new Error(`loader has no module "${specifier}"`)
      }
      const produced: unknown = entry.factory(requireFromTable)
      if (typeof produced !== 'object' || produced === null) {
        throw new Error('bundle factory returned no exports object')
      }
      for (const [key, value] of Object.entries(produced)) record.exported.set(key, value)

      const apply = record.exported.get('apply')
      if (!isCallable(apply)) throw new Error('bundle exports no apply function')
      apply({
        effect: (callback: () => unknown) => callback(),
        slots: {
          inject(slot: string, callback: () => unknown) {
            record.injected.push(slot)
            callback()
          },
          register(options: Record<string, unknown>, component: unknown) {
            record.registrations.push({ options: new Map(Object.entries(options)), component })
            return () => undefined
          },
        },
        locale: {
          register(namespace: string) {
            record.namespaces.push(namespace)
            return () => undefined
          },
        },
      })
    },
  }

  const scope = globalThis as { window?: unknown }
  const previous = scope.window
  scope.window = { __ModuleLoader__: loader }
  try {
    // CommonJS caches by resolved path: without dropping the entry a second run
    // would replay the first run's export object instead of executing the bundle.
    const loaderRequire = createRequire(import.meta.url)
    delete loaderRequire.cache[loaderRequire.resolve(BUNDLE)]
    const loaded: unknown = loaderRequire(BUNDLE)
    void loaded
  } finally {
    scope.window = previous
  }
  records.push(record)
  return record
}

describe('built client bundle', () => {
  test('identifies itself with the package name', async () => {
    const manifest: unknown = await Bun.file(MANIFEST).json()
    const declared =
      typeof manifest === 'object' && manifest !== null ? Reflect.get(manifest, 'name') : undefined
    const run = runBundle()
    expect(run.id).toBe(declared)
    expect(run.id).toBe('@reedchan7/dsh-cost')
  })

  test('reaches the module table through the injected require, never a real one', () => {
    const run = runBundle()
    expect(run.requested).toContain('react')
    // The pill renders into the shipped stats row by portal, so react-dom is a
    // platform module this bundle must request rather than inline.
    expect(run.requested).toContain('react-dom')
  })

  test('exports the boot contract DSH calls', () => {
    const run = runBundle()
    expect(typeof run.exported.get('apply')).toBe('function')
    expect(run.exported.get('inject')).toEqual(['slots', 'locale'])
  })

  test('registers exactly one entry, on the composer stats row, at the declared order', () => {
    const run = runBundle()
    expect(run.injected).toEqual(['conversation.composer.dock'])
    expect(run.namespaces).toEqual(['dsh-cost'])
    expect(run.registrations).toHaveLength(1)
    const registration = run.registrations[0]
    expect(registration?.options.get('id')).toBe('cost')
    expect(registration?.options.get('name')).toBe('conversation.composer.dock')
    expect(registration?.options.get('order')).toBe(100)
    expect(registration?.options.get('locale')).toBe('dsh-cost')
    expect(typeof registration?.component).toBe('function')
  })

  test('the published package carries no runtime dependency', async () => {
    const manifest: unknown = await Bun.file(MANIFEST).json()
    expect(Reflect.get(Object(manifest), 'dependencies')).toBeUndefined()
    expect(Reflect.get(Object(manifest), 'peerDependencies')).toBeUndefined()
  })

  test('every run of the bundle behaves identically', () => {
    // Two runs in one process is what a reload looks like; a bundle that captured
    // module state on the first run would drift on the second.
    const first = runBundle()
    const second = runBundle()
    expect(second.requested).toEqual(first.requested)
    expect(second.registrations).toHaveLength(1)
    expect(records.filter((entry) => entry.id === first.id).length).toBeGreaterThan(1)
  })
})
