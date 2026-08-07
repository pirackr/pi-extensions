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
	loadRun,
	createTailState,
	nextEvents,
	createStreamState,
	accumulate,
	summarizeArgs,
	summarizeResult,
	renderFullOutput,
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
		fs.writeFileSync(
			path.join(dir, "request", `${t.taskId}.json`),
			JSON.stringify({
				taskId: t.taskId,
				agent: t.status.agent,
				model: t.status.model,
				cwd: "/work",
				statusPath: path.join(dir, "status", `${t.taskId}.json`),
				outputPath: path.join(dir, "output", `${t.taskId}.jsonl`),
				stderrPath: path.join(dir, "stderr", `${t.taskId}.log`),
			}),
		);
	}
	return dir;
}

describe("discovery", () => {
	it("findRuns finds fixture runs and sorts most-recent first", () => {
		writeRun("pi-subagent-old", [
			{
				taskId: "task-1",
				status: makeStatus({
					state: "succeeded",
					startedAt: "2026-08-07T09:00:00Z",
				}),
			},
		]);
		writeRun("pi-subagent-new", [
			{
				taskId: "task-1",
				status: makeStatus({
					state: "running",
					startedAt: "2026-08-07T11:00:00Z",
				}),
			},
		]);
		const runs = findRuns(base);
		expect(runs.map((r) => r.session)).toEqual([
			"pi-subagent-new",
			"pi-subagent-old",
		]);
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
			{
				taskId: "task-2",
				status: makeStatus({ state: "succeeded", taskId: "task-2" }),
			},
		]);
		const text = listRunsText(findRuns(base));
		expect(text).toContain("pi-subagent-a");
		expect(text).toContain("1 running");
		expect(text).toContain("1 succeeded");
		expect(text).toContain("●");
	});

	it("resolveRunArg: no arg picks most recent", () => {
		writeRun("pi-subagent-b", [
			{
				taskId: "task-1",
				status: makeStatus({ startedAt: "2026-08-07T08:00:00Z" }),
			},
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
		expect(resolveRunArg(path.join(base, "nope"), base).error).toContain(
			"not a subagent run dir",
		);
	});

	it("resolveRunArg: suffix arg matches session names", () => {
		writeRun("pi-subagent-abc123", [
			{ taskId: "task-1", status: makeStatus({}) },
		]);
		const { run } = resolveRunArg("abc123", base);
		expect(run?.session).toBe("pi-subagent-abc123");
		expect(resolveRunArg("zzz", base).error).toContain("no run matching");
	});

	it("LIVE_STATES contains starting and running", () => {
		expect(LIVE_STATES.has("starting")).toBe(true);
		expect(LIVE_STATES.has("running")).toBe(true);
	});
});
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
		fs.writeFileSync(
			path.join(dir, "status", "task-1.json"),
			JSON.stringify(makeStatus({})),
		);
		const run = loadRun(dir);
		expect(run.tasks).toHaveLength(1);
		expect(run.tasks[0].agent).toBe("task-1");
		expect(run.tasks[0].cwd).toBe("");
		expect(run.tasks[0].outputPath.endsWith("output/task-1.jsonl")).toBe(true);
	});
});
describe("tailing", () => {
	it("parses complete JSONL lines and advances the offset", () => {
		const file = path.join(base, "out.jsonl");
		fs.writeFileSync(
			file,
			'{"type":"message_update"}\n{"type":"tool_execution_start"}\n',
		);
		const state = createTailState();
		const first = nextEvents(file, state);
		expect(first.events.map((e) => e.type)).toEqual([
			"message_update",
			"tool_execution_start",
		]);
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
		fs.writeFileSync(file, "{broken\n{\"type\":\"message_end\"}\n");
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
		fs.writeFileSync(
			file,
			'{"type":"message_update"}\n{"type":"message_end"}\n',
		);
		const state = createTailState();
		nextEvents(file, state);
		fs.writeFileSync(file, '{"type":"message_update","delta":"rewritten"}\n');
		const { events } = nextEvents(file, state);
		expect(events).toHaveLength(1);
		expect(events[0].delta).toBe("rewritten");
	});
});
describe("stream rendering", () => {
	it("accumulate joins text deltas into lines and splits on newlines", () => {
		const acc = createStreamState();
		accumulate(acc, {
			type: "message_update",
			assistantMessageEvent: { delta: "Hel" },
		});
		accumulate(acc, {
			type: "message_update",
			assistantMessageEvent: { delta: "lo\nWorld" },
		});
		expect(acc.lines).toEqual(["Hello"]);
		expect(acc.current).toBe("World");
		accumulate(acc, {
			type: "message_update",
			assistantMessageEvent: { delta: "\n" },
		});
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
		expect(acc.lines[0]).toContain('query="mini pc prices" limit=5');
		expect(acc.lines[1]).toContain("1 results [exa]");
	});

	it("accumulate caps lines at maxLines", () => {
		const acc = createStreamState(3);
		for (let i = 0; i < 10; i++) {
			accumulate(acc, {
				type: "message_update",
				assistantMessageEvent: { delta: `line${i}\n` },
			});
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
			summarizeResult("web_lookup", {
				isError: true,
				result: { error: "boom" },
			}),
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
		fs.writeFileSync(
			path.join(dir, "output", "task-1.jsonl"),
			[
				'{"type":"message_update","assistantMessageEvent":{"delta":"hello"}}',
				'{"type":"tool_execution_start","toolName":"read","args":{"path":"a.ts"}}',
				'{"type":"message_update","assistantMessageEvent":{"delta":"\\nworld"}}',
				"",
			].join("\n"),
		);
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
