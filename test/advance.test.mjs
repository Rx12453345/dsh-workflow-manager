/**
 * The workflow phase machine (`lib/advance.js`) and the `workflow_advance` tool.
 *
 * THE PROPERTY THAT MATTERS MOST HERE IS NOT THE PHASE GRAPH.
 * A phase graph is easy and a prompt could describe it. What these tests defend is that
 * the framework, not the agent, decides when a feature is complete:
 *
 *  - `passes: true` cannot be hand-written or claimed — it is written by the framework
 *    from a review THIS SESSION actually ran;
 *  - the reviewed artefact is fingerprinted, so an edit after approval invalidates it;
 *  - a feature definition is frozen after planning, because a changed definition is not
 *    the thing that was reviewed;
 *  - BUILD is refused until the session has checked the foundation.
 *
 * Every one of those is a rule a prompt could only ASK for, which is the whole reason this
 * plugin exists.
 *
 * Run with `node --test test/`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  PHASES,
  TRANSITIONS,
  canTransition,
  transition,
  pickNextFeature,
  featureCounts,
  checkFeatureMutation,
  checkFeatureDiff,
  applyReviewOutcome,
  buildBootstrap,
  fingerprint,
  emptyFeatures,
  readState,
  writeState,
  readFeatures,
  writeFeatures,
  WORKFLOW_STATE_RELATIVE_PATH,
  FEATURES_RELATIVE_PATH,
} from '../lib/advance.js'
import { buildAdvanceToolDefinition, buildReviewToolDefinition, buildToolDefinition } from '../lib/tools.js'
import { resolveConfig } from '../lib/config.js'

/** A project directory with an optional `.dsh/workflow.yml` (its presence = opt-in). */
function makeProject({ optIn = true, features, review } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wf-adv-'))
  mkdirSync(join(dir, '.dsh'), { recursive: true })
  if (optIn) writeFileSync(join(dir, '.dsh', 'workflow.yml'), 'tier: standard\n', 'utf8')
  if (features) writeFileSync(join(dir, FEATURES_RELATIVE_PATH), JSON.stringify(features, null, 2), 'utf8')
  if (review) writeFileSync(join(dir, 'reviewed.txt'), review, 'utf8')
  return dir
}

const execFor = dir => ({ agent: { id: 'agent-1', session: { header: { cwd: dir } } } })

const feature = (id, priority, overrides = {}) => ({
  id,
  category: 'functional',
  description: `feature ${id}`,
  steps: ['do it'],
  passes: false,
  priority,
  acceptance_id: null,
  evidence: [],
  attempts: 0,
  blocked_reason: null,
  ...overrides,
})

// ---------------------------------------------------------------------------
// the phase graph
// ---------------------------------------------------------------------------

test('every phase is reachable through the declared transitions', () => {
  // A phase with no inbound edge would be dead code in a state machine.
  const reachable = new Set(['INIT'])
  for (let pass = 0; pass < PHASES.length; pass += 1) {
    for (const [from, tos] of Object.entries(TRANSITIONS)) {
      if (!reachable.has(from)) continue
      for (const to of tos) reachable.add(to)
    }
  }
  const orphans = PHASES.filter(phase => !reachable.has(phase))
  assert.deepEqual(orphans, [], `unreachable phase(s): ${orphans.join(', ')}`)
})

test('every declared successor is a real phase', () => {
  for (const [from, tos] of Object.entries(TRANSITIONS)) {
    assert.ok(PHASES.includes(from), `unknown source phase ${from}`)
    for (const to of tos) assert.ok(PHASES.includes(to), `${from} -> ${to} names an unknown phase`)
  }
})

test('a transition not in the graph is refused, with the legal moves reported', () => {
  const state = { ...readState('/nonexistent').state, phase: 'PLAN' }
  const result = transition(state, 'COMMIT')
  assert.equal(result.ok, false)
  assert.match(result.error, /cannot go from PLAN to COMMIT/)
  assert.deepEqual(result.allowed, ['PICK'])
})

test('an unknown phase name is refused rather than silently stored', () => {
  const state = readState('/nonexistent').state
  const result = transition(state, 'TELEPORT')
  assert.equal(result.ok, false)
  assert.match(result.error, /unknown phase/)
})

test('a transition to the current phase is refused, not recorded as progress', () => {
  const state = { ...readState('/nonexistent').state, phase: 'BUILD' }
  assert.equal(transition(state, 'BUILD').ok, false)
})

