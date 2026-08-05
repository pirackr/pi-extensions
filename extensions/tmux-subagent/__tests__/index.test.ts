import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock modules before importing the module under test
vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: vi.fn().mockReturnValue("/mock/agent/dir"),
	parseFrontmatter: vi.fn(),
}));

vi.mock("typebox", () => ({
	Type: {
		Object: vi.fn((props: any) => props),
		String: vi.fn((opts: any) => ({ type: "string", ...opts })),
		Number: vi.fn((opts: any) => ({ type: "number", ...opts })),
		Array: vi.fn((item: any, opts: any) => ({ type: "array", item, ...opts })),
		Optional: vi.fn((item: any) => ({ optional: true, ...item })),
	},
}));

vi.mock("node:child_process", () => ({
	execFile: vi.fn(),
}));

vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		default: {
			...actual,
			existsSync: vi.fn(),
			readFileSync: vi.fn(),
			constants: { R_OK: 4 },
			promises: {
				access: vi.fn(),
				stat: vi.fn(),
				mkdtemp: vi.fn(),
				chmod: vi.fn(),
				mkdir: vi.fn(),
				writeFile: vi.fn(),
				readFile: vi.fn(),
				realpath: vi.fn(),
				rm: vi.fn(),
			},
			createWriteStream: vi.fn(),
		},
		existsSync: vi.fn(),
		readFileSync: vi.fn(),
		constants: { R_OK: 4 },
		promises: {
			access: vi.fn(),
			stat: vi.fn(),
			mkdtemp: vi.fn(),
			chmod: vi.fn(),
			mkdir: vi.fn(),
			writeFile: vi.fn(),
			readFile: vi.fn(),
			realpath: vi.fn(),
			rm: vi.fn(),
		},
		createWriteStream: vi.fn(),
	};
});

vi.mock("node:os", () => ({
	homedir: vi.fn().mockReturnValue("/home/user"),
	tmpdir: vi.fn().mockReturnValue("/tmp"),
}));

vi.mock("./config.ts", () => ({
	loadSubagentConfiguration: vi.fn().mockReturnValue({
		config: {
			maxTasks: 4,
			defaultTimeoutSeconds: 300,
			retainArtifacts: "on_failure",
			childExtensions: [],
			loadContextFiles: true,
		},
		profiles: [
			{
				name: "worker",
				description: "A worker agent",
				model: "gpt-4o",
				thinking: "medium",
				tools: ["read", "edit"],
				access: "write",
				timeoutSeconds: 600,
				systemPrompt: "You are a worker.",
				filePath: "/agents/worker.md",
				source: "bundled",
			},
		],
		userConfigPath: "/mock/config.json",
	}),
}));

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import {
	runCommand,
	shellQuote,
	getPiInvocation,
	getRunnerInvocation,
	buildTaskPrompt,
	readStatus,
	readStderrTail,
	getWorktreeIdentity,
	aggregateUsage,
	truncateResult,
	renderProgress,
	renderResults,
	delay,
	type TaskStatus,
} from "../index.ts";

const mockExecFile = vi.mocked(execFile);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFile = vi.mocked(fs.promises.readFile);
const mockRealpath = vi.mocked(fs.promises.realpath);

describe("runCommand", () => {
	beforeEach(() => {
		mockExecFile.mockReset();
	});

	it("resolves with stdout and stderr on success", async () => {
		mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
			callback!(null, "stdout content", "stderr content");
			return undefined as any;
		});

		const result = await runCommand("echo", ["hello"]);
		expect(result).toEqual({
			stdout: "stdout content",
			stderr: "stderr content",
		});
	});

	it("rejects with error detail on failure", async () => {
		mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
			const error = new Error("Command failed");
			callback!(error, "", "stderr detail");
			return undefined as any;
		});

		await expect(runCommand("false", [])).rejects.toThrow(
			"false  failed: stderr detail",
		);
	});

	it("uses error message when stderr is empty", async () => {
		mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
			const error = new Error("Something went wrong");
			callback!(error, "", "");
			return undefined as any;
		});

		await expect(runCommand("cmd", [])).rejects.toThrow(
			"cmd  failed: Something went wrong",
		);
	});

	it("respects timeout parameter", async () => {
		mockExecFile.mockImplementation((_cmd, _args, opts, callback) => {
			expect(opts?.timeout).toBe(5000);
			callback!(null, "", "");
			return undefined as any;
		});

		await runCommand("sleep", ["1"], 5000);
	});
});

