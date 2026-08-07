# watch-subagents Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A standalone command (`watch-subagents`) that shows every agent of a `run_subagents` batch in one terminal screen — live while they run, and again after by replaying retained artifacts.

**Architecture:** A single zero-dependency Node ESM file (`tools/watch-subagents.mjs`) with exported pure functions (discovery, loading, stream tailing, rendering) and an `isMainModule`-guarded TUI entry. It reads only the files `run_subagents` already writes (`status/*.json`, `output/*.jsonl`, `request/*.json`) under `/tmp/pi-subagent-*` run dirs — no extension changes. Pure functions live in the module so vitest can import them; the TUI (raw mode, alternate screen, key loop) runs only when executed directly.

**Tech Stack:** Node.js (>= 18), ESM `.mjs`, built-in modules only (`node:fs`, `node:path`, `node:os`, `node:url`, `node:readline`, `node:child_process`). Tests: vitest 2.x (already in repo), `tests/watch-subagents.test.ts`.

## Global Constraints

- **Zero runtime dependencies** — node built-ins only, matching the repo's "pi loads TS directly" ethos; the tool must run with plain `node`.
- **One implementation file** — `tools/watch-subagents.mjs`. All logic lives there; `tools/watch-subagents.d.mts` declares the public API for TypeScript consumers; `tools/watch-subagents` is a shell shim.
- **No extension changes** — do not touch `extensions/tmux-subagent/*`, `config/tmux-subagent.json`, or `~/.pi/agent/tmux-subagent/config.json`.
- **Guard the TUI** — the module must be importable from vitest without starting the TUI: wrap `main()` in `if (isMainModule)` exactly like `extensions/tmux-subagent/runner.mjs` does.
- **Copy, don't import** — the arg/result summarizers (`summarizeArgs`, `summarizeResult`, `truncate`) are duplicated from `runner.mjs` (~50 lines), byte-compatible in behavior, to keep the tool standalone.
- **Event shapes** — stream events come from `output/<task>.jsonl` lines: `message_update` with `assistantMessageEvent.delta` (string), `tool_execution_start` with `toolName`/`toolCall.name` + `args`/`toolCall.arguments`, `tool_execution_end` with `toolName` + `result.details`/`result.error` + `isError`, `message_end` with `message.role === "assistant"`. Status files have `state`, `startedAt`, `finishedAt`, `errorMessage`, `result`, `usage.totalTokens`, `usage.cost.total`, `usage.turns`. Request files have `agent`, `model`, `cwd`, `statusPath`, `outputPath`, `stderrPath`.
- **Test command** — `npx vitest run tests/watch-subagents.test.ts -t "<filter>"` (vitest 2.x, globals: true). Full suite: `npx vitest run`.
- **Commit hygiene** — only stage files this plan creates/modifies (`tools/`, `tests/watch-subagents.test.ts`, `AGENTS.md`, this plan). The working tree has unrelated uncommitted changes (`config/`, `extensions/`, PDFs, etc.) — never `git add -A`.

---

## File Structure

| File | Responsibility |
| ---- | -------------- |
| `tools/watch-subagents.mjs` | Everything: discovery, run loading, stream tailing, stream rendering, formatting, grid/pane/frame rendering, TUI main. Exported pure functions + guarded `main()`. |
| `tools/watch-subagents.d.mts` | TS declaration for the exported API (lets `tests/watch-subagents.test.ts` import with types). |
| `tools/watch-subagents` | Shell shim: `exec node "$(dirname "$0")/watch-subagents.mjs" "$@"` — symlink target for `~/.local/bin`. |
| `tests/watch-subagents.test.ts` | vitest suite. Fixture run dirs built under a temp base dir (passes `baseDir` to `findRuns`, so no touching real `/tmp`). |
| `AGENTS.md` | Usage note (added in Task 9). |

---

### Task 1: Scaffold + discovery

**Files:**

- Create: `tools/watch-subagents.mjs` (module skeleton: imports, constants, `isMainModule` guard, discovery functions)
- Create: `tools/watch-subagents.d.mts` (full API declaration — the agreed contract; functions land in later tasks)
- Create: `tests/watch-subagents.test.ts` (fixture helper + discovery tests)

**Interfaces:**

- Consumes: nothing (first task).
- Produces (used by Tasks 2–9 and the TUI):
  - `findRuns(baseDir?: string): RunInfo[]` — scan `baseDir` (default `/tmp`) for `pi-subagent-*` dirs with readable `status/*.json`; sorted most-recent `start` first.
  - `inspectDir(dir: string): RunInfo | null` — validate a dir is a run dir (has `status/*.json`); null otherwise.
  - `readStatus(statusPath: string): object | null` — parse status JSON; null on missing/corrupt.
  - `listRunsText(runs: RunInfo[]): string` — human listing for `-l` and the picker.
  - `resolveRunArg(arg: string | undefined, baseDir?: string): { run: RunInfo | null; error: string | null }` — no arg → most recent (from `findRuns(baseDir)`, default `/tmp`); path-like arg → `inspectDir`; otherwise suffix match on session name.
  - `RunInfo = { dir, session, start: Date, counts: Record<string, number>, live: boolean }`
  - `LIVE_STATES = new Set(["starting", "running"])`, `TERMINAL_STATES = new Set(["succeeded", "failed", "timed_out", "cancelled"])` (both exported).

- [ ] **Step 1: Write the failing tests**

`tests/watch-subagents.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
 findRuns,
 inspectDir,
 readStatus,
 listRunsText,
 resolveRunArg,
 LIVE_STATES,
} from "../tools/watch-subagents.mjs";

let base: string;

beforeEach(() => {
 base = fs.mkdtempSync(path.join(os.tmpdir(), "watch-fixture-"));
});

afterEach(() => {
 fs.rmSync(base, { recursive: true, force: true });
});

function makeStatus(over: Record<string, unknown> = {}): Record<string, unknown> {
 return {
  taskId: "task-1",
  agent: "scout",
  state: "running",
  startedAt: new Date("2026-08-07T10:00:00Z").toISOString(),
  model: "deepseek-v4-flash",
  ...over,
 };
}

/** Build a fake run dir under `base`; returns the dir path. */
function writeRun(
 name: string,
 tasks: Array<{ taskId: string; status: Record<string, unknown> }>,
): string {
 const dir = path.join(base, name);
 for (const sub of ["status", "output", "stderr", "request"]) {
  fs.mkdirSync(path.join(dir, sub), { recursive: true });
 }
 for (const t of tasks) {
  fs.writeFileSync(
   path.join(dir, "status", `${t.taskId}.json`),
   JSON.stringify(t.status, null, 2),
  );
  fs.writeFileSync(path.join(dir, "request", `${t.taskId}.json`), JSON.stringify({
   taskId: t.taskId,
   agent: t.status.agent,
   model: t.status.model,
   cwd: "/work",
   statusPath: path.join(dir, "status", `${t.taskId}.json`),
   outputPath: path.join(dir, "output", `${t.taskId}.jsonl`),
   stderrPath: path.join(dir, "stderr", `${t.taskId}.log`),
  }));
 }
 return dir;
}

describe("discovery", () => {
 it("findRuns finds fixture runs and sorts most-recent first", () => {
  writeRun("pi-subagent-old", [
   { taskId: "task-1", status: makeStatus({ state: "succeeded", startedAt: "2026-08-07T09:00:00Z" }) },
  ]);
  writeRun("pi-subagent-new", [
   { taskId: "task-1", status: makeStatus({ state: "running", startedAt: "2026-08-07T11:00:00Z" }) },
  ]);
  const runs = findRuns(base);
  expect(runs.map((r) => r.session)).toEqual(["pi-subagent-new", "pi-subagent-old"]);
  expect(runs[0].live).toBe(true);
  expect(runs[1].live).toBe(false);
  expect(runs[0].counts).toEqual({ running: 1 });
  expect(runs[1].counts).toEqual({ succeeded: 1 });
 });

 it("findRuns ignores dirs without status files", () => {
  fs.mkdirSync(path.join(base, "pi-subagent-empty"));
  fs.mkdirSync(path.join(base, "not-a-run"));
  expect(findRuns(base)).toEqual([]);
 });

 it("inspectDir returns null for non-run dirs", () => {
  fs.mkdirSync(path.join(base, "pi-subagent-x"));
  expect(inspectDir(path.join(base, "pi-subagent-x"))).toBeNull();
 });

 it("readStatus returns null for missing and corrupt files", () => {
  expect(readStatus(path.join(base, "nope.json"))).toBeNull();
  const bad = path.join(base, "bad.json");
  fs.writeFileSync(bad, "{not json");
  expect(readStatus(bad)).toBeNull();
 });

 it("listRunsText lists runs with state counts and marks live", () => {
  writeRun("pi-subagent-a", [
   { taskId: "task-1", status: makeStatus({ state: "running" }) },
   { taskId: "task-2", status: makeStatus({ state: "succeeded", taskId: "task-2" }) },
  ]);
  const text = listRunsText(findRuns(base));
  expect(text).toContain("pi-subagent-a");
  expect(text).toContain("1 running");
  expect(text).toContain("1 succeeded");
  expect(text).toContain("●");
 });

 it("resolveRunArg: no arg picks most recent", () => {
  writeRun("pi-subagent-b", [
   { taskId: "task-1", status: makeStatus({ startedAt: "2026-08-07T08:00:00Z" }) },
  ]);
  const { run, error } = resolveRunArg(undefined, base);
  expect(error).toBeNull();
  expect(run?.session).toBe("pi-subagent-b");
 });

 it("resolveRunArg: path arg validates the dir", () => {
  const dir = writeRun("pi-subagent-c", [
   { taskId: "task-1", status: makeStatus({}) },
  ]);
  expect(resolveRunArg(dir).run?.session).toBe("pi-subagent-c");
  expect(resolveRunArg(path.join(base, "nope"), base).error).toContain("not a subagent run dir");
  expect(resolveRunArg(path.join(base, "nope")).error).toContain("not a subagent run dir");
 });

 it("resolveRunArg: suffix arg matches session names", () => {
  writeRun("pi-subagent-abc123", [
   { taskId: "task-1", status: makeStatus({}) },
  ]);
  const { run } = resolveRunArg("abc123", base);
  expect(run?.session).toBe("pi-subagent-abc123");
  expect(resolveRunArg("zzz", base).error).toContain("no run matching");
  expect(run?.session).toBe("pi-subagent-abc123");
  expect(resolveRunArg("zzz").error).toContain("no run matching");
 });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/watch-subagents.test.ts -t "discovery"`

