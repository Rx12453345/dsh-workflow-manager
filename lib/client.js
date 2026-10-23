/**
 * dsh-workflow — settings panel, browser half.
 *
 * Loading contract, confirmed against WORKING official client halves
 * (`dsh-client-ui-settings-subagent`, `dsh-client-ui-settings-shell`,
 * `dsh-client-ui-plugin-manager`):
 *
 *  - `package.json` exports this file as `./client` and declares
 *    `dsh.client.platform = "web"`; the client-modules host half scans ENABLED
 *    Loader entries and serves each declaration as a bundle.
 *  - The `id` below MUST equal the PACKAGE name — not the Loader row id from
 *    `cordis.patch.yml`. A mismatch makes the shell report "loaded without
 *    registering".
 *  - `ctx.slots.inject(slot, …)` mounts the page; a bare `ctx.slots.register()` is
 *    a no-op while the slot does not exist yet.
 *  - `plugins.row.config` is keyed `${packageName}#${rowId}` and is rendered
 *    TWICE by the plugin manager: once with `view: "summary"` to fill the row's
 *    description line, and once with `view: "page"` (plus a `form`) for the body.
 *    A registration that ignores `view` paints its whole body into the
 *    description line. The official convention is an early return:
 *    `if (props.view === "summary") return t("…Description")`.
 *  - The page's `form` capability is what `ConfigForms.get(entryId)` returns. The
 *    page only resolves it while the Host serves that namespace, so this page
 *    asks for the controller itself and treats the namespace directory as
 *    advisory — degrading to a readable message rather than to nothing.
 *
 * The form reads and writes the plugin entry's configuration. The controller
 * exposes `getSnapshot()` / `subscribe()` / `set(field, value)` / `mutate(ops,
 * revision)`. `set` reaches a TOP-LEVEL SCALAR and nothing else, so the top-level
 * scalars (`tier`, `recipe`) go through it and EVERY nested field goes through one
 * atomic op list — `form.mutate(fieldOps(section, key, value))`.
 *
 * WHY NO CONTROL EVER BUILDS A SECTION OBJECT. A write built from the value read at
 * RENDER time is a LOST UPDATE: two fast clicks on sibling fields in one section each
 * spread the same stale section, and the second write reverts the first. `modules`
 * was fixed that way first; `approval.strength`/`approval.riskThreshold` and
 * `evaluator.bar`/`evaluator.independent` had the same defect and now use the same
 * single-key op. `write` remains only for genuinely top-level scalars.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE SETTINGS LIVE — and why there are TWO of them, never one.
 * ---------------------------------------------------------------------------
 * `lib/config.js` fixes the resolution order as
 *
 *     defaults  →  patch-row config  →  the project's .dsh/workflow.yml
 *
 * and the two browser surfaces this file publishes are on OPPOSITE sides of that
 * boundary. Confusing them is the defect this comment exists to prevent, because both
 * sides are rendered by the same `WorkflowCard` and therefore look identical to a user:
 *
 *  - `plugins.row.config` (the settings page under 设置 → 插件) and the sidebar panel
 *    edit the PLUGIN ENTRY's configuration — the `configForms` namespace keyed by the
 *    Loader row id. That layer is the DEFAULTS for every project, and it is what
 *    `workflow_set`'s `write` path does NOT touch.
 *  - the `conversation.view` tab edits nothing at all. It READS the current session's
 *    own `.dsh/workflow.yml` through the shipped `workspaceFiles` Remote (the Session's
 *    own read authority; the service exposes no mutation operation) and prints it
 *    verbatim, with the absolute path the Host resolved. Writes stay with the
 *    `workflow_set` tool, which is the only writer of that file.
 *
 * The tab therefore never falls back to the plugin defaults. A tab that painted
 * `configForms` fields under a header saying "this project" would be exactly the mistake
 * it was built to correct, and `test/status.test.mjs` pins the separation.
 *
 * @module src-12453345_-dsh-workflow/client
 */

