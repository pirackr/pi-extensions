> **ARCHIVED** — Superseded by the durable Agent extension rewrite (2026-08-24). This document is retained for historical reference only.

# Shared tmux subagent session design

## Goal

Make subagent activity directly observable in tmux without a separate dashboard:

- all subagents use one shared tmux session named `pi-subagents`;
- each parent Pi session owns one tmux window;
- all active subagents belonging to that parent appear as panes in its window;
- completed panes remain visible until the parent starts another batch;
- concurrent batches from the same parent coexist;
- pane output remains available briefly after the parent exits through private transcripts under `/tmp`.

The parent Pi TUI is not moved into the shared tmux session. Its window contains only subagent panes.

## Current behavior

Each `run_subagents` call currently creates a private `pi-subagent-*` tmux session containing a control window and one window per task. The extension kills that tmux session when the tool call finishes. The standalone `watch-subagents` TUI discovers per-run directories and assumes each directory maps to its own tmux session.

## Chosen approach

The extension will orchestrate the shared tmux session directly. It will not introduce a daemon or filesystem reconciliation service.

A short-lived `__bootstrap` window creates `pi-subagents` safely when no tmux session exists. It runs the existing control-mode process only until the first parent window has a task pane, then it is removed. There is no permanent control window or control pane.

Shared tmux mutations are serialized with `tmux wait-for -L/-U` using the lock name `pi-subagents-mutation`. Agent execution remains concurrent; only session, window, pane, and layout mutations are serialized.

## Tmux hierarchy and identity

```text
pi-subagents                         shared tmux session
├── w/g/pi-extensions-observability parent Pi session window
│   ├── scout task pane
│   ├── worker task pane
│   └── reviewer task pane
└── w/g/other-project-fix-auth      another parent Pi session window
    ├── tester task pane
    └── reviewer task pane
```

The parent identity is `ctx.sessionManager.getSessionId()`. The extension stores it as tmux window metadata, such as `@pi_parent_session_id`, and discovers windows by that metadata rather than by display name. Duplicate display names are therefore safe.

Additional window metadata records the owning Pi process and normalized project path so stale or resumed windows can be recognized without relying on extension memory.

## Window naming

The display name combines a shortened working-directory path with a topic slug.

For a working directory of:

```text
~/Working/grinder/pi-extensions
```

and a session topic of `Observability`, the window is named:

```text
w/g/pi-extensions-observability
```

Naming rules:

1. Paths below the home directory are made home-relative.
2. Ancestor directory segments are shortened to their first lowercase alphanumeric character.
3. The final directory name remains readable and is slugified.
4. The topic comes from the explicit Pi session name set by `/name`.
5. If no explicit name exists, the topic is deterministically derived from the first user prompt; no extra model call is made.
6. The topic is lowercased, reduced to safe alphanumeric hyphen-separated words, and length-limited.
7. The complete display name is capped for terminal readability by truncating the topic before the path.

A `session_info_changed` handler renames an existing parent window when `/name` changes. Internal ownership remains tied to the immutable Pi session ID.

## Components and boundaries

### `extensions/tmux-subagent/index.ts`

Retains responsibility for:

- tool schema and argument validation;
- profile resolution and task preparation;
- worktree safety checks;
- per-call run-directory and request creation;
- status polling, progress updates, usage aggregation, and final results;
- the existing full-artifact retention policy.

It obtains parent identity from the tool `ExtensionContext` and delegates all tmux mutations to the orchestration module. The existing large `execute` callback should not absorb the new tmux state machine.

### Tmux orchestration module

A focused module under `extensions/tmux-subagent/` owns:

- tmux command execution and target escaping;
- race-tolerant shared-session creation;
- lock acquisition and guaranteed unlock;
- parent-window discovery and creation;
- dead-pane pruning;
- pane creation and pane ID capture;
- pane and window metadata;
- deterministic layout application;
- window rename and shutdown;
- rollback of panes created by a partially failed batch.

The module accepts an injectable tmux command executor so command planning and failure behavior can be tested without a real tmux server.

### `extensions/tmux-subagent/runner.mjs`

Retains responsibility for launching and supervising one child Pi process. It additionally tees the same human-readable text written to its pane into a transcript file. This includes assistant text deltas, summarized tool activity, child stderr, and the final task state.

