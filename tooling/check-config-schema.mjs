/**
 * Pin down schemastery's `volatile` semantics and the shape the host requires of
 * an exported `Config`.
 *
 * This script exists because the loader and the settings UI want opposite things
 * from the same schema, and the difference is not documented:
 *
 *  - the host LOADER normalises a row's config by calling the schema directly
 *    (`Schema(value)`), which must yield every default;
 *  - the settings UI reads the `~standard.validate` projection, and only sees
 *    fields marked `.volatile()`.
 *
 * A volatile field stores a PLACEHOLDER instead of its default WHEN THE SCHEMA IS
 * CALLED, so a single schema cannot be both a callable default-filler and a
 * volatile settings form. The host resolves this by never calling the schema: it
 * projects metadata into JSON Schema and validates with Ajv. Volatile is therefore
 * safe on the exported `Config` (part 1 below proves what a direct call does, so
 * the limitation is recorded rather than rediscovered).
 *
 * What the host DOES require is that `Config` is present on the module namespace
 * when it describes the settings document — an injected assignment is too late and
 * makes the row disappear from the settings namespace directory (part 4).
 *
 *   cd "$DSH_PROFILE_DIR"        # default: ~/.dsh/profiles/desktop
 *   node "<plugin-checkout>/tooling/check-config-schema.mjs"
 *
 * The profile can be overridden with DSH_PROFILE_DIR; the package root is derived
 * from this script's own location, so the checkout can live anywhere.
 */

import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const PACKAGE_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'desktop')

async function loadSchemastery() {
  try {
    const mod = await import('@deepseek-ai/schemastery')
    console.log('schemastery: resolved from the current base')
    return mod.default ?? mod
  } catch {
    try {
      const require = createRequire(pathToFileURL(join(PROFILE_DIR, 'package.json')))
      const path = require.resolve('@deepseek-ai/schemastery')
      const mod = await import(pathToFileURL(path).href)
      console.log('schemastery: resolved via the profile')
      return mod.default ?? mod
    } catch (error) {
      console.error(
        'could not resolve @deepseek-ai/schemastery. Run from the profile:\n' +
          `  cd ${PROFILE_DIR}\n  node ${PACKAGE_DIR}/tooling/check-config-schema.mjs\n` +
          `  (${error.code ?? error.message})`,
      )
      process.exit(2)
    }
  }
}

const z = await loadSchemastery()
const { buildConfigSchema } = await import(pathToFileURL(join(PACKAGE_DIR, 'lib', 'config-schema.js')).href)
const { DEFAULT_CONFIG, resolveConfig } = await import(pathToFileURL(join(PACKAGE_DIR, 'lib', 'config.js')).href)

