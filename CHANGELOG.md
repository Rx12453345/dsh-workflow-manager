# Changelog

All notable changes to this project are documented here.
Entries are grouped by the date the work landed; the version line is the one recorded in `package.json`.

Version recorded in `package.json`: **0.4.0**.

`0.3.0` is the **recovered checkout**: the tree rebuilt from the session logs (see
[`docs/RECOVERY.md`](docs/RECOVERY.md)) plus the P3 changes. It was **deployed as 0.3.0 on
2026-10-25** to both install roots (`~/.dsh/plugins/…` and the desktop profile's `node_modules`), and
at that point the status banner read `0.3.0`; it replaced the build from commit `3d6dd16`, whose
`package.json` says `0.2.0`. It is still not a published release: no 0.3.0 build was published. That
deploy is history, not a current fact — `node tooling/sync-to-profile.mjs --check` reads what is
installed now, and the gitignored `handoff/P3-STATUS.md` carries live state. Entries below that say
"not deployed" record the state when they were written; the 0.3.0 deploy is the later sync that
carried them.

Deployment is not uniform: a `file:` dependency is a **copy, not a symlink**, so implemented work is not
live until it has been synced and DSH restarted.

---

## [Unreleased] — 2026-11-02 (0.4.0)

### Changed — the recorded state survives a context reset, and judges staleness

Three problems, all measured in one session, all of them the same shape: the state carried a verdict
but not the reason for it.

- **The reviewer's findings are persisted.** A review's evidence row stored the score, the files and
  the digests — and nothing about what the reviewer complained about, so a later session could see
  "PASS 9.29 over these 15 files" and be blind to three unfixed minors. `workflow_advance
  action=record-review` now writes a bounded `issues` summary (dimension, severity, reachable, a
  one-sentence title; at most 10, ordered by consequence so truncation cannot drop a blocker, with
  `issuesTotal` when it does). `workflow_status` and the handoff brief print it per feature. A row
  written before this has no `issues` field and reads as "not recorded", never as "nothing found".
- **Staleness is judged, not just announced.** "re-review 6 stale feature(s)" was wrong advice: most
  of those records were stale because a document inside their declared set had been edited, and
  chasing all six cost hours. `reviewFreshness` now records per-file digests, and the status line and
  the brief say which stale records owe a review (`code changed`) and which are cosmetic
  (`documents only`); a mixed set with no per-file evidence answers `unknown` rather than guessing.
  The classification is the project's own (`verification.sources`/`security`/`ui`/`nonExecutable`),
  not a second extension list.
- **The brief no longer freezes at HANDOFF.** It was written only when the project entered `HANDOFF`,
  which is terminal, so every later `record-review` left the file describing a past state (it said
  7/8 complete and six stale while the state said 8/8 and five). Every state write now refreshes it —
  phase moves and `record-review` alike; `workflow_status` stays read-only; `modules.handoffDoc:
  false` still means no file. A project that never entered `HANDOFF` gets no file.
- **`docs/HANDOFF-STATE.md`** (new, tracked) records what the machine cannot: why work stopped, what
  was deliberately left stale, the unfixed minors, the open decisions. It is never declared in a
  review, so writing it costs one commit and no re-review (constraint C002, and a test asserts the
  property over this repository's own evidence).

`package.json` is now **0.4.0**.

---

## [Unreleased] — 2026-11-01

### Added — the handoff brief (`modules.handoffDoc` finally writes something)

`modules.handoffDoc` (default `true`, rendered on the settings page, listed by `workflow_status`) was
declared since the first version and read by **no code**: switching it changed nothing. It now
implements the document its name promises.

- **`lib/handoff.js` (new)** renders a markdown brief from the live state — the phase, every feature
  with its pass/fail and whether its review still covers the files on disk (`FRESH` / `STALE` /
  `UNKNOWN`), the last recorded review per feature (verdict, overall score, date), the blockers
  `COMMIT`/`HANDOFF` would enforce, the open constraints and the next legal moves — and writes it to
  `.dsh/HANDOFF.md` when the project **enters `HANDOFF`** (`enterHandoff` in `lib/advance.js`).
- **The target is `.dsh/HANDOFF.md`, never the repository's tracked root `HANDOFF.md`** (the
  incident brief). The path is derived, never passed as a caller argument, and
  `assertHandoffDocTarget` refuses anything whose name is not `HANDOFF.md` directly under the
  scope's workflow directory. `.dsh/` is gitignored here, so the generated file never appears in
  `git status`, never enters a diff and can never be declared in a review's `changed_files`.
- **Regeneration is byte-idempotent.** The timestamp line defaults to the state's `updated_at`
  instead of "now", so the same state renders the same bytes; the file is replaced, never appended.
- **The switch is honoured.** `modules.handoffDoc: false` writes no file **and** removes the
  `workflow_status` section; an inert project renders no section either.
- **`workflow_status` renders a bounded summary** of the same builder — the path with its size and
  modification time, the complete/open/stale counts, and one next action. Three lines: the full
  brief is on disk, and inlining it would make an already-long status report truncated.
- **`test/handoff.test.mjs`** (12 cases) pins the brief's content, the off switch, the `.dsh/`-only
  target, the idempotent rewrite, the bounded status section with counts matching the state, and a
  project with no review evidence. A failing write is reported in the `workflow_advance` reply
  rather than turning a legal `HANDOFF` move into a failure.

### Fixed — the p3-7 review's recorded debt in the handoff brief

The review PASSed the feature and recorded four defects as debt; each is now fixed in place, with
a regression test that can go red:

- **The work unit was not in the path, only in the content** (major, reachable). Two units entering
  `HANDOFF` overwrote the same `.dsh/HANDOFF.md`, and `workflow_status work_unit=A` then paired A's
  counts with B's file. A named unit now writes `.dsh/work/<id>/HANDOFF.md`, derived from the
  project's work-unit validator (an id such as `../x` is refused, not sanitised, and the resolved
  path is containment-checked inside `.dsh/work`). `workUnit` is threaded through the target
  computation, the writer, `readHandoffDocStatus` and `buildStatus`; the brief's own header names
  the file it is. Two new tests: a two-unit canary proving separate files, separate counts and an
  untouched project-level path, and an escape test naming the refusing layer.
- **`phase` was interpolated unflattened** (minor, unreachable) in the metadata line — and in the
  next-moves line — so a hand-edited `WORKFLOW.json` could forge brief structure with a newline.
  Both are `oneLine`d now; a test with a newline-bearing phase proves no second markdown line.
