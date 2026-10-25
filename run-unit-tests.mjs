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
 * Sandbox mode: `node run-unit-tests.mjs [--sandbox]`. The runner probes whether a piped
 * child can be started. When the sandbox denies it (EPERM), the test process receives
 * `DSH_WORKFLOW_SANDBOX=1`; the handful of tests that NEED a pipe or a browser skip with an
 * explicit reason instead of reporting red. A normal terminal never sets the flag, so those
 * tests still run and still fail on a real defect. `--sandbox` forces the mode for a manual
 * check.
 *
 * THE ISOLATION FLAG IS PROBED, NOT ASSUMED. `--test-isolation=none` exists in Node 24 and
 * is rejected outright by Node 22 (`node.exe: bad option: --test-isolation=none`), which is
 * what made CI's Node 22 job fail before it ran a single test. On a Node that does not accept
 * it, the runner omits the flag and lets the ordinary per-file child isolation happen; that
 * works wherever child processes can be spawned, which is exactly where the older Node runs.
 *
 * Usage: node run-unit-tests.mjs [--sandbox]
 */

import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Whether child-process pipes are denied here.
 *
 * The Windows sandbox refuses to create a named pipe for a captured child, which arrives as
 * EPERM from `spawn`. The test runner itself spawns Node with INHERITED stdio, so it works;
 * tests that spawn a child WITH A PIPE (the mutation-lock races) and tests that launch a
 * browser cannot. Probe once, before the suite, and tell the test process so those cases can
 * skip LOUDLY instead of reporting a red suite for an environment limitation.
 */
function sandboxDeniesPipes() {
  const probe = spawnSync(process.execPath, ['-e', ''], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
  })
  return probe.error?.code === 'EPERM'
}

/**
 * Whether this Node accepts `--test-isolation=none`.
 *
 * Probed rather than keyed on a version number, because the flag is a runtime detail and the
 * CI matrix spans two majors. `stdio: 'ignore'` keeps the probe off the pipe path, so it also
 * works inside the DSH sandbox — where the flag is both supported and REQUIRED (a piped child
 * cannot start).
 */
function supportsNoIsolation() {
  const probe = spawnSync(process.execPath, ['--test-isolation=none', '-e', ''], {
    stdio: 'ignore',
  })
  return probe.status === 0
}

const forced = process.argv.includes('--sandbox')
const sandbox = forced || sandboxDeniesPipes()

if (sandbox) {
  console.log(
    'dsh-workflow tests: SANDBOX mode — child-process pipes are denied; ' +
      'the tests that require a pipe or a browser will skip with a reason.',
  )
}

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

const noIsolation = supportsNoIsolation()
if (!noIsolation) {
  console.log(
    'dsh-workflow tests: this Node does not accept --test-isolation=none (Node 22 does not); ' +
      'running with the default per-file isolation. Fine in CI, not usable inside the DSH sandbox.',
  )
}

const result = spawnSync(
  process.execPath,
  ['--test', ...(noIsolation ? ['--test-isolation=none'] : []), ...FILES],
  // `stdio: 'inherit'` specifically: the sandboxed environment cannot open a named
  // pipe for a captured child, but an inherited terminal passes straight through.
  {
    stdio: 'inherit',
    env: { ...process.env, ...(sandbox ? { DSH_WORKFLOW_SANDBOX: '1' } : {}) },
  },
)

if (result.error) {
  console.error(`could not start the test runner: ${result.error.message}`)
  process.exit(1)
}

process.exit(result.status ?? 1)
