/**
 * dsh-workflow — Host half (shared implementation).
 *
 * Host services are reached through `ctx.get(name)` / `ctx.inject([...])` /
 * `ctx.on(event)` rather than value imports, following the dsh-ops convention.
 * The one exception is `@deepseek-ai/schemastery`, which is imported directly
 * because `Config` MUST be a module-level export (see below).
 *
 * WHY `Config` IS A STATIC EXPORT, NOT AN INJECTED ONE:
 * `dsh-settings` builds the settings namespace directory from
 *
 *     schema(entry) { return entry.fiber?.runtime?.Config }        // dsh-settings
 *     const schema = this.schema(entry)
 *     if (schema === void 0) return []                             // entry DROPPED
 *     const form = volatileForm(schema); if (form === void 0) return []
 *     … ns: entry.options.id
 *
 * `runtime.Config` is the MODULE NAMESPACE member, read when the settings document
 * is described. Assigning it later from an `ctx.inject` callback leaves it
 * `undefined` at that moment, so the row is dropped from `describe()`, the browser
 * page's namespace gate never opens, and the settings form silently never appears.
 * The export therefore has to exist by the time the module namespace is handed to
 * the loader. `schemastery` is a real dependency of every DSH installation, so a
 * static import is appropriate; the build is still wrapped so that a deployment
 * without it loads the tools and simply declares no schema.
 *
 * WHY EXPORTING A VOLATILE `Config` IS SAFE:
 * The host does not call this schema. It projects the schemastery node graph into
 * JSON Schema (reading `meta`, `dict`, `type`) and validates config values with
 * Ajv against the generated schema. `volatile` is therefore pure metadata here —
 * the "a volatile field holds a placeholder instead of its default" behaviour only
 * appears if the schema is invoked directly, which the host never does.
 *
 * The one hard rule this creates: a schema default BECOMES the field's value, so a
 * field whose value must differ per row (like `rowKind`) must not appear in the
 * schema at all. The schema is only ever a VIEW over `entry.fiber.config`, and
 * projected fields are the only ones a form can write back.
 *
 * @module src-12453345_-dsh-workflow
 */

import { DEFAULT_CONFIG, resolveConfig, configWarnings, readVerificationPolicy } from './config.js'
import { probeProject, describeProject } from './project.js'
import { registerAllTools, probeServices, probeSubagents } from './tools.js'
import { buildConfigSchema } from './config-schema.js'
import { loadSchemastery } from './schemastery.js'
import { createApprovalGate, readApprovalGate, selfInstallRoot } from './approval.js'
import { resolveApprovalState } from './approval-state.js'

export const name = 'dsh-workflow'

/**
 * Deployment-tunable configuration.
 *
 * Declared STATICALLY — see the module comment for why an injected assignment
 * cannot work. `schemastery` ships with every DSH installation; when it cannot be
 * resolved (a bare checkout) the schema is omitted and the plugin still loads.
 */
export let Config

try {
  Config = buildConfigSchema(loadSchemastery(import.meta.url))
} catch (error) {
  console.warn(
    `dsh-workflow: schemastery unavailable (${error?.code ?? error?.message ?? error}); ` +
      'Config is undeclared, so the settings page will offer no fields. ' +
      'The workflow tools still work.',
  )
  Config = undefined
}

function report(ctx, message, level = 'error') {
  const logger = ctx?.logger
  if (typeof logger?.[level] === 'function') logger[level](`dsh-workflow: ${message}`)
  else if (level === 'warn') console.warn(`dsh-workflow: ${message}`)
}

/**
 * Apply the core component: report the service probe, then register the status
 * tool THROUGH `ctx.inject(['tools'], ...)`.
 *
 * Injection, not `ctx.get`, is what makes registration reliable: `get` samples the
 * registry once and can miss a service that starts later, while `inject` waits for
 * it and runs the callback on every re-entry.
 *
 * @param ctx - cordis context (root or scoped).
 * @param rawConfig - configuration from the patch row.
 */
