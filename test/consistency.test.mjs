/**
 * Cross-surface consistency: the WRITER and the GATE must agree on what a usable
 * configuration value is.
 *
 * WHY THIS FILE EXISTS
 * Four independent review rounds each found the SAME fail-open class through a
 * different value, because four surfaces each implemented their own check:
 *
 *   1. the review gate (`runReview`)
 *   2. `decideVerdict`, the exported scorer
 *   3. `workflow_set`'s validator — the writer
 *   4. the settings panel's number input — a second writer
 *
 * Round 2's `bar: abc`, round 3's `bar: ""` / `[]` / `true`, round 4's filtered
 * `mustPass` and the panel's `Number('')` → `bar: 0` were all the same disagreement
 * expressed differently. Fixing them one at a time is how each round found another.
 *
 * The durable fix is one predicate in `lib/gate.js` used by every surface. These tests
 * assert the surfaces AGREE rather than that each is individually correct, so a future
 * divergence fails here instead of surviving to a review round.
 *
 * Run with `node --test test/`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  checkBar,
  checkMaxRounds,
  readStringList,
  readEvaluatorGate,
  describeValue,
  BAR_MAX,
  BAR_MIN,
} from '../lib/gate.js'
import { validateSettingValue } from '../lib/tools.js'
import { decideVerdict, runReview, DEFAULT_DIMENSIONS, DEFAULT_MUST_PASS } from '../lib/review.js'
import { readApprovalGate } from '../lib/approval.js'
import { DEFAULT_CONFIG } from '../lib/config.js'

/** Values that are not usable gates: coercible, out of range, or the wrong type. */
const UNUSABLE = [
  '', '   ', 'abc', '8', '0x8', '8abc', ' ', 'true', 'false', 'null', 'NaN', 'Infinity',
  [], [5], [8], [0], true, false, {}, { valueOf: () => 5 }, { toString: () => '8' },
  Number.NaN, Infinity, -Infinity, -1, -0.5, 10.5, 11, 99, Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER,
]

/** Values that ARE usable pass marks. */
const USABLE_BARS = [0, 1, 5, 7.5, 8, 9.9, 10]

test('checkBar accepts exactly the real numbers in range', () => {
  for (const value of USABLE_BARS) {
    assert.equal(checkBar(value).ok, true, `bar ${value} should be usable`)
  }
  for (const value of UNUSABLE) {
    const verdict = checkBar(value)
    assert.equal(verdict.ok, false, `bar ${describeValue(value)} (${typeof value}) must be refused`)
    assert.ok(verdict.detail, `a refusal must explain itself for ${describeValue(value)}`)
  }
})

test('checkBar bounds are inclusive and nothing outside them passes', () => {
  assert.equal(checkBar(BAR_MIN).ok, true, '0 is the most permissive legal gate')
  assert.equal(checkBar(BAR_MAX).ok, true, '10 is legal')
  assert.equal(checkBar(BAR_MIN - 0.001).ok, false)
  assert.equal(checkBar(BAR_MAX + 0.001).ok, false)
})

test('checkMaxRounds requires a whole number of at least one', () => {
  for (const value of [1, 2, 3, 11, 100]) {
    assert.equal(checkMaxRounds(value).ok, true, `${value} is a usable round budget`)
  }
  // No upper bound on rounds. The bar's out-of-range values (11, 99, MAX_SAFE_INTEGER)
  // are legitimate here, so the shared UNUSABLE list is filtered rather than reused.
  const notWhole = [0, -1, 1.5, 2.0000001, -0.5]
  const notNumbers = UNUSABLE.filter(value => typeof value !== 'number')
  const nonPositive = [-1]
  for (const value of [...notWhole, ...notNumbers, ...nonPositive]) {
    assert.equal(checkMaxRounds(value).ok, false, `maxRounds ${describeValue(value)} must be refused`)
  }
})

test('describeValue never throws, including on a BigInt', () => {
  // `JSON.stringify(0n)` throws, which crashed the very guard that exists to report a
  // bad gate value — a refusal turned into an exception, i.e. failing open.
  for (const value of [0n, 10n, Symbol('x'), () => {}, undefined, null, { a: 1n }]) {
    assert.doesNotThrow(() => describeValue(value))
    assert.equal(typeof describeValue(value), 'string')
  }
})

// ---------------------------------------------------------------------------
// the surfaces must AGREE
// ---------------------------------------------------------------------------

