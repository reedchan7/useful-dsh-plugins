/**
 * Which row the pill shares a line with.
 *
 * The composer dock draws one row per registered entry, so the pill reaches the shipped stats line
 * by rendering into that row instead of its own. The lookup reads the row from the entry's own
 * anchor — never the document, so a second composer on screen cannot hand this entry the wrong row
 * — and it keys on the `data-composer-stats` marker DSH's own composer stylesheet already uses.
 * These cases pin the marker, the sibling scope, and the absent-row answer: no row must yield no
 * host (the pill then keeps its own row) rather than some arbitrary element.
 */

import { describe, expect, test } from 'bun:test'

import { STATS_ROW_MARKER, statsRowOf } from '../src/client/CostPill.ts'

/** An anchor whose parent answers a query with one fixed node. */
function anchorWith<T>(row: T | null): { parentElement: { querySelector: () => T | null } } {
  return { parentElement: { querySelector: () => row } }
}

describe('stats row lookup', () => {
  test('the marker is the attribute DSH puts on the shipped stats row', () => {
    expect(STATS_ROW_MARKER).toBe('[data-composer-stats]')
  })

  test('an anchor beside the shipped row resolves to that row', () => {
    const row = { stats: true }
    expect(statsRowOf(anchorWith(row))).toBe(row)
  })

  test('the lookup asks the parent for that marker', () => {
    const asked: string[] = []
    const anchor = {
      parentElement: {
        querySelector: (selector: string) => {
          asked.push(selector)
          return null
        },
      },
    }
    expect(statsRowOf(anchor)).toBeNull()
    expect(asked).toEqual([STATS_ROW_MARKER])
  })

  test('no anchor, no parent and no row all resolve to no host', () => {
    expect(statsRowOf(null)).toBeNull()
    expect(statsRowOf({ parentElement: null })).toBeNull()
    expect(statsRowOf(anchorWith(null))).toBeNull()
  })
})
