/**
 * Model-facing tools for dsh-workflow.
 *
 * Every tool result is passed through {@link toLosslessJson} before it leaves this
 * module. The host validates tool output at the result boundary and rejects any
 * value that is not lossless JSON — and `undefined` is NOT lossless JSON, so a
 * single undefined field (for example the absent `value` argument of a read-only
 * `workflow_set`) corrupts the whole call.
 *
 * @module src-12453345_-dsh-workflow/tools
 */

import {
  probeProject,
  describeProject,
  resolveWorkspaceDir,
  describeExec,
  parseWorkflowYaml,
} from './project.js'
import {
  TIERS,
  RECIPES,
  APPROVAL_STRENGTHS,
  RISK_LEVELS,
  APPROVAL_STRENGTH_LABELS,
  isPlainObject,
  configWarnings,
  toLosslessJson,
  oneLine,
} from './shared.js'
import { createHash } from 'node:crypto'
import {
  readApprovalGate,
  approvalWarningLines,
  readPromptChannel,
  APPROVAL_REMEDY,
  selfInstallRoot,
} from './approval.js'
import { readApprovalForProject, forgetApprovalSnapshot } from './approval-state.js'
import { DEFAULT_CONFIG, MAX_SUBAGENT_DEPTH, CHANGE_CLASS_IDS, CHANGE_CLASSES, VERIFICATION_DEPTHS, VERIFICATION_DEPTH_LABELS, MAX_VERIFICATION_DEPTH, readVerificationPolicy, resolveVerificationDepth, requestVerificationConfirmation, buildVerificationQuestion, verificationChoiceLabels, verificationGates, isVerificationConfirmed, isChangeClass } from './config.js'
import {
  readWorkflowFile,
  resolveEffectiveConfig,
  writeWorkflowFile,
  getPath,
  setPath,
  validateTopLevelKey,
  WORKFLOW_RELATIVE_PATH,
} from './workflow-file.js'
import { runReview, renderReview, buildVerificationAudit, harnessesForDepth, renderVerificationAudit, renderVerificationGuidance } from './review.js'
import { buildGcToolDefinition, resolveUserQuestions, askForConfirmation } from './gc.js'
import { readRetireCheck, isConfirmed } from './constraints.js'
import { checkBar, checkMaxRounds, readStringList, readEvaluatorGate, describeValue } from './gate.js'
import {
  listWorkUnits,
  resolveWorkUnitArgument,
  reviewOutcomeKey,
  workUnitRefusal,
} from './work-unit.js'
import {
  fingerprint,
  readState,
  writeState,
  readFeatures,
  writeFeatures,
  transition,
  canTransition,
  pickNextFeature,
  featureCounts,
  buildBootstrap,
  applyReviewOutcome,
  checkFeatureDiff,
  emptyFeatures,
  describeAdvance,
  PHASES,
  PHASE_ROLE,
  TRANSITIONS,
  HISTORY_CAP,
} from './advance.js'

/**
 * The sanitiser now lives in `lib/shared.js`, the leaf module every tool module already
 * imports; it is re-exported here because this is where callers already import it from.
 * See {@link toLosslessJson} for why the host rejects anything else.
 */
export { toLosslessJson }

/**
 * Host services the workflow needs, as the host actually registers them.
 *
 * `subagents` is PLURAL. The package whose README describes delegation is
 * `dsh-subagent`, but the service it publishes is `ctx.subagents` — a singular
 * probe silently reports "absent" forever, which is exactly what happened on the
 * first real install. Both spellings are probed; the report shows the plural key.
 */
export const OPTIONAL_SERVICES = [
  'tools',
  'systemPrompt',
  'subagents',
  'subagent',
  'settings',
  'approval',
]

/** Service keys shown in a status report, in display order. */
export const REPORTED_SERVICES = ['tools', 'systemPrompt', 'subagents', 'settings', 'approval']

/**
 * Probe which optional host services are present, without failing when one is
 * absent.
 *
 * Deliberately defensive: a scoped context may expose services as plain
 * properties rather than via `get`, and an unexpected context shape must degrade
 * to "unknown" instead of poisoning the whole report (an earlier version turned a
 * thrown probe into a bogus `probeError: present` service).
 *
 * @param ctx - a cordis context or scoped context.
 * @returns `{ availability, resolved }`.
 */
export function probeServices(ctx) {
  const availability = {}
  const resolved = {}

  const getter =
    ctx !== null && typeof ctx === 'object' && typeof ctx.get === 'function'
      ? name => ctx.get(name)
      : null

  for (const service of OPTIONAL_SERVICES) {
    let value
    if (getter) {
      try {
        value = getter(service)
      } catch {
        value = undefined
      }
    }
    if ((value === undefined || value === null) && ctx !== null && typeof ctx === 'object') {
      try {
        value = ctx[service]
      } catch {
        value = undefined
      }
    }
    availability[service] = value !== undefined && value !== null
    if (availability[service]) resolved[service] = value
  }
  return { availability, resolved }
}

/**
 * Resolve the optional `subagents` service for ONE tool call.
 *
 * WHY THIS EXISTS AS ONE FUNCTION, AND WHY IT PROBES AT CALL TIME.
 * `workflow_status` and `workflow_review` used to answer "is delegation available?" through two
 * different routes. Status went through `probeServices` (try `get`, then the property) and saw a
 * service that was reachable only through `get`; review read `exec.subagents`,
 * `options.services.subagents`, and `options.ctx.get('subagents')`. The first is an execution
 * record, not a context; the second is a value captured at registration; the third is the OUTER
 * context, while the service belongs to the injected `runtimeCtx`. The result was a status report
 * that said "available" and a review that said "unavailable" in the same session.
 *
 * The routes are tried in this order:
 *   1. `exec.subagents`      — tests and future host shapes that put it on the execution record;
 *   2. an injected getter    — `lib/index.js` passes `getSubagents`, so the value is read live;
 *   3. the captured property — the registration-time value, kept for compatibility;
 *   4. `probeServices(...)`  — the SAME probe status uses, which tries `get` and then the property;
 *   5. the outer ctx         — last resort, and safe because `probeServices` catches a `get` that
 *                              throws on a context that never declared the service.
 *
 * A route that throws is unavailable, not fatal: the whole point is to survive a host shape we do
 * not control without turning a missing optional service into a failed status call.
 *
 * @param options - the tool options (`{ services, ctx, subagents, getSubagents }`).
 * @param exec - the pending execution.
 * @returns the subagents service, or undefined.
 */
export function resolveSubagents(options, exec) {
  const candidates = [
    () => exec?.subagents,
    () => options?.getSubagents?.(),
    () => options?.subagents,
    () => probeServices(options?.services).resolved.subagents,
    () => probeServices(options?.ctx).resolved.subagents,
  ]
  for (const candidate of candidates) {
    try {
      const value = candidate()
      if (value !== undefined && value !== null) return value
    } catch {
      // A context that did not inject the service may throw on get(); try the next route.
    }
  }
  return undefined
}

/**
 * Build the status payload for one call.
 *
 * @param options - the resolved context.
 * @returns A plain JSON-serialisable status object.
 */
// ---------------------------------------------------------------------------
// per-work-unit scope
// ---------------------------------------------------------------------------
//
// The scope helpers live in `lib/work-unit.js`, the leaf module that both this file and
// `lib/gc.js` import, so the validator and the refusal text cannot drift between tools.
// They are re-exported here because this is where callers already import tool helpers from.
export { resolveWorkUnitArgument, workUnitRefusal }

/**
 * Resolve the project directory, letting an explicit `workspace_dir` win over the session cwd.
 *
 * ONE HELPER BECAUSE THE BUG CAME BACK, AND THIS TIME IT WROTE TO THE WRONG PLACE.
 *
 * `workflow_status` was fixed to honour `workspace_dir` after a live run found it silently
 * discarding the argument. `workflow_init` and `workflow_set` were left without it — so
 * `workflow_init workspace_dir=X` opted in the WRONG project, writing `.dsh/workflow.yml`
 * into the session cwd, and `workflow_set workspace_dir=X` could change the wrong project's
 * approval strength. Both were found by calling the tools on a real host, not by any test.
 *
 * The instance was fixed and the class was not. Every tool that touches a project now goes
 * through here, and `test/status.test.mjs` asserts that all of them DECLARE the parameter —
 * because a missing declaration is what makes the host drop it silently, with no error.
 */
export function resolveWorkspace({ exec, workspaceDir }) {
  const resolved = resolveWorkspaceDir(exec)
  // An empty string is not an override; treat it as absent rather than as a project at "".
  if (typeof workspaceDir !== 'string' || workspaceDir === '') return resolved
  return {
    dir: workspaceDir,
    source: 'workspace_dir argument',
    found: [
      { label: 'workspace_dir', value: workspaceDir },
      ...resolved.found,
    ],
  }
}

export function buildStatus({ exec, config: rowConfig, services, workspaceDir, approvalStats, approvalReview, approvalChannel, declaredClass, changedFiles, diff }) {
  const workspace = resolveWorkspace({ exec, workspaceDir })
  const project = probeProject(workspace.dir)

  // Work units are reported, not selected. A project with none stays byte-identical in the
  // rendered report, so nothing changes for every pre-existing project. The scan is
  // defensive: `.dsh/work` is hand-editable, so a malformed entry is reported rather than
  // allowed to break the whole status call.
  const workUnits = listWorkUnits(project.projectDir ?? workspace.dir)

  // The project file is the override layer on top of defaults and the patch row.
  const projectFile = readWorkflowFile(workspace.dir, parseWorkflowYaml)
  // THE PROJECT-FILE RULE IS NOT RE-DERIVED HERE. `readApprovalForProject` is the one
  // place that decides a project's approval section is unusable (a malformed section, or
  // a file the reader could not fully parse); the runtime gate calls it too. Calling
  // `readApprovalGate(config.approval, …)` here instead — as this code used to — made the
  // status report show the project's written strength while the gate actually ran on the
  // fail-closed defaults, i.e. the report described a gate that did not exist.
  const { config, sources, gate: approvalGate } = readApprovalForProject(
    rowConfig,
    projectFile,
    DEFAULT_CONFIG.approval,
    // The monotonic memory is keyed by the project whose file this is. Status must report the
    // gate that will judge the next call, not the weaker value the file was just edited to.
    project.projectDir ?? workspace.dir,
  )

  // Resolve service availability at CALL time rather than mount time: a mount-time
  // probe can miss a service that starts later, and the live answer is the one
  // that matters for "can this workflow delegate to isolated child agents".
  const probe = services ? probeServices(services) : { availability: {}, resolved: {} }
  const availability = probe.availability
  // THE SAME RESOLVER THE REVIEW TOOL USES. `availability` answers "did the mount probe see it";
  // this answers "would workflow_review find it right now", which is the question the status
  // report claims to answer. Keeping them separate and reporting both is what makes a
  // status/review contradiction visible instead of silent.
  const reviewService = resolveSubagents({ services }, exec)

  const moduleSwitches = Object.entries(config.modules ?? {})
    .filter(([, on]) => on === true)
    .map(([key]) => key)

  // THE APPROVAL STATE IS READ THROUGH THE GATE'S OWN RULE AND VALIDATOR, never through
  // the optional chain that used to live in this object literal. `config.approval?.strength`
  // reads as `undefined` for a section that is a string, so the old report showed
  // "(unknown strength)" and reported the gate as healthy while the gate itself was
  // refusing the section and running on its fail-closed defaults.
  const approvalWarnings = approvalWarningLines(approvalGate)
  const reviewerNeeded = approvalGate.strength === 'llm-then-user' || approvalGate.strength === 'llm-only'
  const reviewerHasLlm =
    approvalReview && typeof approvalReview.hasLlm === 'function' ? approvalReview.hasLlm() === true : null
  const reviewerCounters = typeof approvalStats === 'function' ? approvalStats() : null

  // WHETHER THE RESOLVED STRENGTH CAN BE SATISFIED IN THIS SESSION.
  //
  // A report that prints `approval: ask-user` while every medium-risk call in the session is
  // auto-denied is describing a gate that does not exist. The policy the answer would come
  // from IS observable here — `workflow_status` runs with a real `exec`, and the `approval`
  // service is reachable through the injected getter — so this is a DETECTION where the
  // environment allows it, not a guess. Where it is not observable (no service, no
  // `effectivePolicy`, no session, an unrecognized policy, a throw) the state is `unknown`
  // and the report falls back to a CONDITIONAL warning, because a claim the plugin cannot
  // check is worse than an explicit "if".
  let promptChannel
  try {
    const service =
      (approvalChannel && typeof approvalChannel.get === 'function' ? approvalChannel.get() : undefined) ??
      probe.resolved?.approval ??
      undefined
    promptChannel = readPromptChannel(service, exec)
  } catch (error) {
    promptChannel = {
      state: 'unknown',
      detail: `the approval prompt channel could not be read: ${error?.message ?? error}`,
    }
  }

  return {
    ok: true,
    diagnostics: {
      workspaceSource: workspace.source,
      workspaceCandidates: workspace.found,
      configSources: sources,
      exec: describeExec(exec),
    },
    plugin: {
      name: 'src-12453345_-dsh-workflow',
      version: '0.1.0',
      stage: 'stage 2 — read-only status plus the project write path',
    },
    projectFile: {
      path: projectFile.path,
      present: projectFile.present,
      problems: projectFile.problems,
      overrides: projectFile.value,
    },
    // Only the canonical keys are shown; the singular alias is probed for
    // diagnosis but not advertised, so reports stay comparable across versions.
    hostServices: Object.fromEntries(
      REPORTED_SERVICES.map(key => [key, availability[key] === true ? 'present' : 'absent']),
    ),
    // Kept for diagnosis: a mismatch here means the host renamed a service.
    hostServiceAliases: Object.fromEntries(
      Object.entries(availability)
        .filter(([key]) => !REPORTED_SERVICES.includes(key))
        .map(([key, present]) => [key, present ? 'present' : 'absent']),
    ),
    subagent: {
      // Reported rather than trusted: the tool itself is a plain registry entry, so
      // whether the call-time resolver finds `subagents` is the direct answer to whether
      // the workflow can delegate to isolated child agents at all.
      available: reviewService !== undefined,
      // The mount-time probe is kept separately: when it disagrees with `available`, the host
      // exposed the service after registration or only through `get`.
      probeAvailable: availability.subagents === true,
      reviewRoute: {
        resolved: reviewService !== undefined,
        detail: reviewService !== undefined
          ? 'subagents resolved at call time; workflow_review uses the same resolver'
          : 'subagents NOT resolved via exec, getter, captured property, injected services, or ctx.get',
      },
      singularAlias: availability.subagent === true,
      maxDepth: config.subagent?.maxDepth ?? null,
      maxActiveSubagents: config.subagent?.maxActiveSubagents ?? null,
      roles: ['planner', 'generator', 'evaluator', 'verifier'],
    },
    project: {
      projectDir: project.projectDir,
      detected: project.detected,
      optedIn: project.detected,
      workflowPath: project.workflowPath,
      workflow: project.workflow,
      workflowProblems: project.workflowProblems,
      harnessability: project.harnessability,
      signals: project.signals,
      notes: project.signals,
    },
    // Which work units exist in this project. Empty when there are none, which is the
    // untouched single-unit case; the renderer says nothing at all in that case.
    workUnits: {
      base: workUnits.base,
      units: workUnits.units,
      ignored: workUnits.ignored,
    },
    // Effective config = built-in defaults overlaid with the patch row. The
    // project-level `.dsh/workflow.yml` overlay lands once the write path exists.
    effectiveConfig: {
      tier: config.tier,
      recipe: config.recipe,
      requireOptIn: config.requireOptIn,
      modulesOn: moduleSwitches,
      approval: {
        strength: approvalGate.strength,
        meaning: APPROVAL_STRENGTH_LABELS[approvalGate.strength] ?? '(unknown strength)',
        riskThreshold: approvalGate.riskThreshold,
        denyHighAlways: approvalGate.denyHighAlways,
        exemptTools: approvalGate.exemptTools,
        // `usable: false` means the section was refused and the fail-closed defaults are
        // in force. Reported rather than hidden: a project whose gate is running on
        // fallbacks must not look like a project whose configuration was honoured.
        usable: approvalGate.usable,
        problems: approvalGate.problems,
        // A weaker value the file now asks for is NOT the gate that runs. Report both facts,
        // so "the file says llm-only" and "the effective gate is still ask-user" can be seen
        // together instead of the report describing a gate that does not exist.
        monotonic: {
          downgradeIgnored: approvalGate.downgradeIgnored === true,
          optedInMissing: approvalGate.optedInMissing === true,
          notices: Array.isArray(approvalGate.notices) ? approvalGate.notices : [],
        },
        warnings: approvalWarnings,
        // `state: 'disabled'` means the strength ASKED FOR cannot be satisfied here (see
        // `readPromptChannel`): the ask would be auto-denied and reported as a human
        // rejection. `'unknown'` means this report could not read the policy, and the
        // renderer says "if" rather than claiming either way.
        promptChannel: {
          state: promptChannel.state,
          policy: typeof promptChannel.policy === 'string' ? promptChannel.policy : null,
          detail: promptChannel.detail,
          autoDenials:
            reviewerCounters && Number.isInteger(reviewerCounters.autoDeniedNoPrompt)
              ? reviewerCounters.autoDeniedNoPrompt
              : null,
        },
        reviewer: {
          needed: reviewerNeeded,
          llmAvailable: reviewerHasLlm,
          // A configured-but-unrunnable reviewer is the dangerous state: the strength
          // says "the model decides" while every gated call would fail closed instead.
          runnable: !reviewerNeeded || reviewerHasLlm !== false,
          blockedBy:
            reviewerNeeded && reviewerHasLlm === false
              ? 'the `llm` service is absent, so no reviewer can run and every gated call will be denied'
              : null,
          calls: reviewerCounters ? reviewerCounters.reviewerCalls : null,
          failures: reviewerCounters ? reviewerCounters.reviewerFailures : null,
        },
      },
      evaluator: {
        independent: config.evaluator?.independent,
        bar: config.evaluator?.bar,
        mustPass: config.evaluator?.mustPass,
        dimensions: config.evaluator?.dimensions,
        maxRounds: config.evaluator?.maxRounds,
        // Whether a review can physically run: the reviewer is a delegated child, so
        // without the subagents service the gate is configuration only.
        reviewTool: 'workflow_review',
        // RESOLVED THE SAME WAY THE TOOL RESOLVES IT. `availability.subagents` was the mount
        // probe; using it here made the report claim a capability the review path did not have.
        canReview: reviewService !== undefined && config.evaluator?.independent !== false,
        reviewRoute: {
          resolved: reviewService !== undefined,
          detail: reviewService !== undefined
            ? 'subagents resolved at call time; workflow_review uses the same resolver'
            : 'subagents NOT resolved via exec, getter, captured property, injected services, or ctx.get',
        },
        blockedBy:
          reviewService === undefined
            ? 'the subagents service could not be resolved at call time, so no reviewer can be started'
            : config.evaluator?.independent === false
              ? 'evaluator.independent is false, so reviews are not offered'
              : null,
      },
      context: {
        maxInlineTokens: config.context?.maxInlineTokens,
        isolation: config.modules?.isolation === true,
      },
      // ---- risk-based verification depth ----
      //
      // REPORTED EVEN WHEN THE POLICY IS `off`, because the user's request had two halves and only
      // one of them needs to be opt-in: enforcement must never turn itself on, but an operator
      // seeing at a glance what level of verification a piece of work is under costs nothing.
      verification: buildVerificationStatus(config, {
        declaredClass,
        changedFiles,
        diff,
        // The built-in lists describe the INSTALLED plugin's own repository. A review of any
        // other project (including a working copy of this repo) must not borrow them; such a
        // project declares its own `verification.sources` or stays fail-closed.
        selfProject: (project.projectDir ?? workspace.dir) === selfInstallRoot(),
      }),
    },
    validOptions: {
      tiers: TIERS,
      recipes: RECIPES,
      approvalStrengths: APPROVAL_STRENGTHS,
      verificationClasses: [...CHANGE_CLASS_IDS],
      verificationDepths: [0, 1, 2, 3],
    },
    nextSteps: project.detected
      ? [
          'The workflow is active for this project; workflow_set changes its parameters.',
          'workflow_set with no value reads a parameter without writing anything.',
          'Drive multi-step work with workflow_advance; it owns the phase machine and refuses ' +
            'illegal moves. Call it with no action to see the current phase.',
          'Before delivering finished work, call workflow_review for an independent verdict rather ' +
            'than declaring it complete yourself. workflow_advance marks a feature complete only ' +
            'from a review this session actually ran.',
          'Turn a recurring problem into a constraint with workflow_gc action=add: it asks the user to ' +
            'confirm, and the constraint records its own retirement condition from the start.',
          'Run workflow_gc action=scan to see which constraints are due for retirement. It only ever ' +
            'suggests, and a natural-language retirement signal is a question for a human, not a check.',
          'Run the advance/review loop from INSIDE a delegated child agent, so the review ' +
            'round-trips do not consume this conversation.',
        ]
      : [
          'Run workflow_init to opt this project in and create .dsh/workflow.yml.',
          'Until then the workflow stays completely inert here, by design.',
        ],
  }
}

