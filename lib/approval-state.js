/**
 * Resolve the approval gate for one pending call: opt-in, effective config, validated gate.
 *
 * WHY THIS IS A SEPARATE MODULE FROM `approval.js`
 * `approval.js` owns the POLICY (what a risk is, what a strength does). This module owns
 * the OBSERVATION (which project a call belongs to, what its configuration says). Keeping
 * them apart is what lets `approval.js` avoid importing `config.js` while `config.js`
 * imports the validator from `approval.js` — the alternative is an import cycle, and a
 * cycle in the file that defines the safety gate's defaults is not a place to be clever.
 *
 * OPT-IN IS HONOURED HERE, BEFORE ANY JUDGEMENT. The plugin's central invariant is that a
 * project without `.dsh/workflow.yml` is completely inert. A gate that intercepted calls
 * in every project would break that invariant and turn an opt-in workflow tool into a
 * global, always-on interceptor, so `active` is false unless the project opted in (or the
 * row explicitly sets `requireOptIn: false`).
 *
 * @module src-12453345_-dsh-workflow/approval-state
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { DEFAULT_CONFIG } from './config.js'
import { resolveEffectiveConfig, WORKFLOW_RELATIVE_PATH } from './workflow-file.js'
import { parseWorkflowYaml } from './project.js'
import { readApprovalGate, sessionCwd, FAIL_CLOSED_APPROVAL } from './approval.js'

/**
 * Cached project-file reads, keyed by absolute path.
 *
 * The guard is SYNCHRONOUS and runs before every tool call, so it cannot parse YAML on
 * each one. The cache key includes mtime and size, so editing `.dsh/workflow.yml` takes
 * effect on the next call without a restart — and a stale entry can never outlive a
 * write, which is the failure mode a plain path key would have introduced.
 *
 * @type {Map<string, { key: string, present: boolean, value: unknown, problems: string[] }>}
 */
const cache = new Map()

/** Drop the memo, so a test (or a writer) never sees a stale project file. */
export function clearApprovalStateCache() {
  cache.clear()
}

function readProjectFile(projectDir) {
  const path = join(projectDir, WORKFLOW_RELATIVE_PATH)
  let stamp
  try {
    const stats = statSync(path)
    stamp = `${path}\u0000${stats.mtimeMs}\u0000${stats.size}`
  } catch (error) {
    // Absent, or present but not statable — two different situations. An absent file means
    // the project did not opt in. A file that exists but cannot be examined is reported as
    // a problem the gate refuses to interpret, because treating it as "no overrides" would
    // let an unreadable file silently discard the strength the project asked for.
    cache.delete(path)
    let present = false
    try {
      present = existsSync(path)
    } catch {
      present = false
    }
    return {
      present,
      value: null,
      problems: present ? [`could not examine ${path}: ${error?.message ?? error}`] : [],
    }
  }

  const hit = cache.get(path)
  if (hit && hit.key === stamp) return hit

  const entry = { key: stamp, present: true, value: null, problems: [] }
  try {
    const parsed = parseWorkflowYaml(readFileSync(path, 'utf8'))
    entry.value = parsed.value
    entry.problems = Array.isArray(parsed.problems) ? parsed.problems : []
  } catch (error) {
    entry.problems = [`could not read ${path}: ${error?.message ?? error}`]
  }
  cache.set(path, entry)
  return entry
}

/**
 * The ONE place the "is this project's approval section usable" rule lives.
 *
 * SHARED BY THE RUNTIME GATE AND BY EVERY REPORTING SURFACE. It did not used to be: the
 * listener refused a project file with parse problems (ignoring its approval section
 * entirely) while `workflow_status` and `workflow_set` re-derived the merged section and
 * reported the strength the project had written. The two answers disagreed exactly when a
 * file was malformed — status showed `off` with no "gate broken" marker for a gate that
 * would in fact ask on every gated call and deny every high-risk one. Two readers of one
 * setting disagreeing is the failure class `lib/gate.js` exists to remove, so the rule is
 * extracted here and both sides call it.
 *
 * @param rowConfig - configuration from the loader's patch row.
 * @param projectFile - `{ present, value, problems }`, as `readWorkflowFile` returns it.
 * @param defaults - the documented defaults for an absent field.
 * @returns `{ config, sources, gate }`, where `gate` is ALWAYS usable-shaped: on any
 *   problem it carries the fail-closed values and `gate.usable === false`.
 */
