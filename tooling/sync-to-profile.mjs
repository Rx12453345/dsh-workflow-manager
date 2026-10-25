// Sync the workspace plugin into the profile's installed copy.
//
// WHY THIS EXISTS: the profile declares the plugin as a `file:` dependency and the
// loader still materialises a COPY rather than a symlink, so editing
// a checkout has NO effect until the files are copied across and DSH is restarted.
// Forgetting this step produces the worst kind of bug report: "I fixed it and
// nothing changed".
//
// THE VERDICT LIVES IN `sync-plan.mjs`, ON PURPOSE. Identity is decided there on the TEXT
// (line endings folded), because this checkout really does hold both styles: `git ls-files
// --eol` reports files whose working tree is `w/crlf` while the blob is `i/lf`. The set grows
// as files are added and changes when an editor rewrites one, so run that command for the
// current list rather than trusting a count in a comment. A byte-exact comparison called
// such a file a difference, so `--check` printed DIFFERS for a copy that was the same text — see
// docs/PITFALLS.md §10. Keeping the decision in a module also makes it testable without
// writing into the profile, which this file must not do in `--check` mode.
//
// Usage:  node sync-to-profile.mjs [--check]
//   (default) copy this checkout -> the profile's installed copy
//   --check   report differences without writing
//   DSH_WORKFLOW_SRC / DSH_PROFILE_DIR override the two roots.
//
// CONTRACT, PINNED BY test/sync-to-profile.test.mjs: an absent DSH_WORKFLOW_SRC (or an absent
// default checkout root) is a hard ERROR — exit 1 with `the workspace root does not exist` on
// stderr. It is NOT a clean run. The old script printed `absent:` and exited 0, which made a
// wrong DSH_WORKFLOW_SRC look like "nothing to do"; changing that exit code was deliberate, and
// the test is what keeps it from drifting back.

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { planSync } from './sync-plan.mjs'

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

if (!existsSync(SRC)) {
  // Not an error to paper over: a wrong DSH_WORKFLOW_SRC would otherwise "sync" nothing and
  // report a clean run, which is the exact failure this script exists to prevent.
  console.error(`sync: the workspace root does not exist: ${SRC}`)
  process.exit(1)
}

const report = await planSync({ src: SRC, dst: DST, include: INCLUDE, checkOnly })

for (const label of report.copied) console.log(`copied  ${label}`)
for (const label of report.differ) console.log(`DIFFERS ${label}`)
// Same text, different line endings: reported so the byte-level fact is not hidden, but not
// counted as a difference and never copied just to rewrite endings.
for (const label of report.eolOnly) {
  console.log(`${checkOnly ? 'same text' : 'not copied'} (line endings differ only) ${label}`)
}

const moved = checkOnly ? report.differ.length : report.copied.length
console.log(
  `\n${checkOnly ? 'check' : 'sync'} complete: ${moved} ${checkOnly ? 'differ' : 'copied'}, ` +
    `${report.identical.length} already identical` +
    (report.eolOnly.length > 0
      ? ` (${report.eolOnly.length} of those differ only in line endings)`
      : ''),
)
if (report.missing.length) console.log(`absent: ${report.missing.join(', ')}`)
if (report.copied.length > 0 && !checkOnly) {
  console.log('\nRESTART DSH for the Host half — and hard-reload the window for the browser half:')
  console.log('  F12 -> Network -> Disable cache -> F5')
}