/**
 * Render a status payload as the text the model reads.
 *
 * @param status - the payload from {@link buildStatus}.
 * @returns The rendered text.
 */
export function renderStatus(status) {
  const out = []
  const { plugin, hostServices, subagent, project, effectiveConfig, diagnostics } = status

  out.push(`${plugin.name} v${plugin.version} — ${plugin.stage}`)
  out.push(
    `host services: ${Object.entries(hostServices)
      .map(([key, state]) => `${key}=${state}`)
      .join(', ')}`,
  )
  if (status.hostServiceAliases && Object.keys(status.hostServiceAliases).length > 0) {
    out.push(
      `  alias probes: ${Object.entries(status.hostServiceAliases)
        .map(([key, state]) => `${key}=${state}`)
        .join(', ')}`,
    )
  }
  out.push(
    `delegation: subagents=${subagent.available ? 'available' : 'UNAVAILABLE'} ` +
      `(maxDepth ${subagent.maxDepth}, maxActive ${subagent.maxActiveSubagents})`,
  )
  // THE REVIEW PATH, NOT JUST THE MOUNT PROBE. This is the line that would have exposed A1:
  // status said "subagents present" while workflow_review's own resolution found nothing.
  out.push(`review route: ${subagent.reviewRoute?.detail ?? 'not reported'}`)
  if (subagent.available !== true && subagent.probeAvailable === true) {
    out.push(
      '  NOTE: the mount-time probe saw subagents but the call-time resolver did not — ' +
        'workflow_review would report "the subagents service is unavailable".',
    )
  }
  if (!subagent.available && subagent.singularAlias) {
    out.push('  note: only the singular `subagent` key resolved — the host renamed the service')
  }
  out.push('')
  for (const line of describeProject(project)) out.push(line)
  // Work units are reported only when they EXIST, so a project that has never used one
  // renders exactly as it did before this feature. Every value below comes from a
  // hand-editable directory, so nothing is assumed about its shape — and every value is
  // flattened to one line by `oneLine`, because a directory name or a `phase` field
  // containing a newline would otherwise forge extra lines into a report a model reads.
  const workUnitInfo = status.workUnits && typeof status.workUnits === 'object' ? status.workUnits : {}
  const workUnitList = Array.isArray(workUnitInfo.units) ? workUnitInfo.units : []
  if (workUnitList.length > 0) {
    const describeUnit = unit => {
      const id = typeof unit?.id === 'string' ? oneLine(unit.id) : '(unnamed)'
      if (typeof unit?.phase === 'string') return `${id}@${oneLine(unit.phase)}`
      return unit?.hasState === true ? `${id}@(unreadable)` : `${id}@(empty)`
    }
    out.push(`work units (${workUnitList.length}): ${workUnitList.map(describeUnit).join(', ')}`)
    for (const unit of workUnitList) {
      const problems = Array.isArray(unit?.problems) ? unit.problems : []
      const id = typeof unit?.id === 'string' ? oneLine(unit.id) : '(unnamed)'
      for (const problem of problems) out.push(`  work unit ${id}: ${oneLine(problem)}`)
    }
  }
  const ignoredUnits = Array.isArray(workUnitInfo.ignored) ? workUnitInfo.ignored : []
  if (ignoredUnits.length > 0) {
    out.push(
      `  work unit entries ignored (not valid ids): ${ignoredUnits.map(oneLine).join(', ')}`,
    )
  }
  out.push('')
  out.push(`tier=${effectiveConfig.tier} recipe=${effectiveConfig.recipe ?? 'none'}`)
  out.push(`modules on (${effectiveConfig.modulesOn.length}): ${effectiveConfig.modulesOn.join(', ')}`)
  out.push(
    `approval: ${effectiveConfig.approval.strength} — ${effectiveConfig.approval.meaning} ` +
      `(threshold ${effectiveConfig.approval.riskThreshold}, denyHigh=${effectiveConfig.approval.denyHighAlways}, ` +
      `exempt=[${(Array.isArray(effectiveConfig.approval.exemptTools) ? effectiveConfig.approval.exemptTools : []).join(', ')}])`,
  )
  // An unusable approval section is reported BEFORE anything else about the gate, because
  // everything printed after it describes the fail-closed fallback rather than the
  // configuration the user wrote.
  if (effectiveConfig.approval.usable === false) {
    out.push('  APPROVAL GATE BROKEN — the section was refused; the fail-closed defaults are in force:')
    const problems = Array.isArray(effectiveConfig.approval.problems) ? effectiveConfig.approval.problems : []
    for (const problem of problems) out.push(`    ${problem}`)
  }
  // A STRENGTH THAT CANNOT BE SATISFIED MUST NOT HIDE BEHIND A HEALTHY-LOOKING `approval:`
  // LINE. `ask-user` (and `llm-then-user`) needs a human decision; in a session whose approval
  // policy is `never` the prompt is never shown and the request is rejected automatically —
  // and `dsh-tools` reports that rejection as `the user rejected tool "<name>"`, which is
  // indistinguishable from a human declining. The state is DETECTED where the environment
  // allows it and stated as an explicit IF where it does not, because a claim the plugin
  // cannot check is worse than a conditional one. The remedy travels with the warning: the
  // configuration is the thing that has to change, so it is the thing the user must be told.
  const promptChannel =
    effectiveConfig.approval.promptChannel && typeof effectiveConfig.approval.promptChannel === 'object'
      ? effectiveConfig.approval.promptChannel
      : {}
  const needsPrompt =
    effectiveConfig.approval.strength === 'ask-user' || effectiveConfig.approval.strength === 'llm-then-user'
  const channelDetail =
    typeof promptChannel.detail === 'string' && promptChannel.detail.length > 0
      ? promptChannel.detail
      : 'the reason is unknown'
  if (needsPrompt && promptChannel.state === 'disabled') {
    out.push(
      `  APPROVAL NOT SATISFIABLE HERE — ${channelDetail}, so the resolved strength ` +
        `"${effectiveConfig.approval.strength}" can never be satisfied: every call this gate asks about is denied ` +
        'automatically, and that denial is reported as if a human had rejected it. ' +
        `What to do instead: ${APPROVAL_REMEDY}.`,
    )
  } else if (needsPrompt && promptChannel.state !== 'askable') {
    out.push(
      `  approval satisfaction UNKNOWN — this report could not read the session's approval policy (${channelDetail}). ` +
        `IF approval prompts are unavailable in this session, the resolved strength "${effectiveConfig.approval.strength}" ` +
        'cannot be satisfied: every call this gate asks about is auto-denied, and that denial is reported as if a human ' +
        `had rejected it. What to do instead: ${APPROVAL_REMEDY}.`,
    )
  }
  // THE MONOTONIC GATE, MADE VISIBLE. A file that asks for a weaker gate is not the gate that
  // runs; hiding that difference is how "the file says llm-only" becomes a false report.
  const monotonic = effectiveConfig.approval.monotonic ?? {}
  if (monotonic.optedInMissing === true) {
    out.push(
      '  OPT-IN FILE MISSING — this project was opted in earlier in this session and the file ' +
        'has since disappeared. The approval gate stays active until a restart; deleting the file ' +
        'is not a way to switch it off mid-session.',
    )
  }
  if (monotonic.downgradeIgnored === true) {
    for (const notice of Array.isArray(monotonic.notices) ? monotonic.notices : []) {
      out.push(`  DOWNGRADE IGNORED — ${oneLine(notice)}`)
    }
  }
  if (Number.isInteger(promptChannel.autoDenials) && promptChannel.autoDenials > 0) {
    out.push(
      `  approval auto-denials this load: ${promptChannel.autoDenials} call(s) denied because no approval prompt could be answered`,
    )
  }
  if (effectiveConfig.approval.reviewer?.needed) {
    out.push(
      effectiveConfig.approval.reviewer.runnable
        ? `  approval reviewer: runnable (${effectiveConfig.approval.reviewer.calls ?? 0} reviewer call(s) this load)`
        : `  approval reviewer: NOT runnable — ${effectiveConfig.approval.reviewer.blockedBy}`,
    )
  }
  // THE SHIPPED LAYER'S WARNING, VERBATIM — including the fact that it provides no file
  // sandbox. Printed, never summarised, whenever human authorization has been removed.
  const approvalWarnings = Array.isArray(effectiveConfig.approval.warnings)
    ? effectiveConfig.approval.warnings
    : []
  for (const warning of approvalWarnings) out.push(`  approval warning: ${warning}`)
  // Every value here comes from a file a user can hand-edit, so a renderer must never
  // assume a shape. `mustPass` was joined directly, so a project file containing
  // `mustPass: correctness` (a plain string — reachable through the whole-section write
  // that used to skip validation) made `workflow_status` THROW
  // "mustPass.join is not a function". The host turns a throwing render into an opaque
  // projection error, so the model saw no status at all. Report the malformation
  // instead: that is the diagnostic the user needs.
  const list = (value, fallback) => (Array.isArray(value) ? value : fallback)
  const showValue = value => (typeof value === 'string' ? value : describeValue(value))

  out.push(
    `evaluator: independent=${effectiveConfig.evaluator.independent} bar=${showValue(effectiveConfig.evaluator.bar)} ` +
      `mustPass=[${list(effectiveConfig.evaluator.mustPass, []).join(', ')}]`,
  )
  // Surface an unusable gate in the STATUS rather than only at review time, so a project
  // whose reviews will be refused cannot look healthy until someone tries one.
  const gate = readEvaluatorGate(effectiveConfig.evaluator, {
    bar: DEFAULT_CONFIG.evaluator.bar,
    maxRounds: DEFAULT_CONFIG.evaluator.maxRounds,
    dimensions: DEFAULT_CONFIG.evaluator.dimensions,
    mustPass: DEFAULT_CONFIG.evaluator.mustPass,
  })
  if (!gate.ok) {
    out.push(`  GATE BROKEN — ${gate.problems.join('; ')}`)
  }
  // Whether the gate can actually run. A configured-but-unrunnable review is the
  // dangerous state: it looks like a safety net while nothing enforces it.
  out.push(
    effectiveConfig.evaluator.canReview
      ? 'independent review: available via workflow_review (subagents resolved at call time)'
      : `independent review: NOT runnable — ${effectiveConfig.evaluator.blockedBy}`,
  )
  out.push(`context isolation: ${effectiveConfig.context.isolation ? 'on' : 'off'}`)
  // THE DEPTH IS PRINTED WHERE THE OPERATOR ALREADY LOOKS. Reported before the project-file
  // section, because it is the answer to "what level of verification is this work under" and
  // everything after it is supporting detail.
  for (const line of renderVerificationStatus(effectiveConfig.verification)) out.push(line)
  out.push('')
  const projectFile = status.projectFile
  if (projectFile?.present) {
    const overrides = projectFile.overrides && Object.keys(projectFile.overrides).length
    out.push(`project overrides: ${overrides ? Object.keys(projectFile.overrides).join(', ') : '(none)'}`)
    for (const problem of projectFile.problems ?? []) out.push(`  file problem: ${problem}`)
  }
  if (!project.optedIn) {
    out.push('This project has NOT opted in — the workflow is inert here by design.')
  }

  // Host-shape diagnostics. The exec/context shapes are host-owned and not a
  // published contract, so a mismatch is reported here instead of being guessed at.
  if (diagnostics) {
    out.push('')
    out.push('diagnostics:')
    out.push(`  workspace from: ${diagnostics.workspaceSource}`)
    for (const candidate of diagnostics.workspaceCandidates ?? []) {
      out.push(`    - ${candidate.label} = ${candidate.value}`)
    }
    for (const line of diagnostics.exec ?? []) out.push(`  ${line}`)
  }

  for (const step of status.nextSteps) out.push(`next: ${step}`)

  return out.join('\n')
}

