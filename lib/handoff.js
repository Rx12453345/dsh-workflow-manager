/**
 * The HANDOFF brief (`.dsh/HANDOFF.md`) — the document that lets the next session start cold.
 *
 * WHY THE BRIEF EXISTS AT ALL
 * The phase machine records everything a later session needs (phase, features, review evidence,
 * waivers, the constraint ledger), but it records it as three JSON files whose meaning lives in
 * this repository's code. A model that opens the project tomorrow does not read `WORKFLOW.json`
 * — it reads a status report, or it reads nothing. `modules.handoffDoc` has been declared (default
 * `true`, rendered on the settings page, listed by `workflow_status`) since the first version
 * while NO code read it: a user-visible switch that did nothing. This module is that switch's
 * implementation. It renders the state as prose a cold reader can act on: the phase, every
 * feature with its pass/fail and whether its review still covers the files on disk, the last
 * review recorded for each feature, the blockers the transition rules apply to COMMIT/HANDOFF,
 * the open constraints, and the moves the machine still allows.
 *
 * WHY `.dsh/HANDOFF.md` AND NOT THE REPOSITORY ROOT
 * The repository root already carries a TRACKED `HANDOFF.md` (the 2026-10-25 incident brief).
 * A generator that wrote there would overwrite a human-owned document, and it would dirty the
 * working tree on every HANDOFF. `.dsh/` is the workflow's own directory — gitignored in this
 * repository — so the generated brief never appears in `git status`, never enters a diff, and
 * can never be declared in a review's `changed_files` and stale a feature. The target is
 * therefore derived, never passed: {@link assertHandoffDocTarget} resolves it and refuses
 * anything whose basename is not `HANDOFF.md` directly under the scope's workflow directory, so
 * no caller can ask this module to write the root brief.
 *
 * WHY A WORK UNIT GETS ITS OWN BRIEF
 * The brief's content is rendered from the SCOPE's state, so one project-level path would be a
 * collision: two work units entering HANDOFF would overwrite each other, and
 * `workflow_status work_unit=A` would pair A's counts with B's file. A named unit therefore
 * writes `.dsh/work/<id>/HANDOFF.md` — the directory its own `WORKFLOW.json` lives in — and the
 * project-level brief is left untouched by either. `<id>` is validated by the project's
 * work-unit validator and the resolved path is containment-checked inside `.dsh/work`, so an id
 * such as `../x` can never name a file outside the unit's own directory.
 *
 * WHAT IT DOES NOT DO
 * It invents nothing. Every line is derived from `WORKFLOW.json`, `FEATURES.json`,
 * `.dsh/CONSTRAINTS.json` (the caller passes the ledger) and the recheck of the reviewed files;
 * where a value is missing or malformed the brief says so instead of guessing. It is not a
 * security boundary: the transition rules are enforced by `lib/advance.js` and `lib/tools.js`,
 * and the brief only restates them so the reader does not have to rediscover them.
 *
 * WHY THE IMPORT GOES ONE WAY
 * This module reads `lib/advance.js` (freshness, feature counts, the transition graph); the
 * phase machine calls the writer lazily, at the single moment a project ENTERS `HANDOFF` (see
 * `enterHandoff` in `lib/advance.js`). That keeps the static graph acyclic: the renderer depends
 * on the machine, never the other way round.
 *
 * @module src-12453345_-dsh-workflow/handoff
 */

import { mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join, resolve, sep } from 'node:path'

import { describeRecordedIssues, describeStaleJudgement, oneLine } from './shared.js'
import {
  REVIEW_EVIDENCE_TYPE,
  allowedTransitions,
  featureCounts,
  reviewFreshnessAll,
} from './advance.js'
import { WORK_UNIT_DIR_RELATIVE_PATH, isContainedIn, validateWorkUnitId } from './work-unit.js'

/** The workflow-owned directory the brief lives in. */
export const HANDOFF_DOC_DIRECTORY = '.dsh'

/** The brief's file name. DELIBERATELY the same name as the tracked root brief, in `.dsh/`. */
export const HANDOFF_DOC_FILENAME = 'HANDOFF.md'

