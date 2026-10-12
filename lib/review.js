/**
 * Independent review: the plugin's core value.
 *
 * WHY A SEPARATE CHILD AGENT
 * An agent cannot grade its own work. Anthropic's planner/generator/evaluator work
 * records the reason plainly: the generator "has a lens on its own output", misses
 * its own bugs, and declares success early. The only reliable signal comes from a
 * reviewer that did NOT write the artifact, started from a fresh context, and was
 * told to verify claims instead of trusting them.
 *
 * WHY THE SCORE IS NOT TAKEN ON FAITH
 * A child that reports `score: 9` while its own `mustPass` dimension sits at 4 is
 * contradictory. This module therefore recomputes the overall score from the
 * per-dimension values and enforces `mustPass` independently, so the gate cannot be
 * passed by an inflated headline number.
 *
 * DESIGN CONSTRAINTS FROM THE SERVICE
 *  - `subagents.start(name, request)` resolves to a run whose `result` is a
 *    PROMISE; `run.dispose()` must always run, including on failure.
 *  - `parent` is mandatory — the run cannot be established without a calling agent.
 *  - When the provider is a one-shot in-process backend it advertises
 *    `outputSchema`, so the child can be asked for JSON directly rather than
 *    parsing prose out of its final message.
 *  - `stopReason === 'completed'` is the only success; every other reason means the
 *    child failed, was killed, or ran out of room, and must not be scored.
 *
 * @module src-12453345_-dsh-workflow/review
 */

import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { checkBar, describeValue, readEvaluatorGate, readStringList } from './gate.js'
import {
  CHANGE_CLASSES,
  DEFAULT_VERIFICATION,
  MAX_VERIFICATION_DEPTH,
  VERIFICATION_DEPTHS,
  MAX_SUBAGENT_DEPTH as DEFAULT_MAX_DEPTH,
  isChangeClass,
  normalisePath,
} from './config.js'

/** The dimensions a reviewer scores when the caller does not narrow them. */
export const DEFAULT_DIMENSIONS = Object.freeze([
  'correctness',
  'build',
  'tests',
  'regressions',
  'archFit',
  'legibility',
  'scope',
])

/** Dimensions that veto a pass when they fall below the bar. */
export const DEFAULT_MUST_PASS = Object.freeze(['correctness', 'build', 'regressions'])

/** The JSON Schema handed to the child for a machine-checkable verdict. */
export const REVIEW_OUTPUT_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    perDimension: {
      type: 'array',
      description: 'One entry per dimension you were asked to score.',
      items: {
        type: 'object',
        properties: {
          dimension: { type: 'string' },
          score: { type: 'number', description: '0-10 for this dimension.' },
          rationale: { type: 'string', description: 'One or two sentences of evidence.' },
        },
        required: ['dimension', 'score', 'rationale'],
        additionalProperties: false,
      },
    },
    issues: {
      type: 'array',
      description:
        'Concrete defects. Each must be actionable and located, and each must declare whether a ' +
        'REAL call sequence reaches it.',
      items: {
        type: 'object',
        properties: {
          where: { type: 'string', description: 'File path and line, or the exact failing command.' },
          what: { type: 'string', description: 'What is wrong.' },
          fix: { type: 'string', description: 'The smallest change that would fix it.' },
          severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
          // WHICH DIMENSION THIS DEFECT DAMAGES. Required for a defect that justifies holding
          // a veto dimension below the bar: the framework checks that a below-bar veto
          // dimension has at least one reachable issue naming it, and a rating without a
          // named cause is treated as an opinion rather than evidence.
          dimension: {
            type: 'string',
            description:
              'The scored dimension this defect damages, e.g. "correctness" or "regressions". ' +
              'Required when the defect is why a veto dimension falls below the bar.',
          },
          // REACHABILITY IS REQUIRED, and it is what keeps the gate terminating.
          //
          // Without it the review could not converge: an issue's severity is judged by the
          // reviewer, any below-bar veto dimension fails the round, and there is always one
          // more shape a hand-written payload could have. A live loop therefore spent three
          // rounds on findings the reviewer itself labelled "not reachable from the
          // plugin's own code paths" — real observations, but not reasons to fail the work.
          reachable: {
            type: 'boolean',
            description:
              'true only if you can name a concrete sequence of user or tool actions that reaches ' +
              'this defect in normal operation. A shape only a hand-written payload could produce ' +
              'is NOT reachable. Unreachable issues are recorded but never lower a score or block delivery.',
          },
          reach: {
            type: 'string',
            description:
              'When reachable: the exact sequence that triggers it (the tool call, the config that ' +
              'must be set, the input that must be supplied). When unreachable: say why it cannot be ' +
              'reached in normal operation.',
          },
        },
        required: ['where', 'what', 'fix', 'severity', 'reachable', 'reach'],
        additionalProperties: false,
      },
    },
    verified: {
      type: 'array',
      description: 'What you actually checked yourself, and how. Do not list what you merely read.',
      items: { type: 'string' },
    },
    observations: {
      type: 'array',
      description:
        'Things worth noting that are NOT defects: unreachable shapes, style preferences, latent ' +
        'follow-ups, ideas for later. These never affect the verdict. Put anything here rather than ' +
        'lowering a score for it.',
      items: { type: 'string' },
    },
    recommendation: { type: 'string' },
  },
  required: ['perDimension', 'issues'],
  additionalProperties: false,
})

/**
 * Build the reviewer's prompt.
 *
 * The reviewer is told to distrust this text. A summary supplied by the author is
 * evidence of intent, never evidence of behaviour, and a reviewer that simply
 * agrees with it adds cost without adding safety.
 *
 * @param options - the claim under review.
 * @returns one text block.
 */