test('the review routes exist: EVALUATE can fail back to BUILD and pass to COMMIT', () => {
  assert.ok(canTransition('EVALUATE', 'BUILD'), 'a failed review must be able to return to BUILD')
  assert.ok(canTransition('EVALUATE', 'COMMIT'), 'a passed review must be able to reach COMMIT')
  assert.ok(canTransition('VERIFY', 'BUILD'), 'a failed sensor must be able to return to BUILD')
})

test('the plan can be amended mid-flight, because PICK leads back to PLAN', () => {
  // `PICK` is an intermediate state, so without this edge the feature list could only ever
  // be written once — and work that reveals a missing feature is normal, not exceptional.
  assert.ok(canTransition('PICK', 'PLAN'), 're-planning must be reachable')
  assert.ok(canTransition('PICK', 'BUILD'))
  // Re-planning is safe: any move except to COMMIT clears the recorded approval.
  const state = { ...readState('/nope').state, phase: 'PICK', review: { passed: true } }
  assert.equal(transition(state, 'PLAN').state.review, null)
})

test('moving away from a review clears the approval it granted', () => {
  // An approval authorizes exactly the COMMIT that follows it. Going back to BUILD means
  // the work changes again, so the old verdict must not linger and authorize the new state.
  const state = {
    ...readState('/nonexistent').state,
    phase: 'EVALUATE',
    review: { passed: true },
    reviewed_fingerprint: 'abc',
  }
  const moved = transition(state, 'BUILD')
  assert.equal(moved.ok, true)
  assert.equal(moved.state.review, null)
  assert.equal(moved.state.reviewed_fingerprint, null)
})

test('COMMIT keeps the approval it is acting on', () => {
  const state = {
    ...readState('/nonexistent').state,
    phase: 'EVALUATE',
    review: { passed: true },
    reviewed_fingerprint: 'abc',
  }
  const moved = transition(state, 'COMMIT')
  assert.equal(moved.ok, true)
  assert.deepEqual(moved.state.review, { passed: true })
})

// ---------------------------------------------------------------------------
// picking work
// ---------------------------------------------------------------------------

test('pickNextFeature returns the highest-priority unfinished feature', () => {
  const features = {
    features: [
      feature('F002', 2),
      feature('F001', 1),
      feature('F003', 3),
      feature('F000', 0, { passes: true }),
    ],
  }
  assert.equal(pickNextFeature(features).id, 'F001', 'priority 1 wins')
})

test('pickNextFeature skips completed work and reports an empty queue as undefined', () => {
  assert.equal(pickNextFeature({ features: [feature('A', 1, { passes: true })] }), undefined)
  assert.equal(pickNextFeature({ features: [] }), undefined)
  assert.equal(pickNextFeature(undefined), undefined)
})

test('a feature without a priority sorts last rather than first', () => {
  const features = { features: [{ ...feature('NOPRI', 1), priority: undefined }, feature('P', 5)] }
  assert.equal(pickNextFeature(features).id, 'P')
})

test('featureCounts reports progress', () => {
  const counts = featureCounts({ features: [feature('A', 1, { passes: true }), feature('B', 2)] })
  assert.deepEqual(counts, { total: 2, done: 1, open: 1 })
})

// ---------------------------------------------------------------------------
// the write-permission rule — the structural half of "verify before you claim done"
// ---------------------------------------------------------------------------

test('only the evaluator may write the passes flag', () => {
  assert.equal(checkFeatureMutation('passes', 'evaluator').ok, true)
  for (const role of ['generator', 'planner', 'verifier', 'initializer']) {
    const verdict = checkFeatureMutation('passes', role)
    assert.equal(verdict.ok, false, `${role} must not write passes`)
    assert.match(verdict.reason, /independent review|framework/i)
  }
})

test('only the verifier may append evidence', () => {
  assert.equal(checkFeatureMutation('evidence', 'verifier').ok, true)
  assert.equal(checkFeatureMutation('evidence', 'generator').ok, false)
})

test('only the planner may change a feature definition', () => {
  for (const field of ['description', 'steps', 'acceptance_id']) {
    assert.equal(checkFeatureMutation(field, 'planner').ok, true, `${field} by planner`)
    assert.equal(checkFeatureMutation(field, 'generator').ok, false, `${field} by generator`)
  }
})

test('an unlisted field is not part of the contract', () => {
  assert.equal(checkFeatureMutation('some_future_field', 'generator').ok, true)
})