test('the gate and the writer agree on every bar value', () => {
  // The decisive consistency check. If a value can be WRITTEN but the gate refuses it,
  // a user's project looks configured and refuses every review; if it can be written and
  // the gate ACCEPTS it with different meaning, that is a fail-open. Both are failures.
  for (const value of [...USABLE_BARS, ...UNUSABLE]) {
    const writable = validateSettingValue(['evaluator', 'bar'], value) === null
    const gateAccepts = checkBar(value).ok
    assert.equal(
      writable,
      gateAccepts,
      `evaluator.bar ${describeValue(value)} (${typeof value}): writer ${writable ? 'accepts' : 'refuses'} ` +
        `but the gate ${gateAccepts ? 'accepts' : 'refuses'}`,
    )
  }
})

test('the gate and the writer agree on every maxRounds value', () => {
  // Rounds have no upper bound, so the bar's out-of-range values are meaningful here.
  for (const value of [1, 2, 3, 11, 0, -1, 1.5, ...UNUSABLE.filter(v => typeof v !== 'number')]) {
    const writable = validateSettingValue(['evaluator', 'maxRounds'], value) === null
    const gateAccepts = checkMaxRounds(value).ok
    assert.equal(
      writable,
      gateAccepts,
      `evaluator.maxRounds ${describeValue(value)}: writer ${writable}, gate ${gateAccepts}`,
    )
  }
})

test('the writer refuses every list the gate would refuse', () => {
  const lists = [
    [['correctness'], 'build'],
    [],
    'nope',
    ['ok', 1],
    { correctness: true },
    [null],
  ]
  for (const value of lists) {
    for (const path of ['evaluator.dimensions', 'evaluator.mustPass']) {
      const writable = validateSettingValue(path.split('.'), value) === null
      // The empty-list rule is PATH-DEPENDENT (`mustPass: []` is honoured,
      // `dimensions: []` is not), so the expected option is stated here rather than
      // omitted. Omitting it — as this test originally did — repeated the writer's own
      // mistake and made the comparison blind to the divergence it was meant to catch:
      // both sides refused `mustPass: []` while `readEvaluatorGate` accepted it, so the
      // assertion `writable === gateAccepts` held while the gate disagreed with itself.
      const gateAccepts = readStringList(path, value, [], {
        allowEmpty: path === 'evaluator.mustPass',
      }).ok
      assert.equal(
        writable,
        gateAccepts,
        `${path} ${describeValue(value)}: writer ${writable}, gate ${gateAccepts}`,
      )
    }
  }
})

test('readEvaluatorGate and the writer agree about an empty mustPass', () => {
  // The decisive non-tautological check for the round-6 blocker: the two FUNCTIONS that
  // read this setting must give the same answer, and the per-key writer must match them.
  const defaults = { bar: 8, maxRounds: 3, dimensions: DEFAULT_DIMENSIONS, mustPass: DEFAULT_MUST_PASS }
  const gate = readEvaluatorGate({ mustPass: [] }, defaults)

  assert.equal(gate.ok, true, 'an empty veto set is a coherent gate')
  assert.deepEqual(gate.mustPass, [], 'and it must survive as an empty set, not become the defaults')
  assert.equal(validateSettingValue(['evaluator', 'mustPass'], []), null)
  assert.equal(validateSettingValue(['evaluator'], { mustPass: [] }), null)

  // A non-object section is a malformation, not "no overrides".
  for (const bad of ['nope', 42, [], true]) {
    assert.equal(readEvaluatorGate(bad, defaults).ok, false, `evaluator ${describeValue(bad)} must be refused`)
  }
  assert.equal(readEvaluatorGate(undefined, defaults).ok, true, 'absent is not malformed')
  assert.equal(readEvaluatorGate(null, defaults).ok, true)
  assert.equal(readEvaluatorGate({}, defaults).ok, true)
})

test('decideVerdict agrees with the gate about an unusable bar', () => {
  for (const value of UNUSABLE) {
    const gateAccepts = checkBar(value).ok
    const scored = decideVerdict(
      { perDimension: DEFAULT_DIMENSIONS.map(d => ({ dimension: d, score: 10 })), issues: [] },
      { bar: value, mustPass: DEFAULT_MUST_PASS, dimensions: DEFAULT_DIMENSIONS },
    )
    // A value the gate refuses must never produce a PASS from the scorer either.
    assert.equal(
      scored.passed && gateAccepts,
      scored.passed,
      `decideVerdict passed with an unusable bar ${describeValue(value)}`,
    )
    if (!gateAccepts) assert.equal(scored.passed, false, `bar ${describeValue(value)} approved work`)
  }
})

