# Contributing

What must run before a change is considered done, and the rules this repository has learned the hard
way. Read this before you open a pull request; read `docs/PITFALLS.md` before you write code.

This project's own documented failures are its evidence. Where a rule below looks pedantic, the
pitfall it comes from is cited, and the incident really happened.

---

## Before you change anything

1. **Read `docs/DESIGN.md`** — why the plugin is built the way it is, and which first-party sources each
   decision rests on. A change that contradicts a design decision without saying so will be sent back.
2. **Read `docs/PITFALLS.md`** — every trap, with the symptom and the fix. Most of the code in this
   repository exists because of one of those entries. If your change removes one of those guards, you
   need to say which entry no longer applies and why.

Working directory for everything below:

```powershell
cd <plugin-checkout>
```

---

## The ordered gate

Run these in order. **Do not stop at step 1.** This project holds five recorded instances of "the
offline suite was green and the real host broke immediately", and four of "a test that cannot go red is
not a test".

```
1. offline suite          seconds    must be fully green
2. mutation harnesses    minutes    confirm the tests still have teeth
3. sync + restart + real host   the only layer that sees the real thing
4. independent review     when the change is not obviously correct
5. delegate a real work unit    when the change touches architecture
```

Layer 4 does not substitute for layer 1, and layer 1 cannot substitute for layer 4.

### 1. The offline suite

```powershell
npm test                                     # expect: 0 fail (normal 576/575/0/1; sandbox 576/569/0/7)
npm run test:sandbox                         # force the sandbox profile; the six environment tests skip with a reason
node run-smoke-test.mjs                      # expect: "smoke test passed"
node run-config-check.mjs                    # expect: two OK lines, and "resolved maxDepth is 2"
$env:DSH_TOOLS_BUNDLE = '<extracted>/dsh-tools/lib/index.js'; node tooling/validate-tool-definition.mjs
node tooling/check-installed-config.mjs      # every entry exports a Config the host accepts
$env:DSH_CLIENT_MODULES_BUNDLE = '<extracted>/dsh-client-modules/lib/index.js'; node tooling/simulate-client-scan.mjs
node tooling/sync-to-profile.mjs --check     # expect: 0 differ
```

`check-config-schema.mjs` derives the checkout from its own location and resolves schemastery from
the profile (`DSH_PROFILE_DIR`, default `~/.dsh/profiles/desktop`). The shipped-bundle tools need
`DSH_TOOLS_BUNDLE` / `DSH_CLIENT_MODULES_BUNDLE`, because the host implementation is not vendored
into this repository.

Test counts drift and change; the failure count must be zero. Do not chase a number you remember —
read the output.

**An optional extra for layout changes.** `tooling/measure-grid-layout.mjs` opens a headless Chromium
and prints the resolved `grid-template-columns` of the settings page and the sidebar panel. It asserts
nothing; it is a measuring instrument. Where no Chromium-family browser exists, the corresponding test
case skips and says the geometry cannot be measured.

### 2. The mutation harnesses

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

Each one injects a defect, runs the suite, records whether it went red, then **restores the source byte
for byte**. `mutation-check-governance.mjs` runs each mutant in a throwaway `%TEMP%` copy instead, so no
mutant is ever written into the canonical `lib/` (it still takes the shared lock, and verifies
`lib/tools.js` and `lib/advance.js` byte-for-byte); its check line is
`canonical sources unchanged ... YES`.

> **In the DSH Windows sandbox these harnesses capture their child's output through temp files,
> not a pipe (`tooling/child-output.mjs`), because the sandbox denies a piped child (EPERM).** That
> covers the constraints, approval, governance, verification and work-unit harnesses. `mutation-check-client.mjs`,
> `mutation-check-panel.mjs` and `mutation-check-project-tab.mjs` additionally run the Chromium layout
> test, which the sandbox cannot launch, so run those three in a normal terminal. The unit suite is not a
> substitute for a security-depth harness; a security change with no harness result is not finished.

