/**
 * Review isolation: a reviewer must not be able to destroy the project.
 *
 * WHY THESE TESTS EXIST: on 2026-10-25 the workspace `D:\DSH_Work\WorkFlow` was emptied by a
 * `workflow_review` reviewer that created a directory junction to the repo under `%TEMP%` and
 * then ran a recursive delete. Git history, workflow state and the uncommitted work were lost.
 * The review result itself labelled it "reviewer-side data loss, not a defect in the author's
 * change" — which is exactly the point: the harness allowed it.
 *
 * WHAT THE HOST CANNOT DO (measured, and recorded because the design depends on it)
 * A child started by the subagents service inherits the PARENT's working directory and file
 * policy. A `cwd` in the spawn request does not move its sandbox root: a probe child told to
 * work in `%TEMP%` still reported `process.cwd()` on the real project and appended to a file
 * there successfully. A plugin cannot impose a read-only policy on a child the host starts.
 *
 * SO THE GUARD IS THE TRANSACTION, NOT A PROMPT
 *   - snapshot the project into an isolated temp root (a real copy, never a link);
 *   - point the reviewer at that copy;
 *   - re-scan the real project when the child finishes: deletions are restored, modifications
 *     and additions are reported, and the review is CONTAMINATED — it cannot pass at any score;
 *   - delete only the copy, through guards a junction cannot satisfy.
 *
 * The incident replay below deletes the project through a junction and requires the fence to
 * put every byte back before the tool returns.
 *
 * Run with `node run-unit-tests.mjs`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'

import { DEFAULT_DIMENSIONS, renderIsolation, runReview } from '../lib/review.js'
import {
  SNAPSHOT_CANARY_NAME,
  SNAPSHOT_MARKER_NAME,
  SNAPSHOT_REMOVE_RETRY,
  createReviewSnapshot,
  removeReviewSnapshot,
  verifyReviewSnapshot,
} from '../lib/review-sandbox.js'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** A temporary project with the files a review would care about — including fake git data. */
function makeProject(t) {
  const dir = mkdtempSync(join(tmpdir(), 'wf-iso-project-'))
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // The fence may already have restored it; a leftover temp dir is not a test failure.
    }
  })
  writeFileSync(join(dir, 'package.json'), '{"name":"fixture"}\n')
  mkdirSync(join(dir, 'src'))
  writeFileSync(join(dir, 'src', 'a.js'), 'export const a = 1\n')
  writeFileSync(join(dir, 'src', 'b.js'), 'export const b = 2\n')
  mkdirSync(join(dir, '.git'))
  writeFileSync(join(dir, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(join(dir, '.git', 'config'), '[core]\n\trepositoryformatversion = 0\n')
  return dir
}

/** Every path below `dir` with its content hash, so "restored byte-for-byte" is measurable. */
function signature(dir) {
  const out = new Map()
  const walk = (absolute, rel) => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = join(absolute, entry.name)
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        out.set(childRel, 'dir')
        walk(child, childRel)
      } else if (entry.isFile()) {
        out.set(childRel, `file:${createHash('sha256').update(readFileSync(child)).digest('hex')}`)
      } else if (entry.isSymbolicLink()) {
        out.set(childRel, 'link')
      }
    }
  }
  walk(dir, '')
  return out
}

/** The review payload a perfect reviewer returns. */
function perfectReview() {
  return {
    perDimension: DEFAULT_DIMENSIONS.map(dimension => ({ dimension, score: 10, rationale: 'ok' })),
    issues: [],
  }
}

/**
 * A fake subagents service whose reviewer performs `effect` and then returns a perfect score.
 * The effect is where a hostile or buggy reviewer is simulated.
 */
function reviewerThat(effect) {
  const calls = { started: 0, disposed: 0, lastRequest: null }
  return {
    calls,
    service: {
      async start(_provider, request) {
        calls.started += 1
        calls.lastRequest = request
        if (effect) effect()
        const payload = perfectReview()
        return {
          id: 'child-1',
          result: Promise.resolve({
            stopReason: 'completed',
            output: [{ type: 'text', text: JSON.stringify(payload) }],
            structured: payload,
          }),
          async dispose() {
            calls.disposed += 1
          },
        }
      },
    },
  }
}

/**
 * Run a review and register removal of whatever snapshot it keeps.
 *
 * THE TESTS THAT PROVE CONTAMINATION KEEP THEIR SNAPSHOT ON PURPOSE, which is correct: it is
 * the only remaining copy. But a test suite that leaves one temp tree per contamination case
 * is a suite that litters — measured: five roots left behind by one run of this file. The
 * kept root is registered for removal here so the production behaviour stays untouched and
 * the test process leaves nothing behind.
 *
 * @param t - the node:test context.
 * @param options - the runReview options.
 * @returns the outcome, unchanged.
 */
