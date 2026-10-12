/**
 * The constraint ledger (`.dsh/CONSTRAINTS.json`) and THE RETIREMENT RULE.
 *
 * WHY A CONSTRAINT LEDGER AT ALL
 * A harness grows constraints — "implement one feature at a time", "never edit a test to
 * make it pass" — because the model got something wrong. Each one is real, and each one is
 * also a bet that the model will keep getting that thing wrong. When the model improves,
 * the bet is worthless and the constraint is pure cost. The design's most important
 * meta-rule is therefore that a constraint has a LIFECYCLE: it names what it defends
 * against, who it was added for, and the condition under which it should be removed.
 *
 * THE POINT THAT IS EASY TO GET WRONG
 * `retire_when.signal` is NATURAL LANGUAGE. The design's own example is
 * "连续 5 次 BUILD 阶段未触发 context_overflow 且无半成品提交". No code in this plugin can
 * evaluate that sentence, and a garbage collector that reports "the retirement signal is
 * satisfied" when it has not evaluated the signal REMOVES A GUARDRAIL ON A FALSE PREMISE —
 * worse than never retiring anything, because a constraint exists precisely to prevent a
 * failure that has not happened yet. So evaluation is split, permanently and visibly:
 *
 *   - a condition is `evaluated` only when the framework computed it from data it really
 *     records, and the detail string says which data;
 *   - `provably-due` requires EVERY declared condition to have been evaluated AND satisfied
 *     AND no free-text signal to be outstanding. Only then may the framework defend the
 *     claim "this should be retired";
 *   - anything the framework cannot evaluate routes to `due-for-human-review`: it is a
 *     question for the human, carrying the constraint's `why`, and a statement that the
 *     framework cannot confirm it.
 *
 * A constraint with NO `retire_when` is itself a defect — it can never retire, which is the
 * failure mode this whole module exists to prevent — and is reported as such rather than
 * silently accepted.
 *
 * WHAT IS WRITTEN, AND WHAT IS NEVER WRITTEN
 * Nothing here deletes. `retireConstraint` sets `status: 'retired'` and keeps the record,
 * because the history of which constraints were needed and why they stopped being needed is
 * the only evidence that the harness is shrinking for the right reason.
 *
 * @module src-12453345_-dsh-workflow/constraints
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { describeValue } from './gate.js'
import { HISTORY_CAP, PHASES } from './advance.js'

/** Where the ledger lives, relative to the project root. */
export const CONSTRAINTS_RELATIVE_PATH = join('.dsh', 'CONSTRAINTS.json')

/** The lifecycle states a constraint may be in. */
export const CONSTRAINT_STATUSES = Object.freeze(['active', 'retired'])

/**
 * The retirement verdicts, from strongest claim to weakest.
 *
 * `provably-due` is the ONLY verdict that asserts the retirement condition is met, and it
 * is reachable only when the framework evaluated every part of that condition itself.
 */
export const RETIREMENT_VERDICTS = Object.freeze([
  'provably-due',
  'due-for-human-review',
  'not-due',
  'defective',
  'retired',
])

/**
 * The counter kinds the framework can really evaluate.
 *
 * ONE KIND, DELIBERATELY. Every entry here has to be a count over events the framework
 * writes itself; adding a kind before the events exist would be a re-reading of a sentence
 * dressed up as a check. `phase_entries` counts transitions INTO a phase in
 * `.dsh/WORKFLOW.json` history — entries appended by `transition()` on every real move.
 */
export const OBSERVABLE_KINDS = Object.freeze(['phase_entries'])

/** Fields a candidate constraint may carry. Anything else is refused, never ignored. */
export const CANDIDATE_FIELDS = Object.freeze(['rule', 'why', 'added_for_model', 'retire_when'])

/** Fields `retire_when` may carry. */
export const RETIRE_WHEN_FIELDS = Object.freeze(['signal', 'review_after_days', 'observable'])

/** Fields the `retireCheck` configuration section may carry. */
export const RETIRE_CHECK_FIELDS = Object.freeze(['enabled', 'everyDays', 'autoSuggest'])

/**
 * Read and validate the `retireCheck` section. THE single reader for it.
 *
 * It exists for the same reason `lib/gate.js` exists: the writer (`workflow_set`) and the
 * reader (`workflow_gc`) must not answer "is this section usable" differently. The per-key
 * rule and the whole-section rule both route through here, because a section write is not a
 * free pass just because the section name is legal — a rule that covered only the per-key
 * path let `workflow_set path=retireCheck value={everyDays:'soon'}` persist a cadence the
 * reader then displayed as if it had asked for it.
 *
 * A malformed value is REFUSED, never coerced: `'30'` is not 30 days.
 *
 * @param source - the raw `retireCheck` section.
 * @param defaults - `{ enabled, everyDays, autoSuggest }`.
 * @returns `{ ok, problems, enabled, everyDays, autoSuggest }`; on failure the three values
 *   carry the defaults, so a caller that ignores `ok` still fails closed.
 */