/**
 * Build the `workflow_status` tool definition.
 *
 * Two shape rules the shipped registry enforces, and which a plain read of the
 * authoring DSL does not reveal:
 *
 *  - `output.schema` is validated by `assertSupportedJsonSchema`, whose accepted
 *    `type` values are only object/array/string/number/integer/boolean/null. The
 *    author-facing `{ type: "json" }` shape (what `defineTool(...)` transforms for
 *    you) is REJECTED here, so a structured status is declared as an object.
 *  - `parameters` must already be a JSON Schema object (`type: "object"` plus
 *    `properties`), not the flat `{ name: { type, description } }` authoring DSL.
 *
 * @returns A definition accepted by `ctx.tools.register()`.
 */
export function buildToolDefinition(options) {
  return {
    name: 'workflow_status',
    description:
      'Inspect the dsh-workflow harness state for the current project: whether the project opted in ' +
      '(.dsh/workflow.yml present), the effective tier and switches, approval strength, evaluator ' +
      'gate, and the host services the plugin can reach. Read-only. Use it before assuming any ' +
      'project structure or workflow setting.',
    parameters: {
      type: 'object',
      properties: {
        verbose: {
          type: 'boolean',
          description: 'Include the full effective configuration instead of the summary.',
        },
        // PRESENT SO IT IS NOT SILENTLY DROPPED. `workspace_dir` was missing from this
        // schema while `workflow_advance` and `workflow_review` both accepted it, so a
        // delegated child that passed it here had the argument discarded with no error and
        // reported on the wrong project. Silent parameter dropping is a trap precisely for
        // the delegated-child pattern this plugin recommends, where the session cwd and the
        // project under work are routinely different.
        workspace_dir: {
          type: 'string',
          description: 'Absolute path to the project. Defaults to the current workspace.',
        },
        // ---- risk-based verification depth ----
        //
        // DECLARED HERE, OR THE HOST DROPS IT SILENTLY — the same rule that made a missing
        // `workspace_dir` write to the wrong project. These three let an operator ask "what depth
        // would this change resolve to" BEFORE running the loop, which is the whole point of
        // surfacing the policy: a depth nobody can see in advance is a depth nobody chooses.
        class: {
          type: 'string',
          enum: [...CHANGE_CLASS_IDS],
          description:
            'The change class to resolve a depth for: docs, ui, logic, security. Read-only here: ' +
            'workflow_status reports what the class would resolve to and refuses nothing.',
        },
        changed_files: {
          type: 'array',
          items: { type: 'string' },
          description:
            'The files this change touches, so the class can be CHECKED rather than believed. A ' +
            'class shallower than these files require is reported as refused.',
        },
        diff: {
          type: 'string',
          description:
            'The diff, if you have it. Its `diff --git` / `+++` headers are read for file paths, so a ' +
            'diff alone is enough evidence to resolve a depth.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: renderStatus(value) }],
    },
    async execute(args, exec) {
      return toLosslessJson(
        buildStatus({
          ...options,
          exec,
          verbose: args?.verbose === true,
          workspaceDir: args?.workspace_dir,
          declaredClass: args?.class,
          changedFiles: args?.changed_files,
          diff: args?.diff,
        }),
      )
    },
  }
}

/**
 * Build the verification-depth section of a status payload.
 *
 * THE REPORT IS ALWAYS SHAPED THE SAME WAY, whatever the caller supplied, so the renderer never
 * has to guess. `resolution` is null when nothing could be resolved — and "could not resolve" is
 * reported as exactly that rather than being dressed as a shallow class, because a status line
 * claiming depth 0 while the policy is `enforced` would describe a decision that was never made.
 *
 * @param config - the effective configuration.
 * @param options - `{ declaredClass, changedFiles, diff }` from the call's arguments.
 * @returns a JSON-serialisable section.
 */
export function buildVerificationStatus(config, options = {}) {
  const section = readVerificationPolicy(config?.verification)
  const requested = options.declaredClass !== undefined || options.changedFiles !== undefined ||
    options.diff !== undefined

  // NOTHING ASKED, NOTHING CLAIMED. With no class and no file list the resolver would still return
  // an answer (the fail-closed one), and printing that as "this project's depth" would be wrong:
  // it describes no particular piece of work. The table of classes is offered instead, so an
  // operator can see the policy exists without being told a depth for a change they did not name.
  const selfProject = options.selfProject !== false
  const resolution = requested
    ? resolveVerificationDepth({
        declaredClass: options.declaredClass,
        changedFiles: options.changedFiles,
        diff: options.diff,
        policy: section.policy,
        classification: section.classification,
        classificationUsable: section.classificationUsable,
        classificationProblems: section.classificationProblems,
        selfProject,
      })
    : null

  const harnessPlan = resolution === null
    ? null
    : harnessesForDepth({ depth: resolution.depth, files: resolution.files })

  return {
    policy: section.policy,
    policyUsable: section.usable,
    policyProblems: section.problems,
    confirmation: section.confirmation,
    report: section.report,
    enforcing: verificationGates(section.policy),
    securityClass: 'security',
    securityNotDegradable: true,
    // WHICH CLASSIFICATION IS IN FORCE, INCLUDING "NONE BECAUSE THE SECTION WAS INVALID".
    // Without this, an external project cannot tell why its ordinary `.js` was graded security.
    classification: section.classification,
    classificationUsable: section.classificationUsable,
    classificationProblems: section.classificationProblems,
    selfProject,
    // The class table itself, so an operator can see the vocabulary without reading the source.
    classDepths: Object.fromEntries(
      CHANGE_CLASS_IDS.map(id => [
        id,
        {
          shallowest: CHANGE_CLASSES[id].shallowest,
          humanCheck: CHANGE_CLASSES[id].humanCheck === true,
          independentReview: CHANGE_CLASSES[id].independentReview,
          summary: CHANGE_CLASSES[id].summary,
        },
      ]),
    ),
    resolution: resolution === null
      ? null
      : {
          requested: true,
          resolved: resolution.resolved,
          declared: resolution.declared,
          declaredRaw: resolution.declaredRaw,
          derived: resolution.derived,
          evidence: resolution.evidence,
          depth: resolution.depth,
          depthLabel: resolution.depthLabel,
          refused: resolution.refused,
          refusal: resolution.refusal,
          escalated: resolution.escalated,
          files: resolution.files,
          unknownFiles: resolution.unknownFiles,
          uiTouched: resolution.uiTouched,
          humanCheckRequired: resolution.humanCheckRequired,
          requiredHarnesses: harnessPlan.required,
          harnessNote: harnessPlan.note,
        },
    nextSteps: resolution === null
      ? [
          'Call workflow_status with changed_files (or a diff) and optionally class=... to see the ' +
            'depth this change resolves to before running the loop.',
          'workflow_review takes the same arguments: class is a PROPOSAL that is checked against ' +
            'changed_files, so declaring a shallower class than the files require is refused.',
        ]
      : null,
  }
}

/**
 * Render the verification-depth section of a status report.
 *
 * A RENDERER MUST NEVER ASSUME THE SHAPE OF HAND-EDITABLE DATA, and every value here can come
 * from a hand-edited `.dsh/workflow.yml` (the class table), a model-authored argument (the file
 * list) or a filesystem scan (the harness list). Each is read through a type check and flattened
 * to one line, because a `changed_files` entry containing a newline would otherwise forge extra
 * lines into a report the model reads as instructions.
 *
 * @param verification - the section from {@link buildVerificationStatus}.
 * @returns lines to print; empty when there is nothing to say.
 */
export function renderVerificationStatus(verification) {
  if (!isPlainObject(verification)) return []
  const out = []
  const one = value => String(value).replace(/[\r\n\u2028\u2029]+/g, ' ').slice(0, 300)

  const policy = typeof verification.policy === 'string' ? verification.policy : '(unreadable)'
  out.push(
    `verification depth: policy=${policy}` +
      (verification.enforcing === true ? ' (ENFORCED)' : '') +
      `, confirmation=${one(verification.confirmation ?? 'on-override')}`,
  )
  if (verification.policyUsable === false) {
    out.push('  VERIFICATION SECTION BROKEN — refused; the strictest usable settings are in force:')
    for (const problem of Array.isArray(verification.policyProblems) ? verification.policyProblems : []) {
      out.push(`    ${one(problem)}`)
    }
  }
  if (policy === 'off') {
    out.push(
      '  the policy is off, so a class declaration changes NOTHING about what runs; the depth below ' +
        'is reported for information only. Set verification.policy=advisory to have it checked, or ' +
        'enforced to have a contradicted class refused and the depth confirmed by the user.',
    )
  }
  if (isPlainObject(verification.classification)) {
    const sources = Array.isArray(verification.classification.sources) ? verification.classification.sources : []
    const security = Array.isArray(verification.classification.security) ? verification.classification.security : []
    const ui = Array.isArray(verification.classification.ui) ? verification.classification.ui : []
    if (sources.length + security.length + ui.length > 0) {
      out.push(
        `  project classification: sources=[${sources.map(one).join(', ')}] ` +
          `security=[${security.map(one).join(', ')}] ui=[${ui.map(one).join(', ')}] ` +
          `allowUnknownSources=${verification.classification.allowUnknownSources === true}`,
      )
    }
    if (verification.classificationUsable === false) {
      out.push(
        '  PROJECT CLASSIFICATION UNUSABLE — ' +
          (Array.isArray(verification.classificationProblems)
            ? verification.classificationProblems.slice(0, 3).map(one).join('; ')
            : 'no reason recorded') +
          '; the fail-closed default is in force.',
      )
    }
  }
  out.push(
    '  classes: docs -> unit only; ui -> unit + every covering harness + a HUMAN must look ' +
      '(rendering is not testable); logic -> unit + every covering harness; security -> everything ' +
      '+ independent review, NOT degradable at any setting.',
  )

  const resolution = isPlainObject(verification.resolution) ? verification.resolution : null
  if (resolution === null) {
    out.push(
      '  no change class was resolved: pass changed_files (or a diff) to see the depth this change ' +
        'resolves to. Nothing is assumed in the meantime.',
    )
  } else {
    const depth = Number.isInteger(resolution.depth) ? resolution.depth : '?'
    out.push(
      `  resolved: class "${one(resolution.resolved ?? '(unresolved)')}" at depth ${depth}` +
        `${resolution.depthLabel ? ` (${one(resolution.depthLabel)})` : ''}`,
    )
    out.push(
      `    declared "${one(resolution.declared ?? '(none)')}"` +
        `${resolution.derived ? `, evidence implies "${one(resolution.derived)}"` : ''}` +
        `, evidence from ${one(resolution.evidence ?? 'none')}`,
    )
    if (resolution.refused === true) {
      out.push(
        policy === 'enforced'
          ? `    CLASS REFUSED — ${one(resolution.refusal ?? 'no reason was recorded')}`
          : `    DECLARATION CONTRADICTED (policy ${policy}: reported, not blocking; enforced ` +
            `would refuse) — ${one(resolution.refusal ?? 'no reason was recorded')}`,
      )
    }
    if (typeof resolution.escalated === 'string' && resolution.escalated !== '') {
      out.push(`    depth raised: ${one(resolution.escalated)}`)
    }
    const files = Array.isArray(resolution.files) ? resolution.files : []
    if (files.length > 0) out.push(`    files read as evidence: ${files.slice(0, 6).map(one).join(', ')}`)
    const unknown = Array.isArray(resolution.unknownFiles) ? resolution.unknownFiles : []
    if (unknown.length > 0) {
      out.push(
        `    UNCLASSIFIED source file(s) treated as a security surface: ${unknown.slice(0, 4).map(one).join(', ')}`,
      )
    }
    const harnesses = Array.isArray(resolution.requiredHarnesses) ? resolution.requiredHarnesses : []
    out.push(
      harnesses.length > 0
        ? `    mutation harnesses required: ${harnesses.map(one).join(', ')}`
        : `    mutation harnesses required: none — ${one(resolution.harnessNote ?? 'not determined')}`,
    )
    if (resolution.humanCheckRequired === true) {
      out.push(
        '    a HUMAN must look at the rendered result: this change touches presentation and no test ' +
          'in this project measures it. workflow_review refuses without human_check: true.',
      )
    }
    if (depth === MAX_VERIFICATION_DEPTH) {
      out.push('    independent review is REQUIRED at this depth and cannot be confirmed away.')
    }
  }
  for (const step of Array.isArray(verification.nextSteps) ? verification.nextSteps : []) {
    out.push(`  next: ${one(step)}`)
  }
  return out
}

/**
 *
 * Idempotent by construction — the file is only touched when its content would
 * change, so re-running init never rewrites or reformats an existing file.
 *
 * @returns A definition accepted by `ctx.tools.register()`.
 */
export function buildInitToolDefinition(options) {
  return {
    name: 'workflow_init',
    description:
      'Opt the current project into dsh-workflow by creating .dsh/workflow.yml. Idempotent: an ' +
      'existing file is never rewritten unless the requested changes differ. Projects without this ' +
      'file stay completely inert, so this is the single action that enables the workflow. ' +
      'Returns the file path and the resulting effective configuration.',
    parameters: {
      type: 'object',
      properties: {
        tier: {
          type: 'string',
          enum: TIERS,
          description: 'Workflow tier to write: minimal, standard (default), or strict.',
        },
        recipe: {
          type: 'string',
          description: 'Optional named recipe that overrides the tier: hotfix, spike, refactor, docs, review.',
        },
        require_opt_in: {
          type: 'boolean',
          description: 'Keep the opt-in check on the project file (default true). Set false only for a project that should always run the workflow.',
        },
        dry_run: {
          type: 'boolean',
          description: 'Report what would be written without touching the file.',
        },
        // THE PARAMETER MUST BE DECLARED OR THE HOST DROPS IT SILENTLY. Its absence here meant
        // `workflow_init workspace_dir=X` opted in the session cwd instead of X — a write to
        // the wrong project with no error to show for it.
        workspace_dir: {
          type: 'string',
          description: 'Absolute path to the project to opt in. Defaults to the current workspace.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: renderInit(value) }],
    },
    async execute(args, exec) {
      return toLosslessJson(
        runInit({
          ...options,
          exec,
          requested: {
            tier: args?.tier,
            recipe: args?.recipe,
            requireOptIn: args?.require_opt_in,
          },
          dryRun: args?.dry_run === true,
          workspaceDir: args?.workspace_dir,
        }),
      )
    },
  }
}

/**
 * Build the `workflow_set` tool definition: change one project-level parameter.
 *
 * Only the requested path is persisted; everything else keeps falling back to the
 * built-in defaults and the patch row, so the project file stays a record of
 * deliberate choices.
 *
 * @returns A definition accepted by `ctx.tools.register()`.
 */
export function buildSetToolDefinition(options) {
  return {
    name: 'workflow_set',
    description:
      'Read or change one dsh-workflow parameter for the current project, persisted in ' +
      '.dsh/workflow.yml. The project file must already exist (run workflow_init first) so that a ' +
      'stray call can never opt a project in by accident. Use dot paths such as "tier", ' +
      '"modules.planner", "approval.strength", or "evaluator.bar". Omit value to read the current ' +
      'effective value without writing. A write that would WEAKEN the approval or verification gate ' +
      'is not applied on the model\'s word: it needs a real user confirmation through the host, and ' +
      'is refused in a session that cannot ask one (a delegated child, or no answerer).',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Dot path of the parameter, e.g. "modules.planner" or "approval.strength".',
        },
        value: {
          description: 'New value. Omit to read instead of write. Use null to unset a project override.',
        },
        dry_run: {
          type: 'boolean',
          description: 'Validate and report the change without writing the file.',
        },
        // DECLARED, OR THE HOST DROPS IT SILENTLY. Without this, `workflow_set
        // workspace_dir=X path=approval.strength ...` changed the SESSION CWD's approval
        // strength instead of X's — a security-relevant write to the wrong project.
        workspace_dir: {
          type: 'string',
          description: 'Absolute path to the project. Defaults to the current workspace.',
        },
      },
      required: ['path'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: renderSet(value) }],
    },
    async execute(args, exec) {
      const base = {
        ...options,
        exec,
        path: typeof args?.path === 'string' ? args.path : '',
        value: Object.hasOwn(args ?? {}, 'value') ? args.value : undefined,
        hasValue: Object.hasOwn(args ?? {}, 'value'),
        dryRun: args?.dry_run === true,
        workspaceDir: args?.workspace_dir,
      }

      const first = runSet(base)
      // A dry run never asks: it is a report, and the caller can inspect the proposed delta.
      if (first.status !== 'confirmation-required' || first.dryRun === true) {
        return toLosslessJson(first)
      }

      // THE ASK IS THE AUTHORIZATION. There is no boolean flag a model can set; the token is
      // minted only from a real answer and is bound to this exact change by its question id.
      const asked = await askForConfirmation({
        service: resolveUserQuestions(options, exec),
        exec,
        questionId: first.confirmationQuestionId,
        header: 'Approval gate change',
        question: buildApprovalWriteQuestion(first),
        approveLabel: APPROVAL_WRITE_APPROVE_LABEL,
        rejectLabel: APPROVAL_WRITE_REJECT_LABEL,
        approveDescription: 'Write this change to .dsh/workflow.yml.',
        rejectDescription: 'Keep the current gate; change nothing.',
      })
      if (asked.ok !== true) {
        return toLosslessJson({
          ...first,
          ok: false,
          // Preserve the distinction: a user who DECLINED is not the same environment as a
          // child that cannot be asked. Both refuse the write; the reason must say which.
          status: typeof asked.status === 'string' ? asked.status : 'confirmation-unavailable',
          reason: asked.reason,
          selected: asked.selected ?? null,
        })
      }

      return toLosslessJson(runSet({ ...base, confirmation: asked.confirmation }))
    },
  }
}

