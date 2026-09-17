/**
 * The host half's two routes, driven end to end.
 *
 * The figures the pill shows come from these handlers, and the parts that were wrong before are the
 * ones no unit test of the pricing library could see: which currency the route prices with, and
 * whether a session that ended between polls is still counted. These cases call the handler with
 * the same structural context DSH supplies and read the JSON body it writes.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CNY_RATE_TABLE, USD_RATE_TABLE } from '@useful-dsh/cost-core'

import { Config, apply, tableForConfig, wirePeriod } from '../src/index.ts'

/** One route registration captured from a fake host. */
interface Route {
  kind: string
  path: string
  handler: (req: unknown, res: unknown) => void | Promise<void>
}

/** A fake host context that records the routes and answers `sessions.list()`. */
function fakeHost(sessions: readonly unknown[] = []): {
  ctx: Parameters<typeof apply>[0]
  routes: Map<string, Route>
  warnings: string[]
} {
  const routes = new Map<string, Route>()
  const warnings: string[] = []
  return {
    routes,
    warnings,
    ctx: {
      logger: { warn: (message: string) => void warnings.push(message) },
      sessions: { list: () => sessions },
      webServer: {
        register: (route: Route) => {
          routes.set(route.path, route)
          return () => routes.delete(route.path)
        },
      },
      effect: (callback) => {
        callback()
      },
    },
  }
}

/** A loopback request for one route. */
function request(url: string): unknown {
  return { url, headers: { host: '127.0.0.1:4173' }, socket: { remoteAddress: '127.0.0.1' } }
}

/** Call one route and decode the JSON body it wrote. */
async function call(route: Route, url: string): Promise<Record<string, unknown>> {
  let body = ''
  const response = {
    writeHead: () => {},
    end: (text: string) => {
      body = text
    },
  }
  await route.handler(request(url), response)
  const decoded: unknown = JSON.parse(body)
  if (!isRecord(decoded)) throw new Error(`route answered with a non-object body: ${body}`)
  return decoded
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** One nested record of a response body. */
function section(body: Record<string, unknown>, key: string): Record<string, unknown> {
  const value = body[key]
  if (!isRecord(value)) throw new Error(`response has no "${key}" object: ${JSON.stringify(body)}`)
  return value
}

/** The route registered at one path, which every case below expects to exist. */
function routeAt(host: { routes: Map<string, Route> }, path: string): Route {
  const route = host.routes.get(path)
  if (route === undefined) throw new Error(`no route registered at ${path}`)
  return route
}

let root = ''
let previousHome: string | undefined

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-cost-route-'))
  // The day scope reads `$DSH_HOME/sessions`; pointing it at an empty temporary
  // home keeps this test off the developer's own session store, which is what the
  // store root is documented to follow.
  previousHome = process.env['DSH_HOME']
  process.env['DSH_HOME'] = root
})

afterEach(() => {
  if (previousHome === undefined) {
    delete process.env['DSH_HOME']
  } else {
    process.env['DSH_HOME'] = previousHome
  }
  rmSync(root, { recursive: true, force: true })
})

describe('the currency the routes price with', () => {
  test('the config row selects the price book', () => {
    expect(tableForConfig({}).currency).toBe('CNY')
    expect(tableForConfig({ currency: 'USD' }).currency).toBe('USD')
    expect(tableForConfig({ currency: 'USD' })).toBe(USD_RATE_TABLE)
  })

  test('an unusable currency is rejected where it is written, not at render time', () => {
    // The loader reads `Config['~standard'].validate`, so the refusals have to
    // arrive as standard-schema issues: a schema that only exposed `parse` threw
    // on the loader's own property read and took the whole entry down.
    const schema = Config['~standard']
    expect(schema.validate({ currency: 'EUR' })).toEqual({
      issues: [{ message: 'dsh-cost: currency must be "CNY" or "USD", got "EUR"' }],
    })
    expect(schema.validate('USD')).toEqual({
      issues: [{ message: 'dsh-cost: config must be an object' }],
    })
    expect(schema.validate({})).toEqual({ value: {} })
    expect(schema.validate(undefined)).toEqual({ value: {} })
    expect(schema.validate({ currency: 'USD' })).toEqual({ value: { currency: 'USD' } })
  })

  test('the summary route reports the configured currency', async () => {
    // The browser half used to send `currency=CNY` on every request, so a USD
    // account was priced and labelled in renminbi. The route's answer is now what
    // the pill renders, and it comes from the composition row.
    const runs = (['CNY', 'USD'] as const).map(async (currency) => {
      const host = fakeHost()
      apply(host.ctx, { currency })
      const summary = await call(
        routeAt(host, '/api/dsh-cost/summary'),
        'http://127.0.0.1/api/dsh-cost/summary?session=none',
      )
      const config = await call(
        routeAt(host, '/api/dsh-cost/config'),
        'http://127.0.0.1/api/dsh-cost/config',
      )
      return { currency, summary: summary['currency'], config: config['currency'] }
    })
    expect(await Promise.all(runs)).toEqual([
      { currency: 'CNY', summary: 'CNY', config: 'CNY' },
      { currency: 'USD', summary: 'USD', config: 'USD' },
    ])
  })

  test('an explicit request currency still overrides the configured one', async () => {
    const host = fakeHost()
    apply(host.ctx, { currency: 'CNY' })
    const body = await call(
      routeAt(host, '/api/dsh-cost/summary'),
      'http://127.0.0.1/api/dsh-cost/summary?session=none&currency=USD',
    )
    expect(body['currency']).toBe('USD')
  })

  test('a non-loopback request is refused', async () => {
    const host = fakeHost()
    apply(host.ctx)
    let status = 0
    await routeAt(host, '/api/dsh-cost/summary').handler(
      {
        url: 'http://evil.example/api/dsh-cost/summary',
        headers: { host: 'evil.example' },
        socket: { remoteAddress: '203.0.113.5' },
      },
      {
        writeHead: (value: number) => {
          status = value
        },
        end: () => {},
      },
    )
    expect(status).toBe(403)
  })
})

