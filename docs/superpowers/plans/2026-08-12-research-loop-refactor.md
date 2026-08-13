# Research Loop Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `/loop` into a generic repetition engine and rebuild `/research` as a preset and policy over it, with provider-neutral subagent dispatch and durable, authoritative research state.

**Architecture:** One loop runtime with a thin registration entrypoint and focused internal modules. Research helpers live under `extensions/research/` as plain modules imported by the loop entrypoint — never a second stateful extension. Subagent dispatch is a stable façade that discovers versioned `SubagentProvider`s over `pi.events`; `ResearchPolicy` middleware enforces the frozen manifest during an active run.

**Tech Stack:** Pi extensions (TypeScript, jiti-loaded), Vitest, existing typebox conventions, existing tmux runner (`runner.mjs`). No new dependencies. No model required by automated tests.

## Global Constraints

- Run workspace: project-root `.research/<mission-slug>[-N]/`; allocation uses an exclusively created hidden claim directory followed by a same-parent staging rename; never reuse or delete existing workspaces.
- `.research/cache/web/` is reserved for a future web cache and must be excluded from run discovery.
- In a Git repo, add `/.research/` idempotently to `.git/info/exclude`; never modify tracked `.gitignore`. Non-Git projects just use the directory.
- Configuration namespace is `research` — no compatibility alias; old `deep-research` config paths are ignored, not migrated.
- `run.json`, `program.snapshot.md`, and `prompts/<role>.md` are immutable (read-only + SHA-256 verified). `run-state.json` is the only authoritative mutable store, revisioned via temp-file + flush + atomic rename.
- `run.json` contains no counters, statuses, or outcomes; no credentials/API keys anywhere in config or manifests.
- Only `--max-iterations unlimited` enables unlimited iterations; packaged defaults are finite. `--no-progress off` is the only off value for that flag. Research round/dispatch/retry/lookup/fetch/verification settings are configuration-only (no CLI).
- The stable tool name is `run_subagents`, registered once by the façade (never by the tmux adapter). Reserved Anthropic server-tool names (`web_search`, `computer`, `bash`, `text_editor`, `code_execution`) must not be reused.
- Packaged config layers must be complete and reject unknown fields; the user layer is a strict partial document; arrays replace atomically; `null` only in nullable fields (incl. profile `maxRounds`); paths resolve against the layer that supplied them.
- score.md table: exact columns `ID | Question | Score | Notes`; unique IDs; integer scores 0–100; row count in configured structural range (default 5–8). notes.md: `## Source Ledger` table with exact columns `URL | Title | Tier | Retrieved | Claims`; only valid rows count toward the source floor.
- URL canonicalization: lowercase scheme+host, drop default ports and fragments, delete `utm_*`, `fbclid`, `gclid`, `dclid`, `msclkid`, sort remaining query params; `notes.md` bytes stay untouched.
- No complete subagent outputs are cached; no benchmark framework; no web-result cache implementation.
- ES-module/TS conventions as today; every change keeps `npx vitest run` green.

---

### Task 1: Research configuration module

**Files:**

- Create: `config/research.json`
- Create: `extensions/research/config.ts`
- Test: `tests/research-config.test.ts`

**Interfaces:**

```ts
export interface ConfigLayer {
  path: string;
  kind: "packaged" | "user" | "cli";
  value: unknown;
}

export function resolveResearchConfig(layers: ConfigLayer[]): ResolvedResearchConfig;
export function resolveCapability(name: string): PackagedCapability;
export function validateResearchConfig(config: ResolvedResearchConfig): void;
```

- `resolveResearchConfig` performs only pure layered configuration work: strict per-layer validation, recursive object merge, atomic array replacement, provenance-aware path resolution, and final schema validation. It does not inspect Pi's model registry or discover subagent providers.
- The resolved schema covers the default program, profile, and provider; finite default iterations; token/no-progress limits; nullable profile `maxRounds`; source/score thresholds; per-role total/concurrent dispatch; retry and per-attempt web budgets; complete role definitions including assembler; retention and structured-output contracts; verification/artifact definitions; packaged capability names; and explicit child-extension paths.
- `resolveCapability` maps package-owned names to bundled paths and required tool access. User/provider extensions are accepted only as explicit paths.
- Runtime model/provider/capability negotiation is deliberately deferred to Task 9, after the provider registry exists.
- Consumes: nothing new; uses the existing `$PI_AGENT_DIR` convention.