> **NEVER RUN TWO OF THESE CONCURRENTLY.**
>
> They rewrite files under `lib/` and restore them afterwards. Two at once on `lib/client.js` once left
> **two mutants permanently in the source tree, while both processes printed
> `sources restored byte-for-byte: YES`** — each verifies only its own restoration. A quiet mutant that
> keeps the suite green would leave silently polluted sources and still print YES. That was luck, not
> safety.
>
> A shared lock (`tooling/.mutation-lock`) now refuses the second one: it exits **2** immediately,
> naming the holder. It never queues — a queue looks like a hang, and a silent queue is how someone
> concludes the tool is broken.

**After every run, check the restoration line:**

```
source restored byte-for-byte: YES        <- required
canonical sources unchanged ...: YES      <- the governance harness's equivalent (no mutant reaches lib/)
```

If it says anything else, you are working on a corrupted source tree. Compare the constants against the
harness's `from` literal to find what was left behind, restore it, and start again. `mutation-check-work-unit.mjs`
exits **3** if it could not restore. Related: if a harness reports `anchor occurs 0 times`, that has
**two** possible meanings — the anchor is wrong, **or** a previous run left the tree dirty. Read the
message, which now says both.

A harness that gets interrupted (Ctrl-C, a hard kill) can leave the lock and the mutation behind. The
next run takes over the stale lock and prints why; restoring the source is still your job. Do not kill a
harness casually:

```powershell
node tooling/sync-to-profile.mjs --check
```

`tooling/check-behaviour-delta.mjs` is read-only, writes nothing under `lib/`, does not take the lock,
and is not blocked by it. Run it any time:

```powershell
node tooling/check-behaviour-delta.mjs
```

It exits **0** (compared and clean), **1** (unexplained differences, or the comparator itself is broken),
or **2**. **`RESULT: NOT CHECKED` with exit 2 is not a pass** — it means there was no installed copy to
compare against. Never merge 0/1/2 into "fine".

### 3. Sync, restart, and look at it on a real host

```powershell
node tooling/sync-to-profile.mjs            # after seeing --check's exact diff
```

Then **restart DSH** (host half) and **hard-reload the window** (browser half):
F12 → Network → tick **Disable cache** → F5. `Ctrl+Shift+R` often does nothing in Electron.

`file:` dependencies are **copies, not symlinks**. If you changed plugin code and did not sync, you will
see the old behaviour and conclude your fix did not work.

> **Never sync only part of the files.** `lib/tools.js` depends on `lib/work-unit.js`; omitting the
> latter makes `tools.js` fail at import and **the plugin's entire tool surface disappears**.

> **The sync command may be refused by this plugin's own approval gate, and that is correct.** The
> refusal means the gate cannot verify the write scope of an opaque script that modifies the very module
> governing the gate. **Do not retry it, do not reword it, and do not request a wider sandbox.** The
> remedy the gate names is either an explicit per-file copy into the installed path, or a human / a
> session the gate does not govern performing the first copy. A refusal is not a failure to route
> around; it is an answer.
>
> **The first deployment of a change to the exemption itself always needs an out-of-band copy** — the
> copy currently running the gate predates the exemption, so the gate cannot authorise its own first
> deployment. This is structural, not a bug.

Real-host verification has no automated substitute. Walk the checklists in `docs/ROADMAP.md`
("Unverified") for the surface you touched — the sidebar panel, the project tab, the settings page.
**If anything mismatches, bring back the console output and a screenshot.** Offline tests cannot replace
this step. `tooling/simulate-client-scan.mjs` is a simulation, not the running UI.

### 4. Independent review

```powershell
workflow_review feature="…" acceptance=[…] changed_files=[…] diff="…" sensors=[…] class=… round=1
```

The only property that matters: **whoever did the work cannot declare it done.** Before calling it, run
`git status --porcelain` and include every changed path in `changed_files`. The reviewer prompt tells the
reviewer to run the same command and compare it with your list; a changed path that is missing is an
issue, scored against `scope`, `tests` or `correctness`. That cross-check is **reviewer-side** — the
framework does not reconcile the list itself, and `git status` sees only **uncommitted** changes, so a
committed path is invisible and this is not a security boundary.

