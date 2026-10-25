/**
 * Mutation check for HANDOFF governance, the waiver, and the `recipe: docs` fast lane.
 *
 * WHAT THIS COVERS
 * `test/governance.test.mjs` states three rules, and every one of them is a NEGATIVE rule — a
 * thing the machine must refuse. A green test cannot show that its assertions actually bite, so
 * this harness re-injects each defect the rules exist to prevent and records whether the suite
 * went RED for the NAMED regression test:
 *
 *   1. THE HANDOFF GOVERNANCE (G01-G03)
 *      open features refuse HANDOFF; a waiver needs a reason; a granted waiver is durable.
 *   2. THE DOCS FAST LANE AND THE GRAPH INVARIANT (G04-G06)
 *      `docs` adds exactly BUILD -> EVALUATE; no recipe and no base-graph change may add
 *      BUILD -> COMMIT; the graph itself stays frozen.
 *   3. THE FAST LANE IS ANNOUNCED (G07)
 *      a move that skips VERIFY must say so in the payload and the rendered report, so the
 *      reader is never told the plain graph was followed.
 *
 * WHY EVERY MUTANT RUNS IN A THROWAWAY COPY (P3-4)
 * The other `mutation-check-*.mjs` harnesses rewrite `lib/` in place, hold a lock and restore the
 * bytes. That works, but a harness bug is exactly how two mutants were once left applied while
 * both runs printed "restored". This harness removes the failure mode instead of detecting it:
 * each run copies the project into a unique `%TEMP%/p3-governance-mutant-*`, writes the mutant
 * THERE, and runs the real suite there. The canonical `lib/` is never opened for writing, so the
 * restore question does not arise — the final check asserts the canonical sources are BYTE-IDENTICAL
 * to the snapshot taken before the run (exit 3 if anything outside this harness touched them). The
 * one canonical write this harness does make is the shared lock file it takes below, exactly like
 * every other harness; it is removed on release.
 *
 * THE LOCK IS STILL TAKEN, and it is not ceremony: an in-place harness running at the same time
 * would be rewriting the very `lib/` tree this one copies, so a copy could capture a mutant and
 * judge it as the baseline. Every official harness therefore shares `tooling/.mutation-lock`.
 *
 * A HARNESS THAT CANNOT FAIL IS NOT A CHECK, so the verdicts are explicit and the exit codes are
 * documented (never read 2 or 3 as success):
 *
 *   baseline first. The unmutated copy must run GREEN, or no mutant verdict is evidence: every
 *   mutant is reported NOT RUN and the harness exits 2. This is the P3-3 lesson — a mutant that
 *   is only "red" because the suite never started looks identical to a caught one.
 *
 *   CAUGHT        the suite was RED, at least one test PASSED next to the failing ones, and every
 *                 test named in `must` is among the failures. A crash or load error exits nonzero
 *                 with no passing test and is NOT a catch.
 *   SURVIVED      the mutant ran GREEN: a missing test, not a pass (exit 1).
 *   WRONG TEST    the suite was RED, but the named regression test did not fail — some other
 *                 test is doing the work, so the named property is not pinned (exit 1).
 *   NOT APPLIED   the anchor did not occur exactly once in the source (exit 1).
 *   NOT RUN       no honest verdict exists: the suite could not start, did not exit normally, or
 *                 executed zero tests (exit 2).
 *
 * Exit codes:
 *   0  real run, every mutant CAUGHT as declared (`caught=N/N`)
 *   1  a surviving mutant, a red-for-the-wrong-test mutant, an unusable anchor, or an unknown
 *      mutant id requested on the command line
 *   2  NOT RUN — the baseline is not green or a run produced no test result; not a pass.
 *      THE SAME NUMBER IS ALSO THE LOCK REFUSAL: `EXIT_LOCK_HELD` (imported from
 *      `tooling/mutation-lock.mjs`) is 2 as well, because another harness holds the shared
 *      lock and this run never started. The two are distinguished by the message — the lock
 *      case prints `<label>: <holder message>` and nothing about a baseline or a mutant. The
 *      collision is kept rather than renumbered because 2 already means "no run happened" in
 *      every harness here, and renumbering one harness would let a caller read the old 2 as
 *      "NOT RUN" when it now means something else. Neither reading is ever a pass.
 *   3  integrity failure: a canonical source changed while the harness ran (never expected)
 *
 * Usage: node tooling/mutation-check-governance.mjs [id ...]
 */

