/**
 * The constraint ledger (`lib/constraints.js`) and `workflow_gc` (`lib/gc.js`).
 *
 * WHAT THESE TESTS DEFEND, AND WHY IT IS NOT "THE LEDGER ROUND-TRIPS"
 * A store that reads and writes JSON is easy. The properties worth a test are the ones a
 * plausible implementation gets wrong:
 *
 *  1. **A free-text retirement signal is never reported as evaluated.** The design's own
 *     example signal ("连续 5 次 BUILD 阶段未触发 context_overflow 且无半成品提交") cannot be
 *     evaluated by any code in this plugin. An implementation that labels it `provably-due`
 *     removes a guardrail on a false premise, which is worse than never retiring anything.
 *     See "THE CORE RULE", "a signal plus partial machine evidence" and "every evaluation of
 *     an active constraint keeps signalEvaluated false" — mutants M1/M2/M3 are what they catch.
 *  2. **A constraint with no `retire_when` is a defect**, not a normal entry: see "a constraint
 *     with no retire_when is a DEFECT".
 *  3. **Adding requires the user, structurally.** The confirmation is a token only the
 *     framework can mint from an actual answer, and the tool's add path must write nothing
 *     when the answer is missing, refused, or unobtainable — mutants M5 and M11.
 *  4. **Nothing is ever deleted.** After retirement the entry is still in the file — M7.
 *  5. **The framework owns `added_at`.** A caller-supplied date would be backdating, which is
 *     how a model makes its own review clock elapsed — M6.
 *
 * Run with `node --test test/`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  CANDIDATE_FIELDS,
  CONSTRAINT_STATUSES,
  CONSTRAINTS_RELATIVE_PATH,
  OBSERVABLE_KINDS,
  RETIREMENT_VERDICTS,
  addConstraint,
  confirmationFromAnswer,
  countPhaseEntries,
  daysBetween,
  emptyConstraints,
  evaluateConstraint,
  evaluateConstraints,
  isConfirmed,
  nextConstraintId,
  readConstraints,
  readRetireCheck,
  retireConstraint,
  signalForDisplay,
  validateConstraintCandidate,
  writeConstraints,
} from '../lib/constraints.js'
import {
  GC_ACTIONS,
  GC_APPROVE_LABELS,
  GC_QUESTION_IDS,
  GC_SCOPES,
  buildGcToolDefinition,
  describeAskFailure,
  resolveUserQuestions,
} from '../lib/gc.js'
import { HISTORY_CAP, readState } from '../lib/advance.js'
import { resolveConfig, DEFAULT_CONFIG } from '../lib/config.js'
import { validateSettingValue } from '../lib/tools.js'

// ---------------------------------------------------------------------------
// harness
// ---------------------------------------------------------------------------

/** A project directory, opted in unless told otherwise. */
function makeProject({ optIn = true, workflow = null, constraints = undefined } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-wf-gc-'))
  mkdirSync(join(dir, '.dsh'), { recursive: true })
  if (optIn) writeFileSync(join(dir, '.dsh', 'workflow.yml'), workflow ?? 'tier: standard\n', 'utf8')
  if (constraints !== undefined) {
    writeFileSync(
      join(dir, CONSTRAINTS_RELATIVE_PATH),
      typeof constraints === 'string' ? constraints : JSON.stringify(constraints, null, 2),
      'utf8',
    )
  }
  return dir
}

const execFor = (dir, extra = {}) => ({
  agent: {
    id: 'agent-1',
    session: { header: { cwd: dir }, requestHeader: () => ({ config: { provider: 'p', model: 'test-model' } }) },
  },
  ...extra,
})

/** A complete, valid candidate. Individual tests override pieces of it. */
const candidate = (overrides = {}) => ({
  rule: 'implement one feature at a time',
  why: 'a single pass exhausted the context and left half-finished work',
  added_for_model: 'test-model',
  retire_when: { signal: 'five BUILD phases in a row without a half-finished commit', review_after_days: 30 },
  ...overrides,
})

/** A fake user-questions service that answers with the given option label. */
function fakeAnswerer({ label, questionId = null, throwError = null, record = [] }) {
  return {
    asked: record,
    async ask(request) {
      record.push(request)
      if (throwError !== null) throw throwError
      const question = request?.questions?.[0] ?? {}
      const chosen = label ?? null
      return { answers: [{ id: questionId ?? question.id, selected: chosen === null ? [] : [chosen] }] }
    },
  }
}

/** The stored constraints of a project. */
function storedConstraints(dir) {
  return readConstraints(dir).constraints
}

const iso = ms => new Date(ms).toISOString()
const dateOnly = ms => new Date(ms).toISOString().slice(0, 10)

/** A workflow state carrying `count` REAL transitions into `phase`, all after `sinceMs`. */
function stateWithPhaseEntries(phase, count, sinceMs) {
  return {
    schema_version: 1,
    history: Array.from({ length: count }, (unused, index) => ({
      at: iso(sinceMs + index * 1000),
      // `from` must DIFFER from `to`, because a same-phase entry is a log line, not a move.
      from: phase === 'BUILD' ? 'VERIFY' : 'BUILD',
      to: phase,
      reason: `entry ${index}`,
    })),
  }
}

// ---------------------------------------------------------------------------
// the store: hand-editable data is never assumed
// ---------------------------------------------------------------------------

test('an absent ledger reads as empty rather than as an error', () => {
  const dir = makeProject()
  const ledger = readConstraints(dir)
  assert.equal(ledger.present, false)
  assert.deepEqual(ledger.constraints, [])
  assert.deepEqual(ledger.problems, [])
  assert.equal(ledger.path, join(dir, CONSTRAINTS_RELATIVE_PATH))
})

test('an unparseable ledger yields a problem, not an exception', () => {
  const dir = makeProject({ constraints: '{ this is not json' })
  const ledger = readConstraints(dir)
  assert.equal(ledger.present, true)
  assert.deepEqual(ledger.constraints, [])
  assert.equal(ledger.problems.length, 1)
  assert.match(ledger.problems[0], /could not read/)
  assert.match(ledger.problems[0], /untouched/)
})

test('a ledger whose constraints field is not an array is reported and read as empty', () => {
  const dir = makeProject({ constraints: { constraints: { C001: 'nope' } } })
  const ledger = readConstraints(dir)
  assert.deepEqual(ledger.constraints, [])
  assert.equal(ledger.problems.length, 1)
  assert.match(ledger.problems[0], /expected an array/)
})

test('non-object entries stay visible and countable, and are reported', () => {
  const dir = makeProject({
    constraints: {
      constraints: [
        null,
        42,
        'C001',
        candidate({ id: 'C002', status: 'active', added_at: '2026-01-01' }),
      ],
    },
  })
  const ledger = readConstraints(dir)
  assert.equal(ledger.constraints.length, 4)
  assert.equal(ledger.problems.length, 1)
  assert.match(ledger.problems[0], /3 entr.* not an object/s)

  const analysis = evaluateConstraints(ledger.constraints, {})
  assert.equal(analysis.counts.defective, 3, 'the junk entries are defects; the real one is evaluated')
  assert.equal(analysis.counts.total, 4)
})

test('the write path is atomic: no temp file is left behind, and the JSON round-trips', () => {
  const dir = makeProject()
  const document = emptyConstraints()
  document.constraints.push({ id: 'C001', rule: 'r', why: 'w', retire_when: { review_after_days: 1 }, status: 'active' })
  const path = writeConstraints(dir, document)

  const names = readdirSync(join(dir, '.dsh'))
  assert.deepEqual(names.filter(name => name.includes('.tmp')), [])
  assert.deepEqual(JSON.parse(readFileSync(path, 'utf8')), document)
  assert.deepEqual(readConstraints(dir).constraints, document.constraints)
})

test('ids increment past malformed ones instead of colliding with them', () => {
  assert.equal(nextConstraintId([]), 'C001')
  assert.equal(nextConstraintId([{ id: 'C009' }, { id: 'nonsense' }, { id: 7 }, null], ), 'C010')
  assert.equal(nextConstraintId(null), 'C001')
})

test('the vocabulary the module publishes and the vocabularies it accepts agree', () => {
  // A list that drifts from the validator is how a documented status becomes unwritable.
  assert.deepEqual([...CONSTRAINT_STATUSES], ['active', 'retired'])
  assert.ok(RETIREMENT_VERDICTS.includes('provably-due') && RETIREMENT_VERDICTS.includes('due-for-human-review'))
  assert.ok(OBSERVABLE_KINDS.includes('phase_entries'))
  assert.ok(CANDIDATE_FIELDS.includes('retire_when'))
})

// ---------------------------------------------------------------------------
// the validator: nothing is coerced, nothing is defaulted away
// ---------------------------------------------------------------------------

test('a complete candidate validates and carries its retirement condition', () => {
  const verdict = validateConstraintCandidate(candidate())
  assert.equal(verdict.ok, true)
  assert.equal(verdict.value.rule, 'implement one feature at a time')
  assert.equal(verdict.value.retire_when.review_after_days, 30)
  assert.equal(verdict.value.retire_when.signal, 'five BUILD phases in a row without a half-finished commit')
})

test('a candidate with no retire_when is refused at the door', () => {
  const withoutRetire = candidate()
  delete withoutRetire.retire_when
  const verdict = validateConstraintCandidate(withoutRetire)
  assert.equal(verdict.ok, false)
  assert.match(verdict.problems.join(' '), /retire_when must be an object/)
  assert.match(verdict.problems.join(' '), /can never retire/)
})

test('an empty retire_when is refused: it is a promise that can never be kept', () => {
  const verdict = validateConstraintCandidate(candidate({ retire_when: {} }))
  assert.equal(verdict.ok, false)
  assert.match(verdict.problems.join(' '), /declares nothing usable/)
})