- [ ] **Step 1: Write failing tests** covering layer precedence, unknown-field rejection, recursive object merge, atomic array replacement, nullable-field enforcement, path provenance, capability resolution, explicit child paths, unreadable paths, and credential-field rejection. Tests call only the pure interfaces above.
- [ ] **Step 2: Run `npx vitest run tests/research-config.test.ts`** — expect FAIL with `Cannot find module '../extensions/research/config.ts'`.
- [ ] **Step 3: Implement `extensions/research/config.ts`** with strict schemas, merge semantics, provenance-aware path resolution, and complete final validation. Do not import Pi runtime or provider-registry state.
- [ ] **Step 4: Author `config/research.json`** as a complete standalone layer with finite packaged defaults and integer packaged `maxRounds`.
- [ ] **Step 5: Run `npx vitest run tests/research-config.test.ts`** — expect PASS.
- [ ] **Step 6: Commit** — `feat: strict layered research configuration`.

---

### Task 2: Generic loop engine split

**Files:**

- Create: `extensions/loop/command.ts`, `extensions/loop/engine.ts`, `extensions/loop/program.ts`, `extensions/loop/state.ts`, `extensions/loop/completion.ts`
- Modify: `extensions/loop/index.ts` (becomes thin registration entrypoint)
- Test: rework `tests/loop-checkpoint.test.ts`, `tests/loop-program-block.test.ts`, `tests/loop-research.test.ts`; create `tests/loop-command.test.ts`, `tests/loop-engine.test.ts`, `tests/loop-state.test.ts`, `tests/loop-completion.test.ts`

**Interfaces:**

```ts
export interface LoopUsage { coordinator: number; nested: number; total: number }
export interface CompletionFailure { code: string; message: string }
export interface CompletionPolicy {
  audit(state: Readonly<LoopState>): Promise<CompletionFailure[]>;
}
export interface LoopEngineOptions {
  completionPolicy: CompletionPolicy;
  onStateChange(state: LoopState): Promise<void>;
}
export function addCoordinatorUsage(state: LoopState, usage: unknown): LoopState;
export function addNestedUsage(state: LoopState, usage: unknown): LoopState;
```

- `parseLoopArgs(argv)` returns `{program?, maxIterations: number|'unlimited', maxTokens: number, noProgress: number|'off', mission}`; numeric flags are positive integers; `unlimited` and `off` are accepted only by their documented flags.
- `snapshotProgram(source)` returns an immutable in-session snapshot entry plus SHA-256 digest. Iteration 1 and post-compaction recovery receive the full snapshot; ordinary continuations reference its digest. The source is never reread during a run.
- `LoopEngine` persists the iteration count at turn start and queues continuation only from `agent_settled`. Reaching iteration/token/no-progress limits records `budget_limited` and preserves artifacts.
- Coordinator usage is added only from assistant-turn usage. Nested usage is added only from finalized `run_subagents` tool-result `usage`. `total = coordinator + nested`; replaying/restoring a persisted result must not add it again, so processed tool-call IDs are persisted in generic loop state.
- Generic `/loop` installs a program-defined `CompletionPolicy`; an empty failure list permits completion. Research supplies a different implementation in Task 11.
- Consumes: existing loop behavior in `extensions/loop/index.ts` and `sources.ts` (fold source-independent program helpers into `program.ts`).

