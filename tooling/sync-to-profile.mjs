// Sync the workspace plugin into the profile's installed copy.
//
// WHY THIS EXISTS: the profile declares the plugin as a `file:` dependency and the
// loader still materialises a COPY rather than a symlink, so editing
// a checkout has NO effect until the files are copied across and DSH is restarted.
// Forgetting this step produces the worst kind of bug report: "I fixed it and
// nothing changed".
//
// Usage:  node sync-to-profile.mjs [--check]
//   (default) copy this checkout -> the profile's installed copy
//   --check   report differences without writing
//   DSH_WORKFLOW_SRC / DSH_PROFILE_DIR override the two roots.

import { cp, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = process.env.DSH_WORKFLOW_SRC ?? resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PROFILE_DIR = process.env.DSH_PROFILE_DIR ?? join(homedir(), '.dsh', 'profiles', 'desktop')
const DST = join(PROFILE_DIR, 'node_modules', 'src-12453345_-dsh-workflow')

/**
 * Everything the runtime needs. `tooling/` is shipped because `lib/review.js` reads the
 * mutation-harness table from it; without this copy an installed review honestly reports
 * the table as UNREADABLE. `test/` stays workspace-only.
 */
const INCLUDE = ['lib', 'tooling', 'package.json', 'cordis.patch.yml', 'README.md']

const checkOnly = process.argv.includes('--check')

async function walk(root, prefix = '') {
  const out = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? join(prefix, entry.name) : entry.name
    if (entry.isDirectory()) out.push(...(await walk(root, rel)))
    else out.push(rel)
  }
  return out
}

let copied = 0
let identical = 0
const missing = []

for (const entry of INCLUDE) {
  const from = join(SRC, entry)
  if (!existsSync(from)) {
    missing.push(`${entry} (absent in workspace)`)
    continue
  }
  const info = await stat(from)
  if (info.isDirectory()) {
    for (const rel of await walk(join(SRC, entry))) {
      const source = join(SRC, entry, rel)
      const target = join(DST, entry, rel)
      const same =
        existsSync(target) && (await readFile(source)).equals(await readFile(target))
      if (same) {
        identical += 1
        continue
      }
      if (!checkOnly) {
        await mkdir(join(DST, entry), { recursive: true })
        await cp(source, target)
      }
      copied += 1
      console.log(`${checkOnly ? 'DIFFERS' : 'copied '} ${relative(DST, target)}`)
    }
  } else {
    const target = join(DST, entry)
    const same = existsSync(target) && (await readFile(from)).equals(await readFile(target))
    if (same) {
      identical += 1
      continue
    }
    if (!checkOnly) {
      await mkdir(DST, { recursive: true })
      await cp(from, target)
    }
    copied += 1
    console.log(`${checkOnly ? 'DIFFERS' : 'copied '} ${entry}`)
  }
}

console.log(
  `\n${checkOnly ? 'check' : 'sync'} complete: ${copied} ${checkOnly ? 'differ' : 'copied'}, ${identical} already identical`,
)
if (missing.length) console.log(`absent: ${missing.join(', ')}`)
if (copied > 0 && !checkOnly) {
  console.log('\nRESTART DSH for the Host half — and hard-reload the window for the browser half:')
  console.log('  F12 -> Network -> Disable cache -> F5')
}