test('a numeric string is refused rather than coerced', () => {
  const verdict = validateConstraintCandidate(candidate({ retire_when: { review_after_days: '30' } }))
  assert.equal(verdict.ok, false)
  assert.match(verdict.problems.join(' '), /review_after_days must be a positive finite number/)
})

test('added_at and status cannot be supplied by a caller', () => {
  const verdict = validateConstraintCandidate(
    candidate({ added_at: '2000-01-01', status: 'retired' }),
  )
  assert.equal(verdict.ok, false)
  const text = verdict.problems.join(' ')
  assert.match(text, /unknown field "added_at"/)
  assert.match(text, /unknown field "status"/)
})

test('a typo in a field name is refused, never dropped', () => {
  // Dropping it would write a constraint that LOOKS complete and has no retirement condition.
  const verdict = validateConstraintCandidate({ rule: 'r', why: 'w', retireWhen: { signal: 's' } })
  assert.equal(verdict.ok, false)
  assert.match(verdict.problems.join(' '), /unknown field "retireWhen"/)
})

test('added_for_model falls back to the calling model, and is refused when neither is known', () => {
  const noModel = candidate()
  delete noModel.added_for_model
  assert.equal(validateConstraintCandidate(noModel).ok, false)
  assert.match(validateConstraintCandidate(noModel).problems.join(' '), /added_for_model/)

  const inferred = validateConstraintCandidate(noModel, { defaultForModel: 'session-model' })
  assert.equal(inferred.ok, true)
  assert.equal(inferred.value.added_for_model, 'session-model')
})

test('why is required, because a constraint nobody can justify can never be retired', () => {
  const verdict = validateConstraintCandidate(candidate({ why: '   ' }))
  assert.equal(verdict.ok, false)
  assert.match(verdict.problems.join(' '), /why must be a non-empty string/)
})

test('an observable the framework does not implement is refused, not stored as if checkable', () => {
  const verdict = validateConstraintCandidate(
    candidate({ retire_when: { observable: { kind: 'context_overflow_events', phase: 'BUILD', at_least: 1 } } }),
  )
  assert.equal(verdict.ok, false)
  assert.match(verdict.problems.join(' '), /only[\s\S]*implements phase_entries/)
})

test('an observable naming an unknown phase is refused', () => {
  const verdict = validateConstraintCandidate(
    candidate({ retire_when: { observable: { kind: 'phase_entries', phase: 'TELEPORT', at_least: 1 } } }),
  )
  assert.equal(verdict.ok, false)
  assert.match(verdict.problems.join(' '), /observable.phase is/)
})

test('a candidate that is not an object is refused with a description rather than a throw', () => {
  for (const value of [null, 'rule: x', 42, ['x']]) {
    const verdict = validateConstraintCandidate(value)
    assert.equal(verdict.ok, false)
    assert.ok(verdict.problems.length > 0)
  }
})

// ---------------------------------------------------------------------------
// the confirmation token: "the user agreed" is not something a caller can assert
// ---------------------------------------------------------------------------

test('a token is minted only from an answer naming the exact approving option', () => {
  const at = new Date('2026-01-02T00:00:00Z')
  const approved = confirmationFromAnswer({
    answer: { answers: [{ id: 'q', selected: ['Add the constraint'] }] },
    questionId: 'q',
    at,
    approveLabel: 'Add the constraint',
  })
  assert.equal(approved.approved, true)
  assert.equal(isConfirmed(approved), true)

  const declined = confirmationFromAnswer({
    answer: { answers: [{ id: 'q', selected: ['Do not add it'] }] },
    questionId: 'q',
    at,
    approveLabel: 'Add the constraint',
  })
  assert.equal(isConfirmed(declined), false)

  // A typed custom answer is NOT consent: "the user typed something" is a different claim
  // from "the user approved this text", and the wrong direction writes a constraint nobody
  // agreed to.
  const custom = confirmationFromAnswer({
    answer: { answers: [{ id: 'q', selected: [], custom: 'yes' }] },
    questionId: 'q',
    at,
    approveLabel: 'Add the constraint',
  })
  assert.equal(isConfirmed(custom), false)

  const wrongQuestion = confirmationFromAnswer({
    answer: { answers: [{ id: 'other', selected: ['Add the constraint'] }] },
    questionId: 'q',
    at,
    approveLabel: 'Add the constraint',
  })
  assert.equal(isConfirmed(wrongQuestion), false)
})

test('no hand-built shape is accepted as a confirmation', () => {
  for (const value of [
    undefined,
    null,
    true,
    'yes',
    {},
    { approved: true },
    { source: 'user-question', approved: true },
    // The full field set, WITHOUT the brand only `confirmationFromAnswer` can stamp: a caller
    // cannot manufacture consent, even in-process.
    { source: 'user-question', approved: true, questionId: 'q' },
    { source: 'user-question', approved: true, questionId: 'q', selected: ['Add the constraint'] },
  ]) {
    assert.equal(isConfirmed(value), false, `${JSON.stringify(value)} must not authorise a write`)
  }
  // The token that DOES come from a real answer carries the brand, and is accepted.
  const real = confirmationFromAnswer({
    answer: { answers: [{ id: 'q', selected: [GC_APPROVE_LABELS.add] }] },
    questionId: 'q',
    at: new Date(),
    approveLabel: GC_APPROVE_LABELS.add,
  })
  assert.equal(isConfirmed(real), true)
  assert.notEqual(isConfirmed({ ...real, approved: false }), true, 'and its approval field still decides')
})

test('the store refuses to add without a confirmation token, and changes nothing', () => {
  const document = emptyConstraints()
  for (const confirmation of [undefined, null, {}, { approved: true }, { source: 'user-question', approved: true, questionId: '' }]) {
    const result = addConstraint(document, candidate(), { confirmation })
    assert.equal(result.ok, false, `${JSON.stringify(confirmation)} must be refused`)
    assert.equal(result.status, 'not-confirmed')
  }
  assert.deepEqual(document.constraints, [])
})

test('a token for the reject option cannot be replayed as approval', () => {
  const document = emptyConstraints()
  const token = confirmationFromAnswer({
    answer: { answers: [{ id: 'q', selected: ['Do not add it'] }] },
    questionId: 'q',
    at: new Date(),
    approveLabel: GC_APPROVE_LABELS.add,
  })
  const result = addConstraint(document, candidate(), { confirmation: token })
  assert.equal(result.ok, false)
  assert.equal(result.status, 'not-confirmed')
})

test('a confirmed add stamps the framework date, never a caller-supplied one', () => {
  const document = emptyConstraints()
  const now = new Date('2026-01-02T03:04:05Z')
  const token = confirmationFromAnswer({
    answer: { answers: [{ id: 'q', selected: [GC_APPROVE_LABELS.add] }] },
    questionId: 'q',
    at: now,
    approveLabel: GC_APPROVE_LABELS.add,
  })
  const result = addConstraint(document, candidate(), { confirmation: token, now })
  assert.equal(result.ok, true)
  assert.equal(result.constraint.id, 'C001')
  assert.equal(result.constraint.status, 'active')
  assert.equal(result.constraint.added_at, '2026-01-02')
  assert.equal(result.constraint.confirmed_by, 'user-question')
  assert.equal(result.constraint.added_at, dateOnly(now.getTime()), 'the framework date, in full')

  // ...AND A CALLER-SUPPLIED DATE CANNOT REACH THE LEDGER THROUGH THIS DOOR EITHER. The property
  // was asserted here only as "the framework stamps its own date", which stays true even if a
  // backdated `added_at` on the candidate is honoured — the caller simply has not supplied one.
  // So the caller-supplies-one case is asserted explicitly: it must be REFUSED, because a
  // backdated constraint is a constraint whose review clock has already elapsed.
  const backdated = addConstraint(
    emptyConstraints(),
    { ...candidate(), added_at: '2000-01-01' },
    { confirmation: token, now },
  )
  assert.equal(backdated.ok, false)
  assert.equal(backdated.status, 'invalid-candidate')
  assert.match(backdated.problems.join(' '), /unknown field "added_at"/)
})

test('an exact duplicate rule is refused while the first is active, and allowed after retirement', () => {
  const now = new Date('2026-01-02T00:00:00Z')
  const token = confirmationFromAnswer({
    answer: { answers: [{ id: 'q', selected: [GC_APPROVE_LABELS.add] }] },
    questionId: 'q',
    at: now,
    approveLabel: GC_APPROVE_LABELS.add,
  })
  const first = addConstraint(emptyConstraints(), candidate(), { confirmation: token, now })
  assert.equal(first.ok, true)

  const second = addConstraint(first.document, candidate({ why: 'different reason' }), { confirmation: token, now })
  assert.equal(second.ok, false)
  assert.equal(second.status, 'duplicate')
  assert.equal(second.existingId, 'C001')
  assert.equal(first.document.constraints.length, 1)

  const retired = retireConstraint(first.document, 'C001', { confirmation: token, now, reason: 'gap closed' })
  assert.equal(retired.ok, true)
  const third = addConstraint(retired.document, candidate({ why: 'different reason' }), { confirmation: token, now })
  assert.equal(third.ok, true)
})

