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

/** How many feature ids one stale class prints before it summarizes the rest. */
const STALE_ID_CAP = 8

/**
 * Summarize the reviewer findings one evidence row recorded, as one bounded phrase.
 *
 * THE STATES ARE DIFFERENT AND READ DIFFERENTLY: a row with no `issues` field was written before
 * findings were persisted, and a row with `issues: []` recorded a reviewer that found nothing.
 * BOTH RENDER NOTHING. The empty phrase is what keeps an old report byte-identical, and a
 * "the reviewer recorded no finding" line for every clean review would bury the features that do
 * have findings — review round 1 of this change found exactly that line in the status report.
 * `issuesTotal` only appears when the writer had to drop some findings.
 *
 * @param issues - the `issues` array from an evidence row, or anything (malformed is "not recorded").
 * @param issuesTotal - how many findings existed before truncation, when the writer recorded it.
 * @returns one phrase, or '' when the row does not say what the reviewer found.
 */
export function describeRecordedIssues(issues, issuesTotal = null) {
  if (!Array.isArray(issues)) return ''
  const counts = { blocker: 0, major: 0, minor: 0 }
  let reachable = 0
  let rendered = 0
  for (const issue of issues) {
    if (issue === null || typeof issue !== 'object' || Array.isArray(issue)) continue
    rendered += 1
    const severity = issue.severity === 'blocker' || issue.severity === 'minor' ? issue.severity : 'major'
    counts[severity] += 1
    if (issue.reachable === true) reachable += 1
  }
  const total = Number.isFinite(issuesTotal) && issuesTotal > rendered ? issuesTotal : rendered
  if (total === 0) return ''
  const parts = []
  for (const severity of ['blocker', 'major', 'minor']) {
    if (counts[severity] > 0) parts.push(`${counts[severity]} ${severity}`)
  }
  const shown = total === rendered ? `${rendered}` : `${rendered} of ${total}`
  return `${shown} recorded finding(s) (${parts.join(', ')}${reachable > 0 ? `; ${reachable} reachable` : ''})`
}

/**
 * Render the JUDGED stale summary: which stale records owe a re-review, and which are cosmetic.
 *
 * WHY A SHARED HELPER. `workflow_status`, the handoff brief and the `workflow_advance` reply all
 * report review freshness, and the three used to say only "STALE for a, b, c" — literal advice
 * that was measured to be wrong: most of those records were stale because a document inside their
 * declared set had been edited, and chasing all of them cost hours. The judgement lives once so
 * the three surfaces cannot disagree about which re-reviews are owed.
 *
 * BOUNDED AND FLATTENED like every other rendered value: ids come out of a hand-editable
 * `FEATURES.json`, so each is passed through {@link oneLine} and the list is capped. An empty or
 * malformed argument renders the empty string, which is how a caller keeps a pre-existing report
 * byte-identical.
 *
 * @param staleKinds - `{ code, docs, unknown }` lists of feature ids.
 * @returns one sentence fragment, or '' when there is no stale record to judge.
 */
export function describeStaleJudgement(staleKinds) {
  const ids = key => {
    const list = Array.isArray(staleKinds?.[key])
      ? staleKinds[key].filter(id => typeof id === 'string' && id !== '')
      : []
    const shown = list.slice(0, STALE_ID_CAP).map(id => oneLine(id).slice(0, 200))
    if (shown.length === 0) return { count: 0, text: '' }
    const more = list.length > shown.length ? ` and ${list.length - shown.length} more` : ''
    return { count: list.length, text: `${shown.join(', ')}${more}` }
  }
  const code = ids('code')
  const docs = ids('docs')
  const unknown = ids('unknown')
  if (code.count + docs.count + unknown.count === 0) return ''
  const parts = []
  if (code.count > 0) {
    parts.push(`${code.count} re-review(s) owed (code changed: ${code.text})`)
  }
  if (docs.count > 0) {
    // NOTHING IS WRONG WITH THESE RECORDS' CODE CLAIM; only the documents in their set moved.
    // Worded so one id reads as well as ten ("their ... claims" for a single id was a grammar
    // complaint from review round 1).
    parts.push(
      `${docs.count} cosmetic (documents only: ${docs.text} — the reviewed code is unchanged, ` +
        'so those claims still hold)',
    )
  }
  if (unknown.count > 0) {
    parts.push(
      `${unknown.count} unclassified (changed files could not be told apart: ${unknown.text} — ` +
        'counted as owed)',
    )
  }
  return parts.join('; ')
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
