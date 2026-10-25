# dsh-workflow

A tiered, fully switchable agent-workflow harness for [DeepSeek Harness](https://github.com/deepseek-ai) (DSH). It turns the core Harness-Engineering mechanisms — context isolation, independent review, risk-graded approval, constraint retirement — into **a block of configuration**, so "adapt the process to this task" becomes a config change instead of a prompt.

> **Design constitution: humans are lazy.**
> Every mechanism can be turned off in one sentence. The defaults run without configuration. The places that need a human decision are as few as possible, and they are the ones that genuinely need judgement.

---

## Why this exists

Long-running agent work fails in ways that extra prompting does not fix:

- **Context pollution.** Reviewer round-trips are long and mostly irrelevant to the task; when they happen in the main conversation, the signal drowns.
- **Self-certification.** An agent that graded its own work always passes. Anthropic's harness research is explicit that a self-evaluating generator is "grading its own homework".
- **Unbounded harness.** Constraints accumulate forever. Mitchell Hashimoto's rule — *when the agent makes a mistake, change the system so it cannot make that mistake again* — produces a system that only grows unless every constraint carries a retirement condition.
- **Uniform rigour.** Re-running the full review loop for a one-line CSS change, at the same cost as for an approval-gate rewrite, is how process gets abandoned.

`dsh-workflow` packages the fixes for those four as switchable mechanisms, plus a phase machine and an artifact contract that make "verified" mean something a claim cannot fake.

**This plugin is inert until a project opts in.** It activates for a project only when that project contains `.dsh/workflow.yml`. Installing it does not change the behaviour of any existing conversation.

## What it does

- **Phase machine** — `INIT → PLAN → PICK → NEGOTIATE → BUILD → VERIFY → EVALUATE → COMMIT → HANDOFF`, with `BUILD` refused until the project's own sensors pass, and `HANDOFF` refused while any feature is still open (an explicit, reasoned `waive_open_features` + `waiver_reason` is the only way past it, and it is recorded in the state). With `recipe: docs` the machine may go `BUILD → EVALUATE` directly and skip `VERIFY` — that is the only edge the recipe adds, and no recipe adds `BUILD → COMMIT`; a feature is marked complete only from a review this session actually ran, while `COMMIT` itself is not review-gated (`VERIFY → COMMIT` exists).
- **Independent review** — `workflow_review` starts a *fresh* subagent that did not write the code, scores declared dimensions, and vetoes on the configured `mustPass` dimensions. A feature is marked complete **only** from a review this session actually ran. The author is told to run `git status --porcelain` before review, and the reviewer is told to run it and report any changed path the author's list omitted. The framework also reconciles the declaration with `git status` on its own (`lib/git-changes.js`) and folds an omitted path into the evidence — **evidence, not a security boundary**, because `git status` sees only uncommitted changes and a committed path must still be declared.
- **A review cannot destroy the project it reviews** — before the reviewer starts, the project is snapshotted into an isolated temp root as a **real copy** (never a link), and the reviewer is pointed at that copy. When the child finishes, the real project is re-scanned against the snapshot: deletions are **restored byte-for-byte**, modifications and additions are reported rather than reverted (a concurrent human edit is not the reviewer's doing), and any difference makes the review **contaminated — it cannot pass at any score**. The copy is deleted only through guards a junction cannot satisfy (native realpath containment, a pre-delete link scan, a snapshot marker, and a canary outside the copy). If a snapshot cannot be built, **no reviewer starts**. This exists because a reviewer once created a junction to the workspace and emptied it with a recursive delete; see [`docs/PITFALLS.md`](docs/PITFALLS.md).
- **Governance and a docs fast lane** — `HANDOFF` is refused while features are still open; the only way past is an explicit `waive_open_features` with a non-empty `waiver_reason`, recorded in the state, and a waiver never waives a review. The `docs` recipe adds exactly one edge, `BUILD → EVALUATE` (skipping `VERIFY`); no recipe adds `BUILD → COMMIT`. When the project is a git checkout, the declared `changed_files` is cross-checked against `git status` with argument arrays (never a shell) for **uncommitted working-tree changes**: a path git reports and the declaration omits is **added to the evidence**, so within that working tree a subset cannot buy a shallower class — a committed part of the change is not visible to `git status` and must still be declared. The omission is reported in the verdict, the reviewer's prompt, and a bounded `git_cross_check` summary persisted in the `FEATURES.json` evidence row.
- **Review fingerprinting that is rechecked** — the reviewed files are hashed. Editing them after the review invalidates the approval, and `workflow_status` reports `fresh` / `stale` / `unknown`; `COMMIT`/`HANDOFF` refuse a stale PASS for any reviewed feature. **Line endings are not content**: text is folded to LF (`lib/eol.js`) before hashing, so a CRLF checkout is not a false STALE while a real edit still changes the digest; binary files are hashed byte-exactly. A reviewer child that stops with `aborted`/`error` gets one bounded retry, with `attempts`/`stopReason` reported.
- **Context isolation** — the review round-trip runs inside a delegated child and returns only a summary, so it does not consume the main conversation.
- **Risk-graded approval gate** — `low` passes, `medium` is handled according to the configured strength, `high` is always denied through a monotonic guard that no later listener can flip back to `allow`.
- **The gate is not writable by the session it judges** — a weakening `approval`/`verification` write needs a real user confirmation; a delegated child cannot ask one and refuses. The process keeps the strongest gate it has seen per project, so a direct file edit (or deleting the opt-in file) cannot lower or switch it off until a restart.
- **Constraint ledger with retirement** — constraints are recorded with a `retire_when` condition. The GC only ever suggests; it never auto-retires. A natural-language retirement signal is reported as *needs a human*, never as *satisfied*.
- **Risk-based verification depth** — optionally, a change class (`docs` / `ui` / `logic` / `security`) declares how deep verification must go, and the framework checks the declaration against the files actually changed. A project can declare its own `verification.sources` / `security` / `ui` surfaces, so an external project's ordinary `.js` is not mistaken for a security surface; an unrecognised source stays fail-closed unless the project explicitly sets `allowUnknownSources: true`. A data tree that is not executable can be listed under `verification.nonExecutable` (e.g. `data/**`): matching **non-code** files are graded `docs`, while a security/UI surface still wins and a `.js` under that tree is still not data.

## Install

The plugin is developed in a workspace, but the DSH profile lives outside it, so installation is manual.

1. Add the dependency to the profile's `package.json` — **use the directory path, not a tarball**, so code changes need no repackaging:

   ```json
   "src-12453345_-dsh-workflow": "file:<absolute-path-to-plugin-checkout>"
   ```

2. Add the package name to the profile's `bundles` array, alongside the other bundles.

3. Install from the profile directory, then restart DSH:

   ```powershell
   cd <profile>
   pnpm install
   ```

The plugin's `cordis.patch.yml` is appended by the loader automatically; nothing needs to be added to the profile's patch by hand.

`file:` dependencies are **copies, not symlinks** — after editing plugin code you must re-copy and restart. See [docs/USAGE.md](docs/USAGE.md#developing-the-plugin-itself).

### What you should see after installing

The plugin mounts **three** Loader rows, each independently switchable:

| Row | Package | Job |
|---|---|---|
| `dsh-workflow-module` | `src-12453345_-dsh-workflow` | Declaration only. Exists so the browser half is discoverable — see [docs/PITFALLS.md](docs/PITFALLS.md#a-slash-in-a-loader-entry-name-drops-the-browser-half-silently). |
| `dsh-workflow-core` | `src-12453345_-dsh-workflow/core` | The six model-facing tools, the phase machine, the approval gate. |
| `dsh-workflow-panel` | `src-12453345_-dsh-workflow/panel` | Owns the panel namespace and the sidebar entry. |

The host log line `dsh-workflow: core mounted. services: tools=yes, systemPrompt=yes, subagent=yes, settings=yes, approval=yes` confirms the mount.

## Quick start

In a project where you want the workflow:

1. **Opt the project in.** Ask the model to initialise the workflow, or call `workflow_init`. That creates `.dsh/workflow.yml`. Nothing happens in this project until that file exists.
2. **Ask for the work normally.** There is no need to say "use the workflow" — the model sees the project is opted in.
3. **Ask for independent verification.** The only property that matters: whoever did the work cannot declare it done.
4. **Look at the project tab** (「工作流（本工程）」) to see the values *actually in effect* for this project, and which of them are project overrides versus inherited defaults.

The full walkthrough, the three surfaces and the FAQ are in **[docs/USAGE.md](docs/USAGE.md)**.

## The six tools

| Tool | What it does | Writes? |
|---|---|---|
| `workflow_status` | Reports phase, feature counts and the open feature list, effective configuration, resolved verification depth, service availability and host diagnostics. Read-only. | no |
| `workflow_init` | Opts a project in by creating `.dsh/workflow.yml`. Idempotent, atomic. | yes |
| `workflow_set` | Reads or changes one project-level parameter, with path and enum validation. Refuses to write to a project that did not opt in. | yes |
| `workflow_review` | Starts a fresh reviewer subagent for an independent verdict. Takes a change class and `changed_files`/`diff` so the declaration can be *checked* rather than believed; a git checkout is consulted, and omitted changed paths are added to the evidence. | records a verdict |
| `workflow_advance` | Drives the phase machine. Refuses illegal transitions and names the legal ones, per recipe. This is the only path that marks a feature complete, and only from a review this session ran; `HANDOFF` needs the features finished or an explicit recorded waiver. | yes |
| `workflow_gc` | Constraint ledger: shows which constraints are due for retirement. Only `scope=constraints` is implemented; the other scopes **refuse** rather than pretend. | asks first |

## Architecture in brief

```
config (defaults) ──► project `.dsh/workflow.yml` ──► per-call arguments
                              │
                              ▼
                    phase machine (lib/advance.js)
                              │
        ┌─────────────────────┼──────────────────────┐
        ▼                     ▼                      ▼
  artifact contract     independent review     approval gate
  (features / state)    (fresh subagent)       (pre-execute)
```

- **The host half** (`lib/index.js`, `lib/config.js`, `lib/tools.js`, `lib/gc.js`, `lib/review.js`, `lib/approval.js`, `lib/advance.js`, `lib/gate.js`, `lib/work-unit.js`, `lib/git-changes.js`) registers the tools and owns all state.
- **The browser half** is a single hand-written `lib/client.js` — a lazy-CJS bundle loaded through `window.__ModuleLoader__.load({ id, factory })`. It registers both the plugin settings page and the sidebar entry. No official build toolchain is required.
- **State is JSON, narrative is Markdown.** `.dsh/FEATURES.json`, `.dsh/WORKFLOW.json`, `.dsh/CONSTRAINTS.json` are machine-owned; the documents a human reads are separate files.

Architecture, the full design rationale and every first-party source behind these decisions: **[docs/DESIGN.md](docs/DESIGN.md)**.

## Verification status

Honesty about what is proven matters more here than polish, because this project has a documented history of documents claiming things that were not true.

- **Zero failures is the bar** — run `npm test` (`node run-unit-tests.mjs`) in the environment you are
  judging; this page does not restate today's pass count. The skips are environment-gated, not
  failures: the Windows-only `SIGTERM` case always skips, and the DSH sandbox adds the cases that need a
  piped child (`EPERM`) or the Chromium layout browser. The runner detects the sandbox and the affected
  tests skip LOUDLY with a reason — **they are NOT RUN, which is not the same as passing**. In a normal
  terminal with a Chromium-family browser only the `SIGTERM` case skips; without one the layout case
  skips too. **The failure count is the number that must be zero; the totals drift as work lands, so
  they are not restated here.**
- **Mutation testing** is the layer that shows the tests have teeth: the mutation harnesses inject defects and require the suite to go red, then restore sources byte-for-byte (the governance harness instead runs every mutant in a throwaway copy, so no mutant is ever written into the canonical `lib/`; it still takes the shared lock and verifies `lib/tools.js` and `lib/advance.js` byte-for-byte). They must never be run concurrently — a shared lock refuses the second. They capture their child's output through temp files (`tooling/child-output.mjs`), not a pipe, so the constraints, approval, governance, verification and work-unit harnesses run **inside the DSH Windows sandbox**. The settings-page, panel and project-tab harnesses additionally run the Chromium layout test; the sandbox cannot launch that browser, so an in-sandbox run of those three hits an environment failure — not a caught mutant — and they need a normal terminal. The separate lock probe (`tooling/mutation-check-lock-probe.mjs`) is the one harness that refuses to answer in-sandbox: it prints `NOT RUN` and exits **2** without `DSH_WORKFLOW_SANDBOX=1`, and exit 2 is documented as not a pass.
- **This tree was reconstructed on 2026-10-25, not restored from git.** A `workflow_review` reviewer created a directory junction to the workspace and ran a recursive delete; it took git history, the `.dsh` state and the uncommitted work. The checkout was rebuilt by decompressing the 57 workspace session logs and replaying every successful `write`/`edit` onto the 0.2.0 tree between the 0.2.0 commit and the incident, with CRLF normalised first, and the P0 review-isolation patch merged back with `git apply --3way`. **That is reconstruction by evidence, not a byte-for-byte git restore.** The full inventory, the verbatim P3-1 probe results and the corrected handoff facts are in [docs/RECOVERY.md](docs/RECOVERY.md); the junction facts are in [docs/PITFALLS.md](docs/PITFALLS.md).
- **`verification.policy` defaults to `off`.** The feature does nothing until it is enabled; the report is informational only. Do not read the class/depth table as active behaviour.
- **Deployment cannot be completed by an agent on its own.** `sync-to-profile.mjs` is still refused as an opaque script, and the self-deployment exemption — which covers file tools carrying explicit paths — cannot authorise its own **first** deployment, because the copy that is running predates the exemption. A first deployment needs an out-of-band copy performed by a human, or by a session the gate does not govern.

The unverified and deliberately-unimplemented items are listed in **[docs/ROADMAP.md](docs/ROADMAP.md)** rather than implied to work.

## Documentation

Each document has exactly one job.

| Document | Job |
|---|---|
| [docs/GETTING-STARTED.zh-CN.md](docs/GETTING-STARTED.zh-CN.md) | **中文入门指南.** For someone who does not configure software: two sentences to remember, what to say for each kind of project, and what to do when it feels slow. |
| [docs/USAGE.md](docs/USAGE.md) | **For users.** The four-step start, the three surfaces, the nine phases, the FAQ. |
| [docs/DESIGN.md](docs/DESIGN.md) | **Why it is built this way.** Design decisions and the first-party sources behind them. |
| [docs/PITFALLS.md](docs/PITFALLS.md) | **What went wrong.** Every hard-won trap, with the root cause and the fix. |
| [docs/RECOVERY.md](docs/RECOVERY.md) | **How this tree was rebuilt.** The 2026-10-25 incident, the replay method, the corrected handoff facts and what remains unverified. |
| [docs/TESTING.md](docs/TESTING.md) | **How to verify a change.** The six verification layers and the depth policy. |
| [docs/ROADMAP.md](docs/ROADMAP.md) | **What is not done.** Unverified items, deliberate non-implementations, known debts. |
| [CHANGELOG.md](CHANGELOG.md) | User-visible changes, newest first. |
| [CONTRIBUTING.md](CONTRIBUTING.md) | What must run before a change is considered done. |

---

## Development

```powershell
cd <plugin-checkout>

npm test                                   # the full unit suite; auto-detects the DSH sandbox
npm run test:sandbox                       # force sandbox mode (environment tests skip with a reason)
node run-smoke-test.mjs                    # full apply/execute/render chain on a fake ctx
node run-config-check.mjs                  # patch values vs code defaults
$env:DSH_TOOLS_BUNDLE = '<extracted>/dsh-tools/lib/index.js'; node tooling/validate-tool-definition.mjs
$env:DSH_CLIENT_MODULES_BUNDLE = '<extracted>/dsh-client-modules/lib/index.js'; node tooling/simulate-client-scan.mjs
```

Before you consider a change done, read **[CONTRIBUTING.md](CONTRIBUTING.md)**. The short version: a test that cannot be made to go red is not a test, and "the suite is green" has never once been enough to conclude that the plugin works.

## Licence

[MIT](LICENSE).
