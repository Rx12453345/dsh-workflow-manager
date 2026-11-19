/**
 * The git half of "the declared file list is a CLAIM, not evidence".
 *
 * WHY THIS MODULE EXISTS
 * `workflow_review` has always taken `changed_files` from the caller and folded those paths
 * into the verification classification. The declaration was therefore both the claim AND the
 * evidence for it: a caller that omitted `lib/approval.js` from the list got a shallower class
 * for a change that touched the approval surface. Naming a class cannot lower the depth,
 * because the class is checked against the files — but nothing checked that the FILES were the
 * files. This module supplies the missing half: when the reviewed project is a git checkout,
 * the working tree itself says what changed, and a path the declaration left out is added to
 * the evidence rather than being silently accepted as part of the claim.
 *
 * WHAT IT IS NOT. It is not an enforcement on its own: it reports, and `workflow_review` folds
 * the result into the classification set. A project that is not a repository, or a machine
 * without git, gets a documented note and the existing behaviour — a review must not become
 * impossible because a tool is missing, but the absence must also never be reported as
 * agreement.
 *
 * NO SHELL, EVER. Every call goes through `execFileSync(command, [arguments])` with the
 * project directory as `cwd`. Nothing from a model, a file, or a report is ever concatenated
 * into a command line, so a path with a space, a quote, or a `;` is data rather than syntax.
 *
 * @module src-12453345_-dsh-workflow/git-changes
 */

import { execFileSync } from 'node:child_process'
import { relative, resolve } from 'node:path'
import { realpathSync, statSync } from 'node:fs'

import { CONSTRAINTS_RELATIVE_PATH } from './constraints.js'
import {
  DEFAULT_FEATURES_RELATIVE_PATH,
  DEFAULT_WORKFLOW_STATE_RELATIVE_PATH,
  WORK_UNIT_DIR_RELATIVE_PATH,
} from './work-unit.js'
import { WORKFLOW_RELATIVE_PATH } from './workflow-file.js'

/**
 * A canonical framework path in the comparison form this module uses.
 *
 * The constants are built with `path.join`, so on Windows they contain backslashes while
 * `normaliseGitPath` emits forward slashes. Lowercasing matches the case-insensitive comparison
 * the excluded-set contract already relied on and keeps a Windows checkout spelling `.DSH`
 * excluded. Importing the constants rather than re-typing them means a renamed framework file
 * cannot silently stop being excluded here.
 */
const frameworkStatePath = value => value.replace(/\\/g, '/').toLowerCase()

/**
 * Framework state files that are NOT code changes.
 *
 * WHY THEY ARE EXCLUDED FROM THE COMPARISON, STATED SO IT CAN BE DISPUTED. The workflow writes
 * `.dsh/workflow.yml`, `.dsh/WORKFLOW.json`, `.dsh/FEATURES.json`, `.dsh/CONSTRAINTS.json` and
 * the per-unit `.dsh/work/**` files ITSELF, during the very session being reviewed —
 * `record-review` writes FEATURES.json, a phase move writes WORKFLOW.json, and `workflow_gc`
 * writes the constraint ledger. Comparing them against a review's file list would therefore do
 * two bad things: every review of an active workflow project would report a mismatch caused by
 * the framework's own bookkeeping, and `.dsh/workflow.yml` is a protected gate/configuration
 * surface, so the derived class would be `security` on every call. Those files are still
 * protected from the caller's side — the classifier grades a declared `.dsh/workflow.yml` as
 * security — they are simply not treated as changed CODE by this cross-check.
 *
 * Matched case-insensitively on the normalised forward-slash path, because a Windows checkout
 * spells the same directory `.DSH`.
 */
export const FRAMEWORK_STATE_PATHS = Object.freeze([
  frameworkStatePath(WORKFLOW_RELATIVE_PATH),
  frameworkStatePath(DEFAULT_WORKFLOW_STATE_RELATIVE_PATH),
  frameworkStatePath(DEFAULT_FEATURES_RELATIVE_PATH),
  frameworkStatePath(CONSTRAINTS_RELATIVE_PATH),
])

/** Prefixes whose whole tree is framework state (one directory per work unit). */
export const FRAMEWORK_STATE_PREFIXES = Object.freeze([
  `${frameworkStatePath(WORK_UNIT_DIR_RELATIVE_PATH)}/`,
])

/** The path maximum before the list is reported as a prefix. */
export const GIT_PATH_CAP = 400

/** How long one git call may take. It reads a working tree, not the network. */
const GIT_TIMEOUT_MS = 10_000

/** The argv the cross-check runs, exported so a test can assert it rather than guess. */
export const GIT_REV_PARSE_ARGS = Object.freeze(['rev-parse', '--is-inside-work-tree'])
export const GIT_TOP_LEVEL_ARGS = Object.freeze(['rev-parse', '--show-toplevel'])
export const GIT_STATUS_ARGS = Object.freeze([
  'status',
  // porcelain v1 -z: machine-readable, NUL-terminated, and never path-quoted, so a space or a
  // newline in a filename cannot split one record into two.
  '--porcelain',
  '-z',
  // `-uall` expands untracked DIRECTORIES into files. The collapsed `dir/` form is a directory,
  // which this codebase's classifier refuses as unusable evidence — and a directory cannot be
  // fingerprinted. `-uall` is what makes an untracked file usable evidence.
  '--untracked-files=all',
  // A PATHSPEC, NOT A STRING SHELL. `--` ends option parsing, and `.` limits the answer to the
  // reviewed project even when it is a subdirectory of a larger repository.
  '--',
  '.',
])

/**
 * The default runner: `execFileSync` with piped stdout.
 *
 * INJECTABLE ONLY FOR TESTS AND EMBEDDERS, never from a tool argument. `workflow_review`
 * reads its runner from the tool OPTIONS (a host-side object), and the tool's JSON argument
 * schema has no field that could reach it.
 *
 * @param command - the executable.
 * @param args - the argument array. Never a shell string.
 * @param options - `{ cwd, timeout, maxBuffer }`.
 * @returns the child's stdout as text.
 */
export function defaultGitRunner(command, args, options) {
  return execFileSync(command, args, {
    ...options,
    encoding: 'utf8',
    // Separated stdio on purpose: stderr is discarded because a non-repository answer is an
    // expected outcome, not a diagnostic the caller reads.
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  })
}

/** One-line, bounded rendering of an error for a report. */
function describeError(error) {
  const message = typeof error?.message === 'string' ? error.message.split(/\r?\n/)[0] : String(error)
  return message.slice(0, 200)
}

/**
 * A normalised, project-relative path: forward slashes, no `./` prefix.
 *
 * NO `trim()`. A leading or trailing space is a LEGAL character in a POSIX filename and a
 * legal (if awkward) one on Windows, so trimming would silently turn `" lib/a.js"` into
 * `"lib/a.js"` — two different files collapsed into one evidence row, with the second one
 * shadowing the first. Git reports the path verbatim (`-z` output is never quoted), and a
 * declared path is the caller's spelling of the same thing, so both keep their whitespace.
 * Only the two transformations every consumer needs are applied: separators are normalised
 * to `/`, and a leading `./` is removed. Internal and edge whitespace is preserved.
 *
 * An empty string is not a path; a string of spaces IS one and is kept.
 */
