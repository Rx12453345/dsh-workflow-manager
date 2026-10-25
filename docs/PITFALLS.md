# Pitfalls

Every hard-won trap in this project: the symptom, the root cause, the fix, and whether the fix was
**VERIFIED** (something ran that would have failed if the fix were wrong) or only **BELIEVED** (sound
reasoning, nothing tested it). The README is the operating manual; this file is the failure record.

Sources are line numbers in `NEXT-STEPS.md`, the development journal (Chinese). Where a fact comes from
elsewhere, the source says so.

---

## 1. Host facts and the client bundle

### A slash in a Loader entry name drops the browser half silently
Nothing happens — no error, no log, indistinguishable from a host-only build, because
`exactPackageSpecifier` returns `undefined` for a specifier containing `/` or `:`. Fix: a second Loader row
carrying the **bare package name** (`rowKind: module`, declaration only) — the same rule means a
`<package>/panel` row can never ship a bundle. **VERIFIED** — `simulate-client-scan.mjs` STEP 1–5.
`NEXT-STEPS.md:778–786, 2186–2189`.

### Individual bundle probes give misleading 404s
`/plugins/<pkg>/client.js` 404s, so "the browser half was not delivered" looks proven — misdiagnosed twice;
bundles are batch-merged (`plugins/??a.js,b.js&rev=…`) and no per-package URL exists. Fix: judge discovery
only by whether your entry is in `window.__DSH_BOOT__`; a hand-written lazy-CJS bundle works, the official
build chain is not required. **VERIFIED.** `NEXT-STEPS.md:788–792`.

### `ctx.get` races while `ctx.inject` waits
`ctx.get('tools')` returns `undefined` silently, and on a real host the same mistake was
`cannot get property "subagents" without inject` for a service that plainly existed — because `ctx.get`
does not wait for a mount and may only take services the current context **declared**, a check the fake-ctx
smoke framework does not enforce. Fix: register inside `ctx.inject`, nested for optional services.
**VERIFIED** — only the real host caught it. `NEXT-STEPS.md:794–797, 1117–1132`.

### The service is `ctx.subagents` (plural)
A probe for `subagent` is permanently `absent`. Fix: use the plural, and get the contract right —
`prompt` is a block array, `parent` is required, `run.result` is a Promise, `run.dispose()` must run on
every path, and only `stopReason === 'completed'` is success. **VERIFIED.** `NEXT-STEPS.md:799–801`.

### The `subagents` service has two start APIs
Older hosts expose `subagents.start(provider, request)`. The current
`@deepseek-ai/dsh-subagent` exposes `subagents.startActivation(spec)` and **no `start`**. Requiring
`start()` therefore rejects the real service: status says `probe service start=NO`, while the mount
probe still says `subagents=present`, and `workflow_review` returns `unavailable`. Both entry points
return the same `{ result, dispose }` receipt, so accept either and adapt at the start call. The
`get` route can return a facade without the entry point while the property carries the real service,
so probe by shape, not by non-nullness. **VERIFIED on the real host** — see A1 in `CHANGELOG.md`.

### `maxDepth` is an absolute tree bound, and 1 forbade this plugin's own architecture
`SubagentDepthError` when a reviewer was created inside an orchestrating child: depth accumulates down the
tree, so main(0) → child(1) → reviewer(2) needs 2, while the constant was commented "LOCKED: prevents
nesting" — permitting only the architecture that keeps review round-trips in the main context, the thing
this plugin exists to prevent. Fix: 2, still bounded. Note `maxActiveSubagents` does **not** queue
(`ACTIVATION_LIMIT_REACHED`). **VERIFIED on a real host.** `NEXT-STEPS.md:1134–1149`.

### `Ctrl+Shift+R` does nothing in Electron
A rebuilt browser half does not appear, because `window.__DSH_BOOT__` is injected at page load and reading
it without a reload gives a stale boot graph. Fix: F12 → Network → **Disable cache** → F5, plus a restart
for host changes; a `file:` dependency is a copy, not a symlink, so refresh it first — a same-named file of
a different size is the tell. **VERIFIED.** `NEXT-STEPS.md:826–829, 853–858`.

### `node --check` cannot catch a scope error
The whole settings table fails to render while every syntax check passes: a module-level helper referenced
a dictionary that existed only inside the component factory — legal syntax, runtime `ReferenceError`, only
on that path. Fix: run the smoke test, which exercises the real render chain. **VERIFIED.** `USAGE.md §10`.
`NEXT-STEPS.md:1197–1200`.

### On Windows a junction is invisible to `lstat` and to `realpathSync`
Measured on Node v24.18.0 after a reviewer emptied the workspace with a recursive delete through a
directory junction. A junction created with `symlinkSync(target, path, 'junction')`:

- `lstatSync(path).isSymbolicLink()` → **false** (it looks like an ordinary directory);
- `readlinkSync(path)` → `EINVAL`;
- `realpathSync(path)` → **the junction path itself**, so a containment check built on it silently
  passes for a link that points at the project;
- `realpathSync.native(path)` → the real target;
- `readdirSync(parent, {withFileTypes:true})`'s `Dirent.isSymbolicLink()` → **true**;
- `rmSync(path, {recursive:true})` removes only the link, but `rmSync(join(path,'child'), …)` deletes
  **through** it into the target, and `unlinkSync(path)` fails with `EPERM` (use `rmdirSync`).
A child subagent also inherits the parent's working directory and file policy: a `cwd` in the spawn
request does not move its sandbox root, and a write into the real project still succeeds. **VERIFIED.**
`lib/review-sandbox.js`, `test/review-isolation.test.mjs`.

---

## 2. The settings-slot contract