- [ ] **Step 1: Add characterization tests** for current iteration counting, checkpoint persistence, continuation timing, generic completion, and reload behavior.
- [ ] **Step 2: Write failing command/program tests** for strict flags, explicit unlimited/off values, snapshot immutability, and reinjection after compaction.
- [ ] **Step 3: Write failing engine/state tests** for persistence at turn start, `agent_settled` scheduling, coordinator-only usage, nested-only usage, parallel tool results, retry results, restore/replay deduplication, and total calculation.
- [ ] **Step 4: Write failing completion tests** using a fake async policy that returns typed failures; verify generic `/loop` has no research checkpoint or verification gates.
- [ ] **Step 5: Split and implement the modules**, keeping research roles, tables, thresholds, and verification entirely outside the generic engine.
- [ ] **Step 6: Run `npx vitest run tests/loop-*.test.ts` and then `npx vitest run`** — expect PASS.
- [ ] **Step 7: Commit** — `refactor: split loop engine into focused modules`.

---

### Task 3: Workspace, run identity, and run-state

**Files:**

- Create: `extensions/research/workspace.ts`, `extensions/research/manifest.ts`, `extensions/research/state.ts`
- Test: `tests/research-workspace.test.ts`, `tests/research-manifest-state.test.ts`

**Interfaces:**

```ts
export interface StateConflict { expected: number; actual: number }
export interface WorkspaceClaim { finalDir: string; claimPath: string; transitionId: string }
export async function acquireWorkspaceClaim(
  projectRoot: string,
  mission: string,
  transitionId: string,
 ): Promise<WorkspaceClaim>;
export async function updateRunState(
  ws: Workspace,
  expectedRevision: number,
  mutate: (current: Readonly<RunState>) => RunState,
 ): Promise<RunState>;
export async function prepareStaging(claim: WorkspaceClaim): Promise<StagedRun>;
export async function commitStaging(staged: StagedRun, claim: WorkspaceClaim): Promise<Workspace>;
```

- `acquireWorkspaceClaim` selects `<slug>`, then `-2`, `-3`, by exclusively creating a hidden same-parent claim directory such as `.claim-<slug>-<transitionId>` with non-recursive `mkdir`. The claim reserves a final path without creating that path. Staging is built for the claimed final path; `commitStaging` verifies the target remains absent, performs the same-parent rename, then removes the claim. A collision or stale target releases/quarantines the claim and retries the next suffix. Recovery reconciles claim, staging, and final paths by transition ID. Run discovery ignores hidden claim/staging directories.
- `ensureGitExclude(projectRoot)` idempotently adds `/.research/` through the Git-resolved repository root and is a no-op outside Git.
- `createRunManifest` exclusively creates immutable `run.json` and snapshots. Manifest paths always name the eventual final workspace, never the hidden staging path.
- `newRunState` and `readRunState` expose revisioned mutable state. All writes use `updateRunState`: callers supply the expected revision; a per-workspace serialized queue plus revision comparison prevents lost updates; stale revisions return a typed conflict and are retried by the caller from a fresh read. Temp-file creation, file flush, directory flush where supported, and atomic rename prevent torn writes.
- `acquireLease`/`releaseLease` enforce one driving session. Stale leases are handled explicitly during resume.
- Transition recovery uses the transition ID to finish or roll back an interrupted staging/final activation before any continuation runs.
- Consumes: Task 1 configuration and Task 2 generic state conventions.

- [ ] **Step 1: Write failing workspace tests** for exclusive claims, suffix allocation, two concurrent starts, stale claims, target appearance before rename, final-path manifest values, hidden-entry discovery exclusion, Git exclusion, staging rollback, and transition recovery in both directions.
- [ ] **Step 2: Write failing state tests** for revision increments, stale-revision rejection, two concurrent reservations with no lost update, checkpoint-versus-usage contention, completion-versus-usage contention, atomic replacement, and lease contention.
- [ ] **Step 3: Implement `workspace.ts`, `manifest.ts`, and `state.ts`**; snapshot program and role prompts under the claimed final path contract, verify staging, commit by rename, and clean up the claim.
- [ ] **Step 4: Run `npx vitest run tests/research-workspace.test.ts tests/research-manifest-state.test.ts`** — expect PASS.
- [ ] **Step 5: Commit** — `feat: research workspace, manifest, and transactional state`.

---

### Task 4: Subagent dispatch façade

**Files:**

