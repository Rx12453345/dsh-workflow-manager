/**
 * Mutation harness for the CONVERSATION-PAGE TAB (project scope).
 *
 * For each mutant: apply one literal edit to `lib/client.js`, run `test/status.test.mjs`,
 * record whether the named test went RED, then restore the file byte-for-byte and verify
 * the hash. A test that cannot go red is not a test.
 *
 * WHY THIS FILE EXISTS SEPARATELY from `mutation-check-panel.mjs`: that harness covers the
 * plugin-DEFAULTS surfaces (the settings page and the sidebar panel). This one covers the
 * correction — the tab that reads THIS project's `.dsh/workflow.yml` — and keeps its own
 * list so a mutant that stops applying (because the code it targets moved) is reported as
 * APPLY-FAILED instead of silently disappearing into a longer list.
 *
 * P28 ONWARDS COVER THE EFFECTIVE-CONFIGURATION MIRROR: the browser-side copy of host
 * resolution (the YAML subset reader, the layered merge, the layer marker, the approval and
 * evaluator gates) that lets the tab answer "what is in force here". Each of those mutants is
 * caught by the DIFFERENTIAL test that runs the HOST'S OWN function beside the copy, which is
 * the only kind of test that can distinguish a faithful mirror from a plausible one.
 *
 * Usage: node tooling/mutation-check-project-tab.mjs [P1 P4 ...]
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'

// The lock is reached from the project's own tooling directory: `mutation-check-approval`
// mutates lib/client.js too, and this harness rewrites the same file, so they must contend.
import { EXIT_LOCK_HELD, MutationLockHeld, withMutationLock } from './mutation-lock.mjs'

/** Every harness takes this lock, so no two of them can rewrite lib/ at the same time. */
const LABEL = 'tooling/mutation-check-project-tab.mjs'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const CLIENT = `${ROOT}lib/client.js`
const only = new Set(process.argv.slice(2))

const TEST_BODY = 'the project tab reads the project file and the defaults layer, with no write path'
const TEST_REG = 'the tab is registered into conversation.view with its own id and a thunk label'
const TEST_SCOPE = 'the project tab is scoped to this project and labels every layer it shows'
const TEST_PATH = 'the project tab resolves the file through the Session, and the path mirrors the host'
const TEST_LAYOUT = 'the conversation column is inset, width-capped, and never centred'
const TEST_PANEL = 'the sidebar panel is narrower and airier than the plugin page'
const TEST_KEYS = 'the project tab lists what the FILE declares, not what the config resolves to'
const TEST_RESULT = 'a refused read is a failure BRANCH, not an empty file'
const TEST_FAILURE = 'a missing file and an unreadable one send the user to different remedies'
// The EFFECTIVE-CONFIGURATION mirror's own tests. Each mutant below names the ONE test that has to
// go red, so a mutant that stops being observable shows up as MISSED rather than as a silent pass.
const TEST_PARSE = 'the browser YAML reader parses exactly what the host parses'
const TEST_MERGE = 'the browser merge resolves exactly what the host resolves'
const TEST_LAYER = 'the layer marker names the layer the merge actually used'
const TEST_LEAVES = 'every leaf of the tree is enumerated, and an empty section is a leaf'
const TEST_VALUE = 'a value is rendered as the plugin holds it, never re-worded'
const TEST_APPROVAL = 'the approval mirror refuses exactly what the host refuses'
const TEST_EVALUATOR = 'the evaluator mirror refuses exactly what the host refuses'
const TEST_CONSTANTS = 'every constant and vocabulary the mirror uses is pinned to the host\u2019s own'
const TEST_NOFILE = 'no configuration table is rendered without a readable project file'
const TEST_DEFAULTS = 'the defaults layer is read from the snapshot and never guessed when it is not ready'
const TEST_VIEW = 'the effective view marks each row with the layer that won it'
const TEST_REFUSED = 'a refused approval section shows the fail-closed values and what the file asked for'
const TEST_UNKNOWN = 'the approval mirror reports UNKNOWN rather than a guessed value when it cannot decide'
const TEST_EVALNOTE = 'an evaluator section the host would refuse is marked, not silently printed'
const TEST_ASIDE = 'the aside under a value is shown only when it says something'
const TEST_DICT = 'every key the tab renders exists in BOTH dictionaries, and the computed ones interpolate'

