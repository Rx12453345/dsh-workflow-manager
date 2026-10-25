/**
 * A mutual-exclusion lock for the mutation harnesses.
 *
 * WHY THIS EXISTS (a real incident, not a hypothetical)
 * Six harnesses in this directory inject a defect into a file under `lib/`, run a suite, then
 * restore the file byte-for-byte. Each one verifies only ITS OWN restore, so two of them
 * running at once on the same file is not detected by either: two agents started two
 * harnesses concurrently, both rewrote `lib/client.js`, and TWO MUTANTS WERE LEFT APPLIED in
 * the source tree with nobody aware. The suite happened to catch it that time — luck, not
 * safety. A subtle enough mutant that kept the suite green would have left a silently
 * corrupted source file while the harness still printed "sources restored byte-for-byte: YES".
 *
 * WHAT THIS GUARANTEES
 * At most one mutation harness touches `lib/` at a time, process-wide and machine-wide. The
 * second process does NOT wait: it FAILS LOUDLY AND EXITS NON-ZERO, naming the holder. That is
 * deliberate — a queued run looks like a hang, and a silent queue is how someone concludes the
 * tool is broken and starts killing things. Failing fast is the readable outcome.
 *
 * HOW THE LOCK IS TAKEN
 * `writeFileSync(path, json, { flag: 'wx' })` — O_CREAT|O_EXCL. The create is atomic: the
 * kernel picks exactly one winner, so two processes cannot both believe they hold the lock.
 * The winner records its pid, the acquisition time, the host name and the caller's label.
 *
 * HOW A STALE LOCK IS RECOVERED — AND THE ONE CASE THAT MUST NOT BE STOLEN
 * A process killed with SIGKILL (or one whose machine died) leaves the file behind. A lock is
 * taken over when EITHER the recorded pid is no longer running OR the lock is older than
 * TTL_MS (30 minutes by default). Which of the two do we trust?
 *
 *   - The TIMESTAMP is the primary signal, and the take-over message is phrased around it.
 *     `kill(pid, 0)` cannot distinguish "this process is still running" from "this process is
 *     gone and its pid has since been reused", so on its own it can only ever answer "alive"
 *     for a recycled pid — which would wedge the tool forever.
 *   - "pid not alive" is the SECONDARY signal: it is only believed when it is proof of death.
 *     When the pid IS live we fall back to the timestamp, so a recycled pid can neither block
 *     a genuinely dead holder forever nor let us stomp a live one early. A holder that really
 *     does overrun the cap is not stolen from silently — recovering prints a loud take-over
 *     line naming the holder and the reason.
 *
 * THE DEFECT THIS PRECEDENCE EXISTS TO PREVENT (`Date.parse(x) || 0`, one more time)
 * The age used to be computed as `typeof holder.at === 'number' ? holder.at : 0`, so a record
 * whose `at` was a STRING — a hand-written lock, an ISO timestamp — was silently read as epoch
 * 0, i.e. as infinitely old. Because "over the cap" alone authorises a take-over, that turned a
 * perfectly readable record into one that got stolen: a live holder of pid 26200 was taken over
 * with "the lock is 1791808015s old" — 1791808015 being the whole Unix timestamp, the signature
 * of `Date.now() - 0`. The tool had already read that holder's label/pid/host and confirmed the
 * pid was STILL RUNNING, and stole the lock anyway. "I cannot read the age" had become "the age
 * is infinite", which is the opposite meaning: unknown is not old.
 *
 * So the three cases are kept distinct instead of collapsed:
 *
 *   1. `at` readable (see readLockTimestamp) and inside the cap, pid live  -> not stale, refuse.
 *   2. `at` readable and over the cap, whatever the pid says              -> stale, take over.
 *      (A recycled pid must not make a dead holder look permanent; this is why the timestamp
 *      outranks "the pid looks alive".)
 *   3. `at` NOT readable -> the age is UNKNOWN.
 *        - a live pid    -> REFUSE, and say the age could not be determined. An unreadable age
 *                           must never, by itself, authorise stealing a live holder's lock.
 *        - a dead pid, or no usable holder record at all -> stale, take over. This is what
 *                           keeps a corrupt lock file from wedging the tool forever.
 *
 * The take-over message says WHICH of the three it was (old / holder gone / unreadable age), and
 * `describeHolder` prints `acquired=?` when the timestamp could not be read, so a reader is never
 * told "epoch 1970" about a holder that is simply unreadable.
 *
 * Take-over is not `unlink`-and-pray: the file is removed and the atomic create is retried, so
 * if another process wins the take-over race the loser re-reads the (now live) lock and fails
 * loudly naming the new holder. Both processes can never hold it.
 *
 * USAGE
 *   import { withMutationLock } from './mutation-lock.mjs'
 *
 *   const result = await withMutationLock(async () => { ...mutate, run, restore... },
 *                                        { label: 'tooling/mutation-check.mjs' })
 *
 * The lock is released on normal return, on a thrown error, and on SIGINT/SIGTERM.
 *
 * ENVIRONMENT (used by the tests; the defaults are the real thing)
 *   MUTATION_LOCK_PATH  lock file path (default: `tooling/.mutation-lock`)
 *   MUTATION_LOCK_TTL_MS  staleness cap in ms (default 30 minutes)
 */

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** Exit code for "another mutation harness holds the lock". Distinct from 1 (a thrown error). */
export const EXIT_LOCK_HELD = 2