- **Waiver `openFeatures` ids were joined unflattened** (minor, unreachable) while the OPEN blocker
  line flattened its ids. They are flattened consistently now; a test with a newline-bearing id
  proves the waiver line stays one line.
- **`docs/USAGE.md` overstated the STALE blocker section**: the shipped path never shows the brief
  in that state, because `HANDOFF` refuses a stale review before it writes. The docs now say the
  line is a report of the refusal `workflow_advance` would give, seen by reading the file (or
  `workflow_status`) **before** attempting the move.
- **`tooling/mutation-check-handoff.mjs` (new)** closes the harness gap the review named: it
  injects the eight defects above (switch, root-brief target, append-instead-of-replace, dropped
  stale count, dropped OPEN line, project-level path for a unit, unflattened phase, unflattened
  waiver id), runs `test/handoff.test.mjs` after each literal edit, and restores `lib/` byte-for-byte
  under the shared mutation lock. 8/8 caught.

### Fixed — a browser-only red counted as a caught mutant in the three UI harnesses

`mutation-check-client.mjs`, `mutation-check-panel.mjs` and `mutation-check-project-tab.mjs`
spawn `test/status.test.mjs` directly and judged a mutant with `caught: failed.length > 0`. In the
DSH sandbox the layout case reaches Chromium and dies with `the browser exited early with
2147483651`, so the suite was red for an **environment** reason and every mutant looked caught
(measured: `M1 CAUGHT count=2`, exit 0). The three harnesses now run the unmutated baseline first
and share `tooling/mutation-verdict.mjs`, which splits real from environment failures and answers
`caught`, `missed`, `partial` or `NOT RUN`; only a real failing assertion can catch a mutant. A
baseline that cannot produce a verdict prints one line naming the browser and exits **2** (not a
pass; a surviving mutant is 1, APPLY-FAILED 4, an integrity failure 3), and the exit-code truth
table is shared and unit-tested — including the case where a typo'd mutant filter leaves zero rows.
`test/mutation-verdict.test.mjs` pins all four outcomes with synthetic spec and TAP output, no
browser needed. The end-to-end caught counts still need a normal terminal with a Chromium-family
browser: the three harnesses are **NOT RUN in-sandbox** after this change.

### Fixed — the review fence could pass a project it had never content-hashed

`lib/review-sandbox.js` compared files by content digest only while a 64 MiB budget lasted, and the
residue was compared by size and timestamp. A file that had no digest and whose size did not change
fell through the comparison entirely, so a **same-length rewrite of an unhashed file left the fence
reporting `clean: true`** and the changed bytes in the project (reproduced by the security review with
a 65 MiB fixture). On this repository that covered hundreds of entries, including `.dsh/FEATURES.json`
and `.github/workflows/ci.yml`.

The budget is now the snapshot's own copy cap: hashing is cheaper than the copy the fence already
makes, so **every project the snapshot accepts is fully content-hashed**, and a deliberately lowered
budget cannot come back clean at all. Files without a digest are reported for what they are — no longer
`"is unchanged"` — and "possibly changed" / "unverifiable" are part of the clean predicate instead of
being printed after a PASS.

Two related guards, from the same review:

- **Git's own bookkeeping is compared structurally, not by content.** The reviewer prompt tells the
  reviewer to run `git status`, which rewrites `.git/index`; a human's concurrent push appends reflogs
  and rewrites remote-tracking refs. A file's content change in the index/reflog/remote-tracking/lock
  paths is no longer contamination, while a deletion, an addition or a kind change there still is.
- **The restore side now has the delete side's link guard.** A restore used to write through any
  directory in the project; a junction planted where a deleted directory had been received the bytes
  instead. Ancestors are checked (native realpath, contained in the project, not a reparse point), and a
  project root that has been swapped for a junction is reported as `rootSwapped` with nothing restored.

Seven cases were added to `test/review-isolation.test.mjs`; the test helper that counts links was itself
weaker than the guard (it used `lstat`, which reports a Windows junction as a directory) and now uses
the parent `Dirent` plus the native realpath.

### Fixed — the approval gate classified the host's shell tool as "unknown"

The host moved its shell tool to `ops_bash`, supplied by an ops plugin rather than by DSH core, and
`SHELL_TOOLS` is a fixed name list: a plain `ops_bash{command: …}` classified `null` — deferred, i.e.
**no review at all** — and 16 of 16 destructive commands tried against it were missed. Destinations had
the same hole a level down: they were recognised only by an enumerated key, so
`ops_bash{script_path: "C:/Windows/x.sh"}` never produced the "outside the project" escalation.

Classification is now by **shape**: a tool whose name looks like a shell, or a call that carries a
program body under a command key, is `medium` (the name list is kept as a fast path); a string value
that is an absolute path is a destination whatever its key is called — except under a key that names
TEXT (`pattern`/`queries`/`old_string`/`content`/`prompt`/…), because `ops_grep{pattern: "/etc/passwd"}`,
`edit{old_string: "/api/v1"}`, `web_search{queries: ["/usr/share/doc"]}` and `subagent{prompt: "/plan
this"}` are not destinations and the false reason was itself a denial at the default strength; and
`cwd`/`workdir`/`cd` are judged as
working directories with their own reason instead of being counted as destinations. Exemptions,
exfiltration precedence and the unknown-tool default (`null` = defer) are unchanged. The
self-deployment exemption now shares both shape tests — a shell-looking NAME cannot reach it just
because the call carries no command key, and it reads the same shape-aware destination set, so an
unlisted absolute path outside the package removes the exemption instead of being invisible to it;
the installed copy's own conditions are otherwise unchanged. Six mutants were added to
`tooling/mutation-check-approval.mjs` for these rules.

Two follow-ups the PASSing review recorded as minors, fixed in the same day: a working directory
outside the project is checked **before** the self-deployment exemption (it received destinations
only), so `write{file_path: "<package>/x.js", cd: "C:/Windows"}` can no longer be laundered to `low`;
and `TEXT_KEYS` covers the structured-output citation keys (`verified`, `where`, `reach`,
`observations`), so a report quoting an absolute path is not read as an outside destination.

### Fixed — `workflow_gc action=list` could not read back what it recorded

Found while using the tool on this project (the dogfood feature): the list branch returns the entries
under `ledger.constraints`, but the report read a top-level `constraints` key that no branch produced, so
`action=list` answered with the ledger path alone. A rule written through the confirmed `action=add` path
could only be read with `cat .dsh/CONSTRAINTS.json`. The list now prints every entry (id, status, rule)
with its `retire_when`, and a mutant in `tooling/mutation-check.mjs` pins it.

