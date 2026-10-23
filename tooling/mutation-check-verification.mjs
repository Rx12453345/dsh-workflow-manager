/**
 * Mutation check for the risk-based verification-depth policy.
 *
 * WHAT THIS IS FOR
 * The policy's entire safety argument is a NEGATIVE one: a declaration must never be able to
 * lower the verification a change receives. A test that cannot fail cannot establish that, so
 * this harness re-injects each defect the policy is supposed to prevent and reports whether the
 * regression file went RED.
 *
 * The mutants are grouped by the four claims the policy makes, and a survivor in any group is a
 * hole worth naming rather than a number to round up:
 *
 *   1. A SHALLOW CLASS OVER A SECURITY CHANGE IS REFUSED (M1-M8)
 *   2. UNREADABLE EVIDENCE FAILS CLOSED (M9-M14)
 *   3. THE USER'S ANSWER IS WHAT AUTHORISES THE DEPTH (M15-M20)
 *   4. THE REPORT CANNOT BE FORGED BY HAND-EDITED DATA (M21-M24)
 *
 * ⚠ ONE MUTATION HARNESS AT A TIME. Every `mutation-check-*.mjs` rewrites `lib/` sources and
 * restores them; two concurrent runs overwrite each other's restores and can LEAVE A MUTANT
 * APPLIED (this happened once). `tooling/mutation-lock.mjs` refuses a second run, but the lock
 * is a backstop rather than a licence — do not rely on it.
 *
 * Usage: node tooling/mutation-check-verification.mjs
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { EXIT_LOCK_HELD, MutationLockHeld, withMutationLock } from './mutation-lock.mjs'

/**
 * The regression file this policy's tests live in.
 *
 * Pointed at `test/review.test.mjs` rather than the whole suite on purpose: the policy is
 * contained in `lib/config.js`, `lib/review.js` and `lib/tools.js`, and running every file would
 * let an unrelated red test mask a mutant by making the run fail for the wrong reason. The TAP
 * output is compared per test NAME, so a pre-existing unrelated failure cannot be mistaken for a
 * kill either.
 */
const TEST_FILE = 'test/review.test.mjs'

/** Every harness takes this lock, so no two of them can rewrite lib/ at the same time. */
const LABEL = 'tooling/mutation-check-verification.mjs'

const CFG = 'lib/config.js'
const REVIEW = 'lib/review.js'
const TOOLS = 'lib/tools.js'