/**
 * Validate one requested setting value against the option vocabulary.
 *
 * A write that persisted an unknown enum value would only show up as a warning in
 * a later status report, so invalid values are refused before the file is touched.
 *
 * @param segments - the dot path split into parts.
 * @param value - the requested value.
 * @returns An error string, or null when acceptable.
 */
export function validateSettingValue(segments, value) {
  if (value === null || value === undefined) return null // unset is always allowed

  const path = segments.join('.')
  const allowed = {
    tier: TIERS,
    recipe: RECIPES,
    'approval.strength': APPROVAL_STRENGTHS,
    // `approval.riskThreshold` used to have NO rule here, so `workflow_set
    // path=approval.riskThreshold value=banana` was accepted and only ever surfaced as a
    // warning in a later status report. The gate refuses that value; the writer must too.
    'approval.riskThreshold': RISK_LEVELS,
  }
  if (allowed[path]) {
    if (!allowed[path].includes(value)) {
      return `"${value}" is not a valid value for ${path}; expected one of ${allowed[path].join(', ')}`
    }
    return null
  }

  // Type expectations for the rest of the writable surface.
  const booleans = [
    'requireOptIn',
    'context.requireBootstrap',
    'acceptance.negotiateBeforeBuild',
    'evaluator.independent',
    'verifier.stopOnFirstFailure',
    'guards.forbidTestEdits',
    'guards.forbidNewDeps',
    'guards.requireHumanOnFatal',
    'approval.denyHighAlways',
    'escalation.onContextOverflow',
    'escalation.onScopeCreep',
    'retireCheck.enabled',
    'retireCheck.autoSuggest',
    'signoff.beforeGenerate',
    'signoff.beforeExpensiveBuild',
    'signoff.beforeBulkEdit',
  ]
  if (booleans.includes(path)) {
    return typeof value === 'boolean' ? null : `${path} expects true or false, got ${typeof value}`
  }
  if (path.startsWith('modules.')) {
    return typeof value === 'boolean'
      ? null
      : `${path} expects true or false (each module is an on/off switch), got ${typeof value}`
  }
  if (path === 'retireCheck.everyDays') {
    // The remaining `retireCheck` fields were validated and this one was not, so
    // `workflow_set path=retireCheck.everyDays value=banana` was persisted and then reported by
    // `workflow_gc` as the intended review cadence. A cadence that is not a whole number of days
    // is a configuration error, and configuration errors are refused here, not normalised.
    //
    // DELEGATED to the section's own reader, so this rule and the whole-section rule below
    // cannot drift apart — the divergence class this change set exists to remove.
    const verdict = readRetireCheck({ everyDays: value }, DEFAULT_CONFIG.retireCheck)
    return verdict.ok ? null : verdict.problems.join('; ')
  }
  if (path === 'evaluator.bar') {
    // DELEGATED, not re-derived. This is the writer side of the same gate the reviewer
    // reads, and the two used to be implemented separately — which is how
    // `workflow_set path=evaluator.bar value=""` could persist a value the gate then
    // treated as `bar: 0`, silently disabling every veto. `checkBar` is the single
    // definition; a value it rejects must never reach the file.
    const verdict = checkBar(value)
    return verdict.ok
      ? null
      : `evaluator.bar expects a number from 0 to 10 (${verdict.detail})`
  }
  if (path === 'evaluator.maxRounds') {
    const verdict = checkMaxRounds(value)
    return verdict.ok ? null : `evaluator.maxRounds expects a whole number of 1 or more (${verdict.detail})`
  }
  if (path === 'evaluator.dimensions' || path === 'evaluator.mustPass') {
    // The reviewer refuses a mixed list, so the writer must too: persisting a list the
    // gate will reject produces a project that looks configured and refuses every review.
    //
    // `allowEmpty` MUST match `readEvaluatorGate`, exactly as in `decideVerdict`. It did
    // not: this rule refused `[]` for BOTH paths while the whole-section rule
    // (`path === 'evaluator'`, which runs `readEvaluatorGate`) accepted `{mustPass: []}`.
    // Two writers of one setting disagreeing is the divergence class this change set out
    // to remove, so the predicate mirrors the gate: an empty veto set is a coherent
    // choice (average-only grading), an empty scored set is not (nothing could be graded).
    const verdict = readStringList(path, value, [], {
      allowEmpty: path === 'evaluator.mustPass',
    })
    return verdict.ok ? null : verdict.detail
  }
  if (path === 'approval.exemptTools') {
    // Delegated to the gate's own list reader, for the same reason the evaluator lists
    // are: a list the gate refuses must never be persisted. An empty list is a coherent
    // choice here (no exemptions), so `allowEmpty` is what the gate uses.
    const verdict = readStringList('approval.exemptTools', value, [], { allowEmpty: true })
    return verdict.ok ? null : verdict.detail
  }
  if (path === 'subagent.maxActiveSubagents') {
    // Same rule: '8' is a string, not a limit the host will honour as written.
    return typeof value === 'number' && Number.isInteger(value) && value >= 1
      ? null
      : `subagent.maxActiveSubagents expects an integer of 1 or more, got ${JSON.stringify(value)}`
  }
  if (path === 'subagent.maxDepth') {
    // The cap is 2, not 1, and the bound belongs to `config.js` so the two cannot drift.
    //
    // Pinning to 1 forbade the architecture the plugin recommends: `maxDepth` is an
    // ABSOLUTE tree ceiling, so 1 also stops a delegated orchestrator (depth 1) from
    // starting its reviewer (depth 2) — pushing every review back into the main
    // conversation. 2 permits exactly that one level and nothing deeper.
    return Number.isInteger(value) && value >= 1 && value <= MAX_SUBAGENT_DEPTH
      ? null
      : `subagent.maxDepth must be an integer from 1 to ${MAX_SUBAGENT_DEPTH}. ` +
          '1 forbids a delegated orchestrator from starting a reviewer (forcing reviews into ' +
          `the main context); ${MAX_SUBAGENT_DEPTH} permits it and nothing deeper. Got ${JSON.stringify(value)}.`
  }

  // A WHOLE-SECTION WRITE MUST BE VALIDATED AS ITS SECTION.
  //
  // `evaluator` is a writable top-level key, so `workflow_set path=evaluator
  // value={mustPass:'correctness'}` reached this function with segments `['evaluator']`,
  // matched no rule, and fell through to `return null` — ACCEPT. The per-key rule
  // `evaluator.mustPass` would have refused that value, but the section write bypassed
  // it entirely and persisted `mustPass: correctness`. That falsified the whole point of
  // this validator and then crashed `workflow_status` on the state it created.
  //
  // The rule is therefore: a section write is re-validated by the SAME predicate its
  // readers use. A section is not a free pass just because it is a valid section name.
  if (path === 'evaluator') {
    if (value === null) return null // unset
    if (!isPlainObject(value)) {
      return `evaluator must be a section (an object), got ${typeof value}`
    }
    const gate = readEvaluatorGate(value, {
      bar: DEFAULT_CONFIG.evaluator.bar,
      maxRounds: DEFAULT_CONFIG.evaluator.maxRounds,
      dimensions: DEFAULT_CONFIG.evaluator.dimensions,
      mustPass: DEFAULT_CONFIG.evaluator.mustPass,
    })
    return gate.ok ? null : `evaluator is not a usable gate: ${gate.problems.join('; ')}`
  }

  // A WHOLE-SECTION APPROVAL WRITE IS RE-VALIDATED AS A SECTION, exactly like `evaluator`.
  // This is not hypothetical. The settings panel writes the whole `approval` object on
  // every change (`{ ...(value.approval ?? {}), strength }`), and `workflow_set
  // path=approval value={strength:'maybe'}` reaches this function with segments
  // `['approval']`. Without this rule the write was accepted, the gate refused the
  // section, and the fail-closed defaults silently replaced the strength the user chose.
  if (path === 'approval') {
    if (value === null) return null // unset
    if (!isPlainObject(value)) {
      return `approval must be a section (an object), got ${typeof value}`
    }
    const gate = readApprovalGate(value, DEFAULT_CONFIG.approval)
    return gate.usable ? null : `approval is not a usable gate: ${gate.problems.join('; ')}`
  }

  // A WHOLE-SECTION `retireCheck` WRITE IS RE-VALIDATED AS A SECTION, for the same reason
  // `evaluator` and `approval` are, and by the same reader the per-key rule uses.
  if (path === 'retireCheck') {
    if (value === null) return null // unset
    if (!isPlainObject(value)) {
      return `retireCheck must be a section (an object), got ${typeof value}`
    }
    const verdict = readRetireCheck(value, DEFAULT_CONFIG.retireCheck)
    return verdict.ok ? null : `retireCheck is not a usable section: ${verdict.problems.join('; ')}`
  }

  // Any other section write still has to be an object, so a scalar cannot replace a
  // whole section and crash every reader of it.
  if (value !== null && !path.includes('.') && segments.length === 1) {
    return isPlainObject(value) ? null : `${path} must be a section (an object), got ${typeof value}`
  }

  return null
}

/**
 * Opt a project in by creating or updating `.dsh/workflow.yml`.
 *
 * @param options - `{ exec, config, requested, dryRun }`.
 * @returns A plain result object.
 */
export function runInit({ exec, config: rowConfig, requested = {}, dryRun = false, workspaceDir }) {
  const workspace = resolveWorkspace({ exec, workspaceDir })
  const projectDir = workspace.dir
  if (!projectDir) {
    return { ok: false, error: 'no project directory could be resolved for this session' }
  }

  const existing = readWorkflowFile(projectDir, parseWorkflowYaml)
  const next = isPlainObject(existing.value) ? structuredClone(existing.value) : {}
  const changes = []

  if (requested.tier !== undefined) {
    const error = validateSettingValue(['tier'], requested.tier)
    if (error) return { ok: false, error }
    if (next.tier !== requested.tier) {
      changes.push(`tier: ${existing.value?.tier ?? '(default)'} -> ${requested.tier}`)
      next.tier = requested.tier
    }
  }
  if (requested.recipe !== undefined && requested.recipe !== null) {
    const error = validateSettingValue(['recipe'], requested.recipe)
    if (error) return { ok: false, error }
    if (next.recipe !== requested.recipe) {
      changes.push(`recipe: ${existing.value?.recipe ?? '(none)'} -> ${requested.recipe}`)
      next.recipe = requested.recipe
    }
  }
  if (requested.requireOptIn !== undefined) {
    const error = validateSettingValue(['requireOptIn'], requested.requireOptIn)
    if (error) return { ok: false, error }
    if (next.requireOptIn !== requested.requireOptIn) {
      changes.push(`requireOptIn: ${existing.value?.requireOptIn ?? '(default true)'} -> ${requested.requireOptIn}`)
      next.requireOptIn = requested.requireOptIn
    }
  }

  const { config, sources } = resolveEffectiveConfig(rowConfig, next)
  const warnings = configWarnings(config)

  // Belt and braces: the vocabulary checks above cover the requested fields, but a
  // pre-existing file could already hold an invalid value; do not write that back.
  if (warnings.some(warning => warning.startsWith('unknown '))) {
    const offending = warnings.find(warning => warning.startsWith('unknown '))
    return { ok: false, error: `refusing to write an invalid configuration: ${offending}` }
  }

  let written = { path: null, text: '', written: false, changed: false }
  try {
    written = writeWorkflowFile(projectDir, next, { dryRun })
  } catch (error) {
    return { ok: false, error: `could not write ${WORKFLOW_RELATIVE_PATH}: ${error?.message ?? error}` }
  }

  return {
    ok: true,
    alreadyPresent: existing.present,
    dryRun,
    path: written.path,
    changed: written.changed,
    wrote: written.written,
    changes,
    warnings,
    configSources: sources,
    effectiveTier: config.tier,
    text: written.text,
  }
}

