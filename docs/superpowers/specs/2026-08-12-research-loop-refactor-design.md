# Research Loop Refactor — Design Spec

- **Date:** 2026-08-12
- **Status:** Approved
- **Scope:** Refactor generic `/loop`, rebuild `/research` as a preset and policy over it, and make subagent execution provider-neutral.
- **Input:** `notes.org` review findings plus the decisions made during design review.

## 1. Goal

Preserve the program-driven research architecture while repairing its state, configuration, enforcement, and evidence boundaries:

- `/loop` remains a generic repetition engine that can execute any program.
- `/research` remains a preset and policy over that engine, not a hardcoded workflow state machine.
- The selected program and role prompts are frozen when a run starts.
- One self-contained research configuration owns all research operational values.
- Generic loop iterations and completed research rounds remain separate concepts.
- Subagent execution is selected through a replaceable provider contract.
- Research state and artifacts survive reloads and process crashes in a project-local workspace.
- Checkpoint and completion decisions derive from authoritative state and files rather than model claims.

The program continues to own research methodology. TypeScript owns mechanics, limits, integrity, and verification.

## 2. Non-goals

This refactor does not implement:

- a benchmark corpus, benchmark runner, optimization loop, or quality dashboard;
- the project-wide web-result cache, beyond reserving its integration path;
- a second real subagent provider beyond the bundled tmux adapter;
- live editing of an active run's program, prompts, configuration, or provider;
- migration of legacy research configuration, active research state, or `/tmp` workspaces;
- automatic deletion or retention policies for historical runs.

The web-result cache will receive its own follow-up design. Its reserved location is `.research/cache/web/`.

## 3. Approved decisions

1. Keep `/loop + program` rather than introducing a research workflow engine.
2. Treat the review notes as a strong proposal whose boundaries may be improved.
3. Use a hybrid capability model: package-owned capabilities resolve by name; user/provider extensions use explicit paths.
4. Use finite packaged iteration defaults. Unlimited iterations require `--max-iterations unlimited`.
5. Allow each profile's `maxRounds` to be an integer or `null`; packaged profiles remain finite.
6. Rename the configuration namespace to `research` with no compatibility alias.
7. Split immutable `run.json` from mutable, authoritative `run-state.json`.
8. Store research runs under project-root `.research/<slug>[-N]/`.
9. Add `/.research/` idempotently to `.git/info/exclude`; never modify tracked `.gitignore`.
10. Retain generic safety CLI overrides while keeping research-specific caps configuration-only.
11. Use a policy middleware over a generic subagent façade.
12. Make subagent provider selection first-class; tmux is the bundled adapter.
13. Retain every successfully initialized run and derive history by scanning run manifests.
14. Do not cache complete subagent outputs.
15. Defer project-wide `web_lookup` and `fetch_web` response caching to the next spec.
16. Keep automated integration model-free; make the live local-model test opt-in.

## 4. Architecture and ownership

There is one loop runtime and at most one active loop per Pi session.

### 4.1 Generic loop runtime

`extensions/loop/index.ts` becomes a thin registration entrypoint. Focused internal modules own:

- command parsing and status commands;
- persisted generic loop state;
- immutable program snapshots;
- iteration scheduling and continuation delivery;
- coordinator and nested usage accounting;
- iteration, token, and no-progress limits;
- generic completion-policy hooks.

The loop engine knows nothing about search phases, research roles, score tables, source thresholds, or verification files.

### 4.2 Research preset

Research helpers live under `extensions/research/`, but they are imported by the loop entrypoint rather than loaded as another stateful extension. They own:

- research configuration resolution;
- workspace allocation and run manifests;
- authoritative research state;
- the active `ResearchPolicy`;
- checkpoint evaluation;
- research completion gates;
- verification registry and validators;
- research history discovery.

`/research` constructs a `ResearchPreset` over the same `LoopEngine` used by `/loop`.

### 4.3 Subagent façade and providers

A provider-neutral subagent-dispatch extension registers the stable `run_subagents` tool. It selects a versioned `SubagentProvider` through Pi's shared `pi.events` bus.

The current tmux implementation becomes the bundled `tmux-subagent` provider adapter. A future backend can replace it by implementing the same provider contract; no loop, research-policy, or program changes are required.

The event bus carries provider registrations, policy discovery envelopes, and awaited callbacks. It is not state storage. No mutable module import is used for cross-extension communication.

