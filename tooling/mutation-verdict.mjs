/**
 * SHARED VERDICT LOGIC FOR THE THREE UI MUTATION HARNESSES.
 *
 * `mutation-check-client.mjs`, `mutation-check-panel.mjs` and
 * `mutation-check-project-tab.mjs` all spawn `test/status.test.mjs`, which contains the
 * Chromium layout measurement. In the DSH sandbox that browser cannot start, so the layout
 * case is RED for an ENVIRONMENT reason. The harnesses used to judge a mutant with
 * `caught: failed.length > 0`, so that environmental red was counted as a caught mutant —
 * a red baseline makes every mutant "caught", which is worse than no evidence because it
 * looks like a pass.
 *
 * This module answers what one harness run MEANS, and nothing else:
 *
 *   caught   the mutant's NAMED test(s) failed for a real reason
 *   missed   nothing failed: the mutant survived (a missing test, not a pass)
 *   partial  the suite went red, but some required test name did NOT fail
 *   not-run  no verdict exists: the run could not start, did not exit normally, executed
 *            zero tests, or its only failure was the browser being unavailable / exiting
 *            early / the sandbox skipping the layout case. NEVER a catch.
 *
 * A red run is split into REAL failures and ENVIRONMENT failures. Only the real ones can
 * make a mutant caught; the browser failure is reported by name and excluded. A run whose
 * only failures are environmental is `not-run`, not `caught`.
 *
 * THE BASELINE RUNS FIRST in every harness. `classifyBaseline` refuses to turn a red
 * baseline (including a browser-only red, or a green baseline whose layout case was skipped
 * for an environmental reason) into evidence: it returns `not-run`, the harness prints one
 * line naming the reason, and exits 2.
 *
 * EXIT CODES — 2 is NOT a pass:
 *   0  every mutant was caught
 *   1  a mutant survived (missed) or only partly failed (partial)
 *   2  NOT RUN: the baseline or a mutant run produced no verdict (environment), so this
 *      is not a pass. This is the same number the lock probe uses for its NOT RUN.
 *   3  source integrity failure (a file changed while the harness ran)
 *   4  an unusable mutant anchor (APPLY-FAILED): a harness defect, not a surviving mutant
 *
 * `EXIT_NOT_RUN` (2) and `EXIT_MISSED` (1) are deliberately different so an environment
 * failure can never be read as "the tests have teeth" or as "a mutant survived".
 */

export const EXIT_OK = 0
export const EXIT_MISSED = 1
export const EXIT_NOT_RUN = 2
export const EXIT_SOURCE_CHANGED = 3
export const EXIT_APPLY_FAILED = 4

/**
 * Strong signatures of "the environment, not the code, produced this result".
 *
 * The first one is the measured in-sandbox failure:
 *   `Error: the browser exited early with 2147483651 (port 9806)`
 * from `withChromium` in `tooling/layout-styles.mjs`. The others cover the same browser
 * being absent or the sandbox skipping the case with its reason. They are deliberately
 * specific: matching a bare "browser" would let a real assertion that merely mentions a
 * browser be excused as an environment failure.
 */
const BROWSER_SIGNATURES = [
  /the browser exited early with -?\d+(?: \(port \d+\))?/i,
  /the DevTools endpoint never came up/i,
  /no Chromium-family browser on this machine/i,
  /launches Chromium to measure layout/i,
  /cannot start the browser/i,
]

/** One human-readable line for a spawn error, without a stack trace. */
function describeError(error) {
  return `${error?.code ? `${error.code}: ` : ''}${error?.message ?? String(error)}`
}

/**
 * The first browser-related signature in `text`, verbatim when possible.
 *
 * Used in the NOT RUN line so the reason NAMES THE BROWSER instead of saying "environment".
 *
 * @param {unknown} text
 * @returns {string}
 */
export function browserSignature(text) {
  const source = String(text ?? '')
  const exit = /the browser exited early with -?\d+(?: \(port \d+\))?/i.exec(source)
  if (exit !== null) return exit[0]
  for (const signature of BROWSER_SIGNATURES) {
    const match = signature.exec(source)
    if (match !== null) return match[0]
  }
  return 'the browser was unavailable'
}

/**
 * Read the runner's summary out of `node --test` output.
 *
 * The spec reporter prints `ℹ tests 82`; the TAP reporter prints `# tests 82`. Both are
 * accepted, because the harness's captured output is a file and Node's reporter choice is a
 * runtime detail. A missing summary must not look like a green run: every count is null and
 * `executed` is 0.
 *
 * @param {string} output - the child's stdout+stderr.
 * @returns {{tests: number|null, pass: number|null, fail: number|null, skipped: number|null, executed: number}}
 */
