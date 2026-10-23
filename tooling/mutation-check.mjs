/**
 * B4 constraint-retirement mutation harness.
 *
 * For each mutant: apply a literal source edit, run the whole unit suite, record whether the
 * test(s) NEXT-STEPS.md says must catch it went RED, then restore the file byte-for-byte.
 *
 * Usage: node D:/DSH/P5/_b4_mutate.mjs [id ...]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { EXIT_LOCK_HELD, MutationLockHeld, withMutationLock } from './mutation-lock.mjs'

// Repo-relative; see the comment in mutation-check-approval.mjs. The old P5 path made the
// baseline run in a checkout with no `test/` whenever the harness was run from a clone.
const ROOT = fileURLToPath(new URL('..', import.meta.url))
const only = new Set(process.argv.slice(2))

/** Every harness takes this lock, so no two of them can rewrite lib/ at the same time. */
const LABEL = 'tooling/mutation-check.mjs'

const C = 'lib/constraints.js'
const G = 'lib/gc.js'

// Each mutant: `find`/`replace` are literal; `must` lists test names that MUST be in the
// failing set (substring match). `extra` is a second literal edit applied to the same tree.
const MUTANTS = [
  {
    id: 'M1',
    what: 'evaluateConstraint drops the `signal === null` condition',
    file: C,
    find: `  if (signal === null && !anyUnreadable && allEvaluated && allSatisfied && item.problems.length === 0) {`,
    replace: `  if (!anyUnreadable && allEvaluated && allSatisfied && item.problems.length === 0) {`,
    must: [
      'THE CORE RULE: a free-text signal is NEVER reported as evaluated',
      'a signal plus partial machine evidence never becomes provably due',
    ],
  },
  {
    id: 'M2',
    what: 'a machine-satisfied condition with a free-text signal is reported provably-due',
    file: C,
    find: `  } else if (allSatisfied || (checks.length === 0 && signal !== null)) {`,
    replace: `  } else if (allSatisfied || (checks.length === 0 && signal !== null)) {\n    if (allSatisfied) return { ...item, status: 'active', verdict: 'provably-due', checks, signal, signalEvaluated: false, unevaluable }`,
    must: [
      'THE CORE RULE: a free-text signal is NEVER reported as evaluated',
      'a signal plus partial machine evidence never becomes provably due',
    ],
  },
  {
    id: 'M3',
    what: 'signalEvaluated is reported as true',
    file: C,
    find: `    signalEvaluated: false,`,
    replace: `    signalEvaluated: true,`,
    all: true,
    must: ['every evaluation of an active constraint keeps signalEvaluated false'],
  },
  {
    id: 'M4',
    what: 'the "no retire_when is a DEFECT" branch is deleted',
    file: C,
    find: `  if (!isPlainObject(constraint.retire_when)) {`,
    replace: `  if (false) {`,
    must: ['a constraint with no retire_when is a DEFECT, not a normal entry'],
  },
  {
    id: 'M5',
    what: 'addConstraint ignores isConfirmed(confirmation)',
    file: C,
    find: `export function addConstraint(document, candidate, options = {}) {\n  if (!isConfirmed(options.confirmation)) return { ...UNCONFIRMED }`,
    replace: `export function addConstraint(document, candidate, options = {}) {\n  if (false) return { ...UNCONFIRMED }`,
    must: [
      'the store refuses to add without a confirmation token, and changes nothing',
      'a token for the reject option cannot be replayed as approval',
    ],
  },
  {
    id: 'M6',
    what: 'addConstraint backdates from candidate.added_at (as specified in NEXT-STEPS)',
    file: C,
    find: `    added_at: now.toISOString().slice(0, 10),`,
    replace: `    added_at: candidate.added_at ?? now.toISOString().slice(0, 10),`,
    must: ['a confirmed add stamps the framework date, never a caller-supplied one'],
  },
  {
    id: 'M6b',
    what: 'M6 + the validator stops refusing an unknown added_at (removes the masking guard)',
    file: C,
    find: `    added_at: now.toISOString().slice(0, 10),`,
    replace: `    added_at: candidate.added_at ?? now.toISOString().slice(0, 10),`,
    extra: {
      find: `    if (!CANDIDATE_FIELDS.includes(key)) {`,
      replace: `    if (!CANDIDATE_FIELDS.includes(key) && key !== 'added_at' && key !== 'status') {`,
    },
    must: [
      'added_at and status cannot be supplied by a caller',
      'a confirmed add stamps the framework date, never a caller-supplied one',
    ],
  },
  {
    id: 'M7',
    what: 'retireConstraint DELETES the entry instead of marking it',
    file: C,
    find: `    document: { ...document, constraints: existing.map((entry, position) => (position === index ? retired : entry)) },`,
    replace: `    document: { ...document, constraints: existing.filter(entry => entry !== current) },`,
    must: ['retirement requires confirmation, keeps the record, and is not a delete'],
  },
  {
    id: 'M8',
    what: 'confirmationFromAnswer treats a custom answer as consent',
    file: C,
    find: `    approved: approveLabel !== undefined && selected.includes(approveLabel),`,
    replace: `    approved: approveLabel !== undefined && (selected.includes(approveLabel) || typeof item?.custom === 'string'),`,
    must: [
      'a custom answer is not consent',
      'a token is minted only from an answer naming the exact approving option',
    ],
  },
  {
    id: 'M9',
    what: 'countPhaseEntries ignores the `since` window',
    file: C,
    find: `    if (since === null || at.getTime() >= since.getTime()) count += 1`,
    replace: `    count += 1`,
    must: ['the phase counter reads only real history entries, for its phase and its window'],
  },
  {
    id: 'M10',
    what: 'readConstraints stops checking that `constraints` is an array',
    file: C,
    find: `  if (!Array.isArray(parsed.constraints)) {`,
    replace: `  if (false) {`,
    must: [
      'a ledger whose constraints field is not an array is reported and read as empty',
      'a ledger that cannot be read is never appended to',
    ],
  },
  {
    id: 'M11',
    what: 'the gc add branch ignores asked.ok (as specified in NEXT-STEPS)',
    file: G,
    find: `    if (asked.ok !== true) return { ...asked, action, projectDir }\n\n    const added = addConstraint(`,
    replace: `    if (false) return { ...asked, action, projectDir }\n\n    const added = addConstraint(`,
    must: ['a declined confirmation writes NOTHING', 'a custom answer is not consent'],
  },
  {
    id: 'M11b',
    what: 'M11 + the write mints its own approval (removes the masking guard)',
    file: G,
    find: `    if (asked.ok !== true) return { ...asked, action, projectDir }\n\n    const added = addConstraint(`,
    replace: `    if (false) return { ...asked, action, projectDir }\n\n    const added = addConstraint(`,
    extra: {
      find: `    const added = addConstraint(ledger.document, args?.constraint, {\n      confirmation: asked.confirmation,`,
      replace: `    const added = addConstraint(ledger.document, args?.constraint, {\n      confirmation: confirmationFromAnswer({ answer: { answers: [{ id: GC_QUESTION_IDS.add, selected: [GC_APPROVE_LABELS.add] }] }, questionId: GC_QUESTION_IDS.add, at: new Date(), approveLabel: GC_APPROVE_LABELS.add }),`,
    },
    must: ['a declined confirmation writes NOTHING', 'a custom answer is not consent'],
  },
  {
    id: 'M12',
    what: 'the gc retire branch never asks the user (mints its own approval instead)',
    file: G,
    find: `    const asked = await askForConfirmation({\n      service: resolveUserQuestions(options, exec),\n      exec,\n      questionId: GC_QUESTION_IDS.retire,\n      header: 'Retire a workflow constraint',\n      question: buildRetireQuestion(target),\n      approveLabel: GC_APPROVE_LABELS.retire,\n      rejectLabel: 'Keep it',\n    })\n    if (asked.ok !== true) return { ...asked, action, projectDir, constraintId: id }`,
    replace: `    const asked = {\n      ok: true,\n      confirmation: confirmationFromAnswer({\n        answer: { answers: [{ id: GC_QUESTION_IDS.retire, selected: [GC_APPROVE_LABELS.retire] }] },\n        questionId: GC_QUESTION_IDS.retire,\n        at: new Date(),\n        approveLabel: GC_APPROVE_LABELS.retire,\n      }),\n    }`,
    must: ['a declined retirement keeps the constraint active'],
  },
  {
    id: 'M13',
    what: 'a below-threshold count from a FULL window is reported as evaluated/not-met',
    file: C,
    find: `  if (counted.truncated && counted.count < observable.at_least) {`,
    replace: `  if (false) {`,
    must: ['an observable below its threshold is not due, and below a FULL window it is not "not due" either'],
  },
  {
    id: 'M14',
    what: 'readRetireCheck stops refusing unknown keys',
    file: C,
    find: `    if (!RETIRE_CHECK_FIELDS.includes(key)) {`,
    replace: `    if (false) {`,
    must: ['the writer refuses every retireCheck value the reader refuses, per key and whole-section'],
  },
  {
    id: 'M15',
    what: 'renderConstraint drops the FREE TEXT marker',
    file: G,
    find: '    out.push(`${depth}    signal (FREE TEXT — the framework did NOT evaluate this): ${asText(item.signal)}`)',
    replace: '    out.push(`${depth}    signal: ${asText(item.signal)}`)',
    must: ['scan separates provably due from due-for-human-review and claims nothing about the signal'],
  },
  {
    id: 'M16',
    what: 'the added_at usability check goes back INSIDE the review_after_days branch',
    file: C,
    find: `  if (declared > 0 && !sinceUsable) {`,
    replace: `  if (false) {`,
    extra: [
      { find: `  if (context.sinceUsable === false) {`, replace: `  if (false) {` },
      {
        find: `      checks.push(evaluateObservable(observable, { state, since, sinceUsable }))`,
        replace: `      checks.push(evaluateObservable(observable, { state, since, sinceUsable: true }))`,
      },
    ],
    must: ['an OBSERVABLE-ONLY constraint with no usable added_at is never provably due'],
  },
  {
    id: 'M17',
    what: 'countPhaseEntries stops skipping from === to self-log lines',
    file: C,
    find: `    if (entry.to !== options.phase || entry.from === entry.to) continue`,
    replace: `    if (entry.to !== options.phase) continue`,
    must: [
      'a same-phase log line is NOT a phase transition',
      'the phase counter reads only real history entries, for its phase and its window',
    ],
  },
  {
    id: 'M18',
    what: 'isConfirmed drops the Symbol brand check',
    file: C,
    find: `    isPlainObject(confirmation) &&\n    confirmation[CONFIRMATION] === true &&`,
    replace: `    isPlainObject(confirmation) &&`,
    must: ['no hand-built shape is accepted as a confirmation'],
  },
  {
    id: 'M19',
    what: 'countPhaseEntries treats an unparseable `since` as "no window"',
    file: C,
    find: `  if (windowed && since === null) return { count: 0, considered: 0, truncated, usable: false }`,
    replace: `  if (false) return { count: 0, considered: 0, truncated, usable: false }`,
    must: ['a window that cannot be read is not an open window'],
  },
  {
    id: 'M20',
    what: 'the verdict branch uses satisfiedAny instead of allSatisfied',
    file: C,
    find: `  } else if (allSatisfied || (checks.length === 0 && signal !== null)) {`,
    replace: `  } else if (checks.some(check => check.evaluated && check.satisfied === true) || (checks.length === 0 && signal !== null)) {`,
    must: ['a conjunction with one part unmet and nothing unreadable is NOT DUE, not a question'],
  },
  // --- mutants for the fix made in THIS session (strict date reading) -------------
  {
    id: 'M21',
    what: 'parseDate falls back to the LENIENT `new Date(string)` (the defect this session fixed)',
    file: C,
    find: `  if (typeof value !== 'string') return null\n  const text = value.trim()\n  if (!ISO_DATE_ONLY.test(text) && !ISO_DATE_TIME.test(text)) return null\n  if (!isRealCalendarDate(text)) return null\n  const parsed = new Date(text)`,
    replace: `  if (typeof value !== 'string') return null\n  const text = value.trim()\n  const parsed = new Date(text)`,
    must: [
      'an unreadable added_at is NOT treated as elapsed, and not as "not due" either',
      'a window that cannot be read is not an open window',
      'an OBSERVABLE-ONLY constraint with no usable added_at is never provably due',
      'a date that only the LENIENT parser would accept is not a date',
    ],
  },
  {
    id: 'M22',
    what: 'parseDate stops rejecting an impossible calendar date (2026-02-31 → 2026-03-03)',
    file: C,
    find: `  if (!isRealCalendarDate(text)) return null\n`,
    replace: ``,
    must: ['a date that only the LENIENT parser would accept is not a date'],
  },
  {
    id: 'M23',
    what: 'the present-but-unreadable signal guard is removed (round-1 review defect)',
    file: C,
    find: `  const unreadableSignal = rawSignal !== undefined && nonEmptyString(rawSignal) === null ? rawSignal : null`,
    replace: `  const unreadableSignal = null`,
    must: [
      'a signal that is present but UNREADABLE is never treated as an ABSENT signal',
      'the renderer survives the shape a hand-edited ledger can actually produce',
    ],
  },
  {
    id: 'M24',
    what: 'the scan reason loses its PROVABLY DUE branch (round-1 review defect)',
    file: G,
    find: `          : analysis.counts.provablyDue > 0`,
    replace: `          : false`,
    must: ['a scan whose only finding is provably due does not headline "No constraint is due for review"'],
  },
  {
    id: 'M25',
    what: 'the unreadable signal is derived ONLY after the early returns (round-2 review blocker)',
    file: C,
    find: `    addedForModel: nonEmptyString(constraint.added_for_model),\n    unreadableSignal,\n  }`,
    replace: `    addedForModel: nonEmptyString(constraint.added_for_model),\n  }`,
    must: ['an entry that never reached the evaluation still reports its unreadable signal'],
  },
  {
    id: 'M26',
    what: 'the retire consent prompt claims an unevaluated entry declares nothing (round-2 review)',
    file: G,
    find: `  const evaluated = verdict !== 'defective' && verdict !== 'retired'`,
    replace: `  const evaluated = true`,
    must: ['an entry that never reached the evaluation still reports its unreadable signal'],
  },
]