export function buildReviewPrompt(options) {
  const {
    feature,
    acceptance = [],
    changedFiles = [],
    diff,
    sensors = [],
    round = 1,
    maxRounds = 3,
    dimensions = DEFAULT_DIMENSIONS,
    mustPass = DEFAULT_MUST_PASS,
    bar = 8,
    workspaceDir,
    verification,
  } = options

  const lines = [
    'You are an INDEPENDENT REVIEWER. You did not write this work and you owe its author nothing.',
    '',
    'Your job is to find out whether the work is actually correct — not to confirm that it looks',
    'plausible. Treat everything below as a CLAIM to be tested, not as fact. If a claim cannot be',
    'verified, say so and score the dimension accordingly.',
    '',
  ]

  // THE DEPTH IS PART OF THE CLAIM, so the reviewer is told it and told what it skipped. An
  // independent reviewer that does not know which harnesses were run cannot judge whether the
  // verification was adequate to the risk — and a shallow depth is exactly the thing worth a
  // second opinion, which is why a skipped harness is listed here rather than left implicit.
  if (verification !== null && typeof verification === 'object' && !Array.isArray(verification)) {
    const className = typeof verification.class === 'string' ? verification.class : '(unresolved)'
    const depth = Number.isInteger(verification.depth) ? verification.depth : null
    lines.push('## Verification depth this work was classified under', '')
    lines.push(
      `class "${className}", depth ${depth ?? 'unresolved'}${
        typeof verification.depthLabel === 'string' ? ` (${verification.depthLabel})` : ''
      }.`,
    )
    const skipped = Array.isArray(verification.skipped) ? verification.skipped : []
    lines.push(
      skipped.length > 0
        ? `Deliberately skipped at this depth: ${skipped.join('; ')}.`
        : 'Nothing was deliberately skipped at this depth.',
    )
    if (verification.refused === true) {
      lines.push(
        `THE AUTHOR'S CLASS WAS REFUSED as contradicted by the change itself: ${
          typeof verification.refusal === 'string' ? verification.refusal : 'no reason recorded'
        }. Treat the class above as the one that applies, not the one that was claimed.`,
      )
    }
    lines.push(
      'Judge the work at the depth it was actually given. If the class is too shallow for what the',
      'diff does, say so as an issue and cite the dimension it damages — that is a finding about the',
      'process, and it is in scope.',
      '',
    )
  }

  lines.push('## What is claimed', '', feature ? String(feature) : '(no description supplied)', '')

  if (acceptance.length) {
    lines.push('## Acceptance criteria the work claims to meet', '')
    for (const item of acceptance) lines.push(`- ${item}`)
    lines.push('')
  }

  if (changedFiles.length) {
    lines.push('## Files the author says changed', '')
    for (const file of changedFiles) lines.push(`- ${file}`)
    lines.push('')
  }

  if (diff) {
    lines.push('## Diff as reported by the author', '', '```diff', String(diff).slice(0, 60000), '```', '')
  }

  if (sensors.length) {
    lines.push('## Computational checks the author says passed', '')
    for (const sensor of sensors) {
      lines.push(`- ${sensor.type ?? 'check'}: ${sensor.ok === false ? 'FAILED' : 'passed'}${sensor.detail ? ` — ${sensor.detail}` : ''}`)
    }
    lines.push('')
  }

  lines.push(
    '## How to work',
    '',
    workspaceDir ? `The project is at: ${workspaceDir}` : 'The project is the current working directory.',
    '',
    '1. READ THE ACTUAL FILES. The diff above may be incomplete or wrong.',
    '2. RUN THE PROJECT\u2019S OWN CHECKS where they exist (tests, typecheck, build). Quote the real output.',
    '3. TRY TO FALSIFY. Look for the case the author did not consider, the boundary, the error path.',
    '4. Do not fix anything. Report only.',
    '5. If you cannot verify a claim, say so. Silence is not a pass.',
    '',
    '## Scoring',
    '',
    `Score each dimension 0-10. A dimension is a PASS at ${bar} or above.`,
    '',
  )
  for (const dimension of dimensions) {
    lines.push(`- ${dimension}${mustPass.includes(dimension) ? '  ** veto — below the bar fails the review outright **' : ''}`)
  }
  lines.push(
    '',
    `These dimensions veto a pass: ${mustPass.join(', ')}. A high average cannot compensate for a`,
    'failed veto dimension.',
    '',
    `This is review round ${round} of at most ${maxRounds}. If earlier defects were reported and`,
    'are still present, say so explicitly rather than re-describing them loosely.',
    '',
    'Report every defect with its exact location (file and line, or the failing command) and the',
    'smallest fix. An issue whose location is vague cannot be acted on and will be discounted.',
    '',
    '## Reachability — READ THIS BEFORE SCORING',
    '',
    'Every issue must declare `reachable` and explain `reach`.',
    '',
    '- `reachable: true` means you can name a concrete sequence of user or tool actions that hits the',
    '  defect in NORMAL operation: the tool call, the configuration that must be set, the input that',
    '  must be supplied.',
    '- A shape that only a hand-written payload, a synthetic object, or a hostile caller could produce',
    '  is `reachable: false`. So is anything whose only trigger is a service that never returns.',
    '- **Only a reachable defect may lower a veto dimension below the bar, or block delivery.**',
    '- Unreachable findings still belong in the report: list them under `observations`, or as issues',
    '  with `reachable: false`. They are recorded and shown to the human. They do not fail the work.',
    '',
    'This is not a loophole and it is not leniency. Failing a round over a defect no call sequence',
    'reaches costs the budget that would have found the next real one, and this project has real ones',
    'to find. Judge what the code does when people use it.',
    '',
    'Do not manufacture severity to be taken seriously. A review that reports only unreachable',
    'problems as blockers is a failed review, not a rigorous one.',
  )

  return lines.join('\n')
}

/**
 * Recompute an overall score from per-dimension values.
 *
 * @param entries - `[{ dimension, score }]`.
 * @returns the mean over scored dimensions, or undefined when nothing was scored.
 */
export function aggregateScore(entries) {
  const scores = entries
    .map(entry => Number(entry?.score))
    .filter(score => Number.isFinite(score))
  if (scores.length === 0) return undefined
  return scores.reduce((sum, score) => sum + score, 0) / scores.length
}

/**
 * Decide whether one review result passes.
 *
 * The verdict is computed here, never read from the child, so an inflated headline
 * score cannot override a failed veto dimension.
 *
 * DUPLICATE DIMENSIONS ARE A BYPASS, AND ARE HANDLED AS SUCH.
 * An earlier version filled `byDimension` with `Map.set`, so the LAST entry won while
 * `aggregateScore` averaged EVERY entry. A payload of
 * `[{correctness: 3}, ...six 10s..., {correctness: 10}]` therefore reported
 * `passed: true, overall: 9.13` while correctness had been scored 3 — exactly the
 * "inflated headline overrides a failed veto" outcome this function exists to
 * prevent. Two independent defences now apply:
 *
 *  1. the map keeps the LOWEST score for each dimension, so a later optimistic
 *     repeat cannot erase an earlier pessimistic one; and
 *  2. a repeated dimension is reported as a defect in its own right, because a
 *     self-contradicting payload is not evidence of anything.
 *
 * The overall score is then recomputed from the deduplicated map, so the same score
 * drives both the mean and the veto.
 *
 * @param result - normalised review result.
 * @param options - the gate.
 * @returns the verdict with the reason it was reached.
 */