export function readRetireCheck(source, defaults = { enabled: true, everyDays: 30, autoSuggest: true }) {
  const problems = []
  const fallback = {
    enabled: defaults.enabled ?? true,
    everyDays: defaults.everyDays ?? 30,
    autoSuggest: defaults.autoSuggest ?? true,
  }

  if (source !== undefined && source !== null && !isPlainObject(source)) {
    problems.push(
      `retireCheck is ${describeValue(source)} (${typeof source}); expected a section (an object). ` +
        'The defaults were used instead.',
    )
    return { ok: false, problems, ...fallback }
  }

  const raw = source ?? {}

  // An unknown key is a TYPO, and a typo here is a setting that silently does not apply: a
  // user who writes `everyDay: 7` would otherwise get the 30-day default with `ok: true` and
  // no way to notice. Refused, not ignored — the same stance `validateTopLevelKey` takes.
  for (const key of Object.keys(raw)) {
    if (!RETIRE_CHECK_FIELDS.includes(key)) {
      problems.push(
        `retireCheck.${key} is not a known field; expected one of ${RETIRE_CHECK_FIELDS.join(', ')}. ` +
          'Unknown fields are refused rather than ignored, because an ignored typo is a setting ' +
          'the user believes is in force.',
      )
    }
  }

  const enabled = raw.enabled ?? fallback.enabled
  if (typeof enabled !== 'boolean') {
    problems.push(`retireCheck.enabled is ${describeValue(enabled)} (${typeof enabled}); expected true or false.`)
  }

  const everyDays = raw.everyDays ?? fallback.everyDays
  if (!Number.isInteger(everyDays) || everyDays < 1) {
    problems.push(
      `retireCheck.everyDays must be a whole number of days of 1 or more; got ${describeValue(everyDays)}. ` +
        'A cadence that is not a whole number is a configuration error, not a preference.',
    )
  }

  const autoSuggest = raw.autoSuggest ?? fallback.autoSuggest
  if (typeof autoSuggest !== 'boolean') {
    problems.push(`retireCheck.autoSuggest is ${describeValue(autoSuggest)} (${typeof autoSuggest}); expected true or false.`)
  }

  if (problems.length) return { ok: false, problems, ...fallback }
  return { ok: true, problems: [], enabled, everyDays, autoSuggest }
}

const NOTE =
  'The framework never deletes a constraint and never removes an entry from this file. ' +
  'Retirement sets status="retired" and keeps the record. workflow_gc only ever SUGGESTS: ' +
  'a constraint whose free-text signal cannot be evaluated is surfaced as a question for a ' +
  'human, and is never reported as though the framework had verified its signal.'

/** An empty ledger document. */
export function emptyConstraints() {
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    constraints: [],
    notes: NOTE,
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** A non-empty trimmed string, or null. Never throws on hand-editable input. */
function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

// THE SHAPES THIS MODULE ACCEPTS AS A DATE, AND WHY IT DOES NOT ACCEPT MORE.
//
// `new Date(string)` runs V8's legacy lenient parser. `Date.parse('sometime in 2026')` does not
// return NaN — it returns 2026-01-01T00:00:00.000Z, and `Date.parse('12345')` returns an epoch
// date. Every fail-closed guard in this file is phrased as "an unreadable date means the
// condition was NOT evaluated", so a parser that invents a date for a string that is not one
// defeats all of those guards at once, silently. Measured on this code, with `added_at:
// 'sometime in 2026'`:
//
//   * the review clock reported "283 day(s) since added_at sometime in 2026" and the constraint
//     was reported `provably-due`;
//   * `countPhaseEntries(..., { since: 'sometime in 2026' })` returned `usable: true` with every
//     retained entry counted — i.e. an unreadable window was treated as a FULLY OPEN one;
//   * an OBSERVABLE-ONLY constraint with that added_at was reported `provably-due`.
//
// That is exactly the false-premise retirement this module exists to prevent, so the accepted
// grammar is narrow: the calendar-date form the framework itself writes (`added_at` is
// `now.toISOString().slice(0, 10)`) plus the ISO date-time forms, with an optional Z or offset.
const ISO_DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/
const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})?$/

/**
 * Is the leading `YYYY-MM-DD` a date that exists?
 *
 * An impossible date must not silently become a different one: `new Date('2026-02-31')` is
 * 2026-03-03, so a hand-edited `added_at` of 2026-02-31 would quietly read as a date three days
 * later than the one written. The date is round-tripped through UTC and must survive unchanged.
 */
function isRealCalendarDate(text) {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text)
  if (match === null) return false
  const year = Number(match[1])
  const month = Number(match[2])
  const day = Number(match[3])
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  )
}

/**
 * Parse a Date, a STRICT ISO date/date-time string, or epoch milliseconds.
 *
 * @param value - the value to read.
 * @returns a Date, or null when this is not a date the framework is willing to compute on.
 */
function parseDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return null
    const parsed = new Date(value)
    return Number.isNaN(parsed.getTime()) ? null : parsed
  }
  if (typeof value !== 'string') return null
  const text = value.trim()
  if (!ISO_DATE_ONLY.test(text) && !ISO_DATE_TIME.test(text)) return null
  if (!isRealCalendarDate(text)) return null
  const parsed = new Date(text)
  return Number.isNaN(parsed.getTime()) ? null : parsed
}

/**
 * Coerce a caller-supplied clock to a Date, without ever throwing.
 *
 * @param value - a Date, an ISO string, or epoch milliseconds.
 * @returns a Date (the current time when the input is unusable).
 */
export function toDate(value) {
  return parseDate(value) ?? new Date()
}

/**
 * Whole days between two dates, or null when either is unusable.
 *
 * NULL RATHER THAN 0 OR "NOW": a caller that gets a number back has a real interval, and a
 * caller that gets null knows the inputs could not be compared. Silently substituting the
 * current time would turn a malformed `added_at` into an elapsed review clock, which is the
 * one direction this module must never fail in.
 */
export function daysBetween(from, to) {
  const start = parseDate(from)
  const end = parseDate(to)
  if (start === null || end === null) return null
  return Math.floor((end.getTime() - start.getTime()) / 86400000)
}

// ---------------------------------------------------------------------------
// the store
// ---------------------------------------------------------------------------

/**
 * Read the ledger.
 *
 * A HAND-EDITABLE FILE, SO NOTHING IS ASSUMED. Every field is reported as it is found and
 * a malformed document yields problems rather than an exception: a renderer that throws on
 * the state a user created is an opaque projection error, and the user learns nothing.
 * Entries that are not objects are KEPT in the array so they stay visible and countable;
 * `evaluateConstraint` reports them as defective.
 *
 * @param projectDir - the project root.
 * @returns `{ document, constraints, present, path, problems }`.
 */
