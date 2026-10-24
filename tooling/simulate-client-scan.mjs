/**
 * Offline simulation of the client-modules host scan for this package.
 *
 * The scan is the single gate between "declared a browser half" and "the browser
 * actually receives a bundle". Rather than restarting the app to observe it, this
 * runs the SHIPPED `resolveMeta` logic against the real installed files and reports
 * exactly where discovery would stop.
 *
 * Usage:
 *   DSH_CLIENT_MODULES_BUNDLE=<extracted>/dsh-client-modules/lib/index.js \
 *     node tooling/simulate-client-scan.mjs [packageDir]
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

const pkgDir = resolve(process.argv[2] ?? process.cwd())

const BUNDLE = process.env.DSH_CLIENT_MODULES_BUNDLE ?? ''
if (BUNDLE === '') {
  console.error('DSH_CLIENT_MODULES_BUNDLE is not set; point it at the extracted dsh-client-modules/lib/index.js')
  process.exit(2)
}
const source = readFileSync(BUNDLE, 'utf8')

/**
 * Lift the shipped declaration parser and export resolver out of the bundle so we
 * run the genuine rules, not a re-implementation of them.
 */
function extract(name, endMarker) {
  const start = source.indexOf(`function ${name}(`)
  if (start < 0) throw new Error(`could not locate ${name} in the shipped bundle`)
  const end = endMarker ? source.indexOf(endMarker, start) : -1
  return source.slice(start, end > start ? end : source.indexOf('\n}', start) + 2)
}

const helperNames = [
  'optionalStringArray',
  'parseDshClient',
]
const helpers = helperNames.map(n => extract(n)).join('\n')

const prelude = 'class HarnessError extends Error {}\n'

// clientExportOf resolves the "./client" export; take its body from the bundle.
const clientExportOfStart = source.indexOf('function clientExportOf(')
const clientExportOfEnd = source.indexOf('\n}', clientExportOfStart) + 2
const clientExportBody = source.slice(clientExportOfStart, clientExportOfEnd)

const factory = new Function(
  `${prelude}${helpers}\n${clientExportBody}\nreturn { parseDshClient, clientExportOf };`,
)
const { parseDshClient, clientExportOf } = factory()

console.log(`package dir: ${pkgDir}`)
console.log('')

// --- step 1: locate the manifest -------------------------------------------------
const pkgPath = join(pkgDir, 'package.json')
if (!existsSync(pkgPath)) {
  console.log('STEP 1 FAIL: no package.json at the row resolution target')
  process.exit(1)
}
console.log(`STEP 1 ok  manifest: ${pkgPath}`)

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
const packageName = pkg.name
console.log(`           name:     ${packageName}`)

// --- step 2: parse the dsh.client declaration -----------------------------------
const decl = parseDshClient(packageName, pkg.dsh?.client)
if (decl === undefined) {
  console.log('STEP 2 FAIL: no dsh.client declaration -> the row is treated as host-only')
  process.exit(1)
}
console.log(`STEP 2 ok  dsh.client: platform=${decl.platform} inject=[${(decl.inject ?? []).join(', ')}] immediately=${decl.immediately === true}`)
if (decl.platform !== 'web') {
  console.log(`STEP 2 FAIL: platform is "${decl.platform}", the scanner requires "web"`)
  process.exit(1)
}

// --- step 3: resolve the "./client" export --------------------------------------
const clientRel = clientExportOf(packageName, pkg.exports)
if (clientRel === undefined) {
  console.log('STEP 3 FAIL: dsh.client is declared but exports["./client"] is missing')
  process.exit(1)
}
const clientPath = join(dirname(pkgPath), clientRel)
console.log(`STEP 3 ok  client export: ${clientRel}`)
console.log(`           resolved to:   ${clientPath}`)

if (!existsSync(clientPath)) {
  console.log('STEP 3 FAIL: the resolved client bundle does not exist on disk')
  process.exit(1)
}
console.log(`STEP 3 ok  bundle exists:  ${readFileSync(clientPath).length} bytes`)

// --- step 4: the self-request rule the composition rejects ----------------------
const packageInjected = (decl.inject ?? []).some(name => name === packageName)
console.log(
  `STEP 4 ${packageInjected ? 'FAIL' : 'ok'}  self-request check: ${packageInjected ? 'declares its own package in inject' : 'no self-request'}`,
)

// --- step 5: the bundle must register the module id the host expects ------------
const clientSource = readFileSync(clientPath, 'utf8')
const idMatch = /__ModuleLoader__\.load\(\{\s*id:\s*'([^']+)'/.exec(clientSource)
console.log('')
if (!idMatch) {
  console.log('STEP 5 FAIL: the bundle does not call window.__ModuleLoader__.load({ id, factory })')
  process.exitCode = 1
} else {
  const id = idMatch[1]
  const consistent = id === packageName || id.startsWith(`${packageName}/`) || packageName.startsWith(`${id}/`)
  console.log(`STEP 5 ${consistent ? 'ok' : 'WARN'}  bundle module id: ${id}`)
  if (!consistent) {
    console.log(`           the host identifies this module as "${packageName}", so a mismatched id may not resolve`)
  }
}

console.log('')
console.log('--- what the host would publish ---')
console.log(
  JSON.stringify(
    {
      packageName,
      clientPath,
      inject: decl.inject ?? [],
      external: decl.external ?? [],
      immediately: decl.immediately === true,
      rowConfigKeyHint: `${packageName}#<rowId>`,
    },
    null,
    2,
  ),
)
