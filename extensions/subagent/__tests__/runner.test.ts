// Deterministic fake-child tests for the standalone Pi RPC runner.
//
// These tests never start a real Pi or tmux process. Every side effect is
// injected through {@link RunnerDeps}: a fake `spawn` returning an
// EventEmitter-based child, a controllable clock, a process-group kill spy,
// and writable stdout/stderr spies. Real temporary artifact files are used for
// the durable records so publication order and strict JSONL durability can be
// verified on disk. No arbitrary sleeps: the injected clock drives timeout /
// grace / cancel / fallback timers and fs completes through a `drain()` helper.

import { describe, it, expect, vi, afterEach } from "vitest";

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";

import type { RunnerDeps, RunnerRequest } from "../runner.d.mts";

const mod = await import("../runner.mjs");
const runTaskMode = mod.runTaskMode;

// --------------------------------------------------------------------------
// Injected test doubles
// --------------------------------------------------------------------------

interface ClockHandle {
	clock: RunnerDeps["clock"];
	advance: (ms: number) => void;
	runPending: () => void;
	pending: () => number;
}

function createClock(start = 1_000): ClockHandle {
	let now = start;
	const timers = new Map<number, { cb: () => void; dueAt: number }>();
	let nextId = 1;
	return {
		clock: {
			now: () => now,
			setTimeout: (cb: () => void, ms: number) => {
				const id = nextId++;
				timers.set(id, { cb, dueAt: now + ms });
				return { id } as unknown as NodeJS.Timeout;
			},
			clearTimeout: (id: unknown) => {
				const { id: realId } = id as { id: number };
				timers.delete(realId);
			},
		},
		advance: (ms: number) => {
			now += ms;
		},
		runPending: () => {
			const ready = [...timers.entries()]
				.filter(([, timer]) => timer.dueAt <= now)
				.sort((left, right) => left[1].dueAt - right[1].dueAt);
			for (const [id] of ready) timers.delete(id);
			for (const [, timer] of ready) timer.cb();
		},
		pending: () => timers.size,
	};
}

class FakeStdin {
	writes: string[] = [];
	ended = false;
	write(data: string): boolean {
		this.writes.push(data);
		return true;
	}
	end(): void {
		this.ended = true;
	}
}

class FakeChild extends EventEmitter {
	pid: number;
	stdin = new FakeStdin();
	stdout = new EventEmitter();
	stderr = new EventEmitter();
	kills: Array<[number, NodeJS.Signals]> = [];
	constructor(pid: number) {
		super();
		this.pid = pid;
	}
	kill(signal: NodeJS.Signals): void {
		this.kills.push([this.pid, signal]);
	}
	emitError(error: Error): void {
		this.emit("error", error);
	}
}

function createFakeSpawn() {
	const made: FakeChild[] = [];
	const fn = vi.fn(
		(_command: string, _args: string[], _options: Record<string, unknown>) => {
			const child = new FakeChild(10_000 + made.length);
			made.push(child);
			return child;
		},
	);
	return { fn, made };
}

// --------------------------------------------------------------------------
// Request fixtures + temp dirs
// --------------------------------------------------------------------------

const BASE_REQUEST: RunnerRequest = {
	schema: 1,
	parentId: "pi01",
	agentId: "q9xm",
	parentAgentId: null,
	origin: "origin-uuid",
	groupId: null,
	sequence: 7,
	queuedAt: 42,
	description: "scout",
	prompt: "Investigate the wiring.",
	artifactRoot: "/tmp/slug/pi-pi01",
	cwd: process.cwd(),
	profile: {
		model: "gpt-4o",
		thinking: "medium",
		tools: ["read", "web_lookup"],
		systemPrompt: "You are a scout.",
		timeoutSeconds: 300,
	},
	pi: {
		command: "/usr/local/bin/pi",
		args: ["--prefix"],
	},
	childExtensions: ["extensions/research"],
	loadContextFiles: false,
	webSearchMaxLookups: 5,
	webSearchMaxFetches: 3,
	reservation: null,
};

function makeRequest(overrides: Partial<RunnerRequest> = {}): RunnerRequest {
	return {
		...BASE_REQUEST,
		...overrides,
		profile: { ...BASE_REQUEST.profile, ...(overrides.profile ?? {}) },
		pi: { ...BASE_REQUEST.pi, ...(overrides.pi ?? {}) },
	} as RunnerRequest;
}