### 4.4 Module boundaries

```text
config/
  research.json
  subagent-dispatch.json
extensions/
  loop/
    index.ts
    command.ts
    engine.ts
    program.ts
    state.ts
    completion.ts
  research/
    config.ts
    workspace.ts
    manifest.ts
    state.ts
    policy.ts
    checkpoint.ts
    verification.ts
    history.ts
  subagent-dispatch/
    index.ts
    contract.ts
    registry.ts
  tmux-subagent/
    index.ts                 # provider registration
    provider.ts              # execution adapter
    config.ts
    runner.mjs
    tmux.ts
    render.ts
skills/
  research/
    SKILL.md
    program.md
    agents/
```

## 5. Configuration

### 5.1 Locations and precedence

Research configuration resolves from:

1. packaged `config/research.json`;
2. optional `$PI_AGENT_DIR/research/config.json`;
3. permitted per-run CLI safety overrides.

Research does not import values from `config/tmux-subagent.json`, `config/web-search.json`, ambient model aliases, or another extension's defaults.

The packaged layer must be complete. The user layer is a strict partial document. Each layer rejects unknown fields before merging; the final merged document is fully validated.

Named objects merge recursively by field. Arrays replace atomically. `null` is accepted only by fields explicitly declared nullable, including profile `maxRounds`. Paths are resolved relative to the layer that supplied each path before layers merge, so a partial user override cannot accidentally change ownership of a packaged prompt path.

Generic `run_subagents` provider selection resolves separately from packaged `config/subagent-dispatch.json` and optional `$PI_AGENT_DIR/subagent-dispatch/config.json`. That configuration selects only the generic default provider and protocol-wide safety ceiling. Provider-specific generic profiles remain in the selected provider's configuration, including `config/tmux-subagent.json` for tmux. An active research manifest overrides the generic provider selection and imports no provider-specific defaults.

### 5.2 Configuration ownership

One research configuration owns:

- schema version;
- default program, profile, and subagent provider;
- finite default loop iterations;
- default token and no-progress limits;
- minimum and integer-or-null maximum research rounds;
- source and score thresholds;
- total dispatch and concurrency limits per role;
- complete role definitions, including assembler;
- concrete canonical `provider/model-id` values;
- thinking levels, tools, access levels, and timeouts;
- retry policy and per-attempt lookup/fetch budgets;
- result retention and structured-output contracts;
- verification matrix and artifact definitions;
- packaged capability names;
- explicit user/provider child-extension paths.

The configuration contains no API keys or resolved credentials.

### 5.3 Hybrid capability resolution

Package-owned capability names map through a small code-owned registry to bundled extension paths and required tool access. User-specific or provider-specific extensions must be listed explicitly, with relative paths resolved against the owning configuration file.

At run startup, every path must be readable, every concrete model must resolve, and the selected subagent provider must advertise all required capabilities and sufficient hard limits. Failure prevents the run from starting.

### 5.4 CLI

The clean command surface is:

```text
/loop --program <path> --max-iterations N|unlimited --tokens N --no-progress N|off <mission>
/research --program <path> --profile <name> --max-iterations N|unlimited --tokens N --no-progress N|off [--yes] <mission>
```

Flags are optional. Numeric values are positive integers; `unlimited` is valid only for `--max-iterations`, and `off` is valid only for `--no-progress`. Omitted research safety flags use frozen research-configuration defaults; generic `/loop` uses its own packaged defaults. Research-specific round, dispatch, retry, lookup, fetch, and verification settings are configuration-only. `--yes` affects interactive confirmation only and is not an operational override.

## 6. Workspace, run identity, and history

### 6.1 Workspace allocation

An approved research run is allocated beneath the current project:

```text
.research/<mission-slug>/
.research/<mission-slug>-2/
.research/<mission-slug>-3/
```

Allocation uses exclusive directory creation, so concurrent starts cannot overwrite one another. Existing workspaces are never reused or deleted.

In a Git repository, `/research` resolves the repository-local exclude file through Git and adds `/.research/` idempotently. It never edits tracked `.gitignore`. Non-Git projects simply use the directory.

The shared future cache path `.research/cache/web/` is excluded from run discovery.

### 6.2 Run layout

