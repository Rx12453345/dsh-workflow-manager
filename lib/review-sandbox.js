/**
 * Review sandbox: the reviewer must not be able to destroy the project.
 *
 * THE INCIDENT THIS MODULE EXISTS FOR
 * A `workflow_review` child created a **directory junction** under `%TEMP%` that
 * pointed at the project, then ran `fs.rmSync(junction, {recursive: true, force:
 * true})`. Node follows a junction on Windows, so the recursive delete emptied the
 * real workspace: git history, workflow state and the uncommitted work were lost.
 * The reviewer was not malicious — it was tidying up a scratch directory it had made.
 *
 * WHAT CANNOT BE ENFORCED FROM HERE
 * The probe result is recorded deliberately, because the design depends on it: a
 * child spawned by the subagents service inherits the PARENT's working directory and
 * file policy. Asking for `cwd = <temp copy>` does **not** move the child's sandbox
 * root — `process.cwd()` inside such a child still reports the real project, and a
 * write into the real project still succeeds (measured 2026-10-25 on this host).
 * A plugin cannot impose a read-only file policy on a child the host starts, so a
 * prompt that says "do not touch the project" is a request, not a mechanism.
 *
 * WHAT THIS MODULE DOES INSTEAD — THE REVIEW BECOMES TRANSACTIONAL
 *  1. SNAPSHOT before the child starts: a real (never a link) copy of the project in
 *     an isolated temp root, plus a canary file placed OUTSIDE that copy.
 *  2. POINT the reviewer at the copy and state the rules (the copy is disposable; no
 *     links; anything outside is off limits). This is defence in depth, not the guard.
 *  3. FENCE after the child finishes: re-scan the real project against the snapshot.
 *     A REVIEW THAT CHANGED THE PROJECT CANNOT PASS. Deletions are restorable and are
 *     restored from the snapshot before the tool returns; modifications and additions
 *     are reported rather than reverted (a concurrent human edit is not the reviewer's
 *     doing, and silently reverting it would be a second way to lose work).
 *  4. GUARDED DELETE of the copy: realpath-checked to be inside the temp root, refused
 *     if it is a reparse point or if it contains / equals the project, and never
 *     followed through a link. Then the canary must still exist.
 *  5. FAIL CLOSED: if the snapshot cannot be built (unreadable tree, links it cannot
 *     vouch for, size caps, a failed copy) no reviewer is started at all.
 *
 * The net effect on the incident: the recursive delete still empties the copy's
 * source, but the fence sees the missing paths and restores them byte-for-byte from
 * the snapshot, and the review is reported `contaminated` instead of PASS.
 *
 * @module src-12453345_-dsh-workflow/review-sandbox
 */

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'

/** Every snapshot lives under this prefix in the OS temp directory. */
export const SNAPSHOT_ROOT_PREFIX = 'dsh-review-'

/** The copy itself is always this subdirectory of the snapshot root. */
export const SNAPSHOT_WORK_DIRNAME = 'work'

/** The canary sits next to the copy, never inside it. */
export const SNAPSHOT_CANARY_NAME = 'canary.txt'

/**
 * The marker lives in the snapshot ROOT and is written before anything is copied. It is
 * what makes "delete this path" provable rather than assumed: the root is only removed
 * after this file has been read back and found to name this plugin's own snapshot.
 */
export const SNAPSHOT_MARKER_NAME = 'snapshot.json'

/** A project bigger than this is refused rather than half-snapshotted. */
export const DEFAULT_MAX_BYTES = 512 * 1024 * 1024

/** ...and so is one with more entries than this. */
export const DEFAULT_MAX_FILES = 20000

/**
 * The content-hash budget: how many bytes of file content the fence will digest.
 *
 * IT EQUALS THE COPY CAP, AND THAT IS THE POINT. A review already copies the whole project,
 * and hashing is far cheaper than copying, so there is no reason to verify less content than
 * the snapshot is willing to hold. The old 64 MiB budget made the fence fall back to
 * size+mtime for the residue — and a fallback that only *reports* something weaker is exactly
 * what let a same-length edit to an unhashed file (`533 of 999` entries in this project)
 * pass as clean: measured by the 2026-10-25 security review, which tampered a 65 MiB fixture
 * and kept `clean: true`. With the budget at the copy cap, every project the snapshot accepts
 * is fully content-hashed.
 *
 * A caller may still lower it (tests do, to reach the fallback deliberately); a lowered
 * budget can make a review NOT pass — never quietly pass on weaker evidence.
 */
export const DEFAULT_HASH_BUDGET = DEFAULT_MAX_BYTES

/**
 * What the snapshot does not copy unless the project says otherwise.
 *
 * THIS IS A DEFAULT EXCLUSION, NOT A POLICY. `node_modules` is regenerable, enormous and never
 * reviewed; a real review of this repository could not run at all on the old hard-coded cap
 * because of it. The cost is real — the fence cannot see a change under an excluded path — so
 * every exclusion is reported in the isolation evidence and in the review report. Only this
 * entry plus what the user declares is excluded: `.git` is never excluded, because the fence is
 * both the detection and the restore basis for the project's history.
 */
export const DEFAULT_SNAPSHOT_EXCLUDE = Object.freeze(['node_modules'])

/**
 * The durable pending-cleanup list, in the OS temp directory.
 *
 * THE DELETE STILL RUNS FIRST, AS IT ALWAYS DID. This list only records what the bounded retry
 * could NOT remove (a reviewer's own `npm test` children still holding the copy), so a later
 * sweep can finish the job instead of leaving a temp root for a human to find days later.
 */
export const SNAPSHOT_CLEANUP_STATE_NAME = 'dsh-workflow-review-cleanup.json'

/** The bounded retry window for a pending cleanup: every 30 s for up to 10 minutes. */
export const SNAPSHOT_CLEANUP_RETRY = Object.freeze({ intervalMs: 30_000, windowMs: 10 * 60_000 })

/**
 * How long a REGISTERED pending root waits before the sweep may treat it as orphaned.
 *
 * WHY A RELEASE TIME IS NEEDED AT ALL. The snapshot marker records the HOST's pid — the process
 * that created the copy — and the sweep keeps any root whose recorded owner is alive. But a
 * failed cleanup is registered BY THAT SAME HOST: the owner is not dead, it has merely finished
 * with the snapshot and could not delete it (a reviewer's `npm test` children held it). Without a
 * release record the retry would keep refusing its own leftover until the host process exited,
 * i.e. the 30-second in-process retry could never succeed and the pre-next-review sweep was dead
 * code. So registration writes `releasedAt`, and after this short grace the sweep stops requiring
 * the pid to be dead — the grace itself is the evidence that the releasing handle had time to let
 * go. A root with NO release record (an older build's leftover, or a hand-written entry) gets no
 * such trust: it still needs a dead marker pid.
 */
export const SNAPSHOT_CLEANUP_RELEASE_GRACE_MS = 15_000

/** The number of excluded paths reported in full; beyond it the report says how many more. */
const EXCLUDE_REPORT_CAP = 50

/** The top directories named by an over-cap error. */
const OVER_CAP_DIRECTORY_COUNT = 5


/**
 * How long the guarded delete keeps retrying when a reviewer's own child processes still hold
 * the copy.
 *
 * MEASURED, AND WHY IT GREW (P3-5). A live review whose reviewer had run `npm test` left those
 * children running, and the then-current 5 x 120 ms window lost to them. Node's `rmSync` backs
 * off LINEARLY (`retries * retryDelay`), so that window was 120+240+360+480+600 = 1.8 s, not the
 * 600 ms it looked like. 8 x 250 ms gives 250+500+...+2000 = 9.0 s — long enough for a test
 * runner to exit, still BOUNDED, so a genuinely stuck handle becomes a reported refusal with a
 * path to delete by hand instead of a hang. The same window is used for the snapshot root.
 */
export const SNAPSHOT_REMOVE_RETRY = Object.freeze({ maxRetries: 8, retryDelay: 250 })

/**
 * GIT'S OWN BOOKKEEPING — paths a READ-ONLY git command legitimately rewrites.
 *
 * MEASURED, TWICE, AND IT COST A WHOLE REVIEW. The reviewer prompt tells the reviewer to run
 * `git status --porcelain`, which refreshes the index: `.git/index` is rewritten with new stat
 * data on every such call. A human pushing to the remote while a review is running appends to
 * `.git/logs/refs/remotes/...`. Both were reported as CONTAMINATED against reviews that had
 * changed nothing in the project (2026-10-25, the first `p0` attempt: a remote-tracking reflog
 * written at 22:39:50 by the human's own push).
 *
 * So these paths are compared STRUCTURALLY — an entry that disappears still counts as a
 * deletion, a kind change still counts as a modification, and a deletion is still restored from
 * the snapshot — but their CONTENT (and therefore size and mtime, which move with it) is not
 * evidence of contamination. Everything that holds the project's work stays fully content-hashed:
 * `HEAD`, `config`, `refs/heads/**`, `objects/**`, `packed-refs`.
 */
const GIT_BOOKKEEPING_FILES = Object.freeze([
  '.git/index',
  '.git/index.lock',
  '.git/FETCH_HEAD',
  '.git/ORIG_HEAD',
  '.git/AUTO_MERGE',
  '.git/COMMIT_EDITMSG',
  '.git/MERGE_MSG',
])

/** Whether a relative key is git bookkeeping a read-only git command may rewrite. */
function gitBookkeeping(relKey) {
  if (GIT_BOOKKEEPING_FILES.includes(relKey)) return true
  if (!relKey.startsWith('.git/')) return false
  const rest = relKey.slice('.git/'.length)
  // Reflogs grow on push/fetch/commit; remote-tracking refs are a cache of the remote, not the
  // project's own history. Transient lock files exist only while a git command runs.
  if (rest === 'logs' || rest.startsWith('logs/')) return true
  if (rest === 'refs/remotes' || rest.startsWith('refs/remotes/')) return true
  if (rest.endsWith('.lock')) return true
  return false
}

/** Build a failure record. */
function failure(reason, detail = '') {
  return { ok: false, reason, detail }
}

/**
 * Whether `child` is strictly below `parent`.
 *
 * @param child - candidate path.
 * @param parent - supposed ancestor.
 * @returns true when the relationship holds.
 */