/** The brief's path, relative to the project root. The ONLY target this module can write. */
export const HANDOFF_DOC_RELATIVE_PATH = join(HANDOFF_DOC_DIRECTORY, HANDOFF_DOC_FILENAME)

/**
 * The brief's path as a report should print it.
 *
 * A separate constant so a status line reads the same on every platform, and so no report
 * accidentally prints a bare `HANDOFF.md` that a reader could mistake for the tracked root file.
 */
export const HANDOFF_DOC_DISPLAY_PATH = `${HANDOFF_DOC_DIRECTORY}/${HANDOFF_DOC_FILENAME}`

/** Render a project-relative path with forward slashes, the way reports print it. */
function displayPathOf(relativePath) {
  return relativePath.split(sep).join('/')
}

/**
 * Resolve the brief's scope: the project itself, or one work unit.
 *
 * THE PATH IS NEVER A PARAMETER. The only variable part is a work-unit id, and that id comes
 * out of the project's own validator — which refuses separators, leading dots and every other
 * way a traversal is written — so a scope can only widen the path to `.dsh/work/<id>/`, never
 * outside it.
 *
 * @param workUnit - the optional work-unit id.
 * @returns `{ ok: true, id, relativePath }` (id `null` for the project) or `{ ok: false, error }`.
 */
function handoffScope(workUnit) {
  if (workUnit === undefined || workUnit === null) {
    return { ok: true, id: null, relativePath: HANDOFF_DOC_RELATIVE_PATH }
  }
  const checked = validateWorkUnitId(workUnit)
  if (checked.ok !== true) return { ok: false, error: checked.error }
  return {
    ok: true,
    id: checked.id,
    relativePath: join(WORK_UNIT_DIR_RELATIVE_PATH, checked.id, HANDOFF_DOC_FILENAME),
  }
}

/**
 * The brief's project-relative path for a scope.
 *
 * The project-level scope is the constant; a work unit adds exactly one directory segment,
 * `.dsh/work/<id>/`. The `null` return means the id is unusable and is refused rather than
 * sanitised, consistently with every other work-unit path in this plugin.
 *
 * @param workUnit - the optional work-unit id.
 * @returns the project-relative path, or `null` when the id is unusable.
 */
export function handoffDocRelativePath(workUnit) {
  const scope = handoffScope(workUnit)
  return scope.ok === true ? scope.relativePath : null
}

/** How much of a feature description the brief repeats. */
const FEATURE_DESCRIPTION_CAP = 200

/** How much of a reason string the brief repeats. */
const REASON_CAP = 240

/** How much of a constraint rule the brief repeats. */
const CONSTRAINT_RULE_CAP = 400

/** How much of a constraint's `why` the brief repeats. */
const CONSTRAINT_WHY_CAP = 300

/** How much of a waiver reason the brief repeats (it is free text from a model). */
const WAIVER_REASON_CAP = 300

/**
 * Resolve the brief's target inside a project and refuse anything else.
 *
 * THE REFUSAL IS THE POINT. There is no path argument anywhere in this module: the writer can
 * only write the path its scope derives, and this function re-derives the one legal absolute
 * path from the project root. The root `HANDOFF.md` is checked explicitly as well, so a future
 * refactor that changed the relative constant could not quietly start overwriting the tracked
 * incident brief. A work-unit scope gets one extra check: the resolved path must be inside
 * `.dsh/work`, which is defence in depth on top of the id validator (the same belt-and-braces
 * the work-unit resolver applies to its own state files).
 *
 * @param projectDir - the project root.
 * @param workUnit - the optional work-unit id; absent means the project-level brief.
 * @returns `{ ok: true, path, relativePath, displayPath, workUnit }` or `{ ok: false, reason }`.
 */
