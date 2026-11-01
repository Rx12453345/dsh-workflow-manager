/**
 * The HANDOFF brief (`.dsh/HANDOFF.md`) and its `workflow_status` summary.
 *
 * WHAT THESE TESTS DEFEND
 * `modules.handoffDoc` is a user-visible switch (default `true`, rendered on the settings page,
 * listed by `workflow_status`). Before this feature it was read by NO code, so switching it
 * changed nothing — a settings knob that lied. The tests therefore pin BOTH halves of the
 * contract:
 *
 *  - the document itself must let the next session start cold: every feature named with its
 *    pass/fail and whether its review still covers the files, the last recorded verdict per
 *    feature, the blockers COMMIT/HANDOFF would enforce, the open constraints, and the moves the
 *    machine still allows;
 *  - the switch must DO something: off means no file and no status section, and the target is
 *    always `.dsh/HANDOFF.md` — never the repository's tracked root `HANDOFF.md` (the incident
 *    brief), which would be data loss.
 *
 * Regeneration is idempotent, the status section is bounded (the point of the file is that the
 * FULL brief is on disk), and a project with no review evidence still gets a brief instead of a
 * crash.
 *
 * Run with `node --test test/`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  HANDOFF_DOC_DISPLAY_PATH,
  HANDOFF_DOC_RELATIVE_PATH,
  assertHandoffDocTarget,
  buildHandoffDoc,
  handoffDocRelativePath,
  readHandoffDocStatus,
  writeHandoffDoc,
} from '../lib/handoff.js'
import {
  FEATURES_RELATIVE_PATH,
  fingerprint,
  readState,
  refreshHandoffDoc,
  writeFeatures,
  writeState,
} from '../lib/advance.js'
import { validateWorkUnitId } from '../lib/work-unit.js'
import { resolveConfig } from '../lib/config.js'
import {
  buildAdvanceToolDefinition,
  buildReviewToolDefinition,
  buildToolDefinition,
  renderAdvance,
  renderStatus,
} from '../lib/tools.js'

/** A project directory with the opt-in file (its presence is what activates the workflow). */
function makeProject({ config = 'tier: standard\n' } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wf-handoff-'))
  mkdirSync(join(dir, '.dsh'), { recursive: true })
  writeFileSync(join(dir, '.dsh', 'workflow.yml'), config, 'utf8')
  return dir
}

const execFor = dir => ({ agent: { id: 'agent-1', session: { header: { cwd: dir } } } })

function cleanup(dir) {
  rmSync(dir, { recursive: true, force: true })
}

/** A feature row in the shape the planner writes. */
function feature(id, overrides = {}) {
  return {
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
  }
}

/**
 * A review evidence row whose file fingerprint is computed from the files as they are NOW.
 * A test that wants a STALE verdict rewrites one of those files afterwards.
 */
function reviewRow(dir, files, overrides = {}) {
  const { passed = true, overall = 9, at = '2026-10-25T10:00:00.000Z', round = 1 } = overrides
  return {
    type: 'review',
    at,
    round,
    overall,
    passed,
    fingerprint: `full-${files.join('-')}`,
    files_fingerprint: fingerprint(dir, files, '', ''),
    diff_hash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    unreadable_files: [],
    files,
  }
}

/** The state document the tool reads, in the shape `writeState` persists. */
function stateDoc({ phase = 'COMMIT', featureId = null, waivers = [] } = {}) {
  return {
    schema_version: 1,
    phase,
    feature_id: featureId,
    round: 0,
    history: [],
    waivers,
    acceptance: null,
    review: null,
    reviewed_fingerprint: null,
    bootstrapped: true,
    bootstrap: null,
    started_at: null,
    updated_at: '2026-11-01T00:00:00.000Z',
  }
}

/** Write the two state documents the tool reads (state phase defaults to COMMIT). */
function seedProject(dir, featureList, { phase = 'COMMIT', featureId = featureList[0]?.id ?? null, waivers = [] } = {}) {
  writeFileSync(
    join(dir, FEATURES_RELATIVE_PATH),
    JSON.stringify({ schema_version: 1, generated_at: '2026-10-25T00:00:00.000Z', source_request: '', features: featureList }, null, 2),
    'utf8',
  )
  writeState(dir, stateDoc({ phase, featureId, waivers }))
}

const toolOptions = () => ({ config: resolveConfig({}), ctx: null, services: null })

/**
 * A review tool whose reviewer always completes with a passing report.
 *
 * `record-review` only consumes a verdict the framework itself recorded, so a test of the
 * post-HANDOFF refresh needs a review that really runs through the tool.
 */
function reviewRig(options, exec) {
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
            ].map(dimension => ({ dimension, score: 9, rationale: '' })),
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

/**
 * A project with one FRESH complete feature, one STALE complete feature, one OPEN feature with
 * no evidence, and one OPEN feature whose last review FAILED.
 */