Expected: FAIL — `Cannot find module '../tools/watch-subagents.mjs'`.

- [ ] **Step 3: Create the module skeleton + discovery implementation**

`tools/watch-subagents.mjs`:

```js
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const LIVE_STATES = new Set(["starting", "running"]);
export const TERMINAL_STATES = new Set([
 "succeeded",
 "failed",
 "timed_out",
 "cancelled",
]);

// ---------- discovery ----------

/** Read and parse a status file; null on missing or corrupt. */
export function readStatus(statusPath) {
 try {
  const parsed = JSON.parse(fs.readFileSync(statusPath, "utf8"));
  return parsed && typeof parsed === "object" ? parsed : null;
 } catch {
  return null;
 }
}

/** Validate a dir as a subagent run; null if not one. */
export function inspectDir(dir) {
 let statusFiles = [];
 try {
  statusFiles = fs
   .readdirSync(path.join(dir, "status"))
   .filter((f) => f.endsWith(".json"));
 } catch {
  return null;
 }
 if (statusFiles.length === 0) return null;
 const counts = {};
 let start = null;
 let live = false;
 for (const file of statusFiles) {
  const status = readStatus(path.join(dir, "status", file));
  if (!status) continue;
  counts[status.state] = (counts[status.state] || 0) + 1;
  const s = Date.parse(status.startedAt || "");
  if (!Number.isNaN(s) && (!start || s < start)) start = s;
  if (LIVE_STATES.has(status.state)) live = true;
 }
 let mtime = Date.now();
 try {
  mtime = fs.statSync(dir).mtimeMs;
 } catch {
  // dir vanished between readdir and stat — caller will treat as ended
 }
 return {
  dir,
  session: path.basename(dir),
  start: new Date(start || mtime),
  counts,
  live,
 };
}

/** Scan baseDir for pi-subagent-* runs, most recent first. */
export function findRuns(baseDir = "/tmp") {
 let entries = [];
 try {
  entries = fs.readdirSync(baseDir);
 } catch {
  return [];
 }
 const runs = [];
 for (const name of entries) {
  if (!name.startsWith("pi-subagent-")) continue;
  const info = inspectDir(path.join(baseDir, name));
  if (info) runs.push(info);
 }
 runs.sort((a, b) => b.start.getTime() - a.start.getTime());
 return runs;
}

/** Resolve a CLI argument (or none) to a run. */
export function resolveRunArg(arg, baseDir = "/tmp") {
 if (!arg) {
  const runs = findRuns(baseDir);
  return { run: runs[0] || null, error: null };
 }
 const looksLikePath =
  arg.includes("/") ||
  arg.startsWith(".") ||
  path.isAbsolute(arg) ||
  fs.existsSync(arg);
 if (looksLikePath) {
  const info = inspectDir(path.resolve(arg));
  if (!info)
   return { run: null, error: `not a subagent run dir: ${path.resolve(arg)}` };
  return { run: info, error: null };
 }
 const matches = findRuns(baseDir).filter((r) => r.session.includes(arg));
 if (matches.length === 0)
  return { run: null, error: `no run matching "${arg}"` };
 return { run: matches[0], error: null };
}

/** Human listing for -l and the picker. */
export function listRunsText(runs) {
 if (runs.length === 0) {
  return 'No subagent runs found.\nReplay requires retained artifacts (pass retain_artifacts: "always" to run_subagents).';
 }
 return runs
  .map((run, i) => {
   const counts = Object.entries(run.counts)
    .map(([state, count]) => `${count} ${state}`)
    .join(", ") || "no status";
   const mark = run.live ? "●" : "○";
   return `${i + 1}. ${mark} ${run.session}  started ${formatAge(Date.now() - run.start.getTime())} ago  [${counts}]`;
  })
  .join("\n");
}

// ---------- formatting (used above; full impl in Task 5) ----------

export function formatAge(ms) {
 ms = Math.max(0, ms);
 const s = Math.floor(ms / 1000);
 if (s < 60) return `${s}s`;
 const m = Math.floor(s / 60);
 if (m < 60) return `${m}m`;
 return `${Math.floor(m / 60)}h${m % 60}m`;
}

// ---------- entry guard (TUI main lands in Task 8) ----------

const isMainModule =
 process.argv[1] === fileURLToPath(import.meta.url) ||
 process.argv[1]?.endsWith("/tools/watch-subagents.mjs");

if (isMainModule) {
 import("./main.ts").catch(() => {
  process.stderr.write("TUI not yet implemented (Task 8).\n");
  process.exit(1);
 });
}
```

`tools/watch-subagents.d.mts` (full contract — declare everything the plan defines; later tasks implement):

```ts
export interface RunInfo {
 dir: string;
 session: string;
 start: Date;
 counts: Record<string, number>;
 live: boolean;
}
export interface TaskInfo {
 taskId: string;
 agent: string;
 model: string;
 cwd: string;
 statusPath: string;
 outputPath: string;
 stderrPath: string;
 status?: Record<string, unknown> | null;
}
export interface Run {
 dir: string;
 session: string;
 tasks: TaskInfo[];
}
export interface TailState {
 offset: number;
 partial: string;
}
export interface StreamState {
 lines: string[];
 current: string;
 maxLines: number;
}
export const LIVE_STATES: Set<string>;
export const TERMINAL_STATES: Set<string>;
export function findRuns(baseDir?: string): RunInfo[];
export function inspectDir(dir: string): RunInfo | null;
export function readStatus(statusPath: string): Record<string, unknown> | null;
export function listRunsText(runs: RunInfo[]): string;
export function resolveRunArg(
 arg: string | undefined,
 baseDir?: string,
): { run: RunInfo | null; error: string | null };
export function formatAge(ms: number): string;
export function loadRun(dir: string): Run;
export function createTailState(): TailState;
export function nextEvents(
 outputPath: string,
 state: TailState,
): { events: Record<string, unknown>[]; state: TailState };
export function createStreamState(maxLines?: number): StreamState;
export function accumulate(acc: StreamState, event: unknown): void;
export function summarizeArgs(args: unknown): string;
export function summarizeResult(
 toolName: string,
 event: Record<string, unknown>,
): string;
export function renderFullOutput(task: TaskInfo): string;
export function formatDuration(startedAt?: string, finishedAt?: string): string;
export function formatTokens(n: number): string;
export function aggregateStats(
 statuses: Array<Record<string, unknown> | null>,
): { counts: Record<string, number>; totalTokens: number; totalCost: number; turns: number };
export function formatStatus(task: TaskInfo): string;
export function computeGrid(n: number): { cols: number; rows: number };
export function truncateLine(s: string, width: number): string;
export function renderTaskLines(
 task: TaskInfo,
 stream: StreamState,
 width: number,
 height: number,
 selected: boolean,
): { lines: string[]; title: { text: string; selected: boolean } };
export function renderHeader(opts: {
 run: Run;
 paused: boolean;
 live: boolean;
 width: number;
}): string[];
export function renderFrame(opts: {
 run: Run;
 streams: Map<string, StreamState>;
 selected: number;
 paused: boolean;
 live: boolean;
 width: number;
 height: number;
}): {
 text: string;
 titles: Array<{ row: number; col: number; len: number; state: string; selected: boolean }>;
};
export function applyTuiStyles(
 text: string,
 titles: Array<{ row: number; col: number; len: number; state: string; selected: boolean }>,
): string;
```