- Create: `config/subagent-dispatch.json`, `extensions/subagent-dispatch/contract.ts`, `extensions/subagent-dispatch/registry.ts`, `extensions/subagent-dispatch/index.ts`
- Test: `tests/subagent-contract.test.ts`

**Interfaces:**

```ts
export type AttemptOutcome =
  | { status: "completed"; result: AttemptResult }
  | { status: "failed" | "cancelled" | "interrupted"; error: SerializedError };

export interface SubagentProvider {
  readonly descriptor: ProviderDescriptor;
  executeAttempt(plan: ResolvedAttempt, signal: AbortSignal): Promise<AttemptResult>;
}
export interface DispatchPolicy {
  claim(context: DispatchContext): Promise<boolean>;
  resolve(plan: RequestedPlan): Promise<ResolvedDispatch>;
  reserveAttempt(attempt: ResolvedAttempt): Promise<AttemptReservation>;
  releaseAttempt(reservation: AttemptReservation, outcome: AttemptOutcome): Promise<void>;
  exportArtifact(reservation: AttemptReservation, result: AttemptResult): Promise<ArtifactMetadata | undefined>;
}
```

- The façade, not a provider, owns batching expansion and retries. For every physical launch—including retries—it calls `reserveAttempt`, invokes exactly one `provider.executeAttempt`, normalizes returns/throws/aborts into `AttemptOutcome`, exports a successful artifact, and calls `releaseAttempt` exactly once in `finally`. A failed reservation prevents launch. Providers must not implement hidden retries.
- `ProviderDescriptor` includes unique ID, adapter version, protocol/execution-spec versions, capability flags, and hard task/concurrency ceilings.
- Provider and active-policy discovery use load-order-independent `pi.events` collection envelopes. Because `EventBus.emit` is synchronous and returns `void`, listeners synchronously append descriptors or promises to the caller-owned envelope; the caller then awaits the collected promises. The bus stores no registry or mutable policy state. Tests cover providers loaded before and after the façade's factory registration.
- Generic calls select from packaged/user `subagent-dispatch` config. Active research policy forces the frozen provider. Missing, duplicate, incompatible, or insufficient providers fail closed.
- `run_subagents` is registered once by the façade and returns aggregate nested usage in Pi's standard tool-result `usage` field.
- `negotiateProvider(registry, selection, requirements)` is the runtime provider-capability validator consumed by Task 9; it does not belong in configuration resolution.

- [ ] **Step 1: Write a shared failing contract suite** covering discovery before/after façade load, duplicates, missing/incompatible providers, one physical launch per `executeAttempt`, façade-owned retries, reservation before every attempt, release on success/error/cancellation/artifact-export failure, no launch after reservation failure, capability negotiation, and usage aggregation.
- [ ] **Step 2: Implement the contract, registry, façade, and an in-memory fake provider.** The fake records every attempted launch so later tests can prove limits cannot be bypassed.
- [ ] **Step 3: Author `config/subagent-dispatch.json`** with only default provider selection and protocol-wide ceilings.
- [ ] **Step 4: Run `npx vitest run tests/subagent-contract.test.ts`** — expect PASS.
- [ ] **Step 5: Commit** — `feat: provider-neutral subagent dispatch façade`.

---

### Task 5: tmux provider adapter

**Files:**

- Modify: `extensions/tmux-subagent/index.ts` (registration only — advertise the provider via `pi.events`; stop registering `run_subagents`)
- Create: `extensions/tmux-subagent/provider.ts`
- Keep: `extensions/tmux-subagent/config.ts`, `runner.mjs`, `tmux.ts`, `render.ts`
- Test: `tests/tmux-provider.test.ts` (runs the same contract suite as the fake provider)

**Interfaces:**

- `TmuxSubagentProvider` implements `executeAttempt` only. It launches one already-resolved attempt through the existing runner, reports status/timestamps/usage/artifact metadata, and performs no policy decisions or hidden retries.
- `extensions/tmux-subagent/index.ts` advertises the descriptor through `pi.events` and no longer registers `run_subagents`. Generic tmux profiles remain in `config/tmux-subagent.json`; research never imports them.
- Consumes: Task 4 contract and shared contract suite.