import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { basename, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runCaptured } from './child-output.mjs'
import { EXIT_LOCK_HELD, MutationLockHeld, withMutationLock } from './mutation-lock.mjs'

/** Repo-relative, like every other harness here: a clone must still run the real tree. */
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Every harness takes this lock, so no two of them can rewrite lib/ while another copies it. */
export const LABEL = 'tooling/mutation-check-governance.mjs'

export const EXIT_OK = 0
export const EXIT_UNEXPECTED = 1
export const EXIT_NOT_RUN = 2
export const EXIT_SOURCE_CHANGED = 3

/**
 * The throwaway root. Outside the project ON PURPOSE: `cpSync` refuses to copy a directory into a
 * subdirectory of itself, so a copy under `.tmp/` cannot be made at all (`ERR_FS_CP_EINVAL`).
 * Each directory is created by `mkdtempSync`, so it is unique to this process, and `removeCopy`
 * re-checks both the prefix and the parent before removing anything.
 */
const SCRATCH = tmpdir()
const COPY_PREFIX = 'p3-governance-mutant-'

/** Top-level entries never copied: VCS data, machine state, scratch and installed packages. */
const SKIP_ENTRIES = new Set(['.git', '.dsh', '.tmp', 'node_modules', 'bili-out'])

/**
 * Each mutant is one or more literal replacements in the real source, and the test(s) that MUST
 * be among the failures.
 *
 * `from`/`to` are written with LF and matched against an LF-normalised copy, because `lib/advance.js`
 * is CRLF on disk while `lib/tools.js` is LF in the same checkout. A raw-literal anchor would
 * silently apply in one file and report `anchor occurs 0 times` in the other.
 *
 * THE ANCHORS TARGET THE DECISION SITES, NOT THEIR DISPLAY. `!waiverRequested` appears only once;
 * `waiverReason === ''` only once; the `nextState` assignment is the only place the waiver is
 * persisted. Each is checked at run time to occur exactly once, so a moved source can never turn a
 * mutant into a silent no-op.
 */
export const MUTANTS = [
  {
    id: 'G01',
    what: 'HANDOFF proceeds with open features and no waiver at all',
    file: 'lib/tools.js',
    // THE DEFECT NEEDS BOTH GUARDS REMOVED, AND NOT BECAUSE EITHER ALONE STILL REFUSES.
    // Neutralising only `if (!waiverRequested)` leaves the empty-reason guard, which refuses a call
    // that supplies no reason — but that guard reads the reason STRING, not the flag, so a caller
    // that passes `waiver_reason` without `waive_open_features: true` slips past it. The
    // single-guard mutant would then exercise that side channel rather than the rule this mutant is
    // about ("no waiver at all"). Removing both makes the plain call — no flag, no reason — reach
    // the transition. The product is safe because both guards are present AND `handoffWaived`
    // (`:4041`) requires both arguments; the mutant removes both only to reach the defect.
    from: `        if (!waiverRequested) {`,
    to: `        if (false) {`,
    extra: {
      find: `        if (waiverReason === '') {`,
      replace: `        if (false) {`,
    },
    must: ['HANDOFF is refused while features are open, and the refusal names them'],
  },
  {
    id: 'G02',
    what: 'a waiver is accepted with an EMPTY reason and recorded with no justification',
    file: 'lib/tools.js',
    from: `        if (waiverReason === '') {`,
    to: `        if (false) {`,
    must: ['a waiver without a reason is refused, and nothing is recorded'],
  },
  {
    id: 'G03',
    what: 'the waiver is echoed to the caller but never persisted to the workflow state',
    file: 'lib/tools.js',
    from: `      const nextState =
        handoffWaiver === null
          ? moved.state
          : {
              ...moved.state,
              waivers: [
                ...(Array.isArray(state.waivers) ? state.waivers : []),
                handoffWaiver,
              ].slice(-HANDOFF_WAIVER_CAP),
            }`,
    to: `      const nextState = moved.state`,
    must: ['an explicit waiver with a reason is allowed, and the waiver is auditable'],
  },
  {
    id: 'G04',
    what: 'the docs recipe gains an illegal BUILD -> COMMIT edge, skipping the review',
    file: 'lib/advance.js',
    from: `  docs: Object.freeze({
    BUILD: Object.freeze(['EVALUATE']),
  }),`,
    to: `  docs: Object.freeze({
    BUILD: Object.freeze(['EVALUATE', 'COMMIT']),
  }),`,
    must: ['docs allows BUILD -> EVALUATE and NO recipe reaches COMMIT from BUILD'],
  },
  {
    id: 'G05',
    what: 'the docs fast lane disappears, so BUILD -> EVALUATE is refused as an illegal move',
    file: 'lib/advance.js',
    from: `    BUILD: Object.freeze(['EVALUATE']),`,
    to: `    BUILD: Object.freeze([]),`,
    must: ['the docs fast lane moves BUILD -> EVALUATE in the tool and names what it skipped'],
  },
  {
    id: 'G06',
    what: 'the immutable base graph itself gains the BUILD -> COMMIT edge',
    file: 'lib/advance.js',
    from: `  BUILD: Object.freeze(['VERIFY']),`,
    to: `  BUILD: Object.freeze(['VERIFY', 'COMMIT']),`,
    must: ['the frozen graph is unchanged, and a recipe edge is per call'],
  },
  {
    id: 'G07',
    what: 'the fast lane moves BUILD -> EVALUATE but is not announced, so VERIFY silently vanishes',
    file: 'lib/tools.js',
    from: `      const fastLane = fastLaneFor(state.phase, to, effective.recipe)`,
    to: `      const fastLane = null`,
    must: ['the docs fast lane moves BUILD -> EVALUATE in the tool and names what it skipped'],
  },
]

