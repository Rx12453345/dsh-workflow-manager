/**
 * Per-work-unit state resolution.
 *
 * THE DEFECT THIS EXISTS TO FIX
 * `workflow_advance` kept its state in `.dsh/WORKFLOW.json` and `.dsh/FEATURES.json`,
 * keyed by project only. A delegated child agent therefore could not drive its OWN work
 * unit without trampling the parent's: a child delegated to implement component B4 found
 * the parent's B3 unit sitting at phase `EVALUATE` in the same file, correctly refused to
 * touch it, and had to abandon the phase machine entirely.
 *
 * THE LAYOUT
 *
 *   work_unit ABSENT  ->  .dsh/WORKFLOW.json + .dsh/FEATURES.json          (UNCHANGED)
 *   work_unit "<id>"  ->  .dsh/work/<id>/WORKFLOW.json + FEATURES.json
 *
 * The absent case must stay byte-identical to the pre-existing layout — existing projects
 * are not migrated, not rewritten, and not even inspected for `.dsh/work`.
 *
 * WHY THE ID VALIDATION IS SECURITY-CRITICAL
 * `<id>` becomes a path segment, and this plugin runs with real filesystem access. A
 * `../` in a work-unit id is a path-traversal WRITE. So the id is checked against a
 * conservative character set and the resolved path is then compared against the work-unit
 * root. The character set should already make escape impossible; the containment check is
 * defence in depth, and it is a real containment check rather than a prefix string
 * comparison, because `/a/bc` starts with `/a/b` and is *not* inside it.
 *
 * An unusable id is REFUSED, never sanitised. A silently-mangled id is worse than a
 * refusal: two callers would believe they share a unit while writing to different ones.
 *
 * @module src-12453345_-dsh-workflow/work-unit
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/** The directory, relative to the project root, that holds every work unit. */
export const WORK_UNIT_DIR_RELATIVE_PATH = join('.dsh', 'work')

/** The state file names INSIDE a work-unit directory (no `.dsh` prefix). */
export const WORK_UNIT_WORKFLOW_FILENAME = 'WORKFLOW.json'
export const WORK_UNIT_FEATURES_FILENAME = 'FEATURES.json'

/**
 * The legacy layout, kept as the authoritative default so the two modules cannot drift.
 * These names are re-exported from `lib/advance.js` under their original identifiers.
 */
export const DEFAULT_WORKFLOW_STATE_RELATIVE_PATH = join('.dsh', 'WORKFLOW.json')
export const DEFAULT_FEATURES_RELATIVE_PATH = join('.dsh', 'FEATURES.json')

/** A work-unit id is capped well below any filesystem limit; 64 is plenty. */
export const WORK_UNIT_ID_MAX_LENGTH = 64

/**
 * The accepted character set. Deliberately conservative: letters, digits, dot,
 * underscore and hyphen. Everything else — separators, colons, backslashes, percent
 * escapes, NUL, whitespace, non-ASCII — is refused.
 */
export const WORK_UNIT_ID_PATTERN = /^[A-Za-z0-9._-]+$/

/**
 * Platforms whose default filesystem folds case, so `"B4"` and `"b4"` name ONE directory.
 *
 * This matters because the validator and the review-store key treat the two as different
 * units. Without the check in {@link resolveWorkUnitDir}, two callers would each believe
 * they own a separate unit while silently sharing a single `WORKFLOW.json`. Exported so a
 * test can assert it agrees with `process.platform`.
 */
export const CASE_INSENSITIVE_FILESYSTEMS = Object.freeze(['win32', 'darwin'])

/** Render any value for an error message without throwing (BigInt/Symbol included). */
function describeValue(value) {
  if (typeof value === 'string') return JSON.stringify(value)
  try {
    return String(value)
  } catch {
    return `(a ${typeof value})`
  }
}

/**
 * Validate a work-unit id.
 *
 * @param value - the candidate id.
 * @returns `{ ok: true, id }` or `{ ok: false, error }`.
 */