export function normaliseGitPath(path) {
  if (typeof path !== 'string') return null
  let out = path.replace(/\\/g, '/')
  while (out.startsWith('./')) out = out.slice(2)
  return out === '' ? null : out
}

/**
 * The dedupe key for a normalised project-relative path.
 *
 * CASE-INSENSITIVE ONLY WHERE THE FILESYSTEM IS. Windows collapses `lib/A.js` and `lib/a.js`
 * into one file, so keeping both would report the same change twice. A case-sensitive
 * filesystem can hold BOTH names at once, and collapsing them there silently drops evidence —
 * a changed file that never appears in the review's file list.
 *
 * THE SAME KEY IS USED BY THE UNION AND BY `reconcileChangedFiles`, so the declared list and the
 * git list agree about what "the same path" means. Keying the reconciliation case-insensitively
 * while the union was exact would let a declared `src/App.js` cover a real `src/app.js` on Linux:
 * the path would be reported as complete while the changed file never reached the reviewer.
 *
 * `platform` is a parameter only so a test on any host can pin both rules; production callers
 * omit it.
 *
 * @param path - a normalised project-relative path.
 * @param platform - the platform whose case rule applies; defaults to this process's.
 * @returns the comparison key for that platform.
 */
export function dedupeKey(path, platform = process.platform) {
  return platform === 'win32' ? path.toLowerCase() : path
}

/**
 * Whether a normalised path is framework state rather than code.
 *
 * @param path - a project-relative path.
 * @returns true when the path is one of the framework's own files or a work unit's directory.
 */
export function isFrameworkStatePath(path) {
  const normalised = normaliseGitPath(path)
  if (normalised === null) return false
  const lower = normalised.toLowerCase()
  if (FRAMEWORK_STATE_PATHS.includes(lower)) return true
  return FRAMEWORK_STATE_PREFIXES.some(prefix => lower.startsWith(prefix))
}

/**
 * Parse `git status --porcelain -z` output into changed paths, untracked additions and
 * deletions.
 *
 * The v1 `-z` record format is `XY<space>path\0`, and a rename or copy appends the ORIGINAL
 * path as a second NUL-terminated record. Both sides are changes and both are returned: a
 * review of `lib/a.js -> lib/b.js` covers the deletion at the old name and the addition at the
 * new one.
 *
 * TRACKED, UNTRACKED AND DELETED ARE THREE DIFFERENT FACTS.
 *  - A `D` on EITHER side of `XY` is a deletion of that path: staged (`D `), unstaged (` D`),
 *    or both (`DD`).
 *  - A rename (`R` on either side) DELETES the old name and creates the new one, so the
 *    original record is a deletion as well as a path. A copy (`C`) leaves the original in
 *    place, so its old name is NOT a deletion.
 *  - The untracked additions (`??`) are returned separately as well as in `paths`.
 *
 * WHY DELETIONS ARE THEIR OWN LIST. A deleted path is real evidence — the classifier must see
 * it, and the reviewer must be told the change removes it — but it can never be part of the
 * DURABLE reviewed fingerprint: the file no longer exists, so a digest over it hashes a
 * constant, and a later freshness recheck would report UNKNOWN forever for a review that
 * legitimately covered the deletion. The caller therefore keeps the path in the evidence and
 * drops it from the durable set.
 *
 * @param output - the raw stdout.
 * @returns `{ paths, untracked, deleted, malformed }`; malformed records are counted, never
 *   thrown on.
 */
export function parsePorcelainZ(output) {
  const text = typeof output === 'string' ? output : ''
  const records = text.split('\0')
  const paths = []
  const untracked = []
  const deleted = []
  const deletedSeen = new Set()
  // One path may be reported twice (a rename's old name in a record and as a `D` path), and
  // the deletion fact is the same either way; deduplicate without reordering.
  const noteDeleted = path => {
    if (path === null || deletedSeen.has(path)) return
    deletedSeen.add(path)
    deleted.push(path)
  }
  let malformed = 0
  for (let index = 0; index < records.length; index += 1) {
    const record = records[index]
    if (record === '') continue
    // The minimum record is two status characters, a space and one character of path.
    if (record.length < 4 || record[2] !== ' ') {
      malformed += 1
      continue
    }
    const status = record.slice(0, 2)
    const path = normaliseGitPath(record.slice(3))
    if (path !== null) {
      paths.push(path)
      // `??` is the porcelain v1 spelling of "untracked". `!!` (ignored) is never requested
      // here: `--untracked-files=all` without `--ignored` cannot produce it.
      if (status === '??') untracked.push(path)
      if (status[0] === 'D' || status[1] === 'D') noteDeleted(path)
    }
    // `R`/`C` on EITHER side mean the next NUL record is the other name of the same change.
    if ((status[0] === 'R' || status[0] === 'C' || status[1] === 'R' || status[1] === 'C') && index + 1 < records.length) {
      const original = normaliseGitPath(records[index + 1])
      if (original !== null) {
        paths.push(original)
        // A RENAME removes the old name; a COPY does not. Only `R` is a deletion here.
        if (status[0] === 'R' || status[1] === 'R') noteDeleted(original)
      }
      index += 1
    }
  }
  return { paths, untracked, deleted, malformed }
}

/**
 * A path in the OS's canonical spelling.
 *
 * GIT PRINTS CANONICAL PATHS, AND CALLERS DO NOT. `git rev-parse --show-toplevel` returns the
 * real spelling, while the project directory can arrive spelled with an 8.3 short name
 * (`C:\Users\RUNNER~1\...`) or different letter case — which is exactly what GitHub's Windows
 * runners hand to a process through `%TEMP%`. `resolve()` preserves the caller's spelling, so
 * `relative(cwd, resolve(root, path))` then produced `..\..\...` for EVERY path: the
 * cross-check reported "git reports no changed paths" while `git status` listed plenty, and it
 * reported itself COMPLETE while doing so. An empty answer that looks authoritative is worse
 * than an error, because it silently removes the evidence that a declared subset cannot buy a
 * shallower class.
 *
 * Measured on GitHub run 40172196645 (windows-latest): 12 governance tests failed, all with
 * `paths: []` against `['README.md']`.
 *
 * @param path - any spelling of the path.
 * @returns the canonical path, or the resolved input when it cannot be resolved.
 */
function canonicalPath(path) {
  try {
    return realpathSync.native(path)
  } catch {
    return resolve(path)
  }
}

/**
 * Read the working tree's changes, relative to the reviewed project directory.
 *
 * NEVER THROWS. Every failure is a reported, documented note: `available` says whether git
 * could be started at all, `repository` says whether the directory is inside a work tree, and
 * `reason` always explains which of the two applied. A caller can therefore distinguish
 * "nothing changed" from "the cross-check could not run", which is the distinction that
 * matters — silence from a missing tool must not read as agreement.
 *
 * `failed` IS A THIRD STATE, DISTINCT FROM BOTH. When `git status` itself throws (an
 * `index.lock` left by a dead process, a timeout, a corrupt index), git could be started and
 * the directory IS a repository, yet the working tree was never read. That is not "the change
 * is bigger than the cap": reporting it as `complete: false` produced cap wording and a
 * cap remedy for a failure no amount of narrowing the working tree would fix. `failed: true`
 * and `checked: false` say the comparison did not happen, and the tool reports it as its own
 * state with a retry/repair remedy.
 *
 * @param projectDir - the reviewed project directory.
 * @param options - `{ run, cap, timeoutMs }`; `run` is a test/embedder seam.
 * @returns `{ available, repository, root, paths, untracked, deleted, excluded, checked,
 *   failed, complete, truncated, totalPaths, cap, malformed, outsideProject, command, reason }`.
 */