export function decideVerdict(result, options) {
  const { bar = 8, mustPass = DEFAULT_MUST_PASS, dimensions = DEFAULT_DIMENSIONS } = options

  // This is an exported entry point, so it must fail closed on its own terms rather
  // than relying on `runReview` to have validated the gate first. The rule itself lives
  // in lib/gate.js so this check cannot drift from the one the writer and the panel use.
  const usableBar = checkBar(bar ?? 8)
  if (!usableBar.ok) {
    return {
      passed: false,
      overall: null,
      bar: null,
      failedVeto: [],
      missing: [],
      duplicates: [],
      blockers: 0,
      reason: `the bar is unusable (${describeValue(bar)}): ${usableBar.detail}; a gate that cannot be evaluated fails closed`,
    }
  }
  const effectiveBar = usableBar.value

  // The list rules come from lib/gate.js too. This function previously re-derived them
  // (`Array.isArray(x) ? x : DEFAULT`), which silently normalised a non-array AND an
  // empty array to the defaults — so `mustPass: 'correctness'`, `{}`, `42`, `true` and
  // `[]` all produced `passed: true` here while `readEvaluatorGate` refuses every one of
  // them. That is the exact "silent normalisation" class this round set out to remove,
  // and it was sitting on one of the four surfaces claimed to route through the shared
  // validator. An undefined/null list still takes the defaults, which is the documented
  // "unset" meaning.
  //
  // `allowEmpty` MUST match `readEvaluatorGate`, and it did not: that function passes
  // `{ allowEmpty: true }` for `mustPass` while this call omitted it, so a project whose
  // `.dsh/workflow.yml` says `mustPass: []` — schema-legal, blessed by `configWarnings`,
  // and reported healthy by `workflow_status` — failed EVERY review with the reason "an
  // empty list, so no dimension would ever be scored" (which is also the wrong
  // explanation for this list: an empty veto set scores everything and vetoes nothing).
  // Two call sites of one function disagreeing about one question is exactly the drift
  // this module exists to prevent, so the option is now explicit on both sides and pinned
  // by a test that goes through `runReview`, not just the warning helper.
  const vetoList = readStringList('evaluator.mustPass', mustPass, DEFAULT_MUST_PASS, {
    allowEmpty: true,
  })
  const allList = readStringList('evaluator.dimensions', dimensions, DEFAULT_DIMENSIONS)

  if (!vetoList.ok || !allList.ok) {
    return {
      passed: false,
      overall: null,
      bar: null,
      failedVeto: [],
      missing: [],
      duplicates: [],
      blockers: 0,
      reason:
        `the dimension lists are unusable (${[vetoList, allList].filter(r => !r.ok).map(r => r.detail).join('; ')}); ` +
        'a gate that cannot be evaluated fails closed',
    }
  }

  const vetoDimensions = vetoList.value
  const allDimensions = allList.value

  // Tolerant by design: this is an exported entry point, so it must not throw
  // "object is not iterable" on a caller that passes a non-array. `runReview` always
  // normalises first, but the guard keeps the function safe on its own terms.
  const entries = Array.isArray(result?.perDimension) ? result.perDimension : []
  const issueList = Array.isArray(result?.issues) ? result.issues : []

  const canonical = []
  const duplicates = new Set()
  const byDimension = new Map()
  for (const entry of entries) {
    if (typeof entry?.dimension !== 'string') continue
    const previous = byDimension.get(entry.dimension)
    if (previous === undefined) {
      byDimension.set(entry.dimension, entry)
      canonical.push(entry)
      continue
    }
    duplicates.add(entry.dimension)
    // Keep the pessimistic reading: a repeat must not raise a dimension's score.
    const previousScore = Number(previous?.score)
    const nextScore = Number(entry?.score)
    const worse =
      !Number.isFinite(nextScore) ? entry : !Number.isFinite(previousScore) ? previous : nextScore < previousScore ? entry : previous
    byDimension.set(entry.dimension, worse)
    const index = canonical.findIndex(candidate => candidate?.dimension === entry.dimension)
    if (index !== -1) canonical[index] = worse
  }

  const missing = allDimensions.filter(dimension => !byDimension.has(dimension))
  const failedVeto = vetoDimensions.filter(dimension => {
    const score = Number(byDimension.get(dimension)?.score)
    return !Number.isFinite(score) || score < effectiveBar
  })

  // THE MEAN IS COMPUTED OVER THE DECLARED DIMENSIONS ONLY.
  //
  // Deduplicating (above) stopped a repeated dimension from padding the mean. It did not
  // stop the reviewer from INVENTING new ones: a live review reported an eighth dimension
  // (`reviewProcess`) that the configuration never asked for, and `aggregateScore` averaged
  // it in. That is the same bypass by another route — measured, a review whose seven
  // DECLARED dimensions all scored 7 (below the bar of 8) becomes `passed: true` with
  // `overall 8.09` once four undeclared dimensions are supplied at 10.
  //
  // So the score is always the mean of what the configuration asked to measure, which also
  // makes two reviews of the same project comparable. Undeclared dimensions are kept and
  // reported, because they may be informative — they simply cannot move the verdict.
  const scored = canonical.filter(entry => allDimensions.includes(entry.dimension))
  const extraDimensions = canonical
    .filter(entry => !allDimensions.includes(entry.dimension))
    .map(entry => entry.dimension)

  const overall = aggregateScore(scored)

  // REACHABILITY GATES THE BLOCKING COUNT, AND THAT IS WHAT MAKES THE LOOP TERMINATE.
  //
  // Before this, `blockers` counted every `severity: 'blocker'` issue and a below-bar veto
  // dimension failed the round — both judged entirely by the reviewer. Since there is always
  // one more shape a hand-written payload can take, a live loop spent three rounds on
  // findings the reviewer itself labelled "not reachable from the plugin's own code paths".
  // Those are worth recording; they are not worth failing the work over.
  //
  // So: only a REACHABLE blocker blocks, and only reachable defects can hold a veto
  // dimension below the bar. Unreachable findings stay in the report, visible to the human,
  // unable to spend another review round.
  const reachable = issueList.filter(issue => issue?.reachable === true)
  const unreachable = issueList.filter(issue => issue?.reachable !== true)
  const reachableBlockers = reachable.filter(issue => issue?.severity === 'blocker')
  const reachableMajors = reachable.filter(issue => issue?.severity === 'major')

  // A veto dimension below the bar must be EXPLAINED, and the explanation must be reachable.
  //
  // Three cases, and only the middle one is allowed not to block:
  //
  //  1. No issue explains the low score at all — the reviewer asserted a bad rating without
  //     citing a cause. That blocks. Otherwise `correctness: 3` with an empty issue list
  //     would PASS, which is a fail-open far worse than the non-convergence this change
  //     removes: a rating is not evidence.
  //  2. Issues cite the dimension but every one is explicitly unreachable. That does NOT
  //     block, and is the whole point of the change: the reviewer has told us the defect
  //     cannot be hit in normal operation, so spending another round on it is waste. The
  //     finding stays visible in the report.
  //  3. At least one REACHABLE issue cites the dimension. That blocks, as it always did.
  const unexplainedVeto = failedVeto.filter(
    dimension => !issueList.some(issue => issue?.dimension === dimension),
  )
  const reachableVeto = failedVeto.filter(dimension =>
    reachable.some(issue => issue?.dimension === dimension),
  )
  const unreachableOnlyVeto = failedVeto.filter(
    dimension =>
      !unexplainedVeto.includes(dimension) && !reachableVeto.includes(dimension),
  )

  const reasons = []
  if (duplicates.size) {
    reasons.push(
      `dimension(s) scored more than once, which is not a valid review: ${[...duplicates].join(', ')}`,
    )
  }
  if (overall === undefined) reasons.push('the reviewer scored no dimensions')
  else if (overall < effectiveBar) {
    reasons.push(`overall ${round2(overall)} is below the bar of ${effectiveBar}`)
  }
  if (reachableVeto.length) {
    reasons.push(
      `veto dimension(s) below ${effectiveBar}, with a reachable defect behind it: ${reachableVeto.join(', ')}`,
    )
  }
  if (unexplainedVeto.length) {
    reasons.push(
      `veto dimension(s) below ${effectiveBar} with no issue explaining the score: ` +
        `${unexplainedVeto.join(', ')} — a rating with no cited cause is not evidence`,
    )
  }
  if (missing.length) reasons.push(`dimension(s) never scored: ${missing.join(', ')}`)
  if (reachableBlockers.length) {
    reasons.push(`${reachableBlockers.length} reachable blocker issue(s) reported`)
  }

  return {
    passed: reasons.length === 0,
    overall: overall === undefined ? null : round2(overall),
    bar: effectiveBar,
    // Only the evidenced ones gate the verdict; the rest are reported below.
    failedVeto: [...reachableVeto, ...unexplainedVeto],
    unjustifiedVeto: unreachableOnlyVeto,
    unexplainedVeto,
    missing,
    duplicates: [...duplicates],
    reachableIssues: reachable.length,
    unreachableIssues: unreachable.length,
    reachableBlockers: reachableBlockers.length,
    reachableMajors: reachableMajors.length,
    // Reported, never averaged: they cannot move the verdict.
    extraDimensions,
    reason:
      reasons.length === 0
        ? unreachableOnlyVeto.length
          ? `every reachable dimension is at or above ${effectiveBar}; ` +
            `${unreachableOnlyVeto.join(', ')} scored below it, but the reviewer marked every cited ` +
            'defect unreachable, so it does not block (see the reported findings)'
          : `every dimension is at or above ${effectiveBar}`
        : reasons.join('; '),
  }
}

