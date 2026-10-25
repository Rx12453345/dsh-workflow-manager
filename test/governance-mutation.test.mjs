/**
 * The verdict logic of `tooling/mutation-check-governance.mjs`, pinned WITHOUT spawning anything.
 *
 * WHY THIS FILE EXISTS. A mutation harness is evidence, and evidence that can lie is worse than
 * none: the lock probe once printed `4/4 caught` because a sandbox EPERM made every child fail to
 * start, and it read "the child did not exit 0" as "the mutant was caught". `mutation-check-governance.mjs`
 * removes that class of false evidence (baseline first; RED requires a failing test NEXT TO a
 * passing one; a crash is NOT RUN), but the rule itself needs a test — otherwise the next edit to
 * the classifier could quietly turn a NOT RUN into a CAUGHT and every mutant report would still
 * look green.
 *
 * The probe takes an injected `runTests`, so these cases run as ordinary unit tests: no copy, no
 * child, no lock, no lib/ rewrite.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  MUTANTS,
  EXIT_NOT_RUN,
  EXIT_OK,
  EXIT_UNEXPECTED,
  classifyRun,
  readFailingTests,
  readTestSummary,
  runGovernanceProbe,
} from '../tooling/mutation-check-governance.mjs'

/** A spec-reporter summary block, exactly as the captured suite prints it. */
function summary({ tests = 40, pass = 40, fail = 0, skipped = 0 } = {}) {
  return [
    `ℹ tests ${tests}`,
    'ℹ suites 0',
    `ℹ pass ${pass}`,
    `ℹ fail ${fail}`,
    'ℹ cancelled 0',
    `ℹ skipped ${skipped}`,
    'ℹ todo 0',
    'ℹ duration_ms 42',
  ].join('\n')
}

const run = ({ status = 0, body = '', fail = 0, pass = 40, error = null, signal = null } = {}) => ({
  status,
  signal,
  error,
  stdout: `${body}\n${summary({ pass, fail })}`,
  stderr: '',
})

/** A green suite. */
const green = () => run()

/** A red suite where exactly `names` failed next to passing tests. */
function red(names) {
  const body = [
    '✔ a test that still passes (0.1ms)',
    ...names.map(name => `✖ ${name} (0.2ms)`),
    '',
    '✖ failing tests:',
    ...names.map(name => `✖ ${name} (0.2ms)`),
  ].join('\n')
  return run({ status: 1, body, pass: 39, fail: names.length })
}

const quiet = () => {}

test('readTestSummary reads the spec summary, and a missing summary is not a green', () => {
  assert.deepEqual(readTestSummary(summary({ tests: 639, pass: 632, fail: 0, skipped: 7 })), {
    tests: 639,
    pass: 632,
    fail: 0,
    skipped: 7,
    executed: 632,
  })
  const missing = readTestSummary('✔ a test (0.1ms)')
  assert.deepEqual(missing, { tests: null, pass: null, fail: null, skipped: null, executed: 0 })
})

test('readFailingTests strips the timing but not parentheses in the name', () => {
  const output = [
    '✔ passes (0.1ms)',
    '✖ a failing test with (parens) in the name (0.5201ms)',
    '',
    '✖ failing tests:',
    '✖ a failing test with (parens) in the name (0.5201ms)',
  ].join('\n')
  assert.deepEqual(readFailingTests(output), ['a failing test with (parens) in the name'])
})

test('classifyRun: GREEN only when the run passed with no failures', () => {
  assert.equal(classifyRun(green()).verdict, 'GREEN')
  assert.equal(classifyRun(run({ status: 0, body: '✔ x (1ms)', pass: 0, fail: 0 })).verdict, 'NOT RUN')
})

test('classifyRun: RED needs a failing test NEXT TO a passing one', () => {
  const caught = classifyRun(red(['the named test']))
  assert.equal(caught.verdict, 'RED')
  assert.deepEqual(caught.failing, ['the named test'])

  // A load error / crash: nonzero exit, a failure count, but NOTHING passed. Calling this a catch
  // is exactly the false evidence the harness exists to prevent.
  const crash = classifyRun(run({ status: 1, body: '✖ the file could not be loaded (0ms)', pass: 0, fail: 1 }))
  assert.equal(crash.verdict, 'NOT RUN')
  assert.match(crash.reason, /crash or load error is not a caught mutant/)
})

test('classifyRun: an unstarted, killed or empty run is NOT RUN, never a catch', () => {
  assert.equal(classifyRun(null).verdict, 'NOT RUN')
  const spawnError = classifyRun({ status: null, signal: null, error: Object.assign(new Error('EPERM'), { code: 'EPERM' }), stdout: '', stderr: '' })
  assert.equal(spawnError.verdict, 'NOT RUN')
  assert.match(spawnError.reason, /could not start.*EPERM/)
  assert.equal(classifyRun({ status: null, signal: 'SIGKILL', error: null, stdout: '', stderr: '' }).verdict, 'NOT RUN')
  assert.match(classifyRun(run({ pass: 0, fail: 0 })).reason, /no test executed/)
})

