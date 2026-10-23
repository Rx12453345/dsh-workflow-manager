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

import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

import { DEFAULT_CONFIG } from './config.js'
import { resolveEffectiveConfig, WORKFLOW_RELATIVE_PATH } from './workflow-file.js'
import { parseWorkflowYaml } from './project.js'
import {
  readApprovalGate,
  sessionCwd,
  FAIL_CLOSED_APPROVAL,
  APPROVAL_STRENGTHS,
  RISK_LEVELS,
} from './approval.js'

/**
 * The project file is read on EVERY call, deliberately.
 *
 * It used to be cached by `${path}:${mtimeMs}:${size}`. That key is not a correctness
 * guarantee: two same-size edits inside the filesystem's timestamp resolution produce the
 * same key, so a direct write of `strength: llm-only` could be invisible to the very next
 * gate decision. A test reproduced it; on the security path, "the cache did not notice"
 * is a bypass, not a performance trade. The file is a handful of lines and the read is
 * synchronous but tiny, so the cache is gone rather than made cleverer.
 *
 * The monotonic memory below is separate: it is what makes a WEAKER value ineffective even
 * when the read does see it.
 */

/**
 * The strongest gate each project has resolved in THIS process, and the projects that were
 * observed opted in.
 *
 * WHY THE PROCESS REMEMBERS. The project file is read per call, which is what lets a user fix a
 * configuration without a restart. The same property let an agent edit `.dsh/workflow.yml` (or
 * delete it) and have the gate weaken or disappear on the very next call — including the write
 * the gate had just refused. The approval strength is not a preference a session may lower while
 * it is being judged. The memory enforces the rule the design states: a weaker gate takes effect
 * only after a restart, or after a write the user confirmed through `workflow_set`.
 *
 * The memory is per process on purpose. A restart is the documented way to adopt a weaker file;
 * clearing it in a test simulates exactly that.
 */
const strongestByProject = new Map()
const optedInByProject = new Set()

/**
 * One canonical key per project.
 *
 * `sessionCwd` and `probeProject` can hand back the same directory with different separators
 * (`D:\x` vs `D:/x`); keying the memory on the raw string would give the gate and the status
 * surface separate memories, and a direct edit could look effective to one of them. `resolve`
 * normalises separators and `.`/`..` without touching the filesystem.
 */
function projectKey(projectDir) {
  try {
    return resolve(projectDir)
  } catch {
    return projectDir
  }
}

/** Strength index: lower is stricter (ask-user 0 ... off 3). Unknown -> ask-user. */
function strengthRank(value) {
  const index = APPROVAL_STRENGTHS.indexOf(value)
  return index === -1 ? 0 : index
}

/** Threshold index: lower is stricter (low catches more than high). Unknown -> low. */
function thresholdRank(value) {
  const index = RISK_LEVELS.indexOf(value)
  return index === -1 ? 0 : index
}

function cloneGate(gate) {
  return {
    ...gate,
    exemptTools: Array.isArray(gate?.exemptTools) ? [...gate.exemptTools] : [],
    problems: Array.isArray(gate?.problems) ? [...gate.problems] : [],
    notices: Array.isArray(gate?.notices) ? [...gate.notices] : [],
  }
}

/**
 * Merge one freshly-read gate with the strongest gate already seen for the project.
 *
 * Per axis, never whole-object: a write that raises one axis and lowers another must not be
 * silently rejected on the raised axis. The merge keeps the stricter value on each axis, so a
 * mid-session downgrade can only ever be a no-op. `usable` is AND-ed because a file the gate
 * refused earlier must not become healthy just because a later read is usable; the fail-closed
 * values are already in the merge.
 */
