/**
 * P2 governance and the docs fast lane.
 *
 * THREE RULES ARE UNDER TEST HERE, AND ALL THREE ARE ABOUT NOT TRUSTING AN EASY ANSWER:
 *
 *  1. `workflow_status` tells the truth about features — the counts AND which ones are open —
 *     because "phase EVALUATE" does not say whether three features are unfinished.
 *  2. `HANDOFF` is refused while features are open, and the ONLY way past that is an explicit,
 *     reasoned waiver that is recorded. A waiver waives the feature COUNT, never the review.
 *  3. `recipe: docs` adds exactly one edge (`BUILD -> EVALUATE`, skipping VERIFY) and no other
 *     recipe gains anything. The immutable graph stays immutable, no recipe adds `BUILD -> COMMIT`,
 *     and COMMIT itself is not review-gated (`VERIFY -> COMMIT` exists).
 *
 * The `changed_files` cross-check is tested in the last section: the declared list is a CLAIM,
 * and a real temporary git repository is the evidence. The git runner is injected there because
 * this sandbox denies a child process a piped stdio (EPERM); the injected runner captures git's
 * output through a FILE DESCRIPTOR, so these tests run real git here instead of skipping.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  rmdirSync,
  rmSync,
  openSync,
  closeSync,
  symlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative } from 'node:path'

import {
  TRANSITIONS,
  FEATURES_RELATIVE_PATH,
  allowedTransitions,
  canTransition,
  describeAdvance,
  transition,
  readState,
  writeState,
  readFeatures,
  writeFeatures,
  emptyFeatures,
  fingerprint,
  reviewFreshnessAll,
} from '../lib/advance.js'
import {
  buildAdvanceToolDefinition,
  buildReviewToolDefinition,
  buildStatus,
  buildToolDefinition,
  renderAdvance,
  renderStatus,
} from '../lib/tools.js'
import { resolveConfig } from '../lib/config.js'
import {
  GIT_STATUS_ARGS,
  collectGitChanges,
  isFrameworkStatePath,
  normaliseGitPath,
  parsePorcelainZ,
  reconcileChangedFiles,
} from '../lib/git-changes.js'
import { renderReview, buildReviewPrompt } from '../lib/review.js'

// ---------------------------------------------------------------------------
// fixtures
// ---------------------------------------------------------------------------

/** A project directory with `.dsh/workflow.yml` (its presence = opt-in). */
function makeProject({ yml = 'tier: standard\n', features = null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wf-p2-'))
  // `.dsh` is created for a fixture that has framework state even when the project has NOT
  // opted in — that is exactly the "leftover FEATURES.json in an inert project" case.
  if (yml !== null || features) mkdirSync(join(dir, '.dsh'), { recursive: true })
  if (yml !== null) writeFileSync(join(dir, '.dsh', 'workflow.yml'), yml, 'utf8')
  if (features) writeFileSync(join(dir, FEATURES_RELATIVE_PATH), JSON.stringify(features, null, 2), 'utf8')
  return dir
}

const execFor = dir => ({ agent: { id: 'agent-1', session: { header: { cwd: dir } } } })

const feature = (id, overrides = {}) => ({
  id,
  category: 'functional',
  description: `feature ${id}`,
  steps: ['do it'],
  passes: false,
  priority: 1,
  acceptance_id: null,
  evidence: [],
  attempts: 0,
  blocked_reason: null,
  ...overrides,
})

const featuresDoc = rows => ({ ...emptyFeatures('p2 fixture'), features: rows })

const advanceDef = () => buildAdvanceToolDefinition({ config: resolveConfig({}), ctx: null, services: null })

/** INIT → PLAN → PICK → BUILD, with the bootstrap satisfied. */
async function reachBuild(def, exec, { featureId = 'F001' } = {}) {
  const planned = await def.execute(
    {
      action: 'advance',
      to: 'PLAN',
      features: [{ id: featureId, description: `feature ${featureId}`, steps: ['a'], priority: 1 }],
    },
    exec,
  )
  assert.equal(planned.ok, true, JSON.stringify(planned))
  assert.equal((await def.execute({ action: 'pick' }, exec)).ok, true)
  assert.equal((await def.execute({ action: 'boot', smoke_passed: true }, exec)).ok, true)
  const build = await def.execute({ action: 'advance', to: 'BUILD' }, exec)
  assert.equal(build.ok, true, JSON.stringify(build))
  return build
}

/** INIT → … → COMMIT, without running a review (VERIFY → COMMIT is a legal sensor route). */
async function reachCommit(def, exec, options = {}) {
  await reachBuild(def, exec, options)
  assert.equal((await def.execute({ action: 'advance', to: 'VERIFY' }, exec)).ok, true)
  const commit = await def.execute({ action: 'advance', to: 'COMMIT' }, exec)
  assert.equal(commit.ok, true, JSON.stringify(commit))
  return commit
}

/** INIT → PLAN → PICK, the state in which a review can be recorded. */
async function planAndPick(def, exec, { featureId = 'F001', description = 'the change' } = {}) {
  const planned = await def.execute(
    {
      action: 'advance',
      to: 'PLAN',
      features: [{ id: featureId, description, steps: ['a'], priority: 1 }],
    },
    exec,
  )
  assert.equal(planned.ok, true, JSON.stringify(planned))
  assert.equal((await def.execute({ action: 'pick' }, exec)).ok, true)
}

// ---------------------------------------------------------------------------
// 1. status: feature counts and the open set
// ---------------------------------------------------------------------------

test('workflow_status reports the feature counts AND the open feature list', async () => {
  const dir = makeProject({
    features: featuresDoc([
      feature('F001', { passes: true, description: 'the finished one' }),
      feature('F002', { description: 'the unfinished one' }),
    ]),
  })
  try {
    const status = await buildToolDefinition({ config: resolveConfig({}), ctx: null, services: null }).execute(
      {},
      execFor(dir),
    )
    assert.equal(status.ok, true)
    assert.deepEqual(status.features.counts, { total: 2, done: 1, open: 1 })
    assert.deepEqual(status.features.open, [{ id: 'F002', description: 'the unfinished one' }])
    assert.equal(status.features.truncated, false)

    const text = renderStatus(status)
    assert.match(text, /features: 1\/2 complete, 1 open/)
    assert.match(text, /open: F002 — the unfinished one/)
    // A completed feature is NOT listed as open: the list is the work that remains.
    assert.doesNotMatch(text, /open: F001/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a project with no features renders no feature line at all', async () => {
  const dir = makeProject()
  try {
    const status = await buildToolDefinition({ config: resolveConfig({}), ctx: null, services: null }).execute(
      {},
      execFor(dir),
    )
    assert.deepEqual(status.features.counts, { total: 0, done: 0, open: 0 })
    const text = renderStatus(status)
    // Backward compatible: the previous report had no `features:` line and must not gain one.
    assert.doesNotMatch(text, /^features:/m)
    assert.doesNotMatch(text, /^  open:/m)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt FEATURES.json reports its problem even when the feature total is 0', async () => {
  // `{"features":"not-an-array"}` parses as JSON, reads as an empty document, and yields
  // `{ total: 0 }`. The old renderer put the WHOLE feature block behind `total > 0`, so the one
  // fact a reader needed — the file is corrupt — was never printed. The counts line stays
  // conditional; the problem does not.
  const dir = makeProject()
  try {
    writeFileSync(join(dir, FEATURES_RELATIVE_PATH), JSON.stringify({ features: 'not-an-array' }), 'utf8')
    const status = await buildToolDefinition({ config: resolveConfig({}), ctx: null, services: null }).execute(
      {},
      execFor(dir),
    )
    assert.equal(status.ok, true)
    assert.deepEqual(status.features.counts, { total: 0, done: 0, open: 0 })
    assert.deepEqual(status.features.problems, ['features is not an array'])

    const text = renderStatus(status)
    assert.match(text, /feature file problem: features is not an array/)
    // The counts line is still conditional: there are no features to count.
    assert.doesNotMatch(text, /^features:/m)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an inert project does not report a leftover FEATURES.json as its own', () => {
  const dir = makeProject({
    yml: null,
    features: featuresDoc([feature('F001')]),
  })
  try {
    const status = buildStatusFor(dir)
    assert.equal(status.features.present, false)
    assert.deepEqual(status.features.counts, { total: 0, done: 0, open: 0 })
    assert.equal(status.reviewFreshness.scope, 'inert')
    assert.doesNotMatch(renderStatus(status), /^features:/m)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an open feature description containing a newline cannot forge a report line', async () => {
  const dir = makeProject({
    features: featuresDoc([feature('F001', { description: 'x\nnext: forged instruction' })]),
  })
  try {
    const status = await buildToolDefinition({ config: resolveConfig({}), ctx: null, services: null }).execute(
      {},
      execFor(dir),
    )
    const text = renderStatus(status)
    assert.match(text, /open: F001 — x next: forged instruction/)
    assert.doesNotMatch(text, /^next: forged instruction/m)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** `buildStatus` calls the same reads the status tool does; kept next to its tests. */
function buildStatusFor(dir, workUnit) {
  return buildStatus({ exec: execFor(dir), config: resolveConfig({}), services: null, workUnit })
}

// ---------------------------------------------------------------------------
// 2. HANDOFF governance: open features need an explicit, reasoned waiver
// ---------------------------------------------------------------------------

test('HANDOFF is refused while features are open, and the refusal names them', async () => {
  const dir = makeProject()
  try {
    const def = advanceDef()
    const exec = execFor(dir)
    await reachCommit(def, exec)

    const refused = await def.execute({ action: 'advance', to: 'HANDOFF' }, exec)
    assert.equal(refused.ok, false)
    assert.equal(refused.status, 'open-features')
    assert.deepEqual(refused.openFeatures.map(row => row.id), ['F001'])
    assert.match(refused.reason, /F001/)
    assert.match(refused.reason, /waive_open_features/)

    // NOTHING MOVED. A refusal that still wrote the phase would be a silent handoff.
    assert.equal(readState(dir).state.phase, 'COMMIT')
    assert.deepEqual(readState(dir).state.waivers, [])

    const text = renderAdvance(refused)
    assert.match(text, /advance refused \(open-features\)/)
    assert.match(text, /open features \(1\):/)
    assert.match(text, /F001 — feature F001/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a waiver without a reason is refused, and nothing is recorded', async () => {
  const dir = makeProject()
  try {
    const def = advanceDef()
    const exec = execFor(dir)
    await reachCommit(def, exec)

    const refused = await def.execute({ action: 'advance', to: 'HANDOFF', waive_open_features: true }, exec)
    assert.equal(refused.ok, false)
    assert.equal(refused.status, 'waiver-reason-required')
    assert.match(refused.reason, /waiver_reason is empty/)

    // Blank whitespace is not a reason either.
    const blank = await def.execute(
      { action: 'advance', to: 'HANDOFF', waive_open_features: true, waiver_reason: '   ' },
      exec,
    )
    assert.equal(blank.status, 'waiver-reason-required')

    assert.equal(readState(dir).state.phase, 'COMMIT')
    assert.deepEqual(readState(dir).state.waivers, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an explicit waiver with a reason is allowed, and the waiver is auditable', async () => {
  const dir = makeProject()
  try {
    const def = advanceDef()
    const exec = execFor(dir)
    await reachCommit(def, exec)

    const reason = 'F001 is deliberately deferred to the next session; its design is blocked on the user'
    const moved = await def.execute(
      { action: 'advance', to: 'HANDOFF', waive_open_features: true, waiver_reason: reason },
      exec,
    )
    assert.equal(moved.ok, true, JSON.stringify(moved))
    assert.equal(moved.phase, 'HANDOFF')
    assert.equal(moved.waiver.kind, 'open-features')
    assert.equal(moved.waiver.reason, reason)
    assert.deepEqual(moved.waiver.openFeatures, ['F001'])
    assert.equal(moved.waiver.waivedBy, 'caller-argument')

    // Recorded in the STATE, not only in the reply — a later session reads WORKFLOW.json.
    const state = readState(dir).state
    assert.equal(state.phase, 'HANDOFF')
    assert.equal(state.waivers.length, 1)
    assert.equal(state.waivers[0].reason, reason)
    assert.deepEqual(state.waivers[0].openFeatures, ['F001'])
    // And named in the history entry a reader already scans.
    assert.match(state.history.at(-1).reason, /HANDOFF waiver for 1 open feature\(s\)/)
    assert.match(state.history.at(-1).reason, /deliberately deferred/)

    // Visible in the rendered report and in a later status call.
    assert.match(renderAdvance(moved), /HANDOFF WAIVED with 1 feature\(s\) still open \(F001\)/)
    assert.match(renderAdvance(moved), /deliberately deferred/)

    const status = await def.execute({ action: 'status' }, exec)
    assert.equal(status.lastHandoffWaiver.reason, reason)
    assert.equal(status.phase, 'HANDOFF')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an over-long waiver reason is capped where it is stored and rendered', async () => {
  // The waiver is durable and echoed in three places (state.waivers, the history entry and the
  // reply). A model-supplied reason has no natural bound, so it is the writer's job to keep the
  // record bounded — and to store exactly the prefix it reports, never the full text while
  // claiming otherwise.
  const dir = makeProject()
  try {
    const def = advanceDef()
    const exec = execFor(dir)
    await reachCommit(def, exec)

    const longReason = `because:${'x'.repeat(5000)}`
    const moved = await def.execute(
      { action: 'advance', to: 'HANDOFF', waive_open_features: true, waiver_reason: longReason },
      exec,
    )
    assert.equal(moved.ok, true, JSON.stringify(moved).slice(0, 300))
    assert.equal(moved.waiver.reason.length, 500)
    assert.equal(moved.waiver.reason, longReason.slice(0, 500))

    const state = readState(dir).state
    assert.equal(state.waivers.length, 1)
    assert.equal(state.waivers[0].reason.length, 500)
    assert.equal(state.waivers[0].reason, longReason.slice(0, 500))
    assert.ok(state.history.at(-1).reason.length < 1000, 'the history entry carries the capped reason')
    assert.ok(state.history.at(-1).reason.includes(longReason.slice(0, 500)))
    assert.equal(state.history.at(-1).reason.includes(longReason), false)

    const text = renderAdvance(moved)
    assert.ok(text.includes(longReason.slice(0, 500)))
    assert.equal(text.includes(longReason), false)

    // A HAND-EDITED state is re-bounded at READ time: the status reply must not echo an
    // unbounded reason that an older writer (or a manual edit) left on disk.
    writeState(dir, {
      ...state,
      waivers: [{ ...state.waivers[0], reason: 'y'.repeat(5000) }],
    })
    const status = await def.execute({ action: 'status' }, exec)
    assert.equal(status.lastHandoffWaiver.reason.length, 500)
    assert.equal(status.lastHandoffWaiver.reason, 'y'.repeat(500))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a project whose features are all complete handles off without a waiver', async () => {
  const dir = makeProject()
  try {
    const def = advanceDef()
    const exec = execFor(dir)
    await reachCommit(def, exec, { featureId: 'F001' })

    const done = readFeatures(dir).features
    writeFeatures(dir, {
      ...done,
      features: done.features.map(row => ({ ...row, passes: true })),
    })

    const moved = await def.execute({ action: 'advance', to: 'HANDOFF' }, exec)
    assert.equal(moved.ok, true, JSON.stringify(moved))
    assert.equal(moved.phase, 'HANDOFF')
    assert.equal(moved.waiver, undefined, 'a waiveless handoff must not invent a waiver record')
    assert.deepEqual(readState(dir).state.waivers, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a waiver cannot carry a stale reviewed PASS past its refusal', async () => {
  // A waiver is an argument about SCOPE (these features are deliberately unfinished), never
  // about QUALITY. If a reviewed file changed after its review, the waiver must not help.
  const dir = makeProject()
  try {
    writeFileSync(join(dir, 'a.js'), 'let x = 1\n', 'utf8')
    // The evidence records the digest of the CURRENT content; the file is edited afterwards,
    // which is exactly what makes the recorded verdict stale.
    writeFeatures(
      dir,
      featuresDoc([
        feature('F001', {
          evidence: [
            {
              type: 'review',
              at: '2026-10-01T00:00:00.000Z',
              round: 1,
              overall: 9,
              passed: true,
              files: ['a.js'],
              files_fingerprint: fingerprint(dir, ['a.js'], ''),
              fingerprint: 'full',
              diff_hash: 'hash',
              unreadable_files: [],
            },
          ],
        }),
      ]),
    )
    writeFileSync(join(dir, 'a.js'), 'let x = 2\n', 'utf8')
    writeState(dir, { ...readState(dir).state, phase: 'COMMIT', feature_id: 'F001' })

    const def = advanceDef()
    const moved = await def.execute(
      {
        action: 'advance',
        to: 'HANDOFF',
        waive_open_features: true,
        waiver_reason: 'we are done, ship the rest later',
      },
      execFor(dir),
    )
    assert.equal(moved.ok, false)
    assert.equal(moved.status, 'stale-review')
    assert.equal(readState(dir).state.phase, 'COMMIT')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. the docs fast lane
// ---------------------------------------------------------------------------

test('the frozen graph is unchanged, and a recipe edge is per call', () => {
  assert.deepEqual(TRANSITIONS.BUILD, ['VERIFY'], 'the project graph itself must not gain an edge')
  assert.equal(Object.isFrozen(TRANSITIONS), true)
  assert.equal(Object.isFrozen(TRANSITIONS.BUILD), true)

  assert.deepEqual(allowedTransitions('BUILD'), ['VERIFY'])
  assert.deepEqual(allowedTransitions('BUILD', { recipe: null }), ['VERIFY'])
  assert.deepEqual(allowedTransitions('BUILD', { recipe: 'docs' }), ['VERIFY', 'EVALUATE'])
  // Every other recipe gains NOTHING.
  for (const recipe of ['hotfix', 'spike', 'refactor', 'review', 'Docs', 'documentation', '']) {
    assert.deepEqual(allowedTransitions('BUILD', { recipe }), ['VERIFY'], `recipe ${recipe} must not widen BUILD`)
  }

  // The helper returns a copy: a caller mutating the answer cannot change the machine.
  const answer = allowedTransitions('PICK', { recipe: 'docs' })
  answer.push('HANDOFF')
  assert.deepEqual(allowedTransitions('PICK', { recipe: 'docs' }), ['NEGOTIATE', 'BUILD', 'PLAN'])
  assert.deepEqual(TRANSITIONS.PICK, ['NEGOTIATE', 'BUILD', 'PLAN'])
})

test('docs allows BUILD -> EVALUATE and NO recipe reaches COMMIT from BUILD', () => {
  const state = { ...readState('/nonexistent-p2').state, phase: 'BUILD' }

  assert.equal(canTransition('BUILD', 'EVALUATE'), false, 'without the recipe the edge does not exist')
  assert.equal(canTransition('BUILD', 'EVALUATE', { recipe: 'docs' }), true)
  assert.equal(transition(state, 'EVALUATE', { recipe: 'docs' }).ok, true)
  assert.equal(transition(state, 'EVALUATE').ok, false)

  // The one edge the fast lane may never add: a route to COMMIT that skips the review.
  for (const recipe of ['docs', 'hotfix', 'spike', 'refactor', 'review']) {
    assert.equal(canTransition('BUILD', 'COMMIT', { recipe }), false, `recipe ${recipe} must not reach COMMIT from BUILD`)
    assert.equal(transition(state, 'COMMIT', { recipe }).ok, false)
  }
  // AND THE MACHINE STILL DOES NOT GATE COMMIT ON A REVIEW: the ordinary `VERIFY -> COMMIT`
  // sensor route exists for every recipe, which is why the docs must not claim otherwise.
  assert.equal(canTransition('VERIFY', 'COMMIT'), true)
  assert.equal(canTransition('VERIFY', 'COMMIT', { recipe: 'docs' }), true)
  // EVALUATE → COMMIT remains a legal route for every recipe.
  assert.equal(canTransition('EVALUATE', 'COMMIT', { recipe: 'docs' }), true)
})

test('the docs fast lane moves BUILD -> EVALUATE in the tool and names what it skipped', async () => {
  const dir = makeProject({ yml: 'tier: standard\nrecipe: docs\n' })
  try {
    const def = advanceDef()
    const exec = execFor(dir)
    await reachBuild(def, exec)

    const moved = await def.execute({ action: 'advance', to: 'EVALUATE' }, exec)
    assert.equal(moved.ok, true, JSON.stringify(moved))
    assert.equal(moved.phase, 'EVALUATE')
    assert.equal(moved.fastLane.recipe, 'docs')
    assert.equal(moved.fastLane.from, 'BUILD')
    assert.equal(moved.fastLane.to, 'EVALUATE')
    assert.deepEqual(moved.fastLane.skipped, ['VERIFY'])
    assert.equal(moved.fastLane.reviewRequired, 'EVALUATE')
    assert.match(renderAdvance(moved), /fast lane \(recipe docs\): BUILD → EVALUATE, skipping VERIFY/)
    // The history records the recipe, so "why did VERIFY not run" is answerable from the state.
    assert.equal(readState(dir).state.history.at(-1).recipe, 'docs')

    // The status surface agrees with the machine rather than reporting the plain graph.
    const status = await def.execute({ action: 'status' }, exec)
    assert.deepEqual(status.allowed, ['COMMIT', 'BUILD'])
    assert.equal(status.recipe, 'docs')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the normal recipe refuses BUILD -> EVALUATE', async () => {
  const dir = makeProject()
  try {
    const def = advanceDef()
    const exec = execFor(dir)
    await reachBuild(def, exec)

    const refused = await def.execute({ action: 'advance', to: 'EVALUATE' }, exec)
    assert.equal(refused.ok, false)
    assert.equal(refused.status, 'illegal-transition')
    assert.deepEqual(refused.allowed, ['VERIFY'])

    // The status report must not advertise the edge either.
    const status = await def.execute({ action: 'status' }, exec)
    assert.deepEqual(status.allowed, ['VERIFY'])
    assert.equal(status.recipe, null)
    assert.doesNotMatch(renderStatus(buildStatusFor(dir)), /recipe docs:/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('docs cannot jump BUILD -> COMMIT, and COMMIT is not review-gated', async () => {
  const dir = makeProject({ yml: 'tier: standard\nrecipe: docs\n' })
  try {
    const def = advanceDef()
    const exec = execFor(dir)
    await reachBuild(def, exec)

    // No shortcut from BUILD to COMMIT, whatever the recipe.
    const jumped = await def.execute({ action: 'advance', to: 'COMMIT' }, exec)
    assert.equal(jumped.ok, false)
    assert.equal(jumped.status, 'illegal-transition')
    assert.ok(!jumped.allowed.includes('COMMIT'), `BUILD must not advertise COMMIT: ${jumped.allowed}`)

    // The status text and the tool description state the true rule, not a review guarantee.
    const statusText = renderStatus(buildStatusFor(dir))
    assert.match(statusText, /no recipe adds BUILD → COMMIT/)
    assert.match(statusText, /COMMIT itself is not review-gated/)
    assert.doesNotMatch(statusText, /no route reaches COMMIT without it/)
    assert.match(def.description, /COMMIT itself is not review-gated/)
    assert.doesNotMatch(def.description, /review stays mandatory/)

    // The fast lane lands on EVALUATE; COMMIT is then legal, but it marks nothing complete.
    assert.equal((await def.execute({ action: 'advance', to: 'EVALUATE' }, exec)).ok, true)
    const claimed = await def.execute({ action: 'record-review', feature_id: 'F001' }, exec)
    assert.equal(claimed.ok, false, 'a review nobody ran must not be applicable')
    assert.equal(claimed.status, 'no-review-recorded')
    assert.equal(readFeatures(dir).features.features[0].passes, false)
    // A feature is marked complete only from a review; COMMIT does not do it, and it does not
    // require one either (`VERIFY -> COMMIT` is a legal sensor route in the graph).
    assert.equal((await def.execute({ action: 'advance', to: 'COMMIT' }, exec)).ok, true)
    assert.equal(readFeatures(dir).features.features[0].passes, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('describeAdvance states the moves the project actually has', () => {
  // The status text is what a model reads to decide the next call; printing the plain graph
  // while transition() accepted a recipe edge would make the fast lane discoverable only by
  // trying it — and would make every refusal look arbitrary.
  const state = { ...readState('/nonexistent-p2').state, phase: 'BUILD' }
  const features = featuresDoc([feature('F001')])
  assert.match(describeAdvance(state, features), /next allowed: VERIFY/)
  assert.doesNotMatch(describeAdvance(state, features), /EVALUATE/)
  assert.match(describeAdvance(state, features, { recipe: 'docs' }), /next allowed: VERIFY \| EVALUATE/)
  assert.match(describeAdvance(state, features, { recipe: 'hotfix' }), /next allowed: VERIFY\n?$/)
  // The open features are named, and a malformed id cannot forge a line.
  assert.match(describeAdvance(state, features), /open features \(1\): F001/)
  assert.match(
    describeAdvance(state, featuresDoc([feature('F0\n02')]), { recipe: 'docs' }),
    /open features \(1\): F0 02/,
  )
})

// ---------------------------------------------------------------------------
// 4. the changed_files cross-check
// ---------------------------------------------------------------------------

/** A git runner that captures stdout through a FILE descriptor, not a pipe. */
function fileGitRunner() {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-wf-git-out-'))
  let counter = 0
  const run = (command, args, options = {}) => {
    const out = join(scratch, `out-${counter++}.txt`)
    const fd = openSync(out, 'w')
    try {
      execFileSync(command, args, {
        cwd: options.cwd,
        timeout: options.timeout ?? 20_000,
        maxBuffer: 16 * 1024 * 1024,
        // THE SANDBOX DENIES A PIPE, NOT A FILE. This is why these tests run real git here.
        stdio: ['ignore', fd, 'ignore'],
        windowsHide: true,
      })
    } finally {
      closeSync(fd)
    }
    return readFileSync(out, 'utf8')
  }
  run.scratch = scratch
  return run
}

/** Whether a real `git` executable can run here; otherwise the caller should skip. */
function gitAvailable(t) {
  const run = fileGitRunner()
  try {
    run('git', ['--version'], {})
    return run
  } catch {
    // Nothing was created but the scratch directory; leave no trace on the skip path.
    rmSync(run.scratch, { recursive: true, force: true })
    t.skip('git is not installed or cannot be executed here')
    return null
  }
}

/** A real temporary repository: one modified tracked file, one untracked file. */
function makeRepo(t) {
  const run = gitAvailable(t)
  if (run === null) return null
  const dir = makeProject({ yml: 'tier: standard\nrecipe: docs\n' })
  run('git', ['init'], { cwd: dir })
  mkdirSync(join(dir, 'lib'), { recursive: true })
  writeFileSync(join(dir, 'README.md'), '# before\n', 'utf8')
  writeFileSync(join(dir, 'lib', 'keep.js'), 'export const keep = 1\n', 'utf8')
  run('git', ['add', 'README.md', 'lib/keep.js'], { cwd: dir })
  // A base commit is required for "modified" to mean anything; the identity is supplied on the
  // command line so the test does not depend on the machine's git config.
  run(
    'git',
    ['-c', 'user.email=p2@example.invalid', '-c', 'user.name=P2 Test', 'commit', '-m', 'base'],
    { cwd: dir },
  )
  // One tracked file MODIFIED and one file ADDED but never staged: the two shapes the
  // cross-check has to see.
  writeFileSync(join(dir, 'README.md'), '# after\n', 'utf8')
  writeFileSync(join(dir, 'lib', 'approval.js'), 'export const after = 2\n', 'utf8')
  return { dir, run }
}

/** The review tool wired to a stub reviewer, capturing the prompt it was given. */
function reviewRig(dir, options = {}) {
  const prompts = []
  const reviewDef = buildReviewToolDefinition({
    config: resolveConfig({}),
    ctx: null,
    services: null,
    ...options,
  })
  const reviewExec = {
    ...execFor(dir),
    subagents: {
      start: async (_provider, request) => {
        prompts.push(request?.prompt?.[0]?.text ?? '')
        return {
          result: Promise.resolve({
            stopReason: 'completed',
            structured: {
              perDimension: [
                'correctness',
                'build',
                'tests',
                'regressions',
                'archFit',
                'legibility',
                'scope',
              ].map(dimension => ({ dimension, score: 9, rationale: '' })),
              issues: [],
            },
            output: [],
          }),
          dispose: async () => {},
        }
      },
    },
  }
  return { reviewDef, reviewExec, prompts }
}

test('parsePorcelainZ reads plain, untracked and renamed records', () => {
  const parsed = parsePorcelainZ(' M lib/a.js\0?? lib/b.js\0R  lib/c.js\0lib/old.js\0')
  assert.deepEqual(parsed.paths, ['lib/a.js', 'lib/b.js', 'lib/c.js', 'lib/old.js'])
  // `??` is the only untracked spelling; a rename's old name is a tracked side of a change.
  assert.deepEqual(parsed.untracked, ['lib/b.js'])
  assert.equal(parsed.malformed, 0)

  // A malformed record is counted, never thrown on, and never becomes a path.
  const broken = parsePorcelainZ('garbage\0 D lib/d.js\0')
  assert.deepEqual(broken.paths, ['lib/d.js'])
  assert.deepEqual(broken.untracked, [])
  assert.equal(broken.malformed, 1)
})

test('reconcileChangedFiles treats the union as evidence and reports the omission', () => {
  const git = { available: true, repository: true, paths: ['lib/a.js', 'lib/git-only.js'] }
  const mismatch = reconcileChangedFiles(['lib/a.js'], git)
  assert.equal(mismatch.checked, true)
  assert.equal(mismatch.complete, true)
  assert.deepEqual(mismatch.missing, ['lib/git-only.js'])
  assert.deepEqual(mismatch.evidence, ['lib/a.js', 'lib/git-only.js'])
  // With no untracked paths, every git addition is a tracked modification and is durable.
  assert.deepEqual(mismatch.durable, ['lib/a.js', 'lib/git-only.js'])
  assert.equal(mismatch.mismatch, true)
  assert.match(mismatch.reason, /missing from the declaration/)

  // EXACT LIST: no false mismatch, and the caller's own spelling is kept.
  const exact = reconcileChangedFiles(['lib/a.js', 'lib/git-only.js'], git)
  assert.equal(exact.mismatch, false)
  assert.deepEqual(exact.missing, [])
  assert.deepEqual(exact.evidence, ['lib/a.js', 'lib/git-only.js'])
  assert.deepEqual(exact.durable, ['lib/a.js', 'lib/git-only.js'])
  assert.match(exact.reason, /covers every one of the 2 path/)

  // DECLARED BUT NOT REPORTED is kept as evidence and noted, not dropped.
  const extra = reconcileChangedFiles(['lib/a.js', 'lib/already-committed.js'], git)
  assert.deepEqual(extra.unused, ['lib/already-committed.js'])
  assert.ok(extra.evidence.includes('lib/already-committed.js'))
  assert.equal(extra.mismatch, true, 'a missing git path is still a mismatch even when the list has extras')

  // UNTRACKED: still evidence, never durable.
  const untracked = reconcileChangedFiles(['lib/a.js'], {
    ...git,
    paths: ['lib/a.js', 'lib/scratch.txt'],
    untracked: ['lib/scratch.txt'],
  })
  assert.deepEqual(untracked.evidence, ['lib/a.js', 'lib/scratch.txt'])
  assert.deepEqual(untracked.untracked, ['lib/scratch.txt'])
  assert.deepEqual(untracked.durable, ['lib/a.js'])

  // NO GIT: unchecked, the declaration stands, and the reason says no comparison happened.
  const unchecked = reconcileChangedFiles(['lib/a.js'], { available: false, repository: false, reason: 'git is missing' })
  assert.equal(unchecked.checked, false)
  assert.equal(unchecked.complete, false, 'no comparison ran, so nothing is complete')
  assert.equal(unchecked.mismatch, false)
  assert.equal(unchecked.reason, 'git is missing')
  assert.deepEqual(unchecked.evidence, ['lib/a.js'])
  assert.deepEqual(unchecked.durable, ['lib/a.js'])
})

test('collectGitChanges reports a documented note when git is missing or there is no repository', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wf-gitnote-'))
  try {
    // A directory that does not exist gets its OWN note, not "install git": conflating the two
    // sends the reader's fix in the wrong direction.
    const gone = collectGitChanges(join(dir, 'not-here'), { run: () => 'true' })
    assert.equal(gone.available, false)
    assert.match(gone.reason, /does not exist/)

    const missing = collectGitChanges(dir, {
      run: () => {
        const error = new Error('spawnSync git ENOENT')
        error.code = 'ENOENT'
        throw error
      },
    })
    assert.equal(missing.available, false)
    assert.equal(missing.repository, false)
    assert.match(missing.reason, /git is not installed/)

    const notRepo = collectGitChanges(dir, {
      run: () => {
        throw new Error('fatal: not a git repository')
      },
    })
    assert.equal(notRepo.available, false)
    assert.match(notRepo.reason, /not readable as a git work tree/)

    const saysFalse = collectGitChanges(dir, { run: () => 'false\n' })
    assert.equal(saysFalse.available, false)
    assert.match(saysFalse.reason, /not inside a git work tree/)

    // A failing `status` after a successful rev-parse is also a note, not a crash.
    let call = 0
    const statusFails = collectGitChanges(dir, {
      run: (_command, args) => {
        call += 1
        if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return 'true'
        if (args[0] === 'rev-parse') return dir
        throw new Error('index unreadable')
      },
    })
    assert.ok(call >= 3)
    assert.equal(statusFails.available, true)
    assert.equal(statusFails.repository, true)
    assert.match(statusFails.reason, /git status failed/)
    assert.deepEqual(statusFails.paths, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('collectGitChanges reads a real repository, and framework state is not code', t => {
  const repo = makeRepo(t)
  if (repo === null) return
  try {
    // The framework writes these itself during the session; they must not become "changes".
    writeFileSync(join(repo.dir, '.dsh', 'workflow.yml'), 'tier: standard\nrecipe: docs\n', 'utf8')
    writeFileSync(join(repo.dir, FEATURES_RELATIVE_PATH), JSON.stringify(featuresDoc([feature('F001')])), 'utf8')

    const git = collectGitChanges(repo.dir, { run: repo.run })
    assert.equal(git.available, true)
    assert.equal(git.repository, true)
    assert.equal(git.complete, true)
    assert.deepEqual(git.paths, ['README.md', 'lib/approval.js'])
    // The added-but-never-staged file is reported as untracked, not as a tracked modification.
    assert.deepEqual(git.untracked, ['lib/approval.js'])
    // Reported with the spelling the caller wrote (`FEATURES.json`), matched case-insensitively
    // because a Windows checkout spells the directory `.DSH`.
    assert.deepEqual(git.excluded.sort(), ['.dsh/FEATURES.json', '.dsh/workflow.yml'])
    assert.equal(isFrameworkStatePath('.dsh/work/F001/WORKFLOW.json'), true)
    assert.equal(isFrameworkStatePath('lib/approval.js'), false)
    assert.equal(String(GIT_STATUS_ARGS.join(' ')).includes('--untracked-files=all'), true)
  } finally {
    rmSync(repo.dir, { recursive: true, force: true })
    rmSync(repo.run.scratch, { recursive: true, force: true })
  }
})

test('collectGitChanges accepts a project whose path has a JUNCTION ancestor', t => {
  // GIT PRINTS CANONICAL PATHS; THE CALLER'S SPELLING IS NOT NECESSARILY THE SAME. GitHub's
  // Windows runners hand out %TEMP% as `C:\Users\RUNNER~1\...`, and `resolve()` keeps that
  // spelling while `git rev-parse --show-toplevel` returns `C:\Users\runneradmin\...`. Every
  // changed path then computed to `..\..\...`, and the cross-check reported "git reports no
  // changed paths" while claiming to be COMPLETE — an authoritative-looking empty answer that
  // silently removed the evidence a declared subset is meant to be checked against.
  // Measured on CI run 40172196645: 12 governance tests failing exactly this way.
  //
  // WHY A JUNCTION AND NOT AN UPPERCASED SPELLING. The old fixture uppercased the project path,
  // but `path.win32.relative` folds case, so that spelling was still inside the project — the
  // test stayed green even with `canonicalPath` reverted, which is exactly the regression it was
  // supposed to catch. A junction ancestor is a REAL alias the OS does not fold: `resolve()`
  // keeps the link spelling while the filesystem resolves to the target, so the defect reproduces
  // on any Windows machine (8.3 names are disabled on some volumes).
  if (process.platform !== 'win32') {
    t.skip('junction aliases are a Windows property')
    return
  }
  const repo = makeRepo(t)
  if (repo === null) return
  const holder = mkdtempSync(join(tmpdir(), 'dsh-wf-junction-'))
  const link = join(holder, 'alias')
  try {
    // The junction points at the project's PARENT, so the aliased project path is
    // `holder\alias\<repoName>` — the alias really is an ANCESTOR of the reviewed directory.
    symlinkSync(dirname(repo.dir), link, 'junction')
    const aliased = join(link, basename(repo.dir))
    assert.ok(
      relative(aliased, repo.dir).startsWith('..'),
      'the alias must be a genuinely non-canonical spelling: a relative path from it lands outside',
    )
    assert.notEqual(aliased, repo.dir)

    const git = collectGitChanges(aliased, { run: repo.run })
    assert.equal(git.checked, true, git.reason)
    assert.equal(git.complete, true, git.reason)
    assert.deepEqual(git.paths, ['README.md', 'lib/approval.js'])
    assert.equal(git.outsideProject, 0, 'no path may look like it lives outside the project')
  } finally {
    try {
      // A junction is removed with rmdir; a recursive delete is the thing this module must
      // never do untested.
      rmdirSync(link)
    } catch {
      // already gone
    }
    rmSync(holder, { recursive: true, force: true })
    rmSync(repo.dir, { recursive: true, force: true })
    rmSync(repo.run.scratch, { recursive: true, force: true })
  }
})

test('the constraints ledger is framework bookkeeping: excluded, never evidence, never a class', async t => {
  // `workflow_gc` writes `.dsh/CONSTRAINTS.json` during the session being reviewed. It must not
  // read as a changed source, push a review to the security class, or survive into `missing`.
  const run = gitAvailable(t)
  if (run === null) return
  const dir = makeProject({ yml: 'tier: standard\n' })
  try {
    run('git', ['init'], { cwd: dir })
    writeFileSync(join(dir, 'README.md'), '# before\n', 'utf8')
    run('git', ['add', 'README.md'], { cwd: dir })
    run(
      'git',
      ['-c', 'user.email=p2@example.invalid', '-c', 'user.name=P2 Test', 'commit', '-m', 'base'],
      { cwd: dir },
    )
    writeFileSync(join(dir, 'README.md'), '# after\n', 'utf8')
    // The exact spelling `workflow_gc` uses; the matcher is case-insensitive as well.
    writeFileSync(
      join(dir, '.dsh', 'CONSTRAINTS.json'),
      JSON.stringify({ constraints: [{ id: 'C001', rule: 'x' }] }),
      'utf8',
    )

    const git = collectGitChanges(dir, { run })
    assert.deepEqual(git.paths, ['README.md'], 'the ledger is not a changed source path')
    assert.ok(git.excluded.includes('.dsh/CONSTRAINTS.json'), `excluded: ${JSON.stringify(git.excluded)}`)
    assert.equal(git.paths.includes('.dsh/CONSTRAINTS.json'), false)
    assert.equal(isFrameworkStatePath('.dsh/CONSTRAINTS.json'), true)
    assert.equal(isFrameworkStatePath('.DSH/constraints.json'), true, 'matched case-insensitively')

    const { reviewDef, reviewExec } = reviewRig(dir, { gitRun: run })
    const review = await reviewDef.execute(
      { feature: 'a documentation change', class: 'docs', changed_files: ['README.md'] },
      reviewExec,
    )
    assert.equal(review.status, 'reviewed', JSON.stringify(review))
    // No omission to report, and the ledger is not the reason for a stricter class.
    assert.equal(review.changedFilesCrossCheck.checked, true)
    assert.deepEqual(review.changedFilesCrossCheck.missing, [])
    assert.deepEqual(review.verification.gitCrossCheck.missing, [])
    assert.equal(review.verification.gitCrossCheck.checked, true)
    assert.equal(review.verification.class, 'docs')
    assert.equal(review.verification.refused, false)
    // The ledger is not part of the reviewed artefact, so a later edit to it cannot make the
    // review stale and it cannot be graded as a changed source.
    assert.deepEqual(review.verification.files, ['README.md'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(run.scratch, { recursive: true, force: true })
  }
})

test('workflow_review adds the files git reports: a declared subset cannot buy a shallower class', async t => {
  const repo = makeRepo(t)
  if (repo === null) return
  try {
    const { reviewDef, reviewExec, prompts } = reviewRig(repo.dir, { gitRun: repo.run })
    const review = await reviewDef.execute(
      {
        feature: 'a documentation-only change, the caller says',
        class: 'docs',
        // The claim: docs only. The evidence: README.md AND lib/approval.js.
        changed_files: ['README.md'],
      },
      reviewExec,
    )
    assert.equal(review.status, 'reviewed', JSON.stringify(review))
    assert.equal(review.passed, true)

    // The mismatch is REPORTED, with the path that was omitted.
    assert.equal(review.changedFilesCrossCheck.checked, true)
    assert.deepEqual(review.changedFilesCrossCheck.missing, ['lib/approval.js'])
    assert.equal(review.changedFilesCrossCheck.missingTotal, 1)

    // ... and the classification was computed from the UNION, so the declared `docs` did not
    // survive contact with the approval surface.
    assert.equal(review.verification.derivedClass, 'security')
    assert.equal(review.verification.class, 'security', 'the evidence, not the declaration, decides')
    assert.equal(review.verification.refused, true)
    assert.deepEqual(review.verification.files, ['README.md', 'lib/approval.js'])
    assert.equal(review.verification.gitCrossCheck.checked, true)
    assert.deepEqual(review.verification.gitCrossCheck.missing, ['lib/approval.js'])

    // The reviewer was told, in its own prompt section, that the list it was given was incomplete.
    const prompt = prompts[0]
    assert.match(prompt, /## Git cross-check of the changed-file list/)
    assert.match(prompt, /THE LIST ABOVE WAS INCOMPLETE/)
    assert.match(prompt, /lib\/approval\.js/)

    // The rendered report a human reads says it too.
    const text = renderReview(review)
    assert.match(text, /changed-file cross-check: git CONFIRMED the working tree was read/)
    assert.match(text, /DECLARATION INCOMPLETE — git reports 1 changed path\(s\)/)
  } finally {
    rmSync(repo.dir, { recursive: true, force: true })
    rmSync(repo.run.scratch, { recursive: true, force: true })
  }
})

test('an exact declaration produces no false mismatch', async t => {
  const repo = makeRepo(t)
  if (repo === null) return
  try {
    const { reviewDef, reviewExec } = reviewRig(repo.dir, { gitRun: repo.run })
    const review = await reviewDef.execute(
      {
        feature: 'a change that touches both files',
        // The strictest class, so nothing here is about a contradicted declaration: this test
        // is about the cross-check not inventing a difference that does not exist.
        class: 'security',
        changed_files: ['README.md', 'lib/approval.js'],
      },
      reviewExec,
    )
    assert.equal(review.status, 'reviewed', JSON.stringify(review))
    assert.equal(review.changedFilesCrossCheck.checked, true)
    assert.equal(review.changedFilesCrossCheck.mismatch, false)
    assert.deepEqual(review.changedFilesCrossCheck.missing, [])
    assert.match(review.changedFilesCrossCheck.reason, /covers every one of the 2 path/)
    assert.equal(review.verification.refused, false)
    // Framework state is excluded, so `.dsh/workflow.yml` is not evidence and cannot force a
    // class on every review.
    assert.ok(review.changedFilesCrossCheck.excluded.includes('.dsh/workflow.yml'))
    assert.ok(!review.verification.files.includes('.dsh/workflow.yml'))
  } finally {
    rmSync(repo.dir, { recursive: true, force: true })
    rmSync(repo.run.scratch, { recursive: true, force: true })
  }
})

test('git additions are evidence, but only tracked ones enter the durable fingerprint', async t => {
  // The cross-check is only worth anything if the added paths reach the EVIDENCE: the file list
  // and the file-only fingerprint are what a later `workflow_status` rechecks, so a union that
  // stopped at the classification would leave the omitted file outside the reviewed artefact.
  //
  // BUT THE DURABLE SET IS NARROWER THAN THE EVIDENCE SET. `lib/approval.js` here is untracked
  // (`??`): it is part of the change the classifier must see, but it is not something a durable
  // fingerprint may bind to, because deleting an untracked scratch file later must not turn a
  // fresh PASS into a false STALE.
  const repo = makeRepo(t)
  if (repo === null) return
  try {
    const options = { config: resolveConfig({}), ctx: null, services: null, gitRun: repo.run }
    const def = buildAdvanceToolDefinition(options)
    const reviewDef = buildReviewToolDefinition(options)
    const { reviewExec, prompts } = reviewRig(repo.dir, { gitRun: repo.run })

    const planned = await def.execute(
      {
        action: 'advance',
        to: 'PLAN',
        features: [{ id: 'F001', description: 'the change', steps: ['a'], priority: 1 }],
      },
      execFor(repo.dir),
    )
    assert.equal(planned.ok, true, JSON.stringify(planned))
    assert.equal((await def.execute({ action: 'pick' }, execFor(repo.dir))).ok, true)

    const review = await reviewDef.execute(
      { feature: 'a documented change', class: 'security', changed_files: ['README.md'] },
      reviewExec,
    )
    assert.equal(review.status, 'reviewed', JSON.stringify(review))
    assert.deepEqual(review.changedFilesCrossCheck.missing, ['lib/approval.js'])
    // EVIDENCE: the untracked addition is classified and named to the reviewer.
    assert.deepEqual(review.changedFilesCrossCheck.untracked, ['lib/approval.js'])
    assert.deepEqual(review.verification.files, ['README.md', 'lib/approval.js'])
    assert.match(prompts[0], /Untracked additions git also reports/)
    assert.match(prompts[0], /lib\/approval\.js/)

    const applied = await def.execute({ action: 'record-review', feature_id: 'F001' }, execFor(repo.dir))
    assert.equal(applied.ok, true, JSON.stringify(applied))

    const row = readFeatures(repo.dir).features.features[0].evidence.at(-1)
    assert.deepEqual(
      row.files,
      ['README.md'],
      'the durable set is the declaration plus TRACKED additions; the untracked file is excluded',
    )
    assert.equal(
      row.files_fingerprint,
      fingerprint(repo.dir, ['README.md'], ''),
      'the recheckable fingerprint is over the durable set, not the untracked evidence',
    )
    // The untracked addition is still recorded — separately — so a later reader can see what was
    // evidence without having it become a stale trap.
    assert.deepEqual(row.git_cross_check.untracked, ['lib/approval.js'])
    assert.equal(row.git_cross_check.complete, true)
  } finally {
    rmSync(repo.dir, { recursive: true, force: true })
    rmSync(repo.run.scratch, { recursive: true, force: true })
  }
})

test('deleting an untracked scratch file after the review leaves it FRESH', async t => {
  // END TO END, because this is the shape that used to trap a project: review with a scratch
  // file in the tree, record the verdict, delete the scratch file, and every later status call
  // reported STALE even though nothing that was reviewed had changed.
  const repo = makeRepo(t)
  if (repo === null) return
  const scratch = join(repo.dir, 'scratch-notes.txt')
  try {
    writeFileSync(scratch, 'temporary working notes\n', 'utf8')
    const options = { config: resolveConfig({}), ctx: null, services: null, gitRun: repo.run }
    const def = buildAdvanceToolDefinition(options)
    const reviewDef = buildReviewToolDefinition(options)
    const { reviewExec } = reviewRig(repo.dir, { gitRun: repo.run })

    assert.equal(
      (
        await def.execute(
          {
            action: 'advance',
            to: 'PLAN',
            features: [{ id: 'F001', description: 'the change', steps: ['a'], priority: 1 }],
          },
          execFor(repo.dir),
        )
      ).ok,
      true,
    )
    assert.equal((await def.execute({ action: 'pick' }, execFor(repo.dir))).ok, true)

    const review = await reviewDef.execute(
      {
        feature: 'a reviewed change with scratch notes present',
        class: 'security',
        changed_files: ['README.md', 'lib/approval.js'],
      },
      reviewExec,
    )
    assert.equal(review.status, 'reviewed', JSON.stringify(review))
    assert.deepEqual(review.changedFilesCrossCheck.missing, ['scratch-notes.txt'])
    assert.deepEqual(review.changedFilesCrossCheck.untracked, ['scratch-notes.txt'])
    assert.ok(review.verification.files.includes('scratch-notes.txt'), 'the classifier saw the scratch file')

    const applied = await def.execute({ action: 'record-review', feature_id: 'F001' }, execFor(repo.dir))
    assert.equal(applied.ok, true, JSON.stringify(applied))
    const row = readFeatures(repo.dir).features.features[0].evidence.at(-1)
    assert.deepEqual(row.files, ['README.md', 'lib/approval.js'])
    assert.equal(row.files.includes('scratch-notes.txt'), false)
    assert.deepEqual(row.git_cross_check.untracked, ['scratch-notes.txt'])

    // THE SCRATCH FILE IS GONE. A durable fingerprint over the union would have hashed its
    // content at review time; this must still be FRESH.
    rmSync(scratch, { force: true })
    const freshness = reviewFreshnessAll(repo.dir, undefined, readFeatures(repo.dir).features)
    assert.equal(freshness.state, 'fresh', JSON.stringify(freshness))

    // ... and the surface a user actually reads says so too.
    const status = await buildToolDefinition({
      config: resolveConfig({}),
      ctx: null,
      services: null,
      gitRun: repo.run,
    }).execute({}, execFor(repo.dir))
    assert.equal(status.reviewFreshness.state, 'fresh', JSON.stringify(status.reviewFreshness))
  } finally {
    rmSync(repo.dir, { recursive: true, force: true })
    rmSync(repo.run.scratch, { recursive: true, force: true })
  }
})

test('a git comparison capped at 400 paths is INCOMPLETE and the review refuses it', async () => {
  // The cap is a security boundary, not a display limit: `lib/approval.js` sorts after 400
  // synthetic paths, so it is never evidence. A review that classified the compared subset and
  // reported `mismatch:false` would be a fail-open for exactly the file the cross-check exists
  // to catch. It must refuse BEFORE starting a reviewer and BEFORE resolving a class.
  const dir = makeProject()
  try {
    const status = []
    for (let index = 0; index < 400; index += 1) {
      status.push(` M a/${String(index).padStart(3, '0')}.js\0`)
    }
    // 401st sorted path: a tracked modification on the security surface.
    status.push(' M lib/approval.js\0')
    const run = (_command, args) => {
      if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return 'true'
      if (args[0] === 'rev-parse') return dir
      if (args[0] === 'status') return status.join('')
      throw new Error(`unexpected git call: ${args.join(' ')}`)
    }

    const { reviewDef, reviewExec, prompts } = reviewRig(dir, { gitRun: run })
    const review = await reviewDef.execute(
      { feature: 'a docs-only change, the caller claims', class: 'docs', changed_files: ['a/000.js'] },
      reviewExec,
    )

    assert.equal(review.ok, false)
    assert.equal(review.passed, false)
    assert.equal(review.status, 'changed-files-incomplete')
    assert.equal(prompts.length, 0, 'no reviewer may be started from a truncated comparison')
    assert.equal(review.verification, undefined, 'no class/depth may be resolved from the truncated subset')
    assert.equal(review.changedFilesCrossCheck.checked, true)
    assert.equal(review.changedFilesCrossCheck.complete, false)
    assert.equal(review.changedFilesCrossCheck.truncated, true)
    assert.equal(review.changedFilesCrossCheck.pathCap, 400)
    assert.equal(review.changedFilesCrossCheck.totalPaths, 401)
    assert.equal(review.changedFilesCrossCheck.actualCount, 400)
    assert.equal(review.changedFilesCrossCheck.missing.includes('lib/approval.js'), false)
    assert.match(review.changedFilesCrossCheck.reason, /INCOMPLETE/)
    assert.match(review.reason, /INCOMPLETE/)
    // The rendered refusal must not tell a reader a check passed.
    assert.match(renderReview(review), /did not run/)

    // AND THE PROMPT BUILDER IS DEFENSIVE TOO. The tool refuses before a reviewer exists, so
    // this is the second line of defence for an embedder that calls runReview itself: an
    // incomplete comparison must never be printed as "no path that the list above omits".
    const prompt = buildReviewPrompt({
      feature: 'x',
      changedFiles: ['a/000.js'],
      gitChanges: {
        checked: true,
        complete: false,
        reason: 'the working tree reports 401 changed path(s), more than the 400-path cap',
        missing: [],
        untracked: [],
        excluded: [],
      },
    })
    assert.match(prompt, /THE COMPARISON WAS INCOMPLETE/)
    assert.match(prompt, /NEVER checked/)
    assert.doesNotMatch(prompt, /git reports no changed path that the list above omits/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('git paths keep leading and trailing spaces: two real files stay two evidence rows', () => {
  // A leading space is a legal filename on POSIX and on Windows. `trim()` collapsed
  // `" a.txt"` into `"a.txt"`, so a declaration naming the spaced file silently matched its
  // sibling and the real file was never evidence.
  assert.equal(normaliseGitPath(' a.txt'), ' a.txt')
  assert.equal(normaliseGitPath('a.txt '), 'a.txt ')
  assert.equal(normaliseGitPath('./ a.txt'), ' a.txt')
  assert.equal(normaliseGitPath('dir\\ a.txt'), 'dir/ a.txt')
  assert.equal(normaliseGitPath(' '), ' ', 'a single-space filename is a path, not an empty one')
  assert.equal(normaliseGitPath(''), null)

  // `??` + separator + the filename, so a leading space yields THREE spaces after `??`.
  const parsed = parsePorcelainZ('??  a.txt\0?? a.txt\0 M  indented.js\0')
  assert.deepEqual(parsed.paths, [' a.txt', 'a.txt', ' indented.js'])
  assert.deepEqual(parsed.untracked, [' a.txt', 'a.txt'])

  const git = { available: true, repository: true, paths: parsed.paths, untracked: parsed.untracked }
  const spaced = reconcileChangedFiles([' a.txt'], git)
  assert.deepEqual(spaced.missing, ['a.txt', ' indented.js'], 'the sibling and the spaced file are NOT the same path')
  assert.deepEqual(spaced.untracked, ['a.txt'], 'only the `??` sibling is untracked')
  // The declaration plus the TRACKED addition; the untracked sibling is evidence only.
  assert.deepEqual(spaced.durable, [' a.txt', ' indented.js'])

  const plain = reconcileChangedFiles(['a.txt'], git)
  assert.deepEqual(plain.missing, [' a.txt', ' indented.js'], 'declaring the sibling does not clear the spaced file')
})

test('record-review persists a BOUNDED git cross-check in the FEATURES evidence row', async t => {
  // The verification audit is an in-process object; a later reader must still be able to see
  // whether the reviewed list was the actual working tree. The durable row therefore carries a
  // summary — checked/complete/omitted/untracked/reason — and both lists are capped so
  // FEATURES.json cannot grow with the number of paths.
  const repo = makeRepo(t)
  if (repo === null) return
  try {
    mkdirSync(join(repo.dir, 'lib', 'extra'), { recursive: true })
    for (let index = 1; index <= 24; index += 1) {
      writeFileSync(join(repo.dir, 'lib', 'extra', `f${String(index).padStart(2, '0')}.js`), `export const n = ${index}\n`, 'utf8')
    }
    const options = { config: resolveConfig({}), ctx: null, services: null, gitRun: repo.run }
    const def = buildAdvanceToolDefinition(options)
    const reviewDef = buildReviewToolDefinition(options)
    const { reviewExec } = reviewRig(repo.dir, { gitRun: repo.run })

    assert.equal(
      (
        await def.execute(
          {
            action: 'advance',
            to: 'PLAN',
            features: [{ id: 'F001', description: 'the change', steps: ['a'], priority: 1 }],
          },
          execFor(repo.dir),
        )
      ).ok,
      true,
    )
    assert.equal((await def.execute({ action: 'pick' }, execFor(repo.dir))).ok, true)

    const review = await reviewDef.execute(
      { feature: 'a change that omits many files', class: 'security', changed_files: ['README.md'] },
      reviewExec,
    )
    assert.equal(review.status, 'reviewed', JSON.stringify(review))
    assert.equal(review.changedFilesCrossCheck.missingTotal, 25, 'README plus 25 omitted paths')
    assert.equal(review.changedFilesCrossCheck.missing.length, 20, 'the reported list is capped')
    assert.equal(review.changedFilesCrossCheck.untrackedTotal, 25)
    assert.equal(review.changedFilesCrossCheck.untracked.length, 20, 'the untracked list is capped too')

    const applied = await def.execute({ action: 'record-review', feature_id: 'F001' }, execFor(repo.dir))
    assert.equal(applied.ok, true, JSON.stringify(applied))

    const row = readFeatures(repo.dir).features.features[0].evidence.at(-1)
    assert.deepEqual(
      row.git_cross_check,
      {
        checked: true,
        complete: true,
        missing: review.changedFilesCrossCheck.missing,
        missingTotal: 25,
        untracked: review.changedFilesCrossCheck.untracked,
        untrackedTotal: 25,
        reason: review.changedFilesCrossCheck.reason,
      },
      'the durable row carries the bounded summary, not the in-memory audit',
    )
    assert.equal(row.git_cross_check.missing.length, 20)
    // Bounded also means no full reconciliation leaks into the row.
    for (const key of ['actual', 'declared', 'unused', 'excluded', 'command', 'durable', 'pathCap', 'totalPaths']) {
      assert.equal(Object.prototype.hasOwnProperty.call(row.git_cross_check, key), false, `${key} is not persisted`)
    }
    // ... and every addition here is untracked, so the durable reviewed set is the declaration.
    assert.deepEqual(row.files, ['README.md'])
    assert.equal(row.files.includes('lib/approval.js'), false)
  } finally {
    rmSync(repo.dir, { recursive: true, force: true })
    rmSync(repo.run.scratch, { recursive: true, force: true })
  }
})

test('no git is a harmless, recorded note — never a crash and never a silent pass', async () => {
  const dir = makeProject()
  try {
    const run = () => {
      const error = new Error('spawnSync git ENOENT')
      error.code = 'ENOENT'
      throw error
    }
    const { reviewDef, reviewExec, prompts } = reviewRig(dir, { gitRun: run })
    const review = await reviewDef.execute(
      { feature: 'x', changed_files: ['lib/a.js'] },
      reviewExec,
    )
    assert.equal(review.status, 'reviewed', JSON.stringify(review))
    assert.equal(review.passed, true)
    assert.equal(review.changedFilesCrossCheck.checked, false)
    assert.match(review.changedFilesCrossCheck.reason, /git is not installed/)
    // The claim stands as the caller's claim, and the audit says it was not checked.
    assert.deepEqual(review.verification.files, ['lib/a.js'])
    assert.equal(review.verification.gitCrossCheck.checked, false)
    assert.match(prompts[0], /NOT CHECKED/)
    assert.match(renderReview(review), /changed-file cross-check: NOT CHECKED/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('no changed_files means no cross-check at all, and the payload is unchanged', async () => {
  const dir = makeProject()
  try {
    const { reviewDef, reviewExec, prompts } = reviewRig(dir)
    const review = await reviewDef.execute({ feature: 'x' }, reviewExec)
    assert.equal(review.status, 'reviewed', JSON.stringify(review))
    assert.equal(review.changedFilesCrossCheck, undefined, 'no claim, no cross-check, no extra payload')
    assert.equal(review.verification.gitCrossCheck, null)
    assert.doesNotMatch(prompts[0], /Git cross-check/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5. deletions are evidence, never a durable fingerprint
// ---------------------------------------------------------------------------

test('parsePorcelainZ reports deletions: D on either side, and a rename deletes the old name', () => {
  // The porcelains the check has to understand. `D ` is a staged deletion, ` D` an unstaged one,
  // `DD` both, and a rename REMOVES the old name. A COPY does not: its original still exists.
  const parsed = parsePorcelainZ(
    ' D lib/worktree-delete.js\0' +
      'D  lib/index-delete.js\0' +
      'DD lib/both-delete.js\0' +
      'R  lib/new-name.js\0lib/old-name.js\0' +
      'C  lib/copy.js\0lib/copy-original.js\0' +
      ' M lib/modified.js\0' +
      '?? lib/untracked.js\0',
  )
  assert.deepEqual(parsed.deleted, [
    'lib/worktree-delete.js',
    'lib/index-delete.js',
    'lib/both-delete.js',
    'lib/old-name.js',
  ])
  assert.equal(parsed.deleted.includes('lib/new-name.js'), false, 'the rename target is an addition')
  assert.equal(parsed.deleted.includes('lib/copy-original.js'), false, 'a copy leaves its original in place')
  assert.deepEqual(parsed.untracked, ['lib/untracked.js'])
  // A deletion is still a path: it is classification/prompt evidence, and `paths` is unchanged.
  assert.ok(parsed.paths.includes('lib/old-name.js'))
  assert.ok(parsed.paths.includes('lib/worktree-delete.js'))
})

test('a deleted tracked path stays EVIDENCE but never joins the durable fingerprint', () => {
  const git = {
    available: true,
    repository: true,
    paths: ['lib/a.js', 'lib/gone.js'],
    untracked: [],
    deleted: ['lib/gone.js'],
  }
  const reconciled = reconcileChangedFiles(['lib/gone.js'], git)
  assert.deepEqual(reconciled.evidence, ['lib/gone.js', 'lib/a.js'], 'the deletion is part of the change')
  assert.deepEqual(reconciled.missing, ['lib/a.js'])
  assert.deepEqual(reconciled.deleted, ['lib/gone.js'])
  assert.deepEqual(
    reconciled.durable,
    ['lib/a.js'],
    'a path that no longer exists cannot be re-read, so it cannot enter the fingerprint',
  )

  // The DECLARED spelling is excluded too: a caller who names the deleted file does not opt it
  // into the fingerprint, because the writer would then record it as unreadable forever.
  const declaredDeleted = reconcileChangedFiles(['lib/gone.js', 'lib/a.js'], git)
  assert.deepEqual(declaredDeleted.durable, ['lib/a.js'])
  assert.deepEqual(declaredDeleted.evidence, ['lib/gone.js', 'lib/a.js'])
})

test('a tracked deletion is reviewable END TO END: recorded, evidenced, and FRESH afterwards', async t => {
  // THE DEFECT THIS LOCKS DOWN. A review that covers a `git rm` used to record the deleted path
  // in the durable file set; `unreadable_files` then held it, and every later `workflow_status`
  // reported UNKNOWN forever for a review that had legitimately covered the removal.
  const repo = makeRepo(t)
  if (repo === null) return
  try {
    // A second tracked file so BOTH deletion spellings are exercised: `git rm` stages `D `, and
    // removing the working-tree file leaves ` D`.
    writeFileSync(join(repo.dir, 'lib', 'removed.js'), 'export const removed = 1\n', 'utf8')
    repo.run('git', ['add', 'lib/removed.js'], { cwd: repo.dir })
    repo.run(
      'git',
      ['-c', 'user.email=p2@example.invalid', '-c', 'user.name=P2 Test', 'commit', '-m', 'add removed'],
      { cwd: repo.dir },
    )
    repo.run('git', ['rm', 'lib/keep.js'], { cwd: repo.dir })
    rmSync(join(repo.dir, 'lib', 'removed.js'))

    const options = { config: resolveConfig({}), ctx: null, services: null, gitRun: repo.run }
    const def = buildAdvanceToolDefinition(options)
    const reviewDef = buildReviewToolDefinition(options)
    const { reviewExec, prompts } = reviewRig(repo.dir, { gitRun: repo.run })

    assert.equal(
      (
        await def.execute(
          {
            action: 'advance',
            to: 'PLAN',
            features: [{ id: 'F001', description: 'delete tracked files', steps: ['a'], priority: 1 }],
          },
          execFor(repo.dir),
        )
      ).ok,
      true,
    )
    assert.equal((await def.execute({ action: 'pick' }, execFor(repo.dir))).ok, true)

    const review = await reviewDef.execute(
      {
        feature: 'a change that deletes tracked files',
        class: 'security',
        changed_files: ['README.md', 'lib/keep.js', 'lib/removed.js'],
      },
      reviewExec,
    )
    assert.equal(review.status, 'reviewed', JSON.stringify(review))
    assert.deepEqual(review.changedFilesCrossCheck.deleted, ['lib/keep.js', 'lib/removed.js'])
    assert.equal(review.changedFilesCrossCheck.deletedTotal, 2)
    // EVIDENCE: the classifier and the reviewer both see the removals.
    assert.ok(review.verification.files.includes('lib/keep.js'))
    assert.match(prompts[0], /Tracked paths git reports as DELETED/)
    assert.match(prompts[0], /lib\/keep\.js/)
    assert.ok(review.verification.gitCrossCheck.deleted.includes('lib/removed.js'))

    const applied = await def.execute({ action: 'record-review', feature_id: 'F001' }, execFor(repo.dir))
    assert.equal(applied.ok, true, JSON.stringify(applied))

    const row = readFeatures(repo.dir).features.features[0].evidence.at(-1)
    assert.deepEqual(row.files, ['README.md'], 'the durable set holds no deleted path')
    assert.equal(row.files.includes('lib/keep.js'), false)
    assert.equal(row.files.includes('lib/removed.js'), false)
    assert.deepEqual(row.unreadable_files, [], 'a deletion at review time is not an unreadable file')
    // The deletion is still durable EVIDENCE, in its own bounded list.
    assert.deepEqual(row.git_cross_check.deleted, ['lib/keep.js', 'lib/removed.js'])
    assert.equal(row.git_cross_check.deletedTotal, 2)

    // THE RECHECK IS THE POINT: fresh, not UNKNOWN for a well-formed review.
    const freshness = reviewFreshnessAll(repo.dir, undefined, readFeatures(repo.dir).features)
    assert.equal(freshness.state, 'fresh', JSON.stringify(freshness))

    const status = await buildToolDefinition({
      config: resolveConfig({}),
      ctx: null,
      services: null,
      gitRun: repo.run,
    }).execute({}, execFor(repo.dir))
    assert.equal(status.reviewFreshness.state, 'fresh', JSON.stringify(status.reviewFreshness))
    const text = renderStatus(status)
    assert.match(text, /review freshness: fresh/)
    assert.doesNotMatch(text, /legacy or malformed/)
    assert.doesNotMatch(text, /review freshness: UNKNOWN/)
  } finally {
    rmSync(repo.dir, { recursive: true, force: true })
    rmSync(repo.run.scratch, { recursive: true, force: true })
  }
})

test('legacy deletion evidence is UNKNOWN for its own cause, never called malformed', async () => {
  // A record written before this fix holds a deleted path in `unreadable_files`. Calling that
  // well-formed record "legacy or malformed" misdescribes it; the report now names the cause.
  const dir = makeProject()
  try {
    writeFileSync(join(dir, 'a.js'), 'a', 'utf8')
    writeFeatures(
      dir,
      featuresDoc([
        feature('F001', {
          evidence: [
            {
              type: 'review',
              at: '2026-01-01T00:00:00.000Z',
              passed: true,
              files: ['lib/gone.js', 'a.js'],
              files_fingerprint: fingerprint(dir, ['lib/gone.js', 'a.js'], ''),
              fingerprint: 'full',
              diff_hash: 'hash',
              unreadable_files: ['lib/gone.js'],
            },
          ],
        }),
      ]),
    )
    const status = await buildToolDefinition({ config: resolveConfig({}), ctx: null, services: null }).execute(
      {},
      execFor(dir),
    )
    assert.equal(status.reviewFreshness.state, 'unknown')
    const text = renderStatus(status)
    assert.match(text, /review freshness: UNKNOWN/)
    assert.match(text, /unreadable or already deleted/)
    assert.doesNotMatch(text, /legacy or malformed/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5b. deletion-only evidence is recheckable: fresh while absent, stale when restored
// ---------------------------------------------------------------------------

test('a DELETION-ONLY review is FRESH from its persisted deletion evidence, not UNKNOWN', async t => {
  // THE DEFECT THIS LOCKS DOWN. The durable reviewed set excludes tracked deletions (a deleted
  // path cannot be hashed), so a review whose only reviewed paths were deletions recorded
  // `files: []`. Freshness treated that as "no file list" — UNKNOWN, rendered as "legacy or
  // malformed" — even though the row carried a well-formed, recheckable `git_cross_check.deleted`.
  const repo = makeRepo(t)
  if (repo === null) return
  try {
    // Both tracked files are removed; the untracked lib/approval.js is evidence only.
    repo.run('git', ['rm', '-f', 'README.md', 'lib/keep.js'], { cwd: repo.dir })
    const options = { config: resolveConfig({}), ctx: null, services: null, gitRun: repo.run }
    const def = buildAdvanceToolDefinition(options)
    const reviewDef = buildReviewToolDefinition(options)
    const { reviewExec } = reviewRig(repo.dir, { gitRun: repo.run })
    await planAndPick(def, execFor(repo.dir), { description: 'delete the tracked files' })

    const review = await reviewDef.execute(
      {
        feature: 'a change that only deletes tracked files',
        class: 'security',
        changed_files: ['README.md', 'lib/keep.js'],
      },
      reviewExec,
    )
    assert.equal(review.status, 'reviewed', JSON.stringify(review))
    assert.deepEqual(review.changedFilesCrossCheck.deleted, ['README.md', 'lib/keep.js'])

    const applied = await def.execute({ action: 'record-review', feature_id: 'F001' }, execFor(repo.dir))
    assert.equal(applied.ok, true, JSON.stringify(applied))

    const row = readFeatures(repo.dir).features.features[0].evidence.at(-1)
    assert.deepEqual(row.files, [], 'the durable set is empty: both reviewed paths are deletions')
    assert.deepEqual(row.git_cross_check.deleted, ['README.md', 'lib/keep.js'])
    assert.equal(row.git_cross_check.deletedTotal, 2)

    const freshness = reviewFreshnessAll(repo.dir, undefined, readFeatures(repo.dir).features)
    assert.equal(freshness.state, 'fresh', JSON.stringify(freshness))
    assert.equal(freshness.features[0].cause, 'deletions-only')
    assert.match(freshness.features[0].reason, /still absent/)

    // THE SURFACE A USER READS must say fresh too, and must not call a well-formed deletion row
    // "legacy or malformed" or UNKNOWN.
    const status = await buildToolDefinition(options).execute({}, execFor(repo.dir))
    assert.equal(status.reviewFreshness.state, 'fresh', JSON.stringify(status.reviewFreshness))
    const text = renderStatus(status)
    assert.match(text, /review freshness: fresh/)
    assert.match(text, /2 tracked deletion\(s\)/)
    assert.doesNotMatch(text, /legacy or malformed/)
    assert.doesNotMatch(text, /review freshness: UNKNOWN/)
  } finally {
    rmSync(repo.dir, { recursive: true, force: true })
    rmSync(repo.run.scratch, { recursive: true, force: true })
  }
})

test('a deletion-only review turns STALE when a recorded deletion is restored', async t => {
  // THE OTHER HALF OF THE SAME EVIDENCE. A fresh deletion-only verdict must not survive the file
  // coming back: there is no digest to move, so existence of the recorded path is the only check.
  const repo = makeRepo(t)
  if (repo === null) return
  try {
    repo.run('git', ['rm', '-f', 'README.md', 'lib/keep.js'], { cwd: repo.dir })
    const options = { config: resolveConfig({}), ctx: null, services: null, gitRun: repo.run }
    const def = buildAdvanceToolDefinition(options)
    const reviewDef = buildReviewToolDefinition(options)
    const { reviewExec } = reviewRig(repo.dir, { gitRun: repo.run })
    await planAndPick(def, execFor(repo.dir), { description: 'delete the tracked files' })

    assert.equal(
      (
        await reviewDef.execute(
          {
            feature: 'a change that only deletes tracked files',
            class: 'security',
            changed_files: ['README.md', 'lib/keep.js'],
          },
          reviewExec,
        )
      ).status,
      'reviewed',
    )
    const applied = await def.execute({ action: 'record-review', feature_id: 'F001' }, execFor(repo.dir))
    assert.equal(applied.ok, true, JSON.stringify(applied))
    assert.equal(
      reviewFreshnessAll(repo.dir, undefined, readFeatures(repo.dir).features).state,
      'fresh',
      'the setup must start fresh',
    )

    // Restore one of the reviewed deletions. No readable reviewed file changed.
    writeFileSync(join(repo.dir, 'lib', 'keep.js'), 'export const keep = 1\n', 'utf8')

    const freshness = reviewFreshnessAll(repo.dir, undefined, readFeatures(repo.dir).features)
    assert.equal(freshness.state, 'stale', JSON.stringify(freshness))
    assert.equal(freshness.features[0].cause, 'deletion-restored')
    assert.match(freshness.features[0].reason, /lib\/keep\.js/)
    assert.match(freshness.features[0].reason, /RESTORED/)

    const status = await buildToolDefinition(options).execute({}, execFor(repo.dir))
    assert.equal(status.reviewFreshness.state, 'stale', JSON.stringify(status.reviewFreshness))
    assert.match(renderStatus(status), /review freshness: STALE/)
  } finally {
    rmSync(repo.dir, { recursive: true, force: true })
    rmSync(repo.run.scratch, { recursive: true, force: true })
  }
})

test('a modified file plus a deleted file is FRESH, then STALE when the deletion is restored', async t => {
  // THE SEQUENCING BYPASS. The file digest covers README.md only; restoring lib/keep.js leaves
  // that digest byte-identical, so a fingerprint-only recheck would stay FRESH forever. The
  // persisted deletion must be checked after the digest matches.
  const repo = makeRepo(t)
  if (repo === null) return
  try {
    repo.run('git', ['rm', 'lib/keep.js'], { cwd: repo.dir })
    const options = { config: resolveConfig({}), ctx: null, services: null, gitRun: repo.run }
    const def = buildAdvanceToolDefinition(options)
    const reviewDef = buildReviewToolDefinition(options)
    const { reviewExec } = reviewRig(repo.dir, { gitRun: repo.run })
    await planAndPick(def, execFor(repo.dir), { description: 'modify one file and delete another' })

    const review = await reviewDef.execute(
      {
        feature: 'modify README and delete lib/keep.js',
        class: 'security',
        changed_files: ['README.md', 'lib/keep.js'],
      },
      reviewExec,
    )
    assert.equal(review.status, 'reviewed', JSON.stringify(review))
    assert.deepEqual(review.changedFilesCrossCheck.deleted, ['lib/keep.js'])

    const applied = await def.execute({ action: 'record-review', feature_id: 'F001' }, execFor(repo.dir))
    assert.equal(applied.ok, true, JSON.stringify(applied))
    const row = readFeatures(repo.dir).features.features[0].evidence.at(-1)
    assert.deepEqual(row.files, ['README.md'], 'the deletion is not in the durable file set')
    assert.deepEqual(row.git_cross_check.deleted, ['lib/keep.js'])

    assert.equal(
      reviewFreshnessAll(repo.dir, undefined, readFeatures(repo.dir).features).state,
      'fresh',
      'the setup must start fresh',
    )

    // Restore the deletion: the durable file digest is UNCHANGED, so only the deletion evidence
    // can catch this.
    const digestBefore = fingerprint(repo.dir, ['README.md'], '')
    writeFileSync(join(repo.dir, 'lib', 'keep.js'), 'export const keep = 1\n', 'utf8')
    assert.equal(
      fingerprint(repo.dir, ['README.md'], ''),
      digestBefore,
      'the restoration must not move the file digest, or this test would not exercise the bypass',
    )

    const freshness = reviewFreshnessAll(repo.dir, undefined, readFeatures(repo.dir).features)
    assert.equal(freshness.state, 'stale', JSON.stringify(freshness))
    assert.equal(freshness.features[0].cause, 'deletion-restored')
    assert.match(freshness.features[0].reason, /lib\/keep\.js/)
    assert.match(freshness.features[0].reason, /reviewed files are unchanged/)
    assert.match(renderStatus(await buildToolDefinition(options).execute({}, execFor(repo.dir))), /review freshness: STALE/)
  } finally {
    rmSync(repo.dir, { recursive: true, force: true })
    rmSync(repo.run.scratch, { recursive: true, force: true })
  }
})

test('a truncated persisted deletion list is UNKNOWN (deleted-truncated), never fresh', async t => {
  // The durable row caps `deleted` at 20 and carries `deletedTotal` so the loss is visible. When
  // the cap bit, the restored path may be one of the paths that were NOT persisted: the full set
  // cannot be rechecked, so neither fresh nor stale may be claimed.
  const run = gitAvailable(t)
  if (run === null) return
  const dir = makeProject({ yml: 'tier: standard\n' })
  try {
    run('git', ['init'], { cwd: dir })
    mkdirSync(join(dir, 'lib', 'removed'), { recursive: true })
    const paths = []
    for (let index = 1; index <= 21; index += 1) {
      const relative = `lib/removed/f${String(index).padStart(2, '0')}.js`
      writeFileSync(join(dir, ...relative.split('/')), `export const n = ${index}\n`, 'utf8')
      paths.push(relative)
    }
    run('git', ['add', 'lib/removed'], { cwd: dir })
    run(
      'git',
      ['-c', 'user.email=p2@example.invalid', '-c', 'user.name=P2 Test', 'commit', '-m', 'base'],
      { cwd: dir },
    )
    run('git', ['rm', '-r', 'lib/removed'], { cwd: dir })

    const options = { config: resolveConfig({}), ctx: null, services: null, gitRun: run }
    const def = buildAdvanceToolDefinition(options)
    const reviewDef = buildReviewToolDefinition(options)
    const { reviewExec } = reviewRig(dir, { gitRun: run })
    await planAndPick(def, execFor(dir), { description: 'remove twenty-one tracked files' })

    const review = await reviewDef.execute(
      { feature: 'delete 21 tracked files', class: 'logic', changed_files: paths },
      reviewExec,
    )
    assert.equal(review.status, 'reviewed', JSON.stringify(review))
    assert.equal(review.changedFilesCrossCheck.deletedTotal, 21)
    assert.equal(
      review.changedFilesCrossCheck.deleted.length,
      20,
      'the reported list is bounded, while deletedTotal states the real count',
    )

    const applied = await def.execute({ action: 'record-review', feature_id: 'F001' }, execFor(dir))
    assert.equal(applied.ok, true, JSON.stringify(applied))
    const row = readFeatures(dir).features.features[0].evidence.at(-1)
    assert.deepEqual(row.files, [])
    assert.equal(row.git_cross_check.deleted.length, 20, 'the durable list is capped')
    assert.equal(row.git_cross_check.deletedTotal, 21)

    const freshness = reviewFreshnessAll(dir, undefined, readFeatures(dir).features)
    assert.equal(freshness.state, 'unknown', JSON.stringify(freshness))
    assert.equal(freshness.features[0].cause, 'deleted-truncated')
    assert.match(freshness.features[0].reason, /21 deleted path\(s\)/)
    assert.match(freshness.features[0].reason, /only 20 were persisted/)

    const status = await buildToolDefinition(options).execute({}, execFor(dir))
    assert.equal(status.reviewFreshness.state, 'unknown')
    const text = renderStatus(status)
    assert.match(text, /review freshness: UNKNOWN/)
    assert.match(text, /more deleted paths than the bounded evidence retains/)
    assert.doesNotMatch(text, /legacy or malformed/)
    assert.doesNotMatch(text, /review freshness: fresh/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(run.scratch, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 6. a git CALL that throws is a failed check, not a capped comparison
// ---------------------------------------------------------------------------

/** The error a stale `.git/index.lock` produces, as `execFileSync` would report it. */
function indexLockError() {
  const error = new Error(
    'Command failed: git status --porcelain -z --untracked-files=all -- .\n' +
      "fatal: Unable to create 'D:/repo/.git/index.lock': File exists.\n\n" +
      'Another git process seems to be running in this repository.',
  )
  error.code = 'EBUSY'
  return error
}

/** A runner whose `status` throws the index-lock error; the two rev-parse calls succeed. */
function indexLockRunner(dir) {
  return (_command, args) => {
    if (args[0] === 'rev-parse' && args[1] === '--is-inside-work-tree') return 'true'
    if (args[0] === 'rev-parse') return dir
    throw indexLockError()
  }
}

test('collectGitChanges marks a throwing git status as FAILED, not truncated', () => {
  const dir = makeProject()
  try {
    const git = collectGitChanges(dir, { run: indexLockRunner(dir) })
    assert.equal(git.available, true)
    assert.equal(git.repository, true)
    assert.equal(git.failed, true, 'the check failed; it did not compare a subset')
    assert.equal(git.checked, false)
    assert.equal(git.complete, false, 'nothing was compared, so nothing is complete')
    assert.equal(git.truncated, false, 'a failure is not a capped list')
    assert.deepEqual(git.paths, [])
    assert.match(git.reason, /git status failed/)
    assert.doesNotMatch(git.reason, /cap|INCOMPLETE/, 'the reason must not describe a cap')

    const reconciled = reconcileChangedFiles(['lib/a.js'], git)
    assert.equal(reconciled.checked, false, 'a failed call must never read as checked')
    assert.equal(reconciled.failed, true)
    assert.equal(reconciled.complete, false)
    assert.equal(reconciled.mismatch, false)
    assert.deepEqual(reconciled.durable, ['lib/a.js'], 'the declaration stands, unchecked')
    assert.doesNotMatch(reconciled.reason, /cap|INCOMPLETE/)

    // The prompt builder is defensive too: a failed check is printed as NOT CHECKED, and it must
    // not inherit the capped-scan warning.
    const prompt = buildReviewPrompt({
      feature: 'x',
      changedFiles: ['lib/a.js'],
      gitChanges: {
        checked: false,
        failed: true,
        complete: false,
        reason: 'git status failed (index.lock), so the declared file list could not be cross-checked',
        missing: [],
        untracked: [],
        excluded: [],
      },
    })
    assert.match(prompt, /NOT CHECKED/)
    assert.doesNotMatch(prompt, /THE COMPARISON WAS INCOMPLETE/)
    assert.doesNotMatch(prompt, /400-path cap/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('workflow_review refuses a FAILED git check without starting a reviewer or claiming a cap', async () => {
  // CONSERVATIVE ON PURPOSE. A declaration was supplied, so it is the claim the class would be
  // derived from; a check that could not run must not let an unverified claim buy a class. The
  // review therefore refuses with its own status — and no reviewer is spent.
  const dir = makeProject()
  try {
    const { reviewDef, reviewExec, prompts } = reviewRig(dir, { gitRun: indexLockRunner(dir) })
    const review = await reviewDef.execute(
      { feature: 'a change, supposedly', class: 'docs', changed_files: ['lib/a.js'] },
      reviewExec,
    )
    assert.equal(review.ok, false)
    assert.equal(review.passed, false)
    assert.equal(review.status, 'changed-file-check-failed')
    assert.equal(prompts.length, 0, 'no reviewer may be started for a check that never ran')
    assert.equal(review.verification, undefined, 'no class/depth may be resolved from an unchecked claim')
    assert.equal(review.changedFilesCrossCheck.checked, false)
    assert.equal(review.changedFilesCrossCheck.failed, true)
    assert.equal(review.changedFilesCrossCheck.truncated, false, 'the same error must not read as a cap')
    assert.match(review.reason, /did NOT run/)
    assert.match(review.reason, /index\.lock/, 'the remedy names the likely cause')
    assert.match(review.reason, /NOT checked/, 'the result says the list was not checked')
    assert.doesNotMatch(review.reason, /400-path cap|Narrow the working tree|INCOMPLETE/)

    const text = renderReview(review)
    assert.match(text, /did not run/)
    assert.match(text, /changed-file-check-failed/)
    assert.doesNotMatch(text, /400-path cap|Narrow the working tree/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 7. the open-set rule: a feature is complete ONLY at passes === true
// ---------------------------------------------------------------------------

test('a feature is OPEN unless passes is exactly true: absent and the STRING "false" are open', async () => {
  // THE RULE IS `passes === true`, NOT `passes !== false`. With `passes !== false` an ABSENT flag
  // (`undefined`) and the string `"false"` both read as COMPLETE, so an unfinished feature
  // disappears from the status report and from the HANDOFF gate. A hand-edited FEATURES.json —
  // and a JSON round trip that drops an undefined field — produce exactly those shapes, so both
  // are pinned here, alongside a normal `passes: false` so the closed direction is stated too.
  const dir = makeProject({
    features: featuresDoc([
      // No `passes` key at all.
      { id: 'F001', description: 'no flag at hand', steps: ['a'], priority: 1 },
      feature('F002', { passes: 'false' }),
      feature('F003', { passes: false }),
      feature('F004', { passes: true, description: 'the finished one' }),
    ]),
  })
  try {
    const status = await buildToolDefinition({ config: resolveConfig({}), ctx: null, services: null }).execute(
      {},
      execFor(dir),
    )
    assert.deepEqual(
      status.features.open.map(row => row.id),
      ['F001', 'F002', 'F003'],
      'only `passes: true` is complete',
    )
    assert.deepEqual(status.features.counts, { total: 4, done: 1, open: 3 })

    // The HANDOFF gate reads the SAME rule, so the open count there must agree.
    writeState(dir, { ...readState(dir).state, phase: 'COMMIT', feature_id: 'F001' })
    const refused = await advanceDef().execute({ action: 'advance', to: 'HANDOFF' }, execFor(dir))
    assert.equal(refused.ok, false)
    assert.equal(refused.status, 'open-features')
    assert.deepEqual(refused.openFeatures.map(row => row.id), ['F001', 'F002', 'F003'])
    assert.match(refused.reason, /HANDOFF is refused while 3 feature\(s\) are still open/)

    // A waiver names them by the same rule, so nothing hides behind the boolean spelling.
    const waived = await advanceDef().execute(
      {
        action: 'advance',
        to: 'HANDOFF',
        waive_open_features: true,
        waiver_reason: 'these three are deliberately deferred',
      },
      execFor(dir),
    )
    assert.equal(waived.ok, true, JSON.stringify(waived))
    assert.deepEqual(waived.waiver.openFeatures, ['F001', 'F002', 'F003'])
    assert.match(renderAdvance(waived), /HANDOFF WAIVED with 3 feature\(s\) still open/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

