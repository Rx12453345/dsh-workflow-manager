/**
 * `workflow_gc` — the constraint ledger's maintenance tool.
 *
 * WHY A SEPARATE TOOL, NOT AN ACTION ON AN EXISTING ONE
 * The design's tool table lists `workflow_gc` with its own `scope` (`code|docs|constraints|all`),
 * and three properties force it to stand alone:
 *
 *  1. It runs when NO work is in flight. `workflow_advance`'s vocabulary is the phase machine
 *     (`status|boot|pick|advance|record-review`) and every one of those moves state. A
 *     garbage-collection scan must be possible in a project that is between features, or
 *     whose phase machine was never started at all — folding it into `workflow_advance` would
 *     make "read the ledger" impossible without a legal phase to stand in.
 *  2. Its `add` and `retire` paths OPEN A HUMAN INTERACTION. That is a different kind of
 *     operation from anything the other tools do, and it must stay independently auditable.
 *  3. The design names it. A model reading the design and finding no such tool would
 *     reasonably conclude the constraint lifecycle was never built.
 *
 * THE ONE THING THIS TOOL MUST NEVER DO
 * Report a constraint's free-text retirement signal as satisfied. `retire_when.signal` is
 * natural language ("连续 5 次 BUILD 阶段未触发 context_overflow 且无半成品提交"); no code
 * evaluates it. A collector that says "signal met" on an unevaluated signal lifts a guardrail
 * on a false premise, which is strictly worse than never retiring anything. So `scan` sorts
 * every active constraint into:
 *
 *   PROVABLY DUE          — every declared condition was computed by the framework and holds
 *   DUE FOR HUMAN REVIEW  — something the framework cannot evaluate is outstanding; the item
 *                           ships with a question, the constraint's `why`, and an explicit
 *                           statement that the framework cannot confirm it
 *   NOT DUE               — about the machine-checked conditions only, never about the signal
 *   DEFECTIVE             — no retirement condition at all: it can never retire
 *
 * and NOTHING is ever deleted. `retire` sets `status: "retired"` and keeps the record.
 *
 * ADDING REQUIRES THE USER, STRUCTURALLY
 * The design is explicit that a candidate constraint is confirmed by the user before it is
 * written, because otherwise constraints balloon unchecked. The confirmation is obtained by
 * the FRAMEWORK, through the host's user-questions service, and handed to the store as a
 * token; a caller cannot manufacture one. When the question cannot be asked — no answerer,
 * or a delegated child (a child may not open a human interaction) — nothing is written and
 * the refusal says what to do instead.
 *
 * @module src-12453345_-dsh-workflow/gc
 */

import { describeValue } from './gate.js'
import { toLosslessJson, oneLine } from './shared.js'
import { DEFAULT_CONFIG } from './config.js'
import { probeProject, resolveWorkspaceDir, parseWorkflowYaml } from './project.js'
import { readWorkflowFile, resolveEffectiveConfig } from './workflow-file.js'
import { readState, PHASES } from './advance.js'
import { resolveWorkUnitArgument, workUnitRefusal } from './work-unit.js'
import {
  CONSTRAINTS_RELATIVE_PATH,
  addConstraint,
  confirmationFromAnswer,
  evaluateConstraints,
  readConstraints,
  readRetireCheck,
  retireConstraint,
  signalForDisplay,
  validateConstraintCandidate,
  writeConstraints,
} from './constraints.js'

/** The scopes the design declares. Only `constraints` is implemented by this component. */
export const GC_SCOPES = Object.freeze(['constraints', 'code', 'docs', 'all'])

/** The actions this tool implements. */
export const GC_ACTIONS = Object.freeze(['scan', 'list', 'add', 'retire'])

/** The option labels that count as approval. Exact match only — see `confirmationFromAnswer`. */
export const GC_APPROVE_LABELS = Object.freeze({
  add: 'Add the constraint',
  retire: 'Retire the constraint',
})

/** The question ids, which the answer must echo. */
export const GC_QUESTION_IDS = Object.freeze({
  add: 'workflow-gc-add-constraint',
  retire: 'workflow-gc-retire-constraint',
})

/** Scopes the design declares but this component does not implement. */
const UNIMPLEMENTED_SCOPES = Object.freeze(['code', 'docs'])

/** The refusal shared by a project that has not opted in. */
function notEnabled(projectDir) {
  return {
    ok: false,
    status: 'not-enabled',
    projectDir,
    reason:
      'this project has not opted into dsh-workflow, so no constraint ledger is consulted. ' +
      'Run workflow_init first if that is intended.',
  }
}

/** Run something that may throw, returning undefined instead. */
function safely(fn) {
  try {
    return fn()
  } catch {
    return undefined
  }
}