export function readConstraints(projectDir) {
  const result = { document: emptyConstraints(), constraints: [], present: false, path: null, problems: [] }
  if (!projectDir) {
    result.problems.push('no project directory could be resolved, so the constraint ledger could not be read')
    return result
  }

  const path = join(projectDir, CONSTRAINTS_RELATIVE_PATH)
  result.path = path
  if (!existsSync(path)) return result

  result.present = true
  let parsed
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    result.problems.push(
      `could not read ${CONSTRAINTS_RELATIVE_PATH}: ${error?.message ?? error}. ` +
        'The ledger is left untouched rather than overwritten.',
    )
    return result
  }

  if (!isPlainObject(parsed)) {
    result.problems.push(
      `${CONSTRAINTS_RELATIVE_PATH} is ${describeValue(parsed)} (${Array.isArray(parsed) ? 'array' : typeof parsed}); ` +
        'expected an object with a "constraints" array. Nothing is written to it.',
    )
    return result
  }

  result.document = parsed
  if (!Array.isArray(parsed.constraints)) {
    result.problems.push(
      `constraints is ${describeValue(parsed.constraints)} (${typeof parsed.constraints}); expected an array. ` +
        'No constraint is listed and no write would be safe, so the ledger is read-only until it is fixed.',
    )
    return result
  }

  result.constraints = parsed.constraints
  const nonObjects = parsed.constraints.filter(entry => !isPlainObject(entry)).length
  if (nonObjects > 0) {
    result.problems.push(
      `${nonObjects} entr${nonObjects === 1 ? 'y is' : 'ies are'} not an object; each is reported as defective.`,
    )
  }
  return result
}

/**
 * Write the ledger atomically, the way `.dsh/WORKFLOW.json` is written.
 *
 * A temp file plus a rename, so an interrupted write cannot leave a half-written ledger:
 * a truncated constraint file would silently drop guardrails, which is the one direction
 * this module must never fail in.
 *
 * @param projectDir - the project root.
 * @param document - the ledger document to persist.
 * @returns the path written.
 */
export function writeConstraints(projectDir, document) {
  const path = join(projectDir, CONSTRAINTS_RELATIVE_PATH)
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(document, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
  return path
}

/** The next free `C###` id, ignoring ids that do not follow the convention. */
export function nextConstraintId(constraints) {
  let highest = 0
  for (const entry of Array.isArray(constraints) ? constraints : []) {
    const match = typeof entry?.id === 'string' ? /^C(\d+)$/.exec(entry.id) : null
    if (match) highest = Math.max(highest, Number(match[1]))
  }
  return `C${String(highest + 1).padStart(3, '0')}`
}

// ---------------------------------------------------------------------------
// the single validator
// ---------------------------------------------------------------------------

/**
 * Validate a candidate constraint. THE one definition of a usable constraint.
 *
 * Nothing is coerced and nothing is defaulted away. In particular:
 *
 *  - `retire_when` is REQUIRED and must carry at least one usable condition. A constraint
 *    that can never retire is the failure mode the design is written against, so a
 *    candidate without a retirement condition is refused at the door instead of being
 *    written and reported as a defect later.
 *  - `added_at` and `status` are NOT readable from the candidate. A caller-supplied
 *    `added_at` would let a model backdate a constraint so its review clock has already
 *    elapsed — a write that widens what the framework will propose retiring.
 *  - unknown fields are refused, not dropped: a typo like `retireWhen` would otherwise be
 *    silently discarded and the constraint would be written with no retirement condition
 *    at all while looking complete.
 *
 * @param candidate - the proposed constraint.
 * @param options - `{ defaultForModel }` used when the caller omits `added_for_model`.
 * @returns `{ ok: true, value }` or `{ ok: false, problems }`.
 */
export function validateConstraintCandidate(candidate, options = {}) {
  const problems = []

  if (!isPlainObject(candidate)) {
    return {
      ok: false,
      problems: [
        `the candidate is ${describeValue(candidate)} (${Array.isArray(candidate) ? 'array' : typeof candidate}); ` +
          'expected an object with rule, why, added_for_model and retire_when.',
      ],
    }
  }

  for (const key of Object.keys(candidate)) {
    if (!CANDIDATE_FIELDS.includes(key)) {
      problems.push(
        `unknown field "${key}"; a candidate carries only ${CANDIDATE_FIELDS.join(', ')}. ` +
          'Unknown fields are refused rather than dropped, because a typo would otherwise ' +
          'silently produce a constraint with no retirement condition.',
      )
    }
  }

  const rule = nonEmptyString(candidate.rule)
  if (rule === null) {
    problems.push(`rule must be a non-empty string; got ${describeValue(candidate.rule)}.`)
  }

  const why = nonEmptyString(candidate.why)
  if (why === null) {
    problems.push(
      `why must be a non-empty string; got ${describeValue(candidate.why)}. ` +
        'Without the reason a constraint exists, no human can judge whether it may be retired.',
    )
  }

  const forModel = nonEmptyString(candidate.added_for_model) ?? nonEmptyString(options.defaultForModel)
  if (forModel === null) {
    problems.push(
      'added_for_model must be a non-empty string naming the model this constraint defends ' +
        'against, and it could not be inferred from the calling session. A constraint whose ' +
        'capability gap is unrecorded cannot be retired when that gap closes.',
    )
  }

  const retireWhen = validateRetireWhen(candidate.retire_when, problems)

  if (problems.length) return { ok: false, problems }

  return {
    ok: true,
    value: { rule, why, added_for_model: forModel, retire_when: retireWhen },
  }
}

/** Validate the `retire_when` section, pushing every problem it finds. */
function validateRetireWhen(retireWhen, problems) {
  if (!isPlainObject(retireWhen)) {
    problems.push(
      `retire_when must be an object; got ${describeValue(retireWhen)} (${typeof retireWhen}). ` +
        'It is REQUIRED: a constraint with no retirement condition can never retire, and that ' +
        'is the failure mode this ledger exists to prevent.',
    )
    return null
  }

  for (const key of Object.keys(retireWhen)) {
    if (!RETIRE_WHEN_FIELDS.includes(key)) {
      problems.push(
        `retire_when.${key} is not a known field; expected one of ${RETIRE_WHEN_FIELDS.join(', ')}.`,
      )
    }
  }

  const signal = retireWhen.signal === undefined ? null : nonEmptyString(retireWhen.signal)
  if (retireWhen.signal !== undefined && signal === null) {
    problems.push(
      `retire_when.signal must be a non-empty string when present; got ${describeValue(retireWhen.signal)}.`,
    )
  }

  let reviewAfter = null
  if (retireWhen.review_after_days !== undefined) {
    const value = retireWhen.review_after_days
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      problems.push(
        `retire_when.review_after_days must be a positive finite number of days; got ${describeValue(value)}. ` +
          'A value that merely coerces would make the review clock either never elapse or elapse immediately.',
      )
    } else {
      reviewAfter = value
    }
  }

  const observables = []
  if (retireWhen.observable !== undefined) {
    const list = Array.isArray(retireWhen.observable) ? retireWhen.observable : [retireWhen.observable]
    for (const observable of list) {
      const verdict = validateObservable(observable)
      if (verdict.ok) observables.push(verdict.value)
      else problems.push(...verdict.problems)
    }
  }

  if (signal === null && reviewAfter === null && observables.length === 0) {
    problems.push(
      'retire_when declares nothing usable: it has no signal, no review_after_days and no ' +
        'observable, so the constraint could never retire. Delete the key to use the defaults, ' +
        'or state at least one of the three.',
    )
  }

  return {
    ...(signal === null ? {} : { signal }),
    ...(reviewAfter === null ? {} : { review_after_days: reviewAfter }),
    ...(observables.length === 0 ? {} : { observable: observables }),
  }
}