function writeTempRequest(request: RunnerRequest): {
	dir: string;
	requestPath: string;
} {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "runner-"));
	DIRS.push(dir);
	const requestPath = path.join(dir, "request.json");
	fs.writeFileSync(requestPath, JSON.stringify(request, null, 2));
	return { dir, requestPath };
}

function tempDeps(
	_dir: string,
	clock: ClockHandle,
	kill: ReturnType<typeof vi.fn>,
	stdout: ReturnType<typeof vi.fn>,
	stderr: ReturnType<typeof vi.fn>,
	onWrite: RunnerDeps["onWrite"],
): RunnerDeps {
	return {
		clock: clock.clock,
		killProcessGroup: kill,
		onWrite,
		killGraceMs: 1_000,
		statsFallbackMs: 500,
		cancelPollMs: 20,
		stdout: { write: stdout },
		stderr: { write: stderr },
	};
}

async function drain(): Promise<void> {
	for (let i = 0; i < 12; i++) {
		await Promise.resolve();
	}
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
}

function readStatus(dir: string): Record<string, unknown> {
	return JSON.parse(
		fs.readFileSync(path.join(dir, "status.json"), "utf8"),
	) as Record<string, unknown>;
}

function readResult(dir: string): Record<string, unknown> {
	return JSON.parse(
		fs.readFileSync(path.join(dir, "result.json"), "utf8"),
	) as Record<string, unknown>;
}

const DIRS: string[] = [];

let made: FakeChild[] = [];
let depsForTest: RunnerDeps;

afterEach(() => {
	// Best-effort cleanup of temp dirs created during the suite.
	while (DIRS.length) {
		const dir = DIRS.pop();
		if (dir) fs.rmSync(dir, { recursive: true, force: true });
	}
});

// --------------------------------------------------------------------------
// 1. Module / type contract + plain node runner.mjs direct-runnability
// --------------------------------------------------------------------------

describe("1. plain node runner.mjs direct-runnability", () => {
	it("exports runTaskMode and main functions", () => {
		expect(typeof runTaskMode).toBe("function");
		expect(typeof mod.main).toBe("function");
	});

	it("loads under plain Node and reports usage without a request", () => {
		const result = spawnSync(
			process.execPath,
			[path.resolve(import.meta.dirname, "../runner.mjs")],
			{ encoding: "utf8" },
		);
		expect(result.status).toBe(2);
		expect(result.stderr).toContain("Usage: node runner.mjs <request.json>");
	});
});

// --------------------------------------------------------------------------
// 2. Spawn argument / env
// --------------------------------------------------------------------------

describe("2. spawn argument / env", () => {
	it("spawns with prompt/system/model/thinking/tools/extensions/context/web budgets, detached group, shell:false", async () => {
		const { fn, made: made0 } = createFakeSpawn();
		const { dir, requestPath } = writeTempRequest(makeRequest());
		made = made0;
		const kill = vi.fn();
		const stdout = vi.fn(() => true);
		const stderr = vi.fn(() => true);
		const clock = createClock();
		const deps = tempDeps(dir, clock, kill, stdout, stderr, undefined);
		deps.spawn = fn;

		const done = runTaskMode(requestPath, deps);
		await drain();

		const [command, args, opts] = fn.mock.calls[0] as [
			string,
			string[],
			Record<string, unknown>,
		];
		expect(command).toBe("/usr/local/bin/pi");
		expect(args[0]).toBe("--prefix");
		expect(args).toEqual(
			expect.arrayContaining([
				"--mode",
				"rpc",
				"--no-session",
				"--no-extensions",
				"--extension",
				"extensions/research",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--no-context-files",
				"--model",
				"gpt-4o",
				"--thinking",
				"medium",
				"--tools",
				"read,web_lookup",
				"--web-search-max-lookups",
				"5",
				"--web-search-max-fetches",
				"3",
				"--append-system-prompt",
				"You are a scout.",
			]),
		);
		expect(opts).toEqual(
			expect.objectContaining({
				cwd: BASE_REQUEST.cwd,
				detached: true,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
			}),
		);
		made[0].emit("close", 1);
		await done;
	});

	it("sets PI_SUBAGENT, parent/agent IDs, artifact-root env, preserving inherited env", async () => {
		const { fn, made: made0 } = createFakeSpawn();
		const { dir, requestPath } = writeTempRequest(makeRequest());
		made = made0;
		const kill = vi.fn();
		const stdout = vi.fn(() => true);
		const stderr = vi.fn(() => true);
		const clock = createClock();
		const deps = tempDeps(dir, clock, kill, stdout, stderr, undefined);
		deps.spawn = fn;

		const originalEnv = { ...process.env };
		process.env = {
			...originalEnv,
			PI_SUBAGENT: "0",
			EXTRA: "yes",
		};

		const done = runTaskMode(requestPath, deps);
		await drain();

		const [, , opts] = fn.mock.calls[0] as [
			string,
			string[],
			Record<string, unknown>,
		];
		expect(opts.env).toMatchObject({
			PI_SUBAGENT: "1",
			PI_SUBAGENT_PARENT: "pi01",
			PI_SUBAGENT_AGENT: "q9xm",
			PI_SUBAGENT_ARTIFACT_ROOT: "/tmp/slug/pi-pi01",
			EXTRA: "yes",
		});
		process.env = originalEnv;
		made[0].emit("close", 1);
		await done;
	});
});

