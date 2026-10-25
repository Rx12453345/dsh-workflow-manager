/**
 * Content identity across line-ending styles: the review fingerprint and `sync --check`.
 *
 * THE FAILURE THIS DEFENDS, AND WHY IT IS REAL HERE. In this checkout every tracked blob is
 * LF in the git index (`git ls-files --eol` reports `i/lf`) while 28 files are CRLF in the
 * working tree (`w/crlf`: `lib/approval.js`, `lib/client.js`, `lib/review.js`, the
 * `tooling/mutation-check*.mjs` harnesses, ... measured 2026-10-25 on recovery/p2b1-content).
 * The same text therefore reaches a hash or a comparison as either style, and the two
 * byte-comparing consumers each gave a false answer: the review fingerprint made an
 * unchanged file report STALE (COMMIT/HANDOFF then refuse it), and `sync --check` printed
 * DIFFERS for a copy that was the same text.
 *
 * WHAT IS PINNED HERE IS THE DIRECTION OF THE FIX, both ways: an EOL-only change must NOT be
 * a difference, and a real edit MUST still be one. A test that only proved the first half
 * would certify "make everything equal".
 *
 * Run with `node run-unit-tests.mjs` (see run-unit-tests.mjs for why `node --test` cannot be
 * used in this sandbox).
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { normaliseLineEndings, sameTextContent } from '../lib/eol.js'
import { fingerprint, reviewFreshness } from '../lib/advance.js'
import { planSync } from '../tooling/sync-plan.mjs'

function makeDir() {
  return mkdtempSync(join(tmpdir(), 'dsh-eol-'))
}

/** The same text with Windows line endings, as an editor or a checkout would leave it. */
const crlf = text => text.replace(/\n/g, '\r\n')