function sha(text) {
  return createHash('sha256').update(text).digest('hex').slice(0, 12)
}

function runSuite() {
  const result = spawnSync(process.execPath, ['run-unit-tests.mjs'], { cwd: ROOT, encoding: 'utf8' })
  if (result.error) return { error: result.error.message, output: '' }
  return { error: null, output: `${result.stdout ?? ''}${result.stderr ?? ''}`, status: result.status }
}

function failingTests(output) {
  const names = new Set()
  for (const match of output.matchAll(/^✖ (.+?)(?: \(\d+(?:\.\d+)?ms\))?$/gm)) {
    // Node prints a `✖ failing tests:` footer; it is not a test name.
    const name = match[1].trim()
    if (name !== 'failing tests:') names.add(name)
  }
  return [...names]
}

/**
 * Everything that touches lib/ happens under the lock: the snapshots, every mutant, every
 * restore, and the final byte-for-byte check. Nothing is read before the lock is held, so a
 * concurrently running harness cannot have its mutant recorded here as "the original".
 *
 * The signal handlers are registered BEFORE the lock is taken (so they run before the lock's
 * own backstop handler: Node runs handlers in registration order). The snapshot stays empty
 * until the lock is held, so a Ctrl-C during acquisition cannot write `undefined` over a source.
 */
