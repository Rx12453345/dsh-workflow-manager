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

- **Phase machine** — `INIT → PLAN → PICK → NEGOTIATE → BUILD → VERIFY → EVALUATE → COMMIT → HANDOFF`, with `BUILD` refused until the project's own sensors pass.
- **Independent review** — `workflow_review` starts a *fresh* subagent that did not write the code, scores declared dimensions, and vetoes on the configured `mustPass` dimensions. A feature is marked complete **only** from a review this session actually ran.
- **Review fingerprinting** — the reviewed files are hashed. Editing them after the review invalidates the approval.
- **Context isolation** — the review round-trip runs inside a delegated child and returns only a summary, so it does not consume the main conversation.
- **Risk-graded approval gate** — `low` passes, `medium` is handled according to the configured strength, `high` is always denied through a monotonic guard that no later listener can flip back to `allow`.
- **The gate is not writable by the session it judges** — a weakening `approval`/`verification` write needs a real user confirmation; a delegated child cannot ask one and refuses. The process keeps the strongest gate it has seen per project, so a direct file edit (or deleting the opt-in file) cannot lower or switch it off until a restart.
- **Constraint ledger with retirement** — constraints are recorded with a `retire_when` condition. The GC only ever suggests; it never auto-retires. A natural-language retirement signal is reported as *needs a human*, never as *satisfied*.
- **Risk-based verification depth** — optionally, a change class (`docs` / `ui` / `logic` / `security`) declares how deep verification must go, and the framework checks the declaration against the files actually changed. A project can declare its own `verification.sources` / `security` / `ui` surfaces, so an external project's ordinary `.js` is not mistaken for a security surface; an unrecognised source stays fail-closed unless the project explicitly sets `allowUnknownSources: true`.

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
| `workflow_status` | Reports phase, effective configuration, resolved verification depth, service availability and host diagnostics. Read-only. | no |
| `workflow_init` | Opts a project in by creating `.dsh/workflow.yml`. Idempotent, atomic. | yes |
| `workflow_set` | Reads or changes one project-level parameter, with path and enum validation. Refuses to write to a project that did not opt in. | yes |
| `workflow_review` | Starts a fresh reviewer subagent for an independent verdict. Takes a change class and `changed_files`/`diff` so the declaration can be *checked* rather than believed. | records a verdict |
| `workflow_advance` | Drives the phase machine. Refuses illegal transitions and names the legal ones. This is the only path that marks a feature complete, and only from a review this session ran. | yes |
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

- **The host half** (`lib/index.js`, `lib/config.js`, `lib/tools.js`, `lib/gc.js`, `lib/review.js`, `lib/approval.js`, `lib/advance.js`, `lib/gate.js`, `lib/work-unit.js`) registers the tools and owns all state.
- **The browser half** is a single hand-written `lib/client.js` — a lazy-CJS bundle loaded through `window.__ModuleLoader__.load({ id, factory })`. It registers both the plugin settings page and the sidebar entry. No official build toolchain is required.
- **State is JSON, narrative is Markdown.** `.dsh/FEATURES.json`, `.dsh/WORKFLOW.json`, `.dsh/CONSTRAINTS.json` are machine-owned; the documents a human reads are separate files.

Architecture, the full design rationale and every first-party source behind these decisions: **[docs/DESIGN.md](docs/DESIGN.md)**.

## Verification status

Honesty about what is proven matters more here than polish, because this project has a documented history of documents claiming things that were not true.

- **Unit suite: 518 tests; in the DSH Windows sandbox 511 pass, 7 skip, 0 fail** — verified with `npm test` (`node run-unit-tests.mjs`). Six of the skips are environment-gated: the sandbox denies a piped child (`EPERM`) and cannot start the Chromium layout browser. The runner detects that and the affected tests skip LOUDLY with a reason; a normal terminal does not set the flag, so those six run there. The seventh skip is the pre-existing Windows-only `SIGTERM` limitation.
- **Mutation testing** is the layer that shows the tests have teeth: seven `mutation-check-*.mjs` harnesses inject defects and require the suite to go red, then restore sources byte-for-byte. They must never be run concurrently — a shared lock refuses the second. They spawn a captured child, so in the DSH sandbox they need a normal terminal or the harness's own sandbox mode.
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