async function runReviewWithCleanup(t, options) {
  const outcome = await runReview(options)
  const work = outcome?.isolation?.reviewerWorkspace
  if (typeof work === 'string') {
    t?.after?.(() => {
      try {
        rmSync(dirname(work), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
      } catch {
        // Best effort: a leftover temp root must not fail a green test.
      }
    })
  }
  return outcome
}

/** Count reparse points below a directory, independently of the module under test. */
function countLinks(dir) {
  let links = 0
  const walk = absolute => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = join(absolute, entry.name)
      // THE HELPER MUST SEE WHAT THE GUARD SEES. `lstatSync(child).isSymbolicLink()` reports a
      // Windows junction as FALSE (measured), so an lstat-only counter returned zero for a copy
      // that really did contain one — a test weaker than the guard it was supposed to check.
      // The Dirent of the parent listing IS true for it, and the native realpath settles the
      // rest (an ordinary directory resolves to its own name).
      if (entry.isSymbolicLink() || resolvesElsewhere(absolute, entry.name, child)) {
        links += 1
        continue
      }
      if (statSync(child).isDirectory()) walk(child)
    }
  }
  walk(dir)
  return links
}

/** Whether a path exists under its own name in its parent, i.e. it is not a redirect. */
function resolvesElsewhere(parent, name, child) {
  try {
    return !samePath(realpathSync.native(child), join(realpathSync.native(parent), name))
  } catch {
    // Unresolvable: count it as a link, like the module's own guard does.
    return true
  }
}

/** Case-insensitive equality on Windows, exact elsewhere. */
function samePath(a, b) {
  const left = resolve(a)
  const right = resolve(b)
  return process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right
}

/** A throwaway directory outside any project, registered for cleanup. */
function makeHolder(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  })
  return dir
}

// ---------------------------------------------------------------------------
// the snapshot itself
// ---------------------------------------------------------------------------

test('a snapshot is a real copy of the project, with no link a delete could follow', t => {
  const project = makeProject(t)
  const snapshot = createReviewSnapshot(project)
  assert.equal(snapshot.ok, true, snapshot.reason)

  try {
    assert.equal(existsSync(join(snapshot.workDir, 'src', 'a.js')), true, 'the copy has the sources')
    assert.equal(
      readFileSync(join(snapshot.workDir, 'src', 'a.js'), 'utf8'),
      'export const a = 1\n',
      'the copy is byte-identical',
    )
    assert.equal(countLinks(snapshot.workDir), 0, 'the copy contains no reparse points')
    assert.equal(
      existsSync(join(snapshot.rootDir, SNAPSHOT_CANARY_NAME)),
      true,
      'the canary exists outside the copy',
    )
    assert.equal(
      existsSync(join(snapshot.workDir, SNAPSHOT_CANARY_NAME)),
      false,
      'the canary is not inside the copy',
    )
    assert.equal(existsSync(join(snapshot.rootDir, SNAPSHOT_MARKER_NAME)), true, 'the marker exists')
  } finally {
    const removed = removeReviewSnapshot(snapshot)
    assert.equal(removed.ok, true, removed.reason)
  }

  assert.equal(existsSync(snapshot.workDir), false, 'the copy is gone')
  assert.equal(existsSync(snapshot.rootDir), false, 'the snapshot root is gone')
  assert.equal(existsSync(join(project, 'src', 'a.js')), true, 'the project is untouched')
})

test('a clean review leaves the project byte-identical and removes the copy', async t => {
  const project = makeProject(t)
  const before = signature(project)
  const { calls, service } = reviewerThat()

  const outcome = await runReviewWithCleanup(t, {
    feature: 'a change',
    parent: { id: 'parent-1' },
    subagents: service,
    workspaceDir: project,
    config: { bar: 8 },
  })

  assert.equal(outcome.status, 'reviewed', outcome.reason)
  assert.equal(outcome.passed, true)
  assert.deepEqual(signature(project), before, 'the project must not have changed')

  // THE REVIEWER WAS POINTED AT THE COPY, NOT AT THE PROJECT.
  const prompt = calls.lastRequest.prompt[0].text
  assert.equal(calls.started, 1)
  assert.ok(prompt.includes(outcome.isolation.reviewerWorkspace), 'the prompt names the copy')
  assert.equal(prompt.includes(project), false, 'the prompt must not name the real project')

  assert.equal(outcome.isolation.enabled, true)
  assert.equal(outcome.isolation.contentHashed, true)
  assert.equal(outcome.isolation.fence.clean, true)
  assert.equal(outcome.isolation.cleanup.ok, true, outcome.isolation.cleanup.reason)
  assert.equal(existsSync(outcome.isolation.reviewerWorkspace), false, 'the copy was removed')
})