/**
 * How long a lock may live before it is treated as abandoned. Generous on purpose: the unit
 * suite alone takes ~2.4s and the approval harness runs 61 mutants through two suites, so a
 * long-but-live run must never be stolen from. A stale lock costs 30 minutes of waiting at
 * worst, which is strictly better than ripping the lock away from a running process.
 */
const DEFAULT_TTL_MS = 30 * 60 * 1000

/** The default lock path is a sibling of this module, so every harness agrees on one file. */
function defaultLockPath() {
  return join(dirname(fileURLToPath(import.meta.url)), '.mutation-lock')
}

export function lockPath() {
  const fromEnv = process.env.MUTATION_LOCK_PATH
  return typeof fromEnv === 'string' && fromEnv.trim() !== '' ? fromEnv : defaultLockPath()
}

export function lockTtlMs() {
  const parsed = Number(process.env.MUTATION_LOCK_TTL_MS)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TTL_MS
}

/** Thrown when the lock is already held. `message` is meant to be printed verbatim. */
export class MutationLockHeld extends Error {
  constructor(message, holder) {
    super(message)
    this.name = 'MutationLockHeld'
    this.holder = holder ?? null
  }
}

/**
 * Is this pid running? Returns true, false, or `undefined` when the answer is not knowable.
 * `kill(pid, 0)` throws ESRCH for a dead pid and EPERM for a live one owned by somebody else —
 * EPERM is proof of life, so false is returned only on ESRCH.
 */
function processIsRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    if (error?.code === 'EPERM') return true
    return undefined
  }
}

/**
 * The smallest value that can honestly be read as epoch MILLISECONDS. A 10-digit number (or a
 * 10-digit numeric string) is epoch SECONDS — 1970 + 1.79e9s — and reading it as milliseconds
 * would report "1970-01-01" and hand out a take-over that nobody asked for. Anything that could
 * be seconds is therefore NOT readable as an acquisition time: a wrong unit in the safe
 * direction (refuse, or fall back to "the holder is gone") is the whole point of this file.
 */
const MIN_PLAUSIBLE_EPOCH_MS = 1e12 // 2001-09-09, in ms

