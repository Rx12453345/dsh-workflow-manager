/**
 * Small shared vocabulary for dsh-workflow.
 *
 * Kept in one module so the config model, the tools, and the settings panel all
 * describe the same options with the same words.
 *
 * @module src-12453345_-dsh-workflow/shared
 */

export {
  TIERS,
  RECIPES,
  APPROVAL_STRENGTHS,
  RISK_LEVELS,
  isPlainObject,
  mergeConfigLayers,
  configWarnings,
} from './config.js'

/**
 * Collapse every line terminator so a value cannot forge an extra line in a report.
 *
 * Why this lives in the leaf module: the reports are read by a MODEL, and most of their
 * content comes from hand-editable files (`.dsh/WORKFLOW.json`, `.dsh/FEATURES.json`,
 * `.dsh/CONSTRAINTS.json`) or from arguments that are echoed back even when REFUSED. A
 * newline in any of those becomes a standalone line, which is indistinguishable from
 * report structure and can read as an instruction. Both `lib/tools.js` and `lib/gc.js`
 * render such values, so the rule lives here once rather than being duplicated.
 *
 * The class covers ASCII controls, DEL, the C1 controls (NEL is U+0085) and the two
 * Unicode line separators, because a Unicode-aware consumer treats U+2028/U+2029 as
 * line breaks even though `String.prototype.split('\n')` does not.
 *
 * @param value - any value; stringified defensively.
 * @returns one line, with every line terminator replaced by a space.
 */
export function oneLine(value) {
  return String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
}

/**
 * Return a structurally lossless-JSON copy of a tool result.
 *
 * `undefined` becomes `null`, non-finite numbers become `null`, functions and
 * symbols are dropped, and cycles are replaced with a marker. The host rejects a
 * tool result that is not lossless JSON, so an unconverted `undefined` anywhere in
 * the payload fails the whole call with "returned invalid output".
 *
 * It lives here, in the leaf module every tool module already imports, rather than in
 * `tools.js`: `lib/gc.js` is registered by `tools.js`, so exporting the sanitiser from the
 * tool registry would make the two modules import each other. Re-exported from `tools.js`
 * for the callers that already import it there.
 *
 * @param value - the value to sanitise.
 * @returns A value safe to return from a tool body.
 */
export function toLosslessJson(value, seen = new WeakSet()) {
  if (value === undefined || value === null) return null
  const type = typeof value
  if (type === 'string' || type === 'boolean') return value
  if (type === 'number') return Number.isFinite(value) ? value : null
  if (type === 'bigint') return Number(value)
  if (type === 'function' || type === 'symbol') return null
  if (Array.isArray(value)) {
    if (seen.has(value)) return []
    seen.add(value)
    const out = value.map(item => toLosslessJson(item, seen))
    seen.delete(value)
    return out
  }
  if (type === 'object') {
    if (seen.has(value)) return '[circular]'
    seen.add(value)
    const out = {}
    for (const [key, item] of Object.entries(value)) {
      // A key whose value is undefined is dropped entirely, matching JSON.stringify.
      if (item === undefined) continue
      out[key] = toLosslessJson(item, seen)
    }
    seen.delete(value)
    return out
  }
  return null
}

/**
 * Human-readable meaning of each approval strength, used in status output and on
 * the settings page. The wording states the consequence, not just the label.
 */
export const APPROVAL_STRENGTH_LABELS = {
  'ask-user': 'every approval-gated action asks you first',
  'llm-then-user': 'the model judges risk first; a rejection is handed to you to decide',
  'llm-only': 'the model decides alone — it may allow an unsafe action and spends extra tokens',
  off: 'nothing is intercepted — approval-gated actions proceed unguarded',
}

/**
 * The three-level risk model, reused verbatim from the shipped Auto review layer.
 *
 * @see refs/dsh-experimental-auto-review/README.md
 */
export const RISK_MODEL = {
  low: { verdict: 'allow', description: 'ordinary project-local work; cleanup of objects created in this session' },
  medium: { verdict: 'ask', description: 'deleting pre-existing objects, production actions, external writes, security changes' },
  high: { verdict: 'deny', description: 'sensitive exfiltration across a trust boundary — always denied' },
}
