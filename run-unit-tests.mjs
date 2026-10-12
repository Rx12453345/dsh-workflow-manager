/**
 * In-process test runner.
 *
 * WHY THIS EXISTS, AND WHAT IT IS NOT
 * `node --test <dir>` spawns one child process per test file with piped stdio, which
 * the Windows sandbox denies (EPERM). `--test-isolation=none` runs everything in one
 * process instead, but does not accept a directory, so the files are named here.
 *
 * An earlier version of this file defined `globalThis.test` and imported the test
 * modules directly, believing that replaced the runner. It did not: the test files
 * `import { test } from 'node:test'`, and an ESM import binding is read-only, so the
 * stub was never consulted. The assertions still ran (Node's own runner discovered
 * them) which is exactly why the mistake stayed invisible — the command printed a
 * green summary either way. Rather than keep that indirection, this runner now
 * executes Node's runner as a child with INHERITED stdio and forwards its status.
 *
 * Usage: node run-unit-tests.mjs
 */

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

// DISCOVERED, NOT LISTED. `--test-isolation=none` does not accept a directory, and a
// hand-maintained list is one more thing to forget: a new test file would silently
// never run, which is indistinguishable from passing.
const FILES = readdirSync('test')
  .filter(name => name.endsWith('.test.mjs'))
  .sort()
  .map(name => join('test', name))

if (FILES.length === 0) {
  console.error('no *.test.mjs files found in test/')
  process.exit(1)
}

const result = spawnSync(
  process.execPath,
  ['--test', '--test-isolation=none', ...FILES],
  // `stdio: 'inherit'` specifically: the sandboxed environment cannot open a named
  // pipe for a captured child, but an inherited terminal passes straight through.
  { stdio: 'inherit' },
)

if (result.error) {
  console.error(`could not start the test runner: ${result.error.message}`)
  process.exit(1)
}

process.exit(result.status ?? 1)