/** Strip surrounding whitespace; returns '' for anything that is not a string. */
function trimmed(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * Read a record's `at` as epoch milliseconds, or answer `null` for "NOT READABLE".
 *
 * This is deliberately TYPE-TOLERANT in exactly two narrow ways, so that a record a human or
 * another tool wrote by hand is read through the NORMAL comparison instead of landing on the
 * unknown-age path:
 *
 *   - a numeric string of epoch milliseconds that is a plain integer ('1751...') is accepted;
 *   - a string that `Date.parse` accepts WHERE THE FINAL SEGMENT IS A TIME — i.e. an ISO/RFC
 *     3339 timestamp with an explicit offset or `Z` (`2026-10-12T12:26:55.2431579Z`), or a
 *     date-and-time (`2026-10-12 12:26:55`) — is accepted.
 *
 * Whatever makes it tolerant must NOT become "guess a number", so a value is refused (null) when:
 *   - it is a string `Date.parse` cannot parse, or `Date.parse` answers `NaN`;
 *   - it is a DATE-ONLY string (`2026-10-12`). `Date.parse` reads that as midnight UTC while a
 *     human almost certainly means local midnight, and either way it is nearly a day of
 *     ambiguity compared with a 30-minute cap. Refusing routes it to the unknown path, which is
 *     a refusal for a live holder instead of a guess;
 *   - it is a string with no timezone information at all (`2026-10-12T12:26:55`): "whose
 *     midnight" is exactly the unanswerable part;
 *   - the parsed value is a finite number below MIN_PLAUSIBLE_EPOCH_MS (the seconds-vs-ms unit
 *     trap described above);
 *   - it is a number that is not a finite integer, or anything at all other than a number or a
 *     string (booleans, objects, `Infinity`, `NaN`).
 *
 * Returning `null` is the ONLY way to say "unknown", and the caller must treat unknown as
 * unknown — never as epoch 0.
 */
function readLockTimestamp(holder) {
  if (holder === null || typeof holder !== 'object') return null
  const raw = holder.at

  if (typeof raw === 'number') {
    return Number.isSafeInteger(raw) && raw >= MIN_PLAUSIBLE_EPOCH_MS ? raw : null
  }

  const text = trimmed(raw)
  if (text === '') return null

  // A pure integer: epoch milliseconds, or the seconds unit trap. Nothing else is a number.
  if (/^\d+$/.test(text)) {
    const asNumber = Number(text)
    return Number.isSafeInteger(asNumber) && asNumber >= MIN_PLAUSIBLE_EPOCH_MS ? asNumber : null
  }

  // A date-and-time, but only with an explicit offset/Z, and never a bare date.
  const hasClockAndZone = /[T ]\d{1,2}:\d{2}/.test(text) && /(?:Z|z|[+-]\d{2}:?\d{2})$/.test(text)
  if (!hasClockAndZone) return null

  const parsed = Date.parse(text)
  return Number.isFinite(parsed) && parsed >= MIN_PLAUSIBLE_EPOCH_MS ? parsed : null
}

/** The lock file's content, as written by the current holder. */
function describeHolder(holder) {
  if (!holder) return 'unreadable lock file (no readable holder record)'
  const label = typeof holder.label === 'string' && holder.label !== '' ? holder.label : '(no label recorded)'
  const pid = Number.isInteger(holder.pid) ? holder.pid : '?'
  const host = typeof holder.host === 'string' && holder.host !== '' ? holder.host : '?'
  // `acquired=?` — never a fabricated 1970 date — when the timestamp cannot be read. Telling a
  // reader that an unreadable holder started in 1970 is the same lie that caused the defect.
  const atMs = readLockTimestamp(holder)
  const at = atMs === null ? '?' : new Date(atMs).toISOString()
  return `label=${label} pid=${pid} host=${host} acquired=${at}`
}

/** How old the lock is, for a message. Never invents an age for an unreadable record. */
function describeAge(ageMs) {
  return ageMs === null ? 'an undeterminable age' : `${Math.round(ageMs / 1000)}s old`
}

/**
 * Read the lock file and classify it. Never throws: an unreadable or malformed FILE is a STALE
 * lock, because it cannot name a live holder we would be obliged to respect.
 *
 * The precedence, in full (see the header for why each line is where it is):
 *   no file / unparseable file      -> stale
 *   no readable holder              -> stale  (nothing to respect; never wedge forever)
 *   `at` not readable, pid live     -> NOT stale: refuse, age undetermined
 *   `at` not readable, pid dead     -> stale  (holder gone)
 *   `at` readable, over the cap     -> stale  (even if the pid looks alive: recycled pid)
 *   `at` readable, inside the cap,
 *     pid dead                      -> stale  (holder gone)
 *   otherwise                       -> NOT stale
 */
function inspectLock(path) {
  let text
  try {
    text = readFileSync(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, stale: true, reason: 'no lock file' }
    return { exists: false, stale: true, reason: `lock file unreadable: ${error?.code ?? error?.message ?? error}` }
  }

  let holder = null
  try {
    const parsed = JSON.parse(text)
    if (parsed !== null && typeof parsed === 'object') holder = parsed
  } catch {
    holder = null
  }

  if (holder === null) {
    return { exists: true, stale: true, holder: null, reason: 'lock file is not a readable holder record' }
  }

  const atMs = readLockTimestamp(holder)
  const cap = lockTtlMs()
  const running = processIsRunning(holder.pid)

  // CASE 3 FIRST: the age is unknown. Unknown is NOT "infinitely old" — it is unknown, and the
  // only thing that may still free the lock is proof that the holder is gone.
  if (atMs === null) {
    if (running === true) {
      return {
        exists: true,
        stale: false,
        holder,
        reason:
          `the holder pid ${holder.pid} is still running and the lock's age could not be determined ` +
          `(the recorded acquisition time is missing or unreadable)`,
      }
    }
    if (running === false) {
      return {
        exists: true,
        stale: true,
        holder,
        reason: `the holder pid ${holder.pid} is no longer running (the lock's age could not be determined)`,
      }
    }
    return {
      exists: true,
      stale: true,
      holder,
      reason:
        `the holder pid ${holder.pid} cannot be checked and the lock's age could not be determined, ` +
        `so the record names no holder that can be respected`,
    }
  }

  // CASE 1/2: the age is readable. The timestamp outranks the pid, because a recycled pid can
  // only ever answer "alive" and a dead holder must not look permanent.
  const age = Date.now() - atMs
  const overCap = age > cap

  if (overCap) {
    return {
      exists: true,
      stale: true,
      holder,
      reason:
        running === true
          ? `the lock is ${describeAge(age)}, over the ${Math.round(cap / 1000)}s cap, so it is taken over even though the holder pid ${holder.pid} is still running`
          : `the lock is ${describeAge(age)}, over the ${Math.round(cap / 1000)}s cap`,
    }
  }
  if (running === false) {
    return {
      exists: true,
      stale: true,
      holder,
      reason: `the holder pid ${holder.pid} is no longer running`,
    }
  }
  return {
    exists: true,
    stale: false,
    holder,
    reason:
      running === true
        ? 'the holder pid is still running'
        : 'the holder pid cannot be checked, but the lock is inside the cap',
  }
}

/** Create the lock file atomically. Returns true on a win, false when somebody else holds it. */
function createLockAtomically(path, record) {
  try {
    writeFileSync(path, JSON.stringify(record), { flag: 'wx', encoding: 'utf8' })
    return true
  } catch (error) {
    if (error?.code === 'EEXIST') return false
    throw error
  }
}

/** Release only a lock this acquisition still owns, so we never delete somebody else's. */
function releaseLock(path, record) {
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return false
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    parsed.pid !== record.pid ||
    parsed.at !== record.at ||
    parsed.host !== record.host
  ) {
    return false
  }
  unlinkSync(path)
  return true
}