- [ ] **Step 1: Run the shared Task 4 contract suite against a skeletal tmux adapter** — expect failures for missing descriptor and `executeAttempt`.
- [ ] **Step 2: Implement `provider.ts`** over `runner.mjs`/`tmux.ts`, removing retry ownership and tool registration from the adapter.
- [ ] **Step 3: Run fake and tmux adapters through the same suite**, including the assertion that one adapter invocation equals one physical launch; migrate relevant `tests/subagent-summary.test.ts` assertions.
- [ ] **Step 4: Commit** — `refactor: tmux-subagent as provider adapter`.

---

### Task 6: ResearchPolicy middleware

**Files:**

- Create: `extensions/research/policy.ts`
- Test: `tests/research-policy.test.ts`

**Interfaces:**

- `ResearchPolicy` implements the Task 4 `DispatchPolicy`. `claim` succeeds only for an active research run; `resolve` permits manifest roles only, removes caller operational overrides, forces frozen summary/retention/timeout/retry/web settings, injects run identity and digests, and confines result paths beneath the canonical workspace.
- `reserveAttempt` uses Task 3 `updateRunState` with fresh-read retry on `StateConflict`. Reservations serialize across parallel tool calls and enforce per-role total, per-role concurrent, and provider-wide concurrent limits before the façade launches anything.
- `releaseAttempt` is idempotent by reservation ID, releases concurrency through the same transactional state API, and retains consumed counts for failure, cancellation, and interruption.
- `exportArtifact` validates the frozen role schema, writes atomically, rejects symlink-parent escapes and immutable targets, and returns digest metadata.
- The façade invokes all hooks; providers cannot bypass them because providers receive only one post-reservation `ResolvedAttempt` at a time.

- [ ] **Step 1: Write failing policy tests** for claim scope, role whitelist, forced settings, path confinement/symlink attacks, immutable targets, and artifact schemas.
- [ ] **Step 2: Write failing concurrency tests** with parallel façade calls proving total/concurrent caps, conflict retries, retry accounting, idempotent release, and zero provider launches after reservation rejection.
- [ ] **Step 3: Implement the middleware** on Task 3's transactional state API and Task 4's dispatch lifecycle.
- [ ] **Step 4: Run `npx vitest run tests/research-policy.test.ts tests/subagent-contract.test.ts`** — expect PASS.
- [ ] **Step 5: Commit** — `feat: ResearchPolicy middleware`.

---

### Task 7: Checkpoint and evidence

**Files:**

- Create: `extensions/research/checkpoint.ts`
- Test: `tests/research-checkpoint.test.ts`

**Interfaces:**

- Produces: `evaluateCheckpoint(ws, loopIteration, expectedRevision)` → `{state, verdict: 'CONTINUE'|'PROCEED'|'PROCEED_WITH_GAPS', round, unmet: string[], evidenceDigest}` — accepts no caller-supplied profile/round/source count; all threshold inputs derive from manifest/run-state/workspace, and persistence uses Task 3's conflict-checked transaction.
- Produces: `canonicalizeUrl(u)` per the Global Constraints rules; `parseScoreTable(text)`; `parseLedger(text)`.
- Behavior: on the first valid call in a loop iteration — verify run identity + state, read+validate regular-file `score.md`/`notes.md`, parse both tables, canonicalize unique HTTP(S) ledger URLs, increment the research-round counter once, compute SHA-256 over the exact bytes, evaluate min rounds / source floor / score threshold / optional max, persist and return the verdict with explicit unmet criteria. Repeated calls in the same iteration return the recorded result without incrementing. Missing/unreadable/malformed evidence fails closed and does not increment. `PROCEED_WITH_GAPS` only when gaps remain at a finite maximum; a null maximum never forces it.
- Consumes: Tasks 1, 3 (config thresholds, run-state).

