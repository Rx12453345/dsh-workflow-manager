# Testing

The six verification layers, ordered **from cheapest to most expensive**. Each layer states what it can
catch and — more importantly — **what it cannot**. This document exists because several rounds in this
project's history had "the suite is green" and "it actually works" as two different things.

Working directory throughout: `<plugin-checkout>` (referred to below as `<plugin>`).
What must run before a change is considered done is [CONTRIBUTING.md](../CONTRIBUTING.md); the traps each
layer guards against are in [PITFALLS.md](PITFALLS.md).

> **A field's test for any new report value: was this number computed, or copied?** A report that prints a
> figure it never calculated is the failure mode these layers exist to prevent.

---

## 0. Environment prerequisites

```powershell
cd <plugin>
node tooling/sync-to-profile.mjs          # the host half must be synced; file: deps are copies, not symlinks
node tooling/sync-to-profile.mjs --check  # expect 0 differ
```

Then **restart DSH** (host half) and **hard-reload the window** (browser half):
F12 → Network → tick **Disable cache** → F5. `Ctrl+Shift+R` often does nothing in Electron.

### 0.1 The first sync must be done by a human — after that it is not needed

**This was confirmed by measurement, not assumed.** The gate refuses to let an agent write `lib/` into the
profile, on the grounds that it is:

> "writing into the *agent's own installed plugin directory*, overwriting the **runtime files of the agent
> being governed** … this is a modification of a security control … **the script's own comments show it is
> deliberately routing around a refusal on the same module**."

**It refuses correctly** — a security control preventing modification of itself is a design feature, not a
defect. But it creates a real **treadmill: the gate blocked its own repair and its own deployment.**

**The current disposition** is a built-in self-deployment exemption (`lib/approval.js`, the
`selfDeployment` branch). Its scope is determined **by structure, not by text patterns**:

```
anchor      = the package directory this module was itself loaded from
              (derived from import.meta.url; not a configuration item; no switch can point elsewhere)
it covers   : non-shell calls + no command or script body + at least one "destination" argument
              + every destination resolves inside that package directory
              + every source is inside the session project
it refuses  : any shell/exec, any run_code or script body, any call whose destination cannot be read
```

