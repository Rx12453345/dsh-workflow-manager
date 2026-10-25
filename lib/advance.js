/**
 * The workflow state machine (`workflow_advance`).
 *
 * WHY A FRAMEWORK STATE MACHINE AND NOT A PROMPT
 * Every rule here is one a prompt could only *ask* for, and the whole point of this
 * plugin is that asking is not enforcement:
 *
 *  - a feature is only complete when an INDEPENDENT review passed it, so `passes: true`
 *    is written by the framework from a review result and is not a field a worker may set;
 *  - `description`/`steps` are frozen after planning, because a feature whose definition
 *    silently changes is not the feature that was reviewed;
 *  - the reviewed artefact is FINGERPRINTED, and any edit after approval invalidates it,
 *    so "review passed, then I changed three more things, then committed" cannot happen;
 *  - a session must run the project's sensors before starting new work, because a
 *    foundation broken by the previous round makes new work actively worse.
 *
 * THE ARCHITECTURE THIS EXISTS TO ENABLE
 * The whole loop is meant to run INSIDE a delegated child agent: the main model delegates
 * once, the child drives PLAN → … → COMMIT and calls `workflow_review` itself, and the
 * main conversation receives only the outcome. That is why the review round-trips are
 * modelled as ordinary phases here rather than as something the top-level model
 * orchestrates — see `subagent.maxDepth`, which must be >= 2 for that shape to be legal.
 *
 * @module src-12453345_-dsh-workflow/advance
 */

import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import {
  DEFAULT_FEATURES_RELATIVE_PATH,
  DEFAULT_WORKFLOW_STATE_RELATIVE_PATH,
  workUnitStatePaths,
} from './work-unit.js'

/**
 * Where the machine keeps its state, relative to the project root.
 *
 * This is the DEFAULT (no work unit) layout and it is unchanged. A work unit's state
 * lives at `.dsh/work/<id>/WORKFLOW.json` + `FEATURES.json`; see `lib/work-unit.js` for
 * the resolution and for the path-traversal defences behind it.
 */
export const WORKFLOW_STATE_RELATIVE_PATH = DEFAULT_WORKFLOW_STATE_RELATIVE_PATH
export const FEATURES_RELATIVE_PATH = DEFAULT_FEATURES_RELATIVE_PATH

/** The phases, in the order they normally run. */
export const PHASES = Object.freeze([
  'INIT',
  'PLAN',
  'PICK',
  'NEGOTIATE',
  'BUILD',
  'VERIFY',
  'EVALUATE',
  'COMMIT',
  'HANDOFF',
])

/**
 * Legal successors for each phase.
 *
 * `EVALUATE` may return to `BUILD` (the review failed) or advance to `COMMIT`. `VERIFY`
 * returns to `BUILD` on a sensor failure, which is deliberately NOT a route through
 * EVALUATE: a computational sensor failing needs no reviewer, and spending one would
 * waste a child on something a command already answered.
 *
 * `PICK` may return to `PLAN`. Without that edge the feature list could only ever be
 * written once: `PICK` is an intermediate state, so `PICK -> PLAN` is the only way back,
 * and a plan that cannot be amended when work reveals a missing feature is not a plan a
 * real project can use. Re-planning is safe because any transition except to `COMMIT`
 * clears the recorded review, so an amended definition can never ride on an approval
 * granted to the previous one.
 */
export const TRANSITIONS = Object.freeze({
  // THE ARRAYS ARE FROZEN TOO. `Object.freeze` on the object is shallow: it stopped a phase
  // being re-pointed but left every successor list mutable, so any caller that received one
  // (they used to be handed out directly) could push a phase into the graph. The graph is now
  // immutable all the way down; a per-call extension is `allowedTransitions`.
  INIT: Object.freeze(['PLAN', 'PICK']),
  PLAN: Object.freeze(['PICK']),
  PICK: Object.freeze(['NEGOTIATE', 'BUILD', 'PLAN']),
  NEGOTIATE: Object.freeze(['BUILD']),
  BUILD: Object.freeze(['VERIFY']),
  VERIFY: Object.freeze(['EVALUATE', 'COMMIT', 'BUILD']),
  EVALUATE: Object.freeze(['COMMIT', 'BUILD']),
  COMMIT: Object.freeze(['PICK', 'HANDOFF']),
  HANDOFF: Object.freeze([]),
})

/**
 * The per-recipe fast lanes, and the ONLY edges they add.
 *
 * A recipe is a topology, not a permission: it may make one SENSOR phase unnecessary. `recipe:
 * docs` is a documentation/chore change whose sensors would tell the reader nothing the unit
 * suite does not already say, so BUILD may go straight to EVALUATE and VERIFY is skipped. THAT
 * IS THE ONLY EDGE IT ADDS: no recipe gains a `BUILD -> COMMIT` edge. The review is what marks a
 * feature complete, not what gates COMMIT — `VERIFY -> COMMIT` is a legal sensor route — so a
 * fast-lane comment must not claim the machine cannot commit without a review.
 *
 * WHY THIS IS A TABLE AND NOT A CONDITION. `TRANSITIONS` above is the immutable graph and is
 * what every non-recipe decision still reads; a second, frozen table keeps the exception
 * visible, reviewable in one place, and testable against the invariant "no recipe adds a
 * `BUILD -> COMMIT` edge". A condition in the middle of `transition()` would be invisible
 * from the graph, which is precisely how a fast lane turns into a bypass.
 */
