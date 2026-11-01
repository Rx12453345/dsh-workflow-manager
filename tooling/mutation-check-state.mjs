/**
 * Throwaway mutation harness for the RECORDED STATE: what a review leaves behind and how a later
 * session reads it.
 *
 * WHY THIS EXISTS: the 0.4.0 change added four rules that `test/advance.test.mjs` and
 * `test/review.test.mjs` now defend — the bounded findings summary, the per-file digest evidence,
 * the truncated-map guard on the stale judgement, and the next-action sentence that must not merge
 * the unclassified bucket into "code changed". `tooling/mutation-check-handoff.mjs` covers the brief
 * contract but runs only `test/handoff.test.mjs`, so it caught none of them (measured: H9, H10, H11
 * and H13 all survived there). A test without a mutant behind it is a claim, not a check, and the
 * first version of this change shipped exactly that way — the reader existed and no writer called
 * it, and every suite was green.
 *
 * For each mutant: apply a literal source edit, run the covering suites, record whether they went
 * RED, restore the file byte-for-byte, then verify the restore by comparing Buffers. A survivor, an
 * unmatched anchor, or a non-green post-restore suite exits non-zero. Anchors are matched against
 * LF-normalised text, because a Windows checkout may hold CRLF and matching raw bytes silently
 * skipped every mutant once (the isolation harness learned that the hard way).
 *
 * Usage: node tooling/mutation-check-state.mjs
 * Exit: 0 all caught, 1 survivor / anchor mismatch / red after restore, 2 baseline not green,
 *   3 the shared lock is held by another harness.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runCaptured } from './child-output.mjs'
import { EXIT_LOCK_HELD, MutationLockHeld, withMutationLock } from './mutation-lock.mjs'

/** Repo-relative, so the harness works from any clone. */
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Every harness takes this lock, so no two of them can rewrite lib/ at the same time. */
const LABEL = 'tooling/mutation-check-state.mjs'

/**
 * The targeted regression files. BOTH are needed: the state work is asserted end to end through
 * the advance tool and in the bounded-findings unit tests.
 */
const TEST_FILES = ['test/advance.test.mjs', 'test/review.test.mjs']

const MUTANTS = [
  {
    id: 'S1',
    what: 'a truncated per-file digest map may claim "documents only", so a possibly-hidden code change is skipped',
    file: 'lib/advance.js',
    find: "      if (!truncated || kind === 'code') {\n",
    replace: '      if (true) {\n',
    expect: /truncated|documents only|unknown/,
  },
  {
    id: 'S2',
    what: 'record-review stops persisting the per-file digests, so every mixed set falls back to "unknown"',
    file: 'lib/tools.js',
    find: '        const fileDigests = reviewedFileDigests(projectDir, files)\n',
    replace: '        const fileDigests = { digests: {}, total: files.length, truncated: false }\n',
    expect: /per-file digest is persisted|file_digests/,
  },
  {
    id: 'S3',
    what: "the reviewer's findings are not copied into the evidence row, so a later session is blind to them again",
    file: 'lib/tools.js',
    find: '              ...(Array.isArray(last.issues) ? { issues: last.issues } : {}),\n',
    replace: '',
    expect: /findings are persisted|issues/,
  },
  {
    id: 'S4',
    what: 'the next-action sentence merges the unclassified bucket into "code changed"',
    file: 'lib/tools.js',
    find: '        if (unknownIds.length > 0) {\n',
    replace: '        if (false) {\n',
    expect: /could not be told apart|unclassified/,
  },
  {
    id: 'S5',
    what: 'the bounded findings cap is raised out of its promise, so an evidence row grows with the report',
    file: 'lib/review.js',
    find: 'export const MAX_PERSISTED_ISSUES = 10\n',
    replace: 'export const MAX_PERSISTED_ISSUES = 99\n',
    expect: /10|issuesTotal|bounded/,
  },
  {
    id: 'S6',
    what: 'the COMMIT/HANDOFF gate judges staleness WITHOUT the project classification, so its refusal disagrees with status',
    file: 'lib/tools.js',
    find: '        const all = reviewFreshnessAll(projectDir, workUnit, features, briefContext)\n',
    replace: '        const all = reviewFreshnessAll(projectDir, workUnit, features)\n',
    expect: /COMMIT refusal must judge|disagree/,
  },
]