export function applyCore(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)

  // Declaration-only mode.
  //
  // `dsh-client-modules` resolves a row's package with `exactPackageSpecifier`,
  // which returns undefined for ANY non-scoped specifier containing "/" — so a row
  // mounted as `<package>/core` can never have its `dsh.client` discovered, and the
  // browser half is dropped silently. The package therefore needs a row mounted as
  // the BARE package name; that row must not register a second copy of the tools.
  //
  // `rowKind` defaults to `''` in config.js, so `''`/undefined means "core". Do not
  // invert this: an empty marker is a legitimate core invocation, both in tests and
  // from a row whose `config:` block omits the field.
  if (config.rowKind === 'module') {
    report(ctx, 'module row mounted: the browser half is discoverable via this row id', 'info')
    return
  }

  // The declaration row ALSO carries a `Config`, which makes it visible in the
  // settings namespace directory. This line records what the row actually arrived
  // with, because a schema default replacing the patch value would blank
  // `rowKind` and quietly turn this row into a second tool registrar.
  report(ctx, `row config arrived as rowKind=${JSON.stringify(rawConfig?.rowKind ?? null)}`, 'info')

  let availability = {}
  try {
    availability = probeServices(ctx).availability
  } catch (error) {
    report(ctx, `service probe failed: ${error?.message ?? error}`, 'warn')
  }

  for (const warning of configWarnings(config)) report(ctx, warning, 'warn')

  // THE VERIFICATION POLICY IS STATED AT MOUNT, so a session that never sees a review still
  // records which policy it was operating under. `off` is the default and is reported as such:
  // "this project runs the historical loop" is a fact worth having in the log, and it is the
  // difference between a deliberate choice and an unexamined one.
  const mountVerification = readVerificationPolicy(config.verification)
  report(
    ctx,
    `verification depth policy: ${mountVerification.policy}` +
      (mountVerification.usable ? '' : ' (unusable -> strictest settings)') +
      `, confirmation=${mountVerification.confirmation}, report=${mountVerification.report}; ` +
      'classes docs|ui|logic|security, with security not degradable at any setting',
    'info',
  )

  report(
    ctx,
    `core mounting. services at apply time: ${Object.entries(availability)
      .map(([key, present]) => `${key}=${present ? 'yes' : 'NO'}`)
      .join(', ')}`,
    'info',
  )

  // --- the approval gate ------------------------------------------------------
  //
  // THE GATE IS BUILT BEFORE THE TOOLS, because `workflow_status` reports its counters
  // and because registration is where a `tools.guard()` failure must be visible.
  //
  // The reviewer's route is an OPTIONAL service. A nested `ctx.inject(['llm'], …)` is the
  // only way to obtain it without making it REQUIRED: the tools are registered inside
  // `ctx.inject(['tools', 'subagents'], …)`, and declaring a fourth name there would
  // silently unregister every tool on a deployment that composes no model service.
  // Absent `llm` is not a load-time failure; it is reported as a reviewer failure when an
  // `llm-*` strength actually tries to review a call.
  let llmService
  ctx.inject(['llm'], llmCtx => {
    llmService = llmCtx.llm
    llmCtx.effect(() => () => {
      llmService = undefined
    }, 'dsh-workflow: approval reviewer route')
  })

  // --- the constraint-confirmation route --------------------------------------
  //
  // `workflow_gc` writes a constraint only after the USER confirmed it, and that
  // confirmation has to come from the host, not from the model's account of the
  // conversation. The service is optional and therefore obtained through its own nested
  // `inject`, for the same reason `llm` is: adding the name to the `['tools','subagents']`
  // list would silently unregister every tool on a deployment that composes no
  // user-questions answerer. Absent the service, `workflow_gc` refuses to add or retire
  // anything and says why — that is the fail-closed direction.
  let userQuestionsService
  ctx.inject(['userQuestions'], questionsCtx => {
    userQuestionsService = questionsCtx.userQuestions
    questionsCtx.effect(() => () => {
      userQuestionsService = undefined
    }, 'dsh-workflow: constraint confirmation route')
  })

  // --- the approval prompt channel ---------------------------------------------
  //
  // THE ONE QUESTION THE GATE CANNOT ANSWER FROM `tools/pre-execute`. A strength of
  // `ask-user` (or `llm-then-user`, after its reviewer rejects) hands the call to
  // `dsh-tools`, which routes it through the `approval` service. When that service's
  // session policy is `never`, it returns `rejected` WITHOUT consulting any answerer, and
  // `dsh-tools` reports that as `the user rejected tool "<name>"` — indistinguishable from
  // a human declining, and the reason a delegated child spent a session believing it had
  // done something wrong. The policy is readable in advance (`effectivePolicy(session)`),
  // and it is only readable through an injected context, so the service is captured here
  // and handed to the gate and to `workflow_status` via getters.
  let approvalService
  ctx.inject(['approval'], approvalCtx => {
    approvalService = approvalCtx.approval
    approvalCtx.effect(() => () => {
      approvalService = undefined
    }, 'dsh-workflow: approval prompt channel')
  })

  const approvalGate = createApprovalGate({
    // The row config is the base layer; the project file is resolved per call so a call
    // in project A can never be judged by project B's strength (see `resolveConfig`'s
    // aliasing pitfall, which had exactly this shape).
    resolveGate: exec => resolveApprovalState(exec, config),
    getLlm: () => llmService,
    getApproval: () => approvalService,
    log: (level, message) =>
      report(ctx, message, level === 'warn' ? 'warn' : level === 'info' ? 'info' : 'error'),
  })

  // THE EXEMPTION'S SCOPE, STATED WHERE IT CAN BE READ LATER. `selfDeployAuthorised`
  // counts self-deployments, but "how many" without "authorised over what range" is not an
  // audit trail. The anchor is derived from this module's own location (there is no
  // configurable path to point somewhere wider), and saying it out loud at mount means a
  // session that never sees an authorisation still records what the exemption covers.
  const selfDeployRoot = selfInstallRoot()
  report(
    ctx,
    selfDeployRoot === null
      ? 'approval self-deployment exemption DISABLED: this module could not resolve its own package ' +
          'directory, so every write outside the project stays gated exactly as before'
      : `approval self-deployment exemption anchored at ${selfDeployRoot}: a non-shell call whose every ` +
          'destination argument stays inside that package is authorised (logged and counted); every other ' +
          'outside path, every shell invocation, and every provable exfiltration stay gated',
    'info',
  )

  // THE ORDERED HALF. Registered on the plugin's own context, untagged, so the
  // scope-routed `tools/pre-execute` waterfall admits it for every agent (an untagged
  // listener is global; a listener tagged with a scope is admitted only for that scope
  // and its descendants — dsh-scope `scopeTarget`).
  ctx.effect(
    () => ctx.on('tools/pre-execute', approvalGate.listener),
    'dsh-workflow: approval gate listener',
  )

  // THE MONOTONIC HALF. `dsh-tools` consults guards whenever the waterfall's final
  // decision is `allow` — including after an `ask` was granted — so a provable high-risk
  // call cannot be re-enabled by a later listener or by a human click.
  ctx.inject(['tools'], guardCtx => {
    const tools = guardCtx.tools
    if (typeof tools?.guard !== 'function') {
      report(
        ctx,
        'the `tools` service exposes no guard(), so approval.denyHighAlways cannot be made ' +
          'monotonic. High-risk calls are still denied by the pre-execute listener, but a ' +
          'listener registered ahead of it could allow one.',
        'warn',
      )
      return
    }
    guardCtx.effect(() => tools.guard(approvalGate.guard), 'dsh-workflow: approval high-risk guard')
    // REPORTED THROUGH THE SAME RULE AS THE GATE ITSELF. Reading
    // `config.approval?.strength` here made the mount log a third reader of one setting: a
    // malformed row section logged `(unset)` while the gate was already running the
    // fail-closed strength.
    const mountGate = readApprovalGate(config.approval, DEFAULT_CONFIG.approval)
    report(
      ctx,
      `approval gate installed: pre-execute listener plus a monotonic high-risk guard ` +
        `(strength=${mountGate.strength}${mountGate.usable ? '' : ' (unusable -> fail-closed)'}, ` +
        `threshold=${mountGate.riskThreshold}, denyHighAlways=${mountGate.denyHighAlways})`,
      'info',
    )
  })

  // --- the tools, awaited on the tools service --------------------------------
  //
  // `subagents` IS INJECTED, NOT REACHED FOR. Cordis refuses
  // `ctx.get('subagents')` on a context that never declared it
  // ("cannot get property \"subagents\" without inject"), which is exactly what happened
  // the first time `workflow_review` ran on a real host: registration succeeded, and the
  // CALL failed. The official delegation tool does the same thing — it wraps its tool
  // registration in `ctx.inject([..., 'subagents', ...], runtimeCtx => …)` and reads
  // `runtimeCtx.subagents` inside `execute`.
  //
  // Written to fail loudly rather than silently: if this deployment composes no
  // delegation backend the callback never runs, so the tools would simply be absent.
  // That case is reported by `workflow_status` (the subagent probe) and by the mount log
  // below, and `workflow_review` already reports "the subagents service is unavailable"
  // when it does run.
  ctx.inject(['tools', 'subagents'], (runtimeCtx, apply) => {
    const tools = runtimeCtx.tools
    // THE CALL-TIME GETTER, NOT ONLY THE PROPERTY. A host shape that exposes the injected
    // service through `get` while leaving the property empty made `workflow_review` report
    // "unavailable" while `workflow_status` (which probes both) saw it. The getter is handed
    // to the tools so review resolves the service the same way status does, at call time.
    //
    // `probeSubagents` also checks the property when `get` returns a facade without a
    // review-start entry point, and accepts either `start` (older hosts) or
    // `startActivation` (current hosts). `probeServices(...).resolved.subagents` only did
    // the first and would hand the consumer a service it could not call.
    const getSubagents = () => probeSubagents(runtimeCtx)
    // The injected context may or may not carry the optional member, depending on
    // whether a delegation backend is composed. Read the live route first, then the property.
    const subagents = getSubagents() ?? runtimeCtx.subagents

    if (!tools || typeof tools.register !== 'function') {
      report(ctx, 'the `tools` service resolved but exposes no register(); no tool registered.', 'warn')
      return
    }

    // Registration failure must be LOUD: a rejected definition used to surface as
    // a tool that simply never appeared, with no diagnostic anywhere.
    const registered = []
    let disposeTools
    try {
      disposeTools = registerAllTools(tools, {
        ctx,
        config,
        services: runtimeCtx,
        // What `execute` must use to reach `subagents`. `getSubagents` is the live route;
        // `subagents` is the registration-time value kept for compatibility and diagnostics.
        runtimeCtx,
        subagents,
        getSubagents,
        // The reviewer's per-install cost, reported by `workflow_status`. The design
        // requires the `llm-*` strengths' extra model request to be observable; the
        // consumer named there (`workflow_stats`) does not exist yet, so the counter is
        // surfaced where the model and the user already look.
        approvalStats: () => approvalGate.counters,
        // Whether the reviewer can run at all. Probed from the captured service rather
        // than from `probeServices`, because only a context that INJECTED `llm` may read
        // it (see the nested inject above).
        approvalReview: { hasLlm: () => llmService !== undefined },
        // Whether this session can answer an approval prompt at all. Read through a getter
        // for the same reason `hasLlm` is: the nested `inject` above may run after this
        // registration. `workflow_status` uses it to flag a strength it cannot satisfy.
        approvalChannel: { get: () => approvalService },
        // Reached through a getter, not read once at mount: the nested `inject` above runs
        // whenever the service appears, which may be after this registration.
        getUserQuestions: () => userQuestionsService,
        onRegistered: toolName => registered.push(toolName),
      })
    } catch (error) {
      report(
        ctx,
        `tool registration FAILED after [${registered.join(', ') || 'none'}]: ` +
          `${error?.name ?? 'Error'}: ${error?.message ?? error}`,
        'error',
      )
      return
    }

    runtimeCtx.effect(() => () => {
      disposeTools()
      disposeTools = () => {}
    }, 'dsh-workflow: tool registrations')

    report(
      ctx,
      `registered tools: ${registered.join(', ')}` +
        (subagents
          ? ' — subagents available, workflow_review can delegate'
          : ' — subagents NOT available, workflow_review will report unavailable'),
      subagents ? 'info' : 'warn',
    )
  })

  // --- the prompt guidance, awaited on the prompt service ---------------------
  ctx.inject(['systemPrompt'], promptCtx => {
    promptCtx.effect(
      () =>
        promptCtx.systemPrompt.section({
          name: 'tool:workflow_status',
          order: 161,
          // THE ROW CONFIG IS PASSED IN, not omitted. The guidance is depth-shaped, so a prompt
          // that did not know the policy would have to describe every setting at once — which is
          // the unconditional instruction this function was changed to stop emitting.
          text: renderWorkflowGuidance(config),
        }),
      'dsh-workflow: workflow guidance',
    )
    report(ctx, 'published prompt section: tool:workflow_status', 'info')
  })
}