test('retirement requires confirmation, keeps the record, and is not a delete', () => {
  const now = new Date('2026-01-02T00:00:00Z')
  const token = confirmationFromAnswer({
    answer: { answers: [{ id: 'q', selected: [GC_APPROVE_LABELS.add] }] },
    questionId: 'q',
    at: now,
    approveLabel: GC_APPROVE_LABELS.add,
  })
  const added = addConstraint(emptyConstraints(), candidate(), { confirmation: token, now })

  const unconfirmed = retireConstraint(added.document, 'C001', { now })
  assert.equal(unconfirmed.ok, false)
  assert.equal(unconfirmed.status, 'not-confirmed')
  assert.equal(added.document.constraints[0].status, 'active')

  const retired = retireConstraint(added.document, 'C001', { confirmation: token, now, reason: 'the gap closed' })
  assert.equal(retired.ok, true)
  assert.equal(retired.constraint.status, 'retired')
  assert.equal(retired.constraint.retired_reason, 'the gap closed')
  assert.equal(retired.document.constraints.length, 1, 'the entry must be KEPT, never removed')
  assert.equal(retired.document.constraints[0].id, 'C001')
  assert.equal(retired.document.constraints[0].rule, 'implement one feature at a time')

  const again = retireConstraint(retired.document, 'C001', { confirmation: token, now })
  assert.equal(again.ok, false)
  assert.equal(again.status, 'already-retired')

  const missing = retireConstraint(retired.document, 'C999', { confirmation: token, now })
  assert.equal(missing.ok, false)
  assert.equal(missing.status, 'unknown-constraint')
  assert.deepEqual(missing.known, ['C001'])
})

// ---------------------------------------------------------------------------
// the retirement rule: what IS checked, and what is NOT
// ---------------------------------------------------------------------------

test('a constraint with no retire_when is a DEFECT, not a normal entry', () => {
  const evaluation = evaluateConstraint({
    id: 'C007',
    rule: 'one feature at a time',
    why: 'context exhaustion',
    added_at: '2026-01-01',
    added_for_model: 'test-model',
    status: 'active',
  })
  assert.equal(evaluation.verdict, 'defective')
  assert.match(evaluation.defects.join(' '), /can never retire/)
  assert.equal(evaluation.checks.length, 0)
})

test('a retire_when that declares nothing usable is a DEFECT', () => {
  const evaluation = evaluateConstraint({
    id: 'C007',
    rule: 'r',
    why: 'w',
    added_at: '2026-01-01',
    added_for_model: 'm',
    status: 'active',
    retire_when: {},
  })
  assert.equal(evaluation.verdict, 'defective')
  assert.match(evaluation.defects.join(' '), /no condition the framework can read/)
})

test('an unknown or missing status is a defect: the framework cannot say if the constraint is in force', () => {
  for (const status of [undefined, 'paused', 42]) {
    const evaluation = evaluateConstraint({ id: 'C007', rule: 'r', why: 'w', status, retire_when: { signal: 's' } })
    assert.equal(evaluation.verdict, 'defective', `status=${String(status)}`)
    assert.match(evaluation.defects.join(' '), /status is/)
  }
})

test('an entry with no id is a defect: nothing can reference or retire it', () => {
  const evaluation = evaluateConstraint({ rule: 'r', why: 'w', status: 'active', retire_when: { review_after_days: 1 } })
  assert.equal(evaluation.verdict, 'defective')
  assert.match(evaluation.defects.join(' '), /no usable id/)
})

test('a retired constraint is reported as retired, not re-evaluated', () => {
  const evaluation = evaluateConstraint({ id: 'C001', status: 'retired', rule: 'r', why: 'w' })
  assert.equal(evaluation.verdict, 'retired')
})