describe('the day scope the route reports', () => {
  test('an empty store root yields an empty day rather than an error', async () => {
    const host = fakeHost()
    apply(host.ctx)
    const body = await call(
      routeAt(host, '/api/dsh-cost/summary'),
      'http://127.0.0.1/api/dsh-cost/summary?session=one',
    )
    expect(body['ok']).toBe(false)
    const today = section(body, 'today')
    expect(today['projects']).toBe(0)
    expect(today['sessions']).toBe(0)
    expect(today['total']).toBeNull()
    expect(today['unpriced']).toEqual([])
    expect(host.warnings).toEqual([])
  })
})

describe('the billing period block', () => {
  test('a known transition is carried through with the instant it happens', () => {
    expect(
      wirePeriod({ period: 'offpeak', nextPeriod: 'peak', nextTransitionAt: 1_700_000_000_000 }),
    ).toEqual({ current: 'offpeak', next: 'peak', nextAt: 1_700_000_000_000 })
  })

  test('an unknown transition is reported as unknown, not as the current instant', () => {
    // The wire block has no `now` to fall back to: the old code filled `nextAt`
    // with the request's own timestamp, which the panel rendered as "next change
    // <this moment> (0h 00m 00s)".
    expect(wirePeriod({ period: 'peak', nextPeriod: null, nextTransitionAt: null })).toEqual({
      current: 'peak',
    })
    expect(wirePeriod({ period: 'peak', nextPeriod: 'offpeak', nextTransitionAt: null })).toEqual({
      current: 'peak',
    })
    expect(wirePeriod({ period: 'peak', nextPeriod: null, nextTransitionAt: 123 })).toEqual({
      current: 'peak',
    })
  })

  test('the countdown points at the real change, never at the moment of the request', async () => {
    // Friday 18:00 Beijing ends the last peak window of the week, so the next
    // change is Monday 09:00 — 63 hours later. The route used to fall back to
    // `now` whenever its scan found nothing, and the panel rendered that as "next
    // change <this moment> (0h 00m 00s)" for 15 hours of every week.
    const fridayEvening = Date.parse('2026-09-11T10:00:00Z')
    const realNow = Date.now
    Date.now = () => fridayEvening
    try {
      const host = fakeHost()
      apply(host.ctx)
      const body = await call(
        routeAt(host, '/api/dsh-cost/summary'),
        'http://127.0.0.1/api/dsh-cost/summary?session=none',
      )
      expect(body['generatedAt']).toBe(fridayEvening)
      const period = section(body, 'period')
      expect(period['current']).toBe('offpeak')
      expect(period['next']).toBe('peak')
      expect(period['nextAt']).toBe(Date.parse('2026-09-14T01:00:00Z'))
      expect(period['nextAt']).not.toBe(fridayEvening)
    } finally {
      Date.now = realNow
    }
  })

  test('a Sunday reports the pair rather than a countdown that has already expired', async () => {
    const sunday = Date.parse('2026-09-13T12:00:00Z')
    const realNow = Date.now
    Date.now = () => sunday
    try {
      const host = fakeHost()
      apply(host.ctx)
      const body = await call(
        routeAt(host, '/api/dsh-cost/summary'),
        'http://127.0.0.1/api/dsh-cost/summary?session=none',
      )
      const period = section(body, 'period')
      expect(period['current']).toBe('offpeak')
      expect(period['next']).toBe('peak')
      expect(period['nextAt']).toBe(Date.parse('2026-09-14T01:00:00Z'))
      expect(period['nextAt']).not.toBe(sunday)
    } finally {
      Date.now = realNow
    }
  })
})

describe('regression: the shipped CNY table is what an unconfigured host uses', () => {
  test('no config means the renminbi book', () => {
    const host = fakeHost()
    apply(host.ctx)
    expect(tableForConfig()).toBe(CNY_RATE_TABLE)
  })
})