const sha = text => createHash('sha256').update(text).digest('hex').slice(0, 12)

/** Count non-overlapping occurrences of a literal. */
function occurrences(haystack, needle) {
  return haystack.split(needle).length - 1
}

/**
 * Read the spec-reporter summary (`ℹ tests 639`, `ℹ pass 632`, ...).
 *
 * The mutation suites are captured through FILE descriptors (the sandbox denies a pipe), which
 * gives the spec reporter, not TAP. Both a present count and a missing summary are meaningful:
 * a run with no summary line must never be mistaken for a green one.
 *
 * WHY THESE THREE HELPERS ARE NOT SHARED WITH `mutation-check-lock-probe.mjs`. The probe's own
 * header says it is "a temporary probe, run once and deleted: it is not part of the shipped
 * tooling"; making this shipped harness import from it would hand a throwaway file a permanent
 * contract (and the reverse cannot work either, because the probe's copy has no failing-test
 * names). The two copies HAD diverged: the probe treated `status === 0` alone as GREEN while
 * this harness also requires `fail === 0`. The divergence is now removed — the probe was
 * aligned to the stricter rule and `test/lock-probe.test.mjs` pins it — so the two copies say
 * the same thing. If the probe is ever promoted out of temporary status, extract ONE
 * `tooling/mutation-verdict.mjs` instead of keeping two copies; do not add a third.
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
 * The test names the reporter printed as failing (`✖ name (12.3ms)`), without the timing.
 *
 * The footer line `✖ failing tests:` is not a name. A name may itself contain parentheses, which
 * is why only a TRAILING `(digits ms)` is stripped rather than splitting on the first bracket.
 *
 * @param {string} output - the child's stdout+stderr.
 * @returns {string[]} unique names, in first-seen order.
 */
export function readFailingTests(output) {
  const names = []
  for (const match of String(output).matchAll(/^✖ (.+?)(?: \(\d+(?:\.\d+)?ms\))?$/gm)) {
    const name = match[1].trim()
    if (name !== 'failing tests:' && !names.includes(name)) names.push(name)
  }
  return names
}

/** One human-readable line for a spawn error, without a stack trace. */
function describeError(error) {
  return `${error?.code ? `${error.code}: ` : ''}${error?.message ?? String(error)}`
}

/**
 * Turn one runner result into a verdict. This is the whole anti-false-evidence rule, isolated so a
 * unit test can pin the NOT RUN paths without spawning anything.
 *
 * @param {{status: number|null, signal?: string|null, error?: Error|null, stdout?: string, stderr?: string}|null} run
 * @returns {{verdict: 'RED'|'GREEN'|'NOT RUN', reason: string, detail?: string, summary?: object, failing?: string[]}}
 */
