# Design

Why `dsh-workflow` is built the way it is, and the first-party sources each decision rests on. This
document is **rationale**, not instructions: for how to use the plugin see [USAGE.md](USAGE.md), for the
traps that shaped it see [PITFALLS.md](PITFALLS.md).

- **Design constitution: humans are lazy.** Every mechanism can be turned off in one sentence. The
  defaults must run without configuration. The places that need a human decision must be as few as
  possible — and they must be the ones that genuinely need judgement.
- **The goal** is to package Harness Engineering as a DSH plugin, so that "adapt the working mode to this
  task" is a change to one configuration block rather than a rewrite of prompts.
- **Non-goals.** Not an IDE, not code generation, not model training. Not a replacement for a spec
  framework — an existing spec directory can be declared as the state backend. Not full automation: a
  good harness does not aim to eliminate human input, so the intervention points are compressed into a
  few high-judgement nodes rather than removed.

Every mechanism and its source is tabulated in [References](#references).

---

## 1. Method: read the shipped host, do not guess

Every host fact in this document was read out of the unpacked official plugin bundle rather than
inferred from behaviour: `<DSH install>\resources\app.asar` was extracted, and the unpacked packages are the
corpus the design decisions cite. Reading the source is faster than guessing, and it is the only method
that distinguishes "the host rejects this" from "the host silently ignores this" — a distinction this
project has repeatedly paid for.

Two consequences are load-bearing throughout: several host failures are **silent** (no error, no log,
no network request), so a guess that happens to work today is not evidence; and where a host rule is
mirrored in our own code, it must be mirrored **by a differential test that runs the host's own
function**, never by impression.

---

## 2. Configuration layering (L0–L3)

DSH presets register at start-up, so the design separates **parameters** from **start-up registration**
into four layers:

| Layer | What it is | When it is read |
|---|---|---|
| **L0** | The profile patch entry (`id: dsh-workflow`) | Registration at boot |
| **L1** | That entry's `config` block — the settings page, guarded by a `revision` fence | As this project's *defaults* |
| **L2** | The project's `.dsh/workflow.yml` | **Re-read on every tool call** |
| **L3** | Per-call arguments | Every call |

**Precedence is L3 > L2 > L1.** Three design consequences:

1. **The settings namespace is the profile entry's `id`.** The host and the browser half therefore
   address the same namespace using the same identifier; the patch's `id` *is* the settings namespace.
2. **Changing one line of YAML takes effect without a restart**, because L2 is re-read per call. The
   sidebar panel and `workflow_set` write the same file and are exactly equivalent.
3. **Existing conversations are safe.** A project with no `.dsh/workflow.yml` is treated as *not opted
   in*: it gets a notice and nothing else. The plugin **never takes over implicitly**, so installing it
   cannot change the behaviour of any existing session.

### 2.1 Distribution form

The host half is an ordinary package (`main: lib/index.js`, plus a `dsh.bundle.patch` pointing at
`cordis.patch.yml`). The browser half adds `exports["./client"]` and a `dsh.client` declaration.

Hard requirements the host imposes:

- **Only pre-built client bundles are served.** `lib/client.js` must exist before start-up; if it does
  not, activation fails and reports the build instructions and the package/path list.
- **`external` lists only non-baseline modules.** React, Cordis and the static UI libraries come from the
  shell's frozen module table, not from the bundle.
- **The entry is `window.__ModuleLoader__.load({ id, factory })`.** It registers a factory only;
  side effects are deferred to first materialisation.
- The composition step refuses malformed requests, missing suppliers, self-requests, and synchronous
  dependency cycles.

### 2.2 Multiple components in one package

Following the `dsh-ops` precedent: one npm package, several component entries, each an independently
switchable Loader row (`/core`, `/panel`). The point is **a disabled panel while the tools keep
working** — if the panel breaks or is unwanted, the model-facing surface is untouched and parameters can
still be changed with `workflow_set`.

### 2.3 Registering the settings form

The settings form registers on **`plugins.row.config`**, a *component-level* slot keyed by
`` `${packageName}#${rowId}` ``, mounted through `ctx.slots.inject(slot, () => ctx.slots.register(…))`
so registration waits for the slot. `plugins.item` is a **package-level** slot: registering the form
there does not render it. (This corrects an earlier assumption in this document's first revision.)

---

## 3. Architecture

```
L1 defaults ─┐
             ├─► ConfigResolver ─► ModeResolver ─► planner / generator / evaluator / verifier / gc
L2 project ──┘        (tier + recipe + per-key overrides)          │
                                                                   ▼
                                                            StateStore (dual track)
                                                                   │
                                                            SubagentBridge (spawn/fork)
                                                                   │
                                                            ContextPackager
```

### 3.1 Context isolation

A whitelist assembles what a child sees:

- `include_always`: `design md`, incomplete `features.json` entries only.
- `include_by_phase`: `plan` → the user request; `negotiate` → the feature item and constraints;
  `build` → feature item, acceptance criteria, constraints, relevant docs; `evaluate` → feature item,
  acceptance criteria, diff, test result, report path.
- `exclude_always`: tool-call history, error logs, prior attempts, chain of thought.
- `budget.max_inline_tokens: 12500` — aligned with the host's spill policy — and
  `overflow: spill_to_file`.
- The child's output contract carries only `status`, `artifact_paths`, a summary of at most 200
  characters, `blockers` and `next_suggestion`. Everything else is dropped.

So the tool history, the errors and the dead ends **physically cease to exist in the parent context**.
This is the direct answer to context pollution, and it does not depend on the model's self-discipline.

The rejected alternative was relying on compaction. Anthropic's guidance is explicit that compaction is
not sufficient, and a child session is a structural cut rather than a summarisation.

---

## 4. The dual-track artifact contract

**The principle: JSON to prevent tampering, Markdown for humans to read.**

The reason is a first-party observation, not a preference: models are *less* likely to inappropriately
modify or overwrite JSON files than prose. Narrative belongs in Markdown, machine-owned state in JSON.

| Artifact | Writer | Readers |
|---|---|---|
| `.dsh/DESIGN.md` | planner | humans and all agents — goals, architecture, conventions, and why |
| `.dsh/FEATURES.json` | planner | generator, evaluator — agents may change **`passes` only** |
| `.dsh/PROGRESS.jsonl` | framework | append-only progress stream; **never overwritten** |
| `.dsh/CONSTRAINTS.json` | framework, after user confirmation | every constraint carries a retirement condition |
| `.dsh/ACCEPTANCE.json` | generator + evaluator | the agreed definition of done, fixed *before* the code |
| `.dsh/STATS.json` | framework | cost, iterations, intervention points, sensor health |
| `.dsh/reports/<feature>-<attempt>.md` | evaluator | timestamped score reports with concrete fixes |

`FEATURES.json` has a full schema: `schema_version`, `generated_at`, `source_request` (the user's words,
**never rewritten**), `features[]` (`id`, `category`, `description`, `steps[]`, `passes`, `priority`,
`acceptance_id`, `evidence[]`, `attempts`, `blocked_reason`), and a `notes` field stating that agents may
not add or remove array elements or edit `description`/`steps`.

**Write permissions are enforced by the framework, not by advice:**

- `passes` may be set only by an evaluator `PASS`; the generator has no authority to set it true.
- `steps` and `description` may be written only by the planner at `init`. Later changes are `FATAL` and
  rolled back.
- `evidence` is appended by the verifier.

That is what makes "only mark complete after verification passed" **structural** rather than
exhortatory.

---

## 5. The phase machine

### 5.1 Phase graph

```
INIT → PLAN → PICK → NEGOTIATE → BUILD → VERIFY → EVALUATE ─┬─ FAIL → NEGOTIATE (update constraints)
                                                            └─ PASS → COMMIT → next PICK
all features done → HANDOFF → optional GC
```

### 5.2 Phase responsibilities

| Phase | Actor | Output | Skippable |
|---|---|---|---|
| INIT | initializer child | `DESIGN.md`, `FEATURES.json`, `HANDOFF.md`, initial commit, run scripts | no (minimal degrades to not persisting) |
| PLAN | planner child | completed `FEATURES.json` | yes (minimal) |
| PICK | framework | highest-priority feature with `passes: false` | no |
| NEGOTIATE | generator ⇄ evaluator | `ACCEPTANCE.json` | yes (`acceptance.negotiate_before_build: false`) |
| BUILD | generator | code changes | no |
| VERIFY | verifier (computational sensors first) | `evidence[]` | yes |
| EVALUATE | **independent** evaluator | score + report | yes (minimal) |
| COMMIT | framework + generator | git commit, appended `PROGRESS.jsonl` | no |
| HANDOFF | framework | the next session's bootstrap checklist | no |

### 5.3 The fixed per-session bootstrap

Injected and not skippable:

1. read the tail of `PROGRESS.jsonl`;
2. `git log --oneline -20`;
3. read `FEATURES.json` and select a feature with `passes: false`;
4. run the init/verify scripts as a smoke check;
5. **if the smoke check fails, fix the foundation first and do not start new features.**

Steps 4 and 5 are a direct application of the first-party guidance: make sure the agent can quickly
recognise that the app has been left in a broken state and fix it immediately, because an agent that
starts implementing new features instead is likely to make things worse.

### 5.4 Acceptance negotiation

Order matters: agree on *what counts as done* **before** writing code. The shape is
`{feature_id, draft_by, revised_by, rounds, criteria: [{key, desc, check}], agreed, agreed_at}`, with
criteria keys such as `functional`, `no_regression`, `ui` and checks such as `e2e:test_new_chat`,
`e2e:test_history`, `manual|perf`.

### 5.5 Evaluation and the gate

The `evaluator` block: `independent: true` (must spawn a fresh child; same-session self-evaluation is
forbidden, `provider: spawn`), `bar: 8` on a 0–10 scale, seven dimensions (`correctness`, `build`,
`tests`, `regressions`, `arch_fit`, `legibility`, `scope`), `must_pass: [correctness, build,
regressions]` as a veto, `max_rounds` after which the decision escalates to a human, and a report format
of `score`, `per_dimension`, `timestamped_issues`, `concrete_fix`.

The rationale is the first-party finding that a self-evaluating generator has an inherent bias toward
its own output — so the report must be actionable, with each issue carrying a timestamp or location
**plus one concrete suggested change**.

### 5.6 Feedback precipitation

When a human or an evaluator raises a problem, judge whether it is a one-off or a repeat offence. A
repeat offence becomes a candidate constraint and is written to `CONSTRAINTS.json` **only after the user
confirms**. A one-off is merely recorded. The mandatory confirmation is what stops the ledger from
growing without limit.

### 5.7 Constraint retirement — the most important meta-rule

**Every constraint must carry a retirement condition.** The evidence is direct: as models get stronger,
the harness they need gets smaller, so a constraint with no way to expire is a permanent tax.

```jsonc
{
  "id": "C007",
  "rule": "implement one feature point at a time; do not do everything at once",
  "why": "…",
  "added_at": "…",
  "added_for_model": "deepseek-flash",
  "retire_when": {
    "signal": "five consecutive BUILD phases with no context_overflow and no half-finished commits",
    "review_after_days": 30
  },
  "status": "active"
}
```

`workflow_gc` lists retirement candidates on a cadence and **asks**. It never retires anything on its
own, and a retirement signal expressed in natural language is reported as **needing a human decision** —
never as "satisfied", because the framework cannot evaluate that sentence. Reporting an unevaluated
signal as satisfied would remove a guardrail on a false premise, which is worse than never retiring it.

---

## 6. Guides and sensors

Guides are feed-forward; sensors are feedback. Doing only one of them is a known failure mode: feedback
alone means repeating the same mistake, and feed-forward alone means never learning whether a rule
works. The matrix therefore requires the two to come in pairs, each labelled as **computational**
(deterministic, fast, reliable) or **inferential** (semantic, slow, expensive, non-deterministic), with
computational preferred.

| | Computational | Inferential |
|---|---|---|
| **Guides** | type definitions, schemas, architectural dependency rules, code templates, `init.sh` | `DESIGN.md`, `CONSTRAINTS.json`, skills |
| **Sensors** | type check, linter, unit/integration tests, **structural tests (dependency direction)**, build, smoke script | evaluator scoring, AI code review |

The doctor warns on a guide with no sensor, or a sensor with no guide. Sensor error messages are written
**for an LLM to consume**: they state what to change, which is a benign form of prompt injection that
closes the loop automatically.

---

## 7. Observability

`STATS.json` records `task_id`, `tier`, `features_done`, `total_features`,
`rounds {per_feature_avg, max}`, `cost {wall_clock_minutes, subagent_calls, tokens_estimate}`,
`human_interventions` and `human_intervention_points` (for example `"NEGOTIATE:F004"`,
`"EVALUATE:F006:max_rounds"`, `"CONSTRAINT-CONFIRM"`).

### 7.1 The cost baseline

The first-party measurement: a solo run took 20 minutes and $9; the same work under the full harness took
6 hours and $200 — **40× the time and 22× the cost**. Tier boundaries are therefore drawn by *the cost of
being wrong*, not by lines of code or project size.

### 7.2 Sensor health

The open question — "a sensor never fires; is that high quality or a weak detector?" — is turned into
metrics: `sensor_fire_rate` (a long-run zero means either genuinely high quality or insufficient
detection power, and warrants manual sampling), `guide_orphans` and `harness_coverage`. Low coverage
means **build the missing infrastructure first**, rather than adding more rules.

---

## 8. Tools

| Tool | Purpose |
|---|---|
| `workflow_init` | opt a project in; detect harnessability and select a tier |
| `workflow_status` | read-only: phase, effective configuration, resolved depth, host diagnostics |
| `workflow_advance` | drive the phase machine; refuse illegal transitions and name the legal ones |
| `workflow_review` | start an independent reviewer and record its verdict |
| `workflow_verify` | run the configured computational sensors for a feature |
| `workflow_gc` | constraint ledger: scan, list, add, retire — additive actions ask first |
| `workflow_set` | read or change one project-level parameter |
| `workflow_doctor` | harnessability assessment (see below) |
| `workflow_stats` | cost, iterations, intervention points, sensor health |

`workflow_set` is the facade for adjustability: the model or the user can change a switch and persist it
without hand-editing YAML.

The **harnessability** assessment checks whether a project can be driven at all — a strong type system, a
runnable test framework, clear module boundaries, a linter, a build script or a single command to start
the service, observability, and a git state that can be committed — and produces a 0–100 score plus
advice on what to fix first.

---

## 9. Tiers and recipes

### 9.1 The three presets

| | minimal | standard | strict |
|---|---|---|---|
| Persisting artifacts | none | `DESIGN` + `FEATURES` + `PROGRESS` | all |
| Planner | ✗ | ✓ | ✓ |
| Acceptance negotiation | ✗ | ✓ | ✓ |
| Independent evaluator | ✗ | ✓ bar 8 | ✓ bar 8 |
| Multiple agents | ✗ single | ✓ | ✓ parallel |
| Verifier | optional | ✓ | ✓ mandatory |
| Human intervention points | 1 (final acceptance) | 2 (negotiation dispute, score failure) | 3 (+ constraint confirmation) |
| **Fit criterion** | being wrong costs **< $9** | **$9–200** | **> $200** |

The rejected alternative was using lines of code or project size as the criterion. The cost of being
wrong is what actually determines how much harness is worth paying for.

### 9.2 Recipes

A tier is only a preset. Real adjustability comes from assembling a recipe out of phase actions:

```yaml
name: hotfix
bases: [minimal]
steps:
  - { action: pick }
  - { action: build, max_files: 3, forbid_new_deps: true }
  - { action: verify, sensors: [test], skip_full_suite: true }
  - { action: evaluate, bar: 7 }
  - { action: commit }
disable: [negotiate, gc, progress_md]
budget: { max_minutes: 60 }
```

Built-in suggestions: `hotfix` (small fixes; skip planning and docs, keep only the regression gate),
`spike` (exploratory; **explicitly exempt** from long-term conventions, output under `spikes/` and
marked do-not-merge), `refactor` (only structural sensors: dependency direction, duplication), `docs`
(doc-consistency sensor plus document GC), `review` (read-only: run the evaluator, produce a report,
change no code).

The reason a recipe mechanism exists at all is Ashby's law of requisite variety: you can only regulate
what your model covers, and fixing a topology is itself an act of reducing variety. A recipe makes the
chosen topology explicit and cheap to change.

### 9.3 The full configuration reference

```yaml
schema_version: 1
tier: standard                 # minimal | standard | strict
recipe: null                   # overrides tier when set

modules:                       # every mechanism can be switched off
  planner: true
  features_json: true
  progress_log: true
  handoff_doc: true
  acceptance: true
  independent_review: true     # strongly recommended to stay on
  self_verify: true
  gc_code: true
  gc_docs: true
  constraint_ledger: true
  stats: true
  git_commit_per_feature: true
  isolation: true              # turning this off increases token consumption markedly

context:
  max_inline_tokens: 12500
  overflow: spill_to_file
  exclude: [tool_history, error_logs, prior_attempts, reasoning]
  require_bootstrap: true

acceptance:
  negotiate_before_build: true
  max_rounds: 3

evaluator:
  independent: true
  bar: 8
  max_rounds: 3                # shipped as 2; see PITFALLS on the exhausted terminal state
  must_pass: [correctness, build, regressions]

verifier:
  sensors: [typecheck, lint, test, build, smoke, arch_test]
  stop_on_first_failure: true
  feed_message_style: actionable

guards:
  forbid_test_edits: true      # deleting or weakening tests is unacceptable
  forbid_new_deps: false
  max_files_per_feature: null
  require_human_on_fatal: true

subagent:
  max_depth: 2                 # an absolute bound on the delegation tree, not a per-call budget
  max_active_subagents: 8      # exceeding it raises ACTIVATION_LIMIT_REACHED; there is no queue

escalation:
  auto_upgrade_on:
    context_overflow: { threshold: 1 }
    feature_attempts: { threshold: 3 }
    scope_creep_detected: {}   # no threshold
    sensor_failure_repeat: { threshold: 2 }
  notify_channel: ask_user_question

budget:
  max_minutes: null
  max_subagent_calls: null
  on_exceed: ask               # ask | stop | continue

retire_check:
  enabled: true
  every_days: 30
  auto_suggest: true           # suggest only; never delete
```

Auto-upgrades are *suggestions* and require user confirmation; an escalation is not a silent tier change.

---

## 10. Human intervention points

The rule is: **anything that can be automatic is never asked**; what must be asked is asked one question
at a time with a recommended answer.

| Scenario | Human cost |
|---|---|
| Initialisation | one call |
| Day-to-day progress | zero — PICK → BUILD → VERIFY → EVALUATE is automatic |
| A score below the bar | zero — it recycles automatically up to `max_rounds` |
| `max_rounds` exceeded | one decision, presented with how many attempts were made and how each fell short |
| Negotiation deadlock | one decision, rarely |
| A mistake that will recur | one confirmation, carrying the retirement condition |
| A constraint reaching retirement | one confirmation |
| Budget exceeded | per `on_exceed` (default: ask) |

**Sign-off.** High-cost actions can be gated on an explicit sign-off:
`signoff: {before_generate: false, before_expensive_build: false, before_bulk_edit: true}`. A sign-off
point is a gate — the point is to avoid discovering a wrong direction after burning the budget.

---

## 11. Relationship to existing DSH facilities

The plugin does not replace a spec framework: `state_backend` can point at an existing directory, and the
plugin then only advances and validates state.

It deliberately **reuses** rather than reimplements: `compaction-basic`, `tool-result-pruner` (8192
characters), `spill-policy` (12500 tokens), `tool-todo`, `tool-goal`, `tool-ralph` (its `maxRounds: 64`
loop is usable at L2), `tool-subagent` (`provider: spawn`, the isolation primitive), the sandbox policy
and approval presets (`read-only` / `workspace-write` / `danger-full-access`), and `agent-instructions`
(`maxBytes: 65536`).

What the plugin adds is only what DSH does not have: a phase machine, an artifact contract, independent
review, sensor orchestration, and a constraint ledger with retirement.

### 11.1 Approval and privilege escalation

**The architectural decision: the approval gate hangs on `tools/pre-execute`, not on
`approval/request`.** The approval request body carries only the tool name and a reason — it does **not**
carry the tool arguments — so judging risk from it is signing blind. The official
`dsh-experimental-auto-review` takes the same route, and rebuilds a five-part context instead: fixed
policy, an environment of cwd alone, provenance-tagged project constraints, filtered history, and the
complete pending action.

Configuration: `approval: {strength: ask-user | llm-then-user | llm-only | off, risk_threshold: low |
medium | high (default medium), deny_high_always: true, reviewer: current-model}`. `llm-then-user` is
recommended. `llm-only` and `off` are off by default and require a second confirmation to enable; the
official warning text is displayed in the settings page when they are selected.

**The gate is not writable by the session it judges.** A denial is not permission to lower the gate.
`workflow_set` refuses a weakening approval/verification write unless a real user confirms it through the
host's question service, and a delegated child cannot ask one, so the child refuses and reports upward.
The pre-execute classifier also treats a gate-setting write as `medium`, so the gate participates even
before the tool runs. Finally, the process remembers the strongest gate it has seen per project: a direct
edit of `.dsh/workflow.yml` (or deleting it) cannot lower or switch off the gate for the rest of the
session. A weaker value takes effect on a restart, or after a user-confirmed write — the two moments at
which it is the user's decision rather than the session's. `workflow_status` reports the difference as
`DOWNGRADE IGNORED` / `OPT-IN FILE MISSING` instead of describing a gate that is not running.

The three-level risk model reuses the official definitions directly:

| Level | Meaning | Behaviour |
|---|---|---|
| `low` | ordinary in-project work; cleaning up objects this session created | allow |
| `medium` | deleting existing objects, production operations, external writes, security-relevant changes | intervene according to `strength` |
| `high` | sensitive exfiltration across a trust boundary | **always deny** |

The official warning, shown verbatim where it applies:

> Auto review is experimental: it can allow unsafe actions, deny useful work, and spend additional tokens.
> Auto provides no file sandbox. The outer `run_code` transport and direct Node effects inside a PTC program do not pass through inner-tool review.
> Model classification can be wrong. There are no deterministic tool exemptions, persistent grants, configurable policy, or retry layer.

**Implementation.** `ctx.on("tools/pre-execute", async (call, next) => …)`, returning `allow`, `deny` or
`ask`. `denyHighAlways` is evaluated before the `llm-only` branch. The monotonic half is
`ctx.tools.guard()`, which is synchronous and is consulted again when the waterfall finally decides
`allow` — including after a user has clicked "allow". That is what makes a provable `high` denial
impossible for a later listener, or any human confirmation, to flip back.

**Cost.** Each supported call costs one extra model request, with no caching, no retry and no truncation,
so approval cost is reported separately in `workflow_stats`, and `approval.exempt_tools` exists to let
high-frequency low-risk tools (read-only retrieval, for example) skip review.

### 11.2 The self-deployment exemption

The gate blocked its own fix and its own deployment — **correctly**, since a security control that
prevents modification of itself is a design feature, not a defect. But it produced a real treadmill: the
gate prevented its own repair and rollout.

The exemption is therefore defined **by structure, not by text patterns**:

```
anchor  = the package directory this module was itself loaded from (derived from import.meta.url;
          not a configuration item, with no switch that can point anywhere else)
covers  : non-shell calls + no command or script body + at least one "destination" argument
          + every destination resolves inside that package directory
          + every source is inside the session project
refuses : any shell/exec, any run_code or script body, any call whose destination cannot be read
```

A text-based rule can only be satisfied by **hiding or splitting a literal**, and a legitimate deployer
must never be forced into that. That is exactly the lesson of the Defender incident recorded in
[PITFALLS.md](PITFALLS.md). Structure can be checked; text can only be dodged.

The exemption is kept auditable: a counter increments only on a real release, and an `info` line names
the anchor. An unresolvable anchor disables the exemption and says so. The branch sits **after**
exfiltration detection, so a self-deployment *lookalike* that is really exfiltration stays `high` and is
still refused. Every unreadable input fails closed.

It also cannot authorise its own **first** deployment: the copy running the gate predates the exemption.
That first copy must be performed out of band. See [ROADMAP.md](ROADMAP.md).

---

## 12. The two hard constraints on the client half

These are **design constraints**, discovered from the host source, not implementation details.

### 12.1 A slash in a Loader entry name silently drops the browser half

The host extracts a package name from a Loader entry with a function equivalent to:

```js
function exactPackageSpecifier(specifier) {
  if (specifier.startsWith("@")) { /* scoped: exactly two segments */ }
  return !specifier.includes("/") && !specifier.includes(":") ? specifier : undefined;
}
```

A non-scoped specifier containing `/` yields `undefined`, and the manifest lookup **returns
immediately** rather than searching further. The consequence is that the whole browser half — bundle,
settings page, sidebar entry — is dropped **with no error anywhere**: nothing in the boot graph, nothing
in the console, no network request.

The countermeasure is structural: a multi-entry package must additionally mount one **bare package name**
row, which declares nothing and registers nothing (`rowKind: module`) and exists purely so the
`dsh.client` declaration becomes resolvable. That is why this package mounts three rows, not two.

### 12.2 Bundles are delivered batch-merged

The host merges bundles into a single request, e.g.
`dsh-app://app/plugins/??<pkgA>/client.js,<pkgB>/client.js&rev=<hash>`. Probing
`/plugins/<pkg>/client.js` individually therefore returns a **misleading 404**. The correct test for "am
I included" is whether your own entry appears in the boot graph (`window.__DSH_BOOT__`), or inspecting
the batch URL's contents in the network panel.

A hand-written lazy-CJS bundle works: as long as the shape is right, no official build toolchain is
needed.

### 12.3 Not depended upon

Deliberately **not** depended upon: `skill-filesystem`'s custom skill directory format
(`customSkillDirs` was unverified); the `agent-instructions` lookup rules (the plugin carries its own
`CONSTRAINTS.json` mechanism); and `tool-ralph` semantics (the phase machine is its own).

---

## References

### External sources

The original design document gave titles, authors and dates but **no URLs**. The canonical URLs are
supplied here; where an item was not read first-hand, that is stated.

1. **Anthropic, *Effective harnesses for long-running agents*, 2025-11-26** — read first-hand.
   - An agent that does everything in one go exhausts its context and leaves a mess; the next agent
     cannot see the state, guesses, and then *"declares victory after a cursory look"* → `FEATURES.json`
     plus `PROGRESS.jsonl` plus the fixed per-session bootstrap.
   - *"Use JSON instead of Markdown, because models are less likely to inappropriately modify or
     overwrite JSON files"* → the dual-track contract.
   - *"Deleting or modifying tests is unacceptable"* → `guards.forbid_test_edits` defaults to true.
   - *"Compaction is not enough"* → child-session isolation is preferred over summarisation.
   - *"Ensure Claude can quickly identify whether the app has been left in a broken state and fix it
     immediately; if the agent instead starts implementing new features, it will likely make things
     worse."* → bootstrap steps 4 and 5.
   - *"Only mark complete after verification passes"* → `FEATURES.json` enforced write permissions.
   - Cost baseline: solo 20 minutes / $9; full harness 6 hours / $200 → the tier split and cost
     observability.
2. **Anthropic, *Harness design for long-running application development*, 2026-03-24** — read
   first-hand.
   - The planner/generator/evaluator triad. An agent grading its own output *"has an inherent bias"* →
     `evaluator.independent: true` by default, and the evaluator must use `provider: spawn`.
   - The generator negotiates the *"definition of delivery"* with the evaluator **before** writing code →
     `acceptance.negotiate_before_build: true`.
   - The same cost measurements → the §7.1 baseline and the tier boundaries.
3. **Martin Fowler, *Harness engineering for coding agent users*, 2026-04-02** — read first-hand.
   - **Guides (feed-forward) / sensors (feedback)**; feedback only means repeating the same mistake, feed-forward
     only means never knowing whether a rule works → the mandatory pairing and the doctor's orphan warning.
   - **Computational** (deterministic, millisecond-scale, reliable) vs **inferential** (semantic, slow,
     expensive, non-deterministic) → every item must be labelled, computational preferred.
   - *"A sensor never fires — is that high quality or weak detection?"*, and the call to assess harness
     coverage → `stats.sensor_fire_rate` and the coverage report.
   - **Harnessability / ambient affordances:** *"the place that most needs a harness is the hardest to
     build one for"* → the doctor's 0–100 score.
   - **Ashby's law of requisite variety** — you can only regulate what your model covers, and fixing a
     topology reduces variety → the recipe mechanism.
   - Also: a good harness should not aim to eliminate human input entirely → the intervention-point
     design.
4. **OpenAI, *Harness engineering* — second-hand.** The original page returned 403; the details below come
   from Fowler's discussion and a video commentary, and are treated as second-hand.
   - Codex driving Chrome DevTools to screenshot, read the DOM and simulate actions; connecting to the
     observability stack to read logs, metrics and traces; **every task running in a fully isolated
     environment**; enforcing dependency direction with a linter and tests; and **background jobs
     periodically scanning the code and documentation, fixing and committing automatically** (garbage
     collection). Conclusion: *human steer, agents execute* → the verifier and GC modules, and
     per-task isolation.
5. **Mitchell Hashimoto, *My AI Adoption Journey*, 2026-02-05.** The original formulation: *"Whenever the
   agent makes a mistake, change the system so that it can never make that mistake again."* → the core
   feedback loop and `.dsh/CONSTRAINTS.json`.
6. **Bilibili, `BV12LR1B3EUt`** — <https://www.bilibili.com/video/BV12LR1B3EUt>
   - Opus 4.5 removed *context anxiety*; Opus 4.6 removed the *one-feature-at-a-time* constraint →
     **the stronger the model, the less harness it needs**, therefore **every constraint must carry a
     `retire_when`**. Declared the most important meta-rule of the design.
7. **Bilibili, `BV1hhHi65EnQ`** (AI-produced music video) — <https://www.bilibili.com/video/BV1hhHi65EnQ>
   - State persisted to disk (`design.md` / `progress.md`); the storyboard signed off **before** any image
     generation; **a pass mark of 8 on a 9-dimension score**; complaints turned into memory rules →
     the handoff document, the acceptance phase, `evaluator.bar`, the constraint ledger, and the
     sign-off mechanism.

### Repo-internal first-party sources

| Path | Fact | Where it landed |
|---|---|---|
| `refs/dsh-subagent/README.md` | "Direct service callers continue to supply their own optional request depth." | Context isolation is a framework-level guarantee |
| `refs/dsh-subagent/README.md` | "Children are isolated: a crashed or misbehaving child cannot corrupt the parent's session." | Context pollution is structurally cut off |
| `refs/dsh-client-modules/README.md` | "the host half **scans enabled Loader entries** and composes the boot graph", generating a bundle per `dsh.client` declaration; scanning is independent of where the package came from | The settings panel is a landing item, not a risk |
| `package.json` declaration form | `exports["./client"]` plus `dsh.client = { platform: "web", inject: [], external: [] }` | §2.1 |
| `refs/dsh-user-approval/lib/index.js:176` | `ctx.waterfall(…, "approval/request", req, () => "unavailable")` | The approval decision is mountable |
| `refs/dsh-experimental-auto-review/README.md` | Judgement goes through **`tools/pre-execute`** and reuses the current model, because **approval requests carry no tool arguments** | §11.1 |
| `refs/dsh-client-ui-settings-subagent/lib/client.js` | Registers on the settings slot, reads and writes through `ctx.configForms.get(NS)`, and carries a `revision` fence | §2.3 |
| `refs/dsh-client-ui-primitives` | Reusable components: `SettingsForm`, `SettingsValueField`, `Switch`, `settingsNumberField`, `SettingsFormModel` (staging, dirty checking, reset, save), `createSnapshotStore` | Panel implementation |
| `refs/dsh-ops` | One npm package, several component entries, each an independently switchable Loader row | §2.2 |
| `refs/dsh-client-modules/lib/index.js` | `exactPackageSpecifier` as quoted in §12.1 | The bare-package-name row |
| `refs/dsh-tools/lib/index.js` | `assertSupportedJsonSchema` — the enforced output/parameters subset | Tool definitions |
| `refs/dsh-app-boot/lib/index.js` | Config-schema projection: the host projects metadata and never executes the schema | The `Config` export rules |
| `refs/dsh-client-ui-plugin-manager`, `refs/dsh-client-ui-renderer` | The `sidebar.panellist` slot and its fields, the icon as second argument, the `key === entry.id` rule for the `main` slot, and the locale seat rule `if (entry.locale !== undefined) …` | The sidebar panel |
| `<DSH install>\resources\app.asar` | The official plugin packages, unpacked | The corpus for all of the above |

**Provenance note, preserved from the original:** items not read first-hand are marked as such — the
OpenAI original was unavailable (403) and its technical detail comes from Fowler's discussion and a video
commentary, making it **second-hand**. The two Anthropic pieces and the Fowler piece were **read
first-hand**.