### `Config` must be a module-level static export
The settings page is absent from the namespace catalogue and shows "cannot be edited" with no error, the
evidence being `serves=[…,"dsh-workflow-module"] wants=dsh-workflow-core`: `dsh-settings` reads
`entry.fiber.runtime.Config` while **building the catalogue**, and that is a module export, not an injected
service, so assigning it after an `inject` resolves leaves it `undefined`, drops the entry (`return []`) and
closes the browser-side gate. It is also a **function**, so an `typeof === 'object'` check rejects it. Fix:
build it at module scope; on failure set `undefined` and warn. Keep schemastery an optional peer via
`createRequire` — which needs a **file** path inside the directory, not the directory. **VERIFIED.**
`NEXT-STEPS.md:862–905`.

### Every Loader row must carry `Config` itself
The description renders, the body says "not served", nothing errors — because the host reads the export of
**the module that row loaded**, and the three rows load three modules while the sub-entries exported only
`{ name, apply }`. Fix: each sub-entry re-exports `Config` from `../../index.js`. **VERIFIED.**
`NEXT-STEPS.md:907–935`.

### Schema defaults become values, so per-row fields must stay out
A per-row field (`rowKind`) is overwritten by the schema default, because the host projects schema metadata
into JSON Schema and validates with Ajv **without executing it** — so `volatile` on the export is safe, but
any default becomes that field's value. Keeping per-row fields out loses nothing: the form is a view of
`entry.fiber.config` and undeclared keys were never round-trippable. `volatile` may only be one level deep.
**VERIFIED** — `tooling/check-config-schema.mjs`. `NEXT-STEPS.md:803–810`.

### Keyed slots render the same component twice, with `view: "summary"`
The whole form, error text included, is painted into the one-line description row, because
`plugins.row.config` renders once for the description and once for the body. Fix: early-return one line for
`summary`, as the official component does. The signature is `renderSlot(key, options, ...props)` and `form`
is the third argument — do not gamble on props precedence. **VERIFIED.** `NEXT-STEPS.md:831–851`.

### The `form` passed into a slot is a trimmed view, not a controller
The page sits on "loading configuration" forever with no error or timeout, because the slot's `form` has
only `{ state, mutate }` and an `typeof form.subscribe !== 'function'` guard declines every time. Fix: take
the full controller from the service, `ctx.configForms.get('<row id>')`, passed in via `inject` rather than
relying on `props.ctx`. The row form lives on `plugins.row.config`, keyed `` `${package}#${rowId}` ``,
mounted through `ctx.slots.inject`; `plugins.item` is package-level and never renders there. **VERIFIED.**
`NEXT-STEPS.md:942–976, 2167–2176`.

---

## 3. Tool definitions and JSON

### Tool output must be lossless JSON
One `undefined` field corrupts the whole call — `returned invalid output: value is not lossless JSON`.
Fix: every return goes through `toLosslessJson()`, which lives in `lib/shared.js` and is re-exported from
`lib/tools.js`, because importing it *from* `tools.js` would make a cycle. **VERIFIED.**
`NEXT-STEPS.md:772–776`.

### An undeclared parameter is dropped silently, and the tool reports success
`workflow_init workspace_dir=…` wrote into the **cwd** project and `workflow_set workspace_dir=X` changed
the wrong project's approval strength, because the host discards arguments not declared in the
`parameters` schema without error — and a delegated child's cwd is routinely not the project directory.
Fix: one shared `resolveWorkspace()` **plus a declaration test**, since "not declared" is the cause.
**VERIFIED on a real host.** `NEXT-STEPS.md:1426`; `TESTING.md:355–373`.

### A rejected tool definition means the tool never appears
No error at the call site, because the registry validates with the shipped `assertSupportedJsonSchema` and
rejects unsupported shapes such as `{ type: 'json' }`. Fix: run the **shipped** validator, which must report
`all 6 tool definitions are acceptable to the shipped registry`. **VERIFIED.** `NEXT-STEPS.md:2482, 2498`.

---

## 4. The phase machine and reverse self-certification

### Completion is written only by the framework, from a review it actually ran
Otherwise the state machine relocates self-certification: a model says "the review passed" and the feature
is done. Fix: `workflow_review` records its verdict into a process-local store and `record-review` reads
**only** that store, so a claim — even from a model that really called `workflow_review`, if that call
failed — writes nothing. The decisive test is `record-review is refused when this session never ran a
review`. **VERIFIED on a real host**, refused with **"a claim that one passed is not evidence"**.
`NEXT-STEPS.md:1332–1341`.

### Review verdicts are bound to a fingerprint of the reviewed files
Without it, run the review (pass) → edit three files → commit, and the review approved something else. Fix:
hash the reviewed files plus the diff on a pass, recompute on `record-review`, refuse with "review again or
revert the later edits", and persist the `diff` so a second call reproduces the fingerprint and the refusal
names the real cause rather than wrongly saying "the files were changed". A passed verdict is cleared on any
transition other than `→ COMMIT`. **VERIFIED.** `NEXT-STEPS.md:1342–1353, 1409–1415`.

### Four defects only a real host found
With the offline suite fully green: **(1)** seven declared dimensions scoring 7 plus four *undeclared* ones
scoring 10 gave `passed: true, overall 8.09`; **(2)** `workspace_dir` silently dropped (§3);
**(3)** `record-review` demanded the `diff` be retyped *and* blamed the caller for changing files that had
not changed; **(4)** `action=pick` did not change phase while the reply said "allowed next: PICK" from PLAN.
They need a real delegation depth, real reviewer behaviour, a real multi-call sequence and a real
end-to-end flow respectively. All fixed with regression tests and mutants. **VERIFIED on a real host.**
`NEXT-STEPS.md:1421–1440`.

### The bootstrap checklist message was inverted — **FIXED**
`buildBootstrap()` printed "Every feature is already complete; move to HANDOFF." while features remained,
because the `open_feature` item's `todo` branched on `counts.total > 0` instead of `counts.open > 0`.
Checkbox state was right, so no allow/deny decision was wrong — only the sentence misled. Fix: the same
`counts.open > 0` drives `done` and the choice of `todo` text; the two closed cases keep their own
`counts.total` conditions. **VERIFIED** by `test/governance.test.mjs` — `the bootstrap open_feature item
never says "every feature is complete" while one is open`, plus `the bootstrap still names the genuinely
closed cases`. `NEXT-STEPS.md:1558–1568`.

