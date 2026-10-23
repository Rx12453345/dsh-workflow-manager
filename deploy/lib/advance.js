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
import { dirname, join } from 'node:path'

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
  INIT: ['PLAN', 'PICK'],
  PLAN: ['PICK'],
  PICK: ['NEGOTIATE', 'BUILD', 'PLAN'],
  NEGOTIATE: ['BUILD'],
  BUILD: ['VERIFY'],
  VERIFY: ['EVALUATE', 'COMMIT', 'BUILD'],
  EVALUATE: ['COMMIT', 'BUILD'],
  COMMIT: ['PICK', 'HANDOFF'],
  HANDOFF: [],
})

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
 * @param from - current phase.
 * @param to - requested phase.
 * @returns true when the edge exists in {@link TRANSITIONS}.
 */
export function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to)
}

/**
 * Attempt a transition.
 *
 * @param state - the current state.
 * @param to - requested phase.
 * @param options - `{ reason }`.
 * @returns `{ ok: true, state }` or `{ ok: false, error, allowed }`.
 */
export function transition(state, to, options = {}) {
  const from = state.phase
  if (!PHASES.includes(to)) {
    return { ok: false, error: `unknown phase "${String(to)}"`, allowed: TRANSITIONS[from] ?? [] }
  }
  if (from === to) {
    return { ok: false, error: `already in ${to}`, allowed: TRANSITIONS[from] ?? [] }
  }
  if (!canTransition(from, to)) {
    return {
      ok: false,
      error: `cannot go from ${from} to ${to}`,
      allowed: TRANSITIONS[from] ?? [],
    }
  }

  const now = new Date().toISOString()
  const entry = { at: now, from, to, ...(options.reason ? { reason: options.reason } : {}) }
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
      state: { ...DEFAULT_STATE, ...parsed, history: Array.isArray(parsed?.history) ? parsed.history : [] },
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
export function fingerprint(projectDir, files = [], extra = '', scope = '') {
  const hash = createHash('sha256')
  if (scope !== undefined && scope !== null && String(scope) !== '') {
    hash.update('scope\0')
    hash.update(String(scope))
    hash.update('\0')
  }
  for (const file of [...files].sort()) {
    const path = file.startsWith(projectDir) ? file : join(projectDir, file)
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
      todo: counts.total > 0 ? 'Every feature is already complete; move to HANDOFF.' : 'No features yet.',
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
 * @param options - `{ state, features }`.
 * @returns a short human-readable line.
 */
export function describeAdvance(state, features) {
  const counts = featureCounts(features)
  const current = (features?.features ?? []).find(feature => feature?.id === state.feature_id)
  const next = (TRANSITIONS[state.phase] ?? []).join(' | ') || '(terminal)'
  return [
    `phase ${state.phase}${state.feature_id ? ` on ${state.feature_id}` : ''} ` +
      `(${PHASE_ROLE[state.phase] ?? '?'}), round ${state.round}`,
    `features: ${counts.done}/${counts.total} complete`,
    current ? `current: ${current.description ?? '(no description)'} (passes=${current.passes === true})` : null,
    `next allowed: ${next}`,
  ]
    .filter(Boolean)
    .join('\n')
}