test('the planner owns feature definitions; every other role may not change them', () => {
  // Role-based, matching the design ("only the planner writes description/steps"). It is
  // not an absolute freeze, because re-entering PLAN is a legitimate redefinition — and
  // that is safe because any transition other than to COMMIT clears the recorded review,
  // so a redefinition can never ride on an approval granted to the earlier definition.
  const before = { features: [feature('F001', 1)] }
  const after = { features: [feature('F001', 1, { description: 'something else' })] }

  for (const role of ['generator', 'verifier', 'evaluator', 'framework']) {
    const result = checkFeatureDiff(before, after, role)
    assert.equal(result.ok, false, `${role} must not rewrite a frozen description`)
    assert.match(JSON.stringify(result.violations), /changed its description/)
  }

  assert.equal(checkFeatureDiff(before, after, 'planner').ok, true, 'the planner owns definitions')
})

test('an unchanged definition passes the diff for any role', () => {
  const before = { features: [feature('F001', 1)] }
  const after = { features: [feature('F001', 1, { evidence: [{ type: 'review' }], attempts: 1 })] }
  assert.equal(
    checkFeatureDiff(before, after, 'evaluator').ok,
    true,
    'progress fields may change; only the definition is the planner\u2019s',
  )
})

test('a non-planner cannot add or delete features', () => {
  const before = { features: [feature('F001', 1)] }

  const added = checkFeatureDiff(before, { features: [feature('F001', 1), feature('F002', 2)] }, 'generator')
  assert.equal(added.ok, false)
  assert.match(JSON.stringify(added.violations), /added outside planning/)

  const deleted = checkFeatureDiff(before, { features: [] }, 'generator')
  assert.equal(deleted.ok, false)
  assert.match(JSON.stringify(deleted.violations), /never removed/)
})

test('a non-evaluator flipping passes is reported as a violation', () => {
  const before = { features: [feature('F001', 1)] }
  const after = { features: [feature('F001', 1, { passes: true })] }
  const result = checkFeatureDiff(before, after, 'generator')
  assert.equal(result.ok, false)
  assert.match(JSON.stringify(result.violations), /passes flag changed/)
})

// ---------------------------------------------------------------------------
// applying a review outcome
// ---------------------------------------------------------------------------

test('a failing review records an attempt and a reason instead of passing the feature', () => {
  const features = { features: [feature('F001', 1)] }
  const applied = applyReviewOutcome(features, {
    featureId: 'F001',
    passed: false,
    reason: 'correctness scored 2',
  })
  assert.equal(applied.ok, true)
  assert.equal(applied.feature.passes, false)
  assert.equal(applied.feature.attempts, 1, 'a failed attempt must be counted')
  assert.match(applied.feature.blocked_reason, /correctness scored 2/)
})

test('a passing review records evidence, the round, and the fingerprint it covered', () => {
  const features = { features: [feature('F001', 1)] }
  const applied = applyReviewOutcome(features, {
    featureId: 'F001',
    passed: true,
    evidence: [{ type: 'review', at: 'now', round: 2, overall: 9 }],
  })
  assert.equal(applied.ok, true)
  assert.equal(applied.feature.passes, true)
  assert.equal(applied.feature.blocked_reason, null)
  assert.equal(applied.feature.evidence.length, 1)
  assert.equal(applied.feature.evidence[0].overall, 9)
})

test('a PASS does NOT apply when the artefact changed after the review', () => {
  // The gate is bypassable by sequencing: review, then edit three more things, then
  // commit. The fingerprint makes the approval authorize one artefact, not one moment.
  const features = { features: [feature('F001', 1)] }
  const applied = applyReviewOutcome(features, {
    featureId: 'F001',
    passed: true,
    expectedFingerprint: 'the-reviewed-state',
    currentFingerprint: 'something-else-now',
  })
  assert.equal(applied.ok, false)
  assert.match(applied.error, /does not cover the current artefact/)
  assert.equal(features.features[0].passes, false, 'the feature must be left untouched')
})

test('applying an outcome to an unknown feature is refused', () => {
  const applied = applyReviewOutcome({ features: [] }, { featureId: 'NOPE', passed: true })
  assert.equal(applied.ok, false)
  assert.match(applied.error, /no feature "NOPE"/)
})

// ---------------------------------------------------------------------------
// the fingerprint
// ---------------------------------------------------------------------------

