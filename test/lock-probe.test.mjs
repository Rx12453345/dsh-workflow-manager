/**
 * The lock-probe's false-evidence guard.
 *
 * WHY THIS IS A TEST AND NOT JUST A REFACTOR: `tooling/mutation-check-lock-probe.mjs` used to
 * capture its child through a piped `spawnSync`. In the DSH Windows sandbox that pipe is denied
 * (EPERM), `status` came back `null`, and `status !== 0` was read as "the mutant made the suite
 * fail" — so the probe printed `4/4 caught` and exited 0 having executed ZERO tests. A tool that
 * reports a pass with no evidence is worse than a tool that reports nothing.
 *
 * The cases below pin the replacement rule by injecting runners into `runProbe` (which is why the
 * capture is exported and guarded by a `main` check):
 *
 *   - a suite that cannot start is NOT RUN and exits 2, never "caught";
 *   - a mutant run that cannot start is NOT RUN even when the baseline is green;
 *   - a summary where nothing ran (skipped file / load error) is NOT RUN, not GREEN;
 *   - a real failing test is still RED and exits 0 (the honest path is not weakened);
 *   - a surviving mutant is GREEN/MISSED and exits 1.
 *
 * The injected runners also keep these cases fast and independent of the sandbox; the real
 * `runSuiteInCopy` path is exercised by running the probe itself.
 *
 * Run with `node run-unit-tests.mjs`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  EXIT_NOT_RUN,
  EXIT_OK,
  EXIT_UNEXPECTED,
  MUTANTS,
  classifyRun,
  readTestSummary,
  runProbe,
} from '../tooling/mutation-check-lock-probe.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SOURCE = join(ROOT, 'tooling', 'mutation-lock.mjs')

/** TAP summary for a suite that ran and passed (the reporter used when stdout is a file). */
const PASS_OUTPUT = '# tests 30\n# suites 0\n# pass 27\n# fail 0\n# cancelled 0\n# skipped 3\n# todo 0\n'

/** TAP summary for a suite where a real test failed. */
const FAIL_OUTPUT =
  'not ok 1 - an unreadable age with a LIVE holder is refused\n' +
  '# tests 30\n# suites 0\n# pass 25\n# fail 2\n# cancelled 0\n# skipped 3\n# todo 0\n'

/** TAP summary for a suite where nothing executed (a skipped or unloadable file). */
const NOTHING_RAN_OUTPUT = '# tests 0\n# suites 0\n# pass 0\n# fail 0\n# cancelled 0\n# skipped 1\n# todo 0\n'

/** A spawn-failure result, exactly what the old probe misread as a caught mutant. */
function spawnFailure() {
  const error = new Error('spawn EPERM')
  error.code = 'EPERM'
  return { status: null, signal: null, error, stdout: '', stderr: '' }
}

function ok(stdout) {
  return { status: 0, signal: null, error: null, stdout, stderr: '' }
}

function red(stdout) {
  return { status: 1, signal: null, error: null, stdout, stderr: '' }
}

/** Collect the probe's report lines instead of printing them. */
function recorder() {
  const lines = []
  return { lines, log: line => lines.push(String(line)) }
}

test('classifyRun: a child that cannot start is NOT RUN, never caught', () => {
  const classification = classifyRun(spawnFailure())
  assert.equal(classification.verdict, 'NOT RUN')
  assert.match(classification.reason, /EPERM/)
})

test('classifyRun: an abnormal exit with no status is NOT RUN', () => {
  const classification = classifyRun({ status: null, signal: 'SIGKILL', error: null, stdout: '', stderr: '' })
  assert.equal(classification.verdict, 'NOT RUN')
  assert.match(classification.reason, /SIGKILL/)
})

test('classifyRun: a skipped test file executes nothing, so it is NOT RUN rather than GREEN', () => {
  assert.equal(readTestSummary(NOTHING_RAN_OUTPUT).executed, 0)
  const classification = classifyRun(ok(NOTHING_RAN_OUTPUT))
  assert.equal(classification.verdict, 'NOT RUN')
  assert.match(classification.reason, /no test executed/)
})

test('classifyRun: a crash with no passing test is NOT RUN, not a caught mutant', () => {
  const crash = { status: 1, signal: null, error: null, stdout: 'not ok 1 - the file failed to load\n# tests 1\n# pass 0\n# fail 1\n# skipped 0\n', stderr: '' }
  const classification = classifyRun(crash)
  assert.equal(classification.verdict, 'NOT RUN')
  assert.match(classification.reason, /crash or load error/)
})

test('classifyRun: a failing test next to a passing one is RED', () => {
  assert.equal(classifyRun(red(FAIL_OUTPUT)).verdict, 'RED')
  assert.equal(classifyRun(ok(PASS_OUTPUT)).verdict, 'GREEN')
})

