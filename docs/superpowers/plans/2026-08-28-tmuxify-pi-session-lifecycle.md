# Tmuxify Pi Session Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Launch the main Pi process and its subagents in one temporary `pi-<id>` tmux session while preserving `tmuxify` as a generic temporary-session launcher.

**Architecture:** Move `tmuxify` from an embedded Home Manager function body into a directly testable Fish function file. The launcher atomically creates either `pi-<id>` or `tmuxify-<id>`, runs the requested command in `main`, and destroys the entire session when that command exits; the existing subagent extension reuses the current `pi-<id>` without production changes.

**Tech Stack:** Fish shell, tmux, Nix/Home Manager, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-28-tmuxify-pi-session-lifecycle-design.md`

## Files

- Create: `/home/pirackr/.config/home-manager/modules/fish/tmuxify.fish` — testable `tmuxify` Fish function and session lifecycle.
- Create: `/home/pirackr/.config/home-manager/tests/tmuxify.fish` — mocked-tmux regression tests for naming, escaping, retries, routing, and cleanup.
- Modify: `/home/pirackr/.config/home-manager/modules/fish.nix` — install the function file and remove the embedded `tmuxify` body.

## Global Constraints

- `tmuxify pi ...` is the only Pi-specific invocation form.
- Pi sessions are named `pi-<id>`; generic sessions are named `tmuxify-<id>`.
- IDs are collision-checked four-character lowercase hexadecimal strings, which satisfy the subagent extension's four-character lowercase alphanumeric ID contract.
- Pi receives `PI_SESSION_ID=<id>` in its environment.
- The requested command runs in a window named `main`.
- The launcher owns tmux creation and cleanup. Pi lifecycle events do not kill tmux sessions.
- When the main command exits, cleanup kills the whole tmux session, including running subagents.
- Cleanup removes only the tmux session. Durable subagent artifacts under `/tmp/<project>/pi-<id>` remain for inspection and normal operating-system cleanup.
- This behavior applies to every command launched through `tmuxify`; generic commands no longer leave an interactive Fish shell behind.
- No prompt, project path, or raw argument is interpolated unescaped.
- Arguments containing whitespace, quotes, semicolons, dollar signs, or glob characters must reach the requested command unchanged.
- Cleanup begins only when the top-level command exits.
- Cleanup does not run for Pi session events while the Pi process remains alive.

---

### Task 1: Generic temporary-session launcher

**Files:**

- Create: `/home/pirackr/.config/home-manager/modules/fish/tmuxify.fish`
- Create: `/home/pirackr/.config/home-manager/tests/tmuxify.fish`
- Modify: `/home/pirackr/.config/home-manager/modules/fish.nix`

**Interfaces:**

- Consumes: Fish function arguments in `$argv`, optional `TMUX`, the `tmux` command, Fish `random`, and Fish `string escape`.
- Produces: `tmuxify <command> [arguments...]`, which creates a collision-free `tmuxify-<four-hex-id>` session with window `main`, routes the client, and destroys the session after the command exits.

- [ ] **Step 1: Write the failing generic lifecycle tests.** Create a self-contained Fish test runner that sources `modules/fish/tmuxify.fish`, replaces `random` with deterministic IDs, replaces `tmux` with a recorder that can return configured statuses, and restores temporary state after each case. Assert that no arguments make no tmux calls; a generic command uses `tmuxify-<four-hex-id>` and window `main`; the generated wrapper preserves individually escaped argv; isolated execution of the captured wrapper cleans up after successful, failing, and missing commands; a missing session during cleanup is accepted; no trailing interactive Fish remains; a duplicate-session creation retries with the next ID; missing tmux and other non-collision creation failures return non-zero with a clear message and no attach; outside tmux uses `attach-session`; inside tmux uses `switch-client`; and attach or switch failure requests cleanup of the new session.

- [ ] **Step 2: Run the new test to verify it fails.** From `/home/pirackr/.config/home-manager`, run `fish tests/tmuxify.fish`; expect a non-zero exit because `modules/fish/tmuxify.fish` does not exist and the current embedded function still uses a check-then-create flow, names the window `pi`, and leaves an interactive Fish process.

- [ ] **Step 3: Implement the minimal generic launcher.** Define `tmuxify` in `modules/fish/tmuxify.fish`; return immediately for empty argv; escape each command argument with Fish before joining the wrapper command; allocate four-character lowercase hexadecimal IDs; use `tmux new-session` itself as the atomic collision check and retry only duplicate-session errors; create window `main`; have the wrapper retain the requested command as its foreground child and run idempotent `tmux kill-session` cleanup after every command status; use `switch-client` when `TMUX` is set and `attach-session` otherwise; and destroy the new session if client routing fails. In `modules/fish.nix`, install this file as `fish/functions/tmuxify.fish` and remove only the embedded `tmuxify` definition, preserving the existing `pi` function and unrelated uncommitted Fish configuration.

- [ ] **Step 4: Verify the generic launcher passes.** Run `fish tests/tmuxify.fish` and expect every generic lifecycle assertion to pass. Then run `home-manager build --flake '/home/pirackr/.config/home-manager#pirackr@framework'` and expect successful Home Manager evaluation with the generated `tmuxify` function present.

- [ ] **Step 5: Commit the generic launcher in the Home Manager repository.** Review `git diff --check` and `git status --short`; use patch staging for `modules/fish.nix` so the staged diff includes only the `tmuxify` extraction and function-file installation, excludes its pre-existing unrelated changes, and includes the two new files. Commit that staged diff with message `feat(fish): make tmuxify sessions temporary`.

### Task 2: Pi naming and subagent session contract

**Files:**

- Modify: `/home/pirackr/.config/home-manager/modules/fish/tmuxify.fish`
- Modify: `/home/pirackr/.config/home-manager/tests/tmuxify.fish`
- Verify unchanged: `/home/pirackr/Working/grinder/pi-extensions/extensions/subagent/identity.ts`
- Verify unchanged: `/home/pirackr/Working/grinder/pi-extensions/extensions/subagent/tmux.ts`
- Verify unchanged: `/home/pirackr/Working/grinder/pi-extensions/extensions/subagent/index.ts`

**Interfaces:**

- Consumes: the generic `tmuxify <command> [arguments...]` interface from Task 1 and the subagent extension contract that recognizes current sessions matching `pi-[a-z0-9]{4}`.
- Produces: exact `tmuxify pi [arguments...]` classification, session `pi-<four-hex-id>`, window `main`, and child environment `PI_SESSION_ID=<same-id>`; all other first arguments retain the generic contract.

- [ ] **Step 1: Write the failing Pi contract tests.** Extend the Fish test runner to assert that exact first argument `pi` selects `pi-<id>`, exports the matching four-character ID only inside the command wrapper, keeps window `main`, and still kills the whole session after Pi exits. Add negative classification cases for `pip`, `/usr/bin/pi`, and an `npx` invocation; add an isolated wrapper-execution case whose fake `pi` records `PI_SESSION_ID` and arguments containing whitespace, quotes, semicolons, dollar signs, and glob characters; assert the recorded values are byte-for-byte unchanged and the fake tmux receives `kill-session` afterward.

- [ ] **Step 2: Run the focused test to verify it fails.** From `/home/pirackr/.config/home-manager`, run `fish tests/tmuxify.fish`; expect the new Pi cases to fail because Task 1 still classifies every command as `tmuxify-<id>` and does not export `PI_SESSION_ID`.

- [ ] **Step 3: Implement exact Pi classification.** In `modules/fish/tmuxify.fish`, branch only when `$argv[1]` equals `pi`; select prefix `pi-` for that branch and `tmuxify-` otherwise; insert a locally exported `PI_SESSION_ID` assignment before the safely escaped Pi invocation; keep ID allocation, `main`, client routing, and unconditional whole-session cleanup shared with the generic path; and do not add any Pi lifecycle cleanup to the extension.

- [ ] **Step 4: Run automated verification.** Run `fish tests/tmuxify.fish` and the Home Manager build from Task 1, expecting both to pass. From `/home/pirackr/Working/grinder/pi-extensions`, run `npm test -- extensions/subagent/__tests__/identity-storage.test.ts extensions/subagent/__tests__/tmux.test.ts extensions/subagent/__tests__/integration.test.ts`; expect the existing current-session preference, sibling-window topology, reload survival, and shutdown behavior to remain green without production extension changes.

- [ ] **Step 5: Exercise installed launcher behavior.** Apply the configuration with `home-manager switch --flake '/home/pirackr/.config/home-manager#pirackr@framework'`; run one successful generic command, one failing generic command, one missing generic command, and one invocation from inside an existing tmux client; after each, verify `tmux list-sessions` contains no matching `tmuxify-<id>`. Start `tmuxify pi`, verify `tmux display-message -p '#S'` reports `pi-<id>` and the initial window is `main`, spawn a subagent and verify its `subagent-<id>` window is a sibling in that same session with no second `pi-<id>` parent session, exercise `/reload` and confirm the session survives, then exit Pi and verify the session and child process disappear while `/tmp/<project>/pi-<id>` remains.

- [ ] **Step 6: Commit the Pi contract in the Home Manager repository.** Review `git diff --check` and the exact staged diff, stage only `modules/fish/tmuxify.fish` and `tests/tmuxify.fish`, then commit with message `feat(fish): share pi tmux session with subagents`.