/** Validate one `observable` entry against the closed vocabulary of real counters. */
function validateObservable(observable) {
  if (!isPlainObject(observable)) {
    return {
      ok: false,
      problems: [
        `retire_when.observable must be an object or an array of objects; got ${describeValue(observable)}.`,
      ],
    }
  }
  if (!OBSERVABLE_KINDS.includes(observable.kind)) {
    return {
      ok: false,
      problems: [
        `retire_when.observable.kind is ${describeValue(observable.kind)}; the framework only ` +
          `implements ${OBSERVABLE_KINDS.join(', ')} — counters over events it actually records. ` +
          'A kind it does not implement would be a signal the framework pretends to evaluate.',
      ],
    }
  }
  if (!PHASES.includes(observable.phase)) {
    return {
      ok: false,
      problems: [
        `retire_when.observable.phase is ${describeValue(observable.phase)}; expected one of ${PHASES.join(', ')}.`,
      ],
    }
  }
  const atLeast = observable.at_least
  if (!Number.isInteger(atLeast) || atLeast < 1) {
    return {
      ok: false,
      problems: [
        `retire_when.observable.at_least must be a whole number of 1 or more; got ${describeValue(atLeast)}.`,
      ],
    }
  }
  return { ok: true, value: { kind: observable.kind, phase: observable.phase, at_least: atLeast } }
}

// ---------------------------------------------------------------------------
// the confirmation token
// ---------------------------------------------------------------------------

/**
 * The brand only {@link confirmationFromAnswer} can stamp.
 *
 * WHY A SYMBOL AND NOT JUST FIELDS: a plain `{ source: 'user-question', approved: true,
 * questionId: 'q' }` is an object any in-process caller can write, so "a caller cannot supply
 * a confirmation" would have been a claim the code did not enforce. With the brand, only a
 * value that came out of a real answer to a real question is accepted. The tool path was
 * always safe — `runGc` mints the token itself — but an exported store function that can be
 * talked into writing a constraint by a hand-built object is a trap for the next caller.
 */
const CONFIRMATION = Symbol('dsh-workflow.constraint-confirmation')

/**
 * Turn a user-questions answer into the ONLY token {@link addConstraint} accepts.
 *
 * The token exists so that "the user agreed" cannot be asserted by a caller. It can only be
 * produced from an actual answer to an actual question, and only an explicit affirmative
 * option counts: a typed `custom` response is not treated as approval, because "the user
 * typed something" is not the same claim as "the user approved this text", and the wrong
 * direction here writes a constraint nobody agreed to.
 *
 * @param options - `{ answer, questionId, at, approveLabel }`.
 * @returns a confirmation token, or null when the answer cannot be read as approval.
 */
export function confirmationFromAnswer(options) {
  const { answer, questionId, at, approveLabel } = options ?? {}
  const items = Array.isArray(answer?.answers) ? answer.answers : null
  const item = items?.find(candidate => candidate?.id === questionId) ?? null
  const selected = Array.isArray(item?.selected) ? item.selected.filter(value => typeof value === 'string') : []
  return {
    [CONFIRMATION]: true,
    source: 'user-question',
    questionId: typeof questionId === 'string' ? questionId : null,
    answeredAt: toDate(at).toISOString(),
    approveLabel: typeof approveLabel === 'string' ? approveLabel : null,
    selected,
    custom: typeof item?.custom === 'string' ? item.custom : null,
    approved: approveLabel !== undefined && selected.includes(approveLabel),
  }
}

/** Whether a confirmation token authorises a write. Fail closed on every other shape. */
export function isConfirmed(confirmation) {
  return (
    isPlainObject(confirmation) &&
    confirmation[CONFIRMATION] === true &&
    confirmation.source === 'user-question' &&
    confirmation.approved === true &&
    typeof confirmation.questionId === 'string' &&
    confirmation.questionId !== ''
  )
}

/** The refusal every unconfirmed write shares. */
const UNCONFIRMED = {
  ok: false,
  status: 'not-confirmed',
  reason:
    'adding or retiring a constraint requires an answer from the user, and this call carries no ' +
    'confirmation that the framework itself obtained. A caller cannot supply one: the token is ' +
    'produced only from an answer to a question the framework asked. See workflow_gc.',
}

// ---------------------------------------------------------------------------
// the writes
// ---------------------------------------------------------------------------

/**
 * Append a confirmed candidate to the ledger.
 *
 * @param document - the parsed ledger document (unknown top-level keys are preserved).
 * @param candidate - the proposed constraint.
 * @param options - `{ confirmation, now, defaultForModel }`.
 * @returns `{ ok: true, document, constraint, path? }` or `{ ok: false, status, reason|problems }`.
 */