export function validateWorkUnitId(value) {
  if (typeof value !== 'string') {
    return { ok: false, error: `a work unit id must be a string, got ${describeValue(value)}` }
  }
  if (value.length === 0) {
    return { ok: false, error: 'a work unit id must not be empty' }
  }
  if (value.length > WORK_UNIT_ID_MAX_LENGTH) {
    return {
      ok: false,
      error:
        `a work unit id must be at most ${WORK_UNIT_ID_MAX_LENGTH} characters, got ${value.length}. ` +
        'An over-long id is refused rather than truncated: a truncated id would silently name a different unit.',
    }
  }
  if (!WORK_UNIT_ID_PATTERN.test(value)) {
    return {
      ok: false,
      error:
        'a work unit id may contain only letters, digits, "." , "_" and "-"; ' +
        `${describeValue(value)} contains something else (a path separator, a colon, a drive letter, a ` +
        'percent escape, NUL, whitespace or a non-ASCII character). It is refused rather than sanitised, ' +
        'because a silently-mangled id means two callers think they share a unit and do not.',
    }
  }
  if (value === '.' || value === '..') {
    return { ok: false, error: `${describeValue(value)} is a directory reference, not a work unit id` }
  }
  if (value.startsWith('-')) {
    return { ok: false, error: `a work unit id must not start with "-"; got ${describeValue(value)}` }
  }
  if (value.startsWith('.')) {
    return {
      ok: false,
      error:
        `a work unit id must not start with "."; got ${describeValue(value)}. Leading dots are how a path ` +
        'traversal is written, so they are refused outright.',
    }
  }
  return { ok: true, id: value }
}

/**
 * Whether `candidate` is strictly inside `base`.
 *
 * A prefix comparison is NOT a containment check: `/a/bc` starts with `/a/b` and is a
 * sibling, not a child. This uses the platform's own relative-path computation and
 * refuses the root itself, a parent, an empty relationship, and a cross-drive path.
 *
 * The `..` test compares WHOLE path segments. Matching a bare `startsWith('..')` would
 * also reject a legitimate child whose name merely begins with two dots, which is a false
 * negative rather than a safety win.
 *
 * @param base - the containing directory.
 * @param candidate - the candidate path.
 * @returns true when candidate is strictly inside base.
 */
export function isContainedIn(base, candidate) {
  if (typeof base !== 'string' || typeof candidate !== 'string') return false
  if (base === '' || candidate === '') return false
  const relation = relative(resolve(base), resolve(candidate))
  if (relation === '') return false // the root itself is not inside the root
  if (isAbsolute(relation)) return false // different Windows drive, or otherwise unrelated
  if (relation === '..') return false
  return !relation.startsWith(`..${sep}`)
}

/**
 * Resolve the directory a work unit's state lives in.
 *
 * @param projectDir - the project root.
 * @param id - the requested work-unit id.
 * @returns `{ ok: true, id, base, dir }` or `{ ok: false, error }`.
 */
export function resolveWorkUnitDir(projectDir, id) {
  const checked = validateWorkUnitId(id)
  if (checked.ok !== true) return { ok: false, error: checked.error }

  if (typeof projectDir !== 'string' || projectDir.trim() === '') {
    return {
      ok: false,
      error: 'no project directory was available, so a work unit cannot be resolved (refused rather than defaulted)',
    }
  }

  const root = resolve(projectDir)
  const base = resolve(root, WORK_UNIT_DIR_RELATIVE_PATH)
  const dir = resolve(base, checked.id)

  // Defence in depth. The character set already forbids a separator, so this can only
  // fire if that check is weakened or the platform surprises us — and when it fires, the
  // write is refused instead of landing outside the project.
  if (!isContainedIn(base, dir)) {
    return {
      ok: false,
      error:
        `work unit ${describeValue(checked.id)} resolves to ${dir}, which is outside ` +
        `${WORK_UNIT_DIR_RELATIVE_PATH} (${base}). Refused.`,
    }
  }

  // A case-insensitive volume makes "B4" and "b4" the SAME directory while the validator
  // and the review-store key treat them as different units. Two callers would each believe
  // they own a separate unit and silently share one file. AMBIGUOUS is refused, because
  // "which one did I mean" has no safe default.
  if (CASE_INSENSITIVE_FILESYSTEMS.includes(process.platform)) {
    let existing = null
    try {
      existing = readdirSync(base)
    } catch {
      existing = null // no work-unit root yet: nothing can collide
    }
    if (Array.isArray(existing)) {
      const folded = checked.id.toLowerCase()
      const collision = existing.find(
        name => typeof name === 'string' && name !== checked.id && name.toLowerCase() === folded,
      )
      if (typeof collision === 'string') {
        return {
          ok: false,
          error:
            `work unit ${describeValue(checked.id)} differs only in case from the existing ` +
            `${describeValue(collision)}, and this filesystem does not distinguish them: they are the ` +
            'same directory, so the id is ambiguous and refused rather than silently shared',
        }
      }
    }
  }

  return { ok: true, id: checked.id, base, dir }
}