// ---------------------------------------------------------------------------
// the fence: a destructive reviewer cannot pass, and the damage is undone
// ---------------------------------------------------------------------------

test('a reviewer that deletes the project cannot pass, and the fence restores every byte', async t => {
  const project = makeProject(t)
  const before = signature(project)

  const { service } = reviewerThat(() => {
    // The reviewer has the parent's file policy, so this succeeds. That is the threat.
    rmSync(project, { recursive: true, force: true })
  })

  const outcome = await runReviewWithCleanup(t, {
    feature: 'a change',
    parent: { id: 'parent-1' },
    subagents: service,
    workspaceDir: project,
    config: { bar: 8 },
  })

  assert.equal(outcome.passed, false, 'damage must never be a pass')
  assert.equal(outcome.status, 'contaminated')
  assert.match(outcome.reason, /CONTAMINATED/)
  assert.equal(outcome.review, null, 'a contaminated review must not carry a graded review')
  assert.equal(outcome.verdict, null)

  assert.equal(existsSync(project), true, 'the project was restored')
  assert.deepEqual(signature(project), before, 'every path and every byte is back')
  assert.ok(outcome.isolation.fence.deleted.length > 0, 'the fence saw the deletion')
  assert.equal(outcome.isolation.fence.modified.length, 0)
  assert.deepEqual(outcome.isolation.fence.restoreErrors, [])
  assert.equal(
    outcome.isolation.cleanup.kept,
    true,
    'the snapshot is kept when it is the only remaining copy',
  )
  assert.equal(existsSync(outcome.isolation.reviewerWorkspace), true, 'the kept snapshot still exists')
})

test('the incident shape: a delete THROUGH a junction to the project is restored, not passed', async t => {
  const project = makeProject(t)
  const before = signature(project)
  const holder = makeHolder(t, 'wf-iso-junction-')

  const { service } = reviewerThat(() => {
    // Exactly the incident, one step removed: a junction into the project, then a recursive
    // delete below it. `rmSync(junction)` alone is harmless on current Node; a path BELOW
    // the junction is not — measured, and that is what this reproduces.
    const junction = join(holder, 'link')
    symlinkSync(project, junction, 'junction')
    try {
      rmSync(join(junction, 'src'), { recursive: true, force: true })
    } finally {
      // A junction is removed with rmdir; `unlink` refuses it with EPERM on Windows.
      try {
        rmdirSync(junction)
      } catch {
        // already gone
      }
    }
  })

  const outcome = await runReviewWithCleanup(t, {
    feature: 'a change',
    parent: { id: 'parent-1' },
    subagents: service,
    workspaceDir: project,
    config: { bar: 8 },
  })

  assert.equal(outcome.status, 'contaminated')
  assert.equal(outcome.passed, false)
  assert.ok(outcome.isolation.fence.deleted.includes('src/a.js'), 'the fence names the deleted file')
  assert.equal(existsSync(join(project, 'src', 'a.js')), true, 'the deleted source is back')
  assert.deepEqual(signature(project), before, 'the tree is byte-identical to before the review')
})

test('a modified file is reported, not silently reverted, and the review fails', async t => {
  const project = makeProject(t)
  const { service } = reviewerThat(() => {
    writeFileSync(join(project, 'package.json'), '{"name":"TAMPERED"}\n')
  })

  const outcome = await runReviewWithCleanup(t, {
    feature: 'a change',
    parent: { id: 'parent-1' },
    subagents: service,
    workspaceDir: project,
    config: { bar: 8 },
  })

  assert.equal(outcome.status, 'contaminated')
  assert.equal(outcome.passed, false)
  assert.ok(outcome.isolation.fence.modified.includes('package.json'))
  // A HUMAN EDIT DURING A LONG REVIEW LOOKS THE SAME, so the tool reports rather than
  // reverting: silently reverting someone's in-progress edit would be a second way to lose work.
  assert.equal(readFileSync(join(project, 'package.json'), 'utf8'), '{"name":"TAMPERED"}\n')
  assert.equal(outcome.isolation.cleanup.kept, true)
})

test('an added path is reported as contamination', async t => {
  const project = makeProject(t)
  const { service } = reviewerThat(() => {
    writeFileSync(join(project, 'REVIEWER-NOTES.md'), 'scratch\n')
  })

  const outcome = await runReviewWithCleanup(t, {
    feature: 'a change',
    parent: { id: 'parent-1' },
    subagents: service,
    workspaceDir: project,
    config: { bar: 8 },
  })

  assert.equal(outcome.status, 'contaminated')
  assert.ok(outcome.isolation.fence.added.includes('REVIEWER-NOTES.md'))
})

// ---------------------------------------------------------------------------
// fail closed
// ---------------------------------------------------------------------------