function richProject() {
  const dir = makeProject()
  writeFileSync(join(dir, 'fresh.js'), 'let fresh = 1\n', 'utf8')
  writeFileSync(join(dir, 'stale.js'), 'let stale = 1\n', 'utf8')
  writeFileSync(join(dir, 'failed.js'), 'let failed = 1\n', 'utf8')
  const staleRow = reviewRow(dir, ['stale.js'], { overall: 8.5, at: '2026-10-25T07:00:00.000Z' })
  const freshRow = reviewRow(dir, ['fresh.js'], { overall: 9.25, at: '2026-10-26T08:30:00.000Z', round: 2 })
  const failedRow = reviewRow(dir, ['failed.js'], { passed: false, overall: 7.5, at: '2026-10-27T09:00:00.000Z' })
  // The edit lands AFTER the row's fingerprint was taken: this is what makes F001 STALE.
  writeFileSync(join(dir, 'stale.js'), 'let stale = 2\n', 'utf8')
  const features = {
    schema_version: 1,
    features: [
      feature('F001', { passes: true, evidence: [staleRow] }),
      feature('F002', { passes: true, evidence: [freshRow] }),
      feature('F003'),
      feature('F004', { evidence: [failedRow] }),
    ],
  }
  const constraints = {
    constraints: [
      {
        id: 'C001',
        rule: 'Declare only the files the claim covers.',
        why: 'A branch-union declaration stales every feature.',
        added_at: '2026-11-01',
        retire_when: { signal: 'the framework computes the scope', review_after_days: 90 },
        status: 'active',
      },
      {
        id: 'C000',
        rule: 'An older rule.',
        why: 'It stopped being needed.',
        added_at: '2026-10-01',
        retire_when: { review_after_days: 30 },
        status: 'retired',
      },
    ],
  }
  return { dir, features, constraints }
}

const buildRich = (rig, now = '2026-11-01T00:00:00.000Z') =>
  buildHandoffDoc({
    state: { phase: 'HANDOFF', feature_id: 'F001', round: 0, updated_at: '2026-11-01T00:00:00.000Z', waivers: [] },
    features: rig.features,
    constraints: rig.constraints,
    projectDir: rig.dir,
    now,
  })

// ---------------------------------------------------------------------------
// the document
// ---------------------------------------------------------------------------

test('the brief names every feature with its pass/fail and whether its review still covers the files', () => {
  const rig = richProject()
  try {
    const doc = buildRich(rig)
    for (const id of ['F001', 'F002', 'F003', 'F004']) {
      assert.match(doc, new RegExp(`\\b${id}\\b`), `every feature must be named: ${id} missing`)
    }
    assert.match(doc, /F001 — complete · review STALE/, 'a changed reviewed file must read STALE')
    assert.match(doc, /F002 — complete · review FRESH/, 'unchanged reviewed files must read FRESH')
    assert.match(doc, /F003 — OPEN · no review evidence/, 'an open feature must say it has no review')
    assert.match(doc, /F004 — OPEN · review FRESH/, 'a fresh FAIL is still fresh evidence')
    // The last recorded review per feature: verdict, overall score and date, from the evidence.
    assert.match(doc, /last review: PASS · overall 8\.5 · 2026-10-25T07:00:00\.000Z · round 1/)
    assert.match(doc, /last review: PASS · overall 9\.25 · 2026-10-26T08:30:00\.000Z · round 2/)
    assert.match(doc, /last review: FAIL · overall 7\.5 · 2026-10-27T09:00:00\.000Z/)
    assert.match(doc, /F003[\s\S]{0,120}last review: none recorded/)
  } finally {
    cleanup(rig.dir)
  }
})

