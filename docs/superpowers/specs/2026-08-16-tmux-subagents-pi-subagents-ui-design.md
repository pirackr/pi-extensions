# pi-subagents-style UI for tmux subagents — design

## Goal

Bring the live agent UI of `@gotgenes/pi-subagents` (widget above the editor,
per-agent status rows, completion notifications) to the `tmux-subagent`
extension, plus the tmux-native live surfaces that extension is uniquely able
to provide (parent-window title, per-pane status strips).

Status surfaces after this change, from closest to farthest:

| Surface | Where | Content |
| --- | --- | --- |
| Footer status | pi footer (`setStatus`) | one compact glance line: `⣷ worker+scout · 1/2 done · 1m20s` |
| Widget | above pi editor (`setWidget`) | per-agent rows: spinner/icon, agent, objective, `↻N`, `⚙ N tools`, tokens `(NN%)`, elapsed, activity |
| Inline progress | tool `onUpdate` stream | same rows as widget + tmux attach info (what the parent model sees) |
| Completion notification | pi UI (`notify`) | one notification per terminal task, using the same icon/stats/result preview renderer |
| Results | tool return content | notification-style headers; `<coordinator-summary>` envelope unchanged |
| Window title | tmux status bar | `⣷ worker+scout · 1/2 done · 1m20s`, restored to topic name at end |
| Pane strips | tmux pane border | `⠹ worker · ↻3 · ⚙ 5 tools` per task pane |

## Current behavior

- Children run as `pi --mode json -p`; `runner.mjs` parses the JSON event
  stream to render pane output, accumulate usage, and extract the final
  result. `--mode json -p` is one-shot: task markdown is piped on stdin, the
  process exits, completion is detected from child close.
- `status/<task>.json` carries `state, pid, startedAt, finishedAt, stopReason,
  errorMessage, result, usage {input, output, cacheRead, cacheWrite,
  totalTokens, cost, turns}`.
- Parent polls status files every 250 ms; `emitUpdate()` sends plain-text
  `renderProgress`; results render as plain `renderResults` /
  `renderSummaryResults` blocks.
- No `ctx.ui` usage at all (widget/status/footer untouched).
- The standalone `watch-subagents` dashboard (spec + tool, Aug 2026) was
  removed and its design is now marked **deprecated**; observability is the
  shared tmux session (one parent window per Pi session, one pane per task)
  plus runner transcripts under
  `/tmp/pi-subagent-transcripts`.

## Reference UI (pi-subagents) and agreed deviations

Reference status row:

```text
⠹ Agent  Refactor auth module · ↻5≤30 · 5 tool uses · 33.8k token (62%) · 12.3s
   ⎿  editing 2 files…
```

Agreed format for tmux subagents (turns stay `↻N`; **tools become `⚙ N tools`**
instead of `5 tool uses`; no max-turns segment — there is no per-task turn cap):

```text
⠹ worker · Find auth files · ↻3 · ⚙ 5 tools · 12.4k token (8%) · 12.3s
  ⎿ searching…
```

- Icons: animated braille spinner (running/starting), `✓` (succeeded),
  `✗` (failed/timed_out), `■` (cancelled).
- `(NN%)` is context utilization — omitted when `contextWindow` is unknown.
- Activity line `⎿ …` shows the most recent tool summary (`searching…`,
  `editing 2 files…`), truncated to ~60 chars.
- Glyphs are named constants in `render.ts` (`TURN_GLYPH = "↻"`,
  `TOOL_GLYPH = "⚙"`), so swapping is a one-line change. No emoji (font
  reliability in terminal widgets).

## Decisions (from discussion)

- **Runner protocol json → rpc** (`--mode rpc`): strict superset of json mode
  with identical JSONL framing. Gains precise completion (`agent_settled`),
  `model.contextWindow` (`get_state`), authoritative context usage
  (`get_session_stats`), and a clean EOF-based exit. Verified live against
  this pi build (handshake, events, settle, stats, exit 0).