describe("shellQuote", () => {
	it("wraps value in single quotes", () => {
		expect(shellQuote("hello")).toBe("'hello'");
	});

	it("escapes single quotes", () => {
		expect(shellQuote("it's working")).toBe("'it'\\''s working'");
	});

	it("handles multiple single quotes", () => {
		expect(shellQuote("'hello'")).toBe("''\\''hello'\\'''");
	});

	it("handles empty string", () => {
		expect(shellQuote("")).toBe("''");
	});
});

describe("getPiInvocation", () => {
	beforeEach(() => {
		vi.stubGlobal("process", {
			...process,
			argv: ["node", "/path/to/script.ts"],
			execPath: "/usr/bin/node",
		});
		mockExistsSync.mockReset();
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("returns node with script path when script exists", () => {
		mockExistsSync.mockReturnValue(true);
		const result = getPiInvocation();
		expect(result).toEqual({
			command: "/usr/bin/node",
			args: ["/path/to/script.ts"],
		});
	});

	it("returns execPath with no args for non-node executables", () => {
		vi.stubGlobal("process", {
			...process,
			argv: ["pi", "/path/to/script.ts"],
			execPath: "/usr/bin/pi",
		});
		mockExistsSync.mockReturnValue(false);
		const result = getPiInvocation();
		expect(result).toEqual({ command: "/usr/bin/pi", args: [] });
	});

	it("returns 'pi' command for node/bun without script", () => {
		vi.stubGlobal("process", {
			...process,
			argv: ["node"],
			execPath: "/usr/bin/node",
		});
		const result = getPiInvocation();
		expect(result).toEqual({ command: "pi", args: [] });
	});

	it("skips bun virtual scripts", () => {
		vi.stubGlobal("process", {
			...process,
			argv: ["bun", "/$bunfs/root/script.ts"],
			execPath: "/usr/bin/bun",
		});
		const result = getPiInvocation();
		expect(result).toEqual({ command: "pi", args: [] });
	});
});

describe("getRunnerInvocation", () => {
	beforeEach(() => {
		vi.stubGlobal("process", {
			...process,
			execPath: "/usr/bin/node",
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("returns node with runner path for node executable", () => {
		const result = getRunnerInvocation();
		expect(result.command).toBe("/usr/bin/node");
		expect(result.args[0]).toMatch(/runner\.mjs$/);
	});

	it("returns 'node' with runner path for non-node executables", () => {
		vi.stubGlobal("process", {
			...process,
			execPath: "/usr/bin/python", // not node or bun
		});
		const result = getRunnerInvocation();
		expect(result.command).toBe("node");
		expect(result.args[0]).toMatch(/runner\.mjs$/);
	});
});

describe("buildTaskPrompt", () => {
	it("builds prompt with all sections", () => {
		const task = {
			objective: "Fix the bug",
			scope: ["src/bug.ts"],
			non_goals: ["Don't refactor"],
			constraints: ["Keep tests passing"],
			acceptance_criteria: ["Bug is fixed"],
			inputs: ["Error log"],
			expected_output: "Fixed code",
		};

		const result = buildTaskPrompt(task);
		expect(result).toContain("# Objective\nFix the bug");
		expect(result).toContain("# Scope\n- src/bug.ts");
		expect(result).toContain("# Non-Goals\n- Don't refactor");
		expect(result).toContain("# Constraints\n- Keep tests passing");
		expect(result).toContain("# Acceptance Criteria\n- Bug is fixed");
		expect(result).toContain("# Inputs\n- Error log");
		expect(result).toContain("# Expected Output\nFixed code");
		expect(result).toContain("# Delegation Boundary");
	});

	it("uses defaults for missing fields", () => {
		const task = { objective: "Do something" };
		const result = buildTaskPrompt(task);
		expect(result).toContain("# Objective\nDo something");
		expect(result).toContain(
			"# Scope\n- Use only the scope needed for the objective.",
		);
		expect(result).toContain("# Non-Goals\n- Do not broaden the task.");
		expect(result).toContain(
			"# Constraints\n- Follow repository instructions and existing conventions.",
		);
		expect(result).toContain(
			"# Acceptance Criteria\n- Satisfy the objective with verifiable evidence.",
		);
		expect(result).toContain(
			"# Inputs\n- Inspect primary artifacts rather than relying on assumptions.",
		);
		expect(result).toContain(
			"Return status, concise results, evidence, checks performed, unresolved risks, and the recommended next action.",
		);
	});

	it("handles empty arrays", () => {
		const task = {
			objective: "Test",
			scope: [],
			non_goals: [],
			constraints: [],
			acceptance_criteria: [],
			inputs: [],
		};
		const result = buildTaskPrompt(task);
		expect(result).toContain(
			"# Scope\n- Use only the scope needed for the objective.",
		);
	});
});

describe("readStatus", () => {
	beforeEach(() => {
		mockReadFile.mockReset();
	});

	it("parses valid status JSON", async () => {
		const status: TaskStatus = {
			taskId: "task-1",
			agent: "worker",
			state: "succeeded",
			startedAt: "2024-01-01T00:00:00Z",
			model: "gpt-4o",
		};
		mockReadFile.mockResolvedValue(JSON.stringify(status));

		const result = await readStatus("/status.json");
		expect(result).toEqual(status);
	});

	it("returns null for missing file", async () => {
		const error = new Error("ENOENT") as NodeJS.ErrnoException;
		error.code = "ENOENT";
		mockReadFile.mockRejectedValue(error);

		const result = await readStatus("/missing.json");
		expect(result).toBeNull();
	});

	it("returns null for invalid JSON", async () => {
		mockReadFile.mockResolvedValue("not json");

		const result = await readStatus("/bad.json");
		expect(result).toBeNull();
	});

	it("rethrows unexpected errors", async () => {
		mockReadFile.mockRejectedValue(new Error("Permission denied"));

		await expect(readStatus("/status.json")).rejects.toThrow(
			"Permission denied",
		);
	});
});

describe("readStderrTail", () => {
	beforeEach(() => {
		mockReadFile.mockReset();
	});

	it("returns last 8KB of stderr", async () => {
		const content = "a".repeat(10_000);
		mockReadFile.mockResolvedValue(content);

		const result = await readStderrTail("/stderr.log");
		expect(result).toBe(content.slice(-8 * 1024).trim());
		expect(result.length).toBe(8 * 1024);
	});

	it("returns full content when under 8KB", async () => {
		mockReadFile.mockResolvedValue("short error");

		const result = await readStderrTail("/stderr.log");
		expect(result).toBe("short error");
	});

	it("returns empty string for missing file", async () => {
		mockReadFile.mockRejectedValue(new Error("ENOENT"));

		const result = await readStderrTail("/missing.log");
		expect(result).toBe("");
	});
});

describe("getWorktreeIdentity", () => {
	beforeEach(() => {
		mockExecFile.mockReset();
		mockRealpath.mockReset();
	});

	it("returns git toplevel when available", async () => {
		mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
			callback!(null, "/repo\n", "");
			return undefined as any;
		});
		mockRealpath.mockResolvedValue("/real/repo");

		const result = await getWorktreeIdentity("/repo");
		expect(result).toBe("/real/repo");
	});

	it("falls back to cwd realpath when git fails", async () => {
		mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
			callback!(new Error("not a git repo"), "", "");
			return undefined as any;
		});
		mockRealpath.mockResolvedValue("/real/cwd");

		const result = await getWorktreeIdentity("/cwd");
		expect(result).toBe("/real/cwd");
	});
});

describe("aggregateUsage", () => {
	it("sums usage across all statuses", () => {
		const statuses: TaskStatus[] = [
			{
				taskId: "task-1",
				agent: "worker",
				state: "succeeded",
				startedAt: "2024-01-01T00:00:00Z",
				model: "gpt-4o",
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
					turns: 3,
				},
			},
			{
				taskId: "task-2",
				agent: "reviewer",
				state: "succeeded",
				startedAt: "2024-01-01T00:00:00Z",
				model: "gpt-4o",
				usage: {
					input: 200,
					output: 100,
					cacheRead: 20,
					cacheWrite: 10,
					totalTokens: 330,
					cost: {
						input: 0.002,
						output: 0.004,
						cacheRead: 0.0002,
						cacheWrite: 0.0004,
						total: 0.0066,
					},
					turns: 5,
				},
			},
		];

		const result = aggregateUsage(statuses);
		expect(result.input).toBe(300);
		expect(result.output).toBe(150);
		expect(result.cacheRead).toBe(30);
		expect(result.cacheWrite).toBe(15);
		expect(result.totalTokens).toBe(495);
		expect(result.cost.input).toBe(0.003);
		expect(result.cost.output).toBe(0.006);
		expect(result.cost.total).toBeCloseTo(0.0099, 10);
	});

	it("skips statuses without usage", () => {
		const statuses: TaskStatus[] = [
			{
				taskId: "task-1",
				agent: "worker",
				state: "succeeded",
				startedAt: "2024-01-01T00:00:00Z",
				model: "gpt-4o",
				usage: {
					input: 100,
					output: 50,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 150,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
					turns: 1,
				},
			},
			{
				taskId: "task-2",
				agent: "reviewer",
				state: "failed",
				startedAt: "2024-01-01T00:00:00Z",
				model: "gpt-4o",
			},
		];

		const result = aggregateUsage(statuses);
		expect(result.input).toBe(100);
		expect(result.totalTokens).toBe(150);
	});

	it("returns zero for empty array", () => {
		const result = aggregateUsage([]);
		expect(result.input).toBe(0);
		expect(result.totalTokens).toBe(0);
		expect(result.cost.total).toBe(0);
	});
});

describe("truncateResult", () => {
	it("returns text unchanged when under limit", () => {
		const text = "short text";
		expect(truncateResult(text)).toBe(text);
	});

	it("truncates text over byte limit", () => {
		const text = "a".repeat(60_000);
		const result = truncateResult(text);
		expect(result).toContain("[Output truncated.]");
		expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(
			50 * 1024 + 25,
		); // content + truncation message
	});

	it("handles multi-byte characters correctly", () => {
		const text = "🎉".repeat(20_000);
		const result = truncateResult(text);
		expect(result).toContain("[Output truncated.]");
		expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(
			50 * 1024 + 25,
		); // content + truncation message
	});
});

describe("renderProgress", () => {
	it("renders progress with multiple states", () => {
		const statuses: TaskStatus[] = [
			{
				taskId: "task-1",
				agent: "worker",
				state: "succeeded",
				startedAt: "2024-01-01T00:00:00Z",
				model: "gpt-4o",
			},
			{
				taskId: "task-2",
				agent: "reviewer",
				state: "running",
				startedAt: "2024-01-01T00:00:00Z",
				model: "gpt-4o",
			},
			{
				taskId: "task-3",
				agent: "tester",
				state: "failed",
				startedAt: "2024-01-01T00:00:00Z",
				model: "gpt-4o",
			},
		];

		const result = renderProgress("pi-subagent-abc123", statuses);
		expect(result).toContain("Tmux session: pi-subagent-abc123");
		expect(result).toContain("Attach: tmux attach -t pi-subagent-abc123");
		expect(result).toContain("1 succeeded");
		expect(result).toContain("1 running");
		expect(result).toContain("1 failed");
	});

	it("shows 'starting' when no statuses", () => {
		const result = renderProgress("pi-subagent-abc123", []);
		expect(result).toContain("Progress: starting");
	});

	it("handles single state", () => {
		const statuses: TaskStatus[] = [
			{
				taskId: "task-1",
				agent: "worker",
				state: "running",
				startedAt: "2024-01-01T00:00:00Z",
				model: "gpt-4o",
			},
		];

		const result = renderProgress("session", statuses);
		expect(result).toContain("1 running");
	});
});

describe("renderResults", () => {
	it("renders succeeded task with result", () => {
		const statuses: TaskStatus[] = [
			{
				taskId: "task-1",
				agent: "worker",
				state: "succeeded",
				startedAt: "2024-01-01T00:00:00Z",
				model: "gpt-4o",
				result: "Done!",
			},
		];

		const result = renderResults(statuses, null);
		expect(result).toContain("=== worker / task-1 (succeeded) ===");
		expect(result).toContain("Done!");
	});

	it("renders failed task with error", () => {
		const statuses: TaskStatus[] = [
			{
				taskId: "task-1",
				agent: "worker",
				state: "failed",
				startedAt: "2024-01-01T00:00:00Z",
				model: "gpt-4o",
				errorMessage: "Something broke",
				result: "Partial",
			},
		];

		const result = renderResults(statuses, null);
		expect(result).toContain("=== worker / task-1 (failed) ===");
		expect(result).toContain("Something broke");
		expect(result).toContain("Partial output:\nPartial");
	});

	it("shows '(no output)' when no result", () => {
		const statuses: TaskStatus[] = [
			{
				taskId: "task-1",
				agent: "worker",
				state: "succeeded",
				startedAt: "2024-01-01T00:00:00Z",
				model: "gpt-4o",
			},
		];

		const result = renderResults(statuses, null);
		expect(result).toContain("(no output)");
	});

	it("includes artifacts path when provided", () => {
		const statuses: TaskStatus[] = [
			{
				taskId: "task-1",
				agent: "worker",
				state: "succeeded",
				startedAt: "2024-01-01T00:00:00Z",
				model: "gpt-4o",
				result: "Done",
			},
		];

		const result = renderResults(statuses, "/tmp/artifacts");
		expect(result).toContain("Artifacts retained at: /tmp/artifacts");
	});

	it("renders multiple tasks", () => {
		const statuses: TaskStatus[] = [
			{
				taskId: "task-1",
				agent: "worker",
				state: "succeeded",
				startedAt: "2024-01-01T00:00:00Z",
				model: "gpt-4o",
				result: "A",
			},
			{
				taskId: "task-2",
				agent: "reviewer",
				state: "failed",
				startedAt: "2024-01-01T00:00:00Z",
				model: "gpt-4o",
				errorMessage: "B",
			},
		];

		const result = renderResults(statuses, null);
		expect(result).toContain("=== worker / task-1 (succeeded) ===");
		expect(result).toContain("=== reviewer / task-2 (failed) ===");
	});
});

describe("delay", () => {
	it("resolves after specified milliseconds", async () => {
		const start = Date.now();
		await delay(50);
		const elapsed = Date.now() - start;
		expect(elapsed).toBeGreaterThanOrEqual(45);
	});

	it("rejects when signal is already aborted", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(delay(1000, controller.signal)).rejects.toThrow(
			"Subagent run cancelled",
		);
	});

	it("rejects when signal aborts during delay", async () => {
		const controller = new AbortController();
		const promise = delay(1000, controller.signal);

		setTimeout(() => controller.abort(), 50);

		await expect(promise).rejects.toThrow("Subagent run cancelled");
	});

	it("resolves normally without signal", async () => {
		await expect(delay(10)).resolves.toBeUndefined();
	});
});
