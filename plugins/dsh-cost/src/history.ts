/**
 * Account-level day totals from the durable session store.
 *
 * "What did today cost" is a question about the account, not about the session that happens to be
 * open, so the answer has to include every project on this machine. Live sessions come from the
 * host registry; sessions that already ended are read from `$DSH_HOME/sessions`, which stores one
 * zstd-compressed JSONL log per session under a directory named after its project. Each log is a
 * concatenated zstd stream — one frame per durable write — so it is read frame by frame
 * ({@link decompressFrames}); a single-frame decoder would see only the session header.
 *
 * Reading is bounded on purpose: only files modified inside the requested window are touched, each
 * file is folded once and cached by modification time, and a file this build cannot read is counted
 * and reported rather than skipped in silence.
 *
 * The handover from registry to disk is the fragile moment. The registry drops a session the moment
 * it ends, but the store buffers a session's events in memory and flushes them to its log at a
 * later checkpoint — the file can hold nothing but the header for an hour or more (observed in
 * production: a ¥10 session whose log stayed at its 495-byte header 80 minutes after it ended). A
 * plugin that trusts the file at eviction silently loses the whole session until the checkpoint
 * lands, which is what made the day total jump every time a session was switched. Ended sessions
 * therefore stay in a draining state: the attempts folded while live are kept in memory, the disk
 * log is folded in as checkpoints land, and the disk side takes over only once it demonstrably
 * covers the memory fold.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

import {
  DEEPSEEK_PEAK_SCHEDULE,
  foldAttempts,
  priceAttempt,
  summarize,
  type CostSummary,
  type PricedInput,
  type RateTable,
  type SessionEventLike,
  type UsageAttempt,
} from '@useful-dsh/cost-core'
import { computeInstant, dayStart, shiftDay, type BillingClock } from '@useful-dsh/tz'

import { decompressFrames } from './zstd.ts'

/** One session log found on disk. */
export interface SessionFile {
  /** Absolute path of the log. */
  path: string
  /** Project directory name as the store spells it (a path with separators escaped). */
  project: string
  /** Modification time in epoch ms. */
  modifiedAt: number
  /** Size in bytes. */
  size: number
}

/** What one scan read, and what it could not. */
export interface HistoryScan {
  /** Attempts from every readable session log inside the window. */
  attempts: readonly UsageAttempt[]
  /** Sessions folded into {@link attempts}. */
  sessionsRead: number
  /** Files skipped because this build cannot read them. */
  skipped: number
  /** Distinct projects the read sessions belong to. */
  projects: readonly string[]
  /** Wall time the scan took, for the log line. */
  elapsedMs: number
}

/** Cache entry for one file, keyed by the modification time it was read at. */
interface CacheEntry {
  modifiedAt: number
  attempts: readonly UsageAttempt[]
  /** Size at read time, used to re-check an entry that yielded nothing. */
  size: number
}

/**
 * One ended session kept in memory until its durable log catches up.
 *
 * The registry hands a session over while its log still lags behind (see the module header), so the
 * attempts folded while it was live cannot be dropped on eviction. They are retained here, the disk
 * log is merged in on every scan, and once the log demonstrably covers them the entry is dropped
 * and the plain disk path owns the session from then on.
 */
export interface DrainingState {
  /** Attempts folded from the registry while the session was live, in fold order. */
  attempts: readonly UsageAttempt[]
  /** Wall time the session was handed over, used to bound how long an entry is kept. */
  drainedAt: number
  /** Project directories this session's log has been seen under. */
  projects: string[]
  /**
   * True once the disk log has been seen to cover {@link attempts}; the next scan hands the session
   * to the plain disk path.
   */
  covered: boolean
}

/** How long a handover may take before the entry is dropped anyway: two days, the scan window. */
const DRAIN_SWEEP_MS = 2 * 24 * 3600 * 1000

/** Parse one JSONL log into the events the fold understands. */
function parseLog(text: string): SessionEventLike[] {
  const events: SessionEventLike[] = []
  for (const line of text.split('\n')) {
    if (line === '') continue
    let decoded: unknown
    try {
      decoded = JSON.parse(line)
    } catch {
      // A torn tail is expected: the store appends while a session runs, and an
      // interrupted write can leave a partial final line.
      continue
    }
    if (typeof decoded !== 'object' || decoded === null) continue
    const type: unknown = Reflect.get(decoded, 'type')
    if (typeof type !== 'string') continue
    const seq: unknown = Reflect.get(decoded, 'seq')
    const time: unknown = Reflect.get(decoded, 'time')
    events.push({
      type,
      ...(typeof seq === 'number' ? { seq } : {}),
      ...(typeof time === 'number' ? { time } : {}),
      data: Reflect.get(decoded, 'data'),
    })
  }
  return events
}