/**
 * Take the lock, or throw `MutationLockHeld` after at most `attempts` rounds. The retry loop
 * exists only for the stale take-over race: every round re-reads the file, so a process that
 * loses the race reports the new holder instead of looping.
 */
function acquireLock(path, label, attempts = 3) {
  mkdirSync(dirname(path), { recursive: true })

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const record = { pid: process.pid, at: Date.now(), host: hostname(), label }
    if (createLockAtomically(path, record)) return record

    const state = inspectLock(path)
    if (state.exists && !state.stale) {
      throw new MutationLockHeld(
        `another mutation harness is already running — refusing to start.\n` +
          `  holder: ${describeHolder(state.holder)}\n` +
          `  ${state.reason}.\n` +
          `  Do NOT run two mutation harnesses at the same time: each one rewrites a file under lib/ and\n` +
          `  verifies only its own restore, so two runs can leave a mutant APPLIED in the source tree\n` +
          `  while both report success. Wait for the running harness to finish, then start this one.`,
        state.holder,
      )
    }

    // Stale: take it over, loudly.
    console.warn(
      `[mutation-lock] taking over a stale lock (${state.reason}).\n` +
        `[mutation-lock] stale holder: ${describeHolder(state.holder)}`,
    )
    try {
      unlinkSync(path)
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error
    }
  }

  const state = inspectLock(path)
  throw new MutationLockHeld(
    `could not take the mutation lock at ${path} after 3 attempts — another process keeps winning it.\n` +
      `  current holder: ${describeHolder(state.holder)}`,
    state.holder,
  )
}

