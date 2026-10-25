# Roadmap and known gaps

What is proven, what is implemented but never exercised on a real host, what deliberately refuses
rather than pretends, and what is known to be broken.

This file exists because the project has a documented history of documents claiming things that were
not true. Nothing here is inferred to work. Where two sources disagree, both are named.

Sources: `NEXT-STEPS.md` line numbers (the development journal), `TESTING.md`, and `package.json`.
Where an item was checked directly against the repository during this documentation pass, it says so.

---

## Verified and working

Each line names the evidence, not an assurance.

| Item | Evidence |
|---|---|
| Six tools register, and the shipped registry validator accepts all six definitions | `DSH_TOOLS_BUNDLE=<extracted>/dsh-tools/lib/index.js node tooling/validate-tool-definition.mjs` → `all 6 tool definitions are acceptable to the shipped registry`, exit 0 (NEXT-STEPS.md:1972, 2440) |
| The offline unit suite | `node run-unit-tests.mjs` → **576 tests / 575 pass / 0 fail / 1 skip** in a normal terminal; the skip is a Windows-only limitation (no catchable `SIGTERM`), not a failing case. In the DSH sandbox the same suite is **576 / 569 pass / 0 fail / 7 skip** (six environment-gated cases). |
| The full apply/execute/render chain on a fake ctx | `node run-smoke-test.mjs` → `smoke test passed` (NEXT-STEPS.md:1970) |
| Patch values match code defaults | `node run-config-check.mjs` → `OK: every patch value matches its code default`; `resolved maxDepth is 2` (NEXT-STEPS.md:3155) |
| The browser half is discoverable | `DSH_CLIENT_MODULES_BUNDLE=<extracted>/dsh-client-modules/lib/index.js node tooling/simulate-client-scan.mjs` STEP 1–5 OK (NEXT-STEPS.md:3154) |
| Phase-machine refusals | Real host: an illegal transition lists the legal ones; `BUILD` is refused without the boot checklist; `pick` **moves** `PLAN → PICK` (TESTING.md:330) |
| Bootstrap `open_feature` message | Fixed: `lib/advance.js` branches on `counts.open > 0`; `test/governance.test.mjs` asserts the item never says "every feature is complete" while one is open, and still names the genuinely closed cases |
| Governance: `HANDOFF` refuses open features, the audited waiver, and the `docs` fast lane | **Offline only:** `test/governance.test.mjs` covers the refusal, the waiver-with-reason path and its audit record, and the single `BUILD → EVALUATE` edge. Not yet exercised on a real host. |
| Reverse self-certification | Real host: with no review this session, `record-review` is refused with **"a claim that one passed is not evidence"** (TESTING.md:331) |
| Review fingerprinting | Unit tests; mutation turns 2 tests red; real `FEATURES.json` carries `evidence[].fingerprint` (NEXT-STEPS.md:1392, 1409–1415) |
| Independent review round-trip, delegation depth, and main-context isolation | Real host: a depth-1 child created a depth-2 reviewer with no `SubagentDepthError`, and the full round-trip returned to the main conversation as a summary only (NEXT-STEPS.md:1403–1407) |
| The approval gate's decisions, messages and probe | Real host: `APPROVAL NOT SATISFIABLE HERE — this session's approval policy is "never" …`; `test/approval.test.mjs` covers the incident replay; `mutation-check-approval.mjs` 65/65 active mutants caught (M32 removed because the writer refuses its path; TESTING.md:329; NEXT-STEPS.md:2605) |
| Constraint ledger: scan, validation, `dry_run`, the refuse-to-write without confirmation path, and retirement as a mark rather than a delete | Real host: `not-confirmed` returned for an unconfirmed add; a **typed** answer was correctly judged not consent; a confirmed `C001` write recorded `confirmed_by: "user-question"` (TESTING.md:334–342) |
| The GC never claims to have evaluated a free-text signal | Real host: `workflow_gc scan` on a real constraint judged `not-due` **and explicitly stated that the framework did not evaluate that free-text signal**, and that this is not a claim the signal is unmet (TESTING.md:342) |
| Work-unit isolation | Real host: `.dsh/WORKFLOW.json` (PICK) and `.dsh/work/B4/WORKFLOW.json` (PLAN) coexist; `work units (1): B4@PLAN`; `../evil` refused with an explanation of why refusal beats sanitisation (TESTING.md:332–333) |
| The mutation lock | An in-run second mutator exits **2 within 0.1 s** naming the holder with the source hash unchanged; a killed run's lock is taken over by the next run; the lock probe's L1–L4 mutants are all RED (NEXT-STEPS.md:2888–2896, 3007–3015) |
| The self-deployment exemption (offline) | `test/approval.test.mjs` covers the exemption; `mutation-check-approval.mjs` 46 → 65 active mutants, 65/65 caught (M32 removed as unreachable); independent review round 1 PASS 8.71 with 1306 differential cases and 0 unexplained differences (NEXT-STEPS.md:2605, 2762–2766) |
| Risk-graded verification depth (offline) | V01–V27 all KILLED, `sources restored byte-for-byte: YES` (NEXT-STEPS.md:132–168) |

**Deployment state is not uniform.** Items are separately deployed; see CHANGELOG.md, which marks each
one. At the end of the journal, `verification.policy`, the conversation tab, the sidebar panel and its
layout fix, work-unit isolation, the self-deployment exemption and the project tab's effective-config
view were all recorded as **not yet in the installed copy**. The P2.B1+ batch on `fix/p2b1-plus` — the
harness sandbox fix, governance + docs fast lane, reviewer-side working-tree check and bootstrap fix — is
**committed but not deployed and not exercised on a real host**. The framework-side cross-check from that
batch was dropped (see "Deliberately not implemented").

---

## Unverified

Implemented, and never exercised on a real host. Listed because "unverified is not broken, but
unverified means you do not know".

### The sidebar panel rendering (B6)
The entry on `sidebar.panellist` and the body on the root-scoped `main` slot are registered from the
existing `lib/client.js`, gated by `showInSidebar`. **Nothing about the rendered result has been seen:
DSH was never started during that round.** Offline evidence only: 419/419 tests, 22/22 mutants,
`simulate-client-scan.mjs` STEP 1–5.
Unverified specifically:
- whether the entry actually appears in the sidebar's global-panels group;
- whether clicking it projects the `main` body (a missing `main` entry **throws**);
- whether the single-column layout is readable in a narrow rail;
- whether the icon looks right;
- the **recovery path**: after switching `showInSidebar` off, whether the panel row's own
  `plugins.row.config` page really appears in Settings → Plugins and really switches it back on;
- that the two `plugins.row.config` registrations (core row, panel row) do not cross-talk — the core
  row's page must **not** show the sidebar switch;
- `whileServed` timing: it depends on the settings mirror serving `dsh-workflow-panel` first. If that
  row is disabled the entry **does not register** (deliberate: "no service, no entry"), which has never
  been observed on a real host;
- `panelVisible` behaviour when the switch is turned off at runtime: it is decided **once, at
  registration**; changing it live requires a page refresh. Live withdrawal was deliberately not
  implemented, because it would make the panel vanish under a user who is mid-edit.
**What it would take.** Start DSH, sync first, hard-reload, and walk B6.4's checklist (NEXT-STEPS.md:2257–2300).

### The sidebar layout fix (D) — 11-item manual checklist
The two-column defect is fixed and its geometry is measured in a real engine (headless Chromium:
`0px 244px` before, `264px` after). **The fix was never synced, so the interface has not been seen.**
The checklist is NEXT-STEPS.md:2808–2820: label no longer wraps per character; single column; full-width
row dividers; left-aligned and ≤520 px; looser row gap; the settings page **still** two-column with a
200 px label column (the control group); the `llm-only` warning banner full width; the tab shows the
three new "why no editor" sections; the tab has **no** editable control; the sidebar switch can be
turned back on from Settings → Plugins; no `[dsh-workflow]` error in the console.
Whether the dividers and 16 px spacing look *good* is an aesthetic judgement no measurement reaches.

### The project tab manual checklist — 9 items
The "actual effective configuration" view renders by answer-first-then-raw-text, with a per-row layer
badge. Its logic is covered by differential tests (the host's own functions vs the browser mirror) and
P1–P57 mutants all caught. The rendering is not.
Checklist (NEXT-STEPS.md:3164–3179): first screen is the effective config, not the file text; in this
project `tier: standard` shows **本工程覆盖** and `approval.riskThreshold: medium` shows
**继承自默认值**; the overview counts equal the table's row counts; "re-read" follows the file; changing
an inherited default in Settings → Plugins updates the tab **without a refresh** (the subscription);
a project with no `.dsh/workflow.yml` shows "not opted in" and **must never show a defaults table**;
`approval: nope` shows the fail-closed four values plus `文件要求：nope` and the reason; `evaluator.bar:
abc` warns while still displaying `abc`; visual checks (760 px cap, no overlap, badges wrap without
squeezing the value, the seven dimensions wrap readably); and **no writable control exists** on the page
other than "re-read".
**What it would take.** Sync, restart, walk the checklist by hand.

### The `verification.policy` real-host path
Implemented and self-tested (V01–V27), and **never exercised on a real host**: this project had not
opted in at the time, and there was no GUI. Covered only by six cases in `test/review.test.mjs` that go
through the **real `execute`** with fake `subagents` / fake `userQuestions`. Not deployed.
**What it would take.** Deploy, then call `workflow_review` with a `class` and `changed_files` on a real
host and read the report and the refusal text. Also unverified: the human-check attestation path
(`caller-attestation`) can only ever be an attestation.

### The panel settings page — the B5.4 checklist
B5.1–B5.3 were synced (`copied lib/approval.js / lib/client.js / lib/index.js / lib/tools.js` →
`sync complete: 4 copied, 19 already identical`), and `TESTING.md` records the rendered page as verified
from a user screenshot. What is still only source-level for the **new** controls is the nine-item B5.4
walkthrough, in particular the **lost-update** re-test — change approval strength and then risk
threshold within one round-trip, refresh, and confirm both are the new values (NEXT-STEPS.md:2117–2143).

### Structured-output enforcement
`workflow_review` passes an `outputSchema` through the service API, so the reviewer is forced to return
JSON matching a schema. The offline tests cover the fallback path only (structured missing → parse the
text → `parsed: false` on failure). The sources do not agree on the real-host status: `TESTING.md` §6
records `outputSchema` as verified by a real-host end-to-end run, while an earlier journal entry
(NEXT-STEPS.md:1310–1312) says that step was still outstanding. **Treat the parse/normalise tests as the
certain evidence.** Related, verified limitation: the model-facing `subagent` tool does **not** accept
`outputSchema` at all, which is one concrete reason `workflow_review` exists rather than a prompt
asking reviewers nicely for JSON.

### Other unverified items
- `human_check: 'yes'` (a string) would be rejected as unasserted, which is the fail-closed direction,
  but no test pins the non-boolean behaviour.
- `workflow_gc`'s `retire` **confirmation** path: the refusal side is verified on a real host; the
  approving side of `retire` has never been walked. Not a defect — retirement only ever suggests, and
  requires a confirmed constraint.
- The git-commit path: never verified, because the test project has no VCS. Not a defect.
- The strict date reader's timezone-offset local forms (`2026-01-01 10:00:00`, space-separated) are
  untested; they are judged unreadable and escalate to a human. Safe direction, worth knowing.
- `approval.strength: llm-only` produced both outcomes for the **same** command across two agents.
  Non-determinism is inherent; it is not a defect, but no test can pin it.

---

## Deliberately not implemented

These are deliberately not built, or built only far enough to refuse rather than pretend. A refusal here
is the designed behaviour, not a gap to close.

### `workflow_gc scope=code` and `scope=docs`
Both refuse as **not implemented**, by name, rather than returning an empty or optimistic report.
`scope=all` runs the constraint half and reports the other two as unimplemented.
**Why.** Code and documentation drift detection is not built. An empty report from an unimplemented
scope would read as "nothing drifted".
**What it would take.** An actual drift detector plus its own tests; it is a feature, not a wiring job.

### `retireCheck` timing is scheduled: false
`retireCheck.everyDays` is validated and stored, but **there is no scheduler**. The report says
`scheduled: false` explicitly. `every_days` is design intent only.
**Why.** A report that implied a schedule that does not exist would be passing off a non-existent safety
net as a real one.
**What it would take.** A scheduler in the host half, plus the decision of who triggers it (the plugin
has no background loop).

### A framework-side cross-check of `changed_files` against `git status`
**Not implemented, and the prototype was dropped rather than shipped.** The idea was to have the framework
reconcile the author's declared file list with `git status --porcelain`. It was built on a WIP branch,
failed four independent reviews, and was removed. Three measured reasons:

- **It is not a security boundary.** `git status` reports only **uncommitted** changes; a committed path
  is invisible, so the check can miss exactly the files that matter most.
- **It could not run where it was needed.** Its default runner captured git through piped stdio, which
  the DSH sandbox denies (`spawnSync git EPERM`), so in the installed environment the check could not
  run: it fell back to the declared list and reported `NOT CHECKED`. The review still proceeded, so the
  installed environment gained no completeness check.
- **The cost was not earned.** 649 implementation lines plus roughly 1,240 lines / 24 tests in the WIP
  branch's governance test file (part of a 1,908-line file), and four failed reviews, bought marginal
  completeness over an independent reviewer instructed to run `git status`.

**What landed instead.** The author is told to run `git status --porcelain` before review, and the
reviewer's prompt tells it to run the same command and report omitted paths as issues. That is an
instruction, not an enforced boundary — an honest model can still miss generated or renamed files.
**What a real design would need.** A **base-commit diff** (`git diff <base>...HEAD` plus untracked
files) parsed and bound into the review fingerprint, with deleted and renamed paths handled explicitly;
`git status` alone is the wrong primitive.

### `showInPluginPage` has no reader
Declared on the panel row's schema and annotated as such in `cordis.patch.yml`, but **nothing reads it**.
**Why.** That round did not connect it to anything. It is marked honestly rather than silently removed.
**What it would take.** Decide what it should gate (presumably the plugin-list entry) and wire it,
or delete it.

### The remaining nested configuration sections on the settings page
Still reachable only through `workflow_set`: `context.*`, `acceptance.*`, `guards.*`, `escalation.*`,
`budget.*`, `signoff.*`, `evaluator.maxRounds`, `subagent.keyRoles*`, `approval.denyHighAlways`,
`verifier.feedMessageStyle`.
`verifier.sensors` is the interesting one: it is **deliberately** not done, because
`validateSettingValue` has **no rule** for it. A panel control would have to invent a constraint the host
does not agree with — so the decision is to build nothing rather than build a rule the host will not
enforce.
**What it would take.** For each section, either a host-side reader that the panel can mirror (the
pattern used for `approval` and `evaluator`: mirror the decision **and** add a differential test running
the host's own function), or an explicit decision to leave it out.

### Miscellaneous deliberate refusals
- `gc.js`'s schema declares `observable.phase` as a bare string, so an illegal phase surfaces as a host
  **schema error** rather than the friendlier `validateConstraintCandidate` message. Harmless, and
  recorded so nobody "fixes" it into a duplicate validator.
- No automatic retry after a failed review: `runReview` returns `exhausted`; changing code and re-running
  is the phase machine's job, so the review tool stays side-effect free.
- Escalation suggestions require user confirmation; nothing auto-upgrades a tier.
- `tooling/mutation-check-lock-probe.mjs` is a one-shot probe, not a seventh official mutator, and it is
  **not wired into the mutation lock**. Promoting it is an open decision, deliberately left to a human.

---

## Known defects and debts

### The gate cannot authorise its own first deployment
**What it is.** A chicken-and-egg loop, and it is structural, not a bug in the ordinary sense. The copy
running the gate is the old copy in the profile (`file:` dependencies are copies, not symlinks), and
that copy predates the self-deployment exemption. So the first deployment still needs an **out-of-band
copy**, performed by a human or by a session the gate does not govern.
**Why it is unfinished.** Circular by construction: no in-band fix can authorise its own first run.
**What it would take.** One out-of-band `node tooling/sync-to-profile.mjs` plus a restart. After that the
loop closes and later deployments are authorised by the gate itself, with an audit record. **Never sync
partially** — `lib/tools.js` depends on `lib/work-unit.js`, and omitting the latter makes `tools.js` fail
at import, removing the plugin's entire tool surface.

### A whole-file `write` of `lib/approval.js` passes by coincidence
**What it is.** The file's own text contains both sample literal classes (`SECRET_VALUE_PATTERNS`'s
session-cookie name, and `EXTERNAL_DESTINATION`'s network-command word in a comment). When both fall
inside `MAX_SCANNED_CHARS` (20000), a whole-file write is classified **high** — the first, guard-enforced
rule, which the exemption must not weaken. Measured this time: characters **20119** and **20837**, just
outside the window, so the write was judged low. **Coincidence, not guarantee.**
**Why it is unfinished.** Any fix by editing the literals or the window would be a textual dodge, which
this project forbids.
**What it would take.** Nothing structural; the operational answer is to deploy with `edit` /
`ops_replace` fragments, or out of band. Treat the whole-file write as unstable by design.

### Post-round-2 fixes with no independent review coverage
`evaluator.maxRounds` is 2 and `exhausted` is a terminal state, so the following fixes have **no third
independent opinion**. They have recorded outputs and mutants that go red; that is not the same as
reviewed.
1. **Work-unit `oneLine()` flattening** (NEXT-STEPS.md:2451–2462). Round 2 FAILED at 8.29 with
   `correctness` 7/10 vetoing. The other channels the reviewer found were fixed afterwards: `renderAdvance`
   and `renderConstraint` fields were still unflattened (`rule` was injectable through the *legitimate*
   `workflow_gc action=add` path, no hand-edited file needed), and the character class missed
   U+0085 / U+2028 / U+2029. Now one `oneLine()` in `lib/shared.js` over
   `[\u0000-\u001f\u007f-\u009f\u2028\u2029]`, plus 3 regressions and mutants M21–M23.
2. **The exemption's round-2 text fixes** (NEXT-STEPS.md:2793–2795). Pure text — one comment, two
   numbers — with **no behaviour change**, so round 2's PASS covers byte-identical behaviour.
3. **Three round-2 observations on the project tab**, recorded and not fixed in-round
   (NEXT-STEPS.md:3202–3214): the future `mergeConfigValue` / `DEEP_KEYS` coupling;
   `projectDefaultsUnknownNote` declared but rendered nowhere; `configLayerBadge`'s fallback without a
   direct case. None blocking. Details in PITFALLS.md §8.
**What it would take.** Raise `evaluator.maxRounds` and re-run `workflow_review`, or have a human review
the diffs.

### No mutation harness covers the governance / fast-lane logic
`test/governance.test.mjs` covers the `HANDOFF` open-feature refusal, the waiver path and its audit
record, the `docs` fast lane and the reviewer-prompt instruction, but **no mutation harness injects
defects into that logic**. The seven official harnesses target the constraint ledger, approval,
verification depth, work-unit state and the three UI surfaces. A regression in `lib/advance.js`'s
governance branches or `lib/tools.js`'s fast-lane rendering could therefore survive with the suite green.
**What it would take.** A `mutation-check-governance.mjs` with anchors for the waiver branch, the
`open → done` mapping and the `BUILD → EVALUATE` edge table, wired into `tooling/.mutation-lock` like the
others.

### The UI mutation harnesses still need a normal terminal
The three harnesses that exercise a rendered surface — `mutation-check-client.mjs`,
`mutation-check-panel.mjs`, `mutation-check-project-tab.mjs` — launch Chromium for the layout test. The DSH
sandbox cannot launch it, so they cannot produce a harness result there; the other four now run in-sandbox
through the file-backed child capture.
**Why it is unfixed.** It is the browser launch, not the capture.
**What it would take.** Run them in a normal terminal (the documented path), or find a headless engine the
sandbox permits.

### Reviewer step 4 says to compare with a list that may be absent
When `workflow_review` is called with no `changed_files`, `buildReviewPrompt` omits the "Files the author
says changed" section, but step 4 still reads "compare it with the files the author listed above" — there
is no list above. Minor: the reviewer can still run `git status`, which is the point of the step.
**What it would take.** Branch step 4 on whether the list was rendered: state that the author declared no
files and use `git status --porcelain` as the only source.

### `approvalMirrorable`'s conservative choice (runtime-unreachable)
The project tab requires the defaults layer to *carry* an `approval` section, so a malformed
`approval: nope` is displayed as "unknown + explanation" rather than "rejected → fail-closed" — even
though the host will definitely reject it and run fail-closed.
**Why it is unfinished.** Fixing it naively would report a fail-closed decision the host never made;
showing "unknown" is *less* information, not *wrong* information, and a plausible-looking effective
value is worse than "unknown" because users act on it.
**What it would take.** The condition
`isConfigObject(defaultsValue.approval) || effective.approval is not an object` (the latter is rejected
by the host regardless of the defaults), plus one differential case and one mutant. Runtime-unreachable
today, because `lib/config-schema.js` defaults all four approval fields.

### `run-config-check.mjs` only walks the core row's patch block
The panel row's three patch values were not checked by the existing tool. A `test/status.test.mjs`
comparison against `DEFAULT_CONFIG` substitutes as a guard.
**What it would take.** Teaching `run-config-check.mjs` about all three rows; the tool was out of scope
in the round that added the panel.

### `test/review.test.mjs` mid-round flakiness
Mid-round, 8 failures appeared there (`493 / 484 / 8 / 1`) while another agent was editing `lib/review.js`
without updating its test file. By the end of the round it was green and no longer reproducible. Not a
known defect — recorded so the next person does not read it as an unexplained regression.

---

## Repository hygiene

Items that matter before this becomes a publishable repository. Verified by reading
`package.json` and listing the tree during this documentation pass.

### `package.json` `name` is a workspace-scaffold name
`"name": "src-12453345_-dsh-workflow"` — the directory-name-derived name, not a publishable package name.
**Why it matters.** The README's install instructions and the `cordis.patch.yml` row names all reference
this exact string, so renaming it is a coordinated change, not a find-and-replace.
**What it would take.** Choose a name, then update `package.json`, `cordis.patch.yml`, both component
`package.json` files, the README, `tooling/sync-to-profile.mjs`, and the recorded profile dependency path.
Also decide on `"private": true`, which is present now.

### `package.json` `files` is incomplete for a documentation-bearing repo
`["lib", "tooling", "cordis.patch.yml", "README.md"]`. `tooling/` is now shipped deliberately — the
installed reviewer reads the mutation-harness table from it, and `sync-to-profile.mjs` copies it — but
`docs/`, `CHANGELOG.md` and `test/` are absent. `LICENSE` is included automatically by npm.
**What it would take.** Add `docs` and `CHANGELOG.md` at minimum, if the docs are meant to reach users.
