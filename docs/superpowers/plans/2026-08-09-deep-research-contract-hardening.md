# Deep Research Contract Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `/research` lossless, configurable, and unable to complete without current checkpoint and verification evidence.

**Architecture:** A shared deep-research configuration loader supplies profile and agent definitions to both loop and subagent extensions. Structured subagent summaries guide the coordinator, while durable artifact payloads and strict verification JSON remain in the research directory.

**Tech Stack:** TypeScript ESM, TypeBox, Node filesystem APIs, Vitest, Markdown, JSON, org-mode.

## Global Constraints

- Follow the approved design in `docs/superpowers/specs/2026-08-09-deep-research-contract-hardening-design.md`.
- Use test-first development for each behavior change.
- Keep generic `worker`, `reviewer`, `tester`, and code-scout profiles global.
- Do not load project-local agent/access overrides.
- Preserve existing `/research` commands; new resource flags are optional.
- Do not modify the unrelated `skills/org2pdf/scripts/org2pdf.sh` change.
- This plan intentionally contains no implementation snippets.

---

## File Structure

**Create**

- `config/deep-research.json` — packaged orchestration and agent defaults.
- `extensions/deep-research/config.ts` — strict packaged/user configuration loading and merge validation.
- `extensions/deep-research/verification.ts` — score and verification artifact validation.
- `skills/deep-research/agents/*.md` — research-specific prompt bodies.
- `tests/deep-research-config.test.ts` — configuration and override coverage.
- `tests/deep-research-verification.test.ts` — score, checkpoint, and verification schema coverage.
- `tests/deep-research-program.test.ts` — executable program and prompt contract coverage.

**Modify**

- `extensions/tmux-subagent/config.ts` — register configured research agents.
- `extensions/tmux-subagent/index.ts` — structured summaries, durable exports, and active research budgets.
- `extensions/tmux-subagent/render.ts` — actionable summary rendering.
- `extensions/loop/index.ts` — CLI flags, resolved configuration, checkpoint state, and completion gates.
- `skills/deep-research/program.v2.md` — methodology-only executable contract.
- `docs/006-deep-research-spec.md` — authoritative behavior documentation.
- `tests/loop-checkpoint.test.ts`, `tests/loop-research.test.ts`, and `tests/loop-program-block.test.ts` — loop integration coverage.
- `tests/subagent-summary.test.ts` and `extensions/tmux-subagent/__tests__/{config,index}.test.ts` — subagent coverage.

**Remove after migration**

- `subagents/scout_research.md`
- `subagents/fetcher.md`
- `subagents/judge.md`
- `subagents/citation_agent.md`
- `subagents/source_auditor.md`
- `subagents/contradiction_resolver.md`

---

### Task 1: Deep-research configuration and agent registry

**Files:** Create `config/deep-research.json`, `extensions/deep-research/config.ts`, `tests/deep-research-config.test.ts`, and `skills/deep-research/agents/*.md`; modify `extensions/tmux-subagent/config.ts`, `extensions/tmux-subagent/__tests__/config.test.ts`, and `config/tmux-subagent.json`; remove migrated global profiles.

**Interfaces:** Produce `ResolvedDeepResearchConfig`, `loadDeepResearchConfiguration(packageRoot, agentDir)`, and an adapter that exposes configured research roles as validated tmux-subagent profiles.

- [ ] Write failing tests for packaged defaults, all four profiles, agent metadata, prompt resolution, strict unknown-field rejection, user deep-merge precedence, invalid access/tools, and rejection of project-local overrides.
- [ ] Run the configuration tests and confirm the new loader/registry expectations fail.
- [ ] Add the packaged configuration, shared loader, user override path, research prompt directory, and tmux profile adapter.
- [ ] Move research-specific profiles, add the planner prompt, and confirm generic global profiles remain unchanged.
- [ ] Run configuration and tmux-subagent config tests; confirm they pass.
- [ ] Commit as `feat: add deep research configuration and agents`.

### Task 2: Structured summaries and durable result export

**Files:** Modify `extensions/tmux-subagent/index.ts`, `extensions/tmux-subagent/render.ts`, `tests/subagent-summary.test.ts`, and `extensions/tmux-subagent/__tests__/index.test.ts`.

**Interfaces:** Extend each task with optional `result_path`; add a structured-result parser that returns validated coordinator fields and an optional artifact payload.

- [ ] Write failing tests for complete coordinator-summary extraction, missing/malformed summary failure, conditional artifact requirements, exact artifact extraction, atomic export, export failure, and summary rendering with result path and usage.
- [ ] Run targeted summary/index tests and confirm failure for the new contract.
- [ ] Implement structured parsing, failure disposition, safe temporary-file rename, and result metadata without returning full artifact bodies to the coordinator.
- [ ] Verify summary-only tasks remain supported when no `result_path` is supplied.
- [ ] Run all tmux-subagent and summary tests; confirm they pass.
- [ ] Commit as `feat: add structured subagent results`.

### Task 3: Research CLI configuration and enforced per-agent budgets

**Files:** Modify `extensions/loop/index.ts`, `extensions/tmux-subagent/index.ts`, `tests/loop-research.test.ts`, and `extensions/tmux-subagent/__tests__/index.test.ts`.