export const RECIPE_TRANSITIONS = Object.freeze({
  docs: Object.freeze({
    BUILD: Object.freeze(['EVALUATE']),
  }),
})

/**
 * Legal successors for a phase, for ONE call.
 *
 * `TRANSITIONS` stays the immutable project graph; this returns a fresh array and never
 * mutates either table. An unrecognised or malformed recipe therefore gets exactly the
 * pre-existing graph, which is the only fail-safe reading of a value the schema did not
 * accept: a typo must not widen the machine.
 *
 * @param from - current phase.
 * @param options - `{ recipe }`, or a recipe string.
 * @returns an array of legal target phases (possibly empty for a terminal phase).
 */
export function allowedTransitions(from, options = {}) {
  const base = TRANSITIONS[from] ?? []
  const recipe = typeof options === 'string' ? options : options?.recipe
  // EXACT MATCH ONLY. `Docs`, `docs ` and `documentation` are not the recipe; the schema
  // rejects them and this resolver must agree with it rather than guess.
  const extra = typeof recipe === 'string' ? RECIPE_TRANSITIONS[recipe]?.[from] : undefined
  const out = [...base]
  if (!Array.isArray(extra)) return out
  for (const to of extra) if (PHASES.includes(to) && !out.includes(to)) out.push(to)
  return out
}

/** The phase each role owns, for the permission table. */
export const PHASE_ROLE = Object.freeze({
  INIT: 'initializer',
  PLAN: 'planner',
  PICK: 'framework',
  NEGOTIATE: 'generator+evaluator',
  BUILD: 'generator',
  VERIFY: 'verifier',
  EVALUATE: 'evaluator',
  COMMIT: 'framework',
  HANDOFF: 'framework',
})

/**
 * Which role may change which feature field.
 *
 * This is the structural half of "only mark a feature complete after verification". A
 * prompt telling a worker not to set `passes` is a request; this table is a rule, and
 * `checkFeatureMutation` enforces it.
 */
export const FIELD_WRITERS = Object.freeze({
  passes: 'evaluator',
  evidence: 'verifier',
  description: 'planner',
  steps: 'planner',
  acceptance_id: 'planner',
  attempts: 'framework',
  blocked_reason: 'framework',
})

/** Fields frozen once planning ends — changing them changes what was reviewed. */
export const FROZEN_AFTER_PLAN = Object.freeze(['description', 'steps', 'acceptance_id'])

const DEFAULT_STATE = {
  schema_version: 1,
  phase: 'INIT',
  feature_id: null,
  round: 0,
  history: [],
  // HANDOFF waivers. Absent from older files, so every reader treats a missing (or malformed)
  // value as "no waiver was ever granted" — see `readState`.
  waivers: [],
  acceptance: null,
  review: null,
  reviewed_fingerprint: null,
  bootstrapped: false,
  bootstrap: null,
  started_at: null,
  updated_at: null,
}

/**
 * How many history entries the state file keeps.
 *
 * Exported because the constraint ledger COUNTS phase entries in this window to evaluate a
 * machine-readable retirement signal, and a counter that hardcoded its own bound would
 * silently disagree with the writer the first time this changes. It is also why a count from
 * a full window is reported as a lower bound rather than as a total.
 */
export const HISTORY_CAP = 200

/** An empty features file. */
export function emptyFeatures(sourceRequest = '') {
  return {
    schema_version: 1,
    generated_at: new Date().toISOString(),
    source_request: sourceRequest,
    features: [],
    notes:
      'The framework enforces field writership: passes is written only from an evaluator ' +
      'PASS, description/steps only during planning. Do not hand-edit this file.',
  }
}

// ---------------------------------------------------------------------------
// state transitions
// ---------------------------------------------------------------------------

/**
 * Whether a transition is legal.
 *
 * With no options this is the strict {@link TRANSITIONS} graph, unchanged for every existing
 * caller. `options.recipe` adds that recipe's fast-lane edges via
 * {@link allowedTransitions}, so the graph itself stays immutable and the exception is
 * opt-in per call.
 *
 * @param from - current phase.
 * @param to - requested phase.
 * @param options - `{ recipe }`; omitted means the plain graph.
 * @returns true when the edge is legal for this call.
 */
export function canTransition(from, to, options = {}) {
  return allowedTransitions(from, options).includes(to)
}

/**
 * Attempt a transition.
 *
 * @param state - the current state.
 * @param to - requested phase.
 * @param options - `{ reason, recipe }`. `recipe` selects a fast lane for this call only.
 * @returns `{ ok: true, state }` or `{ ok: false, error, allowed }`.
 */
