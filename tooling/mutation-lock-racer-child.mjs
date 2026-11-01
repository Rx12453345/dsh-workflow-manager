/**
 * Test child for the PIPE-FREE lock race in `test/mutation-lock.test.mjs`.
 *
 * WHY A SEPARATE CHILD EXISTS. The older race test reads its children's output through pipes, and
 * the DSH sandbox denies a piped child (EPERM), so that case SKIPS here and only ever ran in CI —
 * which is exactly how the empty-lock race reached CI unnoticed (run 41275458335: four processes,
 * two winners). This child writes its own result to a FILE and is spawned with `stdio: 'ignore'`,
 * so the same race can be reproduced inside the sandbox.
 *
 * Usage: node tooling/mutation-lock-racer-child.mjs <lockPath> <gatePath> <resultPath> <label> <holdMs>
 */

import { existsSync, writeFileSync } from 'node:fs'

import { EXIT_LOCK_HELD, MutationLockHeld, withMutationLock } from './mutation-lock.mjs'

const [, , lockPath, gatePath, resultPath, label = 'the child holder', holdMs = '0'] = process.argv

const write = text => {
  try {
    writeFileSync(resultPath, text, 'utf8')
  } catch {
    // Nothing useful to do: the parent treats a missing file as a timeout.
  }
}

// WAIT FOR THE START SIGNAL, so process startup time does not spread the children across the
// winner's hold and turn a real race into four sequential acquisitions.
const deadline = Date.now() + 30000
while (!existsSync(gatePath)) {
  if (Date.now() > deadline) {
    write('TIMEOUT: the gate never appeared')
    process.exit(3)
  }
  await new Promise(resolve => setTimeout(resolve, 10))
}

try {
  await withMutationLock(
    async () => {
      write(`WON ${process.pid}`)
      if (Number(holdMs) > 0) await new Promise(resolve => setTimeout(resolve, Number(holdMs)))
    },
    { label, path: lockPath },
  )
  process.exit(0)
} catch (error) {
  if (error instanceof MutationLockHeld) {
    write(error.message)
    process.exit(EXIT_LOCK_HELD)
  }
  write(`THREW: ${error?.stack ?? error}`)
  process.exit(4)
}