export function addConstraint(document, candidate, options = {}) {
  if (!isConfirmed(options.confirmation)) return { ...UNCONFIRMED }

  const validated = validateConstraintCandidate(candidate, { defaultForModel: options.defaultForModel })
  if (!validated.ok) return { ok: false, status: 'invalid-candidate', problems: validated.problems }

  const existing = Array.isArray(document?.constraints) ? document.constraints : []
  const duplicate = existing.find(
    entry => entry?.status !== 'retired' && nonEmptyString(entry?.rule) === validated.value.rule,
  )
  if (duplicate !== undefined) {
    return {
      ok: false,
      status: 'duplicate',
      reason:
        `an active constraint already carries this rule (${String(duplicate?.id ?? '?')}). ` +
        'Constraints are meant to shrink; add a distinct rule or retire the existing one deliberately.',
      existingId: typeof duplicate?.id === 'string' ? duplicate.id : null,
    }
  }

  const now = toDate(options.now)
  const constraint = {
    id: nextConstraintId(existing),
    rule: validated.value.rule,
    why: validated.value.why,
    // THE FRAMEWORK OWNS THIS DATE, deliberately. A caller-supplied `added_at` would let a
    // constraint be backdated so its `review_after_days` clock had already elapsed.
    added_at: now.toISOString().slice(0, 10),
    added_for_model: validated.value.added_for_model,
    retire_when: validated.value.retire_when,
    status: 'active',
    confirmed_by: 'user-question',
    confirmed_at: now.toISOString(),
  }

  return {
    ok: true,
    document: { ...document, constraints: [...existing, constraint] },
    constraint,
  }
}

/**
 * Mark a constraint retired. NEVER deletes it.
 *
 * Retiring lifts a guardrail, so it needs the same user confirmation as adding one, and the
 * entry stays in the file with its reason: the record of which constraints were needed and
 * when they stopped being needed is the evidence that the harness is shrinking for the right
 * reason rather than quietly being abandoned.
 *
 * @param document - the parsed ledger document.
 * @param id - the constraint id.
 * @param options - `{ confirmation, now, reason }`.
 * @returns `{ ok: true, document, constraint }` or a refusal.
 */
export function retireConstraint(document, id, options = {}) {
  if (!isConfirmed(options.confirmation)) return { ...UNCONFIRMED }

  const existing = Array.isArray(document?.constraints) ? document.constraints : []
  const wanted = nonEmptyString(id)
  if (wanted === null) {
    return { ok: false, status: 'bad-request', reason: 'retire requires the id of a constraint, e.g. "C007".' }
  }
  const index = existing.findIndex(entry => isPlainObject(entry) && entry.id === wanted)
  if (index === -1) {
    return {
      ok: false,
      status: 'unknown-constraint',
      reason: `no constraint ${JSON.stringify(wanted)} in ${CONSTRAINTS_RELATIVE_PATH}. Nothing was changed.`,
      known: existing.map(entry => (typeof entry?.id === 'string' ? entry.id : null)).filter(Boolean),
    }
  }
  const current = existing[index]
  if (current.status === 'retired') {
    return { ok: false, status: 'already-retired', reason: `constraint ${JSON.stringify(wanted)} is already retired.` }
  }

  const now = toDate(options.now)
  const retired = {
    ...current,
    status: 'retired',
    retired_at: now.toISOString(),
    retired_reason: nonEmptyString(options.reason) ?? 'retired after a user-confirmed review',
    retired_by: 'user-question',
  }

  return {
    ok: true,
    document: { ...document, constraints: existing.map((entry, position) => (position === index ? retired : entry)) },
    constraint: retired,
  }
}

// ---------------------------------------------------------------------------
// the evaluation
// ---------------------------------------------------------------------------

/** The history window the phase counter can see, and whether it is full. */
export function historyWindow(state) {
  const history = Array.isArray(state?.history) ? state.history.filter(entry => isPlainObject(entry)) : []
  return { history, truncated: history.length >= HISTORY_CAP }
}

/**
 * Count real transitions INTO a phase, recorded since a date.
 *
 * A REAL COUNTER OVER REAL EVENTS. `.dsh/WORKFLOW.json` history is appended by `transition()`
 * on every phase move, and this counts entries whose `to` is the phase and whose `from` is a
 * DIFFERENT phase (a same-phase entry is a log line, not a move). Two limits are reported
 * rather than hidden: the window is capped by `HISTORY_CAP`, and the file is hand-editable.
 * When the window is full the count is a LOWER BOUND, which is why `truncated` is returned and
 * a below-threshold count from a full window is treated as unevaluable instead of as "not yet".
 *
 * A `since` that cannot be read yields `usable: false` with a zero count — never an open window.
 *
 * @param state - the parsed workflow state.
 * @param options - `{ phase, since }`.
 * @returns `{ count, considered, truncated, usable }`.
 */
export function countPhaseEntries(state, options = {}) {
  const { history, truncated } = historyWindow(state)
  // ANY non-null `since` IS A WINDOW; whether it is READABLE is `parseDate`'s call, not a type
  // test's. Testing `typeof options.since === 'string'` made a number/boolean/object window fall
  // through as "no window", i.e. count every retained entry under a window nobody read — the same
  // fail-open shape this function's contract forbids, moved from "unreadable string" to
  // "not-a-string". No production caller passes one, but the guarantee should not depend on that.
  const windowed = options.since !== undefined && options.since !== null
  // STRICT, NOT `Date.parse`: the lenient parser accepts prose such as "sometime in 2026", which
  // would turn the guard below into dead code and count every retained entry under a window
  // nobody could read. See parseDate for the measurements.
  const since = windowed ? parseDate(options.since) : null
  // A WINDOW THAT CANNOT BE READ IS NOT AN OPEN WINDOW. Counting every retained entry under an
  // unparseable `since` would make the threshold trivially satisfiable — which is how a
  // constraint with an unreadable added_at was once reported as provably due. An absent `since`
  // is different and deliberate: it means "no window", and the caller gets the whole window.
  if (windowed && since === null) return { count: 0, considered: 0, truncated, usable: false }

  let count = 0
  let considered = 0
  for (const entry of history) {
    // A SELF-ENTRY IS A LOG LINE, NOT A TRANSITION. `workflow_advance` appends
    // `{ from: 'PICK', to: 'PICK' }` when picking inside PICK, and
    // `{ from: phase, to: phase }` on every record-review. Counting those would let five log
    // lines satisfy a counter that was declared as "five BUILD phases".
    if (entry.to !== options.phase || entry.from === entry.to) continue
    const at = parseDate(entry.at)
    if (at === null) continue
    considered += 1
    if (since === null || at.getTime() >= since.getTime()) count += 1
  }
  return { count, considered, truncated, usable: true }
}