> **The exemption is structural on purpose**: a text-pattern rule can only be satisfied by **hiding or
> splitting a literal**, and a legitimate deployer must never be pushed into that. This is the lesson of
> the Defender incident (see [PITFALLS.md](PITFALLS.md) and §9 of [USAGE.md](USAGE.md#9-one-hard-rule-a-real-incident)).

### 0.2 It still cannot authorise its own first deployment

The copy running the gate is the **old copy in the profile** (`file:` is a copy, not a symlink). So:

**This one time, an out-of-band execution is still required** — you, or any terminal not governed by this
gate:

```powershell
cd <plugin>
node tooling/sync-to-profile.mjs --check   # read-only; look at the exact diff first
node tooling/sync-to-profile.mjs           # full sync
```

Then **restart DSH**. **After that the loop is closed**: the exemption authorises subsequent deployments
and leaves an audit record.

> **Never copy only some of the files.**
> `lib/tools.js` depends on `lib/work-unit.js`; **omitting the latter makes `tools.js` fail at import and
> the plugin's entire tool surface disappears.** Either sync everything or sync nothing.

### 0.3 A fragile corner: whole-file `write` deployment of `approval.js`

`approval.js`'s own body contains both trigger literals. **When both words fall inside the 20 000-character
scan window the call is judged `high`** — and that is the first, guard-enforced rule the exemption must not
weaken.

The two words currently fall at characters **20119** and **20837** of the JSON, **just outside the
window** ⇒ judged `low`. **That is a coincidence, not a guarantee**: if the file changes length, a
whole-file write could be refused by its own high-risk rule.

**Disposition:** use `edit` / `ops_replace` to write **in fragments** (independent of window position), or
use the out-of-band `sync-to-profile.mjs` above.

**Design debt (not done):** the gate should offer an **explicit, auditable exemption for the plugin's own
deployment path**, rather than forcing a choice between "move the configuration window" and "out-of-band
manual copy" — the latter leaves **no audit record at all**.

### 0.4 When this environment cannot answer the approval prompt

Approval prompts may be **disabled** in a session, and the approval gate classifies shell as **medium**,
so `approval.strength: ask-user` makes **every shell call auto-rejected** (the message reads
`the user rejected tool "pwsh"`, indistinguishable from a human refusal). That is a property of the
session, not a reason for the model to widen its own gate.

The correct response is to run the gated work in the **root conversation**, or to ask the user to change
`approval.strength` in the settings page / `.dsh/workflow.yml` (restart applies it). A delegated child
cannot ask, so it must return the request upward. `workflow_set` refuses a weakening write without a
real user confirmation, and a direct file edit cannot lower the gate for the rest of the session.

**The old instruction — `workflow_set path=approval.strength value=llm-only` — was removed because it
was a self-authorization: the child hit the gate, changed the setting, and retried the write.** The
refusal's own text used to recommend it; that text is now a human-only remedy.

### 0.5 `llm-only` judgements are non-deterministic

`llm-only` is decided by a model, so **the same command can pass one time and be refused the next** — this
was measured: two agents ran the **same** `sync-to-profile.mjs`, one allowed and one refused, while the
same copy command had already succeeded for another agent earlier.

**So: do not retry until it passes.** Retrying is **exploiting non-determinism**, and the official
warning already says it may allow unsafe operations and deny useful work. **"It passed last time" is not
authorisation.**

When a refusal names a remedy, first ask **who is allowed to perform it**. A remedy that widens the
gate — changing `approval.strength`, `denyHighAlways`, `exemptTools`, or `evaluator.independent` — is a
**human** action. A session that performs it has authorised itself; the plugin now refuses that write
(and keeps the stronger gate even if the file is edited directly). A remedy that is ordinary project
work can be followed; a remedy that changes the safety control cannot.

---

## Layer 1 — The offline suites

Runs in seconds. Run it after **every** change.

```powershell
cd <plugin>
node run-unit-tests.mjs                       # expect: 0 fail (skips are environment-gated; see below)
node run-smoke-test.mjs                       # expect "smoke test passed"
node run-config-check.mjs                     # expect 2 OK lines
$env:DSH_TOOLS_BUNDLE = '<extracted>/dsh-tools/lib/index.js'; node tooling/validate-tool-definition.mjs
node tooling/check-config-schema.mjs          # schemastery semantics (resolves from the profile)
node tooling/check-installed-config.mjs       # the installed copy is visible to the host
$env:DSH_CLIENT_MODULES_BUNDLE = '<extracted>/dsh-client-modules/lib/index.js'; node tooling/simulate-client-scan.mjs
node tooling/sync-to-profile.mjs --check      # expect 0 differ
```

`DSH_PROFILE_DIR` overrides the profile (default `~/.dsh/profiles/desktop`). The two shipped-bundle
tools require the extracted host packages, because those bundles are not vendored here.

The suite must be green in both environments. **The failure count is the number that must be zero;
test counts drift as work lands, so they are not restated here.** In a normal terminal the only skip
is a Windows limitation (the platform has no catchable `SIGTERM`), not a failing case. In the DSH
sandbox the runner sets `DSH_WORKFLOW_SANDBOX=1`, so the environment-dependent tests skip as well —
the ones that need a piped child (denied with `EPERM`) or the Chromium layout browser — and each skip
is reported with its reason rather than counted as a pass.

### 1.1 What the DSH sandbox does NOT run — a skip is not a pass

`run-unit-tests.mjs` probes a trivial piped child once. In the DSH Windows sandbox that probe comes
back `EPERM`, so the runner sets `DSH_WORKFLOW_SANDBOX=1` for the whole test process; the affected
cases then call `t.skip()` with a visible reason. **They are NOT RUN. They are not green, and a
`0 fail` summary does not cover them.** Specifically:

- **The Chromium layout measurement is NOT RUN in the sandbox.** The case
  `the shipped panel grid resolves to one column with a full-width label` in
  `test/status.test.mjs` drives a headless Chromium through `tooling/layout-styles.mjs`
  (`measureLayout`), which is the only thing that resolves real grid geometry. The sandbox cannot
  start that browser, so the case skips there — the *declaration-level* assertions in the same file
  still run, but **the rendered outcome is unmeasured in the sandbox**. In a normal terminal with a
  Chromium-family browser it runs; without one it skips with its own reason
  (`no Chromium-family browser on this machine; the resolved layout was not computed`).
- **The mutation-lock race cases are NOT RUN in the sandbox.** The cases in
  `test/mutation-lock.test.mjs` that launch child processes are denied their pipes (`EPERM`) and
  skip by name.
- **Everything else runs**, including `test/review.test.mjs`, `test/review-isolation.test.mjs`,
  `test/governance.test.mjs`, `test/approval.test.mjs` and the rest of `test/status.test.mjs`: they
  do not need a pipe or a browser. The harnesses that capture a child at all do it through temp
  files (`tooling/child-output.mjs`), never through a pipe.

So a sandbox run is a real result for the cases it executed and **no result at all** for the ones it
skipped. Do not record a skipped case as passing, and do not read the sandbox's `0 fail` as "the
rendered layout was verified".

`tooling/check-config-schema.mjs` needs schemastery, so run it from the profile directory.

**Catches:** pure logic errors; configuration drifting from the code defaults; a tool definition the
registry rejects; a browser bundle that cannot be discovered; forgetting to sync.

**Cannot catch — and this is the important part:**

| Not caught | Needs |
|---|---|
| That the tests have no binding force | Layer 2 (mutation testing) |
| Real subagent / service behaviour | Layers 3 and 5 |
| Whether the delegation depth is sufficient | Layer 5 |
| Service injection during a real host mount | Layer 4 |
| Settings-page rendering | Layer 4 + a human |
| Problems that only appear across a sequence of calls | Layer 5 |

> **Historical evidence:** with all 330 assertions green, a single real-host run still found 4 defects
> (dimension padding, a silently dropped `workspace_dir`, a `diff` re-send, and `pick` semantics).
> **No layer substitutes for layer 5.**

---

## Layer 2 — Mutation testing

Runs in minutes. It answers the only question layer 1 cannot: **do the tests actually have teeth?**

```powershell
node tooling/mutation-check.mjs               # constraint ledger / retirement
node tooling/mutation-check-approval.mjs      # approval gate + self-deployment exemption
node tooling/mutation-check-client.mjs        # the settings page
node tooling/mutation-check-panel.mjs         # the sidebar panel
node tooling/mutation-check-project-tab.mjs   # the conversation tab
node tooling/mutation-check-work-unit.mjs     # work-unit state
node tooling/mutation-check-verification.mjs  # the verification-depth policy
node tooling/mutation-check-governance.mjs    # HANDOFF governance, the waiver, the docs fast lane
```

Each mutant: inject a defect → run the suite → record whether it went red → **restore the source
byte-for-byte**. `mutation-check-governance.mjs` is the one exception to that shape: it copies the
project into a unique `%TEMP%` directory and runs the mutant THERE, so no mutant is ever written into
the canonical `lib/` (the shared lock is still taken, and `lib/tools.js` and `lib/advance.js` are
verified byte-for-byte). Its check line is `canonical sources unchanged ... YES` rather than
`sources restored byte-for-byte: YES`. The lock is the same, but the harnesses are not identical
elsewhere: the approval harness has neither a `must:` list nor a required `expect:` — an `expect:`
regex, when a mutant declares one, only chooses the stricter success message; a red run is counted as
caught either way (`caught`, or `caught by a different assertion`) — so a mutant that turns the suite
red for the wrong reason still counts, and the harness has no exit 3. The governance harness is
stricter: every mutant names the test that must fail (exit 3 when a canonical source changed while it
ran).

**The captured child now runs inside the DSH Windows sandbox.** Each harness captures its child's
output through temp files (`tooling/child-output.mjs`) instead of a pipe, because the sandbox denies a
piped child (`EPERM`). The capture is still a real child process with a real exit status; only the
transport of its stdout/stderr changed. **Verified by the three sandbox runs that previously could not
start a captured child — `mutation-check-approval.mjs`, `mutation-check-verification.mjs` and
`mutation-check-work-unit.mjs`** — each reached its mutants and printed its restore line.

**The three UI harnesses cannot be judged in the sandbox.** `mutation-check-client.mjs`,
`mutation-check-panel.mjs` and `mutation-check-project-tab.mjs` run `test/status.test.mjs`, which
includes the Chromium layout measurement. The suite runner skips that case in-sandbox (Layer 1.1),
but these harnesses spawn the test file directly and **do not set `DSH_WORKFLOW_SANDBOX`** — so an
in-sandbox run reaches the browser launch, which the sandbox cannot complete. That is an
**environment failure, not a caught mutant**, and the harness does not yet classify it as NOT RUN
(the still-open UI-harness gap). **Run those three in a normal terminal**, and read an in-sandbox run
of them as no evidence about the rendered layout. The gap is tracked in
[ROADMAP.md](ROADMAP.md) §"The UI mutation harnesses still need a normal terminal".

> ⚠️ **Never run two of these concurrently.** They rewrite files under `lib/`. Two at once on
> `lib/client.js` once left **two mutants permanently in the source tree while both processes printed
> `sources restored byte-for-byte: YES`** — each verified only itself. A shared lock
> (`tooling/.mutation-lock`) now refuses the second one, which exits **2** immediately and names the
> holder. It never queues.

**Expected:** mostly `caught`; `partial` and `missed` are each listed individually.

**The meaning of `missed`:** that property is **constrained by no test at all**. Do not ignore it — either
add a test, or write down explicitly in [ROADMAP.md](ROADMAP.md) that the property is untested.

**The criterion:**

```
source restored byte-for-byte: YES     ← required. Otherwise you are corrupting the source
```

> **Why this layer is non-negotiable:** a test that cannot go red is not a test. This project has already
> recorded 4 instances of "every test green, the defect still present".

> ⚠️ **The mutant must genuinely reproduce the defect.** The first attempt at one mutant only changed a
> `description` string without deleting the property, and reported "not caught". Had that been read as
> "the test has no teeth", a good test would have been deleted. When a mutant is `missed`, confirm the
> mutation is real before concluding anything about the test.

---

## Layer 3 — Independent review

One full cycle; runs in minutes. In DSH, call `workflow_review`:

```
feature:         one or two sentences on what was done
acceptance:      the acceptance criteria claimed (a list)
changed_files:   the files touched (bound into the fingerprint)
diff:            if you have it, strongly recommended
sensors:         the computational checks already run, with results
class:           docs | ui | logic | security (a PROPOSAL, checked against the files)
round:           1 (increment after a fix)
```

**Reading the verdict:**

- `overall` is the mean of the **declared** dimensions (undeclared dimensions do not participate, which
  prevents padding).
- `failedVeto` names the vetoed dimensions **supported by a reachable defect**.
- `unjustifiedVeto` = below the bar but every defect is marked unreachable → **does not block**.
- `unexplainedVeto` = below the bar with **no defect explaining it** → **blocks** (a score is not
  evidence).
- Every issue carries `reachable` and `reach`; **only reachable defects block**.
- `observations` are records that do not affect the verdict.

**The reviewer checks the working tree itself, and the framework reconciles the list too.** The prompt's
step 4 tells the reviewer to run `git status --porcelain` in the project and compare it with the author's
`changed_files`; any changed path missing from that list is an issue, scored against `scope`, `tests` or
`correctness`. The framework also reads `git status` through an argv array (`lib/git-changes.js`) and
adds a path the declaration omitted to the evidence, so the reviewer sees the omission without having to
find it. Both are **evidence, not a security boundary**: `git status` only sees **uncommitted** changes,
so a committed path is invisible and must still be declared. A real framework-side design would need a
base-commit diff, not `git status` (see
[DESIGN.md §11.3](DESIGN.md#113-why-the-cross-check-is-evidence-not-a-security-boundary)).

**The PASS is bound to a fingerprint, so a later edit stales it.** `workflow_status` reports
`fresh` / `stale` / `unknown`, and `COMMIT`/`HANDOFF` refuse a stale PASS. The consequence that catches
people: a docs pass in a *later* feature that edits a file an *earlier* PASS covered **stales that
earlier PASS**. That is the framework working, not a routing bug. Either scope documentation edits to
the feature that owns the file, or budget a re-review of the earlier feature and expect it.

**Re-review after a stale PASS** means a fresh `workflow_review` with an incremented `round`, on the
current bytes. Do not edit the evidence, and do not ask `record-review` to accept the old verdict — the
fingerprint is exactly what makes the verdict mean something.

**Catches:** my own blind spots; problems that are reachable but that offline tests do not cover.

**Cannot catch:** rendering, real mounts, UI.

> **Calibration:** `evaluator.maxRounds` is **2**. Exhausting it returns `exhausted`, and **that is a
> terminal state** — take the work to real-host verification, do not try to open a third round.

The same configuration powers the **verification depth policy**: a `class` declaration sets how deep
verification must go, and the declaration is checked against the changed files, so it can only add cost.
`verification.policy` **defaults to `off`**, where a declaration changes nothing. See
[CONTRIBUTING.md](../CONTRIBUTING.md) for the full table.

---

## Layer 4 — Real-host functional verification

Needs a restart and a human. **No automation substitutes for this layer.** Check each item.

### 4.1 `workflow_status`

```
workflow_status                                  # summary
workflow_status verbose=true                     # full configuration
workflow_status workspace_dir="<another project>"  # must report THAT project, not the cwd
```
- [ ] the `approval` line shows the current strength
- [ ] the `independent review:` line shows either availability or **the reason it is unavailable**
- [ ] when `workspace_dir` is passed, `diagnostics.workspaceSource` contains `workspace_dir`

### 4.2 `workflow_init` / `workflow_set`

```
workflow_init dry_run=true                       # see what would be written
workflow_init tier=minimal                       # actually write
workflow_set path=tier                           # read mode; writes nothing
workflow_set path=tier value=strict              # write
workflow_set path=tier value=yolo                # must be refused, naming the legal values
workflow_set path=evaluator.mustPass value=      # an empty list: mustPass allows it, dimensions do not
workflow_set path=evaluator value={...}          # a whole-section write must go through the same validation
```
- [ ] in a project that has not opted in, `workflow_set` **refuses to write** and says to run
      `workflow_init` first
- [ ] an illegal enum value is refused, and the error names the legal values

### 4.3 `workflow_advance`

```
workflow_advance                                 # current phase + legal next moves
workflow_advance action=boot smoke_passed=true   # the bootstrap checklist
workflow_advance action=pick                     # select a feature AND enter PICK
workflow_advance action=advance to=BUILD         # must be refused while the checklist is unmet
workflow_advance action=advance to=COMMIT        # from INIT: must be refused, listing the legal moves
workflow_advance action=advance to=HANDOFF       # with an open feature: `open-features`, and it names them
workflow_advance action=advance to=HANDOFF waive_open_features=true
                                                 # refused: `waiver-reason-required`
workflow_advance action=advance to=HANDOFF waive_open_features=true waiver_reason="why"
                                                 # allowed; WORKFLOW.json `waivers` gains the record
```
- [ ] an illegal transition is refused and the message lists the **legal** moves
- [ ] after `action=pick`, `phase` becomes `PICK` (not just a selection)
- [ ] **`BUILD` is refused while the bootstrap checklist is unmet** (no new features on a broken foundation)
- [ ] **`HANDOFF` is refused while any feature is open**, and the refusal lists them
- [ ] a waiver **without a reason** is refused, and a waiver with one is recorded in `WORKFLOW.json`
- [ ] with `recipe: docs`, `BUILD → EVALUATE` is allowed and the reply names `VERIFY` as skipped; with
      any other recipe it is an `illegal-transition`; **no recipe may go `BUILD → COMMIT`**

### 4.4 `workflow_review` — the reverse self-certification check (the most important one)

```
workflow_advance action=record-review feature_id=<some feature>
```
- [ ] **if no review ran in this session, this must be refused** and say that claiming it passed is not
      evidence
- [ ] after a real `workflow_review`, `passes` becomes `true`
- [ ] **if the reviewed files were edited after the review, `record-review` must refuse** (the
      fingerprint is invalidated)
- [ ] in a **git** project, a review whose `changed_files` omits a file `git status` reports shows
      `DECLARATION INCOMPLETE` with that path, and the resolved class is the stricter of the claim and
      the union; a project with no git says `NOT CHECKED` instead of `no mismatch`
- [ ] each issue in the review report shows `reachable`, or `UNREACHABLE — recorded, does not block`

### 4.5 `workflow_gc`

```
workflow_gc                                      # scan; an empty ledger should report "none"
workflow_gc action=list                          # the raw ledger
workflow_gc action=add constraint={rule,why,retire_when:{review_after_days:30}} dry_run=true
workflow_gc action=add constraint={...}          # must ASK you; without confirmation nothing is written
```
- [ ] `scope=code` / `scope=docs` **explicitly refuse as not-implemented** (they do not pretend)
- [ ] a constraint with no `retire_when` is reported as **defective** (never retiring is itself a defect)
- [ ] a natural-language `retire_when.signal` is reported as **DUE FOR HUMAN REVIEW**, and **never** as
      "the signal is satisfied"
- [ ] `add` / `retire` **require user confirmation**; nothing is written without it
- [ ] retirement is a **mark**, not a deletion (the record is kept)

### 4.6 The settings page (nested module switches)

Open **Plugins → dsh-workflow → `dsh-workflow-core` → configuration**:

- [ ] **the description row is one normal description** (`档位与开关、状态落盘、独立验收、审批强度。`)
      — **not** the full body. A full body there means the `view:"summary"` guard is broken
- [ ] the top-level controls appear: tier, recipe, approval strength, risk threshold, bar, independent
      review, context isolation
- [ ] **nested switches:** under `上下文隔离` there should be a heading `模块开关（modules.*）`, a hint
      line, and then **13 checkboxes**: planner, featuresJson, progressLog, handoffDoc, acceptance,
      independentReview, selfVerify, gcCode, gcDocs, constraintLedger, stats, gitCommitPerFeature,
      isolation (**`isolation` appearing twice is by design**: one dedicated control plus one derived row,
      writing the same single-key op)
- [ ] ticking `planner` shows a brief `已保存` (or `未保存（宿主未接受该值）` when refused), disappearing
      after about 2.5 seconds
- [ ] **reopen the page** and confirm the tick state matches the host, or cross-check with
      `workflow_set path=modules.planner`
- [ ] unticking also persists — it must be a `set` to `false`, not an `unset`
- [ ] **lost-update check:** tick a module row and **immediately (sub-second, before the round-trip
      completes)** click `上下文隔离` — the first checkbox **must not spring back**
- [ ] when the namespace is unwritable or unavailable, the list is disabled or shows a "namespace missing"
      message, and **the console must show no exception**
- [ ] the F12 console contains only `[dsh-workflow:…]` info lines; **no** `write threw`,
      `write rejected`, or React duplicate-key warnings

> **Console diagnostic shortcut** (the `serves` line is the only criterion):
> - `status=ready` with `serves` **containing** `dsh-workflow-core` → the gate is open
> - `serves` **not containing** it → the sub-entry does not export `Config`
> - stuck at "loading" → the controller cannot obtain `subscribe`

### 4.7 The conversation tab and the sidebar panel

The render-dependent surfaces, with item-by-item checklists kept in [ROADMAP.md](ROADMAP.md) under
"Unverified". Read them there and walk them on a real host; **they are not yet verified**, and do not
record them as passed on the strength of the offline evidence.

---

## Layer 5 — Architecture verification

The most valuable layer. It verifies three things: that `maxDepth: 2` is sufficient, that review
round-trips do not enter the main context, and that a full loop runs end to end.

The method: **the main model delegates a real work unit to a subagent**, which drives
`workflow_advance` + `workflow_review` internally, and **reads only its final report**.

```
main LLM (depth 0)
  └─ delegate a work unit ──► child (depth 1)
                                ├─ workflow_advance drives the phases
                                ├─ workflow_review → reviewer (depth 2)   ← is maxDepth 2 enough
                                └─ loop until it passes
  ◄── the main context receives only the final report ──┘
```

**Criteria:**
- [ ] the child calls `workflow_review` and does **not** raise `SubagentDepthError`
- [ ] the full review round-trip (per-dimension scoring, fuzzing) returns to the main conversation
      **as a summary only**
- [ ] `passes: true` in `FEATURES.json` carries an `evidence[].fingerprint`, and was written by the
      framework from a **real review**
- [ ] `WORKFLOW.json` history shows the complete phase sequence

> **To check whether a work unit is genuinely complete:** look at the `evidence` array in
> `.dsh/FEATURES.json`. Only `{type:"review", overall:…, passed:true, fingerprint:…}` means it really
> passed review.

---

## Layer 6 — The working discipline

After a change, run these **in order**:

```
1. offline suite            seconds    must be fully green
2. mutation testing         minutes    confirm the tests still have binding force
3. sync + restart + real host          confirm it actually works
4. independent review       when the change is not obviously correct
5. delegate a real work unit when the change touches architecture
```

**Do not declare completion on a green layer 1.** This project has recorded **5 instances** of "offline
all green, real host broke on the first run".

The reverse also holds: **layer 3 cannot substitute for layer 1** — a real-host run cannot reveal that a
test has no binding force. And a **consistency test that copies the parameters of the code under test
cannot detect that the code is wrong**; write the correct answer into the test independently.

---

## What is deliberately excluded from this document

The **honest list of what remains unverified** — implemented-but-never-exercised surfaces, deliberate
non-implementations, and known debts — lives in [ROADMAP.md](ROADMAP.md). It is kept separate so that it
is *maintained*, rather than becoming a stale table inside a testing guide.

> **Unverified is not the same as broken — but unverified means you do not know.** Every item there should
> eventually be pushed to verified or to a deliberate non-implementation. When this document and
> ROADMAP.md disagree about a surface, **ROADMAP.md is the newer word**.
