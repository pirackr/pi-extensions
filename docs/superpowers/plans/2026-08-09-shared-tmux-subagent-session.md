# Shared tmux Subagent Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace per-batch tmux sessions with one shared `pi-subagents` session containing one metadata-owned window per parent Pi session and one pane per subagent.

**Architecture:** Add a focused tmux orchestration module for naming, locking, window discovery, pane rollover, and deterministic layouts. Keep task execution in `runner.mjs`, integrate orchestration and Pi lifecycle events in `index.ts`, and preserve artifact behavior while adding private durable transcripts.

**Tech Stack:** TypeScript, Node.js ESM, tmux 3.x commands, Pi extension events, Vitest.

## Global Constraints

- Use exactly one shared tmux session named `pi-subagents`.
- Identify parent windows by Pi session ID stored in tmux metadata, not by display name.
- Never move the parent Pi TUI into the shared session.
- Preserve running panes across concurrent batches; prune dead panes only when a later batch starts.
- Keep completed panes visible with tmux `remain-on-exit`.
- Start with side-by-side panes, then use balanced column-first grids through at least 16 panes.
- Derive display names from shortened project path plus explicit Pi session name; fall back to the first user prompt.
- Close only the owning parent window during Pi shutdown.
- Store transcripts under private `/tmp` directories with directory mode `0700` and file mode `0600`; do not delete them during normal extension cleanup.
- Keep existing `retain_artifacts` behavior unchanged.
- Remove runtime files, tests, and `AGENTS.md` guidance for `watch-subagents`; retain its historical spec and plan.
- Add no daemon and no new runtime dependency.

## File Map

| File | Responsibility |
| --- | --- |
| `extensions/tmux-subagent/tmux.ts` | Shared-session naming, metadata, locking, pane lifecycle, rollback, and layouts. |
| `extensions/tmux-subagent/__tests__/tmux.test.ts` | Unit tests for naming, concurrency-safe mutation, rollover, rollback, and layout behavior. |
| `extensions/tmux-subagent/index.ts` | Prepare tasks, launch panes, report attachment details, cancel only the current batch, and register parent lifecycle handlers. |
| `extensions/tmux-subagent/__tests__/index.test.ts` | Integration tests for tool details, progress, cancellation, and Pi lifecycle events. |
| `extensions/tmux-subagent/runner.mjs` | Mirror human-readable subagent output into private transcript files. |
| `extensions/tmux-subagent/runner.d.mts` | Keep runner declarations aligned with exported runner behavior. |
| `extensions/tmux-subagent/__tests__/runner.test.ts` | Transcript mirroring, permissions, and failure-isolation tests. |
| `AGENTS.md` | Remove obsolete watcher instructions. |
| `tools/watch-subagents`, `tools/watch-subagents.mjs`, `tools/watch-subagents.d.mts` | Delete obsolete watcher runtime. |
| `tests/watch-subagents.test.ts` | Delete obsolete watcher tests. |

---

### Task 1: Pure Naming and Layout Planning

**Files:**

- Create: `extensions/tmux-subagent/tmux.ts`
- Create: `extensions/tmux-subagent/__tests__/tmux.test.ts`

**Interfaces:**

- Produces helpers for slugging session topics, shortening project paths, deriving window names, and assigning ordered panes to balanced columns.
- Later tasks use these helpers without duplicating naming or geometry logic.

- [ ] Add failing tests covering explicit session names, first-user-prompt fallback, punctuation/Unicode normalization, home-relative path shortening, bounded tmux-safe names, and unnamed-session fallback.
- [ ] Add failing layout tests for one through sixteen panes. Assert two panes are side-by-side, three panes form a two-row first column plus one-pane second column, and larger counts remain balanced by at most one row.
- [ ] Run only the new tmux tests and confirm they fail because the module does not exist.
- [ ] Implement the minimal pure naming and layout-planning helpers.
- [ ] Re-run the new test file and confirm all pure-helper tests pass.
- [ ] Commit the task as `feat: add tmux window naming and layout planning`.

---

### Task 2: Shared Session and Window Lifecycle

**Files:**

- Modify: `extensions/tmux-subagent/tmux.ts`
- Modify: `extensions/tmux-subagent/__tests__/tmux.test.ts`

**Interfaces:**

- Consumes the naming helpers from Task 1 and an injectable command executor.
- Produces shared-session creation, tmux mutation locking, metadata-based parent-window lookup, rename, and close operations.

- [ ] Add failing tests for creating `pi-subagents`, tolerating a simultaneous creator, and always releasing the `pi-subagents-mutation` lock after success or failure.
- [ ] Add failing tests proving parent windows are found by stored Pi session ID even when names collide.
- [ ] Add failing tests for owner PID and normalized-path metadata, `remain-on-exit`, automatic-name suppression, same-session resume, metadata-preserving rename, parent-only close, and recreation after manual session/window deletion.
- [ ] Run the focused tmux tests and confirm the lifecycle cases fail.
- [ ] Implement the shared-session and parent-window lifecycle operations using tmux metadata and `wait-for` locking.
- [ ] Re-run the focused tests and confirm they pass.
- [ ] Commit the task as `feat: manage shared tmux parent windows`.

---

### Task 3: Pane Launch, Rollover, Layout, and Rollback

**Files:**

- Modify: `extensions/tmux-subagent/tmux.ts`
- Modify: `extensions/tmux-subagent/__tests__/tmux.test.ts`

**Interfaces:**

- Consumes prepared pane specifications containing run ID, task ID, agent, command, working directory, transcript path, and creation order.
- Produces a batch launch result containing shared session name, parent window ID/name, new pane IDs, and any non-fatal layout warning.
- Produces batch-local cancellation for supervisory failures.