Raw JSONL output and stderr artifacts remain unchanged.

## Run data and tool details

Each runner request gains a transcript path. The transcript lives separately from the per-call artifact directory so normal artifact cleanup cannot remove it.

The tool details retain the existing fields and add parent-window and transcript information:

- shared session name;
- immutable tmux window ID;
- readable window name;
- attach command that selects that window;
- transient transcript directory;
- existing artifact path when the selected `retain_artifacts` policy keeps it;
- existing task results.

Existing consumers of `session`, `attachCommand`, `artifactsPath`, and `results` remain compatible. `session` now consistently contains `pi-subagents` rather than a unique per-call name.

## Invocation data flow

1. Validate tasks, profiles, timeouts, working directories, and artifact policy as today.
2. Derive the parent Pi session ID, owning process ID, shortened path, and topic slug.
3. Create the per-call run directory and private transcript directory.
4. Write task prompts and runner request files, including transcript paths.
5. Ensure `pi-subagents` exists, creating the transient `__bootstrap` window when necessary. Creation races are treated as reuse when another process wins.
6. Acquire `pi-subagents-mutation` with `tmux wait-for -L`.
7. Find the parent window by `@pi_parent_session_id`. If it does not exist, create it with the first task as its initial pane and set its metadata.
8. For an existing window with at least one live pane, remove its dead panes and split all new task panes from a live anchor.
9. For an existing window whose panes are all dead, first split the first new task from a dead anchor, then remove the old dead panes. This prevents tmux from destroying the window when its last old pane is removed.
10. Create any remaining task panes, recording every new pane ID for rollback.
11. Remove a transient bootstrap window after a parent task pane exists, then apply the deterministic balanced layout.
12. Release the lock with `tmux wait-for -U` in a `finally` path.
13. Poll status files and return results as today.
14. Leave completed panes in place with `remain-on-exit`; do not kill the shared session or parent window when the tool call returns.

Two concurrent `run_subagents` calls from the same parent enter the locked mutation steps sequentially, but all runners execute concurrently after their panes are created. A later caller removes only panes already dead when it acquired the lock, so it cannot cancel or replace a still-running earlier batch.

## Pane lifecycle

- New task panes are configured with `remain-on-exit` so their final screen remains inspectable.
- A new batch removes all dead panes in the parent window while preserving every live pane.
- When every old pane is dead, the extension creates the first new pane before removing the old final pane, keeping the window alive throughout rollover.
- If every previous pane is live, the new batch only adds panes and reflows the layout.
- Completed panes remain until the next batch or parent shutdown.
- A manually killed pane, window, or shared session terminates the affected runner. The runner publishes cancelled or failed status where possible and leaves its transcript intact.
- A missing shared session or parent window is recreated by the next invocation.

## Layout

The layout creates columns first, then splits each column vertically. This preserves the preferred two-pane side-by-side view.

```text
1 pane          2 panes         3 panes         4 panes
┌───────┐       ┌───┬───┐       ┌───┬───┐       ┌───┬───┐
│   1   │       │ 1 │ 2 │       │ 1 │ 3 │       │ 1 │ 3 │
│       │       │   │   │       ├───┤   │       ├───┼───┤
│       │       │   │   │       │ 2 │   │       │ 2 │ 4 │
└───────┘       └───┴───┘       └───┴───┘       └───┴───┘
```

For `n` panes:

- `columns = ceil(sqrt(n))`;
- panes are distributed across columns as evenly as possible;
- earlier columns receive at most one more pane than later columns;
- panes retain creation order from top to bottom, then left to right.

This gives three columns for 5–9 panes and four columns for 10–16 panes. Six panes form a 3×2 grid; nine form 3×3; sixteen form 4×4.

The orchestration module applies this layout after every successful pane addition or removal. If custom layout application fails, it attempts tmux's built-in tiled layout and reports a warning without cancelling otherwise healthy agents.

## Parent session lifecycle

A `session_shutdown` handler kills only the window whose metadata matches the parent Pi session ID. Active runner panes receive terminal shutdown and cancel their child process groups. Other parent windows and the shared session remain untouched. If the removed window was the last one, tmux may remove the now-empty shared session naturally.

A normal resume of the same Pi session reuses its matching window if it still exists. If normal shutdown already removed it, the next run recreates it with the same identity and current display name.