Fix what the review locates, then review again with an incremented `round`. Read the verdict correctly:

- `overall` is the mean of the **declared** dimensions — undeclared dimensions do not participate, so a
  reviewer cannot pad the mean with extra dimensions;
- only issues with `reachable: true` and a concrete `reach` may block; `UNREACHABLE — recorded, does not
  block` is still shown, but it does not fail the work;
- a low score with **no** issue explaining it **does** block — a score is not evidence;
- `exhausted` is a terminal state. Take it to real-host verification or to a human. Do not try to open
  another round.

### 5. Delegate a real work unit

When the change touches architecture, have a delegated child drive the whole loop from inside itself —
`workflow_advance` plus `workflow_review` — and read only its final report. This is the layer that
found four defects no amount of extra offline testing reached: an undeclared dimension padding the mean,
a silently dropped `workspace_dir`, a review record that demanded its input be retyped, and `pick`
not transitioning.

---

## The verification depth policy

Changes are classified `docs` / `ui` / `logic` / `security`, which sets how deep verification goes:

| Class | Depth | Unit suite | Covering mutation harnesses | Independent review | A human looks |
|---|---|---|---|---|---|
| `docs` | 0 | yes | — | optional | no |
| `ui` | 2 | yes | every covering harness | optional | **required** |
| `logic` | 2 | yes | every covering harness | optional | no |
| `security` | 3 | yes | every covering harness | **required** | no |

`ui` is depth 2, **not lower** than `logic`: a renderer is executable code *and* something no test in
this project can measure, so it earns the human check **in addition**. Human inspection is an addition,
never a discount.

- **A declared class is CHECKED against the changed files.** The resolved depth is the **stricter** of
  the two, so a declaration can only add cost and can never remove it. Declaring `docs` while the diff
  touches `lib/approval.js` is **refused by name**, and the refusal also tells you which class and which
  depth will be used instead. Refusing without telling would let a misclassification through.
- **`security` is not degradable at any setting.**
- Unclassified executable files resolve to `security`: "nobody has judged this yet" is not "this is
  documentation".
- The shallowest class with **no** evidence is refused (depth raised to 2). No declaration and no
  evidence raises the depth to 2 and requires independent review.
- `diff` evidence is read from the `diff --git` / `+++` / `---` **headers only**, never the body.
- **`verification.policy` defaults to `off`.** With it off, a declaration changes nothing and an
  undeclared call behaves as before, byte for byte. Turn it on with
  `workflow_set path=verification.policy value=enforced`. The only other value the sources name is `off`;
  an unrecognised policy value resolves to the strictest usable settings rather than to `off`.

---

## Hard rules

### Never obfuscate, split or encode a literal to pass the argument scanner

**A real incident.** An agent wanted test data (a dotenv path and a URL) past the gate's argument scan,
so it concatenated the literal from fragments. **Windows Defender's AMSI saw the same pattern — string
concatenation producing `https:` and a dotenv path is the standard signature of malware evading static
scanning — and flagged it `Trojan:Win32/ClickFix`, raising a serious alert on the user's machine.**

Put the literal in a **real file** (the gate scans the command line, not file contents), or **report
being blocked**. There is no third option. The only way to satisfy a text-pattern rule is to make the
text not match — hide it, split it, encode it — and that is indistinguishable from evasion, because it
*is* evasion. Any change that is structurally a scanner dodge will be rejected regardless of its intent.

This is also why the self-deployment exemption is built on **structure** (which argument keys are
destinations, and where those values resolve on the filesystem) rather than on text patterns: structure
can be checked, text can only be dodged.

### Report, do not retry, a refusal

Approval decisions in this environment can be model-judged and therefore **non-deterministic**. The same
command has been allowed for one agent and refused for another, and a command that was refused had
already succeeded earlier. **"It passed last time" is not authorisation**, and retrying is exploiting
non-determinism rather than solving anything. Read the refusal — it names a remedy — and follow it, or
ask for a differently shaped action.