/** Read one session log, transparently decompressing the zstd generations; null when unreadable. */
export function readSessionLog(path: string): SessionEventLike[] | null {
  let raw: Buffer
  try {
    if (!statSync(path).isFile()) return null
    raw = readFileSync(path)
  } catch {
    return null
  }
  const text = path.endsWith('.zstd') ? decompressFrames(raw) : raw.toString('utf8')
  return text === null ? null : parseLog(text)
}

/**
 * List session logs modified at or after a cutoff, newest first. The store nests logs two levels
 * deep: `<sessions>/<project>/<session>/<file>`. Unreadable directories are skipped because another
 * writer may be rotating them.
 */
export function listSessionFiles(root: string, since: number): SessionFile[] {
  const files: SessionFile[] = []
  let projects: string[]
  try {
    projects = readdirSync(root)
  } catch {
    return files
  }
  for (const project of projects) {
    const projectDir = join(root, project)
    let sessions: string[]
    try {
      sessions = readdirSync(projectDir)
    } catch {
      continue
    }
    for (const session of sessions) {
      const sessionDir = join(projectDir, session)
      let entries: string[]
      try {
        entries = readdirSync(sessionDir)
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.startsWith('session') || entry.endsWith('.lock')) continue
        const path = join(sessionDir, entry)
        try {
          const stat = statSync(path)
          if (!stat.isFile() || stat.mtimeMs < since) continue
          files.push({ path, project, modifiedAt: stat.mtimeMs, size: stat.size })
        } catch {
          continue
        }
      }
    }
  }
  return files.toSorted((left, right) => right.modifiedAt - left.modifiedAt)
}

/** Files already folded, keyed by path and modification time. */
export type HistoryCache = Map<string, CacheEntry>

export function createHistoryCache(): HistoryCache {
  return new Map()
}

/**
 * Whether two attempts stand at the same position of one session's request stream. Timestamps
 * deliberately play no part: the registry surface drops an event's own time, so an attempt folded
 * from the registry is dated to a poll instant while the same attempt folded from the log carries
 * its true event time.
 */
function sameAttemptPosition(left: UsageAttempt, right: UsageAttempt): boolean {
  return left.turn === right.turn && left.step === right.step
}

/**
 * Merge the attempts of a draining session with a fresh fold of its disk log.
 *
 * Both sides describe the same append-only stream at different prefixes — the retained attempts
 * stop where the registry stopped, the disk fold stops where the latest checkpoint stopped — so
 * when the disk side reaches at least as far and every retained attempt lines up with the disk
 * fold's first entries, the disk fold alone is the session (it also carries true event times).
 * Ordering is what makes retries safe: two attempts of one step sit in stream order on both sides,
 * so duplicates pair up positionally instead of being matched away.
 *
 * When the sequences diverge — a revived session rewritten from scratch, say — the fold falls back
 * to a union keyed on the attempt's full contents, which cannot match across genuinely different
 * requests. The entry then stays uncovered until the window sweep drops it.
 */