const MUTANTS = [
  // ---- 1. a shallow class over a security change is refused -------------------------------
  {
    id: 'V01',
    file: CFG,
    defect: 'the security class is pointed at a SHALLOWER rung, so a security change becomes degradable',
    from: "    id: 'security',\n    shallowest: VERIFICATION_DEPTHS.INDEPENDENT,",
    to: "    id: 'security',\n    shallowest: VERIFICATION_DEPTHS.HARNESSES,",
    must: ['the class table itself puts security at the deepest rung'],
  },
  {
    id: 'V02',
    file: CFG,
    defect: 'the resolved class name can be reported BELOW the depth actually enforced',
    from: '    resolved: classForFloor(effectiveFloor),',
    to: '    resolved: classForFloor(declaredFloor ?? 0),',
    must: ['CRITICAL: a shallow class combined with a security-touching change is REFUSED'],
  },
  {
    id: 'V03',
    file: CFG,
    defect: 'the declared class stops being compared with the evidence, so nothing is ever refused',
    from: '  if (hasEvidence && declaredClass !== null && derivedFloor > declaredFloor) {',
    to: '  if (false) {',
    must: ['CRITICAL: a shallow class combined with a security-touching change is REFUSED'],
  },
  {
    id: 'V04',
    file: CFG,
    defect: 'an unclassified source file is graded as ordinary logic instead of stricter than security',
    from: "      raise('security', `${path} is a source file this policy has not classified`)",
    to: "      raise('logic', `${path} is a source file this policy has not classified`)",
    must: ['an unclassified source file is treated as stricter than security'],
  },
  {
    id: 'V05',
    file: CFG,
    defect: 'a security path spelled with a backslash or a leading ./ is no longer recognised',
    from: "  const trimmed = value.trim().replace(/\\\\/g, '/')",
    to: '  const trimmed = value.trim()',
    must: ['an unclassified source file is treated as stricter than security'],
  },
  {
    id: 'V06',
    file: CFG,
    defect: 'a bare basename no longer matches a security surface, so "approval.js" slips through',
    from: "  return SECURITY_FILES.some(file => file.split('/').pop() === base)",
    to: '  return false',
    must: ['an unclassified source file is treated as stricter than security'],
  },
  {
    id: 'V07',
    file: CFG,
    defect: 'the EVIDENCE half of the floor is dropped, so an undeclared security change resolves shallow',
    from: '  const floor = Math.max(declaredFloor ?? 0, derivedFloor ?? 0)',
    to: '  const floor = declaredFloor ?? derivedFloor ?? 0',
    must: ['the security class is NOT degradable, at any policy setting or explicit depth'],
    note:
      'V03 removes the REFUSAL; this removes the FLOOR. They are separate mutations because a ' +
      'resolver that refuses loudly and then runs at the shallow depth would pass a test that only ' +
      'checked `refused === true`.',
  },
  {
    id: 'V08',
    file: CFG,
    defect: 'a per-call depth may go BELOW the class floor instead of only above it',
    from: '  if (numeric < classFloor) {',
    to: '  if (false) {',
    must: ['the security class is NOT degradable, at any policy setting or explicit depth'],
  },

  // ---- 2. unreadable evidence fails closed --------------------------------------------------
  {
    id: 'V09',
    file: CFG,
    defect: 'a MALFORMED verification section falls back to the documented defaults instead of the strict ones',
    from: `    return {
      policy: 'enforced',
      confirmation: 'always',
      report: true,
      usable: false,`,
    to: `    return {
      policy: 'off',
      confirmation: 'on-override',
      report: true,
      usable: false,`,
    must: ['a malformed verification SECTION resolves to the strictest usable settings'],
  },
  {
    id: 'V10',
    file: CFG,
    defect: 'an unknown policy VALUE is accepted as its own fallback instead of resolving strict',
    from: "    policy: VERIFICATION_POLICIES.includes(policy) ? policy : 'enforced',",
    to: "    policy: VERIFICATION_POLICIES.includes(policy) ? policy : 'off',",
    must: ['a malformed verification SECTION resolves to the strictest usable settings'],
  },
  {
    id: 'V11',
    file: CFG,
    defect: 'an unrecognised change class is treated as NO declaration, so the shallow default runs silently',
    from: '  if (declaredRaw !== undefined && declaredRaw !== null && !declaredUsable) {',
    to: '  if (false) {',
    must: ['an unrecognised class fails closed rather than being read as "no declaration"'],
  },
  {
    id: 'V12',
    file: CFG,
    defect: 'declaring the shallowest class without any evidence is honoured instead of refused',
    from: '  if (declaredNeedsEvidence) {',
    to: '  if (false) {',
    must: ['declaring the shallowest class without evidence is refused'],
  },
  {
    id: 'V13',
    file: CFG,
    defect: 'no declaration and no evidence resolves to a SHALLOW depth instead of a raised one',
    from: "  const unverified = declaredClass === null && !hasEvidence\n  const effectiveFloor = declaredNeedsEvidence || unverified",
    to: "  const unverified = false\n  const effectiveFloor = declaredNeedsEvidence || unverified",
    must: ['with no declaration and no evidence the depth is raised and review substitutes'],
  },
  {
    id: 'V14',
    file: CFG,
    defect: 'a diff that merely MENTIONS a security file raises the class, reading content instead of headers',
    from: '  for (const rawLine of diff.split(/\\r?\\n/)) {',
    to: "  for (const rawLine of diff.split(/\\r?\\n/)) { if (rawLine.includes('approval.js')) return ['lib/approval.js']",
    must: ['a diff alone is enough evidence, and its headers are read rather than its content'],
  },

  // ---- 3. the user's answer is what authorises the depth -----------------------------------
  {
    id: 'V15',
    file: CFG,
    defect: 'a typed custom answer counts as approval of the depth',
    from: "  return approveLabels.find(label => selected.includes(label)) ?? null",
    to: "  return approveLabels[0] ?? null",
    must: ['a verification depth is only confirmed by an exact option label'],
  },
  {
    id: 'V16',
    file: CFG,
    defect: 'the confirmation token carries no brand, so any in-process caller can mint one',
    from: "      [CONFIRMATION]: true,\n      source: 'user-question',",
    to: "      source: 'user-question',",
    must: ['a hand-built object cannot pass as a confirmation'],
  },
  {
    id: 'V17',
    file: CFG,
    defect: 'a missing question service is treated as consent instead of a refusal',
    from: "  if (service === undefined || service === null || typeof service.ask !== 'function') {",
    to: '  if (false) {',
    must: ['a missing question service refuses rather than proceeding on the model word'],
  },
  {
    id: 'V18',
    file: TOOLS,
    defect: 'an unconfirmed depth no longer blocks the review (the user half becomes fictional)',
    from: 'const mustAsk = enforcing && (',
    to: 'const mustAsk = false && (',
    must: ['the workflow_review tool refuses a depth the user did not confirm'],
  },
  {
    id: 'V19',
    file: TOOLS,
    defect: 'the ui class runs a review WITHOUT the human check the class requires',
    from: "      if (enforcing && humanRequired && !humanAsserted) {",
    to: '      if (false) {',
    must: ['the workflow_review tool refuses a ui change with no human check'],
  },
  {
    id: 'V20',
    file: TOOLS,
    defect: "the user's MAXIMUM choice does not actually raise what runs, so the option is decoration",
    from: '          const raisedDepth = Math.max(raised.depth, verification.depth)',
    to: '          const raisedDepth = verification.depth',
    must: ['choosing the maximum option raises the class and the harness plan'],
  },

  // ---- 4. the report cannot be forged by hand-edited data ----------------------------------
  {
    id: 'V21',
    file: REVIEW,
    defect: 'a skipped harness is never recorded, so the audit cannot say what was deliberately skipped',
    from: "    if (depth <= VERIFICATION_DEPTHS.UNIT) skipped.push('every mutation harness')",
    to: '    if (false) skipped.push(\'every mutation harness\')',
    must: ['the audit records what was skipped and who confirmed it'],
  },
  {
    id: 'V22',
    file: REVIEW,
    defect: 'renderVerificationAudit prints a hand-editable value unflattened, so a newline forges a line',
    from: '  out.push(`verification: class "${one(className)}" at depth ${depth ?? \'?\'} (${one(label)})`)',
    to: '  out.push(`verification: class "${className}" at depth ${depth ?? \'?\'} (${label})`)',
    must: ['a hand-edited value containing a newline cannot forge a report line'],
  },
  {
    id: 'V23',
    file: REVIEW,
    defect: 'the confirmation is reported as an OBJECT, so the audit reads "[object Object]"',
    from: "    confirmedBy: isUsableConfirmation(extra.confirmation)\n      ? 'user-question'",
    to: "    confirmedBy: isUsableConfirmation(extra.confirmation)\n      ? extra.confirmation",
    must: ['a confirmation is reported by its source, not as an object'],
  },
  {
    id: 'V24',
    file: REVIEW,
    defect: 'the reviewer is never told the depth, so it cannot judge whether the depth was adequate',
    from: "  if (verification !== null && typeof verification === 'object' && !Array.isArray(verification)) {",
    to: '  if (false) {',
    must: ['the depth is stated to the reviewer, including what it skipped'],
  },
  {
    id: 'V25',
    file: REVIEW,
    defect: 'harness selection ignores the depth, so a shallow class still runs every harness',
    from: '  const required = depth === VERIFICATION_DEPTHS.HARNESS\n    ? [mostSpecificHarness(covering)]\n    : covering',
    to: '  const required = covering',
    must: ['harness selection follows the depth, not a hardcoded list'],
  },
  {
    id: 'V26',
    file: REVIEW,
    defect: 'depth 1 picks the ALPHABETICALLY first covering harness instead of the narrowest',
    from: '    if (leftCount !== rightCount) return leftCount - rightCount\n    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0',
    to: '    return left.name < right.name ? -1 : left.name > right.name ? 1 : 0',
    must: ['harness selection follows the depth, not a hardcoded list'],
  },
  {
    id: 'V27',
    file: REVIEW,
    defect: 'an unreadable tooling directory is read as "nothing covers this file" instead of a gap',
    from: '      unreadable: true,',
    to: '      unreadable: false,',
    must: ['an unreadable harness directory is reported as a gap, not as "no coverage"'],
  },
]

