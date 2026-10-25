/**
 * ONE definition of a usable gate value, shared by every surface that reads or writes
 * one.
 *
 * WHY THIS MODULE EXISTS
 * The gate value (`evaluator.bar`, `evaluator.maxRounds`) is consumed and produced in
 * four places: the review gate, `decideVerdict`, `workflow_set`'s validator, and the
 * settings panel. Each originally implemented its own check, and they disagreed. An
 * independent review round found the SAME fail-open class four times through four
 * different spellings:
 *
 *   1. `bar: abc`      → `NaN`, and every `x < NaN` comparison is false  (round 2)
 *   2. `Number(x)` coercion still failed open, because the check validated the
 *      COERCED value: `Number('')`, `Number([])`, `Number(false)` are 0 and
 *      `Number(true)` is 1, all inside a legal [0,10] range            (round 3)
 *   3. `mustPass` entries were FILTERED rather than refused, so a listed veto
 *      dimension was silently dropped from the veto set                (round 4)
 *   4. the settings panel coerced a cleared `<input>` (`''`) to `bar: 0`, the most
 *      permissive legal value, bypassing the validator entirely        (round 4)
 *
 * Fixing those one at a time is how each round found a new one. The durable fix is for
 * every surface to ask the same question, so a value the gate will reject can never be
 * written and a value the writer accepts can never fail open.
 *
 * THE RULE: a gate number is usable only if it IS a number. Anything that merely
 * coerces to one is a configuration error, and configuration errors must never widen a
 * gate — so they are refused, never normalised.
 *
 * @module src-12453345_-dsh-workflow/gate
 */

/** Inclusive range a pass mark may occupy. */
export const BAR_MIN = 0
export const BAR_MAX = 10

/** Why a candidate value cannot serve as a gate. */
export const GATE_REASONS = Object.freeze({
  NOT_A_NUMBER: 'not-a-number',
  NOT_FINITE: 'not-finite',
  OUT_OF_RANGE: 'out-of-range',
  NOT_INTEGER: 'not-integer',
  TOO_SMALL: 'too-small',
  NOT_A_LIST: 'not-a-list',
  MIXED_LIST: 'mixed-list',
  EMPTY_LIST: 'empty-list',
})