export function transition(state, to, options = {}) {
  const from = state.phase
  const allowed = allowedTransitions(from, options)
  if (!PHASES.includes(to)) {
    return { ok: false, error: `unknown phase "${String(to)}"`, allowed }
  }
  if (from === to) {
    return { ok: false, error: `already in ${to}`, allowed }
  }
  if (!allowed.includes(to)) {
    return {
      ok: false,
      error: `cannot go from ${from} to ${to}`,
      allowed,
    }
  }

  const now = new Date().toISOString()
  // Mark a fast-lane edge in the history. Auditing "why did this skip VERIFY" must not depend
  // on the caller describing it in `reason`, because `reason` is free text the caller writes.
  const baseAllowed = TRANSITIONS[from] ?? []
  const fastLane =
    !baseAllowed.includes(to) && typeof options.recipe === 'string' && options.recipe !== ''
      ? options.recipe
      : null
  const entry = {
    at: now,
    from,
    to,
    ...(fastLane === null ? {} : { recipe: fastLane }),
    ...(options.reason ? { reason: options.reason } : {}),
  }
  return {
    ok: true,
    state: {
      ...state,
      phase: to,
      updated_at: now,
      // A review authorizes exactly the COMMIT that follows it; moving anywhere else means
      // the work is being changed again, so the approval no longer covers the artefact.
      ...to === 'COMMIT' ? {} : { review: null, reviewed_fingerprint: null },
      history: [...state.history, entry].slice(-HISTORY_CAP),
    },
  }
}

/**
 * The feature the machine should work on: highest priority among unfinished ones.
 *
 * @param features - the parsed features document.
 * @returns the selected feature, or undefined.
 */
export function pickNextFeature(features) {
  const open = (features?.features ?? []).filter(feature => feature?.passes !== true)
  if (open.length === 0) return undefined
  return open.reduce((best, candidate) => {
    const a = Number.isFinite(candidate?.priority) ? candidate.priority : Number.MAX_SAFE_INTEGER
    const b = Number.isFinite(best?.priority) ? best.priority : Number.MAX_SAFE_INTEGER
    return a < b ? candidate : best
  })
}

/** Summary counts for a features document. */
export function featureCounts(features) {
  const all = features?.features ?? []
  const done = all.filter(feature => feature?.passes === true).length
  return { total: all.length, done, open: all.length - done }
}

/**
 * How many open features a report lists before it says "and N more".
 *
 * FEATURES.json is hand-editable, so the list can be arbitrarily long; a status call that
 * echoed thousands of rows would be a report nobody reads. The COUNT is always exact, and
 * the list says when it is a prefix rather than silently looking complete.
 */
export const OPEN_FEATURE_LIST_CAP = 100

/**
 * The unfinished features as `{ id, description }` rows, for status and for the HANDOFF gate.
 *
 * A row is OPEN exactly when `passes !== true` — the same rule `pickNextFeature` uses, so the
 * reported list and the feature the machine would pick can never disagree. Nothing here
 * throws: a non-object entry, a non-string id or description, and a huge description all
 * degrade to a usable row, because a malformed file must produce a diagnostic rather than an
 * exception that costs the caller the whole report.
 *
 * @param features - the parsed FEATURES.json document (or anything).
 * @param cap - maximum rows to return; defaults to {@link OPEN_FEATURE_LIST_CAP}.
 * @returns `{ rows, total, truncated }`.
 */
export function openFeatureList(features, cap = OPEN_FEATURE_LIST_CAP) {
  const all = Array.isArray(features?.features) ? features.features : []
  const rows = []
  for (const feature of all) {
    if (feature?.passes === true) continue
    rows.push({
      // BOTH FIELDS ARE BOUNDED. FEATURES.json is hand-editable, and this list is embedded in a
      // status payload and in refusal reasons; one enormous description must not turn a report
      // into a megabyte, and the row still names the feature.
      id:
        typeof feature?.id === 'string' && feature.id !== ''
          ? feature.id.slice(0, 200)
          : '(no id)',
      description: typeof feature?.description === 'string' ? feature.description.slice(0, 300) : '',
    })
  }
  const limit = Number.isInteger(cap) && cap > 0 ? cap : OPEN_FEATURE_LIST_CAP
  return { rows: rows.slice(0, limit), total: rows.length, truncated: rows.length > limit }
}

// ---------------------------------------------------------------------------
// the write-permission rule
// ---------------------------------------------------------------------------

/**
 * Decide whether a role may change a feature field.
 *
 * This is the structural replacement for the prompt "do not mark your own work complete".
 * A worker that tries to set `passes` is refused by the framework, whatever it believes
 * about the quality of its own output.
 *
 * @param field - the field name.
 * @param role - the acting role.
 * @returns `{ ok: true }` or `{ ok: false, reason }`.
 */
export function checkFeatureMutation(field, role) {
  const owner = FIELD_WRITERS[field]
  if (owner === undefined) {
    return { ok: true } // an unlisted field is not part of the contract
  }
  if (owner !== role) {
    return {
      ok: false,
      reason:
        `"${field}" may only be written by the ${owner}; this call is acting as the ${role}. ` +
        (field === 'passes'
          ? 'A feature is marked complete by the FRAMEWORK when an independent review passes it — ' +
            'not by the agent that wrote it.'
          : field === 'evidence'
            ? 'Evidence is recorded by the verifier, from a sensor that actually ran.'
            : 'A feature definition is frozen after planning, because changing it changes what was reviewed.'),
    }
  }
  return { ok: true }
}

/**
 * Compare two feature definitions and report forbidden changes.
 *
 * The rule is ROLE-based, matching the design: `description`/`steps`/`acceptance_id` may be
 * written by the planner, and a change by anyone else is a violation. It is not an absolute
 * freeze, because re-entering PLAN is a legitimate way to redefine the work — and that is
 * safe precisely because entering a phase other than COMMIT clears the recorded review, so
 * a redefinition can never be covered by an approval granted to the earlier definition.
 * (The fingerprint check in `applyReviewOutcome` is the second half of that guarantee.)
 *
 * @param before - the earlier features document.
 * @param after - the proposed one.
 * @param role - the acting role.
 * @returns `{ ok: true }` or `{ ok: false, violations }`.
 */
