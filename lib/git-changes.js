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
  const keyOf = path => path.toLowerCase()
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
 * Collect and reconcile in one call, for the tool layer.
 *
 * Returns `null` when no declaration was supplied: with no claim there is nothing to check,
 * and inventing a git-derived file list here would change the meaning of "no evidence" (which
 * the depth policy deliberately treats as fail-closed) instead of auditing a claim.
 *
 * @param projectDir - the reviewed project directory.
 * @param declared - the caller's `changed_files`, or null/undefined when absent.
 * @param options - `{ run, cap, timeoutMs }`.
 * @returns the reconciled record (with the git facts folded in), or null.
 */
export function crossCheckChangedFiles(projectDir, declared, options = {}) {
  if (declared === undefined || declared === null) return null
  const git = collectGitChanges(projectDir, options)
  const reconciled = reconcileChangedFiles(declared, git)
  return {
    ...reconciled,
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
  }
}