const MUTANTS = [
  {
    id: 'P1',
    what: 'the tab reads the PLUGIN-DEFAULT form instead of the project file',
    find: `      const sessionId = props?.sessionId`,
    replace: `      const sessionId = props?.sessionId
      const form = props?.controller ?? resolveForm(props, props?.ctx)`,
    must: [TEST_BODY],
  },
  {
    id: 'P2',
    what: 'the tab renders the plugin-defaults editor (WorkflowCard) under the project heading',
    find: `      const children = []
      children.push(
        react.createElement(
          'div',
          { key: 'title', style: { fontSize: '16px', fontWeight: 600, margin: '0 0 4px' } },`,
    replace: `      const children = []
      children.push(react.createElement(WorkflowCard, { ...props, key: 'card' }))
      children.push(
        react.createElement(
          'div',
          { key: 'title', style: { fontSize: '16px', fontWeight: 600, margin: '0 0 4px' } },`,
    must: [TEST_BODY],
  },
  {
    id: 'P3',
    what: 'the read stops addressing the file through the Session (sessionId dropped, so it is read through the wrong authority)',
    find: `        pending = read(sessionId, PROJECT_FILE, { limit: PROJECT_FILE_LINES }, controller?.signal)`,
    replace: `        pending = read(PROJECT_FILE, { limit: PROJECT_FILE_LINES }, controller?.signal)`,
    must: [TEST_BODY],
  },
  {
    id: 'P4',
    what: 'the range object is dropped, so the argument count no longer matches the descriptor',
    find: `        pending = read(sessionId, PROJECT_FILE, { limit: PROJECT_FILE_LINES }, controller?.signal)`,
    replace: `        pending = read(sessionId, PROJECT_FILE, controller?.signal)`,
    must: [TEST_BODY],
  },
  {
    id: 'P5',
    what: 'the reader comes from somewhere other than the shipped workspaceFiles namespace',
    find: `        files = ctx?.get?.('remote.workspaceFiles')`,
    replace: `        files = ctx?.configForms`,
    must: [TEST_BODY],
  },
  {
    id: 'P6',
    what: 'a refused read is read as SUCCESS (the empty-<pre> defect)',
    find: `      if (result.ok !== true) {`,
    replace: `      if (false) {`,
    must: [TEST_RESULT],
  },
  {
    id: 'P7',
    what: 'the absence code is dropped, so "not opted in" is never reported',
    find: `      if (typeof failure.code === 'string' && absentCodes.includes(failure.code)) return true`,
    replace: ``,
    must: [TEST_FAILURE],
  },
  {
    id: 'P8',
    what: 'absence is decided by matching words in the diagnostic message (the fail-open direction)',
    find: `      return /\\bENOENT\\b/.test(message)`,
    replace: `      return /not found|absent|no such file/i.test(message)`,
    must: [TEST_FAILURE],
  },
  {
    id: 'P9',
    what: 'the INDENT guard is disabled (the key pattern\'s `^` anchor still holds the rule)',
    find: `        if (/^\\s/.test(line)) continue`,
    replace: `        if (false) continue`,
    must: [TEST_KEYS],
    // SEE THE `projectFileKeys` DOCSTRING: the "starts at column zero" rule is carried by this
    // guard AND by the `^` anchor of the key pattern, so disabling either one changes NO OUTPUT —
    // the behavioural cases cannot tell them apart. What DOES catch this mutant is the
    // REDUNDANCY assertion in `test/status.test.mjs`, which requires both carriers to be present
    // in the shipped source; measured, this mutant is CAUGHT by it. The `equivalent` flag is
    // therefore deliberately NOT set: if a future edit drops that structural assertion, this
    // mutant must show up as MISSED rather than be excused by a stale label.
  },
  {
    id: 'P9b',
    what: 'the key pattern loses its `^` anchor (the indent guard still holds the rule)',
    find: `        const match = /^([A-Za-z_][A-Za-z0-9_-]*)\\s*:/.exec(line)`,
    replace: `        const match = /([A-Za-z_][A-Za-z0-9_-]*)\\s*:/.exec(line)`,
    must: [TEST_KEYS],
    // The companion of P9, caught the same way (the same structural assertion) and unflagged for
    // the same reason. Together they are the reason the "column zero" rule cannot be deleted one
    // carrier at a time: removing either leaves the other enforcing it behaviourally, and the
    // source assertion refuses to let either disappear.
  },
  {
    id: 'P10',
    what: 'the key reader stops stripping CR before classifying a line',
    find: `        const line = rawLine.endsWith('\\r') ? rawLine.slice(0, -1) : rawLine`,
    replace: `        const line = rawLine`,
    must: [TEST_KEYS],
    // NO BEHAVIOURAL DIFFERENCE, and that is a property of the code rather than a gap in
    // the test. The three guards are mutually exclusive and the key pattern stops before
    // the CR, so a `\r` appended to any line the reader accepts is also accepted with it.
    // The `\r` therefore cannot change any output of THIS function; it is stripped so the
    // rule reads as an indentation rule rather than a whitespace-class coincidence. The
    // place where it IS observable is `firstLine`, which the same test covers and which
    // returns the CR verbatim without the strip.
    equivalent: true,
  },
  {
    id: 'P11',
    what: 'the tab registers without an id, so viewTabs() skips it and no tab appears',
    find: `              id: VIEW_ID,`,
    replace: ``,
    must: [TEST_REG],
  },
  {
    id: 'P12',
    what: 'the label stops being a thunk, so a locale switch cannot re-render it',
    find: `              label: () => t('viewProject'),`,
    replace: `              label: t('viewProject'),`,
    must: [TEST_REG],
  },
  {
    id: 'P13',
    what: 'the tab id collides with the trajectory tab (which the developer switch may hide)',
    find: `    const VIEW_ID = 'workflow-project'`,
    replace: `    const VIEW_ID = 'trajectory'`,
    must: [TEST_REG],
  },
  {
    id: 'P14',
    what: 'the registration is a bare register() instead of slots.inject',
    find: `      ctx.slots.inject(VIEW_SLOT, function () {`,
    replace: `      ;(function () {`,
    must: [TEST_REG],
  },
  {
    id: 'P15',
    what: 'the project file path drifts to a plugin path the tab cannot read',
    find: `    const PROJECT_FILE = '.dsh/workflow.yml'`,
    replace: `    const PROJECT_FILE = 'cordis.patch.yml'`,
    must: [TEST_PATH],
  },
  {
    id: 'P16',
    what: 'the column is CENTRED instead of inset (marginRight auto removed)',
    find: `        padding: \`\${TAB_GUTTER_PX}px \${margin}px 56px\`,
        maxWidth: \`\${margin * 2 + TAB_MAX_WIDTH_PX}px\`,
        marginRight: 'auto',`,
    replace: `        padding: \`\${TAB_GUTTER_PX}px \${margin}px 56px\`,
        maxWidth: \`\${margin * 2 + TAB_MAX_WIDTH_PX}px\`,
        marginLeft: 'auto',
        marginRight: 'auto',`,
    must: [TEST_LAYOUT],
  },
  {
    id: 'P17',
    what: 'the margin stops growing with the pane (a fixed gutter on any window)',
    find: `      return Math.max(TAB_MARGIN_MIN_PX, Math.round(width * TAB_MARGIN_RATIO))`,
    replace: `      return TAB_MARGIN_MIN_PX`,
    must: [TEST_LAYOUT],
  },
  {
    id: 'P18',
    what: 'a NaN width reaches the style object, dropping the whole declaration',
    find: `    function paneWidthOf(paneWidth) {
      return typeof paneWidth === 'number' && Number.isFinite(paneWidth) && paneWidth > 0 ? paneWidth : 0
    }`,
    replace: `    function paneWidthOf(paneWidth) {
      return paneWidth
    }`,
    must: [TEST_LAYOUT],
  },
  {
    id: 'P19',
    what: 'the sidebar panel loses its width cap and goes back to tiling the pane',
    find: `            maxWidth: \`\${PANEL_MAX_WIDTH_PX}px\`,`,
    replace: `            maxWidth: '100%',`,
    must: [TEST_PANEL],
  },
  {
    id: 'P20',
    what: 'the panel rows go back to the page\'s spacing (the "tiles the screen" complaint)',
    // The panel geometry moved to a module constant (`panelRowStyle`) when the one-column fix
    // needed the template and the gap in one place: the mutant follows it, so it keeps
    // applying instead of silently disappearing from the list.
    find: `      gap: \`\${PANEL_ROW_GAP} \${PANEL_COLUMN_GAP}\`,`,
    replace: `      gap: '2px 0',`,
    must: [TEST_PANEL],
  },
  {
    id: 'P21',
    what: 'the tab stops saying it is not the defaults editor',
    find: `        react.createElement('p', { key: 'nofallback', style: tabWarningStyle }, t('projectNoFallback')),`,
    replace: ``,
    must: [TEST_SCOPE],
  },
  {
    id: 'P22',
    what: 'the warning stops naming the other layer, so the two scopes look the same',
    find: `      projectNoFallback:
        '注意：本页只读。每行都标了来源：「本工程覆盖」来自本工程的 .dsh/workflow.yml；「继承自默认值」来自插件默认值层——也就是左边侧边栏面板与「设置 → 插件」页改的那一层（影响所有工程）。本页只显示，不写任何一层。',`,
    replace: `      projectNoFallback: '注意：本页只读。',`,
    must: [TEST_SCOPE],
  },
  {
    id: 'P23',
    what: 'the tab goes back to the bare read-only answer, with no statement of what was checked',
    find: `          react.createElement('p', { style: tabNoteStyle, key: 'nw-b' }, t('projectNoWriteBody')),
          react.createElement('p', { style: tabNoteStyle, key: 'nw-f' }, t('projectNoWriteFooter')),`,
    replace: ``,
    must: [TEST_SCOPE],
  },
  {
    id: 'P24',
    what: 'the read-only copy stops naming the namespaces it checked, so the claim cannot be re-checked',
    find: `        '因为没找到能写这个文件的真实通路，而不是没做。逐个查过：workspaceFiles 只读；workspace 命名空间能在工作区列表里新建/改名/删除/排序，但不碰工作区里的任何文件；settings 命名空间确实有写方法，但它按「profile 条目 id」寻址，落盘到当前 profile 的插件配置补丁——那正是本页要区分开的插件默认值那一层，不是本工程的 .dsh/workflow.yml。本工程文件目前的写入口只有 workflow_init 与 workflow_set 两个工具。',`,
    replace: `        '这个页面是只读的。要改本工程设置，请用工具。',`,
    must: [TEST_SCOPE],
  },
  {
    id: 'P25',
    what: 'the read path also reaches the settings namespace (a second reader that cannot address a project file)',
    find: `        files = ctx?.get?.('remote.workspaceFiles')`,
    replace: `        files = ctx?.get?.('remote.workspaceFiles')
        ctx?.get?.('remote.settings')?.describe?.()`,
    must: [TEST_BODY],
  },
  {
    id: 'P26',
    what: 'the read path calls a mutation on workspaceFiles (a fabricated bridge), written through a local alias so the narrow pattern misses it',
    find: `        files = ctx?.get?.('remote.workspaceFiles')`,
    replace: `        files = ctx?.get?.('remote.workspaceFiles')
        files?.write?.(sessionId, PROJECT_FILE, 'tier: minimal')`,
    must: [TEST_BODY],
  },
  {
    id: 'P27',
    what: 'the read path reaches the workspace namespace (which can mutate the Workspace list but no file inside one)',
    find: `        files = ctx?.get?.('remote.workspaceFiles')`,
    replace: `        files = ctx?.get?.('remote.workspaceFiles')
        ctx?.get?.('remote.workspace')?.rename?.({ workspaceId: 'x', title: 'y' })`,
    must: [TEST_BODY],
  },
  // -------------------------------------------------------------------------
  // THE EFFECTIVE-CONFIGURATION MIRROR. Every one of these targets a rule that was COPIED from a
  // host module, and each is caught by the DIFFERENTIAL test that runs the host's own function
  // beside the copy — which is the only kind of test that can tell a faithful mirror from a
  // plausible one. Ordered from the file reader down to the rendered row.
  // -------------------------------------------------------------------------
  {
    id: 'P28',
    what: 'the merge REPLACES a nested section instead of merging it (the sibling-key loss mergeInto exists to prevent)',
    find: `        merged[key] = mergeConfigValue(merged[key], value)`,
    replace: `        merged[key] = cloneConfigValue(value)`,
    must: [TEST_MERGE],
  },
  {
    id: 'P29',
    what: 'the empty-project branch is dropped (a non-object project value would wipe the whole configuration)',
    find: `      if (!isConfigObject(project) || Object.keys(project).length === 0) return cloneConfigValue(defaults)
      return mergeConfigValue(defaults, project)`,
    replace: `      return mergeConfigValue(defaults, project)`,
    must: [TEST_MERGE],
  },
  {
    id: 'P30',
    what: 'a leaf the project names is reported as inherited (every override loses its layer)',
    find: `        if (index === path.length - 1) return 'project'`,
    replace: `        if (false) return 'project'`,
    must: [TEST_LAYER],
  },
  {
    id: 'P31',
    what: 'an ancestor assigned wholesale no longer marks its whole subtree as the project\u2019s',
    find: `        if (!isConfigObject(value)) return 'project'`,
    replace: `        if (!isConfigObject(value)) return 'inherited'`,
    must: [TEST_LAYER],
  },
  {
    id: 'P32',
    what: 'an EMPTY section stops being a leaf, so a malformed `evaluator: {}` disappears from the page',
    find: `        if (!isConfigObject(node) || Object.keys(node).length === 0) {`,
    replace: `        if (!isConfigObject(node)) {`,
    must: [TEST_LEAVES],
  },
  {
    id: 'P33',
    what: 'the file-level rule is dropped: a file that could not be read still has its approval section honoured',
    find: `      if (Array.isArray(fileProblems) && fileProblems.length > 0) {`,
    replace: `      if (false) {`,
    must: [TEST_APPROVAL],
  },
  {
    id: 'P34',
    what: 'a non-object approval section is normalised into the defaults instead of being refused',
    find: `      if (section !== undefined && section !== null && !isConfigObject(section)) {`,
    replace: `      if (false) {`,
    must: [TEST_APPROVAL],
  },
  {
    id: 'P35',
    what: 'the fail-closed threshold is widened back to the documented default',
    find: `        riskThreshold: FAIL_CLOSED_APPROVAL.riskThreshold,`,
    replace: `        riskThreshold: 'medium',`,
    must: [TEST_APPROVAL],
  },
  {
    id: 'P36',
    what: 'the approval axes are built without the veto field the host gate reads',
    find: `        section.rows = ['strength', 'riskThreshold', 'denyHighAlways', 'exemptTools'].map(axis => {`,
    replace: `        section.rows = ['strength', 'riskThreshold', 'denyHighAlways'].map(axis => {`,
    must: [TEST_APPROVAL],
  },
  {
    id: 'P37',
    what: 'a refused section shows the MERGED value under a fail-closed badge (a report describing a gate that is not running)',
    find: `            value: gate[axis],`,
    replace: `            value: mergedSection[axis],`,
    must: [TEST_REFUSED],
  },
  {
    id: 'P38',
    what: 'the value the file asked for is dropped, so a refusal no longer says what it cost',
    find: `            asked: layer === 'fail-closed' && asked !== undefined ? asked : null,`,
    replace: `            asked: null,`,
    must: [TEST_REFUSED],
  },
  {
    id: 'P39',
    what: 'the refusal rows stop being counted as refusals, so the summary contradicts the table',
    find: `        const bucket = row.source === 'fail-closed' ? 'refused' : row.source`,
    replace: `        const bucket = row.source`,
    must: [TEST_REFUSED],
  },
  {
    id: 'P40',
    what: 'an unresolved row is rendered as a VALUE (the guessed number this page must never print)',
    find: `      if (source === 'unknown') return { value: null, shadow: null, asked: null }`,
    replace: `      if (false) return { value: null, shadow: null, asked: null }`,
    must: [TEST_ASIDE],
  },
  {
    id: 'P41',
    what: 'a re-stated default is printed as a shadow, so an override that changes nothing looks like one',
    find: `          source === 'project' && row.previousKnown === true && !configValuesEqual(row.previous, row.value)`,
    replace: `          source === 'project' && row.previousKnown === true`,
    must: [TEST_ASIDE],
  },
  {
    id: 'P42',
    what: 'null is rendered as an empty string, so "unset" and "empty" look the same',
    find: `      if (value === null) return 'null'`,
    replace: `      if (value === null) return ''`,
    must: [TEST_VALUE],
  },
  {
    id: 'P43',
    what: 'the view renders a configuration table with no readable file (an absent file painted as opted in)',
    find: `      if (file === null || typeof file !== 'object' || file.state !== 'ok') {`,
    replace: `      if (false) {`,
    must: [TEST_NOFILE],
  },
  {
    id: 'P44',
    what: 'the defaults layer is read off a NON-READY snapshot (a document that is not loaded read as the configuration)',
    find: `      if (snapshot.status !== 'ready') return { state: 'loading', value: null }`,
    replace: `      if (false) return { state: 'loading', value: null }`,
    must: [TEST_DEFAULTS],
  },
  {
    id: 'P45',
    what: 'the tab reads the PANEL row\u2019s settings instead of the core row\u2019s',
    find: `        return ctx?.configForms?.get?.(ENTRY_ID)`,
    replace: `        return ctx?.configForms?.get?.(PANEL_ENTRY_ID)`,
    must: [TEST_DEFAULTS],
  },
  {
    id: 'P46',
    what: 'the defaults layer is reported as readable without an approval section, so every axis is called fail-closed',
    find: `      const approvalMirrorable = effective !== null && isConfigObject(defaultsValue.approval)`,
    replace: `      const approvalMirrorable = effective !== null`,
    // CAUGHT BY THE TEST THAT OWNS THE DECISION, not by the view test: the view test's defaults
    // layer DOES carry an approval section, so it cannot observe this. The mutation also takes the
    // evaluator-note test red (a spurious fail-closed approval section moves `counts.refused` off
    // zero), so the kill is real on two independent surfaces.
    must: [TEST_UNKNOWN],
  },
  {
    id: 'P47',
    what: 'the effective rows stop being marked at all (every value looks like the project\u2019s own)',
    find: `      if (source === 'project') return { key: 'projectLayerProject', style: configProjectBadgeStyle }`,
    replace: `      if (false) return { key: 'projectLayerProject', style: configProjectBadgeStyle }`,
    must: [TEST_SCOPE],
  },
  {
    id: 'P48',
    what: 'the empty dimensions list is honoured, so a section the host refuses is reported as runnable',
    find: `      const dimensions = readList(source.dimensions ?? defaults.dimensions, defaults.dimensions, false)`,
    replace: `      const dimensions = readList(source.dimensions ?? defaults.dimensions, defaults.dimensions, true)`,
    must: [TEST_EVALUATOR],
  },
  {
    id: 'P49',
    what: 'a veto naming an unscored dimension is accepted (every review would fail without saying why)',
    find: `      if (dimensions !== undefined && mustPass !== undefined && mustPass.some(name => !dimensions.includes(name))) {`,
    replace: `      if (false) {`,
    must: [TEST_EVALUATOR],
  },
  {
    id: 'P50',
    what: 'the YAML reader treats a blank line as a problem (the file would look unreadable)',
    find: `        if (withoutComment.trim() === '') continue`,
    replace: `        if (false) continue`,
    must: [TEST_PARSE],
  },
  {
    id: 'P51',
    what: 'the YAML reader strips a `#` that is not preceded by whitespace (a value is cut in half)',
    find: `            if (i === 0 || /\\s/.test(line[i - 1])) return line.slice(0, i)`,
    replace: `            return line.slice(0, i)`,
    must: [TEST_PARSE],
  },
  {
    id: 'P52',
    what: 'the evaluator mirror accepts a bar outside the host\u2019s range',
    find: `      if (typeof bar !== 'number' || !Number.isFinite(bar) || bar < BAR_MIN || bar > BAR_MAX) problems.push('bar')`,
    replace: `      if (typeof bar !== 'number' || !Number.isFinite(bar)) problems.push('bar')`,
    must: [TEST_EVALUATOR],
  },
  {
    id: 'P53',
    what: 'the approval vocabulary stops matching the host\u2019s enum',
    find: `    const APPROVAL_STRENGTH_VALUES = ['ask-user', 'llm-then-user', 'llm-only', 'off']`,
    replace: `    const APPROVAL_STRENGTH_VALUES = ['ask-user', 'llm-then-user', 'llm-only']`,
    must: [TEST_CONSTANTS],
  },
  {
    id: 'P54',
    what: 'the pass-mark range drifts from lib/gate.js',
    find: `    const BAR_MAX = 10`,
    replace: `    const BAR_MAX = 11`,
    must: [TEST_CONSTANTS],
  },
  {
    id: 'P55',
    what: 'the fail-closed exemptions list stops being empty (calls that would skip a refused gate)',
    find: `      exemptTools: Object.freeze([]),
    })`,
    replace: `      exemptTools: Object.freeze(['workflow_status']),
    })`,
    must: [TEST_CONSTANTS],
  },
  {
    id: 'P56',
    what: 'a refused evaluator section is printed with no mark, so a project whose reviews all fail looks configured',
    find: `          sectionFor('evaluator').note = {
            key: 'projectEvaluatorRefused',
            detail: evaluatorProblems.map(name => (name === 'section' ? 'evaluator' : \`evaluator.\${name}\`)),
          }`,
    replace: ``,
    must: [TEST_EVALNOTE],
  },
  {
    id: 'P57',
    what: 'the summary line becomes a placeholder template, which this bundle\u2019s own translator would print unsubstituted',
    find: `      projectConfigSummary: (project, inherited, unknown) =>
        \`共 \${project} 项本工程覆盖 · \${inherited} 项继承自默认值 · \${unknown} 项未知\`,`,
    replace: `      projectConfigSummary: () => '共 {project} 项本工程覆盖 · {inherited} 项继承自默认值 · {unknown} 项未知',`,
    must: [TEST_DICT],
  },
]