// ---------------------------------------------------------------------------
// gate-weakening writes
// ---------------------------------------------------------------------------

/** The exact labels a user must choose for a weakening `workflow_set` to write. */
const APPROVAL_WRITE_APPROVE_LABEL = 'Apply this approval-gate change'
const APPROVAL_WRITE_REJECT_LABEL = 'Keep the current gate'

/** Strength index: lower is stricter. Unknown -> ask-user (0). */
function strengthIndex(value) {
  const index = APPROVAL_STRENGTHS.indexOf(value)
  return index === -1 ? 0 : index
}

/** Threshold index: lower is stricter. Unknown -> low (0). */
function thresholdIndex(value) {
  const index = RISK_LEVELS.indexOf(value)
  return index === -1 ? 0 : index
}

function gateSnapshot(gate) {
  return {
    strength: typeof gate?.strength === 'string' ? gate.strength : null,
    riskThreshold: typeof gate?.riskThreshold === 'string' ? gate.riskThreshold : null,
    denyHighAlways: gate?.denyHighAlways === true,
    exemptTools: Array.isArray(gate?.exemptTools) ? [...gate.exemptTools].sort() : [],
  }
}

function evaluatorSnapshot(config) {
  const gate = readEvaluatorGate(config?.evaluator, {
    bar: DEFAULT_CONFIG.evaluator.bar,
    maxRounds: DEFAULT_CONFIG.evaluator.maxRounds,
    dimensions: DEFAULT_CONFIG.evaluator.dimensions,
    mustPass: DEFAULT_CONFIG.evaluator.mustPass,
  })
  return {
    independent: config?.evaluator?.independent !== false,
    bar: typeof gate.bar === 'number' ? gate.bar : null,
    dimensions: Array.isArray(gate.dimensions) ? [...gate.dimensions].sort() : [],
    mustPass: Array.isArray(gate.mustPass) ? [...gate.mustPass].sort() : [],
    usable: gate.ok === true,
  }
}

function verificationPolicyOf(config) {
  return readVerificationPolicy(config?.verification).policy
}

/**
 * List every axis on which the proposed configuration is WEAKER than the effective one.
 *
 * THE CHECK LIVES HERE, IN THE WRITER, not in the tool description. A model can call the tool
 * with any arguments it likes; only the writer can compare the proposed gate with the gate that
 * is actually running and refuse the downgrade. The approval axes are the security-sensitive
 * ones; the evaluator and verification axes are the same class (they decide whether a review
 * runs at all), so they are covered by the same confirmation rather than by a second mechanism
 * that could drift.
 */
function gateWeakeningReasons(currentConfig, afterConfig, currentApproval, afterApproval) {
  const reasons = []
  if (strengthIndex(afterApproval.strength) > strengthIndex(currentApproval.strength)) {
    reasons.push(`approval.strength ${currentApproval.strength} -> ${afterApproval.strength}`)
  }
  if (thresholdIndex(afterApproval.riskThreshold) > thresholdIndex(currentApproval.riskThreshold)) {
    reasons.push(`approval.riskThreshold ${currentApproval.riskThreshold} -> ${afterApproval.riskThreshold}`)
  }
  if (currentApproval.denyHighAlways === true && afterApproval.denyHighAlways !== true) {
    reasons.push('approval.denyHighAlways true -> false')
  }
  const currentExempt = new Set(Array.isArray(currentApproval.exemptTools) ? currentApproval.exemptTools : [])
  const addedExempt = (Array.isArray(afterApproval.exemptTools) ? afterApproval.exemptTools : []).filter(
    tool => !currentExempt.has(tool),
  )
  if (addedExempt.length > 0) reasons.push(`approval.exemptTools adds ${addedExempt.join(', ')}`)

  const currentEval = evaluatorSnapshot(currentConfig)
  const afterEval = evaluatorSnapshot(afterConfig)
  if (currentEval.independent === true && afterEval.independent !== true) {
    reasons.push('evaluator.independent true -> false')
  }
  if (currentEval.bar !== null && afterEval.bar !== null && afterEval.bar < currentEval.bar) {
    reasons.push(`evaluator.bar ${currentEval.bar} -> ${afterEval.bar}`)
  }
  const lostVeto = currentEval.mustPass.filter(dimension => !afterEval.mustPass.includes(dimension))
  if (lostVeto.length > 0) reasons.push(`evaluator.mustPass loses ${lostVeto.join(', ')}`)
  const lostDimensions = currentEval.dimensions.filter(dimension => !afterEval.dimensions.includes(dimension))
  if (lostDimensions.length > 0) reasons.push(`evaluator.dimensions loses ${lostDimensions.join(', ')}`)

  const policyRank = { off: 0, advisory: 1, enforced: 2 }
  const currentPolicy = verificationPolicyOf(currentConfig)
  const afterPolicy = verificationPolicyOf(afterConfig)
  if ((policyRank[afterPolicy] ?? 2) < (policyRank[currentPolicy] ?? 2)) {
    reasons.push(`verification.policy ${currentPolicy} -> ${afterPolicy}`)
  }
  return reasons
}

/**
 * A question id bound to the exact project, path, value and current gate.
 *
 * The id is the binding: `runSet` recomputes it on the second call and requires the confirmation
 * token's `questionId` to match. A token minted for a different value, or for a gate that changed
 * between the ask and the write, is refused.
 */
function approvalWriteQuestionId(projectDir, path, value, currentSnapshot) {
  const digest = createHash('sha256')
    .update(JSON.stringify([projectDir, path, value ?? null, currentSnapshot]))
    .digest('hex')
    .slice(0, 20)
  return `workflow-approval-write-${digest}`
}

function buildApprovalWriteQuestion(result) {
  return [
    'This write would weaken a safety gate. Confirm only if you are the user and you intend it.',
    '',
    `path: ${result.path}`,
    `current: ${JSON.stringify(result.current)}`,
    `proposed: ${JSON.stringify(result.proposed)}`,
    `why it weakens: ${result.weakening.join('; ')}`,
    '',
    'The change is written to .dsh/workflow.yml. A delegated child cannot answer this question, ' +
      'so the write is refused there. Ignoring this question leaves the current gate in force.',
  ].join('\n')
}

/**
 * Read or write one project-level parameter.
 *
 * @param options - `{ exec, config, path, value, hasValue, dryRun, confirmation }`.
 * @returns A plain result object.
 */
export function runSet({ exec, config: rowConfig, path, value, hasValue, dryRun = false, workspaceDir, confirmation }) {
  const workspace = resolveWorkspace({ exec, workspaceDir })
  if (!workspace.dir) {
    return { ok: false, error: 'no project directory could be resolved for this session' }
  }

  const segments = String(path ?? '')
    .split('.')
    .map(part => part.trim())
    .filter(Boolean)
  if (segments.length === 0) {
    return { ok: false, error: 'a dot path is required, e.g. "modules.planner"' }
  }
  const topError = validateTopLevelKey(segments[0])
  if (topError) return { ok: false, error: topError }

  const existing = readWorkflowFile(workspace.dir, parseWorkflowYaml)
  const { config, gate: approvalGate } = readApprovalForProject(
    rowConfig,
    existing,
    DEFAULT_CONFIG.approval,
    workspace.dir,
  )

  // THE APPROVAL SECTION IS REPORTED AS THE GATE WILL READ IT.
  //
  // `getPath(config, ['approval', …])` returns the merged RAW section, which is exactly
  // what the runtime will NOT use when the section is malformed or the file has parse
  // problems — a read of `approval.strength` used to answer "off" for a gate that was in
  // fact running ask-user. For this one section the effective values come from the gate,
  // and the reason is attached so the answer explains itself. The raw file value is still
  // reported separately as `projectOverride`.
  const approvalValues = gate => ({
    strength: gate.strength,
    riskThreshold: gate.riskThreshold,
    denyHighAlways: gate.denyHighAlways,
    exemptTools: gate.exemptTools,
  })
  const approvalValueFrom = (gate, sourceConfig) =>
    segments[0] === 'approval'
      ? (segments.length === 1 ? approvalValues(gate) : getPath(approvalValues(gate), segments.slice(1)))
      : getPath(sourceConfig, segments)
  const approvalNoteFrom = gate =>
    segments[0] === 'approval' && !gate.usable
      ? {
          approvalUsable: false,
          approvalProblems: gate.problems,
          approvalNote:
            'the approval section is unusable, so these are the fail-closed values the gate will ' +
            'actually use, not what this project wrote. See project override for the raw value.',
        }
      : {}
  // The same report the status surface gives: the file may ask for a weaker gate, but the
  // session's monotonic memory is what will judge the next call.
  const monotonicNoteFrom = gate => ({
    monotonic: {
      downgradeIgnored: gate.downgradeIgnored === true,
      optedInMissing: gate.optedInMissing === true,
      notices: Array.isArray(gate.notices) ? gate.notices : [],
    },
  })

  // THE APPROVAL WARNINGS COME FROM THE FILE-AWARE GATE, NOT ONLY FROM `configWarnings`.
  //
  // `configWarnings(config)` validates the merged RAW section, which cannot see a
  // file-level parse problem — so `workflow_status` (file-aware) printed the verbatim
  // official warning for a refused gate while `workflow_set` printed nothing at all. Two
  // surfaces disagreeing about one setting is the divergence class this change set exists
  // to remove, so the gate's own accessor is merged in. Duplicates are removed, because
  // both sources emit the same verbatim lines when the section itself is malformed.
  const mergeWarnings = (...lists) => {
    const merged = []
    for (const list of lists) {
      for (const item of Array.isArray(list) ? list : []) {
        if (!merged.includes(item)) merged.push(item)
      }
    }
    return merged
  }

  // Order of refusal is deliberate, and matters for usability:
  //   1. path shape      — a malformed request is answered immediately
  //   2. value vocabulary — a pure check that touches nothing, so a typo'd value is
  //      reported as a bad value instead of being masked by the opt-in state
  //   3. opt-in existence — still refuses before any write, so the workflow can
  //      never be enabled implicitly
  const valueError = validateSettingValue(segments, value)
  if (valueError) {
    return {
      ok: false,
      error: valueError,
      path: segments.join('.'),
      hint: existing.present
        ? undefined
        : `note: this project has not opted in either — run workflow_init first`,
    }
  }

  // Read mode: report the effective value without touching the file.
  if (!hasValue) {
    return {
      ok: true,
      mode: 'read',
      path: segments.join('.'),
      value: approvalValueFrom(approvalGate, config),
      projectOverride: getPath(existing.value, segments),
      projectFilePresent: existing.present,
      warnings: mergeWarnings(configWarnings(config), approvalWarningLines(approvalGate)),
      ...approvalNoteFrom(approvalGate),
      ...monotonicNoteFrom(approvalGate),
    }
  }

  // Refuse to opt a project in by accident: writing requires an explicit init.
  if (!existing.present) {
    return {
      ok: false,
      path: segments.join('.'),
      error:
        `${WORKFLOW_RELATIVE_PATH} does not exist in this project, so it has not opted in. ` +
        'Run workflow_init first — a settings write must never enable the workflow implicitly.',
      projectDir: workspace.dir,
    }
  }

  const next = structuredClone(existing.value)
  const changed = setPath(next, segments, value === null ? undefined : value)

  const { config: after, sources } = resolveEffectiveConfig(rowConfig, next)

  // THE PROPOSED GATE, READ WITHOUT THE MONOTONIC MEMORY. It is the gate the file would ask
  // for, which is what has to be compared with the gate that is actually running. The memory is
  // deliberately not consulted here: a file that is ALREADY weaker is not a new downgrade, and a
  // no-op write must not produce a confirmation prompt.
  const afterApprovalGate = readApprovalForProject(
    rowConfig,
    { present: true, value: next, problems: [] },
    DEFAULT_CONFIG.approval,
  ).gate
  const currentSnapshot = {
    approval: gateSnapshot(approvalGate),
    evaluator: evaluatorSnapshot(config),
    verification: verificationPolicyOf(config),
  }
  const proposedSnapshot = {
    approval: gateSnapshot(afterApprovalGate),
    evaluator: evaluatorSnapshot(after),
    verification: verificationPolicyOf(after),
  }
  const weakening = changed
    ? gateWeakeningReasons(config, after, approvalGate, afterApprovalGate)
    : []
  const expectedQuestionId = approvalWriteQuestionId(
    workspace.dir,
    segments.join('.'),
    value,
    currentSnapshot,
  )

  if (weakening.length > 0) {
    if (confirmation === undefined || confirmation === null) {
      return {
        ok: false,
        status: 'confirmation-required',
        path: segments.join('.'),
        projectDir: workspace.dir,
        dryRun,
        current: currentSnapshot,
        proposed: proposedSnapshot,
        weakening,
        confirmationQuestionId: expectedQuestionId,
        reason:
          'this write would weaken the approval/verification gate. It is NOT written until a real ' +
          'user confirms it; a delegated child, or a session with no user-questions service, cannot.',
      }
    }
    if (isConfirmed(confirmation) !== true || confirmation.questionId !== expectedQuestionId) {
      return {
        ok: false,
        status: 'confirmation-invalid',
        path: segments.join('.'),
        projectDir: workspace.dir,
        reason:
          'the confirmation was not minted for this exact change (or the gate changed between the ' +
          'question and the write). Nothing was written; ask the user again.',
      }
    }
  }

  // The reported gate for a WRITTEN file is evaluated against the file this call would
  // leave behind: after a real write the serialiser has re-emitted the parsed value, so
  // the reader problems are gone; when nothing changed the file is untouched and its
  // existing problems still apply.
  const afterFileFor = written =>
    written ? { present: true, value: next, problems: [] } : existing
  const gateFor = file =>
    readApprovalForProject(rowConfig, file, DEFAULT_CONFIG.approval, workspace.dir).gate

  if (!changed) {
    const unchangedGate = gateFor(existing)
    return {
      ok: true,
      mode: 'write',
      changed: false,
      path: segments.join('.'),
      value: approvalValueFrom(unchangedGate, after),
      projectOverride: getPath(next, segments),
      warnings: mergeWarnings(configWarnings(after), approvalWarningLines(unchangedGate)),
      configSources: sources,
      ...approvalNoteFrom(unchangedGate),
      ...monotonicNoteFrom(unchangedGate),
    }
  }

  let written
  try {
    written = writeWorkflowFile(workspace.dir, next, { dryRun })
  } catch (error) {
    return { ok: false, error: `could not write ${WORKFLOW_RELATIVE_PATH}: ${error?.message ?? error}` }
  }

  // A USER-CONFIRMED weakening write becomes the new baseline. This is the ONLY place the
  // monotonic memory is lowered. A direct file edit never reaches here, and a dry run did not
  // write anything, so neither can relax the gate.
  if (weakening.length > 0 && written.written === true) {
    forgetApprovalSnapshot(workspace.dir)
  }

  const afterGate = gateFor(afterFileFor(written))
  const afterValue = approvalValueFrom(afterGate, after)

  return {
    ok: true,
    mode: 'write',
    changed: written.changed,
    dryRun,
    path: segments.join('.'),
    value: afterValue,
    projectOverride: getPath(next, segments),
    warnings: mergeWarnings(configWarnings(after), approvalWarningLines(afterGate)),
    configSources: sources,
    text: written.text,
    ...approvalNoteFrom(afterGate),
    ...monotonicNoteFrom(afterGate),
  }
}