---

## 5. Fail-open gates and the gate contract

### `NaN` comparisons silently disable every veto
`bar: abc` passed everything, since `score < NaN` is always false, and it survived four rounds because each
fix still validated the **coerced** value — `Number('')`, `Number([])` and `Number(false)` are 0 and
`Number(true)` is 1, all inside the legal range. Fix: validate the **type of the raw value**
(`typeof rawBar !== 'number' || !Number.isFinite(rawBar) || rawBar < 0 || rawBar > 10`), refuse an unusable
gate explicitly, and test **by type** rather than enumerating values. The write side was reachable too, so
the check belongs at every entry with identical semantics. **VERIFIED.** `NEXT-STEPS.md:1036–1043, 1220–1238`.

### A consistency test that copies the code's own parameters proves nothing
The "write side and gate agree" test stayed green while **both** sides were broken identically; when a
mutant restored `Number()` coercion, the contract test went red and the consistency test passed. A contract
test asks "is this value right?", a consistency test "do the sites disagree?" — so one that calls the
function under test, or copies the same missing option, is a tautology; that is exactly what
`lib/consistency.test.mjs` did by omitting the same `allowEmpty` the implementation omitted. Fix: both
layers, with the correct answer written into the test independently. **VERIFIED.**
`NEXT-STEPS.md:1094–1108, 1169–1174`.

### One shared gate definition, and the third write path nobody counted
Every round found the same fail-open through a new door, because `runReview`, `decideVerdict`,
`validateSettingValue` and the browser panel each reimplemented the rule and disagreed — the panel worst,
turning `Number('')` into `bar: 0`, the most permissive legal value, bypassing the validator. Fix:
`lib/gate.js` as the single definition, all four surfaces routed through it, and `readEvaluatorGate`
refusing a `mustPass` naming a dimension `dimensions` does not score. The same shape recurred for
configuration: the listener ignored an unparsed approval section and used the strictest fallback while
`workflow_status` and `workflow_set` each re-derived it and reported the user's written strength, so status
printed `approval: off (denyHigh=false)` with no BROKEN marker while the runtime asked about every
controlled call. Fixed by extracting `readApprovalForProject()` shared by all three callers. **VERIFIED.**
`NEXT-STEPS.md:1071–1092, 1529–1536`.

### `mustPass: []` failed every review while status called it healthy
One function, two call sites, two options — `gate.js` passed `{ allowEmpty: true }` and `review.js` omitted
it. The test that "asserted" the property only checked `configWarnings`, never `decideVerdict`/`runReview`:
a claim about review made at the one layer where the claim happened to hold. Fix: `allowEmpty` everywhere,
plus behavioural end-to-end assertions instead of comparing two functions. **VERIFIED** — it was the real
host's first blocker. `NEXT-STEPS.md:1151–1174`.

