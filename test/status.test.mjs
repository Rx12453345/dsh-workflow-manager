/**
 * The STATUS and DIAGNOSTIC surfaces.
 *
 * WHY THIS FILE EXISTS — round 5's blocker survived because nothing tested these.
 * `buildStatus` / `renderStatus` had ZERO references anywhere under `test/`, and the
 * smoke test rendered a status only with a valid configuration. So a reachable crash
 * went unnoticed:
 *
 *     renderStatus → (evaluator.mustPass ?? []).join(', ')
 *
 * A project file containing `mustPass: correctness` (a plain string) made
 * `workflow_status` throw `TypeError: ...join is not a function`. The host converts a
 * throwing `render` into an opaque projection error, so the model received no status at
 * all — on the plugin's primary read tool.
 *
 * The same value was writable through the plugin's own writer: `validateSettingValue`
 * had no rule for the bare `evaluator` path (a member of `WRITABLE_TOP_LEVEL`), so it
 * fell through to `accept` and `workflow_set path=evaluator value={mustPass:'…'}`
 * persisted it. "A value the gate rejects can never be written" was therefore false.
 *
 * `configWarnings` is covered here for the same reason: it never validated `bar` or
 * `maxRounds`, so `workflow_status` printed `bar=abc` as if the gate were fine.
 *
 * Run with `node --test test/`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { findChromium, gridStyles, measureLayout, sourceConst } from '../tooling/layout-styles.mjs'
import { skipInSandbox } from './sandbox.mjs'

import {
  buildStatus,
  buildToolDefinition as buildStatusToolDefinition,
  buildInitToolDefinition,
  buildSetToolDefinition,
  buildReviewToolDefinition,
  buildAdvanceToolDefinition,
  resolveWorkspace,
  renderStatus,
  validateSettingValue,
  runSet,
  runInit,
  probeServices,
} from '../lib/tools.js'
import { buildGcToolDefinition } from '../lib/gc.js'
import { configWarnings, resolveConfig, DEFAULT_CONFIG, MAX_SUBAGENT_DEPTH, APPROVAL_STRENGTHS, RISK_LEVELS } from '../lib/config.js'
import { probeProject, parseWorkflowYaml } from '../lib/project.js'
import { checkBar, checkMaxRounds, readEvaluatorGate, BAR_MIN, BAR_MAX } from '../lib/gate.js'
import { readApprovalGate, FAIL_CLOSED_APPROVAL } from '../lib/approval.js'
import { readApprovalForProject } from '../lib/approval-state.js'
import { resolveEffectiveConfig } from '../lib/workflow-file.js'

/** A project directory, optionally with a workflow file already written. */
function makeProject(yaml) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wf-status-'))
  if (yaml !== undefined) {
    mkdirSync(join(dir, '.dsh'), { recursive: true })
    writeFileSync(join(dir, '.dsh', 'workflow.yml'), yaml, 'utf8')
  }
  return dir
}

const execFor = dir => ({ agent: { id: 'agent-1', session: { header: { cwd: dir } } } })

/** The plugin root, for source-level pins of the browser bundle. */
const REPO = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

/** Services stub: a present subagents service so `canReview` is exercised. */
const services = {
  get: name => (name === 'subagents' ? { start: async () => {} } : undefined),
}

/**
 * Every malformed `evaluator` section a hand-edited file can produce.
 *
 * This is the shape that crashed `workflow_status`, and it is the shape the writer used
 * to accept.
 */
const MALFORMED_EVALUATOR = [
  'evaluator:\n  mustPass: correctness\n',
  'evaluator:\n  mustPass: {}\n',
  'evaluator:\n  mustPass: 7\n',
  'evaluator:\n  mustPass: true\n',
  'evaluator:\n  dimensions: correctness\n',
  'evaluator:\n  dimensions: 3\n',
  'evaluator:\n  bar: abc\n',
  'evaluator:\n  bar: "8"\n',
  'evaluator:\n  maxRounds: 0\n',
  'evaluator:\n  mustPass:\n    - [correctness]\n    - build\n',
  'evaluator: nope\n',
  'evaluator:\n  bar: true\n',
]

