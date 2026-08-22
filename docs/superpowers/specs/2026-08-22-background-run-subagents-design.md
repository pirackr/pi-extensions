# Background `run_subagents` — design

> **Superseded:** replaced by
> [`2026-08-22-subagent-extension-rewrite-design.md`](./2026-08-22-subagent-extension-rewrite-design.md).

## Goal

Add a `run_in_background` mode to `run_subagents` that matches the
notification-based pattern of `@tintinweb/pi-subagents`, adapted for
tmux-based child processes. The parent tool call returns immediately,
the child runs in a tmux pane as today, and a `<task-notification>`
delivered via `pi.sendMessage(..., { deliverAs: "followUp" })` informs
the parent model when the child finishes. A companion
`get_subagent_result` tool lets the parent fetch full output on demand.

**Default changes.** `run_in_background` defaults to `true` (breaking
change from the current always-blocking behavior). All existing skills
that call `run_subagents` will be updated to pass
`run_in_background: false` explicitly, preserving their blocking
contract.

## Current behavior

- `run_subagents` takes a `tasks: TaskItem[]` array (enforced to exactly
  1), launches tmux panes, and **blocks** until every status file reaches
  a terminal state. The tool result carries the full rendered output.
- Widget, footer, window-title, and pane-strip surfaces all work during
  the blocking poll loop.
- `session_shutdown` kills the parent window (terminating runner process
  groups).
- No background mode, no notifications, no companion result-fetch tool.

## Reference: how tintinweb/pi-subagents does it

| Concept | tintinweb implementation |
| --- | --- |
| Schema | flat single-task fields on `Agent` tool (no array) |
| Background default | `run_in_background` defaults `true` |
| Immediate return | agent ID only; actual run detached in-process |
| Completion delivery | `pi.sendMessage({ customType: "subagent-notification", content:`<task-notification>…</task-notification>`}, { deliverAs: "followUp", triggerTurn: true })` |
| Result fetching | `get_subagent_result(agent_id)` with optional `wait: true` |
| Consumption guard | `resultConsumed` flag — if the model fetches the result before the notification fires, the notification is suppressed |
| Group join | 30 s debounce window consolidates multiple completions into one notification (within a single batch) |
| Concurrency | configurable limit (default 10) with queueing |

**Key difference:** tintinweb subagents are in-process SDK sessions; our
children are detached pi processes in tmux panes. This changes *how we
detect completion* (poll `status/*.json` vs. `await record.promise`) but
not *how we notify* (`pi.sendMessage` is parent-side, independent of
child creation).

## Design

### 1. Schema changes

Replace the current `tasks: TaskItem[]` array with flat, single-task
top-level fields — matching tintinweb's `Agent` tool shape:

```text
run_subagents(
  agent: "worker" | "scout" | ...,
  objective: "Find all auth files",
  scope?: string[],
  non_goals?: string[],
  constraints?: string[],
  acceptance_criteria?: string[],
  inputs?: string[],
  expected_output?: string,
  cwd?: string,
  result_path?: string,
  webSearchMaxLookups?: number,
  webSearchMaxFetches?: number,
  run_in_background?: boolean,     // DEFAULT: true
  timeout_seconds?: number,
  return_mode?: "full" | "summary",
  retain_artifacts?: "never" | "on_failure" | "always",
)
```

