/**
 * Configuration model for dsh-workflow.
 *
 * The config is validated and normalised here rather than through a schema
 * library, so the package keeps zero runtime dependencies (the dsh-ops
 * convention). Every entry below is optional; `resolveConfig` deep-merges the
 * caller's raw config over the defaults.
 *
 * @module src-12453345_-dsh-workflow/config
 */

import { readEvaluatorGate } from './gate.js'
import {
  APPROVAL_STRENGTHS,
  RISK_LEVELS,
  readApprovalGate,
  approvalWarningLines,
  isHumanAuthorizationRemoved,
} from './approval.js'

/** Workflow tiers, from lightest to heaviest. */
export const TIERS = ['minimal', 'standard', 'strict']

/** Named workflow recipes that override a tier. */
export const RECIPES = ['hotfix', 'spike', 'refactor', 'docs', 'review']

/**
 * Approval strengths and risk levels are OWNED BY `lib/approval.js` and re-exported
 * here, so the option vocabulary a user writes and the predicate the gate runs cannot
 * drift apart. The gate's validator imports `gate.js` only, which is what keeps this
 * re-export from being an import cycle.
 */
export { APPROVAL_STRENGTHS, RISK_LEVELS }

/**
 * Highest permitted `subagent.maxDepth`.
 *
 * `maxDepth` is an absolute ceiling on the delegation tree. The plugin has exactly two
 * roles that delegate — an orchestrator and its reviewer — so 2 is the smallest value
 * that supports the recommended architecture and still makes recursion impossible.
 * Raising it further only multiplies cost.
 */
export const MAX_SUBAGENT_DEPTH = 2

// ---------------------------------------------------------------------------
// the risk-based verification-depth policy
// ---------------------------------------------------------------------------
//
// WHY THIS EXISTS, IN THE USER'S OWN TERMS
// A CSS tweak and a change to the approval gate both cost the same ~30 minutes: the unit
// suite, one or more mutation harnesses, an independent reviewer child, and the user's own
// confirmation. The heavy process is not waste — it has found a silently dropped
// `workspace_dir` that wrote to the wrong project, a bypass in the mutation lock, a layout
// root cause no amount of reading would have found, and a mutation harness with no restore
// check. But paying that price for a documentation edit is what makes the process feel like
// a tax, and a tax gets skipped.
//
// So the goal is not "less verification". It is verification whose depth tracks RISK, with
// the choice made EXPLICITLY rather than skipped silently. Three properties make that safe
// enough to ship:
//
//   1. THE FLOOR IS COMPUTED, NOT DECLARED. A class is a claim; `classifyChange` reads the
//      changed files (and the diff's own headers) and returns the class the evidence
//      supports. The resolved depth is the STRICTER of the two, so a declaration can only
//      ever ADD cost. It can never subtract it.
//   2. A CLASS THAT CANNOT BE HONOURED IS REFUSED, NOT COERCED. Declaring "docs" while the
//      diff touches `lib/approval.js` does not resolve to docs and does not resolve silently
//      to security either: it is a refusal that names the file that contradicts the claim.
//      The failure this policy could newly introduce is a misclassification that skips the
//      gate's own review, so that is the one thing it must never allow.
//   3. UNREADABLE EVIDENCE FAILS CLOSED. An empty file list, a hand-edited config value the
//      reader does not recognise, or a malformed section all resolve to the STRICTER side.
//      There is no path from "I could not read it" to "run less".

/**
 * The change-class vocabulary, from the shallowest permitted depth to the deepest.
 *
 * A class is a NAME FOR A RISK, not a name for a depth: the depth comes from
 * {@link VERIFICATION_DEPTHS} and the mapping in {@link CHANGE_CLASSES}, so a class can be
 * re-pointed at a different depth without renaming it in every recorded decision.
 */
export const CHANGE_CLASS_IDS = Object.freeze(['docs', 'ui', 'logic', 'security'])

/**
 * The verification depths, from shallowest to deepest.
 *
 * These are NUMBERS rather than names so that "stricter" is a total order a resolver can take
 * a maximum over. That maximum is the whole mechanism: it is what makes "a declaration can
 * only add cost" a checkable statement instead of a promise in a comment.
 */
export const VERIFICATION_DEPTHS = Object.freeze({
  /** The unit suite and nothing else. */
  UNIT: 0,
  /** Unit suite plus the one mutation harness that covers the touched files. */
  HARNESS: 1,
  /** Unit suite plus every harness covering the touched files. */
  HARNESSES: 2,
  /** Everything above, plus an independent reviewer child. */
  INDEPENDENT: 3,
})

/** The deepest rung; nothing may resolve above it. */
export const MAX_VERIFICATION_DEPTH = VERIFICATION_DEPTHS.INDEPENDENT

/** One line per rung, so no report has to invent its own description of a depth. */
export const VERIFICATION_DEPTH_LABELS = Object.freeze({
  [VERIFICATION_DEPTHS.UNIT]: 'unit suite only',
  [VERIFICATION_DEPTHS.HARNESS]: 'unit suite + the one covering mutation harness',
  [VERIFICATION_DEPTHS.HARNESSES]: 'unit suite + every covering mutation harness',
  [VERIFICATION_DEPTHS.INDEPENDENT]: 'unit suite + every covering mutation harness + independent review',
})

/**
 * The classes and the depth each one permits, with the reason attached.
 *
 * `shallowest` is the depth a caller may DECLARE. It is a ceiling on degradation, never a
 * promise: `security` is the class that must not be degradable, so its shallowest depth is the
 * maximum of the ladder, and `isSecurityFloored` below asserts that relationship rather than
 * trusting the table to have been typed correctly.
 */
export const CHANGE_CLASSES = Object.freeze({
  docs: Object.freeze({
    id: 'docs',
    shallowest: VERIFICATION_DEPTHS.UNIT,
    independentReview: 'optional',
    humanCheck: false,
    summary: 'documentation and configuration copy — no executable behaviour changes',
  }),
  ui: Object.freeze({
    id: 'ui',
    // THE SAME DEPTH AS `logic`, PLUS A HUMAN. The floors are deliberately EQUAL: a UI change is
    // not a smaller-risk change than a logic change, it is a change whose most important check no
    // test can perform. Giving `ui` a shallower floor would have made `lib/client.js` —
    // executable, harness-covered code — declarable as a one-harness class by CALLING IT UI,
    // which lowers coverage by relabelling. The human check is an addition on top of the same
    // depth, so the class is stricter than `logic`, not looser.
    shallowest: VERIFICATION_DEPTHS.HARNESSES,
    independentReview: 'optional',
    humanCheck: true,
    summary: 'user-visible presentation — layout, styles, rendered text',
  }),
  logic: Object.freeze({
    id: 'logic',
    shallowest: VERIFICATION_DEPTHS.HARNESSES,
    independentReview: 'optional',
    humanCheck: false,
    summary: 'behaviour of code that does not decide authorisation',
  }),
  security: Object.freeze({
    id: 'security',
    shallowest: VERIFICATION_DEPTHS.INDEPENDENT,
    // REQUIRED, not offered. A security change that skips independent review is the single
    // downgrade this policy must make impossible.
    independentReview: 'required',
    humanCheck: false,
    summary: 'approval, authorization, permissions, or the gate that decides whether a call runs',
  }),
})

/** The class whose depth may never be lowered by a declaration. */
export const SECURITY_CLASS = 'security'

/**
 * Files whose CONTENT decides whether a tool call is allowed to run.
 *
 * This list is the policy's own statement of what it treats as a security surface, and it is
 * deliberately a list of FILES rather than a search for suggestive words: a token scan would
 * let a rename hide the surface, and this project already carries a comment explaining why a
 * checker must read structure rather than text patterns (`lib/approval.js`).
 *
 * A path NOT in {@link KNOWN_SOURCE_FILES} is treated as STRICTER than security, not relaxed —
 * see `classifyChange`. That is the fail-closed direction, and it means a file added later
 * cannot enter the repository through this policy's blind spot.
 */
export const SECURITY_FILES = Object.freeze([
  'lib/approval.js',
  'lib/approval-state.js',
  'lib/gate.js',
  'lib/work-unit.js',
])

/**
 * Source paths this policy has an opinion about, so that "unknown" can mean something narrower
 * than "not a security file". Both `lib/` and `tooling/` are listed: the harnesses rewrite
 * `lib/` sources and are executable behaviour in their own right.
 */