// --------------------------------------------------------------------------
// 3. Strict LF JSONL
// --------------------------------------------------------------------------

describe("3. strict LF JSONL", () => {
	it("splits at byte-decoded LF, strips one trailing CR, retains U+2028/U+2029, processes final unterminated record", async () => {
		const { fn, made: made0 } = createFakeSpawn();
		const { dir, requestPath } = writeTempRequest(makeRequest());
		made = made0;
		const kill = vi.fn();
		const stdout = vi.fn(() => true);
		const stderr = vi.fn(() => true);
		const clock = createClock();
		const deps = tempDeps(dir, clock, kill, stdout, stderr, undefined);
		deps.spawn = fn;

		const done = runTaskMode(requestPath, deps);
		await drain();
		const child = made[0] as FakeChild;

		child.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					type: "response",
					id: "runner-1",
					success: true,
					data: { model: { contextWindow: 200_000 } },
				}) + "\n",
			),
		);

		const U = "a\u2028b";
		const toolLine = JSON.stringify({
			type: "tool_execution_start",
			toolName: "bash",
			args: { command: U },
		});
		const raw = Buffer.from(toolLine, "utf8");
		const cutAt = raw.indexOf(Buffer.from("\u2028", "utf8")) + 2; // mid-sequence
		child.stdout.emit("data", raw.subarray(0, cutAt)); // first half, no newline
		child.stdout.emit(
			"data",
			Buffer.concat([raw.subarray(cutAt), Buffer.from("\n")]),
		); // second half completes the LF-delimited record

		child.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					type: "message_update",
					assistantMessageEvent: { type: "text_delta", delta: "CRLF-ok" },
				}) + "\r\n",
			),
		);
		child.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					type: "message_update",
					assistantMessageEvent: { type: "text_delta", delta: "final" },
				}),
			),
		);
		child.stdout.emit("end");
		child.emit("close", 1);

		await drain();
		await done;

		const events = fs
			.readFileSync(path.join(dir, "events.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean);
		// get_state + tool (multibyte) + message_update(CRLF) + final = 4 records, CR stripped.
		expect(events.length).toBe(4);
		const toolEvent = JSON.parse(events[1]);
		expect(toolEvent.args.command).toBe(U); // U+2028 retained inside JSON text
		const transcript = fs.readFileSync(path.join(dir, "transcript.log"), "utf8");
		expect(transcript).toContain("CRLF-ok");
		expect(transcript).toContain("final");
	});
});

// --------------------------------------------------------------------------
// 4. starting until successful correlated get_state
// --------------------------------------------------------------------------