/** Render an init result as the text the model reads. */
export function renderInit(result) {
  if (!result.ok) return `workflow_init failed: ${result.error}`
  const out = []
  out.push(result.dryRun ? 'workflow_init (dry run)' : 'workflow_init')
  out.push(`file: ${result.path}`)
  out.push(
    result.alreadyPresent
      ? 'the project was already opted in'
      : 'the project is now opted in',
  )
  if (result.changes?.length) {
    for (const change of result.changes) out.push(`  change: ${change}`)
  } else {
    out.push('  no change was needed')
  }
  out.push(`wrote file: ${result.wrote ? 'yes' : 'no'}`)
  out.push(`effective tier: ${result.effectiveTier}`)
  if (result.warnings?.length) {
    out.push('warnings:')
    for (const warning of result.warnings) out.push(`  - ${warning}`)
  }
  if (result.text) {
    out.push('file contents:')
    for (const line of result.text.replace(/\n$/, '').split('\n')) out.push(`  ${line}`)
  }
  return out.join('\n')
}

/** Render a set result as the text the model reads. */
export function renderSet(result) {
  if (!result.ok) {
    if (result.status === 'confirmation-required') {
      return [
        'workflow_set: NO WRITE — a user confirmation is required',
        `path: ${result.path}`,
        `why: ${result.reason}`,
        ...(Array.isArray(result.weakening) ? result.weakening.map(reason => `weakens: ${reason}`) : []),
        `current: ${JSON.stringify(result.current)}`,
        `proposed: ${JSON.stringify(result.proposed)}`,
      ].join('\n')
    }
    if (
      ['confirmation-unavailable', 'confirmation-invalid', 'not-confirmed', 'confirmation-failed'].includes(
        result.status,
      )
    ) {
      return [
        `workflow_set: NO WRITE — ${result.status}`,
        `path: ${result.path}`,
        `reason: ${result.reason}`,
      ].join('\n')
    }
    const lines = [`workflow_set failed: ${result.error ?? result.reason ?? 'unknown error'}`]
    if (result.hint) lines.push(result.hint)
    return lines.join('\n')
  }
  if (result.mode === 'read') {
    return [
      `workflow_set (read): ${result.path}`,
      `effective value: ${JSON.stringify(result.value)}`,
      `project override: ${JSON.stringify(result.projectOverride ?? null)}`,
      `project file present: ${result.projectFilePresent ? 'yes' : 'no'}`,
    ].join('\n')
  }
  const out = []
  out.push(result.dryRun ? 'workflow_set (dry run)' : 'workflow_set')
  out.push(`path: ${result.path}`)
  out.push(`changed: ${result.changed ? 'yes' : 'no'}${result.changed ? '' : ' (already had that value)'}`)
  out.push(`effective value now: ${JSON.stringify(result.value)}`)
  out.push(`project override now: ${JSON.stringify(result.projectOverride ?? null)}`)
  if (result.warnings?.length) {
    out.push('warnings:')
    for (const warning of result.warnings) out.push(`  - ${warning}`)
  }
  if (result.text) {
    out.push('file contents:')
    for (const line of result.text.replace(/\n$/, '').split('\n')) out.push(`  ${line}`)
  }
  return out.join('\n')
}

/**
 * Wrap a registration result as a callable disposer.
 *
 * Cordis registrations commonly return a disposer, a `Symbol.asyncDispose`
 * holder, or a `dispose()` method; a plain `undefined` has nothing to undo.
 *
 * @param registration - whatever `tools.register()` returned.
 * @returns A zero-argument disposer.
 */
export function asDisposer(registration) {
  return () => {
    try {
      if (registration === undefined || registration === null) return
      if (typeof registration === 'function') return registration()
      const asyncDispose = registration[Symbol.asyncDispose]
      if (typeof asyncDispose === 'function') return asyncDispose.call(registration)
      const dispose = registration[Symbol.dispose]
      if (typeof dispose === 'function') return dispose.call(registration)
      if (typeof registration.dispose === 'function') return registration.dispose()
      if (typeof registration[Symbol.for('cordis.dispose')] === 'function') {
        return registration[Symbol.for('cordis.dispose')]()
      }
    } catch (error) {
      console.warn(`dsh-workflow: tool disposal failed: ${error?.message ?? error}`)
    }
  }
}

/**
 * Build the `workflow_review` tool definition: an INDEPENDENT verdict.
 *
 * This is the only tool here that spends real money, so its failure modes are made
 * explicit rather than convenient:
 *
 *  - When no reviewer can be started, the result says so and `passed` stays false.
 *    A missing reviewer must never read as approval.
 *  - The overall score is recomputed from the reviewer's per-dimension values, and
 *    `mustPass` is enforced here, so a confidently inflated headline cannot pass.
 *  - The child is a fresh `spawn` agent: it does not inherit this conversation, so
 *    its judgement is genuinely independent of the work it grades.
 *
 * @returns A definition accepted by `ctx.tools.register()`.
 */
export function buildReviewToolDefinition(options) {
  const config = options?.config ?? {}

  return {
    name: 'workflow_review',
    description:
      'Get an INDEPENDENT verdict on finished work before delivering it. Starts a fresh reviewer ' +
      'agent that did not write the code, gives it the claim and the acceptance criteria, and asks ' +
      'it to verify rather than trust. The reviewer scores each configured dimension; the overall ' +
      'score is recomputed from those scores and any dimension listed in evaluator.mustPass vetoes ' +
      'a pass below the bar. Use this instead of declaring your own work complete: a generator ' +
      'grading itself is the failure mode this tool exists to prevent.',
    parameters: {
      type: 'object',
      properties: {
        feature: {
          type: 'string',
          description: 'What was built, in one or two sentences. The reviewer treats this as a claim to be tested.',
        },
        acceptance: {
          type: 'array',
          items: { type: 'string' },
          description: 'The acceptance criteria the work claims to meet.',
        },
        changed_files: {
          type: 'array',
          items: { type: 'string' },
          description: 'Files the author says changed. Helps the reviewer aim; it should still read them.',
        },
        diff: {
          type: 'string',
          description: 'The diff, if you have it. Optional but strongly recommended: it lets the reviewer see exactly what moved.',
        },
        sensors: {
          type: 'array',
          description: 'Computational checks you already ran, with their results.',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', description: 'e.g. test, typecheck, lint, build, smoke.' },
              ok: { type: 'boolean' },
              detail: { type: 'string' },
            },
            required: ['type', 'ok'],
            additionalProperties: false,
          },
        },
        round: {
          type: 'integer',
          minimum: 1,
          description:
            'Which review round this is. Increment it after addressing a previous FAIL. Exceeding ' +
            'evaluator.maxRounds is reported as exhausted instead of silently continuing.',
        },
        // ---- risk-based verification depth ----
        //
        // THE CLASS IS A PROPOSAL, NOT A DECISION. It declares what kind of change this is, and
        // the framework then checks that claim against `changed_files`/`diff`. A class whose depth
        // is shallower than the files require is REFUSED and the stricter depth is used, so a
        // caller cannot lower its own verification by naming a class — which is the only reason it
        // is safe to let a model name one at all.
        class: {
          type: 'string',
          enum: [...CHANGE_CLASS_IDS],
          description:
            'What kind of change this is, which sets the verification depth: docs (unit suite ' +
            'only), ui (unit suite + every covering harness + a HUMAN must look at the rendering), ' +
            'logic (unit suite + every covering mutation harness), security (everything + ' +
            'independent review, NOT degradable). The claim is checked against changed_files/diff: a ' +
            'class shallower than the files require is refused and the stricter depth is used. ' +
            'Omitting it changes nothing.',
        },
        verification_depth: {
          type: 'integer',
          minimum: VERIFICATION_DEPTHS.UNIT,
          maximum: MAX_VERIFICATION_DEPTH,
          description:
            'Raise the depth explicitly: 0 unit only, 1 unit + one covering harness, 2 unit + every ' +
            'covering harness, 3 everything + independent review. It may only RAISE the depth the ' +
            'class implies; a smaller number is refused and the class depth is used.',
        },
        human_check: {
          type: 'boolean',
          description:
            'Set true only if a human has actually looked at the rendered result. Required for the ' +
            'ui class, because no test in this project measures what the screen shows. This is the ' +
            "caller's own attestation and is recorded as such — it is never treated as proof.",
        },
        workspace_dir: {
          type: 'string',
          description: 'Absolute path to the project. Defaults to the current workspace.',
        },
        work_unit: {
          type: 'string',
          description:
            'Optional per-work-unit label. When set, this verdict is recorded against that work ' +
            'unit only, and workflow_advance action=record-review must name the same work_unit to ' +
            'consume it — a verdict from one unit can never complete a feature in another. Omit for ' +
            "the project's own workflow state. Accepted characters: letters, digits, . _ -, at most 64.",
        },
      },
      required: ['feature'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: renderReview(value) }],
    },
    async execute(args, exec) {
      // THE EFFECTIVE CONFIG IS RESOLVED PER CALL, not read from the mount-time
      // closure. `options.config` is only the patch row, so reading the gate off it
      // ignored the project's own `.dsh/workflow.yml` entirely: a project that set
      // `evaluator.independent: false` still got a review, and one that set `bar: 10`
      // was still graded against 8 — while `workflow_status`, which DOES resolve the
      // project layer, reported the opposite. Two surfaces disagreeing about whether
      // a gate is on is worse than either being wrong alone.
      //
      // The mount-time object is also aliased into the merge (`mergeConfigLayers`
      // assigns nested objects by reference and mutates them), so reading it here
      // made the gate's behaviour depend on whether some earlier `workflow_status`
      // call had already contaminated it, and let one project's `bar` leak into
      // another's review. Resolving from `options.config` per call keeps the row
      // layer read-only in effect: `resolveEffectiveConfig` still merges through it,
      // which is pre-existing behaviour, but the gate no longer trusts the result
      // across calls.
      const workspace = resolveWorkspaceDir(exec)
      // The gate and the reviewer must look at the SAME directory; `workspace_dir`
      // used to be forwarded only to the prompt, so a call could be validated in one
      // project and review another.
      const reviewDir = args?.workspace_dir ?? workspace.dir

      // The work unit is validated BEFORE anything is spent. An unusable id is refused,
      // never dropped: a review recorded under the wrong scope would be invisible to the
      // unit that needs it and visible to one that must not see it.
      const unit = resolveWorkUnitArgument(reviewDir, args?.work_unit)
      if (unit.ok !== true) {
        return toLosslessJson({
          ...workUnitRefusal(reviewDir, args?.work_unit, unit.error),
          passed: false,
        })
      }
      const workUnit = unit.workUnit

      const project = probeProject(reviewDir)
      const projectFile = readWorkflowFile(reviewDir, parseWorkflowYaml)
      const { config: effective } = resolveEffectiveConfig(config, projectFile.value)

      if (effective.requireOptIn !== false && !project.detected) {
        return toLosslessJson({
          ok: false,
          status: 'not-enabled',
          passed: false,
          reason:
            'this project has not opted into dsh-workflow, so no review runs. Run workflow_init ' +
            'first if that is intended — a stray review call must not spend tokens by accident.',
          projectDir: project.projectDir ?? reviewDir,
        })
      }

      // `evaluator.independent` is reported by workflow_status as the reason reviews
      // are unavailable, so the tool has to honour it too. A status line that claims
      // a gate is off while the gate still runs is worse than either alone.
      if (effective.evaluator?.independent === false) {
        return toLosslessJson({
          ok: false,
          status: 'disabled',
          passed: false,
          reason:
            'evaluator.independent is false for this project, so no independent reviewer runs. ' +
            'Set it back with workflow_set path=evaluator.independent value=true if that is intended.',
        })
      }

      // THE SAME RESOLVER `workflow_status` USES, at call time. The old chain read
      // `exec.subagents` (not a context), the registration-time property, and the OUTER ctx —
      // never the injected `runtimeCtx`, and never the `options.subagents` value it was given.
      // A service reachable only through `ctx.get` was therefore invisible here while the
      // status probe found it. See `resolveSubagents` for the route order.
      const subagents = resolveSubagents(options, exec)

      // ---- the risk-based verification depth --------------------------------------------
      //
      // RESOLVED BEFORE ANYTHING IS SPENT, and enforced only when `verification.policy` is
      // `enforced`. Under the default `off` the whole block below is inert except for the AUDIT
      // it records: a project that declares nothing gets exactly the review it always got.
      const verificationConfig = readVerificationPolicy(effective.verification)
      const verification = resolveVerificationDepth({
        declaredClass: args?.class,
        changedFiles: args?.changed_files,
        diff: args?.diff,
        policy: verificationConfig.policy,
        depth: args?.verification_depth,
        classification: verificationConfig.classification,
        classificationUsable: verificationConfig.classificationUsable,
        classificationProblems: verificationConfig.classificationProblems,
        selfProject: reviewDir === selfInstallRoot(),
      })
      const harnessPlan = harnessesForDepth({
        depth: verification.depth,
        files: verification.files,
      })
      const enforcing = verificationGates(verificationConfig.policy)

      // THE HUMAN CHECK IS A REQUIREMENT OF THE CLASS, NOT A COMMENT. Rendering cannot be tested
      // from here, so for the `ui` class the attestation is the only evidence there is — and it
      // is refused when it is missing, rather than recorded as absent and passed anyway. The
      // ATTESTATION IS STILL ONLY THE CALLER'S WORD, which is why the audit says so; what makes
      // this a check rather than a formality is that the requirement came from the user's own
      // confirmed class, not from the model.
      const humanAsserted = args?.human_check === true
      const humanRequired = verification.humanCheckRequired
      if (enforcing && humanRequired && !humanAsserted) {
        return toLosslessJson({
          ok: false,
          passed: false,
          status: 'human-check-required',
          verification: buildVerificationAudit(verification, {
            policy: verificationConfig.policy,
            confirmation: null,
            harnesses: harnessPlan,
            humanCheck: { required: true, asserted: false, confirmedBy: 'nobody' },
            independentReview: { required: true, ran: false },
          }),
          reason:
            'this change builds rendered output, so it cannot be verified by test alone and the ui ' +
            'class requires a human to look at it first. Have the user look at the rendered result, ' +
            'then call again with human_check: true. This is the one check that ever caught this ' +
            'project\u2019s most expensive presentation defect, and no test here replaces it.',
        })
      }

      // THE USER CONFIRMS THE DEPTH, AND THE ANSWER IS WHAT GETS RECORDED.
      //
      // The user asked for the decision to be made "by the LLM and the user together", so the
      // model PROPOSES a class and the user confirms or overrides it. A model's account of what
      // the user agreed to is not evidence — the same rule `workflow_gc` applies to constraint
      // writes — so the confirmation comes from a real answer to a real question, and the answer
      // is stored in the audit trail.
      //
      // `on-override` (the default) asks exactly when the model's proposal did NOT survive: a
      // refused class, or a depth raised above what was declared. Asking on every review would
      // reintroduce the cost this feature exists to remove; asking never would make the user's
      // half of the decision fictional.
      const overrode = verification.refused || typeof verification.escalated === 'string'
      const mustAsk = enforcing && (
        verificationConfig.confirmation === 'always' ||
        (verificationConfig.confirmation === 'on-override' && overrode)
      )
      let confirmationRecord = null
      let approvedClass = verification.resolved
      if (mustAsk) {
        const choice = verificationChoiceLabels(verification)
        const asked = await requestVerificationConfirmation({
          service: resolveUserQuestions(options, exec),
          exec,
          question: buildVerificationQuestion(verification),
          approveLabels: choice.approveLabels,
          labelsToClass: choice.labelsToClass,
        })
        if (asked.ok !== true) {
          return toLosslessJson({
            ok: false,
            passed: false,
            status: 'verification-unconfirmed',
            verification: buildVerificationAudit(verification, {
              policy: verificationConfig.policy,
              confirmation: null,
              harnesses: harnessPlan,
              humanCheck: { required: humanRequired, asserted: humanAsserted, confirmedBy: 'nobody' },
              independentReview: { required: verification.depth >= MAX_VERIFICATION_DEPTH, ran: false },
            }),
            reason:
              `${asked.reason} The resolved depth was ${verification.depth} ` +
              `(${verification.depthLabel}) for class "${verification.resolved}".`,
          })
        }
        if (isVerificationConfirmed(asked.confirmation) !== true) {
          // A service that answered but whose token this module did not mint is refused, not
          // trusted: the token is the only thing that distinguishes a real answer from an object
          // any in-process caller could write.
          return toLosslessJson({
            ok: false,
            passed: false,
            status: 'verification-unconfirmed',
            verification: buildVerificationAudit(verification, { policy: verificationConfig.policy }),
            reason:
              'the confirmation did not come from this module, so it does not authorise a depth. ' +
              'Nothing was reviewed.',
          })
        }
        confirmationRecord = {
          source: asked.confirmation.source,
          questionId: asked.confirmation.questionId,
          approvedAt: asked.confirmation.approvedAt,
          approvedLabel: asked.approvedLabel,
          selected: asked.selected,
        }
        if (typeof asked.approvedClass === 'string' && isChangeClass(asked.approvedClass)) {
          approvedClass = asked.approvedClass
        }
        // THE USER MAY RAISE THE CLASS, AND THAT RAISES THE DEPTH. The menu offers only
        // "apply the resolved class" or "apply the maximum"; the second one has to actually
        // change what runs, or the option would be decoration.
        if (approvedClass !== verification.resolved) {
          const raised = resolveVerificationDepth({
            declaredClass: approvedClass,
            changedFiles: args?.changed_files,
            diff: args?.diff,
            policy: verificationConfig.policy,
            classification: verificationConfig.classification,
            classificationUsable: verificationConfig.classificationUsable,
            classificationProblems: verificationConfig.classificationProblems,
            selfProject: reviewDir === selfInstallRoot(),
          })
          const raisedDepth = Math.max(raised.depth, verification.depth)
          verification.resolved = raised.resolved
          verification.depth = raisedDepth
          verification.depthLabel = VERIFICATION_DEPTH_LABELS[raisedDepth] ?? `depth ${raisedDepth}`
          verification.floor = raisedDepth
          const raisedHarnesses = harnessesForDepth({ depth: raisedDepth, files: verification.files })
          harnessPlan.required = raisedHarnesses.required
          harnessPlan.covering = raisedHarnesses.covering
          harnessPlan.note = raisedHarnesses.note
          verification.confirmedClass = approvedClass
        }
      }

      const verificationAudit = buildVerificationAudit(verification, {
        policy: verificationConfig.policy,
        confirmation: confirmationRecord,
        harnesses: harnessPlan,
        humanCheck: {
          required: humanRequired,
          asserted: humanAsserted,
          // HONEST ABOUT WHAT THIS IS. `asserted` records the caller's own claim; `confirmedBy`
          // records whether a human was asked at all. Neither is proof that anyone looked at the
          // screen, and the audit says so rather than implying a verification that did not happen.
          confirmedBy: humanAsserted ? (confirmationRecord ? 'user-question' : 'caller-attestation') : 'nobody',
          source: 'caller-attestation',
        },
        independentReview: {
          required: verification.depth >= MAX_VERIFICATION_DEPTH,
          ran: true,
        },
      })

      const outcome = await runReview({
        ...options,
        subagents,
        provider: effective.provider ?? 'spawn',
        parent: exec?.agent,
        signal: exec?.signal,
        config: effective.evaluator ?? {},
        maxDepth: effective.subagent?.maxDepth ?? MAX_SUBAGENT_DEPTH,
        feature: args?.feature,
        acceptance: args?.acceptance ?? [],
        changedFiles: args?.changed_files ?? [],
        diff: args?.diff,
        sensors: args?.sensors ?? [],
        round: args?.round ?? 1,
        workspaceDir: reviewDir,
        verification: verificationAudit,
      })

      // The verdict is recorded so `workflow_advance` can mark a feature complete from
      // the FRAMEWORK's copy of it. Without this, `workflow_advance` would have to accept
      // the caller's word that a review passed — which is the self-certification this
      // whole plugin exists to prevent. A model that reports "the review passed" without
      // running one finds nothing to record and is refused.
      //
      // The INPUTS are persisted too, not just the digest. A live run failed here: the
      // fingerprint folds in `changed_files` and `diff`, and `record-review` originally
      // recomputed it from ITS OWN arguments, so the caller had to re-supply a
      // byte-identical `diff` string on a second call. Omitting it produced "the workspace
      // changed after the review passed" — an accusation of exactly the thing the caller
      // had not done, against files that were provably unchanged. Storing the inputs means
      // `record-review` reproduces the reviewed fingerprint by default, and the refusal
      // (if it still happens) can describe the real cause.
      const reviewedFiles = args?.changed_files ?? []
      const reviewedDiff = args?.diff ?? ''
      recordReviewOutcome(options, reviewDir, workUnit, {
        at: new Date().toISOString(),
        passed: outcome?.passed === true,
        status: outcome?.status ?? 'unknown',
        round: outcome?.round ?? null,
        overall: outcome?.verdict?.overall ?? null,
        failedVeto: outcome?.verdict?.failedVeto ?? [],
        reason: outcome?.reason ?? '',
        // The fingerprint is computed over the review's own file set, in the project the
        // review actually covered, and bound to the work unit. The work unit is folded in
        // as the scope so a record replayed across units cannot match even if the store
        // key were wrong — see `fingerprint` in lib/advance.js.
        fingerprint: outcome?.status === 'reviewed'
          ? fingerprint(reviewDir, reviewedFiles, reviewedDiff, workUnit ?? '')
          : null,
        files: reviewedFiles,
        diff: reviewedDiff,
        // THE DEPTH DECISION TRAVELS WITH THE VERDICT. A verdict that does not say what class it
        // was reached under cannot answer the question a later reader actually has — "was this
        // reviewed as a security change or as a documentation change" — and that question is the
        // one this feature exists to make answerable.
        verification: verificationAudit,
      })

      return toLosslessJson({ ...outcome, verification: verificationAudit })
    },
  }
}