export const KNOWN_SOURCE_FILES = Object.freeze([
  ...SECURITY_FILES,
  'cordis.patch.yml',
  'lib/advance.js',
  'lib/client.js',
  'lib/components/core/index.js',
  'lib/components/panel/index.js',
  'lib/config-schema.js',
  'lib/config.js',
  'lib/constraints.js',
  'lib/gc.js',
  'lib/index.js',
  'lib/project.js',
  'lib/review.js',
  'lib/schemastery.js',
  'lib/shared.js',
  'lib/tools.js',
  'lib/workflow-file.js',
  'package.json',
  'run-config-check.mjs',
  'run-smoke-test.mjs',
  'run-unit-tests.mjs',
])

/** Extensions that cannot change executable behaviour. */
const DOC_FILE_PATTERN = /\.(?:md|markdown|mdx|txt|rst|adoc)$/i

/**
 * Source files that build RENDERED output, listed where the extension cannot say so.
 *
 * `lib/client.js` is the package's browser half: it constructs the DOM of the settings form,
 * the sidebar panel and the conversation tab, and NOTHING in this repository measures what it
 * renders. By extension it is ordinary `.js`, and the first version of this policy therefore
 * classified it `logic` — which happened to give it the right depth for the wrong reason, and
 * silently dropped the HUMAN check, the one check that ever caught its most expensive defect.
 *
 * So the surface is listed, exactly as the security surfaces are, rather than inferred from a
 * word in the filename. The alternative — matching `client` in the name — would make a file
 * `client-side-cache.js` a UI file and a renamed browser half invisible.
 */
export const UI_FILES = Object.freeze(['lib/client.js'])

/**
 * Extensions that carry rendered output.
 *
 * `ui` is the only class that requires a human, and the reason is specifically RENDERING. A
 * stylesheet or a template qualifies by extension; a Markdown file does not, however much a
 * person might like reading it.
 *
 * Kept narrow on purpose: it answers "does this extension render", and it is NOT used to decide
 * whether a file is a UI surface — see {@link UI_FILES} for why that is a list.
 */
const UI_FILE_PATTERN = /\.(?:css|scss|sass|less|html|htm|svg|tsx|jsx|vue|svelte)$/i

/**
 * The project-scoped classification, defaulting to "nothing declared".
 *
 * WHY THIS EXISTS. The built-in lists describe THIS PLUGIN'S repository. An external project's
 * ordinary `.js` file is not in them, so `classifyChange` treated every such file as an
 * unclassified security surface: correct fail-closed behaviour for the plugin itself, unusable
 * for a project that merely uses the plugin. A project can now say which trees are its source,
 * which files are security or UI surfaces, and whether an unrecognised source is acceptable.
 *
 * THE DEFAULT IS STILL FAIL-CLOSED. An external project that declares nothing keeps today's
 * behaviour (unknown executable -> security). `allowUnknownSources: true` is the explicit opt-in
 * that turns an unrecognised source into `logic`; it is never the default.
 */
export function emptyClassification() {
  return {
    sources: [],
    security: [],
    ui: [],
    allowUnknownSources: false,
    inferUiFromExtensions: true,
  }
}

/**
 * Normalise one project-relative source pattern.
 *
 * Rejects absolute paths and `..` segments: a classification entry that escapes the project
 * would let a caller label an outside file as ordinary source. Only `*`/`**` are special.
 */
function normaliseClassificationPattern(raw) {
  if (typeof raw !== 'string') return null
  let text = raw.trim().replace(/\\/g, '/').replace(/\/+$/, '')
  if (text.startsWith('./')) text = text.slice(2)
  if (text === '' || text.startsWith('/') || /^[A-Za-z]:/.test(text)) return null
  const segments = text.split('/')
  if (segments.some(segment => segment === '' || segment === '.' || segment === '..')) return null
  return segments.join('/').toLowerCase()
}

function readClassificationList(name, value, problems) {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) {
    problems.push(`${name} is ${describeValue(value)}; expected a list of project-relative paths.`)
    return []
  }
  const out = []
  for (const entry of value) {
    const normalised = normaliseClassificationPattern(entry)
    if (normalised === null) {
      problems.push(
        `${name} contains ${describeValue(entry)}, which is not a project-relative path ` +
          "(no absolute path, no '..'; '*' and '**' are allowed)",
      )
    } else if (!out.includes(normalised)) {
      out.push(normalised)
    }
  }
  return out
}

/**
 * Read and validate the classification fields of `verification`.
 *
 * Any invalid entry makes the WHOLE classification unusable. Dropping only the bad entry would
 * be fail-open on the security axis: `security: ['../bad']` would disappear while
 * `sources: ['lib']` still labelled the file ordinary logic. The caller falls back to the
 * fail-closed default instead.
 */
function readClassification(value, problems) {
  const classification = emptyClassification()
  if (!isPlainObject(value)) return classification
  classification.sources = readClassificationList('verification.sources', value.sources, problems)
  classification.security = readClassificationList('verification.security', value.security, problems)
  classification.ui = readClassificationList('verification.ui', value.ui, problems)
  if (value.allowUnknownSources !== undefined) {
    if (typeof value.allowUnknownSources !== 'boolean') {
      problems.push(
        `verification.allowUnknownSources is ${describeValue(value.allowUnknownSources)}; expected true or false.`,
      )
    } else {
      classification.allowUnknownSources = value.allowUnknownSources
    }
  }
  if (value.inferUiFromExtensions !== undefined) {
    if (typeof value.inferUiFromExtensions !== 'boolean') {
      problems.push(
        `verification.inferUiFromExtensions is ${describeValue(value.inferUiFromExtensions)}; expected true or false.`,
      )
    } else {
      classification.inferUiFromExtensions = value.inferUiFromExtensions
    }
  }
  return classification
}

/** Match one normalised path against one project pattern (case-insensitive). */
function matchesClassificationPattern(path, pattern) {
  const candidate = path.toLowerCase()
  if (candidate === pattern || candidate.startsWith(`${pattern}/`)) return true
  if (!pattern.includes('*')) return false
  let source = '^'
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index]
    if (character === '*') {
      if (pattern[index + 1] === '*') {
        source += '.*'
        index += 1
      } else {
        source += '[^/]*'
      }
    } else {
      source += character.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    }
  }
  source += '$'
  try {
    return new RegExp(source, 'i').test(candidate)
  } catch {
    return false
  }
}

function matchesClassification(path, patterns) {
  return patterns.some(pattern => matchesClassificationPattern(path, pattern))
}

/**
 * The `verification` section of the configuration.
 *
 * `off` is the default and it is load-bearing: a project that declares nothing gets exactly
 * today's behaviour, so nothing silently weakens. `advisory` resolves and reports the class
 * without refusing anything; `enforced` refuses a declaration the evidence contradicts and
 * requires the user to confirm the choice. `enforced` is the only setting under which this
 * policy can change what runs.
 */
export const VERIFICATION_POLICIES = Object.freeze(['off', 'advisory', 'enforced'])

/** When a resolved depth must be confirmed by the user before gated work proceeds. */
export const VERIFICATION_CONFIRMATIONS = Object.freeze(['never', 'on-override', 'always'])

/** The default `verification` section. */
export const DEFAULT_VERIFICATION = Object.freeze({
  // `off` IS LOAD-BEARING, NOT TIMID. Do not "helpfully" flip this to `enforced`: the suite
  // pins the guarantee that a project which declares NOTHING gets exactly the behaviour it had
  // before, and turning enforcement on globally breaks it — `a project that declares nothing
  // gets exactly the behaviour it had before` goes red, and every review path that omits a
  // class is silently escalated. That was tried and reverted.
  //
  // The slowness this default causes is real (a docs-only change buys the full loop plus an
  // independent reviewer). The fix for it is for callers to DECLARE a class, which the
  // guidance in `renderWorkflowGuidance` asks for — not for the default to change.
  //
  // `advisory` resolves and reports without gating. `enforced` refuses contradicted classes
  // and asks the user when a declaration does not survive.
  policy: 'off',
  confirmation: 'on-override',
  report: true,
})

/** Whether the security class is floored at the deepest rung — asserted, not assumed. */
export function isSecurityFloored() {
  return CHANGE_CLASSES[SECURITY_CLASS]?.shallowest === MAX_VERIFICATION_DEPTH
}

