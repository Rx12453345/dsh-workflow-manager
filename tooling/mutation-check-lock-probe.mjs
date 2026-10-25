/**
 * Mutation check for `tooling/mutation-lock.mjs` + `test/mutation-lock.test.mjs`.
 *
 * A TEMPORARY probe, run once and deleted: it is not part of the shipped tooling and adds no
 * wiring. It exists because the lock's own regression tests must be shown to FAIL when the
 * defect is reintroduced — a test that cannot go red proves nothing.
 *
 * WHAT IT STILL KEEPS SAFE: the mutant is never written into the working tree. Each mutant source
 * is written into a full COPY of the project under %TEMP%, and `node --test` runs THERE, so the
 * canonical `tooling/mutation-lock.mjs` is untouched by construction. (One mutant per run, and
 * the copy is removed afterwards.)
 *
 * WHY THIS FILE CAN NO LONGER INVENT A CAUGHT MUTANT (P3-1)
 * The probe used to capture its child through a piped `spawnSync`. The DSH Windows sandbox
 * denies that pipe (EPERM), so the child never started, `status` came back `null`, and the probe
 * read `status !== 0` as "the mutant made the suite fail". With zero tests executed it printed
 * `4/4 caught` and exited 0 — worse than no evidence, because it looked like a pass.
 *
 * The capture now goes through `tooling/child-output.mjs` (temp-file descriptors, no pipe), and a
 * mutant is called caught only when a real test failed:
 *
 *   RED      at least one test failed AND at least one passed — the mutant was caught.
 *   GREEN    the suite passed — the mutant survived (a MISSED mutant).
 *   NOT RUN  the suite could not start (`result.error`), did not exit normally (`status ===
 *            null`), executed zero tests (a skipped or unloadable file), or exited nonzero
 *            without a failing test next to a passing one (a crash/load error, not a result).
 *
 * THE UNMUTATED BASELINE RUNS FIRST AND MUST BE GREEN. If the suite is already red in this
 * environment — the lock tests that spawn a piped child fail in the DSH sandbox — then a red
 * mutant run proves nothing, and every mutant is reported NOT RUN instead of being counted as
 * caught. A normal terminal runs the real L1–L4 mutants and reports their real verdicts.
 *
 * EXIT CODES (documented so 2/3 can never be mistaken for success):
 *   0  real run, every mutant behaved as declared (`4 caught`)
 *   1  real run, an unexpected verdict (a surviving mutant) or an unusable mutant anchor
 *   2  NOT RUN — no honest verdict exists here; the reason is printed, and this is not a pass
 *   3  integrity failure: the canonical source changed while the probe was running (never expected)
 *
 * Usage: node tooling/mutation-check-lock-probe.mjs
 *          (a normal terminal: the real L1–L4 mutants run and are judged)
 *        DSH_WORKFLOW_SANDBOX=1 node tooling/mutation-check-lock-probe.mjs
 *          (inside the DSH sandbox: the five lock tests that spawn a piped child skip with a
 *           reason, the baseline goes GREEN, and the real mutants are judged)
 *
 * Without that flag in the DSH sandbox the probe prints NOT RUN and exits 2: the lock suite
 * itself is red there (its piped children are denied EPERM), so no mutant verdict is evidence.
 * That is the honest answer, not a pass; do not read exit 2 as success.
 */

import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runCaptured } from './child-output.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SOURCE = join(ROOT, 'tooling', 'mutation-lock.mjs')

export const EXIT_OK = 0
export const EXIT_UNEXPECTED = 1
export const EXIT_NOT_RUN = 2
export const EXIT_SOURCE_CHANGED = 3

/**
 * Each mutant is one literal replacement in the real source. `from` MUST be present exactly
 * once, so a mutant can never silently become a no-op when the source moves — and an anchor
 * that matched the WRONG occurrence would mutate a different site and produce evidence for a
 * defect that was never reintroduced.
 *
 * L1 and L3 anchor on the `inspectLock` decision site specifically: `readLockTimestamp(holder)`
 * also appears in `describeHolder`, so the shorter anchor used to replace the DISPLAY call and
 * left the real stale decision untouched.
 */
