/**
 * Line-ending normalisation, so a content identity check is about TEXT and not about bytes.
 *
 * WHY THIS EXISTS, AND THE MEASURED FACTS. Run `git ls-files --eol` in this checkout
 * (2026-10-25, branch recovery/p2b1-content) and every tracked blob is `i/lf` while dozens of
 * files carry `w/crlf` in the working tree — `lib/approval.js`, `lib/client.js`, `lib/review.js`,
 * `tooling/mutation-check*.mjs` among them (the set changes as files are added, so the command,
 * not a count in a comment, is the durable statement). So the SAME text exists as LF in the git index,
 * in `git diff` output, in a session log, and in anything a `write` tool emits, and as CRLF
 * on disk. Two places answered "is this the same content?" by comparing raw bytes, and both
 * gave a false answer:
 *
 *  - the review fingerprint (`lib/advance.js`) hashes the file bytes, so a file whose endings
 *    were re-materialised (a fresh checkout, a restore from an LF session log, an editor
 *    normalising on save) hashed differently with no text change: the review reported STALE
 *    and COMMIT/HANDOFF refused an unchanged artefact. During the 2026-10-25 recovery almost
 *    every recorded edit that failed to match came from exactly this — log LF, checkout CRLF;
 *  - `tooling/sync-to-profile.mjs --check` decided identity with `Buffer.equals`, so it
 *    printed `DIFFERS` / `n differ` for an installed copy that differed only in endings.
 *    That is a false alarm in the safe direction, but `--check` is the one read-only step
 *    that must stay believable.
 *
 * WHY NORMALISE INSTEAD OF RECORDING THE MODE. Persisting a line-ending mode next to a digest
 * would let a caller demand "same text AND same mode", but nothing here wants that: the
 * question every consumer asks is content identity. A mode field would also have to survive
 * in `FEATURES.json` evidence rows written by versions that do not carry it, so an old record
 * would become permanently unrecheckable. One shared rule is also what the mutation harnesses
 * already use for their anchors ("Anchors must be line-ending independent", docs/PITFALLS.md
 * §7) — two rules for the same fact drift apart.
 *
 * WHAT IS DELIBERATELY NOT NORMALISED:
 *  - content with no carriage return at all is returned AS THE SAME BUFFER, so every digest
 *    and comparison over LF bytes is exactly what it was before this module existed: existing
 *    fingerprints stay valid, and only a CRLF file's digest moves (which is the bug);
 *  - BINARY content (any NUL byte) is returned unchanged. Line endings are not a text concept
 *    there, and rewriting 0x0D bytes inside a PNG or a `.zst` would be corruption dressed up
 *    as normalisation. Binary identity stays byte identity;
 *  - this is NOT a writer. Nothing on disk is rewritten by importing this module; normalised
 *    bytes exist only for the length of a comparison or a hash.
 *
 * @module src-12453345_-dsh-workflow/eol
 */

/** Carriage return, line feed, NUL. Named so the byte arithmetic below reads as text. */
const CR = 13
const LF = 10
const NUL = 0

/**
 * Fold CRLF and a lone CR to LF, for identity checks only.
 *
 * @param buffer - raw file bytes (a Buffer; a string is encoded as UTF-8).
 * @returns a Buffer whose `\r\n` and lone `\r` are `\n`, or THE SAME Buffer when nothing can
 *   change (no CR at all, or a NUL byte marking binary content).
 */
export function normaliseLineEndings(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer ?? ''), 'utf8')
  if (!bytes.includes(CR)) return bytes
  if (bytes.includes(NUL)) return bytes
  const out = Buffer.allocUnsafe(bytes.length)
  let at = 0
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] === CR) {
      out[at] = LF
      at += 1
      // CRLF is ONE line ending, not two: consume the LF that follows the CR.
      if (bytes[index + 1] === LF) index += 1
      continue
    }
    out[at] = bytes[index]
    at += 1
  }
  return out.subarray(0, at)
}

/**
 * Whether two byte buffers carry the same text, ignoring line-ending style.
 *
 * Both sides are normalised, so "LF on the left, CRLF on the right" compares equal while a
 * real edit — any changed byte that is not part of a line ending — still differs.
 *
 * @param left - the first content (Buffer or string).
 * @param right - the second content (Buffer or string).
 * @returns true when the texts are the same.
 */
export function sameTextContent(left, right) {
  return normaliseLineEndings(left).equals(normaliseLineEndings(right))
}