test('the fingerprint changes when a reviewed file changes', () => {
  const dir = makeProject()
  try {
    writeFileSync(join(dir, 'a.js'), 'let x = 1', 'utf8')
    const before = fingerprint(dir, ['a.js'])
    writeFileSync(join(dir, 'a.js'), 'let x = 2', 'utf8')
    assert.notEqual(fingerprint(dir, ['a.js']), before, 'an edit must invalidate the approval')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the fingerprint is stable for unchanged files and order-independent', () => {
  const dir = makeProject()
  try {
    writeFileSync(join(dir, 'a.js'), 'a', 'utf8')
    writeFileSync(join(dir, 'b.js'), 'b', 'utf8')
    assert.equal(fingerprint(dir, ['a.js', 'b.js']), fingerprint(dir, ['b.js', 'a.js']))
    assert.equal(fingerprint(dir, ['a.js', 'b.js']), fingerprint(dir, ['a.js', 'b.js']))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unreadable file still affects the fingerprint', () => {
  // Treating a missing file as empty would make an unreadable file look like a stable one.
  const dir = makeProject()
  try {
    const absent = fingerprint(dir, ['does-not-exist.js'])
    writeFileSync(join(dir, 'does-not-exist.js'), '', 'utf8')
    const empty = fingerprint(dir, ['does-not-exist.js'])
    assert.notEqual(absent, empty)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a diff folded into the fingerprint changes it', () => {
  const dir = makeProject()
  try {
    assert.notEqual(fingerprint(dir, [], 'diff one'), fingerprint(dir, [], 'diff two'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// the session bootstrap
// ---------------------------------------------------------------------------

test('the bootstrap refuses until the sensors have run', () => {
  const features = { features: [feature('F001', 1)] }
  const state = { ...readState('/nope').state, history: [{ at: 'now' }] }

  const withoutSmoke = buildBootstrap({ features, state, smokePassed: false, projectDir: '/nope' })
  assert.equal(withoutSmoke.satisfied, false)
  assert.ok(withoutSmoke.blockedBy.includes('smoke'))

  const withSmoke = buildBootstrap({ features, state, smokePassed: true, projectDir: '/nope' })
  assert.equal(withSmoke.satisfied, true)
})

test('the bootstrap does not block on an empty queue, because that is a HANDOFF', () => {
  const state = { ...readState('/nope').state, history: [{ at: 'now' }] }
  const bootstrap = buildBootstrap({
    features: { features: [feature('A', 1, { passes: true })] },
    state,
    smokePassed: true,
    projectDir: '/nope',
  })
  assert.equal(bootstrap.satisfied, true)
  assert.equal(bootstrap.counts.open, 0)
})

// ---------------------------------------------------------------------------
// the tool, end to end
// ---------------------------------------------------------------------------

const advanceDef = () => buildAdvanceToolDefinition({ config: resolveConfig({}), ctx: null, services: null })

test('workflow_advance refuses a project that has not opted in', async () => {
  const dir = makeProject({ optIn: false })
  try {
    const result = await advanceDef().execute({}, execFor(dir))
    assert.equal(result.ok, false)
    assert.equal(result.status, 'not-enabled')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('status reports the phase, its legal moves, and any review this session ran', async () => {
  const dir = makeProject()
  try {
    const result = await advanceDef().execute({}, execFor(dir))
    assert.equal(result.ok, true)
    assert.equal(result.phase, 'INIT')
    assert.deepEqual(result.allowed, TRANSITIONS.INIT)
    assert.equal(result.lastReview, null)
    assert.match(result.text, /phase INIT/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('BUILD is refused until the session bootstrap has run', async () => {
  const dir = makeProject()
  try {
    const def = advanceDef()
    // Bootstrap requires a populated feature list, so plan one first.
    await def.execute(
      { action: 'advance', to: 'PLAN', features: [{ id: 'F001', description: 'first', steps: ['a'], priority: 1 }] },
      execFor(dir),
    )
    await def.execute({ action: 'advance', to: 'PICK' }, execFor(dir))

    const blocked = await def.execute({ action: 'advance', to: 'BUILD' }, execFor(dir))
    assert.equal(blocked.ok, false)
    assert.equal(blocked.status, 'bootstrap-required')
    assert.match(blocked.reason, /smoke_passed|bootstrap/i)

    await def.execute({ action: 'boot', smoke_passed: true }, execFor(dir))
    const allowed = await def.execute({ action: 'advance', to: 'BUILD' }, execFor(dir))
    assert.equal(allowed.ok, true, JSON.stringify(allowed))
    assert.equal(allowed.phase, 'BUILD')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the bootstrap checklist reports what is still outstanding', async () => {
  const dir = makeProject()
  try {
    const def = advanceDef()
    const beforePlanning = await def.execute({ action: 'boot', smoke_passed: true }, execFor(dir))
    assert.equal(beforePlanning.ok, false, 'no features means nothing to build')
    assert.ok(beforePlanning.bootstrap.blockedBy.includes('features'))

    await def.execute(
      { action: 'advance', to: 'PLAN', features: [{ id: 'F001', description: 'first', steps: ['a'], priority: 1 }] },
      execFor(dir),
    )
    const withoutSmoke = await def.execute({ action: 'boot' }, execFor(dir))
    assert.equal(withoutSmoke.ok, false)
    assert.ok(withoutSmoke.bootstrap.blockedBy.includes('smoke'))

    const complete = await def.execute({ action: 'boot', smoke_passed: true }, execFor(dir))
    assert.equal(complete.ok, true, JSON.stringify(complete.bootstrap))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('planning writes the feature list, and a later edit is still a planner act', async () => {
  const dir = makeProject()
  try {
    const def = advanceDef()
    const planned = await def.execute(
      {
        action: 'advance',
        to: 'PLAN',
        source_request: 'build a thing',
        features: [
          { id: 'F001', description: 'first', steps: ['a'], priority: 1 },
          { id: 'F002', description: 'second', steps: ['b'], priority: 2 },
        ],
      },
      execFor(dir),
    )
    assert.equal(planned.ok, true, JSON.stringify(planned))

    const stored = readFeatures(dir).features
    assert.equal(stored.features.length, 2)
    assert.equal(stored.source_request, 'build a thing')
    assert.equal(stored.features[0].passes, false, 'planning must never mark work complete')

    // Back to PLAN later: the tool performs the diff AS the planner, so refining the list
    // is legal there — the rule exists and is enforced, not assumed.
    await def.execute({ action: 'advance', to: 'PICK' }, execFor(dir))
    const refined = await def.execute(
      {
        action: 'advance',
        to: 'PLAN',
        features: [
          { id: 'F001', description: 'first', steps: ['a'], priority: 1 },
          { id: 'F002', description: 'second', steps: ['b'], priority: 2 },
          { id: 'F003', description: 'added while planning', steps: ['c'], priority: 3 },
        ],
      },
      execFor(dir),
    )
    assert.equal(refined.ok, true, JSON.stringify(refined))
    assert.equal(readFeatures(dir).features.features.length, 3)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('record-review is refused when this session never ran a review', async () => {
  // THE MOST IMPORTANT TEST HERE. A model that writes `passes: true` itself, or claims a
  // review passed without running one, must find nothing to record.
  const dir = makeProject()
  try {
    const def = advanceDef()
    await def.execute(
      {
        action: 'advance',
        to: 'PLAN',
        features: [{ id: 'F001', description: 'first', steps: ['a'], priority: 1 }],
      },
      execFor(dir),
    )
    await def.execute({ action: 'advance', to: 'PICK' }, execFor(dir))
    await def.execute({ action: 'pick' }, execFor(dir))

    const claimed = await def.execute({ action: 'record-review', feature_id: 'F001' }, execFor(dir))
    assert.equal(claimed.ok, false)
    assert.equal(claimed.status, 'no-review-recorded')
    assert.match(claimed.reason, /workflow_review/)

    assert.equal(
      readFeatures(dir).features.features[0].passes,
      false,
      'the feature must remain incomplete',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('record-review applies a review that this session DID run, and only via that path', async () => {
  const dir = makeProject()
  try {
    // One shared options object is how the plugin wires the two tools together.
    const options = { config: resolveConfig({}), ctx: null, services: null }
    const reviewDef = buildReviewToolDefinition(options)
    const def = buildAdvanceToolDefinition(options)

    await def.execute(
      {
        action: 'advance',
        to: 'PLAN',
        features: [{ id: 'F001', description: 'first', steps: ['a'], priority: 1 }],
      },
      execFor(dir),
    )
    await def.execute({ action: 'advance', to: 'PICK' }, execFor(dir))
    await def.execute({ action: 'pick' }, execFor(dir))

    // A real review, with a stub reviewer that passes.
    let started = 0
    const reviewExec = {
      ...execFor(dir),
      subagents: {
        start: async () => {
          started += 1
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
                ].map(dimension => ({ dimension, score: 9, rationale: 'verified' })),
                issues: [],
                verified: ['ran the suite'],
              },
              output: [],
            }),
            dispose: async () => {},
          }
        },
      },
    }
    const review = await reviewDef.execute({ feature: 'first' }, reviewExec)
    assert.equal(review.passed, true, JSON.stringify(review).slice(0, 200))
    assert.equal(started, 1)

    const applied = await def.execute({ action: 'record-review', feature_id: 'F001' }, execFor(dir))
    assert.equal(applied.ok, true, JSON.stringify(applied))
    assert.equal(applied.passed, true)
    assert.equal(readFeatures(dir).features.features[0].passes, true)
    assert.equal(applied.counts.done, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a FAIL from the review leaves the feature open and counts the attempt', async () => {
  const dir = makeProject()
  try {
    const options = { config: resolveConfig({}), ctx: null, services: null }
    const reviewDef = buildReviewToolDefinition(options)
    const def = buildAdvanceToolDefinition(options)

    await def.execute(
      { action: 'advance', to: 'PLAN', features: [{ id: 'F001', description: 'first', steps: ['a'], priority: 1 }] },
      execFor(dir),
    )
    await def.execute({ action: 'advance', to: 'PICK' }, execFor(dir))
    await def.execute({ action: 'pick' }, execFor(dir))

    const reviewExec = {
      ...execFor(dir),
      subagents: {
        start: async () => ({
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
              ].map(dimension => ({ dimension, score: dimension === 'correctness' ? 2 : 9, rationale: '' })),
              issues: [{ where: 'a.js:1', what: 'wrong', fix: 'fix it', severity: 'blocker' }],
            },
            output: [],
          }),
          dispose: async () => {},
        }),
      },
    }
    const review = await reviewDef.execute({ feature: 'first' }, reviewExec)
    assert.equal(review.passed, false)

    const applied = await def.execute({ action: 'record-review', feature_id: 'F001' }, execFor(dir))
    assert.equal(applied.ok, true)
    assert.equal(applied.passed, false)

    const stored = readFeatures(dir).features.features[0]
    assert.equal(stored.passes, false, 'a failed review must not complete the feature')
    assert.equal(stored.attempts, 1)
    assert.ok(stored.blocked_reason)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a PASS is refused when the files changed after the review', async () => {
  // End-to-end version of the sequencing bypass: review, edit, then try to record.
  const dir = makeProject()
  try {
    const options = { config: resolveConfig({}), ctx: null, services: null }
    const reviewDef = buildReviewToolDefinition(options)
    const def = buildAdvanceToolDefinition(options)

    writeFileSync(join(dir, 'a.js'), 'let x = 1\n', 'utf8')
    await def.execute(
      { action: 'advance', to: 'PLAN', features: [{ id: 'F001', description: 'first', steps: ['a'], priority: 1 }] },
      execFor(dir),
    )
    await def.execute({ action: 'advance', to: 'PICK' }, execFor(dir))
    await def.execute({ action: 'pick' }, execFor(dir))

    const reviewExec = {
      ...execFor(dir),
      subagents: {
        start: async () => ({
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
        }),
      },
    }
    // The review is told which files it covers, so those are what get fingerprinted.
    await reviewDef.execute({ feature: 'first', changed_files: ['a.js'] }, reviewExec)

    // Now change the reviewed artefact.
    writeFileSync(join(dir, 'a.js'), 'let x = 2\n', 'utf8')

    const applied = await def.execute(
      { action: 'record-review', feature_id: 'F001', changed_files: ['a.js'] },
      execFor(dir),
    )
    assert.equal(applied.ok, false, 'a stale PASS must not complete the feature')
    assert.equal(applied.status, 'refused')
    assert.match(applied.reason, /does not cover the current artefact/)
    assert.equal(readFeatures(dir).features.features[0].passes, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an illegal tool-level transition is refused with the legal moves', async () => {
  const dir = makeProject()
  try {
    const result = await advanceDef().execute({ action: 'advance', to: 'COMMIT' }, execFor(dir))
    assert.equal(result.ok, false)
    assert.equal(result.status, 'illegal-transition')
    assert.ok(Array.isArray(result.allowed))
    assert.match(result.reason, /Legal next steps/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// defects found by an end-to-end run on a real host
// ---------------------------------------------------------------------------
//
// A delegated child drove a complete INIT→HANDOFF loop in a scratch project. The loop
// worked, and the run surfaced four things no offline test had caught. Each one is pinned
// here so it cannot come back.

test('action=pick PERFORMS the PICK phase rather than merely selecting', async () => {
  // The live run had to call `advance to=PICK` afterwards, and `pick`'s reply advertised
  // "allowed next: PICK" while standing in PLAN — a contradiction that cost a round trip.
  const dir = makeProject()
  try {
    const def = advanceDef()
    await def.execute(
      { action: 'advance', to: 'PLAN', features: [{ id: 'F001', description: 'x', steps: ['a'], priority: 1 }] },
      execFor(dir),
    )

    const picked = await def.execute({ action: 'pick' }, execFor(dir))
    assert.equal(picked.ok, true, JSON.stringify(picked))
    assert.equal(picked.phase, 'PICK', 'pick must enter the PICK phase')
    assert.equal(picked.from, 'PLAN')
    assert.equal(picked.featureId, 'F001')
    assert.deepEqual(picked.allowed, TRANSITIONS.PICK)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('pick reports an illegal-transition rather than lying when it cannot move', async () => {
  const dir = makeProject()
  try {
    const def = advanceDef()
    await def.execute(
      { action: 'advance', to: 'PLAN', features: [{ id: 'F001', description: 'x', steps: ['a'], priority: 1 }] },
      execFor(dir),
    )
    await def.execute({ action: 'pick' }, execFor(dir))
    // NEGOTIATE has exactly one successor (BUILD), so no feature can be picked from here.
    await def.execute({ action: 'advance', to: 'NEGOTIATE' }, execFor(dir))

    const picked = await def.execute({ action: 'pick' }, execFor(dir))
    assert.equal(picked.ok, false)
    assert.equal(picked.status, 'illegal-transition')
    assert.match(picked.reason, /cannot pick from NEGOTIATE/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

/** A review tool definition plus a stub reviewer that scores everything at `score`. */
function reviewRig(options, exec, score = 9) {
  const reviewDef = buildReviewToolDefinition(options)
  const reviewExec = {
    ...exec,
    subagents: {
      start: async () => ({
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
            ].map(dimension => ({ dimension, score, rationale: '' })),
            issues: [],
          },
          output: [],
        }),
        dispose: async () => {},
      }),
    },
  }
  return { reviewDef, reviewExec }
}

test('record-review does not require the reviewed diff to be supplied twice', async () => {
  // The live run failed here with "the workspace changed after the review passed" against
  // files that were byte-identical. The cause: `record-review` recomputed the fingerprint
  // from ITS OWN arguments, while the review had folded in a diff it did not persist — so
  // the caller had to repeat a byte-identical diff string with nothing documenting it.
  const dir = makeProject()
  try {
    const options = { config: resolveConfig({}), ctx: null, services: null }
    const advanceDef2 = buildAdvanceToolDefinition(options)
    const { reviewDef, reviewExec } = reviewRig(options, execFor(dir))

    writeFileSync(join(dir, 'a.js'), 'let x = 1\n', 'utf8')
    await advanceDef2.execute(
      { action: 'advance', to: 'PLAN', features: [{ id: 'F001', description: 'x', steps: ['a'], priority: 1 }] },
      execFor(dir),
    )
    await advanceDef2.execute({ action: 'pick' }, execFor(dir))

    // The review is given a diff, which IS folded into the reviewed fingerprint.
    await reviewDef.execute(
      { feature: 'x', changed_files: ['a.js'], diff: 'diff --git a/a.js b/a.js\n+let x = 1\n' },
      reviewExec,
    )

    // record-review is called WITHOUT repeating changed_files or diff.
    const applied = await advanceDef2.execute({ action: 'record-review', feature_id: 'F001' }, execFor(dir))
    assert.equal(applied.ok, true, `record-review must reuse the recorded inputs: ${applied.reason ?? ''}`)
    assert.equal(applied.passed, true)
    assert.equal(readFeatures(dir).features.features[0].passes, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a genuine edit after the review is still refused, and the message says so', async () => {
  // The other half: making the recorded inputs reusable must not weaken the guarantee.
  const dir = makeProject()
  try {
    const options = { config: resolveConfig({}), ctx: null, services: null }
    const advanceDef2 = buildAdvanceToolDefinition(options)
    const { reviewDef, reviewExec } = reviewRig(options, execFor(dir))

    writeFileSync(join(dir, 'a.js'), 'let x = 1\n', 'utf8')
    await advanceDef2.execute(
      { action: 'advance', to: 'PLAN', features: [{ id: 'F001', description: 'x', steps: ['a'], priority: 1 }] },
      execFor(dir),
    )
    await advanceDef2.execute({ action: 'pick' }, execFor(dir))

    await reviewDef.execute({ feature: 'x', changed_files: ['a.js'] }, reviewExec)

    writeFileSync(join(dir, 'a.js'), 'let x = 2\n', 'utf8')

    const applied = await advanceDef2.execute({ action: 'record-review', feature_id: 'F001' }, execFor(dir))
    assert.equal(applied.ok, false, 'a real edit after approval must invalidate it')
    assert.match(applied.reason, /does not cover the current artefact/)
    assert.equal(readFeatures(dir).features.features[0].passes, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('workflow_status honours workspace_dir instead of silently dropping it', async () => {
  // The live run passed `workspace_dir` to workflow_status and the argument was discarded
  // with no error — the tool reported on the session cwd instead.
  const statusDef = buildToolDefinition({ config: resolveConfig({}), ctx: null, services: null })

  const dir = makeProject()
  const otherDir = makeProject()
  try {
    const viaArgument = await statusDef.execute({ workspace_dir: dir }, execFor(otherDir))
    assert.equal(viaArgument.project.projectDir, dir, 'workspace_dir must win over the session cwd')
    assert.match(viaArgument.diagnostics.workspaceSource, /workspace_dir/)

    // The parameter must be DECLARED, so the host does not drop it silently.
    assert.ok(
      statusDef.parameters.properties.workspace_dir,
      'workflow_status must declare workspace_dir in its schema',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
    rmSync(otherDir, { recursive: true, force: true })
  }
})

test('state survives a round trip through the file', () => {
  const dir = makeProject()
  try {
    const initial = readState(dir)
    assert.equal(initial.present, false)
    assert.equal(initial.state.phase, 'INIT')

    writeState(dir, { ...initial.state, phase: 'BUILD', feature_id: 'F001', round: 2 })
    const reloaded = readState(dir)
    assert.equal(reloaded.present, true)
    assert.equal(reloaded.state.phase, 'BUILD')
    assert.equal(reloaded.state.feature_id, 'F001')
    assert.equal(reloaded.state.round, 2)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a corrupt state file is reported, not silently reset to INIT', () => {
  const dir = makeProject()
  try {
    mkdirSync(join(dir, '.dsh'), { recursive: true })
    writeFileSync(join(dir, WORKFLOW_STATE_RELATIVE_PATH), '{ this is not json', 'utf8')
    const loaded = readState(dir)
    assert.ok(loaded.problems.length > 0, 'a corrupt file must be reported')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an unknown phase in the state file is reported rather than coerced', () => {
  const dir = makeProject()
  try {
    mkdirSync(join(dir, '.dsh'), { recursive: true })
    writeFileSync(join(dir, WORKFLOW_STATE_RELATIVE_PATH), JSON.stringify({ phase: 'MADE_UP' }), 'utf8')
    const loaded = readState(dir)
    assert.ok(loaded.problems.some(p => /unknown phase/.test(p)), JSON.stringify(loaded.problems))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a features file with a non-array features field is reported', () => {
  const dir = makeProject()
  try {
    mkdirSync(join(dir, '.dsh'), { recursive: true })
    writeFileSync(join(dir, FEATURES_RELATIVE_PATH), JSON.stringify({ features: 'nope' }), 'utf8')
    const loaded = readFeatures(dir)
    assert.ok(loaded.problems.includes('features is not an array'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('emptyFeatures produces the documented contract shape', () => {
  const empty = emptyFeatures('a request')
  assert.equal(empty.schema_version, 1)
  assert.deepEqual(empty.features, [])
  assert.equal(empty.source_request, 'a request')
  assert.ok(empty.notes)
})

test('the features file is written atomically enough to be re-read', () => {
  const dir = makeProject()
  try {
    writeFeatures(dir, emptyFeatures('r'))
    const text = readFileSync(join(dir, FEATURES_RELATIVE_PATH), 'utf8')
    assert.equal(JSON.parse(text).source_request, 'r')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