/** Evaluate one `observable` against the counters the framework actually has. */
function evaluateObservable(observable, context) {
  const name = `observable:${isPlainObject(observable) ? String(observable.kind) : 'unreadable'}`
  if (context.sinceUsable === false) {
    return {
      name,
      evaluated: false,
      satisfied: null,
      detail:
        'the window cannot be read: added_at is not a date, so no count measured from it would mean ' +
        'anything. The framework will not report this condition as met or unmet.',
    }
  }
  if (!isPlainObject(observable)) {
    return { name, evaluated: false, satisfied: null, detail: `the observable is ${describeValue(observable)}, not an object.` }
  }
  if (!OBSERVABLE_KINDS.includes(observable.kind)) {
    return {
      name,
      evaluated: false,
      satisfied: null,
      detail:
        `the framework does not implement observable kind ${describeValue(observable.kind)}, so it ` +
        'cannot evaluate this condition at all. It is surfaced for a human rather than reported as met.',
    }
  }
  if (!PHASES.includes(observable.phase) || !Number.isInteger(observable.at_least)) {
    return {
      name,
      evaluated: false,
      satisfied: null,
      detail: 'the observable is not shaped like a counter the framework can read (phase + at_least).',
    }
  }
  const counted = countPhaseEntries(context.state, { phase: observable.phase, since: context.since })
  if (counted.usable === false) {
    return {
      name,
      evaluated: false,
      satisfied: null,
      detail:
        `the window since ${context.since ?? '(unknown date)'} could not be read, so no count is ` +
        'meaningful. The framework will not report this condition as met or unmet.',
    }
  }
  const detail =
    `${counted.count} ${observable.phase} transition(s) recorded since ${context.since ?? '(no window: every retained entry)'} ` +
    `(retained history window: ${counted.considered} entry/entries)`
  if (counted.truncated && counted.count < observable.at_least) {
    return {
      name,
      evaluated: false,
      satisfied: null,
      detail:
        `${detail}; the history window is full, so earlier transitions may have been dropped and this ` +
        'count is only a lower bound. The framework will not report this condition as met or unmet.',
    }
  }
  return {
    name,
    evaluated: true,
    satisfied: counted.count >= observable.at_least,
    detail: `${detail}${counted.truncated ? '; the window is full, so the count is a lower bound' : ''}`,
    threshold: observable.at_least,
  }
}

/**
 * Evaluate ONE constraint's retirement condition.
 *
 * @param constraint - a raw entry from the ledger.
 * @param options - `{ now, state }`.
 * @returns an evaluation object: `{ id, rule, why, status, verdict, checks, signal, defects, problems, question }`.
 */