export function collectGitChanges(projectDir, options = {}) {
  const run = typeof options.run === 'function' ? options.run : defaultGitRunner
  const cap = Number.isInteger(options.cap) && options.cap > 0 ? options.cap : GIT_PATH_CAP
  const timeoutMs = Number.isInteger(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : GIT_TIMEOUT_MS
  const cwd = typeof projectDir === 'string' && projectDir !== '' ? canonicalPath(projectDir) : null
  const empty = reason => ({
    available: false,
    repository: false,
    root: null,
    paths: [],
    untracked: [],
    deleted: [],
    excluded: [],
    // A COMPARISON THAT DID NOT HAPPEN IS NOT A COMPLETE ONE. `complete` is only true when a
    // repository was read and the whole sorted path list fitted under the cap; every "we could
    // not look" outcome is explicitly incomplete rather than an empty, agreeing answer.
    checked: false,
    failed: false,
    complete: false,
    truncated: false,
    totalPaths: 0,
    cap,
    malformed: 0,
    outsideProject: 0,
    command: null,
    reason,
  })

  if (cwd === null) return empty('no project directory was resolved, so git was not consulted')

  // A DIRECTORY THAT IS NOT THERE IS NOT "GIT IS MISSING". `execFileSync` reports both as ENOENT,
  // and telling a caller to install git when the real problem is a bad `workspace_dir` sends the
  // fix in the wrong direction. Checked before anything is spawned.
  try {
    if (!statSync(cwd).isDirectory()) return empty(`${cwd} is not a directory, so git was not consulted`)
  } catch {
    return empty(`the reviewed directory does not exist (${cwd}), so git was not consulted`)
  }

  // 1. Is git runnable at all? A missing executable is NOT a project problem.
  let insideTree
  try {
    insideTree = String(
      run('git', [...GIT_REV_PARSE_ARGS], { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 }),
    ).trim()
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return empty('git is not installed or is not on PATH, so the declared file list could not be cross-checked')
    }
    return empty(`this directory is not readable as a git work tree (${describeError(error)})`)
  }
  if (insideTree !== 'true') {
    return empty('the reviewed project is not inside a git work tree, so the declared file list could not be cross-checked')
  }

  // 2. Where is the work tree? `git status` prints paths relative to the REPOSITORY ROOT even
  // when it runs in a subdirectory, and every path this module returns must be relative to the
  // REVIEWED DIRECTORY or the classifier would grade `sub/lib/a.js` differently in the two
  // places it is read.
  let root = null
  try {
    const printed = String(
      run('git', [...GIT_TOP_LEVEL_ARGS], { cwd, timeout: timeoutMs, maxBuffer: 1024 * 1024 }),
    ).trim()
    root = printed === '' ? null : canonicalPath(printed)
  } catch (error) {
    return {
      ...empty(`git could not report the repository root (${describeError(error)})`),
      available: true,
      repository: true,
      // A CHECK THAT DID NOT COMPLETE IS NOT A TRUNCATED ONE. Nothing was compared, so the
      // caller must not read this as "the change exceeded a cap".
      failed: true,
      checked: false,
    }
  }
  if (root === null) {
    return {
      ...empty('git reported an empty repository root, so changed paths could not be made project-relative'),
      available: true,
      repository: true,
      failed: true,
      checked: false,
    }
  }

  // 3. The status itself.
  let statusOutput
  try {
    statusOutput = run('git', [...GIT_STATUS_ARGS], { cwd, timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 })
  } catch (error) {
    return {
      ...empty(`git status failed (${describeError(error)}), so the declared file list could not be cross-checked`),
      available: true,
      repository: true,
      root,
      // THE CHECK FAILED; IT WAS NOT TRUNCATED. `index.lock`, a timeout and a corrupt index are
      // failures of the TOOL, and the caller must report a retry/repair remedy rather than
      // telling the user to narrow a working tree that was never even listed.
      failed: true,
      checked: false,
    }
  }

  const parsed = parsePorcelainZ(statusOutput)
  const untrackedRaw = new Set(parsed.untracked)
  const seen = new Set()
  const paths = []
  const untracked = []
  const deleted = []
  const excluded = []
  let outsideProject = 0
  for (const raw of parsed.paths) {
    const absolute = resolve(root, raw)
    const local = normaliseGitPath(relative(cwd, absolute).replace(/\\/g, '/'))
    if (local === null) continue
    // A path above the reviewed directory is outside the review's scope. `-- .` should already
    // have excluded it; this is the guard, not the mechanism.
    if (local === '..' || local.startsWith('../')) {
      outsideProject += 1
      continue
    }
    if (isFrameworkStatePath(local)) {
      if (!excluded.includes(local)) excluded.push(local)
      continue
    }
    if (seen.has(local)) continue
    seen.add(local)
    paths.push(local)
    // THE UNTRACKED FLAG TRAVELS WITH THE PATH. It comes from the porcelain status characters,
    // not from a guess about the filesystem, and it is the fact that decides whether the path
    // may enter the DURABLE reviewed fingerprint. It is still part of `paths` (and therefore of
    // the classification evidence and the reviewer's file list).
    if (untrackedRaw.has(raw)) untracked.push(local)
  }
  // DELETIONS ARE MADE PROJECT-RELATIVE THE SAME WAY, and travel in their own list. The skill
  // status is the porcelain fact, not a guess from `statSync`: a path may be deleted and
  // restored, or staged and then re-touched, between the status call and any later check.
  for (const raw of parsed.deleted) {
    const absolute = resolve(root, raw)
    const local = normaliseGitPath(relative(cwd, absolute).replace(/\\/g, '/'))
    if (local === null) continue
    if (local === '..' || local.startsWith('../')) continue
    if (isFrameworkStatePath(local)) continue
    if (!deleted.includes(local)) deleted.push(local)
  }

  // SORTED, so the report is deterministic. A test that asserted an order the operating system
  // happened to produce would be a test of the filesystem, not of this code.
  paths.sort()
  deleted.sort()
  excluded.sort()
  untracked.sort()
  const totalPaths = paths.length
  const truncated = totalPaths > cap
  // A PATH BEYOND THE CAP WAS NEVER COMPARED. Reporting `truncated` alone was not enough: the
  // reconciliation below still said `checked: true` with no mismatch, and a security surface
  // sorted after the cap could therefore be silently absent from the evidence. `complete` makes
  // that state explicit so `workflow_review` can refuse it instead of classifying a subset.
  const compared = truncated ? paths.slice(0, cap) : paths
  const comparedSet = new Set(compared)
  return {
    available: true,
    repository: true,
    root,
    paths: compared,
    // Bounded by the same cap as the evidence: an untracked path that was never compared cannot
    // legitimately be reported as an "untracked addition among the compared paths".
    untracked: untracked.filter(path => comparedSet.has(path)),
    // The same bound, for the same reason: a deletion outside the compared slice was never
    // evidence, so it must not be reported as one here either.
    deleted: deleted.filter(path => comparedSet.has(path)),
    excluded,
    checked: true,
    failed: false,
    complete: !truncated,
    truncated,
    totalPaths,
    cap,
    malformed: parsed.malformed,
    outsideProject,
    command: `git ${GIT_STATUS_ARGS.join(' ')}`,
    reason: truncated
      ? `the working tree reports ${totalPaths} changed path(s), more than the ${cap}-path cap; ` +
        `only the first ${cap} sorted path(s) were compared, so the comparison is INCOMPLETE`
      : totalPaths === 0
        ? 'git reports no changed paths in this project'
        : `git reports ${totalPaths} changed path(s) in this project`,
  }
}

