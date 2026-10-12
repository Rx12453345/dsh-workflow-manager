/**
 * Consistency check: every value written in `cordis.patch.yml` must match the
 * code default it claims to mirror, so a patch edit never silently diverges from
 * the documented configuration model.
 *
 * Usage: node run-config-check.mjs
 */

import { readFileSync } from 'node:fs'
import { resolveConfig, DEFAULT_CONFIG, MAX_SUBAGENT_DEPTH } from './lib/config.js'
import { parseWorkflowYaml } from './lib/project.js'

const text = readFileSync(new URL('./cordis.patch.yml', import.meta.url), 'utf8')

// The reader is indentation-sensitive; the core row's config body sits six spaces
// deep inside the patch list, so strip exactly that one level before parsing.
const lines = text.split(/\r?\n/)
const start = lines.findIndex(line => line.includes('dsh-workflow-core'))
const end = lines.findIndex((line, index) => index > start && /^\s*- id: dsh-workflow-panel/.test(line))
const coreConfigBlock = lines
  .slice(start, end === -1 ? undefined : end)
  .join('\n')
  // Drop the enclosing patch-list level: the six-space strip below aligns the row
  // body, but the leading `- ` would still read as a list item with no owner.
  .replace(/^(\s*)- /m, '$1  ')

const { value, problems } = parseWorkflowYaml(coreConfigBlock.replace(/^ {6}/gm, ''))

const differences = []
function walk(codeValue, patchValue, path) {
  for (const [key, patchLeaf] of Object.entries(patchValue)) {
    const codeLeaf = codeValue?.[key]
    const bothObjects =
      codeLeaf !== null &&
      typeof codeLeaf === 'object' &&
      !Array.isArray(codeLeaf) &&
      patchLeaf !== null &&
      typeof patchLeaf === 'object' &&
      !Array.isArray(patchLeaf)
    if (bothObjects) {
      walk(codeLeaf, patchLeaf, `${path}${key}.`)
      continue
    }
    if (JSON.stringify(codeLeaf) !== JSON.stringify(patchLeaf)) {
      differences.push(`${path}${key}: code=${JSON.stringify(codeLeaf)} patch=${JSON.stringify(patchLeaf)}`)
    }
  }
}

// The row's `config:` mapping is what claims to mirror the code defaults.
const patchConfig = value.config ?? {}
walk(DEFAULT_CONFIG, patchConfig, '')

console.log(`parsed ${Object.keys(patchConfig).length} top-level config keys from the core patch row`)
if (problems.length) {
  console.log('unparsed patch lines (reader limitations, not necessarily errors):')
  for (const problem of problems) console.log(`  - ${problem}`)
}
if (differences.length === 0) {
  console.log('OK: every patch value matches its code default')
} else {
  console.log(`\n${differences.length} divergence(s) — the patch would override the code default:`)
  for (const difference of differences) console.log(`  - ${difference}`)
  process.exitCode = 1
}

// A resolved config must always be usable, whatever the patch says.
//
// The bound is `MAX_SUBAGENT_DEPTH` (2), not a hardcoded 1. It was pinned to 1 while the
// reasoning was "a delegated child must not delegate again" — which was wrong, because
// `maxDepth` is an ABSOLUTE tree ceiling and 1 therefore also forbids the architecture the
// plugin recommends: main agent (0) -> orchestrator child (1) -> its reviewer (2).
// Reading the constant keeps this check and `config.js` from drifting apart.
const resolved = resolveConfig(value.config)
if (resolved.subagent.maxDepth !== MAX_SUBAGENT_DEPTH) {
  console.error(
    `INVARIANT VIOLATED: resolved maxDepth is ${String(resolved.subagent.maxDepth)}, ` +
      `expected ${MAX_SUBAGENT_DEPTH}`,
  )
  process.exitCode = 1
} else {
  console.log(`OK: resolved maxDepth is ${MAX_SUBAGENT_DEPTH}`)
}