test('classifyRun: exit 0 with a failure count is NOT RUN, not GREEN', () => {
  // The governance harness required `fail === 0`; this probe used to read `status === 0` alone as
  // GREEN, so the two copies of the verdict helper disagreed. Exit 0 with failing tests is a
  // contradictory result, not evidence — it must not be counted as a surviving mutant either way.
  const inconsistent = { status: 0, signal: null, error: null, stdout: FAIL_OUTPUT, stderr: '' }
  const classification = classifyRun(inconsistent)
  assert.equal(classification.verdict, 'NOT RUN')
  assert.match(classification.reason, /exited 0 without a failing test next to a passing one/)
  assert.match(classification.detail, /exit 0, tests 30, pass 25, fail 2/)
})

test('runProbe: a suite that cannot start reports every mutant NOT RUN and exits 2', () => {
  const { lines, log } = recorder()
  const report = runProbe({ log, runTests: () => spawnFailure() })

  assert.equal(report.exitCode, EXIT_NOT_RUN)
  assert.equal(report.baseline.verdict, 'NOT RUN')
  assert.match(report.baseline.reason, /EPERM/)
  assert.equal(report.rows.length, MUTANTS.length)
  assert.ok(report.rows.every(row => row.verdict === 'NOT RUN'))

  const text = lines.join('\n')
  assert.match(text, /NOT RUN/)
  assert.doesNotMatch(text, /RED — caught/, 'zero tests run must never be reported as caught')
  assert.match(text, /NOT a pass \(exit 2\)/)
})

test('runProbe: a mutant run that cannot start is NOT RUN even when the baseline is green', () => {
  const { lines, log } = recorder()
  const report = runProbe({
    log,
    runTests: (_source, context) => (context.kind === 'baseline' ? ok(PASS_OUTPUT) : spawnFailure()),
  })

  assert.equal(report.exitCode, EXIT_NOT_RUN)
  assert.equal(report.baseline.verdict, 'GREEN')
  assert.equal(report.rows.length, MUTANTS.length)
  assert.ok(report.rows.every(row => row.verdict === 'NOT RUN'))
  assert.doesNotMatch(lines.join('\n'), /RED — caught/)
})

test('runProbe: a real failing suite is still reported caught and exits 0', () => {
  const { lines, log } = recorder()
  const report = runProbe({
    log,
    runTests: (_source, context) => (context.kind === 'baseline' ? ok(PASS_OUTPUT) : red(FAIL_OUTPUT)),
  })

  assert.equal(report.exitCode, EXIT_OK)
  assert.equal(report.rows.length, MUTANTS.length)
  assert.ok(report.rows.every(row => row.verdict === 'RED'), 'the honest RED path is preserved')
  assert.match(lines.join('\n'), /RED — caught/)
  assert.match(lines.join('\n'), /caught: 4/)
})

test('runProbe: a surviving mutant is reported missed and exits 1', () => {
  const { lines, log } = recorder()
  const report = runProbe({ log, runTests: () => ok(PASS_OUTPUT) })

  assert.equal(report.exitCode, EXIT_UNEXPECTED)
  assert.ok(report.rows.every(row => row.verdict === 'GREEN'))
  assert.match(lines.join('\n'), /GREEN — missed/)
})

test('runProbe: an anchor that is no longer present is NOT APPLIED and exits 1', () => {
  const { lines, log } = recorder()
  const report = runProbe({
    log,
    mutants: [{ id: 'X', description: 'a stale anchor', from: 'this text is not in the source', to: 'x', expected: 'RED' }],
    runTests: () => ok(PASS_OUTPUT),
  })

  assert.equal(report.exitCode, EXIT_UNEXPECTED)
  assert.equal(report.rows[0].verdict, 'NOT APPLIED')
  assert.match(lines.join('\n'), /anchor occurs 0 times/)
})

test('a CRLF checkout still applies the mutants, because anchors are normalised', () => {
  // A clean checkout with core.autocrlf=true is CRLF; the anchors are LF literals. Raw matching
  // would report all four NOT APPLIED (exit 1) and the unit test below would fail on Windows.
  const crlf = readFileSync(SOURCE, 'utf8').replace(/\r?\n/g, '\r\n')
  const report = runProbe({
    log: () => {},
    source: crlf,
    runTests: (_source, context) => (context.kind === 'baseline' ? ok(PASS_OUTPUT) : red(FAIL_OUTPUT)),
  })

  assert.equal(report.exitCode, EXIT_OK)
  assert.equal(report.baseline.verdict, 'GREEN')
  assert.ok(report.rows.every(row => row.verdict === 'RED'), 'every mutant applied on the CRLF source')
})

test('every mutant anchor occurs exactly once, and L1/L3 target the decision site', () => {
  const source = readFileSync(SOURCE, 'utf8').replace(/\r\n/g, '\n')
  for (const mutant of MUTANTS) {
    assert.equal(source.split(mutant.from).length - 1, 1, `${mutant.id} anchor must be unique`)
  }
  // `readLockTimestamp(holder)` also appears in `describeHolder`; the old short anchor silently
  // mutated the DISPLAY call there instead of reinstate the defect in `inspectLock`.
  for (const mutant of MUTANTS.filter(m => m.id === 'L1' || m.id === 'L3')) {
    assert.match(mutant.from, /const cap = lockTtlMs\(\)/, `${mutant.id} must anchor the stale decision`)
  }
})
