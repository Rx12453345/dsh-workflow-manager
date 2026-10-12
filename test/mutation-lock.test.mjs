/**
 * The mutation harnesses' mutual-exclusion lock.
 *
 * THE DEFECT THESE TESTS PIN
 * Two mutation harnesses ran concurrently by mistake. Both rewrote `lib/client.js`, and two
 * mutants were left APPLIED in the source tree while each process reported its own restore as
 * byte-for-byte clean — because each one only ever verified itself. The suite caught that pair
 * by luck; a subtler mutant would have left silent corruption behind.
 *
 * What is tested here is the guarantee that replaces the luck:
 *
 *  1. ACQUISITION IS ATOMIC. Independent processes race for the lock; exactly one wins, and
 *     the losers fail with the concurrency message rather than waiting.
 *  2. A HELD LOCK FAILS LOUDLY, naming the holder's label — never a silent queue.
 *  3. RELEASE happens on normal return, on a throw, and on SIGTERM.
 *  4. A STALE LOCK IS TAKEN OVER AND SAID SO. A pid that is gone, or a lock past the cap,
 *     must not wedge the tool forever; the take-over is reported, not silent.
 *  5. AN UNREADABLE LOCK IS STALE, not a permanent wedge — it cannot name a holder to respect.
 *  6. AN UNREADABLE AGE IS NOT AN INFINITELY OLD LOCK. This is separate from (5): a record that
 *     DOES name a live holder but whose `at` cannot be read must be REFUSED, not stolen. The
 *     defect was `typeof holder.at === 'number' ? holder.at : 0`, which read such a record as
 *     epoch 0 and therefore as "infinitely old" — so a live holder was taken over with a message
 *     claiming the lock was 1791808015s old (the whole Unix timestamp: the signature of
 *     `Date.now() - 0`). Unknown is not old. See the `an unreadable age ...` tests below.
 *
 * Child processes are the real files `tooling/mutation-lock-holder-child.mjs` and
 * `tooling/mutation-lock-attacker-child.mjs`, so the quoting of a temp path cannot silently
 * change what a case proves.
 *
 * Run with `node --test test/`.
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { EXIT_LOCK_HELD, MutationLockHeld, withMutationLock } from '../tooling/mutation-lock.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const HOLDER_CHILD = join(ROOT, 'tooling', 'mutation-lock-holder-child.mjs')
const ATTACKER_CHILD = join(ROOT, 'tooling', 'mutation-lock-attacker-child.mjs')
const scratch = mkdtempSync(join(tmpdir(), 'dsh-mutation-lock-'))
let counter = 0

/** A fresh lock path per case, so no case can see another's file. */
function freshPath() {
  counter += 1
  return join(scratch, `case-${counter}`, '.mutation-lock')
}

function writeLockFile(path, record) {
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, typeof record === 'string' ? record : JSON.stringify(record), 'utf8')
}

/** Start a holder child that holds the lock for `holdMs`. */
function startHolder(path, holdMs, gatePath) {
  const args = [HOLDER_CHILD, path, String(holdMs), 'the child holder']
  if (gatePath) args.push(gatePath)
  const child = spawn(process.execPath, args, { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] })
  if (process.env.MUTATION_LOCK_TEST_DEBUG === '1') {
    const chunks = []
    child.stdout.on('data', chunk => chunks.push([String(chunk), '']))
    child.stderr.on('data', chunk => chunks.push(['', String(chunk)]))
    child.on('exit', code => {
      console.error(`[debug] spawn argv=${JSON.stringify(args)} -> code=${code} out=${JSON.stringify(chunks)}`)
    })
  }
  return child
}

/**
 * Release `count` children at the same moment and collect their outcomes.
 *
 * The gate file appears only after every child has been started, and each child polls for it
 * before touching the lock — otherwise process startup (~100ms) spreads the children across
 * the ~2s hold and they take the lock in turn. A race test that cannot fail is not evidence.
 */