/**
 * Record a review outcome for `workflow_advance` to consume.
 *
 * The store lives on the tool options object, which lives as long as the plugin instance,
 * so it is per-process rather than per-call.
 *
 * THE KEY INCLUDES THE WORK UNIT, and that is load-bearing security, not bookkeeping.
 * `workflow_advance action=record-review` reads ONLY this store; that is what stops a model
 * from marking a feature complete on its own word. If the key were project-only, a verdict
 * recorded while driving unit X could be consumed to complete a feature in unit Y — a
 * lateral bypass of the whole anti-self-certification mechanism. The key encoding lives in
 * `lib/work-unit.js` so the writer and the reader cannot drift apart.
 *
 * @param options - the tool options carrying the store.
 * @param projectDir - the project the review covered.
 * @param workUnit - the work unit the review covered (null for the project-level scope).
 * @param outcome - the compacted verdict.
 */
function recordReviewOutcome(options, projectDir, workUnit, outcome) {
  if (!options || typeof options !== 'object') return
  // ONLY A VERDICT IS EVIDENCE. `runReview` also returns `unavailable`, `misconfigured`,
  // `exhausted` and `incomplete`; those describe a review that did NOT happen. Recording them
  // made `workflow_advance record-review` write `passes:false`, `attempts+1`, a
  // `blocked_reason`, and an evidence row whose round/overall/fingerprint are all null — a
  // "review failed" entry for an event that was never a review. The guard lives here, at the
  // writer, so no future caller can store a non-verdict by forgetting a conditional.
  if (outcome === null || typeof outcome !== 'object' || outcome.status !== 'reviewed') return
  const store = (options.reviewOutcomes ??= new Map())
  store.set(reviewOutcomeKey(projectDir, workUnit), { ...outcome, workUnit: workUnit ?? null })
}

/**
 * Read the most recent recorded review for a project AND work unit.
 *
 * @param options - the tool options carrying the store.
 * @param projectDir - the project directory.
 * @param workUnit - the work unit to read; a record for another unit is invisible here.
 * @returns the recorded outcome, or undefined.
 */
function readReviewOutcome(options, projectDir, workUnit) {
  return options?.reviewOutcomes?.get?.(reviewOutcomeKey(projectDir, workUnit))
}

/**
 * Build the `workflow_advance` tool definition: the phase machine.
 *
 * WHAT THIS EXISTS FOR
 * The review gate answers "is this work good enough". This tool answers "what should
 * happen next, and am I allowed to do it" — and it is the piece that lets the whole
 * build-and-review loop run inside ONE delegated child agent, so the main conversation is
 * not polluted by every round-trip. That shape needs `subagent.maxDepth >= 2`, because the
 * child is depth 1 and its reviewer is depth 2.
 *
 * WHAT IT ENFORCES RATHER THAN ASKS
 *  - `passes: true` is written only from a review THIS SESSION actually ran, whose verdict
 *    is held by the framework. A model claiming "the review passed" finds nothing recorded.
 *  - The reviewed artefact is fingerprinted, and any edit after approval invalidates it, so
 *    "review passed, then I changed three more things" cannot reach COMMIT.
 *  - `description`/`steps` are frozen after planning, because a feature whose definition
 *    changed is not the feature that was reviewed.
 *  - BUILD is refused until a session has run its sensors: new features on a broken
 *    foundation make things worse.
 *
 * @returns A definition accepted by `ctx.tools.register()`.
 */
