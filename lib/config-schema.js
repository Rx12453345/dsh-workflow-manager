/**
 * The exported `Config` schema.
 *
 * Three constraints shape this file:
 *
 *  1. `dsh-settings` only serves fields a plugin declares with `.volatile()`, so
 *     the whole schema is made volatile in ONE call on the root object.
 *     Nesting `.volatile()` inside a volatile subtree is rejected outright
 *     ("volatile fields require a fixed object path without an enclosing volatile
 *     field"), which is why no inner field repeats it.
 *  2. A plugin-declared `Config` supersedes the loader row's `config:` block, so
 *     this schema must carry the SAME defaults as `config.js`.
 *     `run-config-check.mjs` asserts the two stay in step.
 *  3. `z` is injected rather than imported, so this module is testable without the
 *     schemastery package present.
 *
 * @module src-12453345_-dsh-workflow/config-schema
 */

import {
  DEFAULT_CONFIG,
  TIERS,
  RECIPES,
  APPROVAL_STRENGTHS,
  RISK_LEVELS,
  VERIFICATION_POLICIES,
  VERIFICATION_CONFIRMATIONS,
} from './config.js'

/** Module keys, in the order the settings page should present them. */
const MODULE_KEYS = Object.keys(DEFAULT_CONFIG.modules)

/** Verifier sensor names offered by the built-in verifier. */
const SENSOR_KEYS = DEFAULT_CONFIG.verifier.sensors

/** Evaluator dimension names offered by the built-in evaluator. */
const DIMENSION_KEYS = DEFAULT_CONFIG.evaluator.dimensions

/** A nullable number, used by the budget and guard limits. */
const nullableNumber = (z, value) => z.union([z.number(), z.const(null)]).default(value)

/** A nullable string choice, used by the recipe. */
const nullableChoice = (z, values, value) =>
  z.union([...values, z.const(null)]).default(value)
/**
 * Build the schemastery schema for the plugin configuration.
 *
 * @param z - the schemastery module.
 * @returns A volatile schemastery object schema.
 */