test('a project containing a link that escapes it is refused, and no reviewer starts', async t => {
  const project = makeProject(t)
  const outside = makeHolder(t, 'wf-iso-outside-')
  writeFileSync(join(outside, 'secret.txt'), 'not part of the project\n')
  symlinkSync(outside, join(project, 'escape'), 'junction')

  const { calls, service } = reviewerThat()

  const outcome = await runReviewWithCleanup(t, {
    feature: 'a change',
    parent: { id: 'parent-1' },
    subagents: service,
    workspaceDir: project,
    config: { bar: 8 },
  })

  assert.equal(outcome.passed, false)
  assert.equal(outcome.status, 'unavailable')
  assert.match(outcome.reason, /could not be isolated/)
  assert.equal(calls.started, 0, 'no reviewer runs without a snapshot that can restore the project')
})

test('without a workspaceDir the review keeps its old behaviour (no isolation)', async t => {
  const { service } = reviewerThat()
  const outcome = await runReviewWithCleanup(t, {
    feature: 'a change',
    parent: { id: 'parent-1' },
    subagents: service,
    config: { bar: 8 },
  })
  assert.equal(outcome.status, 'reviewed')
  assert.equal(outcome.passed, true)
  assert.equal(outcome.isolation, undefined)
})

// ---------------------------------------------------------------------------
// the delete guards
// ---------------------------------------------------------------------------

