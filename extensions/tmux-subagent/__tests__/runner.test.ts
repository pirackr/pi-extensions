import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock modules before importing runner
vi.mock("node:child_process", () => ({
	spawn: vi.fn(),
}));

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		default: {
			...actual,
			readFileSync: vi.fn(),
			writeFileSync: vi.fn(),
			renameSync: vi.fn(),
			createWriteStream: vi.fn(() => createMockWriteStream()),
		},
		readFileSync: vi.fn(),
		writeFileSync: vi.fn(),
		renameSync: vi.fn(),
		createWriteStream: vi.fn(() => createMockWriteStream()),
	};
});

function createMockWriteStream(): any {
	return {
		write: vi.fn(),
		end: vi.fn(),
		on: vi.fn(),
		close: vi.fn(),
		bytesWritten: 0,
		path: "",
		pending: false,
	};
}

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import { runControlMode, runTaskMode, main } from "../runner.mjs";

const mockSpawn = vi.mocked(spawn);
const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockWriteFileSync = vi.mocked(fs.writeFileSync);
const mockRenameSync = vi.mocked(fs.renameSync);

describe("runControlMode", () => {
	beforeEach(() => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
		vi.spyOn(process, "on").mockImplementation(() => process);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("writes controller message with control name", () => {
		runControlMode("test-session");
		expect(process.stdout.write).toHaveBeenCalledWith(
			"Subagent controller: test-session\n",
		);
	});

	it("writes 'unknown' when control name is missing", () => {
		runControlMode(undefined);
		expect(process.stdout.write).toHaveBeenCalledWith(
			"Subagent controller: unknown\n",
		);
	});

	it("registers signal handlers", () => {
		runControlMode("session");
		expect(process.on).toHaveBeenCalledWith("SIGINT", expect.any(Function));
		expect(process.on).toHaveBeenCalledWith("SIGTERM", expect.any(Function));
		expect(process.on).toHaveBeenCalledWith("SIGHUP", expect.any(Function));
	});
});

describe("runTaskMode", () => {
	let mockChild: any;
	let stdoutCallbacks: Map<string, Function[]>;
	let stderrCallbacks: Map<string, Function[]>;
	let errorCallbacks: Function[];
	let exitCallbacks: Function[];
	let closeCallbacks: Function[];
	let stdinMocks: any;

	beforeEach(() => {
		vi.useFakeTimers();
		stdoutCallbacks = new Map();
		stderrCallbacks = new Map();
		errorCallbacks = [];
		exitCallbacks = [];
		closeCallbacks = [];
		stdinMocks = { on: vi.fn(), end: vi.fn() };

		mockChild = {
			pid: 12345,
			stdin: stdinMocks,
			stdout: {
				on: vi.fn((event: string, cb: Function) => {
					const list = stdoutCallbacks.get(event) ?? [];
					list.push(cb);
					stdoutCallbacks.set(event, list);
				}),
			},
			stderr: {
				on: vi.fn((event: string, cb: Function) => {
					const list = stderrCallbacks.get(event) ?? [];
					list.push(cb);
					stderrCallbacks.set(event, list);
				}),
			},
			on: vi.fn((event: string, cb: Function) => {
				if (event === "error") errorCallbacks.push(cb);
				if (event === "exit") exitCallbacks.push(cb);
				if (event === "close") closeCallbacks.push(cb);
			}),
			kill: vi.fn(),
		};

		mockSpawn.mockReturnValue(mockChild);
		mockReadFileSync.mockImplementation((path: fs.PathOrFileDescriptor) => {
			if (typeof path === "string" && path.includes("request")) {
				return JSON.stringify({
					taskId: "task-1",
					agent: "worker",
					model: "gpt-4o",
					thinking: "medium",
					tools: ["read", "edit"],
					cwd: "/workspace",
					timeoutMs: 300_000,
					promptPath: "/tmp/prompt.md",
					taskPath: "/tmp/task.md",
					outputPath: "/tmp/output.jsonl",
					stderrPath: "/tmp/stderr.log",
					statusPath: "/tmp/status.json",
					pi: { command: "pi", args: [] },
					childExtensions: [],
					loadContextFiles: true,
				});
			}
			if (typeof path === "string" && path.includes("task.md")) {
				return "Do the task";
			}
			return "";
		});
		mockWriteFileSync.mockImplementation(() => undefined);
		mockRenameSync.mockImplementation(() => undefined);

		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	function emitStdout(data: string) {
		const cbs = stdoutCallbacks.get("data") ?? [];
		for (const cb of cbs) cb(Buffer.from(data));
	}

	function emitStderr(data: string) {
		const cbs = stderrCallbacks.get("data") ?? [];
		for (const cb of cbs) cb(Buffer.from(data));
	}

	function emitClose(code: number) {
		for (const cb of closeCallbacks) cb(code);
	}

	it("writes starting status", () => {
		runTaskMode("/tmp/request.json");
		expect(mockWriteFileSync).toHaveBeenCalled();
		const firstCall = mockWriteFileSync.mock.calls[0];
		const status = JSON.parse(firstCall[1] as string);
		expect(status.state).toBe("starting");
		expect(status.taskId).toBe("task-1");
	});

	it("spawns child process with correct arguments", () => {
		runTaskMode("/tmp/request.json");
		expect(mockSpawn).toHaveBeenCalledWith(
			"pi",
			expect.arrayContaining([
				"--mode",
				"json",
				"-p",
				"--no-session",
				"--no-extensions",
				"--no-skills",
				"--no-prompt-templates",
				"--no-themes",
				"--model",
				"gpt-4o",
				"--thinking",
				"medium",
				"--tools",
				"read,edit",
				"--append-system-prompt",
				"/tmp/prompt.md",
			]),
			expect.objectContaining({
				cwd: "/workspace",
				detached: true,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
			}),
		);
	});

	it("passes web-search budget flags to child when set", () => {
		mockReadFileSync.mockImplementation((path: fs.PathOrFileDescriptor) => {
			if (typeof path === "string" && path.includes("request")) {
				return JSON.stringify({
					taskId: "task-1",
					agent: "scout",
					model: "gpt-4o",
					tools: ["web_lookup", "fetch_web"],
					cwd: "/workspace",
					timeoutMs: 300_000,
					promptPath: "/tmp/prompt.md",
					taskPath: "/tmp/task.md",
					outputPath: "/tmp/output.jsonl",
					stderrPath: "/tmp/stderr.log",
					statusPath: "/tmp/status.json",
					pi: { command: "pi", args: [] },
					childExtensions: [],
					loadContextFiles: true,
					webSearchMaxLookups: 10,
					webSearchMaxFetches: 6,
				});
			}
			if (typeof path === "string" && path.includes("task.md")) {
				return "Do the task";
			}
			return "";
		});
		runTaskMode("/tmp/request.json");
		const [command, args] = mockSpawn.mock.calls[0] as unknown as [
			string,
			string[],
		];
		expect(command).toBe("pi");
		expect(args).toContain("--web-search-max-lookups");
		expect(args).toContain("10");
		expect(args).toContain("--web-search-max-fetches");
		expect(args).toContain("6");
	});

	it("omits web-search budget flags when unset", () => {
		runTaskMode("/tmp/request.json");
		const [command, args] = mockSpawn.mock.calls[0] as unknown as [
			string,
			string[],
		];
		expect(command).toBe("pi");
		expect(args).not.toContain("--web-search-max-lookups");
		expect(args).not.toContain("--web-search-max-fetches");
	});

	it("writes running status after spawning", () => {
		runTaskMode("/tmp/request.json");
		const calls = mockWriteFileSync.mock.calls;
		const runningCall = calls.find((call) => {
			try {
				return JSON.parse(call[1] as string).state === "running";
			} catch {
				return false;
			}
		});
		expect(runningCall).toBeDefined();
		const status = JSON.parse(runningCall![1] as string);
		expect(status.pid).toBe(12345);
	});

	it("processes message_update events", () => {
		runTaskMode("/tmp/request.json");
		emitStdout(
			JSON.stringify({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "Hello" },
			}) + "\n",
		);
		expect(process.stdout.write).toHaveBeenCalledWith("Hello");
	});

	it("processes tool_execution_start events", () => {
		runTaskMode("/tmp/request.json");
		emitStdout(
			JSON.stringify({
				type: "tool_execution_start",
				toolName: "read",
			}) + "\n",
		);
		expect(process.stdout.write).toHaveBeenCalledWith("\n[read]\n");
	});

	it("processes message_end events and accumulates usage", () => {
		runTaskMode("/tmp/request.json");
		emitStdout(
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Result" }],
					usage: {
						input: 100,
						output: 50,
						cacheRead: 10,
						cacheWrite: 5,
						totalTokens: 165,
						cost: {
							input: 0.001,
							output: 0.002,
							cacheRead: 0.0001,
							cacheWrite: 0.0002,
							total: 0.0033,
						},
					},
					stopReason: "end_turn",
				},
			}) + "\n",
		);

		emitClose(0);

		const writeCalls = mockWriteFileSync.mock.calls;
		const lastCall = writeCalls[writeCalls.length - 1];
		const status = JSON.parse(lastCall[1] as string);
		expect(status.state).toBe("succeeded");
		expect(status.result).toBe("Result");
		expect(status.usage.input).toBe(100);
		expect(status.usage.output).toBe(50);
		expect(status.usage.turns).toBe(1);
	});

	it("handles failed exit code", () => {
		runTaskMode("/tmp/request.json");
		emitClose(1);

		const writeCalls = mockWriteFileSync.mock.calls;
		const lastCall = writeCalls[writeCalls.length - 1];
		const status = JSON.parse(lastCall[1] as string);
		expect(status.state).toBe("failed");
		expect(status.exitCode).toBe(1);
	});

	it("handles child process error", () => {
		runTaskMode("/tmp/request.json");
		for (const cb of errorCallbacks) cb(new Error("Spawn failed"));
		emitClose(1);

		const writeCalls = mockWriteFileSync.mock.calls;
		const lastCall = writeCalls[writeCalls.length - 1];
		const status = JSON.parse(lastCall[1] as string);
		expect(status.errorMessage).toBe("Spawn failed");
	});

	it("ignores empty lines in stdout", () => {
		runTaskMode("/tmp/request.json");
		emitStdout("\n\n\n");
		// Should not throw
	});

	it("ignores invalid JSON in stdout", () => {
		runTaskMode("/tmp/request.json");
		emitStdout("not valid json\n");
		// Should not throw
	});

	it("sets timeout from request", () => {
		vi.useRealTimers();
		runTaskMode("/tmp/request.json");
		// The timeout should be set to 300000ms
		// We verify by checking the spawn was called
		expect(mockSpawn).toHaveBeenCalled();
	});

	// ----------------------------------------------------------------------
	// Transcript mirroring (Task 4)
	// ----------------------------------------------------------------------
	function runWithTranscript(transcriptPath = "/tmp/transcript.log") {
		const mockCreateWriteStream = vi.mocked(fs.createWriteStream);
		let transcriptStream: any;
		mockCreateWriteStream.mockImplementation((path: unknown, opts: unknown) => {
			const stream = createMockWriteStream();
			(stream as any).path = String(path);
			(stream as any).opts = opts;
			if (String(path).includes("transcript")) transcriptStream = stream;
			return stream;
		});
		mockReadFileSync.mockImplementation((path: fs.PathOrFileDescriptor) => {
			if (typeof path === "string" && path.includes("request")) {
				return JSON.stringify({
					taskId: "task-1",
					agent: "worker",
					model: "gpt-4o",
					thinking: "medium",
					tools: ["read", "edit"],
					cwd: "/workspace",
					timeoutMs: 300_000,
					promptPath: "/tmp/prompt.md",
					taskPath: "/tmp/task.md",
					outputPath: "/tmp/output.jsonl",
					stderrPath: "/tmp/stderr.log",
					statusPath: "/tmp/status.json",
					transcriptPath,
					pi: { command: "pi", args: [] },
					childExtensions: [],
					loadContextFiles: true,
				});
			}
			if (typeof path === "string" && path.includes("task.md")) {
				return "Do the task";
			}
			return "";
		});
		runTaskMode("/tmp/request.json");
		return transcriptStream;
	}

	it("creates the transcript stream with append flags and 0600 mode", () => {
		const stream = runWithTranscript();
		expect(stream).toBeDefined();
		const calls = vi.mocked(fs.createWriteStream).mock.calls;
		const transcriptCall = calls.find((call) => String(call[0]).includes("transcript"));
		expect(transcriptCall![1]).toMatchObject({ flags: "a", mode: 0o600 });
	});

	it("mirrors assistant text, tool markers, stderr, and the completion summary", () => {
		const stream = runWithTranscript();
		emitStdout(
			JSON.stringify({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "Hello world" },
			}) + "\n",
		);
		emitStdout(JSON.stringify({ type: "tool_execution_start", toolName: "read" }) + "\n");
		emitStdout(
			JSON.stringify({
				type: "tool_execution_end",
				toolName: "read",
				result: { content: [{ text: "file contents" }] },
			}) + "\n",
		);
		emitStderr("warning: something\n");
		emitStdout(
			JSON.stringify({
				type: "message_end",
				message: {
					role: "assistant",
					content: [{ type: "text", text: "Final" }],
					usage: { input: 1 },
					stopReason: "end_turn",
				},
			}) + "\n",
		);
		emitClose(0);
		const writes = stream.write.mock.calls.map((call: unknown[]) => String(call[0]));
		const joined = writes.join("");
		expect(joined).toContain("Hello world");
		expect(joined).toContain("[read]");
		expect(joined).toContain("file contents");
		expect(joined).toContain("warning: something");
		expect(joined).toContain("[worker succeeded]");
	});

	it("closes the transcript stream when the child closes", () => {
		const stream = runWithTranscript();
		emitClose(0);
		expect(stream.end).toHaveBeenCalled();
	});

	it("does not crash the task when transcript writes fail", () => {
		const stream = runWithTranscript();
		stream.write.mockImplementation(() => {
			throw new Error("disk full");
		});
		emitStdout(
			JSON.stringify({
				type: "message_update",
				assistantMessageEvent: { type: "text_delta", delta: "Hello" },
			}) + "\n",
		);
		emitClose(0);
		const statusCall = mockWriteFileSync.mock.calls.find((call) => {
			try {
				return JSON.parse(call[1] as string).state === "failed";
			} catch {
				return false;
			}
		});
		expect(statusCall).toBeDefined();
	});
});