- [ ] **Step 1: Write failing tests** — table parsing (exact columns, unique IDs, 0–100 integer scores, 5–8 row range), ledger row counting (URLs outside the table ignored; empty ledger = 0 sources), canonicalization vectors, one-increment-per-iteration idempotence, stale-revision retry without double increment, fail-closed malformed evidence, verdict combinations, and digest stability.
- [ ] **Step 2: Implement `checkpoint.ts`**.
- [ ] **Step 3: Wire round counting into run-state** (research rounds and loop iterations are separate counters; planning/synthesis/verification/repair never increment rounds).
- [ ] **Step 4: Run tests** — expect PASS.
- [ ] **Step 5: Commit** — `feat: authoritative research checkpoints`.

---

### Task 8: Verification registry

**Files:**

- Create: `extensions/research/verification.ts`
- Test: `tests/research-verification.test.ts`

**Interfaces:**

- Produces: one definition per verification kind — logical role, output filename, schema version, validator ID, pass predicate, profiles requiring it — plus `runVerification(ws)` executing the matrix and returning per-kind results.
- Produces: digest binding — verification agents receive current run ID, manifest digest, evidence digest, and report digest via policy injection; editing `report.org` invalidates report-bound artifacts; editing evidence invalidates both checkpoint and verification artifacts.
- Consumes: Tasks 1 (matrix + artifact contracts), 6 (injection).

- [ ] **Step 1: Write failing tests** — schema validation, pass predicates, per-kind definitions, invalidation matrix (report edit / evidence edit / no-change).
- [ ] **Step 2: Implement the registry + runner**.
- [ ] **Step 3: Run tests** — expect PASS.
- [ ] **Step 4: Commit** — `feat: verification registry`.

---

### Task 9: Research startup and atomic activation

**Files:**

- Create: `extensions/research/startup.ts`
- Modify: `extensions/loop/index.ts` (register `/research` preset beside `/loop`)
- Test: `tests/research-startup.test.ts`

**Interfaces:**

```ts
export async function validateStartupContract(
  config: ResolvedResearchConfig,
  models: ModelRegistryView,
  providers: ProviderRegistryView,
 ): Promise<ResolvedRunContract>;
export async function prepareAndActivateResearch(
  request: ResearchStartRequest,
  deps: StartupDependencies,
 ): Promise<ActiveResearchPointer>;
```

- Startup parses CLI, resolves pure configuration, validates paths, resolves concrete models through an injected Pi model-registry view, negotiates provider capabilities through Task 4, displays the resolved contract, and confirms unless `--yes`.
- It builds and verifies the complete run in hidden staging, commits it with Task 3's collision-safe rename, then transactionally appends the replacement transition, marks the prior run `replaced`, installs the new pointer, claims the research policy, and activates iteration 1.
- Validation, decline, or staging failure removes staging and leaves the previous run untouched. Recovery uses the shared transition ID; a committed manifest is retained with an explicit resumable or terminal state.
- Runtime dependencies are explicit test doubles; configuration code never imports live Pi registries.

- [ ] **Step 1: Write failing negotiation tests** for unresolved models, unavailable child extensions, missing/duplicate/incompatible providers, insufficient hard ceilings, and successful frozen contract construction.
- [ ] **Step 2: Write failing transaction tests** for decline, validation failure, staging failure, collision retry, crash before rename, crash after rename, and idempotent replacement recovery.
- [ ] **Step 3: Implement `startup.ts` and thin `/research` registration**, wiring Task 6 policy and Task 7 checkpoint into the same `LoopEngine`.
- [ ] **Step 4: Run `npx vitest run tests/research-startup.test.ts`** — expect PASS.
- [ ] **Step 5: Commit** — `feat: atomic research startup and activation`.

---

### Task 10: Research lifecycle, history, and resume

**Files:**

- Create: `extensions/research/history.ts`, `extensions/research/lifecycle.ts`
- Modify: `extensions/loop/index.ts` (command routing only)
- Test: `tests/research-history.test.ts`, `tests/research-resume.test.ts`

**Interfaces:**

