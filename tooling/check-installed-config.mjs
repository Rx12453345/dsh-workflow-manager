/**
 * Verify the INSTALLED copy the way the host will read it.
 *
 * This is the end-to-end check for the settings form: `dsh-settings` drops any
 * entry whose `fiber.runtime.Config` is missing or is not a native schemastery
 * graph, and a dropped entry never appears in the settings namespace directory —
 * which is exactly what makes the browser page's namespace gate stay shut.
 *
 * Usage: node tooling/check-installed-config.mjs
 */

import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'desktop')
const PACKAGE_DIR = join(PROFILE_DIR, 'node_modules', 'src-12453345_-dsh-workflow')
const INSTALLED = pathToFileURL(join(PACKAGE_DIR, 'lib', 'index.js')).href

/** The host's own predicate, copied from dsh-app-boot `isNativeConfigSchema`. */
function isNativeConfigSchema(value) {
  if (value === null || (typeof value !== 'object' && typeof value !== 'function')) return false
  const meta = Reflect.get(value, 'meta')
  return (
    Reflect.get(value, Symbol.for('schemastery')) === true &&
    typeof Reflect.get(value, 'type') === 'string' &&
    meta !== null &&
    typeof meta === 'object'
  )
}

/** The host's `schema(entry)` also requires toJSON. */
function hostAccepts(value) {
  return isNativeConfigSchema(value) && 'toJSON' in value
}

const entry = await import(INSTALLED)
const Config = entry.Config
const dict = Reflect.get(Config ?? {}, 'dict') ?? {}

// EVERY independently switchable row needs the schema on the module that row
// loads. `dsh-settings` reads `entry.fiber.runtime.Config` per Loader row, so a
// component entry that forgets to re-export `Config` is silently dropped from the
// settings namespace directory — the browser page then never receives a form.
const SUBENTRIES = [
  ['core', join(PACKAGE_DIR, 'lib', 'components', 'core', 'index.js')],
  ['panel', join(PACKAGE_DIR, 'lib', 'components', 'panel', 'index.js')],
]

const checks = [
  ['the installed entry imports', typeof entry.apply === 'function'],
  ['Config is present at import time', Config !== undefined],
  ['the host would accept Config as a schema', hostAccepts(Config)],
  ['Config is volatile at the root (fields become editable)', Config?.meta?.volatile === true],
  ['rowKind is absent so no form can write it', !Object.hasOwn(dict, 'rowKind')],
  [
    'every section the settings page edits is declared',
    ['tier', 'recipe', 'approval', 'evaluator', 'modules'].every(key => Object.hasOwn(dict, key)),
  ],
  ['applySchemas is gone (no injected schema path remains)', entry.applySchemas === undefined],
]

for (const [label, path] of SUBENTRIES) {
  const sub = await import(pathToFileURL(path).href)
  checks.push(
    [`the /${label} entry re-exports Config`, sub.Config !== undefined],
    [`the host would accept the /${label} Config`, hostAccepts(sub.Config)],
    [`the /${label} entry still applies`, typeof sub.apply === 'function'],
  )
}

let failed = false
for (const [label, ok] of checks) {
  if (!ok) failed = true
  console.log(`  ${ok ? 'ok   ' : 'FAIL '} ${label}`)
}
console.log(`\ndeclared top-level sections: ${Object.keys(dict).length}`)

process.exitCode = failed ? 1 : 0
