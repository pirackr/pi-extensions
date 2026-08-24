> **ARCHIVED** — Superseded by the durable Agent extension rewrite (2026-08-24). This document is retained for historical reference only.

# watch-subagents — subagent run dashboard design

> **DEPRECATED (2026-08-16)** — the standalone `watch-subagents` tool was
> removed (commit `c6b0110`) and this design is superseded by observability
> inside the extension itself: the shared tmux session (one parent window per
> Pi session, panes per task) plus the pi-subagents-style in-pi UI
> (`2026-08-16-tmux-subagents-pi-subagents-ui-design.md`). Kept for history;
> the new status fields (`tools`, `activity`, `contextUsage`) remain
> backward-compatible with the file-based data model described here.

## Goal

A standalone command that shows every agent of a `run_subagents` batch in **one
terminal screen** — live while they run, and again after they finish by
replaying retained artifacts. Zero changes to the `tmux-subagent` extension:
the tool reads only the files `run_subagents` already writes.

## Decisions (from discussion)

- **Standalone command** — not a pi extension tool. Invoked from the user's own
  terminal.
- **File-based TUI, not tmux-native.** One renderer serves both live and replay
  modes because both read the same `status/*.json` + `output/*.jsonl` files.
  No `join-pane` gymnastics; robust to the extension killing the tmux session
  (files outlive the session while the run dir exists).
- **No extension changes.** Live sessions die when the tool call returns;
  post-run review works when `retain_artifacts` kept the dir (`"always"`, or
  `"on_failure"` for failed runs). The tool's own copy of the arg/result
  summarizers (~50 lines from `runner.mjs`) keeps it self-contained — no import
  coupling to the extension.
- **All agents in one screen** — a grid layout, not per-window attach.
  Attach/jump-to-raw is an escape hatch on a single key, not the primary view.

## Script & placement

- `tools/watch-subagents.mjs` — self-contained, zero dependencies, run with
  `node` (repo convention: `.mjs` + top-level await is fine).
- `tools/watch-subagents` — shell shim: `exec node "$(dirname "$0")/watch-subagents.mjs" "$@"`.
- Symlink the shim into `~/.local/bin/` (user's PATH) to get the `watch-subagents`
  command.
- AGENTS.md note: usage, symlink instruction, replay requires
  `retain_artifacts: "always"` (or `"on_failure"` for failed runs).

## Invocation

| Form | Behavior |
| ---- | -------- |
| `watch-subagents` | Most recent run (live or ended-but-not-wiped). If >1 run exists, numbered picker first. |
| `watch-subagents <suffix>` | Match session name suffix (`abc123`); if several match, picker. If the arg is a directory path, treat as replay dir. |
| `watch-subagents -l` | List all runs (name, age, per-state counts) and exit. |

A directory argument without `status/` is an error: "not a subagent run dir".

## Discovery

- Live runs: scan `/tmp` for `pi-subagent-*` directories. A dir is recognized
  as a run when it has `status/*.json` files.
- Any explicit path argument: accept as a run dir if `status/` exists.
- A run is **live** if any status is `starting`/`running`; otherwise **ended**
  (still watchable until the extension wipes the dir).
- Runs that no longer exist (extension deleted the dir mid-watch): mark
  `ENDED (artifacts removed)`, keep last known state, stop polling.

## Data model (all existing files)

- `status/<task>.json` → state, pid, startedAt/finishedAt, stopReason,
  errorMessage, result, usage (tokens/cost/turns).
- `output/<task>.jsonl` → stream events: `message_update` text deltas,
  `tool_execution_start`/`tool_execution_end`, `message_end` (usage).
- `request/<task>.json` → agent name, model, cwd (labels panes).
- Task id is the file stem (`task-1`, `task-2`, …).

## Rendering

- **Header bar** (top 2 lines): mode (`LIVE` / `REPLAY` / `ENDED`), session
  name, elapsed, per-state counts (`2 running, 1 succeeded`), aggregate
  tokens + cost, refresh toggle state.
- **Grid:** `cols = ceil(√n)`, `rows = ceil(n/cols)` — 1 agent = full pane,
  2 = side-by-side, 3–4 = 2×2, up to 16 (config maxTasks). If the terminal is
  too small for the grid, render best-effort with a warning line.
- **Pane title line:** `task-2 · scout · RUNNING · 84s · 21.4k tok` —
  state-colored (green succeeded, red failed/timed_out/cancelled, yellow
  running, dim starting).
- **Pane body:** ring buffer of the rendered stream (last N lines that fit):
  text deltas joined into wrapped lines, tool calls as
  `[web_lookup] query="..."` with the result one line beneath (same
  summarization as `runner.mjs`), stderr lines dimmed. Long lines truncated
  with `…`.
- **Terminal panes:** show result tail (succeeded) or error message (failed).

## Refresh & interaction

- Poll every 500 ms: re-read status files, tail each `output/*.jsonl` from a
  tracked byte offset (partial JSON lines held until the line completes).
  Redraw only on change; 1 s forced tick updates elapsed.
- Keys:
  - `j`/`k` (or arrows) — move pane selection; selected pane gets a
    highlighted border
  - `Enter` — live: `tmux attach -t <session>` (detach with `Ctrl-b d`);
    ended/replay: agent's full rendered output in `less` (or print after exit)
  - `r` — pause/resume auto-refresh
  - `q` — quit, restore terminal cleanly

## Terminal handling

- Alternate screen buffer, raw-mode key input, ANSI colors (auto-disabled when
  not a TTY or `NO_COLOR` set), graceful Ctrl-C restore.

## Error handling

| Case | Behavior |
| ---- | -------- |
| No runs found | Message + hint that replay requires retained artifacts |
| Run dir deleted mid-watch | Mark `ENDED (artifacts removed)`, stop polling that dir |
| Partial JSONL line at EOF | Hold until line completes |
| Terminal too small for grid | Best-effort render + warning |
| Ctrl-C / `q` | Restore terminal, exit 0 |

## Tests (`tests/watch-subagents.test.ts`, vitest)

- Fixture: fake run dir in a temp dir with `request/`, `status/`, `output/`
  files — one mid-stream, one terminal, one partial JSONL line.
- Discovery + live/ended classification.
- Event → line rendering (text delta joins, tool start/end, result
  truncation).
- Partial JSONL line held across reads.
- Grid math: 1/2/3/4/16 agents; small-terminal fallback.
- Status aggregation (counts, tokens, cost).

## Manual verification

- Live: run `run_subagents` with 2+ tasks; `watch-subagents` shows all agents
  on one screen; `Enter` jumps to tmux attach; `q` restores cleanly.
- Replay: run with `retain_artifacts: "always"`, then point the tool at the
  retained dir after the run returns.