/**
 * The project-relative display spelling of a repository root.
 *
 * `.` for the project itself, a project-relative directory for a work tree below it, and the
 * absolute root for a work tree ABOVE the project (a project can be a subdirectory of a larger
 * repository; a `..` path cannot name it).
 */
function displayRepoRoot(projectDir, root) {
  if (typeof root !== 'string' || root === '') return null
  const canonicalProject = canonicalPath(projectDir)
  const raw = relative(canonicalProject, root).replace(/\\/g, '/')
  if (raw === '' || raw === '.') return '.'
  if (raw.startsWith('..')) return root.replace(/\\/g, '/')
  return normaliseGitPath(raw) ?? root.replace(/\\/g, '/')
}

/**
 * Read the working tree's changes across the project's declared source directories.
 *
 * WHY THE PROJECT ROOT IS NOT ENOUGH. `collectGitChanges` answers "what changed in THIS
 * directory's work tree". A project can legitimately not be a checkout at its root while the
 * code lives in a subdirectory that IS one (the bilibili layout: only `dsh-bilibili-pro` is a
 * repository). Checking the root then reported NOT CHECKED forever, so the declaration was
 * never compared with anything even though git could read every source the project declared.
 * The cross-check therefore asks the project where its sources are (`verification.sources`)
 * and reads each one that resolves to a work tree.
 *
 * WHAT IS AND IS NOT READ.
 *  - A source that is a file, a glob pattern, or missing cannot be a work tree; it is SKIPPED
 *    and NAMED in `skippedSources` (and in the reason), never silently dropped.
 *  - A directory is read with `collectGitChanges`, so git availability, the work-tree check,
 *    the porcelain parser, the framework-state exclusions, the cap and the `failed` state are
 *    all the SAME rules the root-only path used — there is no second implementation here.
 *  - Every reported path is mapped to a PROJECT-relative path by prefixing the repository
 *    directory's project-relative location. A repository whose top level IS the project maps
 *    identically; one nested under the project contributes `sub/dir/<repo-relative path>`.
 *    Paths that would land outside the project (a source reached through a link) are dropped.
 *  - The union is deduplicated case-insensitively ONLY on Windows, where the filesystem collapses
 *    the spellings, and exactly on a case-sensitive filesystem, where two case-variant paths are
 *    two files and collapsing them would drop evidence. It is then sorted, and the SAME cap
 *    applies to the merged list. A source that was itself truncated makes the merged comparison
 *    incomplete, because its paths beyond the cap were never compared either.
 *  - A source that IS a work tree but whose read failed is named in `sourcesFailed`, never in
 *    `sourcesRead`, and the combined reason names it.
 *
 * @param projectDir - the reviewed project directory.
 * @param sources - the declared `verification.sources` entries.
 * @param options - `{ run, cap, timeoutMs }`; `run` is a test/embedder seam.
 * @returns a `collectGitChanges`-shaped result, plus `repoRoots`, `sourcesRead`, `sourcesFailed`
 *   and `skippedSources`.
 */
