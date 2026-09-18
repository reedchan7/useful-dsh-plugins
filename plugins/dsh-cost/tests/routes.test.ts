/**
 * The host half's two routes, driven end to end.
 *
 * The figures the pill shows come from these handlers, and the parts that were wrong before are the
 * ones no unit test of the pricing library could see: which currency the route prices with, and
 * whether a session that ended between polls is still counted. These cases call the handler with
 * the same structural context DSH supplies and read the JSON body it writes.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { CNY_RATE_TABLE, USD_RATE_TABLE } from '@useful-dsh/cost-core'
import { dayKey, dayStart } from '@useful-dsh/tz'

import type { AccountFetcher } from '../src/account.ts'
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

/** One live session whose single settled request carries the given usage, dated `at`. */
function liveSessionAt(
  id: string,
  at: number,
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens?: number },
): unknown {
  const events = [
    { type: 'turn/start', time: at, data: { turn: 1 } },
    { type: 'step/start', time: at, data: { turn: 1, step: 1 } },
    {
      type: 'assistant/message',
      time: at + 1000,
      data: {
        turn: 1,
        step: 1,
        usage,
        message: {
          role: 'assistant',
          content: [],
          source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' },
        },
      },
    },
    { type: 'turn/end', time: at + 2000, data: { turn: 1 } },
  ]
  return { id, seq: events.length, eventAt: (position: number) => events[position] }
}

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

  test("a live session's attempts stay on the day and period they ran in", async () => {
    // The registry's own event surface used to strip `time`, so every attempt a
    // live session had ever made was dated to the poll instant: yesterday's spend
    // landed in today's total, priced at whatever period the poll happened to be
    // in. Polled at 09:30 Beijing (peak), a request from yesterday 20:00 (off-peak)
    // must still price at ¥1/M, and today must stay empty.
    const poll = Date.parse('2026-09-18T01:30:00Z')
    const yesterdayEvening = Date.parse('2026-09-17T12:00:00Z')
    const realNow = Date.now
    Date.now = () => poll
    try {
      const host = fakeHost([
        liveSessionAt('s1', yesterdayEvening, { inputTokens: 1_000_000, outputTokens: 0 }),
      ])
      apply(host.ctx)
      const body = await call(
        routeAt(host, '/api/dsh-cost/summary'),
        'http://127.0.0.1/api/dsh-cost/summary?session=s1&tz=Asia/Shanghai',
      )
      expect(body['ok']).toBe(true)
      expect(section(body, 'session')['total']).toBeCloseTo(1, 10)
      const today = section(body, 'today')
      expect(today['total']).toBeNull()
      expect(today['tokens']).toBe(0)
    } finally {
      Date.now = realNow
    }
  })

  test('the day token count covers the same sources as the day cost', async () => {
    // The day summary used to spread the disk half and override only its total, so
    // a day served entirely by live sessions showed a real cost next to "0 tok".
    const poll = Date.parse('2026-09-18T01:30:00Z')
    const thisMorning = Date.parse('2026-09-18T01:20:00Z')
    const realNow = Date.now
    Date.now = () => poll
    try {
      const host = fakeHost([
        liveSessionAt('s1', thisMorning, {
          inputTokens: 1_000_000,
          outputTokens: 100,
          cacheReadTokens: 2_000_000,
        }),
      ])
      apply(host.ctx)
      const body = await call(
        routeAt(host, '/api/dsh-cost/summary'),
        'http://127.0.0.1/api/dsh-cost/summary?session=s1&tz=Asia/Shanghai',
      )
      const today = section(body, 'today')
      // 09:20 Beijing on a Friday is peak: 2/M input, 0.04/M cache read, 8/M output.
      expect(today['total']).toBeCloseTo(2 + 0.08 + 0.0008, 10)
      expect(today['tokens']).toBe(3_000_100)
    } finally {
      Date.now = realNow
    }
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

/** Platform-shaped fixture for the billed day this test runs in; sums are hand-computed. */
function platformFixture(): { fetcher: AccountFetcher } {
  const startSec = Math.floor(dayStart(dayKey(Date.now(), 'Asia/Shanghai'), 'Asia/Shanghai') / 1000)
  const amount = {
    data: {
      biz_data: {
        series: [
          {
            buckets: [
              {
                time: startSec + 3600,
                usage: {
                  PROMPT_CACHE_HIT_TOKEN: 1000,
                  PROMPT_CACHE_MISS_TOKEN: 200,
                  RESPONSE_TOKEN: 50,
                },
              },
            ],
          },
        ],
      },
    },
  }
  const cost = {
    data: {
      biz_data: {
        data: [
          { currency: 'CNY', series: [{ buckets: [{ time: startSec + 3600, cost: 0.005 }] }] },
          { currency: 'CNY', series: [{ buckets: [{ time: startSec + 3600, cost: 0.002 }] }] },
        ],
      },
    },
  }
  const fetcher: AccountFetcher = (url: string) =>
    Promise.resolve({
      status: 200,
      ok: true,
      text: () => Promise.resolve(JSON.stringify(url.includes('/amount?') ? amount : cost)),
    })
  return { fetcher }
}

describe('the account block the summary carries', () => {
  test('without a platform token the route reports no-token', async () => {
    const host = fakeHost()
    apply(host.ctx)
    const body = await call(
      routeAt(host, '/api/dsh-cost/summary'),
      'http://127.0.0.1/api/dsh-cost/summary?session=none',
    )
    const account = section(body, 'account')
    expect(account['configured']).toBe(false)
    expect(account['status']).toBe('no-token')
  })

  test('a configured token brings the all-devices reading into the summary', async () => {
    writeFileSync(join(root, 'dsh-cost-platform-token'), 'platform-token')
    const host = fakeHost()
    apply(host.ctx, {}, { fetcher: platformFixture().fetcher })

    // The first answer comes from the empty cache while the platform fetch is in flight.
    const first = await call(
      routeAt(host, '/api/dsh-cost/summary'),
      'http://127.0.0.1/api/dsh-cost/summary?session=none',
    )
    expect(section(first, 'account')['status']).toBe('loading')

    await new Promise((resolve) => setTimeout(resolve, 0))
    const second = await call(
      routeAt(host, '/api/dsh-cost/summary'),
      'http://127.0.0.1/api/dsh-cost/summary?session=none',
    )
    const account = section(second, 'account')
    expect(account['configured']).toBe(true)
    expect(account['status']).toBe('ok')
    expect(account['currency']).toBe('CNY')
    // Hand-computed from the fixture: 0.005 + 0.002 cost over the two API keys.
    expect(account['today']).toBeCloseTo(0.007, 10)
    expect(account['tokens']).toEqual({ cacheHit: 1000, cacheMiss: 200, completion: 50 })
  })
})

/** A loopback POST carrying a JSON body. */
function postRequest(url: string, body: unknown): unknown {
  const text = JSON.stringify(body)
  return {
    url,
    method: 'POST',
    headers: { host: '127.0.0.1:4173' },
    socket: { remoteAddress: '127.0.0.1' },
    async *[Symbol.asyncIterator]() {
      yield Buffer.from(text)
    },
  }
}

/** A fetcher whose every answer is a 401, as the platform answers a bad token. */
const rejectedFetcher: AccountFetcher = () =>
  Promise.resolve({ status: 401, ok: false, text: () => Promise.resolve('{}') })

describe('the account token route', () => {
  /** Call the token route with one body and decode the JSON it wrote. */
  async function postToken(
    host: { routes: Map<string, Route> },
    body: unknown,
  ): Promise<{
    status: number
    body: Record<string, unknown>
  }> {
    let status = 0
    let text = ''
    await routeAt(host, '/api/dsh-cost/account-token').handler(
      postRequest('http://127.0.0.1/api/dsh-cost/account-token', body),
      {
        writeHead: (value: number) => {
          status = value
        },
        end: (chunk: string) => {
          text = chunk
        },
      },
    )
    const decoded: unknown = JSON.parse(text)
    if (!isRecord(decoded)) throw new Error(`token route answered non-object: ${text}`)
    return { status, body: decoded }
  }

  test('a validated token is persisted and the summary picks it up', async () => {
    const host = fakeHost()
    apply(host.ctx, {}, { fetcher: platformFixture().fetcher })
    const answer = await postToken(host, { token: 'platform-token' })
    expect(answer.status).toBe(200)
    expect(answer.body['ok']).toBe(true)
    // The route awaits the refresh, so the answer already carries the fresh reading.
    const account = section(answer.body, 'account')
    expect(account['status']).toBe('ok')
    expect(account['today']).toBeCloseTo(0.007, 10)
    expect(readFileSync(join(root, 'dsh-cost-platform-token'), 'utf8').trim()).toBe(
      'platform-token',
    )

    const summary = await call(
      routeAt(host, '/api/dsh-cost/summary'),
      'http://127.0.0.1/api/dsh-cost/summary?session=none',
    )
    expect(section(summary, 'account')['status']).toBe('ok')
  })

  test('a rejected token is named and never touches the file', async () => {
    writeFileSync(join(root, 'dsh-cost-platform-token'), 'working-token')
    const host = fakeHost()
    apply(host.ctx, {}, { fetcher: rejectedFetcher })
    const answer = await postToken(host, { token: 'bad-token' })
    expect(answer.body['ok']).toBe(false)
    expect(answer.body['error']).toBe('invalid-token')
    expect(readFileSync(join(root, 'dsh-cost-platform-token'), 'utf8')).toBe('working-token')
  })

  test('an empty token clears the credential', async () => {
    writeFileSync(join(root, 'dsh-cost-platform-token'), 'working-token')
    const host = fakeHost()
    apply(host.ctx)
    const answer = await postToken(host, { token: '' })
    expect(answer.body['ok']).toBe(true)
    expect(section(answer.body, 'account')['status']).toBe('no-token')
    expect(existsSync(join(root, 'dsh-cost-platform-token'))).toBe(false)
  })

  test('a non-POST is refused, and a non-loopback caller gets nothing', async () => {
    const host = fakeHost()
    apply(host.ctx)
    let status = 0
    const response = {
      writeHead: (value: number) => {
        status = value
      },
      end: () => {},
    }
    await routeAt(host, '/api/dsh-cost/account-token').handler(
      {
        url: 'http://127.0.0.1/api/dsh-cost/account-token',
        method: 'GET',
        headers: { host: '127.0.0.1:4173' },
        socket: { remoteAddress: '127.0.0.1' },
      },
      response,
    )
    expect(status).toBe(405)
    await routeAt(host, '/api/dsh-cost/account-token').handler(
      {
        url: 'http://evil.example/api/dsh-cost/account-token',
        method: 'POST',
        headers: { host: 'evil.example' },
        socket: { remoteAddress: '203.0.113.5' },
      },
      response,
    )
    expect(status).toBe(403)
  })
})

describe('regression: the shipped CNY table is what an unconfigured host uses', () => {
  test('no config means the renminbi book', () => {
    const host = fakeHost()
    apply(host.ctx)
    expect(tableForConfig()).toBe(CNY_RATE_TABLE)
  })
})