test('THE CORE RULE: a free-text signal is NEVER reported as evaluated', () => {
  // The design's own example. Nothing in this plugin can evaluate that sentence, so the only
  // honest verdicts are "due for human review" or "not due" — never "provably due".
  const now = new Date('2026-12-31T00:00:00Z')
  const evaluation = evaluateConstraint(
    {
      id: 'C007',
      rule: '每次只实现一个功能点，不许一次做完',
      why: '防 agent 一口气做完导致上下文耗尽、留下半成品',
      added_at: '2026-01-01',
      added_for_model: 'deepseek-flash',
      status: 'active',
      retire_when: {
        signal: '连续 5 次 BUILD 阶段未触发 context_overflow 且无半成品提交',
        review_after_days: 30,
      },
    },
    { now },
  )

  assert.equal(evaluation.verdict, 'due-for-human-review')
  assert.notEqual(evaluation.verdict, 'provably-due')
  assert.equal(evaluation.signalEvaluated, false)
  // The machine-checkable half IS reported, and says what it is.
  assert.equal(evaluation.checks.length, 1)
  assert.equal(evaluation.checks[0].evaluated, true)
  assert.equal(evaluation.checks[0].satisfied, true)
  assert.match(evaluation.checks[0].detail, /not the constraint's free-text signal/)
  // The question carries the reason the constraint exists and states the limit.
  assert.match(evaluation.question, /why it exists: 防 agent 一口气做完/)
  assert.match(evaluation.question, /NOT evaluated by the framework/)
  assert.match(evaluation.question, /CANNOT confirm the signal/)
})

test('a free-text signal that has not come due yet is NOT reported as unmet either', () => {
  const evaluation = evaluateConstraint(
    {
      id: 'C008',
      rule: 'r',
      why: 'w',
      added_at: '2026-12-30',
      added_for_model: 'm',
      status: 'active',
      retire_when: { signal: 'no context overflow in five BUILD phases', review_after_days: 30 },
    },
    { now: new Date('2026-12-31T00:00:00Z') },
  )
  assert.equal(evaluation.verdict, 'not-due')
  assert.equal(evaluation.signalEvaluated, false)
  assert.match(evaluation.note, /CANNOT be evaluated/)
  assert.match(evaluation.note, /not a claim that the signal is unmet/)
})

test('a signal-only constraint is always a question for a human', () => {
  const evaluation = evaluateConstraint({
    id: 'C009',
    rule: 'r',
    why: 'w',
    added_at: '2026-01-01',
    added_for_model: 'm',
    status: 'active',
    retire_when: { signal: 'the model stops needing this' },
  })
  assert.equal(evaluation.verdict, 'due-for-human-review')
  assert.equal(evaluation.checks.length, 0)
  assert.match(evaluation.question, /CANNOT confirm the signal/)
})

test('a purely mechanical condition that holds IS provably due — that is the only such path', () => {
  const evaluation = evaluateConstraint(
    {
      id: 'C010',
      rule: 'r',
      why: 'w',
      added_at: '2026-01-01',
      added_for_model: 'm',
      status: 'active',
      retire_when: { review_after_days: 30 },
    },
    { now: new Date('2026-02-15T00:00:00Z') },
  )
  assert.equal(evaluation.verdict, 'provably-due')
  assert.equal(evaluation.signal, null)
  assert.match(evaluation.note, /never retires anything by itself/)
})

test('a mechanical condition that does not hold is not due', () => {
  const evaluation = evaluateConstraint(
    {
      id: 'C011',
      rule: 'r',
      why: 'w',
      added_at: '2026-02-14',
      added_for_model: 'm',
      status: 'active',
      retire_when: { review_after_days: 30 },
    },
    { now: new Date('2026-02-15T00:00:00Z') },
  )
  assert.equal(evaluation.verdict, 'not-due')
})

test('a missing added_for_model blocks the provably-due claim', () => {
  const evaluation = evaluateConstraint(
    {
      id: 'C012',
      rule: 'r',
      why: 'w',
      added_at: '2026-01-01',
      status: 'active',
      retire_when: { review_after_days: 1 },
    },
    { now: new Date('2026-02-15T00:00:00Z') },
  )
  assert.notEqual(evaluation.verdict, 'provably-due')
  assert.match(evaluation.problems.join(' '), /added_for_model is missing/)
})

test('an unreadable added_at is NOT treated as elapsed, and not as "not due" either', () => {
  const evaluation = evaluateConstraint({
    id: 'C013',
    rule: 'r',
    why: 'w',
    added_at: 'sometime in 2026',
    added_for_model: 'm',
    status: 'active',
    retire_when: { review_after_days: 30 },
  })
  assert.equal(evaluation.verdict, 'due-for-human-review')
  assert.match(evaluation.unevaluable.join(' '), /added_at is/)
  assert.match(evaluation.unevaluable.join(' '), /not treated as elapsed/)
})

// ---------------------------------------------------------------------------
// a REAL counter, over REAL recorded events
// ---------------------------------------------------------------------------

test('the phase counter reads only real history entries, for its phase and its window', () => {
  const state = {
    history: [
      { at: '2026-01-01T00:00:00.000Z', from: 'PICK', to: 'BUILD' },
      { at: '2026-01-02T00:00:00.000Z', from: 'BUILD', to: 'VERIFY' },
      { at: '2026-01-03T00:00:00.000Z', from: 'VERIFY', to: 'BUILD' },
      { at: '2026-01-04T00:00:00.000Z', from: 'BUILD', to: 'VERIFY' },
      { at: 'not a date', from: 'VERIFY', to: 'BUILD' },
      { from: 'VERIFY', to: 'BUILD' },
      null,
      'junk',
    ],
  }
  const all = countPhaseEntries(state, { phase: 'BUILD' })
  assert.equal(all.count, 2, 'only entries with a readable date and the right phase count')
  assert.equal(all.considered, 2)
  assert.equal(all.truncated, false)
  assert.equal(all.usable, true)

  const windowed = countPhaseEntries(state, { phase: 'BUILD', since: '2026-01-02T00:00:00.000Z' })
  assert.equal(windowed.count, 1, 'entries before the constraint was added must not count')

  assert.equal(countPhaseEntries(state, { phase: 'VERIFY' }).count, 2)
  assert.equal(countPhaseEntries(state, { phase: 'COMMIT' }).count, 0)
  assert.equal(countPhaseEntries(null, { phase: 'BUILD' }).count, 0)
})

test('a same-phase log line is NOT a phase transition', () => {
  // `workflow_advance` appends `{from:'PICK',to:'PICK'}` when picking inside PICK, and
  // `{from:phase,to:phase}` on every record-review. Counting those would let five log lines
  // satisfy a counter declared as "five BUILD phases".
  const state = {
    history: [
      { at: '2026-01-01T00:00:00.000Z', from: 'BUILD', to: 'BUILD', reason: 'review PASS' },
      { at: '2026-01-02T00:00:00.000Z', from: 'BUILD', to: 'BUILD', reason: 'review FAIL' },
      { at: '2026-01-03T00:00:00.000Z', from: 'VERIFY', to: 'BUILD' },
    ],
  }
  assert.equal(countPhaseEntries(state, { phase: 'BUILD' }).count, 1)
  assert.equal(countPhaseEntries(state, { phase: 'BUILD' }).considered, 1)
})

test('a window that cannot be read is not an open window', () => {
  // The fail-open reading of an unreadable date is "count everything", which makes any
  // threshold satisfiable — the shape that once produced a false `provably-due`.
  const state = stateWithPhaseEntries('BUILD', 3, Date.parse('2026-02-01T00:00:00.000Z'))
  const counted = countPhaseEntries(state, { phase: 'BUILD', since: 'sometime in 2026' })
  assert.equal(counted.usable, false)
  assert.equal(counted.count, 0)
})

test('the counter reports a full history window as a lower bound instead of a total', () => {
  const state = stateWithPhaseEntries('BUILD', HISTORY_CAP, Date.parse('2026-01-01T00:00:00.000Z'))
  const counted = countPhaseEntries(state, { phase: 'BUILD', since: '2026-01-01T00:00:00.000Z' })
  assert.equal(counted.count, HISTORY_CAP)
  assert.equal(counted.truncated, true)
})

test('an observable the framework CAN evaluate is provably checked', () => {
  const state = stateWithPhaseEntries('BUILD', 5, Date.parse('2026-02-01T00:00:00.000Z'))
  const evaluation = evaluateConstraint(
    {
      id: 'C020',
      rule: 'r',
      why: 'w',
      added_at: '2026-01-01',
      added_for_model: 'm',
      status: 'active',
      retire_when: { observable: { kind: 'phase_entries', phase: 'BUILD', at_least: 5 } },
    },
    { now: new Date('2026-03-01T00:00:00Z'), state },
  )
  assert.equal(evaluation.verdict, 'provably-due')
  assert.equal(evaluation.checks[0].name, 'observable:phase_entries')
  assert.equal(evaluation.checks[0].evaluated, true)
  assert.equal(evaluation.checks[0].satisfied, true)
})

test('a conjunction with one part unmet and nothing unreadable is NOT DUE, not a question', () => {
  // Round-2 review finding: `satisfiedAny` sent this shape to DUE FOR HUMAN REVIEW, whose own
  // claim is "each one has a condition it did not evaluate" — false here, since every condition
  // WAS evaluated and one simply does not hold. A conjunction means what it says.
  const state = stateWithPhaseEntries('BUILD', 2, Date.parse('2026-02-01T00:00:00.000Z'))
  const evaluation = evaluateConstraint(
    {
      id: 'C025',
      rule: 'r',
      why: 'w',
      added_at: '2026-01-01',
      added_for_model: 'm',
      status: 'active',
      retire_when: {
        review_after_days: 30,
        observable: { kind: 'phase_entries', phase: 'BUILD', at_least: 5 },
      },
    },
    { now: new Date('2026-03-05T00:00:00Z'), state },
  )
  assert.equal(evaluation.verdict, 'not-due')
  assert.equal(evaluation.checks.length, 2)
  assert.equal(evaluation.checks.every(check => check.evaluated === true), true)
  assert.deepEqual(evaluation.checks.map(check => check.satisfied), [true, false])
  assert.deepEqual(evaluation.unevaluable, [])

  // ...and the same conjunction with BOTH parts met is provably due, so the change did not
  // simply widen `not-due`.
  const met = evaluateConstraint(
    {
      id: 'C026',
      rule: 'r',
      why: 'w',
      added_at: '2026-01-01',
      added_for_model: 'm',
      status: 'active',
      retire_when: {
        review_after_days: 30,
        observable: { kind: 'phase_entries', phase: 'BUILD', at_least: 5 },
      },
    },
    { now: new Date('2026-03-05T00:00:00Z'), state: stateWithPhaseEntries('BUILD', 5, Date.parse('2026-02-01')) },
  )
  assert.equal(met.verdict, 'provably-due')
})

test('an OBSERVABLE-ONLY constraint with no usable added_at is never provably due', () => {
  // THE REGRESSION THIS FILE EXISTS FOR. The window date was originally checked only inside the
  // `review_after_days` branch, so an observable-only constraint skipped it; the counter was
  // handed a NaN window, which counted every retained BUILD entry, and the constraint was
  // reported PROVABLY DUE — a guardrail lifted on a condition nobody evaluated.
  const state = stateWithPhaseEntries('BUILD', 9, Date.parse('2026-02-01T00:00:00.000Z'))
  // `2026-02-31` is in the list on purpose: it is a string that LOOKS like a date, and the
  // lenient parser rolls it into 2026-03-03 instead of rejecting it.
  for (const addedAt of [undefined, 'sometime in 2026', '2026-02-31', 12345, null]) {
    const evaluation = evaluateConstraint(
      {
        id: 'C024',
        rule: 'r',
        why: 'w',
        ...(addedAt === undefined ? {} : { added_at: addedAt }),
        added_for_model: 'm',
        status: 'active',
        retire_when: { observable: { kind: 'phase_entries', phase: 'BUILD', at_least: 1 } },
      },
      { now: new Date('2026-03-01T00:00:00Z'), state },
    )
    assert.notEqual(evaluation.verdict, 'provably-due', `added_at=${String(addedAt)}`)
    assert.equal(evaluation.verdict, 'due-for-human-review', `added_at=${String(addedAt)}`)
    assert.equal(evaluation.checks.length, 0, 'nothing was measured, so nothing is reported as measured')
    assert.match(evaluation.unevaluable.join(' '), /added_at is/)
    // And the counter was never asked a question it could answer wrongly.
    assert.equal(evaluation.signalEvaluated, false)
  }
})

test('an observable below its threshold is not due, and below a FULL window it is not "not due" either', () => {
  const partial = evaluateConstraint(
    {
      id: 'C021',
      rule: 'r',
      why: 'w',
      added_at: '2026-01-01',
      added_for_model: 'm',
      status: 'active',
      retire_when: { observable: { kind: 'phase_entries', phase: 'BUILD', at_least: 5 } },
    },
    { now: new Date('2026-03-01T00:00:00Z'), state: stateWithPhaseEntries('BUILD', 2, Date.parse('2026-02-01')) },
  )
  assert.equal(partial.verdict, 'not-due')

  const truncated = evaluateConstraint(
    {
      id: 'C022',
      rule: 'r',
      why: 'w',
      added_at: '2026-01-01',
      added_for_model: 'm',
      status: 'active',
      retire_when: { observable: { kind: 'phase_entries', phase: 'BUILD', at_least: 500 } },
    },
    {
      now: new Date('2026-03-01T00:00:00Z'),
      state: stateWithPhaseEntries('BUILD', HISTORY_CAP, Date.parse('2026-02-01')),
    },
  )
  // A full window means earlier transitions may have been dropped, so the count is a lower
  // bound and the framework must not claim the threshold is unmet.
  assert.equal(truncated.verdict, 'due-for-human-review')
  assert.equal(truncated.checks[0].evaluated, false)
  assert.match(truncated.checks[0].detail, /lower bound/)
})

test('a signal plus partial machine evidence never becomes provably due', () => {
  const state = stateWithPhaseEntries('BUILD', 5, Date.parse('2026-02-01T00:00:00.000Z'))
  const evaluation = evaluateConstraint(
    {
      id: 'C023',
      rule: 'r',
      why: 'w',
      added_at: '2026-01-01',
      added_for_model: 'm',
      status: 'active',
      retire_when: {
        signal: 'no context overflow in five BUILD phases',
        observable: { kind: 'phase_entries', phase: 'BUILD', at_least: 5 },
      },
    },
    { now: new Date('2026-03-01T00:00:00Z'), state },
  )
  // The observable is met; the sentence also says "no context overflow", which the framework
  // does NOT track. Reporting this as provably due would drop the guardrail on the half it
  // never evaluated.
  assert.notEqual(evaluation.verdict, 'provably-due')
  assert.equal(evaluation.verdict, 'due-for-human-review')
  assert.equal(evaluation.checks[0].satisfied, true)
  assert.match(evaluation.question, /CANNOT confirm the signal/)
})

test('every evaluation of an active constraint keeps signalEvaluated false', () => {
  // A single mutant flipping this to true is the whole failure mode in one field.
  const cases = [
    { retire_when: { signal: 's', review_after_days: 1 } },
    { retire_when: { signal: 's' } },
    { retire_when: { review_after_days: 1 } },
    { retire_when: { observable: { kind: 'phase_entries', phase: 'BUILD', at_least: 1 } } },
  ]
  for (const extra of cases) {
    const evaluation = evaluateConstraint(
      { id: 'C030', rule: 'r', why: 'w', added_at: '2026-01-01', added_for_model: 'm', status: 'active', ...extra },
      { now: new Date('2026-03-01T00:00:00Z'), state: stateWithPhaseEntries('BUILD', 3, 0) },
    )
    assert.equal(evaluation.signalEvaluated, false, JSON.stringify(extra))
    assert.ok(RETIREMENT_VERDICTS.includes(evaluation.verdict))
  }
})

test('a signal that is present but UNREADABLE is never treated as an ABSENT signal', () => {
  // THE ROUND-1 REVIEW DEFECT (major, reachable). `nonEmptyString(['a','b'])` is null, so an
  // array/number/object/boolean signal collapsed to "no signal declared"; with an elapsed clock
  // every machine condition held, so the entry was reported PROVABLY DUE while the renderer
  // printed "signal: (none declared)" and the consent question asked about a constraint whose
  // signal was never shown. Same failure class as the unreadable date: a declared condition
  // silently dropped, retiring a guardrail on a false premise.
  const elapsed = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10)
  const shapes = [
    ['five BUILD phases without context_overflow', 'no half-finished commit'], // a natural two-part signal
    5,
    { text: 'no context overflow' },
    true,
    '',
    '   ',
  ]
  for (const signal of shapes) {
    const evaluation = evaluateConstraint({
      id: 'C001',
      rule: 'r',
      why: 'w',
      added_at: elapsed,
      added_for_model: 'm',
      status: 'active',
      retire_when: { signal, review_after_days: 30 },
    })
    const label = `signal=${JSON.stringify(signal)}`
    assert.notEqual(evaluation.verdict, 'provably-due', label)
    assert.equal(evaluation.verdict, 'due-for-human-review', label)
    assert.equal(evaluation.signal, null, label)
    assert.notEqual(evaluation.unreadableSignal, null, label)
    assert.match(evaluation.unevaluable.join(' '), /not readable text/, label)
    assert.equal(evaluation.signalEvaluated, false, label)
    // The human sees the value the file holds — never "(none)".
    assert.doesNotMatch(evaluation.question, /\(none\)/, `${label}: the question must not claim there is no signal`)
    assert.match(evaluation.question, /not readable text/, label)
  }

  // A SIGNAL-ONLY entry with an unreadable value is not DEFECTIVE either: the file DOES declare a
  // signal, so "declares no condition ... and no signal at all" would be a false statement.
  const only = evaluateConstraint({
    id: 'C002',
    rule: 'r',
    why: 'w',
    added_at: elapsed,
    added_for_model: 'm',
    status: 'active',
    retire_when: { signal: ['a', 'b'] },
  })
  assert.equal(only.verdict, 'due-for-human-review')
  assert.doesNotMatch(JSON.stringify(only.defects), /no signal at all/)

  // ...and a readable signal is still routed exactly as before (this did not widen the verdict).
  const readable = evaluateConstraint({
    id: 'C003',
    rule: 'r',
    why: 'w',
    added_at: elapsed,
    added_for_model: 'm',
    status: 'active',
    retire_when: { signal: 'the model stops needing this', review_after_days: 30 },
  })
  assert.equal(readable.verdict, 'due-for-human-review')
  assert.equal(readable.unreadableSignal, null)
  assert.equal(readable.signal, 'the model stops needing this')
  assert.doesNotMatch(readable.question, /not readable text/)
})