describe("4. starting until successful correlated get_state", () => {
	it("publishes running only after get_state, captures context window, sends prompt", async () => {
		const { fn, made: made0 } = createFakeSpawn();
		const { dir, requestPath } = writeTempRequest(makeRequest());
		fs.writeFileSync(
			path.join(dir, "status.json"),
			JSON.stringify({
				schema: 1,
				generation: "scheduler-generation",
				revision: 10,
				agentId: "q9xm",
				state: "starting",
				tmuxWindow: "subagent-q9xm",
				durableSentinel: "preserve-me",
			}),
		);
		made = made0;
		const kill = vi.fn();
		const stdout = vi.fn(() => true);
		const stderr = vi.fn(() => true);
		const clock = createClock();
		const deps = tempDeps(dir, clock, kill, stdout, stderr, undefined);
		deps.spawn = fn;

		const done = runTaskMode(requestPath, deps);
		await drain();
		const child = made[0] as FakeChild;

		const starting = readStatus(dir);
		expect(starting.state).toBe("starting");
		expect(starting.contextWindow).toBeUndefined();

		const getstateWrite = child.stdin.writes.find((w) =>
			w.includes("get_state"),
		);
		expect(getstateWrite).toBeDefined();
		const getStateId = JSON.parse(getstateWrite!.slice(0, -1)).id;
		expect(typeof getStateId).toBe("string");

		expect(
			child.stdin.writes.some((w) => w.includes('"prompt"')),
		).toBe(false);

		child.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					type: "response",
					id: getStateId,
					success: true,
					data: { model: { contextWindow: 131_072 } },
				}) + "\n",
			),
		);
		await drain();

		const running = readStatus(dir);
		expect(running.state).toBe("running");
		expect(running.runnerPid).toBe(process.pid);
		expect(running.contextWindow).toBe(131_072);
		expect(running.heartbeatAt).toBeGreaterThan(0);
		expect(running.processStart).toEqual(expect.any(String));
		expect(running.generation).toBe("scheduler-generation");
		expect(running.tmuxWindow).toBe("subagent-q9xm");
		expect(running.durableSentinel).toBe("preserve-me");
		expect(running.revision).toBeGreaterThan(10);
		expect(child.stdin.writes.some((w) => w.includes('"prompt"'))).toBe(true);

		child.emit("close", 1);
		await done;
	});
});

// --------------------------------------------------------------------------
// 5. Failed outcomes publish durable failed (result before status)
// --------------------------------------------------------------------------

describe("5. failed outcomes publish durable failed (result before status)", () => {
	it("turns a synchronous spawn failure into a durable failed result", async () => {
		const { dir, requestPath } = writeTempRequest(makeRequest());
		const clock = createClock();
		const writes: string[] = [];
		const deps = tempDeps(
			dir,
			clock,
			vi.fn(),
			vi.fn(() => true),
			vi.fn(() => true),
			(file) => writes.push(file),
		);
		deps.spawn = vi.fn(
			(_command: string, _args: string[], _options: Record<string, unknown>) => {
				throw new Error("synchronous ENOENT");
			},
		);

		await runTaskMode(requestPath, deps);

		expect(readResult(dir).state).toBe("failed");
		expect(readStatus(dir).state).toBe("failed");
		expect(writes.lastIndexOf(`${dir}/result.json`)).toBeLessThan(
			writes.lastIndexOf(`${dir}/status.json`),
		);
	});

	function fresh(): {
		dir: string;
		requestPath: string;
		kill: ReturnType<typeof vi.fn>;
		writes: string[];
	} {
		const { fn, made: made0 } = createFakeSpawn();
		const { dir, requestPath } = writeTempRequest(makeRequest());
		made = made0;
		const kill = vi.fn();
		const stdout = vi.fn(() => true);
		const stderr = vi.fn(() => true);
		const clock = createClock();
		const writes: string[] = [];
		const onWrite = (p: string) => writes.push(p);
		depsForTest = tempDeps(dir, clock, kill, stdout, stderr, onWrite);
		depsForTest.spawn = fn;
		return { dir, requestPath, kill, writes };
	}

	it("failed spawn → durable failed before status", async () => {
		const { dir, requestPath, kill } = fresh();
		const done = runTaskMode(requestPath, depsForTest);
		await drain();
		const child = made[0] as FakeChild;
		child.emitError(new Error("ENOENT pi"));
		child.emit("close", 127);
		await drain();
		await done;

		expect(readResult(dir).state).toBe("failed");
		expect(readStatus(dir).state).toBe("failed");
		expect((readResult(dir).terminalReason as string).length).toBeGreaterThan(0);
		expect(kill).toHaveBeenCalledWith(child.pid, "SIGTERM");
	});

	it("failed get_state → durable failed before status in result-before-status order", async () => {
		const { dir, requestPath, kill, writes } = fresh();
		const done = runTaskMode(requestPath, depsForTest);
		await drain();
		const child = made[0] as FakeChild;
		child.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					type: "response",
					id: "runner-1",
					success: false,
					error: "no model",
				}) + "\n",
			),
		);
		await drain();
		expect(kill).toHaveBeenCalledWith(made[0].pid, "SIGTERM");
		made[0].emit("close", 1);
		await done;
		const resultIdx = writes.lastIndexOf(`${dir}/result.json`);
		const statusIdx = writes.lastIndexOf(`${dir}/status.json`);
		expect(readResult(dir).state).toBe("failed");
		expect(resultIdx).toBeGreaterThanOrEqual(0);
		expect(resultIdx).toBeLessThan(statusIdx);
	});

	it("rejected prompt → durable failed before status", async () => {
		const { dir, requestPath } = fresh();
		const done = runTaskMode(requestPath, depsForTest);
		await drain();
		const child = made[0] as FakeChild;
		child.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					type: "response",
					id: "runner-1",
					success: true,
					data: { model: { contextWindow: 1000 } },
				}) + "\n",
			),
		);
		await drain();
		child.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					type: "response",
					id: "runner-2",
					success: false,
					error: "rejected",
				}) + "\n",
			),
		);
		await drain();
		expect(depsForTest.killProcessGroup).toHaveBeenCalledWith(child.pid, "SIGTERM");
		child.emit("close", 1);
		await done;
		expect(readResult(dir).state).toBe("failed");
	});

	it("early child exit before acknowledgement → durable failed", async () => {
		const { dir, requestPath } = fresh();
		const done = runTaskMode(requestPath, depsForTest);
		await drain();
		const child = made[0] as FakeChild;
		child.emit("close", 6);
		await drain();
		await done;
		expect(readResult(dir).state).toBe("failed");
	});
});