export function assertHandoffDocTarget(projectDir, workUnit) {
  if (typeof projectDir !== 'string' || projectDir.trim() === '') {
    return { ok: false, reason: 'no project directory was resolved, so the handoff brief cannot be written' }
  }
  const scope = handoffScope(workUnit)
  if (scope.ok !== true) {
    return {
      ok: false,
      reason:
        `refusing to write the handoff brief for work unit ${JSON.stringify(workUnit)}: ${scope.error}. ` +
        'The id is refused rather than sanitised, because a mangled id would name a different unit.',
    }
  }
  const root = resolve(projectDir)
  const relativePath = scope.relativePath
  const displayPath = displayPathOf(relativePath)
  const path = resolve(root, relativePath)
  const directory = resolve(root, dirname(relativePath))
  const rootBrief = resolve(root, HANDOFF_DOC_FILENAME)
  const escape = (shown) =>
    `refusing to write ${JSON.stringify(shown)}: the handoff brief is always ${displayPath}`
  if (path === rootBrief) return { ok: false, reason: escape(rootBrief) }
  if (basename(path) !== HANDOFF_DOC_FILENAME) return { ok: false, reason: escape(path) }
  if (dirname(path) !== directory || path !== join(directory, HANDOFF_DOC_FILENAME)) {
    return { ok: false, reason: escape(path) }
  }
  if (scope.id !== null && !isContainedIn(resolve(root, WORK_UNIT_DIR_RELATIVE_PATH), path)) {
    return { ok: false, reason: escape(path) }
  }
  return { ok: true, path, relativePath, displayPath, workUnit: scope.id }
}

/** Collapse and bound an untrusted value for a single brief line. */
function text(value, cap) {
  if (typeof value !== 'string') return ''
  return oneLine(value).trim().slice(0, cap)
}

/** A one-line rendering of a score, honest about a missing or non-numeric value. */
function score(value) {
  return Number.isFinite(value) ? String(value) : '(not recorded)'
}

/** The review evidence rows a feature carries, in document order. */
function reviewRows(feature) {
  const evidence = Array.isArray(feature?.evidence) ? feature.evidence : []
  return evidence.filter(
    row => row !== null && typeof row === 'object' && !Array.isArray(row) && row.type === REVIEW_EVIDENCE_TYPE,
  )
}

/** The last review row recorded for a feature, or null. */
function lastReviewRow(feature) {
  const rows = reviewRows(feature)
  return rows.length === 0 ? null : rows[rows.length - 1]
}

/** The freshness summary for every reviewed feature, never throwing. */
function freshnessOf(projectDir, workUnit, document, context = null) {
  try {
    return reviewFreshnessAll(projectDir, workUnit, document, context)
  } catch (error) {
    return {
      state: 'unknown',
      counts: { fresh: 0, stale: 0, unknown: 0 },
      staleKinds: { code: [], docs: [], unknown: [] },
      features: [],
      reason: `the review evidence could not be rechecked: ${error?.message ?? error}`,
    }
  }
}

/** The freshness answer for one feature id, or null when it has no review evidence. */
function freshnessFor(featureId, byId) {
  return typeof featureId === 'string' && byId.has(featureId) ? byId.get(featureId) : null
}

/** The label the brief prints for a freshness state. */
const FRESHNESS_LABELS = {
  fresh: 'FRESH',
  stale: 'STALE',
  unknown: 'UNKNOWN',
  none: 'no review evidence',
}

/** Normalise the constraints argument: a ledger document, a read result, or a bare array. */
function ledgerOf(source) {
  if (Array.isArray(source)) return { rows: source, problems: [] }
  if (source !== null && typeof source === 'object' && !Array.isArray(source)) {
    const document = source.document !== null && typeof source.document === 'object' ? source.document : source
    const rows = Array.isArray(document.constraints) ? document.constraints : []
    const problems = Array.isArray(source.problems)
      ? source.problems.filter(problem => typeof problem === 'string')
      : []
    return { rows, problems }
  }
  return { rows: [], problems: [] }
}

/** The retirement condition of a constraint, as the ledger recorded it. */
function retireLine(constraint) {
  const when = constraint?.retire_when
  if (when === null || typeof when !== 'object' || Array.isArray(when)) {
    return 'retire: (no retirement condition recorded — a constraint without one can never retire)'
  }
  const parts = []
  if (Number.isFinite(when.review_after_days) && when.review_after_days > 0) {
    parts.push(`review after ${when.review_after_days} day(s)`)
  }
  const observable = when.observable
  if (observable !== null && typeof observable === 'object' && !Array.isArray(observable)) {
    const kind = text(observable.kind, 40)
    const phase = text(observable.phase, 40)
    const atLeast = Number.isFinite(observable.at_least) ? observable.at_least : null
    if (kind !== '' && phase !== '' && atLeast !== null) {
      parts.push(`the framework counts ${kind} into ${phase} >= ${atLeast}`)
    }
  }
  const signal = text(when.signal, REASON_CAP)
  if (signal !== '') parts.push(`a human must judge: "${signal}"`)
  return parts.length === 0
    ? 'retire: (no usable retirement condition recorded — a constraint without one can never retire)'
    : `retire: ${parts.join('; ')}`
}

