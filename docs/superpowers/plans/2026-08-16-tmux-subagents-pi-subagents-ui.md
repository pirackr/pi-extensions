> **ARCHIVED** — Superseded by the durable Agent extension rewrite (2026-08-24). This document is retained for historical reference only.

# tmux-subagents pi-subagents UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the pi-subagents-style live agent UI (widget above the editor, per-agent status rows, completion notifications) to the tmux-subagent extension, plus the tmux-native surfaces that extension is uniquely able to provide (parent-window title, per-pane status strips).

**Architecture:** Children switch from one-shot `--mode json -p` to the `--mode rpc` protocol: the runner drives `get_state` / `prompt` / `get_session_stats` over the child's stdin (kept open), publishing live `tools` / `activity` / `contextUsage` / `compactionCount` fields into the status files the parent already polls every 250 ms. Pure pi-import-free renderers in `render.ts` (named glyph constants, formatters, row/widget/window/pane/notification renderers with optional theme coloring) feed a TUI-gated widget and footer status, an upgraded row-based inline progress stream, restyled result headings, and best-effort tmux window-title and pane-border-strip updates driven from a shared module-level run registry.

**Files:**

- Modify: `extensions/tmux-subagent/render.ts` — glyph constants, formatters, row/widget/window/pane/notification renderers, results restyle
- Modify: `extensions/tmux-subagent/runner.mjs` — json→rpc protocol, live status fields, pane header line
- Modify: `extensions/tmux-subagent/index.ts` — TaskStatus fields, widgetRuns registry, widget, footer, window title, pane strips, inline progress, results restyle
- Modify: `types/pi-coding-agent.d.ts` — setWidget overloads + minimal Theme/TUI/Component/ExtensionWidgetOptions stubs
- Create: `extensions/tmux-subagent/__tests__/widget-types-probe.ts` — tsc-gated type probe for the widget API
- Create: `tests/tmux-ui-render.test.ts` — pure renderer tests (vitest)
- Modify: `extensions/tmux-subagent/__tests__/runner.test.ts` — RPC protocol flow tests
- Modify: `extensions/tmux-subagent/__tests__/integration.test.ts` — widget/footer/window-title/pane-strip/progress tests
- Modify: `tests/subagent-summary.test.ts` — heading assertions for restyled summary mode

**Spec:** `docs/superpowers/specs/2026-08-16-tmux-subagents-pi-subagents-ui-design.md`

## Global Constraints

- Glyphs are named constants in `render.ts` (`TURN_GLYPH = "↻"`, `TOOL_GLYPH = "⚙"`), so swapping is a one-line change. No emoji (font reliability in terminal widgets).
- All tmux calls best-effort (try/catch — a tmux failure must never fail the tool).
- Widget (`ctx.ui.setWidget("tmux-subagents", …)`) only when `ctx.mode === "tui"`; every component-rendered line must be ANSI-safely truncated to the `render(width)` viewport.
- All new status fields optional and additive — existing consumers (`readStatus`, any file-based reader) are unaffected.
- `renderSummaryResults` keeps its `<coordinator-summary>` envelope untouched (parseable contract for research loops).
- Task delivery: read `request.taskPath` and send `{"type":"prompt","message":<task text>}`; stdin stays open (do not end it — rpc mode reads commands until EOF).
- The wait for `get_session_stats` is bounded by a ~3 s fallback timer. The stats response or fallback updates the last running status and ends stdin; the child `close` handler remains the sole writer of terminal status so a non-zero exit cannot be masked.
- Live context usage uses the latest valid assistant-message usage, never the cumulative billing total; `compaction_end` resets live tokens/percent to null until a post-compaction assistant message arrives.
- Pane strips: after `launchBatch`, on the run's own window only: `set-window-option pane-border-status top` + `pane-border-format "#{pane_title}"`; push a pane title when its rendered value changes, throttled to ≥1 s.

---

### Task 1: render.ts — glyph constants, statusIcon, formatTokens, formatElapsed

**Files:**

- Modify: `extensions/tmux-subagent/render.ts`
- Create: `tests/tmux-ui-render.test.ts`

**Interfaces:**