/**
 * Find the host's user-questions service.
 *
 * Probed at CALL time through several shapes because the service may arrive on the exec
 * record, on the injected context, or through the nested injection `lib/index.js` performs
 * (a nested `ctx.inject` is the only way to obtain an optional service without unregistering
 * every tool on a deployment that composes none).
 *
 * @param options - the tool options.
 * @param exec - the tool execution context.
 * @returns the service, or undefined.
 */
export function resolveUserQuestions(options, exec) {
  const candidates = [
    safely(() => exec?.userQuestions),
    safely(() => options?.services?.userQuestions),
    safely(() => options?.getUserQuestions?.()),
    safely(() => options?.ctx?.get?.('userQuestions')),
  ]
  for (const candidate of candidates) {
    if (candidate !== null && typeof candidate === 'object' && typeof candidate.ask === 'function') {
      return candidate
    }
  }
  return undefined
}

/** The model running this session, which is the model a constraint is added for. */
export function callingModel(exec) {
  const header = safely(() => exec?.agent?.session?.requestHeader?.())
  const model = safely(() => header?.config?.model)
  return typeof model === 'string' && model !== '' ? model : null
}

/**
 * Turn a user-questions failure into an instruction, not a stack trace.
 *
 * Every one of these paths leaves the ledger untouched. The delegated-child case matters
 * most: the architecture this plugin recommends runs the build-and-review loop inside a
 * child, and a child may not open a human interaction — so the honest answer is "report the
 * candidate upward", never "write it anyway".
 *
 * @param error - whatever `ask()` threw.
 * @returns a reason string.
 */
export function describeAskFailure(error) {
  const code = safely(() => error?.code)
  const base = 'the constraint ledger was NOT modified'
  if (code === 'DELEGATED_CALLER') {
    return (
      'this call is running inside a delegated child agent, and a child may not open a human ' +
      `interaction, so the confirmation could not be asked; ${base}. Include the candidate ` +
      'constraint and its retirement condition in the child result and let the root agent (or the ' +
      'user) confirm it there.'
    )
  }
  if (code === 'NO_PROVIDER') {
    return (
      'no answerer accepted the question, so the user could not be asked; ' +
      `${base}. Ask the user directly with ask_user_question and only then call workflow_gc again.`
    )
  }
  if (code === 'CALLER_NOT_LIVE') {
    return `the calling agent is no longer live, so the user could not be asked; ${base}.`
  }
  if (code === 'ASK_ABORTED') {
    return `the question was aborted before the user answered; ${base}.`
  }
  return `the user-questions service failed (${safely(() => error?.message) ?? String(error)}); ${base}.`
}

/**
 * Ask the user one yes/no question through the host service.
 *
 * @param options - `{ service, exec, questionId, header, question, approveLabel, rejectLabel,
 *   approveDescription?, rejectDescription? }`.
 * @returns `{ ok: true, confirmation, selected, custom }` or `{ ok: false, status, reason }`.
 */