// --------------------------------------------------------------------------
// 6. Text / tool events append and coalesce
// --------------------------------------------------------------------------

describe("6. text/tool events append and coalesce", () => {
	it("captures raw events, transcript, activity, tool uses, turns, usage, context, compaction", async () => {
		const { fn, made: made0 } = createFakeSpawn();
		const reservation = {
			owner: "research",
			profile: "general",
			token: "reservation-a001",
			acquiredAt: 1,
		};
		const { dir, requestPath } = writeTempRequest(makeRequest({ reservation }));
		made = made0;
		const kill = vi.fn();
		const stdout = vi.fn(() => true);
		const stderr = vi.fn(() => true);
		const clock = createClock();
		const writes: string[] = [];
		const deps = tempDeps(dir, clock, kill, stdout, stderr, (file) => writes.push(file));
		deps.spawn = fn;

		const done = runTaskMode(requestPath, deps);
		await drain();
		const child = made[0] as FakeChild;
		const startupId = JSON.parse(child.stdin.writes[0].slice(0, -1)).id;

		child.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					type: "response",
					id: startupId,
					success: true,
					data: { model: { contextWindow: 200_000 } },
				}) + "\n",
			),
		);
		await drain();

		const statusWritesBeforeBurst = writes.filter((file) => file.endsWith("status.json")).length;
		child.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					type: "tool_execution_start",
					toolName: "web_lookup",
					args: { query: "wiring" },
				}) + "\n",
			),
		);
		child.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					type: "message_update",
					usage: { totalTokens: 120, cost: { total: 0.12 } },
					assistantMessageEvent: { type: "text_delta", delta: "thinking" },
				}) + "\n",
			),
		);
		child.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					type: "message_end",
					message: {
						role: "assistant",
						content: [{ type: "text", text: "done" }],
						usage: {
							input: 100,
							output: 50,
							cacheRead: 10,
							cacheWrite: 5,
							totalTokens: 165,
						},
						stopReason: "end_turn",
					},
				}) + "\n",
			),
		);
		child.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					type: "tool_execution_end",
					toolName: "web_lookup",
					result: { content: [{ type: "text", text: "compact result summary" }] },
					isError: false,
				}) + "\n",
			),
		);
		child.stdout.emit(
			"data",
			Buffer.from(JSON.stringify({ type: "compaction_end" }) + "\n"),
		);
		await drain();

		const events = fs
			.readFileSync(path.join(dir, "events.jsonl"), "utf8")
			.split("\n")
			.filter(Boolean);
		expect(events.some((e) => e.includes("web_lookup"))).toBe(true);

		const status = readStatus(dir);
		expect(status.state).toBe("running");
		expect(status.toolUses).toBe(1);
		expect(status.tools).toContain("web_lookup");
		expect(status.turns).toBe(1);
		expect((status.usage as { totalTokens: number }).totalTokens).toBe(165);
		expect(status.compactionCount).toBe(1);
		expect(status.reservation).toEqual(reservation);
		expect(String(status.activity)).toContain("responding");
		const statusWritesAfterBurst = writes.filter((file) => file.endsWith("status.json")).length;
		expect(statusWritesAfterBurst - statusWritesBeforeBurst).toBe(1);
		const transcript = fs.readFileSync(path.join(dir, "transcript.log"), "utf8");
		expect(transcript).toContain("thinking");
		expect(transcript).toContain("done");
		expect(transcript).toContain("compact result summary");
		child.emit("close", 1);
		await done;
	});
});