export const MUTANTS = [
  {
    id: 'L1',
    description: 'the defect itself: an unreadable `at` is read as epoch 0 (`: 0` reinstated)',
    from: 'const atMs = readLockTimestamp(holder)\n  const cap = lockTtlMs()',
    to: "const atMs = (typeof holder.at === 'number' ? holder.at : 0)\n  const cap = lockTtlMs()",
    expected: 'RED',
  },
  {
    id: 'L2',
    description: 'the unknown-age branch is removed, so unknown age is always stale',
    from: `  if (atMs === null) {
    if (running === true) {
      return {
        exists: true,
        stale: false,
        holder,
        reason:
          \`the holder pid \${holder.pid} is still running and the lock's age could not be determined \` +
          \`(the recorded acquisition time is missing or unreadable)\`,
      }
    }
    if (running === false) {`,
    to: `  if (atMs === null) {
    if (false) {
    }
    if (running === false) {`,
    expected: 'RED',
  },
  {
    id: 'L3',
    description: 'the `at` value is used raw: no tolerant read, so an ISO string becomes NaN/epoch 0',
    from: 'const atMs = readLockTimestamp(holder)\n  const cap = lockTtlMs()',
    to: 'const atMs = holder.at\n  const cap = lockTtlMs()',
    expected: 'RED',
  },
  {
    id: 'L4',
    description: '`readLockTimestamp` always answers null (the unknown path swallows everything)',
    from: "function readLockTimestamp(holder) {\n  if (holder === null || typeof holder !== 'object') return null",
    to: "function readLockTimestamp(holder) {\n  return null\n  if (holder === null || typeof holder !== 'object') return null",
    expected: 'RED',
  },
]

/** One human-readable line for a spawn error, without a stack trace. */
function describeError(error) {
  const code = error?.code ? `${error.code}: ` : ''
  return `${code}${error?.message ?? String(error)}`
}

/**
 * Parse the counts out of a `node --test` run.
 *
 * TAP (the reporter used when stdout is a file, which is what `runCaptured` gives us) prints
 * `# tests 30` / `# pass 25`; the spec reporter prints the same numbers prefixed with `ℹ`. Both
 * are read, because the point of the counts is to prove that tests actually executed — a run
 * with no summary line must not be mistaken for a green one.
 *
 * @param {string} output - the child's stdout+stderr.
 * @returns {{tests: number|null, pass: number|null, fail: number|null, skipped: number|null, executed: number}}
 */
export function readTestSummary(output) {
  const count = label => {
    const match = String(output).match(new RegExp(`^(?:#|ℹ)\\s*${label}\\s+(\\d+)\\s*$`, 'm'))
    return match === null ? null : Number(match[1])
  }
  const tests = count('tests')
  const pass = count('pass')
  const fail = count('fail')
  const skipped = count('skipped')
  return { tests, pass, fail, skipped, executed: (pass ?? 0) + (fail ?? 0) }
}

/**
 * Turn one runner result into a verdict. This is the whole anti-false-evidence rule, isolated so
 * the unit test can pin it without spawning anything.
 *
 * @param {{status: number|null, signal?: string|null, error?: Error|null, stdout?: string, stderr?: string}|null} run
 * @returns {{verdict: 'RED'|'GREEN'|'NOT RUN', reason: string, detail?: string, summary?: object}}
 */