function isSection(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Describe a value for a diagnostic without ever throwing.
 *
 * `JSON.stringify` throws on a BigInt, so a programmatic caller passing `bar: 0n` used
 * to crash the very guard that exists to report a bad bar — failing open in the most
 * literal sense, by turning a refusal into an exception.
 *
 * The fallback is ITSELF wrapped, because `String(value)` can throw too: a revoked Proxy
 * raises `TypeError: Cannot perform 'get' on a proxy that has been revoked`, and an object
 * whose `toJSON`, `toString` and `Symbol.toPrimitive` all throw propagates from there.
 * The first version called `String(value)` in its catch block, which merely moved the
 * throw one step later. Reachability is low — gate values come from YAML/JSON, which
 * cannot produce a Proxy — but a function documented as never throwing should not have a
 * throwing path at all.
 *
 * @param value - the value to describe.
 * @returns a short, safe rendering.
 */
export function describeValue(value) {
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
 * Check whether a value is usable as the pass mark.
 *
 * @param value - the candidate, exactly as it was read from configuration.
 * @returns `{ ok: true, value }` or `{ ok: false, reason, detail }`.
 */
export function checkBar(value) {
  if (typeof value !== 'number') {
    return {
      ok: false,
      reason: GATE_REASONS.NOT_A_NUMBER,
      detail: `it is ${describeValue(value)} (${typeof value}); a gate must BE a number, not merely coerce to one`,
    }
  }
  if (!Number.isFinite(value)) {
    return { ok: false, reason: GATE_REASONS.NOT_FINITE, detail: `it is ${value}` }
  }
  if (value < BAR_MIN || value > BAR_MAX) {
    return {
      ok: false,
      reason: GATE_REASONS.OUT_OF_RANGE,
      detail: `it is ${value}, outside ${BAR_MIN}-${BAR_MAX}`,
    }
  }
  return { ok: true, value }
}

/**
 * Check whether a value is usable as the review-round budget.
 *
 * @param value - the candidate, exactly as it was read from configuration.
 * @returns `{ ok: true, value }` or `{ ok: false, reason, detail }`.
 */
export function checkMaxRounds(value) {
  if (typeof value !== 'number') {
    return {
      ok: false,
      reason: GATE_REASONS.NOT_A_NUMBER,
      detail: `it is ${describeValue(value)} (${typeof value})`,
    }
  }
  if (!Number.isFinite(value)) {
    return { ok: false, reason: GATE_REASONS.NOT_FINITE, detail: `it is ${value}` }
  }
  if (!Number.isInteger(value)) {
    return { ok: false, reason: GATE_REASONS.NOT_INTEGER, detail: `it is ${value}` }
  }
  if (value < 1) {
    return { ok: false, reason: GATE_REASONS.TOO_SMALL, detail: `it is ${value}` }
  }
  return { ok: true, value }
}

/**
 * Read a configuration list that must be a non-empty list of strings.
 *
 * A MIXED LIST IS REFUSED, NEVER FILTERED — that was round 4's blocker. Filtering
 * non-string entries looked tidy but silently NARROWED the set: a project file with
 *
 *     mustPass: [ [correctness], build, regressions ]
 *
 * (valid YAML, parsed cleanly into `[["correctness"], "build", "regressions"]`) had its
 * `correctness` entry dropped, so the veto set became `["build", "regressions"]` and a
 * reviewer scoring correctness 2 PASSED with `failedVeto: []`. The reviewer prompt was
 * narrowed the same way. A partially-read list is a configuration error, not a
 * preference.
 *
 * `undefined`/`null` mean "unset" and take the fallback. An EMPTY list is a deliberate
 * statement, and whether it can be honoured depends on which list it is:
 *
 *  - `mustPass: []` means "no veto dimensions". That is a coherent (average-only) gate,
 *    it is what the exported `Config` schema permits via `z.array(z.string())`, and
 *    refusing it would make a schema-legal value break every review in the project. It
 *    is HONOURED.
 *  - `dimensions: []` means "score nothing", which no review can satisfy. It is refused.
 *
 * @param name - the configuration path, for the diagnostic.
 * @param value - the raw value.
 * @param fallback - the default list.
 * @param options - `{ allowEmpty }` — whether an empty list can be honoured.
 * @returns `{ ok: true, value }` or `{ ok: false, reason, detail }`.
 */
export function readStringList(name, value, fallback, options = {}) {
  const { allowEmpty = false } = options
  if (value === undefined || value === null) return { ok: true, value: fallback }
  if (!Array.isArray(value)) {
    return {
      ok: false,
      reason: GATE_REASONS.NOT_A_LIST,
      detail: `${name} is ${describeValue(value)} (${typeof value}); expected a list of strings`,
    }
  }
  const nonStrings = value.filter(item => typeof item !== 'string')
  if (nonStrings.length) {
    return {
      ok: false,
      reason: GATE_REASONS.MIXED_LIST,
      detail:
        `${name} contains ${nonStrings.length} non-string entr${nonStrings.length === 1 ? 'y' : 'ies'} ` +
        `(${nonStrings.map(describeValue).join(', ')}); a partly-read list would silently narrow the veto set`,
    }
  }
  if (value.length === 0 && !allowEmpty) {
    return {
      ok: false,
      reason: GATE_REASONS.EMPTY_LIST,
      detail:
        `${name} is an empty list, so no dimension would ever be scored and no review could be ` +
        `graded. Remove the key to use the defaults, or clear it with ` +
        `workflow_set path=${name} value=null.`,
    }
  }
  return { ok: true, value: [...value] }
}

/**
 * Read a whole evaluator gate from raw configuration.
 *
 * The single entry point the gate, the writer and the panel all use. Being able to
 * write a value this function rejects is the bug this module exists to prevent, so
 * `workflow_set` and the settings panel must route through {@link checkBar} /
 * {@link checkMaxRounds} rather than re-deriving the rule.
 *
 * @param evaluator - the raw `evaluator` section.
 * @param defaults - `{ bar, maxRounds, dimensions, mustPass }`.
 * @returns `{ ok: true, bar, maxRounds, dimensions, mustPass }` or `{ ok: false, problems }`.
 */
export function readEvaluatorGate(evaluator, defaults) {
  const problems = []

  // A NON-OBJECT SECTION IS A MALFORMATION, NOT "NO OVERRIDES".
  //
  // `evaluator ?? {}` silently turned `evaluator: nope` (a hand-editable mistake, and one
  // already listed in the malformed-config test table) into the default gate, so
  // `workflow_status` reported a healthy-looking project and `configWarnings` stayed
  // quiet. The effect is fail-safe because the defaults apply — but it is silent
  // normalisation of a malformed section in the one function documented as the single
  // entry point for reading it, which is the class of bug this module exists to remove.
  if (evaluator !== undefined && evaluator !== null && !isSection(evaluator)) {
    problems.push(
      `evaluator is ${describeValue(evaluator)} (${typeof evaluator}); expected a section (an object). ` +
        'Its settings were ignored and the defaults applied.',
    )
    return { ok: false, problems, bar: null, maxRounds: null, dimensions: null, mustPass: null }
  }

  const source = evaluator ?? {}

  const bar = checkBar(source.bar ?? defaults.bar)
  if (!bar.ok) problems.push(`evaluator.bar is unusable: ${bar.detail}`)

  const maxRounds = checkMaxRounds(source.maxRounds ?? defaults.maxRounds)
  if (!maxRounds.ok) problems.push(`evaluator.maxRounds is unusable: ${maxRounds.detail}`)

  const dimensions = readStringList('evaluator.dimensions', source.dimensions, defaults.dimensions)
  if (!dimensions.ok) problems.push(dimensions.detail)

  // An empty `mustPass` is honoured: "no veto dimensions" is coherent, and the exported
  // Config schema permits it, so refusing it would make a schema-legal value break every
  // review in the project.
  const mustPass = readStringList('evaluator.mustPass', source.mustPass, defaults.mustPass, {
    allowEmpty: true,
  })
  if (!mustPass.ok) problems.push(mustPass.detail)

  if (problems.length) return { ok: false, problems, bar: null, maxRounds: null, dimensions: null, mustPass: null }

  // A veto dimension that is not in the scored set can never be evaluated, so every
  // review would fail without saying why. Surfaced here rather than as an opaque FAIL.
  const notScored = mustPass.value.filter(dimension => !dimensions.value.includes(dimension))
  if (notScored.length) {
    problems.push(
      `evaluator.mustPass names dimension(s) that evaluator.dimensions does not score: ` +
        `${notScored.join(', ')}. Add them to dimensions or remove them from mustPass.`,
    )
    return { ok: false, problems, bar: null, maxRounds: null, dimensions: null, mustPass: null }
  }

  return {
    ok: true,
    bar: bar.value,
    maxRounds: maxRounds.value,
    dimensions: dimensions.value,
    mustPass: mustPass.value,
  }
}
