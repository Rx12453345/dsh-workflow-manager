/**
 * Project detection for dsh-workflow.
 *
 * Two responsibilities:
 *  1. locate the session working directory (the project root we operate on);
 *  2. detect whether the project opted in, by the presence of `.dsh/workflow.yml`.
 *
 * Opt-in detection is the mechanism that keeps the plugin inert in every
 * pre-existing project: no file means no workflow state, and no behaviour change.
 *
 * @module src-12453345_-dsh-workflow/project
 */

import { existsSync, readFileSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'

/** Path of the project-level workflow file, relative to the project root. */
export const WORKFLOW_RELATIVE_PATH = join('.dsh', 'workflow.yml')

/**
 * Read the session working directory from a tool execution context.
 *
 * The exec shape is host-owned and not part of the published contract, so this
 * tries the documented path first, then a bounded search, then falls back to the
 * harness process cwd. Returning '' would silently disable every project-relative
 * feature, so the caller also gets a record of what was actually seen.
 *
 * @param exec - the tool execution context.
 * @returns `{ dir, source, found }`, where source names where dir came from.
 */
export function resolveWorkspaceDir(exec) {
  const found = []

  const record = (label, value) => {
    if (typeof value === 'string' && value.trim()) found.push({ label, value })
  }

  try {
    record('exec.agent.session.header.cwd', exec?.agent?.session?.header?.cwd)
    record('exec.session.header.cwd', exec?.session?.header?.cwd)
    record('exec.cwd', exec?.cwd)
    record('exec.agent.cwd', exec?.agent?.cwd)
    // Bounded breadcrumb search: catches a moved working directory without
    // guessing at an unbounded shape.
    if (exec && typeof exec === 'object') {
      for (const [key, value] of Object.entries(exec)) {
        if (value && typeof value === 'object') {
          record(`exec.${key}.cwd`, value.cwd)
          if (value.header && typeof value.header === 'object') {
            record(`exec.${key}.header.cwd`, value.header.cwd)
          }
        }
      }
    }
  } catch (error) {
    found.push({ label: 'error', value: String(error?.message ?? error) })
  }

  if (found.length > 0) {
    return { dir: found[0].value, source: found[0].label, found }
  }

  const fallback = process.cwd()
  return {
    dir: fallback,
    source: 'process.cwd()',
    found: [{ label: 'process.cwd()', value: fallback }],
  }
}

/**
 * Backwards-compatible accessor returning just the directory.
 *
 * @param exec - the tool execution context.
 * @returns The absolute project directory, or '' when unavailable.
 */
export function sessionWorkspaceDir(exec) {
  try {
    return resolveWorkspaceDir(exec).dir
  } catch {
    return ''
  }
}

/**
 * Describe the exec object enough to diagnose a shape mismatch, without dumping
 * unbounded content.
 *
 * @param exec - the tool execution context.
 * @returns An array of short description lines.
 */
export function describeExec(exec) {
  if (exec === null || exec === undefined) return ['exec is ' + String(exec)]
  if (typeof exec !== 'object') return [`exec is ${typeof exec}`]
  const keys = Object.keys(exec)
  const lines = [`exec keys: ${keys.length ? keys.join(', ') : '(none)'}`]
  for (const key of keys.slice(0, 24)) {
    const value = exec[key]
    if (value === null || value === undefined) {
      lines.push(`  ${key} = ${String(value)}`)
      continue
    }
    if (typeof value !== 'object') {
      lines.push(`  ${key} = ${typeof value}`)
      continue
    }
    const nested = Object.keys(value)
    lines.push(`  ${key}: object{${nested.slice(0, 14).join(', ')}${nested.length > 14 ? ', …' : ''}}`)
  }
  return lines
}

/**
 * A minimal YAML reader for the workflow file only.
 *
 * Deliberately not a general YAML parser: it supports nested mappings by
 * two-space indentation, `key: value` scalars, inline flow arrays, and `#`
 * comments. Anything it cannot understand is reported rather than guessed at.
 *
 * @param text - the file contents.
 * @returns `{ value, problems }`, where problems lists unparsed lines.
 */
export function parseWorkflowYaml(text) {
  const root = {}
  const problems = []
  // Frames describe where the next nested value belongs:
  //   container[key] = value   (key === null means "the container is the value")
  // `indent` is the column of the line that DECLARED the key.
  const stack = [{ container: root, key: null, indent: -1 }]

  const lines = String(text ?? '').split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const rawLine = lines[index]
    const withoutComment = stripComment(rawLine)
    if (withoutComment.trim() === '') continue

    const indent = withoutComment.length - withoutComment.trimStart().length
    const content = withoutComment.trim()

    if (content === '-' || content.startsWith('- ')) {
      const owner = findOwner(stack, indent)
      if (owner === null) {
        problems.push(`line ${index + 1}: list item has no owning key ("${content}")`)
        continue
      }
      const list = owner.key === null ? owner.container : ensureArrayFor(owner)
      const body = content === '-' ? '' : content.slice(2).trim()
      if (body === '') {
        pushFrame(stack, list, null, indent)
        continue
      }
      const itemSeparator = body.indexOf(':')
      const looksLikeMapping = itemSeparator > 0 && !body.startsWith('[') && !/^["']/.test(body)
      if (!looksLikeMapping) {
        list.push(parseScalar(body))
        continue
      }
      const element = {}
      list.push(element)
      pushFrame(stack, element, null, indent)
      const firstKey = body.slice(0, itemSeparator).trim()
      const firstRaw = body.slice(itemSeparator + 1).trim()
      if (firstRaw === '') pushFrame(stack, element, firstKey, indent + 1)
      else element[firstKey] = parseScalar(firstRaw)
      continue
    }

    const separator = content.indexOf(':')
    if (separator <= 0) {
      problems.push(`line ${index + 1}: not a "key: value" mapping ("${content}")`)
      continue
    }
    const key = content.slice(0, separator).trim()
    const rawValue = content.slice(separator + 1).trim()

    const parent = resolveContainer(stack, indent)
    if (rawValue === '') {
      // The container type is decided when the first child arrives.
      parent[key] = {}
      pushFrame(stack, parent, key, indent)
      continue
    }
    parent[key] = parseScalar(rawValue)
  }

  return { value: root, problems }
}

/** Push a frame, keeping the stack bounded so a pathological file cannot grow it. */
function pushFrame(stack, container, key, indent) {
  stack.push({ container, key, indent })
  while (stack.length > 64) stack.splice(1, 1)
}

/**
 * The frame owning a list started at `indent`: the nearest frame whose key sits at
 * a shallower or equal indent, or one whose container is already that list.
 */
function findOwner(stack, indent) {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const frame = stack[i]
    if (Array.isArray(frame.container)) return frame
    if (frame.key !== null && indent > frame.indent) return frame
  }
  return null
}