function mergeMonotonicGate(previous, next) {
  const prev = cloneGate(previous)
  const merged = cloneGate(next)

  merged.strength = strengthRank(prev.strength) <= strengthRank(next.strength)
    ? prev.strength
    : next.strength
  merged.riskThreshold = thresholdRank(prev.riskThreshold) <= thresholdRank(next.riskThreshold)
    ? prev.riskThreshold
    : next.riskThreshold
  merged.denyHighAlways = prev.denyHighAlways === true || next.denyHighAlways === true
  const prevExempt = new Set(prev.exemptTools)
  merged.exemptTools = next.exemptTools.filter(tool => prevExempt.has(tool))
  merged.usable = prev.usable !== false && next.usable !== false
  merged.ok = merged.usable
  merged.problems = [...new Set([...prev.problems, ...next.problems])]

  const weakened =
    merged.strength !== next.strength ||
    merged.riskThreshold !== next.riskThreshold ||
    merged.denyHighAlways !== next.denyHighAlways ||
    merged.exemptTools.length !== next.exemptTools.length
  if (weakened) {
    merged.downgradeIgnored = true
    merged.notices = [
      ...(Array.isArray(next.notices) ? next.notices : []),
      `the project asks for strength=${next.strength}, threshold=${next.riskThreshold}, ` +
        `denyHighAlways=${next.denyHighAlways}, exempt=[${next.exemptTools.join(', ')}], but this ` +
        'session already ran with a stricter gate; the weaker value is IGNORED until a restart or a ' +
        'user-confirmed change.',
    ]
  }
  if (next.optedInMissing === true) merged.optedInMissing = true
  return merged
}

/**
 * Let a user-confirmed write become the new baseline for one project.
 *
 * ONLY the confirmed `workflow_set` path may call this. A direct file edit is not a confirmation
 * and must keep the stronger gate; that is the whole point of the memory.
 */
export function forgetApprovalSnapshot(projectDir) {
  if (typeof projectDir === 'string' && projectDir !== '') {
    strongestByProject.delete(projectKey(projectDir))
  }
}

/** Drop the monotonic memory (tests simulate a restart; a new process starts empty anyway). */
export function clearApprovalStateCache() {
  strongestByProject.clear()
  optedInByProject.clear()
}

function readProjectFile(projectDir) {
  const path = join(projectDir, WORKFLOW_RELATIVE_PATH)
  try {
    const parsed = parseWorkflowYaml(readFileSync(path, 'utf8'))
    return {
      present: true,
      value: parsed.value,
      problems: Array.isArray(parsed.problems) ? parsed.problems : [],
    }
  } catch (error) {
    // Absent, or present but unreadable — two different situations. An absent file means the
    // project did not opt in. A file that exists but cannot be read is reported as a problem
    // the gate refuses to interpret, because treating it as "no overrides" would let an
    // unreadable file silently discard the strength the project asked for.
    let present = false
    try {
      present = existsSync(path)
    } catch {
      present = false
    }
    return {
      present,
      value: null,
      problems: present ? [`could not read ${path}: ${error?.message ?? error}`] : [],
    }
  }
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
 * @param projectDir - the project the gate belongs to. When supplied, the per-process
 *   monotonic memory is applied; when omitted (unit tests of the pure reader), it is not.
 * @returns `{ config, sources, gate }`, where `gate` is ALWAYS usable-shaped: on any
 *   problem it carries the fail-closed values and `gate.usable === false`.
 */
export function readApprovalForProject(rowConfig, projectFile, defaults, projectDir) {
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

  let effective = { ...gate, ok: usable, usable, problems }

  // THE MONOTONIC MEMORY, APPLIED WHERE EVERY SURFACE READS THE GATE. This is deliberately in
  // the shared reader rather than in the listener: `workflow_status` and `workflow_set` must
  // report the gate that will actually judge the next call, not the weaker value a file was
  // just edited to. The runtime listener and both reporting tools reach this function.
  if (typeof projectDir === 'string' && projectDir !== '') {
    const memoryKey = projectKey(projectDir)
    if (projectFile?.present === true) optedInByProject.add(memoryKey)
    if (projectFile?.present !== true && optedInByProject.has(memoryKey)) {
      effective.optedInMissing = true
      effective.notices = [
        ...(Array.isArray(effective.notices) ? effective.notices : []),
        'the opt-in file disappeared during this session; the approval gate stays active until a ' +
          'restart, so deleting the file cannot switch the gate off mid-session.',
      ]
    }
    const previous = strongestByProject.get(memoryKey)
    if (previous !== undefined && previous !== null) {
      effective = mergeMonotonicGate(previous, effective)
    }
    strongestByProject.set(memoryKey, cloneGate(effective))
  }

  return { config, sources, gate: effective }
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

  const { config, sources, gate } = readApprovalForProject(rowConfig, file, defaults, projectDir)
  const requireOptIn = config.requireOptIn !== false
  // A file that WAS present in this process keeps the project opted in even if it disappears:
  // otherwise deleting `.dsh/workflow.yml` is a one-call way to switch the gate off.
  const optedIn = file.present === true || gate.optedInMissing === true
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