const sha = text => createHash('sha256').update(text).digest('hex').slice(0, 12)

/**
 * Everything that touches the source happens under the lock: the snapshot, every mutant,
 * every restore, and the final verification. Nothing is read before the lock is held, so a
 * concurrently running harness cannot have its mutant recorded here as "the original".
 *
 * The signal handlers are registered BEFORE the lock is taken (so they run before the lock's
 * own backstop handler: Node runs handlers in registration order). `original` stays null until
 * the lock is held, so a Ctrl-C during acquisition can never write `undefined` over the source.
 */
async function main() {
  let original = null
  const restore = () => {
    if (original !== null) writeFileSync(CLIENT, original, 'utf8')
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
      original = readFileSync(CLIENT, 'utf8')
      const before = sha(original)

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
        const occurrences = original.split(mutant.find).length - 1
        if (occurrences !== 1) {
          rows.push({ ...mutant, applied: false, problem: `literal occurs ${occurrences}x` })
          continue
        }
        let output = ''
        let status = null
        try {
          writeFileSync(CLIENT, original.replace(mutant.find, mutant.replace), 'utf8')
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
        rows.push({
          ...mutant,
          applied: true,
          red: status !== 0,
          failed,
          missed,
          caught: failed.length > 0 && missed.length === 0,
        })
      }

      restore()
      const after = sha(readFileSync(CLIENT, 'utf8'))
      console.log('=== PROJECT-TAB MUTATION RESULTS ===')
      for (const row of rows) {
        if (!row.applied) {
          console.log(`${row.id.padEnd(4)} APPLY-FAILED  ${row.problem}`)
          continue
        }
        const mark = row.caught ? 'CAUGHT ' : row.red ? 'PARTIAL' : row.equivalent ? 'EQUIV  ' : 'MISSED '
        console.log(`${row.id.padEnd(4)} ${mark} red=${row.red ? 'yes' : 'no '} count=${row.failed.length}`)
        console.log(`     what: ${row.what}`)
        if (row.missed.length) console.log(`     NOT failing: ${row.missed.join(' ; ')}`)
        if (row.failed.length) console.log(`     failing: ${row.failed.slice(0, 3).join(' ; ')}${row.failed.length > 3 ? ` (+${row.failed.length - 3})` : ''}`)
      }
      const caught = rows.filter(row => row.caught).length
      const applied = rows.filter(row => row.applied).length
      const equivalent = rows.filter(row => row.equivalent && !row.caught).length
      const missed = rows.filter(row => row.applied && !row.caught && !row.equivalent).length
      console.log(`\ncaught ${caught}/${applied - equivalent} killable mutants (${equivalent} declared behaviourally equivalent, ${missed} missed)`)
      console.log(`source restored byte-for-byte: ${before === after ? 'YES' : 'NO — INVESTIGATE'}`)
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