test('an entry that never reached the evaluation still reports its unreadable signal', async () => {
  // ROUND-2 REVIEW BLOCKER (reachable). `rawSignal`/`unreadableSignal` were derived AFTER the
  // early returns, so an entry with an invalid `status` ("Active"), a `retired` status, or no id
  // came back with `unreadableSignal: null` — the renderer printed "signal: (none declared)" and
  // the RETIREMENT CONSENT PROMPT showed "(none)" before a human agreed to lift a guardrail that
  // the file says is conditioned on a signal. The derivation now happens before every early
  // return, and this test pins that for all three shapes.
  const arraySignal = ['five green builds', 'no flaky test']
  const shapes = [
    { id: 'C001', status: 'Active', retire_when: { signal: arraySignal, review_after_days: 30 } },
    { id: 'C002', status: 'retired', retire_when: { signal: arraySignal } },
    { status: 'active', retire_when: { signal: arraySignal } },
  ]
  for (const entry of shapes) {
    const evaluation = evaluateConstraint(entry, { now: new Date('2026-03-01T00:00:00Z') })
    const label = `id=${String(entry.id)} status=${String(entry.status)}`
    assert.notEqual(evaluation.unreadableSignal, null, label)
    assert.equal(signalForDisplay(evaluation), signalForDisplay({ retire_when: entry.retire_when }), label)
    assert.match(signalForDisplay(evaluation), /UNREADABLE — declared as/, label)
    assert.notEqual(signalForDisplay(evaluation), '(none)', label)
  }

  // ...and the FILE's own words reach the human, in both the scan block and the consent prompt.
  const dir = makeProject({
    constraints: {
      constraints: [
        { id: 'C001', rule: 'one at a time', why: 'w', status: 'Active', added_for_model: 'm', retire_when: { signal: arraySignal, review_after_days: 30 } },
      ],
    },
  })
  const service = fakeAnswerer({ label: GC_APPROVE_LABELS.retire, questionId: GC_QUESTION_IDS.retire })
  const tool = gcTool({ services: { userQuestions: service } })
  const scan = await tool.execute({ action: 'scan' }, execFor(dir))
  assert.equal(scan.counts.provablyDue, 0)
  const scanned = scan.defective.items[0] ?? scan.dueForHumanReview.items[0]
  assert.match(signalForDisplay(scanned), /UNREADABLE — declared as/)

  const text = tool.output.render({}, scan)[0].text
  const block = text.split('- C001')[1].split('\n\n')[0]
  assert.match(block, /UNREADABLE — declared as/, 'the rendered entry must show the declared signal')
  assert.doesNotMatch(block, /signal: \(none declared\)/)

  const result = await tool.execute({ action: 'retire', id: 'C001' }, execFor(dir))
  assert.equal(service.asked.length, 1, 'the retirement really asked the user')
  const question = service.asked[0].questions[0].question
  assert.match(question, /UNREADABLE — declared as/, 'the consent prompt must show the declared signal')
  assert.doesNotMatch(question, /retirement signal \(free text, NOT evaluated by the framework\): \(none\)/)
  // It must not claim there was nothing to check while the file declares review_after_days.
  assert.doesNotMatch(question, /declares no machine-readable condition/)
  assert.match(question, /NOT EVALUATED/)
  // The retirement still happened (the prompt was truthful, not blocked) — that is the documented
  // policy: the framework asks, the person decides.
  assert.equal(result.status, 'retired')
})

test('the buckets partition the ledger: every active entry is in exactly one', () => {
  const constraints = [
    candidate({ id: 'C001', status: 'active', added_at: '2026-01-01' }), // free-text signal → human review
    { id: 'C002', rule: 'r2', why: 'w', added_at: '2026-01-01', added_for_model: 'm', status: 'active', retire_when: { review_after_days: 30 } },
    { id: 'C003', rule: 'r3', why: 'w', added_at: '2026-02-01', added_for_model: 'm', status: 'active', retire_when: { review_after_days: 90 } },
    { id: 'C004', rule: 'r4', why: 'w', status: 'active' },
    { id: 'C005', status: 'retired' },
    'junk',
  ]
  const analysis = evaluateConstraints(constraints, { now: new Date('2026-03-05T00:00:00Z'), state: readState('/nonexistent').state })

  const seen = [
    ...analysis.provablyDue,
    ...analysis.dueForHumanReview,
    ...analysis.notDue,
    ...analysis.defective,
    ...analysis.retired,
  ]
  assert.equal(seen.length, constraints.length)
  assert.equal(new Set(seen).size, constraints.length, 'an entry must not appear in two buckets')

  assert.equal(analysis.counts.total, 6)
  assert.equal(analysis.counts.retired, 1)
  assert.equal(analysis.counts.defective, 2) // C004 (no retire_when) and the junk string
  assert.equal(analysis.counts.provablyDue, 1) // C002
  assert.equal(analysis.counts.dueForHumanReview, 1) // C001
  assert.equal(analysis.counts.notDue, 1) // C003
})

test('daysBetween returns null rather than inventing an interval', () => {
  assert.equal(daysBetween('2026-01-01', '2026-01-31'), 30)
  assert.equal(daysBetween(undefined, undefined), null)
  assert.equal(daysBetween('nope', null), null)
  assert.equal(daysBetween('2026-01-01', 'not a date'), null)
  // A malformed added_at must never look like an elapsed clock.
  assert.notEqual(daysBetween('sometime in 2026', new Date()), 0)
})

test('a date that only the LENIENT parser would accept is not a date', () => {
  // THE ROOT CAUSE OF THE FALSE `provably-due`. `Date.parse('sometime in 2026')` does not return
  // NaN: it returns 2026-01-01T00:00:00Z. That one coercion defeated all three fail-closed guards
  // at once — an unreadable `added_at` reported an elapsed 283-day review clock, an unreadable
  // counter window counted every retained entry, and an observable-only constraint went provably
  // due. The accepted grammar is therefore narrow, and this test pins the parser itself rather
  // than only the verdicts three call sites downstream.
  const now = new Date('2026-10-11T00:00:00Z')
  assert.equal(daysBetween('sometime in 2026', now), null)
  assert.equal(daysBetween('12345', now), null)
  assert.equal(daysBetween('01/02/2026', now), null)
  assert.equal(daysBetween('next Tuesday', now), null)
  // An impossible calendar date must not silently roll over into a real one: `new Date('2026-02-31')`
  // is 2026-03-03, i.e. a hand-edit would move the window by days without saying so.
  assert.equal(daysBetween('2026-02-31', now), null)
  assert.equal(daysBetween('2026-13-01', now), null)
  // ...and the two shapes the framework itself writes still read exactly as before.
  assert.equal(daysBetween('2026-01-01', '2026-01-31'), 30)
  assert.equal(daysBetween('2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z'), 1)

  // The same coercion at the counter: an impossible window is unusable, never a full window.
  const state = stateWithPhaseEntries('BUILD', 3, Date.parse('2026-02-01T00:00:00.000Z'))
  for (const since of ['sometime in 2026', '2026-02-31', '12345', true, {}, []]) {
    const counted = countPhaseEntries(state, { phase: 'BUILD', since })
    assert.equal(counted.usable, false, `since=${JSON.stringify(since)}`)
    assert.equal(counted.count, 0, `since=${JSON.stringify(since)}`)
  }
  // A NON-STRING window is still a window. The fail-open shape here was "not a string ⇒ treat as
  // no window", i.e. count every retained entry; a number remains epoch milliseconds (parseDate's
  // documented contract), and it is the READER that decides readability, not a type test.
  const epochWindow = countPhaseEntries(state, { phase: 'BUILD', since: 0 })
  assert.equal(epochWindow.usable, true)
  assert.equal(epochWindow.count, 3, 'every retained entry is after 1970-01-01')
  // A history entry with an impossible `at` is skipped, not rolled into the adjacent day.
  assert.equal(
    countPhaseEntries(
      { history: [{ at: '2026-02-31T00:00:00.000Z', from: 'VERIFY', to: 'BUILD' }] },
      { phase: 'BUILD' },
    ).count,
    0,
  )
})