/**
 * Build the handoff brief as markdown.
 *
 * THE OUTPUT IS A HUMAN DOCUMENT, NOT A SERIALISED STATE. Every fact is read from the arguments
 * (the live documents) or rechecked against the files on disk; nothing is copied out of a source
 * file verbatim, because `FEATURES.json` and `CONSTRAINTS.json` are hand-editable and a newline
 * inside a description would forge brief structure. `oneLine` bounds each such value.
 *
 * REGENERATION IS BYTE-IDEMPOTENT when the state has not moved. The timestamp line defaults to
 * `state.updated_at` — the moment the state the brief describes was written — instead of "now",
 * so writing the same state twice produces the same bytes. A caller that wants a different stamp
 * passes `now` explicitly; it is then used as given.
 *
 * IT NEVER THROWS on malformed input: `WORKFLOW.json`, `FEATURES.json` and `CONSTRAINTS.json` are
 * hand-editable, and a brief that crashed would leave the reader with no brief at all. Missing
 * values are printed as missing.
 *
 * @param options - `{ state, features, constraints, projectDir, now, workUnit, recipe }`. `state`
 *   and `features` are the parsed documents (an array of features is also accepted); `constraints`
 *   is a ledger document, a `readConstraints` result, or an array; `now` overrides the stamp.
 * @returns the markdown brief.
 */