export function checkFeatureDiff(before, after, role) {
  const violations = []
  const beforeById = new Map((before?.features ?? []).map(feature => [feature?.id, feature]))
  // The planner owns the definitions; everyone else may only move progress fields.
  const mayDefine = role === 'planner' || role === 'initializer'

  for (const feature of after?.features ?? []) {
    const original = beforeById.get(feature?.id)
    if (original === undefined) {
      // Adding a feature is a planning act, not a mid-build one.
      if (!mayDefine) {
        violations.push({
          field: 'features[]',
          reason: `feature "${String(feature?.id)}" was added outside planning`,
        })
      }
      continue
    }
    if (!mayDefine) {
      for (const field of FROZEN_AFTER_PLAN) {
        if (JSON.stringify(original[field]) !== JSON.stringify(feature[field])) {
          violations.push({
            field,
            id: feature?.id,
            reason:
              `feature "${String(feature?.id)}" changed its ${field} outside planning, so it is no ` +
              'longer the feature that was reviewed',
          })
        }
      }
    }
    if (original.passes !== feature.passes && role !== 'evaluator' && role !== 'framework') {
      violations.push({
        field: 'passes',
        id: feature?.id,
        reason:
          `feature "${String(feature?.id)}" had its passes flag changed by the ${role}; ` +
          'only the framework may do that, from an evaluator PASS',
      })
    }
  }

  const afterIds = new Set((after?.features ?? []).map(feature => feature?.id))
  for (const feature of before?.features ?? []) {
    if (!afterIds.has(feature?.id)) {
      violations.push({
        field: 'features[]',
        reason: `feature "${String(feature?.id)}" was deleted; features are never removed, only marked complete`,
      })
    }
  }

  return violations.length === 0 ? { ok: true } : { ok: false, violations }
}

// ---------------------------------------------------------------------------
// persistence
// ---------------------------------------------------------------------------

/**
 * Read the state file.
 *
 * `workUnit` is optional. ABSENT it reads the project-level `.dsh/WORKFLOW.json` exactly
 * as before. PRESENT it reads that unit's own file. An unusable work unit is NOT defaulted
 * to the project file — that would let a caller believe it was driving its own unit while
 * silently reading and writing the parent's.
 *
 * @param projectDir - the project root.
 * @param workUnit - the optional work-unit id.
 * @returns `{ state, present, path, problems, refused? }`.
 */
export function readState(projectDir, workUnit) {
  const target = workUnitStatePaths(projectDir, workUnit)
  if (target.ok !== true) {
    return {
      state: { ...DEFAULT_STATE },
      present: false,
      path: null,
      problems: [target.error],
      refused: true,
    }
  }
  const path = target.workflowPath
  if (!existsSync(path)) return { state: { ...DEFAULT_STATE }, present: false, path, problems: [] }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    // An unknown phase is a real problem: the machine would have no legal moves, and
    // silently coercing it to INIT would discard work.
    const problems = PHASES.includes(parsed?.phase) ? [] : [`unknown phase "${String(parsed?.phase)}"`]
    return {
      state: {
        ...DEFAULT_STATE,
        ...parsed,
        history: Array.isArray(parsed?.history) ? parsed.history : [],
        // A HAND-EDITED `waivers` VALUE IS NOT A WAIVER LIST. Only an array is kept; anything
        // else is dropped, so a malformed value can never be mistaken for a recorded waiver
        // (the audit direction that matters: never invent consent).
        waivers: Array.isArray(parsed?.waivers) ? parsed.waivers : [],
      },
      present: true,
      path,
      problems,
    }
  } catch (error) {
    return { state: { ...DEFAULT_STATE }, present: true, path, problems: [`unreadable: ${error?.message ?? error}`] }
  }
}

/**
 * Write the state file atomically, so an interrupted write cannot corrupt it.
 *
 * An unusable work unit THROWS. Writing is the point at which a bad id would become a
 * real path traversal, and silently falling back to the project file would be the worst
 * of both worlds — a refusal is the only safe answer. Callers that accept a work unit
 * from a model validate it before reaching here (see `resolveWorkUnitArgument` in
 * `lib/tools.js`); this throw is the last line of defence.
 *
 * @param projectDir - the project root.
 * @param state - the state to persist.
 * @param workUnit - the optional work-unit id.
 * @returns the path written.
 */
export function writeState(projectDir, state, workUnit) {
  const target = workUnitStatePaths(projectDir, workUnit)
  if (target.ok !== true) throw new Error(target.error)
  const path = target.workflowPath
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
  return path
}

/**
 * Read the features file.
 *
 * @param projectDir - the project root.
 * @param workUnit - the optional work-unit id.
 * @returns `{ features, present, path, problems, refused? }`.
 */