**Interfaces:** Persist resolved research configuration and `maxSearchesPerAgent`/`maxFetchesPerAgent` in loop state; expose them to subagent execution through the active session state.

- [ ] Write failing tests for both new flags, numeric validation, JSON defaults, CLI precedence, `0` as unlimited, resolved-value confirmation text, persistence, restore behavior, and automatic child-process budget propagation.
- [ ] Add a test proving task arguments cannot bypass a stricter active `/research` budget.
- [ ] Run targeted loop and tmux tests; confirm they fail before implementation.
- [ ] Implement parsing, resolved configuration display, persisted execution settings, and session-aware budget application in `run_subagents`.
- [ ] Run targeted tests and confirm existing invocations still pass without the new flags.
- [ ] Commit as `feat: expose research agent limits`.

### Task 4: Override-aware checkpoint and score validation

**Files:** Create `tests/deep-research-verification.test.ts`; modify `extensions/deep-research/verification.ts`, `extensions/loop/index.ts`, `tests/loop-checkpoint.test.ts`, and `tests/loop-research.test.ts`.

**Interfaces:** Add strict `score.md` table parsing and persisted checkpoint evidence tied to run ID, round, source count, score state, and verdict.

- [ ] Write failing tests for five-to-eight unique score rows, integer score bounds, malformed tables, configured score thresholds, lower and higher `--max-rounds` overrides, `PROCEED_WITH_GAPS`, and honest URL counting.
- [ ] Write failing tests showing a successful checkpoint is recorded and invalidated when another research round starts.
- [ ] Run checkpoint tests and confirm the new cases fail.
- [ ] Implement score validation, effective-cap semantics, persisted checkpoint evidence, and stale-evidence invalidation.
- [ ] Remove the round-0 checkpoint path and preserve 1-indexed research rounds.
- [ ] Run checkpoint and loop tests; confirm they pass.
- [ ] Commit as `feat: harden research checkpoints`.

### Task 5: Verification schemas and completion enforcement

**Files:** Modify `extensions/deep-research/verification.ts`, `extensions/loop/index.ts`, `tests/deep-research-verification.test.ts`, `tests/loop-checkpoint.test.ts`, and `tests/loop-research.test.ts`.

**Interfaces:** Validate versioned judge, citation, source-audit, and contradiction JSON; make research completion return precise gate failures.

- [ ] Write failing tests for every valid and malformed verification artifact, run-ID mismatch, failed verdicts, unresolved replacements, unsupported citations, and acknowledged versus unhandled contradictions.
- [ ] Write profile-matrix tests for quick, standard, intermediate, and deep completion requirements.
- [ ] Write integration tests rejecting completion for stale checkpoints, empty reports, missing/failed artifacts, and `budget_limited` runs.
- [ ] Run targeted tests and confirm the gates fail before implementation.
- [ ] Implement strict artifact validation and `/research`-specific `complete_loop` checks while leaving generic `/loop` completion unchanged.
- [ ] Confirm capped incomplete runs remain `budget_limited`; confirm fully verified active runs complete.
- [ ] Run loop and verification tests; confirm they pass.
- [ ] Commit as `feat: enforce research verification gates`.

### Task 6: Rewrite the executable program and agent contracts

**Files:** Create `tests/deep-research-program.test.ts`; modify `skills/deep-research/program.v2.md`, `skills/deep-research/agents/*.md`, and `tests/loop-program-block.test.ts`.

**Interfaces:** Program uses logical roles only; every summary-mode agent emits the required coordinator summary, and artifact-producing agents emit the required artifact payload.

- [ ] Write failing contract tests that reject embedded runtime configuration, hardcoded agent-profile names, multi-task examples, invalid org headings, numbered-citation guidance, and missing summary/artifact instructions.
- [ ] Rewrite the program around sequential rounds, durable result paths, strict score format, synthesis/repair ordering, profile-driven verification, and honest cap behavior.
- [ ] Update research agent prompts for actionable summaries, strict verification JSON, inline org citations, and matching repair outputs.
- [ ] Run contract, prompt-discovery, and program-injection tests; confirm they pass.
- [ ] Commit as `docs: align deep research execution contract`.

### Task 7: Documentation and end-to-end regression

**Files:** Modify `docs/006-deep-research-spec.md` and `tests/loop-research.test.ts`.

**Interfaces:** Documentation describes configuration precedence, CLI flags, artifact layout, verification matrix, and terminal statuses exactly as implemented.

- [ ] Add an end-to-end mocked run covering plan, scout export, consolidation, checkpoint, synthesis, verification, and successful completion.
- [ ] Add the capped-run counterpart proving partial artifacts survive without a success status.
- [ ] Update the feature spec and remove stale profile, artifact, self-judge, and coordinator-repair claims.
- [ ] Run `npx vitest run` and confirm all tests pass with clean output.
- [ ] Run `lens_diagnostics` on all modified TypeScript files and resolve blocking findings.
- [ ] Check the final diff for unrelated changes and confirm `skills/org2pdf/scripts/org2pdf.sh` is excluded.
- [ ] Commit as `test: verify hardened deep research flow`.