export function buildHandoffDoc(options = {}) {
  const { state, features, constraints, projectDir, now, workUnit, recipe, classification, selfProject } = options ?? {}

  const featureList = Array.isArray(features)
    ? features
    : Array.isArray(features?.features)
      ? features.features
      : []
  const document = { features: featureList }
  const counts = featureCounts(document)
  // THE JUDGEMENT NEEDS THE PROJECT'S OWN CLASSIFICATION, so it is threaded from the caller that
  // already resolved it (tools.js) instead of being re-derived here with a second rule.
  const freshness = freshnessOf(projectDir, workUnit, document, { classification, selfProject })
  const reviewed = Array.isArray(freshness?.features) ? freshness.features : []
  const byId = new Map(
    reviewed
      .filter(result => typeof result?.featureId === 'string' && result.featureId !== '')
      .map(result => [result.featureId, result]),
  )
  const freshCounts = freshness?.counts ?? { fresh: 0, stale: 0, unknown: 0 }
  const phase = typeof state?.phase === 'string' && state.phase !== '' ? state.phase : null
  const recipeName = typeof recipe === 'string' && recipe !== '' ? recipe : null
  const allowed = phase === null ? [] : allowedTransitions(phase, recipeName === null ? {} : { recipe: recipeName })
  const stamp =
    typeof now === 'string' && now !== ''
      ? now
      : typeof state?.updated_at === 'string' && state.updated_at !== ''
        ? state.updated_at
        : new Date().toISOString()
  const selectedFeatureId = typeof state?.feature_id === 'string' && state.feature_id !== '' ? state.feature_id : null
  const round = Number.isFinite(state?.round) ? state.round : null
  const scope =
    typeof workUnit === 'string' && workUnit !== ''
      ? `work unit \`${text(workUnit, 64)}\``
      : 'project-level state'
  // THE BRIEF NAMES THE FILE IT IS. For a work unit that is `.dsh/work/<id>/HANDOFF.md`, not the
  // project-level path: a reader who follows the sentence must land on THIS document, or the
  // brief sends them to another unit's file.
  const scopePath = handoffScope(workUnit)
  const briefPath = scopePath.ok === true ? displayPathOf(scopePath.relativePath) : HANDOFF_DOC_DISPLAY_PATH

  const openFeatures = featureList.filter(feature => feature?.passes !== true)
  const staleResults = reviewed.filter(result => result?.state === 'stale')
  const unknownResults = reviewed.filter(result => result?.state === 'unknown')
  const waivers = Array.isArray(state?.waivers) ? state.waivers : []
  const lastWaiver =
    waivers.length === 0 ? null : waivers[waivers.length - 1] !== null && typeof waivers[waivers.length - 1] === 'object'
      ? waivers[waivers.length - 1]
      : null
  const ledger = ledgerOf(constraints)
  const constraintRows = ledger.rows
  const activeConstraints = constraintRows.filter(
    row => row !== null && typeof row === 'object' && !Array.isArray(row) && row.status !== 'retired',
  )
  const retiredConstraints = constraintRows.filter(
    row => row !== null && typeof row === 'object' && !Array.isArray(row) && row.status === 'retired',
  )
  const malformedConstraints = constraintRows.length - activeConstraints.length - retiredConstraints.length

  const out = []
  out.push('# Handoff brief')
  out.push('')
  out.push(
    'This file is generated by dsh-workflow from the live workflow state. It is overwritten ' +
      'whenever the brief is regenerated, so do not hand-edit it. It lives at ' +
      `\`${briefPath}\` — a workflow-owned path that is gitignored in this ` +
      'repository — and it is **not** the tracked repository-root `HANDOFF.md`.',
  )
  out.push('')
  const projectLabel = typeof projectDir === 'string' && projectDir !== '' ? text(projectDir, 400) : '(not recorded)'
  out.push(`- project: \`${projectLabel}\``)
  out.push(`- scope: ${scope}`)
  out.push(
    `- phase: ${phase === null ? '(not recorded)' : text(phase, 40)}` +
      `${round === null ? '' : ` · round ${round}`}` +
      `${selectedFeatureId === null ? '' : ` · selected feature: ${text(selectedFeatureId, 200)}`}`,
  )
  out.push(`- features: ${counts.done}/${counts.total} complete, ${counts.open} open`)
  out.push(
    `- review freshness: ${Number(freshCounts.stale) || 0} stale, ` +
      `${Number(freshCounts.unknown) || 0} unknown, ${Number(freshCounts.fresh) || 0} fresh`,
  )
  // THE JUDGEMENT, on its own line so the counts line above stays parseable. This is the sentence
  // that tells the next session whether the stale records are work or bookkeeping.
  const staleJudgement = describeStaleJudgement(freshness?.staleKinds)
  if (staleJudgement !== '') out.push(`- review judgement: ${staleJudgement}`)
  if (recipeName !== null) out.push(`- recipe: ${text(recipeName, 40)}`)
  out.push(`- generated: ${text(stamp, 80)}`)
  out.push('')

  // ---- features -----------------------------------------------------------
  out.push(`## Features (${counts.total})`)
  out.push('')
  if (featureList.length === 0) {
    out.push('- (no features recorded)')
  } else {
    for (const feature of featureList) {
      const id = text(feature?.id, 200)
      const shownId = id === '' ? '(no id)' : id
      const passed = feature?.passes === true
      const description = text(feature?.description, FEATURE_DESCRIPTION_CAP)
      const result = freshnessFor(feature?.id, byId)
      const rows = reviewRows(feature)
      const last = lastReviewRow(feature)
      let stateLine = passed ? 'complete' : 'OPEN'
      // THE LABEL COMES FROM THE SAME RECHECK THE COMMIT/HANDOFF GATE USES, so the brief and the
      // refusal cannot disagree. `null` means the feature has no review row at all: the recheck
      // collects every feature WITH evidence, so a reviewed-but-malformed row arrives as UNKNOWN
      // rather than as missing.
      if (result === null) {
        stateLine += ' · no review evidence'
      } else {
        stateLine += ` · review ${FRESHNESS_LABELS[result.state] ?? 'UNKNOWN'}`
      }
      out.push(`- [${passed ? 'x' : ' '}] ${shownId} — ${stateLine}`)
      if (description !== '') out.push(`  ${description}`)
      if (last === null) {
        out.push('  last review: none recorded')
      } else {
        out.push(
          `  last review: ${last.passed === true ? 'PASS' : 'FAIL'} · overall ${score(last.overall)} · ` +
            `${text(last.at, 80) === '' ? '(date not recorded)' : text(last.at, 80)}` +
            `${Number.isFinite(last.round) ? ` · round ${last.round}` : ''} · ${rows.length} review row(s)`,
        )
        // THE FINDINGS, not just the score. A PASS with three unfixed minors is not the same
        // handoff as a clean one, and the evidence row is where they now live. Silent for a row
        // written before the summary was persisted, so an old brief is unchanged.
        const findings = describeRecordedIssues(last.issues, last.issuesTotal)
        if (findings !== '') out.push(`  findings: ${findings}`)
      }
      // The reason a PASS no longer covers the artefact, one line, bounded. This is the single
      // most useful sentence for the next session: it says WHICH feature to re-review. For a
      // STALE verdict the digest pair in `result.reason` is deliberately not repeated — it is
      // exact but not actionable, and the state already carries it.
      if (result !== null && result.state === 'stale') {
        // THE TWO STALE KINDS GET DIFFERENT ADVICE, because they are different work. A record
        // whose code moved does not cover the artefact any more; one whose documents moved still
        // does, and telling the next session to re-review it is how a documentation edit used to
        // cost a review round it did not need.
        if (result.staleKind === 'docs') {
          out.push(
            '  stale (documents only): the code this record covers is unchanged — only ' +
              'documentation in its reviewed set moved, so re-reviewing is optional; re-run ' +
              'workflow_review when the claim needs to cover the new text.',
          )
        } else if (result.staleKind === 'code') {
          out.push(
            '  stale (code changed): the reviewed code changed after the review; re-run ' +
              'workflow_review and record the verdict.',
          )
        } else {
          out.push(
            '  stale: the recorded PASS no longer covers the artefact — the reviewed files ' +
              'changed after the review; re-run workflow_review and record the verdict.',
          )
        }
      } else if (result !== null && result.state === 'unknown') {
        const reason = text(result.reason, REASON_CAP)
        if (reason !== '') out.push(`  unknown: ${reason}`)
      }
    }
  }
  out.push('')

  // ---- blockers -----------------------------------------------------------
  out.push('## Blockers for COMMIT and HANDOFF')
  out.push('')
  out.push(
    '`workflow_advance` enforces these rules; this brief only reports how they apply now. ' +
      'COMMIT and HANDOFF refuse any feature whose reviewed files changed after its PASS ' +
      '(STALE). HANDOFF additionally refuses while any feature is open, unless a waiver was ' +
      'recorded.',
  )
  out.push('')
  if (staleResults.length === 0) {
    out.push('- No STALE feature: every recorded PASS still covers the files on disk.')
  } else {
    out.push(
      `- STALE (${staleResults.length}): ${staleResults.map(result => text(result.featureId, 200)).join(', ')} ` +
        '— re-run workflow_review for each of these and record the verdict before relying on its PASS.',
    )
    // THE SAME JUDGEMENT THE STATUS LINE CARRIES, so a reader of the file cannot conclude that all
    // of these re-reviews are equally necessary.
    if (staleJudgement !== '') out.push(`- Why, and what is actually owed: ${staleJudgement}.`)
  }
  if (openFeatures.length === 0) {
    out.push('- No open feature: the HANDOFF feature-count gate is satisfied.')
  } else {
    const named = openFeatures.slice(0, 20).map(feature => text(feature?.id, 200) || '(no id)')
    const more = openFeatures.length > named.length ? ` and ${openFeatures.length - named.length} more` : ''
    out.push(
      `- OPEN (${openFeatures.length}): ${named.join(', ')}${more} — ` +
        (openFeatures.length === 1
          ? 'finish it, or record another HANDOFF waiver naming why it is deliberately left unfinished.'
          : 'finish them, or record another HANDOFF waiver naming why they are deliberately left unfinished.'),
    )
  }
  if (unknownResults.length > 0) {
    out.push(
      `- UNKNOWN evidence (${unknownResults.length}): ` +
        `${unknownResults.map(result => text(result.featureId, 200)).join(', ')} — the evidence ` +
        'cannot be rechecked, so it is not treated as fresh.',
    )
  }
  if (lastWaiver === null) {
    out.push('- Waiver: none recorded.')
  } else {
    // THE REASON IS FREE TEXT AND THE BRIEF IS A REPORT, so it is bounded — but a cut sentence
    // must LOOK cut, or a reader takes the last word for the end of the argument. The stored
    // waiver already caps the reason; this cap is the rendering's own.
    const rawReason = typeof lastWaiver.reason === 'string' ? oneLine(lastWaiver.reason) : ''
    const reason =
      rawReason.length > WAIVER_REASON_CAP
        ? `${rawReason.slice(0, WAIVER_REASON_CAP)}…`
        : rawReason
    // THE IDS ARE FLATTENED LIKE THE OPEN BLOCKER LINE'S, because they come out of a
    // hand-editable `WORKFLOW.json`: a newline inside one would otherwise become its own line of
    // the brief, and a waiver line a reader takes as "the framework waived this" is exactly the
    // structure a forged line can imitate.
    const ids = Array.isArray(lastWaiver.openFeatures)
      ? lastWaiver.openFeatures
          .filter(value => typeof value === 'string')
          .slice(0, 20)
          .map(value => text(value, 200) || '(no id)')
      : []
    out.push(
      `- Waiver recorded at ${text(lastWaiver.at, 80) || '(date not recorded)'}: ` +
        `${Number.isFinite(lastWaiver.openTotal) ? `${lastWaiver.openTotal} open feature(s)` : 'an open set'}` +
        `${ids.length === 0 ? '' : ` (${ids.join(', ')})`}` +
        `${reason === '' ? '; no reason recorded' : ` — "${reason}"`}`,
    )
  }
  out.push('')

  // ---- constraints --------------------------------------------------------
  out.push(
    `## Constraints (${activeConstraints.length} active` +
      `${retiredConstraints.length > 0 ? `, ${retiredConstraints.length} retired` : ''})`,
  )
  out.push('')
  if (activeConstraints.length === 0) {
    out.push('- (no active constraint)')
  } else {
    for (const constraint of activeConstraints) {
      const id = text(constraint.id, 40)
      const shownId = id === '' ? '(no id)' : id
      out.push(`- ${shownId} [${text(constraint.status, 20) || 'active'}] ${text(constraint.rule, CONSTRAINT_RULE_CAP)}`)
      const why = text(constraint.why, CONSTRAINT_WHY_CAP)
      if (why !== '') out.push(`  why: ${why}`)
      out.push(`  ${retireLine(constraint)}`)
    }
  }
  if (retiredConstraints.length > 0) {
    out.push(
      `- ${retiredConstraints.length} retired constraint(s) are kept in the ledger but not repeated here; ` +
        '`workflow_gc action=list` shows them.',
    )
  }
  if (malformedConstraints > 0) {
    out.push(
      `- ${malformedConstraints} ledger entr${malformedConstraints === 1 ? 'y is' : 'ies are'} ` +
        'not an object and cannot be rendered.',
    )
  }
  for (const problem of ledger.problems) out.push(`- ledger problem: ${text(problem, REASON_CAP)}`)
  out.push('')

  // ---- next moves ---------------------------------------------------------
  out.push('## Next legal moves')
  out.push('')
  if (phase === null) {
    out.push('- (no phase recorded, so the machine has no legal move to report)')
  } else if (allowed.length === 0) {
    out.push(`- ${text(phase, 40)} has no successor phase${phase === 'HANDOFF' ? ' (HANDOFF is terminal)' : ''}.`)
  } else {
    out.push(`- from ${text(phase, 40)}: ${allowed.join(' | ')}`)
  }
  return `${out.join('\n')}\n`
}

