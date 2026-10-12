/**
 * Offline self-test for dsh-workflow.
 *
 * These tests need no DSH host: they exercise the pure logic — configuration
 * resolution and the project opt-in probe — which is where the safety invariants
 * live. Run with `node --test test/` from the package root.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig, configWarnings, DEFAULT_CONFIG, mergeConfigLayers } from '../lib/config.js'
import { probeProject, parseWorkflowYaml } from '../lib/project.js'
import {
  serializeWorkflowYaml,
  resolveEffectiveConfig,
  setPath,
  getPath,
  validateTopLevelKey,
  readWorkflowFile,
} from '../lib/workflow-file.js'
import { toLosslessJson } from '../lib/tools.js'
import {
  aggregateScore,
  decideVerdict,
  normaliseReview,
  buildReviewPrompt,
  runReview,
  renderReview,
  DEFAULT_DIMENSIONS,
  DEFAULT_MUST_PASS,
  REVIEW_OUTPUT_SCHEMA,
} from '../lib/review.js'

test('resolveConfig returns defaults when nothing is supplied', () => {
  const config = resolveConfig(undefined)
  assert.equal(config.tier, 'standard')
  assert.equal(config.subagent.maxDepth, 2)
  assert.equal(config.approval.strength, 'ask-user')
  assert.equal(config.modules.independentReview, true)
})

test('resolveConfig deep-merges without dropping sibling defaults', () => {
  const config = resolveConfig({ modules: { planner: false } })
  assert.equal(config.modules.planner, false)
  assert.equal(config.modules.independentReview, true, 'sibling switches must survive')
  assert.equal(config.tier, 'standard', 'untouched top-level keys must survive')
})

test('resolveConfig ignores undefined so an absent patch field cannot erase a default', () => {
  const config = resolveConfig({ tier: undefined, approval: { strength: undefined } })
  assert.equal(config.tier, DEFAULT_CONFIG.tier)
  assert.equal(config.approval.strength, DEFAULT_CONFIG.approval.strength)
})

// REGRESSION — the depth cap. It was pinned to 1, reasoned as "a delegated child must not
// delegate again". That reasoning was wrong: `maxDepth` is an ABSOLUTE ceiling on the
// delegation tree, so 1 also forbade the architecture this plugin recommends —
// main agent (0) -> orchestrator child (1) -> its reviewer (2) — and pushed every review
// back into the main conversation, the very context pollution the plugin exists to avoid.
test('maxDepth caps nesting at 2 and repairs anything higher', () => {
  // `resolveConfig` only merges; the invariant is enforced by `configWarnings`, which
  // reports AND repairs. The contract is therefore asserted through `configWarnings`.
  const check = bad => {
    const config = resolveConfig({ subagent: { maxDepth: bad } })
    const warnings = configWarnings(config)
    return { depth: config.subagent.maxDepth, warned: warnings.some(w => w.includes('maxDepth')) }
  }

  const tooDeep = check(5)
  assert.equal(tooDeep.depth, 2, 'runaway nesting must be unrepresentable')
  assert.ok(tooDeep.warned, 'the repair must be reported')

  // 2 is permitted: it is what lets a delegated orchestrator start its reviewer.
  assert.equal(check(2).depth, 2, 'a valid value must be left alone')
  assert.equal(check(2).warned, false, 'a valid value must not warn')
  assert.equal(check(1).depth, 1, '1 is a valid, stricter choice')

  // 0 would disable delegation entirely; non-integers and >2 are unusable.
  for (const bad of [0, -1, 3, 1.5]) {
    const result = check(bad)
    assert.equal(result.depth, 2, `maxDepth ${bad} must be repaired`)
    assert.ok(result.warned, `maxDepth ${bad} must be reported`)
  }
})

test('a bad parallel limit is repaired to the default and reported', () => {
  const config = resolveConfig({ subagent: { maxActiveSubagents: 0 } })
  const warnings = configWarnings(config)
  assert.equal(config.subagent.maxActiveSubagents, 8)
  assert.ok(warnings.some(w => w.includes('maxActiveSubagents')))
})

test('llm-only approval is accepted but warned about', () => {
  const config = resolveConfig({ approval: { strength: 'llm-only' } })
  assert.equal(config.approval.strength, 'llm-only')
  const warnings = configWarnings(config)
  assert.ok(warnings.some(w => w.includes('removes human authorization')))
})

test('unknown vocabulary is reported, not thrown', () => {
  const config = resolveConfig({ tier: 'gigantic', approval: { strength: 'yolo' } })
  const warnings = configWarnings(config)
  assert.ok(warnings.some(w => w.includes('unknown tier')))
  // The approval refusal is now emitted by the gate's own validator, so it names the
  // field and the offending value. The intent of this assertion is unchanged: an unknown
  // strength must never be absorbed silently.
  assert.ok(
    warnings.some(w => w.includes('approval.strength') && w.includes('yolo')),
    warnings.join(' | '),
  )
  assert.ok(warnings.some(w => w.includes('fail-closed defaults')))
})

test('turning off independent review is warned about', () => {
  const config = resolveConfig({ evaluator: { independent: false } })
  assert.ok(configWarnings(config).some(w => w.includes('independent')))
})

test('mustPass entries missing from dimensions are reported', () => {
  const config = resolveConfig({ evaluator: { dimensions: ['correctness'], mustPass: ['build'] } })
  assert.ok(configWarnings(config).some(w => w.includes('build')))
})

test('probeProject treats a missing workflow file as not opted in', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wf-'))
  try {
    const probe = probeProject(dir)
    assert.equal(probe.detected, false)
    assert.equal(probe.projectDir, dir)
    assert.ok(probe.signals.some(s => s.includes('has not opted in')))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('probeProject detects opt-in and reads the workflow file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wf-'))
  try {
    mkdirSync(join(dir, '.dsh'), { recursive: true })
    writeFileSync(
      join(dir, '.dsh', 'workflow.yml'),
      ['tier: strict', 'modules:', '  planner: false', 'context:', '  maxInlineTokens: 9000'].join('\n'),
      'utf8',
    )
    const probe = probeProject(dir)
    assert.equal(probe.detected, true)
    assert.equal(probe.workflow.tier, 'strict')
    assert.equal(probe.workflow.modules.planner, false)
    assert.equal(probe.workflow.context.maxInlineTokens, 9000)
    assert.deepEqual(probe.workflowProblems, [])
    assert.equal(probe.harnessability.dsDir, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('probeProject reports harness signals it can see', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wf-'))
  try {
    mkdirSync(join(dir, '.git'), { recursive: true })
    writeFileSync(join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }), 'utf8')
    writeFileSync(join(dir, 'tsconfig.json'), '{}', 'utf8')
    const probe = probeProject(dir)
    assert.equal(probe.harnessability.git, true)
    assert.equal(probe.harnessability.manifest, 'package.json')
    assert.equal(probe.harnessability.testScript, true)
    assert.equal(probe.harnessability.typecheckConfig, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('probeProject tolerates an unknown directory', () => {
  const probe = probeProject('')
  assert.equal(probe.projectDir, null)
  assert.equal(probe.detected, false)
  assert.ok(probe.signals.length > 0)
})

test('the workflow YAML reader reports lines it cannot parse', () => {
  const { value, problems } = parseWorkflowYaml(['tier: minimal', 'this is not yaml', 'bar: 2'].join('\n'))
  assert.equal(value.tier, 'minimal')
  assert.equal(value.bar, 2)
  assert.equal(problems.length, 1)
  assert.ok(problems[0].includes('line 2'))
})

test('the workflow YAML reader ignores comments and handles flow arrays', () => {
  const { value } = parseWorkflowYaml(
    ['# lead comment', 'evaluator:', '  mustPass: [correctness, build]  # trailing', '  bar: 8'].join('\n'),
  )
  assert.deepEqual(value.evaluator.mustPass, ['correctness', 'build'])
  assert.equal(value.evaluator.bar, 8)
})

test('the workflow YAML reader handles block sequences', () => {
  const { value, problems } = parseWorkflowYaml(
    [
      'evaluator:',
      '  mustPass:',
      '    - correctness',
      '    - build',
      '  bar: 8',
      'context:',
      '  exclude:',
      '    - tool_history',
      '    - error_logs',
    ].join('\n'),
  )
  assert.deepEqual(problems, [])
  assert.deepEqual(value.evaluator.mustPass, ['correctness', 'build'])
  assert.equal(value.evaluator.bar, 8, 'a key after a block list must still attach to the mapping')
  assert.deepEqual(value.context.exclude, ['tool_history', 'error_logs'])
})

test('the workflow YAML reader handles a list of mappings', () => {
  const { value, problems } = parseWorkflowYaml(
    [
      'steps:',
      '  - action: pick',
      '  - action: build',
      '    maxFiles: 3',
      '  - action: commit',
    ].join('\n'),
  )
  assert.deepEqual(problems, [])
  assert.equal(value.steps.length, 3)
  assert.equal(value.steps[0].action, 'pick')
  assert.equal(value.steps[1].action, 'build')
  assert.equal(value.steps[1].maxFiles, 3)
  assert.equal(value.steps[2].action, 'commit')
})

test('the workflow YAML reader handles scalars, nesting, and inline comments together', () => {
  const { value } = parseWorkflowYaml(
    [
      'tier: strict      # the strictest',
      'recipe: null',
      'approval:',
      '  strength: llm-then-user',
      '  denyHighAlways: true',
      '  riskThreshold: medium',
      'budget:',
      '  maxMinutes: 30',
      '  onExceed: ask',
    ].join('\n'),
  )
  assert.equal(value.tier, 'strict')
  assert.equal(value.recipe, null)
  assert.equal(value.approval.strength, 'llm-then-user')
  assert.equal(value.approval.denyHighAlways, true)
  assert.equal(value.budget.maxMinutes, 30)
  assert.equal(value.budget.onExceed, 'ask')
})

test('the packaged workflow file maps onto real settings', () => {
  const { value, problems } = parseWorkflowYaml(
    [
      'tier: strict',
      'modules:',
      '  planner: false',
      '  independentReview: true',
      'approval:',
      '  strength: llm-only',
      'signoff:',
      '  beforeBulkEdit: true',
    ].join('\n'),
  )
  assert.deepEqual(problems, [])
  assert.equal(value.tier, 'strict')
  assert.equal(value.modules.planner, false)
  assert.equal(value.modules.independentReview, true)
  assert.equal(value.approval.strength, 'llm-only')
  assert.equal(value.signoff.beforeBulkEdit, true)
})

// ---------------------------------------------------------------------------
// configuration layers
// ---------------------------------------------------------------------------

test('mergeConfigLayers keeps sibling keys of a nested section', () => {
  // Regression: a spread (`{...row, ...project}`) would drop modules.planner here.
  const merged = mergeConfigLayers(
    { modules: { planner: false }, tier: 'standard' },
    { modules: { acceptance: false } },
  )
  assert.equal(merged.modules.planner, false, 'row sibling must survive')
  assert.equal(merged.modules.acceptance, false, 'project override must apply')
  assert.equal(merged.tier, 'standard')
})

// ---------------------------------------------------------------------------
// the merge must not mutate its inputs
// ---------------------------------------------------------------------------
//
// REGRESSION — a cross-project veto bypass. `mergeInto` assigned a source's nested
// objects by reference and then merged INTO them, so every merged layer shared
// storage with the row config it was built from. Because the effective config is
// resolved per request, one project's `.dsh/workflow.yml` rewrote a shared object
// that a LATER request in a DIFFERENT project read. Observed end to end: project A
// setting `mustPass: [scope]` left the shared row's `mustPass` as `["scope"]`, so the
// next project's review returned `failedVeto: []` while correctness scored 2 — A
// silently switched off B's veto. A's `bar` and `independent: false` leaked the same
// way.
//
// The suite previously missed this because the only non-mutation-adjacent check lived
// in the smoke test, which built its tool with `{ config: {} }` — an empty row has no
// nested objects to contaminate, making the assertion unfalsifiable.
test('mergeConfigLayers leaves its input layers untouched', () => {
  const row = { tier: 'standard', evaluator: { bar: 8, mustPass: ['correctness'], dimensions: ['correctness'] } }
  const project = { evaluator: { mustPass: ['scope'], bar: 4 } }
  const rowBefore = JSON.stringify(row)
  const projectBefore = JSON.stringify(project)

  const merged = mergeConfigLayers(row, project)

  assert.equal(JSON.stringify(row), rowBefore, 'the row layer must not be rewritten')
  assert.equal(JSON.stringify(project), projectBefore, 'the project layer must not be rewritten')
  assert.deepEqual(merged.evaluator.mustPass, ['scope'], 'the merged view takes the override')
  assert.equal(merged.evaluator.bar, 4)
})

test('a merged layer does not alias its source, so later edits cannot leak back', () => {
  const row = { evaluator: { mustPass: ['correctness'] } }
  const merged = mergeConfigLayers(row)

  // Mutating the merged result is the normal consequence of resolving another layer
  // over it; it must never reach the row.
  merged.evaluator.mustPass = ['scope']
  merged.evaluator.bar = 99

  assert.deepEqual(row.evaluator.mustPass, ['correctness'], 'aliasing leaked into the row')
  assert.equal(row.evaluator.bar, undefined, 'aliasing added a key to the row')
})

test('resolveEffectiveConfig leaves the row config untouched', () => {
  const row = { tier: 'standard', evaluator: { bar: 8, mustPass: ['correctness'] } }
  const before = JSON.stringify(row)

  const first = resolveEffectiveConfig(row, { evaluator: { mustPass: ['scope'] } })
  const second = resolveEffectiveConfig(row, null)

  assert.equal(JSON.stringify(row), before, 'the row layer must survive both calls')
  assert.deepEqual(first.config.evaluator.mustPass, ['scope'])
  assert.deepEqual(
    second.config.evaluator.mustPass,
    ['correctness'],
    'a later project must not inherit the previous project override',
  )
  assert.equal(second.config.evaluator.bar, 8, 'and must not inherit the previous bar')
})

test('resolveConfig leaves the raw patch row untouched', () => {
  const raw = { modules: { planner: false }, evaluator: { mustPass: ['correctness'] } }
  const before = JSON.stringify(raw)

  const resolved = resolveConfig(raw)
  resolved.modules.planner = true
  resolved.evaluator.mustPass.push('scope')

  assert.equal(JSON.stringify(raw), before, 'the patch row must not be aliased into the result')
})

test('later layers win on scalars and arrays replace wholesale', () => {
  const merged = mergeConfigLayers(
    { tier: 'minimal', evaluator: { bar: 5, mustPass: ['correctness'] } },
    { tier: 'strict', evaluator: { bar: 9 } },
  )
  assert.equal(merged.tier, 'strict')
  assert.equal(merged.evaluator.bar, 9)
  assert.deepEqual(merged.evaluator.mustPass, ['correctness'], 'untouched nested key survives')
})

test('mergeConfigLayers ignores non-object layers', () => {
  const merged = mergeConfigLayers(undefined, null, 'nope', { tier: 'strict' })
  assert.deepEqual(merged, { tier: 'strict' })
})

test('resolveEffectiveConfig reports which layers contributed', () => {
  const withoutProject = resolveEffectiveConfig({ tier: 'minimal' }, null)
  assert.deepEqual(withoutProject.sources, ['defaults', 'patch-row'])
  assert.equal(withoutProject.config.tier, 'minimal')

  const withProject = resolveEffectiveConfig({ tier: 'minimal' }, { tier: 'strict' })
  assert.deepEqual(withProject.sources, ['defaults', 'patch-row', 'project-file'])
  assert.equal(withProject.config.tier, 'strict')
})

// ---------------------------------------------------------------------------
// workflow file handling
// ---------------------------------------------------------------------------

test('setPath and getPath address nested keys', () => {
  const target = {}
  assert.equal(setPath(target, ['modules', 'planner'], false), true)
  assert.equal(getPath(target, ['modules', 'planner']), false)
  assert.equal(setPath(target, ['modules', 'planner'], false), false, 'no-op reports no change')
  assert.equal(setPath(target, ['modules', 'planner'], undefined), true, 'unset removes the key')
  assert.equal(getPath(target, ['modules', 'planner']), undefined)
  assert.equal(setPath(target, [], 1), false)
})

test('serialised YAML round-trips through the reader', () => {
  const value = {
    tier: 'strict',
    modules: { planner: false, independentReview: true },
    evaluator: { bar: 8, mustPass: ['correctness', 'build'] },
    approval: { strength: 'llm-then-user', denyHighAlways: true },
    budget: { maxMinutes: null },
  }
  const text = serializeWorkflowYaml(value)
  const { value: parsed, problems } = parseWorkflowYaml(text)
  assert.deepEqual(problems, [], `reader problems: ${problems.join('; ')}`)
  assert.equal(parsed.tier, 'strict')
  assert.equal(parsed.modules.planner, false)
  assert.equal(parsed.modules.independentReview, true)
  assert.equal(parsed.evaluator.bar, 8)
  assert.deepEqual(parsed.evaluator.mustPass, ['correctness', 'build'])
  assert.equal(parsed.approval.strength, 'llm-then-user')
  assert.equal(parsed.budget.maxMinutes, null)
})

test('serialised YAML quotes strings that would be misread', () => {
  const text = serializeWorkflowYaml({ recipe: 'true', tier: 'strict' })
  const { value: parsed } = parseWorkflowYaml(text)
  assert.equal(parsed.recipe, 'true', 'a boolean-looking string must stay a string')
  assert.equal(parsed.tier, 'strict')
})

test('serialised YAML writes an empty array explicitly', () => {
  const text = serializeWorkflowYaml({ context: { exclude: [] } })
  const { value: parsed } = parseWorkflowYaml(text)
  assert.deepEqual(parsed.context.exclude, [])
})

test('only the writable top-level keys are accepted', () => {
  assert.equal(validateTopLevelKey('tier'), null)
  assert.equal(validateTopLevelKey('modules'), null)
  assert.ok(validateTopLevelKey('nonsense'))
  assert.ok(validateTopLevelKey('__proto__'))
})

test('readWorkflowFile reports absence without throwing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wf-rw-'))
  try {
    const missing = readWorkflowFile(dir, parseWorkflowYaml)
    assert.equal(missing.present, false)
    assert.ok(missing.path.endsWith('workflow.yml'))

    mkdirSync(join(dir, '.dsh'), { recursive: true })
    writeFileSync(join(dir, '.dsh', 'workflow.yml'), 'tier: minimal\n', 'utf8')
    const present = readWorkflowFile(dir, parseWorkflowYaml)
    assert.equal(present.present, true)
    assert.equal(present.value.tier, 'minimal')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// tool-result JSON safety
// ---------------------------------------------------------------------------

test('toLosslessJson removes every undefined from a payload', () => {
  // Regression: `value: undefined` in the read path made the host reject the whole
  // result with "returned invalid output: value is not lossless JSON".
  const sanitised = toLosslessJson({
    ok: true,
    value: undefined,
    hint: undefined,
    nested: { a: undefined, b: 1 },
    list: [1, undefined, 2],
  })
  assert.equal(JSON.stringify(sanitised).includes('undefined'), false, 'no undefined may survive')
  assert.ok(!Object.hasOwn(sanitised, 'value'), 'an undefined member is dropped')
  assert.ok(!Object.hasOwn(sanitised.nested, 'a'))
  assert.equal(sanitised.nested.b, 1)
  assert.equal(sanitised.list[1], null, 'an undefined array slot becomes null')
  // The strongest statement: the payload must survive a JSON round trip unchanged.
  assert.deepEqual(JSON.parse(JSON.stringify(sanitised)), sanitised)
})

test('toLosslessJson nulls non-finite numbers and survives cycles', () => {
  const cyclic = { name: 'x' }
  cyclic.self = cyclic
  const sanitised = toLosslessJson({ n: Number.NaN, i: Number.POSITIVE_INFINITY, cyclic })
  assert.equal(sanitised.n, null)
  assert.equal(sanitised.i, null)
  assert.equal(sanitised.cyclic.self, '[circular]')
  assert.deepEqual(JSON.parse(JSON.stringify(sanitised)), sanitised)
})