// --------------------------------------------------------------------------
// 7. agent_settled sends distinct stats + text requests
// --------------------------------------------------------------------------

describe("7. agent_settled sends distinct stats + text requests", () => {
	it("authoritative session stats and final text win over streaming fallback", async () => {
		const { fn, made: made0 } = createFakeSpawn();
		const { dir, requestPath } = writeTempRequest(makeRequest());
		made = made0;
		const kill = vi.fn();
		const stdout = vi.fn(() => true);
		const stderr = vi.fn(() => true);
		const clock = createClock();
		const deps = tempDeps(dir, clock, kill, stdout, stderr, undefined);
		deps.spawn = fn;

		const done = runTaskMode(requestPath, deps);
		await drain();
		const child = made[0] as FakeChild;

		child.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					type: "response",
					id: "runner-1",
					success: true,
					data: { model: { contextWindow: 200_000 } },
				}) + "\n",
			),
		);
		await drain();

		child.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					type: "agent_settled",
					stopReason: "end_turn",
					message: { content: [{ type: "text", text: "settled text" }] },
				}) + "\n",
			),
		);
		await drain();

		const writes = child.stdin.writes;
		const statsWrites = writes.filter((w) => w.includes("get_session_stats"));
		const textWrites = writes.filter((w) =>
			w.includes("get_last_assistant_text"),
		);
		expect(statsWrites.length).toBe(1);
		expect(textWrites.length).toBe(1);
		const statsId = JSON.parse(
			statsWrites[0].slice(0, -1),
		).id as number;
		const textId = JSON.parse(
			textWrites[0].slice(0, -1),
		).id as number;
		expect(statsId).not.toBe(textId);

		child.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					type: "response",
					id: statsId,
					success: true,
					data: {
						tokens: { input: 10, output: 20, cacheRead: 1, cacheWrite: 2, total: 33 },
						toolCalls: 4,
						assistantMessages: 2,
						cost: 0.5,
						contextUsage: { contextWindow: 200_000, tokens: 33 },
					},
				}) + "\n",
			),
		);
		child.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					type: "response",
					id: textId,
					success: true,
					data: { text: "authoritative final text" },
				}) + "\n",
			),
		);
		await drain();

		child.stdin.end();
		child.emit("close", 0);
		await drain();
		await done;

		const result = readResult(dir);
		expect(result.state).toBe("succeeded");
		expect((result.usage as { totalTokens: number }).totalTokens).toBe(33);
		expect((result.usage as { toolUses: number }).toolUses).toBe(4);
		expect((result.output as string).toLowerCase()).toContain(
			"authoritative final text",
		);
	});

	it("uses bounded streaming fallbacks when authoritative responses never arrive", async () => {
		const { fn, made: made0 } = createFakeSpawn();
		const { dir, requestPath } = writeTempRequest(makeRequest());
		made = made0;
		const clock = createClock();
		const deps = tempDeps(
			dir,
			clock,
			vi.fn(),
			vi.fn(() => true),
			vi.fn(() => true),
			undefined,
		);
		deps.spawn = fn;

		const done = runTaskMode(requestPath, deps);
		await drain();
		const child = made[0] as FakeChild;
		child.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					type: "response",
					id: "runner-1",
					success: true,
					data: { model: { contextWindow: 200_000 } },
				}) + "\n",
			),
		);
		child.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					type: "agent_settled",
					message: { content: [{ type: "text", text: "fallback final" }] },
				}) + "\n",
			),
		);
		await drain();

		clock.advance(500);
		clock.runPending();
		await drain();
		expect(child.stdin.ended).toBe(true);
		child.emit("close", 0);
		await done;

		expect(readResult(dir)).toMatchObject({
			state: "succeeded",
			output: "fallback final",
		});
		expect(clock.pending()).toBe(0);
	});
});

