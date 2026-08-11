# Model-Aware Auto-Compaction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Pi extension that enforces per-model context-usage compaction thresholds expressed as percentages or absolute token counts.

**Architecture:** Strict layered configuration feeds a pure model-policy resolver and a session-local controller. Pi event wiring triggers earlier compaction, gates premature built-in threshold compaction, preserves manual and overflow flows, and exposes `/auto-compact` status.

**Tech Stack:** TypeScript ES modules, Pi Extension API, minimatch, Vitest, Node filesystem APIs.

## Global Constraints

- Preserve Pi's summary generation and `keepRecentTokens` behavior.
- Never block manual `/compact` or Pi overflow recovery.
- Do not mutate Pi `settings.json` files.
- Match case-sensitive canonical `provider/model-id` keys.
- Use packaged, user, then trusted-project configuration layers.
- Use `CONFIG_DIR_NAME`; never hardcode `.pi`.
- Keep model-context messages free of extension status output.

## File Map

- Create `config/auto-compact.json`: packaged 80% default.
- Create `extensions/auto-compact/policy.ts`: types, glob matching, precedence, threshold resolution.
- Create `extensions/auto-compact/config.ts`: strict parsing, validation, trust-aware layer loading.
- Create `extensions/auto-compact/controller.ts`: threshold state, gating, and loop prevention.
- Create `extensions/auto-compact/index.ts`: Pi events, notifications, and status command.
- Create three focused test files under `tests/` for policy, config, and controller/integration behavior.
- Modify `package.json`: declare minimatch as a runtime dependency.
- Modify `types/pi-coding-agent.d.ts`: add only required public Pi types.
- Modify `README.md`: document installation, configuration, precedence, and status usage.

---

### Task 1: Policy engine

**Files:**

- Create: `extensions/auto-compact/policy.ts`
- Create: `tests/auto-compact-policy.test.ts`
- Modify: `package.json`

**Interfaces:**

- Produce `ConfigLayer`, `ModelRule`, `ResolvedPolicy`, and `PolicyWarning` types.
- Produce `resolveModelPolicy(layers, modelKey, contextWindow)`.
- Return source layer, matched pattern or default, enabled state, effective token threshold, and warnings.

- [ ] Write failing tests for project/user/packaged precedence, first-match ordering, case-sensitive provider/model globs, percentage flooring, absolute thresholds, disabled rules, and oversized-token warnings.
- [ ] Run `npx vitest run tests/auto-compact-policy.test.ts`; confirm failures are caused by the missing policy implementation.
- [ ] Add minimatch to runtime dependencies and implement the smallest pure resolver satisfying the tests.
- [ ] Re-run the focused test and confirm it passes.
- [ ] Commit as `feat: add auto-compaction policy resolver`.

### Task 2: Strict layered configuration

**Files:**

- Create: `config/auto-compact.json`
- Create: `extensions/auto-compact/config.ts`
- Create: `tests/auto-compact-config.test.ts`

**Interfaces:**

- Produce `loadAutoCompactConfiguration(options)` returning valid ordered layers, loaded/ignored paths, and sanitized warnings.
- Options must include package root, agent directory, cwd, and project trust state.
- Optional invalid layers are ignored atomically; packaged invalidity throws.

- [ ] Write failing tests for the exact 80% packaged default, partial user/project files, strict unknown-field rejection, threshold exclusivity, disabled-rule validation, invalid-layer fallback, warning redaction, and untrusted-project exclusion.
- [ ] Run `npx vitest run tests/auto-compact-config.test.ts`; confirm expected failures.
- [ ] Implement trust-aware loading using `$PI_AGENT_DIR/auto-compact/config.json` and `<cwd>/${CONFIG_DIR_NAME}/auto-compact.json`.
- [ ] Re-run config and policy tests; confirm both pass.
- [ ] Commit as `feat: load auto-compaction configuration`.

### Task 3: Session-local controller

**Files:**

- Create: `extensions/auto-compact/controller.ts`
- Create: `tests/auto-compact-controller.test.ts`

**Interfaces:**

- Produce `AutoCompactController` with methods to reset a session, evaluate a usage snapshot, gate a Pi compaction attempt, record completion/failure, and return status.
- Evaluation must atomically mark a trigger in flight.
- Gate input includes Pi reason, tokens, resolved policy, and global enablement.

- [ ] Write failing tests for initial/resumed evaluation, model-change reset, unknown usage, `>=` boundary behavior, one-shot threshold crossing, in-flight deduplication, rearming below threshold, successful completion, failure disarming, disabled model rules, global disablement, and manual/overflow pass-through.
- [ ] Run `npx vitest run tests/auto-compact-controller.test.ts`; confirm expected failures.
- [ ] Implement the minimal state machine and fail-open behavior when model context cannot be resolved.
- [ ] Re-run controller and policy tests; confirm they pass.
- [ ] Commit as `feat: add auto-compaction controller`.

### Task 4: Pi extension wiring and status command

**Files:**

- Create: `extensions/auto-compact/index.ts`
- Modify: `tests/auto-compact-controller.test.ts`
- Modify: `types/pi-coding-agent.d.ts`

**Interfaces:**

- Register `session_start`, `model_select`, `turn_end`, `session_before_compact`, and `session_compact` handlers.
- Register `/auto-compact` with no arguments.
- Use `ctx.compact()` callbacks for plugin-triggered completion and failure.

- [ ] Extend the fake Pi harness with failing integration tests for session/model/turn evaluation, threshold cancellation and allowance, `session_compact` synchronization, UI-guarded notifications, config warnings, and status output without `pi.sendMessage()`.
- [ ] Run the focused controller test; confirm integration cases fail.
- [ ] Wire configuration, policy, and controller modules; update the local Pi type shim only for APIs used by this extension.
- [ ] Re-run all three auto-compaction test files; confirm they pass.
- [ ] Commit as `feat: register model-aware auto compaction`.

### Task 5: Documentation and final verification

**Files:**

- Modify: `README.md`
- Verify all files changed in Tasks 1–4.

- [ ] Document configuration paths, schema, precedence, disabled rules, `/reload`, `/auto-compact`, and preservation of manual/overflow behavior.
- [ ] Run `npx vitest run tests/auto-compact-*.test.ts` and confirm all focused tests pass.
- [ ] Run `npm test` and confirm the full suite passes.
- [ ] Run LSP diagnostics on `extensions/auto-compact/`, its tests, and the type shim; resolve all new errors and warnings.
- [ ] Run `lens_diagnostics` in `all` mode and verify no blocking findings remain in edited files.
- [ ] Load `extensions/auto-compact/index.ts` through Pi where local model/auth availability permits and verify clean registration.
- [ ] Commit as `docs: document model-aware auto compaction`.
