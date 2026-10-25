# Recovery record — 2026-10-25

What happened to this checkout, what was lost, what was rebuilt and how, and what still cannot be
claimed. Written because the first handoff got its central premise wrong in two places (see §3), and
because "the tests are green" is not evidence that the tree is the one that was lost.

**Read this with [`docs/TESTING.md`](TESTING.md)** (how to verify) and [`docs/ROADMAP.md`](ROADMAP.md)
(what remains unverified). The working handoff files (`HANDOFF.md`, `handoff/`) are not tracked and
are allowed to go stale; this file is the durable record.

---

## 1. The incident

On **2026-10-25**, during the review of the P3-1 lock-probe change, a `workflow_review` reviewer
created a **directory junction** to the workspace under `%TEMP%` and then ran a recursive delete.
Node followed the link and emptied `D:\DSH_Work\WorkFlow` at about **12:51–12:52 local
(04:51–04:52Z)**. The review result itself labelled it
`[blocker] REVIEWER-SIDE DATA LOSS, NOT A DEFECT IN THE AUTHOR'S CHANGE` — the harness allowed it.
The change under review was not at fault; the plugin's missing guard was.

**Lost with the tree:**

- `.git` history and every local commit hash; the P1/P2/F3 commits had never been pushed.
- The `.dsh` workflow state (`workflow.yml`, `WORKFLOW.json`, `FEATURES.json`, work units).
- `handoff/` backups and the recovery manifests inside them.
- The P1 test updates and the F1/F2/F3 test and documentation changes, which existed only in the
  working tree (and in the DSH session logs).
- The deploy helper (`deploy-p1.cmd`/`.ps1`).

**What survived:** the remote at `0.2.0` (`479868f`), the installed plugin copy under
`C:\Users\dengh\.dsh\plugins\src-12453345_-dsh-workflow`, the DSH **session logs**, and an older
`v0.1.0` tree under `%TEMP%`.

## 2. What was recovered, and by what method

The method is reconstruction **from evidence**, not a git restore. The authoritative commit message is
`dfe1e86` (`recovery: restore the lost F1/F2/F3 tests and the P2 lib from session logs`); this section
summarises it and the commits around it.

1. **Base.** `master` `b0a5ec8` is the `0.2.0` tree obtained through `gh api` as a zipball,
   because `git clone` over remote-https is blocked by the DSH sandbox's pipe restriction. The
   original `0.2.0` history is not in that zip; the commit is a new base with the same content.