test('the cleanup refuses a copy that contains a link, and the project survives', t => {
  const project = makeProject(t)
  const snapshot = createReviewSnapshot(project)
  assert.equal(snapshot.ok, true, snapshot.reason)
  t.after(() => {
    try {
      rmSync(snapshot.rootDir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  })

  // A reviewer plants a junction INSIDE the copy: deleting the tree that contains it could
  // reach the target, so the delete must not happen at all.
  const planted = join(snapshot.workDir, 'planted-link')
  symlinkSync(project, planted, 'junction')

  const removed = removeReviewSnapshot(snapshot)
  assert.equal(removed.ok, false)
  assert.match(removed.reason, /link/)
  assert.equal(existsSync(join(project, 'src', 'a.js')), true, 'the project is untouched')
  assert.equal(existsSync(snapshot.workDir), true, 'the copy is left in place, not deleted')

  rmdirSync(planted)
})

test('the cleanup refuses when the copy has been swapped for a junction to the project', t => {
  const project = makeProject(t)
  const snapshot = createReviewSnapshot(project)
  assert.equal(snapshot.ok, true, snapshot.reason)
  t.after(() => {
    try {
      rmSync(snapshot.rootDir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  })

  rmSync(snapshot.workDir, { recursive: true, force: true })
  symlinkSync(project, snapshot.workDir, 'junction')

  const removed = removeReviewSnapshot(snapshot)
  assert.equal(removed.ok, false)
  assert.match(removed.reason, /link|open|resolve/i)
  assert.equal(existsSync(join(project, 'src', 'a.js')), true, 'the project is untouched')
  assert.equal(existsSync(join(project, 'README.md')), false, 'and nothing followed the junction')

  rmdirSync(snapshot.workDir)
})

test('the cleanup refuses root it cannot prove is its own snapshot', t => {
  const project = makeProject(t)
  const snapshot = createReviewSnapshot(project)
  assert.equal(snapshot.ok, true, snapshot.reason)
  t.after(() => {
    try {
      rmSync(snapshot.rootDir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  })

  rmSync(join(snapshot.rootDir, SNAPSHOT_MARKER_NAME), { force: true })
  const removed = removeReviewSnapshot(snapshot)
  assert.equal(removed.ok, false)
  assert.match(removed.reason, /marker|snapshot/i)
  // A KEPT SNAPSHOT MUST BE FINDABLE. A cleanup refusal that does not name the path is a
  // message nobody can act on.
  assert.equal(removed.kept, true)
  assert.equal(removed.path, snapshot.rootDir)
  assert.equal(existsSync(join(project, 'src', 'a.js')), true, 'the project is untouched')
})

test('the cleanup refuses a copy that is a link to somewhere inside the snapshot root', t => {
  // THIS CASE EXISTS FOR ONE GUARD ONLY. A junction whose target is INSIDE the snapshot root
  // passes the containment check (it *is* inside), so only the explicit reparse-point test can
  // refuse it. Without this test that guard is decoration: removing it leaves every other case
  // green, because the containment check masks it.
  const project = makeProject(t)
  const snapshot = createReviewSnapshot(project)
  assert.equal(snapshot.ok, true, snapshot.reason)
  t.after(() => {
    try {
      rmSync(snapshot.rootDir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  })

  const holder = join(snapshot.rootDir, 'holder')
  mkdirSync(holder)
  writeFileSync(join(holder, 'innocent.txt'), 'inside the root\n')
  rmSync(snapshot.workDir, { recursive: true, force: true })
  symlinkSync(holder, snapshot.workDir, 'junction')

  const removed = removeReviewSnapshot(snapshot)
  assert.equal(removed.ok, false)
  assert.match(removed.reason, /link/)
  assert.equal(existsSync(join(project, 'src', 'a.js')), true, 'the project is untouched')

  rmdirSync(snapshot.workDir)
})

test('the canary must survive, or the delete is reported as unsafe', t => {
  const project = makeProject(t)
  const snapshot = createReviewSnapshot(project)
  assert.equal(snapshot.ok, true, snapshot.reason)
  t.after(() => {
    try {
      rmSync(snapshot.rootDir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  })

  rmSync(join(snapshot.rootDir, SNAPSHOT_CANARY_NAME), { force: true })
  const removed = removeReviewSnapshot(snapshot)
  assert.equal(removed.ok, false)
  assert.match(removed.reason, /canary/)
  // A LIVE REVIEW SHOWED THIS GAP: the reviewer's own `npm test` children still held the copy,
  // the delete failed, and the message said "kept at (unknown)". Naming the path is the minimum.
  assert.equal(removed.kept, true)
  assert.equal(removed.path, snapshot.rootDir)
  assert.equal(existsSync(join(project, 'src', 'a.js')), true, 'the project is untouched')
})

test('the guarded delete uses the longer, bounded retry window and names the path when it still fails', t => {
  // THE FAILURE THIS PINS. A reviewer that ran `npm test` left its children holding the copy, and
  // the delete lost the race: the snapshot was kept (correct) but the window was short — Node's
  // `rmSync` backs off linearly, so the old 5 x 120 ms was only 1.8 s in total. The window is now
  // longer and still bounded, and the failure must name the path a human has to delete.
  const project = makeProject(t)
  const snapshot = createReviewSnapshot(project)
  assert.equal(snapshot.ok, true, snapshot.reason)
  t.after(() => {
    try {
      rmSync(snapshot.rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // best effort
    }
  })

  const { maxRetries, retryDelay } = SNAPSHOT_REMOVE_RETRY
  assert.ok(maxRetries > 5, `maxRetries ${maxRetries} must exceed the old 5`)
  assert.ok(retryDelay > 120, `retryDelay ${retryDelay} ms must exceed the old 120 ms`)
  const windowMs = (retryDelay * maxRetries * (maxRetries + 1)) / 2
  assert.ok(windowMs > 1_800, `the total wait ${windowMs} ms must exceed the old ~1.8 s window`)
  assert.ok(windowMs <= 15_000, `the total wait ${windowMs} ms must stay bounded`)

  const calls = []
  const removed = removeReviewSnapshot(snapshot, {
    rm(path, options) {
      calls.push({ path, options })
      throw Object.assign(new Error('EPERM: still held by the reviewer test runner'), { code: 'EPERM' })
    },
  })

  // The retry loop lives inside `rmSync`; what this module owns is the options it hands over.
  assert.equal(calls.length, 1)
  assert.equal(calls[0].path, snapshot.workDir)
  assert.equal(calls[0].options.recursive, true)
  assert.equal(calls[0].options.force, true)
  assert.equal(calls[0].options.maxRetries, maxRetries, 'the exported window is the one used')
  assert.equal(calls[0].options.retryDelay, retryDelay, 'the exported window is the one used')
  assert.equal(removed.ok, false)
  assert.equal(removed.kept, true)
  assert.equal(removed.path, snapshot.workDir, 'a kept copy must be findable by path')
  assert.match(removed.reason, /could not be removed/)
  assert.equal(existsSync(snapshot.workDir), true, 'the copy is still there for the human to delete')
})

test('the delete guards run BEFORE the recursive delete is attempted at all', t => {
  // A test seam for the delete function must not become a way around the guards: a copy that
  // contains a link is refused before the seam is ever called.
  const project = makeProject(t)
  const snapshot = createReviewSnapshot(project)
  assert.equal(snapshot.ok, true, snapshot.reason)
  const planted = join(snapshot.workDir, 'planted-link')
  symlinkSync(project, planted, 'junction')
  t.after(() => {
    try {
      rmdirSync(planted)
    } catch {
      // already gone
    }
    try {
      rmSync(snapshot.rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // best effort
    }
  })

  let called = false
  const removed = removeReviewSnapshot(snapshot, {
    rm() {
      called = true
    },
  })
  assert.equal(called, false, 'a refused copy must never reach the recursive delete')
  assert.equal(removed.ok, false)
  assert.match(removed.reason, /link/)
  assert.equal(existsSync(snapshot.workDir), true)
})

test('the report says the project was verified, and says it the honest way', async t => {
  const project = makeProject(t)
  const { service } = reviewerThat()
  const outcome = await runReviewWithCleanup(t, {
    feature: 'a change',
    parent: { id: 'parent-1' },
    subagents: service,
    workspaceDir: project,
    config: { bar: 8 },
  })
  const text = renderIsolation(outcome.isolation).join(' ')
  assert.match(text, /disposable copy/)
  assert.match(text, /verified after the review and is unchanged/)
  assert.match(text, /content hashed/)
})

test('the report shouts CONTAMINATED and names where the snapshot was kept', async t => {
  const project = makeProject(t)
  const { service } = reviewerThat(() => {
    writeFileSync(join(project, 'REVIEWER-NOTES.md'), 'scratch\n')
  })
  const outcome = await runReviewWithCleanup(t, {
    feature: 'a change',
    parent: { id: 'parent-1' },
    subagents: service,
    workspaceDir: project,
    config: { bar: 8 },
  })
  const text = renderIsolation(outcome.isolation).join(' ')
  assert.match(text, /CONTAMINATED/)
  assert.match(text, /added 1/)
  assert.match(text, new RegExp(outcome.isolation.cleanup.path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
})

// ---------------------------------------------------------------------------
// the fence's own contract
// ---------------------------------------------------------------------------

test('a restore from a tampered snapshot copy is refused, not written back', t => {
  // The reviewer is TOLD the copy path and has write access to the temp root, so it can poison
  // the very source a restore would read from. Writing those bytes back as "the original" would
  // turn a detected incident into silent corruption.
  const project = makeProject(t)
  const snapshot = createReviewSnapshot(project)
  assert.equal(snapshot.ok, true, snapshot.reason)
  t.after(() => {
    try {
      rmSync(snapshot.rootDir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  })

  writeFileSync(join(snapshot.workDir, 'src', 'a.js'), 'export const a = "tampered"\n')
  rmSync(join(project, 'src', 'a.js'))

  const fence = verifyReviewSnapshot(snapshot)
  assert.equal(fence.clean, false)
  assert.ok(
    fence.restoreErrors.some(entry => entry.includes('src/a.js')),
    'the digest mismatch is reported',
  )
  assert.equal(fence.restored.includes('src/a.js'), false, 'nothing untrusted was written back')
  assert.equal(existsSync(join(project, 'src', 'a.js')), false, 'the project is left as it was')
})

test('a snapshot on an ALIASED temp path still certifies its copy', t => {
  // GitHub's Windows runners report %TEMP% as an 8.3 short path (C:\Users\RUNNER~1\...), and a
  // path differing only in letter case has the same property. Comparing every child's resolved
  // path with its OWN spelling made each directory look like a reparse point: 50 CI failures,
  // every review refusing with "it is a reparse point the directory listing did not flag". The
  // scan canonicalises the root once and judges containment, so an alias is not a link.
  if (process.platform !== 'win32') {
    t.skip('path aliasing is a Windows property')
    return
  }
  const project = makeProject(t)
  const snapshot = createReviewSnapshot(project, { tempRoot: tmpdir().toUpperCase() })
  assert.equal(snapshot.ok, true, snapshot.reason)
  t.after(() => {
    try {
      rmSync(snapshot.rootDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
    } catch {
      // best effort
    }
  })

  assert.equal(existsSync(join(snapshot.workDir, 'src', 'a.js')), true, 'the copy was made')
  assert.equal(verifyReviewSnapshot(snapshot).clean, true, 'the fence accepts an aliased tree')
  assert.equal(removeReviewSnapshot(snapshot).ok, true, 'the guarded delete accepts it too')
})

test('verifyReviewSnapshot reports a missing project as deletions to restore', t => {
  const project = makeProject(t)
  const before = signature(project)
  const snapshot = createReviewSnapshot(project)
  assert.equal(snapshot.ok, true, snapshot.reason)
  t.after(() => {
    try {
      rmSync(snapshot.rootDir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  })

  rmSync(project, { recursive: true, force: true })
  const fence = verifyReviewSnapshot(snapshot)
  assert.equal(fence.clean, false)
  assert.ok(fence.deleted.includes('src/a.js'))
  assert.deepEqual(fence.restoreErrors, [])
  assert.deepEqual(signature(project), before, 'the whole tree is restored')
})

test('a snapshot directory is only created under the OS temp directory', t => {
  const project = makeProject(t)
  const snapshot = createReviewSnapshot(project)
  assert.equal(snapshot.ok, true, snapshot.reason)
  t.after(() => {
    try {
      rmSync(snapshot.rootDir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  })

  assert.equal(dirname(snapshot.rootDir), tmpdir(), 'the root lives directly under the temp dir')
  assert.ok(snapshot.workDir.startsWith(snapshot.rootDir), 'the copy is inside that root')
  assert.equal(
    snapshot.workDir === project || project.startsWith(`${snapshot.workDir}\\`),
    false,
    'the copy never contains the project',
  )
})

// ---------------------------------------------------------------------------
// the clean predicate cannot be fooled (2026-10-25 security review)
// ---------------------------------------------------------------------------
//
// THE DEFECT THESE PIN: the fence compared files by content hash only while a 64 MiB budget
// lasted and silently fell through to "nothing to report" for the rest. A same-length rewrite
// of an unhashed file therefore left `clean: true` and the tampered bytes in the project —
// reproduced by the review with a 65 MiB fixture. This project had 533 of 999 entries unhashed,
// including `.dsh/FEATURES.json` and `.github/workflows/ci.yml`.

test('the link counter used by these tests can see a junction', t => {
  const dir = makeHolder(t, 'wf-iso-links-')
  const target = makeHolder(t, 'wf-iso-links-target-')
  writeFileSync(join(target, 'x.txt'), 'x\n')
  symlinkSync(target, join(dir, 'link'), 'junction')
  assert.equal(countLinks(dir), 1, 'a junction must be counted; lstat alone reports it as a directory')
  assert.equal(countLinks(target), 0, 'an ordinary directory is not a link')
})

test('a same-length rewrite cannot pass when the fence took no digest', t => {
  const project = makeProject(t)
  // A LOWERED BUDGET IS THE OLD DEFAULT'S BEHAVIOUR, kept reachable on purpose: it is the state
  // in which files have no digest, and the state the review proved could pass while tampered.
  const snapshot = createReviewSnapshot(project, { hashBudget: 0 })
  assert.equal(snapshot.ok, true, snapshot.reason)
  t.after(() => {
    try {
      rmSync(snapshot.rootDir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  })
  assert.equal(snapshot.contentHashed, false, 'the fixture must really have unhashed files')
  // A LOWERED BUDGET CANNOT PRODUCE A CLEAN VERDICT AT ALL, and that is the fail-closed answer:
  // the fence had no digest for these files, so "unchanged" is not something it can certify.
  const untouched = verifyReviewSnapshot(snapshot)
  assert.equal(untouched.clean, false)
  assert.ok(untouched.unverified.length > 0, 'the files without a digest are named as unverifiable')

  const file = join(project, 'package.json')
  const original = readFileSync(file)
  const tampered = Buffer.from(original)
  tampered[tampered.length - 3] = tampered[tampered.length - 3] === 0x39 ? 0x38 : 0x39 // same length
  writeFileSync(file, tampered)
  const stamp = new Date(Date.now() + 5000)
  utimesSync(file, stamp, stamp)

  const fence = verifyReviewSnapshot(snapshot)
  assert.equal(fence.clean, false, 'a file the fence could not hash must not certify the project')
  assert.ok(fence.touched.includes('package.json'), 'the file is reported as possibly changed')
  assert.deepEqual(fence.modified, [], 'there is no digest, so it cannot be called modified')
})

test('a file with no digest whose timestamp moved cannot pass on that basis alone', t => {
  // THE PREDICATE HAS TWO DOUBT BUCKETS AND EACH NEEDS ITS OWN CASE. In the fixture above the
  // unchanged files land in `unverified`, so dropping `touched` from the clean predicate would
  // still be refused by the other bucket. This project has ONE file, and it is the one whose
  // timestamp moved: `unverified` is empty and only `touched` can refuse the pass.
  const dir = mkdtempSync(join(tmpdir(), 'wf-iso-one-'))
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  })
  writeFileSync(join(dir, 'only.txt'), 'abcdef\n')
  const snapshot = createReviewSnapshot(dir, { hashBudget: 0 })
  assert.equal(snapshot.ok, true, snapshot.reason)
  t.after(() => {
    try {
      rmSync(snapshot.rootDir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  })

  writeFileSync(join(dir, 'only.txt'), 'abcdeF\n') // same length, different byte
  const stamp = new Date(Date.now() + 5000)
  utimesSync(join(dir, 'only.txt'), stamp, stamp)

  const fence = verifyReviewSnapshot(snapshot)
  assert.deepEqual(fence.unverified, [], 'no file is in the "nothing was compared" bucket')
  assert.deepEqual(fence.touched, ['only.txt'])
  assert.equal(fence.clean, false, 'a file that may have changed must not certify the project')
})

test('with the default budget a same-length rewrite is a MODIFICATION, not a doubt', t => {
  const project = makeProject(t)
  const snapshot = createReviewSnapshot(project)
  assert.equal(snapshot.ok, true, snapshot.reason)
  t.after(() => {
    try {
      rmSync(snapshot.rootDir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  })
  // THE DEFAULT MUST COVER EVERY SNAPSHOT THE FENCE ACCEPTS: hashing is cheaper than the copy
  // this module already makes, so no accepted project may fall back to size+mtime.
  assert.equal(snapshot.contentHashed, true, 'every accepted snapshot is fully content-hashed')

  const file = join(project, 'package.json')
  const tampered = Buffer.from(readFileSync(file))
  tampered[tampered.length - 3] = tampered[tampered.length - 3] === 0x39 ? 0x38 : 0x39
  writeFileSync(file, tampered)

  const fence = verifyReviewSnapshot(snapshot)
  assert.equal(fence.clean, false)
  assert.ok(fence.modified.includes('package.json'))
})

test("git's own bookkeeping is not evidence a reviewer touched the project", t => {
  const project = makeProject(t)
  writeFileSync(join(project, '.git', 'index'), 'DIRC-v1\n')
  // The reflog file exists BEFORE the snapshot, as it does in any real repository: a push
  // APPENDS to it. A NEW reflog path is still an addition and still fails the fence below.
  mkdirSync(join(project, '.git', 'logs', 'refs', 'remotes', 'origin'), { recursive: true })
  writeFileSync(join(project, '.git', 'logs', 'refs', 'remotes', 'origin', 'main'), 'old\n')
  const snapshot = createReviewSnapshot(project)
  assert.equal(snapshot.ok, true, snapshot.reason)
  t.after(() => {
    try {
      rmSync(snapshot.rootDir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  })

  // EXACTLY WHAT `git status --porcelain` DOES — the step-4 instruction in the reviewer prompt —
  // and what a human's concurrent `git push` does to the reflog. Both used to read as
  // CONTAMINATED against a review that changed nothing.
  writeFileSync(join(project, '.git', 'index'), 'DIRC-v2 with refreshed stat data\n')
  writeFileSync(join(project, '.git', 'logs', 'refs', 'remotes', 'origin', 'main'), 'old\npush\n')

  const fence = verifyReviewSnapshot(snapshot)
  assert.equal(
    fence.clean,
    true,
    `the index refresh must not contaminate: modified=${fence.modified.join(',')} added=${fence.added.join(',')}`,
  )

  // STRUCTURAL DAMAGE IS STILL DAMAGE. Removing the index is a deletion and is restored.
  rmSync(join(project, '.git', 'index'))
  const deleted = verifyReviewSnapshot(snapshot)
  assert.equal(deleted.clean, false)
  assert.ok(deleted.deleted.includes('.git/index'))
  assert.ok(deleted.restored.includes('.git/index'), 'the index is restored from the snapshot')
})

test('a restore refuses to write through a junction planted in the project', t => {
  const project = makeProject(t)
  const snapshot = createReviewSnapshot(project)
  assert.equal(snapshot.ok, true, snapshot.reason)
  t.after(() => {
    try {
      rmSync(snapshot.rootDir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  })

  // The reviewer deletes `src` and leaves a junction in its place, pointing INSIDE the project
  // so the scan itself has no reason to refuse. A restore through it would write `src/a.js`
  // into `.git/a.js` — a corrupted tree, reported as "restored".
  rmSync(join(project, 'src'), { recursive: true, force: true })
  symlinkSync(join(project, '.git'), join(project, 'src'), 'junction')

  const fence = verifyReviewSnapshot(snapshot)
  assert.equal(fence.clean, false)
  assert.ok(
    fence.restoreErrors.some(entry => entry.includes('src/a.js') && entry.includes('link')),
    `the restore must name the link: ${fence.restoreErrors.join(' | ')}`,
  )
  assert.equal(existsSync(join(project, '.git', 'a.js')), false, 'nothing was written through the junction')
})

test('a project root swapped for a junction is not restored through', t => {
  const project = makeProject(t)
  const snapshot = createReviewSnapshot(project)
  assert.equal(snapshot.ok, true, snapshot.reason)
  const holder = makeHolder(t, 'wf-iso-rootswap-')
  const aside = `${project}-aside`
  renameSync(project, aside)
  symlinkSync(holder, project, 'junction')
  t.after(() => {
    try {
      rmdirSync(project)
    } catch {
      // already gone
    }
    try {
      rmSync(aside, { recursive: true, force: true })
    } catch {
      // best effort
    }
    try {
      rmSync(snapshot.rootDir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  })

  const fence = verifyReviewSnapshot(snapshot)
  assert.equal(fence.clean, false)
  assert.equal(fence.rootSwapped, true, 'the fence must name the root swap, not report a plain deletion')
  assert.deepEqual(fence.restored, [], 'nothing is restored into a directory that is no longer the project')
  assert.deepEqual(readdirSync(holder), [], 'nothing was written through the swapped root')
})