/** Ensure the frame's `container[key]` is an array and return it. */
function ensureArrayFor(frame) {
  const existing = frame.container[frame.key]
  if (Array.isArray(existing)) return existing
  const list = []
  frame.container[frame.key] = list
  return list
}

/** The mapping that should receive a `key: value` declared at `indent`. */
function resolveContainer(stack, indent) {
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    const frame = stack[i]
    if (indent > frame.indent) {
      if (frame.key === null) return frame.container
      const value = frame.container[frame.key]
      if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value
      return frame.container
    }
  }
  return stack[0].container
}

function stripComment(line) {
  let inSingle = false
  let inDouble = false
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]
    if (ch === "'" && !inDouble) inSingle = !inSingle
    else if (ch === '"' && !inSingle) inDouble = !inDouble
    else if (ch === '#' && !inSingle && !inDouble) {
      if (i === 0 || /\s/.test(line[i - 1])) return line.slice(0, i)
    }
  }
  return line
}

function parseScalar(raw) {
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim()
    if (inner === '') return []
    return inner.split(',').map(part => parseScalar(part.trim()))
  }
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1)
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1)
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw === 'null' || raw === '~') return null
  if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10)
  if (/^-?\d*\.\d+$/.test(raw)) return Number.parseFloat(raw)
  return raw
}