```text
.research/<slug>/
  run.json
  run-state.json
  program.snapshot.md
  prompts/
    <role>.md
  score.md
  notes.md
  report.org
  scout-outputs/
  fragments/
  verification/
```

`run.json`, `program.snapshot.md`, and prompt snapshots are created exclusively and made read-only. Read-only permissions are defense in depth; integrity is enforced through SHA-256 verification.

### 6.3 Immutable `run.json`

`run.json` records:

- schema version and immutable run ID;
- creation timestamp, mission, project root, workspace, and selected profile;
- fully resolved research configuration with secrets omitted;
- effective CLI safety overrides;
- program source and snapshot paths plus SHA-256 digest;
- role prompt source and snapshot paths plus SHA-256 digests;
- concrete model identifiers;
- selected provider ID, adapter contract version, protocol/execution-spec versions, and capabilities;
- effective iteration, token, no-progress, round, dispatch, retry, lookup, and fetch limits;
- verification registry and artifact contracts.

It contains no changing counters, statuses, or outcome fields.

### 6.4 Mutable `run-state.json`

`run-state.json` is authoritative for research-specific mutable state. It is revisioned and updated using temp-file creation, flush, and atomic rename. It records:

- lifecycle status, reason, and timestamps;
- loop iteration and research-round counters;
- coordinator, nested, and total token usage;
- per-role reserved, running, completed, failed, interrupted, and retried attempt counts;
- checkpoint verdict and evidence digest;
- current report and verification digests;
- final outcome metadata.

Pi session entries retain generic loop state plus the research workspace path, run ID, and manifest digest. Resume reloads and validates `run-state.json`; the session does not mirror research counters as a competing source of truth.

### 6.5 History behavior

Every run whose final manifest was created remains inspectable. Declined, invalid, or staging-only starts create no history entry. Clearing or replacing a run marks it `abandoned` or `replaced` and detaches it from the active session without deleting files.

Commands include:

- `/research list` — scan valid run directories and summarize lifecycle state;
- `/research status` — show the active run;
- `/research status <slug>` — inspect a retained run.

History scanning tolerates malformed or partially deleted workspaces and reports them as unreadable entries instead of failing the entire listing.

## 7. Program immutability and loop lifecycle

### 7.1 Program snapshots

`/loop` and `/research` snapshot the selected program before iteration 1.

A generic loop stores one immutable program-snapshot entry in the Pi session and references its digest from later state entries. A research run additionally writes `program.snapshot.md` and prompt snapshots into its workspace.

The full program is injected on iteration 1 and after compaction. Other continuations reference the immutable snapshot and digest together with current mission and limit state. The engine never rereads the source program during an active run.

Source program, prompt, configuration, and provider changes affect only later runs.

### 7.2 Startup preparation and activation

Starting `/research` validates and prepares the new run before replacing anything:

1. Parse CLI.
2. Resolve configuration, program, profile, provider, models, and capabilities.
3. Validate every effective value and path.
4. Display the resolved contract and request confirmation when UI is available.
5. Build and verify the complete run in a hidden staging directory beneath `.research/`.
6. Rename the staging directory to the exclusively allocated final slug.
7. Append a replacement-transition entry, mark the previous run `replaced`, install the new loop pointer, and activate iteration 1.

Steps 6–7 share a transition ID and are idempotent on restore. Recovery finishes or rolls back an interrupted transition before any continuation can run, so two workspaces are never driven concurrently. An ordinary validation or preparation failure removes staging data and leaves the previous run unchanged. If a crash occurs after the final manifest exists, history retains the new run and recovery gives it an explicit terminal or resumable state rather than deleting it.

### 7.3 Iterations and continuations

A loop iteration is one program-driven agent turn, including the initial turn. The count is persisted at turn start, so a crash cannot replay an uncounted iteration. Planning, evidence collection, consolidation, synthesis, verification, and repair can each consume iterations.

The engine queues the next continuation only at `agent_settled`, after provider retries and compaction retries are finished. It verifies the manifest and snapshot digests before every research iteration.

Packaged defaults are finite. `--max-iterations unlimited` is the only unlimited opt-in. Reaching an iteration or token limit before valid completion records `budget_limited` and preserves all artifacts.

### 7.4 Restore behavior

Reloading or restoring an active run pauses it rather than continuing silently. `/research resume` reacquires the workspace lease and validates:

- manifest and snapshot integrity;
- mutable state schema and run ID;
- the exact selected provider ID and adapter contract version;
- compatible provider protocol/execution-spec versions and all frozen capabilities;
- concrete model and child-extension availability;
- absence of another active owner.

Interrupted in-flight attempts retain their consumed dispatch count and become `interrupted`; concurrency slots are released.

### 7.5 Lifecycle states

Research states are:

- `active`;
- `paused`;
- `no_progress`;
- `budget_limited`;
- `complete`;
- `failed`;
- `integrity_error`;
- `abandoned`;
- `replaced`.

Every transition records a structured reason and timestamp.

## 8. Replaceable subagent provider

### 8.1 Stable façade

`run_subagents` is the stable public tool. It is registered once by the provider-neutral façade, not by the tmux adapter.

For generic calls, the façade selects the provider from `config/subagent-dispatch.json` plus its optional user override. During an active research run, `ResearchPolicy` forces the provider frozen in `run.json`. Research provider selection never inherits tmux configuration.

### 8.2 `SubagentProvider` contract

A versioned provider advertises:

- one unique provider ID;
- its adapter contract version;
- supported provider-protocol and execution-spec versions;
- batching, cancellation, retry, artifact-export, summary, and usage capabilities;
- hard task and concurrency ceilings;
- a callback that executes fully resolved dispatch plans.

The façade discovers providers through a load-order-independent `pi.events` collection envelope. Missing, duplicate, incompatible, or insufficient selected providers fail closed.

The initial implementation includes the tmux adapter and an in-memory fake used for contract tests. No second production backend is part of this refactor.

### 8.3 Research policy middleware

Before execution, the façade discovers at most one active dispatch policy. `ResearchPolicy` claims calls only while a research loop is active. It:

1. permits only roles in the frozen manifest;
2. resolves each logical role to an explicit execution specification;
3. rejects or replaces caller-supplied operational overrides;
4. forces configured summary, retention, timeout, retry, lookup, and fetch settings;
5. injects run ID, manifest path, workspace, mission, role contract, and required digests;
6. canonicalizes and confines every result path beneath the workspace;
7. verifies requested batch size against profile limits and provider capabilities.

Outside an active research run, the selected provider continues to resolve and execute its ordinary generic profiles using its own generic configuration.

### 8.4 Attempt accounting and retries

Before every physical launch, including a retry, the provider requests an atomic reservation from `ResearchPolicy`. Profile limits distinguish:

- total dispatch attempts per role;
- concurrent attempts per role;
- provider-wide concurrent attempts.

A retry consumes another dispatch attempt. Exhausted limits prevent launch. Parallel tool calls serialize reservations against the run-state revision, so they cannot race past a cap.

After every attempt, the provider reports status, timestamps, nested usage, and artifact metadata. The policy releases concurrency, persists the result, and retains consumed attempt counts even for cancellation or interruption.

The façade returns aggregate nested usage through Pi's standard tool-result `usage` field. Generic loop accounting adds coordinator usage from assistant turns and nested usage from tool results without double-counting.

### 8.5 Artifact export

Research outputs use structured summary mode. Artifact payloads are validated against the frozen role contract and exported atomically. Result paths must remain within the canonical workspace, including when the final file does not yet exist; symlinked parent escapes are rejected.

Immutable manifest and snapshot files are never valid result targets.

## 9. Research rounds and authoritative checkpoints

### 9.1 Separate counters

A loop iteration is a generic program execution. A research round is one completed evidence-gathering cycle acknowledged by a valid checkpoint. Planning, synthesis, verification, and report repair do not increment research rounds.

Each profile has `minRounds` and `maxRounds: integer | null`. A null maximum disables only the research-round cap; iteration, token, no-progress, dispatch, and provider limits remain active.

### 9.2 Checkpoint interface

`research_checkpoint` accepts no caller-supplied profile, round, or source count. It derives all inputs from the active run and workspace.

`score.md` contains one Markdown table with exact columns `ID | Question | Score | Notes`. IDs must be unique, scores must be integers from 0 through 100, and the row count must satisfy the configured structural range (packaged default: 5–8).

`notes.md` contains a `## Source Ledger` Markdown table with exact columns `URL | Title | Tier | Retrieved | Claims`. Only valid rows in that table count toward the source floor; URLs elsewhere in the file do not. A ledger with no data rows is valid and counts as zero sources.