function run() {
  // FILE-BACKED CAPTURE: the sandbox denies a piped child (EPERM); see tooling/child-output.mjs.
  const result = runCaptured(process.execPath, ['--test', '--test-isolation=none', ...TEST_FILES], {
    cwd: ROOT,
  })
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

/**
 * The text of the mutant currently applied and its path. The signal handlers below read it, so a
 * Ctrl-C in the middle of a mutant restores that file before the process dies — otherwise the
 * mutant stays on disk. Registered BEFORE the lock, so it runs before the lock's backstop handler
 * (Node runs handlers in registration order) and the source is restored before release.
 */
let appliedMutant = null
let currentFile = null
const restoreInterrupted = () => {
  if (appliedMutant !== null && currentFile !== null) writeFileSync(currentFile, appliedMutant)
}
process.once('SIGINT', () => {
  restoreInterrupted()
  process.exit(130)
})
process.once('SIGTERM', () => {
  restoreInterrupted()
  process.exit(143)
})

/**
 * Everything that touches lib/ happens under the lock: the baseline, every mutant, every restore,
 * and the post-restore verification. Nothing is read before the lock is held, so a concurrently
 * running harness cannot have its mutant recorded here as "the original".
 */
async function main() {
  return withMutationLock(
    async () => {
      console.log(`${LABEL}: mutation lock acquired`)
      const baseline = run()
      console.log(`baseline state suites: exit ${baseline.status}`)
      if (baseline.status !== 0) {
        console.error('baseline is not green; refusing to mutate')
        return { baselineOk: false }
      }

      let caught = 0
      const missed = []
      for (const mutant of MUTANTS) {
        const path = `${ROOT}/${mutant.file}`
        const originalBuffer = readFileSync(path)
        const original = originalBuffer.toString('utf8')
        const normalised = original.replace(/\r\n/g, '\n')
        if (!normalised.includes(mutant.find)) {
          console.log(`?? ${mutant.id}: the anchor did not match — mutant not applied (${mutant.what})`)
          missed.push(`${mutant.id} (anchor mismatch)`)
          continue
        }
        const mutated = normalised.replace(mutant.find, mutant.replace)
        if (mutated === normalised) {
          console.log(`?? ${mutant.id}: the replacement changed nothing`)
          missed.push(`${mutant.id} (no-op)`)
          continue
        }
        try {
          writeFileSync(path, mutated, 'utf8')
          appliedMutant = originalBuffer
          currentFile = path
          const result = run()
          const red = result.status !== 0
          const namesFailingTest = mutant.expect.test(result.output)
          if (red && namesFailingTest) {
            caught += 1
            console.log(`OK ${mutant.id} caught (state exit ${result.status}): ${mutant.what}`)
          } else if (red) {
            caught += 1
            console.log(`OK ${mutant.id} caught by a different assertion: ${mutant.what}`)
          } else {
            missed.push(mutant.id)
            console.log(`!! ${mutant.id} SURVIVED (state exit 0): ${mutant.what}`)
          }
        } finally {
          writeFileSync(path, originalBuffer)
          appliedMutant = null
          currentFile = null
          if (!readFileSync(path).equals(originalBuffer)) {
            throw new Error(`${mutant.file} was not restored byte-for-byte after ${mutant.id}`)
          }
        }
      }

      console.log(`\n${caught}/${MUTANTS.length} mutants caught`)
      if (missed.length) console.log(`survivors: ${missed.join(', ')}`)
      console.log('sources restored byte-for-byte: YES')

      // Restore-and-verify: the suites must be green again after every mutation was reverted.
      const after = run()
      console.log(`post-restore state: exit ${after.status}`)
      // A HARNESS THAT CANNOT FAIL IS NOT A CHECK: an unmatched anchor or a surviving mutant
      // makes the run a failure even when the post-restore suite is green.
      return { baselineOk: true, green: after.status === 0 && missed.length === 0 && caught === MUTANTS.length }
    },
    { label: LABEL },
  )
}

try {
  const result = await main()
  process.exit(result.baselineOk === false ? 2 : result.green ? 0 : 1)
} catch (error) {
  if (error instanceof MutationLockHeld) {
    console.error(`${LABEL}: ${error.message}`)
    process.exit(EXIT_LOCK_HELD)
  }
  throw error
}