/**
 * The complete default configuration. Mirrors the documented parameters in
 * `cordis.patch.yml`, which ships the same values for the loader's row config.
 */
export const DEFAULT_CONFIG = {
  /** Only operate in projects that contain `.dsh/workflow.yml`. */
  requireOptIn: true,

  /**
   * Internal marker. The declaration-only module row sets `rowKind: 'module'` so
   * that row mounts without registering a second copy of the tools; it exists
   * because the host can only discover this package's browser half through a row
   * mounted on the BARE package name.
   */
  rowKind: '',

  tier: 'standard',
  recipe: null,

  modules: {
    planner: true,
    featuresJson: true,
    progressLog: true,
    handoffDoc: true,
    acceptance: true,
    independentReview: true,
    selfVerify: true,
    gcCode: true,
    gcDocs: true,
    constraintLedger: true,
    stats: true,
    gitCommitPerFeature: true,
    isolation: true,
  },

  context: {
    maxInlineTokens: 12500,
    overflow: 'spill-to-file',
    exclude: ['tool_history', 'error_logs', 'prior_attempts', 'reasoning'],
    requireBootstrap: true,
  },

  acceptance: {
    negotiateBeforeBuild: true,
    maxRounds: 3,
  },

  evaluator: {
    independent: true,
    bar: 8,
    // TWO ROUNDS, NOT THREE.
    //
    // A live loop spent three rounds and roughly forty minutes chasing findings that were
    // real but narrow — several of which the reviewer itself marked unreachable. The gate
    // now ignores unreachable findings (see `decideVerdict`), which removes most of that,
    // and the budget is halved on top because the evidence says the second round is where
    // the value is and the third is where the cost is.
    //
    // When the budget runs out the review reports `exhausted` rather than looping, which is
    // the honest terminal state: take the work to real operation, or to a human.
    maxRounds: 2,
    dimensions: [
      'correctness',
      'build',
      'tests',
      'regressions',
      'archFit',
      'legibility',
      'scope',
    ],
    mustPass: ['correctness', 'build', 'regressions'],
  },

  verifier: {
    sensors: ['typecheck', 'lint', 'test', 'build', 'smoke', 'arch_test'],
    stopOnFirstFailure: true,
    feedMessageStyle: 'actionable',
  },

  guards: {
    forbidTestEdits: true,
    forbidNewDeps: false,
    maxFilesPerFeature: null,
    requireHumanOnFatal: true,
  },

  subagent: {
    // DEPTH 2, NOT 1 — because the architecture this plugin recommends needs it.
    //
    // `maxDepth` is an ABSOLUTE ceiling on the delegation tree, not a per-call budget:
    // the service computes `childDepth = delegationDepthOf(parent) + 1` and refuses when
    // `childDepth > maxDepth`. So with `maxDepth: 1`:
    //
    //   main agent (depth 0) → orchestrator child (depth 1) → reviewer (depth 2)  ✗ REFUSED
    //   main agent (depth 0) → reviewer (depth 1)                                 ✓
    //
    // Depth 1 therefore forces every review to be orchestrated from the MAIN
    // conversation, which is precisely the context pollution this plugin exists to
    // avoid. The better shape is: the main model delegates the whole build-and-review
    // loop to ONE child, and that child owns the review round-trips. That child is at
    // depth 1, so its reviewer is depth 2, so the ceiling has to be at least 2.
    //
    // It is still bounded: depth 2 lets a delegated orchestrator start a reviewer,
    // and the reviewer itself cannot delegate again. Nothing recurses further.
    // The value is passed per request by `workflow_review`, so this default is the only
    // place the ceiling is expressed.
    maxDepth: 2,
    maxActiveSubagents: 8,
    keyRolesModel: false,
    keyRolesProvider: '',
    keyRolesModelId: '',
  },

  approval: {
    strength: 'ask-user',
    riskThreshold: 'medium',
    denyHighAlways: true,
    exemptTools: [],
  },

  // ---- risk-based verification depth ----
  //
  // `policy: 'off'` is the default and it is LOAD-BEARING: a project that declares nothing gets
  // exactly the behaviour every previous release had, so adopting this feature cannot silently
  // weaken anyone. `advisory` resolves and reports without refusing; `enforced` refuses a
  // declaration the changed files contradict and requires the user to confirm the depth.
  //
  // `report` is true even when the policy is off, because printing the class costs nothing and
  // is the half of the user's request that does not need a gate ("so an operator can see at a
  // glance what level of verification a piece of work is under").
  verification: { ...DEFAULT_VERIFICATION },

  escalation: {
    onContextOverflow: true,
    featureAttempts: 3,
    onScopeCreep: true,
    sensorRepeatFailures: 2,
  },

  budget: {
    maxMinutes: null,
    maxSubagentCalls: null,
    onExceed: 'ask',
  },

  retireCheck: {
    enabled: true,
    everyDays: 30,
    autoSuggest: true,
  },

  signoff: {
    beforeGenerate: false,
    beforeExpensiveBuild: false,
    beforeBulkEdit: true,
  },

  // Panel-only fields; harmless on the core row.
  showInSidebar: true,
  sidebarLabel: '工作流设置',
  showInPluginPage: true,
}

/** Keys whose value is a plain object that must be merged rather than replaced. */
const DEEP_KEYS = new Set(Object.keys(DEFAULT_CONFIG).filter(key => {
  const value = DEFAULT_CONFIG[key]
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}))

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}


/**
 * A path as this policy compares it: forward slashes, no leading `./`, trimmed.
 *
 * Paths arrive from a model-authored argument, from a diff header and (in tests) from a
 * fixture, and all three spell the same file differently. Comparing raw strings made
 * `lib\\approval.js` invisible to a check for `lib/approval.js`, which is precisely the shape
 * of the silently-dropped-argument defect this project already paid for once.
 *
 * @param value - a candidate path.
 * @returns the canonical form, or null when the value is not a usable path.
 */