function collectGitChangesAcrossSources(projectDir, sources, options) {
  const cap = Number.isInteger(options.cap) && options.cap > 0 ? options.cap : GIT_PATH_CAP
  const canonicalProject = canonicalPath(projectDir)
  const skippedSources = []
  const repoRoots = []
  const seenRoots = new Set()
  const sourcesRead = []
  // A WORK TREE THAT WAS FOUND BUT COULD NOT BE READ IS NEITHER "READ" NOR "SKIPPED". It used to
  // be pushed into `sourcesRead` before the failure check, so the combined reason named the root
  // list (".") while the one fact needed — which source failed and why — was missing.
  const failedSources = []
  const seenSources = new Set()
  const seenDirs = new Set()
  const merged = new Map()
  const excludedSeen = new Set()
  const excluded = []
  const sourceTotals = []
  let repoCount = 0
  let failed = false
  let failedReason = ''
  let gitMissing = false
  let truncatedSource = false
  let malformed = 0
  let outsideProject = 0
  const note = (source, reason) => {
    if (skippedSources.length >= 50) return
    skippedSources.push({
      source: typeof source === 'string' ? source.slice(0, 120) : String(source).slice(0, 120),
      reason: (typeof reason === 'string' ? reason : String(reason)).slice(0, 300),
    })
  }
  const noteExcluded = path => {
    const key = dedupeKey(path)
    if (excludedSeen.has(key)) return
    excludedSeen.add(key)
    excluded.push(path)
  }

  for (const raw of sources) {
    let text = typeof raw === 'string' ? raw.trim().replace(/\\/g, '/') : null
    if (text === null) {
      note(String(raw), 'not a path string, so it was not read')
      continue
    }
    while (text.startsWith('./')) text = text.slice(2)
    text = text.replace(/\/+$/, '')
    if (text === '') {
      note(raw, 'an empty path, so it was not read')
      continue
    }
    if (text.startsWith('/') || /^[A-Za-z]:/.test(text) || text.split('/').includes('..')) {
      note(raw, 'not a project-relative directory, so it was not read')
      continue
    }
    // A classification pattern is not a directory. Expanding it here would be a second,
    // different scope rule; the honest answer is to name it as skipped.
    if (text.includes('*')) {
      note(raw, 'a pattern rather than a directory, so it was not read')
      continue
    }
    const absolute = resolve(projectDir, text)
    let stat = null
    try {
      stat = statSync(absolute)
    } catch {
      note(raw, 'the declared source does not exist in this project')
      continue
    }
    if (!stat.isDirectory()) {
      note(raw, 'the declared source is a file, not a directory')
      continue
    }
    const canonicalSource = canonicalPath(absolute)
    const dirKey = dedupeKey(canonicalSource)
    if (seenDirs.has(dirKey)) continue
    seenDirs.add(dirKey)

    const collected = collectGitChanges(absolute, options)
    if (collected.repository !== true) {
      if (collected.available === false && /git is not installed/i.test(collected.reason ?? '')) {
        gitMissing = true
      }
      note(raw, collected.reason ?? 'this source is not a git work tree')
      continue
    }
    // THE PREFIX IS COMPUTED FROM CANONICAL PATHS ON BOTH SIDES, for the same reason the
    // collector canonicalises its own directory: a junction ancestor or a different letter case
    // must not turn a real path into `../..`.
    const prefixRaw = relative(canonicalProject, canonicalSource).replace(/\\/g, '/')
    const prefix = prefixRaw === '' ? '' : normaliseGitPath(prefixRaw)
    if (prefix === null || prefix === '..' || prefix.startsWith('../')) {
      note(raw, 'the declared source resolves outside the project, so its paths were not read')
      continue
    }
    repoCount += 1
    const sourceDisplay = prefix === '' ? '.' : prefix
    // THE WORK TREE'S ROOT IS REPORTED EVEN WHEN ITS READ FAILED: the repository was found, and
    // the remedy points at it. Whether the source was READ is a separate fact, recorded below.
    if (typeof collected.root === 'string' && collected.root !== '') {
      const rootDisplay = displayRepoRoot(projectDir, collected.root)
      if (rootDisplay !== null) {
        const rootKey = dedupeKey(rootDisplay)
        if (!seenRoots.has(rootKey)) {
          seenRoots.add(rootKey)
          repoRoots.push(rootDisplay)
        }
      }
    }
    if (collected.failed === true) {
      failed = true
      // NAME THE FAILING SOURCE. The old code listed it in `sourcesRead` and named only the root
      // list in the reason, so the reader learned that SOMETHING failed but not which source, and
      // the audit claimed a source was read when it was not.
      failedSources.push({
        source: sourceDisplay,
        reason: (typeof collected.reason === 'string' ? collected.reason : 'the read failed').slice(0, 300),
      })
      if (failedReason === '') failedReason = collected.reason ?? ''
    } else {
      const sourceKey = dedupeKey(sourceDisplay)
      if (!seenSources.has(sourceKey)) {
        seenSources.add(sourceKey)
        sourcesRead.push(sourceDisplay)
      }
    }
    if (collected.truncated === true) truncatedSource = true
    if (Number.isInteger(collected.totalPaths)) sourceTotals.push(collected.totalPaths)
    const mapPath = local => (prefix === '' ? local : `${prefix}/${local}`)
    const usableProjectPath = mapped =>
      typeof mapped === 'string' &&
      mapped !== '' &&
      mapped !== '.' &&
      !mapped.startsWith('/') &&
      !/^[A-Za-z]:/.test(mapped) &&
      !mapped.split('/').includes('..')

    const untrackedRaw = new Set(Array.isArray(collected.untracked) ? collected.untracked : [])
    for (const local of Array.isArray(collected.paths) ? collected.paths : []) {
      const mapped = mapPath(local)
      if (!usableProjectPath(mapped)) continue
      if (isFrameworkStatePath(mapped)) {
        noteExcluded(mapped)
        continue
      }
      const key = dedupeKey(mapped)
      let item = merged.get(key)
      if (item === undefined) {
        item = { path: mapped, untracked: false, deleted: false }
        merged.set(key, item)
      }
      if (untrackedRaw.has(local)) item.untracked = true
    }
    // Deletions travel in their own list in the collector; a deleted path may already be in
    // `paths` (a rename's old name), so this only adds the deletion fact and any path the
    // collector reported solely because it was removed.
    for (const local of Array.isArray(collected.deleted) ? collected.deleted : []) {
      const mapped = mapPath(local)
      if (!usableProjectPath(mapped)) continue
      if (isFrameworkStatePath(mapped)) {
        noteExcluded(mapped)
        continue
      }
      const key = dedupeKey(mapped)
      let item = merged.get(key)
      if (item === undefined) {
        item = { path: mapped, untracked: false, deleted: false }
        merged.set(key, item)
      }
      item.deleted = true
    }
    for (const local of Array.isArray(collected.excluded) ? collected.excluded : []) {
      const mapped = mapPath(local)
      if (usableProjectPath(mapped)) noteExcluded(mapped)
    }
    if (Number.isInteger(collected.malformed)) malformed += collected.malformed
    if (Number.isInteger(collected.outsideProject)) outsideProject += collected.outsideProject
  }

  if (repoCount === 0) {
    // NO WORK TREE WAS READ: the honest NOT CHECKED outcome, with the sources named so the
    // reader can fix the declaration instead of guessing why git was not consulted.
    const declaredNames = sources
      .map(source => (typeof source === 'string' ? source : String(source)))
      .join(', ')
      .slice(0, 300)
    const skippedText = skippedSources
      .slice(0, 6)
      .map(entry => `${entry.source} (${entry.reason})`)
      .join('; ')
    return {
      available: false,
      repository: false,
      root: null,
      paths: [],
      untracked: [],
      deleted: [],
      excluded: [],
      checked: false,
      failed: false,
      complete: false,
      truncated: false,
      totalPaths: 0,
      cap,
      malformed,
      outsideProject,
      command: null,
      reason: gitMissing
        ? `git is not installed or is not on PATH, so none of the declared verification.sources ` +
          `(${declaredNames}) could be cross-checked`
        : `none of the declared verification.sources resolves to a git work tree (${declaredNames})` +
          (skippedText === '' ? '' : `; skipped: ${skippedText}`) +
          ', so the declared file list could not be cross-checked',
      repoRoots: [],
      sourcesRead: [],
      // NO WORK TREE FAILED EITHER: none was even found, which `skippedSources` names.
      sourcesFailed: [],
      skippedSources,
      projectRootRead: false,
    }
  }

  const all = [...merged.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )
  const totalPaths = truncatedSource
    ? Math.max(
        all.length,
        ...sourceTotals.map(total => total),
      )
    : all.length
  const truncated = truncatedSource || totalPaths > cap
  // A PER-SOURCE TOTAL IS EXACT only when one work tree was read; with several sources the
  // merged count can under-count overlapping paths, so it is a LOWER BOUND and the message says
  // "at least". Never claim "more than 500" when the collector computed exactly 500.
  const exactTotal = !truncatedSource || sourceTotals.length <= 1
  const compared = truncated ? all.slice(0, cap) : all
  const paths = compared.map(item => item.path)
  const excludedSorted = [...excluded].sort()
  const repoRootsText = repoRoots.length === 0
    ? '(not reported)'
    : repoRoots.slice(0, 8).join(', ') + (repoRoots.length > 8 ? ` (+${repoRoots.length - 8} more)` : '')
  const skippedText = skippedSources.length === 0
    ? ''
    : `; source(s) not read as work trees: ` +
      skippedSources.slice(0, 6).map(entry => `${entry.source} (${entry.reason})`).join(', ') +
      (skippedSources.length > 6 ? ` (+${skippedSources.length - 6} more)` : '')
  // THE FAILING SOURCE IS NAMED, NOT JUST THE ROOT LIST. `repoRootsText` often contains "." (the
  // project root), which is what made "the combined failure reason names only '.'" possible: the
  // reader could not tell which declared source failed. The structured `failedSources` list makes
  // the same fact available to a renderer.
  const failedText = failedSources.length === 0
    ? String(failedReason ?? '').slice(0, 300)
    : failedSources
        .slice(0, 4)
        .map(entry => `${entry.source} (${entry.reason})`)
        .join('; ') + (failedSources.length > 4 ? ` (+${failedSources.length - 4} more)` : '')
  const reason = failed
    ? `git could not read at least one source work tree (${repoRootsText}), so the comparison is ` +
      `INCOMPLETE — the failing source(s): ${failedText}`
    : truncated
      ? `the source work trees report ${exactTotal ? '' : 'at least '}${totalPaths} changed path(s) ` +
        `(${repoRootsText}), more than the ${cap}-path cap; only the first ${compared.length} sorted ` +
        'path(s) were compared, so the comparison is INCOMPLETE'
      : totalPaths === 0
        ? `git reports no changed paths in the source work tree(s) read (${repoRootsText})${skippedText}`
        : `git reports ${totalPaths} changed path(s) in the source work tree(s) read (${repoRootsText})${skippedText}`
  return {
    available: true,
    repository: true,
    root: repoRoots.length > 0 ? repoRoots[0] : null,
    paths,
    untracked: compared.filter(item => item.untracked).map(item => item.path),
    deleted: compared.filter(item => item.deleted).map(item => item.path),
    excluded: excludedSorted,
    checked: !failed,
    failed,
    complete: !truncated && !failed,
    truncated,
    totalPaths,
    cap,
    malformed,
    outsideProject,
    command: 'git status --porcelain -z --untracked-files=all -- . (per source work tree)',
    reason,
    repoRoots,
    sourcesRead,
    sourcesFailed: failedSources,
    skippedSources,
    projectRootRead: false,
  }
}