- **Tmux-native surfaces included** (option B): live parent-window title +
  per-pane border strips, in addition to the pi-side widget. Honest
  adaptation of "live UI" to a tmux-based runner.
- **TUI mode for children rejected**: no machine-readable output, no
  completion signal (idles at the prompt), logging/artifacts degrade to ANSI
  soup, and it cannot compose with the blocking tool model.
- **Footer status line added** (`ctx.ui.setStatus("tmux-subagents", …)`):
  compact glance line, cleared when the last run finishes. Works in TUI and
  RPC modes (fire-and-forget `extension_ui_request`).
- **Steering out of scope**: rpc mode *enables* a `steer`-based tool, but the
  parent blocks during a run; a steering tool is a follow-up, not part of this
  change.
- **Compaction `⇊N` annotation included** (cheap, faithful to the reference).

## Architecture

### 1. Runner protocol (`runner.mjs`)

Replace `--mode json -p` with `--mode rpc`; drive the JSON-RPC protocol over
stdin (LF-delimited JSONL, same framing the parser already handles).

- **Startup**: after spawn, send `{"type":"get_state","id":"st1"}`; parse the
  response for `data.model.contextWindow` (may be null → `(NN%)` omitted).
- **Task delivery**: read `request.taskPath` and send
  `{"type":"prompt","message":<task text>}`. stdin stays **open** (do not
  end it — rpc mode reads commands until EOF).
- **Completion**: on `agent_settled`, send `get_session_stats` (id-correlated).
  On its response, write one last `running` status with authoritative
  `contextUsage` and call `child.stdin.end()`. The stats wait is bounded by a
  ~3 s fallback timer: on expiry, write the last running status with live
  `contextUsage` and end stdin anyway. The child `close` handler remains the
  sole terminal-status writer, preserving the authoritative exit code and
  preventing a late non-zero exit from being masked.
- **Safety net**: if `agent_settled` never arrives, existing timeout → kill
  process group fallback is unchanged. If the `prompt` response is
  `success:false`, set `errorMessage` and terminate.
- Event parsing (`processEvent`) unchanged for `message_update` /
  `tool_execution_start` / `tool_execution_end` / `message_end` — RPC emits
  the same shapes. New: `response` handling, `compaction_end` counting,
  `agent_settled`.
- **Pane header line**: emit `━━━ <agent> · <taskId> · <model> ━━━` once at
  task start (goes to pane + transcript) so a pane is identifiable at a
  glance without the border strip.

### 2. Status data (`status/<task>.json`) — new live fields

Written by `runner.mjs` (atomic tmp+rename, unchanged pattern):

| Field | Written on | Purpose |
| --- | --- | --- |
| `tools` (number) | every `tool_execution_start` | cumulative tool-execution count |
| `activity` (string) | every `tool_execution_start` | short current-tool summary (`searching…`) |
| `contextUsage` `{tokens, contextWindow, percent}` | every `message_end` + final | live + authoritative `(NN%)` |
| `compactionCount` (number) | every `compaction_end` | `⇊N` annotation |

All optional and additive — existing consumers (`readStatus`, any file-based
reader) are unaffected. Aggregate `usage` remains the billing/result total,
but live context utilization is computed from the latest valid assistant
message's `usage.totalTokens`, never the aggregate sum. On `compaction_end`,
live `tokens` and `percent` become null until a post-compaction assistant
message supplies valid usage. The final running status uses
`get_session_stats`'s authoritative `contextUsage` when available.

### 3. Pure renderers (`render.ts`)

Kept pi-import-free and unit-testable (same pattern as the current file).
New exports:

- `SPINNER_FRAMES`, `TURN_GLYPH`, `TOOL_GLYPH` — named glyph constants.
- `statusIcon(state, frame)` — icon per state.
- `formatTokens(n)` — `812 tok` / `12.4k tok` / `1.2M tok`.
- `formatElapsed(startedAt, finishedAt?)` — `812ms` / `12.3s` / `2m17s`;
  empty when `startedAt` missing.