export function classifyRun(run) {
  if (run === null || run === undefined) {
    return { verdict: 'NOT RUN', reason: 'the runner returned no result', failing: [] }
  }
  if (run.error) {
    return { verdict: 'NOT RUN', reason: `the suite could not start: ${describeError(run.error)}`, failing: [] }
  }
  if (run.status === null) {
    return {
      verdict: 'NOT RUN',
      reason: `the suite did not exit normally (signal: ${run.signal ?? 'none'}), so there is no test result`,
      failing: [],
    }
  }

  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  const failing = readFailingTests(output)
  const summary = readTestSummary(output)
  const detail =
    `exit ${run.status}, tests ${summary.tests ?? '?'}, pass ${summary.pass ?? '?'}, ` +
    `fail ${summary.fail ?? '?'}, skipped ${summary.skipped ?? '?'}`

  // No test executed: a skipped file, a load error, or an empty suite. Red or green, neither is
  // evidence, so this is named explicitly rather than being read as "the suite stayed green".
  if (summary.executed === 0) {
    return {
      verdict: 'NOT RUN',
      summary,
      failing,
      detail,
      reason: `no test executed (${detail}); a skipped or unloadable suite is not evidence`,
    }
  }
  if (run.status === 0 && (summary.fail ?? 0) === 0) {
    return { verdict: 'GREEN', summary, failing, detail, reason: detail }
  }
  // A red run is a caught mutant only when a test failed NEXT TO a passing one. A crash before the
  // tests (load error, uncaught throw in the harness) exits nonzero with no passing test.
  if (run.status !== 0 && (summary.fail ?? 0) > 0 && (summary.pass ?? 0) > 0) {
    return { verdict: 'RED', summary, failing, detail, reason: detail }
  }
  return {
    verdict: 'NOT RUN',
    summary,
    failing,
    detail,
    reason:
      `the suite exited ${run.status} without a failing test next to a passing one (${detail}); ` +
      'a crash or load error is not a caught mutant',
  }
}

/** Remove a throwaway copy, but only a path this module provably created under %TEMP%. */
function removeCopy(dir) {
  const resolved = resolve(dir)
  const root = resolve(SCRATCH)
  if (!resolved.startsWith(`${root}${sep}`) || !basename(resolved).startsWith(COPY_PREFIX)) {
    throw new Error(`refusing to remove a path this harness did not create: ${resolved}`)
  }
  rmSync(resolved, { recursive: true, force: true })
}

/**
 * Copy the project into `%TEMP%/p3-governance-mutant-*`, optionally write one mutated source into
 * the copy, and run the real unit suite THERE.
 *
 * The copy filter skips `.git`, `.dsh`, `.tmp`, `node_modules` and the lock file: the suite must
 * see a project shaped like this checkout, not this checkout's scratch or another harness's lock.
 *
 * @param {string|null} sourceText - the mutated file's text, or null for the unmutated baseline.
 * @param {{file?: string}} [context] - which project-relative file to write.
 * @returns {{status: number|null, signal: string|null, error: Error|null, stdout: string, stderr: string}}
 */
export function runSuiteInCopy(sourceText, context = {}) {
  mkdirSync(SCRATCH, { recursive: true })
  const dir = mkdtempSync(join(SCRATCH, COPY_PREFIX))
  try {
    cpSync(ROOT, dir, {
      recursive: true,
      filter: source => {
        const rel = relative(ROOT, source)
        if (rel === '') return true
        const [top] = rel.split(sep)
        if (SKIP_ENTRIES.has(top)) return false
        // A live lock belongs to THIS run, not to the copied project.
        return basename(source) !== '.mutation-lock'
      },
    })
    if (sourceText !== null) {
      if (typeof context.file !== 'string' || context.file === '') {
        throw new Error('a mutant run needs the project-relative file to write')
      }
      writeFileSync(join(dir, context.file), sourceText, 'utf8')
    }
    // FILE-BACKED CAPTURE: the sandbox denies a piped child (EPERM); run-unit-tests.mjs inherits
    // the descriptors, so the grandchild's output still lands in the temp files.
    return runCaptured(process.execPath, ['run-unit-tests.mjs'], { cwd: dir })
  } finally {
    removeCopy(dir)
  }
}

/**
 * Run the probe and return its verdicts.
 *
 * Exported behind an `invokedPath` guard so the unit test can inject a fake runner and pin the
 * NOT RUN / SURVIVED / WRONG TEST paths without spawning anything.
 *
 * @param {object} [options]
 * @param {Function} [options.runTests] - `(sourceText|null, context) => run result`; defaults to a
 *   real suite run in a throwaway copy.
 * @param {Array} [options.mutants] - defaults to MUTANTS.
 * @param {string[]} [options.only] - optional mutant ids to run (the baseline still runs).
 * @param {Function} [options.log] - sink for the report; defaults to console.log.
 * @returns {{exitCode: number, baseline: object, rows: Array, canonicalUnchanged: boolean}}
 */