test('renderStatus never throws for any hand-editable evaluator value', () => {
  for (const yaml of MALFORMED_EVALUATOR) {
    const dir = makeProject(yaml)
    try {
      const status = buildStatus({ exec: execFor(dir), config: resolveConfig({}), services })
      let text
      try {
        text = renderStatus(status)
      } catch (error) {
        assert.fail(`renderStatus threw for ${JSON.stringify(yaml)}: ${error?.message ?? error}`)
      }
      assert.equal(typeof text, 'string', `renderStatus returned a non-string for ${JSON.stringify(yaml)}`)
      assert.ok(text.length > 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('status accepts startActivation and prefers a service-shaped property over a get facade', () => {
  // THE CURRENT HOST. `@deepseek-ai/dsh-subagent` exposes `startActivation`, not `start`.
  // A report that only recognized `start` said "review route: ... start=NO" and disabled
  // reviews even though the service was present and could run one.
  const dir = makeProject('tier: standard\n')
  try {
    const service = { async startActivation() {} }
    const activationOnly = { get: name => (name === 'subagents' ? service : undefined) }
    const status = buildStatus({ exec: execFor(dir), config: resolveConfig({}), services: activationOnly })
    assert.equal(status.subagent.available, true)
    assert.equal(status.subagent.reviewRoute.method, 'startActivation')
    assert.equal(status.subagent.reviewRoute.probeHasStart, true)
    assert.equal(status.effectiveConfig.evaluator.canReview, true)
    assert.match(renderStatus(status), /probe service start=yes/)

    // `get` can return a facade that is not the service; the property still carries the
    // real one. Resolution must be by shape, not by which route returned a non-null value.
    const facade = { prompt() {} }
    const facadeThenProperty = {
      get: name => (name === 'subagents' ? facade : undefined),
      subagents: service,
    }
    const fallback = buildStatus({ exec: execFor(dir), config: resolveConfig({}), services: facadeThenProperty })
    assert.equal(fallback.subagent.available, true)
    assert.equal(fallback.subagent.reviewRoute.method, 'startActivation')
    assert.equal(fallback.effectiveConfig.evaluator.canReview, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a broken gate is REPORTED in the status, not silently printed as healthy', () => {
  // The dangerous state is a project that looks configured while every review is
  // refused. The status must say so.
  for (const yaml of ['evaluator:\n  bar: abc\n', 'evaluator:\n  mustPass: correctness\n']) {
    const dir = makeProject(yaml)
    try {
      const text = renderStatus(buildStatus({ exec: execFor(dir), config: resolveConfig({}), services }))
      assert.match(
        text,
        /GATE BROKEN/,
        `the status did not flag ${JSON.stringify(yaml)}; got:\n${text}`,
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
})

test('a healthy gate is not reported as broken', () => {
  const dir = makeProject('evaluator:\n  bar: 9\n  maxRounds: 2\n')
  try {
    const text = renderStatus(buildStatus({ exec: execFor(dir), config: resolveConfig({}), services }))
    assert.doesNotMatch(text, /GATE BROKEN/, text)
    assert.match(text, /bar=9/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('renderStatus survives a project with no workflow file at all', () => {
  const dir = makeProject(undefined)
  try {
    const text = renderStatus(buildStatus({ exec: execFor(dir), config: resolveConfig({}), services }))
    assert.equal(typeof text, 'string')
    assert.match(text, /NOT opted in|inert/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('status resolves review availability the same way workflow_review does', () => {
  // A1'S OTHER HALF. The status report must answer "would workflow_review find subagents
  // right now", not merely "did the mount probe see it". The stub below exposes the service
  // ONLY through get, which is the shape that produced "status: available / review:
  // unavailable" on a real host.
  const dir = makeProject('tier: standard\n')
  try {
    const status = buildStatus({ exec: execFor(dir), config: resolveConfig({}), services })
    assert.equal(status.subagent.available, true)
    assert.equal(status.subagent.probeAvailable, true)
    assert.equal(status.effectiveConfig.evaluator.canReview, true)
    assert.match(renderStatus(status), /review route: subagents resolved at call time/)

    const missing = buildStatus({ exec: execFor(dir), config: resolveConfig({}), services: undefined })
    assert.equal(missing.subagent.available, false)
    assert.equal(missing.effectiveConfig.evaluator.canReview, false)
    assert.match(renderStatus(missing), /independent review: NOT runnable/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// configWarnings must surface an unusable gate
// ---------------------------------------------------------------------------

test('configWarnings reports an unusable bar or maxRounds', () => {
  for (const evaluator of [{ bar: 'abc' }, { bar: Number.NaN }, { bar: -1 }, { maxRounds: 0 }, { maxRounds: '3' }]) {
    const warnings = configWarnings(resolveConfig({ evaluator }))
    assert.ok(
      warnings.some(w => /evaluator gate unusable/.test(w)),
      `no gate warning for ${JSON.stringify(evaluator)}: ${JSON.stringify(warnings)}`,
    )
  }
})

test('configWarnings reports a malformed dimension list instead of going silent', () => {
  // The old bespoke check was gated on `Array.isArray`, so it went SILENT exactly when
  // the value was malformed — the opposite of its purpose.
  for (const evaluator of [
    { mustPass: 'correctness' },
    { mustPass: { a: 1 } },
    { dimensions: 'correctness' },
    { mustPass: [['correctness']] },
    { dimensions: [] },
  ]) {
    const warnings = configWarnings(resolveConfig({ evaluator }))
    assert.ok(
      warnings.some(w => /evaluator gate unusable/.test(w)),
      `no gate warning for ${JSON.stringify(evaluator)}`,
    )
  }
})

test('configWarnings is silent for a healthy gate', () => {
  const warnings = configWarnings(resolveConfig({ evaluator: { bar: 8, maxRounds: 3 } }))
  assert.equal(
    warnings.filter(w => /evaluator gate unusable/.test(w)).length,
    0,
    JSON.stringify(warnings),
  )
})

test('an empty mustPass is honoured by the WARNING helper', () => {
  // `z.array(z.string())` in the exported schema permits `[]`, and "no veto dimensions"
  // is coherent, so a schema-legal clear must not be reported as a broken gate.
  const warnings = configWarnings(resolveConfig({ evaluator: { mustPass: [] } }))
  assert.equal(
    warnings.filter(w => /evaluator gate unusable/.test(w)).length,
    0,
    JSON.stringify(warnings),
  )
})

test('an empty mustPass is honoured END TO END, not just by the warning helper', () => {
  // REGRESSION — an independent review found this by running the real path, while the
  // suite was green. `readEvaluatorGate` passed `{ allowEmpty: true }` for `mustPass` and
  // `decideVerdict` did not, so a schema-legal `mustPass: []` made EVERY review fail with
  // "an empty list, so no dimension would ever be scored" — while `configWarnings` and
  // `workflow_status` both reported the project healthy.
  //
  // The previous version of this test checked ONLY `configWarnings`, so it asserted the
  // broken property at a layer where it happened to hold. A test for a claim about
  // reviews has to run a review.
  const reviewDir = makeProject('evaluator:\n  mustPass: []\n')
  try {
    const text = renderStatus(buildStatus({ exec: execFor(reviewDir), config: resolveConfig({}), services }))
    assert.doesNotMatch(text, /GATE BROKEN/, 'the status must not call an empty veto set broken')
  } finally {
    rmSync(reviewDir, { recursive: true, force: true })
  }
})

test('the writer and the whole-section rule agree about an empty mustPass', () => {
  // Two writers of one setting must not disagree: `workflow_set path=evaluator
  // value={mustPass: []}` goes through `readEvaluatorGate` (which accepts it), while
  // `workflow_set path=evaluator.mustPass value=[]` went through the per-key rule (which
  // refused it). This pins both to the same answer.
  assert.equal(validateSettingValue(['evaluator', 'mustPass'], []), null, 'per-key: mustPass [] is acceptable')
  assert.equal(validateSettingValue(['evaluator'], { mustPass: [] }), null, 'whole-section: same answer')

  // ...and `dimensions: []` is refused by both, because nothing could ever be scored.
  assert.ok(validateSettingValue(['evaluator', 'dimensions'], []), 'per-key: dimensions [] must be refused')
  assert.ok(
    validateSettingValue(['evaluator'], { dimensions: [] }),
    'whole-section: dimensions [] must be refused',
  )
})

// ---------------------------------------------------------------------------
// the whole-section write must not bypass the per-key rules
// ---------------------------------------------------------------------------

test('a whole-section evaluator write is validated as an evaluator section', () => {
  // REGRESSION: `evaluator` is in WRITABLE_TOP_LEVEL, but validateSettingValue had no
  // rule for the bare path, so it fell through to ACCEPT. `workflow_set path=evaluator
  // value={mustPass:'correctness'}` therefore persisted a value that the per-key rule
  // `evaluator.mustPass` correctly refuses — and that then crashed workflow_status.
  const bad = [
    { mustPass: 'correctness' },
    { mustPass: 42 },
    { dimensions: {} },
    { bar: 'abc' },
    { bar: [] },
    { maxRounds: 0 },
    { mustPass: [['correctness']] },
  ]
  for (const value of bad) {
    const error = validateSettingValue(['evaluator'], value)
    assert.ok(error, `the whole-section write accepted ${JSON.stringify(value)}`)
  }

  // A legitimate section write must still be allowed.
  assert.equal(validateSettingValue(['evaluator'], { bar: 9, maxRounds: 2 }), null)
  assert.equal(validateSettingValue(['evaluator'], { mustPass: ['scope'] }), null)
  assert.equal(validateSettingValue(['evaluator'], null), null, 'unset must remain allowed')
})

test('other section writes still have to be objects', () => {
  // A scalar replacing a section would crash every reader of it.
  for (const section of ['modules', 'subagent', 'approval', 'context']) {
    assert.ok(validateSettingValue([section], 'nope'), `${section} accepted a string`)
    assert.ok(validateSettingValue([section], 7), `${section} accepted a number`)
  }
})

test('the whole-section bypass is closed end to end', () => {
  const dir = makeProject('tier: standard\n')
  try {
    const exec = execFor(dir)
    const refused = runSet({
      exec,
      config: resolveConfig({}),
      path: 'evaluator',
      value: { mustPass: 'correctness' },
      hasValue: true,
    })
    assert.equal(refused.ok, false, 'the section write was accepted')
    assert.match(String(refused.error), /evaluator/)

    // And the file must be untouched by the refusal.
    const after = probeProject(dir)
    assert.equal(after.detected, true)
    const status = renderStatus(buildStatus({ exec, config: resolveConfig({}), services }))
    assert.doesNotMatch(status, /GATE BROKEN/, 'the refused write still reached the file')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a full init plus a legitimate section write leaves a usable, renderable project', () => {
  const dir = makeProject(undefined)
  try {
    const exec = execFor(dir)
    const init = runInit({ exec, config: resolveConfig({}), requested: { tier: 'standard' } })
    assert.equal(init.ok, true, JSON.stringify(init))

    const write = runSet({
      exec,
      config: resolveConfig({}),
      path: 'evaluator',
      value: { bar: 9, maxRounds: 2 },
      hasValue: true,
    })
    assert.equal(write.ok, true, JSON.stringify(write))

    const text = renderStatus(buildStatus({ exec, config: resolveConfig({}), services }))
    assert.match(text, /bar=9/)
    assert.doesNotMatch(text, /GATE BROKEN/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('probeServices does not mistake a throwing probe for a present service', () => {
  // A regression guard for an early bug: a probe that threw was read as "present".
  const hostile = {
    get: name => {
      if (name === 'subagents') throw new Error('boom')
      return undefined
    },
  }
  const { availability } = probeServices(hostile)
  assert.notEqual(availability.subagents, true, 'a throwing get() must not read as present')
})

// ---------------------------------------------------------------------------
// the settings panel's bar rule must mirror the gate's
// ---------------------------------------------------------------------------
//
// The panel cannot import `lib/gate.js` (a browser bundle cannot pull in a host module),
// so it re-implements the rule. That is a divergence risk, and an independent review
// correctly flagged that claiming "every surface uses gate.js" was inaccurate. Rather
// than leave it as an assertion in a comment, this test pins the property that matters:
// the panel cannot write a value the gate would refuse.
//
// The panel's logic, transcribed: trim, ignore an empty field, otherwise `Number(raw)`
// must be finite and within [0, 10].
function panelWouldWrite(raw) {
  const trimmed = String(raw).trim()
  if (trimmed === '') return undefined
  const next = Number(trimmed)
  if (!Number.isFinite(next) || next < 0 || next > 10) return undefined
  return next
}

test('every value the settings panel writes is one the gate accepts', () => {
  // A number input yields strings; these are the shapes a browser can hand to onChange.
  const inputs = [
    '', '   ', '0', '5', '8', '8.5', '10', '10.5', '11', '-1', '-0', 'abc', '8abc', '1e2',
    '0x8', 'NaN', 'Infinity', '-Infinity', '.5', '1.', '00', '+8', ' ', ' 8 ', '\t8\n',
  ]
  for (const raw of inputs) {
    const written = panelWouldWrite(raw)
    if (written === undefined) continue
    const accepted = checkBar(written)
    assert.equal(
      accepted.ok,
      true,
      `the panel would write ${JSON.stringify(raw)} as bar ${written}, which the gate refuses (${accepted.detail})`,
    )
  }
})

test('the panel refuses the empty input rather than coercing it to zero', () => {
  // `Number('')` is 0 — a legal bar that disables every veto. Clearing the field must
  // mean "leave it", not "set it to the most permissive legal gate".
  assert.equal(panelWouldWrite(''), undefined)
  assert.equal(panelWouldWrite('   '), undefined, 'whitespace is not a bar either')
})

test('the panel refuses out-of-range input, which min/max alone does not', () => {
  // `min`/`max` attributes do not constrain onChange; this was a real defect.
  assert.equal(panelWouldWrite('11'), undefined)
  assert.equal(panelWouldWrite('-1'), undefined)
  assert.equal(panelWouldWrite('10.5'), undefined)
})

// ---------------------------------------------------------------------------
// the settings panel's NESTED module writes must mirror the host's writer
// ---------------------------------------------------------------------------
//
// `modules` is the heart of the tier system and no `form.set` can reach it: a nested field
// needs the atomic op list. The panel therefore builds `{ op:'set', path:['modules', key],
// value }` itself, and `key` comes from the SNAPSHOT rather than from a list in the bundle —
// so the same divergence guard the bar rule has applies here, plus one for the key list.
//
// The helpers are lifted out of `lib/client.js` and evaluated, the way
// `tooling/simulate-client-scan.mjs` lifts the shipped scanner: a transcription of the panel
// would only pin the copy that drifts away from the shipped one.

/**
 * Slice a top-level `function name(...) {...}` out of the browser bundle by brace matching.
 *
 * The panel cannot be imported here — its entry is `window.__ModuleLoader__.load({…})` — so
 * this is the only way to run the shipped helper rather than a re-implementation of it.
 */
function clientFunction(source, name) {
  const start = source.indexOf(`function ${name}(`)
  assert.ok(start >= 0, `lib/client.js no longer declares ${name}()`)
  let depth = 0
  for (let i = source.indexOf('{', start); i >= 0 && i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  assert.fail(`could not find the end of ${name}()`)
}

/** The panel's own pure helpers, evaluated from the shipped bundle. */
function panelModuleHelpers() {
  return panelHelpers()
}

/**
 * The full initializer of a shipped `const NAME = …`, including a CALL wrapper.
 *
 * `sourceConst` returns only the rest of the line for an initializer that is neither a literal
 * nor a quoted/templated string — exactly right for `const BAR_MIN = 0`, and unusable for
 * `const FAIL_CLOSED_APPROVAL = Object.freeze({ … })`, where the multi-line object is an
 * ARGUMENT. This finishes that statement by balancing the parentheses; for every other shape it
 * is `sourceConst`. Quotes are not tracked, which is sound for the constants lifted here (no
 * lifted initializer contains a parenthesis inside a string) and is asserted by the callers
 * failing loudly if that ever stops being true.
 *
 * @param source - the bundle text.
 * @param name - the const to lift.
 * @returns the initializer source.
 */
function liftedConst(source, name) {
  const marker = `const ${name} = `
  const start = source.indexOf(marker)
  assert.ok(start >= 0, `lib/client.js no longer declares ${name}`)
  const head = sourceConst(source, name)
  if (!/^[\w$.]+\s*\(/.test(head)) return head
  const from = start + marker.length
  let depth = 0
  for (let i = source.indexOf('(', from); i >= 0 && i < source.length; i += 1) {
    if (source[i] === '(') depth += 1
    else if (source[i] === ')') {
      depth -= 1
      if (depth === 0) return source.slice(from, i + 1)
    }
  }
  assert.fail(`could not find the end of the ${name} initializer`)
}

/**
 * Every pure helper `lib/client.js` ships, evaluated from the shipped source.
 *
 * The list is EXPLICIT because each name is looked up by `function <name>(`; a helper that is
 * renamed must be renamed here too, which is the point — a silently missing helper would make
 * the mirror tests below vacuous.
 */
function panelHelpers() {
  const source = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
  const names = [
    'moduleKeys',
    'fieldOps',
    'moduleOps',
    'stringList',
    'listText',
    'listValue',
    'intValue',
    'prunedMustPass',
    'toggledMustPass',
    'panelVisible',
    'panelLabel',
    // the conversation-page tab (PROJECT scope) — pure helpers only, so they can be
    // lifted out of the bundle and driven without a browser.
    'paneWidthOf',
    'pageMargin',
    'conversationContentStyle',
    'firstLine',
    'projectFileKeys',
    'projectFileResult',
    'projectFileAbsent',
    'projectFailureText',
    // the EFFECTIVE-CONFIGURATION mirror — the whole point of these being functions rather
    // than inline render code is that the host's own resolution can be run beside them.
    'isConfigObject',
    'cloneConfigValue',
    'mergeConfigValue',
    'projectEffectiveConfig',
    'configPathValue',
    'configValuesEqual',
    'projectValueText',
    'projectLeafSource',
    'projectConfigLeaves',
    'parseProjectYaml',
    'projectApprovalGate',
    'projectEvaluatorProblems',
    'projectDefaultsState',
    'projectDefaultsController',
    'projectConfigView',
    'projectRowText',
    'configLayerBadge',
  ]
  // The constants the lifted helpers read, in DEPENDENCY ORDER — a lifted badge style spreads
  // another lifted style, so these declarations cannot be reordered freely. `sourceConst` (the
  // same reader `tooling/measure-grid-layout.mjs` uses) is used instead of a single-line regex
  // because a multi-line object literal is exactly what a badge style is.
  const constNames = [
    'DIAG',
    'ENTRY_ID',
    'TAB_MARGIN_RATIO',
    'TAB_MARGIN_MIN_PX',
    'TAB_MAX_WIDTH_PX',
    'TAB_GUTTER_PX',
    'tabMonoStyle',
    'tabBadgeStyle',
    'configLayerBadgeStyle',
    'configProjectBadgeStyle',
    'configRefusedBadgeStyle',
    'APPROVAL_STRENGTH_VALUES',
    'RISK_LEVEL_VALUES',
    'BAR_MIN',
    'BAR_MAX',
    'FAIL_CLOSED_APPROVAL',
  ]
  const constants = constNames.map(name => `const ${name} = ${liftedConst(source, name)}`)
  return new Function(
    `${constants.join('\n')}\n${names.map(name => clientFunction(source, name)).join('\n')}\n` +
      `return { ${names.join(', ')}, ${constNames.join(', ')} }`,
  )()
}

test('every nested module op the panel builds is one the host writer accepts', () => {
  const { moduleOps } = panelModuleHelpers()
  // Over the SHIPPED default key set, so this guard grows with the configuration: a module
  // added to `lib/config.js` is exercised here without editing this test.
  for (const key of Object.keys(DEFAULT_CONFIG.modules)) {
    for (const value of [true, false]) {
      const ops = moduleOps(key, value)
      assert.deepEqual(ops, [{ op: 'set', path: ['modules', key], value }])
      for (const op of ops) {
        assert.equal(op.op, 'set', `the panel builds a non-set op: ${JSON.stringify(op)}`)
        // The mirror: the same dotted path and boolean rule `workflow_set
        // path=modules.<key>` goes through. `validateSettingValue` would refuse anything the
        // panel handed it that the file's own writer would refuse.
        assert.equal(
          validateSettingValue(op.path, op.value),
          null,
          `the panel would submit ${JSON.stringify(op)}, which the writer refuses`,
        )
      }
    }
  }
})

test('the panel derives its module list from the config instead of hardcoding keys', () => {
  const { moduleKeys } = panelModuleHelpers()

  // The argument decides the answer. A hardcoded list cannot satisfy both of these.
  assert.deepEqual(moduleKeys({ planner: true, isolation: false }), ['planner', 'isolation'])
  assert.deepEqual(moduleKeys(DEFAULT_CONFIG.modules), Object.keys(DEFAULT_CONFIG.modules))

  // The guard mirrors the host's section rule (`validateSettingValue` refuses a scalar or an
  // array where a section is expected): a hand-edited `modules: nope` renders no rows.
  for (const notASection of [null, undefined, 'nope', 7, [], true]) {
    assert.deepEqual(moduleKeys(notASection), [], `${JSON.stringify(notASection)} must yield no rows`)
  }
})

test('the summary render path stays a plain one-line string', () => {
  // The plugin manager renders this registration TWICE per row: once with `view: "summary"`
  // to fill the row's description line, and once with `view: "page"` for the body. A
  // registration that ignored `view` would paint the whole form into the description line.
  // This pins the early return that prevents it — the one rendering contract that can be
  // checked without a running DSH window.
  const source = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
  assert.match(
    source,
    /if \(props\?\.view === 'summary'\) return t\('description'\)/,
    'the summary path must return the one-line description before any body is built',
  )
  assert.match(source, /description: '[^']+'/, 'the dictionaries must define that one-liner')
})

test('the panel routes each switch through the nested op, not through a copied key list', () => {
  // Behaviour alone cannot tell a derived list from a cleverly written literal, and the two
  // live wiring lines are what make the derivation reach the UI. This pins them the way
  // `approval.test.mjs` pins the panel's live warning branch.
  const source = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
  assert.match(
    source,
    /const moduleSwitchNames = moduleKeys\(modulesValue\)/,
    'the rows must be enumerated from the snapshot section',
  )
  assert.match(
    source,
    /form\.mutate\(moduleOps\(key, next\)\)/,
    'every module switch must be written as a nested mutate op',
  )
  assert.match(
    source,
    /onChange: event => writeModule\(name, event\.target\.checked\)/,
    'the checkbox must pass its own key, not a literal index or a fixed key',
  )

  // LOST UPDATE — an independent review found this by driving the rendered component: the
  // dedicated context-isolation control used to write the WHOLE `modules` section from the
  // render it was built in, so clicking a module row and then that control inside one host
  // round-trip reverted the row. `isolation` is also a derived row, so every writer of a
  // `modules.*` key must be a one-key nested op; a whole-section write from a stale render is
  // the only way this page can lose a sibling's value.
  assert.match(
    source,
    /onChange: event => writeModule\('isolation', event\.target\.checked\)/,
    'the context-isolation control must use the same one-key nested op',
  )
  assert.ok(
    !source.includes("write('modules'"),
    "no control may write the whole modules section; that reverts a sibling's fresh value",
  )
})

// ---------------------------------------------------------------------------
// B5.2 — every nested field the panel now edits goes through ONE op builder
// ---------------------------------------------------------------------------
//
// The reviewer rated the remaining sibling-field lost update MAJOR and reachable:
// `write('approval', { ...section('approval'), strength })` read the section at RENDER time, so
// `approval.strength` + `approval.riskThreshold` (and `evaluator.bar` + `evaluator.independent`)
// each reverted the other when clicked inside one host round-trip. `modules.isolation` had been
// fixed with a single-key op; the fix is now general (`fieldOps` + `writeField`) and these tests
// pin both halves: the op the builder produces is one the host writer accepts, and NO control
// builds a section object again.

test('every nested field op the panel builds is one the host writer accepts', () => {
  const { fieldOps } = panelHelpers()
  // The value vocabulary each control can produce, taken from the HOST's own enums where one
  // exists, so a new strength or risk level is exercised here without editing this table.
  const CASES = [
    ['approval', 'strength', [...APPROVAL_STRENGTHS]],
    ['approval', 'riskThreshold', [...RISK_LEVELS]],
    ['approval', 'exemptTools', [[], ['workflow_status', 'workflow_gc']]],
    ['evaluator', 'bar', [0, 5, 8, 10, 8.5]],
    ['evaluator', 'independent', [true, false]],
    ['evaluator', 'dimensions', [['correctness'], ['correctness', 'build']]],
    ['evaluator', 'mustPass', [[], ['correctness'], ['build', 'scope']]],
    ['subagent', 'maxDepth', [1, 2]],
    ['subagent', 'maxActiveSubagents', [1, 8, 64]],
    ['retireCheck', 'enabled', [true, false]],
    ['retireCheck', 'everyDays', [1, 30]],
    ['retireCheck', 'autoSuggest', [true, false]],
  ]
  for (const [section, key, values] of CASES) {
    for (const value of values) {
      const ops = fieldOps(section, key, value)
      assert.deepEqual(ops, [{ op: 'set', path: [section, key], value }])
      for (const op of ops) {
        assert.equal(op.op, 'set', `the panel builds a non-set op: ${JSON.stringify(op)}`)
        // The mirror: the same dotted path and value rule `workflow_set path=<section>.<key>`
        // goes through. Anything the panel handed the writer that the file's own writer refuses
        // would be a panel-only way to persist a broken setting.
        assert.equal(
          validateSettingValue(op.path, op.value),
          null,
          `the panel would submit ${JSON.stringify(op)}, which the writer refuses`,
        )
      }
    }
  }
})

test('no control writes a whole section from a value read at render time', () => {
  // The REGRESSION pin for the lost update. A section spread built from the render's own value
  // is the only way this page can revert a sibling field's fresh write, and every nested control
  // now goes through `writeField`/`writeOps` instead.
  const source = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')

  for (const section of ['approval', 'evaluator', 'subagent', 'retireCheck']) {
    assert.ok(
      !source.includes(`write('${section}'`),
      `a control still writes the whole ${section} section; that reverts a sibling's fresh value`,
    )
  }

  // ...and the four fields that used to be written that way really are routed through the
  // one-key helper, so this cannot pass by deleting the controls altogether.
  for (const [section, key] of [
    ['approval', 'strength'],
    ['approval', 'riskThreshold'],
    ['evaluator', 'bar'],
    ['evaluator', 'independent'],
  ]) {
    assert.match(
      source,
      new RegExp(`writeField\\('${section}', '${key}'`),
      `${section}.${key} must be written as a single-key nested op`,
    )
  }
})

// ---------------------------------------------------------------------------
// B5.2 — the list rules (MIRRORS of gate.js `readStringList`)
// ---------------------------------------------------------------------------

test('the panel never writes the empty dimension list the gate refuses', () => {
  const { listValue } = panelHelpers()

  // `readStringList('evaluator.dimensions', …, { allowEmpty: false })` refuses `[]` because
  // nothing could ever be scored, so a cleared field must mean "leave it".
  for (const raw of ['', '   ', ',', ' , , ', '\t']) {
    assert.equal(
      listValue(raw, { allowEmpty: false }),
      undefined,
      `${JSON.stringify(raw)} must not produce an empty dimension list`,
    )
  }

  // Every list it DOES write is one the writer accepts, and none is empty.
  for (const raw of ['correctness', ' correctness , build ', 'a,b,c', 'a,,b']) {
    const next = listValue(raw, { allowEmpty: false })
    assert.ok(Array.isArray(next) && next.length > 0, `${JSON.stringify(raw)} produced ${JSON.stringify(next)}`)
    assert.ok(next.every(entry => typeof entry === 'string'), 'every entry must be a string')
    assert.equal(validateSettingValue(['evaluator', 'dimensions'], next), null)
  }
  assert.deepEqual(listValue(' correctness , build ', { allowEmpty: false }), ['correctness', 'build'])
})

test('an empty veto list is honoured, not refused', () => {
  const { listValue, toggledMustPass } = panelHelpers()

  // `mustPass` is the one list where an empty value is a deliberate, schema-legal statement
  // ("no veto dimensions", average-only grading), and `readStringList` is called with
  // `allowEmpty: true` for it. Unchecking the last box is how a user gets there.
  assert.deepEqual(listValue('', { allowEmpty: true }), [])
  assert.equal(validateSettingValue(['evaluator', 'mustPass'], []), null)
  assert.deepEqual(toggledMustPass(['correctness'], ['correctness', 'build'], 'correctness', false), [])
  assert.equal(validateSettingValue(['evaluator', 'mustPass'], []), null)
})

test('the panel never flattens a mixed list into a narrower one', () => {
  const { stringList, listText } = panelHelpers()

  // gate.js refuses a mixed list rather than filtering it, because filtering silently NARROWED
  // the veto set (a listed veto dimension disappeared and a review passed). The panel's reader
  // must not undo that by turning `[['correctness'], 'build']` into `'correctness, build'` text a
  // later edit would rewrite as two strings.
  const mixed = [['correctness'], 'build', 'regressions']
  assert.deepEqual(stringList(mixed), [], 'a mixed list is unusable, never filtered')
  assert.equal(listText(mixed), '', 'a mixed list must not be rendered as if it were clean')

  for (const notAList of ['correctness', 7, true, null, undefined, { a: 1 }, [[]]]) {
    assert.deepEqual(stringList(notAList), [], `${JSON.stringify(notAList)} must not read as a list`)
  }
  assert.deepEqual(stringList(['a', 'b']), ['a', 'b'])
  const input = ['a']
  assert.notStrictEqual(stringList(input), input, 'the reader must not hand back the live array')
})

// ---------------------------------------------------------------------------
// B5.2 — the veto set stays a subset of the scored set
// ---------------------------------------------------------------------------
//
// `readEvaluatorGate` refuses a whole gate whose `mustPass` names a dimension `dimensions` does
// not score: every review would then fail with an explanation instead of a score. The panel
// therefore cannot write the two independently — a dimension that leaves `dimensions` leaves the
// veto set in the same atomic op list, and the veto checkboxes are built from `dimensions`.

test('the veto set the panel writes always names only scored dimensions', () => {
  const { prunedMustPass, toggledMustPass } = panelHelpers()
  const dimensions = ['correctness', 'build', 'tests']

  // Shrinking `dimensions` prunes the veto list carried by the SAME atomic write...
  assert.deepEqual(prunedMustPass(['correctness', 'build'], ['build', 'tests']), ['build'])
  assert.deepEqual(prunedMustPass(['correctness', 'build'], []), [])

  // ...and the host's whole-section reader accepts exactly the pair that write produces.
  for (const nextDimensions of [['build', 'tests'], ['tests'], dimensions]) {
    const kept = prunedMustPass(['correctness', 'build'], nextDimensions)
    assert.ok(kept.every(dimension => nextDimensions.includes(dimension)))
    assert.equal(
      validateSettingValue(['evaluator'], { dimensions: nextDimensions, mustPass: kept }),
      null,
      `the pair { dimensions: ${JSON.stringify(nextDimensions)}, mustPass: ${JSON.stringify(kept)} } was refused`,
    )
  }

  // The prune to [] is a coherent veto set, but the DIMENSIONS side of that pair is not:
  // `dimensions: []` scores nothing, and the panel's `listValue(raw, { allowEmpty: false })`
  // guard is what keeps this pair from ever being built.
  assert.deepEqual(prunedMustPass(['correctness'], []), [])
  assert.ok(validateSettingValue(['evaluator'], { dimensions: [], mustPass: [] }))

  // A superset IS refused, which is why the pruning op is required rather than optional.
  assert.ok(validateSettingValue(['evaluator'], { dimensions: ['tests'], mustPass: ['correctness'] }))

  // A checkbox can only name an offered dimension, and the result keeps the dimensions' order.
  assert.deepEqual(toggledMustPass(['correctness'], dimensions, 'build', true), ['correctness', 'build'])
  assert.deepEqual(toggledMustPass(['build', 'correctness'], dimensions, 'build', true), ['correctness', 'build'])
  // An entry the dimensions no longer list is dropped rather than written into a refused gate.
  assert.deepEqual(toggledMustPass(['stale', 'correctness'], dimensions, 'build', true), ['correctness', 'build'])
  for (const on of [true, false]) {
    const next = toggledMustPass(['correctness'], dimensions, 'build', on)
    assert.equal(validateSettingValue(['evaluator'], { dimensions, mustPass: next }), null)
  }
})

// ---------------------------------------------------------------------------
// B5.2 — the integer controls mirror the writer's rules
// ---------------------------------------------------------------------------

test('the whole-number controls cannot produce a value the writer refuses', () => {
  const { intValue } = panelHelpers()

  // subagent.maxDepth: an integer in [1, MAX_SUBAGENT_DEPTH]. The `<select>` offers only those,
  // and `intValue` is the guard that survives the select being replaced by a text field.
  for (const [raw, expected] of [['1', 1], ['2', 2], [' 2 ', 2]]) {
    const next = intValue(raw, 1, MAX_SUBAGENT_DEPTH)
    assert.equal(next, expected)
    assert.equal(validateSettingValue(['subagent', 'maxDepth'], next), null)
  }
  for (const raw of ['3', '0', '-1', '4', '1.5', 'abc', '', '   ', '2abc', '1e2', 'Infinity']) {
    assert.equal(
      intValue(raw, 1, MAX_SUBAGENT_DEPTH),
      undefined,
      `${JSON.stringify(raw)} must not become a maxDepth`,
    )
  }

  // subagent.maxActiveSubagents and retireCheck.everyDays: integers of 1 or more.
  for (const [path, raw, expected] of [
    [['subagent', 'maxActiveSubagents'], '1', 1],
    [['subagent', 'maxActiveSubagents'], '8', 8],
    [['retireCheck', 'everyDays'], '1', 1],
    [['retireCheck', 'everyDays'], '30', 30],
  ]) {
    const next = intValue(raw, 1)
    assert.equal(next, expected)
    assert.equal(validateSettingValue(path, next), null, `${path.join('.')} refused ${next}`)
  }
  // A blank field means "leave it" — the panel writes nothing at all, which is why a cleared
  // number input can never become the most permissive value (the defect the pass-mark input
  // already documents).
  assert.equal(intValue('', 1), undefined, 'a blank field must write nothing, not 0')
  assert.equal(intValue('   ', 1), undefined)

  for (const [path, raw, asValue] of [
    [['subagent', 'maxActiveSubagents'], '0', 0],
    [['subagent', 'maxActiveSubagents'], '-3', -3],
    [['subagent', 'maxActiveSubagents'], '1.5', 1.5],
    [['retireCheck', 'everyDays'], '0', 0],
    [['retireCheck', 'everyDays'], '2.5', 2.5],
    [['retireCheck', 'everyDays'], 'soon', 'soon'],
  ]) {
    assert.equal(intValue(raw, 1), undefined, `${path.join('.')} must not accept ${JSON.stringify(raw)}`)
    // ...and the writer refuses the same value, so the guard is not a panel-only opinion.
    assert.ok(
      validateSettingValue(path, asValue),
      `${path.join('.')} = ${raw} is not refused by the writer either`,
    )
  }
})

test('the panel states the same delegation ceiling as the host config', () => {
  // The cap lives in `lib/config.js` (`MAX_SUBAGENT_DEPTH`) and `validateSettingValue` binds to
  // it. A browser bundle cannot import it, so the panel repeats the number — and a repeated
  // constant is exactly the divergence this test exists to catch. 1 forbids a delegated
  // orchestrator from starting its reviewer, so 3 must not be offered.
  const source = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
  const captured = /const MAX_DEPTH = (\d+)/.exec(source)
  assert.ok(captured, 'the panel no longer states its own depth ceiling')
  assert.equal(Number(captured[1]), MAX_SUBAGENT_DEPTH, 'the panel ceiling drifted from config.js')
  assert.match(
    source,
    /intValue\(event\.target\.value, 1, MAX_DEPTH\)/,
    'the depth control must be guarded by the mirrored ceiling, not taken raw',
  )
})

test('the panel wires the guarded builders to the live controls', () => {
  // Behaviour alone cannot tell a guarded control from a guarded helper that nothing calls.
  // These are the live wiring lines: the empty-dimensions guard, the prune op that keeps the
  // veto set a subset of the scored set, and the checkbox that can only name an offered
  // dimension. Each mirrors a rule `readEvaluatorGate` enforces.
  const source = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')

  assert.match(
    source,
    /listValue\(event\.target\.value, \{ allowEmpty: false \}\)/,
    'the dimensions control must refuse an empty list rather than hand it to the host',
  )
  assert.match(
    source,
    /const kept = prunedMustPass\(current, next\)/,
    'the dimensions control must prune the veto set it writes alongside',
  )
  assert.match(
    source,
    /\.\.\.fieldOps\('evaluator', 'mustPass', kept\)/,
    'the pruned veto set must ride the SAME atomic write as the dimensions it follows',
  )
  assert.match(
    source,
    /const dimensionNames = stringList\(value\.evaluator\?\.dimensions\)/,
    'the veto checkboxes must be derived from the live scored set',
  )
  assert.match(
    source,
    /toggledMustPass\(mustPassValue, dimensionNames, name, event\.target\.checked\)/,
    'the veto checkbox must toggle through the subset-preserving helper',
  )
})

// ---------------------------------------------------------------------------
// B6. The sidebar panel — the designed-but-never-built second surface
// ---------------------------------------------------------------------------
//
// The design calls the sidebar settings panel a deliverable in three places, and
// nothing implemented it: `showInSidebar` had ZERO readers anywhere in the repo, and
// `lib/components/panel/index.js` carried a comment claiming a `./panel/client` export
// that did not exist. This section pins the two halves that must exist together:
//
//   1. the SLOT CONTRACT, read from the shipped composition rather than guessed —
//      `dsh-client-ui-sidebar/README.md`: "Plugins add an icon component to the
//      root-scoped `sidebar.panellist` list with an `id`, optional `order`, and a
//      string or locale-aware `label`. The same id addresses the component registered
//      in the layout's root-scoped `main` keyed slot; selecting a missing main entry
//      throws without changing the current selection." So `id` is not decoration: it
//      is the primary key shared by the list entry and the body, and one without the
//      other is a click that throws.
//   2. the SWITCH. `showInSidebar` is the panel's own off-ramp. The design's goal is
//      "面板停用而工具照常工作", so the gate must remove exactly the UI and leave the
//      tools alone.

/**
 * The `sidebar.panellist` registration, sliced out of the shipped bundle.
 *
 * A field-by-field regex over the whole file could match members of different
 * registrations; the slice keeps the assertions on the ONE object the sidebar's
 * collector reads (`options.id`, `options.order`, the resolved `label`, the locale).
 */
function sidebarRegistration(source) {
  const start = source.indexOf("name: 'sidebar.panellist'")
  assert.ok(start >= 0, 'lib/client.js no longer registers a sidebar.panellist entry')
  return source.slice(start, start + 400)
}

test('the panel is invisible only when the settings document says so, and never while it is unread', () => {
  const { panelVisible } = panelHelpers()

  // The switch works in both directions.
  assert.equal(panelVisible({ status: 'ready', value: { showInSidebar: false } }), false)
  assert.equal(panelVisible({ status: 'ready', value: { showInSidebar: true } }), true)

  // THE LOAD WINDOW. The controller's first snapshot is idle with no value — that is
  // "not answered yet", not "switched off". A `=== true` test here would hide the entry
  // on every boot for the majority who never touch the switch, and nothing would say so.
  for (const unread of [
    undefined,
    null,
    {},
    { status: 'idle' },
    { status: 'loading' },
    { status: 'unavailable' },
    { status: 'ready' },
  ]) {
    assert.equal(panelVisible(unread), true, `${JSON.stringify(unread)} must not hide the panel`)
  }

  // Only an explicit false is a switch-off; a hand-edited document carrying something
  // else is not a reason to silently withdraw the surface.
  for (const other of [0, '', 'no', []]) {
    assert.equal(
      panelVisible({ status: 'ready', value: { showInSidebar: other } }),
      true,
      `${JSON.stringify(other)} is not an explicit false`,
    )
  }

  // A NON-READY SNAPSHOT CAN STILL CARRY A VALUE, and it must be ignored. The mirror
  // publishes by replacing `value` while it re-reads, so the pair
  // `{ status: 'loading', value: <last document> }` is reachable — and acting on that
  // stale value would withdraw the entry every time the settings document reloads.
  for (const stale of [
    { status: 'idle', value: { showInSidebar: false } },
    { status: 'loading', value: { showInSidebar: false } },
    { status: 'unavailable', value: { showInSidebar: false } },
  ]) {
    assert.equal(
      panelVisible(stale),
      true,
      `a ${stale.status} snapshot must not act on its carried value`,
    )
  }
})

test('the sidebar label falls back to the dictionary and then to the id, never to blank', () => {
  const { panelLabel } = panelHelpers()

  // Configured wins.
  assert.equal(panelLabel('我的工作流', '工作流设置', 'dsh-workflow'), '我的工作流')

  // A blank or missing configured label is an unlabelled, unlabellable button, so it
  // falls through rather than rendering an empty accessible name.
  for (const blank of ['', '   ', undefined, null, 7, {}, []]) {
    assert.equal(
      panelLabel(blank, '工作流设置', 'dsh-workflow'),
      '工作流设置',
      `${JSON.stringify(blank)} must fall back to the dictionary`,
    )
  }

  // The id is the documented last resort, so the entry is never nameless. A blank id
  // (the constant emptied by mistake) must still not produce a blank label.
  for (const blank of ['', '  ', undefined]) {
    assert.equal(panelLabel(blank, blank, 'dsh-workflow'), 'dsh-workflow')
  }
  for (const missingId of ['', undefined, null]) {
    assert.equal(
      panelLabel('', '', missingId),
      '',
      'with nothing usable to fall back to, the result is still a string',
    )
  }
})

test('the sidebar entry and the main body it opens share one id', () => {
  const source = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')

  // The shared constant, then both registrations reading it. A literal on either side
  // is what lets them drift apart.
  const declared = /const PANEL_ID = '([^']+)'/.exec(source)
  assert.ok(declared, 'the shared panel id is no longer a named constant')

  assert.match(
    source,
    /id: PANEL_ID,/,
    'the sidebar entry must carry the shared id — the sidebar keys its row cells by it',
  )
  assert.match(
    source,
    /name: 'main',\s*key: PANEL_ID,/,
    'the body must be registered in the main keyed slot under the SAME id, or selecting ' +
      'the entry throws instead of opening a panel',
  )

  // The contract's own shape, read from the registration literal: the sidebar collector
  // reads `options.id` (its cell), `options.order` (its sort key), the resolved `label`
  // (the visible text, accessible name and tooltip) and the locale namespace the label
  // resolves in. One slice, not a whole-file regex, because these must be members of ONE
  // registration.
  const entry = sidebarRegistration(source)
  for (const member of ['id: PANEL_ID', 'order: PANEL_ORDER', 'label,', 'locale: NS']) {
    assert.ok(entry.includes(member), `the sidebar registration lost its \`${member}\` member`)
  }
  assert.match(source, /ctx\.slots\.inject\('sidebar\.panellist',/, 'the entry must be injected, not registered bare')
  assert.match(source, /ctx\.slots\.inject\('main',/, 'the body must be injected into the main slot')

  // The BODY's own registration: it needs the shared id (asserted above) and a locale
  // namespace — see the locale test below for why the seat is not optional.
  const bodyStart = source.indexOf("ctx.slots.inject('main'")
  const main = source.slice(bodyStart, bodyStart + 500)
  assert.ok(main.includes('key: PANEL_ID,'), 'the main registration must be keyed by the shared id')
  assert.ok(main.includes('locale: NS,'), 'the main registration must declare the locale namespace, or the body has no t seat')
})

test('the sidebar switch READS and WRITES the same settings namespace', () => {
  const source = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')

  // The review round-1 blocker, pinned. Each Loader row owns its OWN settings document,
  // so reading `showInSidebar` from the panel row while writing it through the core
  // row's controller makes the feature's only control inert: it reports 已保存, changes
  // nothing any reader consults, and the entry is still in the sidebar after a reload.
  // A green suite proved nothing about this, because no assertion tied the two together.
  // The switch row's document is the PANEL row's, and it must be taken from
  // `props.panelController`. Scoped to the brace-matched SidebarPanel body: a whole-file
  // regex cannot tell a correct subscription from `props.controller` here, because a
  // decoy `props.panelController` exists in the SIBLING WorkflowCard function, and the
  // plugin page legitimately binds `form` the same way.
  const body = clientFunction(source, 'SidebarPanel')
  assert.match(
    body,
    /const panel = props\?\.panelController/,
    'the body must take the panel row\'s controller — it is the value the gate reads',
  )
  assert.match(
    body,
    /return panel\.subscribe\(publish\)/,
    'the switch state must come from the panel row\'s document',
  )
  assert.match(
    body,
    /const publish = \(\) => setSnapshot\(panel\.getSnapshot\(\)\)/,
    'the snapshot the switch reads must be the panel row\'s',
  )

  // The switch's checked source and its write target, brace-matched as ONE expression so
  // a same-named controller in either slot cannot make this pass by accident.
  const open = source.indexOf('header: sidebarVisibleRow({')
  assert.ok(open >= 0, 'the body no longer renders the switch row')
  let depth = 0
  let header = ''
  for (let i = source.indexOf('{', source.indexOf('sidebarVisibleRow', open)); i >= 0 && i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) {
        header = source.slice(source.indexOf('sidebarVisibleRow', open), i + 1)
        break
      }
    }
  }
  assert.ok(header.length > 0, 'could not slice the switch row')
  assert.match(header, /checked: live\.showInSidebar !== false/, 'the switch must read the panel document')
  assert.match(
    header,
    /writeTopLevel\(panel, 'showInSidebar'/,
    'the switch must WRITE the panel document — the same one it reads and the same one `panelVisible` gates on',
  )
  assert.ok(
    !/writeTopLevel\(form, 'showInSidebar'/.test(source),
    'writing the switch through the core row is the inert-control defect: the gate never sees it',
  )

  // And the core row must still be the one the rest of the form writes.
  assert.match(
    source,
    /const form = props\?\.controller \?\? resolveForm\(props, props\?\.ctx\)/,
    'the form below must keep using the core row controller',
  )
})

test('every slot registration that renders visible copy declares its locale namespace', () => {
  const source = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')

  // The renderer installs the `t` seat ONLY for entries that declare `locale`
  // (refs/dsh-client-ui-renderer: `if (entry.locale !== undefined) kit['t'] =
  // localeSeat(face, entry.locale)`), and the `main` render call passes no `t` of its
  // own. An entry without it silently falls back to the bundle's built-in dictionaries:
  // the page renders Chinese in an English session, and the locale seat declared on the
  // ICON entry does not help, because the icon receives `size`/`active` only.
  //
  // One test per registration, so a NEW registration added without the line fails here
  // rather than shipping as an untranslated surface.
  for (const name of ['plugins.row.config', 'sidebar.panellist', 'main', 'conversation.view']) {
    const start = source.indexOf(`name: '${name}'`)
    assert.ok(start >= 0, `lib/client.js no longer registers ${name}`)
    const registration = source.slice(start, start + 700)
    assert.ok(
      /locale: NS,/.test(registration),
      `the ${name} registration must declare \`locale: NS\`, or it renders untranslated`,
    )
  }
})

test('the sidebar cannot be registered without its body', () => {
  const source = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')

  // Both registrations must live inside the ONE `whileServed` callback that a single
  // disposer wraps: the sidebar THROWS on an id whose main entry is missing, so a path
  // that registers one without the other is worse than registering neither.
  const gate = source.indexOf('ctx.configForms.whileServed([PANEL_ENTRY_ID]')
  assert.ok(gate >= 0, 'the panel no longer follows the settings namespace that owns its switch')
  const entry = source.indexOf("ctx.slots.inject('sidebar.panellist'")
  const body = source.indexOf("ctx.slots.inject('main'")
  assert.ok(entry > gate, 'the sidebar entry must be registered inside the served-namespace gate')
  assert.ok(body > entry, 'the main body must follow its entry in the same gate')

  // The callback's own body, sliced so the disposer assertions below cannot be satisfied
  // by the sibling `plugins.row.config` registration's identically-shaped early return.
  const open = source.indexOf('{', source.indexOf('whileServed([PANEL_ENTRY_ID]', gate))
  let depth = 0
  let callback = ''
  for (let i = open; i >= 0 && i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) {
        callback = source.slice(open, i + 1)
        break
      }
    }
  }
  assert.ok(callback.length > 0, 'could not slice the whileServed callback')

  // A withdrawal is a disposer, not undefined: `whileServed` assigns the callback's
  // return value (`off = register(served)`) and calls it on teardown (`off?.()`), so a
  // bare `return` would silently break the service's own contract.
  assert.match(
    callback,
    /return function \(\) \{\}/,
    'a withdrawn panel must return a disposer, which is what whileServed calls',
  )
  assert.match(
    callback,
    /releasePanel\(\)\s*\n\s*releaseBody\(\)/,
    'teardown must release the entry and the body together',
  )
})

test('the sidebar label comes from the same locale namespace the dictionary is registered under', () => {
  const source = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')

  // A `t` bound to another namespace resolves the key to itself and the sidebar would
  // show the literal text "panelLabel" — a silent, plausible-looking failure.
  assert.match(source, /t = ctx\.locale\.bind\(NS\)/, 'the sidebar label must be a namespace-bound translator')
  assert.match(source, /panelLabel\(value\.sidebarLabel, t\('panelLabel'\), PANEL_ID\)/, 'the label must fall through to the dictionary entry and then to the panel id')
  assert.match(source, /panelLabel: '[^']+'/, 'both dictionaries must define the fallback')
  assert.equal(
    source.split("panelLabel: '").length - 1,
    2,
    'the fallback must exist in the zh AND en dictionaries',
  )
})

test('exactly ONE row carries the configuration page, and the switch survives on it', () => {
  const source = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')

  // THE DUPLICATE, REMOVED. `plugins.row.config` is a KEYED slot whose key is
  // `<package>#<rowId>`, and the plugin manager renders a row's page — including its
  // "Configure" control — only while a key names it. Registering it for BOTH rows (the
  // previous shape) put the SAME form on the bundle's page twice, which is the duplicate
  // the user asked to have removed. The extraction is per-registration, so this is exact:
  // a third row added back later fails here.
  const keys = [...source.matchAll(/'src-12453345_-dsh-workflow#([A-Za-z0-9_-]+)'/g)].map(match => match[1])
  assert.deepEqual(
    [...new Set(keys)],
    ['dsh-workflow-core'],
    `exactly one plugins.row.config key may exist; found ${JSON.stringify(keys)}`,
  )

  // ...AND THE ONE-WAY DOOR IS STILL CLOSED — this is the constraint that motivated the
  // double registration, so removing one entry must not remove the way back.
  //
  // `showInSidebar` lives in the PANEL row's settings document (the profile patch, a layer
  // the project file cannot override), and `workflow_set` refuses a boolean at that path.
  // The UI's only writer is the row page, so the row page has to render the switch. It
  // does so through `props.panelController`, which the registration below hands it.
  //
  // `PANEL_ENTRY_ID` must therefore still be USED as the controller source even though it
  // is no longer a registration key.
  assert.match(
    source,
    /panelController: panelConfigController\(ctx\)/,
    'the remaining page must still receive the PANEL row controller — it is the only UI that can restore the switch',
  )
  assert.match(
    source,
    /const PANEL_ENTRY_ID = 'dsh-workflow-panel'/,
    'the panel row id must still name the row that DECLARES showInSidebar',
  )

  // That page has to actually render the switch, and write the panel row: this is the
  // `props.panelController` branch inside the shared card. The assertions run against the
  // BRACE-MATCHED WorkflowCard body, not the whole file: a whole-file regex cannot tell
  // `const panel = props?.panelController` from `const panel = undefined` followed later
  // by an unrelated `props.panelController` mention.
  const card = clientFunction(source, 'WorkflowCard')
  assert.match(
    card,
    /const panel = props\?\.panelController/,
    'the page must take the panel row controller from its own registration',
  )
  assert.match(
    card,
    /checked: panelSnapshot\?\.value\?\.showInSidebar !== false/,
    'the page\'s switch must read the panel document through props.panelController',
  )
  assert.match(
    card,
    /writeTopLevel\(panel, 'showInSidebar', event\.target\.checked, switchToken, setMessage, t\)/,
    'the page\'s switch must write the panel document, with its own write stamp',
  )
  assert.match(
    card,
    /panel\s*\n?\s*\? sidebarVisibleRow\(/,
    'the switch must be rendered only when the panel controller is present',
  )

  // And the hint must not send the user to a path that cannot work. `workflow_set` and
  // the project `.dsh/workflow.yml` both live BELOW the profile patch, and the writer
  // refuses this field; only the row page (or the profile document itself) clears it.
  for (const key of ['showInSidebarHint']) {
    const hints = [...source.matchAll(new RegExp(`${key}: '([^']+)'`, 'g'))].map(match => match[1])
    assert.equal(hints.length, 2, `${key} must exist in both dictionaries`)
    for (const hint of hints) {
      assert.ok(
        !/workflow_set/.test(hint),
        `the hint must not name workflow_set as the restore path: ${hint}`,
      )
      assert.ok(
        !/\.dsh\/workflow\.yml/.test(hint),
        `the hint must not name the project file as the restore path: ${hint}`,
      )
    }
  }
  // At least one language names the row that actually works.
  assert.ok(
    /dsh-workflow-panel/.test(source),
    'the hint (or the registration) must name the row page that can restore the switch',
  )
})

test('the panel row\'s patch values match the runtime defaults', () => {
  // `run-config-check.mjs` walks the CORE row's patch block only, so the panel row's
  // three presentation fields were outside every guard — and those are exactly the
  // values the gate and the label consume when the profile patch carries no override.
  // Parsed from the shipped patch, and compared with `DEFAULT_CONFIG`, so a divergence
  // between the two layers fails here instead of only on a machine with no override.
  const patch = readFileSync(join(REPO, 'cordis.patch.yml'), 'utf8')
  const panelRow = patch.slice(patch.indexOf('src-12453345_-dsh-workflow/panel'))
  assert.ok(panelRow.length > 0, 'the panel row left cordis.patch.yml')

  const scalar = (key, raw) => {
    const match = new RegExp(`^\\s*${key}:\\s*([^#\\n]+)`, 'm').exec(raw)
    assert.ok(match, `the panel row no longer carries \`${key}\``)
    return match[1].trim()
  }

  assert.equal(scalar('showInSidebar', panelRow), String(DEFAULT_CONFIG.showInSidebar))
  assert.equal(scalar('sidebarLabel', panelRow), DEFAULT_CONFIG.sidebarLabel)
  assert.equal(scalar('showInPluginPage', panelRow), String(DEFAULT_CONFIG.showInPluginPage))
})

test('the browser half still requires nothing but react', () => {
  // A browser bundle cannot import a host module, and this one must keep a single
  // require. The sidebar work added no import, and `showInSidebar` is read through the
  // settings service rather than by importing `lib/config.js`.
  //
  // Comment lines are stripped first: the bundle's own prose quotes the require (the
  // loading-contract header explains why there is exactly one), and a test that counted
  // a comment would fail the moment someone documented the rule better.
  const source = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
  const code = source
    .split('\n')
    .filter(line => !/^\s*(\*|\/\*|\/\/)/.test(line))
    .join('\n')
  const requires = [...code.matchAll(/require\(([^)]*)\)/g)].map(match => match[1])
  assert.deepEqual(requires, ["'react'"], `the bundle requires ${JSON.stringify(requires)}`)
})

test('the panel switch is declared in the schema and in the runtime defaults, and is read in the browser', () => {
  // "Nothing reads it" was the defect this whole section exists for, so the three halves
  // of the switch are pinned together: the field the Host serves, the default it
  // resolves to, and the browser half that acts on it.
  const schema = readFileSync(join(REPO, 'lib', 'config-schema.js'), 'utf8')
  assert.match(schema, /showInSidebar: z\.boolean\(\)\.default\(DEFAULT_CONFIG\.showInSidebar\)/, 'the schema must still serve the switch')
  assert.match(schema, /sidebarLabel: z\.string\(\)\.default\(DEFAULT_CONFIG\.sidebarLabel\)/, 'the schema must still serve the label')

  assert.equal(
    DEFAULT_CONFIG.showInSidebar,
    true,
    'the browser treats an unread switch as visible, which is only correct while the default is true',
  )

  const source = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
  assert.match(source, /get\?\.\(PANEL_ENTRY_ID\)/, 'the switch must be read from the entry that declares it')
  const ids = [...source.matchAll(/const PANEL_ENTRY_ID = '([^']+)'/g)].map(match => match[1])
  assert.equal(ids.length, 1, 'the panel entry id must be declared once')
})

// ---------------------------------------------------------------------------
// THE CONVERSATION-PAGE TAB — project scope
// ---------------------------------------------------------------------------
//
// The correction this whole change set exists for. A left-sidebar panel and the plugin
// detail page BOTH edit the plugin entry's configuration (`configForms`), so they are the
// same surface twice; what the user asked for is THIS project's settings, which live in
// the project's own `.dsh/workflow.yml`.
//
// A tab that painted `configForms` fields under a "this project" heading would repeat
// exactly that mistake, so the separation is asserted, not described.

test('the project tab reads the project file and the defaults layer, with no write path', () => {
  const source = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
  const tab = clientFunction(source, 'WorkflowTab')

  // THE TAB READS TWO LAYERS AND WRITES NEITHER. It must not render the plugin-defaults
  // EDITOR (`WorkflowCard`), and the defaults layer must arrive through the one named reader
  // that exists for it — not through the settings page's `resolveForm` render prop, and not
  // through `props.controller`, which is an editing surface.
  assert.ok(
    !/WorkflowCard/.test(tab),
    'the project tab must not render WorkflowCard; that is the defaults editor under a project heading',
  )
  assert.match(
    tab,
    /projectDefaultsController\(/,
    'the defaults layer must be read through the named read-only reader',
  )
  assert.ok(!/resolveForm/.test(tab), 'the tab must not resolve the settings page\u2019s editing form')
  assert.ok(!/props\??\.controller/.test(tab), 'the tab must not take an editing controller as a prop')
  assert.ok(
    !/panelConfigController/.test(tab),
    'the tab displays the CORE entry\u2019s defaults, never the panel row\u2019s',
  )

  // THE READ-ONLY FRAMING, ASSERTED AS ABSENCE OF A WRITE PATH. A `set`/`mutate`/`unset` call
  // anywhere in this component would be a control that edits one of the two layers this page
  // only displays — and the defaults layer is the one that affects every project. `\bset\(`
  // deliberately does not match `setState(`/`setRevision(`/`setPaneWidth(`/`setDefaults(`,
  // which are this component's own React state setters.
  for (const pattern of [/\.mutate\s*\(/, /\.unset\s*\(/, /\bset\s*\(/, /\bwrite\s*\(/, /\.update\s*\(/]) {
    assert.ok(
      !pattern.test(tab),
      `the project tab must contain no write path (matched ${pattern}): the two layers it shows are written by the settings surfaces and the workflow_* tools`,
    )
  }
  // ...and the read helper itself takes nothing but a context.
  const reader = clientFunction(source, 'projectDefaultsController')
  assert.match(reader, /ctx\?\.configForms\?\.get\?\.\(ENTRY_ID\)/, 'the reader must ask for the core entry')
  for (const pattern of [/\.mutate\s*\(/, /\bset\s*\(/, /\bwrite\s*\(/]) {
    assert.ok(!pattern.test(reader), `the defaults reader must not write (matched ${pattern})`)
  }

  // The project half is still the shipped read-only Remote, addressed by the SESSION the slot
  // was scoped to. `readProjectWorkflow` is where that lives.
  const read = clientFunction(source, 'readProjectWorkflow')
  assert.match(
    read,
    /ctx\?\.get\?\.\('remote\.workspaceFiles'\)/,
    'the tab must read through the shipped workspaceFiles namespace',
  )
  assert.match(
    read,
    /read\(sessionId, PROJECT_FILE, \{ limit: PROJECT_FILE_LINES \}, controller\?\.signal\)/,
    'the read must pass the session, the project file, a range object and the abort signal, in the descriptor\'s order',
  )

  // WRITES ARE THE TOOL'S, NOT THIS BUNDLE'S. The namespace exposes no mutation
  // operation, so any `write`/`set` call here would be a fabricated bridge.
  //
  // THREE ASSERTIONS, because each narrower one is satisfied by a real way of writing the
  // same bridge:
  //   - matching only `workspaceFiles').write` is satisfied by `files?.write?.(…)`, the same
  //     call one local variable away;
  //   - matching `write(` is satisfied by `write?.(…)`, because `write?` ends in a word
  //     character and so contains no `\b` before the paren.
  // Both of those mutants were reported MISSED by this file's own harness before the guards
  // below were written, which is the only reason they are this specific.
  const mutations = read.replace(/ReadProjectWorkflow|setState/g, '')
  assert.ok(
    !/workspaceFiles'\)\.(write|set|save|update)/.test(read),
    'the tab must not call a mutation on workspaceFiles — the service has none',
  )
  assert.ok(
    !/\b(write|set|save|update)\s*\(/.test(mutations),
    'the read path must call no mutation at all, however the receiver is spelled',
  )
  assert.ok(
    !/\b(write|set|save|update)\s*\??\.\s*\(/.test(mutations),
    'and no optional-call mutation either: `files?.write?.()` is the same fabricated bridge',
  )

  // ...AND NO OTHER NAMESPACE WAS REACHED FOR EITHER. The write-path investigation examined
  // `settings` (which DOES have `update`/`replace`/`mutate`) and `workspace` (which mutates
  // the Workspace list). Wiring `remote.settings` here would be worse than not editing at
  // all: `SettingsForms.write` resolves its first argument through
  // `configEditor.entries().find(row => row.options.id === ns)` and persists through
  // `configEditor.edit`, so it can only write a PROFILE ENTRY's plugin configuration — the
  // plugin-defaults layer, which this tab exists to be distinct from — and it throws
  // `No configurable plugin entry "<ns>"` for anything else, including a project path.
  assert.ok(
    !/remote\.settings|remote\.workspace\b/.test(read),
    'the tab must not reach the settings or workspace namespaces; neither addresses a file ' +
      'inside a project, and settings writes land in the plugin-defaults layer',
  )
})

test('the tab is registered into conversation.view with its own id and a thunk label', () => {
  const source = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')

  // `viewTabs()` skips an entry with no `id` and builds its label through
  // `resolveSlotLabel(entry.options.label) ?? entry.options.id`, so BOTH are load-bearing.
  assert.match(
    source,
    /ctx\.slots\.inject\(VIEW_SLOT, function \(\) \{/,
    'the tab must go through slots.inject — a bare register() is a no-op before the slot is declared',
  )
  const start = source.indexOf("name: 'conversation.view'")
  assert.ok(start >= 0, 'the conversation.view registration is gone')
  const registration = source.slice(start, start + 600)
  assert.match(registration, /id: VIEW_ID,/, 'the entry needs an id; viewTabs() skips one without')
  assert.match(
    registration,
    /label: \(\) => t\('viewProject'\)/,
    'the label must be a thunk so it follows a locale switch',
  )
  assert.match(registration, /order: VIEW_ORDER,/, 'the order must come from the named constant')

  // `conversation.view` is NOT always accompanied by 「轨迹」: the conversation assembly
  // drops the trajectory tab unless the developer switch is on
  // (`if (!ctx.configForms.developerTools.enabled.getSnapshot() && entry.options.id ===
  // "trajectory") continue`). So this tab must be independently identifiable.
  const ids = [...source.matchAll(/const VIEW_ID = '([^']+)'/g)].map(match => match[1])
  assert.deepEqual(ids, ['workflow-project'], 'the view id must be declared once and not be "trajectory"')
  assert.ok(
    /viewProject: '[^']+'/.test(source),
    'the tab needs its own label dictionary entry, independent of the sidebar panel label',
  )
  assert.equal(
    source.split("viewProject: '").length - 1,
    2,
    'the label must exist in the zh AND en dictionaries',
  )
})

test('the project tab is scoped to this project and labels every layer it shows', () => {
  const source = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
  const tab = clientFunction(source, 'WorkflowTab')

  // The two-layer notice has to be on the page: the defaults layer is VISIBLE here (as the
  // inherited value) and is edited elsewhere, so a user must be able to tell which surface
  // changes what. It has to name both the other layer and the surface that edits it.
  assert.match(tab, /t\('projectNoFallback'\)/, 'the tab must state which layer it does not edit')
  const noFallback = [...source.matchAll(/projectNoFallback:\s*\n?\s*'([^']+)'/g)].map(match => match[1])
  assert.equal(noFallback.length, 2, 'the notice must exist in the zh AND en dictionaries')
  for (const line of noFallback) {
    assert.ok(/默认值|DEFAULTS/.test(line), `projectNoFallback must name the other layer: ${line}`)
    assert.ok(
      /侧边栏|sidebar|设置/.test(line),
      `projectNoFallback must name the surface it is not: ${line}`,
    )
  }

  // EVERY ROW CARRIES A LAYER BADGE, and the row renderer is what puts it there: the layer
  // mapping has one definition (`configLayerBadge`) and the row uses it, so a row cannot be
  // rendered without saying where its value came from.
  assert.match(tab, /configLayerBadge\(row\.source\)/, 'every effective-config row must be labelled by layer')
  assert.match(tab, /projectRowText\(row\)/, 'row values must go through the pure formatter')
  for (const key of ['projectLayerProject', 'projectLayerInherited', 'projectLayerUnknown', 'projectLayerFailClosed']) {
    assert.ok(
      source.split(`${key}: '`).length - 1 === 2,
      `${key} must be defined in the zh AND en dictionaries`,
    )
  }
  const badge = clientFunction(source, 'configLayerBadge')
  assert.match(badge, /source === 'project'/, 'the project layer must be distinguishable')
  assert.match(badge, /source === 'fail-closed'/, 'a refused section must be distinguishable')

  // ...and the write path has to be named, because this bundle cannot write the file.
  assert.match(tab, /t\('projectWriteBody'\)/)
  assert.match(tab, /t\('projectWriteExample'\)/)
  for (const line of [...source.matchAll(/projectWriteBody:\s*\n?\s*'([^']+)'/g)].map(match => match[1])) {
    assert.ok(/workspaceFiles|workspace file|只读|read/i.test(line), `projectWriteBody must say why the browser cannot write: ${line}`)
  }
  for (const line of [...source.matchAll(/projectWriteExample:\s*'([^']+)'/g)].map(match => match[1])) {
    assert.match(
      line,
      /^workflow_set path=/,
      `the example must be a real workflow_set invocation: ${line}`,
    )
  }

  // THE READ-ONLY ANSWER HAS TO BE ON THE PAGE, and it has to be the CHECKED answer rather
  // than a shrug. The tab was reported as "暂时没有功能性，调不了本项目设置" — it read as an
  // unfinished tab, not as a deliberate one. Two candidate namespaces were then investigated
  // (`dsh-api-settings-controller`, `dsh-api-workspace-controller`); neither can address a
  // file inside a project's `.dsh/`, so there is no editor to build. The page says so, and
  // names what was checked, so the next reader does not repeat the search.
  assert.match(tab, /t\('projectNoWriteHeading'\)/)
  assert.match(tab, /t\('projectNoWriteBody'\)/)
  assert.match(tab, /t\('projectNoWriteFooter'\)/)
  for (const line of [...source.matchAll(/projectNoWriteBody:\s*\n?\s*'([^']+)'/g)].map(match => match[1])) {
    // Each checked candidate is NAMED, or the sentence is a claim nobody can re-check.
    for (const namespace of ['workspaceFiles', 'workspace', 'settings']) {
      assert.ok(line.includes(namespace), `projectNoWriteBody must name ${namespace}: ${line}`)
    }
    assert.ok(
      /workflow_set|workflow_init/.test(line),
      `projectNoWriteBody must name the writers that DO exist: ${line}`,
    )
  }
  for (const line of [...source.matchAll(/projectNoWriteFooter:\s*\n?\s*'([^']+)'/g)].map(match => match[1])) {
    // The line this tab refuses to cross. A defaults editor under this heading is the exact
    // mistake the scope test above fails on; the copy says it out loud.
    assert.ok(
      /默认值|DEFAULT|descriptor|描述符/.test(line),
      `projectNoWriteFooter must state what is refused, not merely that nothing is here: ${line}`,
    )
  }
})

test('every key the tab renders exists in BOTH dictionaries, and the computed ones interpolate', () => {
  const source = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
  const zhDict = new Function(`return ${sourceConst(source, 'zh')}`)()
  const enDict = new Function(`return ${sourceConst(source, 'en')}`)()
  const tab = clientFunction(source, 'WorkflowTab')

  // A key that exists in only one dictionary is a page that silently renders the key itself in the
  // other language — which is exactly how the new configuration table could ship half-translated.
  // The lookbehind is load-bearing: `createElement('span', …)` contains the letters `t('span'`, and a
  // scan that counted those would demand a dictionary entry for every HTML tag the tab renders.
  const keys = [...new Set([...tab.matchAll(/(?<![\w.])t\('([A-Za-z0-9_]+)'/g)].map(match => match[1]))]
  assert.ok(keys.length > 10, `the tab renders only ${keys.length} dictionary keys; the scan is broken`)
  for (const key of keys) {
    assert.ok(zhDict[key] !== undefined, `the zh dictionary is missing ${key}`)
    assert.ok(enDict[key] !== undefined, `the en dictionary is missing ${key}`)
  }

  // The two SUMMARY entries are FUNCTIONS, like `namespaceMissing`: the locale service returns a
  // function value unchanged and this bundle's own fallback translator ignores a second argument,
  // so a `{project}` template would reach the user with its placeholders unsubstituted.
  for (const key of ['projectConfigSummary', 'projectConfigRefusedCount']) {
    for (const [name, dict] of [['zh', zhDict], ['en', enDict]]) {
      assert.equal(typeof dict[key], 'function', `${name}.${key} must be a function`)
      const text = dict[key](1, 2, 3)
      assert.equal(typeof text, 'string', `${name}.${key} must return a string`)
      assert.ok(!/\{\w+\}/.test(text), `${name}.${key} left a placeholder unsubstituted: ${text}`)
    }
  }
})

test('the project tab resolves the file through the Session, and the path mirrors the host', () => {
  const { projectFilePath } = panelHelpers()

  // MIRROR of `join(projectDir, WORKFLOW_RELATIVE_PATH)`: `lib/workflow-file.js` exports
  // `WORKFLOW_RELATIVE_PATH = join('.dsh', 'workflow.yml')`, so the browser copy must be
  // the same two segments in the same order. Pinned against the host's own export rather
  // than against a transcription of it.
  const host = readFileSync(join(REPO, 'lib', 'workflow-file.js'), 'utf8')
  assert.match(
    host,
    /export const WORKFLOW_RELATIVE_PATH = join\('\.dsh', 'workflow\.yml'\)/,
    'the host moved the project file; this test pins the mirror against it',
  )
  const source = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
  const mirror = [...source.matchAll(/const PROJECT_FILE = '([^']+)'/g)].map(match => match[1])
  assert.deepEqual(mirror, ['.dsh/workflow.yml'], 'the browser mirror of the relative path must match')

  // The path is RELATIVE to the session's workspace root — the workspace-files README
  // states the rule ("accept an absolute path or one relative to the selected Session's
  // workspace root"), and an absolute path here would be a guess about the project
  // directory the browser does not have.
  assert.ok(
    !mirror[0].startsWith('/') && !/^[A-Za-z]:/.test(mirror[0]),
    'the path must stay workspace-relative',
  )

  // ...and the constant is what the read actually uses, not a decoration.
  const read = clientFunction(source, 'readProjectWorkflow')
  assert.match(read, /read\(sessionId, PROJECT_FILE,/, 'the read must use the mirrored constant')
})


// ---------------------------------------------------------------------------
// `workspace_dir` must be declared AND honoured by EVERY project-touching tool
// ---------------------------------------------------------------------------
//
// REGRESSION — found by calling the tools on a real host, not by any test.
//
// A previous fix made `workflow_status` honour `workspace_dir` after a live run caught it
// discarding the argument. `workflow_init` and `workflow_set` were left without it, so:
//
//   workflow_init workspace_dir=X   -> opted in the SESSION CWD, writing .dsh/workflow.yml
//                                      into the wrong project
//   workflow_set  workspace_dir=X   -> changed the session cwd's approval.strength,
//                                      a security-relevant write to the wrong project
//
// The failure mode is SILENT: the host drops an undeclared parameter with no error, so the
// tool cheerfully operates on the wrong directory and reports success. A test on one tool
// cannot catch that; this test asserts the DECLARATION across every tool, which is the
// actual invariant, and pins the two that regressed behaviourally.

test('every project-touching tool DECLARES workspace_dir, or the host drops it silently', () => {
  const options = { config: resolveConfig({}), ctx: null, services: null }
  const tools = {
    workflow_status: buildStatusToolDefinition(options),
    workflow_init: buildInitToolDefinition(options),
    workflow_set: buildSetToolDefinition(options),
    workflow_review: buildReviewToolDefinition(options),
    workflow_advance: buildAdvanceToolDefinition(options),
    workflow_gc: buildGcToolDefinition(options),
  }

  for (const [name, definition] of Object.entries(tools)) {
    assert.ok(definition, `${name} must build`)
    const declared = definition.parameters?.properties ?? {}
    assert.ok(
      Object.hasOwn(declared, 'workspace_dir'),
      `${name} must declare workspace_dir in its JSON Schema — an undeclared parameter is ` +
        'dropped by the host with no error, so the tool operates on the session cwd instead',
    )
  }
})

test('workflow_init HONOURS workspace_dir instead of opting in the cwd', () => {
  const cwdProject = makeProject()      // the session cwd — must NOT be touched
  const targetProject = mkdtempSync(join(tmpdir(), 'dsh-wf-ws-'))
  try {
    const definition = buildInitToolDefinition({ config: resolveConfig({}), ctx: null, services: null })
    const result = runInit({
      exec: execFor(cwdProject),
      config: resolveConfig({}),
      requested: { tier: 'minimal' },
      dryRun: false,
      workspaceDir: targetProject,
    })

    assert.equal(result.path, join(targetProject, '.dsh', 'workflow.yml'))
    assert.equal(result.wrote, true)
    assert.ok(
      readFileSync(join(targetProject, '.dsh', 'workflow.yml'), 'utf8').includes('tier: minimal'),
      'the workflow file must land in the TARGET project',
    )
    assert.equal(
      existsSync(join(cwdProject, '.dsh', 'workflow.yml')),
      false,
      'the session cwd must NOT be opted in',
    )
    assert.ok(definition, 'the tool must build')
  } finally {
    rmSync(cwdProject, { recursive: true, force: true })
    rmSync(targetProject, { recursive: true, force: true })
  }
})

test('workflow_set HONOURS workspace_dir instead of changing the cwd project', () => {
  const cwdProject = makeProject('tier: standard\n')
  const targetProject = makeProject('tier: standard\n')
  try {
    const result = runSet({
      exec: execFor(cwdProject),
      config: resolveConfig({}),
      path: 'tier',
      value: 'strict',
      hasValue: true,
      workspaceDir: targetProject,
    })

    assert.equal(result.ok, true, JSON.stringify(result.warnings ?? result))
    assert.match(
      readFileSync(join(targetProject, '.dsh', 'workflow.yml'), 'utf8'),
      /tier: strict/,
      'the TARGET project must receive the change',
    )
    assert.match(
      readFileSync(join(cwdProject, '.dsh', 'workflow.yml'), 'utf8'),
      /tier: standard/,
      'the session cwd must be left alone — a security-relevant setting changed here by mistake ' +
        'would be entirely silent',
    )
  } finally {
    rmSync(cwdProject, { recursive: true, force: true })
    rmSync(targetProject, { recursive: true, force: true })
  }
})

test('resolveWorkspace lets workspace_dir win, and treats an empty string as absent', () => {
  const cwdProject = makeProject()
  try {
    const exec = execFor(cwdProject)
    assert.equal(resolveWorkspace({ exec }).dir, cwdProject)
    assert.match(resolveWorkspace({ exec }).source, /cwd|session/)

    const overridden = resolveWorkspace({ exec, workspaceDir: 'D:\\elsewhere' })
    assert.equal(overridden.dir, 'D:\\elsewhere')
    assert.equal(overridden.source, 'workspace_dir argument')

    // "" is not a project. Treating it as one would resolve to the process cwd by accident.
    assert.equal(resolveWorkspace({ exec, workspaceDir: '' }).dir, cwdProject)
  } finally {
    rmSync(cwdProject, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// THE CONVERSATION TAB'S LAYOUT — a content column, not a full-bleed pane
// ---------------------------------------------------------------------------
//
// The user asked for the `轨迹` page's design language: a content column with left and
// right margins, spaced rows, not full width and not centred. That is arithmetic, so it
// is testable — and the failure mode (a column that silently becomes full bleed because a
// style declaration was dropped) is invisible without it.

test('the conversation column is inset, width-capped, and never centred', () => {
  const { conversationContentStyle, pageMargin } = panelHelpers()

  // The margin GROWS with the pane, and never collapses below a usable gutter.
  assert.equal(pageMargin(1000), 80)
  assert.equal(pageMargin(2500), 200)
  assert.equal(pageMargin(100), 24, 'a narrow pane keeps the minimum gutter')
  assert.equal(pageMargin(0), 24)
  assert.equal(pageMargin(-50), 24, 'a negative width is not a margin')
  assert.equal(pageMargin(Number.NaN), 24, 'NaN would drop the whole declaration in a style object')
  assert.equal(pageMargin(undefined), 24)
  assert.equal(pageMargin('1200'), 24, 'a string width is not a width')

  // NOT STRICTLY CENTRED: the slack stays on the RIGHT, the way the message column's does.
  const style = conversationContentStyle(1600)
  assert.deepEqual(
    Object.keys(style).sort(),
    ['boxSizing', 'marginRight', 'maxWidth', 'padding'],
    'the column must set exactly these declarations — a `marginLeft` here is a centring rule, ' +
      'and one that is merely balanced against `marginRight` cancels back into full bleed',
  )
  assert.equal(style.marginRight, 'auto', 'the column must be left-aligned, not centred')
  assert.equal(style.padding, '16px 128px 56px')
  assert.equal(style.maxWidth, '1016px', 'the readable cap plus both margins')
  assert.equal(style.boxSizing, 'border-box', 'the padding must be inside the cap, not added to it')

  // A very wide pane does NOT widen the TEXT: the cap grows only with the margins, so the
  // content keeps its readable width instead of running to the far edge of the monitor.
  const wide = conversationContentStyle(9000)
  assert.equal(pageMargin(9000), 720)
  assert.equal(wide.maxWidth, '2200px')
  assert.equal(wide.padding, '16px 720px 56px')
  // A narrow pane does not produce a negative margin or a zero-width column.
  const narrow = conversationContentStyle(10)
  assert.equal(narrow.padding, '16px 24px 56px')
  assert.equal(narrow.maxWidth, '808px')
  assert.equal(pageMargin(300), 24, 'a narrow pane keeps the minimum gutter')
})

test('the sidebar panel is narrower and airier than the plugin page', () => {
  const source = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
  const panel = clientFunction(source, 'SidebarPanel')

  // Narrower than the pane, and left-aligned rather than centred.
  assert.match(panel, /maxWidth: `\$\{PANEL_MAX_WIDTH_PX\}px`/, 'the panel must cap its width')
  assert.match(panel, /marginRight: 'auto'/, 'the panel must not be centred')
  assert.match(panel, /maxWidth: `\$\{PANEL_MAX_WIDTH_PX\}px`[\s\S]{0,120}marginRight: 'auto'/)

  // The rows are spaced WIDER than the settings page's, which is the "it tiles the whole
  // screen" complaint: a single stacked column at the page's spacing reads as one block.
  // The ROW half is the one that does the work; the column half is carried so the grid
  // shorthand has both numbers from one place.
  //
  // The geometry is now a MODULE constant (`panelRowStyle`) rather than an object built
  // inside `SidebarPanel`, because the template it declares is the input `columnStyle`
  // selects a child's column from — one constant means the two cannot drift. The panel's own
  // function is asserted to pass THAT constant, so the constant cannot become decorative.
  assert.match(
    panel,
    /rowStyle: panelRowStyle,/,
    'the sidebar body must place its rows into the panel geometry, not the page default',
  )
  const panelGeometry = sourceConst(source, 'panelRowStyle')
  assert.match(
    panelGeometry,
    /gap: `\$\{PANEL_ROW_GAP\} \$\{PANEL_COLUMN_GAP\}`/,
    'the stacked rows must use the panel row gap, not the page one',
  )
  assert.match(
    panelGeometry,
    /padding: PANEL_ROW_PADDING/,
    'each row must carry the panel row padding',
  )

  // And the constants have to be BIGGER than the page's, or the "fix" is a rename.
  const constOf = name => {
    const match = new RegExp(`const ${name} = (\\d+|'(?:[^']*)')`).exec(source)
    assert.ok(match, `const ${name} is gone`)
    return match[1]
  }
  assert.equal(constOf('PANEL_MAX_WIDTH_PX'), '520')
  assert.equal(constOf('PANEL_ROW_GAP'), "'16px'")
  const pageGap = /gap: '(\d+)px (\d+)px'/.exec(source)
  assert.ok(pageGap, 'the shared field grid lost its gap')
  assert.ok(
    Number(constOf('PANEL_ROW_GAP').replace(/\D/g, '')) > Number(pageGap[1]),
    'the panel rows must be spaced wider than the page rows, not merely differently',
  )
})

// ---------------------------------------------------------------------------
// THE PANEL'S ONE COLUMN — why it was two, and that it stays one
// ---------------------------------------------------------------------------
//
// The shipped panel rendered its label one character per line. The source said
// `gridTemplateColumns: 'minmax(0, 1fr)'`, i.e. one column, so nothing in the source could
// have caught it: `minmax(0, 1fr)` gives the grid NO definite width, so the `fr` track is
// resolved by intrinsic sizing, and its flex base size is the ZERO of its minimum. The hint
// under each control carried `gridColumn: '2'` (correct on the settings page, whose rows
// really are `200px 1fr`), and an explicitly placed item CREATES the track it names — so the
// implicit second track took the width and the label's track was left at 0px.
//
// Measured in Chromium before the fix, at a 264px row:
//   tracks="0px 244px"   label=0px, wrapping over 4 lines
// after:
//   tracks="264px"       label=264px on one line
//
// The assertion is the resolved number, not the string, because the string was already
// right. `tooling/measure-grid-layout.mjs` prints the same table on demand.
test('the panel hint spans its one column instead of creating a second', () => {
  const source = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
  const styles = gridStyles(source)

  // The page's rows have a real second track, and the shared hint style is correct there.
  assert.equal(styles.rowStyleDefault.gridTemplateColumns, '200px 1fr')
  assert.equal(styles.hintStyle.gridColumn, '2')
  assert.equal(styles.warningStyle.gridColumn, '2')

  // The panel's geometry is ONE track that cannot be squeezed by an implicit sibling: a
  // definite `100%`, not a `minmax()` the intrinsic sizing pass can resolve to zero.
  assert.equal(styles.panelRowStyle.display, 'grid')
  assert.equal(
    styles.panelRowStyle.gridTemplateColumns,
    '100%',
    'a single `minmax(0, 1fr)` track is not enough: with no definite grid width its ' +
      'resolved size is the flex base size of its zero minimum, and any sibling that claims ' +
      'column two then takes the width the label needed',
  )
  assert.equal(styles.panelFieldHintStyle.gridColumn, '1 / -1')
  assert.equal(styles.panelWarningStyle.gridColumn, '1 / -1')
  assert.equal(styles.panelFieldHintStyle.color, styles.hintStyle.color, 'the shade must not change')
  assert.equal(styles.panelFieldHintStyle.fontSize, styles.hintStyle.fontSize)

  // `columnStyle` selects by the row template itself, so the choice cannot drift from the
  // grid it is used in: the panel gets the spanning styles, the page keeps column two.
  assert.equal(styles.columnStyle(styles.panelRowStyle, styles.panelFieldHintStyle, styles.hintStyle), styles.panelFieldHintStyle)
  assert.equal(styles.columnStyle(styles.rowStyleDefault, styles.panelFieldHintStyle, styles.hintStyle), styles.hintStyle)
  assert.equal(styles.columnStyle(undefined, 'panel', 'page'), 'page', 'an unknown row template is the page case')

  // And the two call sites inside the form really go through it.
  const card = clientFunction(source, 'WorkflowCard')
  assert.match(
    card,
    /columnStyle\(rowStyle, panelFieldHintStyle, hintStyle\)/,
    'every field hint must have its column chosen from the row it is placed into',
  )
  assert.match(
    card,
    /columnStyle\(rowStyle, panelWarningStyle, warningStyle\)/,
    'the approval banner claims column two for the same reason the hints did',
  )
})

test('the shipped panel grid resolves to one column with a full-width label', async t => {
  if (skipInSandbox(t, 'this case launches Chromium to measure layout; the sandbox cannot start the browser')) return
  const browser = findChromium()
  if (browser === undefined) {
    // The declaration-level test above already pins the fix; this one pins the OUTCOME, and
    // an outcome needs a layout engine. Skipping is honest — a pass here would require
    // measuring, and measuring is impossible without a browser.
    t.skip('no Chromium-family browser on this machine; the resolved layout was not computed')
    return
  }
  const source = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
  const measured = await measureLayout({ browser, source })
  const panel = measured.filter(row => row.kind === 'panel')
  const page = measured.filter(row => row.kind === 'page')

  assert.ok(panel.length >= 5, 'the harness must have measured the panel rows')

  // THE REGRESSION ASSERTION: a resolved `gridTemplateColumns` of `0px …` (or any two-track
  // resolution) is the bug, whatever the declared string is.
  for (const row of panel) {
    assert.match(
      row.gridTemplateColumns,
      /^\d+px$/,
      `a panel row resolved to more than one track: ${row.gridTemplateColumns}`,
    )
    assert.equal(row.labelWidth, row.rowWidth, `the label must fill the row, not wrap: ${JSON.stringify(row)}`)
    assert.equal(row.labelLines, 1, `the label wrapped onto ${row.labelLines} lines`)
    assert.equal(row.controlWidth, row.rowWidth, 'the control must have the whole row')
    assert.equal(row.dividerWidth, row.rowWidth, 'the divider must cross the whole row')
    if (row.warningWidth !== null) {
      assert.equal(row.warningWidth, row.rowWidth, 'the warning banner must span the whole row')
    }
  }

  // The settings page is NOT changed by any of this: two tracks, control in the second.
  for (const row of page) {
    assert.match(row.gridTemplateColumns, /^200px \d+px$/, `the page lost its two columns: ${row.gridTemplateColumns}`)
    assert.equal(row.labelWidth, 200, 'the page label column is the shared 200px')
  }
}, { timeout: 120000 })

// ---------------------------------------------------------------------------
// WHAT THE TAB READS — the file's own keys, and a Remote result that is not a throw
// ---------------------------------------------------------------------------
//
// Two decisions here are the difference between a tab that tells the truth and one that
// invents it:
//
//  - the project file is a DELTA (`serializeWorkflowYaml` writes only differing values),
//    so listing the EFFECTIVE configuration would paint an inherited default as this
//    project's own choice;
//  - the Remote answer is `{ ok, value }` / `{ ok: false, error }`, not an exception, so
//    "the file is missing" arrives as a BRANCH. Reading it as success renders an empty
//    `<pre>` that looks like an empty project file.

test('the project tab lists what the FILE declares, not what the config resolves to', () => {
  const { projectFileKeys, firstLine } = panelHelpers()

  const file = [
    '# a comment, not a key',
    'tier: standard',
    'approval:',
    '  strength: llm-only',
    '  exemptTools: []',
    'modules:',
    '  planner: false',
    'recipe: null',
    'tier: strict',
    '',
  ].join('\n')

  assert.deepEqual(
    projectFileKeys(file),
    ['tier', 'approval', 'modules', 'recipe'],
    'only TOP-LEVEL keys, in file order, deduplicated — nested keys are the parent\'s values',
  )

  // Nothing declared -> nothing listed. The renderer says so instead of showing the
  // inherited defaults as if the file had chosen them.
  assert.deepEqual(projectFileKeys(''), [])
  assert.deepEqual(projectFileKeys('# only comments\n\n'), [])
  assert.deepEqual(projectFileKeys(null), [], 'a non-string is not a file')
  assert.deepEqual(projectFileKeys(undefined), [])

  // A hand-written file is arbitrary text: no key may be inferred from a line that is
  // indented, a comment, a list item, or a bare scalar. The INDENTED cases come FIRST
  // because they are how a nested mapping is written — a reader that ignores indentation
  // promotes `strength` and `planner` into top-level project keys, which is the
  // inherited-value-painted-as-a-choice defect in another shape.
  assert.deepEqual(projectFileKeys('  tier: standard\n'), [], 'an indented key belongs to its parent')
  assert.deepEqual(
    projectFileKeys('approval:\n  strength: off\nmodules:\n  planner: false\n'),
    ['approval', 'modules'],
    'the nested keys must not be promoted',
  )
  assert.deepEqual(projectFileKeys('\tstrength: off\n'), [], 'a tab indent is an indent')
  assert.deepEqual(projectFileKeys('- tier\n'), [])
  assert.deepEqual(projectFileKeys('  - tier\n'), [])
  assert.deepEqual(projectFileKeys('tier: standard # trailing\n'), ['tier'])
  // A quoted key is not a key the writer emits, and neither is a list item or a scalar.
  assert.deepEqual(projectFileKeys('quoted_key: 1\n'), ['quoted_key'], 'a bare key with an underscore is a key')
  assert.deepEqual(projectFileKeys('"tier": standard\n'), [], 'a quoted key is not a key the writer emits')
  assert.deepEqual(projectFileKeys("'tier': standard\n"), [])

  // CRLF is what a Windows editor produces, and `\s` matches `\r` — so an indentation test
  // applied to a line whose CR was never stripped is TRUE for the CR itself. A reader that
  // keeps the CR therefore reports NOTHING for a Windows file, which is caught here.
  assert.deepEqual(projectFileKeys('tier: standard\r\napproval:\r\n  strength: off\r\n'), ['tier', 'approval'])
  assert.deepEqual(projectFileKeys('tier:\r\napproval:\r\n'), ['tier', 'approval'], 'a CRLF file of bare keys')
  assert.equal(firstLine('tier: standard\r\napproval:\r\n'), 'tier: standard')
  assert.equal(firstLine('tier: standard'), 'tier: standard', 'a file with no trailing newline')
  assert.equal(firstLine(''), '')
  assert.equal(firstLine(undefined), '')

  // THE RULE IS CARRIED TWICE, SO NO SINGLE EDIT CAN DROP IT — asserted structurally,
  // because the redundancy is exactly what makes the behavioural cases above unable to fail
  // one at a time: with either carrier removed the other still enforces "column zero", so the
  // two mutants that delete them are caught by THESE assertions and by nothing else (measured:
  // `tooling/mutation-check-project-tab.mjs` P9 and P9b are both CAUGHT on this test, and
  // neither is flagged `equivalent` — if these two assertions ever go, the harness must report
  // them as MISSED rather than excuse them). The `/^\s/` guard and the key pattern's `^` anchor
  // both say "the key starts at column zero"; requiring BOTH is what keeps a future edit to
  // the regex from quietly promoting `approval.strength` into a project-level setting.
  const keys = clientFunction(readFileSync(join(REPO, 'lib', 'client.js'), 'utf8'), 'projectFileKeys')
  assert.match(keys, /if \(\/\^\\s\/\.test\(line\)\) continue/, 'the indentation guard left projectFileKeys')
  assert.match(
    keys,
    /\/\^\(\[A-Za-z_\]\[A-Za-z0-9_-\]\*\)\\s\*:\//,
    'the key pattern lost its start anchor — the second carrier of the column-zero rule',
  )
})

test('a refused read is a failure BRANCH, not an empty file', () => {
  const { projectFileResult } = panelHelpers()

  const ok = projectFileResult({
    ok: true,
    value: {
      offset: 1,
      text: 'tier: standard\n',
      lines: 1,
      eof: true,
      absolutePath: 'C:\\ws\\p\\.dsh\\workflow.yml',
      version: 'v1',
      bytes: 15,
    },
  })
  assert.equal(ok.state, 'ok')
  assert.equal(ok.path, 'C:\\ws\\p\\.dsh\\workflow.yml')
  assert.equal(ok.text, 'tier: standard\n')
  assert.equal(ok.eof, true)
  assert.equal(ok.bytes, 15)
  assert.equal(ok.version, 'v1')

  // THE ONE THAT MATTERS: `ok: false` must NOT be read as an empty file.
  const refused = projectFileResult({ ok: false, error: { code: 'workspace-file/unknown', message: 'no such file' } })
  assert.equal(refused.state, 'failed')
  assert.equal(refused.text, '', 'a failure carries no text')
  assert.match(refused.error, /no such file/)

  // A success with no file is still not a file.
  assert.equal(projectFileResult({ ok: true }).state, 'failed')
  assert.equal(projectFileResult({ ok: true, value: null }).state, 'failed')
  // Anything that is not a Remote result at all is a failure, never a trusted success.
  assert.equal(projectFileResult(null).state, 'failed')
  assert.equal(projectFileResult(undefined).state, 'failed')
  assert.equal(projectFileResult('tier: standard').state, 'failed')
  // A refusal with no message still fails, with a readable fallback.
  assert.equal(projectFileResult({ ok: false }).state, 'failed')
  assert.ok(projectFileResult({ ok: false }).error.length > 0)
})

test('a missing file and an unreadable one send the user to different remedies', () => {
  const { projectFailureText } = panelHelpers()
  const t = key => `[${key}]`

  // No reader at all: the deployment's Remote assembly does not serve the namespace, so
  // the remedy is the tool, not `workflow_init`.
  assert.equal(projectFailureText({ error: 'anything' }, false, t), '[projectNoReader]')

  // The file is absent -> "this project has not opted in", whose remedy is workflow_init.
  // The decision is made from the namespace's own stable FAILURE CODE (or its explicit
  // absence flag), not by finding words in a diagnostic message.
  for (const outcome of [
    { code: 'workspace-file/not-found', error: 'whatever the host chose to say' },
    { code: 'fs/enoent', error: '' },
    { absent: true, error: '' },
    { error: 'ENOENT: no such file, open C:\\ws\\.dsh\\workflow.yml' },
  ]) {
    assert.equal(
      projectFailureText(outcome, true, t),
      '[projectNotOptedIn]',
      `${JSON.stringify(outcome)} must be reported as "not opted in"`,
    )
  }

  // Anything else is a refusal or a fault, and is reported VERBATIM — a permission failure
  // must not be presented as an absent file, because the two have different fixes and one
  // of them is not workflow_init.
  for (const message of ['permission denied', 'not found in the sandbox policy', 'gateway/cancelled']) {
    const refused = projectFailureText({ error: message }, true, t)
    assert.match(refused, new RegExp(message.replace(/[/\\]/g, '.')))
    assert.ok(!refused.includes('[projectNotOptedIn]'), `a refusal must not be reported as a missing file: ${message}`)
  }

  // A malformed outcome is still a failure with something readable in it.
  for (const outcome of [undefined, null, 'a string', 7]) {
    const text = projectFailureText(outcome, true, t)
    assert.ok(text.length > 0, `${JSON.stringify(outcome)} must still render a message`)
  }
})

// ---------------------------------------------------------------------------
// THE EFFECTIVE CONFIGURATION — every mirror is pinned by a DIFFERENTIAL test
// ---------------------------------------------------------------------------
//
// The tab answers "what is actually in force for this project", and it answers it by COPYING
// host resolution into the browser bundle: the project file over the plugin defaults. A copy
// drifts, and a drifted copy does not fail loudly — it prints a plausible configuration that the
// plugin is not running, which is worse than printing nothing, because the user acts on it.
//
// So every rule below is pinned by running the HOST'S OWN FUNCTION and the browser copy over the
// same inputs and comparing the answers. A change to `lib/project.js`, `lib/config.js`,
// `lib/workflow-file.js`, `lib/approval.js`, `lib/approval-state.js` or `lib/gate.js` fails HERE,
// in the file that has to be edited next to it.

/** A full, resolved configuration — what the settings snapshot's `value` carries. */
function resolvedDefaults(overrides = {}) {
  return resolveConfig(overrides)
}

test('the browser YAML reader parses exactly what the host parses', () => {
  const { parseProjectYaml } = panelHelpers()
  const cases = [
    '',
    '\n',
    '# only a comment\n',
    'tier: standard\n',
    'tier:standard\n',
    'tier:\n',
    'tier: minimal\nrecipe: hotfix\n',
    'approval:\n  strength: llm-only\n  exemptTools: []\n',
    'approval:\n  strength: off\nmodules:\n  planner: false\n  isolation: true\n',
    'mustPass:\n  - correctness\n  - build\n',
    'evaluator:\n  dimensions:\n    - correctness\n    - build\n  mustPass:\n    - build\n',
    'exemptTools:\n  - a\n  - b\n',
    'exemptTools:\n  - key: value\n',
    'exemptTools:\n  -\n',
    'exemptTools:\n  - [a, b]\n',
    'exemptTools: [a, b]\n',
    'exemptTools: []\n',
    'x: "quoted # not a comment"\n',
    "y: 'single'\n",
    'z: value # trailing comment\n',
    'w: a#nospace\n',
    'bar: 8\n',
    'bar: 8.5\n',
    'flag: true\nother: false\nnone: null\ntilde: ~\n',
    'nested:\n  deep:\n    key: 1\n',
    'a: 1\n  b: 2\n',
    '\ttabbed: 1\n',
    'no colon here\n',
    '  indented: 1\n',
    '- item\n',
    'list:\n  -\n',
    'tier: standard\r\napproval:\r\n  strength: off\r\n',
    'tier: standard\r\n',
    'unknown_top_level: 1\nallowance: yes\n',
    'a: 1\na: 2\n',
    'approval: nope\n',
    'evaluator:\n  bar: abc\n',
    'approval:\n  denyHighAlways: "false"\n',
    'vendor:\n  region: cn\n',
  ]
  for (const text of cases) {
    assert.deepEqual(
      parseProjectYaml(text),
      parseWorkflowYaml(text),
      `the browser reader disagrees with lib/project.js for ${JSON.stringify(text)}`,
    )
  }
  // The writer's own output is the format the reader must round-trip, so the mirror is also run
  // over a real serialised document rather than only over hand-written fragments.
  const serialised = [
    'tier: strict\n',
    'approval:\n  strength: llm-only\n  exemptTools:\n    - workflow_status\n',
    'evaluator:\n  dimensions:\n    - correctness\n    - scope\n',
  ].join('')
  assert.deepEqual(parseProjectYaml(serialised), parseWorkflowYaml(serialised))
  assert.deepEqual(parseProjectYaml(null), { value: {}, problems: [] }, 'a non-string is an empty document')
})

test('the browser merge resolves exactly what the host resolves', () => {
  const { projectEffectiveConfig } = panelHelpers()
  // The defaults layer in the browser is the settings snapshot, which does NOT carry `rowKind`
  // (the host keeps that field out of the exported schema on purpose). Everything else is the
  // same object on both sides, so the comparison drops `rowKind` from the host's answer and
  // nothing else.
  const defaults = resolvedDefaults()
  delete defaults.rowKind

  const projects = [
    null,
    undefined,
    {},
    'nope',
    ['tier'],
    { tier: 'strict' },
    { tier: 'strict', recipe: null },
    { modules: { planner: false } },
    { modules: { planner: false, isolation: false } },
    { approval: { strength: 'off' } },
    { approval: 'nope' },
    { approval: { exemptTools: ['workflow_status'] } },
    { evaluator: { bar: 9, mustPass: [] } },
    { evaluator: { dimensions: ['correctness'] } },
    { subagent: { maxDepth: 1 } },
    { retireCheck: { everyDays: 7 } },
    { unknown_key: 1 },
    { tier: undefined },
    { context: { exclude: ['tool_history'] } },
  ]
  for (const project of projects) {
    const host = resolveEffectiveConfig(resolvedDefaults(), project).config
    delete host.rowKind
    assert.deepEqual(
      projectEffectiveConfig(defaults, project),
      host,
      `the browser merge disagrees with lib/workflow-file.js for ${JSON.stringify(project)}`,
    )
  }

  // The snapshot the browser reads is FROZEN, so the merge may not write through it.
  const frozen = Object.freeze({
    modules: Object.freeze({ planner: true, isolation: true }),
    evaluator: Object.freeze({ dimensions: Object.freeze(['correctness']) }),
  })
  const merged = projectEffectiveConfig(frozen, { modules: { planner: false } })
  assert.deepEqual(merged, {
    modules: { planner: false, isolation: true },
    evaluator: { dimensions: ['correctness'] },
  })
  assert.deepEqual(frozen, {
    modules: { planner: true, isolation: true },
    evaluator: { dimensions: ['correctness'] },
  })
})

test('the layer marker names the layer the merge actually used', () => {
  const { projectLeafSource } = panelHelpers()
  const project = {
    tier: 'strict',
    modules: { planner: false },
    evaluator: { mustPass: ['build'] },
    approval: 'nope',
    exemptTools: [],
    nothing: null,
  }

  // Named by the project, at the top level and one level down.
  assert.equal(projectLeafSource(project, ['tier']), 'project')
  assert.equal(projectLeafSource(project, ['modules', 'planner']), 'project')
  assert.equal(projectLeafSource(project, ['evaluator', 'mustPass']), 'project')
  assert.equal(projectLeafSource(project, ['exemptTools']), 'project', 'an empty list is a value, not an absence')
  assert.equal(projectLeafSource(project, ['nothing']), 'project', 'null is a value the merge assigns')
  // A SECTION the project wrote is itself the project's — including an empty one, which the merge
  // assigns wholesale (`evaluator: {}` is malformed to the gate, not "no evaluator settings").
  assert.equal(projectLeafSource(project, ['modules']), 'project')
  assert.equal(projectLeafSource({ evaluator: {} }, ['evaluator']), 'project')

  // Not named -> inherited, including a sibling of a key the project DID set.
  assert.equal(projectLeafSource(project, ['recipe']), 'inherited')
  assert.equal(projectLeafSource(project, ['modules', 'isolation']), 'inherited')
  assert.equal(projectLeafSource(project, ['evaluator', 'bar']), 'inherited')
  // ...while a path BELOW a value the project assigned wholesale belongs to the project: the
  // merge does not descend into an array, so `mustPass[0]` is the project's entry.
  assert.equal(projectLeafSource(project, ['evaluator', 'mustPass', '0']), 'project')

  // An ancestor replaced by a NON-SECTION: `mergeInto` assigns these wholesale, so everything
  // below them came from the project even though the deeper key is not written.
  assert.equal(projectLeafSource(project, ['approval', 'strength']), 'project')
  assert.equal(projectLeafSource({ modules: [] }, ['modules', 'planner']), 'project')
  assert.equal(projectLeafSource({ modules: null }, ['modules', 'planner']), 'project')

  // Nothing to read: no project, no path, or a path through a scalar.
  assert.equal(projectLeafSource(null, ['tier']), 'inherited')
  assert.equal(projectLeafSource(project, []), 'inherited')
  assert.equal(projectLeafSource(project, undefined), 'inherited')
  // A path THROUGH a value the project assigned wholesale is the project's, by the same ancestor
  // rule as above — the merge never descends into `tier`, so nothing under it is inherited.
  assert.equal(projectLeafSource({ tier: 'strict' }, ['tier', 'deeper']), 'project')
  assert.equal(projectLeafSource(project, ['modules', 'planner', 'deeper']), 'project')
})

test('every leaf of the tree is enumerated, and an empty section is a leaf', () => {
  const { projectConfigLeaves } = panelHelpers()
  assert.deepEqual(projectConfigLeaves({ a: 1, b: { c: 2, d: [1, 2] } }), [
    { path: ['a'], value: 1 },
    { path: ['b', 'c'], value: 2 },
    { path: ['b', 'd'], value: [1, 2] },
  ])
  // `evaluator: {}` is malformed to the gate, not "no evaluator settings": dropping it would
  // hide the refusal.
  assert.deepEqual(projectConfigLeaves({ evaluator: {} }), [{ path: ['evaluator'], value: {} }])
  assert.deepEqual(projectConfigLeaves({}), [])
  assert.deepEqual(projectConfigLeaves(null), [])
  assert.deepEqual(projectConfigLeaves('nope'), [])
})

test('a value is rendered as the plugin holds it, never re-worded', () => {
  const { projectValueText } = panelHelpers()
  assert.equal(projectValueText(true), 'true', 'a boolean stays a boolean: the page is checkable against the config')
  assert.equal(projectValueText(false), 'false')
  assert.equal(projectValueText(8), '8')
  assert.equal(projectValueText(8.5), '8.5')
  assert.equal(projectValueText('strict'), 'strict')
  assert.equal(projectValueText(null), 'null')
  assert.equal(projectValueText(undefined), '—')
  assert.equal(projectValueText([]), '[]', 'an empty list is meaningful on exemptTools and mustPass')
  assert.equal(projectValueText(['a', 'b']), '[a, b]')
  assert.equal(projectValueText({}), '{}')
  assert.equal(projectValueText({ a: 1 }), '{"a":1}')
})

// ---------------------------------------------------------------------------
// the approval mirror: the values IN FORCE, not the values the file asked for
// ---------------------------------------------------------------------------

test('the approval mirror refuses exactly what the host refuses', () => {
  const { projectApprovalGate } = panelHelpers()
  const defaults = DEFAULT_CONFIG.approval

  const sections = [
    undefined,
    null,
    {},
    'nope',
    7,
    [],
    { strength: 'off' },
    { strength: 'maybe' },
    { strength: 1 },
    { strength: 'ask-user', riskThreshold: 'low', denyHighAlways: true, exemptTools: [] },
    { riskThreshold: 'banana' },
    { riskThreshold: 'high' },
    { denyHighAlways: 'false' },
    { denyHighAlways: false },
    { denyHighAlways: null },
    { exemptTools: ['grep'] },
    { exemptTools: [] },
    { exemptTools: ['grep', 7] },
    { exemptTools: 'grep' },
    { strength: 'llm-only', exemptTools: ['a', 'b'] },
  ]
  for (const section of sections) {
    const host = readApprovalGate(section, defaults)
    const mine = projectApprovalGate(section, [], defaults)
    assert.equal(mine.usable, host.usable, `the mirror and lib/approval.js disagree about ${JSON.stringify(section)}`)
    assert.deepEqual(
      [mine.strength, mine.riskThreshold, mine.denyHighAlways, mine.exemptTools],
      [host.strength, host.riskThreshold, host.denyHighAlways, host.exemptTools],
      `the mirror's values disagree with the host gate for ${JSON.stringify(section)}`,
    )
  }

  // THE FILE-LEVEL RULE, which is the one rule that is not `readApprovalGate`'s: a file that
  // could not be fully read refuses the section WHATEVER it says, so a typo can never select a
  // looser strength than the project asked for. Compared against the host function itself.
  for (const problems of [[], ['line 3: not a "key: value" mapping ("  oops")']]) {
    const projectValue = { approval: { strength: 'off' } }
    const host = readApprovalForProject(resolvedDefaults(), { present: true, value: projectValue, problems }, defaults)
      .gate
    const mine = projectApprovalGate({ ...defaults, strength: 'off' }, problems, defaults)
    assert.equal(mine.usable, host.usable, `the file rule disagrees (problems: ${JSON.stringify(problems)})`)
    assert.deepEqual(
      [mine.strength, mine.riskThreshold, mine.denyHighAlways, mine.exemptTools],
      [host.strength, host.riskThreshold, host.denyHighAlways, host.exemptTools],
      'the file rule must produce the same values the host runs on',
    )
  }
  assert.equal(projectApprovalGate({ strength: 'off' }, ['something'], defaults).usable, false)
  assert.equal(projectApprovalGate({ strength: 'off' }, ['something'], defaults).strength, 'ask-user')

  // THE AXIS NAMES the renderer builds its rows from are the host gate's own keys — a fifth
  // field added to `readApprovalGate` fails here instead of going unrendered.
  const source = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
  const axes = /section\.rows = \[([^\]]+)\]\.map\(/.exec(clientFunction(source, 'projectConfigView'))
  assert.ok(axes, 'projectConfigView no longer builds the approval axes from one list')
  const named = [...axes[1].matchAll(/'([^']+)'/g)].map(match => match[1])
  assert.deepEqual(
    named,
    ['strength', 'riskThreshold', 'denyHighAlways', 'exemptTools'],
    'the rendered axes must be the four fields the host gate reads',
  )
  assert.deepEqual(
    Object.keys(readApprovalGate({}, defaults)).filter(key => !['ok', 'usable', 'problems'].includes(key)),
    named,
  )
})

test('the approval mirror reports UNKNOWN rather than a guessed value when it cannot decide', () => {
  const { projectConfigView, projectRowText } = panelHelpers()
  // A defaults layer with no `approval` section cannot resolve an absent field, so the page must
  // not fall back to documented defaults it cannot read.
  const view = projectConfigView(
    { state: 'ok', text: 'tier: strict\n' },
    { state: 'ready', value: { tier: 'standard' } },
  )
  assert.equal(view.unknownDefaults, false)
  assert.equal(view.sections.find(section => section.key === 'approval'), undefined)

  // ...and when the PROJECT does set the section, the page still refuses to judge it: the host
  // falls back to its built-in defaults for the fields the section lacks, and those are a host
  // module this bundle cannot read. Reporting four fail-closed axes instead would be a refusal the
  // host never made, so the rows say unknown and the section says why.
  const missing = projectConfigView(
    { state: 'ok', text: 'approval:\n  strength: off\n' },
    { state: 'ready', value: { tier: 'standard' } },
  )
  const section = missing.sections.find(entry => entry.key === 'approval')
  assert.ok(section, 'the project\u2019s own approval section is still shown')
  assert.equal(section.note.key, 'projectConfigSectionUnknown')
  assert.deepEqual(section.note.detail, ['approval'])
  assert.deepEqual(section.rows.map(row => row.dotted), ['approval.strength'])
  assert.equal(section.rows[0].source, 'unknown', 'not "this project set it": the VALUE in force is unknown')
  assert.equal(section.rows[0].value, null, 'an unresolved row carries no value at all')
  assert.deepEqual(projectRowText(section.rows[0]).value, null)
  assert.equal(missing.counts.unknown, 1)
  assert.equal(missing.counts.refused, 0)

  // The SAME rule for `evaluator`, with ONE deliberate difference, and it is the difference
  // between the two mirrors: an unusable `evaluator` section is REFUSED by the host, not
  // substituted, so the value the file wrote is still the value in force. Only the verdict (is this
  // section runnable?) is unknown here, which is what the note reports — so the row stays `project`
  // with its real value rather than being blanked.
  const evaluator = projectConfigView(
    { state: 'ok', text: 'evaluator:\n  bar: 9\n' },
    { state: 'ready', value: { tier: 'standard' } },
  )
  const evaluatorSection = evaluator.sections.find(entry => entry.key === 'evaluator')
  assert.equal(evaluatorSection.note.key, 'projectConfigSectionUnknown')
  assert.equal(evaluatorSection.rows[0].source, 'project')
  assert.equal(evaluatorSection.rows[0].value, 9)
})

// ---------------------------------------------------------------------------
// the evaluator mirror: the host refuses the section, it does not substitute it
// ---------------------------------------------------------------------------

test('the evaluator mirror refuses exactly what the host refuses', () => {
  const { projectEvaluatorProblems, parseProjectYaml } = panelHelpers()
  const defaults = DEFAULT_CONFIG.evaluator

  const sections = [
    undefined,
    null,
    {},
    'nope',
    7,
    [],
    { bar: 8 },
    { bar: 0 },
    { bar: 10 },
    { bar: 10.5 },
    { bar: -1 },
    { bar: 'abc' },
    { bar: '8' },
    { bar: true },
    { bar: Number.NaN },
    { maxRounds: 1 },
    { maxRounds: 2 },
    { maxRounds: 0 },
    { maxRounds: 1.5 },
    { maxRounds: '2' },
    { dimensions: ['correctness'] },
    { dimensions: [] },
    { dimensions: 'correctness' },
    { dimensions: ['correctness', 7] },
    { mustPass: [] },
    { mustPass: ['correctness'] },
    { mustPass: ['scope'] },
    { mustPass: 'build' },
    { mustPass: [['correctness'], 'build'] },
    { independent: false, bar: 5 },
  ]
  for (const section of sections) {
    const host = readEvaluatorGate(section, defaults)
    const mine = projectEvaluatorProblems(section, defaults)
    assert.equal(
      mine.length === 0,
      host.ok,
      `the mirror and lib/gate.js disagree about ${JSON.stringify(section)}: ${JSON.stringify(mine)} vs ${JSON.stringify(host.problems)}`,
    )
    if (!host.ok) assert.ok(mine.length > 0, 'a refused section must report at least one reason')
  }

  // ...AND OVER THE HAND-EDITED FILES this file already uses as its malformed table, so a value
  // that only becomes malformed after YAML parsing is covered too.
  for (const yaml of MALFORMED_EVALUATOR) {
    const section = parseProjectYaml(yaml).value.evaluator
    const host = readEvaluatorGate(section, defaults)
    const mine = projectEvaluatorProblems(section, defaults)
    assert.equal(mine.length === 0, host.ok, `the mirror disagrees for the file ${JSON.stringify(yaml)}`)
  }

  // The reasons name the offending configuration paths, so the page can list them.
  assert.deepEqual(projectEvaluatorProblems('nope', defaults), ['section'])
  assert.deepEqual(projectEvaluatorProblems({ bar: 'abc', maxRounds: 0 }, defaults), ['bar', 'maxRounds'])
  assert.deepEqual(
    projectEvaluatorProblems({ dimensions: ['correctness'], mustPass: ['scope'] }, defaults),
    ['mustPass-not-scored'],
    'a veto on a dimension nothing scores makes every review fail without saying why',
  )
  assert.deepEqual(
    projectEvaluatorProblems({ dimensions: [], mustPass: ['scope'] }, defaults),
    ['dimensions'],
    'an empty scored set is refused first: the host returns before it can judge the veto set',
  )
  assert.deepEqual(projectEvaluatorProblems(undefined, defaults), [], 'absent is not malformed')
})

test('every constant and vocabulary the mirror uses is pinned to the host\u2019s own', () => {
  const helpers = panelHelpers()
  assert.deepEqual(helpers.APPROVAL_STRENGTH_VALUES, [...APPROVAL_STRENGTHS])
  assert.deepEqual(helpers.RISK_LEVEL_VALUES, [...RISK_LEVELS])
  assert.equal(helpers.BAR_MIN, BAR_MIN)
  assert.equal(helpers.BAR_MAX, BAR_MAX)
  assert.deepEqual(
    { ...helpers.FAIL_CLOSED_APPROVAL, exemptTools: [...helpers.FAIL_CLOSED_APPROVAL.exemptTools] },
    { ...FAIL_CLOSED_APPROVAL, exemptTools: [...FAIL_CLOSED_APPROVAL.exemptTools] },
    'the fail-closed values the page prints must be the host\u2019s',
  )
  assert.equal(helpers.FAIL_CLOSED_APPROVAL.exemptTools.length, 0)
  assert.equal(Object.isFrozen(helpers.FAIL_CLOSED_APPROVAL), true)

  // The settings panel labels the same vocabulary; a change to the host enums has to reach all
  // three lists, and this is what makes that fail here instead of in the UI.
  const source = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8')
  const strengthOptions = new Function(`return ${sourceConst(source, 'STRENGTH_OPTIONS')}`)()
  const riskOptions = new Function(`return ${sourceConst(source, 'RISK_OPTIONS')}`)()
  assert.deepEqual(strengthOptions.map(([value]) => value), [...APPROVAL_STRENGTHS])
  assert.deepEqual(riskOptions.map(([value]) => value), [...RISK_LEVELS])

  // ...and the bar rule the panel's number input enforces is `checkBar`'s range with
  // `checkMaxRounds`' integrality, both read from `lib/gate.js` above.
  for (const value of [0, 5, 8, 10, 8.5, -1, 11, 10.5]) {
    assert.equal(checkBar(value).ok, value >= BAR_MIN && value <= BAR_MAX, `checkBar disagrees for ${value}`)
  }
  for (const value of [1, 2, 0, 1.5, -1, '2']) {
    assert.equal(checkMaxRounds(value).ok, Number.isInteger(value) && value >= 1, `checkMaxRounds disagrees for ${value}`)
  }
})

// ---------------------------------------------------------------------------
// the page model: what is rendered, and what is refused
// ---------------------------------------------------------------------------

test('no configuration table is rendered without a readable project file', () => {
  const { projectConfigView } = panelHelpers()
  const defaults = { state: 'ready', value: resolvedDefaults() }

  // ABSENT -> "not opted in". A table of inherited defaults under that heading would read as
  // though this project had chosen them, which is the defect this page exists to correct.
  const absent = projectConfigView({ state: 'failed', absent: true, code: 'workspace-file/not-found' }, defaults)
  assert.equal(absent.state, 'not-opted-in')
  assert.deepEqual(absent.sections, [], 'an absent file must not produce a table of defaults')

  // REFUSED or unreadable -> no table either: the tab cannot know what the file says.
  for (const outcome of [
    { state: 'failed', error: 'permission denied' },
    { state: 'failed', code: 'workspace-file/unknown' },
    { state: 'failed' },
    null,
    undefined,
    'a string',
  ]) {
    const view = projectConfigView(outcome, defaults)
    assert.equal(view.state, 'unreadable', `${JSON.stringify(outcome)} must not be reported as opted in`)
    assert.deepEqual(view.sections, [])
  }
  // An ENOENT message is the secondary absence signal, and it reaches the view through the same
  // one classifier the failure text uses.
  assert.equal(projectConfigView({ state: 'failed', error: 'ENOENT: no such file' }, defaults).state, 'not-opted-in')
  assert.equal(projectConfigView({ state: 'failed', error: 'no such file' }, defaults).state, 'unreadable')
})

test('the defaults layer is read from the snapshot and never guessed when it is not ready', () => {
  const { projectDefaultsState, projectDefaultsController, projectConfigView } = panelHelpers()

  // THE CONTRACT, from `dsh-client-ui-settings`: snapshots carry `value`, `base`, `user`,
  // `revision`, writability and persistence mode, and the store is seeded
  // `{ status: 'loading', value: undefined }`.
  assert.deepEqual(projectDefaultsState(null), { state: 'unavailable', value: null })
  assert.deepEqual(projectDefaultsState({ status: 'unavailable' }), { state: 'unavailable', value: null })
  assert.deepEqual(projectDefaultsState({ status: 'loading' }), { state: 'loading', value: null })
  assert.deepEqual(projectDefaultsState({ status: 'idle' }), { state: 'loading', value: null })
  assert.deepEqual(
    projectDefaultsState({ status: 'ready' }),
    { state: 'unavailable', value: null },
    'a non-object value is not a configuration',
  )
  assert.deepEqual(projectDefaultsState({ status: 'ready', value: 'nope' }), { state: 'unavailable', value: null })
  assert.deepEqual(projectDefaultsState({ status: 'ready', value: [] }), { state: 'unavailable', value: null })
  assert.deepEqual(
    projectDefaultsState({ status: 'ready', value: { tier: 'standard' } }),
    { state: 'ready', value: { tier: 'standard' } },
  )

  // A NON-READY SNAPSHOT CAN STILL CARRY A VALUE, and reading one is how a page reports a
  // configuration that is not in force — the same rule `panelVisible` follows.
  assert.deepEqual(
    projectDefaultsState({ status: 'loading', value: { tier: 'strict' } }),
    { state: 'loading', value: null },
    'a value on a loading snapshot must be ignored',
  )
  assert.equal(projectDefaultsState({ status: 'unavailable', value: { tier: 'strict' } }).value, null)

  // The controller is asked for by entry id, and a throwing service is a reader that cannot read
  // rather than a page that crashes.
  const controller = { marker: true }
  assert.equal(
    projectDefaultsController({ configForms: { get: id => (id === 'dsh-workflow-core' ? controller : undefined) } }),
    controller,
  )
  assert.equal(projectDefaultsController({}), undefined)
  assert.equal(projectDefaultsController(undefined), undefined)
  assert.equal(
    projectDefaultsController({
      configForms: {
        get: () => {
          throw new Error('boom')
        },
      },
    }),
    undefined,
  )

  // ...AND THE PAGE MODEL NEVER INVENTS THE MISSING LAYER. With the file readable and the
  // defaults unreadable, only what the project itself writes is shown, and every one of those
  // rows says so.
  const file = { state: 'ok', text: 'tier: strict\napproval:\n  strength: off\n' }
  for (const defaults of [{ state: 'loading' }, { state: 'unavailable' }]) {
    const view = projectConfigView(file, defaults)
    assert.equal(view.unknownDefaults, true)
    assert.equal(view.defaultsState, defaults.state)
    assert.ok(view.sections.length > 0, 'the project\u2019s own overrides are still worth showing')
    const rows = view.sections.flatMap(section => section.rows)
    assert.ok(rows.length > 0)
    for (const row of rows) {
      assert.equal(row.source, 'project', `${row.dotted} must not claim an inherited value`)
      assert.equal(row.previousKnown, false, 'the shadowed default is unknown, and must be reported as such')
    }
    assert.deepEqual(rows.map(row => row.dotted), ['tier', 'approval.strength'])
    assert.deepEqual(view.counts, { project: 2, inherited: 0, unknown: 0, refused: 0 })
  }
})

test('the effective view marks each row with the layer that won it', () => {
  const { projectConfigView } = panelHelpers()
  const defaults = {
    state: 'ready',
    value: {
      tier: 'standard',
      recipe: null,
      modules: { planner: true, isolation: true },
      approval: { strength: 'ask-user', riskThreshold: 'medium', denyHighAlways: true, exemptTools: [] },
      evaluator: {
        independent: true,
        bar: 8,
        maxRounds: 2,
        dimensions: ['correctness', 'build'],
        mustPass: ['build'],
      },
      retireCheck: { enabled: true, everyDays: 30 },
    },
  }
  const file = {
    state: 'ok',
    text: [
      'tier: strict',
      'modules:',
      '  planner: false',
      'approval:',
      '  strength: llm-only',
      'retireCheck:',
      '  everyDays: 7',
      '',
    ].join('\n'),
  }
  const view = projectConfigView(file, defaults)
  assert.equal(view.state, 'ready')
  assert.equal(view.unknownDefaults, false)
  assert.deepEqual(view.problems, [], 'a well-formed file parses cleanly')

  const rows = new Map(view.sections.flatMap(section => section.rows).map(row => [row.dotted, row]))
  // Named by the file, at both depths.
  assert.equal(rows.get('tier').source, 'project')
  assert.equal(rows.get('tier').value, 'strict')
  assert.equal(rows.get('tier').previous, 'standard', 'the override shows what it replaced')
  assert.equal(rows.get('modules.planner').source, 'project')
  assert.equal(rows.get('modules.planner').value, false)
  assert.equal(rows.get('approval.strength').source, 'project')
  assert.equal(rows.get('approval.strength').value, 'llm-only')
  assert.equal(rows.get('retireCheck.everyDays').source, 'project')
  // ...and everything else is inherited, WITH its value still resolved.
  assert.equal(rows.get('modules.isolation').source, 'inherited')
  assert.equal(rows.get('modules.isolation').value, true)
  assert.equal(rows.get('approval.riskThreshold').source, 'inherited')
  assert.equal(rows.get('approval.riskThreshold').value, 'medium')
  assert.equal(rows.get('evaluator.bar').source, 'inherited')
  assert.equal(rows.get('evaluator.bar').value, 8)
  assert.equal(rows.get('retireCheck.enabled').source, 'inherited')

  // THE COUNTS ARE THE SAME STATEMENT AS THE ROWS, so the summary line cannot disagree with the
  // table under it.
  const counted = { project: 0, inherited: 0, unknown: 0, refused: 0 }
  for (const row of rows.values()) counted[row.source === 'fail-closed' ? 'refused' : row.source] += 1
  assert.deepEqual(view.counts, counted)

  // Section order follows the DEFAULTS layer's key order (the plugin's own declaration order),
  // and `approval` keeps its place instead of being appended where the gate was built.
  assert.deepEqual(
    view.sections.map(section => section.key),
    ['tier', 'recipe', 'modules', 'approval', 'evaluator', 'retireCheck'],
  )

  // A file that declares nothing still produces the effective table — the project opted in by
  // existing, and "everything is inherited" is the answer.
  const empty = projectConfigView({ state: 'ok', text: '' }, defaults)
  assert.equal(empty.state, 'ready')
  assert.equal(empty.counts.project, 0)
  assert.ok(empty.counts.inherited > 0)
})

test('a refused approval section shows the fail-closed values and what the file asked for', () => {
  const { projectConfigView, projectRowText } = panelHelpers()
  const defaults = {
    state: 'ready',
    value: {
      tier: 'standard',
      approval: { strength: 'ask-user', riskThreshold: 'medium', denyHighAlways: true, exemptTools: [] },
    },
  }

  // The file parses, but its approval section is not a section. The host refuses it and runs the
  // fail-closed values; the page must show THOSE, and keep the file's value as what it asked for.
  const broken = projectConfigView({ state: 'ok', text: 'approval: nope\n' }, defaults)
  const brokenSection = broken.sections.find(section => section.key === 'approval')
  assert.deepEqual(brokenSection.rows.map(row => row.dotted), [
    'approval.strength',
    'approval.riskThreshold',
    'approval.denyHighAlways',
    'approval.exemptTools',
  ])
  for (const row of brokenSection.rows) {
    assert.equal(row.source, 'fail-closed', `${row.dotted} must not be reported as this project\u2019s choice`)
    assert.equal(row.previous, null, 'a fail-closed row carries no shadowed default to compare against')
    assert.equal(projectRowText(row).shadow, null)
  }
  const strength = brokenSection.rows[0]
  assert.equal(strength.value, 'ask-user', 'the value IN FORCE is the fail-closed one')
  // There is no per-axis value to name when the WHOLE section is a scalar: the four rows would
  // each repeat `nope`, so the section note carries it instead and every row says `null`.
  assert.equal(strength.asked, null)
  assert.equal(projectRowText(strength).asked, null)
  assert.equal(projectRowText(strength).value, 'ask-user')
  assert.equal(projectRowText(strength).shadow, null)
  assert.equal(broken.counts.refused, 4)
  assert.equal(brokenSection.note.key, 'projectApprovalRefused')
  assert.match(brokenSection.note.detail.join(';'), /approval: nope/)

  // A FILE THAT COULD NOT BE READ refuses the section too, even though what parsed reads fine —
  // and the note carries the reader's own complaint.
  const unreadable = projectConfigView({ state: 'ok', text: 'approval:\n  strength: off\n  oops\n' }, defaults)
  assert.ok(unreadable.problems.length > 0, 'the reader must report the line it could not read')
  const refusedSection = unreadable.sections.find(section => section.key === 'approval')
  assert.equal(refusedSection.rows.every(row => row.source === 'fail-closed'), true)
  assert.equal(refusedSection.rows[0].asked, 'off', 'the parsed value is still shown as what was asked')
  assert.equal(refusedSection.note.key, 'projectApprovalRefused')
  assert.equal(unreadable.counts.refused, 4)

  // A LEGAL SECTION IS NOT REFUSED, and its malformed sibling FIELD is: `denyHighAlways: 'false'`
  // is a string, and every truthiness test on it would read as "deny" while every comparison
  // reads as "not true", which is why the host refuses the whole section.
  const field = projectConfigView({ state: 'ok', text: 'approval:\n  denyHighAlways: "false"\n' }, defaults)
  assert.equal(field.counts.refused, 4)
  assert.match(
    field.sections.find(section => section.key === 'approval').note.detail.join(';'),
    /approval\.denyHighAlways/,
  )
  const legal = projectConfigView({ state: 'ok', text: 'approval:\n  strength: off\n' }, defaults)
  assert.equal(legal.counts.refused, 0)
  const legalSection = legal.sections.find(section => section.key === 'approval')
  assert.equal(legalSection.note, null)
  assert.equal(legalSection.rows[0].value, 'off')
  assert.equal(legalSection.rows[0].source, 'project')
})

test('an evaluator section the host would refuse is marked, not silently printed', () => {
  const { projectConfigView } = panelHelpers()
  const defaults = {
    state: 'ready',
    value: {
      tier: 'standard',
      evaluator: { independent: true, bar: 8, maxRounds: 2, dimensions: ['correctness'], mustPass: [] },
    },
  }
  const view = projectConfigView({ state: 'ok', text: 'evaluator:\n  bar: abc\n' }, defaults)
  const section = view.sections.find(entry => entry.key === 'evaluator')
  assert.ok(section, 'the evaluator section is still rendered')
  assert.equal(section.note.key, 'projectEvaluatorRefused')
  assert.deepEqual(section.note.detail, ['evaluator.bar'])
  // The VALUES are not substituted — the host refuses the section rather than replacing it, so
  // the page shows what the file says and says that it cannot run.
  const bar = section.rows.find(row => row.dotted === 'evaluator.bar')
  assert.equal(bar.source, 'project')
  assert.equal(bar.value, 'abc')
  assert.equal(view.counts.refused, 0)

  const ok = projectConfigView({ state: 'ok', text: 'evaluator:\n  bar: 9\n' }, defaults)
  assert.equal(ok.sections.find(entry => entry.key === 'evaluator').note, null)

  // A NON-OBJECT section is refused by the mirror AND visible on the page, because the leaf
  // reader keeps `evaluator: nope` as a leaf.
  const scalar = projectConfigView({ state: 'ok', text: 'evaluator: nope\n' }, defaults)
  assert.deepEqual(scalar.sections.find(entry => entry.key === 'evaluator').note.detail, ['evaluator'])
  assert.equal(scalar.sections.find(entry => entry.key === 'evaluator').rows[0].value, 'nope')

  // Unknown top-level keys the host's schema does not declare are still shown rather than
  // dropped: a typo in a key name is exactly the kind of thing the file alone cannot reveal.
  const extra = projectConfigView({ state: 'ok', text: 'tierr: strict\n' }, defaults)
  assert.deepEqual(extra.sections.find(entry => entry.key === 'tierr').rows.map(row => row.dotted), ['tierr'])
  assert.equal(extra.sections.find(entry => entry.key === 'tierr').rows[0].source, 'project')
})

test('the aside under a value is shown only when it says something', () => {
  const { projectRowText } = panelHelpers()
  // A re-stated default overrides nothing observable, so the shadow is noise and is dropped.
  assert.deepEqual(
    projectRowText({ source: 'project', value: 'standard', previous: 'standard', previousKnown: true, asked: null }),
    { value: 'standard', shadow: null, asked: null },
  )
  // A real override prints the default it replaced, structurally compared so an array is not
  // compared by identity.
  assert.deepEqual(
    projectRowText({ source: 'project', value: false, previous: true, previousKnown: true, asked: null }),
    { value: 'false', shadow: 'true', asked: null },
  )
  assert.deepEqual(
    projectRowText({ source: 'project', value: ['b'], previous: ['b'], previousKnown: true, asked: null }),
    { value: '[b]', shadow: null, asked: null },
  )
  // An inherited row never prints a shadow: the default IS the value.
  assert.deepEqual(
    projectRowText({ source: 'inherited', value: 8, previous: 8, previousKnown: true, asked: null }),
    { value: '8', shadow: null, asked: null },
  )
  // An unresolved row prints no value at all — the renderer substitutes its own word for it.
  assert.deepEqual(
    projectRowText({ source: 'unknown', value: 8, previousKnown: false, asked: null }),
    { value: null, shadow: null, asked: null },
  )
  assert.deepEqual(projectRowText(null), { value: null, shadow: null, asked: null })
})