export function classifyRun(run) {
  if (run === null || run === undefined) {
    return { verdict: 'NOT RUN', reason: 'the runner returned no result' }
  }
  if (run.error) {
    return { verdict: 'NOT RUN', reason: `the suite could not start: ${describeError(run.error)}` }
  }
  if (run.status === null) {
    return {
      verdict: 'NOT RUN',
      reason: `the suite did not exit normally (signal: ${run.signal ?? 'none'}), so there is no test result`,
    }
  }

  const summary = readTestSummary(`${run.stdout ?? ''}${run.stderr ?? ''}`)
  const detail =
    `exit ${run.status}, tests ${summary.tests ?? '?'}, pass ${summary.pass ?? '?'}, ` +
    `fail ${summary.fail ?? '?'}, skipped ${summary.skipped ?? '?'}`

  // No test executed at all: a skipped file, a load error, or an empty suite. Red or green,
  // neither verdict would be evidence, so this case is named explicitly.
  if (summary.executed === 0) {
    return {
      verdict: 'NOT RUN',
      summary,
      detail,
      reason: `no test executed (${detail}); a skipped or unloadable file is not evidence`,
    }
  }
  if (run.status === 0) {
    return { verdict: 'GREEN', summary, detail, reason: detail }
  }
  // A red run is a caught mutant only when a test failed NEXT TO a passing one. A crash before
  // the tests (load error, uncaught throw in the harness) exits nonzero with no passing test,
  // and calling that "caught" is the same false evidence in a new costume.
  if ((summary.fail ?? 0) > 0 && (summary.pass ?? 0) > 0) {
    return { verdict: 'RED', summary, detail, reason: detail }
  }
  return {
    verdict: 'NOT RUN',
    summary,
    detail,
    reason: `the suite exited nonzero without a failing test next to a passing one (${detail}); a crash or load error is not a caught mutant`,
  }
}

/**
 * Run the lock suite in a throwaway copy of the project with `sourceText` in place.
 *
 * The child is captured through file descriptors, never a pipe: the DSH sandbox denies a pipe
 * (EPERM), which is exactly how the old probe produced its false 4/4. The copy is always removed.
 *
 * @param {string} sourceText - the `tooling/mutation-lock.mjs` text to run against.
 * @returns {{status: number|null, signal: string|null, error: Error|null, stdout: string, stderr: string}}
 */