export function runGovernanceProbe({
  runTests = runSuiteInCopy,
  mutants = MUTANTS,
  only = [],
  log = console.log,
} = {}) {
  const wanted = new Set(only)
  const selected = [...mutants].filter(mutant => wanted.size === 0 || wanted.has(mutant.id))
  // A TYPO MUST NOT LOOK LIKE A CLEAN RUN. Filtering an unknown id to "no mutants" would run the
  // baseline, print `mutants: 0` and exit 0 — a green report for a check that did not happen.
  const unknown = [...wanted].filter(id => !mutants.some(mutant => mutant.id === id))
  if (unknown.length > 0) {
    log(`no mutant has the requested id(s): ${unknown.join(', ')}`)
    log(`known ids: ${mutants.map(mutant => mutant.id).join(', ')}`)
    return { exitCode: EXIT_UNEXPECTED, baseline: null, rows: [], canonicalUnchanged: true }
  }
  const files = [...new Set(selected.map(mutant => mutant.file))]

  // SNAPSHOT BEFORE ANY RUN. The copy-based design means nothing here should write these files;
  // hashing them anyway turns that design claim into a checked fact (exit 3 if it is false).
  const originals = new Map(files.map(file => [file, readFileSync(join(ROOT, file), 'utf8')]))
  const hashes = new Map([...originals].map(([file, text]) => [file, sha(text)]))
  const anchors = new Map([...originals].map(([file, text]) => [file, text.replace(/\r\n/g, '\n')]))

  log(`source: ${ROOT}`)
  log('no mutant is written into the canonical sources: each runs in a throwaway %TEMP% copy.\n')

  const baseline = classifyRun(runTests(null, { kind: 'baseline' }))
  log(`baseline (unmutated, full suite in a copy): ${baseline.verdict} — ${baseline.reason}`)
  log(
    baseline.verdict === 'GREEN'
      ? ''
      : 'baseline not green: a red mutant run here would prove nothing, so no mutant is counted.\n',
  )

  const rows = []
  for (const mutant of selected) {
    const edits = [
      { find: mutant.from, replace: mutant.to },
      ...(mutant.extra === undefined ? [] : Array.isArray(mutant.extra) ? mutant.extra : [mutant.extra]),
    ]
    const anchorText = anchors.get(mutant.file)
    let mutated = anchorText
    const problems = []
    for (const edit of edits) {
      const seen = occurrences(mutated, edit.find)
      if (seen !== 1) {
        problems.push(`anchor occurs ${seen}x (expected 1): ${JSON.stringify(edit.find.slice(0, 70))}`)
        continue
      }
      mutated = mutated.replace(edit.find, edit.replace)
    }
    if (problems.length > 0) {
      rows.push({ ...mutant, verdict: 'NOT APPLIED', reason: problems.join(' | '), failing: [] })
      continue
    }
    if (baseline.verdict !== 'GREEN') {
      rows.push({
        ...mutant,
        verdict: 'NOT RUN',
        reason: `the unmutated baseline is ${baseline.verdict}, so no mutant verdict can be evidence`,
        failing: [],
      })
      continue
    }

    // KEEP THE FILE'S OWN LINE-ENDING STYLE, so the reintroduced defect is the ONLY difference
    // between the mutant copy and the baseline copy.
    const styled = originals.get(mutant.file).includes('\r\n') ? mutated.replace(/\n/g, '\r\n') : mutated
    const classification = classifyRun(
      runTests(styled, { kind: 'mutant', mutant, file: mutant.file }),
    )

    if (classification.verdict === 'NOT RUN') {
      rows.push({ ...mutant, verdict: 'NOT RUN', reason: classification.reason, failing: classification.failing })
      continue
    }
    if (classification.verdict === 'GREEN') {
      rows.push({
        ...mutant,
        verdict: 'SURVIVED',
        reason: `the whole suite stayed green (${classification.detail}) — a missing test, not a pass`,
        failing: [],
      })
      continue
    }

    const missing = mutant.must.filter(name => !classification.failing.includes(name))
    if (missing.length > 0) {
      rows.push({
        ...mutant,
        verdict: 'WRONG TEST',
        reason:
          `RED, but the named test(s) did not fail: ${missing.map(name => `"${name}"`).join(', ')}. ` +
          `Failing: ${classification.failing.join('; ') || '(none parsed)'}`,
        failing: classification.failing,
      })
      continue
    }
    rows.push({
      ...mutant,
      verdict: 'CAUGHT',
      reason: classification.detail,
      failing: classification.failing,
    })
  }

  const unusableAnchors = rows.filter(row => row.verdict === 'NOT APPLIED').length
  log('mutation check: HANDOFF governance, the waiver and the docs fast lane')
  // "VERIFIED" IS A CLAIM ABOUT EVERY ANCHOR. An anchor that did not occur exactly once never ran
  // its mutant, so printing "anchors verified" next to a NOT APPLIED row would be a false headline
  // over a report whose exit code says the run failed.
  log(
    unusableAnchors === 0
      ? `anchors verified against ${rows.length} mutant(s)\n`
      : `anchors NOT all applied: ${unusableAnchors} of ${rows.length} mutant(s) had an unusable ` +
          `anchor — see the NOT APPLIED row(s)\n`,
  )

  for (const row of rows) {
    log(`${row.verdict.padEnd(12)} ${row.id}  ${row.file}`)
    log(`  defect: ${row.what}`)
    log(`  ${row.reason}`)
    for (const name of (row.failing ?? []).slice(0, 3)) log(`    RED: ${name}`)
    if ((row.failing ?? []).length > 3) log(`    RED: … and ${row.failing.length - 3} more`)
    log('')
  }

  // The design claim, checked: the canonical files must be byte-identical to the snapshot.
  let canonicalUnchanged = true
  for (const [file, original] of originals) {
    let now
    try {
      now = readFileSync(join(ROOT, file), 'utf8')
    } catch {
      canonicalUnchanged = false
      continue
    }
    if (now !== original || sha(now) !== hashes.get(file)) canonicalUnchanged = false
    log(`  ${file}: ${now === original ? 'unchanged' : 'CHANGED — INVESTIGATE'}`)
  }
  log(
    `\ncanonical sources unchanged (no mutant ran against them; every mutant ran in a throwaway copy): ` +
      `${canonicalUnchanged ? 'YES' : 'NO — INVESTIGATE'}`,
  )

  const counts = {
    caught: rows.filter(row => row.verdict === 'CAUGHT').length,
    survived: rows.filter(row => row.verdict === 'SURVIVED').length,
    wrongTest: rows.filter(row => row.verdict === 'WRONG TEST').length,
    notRun: rows.filter(row => row.verdict === 'NOT RUN').length,
    notApplied: rows.filter(row => row.verdict === 'NOT APPLIED').length,
  }
  log(
    `\nmutants: ${rows.length}; caught: ${counts.caught}; survived: ${counts.survived}; ` +
      `wrong test: ${counts.wrongTest}; not run: ${counts.notRun}; not applied: ${counts.notApplied}`,
  )

  if (!canonicalUnchanged) {
    log(`INTEGRITY FAILURE: a canonical source changed while the harness ran (exit ${EXIT_SOURCE_CHANGED}).`)
    return { exitCode: EXIT_SOURCE_CHANGED, baseline, rows, canonicalUnchanged }
  }
  if (counts.notRun > 0) {
    log(`NOT RUN: no honest verdict exists for ${counts.notRun} mutant(s), so this is NOT a pass (exit ${EXIT_NOT_RUN}).`)
    return { exitCode: EXIT_NOT_RUN, baseline, rows, canonicalUnchanged }
  }
  if (counts.survived > 0 || counts.wrongTest > 0 || counts.notApplied > 0) {
    log(
      `UNEXPECTED: ${counts.survived} survivor(s), ${counts.wrongTest} caught by the wrong test, ` +
        `${counts.notApplied} unusable anchor(s) (exit ${EXIT_UNEXPECTED}).`,
    )
    return { exitCode: EXIT_UNEXPECTED, baseline, rows, canonicalUnchanged }
  }
  log(`every mutant was caught by its named test (exit ${EXIT_OK}).`)
  return { exitCode: EXIT_OK, baseline, rows, canonicalUnchanged }
}

async function main() {
  await withMutationLock(
    async () => {
      console.log(`${LABEL}: mutation lock acquired`)
      const { exitCode } = runGovernanceProbe({ only: process.argv.slice(2) })
      process.exitCode = exitCode
    },
    { label: LABEL },
  )
}

// `main` guard: importing this module (the unit test does) must not run the probe.
const invokedPath = process.argv[1] === undefined ? null : resolve(process.argv[1])
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    await main()
  } catch (error) {
    if (error instanceof MutationLockHeld) {
      console.error(`${LABEL}: ${error.message}`)
      process.exit(EXIT_LOCK_HELD)
    }
    throw error
  }
}
