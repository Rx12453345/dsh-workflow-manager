/**
 * Load `@deepseek-ai/schemastery` for the exported `Config` schema.
 *
 * WHY THIS HELPER EXISTS
 * `Config` must be a module-level export, because `dsh-settings` reads
 * `entry.fiber.runtime.Config` (the module namespace member) while describing the
 * settings document. An injected assignment is too late and the row silently
 * disappears from the settings namespace directory.
 *
 * That makes schemastery a hard requirement of module evaluation, which needs a
 * resolver that works in two different layouts:
 *
 *  1. INSTALLED (the real deployment) — the package sits in
 *     `<profile>/node_modules/dsh-workflow`, exactly like every official plugin, so
 *     an ordinary `createRequire(import.meta.url)` resolution finds schemastery as a
 *     sibling. This is the primary path and it needs no help.
 *  2. CHECKOUT (development) — a bare checkout has no `node_modules`, so the
 *     same resolution fails. Only this case falls back to the profile's copy.
 *
 * Resolution failure is not fatal: the caller records a warning and runs without a
 * schema, so the workflow tools keep working on a bare checkout.
 *
 * @module src-12453345_-dsh-workflow/schemastery
 */

import { createRequire } from 'node:module'
import { existsSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PACKAGE = '@deepseek-ai/schemastery'

/** Profile directories to try, most specific first. */
function profileCandidates() {
  const home = process.env.DSH_HOME
  const roots = [home && join(home, 'profiles'), join(homedir(), '.dsh', 'profiles')].filter(Boolean)
  const found = []
  for (const root of roots) {
    if (!existsSync(root)) continue
    try {
      for (const name of readdirSync(root)) {
        const dir = join(root, name)
        if (existsSync(join(dir, 'package.json'))) found.push(dir)
      }
    } catch {
      // A profile directory we cannot list is simply not a candidate.
    }
  }
  return found
}

/**
 * Resolve schemastery, preferring the plugin's own module graph.
 *
 * @param moduleUrl - the calling module's `import.meta.url`.
 * @returns the resolved absolute path.
 * @throws when no layout provides the package.
 */
export function resolveSchemasteryPath(moduleUrl) {
  // `createRequire` resolves from the DIRECTORY CONTAINING the given path, so a
  // bare directory does not make it look in that directory's `node_modules`. Each
  // profile candidate is therefore given a filler filename inside it.
  const attempts = [moduleUrl, ...profileCandidates().map(dir => join(dir, 'resolve-from-here.js'))]
  let lastError
  for (const base of attempts) {
    try {
      return createRequire(base).resolve(PACKAGE)
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error(`${PACKAGE} is not resolvable`)
}

/**
 * Load schemastery, normalising the CJS/ESM interop shape.
 *
 * @param moduleUrl - the calling module's `import.meta.url`.
 * @returns the schemastery module.
 */
export function loadSchemastery(moduleUrl) {
  const loaded = createRequire(moduleUrl)(resolveSchemasteryPath(moduleUrl))
  return loaded?.default ?? loaded
}
