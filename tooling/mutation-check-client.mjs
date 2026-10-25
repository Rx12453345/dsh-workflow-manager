/**
 * B5.2 mutation harness (temporary, lives OUTSIDE the plugin package).
 *
 * For each mutant: apply a literal edit to lib/client.js, run the panel's own test file,
 * record whether it went RED, then restore the file byte-for-byte and verify the hash.
 *
 * Usage: node tooling/mutation-check-client.mjs [M1 M4 ...]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { EXIT_LOCK_HELD, MutationLockHeld, withMutationLock } from './mutation-lock.mjs'

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

      function failingTests(output) {
        const names = new Set()
        for (const match of output.matchAll(/^✖ (.+?)(?: \(\d+(?:\.\d+)?ms\))?$/gm)) {
          const name = match[1].trim()
          if (name !== 'failing tests:') names.add(name)
        }
        return [...names]
      }

      // A CRLF checkout must not turn a valid anchor into a skipped mutant.
      const normalised = original.replace(/\r\n/g, '\n')
      const rows = []
      for (const mutant of MUTANTS) {
        if (only.size > 0 && !only.has(mutant.id)) continue
        const occurrences = normalised.split(mutant.find).length - 1
        if (occurrences !== 1) {
          rows.push({ ...mutant, applied: false, problem: `literal occurs ${occurrences}x` })
          continue
        }
        const mutated = normalised.replace(mutant.find, mutant.replace)
        let output = ''
        let status = null
        try {
          writeFileSync(FILE, mutated, 'utf8')
          const run = spawnSync(
            process.execPath,
            ['--test', '--test-isolation=none', 'test/status.test.mjs'],
            { cwd: ROOT, encoding: 'utf8' },
          )
          output = `${run.stdout ?? ''}${run.stderr ?? ''}`
          status = run.status
        } finally {
          restore()
        }
        const failed = failingTests(output)
        const missed = mutant.must.filter(name => !failed.includes(name))
        rows.push({ ...mutant, applied: true, red: status !== 0, failed, missed, caught: failed.length > 0 && missed.length === 0 })
      }

      restore()
      const after = sha(readFileSync(FILE, 'utf8'))
      console.log('=== B5.2 MUTATION RESULTS ===')
      for (const row of rows) {
        if (!row.applied) {
          console.log(`${row.id.padEnd(4)} APPLY-FAILED  ${row.problem}`)
          continue
        }
        const mark = row.caught ? 'CAUGHT ' : row.red ? 'PARTIAL' : 'MISSED '
        console.log(`${row.id.padEnd(4)} ${mark} red=${row.red ? 'yes' : 'no '} count=${row.failed.length}`)
        console.log(`     what: ${row.what}`)
        if (row.missed.length) console.log(`     NOT failing: ${row.missed.join(' ; ')}`)
        if (row.failed.length) console.log(`     failing: ${row.failed.slice(0, 4).join(' ; ')}${row.failed.length > 4 ? ` (+${row.failed.length - 4})` : ''}`)
      }
      console.log(`\nsource restored byte-for-byte: ${before === after ? 'YES' : 'NO — INVESTIGATE'}`)
      // AN APPLY-FAILED MUTANT IS NOT A PASS. This harness used to print the rows and exit 0,
      // so a CRLF checkout silently skipped 3 of 13 mutants while looking green.
      const applyFailed = rows.filter(row => !row.applied).length
      const notCaught = rows.filter(row => row.applied && !row.caught).length
      if (before !== after) process.exitCode = 3
      else if (applyFailed > 0) process.exitCode = 2
      else if (notCaught > 0) process.exitCode = 1
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
