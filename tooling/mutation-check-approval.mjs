/**
 * Throwaway mutation harness for the B3 approval gate.
 *
 * For each mutant: apply a literal source edit, run the suite that is supposed to catch
 * it, record whether it went RED, then restore the file byte-for-byte.
 *
 * Usage: node D:/DSH/P5/.mutate.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { EXIT_LOCK_HELD, MutationLockHeld, withMutationLock } from './mutation-lock.mjs'

// REPO-RELATIVE, NOT THE OLD P5 PATH. The harness was written in one development checkout and
// hardcoded it; running it from any other clone then executed tests in a directory that had no
// `test/` at all and reported the baseline as red. `..` from `tooling/` is the repository root.
const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** Every harness takes this lock, so no two of them can rewrite lib/ at the same time. */
const LABEL = 'tooling/mutation-check-approval.mjs'

const MUTANTS = [
  {
    id: 'M1',
    what: "denyHighAlways: a string is coerced/ignored instead of refused",
    file: 'lib/approval.js',
    find: `  const denyHighAlways = source.denyHighAlways ?? defaults.denyHighAlways
  if (typeof denyHighAlways !== 'boolean') {`,
    replace: `  const denyHighAlways = source.denyHighAlways ?? defaults.denyHighAlways
  if (false) {`,
    suite: 'unit',
    expect: /denyHighAlways/,
  },
  {
    id: 'M2',
    what: 'the fail-closed fallback is made permissive (strength off, denyHighAlways false)',
    file: 'lib/approval.js',
    find: `export const FAIL_CLOSED_APPROVAL = Object.freeze({
  strength: 'ask-user',
  riskThreshold: 'low',
  denyHighAlways: true,`,
    replace: `export const FAIL_CLOSED_APPROVAL = Object.freeze({
  strength: 'off',
  riskThreshold: 'high',
  denyHighAlways: false,`,
    suite: 'unit',
    expect: /fail-closed|narrowest/,
  },
  {
    id: 'M3',
    what: 'a mixed exemptTools list is FILTERED instead of refused',
    file: 'lib/approval.js',
    find: `  const exemptTools = readStringList('approval.exemptTools', source.exemptTools, [...defaults.exemptTools], {
    allowEmpty: true,
  })
  if (!exemptTools.ok) problems.push(exemptTools.detail)`,
    replace: `  const exemptTools = Array.isArray(source.exemptTools)
    ? { ok: true, value: source.exemptTools.filter(item => typeof item === 'string') }
    : readStringList('approval.exemptTools', source.exemptTools, [...defaults.exemptTools], { allowEmpty: true })
  if (!exemptTools.ok) problems.push(exemptTools.detail)`,
    suite: 'unit',
    expect: /NEVER filtered|non-string|malformed exemptTools/,
  },
  {
    id: 'M4',
    what: 'the exempt list is consulted BEFORE provable exfiltration',
    file: 'lib/approval.js',
    find: `  // 1. Provable exfiltration, before every exemption. This is the only rule the guard
  //    needs, so it must not be reachable-around.
  const exfiltration = detectExfiltration(args, name)
  if (exfiltration !== null) return { risk: 'high', reason: exfiltration }

  // 2. The outer PTC transport carries a program, not effects. Its inner calls are
  //    reviewed like any other call.
  if (name === RUN_CODE_NAME && exec?.parent === undefined) {
    return { risk: null, reason: 'the outer run_code transport carries a program, not inspectable effects' }
  }

  // 3. Exemptions and this plugin's own project-local tools.
  const exempt = Array.isArray(gate?.exemptTools) ? gate.exemptTools : []
  if (name && exempt.includes(name)) {
    return { risk: 'low', reason: \`"\${name}" is listed in approval.exemptTools\` }
  }`,
    replace: `  const exempt0 = Array.isArray(gate?.exemptTools) ? gate.exemptTools : []
  if (name && exempt0.includes(name)) {
    return { risk: 'low', reason: \`"\${name}" is listed in approval.exemptTools\` }
  }
  const exfiltration = detectExfiltration(args, name)
  if (exfiltration !== null) return { risk: 'high', reason: exfiltration }

  if (name === RUN_CODE_NAME && exec?.parent === undefined) {
    return { risk: null, reason: 'the outer run_code transport carries a program, not inspectable effects' }
  }

  const exempt = exempt0`,
    suite: 'unit',
    expect: /exemption cannot whitelist|high/,
  },
  {
    id: 'M5',
    what: 'denyHighAlways is dropped, so a high risk passes under off',
    file: 'lib/approval.js',
    find: `  if (risk === 'high' && denyHighAlways === true) return 'deny'
  if (!reachesThreshold(risk, threshold)) return 'pass'`,
    replace: `  if (!reachesThreshold(risk, threshold)) return 'pass'`,
    suite: 'unit',
    expect: /denyHighAlways|high risk/,
  },
  {
    id: 'M6',
    what: 'the guard ignores denyHighAlways, so the escape hatch does not disarm it',
    file: 'lib/approval.js',
    find: `    if (gate.denyHighAlways !== true) return undefined`,
    replace: `    if (false) return undefined`,
    suite: 'unit',
    expect: /escape hatch|denyHighAlways/,
  },
  {
    id: 'M7',
    what: 'containment trusts the lexical path instead of the filesystem identity',
    file: 'lib/approval.js',
    find: `  let realResolved
  let realRoot
  try {
    realRoot = realpathSync.native ? realpathSync.native(root) : realpathSync(root)
    const existing = nearestExisting(resolved)
    if (existing === null) return 'unknown'
    realResolved = realpathSync.native ? realpathSync.native(existing) : realpathSync(existing)
  } catch {
    return 'unknown'
  }
  return textIsInside(realResolved, realRoot) ? 'inside' : 'outside'`,
    replace: `  return 'inside'`,
    suite: 'unit',
    expect: /symlink/,
  },
  {
    id: 'M8',
    what: 'an unclassified call is treated as medium instead of deferred',
    file: 'lib/approval.js',
    find: `  // 7. Nothing observed either way. Defer.
  return { risk: null, reason: 'no argument proves anything about this call' }`,
    replace: `  // 7. Nothing observed either way.
  return { risk: 'medium', reason: 'no argument proves anything about this call' }`,
    suite: 'unit',
    expect: /UNCLASSIFIED|deferred/,
  },
  {
    id: 'M9',
    what: 'a reviewer failure is deferred to the pipeline instead of failing closed',
    file: 'lib/approval.js',
    find: `    if (!review.ok) {
      counters.reviewerFailures += 1
      counters.denied += 1
      return deny(`,
    replace: `    if (!review.ok) {
      counters.reviewerFailures += 1
      return next()
    }
    if (false) {
      counters.denied += 1
      return deny(`,
    suite: 'unit',
    expect: /reviewer FAILURE|fail/i,
  },
  {
    id: 'M10',
    what: 'llm-then-user denies a reviewer rejection instead of handing it to the user',
    file: 'lib/approval.js',
    find: `    if (review.risk === 'high' || gate.strength === 'llm-only') {`,
    replace: `    if (true) {`,
    suite: 'unit',
    expect: /llm-then-user|ask/i,
  },
  {
    id: 'M11',
    what: 'a reason is accepted on an allow response',
    file: 'lib/approval.js',
    find: `  if (decision === 'allow' && !hasReason && (risk === 'low' || risk === 'medium')) return { risk, decision }`,
    replace: `  if (decision === 'allow' && (risk === 'low' || risk === 'medium')) return { risk, decision }`,
    suite: 'unit',
    expect: /protocol/,
  },
  {
    id: 'M12',
    what: 'data after the terminal finish is tolerated',
    file: 'lib/approval.js',
    find: `      if (finished) {
        return { ok: false, error: 'the reviewer emitted data after its terminal finish' }
      }`,
    replace: `      if (false) {
        return { ok: false, error: 'the reviewer emitted data after its terminal finish' }
      }`,
    suite: 'unit',
    expect: /after its terminal finish/,
  },
  {
    id: 'M13',
    what: 'resolveApprovalState passes the project file through with its problems dropped',
    file: 'lib/approval-state.js',
    find: `  const { config, sources, gate } = readApprovalForProject(rowConfig, file, defaults, projectDir)`,
    replace: `  const { config, sources, gate } = readApprovalForProject(rowConfig, { ...file, problems: [] }, defaults, projectDir)`,
    suite: 'unit',
    expect: /unreadable project file|fully read/,
  },
  {
    id: 'M14',
    what: 'the monotonic memory is bypassed, so a direct edit weakens the running gate',
    file: 'lib/approval-state.js',
    find: `    if (previous !== undefined && previous !== null) {
      effective = mergeMonotonicGate(previous, effective)
    }`,
    replace: `    if (false && previous !== undefined) {
      effective = mergeMonotonicGate(previous, effective)
    }`,
    suite: 'unit',
    expect: /weaker file value must be ignored|direct file edit/,
  },
  {
    id: 'M15',
    what: 'the status renderer iterates problems/warnings without checking they are lists',
    file: 'lib/tools.js',
    find: "    const problems = Array.isArray(effectiveConfig.approval.problems) ? effectiveConfig.approval.problems : []\n    for (const problem of problems) out.push(`    ${problem}`)\n  }\n  // A STRENGTH THAT CANNOT BE SATISFIED",
    replace: "    for (const problem of effectiveConfig.approval.problems) out.push(`    ${problem}`)\n  }\n  // A STRENGTH THAT CANNOT BE SATISFIED",
    suite: 'unit',
    expect: /render|malformed|payload/i,
  },
  {
    id: 'M16',
    what: 'the writer stops validating a whole approval section',
    file: 'lib/tools.js',
    find: `  if (path === 'approval') {
    if (value === null) return null // unset
    if (!isPlainObject(value)) {
      return \`approval must be a section (an object), got \${typeof value}\`
    }
    const gate = readApprovalGate(value, DEFAULT_CONFIG.approval)
    return gate.usable ? null : \`approval is not a usable gate: \${gate.problems.join('; ')}\`
  }`,
    replace: `  if (path === 'approval') {
    return null
  }`,
    suite: 'unit',
    expect: /writer refuses|writer/,
  },
  {
    id: 'M17',
    what: 'the guard is never registered with the tools service',
    file: 'lib/index.js',
    find: `    guardCtx.effect(() => tools.guard(approvalGate.guard), 'dsh-workflow: approval high-risk guard')`,
    replace: `    // mutated: no guard`,
    suite: 'smoke',
    expect: /monotonic guard/,
  },
  {
    id: 'M18',
    what: 'the listener is registered on the wrong event name',
    file: 'lib/index.js',
    find: `    () => ctx.on('tools/pre-execute', approvalGate.listener),`,
    replace: `    () => ctx.on('tools/pre-exec', approvalGate.listener),`,
    suite: 'smoke',
    expect: /pre-execute listener/,
  },
  {
    id: 'M19',
    what: 'the gate is installed even for a project that never opted in',
    file: 'lib/approval-state.js',
    find: `  const active = requireOptIn ? optedIn : true`,
    replace: `  const active = true`,
    suite: 'unit',
    expect: /inert|opted in|never opted/,
  },
  {
    id: 'M20',
    what: "the gate's own tools are classified medium instead of low",
    file: 'lib/approval.js',
    find: `  if (PLUGIN_TOOLS.has(name)) {
    return { risk: 'low', reason: \`"\${name}" is a dsh-workflow tool: project-local and opt-in gated\` }
  }`,
    replace: `  if (false) {
    return { risk: 'low', reason: \`"\${name}" is a dsh-workflow tool: project-local and opt-in gated\` }
  }`,
    suite: 'unit',
    expect: /project-local/,
  },
  {
    id: 'M21',
    what: 'workflow_status re-derives the approval section instead of sharing the project-file rule',
    file: 'lib/tools.js',
    find: `  const { config, sources, gate: approvalGate } = readApprovalForProject(
    rowConfig,
    projectFile,
    DEFAULT_CONFIG.approval,
    // The monotonic memory is keyed by the project whose file this is. Status must report the
    // gate that will judge the next call, not the weaker value the file was just edited to.
    project.projectDir ?? workspace.dir,
  )`,
    replace: `  const { config, sources } = resolveEffectiveConfig(rowConfig, projectFile.value)
  const approvalGate = readApprovalGate(config.approval, DEFAULT_CONFIG.approval)`,
    suite: 'unit',
    expect: /reports the gate the RUNTIME|runtime strength/,
  },
  {
    id: 'M22',
    what: 'workflow_set reports the raw approval section instead of the effective gate',
    file: 'lib/tools.js',
    find: `      value: approvalValueFrom(approvalGate, config),`,
    replace: `      value: getPath(config, segments),`,
    suite: 'unit',
    expect: /must not report "off"|workflow_set/,
  },
  {
    id: 'M23',
    what: 'configWarnings only shows the official warning for the raw llm-only/off strength',
    file: 'lib/config.js',
    find: `  if (isHumanAuthorizationRemoved(config.approval?.strength) || isHumanAuthorizationRemoved(approval.strength) || !approval.usable) {`,
    replace: `  if (isHumanAuthorizationRemoved(config.approval?.strength)) {`,
    suite: 'unit',
    expect: /refused section|verbatim line/,
  },
  {
    id: 'M24',
    what: 'the settings panel drops its broken-approval-section branch',
    file: 'lib/client.js',
    find: `      if (approvalBroken) {`,
    replace: `      if (false) {`,
    suite: 'unit',
    expect: /approvalBroken|not an object/,
  },
  {
    id: 'M25',
    what: 'the fail-closed fallback threshold is widened back to medium',
    file: 'lib/approval.js',
    find: `export const FAIL_CLOSED_APPROVAL = Object.freeze({
  strength: 'ask-user',
  riskThreshold: 'low',`,
    replace: `export const FAIL_CLOSED_APPROVAL = Object.freeze({
  strength: 'ask-user',
  riskThreshold: 'medium',`,
    suite: 'unit',
    expect: /narrowest value on EVERY axis|fallback/,
  },
  {
    id: 'M26',
    what: 'the ask branch joins problems without checking it is a list',
    file: 'lib/approval.js',
    find: `      const problems = Array.isArray(gate.problems) ? gate.problems : []
      const suffix = gate.usable || problems.length === 0 ? '' : \`; approval configuration problems: \${problems.join('; ')}\``,
    replace: `      const suffix = gate.usable || gate.problems.length === 0 ? '' : \`; approval configuration problems: \${gate.problems.join('; ')}\``,
    suite: 'unit',
    expect: /malformed gate shape|join/,
  },
  {
    id: 'M27',
    what: 'an unresolvable project directory is silently ignored again',
    file: 'lib/approval.js',
    find: `      if (state?.projectDirKnown === false) {
        counters.unresolvedProjectDir += 1`,
    replace: `      if (false) {
        counters.unresolvedProjectDir += 1`,
    suite: 'unit',
    expect: /unresolvable project directory|project directory/,
  },
  {
    id: 'M28',
    what: 'configWarnings re-adds the legacy membership tests that name "undefined" fields',
    file: 'lib/config.js',
    find: `  const approval = readApprovalGate(config.approval, DEFAULT_CONFIG.approval)`,
    replace: `  if (typeof config.approval?.strength !== 'string' || !APPROVAL_STRENGTHS.includes(config.approval?.strength)) {
    warnings.push(\`unknown approval.strength "\${config.approval?.strength}"; expected one of \${APPROVAL_STRENGTHS.join(', ')}.\`)
  }
  const approval = readApprovalGate(config.approval, DEFAULT_CONFIG.approval)`,
    suite: 'unit',
    expect: /never wrote|undefined/,
  },
  {
    id: 'M29',
    what: 'the reviewer policy stops stating that it does not see session history',
    file: 'lib/approval.js',
    find: `You see only the fixed policy, the working directory, and the complete pending action. You do NOT see the session history.`,
    replace: `You see the fixed policy, the working directory, and the complete pending action.`,
    suite: 'unit',
    expect: /session history|policy pins its own limits/,
  },
  {
    id: 'M30',
    what: 'readApprovalForProject ignores the project-file problems again (the shared rule is hollowed out)',
    file: 'lib/approval-state.js',
    find: `  const unreadable = fileProblems.length > 0`,
    replace: `  const unreadable = false`,
    suite: 'unit',
    expect: /unreadable|fully read|could not be fully read/,
  },
  {
    id: 'M31',
    what: 'the unreadable-file fallback passes `undefined` (the caller defaults) instead of FAIL_CLOSED_APPROVAL',
    file: 'lib/approval-state.js',
    find: `  const gate = unreadable
    ? readApprovalGate(FAIL_CLOSED_APPROVAL, FAIL_CLOSED_APPROVAL)
    : readApprovalGate(config.approval, defaults)`,
    replace: `  const gate = unreadable
    ? readApprovalGate(undefined, defaults)
    : readApprovalGate(config.approval, defaults)`,
    suite: 'unit',
    expect: /fail-closed threshold|refused gate|widening/,
  },
  {
    id: 'M32',
    what: 'workflow_set warnings ignore the file-aware gate again',
    file: 'lib/tools.js',
    find: `      warnings: mergeWarnings(configWarnings(after), approvalWarningLines(unchangedGate)),`,
    replace: `      warnings: configWarnings(after),`,
    suite: 'unit',
    expect: /EVERY surface|must warn about a refused gate/,
  },
  {
    id: 'M33',
    what: 'collectPathArguments is not total, so a throwing getter escapes classifyRisk',
    file: 'lib/approval.js',
    find: `  try {
    for (const [key, value] of Object.entries(args)) visit(value, key, 0)
  } catch {
    return found
  }
  return found
}

/**
 * Collect the string values under path-shaped argument keys.`,
    replace: `  for (const [key, value] of Object.entries(args)) visit(value, key, 0)
  return found
}

/**
 * Collect the string values under path-shaped argument keys.`,
    suite: 'unit',
    expect: /total|throwing getter/,
  },
  {
    id: 'M34',
    what: 'the mount log reads the raw row fields instead of the resolved gate',
    file: 'lib/index.js',
    find: `    const mountGate = readApprovalGate(config.approval, DEFAULT_CONFIG.approval)
    report(
      ctx,
      \`approval gate installed: pre-execute listener plus a monotonic high-risk guard \` +
        \`(strength=\${mountGate.strength}\${mountGate.usable ? '' : ' (unusable -> fail-closed)'}, \` +
        \`threshold=\${mountGate.riskThreshold}, denyHighAlways=\${mountGate.denyHighAlways})\`,
      'info',
    )`,
    replace: `    report(
      ctx,
      \`approval gate installed: pre-execute listener plus a monotonic high-risk guard \` +
        \`(strength=\${config.approval?.strength ?? '(unset)'}, threshold=\${config.approval?.riskThreshold ?? '(unset)'}, \` +
        \`denyHighAlways=\${config.approval?.denyHighAlways === true})\`,
      'info',
    )`,
    suite: 'smoke',
    expect: /mount log/,
  },
  {
    id: 'M35',
    what: 'the official warning is emitted twice when both sources cover the same case',
    file: 'lib/tools.js',
    find: `      warnings: mergeWarnings(configWarnings(after), approvalWarningLines(unchangedGate)),`,
    replace: `      warnings: [...configWarnings(after), ...approvalWarningLines(unchangedGate)],`,
    suite: 'unit',
    expect: /appear once|duplicat/,
  },
  // ---- the unsatisfiable-configuration change set -------------------------------
  {
    id: 'M36',
    what: 'the gate asks again in a session whose policy guarantees the ask is auto-denied (the original defect)',
    file: 'lib/approval.js',
    find: "    if (channel.state === 'disabled') {\n      counters.autoDeniedNoPrompt += 1",
    replace: "    if (false) {\n      counters.autoDeniedNoPrompt += 1",
    suite: 'unit',
    expect: /human decline|auto-denial/,
  },
  {
    id: 'M37',
    what: 'the auto-denial message stops naming the cause and the human remedy',
    file: 'lib/approval.js',
    find: "    '— so the request is denied AUTOMATICALLY. That is NOT a human declining it, nothing was executed, ' +\n    'and retrying the same call cannot help. ' +\n    `What to do instead: ${APPROVAL_REMEDY}. Changing approval.exemptTools or approval.denyHighAlways ` +\n    'from inside this session is the same self-authorization and is refused for the same reason.'",
    replace: "    '— so the request is denied. Nothing was executed.'",
    suite: 'unit',
    expect: /human decline|remedy|settings page/,
  },
  {
    id: 'M38',
    what: 'workflow_status stops flagging a detected unsatisfiable strength',
    file: 'lib/tools.js',
    find: "  if (needsPrompt && promptChannel.state === 'disabled') {",
    replace: "  if (false) {",
    suite: 'unit',
    expect: /NOT SATISFIABLE|satisfiable/,
  },
  {
    id: 'M39',
    what: "readPromptChannel stops recognizing the policy that makes the outcome a certainty",
    file: 'lib/approval.js',
    find: "  if (policy === 'never') {",
    replace: "  if (false) {",
    suite: 'unit',
    expect: /human decline|refuses to guess|disabled/,
  },
  {
    id: 'M40',
    what: 'an unreadable policy is invented as answerable',
    file: 'lib/approval.js',
    find: "    state: 'unknown',\n    policy,\n    detail: `the approval service reported an unrecognized approval policy (${describeValue(policy)})`,",
    replace: "    state: 'askable',\n    policy: 'ask',\n    detail: 'assumed answerable',",
    suite: 'unit',
    expect: /refuses to guess|unknown/,
  },
  {
    id: 'M41',
    what: 'an unreadable channel is treated as disabled, so an honest ask becomes an invented denial',
    file: 'lib/approval.js',
    find: "    if (channel.state === 'disabled') {",
    replace: "    if (channel.state !== 'askable') {",
    suite: 'unit',
    expect: /unreadable|auto-denial/,
  },
  {
    id: 'M42',
    what: 'apply() stops handing the approval service to the gate (the wiring is dropped)',
    file: 'lib/index.js',
    find: "  ctx.inject(['approval'], approvalCtx => {\n    approvalService = approvalCtx.approval",
    replace: "  if (false) ctx.inject(['approval'], approvalCtx => {\n    approvalService = approvalCtx.approval",
    suite: 'smoke',
    expect: /approval service to the gate|unanswerable prompt/,
  },
  {
    id: 'M43',
    what: 'workflow_status drops the conditional warning for an unreadable environment',
    file: 'lib/tools.js',
    find: "  } else if (needsPrompt && promptChannel.state !== 'askable') {",
    replace: '  } else if (false) {',
    suite: 'unit',
    expect: /conditional risk|UNKNOWN/,
  },
  {
    id: 'M44',
    what: 'the approval policy is read for a session other than the call being judged',
    file: 'lib/approval.js',
    find: '    policy = approval.effectivePolicy(session)',
    replace: '    policy = approval.effectivePolicy(undefined)',
    suite: 'unit',
    expect: /session/,
  },
  {
    id: 'M45',
    what: 'the auto-denial detail falls back to the ask-side text, restating the risk level',
    file: 'lib/approval.js',
    find: "        detail: `${verdict.reason ?? 'a classified effect'}${suffix}`,",
    replace: '',
    suite: 'unit',
    expect: /restated|risk level/,
  },
  {
    id: 'M46',
    what: 'the llm-then-user auto-denial detail falls back to the reasonless reviewer sentence, restating the level',
    file: 'lib/approval.js',
    find: "      detail: review.reason ?? 'the reviewer rejected this call without stating a reason',",
    replace: '',
    suite: 'unit',
    expect: /restated|risk level/,
  },
  {
    id: 'M47',
    what: 'the self-deployment exemption stops checking that the destination is inside the plugin package (any outside path is authorised)',
    file: 'lib/approval.js',
    find: `    if (containmentAgainst(destination, root, cwd) !== 'inside') return null // 5.`,
    replace: `    if (false) return null // 5.`,
    suite: 'unit',
    expect: /neighbouring|sibling|profile|outside/,
  },
  {
    id: 'M48',
    what: 'the self-deployment exemption stops requiring its sources to stay inside the project',
    file: 'lib/approval.js',
    find: `    if (pathContainment(cwd, source) !== 'inside') return null // 6.`,
    replace: `    if (false) return null // 6.`,
    suite: 'unit',
    expect: /source/,
  },
  {
    id: 'M49',
    what: 'the self-deployment exemption starts firing for shell transports, whose command can act on unnamed paths',
    file: 'lib/approval.js',
    find: `  if (SHELL_TOOLS.has(name)) return null // 2.`,
    replace: `  if (false) return null // 2.`,
    suite: 'unit',
    expect: /shell|command/,
  },
  {
    id: 'M50',
    what: 'the self-deployment exemption starts firing for actions that carry a script/program body',
    file: 'lib/approval.js',
    find: `  if (hasCommandBody !== false) return null // 3.`,
    replace: `  if (false) return null // 3.`,
    suite: 'unit',
    expect: /command-body|command body|script|program/,
  },
  {
    id: 'M51',
    what: 'the self-deployment exemption fires on a source alone, with no readable destination',
    file: 'lib/approval.js',
    find: `  if (destinations.length === 0) return null // 4.`,
    replace: `  if (false) return null // 4.`,
    suite: 'unit',
    expect: /destination/,
  },
  {
    id: 'M52',
    what: 'the classifier drops the self-deployment marker, so an authorisation becomes invisible to the gate',
    file: 'lib/approval.js',
    find: `      selfDeployment,
    }
  }`,
    replace: `    }
  }`,
    suite: 'unit',
    expect: /selfDeployment|authoris/,
  },
  {
    id: 'M53',
    what: 'the gate stops counting authorised self-deployments (the audit trail loses its number)',
    file: 'lib/approval.js',
    find: `        counters.selfDeployAuthorised += 1`,
    replace: '',
    suite: 'unit',
    expect: /selfDeployAuthorised|counted/,
  },
  {
    id: 'M54',
    what: 'the self-deployment audit line is emitted above the exempted calls only, and at a level nobody reads',
    file: 'lib/approval.js',
    find: `        log(
          'info',`,
    replace: `        log(
          'debug',`,
    suite: 'unit',
    expect: /authorised self-deployment|info:/,
  },
  {
    id: 'M55',
    what: 'the self-deployment exemption swallows the exfiltration rule, so a high risk can be authorised',
    file: 'lib/approval.js',
    find: `  const exfiltration = detectExfiltration(args, name)
  if (exfiltration !== null) return { risk: 'high', reason: exfiltration }`,
    replace: `  const exfiltration = detectExfiltration(args, name)
  if (exfiltration !== null && selfInstallRoot() === null) return { risk: 'high', reason: exfiltration }`,
    suite: 'unit',
    expect: /exfiltration|high/,
  },
  {
    id: 'M56',
    what: 'apply() drops the exemption branch from the classifier, so a self-deployment is judged as any other outside write',
    file: 'lib/approval.js',
    find: `  if (selfDeployment !== null) {`,
    replace: `  if (false) {`,
    suite: 'unit',
    expect: /selfDeployment|authoris|deployment/,
  },
  {
    id: 'M57',
    what: 'the mount never states the exemption anchor, so its scope cannot be read afterwards',
    file: 'lib/index.js',
    find: `    selfDeployRoot === null`,
    replace: `    true`,
    suite: 'unit',
    expect: /scope|anchor|exemption/,
  },
  {
    id: 'M58',
    what: 'the gate’s audit line is routed to the error channel, where a normal log filter hides it',
    file: 'lib/index.js',
    find: `      report(ctx, message, level === 'warn' ? 'warn' : level === 'info' ? 'info' : 'error'),`,
    replace: `      report(ctx, message, level === 'warn' ? 'warn' : 'error'),`,
    suite: 'unit',
    expect: /info:|authorised self-deployment/,
  },
  {
    id: 'M59',
    what: 'a working directory is counted as a destination, so a context key can authorise an action by itself',
    file: 'lib/approval.js',
    find: `    else if (CONTEXT_PATH_KEYS.has(key)) continue // a working directory proves nothing either way`,
    replace: `    else if (false) continue // a working directory proves nothing either way`,
    suite: 'unit',
    expect: /working directory|destination|cwd/,
  },
  {
    id: 'M60',
    what: 'the command-body walk is read shallower than the destination walk, so a body nested deeper than the destination is authorised',
    file: 'lib/approval.js',
    find: `      hasCommandBody: collectCommandText(args, 4).length > 0,`,
    replace: `      hasCommandBody: collectCommandText(args).length > 0,`,
    suite: 'unit',
    expect: /nested command body|command body/,
  },
  {
    id: 'M61',
    what: 'an unreadable session directory is resolved against the package root instead of refusing',
    file: 'lib/approval.js',
    find: `  if (typeof cwd !== 'string' || cwd.length === 0) return null // 1b.`,
    replace: `  if (false) return null // 1b.`,
    suite: 'unit',
    expect: /cwd|session|unreadable/,
  },
  {
    id: 'M62',
    what: 'a deleted opt-in file switches the gate off mid-session',
    file: 'lib/approval-state.js',
    find: `  const optedIn = file.present === true || gate.optedInMissing === true`,
    replace: `  const optedIn = file.present === true`,
    suite: 'unit',
    expect: /deleting the file must not switch the gate off|OPT-IN FILE MISSING/,
  },
  {
    id: 'M63',
    what: 'a user-confirmed weakening write does not reset the monotonic snapshot, so it never takes effect',
    file: 'lib/tools.js',
    find: `  if (weakening.length > 0 && written.written === true) {
    forgetApprovalSnapshot(workspace.dir)
  }`,
    replace: `  if (false) {
    forgetApprovalSnapshot(workspace.dir)
  }`,
    suite: 'unit',
    expect: /after\.gate\.strength|confirmed write|llm-only/,
  },
  {
    id: 'M64',
    what: 'workflow_set applies a weakening write without asking the user',
    file: 'lib/tools.js',
    find: `  if (weakening.length > 0) {`,
    replace: `  if (false && weakening.length > 0) {`,
    suite: 'unit',
    expect: /confirmation-required|user confirmation/,
  },
  {
    id: 'M65',
    what: 'workflow_set on a gate setting is classified low again, so the gate never sees it',
    file: 'lib/approval.js',
    find: `  if (name === 'workflow_set' && isGateConfigurationWrite(args)) {`,
    replace: `  if (false) {`,
    suite: 'unit',
    expect: /classified above low|classified medium|gate setting/,
  },
  {
    id: 'M66',
    what: 'the refusal text recommends the self-downgrade command again',
    file: 'lib/approval.js',
    find: `export const APPROVAL_REMEDY =
  'run the work from the root conversation, or ask the user to change approval.strength in the ' +
  'settings page or in .dsh/workflow.yml (the change takes effect only on a restart). A session ' +
  'must not change the gate that is judging it; this plugin will refuse a weakening write from ' +
  'inside the session'`,
    replace: `export const APPROVAL_REMEDY =
  'workflow_set path=approval.strength value=llm-only keeps model-judged gating without needing a ' +
  'prompt, and value=off disables the gate'`,
    suite: 'unit',
    expect: /value=llm-only|downgrade command/,
  },
]