export function mergeAttemptTail(
  retained: readonly UsageAttempt[],
  disk: readonly UsageAttempt[],
): { attempts: readonly UsageAttempt[]; covered: boolean } {
  if (
    disk.length >= retained.length &&
    retained.every((attempt, index) => {
      const candidate = disk[index]
      return candidate !== undefined && sameAttemptPosition(attempt, candidate)
    })
  ) {
    return { attempts: disk, covered: true }
  }
  const seen = new Set(
    retained.map(
      (attempt) =>
        `${attempt.turn}/${attempt.step}/${attempt.tokens.input}/${attempt.tokens.cacheRead}/${attempt.tokens.output}/${attempt.tokens.cacheWrite ?? 0}`,
    ),
  )
  const extra = disk.filter((attempt) => {
    const key = `${attempt.turn}/${attempt.step}/${attempt.tokens.input}/${attempt.tokens.cacheRead}/${attempt.tokens.output}/${attempt.tokens.cacheWrite ?? 0}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  return { attempts: [...retained, ...extra], covered: false }
}

/**
 * Fold every session log that could hold spend inside the local day. The window starts one local
 * day before the requested day so a session that began before midnight and is still running is not
 * lost; the caller filters by attempt timestamp anyway.
 *
 * @param liveSessionIds - Sessions the host already folds, whose files are skipped.
 * @param draining - Sessions the registry handed over but whose logs have not caught up; their
 *   files are folded into the retained state instead of the scan, and never counted twice.
 */
export function scanHistory(
  cache: HistoryCache,
  root: string,
  clock: BillingClock,
  now: number,
  liveSessionIds: ReadonlySet<string>,
  draining?: Map<string, DrainingState>,
): HistoryScan {
  const started = Date.now()
  const today = clockDayKey(now, clock)
  const windowStart = dayStart(shiftDay(today, -1), clock.timezone)
  const files = listSessionFiles(root, windowStart)
  const attempts: UsageAttempt[] = []
  const projects = new Set<string>()
  let sessionsRead = 0
  let skipped = 0

  // Sweep entries the handover has not finished in two days, and covered entries the
  // disk path now owns; both would otherwise pin their files out of the scan for the
  // process lifetime. Age is measured from the handover itself: a session's newest
  // *closed* attempt can sit well before it ended (its last request closes only when
  // the log's closing boundary reaches the fold), which is not old age.
  if (draining !== undefined) {
    for (const [id, entry] of draining) {
      if (entry.covered || now - entry.drainedAt > DRAIN_SWEEP_MS) draining.delete(id)
    }
  }

  for (const file of files) {
    const id = file.path.split('/').slice(-2, -1)[0] ?? ''
    if (liveSessionIds.has(id)) continue
    const drainingEntry = draining?.get(id)
    if (drainingEntry !== undefined) {
      // The memory side owns this session until its log catches up. Fold whatever the latest
      // checkpoint has landed and merge it in; the scan itself must not count the file.
      const events = readSessionLog(file.path)
      if (events !== null) {
        const merged = mergeAttemptTail(drainingEntry.attempts, foldAttempts(events))
        drainingEntry.attempts = merged.attempts
        drainingEntry.covered = drainingEntry.covered || merged.covered
        if (!drainingEntry.projects.includes(file.project)) {
          drainingEntry.projects = [...drainingEntry.projects, file.project]
        }
      }
      continue
    }
    const cached = cache.get(file.path)
    let folded: readonly UsageAttempt[]
    // A cached empty result is re-read once per modification: a log too short to
    // hold a billed request legitimately yields nothing, but a real log must never
    // stay invisible because an earlier read failed or raced the writer.
    if (
      cached !== undefined &&
      cached.modifiedAt === file.modifiedAt &&
      (cached.attempts.length > 0 || file.size === cached.size)
    ) {
      folded = cached.attempts
    } else {
      const events = readSessionLog(file.path)
      if (events === null) {
        skipped += 1
        continue
      }
      folded = foldAttempts(events)
      cache.set(file.path, { modifiedAt: file.modifiedAt, attempts: folded, size: file.size })
    }
    const inWindow = folded.filter((attempt) => attempt.at >= windowStart)
    if (inWindow.length === 0) continue
    sessionsRead += 1
    projects.add(file.project)
    attempts.push(...inWindow)
  }
  return {
    attempts,
    sessionsRead,
    skipped,
    projects: [...projects],
    elapsedMs: Date.now() - started,
  }
}

/** Local calendar day key of one instant in the reader's zone. */
function clockDayKey(at: number, clock: BillingClock): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: clock.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(at))
  return parts
}

/** Price scanned attempts into per-hour buckets of one local day. */
export function summarizeHistoryDay(
  attempts: readonly UsageAttempt[],
  table: RateTable,
  clock: BillingClock,
  now: number,
): {
  summary: CostSummary
  hourly: { hour: number; cost: number; tokens: number }[]
  unpriced: string[]
} {
  const key = clockDayKey(now, clock)
  const start = dayStart(key, clock.timezone)
  const end = dayStart(shiftDay(key, 1), clock.timezone)
  const hours = new Map<number, { hour: number; cost: number; tokens: number }>()
  const hourFormatter = new Intl.DateTimeFormat('en-GB', {
    timeZone: clock.timezone,
    hour: '2-digit',
    hour12: false,
  })
  // Pricing reads only the attempt's period, so the transition scan is skipped
  // (scanMs 0): scanning for the *next* rate change once per attempt made a
  // day with a few thousand attempts take seconds of synchronous CPU.
  const inDay: PricedInput[] = []

  for (const attempt of attempts) {
    if (attempt.at < start || attempt.at >= end) continue
    const instant = computeInstant(DEEPSEEK_PEAK_SCHEDULE, clock, attempt.at, 0)
    inDay.push({ attempt, instant })
    const hour = Number(hourFormatter.format(new Date(attempt.at)))
    const bucket = hours.get(hour) ?? { hour, cost: 0, tokens: 0 }
    bucket.cost += priceAttempt(table, attempt, instant).cost ?? 0
    bucket.tokens +=
      attempt.tokens.input +
      attempt.tokens.cacheRead +
      (attempt.tokens.cacheWrite ?? 0) +
      attempt.tokens.output
    hours.set(hour, bucket)
  }

  const summary = summarize(table, inDay)
  const hourly = Array.from(
    { length: 24 },
    (_, hour) => hours.get(hour) ?? { hour, cost: 0, tokens: 0 },
  )
  return { summary, hourly, unpriced: [...new Set(summary.unpriced.map((e) => e.attempt.model))] }
}