// ---------------------------------------------------------------------------
// workflow_gc: the tool
// ---------------------------------------------------------------------------

const gcTool = (options = {}) => buildGcToolDefinition({ config: resolveConfig({}), ...options })

test('the tool publishes the design vocabulary and refuses the scopes it does not implement', async () => {
  assert.deepEqual([...GC_ACTIONS], ['scan', 'list', 'add', 'retire'])
  assert.deepEqual([...GC_SCOPES], ['constraints', 'code', 'docs', 'all'])

  const dir = makeProject()
  const tool = gcTool()
  for (const scope of ['code', 'docs']) {
    const result = await tool.execute({ action: 'scan', scope }, execFor(dir))
    assert.equal(result.ok, false, scope)
    assert.equal(result.status, 'not-implemented')
    assert.match(result.reason, /not implemented/)
  }
  const all = await tool.execute({ action: 'scan', scope: 'all' }, execFor(dir))
  assert.equal(all.ok, true, 'scope=all still runs the part that exists')
  assert.deepEqual(all.scope.unimplemented, ['code', 'docs'])
})

test('nothing happens in a project that has not opted in — not even a ledger file', async () => {
  const dir = makeProject({ optIn: false })
  const result = await gcTool().execute({ action: 'add', constraint: candidate() }, execFor(dir))
  assert.equal(result.ok, false)
  assert.equal(result.status, 'not-enabled')
  assert.equal(existsSync(join(dir, CONSTRAINTS_RELATIVE_PATH)), false)
})

test('the constraintLedger switch really gates the ledger', async () => {
  const dir = makeProject({ workflow: 'modules:\n  constraintLedger: false\n' })
  const result = await gcTool().execute({ action: 'scan' }, execFor(dir))
  assert.equal(result.ok, false)
  assert.equal(result.status, 'disabled')
  assert.match(result.reason, /modules.constraintLedger is off/)
})

test('retireCheck.enabled really gates the retire check, without disabling the ledger', async () => {
  const dir = makeProject({
    workflow: 'retireCheck:\n  enabled: false\n',
    constraints: { constraints: [candidate({ id: 'C001' })] },
  })
  const tool = gcTool()
  const scan = await tool.execute({ action: 'scan' }, execFor(dir))
  assert.equal(scan.ok, false)
  assert.equal(scan.status, 'disabled')
  assert.match(scan.reason, /retireCheck.enabled is off/)

  const list = await tool.execute({ action: 'list' }, execFor(dir))
  assert.equal(list.ok, true, 'listing the ledger is not the retire check')
  assert.equal(list.ledger.constraints.length, 1)
})

test('scan separates provably due from due-for-human-review and claims nothing about the signal', async () => {
  const dir = makeProject({
    constraints: {
      constraints: [
        {
          id: 'C001',
          rule: 'one feature at a time',
          why: 'context exhaustion',
          added_at: '2026-01-01',
          added_for_model: 'deepseek-flash',
          status: 'active',
          retire_when: { signal: 'no context overflow in five BUILD phases', review_after_days: 1 },
        },
        {
          id: 'C002',
          rule: 'never edit a test to pass',
          why: 'it hides the defect',
          added_at: '2026-01-01',
          added_for_model: 'deepseek-flash',
          status: 'active',
          retire_when: { review_after_days: 1 },
        },
      ],
    },
  })

  const tool = gcTool()
  const result = await tool.execute({ action: 'scan' }, execFor(dir))
  assert.equal(result.ok, true)
  assert.equal(result.status, 'ok')
  assert.deepEqual(result.provablyDue.items.map(item => item.id), ['C002'])
  assert.deepEqual(result.dueForHumanReview.items.map(item => item.id), ['C001'])
  assert.equal(result.counts.provablyDue, 1)
  assert.equal(result.counts.dueForHumanReview, 1)
  // The bucket's own claim is part of the payload, so a renderer cannot lose it.
  assert.match(result.dueForHumanReview.claim, /CANNOT confirm/)
  assert.match(result.provablyDue.claim, /evaluated by the framework/)

  const text = tool.output.render({}, result)[0].text
  assert.match(text, /PROVABLY DUE \(1\)/)
  assert.match(text, /DUE FOR HUMAN REVIEW \(1\)/)
  assert.match(text, /FREE TEXT — the framework did NOT evaluate this/)
  assert.match(text, /CANNOT confirm the signal/)
  assert.match(text, /question for a human:/)
})

test('scan reports a defective constraint instead of silently accepting it', async () => {
  const dir = makeProject({
    constraints: {
      constraints: [
        { id: 'C001', rule: 'no lifecycle', why: 'unknown', added_at: '2026-01-01', added_for_model: 'm', status: 'active' },
      ],
    },
  })
  const tool = gcTool()
  const result = await tool.execute({ action: 'scan' }, execFor(dir))
  assert.equal(result.ok, true)
  assert.equal(result.status, 'defects-found')
  assert.equal(result.defective.items.length, 1)
  assert.match(result.reason, /can never retire/)
  const text = tool.output.render({}, result)[0].text
  assert.match(text, /DEFECTIVE — CAN NEVER RETIRE \(1\)/)
  assert.match(text, /DEFECT: /)
})

test('scan says out loud that nothing schedules it', async () => {
  const dir = makeProject()
  const result = await gcTool().execute({ action: 'scan' }, execFor(dir))
  assert.equal(result.retireCheck.enabled, true)
  assert.equal(result.retireCheck.scheduled, false)
  assert.match(result.retireCheck.note, /nothing in this plugin runs on a timer/)
})

test('the retireCheck section has ONE reader, and it refuses rather than coerces', () => {
  const defaults = DEFAULT_CONFIG.retireCheck
  assert.equal(readRetireCheck(undefined, defaults).ok, true)
  assert.equal(readRetireCheck({}, defaults).ok, true)
  assert.equal(readRetireCheck({ everyDays: 7 }, defaults).everyDays, 7)

  for (const value of ['nope', 42, [], true]) {
    assert.equal(readRetireCheck(value, defaults).ok, false, `${JSON.stringify(value)} must be refused`)
  }
  for (const value of ['30', 0, -1, 2.5, true, {}]) {
    assert.equal(readRetireCheck({ everyDays: value }, defaults).ok, false, `everyDays ${String(value)}`)
  }
  for (const value of ['false', 0, 1, {}]) {
    assert.equal(readRetireCheck({ enabled: value }, defaults).ok, false, `enabled ${String(value)}`)
    assert.equal(readRetireCheck({ autoSuggest: value }, defaults).ok, false, `autoSuggest ${String(value)}`)
  }
  // An explicit null is "unset", matching every other section reader in this plugin.
  assert.equal(readRetireCheck({ enabled: null, everyDays: null }, defaults).ok, true)
  assert.equal(readRetireCheck({ enabled: null, everyDays: null }, defaults).everyDays, defaults.everyDays)

  // An unknown key is a typo, and an ignored typo is a setting the user believes is in force.
  const typo = readRetireCheck({ everyDay: 7 }, defaults)
  assert.equal(typo.ok, false)
  assert.match(typo.problems.join(' '), /retireCheck.everyDay is not a known field/)
  assert.equal(readRetireCheck({ ...DEFAULT_CONFIG.retireCheck }, defaults).ok, true, 'the declared fields are known')

  // On failure the values are the documented defaults, so a caller that ignores `ok` is safe.
  const broken = readRetireCheck({ enabled: false, everyDays: 'soon' }, defaults)
  assert.equal(broken.ok, false)
  assert.equal(broken.everyDays, defaults.everyDays)
  assert.equal(broken.enabled, defaults.enabled)
})

test('the writer refuses every retireCheck value the reader refuses, per key and whole-section', () => {
  assert.equal(validateSettingValue(['retireCheck', 'everyDays'], 30), null)
  assert.notEqual(validateSettingValue(['retireCheck', 'everyDays'], '30'), null)
  assert.notEqual(validateSettingValue(['retireCheck', 'everyDays'], 0), null)
  assert.equal(validateSettingValue(['retireCheck', 'enabled'], false), null)

  assert.equal(validateSettingValue(['retireCheck'], { enabled: false }), null)
  assert.equal(validateSettingValue(['retireCheck'], null), null)
  assert.notEqual(validateSettingValue(['retireCheck'], 'nope'), null)
  assert.notEqual(validateSettingValue(['retireCheck'], { everyDays: 'soon' }), null)
  assert.notEqual(validateSettingValue(['retireCheck'], { enabled: 'false' }), null)
  assert.notEqual(validateSettingValue(['retireCheck'], { everyDay: 7 }), null)
})

test('a malformed retireCheck section refuses the scan instead of guessing', async () => {
  const dir = makeProject({ workflow: 'retireCheck: nope\n' })
  const result = await gcTool().execute({ action: 'scan' }, execFor(dir))
  assert.equal(result.ok, false)
  assert.equal(result.status, 'unusable-config')
  assert.match(result.problems.join(' '), /expected a section/)
  assert.match(result.reason, /did not run/)
})