### `undefined` means "unset", never "strictest"
A branch named and documented fail-closed used the caller's document defaults, so a `low` call was let
through: `readApprovalGate(unreadable ? undefined : …, defaults)`, where `undefined` means "not set ⇒ use
the caller's defaults", not `FAIL_CLOSED_APPROVAL`. A test asserted `riskThreshold ===
DEFAULTS.riskThreshold`, certifying the defect. Fix: pass `FAIL_CLOSED_APPROVAL` itself, assert on the
**semantic constant**, and run the full 4 × 3 matrix against the returned gate. Keep the asymmetry: **not
written** ⇒ document default; **written but broken** ⇒ strictest. **VERIFIED.** `NEXT-STEPS.md:1543–1552`.

### Renderer shape guards must cover every field the body dereferences
Guards checked `perDimension`/`issues` while the body also read `verdict.failedVeto` (`.includes`) and
`review.verified` (`.length`/`.map`); and `renderStatus` assumed `mustPass` was an array, so
`(x ?? []).join()` threw on a string written by `workflow_set path=evaluator value={mustPass:'…'}`, accepted
because a whole-section `evaluator` write fell through to `return null`. The host turns a throwing `render`
into a contentless projection error, so the plugin's main read tool went dark. Fix: guards on every
dereferenced field, a rule for the whole section, and rendering **every** malformed configuration a
hand-edited file can produce — before `test/status.test.mjs` existed, `buildStatus`/`renderStatus` were
referenced **zero** times under `test/`. **VERIFIED.** `NEXT-STEPS.md:1040, 1176–1200`.

### Two ways a test lies about a crash
A mutant that made the renderer treat `problems` as an array survived, because the payload was a string and
`for…of` over a string iterates characters without throwing — use a non-iterable payload, and grep the live
condition rather than the mere presence of a string (which passes for `if (false)`). Related:
`{ toJSON: () => ({...}), get path() { throw } }` makes `JSON.stringify` succeed while `Object.entries`
throws, so traversal must return "unreadable"; testing only "a getter throws" does not reproduce it, because
`stringifySafely` returns early. **VERIFIED.** `NEXT-STEPS.md:1514–1518, 1553–1557`.

---

## 6. Lenient date parsing

### `Date.parse` accepts garbage, turning three fail-closed guards into dead code
`added_at: 'sometime in 2026'` was reported `provably-due` with "283 day(s) since added_at sometime in
2026", an unreadable window behaved as an open window, and an observable-only constraint was satisfied by
*every* retained entry — because `Date.parse('sometime in 2026')` is a real timestamp and
`Date.parse('12345')` is not `NaN`, making every guard premised on "unreadable ⇒ NaN/null" unreachable.
Fix: a **strict reader** accepting only the shapes the framework writes (`YYYY-MM-DD`, full ISO date-times)
plus ISO variants a human might type, with a **UTC round-trip check** so `2026-02-31` is not rolled to
`2026-03-03`; a space-separated local time escalates as unreadable. **VERIFIED.**
`NEXT-STEPS.md:1746–1773`.

### Two tests contradicted each other, and the older one was wrong
The identical shape was asserted `not-due` in one passing test and `due-for-human-review` in another, the
ambivalence coming from documentation wording that read literally would put every signal-bearing constraint
in the human bucket. Fix: judged for `not-due` on three grounds — a whole code branch written for it, the
bucket's own claim text, and the design's purpose (`--retire-check` lists constraints **due** for
retirement; one written 0 minutes ago with a 30-day window is not a candidate) — and the failing test was
replaced with **stronger** assertions. The literal reading remains a recorded divergence: if preferred, the
other test and the claim text must change, since only one can stand. **VERIFIED.**
`NEXT-STEPS.md:1775–1807`.

---

## 7. The mutation harnesses

### REAL INCIDENT: two harnesses ran concurrently and left two mutants in the tree
**Two mutants stayed permanently in the source tree while both processes printed
`sources restored byte-for-byte: YES`** — each verifies only its own restoration, so a quiet mutant keeping
the suite green would leave silently polluted sources and still print YES. A second occurrence: hard-killing
a harness running M01 skipped `finally`, left the mutation in `lib/work-unit.js:47`, and five red tests were
misdiagnosed as test isolation (diagnose by comparing the constants against the harness's `from` literal).
Fix: `withMutationLock`, acquired by atomic create (`{ flag: 'wx' }`, exactly one winner) into
`tooling/.mutation-lock`, and if held it **fails loudly, exits 2 and never queues**, because a queue looks
like a hang. Signal handlers register **before** acquiring, since Node runs them in registration order.
Every harness is wired to it, so any pairing is safe — the journal documents the original six, and the
verification-depth harness added later takes the same lock — and the work-unit harness now verifies its own
restoration (exit **3** on failure). **VERIFIED.** `NEXT-STEPS.md:2830–2905, 3019–3028`.

### Stale-lock takeover stole a LIVE holder's lock
Reproduced with a string `at` and a live pid:
`(the holder pid 26200 is still running but the lock is 1791808015s old, over the 1800s cap)`. `1791808015`
is the whole Unix timestamp, the signature of `Date.now() - 0`: `typeof holder.at === 'number' ? holder.at :
0` read an unreadable age as epoch 0 ("infinitely old"), and "over TTL" **alone** authorised takeover even
though the holder's label, pid and host had been read and the pid was known alive. Fix: unreadable or
holderless lock ⇒ stale (never hang forever); **age unreadable: live pid ⇒ refuse**, dead pid ⇒ stale,
undeterminable pid ⇒ stale; age readable: over TTL ⇒ stale **even if the pid looks alive**, within TTL + dead
⇒ stale, within TTL + live ⇒ refuse. `describeHolder` prints `acquired=?` — "print 1970" and "read as 0" are
the same lie twice — and `readLockTimestamp` accepts only an epoch-**ms** integer string or a date-time with
an **explicit zone**, rejecting a bare date ("whose midnight" must not be guessed) and a 10-digit value
rather than unit-converting it. **VERIFIED** — 6 new cases, existing 13 unchanged, L1–L4 all RED.
`NEXT-STEPS.md:2914–3029`.

### Anchors must be line-ending independent
Five mutants reported `anchor occurs 0 times`, read as "the test has a hole": `lib/config.js` is CRLF while
`lib/review.js` and `lib/tools.js` are LF, and the harness wrote anchors with `\n`, so the mutation never
applied and the script only reported "not killed". Fix: fold `\r\n` for matching while the restoration check
reads the **original bytes**, so normalisation does not dilute "byte for byte", and name both possible
meanings in the message — wrong anchor, or a dirty tree. Related: a mutant can be behaviourally
**equivalent** (removing backslash normalisation still returned `security`, because a basename fallback
matched), so assert the two lookups separately and record equivalence rather than pretending to kill it.
**VERIFIED.** `NEXT-STEPS.md:172–204, 452–455`.

### The test runner was an empty shell
`run-unit-tests.mjs` printed green summaries while errors were invisible: it defined `globalThis.test`
before importing the test files, but they `import { test } from 'node:test'` and **ESM import bindings are
read-only**, so the stub was never used and Node's own runner ran everything. Fix: `spawnSync` with
`node --test --test-isolation=none`, noting that single-process mode does **not** accept a directory (list
the files) and that piped stdio is refused in this sandbox (EPERM), hence `stdio: 'inherit'`. **VERIFIED.**
`NEXT-STEPS.md:760–766`.

### A captured child cannot be a pipe inside the DSH sandbox — **FIXED**
Every mutation harness spawned its child with piped stdio so it could parse TAP and read the exit status.
The sandbox denies a named pipe, so in the installed environment the harnesses could not start their
captured child at all (`spawnSync` failed with `EPERM`) — and a harness that cannot run is an evidence gap,
not a pass. Fix: `tooling/child-output.mjs` redirects the child's stdout/stderr to temp-file **file
descriptors** and returns `{ status, signal, error, stdout, stderr }`; TAP parsing, exit codes, lock
handling, printed wording and byte-for-byte restoration are unchanged — only the transport moved.
**VERIFIED** by running `mutation-check-approval.mjs`, `mutation-check-verification.mjs` and
`mutation-check-work-unit.mjs` inside the sandbox: all three reached their mutants and printed the restore
line, where before they could not start the child. `test/child-output.test.mjs` covers split streams, exit
status, spawn failure and large output. The UI harnesses still cannot run there — they launch Chromium for
the layout test — so `mutation-check-client/-panel/-project-tab` need a normal terminal.

### Restoration verification is weaker than it looks
`mutation-check-approval.mjs` judged restoration **indirectly** (unit + smoke go green after rollback) and
never compared bytes; it also exited 0 when an anchor failed or a mutant survived. Fixed: every restore is
compared with the original **Buffer**, anchor matching folds `\r\n`, and `missed.length > 0` or
`caught !== MUTANTS.length` exits 1. `tooling/mutation-check-lock-probe.mjs` is still a one-shot probe,
not one of the official harnesses, and is **not wired into the lock**. **VERIFIED** for the approval
harness (`sources restored byte-for-byte: YES`, 65/65 active mutants; M32 was removed because the writer
now refuses the unreadable-file path it exercised); the lock-probe caveat remains.
`NEXT-STEPS.md:2885–2886, 3031–3035`.

---

## 8. Review calibration

### An unbounded adversarial loop cannot terminate
A delegated review ran 40 minutes without converging; over six offline rounds, ~15 reachable defects versus
6 unreachable, while one real end-to-end run found 4 defects, all reachable, in one round. The structure is
that `passed` is false if any `mustPass` dimension is below the bar, that score is purely the reviewer's
judgement, and nothing asks it to separate a bug a user will meet from a shape only a hand-written payload
has — so one more theoretical shape always exists. Fix: require `reachable` plus a concrete `reach` on every
issue and let it **control the veto**; `evaluator.maxRounds` 3 → 2 with `exhausted` an honest terminal
state; add the missing prompt counterweight; and print reachability so a human reading PASS sees what was
waived. The fix itself nearly introduced a fail-open, letting "low score with no supporting issue" pass —
the rule is: no issue explaining the score ⇒ veto; all issues unreachable ⇒ does not block; one reachable
issue ⇒ veto. **VERIFIED.** `NEXT-STEPS.md:1570–1630`.

### An inflated headline cannot override a failed veto dimension
`[{correctness: 3}, …six 10s…, {correctness: 10}]` gave `passed: true, overall 9.13` — the back door this
feature closes — because `byDimension` used `Map.set` (last wins) to decide the veto while `aggregateScore`
averaged **all** entries. Fix: the framework recomputes the total and runs `mustPass` itself, duplicate
dimensions take the **lowest** score, and duplication makes the review invalid. Its twin is the
undeclared-dimension padding above: the same hole through two doors. **VERIFIED.**
`NEXT-STEPS.md:1017–1022, 1425`.

### Unreachable findings must not block — but must not vanish
A review reporting only unreachable problems as blockers burns the budget that should find the next real
defect, and silently dropping a finding is worse. Fix: reachability controls the veto, `observations` are
recorded and displayed, and the verdict distinguishes `failedVeto` (reachable), `unjustifiedVeto` (below
bar, all defects unreachable ⇒ does not block) and `unexplainedVeto` (below bar with no explanation ⇒
blocks). **VERIFIED.** `TESTING.md:176–187`.

### A declared class cannot override the evidence
A change touching `lib/approval.js` declared `class: docs` — depth 0 — but a declaration is a **claim** and
`changed_files`/`diff` are evidence. Fix: the resolved depth is the **stricter** of the two, so a
declaration can only add cost; `security` is not degradable at any setting; a refusal names the contradicting
file **and still reports the class and depth that will be used**; the shallowest class with no evidence is
refused; and no declaration with no evidence raises the depth and requires review. `filesFromDiff` reads
only `git`/`+++`/`---` headers, never bodies, so a comment mentioning a security file cannot escalate a
change and a rewording cannot dodge the check. Instructive failure: `class: docs` + `lib/client.js` was
initially refused because `ui` was depth 1 and `logic` depth 2, and the fix was **not** to allow the
downgrade but to raise `ui` to `logic`'s depth and add a human check, because a renderer is executable code
*and* unmeasurable here. **VERIFIED** — V01–V27 all KILLED. `NEXT-STEPS.md:33–50, 128–168`.

### A `git status` cross-check is not a security boundary — the framework does not reconcile the file list
A framework-side cross-check of the author's `changed_files` against `git status --porcelain` was built on
a WIP branch and then **dropped before landing** (P2.B1+). Three measured reasons. **(1)** `git status`
reports only **uncommitted** changes, so a committed path is invisible; it is a convenience check, not a
security boundary. **(2)** Its default runner captured git through piped stdio, which the DSH sandbox
denies (`spawnSync git EPERM`), so in the installed environment the check could not run: it fell back to
the declared list and reported `NOT CHECKED`, and the review still proceeded. **(3)** Its marginal
completeness value over an independent reviewer instructed to run `git status` did not justify 649
implementation lines plus roughly 1,240 lines / 24 tests in the WIP branch's governance test file, and four
failed reviews. The landed design is **reviewer-side**: the author is told to run
`git status --porcelain` before review, and the independent reviewer is told to run it and report any
omitted path as an issue. **VERIFIED** that the reviewer prompt contains that instruction
(`test/governance.test.mjs`); the framework-side cross-check is not present. An honest model can still
miss generated or renamed files — the reviewer-side check reduces that far more cheaply, but it is an
instruction, not an enforced boundary. See [DESIGN.md §11.3](DESIGN.md#113-why-the-framework-does-not-reconcile-the-declared-file-list).

### Editing a reviewed file in a later feature stales an earlier PASS
A docs feature that edits `README.md`, `CONTRIBUTING.md` or `docs/TESTING.md` — files an earlier feature
covered — invalidates that earlier feature's PASS, because the fingerprint hashes the reviewed bytes.
`workflow_status` then reports `stale`, and `COMMIT`/`HANDOFF` refuse it. This is not a routing bug to
work around: it is what makes a PASS mean *these bytes*, and a PASS that survives arbitrary later edits is
exactly the claim-not-evidence failure the fingerprint exists to prevent. Fix at the planning level: scope
an edit to the feature that owns the file, or budget a **re-review** of the earlier feature. **Observed on
this repository** — the P2.B1+ `docs-truth` pass stales the `harness-sandbox` PASS on `README.md`,
`CONTRIBUTING.md` and `docs/TESTING.md`, and `harness-sandbox` must be re-reviewed after this pass rather
than having its evidence edited. The staleness mechanism itself is **VERIFIED** by the fingerprint tests;
never edit the evidence, and never ask `record-review` to accept a verdict the bytes no longer match.

### A `human_check` attestation is not proof, and a typed answer is not consent
The framework cannot prove a human looked at a screen, so it is recorded as `caller-attestation`, never
verified — its only advantage over not asking is that the requirement comes from a class the **user**
confirmed. Consent is only an **exact option-label match**, a typed answer is not consent, and confirmation
tokens carry a private `Symbol` brand so an in-process caller cannot forge one. **VERIFIED** — V15/V16/V17
KILLED. `NEXT-STEPS.md:78–90, 1676–1682`.

### A test that names the defect can still give a false guarantee
M61 "survived": deleting the target code left the suite green, because the test also carried a `source`
argument and an earlier condition caught the call first. Only mutation testing finds this class — ask "could
this test fail?", not "did it pass?". **VERIFIED.** `NEXT-STEPS.md:2776–2783`.

### Three observations deliberately left unfixed after round 2
Non-blocking; the review budget was exhausted. **(a)** `mergeConfigValue` merges every nested plain object
while the host's pipeline is bounded by `DEEP_KEYS`; they coincide today, but a future top-level object key
missing from `DEEP_KEYS` would let the browser keep siblings the host drops. **(b)**
`projectDefaultsUnknownNote` is declared in both dictionaries and rendered **nowhere** — a dead entry the
completeness test cannot see, since it only checks that rendered keys exist in the dictionary. **(c)**
`configLayerBadge`'s fallback has no direct case. `NEXT-STEPS.md:3202–3214`.

---

## 9. The client bundle and rendering

### The two-column sidebar defect that reading the source cannot reveal
The label column was about one character wide, wrapping Chinese labels per character, while the source was
**already** single-column (`minmax(0, 1fr)`) — so any code-reading conclusion is "one column", and it
rendered as two. Two conditions: `minmax(0, 1fr)` in a grid with **no definite width** resolves that track
to 0 (the panel root has only `maxWidth: 520px` plus `marginRight: 'auto'`), and each hint's
`gridColumn: '2'` — correct on the settings page, whose rows really are `200px 1fr` — **creates** the track
it names, so the implicit second track took everything. Measured in headless Chromium: `0px 244px` (label
0 px, 4 lines) before, `264px` after changing the hint to `1 / -1`, settings page unchanged at
`200px 131px`; an explicit `0px` second track is **not** a fix, squeezing the control to 2 px instead. Fix:
`panelRowStyle` uses `gridTemplateColumns: '100%'` (definite), hints and warnings span `1 / -1`, and
`field()` inserts a `grid-column: 1 / -1; height: 0; border-top` divider rather than a border on the label or
control, which live *inside* the grid. **VERIFIED** (geometry); the visual result is a human's check.
`NEXT-STEPS.md:235–303`.

### Measure the wiring, not the constant
The mutant that wired the panel to the **page's** row styles still measured single-column, because
`measureLayout` read `panelRowStyle` directly to build its HTML. Fix: read the name after `rowStyle:` in the
`SidebarPanel` source and take that style. The tests also extract styles **from `lib/client.js`**
(comment-aware brace matching — style blocks contain `}` inside JSDoc), so they measure the shipped styles;
with no Chromium-family browser they skip and say so. **VERIFIED** — M27 caught. `NEXT-STEPS.md:298–303`.

### `=== true` hides the panel on every boot
The panel vanishes silently at every start, because the controller's **first snapshot is
`{ status: 'idle', value: undefined }`** — "not read yet" is not "switched off" — so
`value?.showInSidebar === true` is false and the panel is never registered. Fix: `!== false`, pinned with 7
"not read" shapes plus 3 "not ready yet carrying a stale value" shapes.
**VERIFIED.** `NEXT-STEPS.md:2206, 2211–2215`.

### The switch wrote the core row while the gate read the panel row
The switch did nothing at any value with 417 tests green, because `showInSidebar` is declared on the
**panel** row but the settings page receives the **core** row's controller, and nothing bound the namespace
written to the namespace read. Fix: a module-level `panelConfigController`, with the body entry's `inject`
handing over both controllers; the regression test is `the sidebar switch READS and WRITES the same
settings namespace`. **VERIFIED** — M15/M16/M17 red. `NEXT-STEPS.md:2221–2231`.

### The panel body had no `t` seat
In an English session the body renders Chinese and does not re-render on language change, because the
renderer installs `t` **only for entries declaring `locale`** and `locale: NS` was declared only on the icon
entry — which receives only `{ size, active }`. Fix: `locale: NS` on the body registration, plus the same
pre-existing gap on `plugins.row.config`, hidden until then by a dictionary fallback. **VERIFIED** at source
level; never seen rendered. `NEXT-STEPS.md:2232–2239`.

### The sidebar switch was a one-way door
Once switched off there was no in-product way back, because `showInSidebar` lives in the **profile patch**,
*above* `.dsh/workflow.yml` and therefore above `workflow_set` — and the writer rejects booleans. Fix: the
panel row also registers `plugins.row.config` carrying the same switch, "the only in-product recovery
path", pinned by tests requiring both rows to register the page, the page to render the switch, and the hint
text to stop pointing at `workflow_set`. **VERIFIED** at source level; never walked on a real host.
`NEXT-STEPS.md:2262–2282`.

### Three empty shells that read as working code
The design listed the sidebar panel three times and shipped a shell: `applyPanel()` only logged, while its
comment claimed the browser half was declared by `exports["./panel/client"]` — **that export never
existed**; `sidebar.panellist` was never registered; `showInSidebar` had **zero readers**. All fixed and the
comments corrected, not deleted: a comment describing something that does not exist is worse than none,
because it terminates the search. **VERIFIED.** `NEXT-STEPS.md:2160–2165`.

### The entry and its body share one id
Clicking the sidebar entry throws "selecting a missing main entry throws" and the selection does not change,
because the entry and body are keyed by the same `id`, so registering half is a click away from an
exception. Fix: both halves register in the **same** `whileServed` callback and are withdrawn by the
**same** disposer, and the second argument is an **icon component** rendered inside the button with
`{ size, active }`, not a page. **VERIFIED** at source level. `NEXT-STEPS.md:2167–2180`.

### `simulate-client-scan.mjs` needs the shipped bundle, not a vendored copy
It scans the current checkout by default and requires
`DSH_CLIENT_MODULES_BUNDLE=<extracted>/dsh-client-modules/lib/index.js`; the host implementation is not
vendored. No simulation replaces the real window: if anything mismatches, bring back the console output
and a screenshot. **VERIFIED.** `NEXT-STEPS.md:3183, 2143`.

---

## 10. Deployment and the approval gate self-deployment exemption

### The gate blocked its own deployment
Deploying means copying `lib/` into the profile's `node_modules/<package>/` — over the very approval module
judging the copy — and the gate refused, **correctly**, four agents in a row, leaving only worse options:
open a configuration window to switch the gate off, or copy out of band with **no audit record**. Fix: an
explicit, narrow, auditable authorisation anchored at the package directory the module itself was loaded
from (`selfInstallRoot()`) — **not a config item**, with no switch pointing at an arbitrary path and no "all
profile packages" category. Six conditions, all required, anything unreadable meaning no exemption: the
package dir resolves and is not the volume root; not a shell/exec channel; no command/script body; at least
one **destination** argument; every destination inside the package dir (`..` escapes, symlink escapes and
prefix-matching siblings all count as outside); every `source` inside the session project. `cwd` is neither,
and unreadable keys count as destinations. It runs **after** `detectExfiltration`, so a call that also looks
like exfiltration stays **high** and is refused monotonically, and `decideStrength` was not changed by a
byte — only the classification moves from medium to low, leaving thresholds, strength and `denyHighAlways`
intact. `selfDeployAuthorised` increments **only on a real release**, an `info` line names the anchor, and an
unresolvable anchor logs **DISABLED** rather than widening the range. `workflow_status` does **not** render
that counter, since it lives in `lib/tools.js`, outside that round. **VERIFIED** offline — the harness is now 65/65 active mutants and
review round 1 PASS 8.71 with 0 unexplained differences. `NEXT-STEPS.md:2508–2605, 2762–2798`.

### What the exemption still refuses, and why that is structural
Deliberately uncovered: `pwsh -Command "…"` / `bash -c "…"` (a command acts on paths appearing in no
argument), `node tooling/sync-to-profile.mjs` (opaque script), anything with a `code`/`script` body
including `run_code`'s inner call, and any call whose destination cannot be read — all still medium, still
threshold/reviewer/human. The reason, written into the code and important beyond one file, is that **a
text-pattern exemption can only be satisfied by making the action not match — hiding, splitting or encoding
a literal — which is the shape of malware, and a legitimate deployer must never be pushed into it**:
structure can be checked, text can only be dodged. One measured consequence, recorded honestly: exempted
calls are **no longer** subject to step 4's `RISKY_TEXT` and step 6's external-link heuristics —
deliberate, because those scan the **payload text**, and a deployment's payload *is* this plugin's own
source containing its own trigger words. **VERIFIED** — M47–M61 caught. `NEXT-STEPS.md:2546–2556, 2790`.

### The exemption cannot authorise its own first deployment
The copy running the gate is the **old copy in the profile** (`file:` dependencies are copies) and predates
the exemption, so the first deployment still needs one **out-of-band copy** — a human, or a session the gate
does not govern; after that the loop closes. Also, **never copy part of the files**: `lib/tools.js` depends
on `lib/work-unit.js`, and omitting the latter makes `tools.js` fail at import, so the tool surface
vanishes. **VERIFIED.** `NEXT-STEPS.md:2633–2638`; `TESTING.md:45–61`.

### A whole-file `write` of `lib/approval.js` passes by coincidence
The file's own body contains both sample literal classes — `SECRET_VALUE_PATTERNS`' session-cookie name and
`EXTERNAL_DESTINATION`' network-command word in a comment — and when both land inside `MAX_SCANNED_CHARS`
(20000) the write is judged **high**, the first guard-enforced rule. Measured this time at characters
**20119** and **20837**, just outside the window, so it was low: **coincidence, not guarantee**, since the
file growing or shrinking flips it. The literals are not reproduced here or in the journal, because writing
them out in scanner-evading form is what this project forbids; their definitions are in `lib/approval.js`.
Fix: deploy with `edit`/`ops_replace` fragments, or out of band. Verified in place:
`MAX_SCANNED_CHARS = 20000` at `lib/approval.js:450`. `NEXT-STEPS.md:2644–2656`.

### The behaviour-delta comparator was direction-blind and permanently red
It failed forever on a **correct** state — and a check that is always red gets ignored, then protects
nothing — because it accepted only "the workspace copy carries the marker", while the exemption is anchored
at **each copy's own** `selfInstallRoot()`, making it legitimate for the installed copy to authorise a path
inside the installed package and not the workspace one. Fix: a side carries the marker **iff** the path is
inside *that marking copy's own* package directory, decided by calling that copy's own exported
`selfInstallRoot()` and `containmentAgainst()` — never a second implementation, or the checker drifts from
what it checks — with only `'inside'` counting and a drifted anchor an immediate FAIL. A real fixture bug
went with it: `dirname(module)` made "inside the package" mean `...\lib\lib\approval.js`. SKIP also exited
**0**, so "not checked" read as success; it is now exit **2** with `RESULT: NOT CHECKED`, and 0/1/2 are
never merged. The comparator self-tests each run, and an injected wrong expectation printed
`RESULT: FAIL — the comparator itself is broken`. It still cannot prove that wrongly marking an in-package
call as self-deployment is wrong, and reads only the **first** destination argument, with `unknown` counting
as not earned. **VERIFIED.** `NEXT-STEPS.md:2690–2758`.

### `sync --check` can report a CRLF/LF difference that is not a change — KNOWN, UNFIXED
`tooling/sync-to-profile.mjs --check` decides identity by byte-exact comparison
(`readFile(source).equals(readFile(target))`, lines 59 and 73). A line-ending-only difference — workspace
LF, installed copy CRLF, or the reverse — is therefore reported as `DIFFERS` / `n differ` even though the
text is semantically identical, and running the sync then copies the workspace bytes over and makes the
"difference" vanish without any behavioural change. The trap is concluding that a real change was pending,
or that the sync repaired something. It is a false alarm in the safe direction (it never hides a real
difference), but it erodes trust in `--check`, which is the one read-only step that must stay believable.
**Known, unfixed.** The fix is a content comparison that normalises `\r\n`/`\n` for the *verdict* while
still reporting the byte-level difference, so "same text, different endings" is distinct from "different
text". Source: `tooling/sync-to-profile.mjs`.

### A subagent cannot open a human interaction
Any mechanism requiring a human answer before writing fails inside a delegated child — this plugin's
recommended architecture — because `ctx.userQuestions.ask()` accepts only the runtime **root** and an owned
child throws `DELEGATED_CALLER`. The refusal direction is right, but the message must give a way out: put
the candidate in the child's final result for the root agent or user. **VERIFIED.**
`NEXT-STEPS.md:978–986`.

### "The framework evaluated it" is not "the framework understood it"
A GC reporting a natural-language retirement signal as "satisfied" drops a guardrail on a false premise,
which is worse than never retiring, since the constraint exists to prevent a failure that has not happened.
Fix: prove "due" only when **every** declared condition was genuinely computed and satisfied **and** there
is no free-text signal; anything uncomputable goes to needs-a-human with its own question; per-condition
`evaluated` flags are recorded and free text is always `signalEvaluated: false`. Two real defects of this
shape: an `added_at` usability check inside the `review_after_days` branch (so observable-only constraints
skipped it and a NaN window counted every retained entry), and `from === to` self-loop log lines counted as
phase transitions (so five log lines satisfied "five BUILD entries"). Test every new report field by asking
**was this value computed, or copied?** **VERIFIED.** `NEXT-STEPS.md:988–999, 1649–1673`.

---

## 11. Discipline

### Never obfuscate a literal to pass a scanner
**A real incident.** An agent wanted test data (a dotenv path and a URL) past the gate's argument scan and
concatenated the literal from fragments; **Windows Defender's AMSI saw the same pattern — concatenation
producing `https:` and a dotenv path is malware's standard static-scan-evasion signature — and flagged it
`Trojan:Win32/ClickFix`, raising a serious alert on the user's machine.** The only way to satisfy a
text-pattern rule is to make the text not match, which is indistinguishable from evasion because it *is*
evasion. Fix: put the literal in a **real file** (the gate scans the command line, not file contents), or
report being blocked — there is no third option. `USAGE.md §9`; `NEXT-STEPS.md:2678–2681`.

### Do not retry a refusal — and never follow a remedy that widens the gate
Approval decisions here are model-judged and therefore **non-deterministic**: two agents ran the **same**
`sync-to-profile.mjs` and one was allowed while the other was refused, and a command refused here had
already succeeded earlier elsewhere — so retrying exploits that non-determinism, and **"it passed last
time" is not authorisation**. Fix: read the refusal and follow it **only when the remedy is ordinary
project work**. A remedy that changes the approval or verification gate is a **human** action.

**The earlier version of this section was itself the A2 incident.** It named `workflow_set
path=approval.strength value=llm-only` as the remedy when `ask-user` could not be satisfied, and the
refusal text said the same. A delegated child — whose approval policy is `never`, so every prompt is
auto-denied — read that, ran the command, and then wrote what the gate had refused. The model was not
misbehaving; the system handed it a self-authorization and called it a remedy. The fix has six parts:
the refusal text names only a human action; `workflow_set` refuses a safety-gate write unless a real user
confirms it, and a child cannot ask; the pre-execute gate classifies every approval/evaluator/verification
write as medium so the gate participates; the gate judges the **explicit `workspace_dir` target** of a
`workflow_set`/`workflow_init`, not only the session cwd; the confirmation wording names the gate (not the
constraint ledger) and says the child refusal is automatic; and the process keeps the strongest gate it
has seen per project, so a direct file edit or a deleted opt-in file cannot lower or switch off the gate
mid-session. A verification-only confirmation must **not** clear that memory; the writer measures a
non-approval delta against the file, so it cannot legitimise an earlier direct approval edit. A weaker
file takes effect on a restart (or after a user-confirmed approval write), which is the only point at
which it is genuinely the user's configuration. **VERIFIED** by `test/approval.test.mjs` (the incident
replay, the direct-edit, delete and cross-axis cases) and the runtime's own status line.
`TESTING.md:91–112`.

### Do not measure a moving tree
Seven test failures appeared mid-round while another agent was editing `lib/client.js`, and a separate
mistake produced 32 failures by moving an old installed copy into the workspace in place of a file someone
else was editing. Fix: decide "who reddened it" by **controlled experiment** — swap your own changed files
for the installed copies and re-run; here the failing test names and counts were identical before and after
(7 and 7, name for name), exonerating the round, and the failures then went green on their own.
**VERIFIED.** `NEXT-STEPS.md:218–226`.

### A green suite is not evidence that the plugin works
Five recorded instances of "offline green, real host broken immediately" and four of "a test that cannot go
red is not a test". The five layers, in order: offline suite → mutation harnesses → sync + restart + real
host → independent review → delegate a real work unit, with layer 4 not substituting for layer 1 and layer
1 not substituting for layer 4. `CONTRIBUTING.md` states the gate. `TESTING.md:376–393`;
`NEXT-STEPS.md:1437–1440`.