test('runReview refuses every value the writer refuses, and starts no child', async () => {
  let started = 0
  const subagents = {
    start: async () => {
      started += 1
      return {
        result: Promise.resolve({
          stopReason: 'completed',
          structured: { perDimension: DEFAULT_DIMENSIONS.map(d => ({ dimension: d, score: 10 })), issues: [] },
          output: [],
        }),
        dispose: async () => {},
      }
    },
  }

  for (const value of UNUSABLE) {
    started = 0
    const outcome = await runReview({
      feature: 'x',
      parent: { id: 'p' },
      subagents,
      config: { bar: value },
    })
    assert.equal(outcome.passed, false, `bar ${describeValue(value)} approved work`)
    assert.equal(outcome.status, 'misconfigured')
    assert.equal(started, 0, `bar ${describeValue(value)} started a child`)
  }
})

test('readEvaluatorGate is the single source both readers use', () => {
  const defaults = { bar: 8, maxRounds: 3, dimensions: DEFAULT_DIMENSIONS, mustPass: DEFAULT_MUST_PASS }

  assert.equal(readEvaluatorGate({}, defaults).ok, true, 'an empty section takes the defaults')
  assert.equal(readEvaluatorGate(undefined, defaults).ok, true)
  assert.equal(readEvaluatorGate({ bar: 8, maxRounds: 3 }, defaults).ok, true)

  // Every unusable field must surface as a problem rather than being absorbed.
  for (const value of UNUSABLE) {
    const gate = readEvaluatorGate({ bar: value }, defaults)
    assert.equal(gate.ok, false, `bar ${describeValue(value)} produced an ok gate`)
    assert.ok(gate.problems.length > 0)
  }

  const missing = readEvaluatorGate({ dimensions: ['correctness'], mustPass: ['correctness', 'build'] }, defaults)
  assert.equal(missing.ok, false, 'a veto on an unscored dimension must be refused, not silently ineffective')
  assert.match(missing.problems.join(' '), /build/)
})

// ---------------------------------------------------------------------------
// the SAME property for the approval gate
// ---------------------------------------------------------------------------

test('the approval writer and the approval gate agree on every field and value', () => {
  // `workflow_set` and the gate are the two surfaces for this section, and this is the
  // approval half of the property above. The whole-section case is the one that matters
  // most: the settings panel writes a whole section on every change, and a section write
  // that skipped validation let a malformed strength reach the file and then be silently
  // replaced by the fail-closed defaults.
  const values = [
    'ask-user', 'llm-then-user', 'llm-only', 'off', 'maybe', '', 'llm', 'OFF',
    'low', 'medium', 'high', 'banana', 0, 1, true, false, null,
    [], ['grep'], ['grep', 7], 'grep', { grep: true },
    { strength: 'off' }, { strength: 'maybe' }, { riskThreshold: 'banana' },
    { denyHighAlways: 'false' }, { denyHighAlways: true }, { exemptTools: ['grep', 7] }, { exemptTools: [] },
    'nope', 42, 7n, () => {},
  ]
  for (const value of values) {
    for (const key of ['strength', 'riskThreshold', 'denyHighAlways', 'exemptTools']) {
      const writable = validateSettingValue(['approval', key], value) === null
      const gateAccepts = readApprovalGate({ [key]: value }, DEFAULT_CONFIG.approval).usable
      assert.equal(
        writable,
        gateAccepts,
        `approval.${key} ${describeValue(value)} (${typeof value}): writer ${writable}, gate ${gateAccepts}`,
      )
    }
  }

  for (const value of values) {
    const writable = validateSettingValue(['approval'], value) === null
    const gateAccepts = value === null || readApprovalGate(value, DEFAULT_CONFIG.approval).usable
    assert.equal(writable, gateAccepts, `approval ${describeValue(value)}: writer ${writable}, gate ${gateAccepts}`)
  }
})

test('an unusable approval section can never become a permissive one', () => {
  // The direction of the fallback, asserted rather than described. `off` is the widest
  // strength, so a refused section must never resolve to it.
  for (const bad of ['nope', 42, [], true, { strength: 'maybe' }, { exclude: 1, exemptTools: 'grep' }]) {
    const gate = readApprovalGate(bad, DEFAULT_CONFIG.approval)
    assert.equal(gate.usable, false)
    assert.notEqual(gate.strength, 'off', `${describeValue(bad)} resolved to the widest strength`)
    assert.equal(gate.strength, 'ask-user')
    assert.equal(gate.denyHighAlways, true, 'the monotonic high-risk denial must survive a malformed section')
  }
})