async function raceForLock(path, { count = 4, holdMs = 2000 } = {}) {
  const gate = `${path}.gate`
  mkdirSync(join(path, '..'), { recursive: true })
  const children = []
  for (let index = 0; index < count; index += 1) {
    children.push(
      spawn(process.execPath, [HOLDER_CHILD, path, String(holdMs), 'the child holder', gate], {
        cwd: ROOT,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    )
  }
  await new Promise(resolve => setTimeout(resolve, 400))
  writeFileSync(gate, 'go', 'utf8')
  const results = await Promise.all(children.map(child => collect(child, 40000)))
  rmSync(gate, { force: true })
  return results
}

/** Collect a child's stdout+stderr and its exit status, with a hard timeout. */
function collect(child, timeoutMs = 30000) {
  let output = ''
  child.stdout?.on('data', chunk => {
    output += String(chunk)
  })
  child.stderr?.on('data', chunk => {
    output += String(chunk)
  })
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`child did not exit within ${timeoutMs}ms: ${output}`))
    }, timeoutMs)
    child.on('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, output })
    })
  })
}

/** Resolve once the child's output contains `needle`. */
function outputContains(child, needle, timeoutMs = 20000) {
  const state = { output: '' }
  const seen = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`child never printed "${needle}": ${state.output}`)), timeoutMs)
    const onData = chunk => {
      state.output += String(chunk)
      if (state.output.includes(needle)) {
        clearTimeout(timer)
        resolve()
      }
    }
    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
  })
  return { seen, state }
}

/**
 * Try to take an EXISTING lock file and report what happened, including the take-over warnings.
 *
 * The warnings matter as much as the outcome here: a take-over that happens silently is half the
 * defect, and the reason it prints ("the lock is old" vs "the holder is gone") is how a reader
 * tells WHICH staleness rule fired. On a take-over the callback reports the record now on disk —
 * the winner's own — which is why the case can check `taken` rather than guess. The lock this
 * acquired is released again, so a later case never inherits it.
 */
async function attemptTakeOver(path, label = 'the next harness') {
  const warnings = []
  const realWarn = console.warn
  console.warn = (...args) => {
    warnings.push(args.join(' '))
  }
  const outcome = { error: null, warnings, result: null }
  try {
    outcome.result = await withMutationLock(
      async () => {
        let onDisk = null
        try {
          onDisk = JSON.parse(readFileSync(path, 'utf8'))
        } catch {
          onDisk = null
        }
        return { taken: existsSync(path) && onDisk?.pid === process.pid, label: onDisk?.label ?? null, at: onDisk?.at ?? null }
      },
      { label, path },
    )
  } catch (error) {
    outcome.error = error
  } finally {
    console.warn = realWarn
  }
  return outcome
}

test.after(() => rmSync(scratch, { recursive: true, force: true }))

test('the lock is held inside the critical section and gone after it', async () => {
  const path = freshPath()
  let heldDuring = false
  const value = await withMutationLock(
    async () => {
      heldDuring = existsSync(path)
      return 'the callback result'
    },
    { label: 'test/holder', path },
  )
  assert.equal(value, 'the callback result', 'the lock passes the callback result through')
  assert.equal(heldDuring, true, 'the lock file exists inside the callback')
  assert.equal(existsSync(path), false, 'the lock file is removed after a normal return')
})

test('a second acquisition fails loudly, naming the holder and forbidding concurrency', async () => {
  const path = freshPath()
  await withMutationLock(
    async () => {
      let thrown = null
      try {
        await withMutationLock(async () => {}, { label: 'the second harness', path })
      } catch (error) {
        thrown = error
      }
      assert.ok(thrown instanceof MutationLockHeld, 'the second acquisition throws MutationLockHeld')
      assert.match(thrown.message, /another mutation harness is already running/)
      assert.match(thrown.message, /label=the first harness/, "the holder's label is named")
      assert.match(thrown.message, new RegExp(`pid=${process.pid}`), "the holder's pid is named")
      assert.match(thrown.message, /Do NOT run two mutation harnesses/)
      assert.equal(existsSync(path), true, 'the refused attempt leaves the holder lock in place')
    },
    { label: 'the first harness', path },
  )
})

