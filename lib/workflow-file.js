/**
 * Project-level workflow file: read, merge, and write `.dsh/workflow.yml`.
 *
 * This is the file that both opts a project in and carries its overrides. Two
 * rules shape everything here:
 *
 *  - **Opt-in is the file's existence.** No file means no workflow state and no
 *    behaviour change, which is what keeps every pre-existing project untouched.
 *  - **A write must be atomic.** A half-written YAML file would silently change
 *    what the workflow does, so writes go through a temp file and a rename.
 *
 * @module src-12453345_-dsh-workflow/workflow-file
 */

import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

import { DEFAULT_CONFIG, resolveConfig, isPlainObject, mergeConfigLayers } from './config.js'

/** Path of the project-level workflow file, relative to the project root. */
export const WORKFLOW_RELATIVE_PATH = join('.dsh', 'workflow.yml')

/** Keys that the project file may set, with their accepted shape. */
export const WRITABLE_TOP_LEVEL = new Set([
  'tier',
  'recipe',
  'requireOptIn',
  'modules',
  'context',
  'acceptance',
  'evaluator',
  'verifier',
  'guards',
  'subagent',
  'approval',
  'escalation',
  'budget',
  'retireCheck',
  'signoff',
  // The risk-based verification-depth policy. It was implemented, documented and
  // schema-validated but left out of this set, so `workflow_set path=verification.policy`
  // answered "unknown configuration key" — the feature existed and could not be turned on
  // through the tool that exists to turn things on. Adding the key is the whole fix.
  'verification',
])

/**
 * Read the project workflow file when it exists.
 *
 * @param projectDir - absolute project directory, or '' when unknown.
 * @param parse - the YAML reader (injected to keep this module free of the parser).
 * @returns `{ present, path, value, problems }`.
 */
export function readWorkflowFile(projectDir, parse) {
  const result = { present: false, path: null, value: null, problems: [] }
  if (!projectDir) return result

  const path = join(projectDir, WORKFLOW_RELATIVE_PATH)
  result.path = path
  if (!existsSync(path)) return result

  result.present = true
  try {
    const text = readFileSync(path, 'utf8')
    const parsed = parse(text)
    result.value = parsed.value
    result.problems = parsed.problems
  } catch (error) {
    result.problems = [`could not read ${path}: ${error?.message ?? error}`]
  }
  return result
}

/**
 * Resolve the effective configuration for a project: built-in defaults, then the
 * patch-row config, then the project file on top.
 *
 * @param rowConfig - configuration from the loader's patch row.
 * @param projectValue - parsed `.dsh/workflow.yml`, or null.
 * @returns `{ config, sources }` where sources records which layers contributed.
 */
export function resolveEffectiveConfig(rowConfig, projectValue) {
  const sources = ['defaults', 'patch-row']
  if (!isPlainObject(projectValue) || Object.keys(projectValue).length === 0) {
    return { config: resolveConfig(rowConfig), sources }
  }
  sources.push('project-file')
  // Deep-merge the layers so a project setting overrides one key without dropping
  // its sibling keys from the row.
  return { config: resolveConfig(mergeConfigLayers(rowConfig, projectValue)), sources }
}

/**
 * Set one nested key path on a plain object, creating containers as needed.
 *
 * @param target - object to mutate.
 * @param path - array of keys, e.g. `['modules', 'planner']`.
 * @param value - the new value; `undefined` deletes the key.
 * @returns true when something changed.
 */
export function setPath(target, path, value) {
  if (!Array.isArray(path) || path.length === 0) return false
  let node = target
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index]
    if (!isPlainObject(node[key])) node[key] = {}
    node = node[key]
  }
  const last = path[path.length - 1]
  if (value === undefined) {
    if (!Object.hasOwn(node, last)) return false
    delete node[last]
    return true
  }
  if (JSON.stringify(node[last]) === JSON.stringify(value)) return false
  node[last] = value
  return true
}

/** Read one nested key path. */
export function getPath(source, path) {
  let node = source
  for (const key of path ?? []) {
    if (node === null || typeof node !== 'object') return undefined
    node = node[key]
  }
  return node
}

/**
 * Serialise a project configuration as YAML text.
 *
 * Only values that differ from the defaults are written, so the file stays a
 * record of deliberate choices rather than a dump of every switch. Arrays are
 * emitted as block sequences and nested mappings by two-space indentation, which
 * is exactly the subset `parseWorkflowYaml` reads back.
 *
 * @param value - the configuration to serialise.
 * @param base - the defaults to diff against.
 * @returns YAML text ending in a newline.
 */
export function serializeWorkflowYaml(value, base = DEFAULT_CONFIG) {
  const lines = []
  writeNode(lines, value, base, 0)
  return lines.length ? `${lines.join('\n')}\n` : ''
}

function writeNode(lines, node, base, depth) {
  const indent = '  '.repeat(depth)
  for (const [key, raw] of Object.entries(node)) {
    const baseline = isPlainObject(base) ? base[key] : undefined
    if (isPlainObject(raw)) {
      lines.push(`${indent}${key}:`)
      writeNode(lines, raw, baseline, depth + 1)
      continue
    }
    if (Array.isArray(raw)) {
      if (raw.length === 0) {
        lines.push(`${indent}${key}: []`)
        continue
      }
      lines.push(`${indent}${key}:`)
      for (const item of raw) {
        lines.push(`${indent}  - ${formatScalar(item)}`)
      }
      continue
    }
    if (raw === null) {
      lines.push(`${indent}${key}: null`)
      continue
    }
    lines.push(`${indent}${key}: ${formatScalar(raw)}`)
  }
}

function formatScalar(value) {
  if (typeof value === 'string') {
    // Quote only when a bare scalar would be ambiguous or mistyped.
    if (value === '' || /^[\s#]|[:#\[\]{}]|^\s|\s$/.test(value) || /^(true|false|null|~|\d)/.test(value)) {
      return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
    }
    return value
  }
  return String(value)
}

/**
 * Write the project workflow file atomically.
 *
 * @param projectDir - absolute project directory.
 * @param value - the configuration object to persist.
 * @param options - `{ base, dryRun }`.
 * @returns `{ path, text, written, changed }`.
 */
export function writeWorkflowFile(projectDir, value, options = {}) {
  const path = join(projectDir, WORKFLOW_RELATIVE_PATH)
  const text = serializeWorkflowYaml(value, options.base ?? DEFAULT_CONFIG)

  if (options.dryRun) return { path, text, written: false, changed: true }

  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })

  // Compare before writing so an idempotent init does not touch the file.
  let previous = null
  if (existsSync(path)) {
    try {
      previous = readFileSync(path, 'utf8')
    } catch {
      previous = null
    }
  }
  if (previous === text) return { path, text, written: false, changed: false }

  const temp = `${path}.tmp-${process.pid}`
  try {
    writeFileSync(temp, text, 'utf8')
    renameSync(temp, path)
  } catch (error) {
    try {
      if (existsSync(temp)) rmSync(temp, { force: true })
    } catch {
      // best effort
    }
    throw error
  }
  return { path, text, written: true, changed: true }
}

/**
 * Validate a requested top-level key against the writable set.
 *
 * @param key - the top-level key name.
 * @returns An error string, or null when acceptable.
 */
export function validateTopLevelKey(key) {
  if (!WRITABLE_TOP_LEVEL.has(key)) {
    return (
      `unknown configuration key "${key}". Writable keys: ` +
      `${[...WRITABLE_TOP_LEVEL].sort().join(', ')}`
    )
  }
  return null
}

export { isPlainObject }
