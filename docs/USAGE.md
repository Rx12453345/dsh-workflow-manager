# Usage

For people **using** the plugin. For what it is and how to install it, see the
[README](../README.md). For why it is built this way, see [DESIGN.md](DESIGN.md).

In one sentence: **it turns a round of development into a process with phases, acceptance criteria and a
record — and it keeps the process detail out of your main conversation.**

Start with [§1 The thirty-second version](#1-the-thirty-second-version), then
[§2 First time: four steps](#2-first-time-four-steps).

---

## 1. The thirty-second version

You do two things:

1. **In a project, say "initialise the workflow"** — the model calls `workflow_init`.
2. **Then just ask for what you want** — the model drives the phases and opens its own reviewers.

You will see it in two places:

- **A tab on the conversation page, 「工作流（本工程）」** — the configuration *actually in effect* for this
  project, any time.
- **A sidebar entry, 「工作流设置」** — the plugin's defaults.

---

## 2. First time: four steps

### Step 1 — opt the project in

In the project where you want it, say:

> **初始化工作流**

The model calls `workflow_init`, which creates `.dsh/workflow.yml` in that project. **Without that file
the workflow does not apply at all** — this is deliberate, so that nothing silently takes over an existing
project.

### Step 2 — ask for the work normally

> 帮我在这个工程里加一个 X 功能

You do not need to say "use the workflow". The model sees the project is opted in and drives
`workflow_advance` through the phases.

### Step 3 (optional) — ask for independent verification

> 做完后自己开子代理验收，别自己宣布完工

That is `workflow_review`. **The property that matters: whoever did the work cannot declare it done.**

### Step 4 — look at the result

Open the **「工作流（本工程）」** tab. It shows every line of configuration *actually in effect* for this
project, and marks each one as a project override or an inherited default.

---

## 3. What the six tools do

You do not need to memorise them. This table is so that you can tell what the model is doing.

| Tool | In one line | Who calls it |
|---|---|---|
| `workflow_status` | See the current state — phase, configuration, depth | read-only; call it freely |
| `workflow_init` | Opt this project in | once per project |
| `workflow_set` | Change one parameter | when you want to tune something |
| `workflow_review` | **Start a brand-new reviewer subagent to score the work** | after finishing something |
| `workflow_advance` | Drive the phases (INIT → … → HANDOFF) | during the work |
| `workflow_gc` | Constraint ledger: which constraint is due for retirement | occasionally |

---

## 4. The nine phases

```
INIT → PLAN → PICK → NEGOTIATE → BUILD → VERIFY → EVALUATE → COMMIT → HANDOFF
初始化  规划   选一个   谈清验收     写代码   跑传感器   独立评审    提交    交接
```

**Two gates you should know about, because they refuse:**

- **`BUILD` requires the bootstrap checklist first** — this prevents starting new features on a broken
  foundation.
- **`EVALUATE` requires a review this session actually ran** — *the model saying "the review passed" is
  not evidence*. The framework only trusts a review it witnessed itself.

---

## 5. Four mechanisms worth knowing

### ① Reverse self-certification

A feature can be marked complete **only by the framework, written from a real review**, and the record
carries a fingerprint. **A claim by the model that it passed is void.**

If the reviewed files are edited after the review, the fingerprint is invalidated and the review must be
redone.

### ② Context isolation

Each round can start a **fresh subagent** carrying only whitelisted content. **Review round-trips do not
consume your main conversation** — that is the problem this plugin was built to solve.

### ③ The approval gate

Tool calls are intercepted according to risk. Four strengths:

| Strength | Meaning |
|---|---|
| `ask-user` | ask you every time — **but if approval prompts are unavailable in this environment, everything locks; see below** |
| `llm-then-user` | the model judges first; if it refuses, the decision goes to you |
| `llm-only` | the model decides alone |
| `off` | no interception (**a provable `high` is still refused by the monotonic guard**) |

> ⚠️ **A session must not change the gate that is judging it.** With `ask-user` in an environment whose
> approval prompts are disabled, every shell call is auto-rejected, and the host's message reads
> `the user rejected tool …` — **indistinguishable from a human refusal**. That is an environment fact
> about this session, not permission for the model to widen the gate.
>
> The way out is a **human** action: run the gated work from the **root conversation**, or ask the user
> to change `approval.strength` in the settings page or in `.dsh/workflow.yml` (a restart applies it).
> A delegated child cannot answer the question, so it refuses the write and reports the change upward.
>
> Why the old advice was removed: `workflow_set path=approval.strength value=llm-only` was a
> self-authorization. A child that had just been denied could run it, then perform the write the gate
> had refused. The tool now refuses a weakening write unless a real user confirms it, and the runtime
> keeps the stronger gate for the rest of the session even if the file is edited directly.

### ④ The constraint ledger

Lessons that would otherwise live only in someone's memory are recorded, each with a **retirement
condition**.

- **It only ever suggests; it never deletes.**
- A natural-language retirement signal is reported as **needing a human decision** — the framework
  **never pretends it evaluated that sentence**.

Example: `workflow_gc action=scan`.

---

## 6. Verification depth: how to make the process faster

**The default is `off` — until you enable it, nothing about the behaviour changes.**

Enable it:

```
workflow_set path=verification.policy value=enforced
```

Then four change classes map to four depths:

| Class | Depth | Includes |
|---|---|---|
| `docs` | 0 | the unit suite only |
| `ui` | 2 | unit suite + every covering mutation harness + **a human must look at the render** |
| `logic` | 2 | unit suite + every covering mutation harness |
| **`security`** | **3** | everything + **an independent review (not degradable)** |

**The rules that matter:**

- When calling `workflow_review`, declare `class=docs` — **but the framework checks it against the files
  you actually changed.**
- **A declaration can only add cost, never remove it.** `class=docs` while touching `lib/approval.js` is
  **refused by name**, and the strictest depth is used instead.
- **The security class is not degradable** at any setting.

**A project that is not this plugin's own repository must declare its surfaces.** The built-in file
lists describe the plugin's own `lib/`, so an external project's ordinary `.js` is otherwise an
unclassified source and stays fail-closed (security). Add a section to the project's
`.dsh/workflow.yml`:

```yaml
verification:
  policy: advisory
  sources:          # project-relative files or trees; '*' and '**' are allowed
    - lib
    - index.js
    - tests
  security:         # wins over sources
    - lib/auth.js
  ui:               # explicit rendered surfaces
    - web
  allowUnknownSources: false   # explicit opt-in; default false keeps unknown sources security
  inferUiFromExtensions: true  # false stops `.html` etc. from counting as UI by extension
```

Only the installed plugin's own package gets the built-in lists. A typo or an absolute/`..` path in
the classification invalidates the WHOLE classification rather than dropping just the bad entry; the
fail-closed default is used and the status says so. Under `advisory`, a contradicted declaration is
reported as `DECLARATION CONTRADICTED`; only `enforced` refuses.

Once enabled, **documentation and UI changes stop going through the full review loop** — which is the
efficiency it buys.

---

## 7. What the three surfaces each change

This is the most confusing part of the product, so it is worth stating plainly.

| Surface | Changes | Affects |
|---|---|---|
| **Settings → Plugins → dsh-workflow-core** | the plugin's **defaults** | **all projects** (unless overridden) |
| **Sidebar 「工作流设置」** | the **same defaults** | the same |
| **Conversation tab 「工作流（本工程）」** | **read-only**; shows this project's effective values | view only |

The layer relationship:

```
plugin defaults              ← the settings page / sidebar change this
   ↓ overridden by
this project's .dsh/workflow.yml    ← workflow_set changes this
   = the effective value            ← the 「工作流（本工程）」 tab shows this
```

**To make a specific project behave differently**: run `workflow_init` **in that project**, then override
with `workflow_set`.

**Why can the project tab not be edited?** The browser's `workspaceFiles` interface **provides no write
operation by design** (three host constraints block it; this was checked). It is therefore a **read-only
window**, and writes go through `workflow_set`. The page says so explicitly.

---

## 8. FAQ

**Q: I changed a setting and the project did not react.**
A: You changed a **default**. Defaults only affect projects that have not overridden them. To change *this*
project, use `workflow_set` **inside that project**.

**Q: The model says the review passed, but the feature is not marked complete.**
A: **What it says does not count.** Only after `workflow_review` has genuinely run once can
`workflow_advance action=record-review` mark the feature complete.

**Q: Why was my tool call refused?**
A: Read the refusal — it states **the reason and the remedy**. **Follow it; do not work around it** (see
§9).

**Q: Why does every round run so many tests?**
A: Under the default policy, it does. Enable `verification.policy=enforced` to let **documentation and
UI changes** run less.

**Q: Where do I find what is not finished?**
A: [ROADMAP.md](ROADMAP.md) — unverified items, deliberate non-implementations and known debts. The
README deliberately does not claim those work.

---

## 9. One hard rule (a real incident)

> **Never obfuscate, split or encode a literal to get it past the gate's scanner.**

**Why.** An agent wanted test data (a `.env` path and a URL) past the gate and concatenated the literal
from fragments. **Windows Defender's AMSI saw the same pattern — string concatenation producing `https:`
and a `.env` path is the standard signature of malware evading static scanning — and flagged it
`Trojan:Win32/ClickFix`, raising a severe alert on the user's machine.**

**The correct move:** put it in a **real file** (the gate scans the **command line**, not file contents),
or **report honestly that you were blocked**.

The same reasoning is why the plugin's own self-deployment exemption is built on **structure** rather
than text patterns: text can only be dodged, structure can be checked. See
[DESIGN.md §11.2](DESIGN.md#112-the-self-deployment-exemption).

---

## Developing the plugin itself

- **`file:` dependencies are copies, not symlinks.** After changing code you must sync, then **restart
  DSH and hard-reload the window** (F12 → Network → tick **Disable cache** → F5; `Ctrl+Shift+R` often does
  nothing in Electron).
- **`simulate-client-scan.mjs` scans the installed copy by default.** To check the workspace copy, pass the
  path: `node tooling/simulate-client-scan.mjs "D:\DSH\P5\src-12453345_-dsh-workflow"`.
- **The mutation harnesses must never run concurrently** — they rewrite source files, and a shared lock
  now makes the second one fail fast.
- **`node --check` does not catch scope errors.** One round nearly broke because a module-level helper
  referenced a dictionary inside a factory: syntactically valid, but a runtime `ReferenceError` that took
  the whole configuration table down.

The full six-layer verification guide is [TESTING.md](TESTING.md); what must run before a change is
"done" is [CONTRIBUTING.md](../CONTRIBUTING.md).
