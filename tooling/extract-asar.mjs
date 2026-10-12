/**
 * Extract named @deepseek-ai packages out of the packaged app.asar.
 *
 * The app ships its plugins inside `D:\DSH\resources\app.asar`; reading the
 * official implementations is the fastest way to learn an exact contract. This
 * helper is reusable for any package, not just the ones already extracted.
 *
 * Usage: node tooling/extract-asar.mjs <outDir> <pkg> [pkg...]
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const ASAR = 'D:\\DSH\\resources\\app.asar'

const [outDir, ...packages] = process.argv.slice(2)
if (!outDir || packages.length === 0) {
  console.error('usage: node extract-asar.mjs <outDir> <pkg> [pkg...]')
  process.exit(2)
}
if (!existsSync(ASAR)) {
  console.error(`app.asar not found at ${ASAR}`)
  process.exit(1)
}

const buffer = readFileSync(ASAR)
const jsonSize = buffer.readUInt32LE(12) & 0xffffff
const header = JSON.parse(buffer.toString('utf8', 16, 16 + jsonSize))
const base = 16 + jsonSize + ((4 - (jsonSize % 4)) % 4)

const entries = []
;(function walk(node, prefix) {
  for (const [key, value] of Object.entries(node.files ?? {})) {
    const path = prefix ? `${prefix}/${key}` : key
    if (value.files) walk(value, path)
    else entries.push([path, value])
  }
})(header, '')

let extracted = 0
let skipped = 0
for (const [path, entry] of entries) {
  const pkg = packages.find(p => path.startsWith(`dsh/node_modules/@deepseek-ai/${p}/`))
  if (!pkg) continue
  if (entry.unpacked) {
    skipped += 1
    continue
  }
  const relative = path.slice('dsh/node_modules/@deepseek-ai/'.length)
  const destination = join(outDir, relative)
  mkdirSync(dirname(destination), { recursive: true })
  const offset = Number(entry.offset)
  writeFileSync(destination, buffer.subarray(base + offset, base + offset + entry.size))
  extracted += 1
}

console.log(`extracted ${extracted} file(s); skipped ${skipped} unpacked entry(ies)`)