Shutdown cleanup is best-effort. An uncatchable process crash may leave a stale window. A later invocation may reclaim a same-session window or remove a stale window whose recorded owner process is no longer alive; it must never remove a window containing a live owner merely because its display name collides.

## Transcripts and artifacts

### Human-readable transcripts

Transcripts are always written under a private hierarchy similar to:

```text
/tmp/pi-subagent-transcripts/<parent-session-id>/<run-id>/<task-id>.log
```

Directory permissions are `0700`; transcript permissions are `0600`. The extension does not delete these transcripts. They remain available until the operating system's normal `/tmp` cleanup.

Transcripts are intended for quick manual inspection after a tmux window closes. They are not a replacement for raw event artifacts and are not exposed to child agents as context.

### Existing `retain_artifacts` behavior

The existing policy remains unchanged for prompts, task requests, JSONL events, stderr, status, results, and usage:

- `never`: remove full run artifacts after every run;
- `on_failure`: retain full artifacts only when a task fails;
- `always`: retain full artifacts for every run.

The separate transcript survives regardless of this policy.

## Failure handling

- If tmux is unavailable, validation fails before task launch as today.
- Shared-session creation treats a duplicate-session error as a recoverable race and rechecks the session.
- Lock release runs in `finally`, including command and layout failures.
- If pane creation fails partway through a batch, the extension kills only pane IDs created by that batch, preserves pre-existing live panes, reapplies layout, and reports the failure.
- If fallback layout also fails, agents continue when their panes were created successfully; progress includes a layout warning.
- Run and transcript paths are shell-quoted and never interpolated into untrusted shell source without escaping.
- Parent-window cleanup always targets immutable tmux metadata or captured window IDs, never a possibly duplicated display name.

## Removing `watch-subagents`

The shared tmux hierarchy replaces the standalone dashboard. Remove:

- `tools/watch-subagents`;
- `tools/watch-subagents.mjs`;
- `tools/watch-subagents.d.mts`;
- `tests/watch-subagents.test.ts`;
- the `watch-subagents` guidance section in `AGENTS.md`.

Keep the committed historical design and implementation-plan documents as project history. Any remaining current-facing command references found during implementation should be removed or rewritten, while historical documents remain untouched.

## Testing

### Automated tests

Add focused tests for:

- parent identity based on `SessionManager.getSessionId()`;
- path shortening, explicit-name slugging, first-prompt fallback, sanitization, and length limits;
- race-tolerant shared-session creation;
- lock acquisition and guaranteed release;
- parent-window discovery by metadata rather than display name;
- dead-pane removal while live panes survive;
- all-dead rollover creates a new anchor before removing the old final pane;
- concurrent batches adding panes to the same window;
- deterministic layouts for 1–16 panes;
- rollback after partial pane creation;
- fallback when custom layout fails;
- `/name`-driven window rename;
- parent shutdown targeting only its own window;
- transcript content and `0600` permissions;
- transcript survival independent of `retain_artifacts`;
- unchanged full-artifact retention behavior;
- updated progress and result details for the shared session/window.

Tmux command tests use an injected fake executor. Runner tests use temporary files and mocked child streams. The complete Vitest suite must remain green after deleting the obsolete dashboard tests.

### Manual verification

1. Start two parent Pi sessions and run subagents from each.
2. Confirm `tmux attach -t pi-subagents` shows two parent windows with readable names.
3. Confirm two tasks begin side by side.
4. Start another batch from the first parent while earlier tasks run; verify live panes remain and new panes are added.
5. Allow panes to finish; verify their final output remains visible.
6. Start another batch; verify dead panes disappear, live panes survive, and layout rebalances.
7. Rename a parent with `/name`; verify only its tmux window is renamed.
8. Exit one parent; verify its window closes while the other remains.
9. Inspect that parent's transcript files under `/tmp` after shutdown.
10. Exercise `never`, `on_failure`, and `always` to confirm only full artifacts follow those policies.
11. Exit the final parent and confirm no unrelated tmux sessions or windows are affected.

## Out of scope

- Moving the parent Pi TUI into the shared tmux window.
- A background daemon or long-lived reconciliation service.
- A replacement dashboard for `watch-subagents`.
- Automatic transcript pruning beyond normal operating-system `/tmp` cleanup.
- Cross-host or remote tmux coordination.