export function buildConfigSchema(z) {
  const schema = z.object({
    // ---- tier and recipe ----
    tier: z.union(TIERS).default(DEFAULT_CONFIG.tier),
    recipe: nullableChoice(z, RECIPES, DEFAULT_CONFIG.recipe),

    // ---- module switches: every mechanism can be turned off ----
    modules: z.object(
      Object.fromEntries(
        MODULE_KEYS.map(key => [key, z.boolean().default(DEFAULT_CONFIG.modules[key])]),
      ),
    ),

    // ---- context isolation ----
    context: z.object({
      maxInlineTokens: z.number().default(DEFAULT_CONFIG.context.maxInlineTokens),
      overflow: z
        .union(['spill-to-file', 'truncate', 'fail'])
        .default(DEFAULT_CONFIG.context.overflow),
      exclude: z.array(z.string()).default([...DEFAULT_CONFIG.context.exclude]),
      requireBootstrap: z.boolean().default(DEFAULT_CONFIG.context.requireBootstrap),
    }),

    // ---- acceptance negotiation ----
    acceptance: z.object({
      negotiateBeforeBuild: z.boolean().default(DEFAULT_CONFIG.acceptance.negotiateBeforeBuild),
      maxRounds: z.number().default(DEFAULT_CONFIG.acceptance.maxRounds),
    }),

    // ---- independent evaluation ----
    evaluator: z.object({
      independent: z.boolean().default(DEFAULT_CONFIG.evaluator.independent),
      bar: z.number().default(DEFAULT_CONFIG.evaluator.bar),
      maxRounds: z.number().default(DEFAULT_CONFIG.evaluator.maxRounds),
      dimensions: z.array(z.string()).default([...DIMENSION_KEYS]),
      mustPass: z.array(z.string()).default([...DEFAULT_CONFIG.evaluator.mustPass]),
    }),

    // ---- computational sensors ----
    verifier: z.object({
      sensors: z.array(z.string()).default([...SENSOR_KEYS]),
      stopOnFirstFailure: z.boolean().default(DEFAULT_CONFIG.verifier.stopOnFirstFailure),
      feedMessageStyle: z
        .union(['actionable', 'plain'])
        .default(DEFAULT_CONFIG.verifier.feedMessageStyle),
    }),

    // ---- hard guards ----
    guards: z.object({
      forbidTestEdits: z.boolean().default(DEFAULT_CONFIG.guards.forbidTestEdits),
      forbidNewDeps: z.boolean().default(DEFAULT_CONFIG.guards.forbidNewDeps),
      maxFilesPerFeature: nullableNumber(z, DEFAULT_CONFIG.guards.maxFilesPerFeature),
      requireHumanOnFatal: z.boolean().default(DEFAULT_CONFIG.guards.requireHumanOnFatal),
    }),

    // ---- subagent limits ----
    subagent: z.object({
      // Pinned to 1 by an invariant in config.js; still surfaced so the value is visible.
      maxDepth: z.number().default(DEFAULT_CONFIG.subagent.maxDepth),
      maxActiveSubagents: z.number().default(DEFAULT_CONFIG.subagent.maxActiveSubagents),
      keyRolesModel: z.boolean().default(DEFAULT_CONFIG.subagent.keyRolesModel),
      keyRolesProvider: z.string().default(DEFAULT_CONFIG.subagent.keyRolesProvider),
      keyRolesModelId: z.string().default(DEFAULT_CONFIG.subagent.keyRolesModelId),
    }),

    // ---- approval strength ----
    approval: z.object({
      strength: z.union(APPROVAL_STRENGTHS).default(DEFAULT_CONFIG.approval.strength),
      riskThreshold: z.union(RISK_LEVELS).default(DEFAULT_CONFIG.approval.riskThreshold),
      denyHighAlways: z.boolean().default(DEFAULT_CONFIG.approval.denyHighAlways),
      exemptTools: z.array(z.string()).default([...DEFAULT_CONFIG.approval.exemptTools]),
    }),

    // ---- risk-based verification depth ----
    //
    // `policy` is a real choice and it is offered to the user, because the whole point of this
    // feature is that the decision is made explicitly rather than skipped. The default stays
    // `off`, so a schema default can never turn the gate on for someone who did not ask.
    verification: z.object({
      policy: z.union(VERIFICATION_POLICIES).default(DEFAULT_CONFIG.verification.policy),
      confirmation: z
        .union(VERIFICATION_CONFIRMATIONS)
        .default(DEFAULT_CONFIG.verification.confirmation),
      report: z.boolean().default(DEFAULT_CONFIG.verification.report),
    }),

    // ---- escalation triggers ----
    escalation: z.object({
      onContextOverflow: z.boolean().default(DEFAULT_CONFIG.escalation.onContextOverflow),
      featureAttempts: z.number().default(DEFAULT_CONFIG.escalation.featureAttempts),
      onScopeCreep: z.boolean().default(DEFAULT_CONFIG.escalation.onScopeCreep),
      sensorRepeatFailures: z.number().default(DEFAULT_CONFIG.escalation.sensorRepeatFailures),
    }),

    // ---- budget ----
    budget: z.object({
      maxMinutes: nullableNumber(z, DEFAULT_CONFIG.budget.maxMinutes),
      maxSubagentCalls: nullableNumber(z, DEFAULT_CONFIG.budget.maxSubagentCalls),
      onExceed: z.union(['ask', 'stop', 'continue']).default(DEFAULT_CONFIG.budget.onExceed),
    }),

    // ---- constraint retirement ----
    retireCheck: z.object({
      enabled: z.boolean().default(DEFAULT_CONFIG.retireCheck.enabled),
      everyDays: z.number().default(DEFAULT_CONFIG.retireCheck.everyDays),
      autoSuggest: z.boolean().default(DEFAULT_CONFIG.retireCheck.autoSuggest),
    }),

    // ---- high-cost sign-off gates ----
    signoff: z.object({
      beforeGenerate: z.boolean().default(DEFAULT_CONFIG.signoff.beforeGenerate),
      beforeExpensiveBuild: z.boolean().default(DEFAULT_CONFIG.signoff.beforeExpensiveBuild),
      beforeBulkEdit: z.boolean().default(DEFAULT_CONFIG.signoff.beforeBulkEdit),
    }),

    // ---- internal row markers ----
    //
    // `rowKind` is deliberately ABSENT. A schema default becomes the field's value,
    // so declaring `rowKind: ''` here would overwrite the module row's
    // `rowKind: 'module'` and make that row register the tools a second time.
    // Fields that exist only to steer mounting must stay out of the schema.
    requireOptIn: z.boolean().default(DEFAULT_CONFIG.requireOptIn),

    // ---- panel-only presentation ----
    // Safe here: the panel row's patch values already equal these defaults.
    showInSidebar: z.boolean().default(DEFAULT_CONFIG.showInSidebar),
    sidebarLabel: z.string().default(DEFAULT_CONFIG.sidebarLabel),
    showInPluginPage: z.boolean().default(DEFAULT_CONFIG.showInPluginPage),
  })

  // ONE volatile call on the root marks the whole subtree editable. Volatile is
  // METADATA: the host projects this schema into JSON Schema and never calls it, so
  // the "volatile fields store a placeholder" behaviour never runs against it.
  return schema.volatile()
}

export { MODULE_KEYS, SENSOR_KEYS, DIMENSION_KEYS }