async function main() {
  const originals = new Map()
  const restoreAll = () => {
    for (const [file, text] of originals) writeFileSync(`${ROOT}/${file}`, text, 'utf8')
  }
  // try/finally covers a thrown suite, but NOT a signal: Node's default SIGINT handler exits
  // without unwinding. Restore explicitly before dying, so a Ctrl-C cannot leave a mutant behind.
  process.once('SIGINT', () => {
    restoreAll()
    console.error('\ninterrupted — original sources restored')
    process.exit(130)
  })
  process.once('SIGTERM', () => {
    restoreAll()
    process.exit(143)
  })

  await withMutationLock(
    async () => {
      console.log(`${LABEL}: mutation lock acquired`)
      for (const file of new Set(MUTANTS.map(m => m.file))) originals.set(file, readFileSync(`${ROOT}/${file}`, 'utf8'))

      const beforeHashes = new Map([...originals].map(([file, text]) => [file, sha(text)]))
      const rows = []

      for (const mutant of MUTANTS) {
        if (only.size > 0 && !only.has(mutant.id)) continue
        const original = originals.get(mutant.file)
        const edits = [{ find: mutant.find, replace: mutant.replace }, ...(mutant.extra ? (Array.isArray(mutant.extra) ? mutant.extra : [mutant.extra]) : [])]
        let text = original
        const problems = []
        for (const edit of edits) {
          const occurrences = text.split(edit.find).length - 1
          const expected = edit === edits[0] && mutant.all ? occurrences : 1
          if (mutant.all ? occurrences < 1 : occurrences !== 1) {
            problems.push(`literal occurs ${occurrences}x (expected ${mutant.all ? '>=1' : 1}): ${JSON.stringify(edit.find.slice(0, 70))}`)
            continue
          }
          text = mutant.all ? text.split(edit.find).join(edit.replace) : text.replace(edit.find, edit.replace)
        }
        if (problems.length > 0) {
          rows.push({ id: mutant.id, what: mutant.what, applied: false, problems })
          continue
        }

        // try/finally so an interrupt (Ctrl-C, timeout) between the two writes cannot leave a mutant
        // on disk: the source is restored before this process is allowed to exit.
        let run
        try {
          writeFileSync(`${ROOT}/${mutant.file}`, text, 'utf8')
          run = runSuite()
        } finally {
          writeFileSync(`${ROOT}/${mutant.file}`, original, 'utf8')
        }

        if (run.error) {
          rows.push({ id: mutant.id, what: mutant.what, applied: true, error: run.error })
          continue
        }
        const failed = failingTests(run.output)
        const missed = mutant.must.filter(name => !failed.some(actual => actual === name))
        rows.push({
          id: mutant.id,
          what: mutant.what,
          applied: true,
          red: failed.length > 0,
          failed,
          must: mutant.must,
          missed,
          caught: failed.length > 0 && missed.length === 0,
        })
      }

      // Restore check: every file must be byte-identical to the snapshot taken before the run.
      let restored = true
      for (const [file, text] of originals) {
        const now = readFileSync(`${ROOT}/${file}`, 'utf8')
        if (now !== text) restored = false
        if (sha(now) !== beforeHashes.get(file)) restored = false
      }

      console.log('\n=== B4 MUTATION RESULTS ===')
      for (const row of rows) {
        if (!row.applied) {
          console.log(`${row.id.padEnd(5)} APPLY-FAILED  ${row.problems.join(' | ')}`)
          continue
        }
        if (row.error) {
          console.log(`${row.id.padEnd(5)} RUN-ERROR     ${row.error}`)
          continue
        }
        const mark = row.caught ? 'CAUGHT ' : row.red ? 'PARTIAL' : 'MISSED '
        console.log(`${row.id.padEnd(5)} ${mark} red=${row.red ? 'yes' : 'no '} failed=${row.failed.length}`)
        console.log(`      what: ${row.what}`)
        if (row.missed.length) console.log(`      NOT in the failing set: ${row.missed.map(name => `"${name}"`).join(' ; ')}`)
        if (row.failed.length) console.log(`      failing: ${row.failed.slice(0, 6).map(name => `"${name}"`).join(' ; ')}${row.failed.length > 6 ? ` (+${row.failed.length - 6})` : ''}`)
      }
      console.log(`\nsource restored byte-for-byte: ${restored ? 'YES' : 'NO — INVESTIGATE'}`)
      const summary = { caught: rows.filter(r => r.caught).length, partial: rows.filter(r => r.applied && !r.error && r.red && !r.caught).length, missed: rows.filter(r => r.applied && !r.error && !r.red).length, failed: rows.filter(r => !r.applied || r.error).length }
      console.log(`totals: caught=${summary.caught} partial=${summary.partial} missed=${summary.missed} not-applied/errored=${summary.failed}`)
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
