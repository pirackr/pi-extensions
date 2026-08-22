# `subagent` extension rewrite — design

## Status

Approved design. This specification supersedes
`2026-08-22-background-run-subagents-design.md`.

Implementation remains gated on a separate implementation plan and its review.

## Goal

Build a new `extensions/subagent/` implementation that preserves the useful
live tmux UI from `tmux-subagent` while matching the public behavior of
[`tintinweb/pi-subagents`](https://github.com/tintinweb/pi-subagents) as closely
as is practical for independent Pi processes.

The new extension will provide:

- A compact, flat `Agent` tool with background execution by default
- One full tmux window per running child
- Four-character parent and child identifiers
- Durable queue, status, result, transcript, and notification state under
  `/tmp`
- Completion notifications with grouped previews
- On-demand full-result retrieval
- Explicit cancellation through `stop_subagent`
- Parent restart/reload recovery
- Existing-style widget, footer, and compact tool rendering
- Layered packaged, user, and trusted-project configuration

This is a clean replacement, not an in-place refactor. The existing
`tmux-subagent` remains available while the replacement is tested and is
removed only after cutover acceptance passes.

## Non-goals

The first stable version does not include:

- Mid-run steering
- Agent resume
- Scheduling or cron
- Per-call model, thinking, tool, timeout, or access overrides
- Inherited parent conversation context
- Worktree isolation management
- Background nested delegation
- A persistent supervisor daemon
- Extension-managed artifact expiry
- Home Manager changes that launch the parent Pi inside tmux

Home Manager integration is a follow-up. The extension nevertheless works
before that integration by ensuring its required tmux session exists.

## Terminology

- **Parent ID** — four-character ID belonging to one parent Pi process, for
  example `a7k2`
- **Agent ID** — four-character ID belonging to one child, for example `q9xm`
- **Parent tmux session** — `pi-<parent-id>`, for example `pi-a7k2`
- **Agent window** — `subagent-<agent-id>`, for example `subagent-q9xm`
- **Origin conversation** — immutable Pi conversation/session UUID from which
  the `Agent` call was made
- **Manager** — the connected parent extension instance that owns queue
  admission, UI, and notifications
- **Runner** — the standalone Node process in an agent window that owns the
  child Pi RPC process and terminal result capture

## Architecture

### Tmux topology

Each parent uses one tmux session:

```text
pi-a7k2
├── main
├── subagent-q9xm
├── subagent-4vnr
└── subagent-k2pd
```

`main` is the parent Pi window after the future Home Manager integration. When
the parent was not launched inside the expected session, the extension creates
`pi-<parent-id>` detached with a keeper window named `main`. The extension only
requires that all of its children go into this session; it does not attempt to
move an already-running parent process into tmux.

Each child owns a full window, not a pane. Windows are created detached and
never steal focus. They show a readable, read-only event stream from Pi RPC.
Direct typing into child windows is unsupported; lifecycle control stays with
the parent tools.

The window uses normal close-on-process-exit behavior. The runner writes and
flushes terminal state before exiting, after which tmux closes the window
automatically.

### Parent ID resolution

Resolution order:

1. If the current tmux session matches `pi-[a-z0-9]{4}`, use its suffix.
2. Otherwise, use a valid `PI_SESSION_ID` value.
3. Otherwise, allocate a new collision-checked ID and set
   `process.env.PI_SESSION_ID`.
4. Ensure tmux session `pi-<id>` exists.

The environment value survives `/reload` within the same process. The future
launcher will create and export the ID before starting Pi.

IDs use cryptographic random bytes mapped to lowercase `a-z0-9`. Allocation
checks both tmux targets and durable artifact paths. Creation retries are
bounded and fail with a clear error if the namespace cannot be allocated.

### Process ownership

The connected parent manager owns:

- Queue admission and concurrency slots
- Starting agent windows
- Live status polling and recovery reconciliation
- Parent widget and footer
- Completion grouping and delivery
- `/agents` management UI

The runner owns:

- Starting Pi in RPC mode
- Child process-group termination
- Timeout enforcement
- Status, event, transcript, stderr, and result writes
- Final usage collection
- Closing its window by exiting after terminal capture

The parent does not own runner lifetime. Parent shutdown never kills running
children.

There is no persistent supervisor daemon. If the parent is absent, running
agents finish independently while queued agents remain queued. Queue dispatch
resumes when a manager reconnects.

## Public API

### `Agent`

```ts
Agent({
  description: string,
  prompt: string,
  subagent_type: string,
  run_in_background?: boolean,
})
```

- `description` is a short UI label and must not contain the entire prompt.
- `prompt` is the complete task contract.
- `subagent_type` selects a configured profile.
- `run_in_background` defaults to `true`.

Every call creates exactly one child. Parallelism comes from multiple `Agent`
tool calls in the same assistant message.

A background call returns after durable enqueue, and after runner startup
acknowledgement when admitted immediately. It includes:

- Agent ID
- `queued`, `starting`, or `running` state
- Parent tmux session
- Agent window when created
- Attach command
- Artifact directory

A foreground call uses the same durable queue and runner but waits
interruptibly for terminal state. It returns the complete final output inline,
marks the result consumed, and does not emit a completion notification.

`maxConcurrent` applies to both foreground and background tasks. `starting` and
`running` tasks consume slots.

### `get_subagent_result`

```ts
get_subagent_result({
  agent_id: string,
  wait?: boolean,
})
```

`wait` defaults to `false`.

- Queued/running with `wait: false` — return state, activity, elapsed time,
  usage, tmux target, and artifact path.
- Queued/running with `wait: true` — wait interruptibly until terminal.
- Terminal — return the complete captured result and usage, then atomically
  mark delivery consumed.
- Unknown ID — return a structured not-found result scoped to the current
  parent registry.

Retrieval reads durable normalized `result.json`; it never depends on a
transient status file or retained in-memory record.

### `stop_subagent`

```ts
stop_subagent({ agent_id: string })
```

- Queued — atomically transition to `cancelled` without creating a window.
- Running — write an atomic cancellation request for the runner.
- Terminal — return the existing state idempotently.
- Parent task with active descendants — recursively cancel descendants first.

The runner sends `SIGTERM` to the Pi process group, escalates to `SIGKILL` after
a grace period, captures available output, and finalizes `cancelled`.

### `/agents`

The interactive command lists queued, running, and completed tasks, grouped by
state and shown hierarchically when nested delegation was used.

Actions:

- Select/attach a running agent window
- Stop a queued or running task
- Retrieve a completed result
- Display or copy the artifact path
- Refresh durable state

## Inline rendering

Canonical compact rendering:

```text
▸ worker (do abc xyz)
  ⎿ Running as subagent-a1b2…
```

When capacity is full:

```text
▸ worker (do abc xyz)
  ⎿ Queued as subagent-a1b2…
```

Foreground completion:

```text
▸ worker (do abc xyz)
  ⎿ Done
```

Expanded background details:

```text
Tmux:      pi-k7m2:subagent-a1b2
Attach:    tmux attach -t pi-k7m2 \; select-window -t subagent-a1b2
Artifacts: /tmp/<project-slug>/pi-k7m2/subagents/a1b2
```

The prompt is never echoed by compact tool rendering.

## Durable storage

### Root layout

The project slug is a sanitized canonical-directory basename plus a short hash
of the canonical path, preventing collisions between projects with the same
basename.

```text
/tmp/<project-slug>/pi-a7k2/
├── parent.json
├── manager.lock
├── registry.lock
├── groups/
│   └── <group-id>.json
└── subagents/
    └── q9xm/
        ├── request.json
        ├── profile.json
        ├── status.json
        ├── result.json
        ├── delivery.json
        ├── events.jsonl
        ├── stderr.log
        ├── transcript.log
        └── control/
```

There is no central `queue.json`. Task manifests with state `queued` are the
durable queue.

Directories use mode `0700`; files use `0600`. Prompts, results, and
transcripts are sensitive. Existing symlinks or unexpected file types are
rejected.

Artifacts remain until the operating system cleans `/tmp`; the extension does
not delete completed artifacts.

### Manifest fields

Every task records at least:

- Schema version and monotonic revision
- Parent ID and agent ID
- Optional `parentAgentId`
- Origin conversation UUID
- Notification group ID
- Description and full prompt
- Resolved profile snapshot
- State and FIFO sequence
- Queued, started, heartbeat, and finished timestamps
- Runner PID and process-start identity
- Tmux session/window target
- Timeout and terminal reason

The resolved profile is snapshotted at enqueue so later config changes do not
mutate queued or running work.

### State machine

```text
queued → starting → running → succeeded
                            → failed
                            → timed_out
                            → cancelled
                            → interrupted
queued → cancelled
```

The runner is the sole writer of normal terminal `status.json` and
`result.json`. Reconciliation may write `interrupted` only after proving that a
nonterminal task has neither a live runner/process nor a live tmux window.

Lifecycle writes use temporary-file-plus-rename in the destination directory.
Append-only logs are flushed before terminal publication. `result.json` is
published before terminal `status.json`, making terminal status the commit
marker.

## Durable FIFO scheduler

No external queue service or queue library is used.

Each enqueued task receives a monotonically increasing sequence under a
short-lived `registry.lock`. Concurrent `Agent` submissions are serialized for
allocation, group membership, and manifest publication; the complete queued
manifest is atomically published before the lock is released.

The connected manager runs an independent asynchronous scheduler loop that:

1. Reconciles `starting` and `running` manifests.
2. Counts occupied top-level ownership trees. A tree is occupied when any task
   in it is `starting` or `running`; nested descendants do not add another
   global slot.
3. Selects the lowest-sequence eligible queued task.
4. Atomically claims it as `starting`.
5. Loads the immutable profile snapshot captured at enqueue and creates its
   window.
6. Repeats until `maxConcurrent` is reached.

The scheduler loop is independent of every tool `execute()` call. Foreground
`Agent` and `get_subagent_result({ wait: true })` waits use abort-aware async
file watching or polling and never block the Node event loop. The scheduler
therefore continues to dispatch work while a foreground caller is waiting,
including a nested foreground descendant whose parent holds the ownership-tree
slot.

Strict FIFO applies across foreground and background top-level tasks.
Concurrency is counted by top-level ownership tree rather than by every
process in that tree: a top-level agent acquires one slot, and a nested
foreground descendant runs within that reserved slot while its parent is
waiting. Only one nested descendant per ownership tree may actively run at a
time; additional nested calls queue within the tree. This avoids a
`maxConcurrent: 1` deadlock while ensuring no ownership tree performs more
than one active model run at once.

`manager.lock` is a long-lived lease containing PID, process-start identity,
and random generation token. It prevents two parent Pi processes from pumping
the same queue. `registry.lock` is short-lived and may be used by explicitly
enabled nested producers to enqueue safely.

Both locks use atomic exclusive creation rather than check-then-create. The
owner writes and flushes its identity before performing protected mutations;
contenders retry an incomplete just-created payload. Stale reclamation first
verifies PID plus process-start identity, atomically renames the stale lock to
a unique quarantine name, and then retries exclusive creation. Competing
reclaimers still converge on one winner, and generation checks prevent a stale
owner from mutating state or unlinking a successor's lock.

## Runner lifecycle

The new runner launches Pi in RPC mode with:

- Resolved model and thinking level
- Resolved tool list and child extensions
- Profile system prompt plus task prompt
- Context-file loading setting
- Web lookup/fetch limits
- `PI_SUBAGENT=1`
- Top-level parent ID and current agent ID
- Canonical artifact root

The runner creates a process group, writes `starting`, starts Pi, then writes
`running` only after RPC startup acknowledgement. A background `Agent` call
reports `Running` only after that acknowledgement. Startup failures become
durable failed results rather than phantom running tasks.

RPC events update:

- Assistant text transcript
- Tool names, activity, and compact argument/result summaries
- Turn and tool-use counts
- Usage and cost
- Context-window usage
- Compaction count
- Heartbeat

High-frequency updates are coalesced before atomic status writes.

On settlement, the runner requests authoritative session statistics, captures
the final assistant message, writes result then terminal status, flushes logs,
and exits. On timeout or cancellation it terminates the entire child process
group before publishing terminal state.

If the runner is killed before terminal publication, existing partial logs are
retained and manager reconciliation records `interrupted`.

## Background completion delivery

### Grouping

Background `Agent` calls created during the same parent assistant turn share a
durable group ID. Foreground tasks are excluded. On `turn_start`, the manager
allocates a collision-resistant group token from the origin conversation UUID,
manager generation, event `turnIndex`, and a random nonce. Every background
`Agent` execution in that turn reuses the token until the matching `turn_end`;
the token and membership are persisted with each enqueue. This avoids relying
on an undocumented parent-message ID in tool execution context.

A group becomes eligible when:

- Every background member is terminal, or
- Thirty seconds have elapsed since the first member completed

If the timeout expires, currently terminal members are delivered together.
Later stragglers form a subsequent delivery for the same group.

### Notification format

```xml
<task-notifications>
  <task-notification>
    <task-id>q9xm</task-id>
    <status>succeeded</status>
    <summary>reviewer: Audit authentication</summary>
    <result>Escaped preview…</result>
    <usage>
      <total_tokens>12400</total_tokens>
      <tool_uses>5</tool_uses>
      <duration_ms>4100</duration_ms>
    </usage>
  </task-notification>
</task-notifications>
```

A solo completion receives up to 500 preview characters. Grouped completions
receive up to 300 characters each. All dynamic XML fields are escaped and
truncation is Unicode-safe. Full output requires `get_subagent_result`.

Delivery uses:

```ts
pi.sendMessage(
  {
    customType: "subagent-notification",
    content: notificationXml,
    display: true,
    details: { notificationId, groupId, agentIds },
  },
  { deliverAs: "followUp", triggerTurn: true },
);
```

A dedicated renderer keeps the TUI notification compact while the XML remains
in model context.

### Consumption and crash semantics

`delivery.json` is independent of task artifacts and tracks pending,
dispatching, delivered, and consumed states. `get_subagent_result` atomically
marks a terminal result consumed. Pending group evaluation omits consumed
members; a fully consumed group emits nothing.

The delivery transition is serialized with result consumption. If delivery is
already committed, retrieval cannot retract the message.

To avoid duplicate model turns after a crash, notification delivery is
at-most-once: `dispatching` is persisted before `pi.sendMessage`, and recovery
treats an ambiguous `dispatching` record as already attempted. A crash in that
small interval may lose the notification, but the durable result remains
visible in `/agents` and through direct retrieval.

### Origin conversation binding

Every task records the Pi conversation UUID that created it. A notification is
sent only while that origin conversation is active. `/new` does not inject old
results into the new conversation. Resuming the original conversation makes
its pending deliveries eligible. `/agents` can inspect all tasks belonging to
the parent process regardless of origin conversation.

## Parent lifecycle and modes

### Startup/reload

On `session_start`, the extension:

1. Resolves parent identity and tmux topology.
2. Acquires the manager lease.
3. Loads layered configuration and profiles.
4. Scans durable tasks.
5. Reconciles manifests with tmux and process identity.
6. Restores queued work, widget, and footer.
7. Processes eligible pending deliveries.
8. Pumps the queue.

### Shutdown

On `session_shutdown`, the extension awaits cleanup rather than launching an
untracked async closure. It stops timers, unregisters UI resources, persists
scheduler state, and releases the manager lease. It does not kill runners,
close active agent windows, or delete artifacts.

### Recovery rules

- Terminal result exists — restore it and delivery state.
- Running window/process exists — re-adopt it.
- Nonterminal manifest has no live window/process — record `interrupted`.
- Queued task — retain it and launch only while a manager is connected.
- Completed orphan window — close it only after verifying durable terminal
  result.

### Runtime modes

- **TUI** — tools, widget, footer, `/agents`, and displayed notifications.
- **RPC** — tools and notification semantics without terminal widgets.
- **Print/JSON background** — return ID, tmux target, and artifact path before
  parent exit; child continues. Notification requires a later reconnect with
  the same `PI_SESSION_ID`.
- **Print/JSON foreground** — wait and return result in the same invocation.

## Widget and footer

The widget retains the existing information density while switching from pane
batches to independent windows.

Example row:

```text
● q9xm reviewer (Audit authentication) 2m14s · 5 tools · 12.4k (8%) · reading src/auth.ts
```

It shows queued, starting, running, and recently completed tasks with:

- ID, profile, and short description
- Elapsed time and timeout
- Tool-use count and activity
- Token usage and context percentage
- Terminal state indicator

Completed rows remain dimmed until the next user input. Durable history remains
in `/agents`.

Footer example:

```text
Agents: 2 running · 3 queued · 1 finished
```

Pane-grid layout, pane border strips, and aggregate parent-window renaming are
removed. Their status information is represented by the parent widget and tmux
window list.

## Configuration

### Layers and paths

```text
config/subagent.json
$PI_AGENT_DIR/subagent/config.json
<project>/.pi/subagent/config.json
```

Precedence:

```text
packaged < user < trusted project
```

The project layer participates only when `ctx.isProjectTrusted()` is true and
is re-resolved for each `Agent` call.

### Merge rules

Preserve current semantics:

- `models` — per-key merge
- `toolAccess` — built-in base plus per-key layered merge
- `childExtensions` — highest layer specifying the array replaces lower layers
- `agentDirs` — concatenate packaged, user, then project directories
- Scalars — highest specified value wins
- Profiles — later source replaces an earlier profile with the same name

Malformed paths, profiles, models, tools, or access combinations fail closed.
Paths are expanded and canonicalized relative to the configuration file that
supplied them.

### Settings

Preserved or renamed settings:

- `models`
- `childExtensions`
- `toolAccess`
- `agentDirs`
- `loadContextFiles`
- `defaultTimeoutSeconds`
- `webSearchMaxLookups`
- `webSearchMaxFetches`
- `maxConcurrent` — replaces `maxTasks`, default `10`
- `notificationGroupWaitSeconds` — default `30`
- `soloPreviewCharacters` — default `500`
- `groupPreviewCharacters` — default `300`

`retainArtifacts` is removed because all artifacts remain until OS `/tmp`
cleanup.

## Profiles and extension integration

### Generic profile sources

```text
<package>/subagents/*.md
$PI_AGENT_DIR/subagent/agents/*.md
agentDirs from layered configuration
```

Profiles preserve frontmatter-driven:

- Name and description
- Model alias or concrete model
- Thinking level
- Tools
- Access level
- Timeout
- Markdown body as system prompt

Tool requirements are validated against `toolAccess`. Declared access may not
be weaker than the selected tools require.

### External profile providers

The generic extension must not import research configuration. It exposes a
synchronous `subagent:discover-profiles` event with a caller-owned envelope.
Other extensions append already-resolved profile descriptors with an owner ID.
Discovery runs on session startup and before each `Agent` call, making it
load-order independent and idempotent.

Repeated contributions deduplicate by owner plus profile name. Conflicting
owners for the same reserved profile fail closed unless an explicit precedence
contract exists.

The research extension owns `config/research.json`, user research overrides,
research prompt paths, and role resolution. It contributes every configured
research role as an already-resolved profile through this generic contract.
The subagent extension never reads or interprets research config.

Profile contribution alone does not silently replace research startup and
policy behavior. Before cutover, the research migration must characterize and
map its existing provider negotiation and `ResearchPolicy` contracts: frozen
role whitelisting, resolved model/tool validation, per-role total and
concurrent dispatch ceilings, provider-wide ceilings, timeout and web budgets,
durable reservation/release accounting, retention, and result export. Each
behavior is either preserved at a research-owned integration boundary or
explicitly retired with evidence that it is stale. The generic extension
remains owner-neutral; research-specific configuration and policy logic do not
move into `extensions/subagent/`.

## Explicit nested delegation

Nested delegation is unavailable by default. A child profile may explicitly
list `Agent` in its tools, causing the subagent extension to be loaded for that
child.

Initial nested rules:

- Nested calls must use `run_in_background: false`.
- `run_in_background: true` returns a validation error.
- The nested request is durably enqueued under the same top-level artifact root
  and tmux session.
- Its manifest records `parentAgentId` and its top-level ownership-tree ID.
- The ownership tree retains its existing concurrency slot while the parent
  waits; the nested child executes within that slot.
- Only one nested descendant in an ownership tree may run at once. Additional
  nested calls queue within the tree until the active descendant settles.
- If the top-level manager is absent, the nested request stays queued and its
  foreground caller waits until reconnect, cancellation, or timeout.
- Stopping a parent recursively stops queued/running descendants.
- `/agents` displays the ownership hierarchy.

Nested producers use the short-lived registry lock only; they do not acquire
the top-level manager lease or pump the queue.

## Security boundaries

- Use `execFile`/argument arrays for tmux and process operations; never
  interpolate prompts or paths into shell commands.
- Validate all IDs and derive tmux names only from validated IDs.
- Canonicalize project, extension, and profile paths.
- Reject symlinked or unexpected artifact entries.
- Keep project configuration trust-gated.
- Treat child output as untrusted when constructing notifications.
- Do not expose prompt contents in compact rendering or tmux commands.
- Snapshot profiles before launch.
- Include schema version, generation, revision, heartbeat, PID, and process
  start identity in status records.
- Count `starting` as an occupied concurrency slot.
- Expose `Agent` to a child only when its profile explicitly requests it.

## Error handling

| Case | Behavior |
| --- | --- |
| tmux unavailable | Reject `Agent` before enqueue with setup error |
| Parent tmux session absent | Create detached `pi-xxxx` with `main` keeper |
| Profile unknown | Reject with available profile names/descriptions |
| Queue full | Persist `queued`; no window created |
| Runner startup failure | Durable `failed`; background call reports failure |
| Runner heartbeat stale but process live | Keep running and surface stale warning |
| Runner/window gone without terminal result | Reconcile to `interrupted` |
| Timeout | Runner kills process group, records `timed_out` |
| Stop queued | Record `cancelled` without launch |
| Stop running | Atomic control request, then process-group termination |
| Parent exits | Running survives; queued pauses |
| Notification send throws | Keep durable result; mark attempted under at-most-once policy |
| Result already consumed | Omit from pending notification |
| Nested background requested | Reject with foreground-only message |
| Manager lease already held | Enter observer mode: allow status/result inspection, but reject `Agent` and `stop_subagent` with lock-owner details |

## Testing strategy

### Unit tests

- ID format, cryptographic allocation, and collision retries
- Project slug canonicalization and hash collision resistance
- Config precedence and every merge rule
- Trusted/untrusted project layers
- Profile override and access validation
- External profile discovery idempotence and conflicts
- FIFO ordering and ownership-tree concurrency accounting
- Occupied-slot counting includes both `starting` and `running`
- State-machine transition validation
- Atomic publication ordering
- Exclusive lock acquisition, competing stale takeover, and generation safety
- XML escaping and Unicode-safe preview truncation
- `turn_start` group identity, parallel membership, and 30-second partial flush
- Consumption/delivery serialization
- Compact and expanded rendering

### Integration tests

- Background immediate return for queued and running tasks
- Foreground wait and interrupt cancellation
- `get_subagent_result` running, waiting, terminal, consumed, and unknown states
- `stop_subagent` queued/running/terminal behavior
- Eleven tasks with `maxConcurrent: 10`
- Runner startup failure and timeout
- Parent reload re-adoption
- Parent process absence with child completion
- Pending notification recovery for the origin conversation
- `/new` suppression and `/resume` delivery
- Missing runner/window reconciliation
- Nested foreground enqueue, execution, and recursive cancellation
- Foreground wait while the independent scheduler continues dispatching
- `maxConcurrent: 1` nested ownership-tree deadlock regression
- TUI/RPC/print/JSON behavior
- UI widget/footer lifecycle

### Live tmux acceptance

1. Launch Pi outside tmux and verify `pi-xxxx` creation.
2. Launch inside `pi-xxxx` and verify reuse.
3. Dispatch eleven agents and verify ten windows plus one queued task.
4. Confirm names `subagent-xxxx` and detached window creation.
5. Inspect live event streams and parent widget/footer.
6. Exit the parent; verify runners finish, publish results, and close windows.
7. Restart with the same ID; verify queue and pending notifications recover.
8. Test `/agents`, attach, stop, full result retrieval, and artifact paths.
9. Verify user and trusted-project configuration overrides.
10. Run one explicitly enabled nested foreground agent.
11. Exercise a full research workflow after research migration.

## Migration and cutover

### Phase 1 — isolated implementation

- Add the new extension and runner without changing legacy behavior.
- Port configuration/profile characterization tests first.
- Test the new extension in a controlled process where the legacy tool is not
  exposed to the model.
- Keep `tmux-subagent` available for rollback.

### Phase 2 — integration migration

- Rewrite the subagent skill around `Agent`.
- Move research profile resolution behind the external profile-provider
  contract.
- Replace research startup's `ProviderDescriptor`/`negotiateProvider`
  dependency and characterize every `ResearchPolicy` reservation, limit,
  retention, and export behavior before adapting or retiring it.
- Rewrite research coordinator calls from structured `run_subagents` arrays to
  compact `Agent` calls.
- Port research startup, resume, policy, integration, and live-smoke tests to
  the new boundary before removing `subagent-dispatch`.
- Update package README and configuration documentation.
- Validate usage/budget accounting for foreground research calls.

### Phase 3 — cutover

After automated and live acceptance passes:

- Make `subagent` the default extension.
- Delete `extensions/tmux-subagent`, its runner, configuration, and tests.
- Remove the provider-dispatch façade if no remaining consumer exists.
- Remove or archive obsolete implementation plans/specifications.
- Run the entire repository test suite and final live workflow.

Home Manager tmux-launch integration remains a separate follow-up.

## Approval gate

This document approves architecture only. The next step is a detailed
implementation plan produced with the `writing-plans` workflow. No production
implementation begins until that plan is reviewed and approved.