test('retireCheck.autoSuggest withholds the questions without changing a single verdict', async () => {
  const dir = makeProject({
    workflow: 'retireCheck:\n  autoSuggest: false\n',
    constraints: {
      constraints: [
        {
          id: 'C001',
          rule: 'one feature at a time',
          why: 'context exhaustion',
          added_at: '2026-01-01',
          added_for_model: 'm',
          status: 'active',
          retire_when: { signal: 'no context overflow in five BUILD phases', review_after_days: 1 },
        },
      ],
    },
  })
  const result = await gcTool().execute({ action: 'scan' }, execFor(dir))
  assert.equal(result.ok, true)
  assert.equal(result.retireCheck.autoSuggest, false)
  assert.match(result.retireCheck.note, /questions were withheld/)
  assert.equal(result.dueForHumanReview.items.length, 1)
  assert.equal(result.dueForHumanReview.items[0].verdict, 'due-for-human-review')
  assert.equal(result.dueForHumanReview.items[0].question, null)
  // The classification and the honest claim survive; only the ask is withheld.
  assert.match(result.dueForHumanReview.claim, /CANNOT confirm/)
})

test('scan is read-only: it never rewrites the ledger and never retires anything', async () => {
  const dir = makeProject({
    constraints: {
      constraints: [candidate({ id: 'C001', status: 'active', added_at: '2020-01-01' })],
    },
  })
  const before = readFileSync(join(dir, CONSTRAINTS_RELATIVE_PATH), 'utf8')
  const result = await gcTool().execute({ action: 'scan' }, execFor(dir))
  assert.equal(result.counts.dueForHumanReview > 0 || result.counts.provablyDue > 0, true)
  assert.equal(readFileSync(join(dir, CONSTRAINTS_RELATIVE_PATH), 'utf8'), before)
  assert.equal(storedConstraints(dir)[0].status, 'active')
})

test('a scan whose only finding is provably due does not headline "No constraint is due for review"', async () => {
  // ROUND-1 REVIEW DEFECT (minor, reachable): `reason` is the one line a caller reading only the
  // summary sees, and it said "No constraint is due for review" while the very same payload listed
  // "PROVABLY DUE (1)" — the candidate invisible in the headline.
  const dir = makeProject({
    constraints: {
      constraints: [
        {
          id: 'C001',
          rule: 'one feature at a time',
          why: 'context exhaustion',
          added_at: new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10),
          added_for_model: 'm',
          status: 'active',
          retire_when: { review_after_days: 30 },
        },
      ],
    },
  })
  const result = await gcTool().execute({ action: 'scan' }, execFor(dir))
  assert.equal(result.counts.provablyDue, 1)
  assert.equal(result.counts.dueForHumanReview, 0)
  assert.match(result.reason, /PROVABLY DUE/)
  assert.doesNotMatch(result.reason, /No constraint is due for review/)
  // ...and the empty ledger still gets the "nothing due" line, so the branch did not simply widen.
  const empty = await gcTool().execute({ action: 'scan' }, execFor(makeProject()))
  assert.match(empty.reason, /No constraint is due for review/)
})

test('adding without a user-questions service refuses and writes NOTHING', async () => {
  const dir = makeProject()
  const tool = gcTool({ services: null })
  const result = await tool.execute({ action: 'add', constraint: candidate() }, execFor(dir))
  assert.equal(result.ok, false)
  assert.equal(result.status, 'confirmation-unavailable')
  assert.match(result.reason, /no user-questions service/)
  assert.equal(existsSync(join(dir, CONSTRAINTS_RELATIVE_PATH)), false)
})

test('a declined confirmation writes NOTHING', async () => {
  const dir = makeProject()
  const service = fakeAnswerer({ label: 'Do not add it' })
  const tool = gcTool({ services: { userQuestions: service } })
  const result = await tool.execute({ action: 'add', constraint: candidate() }, execFor(dir))
  assert.equal(result.ok, false)
  assert.equal(result.status, 'not-confirmed')
  assert.match(result.reason, /did not choose the confirming option/)
  assert.equal(existsSync(join(dir, CONSTRAINTS_RELATIVE_PATH)), false)
  // The question really was asked, and it carried the retirement condition.
  assert.equal(service.asked.length, 1)
  assert.match(service.asked[0].questions[0].question, /retires when:/)
})

test('a custom answer is not consent', async () => {
  const dir = makeProject()
  const service = {
    async ask(request) {
      return { answers: [{ id: request.questions[0].id, selected: [], custom: 'add it' }] }
    },
  }
  const tool = gcTool({ services: { userQuestions: service } })
  const result = await tool.execute({ action: 'add', constraint: candidate() }, execFor(dir))
  assert.equal(result.ok, false)
  assert.equal(result.status, 'not-confirmed')
  assert.equal(existsSync(join(dir, CONSTRAINTS_RELATIVE_PATH)), false)
})

test('a delegated child cannot confirm, and the refusal says what to do instead', async () => {
  const dir = makeProject()
  const error = Object.assign(new Error('delegated'), { code: 'DELEGATED_CALLER' })
  const tool = gcTool({ services: { userQuestions: fakeAnswerer({ label: null, throwError: error }) } })
  const result = await tool.execute({ action: 'add', constraint: candidate() }, execFor(dir))
  assert.equal(result.ok, false)
  assert.equal(result.status, 'confirmation-failed')
  assert.match(result.reason, /delegated child/)
  assert.match(result.reason, /NOT modified/)
  assert.equal(existsSync(join(dir, CONSTRAINTS_RELATIVE_PATH)), false)
  assert.match(describeAskFailure(error), /include the candidate/i)
})

test('an approved add writes the constraint, with the model the session is running', async () => {
  const dir = makeProject()
  const service = fakeAnswerer({ label: GC_APPROVE_LABELS.add, questionId: GC_QUESTION_IDS.add })
  const tool = gcTool({ services: { userQuestions: service } })
  const payload = {
    ...candidate(),
    added_for_model: undefined,
  }
  delete payload.added_for_model
  const result = await tool.execute({ action: 'add', constraint: payload }, execFor(dir))

  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 200))
  assert.equal(result.status, 'added')
  assert.equal(result.constraint.id, 'C001')
  assert.equal(result.constraint.added_for_model, 'test-model', 'the session model is the default')
  assert.equal(result.confirmedBy, 'user-question')

  const stored = storedConstraints(dir)
  assert.equal(stored.length, 1)
  assert.equal(stored[0].status, 'active')
  assert.equal(stored[0].added_at, new Date().toISOString().slice(0, 10))

  // ...and a second scan now reports it rather than losing it.
  //
  // WHICH BUCKET, AND WHY IT IS `notDue`. This constraint was added moments ago and its
  // `review_after_days` window has not elapsed, so nothing about it is a retirement candidate
  // yet. Its free-text signal is unevaluable — which is why it can never be `provablyDue` — but
  // that does not make it a QUESTION for a person: `dueForHumanReview` is the bucket of entries
  // whose machine-checked half is due and whose remainder the framework cannot confirm. The
  // identical shape with an ELAPSED clock is due-for-human-review; see
  // "a free-text signal that has not come due yet is NOT reported as unmet either" and
  // "a scan buckets a signal-bearing constraint by its machine-checked half". Asserting
  // `dueForHumanReview` here would contradict that first test, so this one was wrong.
  const scan = await tool.execute({ action: 'scan' }, execFor(dir))
  assert.equal(scan.counts.total, 1)
  assert.equal(scan.notDue.items.length, 1)
  assert.equal(scan.notDue.items[0].id, 'C001')
  assert.equal(scan.dueForHumanReview.items.length, 0)
  assert.equal(scan.provablyDue.items.length, 0)
  // The note is what keeps `notDue` from reading as "the signal is unmet".
  assert.match(scan.notDue.items[0].note, /not a claim that the signal is unmet/)
})

test('a scan buckets a signal-bearing constraint by its machine-checked half', async () => {
  // Two entries carrying the SAME unevaluable signal, differing only in whether the review clock
  // has elapsed. Neither may be provably due — the signal is never evaluated — but only the
  // elapsed one is a retirement candidate worth asking a person about. This is the tool-level
  // counterpart of "a free-text signal that has not come due yet is NOT reported as unmet
  // either": it pins the bucket, not just the verdict, and it pins that a fresh constraint does
  // not immediately become a question.
  const day = 86400000
  const elapsed = new Date(Date.now() - 90 * day).toISOString().slice(0, 10)
  const fresh = new Date().toISOString().slice(0, 10)
  const dir = makeProject({
    constraints: {
      constraints: [
        candidate({ id: 'C001', status: 'active', added_at: elapsed }),
        candidate({ id: 'C002', status: 'active', added_at: fresh }),
      ],
    },
  })
  const result = await gcTool().execute({ action: 'scan' }, execFor(dir))

  assert.equal(result.counts.total, 2)
  assert.equal(result.counts.provablyDue, 0, 'a free-text signal can never be provably due')
  assert.deepEqual(result.dueForHumanReview.items.map(item => item.id), ['C001'])
  assert.deepEqual(result.notDue.items.map(item => item.id), ['C002'])
  assert.equal(result.notDue.items[0].question, null, 'a not-yet-due constraint is not a question')
  assert.match(result.notDue.items[0].note, /not a claim that the signal is unmet/)
  assert.match(result.dueForHumanReview.items[0].question, /CANNOT confirm the signal/)
  // Both buckets refuse to claim the signal was verified, in their own words.
  assert.match(result.notDue.claim, /not claiming it is unmet/)
  assert.match(result.dueForHumanReview.claim, /CANNOT confirm/)
})