export async function askForConfirmation(options) {
  const {
    service,
    exec,
    questionId,
    header,
    question,
    approveLabel,
    rejectLabel,
    // Optional so the constraint ledger keeps its own wording while `workflow_set` can say
    // where the approval-gate change is written. The confirmation token is unchanged.
    approveDescription = 'Write this decision to .dsh/CONSTRAINTS.json.',
    rejectDescription = 'Change nothing.',
  } = options
  if (service === undefined) {
    return {
      ok: false,
      status: 'confirmation-unavailable',
      reason:
        'the host exposes no user-questions service, so the framework cannot ask you to confirm. ' +
        'Nothing was written. This decision is user-confirmed by design — a model asserting ' +
        '"the user agreed" is not evidence.',
    }
  }

  const signal = safely(() => (typeof AbortSignal !== 'undefined' && exec?.signal instanceof AbortSignal ? exec.signal : undefined))
  let answer
  try {
    answer = await service.ask({
      questions: [
        {
          id: questionId,
          header,
          question,
          options: [
            { label: approveLabel, description: approveDescription },
            { label: rejectLabel, description: rejectDescription },
          ],
        },
      ],
      agent: safely(() => exec?.agent),
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    return { ok: false, status: 'confirmation-failed', reason: describeAskFailure(error) }
  }

  const confirmation = confirmationFromAnswer({ answer, questionId, at: new Date(), approveLabel })
  if (confirmation.approved !== true) {
    return {
      ok: false,
      status: 'not-confirmed',
      reason:
        'the user did not choose the confirming option, so nothing was written. (Only the exact ' +
        'option label counts as approval: a typed custom answer is not treated as consent, because ' +
        '"the user typed something" is not "the user approved this text".)',
      selected: confirmation.selected,
      custom: confirmation.custom,
    }
  }
  return { ok: true, confirmation, selected: confirmation.selected, custom: confirmation.custom }
}

/** Build the confirmation question for adding a candidate. */
export function buildAddQuestion(candidate, validated) {
  const retireWhen = validated.value.retire_when
  const retires = [
    retireWhen.signal === undefined ? null : `signal (not machine-checked): ${retireWhen.signal}`,
    retireWhen.review_after_days === undefined ? null : `review_after_days: ${retireWhen.review_after_days}`,
    Array.isArray(retireWhen.observable)
      ? retireWhen.observable
          .map(entry => `observable: ${entry.kind} ${entry.phase} >= ${entry.at_least}`)
          .join('\n')
      : null,
  ].filter(Boolean)
  return [
    'Add this constraint to the workflow harness?',
    '',
    `rule: ${validated.value.rule}`,
    `why: ${validated.value.why}`,
    `added for model: ${validated.value.added_for_model}`,
    'retires when:',
    ...retires.map(line => `  - ${line}`),
    '',
    'workflow_gc will keep reporting it until that retirement condition is met, and it will only ' +
      'ever suggest retiring it — a person decides. A constraint is a bet that this model keeps ' +
      'getting something wrong; if the bet is not worth writing down, decline.',
  ].join('\n')
}

/** Build the confirmation question for retiring a constraint. */
export function buildRetireQuestion(evaluation) {
  const checks = Array.isArray(evaluation?.checks) ? evaluation.checks : []
  // AN UNEVALUATED ENTRY MUST NOT CLAIM IT DECLARES NOTHING. A defective entry (an unknown status,
  // say) or a retired one returns before the checks loop, so `checks.length === 0` there means
  // "nobody looked", not "there is nothing to look at" — and this text sits inside a prompt whose
  // answer WRITES to the ledger. Saying "declares no machine-readable condition" about an entry
  // that does declare `review_after_days` is a false statement in a consent prompt.
  const verdict = typeof evaluation?.verdict === 'string' ? evaluation.verdict : null
  const evaluated = verdict !== 'defective' && verdict !== 'retired'
  const defects = Array.isArray(evaluation?.defects) ? evaluation.defects : []
  return [
    `Retire constraint ${evaluation?.id ?? '(no id)'}?`,
    '',
    `rule: ${evaluation?.rule ?? '(not recorded)'}`,
    `why it exists: ${evaluation?.why ?? '(not recorded)'}`,
    `retirement signal (free text, NOT evaluated by the framework): ${signalForDisplay(evaluation)}`,
    'what the framework could check:',
    ...(evaluated
      ? checks.length === 0
        ? ['  - nothing: this constraint declares no machine-readable condition.']
        : checks.map(
            check =>
              `  - ${check.name}: ${check.evaluated ? (check.satisfied ? 'currently met' : 'not yet met') : 'could not be evaluated'} — ${check.detail}`,
          )
      : [
          `  - NOT EVALUATED: this entry was not evaluated as recorded (${verdict ?? 'no verdict'}), so no ` +
            'condition was checked. Do not read this as "there is nothing to check".',
          ...defects.map(defect => `    DEFECT: ${defect}`),
        ]),
    '',
    'Retiring removes a guardrail. The record is kept with status="retired"; nothing is deleted.',
  ].join('\n')
}

/**
 * Run one `workflow_gc` call.
 *
 * @param options - `{ options, args, exec }`.
 * @returns a plain, JSON-serialisable result.
 */
export async function runGc({ options = {}, args = {}, exec } = {}) {
  const action = GC_ACTIONS.includes(args?.action) ? args.action : 'scan'
  const scope = GC_SCOPES.includes(args?.scope) ? args.scope : 'constraints'
  const dryRun = args?.dry_run === true
  const rowConfig = options?.config ?? {}

  const workspace = resolveWorkspaceDir(exec)
  const projectDir = typeof args?.workspace_dir === 'string' && args.workspace_dir !== ''
    ? args.workspace_dir
    : workspace.dir

  const projectFile = readWorkflowFile(projectDir, parseWorkflowYaml)
  const { config: effective } = resolveEffectiveConfig(rowConfig, projectFile.value)
  const detected = probeProject(projectDir).detected

  // The ledger itself is PROJECT-level (`.dsh/CONSTRAINTS.json`), but the retirement signal
  // counts phase entries in the workflow state, and that state is per work unit. Validated
  // and refused rather than defaulted, like every other tool that accepts one.
  const unit = resolveWorkUnitArgument(projectDir, args?.work_unit)
  if (unit.ok !== true) {
    return workUnitRefusal(projectDir, args?.work_unit, unit.error)
  }
  const workUnit = unit.workUnit

  const scopeNote = {
    requested: scope,
    implemented: ['constraints'],
    unimplemented: UNIMPLEMENTED_SCOPES,
    note:
      'B4 delivers the constraint ledger only. Code and document garbage collection are declared by ' +
      'the design (§8.1) and are NOT implemented: this tool will not pretend to have collected ' +
      'anything it did not.',
  }

  if (effective.requireOptIn !== false && !detected) return notEnabled(projectDir)

  if (scope === 'code' || scope === 'docs') {
    return {
      ok: false,
      status: 'not-implemented',
      action,
      projectDir,
      scope: scopeNote,
      reason:
        `scope="${scope}" is declared by the design but not implemented. Only "constraints" is. ` +
        'Nothing was collected or changed.',
    }
  }

  if (effective.modules?.constraintLedger !== true) {
    return {
      ok: false,
      status: 'disabled',
      action,
      projectDir,
      reason:
        'modules.constraintLedger is off for this project, so the constraint ledger is not consulted ' +
        'and nothing is written. Set it back with workflow_set path=modules.constraintLedger value=true ' +
        'if that is intended.',
    }
  }

  // --- list: exactly what is recorded, no analysis -----------------------------
  if (action === 'list') {
    const ledger = readConstraints(projectDir)
    return {
      ok: true,
      status: 'ok',
      action,
      projectDir,
      scope: scopeNote,
      ledger: {
        path: ledger.path,
        present: ledger.present,
        problems: ledger.problems,
        counts: { total: ledger.constraints.length },
        constraints: ledger.constraints,
      },
      reason:
        'This is the ledger as recorded. No retirement condition was evaluated — use action=scan for that.',
    }
  }

  // --- retire ------------------------------------------------------------------
  if (action === 'retire') {
    const ledger = readConstraints(projectDir)
    const blocked = unreadableLedger(ledger)
    if (blocked) return { ...blocked, action, projectDir }

    const id = typeof args?.id === 'string' ? args.id : ''
    const analysis = evaluateConstraints(ledger.constraints, { state: readState(projectDir, workUnit).state })
    const target = analysis.evaluations.find(item => item.id === id)
    if (target === undefined) {
      return {
        ok: false,
        status: 'unknown-constraint',
        action,
        projectDir,
        reason: `no constraint ${JSON.stringify(id)} in ${CONSTRAINTS_RELATIVE_PATH}. Nothing was changed.`,
        known: analysis.evaluations.map(item => item.id).filter(value => typeof value === 'string'),
      }
    }
    if (target.status === 'retired') {
      return {
        ok: false,
        status: 'already-retired',
        action,
        projectDir,
        reason: `constraint ${JSON.stringify(id)} is already retired. Nothing was changed.`,
      }
    }

    if (dryRun) {
      return {
        ok: true,
        status: 'dry-run',
        action,
        projectDir,
        scope: scopeNote,
        wouldRetire: target,
        reason: 'Nothing was written and no question was asked, because dry_run was set.',
      }
    }

    const asked = await askForConfirmation({
      service: resolveUserQuestions(options, exec),
      exec,
      questionId: GC_QUESTION_IDS.retire,
      header: 'Retire a workflow constraint',
      question: buildRetireQuestion(target),
      approveLabel: GC_APPROVE_LABELS.retire,
      rejectLabel: 'Keep it',
    })
    if (asked.ok !== true) return { ...asked, action, projectDir, constraintId: id }

    const retired = retireConstraint(ledger.document, id, {
      confirmation: asked.confirmation,
      now: new Date(),
      reason: args?.reason,
    })
    if (retired.ok !== true) return { ...retired, action, projectDir, constraintId: id }

    const path = writeConstraints(projectDir, { ...retired.document, generated_at: new Date().toISOString() })
    return {
      ok: true,
      status: 'retired',
      action,
      projectDir,
      workUnit,
      scope: scopeNote,
      constraintId: id,
      constraint: retired.constraint,
      path,
      confirmedBy: 'user-question',
      reason:
        `constraint ${id} is marked retired. The entry is KEPT in the ledger, because the record of ` +
        'which constraints were needed and when they stopped being needed is the evidence the harness ' +
        'is shrinking for the right reason.',
    }
  }

  // --- add ---------------------------------------------------------------------
  if (action === 'add') {
    const ledger = readConstraints(projectDir)
    const blocked = unreadableLedger(ledger)
    if (blocked) return { ...blocked, action, projectDir }

    const validated = validateConstraintCandidate(args?.constraint, { defaultForModel: callingModel(exec) })
    if (validated.ok !== true) {
      return {
        ok: false,
        status: 'invalid-candidate',
        action,
        projectDir,
        problems: validated.problems,
        reason:
          'the candidate was refused before anything was asked or written. A constraint is not written ' +
          'without a retirement condition, a reason, and the model it was added for.',
      }
    }

    if (dryRun) {
      return {
        ok: true,
        status: 'dry-run',
        action,
        projectDir,
        scope: scopeNote,
        candidate: validated.value,
        reason:
          'the candidate is valid. Nothing was written and no question was asked, because dry_run was ' +
          'set — run again without dry_run to ask the user and write it.',
      }
    }

    const asked = await askForConfirmation({
      service: resolveUserQuestions(options, exec),
      exec,
      questionId: GC_QUESTION_IDS.add,
      header: 'Add a workflow constraint',
      question: buildAddQuestion(args?.constraint, validated),
      approveLabel: GC_APPROVE_LABELS.add,
      rejectLabel: 'Do not add it',
    })
    if (asked.ok !== true) return { ...asked, action, projectDir }

    const added = addConstraint(ledger.document, args?.constraint, {
      confirmation: asked.confirmation,
      now: new Date(),
      defaultForModel: callingModel(exec),
    })
    if (added.ok !== true) return { ...added, action, projectDir }

    const path = writeConstraints(projectDir, { ...added.document, generated_at: new Date().toISOString() })
    return {
      ok: true,
      status: 'added',
      action,
      projectDir,
      scope: scopeNote,
      constraint: added.constraint,
      path,
      confirmedBy: 'user-question',
      reason:
        `${added.constraint.id} was written after the user confirmed it. It now has to earn its keep: ` +
        'workflow_gc action=scan will report it, and will only ever SUGGEST retiring it.',
    }
  }

  // --- scan (default): the retirement check ------------------------------------
  //
  // The section is read through its OWN validator, the same one `workflow_set` writes through.
  // A malformed section is refused rather than guessed at: `retireCheck: nope` means the user's
  // intent is unknown, and the fail-closed reading of "unknown" is "did not ask for this".
  const retireCheck = readRetireCheck(effective.retireCheck, DEFAULT_CONFIG.retireCheck)
  if (!retireCheck.ok) {
    return {
      ok: false,
      status: 'unusable-config',
      action: 'scan',
      projectDir,
      problems: retireCheck.problems,
      reason:
        'the retireCheck section could not be read, so the retirement check did not run. Nothing was ' +
        'changed. Fix the section with workflow_set path=retireCheck, or unset it to use the defaults.',
    }
  }
  if (retireCheck.enabled !== true) {
    return {
      ok: false,
      status: 'disabled',
      action: 'scan',
      projectDir,
      reason:
        'retireCheck.enabled is off for this project, so the retirement check does not run. The ledger ' +
        'itself is untouched; set it back with workflow_set path=retireCheck.enabled value=true if that ' +
        'is intended.',
    }
  }

  const ledger = readConstraints(projectDir)
  const state = readState(projectDir, workUnit).state
  const analysis = evaluateConstraints(ledger.constraints, { state })

  const suggestions = retireCheck.autoSuggest === true
  /** With suggestions off the classification is unchanged; only the ASK is withheld. */
  const offer = item => (suggestions ? item : { ...item, question: null })

  // The report NEVER claims the free-text signal was verified. Each bucket's note says what the
  // bucket does and does not assert, and the `dueForHumanReview` items carry a question.
  const buckets = {
    provablyDue: {
      claim: 'every declared condition was evaluated by the framework and currently holds',
      items: analysis.provablyDue.map(offer),
    },
    dueForHumanReview: {
      claim:
        'the framework CANNOT confirm these: each one has something it did not evaluate — a ' +
        'free-text signal, a window it could not read, a condition it does not implement, or a ' +
        'recorded data problem. They are questions for a person, and each carries the constraint\'s ' +
        'reason for existing.',
      items: analysis.dueForHumanReview.map(offer),
    },
    notDue: {
      claim:
        'NOT DUE is about the machine-checked conditions only. A free-text signal may still be met; ' +
        'the framework cannot tell, and is not claiming it is unmet.',
      items: analysis.notDue.map(offer),
    },
    defective: {
      claim:
        'as recorded these can never retire. That is the failure mode the ledger exists to prevent: ' +
        'fix the retirement condition, or retire the constraint deliberately so the absence is a ' +
        'decision rather than an oversight.',
      items: analysis.defective.map(offer),
    },
    retired: { claim: 'kept for the record; the framework never deletes an entry', items: analysis.retired.map(offer) },
  }

  return {
    ok: true,
    status: analysis.counts.defective > 0 ? 'defects-found' : 'ok',
    action: 'scan',
    projectDir,
    workUnit,
    scope: scopeNote,
    ledger: {
      path: ledger.path,
      present: ledger.present,
      problems: ledger.problems,
    },
    retireCheck: {
      enabled: true,
      everyDays: retireCheck.everyDays,
      autoSuggest: suggestions,
      // The design calls this a periodic scan; nothing in this plugin SCHEDULES anything, and
      // saying "runs every N days" when no scheduler exists would be a lie about a safety net.
      scheduled: false,
      note:
        'nothing in this plugin runs on a timer: the scan happens when workflow_gc is called. ' +
        'every_days is the cadence the design intends, not a promise that a scan will occur.' +
        (suggestions
          ? ''
          : ' retireCheck.autoSuggest is off, so the per-constraint questions were withheld; the ' +
            'classification above is unchanged.'),
    },
    counts: analysis.counts,
    provablyDue: buckets.provablyDue,
    dueForHumanReview: buckets.dueForHumanReview,
    notDue: buckets.notDue,
    defective: buckets.defective,
    retired: buckets.retired,
    // A defect is reported, never silently accepted: the model is told to deal with it.
    reason:
      analysis.counts.defective > 0
        ? `${analysis.counts.defective} constraint(s) can never retire as recorded. Fix each retirement ` +
          'condition, or retire it deliberately. Nothing has been changed by this scan.'
        : analysis.counts.dueForHumanReview > 0
          ? `${analysis.counts.dueForHumanReview} constraint(s) are due for HUMAN review — the framework ` +
            'cannot fully confirm them (a free-text signal it cannot evaluate, an unreadable window, an ' +
            'unimplemented condition, or a data problem). Nothing is retired by this scan; a person decides.'
          : analysis.counts.provablyDue > 0
            // WITHOUT THIS BRANCH the headline called a report that lists "PROVABLY DUE (1)" a report
            // where "No constraint is due for review" — the one line a caller reading only the summary
            // sees, contradicting the payload it was built from.
            ? `${analysis.counts.provablyDue} constraint(s) look PROVABLY DUE to the framework: every ` +
              'declared condition it could evaluate currently holds. Nothing is retired by this scan; a person decides.'
            : 'No constraint is due for review. This scan is read-only: it never retires anything.',
  }
}

/** Refuse to write to a ledger that could not be read: a write would clobber hand-edited data. */
function unreadableLedger(ledger) {
  if (!ledger.present) return null
  const blocked = ledger.problems.length > 0 || !Array.isArray(ledger.document?.constraints)
  if (!blocked) return null
  return {
    ok: false,
    status: 'unreadable-ledger',
    problems: ledger.problems,
    path: ledger.path,
    reason:
      `${CONSTRAINTS_RELATIVE_PATH} could not be read as a constraint ledger, so nothing was written: ` +
      'appending to a document whose shape is not understood would replace the parts that were not ' +
      'understood. Fix the file, then run again.',
  }
}

/**
 * Build the `workflow_gc` tool definition.
 *
 * @param options - the resolved tool options.
 * @returns A definition accepted by `ctx.tools.register()`.
 */
export function buildGcToolDefinition(options) {
  return {
    name: 'workflow_gc',
    description:
      'Maintain the dsh-workflow harness. scope=constraints (the only implemented scope) reads ' +
      '.dsh/CONSTRAINTS.json and reports every constraint that is due for retirement. IT NEVER ' +
      'DELETES AND NEVER AUTO-RETIRES: a constraint whose retirement condition is natural language is ' +
      'reported as DUE FOR HUMAN REVIEW, with a question and an explicit statement that the framework ' +
      'cannot confirm the signal — it is never reported as though the signal had been evaluated. A ' +
      'constraint with no retirement condition at all is reported as defective, because it can never ' +
      'retire. action=add and action=retire ASK YOU to confirm through the host question service ' +
      'before anything is written; without an answer nothing is written. scope=code and scope=docs are ' +
      'declared by the design but NOT implemented, and say so rather than pretending.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [...GC_ACTIONS],
          description:
            'scan (default): the retirement check — classify every constraint and ask for nothing. ' +
            'list: the ledger exactly as recorded, with no analysis. add: propose a constraint; the ' +
            'user is asked to confirm before it is written. retire: mark a constraint retired after ' +
            'the user confirms; the record is kept.',
        },
        scope: {
          type: 'string',
          enum: [...GC_SCOPES],
          description:
            'constraints (default, implemented) | code | docs | all. code and docs are declared by the ' +
            'design and are NOT implemented by this component, so they refuse with not-implemented; ' +
            'all runs the constraint half and reports the other two as unimplemented.',
        },
        constraint: {
          type: 'object',
          description:
            'For action=add: the candidate. Requires rule, why and retire_when (with at least one of ' +
            'signal, review_after_days, observable). added_at and status are assigned by the framework ' +
            'and cannot be supplied.',
          properties: {
            rule: { type: 'string', description: 'The constraint, as one imperative sentence.' },
            why: {
              type: 'string',
              description:
                'The failure it defends against. Required: without it no human can judge whether the ' +
                'constraint may be retired.',
            },
            added_for_model: {
              type: 'string',
              description:
                'The model whose capability gap this defends against. Defaults to the model running ' +
                'this session.',
            },
            retire_when: {
              type: 'object',
              description: 'REQUIRED. The condition under which this constraint should be removed.',
              properties: {
                signal: {
                  type: 'string',
                  description:
                    'The retirement signal in natural language. The framework CANNOT evaluate it; it ' +
                    'will be surfaced as a question for a human.',
                },
                review_after_days: {
                  type: 'number',
                  description:
                    'Days after which the retirement should be reviewed. This one IS machine-checked.',
                },
                observable: {
                  type: 'object',
                  description:
                    'An OPTIONAL machine-checkable counter, for a signal the framework can really ' +
                    'evaluate. kind=phase_entries counts REAL transitions into `phase` (entries whose ' +
                    'from and to differ) recorded in .dsh/WORKFLOW.json history since this constraint ' +
                    'was added; a same-phase log line is not a transition.',
                  properties: {
                    kind: { type: 'string', enum: ['phase_entries'] },
                    // Enumerated rather than a bare string, so a bad phase is a guided choice
                    // instead of a host schema error the model has to decode.
                    phase: { type: 'string', enum: [...PHASES] },
                    at_least: { type: 'integer', minimum: 1 },
                  },
                  required: ['kind', 'phase', 'at_least'],
                  additionalProperties: false,
                },
              },
              additionalProperties: false,
            },
          },
          required: ['rule', 'why', 'retire_when'],
          additionalProperties: false,
        },
        id: {
          type: 'string',
          description: 'For action=retire: the constraint id, e.g. "C007".',
        },
        reason: {
          type: 'string',
          description: 'For action=retire: why the guardrail is no longer needed, recorded with the entry.',
        },
        dry_run: {
          type: 'boolean',
          description:
            'For action=add or action=retire: validate and report without asking the user and without ' +
            'writing.',
        },
        workspace_dir: {
          type: 'string',
          description: 'Absolute path to the project. Defaults to the current workspace.',
        },
        work_unit: {
          type: 'string',
          description:
            'Optional per-work-unit label. The constraint ledger is project-level, but the phase ' +
            'history a retirement signal counts is per work unit, so this selects which one is read. ' +
            "Omit for the project's own state. An unusable id is refused, never sanitised.",
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: renderGc(value) }],
    },
    async execute(args, exec) {
      return toLosslessJson(
        await runGc({
          options,
          args: args ?? {},
          exec,
        }),
      )
    },
  }
}