export function readFeatures(projectDir, workUnit) {
  const target = workUnitStatePaths(projectDir, workUnit)
  if (target.ok !== true) {
    return {
      features: emptyFeatures(),
      present: false,
      path: null,
      problems: [target.error],
      refused: true,
    }
  }
  const path = target.featuresPath
  if (!existsSync(path)) return { features: emptyFeatures(), present: false, path, problems: [] }
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (!Array.isArray(parsed?.features)) {
      return { features: emptyFeatures(), present: true, path, problems: ['features is not an array'] }
    }
    const missingIds = parsed.features.filter(feature => typeof feature?.id !== 'string').length
    return {
      features: parsed,
      present: true,
      path,
      problems: missingIds ? [`${missingIds} feature(s) have no string id`] : [],
    }
  } catch (error) {
    return {
      features: emptyFeatures(),
      present: true,
      path,
      problems: [`unreadable: ${error?.message ?? error}`],
    }
  }
}

/** Write the features file atomically. An unusable work unit throws, as in {@link writeState}. */
export function writeFeatures(projectDir, features, workUnit) {
  const target = workUnitStatePaths(projectDir, workUnit)
  if (target.ok !== true) throw new Error(target.error)
  const path = target.featuresPath
  mkdirSync(dirname(path), { recursive: true })
  const temporary = `${path}.tmp`
  writeFileSync(temporary, `${JSON.stringify(features, null, 2)}\n`, 'utf8')
  renameSync(temporary, path)
  return path
}

// ---------------------------------------------------------------------------
// the fingerprint that binds a review to the artefact it approved
// ---------------------------------------------------------------------------

/**
 * Hash a set of files so a review can be tied to exactly the state it reviewed.
 *
 * WITHOUT THIS THE GATE IS BYPASSABLE BY SEQUENCING: run the review, then make three more
 * edits, then commit. The review did pass — on something else. Recording a fingerprint at
 * approval and re-checking it at commit makes the approval authorise one artefact, not one
 * moment.
 *
 * `scope` is the WORK UNIT the approval belongs to, and it is folded into the digest. The
 * review store is already keyed by work unit, so this is a second, independent binding: a
 * verdict recorded for unit X can never be replayed for unit Y even if the store key were
 * wrong or a record were moved by hand. An empty scope (the default, and the only value the
 * absent-work-unit path ever passes) contributes nothing, so every pre-existing digest is
 * byte-identical.
 *
 * @param projectDir - the project root.
 * @param files - absolute or project-relative paths, plus `diff` text for tracked changes.
 * @param extra - extra text to fold in (e.g. a diff the caller already has).
 * @param scope - the work unit this digest is bound to; '' means the project-level scope.
 * @returns a hex digest.
 */
/**
 * The reviewed paths that could not be read at record time.
 *
 * `fingerprint` deliberately hashes an unreadable file as a constant so the digest still
 * changes (rather than treating the file as empty). That is correct for a fingerprint but
 * WRONG as evidence of a fresh review: if the file was already unreadable when the review
 * was recorded, the constant matches forever. The record-review writer stores this list and
 * `reviewFreshness` turns it into `unknown`, never `fresh`.
 *
 * @param projectDir - the project root.
 * @param files - the reviewed paths, as the evidence stores them.
 * @returns the paths that could not be read, in input order.
 */
export function unreadableReviewedFiles(projectDir, files = []) {
  const out = []
  for (const file of Array.isArray(files) ? files : []) {
    if (typeof file !== 'string' || file === '') continue
    try {
      readFileSync(resolve(projectDir, file))
    } catch {
      out.push(file)
    }
  }
  return out
}

/**
 * Hash a set of reviewed files (and an optional diff) into one digest.
 *
 * `files` may be project-relative or absolute; `resolve` normalises both. An unreadable file
 * still contributes a constant so the digest is not mistaken for an empty one — callers that
 * need "did a review actually cover a readable file" must use {@link unreadableReviewedFiles}.
 *
 * @param projectDir - the project root.
 * @param files - reviewed paths.
 * @param extra - extra text to fold in (the reviewed diff).
 * @param scope - the work-unit scope.
 * @returns a hex digest.
 */
export function fingerprint(projectDir, files = [], extra = '', scope = '') {
  const hash = createHash('sha256')
  if (scope !== undefined && scope !== null && String(scope) !== '') {
    hash.update('scope\0')
    hash.update(String(scope))
    hash.update('\0')
  }
  for (const file of [...files].sort()) {
    // RESOLVE, DO NOT PREFIX-MATCH. A caller may supply an absolute path with forward
    // slashes (`C:/repo/a.js`) or a drive-letter case different from projectDir. The old
    // `startsWith(projectDir)` check did not recognise either shape, `join`ed it into a
    // non-existent path, and hashed the CONSTANT `<unreadable:ENOENT>` — so a review stayed
    // FRESH after the file changed. `resolve` normalises both spellings on every platform.
    const path = resolve(projectDir, file)
    try {
      hash.update(file)
      hash.update('\0')
      hash.update(readFileSync(path))
      hash.update('\0')
    } catch (error) {
      // A file that cannot be read still has to affect the digest: treating it as empty
      // would make an unreadable file look like a stable one.
      hash.update(`<unreadable:${error?.code ?? 'error'}>`)
      hash.update('\0')
    }
  }
  if (extra) {
    hash.update('diff\0')
    hash.update(String(extra))
  }
  return hash.digest('hex')
}

// ---------------------------------------------------------------------------
// re-checkable review evidence
// ---------------------------------------------------------------------------

/**
 * Which evidence rows are review verdicts.
 *
 * The review writer has always stamped `type: "review"` on the row; a row without the type
 * is a sensor/experiment row and is not evidence that an independent review covered files.
 */
const REVIEW_EVIDENCE_TYPE = 'review'