/**
 * Reconcile the caller's declared file list with what git actually reports.
 *
 * THE RULE, IN ONE SENTENCE: the union is the evidence. A path the working tree reports and
 * the declaration omits is ADDED, because a review that does not cover it is a review of a
 * different artefact; a path the declaration names and git does not report is KEPT and noted,
 * because a file can legitimately be part of a change that was already committed and because
 * dropping it would remove the caller's own evidence.
 *
 * BUT EVIDENCE FOR THE CLASS IS NOT THE SAME AS THE DURABLE FINGERPRINT. `durable` is the
 * declared reviewed set plus the TRACKED modifications git added, minus any path git reports as
 * DELETED. Three exclusions, for three separate reasons:
 *  - an untracked (`??`) addition is kept out because deleting a scratch file after a review
 *    must not flip that review to STALE;
 *  - a DELETED tracked path is kept out because the file no longer exists, so a digest over it
 *    hashes a constant and every later freshness recheck reports UNKNOWN for a review that
 *    legitimately covered the deletion. The deletion is still classification/prompt evidence
 *    and is reported in `deleted`;
 *  - both remain in `evidence`, which is a different set from `durable`.
 *
 * `unchecked` is not `matched`: when git is unavailable the declared list stands, the result
 * says `checked: false`, and the reason travels with it so nothing downstream can print
 * "no mismatch" for a comparison that never happened. A comparison that ran but hit the path cap
 * says `complete: false`; that is a different state from both `checked:false` and a verified
 * match, and `workflow_review` refuses it rather than classifying a truncated subset. A git call
 * that THREW says `checked: false, failed: true`: it is not a truncated scan and must never be
 * described as one.
 *
 * @param declared - the caller's `changed_files` (or anything).
 * @param git - the {@link collectGitChanges} result.
 * @returns `{ checked, failed, complete, declared, declaredUnusable, actual, untracked, deleted,
 *   missing, unused, durable, evidence, mismatch, reason }`.
 */
export function reconcileChangedFiles(declared, git) {
  const declaredRows = Array.isArray(declared) ? declared : []
  const declaredPaths = []
  const declaredUnusable = []
  // THE SAME PLATFORM RULE THE UNION USES. A case typo in the declaration is a DIFFERENT file on
  // a case-sensitive filesystem, so it must be ADDED to the evidence rather than counted as
  // covering the real path: otherwise `missing` is empty, `mismatch` is false, and the reviewer
  // prompt, classifier and fingerprint all name a file that did not change while the changed one
  // is never reviewed. On win32 the spellings are one file and stay case-insensitive.
  const keyOf = path => dedupeKey(path)
  const declaredKeys = new Map()
  for (const entry of declaredRows) {
    const normalised = normaliseGitPath(entry)
    if (normalised === null) {
      declaredUnusable.push(entry)
      continue
    }
    if (declaredKeys.has(keyOf(normalised))) continue
    declaredKeys.set(keyOf(normalised), normalised)
    declaredPaths.push(entry)
  }

  // A FAILED GIT CALL IS NOT A COMPARISON. `failed: true` (a throwing `git status`, an
  // unreadable repository root) carries an empty `paths` array just like a genuinely clean
  // tree, so requiring only `available`/`repository`/`paths` reported a comparison that never
  // happened as `checked: true, complete: false` — and the tool then printed cap wording
  // ("narrow the working tree") for an index.lock. `failed` is checked explicitly.
  const failed = git?.failed === true
  const checked =
    git?.available === true && git?.repository === true && Array.isArray(git?.paths) && !failed
  if (!checked) {
    return {
      checked: false,
      failed,
      // NO COMPARISON RAN, so nothing about the change was verified as complete. The declared
      // list is still the durable reviewed set: there is no git-side fact to exclude from it.
      complete: false,
      declared: declaredPaths,
      declaredUnusable,
      actual: [],
      untracked: [],
      deleted: [],
      missing: [],
      unused: [],
      durable: [...declaredPaths],
      evidence: [...declaredRows],
      mismatch: false,
      reason:
        typeof git?.reason === 'string' && git.reason !== ''
          ? git.reason
          : 'the working tree could not be read, so the declared file list was not cross-checked',
    }
  }

  const actual = git.paths
  const actualKeys = new Set(actual.map(path => keyOf(path)))
  const missing = actual.filter(path => !declaredKeys.has(keyOf(path)))
  const unused = declaredPaths.filter(entry => {
    const normalised = normaliseGitPath(entry)
    return normalised !== null && !actualKeys.has(keyOf(normalised))
  })

  // THE UNTRACKED SPLIT. `git.untracked` is the set reported with `??`; a missing path in that
  // set is an untracked ADDITION. It remains evidence but is kept out of `durable`, so removing
  // the scratch file cannot turn a fresh PASS into a false STALE.
  const untrackedKeys = new Set(
    (Array.isArray(git.untracked) ? git.untracked : []).map(path => keyOf(path)),
  )
  const untrackedAdded = missing.filter(path => untrackedKeys.has(keyOf(path)))
  const trackedAdded = missing.filter(path => !untrackedKeys.has(keyOf(path)))

  // THE DELETED SET IS EVIDENCE, NOT FINGERPRINT. A path git reports as deleted may be declared
  // or added by the reconciliation; either way it cannot be re-read after the review, so folding
  // it into the durable set would make the recorded digest a constant and the later freshness
  // recheck permanently UNKNOWN. It stays in `evidence` (and in its own `deleted` list, so the
  // fact is reported) and leaves `durable`.
  const deleted = (Array.isArray(git.deleted) ? git.deleted : []).filter(
    path => typeof path === 'string' && path !== '',
  )
  const deletedKeys = new Set(deleted.map(path => keyOf(path)))
  const durable = [...declaredPaths, ...trackedAdded].filter(
    path => !deletedKeys.has(keyOf(path)),
  )

  // DECLARED SPELLING FIRST, then the git-side spelling for anything the declaration missed:
  // the classifier normalises both, and keeping the caller's spelling makes the report
  // recognisable to the caller.
  const evidence = [...declaredRows]
  for (const path of missing) evidence.push(path)

  // `complete` is false when the comparison hit the cap. A record from an older collector that
  // carries no `complete` field is treated as complete for the subset it did compare — it never
  // produced a capped list in the first place (`truncated` did not exist before this version).
  // The checked-but-incomplete state keeps the compared subset as information, but it must be
  // visible on the record itself: `mismatch: false` from a truncated scan is not a clearance.
  const complete = git.complete !== false && git.truncated !== true

  return {
    checked: true,
    failed: false,
    complete,
    declared: declaredPaths,
    declaredUnusable,
    actual,
    untracked: untrackedAdded,
    deleted,
    missing,
    unused,
    durable,
    evidence,
    mismatch: missing.length > 0,
    reason: complete
      ? missing.length === 0
        ? actual.length === 0
          ? 'git reports no changed paths; the declared list was accepted as the change'
          : `the declared list covers every one of the ${actual.length} path(s) git reports`
        : `${missing.length} changed path(s) git reports were missing from the declaration and were added to the evidence: ${missing.slice(0, 8).join(', ')}`
      : `the git comparison is INCOMPLETE — ${
          typeof git.reason === 'string' && git.reason !== ''
            ? git.reason.slice(0, 300)
            : `only the first ${Number.isInteger(git.cap) ? git.cap : GIT_PATH_CAP} sorted path(s) were compared`
        }${
          missing.length > 0
            ? `; within the compared slice, ${missing.length} path(s) were missing from the declaration`
            : '; nothing in the compared slice was missing, but a path beyond the cap was never checked'
        }`,
  }
}

