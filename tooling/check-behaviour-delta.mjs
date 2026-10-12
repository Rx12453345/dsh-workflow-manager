/**
 * Behaviour-delta check: the INSTALLED copy of this plugin against this workspace copy.
 *
 * WHY THIS EXISTS. The self-deployment exemption changes `classifyRisk`, and a change to a
 * security classifier is only interesting in one of two ways: it authorises exactly the
 * self-deployments it claims to, or it authorises something else. The offline suite prices
 * the second case with mutants; this script prices the first against the code that is
 * ACTUALLY RUNNING on this machine — the profile's installed copy of `lib/approval.js`,
 * which is the last revision before the exemption existed.
 *
 * WHAT "THE INSTALLED COPY" MEANS HERE, PRECISELY. It is the installed copy OF THE ONE FILE
 * THIS TOOL IMPORTS (`<package>/lib/approval.js`), not the installed package as a whole:
 * the profile's copy is several revisions behind in its browser half
 * (`lib/client.js`) and a comparison across all of it would be measuring the other
 * agents' work, not this change. Only the classifier module and the primitive it needs are
 * compared.
 *
 * THE INVARIANT IT CHECKS — and it is the strongest claim the change makes:
 *
 *     the classifier may differ from the other copy ONLY on calls whose marker is EARNED,
 *     i.e. the differing call's classified path resolves INSIDE the package directory of
 *     the very copy that carries the `selfDeployment` marker.
 *
 * Every other difference — a risk level that moved without a marker, a marker that is not
 * an object, a marker on both sides, a marker on one side for a path that copy's own
 * package does not contain, a case where one side failed and the other did not — is a
 * FAILURE. So the script is green both before the deployment (the installed copy has no
 * exemption, so the only differences are marked ones) and after it (both copies are the
 * new code, differing only by where each was loaded from).
 *
 * WHY "EARNED" REPLACES THE OLD DIRECTION-BLIND RULE, AND WHAT THE OLD ONE GOT WRONG. The
 * exemption anchors on `selfInstallRoot()`, derived from `import.meta.url`, so EACH COPY
 * ANCHORS ON ITS OWN PACKAGE DIRECTORY. For a path inside the INSTALLED package the two
 * copies necessarily disagree in the mirror-image direction: the installed copy sees its
 * own package and marks the call, the workspace copy sees a directory outside its own
 * package, does not mark it, and classifies a few steps further down. That is legitimate
 * and permanent, and the previous rule — "a marker on the new side and none on the old is
 * fine" — called it UNEXPLAINED, so the check was red on a correct state and protected
 * nothing. The rule implemented here is not "a marker on either side is fine": a one-sided
 * marker is accepted exactly when the path being classified lies inside the MARKING copy's
 * OWN anchor, and otherwise stays UNEXPLAINED. Both anchors are consulted, and the anchor
 * used for a given pair is the one belonging to the copy that produced the marker — never
 * a shared or re-derived root.
 *
 * Usage:  node tooling/check-behaviour-delta.mjs [path/to/other/approval.js]
 *         (default: the desktop profile's installed copy)
 *
 * WHAT IT CANNOT CATCH — stated so nobody mistakes this for more than it is. Anchoring
 * separates the legitimate asymmetry from an unjustified marker, but it does not and
 * cannot judge the EXEMPTION itself: the anchor is the copy's own package directory, so a
 * copy whose exemption wrongly marked a call inside its own package as a self-deployment
 * would still pass here, and a call carrying an in-package destination among several is
 * judged here by the same first-destination rule the exemption uses (a marker on the
 * verdict, earned against the anchor, is what is checked — not the whole condition set
 * that produced it). Deciding that a mark is justified is the job of the unit contract
 * tests and of `tooling/mutation-check-approval.mjs`; this script is the other half — it
 * proves the change authorises nothing it did not claim, against the code actually
 * running here. Two narrower limits, plainly: it can only classify cases whose path is
 * readable from here, and an anchor whose containment answer is `unknown` (a filesystem
 * that will not say) is treated as NOT earned, so a legitimate asymmetry on such a path
 * shows up as a failure rather than as a silent pass.
 * It also cannot run at all where no installed copy exists, and says SKIP rather than
 * reporting a pass.
 *
 * Note the shape of this file: the fixtures below are ordinary written-out values, and the
 * check reads STRUCTURE (argument keys, resolved paths), never a pattern inside an action's
 * text. That is deliberate — see the "WHY IT READS STRUCTURE AND NEVER TEXT PATTERNS"
 * comment in `lib/approval.js`. A checker that could only be satisfied by rewording an
 * action would be asking its caller to hide a literal, which is evasion-shaped behaviour
 * and must never be the price of passing a check.
 */

