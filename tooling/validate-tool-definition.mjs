/**
 * Validate dsh-workflow's tool definition against the REAL schema checker.
 *
 * Why this exists: `ctx.tools.register()` immediately runs
 * `assertSupportedJsonSchema(output.schema)` and throws for anything outside the
 * enforced subset. The supported `type` values are only
 * object/array/string/number/integer/boolean/null — `{ type: "json" }` (the shape
 * a `defineTool(...)` author DSL accepts) is REJECTED there. A fake tools service
 * cannot catch that, so this harness lifts the genuine checker out of the shipped
 * bundle and runs it against our own definition.
 *
 * Usage:
 *   DSH_TOOLS_BUNDLE=<extracted>/dsh-tools/lib/index.js \
 *     node tooling/validate-tool-definition.mjs
 *
 * DSH 0.2.2-rc.5 moved the checker out of `lib/index.js` into a shared chunk
 * (`lib/shared-*.js`); the documented path still points at `lib/index.js`, so the
 * locator below searches the entry bundle first and then its directory.
 */

import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

const TOOLS_BUNDLE = process.env.DSH_TOOLS_BUNDLE ?? ''
if (TOOLS_BUNDLE === '') {
  console.error('DSH_TOOLS_BUNDLE is not set; point it at the extracted dsh-tools/lib/index.js')
  process.exit(2)
}

// Take the checker and everything it depends on: from the top of the module
// (constants and helpers) to the end of the function that uses it.
const FUNCTION_START = 'function assertSupportedJsonSchema'
const FUNCTION_END = 'function assertObjectJsonSchema'

/**
 * Read the bundle that actually DEFINES the checker.
 *
 * A bundle can re-export the checker from a sibling chunk (rc.5 does), so the entry
 * file alone is not enough. The entry is tried first; then every `.js` sibling is
 * searched for the definition. The returned path is reported in the failure message
 * so a missing anchor names the file that was actually read.
 *
 * @param bundlePath - the path in DSH_TOOLS_BUNDLE.
 * @returns `{ path, source }`; `source` is the entry text when no sibling defines it.
 */
function readBundleWithChecker(bundlePath) {
  const direct = readFileSync(bundlePath, 'utf8')
  if (direct.includes(FUNCTION_START)) return { path: bundlePath, source: direct }

  let names
  try {
    names = readdirSync(dirname(bundlePath))
  } catch {
    return { path: bundlePath, source: direct }
  }
  for (const name of names) {
    if (name === basename(bundlePath) || !name.endsWith('.js')) continue
    const candidate = join(dirname(bundlePath), name)
    try {
      const sibling = readFileSync(candidate, 'utf8')
      if (sibling.includes(FUNCTION_START)) return { path: candidate, source: sibling }
    } catch {
      // An unreadable sibling is not the checker; keep looking.
    }
  }
  return { path: bundlePath, source: direct }
}

const located = readBundleWithChecker(TOOLS_BUNDLE)
const source = located.source
const start = source.indexOf(FUNCTION_START)
const end = source.indexOf(FUNCTION_END)
if (start < 0 || end < 0 || end <= start) {
  console.error(
    `could not locate assertSupportedJsonSchema in ${TOOLS_BUNDLE} or in any .js file ` +
      `beside it (${dirname(TOOLS_BUNDLE)})`,
  )
  process.exit(1)
}

// The slice needs its constants and helper functions, which sit before the
// function in the bundle; take the module header up to the function, skipping any
// ESM statements the Function constructor cannot parse.
const header = source
  .slice(0, start)
  .split('\n')
  .filter(line => !/^\s*(export|import)\s/.test(line))
  .join('\n')

const body = source.slice(start, end)

// The checker's error class extends the harness' own base error, which lives
// outside the slice. A minimal stand-in is enough: only the message matters here.
const prelude = 'class HarnessError extends Error {}\n'

const factory = new Function(`${prelude}${header}\n${body}\nreturn { assertSupportedJsonSchema };`)
const { assertSupportedJsonSchema } = factory()

const {
  buildToolDefinition,
  buildInitToolDefinition,
  buildSetToolDefinition,
  buildReviewToolDefinition,
  buildAdvanceToolDefinition,
} = await import('../lib/tools.js')
const { buildGcToolDefinition } = await import('../lib/gc.js')

const options = { config: {}, ctx: null, services: null }
const definitions = [
  buildToolDefinition(options),
  buildInitToolDefinition(options),
  buildSetToolDefinition(options),
  buildReviewToolDefinition(options),
  buildAdvanceToolDefinition(options),
  buildGcToolDefinition(options),
]

let failed = false

for (const definition of definitions) {
  console.log(`\ntool: ${definition.name}`)
  console.log(`  output.schema: ${JSON.stringify(definition.output.schema)}`)

  try {
    assertSupportedJsonSchema(definition.output.schema)
    console.log('  ok    output.schema passes the real checker')
  } catch (error) {
    failed = true
    console.log(`  FAIL  output.schema rejected: ${error?.message ?? error}`)
  }

  // The parameters must look like a prepared JSON Schema, not the author DSL.
  const parameters = definition.parameters
  const looksPrepared =
    parameters !== null &&
    typeof parameters === 'object' &&
    parameters.type === 'object' &&
    typeof parameters.properties === 'object' &&
    (parameters.required === undefined || Array.isArray(parameters.required))
  if (looksPrepared) {
    console.log('  ok    parameters are a prepared JSON Schema object')
  } else {
    failed = true
    console.log(`  FAIL  parameters are not prepared: ${JSON.stringify(parameters).slice(0, 160)}`)
  }

  // Required names must exist in properties, or the registry's validator misleads.
  for (const name of parameters.required ?? []) {
    if (!Object.hasOwn(parameters.properties ?? {}, name)) {
      failed = true
      console.log(`  FAIL  required name "${name}" is absent from properties`)
    }
  }
}

console.log('')
// Confirm the known-bad shape really is rejected, so this harness would have
// caught the bug it now guards against.
try {
  assertSupportedJsonSchema({ type: 'json' })
  console.log('  WARN  { type: "json" } was ACCEPTED — the checker behaviour changed; revisit this guard')
} catch {
  console.log('  ok    { type: "json" } is rejected, as expected (this is the bug this guard prevents)')
}

if (failed) process.exitCode = 1
else console.log(`\nall ${definitions.length} tool definitions are acceptable to the shipped registry`)