function isInside(child, parent) {
  const rel = relative(parent, child)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * How a reparse point is actually detected on Windows.
 *
 * MEASURED, AND THE WHOLE MODULE DEPENDS ON IT (Node v24.18.0, Windows):
 *   - `lstatSync(junction).isSymbolicLink()` is **false** — a junction looks like a directory;
 *   - `readlinkSync(junction)` throws EINVAL;
 *   - `realpathSync(junction)` returns the junction path itself, so a containment check built
 *     on it silently passes for a link that points at the project;
 *   - `realpathSync.native(junction)` DOES resolve to the target;
 *   - `readdirSync(parent, {withFileTypes:true})`'s `Dirent.isSymbolicLink()` IS true for it.
 *
 * So detection must come from the Dirent of the parent listing, and containment from the
 * NATIVE realpath. Using `lstat` and the JS `realpath` here would rebuild the exact hole the
 * incident went through.
 *
 * @param parent - directory to list.
 * @param name - entry name inside it.
 * @param absolute - full path of the candidate.
 * @returns true for a symlink, junction or any other reparse point.
 */
function isReparsePoint(parent, name, absolute) {
  try {
    const entry = readdirSync(parent, { withFileTypes: true }).find(candidate => candidate.name === name)
    if (entry !== undefined && entry.isSymbolicLink()) return true
  } catch {
    // Fall through to the native comparison below.
  }
  try {
    // THE FALLBACK MUST NOT COMPARE A RESOLVED PATH WITH ITS OWN SPELLING. That is the same
    // mistake the scan made: on an 8.3 or case-aliased path (`C:\Users\RUNNER~1\...`) every
    // ordinary entry resolves to a different spelling and looks like a link. Ask instead
    // whether the entry sits in its parent's canonical location under its own name — which a
    // junction to somewhere else does not.
    const parentReal = nativeRealpath(dirname(absolute))
    return !samePath(nativeRealpath(absolute), join(parentReal, basename(absolute)))
  } catch {
    // Unresolvable path: treat as a link so the callers refuse it rather than walk it.
    return true
  }
}

/**
 * A path with every link resolved by the OS (not by Node's JS implementation, which leaves
 * junctions alone on Windows — see {@link isReparsePoint}).
 */
function nativeRealpath(path) {
  return realpathSync.native(path)
}

/** Normalise a walk-produced relative path to forward slashes for stable reporting. */
function key(relPath) {
  return relPath.split('\\').join('/')
}

/**
 * Whether two paths name the same location.
 *
 * Windows is case-insensitive and the native realpath may return a canonical spelling that
 * differs in case from the input; a case-sensitive comparison would report an ordinary
 * directory as a reparse point and refuse every review.
 */
function samePath(a, b) {
  const left = resolve(a)
  const right = resolve(b)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/**
 * Normalise a declared exclusion to the form the scan compares.
 *
 * The configuration reader already validates entries; this repeats the normalisation so a
 * DIRECT caller (a test, or a future caller of this module) cannot smuggle in a spelling the
 * comparison would never match — an exclusion that matches nothing is worse than none, because
 * the report would claim the path was excluded.
 *
 * @param values - candidate entries.
 * @returns canonical entries, in declaration order, without duplicates.
 */
function normaliseExclusions(values) {
  const out = []
  for (const value of Array.isArray(values) ? values : []) {
    if (typeof value !== 'string') continue
    const trimmed = value.trim().replace(/\\/g, '/').replace(/^\.\//, '')
    if (trimmed === '' || trimmed === '.') continue
    if (trimmed.startsWith('/') || /^[A-Za-z]:/.test(trimmed)) continue
    if (trimmed.includes('*') || trimmed.includes('?')) continue
    const parts = trimmed.split('/').filter(part => part !== '')
    if (parts.length === 0 || parts.includes('..')) continue
    // `.git` IS NOT EXCLUDABLE, EVEN BY A DIRECT CALLER. The fence is both the detection and the
    // restore basis for the project's history; dropping the entry here means the module's own
    // record can never claim a `.git` exclusion it silently applied.
    if (isGitMetadataEntry(parts.join('/'))) continue
    const entry = parts.join('/')
    if (!out.includes(entry)) out.push(entry)
  }
  return out
}

/**
 * Whether an exclusion entry names git metadata (its FIRST segment is `.git`).
 *
 * Only the first segment: `.git` and `.git/**` are the history the fence depends on. A nested
 * directory that happens to be called `.git` inside a submodule is not what this invariant is
 * about, and a case-insensitive first segment is the safe reading on Windows.
 *
 * @param entry - a normalised (or raw) exclusion path.
 * @returns true when the entry would exclude git metadata.
 */
function isGitMetadataEntry(entry) {
  if (typeof entry !== 'string') return false
  const first = entry.replace(/\\/g, '/').replace(/^\.\//, '').split('/')[0]
  return first.toLowerCase() === '.git'
}

/**
 * Whether a project-relative path is excluded from the snapshot.
 *
 * AN ENTRY WITHOUT A SLASH MATCHES THAT NAME AT ANY DEPTH, so `node_modules` also covers
 * `packages/web/node_modules` — the spelling npm workspaces produce. An entry WITH a slash is a
 * path prefix, so `build/cache` excludes that directory and nothing else.
 *
 * @param relKey - normalised project-relative path.
 * @param exclude - canonical exclusions.
 * @returns true when the path is excluded.
 */
function isExcluded(relKey, exclude) {
  if (!Array.isArray(exclude) || exclude.length === 0) return false
  const segments = relKey.split('/')
  for (const entry of exclude) {
    if (entry.includes('/')) {
      if (relKey === entry || relKey.startsWith(`${entry}/`)) return true
      continue
    }
    if (segments.includes(entry)) return true
  }
  return false
}

/** A byte count as a short human string, for an error a human has to act on. */
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return 'unknown size'
  const mb = bytes / (1024 * 1024)
  if (mb >= 1) return `${mb.toFixed(1)} MB`
  return `${Math.round(bytes / 1024)} KB`
}

/**
 * The cap in MEGABYTES exactly as configured, for every place it is reported.
 *
 * THE VALUE MUST BE THE SAME ONE THE READER SET. `Math.round` turned a configured 0.5 MB into
 * "over the 1 MB cap" and recorded `caps.maxMb: 1`, so the evidence and the remedy named a cap
 * the user never wrote — and the remedy is "raise this setting". One decimal was still a display
 * lie for the fractional caps the reader accepts: 0.25 printed "0.3" and 0.04 printed "0".
 *
 * THREE SIGNIFICANT DIGITS, TRAILING ZEROS TRIMMED. That keeps a user-written 0.25 as "0.25"
 * and 0.04 as "0.04" while a whole 512 still prints as "512" and 0.5 does not become "0.500".
 * The limit itself is enforced in bytes (`bytes > maxBytes`) and `caps.maxMb` carries the exact
 * configured number, so only this DISPLAY is rounded.
 *
 * @param bytes - the cap in bytes.
 * @returns `512` for a whole number of megabytes, `0.25` for a fractional one.
 */
export function formatMegabytes(bytes) {
  const mb = Number.isFinite(bytes) ? bytes / (1024 * 1024) : Number.NaN
  if (!Number.isFinite(mb) || mb < 0) return '?'
  if (mb === 0) return '0'
  // WHOLE MEGABYTE CAPS ARE PRINTED EXACTLY. Three significant digits would turn 1024 into
  // "1020" and 2048 into "2050" — the same "a cap the user never wrote" lie that one decimal
  // produced for 0.25. The fractional rule below is only for values that cannot be written as a
  // whole number of megabytes.
  if (Number.isInteger(mb)) return String(mb)
  // `Number(x.toPrecision(3))` is three significant digits with the trailing zeros gone, and it
  // also normalises the exponent notation `toPrecision` uses for large fractional caps.
  return String(Number(mb.toPrecision(3)))
}

/**
 * Measure the project's TOP-LEVEL directories, so an over-cap refusal can say WHERE the bytes
 * are instead of printing one number.
 *
 * BEST EFFORT AND BOUNDED: this runs only on the refusal path, never on a snapshot that is
 * about to succeed, and it stops after `maxEntries` entries so a pathological tree cannot turn
 * one refusal into a long scan. Links are not followed (the same reason the real scan refuses
 * them). `complete:false` is reported rather than hidden.
 *
 * @param rootReal - the canonical project root.
 * @param options - `{ exclude, maxEntries }`.
 * @returns `{ rows: [{ path, bytes, entries }], total, complete }`.
 */
function summariseDirectories(rootReal, options = {}) {
  const exclude = Array.isArray(options.exclude) ? options.exclude : []
  const maxEntries = Number.isInteger(options.maxEntries) && options.maxEntries > 0
    ? options.maxEntries
    : 100_000
  const rows = []
  let total = 0
  let visited = 0
  let complete = true

  let top
  try {
    top = readdirSync(rootReal, { withFileTypes: true })
  } catch (error) {
    return { rows, total, complete: false, reason: `${error?.code ?? error}` }
  }

  for (const entry of top) {
    const abs = join(rootReal, entry.name)
    if (entry.isSymbolicLink()) continue
    if (isExcluded(entry.name, exclude)) continue
    let stat
    try {
      stat = statSync(abs)
    } catch {
      complete = false
      continue
    }
    if (!entry.isDirectory()) {
      total += stat.size
      continue
    }
    const row = { path: entry.name, bytes: 0, entries: 0 }
    const queue = [{ abs, rel: entry.name }]
    while (queue.length > 0) {
      const current = queue.pop()
      let names
      try {
        names = readdirSync(current.abs, { withFileTypes: true })
      } catch {
        complete = false
        continue
      }
      for (const child of names) {
        visited += 1
        if (visited > maxEntries) {
          complete = false
          queue.length = 0
          break
        }
        const childAbs = join(current.abs, child.name)
        const childRel = `${current.rel}/${child.name}`
        if (child.isSymbolicLink()) continue
        if (isExcluded(childRel, exclude)) continue
        let childStat
        try {
          childStat = statSync(childAbs)
        } catch {
          complete = false
          continue
        }
        if (child.isDirectory()) {
          row.entries += 1
          queue.push({ abs: childAbs, rel: childRel })
        } else if (child.isFile()) {
          row.entries += 1
          row.bytes += childStat.size
          total += childStat.size
        }
      }
    }
    rows.push(row)
  }

  return { rows, total, complete }
}

/** The five largest directories by a numeric key, as `path (value)` strings. */
function topDirectories(rows, key, format) {
  return [...rows]
    .sort((left, right) => (right[key] ?? 0) - (left[key] ?? 0))
    .slice(0, OVER_CAP_DIRECTORY_COUNT)
    .filter(row => (row[key] ?? 0) > 0)
    .map(row => `${row.path} (${format(row[key])})`)
}

/**
 * Hash a file's bytes, or return null when it cannot be read.
 *
 * A hash that cannot be taken is recorded as "not hashed" rather than as an empty
 * digest: an empty digest would compare equal to another failed read and report a
 * change-free project that was never actually verified.
 */
function hashFile(absolute) {
  try {
    return createHash('sha256').update(readFileSync(absolute)).digest('hex')
  } catch {
    return null
  }
}

/**
 * Walk a project and return what the fence needs to compare two moments in time.
 *
 * Links are NOT descended into. A link is recorded as its own entry, and its target is
 * checked instead: a link that resolves outside the project is refused, because copying
 * it would drag foreign content into the snapshot and restoring it could recreate a path
 * this plugin has no business writing. A link that resolves to its own ancestor is
 * refused too — dereferencing it would recurse.
 *
 * @param root - the real project directory (already realpath'd).
 * @param options - size/file/hash caps.
 * @returns a scan record, or a failure record.
 */
function scanProject(root, options = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  const hashBudget = options.hashBudget ?? DEFAULT_HASH_BUDGET
  // ABSENT MEANS THE DEFAULT EXCLUSION; AN EXPLICIT EMPTY LIST MEANS EXCLUDE NOTHING. The
  // difference is load-bearing: a project that wants the whole tree verified must be able to ask
  // for it, and a caller that says nothing gets the shipped behaviour rather than total coverage
  // it did not ask for.
  const exclude = Array.isArray(options.exclude)
    ? normaliseExclusions(options.exclude)
    : [...DEFAULT_SNAPSHOT_EXCLUDE]

  // THE ROOT IS CANONICALISED ONCE, AND EVERY CHILD IS JUDGED AGAINST IT.
  //
  // Comparing each child's native realpath with its OWN spelling looked reasonable and was
  // wrong: on a machine whose %TEMP% is an 8.3 short path (`C:\Users\RUNNER~1\...`, which is
  // what GitHub's Windows runners use) or whose path differs in letter case, the resolved
  // form legitimately differs from the input and every directory looked like a reparse point.
  // Measured on CI: 50 failures, every review refusing with "it is a reparse point the
  // directory listing did not flag". The question a scan actually needs answered is
  // "does this resolve outside the tree I am scanning?", and that needs one canonical root.
  let rootReal
  try {
    rootReal = nativeRealpath(root)
  } catch (error) {
    return failure(
      `the reviewer snapshot cannot be taken: ${root} cannot be resolved (${error?.code ?? error})`,
    )
  }

  const entries = new Map()
  let bytes = 0
  let hashedBytes = 0
  let hashed = 0
  let unhashed = 0
  let links = 0
  const excludedRows = []
  let excludedTotal = 0

  const queue = [{ abs: rootReal, rel: '' }]
  while (queue.length > 0) {
    const current = queue.pop()

    let names
    try {
      names = readdirSync(current.abs, { withFileTypes: true })
    } catch (error) {
      return failure(
        `the reviewer snapshot cannot be taken: ${key(current.rel) || '.'} could not be read (${error?.code ?? error})`,
        'A project that cannot be read in full cannot be restored, so no review runs.',
      )
    }

    for (const entry of names) {
      const abs = join(current.abs, entry.name)
      const rel = current.rel === '' ? entry.name : join(current.rel, entry.name)
      const relKey = key(rel)

      // AN EXCLUDED PATH IS NOT SCANNED, NOT COPIED AND NOT VERIFIED, and every one of them is
      // recorded so the report can say what the fence cannot see. This is checked BEFORE the
      // entry cap: an excluded directory is not copied, so it must not consume the budget that
      // exists to bound the copy.
      if (isExcluded(relKey, exclude)) {
        excludedTotal += 1
        if (excludedRows.length < EXCLUDE_REPORT_CAP) {
          excludedRows.push({ path: relKey, kind: entry.isDirectory() ? 'dir' : 'file' })
        }
        continue
      }

      if (entries.size >= maxFiles) {
        const usage = summariseDirectories(rootReal, { exclude })
        return failure(
          `the reviewer snapshot is over the ${maxFiles}-entry cap (${entries.size} entries so far, ` +
            `${formatBytes(bytes)} of file content)`,
          overCapDetail({
            usage,
            by: 'entries',
            capName: 'maxFiles',
            capValue: String(maxFiles),
            exclude,
          }),
        )
      }

      // LINKS ARE JUDGED FROM THE DIRENT, NEVER FROM `lstat`. On Windows `lstat` reports a
      // junction as an ordinary directory, so a scan that trusted it would descend through
      // the link, copy foreign content, and later point a recursive delete at a tree this
      // plugin never chose. See `isReparsePoint` for the measurements.
      if (entry.isSymbolicLink()) {
        links += 1
        let target
        try {
          target = nativeRealpath(abs)
        } catch (error) {
          return failure(
            `the reviewer snapshot refuses ${relKey}: it is a link whose target cannot be resolved (${error?.code ?? error})`,
            'A dangling or looping link cannot be copied as a real path, so it cannot be restored either.',
          )
        }
        if (!isInside(target, rootReal)) {
          return failure(
            `the reviewer snapshot refuses ${relKey}: it is a link that resolves outside the project (${target})`,
            'Copying it would pull foreign content into the snapshot; restoring it would write outside the project.',
          )
        }
        const targetStat = statSync(target)
        if (targetStat.isDirectory() && (samePath(target, rootReal) || isInside(current.abs, target))) {
          return failure(
            `the reviewer snapshot refuses ${relKey}: it is a link to its own ancestor (${target})`,
            'Dereferencing it while copying would recurse without bound.',
          )
        }
        entries.set(relKey, { kind: 'link', target })
        continue
      }

      let stat
      try {
        stat = statSync(abs)
      } catch (error) {
        return failure(
          `the reviewer snapshot cannot be taken: ${relKey} could not be inspected (${error?.code ?? error})`,
          'An entry that cannot be inspected cannot be restored, so no review runs.',
        )
      }

      if (entry.isDirectory()) {
        // SECOND GATE: a directory the listing did not flag as a link must still not leave the
        // tree being copied. Judged by CONTAINMENT against the canonical root, not by comparing
        // the child's resolved path with its own spelling — that comparison misfired on every
        // 8.3/case-alias path and refused reviews wholesale (see the note above `rootReal`).
        let resolvedChild
        try {
          resolvedChild = nativeRealpath(abs)
        } catch (error) {
          return failure(
            `the reviewer snapshot refuses ${relKey}: it cannot be resolved (${error?.code ?? error})`,
            'A directory whose target cannot be resolved cannot be copied or restored faithfully.',
          )
        }
        if (!isInside(resolvedChild, rootReal)) {
          return failure(
            `the reviewer snapshot refuses ${relKey}: it resolves outside the snapshot root (${resolvedChild})`,
            'A directory the listing did not flag as a link still must not escape the tree being copied.',
          )
        }
        entries.set(relKey, { kind: 'dir' })
        queue.push({ abs, rel })
        continue
      }

      if (!entry.isFile()) {
        // A device/FIFO/socket cannot be reproduced by a file copy; the fence cannot
        // promise to restore it, so the snapshot is refused rather than weakened.
        return failure(
          `the reviewer snapshot refuses ${relKey}: it is not a regular file or directory`,
          'Only ordinary files and directories can be copied and restored faithfully.',
        )
      }

      bytes += stat.size
      if (bytes > maxBytes) {
        const usage = summariseDirectories(rootReal, { exclude })
        return failure(
          `the reviewer snapshot is over the ${formatMegabytes(maxBytes)} MB cap ` +
            `(${formatBytes(bytes)} of file content, and ${relKey} pushed it over)`,
          overCapDetail({
            usage,
            by: 'bytes',
            capName: 'maxMb',
            capValue: formatMegabytes(maxBytes),
            exclude,
          }),
        )
      }

      let hash = null
      if (hashedBytes + stat.size <= hashBudget) {
        hash = hashFile(abs)
        if (hash === null) {
          unhashed += 1
        } else {
          hashed += 1
          hashedBytes += stat.size
        }
      } else {
        unhashed += 1
      }

      entries.set(relKey, { kind: 'file', size: stat.size, mtimeMs: stat.mtimeMs, hash })
    }
  }

  return {
    ok: true,
    root,
    entries,
    bytes,
    hashed,
    unhashed,
    links,
    files: entries.size,
    exclude,
    excluded: { rows: excludedRows, total: excludedTotal, truncated: excludedTotal > excludedRows.length },
  }
}

/**
 * The detail line for an over-cap refusal: WHERE the bytes are, and what a human can do.
 *
 * ONE NUMBER IS NOT ACTIONABLE. "Over the 512 MB cap" leaves the reader to guess which directory
 * did it, and the guess is usually the one that is not. The top directories are measured (best
 * effort), both levers are named with their CURRENT values, and the visibility of an exclusion is
 * stated so choosing it is an informed trade rather than a silent blind spot.
 *
 * @param options - `{ usage, by, capName, capValue, exclude }`.
 * @returns one sentence naming where the weight is and the remedy.
 */
function overCapDetail(options) {
  const { usage, by, capName, capValue, exclude } = options
  const rows = Array.isArray(usage?.rows) ? usage.rows : []
  const label = by === 'bytes' ? 'Largest directories' : 'Directories with the most entries'
  const formatted = by === 'bytes'
    ? topDirectories(rows, 'bytes', formatBytes)
    : topDirectories(rows, 'entries', value => `${value} entries`)
  const where = formatted.length > 0
    ? `${label}: ${formatted.join(', ')}${usage?.complete === false ? ' (partial scan: the tree could not be fully measured)' : ''}.`
    : 'No single directory dominates; the size is spread across the root files.'
  const excluded = Array.isArray(exclude) && exclude.length > 0 ? exclude.join(', ') : '(none)'
  return (
    `${where} Remedy: raise review.snapshot.${capName} (currently ${capValue}) in the project's ` +
    `.dsh/workflow.yml, or add one of those directories to review.snapshot.exclude (currently ` +
    `${excluded}) so it is not snapshotted. An excluded path is NOT verified: every exclusion is ` +
    'reported in the isolation evidence.'
  )
}

/**
 * Build the reviewer's isolated workspace.
 *
 * Ordering matters: the project is scanned and the links are judged BEFORE anything is
 * copied, because a copy that follows an escaping link has already read content the
 * snapshot is not allowed to contain.
 *
 * @param projectDir - the real project under review.
 * @param options - size/file/hash caps, plus `tempRoot`: where the snapshot root is created
 *   (defaults to the OS temp directory). `tempRoot` is a TEST SEAM for exercising aliased
 *   paths (8.3 short names, differing letter case) that would otherwise be unreproducible on
 *   a developer machine; it must be an existing directory and it is validated as one. The
 *   default stays the OS temp directory, which is what the module's invariant describes.
 * @returns a snapshot record (with `workDir`), or a failure record.
 */
export function createReviewSnapshot(projectDir, options = {}) {
  if (typeof projectDir !== 'string' || projectDir === '') {
    return failure('no project directory was given, so no reviewer workspace can be isolated')
  }

  let projectRoot
  try {
    // NATIVE realpath. The JS implementation leaves a junction unresolved on Windows, so a
    // project reached through one would be recorded under the link's spelling while the
    // contained-location checks reason about a different string.
    projectRoot = nativeRealpath(resolve(projectDir))
  } catch (error) {
    return failure(
      `the reviewer workspace cannot be isolated: ${projectDir} cannot be resolved (${error?.code ?? error})`,
      'Nothing to snapshot means nothing to point the reviewer at.',
    )
  }

  let projectStat
  try {
    projectStat = statSync(projectRoot)
  } catch (error) {
    return failure(`the reviewer workspace cannot be isolated: ${error?.code ?? error}`)
  }
  if (!projectStat.isDirectory()) {
    return failure('the reviewer workspace cannot be isolated: the project path is not a directory')
  }
  // THE PROJECT PATH MUST NOT ITSELF BE A LINK. `nativeRealpath` above resolved it, so an
  // ordinary directory resolves to itself; a path that still resolves elsewhere means the
  // OS replaced or redirected it between the two calls, which is not a tree worth copying.
  if (!samePath(nativeRealpath(projectRoot), projectRoot)) {
    return failure(
      'the reviewer workspace cannot be isolated: the project path is itself a link/reparse point',
      'Point the review at the real directory, not at a junction.',
    )
  }

  const scan = scanProject(projectRoot, options)
  if (!scan.ok) return scan

  // THE CONFIGURED EXCLUSIONS ARE NORMALISED ONCE AND CARRIED BY THE RECORD, so the fence (which
  // runs later, on the same project) excludes exactly what the snapshot excluded. A fence that
  // re-derived them could compare a different tree than the one that was copied.
  const exclude = scan.exclude
  // THE EXACT CONFIGURED VALUE, IN MEGABYTES. A fractional cap is legal and the evidence must
  // record the number the user wrote, not a rounded one (see `formatMegabytes`).
  const maxMb = (options.maxBytes ?? DEFAULT_MAX_BYTES) / (1024 * 1024)
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES

  let rootDir
  try {
    // Where the snapshot lives is normally the OS temp directory. `tempRoot` exists so a test
    // can put it on an ALIASED spelling of that path (8.3 short name, different letter case) —
    // the condition GitHub's Windows runners have and the one that made every review refuse
    // before containment replaced exact-spelling comparison.
    const parent = typeof options.tempRoot === 'string' && options.tempRoot !== '' ? options.tempRoot : tmpdir()
    // VALIDATED, NOT TRUSTED. An option that silently falls back would hide a caller mistake,
    // and a snapshot outside a real directory cannot be cleaned up by the delete guards.
    if (parent !== tmpdir() && !statSync(parent).isDirectory()) {
      return failure(`the reviewer workspace cannot be isolated: tempRoot ${parent} is not a directory`)
    }
    rootDir = mkdtempSync(join(parent, SNAPSHOT_ROOT_PREFIX))
  } catch (error) {
    return failure(`the reviewer workspace cannot be isolated: temp directory creation failed (${error?.code ?? error})`)
  }

  const workDir = join(rootDir, SNAPSHOT_WORK_DIRNAME)
  const canaryPath = join(rootDir, SNAPSHOT_CANARY_NAME)
  const markerPath = join(rootDir, SNAPSHOT_MARKER_NAME)

  try {
    writeFileSync(
      markerPath,
      // THE MARKER IS ALSO THE JANITOR'S PROOF. `pid` and `createdAt` were added so a sweep can
      // tell "the owner of this snapshot is gone" from "the owner is still working" — a
      // directory that merely looks old is never enough to delete it.
      `${JSON.stringify(
        {
          plugin: 'dsh-workflow',
          kind: 'review-snapshot',
          projectDir: projectRoot,
          pid: process.pid,
          createdAt: new Date().toISOString(),
          at: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
    )
    // `dereference: true` turns the in-project links the scan allowed into real files,
    // so the snapshot itself contains no link that a future delete could follow.
    // THE FILTER MUST EXCLUDE EXACTLY WHAT THE SCAN EXCLUDED, or the copy and the fence would
    // describe two different trees — and an excluded `node_modules` would be copied anyway.
    cpSync(projectRoot, workDir, {
      recursive: true,
      dereference: true,
      force: true,
      filter: source => {
        const relativeSource = relative(projectRoot, source)
        if (relativeSource === '') return true
        if (relativeSource.startsWith('..') || isAbsolute(relativeSource)) return true
        return !isExcluded(key(relativeSource), exclude)
      },
    })
    writeFileSync(canaryPath, `canary for ${projectRoot}\n`)
  } catch (error) {
    // The snapshot is unusable; remove only the temp root whose path we just created.
    try {
      rmSync(rootDir, { recursive: true, force: true })
    } catch {
      // Leaving a partial temp directory behind is strictly better than throwing here.
    }
    return failure(
      `the reviewer workspace could not be copied (${error?.code ?? error})`,
      'No reviewer starts without a snapshot, because the project could not be restored afterwards.',
    )
  }

  // A copy that still contains a link would give a future delete something to follow.
  // NO EXCLUSION HERE: the copy itself must be inspected in full, because a link planted in an
  // excluded directory would still be a target a recursive delete could follow.
  const copied = scanProject(workDir, { maxBytes: Infinity, maxFiles: Infinity, hashBudget: 0, exclude: [] })
  if (!copied.ok) {
    discardReviewSnapshot(
      { rootDir, workDir, canaryPath, projectDir: projectRoot },
      { statePath: options.statePath },
    )
    return failure('the reviewer copy could not be verified', copied.reason)
  }
  if (copied.links > 0) {
    discardReviewSnapshot(
      { rootDir, workDir, canaryPath, projectDir: projectRoot },
      { statePath: options.statePath },
    )
    return failure(
      `the reviewer copy still contains ${copied.links} link(s) after dereferencing`,
      'A copy with links is exactly what caused the data loss; refusing is the safe outcome.',
    )
  }

  return {
    ok: true,
    projectDir: projectRoot,
    rootDir,
    workDir,
    canaryPath,
    markerPath,
    baseline: scan.entries,
    files: scan.files,
    bytes: scan.bytes,
    hashed: scan.hashed,
    unhashed: scan.unhashed,
    links: scan.links,
    contentHashed: scan.unhashed === 0,
    // THE EXCLUSION EVIDENCE TRAVELS WITH THE SNAPSHOT. The fence reads it from here; the review
    // report prints it. Nothing about "what was not copied or verified" may stay inside this
    // module, because the reviewer's fence is exactly the thing whose coverage is being narrowed.
    exclude: {
      patterns: [...exclude],
      paths: scan.excluded.rows.map(row => row.path),
      total: scan.excluded.total,
      truncated: scan.excluded.truncated === true,
    },
    caps: { maxMb, maxFiles },
    hashBudget: options.hashBudget ?? (options.maxBytes ?? DEFAULT_MAX_BYTES),
  }
}

/**
 * Why a restore must not be written under `relKey`, or `null` when every ancestor inside the
 * project is a real directory.
 *
 * THE RESTORE SIDE NEEDS THE SAME LINK GUARD AS THE DELETE SIDE. Deletions are the reviewer's
 * normal damage, and a reviewer can also plant a junction where a deleted directory used to be
 * (`src -> <project>/.git`, or anywhere else). `mkdirSync`+`copyFileSync` through it would then
 * write the project's bytes to that target: measured, a file restored under a junction landed in
 * the junction's target instead of the project. Nothing is created or written below a link.
 *
 * @param projectRoot - the real project directory.
 * @param projectReal - its canonical spelling (already resolved by the caller).
 * @param relKey - the relative path about to be restored; its PARENT chain is checked.
 * @param verified - cache of ancestor directories already proven safe.
 * @returns a problem sentence, or null.
 */
function parentLinkProblem(projectRoot, projectReal, relKey, verified) {
  const parts = relKey.split('/')
  parts.pop()
  let current = projectRoot
  for (const part of parts) {
    current = join(current, part)
    if (verified.has(current)) continue
    // A missing ancestor is fine: the restore creates it as a real directory below.
    if (!existsSync(current)) continue
    let stat
    try {
      stat = statSync(current)
    } catch (error) {
      return `its parent ${current} could not be inspected (${error?.code ?? error})`
    }
    if (!stat.isDirectory()) return `its parent ${current} is not a directory`
    if (isReparsePoint(dirname(current), basename(current), current)) {
      return `its parent ${current} is a link/reparse point, so a write would land outside the project`
    }
    let real
    try {
      real = nativeRealpath(current)
    } catch (error) {
      return `its parent ${current} cannot be resolved (${error?.code ?? error})`
    }
    if (!(samePath(real, projectReal) || isInside(real, projectReal))) {
      return `its parent ${current} resolves outside the project (${real})`
    }
    verified.add(current)
  }
  return null
}

/**
 * Re-scan the real project and compare it with the snapshot.
 *
 * @param snapshot - the record from {@link createReviewSnapshot}.
 * @returns what changed, and what was restored.
 */
export function verifyReviewSnapshot(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.projectDir !== 'string') {
    return failure('no snapshot was given, so the project cannot be verified')
  }
  const projectRoot = snapshot.projectDir

  // THE ROOT ITSELF MUST STILL BE THE DIRECTORY THAT WAS SNAPSHOTTED. If the reviewer (or
  // anything else) replaced it with a junction, every path below it resolves somewhere else:
  // the scan compares foreign content, and a restore would write the project's bytes OUTSIDE
  // the project. `createReviewSnapshot` refuses a linked project up front; this is the same
  // guard at the other end, where it matters more, because this end WRITES.
  let projectReal = projectRoot
  if (existsSync(projectRoot)) {
    try {
      projectReal = nativeRealpath(projectRoot)
    } catch {
      projectReal = null
    }
    if (projectReal === null || !samePath(projectReal, projectRoot)) {
      return {
        ok: true,
        clean: false,
        rootMissing: false,
        rootSwapped: true,
        unreadable: true,
        reason:
          `the project root no longer resolves to the directory that was snapshotted (${projectReal ?? 'unresolvable'}); ` +
          'it was replaced by a link, so nothing was restored',
        added: [],
        modified: [],
        deleted: [],
        touched: [],
        unverified: [],
        restored: [],
        restoreErrors: [],
      }
    }
  }

  let current
  if (!existsSync(projectRoot)) {
    // THE PROJECT ROOT IS GONE. Every snapshot entry is a deletion to restore.
    current = { ok: true, entries: new Map(), unhashed: 0 }
  } else {
    // THE FENCE COMPARES EXACTLY WHAT THE SNAPSHOT COPIED. The exclusions are read from the
    // snapshot record, not from configuration: the project file could have been edited by the
    // reviewer, and a fence that re-derived them could then silently stop verifying a directory
    // the snapshot DID copy (or start reporting one it deliberately never copied as "added").
    const exclude = Array.isArray(snapshot.exclude?.patterns) ? snapshot.exclude.patterns : []
    current = scanProject(projectRoot, {
      maxBytes: Infinity,
      maxFiles: Infinity,
      hashBudget: Number.isFinite(snapshot.hashBudget) ? snapshot.hashBudget : DEFAULT_HASH_BUDGET,
      exclude,
    })
    if (!current.ok) {
      // An unreadable project after the review is itself contamination we cannot
      // enumerate. It is reported as unclean with no restore attempted.
      return {
        ok: true,
        clean: false,
        rootMissing: false,
        rootSwapped: false,
        unreadable: true,
        reason: current.reason,
        added: [],
        modified: [],
        deleted: [],
        touched: [],
        unverified: [],
        restored: [],
        restoreErrors: [],
      }
    }
  }

  const deleted = []
  const modified = []
  const touched = []
  const unverified = []
  const added = []

  for (const [relKey, before] of snapshot.baseline) {
    const after = current.entries.get(relKey)
    if (after === undefined) {
      deleted.push(relKey)
      continue
    }
    if (before.kind !== after.kind) {
      modified.push(relKey)
      continue
    }
    if (before.kind !== 'file') continue

    // GIT BOOKKEEPING IS COMPARED STRUCTURALLY ONLY — see `gitBookkeeping`. Existence, kind and
    // restoration still count; its content is rewritten by read-only commands the reviewer is
    // TOLD to run (`git status` refreshes the index) and by a human's concurrent push (reflogs).
    if (gitBookkeeping(relKey)) continue

    if (before.size !== after.size) {
      modified.push(relKey)
      continue
    }
    if (before.hash !== null && after.hash !== null) {
      if (before.hash !== after.hash) modified.push(relKey)
      continue
    }
    if (before.mtimeMs !== after.mtimeMs) {
      // THE HOLE THIS CLOSES (found by the 2026-10-25 security review, with a 65 MiB fixture):
      // when there was no content digest on both sides this branch used to fall through
      // silently, so a SAME-LENGTH rewrite of a file the hash budget never reached left the
      // fence reporting `clean: true` and the tampered bytes in place. A moved timestamp is not
      // proof of a change — but it is the only signal left, and "could have changed" must not
      // be reported as "unchanged".
      touched.push(relKey)
      continue
    }
    // Size and timestamp both match and there is no digest to settle it: NOT proven unchanged,
    // so not clean. Unreachable while DEFAULT_HASH_BUDGET covers every snapshot the fence
    // accepts; this exists for a deliberately lowered budget and for unreadable files.
    unverified.push(relKey)
  }
  for (const relKey of current.entries.keys()) {
    if (!snapshot.baseline.has(relKey)) added.push(relKey)
  }

  const restored = []
  const restoreErrors = []
  const verifiedDirs = new Set()
  const restoreTargets = deleted.filter(relKey => {
    const before = snapshot.baseline.get(relKey)
    return before !== undefined
  })

  // DIRECTORIES FIRST (parents before children), then files, so a restored file never
  // has to create a parent that a later directory pass would have made anyway.
  const directories = restoreTargets
    .filter(relKey => snapshot.baseline.get(relKey).kind === 'dir')
    .sort((a, b) => a.split('/').length - b.split('/').length)
  const links = restoreTargets.filter(relKey => snapshot.baseline.get(relKey).kind === 'link')
  const files = restoreTargets.filter(relKey => snapshot.baseline.get(relKey).kind === 'file')

  try {
    if (!existsSync(projectRoot)) mkdirSync(projectRoot, { recursive: true })
  } catch (error) {
    restoreErrors.push(`. (${error?.code ?? error})`)
  }

  for (const relKey of directories) {
    const absolute = join(projectRoot, relKey)
    const problem = parentLinkProblem(projectRoot, projectReal, relKey, verifiedDirs)
    if (problem !== null) {
      restoreErrors.push(`${relKey} (${problem}; not created)`)
      continue
    }
    try {
      mkdirSync(absolute, { recursive: true })
      restored.push(relKey)
    } catch (error) {
      restoreErrors.push(`${relKey} (${error?.code ?? error})`)
    }
  }
  // AN IN-PROJECT LINK IS RESTORED AS CONTENT, NOT AS A LINK. The copy was taken with
  // `dereference: true`, so there is no link left to recreate — and recreating one would
  // hand a future recursive delete a target it should not have.
  for (const relKey of links) {
    const absolute = join(projectRoot, relKey)
    const copy = join(snapshot.workDir, relKey)
    const problem = parentLinkProblem(projectRoot, projectReal, relKey, verifiedDirs)
    if (problem !== null) {
      restoreErrors.push(`${relKey} (${problem}; not written back)`)
      continue
    }
    try {
      mkdirSync(dirname(absolute), { recursive: true })
      if (statSync(copy).isDirectory()) cpSync(copy, absolute, { recursive: true })
      else copyFileSync(copy, absolute)
      restored.push(relKey)
    } catch (error) {
      restoreErrors.push(`${relKey} (${error?.code ?? error})`)
    }
  }
  for (const relKey of files) {
    const absolute = join(projectRoot, relKey)
    const copy = join(snapshot.workDir, relKey)
    const before = snapshot.baseline.get(relKey)
    try {
      // THE RESTORE READS FROM THE SNAPSHOT, SO THE SNAPSHOT HAS TO BE TRUSTED FIRST. The
      // reviewer knows the copy path (the prompt names it) and has write access to the temp
      // root, so it could edit the copy it is reviewing. Writing those bytes back as "the
      // original" would turn a detected incident into silent corruption. The copy is hashed
      // BEFORE anything is written, and a mismatch means the project is left as it is with the
      // mismatch reported — never overwritten with content nobody vouched for.
      if (typeof before.hash === 'string' && hashFile(copy) !== before.hash) {
        restoreErrors.push(`${relKey} (the snapshot copy no longer matches its recorded digest; not written back)`)
        continue
      }
      const problem = parentLinkProblem(projectRoot, projectReal, relKey, verifiedDirs)
      if (problem !== null) {
        restoreErrors.push(`${relKey} (${problem}; not written back)`)
        continue
      }
      mkdirSync(dirname(absolute), { recursive: true })
      copyFileSync(copy, absolute)
      restored.push(relKey)
    } catch (error) {
      restoreErrors.push(`${relKey} (${error?.code ?? error})`)
    }
  }

  // NOTHING THAT COULD HAVE CHANGED MAY COUNT AS UNCHANGED. `touched` and `unverified` are the
  // two ways a file can be in doubt (a moved timestamp with no digest; matching size and
  // timestamp with no digest), and before 2026-11-01 neither was part of this predicate — the
  // review's security review proved that a tampered file could therefore still PASS.
  const clean =
    deleted.length === 0 &&
    modified.length === 0 &&
    added.length === 0 &&
    touched.length === 0 &&
    unverified.length === 0 &&
    restoreErrors.length === 0

  return {
    ok: true,
    clean,
    rootMissing: !existsSync(projectRoot),
    rootSwapped: false,
    unreadable: false,
    added,
    modified,
    deleted,
    touched,
    unverified,
    restored,
    restoreErrors,
    restoredFrom: snapshot.workDir,
    hashed: current.hashed ?? 0,
    unhashed: current.unhashed ?? 0,
  }
}

/**
 * A snapshot that was kept: report the ROOT (the thing a human deletes), not the copy.
 *
 * WHY THE ROOT AND NOT `workDir`: the copy is usually already gone by the time a root delete
 * fails, so a path pointing at `.../work` names something that does not exist — and the human
 * reading the report has to guess. The root is the unit this plugin created, the unit the
 * janitor sweeps, and the unit the command below removes.
 *
 * `remedy` is a copy-paste command, not a description of one: the reader is a model or a person
 * in a terminal, and retyping a temp path from prose is how it gets deleted wrongly or not at
 * all. `janitor: true` marks the failure class the durable sweep may finish later (a live handle
 * held it); every other reason is a guard REFUSAL and is never auto-deleted.
 */
function keptFailure(rootDir, workDir, reason, detail, extra = {}) {
  return {
    ...failure(reason, detail),
    kept: true,
    path: rootDir,
    workDir,
    remedy: `Remove-Item -LiteralPath '${rootDir}' -Recurse -Force`,
    ...extra,
  }
}

/**
 * Delete the reviewer's copy — and nothing else.
 *
 * THE GUARDS ARE THE POINT. `rmSync(path, {recursive:true})` on Windows follows a
 * directory junction, which is precisely how the workspace was destroyed. So the path
 * is resolved, and it must (a) be named `work`, (b) be inside the snapshot root whose
 * name this plugin chose, (c) not be a reparse point, and (d) not contain or equal the
 * project. Any doubt means the delete is refused and the temp tree is left in place.
 *
 * @param snapshot - the record from {@link createReviewSnapshot}.
 * @param options - `{ rm }`; `rm` is a TEST SEAM, never a tool argument. It defaults to
 *   `rmSync` and is called only after every guard above has passed, so it cannot widen what
 *   may be deleted — it exists so a test can prove the retry options this module exports are
 *   the ones it passes, and that a delete which still fails reports its path.
 * @returns whether the copy is gone and the canary survived.
 */
export function removeReviewSnapshot(snapshot, options = {}) {
  if (!snapshot || typeof snapshot !== 'object' || typeof snapshot.rootDir !== 'string') {
    return failure('no snapshot root was given, so nothing is deleted')
  }
  const rm = typeof options.rm === 'function' ? options.rm : rmSync
  const rootDir = snapshot.rootDir
  const workDir = snapshot.workDir ?? join(rootDir, SNAPSHOT_WORK_DIRNAME)
  const canaryPath = snapshot.canaryPath ?? join(rootDir, SNAPSHOT_CANARY_NAME)
  const markerPath = snapshot.markerPath ?? join(rootDir, SNAPSHOT_MARKER_NAME)
  const projectDir = snapshot.projectDir

  let rootReal
  try {
    rootReal = nativeRealpath(rootDir)
  } catch (error) {
    return failure(`the snapshot root is already gone or unreadable (${error?.code ?? error})`)
  }

  let workReal = null
  try {
    // NATIVE: the JS realpath leaves a junction unresolved on Windows, so a copy replaced by
    // a junction to the project would compare as "inside the snapshot root" and be deleted.
    workReal = nativeRealpath(workDir)
  } catch {
    // Already removed. The canary check below still runs.
  }

  if (workReal !== null) {
    if (basename(workDir) !== SNAPSHOT_WORK_DIRNAME) {
      return failure(`refusing to delete ${workDir}: it is not the reviewer copy directory`)
    }
    if (!isInside(workReal, rootReal)) {
      return failure(`refusing to delete ${workDir}: it resolves outside the snapshot root (${workReal})`)
    }
    if (projectDir !== undefined) {
      const projectReal = (() => {
        try {
          return nativeRealpath(projectDir)
        } catch {
          return null
        }
      })()
      if (projectReal !== null && (workReal === projectReal || isInside(projectReal, workReal) || isInside(workReal, projectReal))) {
        return failure(
          `refusing to delete ${workDir}: it resolves to or contains the project (${workReal})`,
          'This is the shape of the incident: a link whose target is the workspace.',
        )
      }
    }
    if (isReparsePoint(rootDir, basename(workDir), workDir)) {
      return failure(
        `refusing to delete ${workDir}: it is a link/reparse point`,
        'A recursive delete would follow it, which is exactly how the workspace was destroyed.',
      )
    }
    // A LINK PLANTED INSIDE THE COPY IS THE INCIDENT WITH ONE EXTRA STEP. Deleting a
    // directory that CONTAINS a junction can still reach its target (measured), so the
    // copy is scanned immediately before the delete and any link blocks it.
    //
    // NO EXCLUSION HERE, DELIBERATELY. The configured exclusions describe what the snapshot did
    // not copy; the reviewer can still CREATE a directory with an excluded name inside the copy,
    // and a link planted there would be skipped by an exclusion-aware scan and then followed by
    // the recursive delete. This scan is about the tree that is about to be deleted.
    const inside = scanProject(workDir, { maxBytes: Infinity, maxFiles: Infinity, hashBudget: 0, exclude: [] })
    if (!inside.ok) {
      return failure(
        `refusing to delete ${workDir}: it could not be scanned (${inside.reason})`,
        'A tree that cannot be checked for links is not safe to delete recursively.',
      )
    }
    if (inside.links > 0) {
      return failure(
        `refusing to delete ${workDir}: it contains ${inside.links} link(s)`,
        'A recursive delete can reach a link target; the copy is left in place instead.',
      )
    }
    try {
      // THE REVIEWER MAY HAVE SPAWNED PROCESSES IN THE COPY (`npm test`, `node --test`).
      // Measured: a cleanup right after such a review failed with EPERM and left the tree
      // behind, then a later attempt succeeded — the child's processes had still held the
      // files. `SNAPSHOT_REMOVE_RETRY` is the longer, bounded window; when it still fails, the
      // failure below names the path so a human can delete it once the children exit.
      rm(workDir, { recursive: true, force: true, ...SNAPSHOT_REMOVE_RETRY })
    } catch (error) {
      // A LIVE HANDLE, NOT A GUARD REFUSAL. This is the EPERM leftover the janitor exists for:
      // the snapshot is registered durably and swept later, and the report names the ROOT with
      // the exact command that removes it.
      return keptFailure(
        rootDir,
        workDir,
        `the reviewer copy could not be removed (${error?.code ?? error}) and was kept`,
        'Something still holds it (a review that launched its own child processes); delete it when they exit.',
        { janitor: true },
      )
    }
  }

  if (!existsSync(canaryPath)) {
    return keptFailure(
      rootDir,
      workDir,
      'the canary outside the reviewer copy disappeared, so the delete is treated as unsafe',
      'The snapshot root is left in place for inspection.',
    )
  }

  // THE ROOT IS ONLY REMOVED WHEN IT IS PROVABLY OURS. Without the marker a swapped-in
  // path would be deleted on the strength of the caller's word alone.
  let marker = null
  try {
    marker = JSON.parse(readFileSync(markerPath, 'utf8'))
  } catch (error) {
    return keptFailure(
      rootDir,
      workDir,
      `refusing to delete the snapshot root: ${markerPath} is missing or unreadable (${error?.code ?? error})`,
      'The root is left in place; only the copy itself was removed.',
    )
  }
  if (marker?.plugin !== 'dsh-workflow' || marker?.kind !== 'review-snapshot') {
    return keptFailure(
      rootDir,
      workDir,
      'refusing to delete the snapshot root: it is not a dsh-workflow review snapshot',
    )
  }

  try {
    // Same bounded retry window as the copy: the root can be held by the same children.
    rm(rootDir, { recursive: true, force: true, ...SNAPSHOT_REMOVE_RETRY })
  } catch (error) {
    return keptFailure(
      rootDir,
      workDir,
      `the snapshot root could not be removed (${error?.code ?? error})`,
      'Something still holds it (a review that launched its own child processes); the janitor retries.',
      { janitor: true },
    )
  }

  return { ok: true, removed: true }
}

// ---------------------------------------------------------------------------------------------
// THE SNAPSHOT-CLEANUP JANITOR
//
// WHY IT EXISTS. The immediate delete already retries for nine seconds, and a live review whose
// reviewer had launched `npm test` still lost that race: the copy was kept (correct), the report
// named it (correct), and nobody ever deleted it. One measured run of the isolation suite left
// FIVE temp roots behind. The retry stays — it wins most of the time — but a failure is no longer
// the end of the story: the ROOT is recorded durably, a bounded in-process retry keeps trying,
// and a later startup sweeps what is left.
//
// ONLY WHAT THIS BUILD REGISTERED IS SWEPT. An older build's leftover carries no release record
// (below), so it is reported to the user with a command instead of being auto-deleted.
//
// WHAT A SWEEP MAY DELETE — every condition, all required:
//   * the root is in the pending list this plugin wrote (never "any dsh-review-* directory");
//   * it lives under the OS temp directory;
//   * it is named `dsh-review-*`;
//   * it carries `snapshot.json` with plugin `dsh-workflow` and kind `review-snapshot`;
//   * OR it has a valid `releasedAt` old enough for the grace, OR its marker records a pid that is
//     NO LONGER ALIVE (age alone is never a reason; the release record is only trusted for an
//     entry this plugin registered itself);
//   * it passes every guard `removeReviewSnapshot` already enforces (canary, containment,
//     no links, no project inside or around it).
//
// A SNAPSHOT KEPT FOR CONTAMINATION IS EVIDENCE AND IS NEVER REGISTERED, so no sweep can reach
// it: `runReview` records that keep itself and never calls the registering wrapper.
// ---------------------------------------------------------------------------------------------

/** Where the durable pending-cleanup list lives by default. */
export function defaultCleanupStatePath() {
  return join(tmpdir(), SNAPSHOT_CLEANUP_STATE_NAME)
}

/** How many pending roots are tracked; beyond it the oldest are reported as not recorded. */
const CLEANUP_ENTRY_CAP = 64

/**
 * The most a pending entry's recorded attempt count may reach.
 *
 * THE DURABLE FILE MUST NOT GROW WITHOUT BOUND. A leftover can survive many sessions and many
 * 30-second retries; an uncapped counter would make the state file's only growing field a plain
 * integer. The count is diagnostic, not arithmetic: once it reaches the ceiling, "kept 1000+
 * times" says everything a reader needs.
 */
export const CLEANUP_ATTEMPT_CAP = 1000

/** The longest recorded keep reason kept in the durable list (one report line). */
const CLEANUP_REASON_CHARS = 300

/**
 * A value safe to persist and print as ONE line: newlines flattened, bounded, empty as null.
 *
 * THE KEEP REASON IS READ ACROSS SESSIONS AND PRINTED BY `workflow_status`, so it must not carry
 * a stack, a CRLF and a forged extra report line into the state file, and it must not grow that
 * file without bound. A non-string is `null` (unknown) rather than the string "undefined".
 */
function boundedReason(value, maxChars = CLEANUP_REASON_CHARS) {
  if (typeof value !== 'string') return null
  const flat = value.replace(/[\r\n\u2028\u2029]+/g, ' ').trim()
  return flat === '' ? null : flat.slice(0, maxChars)
}

/** A recorded attempt count, normalised to a non-negative integer no greater than the cap. */
function boundedAttempts(value) {
  if (!Number.isInteger(value) || value < 0) return 0
  return Math.min(value, CLEANUP_ATTEMPT_CAP)
}

/**
 * One entry with this sweep's attempt recorded.
 *
 * THE KEPT ENTRY IS UPDATED IN PLACE IN THE LIST, not only summarised in the return value: the
 * return value belongs to this call, while the durable list is what the next session reads. A
 * sweep that kept everything used to write nothing at all, so the keep reason survived only in
 * the mount log — which is how a pending snapshot once outlived the evidence explaining it.
 */
function recordAttempt(entry, reason, at) {
  return {
    ...entry,
    attempts: boundedAttempts((Number.isInteger(entry.attempts) ? entry.attempts : 0) + 1),
    lastAttemptAt: at,
    lastReason: boundedReason(reason),
  }
}

/**
 * Read the durable pending list.
 *
 * AN UNREADABLE OR MALFORMED FILE IS REPORTED, NOT THROWN: a startup path must never fail the
 * host mount, and a list that cannot be read must not read as "there is nothing to clean" — the
 * `problems` array says so instead.
 *
 * @param statePath - where the list lives.
 * @returns `{ entries, problems, present }`.
 */
export function readPendingSnapshots(statePath = defaultCleanupStatePath()) {
  const problems = []
  let text
  try {
    text = readFileSync(statePath, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') problems.push(`the pending cleanup list could not be read (${error?.code ?? error})`)
    return { entries: [], problems, present: false }
  }
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { entries: [], problems: [`the pending cleanup list is not valid JSON (${error?.message ?? error})`], present: true }
  }
  const raw = Array.isArray(parsed?.pending) ? parsed.pending : []
  const entries = []
  for (const item of raw) {
    if (item === null || typeof item !== 'object' || typeof item.rootDir !== 'string' || item.rootDir === '') {
      problems.push('an entry in the pending cleanup list has no usable rootDir; it was ignored')
      continue
    }
    entries.push({
      rootDir: item.rootDir,
      projectDir: typeof item.projectDir === 'string' && item.projectDir !== '' ? item.projectDir : null,
      registeredAt: typeof item.registeredAt === 'string' ? item.registeredAt : null,
      // THE RELEASE RECORD. A registered entry means "the owner finished with this snapshot and
      // could not delete it"; `releasedAt` is when that happened. Only `registerPendingSnapshotCleanup`
      // writes it, so an entry without one was not written by this build (or the list was edited).
      releasedAt: typeof item.releasedAt === 'string' ? item.releasedAt : null,
      reason: typeof item.reason === 'string' ? item.reason : null,
      // WHY IT IS STILL HERE. Every sweep that keeps an entry rewrites these three fields, so the
      // next occurrence records its own explanation instead of leaving a bare path behind.
      attempts: boundedAttempts(item.attempts),
      lastAttemptAt:
        typeof item.lastAttemptAt === 'string' && Number.isFinite(Date.parse(item.lastAttemptAt))
          ? new Date(Date.parse(item.lastAttemptAt)).toISOString()
          : null,
      lastReason: boundedReason(item.lastReason),
    })
  }
  return { entries, problems, present: true }
}

/** Write the pending list back. A write failure is reported, never thrown. */
function writePendingSnapshots(statePath, entries) {
  try {
    writeFileSync(
      statePath,
      `${JSON.stringify({ plugin: 'dsh-workflow', kind: 'review-cleanup', pending: entries }, null, 2)}\n`,
      'utf8',
    )
    return { ok: true }
  } catch (error) {
    return { ok: false, reason: `the pending cleanup list could not be written (${error?.code ?? error})` }
  }
}

/**
 * Record one snapshot ROOT in the durable pending list.
 *
 * REGISTRATION IS A RELEASE RECORD. Reaching here means the delete already ran its bounded retry
 * and failed on a live handle; from the owner's point of view the snapshot is FINISHED WITH, not
 * still in use. `releasedAt` says so, and the sweep uses it instead of the marker's host pid
 * (which stays alive for the rest of the session). See {@link SNAPSHOT_CLEANUP_RELEASE_GRACE_MS}.
 *
 * @param entry - `{ rootDir, projectDir?, reason? }`.
 * @param options - `{ statePath, releasedAt }`; both are test seams (the default is the OS temp
 *   directory and "now").
 * @returns `{ ok, statePath, total, kept, entry?, reason? }`.
 */
export function registerPendingSnapshotCleanup(entry, options = {}) {
  if (entry === null || typeof entry !== 'object' || typeof entry.rootDir !== 'string' || entry.rootDir === '') {
    return { ok: false, statePath: options.statePath ?? defaultCleanupStatePath(), total: 0, kept: false, reason: 'no snapshot root was given' }
  }
  const statePath = typeof options.statePath === 'string' && options.statePath !== ''
    ? options.statePath
    : defaultCleanupStatePath()
  const current = readPendingSnapshots(statePath)
  const pending = [...current.entries]
  const existing = pending.find(item => samePath(item.rootDir, entry.rootDir))
  if (existing !== undefined) {
    return { ok: true, statePath, total: pending.length, kept: false, entry: existing, problems: current.problems }
  }
  const releasedAt = typeof options.releasedAt === 'string' && Number.isFinite(Date.parse(options.releasedAt))
    ? new Date(Date.parse(options.releasedAt)).toISOString()
    : new Date().toISOString()
  const record = {
    rootDir: entry.rootDir,
    projectDir: typeof entry.projectDir === 'string' && entry.projectDir !== '' ? entry.projectDir : null,
    registeredAt: new Date().toISOString(),
    releasedAt,
    reason: typeof entry.reason === 'string' ? entry.reason : null,
    // NOTHING HAS BEEN KEPT YET. `attempts` counts SWEEPS THAT KEPT the entry, not the failed
    // delete that registered it (that failure is `reason`, and `registeredAt` is when it ran).
    attempts: 0,
    lastAttemptAt: null,
    lastReason: null,
  }
  pending.push(record)
  const dropped = pending.length > CLEANUP_ENTRY_CAP ? pending.splice(0, pending.length - CLEANUP_ENTRY_CAP) : []
  const written = writePendingSnapshots(statePath, pending)
  return {
    ok: written.ok === true,
    statePath,
    total: pending.length,
    kept: true,
    entry: record,
    droppedTotal: dropped.length,
    ...(written.ok === true ? {} : { reason: written.reason }),
    problems: current.problems,
  }
}

/**
 * Delete a snapshot and, when the delete failed on a LIVE HANDLE, hand the ROOT to the durable
 * janitor.
 *
 * `removeReviewSnapshot` stays the pure delete: it performs the guards and the bounded retry and
 * reports what it kept, but it does not write state. This wrapper is what `runReview` calls, so
 * the durable write happens exactly where a review owns the snapshot — and a unit test of the
 * delete itself never touches the machine's pending list.
 *
 * A CONTAMINATION KEEP NEVER REACHES HERE: `runReview` skips the removal entirely in that case,
 * because the snapshot is the only remaining copy of the project's pre-review bytes.
 *
 * @param snapshot - the record from {@link createReviewSnapshot}.
 * @param options - `{ rm, statePath }`; both are test seams.
 * @returns the removal record, plus `pending` when the root was registered.
 */
export function discardReviewSnapshot(snapshot, options = {}) {
  const removed = removeReviewSnapshot(snapshot, options)
  if (removed?.ok !== false || removed.kept !== true || removed.janitor !== true) return removed
  const pending = registerPendingSnapshotCleanup(
    { rootDir: snapshot.rootDir, projectDir: snapshot.projectDir, reason: removed.reason },
    { statePath: options.statePath },
  )
  return { ...removed, pending }
}

/** Whether a pid is alive; `null` when that cannot be decided, which is treated as alive. */
function processAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    if (error?.code === 'ESRCH') return false
    // EPERM means the process exists but is not ours — alive, and certainly not ours to kill or
    // delete around. `null`/unknown must never read as "gone".
    return true
  }
}

/**
 * Decide whether one pending root may be swept.
 *
 * TWO ORIGINS, TWO PROOFS. An entry this build registered carries `releasedAt`: the owner finished
 * with it, so after the grace the marker's pid is irrelevant (the host may run for hours). An entry
 * with no release record was not written by this build — it is kept until its marker pid is
 * provably dead. Neither proof bypasses the marker/name/temp/reparse gates below.
 *
 * @param entry - one pending record.
 * @param options - `{ tempRoot, now, releaseGraceMs }`.
 * @returns `{ verdict: 'gone' | 'keep' | 'remove', reason }`.
 */
function cleanupVerdict(entry, options) {
  const tempRoot = options.tempRoot
  const now = Number.isFinite(options.now) ? options.now : Date.now()
  const graceMs = Number.isFinite(options.releaseGraceMs) && options.releaseGraceMs >= 0
    ? options.releaseGraceMs
    : SNAPSHOT_CLEANUP_RELEASE_GRACE_MS
  let rootReal
  try {
    rootReal = nativeRealpath(entry.rootDir)
  } catch (error) {
    return { verdict: 'gone', reason: `the snapshot root is already gone (${error?.code ?? error})` }
  }
  if (!existsSync(entry.rootDir)) return { verdict: 'gone', reason: 'the snapshot root is already gone' }
  if (basename(entry.rootDir) === '' || !basename(entry.rootDir).startsWith(SNAPSHOT_ROOT_PREFIX)) {
    return { verdict: 'keep', reason: `it is not named ${SNAPSHOT_ROOT_PREFIX}*` }
  }
  if (!isInside(rootReal, tempRoot)) {
    return { verdict: 'keep', reason: `it is not under the OS temp directory (${rootReal})` }
  }
  // A REPARSE POINT IS NEVER SWEPT: the root's own path could redirect the delete.
  if (isReparsePoint(dirname(entry.rootDir), basename(entry.rootDir), entry.rootDir)) {
    return { verdict: 'keep', reason: 'it is a link/reparse point' }
  }
  let marker
  try {
    marker = JSON.parse(readFileSync(join(entry.rootDir, SNAPSHOT_MARKER_NAME), 'utf8'))
  } catch (error) {
    return { verdict: 'keep', reason: `${SNAPSHOT_MARKER_NAME} is missing or unreadable (${error?.code ?? error})` }
  }
  if (marker?.plugin !== 'dsh-workflow' || marker?.kind !== 'review-snapshot') {
    return { verdict: 'keep', reason: 'the marker does not name a dsh-workflow review snapshot' }
  }

  const releasedAt = typeof entry.releasedAt === 'string' ? Date.parse(entry.releasedAt) : Number.NaN
  if (Number.isFinite(releasedAt)) {
    const age = now - releasedAt
    // A NEGATIVE AGE IS NOT "LONG AGO": a release time in the future is unreadable evidence, and
    // the safe reading of unreadable is "keep waiting", exactly as the isolation policy treats
    // an unprovable file.
    if (age < graceMs) {
      const waited = Number.isFinite(age) && age >= 0 ? Math.round(age / 1000) : 0
      return {
        verdict: 'keep',
        reason: `it was released ${waited}s ago; the ${Math.round(graceMs / 1000)}s release grace has not elapsed`,
      }
    }
    return {
      verdict: 'remove',
      reason: `this plugin registered it for cleanup ${Math.round(age / 1000)}s ago (released by its owner)`,
    }
  }

  // NO RELEASE RECORD: NOT WRITTEN BY THIS BUILD. The pid is the only evidence of ownership, so it
  // must be provably dead — the same rule as before, and the reason an older leftover is reported
  // to the user instead of being auto-deleted.
  const alive = processAlive(marker.pid)
  if (alive === null) {
    return {
      verdict: 'keep',
      reason:
        'it has no release record and its marker records no usable owner pid, so it cannot be proven orphaned',
    }
  }
  if (alive === true) {
    return { verdict: 'keep', reason: `its recorded owner pid ${marker.pid} is still running and it has no release record` }
  }
  return { verdict: 'remove', reason: `its recorded owner pid ${marker.pid} is no longer running` }
}

/**
 * Sweep the durable pending list once.
 *
 * AGE IS NEVER A CRITERION ON ITS OWN. A root this build released is swept after the grace; a root
 * with no release record is swept only when its owner is provably dead. "It looks old" is never a
 * reason, because "old" and "abandoned" are not the same fact — the same mistake the mutation lock
 * made when it read an unreadable age as epoch 0.
 *
 * @param options - `{ statePath, tempRoot, rm, now, releaseGraceMs }`; all are test seams.
 * @returns `{ ok, statePath, checked, removed, gone, kept, problems }`.
 */
export function sweepPendingSnapshots(options = {}) {
  const statePath = typeof options.statePath === 'string' && options.statePath !== ''
    ? options.statePath
    : defaultCleanupStatePath()
  const current = readPendingSnapshots(statePath)
  const problems = [...current.problems]
  if (current.entries.length === 0) {
    return { ok: true, statePath, checked: 0, removed: [], gone: [], kept: [], problems }
  }

  const rawTempRoot = typeof options.tempRoot === 'string' && options.tempRoot !== ''
    ? options.tempRoot
    : tmpdir()
  let tempRoot
  try {
    tempRoot = nativeRealpath(rawTempRoot)
    if (!statSync(tempRoot).isDirectory()) throw new Error('not a directory')
  } catch (error) {
    return {
      ok: false,
      statePath,
      checked: 0,
      removed: [],
      gone: [],
      kept: current.entries.map(entry => ({ rootDir: entry.rootDir, reason: `the temp root ${rawTempRoot} is unusable` })),
      problems,
      reason: `the sweep could not run: ${rawTempRoot} is not a directory (${error?.code ?? error})`,
    }
  }

  const removed = []
  const gone = []
  const kept = []
  const remaining = []
  const nowMs = Number.isFinite(options.now) ? options.now : Date.now()
  const attemptAt = new Date(nowMs).toISOString()
  const verdictOptions = {
    tempRoot,
    now: nowMs,
    releaseGraceMs: options.releaseGraceMs,
  }
  let recordedKeep = false
  for (const entry of current.entries) {
    const verdict = cleanupVerdict(entry, verdictOptions)
    if (verdict.verdict === 'gone') {
      gone.push(entry.rootDir)
      continue
    }
    if (verdict.verdict === 'keep') {
      kept.push({ rootDir: entry.rootDir, reason: verdict.reason })
      // THE ENTRY IS UPDATED, NOT JUST THE RETURN VALUE. This is what makes a keep diagnosable
      // in the NEXT session (see `recordAttempt`): the reason travels with the durable entry.
      remaining.push(recordAttempt(entry, verdict.reason, attemptAt))
      recordedKeep = true
      continue
    }
    const result = removeReviewSnapshot(
      {
        rootDir: entry.rootDir,
        workDir: join(entry.rootDir, SNAPSHOT_WORK_DIRNAME),
        canaryPath: join(entry.rootDir, SNAPSHOT_CANARY_NAME),
        markerPath: join(entry.rootDir, SNAPSHOT_MARKER_NAME),
        projectDir: entry.projectDir ?? undefined,
      },
      { rm: options.rm },
    )
    if (result.ok === true) {
      removed.push(entry.rootDir)
      continue
    }
    kept.push({ rootDir: entry.rootDir, reason: result.reason })
    remaining.push(recordAttempt(entry, result.reason, attemptAt))
    recordedKeep = true
  }

  // THE LIST IS REWRITTEN WHEN AN ENTRY LEAVES IT **OR WHEN ONE WAS KEPT**. The second half is
  // the observability fix: a sweep that kept everything used to write nothing, so the only record
  // of WHY a root was kept was the mount log, which the next session never sees. The
  // "a machine that never had a failed delete grows no state file" property still holds — with
  // no pending entry this function returns above and never creates the file.
  if (remaining.length !== current.entries.length || recordedKeep) {
    const written = writePendingSnapshots(statePath, remaining)
    if (written.ok !== true) problems.push(written.reason)
  }

  return { ok: true, statePath, checked: current.entries.length, removed, gone, kept, problems }
}

/**
 * A READ-ONLY summary of the durable pending list, for `workflow_status`.
 *
 * IT NEVER SWEEPS AND NEVER WRITES. A status call is what a human uses to decide what to do
 * about a leftover; a read that deleted a root would destroy the very evidence the list exists
 * to report. It also never touches the snapshot itself — no stat, no open, no re-scan.
 *
 * The list is bounded the same way the mount report is: at most `limit` entries, each flattened
 * to one line, with `truncated` saying more exist. `lastReason` is why the last sweep kept it;
 * before the first sweep it is `null`, and the registration reason is the fallback.
 *
 * @param options - `{ statePath, limit }`; both are optional.
 * @returns `{ present, statePath, count, entries, truncated, problems }`.
 */
export function pendingSnapshotLeftovers(options = {}) {
  const statePath = typeof options.statePath === 'string' && options.statePath !== ''
    ? options.statePath
    : defaultCleanupStatePath()
  const limit = Number.isInteger(options.limit) && options.limit > 0 ? options.limit : 3
  const current = readPendingSnapshots(statePath)
  const entries = current.entries.slice(0, limit).map(entry => ({
    rootDir: boundedReason(entry.rootDir, 500) ?? '(unusable root path)',
    lastReason: entry.lastReason ?? boundedReason(entry.reason),
    attempts: entry.attempts,
    lastAttemptAt: entry.lastAttemptAt,
  }))
  return {
    present: current.present,
    statePath,
    count: current.entries.length,
    entries,
    truncated: current.entries.length > entries.length,
    problems: current.problems,
  }
}

/** The single in-process retry timer, so repeated failures cannot schedule an unbounded set. */
let cleanupRetryController = null

/**
 * Start the bounded in-process retry: sweep every `intervalMs`, give up after `windowMs`.
 *
 * BOUNDED IN BOTH DIRECTIONS. It stops when the list is empty (the normal outcome) and when the
 * window expires, leaving the durable list for the next startup. A hard attempt ceiling derived
 * from the window and interval stops it even if the clock never advances. The timer is `unref()`d
 * so a plugin process is never held open by a cleanup obligation.
 *
 * @param options - `{ statePath, tempRoot, intervalMs, windowMs, setTimeout, clearTimeout, now }`.
 * @returns `{ started, statePath, attempts, maxAttempts, lastSweep?, stop() }`; `started:false`
 *   when one is already running, so the caller never stacks timers.
 */
export function ensureCleanupRetry(options = {}) {
  if (cleanupRetryController !== null) {
    return { started: false, reason: 'a cleanup retry is already scheduled', stop() {} }
  }
  const statePath = typeof options.statePath === 'string' && options.statePath !== ''
    ? options.statePath
    : defaultCleanupStatePath()
  const intervalMs = Number.isFinite(options.intervalMs) && options.intervalMs > 0
    ? options.intervalMs
    : SNAPSHOT_CLEANUP_RETRY.intervalMs
  const windowMs = Number.isFinite(options.windowMs) && options.windowMs > 0
    ? options.windowMs
    : SNAPSHOT_CLEANUP_RETRY.windowMs
  const setTimer = typeof options.setTimeout === 'function' ? options.setTimeout : setTimeout
  const clearTimer = typeof options.clearTimeout === 'function' ? options.clearTimeout : clearTimeout
  const now = typeof options.now === 'function' ? options.now : Date.now
  const startedAt = now()
  // A HARD ATTEMPT CEILING IN ADDITION TO THE WALL-CLOCK WINDOW. The window depends on `now()`
  // advancing; a caller-injected clock that never advances, or a fake timer that fires without
  // time passing, would otherwise schedule forever. The ceiling is derived from the same two
  // numbers, so a normal run reaches the window first — it is a floor on correctness, not a
  // second policy.
  const maxAttempts = Math.max(1, Math.ceil(windowMs / intervalMs) + 1)
  let handle

  const controller = {
    started: true,
    statePath,
    attempts: 0,
    maxAttempts,
    stopped: false,
    lastSweep: null,
    stop() {
      if (controller.stopped) return
      controller.stopped = true
      if (handle !== undefined) {
        try {
          clearTimer(handle)
        } catch {
          // A timer that cannot be cleared is not worse than one that fires into a stopped flag.
        }
      }
      handle = undefined
      cleanupRetryController = null
    },
  }

  const schedule = () => {
    handle = setTimer(() => {
      handle = undefined
      if (controller.stopped) return
      controller.attempts += 1
      let swept
      try {
        swept = sweepPendingSnapshots({ ...options, statePath })
      } catch (error) {
        swept = {
          ok: false,
          statePath,
          checked: 0,
          removed: [],
          gone: [],
          kept: [{ rootDir: '(unknown)', reason: String(error?.message ?? error) }],
          problems: [],
        }
      }
      controller.lastSweep = swept
      if (swept.kept.length === 0) {
        controller.stop()
        return
      }
      if (controller.attempts >= maxAttempts || now() - startedAt >= windowMs) {
        controller.stop()
        return
      }
      schedule()
    }, intervalMs)
    if (handle !== null && typeof handle === 'object' && typeof handle.unref === 'function') {
      handle.unref()
    }
  }

  cleanupRetryController = controller
  schedule()
  return controller
}

/** Stop the in-process retry, if one is scheduled. Returns whether one was stopped. */
export function stopCleanupRetry() {
  if (cleanupRetryController === null) return false
  cleanupRetryController.stop()
  return true
}