/** Round to two decimals for a stable, readable report. */
function round2(value) {
  return Math.round(value * 100) / 100
}

/**
 * Normalise a child's structured output into the review shape.
 *
 * A child that ignores the schema must not be silently accepted, so anything
 * unparseable is reported as a failed review with the raw text attached.
 *
 * @param result - the run's terminal result.
 * @returns the normalised review.
 */
export function normaliseReview(result) {
  const structured =
    result?.structured ??
    (() => {
      const text = (result?.output ?? [])
        .filter(block => block?.type === 'text')
        .map(block => block.text)
        .join('')
        .trim()
      if (!text) return undefined
      try {
        return JSON.parse(text)
      } catch {
        return undefined
      }
    })()

  if (structured === undefined || structured === null || typeof structured !== 'object') {
    return {
      parsed: false,
      perDimension: [],
      issues: [],
      verified: [],
      recommendation: '',
      raw: (result?.output ?? []).filter(block => block?.type === 'text').map(block => block.text).join('').slice(0, 4000),
    }
  }

  const perDimension = Array.isArray(structured.perDimension)
    ? structured.perDimension.map(entry => ({
        dimension: String(entry?.dimension ?? ''),
        score: Number(entry?.score),
        rationale: String(entry?.rationale ?? ''),
      }))
    : []

  const issues = Array.isArray(structured.issues)
    ? structured.issues.map(issue => ({
        where: String(issue?.where ?? ''),
        what: String(issue?.what ?? ''),
        fix: String(issue?.fix ?? ''),
        severity: ['blocker', 'major', 'minor'].includes(issue?.severity) ? issue.severity : 'major',
        dimension: typeof issue?.dimension === 'string' ? issue.dimension : '',
        // Reachability is defaulted to FALSE when the reviewer does not state it, which is
        // the safe direction: an unstated claim cannot be used to fail the work, and the
        // report still shows the finding. A reviewer that wants it to count says so.
        reachable: issue?.reachable === true,
        reach: String(issue?.reach ?? ''),
      }))
    : []

  return {
    parsed: true,
    perDimension,
    issues,
    verified: Array.isArray(structured.verified) ? structured.verified.map(String) : [],
    observations: Array.isArray(structured.observations) ? structured.observations.map(String) : [],
    recommendation: String(structured.recommendation ?? ''),
    raw: '',
  }
}

/**
 * Run one independent review.
 *
 * @param options - services, the claim under review, and the gate.
 * @returns the verdict, the reviewer's findings, and diagnostics.
 */
export async function runReview(options) {
  const {
    subagents,
    provider = 'spawn',
    parent,
    signal,
    config = {},
    maxDepth = DEFAULT_MAX_DEPTH,
    // A review is a real subagent run, so the default is generous; it exists to stop
    // a hung child from pinning the tool forever. Overridable so the timeout path can
    // actually be tested.
    timeoutMs = 30 * 60 * 1000,
    // Bounded separately: a hung `dispose()` must not re-hang the tool after the
    // verdict was already decided.
    disposeTimeoutMs = 10 * 1000,
    ...review
  } = options

  // THE WHOLE GATE IS READ THROUGH ONE SHARED VALIDATOR (lib/gate.js).
  //
  // Every fail-open this codebase has been bitten by came from a surface implementing
  // its own version of "is this value usable": `bar: abc` (NaN comparisons are always
  // false), `Number()` coercion accepting `''`/`[]`/`true`, `mustPass` entries filtered
  // instead of refused, and a settings panel coercing a cleared input to `bar: 0`.
  // Four independent review rounds found four spellings of one defect. The durable fix
  // is for the gate, the writer and the panel to ask the same question, so a value the
  // gate rejects can never be written and a value the writer accepts can never fail
  // open. This call site owns no validation rule of its own, deliberately.
  const gate = readEvaluatorGate(
    {
      bar: config.bar ?? review.bar,
      maxRounds: config.maxRounds ?? review.maxRounds,
      dimensions: config.dimensions,
      mustPass: config.mustPass,
    },
    {
      bar: 8,
      maxRounds: 3,
      dimensions: DEFAULT_DIMENSIONS,
      mustPass: DEFAULT_MUST_PASS,
    },
  )

  if (!gate.ok) {
    return {
      ok: false,
      passed: false,
      status: 'misconfigured',
      reason:
        `the review gate is unusable, so no review runs: ${gate.problems.join('; ')}. ` +
        'A gate that cannot be evaluated is refused rather than treated as "everything passes".',
      detail: '',
      review: null,
      verdict: null,
    }
  }

  const { bar, maxRounds, dimensions, mustPass } = gate

  const round = Number(review.round ?? 1)

  const refusal = (reason, detail = '') => ({
    ok: false,
    passed: false,
    status: 'unavailable',
    reason,
    detail,
    review: null,
    verdict: null,
  })

  if (!subagents || typeof subagents.start !== 'function') {
    return refusal('the subagents service is unavailable, so no independent review can run')
  }
  if (!parent) {
    return refusal('no calling agent (exec.agent) was available, so a reviewer cannot be started')
  }
  if (round > maxRounds) {
    return {
      ok: false,
      passed: false,
      status: 'exhausted',
      reason: `review budget exhausted: round ${round} exceeds evaluator.maxRounds (${maxRounds})`,
      detail: 'The work did not reach the bar within the configured number of reviews.',
      review: null,
      verdict: null,
    }
  }

  const prompt = buildReviewPrompt({ ...review, dimensions, mustPass, bar, maxRounds, round })

  const request = {
    label: `independent review: ${String(review.feature ?? 'work item').slice(0, 80)}`,
    prompt: [{ type: 'text', text: prompt }],
    parent,
    outputSchema: REVIEW_OUTPUT_SCHEMA,
    ...maxDepth === undefined ? {} : { maxDepth },
    ...signal === undefined ? {} : { signal },
  }

  // BOTH `start()` AND `result` ARE RACED AGAINST THE SAME BUDGET.
  //
  // Bounding only `result` left the exact path the acceptance criteria named open: a
  // `start()` that never settles hung `runReview` forever, because the timer used to
  // be armed after `start` resolved. A provider that accepts the request and then
  // stalls is a realistic failure, so the budget has to cover the whole operation.
  //
  // The timer is cleared on every exit so it cannot keep the process alive, and the
  // two races share one handle so exactly one timer exists per review.
  let run
  let terminal
  let timedOut = false
  let timer
  const budget = new Promise((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true
      reject(new Error(`the review did not settle within ${timeoutMs}ms`))
    }, timeoutMs)
    // Deliberately NOT unref'd: an unref'd timer only fires while some other handle
    // keeps the loop alive, so in an otherwise idle process the run would be abandoned
    // by process exit instead of by this timeout — a weaker guarantee than the one this
    // function claims. The handle is cleared on every exit path.
  })

  try {
    try {
      run = await Promise.race([subagents.start(provider, request), budget])
    } catch (error) {
      if (timedOut) {
        return {
          ok: false,
          passed: false,
          status: 'incomplete',
          reason: `the reviewer did not start within ${timeoutMs}ms`,
          detail: String(error?.message ?? error),
          review: null,
          verdict: null,
        }
      }
      // A provider that cannot honour `outputSchema` fails LOUDLY here rather than
      // silently returning prose, which is the behaviour worth surfacing verbatim.
      return refusal(
        `could not start the reviewer on provider "${provider}"`,
        `${error?.code ? `${error.code}: ` : ''}${error?.message ?? error}`,
      )
    }

    // A `start()` that lost the race never produced a run to dispose.
    if (run === undefined || run === null) {
      return refusal('the reviewer started but returned no run handle')
    }

    terminal = await Promise.race([run.result, budget])
  } catch (error) {
    if (timedOut) {
      return {
        ok: false,
        passed: false,
        status: 'incomplete',
        reason: `the reviewer did not settle within ${timeoutMs}ms and was abandoned`,
        detail: String(error?.message ?? error),
        review: null,
        verdict: null,
      }
    }
    return refusal('the reviewer failed before producing a result', String(error?.message ?? error))
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    // Disposal is mandatory, but it must be BOUNDED. Awaiting it directly defeated the
    // timeout above: a `dispose()` whose promise never settles hung `runReview`
    // forever, so the mechanism added to stop a hung child was undone by its own
    // cleanup (measured: still pending 800ms after a 50ms timeout fired). The child is
    // released as far as the runtime allows either way; this only stops the tool from
    // waiting on it indefinitely.
    //
    // The timer is CLEARED once the race settles. Leaving it armed kept the event loop
    // alive for `disposeTimeoutMs` on every review — a review that resolved in 1ms held
    // its process open for 10s, and the test suite's own reported duration was 10.1s
    // for under 100ms of assertions.
    let disposeTimer
    try {
      await Promise.race([
        Promise.resolve(run?.dispose?.()),
        new Promise(resolve => {
          disposeTimer = setTimeout(resolve, disposeTimeoutMs)
        }),
      ])
    } catch (error) {
      console.error(`[dsh-workflow] reviewer disposal failed: ${String(error?.message ?? error)}`)
    } finally {
      if (disposeTimer !== undefined) clearTimeout(disposeTimer)
    }
  }

  const stopReason = terminal?.stopReason
  if (stopReason !== 'completed') {
    return {
      ok: false,
      passed: false,
      status: 'incomplete',
      reason: `the reviewer did not complete (stopReason: ${String(stopReason ?? 'unknown')})`,
      detail: terminal?.diagnostic ? String(terminal.diagnostic) : '',
      review: null,
      verdict: null,
    }
  }

  const normalised = normaliseReview(terminal)
  const verdict = decideVerdict(normalised, { bar, mustPass, dimensions })

  return {
    ok: true,
    status: 'reviewed',
    passed: verdict.passed,
    round,
    maxRounds,
    verdict,
    review: normalised,
    reason: normalised.parsed
      ? verdict.reason
      : 'the reviewer did not return the required JSON, so its findings cannot be trusted as a pass',
  }
}

