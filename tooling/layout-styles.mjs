/**
 * Read the browser bundle's grid styles OUT OF THE SHIPPED SOURCE.
 *
 * WHY THIS EXISTS: the panel defect is an intrinsic-sizing outcome that no amount of
 * reading predicts — the source said "one column" and the browser rendered two. But a test
 * that hardcodes the corrected style object would only be asserting a transcription of the
 * fix, and would stay green after `lib/client.js` changed underneath it. So the styles are
 * lifted from `lib/client.js` itself, by name, and a renamed or deleted constant fails the
 * caller loudly instead of silently changing what the assertion means.
 *
 * `measureLayout` then renders those styles with a real Chromium engine, which is the only
 * thing that actually computes the outcome.
 *
 * NOT A TEST. It is a helper for `test/status.test.mjs` and for
 * `tooling/measure-grid-layout.mjs`; it exits nothing and asserts nothing.
 */

import { spawn } from 'node:child_process'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Slice a top-level `const NAME = …` initializer out of the bundle.
 *
 * Brace/bracket aware from the first `{` or `[`, and both quote AND comment aware. A
 * comment-blind scan is not good enough here: the shipped style objects carry JSDoc prose
 * that contains braces, and a scan that counted one would run past the end of the object and
 * splice unrelated source into the evaluated string (which then fails to parse, or worse,
 * parses into something else).
 *
 * A value that is neither an object, an array, nor a quoted/templated string (e.g. a number)
 * is returned as the rest of its line.
 *
 * @param source - the bundle text.
 * @param name - the const to lift.
 * @returns the initializer source, exactly as shipped.
 */
export function sourceConst(source, name) {
  const marker = `const ${name} = `
  const start = source.indexOf(marker)
  if (start < 0) throw new Error(`lib/client.js no longer declares ${name}`)
  const from = start + marker.length
  const first = source[from]

  if (first === '{' || first === '[') {
    const close = first === '{' ? '}' : ']'
    let depth = 0
    let quote = null
    let lineComment = false
    let blockComment = false
    for (let i = from; i < source.length; i += 1) {
      const char = source[i]
      const next = source[i + 1]
      if (lineComment) {
        if (char === '\n') lineComment = false
        continue
      }
      if (blockComment) {
        if (char === '*' && next === '/') {
          blockComment = false
          i += 1
        }
        continue
      }
      if (quote !== null) {
        if (char === '\\') i += 1
        else if (char === quote) quote = null
        continue
      }
      if (char === '/' && next === '/') {
        lineComment = true
        i += 1
        continue
      }
      if (char === '/' && next === '*') {
        blockComment = true
        i += 1
        continue
      }
      if (char === "'" || char === '"' || char === '`') {
        quote = char
        continue
      }
      if (char === first) depth += 1
      else if (char === close) {
        depth -= 1
        if (depth === 0) return source.slice(from, i + 1)
      }
    }
    throw new Error(`could not find the end of ${name}`)
  }

  if (first === "'" || first === '"' || first === '`') {
    for (let i = from + 1; i < source.length; i += 1) {
      if (source[i] === '\\') i += 1
      else if (source[i] === first) return source.slice(from, i + 1)
    }
    throw new Error(`could not find the end of ${name}`)
  }

  const lineEnd = source.indexOf('\n', from)
  return source.slice(from, lineEnd < 0 ? undefined : lineEnd).trim()
}

/**
 * Slice a top-level `function NAME(…) {…}` out of the bundle by brace matching.
 *
 * @param source - the bundle text.
 * @param name - the function to lift.
 * @returns the function source, exactly as shipped.
 */
export function sourceFunction(source, name) {
  const marker = `function ${name}(`
  const start = source.indexOf(marker)
  if (start < 0) throw new Error(`lib/client.js no longer declares ${name}()`)
  let depth = 0
  for (let i = source.indexOf('{', start); i >= 0 && i < source.length; i += 1) {
    if (source[i] === '{') depth += 1
    else if (source[i] === '}') {
      depth -= 1
      if (depth === 0) return source.slice(start, i + 1)
    }
  }
  throw new Error(`could not find the end of ${name}()`)
}

/**
 * Evaluate the shipped grid-style names into objects.
 *
 * The name list is explicit and the evaluation is one `new Function`, so the styles are the
 * shipped ones and a missing name is an error rather than `undefined` flowing into a
 * comparison that then passes.
 *
 * @param source - the bundle text.
 * @returns the named values.
 */