import { existsSync, mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const WORKSPACE_MODULE = join(dirname(fileURLToPath(import.meta.url)), '..', 'lib', 'approval.js')
const INSTALLED_MODULE =
  process.argv[2] ?? 'C:/Users/dengh/.dsh/profiles/desktop/node_modules/src-12453345_-dsh-workflow/lib/approval.js'

/**
 * The shape of one verdict, reduced to the two things this check cares about.
 *
 * `marker` is `'absent'` when the verdict carries no `selfDeployment` field at all,
 * `'object'` when it carries the authorisation this change introduces, and `'malformed'`
 * for anything else — so a marker field of the wrong kind is UNEXPLAINED rather than being
 * silently read as "no marker".
 */
function verdictShape(verdict) {
  if (verdict === null || verdict === undefined) return { risk: null, marker: 'absent' }
  if (typeof verdict !== 'object') return { risk: null, marker: 'malformed' }
  const risk = verdict.risk ?? null
  if (!Object.hasOwn(verdict, 'selfDeployment')) return { risk, marker: 'absent' }
  const marker = verdict.selfDeployment
  const wellFormed = marker !== null && marker !== undefined && typeof marker === 'object'
  return { risk, marker: wellFormed ? 'object' : 'malformed' }
}

/**
 * The package directory one loaded copy anchors on: its own `selfInstallRoot()`, never a
 * path re-derived here, so the fixtures and the classifiers cannot disagree about where a
 * copy's package begins. Falls back to the module file's parent only when the copy is too
 * old to export one — and the fixtures that use it are then outside its anchor anyway.
 */
function selfRootOf(module) {
  const root = typeof module?.selfInstallRoot === 'function' ? module.selfInstallRoot() : null
  return typeof root === 'string' && root.length > 0 ? root : dirname(WORKSPACE_MODULE)
}

/**
 * The path each case's marker has to be judged against: the FIRST path-shaped argument
 * that is a destination, which is the one `selfDeploymentVerdict` anchors on.
 *
 * The key list and the exclusions mirror `lib/approval.js`'s `PATH_KEYS` /
 * `SOURCE_PATH_KEYS` / `CONTEXT_PATH_KEYS` (the same rule the exemption applies, a
 * `source` names content rather than a place it lands, and a `cwd` names context). It is
 * written out here rather than imported because the fixtures are written out here and the
 * installed copy may predate the module's exports; the assertion it feeds — "the marker's
 * own anchor contains this path" — is what actually decides, and an anchor that cannot
 * place the path is NOT earned.
 */
const DESTINATION_KEYS = new Set([
  'path', 'paths', 'file', 'files', 'filename', 'filepath', 'file_path', 'dir', 'directory',
  'folder', 'target', 'destination', 'dest', 'dst', 'output', 'out',
])

function firstDestinationPath(args) {
  if (args === null || typeof args !== 'object') return null
  for (const [key, value] of Object.entries(args)) {
    if (DESTINATION_KEYS.has(String(key).toLowerCase()) && typeof value === 'string' && value.length > 0) return value
    if (Array.isArray(value)) {
      for (const item of value) {
        if (DESTINATION_KEYS.has(String(key).toLowerCase()) && typeof item === 'string' && item.length > 0) return item
      }
    }
  }
  return null
}

/**
 * Whether one copy's own marker is EARNED for the path being classified.
 *
 * The marker claims "every destination of this call resolves inside this copy's own
 * package directory". The claim is checked against that copy's OWN anchor — asked of the
 * copy itself through the `containmentAgainst` it exports, so the path rule (symlink
 * resolution, "unknown never counts as inside") cannot drift from the classifier's — and
 * only `'inside'` earns the marker.
 */
function markerIsEarned(markerModule, path, base) {
  const root = typeof markerModule?.selfInstallRoot === 'function' ? markerModule.selfInstallRoot() : null
  if (typeof root !== 'string' || root.length === 0) return { earned: false, root: null }
  if (typeof path !== 'string' || path.length === 0) return { earned: false, root }
  if (typeof markerModule?.containmentAgainst !== 'function') return { earned: false, root }
  const containment = markerModule.containmentAgainst(path, root, base)
  // Only a provable `inside` earns it: `outside` and `unknown` are both "not earned".
  return { earned: containment === 'inside', root, containment }
}

/**
 * Classify one (old, new) verdict pair for ONE classified path.
 *
 * Rules, in order:
 *
 *  - identical shapes are `same`, whatever the marker says;
 *  - a marker on BOTH sides is not a licence for a risk change — UNEXPLAINED (it is not a
 *    one-sided anchor difference, and tolerating it would license any marked change);
 *  - a one-sided marker is `authorised-self-deployment` exactly when the marking copy's
 *    OWN anchor contains the classified path, i.e. the mark was earned; a marker of the
 *    wrong kind, or a marker that copy's package does not contain, is UNEXPLAINED.
 *
 * A marker is well-formed only as an object (see {@link verdictShape}), which is what keeps
 * `selfDeployment: true` and `selfDeployment: null` red.
 *
 * @param path - the call's classified path (its first destination), or null if it has none.
 * @param anchors - `{ old, new }`, the modules each verdict came from, consulted for their
 *   own `selfInstallRoot()` / `containmentAgainst` and never for each other's.
 * @returns `'same' | 'authorised-self-deployment' | 'UNEXPLAINED'`.
 */
function classifyPair(oldVerdict, newVerdict, { path = null, base = null, anchors = {} } = {}) {
  const before = verdictShape(oldVerdict)
  const after = verdictShape(newVerdict)
  if (before.risk === after.risk && before.marker === after.marker) return 'same'

  const marked = []
  if (before.marker === 'object') marked.push(anchors.old)
  if (after.marker === 'object') marked.push(anchors.new)
  if (marked.length !== 1) return 'UNEXPLAINED' // none, or both, or a malformed marker
  if (before.marker !== 'absent' && before.marker !== 'object') return 'UNEXPLAINED'
  if (after.marker !== 'absent' && after.marker !== 'object') return 'UNEXPLAINED'

  return markerIsEarned(marked[0], path, base).earned ? 'authorised-self-deployment' : 'UNEXPLAINED'
}

/**
 * Prove the comparator can fail. A check that cannot go red is not a check, and this one
 * compares two things that are usually identical, so its failure path is exactly what
 * nobody would notice going missing.
 */
function selftest() {
  // Two anchors that stand in for "a copy whose package directory contains the path" and
  // "a copy whose package directory does not". They are ordinary written-out directories
  // used as paths; the comparator only asks whether one contains the classified path.
  const oldRoot = join(WORKSPACE_MODULE, '..', '..', 'old-copy')
  const newRoot = join(WORKSPACE_MODULE, '..', '..', 'new-copy')
  const insideOld = join(oldRoot, 'lib', 'a.js')
  const insideNew = join(newRoot, 'lib', 'a.js')
  const outsideBoth = join(WORKSPACE_MODULE, '..', '..', 'somewhere-else', 'a.js')
  // A fake module on each side, so the containment question is answered by the fake rather
  // than by a real install: `inside` when the path starts with that copy's anchor.
  const fakeCopy = (root) => ({
    selfInstallRoot: () => root,
    containmentAgainst: (candidate) => (String(candidate).startsWith(root) ? 'inside' : 'outside'),
  })
  const fakeAnchors = { old: fakeCopy(oldRoot), new: fakeCopy(newRoot) }
  const at = (path) => ({ path, base: path, anchors: fakeAnchors })

  const cases = [
    ['identical verdicts are the same', classifyPair({ risk: 'medium' }, { risk: 'medium' }), 'same'],
    ['two absent verdicts are the same', classifyPair(null, null), 'same'],
    [
      'a risk level that moves with no marker is UNEXPLAINED',
      classifyPair({ risk: 'medium' }, { risk: 'low' }),
      'UNEXPLAINED',
    ],
    [
      'a risk level that moves the other way is UNEXPLAINED too',
      classifyPair({ risk: 'low' }, { risk: 'medium' }),
      'UNEXPLAINED',
    ],
    [
      'a marker on the new side, for a path inside the NEW copy anchor, is the one allowed difference',
      classifyPair({ risk: 'medium' }, { risk: 'low', selfDeployment: { root: newRoot } }, at(insideNew)),
      'authorised-self-deployment',
    ],
    [
      'the same marker for a path OUTSIDE the marking copy anchor is UNEXPLAINED',
      classifyPair({ risk: 'medium' }, { risk: 'low', selfDeployment: { root: newRoot } }, at(outsideBoth)),
      'UNEXPLAINED',
    ],
    [
      'a marker field that is not an object is UNEXPLAINED',
      classifyPair({ risk: 'low' }, { risk: 'low', selfDeployment: true }),
      'UNEXPLAINED',
    ],
    [
      'a null marker field is UNEXPLAINED rather than read as "no marker"',
      classifyPair({ risk: 'low' }, { risk: 'low', selfDeployment: null }),
      'UNEXPLAINED',
    ],
    ['one side failing where the other did not is UNEXPLAINED', classifyPair({ risk: 'low' }, null), 'UNEXPLAINED'],
    // The mirror-image direction the old rule could not express. It is legitimate exactly
    // when the path is inside the OLD copy's anchor — the installed copy anchoring on its
    // own package is the asymmetry that made the direction-blind check red on correct code.
    [
      'a marker on the OLD side only, for a path inside the OLD copy anchor, is accepted',
      classifyPair({ risk: 'low', selfDeployment: { root: oldRoot } }, { risk: 'medium' }, at(insideOld)),
      'authorised-self-deployment',
    ],
    [
      'a marker on the OLD side only, for a path OUTSIDE the old copy anchor, is UNEXPLAINED',
      classifyPair({ risk: 'low', selfDeployment: {} }, { risk: 'low' }, at(outsideBoth)),
      'UNEXPLAINED',
    ],
    [
      'a marker on the OLD side only with no path to anchor it is UNEXPLAINED',
      classifyPair({ risk: 'low', selfDeployment: {} }, { risk: 'low' }),
      'UNEXPLAINED',
    ],
    [
      'a marker on the NEW side only with no path to anchor it is UNEXPLAINED',
      classifyPair({ risk: 'medium' }, { risk: 'low', selfDeployment: {} }),
      'UNEXPLAINED',
    ],
    [
      'a marker on both sides is not a licence for a risk change',
      classifyPair({ risk: 'medium', selfDeployment: {} }, { risk: 'low', selfDeployment: {} }, at(insideNew)),
      'UNEXPLAINED',
    ],
    [
      'an anchor that cannot decide containment does not earn the marker',
      classifyPair(
        { risk: 'medium' },
        { risk: 'low', selfDeployment: { root: newRoot } },
        { path: insideNew, base: insideNew, anchors: { old: fakeCopy(oldRoot), new: { selfInstallRoot: () => newRoot, containmentAgainst: () => 'unknown' } } },
      ),
      'UNEXPLAINED',
    ],
    [
      'a copy with no readable anchor does not earn the marker',
      classifyPair(
        { risk: 'medium' },
        { risk: 'low', selfDeployment: { root: newRoot } },
        { path: insideNew, base: insideNew, anchors: { old: fakeCopy(oldRoot), new: { selfInstallRoot: () => null, containmentAgainst: () => 'inside' } } },
      ),
      'UNEXPLAINED',
    ],
    [
      'each side is judged against its OWN anchor, never the other copy’s',
      classifyPair({ risk: 'low' }, { risk: 'low', selfDeployment: { root: newRoot } }, at(insideOld)),
      'UNEXPLAINED',
    ],
  ]
  let failed = 0
  for (const [label, actual, expected] of cases) {
    if (actual !== expected) {
      failed += 1
      console.log(`  FAIL  ${label}: got ${actual}, expected ${expected}`)
    }
  }
  console.log(`comparator self-test: ${cases.length - failed}/${cases.length} as expected`)
  return failed === 0
}

function buildExec({ name, args, cwd }) {
  return {
    name,
    arguments: args,
    agent: { session: { header: { cwd } } },
  }
}

function classifyWith(module, exec) {
  try {
    return module.classifyRisk(exec, { exemptTools: [] })
  } catch (error) {
    return { thrown: `${error?.name ?? 'Error'}: ${error?.message ?? error}` }
  }
}

async function main() {
  console.log('behaviour-delta: installed copy vs workspace copy')
  console.log(`  workspace: ${WORKSPACE_MODULE}`)
  console.log(`  installed: ${INSTALLED_MODULE}`)

  if (!selftest()) {
    console.log('\nRESULT: FAIL — the comparator itself is broken, so nothing below is evidence')
    return 1
  }

  const workspace = await import(pathToFileURL(WORKSPACE_MODULE).href)
  if (!existsSync(INSTALLED_MODULE)) {
    console.log(`\nSKIP: the installed copy is not present on this machine (${INSTALLED_MODULE}),`)
    console.log('      so there is nothing to compare against.')
    console.log('RESULT: NOT CHECKED — this is a distinct outcome from PASS, and it exits 2 so')
    console.log('        that a caller cannot read "nothing was compared" as "nothing is wrong".')
    return 2
  }
  let installed
  try {
    installed = await import(pathToFileURL(INSTALLED_MODULE).href)
  } catch (error) {
    console.log(`\nSKIP: the installed copy could not be imported (${error?.message ?? error})`)
    console.log('RESULT: NOT CHECKED — nothing was compared (exit 2).')
    return 2
  }

  console.log(
    `  workspace anchor: ${typeof workspace.selfInstallRoot === 'function' ? workspace.selfInstallRoot() : '(none)'}`,
  )
  console.log(
    `  installed anchor: ${typeof installed.selfInstallRoot === 'function' ? installed.selfInstallRoot() : '(none — the installed copy predates the exemption)'}`,
  )

  const project = mkdtempSync(join(tmpdir(), 'dsh-wf-delta-project-'))
  const elsewhere = mkdtempSync(join(tmpdir(), 'dsh-wf-delta-elsewhere-'))
  // The PACKAGE roots (`<package>`), i.e. the directories each copy's `selfInstallRoot()`
  // names — `approval.js` lives in `<package>/lib`, so the package is two levels up from
  // the module file. Deriving these as the parent of the file would name `<package>/lib`
  // and put every "in-package" fixture one level too deep, which is a mistake this check
  // must not make about the very anchors it depends on.
  const workspacePackage = selfRootOf(workspace)
  const installedPackage = selfRootOf(installed)
  let failures = 0
  try {
    mkdirSync(join(project, 'src'), { recursive: true })

    const cases = [
      ['an ordinary project-local write', { name: 'write_file', args: { path: join(project, 'src', 'a.js'), content: 'x' }, cwd: project }],
      ['a write outside the project', { name: 'write_file', args: { path: join(elsewhere, 'a.js'), content: 'x' }, cwd: project }],
      ['a shell transport', { name: 'bash', args: { command: 'node tooling/sync-to-profile.mjs' }, cwd: project }],
      ['an opaque script through another shell', { name: 'pwsh', args: { command: 'node tooling/check-config-schema.mjs' }, cwd: project }],
      ['a shell call that merely names a package-internal path', {
        name: 'pwsh',
        args: { command: 'node tooling/sync-to-profile.mjs', path: join(workspacePackage, 'lib', 'approval.js') },
        cwd: project,
      }],
      ['an argument naming an external destination', { name: 'sync', args: { path: 'https://example.invalid/x' }, cwd: project }],
      ['a tool with no evidence either way', { name: 'mystery', args: {}, cwd: project }],
      ['the workspace package’s own file', { name: 'write_file', args: { path: join(workspacePackage, 'lib', 'approval.js'), content: 'x' }, cwd: project }],
      ['a file inside the installed package', { name: 'write_file', args: { path: join(installedPackage, 'lib', 'approval.js'), content: 'x' }, cwd: project }],
      ['a source outside the project with an in-package destination', {
        name: 'copy_file',
        args: { source: join(elsewhere, 'a.js'), destination: join(installedPackage, 'lib', 'a.js') },
        cwd: project,
      }],
    ]

    const differences = []
    const anchors = { old: installed, new: workspace }
    for (const [label, spec] of cases) {
      const exec = buildExec(spec)
      const oldVerdict = classifyWith(installed, exec)
      const newVerdict = classifyWith(workspace, exec)
      const path = firstDestinationPath(spec.args)
      const kind = classifyPair(oldVerdict, newVerdict, { path, base: spec.cwd, anchors })

      // The marker's own claim, checked independently of the anchor lookup above: a
      // `selfDeployment.root` that is not the marking copy's own package directory means
      // this tool and the code it checks have drifted apart, so neither number is evidence.
      for (const [side, verdict, module] of [['installed', oldVerdict, installed], ['workspace', newVerdict, workspace]]) {
        const claimed = verdict?.selfDeployment?.root
        if (typeof claimed !== 'string' || typeof module.selfInstallRoot !== 'function') continue
        const own = module.selfInstallRoot()
        if (claimed !== own) {
          failures += 1
          console.log(`  FAIL  a marker from the ${side} copy claims root ${claimed}`)
          console.log(`        but that copy's own selfInstallRoot() is ${own} — the check and the code it checks disagree`)
        }
      }

      if (kind === 'same') continue
      differences.push({ label, kind, oldRisk: oldVerdict?.risk ?? null, newRisk: newVerdict?.risk ?? null, path })
      if (kind === 'UNEXPLAINED') failures += 1
    }

    console.log(`\nclassifications compared: ${cases.length}`)
    if (differences.length === 0) {
      console.log('classifications that differ: none')
    } else {
      console.log('classifications that differ:')
      for (const d of differences) {
        console.log(
          `  ${d.kind === 'UNEXPLAINED' ? 'FAIL' : 'ok  '}  ${d.label}: installed=${d.oldRisk} workspace=${d.newRisk} (${d.kind})`,
        )
        if (d.kind === 'authorised-self-deployment') {
          console.log(`        accepted because the marker’s own anchor contains ${d.path}`)
        }
      }
    }

    // `pathContainment` is the shared primitive underneath both classifiers, and both
    // copies define it, so it must agree exactly — it is the half the exemption reuses.
    const containmentCases = [
      [project, join(project, 'src', 'a.js')],
      [project, join(elsewhere, 'a.js')],
      [project, 'https://example.invalid/x'],
      [project, ''],
      ['', 'a.js'],
      [project, join(project, 'src', '..', '..', 'escape.js')],
    ]
    let containmentDiffs = 0
    for (const [cwd, candidate] of containmentCases) {
      const oldValue = installed.pathContainment(cwd, candidate)
      const newValue = workspace.pathContainment(cwd, candidate)
      if (oldValue !== newValue) {
        containmentDiffs += 1
        failures += 1
        console.log(`  FAIL  pathContainment(${cwd}, ${candidate}): installed=${oldValue} workspace=${newValue}`)
      }
    }
    console.log(`pathContainment cases compared: ${containmentCases.length}, differences: ${containmentDiffs}`)

    console.log(
      failures === 0
        ? '\nRESULT: PASS — every classification difference is a call whose marker is earned against the marking copy’s own package directory'
        : `\nRESULT: FAIL — ${failures} unexplained difference(s)`,
    )
  } finally {
    rmSync(project, { recursive: true, force: true })
    rmSync(elsewhere, { recursive: true, force: true })
  }
  return failures === 0 ? 0 : 1
}

// `main` owns the exit code: 0 = compared and clean, 1 = an unexplained difference, 2 =
// nothing was compared. The three must not be collapsed — a caller that treats "not
// checked" as a pass has a check that silently stops checking.
process.exitCode = await main()