export function evaluateConstraint(constraint, options = {}) {
  const now = toDate(options.now)
  const state = options.state ?? null

  const base = {
    id: null,
    rule: null,
    why: null,
    status: null,
    addedAt: null,
    addedForModel: null,
    verdict: 'defective',
    checks: [],
    signal: null,
    unreadableSignal: null,
    signalEvaluated: false,
    defects: [],
    problems: [],
    question: null,
  }

  if (!isPlainObject(constraint)) {
    return {
      ...base,
      defects: [`this ledger entry is ${describeValue(constraint)} (${typeof constraint}), not an object.`],
    }
  }

  const id = nonEmptyString(constraint.id)
  const rule = nonEmptyString(constraint.rule) ?? (typeof constraint.rule === 'string' ? constraint.rule : null)
  const why = nonEmptyString(constraint.why) ?? (typeof constraint.why === 'string' ? constraint.why : null)
  // DERIVED BEFORE EVERY EARLY RETURN, DELIBERATELY.
  //
  // A result that leaves this function carrying `unreadableSignal: null` while the file declares a
  // signal makes the SAME false claim the round-1 review caught, through a different door: the
  // renderer prints "signal: (none declared)" and the retirement CONSENT PROMPT shows "(none)"
  // before asking a human to lift a guardrail. The early returns below (no usable id, `retired`,
  // an invalid status such as "Active") used to skip this derivation, because it lived further
  // down in the active-constraint path. Anything that leaves here must carry the truth about the
  // signal, whether or not its conditions were ever evaluated.
  const rawRetireWhen = isPlainObject(constraint.retire_when) ? constraint.retire_when : null
  const rawSignal = rawRetireWhen?.signal
  const unreadableSignal = rawSignal !== undefined && nonEmptyString(rawSignal) === null ? rawSignal : null
  const item = {
    ...base,
    id,
    rule,
    why,
    addedAt: nonEmptyString(constraint.added_at),
    addedForModel: nonEmptyString(constraint.added_for_model),
    unreadableSignal,
  }

  if (id === null) {
    // A hard defect, not a note: with no id the framework cannot reference the constraint,
    // cannot retire it, and cannot tell it apart from another entry. Fail closed rather than
    // evaluate a record nothing can ever act on.
    return {
      ...item,
      defects: [
        'the entry has no usable id, so it cannot be referenced or retired. Give it an id such as "C007".',
      ],
    }
  }
  if (item.addedForModel === null) {
    item.problems.push(
      'added_for_model is missing, so the capability gap this constraint defends against is unrecorded.',
    )
  }

  if (constraint.status === 'retired') {
    return { ...item, status: 'retired', verdict: 'retired' }
  }
  if (constraint.status !== 'active') {
    return {
      ...item,
      status: typeof constraint.status === 'string' ? constraint.status : null,
      verdict: 'defective',
      defects: [
        ...item.defects,
        `status is ${describeValue(constraint.status)}; expected one of ${CONSTRAINT_STATUSES.join(', ')}. ` +
          'An unknown lifecycle is not treated as active, because the framework cannot then say whether ' +
          'the constraint is in force.',
      ],
    }
  }

  if (!isPlainObject(constraint.retire_when)) {
    return {
      ...item,
      status: 'active',
      verdict: 'defective',
      defects: [
        ...item.defects,
        'there is no retire_when section, so this constraint can never retire by any signal. ' +
          'That is the failure mode this ledger exists to prevent: add a retirement condition, or ' +
          'retire it deliberately so the absence is a decision rather than an oversight.',
      ],
    }
  }

  const retireWhen = constraint.retire_when
  const checks = []
  // Declared conditions the framework was ASKED to evaluate, versus the ones it managed to.
  // The difference is what stops "the condition could not be read" from rendering as
  // "the condition is not met".
  const unevaluable = []
  const since = item.addedAt
  // STRICT, NOT `Date.parse`. The lenient parser reads prose as a date ("sometime in 2026" →
  // 2026-01-01), which made `sinceUsable` TRUE for an added_at that is not a date, and the
  // constraint was then reported provably due on a window nobody could read.
  const sinceDate = parseDate(since)
  const sinceMs = sinceDate === null ? Number.NaN : sinceDate.getTime()
  // THE WINDOW DATE IS CHECKED BEFORE EITHER CONDITION, NOT INSIDE THE CLOCK'S BRANCH.
  //
  // `review_after_days` measures elapsed time from `added_at`, and the phase counter measures
  // its window from `added_at` too, so an unreadable date makes BOTH unmeasurable. Checking it
  // only inside the clock branch meant an observable-only constraint skipped the check
  // entirely; the counter was then handed a NaN window (which counts every retained entry),
  // the threshold was met, and the constraint was reported PROVABLY DUE on a date the
  // framework could not read. That is precisely the false-premise failure this module exists
  // to prevent: it would lift a guardrail on the strength of a condition nobody evaluated.
  const sinceUsable = !Number.isNaN(sinceMs)

  let declared = 0
  if (retireWhen.review_after_days !== undefined) declared += 1
  const observables = retireWhen.observable === undefined
    ? []
    : Array.isArray(retireWhen.observable)
      ? retireWhen.observable
      : [retireWhen.observable]
  declared += observables.length

  if (declared > 0 && !sinceUsable) {
    unevaluable.push(
      `added_at is ${describeValue(constraint.added_at)}, which is not a date, so no declared ` +
        'condition can be measured from it. It is not treated as elapsed and not treated as ' +
        'satisfied: the framework reports the condition as unreadable instead of guessing.',
    )
  } else {
    if (retireWhen.review_after_days !== undefined) {
      const value = retireWhen.review_after_days
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        unevaluable.push(
          `retire_when.review_after_days is ${describeValue(value)}; a positive number is required, so this ` +
            'condition cannot be evaluated. It is not treated as elapsed.',
        )
      } else {
        const elapsed = daysBetween(since, now)
        checks.push({
          name: 'review_after_days',
          evaluated: true,
          satisfied: elapsed !== null && elapsed >= value,
          detail:
            `${elapsed} day(s) since added_at ${since}; the review was due after ${value}. ` +
            'This is a machine-checked schedule, not the constraint\'s free-text signal.',
          threshold: value,
        })
      }
    }
    for (const observable of observables) {
      checks.push(evaluateObservable(observable, { state, since, sinceUsable }))
    }
  }

  const signal = nonEmptyString(rawSignal)
  // A SIGNAL THE FRAMEWORK CANNOT READ IS NOT AN ABSENT SIGNAL.
  //
  // `retire_when.signal` is any JSON value in a hand-editable ledger. `nonEmptyString` returns
  // null for an array, a number, an object or a boolean, so collapsing those to null made the
  // constraint look as though it declared NO signal — and with every machine condition met that
  // is a `provably-due` verdict on a sentence nobody read (the ledger's own note said "no signal
  // at all", and the renderer printed "signal: (none declared)"). Same failure class as the
  // unreadable date, one field over: a declared condition that cannot be read must never be
  // silently dropped, or the entry retires a guardrail on a false premise.
  //
  // `unreadableSignal` itself is derived ABOVE, before the early returns; this only records it as
  // an unevaluable condition so the verdict below cannot be `provably-due`.
  if (unreadableSignal !== null) {
    unevaluable.push(
      `retire_when.signal is ${describeValue(unreadableSignal)}, which is not readable text, so the ` +
        'framework cannot treat this constraint as having no signal. It is reported as an unreadable ' +
        'signal rather than as an absent one, and it is not treated as satisfied.',
    )
  }

  if (declared === 0 && signal === null && unreadableSignal === null) {
    return {
      ...item,
      status: 'active',
      verdict: 'defective',
      defects: [
        ...item.defects,
        'retire_when declares no condition the framework can read and no signal at all, so this ' +
          'constraint can never retire.',
      ],
    }
  }

  const allEvaluated = checks.every(check => check.evaluated)
  const allSatisfied = checks.length > 0 && checks.every(check => check.evaluated && check.satisfied === true)
  const anyUnevaluated = checks.some(check => !check.evaluated)
  const anyUnreadable = unevaluable.length > 0

  let verdict
  if (signal === null && !anyUnreadable && allEvaluated && allSatisfied && item.problems.length === 0) {
    // THE ONLY PATH TO 'provably-due'. Every declared condition was computed from data the
    // framework records, every one holds, and nothing about this constraint is outstanding.
    verdict = 'provably-due'
  } else if (signal === null && anyUnreadable) {
    // A declared condition could not even be read. Saying "not due" here would be a claim the
    // framework cannot make, so it goes to a human with the reason attached.
    verdict = 'due-for-human-review'
  } else if (allSatisfied || (checks.length === 0 && signal !== null)) {
    // A CONDITION THE FRAMEWORK ACTUALLY EVALUATED IS DUE, and something else is not
    // machine-readable, so the human is asked about the rest — and never told the signal was met.
    //
    // This used to test `satisfiedAny`, which over-asked: a conjunction where the clock had
    // elapsed and an observable had NOT would land here even though every check was evaluated
    // and the bucket's own claim ("each one has a condition it did not evaluate") was then
    // false for it. `allSatisfied` keeps that bucket honest; a conjunction with a part unmet and
    // nothing unreadable falls through to `not-due`, which is what a conjunction means.
    verdict = 'due-for-human-review'
  } else if (anyUnevaluated) {
    // The declared condition cannot be evaluated at all. Routing it to a human is the only
    // honest answer: silence here would look like "not due".
    verdict = 'due-for-human-review'
  } else {
    verdict = 'not-due'
  }

  const result = {
    ...item,
    status: 'active',
    verdict,
    checks,
    signal,
    unreadableSignal,
    signalEvaluated: false,
    unevaluable,
    ageDays: Number.isNaN(sinceMs) ? null : daysBetween(since, now),
  }

  if (verdict === 'due-for-human-review') {
    result.question = buildRetirementQuestion(result)
  } else if (verdict === 'not-due' && (signal !== null || anyUnevaluated)) {
    result.note =
      'NOT DUE is a statement about the machine-checked condition(s) only. ' +
      (signal !== null
        ? `The free-text signal "${signal}" CANNOT be evaluated by the ` +
          'framework, so this is not a claim that the signal is unmet.'
        : 'Part of the declared condition could not be evaluated, so the framework cannot tell.') +
      ' ' +
      (checks.length === 0
        ? 'No condition was machine-checked at all.'
        : `Checked: ${checks
            .map(check => `${check.name} ${check.evaluated ? (check.satisfied ? 'currently met' : 'not yet met') : 'not evaluable'}`)
            .join('; ')}.`)
  }
  if (verdict === 'provably-due') {
    result.note =
      'Every declared condition was evaluated by the framework and currently holds: ' +
      `${checks.map(check => `${check.name} (${check.detail})`).join('; ')}. ` +
      'This is a suggestion only — the framework never retires anything by itself.'
  }

  return result
}

