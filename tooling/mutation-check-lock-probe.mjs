/**
 * Mutation check for `tooling/mutation-lock.mjs` + `test/mutation-lock.test.mjs`.
 *
 * A TEMPORARY probe, run once and deleted: it is not part of the shipped tooling and adds no
 * wiring. It exists because the lock's own regression tests must be shown to FAIL when the
 * defect is reintroduced — a test that cannot go red proves nothing.
 *
 * HOW IT STAYS SAFE: the mutant is never written into the working tree. Each mutant source is
 * written into a full COPY of the project under %TEMP%, and `node --test` runs THERE, so the
 * canonical `tooling/mutation-lock.mjs` is untouched by construction. (One mutant per run, and
 * the copy is removed afterwards.)
 *
 * Usage: node tooling/mutation-check-lock-probe.mjs
 */

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SOURCE = join(ROOT, 'tooling', 'mutation-lock.mjs')
const original = readFileSync(SOURCE, 'utf8')

/**
 * Each mutant is one literal replacement in the real source. `from` MUST be present exactly once,
 * so a mutant can never silently become a no-op when the source moves.
 */
const MUTANTS = [
  {
    id: 'L1',
    description: 'the defect itself: an unreadable `at` is read as epoch 0 (`: 0` reinstated)',
    from: 'const atMs = readLockTimestamp(holder)',
    to: "const atMs = (typeof holder.at === 'number' ? holder.at : 0)",
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
    from: 'const atMs = readLockTimestamp(holder)',
    to: 'const atMs = holder.at',
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

/** Run the lock suite in a throwaway copy of the project with `mutant` applied. */
function runMutant(mutant) {
  if (!original.includes(mutant.from)) {
    return { id: mutant.id, applied: false, status: null, output: 'from-text not found in the source' }
  }
  const dir = mkdtempSync(join(tmpdir(), `p5-lock-mutant-${mutant.id}-`))
  try {
    cpSync(join(ROOT, 'test'), join(dir, 'test'), { recursive: true })
    cpSync(join(ROOT, 'tooling'), join(dir, 'tooling'), { recursive: true })
    writeFileSync(join(dir, 'tooling', 'mutation-lock.mjs'), original.replace(mutant.from, mutant.to), 'utf8')
    const result = spawnSync(process.execPath, ['--test', '--test-isolation=none', join(dir, 'test', 'mutation-lock.test.mjs')], {
      cwd: dir,
      encoding: 'utf8',
    })
    return { id: mutant.id, applied: true, status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

console.log(`source: ${SOURCE}`)
console.log(`source untouched by design: each mutant runs in a %TEMP% copy.\n`)

const rows = []
for (const mutant of MUTANTS) {
  const ran = runMutant(mutant)
  const failed = (ran.output.match(/^✖/gm) ?? []).length
  const red = ran.status !== 0
  rows.push({ ...mutant, ...ran, failed, red })
  console.log(`${mutant.id} ${red ? 'RED  ' : 'GREEN'} exit=${ran.status} failing-lines=${failed} — ${mutant.description}`)
}

console.log('\n| mutant | change | test result | verdict |')
console.log('|---|---|---|---|')
for (const row of rows) {
  const verdict = !row.applied ? 'NOT APPLIED (bad mutant)' : row.red ? 'RED — caught' : row.expected === 'GREEN' ? 'GREEN — as declared' : 'MISSED'
  console.log(`| ${row.id} | ${row.description} | exit ${row.status}, ${row.failed} failing assertions | ${verdict} |`)
}

const bad = rows.filter(row => !row.applied || (row.red !== (row.expected === 'RED')))
console.log(`\nmutants: ${rows.length}; unexpected: ${bad.length}${bad.length ? ` -> ${bad.map(row => row.id).join(', ')}` : ''}`)
console.log(`source restored byte-for-byte: ${readFileSync(SOURCE, 'utf8') === original ? 'YES' : 'NO'}`)
process.exit(bad.length === 0 ? 0 : 1)