export function readTestSummary(output) {
  const count = label => {
    const match = String(output ?? '').match(new RegExp(`^(?:#|ℹ)\\s*${label}\\s+(\\d+)\\s*$`, 'm'))
    return match === null ? null : Number(match[1])
  }
  const tests = count('tests')
  const pass = count('pass')
  const fail = count('fail')
  const skipped = count('skipped')
  return { tests, pass, fail, skipped, executed: (pass ?? 0) + (fail ?? 0) }
}

/**
 * Parse one failure block out of spec or TAP output.
 *
 * A block is the failing line plus every following line INDENTED DEEPER than it. That is
 * what makes one parser work for both formats: the spec reporter indents the error and stack
 * under `✖ name`, TAP indents its YAML block under `not ok N - name`, and the next failure or
 * summary line is at the same (or shallower) indentation. The block text is what decides
 * whether the failure is environmental.
 *
 * @param {string} output
 * @returns {Array<{name: string, detail: string, environment: boolean}>} unique by name
 */
export function readFailures(output) {
  const lines = String(output ?? '').split(/\r?\n/)
  const indentOf = line => line.length - line.trimStart().length
  const found = []
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const spec = /^\s*✖ (.+?)(?: \(\d+(?:\.\d+)?ms\))?$/.exec(line)
    const tap = /^\s*not ok \d+ - (.*)$/.exec(line)
    let name = null
    if (spec !== null && spec[1].trim() !== 'failing tests:') name = spec[1].trim()
    else if (tap !== null) name = tap[1].replace(/\s+#.*$/, '').trim()
    if (name === null || name === '') continue
    const baseIndent = indentOf(line)
    let detail = ''
    for (let next = index + 1; next < lines.length; next += 1) {
      const candidate = lines[next]
      if (candidate.trim() === '') continue
      if (indentOf(candidate) <= baseIndent) break
      detail += `${candidate}\n`
    }
    found.push({ name, detail })
  }

  // The spec reporter repeats a failing test in its trailing "failing tests:" section.
  // Deduplicate by name; any occurrence that carries the environment signature marks the
  // whole failure as environmental.
  const unique = new Map()
  for (const entry of found) {
    const environment = BROWSER_SIGNATURES.some(signature => signature.test(entry.detail))
    const prior = unique.get(entry.name)
    if (prior === undefined) unique.set(entry.name, { ...entry, environment })
    else {
      prior.environment = prior.environment || environment
      if (prior.detail === '') prior.detail = entry.detail
    }
  }
  return [...unique.values()]
}

/** A `not-run` result with the fields every verdict carries. */
function notRun(reason, extra = {}) {
  return {
    verdict: 'not-run',
    reason,
    failures: [],
    realFailures: [],
    environmentFailures: [],
    environmentSkipped: false,
    skipDetail: undefined,
    summary: null,
    detail: '',
    ...extra,
  }
}

/**
 * Classify ONE test-suite run (the unmutated baseline or one mutant's run).
 *
 * This is the whole anti-false-evidence rule, isolated so the unit test can pin it without
 * spawning a child and without a browser.
 *
 * @param {{status: number|null, signal?: string|null, error?: Error|null, stdout?: string, stderr?: string}|null} run
 * @returns {{verdict: 'red'|'green'|'not-run', reason: string, failures: Array, realFailures: Array,
 *   environmentFailures: Array, environmentSkipped: boolean, skipDetail?: string, summary: object|null, detail: string}}
 *   `failures` is the REAL failures only; `environmentFailures` is reported separately and
 *   is never evidence about the mutant.
 */
