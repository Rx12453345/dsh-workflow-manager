/**
 * Throwaway mutation harness for the review fence (`lib/review-sandbox.js`).
 *
 * WHY THIS EXISTS: the fence is the plugin's only mechanism for "a review that damaged the
 * project cannot pass", and until 2026-11-01 **no harness covered it at all** — the four
 * existing harnesses exercise other modules, so a regression could survive with every green
 * summary intact. A security-surface guard with no mutant behind it is a claim, not a check.
 *
 * For each mutant: apply a literal source edit, run `test/review-isolation.test.mjs`, record
 * whether it went RED, restore the file byte-for-byte, then verify the restore by comparing
 * Buffers. A survivor, an unmatched anchor, or a non-green post-restore suite exits non-zero.
 *
 * Usage: node tooling/mutation-check-isolation.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { runCaptured } from './child-output.mjs'
import { EXIT_LOCK_HELD, MutationLockHeld, withMutationLock } from './mutation-lock.mjs'

/** Repo-relative, so the harness works from any clone. */
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Every harness takes this lock, so no two of them can rewrite lib/ at the same time. */
const LABEL = 'tooling/mutation-check-isolation.mjs'

const MUTANTS = [
  {
    id: 'I1',
    what: 'a file with no content digest whose timestamp moved is dropped from the clean predicate (it may have changed, and passes)',
    file: 'lib/review-sandbox.js',
    find: `    touched.length === 0 &&
`,
    replace: '',
    expect: /certify|possibly changed|clean/i,
  },
  {
    id: 'I6',
    what: 'a file with no content digest and an unchanged size/timestamp is dropped from the clean predicate (nothing was compared, and it passes)',
    file: 'lib/review-sandbox.js',
    find: `    unverified.length === 0 &&
`,
    replace: '',
    expect: /unverifiable|certify|clean/i,
  },
  {
    id: 'I2',
    what: 'git bookkeeping is compared by CONTENT again, so `git status` (the reviewer is told to run it) contaminates its own review',
    file: 'lib/review-sandbox.js',
    find: `    if (gitBookkeeping(relKey)) continue`,
    replace: `    if (false) continue`,
    expect: /contaminate|index|bookkeeping/i,
  },
  {
    id: 'I3',
    what: 'the restore stops checking its parent directories, so a junction receives the restored bytes',
    file: 'lib/review-sandbox.js',
    find: `      const problem = parentLinkProblem(projectRoot, projectReal, relKey, verifiedDirs)`,
    replace: `      const problem = null`,
    expect: /link|junction|restore/i,
  },
  {
    id: 'I4',
    what: 'a project root swapped for a junction is no longer detected before the restore',
    file: 'lib/review-sandbox.js',
    find: `    if (projectReal === null || !samePath(projectReal, projectRoot)) {`,
    replace: `    if (false) {`,
    expect: /root swap|rootSwapped|swapped/i,
  },
  {
    id: 'I5',
    what: 'the restore writes the snapshot copy back without re-checking its digest',
    file: 'lib/review-sandbox.js',
    find: `      if (typeof before.hash === 'string' && hashFile(copy) !== before.hash) {`,
    replace: `      if (false) {`,
    expect: /digest|snapshot copy/i,
  },
]

function run() {
  // FILE-BACKED CAPTURE: the sandbox denies a piped child (EPERM); see tooling/child-output.mjs.
  const result = runCaptured(
    process.execPath,
    ['--test', '--test-isolation=none', 'test/review-isolation.test.mjs'],
    { cwd: ROOT },
  )
  return { status: result.status, output: `${result.stdout}${result.stderr}` }
}

/**
 * The text of the mutant currently applied and its path. The signal handlers below read it, so
 * a Ctrl-C in the middle of a mutant restores that file before the process dies — otherwise the
 * mutant stays on disk. Registered BEFORE the lock, so it runs before the lock's backstop
 * handler (Node runs handlers in registration order) and the source is restored before release.
 */
let appliedMutant = null
let currentFile = null
const restoreInterrupted = () => {
  if (appliedMutant !== null && currentFile !== null) writeFileSync(currentFile, appliedMutant, 'utf8')
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
 * Everything that touches lib/ happens under the lock: the baseline, every mutant, every
 * restore, and the post-restore verification. Nothing is read before the lock is held, so a
 * concurrently running harness cannot have its mutant recorded here as "the original".
 */
async function main() {
  return withMutationLock(
    async () => {
      console.log(`${LABEL}: mutation lock acquired`)
      const baseline = run()
      console.log(`baseline isolation suite: exit ${baseline.status}`)
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
        // ANCHORS ARE LF IN THE SOURCE AND MAY BE CRLF IN A WINDOWS CHECKOUT: matching raw
        // bytes skipped 29 mutants in a clean CRLF copy once, and the run still exited 0.
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
            console.log(`OK ${mutant.id} caught (isolation exit ${result.status}): ${mutant.what}`)
          } else if (red) {
            caught += 1
            console.log(`OK ${mutant.id} caught by a different assertion: ${mutant.what}`)
          } else {
            missed.push(mutant.id)
            console.log(`!! ${mutant.id} SURVIVED (isolation exit 0): ${mutant.what}`)
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

      // Restore-and-verify: the suite must be green again after every mutation was reverted.
      const after = run()
      console.log(`post-restore isolation: exit ${after.status}`)
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