/**
 * A synthetic mutant on a file NO real mutant in the table touches.
 *
 * The probe reads the mutant's source from the project and checks its anchor exactly once, so a
 * test that used a REAL governance mutant would fail whenever that mutant is the one being run by
 * the harness: the anchor it looks for has (correctly) been removed in the copy. An anchor in
 * `lib/eol.js` is present in every run, and the injected runner ignores the source anyway.
 */
const SYNTHETIC = {
  id: 'T1',
  what: 'a synthetic mutant used only to exercise the probe verdicts',
  file: 'lib/eol.js',
  from: 'export function normaliseLineEndings(buffer) {',
  to: 'export function normaliseLineEndings(buffer) { /* synthetic */',
  must: ['the named governance test'],
}

/** A runner that answers from a table, so the probe's own logic is under test. */
function scripted(...answers) {
  const calls = []
  const runner = (sourceText, context) => {
    calls.push(context)
    const answer = answers[calls.length - 1]
    if (answer === undefined) throw new Error(`unexpected runner call #${calls.length}`)
    return answer
  }
  return { runner, calls }
}

test('runGovernanceProbe: a red baseline makes EVERY mutant NOT RUN (exit 2), not caught', () => {
  const { runner, calls } = scripted(red(['some unrelated failure']))
  const result = runGovernanceProbe({ runTests: runner, mutants: [SYNTHETIC], log: quiet })
  assert.equal(result.exitCode, EXIT_NOT_RUN)
  assert.equal(calls.length, 1, 'no mutant may run when the baseline is red')
  assert.ok(result.rows.length > 0)
  assert.ok(result.rows.every(row => row.verdict === 'NOT RUN'))
  assert.ok(result.rows.every(row => /baseline is RED/.test(row.reason)))
})

test('runGovernanceProbe: a surviving mutant is a missing test (exit 1), not a pass', () => {
  const { runner } = scripted(green(), green())
  const result = runGovernanceProbe({ runTests: runner, mutants: [SYNTHETIC], log: quiet })
  assert.equal(result.exitCode, EXIT_UNEXPECTED)
  assert.equal(result.rows[0].verdict, 'SURVIVED')
})

test('runGovernanceProbe: red for the WRONG test does not count as caught', () => {
  const { runner } = scripted(green(), red(['some other test entirely']))
  const result = runGovernanceProbe({ runTests: runner, mutants: [SYNTHETIC], log: quiet })
  assert.equal(result.exitCode, EXIT_UNEXPECTED)
  assert.equal(result.rows[0].verdict, 'WRONG TEST')
  assert.match(result.rows[0].reason, /named test\(s\) did not fail/)
})

test('runGovernanceProbe: red for the NAMED test is CAUGHT (exit 0)', () => {
  const { runner } = scripted(green(), red(SYNTHETIC.must))
  const result = runGovernanceProbe({ runTests: runner, mutants: [SYNTHETIC], log: quiet })
  assert.equal(result.exitCode, EXIT_OK)
  assert.equal(result.rows[0].verdict, 'CAUGHT')
})

test('runGovernanceProbe: an unusable anchor is NOT APPLIED, never a survivor or a pass', () => {
  const broken = { id: 'X1', what: 'a broken anchor', file: 'lib/tools.js', from: 'this literal is not in the source', to: 'x', must: ['x'] }
  const { runner, calls } = scripted(green())
  const result = runGovernanceProbe({ runTests: runner, mutants: [broken], log: quiet })
  assert.equal(result.exitCode, EXIT_UNEXPECTED)
  assert.equal(result.rows[0].verdict, 'NOT APPLIED')
  assert.match(result.rows[0].reason, /anchor occurs 0x/)
  assert.equal(calls.length, 1, 'an unapplied mutant must not run the suite')
})

test('runGovernanceProbe: an unknown mutant id is a refusal, never a zero-mutant pass', () => {
  const { runner, calls } = scripted()
  const result = runGovernanceProbe({ runTests: runner, only: ['G99'], log: quiet })
  assert.equal(result.exitCode, EXIT_UNEXPECTED)
  assert.equal(calls.length, 0, 'an unknown id must not be read as "run nothing, all clean"')
  assert.deepEqual(result.rows, [])
})

test('runGovernanceProbe: the real table has unique ids and non-empty assertions', () => {
  const ids = MUTANTS.map(mutant => mutant.id)
  assert.equal(new Set(ids).size, ids.length, 'mutant ids must be unique')
  assert.ok(MUTANTS.length >= 3)
  for (const mutant of MUTANTS) {
    assert.ok(mutant.must.length > 0, `${mutant.id} must declare the test(s) that catch it`)
    assert.notEqual(mutant.from, mutant.to)
    assert.match(mutant.file, /^lib\//)
  }
})
