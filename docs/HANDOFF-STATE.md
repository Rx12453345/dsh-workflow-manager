# Handoff state — where the last session stopped

> **This file is not a reviewed artefact, and never will be.** It is written at the end of a session
> and is **never** declared in a review's `changed_files` (constraint **C002**,
> `.dsh/CONSTRAINTS.json`; the rule is stated in `CONTRIBUTING.md` and asserted by
> `test/handoff.test.mjs`). Staleness is caused by the review FINGERPRINT, which covers only the
> files a review declared — so declaring this document would stale every feature whose review had
> covered it. Because it is never declared, writing it costs one commit and no re-review, which is
> why it can be written *after* the last review of a session.
>
> It carries what the machine cannot: why work stopped, what was deliberately left stale, the
> unfixed minors, the open decisions, and the next actions. It deliberately carries no live counts —
> `workflow_status` is the count, `.dsh/HANDOFF.md` is the generated brief, and `FEATURES.json` is the
> evidence. A count written here would rot within a week.

- date: **2026-11-01**
- version: **0.4.0** (`package.json`; the running plugin's banner tells you what is actually deployed)
- branch: `recovery/p2b1-content`, never merged to `master`

## Where the work stands

The workflow machine is at **`HANDOFF`** (terminal) with every feature recorded complete. The
project is therefore *finished by the machine's own rules*, and the remaining work is delivery and
bookkeeping rather than features.

This session's change (0.4.0) closed three gaps that all had one shape — **the state carried a
verdict but not the reason for it**:

1. `record-review` now persists a bounded summary of the reviewer's findings (dimension, severity,
   reachability, one-sentence title; at most 10, ordered by consequence, `issuesTotal` when
   truncated). `workflow_status` and the brief print it per feature. A row written before this has
   no `issues` field and reads as "not recorded", never as "nothing found".
2. Review evidence now records a bounded per-file digest map, and `reviewFreshness` compares it to
   name the reviewed file that actually moved. Every STALE record is judged `code changed` (a
   re-review is owed) or `documents only` (cosmetic); a mixed set with no per-file evidence answers
   `unknown` rather than guessing, and a truncated map never claims "documents only".
3. The handoff brief is refreshed on **every state write** (phase moves, `boot`, `record-review`),
   not only when the project enters `HANDOFF`, so its counts stop describing the past. A failed
   refresh is reported on the reply.

## What is complete

All eight features are complete with an independent review behind each: the P0 review-isolation
fence, the P1 shape-classified approval gate, the four P3 items (EOL-aware fingerprint, governance
mutant, code minors, handoff dogfood, documentation caveats), the UI harness, and the recovery
baseline. **This session's change (0.4.0) has an independent review of its own** (see
`workflow_review`'s verdict in the session log and the CHANGELOG entry); the phase machine is
terminal, so that verdict is not recorded against a feature.

## Stale review records, and why

`workflow_status` is the source of truth and now says WHICH kind each one is. The shapes to expect:

- **Documentation-only staleness (cosmetic).** Records whose declared set was mostly code, but where
  a document inside that set (`docs/TESTING.md`, `docs/DESIGN.md`, `CHANGELOG.md`, `README.md`,
  `docs/ROADMAP.md`) was edited after the review. Their code claim still holds. These were
  deliberately accepted by the user on 2026-11-01 rather than chased; re-reviewing them is
  optional work.
- **Code staleness (a re-review is owed).** Records whose declared files this session edited
  (`lib/advance.js`, `lib/tools.js`, `lib/review.js`, `lib/handoff.js`, `lib/shared.js`, and the
  tests). The code in them really did change, so their claim no longer covers the artefact.
- Nothing is *blocked* by either: `HANDOFF` was entered before these edits, `HANDOFF` is terminal,
  and no transition is waiting on them.

If a future session wants the old records fresh, re-review each with its **narrow code-only set** —
the exact per-feature lists are in the gitignored `handoff/P3-STATUS.md` (search for "NARROW
code-only set"). Do not use a branch-wide set: a branch-union declaration is what staled every
feature in the first place (constraint C001).

## Known minors nobody fixed

Recorded by the PASSing reviews; none blocks delivery, and each is a real (small) defect:

- `lib/review-sandbox.js` records a link's `target` but `verifyReviewSnapshot` never compares it, so
  re-pointing an in-project link stays `clean: true`.
- `lib/review.js` renders "independent review did not run" for a contaminated run (pre-existing
  wording; the run did happen).
- `docs/RECOVERY.md` points at TESTING §1.1 for a skip set that includes the Windows SIGTERM case
  listed only in §1.
- `CHANGELOG.md` states a live case count in a file whose own rule says counts are not restated.

## Open decisions

1. **Deliver 0.4.0.** The branch is one commit ahead of the pushed tip and `master` has never been
   merged. Decide: push, merge `--ff-only`, sync to the profile, restart — or leave the deployment
   at the previous build.
2. **The stale records.** Re-review the code-stale ones, or accept them and let the new judgement
   keep saying so. The documentation-only ones can be ignored indefinitely.
3. **The two UI harness end-to-end proofs** need a normal terminal (the sandbox forbids the child
   processes they spawn). They are the last unverified surface.

## Next three actions

1. Read `workflow_status`: it names which stale records are code and which are documents, and the
   brief's next action follows that judgement.
2. Push `recovery/p2b1-content`; optionally `node tooling/sync-to-profile.mjs` and restart. The
   status banner is the check — it reads the *deployed* version.
3. `git merge --ff-only recovery/p2b1-content` on `master` (the branch is a strict ancestor), then
   clean the leftover review snapshots: every review leaves `%TEMP%\dsh-review-*` behind because it
   cannot remove its own copy (EPERM). They reached ~12 GB.