export function buildAdvanceToolDefinition(options) {
  const config = options?.config ?? {}

  /** Resolve the project and its effective config the way the other tools do. */
  const resolve = (args, exec) => {
    const workspace = resolveWorkspaceDir(exec)
    const projectDir = args?.workspace_dir ?? workspace.dir
    const projectFile = readWorkflowFile(projectDir, parseWorkflowYaml)
    const { config: effective } = resolveEffectiveConfig(config, projectFile.value)
    return { projectDir, effective, detected: probeProject(projectDir).detected }
  }

  const refuseUnusable = (projectDir, effective) => {
    if (effective.requireOptIn !== false && !probeProject(projectDir).detected) {
      return {
        ok: false,
        status: 'not-enabled',
        reason:
          'this project has not opted into dsh-workflow, so no workflow state advances. ' +
          'Run workflow_init first if that is intended.',
        projectDir,
      }
    }
    return null
  }

  return {
    name: 'workflow_advance',
    description:
      'Drive the dsh-workflow phase machine for the current project: INIT → PLAN → PICK → ' +
      'NEGOTIATE → BUILD → VERIFY → EVALUATE → COMMIT → HANDOFF. Call it with no action to read the ' +
      'current phase and its legal next steps. The framework — not the agent — decides what a phase ' +
      'permits: a feature is marked complete only from an independent review that this session ' +
      'actually ran, the reviewed files are fingerprinted so later edits invalidate the approval, and ' +
      'BUILD is refused until the project sensors pass. This is the tool to drive from INSIDE a ' +
      'delegated child agent, so review round-trips do not consume the main conversation.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'boot', 'pick', 'advance', 'record-review'],
          description:
            'status (default): read the phase and legal moves. boot: run the session bootstrap ' +
            'checklist. pick: select the highest-priority unfinished feature. advance: move to the ' +
            'next phase. record-review: apply the LAST review this session ran to the current feature.',
        },
        to: {
          type: 'string',
          enum: [...PHASES],
          description: 'Target phase for action=advance.',
        },
        feature_id: {
          type: 'string',
          description: 'Feature to act on. Defaults to the currently selected feature.',
        },
        features: {
          type: 'array',
          description:
            'For action=advance when entering PLAN: the complete feature list. Each needs id, ' +
            'description, steps, and a numeric priority. Planner-only: adding features outside ' +
            'planning is refused.',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string' },
              description: { type: 'string' },
              steps: { type: 'array', items: { type: 'string' } },
              priority: { type: 'number' },
              category: { type: 'string' },
            },
            required: ['id', 'description'],
            additionalProperties: false,
          },
        },
        source_request: {
          type: 'string',
          description: 'For action=advance entering PLAN: the original request, kept verbatim.',
        },
        smoke_passed: {
          type: 'boolean',
          description:
            'For action=boot: whether the project sensors passed. BUILD is refused until this is true.',
        },
        changed_files: {
          type: 'array',
          items: { type: 'string' },
          description: 'For action=record-review: the files the review covered, for the fingerprint.',
        },
        diff: {
          type: 'string',
          description: 'For action=record-review: the diff the review covered, for the fingerprint.',
        },
        reason: {
          type: 'string',
          description: 'Optional note recorded in the history, for action=advance.',
        },
        workspace_dir: {
          type: 'string',
          description: 'Absolute path to the project. Defaults to the current workspace.',
        },
        work_unit: {
          type: 'string',
          description:
            'Optional per-work-unit label. Each unit keeps its own .dsh/work/<id>/WORKFLOW.json and ' +
            'FEATURES.json, so a delegated child can drive its own phase machine without touching the ' +
            "parent's. Omit for the project's own state (the default path, unchanged). An unusable id " +
            'is refused, never sanitised. Accepted characters: letters, digits, . _ -, at most 64, not ' +
            'starting with . or -.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: renderAdvance(value) }],
    },
    async execute(args, exec) {
      const action = args?.action ?? 'status'
      const { projectDir, effective } = resolve(args, exec)

      const enabled = refuseUnusable(projectDir, effective)
      if (enabled) return toLosslessJson(enabled)

      // A work unit is validated BEFORE any state is read or written. An unusable id is
      // refused outright: defaulting it would put this call back on the parent's state,
      // which is precisely the collision this feature removes.
      const unit = resolveWorkUnitArgument(projectDir, args?.work_unit)
      if (unit.ok !== true) {
        return toLosslessJson(workUnitRefusal(projectDir, args?.work_unit, unit.error))
      }
      const workUnit = unit.workUnit

      const { state } = readState(projectDir, workUnit)
      const { features } = readFeatures(projectDir, workUnit)

      // --- status ---------------------------------------------------------------
      if (action === 'status') {
        const last = readReviewOutcome(options, projectDir, workUnit)
        return toLosslessJson({
          ok: true,
          status: 'ok',
          projectDir,
          workUnit,
          phase: state.phase,
          role: PHASE_ROLE[state.phase] ?? null,
          featureId: state.feature_id,
          round: state.round,
          counts: featureCounts(features),
          allowed: TRANSITIONS[state.phase] ?? [],
          bootstrapSatisfied: state.bootstrapped === true,
          lastReview: last
            ? { passed: last.passed, status: last.status, overall: last.overall, at: last.at }
            : null,
          currentFeature: (features.features ?? []).find(f => f?.id === state.feature_id) ?? null,
          text: describeAdvance(state, features),
        })
      }

      // --- boot -----------------------------------------------------------------
      if (action === 'boot') {
        const bootstrap = buildBootstrap({
          features,
          state,
          smokePassed: args?.smoke_passed === true,
          projectDir,
        })
        const next = {
          ...state,
          bootstrapped: bootstrap.satisfied === true,
          bootstrap,
          updated_at: new Date().toISOString(),
        }
        writeState(projectDir, next, workUnit)
        return toLosslessJson({
          ok: bootstrap.satisfied === true,
          status: bootstrap.satisfied ? 'ok' : 'bootstrap-incomplete',
          projectDir,
          workUnit,
          bootstrap,
          reason: bootstrap.satisfied
            ? 'the session bootstrap checklist is satisfied; BUILD is permitted'
            : `BUILD stays refused until this is satisfied. Outstanding: ${bootstrap.blockedBy.join(', ')}`,
        })
      }

      // --- pick -----------------------------------------------------------------
      //
      // `pick` PERFORMS the PICK phase, it does not merely look up a feature. The first
      // version only selected and left the phase where it was, so a caller had to follow it
      // with `advance to=PICK` — and meanwhile the reply advertised "allowed next: PICK"
      // while already standing in PICK, which reads as a contradiction. Picking IS the move.
      if (action === 'pick') {
        const feature = pickNextFeature(features)
        if (feature === undefined) {
          return toLosslessJson({
            ok: false,
            status: 'nothing-to-pick',
            projectDir,
            workUnit,
            counts: featureCounts(features),
            reason:
              'every feature is already complete. Advance to HANDOFF, or add features during PLAN.',
          })
        }

        const withFeature = { ...state, feature_id: feature.id, round: 0 }
        let next = withFeature
        if (state.phase !== 'PICK') {
          if (!canTransition(state.phase, 'PICK')) {
            return toLosslessJson({
              ok: false,
              status: 'illegal-transition',
              projectDir,
              workUnit,
              phase: state.phase,
              allowed: TRANSITIONS[state.phase] ?? [],
              reason:
                `cannot pick from ${state.phase}. The selected feature was "${feature.id}", but no ` +
                `feature can be worked on from here. Legal next steps: ` +
                `${(TRANSITIONS[state.phase] ?? []).join(', ') || '(terminal)'}.`,
            })
          }
          next = transition(withFeature, 'PICK', { reason: `picked ${feature.id}` }).state
        } else {
          next = {
            ...withFeature,
            updated_at: new Date().toISOString(),
            history: [
              ...state.history,
              { at: new Date().toISOString(), from: 'PICK', to: 'PICK', reason: `picked ${feature.id}` },
            ].slice(-HISTORY_CAP),
          }
        }

        writeState(projectDir, next, workUnit)
        return toLosslessJson({
          ok: true,
          status: 'ok',
          projectDir,
          workUnit,
          phase: next.phase,
          from: state.phase,
          featureId: feature.id,
          feature,
          counts: featureCounts(features),
          allowed: TRANSITIONS[next.phase] ?? [],
        })
      }

      // --- record-review ---------------------------------------------------------
      if (action === 'record-review') {
        const featureId = args?.feature_id ?? state.feature_id
        if (!featureId) {
          return toLosslessJson({
            ok: false,
            status: 'no-feature',
            projectDir,
            workUnit,
            reason: 'no feature is selected; run action=pick first',
          })
        }

        // The verdict is read from the store under THE SAME WORK UNIT. A record made while
        // driving unit X is simply not found here, which is what stops a lateral replay.
        const last = readReviewOutcome(options, projectDir, workUnit)
        if (last === undefined) {
          return toLosslessJson({
            ok: false,
            status: 'no-review-recorded',
            projectDir,
            workUnit,
            reason:
              'this session has not run workflow_review for this project' +
              (workUnit ? ` and work unit "${workUnit}"` : '') +
              ', so there is no verdict to ' +
              'apply. A feature is marked complete by the framework from a review it witnessed — a ' +
              'claim that one passed is not evidence. Run workflow_review first' +
              (workUnit ? `, with work_unit="${workUnit}" so the verdict is recorded for this unit` : '') +
              '.',
          })
        }

        // DEFENCE IN DEPTH AT THE CONSUMER. The store now refuses to keep a non-verdict, but a
        // record from an older process, a hand-edited store, or a future writer must still not
        // turn "the review did not run" into a FAIL. `status` is the only field that distinguishes
        // a verdict from an attempt; require it explicitly.
        if (last.status !== 'reviewed') {
          return toLosslessJson({
            ok: false,
            status: 'review-not-reviewed',
            projectDir,
            workUnit,
            reason:
              `the last recorded review did not produce a verdict (status: ` +
              `${JSON.stringify(last.status ?? null)}), so it cannot mark a feature complete or ` +
              'failed. A review that did not run is not evidence either way. Run workflow_review ' +
              'again and apply the verdict it actually records.',
          })
        }

        // DEFENCE IN DEPTH on the binding itself. The store key already separates units;
        // this catches a record that was moved, hand-edited, or looked up through a key
        // that collided. A verdict is evidence for the unit it was recorded against, and
        // for no other.
        if ((last.workUnit ?? null) !== (workUnit ?? null)) {
          return toLosslessJson({
            ok: false,
            status: 'cross-unit-review',
            projectDir,
            workUnit,
            reason:
              `the recorded review belongs to work unit ${JSON.stringify(last.workUnit ?? null)}, not to ` +
              `${JSON.stringify(workUnit ?? null)}. A verdict from one work unit is never evidence for ` +
              'another, because that would let a review of unit X complete a feature in unit Y. Run ' +
              'workflow_review for this unit.',
          })
        }

        // The reviewed inputs come FROM THE RECORD, not from this call's arguments.
        //
        // They used to be re-read from `args`, which forced the caller to repeat a
        // byte-identical `diff` string a second time with no documentation saying so — and
        // when it was omitted the refusal accused the caller of editing files after the
        // review, which had not happened. Falling back to `args` keeps an explicit override
        // possible; defaulting to the record is what makes the common path work.
        const files = last.files ?? args?.changed_files ?? []
        const diff = last.diff ?? args?.diff ?? ''
        // The scope must match the one the review recorded, or the digest differs by
        // construction — the fingerprint is bound to the work unit, not just to the files.
        const currentFingerprint = fingerprint(projectDir, files, diff, workUnit ?? '')
        const expected = last.fingerprint

        const applied = applyReviewOutcome(features, {
          featureId,
          passed: last.passed === true,
          expectedFingerprint: expected,
          currentFingerprint,
          evidence: [
            {
              type: 'review',
              at: last.at,
              round: last.round,
              overall: last.overall,
              passed: last.passed,
              fingerprint: expected,
              files,
            },
          ],
          reason: last.reason,
        })

        if (applied.ok !== true) {
          return toLosslessJson({ ok: false, status: 'refused', projectDir, workUnit, reason: applied.error })
        }

        writeFeatures(projectDir, applied.features, workUnit)
        const counts = featureCounts(applied.features)
        const next = {
          ...state,
          round: last.passed === true ? 0 : state.round + 1,
          history: [
            ...state.history,
            {
              at: new Date().toISOString(),
              from: state.phase,
              to: state.phase,
              reason: `review ${last.passed ? 'PASS' : 'FAIL'} on ${featureId} (round ${last.round ?? '?'})`,
            },
          ].slice(-HISTORY_CAP),
          updated_at: new Date().toISOString(),
        }
        writeState(projectDir, next, workUnit)

        return toLosslessJson({
          ok: true,
          status: 'ok',
          projectDir,
          workUnit,
          featureId,
          passed: last.passed === true,
          counts,
          feature: applied.feature,
          allowed: TRANSITIONS[next.phase] ?? [],
          reason: last.passed
            ? `${featureId} is now marked complete, from a review this session ran`
            : `${featureId} stays incomplete (attempt ${applied.feature.attempts}): ${applied.feature.blocked_reason}`,
        })
      }

      // --- advance ---------------------------------------------------------------
      const to = args?.to
      if (!to) {
        return toLosslessJson({
          ok: false,
          status: 'bad-request',
          workUnit,
          reason: 'action=advance requires `to`. Call with no action to see the legal moves.',
          allowed: TRANSITIONS[state.phase] ?? [],
        })
      }

      // BUILD is gated on the session bootstrap. This is the structural version of
      // "do not start new work on a foundation you have not checked".
      if (to === 'BUILD' && state.bootstrapped !== true && effective.modules?.selfVerify !== false) {
        return toLosslessJson({
          ok: false,
          status: 'bootstrap-required',
          projectDir,
          reason:
            'BUILD is refused until this session has run the bootstrap checklist (action=boot with ' +
            'smoke_passed). Starting new work on a foundation broken by the previous round makes ' +
            'things worse. Outstanding: ' + ((state.bootstrap?.blockedBy ?? ['smoke']).join(', ')),
        })
      }

      // Entering PLAN carries the feature list, and only the planner may add features.
      if (to === 'PLAN' && Array.isArray(args?.features)) {
        const proposed = {
          ...emptyFeatures(args?.source_request ?? features.source_request ?? ''),
          features: args.features.map(feature => ({
            id: String(feature.id),
            category: feature.category ?? 'functional',
            description: String(feature.description),
            steps: Array.isArray(feature.steps) ? feature.steps.map(String) : [],
            passes: false,
            priority: Number.isFinite(feature.priority) ? feature.priority : 1,
            acceptance_id: null,
            evidence: [],
            attempts: 0,
            blocked_reason: null,
          })),
        }
        const diff = checkFeatureDiff(features, proposed, 'planner')
        if (diff.ok !== true) {
          return toLosslessJson({
            ok: false,
            status: 'refused',
            projectDir,
            reason: 'the proposed feature list is not an acceptable planning change',
            violations: diff.violations,
          })
        }
        writeFeatures(projectDir, proposed, workUnit)
      }

      const moved = transition(state, to, { reason: args?.reason })
      if (moved.ok !== true) {
        return toLosslessJson({
          ok: false,
          status: 'illegal-transition',
          projectDir,
          workUnit,
          phase: state.phase,
          error: moved.error,
          allowed: moved.allowed,
          reason:
            `cannot go from ${state.phase} to ${String(to)}. Legal next steps: ` +
            `${(moved.allowed ?? []).join(', ') || '(terminal)'}.`,
        })
      }

      // Leaving BUILD without a fingerprint drop is fine; entering COMMIT is what needs
      // an approval that still covers the artefact, and that is checked by record-review.
      writeState(projectDir, moved.state, workUnit)
      const after = readFeatures(projectDir, workUnit).features
      return toLosslessJson({
        ok: true,
        status: 'ok',
        projectDir,
        workUnit,
        phase: moved.state.phase,
        from: state.phase,
        featureId: moved.state.feature_id,
        counts: featureCounts(after),
        allowed: TRANSITIONS[moved.state.phase] ?? [],
        text: describeAdvance(moved.state, after),
      })
    },
  }
}

/**
 * Render a `workflow_advance` result as the text the model reads.
 *
 * @param value - the payload from the tool body.
 * @returns a human-readable report.
 */
export function renderAdvance(value) {
  const out = []
  const heading =
    value?.status === 'ok' ? 'workflow' : `workflow advance refused (${String(value?.status ?? '?')})`
  out.push(heading)

  // Printed only when a work unit was requested, so the project-level report is
  // byte-identical to what it was before work units existed. Flattened, because a REFUSED
  // id is echoed here verbatim and could otherwise forge a line into the report.
  if (typeof value?.workUnit === 'string' && value.workUnit !== '') {
    out.push(`work unit: ${oneLine(value.workUnit)}`)
  }
  // EVERY line below is `oneLine`d where it carries a value a human can edit or an
  // argument that is echoed back. `phase`, `from` and `featureId` come straight out of
  // hand-editable `.dsh/WORKFLOW.json`; the feature text comes out of
  // `.dsh/FEATURES.json`; a newline in any of them would become a standalone line that is
  // indistinguishable from report structure.
  if (value?.phase) out.push(`phase: ${oneLine(value.phase)}${value.role ? ` (${oneLine(value.role)})` : ''}`)
  if (value?.from && value?.phase) out.push(`moved: ${oneLine(value.from)} → ${oneLine(value.phase)}`)
  if (value?.featureId) out.push(`feature: ${oneLine(value.featureId)}`)
  if (value?.counts) out.push(`features: ${oneLine(value.counts.done)}/${oneLine(value.counts.total)} complete`)
  if (Array.isArray(value?.allowed) && value.allowed.length) {
    out.push(`allowed next: ${value.allowed.map(oneLine).join(' | ')}`)
  }
  if (value?.lastReview) {
    out.push(
      `last review this session: ${value.lastReview.passed ? 'PASS' : 'FAIL'}` +
        ` (${oneLine(value.lastReview.status)}${value.lastReview.overall === null || value.lastReview.overall === undefined ? '' : `, overall ${oneLine(value.lastReview.overall)}`})`,
    )
  }

  if (value?.bootstrap) {
    out.push('', 'session bootstrap:')
    for (const item of value.bootstrap.checklist ?? []) {
      out.push(`  [${item.done ? 'x' : ' '}] ${oneLine(item.key)}: ${oneLine(item.todo)}`)
    }
  }

  if (value?.currentFeature) {
    out.push('', `current: ${oneLine(value.currentFeature.description ?? '(no description)')}`)
    out.push(`  passes: ${value.currentFeature.passes === true}`)
    out.push(`  attempts: ${oneLine(value.currentFeature.attempts ?? 0)}`)
  }

  if (value?.feature) {
    out.push('', `feature ${oneLine(value.feature.id)}: ${oneLine(value.feature.description)}`)
    out.push(`  passes: ${value.feature.passes === true}`)
    if (value.feature.blocked_reason) out.push(`  blocked: ${oneLine(value.feature.blocked_reason)}`)
  }

  if (value?.violations?.length) {
    out.push('', 'violations:')
    for (const violation of value.violations) {
      out.push(
        `  ${oneLine(violation.field)}${violation.id ? ` (${oneLine(violation.id)})` : ''}: ${oneLine(violation.reason)}`,
      )
    }
  }

  // A reason can embed a `blocked_reason` that came from FEATURES.json, so it is flattened
  // for the same reason as the fields above.
  if (value?.reason) out.push('', oneLine(value.reason))
  if (value?.error) out.push('', oneLine(value.error))
  return out.join('\n')
}

/**
 * Register every model-facing tool this plugin publishes.
 *
 * Tools are registered through here so a definition rejected by the registry fails
 * the whole registration loudly instead of leaving a partial tool surface.
 *
 * `workflow_review` is registered unconditionally, like the tools that write: the
 * opt-in check belongs at CALL time, where `exec` identifies the real project.
 * Checking it here would be worse in both directions — registration happens once at
 * mount while `process.cwd()` is the harness directory rather than the project, so
 * the test would be unreliable, and a project that opts in later would have to be
 * restarted before it could obtain a review.
 *
 * @param tools - the host tools service (`ctx.tools`).
 * @param options - resolved context for status building.
 * @returns A single disposer releasing every registration.
 */
export function registerAllTools(tools, options) {
  const builders = [
    buildToolDefinition,
    buildInitToolDefinition,
    buildSetToolDefinition,
    buildReviewToolDefinition,
    buildAdvanceToolDefinition,
    buildGcToolDefinition,
  ]

  const disposers = []

  for (const build of builders) {
    const definition = build(options)
    disposers.push(asDisposer(tools.register(definition)))
    options.onRegistered?.(definition.name)
  }

  return () => {
    for (const dispose of disposers) dispose()
  }
}

/**
 * Register only the status tool. Kept for callers that want the read-only surface.
 *
 * @param tools - the host tools service (`ctx.tools`).
 * @param options - resolved context for status building.
 */
export function registerStatusTool(tools, options) {
  const definition = buildToolDefinition(options)
  return asDisposer(tools.register(definition))
}

export { resolveWorkspaceDir, describeExec }
