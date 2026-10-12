/**
 * B6 mutation harness (temporary, lives OUTSIDE the plugin package).
 *
 * For each mutant: apply a literal edit, run the panel's test file, record whether it
 * went RED, restore byte-for-byte and verify the hash.
 *
 * Usage: node D:/DSH/P5/_b6_mutate.mjs [M1 M4 ...]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { EXIT_LOCK_HELD, MutationLockHeld, withMutationLock } from './mutation-lock.mjs'

const ROOT = 'D:/DSH/P5/src-12453345_-dsh-workflow'
const CLIENT = `${ROOT}/lib/client.js`
const SCHEMA = `${ROOT}/lib/config-schema.js`
const only = new Set(process.argv.slice(2))

/** Every harness takes this lock, so no two of them can rewrite lib/ at the same time. */
const LABEL = 'tooling/mutation-check-panel.mjs'

/** Every mutant states which test name it MUST turn red. */
const MUTANTS = [
  {
    id: 'M1',
    file: CLIENT,
    what: 'panelVisible reads the idle snapshot as "switched off" (=== true)',
    find: `      return value.showInSidebar !== false`,
    replace: `      return value.showInSidebar === true`,
    must: ['the panel is invisible only when the settings document says so, and never while it is unread'],
  },
  {
    id: 'M2',
    file: CLIENT,
    what: 'panelVisible drops the ready-status guard and reads an unloaded value',
    find: `      if (snapshot.status !== 'ready') return true\n`,
    replace: ``,
    must: ['the panel is invisible only when the settings document says so, and never while it is unread'],
  },
  {
    id: 'M3',
    file: CLIENT,
    what: 'panelLabel stops falling back to the id (a blank label yields a blank string)',
    find: `      return typeof id === 'string' && id !== '' ? id : ''`,
    replace: `      return ''`,
    must: ['the sidebar label falls back to the dictionary and then to the id, never to blank'],
  },
  {
    id: 'M4',
    file: CLIENT,
    what: 'panelLabel stops trimming (a blank configured label wins)',
    find: `      if (typeof configured === 'string' && configured.trim() !== '') return configured`,
    replace: `      if (typeof configured === 'string') return configured`,
    must: ['the sidebar label falls back to the dictionary and then to the id, never to blank'],
  },
  {
    id: 'M5',
    file: CLIENT,
    what: 'panelLabel returns the raw configured value, dropping both fallbacks',
    find: `      if (typeof fallback === 'string' && fallback.trim() !== '') return fallback\n      return typeof id === 'string' && id !== '' ? id : ''`,
    replace: `      return String(configured ?? '')`,
    must: ['the sidebar label falls back to the dictionary and then to the id, never to blank'],
  },
  {
    id: 'M6',
    file: CLIENT,
    what: 'the sidebar entry carries the id as a literal that can drift from main',
    find: `                  id: PANEL_ID,`,
    replace: `                  id: 'dsh-workflow-panel',`,
    must: ['the sidebar entry and the main body it opens share one id'],
  },
  {
    id: 'M7',
    file: CLIENT,
    what: 'the main body is keyed differently from the sidebar entry',
    find: `                  key: PANEL_ID,`,
    replace: `                  key: PANEL_ID + '-panel',`,
    must: ['the sidebar entry and the main body it opens share one id'],
  },
  {
    id: 'M8',
    file: CLIENT,
    what: 'a withdrawn panel returns undefined instead of a disposer',
    find: `              return function () {}
`,
    replace: ``,
    must: ['the sidebar cannot be registered without its body'],
  },
  {
    id: 'M9',
    file: CLIENT,
    what: 'teardown releases only the body, leaving the sidebar entry registered',
    find: `              releasePanel()
              releaseBody()`,
    replace: `              releaseBody()`,
    must: ['the sidebar cannot be registered without its body'],
  },
  {
    id: 'M10',
    file: CLIENT,
    what: 'the label falls back to the raw key instead of the dictionary',
    find: `panelLabel(value.sidebarLabel, t('panelLabel'), PANEL_ID)`,
    replace: `panelLabel(value.sidebarLabel, 'panelLabel', PANEL_ID)`,
    must: ['the sidebar label comes from the same locale namespace the dictionary is registered under'],
  },
  {
    id: 'M11',
    file: CLIENT,
    what: 'the en dictionary loses the fallback, so English shows the raw key',
    find: `      panelLabel: 'Workflow settings',\n`,
    replace: ``,
    must: ['the sidebar label comes from the same locale namespace the dictionary is registered under'],
  },
  {
    id: 'M12',
    file: CLIENT,
    what: 'an unguarded require (a host module would break the bundle)',
    find: `    const react = require('react')`,
    replace: `    const react = require('react')\n    const gate = require('../gate.js')`,
    must: ['the browser half still requires nothing but react'],
  },
  {
    id: 'M13',
    file: SCHEMA,
    what: 'the Host stops serving the switch, so nothing can read it',
    find: `    showInSidebar: z.boolean().default(DEFAULT_CONFIG.showInSidebar),\n`,
    replace: ``,
    must: ['the panel switch is declared in the schema and in the runtime defaults, and is read in the browser'],
  },
  {
    id: 'M14',
    file: SCHEMA,
    what: 'the Host stops serving the sidebar label',
    find: `    sidebarLabel: z.string().default(DEFAULT_CONFIG.sidebarLabel),\n`,
    replace: ``,
    must: ['the panel switch is declared in the schema and in the runtime defaults, and is read in the browser'],
  },
  {
    id: 'M15',
    file: CLIENT,
    what: 'round-1 blocker: the switch writes the CORE row while the gate reads the PANEL row',
    find: `                writeTopLevel(panel, 'showInSidebar', event.target.checked, writeToken, setMessage, t),`,
    replace: `                writeTopLevel(form, 'showInSidebar', event.target.checked, writeToken, setMessage, t),`,
    must: ['the sidebar switch READS and WRITES the same settings namespace'],
  },
  {
    id: 'M16',
    file: CLIENT,
    what: 'round-1 blocker: the sidebar BODY takes the core controller and reads the core document',
    find: `      const panel = props?.panelController
      const [snapshot, setSnapshot] = react.useState(null)
      const [message, setMessage] = react.useState('')
      const writeToken = react.useRef(0)
      // The switch row follows the PANEL row's document; the form below follows the core
      // row's. Two subscriptions, because the two documents settle independently.
      react.useEffect(() => {
        if (!panel || typeof panel.subscribe !== 'function') return undefined`,
    replace: `      const panel = props?.controller
      const [snapshot, setSnapshot] = react.useState(null)
      const [message, setMessage] = react.useState('')
      const writeToken = react.useRef(0)
      react.useEffect(() => {
        if (!panel || typeof panel.subscribe !== 'function') return undefined`,
    must: ['the sidebar switch READS and WRITES the same settings namespace'],
  },
  {
    id: 'M17',
    file: CLIENT,
    what: 'the sidebar body subscribes to the right controller but reads the CORE document',
    find: `        const publish = () => setSnapshot(panel.getSnapshot())
        publish()
        return panel.subscribe(publish)`,
    replace: `        const publish = () => setSnapshot(form.getSnapshot())
        publish()
        return panel.subscribe(publish)`,
    must: ['the sidebar switch READS and WRITES the same settings namespace'],
  },
  {
    id: 'M18',
    file: CLIENT,
    what: 'round-1 major: the main registration loses its locale namespace (no t seat)',
    find: `                  name: 'main',
                  key: PANEL_ID,
                  locale: NS,`,
    replace: `                  name: 'main',
                  key: PANEL_ID,`,
    must: ['every slot registration that renders visible copy declares its locale namespace'],
  },
  {
    id: 'M19',
    file: CLIENT,
    what: 'the settings page registration loses its locale namespace too',
    find: `                locale: NS,
                // Hand the CONTROLLER in, not the context.`,
    replace: `                // Hand the CONTROLLER in, not the context.`,
    must: ['every slot registration that renders visible copy declares its locale namespace'],
  },
  {
    id: 'M20',
    file: CLIENT,
    what: 'the duplicate returns: `plugins.row.config` is registered for the panel row as well as the core row',
    // The previous shape, restored verbatim: the second entry point that made the SAME
    // form appear twice on the bundle's page (the duplicate the user asked to remove).
    // The one-page test counts registration KEYS, so a second key fails it.
    find: `      for (const row of [{ rowId: ENTRY_ID, key: 'src-12453345_-dsh-workflow#dsh-workflow-core' }]) {`,
    replace: `      for (const row of [
        { rowId: ENTRY_ID, key: 'src-12453345_-dsh-workflow#dsh-workflow-core' },
        { rowId: PANEL_ENTRY_ID, key: 'src-12453345_-dsh-workflow#dsh-workflow-panel' },
      ]) {`,
    must: ['exactly ONE row carries the configuration page, and the switch survives on it'],
  },
  {
    id: 'M21',
    file: CLIENT,
    what: 'the one remaining page stops receiving the panel controller, so the off switch has no UI again',
    find: `      const panel = props?.panelController
      const [panelSnapshot, setPanelSnapshot] = react.useState(null)`,
    replace: `      const panel = undefined
      const [panelSnapshot, setPanelSnapshot] = react.useState(null)`,
    must: ['exactly ONE row carries the configuration page, and the switch survives on it'],
  },
  {
    id: 'M22',
    file: CLIENT,
    what: 'the registration stops handing the panel controller over',
    find: `                  panelController: panelConfigController(ctx),
                }),
              },
              WorkflowCard,`,
    replace: `                }),
              },
              WorkflowCard,`,
    must: ['exactly ONE row carries the configuration page, and the switch survives on it'],
  },
  {
    id: 'M23',
    file: CLIENT,
    what: 'round-2 major: the hint sends the user to a restore path that cannot work',
    find: `      showInSidebarHint: '关掉后要刷新页面，侧边栏里这一项才消失。要再打开，到「设置 → 插件 → dsh-workflow-panel」行。工具不受影响，始终照常工作。',`,
    replace: `      showInSidebarHint: '关掉后要刷新页面才消失；要再打开请用 workflow_set 或改 .dsh/workflow.yml。',`,
    must: ['exactly ONE row carries the configuration page, and the switch survives on it'],
  },
  {
    id: 'M24',
    file: CLIENT,
    what: 'the panel grid goes back to a `minmax(0, 1fr)` track (the shape that resolved to 0px and wrapped the label one character per line)',
    find: `      gridTemplateColumns: '100%',`,
    replace: `      gridTemplateColumns: 'minmax(0, 1fr)',`,
    must: ['the panel hint spans its one column instead of creating a second'],
  },
  {
    id: 'M25',
    file: CLIENT,
    what: 'the panel hint claims column two again, creating the implicit second track that starved the label',
    find: `    const panelFieldHintStyle = { ...hintStyle, gridColumn: '1 / -1', marginTop: 0 }`,
    replace: `    const panelFieldHintStyle = { ...hintStyle, gridColumn: '2', marginTop: 0 }`,
    must: [
      'the panel hint spans its one column instead of creating a second',
      'the shipped panel grid resolves to one column with a full-width label',
    ],
  },
  {
    id: 'M26',
    file: CLIENT,
    what: 'the approval banner claims column two in the panel (the same implicit-track defect, on the other grid child)',
    find: `    const panelWarningStyle = { ...warningStyle, gridColumn: '1 / -1' }`,
    replace: `    const panelWarningStyle = { ...warningStyle, gridColumn: '2' }`,
    must: [
      'the panel hint spans its one column instead of creating a second',
      'the shipped panel grid resolves to one column with a full-width label',
    ],
  },
  {
    id: 'M27',
    file: CLIENT,
    what: 'the sidebar body is handed the PAGE row geometry while the panel constant still exists (the wiring, not the constant)',
    find: `            rowStyle: panelRowStyle,`,
    replace: `            rowStyle: rowStyleDefault,`,
    must: [
      'the sidebar panel is narrower and airier than the plugin page',
      'the shipped panel grid resolves to one column with a full-width label',
    ],
  },
  {
    id: 'M28',
    file: CLIENT,
    what: 'columnStyle stops consulting the row template and always answers with the page style',
    find: `      return rowStyle?.gridTemplateColumns === panelRowStyle.gridTemplateColumns ? panelled : paged`,
    replace: `      return paged`,
    must: [
      'the panel hint spans its one column instead of creating a second',
      'the shipped panel grid resolves to one column with a full-width label',
    ],
  },
]

