/**
 * Layout probe for the sidebar panel's field grid.
 *
 * WHY A REAL BROWSER: the defect this measures ("the label column renders one character
 * wide") is a CSS grid INTRINSIC-SIZING outcome. Nothing in Node computes it — reading the
 * source only tells you which declarations are present, which is exactly what failed to
 * predict the rendering. This tool loads a document built from the SHIPPED style objects
 * (`tooling/layout-styles.mjs` lifts them out of `lib/client.js`) and asks Chromium for the
 * resulting box widths.
 *
 * It is a measurement tool, not a test: it prints a table and always exits 0. The assertions
 * that pin the outcome live in `test/status.test.mjs`, next to nine other cases that run in
 * this same engine; this tool is how those numbers were derived and how a future reader
 * re-derives them after a layout change.
 *
 * READ-ONLY with respect to the plugin: it writes one temporary HTML file under the OS temp
 * directory, removes it again, and never touches `lib/`.
 *
 * Usage: node tooling/measure-grid-layout.mjs
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { findChromium, gridStyles, measureLayout } from './layout-styles.mjs'

const browser = findChromium()
if (browser === undefined) {
  console.log('no Chromium-family browser found; nothing measured')
  process.exit(0)
}

const source = readFileSync(join(import.meta.dirname, '..', 'lib', 'client.js'), 'utf8')
const styles = gridStyles(source)
console.log('shipped styles, lifted from lib/client.js:')
console.log(`  rowStyleDefault       ${JSON.stringify(styles.rowStyleDefault)}`)
console.log(`  panelRowStyle         ${JSON.stringify(styles.panelRowStyle)}`)
console.log(`  hintStyle             ${JSON.stringify(styles.hintStyle)}`)
console.log(`  panelFieldHintStyle   ${JSON.stringify(styles.panelFieldHintStyle)}`)
console.log(`  panelWarningStyle     ${JSON.stringify(styles.panelWarningStyle)}`)
console.log('')

const measured = await measureLayout({ browser, source })
console.log('measured boxes (300px pane, 14/18px stack padding -> 264px row):')
for (const row of measured) {
  console.log(
    `  ${row.kind.padEnd(5)} #${row.index} row=${row.rowWidth} tracks=${JSON.stringify(row.gridTemplateColumns)} ` +
      `label=${row.labelWidth}px/${row.labelLines}line control=${row.controlWidth} hint=${row.hintWidth} ` +
      `divider=${row.dividerWidth}${row.warningWidth === null ? '' : ` warning=${row.warningWidth}`}`,
  )
}