---

## [Unreleased] — 2026-10-25

### Changed — the checkout is version 0.3.0

`package.json` moved from 0.2.0 to 0.3.0. The recovered tree plus the P3 changes is a different
artefact from the 0.2.0 release and from the `3d6dd16` build, so it needs a version of its own. It is
not a published release: no 0.3.0 build was published. It **was** the version deployed on 2026-10-25,
when 0.3.0 was synced to both install roots (see the header); check what is installed now with
`node tooling/sync-to-profile.mjs --check`. It records that the tree carries the P1/P2/B1+ code, the
P3 hardening and the recovery — none of which were in the 0.2.0 release.

### Recovered — the lost workspace

A `workflow_review` reviewer created a directory junction to the workspace and ran a recursive delete;
Node followed the link and emptied the checkout, taking git history, the `.dsh` state and the
uncommitted work. The tree was rebuilt from the DSH **session logs**: all 57 workspace logs were
decompressed, every successful `write`/`edit` was indexed and replayed onto the 0.2.0 tree between the
0.2.0 commit (`2026-10-24T05:09:29Z`) and the incident (`2026-10-25T04:51Z`), with CRLF normalised
first (the logs are LF, the checkout is CRLF), and the P0 review-isolation patch merged back with
`git apply --3way`. This is reconstruction by evidence, **not** a byte-for-byte git restore. The
durable record — the exact method, the verbatim lock-probe results, the handoff corrections and what
still cannot be claimed — is [`docs/RECOVERY.md`](docs/RECOVERY.md).

Two corrections to the first handoff, which are the reason it was rewritten: the installed copy it
called "P2.B1+" was not that baseline — `lib/git-changes.js` existed nowhere on disk, and the deployed
`lib/` predated the git cross-check entirely (nothing in it referenced `git_cross_check`, while the
recovered tests exercise it); and the junction facts are narrower than first stated: a junction created
**inside the DSH sandbox** with `fs.symlinkSync(target, path, 'junction')` (its substitute name
rewritten to `\??\Global\C:\…`) is invisible to `lstat` (measured: `isSymbolicLink()` false,
`isDirectory()` true) and to `realpathSync` (it returns the link path itself), while
`realpathSync.native` resolves the target and `Dirent.isSymbolicLink()` flags the entry — but an
**ordinary** Windows junction is reported by `lstat` as a symlink and resolved by `realpathSync`, so the
guard uses native realpath plus Dirent, which see both spellings (see `docs/PITFALLS.md`). Test totals
are not restated here; they drift.

### Added — the lock probe no longer invents a verdict

`tooling/mutation-check-lock-probe.mjs` captured its child through a piped `spawnSync`. The DSH
sandbox denies that pipe (`EPERM`), so the child never started, `status` came back `null`, and the
probe read "nonzero" as "the mutant was caught": it printed `4/4 caught` with zero tests executed.
It now calls a mutant caught only when a real test failed next to a passing one, runs the unmutated
baseline first, and reports `NOT RUN` with exit **2** when no honest verdict exists (the sandbox
without `DSH_WORKFLOW_SANDBOX=1`; a normal terminal runs the real L1–L4 mutants). The exit codes are
documented as not-a-pass where they are not a pass, and `test/lock-probe.test.mjs` pins the verdict
classes.

### Fixed — the review fingerprint and `sync --check` are line-ending insensitive

The review fingerprint hashed raw bytes while this checkout holds both styles (every tracked blob is
`i/lf`, a number of files are `w/crlf` on disk), so re-materialising a file's endings — a fresh
checkout, a restore from an LF session log, an editor normalising on save — marked an unchanged
reviewed file STALE and made `COMMIT`/`HANDOFF` refuse an artefact the review had approved. The same
bug made `tooling/sync-to-profile.mjs --check` print `DIFFERS` for an installed copy that was the same
text. `lib/eol.js` is now one shared rule: CRLF and a lone CR fold to LF for identity checks only, LF
content is returned as the same Buffer (so every digest recorded before the change keeps its value),
and content containing a NUL byte is treated as binary and left byte-exact. The sync decision moved
into `tooling/sync-plan.mjs`'s `planSync` so it can be tested without a deployment. Pinned by
`test/eol.test.mjs`.

### Fixed — the small defects routed from the P3 reviews

- **Snapshot cleanup keeps trying for longer.** The guarded delete now retries 8 × 250 ms and Node
  backs off linearly, so the window is ~9 s instead of ~1.8 s (the old 5 × 120 ms); a reviewer's
  own `npm test` children were still holding the copy after the shorter window. It stays bounded,
  and a failure still reports the path to delete. A test pins the window, the fact that the delete
  guards run BEFORE the delete is attempted, and the reported path.
- **`sync-to-profile.mjs`'s exit code is now a pinned contract.** An absent `DSH_WORKFLOW_SRC`
  exits 1 with `the workspace root does not exist`; the old script printed `absent:` and exited 0,
  which made a mistyped root look like a clean run. `test/sync-to-profile.test.mjs` holds it.