/**
 * Inspect a project directory: opt-in state, the workflow file, and the signals
 * the design doc's harnessability check depends on.
 *
 * @param projectDir - absolute project directory, or '' when unknown.
 * @returns A structured description of the project.
 */
export function probeProject(projectDir) {
  const result = {
    projectDir: projectDir || null,
    detected: false,
    workflowPath: null,
    workflow: null,
    workflowProblems: [],
    harnessability: {
      git: false,
      dsDir: false,
      manifest: null,
      lockfile: false,
      testScript: false,
      lintConfig: false,
      typecheckConfig: false,
      buildScript: false,
    },
    signals: [],
  }

  if (!projectDir) {
    result.signals.push('no session working directory was available')
    return result
  }

  const root = resolve(projectDir)
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    result.signals.push(`project directory does not exist: ${root}`)
    return result
  }

  const workflowPath = join(root, WORKFLOW_RELATIVE_PATH)
  result.workflowPath = workflowPath
  result.detected = existsSync(workflowPath)

  if (result.detected) {
    try {
      const text = readFileSync(workflowPath, 'utf8')
      const { value, problems } = parseWorkflowYaml(text)
      result.workflow = value
      result.workflowProblems = problems
    } catch (error) {
      result.signals.push(`could not read ${workflowPath}: ${error?.message ?? error}`)
    }
  } else {
    result.signals.push(
      `${WORKFLOW_RELATIVE_PATH} is absent, so this project has not opted in and the workflow stays inert`,
    )
  }

  const harness = result.harnessability
  harness.git = existsSync(join(root, '.git'))
  harness.dsDir = existsSync(join(root, '.dsh'))

  for (const name of ['package.json', 'Cargo.toml', 'pyproject.toml', 'go.mod']) {
    const candidate = join(root, name)
    if (existsSync(candidate)) {
      harness.manifest = name
      if (name === 'package.json') {
        try {
          const pkg = JSON.parse(readFileSync(candidate, 'utf8'))
          const scripts = pkg?.scripts ?? {}
          harness.testScript = typeof scripts.test === 'string'
          harness.buildScript = typeof scripts.build === 'string'
        } catch {
          result.signals.push('package.json could not be parsed as JSON')
        }
      }
      break
    }
  }

  harness.lockfile = ['pnpm-lock.yaml', 'package-lock.json', 'yarn.lock', 'Cargo.lock', 'poetry.lock']
    .some(name => existsSync(join(root, name)))
  harness.lintConfig = [
    '.eslintrc', '.eslintrc.json', '.eslintrc.cjs', '.eslintrc.js', 'eslint.config.js',
    'eslint.config.mjs', 'clippy.toml', 'ruff.toml', '.ruff.toml',
  ].some(name => existsSync(join(root, name)))
  harness.typecheckConfig = ['tsconfig.json', 'jsconfig.json']
    .some(name => existsSync(join(root, name)))

  return result
}

/**
 * Summarise a probe result as one line per finding, for people and models.
 *
 * @param probe - the result of {@link probeProject}.
 * @returns An array of short lines.
 */
export function describeProject(probe) {
  // Accept either the raw probe or a projected view that nests it under `project`,
  // so a caller cannot accidentally pass the wrong shape and crash the renderer.
  const view = probe?.project ?? probe ?? {}
  const signals = Array.isArray(view.signals) ? view.signals : []
  const problems = Array.isArray(view.workflowProblems) ? view.workflowProblems : []
  const harness = view.harnessability ?? {}

  const lines = []
  lines.push(`project: ${view.projectDir ?? '(unknown)'}`)
  lines.push(`workflow file: ${view.detected ? view.workflowPath : 'absent (not opted in)'}`)
  if (problems.length) {
    lines.push(`workflow file problems: ${problems.join('; ')}`)
  }
  const enabled = Object.entries(harness)
    .filter(([, value]) => value === true)
    .map(([key]) => key)
  lines.push(`harness signals present: ${enabled.length ? enabled.join(', ') : 'none'}`)
  for (const signal of signals) lines.push(`note: ${signal}`)
  return lines
}
