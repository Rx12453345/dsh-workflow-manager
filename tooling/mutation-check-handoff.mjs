/**
 * Throwaway mutation harness for the handoff brief (`lib/handoff.js` and the two modules that
 * gate and summarise it).
 *
 * WHY THIS EXISTS: `test/handoff.test.mjs` claims to defend the brief, but until the p3-7 review
 * recorded it, **no harness targeted `lib/handoff.js` at all** — the other harnesses exercise
 * other modules, so a regression in the brief, its target or its status summary could survive
 * with every green summary intact. A test without a mutant behind it is a claim, not a check.
 *
 * For each mutant: apply a literal source edit, run `test/handoff.test.mjs`, record whether it
 * went RED, restore the file byte-for-byte, then verify the restore by comparing Buffers. A
 * survivor, an unmatched anchor, or a non-green post-restore suite exits non-zero. Anchors are
 * matched against LF-normalised text, because a Windows checkout may hold CRLF and matching raw
 * bytes silently skipped every mutant once (the isolation harness learned that the hard way).
 *
 * ONE MUTANT PER RULE THE FEATURE CLAIMS: the module switch, the root-brief refusal, replace-not-
 * append, the stale count, the OPEN blocker line, the work-unit path, and both `oneLine`
 * flattenings. The work-unit mutant is the p3-7 debt's own rule (two units must not share a file).
 *
 * Usage: node tooling/mutation-check-handoff.mjs
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
const LABEL = 'tooling/mutation-check-handoff.mjs'

/** The targeted regression file: the whole brief contract lives here. */
const TEST_FILE = 'test/handoff.test.mjs'

const MUTANTS = [
  {
    id: 'H1',
    what: '`modules.handoffDoc: false` no longer suppresses the write (the switch is a knob that lies again)',
    file: 'lib/advance.js',
    find: '    modules.handoffDoc === false\n',
    replace: "    modules.handoffDoc === 'never'\n",
    expect: /disabled|off switch|handoffDoc/,
  },
  {
    id: 'H2',
    what: 'the brief target is derived from the repository-root HANDOFF.md instead of the scope path (the writer must never accept the root brief)',
    file: 'lib/handoff.js',
    find: '  const path = resolve(root, relativePath)\n',
    replace: '  const path = resolve(root, HANDOFF_DOC_FILENAME)\n',
    expect: /handoff brief is always|HANDOFF\.md/,
  },
  {
    id: 'H3',
    what: 'the writer appends to the brief instead of replacing it, so regeneration is not idempotent',
    file: 'lib/handoff.js',
    find: "    writeFileSync(temporary, markdown, 'utf8')\n    renameSync(temporary, target.path)\n",
    replace: "    writeFileSync(target.path, markdown, { encoding: 'utf8', flag: 'a' })\n",
    expect: /byte-identical|same state|append/,
  },
  {
    id: 'H4',
    what: 'the status summary drops the stale count, so a stale PASS is invisible in the report',
    file: 'lib/tools.js',
    find: '    `  handoff counts: ${done}/${total} complete, ${open} open; ${stale} stale reviewed feature(s)`,\n',
    replace: '    `  handoff counts: ${done}/${total} complete, ${open} open`,\n',
    expect: /stale reviewed feature/,
  },
  {
    id: 'H5',
    what: 'the brief drops the OPEN blocker line and always claims the feature-count gate is satisfied',
    file: 'lib/handoff.js',
    find: "  if (openFeatures.length === 0) {\n    out.push('- No open feature: the HANDOFF feature-count gate is satisfied.')\n",
    replace: "  if (true) {\n    out.push('- No open feature: the HANDOFF feature-count gate is satisfied.')\n",
    expect: /OPEN \(|open blocker|open feature/,
  },
  {
    id: 'H6',
    what: 'a work unit resolves to the project-level brief path again, so two units overwrite one file',
    file: 'lib/handoff.js',
    find: '    relativePath: join(WORK_UNIT_DIR_RELATIVE_PATH, checked.id, HANDOFF_DOC_FILENAME),\n',
    replace: '    relativePath: HANDOFF_DOC_RELATIVE_PATH,\n',
    expect: /separate briefs|work unit|\\.dsh[\\\\/]work/,
  },
  {
    id: 'H7',
    what: 'the phase is interpolated unflattened, so a newline in WORKFLOW.json forges a brief line',
    file: 'lib/handoff.js',
    find: "    `- phase: ${phase === null ? '(not recorded)' : text(phase, 40)}` +\n",
    replace: "    `- phase: ${phase === null ? '(not recorded)' : phase}` +\n",
    expect: /forge|stay inline|metadata/,
  },
  {
    id: 'H8',
    what: 'waiver openFeatures ids are joined unflattened, so a newline in one forges a brief line',
    file: 'lib/handoff.js',
    find: "          .map(value => text(value, 200) || '(no id)')\n",
    replace: "          .map(value => value || '(no id)')\n",
    expect: /forge|waiver line/,
  },
]

function run() {
  // FILE-BACKED CAPTURE: the sandbox denies a piped child (EPERM); see tooling/child-output.mjs.
  const result = runCaptured(process.execPath, ['--test', '--test-isolation=none', TEST_FILE], {
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
 * Everything that touches lib/ happens under the lock: the baseline, every mutant, every
 * restore, and the post-restore verification. Nothing is read before the lock is held, so a
 * concurrently running harness cannot have its mutant recorded here as "the original".
 */
async function main() {
  return withMutationLock(
    async () => {
      console.log(`${LABEL}: mutation lock acquired`)
      const baseline = run()
      console.log(`baseline handoff suite: exit ${baseline.status}`)
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
            console.log(`OK ${mutant.id} caught (handoff exit ${result.status}): ${mutant.what}`)
          } else if (red) {
            caught += 1
            console.log(`OK ${mutant.id} caught by a different assertion: ${mutant.what}`)
          } else {
            missed.push(mutant.id)
            console.log(`!! ${mutant.id} SURVIVED (handoff exit 0): ${mutant.what}`)
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
      console.log(`post-restore handoff: exit ${after.status}`)
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