function runTests() {
  const result = spawnSync(
    process.execPath,
    // TAP so a failing run names the tests that caught the mutant; without it the default
    // reporter prints specs and the harness can only report "something failed".
    ['--test', '--test-reporter=tap', '--test-isolation=none', TEST_FILE],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
  )
  if (result.error) {
    return { ok: false, error: result.error, output: '', failing: [] }
  }
  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`
  const failing = output
    .split(/\r?\n/)
    .filter(line => /^\s*not ok /.test(line))
    .map(line => line.replace(/^\s*not ok\s+\d+\s+-\s+/, '').trim())
  return { ok: result.status === 0, status: result.status, output, failing }
}

const sha = text => createHash('sha256').update(text).digest('hex').slice(0, 12)

/**
 * Read a source EXACTLY as it is on disk, for the byte-for-byte restore check.
 *
 * Deliberately not normalised: a `\r\n` that the harness did not touch must still be there when
 * the mutant is reverted, and the restore comparison is the check that catches a harness which
 * wrote `\n` over the whole file.
 */
const readExact = file => readFileSync(file, 'utf8')

/**
 * Read a source for ANCHOR MATCHING with `\r\n` folded to `\n`.
 *
 * `lib/config.js` is CRLF while `lib/review.js` and `lib/tools.js` are LF in this tree, so an
 * anchor written with plain newlines matched in two files and silently failed to match in the
 * third — which the first run of this harness reported as `anchor occurs 0 times`, not as a kill.
 * Normalising here means every anchor is written once, in one notation, and a mismatch is about
 * the code rather than about line endings.
 */
const readForAnchors = file => readFileSync(file, 'utf8').replace(/\r\n/g, '\n')

/**
 * The signal handlers are registered BEFORE the lock is taken (so they run before the lock's own
 * backstop handler: Node runs handlers in registration order). The snapshot stays empty until the
 * lock is held, so a Ctrl-C during acquisition cannot write `undefined` over a source.
 */
async function main() {
  // Snapshot every source this harness touches BEFORE the first mutant, so the final check
  // compares against a state no mutant could have contaminated.
  const files = [...new Set(MUTANTS.map(mutant => mutant.file))].sort()
  const originals = new Map()
  const hashes = new Map()
  /** The same sources, LF-normalised, for matching the anchors below. */
  const anchors = new Map()
  const restoreAll = () => {
    for (const [file, text] of originals) writeFileSync(file, text, 'utf8')
  }
  process.once('SIGINT', () => {
    restoreAll()
    process.exit(130)
  })
  process.once('SIGTERM', () => {
    restoreAll()
    process.exit(143)
  })

  await withMutationLock(
    async () => {
      console.log(`${LABEL}: mutation lock acquired`)
      for (const file of files) {
        const exact = readExact(file)
        originals.set(file, exact)
        hashes.set(file, sha(exact))
        anchors.set(file, readForAnchors(file))
      }

      const rows = []
      let harnessError = null

      for (const mutant of MUTANTS) {
        const anchorText = anchors.get(mutant.file)
        const occurrences = anchorText.split(mutant.from).length - 1
        if (occurrences !== 1) {
          rows.push({
            ...mutant,
            verdict: 'HARNESS ERROR',
            note:
              `anchor occurs ${occurrences} times` +
              (occurrences === 0 && mutant.to !== undefined
                ? ' — if this is V01 or another FIRST mutant, check whether an EARLIER crashed run left the file mutated rather than restored'
                : ''),
          })
          continue
        }

        const mutated = anchorText.replace(mutant.from, mutant.to)
        // THE MUTANT IS WRITTEN BEFORE THE TRY, AND REVERTED IN A `finally` THAT READS FROM
        // `originals`. An earlier version reverted from a loop-local `original` that no longer
        // existed and crashed in the `finally`, so the mutant stayed applied in the tree and the
        // NEXT run reported it as "anchor occurs 0 times" instead of as a kill. The
        // `isSecurityFloored()` invariant in `configWarnings` is what caught the damage on the
        // following plain `node -e` call, which is the check earning its place.
        writeFileSync(mutant.file, mutated, 'utf8')
        try {
          if (mutated === anchorText) {
            rows.push({ ...mutant, verdict: 'HARNESS ERROR', note: 'the replacement changed nothing' })
            continue
          }
          const result = runTests()
          if (result.error) {
            rows.push({ ...mutant, verdict: 'HARNESS ERROR', note: String(result.error.message ?? result.error) })
            continue
          }
          // A NAMED-TEST ASSERTION, not just "did anything fail". The suite already contains
          // unrelated red tests, so a mutant that merely made the run non-zero would be reported
          // as killed by a test that has nothing to do with it.
          const named = (mutant.must ?? []).filter(name => result.failing.some(line => line.includes(name)))
          if (result.ok) {
            rows.push({ ...mutant, verdict: 'SURVIVED (test hole)', note: 'the whole file stayed green' })
          } else if (named.length !== (mutant.must ?? []).length) {
            rows.push({
              ...mutant,
              verdict: 'KILLED BY ANOTHER TEST',
              note:
                `red, but not the named test(s): ${(mutant.must ?? []).join(', ')}. ` +
                `Failing: ${result.failing.join('; ') || '(none parsed)'}`,
            })
          } else {
            rows.push({
              ...mutant,
              verdict: 'KILLED',
              note: `${result.failing.length} test(s) red, including the named one(s)`,
              failing: named,
            })
          }
        } catch (error) {
          harnessError = error
          rows.push({ ...mutant, verdict: 'HARNESS ERROR', note: String(error?.message ?? error) })
        } finally {
          // THE EXACT BYTES, not the LF-normalised anchor text. Restoring the normalised copy
          // would rewrite every line ending in the file while reporting "restored", which is the
          // class of quiet tree damage this project has already paid for once.
          writeFileSync(mutant.file, originals.get(mutant.file), 'utf8')
        }
      }

      console.log('mutation check: risk-based verification depth')
      console.log(`anchors verified against ${MUTANTS.length} mutants\n`)

      let survived = 0
      for (const row of rows) {
        const killed = row.verdict === 'KILLED'
        if (!killed) survived += 1
        console.log(`${row.verdict.padEnd(24)} ${row.id}  ${row.file}`)
        console.log(`  defect: ${row.defect}`)
        console.log(`  ${row.note}`)
        for (const name of row.failing ?? []) console.log(`    RED: ${name}`)
        console.log('')
      }

      // Restore verification. "The restore worked" must be a checked fact, not an assumption —
      // the same gap that once let two concurrent runs leave mutants applied while each reported
      // success.
      let restored = true
      for (const file of files) {
        const now = readFileSync(file, 'utf8')
        const intact = now === originals.get(file) && sha(now) === hashes.get(file)
        if (!intact) restored = false
        console.log(`  ${file}: ${intact ? 'intact' : `CHANGED ${hashes.get(file)} -> ${sha(now)}`}`)
      }
      console.log(`\nsources restored byte-for-byte: ${restored ? 'YES' : 'NO — INVESTIGATE'}`)

      const killedCount = rows.filter(row => row.verdict === 'KILLED').length
      console.log(`${killedCount}/${rows.length} mutants killed`)

      if (harnessError) {
        console.error(`harness error: ${harnessError.message}`)
        process.exitCode = 2
      } else if (!restored) {
        console.error('the harness did NOT restore every source byte-for-byte — the tree is dirty')
        process.exitCode = 3
      } else if (killedCount !== rows.length) {
        console.error(
          `${rows.length - killedCount} mutant(s) were not killed by the named test — the tests have a hole`,
        )
        process.exitCode = 1
      }
    },
    { label: LABEL },
  )
}

try {
  await main()
} catch (error) {
  if (error instanceof MutationLockHeld) {
    console.error(`${LABEL}: ${error.message}`)
    process.exit(EXIT_LOCK_HELD)
  }
  throw error
}