2. **Session logs.** All **57** workspace session logs were decompressed with a frame-walking
   decompressor (`.tmp/recover-logs.mjs`; Node's own `zstdDecompressSync` stops at the first frame),
   producing roughly **135 MB** of transcript.
3. **Operation index.** Every `write`/`edit` tool call was indexed by `callId` and by the tool
   result's error flag (`.tmp/index-calls.mjs`), so an operation counts as applied only when the log
   says it succeeded.
4. **Replay onto the 0.2.0 tree.** Operations were replayed in recorded order between the **0.2.0
   commit time (`2026-10-24T05:09:29Z`)** and the **incident (`2026-10-25T04:51Z`)**. A file created
   after the release starts from its last full `write`; for a file that existed at the release the
   checked-out file is the base. An edit applies only when its `old_string` occurs **exactly once**
   and its `new_string` is not already present; every skip is reported rather than hidden.
5. **Line endings.** CRLF was normalised before matching. The logs are LF and the checkout is CRLF,
   and that mismatch alone had hidden most matches. (The durable fix for the same class of problem is
   `lib/eol.js`, added later by `22d94a1`.)
6. **The P0 patch.** The review-isolation change was merged back into the reconstructed `review.js`
   with **`git apply --3way`** — a 382-line patch, no conflicts.

**Honest limit.** 26 hunks could not be matched literally, all inside the F2 child's re-application
window (that child re-applied work other sessions had already done). Their behaviour is present by
other paths and the recovered F2 tests pass, but this is **reconstruction by evidence, not a
byte-for-byte restore**. Do not describe the tree as "the lost tree"; describe it as "recovered from
the recorded operations".

**What that produced.** The recovered F1/F2/F3 tests and docs, `lib/advance.js`, `lib/config.js`,
`lib/index.js`, `lib/review.js`, `lib/tools.js` and the previously missing `lib/git-changes.js`; the
P3-1 lock probe; the P0 transactional review guard (`c0cdc5c`); then the P3 features.

## 3. Handoff corrections

The first handoff (the lost `HANDOFF.md`, rewritten as a tracked record by this document) was wrong
about its central premise. These are the corrections, with how they were established:

1. **The installed copy was NOT the "P2.B1+" baseline.** At the time of the loss,
   `lib/git-changes.js` existed **nowhere on disk** — not in the installed plugin, not in the remote,
   not in the `v0.1.0` tree — and the deployed `lib/` **predated the git cross-check** entirely:
   nothing in it referenced `git_cross_check`, while the recovered tests exercise it. The F2 child's
   `lib/` edits are exactly the delta between that deployed copy and the final code, which is why
   they were replayed instead of copied. (`2806e7b` first copied the installed `lib/`; `dfe1e86`
   rebuilt it from the logs and added `git-changes.js`.)
2. **`lstat`/`realpathSync` and junctions need a scope, not a slogan.** The first correction said
   flatly that on Windows `lstat`/`realpathSync` do not see a junction and only
   `realpathSync.native` and `Dirent.isSymbolicLink()` do. Measured on 2026-10-25:
   - a junction created **inside the DSH sandbox** with `fs.symlinkSync(target, path, 'junction')`
     has its substitute name rewritten to `\??\Global\C:\…`; for that link `lstat().isSymbolicLink()`
     is **false**, `lstat().isDirectory()` is true, `readlinkSync` throws `EINVAL`, `realpathSync`
     returns the **link path itself**, while `realpathSync.native` resolves the target and
     `Dirent.isSymbolicLink()` is **true**;
   - an **ordinary** Windows junction (`C:\Users\Default User`, `C:\Documents and Settings`, both
     reparse tag `0xa0000003`) is reported by `lstat` **as a symlink**, and `readlinkSync`/
     `realpathSync` resolve it.
   So the invisibility is a property of the **sandbox-rewritten** link, not of every junction. A
   guard that survives both spellings uses `realpathSync.native` plus `Dirent.isSymbolicLink()` and
   never assumes `lstat` alone settles it in either direction. This is recorded in
   [`docs/PITFALLS.md`](PITFALLS.md); the review-sandbox guards use the native realpath and the
   `Dirent` flag.
3. **Deployment as this record stood (2026-10-25).** On that day the plugin was **0.3.0 in both
   install roots** (`~/.dsh/plugins/src-12453345_-dsh-workflow` and the desktop profile's
   `node_modules`) and the status banner read 0.3.0. The deployed *text* was then the **`e93175b`
   build, not the tree this record accompanies**: `node tooling/sync-to-profile.mjs --check` reported
   five differing files — `lib/advance.js`, `lib/eol.js`, `tooling/mutation-check-governance.mjs`,
   `tooling/sync-to-profile.mjs`, `README.md` — real text differences, not line endings (the check
   folds line endings and reports those separately). That build had replaced the one matching commit
   **`3d6dd16`**: then `lib/` and `tooling/` were byte-identical to `3d6dd16` (synced at about
   14:44–14:46, its files' mtimes preceding the 14:46:13 commit). It is history, not a current fact:
   run `node tooling/sync-to-profile.mjs --check` for today's reading, and read the gitignored
   `handoff/P3-STATUS.md` for live state. This document records what happened and how to check it.

## 4. How to check the state (not restated here)

- **Branch:** development sits directly on one branch, `recovery/p2b1-content`; `git status -sb`
  reads the branch, the upstream and the ahead count today.
- **Unit suite:** `node run-unit-tests.mjs` (Node v24.18.0 inside the DSH sandbox) must exit 0 with
  no failures. Seven cases skip in a sandbox: five mutation-lock race cases, the Chromium layout
  measurement, and the pre-existing Windows `SIGTERM` limitation. A skip is not a pass — see
  [`TESTING.md`](TESTING.md) Layer 1.1. The totals are not restated here; they move with every test
  added, so read them from the run.
- **Other sensors:** `node run-smoke-test.mjs` → `smoke test passed`;
  `node run-config-check.mjs` → two `OK` lines (every patch value matches its code default; resolved
  `maxDepth` is 2).
- **CI:** CI runs on a push to the remote branch (`.github/workflows/ci.yml`: Node 22 and 24 on
  `windows-latest`, `npm test` → smoke → config check). No run id and no pushed tip is recorded
  here: read `git status -sb` for the ahead count, the Actions page for the run covering the current
  tip, and that run for the totals, which move with every test added.
- **The transactional review guard** (`c0cdc5c`, `lib/review-sandbox.js`): before a reviewer starts,
  the project is snapshotted into an isolated temp root as a real copy; the reviewer is pointed at
  that copy; when the child finishes the real project is re-scanned, deletions are restored
  byte-for-byte, modifications and additions are reported, and any difference makes the review
  **contaminated** — it cannot pass at any score. The copy is deleted only through guards a junction
  cannot satisfy (native realpath containment, a pre-delete link scan, a snapshot marker, a canary
  outside the copy), and no reviewer starts if a snapshot cannot be built. The cases in
  `test/review-isolation.test.mjs` include an incident replay that deletes the project through a
  junction and requires every byte back.
- **Version:** read it from `package.json`; this document does not restate it, because it moves.
  What is *installed* is a different question — `node tooling/sync-to-profile.mjs --check` answers it.
  It is still not a published release: no 0.3.0 build was published.

### 4.1 P3-1 re-verification (verbatim, 2026-10-25)

The lock probe is the one check that must never be "green by accident". Both runs, exact exit codes
and the lines that matter:

`node tooling/mutation-check-lock-probe.mjs` (no flag) → **exit 2**:

```
baseline (unmutated): RED — exit 1, tests 19, pass 13, fail 5, skipped 1
baseline not green: a red mutant run here would prove nothing, so no mutant is counted.
L1 NOT RUN — the unmutated baseline is RED, so no mutant verdict can be evidence — the defect itself: an unreadable `at` is read as epoch 0 (`: 0` reinstated)
L2 NOT RUN — the unmutated baseline is RED, so no mutant verdict can be evidence — the unknown-age branch is removed, so unknown age is always stale
L3 NOT RUN — the unmutated baseline is RED, so no mutant verdict can be evidence — the `at` value is used raw: no tolerant read, so an ISO string becomes NaN/epoch 0
L4 NOT RUN — the unmutated baseline is RED, so no mutant verdict can be evidence — `readLockTimestamp` always answers null (the unknown path swallows everything)
mutants: 4; caught: 0; not run: 4; not applied: 0; unexpected: 0
source restored byte-for-byte: YES
NOT RUN: no honest verdict exists here, so this is NOT a pass (exit 2).
```

`DSH_WORKFLOW_SANDBOX=1 node tooling/mutation-check-lock-probe.mjs` → **exit 0**:

```
L1 RED — exit 1, tests 19, pass 7, fail 6, skipped 6 — the defect itself: an unreadable `at` is read as epoch 0 (`: 0` reinstated)
L2 RED — exit 1, tests 19, pass 9, fail 4, skipped 6 — the unknown-age branch is removed, so unknown age is always stale
L3 RED — exit 1, tests 19, pass 7, fail 6, skipped 6 — the `at` value is used raw: no tolerant read, so an ISO string becomes NaN/epoch 0
L4 RED — exit 1, tests 19, pass 11, fail 2, skipped 6 — `readLockTimestamp` always answers null (the unknown path swallows everything)
mutants: 4; caught: 4; not run: 0; not applied: 0; unexpected: 0
source restored byte-for-byte: YES
every mutant was caught as declared (exit 0).
```

The flagged run is the real verification: with the sandbox flag the lock suite's piped-child cases skip
with a reason, the baseline goes GREEN, and each of L1–L4 is caught by a **real failing test**. The
unflagged run is the honest NOT RUN — exit 2 is not a pass and must not be read as one.

## 5. What remains

- **`p3-3-ui-harness` — needs a browser.** A Chromium-only red test can still be counted as a caught
  mutant: the three UI harnesses spawn `test/status.test.mjs` directly without
  `DSH_WORKFLOW_SANDBOX`, so in the sandbox the layout case reaches a browser launch that fails.
  The fix is to classify that failure as **NOT RUN**, not "red", and to pin the classification
  without a browser. It cannot be demonstrated in this sandbox.
- **`p3-7-dogfood` — its constraint step needs the user.** Recording a real constraint goes through
  `workflow_gc action=add`, which asks the user for confirmation; this session has no human channel
  (`approval.strength: llm-only`). The stats / handoff-doc / policy parts can be exercised offline;
  the constraint confirmation cannot.
- **A recorded PASS means *this text*.** Reviews recorded through an older build read **STALE** as soon
  as a reviewed file changes, because their reviewed sets include `docs/ROADMAP.md` and the other
  documents later commits edit. So the rule is mechanical: re-review and re-record after changing a
  reviewed file. Whether any record is currently fresh is not stated here — `workflow_status` answers
  it, reporting every recorded PASS whose files changed as STALE.
- **`p3-6-docs-caveats` is not closed.** Its docs fixes are committed (`b7f13a1`) and the docs-truth
  pass extends them; the earlier review chain used its whole two-round budget (round 1 PASS, round 2
  FAIL on two documentation defects fixed in that commit), so this pass re-reviews the current bytes
  as a fresh sequence, round 1. The feature is recorded complete only from that verdict.
- **Push and deploy are the human's.** `git push` is refused by the gate (a remote-https pipe is
  denied under `workspace-write`, and `danger-full-access` is disproportionate for publishing one
  branch); deploying is `tooling/sync-to-profile.mjs` plus a DSH restart, run by a human. The user
  pushed `e93175b` and deployed 0.3.0 on 2026-10-25; an agent in this workspace does not push or
  deploy, and later deploys remain the human's step.
- **Scratch evidence is not durable.** `.tmp/` holds the recovery tooling (the decompressor, the
  operation indexer, the replay scripts, 57 decompressed logs) and is git-ignored. It explains how
  every recovered file was produced, but it is not part of the repository and may be deleted — the
  push is confirmed (`e93175b`).
