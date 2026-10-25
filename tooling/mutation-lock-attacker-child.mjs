/**
 * Test child for `test/mutation-lock.test.mjs`.
 *
 * Tries to take the mutation lock that somebody else holds. On refusal it prints the refusal
 * message verbatim and exits with EXIT_LOCK_HELD, which is what a real harness does.
 *
 * Usage: node tooling/mutation-lock-attacker-child.mjs <lockPath> [label]
 */

import { EXIT_LOCK_HELD, MutationLockHeld, withMutationLock } from './mutation-lock.mjs'

const [, , lockPath, label = 'the loser'] = process.argv

try {
  await withMutationLock(async () => {}, { label, path: lockPath })
  console.log('WON')
} catch (error) {
  if (error instanceof MutationLockHeld) {
    console.log(error.message)
    process.exit(EXIT_LOCK_HELD)
  }
  throw error
}
