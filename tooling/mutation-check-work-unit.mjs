/**
 * Mutation check for the per-work-unit state feature.
 *
 * WHAT THIS IS FOR
 * "Every behaviour gets a regression test that can go RED" is a claim, and a test that
 * cannot fail is not a test. This harness INJECTS each defect the feature is supposed to
 * prevent, runs the regression file, and reports whether the suite went red. A mutant that
 * survives is a hole in the tests, and the table below is the evidence.
 *
 * It patches a file in place, runs `node --test`, and restores the original text in a
 * `finally`, so an interrupted run does not leave a mutated source tree behind.
 *
 * Usage: node tooling/mutation-check-work-unit.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { EXIT_LOCK_HELD, MutationLockHeld, withMutationLock } from './mutation-lock.mjs'

const TEST_FILE = 'test/work-unit.test.mjs'

/** Every harness takes this lock, so no two of them can rewrite lib/ at the same time. */
const LABEL = 'tooling/mutation-check-work-unit.mjs'

/**
 * Each mutant names ONE defect, the exact text that carries it, and the replacement that
 * puts the defect back. `from` must occur exactly once, so a refactor cannot silently make
 * a mutant a no-op.
 */
const MUTANTS = [
  {
    id: 'M01',
    file: 'lib/work-unit.js',
    defect: 'the default path is relocated into .dsh/work, changing the layout for existing projects',
    from: "export const DEFAULT_WORKFLOW_STATE_RELATIVE_PATH = join('.dsh', 'WORKFLOW.json')",
    to: "export const DEFAULT_WORKFLOW_STATE_RELATIVE_PATH = join('.dsh', 'work', 'default', 'WORKFLOW.json')",
  },
  {
    id: 'M02',
    file: 'lib/work-unit.js',
    defect: 'the work-unit id character set is opened up (separators, colons, NUL, unicode)',
    from: 'export const WORK_UNIT_ID_PATTERN = /^[A-Za-z0-9._-]+$/',
    to: 'export const WORK_UNIT_ID_PATTERN = /^[\\s\\S]*$/',
  },
  {
    id: 'M03',
    file: 'lib/work-unit.js',
    defect: 'path containment becomes a PREFIX comparison, so /a/bc counts as inside /a/b',
    from: "  if (relation === '') return false // the root itself is not inside the root\n  if (isAbsolute(relation)) return false // different Windows drive, or otherwise unrelated\n  if (relation === '..') return false\n  return !relation.startsWith(`..${sep}`)",
    to: '  return resolve(candidate).startsWith(resolve(base))',
  },
  {
    id: 'M04',
    file: 'lib/work-unit.js',
    defect: 'the post-join containment check is disabled entirely',
    from: "  if (relation === '') return false // the root itself is not inside the root\n  if (isAbsolute(relation)) return false // different Windows drive, or otherwise unrelated\n  if (relation === '..') return false\n  return !relation.startsWith(`..${sep}`)",
    to: '  return true',
  },
  {
    id: 'M05',
    file: 'lib/work-unit.js',
    defect: 'the leading-dot rule is removed, so "../x" and hidden names are accepted',
    from: '  if (value.startsWith(\'.\')) {',
    to: '  if (false) {',
  },
  {
    id: 'M06',
    file: 'lib/work-unit.js',
    defect: 'the id length cap is removed',
    from: '  if (value.length > WORK_UNIT_ID_MAX_LENGTH) {',
    to: '  if (false) {',
  },
  {
    id: 'M07',
    file: 'lib/work-unit.js',
    defect: 'the review-store key drops the work unit, so a verdict leaks across units',
    from: `  return JSON.stringify([
    typeof projectDir === 'string' ? projectDir : null,
    workUnit === undefined || workUnit === null ? null : String(workUnit),
  ])`,
    to: '  return JSON.stringify([typeof projectDir === "string" ? projectDir : null, null])',
  },
  {
    id: 'M08',
    file: 'lib/advance.js',
    defect: 'the fingerprint stops folding in the work unit, so approvals are not unit-bound',
    from: "  if (scope !== undefined && scope !== null && String(scope) !== '') {",
    to: '  if (false) {',
  },
  {
    id: 'M09',
    file: 'lib/tools.js',
    defect: 'the cross-unit record guard is removed',
    from: '        if ((last.workUnit ?? null) !== (workUnit ?? null)) {',
    to: '        if (false) {',
  },
  {
    id: 'M10',
    file: 'lib/tools.js',
    defect: 'workflow_advance silently ignores work_unit and drives the project state',
    from: '      const unit = resolveWorkUnitArgument(projectDir, args?.work_unit)',
    to: '      const unit = { ok: true, workUnit: null }',
  },
  {
    id: 'M11',
    file: 'lib/advance.js',
    defect: 'readState ignores the work unit and always reads the project file',
    from: `export function readState(projectDir, workUnit) {
  const target = workUnitStatePaths(projectDir, workUnit)`,
    to: `export function readState(projectDir, workUnit) {
  const target = workUnitStatePaths(projectDir, undefined)`,
  },
  {
    id: 'M12',
    file: 'lib/tools.js',
    defect: 'workflow_status never lists the work units that exist',
    from: '  const workUnits = listWorkUnits(project.projectDir ?? workspace.dir)',
    to: '  const workUnits = { base: null, units: [], ignored: [] }',
  },
  {
    id: 'M13',
    file: 'lib/tools.js',
    defect: 'the status renderer assumes workUnits.units is an array',
    from: '  const workUnitList = Array.isArray(workUnitInfo.units) ? workUnitInfo.units : []',
    to: '  const workUnitList = workUnitInfo.units ?? []',
  },
  {
    id: 'M14',
    file: 'lib/tools.js',
    defect: 'work_unit is dropped from the workflow_advance schema, so the host can discard it',
    from: `        work_unit: {
          type: 'string',
          description:
            'Optional per-work-unit label. Each unit keeps its own .dsh/work/<id>/WORKFLOW.json and '`,
    to: `        __work_unit_removed: {
          type: 'string',
          description:
            'Optional per-work-unit label. Each unit keeps its own .dsh/work/<id>/WORKFLOW.json and '`,
  },
  {
    id: 'M15',
    file: 'lib/tools.js',
    defect: 'workflow_review records the fingerprint WITHOUT the work-unit scope',
    from: "          ? fingerprint(reviewDir, reviewedFiles, reviewedDiff, workUnit ?? '')",
    to: "          ? fingerprint(reviewDir, reviewedFiles, reviewedDiff, '')",
  },
  {
    id: 'M16',
    file: 'lib/shared.js',
    defect: 'the shared oneLine() stops flattening line terminators, so any field can forge a line',
    from: "  return String(value).replace(/[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+/g, ' ')",
    to: '  return String(value)',
  },
  {
    id: 'M17',
    file: 'lib/tools.js',
    defect: 'renderAdvance prints a REFUSED work_unit unflattened, so a newline forges a line',
    from: '    out.push(`work unit: ${oneLine(value.workUnit)}`)',
    to: '    out.push(`work unit: ${value.workUnit}`)',
  },
  {
    id: 'M18',
    file: 'lib/gc.js',
    defect: 'renderGc prints the work_unit unflattened, so a newline forges a line',
    from: '    out.push(`work unit: ${oneLine(value.workUnit)}`)',
    to: '    out.push(`work unit: ${value.workUnit}`)',
  },
  {
    id: 'M19',
    file: 'lib/work-unit.js',
    defect: 'the case-insensitive collision check is removed, so "B4" and "b4" share a directory',
    from: '  if (CASE_INSENSITIVE_FILESYSTEMS.includes(process.platform)) {',
    to: '  if (false) {',
  },
  {
    id: 'M20',
    file: 'lib/work-unit.js',
    defect: 'containment matches a bare ".." prefix instead of whole path segments',
    from: "  if (relation === '..') return false\n  return !relation.startsWith(`..${sep}`)",
    to: "  return !relation.startsWith('..')",
  },
  {
    id: 'M21',
    file: 'lib/tools.js',
    defect: 'renderAdvance prints a hand-editable `phase` unflattened, so it can forge a line',
    from: 'phase: ${oneLine(value.phase)}',
    to: 'phase: ${value.phase}',
  },
  {
    id: 'M22',
    file: 'lib/gc.js',
    defect: 'renderConstraint prints a constraint `rule` unflattened, so it can forge a line',
    from: 'oneLine(item.rule)}',
    to: 'asText(item.rule)}',
  },
  {
    id: 'M23',
    file: 'lib/shared.js',
    defect: 'oneLine stops collapsing the Unicode line separators U+0085/U+2028/U+2029',
    from: '/[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]+/g',
    to: '/[\\u0000-\\u001f\\u007f]+/g',
  },
]