- Lifecycle states are `active`, `paused`, `no_progress`, `budget_limited`, `complete`, `failed`, `integrity_error`, `abandoned`, and `replaced`; every transition has a structured reason and timestamp.
- `/research list`, `/research status [<slug>]`, `/research pause`, `/research clear`, and `/research resume [<slug>]` operate on retained workspaces. Discovery excludes `.research/cache/web/` and reports malformed workspaces without aborting the listing.
- Reload pauses an active run. Resume reacquires the lease and validates manifest/snapshot integrity, mutable-state schema and run ID, exact provider/adapter compatibility, frozen capabilities, models/extensions, and ownership. In-flight attempts become `interrupted`, keep consumed dispatch counts, and release concurrency transactionally.
- Clearing/replacing marks `abandoned`/`replaced` without deleting artifacts.

- [ ] **Step 1: Write failing history tests** for valid runs, cache exclusion, malformed/partial workspaces, status lookup, abandonment, and replacement.
- [ ] **Step 2: Write failing resume tests** for each integrity/provider/model/lease failure, reload pause, interrupted attempts, transactional slot release, and successful continuation only after validation.
- [ ] **Step 3: Implement `history.ts`, `lifecycle.ts`, and thin command routing**; no startup transaction logic remains in the entrypoint.
- [ ] **Step 4: Run `npx vitest run tests/research-history.test.ts tests/research-resume.test.ts`** — expect PASS.
- [ ] **Step 5: Commit** — `feat: retained research lifecycle and resume`.

---

### Task 11: Completion gates

**Files:**

- Modify: `extensions/loop/completion.ts` (generic `CompletionPolicy` audit)
- Create: `extensions/research/completion.ts` (research completion gate)
- Test: `tests/research-completion.test.ts`

**Interfaces:**

- `complete_loop` awaits the active `CompletionPolicy.audit`; typed failures are returned unchanged and leave the loop active. Generic `/loop` uses `ProgramCompletionPolicy`, which enforces only its immutable program/guard contract and has no research gates.
- `researchCompletionGate(ws)` returns `CompletionFailure[]` and checks intact manifest/snapshots, current checkpoint/verdict/evidence digest, structurally valid non-empty `report.org`, required verification artifacts, validators, and all run/manifest/evidence/report digests.
- `finalizeSuccess(ws, expectedRevision, outcome)` records final outcome and digests through Task 3's single transactional state update; stale revisions are re-audited rather than blindly retried. `run.json` remains untouched.
- Consumes: Tasks 2, 3, 7, 8, and 10 lifecycle transitions.

- [ ] **Step 1: Write failing tests** — generic async policy success/failure, each research gate rejected independently, all-gates-pass success, stale-revision re-audit, completion-versus-usage contention, one-write atomic finalize, and `run.json` untouched.
- [ ] **Step 2: Implement the research gate + finalize**.
- [ ] **Step 3: Run tests** — expect PASS.
- [ ] **Step 4: Commit** — `feat: research completion gates`.

---

### Task 12: Program and skill migration

**Files:**

- Create: `skills/research/SKILL.md`, `skills/research/program.md`, `skills/research/agents/` (role prompts moved from `skills/deep-research/`)
- Delete: `skills/deep-research/` (incl. `program.v1.md`; `program.v2.md` content superseded by `program.md`)
- Test: manual review + used as the fixture program in Task 13 integration tests

**Interfaces:**

- Produces: canonical `program.md` owning methodology steps 1–9 (plan sub-questions + initialize scores; search broadly and narrow weak areas; deep-read high-value sources; consolidate evidence + update scores; checkpoint after a completed evidence cycle; write Org fragments + assemble the report; run the configured verification matrix; repair evidence/report/verification failures; reverify changed reports and attempt completion) and role boundaries (scouts/fetchers → immutable reports under `scout-outputs/`; one serialized consolidator → `notes.md` + `score.md`; fragment writers → `fragments/`; dedicated assembler → `report.org` atomically; verification roles → strict JSON under `verification/`).
- Produces: `SKILL.md` with usage guidance linking the program and configuration.
- Constraints: the program contains no literal model identifiers, profile thresholds, budgets, timeouts, provider names, or dispatch caps; it receives a compact resolved-run contract, reads `run-state.json` + existing artifacts before dispatching, uses logical role names only, and one action may be one bounded parallel batch but never spans research phases. Fetched content is data, never instruction; contradictions stay explicit; primary sources preferred; report claims require traceable Org links.