On the first valid call in a loop iteration, the checkpoint:

1. verifies run identity and mutable state;
2. reads and validates regular-file `score.md` and `notes.md`;
3. parses both required tables;
4. extracts and canonicalizes unique HTTP(S) URLs from the source ledger;
5. increments the research-round count once;
6. computes a SHA-256 digest over the exact `score.md` and `notes.md` bytes;
7. evaluates minimum rounds, source floor, score threshold, and optional maximum;
8. persists and returns `CONTINUE`, `PROCEED`, or `PROCEED_WITH_GAPS` with explicit unmet criteria.

A repeated checkpoint in the same loop iteration returns the recorded result without another increment. Missing, unreadable, or malformed evidence fails closed and does not increment the round.

For comparison, source canonicalization lowercases scheme and host, removes default ports and fragments, deletes `utm_*`, `fbclid`, `gclid`, `dclid`, and `msclkid` parameters, and sorts remaining query parameters. The original URL remains unchanged in `notes.md`.

### 9.3 Evidence validity

A successful checkpoint remains valid during later synthesis, verification, and report repair iterations. Completion recomputes the evidence digest. Any change to `score.md` or `notes.md` makes the checkpoint stale and requires a valid checkpoint in a later loop iteration.

A finite maximum can return `PROCEED_WITH_GAPS` when gaps remain at the cap. A null maximum never forces that verdict.

## 10. Completion and verification

`complete_loop` delegates to a generic completion-policy interface. Generic `/loop` retains its program-defined completion audit. Research completion additionally requires:

1. intact manifest, program snapshot, and prompt snapshots;
2. a current checkpoint for the active run;
3. checkpoint verdict `PROCEED` or `PROCEED_WITH_GAPS`;
4. matching current evidence digest;
5. non-empty, structurally valid `report.org`;
6. every profile-required verification artifact;
7. strict artifact schema and validator pass conditions;
8. artifact run ID, manifest digest, evidence digest, and report digest matching current values.

The verification registry contains one definition per verification kind. Each definition unifies:

- logical role;
- output filename;
- schema version;
- validator ID;
- pass predicate;
- profiles requiring it.

Verification agents receive current run identity and digests through policy injection. Editing `report.org` invalidates report-bound verification artifacts. Editing evidence invalidates both checkpoint and verification artifacts.

A failed completion attempt returns precise gate failures and leaves the run active. Success atomically records final outcome and digests in `run-state.json`; `run.json` remains immutable.

## 11. Program and role contracts

The canonical methodology is `skills/research/program.md`. `skills/research/SKILL.md` contains usage guidance and links to the program and configuration. Obsolete versioned programs leave the active skill directory; Git history is the archive.

The program contains no literal model identifiers, profile thresholds, budgets, timeouts, provider names, or dispatch caps. It receives a compact resolved-run contract and uses durable files to select one next methodological action per loop iteration. One action may be one bounded parallel batch, but it may not span multiple research phases.

The program owns this methodology:

1. plan sub-questions and initialize scores;
2. search broadly and narrow weak areas;
3. deep-read high-value sources;
4. consolidate evidence and update scores;
5. checkpoint after a completed evidence cycle;
6. write Org fragments and assemble the report;
7. run the configured verification matrix;
8. repair evidence, report, or verification failures;
9. reverify changed reports and attempt completion.

Role boundaries are:

- scouts and fetchers export immutable reports under `scout-outputs/`;
- one serialized consolidator updates `notes.md` and `score.md`;
- fragment writers export Org fragments;
- a dedicated assembler exports `report.org` atomically;
- verification roles export strict JSON under `verification/`.

The program reads `run-state.json` and existing artifacts before dispatching to avoid repeating completed work. It uses logical role names only.

Fetched content is always data, never instruction. Contradictions remain explicit, primary sources are preferred, and report claims require traceable Org links.

## 12. Failure handling and safety

### 12.1 Startup failures

Research configuration is loaded when a run starts. Invalid research configuration or missing capabilities prevents `/research` from starting with a precise source-layer error. Generic `/loop` remains available.

### 12.2 Runtime failures

- Manifest or snapshot mutation pauses the run as `integrity_error`.
- Provider failures retry according to the frozen policy.
- Exhausted retries or role budgets return structured failures for the program to handle.
- Iteration or token exhaustion records `budget_limited`.
- Malformed checkpoint or verification files fail their gate without mutating valid evidence state.
- Unrecoverable mutable-state corruption records `failed` where possible and never reconstructs guessed values.