// ---------------------------------------------------------------------------
// rendering
// ---------------------------------------------------------------------------

const asArray = value => (Array.isArray(value) ? value : [])
const asText = value => (typeof value === 'string' ? value : describeValue(value))
/**
 * Serialise for display without ever throwing on a value that cannot be serialised.
 */
const asJson = value => {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text
  } catch {
    return '[unprintable value]'
  }
}

/** Render one evaluated constraint. Defensive: every field came from a hand-editable file. */
function renderConstraint(item, depth = '  ') {
  const out = []
  // Every free-text field below is `oneLine`d. `rule`/`why`/`signal` are written through the
  // tool's own add path and are only required to be a non-empty trimmed string, so a newline
  // is reachable WITHOUT host editing; rendered raw it becomes a column-0 line that is
  // indistinguishable from report structure. `note` and `question` are deliberately NOT
  // flattened: they are documented as multi-line prose and every continuation line carries
  // its own indented prefix.
  const id = typeof item?.id === 'string' ? oneLine(item.id) : '(no id)'
  const verdict = typeof item?.verdict === 'string' ? oneLine(item.verdict) : '(unknown)'
  out.push(`${depth}- ${id} [${verdict}] ${item?.rule === null || item?.rule === undefined ? '(no rule recorded)' : oneLine(item.rule)}`)
  if (item?.why !== null && item?.why !== undefined) out.push(`${depth}    why: ${oneLine(item.why)}`)
  if (item?.addedAt !== null && item?.addedAt !== undefined) {
    out.push(`${depth}    added_at: ${oneLine(item.addedAt)}${item.ageDays === null || item.ageDays === undefined ? '' : ` (${oneLine(item.ageDays)} day(s) ago)`}`)
  }
  if (item?.addedForModel !== null && item?.addedForModel !== undefined) {
    out.push(`${depth}    added_for_model: ${oneLine(item.addedForModel)}`)
  }
  if (item?.signal !== null && item?.signal !== undefined) {
    out.push(`${depth}    signal (FREE TEXT — the framework did NOT evaluate this): ${oneLine(item.signal)}`)
  } else {
    // "(none declared)" ONLY when the shared rule says there is nothing declared. A signal the
    // framework could not read IS declared, so it must be shown rather than denied.
    const display = signalForDisplay(item)
    out.push(`${depth}    signal: ${display === '(none)' ? '(none declared)' : oneLine(display)}`)
  }
  for (const check of asArray(item?.checks)) {
    const checkState =
      check?.evaluated === true ? (check?.satisfied === true ? 'MET' : 'not met') : 'NOT EVALUABLE'
    out.push(`${depth}    check ${oneLine(check?.name)}: ${checkState} — ${oneLine(check?.detail)}`)
  }
  for (const problem of asArray(item?.unevaluable)) out.push(`${depth}    could not be evaluated: ${oneLine(problem)}`)
  for (const problem of asArray(item?.problems)) out.push(`${depth}    data problem: ${oneLine(problem)}`)
  for (const defect of asArray(item?.defects)) out.push(`${depth}    DEFECT: ${oneLine(defect)}`)
  if (typeof item?.note === 'string') {
    for (const line of item.note.split('\n')) out.push(`${depth}    note: ${line}`)
  }
  if (typeof item?.question === 'string') {
    out.push(`${depth}    question for a human:`)
    for (const line of item.question.split('\n')) out.push(`${depth}      ${line}`)
  }
  return out
}