**Removed:** the `tasks` array wrapper and its length checks. Each tool
call is one task; parallelism comes from the model issuing multiple
`run_subagents` calls in the same assistant message (pi executes
same-block tool calls concurrently — identical to tintinweb's pattern).

**New parameter:** `run_in_background: boolean` (default `true`).

### 2. Background mode (default)

**Immediate return.** After launching panes and confirming tmux
setup, return immediately:

```text
Agent launched in background.

  Run ID:    pi-subagent-<pid>-<timestamp>
  Tmux:      pi-subagents:<windowId> (window: <windowName>)
  Attach:    tmux attach -t pi-subagents:<windowId>
  Transcripts: /tmp/pi-subagent-transcripts/<session>/<runId>

A <task-notification> will be delivered when the agent completes.
To check status before then, use get_subagent_result(run_id).
```

The returned payload includes:

- `run_id` — stable handle for `get_subagent_result` (the `runDir`
  basename, e.g. `pi-subagent-12345-abc`)
- `session`, `windowId`, `windowName`, `attachCommand` — tmux identity
  (human-facing, same as today's inline return)
- `transcriptDir` — private transcript location

The details object returned alongside (for the TUI renderers) contains
the same fields so the existing `renderSubagentToolCall` and
`renderSubagentToolResult` functions continue to work.

**Watcher.** After `execute()` returns, a lightweight watcher keeps
running inside the extension for this run:

1. **Poll** `status/<taskId>.json` at 1 s intervals (relaxed from the
   250 ms blocking poll — nobody is waiting on each tick).
2. **Widget/footer/window-title updates** continue by calling the same
   `emitUpdate()` + `ctx.ui.setStatus()` + `renameWindow()` +
   `select-pane -T` code paths on every poll tick — the UI works exactly
   the same as blocking mode, just nobody is blocked on it.
3. **Deadline enforcement.** The same `overallDeadline` logic currently
   inside the blocking loop runs in the watcher: if the deadline is
   exceeded, `cancelPanes()` is called and statuses are set to
   `timed_out`.
4. **Terminal state reached.** When all statuses are terminal:
   a. Build a `<task-notification>` XML string (same format as
      tintinweb — see §5).
   b. Deliver via:

      ```ts
      pi.sendMessage({
        customType: "tmux-subagent-notification",
        content: notificationXml,
      }, {
        deliverAs: "followUp",
        triggerTurn: true,
      });
      ```

   c. Update the widget to show the final ✓/✗ state; move the run from
      `widgetRuns` to `finishedRuns` (same pattern as today's `finally`
      block — the finished-run widget persists until the user's next
      input).
   d. Artifact cleanup follows the `retainArtifacts` policy (same as
      today).

**Cancellation.** If the user cancels (`signal.aborted`), the watcher
calls `cancelPanes()` and removes itself. The `session_shutdown` handler
already kills the parent window — no change needed.

### 3. Foreground mode (`run_in_background: false`)

Identical to today's behavior: the blocking poll loop runs inside
`execute()`, results render inline, tool result carries full output.
The `tasks` array removal means the execute path now always processes
exactly one task (the flattened params), so the loop body simplifies
but does not change semantically.

### 4. `get_subagent_result` companion tool

A new tool registered alongside `run_subagents`:

```text
get_subagent_result(
  run_id: string,       // the run ID returned by the background call
  wait?: boolean,       // block until terminal (default false)
)
```

**Behavior:**

1. Look up the run by `run_id` in an in-memory `Map<string, RunRecord>`
   (populated at launch, cleared after artifact cleanup).
2. If the run is still running/waiting and `wait: true`:
   poll until terminal (same 1 s interval), then proceed.
3. If the run is still running and `wait: false` (default): return
   current status from `status/<taskId>.json` (state, usage, elapsed).
4. If the run is terminal:
   - Read the full result from the status file.
   - Set `resultConsumed = true` on the run record — this suppresses
     the pending notification from the watcher (checked before
     `pi.sendMessage`).
   - Return the full rendered result (same format as today's blocking
     mode return).
5. If the `run_id` is unknown: return `"Run not found — it may have
   been cleaned up."`.

### 5. `<task-notification>` format

Matching tintinweb's XML structure, adapted for tmux-subagent:

```xml
<task-notification>
  <task-id>pi-subagent-12345-abc</task-id>
  <status>succeeded</status>
  <summary>Agent "worker" succeeded</summary>
  <result>Found 5 files related to authentication...</result>
  <usage>
    <total_tokens>12400</total_tokens>
    <tool_uses>3</tool_uses>
    <duration_ms>4100</duration_ms>
  </usage>
</task-notification>
```

The `<result>` carries a **preview only** (~500 chars). Full output
requires `get_subagent_result`. Transcript/artifact paths are included
as plain text after the XML block so the model knows where to look.

### 6. Watcher lifecycle and coordination

```text
┌─────────────┐     launch panes     ┌──────────────┐
│  execute()   │ ──────────────────── │ watcher loop │
│  (blocking   │     return {run_id}  │ (1s poll)    │
│   or instant)│                      └──────┬───────┘
└─────────────┘                             │
                                            │ terminal state
                                            ▼
                                  ┌──────────────────┐
                                  │ pi.sendMessage    │
                                  │ followUp+trigger  │
                                  └────────┬─────────┘
                                           │
                      ┌────────────────────┤
                      │                    │
               ┌──────▼──────┐     ┌──────▼──────┐
               │ notification │     │ widget done  │
               │ delivered    │     │ → finished   │
               └──────────────┘     └─────────────┘
```

**Concurrent calls.** Each `run_subagents` call creates its own
`RunRecord` in the shared `Map`, its own watcher, and its own widget
entry — the existing `widgetRuns` registry supports this (keyed by
`runDir`). Multiple background calls issued in the same block run their
watchers independently. Each emits its own notification.

**Deliberately excluded:** cross-run notification consolidation
(tintinweb's group-join). Each of your runs is one task, so there is
nothing to group *within* a run. Grouping *across* runs requires
cross-watcher coordination that is not worth the complexity until the
notification-interruption pain is felt in practice.

### 7. Shared infrastructure (no changes)

| Component | Status |
| --- | --- |
| Widget (`setWidget`) | Works unchanged — reads `widgetRuns` + `finishedRuns` |
| Footer status (`setStatus`) | Works unchanged — aggregate title updated on poll tick |
| Window title rename | Works unchanged — renamed on state change / ≥5 s |
| Pane border strips | Works unchanged — pushed on poll tick, 1 s throttle |
| `session_shutdown` | Works unchanged — kills parent window, watcher dies with extension |
| Artifact retention | Works unchanged — `retainArtifacts` policy applied at watcher cleanup |
| `return_mode: "summary"` | Works unchanged — `<coordinator-summary>` validation runs before notification |
| `renderSubagentToolCall` | Minor update: remove array traversal (single task) |
| `renderSubagentToolResult` | Minor update: show "Launched in background" instead of "Running…" |

### 8. Breakage: skills and existing callers

Skills that call `run_subagents` were written for the always-blocking
contract. Since the default flips to `true`, these need explicit
`run_in_background: false`:

| File | Change |
| --- | --- |
| `skills/research/SKILL.md` | Add `run_in_background: false` to all `run_subagents` examples |
| `skills/subagent/SKILL.md` | Add `run_in_background: false` to all examples |
| `skills/research/agents/*.md` | No change — these are agent prompts, not tool callers |

**Why not preserve the old default?** The entire point of this change
is background-first. Existing skills are authored by us and trivial to
update. Third-party consumers would break, but this extension has no
external consumers yet.

### 9. Types and internal data structures

**New interface — `RunRecord`:**

```ts
interface RunRecord {
  runId: string;
  taskId: string;
  agent: string;
  description: string;
  status: TaskStatus;
  runDir: string;
  request: RunnerRequest;
  prepared: PreparedTask;
  windowId: string;
  windowName: string;
  session: string;
  resultConsumed: boolean;
  watcherTimer?: ReturnType<typeof setInterval>;
  artifactPath?: string; // null after cleanup
}
```

**New registry:** `Map<string, RunRecord>` (keyed by `runId`).
Populated at launch, entries cleaned up after artifact removal +
notification delivery.

### 10. Testing

| Test | File | What |
| --- | --- | --- |
| Flattened schema validation | `__tests__/index.test.ts` | Confirm single-task params accepted, `tasks` array rejected |
| Immediate return shape | `__tests__/index.test.ts` | Background call returns `{ run_id, session, windowId, ... }` with no blocking |
| Watcher notification | `__tests__/integration.test.ts` | Mock `status/*.json` transitions; assert `pi.sendMessage` called with `<task-notification>` |
| Result consumption | `__tests__/integration.test.ts` | Call `get_subagent_result` before notification; assert notification suppressed |
| `get_subagent_result` wait | `__tests__/integration.test.ts` | `wait: true` blocks until terminal; `wait: false` returns current status |
| Foreground regression | `__tests__/index.test.ts` | `run_in_background: false` produces same blocking behavior as today |
| Unknown run_id | `__tests__/index.test.ts` | `get_subagent_result("no-such-id")` returns error message |
| Cancellation | `__tests__/integration.test.ts` | Abort signal during background run → watcher calls `cancelPanes()` |
| `session_shutdown` during background | `__tests__/integration.test.ts` | No error; watcher cleaned up |
| Widget lifecycle | `__tests__/render.test.ts` | Background run populates `widgetRuns`, terminal moves to `finishedRuns`, dismissed on input |

## Error handling

| Case | Behavior |
| --- | --- |
| `run_in_background: true` (default), tmux launch fails | Same error as today (thrown from `launchBatch`); no watcher created |
| Watcher deadline exceeded | `cancelPanes()`, status → `timed_out`, notification delivered |
| `pi.sendMessage` fails | Best-effort: caught, logged, notification lost (user can still attach to tmux) |
| `get_subagent_result` called for cleaned-up run | "Run not found" message |
| `get_subagent_result` called for still-running with `wait: false` | Returns current status snapshot |
| Concurrent background + foreground in same block | Both work: foreground blocks its tool call, background spawns watcher independently |
| Multiple watchers for same `runDir` | Impossible — `runDir` is unique per `execute()` call |

## Non-goals

- **Cross-run notification consolidation** (group-join) — YAGNI until
  notification interruption is felt in practice.
- **Steering** — follow-up; tmux-based steering (injecting text into
  the child pi session) is orthogonal to background mode.
- **Schema flattening beyond single-task** — we flatten the array but
  do not restructure the parameter names; that is a separate concern.
- **Concurrency limits / queueing** — tmux handles process scheduling;
  no need for a software queue. `maxTasks` config exists for
  validation, not queuing.
- **Notification preview truncation tuning** — 500 chars is a starting
  point; can be tuned after real usage.