export function gridStyles(source) {
  const names = [
    'PANEL_ROW_GAP',
    'PANEL_COLUMN_GAP',
    'PANEL_ROW_PADDING',
    'rowStyleDefault',
    'panelRowStyle',
    'labelStyle',
    'hintStyle',
    'panelFieldHintStyle',
    'warningStyle',
    'panelWarningStyle',
  ]
  const declarations = names.map(name => `const ${name} = ${sourceConst(source, name)}`)
  // Emitted in the FILE'S OWN order, because the objects reference each other
  // (`panelRowStyle` spreads `rowStyleDefault` and reads the `PANEL_*` constants;
  // `panelFieldHintStyle` spreads `hintStyle`). Recovering that order from the source means a
  // reordering that broke the real initialization would break here too, instead of being
  // papered over by a hand-written order that happens to work.
  const order = names
    .map(name => ({ name, at: source.indexOf(`const ${name} = `) }))
    .sort((left, right) => left.at - right.at)
    .map(entry => entry.name)
  const byName = new Map(names.map((name, index) => [name, declarations[index]]))

  return new Function(
    `${order.map(name => byName.get(name)).join('\n')}\n${sourceFunction(source, 'columnStyle')}\n` +
      `return { ${names.join(', ')}, columnStyle }`,
  )()
}

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

/** The Chromium-family binary to drive, or undefined when this machine has none. */
export function findChromium() {
  return EDGE_CANDIDATES.find(candidate => existsSync(candidate))
}

/**
 * Resolve a style object into a CSS declaration list.
 *
 * Only the properties the panel actually sets are rendered; a property whose value is not a
 * string or number is skipped rather than stringified into nonsense.
 *
 * @param style - one shipped style object.
 * @returns `a: b;` pairs.
 */
function declarations(style) {
  return Object.entries(style)
    .filter(([, value]) => typeof value === 'string' || typeof value === 'number')
    .map(([property, value]) => `${property.replace(/[A-Z]/g, char => `-${char.toLowerCase()}`)}: ${value}`)
    .join('; ')
}

/**
 * Render rows built from the SHIPPED styles and ask Chromium for the resulting boxes.
 *
 * The rows are a faithful flat sibling list — the divider, the label, the control, the hint —
 * because that is exactly what `WorkflowCard`'s `field()` produces inside the grid: the
 * outcome depends on that list, so a harness that nested the children would measure a
 * different thing. Each header is rendered from the same styles as a real field row.
 *
 * @param options - `{ browser, source }`: the Chromium binary and the bundle text.
 * @returns one measurement per requested header.
 */