/**
 * The lock this process currently holds, or null. Module-level because a signal handler
 * cannot receive it as an argument.
 */
let activeLock = null

/** Release the lock this process holds, if any. Safe to call when nothing is held. */
function releaseCurrentLock() {
  const current = activeLock
  if (current === null) return
  activeLock = null
  try {
    if (!releaseLock(current.path, current.record)) {
      console.error(
        `[mutation-lock] the lock at ${current.path} is no longer ours; it was taken or removed while we held it. ` +
          `Left in place rather than deleted.`,
      )
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      console.error(`[mutation-lock] could not remove ${current.path}: ${error?.message ?? error}`)
    }
  }
}

/** Exported for a harness's own signal handler. See the ordering note on withMutationLock. */
export { releaseCurrentLock as releaseMutationLock }

/**
 * Run `fn` with the mutation lock held. Releases on return, on throw, and on SIGINT/SIGTERM.
 * Returns whatever `fn` returns. Throws `MutationLockHeld` when another harness holds it.
 *
 * SIGNAL HANDLER ORDERING, AND WHY A HARNESS SHOULD REGISTER ITS OWN FIRST
 * A harness that installs its own SIGINT/SIGTERM handler (every one of them does, to restore a
 * mutated source) and calls `process.exit` inside it would otherwise skip the release below.
 * Node runs handlers in registration order, so a harness that registers BEFORE calling this
 * function restores the source first and then exits — and the release still happens here.
 * A harness that registers afterwards should call `releaseMutationLock()` from its handler, or
 * simply let this function's own handler run by returning without exiting. The take-over path
 * (pid gone, or past the cap) means a lock left behind by a handler bug is recoverable, but it
 * would still cost the next run a 30-minute wait — so do not rely on that.
 */
export async function withMutationLock(fn, { label = 'unnamed mutation harness', path = lockPath() } = {}) {
  const record = acquireLock(path, label)
  activeLock = { path, record }

  // Registered only as a BACKSTOP: a harness that wants to restore a source must register its
  // own handler before calling this, and that one runs first.
  function onSignal(signal) {
    releaseCurrentLock()
    process.off(signal, onSignal)
    process.kill(process.pid, signal)
  }
  process.once('SIGINT', onSignal)
  process.once('SIGTERM', onSignal)

  try {
    return await fn()
  } finally {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    releaseCurrentLock()
  }
}