/**
 * Apply the panel component (Host side). The browser half is declared through
 * `dsh.client` and served automatically by the client-modules host.
 *
 * @param ctx - cordis context.
 * @param rawConfig - configuration from the patch row.
 */
export function applyPanel(ctx, rawConfig) {
  const config = resolveConfig(rawConfig)
  const { availability } = probeServices(ctx)
  report(
    ctx,
    `panel host half mounted. settings=${availability.settings ? 'yes' : 'NO'}, ` +
      `showInSidebar=${config.showInSidebar === true}`,
    'info',
  )
}

/** Backward-compatible module entry. The bundle uses independently toggled rows. */
export function apply(ctx, rawConfig) {
  return applyCore(ctx, rawConfig)
}

/**
 * The model-facing guidance for the workflow tools.
 *
 * WHY IT IS DEPTH-SHAPED RATHER THAN ONE FIXED LOOP
 * This text used to instruct the full loop unconditionally: unit suite, mutation harnesses, an
 * independent reviewer child, every round. That is the right loop for a security change and the
 * wrong one for a documentation edit, and a prompt that cannot tell the difference teaches a model
 * to stop reading the section — which costs more than the verification it was trying to avoid. The
 * guidance therefore states the POLICY (how a depth is chosen, checked and confirmed) rather than
 * one procedure, and names the four classes so a model can declare one deliberately.
 *
 * @param config - the effective configuration, when one is available. Optional, because this is
 *   also published before any project has been identified.
 * @returns The prompt section text.
 */