- **The changed-files alias test can now fail.** The fixture is a junction ancestor instead of an
  uppercased path (which `path.win32.relative` folds), so reverting `canonicalPath` reproduces the
  `..\..\` bug on any Windows machine rather than passing.
- **Docs no longer restate drifting test totals.** The stale 576/569 figures in README, TESTING,
  CONTRIBUTING and ROADMAP say "0 fail" instead, which is the only number that must not drift.
- **`workflow_status` refuses an unusable `work_unit`, like every other tool.** The label used to be
  passed straight to `readFeatures` and `readState`, which printed the validator's sentence twice
  under `feature file problem:` — a caller whose ARGUMENT was wrong was told its feature file was
  broken — and a project that had not opted in swallowed the label entirely. It is now validated
  before anything is read and refused with `bad-work-unit`, naming the accepted characters; the
  renderer prints that refusal instead of throwing on a payload with no report sections.
  `test/work-unit.test.mjs` pins the wording, the single sentence, and the non-opted case.
- **Reviewer step 4 no longer points at a list that may be absent.** With a `changed_files` list the
  step says to compare `git status` against it; with none it says git is the only scope evidence and
  does not emit "listed above" (the file-list section is not rendered in that case either). Both
  branches are asserted in `test/review.test.mjs`; before that test existed, reverting the branch
  left the suite green. **The git cross-check section had the same defect and now reads the same
  fact**: an explicitly EMPTY `changed_files` (schema-valid) used to render "the list above" while no
  list section existed — found by the 2026-11-01 re-review, fixed, and pinned in the same test file.
- **Housekeeping:** `collectGitChanges` owns its JSDoc again; `sync-plan.mjs` no longer exports its
  internal `walk`, reuses `sameTextContent`, and its `mkdir` comment states the measured truth
  (`fs.cp` creates missing destination parents); the governance harness's `PASSEED` typo is fixed,
  its exit-code collision with the lock refusal is documented with why it is kept, and the lock
  probe's GREEN rule is aligned with it.

### Added — mutation coverage for HANDOFF governance, the waiver and the docs fast lane

`tooling/mutation-check-governance.mjs` adds seven mutants for the rules `test/governance.test.mjs`
states: the open-feature refusal, the empty-waiver-reason refusal, the waiver's durable audit record,
the docs `BUILD → EVALUATE` edge, the "no recipe adds `BUILD → COMMIT`" invariant, the immutable base
graph, and the fast-lane announcement. Unlike the other harnesses it never writes `lib/`: every mutant
runs the real suite in a unique `%TEMP%` copy, so no mutant can reach the canonical sources, and its
integrity line `canonical sources unchanged ... YES` checks `lib/tools.js` and `lib/advance.js`
byte-for-byte. It still takes the shared `tooling/.mutation-lock` like every other harness. Its verdict
logic is itself pinned by `test/governance-mutation.test.mjs` (a red baseline, a crash with no passing
test, and red-for-the-wrong-test are each NOT a catch). Measured 2026-10-25: baseline green, G01–G07
all CAUGHT (read the harness output for the counts). `lib/review.js` now discovers it, so a change to
`lib/advance.js` or `lib/tools.js` names it in the harness plan.

### Fixed — a review can no longer destroy the project it reviews

On 2026-10-25 a `workflow_review` reviewer created a directory **junction** to the workspace under
`%TEMP%` and ran a recursive delete; Node followed the link and emptied `D:\DSH_Work\WorkFlow`,
taking the git history, the `.dsh` state and the uncommitted work with it. The review result itself
labelled it "reviewer-side data loss, not a defect in the author's change" — the harness allowed it.

What the measurements showed (Node v24.18.0, Windows): a review child inherits the **parent's**
working directory and file policy — a `cwd` in the spawn request does not move its sandbox root, and a
write into the real project still succeeds. A plugin cannot make a child it does not control
read-only. A junction created *inside the DSH sandbox* with `fs.symlinkSync(target, path, 'junction')`
is invisible to `lstat` and unresolved by `realpathSync` (only `realpathSync.native` and `readdir`'s
`Dirent.isSymbolicLink()` see it); an ordinary Windows junction such as `C:\Documents and Settings` is
reported as a symlink — so the guard cannot depend on either spelling. See
[`docs/PITFALLS.md`](docs/PITFALLS.md) for both measurements.

So the guard is the **transaction**, not a prompt. `workflow_review` now snapshots the project into an
isolated temp root (a real copy, never a link; links are audited and escaping ones refused), points the
reviewer at that copy, and re-scans the real project when the child finishes: deletions are restored
byte-for-byte, modifications and additions are reported but not reverted (a concurrent human edit is not
the reviewer's doing), and any difference makes the review **contaminated** — it cannot pass at any
score, and its verdict is discarded. The copy is removed only if it is not a reparse point, contains no
link, resolves inside the snapshot root, does not contain or equal the project, and its root still
carries the marker this plugin wrote; the canary outside the copy must survive. A snapshot that cannot
be built (unreadable tree, escaping link, size caps, failed copy) means **no reviewer starts**, and a
snapshot is kept when it is the only remaining copy.

New module `lib/review-sandbox.js`; every case lives in `test/review-isolation.test.mjs` (the count
is not restated here because it moves with each added case), including an incident replay that deletes
the project through a junction and requires every byte back. Mutation check (manual,
throwaway copy): removing the restore → 3 red; ignoring the contaminated fence → 4 red; removing the
reparse-point delete guard → 1 red.

---

---

## 2026-10-25 — P2 governance (deployed at `3d6dd16`)

These are user-visible changes on top of 0.2.0. They were written before a deployment and were synced
later: the build at that point matched commit `3d6dd16`, which contains this code (measured 2026-10-25,
modulo line endings). `3d6dd16` was this code's first deployment, and the later 0.3.0 sync replaced it;
what is installed NOW is a question for `node tooling/sync-to-profile.mjs --check`, not for this entry.

### Added

- **HANDOFF refuses while features are open, and can be waived explicitly.** `workflow_advance` to
  HANDOFF returns `open-features` and names the unfinished features. The only way past it is
  `waive_open_features: true` plus a non-empty `waiver_reason`; the waiver is recorded in
  `.dsh/WORKFLOW.json` (`waivers`) and in the transition's history entry, and echoed in the reply.
  A waiver waives the **feature count only** — a stale reviewed PASS, unreadable evidence or an
  illegal transition still refuse — and a blank reason is refused. The reason is capped at 500
  characters where it is stored and rendered. **In the `3d6dd16` build.**
- **`workflow_status` reports feature counts and the open set:**
  `features: 1/2 complete, 1 open` plus one `open:` line per unfinished feature, so "phase EVALUATE"
  no longer hides remaining work. The block is additive: a project with no features renders exactly
  as before. A corrupt `FEATURES.json` now prints its `feature file problem` even when the file
  reads as zero features, which is precisely when the problem is the only useful fact. **In the
  `3d6dd16` build.**
- **`recipe: docs` has a fast lane.** The phase machine may go `BUILD → EVALUATE` directly, skipping
  `VERIFY`, and the move names what it skipped. That is the only edge the recipe adds; no recipe
  adds `BUILD → COMMIT`, and `COMMIT` itself is not review-gated (`VERIFY → COMMIT` exists). Other
  recipes keep the plain graph. **In the `3d6dd16` build.**

### Fixed

- **The declared `changed_files` is cross-checked against git.** When the reviewed project is a git
  checkout, `git status` is read through argv (never a shell) and a path the declaration omitted is
  added to the classification evidence and to the reviewer's prompt; git's own bookkeeping files are
  excluded. A capped scan (>400 sorted paths) is reported as `complete: false` and
  `workflow_review` returns `changed-files-incomplete` **before starting a reviewer or resolving a
  class**, because a security path sorted after the cap was never evidence.
  The durable evidence row's `files` / `files_fingerprint` cover the declared reviewed set plus
  **tracked** modified additions only; untracked (`??`) additions are still prompt/class evidence and
  are recorded in the bounded `git_cross_check.untracked`, but deleting a scratch file after a
  review no longer turns a fresh PASS into a false STALE. Git paths keep leading/trailing spaces, so
  a filename with a leading space is not collapsed into its sibling. **In the `3d6dd16` build.**

---

## Unreleased — P2.B1+ (code deployed at `3d6dd16`; docs and tests not)

This batch was committed on `fix/p2b1-plus` and its **code** was in the `3d6dd16` build as deployed
then (measured 2026-10-25, modulo line endings). Its tests and documentation were **not** deployed at
that point: a `file:` dependency copies the package's listed files, and `docs/`, `test/` and the
`run-*.mjs` scripts are not all in `files`. It was never exercised as a released build; do not read
the code installed from any build as a 0.3.0 release.

### Fixed
- **Mutation harnesses now run inside the DSH Windows sandbox.** Each harness captured its child through a
  pipe, which the sandbox denies (`EPERM`), so the harnesses could not start their child there. They now
  capture stdout/stderr through temp-file descriptors (`tooling/child-output.mjs`); TAP parsing, exit
  codes, the shared lock, restoration checks and printed wording are unchanged. Verified by
  `mutation-check-approval.mjs`, `mutation-check-verification.mjs` and `mutation-check-work-unit.mjs` in
  the sandbox. The settings-page, panel and project-tab harnesses still need a normal terminal because
  they launch Chromium.
- **The bootstrap `open_feature` message no longer contradicts the report.** A satisfied item used to say
  "Every feature is already complete; move to HANDOFF." while features were still open, because its todo
  branched on `counts.total > 0`. Both halves now read `counts.open > 0`; covered by
  `test/governance.test.mjs`.

### Added — governance and a docs fast lane
- `workflow_status` reports feature counts and the open feature list.
- `HANDOFF` is refused while features are open. The only way past is an explicit `waive_open_features`
  with a non-empty `waiver_reason`, recorded in the state; a waiver never waives a review.
- `recipe: docs` adds exactly one edge, `BUILD → EVALUATE`, skipping `VERIFY`; no recipe adds
  `BUILD → COMMIT`, and review still gates completion.
- The author guidance now tells the author to run `git status --porcelain` before review and declare
  every changed path; the reviewer prompt tells the reviewer to run it and report omitted paths as issues.

### Changed — the first framework cross-check prototype was dropped (later re-landed)
- A framework-side check of `changed_files` against `git status --porcelain` was prototyped and **not
  landed at that point**. `git status` sees only uncommitted changes (so it is not a security boundary), its default
  piped runner is denied in the sandbox (`EPERM`) so the check fell back to the declared list and reported
  `NOT CHECKED`, and its marginal value did not justify 649 implementation lines plus roughly 1,240 lines
  of tests and four failed reviews. The reviewer-side instruction above replaced it then; the check was
  **re-landed later** with argv-only git execution, evidence addition and a bounded scan — see the
  "P2 governance" entry above and `docs/DESIGN.md` §11.3, which records why a real design would need a
  base-commit diff.

### Testing
- Unit suite: **0 fail** in the DSH sandbox; the environment-gated cases skip with a reason (see
  `docs/TESTING.md` Layer 1.1), and a normal terminal runs them too. Totals drift as work lands, so
  they are not restated here.

---

## [0.2.0] — 2026-10-24

The A1–A5 batch, plus the follow-up hardening found by independent review. The final release candidate
was independently reviewed (security class, PASS 8.86), synced byte-for-byte to both plugin roots, and
live-verified after a DSH restart: `workflow_status` reports `startActivation=yes`, and a delegated
child's gate-weakening write was refused automatically and left the probe file unchanged. This paragraph
was corrected by a docs-only follow-up after deployment; no code changed.

### Fixed — the A1–A5 bug-fix batch

- **A1 — `workflow_status` and `workflow_review` disagreed about delegation.** Status probed `ctx.get`
    then the property; review read `exec.subagents`, the registration-time property, and the OUTER
    context, so a service reachable only through `get` was invisible to review. Both now use one
    `resolveSubagents()` at call time; `lib/index.js` passes a live getter; status prints a separate
    `review route:` line.
    The service API also has two generations: older hosts expose `subagents.start(provider, request)`,
    while the current host exposes `subagents.startActivation(spec)` and **no `start`**. Requiring
    `start()` (the first A1 fix) correctly rejected a decoy but also rejected the real current-host
    service, which is why the live status said `probe service start=NO`. Resolution now accepts either
    entry point and prefers a service-shaped property over a `get` facade; the review calls
    `startActivation({ provider, label, request, signal, delivery: 'caller' })` when that is what the
    host has. Regression tests cover a get-only service, a decoy, `startActivation`-only, and the
    get-facade/property fallback.
- **A2 — the approval gate could be lowered by the session it judges.** The refusal text named
    `workflow_set path=approval.strength value=llm-only/off`; `workflow_set` was classified `low`; the
    write needed no confirmation and took effect on the next call. That is a self-authorization, and it
    is now closed in four layers: a human-only remedy text; a tool-level refusal of weakening writes
    (root can apply one only after a real `userQuestions` confirmation, a child cannot); the pre-execute
    gate classifies gate-setting writes as `medium`; and the process keeps the strongest gate it has
    seen per project, so a direct file edit or a deleted opt-in file cannot lower or switch it off until
    a restart. A live child probe exposed two more holes in the gate layer: the pre-execute resolver
    read only the session cwd, so `workflow_set workspace_dir=<target>` could leave the gate inert;
    it now judges the explicit target project for `workflow_set`/`workflow_init`. And the shared
    confirmation helper hardcoded the constraint-ledger sentence, so a refused gate write named the
    wrong file; the wording is now parameterised, says the refusal is automatic rather than a human
    declining, and names the root-conversation/user remedy. Every write to an approval/evaluator/
    verification section is now confirmable, not only a delta the writer models; the delta for a
    non-approval write is measured against the file, so confirming a verification change cannot clear
    the approval memory and legitimise an earlier direct edit. `workflow_status` reports
    `DOWNGRADE IGNORED` / `OPT-IN FILE MISSING`. A `dry_run` of a gate-setting write now validates
    and reports without asking or writing, and the report still records that the real write would
    require confirmation. The decision to make it strict was the user's: the agent cannot change the
    gate on its own.
- **A3 — the test runner was blocked by the DSH sandbox.** `npm test` now runs `run-unit-tests.mjs`,
    which detects the sandbox's piped-child `EPERM` and sets `DSH_WORKFLOW_SANDBOX=1`; the six
    environment-dependent tests (five mutation-lock races and the Chromium layout measurement) skip with
    a visible reason, so the suite was 525 tests / 518 pass / 7 skip / 0 fail in the sandbox at the time. A
    normal terminal does not set the flag and runs them. `npm run test:sandbox` forces the mode.
    `tooling/mutation-check.mjs` also normalises CRLF for anchor matching, restores the original
    Buffer, refreshes its M15 anchor, and exits 3/2/1 on restore/apply/survivor failures. The
    standalone M6 mutant is removed because the validator masks it (M6b remains the meaningful
    mutation), and the M11/M17 must-lists now name the assertions that actually catch them. Result:
    27/27 caught, exit 0.
- **A4 — the change classifier treated an external project's `.js` as a security surface.** The
    built-in lists describe this plugin's own repository, so every unknown external source failed
    closed. A project can now declare `verification.sources` / `security` / `ui` and explicitly set
    `allowUnknownSources: true`; the built-in lists apply only to the installed plugin's own package;
    an invalid classification is ignored as a whole, not half-applied. Under `advisory`, a contradicted
    declaration now says `DECLARATION CONTRADICTED` instead of printing `CLASS REFUSED` for a refusal
    that did not happen; `enforced` still refuses. A project file the parser could not fully read is
    no longer merged as "verification not configured": the review uses the strict fallback
    (`enforced`/`always`, unusable classification) instead of silently running under `off`.
- **Release hardening (0.2.0).** `workflow_set`/`workflow_init` now refuse a present-but-unreadable
    project file instead of dereferencing `null` or overwriting it; the verification writer is
    re-validated by the same reader as the gate (policy, confirmation, report, classification, and
    unknown keys, and nested paths are refused); an unreadable harness table is carried into
    status/audit as "UNREADABLE", not read as "no harness covers this"; the static model guidance no
    longer asserts a project policy it never read; the init render carries the refusal reason; the
    status version is read from `package.json`; repairing an unreadable approval section clears the
    stale "gate broken" flag while keeping the stricter per-axis values; and the diff parser reads
    only header blocks, unquotes git paths, and handles `diff -ru` boundaries. The release tooling is
    path-portable and has a Windows CI workflow.
- **A5 — a review that did not run was recorded as a FAIL.** `workflow_review` stored every
    `runReview` outcome; `unavailable`/`misconfigured`/`exhausted`/`incomplete` then became
    `passes:false`, `attempts+1`, a `blocked_reason`, and an evidence row with null
    round/overall/fingerprint. Only `status === 'reviewed'` is stored now, and `record-review` refuses
    a non-verdict even if one arrives another way. A "review did not run" is no longer evidence for
    either outcome.

### Added

> **Deployment status as of 2026-10-25.** The items below that say "Not deployed" were written at the
> 0.2.0 release, before the P2.B1+ batch was synced. Their code was in the `3d6dd16` build as deployed
> then; the renders and real-host checks some of them call unverified are still unverified (see
> ROADMAP.md). The tags are kept as the state at the time they were written.

- **Risk-graded verification depth** (`verification.policy`). A change can be declared
  `docs` / `ui` / `logic` / `security`, and the framework checks that declaration against the files
  actually changed. The resolved depth is the **stricter** of the two, so a declaration can only add
  cost, never remove it; `security` is not degradable at any setting, and a refusal names the
  contradicting file while still reporting the class and depth that will be used. `ui` asks for a human
  to look at the rendered result in addition to the unit suite and every covering mutation harness.
  Two fail-closed rules: the shallowest class with no evidence is refused, and no declaration with no
  evidence raises the depth to the every-harness rung, with review as the substitute when no harness
  covers the files. **`verification.policy` defaults to `off`
  and changes nothing until it is enabled** — with it off, an undeclared call behaves byte-for-byte as
  before. Not deployed.
- **The conversation tab 「工作流（本工程）」**, a read-only view of this project's workflow. Not
  deployed.
- **The project tab now shows the actual effective configuration** rather than only the file's path,
  its raw text and its explicitly set top-level keys. It shows the answer first and the raw text after
  (kept as the checkable authority), one group per top-level section in the defaults layer's own key
  order, and one row per setting as dotted path + value + **layer badge**: `本工程覆盖` (project
  override, with `默认值：X` appended only when the inherited value differs), `继承自默认值`,
  `未知` (no value shown), or `已拒绝→fail-closed` (with `文件要求：X` and the reason). An overview
  line counts project overrides, inherited values, unknown values and fail-closed values, computed from
  the same rows the table renders. A project with no `.dsh/workflow.yml` says "not opted in" and shows
  **no defaults table**. Not deployed.
- **Work-unit isolation.** `workflow_advance`, `workflow_review` and `workflow_gc` take an optional
  `work_unit`; state then lives in `.dsh/work/<id>/` instead of `.dsh/`, so a delegated child can drive
  its own phase machine without colliding with its parent's. The default path is byte-for-byte
  unchanged, no existing file is migrated, and `workflow_status` lists units and reports nothing when
  there are none. Unit ids are a **path segment**, so an unusable id is refused rather than sanitised.
  **Not deployed** — the journal records this as deliberately not synced, and warns that the sync must
  carry the new `lib/work-unit.js` or tool registration fails at import; `TESTING.md` §6 later records
  it as verified on a real host, which implies a sync happened afterwards. The two sources are not
  reconciled here.
- **The sidebar 「工作流设置」 panel.** A sidebar entry plus its body, registered from the existing
  browser bundle (not a second bundle: a `<package>/panel` row can never ship one), gated by
  `showInSidebar`. Turning the panel off leaves the six tools working — "panel disabled, tools
  unaffected" is the point. The switch can be switched back on from the panel row's own settings page,
  which is the only in-product recovery path, because `showInSidebar` lives in the profile patch above
  `.dsh/workflow.yml` and the writer rejects booleans. **The rendered result has not been seen** — see
  ROADMAP.md. Not deployed.
- **A self-deployment exemption in the approval gate.** Deployment previously had to be performed out
  of band, leaving no audit record, or by opening a configuration window to disable the gate. The
  exemption authorises file tools carrying explicit destination paths when every destination resolves
  inside the plugin's **own installed package directory**, every source is inside the session project,
  and the call is neither a shell/exec channel nor anything carrying a command/script body. The anchor
  is the directory the running module was loaded from — **not a config item**, with no way to point it
  at an arbitrary path. It runs **after** the exfiltration rule, so a call that also looks like
  exfiltration stays high and is still refused monotonically, and `approval.strength`, the risk
  threshold and `approval.denyHighAlways` all still apply. Authorised releases are counted
  (`selfDeployAuthorised`, incremented only on a real release) and logged on an `info` line naming the
  anchor; an unresolvable anchor reports **DISABLED** rather than widening the range. **This cannot
  authorise its own first deployment** — the copy currently running the gate predates the exemption, so
  the first sync still needs a human or a session the gate does not govern. Not deployed.

### Fixed

- **The sidebar switch wrote the core row while the gate read the panel row**, so the switch did nothing
  at any value — with 417 tests green, because nothing bound the namespace written to the namespace
  read. The switch and the gate now use the same panel controller, with a regression test named for
  exactly that property.
- **The panel body had no translation seat** and rendered Chinese in an English session without
  re-rendering on language change. `locale` is now declared on the body registration as well as the
  icon, and on the row settings registration, which had the same pre-existing gap. In the same change,
  the panel row registers its own settings page so the sidebar switch is no longer a one-way door.
- **The sidebar panel's label column was about one character wide**, wrapping Chinese labels one
  character per line, and the panel rendered as two columns even though the source was already
  single-column. Root cause: `minmax(0, 1fr)` resolves to 0 in a grid with no definite width, and each
  hint's `grid-column: 2` **created** the implicit second track that took the width. The row template is
  now `100%` (definite), hints and warnings span `1 / -1`, and rows carry a full-width divider. Measured
  in a real engine: `0px 244px` → `264px`, with the settings page unchanged as the control. Not
  deployed; the visual result is still a human's check.
- **Flattening of user-editable fields was incomplete** in the advance, GC and constraint reports: a
  newline in a rejected work-unit id, a phase name, feature text, a `blocked_reason`, or a constraint's
  `rule`/`why`/`signal` could forge a whole extra line in the report a model reads. `rule` was injectable
  through the legitimate `workflow_gc action=add` path, with no hand-edited file needed. One shared
  `oneLine()` now covers the C0/C1 range including U+0085, U+2028 and U+2029. The fixes that followed
  the second review round have **no independent review coverage** — the review budget was exhausted;
  see ROADMAP.md.

### Changed

- **Mutation harnesses can no longer run concurrently.** Two running at once previously left **two
  mutants permanently in the source tree while both processes printed `sources restored byte-for-byte:
  YES`** — each verified only its own restoration. A shared lock now refuses the second harness loudly,
  exiting 2 with no queueing, and one harness that had never verified its own restoration now does
  (exit 3 if it fails). Stale-lock takeover no longer treats an unreadable age as infinitely old: an
  unreadable age with a live holder is **refused**. Contributor-facing; no deployment required.

---

## 2026-10-12

### Added

- The settings page gained the nested controls that previously required `workflow_set`: a checkbox list
  of the 13 `modules.*` switches, review dimensions, each veto dimension, the subagent depth cap
  (offering only 1 and 2, because `maxDepth` is an absolute tree bound and the reviewer needs depth 2),
  the concurrent-subagent cap, approval exempt tools, and the three `retireCheck` fields. The list of
  module keys is derived from the configuration itself, so adding a module in `lib/config.js` makes the
  control appear without touching the browser code. Deployed (`sync complete: 4 copied, 19 already
  identical`) and the rendered page was verified from a user screenshot.
- The panel and page layout styles are now measured rather than asserted: a headless-Chromium tool
  resolves the grid geometry of both surfaces, and the style objects are extracted **from the shipped
  `lib/client.js`** so the test measures the published styles rather than a transcription. Where no
  Chromium-family browser exists, the case is skipped and says the geometry cannot be measured.

### Fixed

- **Lost updates when two controls in the same configuration section were clicked within one
  round-trip.** The second write expanded a stale copy of the whole section and reverted the first
  click — reachable with approval strength + risk threshold, and with the acceptance bar + independent
  review. Every nested write is now a single-key operation built by one shared helper, and the
  settings page cannot write a value the host's readers will reject (for example an empty `dimensions`
  list, which the host accepts and the gate then rejects, leaving a project where every review fails).
  Removing a dimension from the scoring list prunes it from the veto list in the same atomic write.
  Deployed.
- **Module list keys** are derived from the snapshot, and each is written as one nested operation;
  `modules.isolation`'s control had written the whole `modules` section. A non-object `modules` section
  renders a placeholder instead of crashing.

### Changed

- **The refusal message for an unsatisfiable approval policy no longer reads as a human declining.**
  When approval prompts are unavailable in a session, `approval.strength: ask-user` auto-denied every shell
  call with `the user rejected tool "pwsh"` — indistinguishable from a human declining, and it locked the
  plugin's own development environment. The gate now probes whether this session can answer an approval at
  all and, when it can prove it cannot, refuses with an explanation that says the denial was **automatic**,
  that nothing ran, and that retrying cannot help, plus the remedy. When it cannot prove it, the original
  behaviour stands — an unreadable channel is never reported as disabled. `workflow_status` marks the
  configuration as **unsatisfiable here** when it can probe, and otherwise prints an explicit IF-clause
  rather than claiming a probe. No allow/deny decision changed. Deployed.
- `evaluator.maxRounds` is **2**. Running out of review rounds returns `exhausted`, which is a
  **terminal state** — take it to real-host verification or to a human rather than trying to open another
  round. This is the review budget; `acceptance.maxRounds` stays 3, because negotiation rounds are not
  review cost.

---

## 2026-10-11

Working down from the earliest record: the journal supports only this date as the earliest dated work below.
Item A (graphical parameter editing) is not dated in the journal and is grouped here rather than assigned a
date the sources do not support; the six tools likewise include work that predates this date.

### Added

**The six tools.** Each is a name a model can call; the "writes?" column is the user-visible contract.

| Tool | What a user gets | Writes? |
|---|---|---|
| `workflow_status` | phase, effective configuration, resolved verification depth, service availability, host diagnostics. Read-only. | no |
| `workflow_init` | opts a project in by creating `.dsh/workflow.yml`. Idempotent, atomic. **The plugin is inert for a project until this file exists** — installing it does not change any existing conversation. | yes |
| `workflow_set` | reads or changes one project-level parameter, with path and enum validation; refuses to write to a project that did not opt in | yes |
| `workflow_review` | starts a fresh reviewer subagent for an independent verdict, taking a change class and `changed_files`/`diff` so the declaration can be checked rather than believed | records a verdict |
| `workflow_advance` | drives the phase machine, refuses illegal transitions and names the legal ones | yes |
| `workflow_gc` | shows which constraints are due for retirement. Only `scope=constraints` is implemented; `scope=code` and `scope=docs` **refuse** rather than pretend | asks first |

- **The phase machine**, `INIT → PLAN → PICK → NEGOTIATE → BUILD → VERIFY → EVALUATE → COMMIT →
  HANDOFF`. `BUILD` is refused until the project's own boot checklist passes, so a broken base is fixed
  before new features start. Deployed and verified on a real host.
- **Reverse self-certification.** A feature is marked complete **only** by the framework, from a review
  this session actually ran. A model claiming a pass writes nothing — even if it really did call
  `workflow_review`, if that review did not pass. Verified on a real host: with no review, the call is
  refused with "a claim that one passed is not evidence".
- **Independent review in a fresh subagent**, with the framework recomputing the total and running
  `mustPass` itself rather than trusting the reviewer's headline score. A reviewer's inflated average
  cannot override a failed veto dimension, and a duplicated dimension takes the lowest score. Missing
  reviewer, non-`completed` stop reason, or unparseable JSON all make `passed` false rather than
  "looks fine".
- **Review fingerprinting.** A pass hashes the reviewed files and the diff; editing them afterwards
  invalidates the approval, and the approval only authorises the next commit. Deployed.
- **Review calibration by reachability.** Every issue must declare whether it is reachable and give a
  concrete call sequence. Only reachable defects may push a veto dimension below the bar or block
  delivery; unreachable findings are still reported and displayed, but do not block. A low score with no
  supporting issue **does** block — a score is not evidence. This is what stopped an adversarial review
  loop that previously ran 40 minutes without converging.
- **The approval gate**: a `tools/pre-execute` listener (not `approval/request`, whose request body
  carries no tool arguments, so risk could not be judged) plus a monotonic guard that no later listener
  can flip back to allow. Three risk levels reused from the official model: `low` passes, `medium` is
  handled per strength, `high` is always denied. **Four strengths**: `ask-user`, `llm-then-user`,
  `llm-only`, `off` — where `off` still denies `high` while `denyHighAlways` is true. Anything
  unclassifiable is handed back to the host's own pipeline rather than turned into a denial. A broken
  approval section falls back to the strictest legal values, and unreachable `llm` or a protocol
  mismatch denies rather than passing. Deployed.
- **The constraint ledger with retirement conditions.** A constraint can only be retired when the
  framework has genuinely computed every declared condition, and a **natural-language retirement signal
  is always reported as needing a human** — never as satisfied, and never as unmet. Adding or retiring a
  constraint requires an exact option-label confirmation from the user; a typed custom answer is not
  consent, and a hand-built confirmation object cannot pass. Retirement is a mark, never a delete.
  Deployed and verified on a real host.
- **The graphical settings page** for the plugin's defaults, and the diagnostic line that explains it:
  `namespace census: status=ready serves=[…]` — whether `serves` contains your row is the only
  criterion for "the namespace is served". Verified on a real host.

### Fixed

- **The settings page disappeared silently.** `Config` must be a module-level static export:
  assigning it after `ctx.inject` resolves meant the host read `undefined` while building the namespace
  catalogue, dropped the entry, and closed the browser-side gate — with no error. Each Loader row must
  also carry `Config` **itself**, because the host reads the export of the module that row loaded; the
  core row had been dropped for exactly that reason. Permanent check:
  `node tooling/check-installed-config.mjs`. Deployed.
- **`maxDepth` was 1**, which forbade this plugin's own recommended architecture: main(0) → orchestrating
  child(1) → reviewer(2). Raised to 2, still bounded — the reviewer cannot delegate further. Found on a
  real host.
- **A tool call could fail with `cannot get property "subagents" without inject`** when the tool was
  registered on a context that had never declared the service. Registration now goes through
  `ctx.inject`, and the smoke test asserts the wiring.
- **`workflow_init` and `workflow_set` silently dropped `workspace_dir`** and then reported success —
  writing to the cwd project instead of the requested one. The host discards undeclared parameters with
  no error, and a delegated child's cwd is routinely not the project directory. All project-scoped tools
  now share one workspace resolver **and** a declaration test, because "not declared" is the actual
  cause. Found on a real host.
- **`action=pick` did not change phase**, and its reply said "allowed next: PICK" while already in PLAN.
  `record-review` also demanded the `diff` be retyped, and blamed the caller ("the files were changed")
  when nothing had changed. Both fixed with regression tests and mutants.
- **`bar: abc` silently disabled every veto** (`score < NaN` is always false). Values are now validated
  by type, not by coercion — `Number('')` and `Number([])` are 0 and `Number(true)` is 1, all inside the
  legal range. The same hole had a second door in a whole-section write and a third in the settings
  panel (`Number('')` → `bar: 0`, the most permissive legal value), so all four surfaces now share one
  gate definition.
- **`mustPass: []` failed every review** while `workflow_status` reported the configuration healthy:
  one function, two call sites, two different options.
- **`Date.parse` accepted garbage**, which turned three fail-closed guards into dead code:
  `added_at: 'sometime in 2026'` was reported as provably due with "283 day(s) since added_at sometime
  in 2026", and an unreadable window was treated as an open window. A strict reader is now used
  everywhere, with a UTC round-trip check so `2026-02-31` is not silently rolled forward to `2026-03-03`.
- **Self-loop log lines counted as phase transitions**, so "five BUILD entries" could be satisfied by
  five log lines that never changed phase.

### Changed

- Risks as measured against the four strengths are unchanged; `high` still always denies.
- Review verdicts gained reachability: only reachable defects may push a veto dimension below the bar or
  block delivery. See the Added entry above.

---

## Notes on what "deployed" means here

`file:` dependencies are copies, not symlinks. After any change to the plugin's own code you must sync
and restart DSH, and hard-reload the window (F12 → Network → Disable cache → F5 — `Ctrl+Shift+R` often
does nothing in Electron). Syncing **part** of the files is worse than not syncing: `lib/tools.js`
depends on `lib/work-unit.js`, and omitting the latter makes `tools.js` fail at import, removing the
plugin's entire tool surface.