test('independent processes race for the lock and exactly one wins per round', async () => {
  for (let round = 1; round <= 3; round += 1) {
    const path = freshPath()
    const results = await raceForLock(path, { count: 4, holdMs: 2000 })
    const winners = results.filter(result => result.code === 0 && result.output.includes('ACQUIRED'))
    const losers = results.filter(result => result.code === EXIT_LOCK_HELD)
    assert.equal(
      winners.length,
      1,
      `round ${round}: exactly one of four processes took the lock: ${JSON.stringify(results.map(r => [r.code, r.output.slice(0, 80)]))}`,
    )
    assert.equal(losers.length, 3, `round ${round}: the other three failed fast instead of queueing`)
    for (const loser of losers) {
      assert.match(loser.output, /another mutation harness is already running/)
      assert.match(loser.output, /label=the child holder/)
    }
    assert.equal(existsSync(path), false, `round ${round}: the lock is released once the winner exits`)
  }
})

test('a live holder makes the next starter exit with the lock-held code', async () => {
  const path = freshPath()
  const holder = startHolder(path, 8000)
  const { seen } = outputContains(holder, 'ACQUIRED')
  await seen
  assert.equal(existsSync(path), true, 'the holder really has the lock on disk')

  const loser = spawnSync(process.execPath, [ATTACKER_CHILD, path, 'the loser'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(loser.status, EXIT_LOCK_HELD, `the loser exits ${EXIT_LOCK_HELD}, not 0: ${loser.stderr}`)
  assert.match(loser.stdout, /another mutation harness is already running/)
  assert.match(loser.stdout, /label=the child holder/)
  assert.equal(existsSync(path), true, 'the loser did not disturb the holder lock')

  const exited = await collect(holder)
  assert.equal(exited.code, 0, 'the holder still finishes normally and releases')
  assert.equal(existsSync(path), false, 'the holder released on the way out')
})

test('a lock whose holder pid is gone is taken over', async () => {
  const path = freshPath()
  // A pid that cannot be running; `kill(pid, 0)` answers ESRCH for it.
  writeLockFile(path, { pid: 0x7fffff0, at: Date.now(), host: 'gone-host', label: 'the killed harness' })

  let ran = false
  await withMutationLock(
    async () => {
      ran = true
    },
    { label: 'the next harness', path },
  )
  assert.equal(ran, true, 'the next harness ran despite the stale lock')
  assert.equal(existsSync(path), false, 'the taken-over lock is released normally afterwards')
})

test('a lock past the time cap is taken over even when the recorded pid is alive', async () => {
  const path = freshPath()
  // The pid IS this process — alive — so only the timestamp can free the lock.
  writeLockFile(path, { pid: process.pid, at: Date.now() - 60 * 60 * 1000, host: 'this-host', label: 'the overrunning harness' })

  let ran = false
  await withMutationLock(
    async () => {
      ran = true
    },
    { label: 'the next harness', path },
  )
  assert.equal(ran, true, 'an over-cap lock does not wedge the next run')
})

// ---------------------------------------------------------------------------------------------
// AN UNREADABLE AGE IS NOT AN INFINITELY OLD LOCK.
//
// These cases pin the fix for `typeof holder.at === 'number' ? holder.at : 0`. That expression
// read a record with a string `at` as epoch 0, so the record looked infinitely old and a LIVE
// holder was taken over. The three cases below must stay distinct:
//   unknown age + live pid  -> REFUSE   (this is the one that used to be stolen)
//   unknown age + dead pid  -> take over (keeps a corrupt record from wedging the tool)
//   readable age + any pid  -> normal comparison (old: take over; recent: refuse)
// ---------------------------------------------------------------------------------------------

test('an unreadable age with a LIVE holder is refused, not read as an infinitely old lock', async () => {
  const path = freshPath()
  // The shape of the record the adversarial test wrote by hand: a string `at`, and the pid of a
  // process that IS running (this one, so the case does not depend on anything else being up).
  // The acquisition time is genuinely unreadable here — a free-text line, not a timestamp — so
  // this is the "the holder is readable but the age is not" case the defect collapsed into
  // "infinitely old". Before the fix it was stolen with "the lock is 1791808015s old", 1791808015
  // being the whole Unix timestamp, i.e. `Date.now() - 0`.
  writeLockFile(path, {
    at: 'the first harness never wrote a usable timestamp',
    label: 'manual-hold-live',
    pid: process.pid,
    host: 'manual-test',
  })
  assert.equal(existsSync(path), true, 'the hand-written record is on disk')

  const { error, warnings } = await attemptTakeOver(path, 'the next harness')

  assert.ok(error instanceof MutationLockHeld, 'a record naming a live holder is refused')
  assert.match(error.message, /manual-hold-live/, "the refusal names the holder's own label")
  assert.match(error.message, new RegExp(`pid=${process.pid}`), "the refusal names the holder's pid")
  assert.match(
    error.message,
    new RegExp(`the holder pid ${process.pid} is still running and the lock's age could not be determined`),
    'the refusal says WHY it refused: the age could not be determined',
  )
  assert.match(error.message, /missing or unreadable/, 'the refusal names the unreadable acquisition time')
  assert.doesNotMatch(error.message, /\bover\b/, 'an unreadable age is never reported as over the cap')
  assert.equal(warnings.length, 0, `nothing was taken over here: ${JSON.stringify(warnings)}`)
  assert.equal(existsSync(path), true, "the live holder's lock file is left exactly where it was")
  assert.equal(readFileSync(path, 'utf8').includes('manual-hold-live'), true, 'the record was not rewritten')
})

test('an unparseable age with a LIVE holder is refused the same way', async () => {
  const path = freshPath()
  // The pid IS this process — alive — so only a value that reads as "infinitely old" could have
  // freed this lock. A garbage age must not: an incident-shaped case, not a hypothetical one.
  writeLockFile(path, { pid: process.pid, at: 'whenever the first harness started', host: 'this-host', label: 'the garbled harness' })

  const { error, warnings } = await attemptTakeOver(path, 'the next harness')

  assert.ok(error instanceof MutationLockHeld, 'a garbage age does not authorise stealing a live lock')
  assert.match(error.message, new RegExp(`the holder pid ${process.pid} is still running and the lock's age could not be determined`))
  assert.doesNotMatch(error.message, /\bover\b/, 'no unreadable age is reported as over the cap')
  assert.equal(warnings.length, 0, 'no take-over was reported')
  assert.equal(existsSync(path), true, "the lock is still the holder's")
})

test('epoch SECONDS is not read as milliseconds, and unknown still beats a live pid', async () => {
  const path = freshPath()
  // 1790000000 seconds is 2026-09-28. Read as milliseconds it would be 1970-01-01, i.e.
  // "infinitely old", and a live holder would be stolen. 10 digits cannot honestly be epoch
  // milliseconds, so it is refused (unknown) rather than multiplied or guessed at.
  writeLockFile(path, { pid: process.pid, at: '1790000000', host: 'this-host', label: 'the seconds-unit harness' })

  const { error, warnings } = await attemptTakeOver(path, 'the next harness')

  assert.ok(error instanceof MutationLockHeld, 'a seconds-unit age is unknown, not infinitely old')
  assert.match(error.message, /age could not be determined/)
  assert.doesNotMatch(error.message, /\bover\b/)
  assert.equal(warnings.length, 0, 'nothing was taken over')
})

test('an unreadable age with a DEAD holder is still taken over, so a corrupt record cannot wedge the tool', async () => {
  const path = freshPath()
  // A pid that cannot be running: `kill(pid, 0)` answers ESRCH for it.
  const deadPid = 0x7fffff0
  writeLockFile(path, { pid: deadPid, at: 'the first harness never wrote a usable timestamp', host: 'gone-host', label: 'the killed harness' })

  const { error, warnings, result } = await attemptTakeOver(path, 'the next harness')

  assert.equal(error, null, 'the unreadable record is recovered, not refused forever')
  assert.equal(result.taken, true, 'the next harness really holds the lock now')
  assert.equal(warnings.length, 1, 'the take-over is reported out loud')
  assert.match(warnings[0], /taking over a stale lock/)
  assert.match(
    warnings[0],
    new RegExp(`the holder pid ${deadPid} is no longer running \\(the lock's age could not be determined\\)`),
    'the reader is told the holder was GONE, not that the lock was old',
  )
  assert.equal(warnings[0].includes('1970-01-01'), false, 'no fabricated epoch-0 acquisition time is printed')
  assert.equal(warnings[0].includes('acquired=?'), true, 'the unreadable acquisition time is shown as unknown')
  assert.equal(existsSync(path), false, 'the recovering run released normally')
})

test('a bare date string is not guessed: unknown age, so a live holder is refused and a dead one is taken over', async () => {
  const path = freshPath()
  // `Date.parse('2026-10-12')` is midnight UTC, but a human writing that means local midnight —
  // nearly a day of ambiguity against a 30-minute cap. The reader refuses it rather than picking
  // a timezone, so it lands on the unknown-age path. The exact date is not what decides this
  // case: the assertion is about the SHAPE, which is why a relative date is enough.
  const bareDate = new Date().toISOString().slice(0, 10)

  writeLockFile(path, { pid: process.pid, at: bareDate, host: 'this-host', label: 'the ambiguous harness' })
  const live = await attemptTakeOver(path, 'the next harness')
  assert.ok(live.error instanceof MutationLockHeld, 'a bare date with a live pid is refused, not guessed at')
  assert.match(live.error.message, /age could not be determined/)
  assert.equal(live.warnings.length, 0, 'no take-over for a live holder')
  assert.equal(existsSync(path), true, 'the lock is untouched')

  writeLockFile(path, { pid: 0x7fffff0, at: bareDate, host: 'gone-host', label: 'the ambiguous harness' })
  const dead = await attemptTakeOver(path, 'the next harness')
  assert.equal(dead.error, null, 'a bare date with a dead pid is still recovered')
  assert.match(dead.warnings[0], /no longer running/)
})

// ---------------------------------------------------------------------------------------------
// THE TYPE-TOLERANT READ, AND THE RULE THAT KEEPS IT FROM BEING A GUESS.
//
// A numeric string of epoch milliseconds and an ISO/RFC-3339 timestamp with an explicit offset
// are READ, so they go through the normal comparison. Anything else is UNKNOWN — never guessed:
// no bare dates, no unspecific clock times, no seconds/milliseconds conversion.
// ---------------------------------------------------------------------------------------------

test('a parseable string timestamp is READ: a recent one is refused as live-inside-the-cap, an old one is taken over', async () => {
  const path = freshPath()
  const iso = offsetMs => new Date(Date.now() - offsetMs).toISOString()

  // (a) RECENT — within the real 30-minute cap, with a live pid. If the value were treated as
  // unknown the refusal would say "the age could not be determined"; if it were treated as epoch
  // 0 it would be stolen. It must do neither: the derived age has to be genuinely small.
  writeLockFile(path, { pid: process.pid, at: iso(60 * 1000), host: 'this-host', label: 'the string-at harness' })
  const recent = await attemptTakeOver(path, 'the next harness')
  assert.ok(recent.error instanceof MutationLockHeld, 'a recent string `at` with a live pid is refused')
  assert.match(recent.error.message, /the holder pid is still running/, 'the normal comparison ran: the holder is live and inside the cap')
  assert.doesNotMatch(recent.error.message, /age could not be determined/, 'the age WAS determined')
  assert.doesNotMatch(recent.error.message, /\bover the\b/, 'a recent timestamp is not over the cap')
  assert.equal(recent.warnings.length, 0, 'nothing was taken over')

  // (b) OLD — with a TTL this file sets itself, so the over-cap path is proved reachable THROUGH
  // the parsed value: only a readable age can print "600s old, over the 60s cap". An unreadable
  // value would print "the lock's age could not be determined" instead.
  process.env.MUTATION_LOCK_TTL_MS = String(60 * 1000)
  try {
    writeLockFile(path, { pid: process.pid, at: iso(600 * 1000), host: 'this-host', label: 'the overrunning string-at harness' })
    assert.equal(existsSync(path), true, 'the old string-`at` record is on disk')
    const old = await attemptTakeOver(path, 'the next harness')
    assert.equal(old.error, null, 'the over-cap string-`at` lock is taken over')
    assert.equal(old.result.taken, true, 'the next harness holds the lock now')
    assert.equal(old.warnings.length, 1, 'the take-over is reported')
    assert.match(old.warnings[0], /the lock is 600s old, over the 60s cap/)
    assert.match(old.warnings[0], /even though the holder pid \S+ is still running/, 'the reader is told the pid looked alive and the lock was still old')
    assert.doesNotMatch(old.warnings[0], /could not be determined/, 'a readable string age never lands on the unknown path')
    assert.doesNotMatch(old.warnings[0], /1970-01-01/, 'the parsed age is the recorded one, not epoch 0')
  } finally {
    delete process.env.MUTATION_LOCK_TTL_MS
  }

  // (c) A READABLE string `at` that is well inside the cap, with a DEAD pid. The age is known, so
  // this is the ordinary "the holder is gone" recovery — NOT the unknown-age recovery. The
  // difference is visible in the message: no "the age could not be determined" here, and no
  // fabricated epoch-0 acquisition time either.
  const deadPid = 0x7fffff0
  writeLockFile(path, { pid: deadPid, at: iso(30 * 1000), host: 'gone-host', label: 'the string-at killed harness' })
  const gone = await attemptTakeOver(path, 'the next harness')
  assert.equal(gone.error, null, 'a readable string age with a dead pid is taken over')
  assert.equal(gone.result.taken, true, 'the next harness holds the lock now')
  assert.match(gone.warnings[0], new RegExp(`the holder pid ${deadPid} is no longer running`))
  assert.doesNotMatch(gone.warnings[0], /could not be determined/, 'the age WAS readable, so this is the "holder gone" reason')
  assert.doesNotMatch(gone.warnings[0], /1970-01-01/, 'the readable age is reported as read, not as epoch 0')

  // (d) The same tolerance covers the other spellings a hand-written record can use: a lowercase
  // `z` zone marker, an explicit `+00:00` offset, and a pure-integer epoch-milliseconds string.
  // Each is READ, which for a recent live holder means the ordinary "still running" refusal.
  for (const [spelling, at] of [
    ['a lowercase z zone', iso(60 * 1000).replace('Z', 'z')],
    ['an explicit +00:00 offset', iso(60 * 1000).replace('Z', '+00:00')],
    ['a numeric epoch-milliseconds string', String(Date.now() - 60 * 1000)],
  ]) {
    writeLockFile(path, { pid: process.pid, at, host: 'this-host', label: 'the string-at harness' })
    const read = await attemptTakeOver(path, 'the next harness')
    assert.ok(read.error instanceof MutationLockHeld, `${spelling} is read, so a recent live holder is refused`)
    assert.doesNotMatch(read.error.message, /age could not be determined/, `${spelling} did not fall into the unknown path`)
    assert.match(read.error.message, /the holder pid is still running/, `${spelling} went through the normal comparison`)
    assert.equal(read.warnings.length, 0, `${spelling}: nothing was taken over`)
  }
})

test('the take-over is reported rather than silent', async () => {
  const path = freshPath()
  writeLockFile(path, { pid: 0x7fffff0, at: Date.now(), host: 'gone-host', label: 'the killed harness' })

  // A real harness reports the take-over on stderr; saying so out loud is the whole point.
  const child = spawnSync(process.execPath, [HOLDER_CHILD, path, '0', 'the next harness'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(child.status, 0, `the take-over run succeeds: ${child.stderr}`)
  assert.match(child.stderr, /taking over a stale lock/)
  assert.match(child.stderr, /label=the killed harness/)
})

test('a stale lock whose process was hard-killed is recovered, and the source is usable again', async () => {
  const path = freshPath()
  const holder = startHolder(path, 60000)
  const { seen } = outputContains(holder, 'ACQUIRED')
  await seen
  assert.equal(existsSync(path), true, 'the holder has the lock')

  const exited = collect(holder)
  holder.kill('SIGKILL')
  await exited
  assert.equal(existsSync(path), true, 'SIGKILL leaves the lock file behind — that is the hazard')

  const next = spawnSync(process.execPath, [HOLDER_CHILD, path, '0', 'the next harness'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(next.status, 0, `the next run is not wedged: ${next.stderr}`)
  assert.match(next.stdout, /ACQUIRED/)
  assert.match(next.stderr, /taking over a stale lock/)
  assert.match(next.stderr, /no longer running/)
  assert.equal(existsSync(path), false, 'the recovering run released normally')
})

test('a malformed lock file is treated as stale rather than as a permanent wedge', async () => {
  const path = freshPath()
  writeLockFile(path, 'this is not JSON')
  let ran = false
  await withMutationLock(
    async () => {
      ran = true
    },
    { label: 'the next harness', path },
  )
  assert.equal(ran, true, 'an unreadable lock cannot name a holder, so it is not respected forever')
})

test('a thrown error releases the lock and propagates', async () => {
  const path = freshPath()
  await assert.rejects(
    withMutationLock(
      async () => {
        throw new Error('the mutated suite blew up')
      },
      { label: 'the failing harness', path },
    ),
    /the mutated suite blew up/,
  )
  assert.equal(existsSync(path), false, 'the lock is released after a throw')

  let ran = false
  await withMutationLock(
    async () => {
      ran = true
    },
    { label: 'the next harness', path },
  )
  assert.equal(ran, true, 'the next run is not blocked by the failed one')
})

test('a hard-killed holder leaves the lock behind, and the next run recovers it', async () => {
  const path = freshPath()
  const holder = startHolder(path, 60000)
  const { seen } = outputContains(holder, 'ACQUIRED')
  await seen
  assert.equal(existsSync(path), true, 'the holder has the lock')

  // SIGKILL: no handler runs, which is the whole hazard. On Windows this is also what a
  // "SIGTERM" from Node performs (TerminateProcess), so the recovery path below is the one
  // that has to work there.
  const exited = collect(holder)
  holder.kill('SIGKILL')
  await exited
  assert.equal(existsSync(path), true, 'a hard kill leaves the lock file behind')

  const next = spawnSync(process.execPath, [HOLDER_CHILD, path, '0', 'the next harness'], { cwd: ROOT, encoding: 'utf8' })
  assert.equal(next.status, 0, `the next run is not wedged: ${next.stderr}`)
  assert.match(next.stdout, /ACQUIRED/)
  assert.match(next.stderr, /taking over a stale lock/)
  assert.match(next.stderr, /no longer running/)
  assert.equal(existsSync(path), false, 'the recovering run released normally')
})

test(
  'a signal releases the lock and the process dies with a non-zero status',
  { skip: process.platform === 'win32' ? 'Windows has no catchable SIGTERM: kill() calls TerminateProcess, so no JS signal handler can run there' : false },
  async () => {
    const path = freshPath()
    const child = startHolder(path, 60000)
    const { seen } = outputContains(child, 'ACQUIRED')
    await seen
    assert.equal(existsSync(path), true, 'the child holds the lock while it runs')
    assert.match(readFileSync(path, 'utf8'), /the child holder/, 'the lock records the holder label')

    const exited = collect(child)
    child.kill('SIGTERM')
    const result = await exited
    assert.notEqual(result.code, 0, 'a signalled run is not reported as a success')
    assert.equal(existsSync(path), false, 'SIGTERM released the lock before the process died')
  },
)

test('the installed signal handler releases the lock and re-raises the signal', async () => {
  const path = freshPath()
  // The handler is called DIRECTLY rather than through a real or emitted signal. A real
  // SIGTERM cannot be tested on Windows (Node maps it to TerminateProcess, so no handler
  // runs at all), and `process.emit('SIGINT')` looks like an interrupt to node's own test
  // runner, which is how this test was intermittently red before. What is load-bearing is
  // that the lock registers a handler and that the handler releases — both are checked here.
  const realKill = process.kill
  const killCalls = []
  let handlerResult = null
  try {
    handlerResult = await withMutationLock(
      async () => {
        const handlers = process.listeners('SIGTERM').filter(listener => listener.name === 'onSignal')
        assert.equal(handlers.length, 1, 'exactly one signal handler is installed while the lock is held')
        process.kill = (pid, signal) => {
          killCalls.push([pid, signal])
          return true
        }
        handlers[0]('SIGTERM')
        return { releasedDuringRun: !existsSync(path), killCalls: [...killCalls] }
      },
      { label: 'the signalled harness', path },
    )
  } finally {
    // Restored even on failure: this patch lives in the shared single test process, and
    // leaving it installed would break every later test that spawns a child.
    process.kill = realKill
  }

  assert.equal(handlerResult.releasedDuringRun, true, 'the handler released the lock during the run')
  assert.deepEqual(handlerResult.killCalls, [[process.pid, 'SIGTERM']], 'the handler re-raises the same signal')
  assert.equal(existsSync(path), false, 'no lock file is left behind')
  assert.equal(process.listeners('SIGTERM').filter(listener => listener.name === 'onSignal').length, 0, 'the handler is removed on release')
  assert.equal(process.kill, realKill, 'nothing patched process.kill permanently')
})
