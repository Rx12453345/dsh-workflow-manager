/**
 * The verdict logic of `tooling/mutation-verdict.mjs`, pinned WITHOUT spawning anything and
 * WITHOUT a browser.
 *
 * WHY THIS FILE EXISTS. The three UI mutation harnesses judge a mutant from a child run's
 * output. Their old rule was `caught: failed.length > 0`, and the in-sandbox layout case fails
 * there for an ENVIRONMENT reason (`the browser exited early with 2147483651`), so a red
 * baseline made every mutant "caught". That is false evidence, and a classifier that can
 * regress to it must be pinned by tests of its own.
 *
 * Every case below is a synthetic `{status, output}` pair: no child, no Chromium, no lock, no
 * `lib/` rewrite. The four outcomes (caught / missed / partial / not-run) are each exercised,
 * including a TAP run whose ONLY failure is the browser message and a TAP run whose failure is
 * a real assertion.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  EXIT_APPLY_FAILED,
  EXIT_MISSED,
  EXIT_NOT_RUN,
  EXIT_OK,
  EXIT_SOURCE_CHANGED,
  classifyBaseline,
  classifyMutant,
  classifyRun,
  readFailures,
  readTestSummary,
} from '../tooling/mutation-verdict.mjs'

const LAYOUT = 'the shipped panel grid resolves to one column with a full-width label'
const NAMED = 'no control writes a whole section from a value read at render time'
const BROWSER_MESSAGE = 'the browser exited early with 2147483651 (port 9517)'

/** A spec-reporter summary block, exactly as the captured suite prints it. */
function specSummary({ tests = 40, pass = 40, fail = 0, skipped = 0 } = {}) {
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

/** A spec-reporter run. `body` is everything before the summary. */
function specRun({ status = 0, body = '', tests = 40, pass = 40, fail = 0, skipped = 0 } = {}) {
  return {
    status,
    signal: null,
    error: null,
    stdout: `${body}\n${specSummary({ tests, pass, fail, skipped })}`,
    stderr: '',
  }
}

/**
 * A spec-reporter red run whose ONE failure is `name`, repeated in the trailing
 * "failing tests:" section exactly as Node prints it.
 */
function specRed(name, detail, { fail = 1, pass = 40 } = {}) {
  const body = [
    '✔ a passing test (0.1ms)',
    `✖ ${name} (0.2ms)`,
    `  ${detail}`,
    '',
    '✖ failing tests:',
    '',
    'test at test\\status.test.mjs:1:1',
    `✖ ${name} (0.2ms)`,
    `  ${detail}`,
    '',
  ].join('\n')
  return specRun({ status: 1, body, tests: pass + fail, pass, fail })
}

/** A spec-reporter green run. */
const specGreen = () => specRun({ body: '✔ a passing test (0.1ms)' })

/**
 * A TAP-reporter run with one failing test. The TAP YAML block is indented under
 * `not ok`, which is why the parser reads blocks by INDENTATION rather than by format.
 */
function tapRun({ name, detail, status = 1, tests = 82, pass = 81, fail = 1, skipped = 0 } = {}) {
  return {
    status,
    signal: null,
    error: null,
    stdout: [
      'TAP version 13',
      `# Subtest: ${name}`,
      `not ok ${tests} - ${name}`,
      '  ---',
      '  duration_ms: 540.9',
      "  failureType: 'testCodeFailure'",
      `  error: '${detail}'`,
      "  code: 'ERR_TEST_FAILURE'",
      '  ...',
      `1..${tests}`,
      `# tests ${tests}`,
      '# suites 0',
      `# pass ${pass}`,
      `# fail ${fail}`,
      '# cancelled 0',
      `# skipped ${skipped}`,
      '# todo 0',
    ].join('\n'),
    stderr: '',
  }
}

/** A TAP-reporter green run. */
function tapGreen() {
  return {
    status: 0,
    signal: null,
    error: null,
    stdout: [
      'TAP version 13',
      '# Subtest: a passing test',
      'ok 1 - a passing test',
      '  ---',
      '  duration_ms: 1.2',
      '  ...',
      '1..1',
      '# tests 1',
      '# suites 0',
      '# pass 1',
      '# fail 0',
      '# cancelled 0',
      '# skipped 0',
      '# todo 0',
    ].join('\n'),
    stderr: '',
  }
}

test('readTestSummary reads both reporters, and a missing summary is not a green', () => {
  assert.deepEqual(readTestSummary(specSummary({ tests: 82, pass: 81, fail: 1, skipped: 0 })), {
    tests: 82,
    pass: 81,
    fail: 1,
    skipped: 0,
    executed: 82,
  })
  assert.deepEqual(
    readTestSummary(['# tests 82', '# pass 81', '# fail 1', '# skipped 0'].join('\n')),
    { tests: 82, pass: 81, fail: 1, skipped: 0, executed: 82 },
  )
  assert.deepEqual(readTestSummary('✔ a test (0.1ms)'), {
    tests: null,
    pass: null,
    fail: null,
    skipped: null,
    executed: 0,
  })
})

test('readFailures parses spec and TAP, dedupes the repeated spec entry, and marks the browser', () => {
  const spec = readFailures(specRed(NAMED, 'AssertionError: expected 1 to equal 2').stdout)
  assert.equal(spec.length, 1, 'the inline and trailing spec entries are one failure')
  assert.equal(spec[0].name, NAMED)
  assert.equal(spec[0].environment, false)

  const tap = readFailures(tapRun({ name: LAYOUT, detail: BROWSER_MESSAGE }).stdout)
  assert.equal(tap.length, 1)
  assert.equal(tap[0].name, LAYOUT)
  assert.equal(tap[0].environment, true, 'the TAP error block carries the browser signature')
})

test('CAUGHT: a real failing assertion named by the mutant', () => {
  const result = classifyMutant(specRed(NAMED, 'AssertionError: expected 1 to equal 2'), [NAMED])
  assert.equal(result.verdict, 'caught')
  assert.deepEqual(result.failures.map(failure => failure.name), [NAMED])
  assert.equal(result.environmentFailures.length, 0)
})

test('CAUGHT from a TAP run whose failure is a real assertion (not the browser)', () => {
  const result = classifyMutant(tapRun({ name: NAMED, detail: 'AssertionError: 1 !== 2' }), [NAMED])
  assert.equal(result.verdict, 'caught')
})

test('MISSED: nothing failed', () => {
  assert.equal(classifyMutant(specGreen(), [NAMED]).verdict, 'missed')
  assert.equal(classifyMutant(tapGreen(), [NAMED]).verdict, 'missed')
})

test('PARTIAL: red, but the named test did not fail', () => {
  const result = classifyMutant(specRed('some other test', 'AssertionError: 1 !== 2'), [NAMED])
  assert.equal(result.verdict, 'partial')
  assert.deepEqual(result.missing, [NAMED])
  assert.match(result.reason, /named test\(s\) did not fail/)
})

test('NOT RUN: a TAP run whose ONLY failure is the browser message — never caught', () => {
  const run = tapRun({ name: LAYOUT, detail: BROWSER_MESSAGE })
  const classified = classifyRun(run)
  assert.equal(classified.verdict, 'not-run')
  assert.equal(classified.realFailures.length, 0)
  assert.equal(classified.environmentFailures.length, 1)
  assert.match(classified.reason, /browser exited early with 2147483651/)

  // The mutant's named test is NOT the layout case: the red proves nothing about it.
  const mutant = classifyMutant(run, [NAMED])
  assert.equal(mutant.verdict, 'not-run')
  assert.match(mutant.reason, /browser exited early with 2147483651/)
})

test('NOT RUN: a required test that failed only because the browser was unavailable', () => {
  // A real failure elsewhere makes the run RED, so this reaches the branch that refuses to
  // pair a required test's ENVIRONMENT failure with that red and report a partial verdict.
  const body = [
    '✔ a passing test (0.1ms)',
    '✖ some other test (0.2ms)',
    '  AssertionError: expected 1 to equal 2',
    '',
    `✖ ${LAYOUT} (0.2ms)`,
    `  Error: ${BROWSER_MESSAGE}`,
    '',
  ].join('\n')
  const run = specRun({ status: 1, body, tests: 42, pass: 40, fail: 2 })
  const result = classifyMutant(run, [LAYOUT])
  assert.equal(result.verdict, 'not-run')
  assert.match(result.reason, /failed only because the browser/)
})

test('a real failure next to a browser failure is caught; the browser failure is NOT counted', () => {
  const body = [
    '✔ a passing test (0.1ms)',
    `✖ ${NAMED} (0.2ms)`,
    '  AssertionError: expected 1 to equal 2',
    '',
    `✖ ${LAYOUT} (0.2ms)`,
    `  Error: ${BROWSER_MESSAGE}`,
    '',
  ].join('\n')
  const run = specRun({ status: 1, body, tests: 42, pass: 40, fail: 2 })
  const result = classifyMutant(run, [NAMED])
  assert.equal(result.verdict, 'caught')
  assert.deepEqual(result.failures.map(failure => failure.name), [NAMED])
  assert.deepEqual(result.environmentFailures.map(failure => failure.name), [LAYOUT])
})

test('classifyBaseline: a green baseline is usable; a red one is NOT RUN', () => {
  assert.equal(classifyBaseline(specGreen()).verdict, 'green')

  const environmental = classifyBaseline(tapRun({ name: LAYOUT, detail: BROWSER_MESSAGE }))
  assert.equal(environmental.verdict, 'not-run')
  assert.match(environmental.reason, /browser exited early with 2147483651/)

  const realRed = classifyBaseline(specRed('an unrelated assertion', 'AssertionError: 1 !== 2'))
  assert.equal(realRed.verdict, 'not-run')
  assert.match(realRed.reason, /unmutated baseline is red/)
})

test('classifyBaseline: green only because the layout case was environment-skipped is NOT RUN', () => {
  const run = specRun({
    tests: 41,
    pass: 40,
    skipped: 1,
    body: `﹣ ${LAYOUT} (0.1ms) # SKIP this case launches Chromium to measure layout; the sandbox cannot start the browser`,
  })
  const baseline = classifyBaseline(run)
  assert.equal(baseline.verdict, 'not-run')
  assert.match(baseline.reason, /skipped for an environmental reason/)
  assert.match(baseline.reason, /launches Chromium|sandbox cannot start the browser/)
})

test('NOT RUN for an unstarted, killed or empty run — never a green or a catch', () => {
  assert.equal(classifyRun(null).verdict, 'not-run')
  assert.equal(
    classifyRun({
      status: null,
      signal: null,
      error: Object.assign(new Error('EPERM'), { code: 'EPERM' }),
      stdout: '',
      stderr: '',
    }).verdict,
    'not-run',
  )
  assert.equal(
    classifyRun({ status: null, signal: 'SIGKILL', error: null, stdout: '', stderr: '' }).verdict,
    'not-run',
  )
  assert.match(classifyRun(specRun({ pass: 0, fail: 0 })).reason, /no test executed/)
})

test('the exit codes keep NOT RUN and a surviving mutant apart', () => {
  assert.equal(EXIT_OK, 0)
  assert.equal(EXIT_MISSED, 1)
  assert.equal(EXIT_NOT_RUN, 2)
  assert.equal(EXIT_SOURCE_CHANGED, 3)
  assert.equal(EXIT_APPLY_FAILED, 4)
  assert.notEqual(EXIT_MISSED, EXIT_NOT_RUN, 'a surviving mutant and a missing verdict are different')
})