/**
 * Merge the project-root read with the per-source reads into one synthetic result.
 *
 * THE ROOT READ IS NOT REPLACED BY THE SOURCE READS. `verification.sources` says which trees
 * are the project's source; it does NOT say the rest of the working tree is out of scope. A
 * project that IS a checkout must keep reporting `package.json`, CI files and docs, or a caller
 * could omit one of those from `changed_files` and the cross-check would call the omission a
 * complete comparison — exactly the fail-open the cross-check exists to prevent. So when the
 * project root is a work tree the root result is kept, and the per-source reads are UNIONED in
 * on top of it (a source may itself be a NESTED repository, which the root's `git status` does
 * not descend into). When the root is not a work tree, the per-source result stands alone.
 *
 * Failure, cap and framework-state semantics are the union of the two inputs: a failed read on
 * either side fails the comparison, and a truncated read on either side makes it incomplete.
 */
function combineGitSources(projectDir, rootGit, sourceGit) {
  const rootRead = rootGit?.repository === true
  const sourceRead = sourceGit?.repository === true
  if (!rootRead && !sourceRead) {
    // The per-source result is the honest NOT CHECKED one: it names the declared sources.
    return sourceGit
  }
  const sourceRoots = Array.isArray(sourceGit?.repoRoots) ? sourceGit.repoRoots : []
  const sourcesRead = Array.isArray(sourceGit?.sourcesRead) ? sourceGit.sourcesRead : []
  const sourcesFailed = Array.isArray(sourceGit?.sourcesFailed) ? sourceGit.sourcesFailed : []
  const skippedSources = Array.isArray(sourceGit?.skippedSources) ? sourceGit.skippedSources : []
  if (rootRead && !sourceRead) {
    const rootDisplay = displayRepoRoot(projectDir, rootGit.root)
    return {
      ...rootGit,
      repoRoots: rootDisplay === null ? [] : [rootDisplay],
      sourcesRead,
      sourcesFailed,
      skippedSources,
      projectRootRead: true,
      // The root read already covers the project; naming the sources records what was consulted
      // so the audit cannot imply it read only the root or only the sources.
      command: `${rootGit.command ?? 'git status --porcelain'} (the declared source entries were also resolved)`,
      reason: rootGit.reason,
    }
  }
  if (!rootRead && sourceRead) {
    return { ...sourceGit, projectRootRead: false }
  }

  // BOTH WERE READ: union the paths, attributes and exclusions.
  const cap =
    Number.isInteger(rootGit.cap) && rootGit.cap > 0
      ? rootGit.cap
      : Number.isInteger(sourceGit.cap) && sourceGit.cap > 0
        ? sourceGit.cap
        : GIT_PATH_CAP
  const merged = new Map()
  const add = (path, untracked, deleted) => {
    if (typeof path !== 'string' || path === '') return
    const key = dedupeKey(path)
    let item = merged.get(key)
    if (item === undefined) {
      item = { path, untracked: false, deleted: false }
      merged.set(key, item)
    }
    if (untracked) item.untracked = true
    if (deleted) item.deleted = true
  }
  const rootUntracked = new Set(Array.isArray(rootGit.untracked) ? rootGit.untracked : [])
  const rootDeleted = new Set(Array.isArray(rootGit.deleted) ? rootGit.deleted : [])
  for (const path of Array.isArray(rootGit.paths) ? rootGit.paths : []) {
    add(path, rootUntracked.has(path), rootDeleted.has(path))
  }
  const sourceUntracked = new Set(Array.isArray(sourceGit.untracked) ? sourceGit.untracked : [])
  const sourceDeleted = new Set(Array.isArray(sourceGit.deleted) ? sourceGit.deleted : [])
  for (const path of Array.isArray(sourceGit.paths) ? sourceGit.paths : []) {
    add(path, sourceUntracked.has(path), sourceDeleted.has(path))
  }
  const all = [...merged.values()].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )
  const truncated =
    rootGit.truncated === true || sourceGit.truncated === true || all.length > cap
  // A UNION OF TWO CAP-LIMITED READS IS A LOWER BOUND, never an exact total.
  const totalPaths = truncated
    ? Math.max(
        all.length,
        Number.isInteger(rootGit.totalPaths) ? rootGit.totalPaths : 0,
        Number.isInteger(sourceGit.totalPaths) ? sourceGit.totalPaths : 0,
      )
    : all.length
  const compared = truncated ? all.slice(0, cap) : all
  const paths = compared.map(item => item.path)
  const excludedSeen = new Set()
  const excluded = []
  for (const path of [
    ...(Array.isArray(rootGit.excluded) ? rootGit.excluded : []),
    ...(Array.isArray(sourceGit.excluded) ? sourceGit.excluded : []),
  ]) {
    if (typeof path !== 'string' || excludedSeen.has(dedupeKey(path))) continue
    excludedSeen.add(dedupeKey(path))
    excluded.push(path)
  }
  const failed = rootGit.failed === true || sourceGit.failed === true
  const rootDisplay = displayRepoRoot(projectDir, rootGit.root)
  const rootSeen = new Set()
  const roots = []
  for (const root of [rootDisplay, ...sourceRoots]) {
    if (typeof root !== 'string' || root === '') continue
    const key = dedupeKey(root)
    if (rootSeen.has(key)) continue
    rootSeen.add(key)
    roots.push(root)
  }
  const rootsText =
    roots.slice(0, 8).join(', ') + (roots.length > 8 ? ` (+${roots.length - 8} more)` : '')
  // THE COMBINED REASON NAMES WHICH SIDE FAILED AND, FOR A SOURCE, WHICH ONE. Picking a single
  // reason string (root first) is how a failed nested source got reduced to the root list ".".
  const failedDetail = []
  if (rootGit.failed === true) {
    failedDetail.push(
      `the project root could not be read (${String(rootGit.reason ?? 'no reason recorded').slice(0, 300)})`,
    )
  }
  if (sourceGit.failed === true) {
    const sourceFailedText = sourcesFailed
      .slice(0, 4)
      .map(entry => `${entry.source} (${entry.reason})`)
      .join('; ')
    failedDetail.push(
      sourcesFailed.length > 0
        ? `declared source work tree(s): ${sourceFailedText}${sourcesFailed.length > 4 ? ` (+${sourcesFailed.length - 4} more)` : ''}`
        : `a declared source work tree could not be read (${String(sourceGit.reason ?? 'no reason recorded').slice(0, 300)})`,
    )
  }
  const failedText = failedDetail.length > 0 ? failedDetail.join('; ') : 'no reason recorded'
  const reason = failed
    ? `git could not read at least one work tree (${rootsText}), so the comparison is INCOMPLETE — ${failedText}`
    : truncated
      ? `the project and source work trees report at least ${totalPaths} changed path(s) ` +
        `(${rootsText}), more than the ${cap}-path cap; only the first ${compared.length} sorted ` +
        'path(s) were compared, so the comparison is INCOMPLETE'
      : totalPaths === 0
        ? `git reports no changed paths across the project work tree and declared source work trees (${rootsText})`
        : `git reports ${totalPaths} changed path(s) across the project work tree and declared source work trees (${rootsText})`
  return {
    available: true,
    repository: true,
    root: roots.length > 0 ? roots[0] : null,
    paths,
    untracked: compared.filter(item => item.untracked).map(item => item.path),
    deleted: compared.filter(item => item.deleted).map(item => item.path),
    excluded: excluded.sort(),
    checked: !failed,
    failed,
    complete: !truncated && !failed,
    truncated,
    totalPaths,
    cap,
    malformed:
      (Number.isInteger(rootGit.malformed) ? rootGit.malformed : 0) +
      (Number.isInteger(sourceGit.malformed) ? sourceGit.malformed : 0),
    outsideProject:
      (Number.isInteger(rootGit.outsideProject) ? rootGit.outsideProject : 0) +
      (Number.isInteger(sourceGit.outsideProject) ? sourceGit.outsideProject : 0),
    command: 'git status --porcelain -z --untracked-files=all -- . (project root and declared source work trees)',
    reason,
    repoRoots: roots,
    sourcesRead,
    sourcesFailed,
    skippedSources,
    projectRootRead: true,
  }
}