/**
 * Whether a value is an object with at least one own key.
 *
 * An empty object `{}` must NOT pass a shape guard: it is truthy and `typeof` is
 * `'object'`, yet reading anything from it yields `undefined`. A truthiness-only
 * check therefore let `{ status: 'reviewed', verdict: {}, review: {} }` reach code
 * that dereferences `verdict.overall`.
 *
 * @param value - the value to test.
 * @returns true for a non-empty plain-ish object.
 */
function isNonEmptyObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length > 0
}

/**
 * Render a review as text for the tool result.
 *
 * THE GUARD IS SHAPE-BASED, NOT A STATUS LIST. An earlier version enumerated the
 * statuses it knew about (`unavailable`/`incomplete`/`exhausted`) and fell through
 * to code that reads `verdict.overall`. Every status added later — `not-enabled`,
 * `disabled`, `misconfigured` — therefore THREW `TypeError: Cannot read properties
 * of undefined (reading 'overall')`. The host converts a throwing `render` into an
 * opaque projection error, so the model saw no refusal text at all on the module's
 * most common refusal path. Enumerating statuses cannot be made safe by being
 * careful; the check has to be "did a graded review actually happen".
 *
 * @param outcome - what {@link runReview} returned.
 * @returns a human-readable report.
 */
export function renderReview(outcome) {
  const out = []

  // The guard covers EVERY field the body dereferences, INCLUDING ARRAY ELEMENTS.
  //
  // This comment previously claimed "no outcome shape can throw" while the loops below
  // read `entry.dimension` and `issue.severity`: `perDimension: [null]` threw
  // "Cannot read properties of null (reading 'dimension')". Checking that a value IS an
  // array says nothing about its elements, so element shape is asserted too. A guard
  // whose claim outruns its checks is worse than no guard, because readers stop looking.
  const allObjects = list => Array.isArray(list) && list.every(item => isNonEmptyObject(item))

  const renderable =
    outcome?.status === 'reviewed' &&
    isNonEmptyObject(outcome.verdict) &&
    isNonEmptyObject(outcome.review) &&
    Array.isArray(outcome.verdict.failedVeto) &&
    allObjects(outcome.review.perDimension) &&
    allObjects(outcome.review.issues) &&
    Array.isArray(outcome.review.verified)

  if (!renderable) {
    out.push(`independent review did not run: ${outcome?.reason ?? 'no reason was recorded'}`)
    if (outcome?.detail) out.push(outcome.detail)
    if (outcome?.status && outcome.status !== 'reviewed') out.push(`(status: ${outcome.status})`)
    // THE DEPTH DECISION IS PRINTED ON THE REFUSAL PATH TOO — that is where it matters most. A
    // review that did not run because the class was refused, or because no human confirmed the
    // depth, is exactly the outcome a reader has to be able to reconstruct afterwards.
    for (const line of renderVerificationAudit(outcome?.verification)) out.push(line)
    return out.join('\n')
  }

  const { verdict, review } = outcome
  out.push(
    `${outcome.passed ? 'PASS' : 'FAIL'} — independent review round ${outcome.round}/${outcome.maxRounds}`,
  )
  out.push(`overall ${verdict.overall ?? 'n/a'} (bar ${verdict.bar}); ${verdict.reason}`)

  if (review.perDimension.length) {
    out.push('', 'dimensions:')
    for (const entry of review.perDimension) {
      const veto = verdict.failedVeto.includes(entry.dimension) ? '  <-- VETO FAILED' : ''
      out.push(`  ${entry.dimension}: ${entry.score}${veto}`)
      if (entry.rationale) out.push(`      ${entry.rationale}`)
    }
  }

  if (!review.parsed) {
    out.push('', 'the reviewer did not return structured JSON; its raw reply follows:', review.raw)
  }

  if (review.issues.length) {
    // Reachability is printed for every issue, because it is what decided the verdict. A
    // human reading a PASS needs to see which findings the gate declined to block on, and a
    // human reading a FAIL needs to see that the blocking ones are actually reachable.
    out.push('', `issues (${review.issues.length}):`)
    for (const issue of review.issues) {
      const reach = issue.reachable ? 'reachable' : 'UNREACHABLE — recorded, does not block'
      out.push(`  [${issue.severity}]${issue.dimension ? ` (${issue.dimension})` : ''} ${issue.where} — ${reach}`)
      out.push(`      what: ${issue.what}`)
      out.push(`      fix:  ${issue.fix}`)
      if (issue.reach) out.push(`      reach: ${issue.reach}`)
    }
  }

  if (review.observations?.length) {
    out.push('', `observations (${review.observations.length}, none of which affect the verdict):`)
    for (const observation of review.observations) out.push(`  - ${observation}`)
  }

  if (verdict.unjustifiedVeto?.length) {
    out.push(
      '',
      `note: ${verdict.unjustifiedVeto.join(', ')} scored below the bar, but every cited defect was ` +
        'marked unreachable, so it did not block. Re-score it if a real call sequence does reach one.',
    )
  }
  if (verdict.unexplainedVeto?.length) {
    out.push(
      '',
      `note: ${verdict.unexplainedVeto.join(', ')} scored below the bar with no issue citing it, which ` +
        'blocked the review. A rating without a cited cause cannot be acted on — cite the defect.',
    )
  }

  if (review.verified.length) {
    out.push('', 'the reviewer says it verified:', ...review.verified.map(item => `  - ${item}`))
  }

  if (outcome.passed) {
    out.push('', 'The reviewer could not find a defect that blocks delivery.')
  } else {
    out.push('', 'Address the issues above, then run workflow_review again with round incremented.')
  }

  // WHAT LEVEL OF VERIFICATION THIS VERDICT WAS REACHED UNDER, at the end of the report where a
  // reader who has just seen the verdict will look for it.
  for (const line of renderVerificationAudit(outcome.verification)) out.push('', line)

  return out.join('\n')
}