A workspace lease prevents two Pi sessions from driving one run. Clean pause/shutdown releases it; stale leases are handled explicitly during resume.

### 12.3 Filesystem and secret safety

All contract and evidence inputs must be regular files. Workspace and artifact paths are checked against the canonical real workspace root. Symlink escapes and attempts to overwrite immutable files are rejected.

`run.json` omits credentials, API keys, and resolved auth headers. Children receive only the tools and settings declared by their role.

## 13. Testing strategy

Implementation is characterization-first and test-first.

### 13.1 Unit tests

Cover:

- strict layered configuration, recursive object merge, atomic arrays, nullable fields, and path provenance;
- finite and explicit-unlimited iteration parsing;
- workspace collision allocation and Git exclusion;
- manifest creation, read-only snapshots, digest checks, leases, and atomic state revisions;
- separate iteration and research-round accounting;
- source canonicalization, score parsing, and evidence staleness;
- verification registry schemas and pass predicates;
- path confinement and symlink attacks;
- history scanning and malformed entries.

### 13.2 Provider contract tests

The in-memory fake provider and tmux adapter run through the same contract suite:

- discovery, selection, and capability negotiation;
- explicit execution specifications;
- per-attempt reservation, retries, concurrency, cancellation, and interruption;
- nested usage reporting;
- summary and atomic artifact export;
- ResearchPolicy enforcement;
- unchanged generic behavior without a research policy.

### 13.3 Integration tests

Deterministic integration tests use the fake provider and no model. They cover:

- startup and frozen snapshots;
- planning through evidence collection;
- repeated checkpoint calls within one iteration;
- synthesis across later iterations without checkpoint loss;
- stale evidence and stale report verification;
- successful completion and every rejection gate;
- iteration, token, dispatch, and no-progress limits;
- reload, pause, resume, interrupted attempts, and provider mismatch;
- replacement, abandonment, and retained history.

A separate opt-in live end-to-end test uses only an explicitly configured local model. It strips cloud-model credentials, never falls back to a remote model, and reports a clear skip when the local runtime is unavailable.

Final verification includes focused tests, the full Vitest suite, LSP/lens diagnostics, independent review, and the opt-in local-model smoke test when available.

## 14. Migration and documentation

This is a clean break:

- remove packaged `config/deep-research.json`;
- ignore the old user override path;
- remove `extensions/deep-research/session.ts` and all module-global budget communication;
- move active helper and skill resources to the `research` namespace;
- remove obsolete `program.v1.md` from the active package;
- do not resume legacy research state under the new engine;
- do not import old `/tmp` workspaces into `.research/`.

A legacy research restore reports that the run cannot be resumed and preserves the old session data. Generic loop behavior remains supported.

`docs/006-deep-research-spec.md` is rewritten or superseded by an authoritative feature document matching the implementation. Older contradictory research documents are explicitly marked superseded.

## 15. Acceptance criteria

The refactor is accepted when:

- `/loop` remains generic and executes any immutable program;
- `/research` is implemented only as a preset and policy over the generic loop;
- finite and explicit-unlimited iteration modes work;
- generic iterations and completed research rounds are separately persisted;
- every approved research run is retained beneath `.research/`;
- one self-contained configuration owns every research parameter;
- research silently inherits no tmux, web-search, or model-alias defaults;
- invalid configuration or missing capability prevents startup clearly;
- `run.json`, program, and prompts remain frozen for the run;
- `run-state.json` is the only authoritative mutable research store;
- `run_subagents` selects a first-class provider through a stable contract;
- tmux and the fake provider pass the same contract tests;
- dispatch, retry, concurrency, result-path, lookup, fetch, iteration, token, and no-progress limits are enforced;
- every physical attempt and nested usage contribution is persisted;
- checkpoint decisions use active state plus parsed workspace evidence;
- checkpoint evidence remains valid until evidence bytes change;
- report changes invalidate report-bound verification;
- every verifier receives and returns current run identity and digests;
- completion rejects stale, missing, malformed, or failing evidence precisely;
- generic `/loop` and generic `run_subagents` behavior remains available outside research;
- automated tests require no model and the live test uses only a local model;
- no benchmark framework or web-result cache implementation is added.
