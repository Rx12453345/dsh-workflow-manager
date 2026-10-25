/**
 * Test child for `test/mutation-lock.test.mjs`.
 *
 * Waits for a start gate, then tries to take the mutation lock and announces the outcome:
 * ACQUIRED + hold, or the refusal message + EXIT_LOCK_HELD. A real file rather than
 * `node -e` so a failure is debuggable and the quoting of a temp path cannot silently
 * change what a case proves.
 *
 * The gate exists because process startup is ~100ms and a hold is ~2s: without it, three
 * "concurrent" children can arrive spread across the hold and all take the lock in turn,
 * which would make a race test that cannot fail.
 *
 * Usage: node tooling/mutation-lock-holder-child.mjs <lockPath> <holdMs> [label] [gatePath]
 *        Add --ttl=<ms> after the path to override the staleness cap (used by the proofs).
 */

import { existsSync } from 'node:fs'
import { EXIT_LOCK_HELD, MutationLockHeld, withMutationLock } from './mutation-lock.mjs'

const args = process.argv.slice(2)
const ttl = args.find(arg => arg.startsWith('--ttl='))
if (ttl) process.env.MUTATION_LOCK_TTL_MS = ttl.slice('--ttl='.length)
const [lockArg, holdArg = '0', label = 'the child holder', gatePath] = args
// An env var wins over the positional argument, because a caller that spawns this through a
// shell has a much easier time setting an environment variable than quoting a path argument
// that may contain spaces: a job/shell that re-splits the command line shifts every argument
// after that path. (This file itself shipped an off-by-one here once, and an env var set by a
// probe masked it — which is why the duration is now validated rather than silently NaN.)
const lockPath = process.env.MUTATION_LOCK_PATH ?? lockArg
const holdMs = process.env.MUTATION_HOLD_MS ?? holdArg
const holdDuration = Number(holdMs)
if (!Number.isFinite(holdDuration)) {
  console.error(`holder: the hold duration is not a number (got ${JSON.stringify(holdMs)})`)
  process.exit(3)
}
if (process.env.MUTATION_DEBUG === '1') console.log(`holder: argv=${JSON.stringify(args)} holdMs=${holdMs} lock=${lockPath}`)

if (gatePath) {
  const deadline = Date.now() + 30000
  while (!existsSync(gatePath)) {
    if (Date.now() > deadline) {
      console.error('the start gate never appeared')
      process.exit(3)
    }
    await new Promise(resolve => setTimeout(resolve, 2))
  }
}

try {
  await withMutationLock(
    async () => {
      console.log('ACQUIRED')
      await new Promise(resolve => setTimeout(resolve, holdDuration))
    },
    { label, path: lockPath },
  )
} catch (error) {
  if (error instanceof MutationLockHeld) {
    console.log(error.message)
    process.exit(EXIT_LOCK_HELD)
  }
  throw error
}