// ---------------------------------------------------------------------------
// risk-based verification depth: which harness covers which file
// ---------------------------------------------------------------------------
//
// WHY THE MAPPING IS READ FROM THE HARNESSES THEMSELVES
//
// "ordinary logic = unit + the harnesses covering the touched files" is only a policy if
// something knows what covers what. A hand-written table in this module would be a second
// source of truth about tools that already declare their own targets, and it would rot in the
// silent direction: a harness renamed or re-pointed would keep its old entry, so the policy
// would keep recommending a harness that no longer covers the file — recommending LESS work
// while looking exactly as confident.
//
// So each harness's target file is READ from its own `file:` / `FILE` / `CLIENT` declaration,
// and a harness whose target cannot be read is reported as unmapped rather than guessed at.
// The two consequences are deliberate:
//
//  - a harness added later is picked up with no edit here, and
//  - a harness whose shape this reader does not understand shows up as `unmapped`, which
//    `workflow_status` prints, instead of vanishing from the plan.

/** Harnesses that verify the mutation lock itself, not a file. Never a coverage answer. */
const META_HARNESSES = Object.freeze(['mutation-check-lock-probe.mjs'])

/**
 * A path this reader found inside a harness's source, as it writes it.
 *
 * The forms that actually appear in `tooling/`: `file: 'lib/x.js'` (the original harness),
 * `` const FILE = `${ROOT}/lib/client.js` `` and `` const CLIENT = `${ROOT}lib/client.js` ``.
 * The pattern requires a `lib/…​.js` or `tooling/…​.js` tail, so a fixture path mentioned in a
 * string does not become a target by accident.
 */