/**
 * Collect and reconcile in one call, for the tool layer.
 *
 * Returns `null` when no declaration was supplied: with no claim there is nothing to check,
 * and inventing a git-derived file list here would change the meaning of "no evidence" (which
 * the depth policy deliberately treats as fail-closed) instead of auditing a claim.
 *
 * `options.sources` IS THE DECLARED SOURCE LIST. When it is present, each entry is resolved to a
 * directory and the git collector runs THERE, so a project whose root is not a checkout but
 * whose source directory is one is checked rather than reported NOT CHECKED. The project ROOT is
 * still read when it is itself a work tree, and the two results are unioned: a declared source
 * list narrows nothing — it only adds the work trees a root-only read cannot see. When no
 * sources are declared, the collector runs once on the project itself, exactly as before. The
 * reason carries which work trees and sources were read (and which entries were skipped)
 * whenever the per-source path ran, so the audit can never imply a read it did not perform.
 *
 * @param projectDir - the reviewed project directory.
 * @param declared - the caller's `changed_files`, or null/undefined when absent.
 * @param options - `{ run, cap, timeoutMs, sources }`.
 * @returns the reconciled record (with the git facts folded in), or null.
 */
export function crossCheckChangedFiles(projectDir, declared, options = {}) {
  if (declared === undefined || declared === null) return null
  const hasSources = Array.isArray(options.sources) && options.sources.length > 0
  const git = hasSources
    ? combineGitSources(
        projectDir,
        collectGitChanges(projectDir, options),
        collectGitChangesAcrossSources(projectDir, options.sources, options),
      )
    : collectGitChanges(projectDir, options)
  const reconciled = reconcileChangedFiles(declared, git)
  // WHICH WORK TREES WERE READ BELONGS IN THE REASON, not only in a structured field the
  // renderers do not know about. `reconcileChangedFiles` builds its own sentence for the
  // checked-and-complete case, so the scope note is appended only there: the failed and
  // truncated reasons already embed the per-source collector's reason (which names the work
  // trees), and appending again would say it twice.
  const scopeNote =
    reconciled.checked === true && reconciled.complete === true ? describeCrossCheckScope(git) : ''
  return {
    ...reconciled,
    reason: scopeNote === '' ? reconciled.reason : `${reconciled.reason} (${scopeNote})`,
    repository: git.repository === true,
    available: git.available === true,
    // A FAILED CALL AND A TRUNCATED ONE ARE DIFFERENT FACTS, and this flag is what lets the tool
    // report the failure with a retry remedy instead of cap wording.
    failed: reconciled.failed === true,
    // THE CAP AND THE TOTAL TRAVEL WITH THE INCOMPLETE ANSWER. A reader has to be able to say
    // how many paths were compared and how many existed, or "incomplete" is a word with no fix.
    complete: reconciled.complete === true,
    truncated: git.truncated === true,
    pathCap: Number.isInteger(git.cap) ? git.cap : GIT_PATH_CAP,
    totalPaths: Number.isInteger(git.totalPaths) ? git.totalPaths : reconciled.actual.length,
    // Deleted paths are EVIDENCE and are reported here, but they are excluded from the durable
    // fingerprint (see `durable`), so this list is bounded and separate from `paths`.
    deleted: reconciled.deleted,
    deletedTotal: reconciled.deleted.length,
    excluded: Array.isArray(git.excluded) ? git.excluded : [],
    command: git.command ?? null,
    // Only the per-source path produces these; the root-only path keeps its historical shape.
    ...(Array.isArray(git.repoRoots) ? { repoRoots: git.repoRoots } : {}),
    ...(Array.isArray(git.sourcesRead) ? { sourcesRead: git.sourcesRead } : {}),
    // A WORK TREE THAT WAS FOUND BUT COULD NOT BE READ. Separate from `sourcesRead` (success) and
    // `skippedSources` (never a work tree), so an audit can tell all three apart.
    ...(Array.isArray(git.sourcesFailed) ? { sourcesFailed: git.sourcesFailed } : {}),
    ...(Array.isArray(git.skippedSources) ? { skippedSources: git.skippedSources } : {}),
  }
}

/**
 * One bounded sentence naming the work trees and declared sources read, and the entries skipped.
 *
 * Empty when the root-only collector ran, so the historical reason is unchanged.
 */
function describeCrossCheckScope(git) {
  const roots = Array.isArray(git?.repoRoots) ? git.repoRoots : null
  if (roots === null || roots.length === 0) return ''
  const sourcesRead = Array.isArray(git.sourcesRead) ? git.sourcesRead : []
  // A source that IS a repository root is already named by the root list; only the additional
  // directories consulted inside a shared work tree need naming.
  const extraSources = sourcesRead.filter(
    source => !roots.some(root => root.toLowerCase() === source.toLowerCase()),
  )
  const skipped = Array.isArray(git.skippedSources) ? git.skippedSources : []
  const rootText = roots.slice(0, 8).join(', ') + (roots.length > 8 ? ` (+${roots.length - 8} more)` : '')
  let text = `git work tree(s) read: ${rootText}`
  if (extraSources.length > 0) {
    text +=
      `; declared source(s) also read: ${extraSources.slice(0, 8).join(', ')}` +
      (extraSources.length > 8 ? ` (+${extraSources.length - 8} more)` : '')
  }
  if (skipped.length > 0) {
    text +=
      (git.projectRootRead === true
        ? '; source entries not read as directories (the project-root read covered them): '
        : '; source(s) not read as work trees: ') +
      skipped
        .slice(0, 4)
        .map(entry => `${entry.source} (${entry.reason})`)
        .join(', ') +
      (skipped.length > 4 ? ` (+${skipped.length - 4} more)` : '')
  }
  return text
}
