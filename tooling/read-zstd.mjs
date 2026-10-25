/**
 * Decompress a multi-frame zstd file completely.
 *
 * Node's `zstdDecompressSync` stops at the first frame end and reports a
 * "premature end" for the rest, so a session log written in many frames only
 * yields a few bytes. This walks the buffer frame by frame instead.
 *
 * Usage: node tooling/read-zstd.mjs <input.zstd> <output.txt>
 */

import { readFileSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const input = process.argv[2]
const output = process.argv[3]
if (!input || !output) {
  console.error('usage: node read-zstd.mjs <input.zstd> <output.txt>')
  process.exit(2)
}

const buffer = readFileSync(input)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

// Locate every frame header, then decompress the slice between consecutive ones.
const starts = []
for (let i = 0; i + 4 <= buffer.length; i += 1) {
  if (
    buffer[i] === MAGIC[0] &&
    buffer[i + 1] === MAGIC[1] &&
    buffer[i + 2] === MAGIC[2] &&
    buffer[i + 3] === MAGIC[3]
  ) {
    starts.push(i)
  }
}

const parts = []
let failed = 0
for (let index = 0; index < starts.length; index += 1) {
  const from = starts[index]
  const to = index + 1 < starts.length ? starts[index + 1] : buffer.length
  try {
    parts.push(zstdDecompressSync(buffer.subarray(from, to)).toString('utf8'))
  } catch {
    failed += 1
  }
}

// Fall back to a single-shot attempt when no frame boundary parsed.
if (parts.length === 0) {
  try {
    parts.push(zstdDecompressSync(buffer).toString('utf8'))
  } catch (error) {
    console.error(`all frame attempts failed: ${error?.message ?? error}`)
    process.exit(1)
  }
}

const text = parts.join('')
writeFileSync(output, text)
console.log(`frames: ${starts.length}, decompressed: ${parts.length}, failed: ${failed}`)
console.log(`bytes: ${text.length}, lines: ${text.split('\n').length}`)
