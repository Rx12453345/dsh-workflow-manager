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
  rmSync,
  rmdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { createHash } from 'node:crypto'

import { DEFAULT_DIMENSIONS, runReview } from '../lib/review.js'
import {
  SNAPSHOT_CANARY_NAME,
  SNAPSHOT_MARKER_NAME,
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

/** Count reparse points below a directory, independently of the module under test. */
function countLinks(dir) {
  let links = 0
  const walk = absolute => {
    for (const entry of readdirSync(absolute, { withFileTypes: true })) {
      const child = join(absolute, entry.name)
      const stat = lstatSync(child)
      if (stat.isSymbolicLink()) {
        links += 1
        continue
      }
      if (stat.isDirectory()) walk(child)
    }
  }
  walk(dir)
  return links
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

  const outcome = await runReview({
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

  const outcome = await runReview({
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

  const outcome = await runReview({
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

  const outcome = await runReview({
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

  const outcome = await runReview({
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

  const outcome = await runReview({
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
  const outcome = await runReview({
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
  assert.equal(existsSync(join(project, 'src', 'a.js')), true, 'the project is untouched')
})

// ---------------------------------------------------------------------------
// the fence's own contract
// ---------------------------------------------------------------------------

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