const HARNESS_TARGET_PATTERN =
  /(?:file|FILE|CLIENT|target|TARGET)\s*[:=]\s*[`'"](?:[^`'"]*?)((?:lib|tooling)\/[A-Za-z0-9_./-]+\.(?:m?js|cjs|json|ya?ml))[`'"]/g

/**
 * Where `tooling/` lives, derived from this module's own location.
 *
 * Derived rather than taken from configuration, for the same reason the exemption anchor in
 * `lib/approval.js` is: there is no configurable path that could point somewhere wider, so a
 * wrong answer cannot silently widen what the policy reads.
 */
function toolingDir() {
  return join(dirname(fileURLToPath(import.meta.url)), '..', 'tooling')
}

/**
 * Read each mutation harness's target file from the harness itself.
 *
 * @param options - `{ tooling }` to override the directory (tests).
 * @returns `{ harnesses, unmapped }`, both arrays of names; the coverage maps live inside.
 */
export function discoverMutationHarnesses(options = {}) {
  const dir = typeof options.tooling === 'string' && options.tooling !== '' ? options.tooling : toolingDir()
  const harnesses = []
  const unmapped = []

  let names
  try {
    names = readdirSync(dir).filter(name => /^mutation-check-.*\.mjs$/.test(name)).sort()
  } catch (error) {
    // AN UNREADABLE TOOLING DIRECTORY IS REPORTED, NEVER READ AS "NOTHING COVERS THIS". The
    // difference matters: "no harness covers these files" would be a reason to skip the
    // harness step, and the honest statement is "this check could not run".
    return {
      harnesses,
      unmapped: [`the tooling directory could not be read (${safeErrorText(error)})`],
      unreadable: true,
    }
  }

  for (const name of names) {
    if (META_HARNESSES.includes(name)) {
      unmapped.push(`${name} (a lock probe, not a coverage harness)`)
      continue
    }
    let source
    try {
      source = readFileSync(join(dir, name), 'utf8')
    } catch (error) {
      unmapped.push(`${name} (unreadable: ${safeErrorText(error)})`)
      continue
    }
    const targets = []
    HARNESS_TARGET_PATTERN.lastIndex = 0
    let match
    while ((match = HARNESS_TARGET_PATTERN.exec(source)) !== null) {
      const path = normalisePath(match[1])
      if (path !== null && !targets.includes(path)) targets.push(path)
    }
    if (targets.length === 0) {
      unmapped.push(`${name} (no target file is declared in a form this reader understands)`)
      continue
    }
    harnesses.push({ name, path: join(dir, name), targets })
  }

  return { harnesses, unmapped, unreadable: false }
}

/** A safe one-line rendering of an error. */
function safeErrorText(error) {
  try {
    return String(error?.message ?? error)
  } catch {
    return 'unprintable error'
  }
}

/** Whether a harness covers any of the files, matched by exact path or by basename. */
function harnessCovers(harness, files) {
  const targets = Array.isArray(harness?.targets) ? harness.targets : []
  return files.some(file => {
    const base = file.split('/').pop()
    return targets.some(target => target === file || target.split('/').pop() === base)
  })
}

/**
 * The harnesses that must run, for one resolved depth and one set of files.
 *
 * `atMost` is the class's own rung, so `ui` gets the ONE relevant harness and `logic` gets all
 * of them, with no `if (class === …)` anywhere: the depth IS the rule. The order is the
 * discovery order, which is sorted by name, so the answer is stable across runs.
 *
 * @param options - `{ depth, files }`.
 * @returns `{ required, unmapped, note }`.
 */
export function harnessesForDepth(options = {}) {
  const depth = Number.isInteger(options.depth) ? options.depth : VERIFICATION_DEPTHS.UNIT
  const files = Array.isArray(options.files) ? options.files.filter(file => typeof file === 'string') : []
  const discovered = discoverMutationHarnesses(options)
  const covering = discovered.harnesses.filter(harness => harnessCovers(harness, files))

  if (depth <= VERIFICATION_DEPTHS.UNIT) {
    return {
      required: [],
      covering: covering.map(harness => harness.name),
      unmapped: discovered.unmapped,
      note:
        'depth 0 runs the unit suite only. A mutation harness is NOT implied by this depth; ' +
        'run one only if you have a specific reason to.',
    }
  }

  if (files.length === 0) {
    return {
      required: [],
      covering: [],
      unmapped: discovered.unmapped,
      // FAIL CLOSED, AND SAY SO. With no file list there is nothing to match, and "no harness
      // covers the files you did not list" must not read as permission to skip the step.
      note:
        'no changed files were supplied, so no harness could be selected. Pass changed_files (or a ' +
        'diff) to get the harnesses this depth requires.',
    }
  }

  if (covering.length === 0) {
    return {
      required: [],
      covering: [],
      unmapped: discovered.unmapped,
      note:
        `no mutation harness in tooling/ covers ${files.slice(0, 3).join(', ')}` +
        `${files.length > 3 ? ' and more' : ''}. That is a statement about the repository, not a ` +
        'waiver: independent review is the substitute, so run it.',
    }
  }

  const required = depth === VERIFICATION_DEPTHS.HARNESS
    ? [mostSpecificHarness(covering)]
    : covering
  return {
    required: required.map(harness => harness.name),
    covering: covering.map(harness => harness.name),
    targets: required.map(harness => ({ name: harness.name, targets: [...harness.targets] })),
    unmapped: discovered.unmapped,
    note:
      depth === VERIFICATION_DEPTHS.HARNESS
        ? `depth 1 runs the ONE covering harness whose targets are narrowest (${required[0].name}, ` +
          `${required[0].targets.length} target(s)); ${covering.length - 1} further covering ` +
          'harness(es) were NOT required at this depth.'
        : `depth ${depth} runs every covering harness (${covering.length}).`,
  }
}

/**
 * The covering harness whose targets are the narrowest, so "the one relevant harness" is the
 * one that was written for these files rather than the one that happens to sort first.
 *
 * ALPHABETICAL ORDER WAS WRONG HERE, and the wrongness was measurable: for a `lib/client.js`
 * change the covering set is `{mutation-check-approval, mutation-check-client,
 * mutation-check-panel, mutation-check-project-tab}`, and picking by name selected the
 * approval harness — the broadest of the four, the only one that is not about the browser
 * half at all. Ranking by target count selects `mutation-check-client.mjs`, which is the
 * harness that was written for that file.
 *
 * The tie-break is the harness name, so the answer does not depend on directory order.
 */
function mostSpecificHarness(covering) {
  return [...covering].sort((left, right) => {
    const leftCount = Array.isArray(left.targets) ? left.targets.length : Number.MAX_SAFE_INTEGER
    const rightCount = Array.isArray(right.targets) ? right.targets.length : Number.MAX_SAFE_INTEGER
    if (leftCount !== rightCount) return leftCount - rightCount
    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0
  })[0]
}

/**
 * The audit record for one verification decision.
 *
 * WHAT THIS IS FOR, AND WHAT IT IS NOT. The user's requirement was that a decision be RECORDED
 * so a later reader can see what was deliberately skipped and why. This record is that: it
 * states the class named, the class the evidence supported, the depth actually used, who
 * confirmed it, and — when a class was refused — the exact contradiction. It is an AUDIT TRAIL,
 * not an enforcement: `enforced` is what refuses, and this only makes the outcome legible
 * afterwards. A record that is missing is reported as missing rather than as agreement.
 *
 * @param resolution - what `resolveVerificationDepth` returned.
 * @param extra - `{ policy, confirmation, harnesses, humanCheck, independentReview }`.
 * @returns a JSON-serialisable record.
 */
export function buildVerificationAudit(resolution, extra = {}) {
  const declared = resolution?.declared ?? null
  const derived = resolution?.derived ?? null
  const depth = Number.isInteger(resolution?.depth) ? resolution.depth : null
  const deferred = declared === null && derived === null && resolution?.evidence === 'none'

  const skipped = []
  if (depth !== null) {
    if (depth <= VERIFICATION_DEPTHS.UNIT) skipped.push('every mutation harness')
    if (depth === VERIFICATION_DEPTHS.HARNESS) {
      skipped.push('every covering mutation harness except the one required')
    }
    if (depth < MAX_VERIFICATION_DEPTH) skipped.push('independent review')
  } else {
    skipped.push('the whole policy — no class or depth could be resolved')
  }

  return {
    class: resolution?.resolved ?? null,
    classSource: declared === null ? (derived === null ? 'none' : 'evidence') : 'declaration',
    declaredClass: declared,
    declaredRaw: resolution?.declaredRaw ?? null,
    derivedClass: derived,
    evidence: resolution?.evidence ?? 'none',
    depth,
    depthLabel: resolution?.depthLabel ?? null,
    refused: resolution?.refused === true,
    refusal: resolution?.refusal ?? null,
    files: Array.isArray(resolution?.files) ? resolution.files : [],
    unknownFiles: Array.isArray(resolution?.unknownFiles) ? resolution.unknownFiles : [],
    reasons: Array.isArray(resolution?.reasons) ? resolution.reasons : [],
    uiTouched: resolution?.uiTouched === true,
    uiReasons: Array.isArray(resolution?.uiReasons) ? resolution.uiReasons : [],
    escalated: typeof resolution?.escalated === 'string' ? resolution.escalated : null,
    skipped,
    policy: extra.policy ?? DEFAULT_VERIFICATION.policy,
    // A LABEL, NOT AN OBJECT. This field is rendered as "confirmed by <value>" in two places, so an
    // object here printed `confirmed by [object Object]`, which is a record that says nothing. A
    // confirmation is only ever recorded once it is a real token, so the presence of ANY usable
    // confirmation is what the label reports.
    confirmedBy: isUsableConfirmation(extra.confirmation)
      ? 'user-question'
      : extra.confirmation === undefined || extra.confirmation === null
        ? 'nobody'
        : 'not confirmed',
    requiredHarnesses: Array.isArray(extra.harnesses?.required) ? extra.harnesses.required : [],
    harnessNote: extra.harnesses?.note ?? null,
    humanCheck: extra.humanCheck ?? { required: false, asserted: false, confirmedBy: 'nobody' },    independentReview: extra.independentReview ?? { required: false, ran: false },
    // What the decision means when it is read back by someone who was not there: the shallowest
    // class was NOT used, and here is what was. `deferred` is the honest case where nothing at
    // all was declared or supplied, which is also the case that runs today's behaviour.
    deferred,
  }
}

/**
 * Whether a class requires an independent reviewer child, and whether it requires everything.
 *
 * `required` is what `enforced` refuses on. Under the default `off` policy this is REPORTED and
 * nothing is refused, which is why the reviewer's prompt is told the depth either way.
 */
export function classRequirements(className) {
  const entry = isChangeClass(className) ? CHANGE_CLASSES[className] : null
  return {
    class: entry?.id ?? null,
    humanCheck: entry?.humanCheck === true,
    independentReviewRequired: entry?.independentReview === 'required',
    shallowest: entry?.shallowest ?? MAX_VERIFICATION_DEPTH,
  }
}

/**
 * Render the verification plan for a human or a model, from the audit record.
 *
 * A RENDERER MUST NEVER ASSUME THE SHAPE OF HAND-EDITABLE DATA, and the audit record is
 * assembled from several of them (a class string, a resolution, a harness list). Every field
 * is therefore read through a type check and every line is flattened to ONE line before it is
 * printed: a `changed_files` entry containing a newline would otherwise forge extra lines into
 * a report a model reads as instructions, which is the defect this codebase already fixed once
 * in `renderStatus`.
 *
 * @param audit - the record from {@link buildVerificationAudit}, or anything else.
 * @returns lines to print; empty when there is nothing to say.
 */
export function renderVerificationAudit(audit) {
  if (audit === null || typeof audit !== 'object' || Array.isArray(audit)) return []
  const out = []
  const one = value => String(value).replace(/[\r\n\u2028\u2029]+/g, ' ').slice(0, 400)

  const className = typeof audit.class === 'string' && audit.class !== '' ? audit.class : '(unresolved)'
  const depth = Number.isInteger(audit.depth) ? audit.depth : null
  const label = typeof audit.depthLabel === 'string' && audit.depthLabel !== ''
    ? audit.depthLabel
    : depth === null
      ? 'no depth could be resolved'
      : `depth ${depth}`

  out.push(`verification: class "${one(className)}" at depth ${depth ?? '?'} (${one(label)})`)
  out.push(
    `  how the class was reached: ${one(audit.classSource ?? 'unknown')}` +
      (typeof audit.declaredClass === 'string' ? ` (declared "${one(audit.declaredClass)}")` : '') +
      (typeof audit.derivedClass === 'string' ? ` (evidence implied "${one(audit.derivedClass)}")` : '')
  )
  if (audit.evidence === 'none') {
    out.push(
      typeof audit.escalated === 'string' && audit.escalated !== ''
        ? `  no evidence: ${one(audit.escalated)}`
        : '  no evidence: no changed files and no diff were supplied, so nothing could be derived from ' +
            'the change itself; the declared class stands',
    )
  }
  if (audit.refused === true) {
    out.push(`  CLASS REFUSED — ${one(audit.refusal ?? 'no reason was recorded')}`)
  }
  const files = Array.isArray(audit.files) ? audit.files : []
  if (files.length > 0) out.push(`  files read as evidence: ${files.slice(0, 8).map(one).join(', ')}`)
  const unknown = Array.isArray(audit.unknownFiles) ? audit.unknownFiles : []
  if (unknown.length > 0) {
    out.push(
      `  UNCLASSIFIED source file(s) treated as a security surface: ${unknown.slice(0, 4).map(one).join(', ')}`,
    )
  }
  const harnesses = Array.isArray(audit.requiredHarnesses) ? audit.requiredHarnesses : []
  if (harnesses.length > 0) {
    out.push(`  mutation harnesses required at this depth: ${harnesses.map(one).join(', ')}`)
  } else if (typeof audit.harnessNote === 'string' && audit.harnessNote !== '') {
    out.push(`  mutation harnesses: none required — ${one(audit.harnessNote)}`)
  }
  const human = audit.humanCheck && typeof audit.humanCheck === 'object' ? audit.humanCheck : {}
  if (human.required === true) {
    out.push(
      `  human check REQUIRED (this class cannot be verified by test alone): ` +
        `attested ${human.asserted === true ? 'yes' : 'NO'}, confirmed by ${one(human.confirmedBy ?? 'nobody')}`,
    )
  }
  const independent = audit.independentReview && typeof audit.independentReview === 'object'
    ? audit.independentReview
    : {}
  if (independent.required === true) {
    out.push(
      '  independent review REQUIRED by this class and NOT degradable: the security class may not be ' +
        'declared down to a shallower depth',
    )
  }
  const skipped = Array.isArray(audit.skipped) ? audit.skipped : []
  out.push(
    skipped.length > 0
      ? `  deliberately skipped at this depth: ${skipped.map(one).join('; ')}`
      : '  deliberately skipped at this depth: nothing',
  )
  out.push(`  decided with: policy=${one(audit.policy ?? 'off')}, confirmed by ${one(audit.confirmedBy ?? 'nobody')}`)
  return out
}

/**
 * Whether a value is a confirmation this framework can report as obtained.
 *
 * Deliberately a SHAPE check and not the branded-token check from `lib/config.js`: this module
 * records what happened, and the branch that decides whether a token authorises a depth is the one
 * that consumes it. Reporting "nobody" for a token the plugin minted would be a false record of an
 * interaction that did take place, which is the direction that wastes a user's answer rather than
 * the direction that claims one.
 */
function isUsableConfirmation(value) {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    value.source === 'user-question' &&
    typeof value.questionId === 'string' &&
    value.questionId !== ''
  )
}