function run(suite) {
  const args =
    suite === 'smoke'
      ? ['run-smoke-test.mjs']
      : ['--test', '--test-isolation=none', 'test/approval.test.mjs']
  const result = spawnSync(process.execPath, args, { cwd: ROOT, encoding: 'utf8' })
  return { status: result.status, output: `${result.stdout ?? ''}${result.stderr ?? ''}` }
}

/**
 * The restoration target of the mutant currently applied: its path and its exact original text.
 * `null` between mutants. The signal handlers below read it, so a Ctrl-C in the middle of a
 * mutant restores that file before the process dies — otherwise the mutant stays on disk.
 *
 * The handlers are registered BEFORE the lock is taken, so they run before the lock's own
 * backstop handler (Node runs handlers in registration order) and the source is restored
 * before the lock is released.
 */
let appliedMutant = null
let currentFile = null
const restoreInterrupted = () => {
  if (appliedMutant !== null && currentFile !== null) writeFileSync(currentFile, appliedMutant, 'utf8')
}
process.once('SIGINT', () => {
  restoreInterrupted()
  process.exit(130)
})
process.once('SIGTERM', () => {
  restoreInterrupted()
  process.exit(143)
})

/**
 * Everything that touches lib/ happens under the lock: the baseline, the anchor reads, every
 * mutant, every restore, and the post-restore verification. Nothing is read before the lock is
 * held, so a concurrently running harness cannot have its mutant recorded here as "the original".
 */