- Consumes: nothing new (existing `RenderStatus` stays untouched).
- Produces: `SPINNER_FRAMES` (10-frame braille dot spinner `⠋ ⠙ ⠹ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏` — its third frame matches the reference row's `⠹`), `TURN_GLYPH = "↻"`, `TOOL_GLYPH = "⚙"`, `ACTIVITY_GLYPH = "⎿"`, `COMPACTION_GLYPH = "⇊"`; `statusIcon(state, frame): string`; `formatTokens(n): string`; `formatElapsed(startedAt?, finishedAt?): string`.

- [ ] **Step 1: Write the failing tests** in `tests/tmux-ui-render.test.ts` (import from `../extensions/tmux-subagent/render.ts`). Assert: `statusIcon` returns `✓` for `succeeded`, `✗` for `failed` and `timed_out`, `■` for `cancelled`, and the frame-indexed spinner glyph (modulo wrap-around) for `starting` and `running`; `formatTokens` returns `0 tok` for 0, `812 tok` for 812, `12.4k tok` for 12400, `1.2M tok` for 1200000; `formatElapsed` returns `""` when `startedAt` is missing, `0ms` for 0, `812ms` for 812, `12.3s` for 12300, `2m17s` for 137000, and `2h5m` for 7500000.
- [ ] **Step 2: Run `npx vitest run tests/tmux-ui-render.test.ts`** — expect failures (the exports do not exist yet).
- [ ] **Step 3: Implement** the constants and three functions in `render.ts` exactly per the contracts above: `statusIcon` switches on state name with frame indexed by modulo; `formatTokens` switches at 1000 and 1e6 with one decimal place; `formatElapsed` switches at 1000 ms (ms), 60 s (one-decimal seconds), and 3600 s (m+s, then h+m above).
- [ ] **Step 4: Run the test file again** — expect PASS.
- [ ] **Step 5: Commit** `feat(tmux-subagent): glyph constants, token/elapsed formatters, status icon`.

### Task 2: render.ts — stats row, task row, toWidgetTask adapter

**Files:**

- Modify: `extensions/tmux-subagent/render.ts`
- Modify: `tests/tmux-ui-render.test.ts`

**Interfaces:**

- Consumes Task 1: `SPINNER_FRAMES`, `TURN_GLYPH`, `TOOL_GLYPH`, `COMPACTION_GLYPH`, `ACTIVITY_GLYPH`, `statusIcon`, `formatTokens`, `formatElapsed`.
- Produces: `WidgetTask` view model `{taskId, agent, state, objective?, model?, turns, tools, tokenCount, percent (number|null), elapsed, activity?, compactionCount, result?, errorMessage?}`; a structural `TaskStatusLike` type (taskId, agent, state, startedAt?, finishedAt?, model?, usage? `{totalTokens?, turns?}`, tools?, activity?, contextUsage? `{percent?}`, compactionCount?, result?, errorMessage?) that both `TaskStatus` (index.ts) and `RenderStatus` satisfy structurally; `toWidgetTask(status: TaskStatusLike): WidgetTask`; `WidgetTheme` `{fg(color: string, text: string): string}` (structural, so the real pi Theme satisfies it); `renderStatsRow(task: WidgetTask): string`; `renderTaskRow(task: WidgetTask, {frame, theme?}): string[]`.

- [ ] **Step 1: Write the failing tests.** `renderStatsRow` must match the spec example exactly — for turns 3, tools 5, tokenCount 12400, percent 8, elapsed `12.3s`: `↻3 · ⚙ 5 tools · 12.4k token (8%) · 12.3s` (the token label derives from `formatTokens` with `tok` → `token`); singular `⚙ 1 tool`; the `⚙` segment absent at tools 0; `(NN%)` omitted when percent is null; `· ⇊1` appended when compactionCount is 1. `renderTaskRow` returns `[icon + " agent · objective · " + stats]` when objective is present and drops `· objective` when absent; colors the icon via `theme.fg` when theme is present (`✓` success, `✗` error, `■` dim, spinner accent) and identity otherwise; a second line `⎿ <activity>` only when activity is present, truncated to 60 chars.
- [ ] **Step 2: Run the test file** — expect failures.
- [ ] **Step 3: Implement** `toWidgetTask` (defaults turns/tools/compactionCount to 0, percent from `contextUsage.percent`, tokenCount from `usage.totalTokens`, elapsed via `formatElapsed(startedAt, finishedAt)`, carries result/errorMessage through) and the two row renderers with the exact segment rules above; apply the percent color thresholds (dim below 70, warning 70–85, error ≥85) only when theme is present.
- [ ] **Step 4: Re-run the test file** — expect PASS.
- [ ] **Step 5: Commit** `feat(tmux-subagent): stats row, task row, toWidgetTask adapter`.

### Task 3: render.ts — widget lines, window title, pane title, notifications, results restyle

**Files:**

- Modify: `extensions/tmux-subagent/render.ts`
- Modify: `tests/tmux-ui-render.test.ts`
- Modify: `tests/subagent-summary.test.ts`

**Interfaces:**

- Consumes Task 2: `WidgetTask`, `toWidgetTask`, `renderTaskRow`, `renderStatsRow`, glyphs, `statusIcon`.
- Produces: `WidgetRun` `{runId, startedAt, tasks: {taskId, agent, objective}[], statuses: Record<taskId, TaskStatusLike>}`; `renderWidgetLines(runs: WidgetRun[], {frame, theme?, width}): string[]`; `renderWindowTitle(runs: WidgetRun[], {frame}): string`; `renderPaneTitle(task: WidgetTask, {frame}): string`; `renderNotification(task: WidgetTask): string[]`; `renderSectionHeading(status: TaskStatusLike): string`; plus restyled `renderSummaryResults` (full-mode `renderResults` remains in `index.ts` for Task 8).

- [ ] **Step 1: Write the failing tests.** `renderWidgetLines`: header line `● Subagents (tmux)`, per-run rows built by merging `run.tasks` (objective) with `run.statuses` via `toWidgetTask` (missing status renders a starting placeholder row), a dim run-id separator line when more than one run, footer `2 running · 1 done` (running = starting+running, done = terminal, each segment only when > 0), and a `…` truncation line when the complete output would exceed the exact 12-line cap (header and footer always retained; keep task rows in run/task order until the remaining line budget is exhausted). Every returned line is ANSI-safely truncated to `width`, with tests at widths 20 and 80. `renderWindowTitle`: running case `⣷ worker+scout · 1/2 done · 1m20s` shape (spinner glyph from frame, unique agents joined `+`, done/total, elapsed since `startedAt`) and terminal cases `✓ 2/2 done · 1m42s` only when every task succeeded, `✗` when any task failed/timed out, and `■` when there are cancellations but no failures. `renderPaneTitle`: `⠹ worker · ↻3 · ⚙ 5 tools` (icon + agent + `↻N` + `⚙ N tools` when tools > 0). `renderNotification` for succeeded/failed/timed_out/cancelled: line 1 icon + `agent · objective` (fall back to taskId when objective absent) + verb `completed`/`failed`/`timed out`/`cancelled`; line 2 `renderStatsRow`; line 3 `⎿` + result or errorMessage preview truncated to 120 chars, omitted when neither present. `renderSectionHeading`: `=== ✓ worker · task-1 · succeeded — 3 turns · 12.4k token ===` (icon per state; turns/tokens segments only when usage present). Summary mode: assert the `<coordinator-summary>` envelope text stays byte-identical while each section gains the notification header. Full-mode `renderResults` is tested and changed in Task 8, where that function actually lives.
- [ ] **Step 2: Update `tests/subagent-summary.test.ts`** heading assertions to the new notification-style headers; the envelope assertions are untouched.
- [ ] **Step 3: Run both test files** — expect failures.
- [ ] **Step 4: Implement** the five renderers plus a private ANSI-preserving visible-width truncation helper in `render.ts`; apply the helper after line-cap selection and before returning every widget line; rewrite only the heading code path of `renderSummaryResults` (notification header per section, envelope/Result/transcript/artifacts lines byte-identical). Do not create or move `renderResults`; it remains in `index.ts` until Task 8.
- [ ] **Step 5: Re-run `tests/tmux-ui-render.test.ts` and `tests/subagent-summary.test.ts`** — expect PASS.
- [ ] **Step 6: Commit** `feat(tmux-subagent): widget/window/pane/notification renderers, results restyle`.

### Task 4: types/pi-coding-agent.d.ts — setWidget stubs

**Files:**

- Modify: `types/pi-coding-agent.d.ts`
- Create: `extensions/tmux-subagent/__tests__/widget-types-probe.ts`

**Interfaces:**

- Produces (consumed by Task 6): `WidgetPlacement` (`"aboveEditor" | "belowEditor"`), `ExtensionWidgetOptions` `{placement?: WidgetPlacement}`, `Component` `{render(width: number): string[]; invalidate(): void}`, `Theme` `{fg(color: string, text: string): string}`, `TUI` `{requestRender(): void}`, and two `setWidget` overloads on `ExtensionUIContext`: `setWidget(key, content: string[] | undefined, options?)` and `setWidget(key, content: ((tui: TUI, theme: Theme) => Component & {dispose?(): void}) | undefined, options?)`. All declared inside the existing `declare module "@earendil-works/pi-coding-agent"` block, matching the real pi API shapes verified in the pi package.

- [ ] **Step 1: Create the probe file** — a function taking `ExtensionContext` that, when `ctx.mode === "tui"`, calls `ctx.ui.setWidget` three ways: with a component factory whose returned object implements `render` (calling `theme.fg` and returning a line) and `invalidate`, plus `dispose` (calling `tui.requestRender`), passing `{placement: "aboveEditor"}`; with a `string[]`; and with `undefined` to clear.
- [ ] **Step 2: Run `npx tsc`** — expect failure: `setWidget` does not exist on `ExtensionUIContext`.
- [ ] **Step 3: Add** the interfaces and both overloads to the stub.
- [ ] **Step 4: Run `npx tsc`** — expect clean; also run `npx vitest run tests/tmux-ui-render.test.ts` to confirm no regressions.
- [ ] **Step 5: Commit** `types: add setWidget/Component/Theme stubs for extension widgets`.

### Task 5: runner.mjs — rpc protocol and live status fields

**Files:**

- Modify: `extensions/tmux-subagent/runner.mjs`
- Modify: `extensions/tmux-subagent/__tests__/runner.test.ts`

**Interfaces:**

- Consumes: `RunnerRequest` unchanged (taskPath/promptPath/statusPath/outputPath/stderrPath/transcriptPath etc.).
- Produces: child args `--mode rpc` (no `-p`, no `--mode json`); status files gain optional `tools` (number), `activity` (string), `contextUsage` `{tokens, contextWindow (number|null), percent (number|null)}`, `compactionCount` (number); a pane header line `━━━ <agent> · <taskId> · <model> ━━━` emitted to pane + transcript at task start; `get_state` (id `st1`) then `prompt` written to stdin after spawn, stdin left open; on `agent_settled` a `get_session_stats` (id `st2`) write and a ~3 s fallback timer; the response (or fallback) writes one last `running` status with the best available `contextUsage` and calls `stdin.end()`, while `close` writes the authoritative terminal status and exit code.

- [ ] **Step 1: Update the spawn-args test** to expect `--mode rpc` and no `-p`/`--mode json`; add a `write` mock to the child's `stdin` mock. Write the failing tests: after spawn `stdin.write` receives a `get_state` JSONL with id `st1` and a `prompt` JSONL carrying the task text from `request.taskPath`; a `response` for `st1` with `data.model.contextWindow` 128000 makes a later `message_end` (totalTokens 10240) write `contextUsage.percent` 8, a second `message_end` with totalTokens 25600 writes 20% (the aggregate 35840 billing total is not used for context percent), a null contextWindow writes percent null, and `compaction_end` immediately writes tokens/percent null until another valid assistant `message_end`; `tool_execution_start` events write cumulative `tools` and `activity` (`searching…` for `web_lookup`, `editing auth.ts…` for `edit` with `args.path` `/tmp/auth.ts`); `compaction_end` increments `compactionCount`; `agent_settled` triggers a `get_session_stats` write; its `response` (id `st2`) writes a final live/running status with authoritative `contextUsage` and then `stdin.end()`; `close(0)` writes succeeded with exit code 0, while `close(1)` overwrites the live status with failed and exit code 1; a `prompt` response with `success:false` sets `errorMessage` and terminates via SIGTERM; when the stats response never arrives, the ~3 s fallback timer writes the last running status from live `contextUsage` and ends stdin; `process.stdout.write` receives the `━━━ worker · task-1 · gpt-4o ━━━` header at start. Existing close-driven tests (message_end accumulation, failed exit code, child error) must be reworked to the RPC flow: emit `message_end`, then `agent_settled`, then the `st2` response, then `close`.
- [ ] **Step 2: Run `npx vitest run extensions/tmux-subagent/__tests__/runner.test.ts`** — expect failures.
- [ ] **Step 3: Implement** in `runner.mjs`: swap the args to `--mode rpc`; after spawn write `get_state` then read `request.taskPath` and write the `prompt` command, keeping stdin open; add a `liveStatus()` helper merging `baseStatus()` with pid, state `running`, `tools`, `activity`, `contextUsage`, `compactionCount`, usage, and turns; keep aggregate `usage` for billing/result reporting but track `latestContextTokens` separately from the latest valid assistant message; call `writeStatus(liveStatus())` after every tool start, after every assistant `message_end`, and after every `compaction_end` (which sets live tokens/percent to null); extend `processEvent` to handle `response` events by id (`st1` → capture `contextWindow`; `st2` → capture authoritative `contextUsage`), count `compaction_end`, and detect `agent_settled` (send `get_session_stats` id `st2` and arm the 3 s fallback timer); add an `activityFor(toolName, args)` mapping (`web_lookup`→`searching…`, `edit`→`editing ${path.basename(args.path)}…` (falling back to `editing…` when path is absent), `fetch_web`→`fetching…`, `read`→`reading…`, `bash`/`shell`→`running…`, default the tool name); on the `st2` response or timer expiry write the last running status (authoritative `contextUsage` when available) and call `stdin.end()` exactly once; on a `prompt` response with `success:false` set `errorMessage` and terminate via the existing SIGTERM path; emit the `━━━` header line once at task start via `emit()`; add a `stdinEnded` guard and clear the stats fallback timer on response/close; keep the `close` handler as the only terminal-status writer so exit errors remain authoritative; the existing timeout → SIGTERM → SIGKILL fallback stays unchanged.
- [ ] **Step 4: Re-run the runner test file** — expect PASS; then run `npx vitest run` on the whole suite to catch regressions in the other tmux tests.
- [ ] **Step 5: Commit** `feat(tmux-subagent): runner rpc protocol with live status fields`.

### Task 6: index.ts — TaskStatus fields, widgetRuns registry, widget, footer status

**Files:**

- Modify: `extensions/tmux-subagent/index.ts`
- Modify: `extensions/tmux-subagent/__tests__/integration.test.ts`

**Interfaces:**

- Consumes Task 3 (`WidgetRun`, `renderWidgetLines`, `renderWindowTitle`), Task 4 (setWidget types).
- Produces: `TaskStatus` gains optional `tools`, `activity`, `contextUsage` (`{tokens, contextWindow, percent}`), `compactionCount`; module-level `widgetRuns: Map<string, WidgetRun>` and `let frame = 0`; widget registration inside `execute` when `ctx.mode === "tui"`; footer `setStatus("tmux-subagents", …)` on state transitions; cleanup in `finally` (registry delete; widget and footer cleared only when the registry empties).

- [ ] **Step 1: Add the four optional fields** to the `TaskStatus` interface. Remove the obsolete comment and change `describe.skip("shared tmux integration", …)` to an active `describe` before adding tests. Write failing integration tests in `__tests__/integration.test.ts` (extend the existing mock stack — fake pi with `ui: {setWidget: vi.fn(), setStatus: vi.fn()}`): with `ctx.mode === "tui"` and mocked `launchBatch` plus status files served from mocked `fs.promises.readFile`, executing the tool calls `setWidget("tmux-subagents", <function>)`; invoking that factory with a fake `tui` (`requestRender: vi.fn()`) and fake `theme` returns a component whose `render(width)` output contains `Subagents (tmux)` and the agent/objective row; with fake timers the 120 ms interval advances the frame and calls `tui.requestRender`, and `dispose()` stops the timer; `setStatus` is called with the aggregate compact footer from `renderWindowTitle([...widgetRuns.values()], …)`, truncated to 80 visible columns on progress changes and cleared with `undefined` at the end; in json mode (fake ui without `setWidget`) the tool completes without throwing; after the run ends and the registry is empty, `setWidget` is called with `undefined`.
- [ ] **Step 2: Run the integration test file** — expect failures.
- [ ] **Step 3: Implement** in `index.ts`: build the run's `WidgetRun` entry (`runId` = `path.basename(runDir)`, `startedAt`, `tasks` from `prepared` with objectives, `statuses: {}`) before launch and `widgetRuns.set`; in the poll loop mirror each `readStatus` result into the entry; in `emitUpdate` update the footer (guarded by `ctx.ui?.setStatus` existence) and, when `ctx.mode === "tui"` and `ctx.ui?.setWidget` exists, register the widget factory: a 120 ms `setInterval` that increments `frame` and calls `tui.requestRender()`, a `render(width)` returning `renderWidgetLines([...widgetRuns.values()], {frame, theme, width})`, a no-op `invalidate()`, and `dispose()` clearing the interval; in `finally` delete the registry entry, then when `widgetRuns.size === 0` clear the widget (TUI-gated) and the footer (guarded), so concurrent runs keep the widget alive until the last one finishes.
- [ ] **Step 4: Re-run the integration test file** — expect PASS; run `npx tsc`.
- [ ] **Step 5: Commit** `feat(tmux-subagent): widget + footer status with shared run registry`.

### Task 7: index.ts — window title and pane strips

**Files:**

- Modify: `extensions/tmux-subagent/index.ts`
- Modify: `extensions/tmux-subagent/__tests__/integration.test.ts`

**Interfaces:**

- Consumes Task 3 (`renderWindowTitle`, `renderPaneTitle`, `toWidgetTask`), Task 6 (registry entry, live statuses, `launchedPaneIds`, `tmuxExec`, `windowId`).
- Produces: a local `bestEffort(fn)` wrapper (try/catch, swallow); aggregate window rename across all registry runs on state-count change or ≥5 s since last rename; after deleting this run from the registry, restore only when no runs remain by recomputing `buildWindowName(parentCwd, {homedir: os.homedir(), topic: ctx?.sessionManager?.getSessionName?.(), firstPrompt: firstUserPrompt(ctx?.sessionManager)})`; pane-border setup plus per-pane `pane-title` pushes throttled ≥1 s.

- [ ] **Step 1: Write the failing integration tests:** after `launchBatch`, `tmuxExec` receives `set-window-option pane-border-status top` and `set-window-option pane-border-format "#{pane_title}"` for the run's `windowId`; `rename-window` is called with `renderWindowTitle([...widgetRuns.values()], …)` when aggregate state counts change; no rename within 5 s of the previous one (fake timers); `set-option -p -t <paneId> pane-title <renderPaneTitle output>` whenever that pane's rendered title changes, at most once per second per pane; when one of two concurrent runs ends, the title is recomputed from the remaining registry run rather than restored; when the last run ends, `rename-window` restores `buildWindowName` recomputed from the current session name (a mid-run `/name` is not clobbered); a `tmuxExec` rejection at any point still lets the tool return its normal result.
- [ ] **Step 2: Run the integration test file** — expect failures.
- [ ] **Step 3: Implement** in `index.ts`: add `bestEffort`; after `launchBatch`, best-effort apply the two `pane-border` window options; track `lastRenameAt`, aggregate state counts, and a per-pane `{lastTitle,lastPushAt}` map; in the poll loop, when aggregate state counts change or 5 s elapsed, best-effort `renameWindow(tmuxExec, windowId, renderWindowTitle([...widgetRuns.values()], {frame}))`; on every poll render each launched pane's candidate title and push it only when it differs and that pane's 1 s throttle has elapsed. Put title cleanup in the existing `finally`: after deleting this run, rename to the aggregate remaining-run title when the registry is non-empty, otherwise restore via the recomputed `buildWindowName` call above. All best-effort helpers must `await` asynchronous tmux calls inside `try/catch`.
- [ ] **Step 4: Re-run the integration test file** — expect PASS.
- [ ] **Step 5: Commit** `feat(tmux-subagent): live window title and pane border strips`.

### Task 8: index.ts — inline progress rows and result notifications

**Files:**

- Modify: `extensions/tmux-subagent/index.ts`
- Modify: `extensions/tmux-subagent/__tests__/integration.test.ts`

**Interfaces:**

- Consumes Task 3 (`renderSectionHeading`, `renderNotification`, `renderTaskRow`, `toWidgetTask`), Task 6 (registry/frame).
- Produces: `renderProgress(session, windowName, windowId, statuses, objectives?)` upgraded to the widget row format plus the attach-info block; `emitUpdate` passes the objectives map and increments `frame`; `renderResults` and `renderSummaryResults` wiring uses the new headings; terminal state transitions emit each task's `renderNotification` exactly once through `ctx.ui.notify` when UI is available.

- [ ] **Step 1: Write the failing tests:** `renderProgress` output contains the attach block (`Tmux session` / `Window` / `Attach` lines) followed by a `renderTaskRow` row per status with the objective from the objectives map and the `⎿` activity line; `renderResults` headings use the `renderSectionHeading` format with prompt echo and full output unchanged; summary-mode results carry the notification header while the `<coordinator-summary>` envelope stays intact; each succeeded/failed/timed-out/cancelled transition calls `ctx.ui.notify` exactly once with `renderNotification` (`info` for success/cancel, `error` for failed/timed_out); update any existing `renderProgress`/`renderResults` assertions in the suite to the new formats.
- [ ] **Step 2: Run the integration test file** — expect failures.
- [ ] **Step 3: Implement** in `index.ts`: extend `renderProgress` with an optional `objectives: Record<string, string>` parameter and build rows via `renderTaskRow(toWidgetTask(status), {frame})` after the attach block; in `emitUpdate`, increment `frame` and pass `Object.fromEntries(prepared.map(p => [p.taskId, p.task.objective]))`; replace the `renderResults` heading with `renderSectionHeading` (prompt echo and body untouched); summary-mode rendering already produces notification headers via Task 3; maintain a per-run `notifiedTaskIds` set in `emitUpdate` and call guarded `ctx.ui.notify(renderNotification(task).join("\n"), type)` only on the first observed terminal transition.
- [ ] **Step 4: Re-run the integration test file** — expect PASS; run the full `npx vitest run`.
- [ ] **Step 5: Commit** `feat(tmux-subagent): row-based inline progress and notification-style results`.

### Task 9: verification

**Files:**

- Create: `tests/tmux-subagent-load.smoke.ts` — Vitest-discovered loader smoke for the tmux-subagent factory (do not reuse the auto-compact smoke).

- [ ] **Step 1:** Run `npx tsc` — clean.
- [ ] **Step 2:** Run `npx vitest run` — all green.
- [ ] **Step 3:** Add and run `npx vitest run tests/tmux-subagent-load.smoke.ts`; it must jiti-load `extensions/tmux-subagent/index.ts`, invoke the factory with a minimal fake `ExtensionAPI`, and assert registration of `run_subagents`, `session_info_changed`, and `session_shutdown` — expect PASS.
- [ ] **Step 4:** Real end-to-end: one `run_subagents` call with 2 tasks (worker + scout) and short objectives; confirm the widget animates (spinner, live `↻`/`⚙`/tokens/elapsed, `⎿` activity), the footer line, the tmux window title, the pane border strips and `━━━` header lines; after completion confirm notification headers in the result, the restored window name, and the cleared widget and footer.
- [ ] **Step 5:** Failure path: temporarily configure a test profile with a deliberately invalid model id but a valid cwd so the pane launches and the child exits non-zero; confirm a `✗` row, a `✗` (not color-dependent) aggregate window title, exactly one failure notification, authoritative non-zero `exitCode`, and preserved `stderr` tail. Remove the temporary profile afterward.
- [ ] **Step 6:** Summary mode (`return_mode: "summary"`): `<coordinator-summary>` envelopes intact with notification headers above them.
