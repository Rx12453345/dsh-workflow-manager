/**
 * Try to take the mutation lock once, for the lock-proof scripts.
 *
 * Usage: node tooling/lock-proofs/lock-takeup.mjs <lockPath> <unused> <label>
 * Exit 2 when the lock is held/refused (the expected "live holder inside the cap" case),
 * 0 when it was acquired, 1 for an unexpected error.
 */

import { EXIT_LOCK_HELD, MutationLockHeld, withMutationLock } from '../mutation-lock.mjs'

const [path, , label] = process.argv.slice(2)
try {
  await withMutationLock(async () => {}, {
    path: path || undefined,
    label: label || 'lock take-up proof',
  })
  process.exit(0)
} catch (error) {
  if (error instanceof MutationLockHeld) {
    console.error(error.message)
    process.exit(EXIT_LOCK_HELD)
  }
  console.error(error?.message ?? String(error))
  process.exit(1)
}