function runTests() {
  const result = spawnSync(
    process.execPath,
    // TAP so a failing run names the tests that caught the mutant; without it the default
    // reporter prints specs and the harness can only report "something failed".
    ['--test', '--test-reporter=tap', '--test-isolation=none', TEST_FILE],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  if (result.error) {
    return { ok: false, error: result.error, output: '' }
  }
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const failing = output
    .split(/\r?\n/)
    .filter(line => /^\s*not ok /.test(line))
    .map(line => line.replace(/^\s*not ok\s+\d+\s+-\s+/, '').trim())
  return { ok: result.status === 0, status: result.status, output, failing }
}

const sha = text => createHash('sha256').update(text).digest('hex').slice(0, 12)

/**
 * The signal handlers are registered BEFORE the lock is taken (so they run before the lock's
 * own backstop handler: Node runs handlers in registration order). The snapshot stays empty
 * until the lock is held, so a Ctrl-C during acquisition cannot write `undefined` over a source.
 */
async function main() {
  // Snapshot every source this harness touches BEFORE the first mutant, so the final check
  // compares against a state no mutant could have contaminated. (This harness rewrites four
  // different files, so a per-mutant snapshot on its own would let one mutant's leftover text
  // become the next one's "original".)
  const files = [...new Set(MUTANTS.map(mutant => mutant.file))].sort()
  const originals = new Map()
  const hashes = new Map()
  const restoreAll = () => {
    for (const [file, text] of originals) writeFileSync(file, text, 'utf8')
  }
  process.once('SIGINT', () => {
    restoreAll()
    process.exit(130)
  })
  process.once('SIGTERM', () => {
    restoreAll()
    process.exit(143)
  })

  await withMutationLock(
    async () => {
      console.log(`${LABEL}: mutation lock acquired`)
      for (const file of files) {
        const text = readFileSync(file, 'utf8')
        originals.set(file, text)
        hashes.set(file, sha(text))
      }

      const rows = []
      let harnessError = null

      for (const mutant of MUTANTS) {
        const original = originals.get(mutant.file)
        // A CRLF checkout must not turn a valid anchor into a skipped mutant.
        const normalised = original.replace(/\r\n/g, '\n')
        const occurrences = normalised.split(mutant.from).length - 1
        if (occurrences !== 1) {
          rows.push({ ...mutant, verdict: 'HARNESS ERROR', note: `anchor occurs ${occurrences} times` })
          continue
        }

        const mutated = normalised.replace(mutant.from, mutant.to)
        try {
          if (mutated === normalised) {
            rows.push({ ...mutant, verdict: 'HARNESS ERROR', note: 'the replacement changed nothing' })
            continue
          }
          writeFileSync(mutant.file, mutated, 'utf8')
          const result = runTests()
          if (result.error) {
            rows.push({ ...mutant, verdict: 'HARNESS ERROR', note: String(result.error.message ?? result.error) })
          } else if (result.ok) {
            rows.push({ ...mutant, verdict: 'SURVIVED (test hole)', note: `${result.failing.length} failing` })
          } else {
            rows.push({
              ...mutant,
              verdict: 'KILLED',
              note: `${result.failing.length} test(s) red`,
              failing: result.failing,
            })
          }
        } catch (error) {
          harnessError = error
          rows.push({ ...mutant, verdict: 'HARNESS ERROR', note: String(error?.message ?? error) })
        } finally {
          writeFileSync(mutant.file, original, 'utf8')
        }
      }

      console.log('mutation check: per-work-unit state')
      console.log(`anchors verified against ${MUTANTS.length} mutants\n`)

      let survived = 0
      for (const row of rows) {
        const killed = row.verdict === 'KILLED'
        if (!killed) survived += 1
        console.log(`${row.verdict.padEnd(22)} ${row.id}  ${row.file}`)
        console.log(`  defect: ${row.defect}`)
        console.log(`  ${row.note}`)
        for (const name of row.failing ?? []) console.log(`    RED: ${name}`)
        console.log('')
      }

      // Restore verification. This harness printed no such line before, so "the restore worked"
      // was an assumption rather than a checked fact — the same gap that let two concurrent runs
      // leave mutants applied while each one reported success.
      let restored = true
      for (const file of files) {
        const now = readFileSync(file, 'utf8')
        const intact = now === originals.get(file) && sha(now) === hashes.get(file)
        if (!intact) restored = false
        console.log(`  ${file}: ${intact ? 'intact' : `CHANGED ${hashes.get(file)} -> ${sha(now)}`}`)
      }
      console.log(`\nsources restored byte-for-byte: ${restored ? 'YES' : 'NO — INVESTIGATE'}`)

      const killedCount = rows.filter(row => row.verdict === 'KILLED').length
      console.log(`${killedCount}/${rows.length} mutants killed`)

      if (harnessError) {
        console.error(`harness error: ${harnessError.message}`)
        process.exitCode = 2
      } else if (!restored) {
        console.error('the harness did NOT restore every source byte-for-byte — the tree is dirty')
        process.exitCode = 3
      } else if (killedCount !== rows.length) {
        console.error('some mutants survived — the tests have a hole')
        process.exitCode = 1
      }
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
