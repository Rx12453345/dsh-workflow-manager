/**
 * B5.2 mutation harness (temporary, lives OUTSIDE the plugin package).
 *
 * For each mutant: apply a literal edit to lib/client.js, run the panel's own test file,
 * record whether the NAMED test went RED, then restore the file byte-for-byte and verify
 * the hash.
 *
 * THE BASELINE RUNS FIRST, AND A RED BASELINE IS NOT EVIDENCE (P3-3). `test/status.test.mjs`
 * contains the Chromium layout measurement. In the DSH sandbox Chromium cannot start, so the
 * suite is red there for an ENVIRONMENT reason. Counting that red as a caught mutant made
 * every mutant "caught". `tooling/mutation-verdict.mjs` classifies the run: only a REAL
 * failing assertion next to a passing test can catch a mutant, and a baseline that produces
 * no verdict is NOT RUN (exit 2, printed by name — including "the browser exited early with
 * ..."). A surviving mutant is exit 1, so the two can never be confused.
 *
 * EXIT CODES: 0 every mutant caught; 1 a surviving/partial mutant; 2 NOT RUN (no verdict —
 * not a pass); 3 source integrity failure; 4 APPLY-FAILED (an unusable mutant anchor).
 *
 * Usage: node tooling/mutation-check-client.mjs [M1 M4 ...]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { runCaptured } from './child-output.mjs'
import { EXIT_LOCK_HELD, MutationLockHeld, withMutationLock } from './mutation-lock.mjs'
import {
  EXIT_NOT_RUN,
  classifyBaseline,
  classifyMutant,
  resolveHarnessExit,
} from './mutation-verdict.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const FILE = `${ROOT}/lib/client.js`
const only = new Set(process.argv.slice(2))

/** Every harness takes this lock, so no two of them can rewrite lib/ at the same time. */
const LABEL = 'tooling/mutation-check-client.mjs'

const MUTANTS = [
  {
    id: 'M1',
    what: 'approval.strength goes back to a whole-section write from the render value',
    find: `              onChange: event => writeField('approval', 'strength', event.target.value),`,
    replace: `              onChange: event =>
                write('approval', { ...section('approval'), strength: event.target.value }),`,
    must: ['no control writes a whole section from a value read at render time'],
  },
  {
    id: 'M2',
    what: 'evaluator.independent goes back to a whole-section write',
    find: `            onChange: event => writeField('evaluator', 'independent', event.target.checked),`,
    replace: `            onChange: event =>
              write('evaluator', { ...(value.evaluator ?? {}), independent: event.target.checked }),`,
    must: ['no control writes a whole section from a value read at render time'],
  },
  {
    id: 'M3',
    what: 'fieldOps drops the section segment from the path',
    find: `      return [{ op: 'set', path: [section, key], value }]`,
    replace: `      return [{ op: 'set', path: [key], value }]`,
    must: ['every nested field op the panel builds is one the host writer accepts'],
  },
  {
    id: 'M4',
    what: 'listValue stops refusing the empty dimensions list',
    find: `      if (items.length === 0 && !allowEmpty) return undefined`,
    replace: `      if (false) return undefined`,
    must: ['the panel never writes the empty dimension list the gate refuses'],
  },
  {
    id: 'M5',
    what: 'stringList FILTERS a mixed list instead of refusing it',
    find: `      if (!Array.isArray(raw) || raw.some(item => typeof item !== 'string')) return []
      return [...raw]`,
    replace: `      if (!Array.isArray(raw)) return []
      return raw.filter(item => typeof item === 'string')`,
    must: ['the panel never flattens a mixed list into a narrower one'],
  },
  {
    id: 'M6',
    what: 'intValue drops the integer check',
    find: `      if (!Number.isInteger(next) || next < minimum) return undefined`,
    replace: `      if (next < minimum) return undefined`,
    must: ['the whole-number controls cannot produce a value the writer refuses'],
  },
  {
    id: 'M7',
    what: 'intValue ignores the upper bound (maxDepth 3 would be writable)',
    find: `      if (maximum !== undefined && next > maximum) return undefined
`,
    replace: ``,
    must: ['the whole-number controls cannot produce a value the writer refuses'],
  },
  {
    id: 'M8',
    what: 'prunedMustPass stops pruning (veto set keeps a dropped dimension)',
    find: `      return current.filter(dimension => dimensions.includes(dimension))`,
    replace: `      return [...current]`,
    must: ['the veto set the panel writes always names only scored dimensions'],
  },
  {
    id: 'M9',
    what: 'toggledMustPass returns the raw set (keeps non-scored entries)',
    find: `      return dimensions.filter(dimension => selected.has(dimension))`,
    replace: `      return [...selected]`,
    must: ['the veto set the panel writes always names only scored dimensions'],
  },
  {
    id: 'M10',
    what: 'the mirrored depth ceiling drifts to 3',
    find: `    const MAX_DEPTH = 2`,
    replace: `    const MAX_DEPTH = 3`,
    must: ['the panel states the same delegation ceiling as the host config'],
  },
  {
    id: 'M11',
    what: 'the dimensions control writes only the dimensions (no veto prune)',
    find: `              writeOps([
                ...fieldOps('evaluator', 'dimensions', next),
                ...fieldOps('evaluator', 'mustPass', kept),
              ])`,
    replace: `              writeField('evaluator', 'dimensions', next)`,
    must: ['the panel wires the guarded builders to the live controls'],
  },
  {
    id: 'M12',
    what: 'the veto checkbox toggles inline, dropping the subset guard',
    find: `                  toggledMustPass(mustPassValue, dimensionNames, name, event.target.checked),`,
    replace: `                  event.target.checked
                    ? [...mustPassValue, name]
                    : mustPassValue.filter(dimension => dimension !== name),`,
    must: ['the panel wires the guarded builders to the live controls'],
  },
  {
    id: 'M13',
    what: 'the dimensions control allows an empty list through to the host',
    find: `              const next = listValue(event.target.value, { allowEmpty: false })`,
    replace: `              const next = listValue(event.target.value, { allowEmpty: true })`,
    must: ['the panel wires the guarded builders to the live controls'],
  },
  {
    id: 'M14',
    what: 'the veto checkboxes are built from a hardcoded list of dimensions',
    find: `      const dimensionNames = stringList(value.evaluator?.dimensions)`,
    replace: `      const dimensionNames = ['correctness', 'build', 'tests', 'regressions', 'archFit', 'legibility', 'scope']`,
    must: ['the panel wires the guarded builders to the live controls'],
  },
]