/**
 * The depth-appropriate loop, as prompt text for the reviewer and for the operator.
 *
 * The unreduced `renderWorkflowGuidance` in `lib/index.js` used to instruct the full loop
 * unconditionally, which is the cost the user complained about. This function says what THIS
 * change's depth permits, so a model reading it does not have to infer the policy.
 *
 * @param audit - the record from {@link buildVerificationAudit}.
 * @returns one paragraph.
 */
export function renderVerificationGuidance(audit) {
  if (audit === null || typeof audit !== 'object' || Array.isArray(audit)) {
    return 'Verification depth was not resolved for this work, so run the full loop.'
  }
  const className = typeof audit.class === 'string' && audit.class !== '' ? audit.class : '(unresolved)'
  const depth = Number.isInteger(audit.depth) ? audit.depth : null
  const parts = []

  if (depth === null) {
    return (
      'Verification depth could NOT be resolved for this work (no class, no evidence), so the full ' +
      'loop applies: unit suite, every covering mutation harness, and an independent reviewer.'
    )
  }

  parts.push(`This work is class "${className}" at depth ${depth}: ${audit.depthLabel ?? 'unknown depth'}.`)
  if (depth <= VERIFICATION_DEPTHS.UNIT) {
    parts.push('Run the unit suite and nothing else — no mutation harness and no reviewer child is implied.')
  } else if (depth === VERIFICATION_DEPTHS.HARNESS) {
    const names = Array.isArray(audit.requiredHarnesses) ? audit.requiredHarnesses : []
    parts.push(
      names.length > 0
        ? `Run the unit suite and ${names.join(', ')}.`
        : 'Run the unit suite; no mutation harness covers these files.',
    )
  } else if (depth === VERIFICATION_DEPTHS.HARNESSES) {
    const names = Array.isArray(audit.requiredHarnesses) ? audit.requiredHarnesses : []
    parts.push(
      names.length > 0
        ? `Run the unit suite and every covering mutation harness (${names.join(', ')}).`
        : 'Run the unit suite; no mutation harness covers these files, so independent review substitutes.',
    )
  } else {
    parts.push(
      'Run the unit suite, every covering mutation harness, and an independent reviewer child. This ' +
        'class is NOT degradable, and its depth may only be raised.',
    )
  }
  // THE HUMAN CHECK IS STATED SEPARATELY FROM THE DEPTH, because it is not a rung: a `ui`
  // change sits at the same depth as a `logic` change and still needs eyes on it.
  if (audit.humanCheck?.required === true) {
    parts.push(
      'A HUMAN MUST LOOK AT THE RESULT: this change builds rendered output, and no test in this ' +
        'project measures what the screen shows.' +
        (audit.humanCheck.asserted === true
          ? ' The caller attests that this happened.'
          : ' That has NOT been attested, so the work is not verified.'),
    )
  }
  if (audit.refused === true) {
    parts.push(`The declared class was REFUSED: ${audit.refusal ?? 'no reason recorded'}`)
  }
  if (typeof audit.escalated === 'string' && audit.escalated !== '') {
    parts.push(`The depth was raised rather than declared: ${audit.escalated}.`)
  }
  if (audit.evidence === 'none') {
    parts.push(
      'No changed_files or diff was supplied, so this depth is not an evidence-derived one; supply the ' +
        'file list to get a floor that can be checked.',
    )
  }
  return parts.join(' ')
}