- `renderStatsRow(task)` — `↻3 · ⚙ 5 tools · 12.4k token (8%) · 12.3s`
  (singular `⚙ 1 tool`; `(NN%)` only when percent is known).
- `renderTaskRow(task, {frame, theme?})` — icon + `agent · objective` +
  stats, then `⎿ activity` line. `theme` optional (identity when absent) so
  plain-text and colored rendering share one implementation.
- `renderWidgetLines(runs, {frame, theme?, width})` — header `● Subagents
  (tmux)`, task rows, footer `2 running · 1 done`, multi-run grouping, an exact
  12-line cap, and ANSI-safe truncation so no visible line exceeds `width`.
- `renderWindowTitle(runs)` — aggregate all active runs in the parent window:
  `⣷ worker+scout · 1/2 done · 1m20s`; terminal icon is `✓` only when every
  task succeeded, `✗` when any failed/timed out, and `■` for cancellations
  when there are no failures.
- `renderPaneTitle(task, {frame})` — short `⠹ worker · ↻3 · ⚙ 5 tools`.
- `renderNotification(task)` — completion box: `✓ worker · Find auth files
  completed` + stats + `⎿` preview (result or errorMessage, ~120 chars).
- `renderSectionHeading(status)` — `=== ✓ worker · task-1 · succeeded — 3
  turns · 12.4k token ===`.
- `toWidgetTask(status)` — adapter from status/`RenderStatus` shapes.

Color mapping (via `theme.fg`): spinner/header accent, `✓` success, `✗` error,
`■` dim; `(NN%)` <70 dim, 70–85 warning, ≥85 error; footer/`└` muted.

`renderSummaryResults` keeps its `<coordinator-summary>` envelope untouched
(parseable contract for research loops) and gains the notification header per
section. `renderResults` (full mode) restyles only the heading; full output
and prompt echo are unchanged.

### 4. Extension wiring (`index.ts`)

- **Module registry** `widgetRuns: Map<runId, WidgetRun>` — supports concurrent
  `run_subagents` calls in one session and is the aggregate source for the
  widget, footer, and parent-window title.
- **Widget** (`ctx.ui.setWidget("tmux-subagents", (tui, theme) => component)`)
  only when `ctx.mode === "tui"`. Factory: 120 ms `setInterval` advancing a
  frame and calling `tui.requestRender()` (pattern used by pi's own animated
  components; verified against `interactive-mode.js`); `render()` reads
  `widgetRuns` + frame; `dispose()` clears the timer. Widget cleared when the
  registry empties (run `finally`).
- **Footer status**: `ctx.ui.setStatus("tmux-subagents", …)` renders one
  aggregate title across all registry runs on state transitions; cleared only
  when the registry empties. Not TUI-gated (works in RPC mode).
- **Inline progress and notifications**: `renderProgress` is upgraded to the
  row format + attach info. Each run tracks notified task ids; the first
  observed terminal transition emits `renderNotification(task)` exactly once
  through guarded `ctx.ui.notify` (`info` for success/cancel, `error` for
  failed/timed_out).
- **Window title**: on aggregate state-count change, or ≥5 s since last
  rename: `renameWindow(tmuxExec, windowId,
  renderWindowTitle([...widgetRuns.values()]))`. Cleanup lives in `finally`:
  after deleting this run, render the remaining aggregate when other runs are
  active; restore only when the registry empties by recomputing
  `buildWindowName(cwd, {homedir, topic: getSessionName(), firstPrompt})`.
- **Pane strips**: after `launchBatch`, on the run's own window only:
  `set-window-option pane-border-status top` + `pane-border-format
  "#{pane_title}"`; compare each pane's newly rendered title with its previous
  value and push changes at most once per second per pane.
  All tmux calls best-effort (try/catch — a tmux failure must never fail the
  tool).
- `TaskStatus` interface gains optional `tools`, `activity`, `contextUsage`,
  `compactionCount`.