/**
 * Recompute a review's file-only fingerprint and classify it against the files on disk now.
 *
 * WHY THIS IS NOT `applyReviewOutcome`'s CHECK. That check runs once, when
 * `workflow_advance action=record-review` consumes the in-memory verdict. A later session
 * only has FEATURES.json, so an edit made after the review was recorded was invisible to
 * `workflow_status` and to the COMMIT/HANDOFF transition — the stored digest was evidence
 * nobody ever re-evaluated. This helper turns the evidence into something recheckable: the
 * writer stores the reviewed file list, the file-only digest, the full digest and a hash of
 * the reviewed diff, and this recomputes only the file-only half against the files present
 * now.
 *
 * THE FILE-ONLY HALF IS THE RECHECKABLE HALF. The full digest folds in the reviewed diff,
 * which is not on disk afterwards; recomputing it would require replaying the exact diff.
 * The file digest is reproducible because the reviewed paths are stored verbatim and the
 * work unit is folded into the scope exactly as it was when the review was recorded.
 *
 * STATES ARE EXPLICIT, because a false FRESH is worse than no answer:
 *  - `fresh`   — every reviewed file still hashes to what was reviewed;
 *  - `stale`   — at least one reviewed file changed, disappeared, or became unreadable;
 *  - `unknown` — the evidence cannot be rechecked: legacy rows without `files_fingerprint`,
 *                a diff-only review with no file list, a malformed file set, or unreadable
 *                FEATURES data. This is never reported as fresh;
 *  - `none`    — no review evidence was recorded at all.
 *
 * `featureId` narrows the search to one feature (the selected one for status and COMMIT/
 * HANDOFF). Omitted, the LATEST review evidence across the document is used, which is what a
 * project-level status summary needs. The function never throws: FEATURES.json is
 * hand-editable, and a malformed row must degrade to `unknown`, not take down the status
 * report or the phase machine.
 *
 * @param projectDir - the project the review covered.
 * @param workUnit - the review's work unit; it is the fingerprint scope, as in {@link fingerprint}.
 * @param features - the parsed FEATURES.json document (or anything; malformed input degrades).
 * @param featureId - optional feature id to inspect; omitted means "latest anywhere".
 * @returns `{ state, featureId, at, reviewedFiles, reviewedFileFingerprint,
 *   currentFileFingerprint, reviewedFingerprint, reason }`.
 */
export function reviewFreshness(projectDir, workUnit, features, featureId = null) {
  const asked = typeof featureId === 'string' && featureId !== '' ? featureId : null
  const none = (reason, id = asked) => ({
    state: 'none',
    featureId: id,
    at: null,
    passed: null,
    reviewedFiles: [],
    reviewedFileFingerprint: null,
    currentFileFingerprint: null,
    reviewedFingerprint: null,
    reason,
  })
  const unknown = (reason, id = asked, row = null) => ({
    state: 'unknown',
    featureId: id,
    at: typeof row?.at === 'string' ? row.at : null,
    passed: typeof row?.passed === 'boolean' ? row.passed : null,
    reviewedFiles: Array.isArray(row?.files) ? row.files.filter(file => typeof file === 'string') : [],
    reviewedFileFingerprint:
      typeof row?.files_fingerprint === 'string' && row.files_fingerprint !== ''
        ? row.files_fingerprint
        : null,
    currentFileFingerprint: null,
    reviewedFingerprint:
      typeof row?.fingerprint === 'string' && row.fingerprint !== '' ? row.fingerprint : null,
    reason,
  })

  try {
    const list = Array.isArray(features?.features) ? features.features : []

    // One candidate per feature: its LAST `type: "review"` row. The evidence array is
    // append-ordered by the framework, so the last one is the verdict a later check should
    // judge. A malformed evidence container is kept as a candidate so a project-level search
    // can report `unknown` instead of quietly treating the feature as having no evidence.
    const candidates = []
    for (const feature of list) {
      if (feature === null || typeof feature !== 'object') continue
      const id = typeof feature.id === 'string' ? feature.id : null
      if (asked !== null && id !== asked) continue
      const evidence = feature.evidence
      if (evidence === undefined || evidence === null) continue
      if (!Array.isArray(evidence)) {
        candidates.push({ feature, id, row: null, malformed: 'the evidence field is not an array' })
        continue
      }
      let row = null
      for (const item of evidence) {
        if (item !== null && typeof item === 'object' && item.type === REVIEW_EVIDENCE_TYPE) row = item
      }
      if (row !== null) candidates.push({ feature, id, row, malformed: null })
    }

    if (candidates.length === 0) {
      return none(
        asked !== null
          ? 'no review evidence was recorded for the selected feature'
          : 'no feature has recorded review evidence',
      )
    }

    // Latest by the row's own ISO timestamp; a row without a usable time loses to one that
    // has it, and two rows with no usable time resolve by document order. Deterministic on
    // purpose: a summary that flips between calls would be worse than no summary.
    const rank = row => {
      const parsed = Date.parse(row?.at)
      return Number.isFinite(parsed) ? parsed : null
    }
    let chosen = candidates[0]
    for (const candidate of candidates.slice(1)) {
      const currentRank = rank(chosen.row)
      const candidateRank = rank(candidate.row)
      if (candidateRank !== null && (currentRank === null || candidateRank >= currentRank)) {
        chosen = candidate
      } else if (candidateRank === null && currentRank === null) {
        chosen = candidate
      }
    }

    const chosenId = asked ?? chosen.id ?? (typeof chosen.feature?.id === 'string' ? chosen.feature.id : null)
    if (chosen.malformed !== null) return unknown(chosen.malformed, chosenId, chosen.row)

    const row = chosen.row
    // A PATH THAT WAS ALREADY UNREADABLE AT REVIEW TIME IS NOT EVIDENCE. `fingerprint` hashes
    // it as a constant, so a later recheck would match forever; the writer records the list
    // and this check refuses to call that fresh.
    if (Array.isArray(row.unreadable_files) && row.unreadable_files.length > 0) {
      return unknown(
        `the review recorded unreadable file(s): ${row.unreadable_files.join(', ')}; ` +
          'a constant digest is not evidence that they are unchanged',
        chosenId,
        row,
      )
    }
    const files = row.files
    if (!Array.isArray(files) || files.length === 0) {
      return unknown(
        'no reviewed file list was recorded for this verdict, so a file-only recheck is ' +
          'impossible (a diff-only review cannot be re-evaluated from FEATURES.json)',
        chosenId,
        row,
      )
    }
    if (files.some(file => typeof file !== 'string' || file === '')) {
      return unknown('the recorded reviewed file list is malformed', chosenId, row)
    }
    const reviewed = row.files_fingerprint
    if (typeof reviewed !== 'string' || reviewed === '') {
      return unknown(
        'legacy review evidence has no file-only fingerprint, so it cannot be rechecked; ' +
          'it is not treated as fresh',
        chosenId,
        row,
      )
    }

    const current = fingerprint(projectDir, files, '', workUnit ?? '')
    const base = {
      featureId: chosenId,
      at: typeof row.at === 'string' ? row.at : null,
      // A fresh fingerprint is not the same fact as a PASS: a FAILED review is recorded
      // with the same evidence shape, and a reader must not mistake `fresh` for `passed`.
      passed: typeof row.passed === 'boolean' ? row.passed : null,
      reviewedFiles: [...files],
      reviewedFileFingerprint: reviewed,
      currentFileFingerprint: current,
      reviewedFingerprint:
        typeof row.fingerprint === 'string' && row.fingerprint !== '' ? row.fingerprint : null,
    }
    return current === reviewed
      ? {
          ...base,
          state: 'fresh',
          reason: `the ${files.length} reviewed file(s) are unchanged since the review was recorded`,
        }
      : {
          ...base,
          state: 'stale',
          reason:
            `the reviewed files changed after the review: the recorded file fingerprint is ` +
            `${reviewed}, the files on disk now hash to ${current}`,
        }
  } catch (error) {
    return unknown(`the review evidence could not be rechecked: ${error?.message ?? error}`)
  }
}