test('the brief names every open feature and every stale one, and states the COMMIT/HANDOFF blockers', () => {
  const rig = richProject()
  try {
    const doc = buildRich(rig)
    const staleBlock = doc.match(/^- STALE \((\d+)\): (.+)$/m)
    assert.ok(staleBlock, 'the brief must have a STALE blocker line')
    assert.equal(staleBlock[1], '1')
    assert.match(staleBlock[2], /F001/)
    const openBlock = doc.match(/^- OPEN \((\d+)\): (.+)$/m)
    assert.ok(openBlock, 'the brief must have an OPEN blocker line')
    assert.equal(openBlock[1], '2')
    assert.match(openBlock[2], /F003/)
    assert.match(openBlock[2], /F004/)
    // The rule the transition enforces is restated, so a cold reader does not rediscover it.
    assert.match(doc, /COMMIT and HANDOFF refuse any feature whose reviewed files changed/)
    assert.match(doc, /HANDOFF additionally refuses while any feature is open/)
    // Constraints: id + rule + status, and the retired record is named but not repeated.
    assert.match(doc, /- C001 \[active\] Declare only the files the claim covers\./)
    assert.match(doc, /why: A branch-union declaration stales every feature\./)
    assert.match(doc, /1 retired constraint\(s\)/)
    // Next legal moves: HANDOFF is terminal, and the brief says so from the graph.
    assert.match(doc, /## Next legal moves/)
    assert.match(doc, /HANDOFF has no successor phase \(HANDOFF is terminal\)/)
  } finally {
    cleanup(rig.dir)
  }
})

test('a newline in a hand-editable phase cannot forge a line of the brief', () => {
  const rig = richProject()
  try {
    // `phase` lives in `.dsh/WORKFLOW.json`, which a human (or a model) can edit by hand. In the
    // metadata line it is the only free-text field that was not flattened; a newline in it used
    // to become a separate markdown line that reads as though the brief said it.
    const doc = buildHandoffDoc({
      state: {
        phase: 'COMMIT\n- features: 9/9 complete, 0 open',
        feature_id: 'F001',
        updated_at: '2026-11-01T00:00:00.000Z',
        waivers: [],
      },
      features: rig.features,
      constraints: rig.constraints,
      projectDir: rig.dir,
      now: '2026-11-01T00:00:00.000Z',
    })
    const lines = doc.split('\n')
    assert.match(doc, /^- phase: COMMIT - features: 9\/9 complete, 0 open/m, 'the phase must stay inline')
    assert.equal(
      lines.some(line => line === '- features: 9/9 complete, 0 open'),
      false,
      'a newline in the phase must not create a markdown line',
    )
    assert.equal(
      lines.filter(line => line.startsWith('- features: ')).length,
      1,
      'exactly one feature-count line: the real one',
    )
  } finally {
    cleanup(rig.dir)
  }
})

test('a newline in a waiver open-feature id cannot forge a line of the brief', () => {
  const rig = richProject()
  try {
    // The ids come out of a hand-editable state file, exactly like the OPEN blocker line's, and
    // they must be flattened the same way — otherwise an id could imitate a waiver line.
    const doc = buildHandoffDoc({
      state: {
        phase: 'HANDOFF',
        updated_at: '2026-11-01T00:00:00.000Z',
        waivers: [
          {
            at: '2026-11-01T00:00:00.000Z',
            reason: 'deliberate',
            openTotal: 2,
            openFeatures: ['F003\n- OPEN (0): every feature is waived', 'F004'],
          },
        ],
      },
      features: rig.features,
      constraints: rig.constraints,
      projectDir: rig.dir,
      now: '2026-11-01T00:00:00.000Z',
    })
    const lines = doc.split('\n')
    assert.equal(
      lines.some(line => line === '- OPEN (0): every feature is waived'),
      false,
      'a newline in a waiver id must not create a markdown line',
    )
    assert.match(
      doc,
      /- Waiver recorded at .*2 open feature\(s\) \(F003 - OPEN \(0\): every feature is waived, F004\) — "deliberate"/,
      'both ids stay on the waiver line, flattened',
    )
  } finally {
    cleanup(rig.dir)
  }
})

test('a project with no review evidence still produces a brief (no crash on empty state)', () => {
  const dir = makeProject()
  try {
    const empty = buildHandoffDoc({ state: {}, features: {}, constraints: {}, projectDir: dir, now: '2026-11-01T00:00:00.000Z' })
    assert.match(empty, /^# Handoff brief/m)
    assert.match(empty, /no features recorded/i)
    assert.match(empty, /no active constraint/i)
    assert.match(empty, /no phase recorded/i)
    // A feature with no evidence is named rather than dropped.
    const withOpen = buildHandoffDoc({
      state: { phase: 'COMMIT' },
      features: { features: [feature('F001')] },
      constraints: { constraints: [] },
      projectDir: dir,
      now: '2026-11-01T00:00:00.000Z',
    })
    assert.match(withOpen, /F001 — OPEN · no review evidence/)
    assert.match(withOpen, /last review: none recorded/)
    // And the writer works on that same empty evidence.
    const written = writeHandoffDoc({ projectDir: dir, state: {}, features: {}, constraints: {}, now: '2026-11-01T00:00:00.000Z' })
    assert.equal(written.written, true, JSON.stringify(written))
    assert.match(readFileSync(join(dir, HANDOFF_DOC_RELATIVE_PATH), 'utf8'), /^# Handoff brief/m)
  } finally {
    cleanup(dir)
  }
})

// ---------------------------------------------------------------------------
// the target
// ---------------------------------------------------------------------------

test('the writer only targets .dsh/HANDOFF.md and never the tracked root HANDOFF.md', () => {
  const dir = makeProject()
  try {
    // A canary standing in for the tracked incident brief at the repository root.
    writeFileSync(join(dir, 'HANDOFF.md'), '# the incident brief\n', 'utf8')
    const result = writeHandoffDoc({
      projectDir: dir,
      state: { phase: 'HANDOFF' },
      features: { features: [] },
      constraints: { constraints: [] },
      now: '2026-11-01T00:00:00.000Z',
    })
    assert.equal(result.written, true, JSON.stringify(result))
    assert.equal(result.path, join(dir, '.dsh', 'HANDOFF.md'))
    assert.equal(HANDOFF_DOC_RELATIVE_PATH, join('.dsh', 'HANDOFF.md'))
    assert.equal(HANDOFF_DOC_DISPLAY_PATH, '.dsh/HANDOFF.md')
    // The root brief is untouched — byte for byte — and the generated file is the only addition.
    assert.equal(readFileSync(join(dir, 'HANDOFF.md'), 'utf8'), '# the incident brief\n')
    assert.deepEqual(readdirSync(dir).sort(), ['.dsh', 'HANDOFF.md'].sort())
    assert.deepEqual(readdirSync(join(dir, '.dsh')).sort(), ['HANDOFF.md', 'workflow.yml'].sort())
    // The resolver refuses anything that is not the one legal target, including the root brief.
    const target = assertHandoffDocTarget(dir)
    assert.equal(target.ok, true)
    assert.equal(target.path, join(dir, '.dsh', 'HANDOFF.md'))
    assert.equal(assertHandoffDocTarget('').ok, false)
  } finally {
    cleanup(dir)
  }
})

test('two work units get separate briefs with their own counts, and neither touches the project-level file', async () => {
  const dir = makeProject()
  try {
    // A: two features, one complete. B: one feature, none complete. Different counts, so a
    // mixed-up file is visible rather than a coincidence.
    const featuresA = { schema_version: 1, features: [feature('A1', { passes: true }), feature('A2')] }
    const featuresB = { schema_version: 1, features: [feature('B1')] }
    writeFeatures(dir, featuresA, 'A')
    writeFeatures(dir, featuresB, 'B')
    const stateA = stateDoc({ phase: 'HANDOFF', featureId: 'A1' })
    const stateB = stateDoc({ phase: 'COMMIT', featureId: 'B1' })
    writeState(dir, stateA, 'A')
    writeState(dir, stateB, 'B')

    const writtenA = writeHandoffDoc({
      projectDir: dir,
      workUnit: 'A',
      state: stateA,
      features: featuresA,
      constraints: { constraints: [] },
    })
    assert.equal(writtenA.written, true, JSON.stringify(writtenA))
    assert.equal(writtenA.relativePath, join('.dsh', 'work', 'A', 'HANDOFF.md'))
    assert.equal(writtenA.displayPath, '.dsh/work/A/HANDOFF.md')
    const bytesA = readFileSync(join(dir, '.dsh', 'work', 'A', 'HANDOFF.md'), 'utf8')
    assert.match(bytesA, /- scope: work unit `A`/)
    assert.match(bytesA, /features: 1\/2 complete, 1 open/)
    // The brief names the file it IS, so a reader is not sent to another scope's document.
    assert.match(bytesA, /It lives at `\.dsh\/work\/A\/HANDOFF\.md`/)

    const writtenB = writeHandoffDoc({
      projectDir: dir,
      workUnit: 'B',
      state: stateB,
      features: featuresB,
      constraints: { constraints: [] },
    })
    assert.equal(writtenB.written, true, JSON.stringify(writtenB))
    const bytesB = readFileSync(join(dir, '.dsh', 'work', 'B', 'HANDOFF.md'), 'utf8')
    assert.match(bytesB, /- scope: work unit `B`/)
    assert.match(bytesB, /features: 0\/1 complete, 1 open/)
    // THE COLLISION THIS PATH EXISTS TO PREVENT: B's write must not overwrite A's brief.
    assert.equal(readFileSync(join(dir, '.dsh', 'work', 'A', 'HANDOFF.md'), 'utf8'), bytesA)
    // Neither unit wrote the project-level brief.
    assert.equal(existsSync(join(dir, HANDOFF_DOC_RELATIVE_PATH)), false)

    // `workflow_status work_unit=A` pairs A's FILE with A's COUNTS — that pairing is the defect.
    const statusA = await buildToolDefinition(toolOptions()).execute({ work_unit: 'A' }, execFor(dir))
    assert.equal(statusA.handoffDoc.displayPath, '.dsh/work/A/HANDOFF.md')
    assert.deepEqual(statusA.handoffDoc.counts, { total: 2, done: 1, open: 1, stale: 0, unknown: 0 })
    const statusB = await buildToolDefinition(toolOptions()).execute({ work_unit: 'B' }, execFor(dir))
    assert.equal(statusB.handoffDoc.displayPath, '.dsh/work/B/HANDOFF.md')
    assert.deepEqual(statusB.handoffDoc.counts, { total: 1, done: 0, open: 1, stale: 0, unknown: 0 })
    // The project-level report still says "not written": neither unit's file is its brief.
    const statusProject = await buildToolDefinition(toolOptions()).execute({}, execFor(dir))
    assert.equal(statusProject.handoffDoc.present, false)
    assert.equal(statusProject.handoffDoc.displayPath, HANDOFF_DOC_DISPLAY_PATH)

    // THE PRODUCTION PATH: entering HANDOFF through the tool for unit B writes B's file, and A's
    // brief and the project-level path are still untouched afterwards.
    const advance = await buildAdvanceToolDefinition(toolOptions()).execute(
      {
        action: 'advance',
        to: 'HANDOFF',
        work_unit: 'B',
        waive_open_features: true,
        waiver_reason: 'B is deliberately left open for this canary',
      },
      execFor(dir),
    )
    assert.equal(advance.ok, true, JSON.stringify(advance))
    assert.equal(advance.handoffDoc?.status, 'written', 'entering HANDOFF must write the unit brief')
    assert.equal(advance.handoffDoc.path, join(dir, '.dsh', 'work', 'B', 'HANDOFF.md'))
    assert.match(renderAdvance(advance), /handoff brief: written to \.dsh\/work\/B\/HANDOFF\.md/)
    assert.equal(readFileSync(join(dir, '.dsh', 'work', 'A', 'HANDOFF.md'), 'utf8'), bytesA)
    assert.equal(existsSync(join(dir, HANDOFF_DOC_RELATIVE_PATH)), false)
  } finally {
    cleanup(dir)
  }
})

test('a work-unit id that could escape .dsh/work is refused as a brief target', () => {
  const dir = makeProject()
  try {
    // THE VALIDATOR IS THE LAYER THAT REFUSES IT: `validateWorkUnitId` rejects a separator and a
    // leading dot, so `../x` never becomes a path segment. The brief derives its path from that
    // same validator, and `assertHandoffDocTarget` additionally containment-checks the result.
    assert.equal(validateWorkUnitId('../escape').ok, false)
    assert.equal(handoffDocRelativePath('../escape'), null)
    assert.equal(assertHandoffDocTarget(dir, '../escape').ok, false)
    const refused = writeHandoffDoc({
      projectDir: dir,
      workUnit: '../escape',
      state: {},
      features: {},
      constraints: {},
    })
    assert.equal(refused.ok, false)
    assert.equal(refused.written, false)
    assert.match(refused.reason, /work unit/i)
    assert.equal(existsSync(join(dir, '.dsh', 'escape')), false)
    assert.equal(existsSync(join(dir, '..', 'escape')), false)
    for (const bad of ['..', '.hidden', 'a/b', 'a\\b', 'a b']) {
      assert.equal(handoffDocRelativePath(bad), null, `${JSON.stringify(bad)} must not resolve to a brief path`)
    }
    // The positive control: a valid unit resolves under its own directory and nowhere else.
    assert.equal(handoffDocRelativePath('A'), join('.dsh', 'work', 'A', 'HANDOFF.md'))
  } finally {
    cleanup(dir)
  }
})

// ---------------------------------------------------------------------------
// the switch
// ---------------------------------------------------------------------------

test('modules.handoffDoc: false writes no brief file and renders no status section', async () => {
  const offDir = makeProject({ config: 'tier: standard\nmodules:\n  handoffDoc: false\n' })
  const onDir = makeProject()
  try {
    for (const dir of [offDir, onDir]) {
      writeFileSync(join(dir, 'a.js'), 'let a = 1\n', 'utf8')
      seedProject(dir, [feature('F001', { passes: true, evidence: [reviewRow(dir, ['a.js'])] })])
    }

    const offDef = buildAdvanceToolDefinition(toolOptions())
    const off = await offDef.execute({ action: 'advance', to: 'HANDOFF' }, execFor(offDir))
    assert.equal(off.ok, true, JSON.stringify(off))
    assert.equal(off.phase, 'HANDOFF')
    assert.equal(off.handoffDoc?.status, 'disabled', 'the reply must say the module is off')
    assert.equal(existsSync(join(offDir, '.dsh', 'HANDOFF.md')), false, 'the off switch must write no file')
    assert.equal(renderAdvance(off).includes('handoff brief'), false, 'no brief line on the reply when off')

    const offStatus = await buildToolDefinition(toolOptions()).execute({}, execFor(offDir))
    const offText = renderStatus(offStatus)
    assert.equal(offStatus.handoffDoc.enabled, false)
    assert.equal(/handoff (brief|counts|next action)/.test(offText), false, 'no status section when off')

    // The positive control: the same project and the same move, with the module on.
    const onDef = buildAdvanceToolDefinition(toolOptions())
    const on = await onDef.execute({ action: 'advance', to: 'HANDOFF' }, execFor(onDir))
    assert.equal(on.ok, true, JSON.stringify(on))
    assert.equal(on.handoffDoc?.status, 'written')
    assert.equal(on.handoffDoc.bytes > 0, true)
    assert.equal(existsSync(join(onDir, '.dsh', 'HANDOFF.md')), true)
    assert.match(renderAdvance(on), /handoff brief: written to \.dsh\/HANDOFF\.md/)

    const onStatus = await buildToolDefinition(toolOptions()).execute({}, execFor(onDir))
    const onText = renderStatus(onStatus)
    assert.equal(onStatus.handoffDoc.enabled, true)
    assert.equal(onStatus.handoffDoc.present, true)
    assert.equal(onStatus.handoffDoc.relativePath, HANDOFF_DOC_RELATIVE_PATH)
    assert.match(onText, /handoff brief: \.dsh\/HANDOFF\.md/)
  } finally {
    cleanup(offDir)
    cleanup(onDir)
  }
})

// ---------------------------------------------------------------------------
// regeneration
// ---------------------------------------------------------------------------

test('regenerating the same state writes byte-identical content and never appends', () => {
  const dir = makeProject()
  try {
    writeFileSync(join(dir, 'a.js'), 'let a = 1\n', 'utf8')
    const options = {
      projectDir: dir,
      state: { phase: 'HANDOFF', updated_at: '2026-11-01T00:00:00.000Z', waivers: [] },
      features: { features: [feature('F001', { passes: true, evidence: [reviewRow(dir, ['a.js'])] })] },
      constraints: { constraints: [] },
    }
    // No `now`: the stamp defaults to `state.updated_at`, so the same state renders the same bytes.
    const first = writeHandoffDoc(options)
    const bytes1 = readFileSync(join(dir, HANDOFF_DOC_RELATIVE_PATH), 'utf8')
    assert.equal(first.written, true, JSON.stringify(first))
    const second = writeHandoffDoc(options)
    const bytes2 = readFileSync(join(dir, HANDOFF_DOC_RELATIVE_PATH), 'utf8')
    assert.equal(second.written, true, JSON.stringify(second))
    assert.equal(bytes2, bytes1, 'the same state must regenerate the same bytes')
    assert.equal(bytes2.length, bytes1.length)
    // Replaced, not appended: exactly one title and one of each section heading.
    assert.equal((bytes2.match(/^# Handoff brief$/gm) ?? []).length, 1)
    assert.equal((bytes2.match(/^## Features \(1\)$/gm) ?? []).length, 1)
    assert.equal((bytes2.match(/^## Next legal moves$/gm) ?? []).length, 1)
    assert.equal(bytes2.endsWith('\n'), true)
    assert.equal(bytes2.endsWith('\n\n'), false, 'the file ends with a single newline')
  } finally {
    cleanup(dir)
  }
})

// ---------------------------------------------------------------------------
// the status summary
// ---------------------------------------------------------------------------

test('the status summary is bounded and its counts match the state', async () => {
  const rig = richProject()
  try {
    // One complete feature is STALE, one is FRESH, two are open: counts are exact.
    writeFileSync(
      join(rig.dir, FEATURES_RELATIVE_PATH),
      JSON.stringify(rig.features, null, 2),
      'utf8',
    )
    seedProject(rig.dir, rig.features.features, { phase: 'COMMIT', featureId: 'F001' })
    const written = writeHandoffDoc({
      projectDir: rig.dir,
      state: { phase: 'COMMIT', updated_at: '2026-11-01T00:00:00.000Z' },
      features: rig.features,
      constraints: rig.constraints,
    })
    assert.equal(written.written, true, JSON.stringify(written))

    const status = await buildToolDefinition(toolOptions()).execute({}, execFor(rig.dir))
    const text = renderStatus(status)
    const section = text
      .split('\n')
      .filter(line => /^\s*(handoff brief|handoff counts|handoff next action):/.test(line))
    assert.ok(section.length > 0, 'the status section must appear when the module is on')
    assert.ok(section.length <= 4, `the status section must stay bounded; got ${section.length} lines:\n${section.join('\n')}`)
    assert.match(section.join('\n'), /handoff brief: \.dsh\/HANDOFF\.md \([\d.]+ (bytes|KB), modified /)
    assert.equal(status.handoffDoc.present, true)
    assert.equal(status.handoffDoc.counts.total, 4)
    assert.equal(status.handoffDoc.counts.done, 2)
    assert.equal(status.handoffDoc.counts.open, 2)
    assert.equal(status.handoffDoc.counts.stale, 1)
    assert.match(section.join('\n'), /handoff counts: 2\/4 complete, 2 open; 1 stale reviewed feature\(s\)/)
    assert.match(section.join('\n'), /handoff next action: re-review 1 stale feature\(s\)/)
    // The FULL brief is on disk, not in the report: the document's headings never appear inline.
    assert.equal(text.includes('## Features (4)'), false)
    // The file facts are read from disk, and the reader must not invent them.
    const fileFacts = readHandoffDocStatus(rig.dir, { handoffDoc: true })
    assert.equal(fileFacts.present, true)
    assert.equal(fileFacts.sizeBytes, written.bytes)
  } finally {
    cleanup(rig.dir)
  }
})

test('entering HANDOFF through the tool writes the brief for an unreviewed, waived project', async () => {
  const dir = makeProject()
  try {
    seedProject(dir, [feature('F001')], { phase: 'COMMIT', featureId: 'F001' })
    const def = buildAdvanceToolDefinition(toolOptions())
    const handoff = await def.execute(
      {
        action: 'advance',
        to: 'HANDOFF',
        waive_open_features: true,
        waiver_reason: 'F001 is deliberately left unfinished for this test',
      },
      execFor(dir),
    )
    assert.equal(handoff.ok, true, JSON.stringify(handoff))
    assert.equal(handoff.handoffDoc?.status, 'written', 'entering HANDOFF must write the brief')
    assert.equal(handoff.handoffDoc.path, join(dir, '.dsh', 'HANDOFF.md'))
    const doc = readFileSync(join(dir, HANDOFF_DOC_RELATIVE_PATH), 'utf8')
    assert.match(doc, /F001 — OPEN · no review evidence/)
    assert.match(doc, /- OPEN \(1\): F001/)
    assert.match(doc, /- Waiver recorded at /)
    assert.match(doc, /F001 is deliberately left unfinished for this test/)
    assert.match(renderAdvance(handoff), /handoff brief: written to \.dsh\/HANDOFF\.md/)
    // A later status call reports the same file without writing a second one.
    const before = readFileSync(join(dir, HANDOFF_DOC_RELATIVE_PATH), 'utf8')
    const status = await buildToolDefinition(toolOptions()).execute({}, execFor(dir))
    assert.equal(status.handoffDoc.present, true)
    assert.equal(readFileSync(join(dir, HANDOFF_DOC_RELATIVE_PATH), 'utf8'), before, 'status is read-only')
  } finally {
    cleanup(dir)
  }
})

// ---------------------------------------------------------------------------
// the brief must not go stale after HANDOFF
// ---------------------------------------------------------------------------
//
// THE DEFECT THIS PINS was measured: the brief was written only as the project ENTERED HANDOFF,
// and HANDOFF is terminal — so every later `record-review` left the file saying "7/8 complete"
// and six stale records while the state said 8/8 and five. A document whose numbers describe a
// past state is worse than no document: the next session reads it first.

test('refreshHandoffDoc writes an existing brief, creates none, and honours the switch', async () => {
  const dir = makeProject()
  try {
    writeFileSync(join(dir, 'a.js'), 'let a = 1\n', 'utf8')
    const state = stateDoc({ phase: 'HANDOFF' })
    const features = { features: [feature('F001', { passes: true, evidence: [reviewRow(dir, ['a.js'])] })] }
    const options = {
      projectDir: dir,
      workUnit: null,
      state,
      features,
      constraints: { constraints: [] },
      modules: {},
    }

    const absent = await refreshHandoffDoc(options)
    assert.equal(absent.status, 'absent', 'a project that never entered HANDOFF gets no file')
    assert.equal(existsSync(join(dir, HANDOFF_DOC_RELATIVE_PATH)), false)

    assert.equal(writeHandoffDoc(options).written, true)
    const before = readFileSync(join(dir, HANDOFF_DOC_RELATIVE_PATH), 'utf8')

    const refreshed = await refreshHandoffDoc({ ...options, state: { ...state, updated_at: '2026-11-02T00:00:00.000Z' } })
    assert.equal(refreshed.status, 'written', JSON.stringify(refreshed))
    const after = readFileSync(join(dir, HANDOFF_DOC_RELATIVE_PATH), 'utf8')
    assert.notEqual(after, before, 'the refreshed brief describes the new state')
    assert.match(after, /- generated: 2026-11-02T00:00:00\.000Z/)

    const off = await refreshHandoffDoc({ ...options, modules: { handoffDoc: false } })
    assert.equal(off.status, 'disabled')
    assert.equal(readFileSync(join(dir, HANDOFF_DOC_RELATIVE_PATH), 'utf8'), after, 'off means no write')
  } finally {
    cleanup(dir)
  }
})

test('record-review in HANDOFF rewrites the brief, so its counts stop describing the past', async () => {
  const dir = makeProject()
  try {
    writeFileSync(join(dir, 'a.js'), 'let a = 1\n', 'utf8')
    writeFileSync(join(dir, 'b.js'), 'let b = 1\n', 'utf8')
    seedProject(
      dir,
      [feature('F001', { passes: true, evidence: [reviewRow(dir, ['a.js'])] }), feature('F002')],
      { phase: 'COMMIT' },
    )
    const options = toolOptions()
    const def = buildAdvanceToolDefinition(options)
    // F002 is deliberately left open, so the move needs a waiver — the same shape the real
    // session used when it entered HANDOFF with work outstanding.
    const entered = await def.execute(
      { action: 'advance', to: 'HANDOFF', waive_open_features: true, waiver_reason: 'deliberately unfinished' },
      execFor(dir),
    )
    assert.equal(entered.ok, true, JSON.stringify(entered))
    const briefBefore = readFileSync(join(dir, HANDOFF_DOC_RELATIVE_PATH), 'utf8')
    assert.match(briefBefore, /- features: 1\/2 complete, 1 open/)

    const { reviewDef, reviewExec } = reviewRig(options, execFor(dir))
    await reviewDef.execute({ feature: 'b', changed_files: ['b.js'] }, reviewExec)
    const applied = await def.execute({ action: 'record-review', feature_id: 'F002' }, execFor(dir))
    assert.equal(applied.ok, true, JSON.stringify(applied))
    assert.equal(applied.handoffDoc?.status, 'written', 'the state write must refresh the brief')

    const briefAfter = readFileSync(join(dir, HANDOFF_DOC_RELATIVE_PATH), 'utf8')
    assert.match(briefAfter, /- features: 2\/2 complete, 0 open/)
    assert.match(briefAfter, /- \[x\] F002 — complete/)
  } finally {
    cleanup(dir)
  }
})

test('a failed brief write is reported on the move, never turned into a refused transition', async () => {
  const dir = makeProject()
  try {
    writeFileSync(join(dir, 'a.js'), 'let a = 1\n', 'utf8')
    seedProject(dir, [feature('F001', { passes: true, evidence: [reviewRow(dir, ['a.js'])] })], { phase: 'COMMIT' })
    // A DIRECTORY at the target path makes the rename fail, which is the only portable way to
    // force the write error this test is about.
    mkdirSync(join(dir, HANDOFF_DOC_RELATIVE_PATH), { recursive: true })

    const def = buildAdvanceToolDefinition(toolOptions())
    const moved = await def.execute({ action: 'advance', to: 'HANDOFF' }, execFor(dir))
    assert.equal(moved.ok, true, 'the phase machine does not own the documentation file')
    assert.equal(moved.phase, 'HANDOFF')
    assert.equal(moved.handoffDoc?.status, 'failed')
    assert.match(String(moved.handoffDoc?.reason ?? ''), /could not be written/)
    assert.equal(readState(dir).state.phase, 'HANDOFF', 'the transition itself is persisted')
  } finally {
    cleanup(dir)
  }
})

// ---------------------------------------------------------------------------
// the tracked state document is never declared in a review (C002)
// ---------------------------------------------------------------------------
//
// WHY A DATA TEST AND NOT A PROSE RULE. `docs/HANDOFF-STATE.md` is prose a human or agent
// writes at the end of a session; no test can police its content. What IS mechanical is the
// property that makes it cheap: it must never appear in a recorded review's `changed_files`.
// Staleness is caused by the FINGERPRINT, which covers only declared files, so declaring the
// document would stale every feature the moment the document was written — the exact trap the
// document exists to avoid.
//
// THE CHECK MUST NOT BE VACUOUS IN A FRESH CLONE. `.dsh/` is gitignored, so a clone has no
// evidence to scan — the first version of this test simply returned and reported PASS, which
// independent review round 1 correctly called out. The rule is therefore asserted where it is
// always present (CONTRIBUTING.md documents it, and the document itself is tracked), and the
// data scan runs in addition whenever this checkout has workflow state.

test('the session-end document is documented as never reviewed (C002)', () => {
  const contributing = readFileSync(new URL('../CONTRIBUTING.md', import.meta.url), 'utf8')
  assert.match(contributing, /docs\/HANDOFF-STATE\.md/, 'CONTRIBUTING must name the document')
  assert.match(contributing, /C002/, 'CONTRIBUTING must name the constraint that pins it')
  assert.match(contributing, /never\*\* declared in a review/, 'the rule itself must be stated')
  // The document is tracked, so its absence is a real failure here (not a missing-state skip).
  assert.equal(
    existsSync(new URL('../docs/HANDOFF-STATE.md', import.meta.url)),
    true,
    'docs/HANDOFF-STATE.md must exist: it is the tracked session-end document',
  )
})

test('no recorded review declares docs/HANDOFF-STATE.md (C002, data check)', () => {
  const featuresPath = new URL('../.dsh/FEATURES.json', import.meta.url)
  // A checkout without workflow state has no recorded evidence to scan; C002 is asserted by the
  // test above, so this one is additive rather than the only check.
  if (!existsSync(featuresPath)) return
  const document = JSON.parse(readFileSync(featuresPath, 'utf8'))
  const declared = []
  for (const feature of Array.isArray(document?.features) ? document.features : []) {
    for (const row of Array.isArray(feature?.evidence) ? feature.evidence : []) {
      if (row === null || typeof row !== 'object' || row.type !== 'review') continue
      for (const file of Array.isArray(row.files) ? row.files : []) declared.push(String(file))
    }
  }
  assert.equal(
    declared.some(file => file === 'docs/HANDOFF-STATE.md' || file.endsWith('/HANDOFF-STATE.md')),
    false,
    'the session-end state document must never be declared in a review: declaring it would stale ' +
      'every feature whose review covered it',
  )
})

test('a failed refresh is reported on the record-review reply, not swallowed', async () => {
  const dir = makeProject()
  try {
    writeFileSync(join(dir, 'a.js'), 'let a = 1\n', 'utf8')
    writeFileSync(join(dir, 'b.js'), 'let b = 1\n', 'utf8')
    seedProject(
      dir,
      [feature('F001', { passes: true, evidence: [reviewRow(dir, ['a.js'])] }), feature('F002')],
      { phase: 'COMMIT' },
    )
    const options = toolOptions()
    const def = buildAdvanceToolDefinition(options)
    const entered = await def.execute(
      { action: 'advance', to: 'HANDOFF', waive_open_features: true, waiver_reason: 'deliberately unfinished' },
      execFor(dir),
    )
    assert.equal(entered.ok, true, JSON.stringify(entered))

    // The portable way to make the write fail: a DIRECTORY where the brief belongs.
    rmSync(join(dir, HANDOFF_DOC_RELATIVE_PATH), { force: true })
    mkdirSync(join(dir, HANDOFF_DOC_RELATIVE_PATH), { recursive: true })

    const { reviewDef, reviewExec } = reviewRig(options, execFor(dir))
    await reviewDef.execute({ feature: 'b', changed_files: ['b.js'] }, reviewExec)
    const applied = await def.execute({ action: 'record-review', feature_id: 'F002' }, execFor(dir))
    assert.equal(applied.ok, true, 'the verdict is recorded whatever the document does')
    // A SILENT FAILURE LEAVES A STALE BRIEF ON DISK, which is the defect the refresh exists to
    // remove — so the failure is on the reply (independent review round 1 found it dropped).
    assert.equal(applied.handoffDoc?.status, 'failed', JSON.stringify(applied))
    assert.match(String(applied.handoffDoc?.reason ?? ''), /could not be refreshed/)
  } finally {
    cleanup(dir)
  }
})

test('boot refreshes an existing brief too, so "every state write" is literal', async () => {
  const dir = makeProject()
  try {
    writeFileSync(join(dir, 'a.js'), 'let a = 1\n', 'utf8')
    seedProject(dir, [feature('F001', { passes: true, evidence: [reviewRow(dir, ['a.js'])] })], { phase: 'COMMIT' })
    const def = buildAdvanceToolDefinition(toolOptions())
    const entered = await def.execute({ action: 'advance', to: 'HANDOFF' }, execFor(dir))
    assert.equal(entered.ok, true, JSON.stringify(entered))
    const before = readFileSync(join(dir, HANDOFF_DOC_RELATIVE_PATH), 'utf8')

    // `boot` also writes WORKFLOW.json. Independent review round 1 observed that it left the
    // brief behind, which made the documented "every later state write refreshes it" false.
    const booted = await def.execute({ action: 'boot', smoke_passed: true }, execFor(dir))
    assert.equal(booted.status, 'ok', JSON.stringify(booted))
    assert.equal(booted.handoffDoc?.status, 'written', 'boot must refresh the brief')
    const after = readFileSync(join(dir, HANDOFF_DOC_RELATIVE_PATH), 'utf8')
    assert.notEqual(after, before, 'the refreshed brief carries the new state stamp')
  } finally {
    cleanup(dir)
  }
})