// --------------------------------------------------------------------------
// 8. Timeout escalates process group
// --------------------------------------------------------------------------

describe("8. timeout escalates process group", () => {
	it("SIGTERM then SIGKILL after grace, captures partial output, publishes timed_out only after close", async () => {
		const { fn, made: made0 } = createFakeSpawn();
		const { dir, requestPath } = writeTempRequest(
			makeRequest({ profile: { ...BASE_REQUEST.profile, timeoutSeconds: 30 } }),
		);
		made = made0;
		const kill = vi.fn();
		const stdout = vi.fn(() => true);
		const stderr = vi.fn(() => true);
		const clock = createClock();
		const deps = tempDeps(dir, clock, kill, stdout, stderr, undefined);
		deps.spawn = fn;

		const done = runTaskMode(requestPath, deps);
		await drain();
		const child = made[0] as FakeChild;

		child.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					type: "response",
					id: "runner-1",
					success: true,
					data: { model: { contextWindow: 200_000 } },
				}) + "\n",
			),
		);
		await drain();
		child.stdout.emit("data", Buffer.from("partial assistant output\n"));

		clock.advance(31_000);
		clock.runPending();

		expect(kill).toHaveBeenCalledWith(child.pid, "SIGTERM");
		expect(kill).not.toHaveBeenCalledWith(child.pid, "SIGKILL");
		clock.advance(1_000);
		clock.runPending();
		expect(kill).toHaveBeenCalledWith(child.pid, "SIGKILL");

		child.emit("close", -15);
		await drain();
		await done;

		expect(readResult(dir).state).toBe("timed_out");
		expect(readStatus(dir).state).toBe("timed_out");
		expect((readStatus(dir).finishedAt as number)).toBeGreaterThan(0);
	});
});

// --------------------------------------------------------------------------
// 9. Atomic cancellation marker
// --------------------------------------------------------------------------

describe("9. atomic cancellation marker", () => {
	it("triggers escalation, publishes cancelled, retains marker", async () => {
		const { fn, made: made0 } = createFakeSpawn();
		const { dir, requestPath } = writeTempRequest(makeRequest());
		made = made0;
		const kill = vi.fn();
		const stdout = vi.fn(() => true);
		const stderr = vi.fn(() => true);
		const clock = createClock();
		const deps = tempDeps(dir, clock, kill, stdout, stderr, undefined);
		deps.spawn = fn;

		fs.mkdirSync(path.join(dir, "control"), { recursive: true });

		const done = runTaskMode(requestPath, deps);
		await drain();
		const child = made[0] as FakeChild;

		child.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					type: "response",
					id: "runner-1",
					success: true,
					data: { model: { contextWindow: 200_000 } },
				}) + "\n",
			),
		);
		await drain();

		fs.writeFileSync(
			path.join(dir, "control", "cancel"),
			JSON.stringify({ agentId: "q9xm", requestedAt: 1 }),
		);

		for (let i = 0; i < 30; i++) {
			clock.advance(20);
			clock.runPending();
			await drain();
			if (kill.mock.calls.some((c) => c[1] === "SIGTERM")) break;
		}

		expect(kill).toHaveBeenCalledWith(child.pid, "SIGTERM");
		child.emit("close", -15);
		await drain();
		await done;

		expect(readResult(dir).state).toBe("cancelled");
		expect(
			fs.existsSync(path.join(dir, "control", "cancel")),
		).toBe(true);
	});
});

// --------------------------------------------------------------------------
// 10. Normal success publication order and cleanup
// --------------------------------------------------------------------------