export function normalisePath(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim().replace(/\\/g, '/')
  if (trimmed === '') return null
  const withoutDot = trimmed.replace(/^\.\//, '')
  return withoutDot === '' ? null : withoutDot
}

/**
 * Whether a value is one of the class names.
 *
 * @param value - the candidate.
 * @returns true when the value names a class.
 */
export function isChangeClass(value) {
  return typeof value === 'string' && Object.hasOwn(CHANGE_CLASSES, value)
}

/** The strictest class in the vocabulary, used as the fail-closed fallback. */
export function strictestChangeClass() {
  return SECURITY_CLASS
}

/**
 * Whether a path names a file whose content decides what is allowed to run.
 *
 * A bare basename matches too, because a caller may report `approval.js` rather than the
 * repository-relative path. Basename matching is WEAKER evidence, so it is only ever allowed
 * to raise the class, never to lower it — which is why it is used here and not in a
 * "this file is safe" test.
 *
 * @param path - a raw or normalised path.
 * @returns true for a security surface.
 */
export function isSecurityPath(path) {
  const normalised = normalisePath(path)
  if (normalised === null) return false
  // EXACT MATCH FIRST. This branch is what carries the slash normalisation and the `./` strip:
  // every SECURITY_FILES entry is written in repository-relative form, so a caller that spells the
  // path the way this repository does is decided here and nowhere else.
  if (SECURITY_FILES.includes(normalised)) return true
  // THE BASENAME FALLBACK IS SECOND, and it exists because a caller may reasonably report
  // `approval.js` rather than `lib/approval.js`. It is a WEAKER signal — that name could belong to
  // an unrelated file in another directory — so it is only ever allowed to RAISE the class, which
  // is the direction that costs verification rather than the direction that skips it.
  const base = normalised.split('/').pop()
  return SECURITY_FILES.some(file => file.split('/').pop() === base)
}

/** Whether a path is one this policy has an opinion about. */
export function isKnownSourcePath(path) {
  const normalised = normalisePath(path)
  if (normalised === null) return false
  if (KNOWN_SOURCE_FILES.includes(normalised)) return true
  const base = normalised.split('/').pop()
  return KNOWN_SOURCE_FILES.some(file => file.split('/').pop() === base)
}

/**
 * Extract file paths from a unified diff, reading its HEADERS and never its content.
 *
 * Reading content would let a diff that merely mentions `lib/approval.js` (in a comment, say)
 * raise its own class, and would let a literal be hidden from a check by rewording — the
 * evasion shape this project has an explicit rule against. Header lines have a fixed grammar,
 * so they are read structurally.
 *
 * @param diff - the diff text, or anything else.
 * @returns the paths the diff touches, in first-occurrence order, duplicates removed.
 */
export function filesFromDiff(diff) {
  if (typeof diff !== 'string' || diff === '') return []
  const found = []
  const seen = new Set()
  const header = /^diff --git a\/(.+?) b\/(.+)$/
  const marker = /^(?:\+\+\+|---)\s+(.+?)(?:\t.*)?$/
  for (const rawLine of diff.split(/\r?\n/)) {
    const line = rawLine.trimEnd()
    let candidate = null
    const git = header.exec(line)
    if (git) {
      candidate = git[2]
    } else {
      const hit = marker.exec(line)
      // `--- /dev/null` marks a newly created file and carries no path; the `diff --git`
      // header above it does, so nothing is lost by skipping the sentinel.
      if (hit && hit[1] !== '/dev/null') candidate = hit[1]
    }
    if (candidate === null) continue
    // A header may carry an `a/`/`b/` prefix even on the `+++`/`---` lines.
    const cleaned = normalisePath(candidate.replace(/^[ab]\//, ''))
    if (cleaned === null || seen.has(cleaned)) continue
    seen.add(cleaned)
    found.push(cleaned)
  }
  return found
}

/**
 * Decide which class the EVIDENCE supports.
 *
 * This is the mechanism, as opposed to the caller's word. It reads the files the change
 * actually touches and returns the class they imply, applying the strictest applicable rule:
 *
 *  - a security surface, or a source file this policy has not classified ⇒ `security`
 *  - a documentation extension and nothing else ⇒ `docs`
 *  - anything else that is executable ⇒ `logic`
 *  - and `uiTouched` when any of it builds rendered output, which ADDS the human check
 *
 * `uiTouched` is returned SEPARATELY and is not a rung on the ladder. A change to
 * `lib/client.js` is executable code (so its depth comes from `logic`) AND it is presentation
 * nobody measures (so a human must look). Folding it into the class would force a choice
 * between the two, and the wrong choice is the one that drops the human.
 *
 * An EMPTY evidence set has no derived answer and says so. That is the fail-closed direction:
 * a caller cannot earn a shallow class by supplying no evidence at all.
 *
 * @param options - `{ changedFiles, diff, classification, selfProject }`. `classification` is a
 *   project's declared source/security/UI lists; `selfProject` (default true) says whether the
 *   BUILT-IN lists — which describe this plugin's own repository — apply.
 * @returns `{ class, uiTouched, uiReasons, evidence, reasons, files, rejected, unknown }`.
 */
export function classifyChange(options = {}) {
  const classification = isPlainObject(options.classification)
    ? options.classification
    : emptyClassification()
  // Preserve the library's historical behaviour for direct callers (the plugin's own tests and
  // policy code): the built-in lists apply unless the caller says this is an external project.
  const selfProject = options.selfProject !== false
  const allowUnknownSources = classification.allowUnknownSources === true
  const inferUi = classification.inferUiFromExtensions !== false
  const sourcePatterns = Array.isArray(classification.sources) ? classification.sources : []
  const securityPatterns = Array.isArray(classification.security) ? classification.security : []
  const uiPatterns = Array.isArray(classification.ui) ? classification.ui : []

  const declaredFiles = Array.isArray(options.changedFiles) ? options.changedFiles : []
  const fromFiles = []
  const rejected = []
  // A CHANGED-FILE ENTRY MUST BE A PROJECT-RELATIVE FILE. `..` was rejected before, but a
  // directory (`lib/`), an absolute path, or a drive-qualified Windows path still fell through
  // the ordinary rules and was graded as `logic`; a directory hides every file below it, and
  // `lib/../lib/approval.js` is not a path this policy can classify. Unusable evidence is now
  // treated as a SECURITY surface, not dropped: dropping it let a security file disappear from
  // the evidence while the declaration kept a shallower class.
  const usableChangedPath = path =>
    typeof path === 'string' &&
    path !== '' &&
    !path.endsWith('/') &&
    !path.startsWith('/') &&
    !/^[A-Za-z]:\//.test(path) &&
    !path.split('/').includes('..') &&
    !path.split('/').includes('.')
  for (const entry of declaredFiles) {
    const path = normalisePath(entry)
    if (!usableChangedPath(path)) rejected.push(entry)
    else fromFiles.push(path)
  }

  const fromDiff = filesFromDiff(options.diff).filter(path => {
    if (usableChangedPath(path)) return true
    rejected.push(path)
    return false
  })
  const files = [...fromFiles]
  for (const path of fromDiff) if (!files.includes(path)) files.push(path)

  const evidence = files.length === 0 ? 'none' : fromFiles.length > 0 ? 'changed_files' : 'diff'
  const reasons = []
  const uiReasons = []
  const unknown = []
  let derived = null

  const raise = (next, reason) => {
    if (derived === null || CHANGE_CLASSES[next].shallowest > CHANGE_CLASSES[derived].shallowest) {
      derived = next
    }
    if (reason !== undefined) reasons.push(reason)
  }

  if (rejected.length > 0) {
    const detail =
      `${rejected.length} entr${rejected.length === 1 ? 'y' : 'ies'} of changed_files ` +
      `${rejected.length === 1 ? 'is' : 'are'} not a usable project-relative file ` +
      `(${rejected.map(describePathEntry).join(', ')})`
    reasons.push(detail)
    // FAIL CLOSED. A rejected entry could be a security file the caller tried to spell past
    // the classifier (`lib/../lib/approval.js`) or a directory that hides its contents (`lib/`).
    // It is not evidence that nothing dangerous changed.
    raise('security', `${detail}; treated as a security surface`)
  }

  for (const path of files) {
    // A project's security list is checked alongside the built-in one; both only ever RAISE.
    if ((selfProject && isSecurityPath(path)) || matchesClassification(path, securityPatterns)) {
      raise('security', `${path} decides whether a call is allowed to run`)
      continue
    }
    // RENDERING IS NOT EXECUTABLE CODE, so a UI surface is handled before the unclassified-file
    // rule below. The extension inference can be turned off for an external project whose
    // `.html` is not rendered by this plugin; an explicitly listed UI surface still counts.
    const base = path.split('/').pop()
    const listedUi =
      (selfProject && (UI_FILES.includes(path) || UI_FILES.some(file => file.split('/').pop() === base))) ||
      matchesClassification(path, uiPatterns)
    const inferredUi = inferUi && UI_FILE_PATTERN.test(path)
    if (listedUi || inferredUi) {
      uiReasons.push(`${path} builds rendered output, which no test in this project measures`)
      if (!isDocPath(path)) raise('logic', `${path} is executable behaviour`)
      continue
    }
    const knownSource =
      (selfProject && isKnownSourcePath(path)) || matchesClassification(path, sourcePatterns)
    if (!knownSource && isExecutablePath(path)) {
      // AN UNRECOGNISED SOURCE FILE IS STRICTER THAN SECURITY, NEVER RELAXED by default. A
      // project may explicitly accept the trade with `allowUnknownSources: true`; that opt-in is
      // recorded in the reason so the audit shows why the file was graded logic.
      if (allowUnknownSources) {
        reasons.push(
          `${path} is an unrecognised source file, treated as logic because ` +
            'verification.allowUnknownSources is true',
        )
        raise('logic', `${path} is executable behaviour (unrecognised source, explicitly allowed)`)
      } else {
        unknown.push(path)
        raise('security', `${path} is a source file this policy has not classified`)
      }
      continue
    }
    if (isDocPath(path)) {
      raise('docs', `${path} cannot change executable behaviour`)
      continue
    }
    raise('logic', `${path} is executable behaviour`)
  }

  return {
    class: derived,
    uiTouched: uiReasons.length > 0,
    uiReasons,
    evidence,
    reasons,
    files,
    rejected,
    unknown,
  }
}

/** Describe one unusable `changed_files` entry without throwing on any shape. */
function describePathEntry(value) {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    return text === undefined ? String(value) : text.slice(0, 40)
  } catch {
    return '[unprintable]'
  }
}

/** Whether a path could change executable behaviour. */
function isExecutablePath(path) {
  if (isDocPath(path)) return false
  if (UI_FILE_PATTERN.test(path)) return true
  return /\.(?:m?js|cjs|ts|jsx|json|ya?ml)$/i.test(path)
}

/** Whether a path is documentation by extension. */
function isDocPath(path) {
  return DOC_FILE_PATTERN.test(path)
}

/**
 * Read the `verification` section, fail-closed on every unusable shape.
 *
 * THE SHAPE RULE: `undefined`/`null` means "not configured" and takes the documented defaults,
 * which is what keeps an existing project byte-identical. Anything else that is not a plain
 * object is a MALFORMATION and resolves to the strictest usable setting — `enforced` with
 * `always` confirmation — because a section the plugin cannot read must not be the reason less
 * verification runs. Each axis falls back on its own strict side, so one bad field does not
 * decide the others.
 *
 * @param value - the raw `verification` value from configuration.
 * @returns `{ policy, confirmation, report, usable, problems, classification,
 *   classificationUsable, classificationProblems }`.
 */
export function readVerificationPolicy(value) {
  const problems = []

  if (value === undefined || value === null) {
    return {
      policy: DEFAULT_VERIFICATION.policy,
      confirmation: DEFAULT_VERIFICATION.confirmation,
      report: DEFAULT_VERIFICATION.report,
      usable: true,
      problems,
      classification: emptyClassification(),
      classificationUsable: true,
      classificationProblems: [],
    }
  }

  if (!isPlainObject(value)) {
    problems.push(
      `verification is ${describeValue(value)} (${typeof value}); expected a section (an object). ` +
        'It was refused, so the strictest usable settings are in force.',
    )
    return {
      policy: 'enforced',
      confirmation: 'always',
      report: true,
      usable: false,
      problems,
      classification: emptyClassification(),
      classificationUsable: false,
      classificationProblems: ['the whole section is not an object, so no classification was read'],
    }
  }

  const { policy, confirmation, report } = value

  if (policy !== undefined && !VERIFICATION_POLICIES.includes(policy)) {
    problems.push(
      `verification.policy is ${describeValue(policy)}; expected one of ${VERIFICATION_POLICIES.join(', ')}.`,
    )
  }
  if (confirmation !== undefined && !VERIFICATION_CONFIRMATIONS.includes(confirmation)) {
    problems.push(
      `verification.confirmation is ${describeValue(confirmation)}; expected one of ` +
        `${VERIFICATION_CONFIRMATIONS.join(', ')}.`,
    )
  }
  if (report !== undefined && typeof report !== 'boolean') {
    problems.push(`verification.report is ${describeValue(report)}; expected true or false.`)
  }

  const classificationProblems = []
  const classification = readClassification(value, classificationProblems)

  return {
    policy: VERIFICATION_POLICIES.includes(policy) ? policy : 'enforced',
    confirmation: VERIFICATION_CONFIRMATIONS.includes(confirmation) ? confirmation : 'always',
    report: typeof report === 'boolean' ? report : true,
    usable: problems.length === 0,
    problems,
    classification,
    // A bad entry in ANY list makes the whole classification unusable; the caller then falls
    // back to the fail-closed default rather than to a half-applied list (see readClassification).
    classificationUsable: classificationProblems.length === 0,
    classificationProblems,
  }
}

/**
 * Describe a value for a diagnostic without ever throwing, mirroring `lib/gate.js`.
 *
 * @param value - the value to describe.
 * @returns a short, safe rendering.
 */
function describeValue(value) {
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'function') return 'a function'
  if (typeof value === 'symbol') return String(value)
  try {
    const text = JSON.stringify(value)
    return text === undefined ? String(value) : text
  } catch {
    try {
      return String(value)
    } catch {
      return '[unprintable value]'
    }
  }
}

/**
 * Resolve the verification depth for one piece of work.
 *
 * THE INVARIANT, stated so it can be checked rather than admired:
 *
 *     resolved depth >= declared class's shallowest depth
 *     resolved depth >= derived  class's shallowest depth
 *     a security-touching change always resolves to at least the security floor
 *
 * Both floors are applied with a maximum, so the ONLY way depth moves is up. A refusal is
 * reported ALONGSIDE the resolution, never instead of it: the caller is told the declaration
 * was rejected AND what class and depth will actually be used, because a refusal that hides the
 * fallback is how a misclassification would still get through.
 *
 * @param options - `{ declaredClass, changedFiles, diff, policy, depth }`.
 * @returns `{ refused, refusal, declared, derived, evidence, files, floor, depth, depthLabel,
 *   resolved, policy }`.
 */
export function resolveVerificationDepth(options = {}) {
  const declaredRaw = options.declaredClass
  const declaredUsable = isChangeClass(declaredRaw)
  const policy = options.policy === undefined || options.policy === null
    ? DEFAULT_VERIFICATION.policy
    : String(options.policy)

  // THE CLASSIFICATION IS SCOPED TO THE PROJECT. The built-in lists describe this plugin's own
  // repository; an external project that declares nothing keeps the fail-closed behaviour
  // (unknown executable -> security). A classification that failed validation is NOT used at
  // all: a half-applied list could drop a security entry while keeping a source entry.
  const classificationUsable = options.classificationUsable !== false
  const classification = classificationUsable && isPlainObject(options.classification)
    ? options.classification
    : null
  const derived = classifyChange({
    changedFiles: options.changedFiles,
    diff: options.diff,
    classification,
    selfProject: options.selfProject,
  })

  // AN UNRECOGNISED CLASS IS A REFUSAL, NOT AN ABSENCE. Treating `class: 'doc'` (one letter
  // short) as "no declaration" would silently run the default depth while the caller believed it
  // had asked for the shallow one — the exact silent downgrade this policy exists to stop.
  const declaredClass = declaredUsable ? declaredRaw : null
  const violations = []
  if (declaredRaw !== undefined && declaredRaw !== null && !declaredUsable) {
    violations.push(
      `${describeValue(declaredRaw)} is not a change class; expected one of ${CHANGE_CLASS_IDS.join(', ')}`,
    )
  }

  const declaredFloor = declaredClass === null
    ? null
    : declaredClassFloor(declaredClass, options.depth, violations)

  // A DEPTH CAN BE RAISED EXPLICITLY WITHOUT NAMING A CLASS. The parameter says it may raise the
  // depth; before this, it was only read inside `declaredClassFloor`, so `verification_depth: 3`
  // with no class was silently ignored. An explicit depth may only raise the derived floor.
  let requestedDepth = null
  if (declaredClass === null && options.depth !== undefined && options.depth !== null) {
    const numeric = typeof options.depth === 'number' && Number.isInteger(options.depth)
      ? options.depth
      : null
    if (numeric === null || numeric < VERIFICATION_DEPTHS.UNIT || numeric > MAX_VERIFICATION_DEPTH) {
      violations.push(
        `depth ${describeValue(options.depth)} is not an integer from ${VERIFICATION_DEPTHS.UNIT} to ` +
          `${MAX_VERIFICATION_DEPTH}; it was ignored.`,
      )
    } else {
      requestedDepth = numeric
    }
  }

  const derivedClass = derived.class
  const derivedFloor = derivedClass === null ? null : CHANGE_CLASSES[derivedClass].shallowest
  const hasEvidence = derived.evidence !== 'none'

  if (hasEvidence && declaredClass !== null && derivedFloor > declaredFloor) {
    // THE REFUSAL THIS POLICY EXISTS FOR. `changed_files` is what the caller said; the derived
    // class is what the files and diff headers imply. When they disagree in the dangerous
    // direction, the declaration is rejected and the name that contradicts it is printed.
    violations.push(
      `class "${declaredClass}" permits depth ${declaredFloor} ` +
        `(${VERIFICATION_DEPTH_LABELS[declaredFloor]}), but the changed files require ` +
        `"${derivedClass}" at depth ${derivedFloor} (${VERIFICATION_DEPTH_LABELS[derivedFloor]}): ` +
        `${derived.reasons.slice(0, 3).join('; ')}`,
    )
  }

  const floor = Math.max(declaredFloor ?? 0, derivedFloor ?? 0, requestedDepth ?? 0)

  // DECLARING WITHOUT EVIDENCE IS A CLAIM THAT CANNOT BE HONOURED, AND IT IS REFUSED.
  //
  // The mechanism this policy rests on is `changed_files`/`diff` contradicting the declaration.
  // A caller that supplies NO evidence removes the mechanism, and the first version of this
  // resolver let it: `class: "docs"` with no file list resolved to depth 0, cleanly, with no
  // refusal — a documentation-touching change and a rewrite of `lib/approval.js` were
  // indistinguishable, which is precisely the fail-open direction this policy exists to close.
  //
  // So `docs` is the one class whose floor it cannot reach without evidence, because it is the
  // only class that claims NOTHING executable changed. Everything else declares a depth at or
  // above what unverified work gets anyway, so requesting `logic` without a file list is a
  // claim in the strict direction and is allowed to stand.
  const declaredNeedsEvidence =
    declaredClass !== null && !hasEvidence && declaredFloor < VERIFICATION_DEPTHS.HARNESS
  if (declaredNeedsEvidence) {
    violations.push(
      `class "${declaredClass}" permits depth ${declaredFloor} but NO changed files and no diff were ` +
        'supplied, so the claim that nothing executable changed cannot be checked. Pass changed_files ' +
        '(or a diff) to declare this class, or declare one at depth ' +
        `${VERIFICATION_DEPTHS.HARNESS} or above.`,
    )
  }

  // UNVERIFIED WORK IS NOT ASSUMED TO BE SHALLOW.
  //
  // With neither a declaration nor evidence, the depth is raised to the `logic` floor and
  // INDEPENDENT REVIEW is required as the substitute for the harnesses nobody selected. This is
  // the fail-closed reading of "no evidence": not "therefore nothing was done", but "therefore
  // the cheapest mechanical signal is unavailable and a reader now has to look".
  const unverified = declaredClass === null && !hasEvidence
  const effectiveFloor = declaredNeedsEvidence || unverified
    ? Math.max(floor, VERIFICATION_DEPTHS.HARNESSES)
    : floor

  const refused = violations.length > 0

  // THE HUMAN CHECK IS AN ADDITION, NOT A RUNG. `uiTouched` comes from the evidence and from
  // the declared class, and it can only ever ADD a requirement: a class cannot declare the human
  // check away, because a declaration is a claim about risk and "nobody needs to look at this
  // screen" is not a claim the caller is entitled to make on the evidence's behalf.
  const declaredHuman = declaredClass === null ? false : CHANGE_CLASSES[declaredClass].humanCheck
  const humanCheckRequired = declaredHuman || derived.uiTouched

  return {
    refused,
    refusal: refused ? violations.join(' ') : null,
    declared: declaredClass,
    declaredRaw: declaredRaw === undefined ? null : declaredRaw,
    derived: derivedClass,
    evidence: derived.evidence,
    files: derived.files,
    rejectedFiles: derived.rejected,
    unknownFiles: derived.unknown,
    reasons: derived.reasons,
    uiTouched: derived.uiTouched,
    uiReasons: derived.uiReasons,
    humanCheckRequired,
    // WHY THE DEPTH IS HIGHER THAN THE DECLARED CLASS SAYS. Reported separately from a refusal,
    // because this is not a contradiction: it is the strict reading of missing information, and a
    // reader who sees only `depth: 2` on a `docs` declaration would otherwise think the table was
    // wired backwards.
    escalated: effectiveFloor > floor ? `depth raised to ${effectiveFloor} because ${declaredNeedsEvidence ? 'the declared class could not be checked' : 'no evidence was supplied'}` : null,
    floor,
    depth: effectiveFloor,
    depthLabel: VERIFICATION_DEPTH_LABELS[effectiveFloor] ?? `depth ${effectiveFloor}`,
    requestedDepth,
    resolved: classForFloor(effectiveFloor),
    securityFloor: MAX_VERIFICATION_DEPTH,
    policy,
    // Carried into the audit so a later reader can see WHICH classification shaped the result.
    classification,
    classificationUsable,
    classificationProblems: Array.isArray(options.classificationProblems)
      ? options.classificationProblems
      : [],
    selfProject: options.selfProject !== false,
  }
}

/**
 * The class reported for a resolved floor, never below the security floor when the floor
 * reaches it.
 *
 * The floor is the fact and the class name is a label for it. Because `security` is the only
 * class at the top of the ladder, a floor of `INDEPENDENT` reports `security` — which is why
 * "the gate's own review" and "maximum depth" are the same statement here.
 */
function classForFloor(floor) {
  let chosen = CHANGE_CLASS_IDS[0]
  for (const id of CHANGE_CLASS_IDS) {
    if (CHANGE_CLASSES[id].shallowest <= floor) chosen = id
  }
  return chosen
}

/**
 * The depth floor a declared class implies, including any explicit per-call depth.
 *
 * A per-call `depth` may only RAISE the floor: a number below the class's own shallowest depth
 * is recorded as a violation and ignored. The class is what the user confirmed, and an argument
 * is not a substitute for confirming a shallower class.
 */
function declaredClassFloor(declaredClass, depthOverride, violations) {
  const classFloor = CHANGE_CLASSES[declaredClass].shallowest
  if (depthOverride === undefined || depthOverride === null) return classFloor

  const numeric = typeof depthOverride === 'number' && Number.isInteger(depthOverride)
    ? depthOverride
    : null
  if (numeric === null || numeric < VERIFICATION_DEPTHS.UNIT || numeric > MAX_VERIFICATION_DEPTH) {
    violations.push(
      `depth ${describeValue(depthOverride)} is not an integer from ${VERIFICATION_DEPTHS.UNIT} to ` +
        `${MAX_VERIFICATION_DEPTH}; the class's own depth ${classFloor} was used instead.`,
    )
    return classFloor
  }
  if (numeric < classFloor) {
    violations.push(
      `depth ${numeric} is shallower than class "${declaredClass}" permits (${classFloor}); ` +
        'a per-call depth may only raise the floor, never lower it.',
    )
    return classFloor
  }
  return numeric
}

const CONFIRMATION = Symbol('dsh-workflow.verification-confirmation')

/**
 * Require a resolved depth to be confirmed by the user, through the host's question service.
 *
 * WHY A CONFIRMATION AND NOT A FLAG. The user asked for the decision to be made "by the LLM and
 * the user together". A boolean argument records only what the MODEL says the user wanted, and
 * a model's account of a conversation is not evidence — the same rule this project already
 * applies to constraint writes (`lib/gc.js`) and to review verdicts. The confirmation therefore
 * comes from an actual answer to an actual question, and the token that proves it is branded
 * with a private symbol so no in-process caller can mint one by hand.
 *
 * @param options - `{ service, exec, question, approveLabels, labelsToClass }`.
 * @returns `{ ok: true, confirmation, selected, custom, approvedLabel, approvedClass }`, or
 *   `{ ok: false, status, reason }` with the ledger untouched.
 */
export async function requestVerificationConfirmation(options) {
  const { service, exec } = options ?? {}
  const question = options?.question ?? null
  const approveLabels = Array.isArray(options?.approveLabels) ? options.approveLabels : []

  if (question === null || typeof question?.id !== 'string' || question.id === '') {
    return {
      ok: false,
      status: 'question-unusable',
      reason: 'no usable question was built, so nothing could be confirmed and no gated work runs.',
    }
  }
  if (service === undefined || service === null || typeof service.ask !== 'function') {
    return {
      ok: false,
      status: 'confirmation-unavailable',
      reason:
        'the host exposes no user-questions service, so the framework cannot ask you to confirm the ' +
        'verification depth. Gated work does not proceed on the model\u2019s account of what was ' +
        'agreed: a depth the user never saw is the silent downgrade this policy exists to prevent. ' +
        'A delegated child cannot open a human interaction, so gather the confirmation in the root ' +
        'conversation and put the answer in the child result.',
    }
  }

  let answer
  try {
    answer = await service.ask({
      questions: [question],
      agent: safeAgent(exec),
      ...(safeSignal(exec) === undefined ? {} : { signal: safeSignal(exec) }),
    })
  } catch (error) {
    return { ok: false, status: 'confirmation-failed', reason: describeAskFailure(error) }
  }

  const chosen = selectedApproval(answer, question.id, approveLabels)
  if (chosen === null) {
    return {
      ok: false,
      status: 'not-confirmed',
      reason:
        'the user did not choose one of the confirming options, so no gated work proceeds. Only an ' +
        'exact option label counts: a typed custom answer is not consent, because "the user typed ' +
        'something" is not "the user approved this depth".',
      selected: readableSelection(answer, question.id),
    }
  }

  return {
    ok: true,
    confirmation: {
      [CONFIRMATION]: true,
      source: 'user-question',
      questionId: question.id,
      approvedAt: new Date().toISOString(),
      approvedLabel: chosen,
      selected: readableSelection(answer, question.id),
    },
    selected: readableSelection(answer, question.id),
    approvedLabel: chosen,
    approvedClass: options?.labelsToClass?.[chosen] ?? null,
  }
}

/** Whether a value is a token this module minted. */
export function isVerificationConfirmed(value) {
  return (
    isPlainObject(value) &&
    value[CONFIRMATION] === true &&
    value.source === 'user-question' &&
    typeof value.questionId === 'string' &&
    value.questionId !== ''
  )
}

/** The first approving label the user actually selected, or null. Exact match only. */
function selectedApproval(answer, questionId, approveLabels) {
  const selected = readableSelection(answer, questionId)
  return approveLabels.find(label => selected.includes(label)) ?? null
}

/** Defensively read the selected labels of one answer. */
function readableSelection(answer, questionId) {
  try {
    const items = Array.isArray(answer?.answers) ? answer.answers : []
    const item = items.find(candidate => candidate?.id === questionId)
    return Array.isArray(item?.selected)
      ? item.selected.filter(value => typeof value === 'string')
      : []
  } catch {
    return []
  }
}

/** Build the question that asks the user to confirm or raise the resolved depth. */
export function buildVerificationQuestion(resolution) {
  const derivedLine = resolution.derived === null
    ? 'no changed files were supplied, so the evidence supports no class of its own'
    : `the changed files imply "${resolution.derived}": ${resolution.reasons.slice(0, 4).join('; ')}`
  return {
    id: 'workflow-verification-depth',
    header: 'Verification depth',
    question: [
      'Confirm the verification depth for this work?',
      '',
      `the model proposed class "${resolution.declared ?? '(none)'}" — ` +
        `${
          resolution.declared === null
            ? 'no class was named, so no depth was claimed'
            : CHANGE_CLASSES[resolution.declared].summary
        }`,
      derivedLine,
      `resolved depth: ${resolution.depth} (${resolution.depthLabel}) — class "${resolution.resolved}"`,
      '',
      resolution.refusal
        ? `THE PROPOSED CLASS WAS REFUSED: ${resolution.refusal}`
        : 'The proposal agrees with the evidence.',
      '',
      'The security class is not degradable: a change touching an approval, authorization or ' +
        `permissions surface resolves to depth ${MAX_VERIFICATION_DEPTH} regardless of how it is ` +
        `declared. Classes: ${CHANGE_CLASS_IDS.join(', ')}. A depth you do not confirm simply does ` +
        'not run.',
    ].join('\n'),
  }
}

/**
 * The answers the depth question offers, and the class each one selects.
 *
 * Three options, no fourth: accept what was resolved, raise everything to maximum, or stop.
 * A menu that offered "a shallower class" would be a menu offering the one thing the policy
 * exists to refuse.
 */
export function verificationChoiceLabels(resolution) {
  const proposed = `Apply class "${resolution.resolved}" at depth ${resolution.depth}`
  const strictest = `Apply class "${SECURITY_CLASS}" at depth ${MAX_VERIFICATION_DEPTH} (maximum)`
  const stop = 'Stop — run no gated work at this depth'
  return {
    proposed,
    strictest,
    stop,
    approveLabels: [proposed, strictest],
    labelsToClass: { [proposed]: resolution.resolved, [strictest]: SECURITY_CLASS },
  }
}

/**
 * Turn a user-questions failure into an instruction rather than a stack trace.
 *
 * The delegated-child case matters most: the architecture this plugin recommends runs the
 * build-and-review loop inside a child, and a child may not open a human interaction — so the
 * honest answer is "gather it upward", never "proceed anyway".
 */
function describeAskFailure(error) {
  const code = safeCode(error)
  const base = 'the verification depth was NOT confirmed and no gated work runs'
  if (code === 'DELEGATED_CALLER') {
    return (
      'this call is running inside a delegated child agent, and a child may not open a human ' +
      `interaction; ${base}. Run the review from the root conversation, or report the class and the ` +
      'resolved depth upward for the user to confirm there.'
    )
  }
  if (code === 'NO_PROVIDER') {
    return `no answerer accepted the question; ${base}. Ask the user directly, then run the review again.`
  }
  if (code === 'CALLER_NOT_LIVE') return `the calling agent is no longer live; ${base}.`
  if (code === 'ASK_ABORTED') return `the question was aborted before the user answered; ${base}.`
  return `the user-questions service failed (${safeMessage(error)}); ${base}.`
}

function safeCode(error) {
  try {
    return error?.code
  } catch {
    return undefined
  }
}

function safeMessage(error) {
  try {
    return error?.message ?? String(error)
  } catch {
    return '[unprintable error]'
  }
}

/** Wrap `exec.signal` defensively: a non-AbortSignal value is not worth crashing over. */
function safeSignal(exec) {
  try {
    return typeof AbortSignal !== 'undefined' && exec?.signal instanceof AbortSignal
      ? exec.signal
      : undefined
  } catch {
    return undefined
  }
}

/** Wrap `exec.agent` defensively, for the same reason. */
function safeAgent(exec) {
  try {
    return exec?.agent
  } catch {
    return undefined
  }
}

/**
 * Whether the verification policy gates a review at all.
 *
 * `enforced` is the only setting that changes what runs. `advisory` resolves and reports, so
 * the model and the user can see the class without any work being refused; reporting is
 * separate again (`report`), because a status line costs nothing and refusing work does not.
 */
export function verificationGates(policy) {
  return policy === 'enforced'
}

/**
 * Deep-merge configuration layers in order, so a later layer overrides an earlier
 * one key by key rather than replacing whole nested objects.
 *
 * A spread (`{ ...row, ...project }`) is NOT sufficient: it would drop sibling keys
 * of any nested section the later layer touches — e.g. a project setting
 * `modules.acceptance` would silently discard the row's `modules.planner: false`.
 *
 * @param layers - configuration layers, lowest precedence first.
 * @returns A new merged layer.
 */
export function mergeConfigLayers(...layers) {
  const merged = {}
  for (const layer of layers) {
    if (!isPlainObject(layer)) continue
    mergeInto(merged, layer)
  }
  return merged
}

/**
 * Deep-merge a raw config over the defaults, dropping `undefined` values so an
 * absent patch field never erases a default.
 *
 * @param raw - raw configuration, possibly partial or absent.
 * @returns A fully populated configuration object.
 */
/**
 * Deep-copy a config value so a merged layer never aliases its source.
 *
 * WHY THIS EXISTS — a cross-project veto bypass.
 * An earlier version assigned the source's nested objects straight onto the target:
 *
 *     if (isPlainObject(value) && isPlainObject(target[key])) mergeInto(target[key], value)
 *     else target[key] = value            // <-- nested object/array by REFERENCE
 *
 * `mergeInto` then mutates that object in place on the next layer, so every merged
 * layer ended up sharing storage with whatever row config it was built from. Because
 * `resolveEffectiveConfig(rowConfig, projectFile)` is called per request, one
 * project's `.dsh/workflow.yml` rewrote a shared object that a LATER request in a
 * DIFFERENT project would read. Observed end to end: project A setting
 * `mustPass: [scope]` left `row.mustPass` as `["scope"]`, and the next review in an
 * unrelated project therefore had `failedVeto: []` while correctness scored 2 —
 * i.e. project A silently switched off project B's veto. A's `bar` and
 * `independent: false` leaked the same way.
 *
 * The defect was invisible to the test suite because the smoke test built its tool
 * definition with `{ config: {} }`: an empty row has no nested objects to
 * contaminate, so the non-mutation assertion could not fail.
 *
 * @param value - config value from a source layer.
 * @returns A value that can be mutated without touching the source.
 */
function cloneValue(value) {
  if (value === null || typeof value !== 'object') return value
  return structuredClone(value)
}

export function resolveConfig(raw) {
  const merged = structuredClone(DEFAULT_CONFIG)
  if (!isPlainObject(raw)) return merged
  for (const [key, value] of Object.entries(raw)) {
    if (value === undefined) continue
    if (DEEP_KEYS.has(key) && isPlainObject(value)) {
      mergeInto(merged[key], value)
      continue
    }
    merged[key] = cloneValue(value)
  }
  return merged
}

/**
 * Merge `source` into `target`, never aliasing the source's nested values.
 *
 * Copies on assignment are what make the function safe to call with a shared row
 * config: the caller's object stays untouched, so the caller cannot be contaminated
 * by a later request in a different project. See {@link cloneValue}.
 *
 * @param target - the object to merge into (mutated).
 * @param source - the layer to merge from (never mutated).
 */
function mergeInto(target, source) {
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined) continue
    if (isPlainObject(value) && isPlainObject(target[key])) mergeInto(target[key], value)
    else target[key] = cloneValue(value)
  }
}