/**
 * Render a `workflow_gc` result as the text the model reads.
 *
 * @param value - the payload from the tool body.
 * @returns a human-readable report.
 */
export function renderGc(value) {
  const out = []
  const ok = value?.ok === true
  const action = typeof value?.action === 'string' ? value.action : 'scan'
  out.push(`workflow_gc (${action})${ok ? '' : ` refused (${oneLine(value?.status ?? '?')})`}`)
  if (value?.projectDir) out.push(`project: ${oneLine(value.projectDir)}`)
  // Printed only when a work unit was requested, so the project-level report is unchanged.
  if (typeof value?.workUnit === 'string' && value.workUnit !== '') {
    out.push(`work unit: ${oneLine(value.workUnit)}`)
  }

  if (typeof value?.reason === 'string') {
    // NOT flattened: several gc reasons are multi-line prose by design. The caller-supplied
    // text they interpolate is JSON.stringify'd at the point of interpolation instead, so a
    // newline inside it is escaped before it can reach this line.
    out.push('')
    out.push(value.reason)
  }
  for (const problem of asArray(value?.problems)) out.push(`  problem: ${oneLine(problem)}`)
  for (const known of asArray(value?.known)) out.push(`  known constraint: ${oneLine(known)}`)

  if (value?.scope && value.scope.requested !== 'constraints') {
    out.push('')
    out.push(`scope: requested=${oneLine(value.scope.requested)} implemented=[${asArray(value.scope.implemented).map(oneLine).join(', ')}]`)
    for (const line of asText(value.scope.note ?? '').split('\n')) if (line) out.push(`  ${line}`)
  }

  if (value?.ledger) {
    out.push('')
    out.push(
      `ledger ${oneLine(value.ledger.path ?? '(unknown path)')}: ` +
        (value.ledger.present === true ? 'present' : 'absent (no constraint has been added yet)'),
    )
    for (const problem of asArray(value.ledger.problems)) out.push(`  ledger problem: ${oneLine(problem)}`)
  }

  if (value?.retireCheck) {
    out.push(
      `retire check: enabled=${value.retireCheck.enabled === true} every_days=${oneLine(value.retireCheck.everyDays)} ` +
        `auto_suggest=${value.retireCheck.autoSuggest === true} scheduled=${value.retireCheck.scheduled === true}`,
    )
  }

  if (value?.counts) {
    out.push(
      `constraints: ${oneLine(value.counts.total)} recorded, ${oneLine(value.counts.provablyDue)} provably due, ` +
        `${oneLine(value.counts.dueForHumanReview)} due for human review, ${oneLine(value.counts.notDue)} not due, ` +
        `${oneLine(value.counts.defective)} defective, ${oneLine(value.counts.retired)} retired`,
    )
  }

  const sections = [
    ['PROVABLY DUE', value?.provablyDue],
    ['DUE FOR HUMAN REVIEW', value?.dueForHumanReview],
    ['NOT DUE', value?.notDue],
    ['DEFECTIVE — CAN NEVER RETIRE', value?.defective],
    ['RETIRED', value?.retired],
  ]
  for (const [title, section] of sections) {
    const items = asArray(section?.items)
    if (items.length === 0) continue
    out.push('')
    out.push(`${title} (${items.length})`)
    out.push(`  ${oneLine(section?.claim ?? '')}`)
    for (const item of items) for (const line of renderConstraint(item)) out.push(line)
  }

  if (Array.isArray(value?.constraints)) {
    out.push('')
    out.push(`recorded constraints (${value.constraints.length}):`)
    for (const entry of value.constraints) out.push(`  ${asJson(entry)}`)
  }
  if (value?.constraint) {
    out.push('')
    out.push(`constraint: ${asJson(value.constraint)}`)
  }
  if (value?.path) out.push(`written: ${asText(value.path)}`)
  if (value?.candidate) {
    out.push('')
    out.push(`candidate: ${asJson(value.candidate)}`)
  }
  if (value?.selected !== undefined && value.selected !== null) {
    out.push(`answer: selected=[${asArray(value.selected).join(', ')}]${value.custom === null || value.custom === undefined ? '' : ` custom=${asText(value.custom)}`}`)
  }
  return out.join('\n')
}