window.__ModuleLoader__.load({
  id: 'src-12453345_-dsh-workflow',
  factory: (require) => {
    const react = require('react')

    const NS = 'workflow'

    /** The Loader row whose configuration this page edits. */
    const ENTRY_ID = 'dsh-workflow-core'

    /**
     * The Loader row that OWNS the two sidebar fields (`showInSidebar`,
     * `sidebarLabel`).
     *
     * Deliberately not {@link ENTRY_ID}: those two fields are declared on the panel
     * row, the settings namespace directory is keyed by the entry that declares them,
     * and a page that asked the core row's controller for them would author a field
     * the core row's schema does not carry. `lib/config-schema.js` builds both rows'
     * schemas from the same `DEFAULT_CONFIG`, so the two ids are the only difference
     * worth naming here.
     */
    const PANEL_ENTRY_ID = 'dsh-workflow-panel'

    /** Diagnostic prefix: greppable in the browser console. */
    const DIAG = '[dsh-workflow:diag]'

    /**
     * The id shared by the sidebar entry and the `main` panel it opens.
     *
     * THIS IS THE SLOT CONTRACT, not a display string. `dsh-client-ui-sidebar`
     * fills its row list from `ctx.slots.entriesOfSlot('sidebar.panellist')` and
     * selects `ctx.layout.selectPanel(id)`; the layout renderer then projects the
     * `main` entry whose `key` is the same string. Its README states it plainly:
     * "The same id addresses the component registered in the layout's root-scoped
     * `main` keyed slot; selecting a missing main entry throws without changing the
     * current selection." A sidebar entry with no matching `main` registration is
     * therefore a click that throws, not one that opens nothing — which is why both
     * halves are registered together below and never separately.
     */
    const PANEL_ID = 'dsh-workflow'

    /**
     * Where this entry sits among the sidebar's global panels.
     *
     * The list is sorted by `order` (then registration sequence); the shipped
     * composition puts Plugins at 0 and Schedules at 1, so a high number parks the
     * workflow entry at the bottom without having to claim a slot between them.
     */
    const PANEL_ORDER = 100

    /**
     * The id of the tab this bundle adds to the conversation page, next to 「对话」/
     * 「轨迹」, and the slot it lives in.
     *
     * THE SLOT IS `conversation.view`, and that is READ OFF THE SHIPPED ASSEMBLY rather
     * than guessed:
     *
     *  - `dsh-client-ui-conversation` declares it as a session-scoped LIST child of
     *    `conversation.session`: `children: { "conversation.view": { kind: "list", scope:
     *    "session" } }` (`lib/client.js:18211-18214`).
     *  - `viewTabs()` walks `slots.entries("conversation.view")`, skips an entry with no
     *    `id`, drops `id === "trajectory"` while the developer switch is off, and builds
     *    `{ id: entry.options.id, label: resolveSlotLabel(entry.options.label) ??
     *    entry.options.id }` (`:17972-17984`). So `label` may be a string or a THUNK —
     *    `resolveSlotLabel` is literally `typeof label === 'function' ? label() : label`
     *    (`dsh-client-ui-slots/lib/index.js:27-29`).
     *  - Those tabs are rendered as `role="tablist"` / `role="tab"` buttons (`:16512-16525`).
     *  - The body is `renderSlot("conversation.view", { inspectCall, viewRequest, openView,
     *    completeViewRequest }, { only: viewId })` (`:16415-16420`) — so the slot receives
     *    exactly the entry whose `id` is the active view, and the OWNER props (the third
     *    argument) do NOT carry `viewId`. The list renderer filters by
     *    `opts.only` (`dsh-client-ui-renderer/lib/client.js:1194`), which is why the body
     *    must NOT re-check a `viewId` prop: it is only ever rendered when it is the
     *    selected tab.
     *  - `order` places the tab: the shipped entries use `chat` 0 and `trajectory` 10
     *    (`dsh-client-ui-chat`, `dsh-client-ui-trajectory`), so 20 appends this one.
     *
     * An `id` is MANDATORY (the loop skips entries without one) and `label` is what the
     * user reads, so this tab stays independently identifiable — it does not depend on
     * 「轨迹」 being present, which it is not unless 开发者工具 is on.
     */
    const VIEW_SLOT = 'conversation.view'
    const VIEW_ID = 'workflow-project'
    const VIEW_ORDER = 20

    /**
     * The path of the project workflow file, relative to the Session's workspace root.
     *
     * MIRROR of `WORKFLOW_RELATIVE_PATH` in `lib/workflow-file.js`. A browser bundle
     * cannot import a host module (and must not — see the single-require test), so the
     * constant is repeated here and pinned by `test/status.test.mjs` against the host's
     * own export. The workspace-files README states the resolution rule explicitly:
     * "`read`, `readBytes`, and `stat` accept an absolute path or one relative to the
     * selected Session's workspace root."
     */
    const PROJECT_FILE = '.dsh/workflow.yml'

    /**
     * How many lines of the project file one page reads.
     *
     * `workspaceFiles.read` returns ONE line window and defaults its limit to the Host's
     * `maxLines`; asking for a number of our own means a project file longer than the
     * window is REPORTED as truncated rather than silently cut. `eof` is the honest
     * signal, so the renderer prints a truncation notice when it is false.
     */
    const PROJECT_FILE_LINES = 400

    /**
     * The conversation-page tab's content geometry.
     *
     * NOTE ON THE ATTRIBUTION, because an earlier version of this comment got it wrong: the
     * `轨迹` page is NOT an inset column — it is a full-bleed table (`width: 100%` in its
     * own module CSS). The conversation page's inset, width-capped column is the CHAT
     * message column (`--dsh-chat-content-width`, 748px), and that is what this tab
     * matches. The brief asked for "the design language of the 轨迹 page"; what it
     * describes (constrained width, generous horizontal margin, not strictly centred) is
     * the chat column, so that is what is implemented and what these numbers say.
     *
     * The values are functions of the pane width so the inset GROWS with the pane (a fixed
     * margin looks cramped on a wide window and eats a narrow one), and the total width is
     * capped where a line of text stops being readable.
     *
     * NOT CENTRED — the inset is applied as the column's HORIZONTAL PADDING (a fraction of
     * the pane) and its right margin is `auto`, so the column sits in the left part of the
     * pane with the remaining space to its right, exactly like the chat column beside it. No
     * `marginLeft` is emitted at all; the `auto` right margin is what would absorb the
     * slack if the cap ever made the column narrower than its box. `Math.max` guarantees
     * the inset never collapses below a usable gutter.
     */
    const TAB_MARGIN_RATIO = 0.08
    const TAB_MARGIN_MIN_PX = 24
    const TAB_MAX_WIDTH_PX = 760
    const TAB_GUTTER_PX = 16

    /**
     * The sidebar panel's own geometry. The panel is a narrow column, so it stays narrow
     * by construction and its rows are spaced wider than the settings page's: the
     * complaint being fixed is that the panel "tiles the entire screen" with fields
     * packed at 8px.
     *
     * `PANEL_COLUMN_GAP` is the horizontal half of that spacing. The panel's field grid is
     * a SINGLE stacked column, so no control ever sits beside another and the horizontal
     * gap has nothing to separate — it is kept because the grid's `gap` shorthand is set
     * from both numbers in one place, and a future two-column panel would otherwise have to
     * reinvent the value.
     */
    const PANEL_MAX_WIDTH_PX = 520
    const PANEL_ROW_GAP = '16px'
    const PANEL_COLUMN_GAP = '20px'
    const PANEL_ROW_PADDING = '10px 0'

    const zh = {
      loading: '正在载入配置…',
      unavailable: '本部署未提供设置服务，无法在界面中编辑。可改用 workflow_set 工具改参数。',
      namespaceMissing: name =>
        `设置服务已就绪，但它还没有服务「${name}」这个条目，所以暂时无法在此编辑。重启 DSH 后应出现；在此之前可用 workflow_set 工具改参数。`,
      notWritable: '当前不可写入。',
      description: '档位与开关、状态落盘、独立验收、审批强度。',
      tier: '默认档位',
      tierHint: 'minimal 轻量 / standard 标准 / strict 严格，按「犯错的代价」选。',
      recipe: '配方（覆盖档位）',
      approvalStrength: '审批强度',
      approvalHint: 'ask-user 全部问你；llm-then-user 模型先判、被拒交你；llm-only 模型全权；off 不拦截。',
      approvalWarning: '官方原文警告（选择 llm-only 或 off 时生效）',
      approvalBroken:
        '当前 approval 段不是一个对象，宿主会拒绝它；审批闸门将回退到最严格的默认值（ask-user / low / denyHighAlways）。改下面任一控件即可写成合法段。',
      // The shipped layer's own warning, VERBATIM — the same strings `lib/approval.js`
      // exports as OFFICIAL_AUTO_REVIEW_WARNING. A browser bundle cannot import a host
      // module, so the text is mirrored here and a test pins the mirror against the host
      // constant (`test/approval.test.mjs`), which is the same technique already used for
      // the pass-mark input.
      approvalWarningEn: [
        'Auto review is experimental: it can allow unsafe actions, deny useful work, and spend additional tokens.',
        'Auto provides no file sandbox. The outer `run_code` transport and direct Node effects inside a PTC program do not pass through inner-tool review.',
      ],
      approvalWarningZh: [
        'Auto review 是实验性的：它可能放行不安全的操作、拒绝有用的工作，并额外消耗 token。',
        '它不提供文件沙箱——run_code 内部的直接 Node 操作不经过内层工具审查。',
        '模型的分类可能出错；没有确定性豁免、没有持久授权、没有可配置策略、也没有重试层。',
      ],
      riskThreshold: '风险阈值',
      evaluatorBar: '验收及格线',
      evaluatorBarHint: '独立评审员的及格分数，低于此分自动回炉。',
      independentReview: '独立验收',
      independentReviewHint: '开启后由全新子代理打分，干活的不能自己宣称完工。',
      exemptTools: '审批豁免工具（approval.exemptTools）',
      exemptToolsHint: '逗号分隔的工具名；留空表示没有确定性豁免。',
      dimensions: '评审维度（evaluator.dimensions）',
      dimensionsHint:
        '逗号分隔；至少要有一个维度——清空会让任何评审都无法打分，宿主会拒绝它，所以这里也不写空值。',
      mustPass: '否决维度（evaluator.mustPass）',
      mustPassHint:
        '勾选「必须通过」的维度；一个都不勾表示只看平均分（宿主允许）。只能勾上面 dimensions 里已经有的维度——没被打分的维度没法否决。',
      mustPassUnavailable:
        'dimensions 现在不是一个合法的字符串列表，先把上面那一行改成逗号分隔的维度名，才能勾选否决维度。',
      maxDepth: '子代理深度上限（subagent.maxDepth）',
      maxDepthHint:
        '1 = 子代理不能再委派，评审只能在主对话里跑；2 = 允许「委派出去的主控再开一个评审员」。上限就是 2，不提供 3。',
      maxActiveSubagents: '并发子代理上限（subagent.maxActiveSubagents）',
      maxActiveSubagentsHint: '1 或更大的整数。',
      retireEnabled: '约束退役检查（retireCheck.enabled）',
      retireEveryDays: '退役检查间隔（retireCheck.everyDays）',
      retireEveryDaysHint: '1 或更大的整数天。',
      retireAutoSuggest: '自动给出退役建议（retireCheck.autoSuggest）',
      contextIsolation: '上下文隔离',
      contextIsolationHint: '每个工作单元起全新子代理，只带白名单内容。',
      modulesList: '模块开关（modules.*）',
      modulesListHint:
        '每一项都是一次独立的原子写入；清单来自当前配置，配置里新增的模块会自动出现在这里。',
      modulesSummary: '启用中的模块',
      advanced: '其余参数（context / acceptance / guards / escalation / budget / signoff / evaluator.maxRounds / verifier.sensors 等）请用 workflow_set 工具或编辑工程内的 .dsh/workflow.yml；本页提供常用选项、全部模块开关与主要嵌套段。',
      saved: '已保存',
      saveFailed: '未保存（宿主未接受该值）',
      panelLabel: '工作流设置',
      showInSidebar: '在侧边栏显示「工作流设置」',
      showInSidebarHint: '关掉后要刷新页面，侧边栏里这一项才消失。要再打开，到「设置 → 插件 → dsh-workflow-panel」行。工具不受影响，始终照常工作。',
      projectNote: '本页修改的是「新工程的默认值」。要让某个具体工程生效，在该工程里运行 workflow_init，再用 workflow_set 覆盖。',
      // ---- the conversation-page tab (PROJECT scope) --------------------------
      viewProject: '工作流（本工程）',
      projectTitle: '本工程的工作流设置',
      projectScope: '作用域：本工程',
      // ---- human labels for the tab's config rows ------------------------------
      // The tab lists the EFFECTIVE config as dotted paths (`modules.planner`). A dotted
      // path is precise but unreadable — the user's complaint was exactly that. Labels
      // live here because the browser half cannot import host modules; ANY path with no
      // entry falls back to its dotted form, so a config key added on the host still
      // appears (as its path) instead of vanishing from the page.
      projectSections: {
        tier: '档位', recipe: '配方', modules: '模块开关', approval: '审批',
        evaluator: '独立评审', subagent: '子代理', retireCheck: '约束退役',
        context: '上下文', acceptance: '验收协商', guards: '护栏', escalation: '升级',
        budget: '预算', signoff: '签署', verifier: '验证器',
      },
      projectLeaves: {
        tier: '档位', recipe: '配方',
        'approval.strength': '审批强度',
        'approval.riskThreshold': '风险阈值',
        'approval.denyHighAlways': '始终拒绝高风险',
        'approval.exemptTools': '审批豁免工具',
        'evaluator.bar': '验收及格线',
        'evaluator.dimensions': '评审维度',
        'evaluator.mustPass': '否决维度',
        'evaluator.independent': '独立验收',
        'evaluator.maxRounds': '评审最大轮数',
        'subagent.maxDepth': '子代理深度上限',
        'subagent.maxActiveSubagents': '并发子代理上限',
        'retireCheck.enabled': '约束退役检查',
        'retireCheck.everyDays': '退役检查间隔（天）',
        'retireCheck.autoSuggest': '自动给出退役建议',
        'context.isolation': '上下文隔离',
        'context.exclude': '排除内容',
        'context.overflow': '溢出处理',
        'context.requireBootstrap': '要求开机清单',
        'acceptance.negotiateBeforeBuild': '开工前先协商验收',
        'acceptance.maxRounds': '协商最大轮数',
        'verification.policy': '验证强度策略',
        'verification.confirmation': '验证确认方式',
        'modules.planner': '规划（planner）',
        'modules.featuresJson': '功能清单落盘',
        'modules.progressLog': '进度日志',
        'modules.handoffDoc': '交接文档',
        'modules.acceptance': '验收协商',
        'modules.independentReview': '独立评审',
        'modules.selfVerify': '自查',
        'modules.gcCode': '代码垃圾回收',
        'modules.gcDocs': '文档垃圾回收',
        'modules.constraintLedger': '约束账本',
        'modules.stats': '统计',
        'modules.gitCommitPerFeature': '每功能点提交',
        'modules.isolation': '上下文隔离',
      },
      projectLoading: '正在读取本工程的 .dsh/workflow.yml…',
      projectNotOptedIn:
        '本工程没有 .dsh/workflow.yml，所以工作流没有启用。要启用：在工程里运行 workflow_init（或让模型调用 workflow_init 工具）。',
      projectNoReader:
        '这个部署没有把 workspaceFiles 只读接口交给浏览器，所以这里读不到本工程的文件内容。下面的路径与「怎么改」仍然准确；要读内容可以用 workflow_status 工具。',
      projectReadFailed: '读取本工程的 .dsh/workflow.yml 失败：',
      projectBytes: '字节',
      projectVersion: '版本',
      projectTruncated: '只显示了前若干行（文件更长）。完整内容请用 workflow_status 或直接打开该文件。',
      projectSource: '内容直接来自', 
      projectNoFallback:
        '注意：本页只读。每行都标了来源：「本工程覆盖」来自本工程的 .dsh/workflow.yml；「继承自默认值」来自插件默认值层——也就是左边侧边栏面板与「设置 → 插件」页改的那一层（影响所有工程）。本页只显示，不写任何一层。',
      projectWriteHeading: '怎么改',
      projectWriteBody:
        '浏览器半只能读这个文件，不能写它：workspaceFiles 接口按设计不提供任何修改操作。写入一律走 workflow_set 工具（点路径、写入前校验）：',
      projectNoWriteHeading: '为什么这里没有编辑框',
      projectNoWriteBody:
        '因为没找到能写这个文件的真实通路，而不是没做。逐个查过：workspaceFiles 只读；workspace 命名空间能在工作区列表里新建/改名/删除/排序，但不碰工作区里的任何文件；settings 命名空间确实有写方法，但它按「profile 条目 id」寻址，落盘到当前 profile 的插件配置补丁——那正是本页要区分开的插件默认值那一层，不是本工程的 .dsh/workflow.yml。本工程文件目前的写入口只有 workflow_init 与 workflow_set 两个工具。',
      projectNoWriteFooter:
        '所以这里不放控件：宁可不给，也不拿「插件默认值编辑器」冒充本工程设置，更不手写一个假的 Remote 描述符。将来若出现能按路径写本工程文件的官方通路，再接上编辑。',
      projectWriteExample: 'workflow_set path=tier value=standard',
      projectWriteInitExample: 'workflow_init',
      projectReadExample: 'workflow_status',
      projectFileHeading: '文件',
      projectPathHeading: '路径（宿主解析的绝对路径）',
      projectPathPending: '（读到文件后显示）',
      projectKeys: '本文件显式设置的键',
      projectKeysNone: '（文件为空或无法解析——以上原文是唯一权威来源）',
      projectOnlySet:
        '只列本文件写下的键。其余参数走默认值或插件默认值，本文件没有覆盖它们，所以这里也不显示——否则会把「继承来的值」画成「本工程的设置」。',
      projectRefresh: '重新读取',
      projectFileEmpty: '（空文件）',
      projectUnavailableTitle: '读不到本工程文件',
      // ---- the EFFECTIVE configuration (what the tab now leads with) -------------
      projectConfigHeading: '本工程的实际生效配置',
      projectConfigIntro:
        '下面每一条都是本工程现在真正生效的值。宿主把「本工程的 .dsh/workflow.yml」叠加在「插件默认值」之上——后者就是「设置 → 插件」页和侧边栏面板里改的那一层，对所有工程生效。',
      projectConfigLegend:
        '「本工程覆盖」= 本工程的文件自己写了这一项；「继承自默认值」= 本工程没写，用的是插件默认值；「未知」= 默认值层读不到，本页不猜。',
      projectConfigSummary: (project, inherited, unknown) =>
        `共 ${project} 项本工程覆盖 · ${inherited} 项继承自默认值 · ${unknown} 项未知`,
      projectConfigRefusedCount: refused => ` · ${refused} 项被宿主拒绝（fail-closed）`,
      projectDefaultsLoading: '正在读取插件默认值层（设置文档）… 读取完成前只显示本工程自己写的项。',
      projectDefaultsUnavailable:
        '这个部署没有为 dsh-workflow-core 提供设置文档，所以插件默认值层读不到。本页只显示本工程文件里自己写的项，继承来的值一律显示为未知而不是猜一个。',
      projectDefaultsUnknownNote: '默认值层当前不可读，因此这里看不到「被覆盖前的默认值」。',
      projectParseProblems: '这个文件没有被完整读懂，宿主的读取器报告了这些问题：',
      projectApprovalRefused:
        '宿主已拒绝本工程的 approval 段，实际生效的是 fail-closed（最严格）默认值：每条都要你确认、阈值 low、高风险一律拒绝、没有豁免。「文件要求」是文件里写的值，也就是被拒绝的那个。原因：',
      projectEvaluatorRefused:
        '宿主会拒绝本工程的 evaluator 段，所以本工程里的独立评审跑不起来（workflow_review 会直接失败）。下面的值是文件里写的值，不是能执行的配置。原因：',
      projectConfigSectionUnknown:
        '插件默认值层里没有这一节，所以宿主的取值规则（缺字段时回退到内建默认值）本页读不到；这一节的实际生效值显示为未知，而不是猜一个。涉及：',
      projectLayerProject: '本工程覆盖',
      projectLayerInherited: '继承自默认值',
      projectLayerUnknown: '未知',
      projectLayerFailClosed: '已拒绝→fail-closed',
      projectValueUnknown: '未知（默认值层读不到，本页不猜）',
      projectValueShadow: '默认值：',
      projectValueAsked: '文件要求：',
      projectValueShadowUnknown: '默认值：未读到',
    }
    const en = {
      loading: 'Loading configuration…',
      unavailable: 'This deployment serves no settings service. Use the workflow_set tool instead.',
      namespaceMissing: name =>
        `The settings service is up, but it does not serve the "${name}" entry yet, so it cannot be edited here. It should appear after restarting DSH; until then use the workflow_set tool.`,
      notWritable: 'Not writable right now.',
      description: 'Tiers and switches, state on disk, independent review, approval strength.',
      tier: 'Default tier',
      tierHint: 'minimal / standard / strict, chosen by the cost of being wrong.',
      recipe: 'Recipe (overrides the tier)',
      approvalStrength: 'Approval strength',
      approvalHint: 'ask-user asks each time; llm-then-user lets the model judge and hands rejections to you; llm-only lets the model decide; off intercepts nothing.',
      approvalWarning: 'Official warning (applies when llm-only or off is selected)',
      approvalBroken:
        'The approval section is not an object, so the host refuses it and the gate falls back to its strictest defaults (ask-user / low / denyHighAlways). Change any control below to write a legal section.',
      approvalWarningEn: [
        'Auto review is experimental: it can allow unsafe actions, deny useful work, and spend additional tokens.',
        'Auto provides no file sandbox. The outer `run_code` transport and direct Node effects inside a PTC program do not pass through inner-tool review.',
        'Model classification can be wrong. There are no deterministic tool exemptions, persistent grants, configurable policy, or retry layer.',
      ],
      approvalWarningZh: [
        'Auto review 是实验性的：它可能放行不安全的操作、拒绝有用的工作，并额外消耗 token。',
        '它不提供文件沙箱——run_code 内部的直接 Node 操作不经过内层工具审查。',
        '模型的分类可能出错；没有确定性豁免、没有持久授权、没有可配置策略、也没有重试层。',
      ],
      riskThreshold: 'Risk threshold',
      evaluatorBar: 'Review pass mark',
      evaluatorBarHint: 'The independent reviewer must score at least this before work is delivered.',
      independentReview: 'Independent review',
      independentReviewHint: 'A fresh child agent scores the work, so the worker cannot declare itself done.',
      exemptTools: 'Approval exemptions (approval.exemptTools)',
      exemptToolsHint: 'Comma-separated tool names; empty means no deterministic exemption.',
      dimensions: 'Review dimensions (evaluator.dimensions)',
      dimensionsHint:
        'Comma-separated. At least one dimension is required — an empty list makes every review ungradeable, the host refuses it, and this page never writes it.',
      mustPass: 'Veto dimensions (evaluator.mustPass)',
      mustPassHint:
        'Checked dimensions must pass; none checked means average-only grading (allowed by the host). Only dimensions listed above in `dimensions` can be checked: a dimension that is not scored cannot be vetoed.',
      mustPassUnavailable:
        '`dimensions` is not a usable list of strings right now, so no veto dimension can be offered. Fix the row above first.',
      maxDepth: 'Delegation depth cap (subagent.maxDepth)',
      maxDepthHint:
        '1 stops a child from delegating at all, forcing every review into the main conversation; 2 lets a delegated orchestrator start its reviewer. The cap is 2; 3 is not offered.',
      maxActiveSubagents: 'Concurrent subagents (subagent.maxActiveSubagents)',
      maxActiveSubagentsHint: 'An integer of 1 or more.',
      retireEnabled: 'Constraint retirement check (retireCheck.enabled)',
      retireEveryDays: 'Retirement check interval (retireCheck.everyDays)',
      retireEveryDaysHint: 'A whole number of days, 1 or more.',
      retireAutoSuggest: 'Suggest retirements automatically (retireCheck.autoSuggest)',
      contextIsolation: 'Context isolation',
      contextIsolationHint: 'Each work unit gets a fresh child agent with a whitelisted context.',
      modulesList: 'Module switches (modules.*)',
      modulesListHint:
        'Each switch is its own atomic write; the list comes from the live configuration, so a module added there appears here.',
      modulesSummary: 'Modules enabled',
      advanced: 'The remaining parameters (context / acceptance / guards / escalation / budget / signoff / evaluator.maxRounds / verifier.sensors, …) live in workflow_set or the project .dsh/workflow.yml; this page keeps the common options, every module switch, and the main nested sections.',
      saved: 'Saved',
      saveFailed: 'Not saved (the host did not accept the value)',
      panelLabel: 'Workflow settings',
      showInSidebar: 'Show "Workflow settings" in the sidebar',
      showInSidebarHint: 'Turning this off needs a page refresh before the sidebar entry disappears. To turn it back on, open 设置 → 插件 → the dsh-workflow-panel row. The tools keep working either way.',
      projectNote: 'This page edits the DEFAULTS for new projects. To affect one project, run workflow_init there and override with workflow_set.',
      // ---- the conversation-page tab (PROJECT scope) --------------------------
      viewProject: 'Workflow (this project)',
      projectTitle: 'This project\u2019s workflow settings',
      projectScope: 'Scope: this project',
      // Human labels for the tab's dotted config paths. Any path with no entry falls
      // back to its dotted form, so a host-side key still appears instead of vanishing.
      projectSections: {
        tier: 'Tier', recipe: 'Recipe', modules: 'Module switches', approval: 'Approval',
        evaluator: 'Independent review', subagent: 'Subagents', retireCheck: 'Constraint retirement',
        context: 'Context', acceptance: 'Acceptance negotiation', guards: 'Guards',
        escalation: 'Escalation', budget: 'Budget', signoff: 'Sign-off', verifier: 'Verifier',
      },
      projectLeaves: {
        tier: 'Tier', recipe: 'Recipe',
        'approval.strength': 'Approval strength',
        'approval.riskThreshold': 'Risk threshold',
        'approval.denyHighAlways': 'Always deny high risk',
        'approval.exemptTools': 'Approval-exempt tools',
        'evaluator.bar': 'Review bar',
        'evaluator.dimensions': 'Review dimensions',
        'evaluator.mustPass': 'Veto dimensions',
        'evaluator.independent': 'Independent review',
        'evaluator.maxRounds': 'Max review rounds',
        'subagent.maxDepth': 'Subagent depth cap',
        'subagent.maxActiveSubagents': 'Concurrent subagent cap',
        'retireCheck.enabled': 'Constraint retirement check',
        'retireCheck.everyDays': 'Retirement check interval (days)',
        'retireCheck.autoSuggest': 'Suggest retirements automatically',
        'context.isolation': 'Context isolation',
        'context.exclude': 'Excluded content',
        'context.overflow': 'Overflow handling',
        'context.requireBootstrap': 'Require the bootstrap checklist',
        'acceptance.negotiateBeforeBuild': 'Negotiate acceptance before building',
        'acceptance.maxRounds': 'Max negotiation rounds',
        'verification.policy': 'Verification-depth policy',
        'verification.confirmation': 'Verification confirmation',
        'modules.planner': 'Planner',
        'modules.featuresJson': 'Features file',
        'modules.progressLog': 'Progress log',
        'modules.handoffDoc': 'Handoff doc',
        'modules.acceptance': 'Acceptance negotiation',
        'modules.independentReview': 'Independent review',
        'modules.selfVerify': 'Self-verify',
        'modules.gcCode': 'Code GC',
        'modules.gcDocs': 'Docs GC',
        'modules.constraintLedger': 'Constraint ledger',
        'modules.stats': 'Stats',
        'modules.gitCommitPerFeature': 'Commit per feature',
        'modules.isolation': 'Context isolation',
      },
      projectLoading: 'Reading this project\u2019s .dsh/workflow.yml…',
      projectNotOptedIn:
        'This project has no .dsh/workflow.yml, so the workflow is not enabled. To enable it, run workflow_init in the project (or have the model call the workflow_init tool).',
      projectNoReader:
        'This deployment did not hand the read-only workspaceFiles interface to the browser, so the file\u2019s contents cannot be shown here. The path and the "how to change it" section below are still accurate; use the workflow_status tool to read the contents.',
      projectReadFailed: 'Reading this project\u2019s .dsh/workflow.yml failed: ',
      projectBytes: 'bytes',
      projectVersion: 'version',
      projectTruncated: 'Only the first lines are shown (the file is longer). Use workflow_status or open the file for the rest.',
      projectSource: 'The content above comes straight from',
      projectNoFallback:
        'Note: this tab is read-only. Every row is labelled by layer: "overridden here" comes from this project\u2019s .dsh/workflow.yml, and "inherited" comes from the plugin DEFAULTS \u2014 the layer the sidebar panel and the 设置 → 插件 page edit, which affects every project. This page shows both layers and writes to neither.',
      projectWriteHeading: 'How to change it',
      projectWriteBody:
        'The browser half can only READ this file: the workspaceFiles interface exposes no mutation operation by design. Every write goes through the workflow_set tool (path-addressed, validated before it touches the file):',
      projectNoWriteHeading: 'Why there is no editor here',
      projectNoWriteBody:
        'Because no real path to writing this file was found — not because an editor was skipped. Checked one by one: workspaceFiles is read-only; the workspace namespace creates, renames, removes and reorders Workspaces but touches no file inside one; the settings namespace does have write methods, but they address a PROFILE ENTRY ID and persist through the active profile\u2019s plugin patch \u2014 the plugin-defaults layer this tab exists to distinguish itself from, not this project\u2019s .dsh/workflow.yml. The only writers for a project file today are the workflow_init and workflow_set tools.',
      projectNoWriteFooter:
        'So there are no controls here: better to offer none than to pass off a plugin-defaults editor as this project\u2019s settings, or to hand-write a Remote descriptor that does not exist. When an official path that writes this project\u2019s file appears, an editor belongs on this page.',
      projectWriteExample: 'workflow_set path=tier value=standard',
      projectWriteInitExample: 'workflow_init',
      projectReadExample: 'workflow_status',
      projectFileHeading: 'File',
      projectPathHeading: 'Path (the absolute path the Host resolved)',
      projectPathPending: '(shown once the file has been read)',
      projectKeys: 'Keys this file sets explicitly',
      projectKeysNone: '(empty or unparseable — the raw text above is the only authority)',
      projectOnlySet:
        'Only the keys this file writes are listed. Every other parameter comes from the defaults or the plugin defaults, and this file does not override it — showing those here would paint an INHERITED value as if this project had chosen it.',
      projectRefresh: 'Read again',
      projectFileEmpty: '(empty file)',
      projectUnavailableTitle: 'This project\u2019s file could not be read',
      // ---- the EFFECTIVE configuration (what the tab now leads with) -------------
      projectConfigHeading: 'This project\u2019s EFFECTIVE configuration',
      projectConfigIntro:
        'Every line below is a value that is in force for this project right now. The host layers this project\u2019s own .dsh/workflow.yml OVER the plugin defaults \u2014 the layer the 设置 → 插件 page and the sidebar panel edit, which applies to every project.',
      projectConfigLegend:
        '"Overridden here" = this project\u2019s file sets it; "inherited" = the file does not mention it, so the plugin default applies; "unknown" = the defaults layer could not be read, and this page does not guess.',
      projectConfigSummary: (project, inherited, unknown) =>
        `${project} overridden here · ${inherited} inherited from the defaults · ${unknown} unknown`,
      projectConfigRefusedCount: refused => ` · ${refused} refused by the host (fail-closed)`,
      projectDefaultsLoading:
        'Reading the plugin-defaults layer (the settings document)… until it arrives, only the values this project sets are shown.',
      projectDefaultsUnavailable:
        'This deployment serves no settings document for dsh-workflow-core, so the plugin-defaults layer cannot be read. Only the values this project\u2019s own file sets are shown; every inherited value is reported as unknown rather than guessed.',
      projectDefaultsUnknownNote:
        'The defaults layer is unreadable right now, so the value each override replaced cannot be shown.',
      projectParseProblems:
        'This file could not be fully understood; the host\u2019s own reader reported these lines:',
      projectApprovalRefused:
        'The host REFUSED this project\u2019s approval section, so the fail-closed defaults are in force: every gated call asks you, the threshold is low, high-risk calls are always denied, and nothing is exempt. "The file asks for" is the value that was refused. Reasons:',
      projectEvaluatorRefused:
        'The host WILL REFUSE this project\u2019s evaluator section, so no independent review can run here (workflow_review fails outright). The values below are what the file says, not a configuration that can execute. Reasons:',
      projectConfigSectionUnknown:
        'The plugin-defaults layer does not carry this section, so the host\u2019s rule for it (a field with no value falls back to a BUILT-IN default) cannot be read here. The values actually in force are reported as unknown rather than guessed. Section:',
      projectLayerProject: 'overridden here',
      projectLayerInherited: 'inherited',
      projectLayerUnknown: 'unknown',
      projectLayerFailClosed: 'refused → fail-closed',
      projectValueUnknown: 'unknown (the defaults layer is unreadable; this page does not guess)',
      projectValueShadow: 'default: ',
      projectValueAsked: 'the file asks for: ',
      projectValueShadowUnknown: 'default: not read',
    }

    /**
     * The browser services this bundle REQUIRES, with WHY each one is here.
     *
     * `remote.workspaceFiles` is the project-scope read path and the reason the array is
     * not just the three settings services any more. It is the SHIPPED Remote namespace
     * (`@deepseek-ai/dsh-api-workspace-files`), already mounted by the application's Remote
     * assembly, so naming it here reaches a service that exists rather than declaring a
     * new one. The official consumer of the same namespace does exactly this —
     * `@deepseek-ai/dsh-api-workspace-files/lib/client.js`:
     *
     *     const inject = ['resources', 'remote', 'remote.workspaceFiles']
     *
     * WHY NOT `remote` ALONE: Cordis refuses `ctx.get('remote.workspaceFiles')` on a
     * context that never declared it ("cannot get property … without inject"). That is the
     * identical failure `lib/index.js` records for `subagents` — a service existing is not
     * the same as this context being allowed to reach it.
     *
     * WHAT IT COSTS: a deployment that does not compose the workspace-files namespace
     * loses this whole bundle, not just the tab. That is the trade the plugin already
     * makes for `configForms`, the tab's reader is useless without it, and the failure
     * direction is a missing page rather than a page that lies about which file it read.
     * `projectNoReader` covers the other, softer shape: the service is reachable but the
     * call fails, and the tab says so instead of falling back to the defaults.
     */
    const inject = ['slots', 'locale', 'configForms', 'remote.workspaceFiles']

    const TIER_OPTIONS = [
      ['minimal', 'minimal — 轻量，适合一次性小改动'],
      ['standard', 'standard — 标准，日常开发'],
      ['strict', 'strict — 严格，错误代价高'],
    ]
    const RECIPE_OPTIONS = [
      ['', '（不使用配方）'],
      ['hotfix', 'hotfix — 修小 bug，跳过规划与文档'],
      ['spike', 'spike — 探索性代码，不合并'],
      ['refactor', 'refactor — 只跑结构性检查'],
      ['docs', 'docs — 只做文档一致性与回收'],
      ['review', 'review — 只读评审'],
    ]
    const STRENGTH_OPTIONS = [
      ['ask-user', 'ask-user — 全部由你确认'],
      ['llm-then-user', 'llm-then-user — 模型先判，被拒交你'],
      ['llm-only', 'llm-only — 模型全权决定（实验性）'],
      ['off', 'off — 不拦截（危险）'],
    ]
    const RISK_OPTIONS = [
      ['low', 'low — 宽松'],
      ['medium', 'medium — 中等'],
      ['high', 'high — 严格'],
    ]
    /**
     * The delegation ceiling this page offers, and ONLY offers.
     *
     * MIRROR of `MAX_SUBAGENT_DEPTH` in `lib/config.js`, which `validateSettingValue`
     * also enforces for `subagent.maxDepth`. A browser bundle cannot import a host
     * module, so the bound is repeated here — and the control is a `<select>` over
     * exactly these options, so 3 is not merely refused but unreachable.
     */
    const MAX_DEPTH = 2
    const DEPTH_OPTIONS = [
      ['1', '1 — 子代理不能再委派'],
      ['2', '2 — 允许委派出去的主控再开一个评审员'],
    ]

    const rowStyleDefault = {
      display: 'grid',
      gridTemplateColumns: '200px 1fr',
      // Wider than the sidebar panel's old 8px: the complaint this fixes is a form whose
      // rows sit shoulder-to-shoulder and therefore read as one wall of controls.
      gap: '14px 20px',
      alignItems: 'center',
      padding: '10px 0',
    }
    /**
     * The sidebar panel's field-row geometry: ONE column, and wider rows than the page's.
     *
     * `gridTemplateColumns: '100%'` RATHER THAN `minmax(0, 1fr)`, and the difference is the
     * whole defect this constant exists to close. With `minmax(0, 1fr)` the grid has no
     * definite width of its own, so the `fr` track is resolved by intrinsic sizing — and a
     * `fr` track's flex base size is the ZERO of its minimum, so a second track (see
     * {@link panelFieldHintStyle}) took the entire width and left the label column at 0px.
     * Measured in Chromium, at 300px: `grid-template-columns: minmax(0, 1fr)` plus a
     * `grid-column: 2` hint resolves to `0px 244px`, and the label wraps one character per
     * line. `100%` is a definite size, so the one track always measures the row's width.
     * `tooling/measure-grid-layout.mjs` reproduces both outcomes on demand.
     *
     * `gap` keeps the horizontal half even though one column means nothing sits beside
     * anything: the shorthand is set from both numbers in one place, and a two-column panel
     * later should not have to reinvent the value. `padding` keeps the shipped
     * `PANEL_ROW_PADDING` and stays wider than the page's rows, which is the half the user
     * asked for and `test/status.test.mjs` pins.
     */
    const panelRowStyle = {
      ...rowStyleDefault,
      gridTemplateColumns: '100%',
      gap: `${PANEL_ROW_GAP} ${PANEL_COLUMN_GAP}`,
      padding: PANEL_ROW_PADDING,
    }
    const labelStyle = { color: 'var(--dsw-alias-label-secondary, #666)', fontSize: '13px' }
    const hintStyle = {
      color: 'var(--dsw-alias-label-tertiary, #999)',
      fontSize: '12px',
      gridColumn: '2',
      marginTop: '-4px',
    }
    /**
     * The same hint look in the panel's single column.
     *
     * THE `gridColumn` IS THE POINT. `hintStyle` places the hint in column two, which is
     * correct on the settings page (whose rows really are `200px 1fr`) and is exactly what
     * broke the panel: an explicitly placed item CREATES the track it names, so a hint at
     * column 2 turned a declared single-column grid into `0px XXpx` and squeezed the label
     * to nothing. `1 / -1` names the last line of the template that actually exists, so it
     * spans the row's one column and creates no track.
     *
     * `marginTop: 0` because the divider below already carries the spacing; the page's -4px
     * pulled the hint up under a control that sat BESIDE its label, which is not this shape.
     */
    const panelFieldHintStyle = { ...hintStyle, gridColumn: '1 / -1', marginTop: 0 }

    const selectStyle = { fontSize: '13px', padding: '4px 6px', maxWidth: '340px' }
    const numberStyle = { ...selectStyle, maxWidth: '110px' }
    const textStyle = { ...selectStyle, maxWidth: '460px' }
    const noteStyle = { fontSize: '12px', opacity: 0.65, marginTop: '12px', lineHeight: 1.6 }
    const warningStyle = {
      gridColumn: '2',
      fontSize: '12px',
      lineHeight: 1.6,
      margin: '4px 0 8px',
      padding: '8px 10px',
      borderLeft: '3px solid var(--dsw-alias-border-warning, #d9a03a)',
      background: 'var(--dsw-alias-bg-secondary, rgba(217,160,58,0.08))',
      color: 'var(--dsw-alias-label-secondary, #666)',
    }
    /**
     * The same warning banner in the panel's single column.
     *
     * The identical cause as {@link panelFieldHintStyle}: `warningStyle` claims column two,
     * and an explicitly placed item creates that track — so an approval warning rendered in
     * the panel would squeeze the label to zero exactly as the hints did. Measured in
     * Chromium, a row of `{select, warning}` under `grid-template-columns: 100%` with the
     * warning at `grid-column: 2` resolves to `188px 76px` against a 264px row, which
     * overflows the row and pushes the label off its own geometry.
     */
    const panelWarningStyle = { ...warningStyle, gridColumn: '1 / -1' }

    /**
     * Which style a grid child uses, given the template it is being placed into.
     *
     * `hintStyle` / `warningStyle` hardcode `gridColumn: '2'` because the settings page's
     * rows are `200px 1fr` and column two is the control column there. The panel declares ONE
     * column, where "column two" is a track that does not exist — naming it creates one, and
     * that implicit track is what left the panel's label with none of the width. So the two
     * panelled styles span `1 / -1` instead. The selection is by the row template itself
     * (`panelRowStyle.gridTemplateColumns`), so it cannot drift from the grid it is used in,
     * and the settings page — whose template is the other one — is untouched.
     *
     * @param rowStyle - the grid style the children are being placed into.
     * @param panelled - the style to use in the panel's single column.
     * @param paged - the style to use in the page's two columns.
     * @returns the style for this row.
     */
    function columnStyle(rowStyle, panelled, paged) {
      return rowStyle?.gridTemplateColumns === panelRowStyle.gridTemplateColumns ? panelled : paged
    }

    const statusStyle = { fontSize: '12px', minHeight: '16px', marginTop: '8px' }
    const summaryStyle = { fontSize: '13px', lineHeight: 1.6, margin: 0 }

    // -------------------------------------------------------------------------
    // PROJECT-SCOPE GEOMETRY — the conversation page's content column
    // -------------------------------------------------------------------------
    //
    // The `轨迹` page is a CONTENT COLUMN with left and right margins, not a
    // full-bleed pane, and this tab has to occupy the same kind of space. Both
    // numbers are functions of the pane width, for one reason: a FIXED margin
    // reads as cramped on a wide window and eats a narrow one, while a fixed
    // max-width alone leaves a short window with no gutter at all.

    /**
     * The usable width of the conversation pane, clamped to a non-negative number.
     *
     * A non-number (a Host that reports no width, a layout mid-resize passing `null`)
     * is not an error and must not become `NaN` in a style object: `NaN` silently
     * drops the whole declaration and the column would fall back to full bleed, which
     * is precisely the look this is here to avoid.
     *
     * @param paneWidth - whatever the layout reported.
     * @returns a finite width >= 0.
     */
    function paneWidthOf(paneWidth) {
      return typeof paneWidth === 'number' && Number.isFinite(paneWidth) && paneWidth > 0 ? paneWidth : 0
    }

    /**
     * The horizontal margin of the conversation content column.
     *
     * A FRACTION of the pane, floored at a usable gutter, and NOT a centring offset: the
     * column sits in the left part of the pane with the slack on its right, the way the
     * message column beside it does. A pane too narrow to give both sides their fraction
     * keeps the minimum gutter on ONE side (never a negative margin), because the
     * alternative — squeezing the column to zero — would hide the content.
     *
     * @param paneWidth - the pane's width in CSS pixels.
     * @returns the margin in CSS pixels, >= 0.
     */
    function pageMargin(paneWidth) {
      const width = paneWidthOf(paneWidth)
      return Math.max(TAB_MARGIN_MIN_PX, Math.round(width * TAB_MARGIN_RATIO))
    }

    /**
     * The style of the conversation tab's outermost column.
     *
     * TWO constraints, and both are needed:
     *
     *  - the MARGINS are a fraction of the pane (see {@link pageMargin}), so the column
     *    keeps the conversation page's inset look at any window size;
     *  - `maxWidth` caps the BOX — margins plus a readable content width — so a very wide
     *    pane does not push the text off to the right of a monitor nobody can read across.
     *    The cap scales with the margins, which is what keeps the CONTENT at
     *    {@link TAB_MAX_WIDTH_PX} rather than at whatever the window happens to allow.
     *
     * `marginRight: 'auto'` is what keeps the column LEFT-ALIGNED rather than centred: the
     * slack left over by the cap stays on the right. The result is always a concrete
     * object so the renderer never diffs an absent style.
     *
     * @param paneWidth - the pane's width in CSS pixels.
     * @returns a React style object.
     */
    function conversationContentStyle(paneWidth) {
      const margin = pageMargin(paneWidth)
      return {
        boxSizing: 'border-box',
        padding: `${TAB_GUTTER_PX}px ${margin}px 56px`,
        maxWidth: `${margin * 2 + TAB_MAX_WIDTH_PX}px`,
        marginRight: 'auto',
      }
    }

    // -------------------------------------------------------------------------
    // PROJECT-SCOPE PURE LOGIC
    // -------------------------------------------------------------------------

    /**
     * The first line of a raw file whose line endings may be CRLF.
     *
     * Plain `indexOf('\n')` would return a string still carrying the `\r`, and a caller
     * that embedded that line in a message would print a stray carriage return — the
     * kind of thing that shows up as a mangled line in a Windows build and nowhere else.
     *
     * @param text - the page's text.
     * @returns the line without its terminator.
     */
    function firstLine(text) {
      if (typeof text !== 'string' || text === '') return ''
      const end = text.indexOf('\n')
      const line = end === -1 ? text : text.slice(0, end)
      return line.endsWith('\r') ? line.slice(0, -1) : line
    }

    /**
     * The top-level YAML keys a project file DECLARES.
     *
     * The project file is a delta: `serializeWorkflowYaml` writes "only values that
     * differ from the defaults", so a key that is ABSENT is inherited, not unset. That
     * distinction is the whole reason this function exists — listing the effective
     * configuration here would paint an inherited default as this project's own choice,
     * which is the same class of mistake as painting the plugin defaults under a
     * "this project" heading.
     *
     * The reader is deliberately the narrow one the project file is written in
     * (`workflow-file.js`'s own subset): a top-level `key:` at column zero, optionally
     * followed by an inline value. Nested keys are indented and therefore skipped, and
     * a `#` comment line is not a key. It is NOT a YAML parser and does not pretend to
     * be — the raw text above it in the UI is the authority, and this list is labelled
     * as what the file declares.
     *
     * THE INDENT RULE IS ENFORCED TWICE, and that is deliberate rather than redundant.
     * The one rule that decides whether `approval.strength` is reported as a project-level
     * key is "the key starts at column zero", and BOTH the `/^\s/` guard here and the `^`
     * anchor of the key pattern below carry it. Either alone would do; together, the rule
     * survives an edit to the other — and a regex is exactly the kind of line someone
     * rewrites while chasing an unrelated bug.
     *
     * The consequence for verification is worth stating plainly: because the two carry
     * the same rule, DISABLING either one changes no output, so no behavioural test can
     * tell them apart. The indented-key cases in `test/status.test.mjs` are the
     * behavioural statement of the contract; `mutation-check-project-tab.mjs` records the
     * redundancy as a declared equivalent rather than pretending it was killed.
     *
     * A CR is stripped from each line first: `\s` also matches `\r`, and a rule whose
     * meaning depends on which of two whitespace characters happened to be present is
     * not a rule.
     *
     * @param text - the file's raw text.
     * @returns the declared top-level key names, in file order, deduplicated.
     */
    function projectFileKeys(text) {
      if (typeof text !== 'string' || text === '') return []
      const keys = []
      for (const rawLine of text.split('\n')) {
        const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
        if (line === '') continue
        if (/^\s/.test(line)) continue
        if (line.startsWith('#')) continue
        const match = /^([A-Za-z_][A-Za-z0-9_-]*)\s*:/.exec(line)
        if (match === null) continue
        if (!keys.includes(match[1])) keys.push(match[1])
      }
      return keys
    }

    /**
     * Decide what one `workspaceFiles.read` answer means for the project tab.
     *
     * THE REMOTE RESULT IS NOT A THROWN ERROR. The gateway returns
     * `{ ok: true, value }` or `{ ok: false, error }` (`dsh-api-gateway`'s
     * `invoke`), so "the file is missing" arrives as a failure BRANCH, not as an
     * exception. Treating a failure as success — or catching an exception that never
     * comes — is how a tab ends up rendering an empty `<pre>` that looks like an empty
     * project file. The two shapes are therefore distinguished here, and a non-object
     * answer is reported as a failure rather than trusted.
     *
     * `absent` is carried separately from the message because ABSENCE is the one failure
     * with a specific remedy (`workflow_init`), and text matching on a diagnostic string
     * is not a classification. It is set ONLY from the namespace's own stable code —
     * `workspace-file/not-found`, the discriminator @deepseek-ai/dsh-typert-protocol
     * documents for this exact service ("Discrimination is always by `code`, never by
     * instanceof") — with an ENOENT message as a secondary signal for a local carrier
     * that answers outside the namespace's vocabulary.
     *
     * @param result - the Remote answer, of unknown shape.
     * @returns `{ state, path, text, lines, eof, bytes, version, code, absent, error }`
     *   where `state` is `'ok'` or `'failed'`.
     */
    function projectFileResult(result) {
      const failed = {
        state: 'failed',
        path: null,
        text: '',
        lines: 0,
        eof: true,
        bytes: undefined,
        version: undefined,
        code: undefined,
        absent: false,
        error: '',
      }
      if (result === null || typeof result !== 'object') {
        return { ...failed, error: 'the read returned something that is not a Remote result' }
      }
      if (result.ok !== true) {
        const error = result.error
        const code = error !== null && typeof error === 'object' ? error.code : undefined
        const message = error !== null && typeof error === 'object' ? error.message : undefined
        return {
          ...failed,
          code: typeof code === 'string' ? code : undefined,
          absent: error !== null && typeof error === 'object' && error.absent === true,
          error: typeof message === 'string' && message !== '' ? message : 'the read was refused',
        }
      }
      const value = result.value
      if (value === null || typeof value !== 'object') {
        return { ...failed, error: 'the read succeeded but carried no file' }
      }
      return {
        state: 'ok',
        path: typeof value.absolutePath === 'string' && value.absolutePath !== '' ? value.absolutePath : null,
        text: typeof value.text === 'string' ? value.text : '',
        lines: typeof value.lines === 'number' ? value.lines : 0,
        eof: value.eof === true,
        bytes: typeof value.bytes === 'number' ? value.bytes : undefined,
        version: typeof value.version === 'string' ? value.version : undefined,
        code: undefined,
        absent: false,
        error: '',
      }
    }

    /**
     * The one line a tab shows for a read that did not produce a file.
     *
     * THREE cases, deliberately distinct, because they have three different remedies and
     * the wrong one sends the user to a screen that cannot help:
     *
     *  - NO READER — this deployment's Remote assembly does not serve the namespace, so
     *    the tab can never read anything. The remedy is the reader it does have:
     *    `workflow_status` / `workflow_set`.
     *  - MISSING FILE — the Session's workspace resolved but `.dsh/workflow.yml` is not
     *    there, which is EXACTLY what "this project has not opted in" means
     *    (`probeProject`'s rule). The remedy is `workflow_init`. This is decided from the
     *    namespace's stable `code` (see {@link projectFileResult}), NEVER by matching
     *    words in a diagnostic message.
     *  - ANYTHING ELSE — a refusal or a transport fault, reported verbatim so a missing
     *    permission is not presented as an absent file.
     *
     * @param outcome - the failure from {@link projectFileResult}, or anything else.
     * @param hasReader - whether a reader was reachable at all.
     * @param t - the translator.
     * @returns the message to render.
     */
    function projectFailureText(outcome, hasReader, t) {
      if (!hasReader) return t('projectNoReader')
      if (projectFileAbsent(outcome)) return t('projectNotOptedIn')
      const failure = outcome !== null && typeof outcome === 'object' ? outcome : {}
      const message = typeof failure.error === 'string' ? failure.error : ''
      return `${t('projectReadFailed')}${message === '' ? '—' : message}`
    }

    /**
     * Whether a FAILED read means "this project has not opted in".
     *
     * ONE DEFINITION, TWO CALLERS, which is the whole reason this is a function: the failure
     * line needs the answer to name a remedy, and the effective-configuration view needs it to
     * decide whether it may render ANYTHING (an absent file means "not opted in", and a table
     * of inherited defaults under that heading would read as though the project had set them).
     * Deciding it twice is how one surface calls an absent file "unreadable" while the other
     * calls an unreadable one "absent" — two remedies for one condition.
     *
     * The answer comes from the namespace's own stable CODE — `workspace-file/not-found`,
     * the discriminator @deepseek-ai/dsh-typert-protocol documents for this service
     * ("Discrimination is always by `code`, never by instanceof") — with an ENOENT message as
     * a secondary signal for a local carrier that answers outside that vocabulary. It is
     * word-boundary matched, so a path containing the letters cannot trigger it.
     *
     * @param outcome - a failure from {@link projectFileResult}, or anything else.
     * @returns true when the honest reading is "the file is not there".
     */
    function projectFileAbsent(outcome) {
      const failure = outcome !== null && typeof outcome === 'object' ? outcome : {}
      if (failure.absent === true) return true
      const absentCodes = [
        'workspace-file/not-found',
        'workspace-file/absent',
        'fs/not-found',
        'fs/enoent',
      ]
      if (typeof failure.code === 'string' && absentCodes.includes(failure.code)) return true
      const message = typeof failure.error === 'string' ? failure.error : ''
      return /\bENOENT\b/.test(message)
    }

    // -------------------------------------------------------------------------
    // THE EFFECTIVE CONFIGURATION — a browser-side MIRROR of host resolution
    // -------------------------------------------------------------------------
    //
    // WHY THIS EXISTS. The tab used to print the file's raw text plus the keys it declares,
    // which answers "where is the file" and not "what is in force". The user's complaint is
    // exactly that: reading YAML is a chore and finding the file is worse. The EFFECTIVE value
    // of every parameter needs two layers, and the browser can reach BOTH:
    //
    //   .dsh/workflow.yml                → the project's own overrides (remote.workspaceFiles)
    //   the `dsh-workflow-core` namespace → the plugin DEFAULTS (the configForms snapshot the
    //                                        settings page already reads)
    //
    // WHAT IS MIRRORED, AND WHERE THE RULE ACTUALLY LIVES (read these before editing anything
    // below — the whole block is a copy of rules that live somewhere else):
    //
    //   parseProjectYaml          lib/project.js         parseWorkflowYaml (and its private
    //                                                    stripComment / parseScalar / frames)
    //   projectEffectiveConfig    lib/workflow-file.js   resolveEffectiveConfig
    //                             lib/config.js          mergeConfigLayers / mergeInto / cloneValue
    //   projectLeafSource         (the same merge read backwards: which layer WON one leaf)
    //   projectApprovalGate       lib/approval-state.js  readApprovalForProject
    //                             lib/approval.js        readApprovalGate / FAIL_CLOSED_APPROVAL
    //   projectEvaluatorProblems  lib/gate.js            readEvaluatorGate / checkBar /
    //                                                    checkMaxRounds / readStringList
    //
    // A MIRROR DRIFTS, so each of those is pinned by a DIFFERENTIAL test in
    // `test/status.test.mjs`: the host function and the copy below are run over the SAME inputs
    // and their answers are compared. A change to the host rule therefore fails there instead of
    // silently mis-reporting what the plugin is running.
    //
    // WHERE AN ANSWER CANNOT BE DERIVED the value is reported as UNKNOWN, never guessed: the
    // defaults namespace may not be served, or may answer before its document is loaded, and a
    // confidently wrong "effective value" is worse than "unknown" because the user acts on it.
    // The same rule applies to the whole project file: absent or unreadable means "no table".

    /**
     * The approval strengths, VALUES ONLY — MIRROR of `APPROVAL_STRENGTHS` in
     * `lib/approval.js` (re-exported by `lib/config.js`).
     *
     * The settings panel's `STRENGTH_OPTIONS` carries the same four values with labels, and
     * `RISK_OPTIONS` the three risk levels; `test/status.test.mjs` pins ALL THREE lists against
     * the host's own exports, so the vocabulary cannot drift apart in one place only.
     */
    const APPROVAL_STRENGTH_VALUES = ['ask-user', 'llm-then-user', 'llm-only', 'off']

    /** MIRROR of `RISK_LEVELS` in `lib/approval.js`. See {@link APPROVAL_STRENGTH_VALUES}. */
    const RISK_LEVEL_VALUES = ['low', 'medium', 'high']

    /**
     * The pass mark's legal range — MIRROR of `BAR_MIN` / `BAR_MAX` in `lib/gate.js`, which
     * `checkBar` enforces. `test/status.test.mjs` pins both numbers against the host's exports.
     */
    const BAR_MIN = 0
    const BAR_MAX = 10

    /**
     * The gate values in force when an `approval` section cannot be used — MIRROR of
     * `FAIL_CLOSED_APPROVAL` in `lib/approval.js`.
     *
     * WHY THEY ARE SHOWN AT ALL. `readApprovalGate` returns these four values instead of what
     * the user wrote whenever the section is unusable, and `readApprovalForProject` uses them
     * for the whole gate when the project file could not be fully read. A page that printed
     * `strength: off` beside a gate that is in fact asking on every call is the "a report
     * describing a gate that does not exist" failure `lib/approval.js` documents: the value in
     * force is the honest one, and the file's value is shown next to it as what was asked for.
     *
     * `test/status.test.mjs` compares this object field by field (and by type, including the
     * frozen empty `exemptTools`) against the host's own export, so a change there fails here.
     */
    const FAIL_CLOSED_APPROVAL = Object.freeze({
      strength: 'ask-user',
      riskThreshold: 'low',
      denyHighAlways: true,
      exemptTools: Object.freeze([]),
    })

    /**
     * A plain object — the only shape the merge treats as a SECTION.
     *
     * MIRROR of `isPlainObject` in `lib/config.js` (re-exported by `lib/workflow-file.js`):
     * `null` is not an object, and an ARRAY is not a section. The distinction is load-bearing
     * in both directions — an array assigned over a section REPLACES it (`mustPass: []` is how
     * a project says "no veto dimensions"), and `approval: [1,2]` is a malformation the gate
     * refuses rather than a section it reads.
     */
    function isConfigObject(value) {
      return value !== null && typeof value === 'object' && !Array.isArray(value)
    }

    /**
     * Deep-copy a configuration value.
     *
     * MIRROR of `cloneValue` in `lib/config.js`, which uses `structuredClone` because it runs
     * on the host. This copy is written by hand for two reasons: the snapshot it copies from is
     * FROZEN (the settings store freezes every snapshot it publishes), so a merge that wrote
     * through would throw; and `structuredClone` is not something a browser bundle should
     * assume. Config values are JSON-shaped by construction — they come out of the settings
     * document and the file's own scalar reader — which is all this needs to handle.
     *
     * @param value - any configuration value.
     * @returns a value that can be mutated without touching the source.
     */
    function cloneConfigValue(value) {
      if (Array.isArray(value)) return value.map(cloneConfigValue)
      if (isConfigObject(value)) {
        const copy = {}
        for (const [key, item] of Object.entries(value)) copy[key] = cloneConfigValue(item)
        return copy
      }
      return value
    }

    /**
     * Merge one layer over another, key by key — MIRROR of `mergeInto` in `lib/config.js`.
     *
     * A spread is NOT the same rule: `{ ...base, ...override }` drops every sibling key of a
     * nested section the override touches, so a project setting `modules.planner` would
     * silently discard the row's `modules.isolation`. The host merges nested plain objects and
     * REPLACES everything else (arrays and scalars included), and skips `undefined` so an
     * absent field never erases a value. All three rules are reproduced here.
     *
     * @param base - the lower layer (never mutated).
     * @param override - the higher layer (never mutated).
     * @returns a new merged value.
     */
    function mergeConfigValue(base, override) {
      if (!isConfigObject(override)) return cloneConfigValue(override)
      const merged = isConfigObject(base) ? cloneConfigValue(base) : {}
      for (const [key, value] of Object.entries(override)) {
        if (value === undefined) continue
        merged[key] = mergeConfigValue(merged[key], value)
      }
      return merged
    }

    /**
     * The EFFECTIVE configuration for this project — MIRROR of `resolveEffectiveConfig` in
     * `lib/workflow-file.js`:
     *
     *     const sources = ['defaults', 'patch-row']
     *     if (!isPlainObject(projectValue) || Object.keys(projectValue).length === 0) {
     *       return { config: resolveConfig(rowConfig), sources }
     *     }
     *     sources.push('project-file')
     *     return { config: resolveConfig(mergeConfigLayers(rowConfig, projectValue)), sources }
     *
     * The layer ORDER is the part worth stating: the project file is the LAST layer, so it
     * wins key by key over the plugin defaults. The empty-file branch is reproduced too — a
     * file that declares nothing contributes nothing, rather than an empty object overwriting
     * the defaults it does not mention.
     *
     * `defaults` is the settings snapshot's `value` (the plugin entry's resolved
     * configuration), NOT its `base`: the host merges the project over the row's EFFECTIVE
     * config, which is what the settings page writes, and `base` would drop those choices.
     *
     * @param defaults - the plugin-defaults layer (the snapshot's `value`).
     * @param project - the parsed project file, or anything else.
     * @returns the effective configuration.
     */
    function projectEffectiveConfig(defaults, project) {
      if (!isConfigObject(project) || Object.keys(project).length === 0) return cloneConfigValue(defaults)
      return mergeConfigValue(defaults, project)
    }

    /**
     * Read one nested key path — MIRROR of `getPath` in `lib/workflow-file.js`.
     *
     * @param source - the configuration object.
     * @param path - an array of keys.
     * @returns the value at that path, or undefined.
     */
    function configPathValue(source, path) {
      let node = source
      for (const key of path ?? []) {
        if (!isConfigObject(node)) return undefined
        node = node[key]
      }
      return node
    }

    /**
     * Whether two configuration leaves are the same value.
     *
     * Used to decide whether a project row's shadowed default is worth printing: a project that
     * re-states the default (`tier: standard` while the default IS `standard`) has overridden
     * nothing observable, and printing "default: standard" beside "standard" is noise. Only
     * leaves are compared — scalars and arrays — so the JSON projection is exact and has no key
     * ordering to disagree about. It is wrapped because `JSON.stringify` throws on a BigInt and
     * a diagnostic must never be the thing that throws.
     *
     * @param left - one value.
     * @param right - the other value.
     * @returns true when they are indistinguishable as configuration values.
     */
    function configValuesEqual(left, right) {
      if (left === right) return true
      try {
        return JSON.stringify(left) === JSON.stringify(right)
      } catch {
        return false
      }
    }

    /**
     * One configuration value as text, exactly as the file or the snapshot holds it.
     *
     * NO TRANSLATION AND NO RE-FORMATTING of scalars: `true` stays `true` rather than becoming
     * a language's word for it, because the whole point of this page is that the user can check
     * it against the value the plugin actually holds. Arrays are flattened for readability and
     * an empty one says so, because `[]` is a MEANINGFUL value on two of these keys
     * (`exemptTools: []` is "no exemption", `mustPass: []` is "no veto dimension").
     *
     * @param value - any configuration value.
     * @returns a one-line rendering.
     */
    function projectValueText(value) {
      if (value === undefined) return '—'
      if (value === null) return 'null'
      if (typeof value === 'string') return value
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      if (Array.isArray(value)) {
        return value.length === 0 ? '[]' : `[${value.map(projectValueText).join(', ')}]`
      }
      if (isConfigObject(value)) {
        if (Object.keys(value).length === 0) return '{}'
        try {
          return JSON.stringify(value)
        } catch {
          return '(unprintable)'
        }
      }
      try {
        return String(value)
      } catch {
        return '(unprintable)'
      }
    }

    /**
     * WHICH LAYER won the effective value at one leaf.
     *
     * This is the layered truth the page exists to show, and it is read off the same merge rule
     * {@link mergeConfigValue} implements, backwards:
     *
     *  - the project names the leaf itself (or replaced an ANCESTOR with a non-section — an
     *    array, a scalar, or `null`) → `'project'`;
     *  - the project does not mention it at all → `'inherited'`.
     *
     * The ancestor case is not hypothetical: `mustPass: []` and `tier: nope` both arrive as a
     * value at an ancestor path, and `mergeInto` assigns them wholesale.
     *
     * @param project - the parsed project file.
     * @param path - the leaf's key path.
     * @returns `'project'` or `'inherited'`.
     */
    /**
 * Resolve one label out of a two-level label table, falling back to the raw key.
 *
 * The config table lists EFFECTIVE settings as dotted paths, which are precise and
 * unreadable. Labels live in the dictionaries under `projectSections` / `projectLeaves`;
 * a path with no entry falls back to itself, so a config key added on the host still
 * shows up (as its path) rather than disappearing from the page.
 *
 * `t` is tried first because it is locale-aware, but its contract only promises strings —
 * so `fallbackTable` (passed by the caller, which is inside the scope that holds the
 * dictionaries) is used when `t` does not return an object. This function must NOT reach
 * for `zh`/`en` itself: those are declared inside the factory, not at module scope, so a
 * module-level helper referencing them throws `ReferenceError` at render time — which
 * `node --check` cannot see because it only validates syntax. The final fallback is the
 * raw key, i.e. the previous behaviour, so this can never regress into a broken page.
 */
function labelFromTable(t, table, key, fallbackTable) {
  let source = null
  try {
    source = t(table)
  } catch {
    source = null
  }
  if (source === null || typeof source !== 'object') {
    source = fallbackTable !== null && typeof fallbackTable === 'object' ? fallbackTable : null
  }
  if (source !== null && typeof source === 'object' && typeof source[key] === 'string') return source[key]
  return key
}

/** A leaf's dotted path as a human label, or the path itself when unlabelled. */
function projectLeafLabel(t, dotted, fallbackTable) {
  return labelFromTable(t, 'projectLeaves', dotted, fallbackTable)
}

/** A top-level section key as a human label, or the key itself when unlabelled. */
function projectSectionLabel(t, key, fallbackTable) {
  return labelFromTable(t, 'projectSections', key, fallbackTable)
}

function projectLeafSource(project, path) {
      if (!Array.isArray(path) || path.length === 0) return 'inherited'
      let node = project
      for (let index = 0; index < path.length; index += 1) {
        if (!isConfigObject(node) || !Object.hasOwn(node, path[index])) return 'inherited'
        const value = node[path[index]]
        if (index === path.length - 1) return 'project'
        // An ancestor that is not a section REPLACED the subtree, so everything under it came
        // from the project. `mergeInto` assigns these wholesale; it does not descend.
        if (!isConfigObject(value)) return 'project'
        node = value
      }
      return 'inherited'
    }

    /**
     * Every LEAF of a configuration tree, depth first, in the object's own key order.
     *
     * A leaf is anything the merge would not descend into: a scalar, `null`, an array, or an
     * EMPTY object (`{}` is a value a section can hold — `evaluator: {}` is malformed to the
     * gate, not "no evaluator settings", and hiding it would hide the refusal).
     *
     * The order is the source object's, which for the effective config is the settings
     * snapshot's own key order — so the page lists parameters in the order the plugin declares
     * them, without this bundle carrying a list of its own to fall behind.
     *
     * @param value - a configuration object, or anything else.
     * @returns an array of `{ path, value }`.
     */
    function projectConfigLeaves(value) {
      const leaves = []
      const walk = (node, path) => {
        if (!isConfigObject(node) || Object.keys(node).length === 0) {
          leaves.push({ path, value: node })
          return
        }
        for (const key of Object.keys(node)) walk(node[key], [...path, key])
      }
      if (!isConfigObject(value)) return []
      for (const key of Object.keys(value)) walk(value[key], [key])
      return leaves
    }

    /**
     * Read the subset of YAML the project file is written in — MIRROR of `parseWorkflowYaml` in
     * `lib/project.js`, which is what the HOST parses `.dsh/workflow.yml` with (through
     * `readWorkflowFile`, `readApprovalForProject` and `probeProject`).
     *
     * WHY A COPY INSTEAD OF A DIFFERENT READER. The page's job is to say what the plugin will
     * run, so it must read the file the way the plugin reads it — including the parts a general
     * YAML parser would get "better". Anything this reader cannot understand is REPORTED
     * (`problems`) and never guessed at, exactly as the host reports it, because a partially
     * read file is a configuration error the gate treats as one.
     *
     * The nested helpers are the host's own private module functions
     * (`pushFrame` / `findOwner` / `ensureArrayFor` / `resolveContainer` / `stripComment` /
     * `parseScalar`) moved inside so the whole rule lifts out of the bundle as ONE unit for the
     * differential test; their bodies are the host's, unchanged.
     *
     * @param text - the file's raw text.
     * @returns `{ value, problems }`, where problems lists the lines that were not understood.
     */
    function parseProjectYaml(text) {
      const root = {}
      const problems = []
      // Frames describe where the next nested value belongs:
      //   container[key] = value   (key === null means "the container is the value")
      // `indent` is the column of the line that DECLARED the key.
      const stack = [{ container: root, key: null, indent: -1 }]

      function pushFrame(container, key, indent) {
        stack.push({ container, key, indent })
        while (stack.length > 64) stack.splice(1, 1)
      }

      function findOwner(indent) {
        for (let i = stack.length - 1; i >= 0; i -= 1) {
          const frame = stack[i]
          if (Array.isArray(frame.container)) return frame
          if (frame.key !== null && indent > frame.indent) return frame
        }
        return null
      }

      function ensureArrayFor(frame) {
        const existing = frame.container[frame.key]
        if (Array.isArray(existing)) return existing
        const list = []
        frame.container[frame.key] = list
        return list
      }

      function resolveContainer(indent) {
        for (let i = stack.length - 1; i >= 0; i -= 1) {
          const frame = stack[i]
          if (indent > frame.indent) {
            if (frame.key === null) return frame.container
            const value = frame.container[frame.key]
            if (value !== null && typeof value === 'object' && !Array.isArray(value)) return value
            return frame.container
          }
        }
        return stack[0].container
      }

      function stripComment(line) {
        let inSingle = false
        let inDouble = false
        for (let i = 0; i < line.length; i += 1) {
          const ch = line[i]
          if (ch === "'" && !inDouble) inSingle = !inSingle
          else if (ch === '"' && !inSingle) inDouble = !inDouble
          else if (ch === '#' && !inSingle && !inDouble) {
            if (i === 0 || /\s/.test(line[i - 1])) return line.slice(0, i)
          }
        }
        return line
      }

      function parseScalar(raw) {
        if (raw.startsWith('[') && raw.endsWith(']')) {
          const inner = raw.slice(1, -1).trim()
          if (inner === '') return []
          return inner.split(',').map(part => parseScalar(part.trim()))
        }
        if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1)
        if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1)
        if (raw === 'true') return true
        if (raw === 'false') return false
        if (raw === 'null' || raw === '~') return null
        if (/^-?\d+$/.test(raw)) return Number.parseInt(raw, 10)
        if (/^-?\d*\.\d+$/.test(raw)) return Number.parseFloat(raw)
        return raw
      }

      const lines = String(text ?? '').split(/\r?\n/)
      for (let index = 0; index < lines.length; index += 1) {
        const rawLine = lines[index]
        const withoutComment = stripComment(rawLine)
        if (withoutComment.trim() === '') continue

        const indent = withoutComment.length - withoutComment.trimStart().length
        const content = withoutComment.trim()

        if (content === '-' || content.startsWith('- ')) {
          const owner = findOwner(indent)
          if (owner === null) {
            problems.push(`line ${index + 1}: list item has no owning key ("${content}")`)
            continue
          }
          const list = owner.key === null ? owner.container : ensureArrayFor(owner)
          const body = content === '-' ? '' : content.slice(2).trim()
          if (body === '') {
            pushFrame(list, null, indent)
            continue
          }
          const itemSeparator = body.indexOf(':')
          const looksLikeMapping = itemSeparator > 0 && !body.startsWith('[') && !/^["']/.test(body)
          if (!looksLikeMapping) {
            list.push(parseScalar(body))
            continue
          }
          const element = {}
          list.push(element)
          pushFrame(element, null, indent)
          const firstKey = body.slice(0, itemSeparator).trim()
          const firstRaw = body.slice(itemSeparator + 1).trim()
          if (firstRaw === '') pushFrame(element, firstKey, indent + 1)
          else element[firstKey] = parseScalar(firstRaw)
          continue
        }

        const separator = content.indexOf(':')
        if (separator <= 0) {
          problems.push(`line ${index + 1}: not a "key: value" mapping ("${content}")`)
          continue
        }
        const key = content.slice(0, separator).trim()
        const rawValue = content.slice(separator + 1).trim()

        const parent = resolveContainer(indent)
        if (rawValue === '') {
          // The container type is decided when the first child arrives.
          parent[key] = {}
          pushFrame(parent, key, indent)
          continue
        }
        parent[key] = parseScalar(rawValue)
      }

      return { value: root, problems }
    }

    /**
     * The approval gate for this project, as the HOST will resolve it — MIRROR of
     * `readApprovalForProject` (`lib/approval-state.js`) over `readApprovalGate`
     * (`lib/approval.js`).
     *
     * TWO RULES, and both are the host's:
     *
     *  1. A file that could not be fully read REFUSES the approval section outright, whatever it
     *     says, and the gate runs on {@link FAIL_CLOSED_APPROVAL}. Without this a typo in the
     *     file would silently select the plugin-defaults strength — which is the direction that
     *     can only widen a permission.
     *  2. Otherwise the section is read, and any malformed value refuses the WHOLE section: the
     *     four values then come from the fail-closed set rather than from a mixture of the
     *     user's intent and the defaults.
     *
     * @param section - the merged `approval` section (i.e. what the file asked for, over the
     *   defaults).
     * @param fileProblems - the project file's parse problems.
     * @param sectionDefaults - the documented defaults for an ABSENT field, taken from the
     *   defaults layer's own `approval` section.
     * @returns `{ usable, refused, reasons, strength, riskThreshold, denyHighAlways, exemptTools }`
     *   where the four values are ALWAYS usable-shaped: on a refusal they are the fail-closed
     *   ones, so no caller can read the user's intent off a gate that is not running it.
     */
    function projectApprovalGate(section, fileProblems, sectionDefaults) {
      const defaults = isConfigObject(sectionDefaults) ? sectionDefaults : {}
      const reasons = []

      const failClosed = () => ({
        usable: false,
        refused: true,
        reasons,
        strength: FAIL_CLOSED_APPROVAL.strength,
        riskThreshold: FAIL_CLOSED_APPROVAL.riskThreshold,
        denyHighAlways: FAIL_CLOSED_APPROVAL.denyHighAlways,
        exemptTools: [...FAIL_CLOSED_APPROVAL.exemptTools],
      })

      if (Array.isArray(fileProblems) && fileProblems.length > 0) {
        reasons.push('file')
        return failClosed()
      }

      // A non-object section is a MALFORMATION, not "no overrides": `approval: nope` must not
      // be normalised into the defaults, which is the one direction that can widen the gate.
      if (section !== undefined && section !== null && !isConfigObject(section)) {
        reasons.push('section')
        return failClosed()
      }

      const source = isConfigObject(section) ? section : {}
      const strength = source.strength ?? defaults.strength
      if (typeof strength !== 'string' || !APPROVAL_STRENGTH_VALUES.includes(strength)) reasons.push('strength')

      const riskThreshold = source.riskThreshold ?? defaults.riskThreshold
      if (typeof riskThreshold !== 'string' || !RISK_LEVEL_VALUES.includes(riskThreshold)) reasons.push('riskThreshold')

      const denyHighAlways = source.denyHighAlways ?? defaults.denyHighAlways
      if (typeof denyHighAlways !== 'boolean') reasons.push('denyHighAlways')

      // `readStringList('approval.exemptTools', …, { allowEmpty: true })`: an absent list takes
      // the fallback, an empty list is honoured, and a MIXED one is refused rather than
      // filtered — filtering `['safe', 7]` down to `['safe']` would silently change which calls
      // skip the gate.
      const rawExempt = source.exemptTools
      let exemptTools = Array.isArray(defaults.exemptTools) ? [...defaults.exemptTools] : []
      if (rawExempt !== undefined && rawExempt !== null) {
        if (!Array.isArray(rawExempt) || rawExempt.some(item => typeof item !== 'string')) reasons.push('exemptTools')
        else exemptTools = [...rawExempt]
      }

      if (reasons.length > 0) return failClosed()

      return { usable: true, refused: false, reasons: [], strength, riskThreshold, denyHighAlways, exemptTools }
    }

    /**
     * Why the HOST would refuse this `evaluator` section — MIRROR of `readEvaluatorGate` in
     * `lib/gate.js` (over `checkBar`, `checkMaxRounds` and `readStringList`).
     *
     * NOTHING IS SUBSTITUTED, and that is the difference from the approval mirror: an unusable
     * `evaluator` section is not replaced by anything — every review in the project is simply
     * REFUSED. So the resolved values stay on screen (they are what the file says) and this
     * tells the page to mark the section as one the host will not run. Without the mark, a
     * project whose `bar` is a string would look configured while `workflow_review` refused
     * every round — the worst place for a misconfiguration to hide.
     *
     * @param section - the merged `evaluator` section.
     * @param sectionDefaults - the defaults layer's own `evaluator` section.
     * @returns an array of `code`s ('section', 'bar', 'maxRounds', 'dimensions', 'mustPass',
     *   'mustPass-not-scored'); empty means the host accepts it.
     */
    function projectEvaluatorProblems(section, sectionDefaults) {
      const defaults = isConfigObject(sectionDefaults) ? sectionDefaults : {}
      if (section !== undefined && section !== null && !isConfigObject(section)) return ['section']
      const source = isConfigObject(section) ? section : {}
      const problems = []

      const bar = source.bar ?? defaults.bar
      if (typeof bar !== 'number' || !Number.isFinite(bar) || bar < BAR_MIN || bar > BAR_MAX) problems.push('bar')

      const maxRounds = source.maxRounds ?? defaults.maxRounds
      if (typeof maxRounds !== 'number' || !Number.isFinite(maxRounds) || !Number.isInteger(maxRounds) || maxRounds < 1) {
        problems.push('maxRounds')
      }

      // The list rules, including the PATH-DEPENDENT empty-list one: `dimensions: []` scores
      // nothing and is refused, while `mustPass: []` ("no veto dimension") is coherent, legal
      // in the exported schema, and honoured.
      const readList = (raw, fallback, allowEmpty) => {
        if (raw === undefined || raw === null) return Array.isArray(fallback) ? [...fallback] : []
        if (!Array.isArray(raw)) return undefined
        if (raw.some(item => typeof item !== 'string')) return undefined
        if (raw.length === 0 && !allowEmpty) return undefined
        return [...raw]
      }

      const dimensions = readList(source.dimensions ?? defaults.dimensions, defaults.dimensions, false)
      if (dimensions === undefined) problems.push('dimensions')
      const mustPass = readList(source.mustPass ?? defaults.mustPass, defaults.mustPass, true)
      if (mustPass === undefined) problems.push('mustPass')
      if (dimensions !== undefined && mustPass !== undefined && mustPass.some(name => !dimensions.includes(name))) {
        problems.push('mustPass-not-scored')
      }
      return problems
    }

    /**
     * The plugin-defaults layer, read out of a `configForms` snapshot.
     *
     * MIRROR OF THE SNAPSHOT CONTRACT, not of a rule: `dsh-client-ui-settings` documents that
     * "Snapshots contain resolved `value`, inherited `base`, raw `user`, revision, writability,
     * and persistence mode", and `status: 'unavailable'` means the settings document does not
     * serve this namespace at all (its README: "a form starts `unavailable`").
     *
     * `value` IS IGNORED UNLESS `status === 'ready'`, which is the same rule the sidebar's
     * switch follows: a form's store is seeded `{ status: 'loading', value: undefined }` and a
     * NON-READY SNAPSHOT CAN STILL CARRY A VALUE — reading one is how a page reports a
     * configuration that is not the one in force.
     *
     * @param snapshot - `form.getSnapshot()`, or anything else.
     * @returns `{ state, value }` where state is `'ready' | 'loading' | 'unavailable'` and
     *   `value` is a plain object only when state is `'ready'`.
     */
    function projectDefaultsState(snapshot) {
      if (snapshot === null || typeof snapshot !== 'object') return { state: 'unavailable', value: null }
      if (snapshot.status === 'unavailable') return { state: 'unavailable', value: null }
      if (snapshot.status !== 'ready') return { state: 'loading', value: null }
      if (!isConfigObject(snapshot.value)) return { state: 'unavailable', value: null }
      return { state: 'ready', value: snapshot.value }
    }

    /**
     * The whole page model for the effective configuration: the merged values, their layers, and
     * the sections the different parameters belong to.
     *
     * WHAT IT REFUSES TO DO, and each refusal is a decision rather than a gap:
     *
     *  - A FILE IT COULD NOT READ produces NO sections. An absent file means this project has
     *    not opted in; a file that was refused means the tab cannot know what it says. Either
     *    way a table of inherited defaults under that heading would read as if the project had
     *    chosen them, so the state (`'not-opted-in'` / `'unreadable'`) leaves `sections` empty
     *    and the renderer shows the remedy instead.
     *  - AN UNREADABLE DEFAULTS LAYER does not stop the page: the PROJECT's own rows are real
     *    and worth showing, so they are rendered from the parsed file alone, every one of them
     *    marked `'project'`, with `unknownDefaults` telling the renderer to say that inherited
     *    values are not available. Guessing them from a hand-copied table is the failure this
     *    whole page exists to correct.
     *  - THE `approval` SECTION IS NEVER READ OFF THE MERGED TREE. The host does not use the
     *    merged section when it refuses it, so the four values shown are the gate's own
     *    ({@link projectApprovalGate}) and their layer says `'fail-closed'` when that is what is
     *    in force, with the file's value kept as what was asked for.
     *
     * @param file - a result from {@link projectFileResult}.
     * @param defaults - the DEFAULTS LAYER as `{ state, value }`, i.e. what
     *   {@link projectDefaultsState} returned for the settings snapshot. The two are kept as one
     *   argument because a caller able to pass a `value` without its `state` is a caller able to
     *   pass an unloaded document as a configuration.
     * @returns the page model. `sections` is `[]` for every state but `'ready'`.
     */
    function projectConfigView(file, defaults) {
      const pair = isConfigObject(defaults) && typeof defaults.state === 'string' ? defaults : {}
      const defaultsState = {
        state: pair.state === 'ready' || pair.state === 'loading' ? pair.state : 'unavailable',
        value: isConfigObject(pair.value) ? pair.value : null,
      }
      const empty = {
        state: 'unreadable',
        problems: [],
        defaultsState: defaultsState.state,
        unknownDefaults: true,
        counts: { project: 0, inherited: 0, unknown: 0, refused: 0 },
        sections: [],
      }
      if (file === null || typeof file !== 'object' || file.state !== 'ok') {
        return { ...empty, state: projectFileAbsent(file) ? 'not-opted-in' : 'unreadable' }
      }

      const parsed = parseProjectYaml(file.text)
      const defaultsValue = defaultsState.state === 'ready' ? defaultsState.value : null
      const unknownDefaults = defaultsValue === null
      const project = isConfigObject(parsed.value) ? parsed.value : {}
      const effective = unknownDefaults ? null : projectEffectiveConfig(defaultsValue, project)
      const source = effective === null ? project : effective

      // THE TWO SECTIONS THE HOST RESOLVES THROUGH ITS OWN VALIDATOR may be mirrored only when the
      // defaults layer actually CARRIES them. `readApprovalGate` / `readEvaluatorGate` fall back to
      // `DEFAULT_CONFIG` for a field the section does not have, and that layer is a host module
      // this bundle cannot read — so a defaults layer missing the section would make every field
      // look malformed (four fail-closed axes) where the host would have used its documented
      // defaults. That is precisely the confidently-wrong answer this page must not print, so those
      // rows are reported as UNKNOWN instead, with the section saying why.
      const approvalMirrorable = effective !== null && isConfigObject(defaultsValue.approval)
      const evaluatorMirrorable = effective !== null && isConfigObject(defaultsValue.evaluator)

      const sections = []
      const byKey = new Map()
      const sectionFor = key => {
        if (!byKey.has(key)) {
          const section = { key, rows: [], note: null }
          byKey.set(key, section)
          sections.push(section)
        }
        return byKey.get(key)
      }

      // The section order is the EFFECTIVE config's own key order, which is the settings
      // snapshot's — i.e. the order the plugin declares its parameters in. No list of section
      // names lives in this bundle, so a section the host adds appears here by itself.
      for (const key of isConfigObject(source) ? Object.keys(source) : []) sectionFor(key)

      const counts = { project: 0, inherited: 0, unknown: 0, refused: 0 }
      const count = row => {
        // `'fail-closed'` lands in the refusal bucket: those rows are neither this project's
        // choice nor an inherited default — they are what the host substituted for the section.
        const bucket = row.source === 'fail-closed' ? 'refused' : row.source
        counts[bucket] = (counts[bucket] ?? 0) + 1
      }

      for (const leaf of projectConfigLeaves(source)) {
        // `approval` is built below from the gate — but only when that gate can be mirrored.
        if (leaf.path[0] === 'approval' && approvalMirrorable) continue
        const layer =
          effective === null
            ? 'project'
            : leaf.path[0] === 'approval' && !approvalMirrorable
              ? 'unknown'
              : projectLeafSource(project, leaf.path)
        const row = {
          dotted: leaf.path.join('.'),
          path: leaf.path,
          // An unresolved row carries NO value, so the renderer can only print the word for it.
          value: layer === 'unknown' ? null : leaf.value,
          source: layer,
          previous: layer === 'project' && defaultsValue !== null ? configPathValue(defaultsValue, leaf.path) : null,
          previousKnown: defaultsValue !== null,
          asked: null,
        }
        sectionFor(leaf.path[0]).rows.push(row)
        count(row)
      }

      if (effective !== null && !approvalMirrorable && byKey.has('approval')) {
        byKey.get('approval').note = { key: 'projectConfigSectionUnknown', detail: ['approval'] }
      }

      if (approvalMirrorable) {
        const gate = projectApprovalGate(effective.approval, parsed.problems, defaultsValue.approval)
        const section = sectionFor('approval')
        // The four fields `readApprovalGate` reads, by name — the same four the settings page
        // writes. Kept in one array so a fifth field cannot be added to the host reader and
        // quietly go unrendered here; `test/status.test.mjs` compares this list with the four
        // keys the host's own gate returns.
        const mergedSection = isConfigObject(effective.approval) ? effective.approval : {}
        section.rows = ['strength', 'riskThreshold', 'denyHighAlways', 'exemptTools'].map(axis => {
          const path = ['approval', axis]
          const layer = gate.usable ? projectLeafSource(project, path) : 'fail-closed'
          const asked = mergedSection[axis]
          const row = {
            dotted: path.join('.'),
            path,
            value: gate[axis],
            source: layer,
            previous: layer === 'project' ? configPathValue(defaultsValue, path) : null,
            previousKnown: defaultsValue !== null,
            // When the whole section is malformed there is no per-axis value to show; the section
            // note carries the raw section instead of repeating it on all four rows.
            asked: layer === 'fail-closed' && asked !== undefined ? asked : null,
          }
          count(row)
          return row
        })
        if (!gate.usable) {
          // The reasons are shown verbatim: the parse problems are the HOST's own strings (the
          // same reader produced them), and the field names are configuration paths.
          const detail = gate.reasons.includes('file')
            ? [...parsed.problems]
            : gate.reasons.includes('section')
              ? [`approval: ${projectValueText(effective.approval)}`]
              : gate.reasons.map(name => `approval.${name}`)
          section.note = { key: 'projectApprovalRefused', detail }
        }
      }

      if (evaluatorMirrorable) {
        const evaluatorProblems = projectEvaluatorProblems(effective.evaluator, defaultsValue.evaluator)
        if (evaluatorProblems.length > 0) {
          sectionFor('evaluator').note = {
            key: 'projectEvaluatorRefused',
            detail: evaluatorProblems.map(name => (name === 'section' ? 'evaluator' : `evaluator.${name}`)),
          }
        }
      } else if (effective !== null && byKey.has('evaluator')) {
        byKey.get('evaluator').note = { key: 'projectConfigSectionUnknown', detail: ['evaluator'] }
      }

      return {
        state: 'ready',
        problems: parsed.problems,
        defaultsState: defaultsState.state,
        unknownDefaults,
        counts,
        // A section whose every row moved elsewhere (nothing but `approval`, say) is dropped
        // rather than rendered as an empty heading.
        sections: sections.filter(section => section.rows.length > 0 || section.note !== null),
      }
    }

    /**
     * One row, as the text the page shows.
     *
     * `value` is null when the row is unresolved — the renderer prints its own word for that,
     * so the page never shows a plausible-looking number it could not derive. `shadow` is the
     * DEFAULT the project overrode, shown only when the two actually differ (re-stating the
     * default overrides nothing observable, and printing it beside itself is noise). `asked` is
     * what the file asked for on a `'fail-closed'` row, i.e. what the refusal cost.
     *
     * @param row - one row from {@link projectConfigView}.
     * @returns `{ value, shadow, asked }`, each a string or null.
     */
    function projectRowText(row) {
      const source = row !== null && typeof row === 'object' ? row.source : 'unknown'
      if (source === 'unknown') return { value: null, shadow: null, asked: null }
      return {
        value: projectValueText(row.value),
        shadow:
          source === 'project' && row.previousKnown === true && !configValuesEqual(row.previous, row.value)
            ? projectValueText(row.previous)
            : null,
        asked: source === 'fail-closed' && row.asked !== undefined && row.asked !== null ? projectValueText(row.asked) : null,
      }
    }

    /**
     * The panel that should be visible in the sidebar, given a settings snapshot.
     *
     * `showInSidebar` is the ONE switch that separates the panel's two deliverables:
     * with it off, the sidebar entry and the `main` body disappear while every
     * model-facing tool keeps working unchanged — the design's own goal
     * (「面板停用而工具照常工作」). It is the panel row's field and therefore lives in
     * the same settings document `workflow_set` writes, so the switch has exactly one
     * owner.
     *
     * READS THE READY SNAPSHOT ONLY, and that "ready" is the whole point: the
     * controller's very first snapshot is `{ status: 'idle', value: undefined }` while
     * the settings document loads, and an unread value is NOT a disabled one. Reading
     * `value?.showInSidebar` off an unloaded snapshot would return undefined, and a
     * naive `=== true` test would then hide the entry on every boot — the panel would
     * silently never appear for the majority who never touch the switch. So an
     * unanswered document leaves the entry registered (the resolved default is `true`;
     * see `DEFAULT_CONFIG.showInSidebar` in `lib/config.js`) and only an ANSWERED
     * `false` withdraws it.
     *
     * @param snapshot - `configForms.get(PANEL_ENTRY_ID).getSnapshot()` — the PANEL row,
     *   which is the row that declares `showInSidebar` — or anything else.
     * @returns true when the sidebar entry (and its `main` body) may be registered.
     */
    function panelVisible(snapshot) {
      if (snapshot === null || typeof snapshot !== 'object') return true
      if (snapshot.status !== 'ready') return true
      const value = snapshot.value
      if (value === null || typeof value !== 'object') return true
      return value.showInSidebar !== false
    }

    /**
     * The label for the sidebar entry: the configured one, else the dictionary, else
     * the id.
     *
     * `label` is rendered as PLAIN VISIBLE TEXT, the button's accessible name, and the
     * collapsed tooltip, so it must be an actual non-empty string by the time the
     * sidebar projects it. A blank configured label would leave an unlabelled,
     * unlabellable button, hence the trim-then-fall-through rather than a `??` chain;
     * and the id is the documented last resort, so the entry is never nameless.
     *
     * @param configured - the snapshot's `sidebarLabel`.
     * @param fallback - the dictionary's `panelLabel`.
     * @param id - the panel id, the last resort when neither of the above is usable.
     * @returns the string to display.
     */
    function panelLabel(configured, fallback, id) {
      if (typeof configured === 'string' && configured.trim() !== '') return configured
      if (typeof fallback === 'string' && fallback.trim() !== '') return fallback
      return typeof id === 'string' && id !== '' ? id : ''
    }

    /**
     * The body's one extra row: the `showInSidebar` switch itself.
     *
     * `WorkflowCard` is the core row's page, so it does not and must not carry the
     * PANEL row's own fields. The value is a top-level boolean, so `form.set` reaches it
     * — but "reaches it" is not enough: the write has to land in the SAME document the
     * gate reads, which is why the caller passes the PANEL row's controller
     * (`props.panelController` / `panelConfigController`), never the core row's.
     *
     * THE SWITCH IS NOT A ONE-WAY DOOR, and that is a hard requirement rather than a
     * nicety: turning it off withdraws the sidebar entry (see {@link panelVisible}), so
     * the sidebar body is exactly the surface that disappears. Two other places keep the
     * switch reachable — the row's own page on 设置 → 插件, registered for BOTH rows so
     * `dsh-workflow-panel` keeps a page (see `apply`), and the profile patch itself.
     * The earlier shape, where this body row was the ONLY control, made the off state
     * unrecoverable from the product: `workflow_set` writes the project file (a
     * different layer than the profile patch the gate reads) and its writer refuses the
     * field outright, so every documented way back was wrong. The hint text says where
     * the switch lives instead of repeating that mistake.
     *
     * @param options - `{ t, writable, checked, onChange }`.
     * @returns the row element.
     */
    function sidebarVisibleRow(options) {
      const { t, writable, checked, onChange } = options
      return react.createElement(
        'div',
        { style: { display: 'grid', gap: '2px', marginBottom: '8px' } },
        react.createElement('label', { style: { display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' } },
          react.createElement('input', {
            type: 'checkbox',
            checked,
            disabled: !writable,
            onChange,
          }),
          t('showInSidebar'),
        ),
        react.createElement('div', { style: { ...hintStyle, gridColumn: 'auto' } }, t('showInSidebarHint')),
      )
    }

    /**
     * Submit one write and settle its verdict into a status line.
     *
     * `ConfigFormController.set` and `.mutate` are ASYNC — they resolve after the host
     * answers the mutation. Reporting a verdict synchronously would read the returned
     * Promise as truthy and claim success even for a rejected write, so the message waits
     * for settlement and is stamped so a stale timer cannot clear a newer one.
     *
     * MODULE-LEVEL because the sidebar body writes the `showInSidebar` switch through the
     * SAME discipline as the settings page: a second, private copy of this helper is the
     * second write path the two surfaces would then drift apart on.
     *
     * @param submit - thunk performing the write and returning its promise.
     * @param writeToken - a React ref holding the newest write's stamp.
     * @param setMessage - the status line's setter.
     * @param t - the translator.
     */
    function commit(submit, writeToken, setMessage, t) {
      const token = ++writeToken.current
      const settle = accepted => {
        if (writeToken.current !== token) return
        setMessage(accepted ? t('saved') : t('saveFailed'))
        window.setTimeout(() => {
          if (writeToken.current === token) setMessage('')
        }, 2500)
      }
      let pending
      try {
        pending = submit()
      } catch (error) {
        console.error(`${DIAG} write threw`, error)
        settle(false)
        return
      }
      if (pending && typeof pending.then === 'function') pending.then(settle, error => {
        console.error(`${DIAG} write rejected`, error)
        settle(false)
      })
      else settle(pending === undefined ? true : Boolean(pending))
    }

    /**
     * Write one TOP-LEVEL scalar immediately (`ConfigForm.set`), reporting the verdict.
     *
     * The `showInSidebar` switch rides this: it is a top-level boolean of
     * `DEFAULT_CONFIG`, so `set` reaches it and no nested op is needed.
     *
     * @param form - the controller.
     * @param field - the top-level field name.
     * @param next - the value the control produced.
     * @param writeToken - a React ref holding the newest write's stamp.
     * @param setMessage - the status line's setter.
     * @param t - the translator.
     */
    function writeTopLevel(form, field, next, writeToken, setMessage, t) {
      commit(() => form.set(field, next), writeToken, setMessage, t)
    }

    /**
     * The module keys a snapshot's `modules` section actually carries.
     *
     * DERIVED, NEVER LISTED. `lib/config.js` owns the module key set and
     * `lib/config-schema.js` builds the module schema from `Object.keys(DEFAULT_CONFIG.modules)`,
     * so a second list here would silently omit every module added later — the panel would
     * quietly stop being able to switch the newest knobs. The snapshot value is the source of
     * truth instead.
     *
     * The non-object guard MIRRORS the host's section rule: `validateSettingValue` refuses a
     * scalar or an array where a section is expected, and `test/status.test.mjs` pins that
     * mirror. A hand-edited `modules: nope` therefore yields no rows rather than a crash.
     *
     * @param modules - the snapshot's `modules` value, of unknown shape.
     * @returns the config's own key order, or [] when there is no section to read.
     */
    function moduleKeys(modules) {
      if (modules === null || typeof modules !== 'object' || Array.isArray(modules)) return []
      return Object.keys(modules)
    }

    /**
     * The atomic op that sets ONE nested field, anywhere below the section root.
     *
     * `ConfigForm.set` only reaches a TOP-LEVEL scalar — the official controller implements it
     * as `mutate([{ op: 'set', path: [field], value }])` — so a nested field needs the op list
     * directly. The path is the same dotted path the host writer accepts (`workflow_set
     * path=approval.strength` reaches `validateSettingValue`'s `approval.strength` rule, and so
     * on); `test/status.test.mjs` pins that every op this builds is one the writer accepts.
     *
     * ONE KEY PER OP. Building a whole section (`{ ...value.approval, strength }`) from the
     * value read at render time is a LOST UPDATE: two fast clicks on sibling fields in the same
     * section each spread the same stale section, so the second write reverts the first. That is
     * why there is no per-call-site section spread left anywhere in this file.
     *
     * @param section - the top-level section name (`approval`, `evaluator`, …).
     * @param key - the field inside that section.
     * @param value - the value the control produced.
     * @returns a one-op list for `form.mutate`.
     */
    function fieldOps(section, key, value) {
      return [{ op: 'set', path: [section, key], value }]
    }

    /**
     * The atomic op that sets ONE nested `modules.<key>` switch.
     *
     * Delegates to {@link fieldOps} so there is exactly one definition of the op this page
     * builds; `test/status.test.mjs` pins the modules case the way it pins the rest.
     *
     * @param key - one module key, taken from the snapshot.
     * @param value - the switch's new boolean state.
     * @returns a one-op list for `form.mutate`.
     */
    function moduleOps(key, value) {
      return fieldOps('modules', key, value)
    }

    /**
     * Read a configured list as a list of strings, or [] when it is not one.
     *
     * MIRRORS the stance of `readStringList` in `lib/gate.js`: a MIXED list is refused, never
     * filtered. Filtering the non-strings out here would turn `mustPass: [["correctness"], "build"]`
     * into `["build"]` — silently narrowing the veto set, which is exactly the round-4 blocker
     * that module's docstring records. A list containing anything but strings is therefore
     * treated as unusable (no rows, an empty field) rather than flattened into text the next
     * edit would quietly narrow.
     *
     * @param raw - the snapshot's value for the list field, of unknown shape.
     * @returns the list of strings, or [].
     */
    function stringList(raw) {
      if (!Array.isArray(raw) || raw.some(item => typeof item !== 'string')) return []
      return [...raw]
    }

    /**
     * Render a configured list into the text a list editor shows.
     *
     * @param raw - the snapshot's value for the list field.
     * @returns `"a, b"`, or `""` when the value is not a list of strings.
     */
    function listText(raw) {
      return stringList(raw).join(', ')
    }

    /**
     * Parse a comma-separated list editor into the value the host's reader accepts.
     *
     * TWO MIRRORS OF `readStringList` (`lib/gate.js`), both of which the writer
     * (`validateSettingValue`) enforces too:
     *
     *  - every entry is a STRING. A text field cannot produce a non-string, so the mixed-list
     *    case is unreachable from this control — which is why the panel needs no equivalent of
     *    the gate's `MIXED_LIST` refusal.
     *  - an EMPTY list is written only where the gate allows it (`evaluator.mustPass` and
     *    `approval.exemptTools` pass `allowEmpty: true`). `evaluator.dimensions` does not:
     *    "score nothing" makes every review ungradeable, so a cleared field is refused HERE and
     *    nothing is written. The host's config schema would accept the empty list, so leaving it
     *    to the host would persist a project whose every review fails.
     *
     * @param raw - the input's raw text.
     * @param options - `{ allowEmpty }` — whether an empty list may be written.
     * @returns a list of strings, or undefined when the field must not be written at all.
     */
    function listValue(raw, options) {
      const allowEmpty = options?.allowEmpty === true
      const items = String(raw)
        .split(',')
        .map(entry => entry.trim())
        .filter(entry => entry !== '')
      if (items.length === 0 && !allowEmpty) return undefined
      return items
    }

    /**
     * Parse a whole-number input, or refuse it.
     *
     * MIRROR of the writer's integer rules (`validateSettingValue`): `subagent.maxDepth` is an
     * integer in [1, MAX_SUBAGENT_DEPTH], `subagent.maxActiveSubagents` and
     * `retireCheck.everyDays` are integers of 1 or more. A blank field means "leave it", never
     * zero — the same stance the pass-mark input takes, and for the same reason: the writer
     * would refuse a non-integer anyway, and the host's schema (`z.number()`) would not.
     *
     * @param raw - the input's raw text.
     * @param minimum - inclusive lower bound.
     * @param maximum - optional inclusive upper bound.
     * @returns the integer, or undefined when the field must not be written.
     */
    function intValue(raw, minimum, maximum) {
      const trimmed = String(raw).trim()
      if (trimmed === '') return undefined
      const next = Number(trimmed)
      if (!Number.isInteger(next) || next < minimum) return undefined
      if (maximum !== undefined && next > maximum) return undefined
      return next
    }

    /**
     * Drop veto dimensions that the scored set no longer contains.
     *
     * `readEvaluatorGate` (`lib/gate.js`) REFUSES the whole gate when `mustPass` names a
     * dimension `dimensions` does not score — every review then fails with an explanation
     * instead of a score. Removing a dimension from `dimensions` therefore has to remove it
     * from the veto set in the SAME atomic op list; otherwise one edit leaves the project with
     * a gate that refuses everything.
     *
     * @param current - the configured veto list (already read through {@link stringList}).
     * @param dimensions - the dimensions about to be written.
     * @returns the veto dimensions that are still scored.
     */
    function prunedMustPass(current, dimensions) {
      return current.filter(dimension => dimensions.includes(dimension))
    }

    /**
     * Toggle one veto dimension, keeping the veto set a SUBSET of the scored set.
     *
     * The checkboxes are built from `dimensions`, so a checked box can only be a scored
     * dimension. Order follows `dimensions` rather than the click order, and an entry the
     * dimensions no longer list is dropped — see {@link prunedMustPass} for why the subset
     * invariant is not negotiable.
     *
     * @param current - the configured veto list (already read through {@link stringList}).
     * @param dimensions - the offered dimensions, in their configured order.
     * @param item - the dimension whose box changed.
     * @param on - the box's new state.
     * @returns the next veto list; `[]` is legal (average-only grading).
     */
    function toggledMustPass(current, dimensions, item, on) {
      const selected = new Set(current)
      if (on) selected.add(item)
      else selected.delete(item)
      return dimensions.filter(dimension => selected.has(dimension))
    }

    /**
     * Pick the config-form controller for this row.
     *
     * ORDER MATTERS. The plugin manager passes `form` as a render prop, but it is a
     * NARROWED VIEW, not the controller:
     *
     *     const formFor = (id) => ({ state: form.getSnapshot(),
     *                                mutate: (ops, revision) => form.mutate(ops, revision) })
     *                                                                  // dsh-client-ui-plugin-manager
     *
     * It has no `subscribe`, no `getSnapshot`, and no `set`. Preferring it made the
     * subscription effect bail out and the page sat on "loading" forever.
     *
     * The service therefore comes FIRST: `ctx.configForms.get(entryId)` returns the
     * provider's single full controller per entry, which is what a live-updating
     * form needs. The render prop stays as a last-resort fallback so that a future
     * change in which share wins cannot leave the page blank.
     *
     * The entry id is spelled here rather than taken from `props.entryKey`: the page
     * builds that key from the row it happens to be showing, and this page only ever
     * edits the one core row.
     *
     * "THE ONE CORE ROW" IS STILL TRUE AFTER THE SIDEBAR WORK, and it is worth saying
     * why, because the page now renders under two keys. The panel row's copy of the page
     * edits the same `dsh-workflow-core` document through this function — the two rows
     * declare the same schema, and the page is one form either way. The panel row's OWN
     * fields arrive separately, as `props.panelController`.
     *
     * @param props - the slot's props.
     * @param ctx - the browser plugin context.
     * @returns the controller, or undefined when neither source has one.
     */
    function resolveForm(props, ctx) {
      if (typeof ctx?.configForms?.get === 'function') {
        try {
          const controller = ctx.configForms.get(ENTRY_ID)
          if (controller !== undefined) return controller
        } catch (error) {
          console.error(`${DIAG} configForms.get threw`, error)
        }
      }
      return props?.form
    }

    /**
     * The config-form controller for the panel row — the entry that DECLARES
     * `showInSidebar` and `sidebarLabel`.
     *
     * MIRRORS {@link resolveForm}, which asks for {@link ENTRY_ID} (the core row, the one
     * this page otherwise edits). These two ids are NOT interchangeable: each Loader row
     * owns its own settings document, so the value `panelVisible` gates on, the value the
     * sidebar's label comes from and the value the body's switch writes must all be read
     * from, and written to, THIS controller. Reading one row and writing the other is the
     * defect this function's existence prevents: the switch would report "saved", change
     * nothing any reader consults, and the sidebar entry would still be there after the
     * next reload.
     *
     * @param ctx - the browser plugin context.
     * @returns the controller, or undefined when the settings service cannot serve it.
     */
    function panelConfigController(ctx) {
      try {
        return ctx?.configForms?.get?.(PANEL_ENTRY_ID)
      } catch (error) {
        console.error(`${DIAG} panel configForms.get threw`, error)
        return undefined
      }
    }

    /**
     * The config-form controller that serves the PLUGIN DEFAULTS for this plugin entry — the
     * layer every project inherits.
     *
     * THE TAB READS THIS ONE AND ONLY READS IT. `ctx.configForms.get(ENTRY_ID)` is the same
     * controller the settings page edits, and the tab needs its snapshot because a project's
     * effective configuration is the project file MERGED OVER this layer; without it the page
     * could only print the file, which is what the user could not read in the first place.
     * Nothing here writes: the tab calls no `set`, `mutate` or `unset` on it, and the writers of
     * this layer remain the settings page and the sidebar panel.
     *
     * MIRRORS {@link resolveForm}'s service-first branch (the same `ctx.configForms.get(ENTRY_ID)`
     * call), minus its `props.form` fallback: that fallback is the plugin manager's render prop,
     * which belongs to the SETTINGS page's two-per-row rendering and is not a reader of the
     * settings document at all. A namespace the Host does not serve yields a controller whose
     * snapshot is `unavailable`, which {@link projectDefaultsState} reports as such — the tab
     * degrades to "the defaults layer could not be read" rather than to nothing.
     *
     * @param ctx - the browser plugin context.
     * @returns the controller, or undefined when the settings service cannot serve it.
     */
    function projectDefaultsController(ctx) {
      try {
        return ctx?.configForms?.get?.(ENTRY_ID)
      } catch (error) {
        console.error(`${DIAG} tab configForms.get threw`, error)
        return undefined
      }
    }

    /**
     * The settings page. Every change is written immediately, so there is no staged
     * draft to lose.
     */
    function WorkflowCard(props) {
      const t = props?.t ?? (key => zh[key] ?? en[key] ?? key)
      // The controller handed in by `inject` wins; `resolveForm` only falls back to
      // the page's narrowed render prop, which cannot subscribe to live updates.
      const form = props?.controller ?? resolveForm(props, props?.ctx)
      // The field grid is a WINDOW property, so the sidebar body overrides it for its
      // narrow column; the plugin page keeps the shared two-column default.
      const rowStyle = props?.rowStyle ?? rowStyleDefault
      const [snapshot, setSnapshot] = react.useState(null)
      const [message, setMessage] = react.useState('')
      // Stamped so a slow write cannot have its verdict overwritten by an earlier
      // write's dismiss timer.
      const writeToken = react.useRef(0)
      // The `showInSidebar` switch keeps its OWN stamp. Sharing `writeToken` would let a
      // switch write swallow the verdict of the control the user just clicked (and vice
      // versa), because the stamp is what suppresses a stale dismiss timer.
      const switchToken = react.useRef(0)

      react.useEffect(() => {
        if (!form || typeof form.subscribe !== 'function') return undefined
        const publish = () => setSnapshot(form.getSnapshot())
        publish()
        return form.subscribe(publish)
      }, [form])

      // THE RECOVERY PATH. The PANEL row's page (and only that page) receives its own
      // row's controller, so `showInSidebar` is reachable from a page that survives the
      // switch being turned off. Without this the switch is a one-way door: the sidebar
      // entry is the only other place the checkbox exists.
      const panel = props?.panelController
      const [panelSnapshot, setPanelSnapshot] = react.useState(null)
      react.useEffect(() => {
        if (!panel || typeof panel.subscribe !== 'function') return undefined
        const publish = () => setPanelSnapshot(panel.getSnapshot())
        publish()
        return panel.subscribe(publish)
      }, [panel])

      // The plugin manager renders this same registration once per row with
      // `view: "summary"` to fill the row's description line. Returning the
      // one-liner here (and ONLY here) is what keeps the full body — and any
      // diagnostic text — out of the description.
      if (props?.view === 'summary') return t('description')

      if (!form) return react.createElement('p', { style: hintStyle }, t('unavailable'))
      if (!snapshot) {
        // Worth a diagnostic: reaching here means the controller exists but the
        // subscription never delivered a snapshot, which is indistinguishable from
        // "still loading" in the UI.
        console.info(
          `${DIAG} page view: controller=${form ? 'yes' : 'no'} ` +
            `subscribe=${typeof form?.subscribe} snapshot=null`,
        )
        return react.createElement('p', { style: hintStyle }, t('loading'))
      }
      if (snapshot.status === 'unavailable') {
        return react.createElement('p', { style: hintStyle }, t('namespaceMissing')(ENTRY_ID))
      }
      if (snapshot.status !== 'ready') {
        return react.createElement('p', { style: hintStyle }, t('loading'))
      }

      const writable = snapshot.writable === true
      const value = snapshot.value ?? {}

      /**
       * Read one top-level section as a plain object.
       *
       * A HAND-EDITED CONFIG CAN BE ANY SHAPE, and spreading it was a latent defect:
       * the approval controls wrote `{ ...(value.approval ?? {}), strength }`, so a
       * project file containing `approval: nope` became
       * `{0:'n',1:'o',2:'p',3:'e',strength:'ask-user'}` — a section the host's validator
       * then refuses, which is at least fail-closed but is not what the user asked for.
       * A non-object section is treated as empty, so the write produces a well-formed
       * section carrying only the field the user just changed.
       *
       * @param key - the top-level section name.
       * @returns the section object, or an empty object.
       */
      const section = key => {
        const raw = value[key]
        return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
      }

      /**
       * Submit one write and settle its verdict into the status line.
       *
       * The discipline lives in the module-level {@link commit}; this binding only fixes
       * the three things this component owns (its message setter, its write stamp, its
       * translator), so the sidebar body that shares `commit` cannot diverge from it.
       *
       * @param submit - thunk performing the write and returning its promise.
       */
      const commitHere = submit => commit(submit, writeToken, setMessage, t)

      /** Write one TOP-LEVEL scalar immediately (`ConfigForm.set`). */
      const write = (field, next) => writeTopLevel(form, field, next, writeToken, setMessage, t)

      /**
       * Write ONE NESTED FIELD immediately (`ConfigForm.mutate`), as a single-key op.
       *
       * The lost-update fix, in one place. A whole-section write built from the value read at
       * RENDER time — `write(section, { ...value[section], key: next })` — meant two clicks on
       * sibling fields inside one host round-trip each spread the same stale section, so the
       * second write reverted the first. Every nested control now goes through this helper,
       * which never reads a sibling: the op names exactly one path.
       *
       * @param section - top-level section name.
       * @param key - the field inside it.
       * @param value - the value the control produced.
       */
      const writeField = (section, key, value) =>
        commitHere(() => form.mutate(fieldOps(section, key, value)))

      /**
       * Submit SEVERAL ops as ONE atomic write.
       *
       * Used only where two fields must agree — dropping a scored dimension while dropping it
       * from the veto set (`readEvaluatorGate` refuses a veto dimension that nothing scores),
       * so the pair cannot be observed apart.
       */
      const writeOps = ops => commitHere(() => form.mutate(ops))

      /**
       * Write one NESTED module switch immediately (`ConfigForm.mutate`).
       *
       * NO `expectedRevision` IS PASSED, and that is the contract rather than an omission.
       * The README's revision rule — "staged editors pass the revision read before editing;
       * conflicts preserve their drafts" — governs STAGED editors, where a draft is held
       * across renders. This page writes on the click, like the controller's own `set`, which
       * calls `mutate` without a revision; the controller then resolves
       * `expectedRevision ?? pendingRevision ?? getSnapshot().revision`. Passing the revision
       * rendered into this row would INVENT a conflict for the ordinary case of two switches
       * clicked in quick succession: the second write would be refused against the revision
       * the first one has just replaced.
       */
      const writeModule = (key, next) => commitHere(() => form.mutate(moduleOps(key, next)))

      /**
       * One labelled control, optionally with a hint line beneath it.
       *
       * A HINT CARRIES ITS OWN COLUMN, and `columnStyle` is what decides which. The panel's
       * template has one column, so a hint that claimed column two there would create that
       * track and starve the label — see {@link panelFieldHintStyle}. The row template is the
       * only input the choice depends on, so the page's rows keep exactly the placement they
       * shipped with.
       */
      const field = (key, control, helpKey) => [
        react.createElement('div', { style: labelStyle, key: `${key}-label` }, t(key)),
        react.createElement('div', {
          key: `${key}-divider`,
          // Not a border on the label or on the control: both sit INSIDE the grid, so a
          // border there is drawn after the label's own text run and only as wide as that
          // cell. This element carries the line across the row instead — it is the label's
          // sibling at `grid-column: 1 / -1`, i.e. above the label it introduces, because
          // the divider belongs between two rows.
          style: {
            gridColumn: '1 / -1',
            height: 0,
            borderTop: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.18))',
          },
        }),
        react.cloneElement(control, { key: `${key}-control` }),
        helpKey
          ? react.createElement(
              'div',
              { style: columnStyle(rowStyle, panelFieldHintStyle, hintStyle), key: `${key}-hint` },
              t(helpKey),
            )
          : null,
      ]

      const children = []

      children.push(
        ...field(
          'tier',
          react.createElement(
            'select',
            {
              style: selectStyle,
              value: value.tier ?? '',
              disabled: !writable,
              onChange: event => write('tier', event.target.value),
            },
            TIER_OPTIONS.map(([v, text]) => react.createElement('option', { key: v, value: v }, text)),
          ),
          'tierHint',
        ),
      )

      children.push(
        ...field(
          'recipe',
          react.createElement(
            'select',
            {
              style: selectStyle,
              value: value.recipe ?? '',
              disabled: !writable,
              onChange: event => write('recipe', event.target.value === '' ? null : event.target.value),
            },
            RECIPE_OPTIONS.map(([v, text]) => react.createElement('option', { key: v, value: v }, text)),
          ),
        ),
      )

      children.push(
        ...field(
          'approvalStrength',
          react.createElement(
            'select',
            {
              style: selectStyle,
              value: value.approval?.strength ?? '',
              disabled: !writable,
              // One nested op, NOT a whole-section spread (`{ ...section('approval'), strength }`).
              // The spread read the section at RENDER time, so clicking this and then the risk
              // threshold inside one host round-trip reverted whichever value was written first.
              onChange: event => writeField('approval', 'strength', event.target.value),
            },
            STRENGTH_OPTIONS.map(([v, text]) => react.createElement('option', { key: v, value: v }, text)),
          ),
          'approvalHint',
        ),
      )

      // THE OFFICIAL WARNING, SHOWN WHEN IT APPLIES. Two cases, and the second was
      // missing: `llm-only`/`off` remove human authorization from gated calls, and a
      // section the host refuses (a non-object, or a value the schema rejects) ALSO ends
      // up removing it — the gate falls back to the fail-closed defaults. A user looking
      // at a blank strength select with no explanation has no way to know either.
      const approvalRaw = value.approval
      const approvalBroken =
        approvalRaw !== undefined &&
        approvalRaw !== null &&
        (typeof approvalRaw !== 'object' || Array.isArray(approvalRaw))
      if (approvalBroken) {
        children.push(
          react.createElement(
            'div',
            { style: columnStyle(rowStyle, panelWarningStyle, warningStyle), key: 'approval-broken' },
            react.createElement('strong', null, t('approvalBroken')),
          ),
        )
      }
      if (approvalBroken || approvalRaw?.strength === 'llm-only' || approvalRaw?.strength === 'off') {
        children.push(
          react.createElement(
            'div',
            { style: columnStyle(rowStyle, panelWarningStyle, warningStyle), key: 'approval-warning' },
            react.createElement('strong', null, t('approvalWarning')),
            ...(Array.isArray(t('approvalWarningEn')) ? t('approvalWarningEn') : []).map((line, index) =>
              react.createElement('div', { key: `approval-warning-en-${index}` }, line),
            ),
            ...(Array.isArray(t('approvalWarningZh')) ? t('approvalWarningZh') : []).map((line, index) =>
              react.createElement('div', { key: `approval-warning-zh-${index}` }, line),
            ),
          ),
        )
      }

      children.push(
        ...field(
          'riskThreshold',
          react.createElement(
            'select',
            {
              style: selectStyle,
              value: value.approval?.riskThreshold ?? '',
              disabled: !writable,
              // Single-key op: see the strength control above (lost update on sibling fields).
              onChange: event => writeField('approval', 'riskThreshold', event.target.value),
            },
            RISK_OPTIONS.map(([v, text]) => react.createElement('option', { key: v, value: v }, text)),
          ),
        ),
      )

      children.push(
        ...field(
          'exemptTools',
          react.createElement('input', {
            type: 'text',
            style: textStyle,
            value: listText(value.approval?.exemptTools),
            disabled: !writable,
            placeholder: 'workflow_status, workflow_gc',
            onChange: event => {
              // `allowEmpty` because the gate's own reader passes it here: "no exemptions" is a
              // coherent choice (`readStringList('approval.exemptTools', …, { allowEmpty: true })`).
              // Every entry is a string, so the mixed-list case is unreachable from a text field.
              writeField('approval', 'exemptTools', listValue(event.target.value, { allowEmpty: true }))
            },
          }),
          'exemptToolsHint',
        ),
      )

      children.push(
        ...field(
          'evaluatorBar',
          react.createElement('input', {
            type: 'number',
            min: 0,
            max: 10,
            step: 0.5,
            style: numberStyle,
            value: value.evaluator?.bar ?? '',
            disabled: !writable,
            onChange: event => {
              const raw = event.target.value
              // Clearing a number input yields `''`, and `Number('')` is 0 — the MOST
              // permissive legal gate, which disables every veto because no score can be
              // below 0. An empty field means "leave it", not "set it to zero".
              //
              // The value is TRIMMED first. `Number('   ')` is also 0, so a
              // whitespace-only field would write the same permissive gate; a number
              // input should not produce that, but a validator that relies on its input
              // widget not producing a value is not a validator.
              //
              // NOTE ON THE "ONE VALIDATOR" CLAIM: this panel does NOT import
              // `lib/gate.js` — a browser bundle cannot pull in a host module. It
              // deliberately mirrors `checkBar` instead: a real number in [0,10]. That
              // mirroring is exact, and `test/status.test.mjs` pins the property rather
              // than leaving it as an assertion in a comment.
              //
              // The `min`/`max` attributes do NOT constrain `onChange`, so the range is
              // enforced here — that was a real defect: out-of-range input used to be
              // written unchecked.
              const trimmed = raw.trim()
              if (trimmed === '') return
              const next = Number(trimmed)
              if (!Number.isFinite(next) || next < 0 || next > 10) return
              // Single-key op: a whole-section write of `evaluator` reverted a sibling
              // `independent` click made inside the same host round-trip.
              writeField('evaluator', 'bar', next)
            },
          }),
          'evaluatorBarHint',
        ),
      )

      children.push(
        ...field(
          'dimensions',
          react.createElement('input', {
            type: 'text',
            style: textStyle,
            value: listText(value.evaluator?.dimensions),
            disabled: !writable,
            placeholder: 'correctness, build, tests',
            onChange: event => {
              // An empty `dimensions` is refused HERE, not by the host: the config schema is
              // `z.array(z.string())`, which accepts `[]`, while `readEvaluatorGate` refuses it —
              // so an empty write would persist a project whose every review fails to grade.
              // Same stance as the pass-mark input: a cleared field means "leave it".
              const next = listValue(event.target.value, { allowEmpty: false })
              if (next === undefined) return
              const current = stringList(value.evaluator?.mustPass)
              const kept = prunedMustPass(current, next)
              if (kept.length === current.length) {
                writeField('evaluator', 'dimensions', next)
                return
              }
              // ONE atomic write: `readEvaluatorGate` refuses a `mustPass` naming a dimension
              // that `dimensions` does not score, so the removed dimension leaves the veto set in
              // the same op list. Writing only `dimensions` would leave a gate that refuses every
              // review, and the panel would be the thing that broke it.
              writeOps([
                ...fieldOps('evaluator', 'dimensions', next),
                ...fieldOps('evaluator', 'mustPass', kept),
              ])
            },
          }),
          'dimensionsHint',
        ),
      )

      // THE VETO SET IS DERIVED FROM THE SCORED SET, never typed independently.
      //
      // `readEvaluatorGate` refuses a gate whose `mustPass` names a dimension `dimensions` does
      // not score, and it refuses a mixed/non-string list outright. A free-text veto field could
      // therefore produce a value the host reader rejects; checkboxes built from the CURRENT
      // `dimensions` cannot. `[]` stays reachable (uncheck everything) because "no veto
      // dimensions" is a coherent, schema-legal choice the reader honours.
      const dimensionNames = stringList(value.evaluator?.dimensions)
      const mustPassValue = stringList(value.evaluator?.mustPass)
      children.push(
        react.createElement(
          'div',
          { style: { ...labelStyle, gridColumn: '1 / -1', marginTop: '6px' }, key: 'mustPass-heading' },
          t('mustPass'),
        ),
        react.createElement(
          'div',
          { style: { ...hintStyle, gridColumn: '1 / -1' }, key: 'mustPass-heading-hint' },
          t('mustPassHint'),
        ),
      )
      if (dimensionNames.length === 0) {
        // A hand-edited `dimensions` can be a string, a mixed list or `[]`. There is then no
        // scored dimension to veto, so the honest render is an explanation, not an empty row of
        // checkboxes that would write a veto set the reader refuses.
        children.push(
          react.createElement(
            'div',
            { style: { ...hintStyle, gridColumn: '1 / -1', marginTop: 0 }, key: 'mustPass-unavailable' },
            t('mustPassUnavailable'),
          ),
        )
      } else {
        for (const name of dimensionNames) {
          children.push(
            react.createElement(
              'div',
              {
                style: { ...labelStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
                key: `mustPass-${name}-label`,
              },
              name,
            ),
            react.createElement('input', {
              key: `mustPass-${name}-control`,
              type: 'checkbox',
              checked: mustPassValue.includes(name),
              disabled: !writable,
              onChange: event =>
                writeField(
                  'evaluator',
                  'mustPass',
                  toggledMustPass(mustPassValue, dimensionNames, name, event.target.checked),
                ),
            }),
          )
        }
      }

      children.push(
        ...field(
          'independentReview',
          react.createElement('input', {
            type: 'checkbox',
            checked: value.evaluator?.independent === true,
            disabled: !writable,
            // Single-key op: see the pass-mark control above (lost update on sibling fields).
            onChange: event => writeField('evaluator', 'independent', event.target.checked),
          }),
          'independentReviewHint',
        ),
      )

      children.push(
        ...field(
          'maxDepth',
          react.createElement(
            'select',
            {
              style: selectStyle,
              value: String(value.subagent?.maxDepth ?? ''),
              disabled: !writable,
              onChange: event => {
                // The `<select>` cannot offer 3, and the guard mirrors `subagent.maxDepth`'s
                // writer rule (an integer in [1, MAX_SUBAGENT_DEPTH]) so a future edit that turns
                // this into a free text field cannot write 3 either.
                const next = intValue(event.target.value, 1, MAX_DEPTH)
                if (next === undefined) return
                writeField('subagent', 'maxDepth', next)
              },
            },
            DEPTH_OPTIONS.map(([v, text]) => react.createElement('option', { key: v, value: v }, text)),
          ),
          'maxDepthHint',
        ),
      )

      children.push(
        ...field(
          'maxActiveSubagents',
          react.createElement('input', {
            type: 'number',
            min: 1,
            step: 1,
            style: numberStyle,
            value: value.subagent?.maxActiveSubagents ?? '',
            disabled: !writable,
            onChange: event => {
              // Mirrors the writer's rule: a positive integer. The host's schema is
              // `z.number()` and would happily persist `-3` or `1.5`.
              const next = intValue(event.target.value, 1)
              if (next === undefined) return
              writeField('subagent', 'maxActiveSubagents', next)
            },
          }),
          'maxActiveSubagentsHint',
        ),
      )

      children.push(
        ...field(
          'retireEnabled',
          react.createElement('input', {
            type: 'checkbox',
            checked: value.retireCheck?.enabled === true,
            disabled: !writable,
            onChange: event => writeField('retireCheck', 'enabled', event.target.checked),
          }),
        ),
      )

      children.push(
        ...field(
          'retireEveryDays',
          react.createElement('input', {
            type: 'number',
            min: 1,
            step: 1,
            style: numberStyle,
            value: value.retireCheck?.everyDays ?? '',
            disabled: !writable,
            onChange: event => {
              // Mirrors `readRetireCheck` / `validateSettingValue`: a whole number of days of 1
              // or more. `'30'`, `0` and `2.5` are configuration errors, not cadences.
              const next = intValue(event.target.value, 1)
              if (next === undefined) return
              writeField('retireCheck', 'everyDays', next)
            },
          }),
          'retireEveryDaysHint',
        ),
      )

      children.push(
        ...field(
          'retireAutoSuggest',
          react.createElement('input', {
            type: 'checkbox',
            checked: value.retireCheck?.autoSuggest === true,
            disabled: !writable,
            onChange: event => writeField('retireCheck', 'autoSuggest', event.target.checked),
          }),
        ),
      )

      children.push(
        ...field(
          'contextIsolation',
          react.createElement('input', {
            type: 'checkbox',
            checked: value.modules?.isolation === true,
            disabled: !writable,
            // Through `writeModule`, NOT `set('modules', { ...})`. `isolation` is also one of
            // the derived rows below, and a whole-section write there would be a LOST UPDATE:
            // click a row and then this control inside the same host round-trip and the row's
            // new value is overwritten by the section this render still holds. One nested op
            // per switch, whichever control the user happened to click.
            onChange: event => writeModule('isolation', event.target.checked),
          }),
          'contextIsolationHint',
        ),
      )

      // MODULE SWITCHES — the highest-value knob `form.set` cannot reach. `modules` is the
      // heart of the tier system, and every switch (here and the dedicated context-isolation
      // row above, which is why `isolation` appears twice) is one atomic nested op. The rows
      // come from the snapshot (`moduleKeys`), never from a list written here, so this section
      // tracks whatever the configuration carries.
      const modulesValue = section('modules')
      const moduleSwitchNames = moduleKeys(modulesValue)
      if (moduleSwitchNames.length > 0) {
        children.push(
          react.createElement(
            'div',
            { style: { ...labelStyle, gridColumn: '1 / -1', marginTop: '6px' }, key: 'modules-heading' },
            t('modulesList'),
          ),
          react.createElement(
            'div',
            { style: { ...hintStyle, gridColumn: '1 / -1' }, key: 'modules-heading-hint' },
            t('modulesListHint'),
          ),
        )
        for (const name of moduleSwitchNames) {
          children.push(
            react.createElement(
              'div',
              {
                style: { ...labelStyle, fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
                key: `module-${name}-label`,
              },
              name,
            ),
            react.createElement('input', {
              key: `module-${name}-control`,
              type: 'checkbox',
              checked: modulesValue[name] === true,
              disabled: !writable,
              onChange: event => writeModule(name, event.target.checked),
            }),
          )
        }
      } else {
        // A hand-edited file can carry no `modules` object at all. Say so rather than render
        // an empty heading for a list that has nothing to switch.
        children.push(
          react.createElement('div', { style: labelStyle, key: 'modules-label' }, t('modulesSummary')),
          react.createElement('div', { style: columnStyle(rowStyle, panelFieldHintStyle, { ...hintStyle, marginTop: 0 }), key: 'modules-value' }, '—'),
        )
      }

      return react.createElement(
        'div',
        { style: { padding: '8px 0', fontSize: '13px' } },
        // The `showInSidebar` switch, rendered on whichever surface is responsible for
        // it. TWO cases, deliberately distinct:
        //   - the sidebar BODY passes `header` explicitly (it holds the panel controller);
        //   - the PANEL row's PAGE renders it here from `props.panelController`, because
        //     that page outlives the sidebar entry it controls — this is the recovery
        //     path for a user who switched the entry off.
        // The CORE row's page receives no panel controller, so it renders no switch and
        // its layout is unchanged.
        props?.header ??
          (panel
            ? sidebarVisibleRow({
                t,
                writable: panelSnapshot?.writable === true,
                checked: panelSnapshot?.value?.showInSidebar !== false,
                onChange: event =>
                  writeTopLevel(panel, 'showInSidebar', event.target.checked, switchToken, setMessage, t),
              })
            : null),
        react.createElement('div', { style: rowStyle }, children.filter(Boolean)),
        !writable ? react.createElement('p', { style: statusStyle }, t('notWritable')) : null,
        // The sidebar body owns its own status line (its `showInSidebar` switch writes
        // through its own stamp) and hands the settled text down as `notice`.
        (props?.notice || message) ? react.createElement('p', { style: statusStyle }, props?.notice || message) : null,
        react.createElement('p', { style: noteStyle }, t('advanced')),
        react.createElement('p', { style: noteStyle }, t('projectNote')),
      )
    }

    /**
     * The sidebar entry's glyph.
     *
     * `dsh-client-ui-sidebar` renders the `sidebar.panellist` component inside its
     * panel button and hands it exactly two props: `size` (16 in the wide column, 18
     * in the collapsed rail) and `active` (whether this entry is the selected panel).
     * The official Plugins entry ignores `active` and renders a themed icon at the
     * requested edge; this one does the same with a bare SVG so the bundle keeps its
     * single `require('react')` and pulls in no icon package. `currentColor` is what
     * makes it follow the button's own hover/selected colour instead of inventing one.
     *
     * @param props - the sidebar's icon share: `{ size, active }`.
     * @returns the icon element.
     */
    function SidebarPanelIcon(props) {
      const size = typeof props?.size === 'number' ? props.size : 18
      return react.createElement(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': 'true',
          focusable: 'false',
        },
        // Three stacked rows with the leading dot of a phase machine, plus a tick that
        // marks the verified step: the shape says "staged work that gets checked".
        react.createElement('circle', { cx: 3.2, cy: 3.4, r: 1.1, key: 'dot-1' }),
        react.createElement('circle', { cx: 3.2, cy: 8, r: 1.1, key: 'dot-2' }),
        react.createElement('circle', { cx: 3.2, cy: 12.6, r: 1.1, key: 'dot-3' }),
        react.createElement('path', { d: 'M6.4 3.4h6.4M6.4 8h6.4M6.4 12.6h3.2', key: 'rows' }),
      )
    }

    // -------------------------------------------------------------------------
    // THE CONVERSATION-PAGE TAB (project scope)
    // -------------------------------------------------------------------------

    const tabSectionStyle = { marginBottom: '28px' }
    const tabHeadingStyle = { fontSize: '13px', fontWeight: 600, margin: '0 0 8px' }
    const tabBodyStyle = { fontSize: '13px', lineHeight: 1.7, margin: 0 }
    const tabNoteStyle = { fontSize: '12px', lineHeight: 1.7, opacity: 0.7, margin: '8px 0 0' }
    const tabMonoStyle = {
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: '12px',
      lineHeight: 1.6,
    }
    const tabBadgeStyle = {
      display: 'inline-block',
      fontSize: '11px',
      lineHeight: 1.6,
      padding: '1px 8px',
      borderRadius: '999px',
      border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.35))',
      color: 'var(--dsw-alias-label-tertiary, #999)',
      marginLeft: '8px',
      verticalAlign: 'middle',
    }
    const tabPreStyle = {
      ...tabMonoStyle,
      margin: '0',
      padding: '12px 14px',
      borderRadius: '6px',
      background: 'var(--dsw-alias-bg-secondary, rgba(127,127,127,0.08))',
      border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.18))',
      whiteSpace: 'pre',
      overflowX: 'auto',
      maxHeight: '360px',
      overflowY: 'auto',
    }
    const tabButtonStyle = {
      fontSize: '12px',
      padding: '4px 10px',
      cursor: 'pointer',
      borderRadius: '4px',
      border: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.35))',
      background: 'transparent',
      color: 'inherit',
    }
    const tabWarningStyle = {
      ...tabBodyStyle,
      padding: '10px 12px',
      borderLeft: '3px solid var(--dsw-alias-border-warning, #d9a03a)',
      background: 'var(--dsw-alias-bg-secondary, rgba(217,160,58,0.08))',
    }

    /**
     * One effective-configuration row: label, value, and the layer it came from.
     *
     * A FLEX ROW rather than a table, because the column that must not collapse is the VALUE
     * (a path like `evaluator.mustPass` is short and a value like a seven-name dimension list is
     * long), and the layer badge has to stay legible on one line at the tab's narrowest width.
     * The badge is {@link tabBadgeStyle} — the same pill the tab already uses for its scope
     * marker — so the two read as one page.
     */
    const configRowStyle = {
      display: 'flex',
      alignItems: 'baseline',
      gap: '10px',
      padding: '4px 0',
      borderTop: '1px solid var(--dsw-alias-border-secondary, rgba(127,127,127,0.14))',
    }
    const configLabelStyle = {
      flex: '0 0 40%',
      minWidth: 0,
      fontSize: '12px',
      color: 'var(--dsw-alias-label-secondary, #666)',
      wordBreak: 'break-word',
    }
    const configValueStyle = {
      flex: '1 1 auto',
      minWidth: 0,
      ...tabMonoStyle,
      wordBreak: 'break-word',
    }
    /** The one-line footnote inside a value cell: the shadowed default, or what the file asked. */
    const configAsideStyle = { fontSize: '11px', opacity: 0.65, marginLeft: '6px' }
    const configLayerBadgeStyle = { ...tabBadgeStyle, marginLeft: 0, flex: '0 0 auto', whiteSpace: 'nowrap' }
    /** The layer badge for a value THIS PROJECT set: the row the user is looking for. */
    const configProjectBadgeStyle = {
      ...configLayerBadgeStyle,
      color: 'var(--dsw-alias-label-primary, #333)',
      borderColor: 'var(--dsw-alias-label-secondary, #888)',
    }
    /** The layer badge for a value the HOST substituted after refusing the section. */
    const configRefusedBadgeStyle = {
      ...configLayerBadgeStyle,
      color: 'var(--dsw-alias-label-warning, #b4791f)',
      borderColor: 'var(--dsw-alias-border-warning, #d9a03a)',
    }

    /**
     * Which badge style and which dictionary key a layer gets.
     *
     * The mapping lives in one place because the two must agree: a row whose badge says
     * "inherited" while its value came from the file is exactly the confusion this page exists
     * to remove, and a `switch` duplicated in the renderer is how one of them drifts.
     *
     * @param source - `'project' | 'inherited' | 'unknown' | 'fail-closed'`.
     * @returns `{ key, style }`.
     */
    function configLayerBadge(source) {
      if (source === 'project') return { key: 'projectLayerProject', style: configProjectBadgeStyle }
      if (source === 'fail-closed') return { key: 'projectLayerFailClosed', style: configRefusedBadgeStyle }
      if (source === 'unknown') return { key: 'projectLayerUnknown', style: configLayerBadgeStyle }
      return { key: 'projectLayerInherited', style: configLayerBadgeStyle }
    }

    /**
     * Read the current session's own `.dsh/workflow.yml` and publish the outcome.
     *
     * WHY THIS READS A FILE INSTEAD OF A CONFIG NAMESPACE: a project's
     * `.dsh/workflow.yml` is NOT a `configForms` namespace. `configForms` serves the
     * Loader ENTRY's configuration, and the entry is the profile's plugin row — one
     * document shared by every project. The project file is a per-directory YAML file
     * the host reads through `probeProject` / `readWorkflowFile`, and its only writer is
     * the `workflow_set` tool. So the tab reaches the file the way any Client plugin
     * reaches a file in a Session: through the Session's own read authority.
     *
     * TWO NESTED GUARDS, because they fail differently:
     *
     *  - NO SERVICE — `ctx.remote.workspaceFiles` is undefined. The bundle declares the
     *    namespace in `inject`, so in a composed deployment this does not happen; when it
     *    does, the tab still renders the path, the scope note and the write instructions,
     *    and `hasReader` is what tells the renderer to say so instead of showing an empty
     *    file.
     *  - NO SESSION — the slot is session-scoped, so `sessionId` is present in practice;
     *    if it is not, there is no filesystem to read and the read is skipped.
     *
     * @param ctx - the browser plugin context.
     * @param sessionId - the Session whose workspace is read.
     * @param setState - the state setter.
     */
    function readProjectWorkflow(ctx, sessionId, setState) {
      let files
      try {
        files = ctx?.get?.('remote.workspaceFiles')
      } catch (error) {
        console.error(`${DIAG} workspaceFiles is not reachable`, error)
        files = undefined
      }
      const read = files === undefined ? undefined : files.read
      if (typeof read !== 'function' || typeof sessionId !== 'string' || sessionId === '') {
        setState({ state: 'no-reader' })
        return
      }

      const controller = typeof AbortController === 'function' ? new AbortController() : undefined
      setState({ state: 'loading' })
      let pending
      try {
        // The argument order is the descriptor's, not a guess:
        // `@deepseek-ai/dsh-api-workspace-files#workspaceFiles/read` declares
        // `[workspaceFileScope (lookup), path (json), range (json)]` plus an optional
        // trailing `AbortSignal` when the caller passes one. `range` is passed as an
        // object rather than omitted because the gateway counts BUSINESS arguments
        // before the signal: `read(sessionId, path, signal)` is three values against two
        // parameters and throws "expected 2 argument(s)".
        pending = read(sessionId, PROJECT_FILE, { limit: PROJECT_FILE_LINES }, controller?.signal)
      } catch (error) {
        setState({ state: 'ready', failure: { error: String(error?.message ?? error) }, hasReader: true })
        return
      }
      Promise.resolve(pending).then(
        result => {
          const outcome = projectFileResult(result)
          if (outcome.state === 'ok') setState({ state: 'ready', file: outcome, hasReader: true })
          else setState({ state: 'ready', failure: outcome, hasReader: true })
        },
        error =>
          setState({ state: 'ready', failure: { error: String(error?.message ?? error) }, hasReader: true }),
      )
      return () => controller?.abort()
    }

    /** One labelled section of the tab, in the conversation page's spacing rhythm. */
    function tabSection(key, heading, children, extra) {
      return react.createElement(
        'section',
        { style: { ...tabSectionStyle, ...extra }, key },
        heading === null ? null : react.createElement('h3', { style: tabHeadingStyle }, heading),
        ...children,
      )
    }

    /**
     * The PROJECT-scope tab body, rendered into `conversation.view`.
     *
     * WHAT IT LEADS WITH. The page's answer is the EFFECTIVE configuration — one row per
     * parameter, each labelled by the layer it came from — because that is the thing neither the
     * raw YAML nor the plugin settings page can tell the user. The raw file, its path, the keys
     * it declares and the "how to change it" block all stay below it: the file is still the
     * authority the values were read from, and a reader who wants to check the page against the
     * document must be able to see the document.
     *
     * IT STILL EDITS NOTHING, and the two layers it DISPLAYS are not the two it may WRITE. The
     * project file has no browser write path at all; the defaults layer is READ through
     * {@link projectDefaultsController} (the same `configForms` controller the settings page
     * edits) and never written here — no `set`, `mutate` or `unset` is called on it. The
     * settings page and the sidebar panel remain the only editors of that layer, and
     * `test/status.test.mjs` asserts the absence of a write path structurally rather than
     * describing it.
     *
     * `sessionId` arrives as the ENTRY's `inject` argument, not as a prop — the slot's
     * owner props carry the view request, and the scope identity is bound by the
     * renderer (`standardKit(host, entry, "session", …)` passes `scopeBinding.key` down
     * as the lookup identity). `renderSlot(..., { only: viewId })` means the body is only
     * ever rendered while its own tab is selected, so there is no `viewId` to re-check.
     */
    function WorkflowTab(props) {
      const t = props?.t ?? (key => zh[key] ?? en[key] ?? key)
      const sessionId = props?.sessionId
      const [state, setState] = react.useState({ state: 'loading' })
      const [revision, setRevision] = react.useState(0)
      // The DEFAULTS layer, read from the settings snapshot of this plugin entry. Its own state
      // is tracked separately from the file's: the file can be readable while the settings
      // document is not served at all, and the page must say which half is missing rather than
      // showing only one of them as if it were the whole answer.
      const [defaults, setDefaults] = react.useState({ state: 'loading', value: null })
      // The MEASURED width of the pane this tab is rendered into, which is what the
      // content column's margins are a fraction of. Measured rather than taken from
      // `window.innerWidth`: the conversation pane is inset by the sidebar and the right
      // rail, so the window is the wrong denominator and the column would sit further
      // left than the page beside it. 0 means "not measured yet", which
      // `conversationContentStyle` turns into the minimum gutter rather than full bleed.
      const hostRef = react.useRef(null)
      const [paneWidth, setPaneWidth] = react.useState(0)

      react.useEffect(() => {
        const node = hostRef.current
        if (node === null || typeof node.getBoundingClientRect !== 'function') return undefined
        const measure = () => setPaneWidth(node.getBoundingClientRect().width)
        measure()
        if (typeof ResizeObserver !== 'function') {
          if (typeof window === 'undefined') return undefined
          window.addEventListener('resize', measure)
          return () => window.removeEventListener('resize', measure)
        }
        const observer = new ResizeObserver(measure)
        observer.observe(node)
        return () => observer.disconnect()
      }, [])

      react.useEffect(() => {
        const abort = readProjectWorkflow(props?.ctx, sessionId, setState)
        return typeof abort === 'function' ? abort : undefined
      }, [props?.ctx, sessionId, revision])

      // SUBSCRIBE, DO NOT POLL: the settings page may be open in another tab of the shell, and a
      // snapshot read once would freeze the defaults layer at whatever it happened to be. The
      // controller is only ever read (`getSnapshot` / `subscribe`) — the tab has no write path.
      react.useEffect(() => {
        const form = projectDefaultsController(props?.ctx)
        if (form === undefined || typeof form.getSnapshot !== 'function') {
          setDefaults({ state: 'unavailable', value: null })
          return undefined
        }
        const publish = () => setDefaults(projectDefaultsState(form.getSnapshot()))
        publish()
        return typeof form.subscribe === 'function' ? form.subscribe(publish) : undefined
      }, [props?.ctx])

      const children = []
      children.push(
        react.createElement(
          'div',
          { key: 'title', style: { fontSize: '16px', fontWeight: 600, margin: '0 0 4px' } },
          t('projectTitle'),
          react.createElement('span', { style: tabBadgeStyle }, t('projectScope')),
        ),
      )
      children.push(
        react.createElement('p', { key: 'file', style: { ...tabMonoStyle, margin: '0 0 20px', opacity: 0.75 } }, PROJECT_FILE),
        react.createElement('p', { key: 'nofallback', style: tabWarningStyle }, t('projectNoFallback')),
      )

      if (state.state === 'loading') {
        children.push(tabSection('loading', null, [react.createElement('p', { style: tabNoteStyle, key: 'l' }, t('projectLoading'))]))
      } else if (state.state === 'ready' && state.file) {
        const file = state.file
        // THE ANSWER FIRST — the effective configuration, before the file it was read from.
        const view = projectConfigView(file, defaults)
        // The dictionary entries are FUNCTIONS, like `namespaceMissing` above, and that is
        // deliberate: the locale service's `t` returns a function value unchanged (it only
        // substitutes `{…}` placeholders into a STRING), and so does this bundle's built-in
        // fallback translator — which would otherwise print the raw template with its
        // placeholders still in it.
        const summary =
          t('projectConfigSummary')(view.counts.project, view.counts.inherited, view.counts.unknown) +
          (view.counts.refused > 0 ? t('projectConfigRefusedCount')(view.counts.refused) : '')
        const config = [
          react.createElement('p', { style: tabBodyStyle, key: 'intro' }, t('projectConfigIntro')),
          react.createElement('p', { style: tabNoteStyle, key: 'legend' }, t('projectConfigLegend')),
          react.createElement('p', { style: { ...tabMonoStyle, marginTop: '8px' }, key: 'summary' }, summary),
        ]
        if (view.defaultsState === 'loading') {
          config.push(react.createElement('p', { style: tabNoteStyle, key: 'd-loading' }, t('projectDefaultsLoading')))
        } else if (view.defaultsState === 'unavailable') {
          config.push(react.createElement('p', { style: tabWarningStyle, key: 'd-missing' }, t('projectDefaultsUnavailable')))
        }
        if (view.problems.length > 0) {
          config.push(
            react.createElement(
              'p',
              { style: tabWarningStyle, key: 'problems' },
              `${t('projectParseProblems')}${view.problems.join('; ')}`,
            ),
          )
        }
        children.push(tabSection('effective', t('projectConfigHeading'), config))

        for (const group of view.sections) {
          const rows = group.rows.map(row => {
            const text = projectRowText(row)
            const badge = configLayerBadge(row.source)
            const value = []
            value.push(
              react.createElement(
                'span',
                { key: 'v', style: text.value === null ? { opacity: 0.7 } : null },
                // AN UNRESOLVED VALUE SAYS SO IN WORDS. Never a plausible-looking number: the
                // whole page is worthless if a guessed default can be mistaken for the one in
                // force.
                text.value === null ? t('projectValueUnknown') : text.value,
              ),
            )
            if (text.asked !== null) {
              value.push(
                react.createElement('span', { key: 'a', style: configAsideStyle }, `${t('projectValueAsked')}${text.asked}`),
              )
            } else if (text.shadow !== null) {
              value.push(
                react.createElement('span', { key: 's', style: configAsideStyle }, `${t('projectValueShadow')}${text.shadow}`),
              )
            } else if (row.source === 'project' && row.previousKnown !== true) {
              value.push(
                react.createElement('span', { key: 'u', style: configAsideStyle }, t('projectValueShadowUnknown')),
              )
            }
            return react.createElement(
              'div',
              { style: configRowStyle, key: `row-${row.dotted}` },
              react.createElement('span', { style: configLabelStyle, key: 'l' }, projectLeafLabel(t, row.dotted, zh.projectLeaves ?? en.projectLeaves)),
              react.createElement('span', { style: configValueStyle, key: 'val' }, value),
              react.createElement('span', { style: badge.style, key: 'b' }, t(badge.key)),
            )
          })
          children.push(
            tabSection(`cfg-${group.key}`, projectSectionLabel(t, group.key, zh.projectSections ?? en.projectSections), [
              ...rows,
              group.note === null
                ? null
                : react.createElement(
                    'p',
                    { style: tabWarningStyle, key: 'note' },
                    `${t(group.note.key)}${group.note.detail.join('; ')}`,
                  ),
            ]),
          )
        }

        const meta = []
        if (file.bytes !== undefined) meta.push(`${file.bytes} ${t('projectBytes')}`)
        if (file.version !== undefined) meta.push(`${t('projectVersion')} ${file.version}`)
        children.push(
          tabSection('path', t('projectPathHeading'), [
            react.createElement('p', { style: { ...tabMonoStyle, margin: 0, wordBreak: 'break-all' }, key: 'p' }, file.path ?? t('projectPathPending')),
          ]),
          tabSection('content', t('projectFileHeading'), [
            react.createElement('pre', { style: tabPreStyle, key: 'pre' }, file.text === '' ? t('projectFileEmpty') : file.text),
            react.createElement('p', { style: tabNoteStyle, key: 'meta' }, `${t('projectSource')} ${file.path ?? PROJECT_FILE}${meta.length ? ' · ' + meta.join(' · ') : ''}`),
            file.eof === true ? null : react.createElement('p', { style: tabNoteStyle, key: 'trunc' }, t('projectTruncated')),
            react.createElement(
              'button',
              {
                type: 'button',
                style: { ...tabButtonStyle, marginTop: '10px' },
                key: 'refresh',
                onClick: () => setRevision(value => value + 1),
              },
              t('projectRefresh'),
            ),
          ]),
        )
        const keys = projectFileKeys(file.text)
        children.push(
          tabSection('keys', t('projectKeys'), [
            react.createElement(
              'p',
              { style: { ...tabMonoStyle, margin: 0 }, key: 'k' },
              keys.length > 0 ? keys.join('  ·  ') : t('projectKeysNone'),
            ),
            // The first line, shown RAW. It is what a reader who opened the file would see
            // first, so it is the cheapest way for the page to be checkable against the
            // document it claims to have read — `firstLine` is also the only place the CR
            // of a CRLF file could reach the screen.
            react.createElement('p', { style: tabNoteStyle, key: 'first' },
              `${PROJECT_FILE}:1  ${firstLine(file.text)}`),
            react.createElement('p', { style: tabNoteStyle, key: 'n' }, t('projectOnlySet')),
          ]),
        )
      } else {
        const failure = projectFailureText(state.failure, state.hasReader !== false, t)
        children.push(
          tabSection('failure', t('projectUnavailableTitle'), [
            react.createElement('p', { style: tabBodyStyle, key: 'f' }, failure),
          ], { borderLeft: 'none' }),
        )
      }

      children.push(
        tabSection('write', t('projectWriteHeading'), [
          react.createElement('p', { style: tabBodyStyle, key: 'b' }, t('projectWriteBody')),
          react.createElement('pre', { style: { ...tabPreStyle, maxHeight: 'none' }, key: 'e' },
            `${t('projectReadExample')}\n${t('projectWriteExample')}\n${t('projectWriteInitExample')}`),
          // THE READ-ONLY ANSWER, STATED AS A CHECKED RESULT. `projectWriteBody` says which
          // path writes the file; this says why no editor is offered HERE, names each
          // candidate namespace and what it returned, and commits to the one shape that is
          // forbidden — passing the plugin-defaults form off as this project's settings.
          // Without it the honest "read-only" answer is indistinguishable from an unfinished
          // tab, which is exactly how it read. (The wording deliberately avoids the names of
          // the default-editing surface, so the scope test's ban on those names stays strict.)
          react.createElement('p', { style: { ...tabNoteStyle, marginTop: '16px' }, key: 'nw-h' },
            react.createElement('strong', null, t('projectNoWriteHeading'))),
          react.createElement('p', { style: tabNoteStyle, key: 'nw-b' }, t('projectNoWriteBody')),
          react.createElement('p', { style: tabNoteStyle, key: 'nw-f' }, t('projectNoWriteFooter')),
        ]),
      )

      return react.createElement(
        'div',
        {
          // The MEASUREMENT host: this element's width IS the pane width the content
          // column insets itself against, so the ref has to sit on the full-width wrapper
          // and not on the (already inset) column inside it.
          ref: hostRef,
          // The tab needs to scroll on its own: the conversation pane scrolls the chat,
          // and a long YAML file inside a non-scrolling column would simply be cut.
          style: { height: '100%', overflowY: 'auto' },
          'data-workflow-tab': VIEW_ID,
        },
        react.createElement('div', { style: conversationContentStyle(paneWidth) }, children),
      )
    }

    /**
     * The sidebar panel BODY: the same page, without the summary branch.
     *
     * The body is the whole reason the sidebar exists — the same `tier` / `recipe` /
     * approval / evaluator / module controls, writing through the same `commit`
     * helpers and the same single-key ops. NOTHING is duplicated: this wrapper only
     * supplies `props.controller` (the CORE row's form, exactly as the settings
     * registration does) and `props.panelController` (the PANEL row's, which owns the
     * one switch this body adds), and deliberately does NOT carry the
     * `view === 'summary'` early return, which belongs to the plugin manager's
     * two-per-row rendering and is meaningless in the sidebar (`props.view` is never set
     * here).
     *
     * ONE DIVERGENCE, and it is the reason this is a wrapper rather than a second
     * registration of `WorkflowCard`: the plugin manager gives the page a wide column,
     * while the sidebar is a narrow one. `gridTemplateColumns: '200px 1fr'` inside
     * ~300px leaves the control column too narrow to use, so the body switches the
     * shared field grid to a single stacked column. The controls themselves are the
     * same objects, so a fix to any control reaches both surfaces.
     */
    function SidebarPanel(props) {
      const t = props?.t ?? (key => zh[key] ?? en[key] ?? key)
      // TWO CONTROLLERS, and they are NOT interchangeable. `props.controller` edits
      // `dsh-workflow-core` — the row whose settings page this form is. `panel` edits
      // `dsh-workflow-panel` — the row that DECLARES `showInSidebar`, and the row
      // `panelVisible` reads at registration time. Each Loader row owns a separate
      // settings document, so a switch that READ one row's value and WROTE the other's
      // would report "saved", change nothing that anything consumes, and leave the
      // sidebar entry standing after the next reload.
      const form = props?.controller ?? resolveForm(props, props?.ctx)
      const panel = props?.panelController
      const [snapshot, setSnapshot] = react.useState(null)
      const [message, setMessage] = react.useState('')
      const writeToken = react.useRef(0)
      // The switch row follows the PANEL row's document; the form below follows the core
      // row's. Two subscriptions, because the two documents settle independently.
      react.useEffect(() => {
        if (!panel || typeof panel.subscribe !== 'function') return undefined
        const publish = () => setSnapshot(panel.getSnapshot())
        publish()
        return panel.subscribe(publish)
      }, [panel])
      const live = snapshot?.status === 'ready' && typeof snapshot.value === 'object' ? snapshot.value : {}
      return react.createElement(
        'div',
        {
          style: {
            padding: '14px 18px 24px',
            // NOT FULL BLEED, and not centred: `maxWidth` keeps the column narrow on a
            // wide window and `marginRight: 'auto'` leaves the slack on the right, so the
            // panel reads as a column like the conversation page beside it rather than as
            // a form stretched across the pane.
            maxWidth: `${PANEL_MAX_WIDTH_PX}px`,
            marginRight: 'auto',
            boxSizing: 'border-box',
            overflowX: 'hidden',
          },
        },
        react.createElement('div', { style: { ...summaryStyle, fontWeight: 600, marginBottom: '6px' } }, t('panelLabel')),
        react.createElement(
          'div',
          { style: { marginTop: 10 } },
          react.createElement(WorkflowCard, {
            ...props,
            t,
            controller: form,
            // NOT forwarded: the body renders the switch itself (above), so handing the
            // panel controller down would draw it a second time inside the form. Only the
            // PANEL ROW's PAGE relies on `props.panelController` inside `WorkflowCard`.
            panelController: undefined,
            // Only the plugin manager's row rendering sets `view`; the sidebar body must
            // never be answerable with the one-line description.
            view: 'page',
            // The one-column geometry. It is a MODULE constant, not an object built here, so
            // the template `columnStyle` compares against and the template the rows are
            // actually placed into are the same string rather than two literals that happen
            // to agree. See `panelRowStyle` for why the column must be `100%`.
            rowStyle: panelRowStyle,
            // The panel row's own switch. Same row for the read and the write, so
            // `panelVisible` sees exactly what this control stores.
            header: sidebarVisibleRow({
              t,
              writable: snapshot?.writable === true,
              checked: live.showInSidebar !== false,
              onChange: event =>
                writeTopLevel(panel, 'showInSidebar', event.target.checked, writeToken, setMessage, t),
            }),
            notice: message,
          }),
        ),
      )
    }

    function apply(ctx) {
      const log = (message, error) => {
        if (typeof console === 'undefined') return
        if (error) console.error(`[dsh-workflow] ${message}`, error)
        else console.info(`[dsh-workflow] ${message}`)
      }

      log('panel bundle loaded; registering settings page')

      try {
        ctx.locale.bind(NS)
        ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-workflow: dictionaries')
      } catch (error) {
        log('locale service unavailable; the page falls back to direct copy', error)
      }

      // One-time namespace census. The plugin manager only resolves the `form`
      // render prop for a namespace the Host actually serves, so when this page
      // shows "namespace missing" this line says which namespaces exist. Reading
      // the shared mirror must never break the page, hence the try/catch and the
      // absence of any `ensure()` (a background read, not a prerequisite).
      try {
        const mirror = ctx.configForms?.describe?.()
        const read = () => {
          const snapshot = mirror?.getSnapshot?.()
          const served = snapshot?.view?.namespaces?.map(row => row.ns) ?? null
          console.info(
            `${DIAG} namespace census: status=${snapshot?.status ?? 'n/a'} ` +
              `serves=${served ? JSON.stringify(served) : '(no view yet)'} wants=${ENTRY_ID}`,
          )
        }
        read()
        mirror?.subscribe?.(read)
      } catch (error) {
        console.error(`${DIAG} namespace census failed`, error)
      }

      // ONE CONFIGURATION PAGE, ON THE CORE ROW — and the ONE-WAY DOOR IS STILL CLOSED.
      //
      // The plugin manager renders a row's configuration page only for a
      // `plugins.row.config` key of the form `<package>#<rowId>`, so a row with no entry
      // there has no page at all. Registering BOTH rows (the earlier shape) gave the same
      // form two entry points on the bundle's page — the duplicate the user asked to have
      // removed — while the reason it was done was real: `showInSidebar` lives in the
      // PANEL row's settings document (the profile patch, a layer the project file cannot
      // override) and `workflow_set` REFUSES a boolean at that path, so the page that
      // opens the switch is the only way back from the off state.
      //
      // THE CHOICE: the CORE row keeps the page. It is the row whose document carries
      // every runtime parameter, and `WorkflowCard` renders under it exactly as before
      // (it always edited the core document, even when it was registered a second time
      // under the panel row's key). The panel row loses only the duplicate form.
      //
      // WHAT KEEPS THE DOOR OPEN: this page is handed the PANEL row's controller too
      // (`panelController` below), and `WorkflowCard` renders `sidebarVisibleRow` from it
      // whenever it is present. The switch therefore sits on the ONE remaining page, and
      // it reads and writes the same document `panelVisible` gates the sidebar entry on.
      // `test/status.test.mjs` fails if the switch and that controller are ever separated
      // again, which is the shape the earlier review found blocking.
      for (const row of [{ rowId: ENTRY_ID, key: 'src-12453345_-dsh-workflow#dsh-workflow-core' }]) {
        ctx.slots.inject('plugins.row.config', function () {
          try {
            return ctx.slots.register(
              {
                name: 'plugins.row.config',
                key: row.key,
                // The `t` seat comes from DECLARING a namespace: the renderer installs
                // it only for entries that carry `locale`, and this registration had
                // none, so the page silently used its built-in dictionaries. Those
                // mirror zh/en correctly today, which is exactly why the omission was
                // invisible — the fix is the same one line the sidebar body needed.
                locale: NS,
                // Hand the CONTROLLER in, not the context. The page's own `form`
                // render prop is a narrowed `{ state, mutate }` view, and reaching the
                // service through `props.ctx` would depend on an undocumented share
                // merge order. Passing the resolved controller keeps the page
                // independent of both.
                //
                // `panelController` is the PANEL row's controller, which carries the two
                // sidebar fields; the page renders its switch from it. This is the ONLY
                // page left, so it is the only surface that can turn the entry back on —
                // see the comment above for why that is not optional.
                inject: () => ({
                  ctx,
                  controller: resolveForm({}, ctx),
                  panelController: panelConfigController(ctx),
                }),
              },
              WorkflowCard,
            )
          } catch (error) {
            log(`plugins.row.config unavailable for ${row.key}`, error)
            return function () {}
          }
        })
      }

      log(`requested plugins.row.config for src-12453345_-dsh-workflow#${ENTRY_ID} only (one page, one form)`)

      // The bound translator. `bind` returns the namespace-bound `t` (it memoizes per
      // namespace), and BOTH label thunks below — the sidebar entry's and the
      // conversation tab's — are resolved by their consumers OUTSIDE any locale context
      // of ours, so the binding has to be captured here rather than reached for as
      // `ctx.locale` from inside the thunk. Bound before the registrations rather than
      // after them: a `const` read above its declaration is a temporal-dead-zone throw,
      // not an undefined label.
      let t = key => zh[key] ?? en[key] ?? key
      try {
        t = ctx.locale.bind(NS)
      } catch (error) {
        log('locale bind unavailable; the sidebar label falls back to direct copy', error)
      }

      // ----------------------------------------------------------------------
      // THE CONVERSATION-PAGE TAB
      // ----------------------------------------------------------------------
      //
      // `ctx.slots.inject` waits for the slot to be DECLARED (the conversation assembly
      // declares `conversation.view` as a session-scoped list child), so a bare
      // `register()` here would be a no-op. The entry's `inject` receives the SESSION
      // ID — the renderer passes `scopeBinding.key` down as the identity argument — and
      // that is what the project-file read is scoped to.
      ctx.slots.inject(VIEW_SLOT, function () {
        try {
          return ctx.slots.register(
            {
              name: 'conversation.view',
              id: VIEW_ID,
              order: VIEW_ORDER,
              // A THUNK, so the tab label follows a locale switch: `viewTabs()` calls
              // `resolveSlotLabel(entry.options.label)`, which invokes a function label.
              label: () => t('viewProject'),
              locale: NS,
              inject: sessionId => ({ ctx, sessionId }),
            },
            WorkflowTab,
          )
        } catch (error) {
          log('conversation.view unavailable; the project tab is not registered', error)
          return function () {}
        }
      })

      log(`requested ${VIEW_SLOT} id="${VIEW_ID}" order=${VIEW_ORDER}`)

      /**
       * The snapshot that owns the two sidebar fields, once the settings service serves
       * it — see {@link panelConfigController}, which is the one definition of "which
       * row carries these fields".
       */
      const panelConfig = () => panelConfigController(ctx)

      // THE SIDEBAR HALF. Registered from this browser half, not from the `panel`
      // package: `dsh-client-modules` attaches a package's browser half to the Loader
      // row whose specifier is the BARE package name, and this bundle's id is that
      // name — so a second bundle would mean a second copy of the whole settings form
      // (two places to fix one lost-update bug), for a switch a config flag already
      // provides.
      //
      // `whileServed` runs `register` once the panel row's namespace is in the shared
      // settings mirror WITH ITS VALUES, and returns the disposer that takes the entry
      // down again. Registering on plugin load instead would read an idle snapshot,
      // where `showInSidebar` is unknown rather than false; `panelVisible` treats
      // unknown as visible on purpose, but the settings document is the honest thing
      // to wait for, and waiting also means a deployment that does not serve the
      // namespace shows no trace of the entry at all.
      ctx.effect(
        () =>
          ctx.configForms.whileServed([PANEL_ENTRY_ID], () => {
            const controller = panelConfig()
            const snapshot = controller?.getSnapshot?.()
            if (!panelVisible(snapshot)) {
              log(`sidebar panel withdrawn: ${PANEL_ENTRY_ID}.showInSidebar is false`)
              return function () {}
            }

            const value =
              snapshot?.value !== null && typeof snapshot?.value === 'object' ? snapshot.value : {}
            const label = () => panelLabel(value.sidebarLabel, t('panelLabel'), PANEL_ID)

            // The sidebar list entry. `id` and `order` are its cell and its sort key
            // (sidebar README: "Add an icon component … with an id, optional order, and
            // a string or locale-aware label").
            const releasePanel = ctx.slots.inject('sidebar.panellist', () =>
              ctx.slots.register(
                {
                  name: 'sidebar.panellist',
                  id: PANEL_ID,
                  order: PANEL_ORDER,
                  label,
                  locale: NS,
                },
                SidebarPanelIcon,
              ),
            )

            // The body that id opens. BOTH registrations share one disposer and one id:
            // the sidebar's own README records that selecting an id with no `main` entry
            // THROWS, so a half-registration here would be a click that breaks the
            // sidebar rather than one that does nothing.
            //
            // `locale: NS` is what installs the `t` seat on the BODY. The renderer adds
            // that seat only for entries that declare a namespace (`if (entry.locale !==
            // undefined) kit['t'] = localeSeat(face, entry.locale)`), and the `main`
            // render call passes no `t` of its own — so without this line `SidebarPanel`
            // would silently fall back to its built-in dictionaries, rendering the whole
            // body in Chinese in an English session and never re-rendering on a locale
            // switch.
            const releaseBody = ctx.slots.inject('main', () =>
              ctx.slots.register(
                {
                  name: 'main',
                  key: PANEL_ID,
                  locale: NS,
                  // TWO controllers, resolved at render time: the CORE row's form (the
                  // same controller the settings page gets) and the PANEL row's, which
                  // owns the switch. See `SidebarPanel`.
                  inject: () => ({
                    ctx,
                    controller: resolveForm({}, ctx),
                    panelController: panelConfig(),
                  }),
                },
                SidebarPanel,
              ),
            )

            log(`registered sidebar.panellist "${PANEL_ID}" and its main body`)
            return () => {
              releasePanel()
              releaseBody()
            }
          }),
        'dsh-workflow: sidebar panel',
      )
    }

    return { apply, inject, NS }
  },
})