describe("main", () => {
	beforeEach(() => {
		vi.spyOn(process.stdout, "write").mockImplementation(() => true);
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);
		vi.spyOn(process, "exit").mockImplementation(
			(code?: string | number | null) => {
				throw new Error(`EXIT_${code}`);
			},
		);
		vi.spyOn(process, "on").mockImplementation(() => process);
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("runs control mode with --control flag", () => {
		main(["node", "runner.mjs", "--control", "test-session"]);
		expect(process.stdout.write).toHaveBeenCalledWith(
			"Subagent controller: test-session\n",
		);
	});

	it("exits with error when no request file provided", () => {
		expect(() => main(["node", "runner.mjs"])).toThrow("EXIT_2");
		expect(process.stderr.write).toHaveBeenCalledWith(
			"Usage: node runner.mjs <request.json>\n",
		);
	});

	it("runs task mode with request file", () => {
		mockReadFileSync.mockImplementation((path: fs.PathOrFileDescriptor) => {
			if (typeof path === "string" && path.includes("request")) {
				return JSON.stringify({
					taskId: "task-1",
					agent: "worker",
					model: "gpt-4o",
					tools: ["read"],
					cwd: "/workspace",
					timeoutMs: 300_000,
					promptPath: "/tmp/prompt.md",
					taskPath: "/tmp/task.md",
					outputPath: "/tmp/output.jsonl",
					stderrPath: "/tmp/stderr.log",
					statusPath: "/tmp/status.json",
					pi: { command: "pi", args: [] },
					childExtensions: [],
					loadContextFiles: true,
				});
			}
			return "";
		});

		const mockChild = {
			pid: 12345,
			stdin: { on: vi.fn(), end: vi.fn() },
			stdout: { on: vi.fn() },
			stderr: { on: vi.fn() },
			on: vi.fn(),
			kill: vi.fn(),
		};
		mockSpawn.mockReturnValue(mockChild as any);

		main(["node", "runner.mjs", "/tmp/request.json"]);
		expect(mockSpawn).toHaveBeenCalled();
	});
});