async function main() {
  return withMutationLock(
    async () => {
      console.log(`${LABEL}: mutation lock acquired`)
      const baseline = { unit: run('unit'), smoke: run('smoke') }
      console.log(`baseline unit: exit ${baseline.unit.status}; smoke: exit ${baseline.smoke.status}`)
      if (baseline.unit.status !== 0 || baseline.smoke.status !== 0) {
        console.error('baseline is not green; refusing to mutate')
        return { baselineOk: false }
      }

      let caught = 0
      const missed = []
      for (const mutant of MUTANTS) {
        const path = `${ROOT}/${mutant.file}`
        const original = readFileSync(path, 'utf8')
        if (!original.includes(mutant.find)) {
          console.log(`?? ${mutant.id}: the anchor did not match — mutant not applied (${mutant.what})`)
          missed.push(`${mutant.id} (anchor mismatch)`)
          continue
        }
        const mutated = original.replace(mutant.find, mutant.replace)
        if (mutated === original) {
          console.log(`?? ${mutant.id}: the replacement changed nothing`)
          missed.push(`${mutant.id} (no-op)`)
          continue
        }
        try {
          writeFileSync(path, mutated, 'utf8')
          appliedMutant = original
          currentFile = path
          const result = run(mutant.suite)
          const red = result.status !== 0
          const namesFailingTest = mutant.expect ? mutant.expect.test(result.output) : true
          if (red && namesFailingTest) {
            caught += 1
            console.log(`OK ${mutant.id} caught (${mutant.suite} exit ${result.status}): ${mutant.what}`)
          } else if (red) {
            caught += 1
            console.log(`OK ${mutant.id} caught by a different assertion: ${mutant.what}`)
          } else {
            missed.push(mutant.id)
            console.log(`!! ${mutant.id} SURVIVED (${mutant.suite} exit 0): ${mutant.what}`)
          }
        } finally {
          writeFileSync(path, original, 'utf8')
          appliedMutant = null
          currentFile = null
        }
      }

      console.log(`\n${caught}/${MUTANTS.length} mutants caught`)
      if (missed.length) console.log(`survivors: ${missed.join(', ')}`)

      // Restore-and-verify: the suite must be green again after every mutation was reverted.
      const after = run('unit')
      const afterSmoke = run('smoke')
      console.log(`post-restore unit: exit ${after.status}; smoke: exit ${afterSmoke.status}`)
      return { baselineOk: true, green: after.status === 0 && afterSmoke.status === 0 }
    },
    { label: LABEL },
  )
}

try {
  const result = await main()
  process.exit(result.baselineOk === false ? 2 : result.green ? 0 : 1)
} catch (error) {
  if (error instanceof MutationLockHeld) {
    console.error(`${LABEL}: ${error.message}`)
    process.exit(EXIT_LOCK_HELD)
  }
  throw error
}