/**
 * Write the handoff brief to the scope's path, atomically.
 *
 * THE SCOPE IS PART OF THE TARGET. A project-level call writes `PROJECT/.dsh/HANDOFF.md`; a
 * named work unit writes `PROJECT/.dsh/work/<id>/HANDOFF.md`, so two units cannot overwrite
 * each other's brief and a status call for A reads the file rendered from A's state.
 *
 * A TEMP FILE PLUS A RENAME, like every other writer in this plugin: an interrupted write must
 * not leave a half-written brief that a later reader would treat as the record.
 *
 * REGENERATION IS NOT APPEND. The file is replaced with the freshly rendered text; the same state
 * twice produces byte-identical content (see {@link buildHandoffDoc}), which is what makes it
 * safe to write on every HANDOFF entry.
 *
 * @param options - the same arguments as {@link buildHandoffDoc}, plus `projectDir`.
 * @returns `{ ok, written, path, relativePath, displayPath, bytes, modifiedAt }` on success, or
 *   `{ ok: false, written: false, reason }` when the target is refused or the write fails.
 */
export function writeHandoffDoc(options = {}) {
  const scope = handoffScope(options?.workUnit)
  const fallbackRelative = scope.ok === true ? scope.relativePath : HANDOFF_DOC_RELATIVE_PATH
  const fallbackDisplay = displayPathOf(fallbackRelative)
  const target = assertHandoffDocTarget(options?.projectDir, options?.workUnit)
  if (target.ok !== true) {
    return {
      ok: false,
      written: false,
      relativePath: fallbackRelative,
      displayPath: fallbackDisplay,
      reason: target.reason,
    }
  }
  try {
    const markdown = buildHandoffDoc(options)
    mkdirSync(dirname(target.path), { recursive: true })
    const temporary = `${target.path}.tmp`
    writeFileSync(temporary, markdown, 'utf8')
    renameSync(temporary, target.path)
    const info = statSync(target.path)
    return {
      ok: true,
      written: true,
      path: target.path,
      relativePath: target.relativePath,
      displayPath: target.displayPath,
      bytes: info.size,
      modifiedAt: info.mtime.toISOString(),
    }
  } catch (error) {
    return {
      ok: false,
      written: false,
      relativePath: target.relativePath,
      displayPath: target.displayPath,
      reason: `the handoff brief could not be written: ${error?.message ?? error}`,
    }
  }
}