/**
 * Recheck every feature that has review evidence, not just the selected one.
 *
 * WHY THIS EXISTS. `reviewFreshness(..., featureId)` answers a per-feature question, and
 * the first version of the status/COMMIT gate asked it only about `state.feature_id`. In a
 * normal multi-feature run, editing feature A's reviewed file after A was committed left
 * `workflow_status` reporting "fresh" for the selected feature B and `workflow_advance
 * to=HANDOFF` succeeding. The delivered project then carried a review that no longer
 * covered its artefact. HANDOFF is a whole-project act, so it has to look at every
 * feature's latest review; the summary below is that view.
 *
 * A feature with no review evidence contributes nothing. The returned `state` is the worst
 * state among the reviewed features (`stale` > `unknown` > `fresh`), so a caller cannot
 * lose a stale feature by asking about the current one.
 *
 * @param projectDir - the project root.
 * @param workUnit - the work unit, or undefined for the project-level files.
 * @param features - the parsed FEATURES.json document.
 * @returns `{ state, counts, features, reason }`, never throws.
 */
export function reviewFreshnessAll(projectDir, workUnit, features) {
  try {
    const list = Array.isArray(features?.features) ? features.features : []
    const reviewed = []
    for (const feature of list) {
      const id = typeof feature?.id === 'string' && feature.id !== '' ? feature.id : null
      if (id === null) continue
      const result = reviewFreshness(projectDir, workUnit, features, id)
      if (result.state !== 'none') reviewed.push(result)
    }
    const counts = { fresh: 0, stale: 0, unknown: 0 }
    for (const result of reviewed) counts[result.state] = (counts[result.state] ?? 0) + 1
    const state =
      counts.stale > 0 ? 'stale' : counts.unknown > 0 ? 'unknown' : counts.fresh > 0 ? 'fresh' : 'none'
    return {
      state,
      counts,
      features: reviewed,
      reason:
        state === 'none'
          ? 'no feature has recorded review evidence'
          : `${counts.stale} stale, ${counts.unknown} unknown, ${counts.fresh} fresh reviewed feature(s)`,
    }
  } catch (error) {
    return {
      state: 'unknown',
      counts: { fresh: 0, stale: 0, unknown: 0 },
      features: [],
      reason: `the review evidence could not be rechecked: ${error?.message ?? error}`,
    }
  }
}

// ---------------------------------------------------------------------------
// phase actions
// ---------------------------------------------------------------------------