export function runSuiteInCopy(sourceText) {
  const dir = mkdtempSync(join(tmpdir(), 'p5-lock-mutant-'))
  try {
    cpSync(join(ROOT, 'test'), join(dir, 'test'), { recursive: true })
    cpSync(join(ROOT, 'tooling'), join(dir, 'tooling'), { recursive: true })
    writeFileSync(join(dir, 'tooling', 'mutation-lock.mjs'), sourceText, 'utf8')
    return runCaptured(
      process.execPath,
      ['--test', '--test-isolation=none', join(dir, 'test', 'mutation-lock.test.mjs')],
      { cwd: dir },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** How many times `needle` occurs in `haystack`. */
function occurrences(haystack, needle) {
  return haystack.split(needle).length - 1
}

/**
 * Run the probe and return its verdicts. Exported behind a `main` guard so a unit test can
 * inject a failing runner and pin the NOT RUN path without spawning a child.
 *
 * @param {object} [options]
 * @param {Function} [options.runTests] - `(sourceText, context) => run result`; defaults to a
 *   real `node --test` run in a temp copy. The test injects a fake to simulate EPERM.
 * @param {Array} [options.mutants] - defaults to MUTANTS.
 * @param {string} [options.source] - an injected source text (tests only); defaults to reading
 *   SOURCE. An injected text is normalised for anchor matching and the canonical file is not
 *   part of the run, so the byte-for-byte check does not apply to it.
 * @param {Function} [options.log] - sink for the report; defaults to console.log.
 * @returns {{exitCode: number, baseline: object, rows: Array}}
 */
export function runProbe({
  runTests = runSuiteInCopy,
  mutants = MUTANTS,
  source,
  log = console.log,
} = {}) {
  const injected = source !== undefined
  const raw = injected ? source : readFileSync(SOURCE, 'utf8')
  // ANCHORS ARE LF LITERALS AND MAY BE CRLF IN A WINDOWS CHECKOUT. Raw matching would report
  // all four mutants NOT APPLIED on a clean checkout with `core.autocrlf=true` — the same
  // failure that skipped 29 mutants in `mutation-check-approval.mjs` before it normalised.
  // Normalise once and use that text for the baseline and for every mutant.
  const original = String(raw).replace(/\r\n/g, '\n')

  log(`source: ${SOURCE}`)
  log('source untouched by design: each mutant runs in a %TEMP% copy.\n')

  const baseline = classifyRun(runTests(original, { kind: 'baseline' }))
  log(`baseline (unmutated): ${baseline.verdict} — ${baseline.reason}`)
  log(
    baseline.verdict === 'GREEN'
      ? ''
      : 'baseline not green: a red mutant run here would prove nothing, so no mutant is counted.\n',
  )

  const rows = []
  for (const mutant of mutants) {
    const seen = occurrences(original, mutant.from)
    if (seen !== 1) {
      rows.push({
        ...mutant,
        verdict: 'NOT APPLIED',
        reason: `the anchor occurs ${seen} times in the source; it must occur exactly once`,
      })
      continue
    }
    if (baseline.verdict !== 'GREEN') {
      rows.push({
        ...mutant,
        verdict: 'NOT RUN',
        reason: `the unmutated baseline is ${baseline.verdict}, so no mutant verdict can be evidence`,
      })
      continue
    }
    const classification = classifyRun(
      runTests(original.replace(mutant.from, mutant.to), { kind: 'mutant', mutant }),
    )
    rows.push({ ...mutant, verdict: classification.verdict, reason: classification.reason })
  }

  for (const row of rows) {
    log(`${row.id} ${row.verdict} — ${row.reason} — ${row.description}`)
  }

  log('\n| mutant | change | run | verdict |')
  log('|---|---|---|---|')
  for (const row of rows) {
    const verdict =
      row.verdict === 'RED'
        ? 'RED — caught'
        : row.verdict === 'GREEN'
          ? 'GREEN — missed'
          : `${row.verdict}: ${row.reason}`
    log(`| ${row.id} | ${row.description} | ${row.reason} | ${verdict} |`)
  }

  const real = rows.filter(row => row.verdict === 'RED' || row.verdict === 'GREEN')
  const notRun = rows.filter(row => row.verdict === 'NOT RUN')
  const notApplied = rows.filter(row => row.verdict === 'NOT APPLIED')
  const caught = real.filter(row => row.verdict === row.expected)
  const unexpected = real.filter(row => row.verdict !== row.expected)

  // The canonical file is never written by this probe, so this can only catch an outside writer
  // while the run is in progress. An injected source (tests only) is not that file.
  const sourceIntact = injected ? true : readFileSync(SOURCE, 'utf8') === raw
  log(
    `\nmutants: ${rows.length}; caught: ${caught.length}; not run: ${notRun.length}; ` +
      `not applied: ${notApplied.length}; unexpected: ${unexpected.length}`,
  )
  log(`source restored byte-for-byte: ${sourceIntact ? 'YES' : 'NO'}`)

  if (!sourceIntact) {
    log(`INTEGRITY FAILURE: the canonical source changed while the probe ran (exit ${EXIT_SOURCE_CHANGED}).`)
    return { exitCode: EXIT_SOURCE_CHANGED, baseline, rows }
  }
  if (notRun.length > 0) {
    log(`NOT RUN: no honest verdict exists here, so this is NOT a pass (exit ${EXIT_NOT_RUN}).`)
    return { exitCode: EXIT_NOT_RUN, baseline, rows }
  }
  if (notApplied.length > 0 || unexpected.length > 0) {
    const ids = [...notApplied, ...unexpected].map(row => row.id).join(', ')
    log(`UNEXPECTED: ${ids} did not behave as declared (exit ${EXIT_UNEXPECTED}).`)
    return { exitCode: EXIT_UNEXPECTED, baseline, rows }
  }
  log(`every mutant was caught as declared (exit ${EXIT_OK}).`)
  return { exitCode: EXIT_OK, baseline, rows }
}

// `main` guard: importing this module (the unit test does) must not run the probe.
const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  process.exitCode = runProbe().exitCode
}
