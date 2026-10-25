/**
 * The decision half of `sync-to-profile.mjs`: what differs, and what to copy.
 *
 * WHY THIS IS A SEPARATE MODULE. `sync-to-profile.mjs` used to decide file identity with
 * `Buffer.equals`, so a copy that differed only in line endings was printed as `DIFFERS` —
 * a false alarm in the safe direction, but `--check` is the one read-only step that must
 * stay believable (docs/PITFALLS.md §10). The fix is a content comparison that ignores
 * line-ending style, and it has to be TESTABLE: the old script did its work at import time
 * and wrote into the profile, so nothing could exercise the verdict without a deployment.
 * The decision now lives here, takes its two roots as arguments, and copies nothing unless
 * the caller asks it to.
 *
 * `lib/eol.js` carries the normalisation and the reasons behind it; this module only applies
 * it. Both `--check` and the copy path use the same comparison, so the verdict and the write
 * can never disagree about what "the same file" means.
 *
 * @module src-12453345_-dsh-workflow/tooling/sync-plan
 */

import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'

import { sameTextContent } from '../lib/eol.js'

/** Every file below `root`, as paths relative to `root`. Internal: `planSync` is the surface. */
async function walk(root, prefix = '') {
  const out = []
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? join(prefix, entry.name) : entry.name
    if (entry.isDirectory()) out.push(...(await walk(root, rel)))
    else out.push(rel)
  }
  return out
}

/**
 * Compare one installed file against its workspace source.
 *
 * `same` is decided on the TEXT (line endings folded), while `eolOnly` keeps the byte-level
 * fact: true means the only difference is line-ending style, which is a difference on disk
 * but not a difference in content. An absent target is `present: false` and never `same`,
 * so the copy path still delivers a file the profile is missing.
 *
 * @param source - absolute path in the workspace checkout.
 * @param target - absolute path in the installed copy.
 * @returns `{ present, same, eolOnly }`.
 */
export async function compareFile(source, target) {
  if (!existsSync(target)) return { present: false, same: false, eolOnly: false }
  const [rawSource, rawTarget] = await Promise.all([readFile(source), readFile(target)])
  const same = sameTextContent(rawSource, rawTarget)
  return {
    present: true,
    same,
    // Reported only when the bytes really do differ; two byte-identical files are not "EOL-only".
    eolOnly: same && !rawSource.equals(rawTarget),
  }
}

/**
 * Decide what a sync/`--check` run would do, and do the copies only when asked.
 *
 * @param options - `{ src, dst, include, checkOnly }`.
 * @param options.src - the workspace root (source of truth).
 * @param options.dst - the installed package root.
 * @param options.include - the top-level entries to sync (`lib`, `tooling`, ...).
 * @param options.checkOnly - when true, NOTHING is written; differences are reported.
 * @returns `{ copied, identical, eolOnly, differ, missing }`, each an array of labels
 *   relative to `dst`. `copied` and `differ` are exclusive by mode: `copied` in copy mode,
 *   `differ` in check mode. `eolOnly` is a SUBSET of `identical` on purpose — same text with
 *   different endings is not a difference, and the list exists so the byte-level fact is
 *   still reported instead of hidden.
 */
export async function planSync({ src, dst, include, checkOnly = false }) {
  const result = { copied: [], identical: [], eolOnly: [], differ: [], missing: [] }

  for (const entry of include) {
    const from = join(src, entry)
    if (!existsSync(from)) {
      result.missing.push(`${entry} (absent in workspace)`)
      continue
    }
    const info = await stat(from)

    if (info.isDirectory()) {
      for (const rel of await walk(from)) {
        const source = join(src, entry, rel)
        const target = join(dst, entry, rel)
        const label = relative(dst, target)
        const comparison = await compareFile(source, target)
        if (comparison.same) {
          result.identical.push(label)
          if (comparison.eolOnly) result.eolOnly.push(label)
          continue
        }
        if (checkOnly) {
          result.differ.push(label)
          continue
        }
        // The target's own directory, not just the entry root: a file that does not exist yet
        // in a nested directory (`lib/components/panel/...`) needs its parents made.
        //
        // MEASURED CORRECTION (P3-5): the original comment here claimed `fs.cp` does NOT create
        // missing destination directories. That is wrong — on the Node measured here (v24.18)
        // `cp` creates them itself (copying a file to `a/b/dst.txt` where `a` does not exist
        // succeeds). The call is therefore BELT AND BRACES, not a requirement: it is
        // idempotent, and it states the precondition explicitly instead of relying on an
        // undocumented implementation detail of `cp`. Behaviour is unchanged either way.
        await mkdir(dirname(target), { recursive: true })
        await cp(source, target)
        result.copied.push(label)
      }
      continue
    }

    const target = join(dst, entry)
    const comparison = await compareFile(from, target)
    if (comparison.same) {
      result.identical.push(entry)
      if (comparison.eolOnly) result.eolOnly.push(entry)
      continue
    }
    if (checkOnly) {
      result.differ.push(entry)
      continue
    }
    await mkdir(dirname(target), { recursive: true })
    await cp(from, target)
    result.copied.push(entry)
  }

  return result
}
