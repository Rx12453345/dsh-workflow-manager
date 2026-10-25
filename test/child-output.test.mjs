/**
 * The shared child-output helper used by every mutation harness.
 *
 * WHY THIS IS A TEST, NOT JUST A REFACTOR: the harnesses used to capture a child through a
 * piped stdio, which the DSH Windows sandbox denies with `EPERM`. The helper exists so they
 * can run in the sandbox at all. If it silently regressed to a pipe, the harnesses would go
 * back to failing to start their child — and the unit suite must notice that before another
 * depth-2 run discovers it by producing no evidence.
 *
 * The functional cases also run under the sandbox, where a piped child genuinely fails, so a
 * regression to a pipe cannot pass here by accident.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { runCaptured } from '../tooling/child-output.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const HELPER = join(ROOT, 'tooling', 'child-output.mjs')

test('runCaptured returns stdout, stderr and the exit status separately', () => {
  const result = runCaptured(process.execPath, [
    '-e',
    "process.stdout.write('the stdout text'); process.stderr.write('the stderr text'); process.exit(7)",
  ])
  assert.equal(result.error, null)
  assert.equal(result.status, 7)
  assert.equal(result.signal, null)
  assert.equal(result.stdout, 'the stdout text')
  assert.equal(result.stderr, 'the stderr text')
})

test('runCaptured reports a child that cannot start instead of throwing', () => {
  const result = runCaptured(join(ROOT, 'tooling', 'this-binary-does-not-exist'), [])
  assert.ok(result.error instanceof Error)
  assert.equal(result.status, null)
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
})

test('runCaptured keeps a large stdout intact (it is a file, not a capped buffer)', () => {
  const line = 'x'.repeat(1024)
  const result = runCaptured(process.execPath, [
    '-e',
    `for (let i = 0; i < 64; i += 1) process.stdout.write(${JSON.stringify(`${line}\n`)})`,
  ])
  assert.equal(result.status, 0)
  assert.equal(result.stdout.length, 64 * 1025)
})

test('the helper never names a pipe stdio', () => {
  const source = readFileSync(HELPER, 'utf8')
  assert.doesNotMatch(
    source,
    /['"]pipe['"]/,
    'tooling/child-output.mjs must not configure a pipe; the sandbox denies it (EPERM)',
  )
})