/**
 * The absolute paths holding a scope's state.
 *
 * `workUnit` absent (`undefined`/`null`) selects the LEGACY layout and is byte-for-byte
 * the same as the pre-work-unit code. Anything else is resolved through
 * {@link resolveWorkUnitDir} and must validate.
 *
 * @param projectDir - the project root.
 * @param workUnit - the optional work-unit id.
 * @returns `{ ok: true, workUnit, dir, workflowPath, featuresPath }` or `{ ok: false, error }`.
 */
export function workUnitStatePaths(projectDir, workUnit) {
  if (workUnit === undefined || workUnit === null) {
    return {
      ok: true,
      workUnit: null,
      dir: projectDir,
      workflowPath: join(projectDir, DEFAULT_WORKFLOW_STATE_RELATIVE_PATH),
      featuresPath: join(projectDir, DEFAULT_FEATURES_RELATIVE_PATH),
    }
  }

  const resolved = resolveWorkUnitDir(projectDir, workUnit)
  if (resolved.ok !== true) return resolved

  return {
    ok: true,
    workUnit: resolved.id,
    dir: resolved.dir,
    workflowPath: join(resolved.dir, WORK_UNIT_WORKFLOW_FILENAME),
    featuresPath: join(resolved.dir, WORK_UNIT_FEATURES_FILENAME),
  }
}

/**
 * The key a review verdict is stored under.
 *
 * The key MUST include the work unit. `workflow_review` records its verdict in a
 * process-level store and `workflow_advance action=record-review` reads ONLY that store;
 * that chain is what stops a model from marking a feature complete on its own word. If the
 * key were project-only, a review of unit X could be consumed to complete a feature in
 * unit Y — a lateral bypass of the whole mechanism.
 *
 * A structured key is used rather than string concatenation so no two (project, unit)
 * pairs can collide by construction.
 *
 * @param projectDir - the project the review covered.
 * @param workUnit - the work unit it covered, or null/undefined for the legacy scope.
 * @returns a stable string key.
 */
export function reviewOutcomeKey(projectDir, workUnit) {
  return JSON.stringify([
    typeof projectDir === 'string' ? projectDir : null,
    workUnit === undefined || workUnit === null ? null : String(workUnit),
  ])
}

/**
 * Validate the optional `work_unit` tool argument and return the canonical id.
 *
 * ABSENT means the legacy, project-level layout — that is the only value that may default.
 * PRESENT but unusable is REFUSED, never dropped and never sanitised: a caller that asked
 * for a unit and silently got the project's own state would trample the parent's unit,
 * which is the exact defect this whole feature exists to remove.
 *
 * @param projectDir - the resolved project root.
 * @param requested - the raw `work_unit` argument.
 * @returns `{ ok: true, workUnit }` (workUnit is null when absent) or `{ ok: false, error }`.
 */
export function resolveWorkUnitArgument(projectDir, requested) {
  if (requested === undefined || requested === null) return { ok: true, workUnit: null }
  const resolved = resolveWorkUnitDir(projectDir, requested)
  if (resolved.ok !== true) return { ok: false, error: resolved.error }
  return { ok: true, workUnit: resolved.id }
}

