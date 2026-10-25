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
 * Content hashes are taken while the project is small enough to make them cheap.
 * Beyond the budget the fence falls back to size+mtime and SAYS SO in the report, so
 * "verified" never quietly means less than it claims.
 */
export const DEFAULT_HASH_BUDGET = 64 * 1024 * 1024

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
 * The git index is a COLD CACHE that `git status` — which the reviewer prompt tells the
 * reviewer to run — rewrites by design. Treating that refresh as contamination would fail
 * every review that followed its own instructions.
 */
const MTIME_INSENSITIVE_PREFIXES = Object.freeze(['.git/index', '.git/index.lock'])

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

/** Whether a relative key is one whose mtime alone is not evidence of a change. */
function mtimeInsensitive(relKey) {
  return MTIME_INSENSITIVE_PREFIXES.some(prefix => relKey === prefix || relKey.startsWith(`${prefix}.`))
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

      if (entries.size >= maxFiles) {
        return failure(
          `the reviewer snapshot is over the ${maxFiles}-entry cap`,
          'Refusing to snapshot a project this size leaves it unprotected, so the review stops instead.',
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
        return failure(
          `the reviewer snapshot is over the ${Math.round(maxBytes / 1024 / 1024)} MB cap`,
          'A partial snapshot cannot restore what it does not contain, so the review stops instead.',
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

  return { ok: true, root, entries, bytes, hashed, unhashed, links, files: entries.size }
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
      `${JSON.stringify({ plugin: 'dsh-workflow', kind: 'review-snapshot', projectDir: projectRoot, at: new Date().toISOString() }, null, 2)}\n`,
    )
    // `dereference: true` turns the in-project links the scan allowed into real files,
    // so the snapshot itself contains no link that a future delete could follow.
    cpSync(projectRoot, workDir, { recursive: true, dereference: true, force: true })
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
  const copied = scanProject(workDir, { maxBytes: Infinity, maxFiles: Infinity, hashBudget: 0 })
  if (!copied.ok) {
    removeReviewSnapshot({ rootDir, workDir, canaryPath, projectDir: projectRoot })
    return failure('the reviewer copy could not be verified', copied.reason)
  }
  if (copied.links > 0) {
    removeReviewSnapshot({ rootDir, workDir, canaryPath, projectDir: projectRoot })
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
  }
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

  let current
  if (!existsSync(projectRoot)) {
    // THE PROJECT ROOT IS GONE. Every snapshot entry is a deletion to restore.
    current = { ok: true, entries: new Map() }
  } else {
    current = scanProject(projectRoot, { maxBytes: Infinity, maxFiles: Infinity, hashBudget: DEFAULT_HASH_BUDGET })
    if (!current.ok) {
      // An unreadable project after the review is itself contamination we cannot
      // enumerate. It is reported as unclean with no restore attempted.
      return {
        ok: true,
        clean: false,
        rootMissing: false,
        unreadable: true,
        reason: current.reason,
        added: [],
        modified: [],
        deleted: [],
        touched: [],
        restored: [],
        restoreErrors: [],
      }
    }
  }

  const deleted = []
  const modified = []
  const touched = []
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

    if (before.size !== after.size) {
      modified.push(relKey)
      continue
    }
    if (before.hash !== null && after.hash !== null) {
      if (before.hash !== after.hash) modified.push(relKey)
      continue
    }
    if (before.mtimeMs !== after.mtimeMs && !mtimeInsensitive(relKey)) {
      // No content hash on both sides, so mtime is all there is. Report it as a
      // possible change rather than pretending it was verified.
      touched.push(relKey)
    }
  }
  for (const relKey of current.entries.keys()) {
    if (!snapshot.baseline.has(relKey)) added.push(relKey)
  }

  const restored = []
  const restoreErrors = []
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
      mkdirSync(dirname(absolute), { recursive: true })
      copyFileSync(copy, absolute)
      restored.push(relKey)
    } catch (error) {
      restoreErrors.push(`${relKey} (${error?.code ?? error})`)
    }
  }

  const clean =
    deleted.length === 0 && modified.length === 0 && added.length === 0 && restoreErrors.length === 0

  return {
    ok: true,
    clean,
    rootMissing: !existsSync(projectRoot),
    unreadable: false,
    added,
    modified,
    deleted,
    touched,
    restored,
    restoreErrors,
    restoredFrom: snapshot.workDir,
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
    const inside = scanProject(workDir, { maxBytes: Infinity, maxFiles: Infinity, hashBudget: 0 })
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
      return {
        ...failure(
          `the reviewer copy could not be removed (${error?.code ?? error}) and was kept`,
          'Something still holds it (a review that launched its own child processes); delete it when they exit.',
        ),
        kept: true,
        path: workDir,
      }
    }
  }

  if (!existsSync(canaryPath)) {
    return {
      ...failure(
        'the canary outside the reviewer copy disappeared, so the delete is treated as unsafe',
        'The snapshot root is left in place for inspection.',
      ),
      kept: true,
      path: rootDir,
    }
  }

  // THE ROOT IS ONLY REMOVED WHEN IT IS PROVABLY OURS. Without the marker a swapped-in
  // path would be deleted on the strength of the caller's word alone.
  let marker = null
  try {
    marker = JSON.parse(readFileSync(markerPath, 'utf8'))
  } catch (error) {
    return {
      ...failure(
        `refusing to delete the snapshot root: ${markerPath} is missing or unreadable (${error?.code ?? error})`,
        'The root is left in place; only the copy itself was removed.',
      ),
      kept: true,
      path: rootDir,
    }
  }
  if (marker?.plugin !== 'dsh-workflow' || marker?.kind !== 'review-snapshot') {
    return {
      ...failure('refusing to delete the snapshot root: it is not a dsh-workflow review snapshot'),
      kept: true,
      path: rootDir,
    }
  }

  try {
    // Same bounded retry window as the copy: the root can be held by the same children.
    rm(rootDir, { recursive: true, force: true, ...SNAPSHOT_REMOVE_RETRY })
  } catch (error) {
    return {
      ...failure(`the snapshot root could not be removed (${error?.code ?? error})`),
      kept: true,
      path: rootDir,
    }
  }

  return { ok: true, removed: true }
}