describe("10. normal success publication order and cleanup", () => {
	it("writes/logs, then result, then terminal status; no timer/listener leaks", async () => {
		const { fn, made: made0 } = createFakeSpawn();
		const { dir, requestPath } = writeTempRequest(makeRequest());
		made = made0;
		const kill = vi.fn();
		const stdout = vi.fn(() => true);
		const stderr = vi.fn(() => true);
		const clock = createClock();
		const writes: string[] = [];
		const onWrite = (p: string) => writes.push(p);
		const deps = tempDeps(dir, clock, kill, stdout, stderr, onWrite);
		deps.spawn = fn;

		const before = ["SIGINT", "SIGTERM", "SIGHUP"].map((s) =>
			process.listenerCount(s as NodeJS.Signals),
		);

		const done = runTaskMode(requestPath, deps);
		await drain();
		const child = made[0] as FakeChild;

		child.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					type: "response",
					id: "runner-1",
					success: true,
					data: { model: { contextWindow: 200_000 } },
				}) + "\n",
			),
		);
		await drain();
		child.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					type: "message_update",
					assistantMessageEvent: { type: "text_delta", delta: "hello world" },
				}) + "\n",
			),
		);
		child.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					type: "agent_settled",
					stopReason: "end_turn",
					message: { content: [{ type: "text", text: "final result" }] },
				}) + "\n",
			),
		);
		await drain();
		const statsId = JSON.parse(
			child.stdin.writes.find((w) => w.includes("get_session_stats"))!.slice(0, -1),
		).id as number;
		const textId = JSON.parse(
			child.stdin.writes.find((w) => w.includes("get_last_assistant_text"))!.slice(0, -1),
		).id as number;
		child.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					type: "response",
					id: statsId,
					success: true,
					data: { tokens: { total: 42 }, contextUsage: { tokens: 42 } },
				}) + "\n",
			),
		);
		child.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					type: "response",
					id: textId,
					success: true,
					data: { text: "final result" },
				}) + "\n",
			),
		);
		await drain();
		child.stdin.end();
		child.emit("close", 0);
		await drain();
		await done;

		const resultIdx = writes.lastIndexOf(`${dir}/result.json`);
		const statusIdx = writes.lastIndexOf(`${dir}/status.json`);
		expect(resultIdx).toBeGreaterThanOrEqual(0);
		expect(statusIdx).toBeGreaterThan(resultIdx);

		expect(fs.statSync(path.join(dir, "events.jsonl")).size).toBeGreaterThan(0);
		expect(fs.statSync(path.join(dir, "transcript.log")).size).toBeGreaterThan(0);
		expect(fs.existsSync(path.join(dir, "stderr.log"))).toBe(true);

		const result = readResult(dir);
		expect(result).toEqual(
			expect.objectContaining({
				agentId: "q9xm",
				state: "succeeded",
				usage: expect.objectContaining({
					totalTokens: 42,
					toolUses: expect.any(Number),
					durationMs: expect.any(Number),
				}),
				finishedAt: expect.any(Number),
			}),
		);

		expect(clock.pending()).toBe(0);
		const after = ["SIGINT", "SIGTERM", "SIGHUP"].map((s) =>
			process.listenerCount(s as NodeJS.Signals),
		);
		expect(after).toEqual(before);
	});
});

// --------------------------------------------------------------------------
// 11. Interrupted / unexpected exit retains partial logs
// --------------------------------------------------------------------------

describe("11. interrupted / unexpected exit retains partial logs", () => {
	it("retains partial event/stderr/transcript and records durable failed reason", async () => {
		const { fn, made: made0 } = createFakeSpawn();
		const { dir, requestPath } = writeTempRequest(makeRequest());
		made = made0;
		const kill = vi.fn();
		const stdout = vi.fn(() => true);
		const stderr = vi.fn(() => true);
		const clock = createClock();
		const deps = tempDeps(dir, clock, kill, stdout, stderr, undefined);
		deps.spawn = fn;

		const done = runTaskMode(requestPath, deps);
		await drain();
		const child = made[0] as FakeChild;

		child.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					type: "response",
					id: "runner-1",
					success: true,
					data: { model: { contextWindow: 200_000 } },
				}) + "\n",
			),
		);
		await drain();
		child.stdout.emit(
			"data",
			Buffer.from(
				JSON.stringify({
					type: "message_update",
					assistantMessageEvent: { type: "text_delta", delta: "partial text" },
				}) + "\n",
			),
		);
		child.stderr.emit("data", Buffer.from("a stderr byte\n"));
		child.emit("close", 1);
		await drain();
		await done;

		expect(fs.existsSync(path.join(dir, "events.jsonl"))).toBe(true);
		expect(fs.existsSync(path.join(dir, "stderr.log"))).toBe(true);
		expect(fs.existsSync(path.join(dir, "transcript.log"))).toBe(true);
		expect(fs.readFileSync(path.join(dir, "transcript.log"), "utf8")).toContain(
			"partial text",
		);
		expect(fs.readFileSync(path.join(dir, "stderr.log"), "utf8")).toContain(
			"a stderr byte",
		);
		expect(readResult(dir).state).toBe("failed");
		expect((readResult(dir).terminalReason as string).length).toBeGreaterThan(0);
	});
});