const sha = text => createHash('sha256').update(text).digest('hex').slice(0, 12)

/**
 * Everything that touches lib/ happens under the lock: the snapshots, every mutant, every
 * restore, and the final verification. Nothing is read before the lock is held, so a
 * concurrently running harness cannot have its mutant recorded here as "the original".
 *
 * The signal handlers are registered BEFORE the lock is taken (so they run before the lock's
 * own backstop handler: Node runs handlers in registration order). The snapshot stays empty
 * until the lock is held, so a Ctrl-C during acquisition cannot write `undefined` over a source.
 */
async function main() {
  const files = [CLIENT, SCHEMA]
  const originals = new Map()
  const restore = () => {
    for (const file of files) {
      const text = originals.get(file)
      if (text !== undefined) writeFileSync(file, text, 'utf8')
    }
  }
  process.once('SIGINT', () => {
    restore()
    process.exit(130)
  })
  process.once('SIGTERM', () => {
    restore()
    process.exit(143)
  })

  await withMutationLock(
    async () => {
      console.log(`${LABEL}: mutation lock acquired`)
      for (const file of files) originals.set(file, readFileSync(file, 'utf8'))
      const hashes = new Map(files.map(file => [file, sha(originals.get(file))]))

      function failingTests(output) {
        const names = new Set()
        for (const match of output.matchAll(/^✖ (.+?)(?: \(\d+(?:\.\d+)?ms\))?$/gm)) {
          const name = match[1].trim()
          if (name !== 'failing tests:') names.add(name)
        }
        return [...names]
      }

      const rows = []
      for (const mutant of MUTANTS) {
        if (only.size > 0 && !only.has(mutant.id)) continue
        const original = originals.get(mutant.file)
        const occurrences = original.split(mutant.find).length - 1
        if (occurrences !== 1) {
          rows.push({ ...mutant, applied: false, problem: `literal occurs ${occurrences}x` })
          continue
        }
        let output = ''
        let status = null
        try {
          writeFileSync(mutant.file, original.replace(mutant.find, mutant.replace), 'utf8')
          const run = spawnSync(
            process.execPath,
            ['--test', '--test-isolation=none', 'test/status.test.mjs'],
            { cwd: ROOT, encoding: 'utf8' },
          )
          output = `${run.stdout ?? ''}${run.stderr ?? ''}`
          status = run.status
        } finally {
          restore()
        }
        const failed = failingTests(output)
        const missed = mutant.must.filter(name => !failed.includes(name))
        rows.push({ ...mutant, applied: true, red: status !== 0, failed, missed, caught: failed.length > 0 && missed.length === 0 })
      }

      restore()
      console.log('=== B6 MUTATION RESULTS ===')
      for (const row of rows) {
        if (!row.applied) {
          console.log(`${row.id.padEnd(4)} APPLY-FAILED  ${row.problem}`)
          continue
        }
        const mark = row.caught ? 'CAUGHT ' : row.red ? 'PARTIAL' : 'MISSED '
        console.log(`${row.id.padEnd(4)} ${mark} red=${row.red ? 'yes' : 'no '} count=${row.failed.length}`)
        console.log(`     what: ${row.what}`)
        if (row.missed.length) console.log(`     NOT failing: ${row.missed.join(' ; ')}`)
        if (row.failed.length) console.log(`     failing: ${row.failed.slice(0, 4).join(' ; ')}${row.failed.length > 4 ? ` (+${row.failed.length - 4})` : ''}`)
      }
      const intact = files.every(file => sha(readFileSync(file, 'utf8')) === hashes.get(file))
      for (const file of files) {
        const current = sha(readFileSync(file, 'utf8'))
        console.log(`  ${file.split('/').pop()}: ${current === hashes.get(file) ? 'intact' : `CHANGED ${hashes.get(file)} -> ${current}`}`)
      }
      console.log(`\nsources restored byte-for-byte: ${intact ? 'YES' : 'NO — INVESTIGATE'}`)
    },
    { label: LABEL },
  )
}

try {
  await main()
} catch (error) {
  if (error instanceof MutationLockHeld) {
    console.error(`${LABEL}: ${error.message}`)
    process.exit(EXIT_LOCK_HELD)
  }
  throw error
}