export function renderWorkflowGuidance(config) {
  // THE ROW CONFIG IS NOT THE PROJECT'S POLICY. This section is published once at mount,
  // before any project is identified; the project's own `.dsh/workflow.yml` can override the
  // row default. Printing "policy=off" here made the system prompt contradict the file for
  // every project that enabled the feature in its own file. State the scope and point at the
  // live surface instead of naming a policy this text did not read.
  const policyLine =
    'Verification policy is PROJECT-SCOPED: the project file can override the row default. ' +
    'Read the effective policy with workflow_status before declaring a class; do not assume off. ' +
    'When it is enforced, a class shallower than the changed files require is refused and the ' +
    'stricter depth is used; advisory reports the class without refusing. The security class is ' +
    'never degradable.'

  return [
    'Use the workflow_status tool to inspect the workflow harness state for the current project.',
    'The workflow activates ONLY for projects that opted in — that is, projects whose working directory',
    'contains `.dsh/workflow.yml`. For every other project, workflow_status reports "not enabled" and you',
    'must not create workflow state on your own initiative.',
    'Call workflow_status before assuming any project structure, tier, or switch setting.',
    // ---- the verification depth, stated as policy ----
    'VERIFICATION DEPTH TRACKS RISK, AND THE CHOICE IS EXPLICIT. There are four change classes and each',
    'has a depth: docs = the unit suite, nothing else; ui = the unit suite plus every covering mutation',
    'harness PLUS a human looking at the rendered result, because rendering cannot be tested from here;',
    'logic = the unit suite plus every covering mutation harness; security = everything plus an',
    'independent reviewer, and the security class is NOT degradable at any setting. Name the class on',
    'workflow_review with class=..., and pass changed_files (or a diff) so the claim can be CHECKED rather',
    'than believed — the resolved depth is the stricter of the class you name and the class the files',
    'imply, so a declaration can only add cost, never remove it. Declaring "docs" while the diff touches',
    'lib/approval.js is REFUSED by name, and the stricter depth is used.',
    policyLine,
    'Run workflow_status with changed_files first to see the resolved depth and the exact mutation',
    'harnesses that depth requires, before spending anything. The security class is not selectable down: a',
    'change touching an approval, authorization or permissions surface resolves to the deepest rung',
    'regardless of how it is declared, and an unrecognised class, an unusable config value or an',
    'unreadable state all resolve to the STRICTER depth, never the looser one.',
    'In a project that opted in, do NOT declare non-trivial work complete on your own judgement:',
    'call workflow_review, which starts a fresh reviewer agent that did not write the code and returns',
    'an independent verdict. Self-assessment is the failure mode that tool exists to prevent. If the',
    'review reports FAIL, fix the located issues and review again with an incremented round.',
    'Drive multi-step work with workflow_advance, which owns the phase machine',
    '(INIT → PLAN → PICK → NEGOTIATE → BUILD → VERIFY → EVALUATE → COMMIT → HANDOFF). Call it with no',
    'action to see the current phase and its legal moves. The framework decides what a phase permits:',
    'a feature is marked complete only from a review this session actually ran, the reviewed files are',
    'fingerprinted so later edits invalidate the approval, and BUILD is refused until the session has',
    'run the project sensors. Do not hand-edit .dsh/FEATURES.json — write permissions are enforced.',
    'Recurring problems become constraints through workflow_gc, never by hand-editing CONSTRAINTS.json:',
    'action=add asks the user to confirm before anything is written, and action=scan reports which',
    'constraints are due for retirement. It never retires anything by itself, and a constraint whose',
    'retirement signal is natural language is reported as DUE FOR HUMAN REVIEW rather than as satisfied —',
    'the framework cannot evaluate that sentence, and a guardrail must never be dropped on a false premise.',
    'A delegated child cannot answer a human approval prompt and cannot change the gate that is judging',
    'it. If approval.strength is ask-user and the child cannot satisfy it, run that gated work in the',
    'root conversation, or ask the user to change approval.strength in the settings page or in',
    '.dsh/workflow.yml (a restart applies it). Do NOT call workflow_set to widen the gate: a weakening',
    'write is refused without a real user confirmation, and a child cannot ask one.',
    'IMPORTANT — run the whole loop (workflow_advance plus workflow_review) from INSIDE a delegated',
    'child agent rather than from this conversation. The loop needs several review round-trips, and',
    'driving it here would put every one of them in this context, which is exactly what the split',
    'between workflow_advance and workflow_review is designed to avoid. Delegate the work unit, let the',
    'child advance and review its own work, and read only its final result. (This requires',
    'subagent.maxDepth >= 2: this conversation is depth 0, the child is depth 1, its reviewer is depth 2.)',
    'ONE EXCEPTION, and it is the point of the depth policy: a depth that requires the USER to confirm,',
    'or a ui-class change that requires a HUMAN to look, cannot be satisfied from inside a child — a child',
    'may not open a human interaction. Gather that confirmation in this conversation and put it in the',
    'child brief; do not let a child report a depth the user never saw.',
  ].join(' ')
}

export { DEFAULT_CONFIG, resolveConfig, probeProject, describeProject }
export { probeServices } from './tools.js'