/** A review evidence row shaped the way `record-review` writes it. */
function reviewedFeature(dir, files, diff = '') {
  return {
    features: [
      {
        id: 'F001',
        passes: true,
        evidence: [
          {
            type: 'review',
            at: '2026-01-01T00:00:00.000Z',
            round: 1,
            overall: 9,
            passed: true,
            fingerprint: fingerprint(dir, files, diff),
            files_fingerprint: fingerprint(dir, files, '', ''),
            diff_hash: 'a'.repeat(64),
            files,
          },
        ],
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// the normaliser
// ---------------------------------------------------------------------------

test('CRLF and a lone CR fold to LF, and LF content is returned as the SAME buffer', () => {
  assert.equal(normaliseLineEndings(Buffer.from('a\r\nb\r\n')).toString('utf8'), 'a\nb\n')
  assert.equal(normaliseLineEndings(Buffer.from('a\rb')).toString('utf8'), 'a\nb', 'a lone CR is one line ending')
  assert.equal(normaliseLineEndings(Buffer.from('a\r\n\r\nb')).toString('utf8'), 'a\n\nb')

  // THE BACKWARD-COMPATIBILITY GUARANTEE: an LF file is not re-encoded at all, so every digest
  // and comparison recorded before this normaliser existed keeps the value it had.
  const lf = Buffer.from('let x = 1\nlet y = 2\n')
  assert.equal(normaliseLineEndings(lf), lf, 'LF content must be handed back untouched')

  assert.equal(sameTextContent('a\nb', 'a\r\nb'), true)
  assert.equal(sameTextContent('a\nb', 'a\nc'), false, 'a changed byte is still a change')
})

test('binary content is not normalised, because a 0x0D byte there is not a line ending', () => {
  // A NUL byte marks content whose 0x0D/0x0A bytes are data, not separators. Folding them
  // would be corruption dressed up as normalisation.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])
  assert.equal(normaliseLineEndings(png), png)
  const edited = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0b, 0x00])
  assert.equal(sameTextContent(png, edited), false)
})

// ---------------------------------------------------------------------------
// the review fingerprint
// ---------------------------------------------------------------------------

test('the fingerprint is the same for LF and CRLF bytes of one file, and still moves on an edit', () => {
  const dir = makeDir()
  try {
    writeFileSync(join(dir, 'a.js'), 'let x = 1\nlet y = 2\n', 'utf8')
    const lf = fingerprint(dir, ['a.js'])

    writeFileSync(join(dir, 'a.js'), crlf('let x = 1\nlet y = 2\n'), 'utf8')
    assert.equal(fingerprint(dir, ['a.js']), lf, 're-materialising the checkout must not move the digest')

    writeFileSync(join(dir, 'a.js'), crlf('let x = 1\nlet y = 3\n'), 'utf8')
    assert.notEqual(fingerprint(dir, ['a.js']), lf, 'a real edit must still invalidate the approval')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a CRLF checkout of an unchanged file keeps its recorded review FRESH, and a real edit stalls it', () => {
  const dir = makeDir()
  try {
    // The review was recorded over the LF bytes...
    writeFileSync(join(dir, 'a.js'), 'let x = 1\n', 'utf8')
    const features = reviewedFeature(dir, ['a.js'], 'diff --git a/a.js b/a.js\n')
    assert.equal(reviewFreshness(dir, undefined, features).state, 'fresh')

    // ...and the same text arrives from a CRLF checkout. That is not an edit.
    writeFileSync(join(dir, 'a.js'), crlf('let x = 1\n'), 'utf8')
    const afterEol = reviewFreshness(dir, undefined, features)
    assert.equal(afterEol.state, 'fresh', `EOL-only rewrite must stay fresh: ${afterEol.reason}`)
    assert.equal(afterEol.currentFileFingerprint, afterEol.reviewedFileFingerprint)

    // The same endings, one character changed: the review no longer covers this file.
    writeFileSync(join(dir, 'a.js'), crlf('let x = 2\n'), 'utf8')
    const stale = reviewFreshness(dir, undefined, features)
    assert.equal(stale.state, 'stale')
    assert.match(stale.reason, /reviewed files changed/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a fingerprint over a binary file is still byte-exact', () => {
  const dir = makeDir()
  try {
    writeFileSync(join(dir, 'image.bin'), Buffer.from([0x00, 0x0d, 0x0a, 0x01]))
    const before = fingerprint(dir, ['image.bin'])
    writeFileSync(join(dir, 'image.bin'), Buffer.from([0x00, 0x0d, 0x0a, 0x02]))
    assert.notEqual(fingerprint(dir, ['image.bin']), before)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------------------
// sync --check
// ---------------------------------------------------------------------------

/** A workspace root holding one file, and an installed root holding `target` bytes. */
function syncFixture(sourceText, targetText) {
  const src = makeDir()
  const dst = makeDir()
  mkdirSync(join(src, 'lib'), { recursive: true })
  mkdirSync(join(dst, 'lib'), { recursive: true })
  writeFileSync(join(src, 'lib', 'a.js'), sourceText, 'utf8')
  writeFileSync(join(dst, 'lib', 'a.js'), targetText, 'utf8')
  return { src, dst, label: join('lib', 'a.js') }
}

test('sync --check reports no difference for a CRLF copy of the same text — and names the byte fact', async () => {
  const fixture = syncFixture('let x = 1\nlet y = 2\n', crlf('let x = 1\nlet y = 2\n'))
  try {
    const report = await planSync({ src: fixture.src, dst: fixture.dst, include: ['lib'], checkOnly: true })
    assert.deepEqual(report.differ, [], 'an EOL-only difference must not be reported as DIFFERS')
    assert.deepEqual(report.eolOnly, [fixture.label], 'the byte-level fact is still reported, not hidden')
    assert.equal(report.identical.length, 1)
    assert.deepEqual(report.copied, [], 'a check writes nothing')
  } finally {
    rmSync(fixture.src, { recursive: true, force: true })
    rmSync(fixture.dst, { recursive: true, force: true })
  }
})

test('sync --check still reports a real edit — the EOL relaxation does not hide changes', async () => {
  const fixture = syncFixture('let x = 1\n', crlf('let x = 9\n'))
  try {
    const report = await planSync({ src: fixture.src, dst: fixture.dst, include: ['lib'], checkOnly: true })
    assert.deepEqual(report.differ, [fixture.label])
    assert.deepEqual(report.eolOnly, [])
    // A binary difference is not mistaken for a text one either.
    writeFileSync(join(fixture.src, 'lib', 'b.bin'), Buffer.from([0x00, 0x0d, 0x0a, 0x01]))
    writeFileSync(join(fixture.dst, 'lib', 'b.bin'), Buffer.from([0x00, 0x0d, 0x0a, 0x02]))
    const withBinary = await planSync({ src: fixture.src, dst: fixture.dst, include: ['lib'], checkOnly: true })
    assert.ok(withBinary.differ.includes(join('lib', 'b.bin')))
  } finally {
    rmSync(fixture.src, { recursive: true, force: true })
    rmSync(fixture.dst, { recursive: true, force: true })
  }
})

test('a sync leaves an EOL-only file alone instead of rewriting bytes for no change', async () => {
  const target = crlf('let x = 1\n')
  const fixture = syncFixture('let x = 1\n', target)
  try {
    const report = await planSync({ src: fixture.src, dst: fixture.dst, include: ['lib'], checkOnly: false })
    assert.deepEqual(report.copied, [], 'nothing to copy: same text')
    assert.deepEqual(report.eolOnly, [fixture.label])
    assert.equal(readFileSync(join(fixture.dst, 'lib', 'a.js'), 'utf8'), target, 'the installed bytes are untouched')
  } finally {
    rmSync(fixture.src, { recursive: true, force: true })
    rmSync(fixture.dst, { recursive: true, force: true })
  }
})

test('a sync still copies a real edit and a file the profile does not have', async () => {
  const fixture = syncFixture('let x = 1\n', crlf('let x = 9\n'))
  try {
    writeFileSync(join(fixture.src, 'lib', 'new.js'), 'let z = 3\n', 'utf8')
    const report = await planSync({ src: fixture.src, dst: fixture.dst, include: ['lib'], checkOnly: false })
    assert.deepEqual(report.copied.sort(), [fixture.label, join('lib', 'new.js')].sort())
    assert.equal(readFileSync(join(fixture.dst, 'lib', 'a.js'), 'utf8'), 'let x = 1\n')
    assert.equal(readFileSync(join(fixture.dst, 'lib', 'new.js'), 'utf8'), 'let z = 3\n')
  } finally {
    rmSync(fixture.src, { recursive: true, force: true })
    rmSync(fixture.dst, { recursive: true, force: true })
  }
})
