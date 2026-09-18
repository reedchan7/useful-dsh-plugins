/**
 * English dictionary for the cost UI.
 *
 * Keys are flat dotted paths so the same map drives the status pill and the detail panel. The
 * Chinese dictionary mirrors this key set exactly; `check-docs-pairing` and the dictionary test
 * enforce that.
 */

export const en = {
  'pill.session': 'Session',
  'pill.turn': 'Turn',
  'pill.today': 'Today',
  'pill.cost': 'Cost',
  'pill.costHint': 'Today, all projects · session {session} · turn {turn} · {period} rate',
  'pill.balance': 'Balance',
  'pill.estimated': 'Estimated',
  'pill.noData': 'No usage recorded yet',
  'pill.unpricedIncluded': 'includes unpriced model',
  'pill.refresh': 'Refresh',
  'pill.updatedAt': 'Updated {time}',

  'panel.title': 'Cost',
  'panel.sessionTotal': 'This session',
  'panel.turnCurrent': 'Current turn',
  'panel.todayTotal': 'Today (all projects)',
  'panel.tokensTotal': 'Tokens',
  'panel.cacheHit': 'Cache hit',
  'panel.cacheMiss': 'Uncached input',
  'panel.output': 'Output',
  'panel.cacheWrite': 'Cache write',
  'panel.priced': 'Priced',
  'panel.unpriced': 'Unpriced',
  'panel.pricingPeriod': 'Rate',
  'panel.periodPeak': 'Peak',
  'panel.periodOffpeak': 'Off-peak',
  'panel.nextSwitch': 'Next rate change {time} ({countdown})',
  'panel.peakWindowLocal': 'Peak {windows} ({zone})',
  'panel.peakWindowBilled': 'Billed peak {windows} Beijing time',
  'panel.byTurn': 'By turn',
  'panel.byModel': 'By model',
  'panel.byHour': 'Today by hour',
  'panel.trend': 'Turn trend',
  'panel.composition': 'What you paid for',
  'panel.compositionNote':
    'Share of this session’s cost: cached input is cheap, uncached input and output are not.',
  'panel.cachedInputCost': 'Cached input',
  'panel.uncachedInputCost': 'Uncached input',
  'panel.cacheWriteCost': 'Cache write',
  'panel.outputCost': 'Output',
  'panel.compositionUnpriced': '{count} attempt(s) had no price and are missing from this split.',
  'panel.dayOnlyLive':
    'Only the sessions live in this process are counted so far; finished session logs were not readable.',
  'panel.sourceLive': 'Live sessions',
  'panel.sourceHistory': 'Finished sessions',
  'panel.sourceDraining': 'Handing over',
  'panel.unpricedModels': 'Unpriced models: {models}',
  'panel.noUsage': 'No token usage in this session yet.',
  'panel.scopeNote':
    'Aggregated across {projects} projects and {sessions} sessions on this machine.',
  'panel.notLive': 'This session is not live in the host process; cost is unavailable.',
  'panel.oldFormatSkipped': '{count} older session files were skipped (unsupported format).',
  'panel.sessionBeforePlugin':
    'Sessions finished before the plugin was installed are read from disk.',
  'panel.estimateNote':
    'Estimated from provider-reported token usage and the published price list. Not a bill.',
  'panel.pricingCapturedAt': 'Price list captured {date}.',
  'panel.balanceTitle': 'Account balance',
  'panel.balanceTotal': 'Total',
  'panel.balanceGranted': 'Granted',
  'panel.balanceToppedUp': 'Topped up',
  'panel.balanceLow': 'Below threshold',
  'panel.balanceUnavailable': 'Balance unavailable: credential or endpoint not reachable.',
  'panel.shareOfBalance': '{percent} of balance',

  'settings.title': 'Cost display',
  'settings.display': 'Status bar display',
  'settings.displayTriple': 'Three pills',
  'settings.displayCompact': 'One compact pill',
  'settings.displayMinimal': 'One minimal pill',
  'settings.currency': 'Currency',
  'settings.currencyAuto': 'Auto (from account balance)',
  'settings.currencyCny': 'CNY (¥)',
  'settings.currencyUsd': 'USD ($)',
  'settings.timezone': 'Calendar timezone',
  'settings.timezoneAuto': 'Auto ({zone})',
  'settings.dayBoundary': 'Day boundary',
  'settings.dayBoundaryLocal': 'Local midnight',
  'settings.dayBoundaryBilled': 'Beijing midnight',
  'settings.lowBalance': 'Low balance threshold',
  'settings.refreshMs': 'Refresh interval (ms)',

  'unit.tokens': 'tok',
  'unit.tokensPerSecond': 'tok/s',
  'unit.turn': 'turn',
  'unit.turns': 'turns',
  'unit.step': 'step',
  'unit.steps': 'steps',
  'unit.attempt.one': '{count} step',
  'unit.attempt.other': '{count} steps',
  'unit.percent': '%',
} as const

/** Every key the cost UI understands. */
export type CostLocaleKey = keyof typeof en