/**
 * The refusal payload for an unusable `work_unit`, shared by every tool that accepts one.
 *
 * @param projectDir - the project the call was aimed at.
 * @param requested - the raw argument, echoed so the caller can see what was refused.
 * @param error - the validator's explanation.
 * @returns A JSON-serialisable refusal.
 */
export function workUnitRefusal(projectDir, requested, error) {
  // The validator's own messages end in a period; strip it so the composed refusal does
  // not read "do not.. A work unit is ...".
  const detail = String(error ?? '').replace(/\.\s*$/, '')
  return {
    ok: false,
    status: 'bad-work-unit',
    projectDir,
    workUnit: typeof requested === 'string' ? requested : null,
    reason:
      `${detail}. A work unit is an optional label that gives a delegated child its own ` +
      `WORKFLOW.json + FEATURES.json under ${WORK_UNIT_DIR_RELATIVE_PATH}/<id>, so that a child can ` +
      "drive its own phase machine without touching the parent's. Call again without work_unit for " +
      "the project's own state, or with an id matching [A-Za-z0-9._-] (at most 64 characters, not " +
      'starting with "." or "-").',
  }
}

/**
 * List the work units that exist in a project.
 *
 * Defensive by construction: `.dsh/work` is hand-editable, so a missing directory, an
 * unreadable entry, a file where a directory was expected, or a directory whose name is
 * not a valid id must all be reported rather than thrown. Invalid names are returned in
 * `ignored` so a hand-made directory is not silently mistaken for a unit.
 *
 * @param projectDir - the project root.
 * @returns `{ base, units, ignored }`, never throws.
 */
export function listWorkUnits(projectDir) {
  const result = { base: null, units: [], ignored: [] }
  if (typeof projectDir !== 'string' || projectDir === '') return result

  const base = join(resolve(projectDir), WORK_UNIT_DIR_RELATIVE_PATH)
  result.base = base

  let entries
  try {
    entries = readdirSync(base, { withFileTypes: true })
  } catch {
    // Absent or unreadable: there are no work units to report, which is not an error.
    return result
  }
  if (!Array.isArray(entries)) return result

  for (const entry of entries) {
    let name = null
    let isDirectory = false
    try {
      name = typeof entry?.name === 'string' ? entry.name : null
      isDirectory = typeof entry?.isDirectory === 'function' && entry.isDirectory() === true
    } catch {
      continue
    }
    if (name === null) continue
    if (!isDirectory) {
      result.ignored.push(name)
      continue
    }
    const checked = validateWorkUnitId(name)
    if (checked.ok !== true) {
      result.ignored.push(name)
      continue
    }
    result.units.push(describeWorkUnit(base, checked.id))
  }

  result.units.sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0))
  result.ignored.sort()
  return result
}

/** Read just enough of one unit's state to describe it, surviving malformed content. */
function describeWorkUnit(base, id) {
  const dir = join(base, id)
  const workflowPath = join(dir, WORK_UNIT_WORKFLOW_FILENAME)
  const featuresPath = join(dir, WORK_UNIT_FEATURES_FILENAME)

  const report = {
    id,
    dir,
    hasState: false,
    hasFeatures: false,
    phase: null,
    problems: [],
  }

  try {
    report.hasState = existsSync(workflowPath)
    report.hasFeatures = existsSync(featuresPath)
  } catch (error) {
    report.problems.push(`could not be inspected: ${error?.message ?? error}`)
    return report
  }

  if (!report.hasState) return report

  try {
    const parsed = JSON.parse(readFileSync(workflowPath, 'utf8'))
    if (parsed !== null && typeof parsed === 'object' && typeof parsed.phase === 'string') {
      report.phase = parsed.phase
    } else {
      report.problems.push('WORKFLOW.json has no usable "phase" field')
    }
  } catch (error) {
    report.problems.push(`WORKFLOW.json could not be read: ${error?.message ?? error}`)
  }

  return report
}