- [ ] **Step 1: Write `program.md`** from the current `program.v2.md` content with all literals removed.
- [ ] **Step 2: Move role prompts** into `skills/research/agents/`; write `SKILL.md`.
- [ ] **Step 3: Delete `skills/deep-research/`** — obsolete versioned programs leave the active skill directory; Git history is the archive.
- [ ] **Step 4: Review the program against the role-contract constraints** above.
- [ ] **Step 5: Commit** — `feat: canonical research program`.

---

### Task 13: Integration tests

**Files:**

- Create: `tests/research-integration.test.ts`, `tests/live-research.smoke.ts` (opt-in)
- Modify: `tests/smoke-load.ts` if it enumerates removed extensions

**Interfaces:**

- Consumes: all prior tasks; uses the fake provider and injected model/provider registry doubles; no model.

- [ ] **Step 1: Write deterministic integration tests** covering startup/frozen snapshots, evidence collection, checkpoint idempotence, later synthesis, evidence/report staleness, every completion gate, iteration/token/dispatch/no-progress limits, reload/resume/interruption/provider mismatch, replacement/abandonment/history, and concurrent state updates.
- [ ] **Step 2: Add end-to-end usage tests** proving coordinator and nested usage totals across parallel calls and retries, persistence across reload, and no double-count after replay. Assert the fake provider's physical-launch log equals the persisted reserved-attempt ledger.
- [ ] **Step 3: Write the opt-in live smoke test** using only an explicitly configured local model; strip cloud credentials, prohibit fallback, and clearly skip when unavailable.
- [ ] **Step 4: Run `npx vitest run tests/research-integration.test.ts` and then `npx vitest run`** — expect PASS.
- [ ] **Step 5: Run LSP/lens diagnostics over `extensions/`** — expect no blocking findings.
- [ ] **Step 6: Commit** — `test: research integration suite`.

---

### Task 14: Migration, docs, and acceptance

**Files:**

- Delete: `config/deep-research.json`, `extensions/deep-research/` (`session.ts`, `config.ts`, `verification.ts`), `tests/deep-research-config.test.ts`, `tests/deep-research-program.test.ts`, `tests/deep-research-verification.test.ts`
- Rewrite: `docs/006-deep-research-spec.md` → authoritative feature document matching the implementation
- Modify: older contradictory research docs (001, 002, 004, 005, 007) explicitly marked superseded

**Interfaces:**

- Produces: legacy restore behavior — a legacy research restore reports the run cannot be resumed and preserves the old session data; generic `/loop` remains available.
- Produces: no legacy state resume under the new engine; no import of old `/tmp` workspaces into `.research/`; old user-override path ignored.

- [ ] **Step 1: Remove legacy files** and the old module-global budget communication (`extensions/deep-research/session.ts`); confirm nothing imports them.
- [ ] **Step 2: Add a legacy-restore test** — attempting to restore a legacy run returns the explicit cannot-resume message and preserves session data.
- [ ] **Step 3: Write the authoritative feature document**; mark older contradictory research documents superseded.
- [ ] **Step 4: Run the full acceptance checklist from spec §15** (generic `/loop`, preset-only `/research`, finite + unlimited modes, separate counters, retained runs, single config owner, no silent tmux/web-search/model-alias inheritance, startup failure clarity, frozen files, single authoritative mutable store, first-class provider selection, shared contract suite, all limit enforcements, persisted attempts + nested usage, evidence-derived checkpoints, digest-validity rules, precise completion rejection, generic availability outside research, model-free automated tests, no benchmark/web-cache).
- [ ] **Step 5: Final verification** — full Vitest suite, LSP/lens diagnostics, independent review, opt-in local-model smoke test when available.
- [ ] **Step 6: Commit** — `chore: research migration and docs`.