export function readApprovalForProject(rowConfig, projectFile, defaults) {
  const fileProblems = Array.isArray(projectFile?.problems) ? projectFile.problems : []
  const { config, sources } = resolveEffectiveConfig(rowConfig, projectFile?.present ? projectFile.value : null)

  // A CORRUPT PROJECT FILE IS A CONFIGURATION ERROR, AND THE GATE REFUSES IT.
  //
  // Without this, an unreadable `.dsh/workflow.yml` falls back to the patch row's
  // approval section — which would let a typo in a project file silently select a
  // LOOSER strength than the project asked for. The gate keeps running (so a user can
  // still fix the file) but on the fail-closed defaults, and the problem is reported
  // rather than absorbed.
  //
  // THE SECTION PASSED FOR THE FALLBACK IS `FAIL_CLOSED_APPROVAL` ITSELF, NOT `undefined`.
  // `undefined` means "unset" to `readApprovalGate`, which returns the CALLER'S defaults —
  // i.e. the documented `medium` threshold — while this function still marked the gate
  // `usable: false` and told the user the fail-closed defaults were in force. The gate was
  // therefore reported as fail-closed and behaved as merely default, and a classified
  // low-risk call was PASSED for a file the gate had just refused: exactly the
  // `off`-for-`ask-user` divergence above, moved onto the threshold axis.
  const unreadable = fileProblems.length > 0
  const gate = unreadable
    ? readApprovalGate(FAIL_CLOSED_APPROVAL, FAIL_CLOSED_APPROVAL)
    : readApprovalGate(config.approval, defaults)

  const problems = []
  if (unreadable) {
    problems.push(
      `${WORKFLOW_RELATIVE_PATH} could not be fully read, so its approval settings were ignored and ` +
        `the fail-closed defaults were used instead: ${fileProblems.join('; ')}`,
    )
  }
  problems.push(...gate.problems)
  const usable = problems.length === 0

  return { config, sources, gate: { ...gate, ok: usable, usable, problems } }
}

/**
 * Resolve the effective approval state for one pending execution.
 *
 * @param exec - the pending execution whose session identifies the project.
 * @param rowConfig - configuration from the loader's patch row.
 * @param options - `{ defaults }` overrides for the approval defaults (tests).
 * @returns `{ active, optedIn, requireOptIn, projectDir, projectDirKnown, config, sources,
 *   problems, gate }`. `gate` is ALWAYS a usable-shaped object (see
 *   {@link readApprovalForProject}), so no caller is left holding `undefined` and reaching
 *   for a permissive fallback of its own.
 *
 *   `projectDirKnown` is reported SEPARATELY from `active` on purpose. An unresolvable
 *   session working directory means the plugin cannot tell whether this project opted in,
 *   and the honest answer is the plugin's central invariant: a project it cannot identify
 *   stays ungated (`next()` is not an allow — the host's own approval policy is still in
 *   force). What was wrong was the SILENCE: a host shape change would have disabled the
 *   gate with no counter, no log and no status line, so the gate reports the condition
 *   instead of hiding it.
 */
export function resolveApprovalState(exec, rowConfig, options = {}) {
  const defaults = options.defaults ?? {
    strength: DEFAULT_CONFIG.approval.strength,
    riskThreshold: DEFAULT_CONFIG.approval.riskThreshold,
    denyHighAlways: DEFAULT_CONFIG.approval.denyHighAlways,
    exemptTools: DEFAULT_CONFIG.approval.exemptTools,
  }

  const projectDir = sessionCwd(exec)
  const projectDirKnown = typeof projectDir === 'string' && projectDir !== ''
  const file = projectDirKnown
    ? readProjectFile(projectDir)
    : { present: false, value: null, problems: [] }

  const { config, sources, gate } = readApprovalForProject(rowConfig, file, defaults)
  const requireOptIn = config.requireOptIn !== false
  const optedIn = file.present === true
  const active = requireOptIn ? optedIn : true

  return {
    active,
    optedIn,
    requireOptIn,
    projectDir,
    projectDirKnown,
    sources,
    config,
    problems: gate.problems,
    gate,
  }
}