> Note: the `import("./main.ts")` placeholder in the guard is temporary — Task 8 replaces the whole guard with the real TUI. Later tasks append exports to this module; the `isMainModule` block only fires when executed directly, so vitest imports stay side-effect-free.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/watch-subagents.test.ts -t "discovery"`

Expected: PASS (all 8 tests).

- [ ] **Step 5: Commit**

```bash
git add tools/watch-subagents.mjs tools/watch-subagents.d.mts tests/watch-subagents.test.ts
git commit -m "feat: watch-subagents discovery + scaffold"
```

---

### Task 2: Run loading

**Files:**

- Modify: `tools/watch-subagents.mjs` (add `loadRun`)
- Modify: `tests/watch-subagents.test.ts` (append loadRun tests)

**Interfaces:**

- Consumes: `readStatus` (Task 1).
- Produces (used by Tasks 3–9 and the TUI):
  - `loadRun(dir: string): Run` — read `request/*.json` for `taskId`/`agent`/`model`/`cwd`/`statusPath`/`outputPath`/`stderrPath`; fall back to derived `dir/status|output|stderr/<taskId>.<ext>` paths and `agent = taskId` when a request file is missing. Sorts tasks numerically (`task-1`, `task-2`, …). Does **not** read statuses (the TUI refreshes those live).
  - `Run = { dir, session, tasks: TaskInfo[] }`, `TaskInfo = { taskId, agent, model, cwd, statusPath, outputPath, stderrPath }`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/watch-subagents.test.ts` (inside `describe("loading", () => { ... })`):

```ts
import { loadRun } from "../tools/watch-subagents.mjs"; // extend the import at top

describe("loading", () => {
 it("loadRun reads agent/model/cwd and paths from request files", () => {
  const dir = writeRun("pi-subagent-load", [
   {
    taskId: "task-1",
    status: makeStatus({ agent: "scout" }),
   },
   {
    taskId: "task-2",
    status: makeStatus({ taskId: "task-2", agent: "fetcher" }),
   },
  ]);
  const run = loadRun(dir);
  expect(run.session).toBe("pi-subagent-load");
  expect(run.tasks.map((t) => t.taskId)).toEqual(["task-1", "task-2"]);
  expect(run.tasks[0].agent).toBe("scout");
  expect(run.tasks[0].model).toBe("deepseek-v4-flash");
  expect(run.tasks[0].cwd).toBe("/work");
  expect(run.tasks[0].outputPath).toContain("output/task-1.jsonl");
  expect(run.tasks[0].statusPath).toContain("status/task-1.json");
 });

 it("loadRun falls back to derived paths and taskId agent without request files", () => {
  const dir = path.join(base, "pi-subagent-fallback");
  for (const sub of ["status", "output", "stderr", "request"]) {
   fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, "status", "task-1.json"), JSON.stringify(makeStatus({})));
  const run = loadRun(dir);
  expect(run.tasks).toHaveLength(1);
  expect(run.tasks[0].agent).toBe("task-1");
  expect(run.tasks[0].cwd).toBe("");
  expect(run.tasks[0].outputPath.endsWith("output/task-1.jsonl")).toBe(true);
 });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/watch-subagents.test.ts -t "loading"`

Expected: FAIL — `loadRun is not a function`.

- [ ] **Step 3: Implement `loadRun`**

Append to `tools/watch-subagents.mjs` (before the formatting section):

```js
// ---------- run loading ----------

/** Load a run's task metadata from its request files (paths, labels). */
export function loadRun(dir) {
 const requestDir = path.join(dir, "request");
 let requestFiles = [];
 try {
  requestFiles = fs
   .readdirSync(requestDir)
   .filter((f) => f.endsWith(".json"));
 } catch {
  // no request dir — fall back to status files below
 }
 const tasks = [];
 const seen = new Set();
 for (const file of requestFiles.sort()) {
  const taskId = path.basename(file, ".json");
  let agent = taskId;
  let model = "";
  let cwd = "";
  let statusPath = path.join(dir, "status", `${taskId}.json`);
  let outputPath = path.join(dir, "output", `${taskId}.jsonl`);
  let stderrPath = path.join(dir, "stderr", `${taskId}.log`);
  try {
   const req = JSON.parse(
    fs.readFileSync(path.join(requestDir, file), "utf8"),
   );
   if (req && typeof req === "object") {
    if (typeof req.agent === "string") agent = req.agent;
    if (typeof req.model === "string") model = req.model;
    if (typeof req.cwd === "string") cwd = req.cwd;
    if (typeof req.statusPath === "string") statusPath = req.statusPath;
    if (typeof req.outputPath === "string") outputPath = req.outputPath;
    if (typeof req.stderrPath === "string") stderrPath = req.stderrPath;
   }
  } catch {
   // unreadable request file — use derived paths
  }
  seen.add(taskId);
  tasks.push({ taskId, agent, model, cwd, statusPath, outputPath, stderrPath });
 }
 // status files without a request file (partial runs)
 const statusDir = path.join(dir, "status");
 let statusFiles = [];
 try {
  statusFiles = fs
   .readdirSync(statusDir)
   .filter((f) => f.endsWith(".json"));
 } catch {
  // no status dir — nothing to fall back to
 }
 for (const file of statusFiles) {
  const taskId = path.basename(file, ".json");
  if (seen.has(taskId)) continue;
  tasks.push({
   taskId,
   agent: taskId,
   model: "",
   cwd: "",
   statusPath: path.join(statusDir, file),
   outputPath: path.join(dir, "output", `${taskId}.jsonl`),
   stderrPath: path.join(dir, "stderr", `${taskId}.log`),
  });
 }
 tasks.sort((a, b) =>
  a.taskId.localeCompare(b.taskId, undefined, { numeric: true }),
 );
 return { dir, session: path.basename(dir), tasks };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/watch-subagents.test.ts -t "loading"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/watch-subagents.mjs tests/watch-subagents.test.ts
git commit -m "feat: watch-subagents loadRun"
```

---

### Task 3: Stream tailing

**Files:**

- Modify: `tools/watch-subagents.mjs` (add `createTailState`, `nextEvents`)
- Modify: `tests/watch-subagents.test.ts` (append tailing tests)

**Interfaces:**

- Consumes: nothing new (fs only).
- Produces (used by Tasks 4, 8 and the TUI):
  - `createTailState(): TailState` → `{ offset: 0, partial: "" }`.
  - `nextEvents(outputPath: string, state: TailState): { events: object[], state: TailState }` — read bytes after `state.offset`; split into lines; hold the trailing partial line in `state.partial`; parse each complete line as JSON (skip malformed); if the file shrank below `state.offset` (rewritten), reset to 0 and read from the top; missing file → `{ events: [], state }` unchanged.

- [ ] **Step 1: Write the failing tests**

Append to `tests/watch-subagents.test.ts`:

```ts
import { createTailState, nextEvents } from "../tools/watch-subagents.mjs"; // extend import

describe("tailing", () => {
 it("parses complete JSONL lines and advances the offset", () => {
  const file = path.join(base, "out.jsonl");
  fs.writeFileSync(file, '{"type":"message_update"}\n{"type":"tool_execution_start"}\n');
  const state = createTailState();
  const first = nextEvents(file, state);
  expect(first.events.map((e) => e.type)).toEqual(["message_update", "tool_execution_start"]);
  expect(state.offset).toBe(fs.statSync(file).size);
  expect(nextEvents(file, state).events).toEqual([]);
 });

 it("holds a partial line until it completes across reads", () => {
  const file = path.join(base, "out.jsonl");
  fs.writeFileSync(file, '{"type":"message_update","delta":"he');
  const state = createTailState();
  expect(nextEvents(file, state).events).toEqual([]);
  fs.appendFileSync(file, 'llo"}\n');
  const second = nextEvents(file, state);
  expect(second.events).toHaveLength(1);
  expect(second.events[0].delta).toBe("hello");
 });

 it("skips malformed lines but keeps parsing the rest", () => {
  const file = path.join(base, "out.jsonl");
  fs.writeFileSync(file, '{broken\n{"type":"message_end"}\n');
  const { events } = nextEvents(file, createTailState());
  expect(events.map((e) => e.type)).toEqual(["message_end"]);
 });

 it("returns empty for a missing file and recovers when it appears", () => {
  const file = path.join(base, "later.jsonl");
  const state = createTailState();
  expect(nextEvents(file, state).events).toEqual([]);
  fs.writeFileSync(file, '{"type":"message_update"}\n');
  expect(nextEvents(file, state).events).toHaveLength(1);
 });

 it("resets the offset when the file is truncated", () => {
  const file = path.join(base, "out.jsonl");
  fs.writeFileSync(file, '{"type":"message_update"}\n{"type":"message_end"}\n');
  const state = createTailState();
  nextEvents(file, state);
  fs.writeFileSync(file, '{"type":"message_update","delta":"rewritten"}\n');
  const { events } = nextEvents(file, state);
  expect(events).toHaveLength(1);
  expect(events[0].delta).toBe("rewritten");
 });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/watch-subagents.test.ts -t "tailing"`

Expected: FAIL — `nextEvents is not a function`.

- [ ] **Step 3: Implement tailing**

Append to `tools/watch-subagents.mjs`:

```js
// ---------- stream tailing ----------

export function createTailState() {
 return { offset: 0, partial: "" };
}

/** Read new JSONL lines from `outputPath` since `state.offset`. */
export function nextEvents(outputPath, state) {
 let size = 0;
 let text = "";
 try {
  const fd = fs.openSync(outputPath, "r");
  size = fs.fstatSync(fd).size;
  if (size < state.offset) state.offset = 0; // file rewritten
  if (size > state.offset) {
   const buf = Buffer.alloc(size - state.offset);
   fs.readSync(fd, buf, 0, buf.length, state.offset);
   text = buf.toString("utf8");
   state.offset = size;
  }
  fs.closeSync(fd);
 } catch {
  return { events: [], state }; // file not present yet
 }
 const events = [];
 if (text) {
  const lines = (state.partial + text).split("\n");
  state.partial = lines.pop() || "";
  for (const line of lines) {
   if (!line.trim()) continue;
   try {
    events.push(JSON.parse(line));
   } catch {
    // malformed line — skip, keep parsing
   }
  }
 }
 return { events, state };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/watch-subagents.test.ts -t "tailing"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/watch-subagents.mjs tests/watch-subagents.test.ts
git commit -m "feat: watch-subagents jsonl tailing"
```

---

### Task 4: Stream rendering

**Files:**

- Modify: `tools/watch-subagents.mjs` (add `createStreamState`, `accumulate`, `summarizeArgs`, `summarizeResult`, `truncate`, `renderFullOutput`)
- Modify: `tests/watch-subagents.test.ts` (append stream rendering tests)

**Interfaces:**

- Consumes: `nextEvents` (Task 3).
- Produces (used by Task 8 and the TUI):
  - `createStreamState(maxLines = 2000): StreamState` → `{ lines: [], current: "", maxLines }`.
  - `accumulate(acc: StreamState, event: unknown): void` — `message_update` deltas append to `acc.current`, split on `\n` into `acc.lines` (capped at `maxLines`); `tool_execution_start` pushes `[name] <summarizeArgs>`; `tool_execution_end` pushes `<summarizeResult>`; everything else ignored.
  - `summarizeArgs(args: unknown): string`, `summarizeResult(toolName: string, event: object): string`, private `truncate(s, n = 120)` — byte-compatible copies of the runner's versions.
  - `renderFullOutput(task: TaskInfo): string` — re-reads the whole jsonl and returns the full rendered text (used by the pager).

- [ ] **Step 1: Write the failing tests**

Append to `tests/watch-subagents.test.ts`:

```ts
import {
 createStreamState,
 accumulate,
 summarizeArgs,
 summarizeResult,
 renderFullOutput,
} from "../tools/watch-subagents.mjs"; // extend import

describe("stream rendering", () => {
 it("accumulate joins text deltas into lines and splits on newlines", () => {
  const acc = createStreamState();
  accumulate(acc, { type: "message_update", assistantMessageEvent: { delta: "Hel" } });
  accumulate(acc, { type: "message_update", assistantMessageEvent: { delta: "lo\nWorld" } });
  expect(acc.lines).toEqual(["Hello"]);
  expect(acc.current).toBe("World");
  accumulate(acc, { type: "message_update", assistantMessageEvent: { delta: "\n" } });
  expect(acc.lines).toEqual(["Hello", "World"]);
  expect(acc.current).toBe("");
 });

 it("accumulate renders tool start and end lines", () => {
  const acc = createStreamState();
  accumulate(acc, {
   type: "tool_execution_start",
   toolName: "web_lookup",
   args: { query: "mini pc prices", limit: 5 },
  });
  accumulate(acc, {
   type: "tool_execution_end",
   toolName: "web_lookup",
   result: {
    details: {
     results: [{ title: "A", url: "https://a" }],
     engines: ["exa"],
    },
   },
  });
  expect(acc.lines[0]).toContain("[web_lookup] query=\"mini pc prices\" limit=5");
  expect(acc.lines[1]).toContain("1 results [exa]");
 });

 it("accumulate caps lines at maxLines", () => {
  const acc = createStreamState(3);
  for (let i = 0; i < 10; i++) {
   accumulate(acc, { type: "message_update", assistantMessageEvent: { delta: `line${i}\n` } });
  }
  expect(acc.lines).toEqual(["line7", "line8", "line9"]);
 });

 it("summarizeArgs handles strings, numbers and truncation", () => {
  expect(summarizeArgs({ query: "hello", limit: 5 })).toBe('query="hello" limit=5');
  expect(summarizeArgs({ query: "x".repeat(200) })).toContain("…");
  expect(summarizeArgs(null)).toBe("");
 });

 it("summarizeResult reports errors and web results", () => {
  expect(
   summarizeResult("web_lookup", { isError: true, result: { error: "boom" } }),
  ).toBe("ERROR: boom");
  expect(
   summarizeResult("web_lookup", {
    result: { details: { results: [], engines: [] } },
   }),
  ).toContain("0 results");
 });

 it("renderFullOutput renders the complete stream", () => {
  const dir = path.join(base, "pi-subagent-full");
  for (const sub of ["status", "output", "stderr", "request"]) {
   fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  fs.writeFileSync(path.join(dir, "output", "task-1.jsonl"), [
   '{"type":"message_update","assistantMessageEvent":{"delta":"hello"}}',
   '{"type":"tool_execution_start","toolName":"read","args":{"path":"a.ts"}}',
   '{"type":"message_update","assistantMessageEvent":{"delta":"\\nworld"}}',
   "",
  ].join("\n"));
  const task = {
   taskId: "task-1",
   agent: "scout",
   model: "m",
   cwd: "",
   statusPath: path.join(dir, "status", "task-1.json"),
   outputPath: path.join(dir, "output", "task-1.jsonl"),
   stderrPath: path.join(dir, "stderr", "task-1.log"),
  };
  const text = renderFullOutput(task);
  expect(text).toContain("hello");
  expect(text).toContain("[read] path=a.ts");
  expect(text).toContain("world");
 });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/watch-subagents.test.ts -t "stream rendering"`

Expected: FAIL — `createStreamState is not a function`.

- [ ] **Step 3: Implement stream rendering**

Append to `tools/watch-subagents.mjs`:

```js
// ---------- stream rendering ----------

const truncate = (s, n = 120) =>
 typeof s === "string" && s.length > n ? s.slice(0, n) + "…" : s ?? "";

export function summarizeArgs(args) {
 if (!args || typeof args !== "object") return "";
 const parts = [];
 if (typeof args.query === "string") parts.push(`query="${truncate(args.query)}"`);
 if (typeof args.url === "string") parts.push(`url=${truncate(args.url)}`);
 if (typeof args.path === "string") parts.push(`path=${truncate(args.path)}`);
 if (args.limit) parts.push(`limit=${args.limit}`);
 if (args.engine) parts.push(`engine=${args.engine}`);
 if (typeof args.command === "string") parts.push(`cmd=${truncate(args.command)}`);
 return parts.join(" ");
}

export function summarizeResult(toolName, event) {
 const result = event.result;
 const details = result?.details;
 if (event.isError) return `ERROR: ${result?.error ?? "tool failed"}`;
 if (toolName === "web_lookup") {
  const results = Array.isArray(details?.results) ? details.results : [];
  const engines = details?.engines?.length
   ? details.engines.join(",")
   : "none";
  const head = results
   .slice(0, 2)
   .map((r) => `${r.title} — ${r.url}`)
   .join(" | ");
  const failures = details?.partialFailures?.length
   ? ` | failures: ${details.partialFailures.map((p) => p.engine).join(",")}`
   : "";
  return `${results.length} results [${engines}]${results.length ? " | " + truncate(head, 180) : ""}${failures}`;
 }
 if (toolName === "fetch_web") {
  const text = result?.content?.map((c) => c.text ?? "").join("") ?? "";
  return `"${truncate(details?.title ?? "(no title)", 80)}" ${text.length} chars`;
 }
 const text =
  result?.content
   ?.map((c) => c.text ?? "")
   .join(" ")
   .replace(/\s+/g, " ")
   .trim() ?? "";
 return truncate(text || "(no content)", 160);
}

export function createStreamState(maxLines = 2000) {
 return { lines: [], current: "", maxLines };
}

function pushLine(acc, line) {
 acc.lines.push(line);
 if (acc.lines.length > acc.maxLines) {
  acc.lines.splice(0, acc.lines.length - acc.maxLines);
 }
}

/** Fold one JSONL stream event into a renderable line buffer. */
export function accumulate(acc, event) {
 if (!event || typeof event !== "object") return;
 if (event.type === "message_update") {
  const delta = event.assistantMessageEvent?.delta;
  if (typeof delta === "string" && delta) {
   acc.current += delta;
   let idx;
   while ((idx = acc.current.indexOf("\n")) !== -1) {
    pushLine(acc, acc.current.slice(0, idx));
    acc.current = acc.current.slice(idx + 1);
   }
  }
 } else if (event.type === "tool_execution_start") {
  const name = event.toolName || event.toolCall?.name || "tool";
  const args = event.args ?? event.toolCall?.arguments ?? {};
  pushLine(acc, `[${name}]${summarizeArgs(args) ? " " + summarizeArgs(args) : ""}`);
 } else if (event.type === "tool_execution_end") {
  const name = event.toolName || "tool";
  pushLine(acc, `  ${summarizeResult(name, event)}`);
 }
}

/** Re-render a task's entire jsonl as plain text (for the pager). */
export function renderFullOutput(task) {
 const tail = createTailState();
 const stream = createStreamState(100000);
 const { events } = nextEvents(task.outputPath, tail);
 for (const event of events) accumulate(stream, event);
 const lines = [...stream.lines];
 if (stream.current) lines.push(stream.current);
 if (tail.partial) lines.push(tail.partial);
 return lines.join("\n") || "(no output)";
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/watch-subagents.test.ts -t "stream rendering"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/watch-subagents.mjs tests/watch-subagents.test.ts
git commit -m "feat: watch-subagents stream rendering"
```

---

### Task 5: Format helpers

**Files:**

- Modify: `tools/watch-subagents.mjs` (add `formatDuration`, `formatTokens`, `aggregateStats`, `formatStatus`)
- Modify: `tests/watch-subagents.test.ts` (append format tests)

**Interfaces:**

- Consumes: `formatAge` (Task 1), `TERMINAL_STATES` (Task 1).
- Produces (used by Tasks 6, 8 and the TUI):
  - `formatDuration(startedAt?: string, finishedAt?: string): string` — "42s", "3m12s", "1h5m"; "–" when `startedAt` is missing/unparseable; uses `Date.now()` when `finishedAt` is absent.
  - `formatTokens(n: number): string` — "856", "21.4k", "1.2M".
  - `aggregateStats(statuses: Array<object | null>): { counts, totalTokens, totalCost, turns }`.
  - `formatStatus(task: TaskInfo): string` — `task-2 · scout · RUNNING · 84s · 21.4k tok` (state uppercased; tokens omitted when absent).

- [ ] **Step 1: Write the failing tests**

Append to `tests/watch-subagents.test.ts`:

```ts
import {
 formatAge,
 formatDuration,
 formatTokens,
 aggregateStats,
 formatStatus,
} from "../tools/watch-subagents.mjs"; // extend import

describe("formatting", () => {
 it("formatAge handles seconds, minutes, hours", () => {
  expect(formatAge(42_000)).toBe("42s");
  expect(formatAge(3 * 60_000 + 12_000)).toBe("3m12s");
  expect(formatAge(65 * 60_000 + 5 * 60_000)).toBe("1h5m");
  expect(formatAge(-5)).toBe("0s");
 });

 it("formatDuration uses finishedAt when given, else now", () => {
  const start = "2026-08-07T10:00:00Z";
  const end = "2026-08-07T10:03:12Z";
  expect(formatDuration(start, end)).toBe("3m12s");
  expect(formatDuration(undefined, end)).toBe("–");
  expect(formatDuration("garbage")).toBe("–");
 });

 it("formatTokens", () => {
  expect(formatTokens(856)).toBe("856");
  expect(formatTokens(21_400)).toBe("21.4k");
  expect(formatTokens(1_200_000)).toBe("1.2M");
 });

 it("aggregateStats sums tokens, cost and counts states", () => {
  const statuses = [
   { state: "running", usage: { totalTokens: 1000, cost: { total: 0.01 }, turns: 2 } },
   { state: "succeeded", usage: { totalTokens: 500, cost: { total: 0.005 }, turns: 1 } },
   null,
   { state: "running" },
  ];
  const stats = aggregateStats(statuses);
  expect(stats.counts).toEqual({ running: 2, succeeded: 1 });
  expect(stats.totalTokens).toBe(1500);
  expect(stats.totalCost).toBeCloseTo(0.015);
  expect(stats.turns).toBe(3);
 });

 it("formatStatus includes state, duration and tokens", () => {
  const task = {
   taskId: "task-2",
   agent: "scout",
   model: "m",
   cwd: "",
   statusPath: "",
   outputPath: "",
   stderrPath: "",
   status: {
    state: "running",
    startedAt: new Date(Date.now() - 84_000).toISOString(),
    usage: { totalTokens: 21_400 },
   },
  };
  const line = formatStatus(task);
  expect(line).toContain("task-2 · scout · RUNNING");
  expect(line).toContain("84s");
  expect(line).toContain("21.4k tok");
 });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/watch-subagents.test.ts -t "formatting"`

Expected: FAIL — `formatDuration is not a function` (etc.).

- [ ] **Step 3: Implement format helpers**

Append to `tools/watch-subagents.mjs` (formatting section already has `formatAge`):

```js
// ---------- formatting ----------

export function formatDuration(startedAt, finishedAt) {
 const start = Date.parse(startedAt || "");
 if (Number.isNaN(start)) return "–";
 const end = finishedAt ? Date.parse(finishedAt) : Date.now();
 if (Number.isNaN(end)) return "–";
 return formatAge(end - start);
}

export function formatTokens(n) {
 if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
 if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
 return String(n);
}

export function aggregateStats(statuses) {
 const counts = {};
 let totalTokens = 0;
 let totalCost = 0;
 let turns = 0;
 for (const status of statuses) {
  if (!status) continue;
  counts[status.state] = (counts[status.state] || 0) + 1;
  totalTokens += status.usage?.totalTokens || 0;
  totalCost += status.usage?.cost?.total || 0;
  turns += status.usage?.turns || 0;
 }
 return { counts, totalTokens, totalCost, turns };
}

export function formatStatus(task) {
 const status = task.status;
 const state = status?.state || "unknown";
 const elapsed = formatDuration(status?.startedAt, status?.finishedAt);
 const tokens =
  status?.usage?.totalTokens
   ? ` · ${formatTokens(status.usage.totalTokens)} tok`
   : "";
 return `${task.taskId} · ${task.agent} · ${state.toUpperCase()} · ${elapsed}${tokens}`;
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/watch-subagents.test.ts -t "formatting"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/watch-subagents.mjs tests/watch-subagents.test.ts
git commit -m "feat: watch-subagents format helpers"
```

---

### Task 6: Grid + pane rendering

**Files:**

- Modify: `tools/watch-subagents.mjs` (add `computeGrid`, `truncateLine`, `renderTaskLines`)
- Modify: `tests/watch-subagents.test.ts` (append grid/pane tests)

**Interfaces:**

- Consumes: `formatStatus` (Task 5), `TERMINAL_STATES` (Task 1).
- Produces (used by Task 7 and the TUI):
  - `computeGrid(n: number): { cols, rows }` — `cols = max(1, ceil(√n))`, `rows = max(1, ceil(n/cols))`.
  - `truncateLine(s: string, width: number): string` — truncate to `width` (respecting astral characters via `Array.from`), append `…`; empty when `width <= 0`.
  - `renderTaskLines(task, stream, width, height, selected): { lines, title }` — line 0 is the title (`formatStatus`); terminal-status tasks show result/error text (succeeded → `status.result || "(no output)"`; failed/timed_out/cancelled → `errorMessage` + optional `Partial output:` section) instead of the stream; otherwise the last `height - 1` stream lines (or `"(no output yet)"`); pads to `height`; truncates each line to `width`. `title = { text, selected }`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/watch-subagents.test.ts`:

```ts
import {
 computeGrid,
 truncateLine,
 renderTaskLines,
 createStreamState,
 TERMINAL_STATES,
} from "../tools/watch-subagents.mjs"; // extend import

describe("grid and pane rendering", () => {
 it("computeGrid: 1,2,3,4,16", () => {
  expect(computeGrid(1)).toEqual({ cols: 1, rows: 1 });
  expect(computeGrid(2)).toEqual({ cols: 2, rows: 1 });
  expect(computeGrid(3)).toEqual({ cols: 2, rows: 2 });
  expect(computeGrid(4)).toEqual({ cols: 2, rows: 2 });
  expect(computeGrid(16)).toEqual({ cols: 4, rows: 4 });
 });

 it("truncateLine truncates and marks with ellipsis", () => {
  expect(truncateLine("hello", 3)).toBe("he…");
  expect(truncateLine("hello", 10)).toBe("hello");
  expect(truncateLine("hello", 0)).toBe("");
 });

 it("renderTaskLines: running task shows title + stream tail + padding", () => {
  const stream = createStreamState();
  stream.lines = ["a", "b", "c"];
  const task = {
   taskId: "task-1", agent: "scout", model: "m", cwd: "",
   statusPath: "", outputPath: "", stderrPath: "",
   status: { state: "running", startedAt: new Date(Date.now() - 1000).toISOString() },
  };
  const { lines, title } = renderTaskLines(task, stream, 40, 4, true);
  expect(lines).toHaveLength(4);
  expect(lines[0]).toContain("task-1 · scout · RUNNING");
  expect(lines[1]).toBe("b");
  expect(lines[2]).toBe("c");
  expect(lines[3]).toBe("");
  expect(title.selected).toBe(true);
 });

 it("renderTaskLines: succeeded task shows result, failed shows error", () => {
  const ok = {
   taskId: "task-1", agent: "a", model: "m", cwd: "",
   statusPath: "", outputPath: "", stderrPath: "",
   status: { state: "succeeded", startedAt: new Date().toISOString(), result: "done!\nnext line" },
  };
  const okRender = renderTaskLines(ok, createStreamState(), 40, 3, false);
  expect(okRender.lines[1]).toBe("done!");
  expect(okRender.lines[2]).toBe("next line");

  const bad = {
   taskId: "task-2", agent: "a", model: "m", cwd: "",
   statusPath: "", outputPath: "", stderrPath: "",
   status: { state: "failed", startedAt: new Date().toISOString(), errorMessage: "boom" },
  };
  const badRender = renderTaskLines(bad, createStreamState(), 40, 2, false);
  expect(badRender.lines[1]).toBe("boom");
 });

 it("renderTaskLines: empty stream shows placeholder", () => {
  const task = {
   taskId: "task-1", agent: "a", model: "m", cwd: "",
   statusPath: "", outputPath: "", stderrPath: "",
   status: { state: "starting", startedAt: new Date().toISOString() },
  };
  const { lines } = renderTaskLines(task, createStreamState(), 40, 2, false);
  expect(lines[1]).toBe("(no output yet)");
 });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/watch-subagents.test.ts -t "grid and pane rendering"`

Expected: FAIL — `computeGrid is not a function`.

- [ ] **Step 3: Implement grid + pane rendering**

Append to `tools/watch-subagents.mjs`:

```js
// ---------- grid and pane rendering ----------

export function computeGrid(n) {
 const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
 const rows = Math.max(1, Math.ceil(n / cols));
 return { cols, rows };
}

export function truncateLine(s, width) {
 if (width <= 0) return "";
 const chars = Array.from(s);
 return chars.length > width
  ? chars.slice(0, width - 1).join("") + "…"
  : s;
}

/** Render one task pane: title line + body; terminal tasks show result/error. */
export function renderTaskLines(task, stream, width, height, selected) {
 const title = truncateLine(formatStatus(task), width);
 let bodyLines;
 const status = task.status;
 if (status && TERMINAL_STATES.has(status.state)) {
  const text =
   status.state === "succeeded"
    ? status.result || "(no output)"
    : [
      status.errorMessage,
      status.result && `Partial output:\n${status.result}`,
     ]
      .filter(Boolean)
      .join("\n\n") || "(no output)";
  bodyLines = text.split("\n");
 } else if (stream.lines.length > 0) {
  bodyLines = stream.lines;
 } else {
  bodyLines = ["(no output yet)"];
 }
 const lines = [title];
 for (const line of bodyLines.slice(-Math.max(0, height - 1))) {
  if (lines.length >= height) break;
  lines.push(truncateLine(line, width));
 }
 while (lines.length < height) lines.push("");
 return { lines, title: { text: title, selected } };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/watch-subagents.test.ts -t "grid and pane rendering"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/watch-subagents.mjs tests/watch-subagents.test.ts
git commit -m "feat: watch-subagents grid and pane rendering"
```

---

### Task 7: Header + full frame + styles

**Files:**

- Modify: `tools/watch-subagents.mjs` (add `renderHeader`, `renderFrame`, `applyTuiStyles`)
- Modify: `tests/watch-subagents.test.ts` (append frame tests)

**Interfaces:**

- Consumes: `computeGrid`, `truncateLine`, `renderTaskLines` (Task 6), `aggregateStats`, `formatTokens` (Task 5), `LIVE_STATES` (Task 1).
- Produces (used by Task 8 and the TUI):
  - `renderHeader({ run, paused, live, width }): string[]` — 2 lines: `LIVE|ENDED  <session>  <state counts> · <tokens> · $<cost> [paused]` and the key-hint line.
  - `renderFrame({ run, streams, selected, paused, live, width, height }): { text, titles }` — full plain-text frame: header rows, then a grid of panes with `│`/`─` gutter/separator lines between them; `titles` records each pane's title cell (`{row, col, len, state, selected}`) for the color pass.
  - `applyTuiStyles(text, titles): string` — wraps each recorded title span with SGR codes: `\x1b[7m` when selected, else a state color (succeeded `32`, failed/timed_out/cancelled `31`, running `33`, starting/unknown `2`), resetting with `\x1b[0m`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/watch-subagents.test.ts`:

```ts
import {
 renderHeader,
 renderFrame,
 applyTuiStyles,
 loadRun,
} from "../tools/watch-subagents.mjs"; // extend import

describe("frame rendering", () => {
 function frameRun() {
  const dir = writeRun("pi-subagent-frame", [
   {
    taskId: "task-1",
    status: makeStatus({ state: "running", agent: "scout" }),
   },
   {
    taskId: "task-2",
    status: makeStatus({ taskId: "task-2", state: "succeeded", agent: "fetcher", result: "ok" }),
   },
   {
    taskId: "task-3",
    status: makeStatus({ taskId: "task-3", state: "running", agent: "judge" }),
   },
  ]);
  return loadRun(dir);
 }

 function withStatuses(run) {
  run.tasks[0].status = makeStatus({ state: "running", agent: "scout" });
  run.tasks[1].status = makeStatus({ taskId: "task-2", state: "succeeded", agent: "fetcher", result: "ok" });
  run.tasks[2].status = makeStatus({ taskId: "task-3", state: "running", agent: "judge" });
  return run;
 }

 it("renderHeader shows mode, session, counts and pause mark", () => {
  const run = withStatuses(frameRun());
  const header = renderHeader({ run, paused: true, live: true, width: 80 });
  expect(header[0]).toContain("LIVE");
  expect(header[0]).toContain("pi-subagent-frame");
  expect(header[0]).toContain("2 running");
  expect(header[0]).toContain("1 succeeded");
  expect(header[0]).toContain("[paused]");
  expect(header[1]).toContain("q quit");
 });

 it("renderFrame lays out a 2x2 grid with gutters, separators and titles", () => {
  const run = withStatuses(frameRun());
  const streams = new Map();
  for (const t of run.tasks) streams.set(t.taskId, createStreamState());
  const { text, titles } = renderFrame({
   run, streams, selected: 0, paused: false, live: true,
   width: 60, height: 12,
  });
  const lines = text.split("\n");
  expect(lines.length).toBe(12);
  expect(lines[0]).toContain("LIVE");
  expect(titles).toHaveLength(3);
  expect(titles[0].selected).toBe(true);
  expect(titles[1].selected).toBe(false);
  expect(titles[0].state).toBe("running");
  expect(titles[1].state).toBe("succeeded");
  // 3 tasks → rows=2, so one separator row at line 6 (2 header + 4 pane rows)
  expect(lines[6].includes("─")).toBe(true);
  // task-1 title appears at its recorded pane position (line stride 61)
  const at = titles[0].row * 61 + titles[0].col;
  expect(text.slice(at, at + 6)).toBe("task-1");
 });

 it("applyTuiStyles wraps the selected title in inverse video", () => {
  const run = withStatuses(frameRun());
  const streams = new Map();
  for (const t of run.tasks) streams.set(t.taskId, createStreamState());
  const { text, titles } = renderFrame({
   run, streams, selected: 0, paused: false, live: true,
   width: 60, height: 12,
  });
  const styled = applyTuiStyles(text, titles);
  expect(styled).toContain("\x1b[7m");
  expect(styled).toContain("\x1b[0m");
  expect(styled).toContain("task-1 · scout");
 });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/watch-subagents.test.ts -t "frame rendering"`

Expected: FAIL — `renderHeader is not a function`.

- [ ] **Step 3: Implement header + frame + styles**

Append to `tools/watch-subagents.mjs`:

```js
// ---------- frame rendering ----------

export function renderHeader({ run, paused, live, width }) {
 const stats = aggregateStats(
  run.tasks.map((task) => task.status ?? null),
 );
 const stateSummary =
  Object.entries(stats.counts)
   .map(([state, count]) => `${count} ${state}`)
   .join(", ") || "starting";
 const tokens = stats.totalTokens
  ? ` · ${formatTokens(stats.totalTokens)} tok`
  : "";
 const cost = stats.totalCost ? ` · $${stats.totalCost.toFixed(4)}` : "";
 const pauseMark = paused ? " [paused]" : "";
 const line1 = `${live ? "LIVE" : "ENDED"}  ${run.session}  ${stateSummary}${tokens}${cost}${pauseMark}`;
 const line2 =
  "j/k select · Enter: tmux attach (live) / pager (ended) · r pause · q quit";
 return [truncateLine(line1, width), truncateLine(line2, width)];
}

const put = (grid, width, height, r, c, ch) => {
 if (r >= 0 && r < height && c >= 0 && c < width) grid[r][c] = ch;
};

/** Render the whole screen as plain text + title metadata for styling. */
export function renderFrame({ run, streams, selected, paused, live, width, height }) {
 const header = renderHeader({ run, paused, live, width });
 const { cols, rows } = computeGrid(run.tasks.length);
 const bodyH = Math.max(1, height - header.length);
 const cellW = Math.max(1, Math.floor((width - (cols - 1)) / cols));
 const cellH = Math.max(1, Math.floor((bodyH - (rows - 1)) / rows));
 const grid = Array.from({ length: height }, () => Array(width).fill(" "));

 // header
 for (let r = 0; r < header.length; r++) {
  const chars = Array.from(header[r]);
  for (let c = 0; c < Math.min(chars.length, width); c++) grid[r][c] = chars[c];
 }

 // vertical gutters between pane columns
 for (let r = 0; r < bodyH; r++) {
  for (let c = 1; c < cols; c++) {
   put(grid, width, height, header.length + r, c * (cellW + 1) - 1, "│");
  }
 }
 // horizontal separators between pane rows
 for (let r = 1; r < rows; r++) {
  const y = header.length + r * (cellH + 1) - 1;
  for (let c = 0; c < width; c++) put(grid, width, height, y, c, "─");
 }
 // intersections
 for (let r = 1; r < rows; r++) {
  for (let c = 1; c < cols; c++) {
   put(grid, width, height, header.length + r * (cellH + 1) - 1, c * (cellW + 1) - 1, "┼");
  }
 }

 // panes
 const titles = [];
 for (let i = 0; i < run.tasks.length; i++) {
  const col = i % cols;
  const row = Math.floor(i / cols);
  const x = col * (cellW + 1);
  const y = header.length + row * (cellH + 1);
  const task = run.tasks[i];
  const { lines, title } = renderTaskLines(
   task,
   streams.get(task.taskId) ?? createStreamState(),
   cellW,
   cellH,
   i === selected,
  );
  for (let r = 0; r < lines.length; r++) {
   const chars = Array.from(lines[r]);
   for (let c = 0; c < Math.min(chars.length, cellW); c++) {
    put(grid, width, height, y + r, x + c, chars[c]);
   }
  }
  titles.push({
   row: y,
   col: x,
   len: Array.from(title.text).length,
   state: (task.status && task.status.state) || "unknown",
   selected: i === selected,
  });
 }

 const text = grid
  .map((line) => line.join("").replace(/\s+$/, ""))
  .join("\n");
 return { text, titles };
}

const STATE_COLOR = {
 succeeded: "32",
 failed: "31",
 timed_out: "31",
 cancelled: "31",
 running: "33",
 starting: "2",
 unknown: "2",
};

/** Apply SGR styling to the title spans of a plain frame. */
export function applyTuiStyles(text, titles) {
 const lines = text.split("\n");
 for (const t of titles) {
  const line = lines[t.row];
  if (!line) continue;
  const start = Math.min(t.col, line.length);
  const end = Math.min(start + t.len, line.length);
  const code = t.selected ? "7" : STATE_COLOR[t.state] || "0";
  lines[t.row] =
   line.slice(0, start) +
   `\x1b[${code}m` +
   line.slice(start, end) +
   "\x1b[0m" +
   line.slice(end);
 }
 return lines.join("\n");
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/watch-subagents.test.ts -t "frame rendering"`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/watch-subagents.mjs tests/watch-subagents.test.ts
git commit -m "feat: watch-subagents frame rendering"
```

---

### Task 8: TUI main (live watch + replay + keys)

**Files:**

- Modify: `tools/watch-subagents.mjs` — replace the placeholder `isMainModule` block (Task 1) with the real TUI: `main`, `chooseRun`, `tui`, `openTask`, `enterTui`/`restoreTerminal`, `runProcess`, `runPager`. Add `node:child_process`, `node:readline` imports.
- Modify: `tests/watch-subagents.test.ts` — no new unit tests here (TUI is manual); keep the suite green.

**Interfaces:**

- Consumes: everything from Tasks 1–7: `findRuns`, `resolveRunArg`, `listRunsText`, `loadRun`, `readStatus`, `createTailState`, `nextEvents`, `createStreamState`, `accumulate`, `renderFullOutput`, `renderFrame`, `applyTuiStyles`, `LIVE_STATES`.
- Produces: the `watch-subagents` command behavior (see spec): no-arg → picker/most-recent; `<suffix>` / dir → that run; `-l` → list and exit; keys `j`/`k`/arrows select, `Enter` attach (live) or pager (ended), `r` pause, `q` quit; 500 ms poll, forced 1 s tick for elapsed; clean terminal restore on exit/Ctrl-C/resize.

- [ ] **Step 1: Replace the placeholder guard with the real TUI**

Replace the Task 1 `isMainModule` block (`import("./main.ts").catch(...)`) with:

```js
// ---------- TUI ----------

import { spawn } from "node:child_process";
import * as readline from "node:readline";

const REFRESH_MS = 500;
const TICK_MS = 1000;

function enterTui() {
 process.stdout.write("\x1b[?1049h\x1b[?25l"); // alternate screen, hide cursor
 process.stdin.setRawMode(true);
 process.stdin.resume();
}

function restoreTerminal() {
 process.stdout.write("\x1b[?25h\x1b[?1049l"); // show cursor, leave alt screen
 try {
  process.stdin.setRawMode(false);
 } catch {
  // stdin not a TTY
 }
 process.stdin.pause();
}

async function chooseRun(runs) {
 if (runs.length <= 1) return runs[0] || null;
 if (!process.stdin.isTTY) return runs[0];
 const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
 });
 process.stdout.write(
  listRunsText(runs) +
   `\n\nSelect run 1-${runs.length} (Enter = most recent): `,
 );
 return new Promise((resolve) => {
  rl.question("", (answer) => {
   rl.close();
   const n = parseInt(answer.trim(), 10);
   if (Number.isNaN(n) || n < 1 || n > runs.length) resolve(runs[0]);
   else resolve(runs[n - 1]);
  });
 });
}

function runProcess(cmd, args) {
 return new Promise((resolve) => {
  let child;
  try {
   child = spawn(cmd, args, { stdio: "inherit" });
  } catch {
   resolve();
   return;
  }
  child.on("exit", () => resolve());
  child.on("error", () => resolve());
 });
}

function runPager(text) {
 return new Promise((resolve) => {
  const child = spawn("less", ["-R"], { stdio: ["pipe", "inherit", "inherit"] });
  child.on("exit", () => resolve());
  child.on("error", () => {
   process.stdout.write(text + "\n");
   resolve();
  });
  child.stdin.on("error", () => {});
  child.stdin.write(text);
  child.stdin.end();
 });
}

async function openTask(run, task) {
 restoreTerminal();
 const status = task.status;
 const isLive = !status || LIVE_STATES.has(status.state);
 if (isLive) {
  await runProcess("tmux", ["attach", "-t", run.session]);
 } else {
  await runPager(renderFullOutput(task));
 }
 enterTui();
}

async function tui(runInfo) {
 const run = loadRun(runInfo.dir);
 const tailers = new Map();
 const streams = new Map();
 for (const task of run.tasks) {
  tailers.set(task.taskId, createTailState());
  streams.set(task.taskId, createStreamState());
 }
 let selected = 0;
 let paused = false;
 let live = runInfo.live;
 let lastDraw = 0;

 const onExit = () => {
  restoreTerminal();
  process.exit(0);
 };
 process.on("SIGINT", onExit);
 process.on("SIGTERM", onExit);
 if (process.stdout.on) process.stdout.on("resize", () => tick(true));

 process.stdin.setRawMode(true);
 process.stdin.resume();
 enterTui();

 let keyBuf = "";
 const n = run.tasks.length;
 const tick = (force = false) => {
  let changed = false;
  for (const task of run.tasks) {
   task.status = readStatus(task.statusPath);
   const { events } = nextEvents(task.outputPath, tailers.get(task.taskId));
   for (const event of events) accumulate(streams.get(task.taskId), event);
   if (events.length) changed = true;
  }
  live = run.tasks.some((task) => {
   const s = task.status;
   return !s || LIVE_STATES.has(s.state);
  });
  const now = Date.now();
  if (!changed && !force && now - lastDraw < TICK_MS) return;
  lastDraw = now;
  const [w, h] =
   process.stdout.getWindowSize
    ? process.stdout.getWindowSize()
    : [80, 24];
  const { text, titles } = renderFrame({
   run,
   streams,
   selected,
   paused,
   live,
   width: Math.max(1, w),
   height: Math.max(1, h),
  });
  process.stdout.write("\x1b[H" + applyTuiStyles(text, titles));
 };

 process.stdin.on("data", (chunk) => {
  keyBuf += chunk.toString();
  while (keyBuf.length > 0) {
   if (keyBuf.startsWith("\x1b[A") || keyBuf.startsWith("\x1b[B")) {
    const up = keyBuf.startsWith("\x1b[A");
    keyBuf = keyBuf.slice(3);
    selected = up
     ? (selected - 1 + n) % n
     : (selected + 1) % n;
    tick(true);
    continue;
   }
   const ch = keyBuf[0];
   keyBuf = keyBuf.slice(1);
   if (ch === "q") {
    onExit();
   } else if (ch === "r") {
    paused = !paused;
    tick(true);
   } else if (ch === "j") {
    selected = (selected + 1) % n;
    tick(true);
   } else if (ch === "k") {
    selected = (selected - 1 + n) % n;
    tick(true);
   } else if (ch === "\r" || ch === "\n") {
    openTask(run, run.tasks[selected]).then(() => tick(true));
   }
  }
 });

 tick(true);
 setInterval(() => tick(false), REFRESH_MS);
}

async function main(argv) {
 const args = argv.slice(2);
 if (args.includes("-l") || args.includes("--list")) {
  process.stdout.write(listRunsText(findRuns()) + "\n");
  return;
 }
 if (args.includes("-h") || args.includes("--help")) {
  process.stdout.write(
   "usage: watch-subagents [-l] [<session-suffix> | <run-dir>]\n" +
    "  no args  pick most recent run (picker when several)\n" +
    "  -l       list runs and exit\n" +
    "  <suffix> match a pi-subagent-* session name\n" +
    "  <dir>    replay a retained artifacts dir\n",
  );
  return;
 }
 const target = args[0];
 let runInfo;
 if (target) {
  const resolved = resolveRunArg(target);
  if (resolved.error) {
   process.stderr.write(resolved.error + "\n");
   process.exit(2);
  }
  runInfo = resolved.run;
 } else {
  const runs = findRuns();
  if (runs.length === 0) {
   process.stderr.write(
    "No subagent runs found.\n" +
     'Start one with run_subagents, or pass a retained artifacts dir (retain_artifacts: "always").\n',
   );
   process.exit(1);
  }
  runInfo = await chooseRun(runs);
 }
 if (!runInfo) process.exit(1);
 await tui(runInfo);
}

const isMainModule =
 process.argv[1] === fileURLToPath(import.meta.url) ||
 process.argv[1]?.endsWith("/tools/watch-subagents.mjs");

if (isMainModule) {
 main(process.argv).catch((error) => {
  restoreTerminal();
  process.stderr.write((error && error.message) || String(error) + "\n");
  process.exit(1);
 });
}
```

> Note: `import` statements in ESM hoist — put the two new imports (`node:child_process`, `node:readline`) at the top of the file with the others, not mid-file; the mid-file comment is only a marker for where the TUI section starts.

- [ ] **Step 2: Run the full test suite to confirm the module still imports cleanly**

Run: `npx vitest run tests/watch-subagents.test.ts`

Expected: PASS (all tests from Tasks 1–7; TUI code is guarded and not exercised).

- [ ] **Step 3: Manual verification — live watch**

In one terminal:

```bash
cd /home/pirackr/Working/grinder/pi-extensions
node tools/watch-subagents.mjs -l   # lists runs (or the "none" hint)
```

Then start a real run (from a pi session, call `run_subagents` with 2 tasks, e.g. `scout` + `worker`, timeout 120 s). While it runs, in another terminal:

```bash
node tools/watch-subagents.mjs       # most recent run → picker if several
```

Verify: header shows `LIVE`, both agents visible in one screen, streams update ~every 500 ms, `j`/`k` move selection (title inverts), `Enter` attaches to the tmux session (detach with `Ctrl-b d`, returns to dashboard), `r` pauses/resumes, `q` restores the terminal cleanly. Resize the terminal (`Ctrl-b d`… or `printf '\e[8;30;100t'` in an xterm) and confirm the frame reflows.

- [ ] **Step 4: Manual verification — replay**

Run `run_subagents` with `retain_artifacts: "always"`, note the artifact path from the tool result, wait for completion, then:

```bash
node tools/watch-subagents.mjs <retained-dir>
```

Verify: header shows `ENDED`, all agents' panes show their final result/error text, `Enter` on a pane opens the full output in `less`, `q` quits.

- [ ] **Step 5: Commit**

```bash
git add tools/watch-subagents.mjs
git commit -m "feat: watch-subagents TUI main"
```

---

### Task 9: Shim + docs

**Files:**

- Create: `tools/watch-subagents` (shell shim)
- Modify: `AGENTS.md` (usage note)
- Modify: `tests/watch-subagents.test.ts` — no change; suite must stay green.

- [ ] **Step 1: Create the shim**

`tools/watch-subagents`:

```bash
#!/bin/sh
exec node "$(dirname "$0")/watch-subagents.mjs" "$@"
```

Make it executable: `chmod +x tools/watch-subagents`.

Verify: `tools/watch-subagents -l` prints the listing (or the no-runs hint).

- [ ] **Step 2: Update AGENTS.md**

Append to `/home/pirackr/Working/grinder/pi-extensions/AGENTS.md`:

```markdown
## watch-subagents

- `tools/watch-subagents.mjs` — standalone TUI dashboard: watch all agents of a
  `run_subagents` batch in one screen, live or replayed. Zero deps, `node` only.
- Run it: `tools/watch-subagents` (or symlink:
  `ln -s ~/Working/grinder/pi-extensions/tools/watch-subagents ~/.local/bin/`).
- Usage: no args = most recent run (picker when several); `<suffix>` matches a
  `pi-subagent-*` session; a directory path replays retained artifacts.
  Keys: `j`/`k` select, `Enter` tmux-attach (live) / `less` pager (ended),
  `r` pause, `q` quit.
- Replay needs `retain_artifacts: "always"` (or `"on_failure"` for failed
  runs); pass the retained dir as the argument. Artifacts under
  `/tmp/pi-subagent-*` are deleted by the extension when a run completes
  unless retained — live watch works while the run is in flight.
```

- [ ] **Step 3: Run the full suite + smoke test**

Run: `npx vitest run`

Expected: PASS (existing suite + new `tests/watch-subagents.test.ts`).

Smoke: `tools/watch-subagents -l` and `node tools/watch-subagents.mjs --help` both behave.

- [ ] **Step 4: Commit**

```bash
git add tools/watch-subagents AGENTS.md
git commit -m "docs: watch-subagents shim + AGENTS.md usage"
```

---

## Self-Review

**Spec coverage:** discovery ✓ (Task 1), run loading ✓ (Task 2), stream tailing with partial-line hold ✓ (Task 3), stream rendering + runner-compatible summarizers ✓ (Task 4), status/duration/token/cost formatting ✓ (Task 5), grid math (1/2/3/4/16) + pane rendering with terminal-result bodies ✓ (Task 6), header + frame + title styling + selection ✓ (Task 7), invocation modes (`-l`, no-arg picker, suffix, dir replay) + keys (j/k/arrows/Enter/r/q) + 500 ms poll + forced 1 s tick + resize + clean restore + tmux attach + less pager ✓ (Task 8), shim + symlink + AGENTS.md note ✓ (Task 9). No-extension-change constraint ✓ (no task touches `extensions/` or config). Zero-dependency constraint ✓ (built-ins only).

**Placeholder scan:** the only temporary code is the Task 1 `import("./main.ts")` guard, explicitly replaced in Task 8 Step 1 — no other TBD/TODO remains.

**Type consistency:** signatures match `tools/watch-subagents.d.mts` throughout — `findRuns(baseDir?)`, `inspectDir(dir)`, `resolveRunArg(arg)` → `{run, error}`, `nextEvents(path, state)` → `{events, state}`, `renderTaskLines(...)` → `{lines, title}`, `renderFrame(...)` → `{text, titles}`, `applyTuiStyles(text, titles)`. Task 8 consumes only names defined in Tasks 1–7.