/**
 * Build the bootstrap checklist a session must satisfy before doing new work.
 *
 * Step 4 is the one that matters: Anthropic's practice is that an agent able to spot a
 * broken foundation will fix it, while an agent that starts a new feature on top of one
 * makes things worse. The framework therefore refuses to enter BUILD until sensors pass.
 *
 * @param options - project facts.
 * @returns the checklist and whether it is satisfied.
 */
export function buildBootstrap(options) {
  const { features, state, smokePassed, projectDir } = options
  const counts = featureCounts(features)

  const checklist = [
    {
      key: 'progress',
      done: state.history.length > 0,
      todo: 'Read the tail of .dsh/WORKFLOW.json history to see what the last session did.',
    },
    {
      key: 'features',
      done: counts.total > 0,
      todo: 'Populate FEATURES.json during PLAN before picking work.',
    },
    {
      key: 'open_feature',
      done: counts.open > 0,
      // THE TODO TEXT MUST AGREE WITH `done`. It used to be guarded by the TOTAL, so a project
      // with open features rendered `[x] open_feature: Every feature is already complete; move
      // to HANDOFF.` — a satisfied item whose instruction contradicted the report. The same
      // condition (`open > 0`) now drives both, and the two closed cases keep their own text.
      todo:
        counts.open > 0
          ? 'Pick the highest-priority open feature.'
          : counts.total > 0
            ? 'Every feature is already complete; move to HANDOFF.'
            : 'No features yet.',
    },
    {
      key: 'smoke',
      done: smokePassed === true,
      todo: 'Run the project sensors and confirm the foundation is intact. New features on a broken base make it worse.',
    },
  ]

  return {
    projectDir,
    phase: state.phase,
    counts,
    checklist,
    satisfied: checklist.every(item => item.done || item.key === 'open_feature'),
    blockedBy: checklist.filter(item => !item.done && item.key !== 'open_feature').map(item => item.key),
  }
}

/**
 * Apply an evaluator PASS/FAIL to the features document.
 *
 * The ONLY path that may set `passes: true`. A PASS records evidence and the fingerprint
 * the review covered; a FAIL increments attempts and records why.
 *
 * @param features - the features document.
 * @param options - `{ featureId, passed, expectedFingerprint, currentFingerprint, evidence, reason }`.
 * @returns `{ ok: true, features }` or `{ ok: false, error }`.
 */
export function applyReviewOutcome(features, options) {
  const { featureId, passed, expectedFingerprint, currentFingerprint, evidence = [], reason = '' } = options

  const index = (features?.features ?? []).findIndex(feature => feature?.id === featureId)
  if (index === -1) {
    return { ok: false, error: `no feature "${String(featureId)}" in FEATURES.json` }
  }

  // The artefact must be the one that was reviewed.
  if (passed && expectedFingerprint !== undefined && expectedFingerprint !== currentFingerprint) {
    return {
      ok: false,
      error:
        'this PASS does not cover the current artefact: the files that were reviewed are not the ' +
        'files on disk now. If the code was edited after the review, revert the edit or re-run ' +
        'workflow_review and record that verdict. (Note: the reviewed file list and diff are ' +
        'recorded with the review, so this is a real difference in content, not a bookkeeping one.)',
    }
  }

  const feature = features.features[index]
  const next = {
    ...feature,
    passes: passed === true,
    attempts: (Number.isFinite(feature.attempts) ? feature.attempts : 0) + (passed ? 0 : 1),
    evidence: [...(feature.evidence ?? []), ...evidence],
    blocked_reason: passed ? null : String(reason || 'the independent review did not pass'),
  }

  return {
    ok: true,
    features: {
      ...features,
      features: features.features.map((candidate, position) => (position === index ? next : candidate)),
    },
    feature: next,
  }
}

/**
 * The one-line status a phase reports, for the model and for the log.
 *
 * `options.recipe` is passed to {@link allowedTransitions}, so the "next allowed" line states
 * the moves THIS project actually has. Printing the plain graph while `transition()` accepted a
 * recipe edge (or the reverse) is the kind of mismatch that teaches a reader to distrust the
 * report — the fast lane would then be discoverable only by trying it.
 *
 * @param state - the current workflow state.
 * @param features - the parsed features document.
 * @param options - `{ recipe }`.
 * @returns a short human-readable line.
 */
export function describeAdvance(state, features, options = {}) {
  const counts = featureCounts(features)
  const current = (features?.features ?? []).find(feature => feature?.id === state.feature_id)
  const next = allowedTransitions(state.phase, options).join(' | ') || '(terminal)'
  const open = openFeatureList(features)
  return [
    `phase ${state.phase}${state.feature_id ? ` on ${state.feature_id}` : ''} ` +
      `(${PHASE_ROLE[state.phase] ?? '?'}), round ${state.round}`,
    `features: ${counts.done}/${counts.total} complete`,
    // Printed only when something is open, so a finished project's report is unchanged. The
    // ids come from a hand-editable file, so each is flattened: a newline inside one would
    // otherwise become a separate line of a report a model reads as structure.
    open.total === 0
      ? null
      : `open features (${open.total}): ${open.rows
          .map(row => String(row.id).replace(/[\r\n\u2028\u2029]+/g, ' '))
          .join(', ')}` + (open.truncated ? ` and ${open.total - open.rows.length} more` : ''),
    current ? `current: ${current.description ?? '(no description)'} (passes=${current.passes === true})` : null,
    `next allowed: ${next}`,
  ]
    .filter(Boolean)
    .join('\n')
}
