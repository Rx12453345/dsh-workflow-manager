/**
 * Run a child process and capture its output WITHOUT a pipe.
 *
 * WHY NOT THE OBVIOUS CAPTURING STDIO: the DSH Windows sandbox refuses to create the named
 * pipe a captured child needs, and `spawnSync` comes back with `EPERM` instead of a result.
 * A mutation harness that captures its child that way therefore cannot run inside the sandbox
 * at all — which is exactly the tooling gap this helper closes.
 *
 * WHAT IT DOES INSTEAD: open two temp files, hand their descriptors to the child as
 * stdout/stderr, wait for it, close the descriptors, read the files back. No named pipe is
 * involved, so the sandbox permits it. The temp directory is always removed, including
 * when the child could not be started.
 *
 * The return shape is deliberately the same information a `spawnSync(..., { encoding:
 * 'utf8' })` call gave the harnesses: `{ status, signal, error, stdout, stderr }`, with
 * `stdout`/`stderr` decoded as UTF-8. `error` is the spawn error (for example ENOENT or
 * EPERM) or `null`; `status`/`signal` are whatever the child exited with.
 */

import { closeSync, mkdtempSync, openSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

/**
 * Run `command` with `args`, capturing stdout/stderr through temp files.
 *
 * @param {string} command - the executable to run.
 * @param {string[]} args - its arguments.
 * @param {object} [options] - spawnSync options other than `stdio`; `stdio`, `encoding` and
 *   `input` are ignored because this helper owns the three standard descriptors.
 * @returns {{status: number|null, signal: string|null, error: Error|null, stdout: string, stderr: string}}
 */
export function runCaptured(command, args, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-workflow-child-'))
  const stdoutPath = join(dir, 'stdout.log')
  const stderrPath = join(dir, 'stderr.log')
  let stdoutFd
  let stderrFd
  try {
    stdoutFd = openSync(stdoutPath, 'w')
    stderrFd = openSync(stderrPath, 'w')
    // `stdio` is assigned LAST so a caller can never re-introduce a pipe by accident.
    // `encoding` and `input` are dropped: the output is decoded by readFileSync below, and
    // stdin is always 'ignore' (no harness feeds its child input).
    const { stdio: _stdio, encoding: _encoding, input: _input, ...spawnOptions } = options
    const result = spawnSync(command, args, {
      ...spawnOptions,
      stdio: ['ignore', stdoutFd, stderrFd],
    })
    // CLOSE BEFORE READING. The bytes are flushed when the last descriptor for the file is
    // closed, and on Windows the temp directory cannot be removed while a handle is open.
    closeSync(stdoutFd)
    stdoutFd = undefined
    closeSync(stderrFd)
    stderrFd = undefined
    return {
      status: result.status,
      signal: result.signal,
      error: result.error ?? null,
      stdout: readFileSync(stdoutPath, 'utf8'),
      stderr: readFileSync(stderrPath, 'utf8'),
    }
  } finally {
    // A throw between open and close must not leak a descriptor or a temp directory.
    if (stdoutFd !== undefined) {
      try {
        closeSync(stdoutFd)
      } catch {}
    }
    if (stderrFd !== undefined) {
      try {
        closeSync(stderrFd)
      } catch {}
    }
    rmSync(dir, { recursive: true, force: true })
  }
}