export async function measureLayout({ browser, source }) {
  const styles = gridStyles(source)
  // WHICH STYLE THE SIDEBAR BODY ACTUALLY PASSES, read from its own source rather than
  // assumed. Without this the harness would render the panel grid the MODULE declares while
  // the component passed something else — so a body wired to the page's two-column default
  // would still measure one column and the regression would survive the suite.
  const sidebar = sourceFunction(source, 'SidebarPanel')
  const passed = /rowStyle:\s*([A-Za-z_][A-Za-z0-9_]*)/.exec(sidebar)
  if (passed === null) throw new Error('SidebarPanel no longer passes a named rowStyle')
  const rowStyleName = passed[1]
  const rowStyle = styles[rowStyleName]
  if (rowStyle === undefined) throw new Error(`SidebarPanel passes unknown style ${rowStyleName}`)

  const headers = [
    '默认档位',
    '默认档位 / tier',
    '审批强度',
    '委托上限',
    'dsh-workflow: 当前项目层',
  ]
  const rows = headers.map((label, index) => ({
    label,
    // Two shapes, both real: a bare field row, and a row whose approval warning renders in
    // the same grid (the panel's second `gridColumn: '2'` case).
    warning: index % 2 === 1,
  }))

  const panelStyle = declarations(rowStyle)
  const pageStyle = declarations(styles.rowStyleDefault)
  const labelStyle = declarations(styles.labelStyle)
  const panelHintStyle = declarations(styles.columnStyle(rowStyle, styles.panelFieldHintStyle, styles.hintStyle))
  const panelWarning = declarations(styles.columnStyle(rowStyle, styles.panelWarningStyle, styles.warningStyle))
  const dividerStyle = 'grid-column: 1 / -1; height: 0; border-top: 1px solid rgba(127,127,127,0.18)'
  const controlStyle = 'font-size: 13px; padding: 4px 6px; max-width: 340px'

  const panelRows = rows
    .map(
      row => `<div class="rows panel"><div style="${dividerStyle}"></div><div style="${labelStyle}">${row.label}</div><select style="${controlStyle}"><option>standard — 标准</option></select><div style="${panelHintStyle}">minimal 轻量 / standard 标准 / strict 严格，按「犯错的代价」选。</div>${row.warning ? `<div style="${panelWarning}">官方原文警告（选择 llm-only 或 off 时生效）</div>` : ''}</div>`,
    )
    .join('\n')
  // The page's own columns, built from the PAGE styles — including the hint placement the
  // page's rows really use, which is what makes this a control rather than a second panel.
  const pageHintStyle = declarations(styles.columnStyle(styles.rowStyleDefault, styles.panelFieldHintStyle, styles.hintStyle))
  const pageRows = rows
    .map(
      row => `<div class="rows page"><div style="${dividerStyle}"></div><div style="${labelStyle}">${row.label}</div><select style="${controlStyle}"><option>standard — 标准</option></select><div style="${pageHintStyle}">minimal 轻量 / standard 标准 / strict 严格，按「犯错的代价」选。</div></div>`,
    )
    .join('\n')

  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    body { margin: 0; font: 13px system-ui; }
    .pane { width: 300px; border: 1px solid #ccc; }
    .stack { padding: 14px 18px 24px; max-width: 520px; margin-right: auto; box-sizing: border-box; overflow-x: hidden; }
    .panel { display: grid; ${panelStyle} }
    .page { display: grid; ${pageStyle} }
  </style></head><body>
    <div class="pane"><div class="stack">${panelRows}</div></div>
    <div class="pane"><div class="stack">${pageRows}</div></div>
  </body></html>`

  const page = join(tmpdir(), `dsh-workflow-grid-${process.pid}.html`)
  writeFileSync(page, html, 'utf8')
  try {
    return await withChromium(browser, async evaluate => {
      const expression = `(() => {
        const out = [];
        for (const kind of ['panel', 'page']) {
          const rows = [...document.querySelectorAll('.rows.' + kind)];
          rows.forEach((row, index) => {
            const label = row.querySelector('div:nth-child(2)');
            const control = row.querySelector('select');
            const hint = row.querySelector('div:nth-child(4)');
            const divider = row.querySelector('div');
            const warning = row.querySelector('div:nth-child(5)');
            out.push({
              kind,
              index,
              rowWidth: Math.round(row.getBoundingClientRect().width),
              gridTemplateColumns: getComputedStyle(row).gridTemplateColumns,
              labelWidth: Math.round(label.getBoundingClientRect().width),
              labelLines: Math.round(label.getBoundingClientRect().height / 16),
              controlWidth: Math.round(control.getBoundingClientRect().width),
              hintWidth: Math.round(hint.getBoundingClientRect().width),
              dividerWidth: Math.round(divider.getBoundingClientRect().width),
              warningWidth: warning === null ? null : Math.round(warning.getBoundingClientRect().width),
            });
          });
        }
        return JSON.stringify(out);
      })()`
      await evaluate('Page.enable', {})
      await evaluate('Page.navigate', { url: 'file:///' + page.replace(/\\/g, '/') })
      await new Promise(resolve => setTimeout(resolve, 900))
      const result = await evaluate('Runtime.evaluate', { expression, returnByValue: true })
      return JSON.parse(result.result.value)
    })
  } finally {
    try {
      rmSync(page, { force: true })
    } catch {
      // ignore
    }
  }
}

/**
 * Drive a headless Chromium over the DevTools protocol.
 *
 * @param browser - the executable path.
 * @param body - receives `(method, params) => Promise<result>` and returns its value.
 * @returns whatever `body` returned.
 */
async function withChromium(browser, body) {
  // A UNIQUE port and profile per launch. A pid-derived port looked deterministic and was
  // the opposite: an instance left over from a previous run still holds both, the freshly
  // spawned one exits because it cannot bind, and the protocol queries then reach the
  // LEFTOVER page — which answers with whatever document it was last navigated to. That
  // measured the wrong build silently (a mutant intended to go red measured green), so the
  // pair is random and the client is verified to be the one this process started.
  const port = 9400 + Math.floor(Math.random() * 500)
  const profile = join(tmpdir(), `dsh-workflow-grid-profile-${process.pid}-${Date.now()}`)
  const child = spawn(
    browser,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      '--no-first-run',
      '--no-default-browser-check',
      `--user-data-dir=${profile}`,
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

  let socket
  try {
    let target
    for (let attempt = 0; attempt < 60 && target === undefined; attempt += 1) {
      if (child.exitCode !== null) throw new Error(`the browser exited early with ${child.exitCode} (port ${port})`)
      try {
        const response = await fetch(`http://127.0.0.1:${port}/json/list`)
        const targets = await response.json()
        target = targets.find(entry => entry.type === 'page' && entry.webSocketDebuggerUrl !== undefined)
      } catch {
        // not up yet
      }
      if (target === undefined) await sleep(250)
    }
    if (target === undefined) throw new Error('the DevTools endpoint never came up')

    socket = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })

    let nextId = 1
    const pending = new Map()
    socket.addEventListener('message', event => {
      const message = JSON.parse(event.data)
      const entry = pending.get(message.id)
      if (entry === undefined) return
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
      else entry.resolve(message.result)
    })
    const send = (method, params) =>
      new Promise((resolve, reject) => {
        const id = nextId
        nextId += 1
        pending.set(id, { resolve, reject })
        socket.send(JSON.stringify({ id, method, params }))
      })

    return await body(send)
  } finally {
    try {
      socket?.close()
    } catch {
      // ignore
    }
    child.kill()
    try {
      rmSync(profile, { force: true, recursive: true })
    } catch {
      // ignore
    }
  }
}
