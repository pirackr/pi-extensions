# Subagent Extension Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the legacy subagent stack with a durable, tmux-window-based `Agent` extension that supports background execution, recovery, notifications, cancellation, nested foreground delegation, and migrated research workflows.

**Architecture:** A generic manager resolves layered profiles, persists every request under a parent-scoped `/tmp` registry, and independently schedules full-window runner processes under a generation-checked manager lease. Standalone runners own Pi RPC, process-group termination, logs, usage, and terminal publication; the parent owns tools, recovery, notification delivery, and TUI/RPC presentation, while research contributes resolved profiles and policy hooks through an owner-neutral discovery contract.

**Tech Stack:** TypeScript, Node.js ESM, Pi Extension API, TypeBox, tmux, Pi JSONL RPC, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-22-subagent-extension-rewrite-design.md`

## Files

- Create: `config/subagent.json` — packaged generic defaults and renamed scheduler/notification settings.
- Create: `extensions/subagent/types.ts` — public requests, durable records, states, profile contributions, policy hooks, and response types.
- Create: `extensions/subagent/identity.ts` — four-character IDs, project slugging, parent identity, and artifact-root resolution.
- Create: `extensions/subagent/storage.ts` — secure artifact layout, atomic JSON/log operations, registry scans, and delivery consumption.
- Create: `extensions/subagent/locks.ts` — exclusive manager leases and short-lived registry locks with safe stale takeover.
- Create: `extensions/subagent/config.ts` — layered configuration, profile parsing, validation, and external profile discovery.
- Create: `extensions/subagent/tmux.ts` — parent-session and detached agent-window operations through argument arrays.
- Create: `extensions/subagent/scheduler.ts` — FIFO admission, ownership-tree concurrency, reconciliation, and queue pumping.
- Create: `extensions/subagent/runner.mjs` — standalone Pi RPC runner, event capture, cancellation, timeout, and terminal publication.
- Create: `extensions/subagent/runner.d.mts` — typed runner exports and injectable test dependencies.
- Create: `extensions/subagent/manager.ts` — enqueue, wait, result retrieval, stop, lifecycle, and observer-mode orchestration.
- Create: `extensions/subagent/notifications.ts` — turn groups, XML previews, origin binding, at-most-once dispatch, and consumption.
- Create: `extensions/subagent/render.ts` — compact/expanded tool rows, widget/footer rows, and notification renderer.
- Create: `extensions/subagent/index.ts` — `Agent`, `get_subagent_result`, `stop_subagent`, `/agents`, events, and mode wiring.
- Create: `extensions/subagent/__tests__/types.test.ts` — state-machine and schema tests.
- Create: `extensions/subagent/__tests__/identity-storage.test.ts` — identity, permissions, safe paths, and atomic publication tests.
- Create: `extensions/subagent/__tests__/locks.test.ts` — acquisition, stale takeover, contention, and generation tests.
- Create: `extensions/subagent/__tests__/config.test.ts` — precedence, trust, profile, access, and discovery tests.
- Create: `extensions/subagent/__tests__/tmux.test.ts` — tmux topology and argument-planning tests.
- Create: `extensions/subagent/__tests__/scheduler.test.ts` — FIFO, concurrency, nested ownership, and reconciliation tests.
- Create: `extensions/subagent/__tests__/runner.test.ts` — RPC, usage, transcript, timeout, cancellation, and publication tests.
- Create: `extensions/subagent/__tests__/manager.test.ts` — public manager behavior, waits, stops, and observer mode tests.
- Create: `extensions/subagent/__tests__/notifications.test.ts` — grouping, escaping, delivery, consumption, and origin tests.
- Create: `extensions/subagent/__tests__/render.test.ts` — compact, expanded, widget, footer, and message-renderer tests.
- Create: `extensions/subagent/__tests__/integration.test.ts` — lifecycle, modes, restart, nesting, and eleven-task integration tests.
- Create: `tests/subagent-load.smoke.ts` — jiti loader and public registration smoke test.
- Create: `tests/live-subagent.smoke.ts` — real-tmux acceptance driver with deterministic fake and real Pi modes.
- Create: `extensions/research/subagent.ts` — research profile provider and durable `ResearchPolicy` adapter.
- Create: `tests/research-subagent.test.ts` — research profile, reservation, settlement, retention, and export tests.
- Create: `tests/subagent-docs.test.ts` — static guards for public names, examples, and removed legacy vocabulary.
- Create: `tests/subagent-cutover.test.ts` — final default-extension and legacy-removal guard.
- Modify: `extensions/research/config.ts` — research-owned model aliases and role-to-profile resolution inputs.
- Modify: `extensions/research/policy.ts` — owner-policy interfaces independent of `subagent-dispatch`.
- Modify: `extensions/research/startup.ts` — profile validation without provider negotiation.
- Modify: `extensions/loop/index.ts` — register research profile integration and remove provider-registry construction.
- Modify: `config/research.json` — research model aliases, new child extension, and capability ownership.
- Modify: `skills/subagent/SKILL.md` — compact `Agent` delegation guidance and retrieval/cancellation behavior.
- Modify: `skills/research/SKILL.md` — foreground `Agent` orchestration and durable-result guidance.
- Modify: `skills/research/program.md` — replace batched `run_subagents` contracts with parallel compact `Agent` calls.
- Modify: `skills/research/agents/fetcher.md` — return complete findings without legacy result-path envelopes.
- Modify: `skills/research/agents/planner.md` — return the research plan through foreground `Agent` output.
- Modify: `skills/research/agents/citation-agent.md` — return claim mappings without legacy result-path envelopes.
- Modify: `skills/research/agents/consolidator.md` — consume coordinator-persisted inputs and return complete consolidation output.
- Modify: `skills/research/agents/contradiction-resolver.md` — return resolutions without legacy result-path envelopes.
- Modify: `skills/research/agents/fragment-writer.md` — return complete fragments through foreground `Agent` output.
- Modify: `skills/research/agents/judge.md` — return the complete judgment through foreground `Agent` output.
- Modify: `skills/research/agents/scout.md` — return complete source findings without legacy result-path envelopes.
- Modify: `skills/research/agents/source-auditor.md` — return the complete audit through foreground `Agent` output.
- Modify: `README.md` — installation, API, configuration, tmux topology, storage, recovery, and migration documentation.
- Modify: `types/pi-coding-agent.d.ts` — current Pi event, message-renderer, TUI, signal, and command context declarations used by the extension.
- Modify: `tests/research-policy.test.ts` — policy characterization through profile-owner hooks.
- Modify: `tests/research-config.test.ts` — research-owned aliases and profile-resolution tests.
- Modify: `tests/research-startup.test.ts` — startup validation without provider negotiation.
- Modify: `tests/research-integration.test.ts` — frozen-profile and foreground `Agent` integration tests.
- Modify: `tests/loop-program-block.test.ts` — compact one-role-per-call program guards.
- Modify: `tests/loop-research.test.ts` — loop orchestration against foreground `Agent` calls.
- Modify: `tests/live-research.smoke.ts` — migrated research dry-run and live-smoke coverage.
- Modify: `docs/superpowers/specs/2026-08-07-watch-subagents-design.md` — archival notice linking the replacement design.
- Modify: `docs/superpowers/specs/2026-08-09-shared-tmux-subagent-session-design.md` — archival notice linking the replacement design.
- Modify: `docs/superpowers/specs/2026-08-16-tmux-subagents-pi-subagents-ui-design.md` — archival notice linking the replacement design.
- Modify: `docs/superpowers/specs/2026-08-22-background-run-subagents-design.md` — archival notice linking its explicit superseding design.
- Modify: `docs/superpowers/plans/2026-08-07-watch-subagents.md` — archival notice linking the replacement plan.
- Modify: `docs/superpowers/plans/2026-08-09-shared-tmux-subagent-session.md` — archival notice linking the replacement plan.
- Modify: `docs/superpowers/plans/2026-08-16-tmux-subagents-pi-subagents-ui.md` — archival notice linking the replacement plan.
- Delete after cutover acceptance: `extensions/tmux-subagent/config.ts` — legacy layered configuration.
- Delete after cutover acceptance: `extensions/tmux-subagent/index.ts` — legacy extension entrypoint.
- Delete after cutover acceptance: `extensions/tmux-subagent/provider.ts` — legacy dispatch-provider adapter.
- Delete after cutover acceptance: `extensions/tmux-subagent/render.ts` — legacy pane-grid rendering.
- Delete after cutover acceptance: `extensions/tmux-subagent/runner.d.mts` — legacy runner declaration.
- Delete after cutover acceptance: `extensions/tmux-subagent/runner.mjs` — legacy runner.
- Delete after cutover acceptance: `extensions/tmux-subagent/tmux.ts` — legacy pane lifecycle.
- Delete after cutover acceptance: `extensions/tmux-subagent/__tests__/config.test.ts` — legacy configuration tests.
- Delete after cutover acceptance: `extensions/tmux-subagent/__tests__/index.test.ts` — legacy tool tests.
- Delete after cutover acceptance: `extensions/tmux-subagent/__tests__/integration.test.ts` — legacy integration tests.
- Delete after cutover acceptance: `extensions/tmux-subagent/__tests__/render.test.ts` — legacy rendering tests.
- Delete after cutover acceptance: `extensions/tmux-subagent/__tests__/runner.test.ts` — legacy runner tests.
- Delete after cutover acceptance: `extensions/tmux-subagent/__tests__/tmux.test.ts` — legacy tmux tests.
- Delete after cutover acceptance: `extensions/tmux-subagent/__tests__/widget-types-probe.ts` — legacy type probe.
- Delete after cutover acceptance: `extensions/subagent-dispatch/contract.ts` — obsolete provider contracts.
- Delete after cutover acceptance: `extensions/subagent-dispatch/index.ts` — obsolete `run_subagents` façade.
- Delete after cutover acceptance: `extensions/subagent-dispatch/registry.ts` — obsolete provider registry.
- Delete after cutover acceptance: `config/tmux-subagent.json` — legacy extension defaults.
- Delete after cutover acceptance: `config/subagent-dispatch.json` — obsolete dispatch defaults.
- Delete after cutover acceptance: `tests/subagent-contract.test.ts` — obsolete façade contract tests.
- Delete after cutover acceptance: `tests/subagent-summary.test.ts` — obsolete batched summary tests.
- Delete after cutover acceptance: `tests/tmux-provider.test.ts` — obsolete provider-adapter tests.
- Delete after cutover acceptance: `tests/tmux-subagent-load.smoke.ts` — legacy load smoke test.
- Delete after cutover acceptance: `tests/tmux-ui-render.test.ts` — legacy UI rendering tests.

## Global Constraints

- This is a clean replacement, not an in-place refactor.
- The existing `tmux-subagent` remains available while the replacement is tested and is removed only after cutover acceptance passes.
- There is no persistent supervisor daemon.
- No external queue service or queue library is used.
- Direct typing into child windows is unsupported; lifecycle control stays with the parent tools.
- Parent shutdown never kills running children.
- Directories use mode `0700`; files use `0600`.
- Existing symlinks or unexpected file types are rejected.
- Artifacts remain until the operating system cleans `/tmp`; the extension does not delete completed artifacts.
- Use `execFile`/argument arrays for tmux and process operations; never interpolate prompts or paths into shell commands.
- Validate all IDs and derive tmux names only from validated IDs.
- Canonicalize project, extension, and profile paths.
- Reject symlinked or unexpected artifact entries.
- Keep project configuration trust-gated.
- Treat child output as untrusted when constructing notifications.
- Do not expose prompt contents in compact rendering or tmux commands.
- Snapshot profiles before launch.
- Include schema version, generation, revision, heartbeat, PID, and process start identity in status records.
- Count `starting` as an occupied concurrency slot.
- Expose `Agent` to a child only when its profile explicitly requests it.
- Nested calls must use `run_in_background: false`.
- Home Manager tmux-launch integration remains a separate follow-up.

---

### Task 1: Freeze public contracts and lifecycle states

**Files:** Create `extensions/subagent/types.ts` and `extensions/subagent/__tests__/types.test.ts`.

**Interfaces:** Consumes the spec’s `Agent`, retrieval, stop, manifest, delivery, usage, profile, and state-machine fields. Produces `AgentRequest`, `AgentManifest`, `TaskStatus`, `TerminalResult`, `DeliveryRecord`, `ResolvedProfile`, `ProfileContribution`, `ProfilePolicyAdapter`, `AgentReceipt`, `ResultResponse`, `StopResponse`, `isShortId(value): boolean`, and `assertTransition(from, to): void` for all later tasks.

- [ ] Write failing table tests for strict `AgentRequest` fields/defaults, four-character IDs, every allowed and forbidden state transition, required schema/revision/process identity fields, and serializable profile snapshots.
- [ ] Run `npx vitest run extensions/subagent/__tests__/types.test.ts`; verify failure because the contracts and transition validator do not exist.
- [ ] Implement the exact unions and interfaces, default `run_in_background` to `true` at normalization, and enforce only the state edges listed in the spec.
- [ ] Rerun the targeted test and `npx tsc --noEmit`; verify both pass.
- [ ] Commit with message `feat(subagent): define durable public contracts`.

### Task 2: Build secure identity and artifact storage

**Files:** Create `extensions/subagent/identity.ts`, `extensions/subagent/storage.ts`, and `extensions/subagent/__tests__/identity-storage.test.ts`.

**Interfaces:** Consumes `AgentManifest`, `TaskStatus`, `TerminalResult`, `DeliveryRecord`, and `isShortId`. Produces `projectSlug(canonicalCwd): string`, `allocateShortId(checkCollision, randomBytes, maxAttempts): Promise<string>`, `resolveParentIdentity(options): Promise<ParentIdentity>`, and `ArtifactStore` methods `initializeParent`, `enqueue`, `scan`, `readTask`, `writeStatus`, `publishTerminal`, `requestCancellation`, `readDelivery`, and `updateDelivery`.

- [ ] Write failing tests for canonical basename-plus-hash slugs, tmux/artifact collision retries, `PI_SESSION_ID` resolution order, the exact root layout, `0700`/`0600` modes, symlink/type rejection, monotonic revisions, and result-before-terminal-status publication.
- [ ] Run `npx vitest run extensions/subagent/__tests__/identity-storage.test.ts`; verify missing-module failure.
- [ ] Implement cryptographic base-36 IDs, canonical path hashing, temporary-file-plus-fsync-plus-rename writes in the destination directory, append-log flushing, and secure path checks without cleanup of completed artifacts.
- [ ] Rerun the targeted test; verify all identity, permission, collision, and publication-order cases pass.
- [ ] Commit with message `feat(subagent): add secure durable artifact store`.

### Task 3: Implement generation-safe filesystem locks

**Files:** Create `extensions/subagent/locks.ts` and `extensions/subagent/__tests__/locks.test.ts`.

**Interfaces:** Consumes the parent root from `ParentIdentity` and process identity records from `types.ts`. Produces `acquireManagerLease(path, owner, signal): Promise<ManagerLease>`, `withRegistryLock(path, owner, fn, signal): Promise<T>`, and lease methods `assertCurrent()` and `release()`.

- [ ] Write failing tests for exclusive creation, incomplete-payload retry, live-owner refusal, PID-plus-start-time stale detection, competing quarantine renames, successor generation protection, and stale-owner release refusal.
- [ ] Run `npx vitest run extensions/subagent/__tests__/locks.test.ts`; verify the lock API is absent.
- [ ] Implement flushed identity payloads, bounded retry/backoff, atomic quarantine rename, generation checks around protected mutations, and idempotent owner-only release.
- [ ] Rerun the targeted test; verify one winner under contention and no stale mutation or successor unlink.
- [ ] Commit with message `feat(subagent): add generation-safe registry leases`.

### Task 4: Port layered configuration and profile discovery

**Files:** Create `config/subagent.json`, `extensions/subagent/config.ts`, and `extensions/subagent/__tests__/config.test.ts`.

**Interfaces:** Consumes `ResolvedProfile`, `ProfileContribution`, `ProfilePolicyAdapter`, Pi’s `CONFIG_DIR_NAME`, `getAgentDir`, `parseFrontmatter`, and `pi.events`. Produces `loadSubagentConfiguration(extensionDir, {cwd, agentDir, projectTrusted}): LoadedSubagentConfiguration` and `discoverProfiles(pi, loaded, context): DiscoveredProfiles` via synchronous `subagent:discover-profiles` envelopes containing caller-owned `contributions`.

- [ ] Write failing tests for packaged/user/trusted-project precedence, every specified merge rule, relative path canonicalization, malformed-layer fail-closed behavior, profile overrides/access validation, reserved-name conflicts, owner-plus-name deduplication, startup/per-call discovery, and untrusted project exclusion.
- [ ] Run `npx vitest run extensions/subagent/__tests__/config.test.ts`; verify missing loader/discovery failures.
- [ ] Port generic configuration behavior without research imports, set `maxConcurrent` to `10`, notification waits/previews to `30`/`500`/`300`, remove `retainArtifacts`, and snapshot serializable profile data separately from owner policy callbacks.
- [ ] Rerun the targeted test; verify all layers, invalid inputs, paths, profile conflicts, and discovery repetitions pass.
- [ ] Commit with message `feat(subagent): add layered profiles and discovery`.

### Task 5: Create the parent-session and agent-window tmux client

**Files:** Create `extensions/subagent/tmux.ts` and `extensions/subagent/__tests__/tmux.test.ts`.

**Interfaces:** Consumes validated parent/agent IDs and runner request paths. Produces `createTmuxClient(execFile): TmuxClient` with `currentSessionId`, `ensureParentSession`, `createAgentWindow`, `windowExists`, `closeVerifiedWindow`, `listAgentWindows`, `targetFor`, and `attachCommand`.

- [ ] Write failing executor-spy tests for current `pi-xxxx` reuse, detached keeper creation, detached `subagent-xxxx` windows, no focus changes, exact attach text, missing tmux errors, duplicate creation races, and argument-array safety with hostile paths.
- [ ] Run `npx vitest run extensions/subagent/__tests__/tmux.test.ts`; verify missing client failure.
- [ ] Implement tmux calls with `execFile` semantics only, validate all derived names, keep normal close-on-runner-exit behavior, and close orphan windows only after a durable terminal result check supplied by the caller.
- [ ] Rerun the targeted test; verify no command uses shell interpolation and every topology case passes.
- [ ] Commit with message `feat(subagent): add full-window tmux topology`.

### Task 6: Implement durable FIFO scheduling and recovery

**Files:** Create `extensions/subagent/scheduler.ts` and `extensions/subagent/__tests__/scheduler.test.ts`.

**Interfaces:** Consumes `ArtifactStore`, `ManagerLease`, `TmuxClient`, immutable profile snapshots, and `maxConcurrent`. Produces `createScheduler(deps): Scheduler` with `start`, `pump`, `reconcile`, `snapshot`, and `stop`; exports pure `occupiedOwnershipTrees(tasks)` and `selectEligibleQueued(tasks)` helpers.

- [ ] Write failing tests for sequence allocation under `registry.lock`, strict top-level FIFO, `starting` plus `running` slot counts, eleven tasks at concurrency ten, startup claim atomicity, queued pause without a manager, live-runner re-adoption, interrupted reconciliation, and verified orphan-window closure.
- [ ] Run `npx vitest run extensions/subagent/__tests__/scheduler.test.ts`; verify scheduler symbols are missing.
- [ ] Implement an independent asynchronous pump, lease-generation checks before every claim, immutable profile launch requests, coalesced reconciliation, and abortable timers that never run inside tool waits.
- [ ] Rerun the targeted test; verify FIFO, slot accounting, recovery, and eleven-task behavior pass.
- [ ] Commit with message `feat(subagent): add durable fifo scheduler`.

### Task 7: Add ownership-tree nested scheduling

**Files:** Modify `extensions/subagent/scheduler.ts` and `extensions/subagent/__tests__/scheduler.test.ts`.

**Interfaces:** Consumes `parentAgentId`, `ownershipTreeId`, nested foreground markers, and scheduler APIs from Task 6. Produces `isNestedEligible(task, tasks): boolean` and recursive `descendantIds(agentId, tasks): string[]` used by stop and `/agents`.

- [ ] Add failing tests for foreground-only nested enqueue, shared top-level slot, one active descendant per tree, in-tree FIFO, `maxConcurrent: 1` deadlock prevention, absent-manager queue retention, and descendant-first recursive cancellation ordering.
- [ ] Run the targeted scheduler test; verify nested cases fail while top-level cases remain green.
- [ ] Implement eligibility so a waiting ancestor retains its tree slot while exactly one descendant may be `starting` or `running`, and reject nested background work before publication.
- [ ] Rerun the targeted test; verify all top-level and nested cases pass together.
- [ ] Commit with message `feat(subagent): schedule nested ownership trees`.

### Task 8: Build the standalone Pi RPC runner

**Files:** Create `extensions/subagent/runner.mjs`, `extensions/subagent/runner.d.mts`, and `extensions/subagent/__tests__/runner.test.ts`.

**Interfaces:** Consumes a persisted `RunnerRequest`, `ArtifactStore` terminal ordering, and snapshotted profile fields. Produces `runTaskMode(requestPath, deps?): Promise<void>` and `main(argv): Promise<void>`; writes status/events/stderr/transcript/result records and accepts atomic cancellation files.

- [ ] Write failing fake-child tests for strict LF JSONL parsing, startup acknowledgement, prompt/system/model/thinking/tools/extensions/context/web-budget arguments, process-group creation, activity/usage/context/compaction capture, authoritative stats/final-message requests, startup failure, timeout, cancellation escalation, and interrupted partial logs.
- [ ] Run `npx vitest run extensions/subagent/__tests__/runner.test.ts`; verify the runner is missing.
- [ ] Implement RPC event coalescing, heartbeat/status publication, readable read-only terminal mirroring, `SIGTERM` then grace-period `SIGKILL` for the whole process group, flushed logs, result-before-terminal status, and exit-driven tmux window closure.
- [ ] Rerun the targeted test; verify every terminal reason and publication order passes without real Pi or tmux.
- [ ] Commit with message `feat(subagent): add durable rpc runner`.

### Task 9: Implement manager enqueue, wait, retrieval, and stop

**Files:** Create `extensions/subagent/manager.ts` and `extensions/subagent/__tests__/manager.test.ts`.

**Interfaces:** Consumes identity, storage, locks, configuration, scheduler, tmux, runner, descendants, and owner policy hooks. Produces `createSubagentManager(deps): SubagentManager` with `start(ctx)`, `enqueue(request, callContext, signal)`, `getResult(agentId, wait, signal)`, `stop(agentId)`, `list()`, and `shutdown()`.

- [ ] Write failing tests for one-child-per-call durable enqueue, queued/starting/running receipts, background startup acknowledgement, interruptible foreground waits, result-only terminal retrieval, atomic consumed delivery, unknown current-parent IDs, queued/running/terminal stop, recursive stop, tmux-unavailable preflight, startup failure, and observer-mode mutation rejection with owner details.
- [ ] Run `npx vitest run extensions/subagent/__tests__/manager.test.ts`; verify manager behavior is unavailable.
- [ ] Implement per-call config/profile re-resolution, owner-policy reservation before publication, abort-aware polling, result normalization from `result.json`, cancellation control requests, idempotent terminal responses, and awaited shutdown that releases only the current lease.
- [ ] Rerun the targeted test; verify public behavior, cancellation, consumption, and observer mode pass.
- [ ] Commit with message `feat(subagent): add manager public operations`.

### Task 10: Add grouped completion delivery

**Files:** Create `extensions/subagent/notifications.ts` and `extensions/subagent/__tests__/notifications.test.ts`.

**Interfaces:** Consumes background manifests/results/delivery records, active origin conversation UUID, manager generation, and Pi `sendMessage`. Produces `NotificationCoordinator` methods `turnStart`, `turnEnd`, `evaluate`, `consume`, and `recover`, plus `renderNotificationXml(items, previewLimit): string`.

- [ ] Write failing tests for turn-index/nonce group IDs, same-turn parallel membership, foreground exclusion, all-terminal delivery, 30-second partial flush, later stragglers, 500/300 Unicode-safe previews, XML escaping, consumed omission, serialized consume-versus-dispatch, `dispatching` crash recovery, send failure, and `/new` suppression plus original-session resume.
- [ ] Run `npx vitest run extensions/subagent/__tests__/notifications.test.ts`; verify coordinator symbols are missing.
- [ ] Implement durable groups and delivery states, persist `dispatching` before one `pi.sendMessage` call with `customType: "subagent-notification"`, `deliverAs: "followUp"`, and `triggerTurn: true`, and treat ambiguous recovery as attempted.
- [ ] Rerun the targeted test; verify grouped, at-most-once, consumption, escaping, and origin-binding cases pass.
- [ ] Commit with message `feat(subagent): add durable grouped notifications`.

### Task 11: Port compact rendering, widget/footer, and `/agents`

**Files:** Create `extensions/subagent/render.ts` and `extensions/subagent/__tests__/render.test.ts`.

**Interfaces:** Consumes `AgentReceipt`, `ResultResponse`, manager snapshots, and notification details. Produces `createToolRenderers`, `renderWidgetLines`, `renderFooter`, `renderNotificationMessage`, and `runAgentsCommand(ctx, manager)`.

- [ ] Write failing golden tests for canonical running/queued/done rows, no compact prompt echo, expanded tmux/attach/artifact fields, queued/running/recently-completed widget rows, footer counts, width-safe output, compact notification rendering, hierarchy indentation, and `/agents` attach/stop/retrieve/path/refresh actions.
- [ ] Run `npx vitest run extensions/subagent/__tests__/render.test.ts`; verify rendering exports are absent.
- [ ] Implement `Text`/`SelectList`-based renderers, `registerMessageRenderer` content, component invalidation, TUI-only custom selection, RPC string widgets, completed-row dismissal on next input, and no pane-grid/window-title logic.
- [ ] Rerun the targeted test; verify all golden output and interaction cases pass.
- [ ] Commit with message `feat(subagent): add manager ui and agents command`.

### Task 12: Register tools and lifecycle across runtime modes

**Files:** Create `extensions/subagent/index.ts`, `extensions/subagent/__tests__/integration.test.ts`, `tests/subagent-load.smoke.ts`, and modify `types/pi-coding-agent.d.ts`.

**Interfaces:** Consumes `SubagentManager`, `NotificationCoordinator`, renderers, TypeBox, Pi events, and session UUIDs. Produces strict tools `Agent({description, prompt, subagent_type, run_in_background?})`, `get_subagent_result({agent_id, wait?})`, `stop_subagent({agent_id})`, command `/agents`, and startup/turn/input/shutdown event wiring.

- [ ] Write failing integration and jiti smoke tests for exact schemas/registration, startup ordering, recovery pump, awaited shutdown, TUI/RPC/print/JSON behavior, background print survival receipt, foreground print wait, widget cleanup, and no untracked async shutdown closure.
- [ ] Run `npx vitest run extensions/subagent/__tests__/integration.test.ts tests/subagent-load.smoke.ts`; verify registration failures.
- [ ] Implement the extension entrypoint, strict TypeBox objects, typed `turn_start`, `registerMessageRenderer`, mode guards, session-origin updates, manager start/stop, and nested-producer mode when `PI_SUBAGENT=1` with explicit `Agent` profile access.
- [ ] Rerun the targeted tests and `npx tsc --noEmit`; verify tools, lifecycle, modes, and declarations pass.
- [ ] Commit with message `feat(subagent): register agent tools and lifecycle`.

### Task 13: Exercise restart, concurrency, and real tmux acceptance before migration

**Files:** Modify `extensions/subagent/__tests__/integration.test.ts` and create `tests/live-subagent.smoke.ts`.

**Interfaces:** Consumes the complete isolated extension and injectable fake RPC executable. Produces an acceptance driver with `--fake-pi` deterministic mode and `--real-pi` operator mode, returning nonzero on any topology, state, recovery, or result mismatch.

- [ ] Add failing integration cases for parent reload re-adoption, parent absence while runners finish, pending origin delivery recovery, missing runner/window interruption, foreground wait with continued dispatch, nested foreground execution, and recursive cancellation; add the eleven-step live checklist as executable assertions in the smoke driver.
- [ ] Run `npx vitest run extensions/subagent/__tests__/integration.test.ts` and `npx tsx tests/live-subagent.smoke.ts --fake-pi`; verify the new acceptance cases expose missing recovery wiring.
- [ ] Make only the integration fixes needed for deterministic fake RPC and real tmux: same-ID reconnect, detached windows, terminal window closure, queue restart, and artifact/result verification.
- [ ] Rerun both commands; verify the isolated suite and fake live-tmux acceptance pass while legacy files remain untouched.
- [ ] Commit with message `test(subagent): cover recovery and live tmux topology`.

### Task 14: Adapt research policy to profile-owned Agent hooks

**Files:** Create `extensions/research/subagent.ts` and `tests/research-subagent.test.ts`; modify `extensions/research/policy.ts` and `tests/research-policy.test.ts`.

**Interfaces:** Consumes `ProfileContribution`, `ProfilePolicyAdapter`, `AgentRequest`, terminal outcomes, frozen research workspace roles, and `ResearchPolicy`. Produces `registerResearchSubagentIntegration(pi, deps): void`, `resolveResearchProfiles(workspace, config): ProfileContribution[]`, and an adapter whose `reserve` returns durable reservation metadata and whose `settle` releases concurrency and exports retained artifacts idempotently.

- [ ] Write failing characterization tests covering frozen role whitelisting, model/tool/access validation, per-role total and concurrent ceilings, provider-wide ceiling, hard timeout, web budgets, durable reserve/release after failure/cancellation/interruption, retention, JSON validation, confined export, and recovered idempotent settlement.
- [ ] Run `npx vitest run tests/research-policy.test.ts tests/research-subagent.test.ts`; verify the new adapter tests fail while the legacy characterization remains green.
- [ ] Move dispatch-neutral attempt/outcome/reservation types into the research integration, map each `Agent` enqueue to one reserved attempt, persist reservation identity in the generic manifest, settle on terminal detection or recovery, and preserve every characterized policy behavior without importing generic code into `ResearchPolicy`.
- [ ] Rerun both tests; verify all old policy guarantees pass through the new owner-policy adapter.
- [ ] Commit with message `feat(research): adapt policy to Agent lifecycle`.

### Task 15: Move research profile ownership and startup validation

**Files:** Modify `extensions/research/config.ts`, `extensions/research/startup.ts`, `extensions/loop/index.ts`, `config/research.json`, `tests/research-config.test.ts`, `tests/research-startup.test.ts`, and startup sections of `tests/research-integration.test.ts`.

**Interfaces:** Consumes `registerResearchSubagentIntegration` and frozen research configuration. Produces research-owned `models`, already-resolved role profiles on `subagent:discover-profiles`, and `validateStartupContract` output keyed by resolved role profiles rather than `ProviderDescriptor` or `negotiateProvider`.

- [ ] Write failing tests that load packaged/user research aliases and prompts, contribute every role idempotently regardless of extension load order, reject model/tool/access conflicts, freeze resolved profiles at run activation, and assert startup has no provider registry or `subagent-dispatch` dependency.
- [ ] Run `npx vitest run tests/research-config.test.ts tests/research-startup.test.ts tests/research-integration.test.ts`; verify the new profile-bound assertions fail.
- [ ] Move research aliases into `config/research.json`, point its child capability at `extensions/subagent/index.ts`, register the discovery listener in `loop/index.ts`, remove `buildProviderView`, `ProviderRegistryView`, `ProviderDescriptor`, and `negotiateProvider`, and keep research prompt paths and role resolution entirely research-owned.
- [ ] Rerun the targeted tests and `npx tsc --noEmit`; verify startup, frozen snapshots, load-order independence, and type consistency pass.
- [ ] Commit with message `feat(research): contribute resolved subagent profiles`.

### Task 16: Rewrite research orchestration around compact foreground Agent calls

**Files:** Modify `skills/research/SKILL.md`, `skills/research/program.md`, `skills/research/agents/fetcher.md`, `skills/research/agents/planner.md`, `skills/research/agents/citation-agent.md`, `skills/research/agents/consolidator.md`, `skills/research/agents/contradiction-resolver.md`, `skills/research/agents/fragment-writer.md`, `skills/research/agents/judge.md`, `skills/research/agents/scout.md`, `skills/research/agents/source-auditor.md`, `tests/loop-program-block.test.ts`, `tests/loop-research.test.ts`, `tests/research-integration.test.ts`, and `tests/live-research.smoke.ts`.

**Interfaces:** Consumes `Agent` with one child per call and `run_in_background: false`, plus complete inline terminal results and research-owned policy artifacts. Produces parallelism through sibling `Agent` calls in one assistant message and parent-driven persisted research files without `tasks`, `return_mode`, `retain_artifacts`, or `result_path` fields.

- [ ] Write failing static and integration tests requiring exact `Agent` keys, one role per call, foreground research dispatch, sibling-call parallelism, parent persistence of returned content, usage accounting, and absence of all legacy batch/result-envelope vocabulary.
- [ ] Run `npx vitest run tests/loop-program-block.test.ts tests/loop-research.test.ts tests/research-integration.test.ts`; verify current `run_subagents` examples and result contracts fail the guards.
- [ ] Rewrite coordinator instructions and role prompts so each prompt is a complete task contract, parallel work uses multiple calls in the same turn, returned content is written by the coordinator to named workspace files, and retention/export metadata comes from the research policy adapter.
- [ ] Rerun the targeted tests and `npx tsx tests/live-research.smoke.ts --dry-run`; verify prompt contracts, policy accounting, and dry-run workflow pass.
- [ ] Commit with message `feat(research): migrate workflows to Agent tool`.

### Task 17: Document and teach the new public behavior

**Files:** Modify `skills/subagent/SKILL.md` and `README.md`; create `tests/subagent-docs.test.ts`.

**Interfaces:** Consumes the final public schemas, configuration paths/defaults, tmux names, storage layout, runtime modes, recovery rules, notification behavior, nesting rules, and `/agents` actions. Produces user guidance that names only `Agent`, `get_subagent_result`, and `stop_subagent` for the new extension.

- [ ] Write failing static tests for all three public tools, background default, multiple-call parallelism, four-character IDs, config precedence, trusted project gate, attach/result/stop examples, foreground nested rule, `/tmp` sensitivity, and absence of `run_subagents`, `maxTasks`, and `retainArtifacts` from active guidance.
- [ ] Run `npx vitest run tests/subagent-docs.test.ts`; verify current README and skill fail the new vocabulary and defaults.
- [ ] Rewrite the skill concisely and replace the README’s legacy section with setup, API, configuration, UI, recovery, security, and troubleshooting instructions that never echo prompt contents.
- [ ] Rerun the static test; verify documentation matches the implemented names, types, defaults, and constraints.
- [ ] Commit with message `docs(subagent): document Agent workflow`.

### Task 18: Cut over and remove the legacy stack

**Files:** Create `tests/subagent-cutover.test.ts`; modify `docs/superpowers/specs/2026-08-07-watch-subagents-design.md`, `docs/superpowers/specs/2026-08-09-shared-tmux-subagent-session-design.md`, `docs/superpowers/specs/2026-08-16-tmux-subagents-pi-subagents-ui-design.md`, `docs/superpowers/specs/2026-08-22-background-run-subagents-design.md`, `docs/superpowers/plans/2026-08-07-watch-subagents.md`, `docs/superpowers/plans/2026-08-09-shared-tmux-subagent-session.md`, and `docs/superpowers/plans/2026-08-16-tmux-subagents-pi-subagents-ui.md`; delete the exact legacy runtime, test, and configuration files listed in the project file map above.

**Interfaces:** Consumes passing isolated, research, documentation, fake-live, and real-live acceptance from Tasks 13–17. Produces one auto-discovered `extensions/subagent/index.ts`, no provider-dispatch façade consumers, and no production or active-test references to the legacy extension names.

- [ ] Write a failing cutover guard that requires the new extension/config, rejects legacy runtime/config paths and imports, and verifies Pi’s loader exposes `Agent`, `get_subagent_result`, and `stop_subagent` exactly once.
- [ ] Run `npx vitest run tests/subagent-cutover.test.ts`; verify it fails because rollback files still exist.
- [ ] Delete the legacy runtime, façade, configs, and legacy-only tests; add archival notices to the superseded historical specs and plans; then run `npx tsx tests/live-subagent.smoke.ts --real-pi` and complete all eleven live acceptance assertions, including one nested foreground agent and a full research workflow.
- [ ] Run `npx vitest run`, `npx tsc --noEmit`, `npx vitest run tests/subagent-cutover.test.ts`, and `npx tsx tests/live-subagent.smoke.ts --fake-pi`; verify every command passes after the real-live gate.
- [ ] Commit with message `refactor(subagent): cut over to durable Agent extension`.

## Self-Review

- Spec coverage: Tasks 1–13 cover API, identity, storage, locks, FIFO/tree scheduling, runner ownership, cancellation, recovery, notifications, runtime modes, UI, errors, and live tmux acceptance; Tasks 14–16 preserve research profile/policy behavior and migrate orchestration; Tasks 17–18 cover documentation and gated cutover.
- Placeholder scan: The plan contains no deferred implementation markers or generic error-handling steps; every task names its failure, implementation boundary, verification command, and commit.
- Interface/type consistency: `types.ts` owns shared durable/public types; configuration produces snapshotted `ResolvedProfile` values and in-memory `ProfilePolicyAdapter` hooks; storage, scheduler, runner, manager, notifications, rendering, and research consume those same names through the ordered tasks.
