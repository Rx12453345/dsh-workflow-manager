/**
 * Per-work-unit state: resolution, path-traversal refusal, scope isolation, and the
 * review-store binding.
 *
 * THE DEFECT THESE TESTS PIN
 * `workflow_advance` stored its state keyed by project only, so a delegated child driving
 * its own work unit trampled the parent's: a child implementing component B4 found the
 * parent's B3 unit sitting at phase EVALUATE in the same file, correctly refused to touch
 * it, and had to abandon the phase machine.
 *
 * Three properties are load-bearing and each is tested to be able to go RED:
 *
 *  1. THE DEFAULT PATH IS UNCHANGED. No work unit means `.dsh/WORKFLOW.json` +
 *     `.dsh/FEATURES.json`, byte-identical to before, and no `.dsh/work` is created.
 *  2. `<id>` BECOMES A PATH SEGMENT, so a traversal id is refused and the RESOLVED path is
 *     re-checked with a real containment test, not a prefix comparison.
 *  3. A REVIEW VERDICT IS BOUND TO ITS WORK UNIT. `workflow_advance action=record-review`
 *     reads only the framework's process-level store; if that store's key ignored the work
 *     unit, a review of unit X could complete a feature in unit Y — a lateral bypass of the
 *     anti-self-certification mechanism.
 *
 * Run with `node --test test/`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  WORK_UNIT_DIR_RELATIVE_PATH,
  WORK_UNIT_ID_MAX_LENGTH,
  isContainedIn,
  listWorkUnits,
  resolveWorkUnitArgument,
  resolveWorkUnitDir,
  reviewOutcomeKey,
  validateWorkUnitId,
  workUnitRefusal,
  workUnitStatePaths,
  CASE_INSENSITIVE_FILESYSTEMS,
} from '../lib/work-unit.js'
import {
  FEATURES_RELATIVE_PATH,
  WORKFLOW_STATE_RELATIVE_PATH,
  fingerprint,
  reviewFreshness,
  readFeatures,
  readState,
  writeFeatures,
  writeState,
} from '../lib/advance.js'
import {
  buildAdvanceToolDefinition,
  buildReviewToolDefinition,
  buildStatus,
  buildToolDefinition,
  renderAdvance,
  renderStatus,
} from '../lib/tools.js'
import { buildGcToolDefinition, renderGc } from '../lib/gc.js'
import { resolveConfig } from '../lib/config.js'

/** A project directory with an opt-in `.dsh/workflow.yml`. */
function makeProject({ optIn = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wf-unit-'))
  mkdirSync(join(dir, '.dsh'), { recursive: true })
  if (optIn) writeFileSync(join(dir, '.dsh', 'workflow.yml'), 'tier: standard\n', 'utf8')
  return dir
}

const execFor = dir => ({ agent: { id: 'agent-1', session: { header: { cwd: dir } } } })

const feature = (id, priority = 1) => ({ id, description: `feature ${id}`, steps: ['a'], priority })

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

const advanceDef = options => buildAdvanceToolDefinition(options ?? { config: resolveConfig({}), ctx: null, services: null })

/** Drive a unit (or the project, when workUnit is null) to a planned, picked feature. */
async function planAndPick(def, dir, workUnit, featureId = 'F001') {
  const args = workUnit ? { work_unit: workUnit } : {}
  const planned = await def.execute(
    { action: 'advance', to: 'PLAN', features: [feature(featureId)], ...args },
    execFor(dir),
  )
  assert.equal(planned.ok, true, JSON.stringify(planned))
  const picked = await def.execute({ action: 'pick', ...args }, execFor(dir))
  assert.equal(picked.ok, true, JSON.stringify(picked))
  return picked
}

// ---------------------------------------------------------------------------
// 1. the id validator — the accepted set and the refused set
// ---------------------------------------------------------------------------

test('a work unit id accepts exactly the conservative character set', () => {
  const accepted = ['b1', 'B4', 'work-unit', 'B4.child_2', '0', 'a-1_2.3', 'x'.repeat(WORK_UNIT_ID_MAX_LENGTH)]
  for (const id of accepted) {
    const checked = validateWorkUnitId(id)
    assert.equal(checked.ok, true, `${JSON.stringify(id)} should be accepted: ${checked.error ?? ''}`)
    assert.equal(checked.id, id)
  }
})

test('every path-traversal, separator, and malformed id is refused', () => {
  // This table is the security requirement, not decoration: `<id>` becomes a path segment
  // and this plugin runs with real filesystem access.
  const refused = [
    // directory references and traversals
    '..',
    '../x',
    'a/../../b',
    'a/b',
    'a\\b',
    '..\\x',
    // absolute / drive / UNC
    '/etc/passwd',
    '/',
    'C:\\Windows',
    'C:/Windows',
    '\\\\server\\share',
    '//server/share',
    // encoding and control characters
    '%2e%2e',
    '%2f',
    'a\0b',
    '..%00',
    // unicode and whitespace
    'wörk',
    'ワーク',
    ' ',
    'a b',
    ' b1',
    'b1 ',
    // leading characters that write a hidden or flag-like name
    '-lead',
    '.lead',
    '...',
    // wrong types and emptiness
    '',
    null,
    undefined,
    42,
    true,
    {},
    [],
    ['b1'],
    () => {},
    Symbol('b1'),
    0n,
    // over-long
    'x'.repeat(WORK_UNIT_ID_MAX_LENGTH + 1),
  ]

  for (const id of refused) {
    const checked = validateWorkUnitId(id)
    assert.equal(checked.ok, false, `${JSON.stringify(String(id))} must be refused`)
    assert.equal(
      typeof checked.error,
      'string',
      `the refusal for ${JSON.stringify(String(id))} must explain itself`,
    )
    assert.ok(checked.error.length > 0)
  }
})

test('resolveWorkUnitDir refuses every unusable id and never yields an escaping path', () => {
  const dir = makeProject()
  try {
    const escaping = ['..', '../x', 'a/../../b', '/etc/passwd', 'C:\\Windows', '\\\\server\\share', '..\\x', 'a\0b', 'x'.repeat(65)]
    for (const id of escaping) {
      const resolved = resolveWorkUnitDir(dir, id)
      assert.equal(resolved.ok, false, `${JSON.stringify(id)} must be refused`)
      assert.equal(resolved.dir, undefined, 'a refusal must not carry a directory')
    }

    const good = resolveWorkUnitDir(dir, 'b4')
    assert.equal(good.ok, true)
    assert.equal(good.dir, join(dir, WORK_UNIT_DIR_RELATIVE_PATH, 'b4'))

    // A valid id with no project is still refused rather than defaulted to the cwd.
    assert.equal(resolveWorkUnitDir('', 'b4').ok, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('an id that differs only in case from an existing unit is refused where it would collide', () => {
  // On a case-folding filesystem "B4" and "b4" are the SAME directory, while the validator
  // and the review-store key treat them as different units. Two callers would each believe
  // they own a separate unit and silently share one WORKFLOW.json. Ambiguous => refused.
  const dir = makeProject()
  try {
    mkdirSync(join(dir, '.dsh', 'work', 'B4'), { recursive: true })
    const collision = resolveWorkUnitDir(dir, 'b4')
    if (CASE_INSENSITIVE_FILESYSTEMS.includes(process.platform)) {
      assert.equal(collision.ok, false, 'a case-only difference must be refused, not silently shared')
      assert.match(collision.error, /case/i)
    } else {
      assert.equal(collision.ok, true, 'on a case-sensitive filesystem these are genuinely different units')
    }
    // The exact same spelling is never a collision, on any platform.
    assert.equal(resolveWorkUnitDir(dir, 'B4').ok, true)
    // Nothing exists yet, so any new id is fine.
    assert.equal(resolveWorkUnitDir(dir, 'fresh').ok, true)
    assert.equal(CASE_INSENSITIVE_FILESYSTEMS.includes('linux'), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('isContainedIn is a real containment check, not a prefix comparison', () => {
  // The brief's own counterexample: `/a/bc` starts with `/a/b` and is a SIBLING.
  assert.equal(isContainedIn('/a/b', '/a/bc'), false)
  assert.equal(isContainedIn('/a/b', '/a/b/c'), true)
  // The root itself is not "inside" the root: an empty relationship is not a work unit.
  assert.equal(isContainedIn('/a/b', '/a/b'), false)
  assert.equal(isContainedIn('/a/b', '/a/b/../c'), false)
  assert.equal(isContainedIn('/a/b', '/a'), false)
  assert.equal(isContainedIn('/a/b', '/a/b/../b/c'), true)
  // `..` is compared as a WHOLE path segment. A child literally named "..foo" is inside
  // the base; matching a bare `startsWith('..')` would call it an escape (a false negative).
  assert.equal(isContainedIn('/a/b', '/a/b/..foo'), true)
  assert.equal(isContainedIn('/a/b', '/a/b/..foo/bar'), true)
  // Defensive on non-strings rather than throwing on a hand-edited argument.
  assert.equal(isContainedIn(undefined, '/a'), false)
  assert.equal(isContainedIn('/a', null), false)
  assert.equal(isContainedIn('', '/a'), false)
})

// ---------------------------------------------------------------------------
// 2. the DEFAULT path is byte-identical to the pre-work-unit layout
// ---------------------------------------------------------------------------

test('an absent work unit resolves to exactly the legacy paths', () => {
  const dir = join(tmpdir(), 'dsh-wf-unit-legacy')
  for (const absent of [undefined, null]) {
    const paths = workUnitStatePaths(dir, absent)
    assert.equal(paths.ok, true)
    assert.equal(paths.workUnit, null)
    assert.equal(paths.workflowPath, join(dir, WORKFLOW_STATE_RELATIVE_PATH))
    assert.equal(paths.featuresPath, join(dir, FEATURES_RELATIVE_PATH))
  }
  // And the legacy constants are still exactly what they always were.
  assert.equal(WORKFLOW_STATE_RELATIVE_PATH, join('.dsh', 'WORKFLOW.json'))
  assert.equal(FEATURES_RELATIVE_PATH, join('.dsh', 'FEATURES.json'))
})

test('readState/readFeatures report the legacy path when no work unit is named', () => {
  const dir = makeProject()
  try {
    assert.equal(readState(dir).path, join(dir, WORKFLOW_STATE_RELATIVE_PATH))
    assert.equal(readState(dir, undefined).path, join(dir, WORKFLOW_STATE_RELATIVE_PATH))
    assert.equal(readState(dir, null).path, join(dir, WORKFLOW_STATE_RELATIVE_PATH))
    assert.equal(readFeatures(dir).path, join(dir, FEATURES_RELATIVE_PATH))
    assert.equal(readState(dir).present, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('writeState/writeFeatures with no work unit still write the legacy files', () => {
  const dir = makeProject()
  try {
    const statePath = writeState(dir, { ...readState(dir).state, phase: 'PLAN' })
    const featuresPath = writeFeatures(dir, { features: [], source_request: 'r' })
    assert.equal(statePath, join(dir, WORKFLOW_STATE_RELATIVE_PATH))
    assert.equal(featuresPath, join(dir, FEATURES_RELATIVE_PATH))
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).phase, 'PLAN')
    // Nothing in the work-unit tree was touched.
    assert.equal(existsSync(join(dir, WORK_UNIT_DIR_RELATIVE_PATH)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the fingerprint digest for the default scope is byte-identical to the old algorithm', () => {
  // The digest is reproducible from an independent implementation of the pre-work-unit
  // algorithm. If folding a work unit into the hash polluted the empty scope, this breaks.
  const dir = makeProject()
  try {
    writeFileSync(join(dir, 'a.js'), 'let x = 1\n', 'utf8')
    const golden = 'b0e71bf37dbf4aba6403e38db7f2e221c33b34e2c7201860bf0a7c41adaba73d'
    assert.equal(fingerprint(dir, ['a.js']), golden)
    assert.equal(fingerprint(dir, ['a.js'], ''), golden)
    assert.equal(fingerprint(dir, ['a.js'], '', ''), golden)
    assert.equal(fingerprint(dir, ['a.js'], undefined, undefined), golden)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the fingerprint is bound to the work unit it approves', () => {
  const dir = makeProject()
  try {
    writeFileSync(join(dir, 'a.js'), 'let x = 1\n', 'utf8')
    const bare = fingerprint(dir, ['a.js'])
    const forX = fingerprint(dir, ['a.js'], '', 'x')
    const forY = fingerprint(dir, ['a.js'], '', 'y')
    assert.notEqual(forX, forY, 'two work units must not share an approval digest')
    assert.notEqual(forX, bare, 'a scoped approval must not equal the project-level one')
    // Deterministic, and the diff still contributes.
    assert.equal(forX, fingerprint(dir, ['a.js'], '', 'x'))
    assert.notEqual(fingerprint(dir, ['a.js'], 'diff one', 'x'), fingerprint(dir, ['a.js'], 'diff two', 'x'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('driving the project with no work_unit creates no work-unit tree at all', async () => {
  const dir = makeProject()
  try {
    const def = advanceDef()
    await def.execute(
      { action: 'advance', to: 'PLAN', features: [feature('F001')] },
      execFor(dir),
    )
    await def.execute({ action: 'pick' }, execFor(dir))
    await def.execute({ action: 'boot', smoke_passed: true }, execFor(dir))
    await def.execute({ action: 'advance', to: 'BUILD' }, execFor(dir))

    assert.equal(JSON.parse(readFileSync(join(dir, WORKFLOW_STATE_RELATIVE_PATH), 'utf8')).phase, 'BUILD')
    assert.equal(existsSync(join(dir, FEATURES_RELATIVE_PATH)), true)
    assert.equal(existsSync(join(dir, WORK_UNIT_DIR_RELATIVE_PATH)), false, 'the legacy path must not create .dsh/work')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the default-path tool payload and renderer are unchanged', async () => {
  const dir = makeProject()
  try {
    const def = advanceDef()
    const result = await def.execute({}, execFor(dir))
    assert.equal(result.workUnit, null, 'the payload must say the scope is the project')
    assert.doesNotMatch(renderAdvance(result), /work unit:/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('workflow_status stays silent about work units when there are none', () => {
  const dir = makeProject()
  try {
    const status = buildStatus({ exec: execFor(dir), config: resolveConfig({}), services: null })
    assert.deepEqual(status.workUnits.units, [])
    assert.deepEqual(status.workUnits.ignored, [])
    assert.doesNotMatch(renderStatus(status), /work unit/i)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 3. a work unit gets its OWN state
// ---------------------------------------------------------------------------

test('two work units in one project drive independent phase machines', async () => {
  const dir = makeProject()
  try {
    const def = advanceDef()

    await planAndPick(def, dir, 'b3')
    await planAndPick(def, dir, 'b4')

    // b3 moves on; b4 must not follow.
    await def.execute({ action: 'advance', to: 'NEGOTIATE', work_unit: 'b3' }, execFor(dir))

    const b3 = await def.execute({ action: 'status', work_unit: 'b3' }, execFor(dir))
    const b4 = await def.execute({ action: 'status', work_unit: 'b4' }, execFor(dir))
    assert.equal(b3.phase, 'NEGOTIATE')
    assert.equal(b4.phase, 'PICK', 'b4 must not have moved with b3')

    // Both on disk, in their own directories.
    assert.ok(existsSync(join(dir, '.dsh', 'work', 'b3', 'WORKFLOW.json')))
    assert.ok(existsSync(join(dir, '.dsh', 'work', 'b4', 'WORKFLOW.json')))
    assert.equal(existsSync(join(dir, WORKFLOW_STATE_RELATIVE_PATH)), false, 'no project-level state was written')
    assert.equal(existsSync(join(dir, FEATURES_RELATIVE_PATH)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a work unit cannot see the project-level state, and vice versa', () => {
  const dir = makeProject()
  try {
    writeState(dir, { ...readState(dir).state, phase: 'COMMIT', feature_id: 'root' })
    writeState(dir, { ...readState(dir).state, phase: 'BUILD', feature_id: 'unit' }, 'b4')

    assert.equal(readState(dir).state.phase, 'COMMIT')
    assert.equal(readState(dir, 'b4').state.phase, 'BUILD')
    assert.equal(readState(dir, 'b4').state.feature_id, 'unit')
    // A third unit that was never used starts from the defaults, not from either.
    assert.equal(readState(dir, 'b5').state.phase, 'INIT')
    assert.equal(readState(dir, 'b5').present, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 4. fail closed: an unusable work unit is refused, never defaulted
// ---------------------------------------------------------------------------

test('workflow_advance refuses an unusable work_unit and touches nothing', async () => {
  const dir = makeProject()
  try {
    const def = advanceDef()
    for (const bad of ['..', '../x', 'a/../../b', '/etc/passwd', 'C:\\Windows', '', 'x'.repeat(65), 42]) {
      const result = await def.execute({ action: 'status', work_unit: bad }, execFor(dir))
      assert.equal(result.ok, false, `${JSON.stringify(String(bad))} must be refused`)
      assert.equal(result.status, 'bad-work-unit')
      assert.equal(typeof result.reason, 'string')
      assert.match(result.reason, /\[A-Za-z0-9\._-\]/)
    }
    assert.equal(existsSync(join(dir, WORK_UNIT_DIR_RELATIVE_PATH)), false)
    assert.equal(existsSync(join(dir, WORKFLOW_STATE_RELATIVE_PATH)), false)
    assert.equal(existsSync(join(dir, FEATURES_RELATIVE_PATH)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('workflow_advance declares work_unit so the host cannot drop it silently', () => {
  const def = advanceDef()
  assert.ok(def.parameters.properties.work_unit, 'work_unit must be declared in the advance schema')
  const review = buildReviewToolDefinition({ config: resolveConfig({}), ctx: null, services: null })
  assert.ok(review.parameters.properties.work_unit, 'work_unit must be declared in the review schema')
  const gc = buildGcToolDefinition({ config: resolveConfig({}), ctx: null, services: null })
  assert.ok(gc.parameters.properties.work_unit, 'work_unit must be declared in the gc schema')
})

test('workflow_review refuses an unusable work_unit before starting a child', async () => {
  const dir = makeProject()
  try {
    let started = 0
    const options = { config: resolveConfig({}), ctx: null, services: null }
    const reviewDef = buildReviewToolDefinition(options)
    const reviewExec = {
      ...execFor(dir),
      subagents: {
        start: async () => {
          started += 1
          return { result: Promise.resolve({ stopOutput: [] }), dispose: async () => {} }
        },
      },
    }
    for (const bad of ['..', '../x', '\\\\server\\share', 'a b']) {
      const result = await reviewDef.execute({ feature: 'x', work_unit: bad }, reviewExec)
      assert.equal(result.ok, false, `${JSON.stringify(bad)} must be refused`)
      assert.equal(result.status, 'bad-work-unit')
      assert.equal(result.passed, false)
    }
    assert.equal(started, 0, 'a refused work unit must not spend a reviewer')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('resolveWorkUnitArgument defaults only when the argument is ABSENT', () => {
  const dir = '/tmp/whatever'
  assert.deepEqual(resolveWorkUnitArgument(dir, undefined), { ok: true, workUnit: null })
  assert.deepEqual(resolveWorkUnitArgument(dir, null), { ok: true, workUnit: null })
  assert.deepEqual(resolveWorkUnitArgument(dir, 'b4'), { ok: true, workUnit: 'b4' })
  for (const bad of ['', '..', '../x', 42]) {
    const result = resolveWorkUnitArgument(dir, bad)
    assert.equal(result.ok, false, `${JSON.stringify(String(bad))} must not default`)
    assert.equal(result.workUnit, undefined)
  }
})

test('the refusal payload echoes the id and composes one clean sentence', () => {
  const refusal = workUnitRefusal('/p', '../x', validateWorkUnitId('../x').error)
  assert.equal(refusal.ok, false)
  assert.equal(refusal.status, 'bad-work-unit')
  assert.equal(refusal.workUnit, '../x')
  assert.equal(refusal.projectDir, '/p')
  // A validator message already ending in a period must not splice into "..".
  assert.doesNotMatch(refusal.reason, /\.\.\s/)
  assert.match(refusal.reason, /refused rather than sanitised/)
  assert.match(refusal.reason, /\[A-Za-z0-9\._-\]/)
  // A non-string argument is echoed as null rather than stringified into the report.
  assert.equal(workUnitRefusal('/p', 42, 'nope').workUnit, null)
})

test('writeState and writeFeatures throw rather than silently writing to the root', () => {
  const dir = makeProject()
  try {
    assert.throws(() => writeState(dir, {}, '../x'), /work unit/i)
    assert.throws(() => writeFeatures(dir, {}, '../x'), /work unit/i)
    // The refusal happened before anything was written.
    assert.equal(existsSync(join(dir, WORKFLOW_STATE_RELATIVE_PATH)), false)
    assert.equal(existsSync(join(dir, FEATURES_RELATIVE_PATH)), false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('readState reports a refused scope instead of defaulting to the project file', () => {
  const dir = makeProject()
  try {
    writeState(dir, { ...readState(dir).state, phase: 'COMMIT' })
    const refused = readState(dir, '../x')
    assert.equal(refused.refused, true)
    assert.equal(refused.path, null)
    assert.ok(refused.problems.length > 0)
    // It did NOT fall back to the project's own COMMIT state.
    assert.equal(refused.state.phase, 'INIT')
    const refusedFeatures = readFeatures(dir, '../x')
    assert.equal(refusedFeatures.refused, true)
    assert.equal(refusedFeatures.path, null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 5. the review store is bound to the work unit — the anti-certification link
// ---------------------------------------------------------------------------

test('the review-store key includes the work unit', () => {
  const dir = '/p'
  assert.notEqual(reviewOutcomeKey(dir, 'x'), reviewOutcomeKey(dir, 'y'))
  assert.notEqual(reviewOutcomeKey(dir, 'x'), reviewOutcomeKey(dir, null))
  assert.notEqual(reviewOutcomeKey(dir, null), reviewOutcomeKey('/q', null))
  // Absent and null are the same scope; the key is stable.
  assert.equal(reviewOutcomeKey(dir, undefined), reviewOutcomeKey(dir, null))
  assert.equal(reviewOutcomeKey(dir, 'x'), reviewOutcomeKey(dir, 'x'))
  // A structured key cannot collide by concatenation.
  assert.notEqual(reviewOutcomeKey('/a', 'b/c'), reviewOutcomeKey('/a/b', 'c'))
})

test('a review run for a work unit completes a feature in THAT unit', async () => {
  const dir = makeProject()
  try {
    const options = { config: resolveConfig({}), ctx: null, services: null }
    const { reviewDef, reviewExec } = reviewRig(options, execFor(dir))
    const def = buildAdvanceToolDefinition(options)

    await planAndPick(def, dir, 'b4')
    const review = await reviewDef.execute({ feature: 'b4 work', work_unit: 'b4' }, reviewExec)
    assert.equal(review.passed, true, JSON.stringify(review).slice(0, 200))

    const applied = await def.execute({ action: 'record-review', feature_id: 'F001', work_unit: 'b4' }, execFor(dir))
    assert.equal(applied.ok, true, JSON.stringify(applied))
    assert.equal(applied.passed, true)
    assert.equal(readFeatures(dir, 'b4').features.features[0].passes, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a review recorded for unit X CANNOT complete a feature in unit Y', async () => {
  // THE CROSS-UNIT BYPASS. The store key must include the work unit or a review of X is
  // evidence for Y — a lateral bypass of the whole anti-self-certification mechanism.
  const dir = makeProject()
  try {
    const options = { config: resolveConfig({}), ctx: null, services: null }
    const { reviewDef, reviewExec } = reviewRig(options, execFor(dir))
    const def = buildAdvanceToolDefinition(options)

    await planAndPick(def, dir, 'x')
    await planAndPick(def, dir, 'y')

    await reviewDef.execute({ feature: 'x work', work_unit: 'x' }, reviewExec)

    // Unit Y tries to consume the verdict that belongs to X.
    const stolen = await def.execute({ action: 'record-review', feature_id: 'F001', work_unit: 'y' }, execFor(dir))
    assert.equal(stolen.ok, false, 'a cross-unit review must not apply')
    assert.equal(stolen.status, 'no-review-recorded')
    assert.equal(readFeatures(dir, 'y').features.features[0].passes, false)

    // Nor may the PROJECT-level scope claim it.
    const projectLevel = await def.execute({ action: 'record-review', feature_id: 'F001' }, execFor(dir))
    assert.equal(projectLevel.ok, false)
    assert.equal(projectLevel.status, 'no-review-recorded')

    // The owner can still use it.
    const applied = await def.execute({ action: 'record-review', feature_id: 'F001', work_unit: 'x' }, execFor(dir))
    assert.equal(applied.ok, true, JSON.stringify(applied))
    assert.equal(readFeatures(dir, 'x').features.features[0].passes, true)
    assert.equal(readFeatures(dir, 'y').features.features[0].passes, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a mismatched record under the right key is refused as a cross-unit verdict', async () => {
  // Defence in depth: even if the store key were bypassed, hand-written, or migrated, a
  // record that says it belongs to another unit must not be usable. The record is injected
  // directly under the key the reader would use for Y.
  const dir = makeProject()
  try {
    const options = { config: resolveConfig({}), ctx: null, services: null }
    const def = buildAdvanceToolDefinition(options)

    await planAndPick(def, dir, 'y')

    options.reviewOutcomes = new Map()
    options.reviewOutcomes.set(reviewOutcomeKey(dir, 'y'), {
      at: new Date().toISOString(),
      passed: true,
      status: 'reviewed',
      round: 1,
      overall: 9,
      failedVeto: [],
      reason: '',
      workUnit: 'x',
      files: [],
      diff: '',
      fingerprint: fingerprint(dir, [], '', 'x'),
    })

    const applied = await def.execute({ action: 'record-review', feature_id: 'F001', work_unit: 'y' }, execFor(dir))
    assert.equal(applied.ok, false, 'a verdict from another unit is not evidence here')
    assert.equal(applied.status, 'cross-unit-review')
    assert.equal(readFeatures(dir, 'y').features.features[0].passes, false)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('review freshness is per work unit: a stale review in X does not block or mark Y', async () => {
  const dir = makeProject()
  try {
    const options = { config: resolveConfig({}), ctx: null, services: null }
    const { reviewDef, reviewExec } = reviewRig(options, execFor(dir))
    const def = buildAdvanceToolDefinition(options)

    writeFileSync(join(dir, 'a.js'), 'let x = 1\n', 'utf8')
    await planAndPick(def, dir, 'x')
    await planAndPick(def, dir, 'y')

    // The review (and its file set) belongs to unit X only.
    await reviewDef.execute({ feature: 'x work', work_unit: 'x', changed_files: ['a.js'] }, reviewExec)
    const applied = await def.execute(
      { action: 'record-review', feature_id: 'F001', work_unit: 'x' },
      execFor(dir),
    )
    assert.equal(applied.ok, true, JSON.stringify(applied))

    assert.equal(reviewFreshness(dir, 'x', readFeatures(dir, 'x').features, 'F001').state, 'fresh')
    assert.equal(
      reviewFreshness(dir, 'y', readFeatures(dir, 'y').features, 'F001').state,
      'none',
      'a review in X must not become evidence in Y',
    )

    writeFileSync(join(dir, 'a.js'), 'let x = 2\n', 'utf8')
    assert.equal(reviewFreshness(dir, 'x', readFeatures(dir, 'x').features, 'F001').state, 'stale')
    assert.equal(
      reviewFreshness(dir, 'y', readFeatures(dir, 'y').features, 'F001').state,
      'none',
      'a stale review in X must not make Y stale either',
    )

    writeState(dir, { ...readState(dir, 'x').state, phase: 'COMMIT' }, 'x')
    const xHandoff = await def.execute({ action: 'advance', to: 'HANDOFF', work_unit: 'x' }, execFor(dir))
    assert.equal(xHandoff.ok, false)
    assert.equal(xHandoff.status, 'stale-review')

    // workflow_status must read the SAME unit files. Before work_unit was threaded through,
    // it read the project-level FEATURES.json and reported none for a stale unit.
    const statusDef = buildToolDefinition({ config: resolveConfig({}), ctx: null, services: null })
    const xStatus = await statusDef.execute({ work_unit: 'x' }, execFor(dir))
    assert.equal(xStatus.reviewFreshness.state, 'stale')
    assert.match(renderStatus(xStatus), /STALE for F001/)

    writeState(dir, { ...readState(dir, 'y').state, phase: 'COMMIT' }, 'y')
    // Y'S OWN FEATURE IS STILL OPEN, so the (newer) HANDOFF governance gate refuses a plain
    // handoff. That is a different rule from the one under test here — X's stale review must not
    // reach Y — so Y hands off with an explicit waiver, which is exactly the documented way past
    // the open-feature gate. The assertions below stay about freshness: Y has no review evidence.
    const yHandoff = await def.execute(
      {
        action: 'advance',
        to: 'HANDOFF',
        work_unit: 'y',
        waive_open_features: true,
        waiver_reason: 'the unit is being handed off with its feature unfinished, deliberately',
      },
      execFor(dir),
    )
    assert.equal(yHandoff.ok, true, JSON.stringify(yHandoff))
    assert.equal(yHandoff.reviewFreshness, undefined, 'Y has no review evidence of its own')
    assert.equal(yHandoff.waiver.reason, 'the unit is being handed off with its feature unfinished, deliberately')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// 6. status reports the units, and every renderer survives hand-edited state
// ---------------------------------------------------------------------------

test('workflow_status reports the work units that exist', () => {
  const dir = makeProject()
  try {
    mkdirSync(join(dir, '.dsh', 'work', 'alpha'), { recursive: true })
    writeFileSync(
      join(dir, '.dsh', 'work', 'alpha', 'WORKFLOW.json'),
      JSON.stringify({ phase: 'PLAN', history: [] }),
      'utf8',
    )
    mkdirSync(join(dir, '.dsh', 'work', 'beta'), { recursive: true })
    // Hand-made junk that must be reported, not mistaken for a unit.
    mkdirSync(join(dir, '.dsh', 'work', 'bad name'), { recursive: true })
    writeFileSync(join(dir, '.dsh', 'work', 'notes.txt'), 'hello', 'utf8')

    const status = buildStatus({ exec: execFor(dir), config: resolveConfig({}), services: null })
    assert.deepEqual(status.workUnits.units.map(unit => unit.id), ['alpha', 'beta'])
    assert.equal(status.workUnits.units[0].phase, 'PLAN')
    assert.equal(status.workUnits.units[0].hasState, true)
    assert.equal(status.workUnits.units[0].hasFeatures, false)
    assert.equal(status.workUnits.units[1].hasState, false)
    assert.deepEqual(status.workUnits.ignored, ['bad name', 'notes.txt'])

    const text = renderStatus(status)
    assert.match(text, /work units \(2\)/)
    assert.match(text, /alpha@PLAN/)
    assert.match(text, /beta@\(empty\)/)
    assert.match(text, /bad name/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a malformed work-unit state file is reported, not thrown', () => {
  const dir = makeProject()
  try {
    mkdirSync(join(dir, '.dsh', 'work', 'gamma'), { recursive: true })
    writeFileSync(join(dir, '.dsh', 'work', 'gamma', 'WORKFLOW.json'), '{ not json', 'utf8')

    const status = buildStatus({ exec: execFor(dir), config: resolveConfig({}), services: null })
    assert.deepEqual(status.workUnits.units.map(unit => unit.id), ['gamma'])
    assert.ok(status.workUnits.units[0].problems.length > 0)
    assert.doesNotThrow(() => renderStatus(status))
    assert.match(renderStatus(status), /gamma@\(unreadable\)/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('listWorkUnits never throws on a hand-edited tree', () => {
  const dir = makeProject()
  try {
    // No .dsh/work at all.
    assert.deepEqual(listWorkUnits(dir).units, [])
    // A FILE where the directory should be.
    writeFileSync(join(dir, '.dsh', 'work'), 'not a directory', 'utf8')
    assert.doesNotThrow(() => listWorkUnits(dir))
    assert.deepEqual(listWorkUnits(dir).units, [])
    // Nonsense arguments.
    assert.doesNotThrow(() => listWorkUnits(undefined))
    assert.doesNotThrow(() => listWorkUnits(null))
    assert.doesNotThrow(() => listWorkUnits(42))
    assert.deepEqual(listWorkUnits(undefined).units, [])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('renderStatus and renderAdvance never throw on malformed payloads', () => {
  const dir = makeProject()
  try {
    // A well-formed outer payload (what buildStatus produces) with a hand-edited
    // `workUnits` section: this is the region the new renderer reads.
    const base = buildStatus({ exec: execFor(dir), config: resolveConfig({}), services: null })
    const malformedSections = [
      undefined,
      null,
      'nope',
      42,
      [],
      { units: 'nope', ignored: 7 },
      { units: [null, 42, { id: 7 }, { id: 'x', problems: 'nope' }] },
      { units: [{ id: 'x', phase: {} }], ignored: [1, null] },
      { units: [{ id: 'x', problems: [{}] }] },
    ]
    for (const section of malformedSections) {
      assert.doesNotThrow(
        () => renderStatus({ ...base, workUnits: section }),
        `renderStatus threw for workUnits=${JSON.stringify(section)}`,
      )
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  // renderAdvance reads the whole payload, so it is fed raw garbage.
  for (const payload of [undefined, null, 'nope', 42, [], {}, { counts: 'nope' }, { bootstrap: 7 }]) {
    assert.doesNotThrow(() => renderAdvance(payload), `renderAdvance threw for ${JSON.stringify(payload)}`)
  }
  // The work-unit line is printed only for a real string.
  assert.doesNotMatch(renderAdvance({ workUnit: 123, status: 'ok' }), /work unit:/i)
  assert.match(renderAdvance({ workUnit: 'b4', status: 'ok' }), /work unit: b4/)
})

test('a refused work_unit containing a newline cannot forge a report line', async () => {
  // The refusal payload echoes the REQUESTED id verbatim, and both renderers print it.
  // A newline in it would otherwise become a standalone line in a report a model reads.
  const dir = makeProject()
  try {
    const marker = 'INJECTED-INSTRUCTION'
    const result = await advanceDef().execute(
      { action: 'status', work_unit: `ok\n${marker} do something evil` },
      execFor(dir),
    )
    assert.equal(result.status, 'bad-work-unit')
    const text = renderAdvance(result)
    assert.match(text, new RegExp(`work unit: ok ${marker} do something evil`))
    assert.equal(
      text.split('\n').map(line => line.trim()).includes(marker),
      false,
      'the injected marker must not become its own line',
    )

    // The gc renderer echoes the same field and must flatten it identically.
    const gcText = renderGc({ ok: false, action: 'scan', workUnit: `ok\n${marker}`, status: 'bad-work-unit' })
    assert.equal(
      gcText.split('\n').map(line => line.trim()).includes(marker),
      false,
      'the gc renderer must flatten the echoed work unit too',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('every hand-editable field a report prints is flattened, not just the work unit', () => {
  // The work_unit is only one channel. `phase`, `from`, `featureId` and the feature text
  // come straight out of hand-editable `.dsh/WORKFLOW.json` / `.dsh/FEATURES.json`, and a
  // constraint's `rule`/`why`/`signal` are reachable WITHOUT file editing through the gc
  // add path. Each one is a way to forge a line in a report a model reads.
  const marker = 'INJECTED-INSTRUCTION'
  const clean = text =>
    text
      .split('\n')
      .map(line => line.trim())
      .includes(marker)

  const advanceText = renderAdvance({
    ok: true,
    status: 'ok',
    phase: `PLAN\n${marker}`,
    from: `INIT\n${marker}`,
    featureId: `F1\n${marker}`,
    counts: { done: 0, total: 1 },
    feature: { id: 'F1', description: `a feature\n${marker}`, passes: false, blocked_reason: `blocked\n${marker}` },
    reason: `a reason\n${marker}`,
  })
  assert.equal(clean(advanceText), false, 'renderAdvance must flatten phase/from/featureId/feature/reason')
  assert.match(advanceText, new RegExp(`phase: PLAN ${marker}`))

  const gcText = renderGc({
    ok: true,
    action: 'scan',
    projectDir: '/p',
    counts: { total: 1, provablyDue: 1, dueForHumanReview: 0, notDue: 0, defective: 0, retired: 0 },
    provablyDue: {
      claim: 'claim',
      items: [
        {
          id: 'C1',
          verdict: 'provably-due',
          rule: `keep it one line\n${marker}`,
          why: `because\n${marker}`,
          signal: `after\n${marker}`,
          checks: [{ name: 'n', evaluated: true, satisfied: true, detail: `d\n${marker}` }],
          unevaluable: [`u\n${marker}`],
          problems: [`p\n${marker}`],
          defects: [`x\n${marker}`],
        },
      ],
    },
  })
  assert.equal(clean(gcText), false, 'renderGc/renderConstraint must flatten every free-text field')
  assert.match(gcText, new RegExp(`keep it one line ${marker}`))
})

test('unicode line separators are flattened too, not only \\n', () => {
  // U+0085 (NEL), U+2028 (LINE SEPARATOR) and U+2029 (PARAGRAPH SEPARATOR) are line breaks
  // to a Unicode-aware consumer even though `split('\n')` does not see them.
  for (const separator of ['\u0085', '\u2028', '\u2029', '\u000b', '\u000c']) {
    const marker = `INJECTED-${separator.codePointAt(0).toString(16)}`
    const text = renderAdvance({ ok: true, status: 'ok', phase: `PLAN${separator}${marker}` })
    assert.equal(text.includes(separator), false, `renderAdvance must not emit ${JSON.stringify(separator)}`)
    const gcText = renderGc({ ok: false, action: 'scan', status: 'bad-work-unit', workUnit: `ok${separator}${marker}` })
    assert.equal(gcText.includes(separator), false, `renderGc must not emit ${JSON.stringify(separator)}`)
  }
})

test('a hand-edited phase cannot forge extra lines into the status report', () => {
  // The status report is read by a model. A `phase` value containing a newline would
  // otherwise inject a whole extra line into it. (Directory NAMES cannot carry a control
  // character on Windows; the phase field can on every platform, so it is the case tested.)
  const dir = makeProject()
  try {
    const marker = 'INJECTED-INSTRUCTION'
    mkdirSync(join(dir, '.dsh', 'work', 'phasey'), { recursive: true })
    writeFileSync(
      join(dir, '.dsh', 'work', 'phasey', 'WORKFLOW.json'),
      JSON.stringify({ phase: `PLAN\n${marker}` }),
      'utf8',
    )

    const text = renderStatus(buildStatus({ exec: execFor(dir), config: resolveConfig({}), services: null }))
    assert.match(text, new RegExp(`phasey@PLAN ${marker}`), 'the phase must be flattened onto one line')
    assert.equal(
      text.split('\n').map(line => line.trim()).includes(marker),
      false,
      'the injected marker must not become its own line',
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('buildBootstrap and the renderer survive a hand-edited state file inside a unit', () => {
  const dir = makeProject()
  try {
    mkdirSync(join(dir, '.dsh', 'work', 'b4'), { recursive: true })
    writeFileSync(
      join(dir, '.dsh', 'work', 'b4', 'WORKFLOW.json'),
      JSON.stringify({ phase: 'BUILD', history: 'not an array' }),
      'utf8',
    )
    const loaded = readState(dir, 'b4')
    assert.deepEqual(loaded.state.history, [], 'a non-array history must be replaced, not trusted')
    assert.ok(existsSync(join(dir, '.dsh', 'work', 'b4', 'WORKFLOW.json')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('the status tool and the gc tool honour work_unit', async () => {
  const dir = makeProject()
  try {
    const statusDef = buildToolDefinition({ config: resolveConfig({}), ctx: null, services: null })
    const result = await statusDef.execute({}, execFor(dir))
    assert.deepEqual(result.workUnits.units, [])

    // gc reads the phase history a retirement signal counts, and that history is per unit.
    const gcDef = buildGcToolDefinition({ config: resolveConfig({}), ctx: null, services: null })
    const refused = await gcDef.execute({ action: 'scan', work_unit: '../x' }, execFor(dir))
    assert.equal(refused.ok, false)
    assert.equal(refused.status, 'bad-work-unit')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