### One document, one job

| Document | Job |
|---|---|
| `README.md` | orientation and install |
| `docs/USAGE.md` | for users |
| `docs/DESIGN.md` | why it is built this way |
| `docs/PITFALLS.md` | what went wrong, with root cause and fix |
| `docs/TESTING.md` | how to verify, layer by layer |
| `docs/ROADMAP.md` | what is not done |
| `CHANGELOG.md` | user-visible changes |
| `CONTRIBUTING.md` | this file: what must run before "done" |

**Do not move pitfalls into the README.** The README is an operating manual; a wall of failure history in
it is exactly the problem this split fixes. A new trap belongs in `docs/PITFALLS.md` with a symptom, a
root cause, a fix, and whether the fix was verified or only believed.

### Editing a file that an earlier PASS covered stales that PASS

The review fingerprint covers the files the PASS was granted on. A later change that edits one of them —
including a documentation truth pass — makes that PASS `stale`: `workflow_status` says so, and
`COMMIT`/`HANDOFF` refuse it until a fresh review runs. That is the mechanism working, not a routing bug.

So either **scope each documentation edit to the feature that owns the file**, or **budget a re-review of
the earlier feature** and expect its PASS to go stale. Do not edit the evidence, and do not try to make
`record-review` accept a verdict the bytes no longer match.

### Found a code defect while documenting? Report it, don't fix it

A documentation change that also edits code is an unreviewed code change wearing a docs badge. Report the
defect — with the file, the line, and the reproduction — in the pull request or in `docs/ROADMAP.md`
("Known defects and debts"), and let a change that can be classified and reviewed carry the fix.

The same discipline applies to a defect you find in a *document*: name the document, the line and what it
claims versus what is true, rather than quietly fixing one copy while another copy stays wrong. Two
documents in this repository have disagreed about deployment status for exactly that reason.

### Do not measure a moving tree

If the suite goes red while another agent is editing the same files, decide who reddened it by
**controlled experiment**, not by guesswork: swap your own changed files for the installed copies and
re-run the same test file. If the failing test names and counts are identical before and after, the
failures are not yours. Do not replace a file someone else is editing with an older copy.

### A green suite is not evidence that the plugin works

If you are about to write "tests pass, therefore it works", re-read step 3. Five times in this project's
history the offline suite was fully green while the real host broke on the first run.

---

## Checklist

- [ ] `docs/DESIGN.md` and `docs/PITFALLS.md` read; any guard I removed is named with the pitfall it came from
- [ ] Offline suite fully green (0 failures), including `validate-tool-definition` and `check-installed-config`
- [ ] Every **covering** mutation harness run **singly**, and each printed `source restored byte-for-byte: YES`
      (or, for `mutation-check-governance.mjs`, `canonical sources unchanged ... YES`)
- [ ] `check-behaviour-delta.mjs` run if I touched the approval classifier; result 0, 1 or 2 read correctly
- [ ] Depth class declared and checked against the actual changed files; `security` treated as non-degradable;
      a human has looked if the class is `ui`
- [ ] Synced (all files, never part), restarted, hard-reloaded, and the affected surface observed on a real host
- [ ] Any refusal followed rather than worked around; anything blocked reported honestly
- [ ] `workflow_review` run when the change is not obviously correct; findings fixed and re-reviewed with a new round
- [ ] `git status --porcelain` run before review; every changed path declared in `changed_files`
- [ ] If I edited a file covered by an earlier PASS, that PASS is knowingly staled and a re-review is budgeted (or the edit was scoped to its owning feature)
- [ ] No literal obfuscated, split or encoded to pass the argument scanner
- [ ] New pitfalls written into `docs/PITFALLS.md`, not into the README
- [ ] User-visible changes added to `CHANGELOG.md`, with "not yet deployed" where it is true
- [ ] Code defects found while documenting reported in `docs/ROADMAP.md`, not fixed inside a docs change