let failed = false
function check(label, condition, detail = '') {
  if (condition) console.log(`  ok    ${label}`)
  else {
    failed = true
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

// ---------------------------------------------------------------------------
// 1. The semantics that decide whether a Config export is safe
// ---------------------------------------------------------------------------
console.log('\nvolatile semantics:')
const plain = z.object({ a: z.string().default('x'), b: z.number().default(3) })
const volatileLeaves = z
  .object({ a: z.string().default('x').volatile(), b: z.number().default(3).volatile() })

const plainApplied = plain({})
check(
  'a non-volatile schema applies its defaults when called',
  plainApplied.a === 'x' && plainApplied.b === 3,
  JSON.stringify(plainApplied),
)

const volatileApplied = volatileLeaves({})
const volatileKeepsDefaults = volatileApplied.a === 'x' && volatileApplied.b === 3
console.log(
  `        a volatile schema called directly yields ${JSON.stringify(volatileApplied)}`,
)
check(
  'DOCUMENTED RISK: a volatile field does NOT keep its default',
  !volatileKeepsDefaults,
  'if this now passes, schemastery changed and a Config export may be safe again',
)

// A volatile field nested inside a volatile subtree is rejected — but only when
// the schema is USED, not when `.volatile()` is called.
let nestedVolatileRejected = false
try {
  const nested = z.object({ a: z.string().default('x').volatile() }).volatile()
  nested({})
} catch {
  nestedVolatileRejected = true
}
check(
  'volatile nested inside volatile is rejected when used',
  nestedVolatileRejected,
  'so .volatile() must be applied at exactly one level',
)

// ---------------------------------------------------------------------------
// 2. The schema we keep for a future settings form still builds
// ---------------------------------------------------------------------------
console.log('\nthe packaged schema:')
let schema
try {
  schema = buildConfigSchema(z)
  check('buildConfigSchema constructs without throwing', true)
} catch (error) {
  check('buildConfigSchema constructs without throwing', false, error.message)
}

// ---------------------------------------------------------------------------
// 3. The runtime defaults stay self-consistent (this is what actually ships)
// ---------------------------------------------------------------------------
console.log('\nruntime defaults (what the plugin really uses):')
const resolved = resolveConfig({})
const expectedTop = Object.keys(DEFAULT_CONFIG)
const missing = expectedTop.filter(key => !(key in resolved))
check('resolveConfig fills every top-level key', missing.length === 0, missing.join(', '))
check('subagent.maxDepth caps nesting at 2 (1 would forbid a delegated reviewer)', resolved.subagent.maxDepth === 2)
check('recipe defaults to null', resolved.recipe === null)
check(
  'resolveConfig deep-merges without dropping siblings',
  (() => {
    const merged = resolveConfig({ modules: { planner: false } })
    return merged.modules.planner === false && merged.modules.independentReview === true
  })(),
)

// ---------------------------------------------------------------------------
// 4. The entry exports a Config the host can actually see
// ---------------------------------------------------------------------------
//
// `dsh-settings` reads `entry.fiber.runtime.Config` while describing the settings
// document. That is the module namespace member, so it must be present the moment
// the namespace is handed to the loader — an assignment from an `ctx.inject`
// callback is too late, the row is dropped from the namespace directory, and the
// browser page silently never appears.
console.log('\nthe exported Config (what the host reads):')
const entry = await import(pathToFileURL(join(PACKAGE_DIR, 'lib', 'index.js')).href)
check(
  'the host entry imports',
  typeof entry.apply === 'function',
  Object.keys(entry).join(', '),
)
check(
  'Config is exported at import time, not injected later',
  entry.Config !== undefined,
  `Config is ${typeof entry.Config} at import time`,
)
check(
  'Config looks like a native schemastery graph',
  // A schemastery schema is a FUNCTION, not a plain object — the host's own
  // isNativeConfigSchema accepts either (`typeof value !== "object" &&
  // typeof value !== "function"`). Pinning the host's full predicate here.
  entry.Config !== null &&
    (typeof entry.Config === 'object' || typeof entry.Config === 'function') &&
    Reflect.get(entry.Config, Symbol.for('schemastery')) === true &&
    typeof Reflect.get(entry.Config, 'type') === 'string' &&
    typeof Reflect.get(entry.Config, 'meta') === 'object' &&
    typeof entry.Config.toJSON === 'function',
  `got ${typeof entry.Config} with Symbol=${Reflect.get(entry.Config ?? {}, Symbol.for('schemastery'))}`,
)
check('Config is volatile at the root (what makes fields editable)', entry.Config?.meta?.volatile === true)
check(
  'rowKind stays OUT of the schema so a form can never write it',
  entry.Config?.dict !== undefined && !Object.hasOwn(entry.Config.dict, 'rowKind'),
)
check(
  'a declared Config exposes every runtime section the settings page edits',
  ['tier', 'recipe', 'approval', 'evaluator', 'modules'].every(key =>
    Object.hasOwn(entry.Config?.dict ?? {}, key),
  ),
  `keys: ${Object.keys(entry.Config?.dict ?? {}).join(', ')}`,
)

process.exitCode = failed ? 1 : 0