/**
 * Read the brief's file facts for `workflow_status`, without writing anything.
 *
 * `workflow_status` is promised to be read-only, so it reports the file rather than regenerating
 * it: a status call must not have a side effect. The scope is threaded through because the
 * content is unit-scoped: reporting the project-level path for `work_unit=A` would pair A's
 * counts with another scope's file. `modules.handoffDoc: false` is honoured here as well as at
 * the writer, so switching the module off removes the status section too — a switch that is off
 * must not leave a report line describing what it would have produced.
 *
 * @param projectDir - the project root.
 * @param modules - the effective `modules` section (the caller passes it so the switch is read
 *   through the same configuration layer as everything else).
 * @param workUnit - the optional work-unit id; absent means the project-level brief.
 * @returns `{ enabled, relativePath, displayPath, present, sizeBytes, modifiedAt, problem? }`.
 */
export function readHandoffDocStatus(projectDir, modules, workUnit) {
  const settings = modules !== null && typeof modules === 'object' && !Array.isArray(modules) ? modules : {}
  const enabled = settings.handoffDoc !== false
  const scope = handoffScope(workUnit)
  const base = {
    enabled,
    relativePath: scope.ok === true ? scope.relativePath : HANDOFF_DOC_RELATIVE_PATH,
    displayPath: scope.ok === true ? displayPathOf(scope.relativePath) : HANDOFF_DOC_DISPLAY_PATH,
    present: false,
    sizeBytes: null,
    modifiedAt: null,
  }
  if (!enabled) return base
  if (scope.ok !== true) return { ...base, problem: scope.error }
  const target = assertHandoffDocTarget(projectDir, workUnit)
  if (target.ok !== true) return { ...base, problem: target.reason }
  try {
    const info = statSync(target.path)
    if (!info.isFile()) {
      return { ...base, problem: `${target.displayPath} exists but is not a regular file` }
    }
    return {
      ...base,
      present: true,
      sizeBytes: info.size,
      modifiedAt: info.mtime.toISOString(),
    }
  } catch {
    // ENOENT is the ordinary "not written yet" case, not a problem to report.
    return base
  }
}