- [ ] Add failing tests for first-batch window creation and one pane per task.
- [ ] Add failing tests showing a later batch removes dead panes, preserves live panes, and adds new panes without affecting another parent window.
- [ ] Add the all-dead rollover test: create a replacement anchor before removing the final dead pane so the parent window survives.
- [ ] Add concurrent-batch tests showing lock serialization and coexistence of live panes from both calls.
- [ ] Add deterministic reflow tests for side-by-side and balanced column-first layouts, preserving pane creation order.
- [ ] Add failure tests for partial pane creation rollback, layout-command fallback, bootstrap-window cleanup, guaranteed lock release, and shell-safe task/run paths.
- [ ] Run the focused tmux tests and confirm the orchestration cases fail.
- [ ] Implement pane metadata, dead/live classification, safe rollover, staging-assisted reflow, batch-local rollback, and a tiled fallback when custom layout fails.
- [ ] Re-run the focused tests and confirm all orchestration cases pass.
- [ ] Commit the task as `feat: orchestrate shared tmux subagent panes`.

---

### Task 4: Private Human-Readable Transcripts

**Files:**

- Modify: `extensions/tmux-subagent/runner.mjs`
- Modify: `extensions/tmux-subagent/runner.d.mts`
- Modify: `extensions/tmux-subagent/__tests__/runner.test.ts`

**Interfaces:**

- Consumes a transcript path from each runner request.
- Mirrors the pane’s human-readable assistant text, tool markers, stderr, and terminal summary while retaining JSONL/status output for machine consumption.

- [ ] Extend runner fixtures with a transcript path and add failing tests for mirrored assistant text, tool markers, stderr, and completion summaries.
- [ ] Add failing tests for append behavior, `0600` creation mode, stream closure, and transcript-write errors not crashing the child task.
- [ ] Run the runner test file and confirm transcript assertions fail.
- [ ] Implement best-effort transcript creation and mirrored writes without changing status or JSONL semantics.
- [ ] Update declarations only where runner exports changed.
- [ ] Re-run runner tests and confirm they pass.
- [ ] Commit the task as `feat: preserve subagent pane transcripts`.

---

### Task 5: Integrate Shared tmux Orchestration with `run_subagents`

**Files:**

- Modify: `extensions/tmux-subagent/index.ts`
- Modify: `extensions/tmux-subagent/__tests__/index.test.ts`

**Interfaces:**

- Consumes the tmux launch/cancel/lifecycle API from Tasks 1–3 and transcript paths from Task 4.
- Returns existing task results plus shared session, parent window ID/name, attach command, transcript directory, artifact path, and optional layout warning.

- [ ] Add failing tests proving parent identity comes from `SessionManager.getSessionId()` and `run_subagents` launches through `pi-subagents` rather than creating per-batch sessions or per-agent windows.
- [ ] Add failing tests for an attach command selecting the immutable parent window ID and for progress/details fields retaining compatibility fields such as `session`, `attachCommand`, `artifactsPath`, and `results`.
- [ ] Add failing tests verifying the `/tmp/pi-subagent-transcripts/<parent>/<run>/<task>.log` hierarchy uses `0700` directories and `0600` files, request files carry transcript paths, and artifact cleanup still follows `never`, `on_failure`, and `always` exactly as before.
- [ ] Add failing cancellation tests proving aborts and supervisor timeouts kill only panes launched by that tool call.
- [ ] Add failing lifecycle tests: `session_info_changed` renames the metadata-matched window, and `session_shutdown` closes only that parent’s window so active child process groups terminate without affecting other parents.
- [ ] Run the index tests and confirm the integration cases fail.
- [ ] Replace per-batch tmux session creation/cleanup with shared-window launch and batch-local cancellation.
- [ ] Register rename/shutdown handlers, derive names from current Pi context, and keep lifecycle errors non-fatal to the parent session.
- [ ] Update progress and result rendering with session/window/attach/transcript information.
- [ ] Re-run index, tmux, and runner tests together and confirm they pass.
- [ ] Commit the task as `feat: integrate shared tmux subagent session`.

---

### Task 6: Remove `watch-subagents` and Verify the Feature

**Files:**

- Delete: `tools/watch-subagents`
- Delete: `tools/watch-subagents.mjs`
- Delete: `tools/watch-subagents.d.mts`
- Delete: `tests/watch-subagents.test.ts`
- Modify: `AGENTS.md`
- Preserve unchanged: `docs/superpowers/specs/2026-08-07-watch-subagents-design.md`
- Preserve unchanged: `docs/superpowers/plans/2026-08-07-watch-subagents.md`

**Interfaces:**

- Removes the obsolete standalone dashboard surface without altering the historical record.

- [ ] Delete the watcher runtime, declaration, shim, and tests; remove only the `watch-subagents` section from `AGENTS.md`.
- [ ] Search outside historical design/plan documents and confirm no live watcher references remain.
- [ ] Run `npx vitest run` and confirm the full suite passes.
- [ ] Run LSP diagnostics on the modified TypeScript files and resolve all new errors.
- [ ] Run `git diff --check` and confirm no whitespace errors.
- [ ] Perform the complete manual verification from the design: two parent sessions, side-by-side first batch, concurrent additions, retained completed panes, dead-pane rollover, rename propagation, all three artifact policies, readable post-shutdown transcripts, parent-only cleanup, and no unrelated tmux changes after the final parent exits.
- [ ] Confirm the unrelated existing change in `skills/org2pdf/scripts/org2pdf.sh` is not staged.
- [ ] Commit only cleanup and related documentation as `chore: remove watch-subagents tooling`.