test('an invalid candidate is refused BEFORE the user is asked anything', async () => {
  const dir = makeProject()
  const service = fakeAnswerer({ label: GC_APPROVE_LABELS.add })
  const tool = gcTool({ services: { userQuestions: service } })
  const noRetire = candidate()
  delete noRetire.retire_when
  const result = await tool.execute({ action: 'add', constraint: noRetire }, execFor(dir))
  assert.equal(result.ok, false)
  assert.equal(result.status, 'invalid-candidate')
  assert.equal(service.asked.length, 0, 'a malformed candidate must not cost the user a prompt')
  assert.equal(existsSync(join(dir, CONSTRAINTS_RELATIVE_PATH)), false)
})

test('dry_run validates without asking and without writing', async () => {
  const dir = makeProject()
  const service = fakeAnswerer({ label: GC_APPROVE_LABELS.add })
  const tool = gcTool({ services: { userQuestions: service } })
  const result = await tool.execute({ action: 'add', constraint: candidate(), dry_run: true }, execFor(dir))
  assert.equal(result.ok, true)
  assert.equal(result.status, 'dry-run')
  assert.equal(service.asked.length, 0)
  assert.equal(existsSync(join(dir, CONSTRAINTS_RELATIVE_PATH)), false)
})

test('a ledger that cannot be read is never appended to', async () => {
  const dir = makeProject({ constraints: { constraints: 'not an array' } })
  const before = readFileSync(join(dir, CONSTRAINTS_RELATIVE_PATH), 'utf8')
  const service = fakeAnswerer({ label: GC_APPROVE_LABELS.add })
  const tool = gcTool({ services: { userQuestions: service } })
  const result = await tool.execute({ action: 'add', constraint: candidate() }, execFor(dir))
  assert.equal(result.ok, false)
  assert.equal(result.status, 'unreadable-ledger')
  assert.match(result.reason, /nothing was written/)
  assert.equal(service.asked.length, 0, 'do not ask about a write that cannot happen')
  assert.equal(readFileSync(join(dir, CONSTRAINTS_RELATIVE_PATH), 'utf8'), before)
})

test('an approved retirement keeps the entry and records why', async () => {
  const dir = makeProject({
    constraints: {
      constraints: [candidate({ id: 'C001', status: 'active', added_at: '2026-01-01' })],
    },
  })
  const service = fakeAnswerer({ label: GC_APPROVE_LABELS.retire, questionId: GC_QUESTION_IDS.retire })
  const tool = gcTool({ services: { userQuestions: service } })
  const result = await tool.execute({ action: 'retire', id: 'C001', reason: 'the gap closed' }, execFor(dir))

  assert.equal(result.ok, true, JSON.stringify(result).slice(0, 200))
  assert.equal(result.status, 'retired')
  assert.equal(result.constraint.status, 'retired')
  assert.match(service.asked[0].questions[0].question, /Retire constraint C001/)
  assert.match(service.asked[0].questions[0].question, /nothing is deleted/i)

  const stored = storedConstraints(dir)
  assert.equal(stored.length, 1, 'THE ENTRY IS NOT DELETED')
  assert.equal(stored[0].id, 'C001')
  assert.equal(stored[0].status, 'retired')
  assert.equal(stored[0].retired_reason, 'the gap closed')

  // A retired constraint is reported as retired, and never asked about again.
  const scan = await tool.execute({ action: 'scan' }, execFor(dir))
  assert.equal(scan.retired.items.length, 1)
  assert.equal(scan.counts.dueForHumanReview, 0)
})

test('a declined retirement keeps the constraint active', async () => {
  const dir = makeProject({
    constraints: { constraints: [candidate({ id: 'C001', status: 'active', added_at: '2026-01-01' })] },
  })
  const tool = gcTool({ services: { userQuestions: fakeAnswerer({ label: 'Keep it' }) } })
  const before = readFileSync(join(dir, CONSTRAINTS_RELATIVE_PATH), 'utf8')
  const result = await tool.execute({ action: 'retire', id: 'C001' }, execFor(dir))
  assert.equal(result.ok, false)
  assert.equal(result.status, 'not-confirmed')
  assert.equal(readFileSync(join(dir, CONSTRAINTS_RELATIVE_PATH), 'utf8'), before)
  assert.equal(storedConstraints(dir)[0].status, 'active')
})

test('retiring an unknown id changes nothing and lists what does exist', async () => {
  const dir = makeProject({ constraints: { constraints: [candidate({ id: 'C001' })] } })
  const tool = gcTool({ services: { userQuestions: fakeAnswerer({ label: GC_APPROVE_LABELS.retire }) } })
  const result = await tool.execute({ action: 'retire', id: 'C404' }, execFor(dir))
  assert.equal(result.ok, false)
  assert.equal(result.status, 'unknown-constraint')
  assert.deepEqual(result.known, ['C001'])
})

test('list shows the ledger as recorded, with no analysis attached', async () => {
  const dir = makeProject({ constraints: { constraints: [candidate({ id: 'C001' })] } })
  const result = await gcTool().execute({ action: 'list' }, execFor(dir))
  assert.equal(result.ok, true)
  assert.equal(result.ledger.constraints.length, 1)
  assert.match(result.reason, /No retirement condition was evaluated/)
})

test('the user-questions service is probed through every documented shape', () => {
  const service = { ask: async () => ({ answers: [] }) }
  assert.equal(resolveUserQuestions({ services: { userQuestions: service } }, {}), service)
  assert.equal(resolveUserQuestions({ getUserQuestions: () => service }, {}), service)
  assert.equal(resolveUserQuestions({ ctx: { get: name => (name === 'userQuestions' ? service : undefined) } }, {}), service)
  assert.equal(resolveUserQuestions({}, { userQuestions: service }), service)
  // A throwing ctx.get must not take the tool down.
  assert.equal(resolveUserQuestions({ ctx: { get: () => { throw new Error('cannot get') } } }, {}), undefined)
  assert.equal(resolveUserQuestions({ services: { userQuestions: {} } }, {}), undefined)
})

test('every workflow_gc payload is lossless JSON', async () => {
  const dir = makeProject({
    constraints: { constraints: [candidate({ id: 'C001', added_at: '2020-01-01' }), { id: 'C002', status: 'active' }] },
  })
  const tool = gcTool({ services: { userQuestions: fakeAnswerer({ label: GC_APPROVE_LABELS.add }) } })
  const payloads = [
    await tool.execute({ action: 'scan' }, execFor(dir)),
    await tool.execute({ action: 'list' }, execFor(dir)),
    await tool.execute({ action: 'scan', scope: 'code' }, execFor(dir)),
    await tool.execute({ action: 'add', constraint: candidate(), dry_run: true }, execFor(dir)),
    await tool.execute({ action: 'add', constraint: candidate({ rule: 'a second rule' }) }, execFor(dir)),
    await tool.execute({ action: 'retire', id: 'C404' }, execFor(dir)),
  ]
  for (const payload of payloads) {
    assert.equal(JSON.stringify(payload), JSON.stringify(JSON.parse(JSON.stringify(payload))))
  }
})

test('the renderer survives the shape a hand-edited ledger can actually produce', async () => {
  const dir = makeProject({
    constraints: {
      constraints: [
        { id: 'C001', rule: { nested: 'object' }, why: 42, status: 'active', retire_when: { signal: ['not', 'a', 'string'] } },
        { id: 'C002', status: 'active', retire_when: { observable: { kind: 'phase_entries', phase: 'BUILD', at_least: 1 } } },
      ],
    },
  })
  // A REAL recorded transition, so the observable in C002 is met by the counter and the only
  // thing standing between it and a false `provably-due` is its missing added_at. Without this
  // entry the fixture could not exercise the fail-open path at all.
  writeFileSync(
    join(dir, '.dsh', 'WORKFLOW.json'),
    JSON.stringify({
      schema_version: 1,
      phase: 'BUILD',
      history: [{ at: new Date().toISOString(), from: 'VERIFY', to: 'BUILD' }],
    }),
    'utf8',
  )

  const tool = gcTool()
  const scan = await tool.execute({ action: 'scan' }, execFor(dir))
  // C001's signal is an ARRAY, i.e. declared but unreadable: it is a question for a human, not a
  // "defective — can never retire" entry and never a `provably-due` one.
  assert.deepEqual(scan.dueForHumanReview.items.map(item => item.id), ['C001', 'C002'])
  assert.equal(scan.counts.provablyDue, 0)
  assert.equal(scan.counts.defective, 0)
  assert.match(scan.dueForHumanReview.items[0].unevaluable.join(' '), /not readable text/)
  assert.match(scan.dueForHumanReview.items[1].unevaluable.join(' '), /added_at is/)
  assert.doesNotMatch(scan.dueForHumanReview.items[0].question, /\(none\)/)

  for (const action of ['scan', 'list']) {
    const payload = await tool.execute({ action }, execFor(dir))
    let text
    assert.doesNotThrow(() => {
      text = tool.output.render({}, payload)[0].text
    }, `render(${action}) must not throw on hand-edited data`)
    assert.equal(typeof text, 'string')
    if (action === 'scan') {
      // The renderer must not tell the human the ledger declares no signal when it declares one
      // it could not read. The C001 block, isolated, is the thing under test.
      const block = text.split('- C001').slice(1).join('- C001').split('- C002')[0]
      assert.match(block, /UNREADABLE — declared as/, 'C001 must render its unreadable signal')
      assert.doesNotMatch(block, /signal: \(none declared\)/, 'C001 must not be rendered as having no signal')
    }
  }

  // The renderer must also survive a payload that is not even the documented one.
  for (const hostile of [
    { ok: true, counts: 3, provablyDue: 'nope', defective: { items: [null, 42] } },
    { ok: false, status: 'unknown', known: 'not-an-array' },
    {},
  ]) {
    assert.doesNotThrow(() => tool.output.render({}, hostile))
  }
})