/**
 * How a retirement signal is shown to a human — the ONE place that decides.
 *
 * A signal the framework could not read must not be displayed as `(none)`: that is the same
 * false claim as reporting it evaluated, one layer out — the human consent prompt would ask about
 * a constraint whose signal was never shown. Both the scan's question and the tool's retire
 * question render through here, so the two cannot disagree.
 *
 * BOTH SHAPES ARE ACCEPTED, on purpose: an EVALUATION carries `signal`/`unreadableSignal`, while a
 * RAW ledger entry carries only `retire_when.signal`. Reading one shape and advertising the other
 * is how this function would silently return `(none)` for a caller that passed the other.
 *
 * @param item - an evaluation, or a raw ledger entry.
 * @returns the text to display for the signal.
 */
export function signalForDisplay(item) {
  const readable =
    typeof item?.signal === 'string' && item.signal.trim() !== ''
      ? item.signal
      : nonEmptyString(item?.retire_when?.signal)
  if (readable !== null) return readable
  const unreadable =
    item?.unreadableSignal !== undefined && item?.unreadableSignal !== null
      ? item.unreadableSignal
      : item?.retire_when?.signal !== undefined && item?.retire_when?.signal !== null
        ? item.retire_when.signal
        : null
  if (unreadable !== null) {
    return (
      `UNREADABLE — declared as ${describeValue(unreadable)} but not readable text; the framework ` +
      'could not interpret it, so it was not evaluated'
    )
  }
  return '(none)'
}

/** The question a free-text signal becomes. Carries the `why`, and says what it cannot do. */
export function buildRetirementQuestion(item) {
  const lines = [
    `Should constraint ${item.id ?? '(no id)'} be retired?`,
    '',
    `rule: ${item.rule ?? '(no rule recorded)'}`,
    `why it exists: ${item.why ?? '(no reason recorded)'}`,
    `retirement signal (free text, NOT evaluated by the framework): ${signalForDisplay(item)}`,
  ]
  if (Array.isArray(item.checks) && item.checks.length > 0) {
    lines.push('what the framework could check:')
    for (const check of item.checks) {
      lines.push(
        `  - ${check.name}: ${check.evaluated ? (check.satisfied ? 'currently met' : 'not yet met') : 'could not be evaluated'} — ${check.detail}`,
      )
    }
  }
  lines.push(
    '',
    'The framework CANNOT confirm the signal above; a constraint exists to prevent a failure that ' +
      'has not happened yet, so a machine removing it on an unevaluated signal would be worse than ' +
      'never retiring it. If the gap has closed, retire it with workflow_gc action=retire — that asks ' +
      'you again before anything is written. If it has not, keep it.',
  )
  return lines.join('\n')
}

/**
 * Evaluate every constraint in the ledger and sort them into the report's buckets.
 *
 * Every entry lands in exactly ONE bucket. `provablyDue`, `dueForHumanReview` and `notDue`
 * are the three release verdicts and are mutually exclusive; `defective` (it can never
 * retire as recorded) and `retired` are reported separately and are NEVER counted as due.
 *
 * @param constraints - the raw ledger entries.
 * @param options - `{ now, state }`.
 * @returns `{ evaluations, provablyDue, dueForHumanReview, notDue, defective, retired, counts }`.
 */
export function evaluateConstraints(constraints = [], options = {}) {
  const list = Array.isArray(constraints) ? constraints : []
  const evaluations = list.map(entry => evaluateConstraint(entry, options))
  const bucket = verdict => evaluations.filter(item => item.verdict === verdict)

  const buckets = {
    evaluations,
    provablyDue: bucket('provably-due'),
    dueForHumanReview: bucket('due-for-human-review'),
    notDue: bucket('not-due'),
    defective: bucket('defective'),
    retired: bucket('retired'),
  }

  return {
    ...buckets,
    counts: {
      total: evaluations.length,
      active: evaluations.filter(item => item.status === 'active').length,
      provablyDue: buckets.provablyDue.length,
      dueForHumanReview: buckets.dueForHumanReview.length,
      notDue: buckets.notDue.length,
      defective: buckets.defective.length,
      retired: buckets.retired.length,
    },
  }
}