/**
 * Validate a resolved configuration and describe every problem found, without
 * throwing: a misconfigured workflow must still let the user open the settings
 * page and fix it.
 *
 * @param config - a resolved configuration.
 * @returns An array of human-readable warnings; empty means valid.
 */
export function configWarnings(config) {
  const warnings = []

  if (!TIERS.includes(config.tier)) {
    warnings.push(`unknown tier "${config.tier}"; expected one of ${TIERS.join(', ')}.`)
  }
  if (config.recipe !== null && !RECIPES.includes(config.recipe)) {
    warnings.push(`unknown recipe "${config.recipe}"; expected one of ${RECIPES.join(', ')}.`)
  }
  // THE APPROVAL SECTION IS VALIDATED BY THE GATE'S OWN DEFINITION, and by nothing else.
  //
  // Two bespoke membership tests used to sit here, looking at `config.approval?.strength`
  // through an optional chain. They were worse than redundant: for `approval: 'nope'` (a
  // string has no `.strength`) they emitted "unknown approval.strength \"undefined\"" —
  // naming a field the user never wrote — on top of the accurate section-level
  // diagnostic, while for `denyHighAlways: 'false'` they emitted nothing at all. One
  // reader, one refusal, one explanation.
  const approval = readApprovalGate(config.approval, DEFAULT_CONFIG.approval)
  if (!approval.usable) {
    for (const problem of approval.problems) warnings.push(`approval gate unusable: ${problem}`)
    warnings.push(
      `the approval gate fell back to its fail-closed defaults ` +
        `(strength=${approval.strength}, threshold=${approval.riskThreshold}, ` +
        `denyHighAlways=${approval.denyHighAlways}, no exemptions). ` +
        'Fix the section above to restore the strength you asked for.',
    )
  }

  // Hard invariants: these are safety caps, not preferences.
  //
  // The depth ceiling used to be pinned to 1, with the reasoning "a delegated child must
  // not delegate again". That reasoning was wrong for this plugin: `maxDepth` is an
  // ABSOLUTE tree ceiling, so 1 also forbids the ARCHITECTURE THE PLUGIN RECOMMENDS —
  // a delegated orchestrator starting its own reviewer (depth 1 → depth 2). Pinning it
  // to 1 pushed every review back into the main conversation, which is the context
  // pollution the plugin exists to prevent.
  //
  // The cap is now 2, which allows exactly one level of nesting below a delegated
  // orchestrator and still makes unbounded recursion impossible. Anything above 2 is
  // refused, because each extra level multiplies cost with no workflow role for it.
  const maxDepth = config.subagent?.maxDepth
  if (!Number.isInteger(maxDepth) || maxDepth < 1 || maxDepth > MAX_SUBAGENT_DEPTH) {
    warnings.push(
      `subagent.maxDepth is ${String(maxDepth)} but must be an integer from 1 to ` +
        `${MAX_SUBAGENT_DEPTH}. 1 forbids a delegated orchestrator from starting a reviewer ` +
        '(forcing reviews into the main context); 2 permits it and nothing deeper. ' +
        `Using ${MAX_SUBAGENT_DEPTH}.`,
    )
    if (isPlainObject(config.subagent)) config.subagent.maxDepth = MAX_SUBAGENT_DEPTH
  }
  const maxActive = config.subagent?.maxActiveSubagents
  if (!Number.isInteger(maxActive) || maxActive < 1) {
    warnings.push(
      `subagent.maxActiveSubagents must be a positive integer; got ${String(maxActive)}. Using 8.`,
    )
    if (isPlainObject(config.subagent)) config.subagent.maxActiveSubagents = 8
  }
  if (config.evaluator?.independent !== true) {
    warnings.push(
      'evaluator.independent is off: nothing independently verifies generated work, so the ' +
        'main agent can declare its own work complete.',
    )
  }
  // The verbatim warning is emitted whenever human authorization is removed — INCLUDING
  // when that removal is the RESULT of an unusable section being refused, because the user
  // must be told what the fallback implies. Gating it on the raw strength alone skipped
  // exactly the case where the user asked for `off` and got the fallback instead.
  if (isHumanAuthorizationRemoved(config.approval?.strength) || isHumanAuthorizationRemoved(approval.strength) || !approval.usable) {
    if (isHumanAuthorizationRemoved(config.approval?.strength)) {
      warnings.push(
        `approval.strength "${config.approval.strength}" removes human authorization from ` +
          'approval-gated actions. Model risk classification can be wrong, and it provides no file ' +
          'sandbox: direct Node effects inside run_code bypass inner-tool review.',
      )
    }
    // THE SHIPPED LAYER'S OWN WARNING, VERBATIM. Not a paraphrase and not optional: the
    // design requires the official text to reach the user, including the no-file-sandbox
    // limitation. It is emitted from the gate's own accessor so the status report, the
    // settings write result and `workflow_init` cannot show three different versions.
    for (const line of approvalWarningLines(approval)) warnings.push(line)
  }
  if (Array.isArray(config.evaluator?.dimensions) && Array.isArray(config.evaluator?.mustPass)) {
    const missing = config.evaluator.mustPass.filter(d => !config.evaluator.dimensions.includes(d))
    if (missing.length) {
      warnings.push(`evaluator.mustPass lists ${missing.join(', ')}, absent from dimensions.`)
    }
  }

  // THE GATE IS VALIDATED HERE TOO, through the same definition the reviewer uses.
  //
  // This check used to be the bespoke `Array.isArray` test above, which went SILENT
  // exactly when a value was malformed — the opposite of its purpose. Nothing validated
  // `bar` or `maxRounds` at all, so `workflow_status` printed `bar=abc` as if the gate
  // were fine while every review in that project was refused. A misconfiguration the
  // user cannot see until they try a review is the worst place for it to hide.
  const gate = readEvaluatorGate(
    config.evaluator ?? {},
    {
      bar: DEFAULT_CONFIG.evaluator.bar,
      maxRounds: DEFAULT_CONFIG.evaluator.maxRounds,
      dimensions: DEFAULT_CONFIG.evaluator.dimensions,
      mustPass: DEFAULT_CONFIG.evaluator.mustPass,
    },
  )
  if (!gate.ok) {
    for (const problem of gate.problems) {
      warnings.push(`evaluator gate unusable: ${problem}`)
    }
  }

  // A CLASS THAT CANNOT BE HONOURED MUST NOT BE DECLARABLE, and the same rule applies to the
  // CLASS TABLE ITSELF. If `security` were ever pointed at a shallower rung — by a careless edit
  // here, or by a reader that reconstructed the table — this policy would be able to skip the
  // gate's own review, which is the one failure it could newly introduce. Reported as a problem
  // rather than assumed, and resolved to the strictest usable settings.
  const verification = readVerificationPolicy(config.verification)
  if (!verification.usable) {
    for (const problem of verification.problems) warnings.push(`verification policy unusable: ${problem}`)
  }
  if (verification.classificationUsable === false) {
    for (const problem of verification.classificationProblems ?? []) {
      warnings.push(`verification classification unusable: ${problem}`)
    }
  }
  if (!isSecurityFloored()) {
    warnings.push(
      `the verification policy is DEFECTIVE: the "${SECURITY_CLASS}" class is not at the deepest ` +
        'depth, so a security change could be declared at a shallower one. Fix the class table in ' +
        'lib/config.js before relying on this policy.',
    )
  }

  return warnings
}