export function classifyRun(run) {
  if (run === null || run === undefined) return notRun('the runner returned no result')
  if (run.error) return notRun(`the suite could not start: ${describeError(run.error)}`)
  if (run.status === null || run.status === undefined) {
    return notRun(
      `the suite did not exit normally (signal: ${run.signal ?? 'none'}), so there is no test result`,
    )
  }

  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  const summary = readTestSummary(output)
  const failures = readFailures(output)
  const environmentFailures = failures.filter(failure => failure.environment)
  const realFailures = failures.filter(failure => !failure.environment)
  const environmentSkipped =
    (summary.skipped ?? 0) > 0 && BROWSER_SIGNATURES.some(signature => signature.test(output))
  const skipDetail = environmentSkipped ? browserSignature(output) : undefined
  const detail =
    `exit ${run.status}, tests ${summary.tests ?? '?'}, pass ${summary.pass ?? '?'}, ` +
    `fail ${summary.fail ?? '?'}, skipped ${summary.skipped ?? '?'}`
  const base = {
    summary,
    failures: realFailures,
    realFailures,
    environmentFailures,
    environmentSkipped,
    skipDetail,
    detail,
  }

  // No test executed at all: a skipped file, a load error, or an empty suite. Red or green,
  // neither verdict would be evidence.
  if (summary.executed === 0) {
    return notRun(`no test executed (${detail}); a skipped or unloadable suite is not evidence`, base)
  }
  if (run.status === 0 && (summary.fail ?? 0) === 0) {
    return { ...base, verdict: 'green', reason: detail }
  }
  // Only a REAL failure, next to a passing test, can make a run evidence. The browser
  // failure is removed BEFORE this test, so it can never be counted as a catch.
  if (run.status !== 0 && realFailures.length > 0 && (summary.pass ?? 0) > 0) {
    return { ...base, verdict: 'red', reason: detail }
  }
  if (environmentFailures.length > 0) {
    const names = environmentFailures.map(failure => failure.name).join('; ')
    const signature = browserSignature(
      environmentFailures.map(failure => failure.detail).join('\n'),
    )
    return notRun(
      `the only failure(s) (${names}) were environmental — ${signature}; ` +
        'no rendered-layout verdict was produced',
      base,
    )
  }
  if (run.status === 0) {
    return notRun(
      `the suite exited 0 while its summary reports failures (${detail}); ` +
        'contradictory, not evidence',
      base,
    )
  }
  return notRun(
    `the suite exited ${run.status} without a failing test next to a passing one (${detail}); ` +
      'a crash or load error is not a caught mutant',
    base,
  )
}

/**
 * Decide whether the UNMUTATED baseline can judge mutants.
 *
 * A red baseline proves nothing (everything after it would look caught), and a baseline that
 * is only green because the layout case was skipped for an environmental reason has no
 * rendered-layout verdict. Both are `not-run`, with a reason the harness prints verbatim.
 *
 * @param {object|null} run - the baseline run result.
 * @returns {{verdict: 'green'|'not-run', reason: string, run?: object}} `verdict` is the
 *   baseline's usability; the underlying run classification is spread onto the result.
 */
export function classifyBaseline(run) {
  const result = classifyRun(run)
  if (result.verdict === 'green') {
    if (result.environmentSkipped) {
      return {
        ...result,
        verdict: 'not-run',
        reason:
          'the baseline went green only because the rendered-layout case was skipped for ' +
          `an environmental reason (${result.skipDetail}); no layout verdict was produced`,
      }
    }
    return result
  }
  if (result.verdict === 'red') {
    const names = result.failures.map(failure => failure.name).join('; ')
    return {
      ...result,
      verdict: 'not-run',
      reason: `the unmutated baseline is red (${names}), so a red mutant run would prove nothing`,
    }
  }
  return result
}

/**
 * Turn one mutant's run into the harness's verdict.
 *
 * @param {object|null} run - the mutant run result.
 * @param {string[]} required - the test names that MUST fail for this mutant to be caught.
 * @returns {object} one of caught / missed / partial / not-run, with `run` fields attached.
 */
export function classifyMutant(run, required = []) {
  const result = classifyRun(run)
  if (result.verdict === 'green') {
    return {
      ...result,
      verdict: 'missed',
      reason: 'the suite stayed green, so the mutant survived (no test has teeth for it)',
    }
  }
  if (result.verdict === 'not-run') return result

  const failed = result.failures.map(failure => failure.name)
  const environmentNames = result.environmentFailures.map(failure => failure.name)
  const requiredEnvironment = required.filter(name => environmentNames.includes(name))
  if (requiredEnvironment.length > 0) {
    const signature = browserSignature(
      result.environmentFailures.map(failure => failure.detail).join('\n'),
    )
    return {
      ...result,
      verdict: 'not-run',
      reason:
        `the required test(s) ${requiredEnvironment.join('; ')} failed only because the ` +
        `browser was unavailable (${signature}), so no mutant verdict exists`,
    }
  }

  const missing = required.filter(name => !failed.includes(name))
  if (missing.length === 0) {
    return {
      ...result,
      verdict: 'caught',
      reason: `every named test failed: ${required.join('; ')}`,
    }
  }
  return {
    ...result,
    verdict: 'partial',
    missing,
    reason: `red, but the named test(s) did not fail: ${missing.join('; ')}`,
  }
}