const sha = text => createHash('sha256').update(text).digest('hex').slice(0, 12)

/**
 * Everything that touches lib/client.js happens under the lock: the snapshot, every mutant,
 * every restore, and the final verification. Nothing is read before the lock is held, so a
 * concurrently running harness cannot have its mutant recorded here as "the original".
 *
 * The signal handlers are registered BEFORE the lock is taken (so they run before the lock's
 * own backstop handler: Node runs handlers in registration order). `original` stays null until
 * the lock is held, so a Ctrl-C during acquisition can never write `undefined` over the source.
 */
async function main() {
  let original = null
  const restore = () => {
    if (original !== null) writeFileSync(FILE, original, 'utf8')
  }
  process.once('SIGINT', () => {
    restore()
    process.exit(130)
  })
  process.once('SIGTERM', () => {
    restore()
    process.exit(143)
  })

  await withMutationLock(
    async () => {
      console.log(`${LABEL}: mutation lock acquired`)
      original = readFileSync(FILE, 'utf8')
      const before = sha(original)
      const selected = MUTANTS.filter(mutant => only.size === 0 || only.has(mutant.id))
      const runSuite = () =>
        runCaptured(process.execPath, ['--test', '--test-isolation=none', 'test/status.test.mjs'], {
          cwd: ROOT,
        })

      // THE BASELINE IS THE FIRST PIECE OF EVIDENCE. `node run-unit-tests.mjs` sets
      // DSH_WORKFLOW_SANDBOX, but this harness spawns the file directly — so in the DSH sandbox
      // the layout case reaches Chromium and fails to start the browser. That red is an
      // environment failure, not a caught mutant, and no mutant is counted from it.
      const baseline = classifyBaseline(runSuite())
      console.log(
        `baseline (unmutated): ${baseline.verdict === 'green' ? 'GREEN' : 'NOT RUN'} — ${baseline.reason}`,
      )

      const rows = []
      if (baseline.verdict !== 'green') {
        console.log(
          `NOT RUN: the unmutated baseline produced no verdict, so no mutant is counted. ` +
            `${selected.length} mutant(s) would have been applied and judged: ` +
            `${selected.map(mutant => mutant.id).join(', ')}. This is NOT a pass ` +
            `(exit ${EXIT_NOT_RUN}); run this harness in a normal terminal with a Chromium-family browser.`,
        )
        for (const mutant of selected) {
          rows.push({
            ...mutant,
            verdict: 'not-run',
            reason: `the unmutated baseline is NOT RUN — ${baseline.reason}`,
          })
        }
      } else {
        // A CRLF checkout must not turn a valid anchor into a skipped mutant.
        const normalised = original.replace(/\r\n/g, '\n')
        for (const mutant of selected) {
          const occurrences = normalised.split(mutant.find).length - 1
          if (occurrences !== 1) {
            rows.push({
              ...mutant,
              verdict: 'apply-failed',
              problem: `literal occurs ${occurrences}x`,
            })
            continue
          }
          const mutated = normalised.replace(mutant.find, mutant.replace)
          let result
          try {
            writeFileSync(FILE, mutated, 'utf8')
            result = classifyMutant(runSuite(), mutant.must)
          } finally {
            restore()
          }
          rows.push({
            ...mutant,
            verdict: result.verdict,
            red: result.verdict === 'caught' || result.verdict === 'partial',
            failed: result.failures.map(failure => failure.name),
            environmentFailures: result.environmentFailures.map(failure => failure.name),
            missing: result.missing ?? [],
            reason: result.reason,
          })
        }
      }

      restore()
      const after = sha(readFileSync(FILE, 'utf8'))
      console.log('=== B5.2 MUTATION RESULTS ===')
      for (const row of rows) {
        if (row.verdict === 'apply-failed') {
          console.log(`${row.id.padEnd(4)} APPLY-FAILED  ${row.problem}`)
          continue
        }
        const mark =
          row.verdict === 'caught'
            ? 'CAUGHT '
            : row.verdict === 'partial'
              ? 'PARTIAL'
              : row.verdict === 'missed'
                ? 'MISSED '
                : 'NOT RUN'
        console.log(`${row.id.padEnd(4)} ${mark} red=${row.red ? 'yes' : 'no '} count=${(row.failed ?? []).length}`)
        console.log(`     what: ${row.what}`)
        if (row.missing?.length) console.log(`     NOT failing: ${row.missing.join(' ; ')}`)
        if (row.environmentFailures?.length) {
          console.log(`     environment failure (NOT counted): ${row.environmentFailures.join(' ; ')}`)
        }
        if (row.failed?.length) {
          console.log(`     failing: ${row.failed.slice(0, 4).join(' ; ')}${row.failed.length > 4 ? ` (+${row.failed.length - 4})` : ''}`)
        }
        if (row.verdict === 'not-run' || row.verdict === 'partial') {
          console.log(`     reason: ${row.reason}`)
        }
      }
      console.log(`\nsource restored byte-for-byte: ${before === after ? 'YES' : 'NO — INVESTIGATE'}`)

      const count = verdict => rows.filter(row => row.verdict === verdict).length
      console.log(
        `baseline ${baseline.verdict === 'green' ? 'green' : 'NOT RUN'}; ` +
          `caught ${count('caught')}; partial ${count('partial')}; missed ${count('missed')}; ` +
          `not run ${count('not-run')}; apply-failed ${count('apply-failed')}`,
      )

      // THE EXIT CODE COMES FROM THE BASELINE TOO, NOT FROM THE ROWS. An empty mutant
      // selection (a typo'd id) has zero rows, and a row-only ladder would exit 0 on a
      // NOT RUN baseline while printing "This is NOT a pass".
      const exitCode = resolveHarnessExit({
        integrityOk: before === after,
        baselineVerdict: baseline.verdict,
        applyFailed: count('apply-failed'),
        notRun: count('not-run'),
        missed: count('missed'),
        partial: count('partial'),
      })
      if (exitCode === EXIT_NOT_RUN) {
        console.log(`NOT RUN: no honest verdict exists here, so this is NOT a pass (exit ${EXIT_NOT_RUN}).`)
      }
      process.exitCode = exitCode
    },
    { label: LABEL },
  )
}

try {
  await main()
} catch (error) {
  if (error instanceof MutationLockHeld) {
    console.error(`${LABEL}: ${error.message}`)
    process.exit(EXIT_LOCK_HELD)
  }
  throw error
}
