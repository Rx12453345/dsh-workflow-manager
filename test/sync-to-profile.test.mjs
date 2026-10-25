/**
 * The `sync-to-profile.mjs` root contract.
 *
 * WHY THIS EXISTS. `tooling/sync-to-profile.mjs` used to print `absent:` and exit 0 when the
 * workspace root did not exist. It now exits 1 with `the workspace root does not exist` — a
 * deliberate change, because a mistyped `DSH_WORKFLOW_SRC` otherwise looked like a clean sync
 * that had nothing to do. The P3 review found that change unclaimed and untested: nothing in
 * the suite would notice if the script drifted back to exit 0. This test pins the intended
 * contract. It exercises ONLY the missing-root path, which returns before `planSync` is called
 * and therefore never reads or writes the profile.
 *
 * The child is captured through `tooling/child-output.mjs` (temp-file descriptors, no pipe):
 * the DSH Windows sandbox denies a piped child with EPERM, so `spawnSync(..., {stdio:'pipe'})`
 * would report a spawn failure instead of the exit code under test.
 *
 * Run with `node run-unit-tests.mjs`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runCaptured } from '../tooling/child-output.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(ROOT, 'tooling', 'sync-to-profile.mjs')

test('sync-to-profile exits 1 when the workspace root does not exist — it is not a clean run', t => {
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-sync-absent-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const missing = join(scratch, 'not-a-checkout')

  const result = runCaptured(process.execPath, [SCRIPT, '--check'], {
    cwd: ROOT,
    env: {
      ...process.env,
      // Both roots are redirected so the test cannot see, or write, the real profile even if the
      // missing-source check were removed: the destination simply does not exist either.
      DSH_WORKFLOW_SRC: missing,
      DSH_PROFILE_DIR: join(scratch, 'profile'),
    },
  })

  assert.equal(result.error, null, `the script could not start: ${result.error?.message ?? ''}`)
  assert.equal(result.status, 1, `an absent source must be exit 1, not a pass: ${result.stderr}`)
  assert.match(result.stderr, /the workspace root does not exist/)
  assert.match(result.stderr, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  // The old behaviour printed `absent:` and a "sync complete" line; neither may come back.
  assert.doesNotMatch(result.stdout, /sync complete/)
  assert.doesNotMatch(result.stdout, /absent:/)
})

test('sync-to-profile --check prints the EOL-only line and counts it as identical, not as a differ', t => {
  // THE PRINTING PATH HAD NO COVERAGE. `planSync` was tested, but the CLI's own loops — the
  // `same text (line endings differ only)` line and the summary's "n of those" suffix — were not.
  // The EOL-only branch only prints when `report.eolOnly` is non-empty, so the throwaway profile
  // must be SEEDED with a target that exists, holds the same text, and differs only in endings.
  const scratch = mkdtempSync(join(tmpdir(), 'dsh-sync-eol-'))
  t.after(() => rmSync(scratch, { recursive: true, force: true }))
  const src = join(scratch, 'src')
  const profile = join(scratch, 'profile')
  const installed = join(profile, 'node_modules', 'src-12453345_-dsh-workflow')
  mkdirSync(join(src, 'lib'), { recursive: true })
  mkdirSync(join(installed, 'lib'), { recursive: true })
  writeFileSync(join(src, 'lib', 'app.js'), 'export const x = 1\n')
  writeFileSync(join(installed, 'lib', 'app.js'), 'export const x = 1\r\n')

  const result = runCaptured(process.execPath, [SCRIPT, '--check'], {
    cwd: ROOT,
    // Both roots are under `scratch`: the real profile is never read or written.
    env: { ...process.env, DSH_WORKFLOW_SRC: src, DSH_PROFILE_DIR: profile },
  })

  assert.equal(result.error, null, `the script could not start: ${result.error?.message ?? ''}`)
  assert.equal(result.status, 0, result.stderr)
  // The byte-level fact is reported, and only as an ending difference. The separator is matched
  // in either form so the case is about the verdict, not about the host's `relative()` spelling.
  assert.match(result.stdout, /same text \(line endings differ only\) lib[\\/]app\.js/)
  assert.doesNotMatch(result.stdout, /DIFFERS lib[\\/]app\.js/)
  // The summary counts it as identical AND names the ending-only subset. Both halves matter: a
  // summary that said `1 differ` would make --check report a change that is not one.
  assert.match(
    result.stdout,
    /check complete: 0 differ, 1 already identical \(1 of those differ only in line endings\)/,
  )
})