### 5. Types, tests, verification

- `types/pi-coding-agent.d.ts`: add the `setWidget` overloads (string[] and
  `(tui, theme) => Component`), minimal `Theme` (`fg(color, text)`),
  `Component` (`render`, `invalidate`, `dispose?`), `ExtensionWidgetOptions`
  (`placement`). The stub is what this repo compiles against.
- Tests (`tests/tmux-ui-render.test.ts`, vitest, pure — no pi mock needed):
  icon per state; token/elapsed formatting edges (0, 999, 1.2M; ms/s/m+s;
  missing start); stats row incl. singular tool and `(NN%)` omission; task
  row with/without activity; widget lines (header, footer counts, multi-run,
  exact line cap, ANSI-safe widths 20/80); aggregate window title
  (running/all-succeeded/failed/cancelled/elapsed); pane title;
  notification (completed/failed/stopped, preview truncation); section
  heading. Summary-mode rendering keeps the envelope.
- Verification: `npx tsc`, `npx vitest run`, `smoke-load.ts`, then one real
  end-to-end `run_subagents` (2 tasks, mixed agents) exercising the RPC
  path, widget, footer, window title, and pane strips; confirm restored
  window name and cleared widget after completion.

## Data flow

```text
runner.mjs (rpc child)                 parent (index.ts)              surfaces
────────────────────                   ─────────────────             ─────────
get_state → contextWindow               poll status/*.json            widget rows
tool_execution_start → tools/activity   every 250 ms                  footer status
message_end → usage/contextUsage                                     window title
compaction_end → compactionCount        renderWidgetLines/renderStats pane strips
agent_settled → stats → running status  emitUpdate (progress rows)    inline progress
stdin.end() → close → terminal status   run end → restore/clear       results/notifications
```

## Error handling

| Case | Behavior |
| --- | --- |
| `prompt` rejected (`success:false`) | `errorMessage`, terminate child, normal failure path |
| `agent_settled` never fires | existing timeout → SIGTERM → SIGKILL fallback |
| `get_state` response absent | `contextWindow = null` → `(NN%)` omitted, everything else works |
| `get_session_stats` response slow/missing after `agent_settled` | bounded ~3 s fallback: last running status uses live `contextUsage`, then `stdin.end()`; `close` writes terminal status |
| tmux rename / pane-border / pane-title fails | best-effort try/catch, never fails the tool |
| widget/setStatus unavailable (json mode) | guarded by `ctx.mode === "tui"` / existence checks |
| mid-run `/name` while window title active | restore recomputes from current session name |
| concurrent runs | widget/footer/window title aggregate the shared registry; restore/clear only when empty |

## Non-goals

- Steering tool (`steer`) — follow-up; the rpc switch enables it.
- TUI-mode children / interactive panes.
- Re-introducing the standalone `watch-subagents` dashboard — its spec
  (`2026-08-07-watch-subagents-design.md`) is marked deprecated; the new
  status fields are backward-compatible with any file-based reader.
- Per-run config knobs for glyphs/colors (constants in `render.ts` suffice).
- Context-window configuration: `(NN%)` derives from the child model's
  declared `contextWindow`.

## Manual verification

1. `run_subagents` with 2 tasks (worker + scout), short objectives; watch the
   widget animate (spinner, live `↻`/`⚙`/tokens/elapsed, `⎿` activity), the
   footer line, and the tmux window title change; `tmux attach` to check the
   pane strips and header lines.
2. Let it finish: exactly one completion notification per task, notification
   headers in the result, window name restored, widget and footer cleared.
3. Failure path: temporarily configure a test profile with an invalid model id
   but a valid cwd, so the pane launches and the child exits non-zero. Confirm a
   `✗` row, `✗` aggregate window title (no color assumption), one failure
   notification, authoritative non-zero exit code, and preserved `stderr` tail;
   then remove the temporary profile.
4. Summary mode (`return_mode: "summary"`): `<coordinator-summary>` envelopes
   intact with notification headers above them.
