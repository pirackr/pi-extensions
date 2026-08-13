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
		Literal: vi.fn((val: any) => ({ literal: val })),
		Union: vi.fn((items: any, opts: any) => ({ union: items, ...opts })),
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

vi.mock("../../deep-research/session.ts", () => ({
	getActiveResearchBudgets: vi.fn().mockReturnValue({
		maxSearchesPerAgent: null,
		maxFetchesPerAgent: null,
	}),
	setActiveResearchBudgets: vi.fn(),
	clearActiveResearchBudgets: vi.fn(),
}));

vi.mock("node:os", () => ({
	homedir: vi.fn().mockReturnValue("/home/user"),
	tmpdir: vi.fn().mockReturnValue("/tmp"),
}));

// The tmux orchestration module is replaced for integration tests: launch
// rejects by default (preserving the existing tests' expectations), and the
// shared-session/lifecycle tests below override it with controlled results.
vi.mock("../tmux.ts", async () => {
	const actual =
		await vi.importActual<typeof import("../tmux.ts")>("../tmux.ts");
	return {
		...actual,
		launchBatch: vi.fn().mockRejectedValue(new Error("unexpected command")),
		cancelPanes: vi.fn().mockResolvedValue(undefined),
		findParentWindow: vi.fn().mockResolvedValue(null),
		renameWindow: vi.fn().mockResolvedValue(undefined),
		closeParentWindow: vi.fn().mockResolvedValue(undefined),
	};
});

import { execFile } from "node:child_process";
import * as os from "node:os";
import piTmuxSubagent from "../index.ts";

import * as fs from "node:fs";
import * as configMod from "../config.ts";
import { getActiveResearchBudgets } from "../../deep-research/session.ts";
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
	validateAndExportSummaryResults,
	type TaskStatus,
	type PreparedTask,
} from "../index.ts";
import { cancelPanes, launchBatch } from "../tmux.ts";

const mockExecFile = vi.mocked(execFile);
const mockExistsSync = vi.mocked(fs.existsSync);
const mockReadFile = vi.mocked(fs.promises.readFile);
const mockRealpath = vi.mocked(fs.promises.realpath);

// restoreAllMocks() in nested describes wipes module-mock implementations;
// re-establish the tmux orchestrator's default rejection before every test.
beforeEach(() => {
	vi.mocked(launchBatch).mockRejectedValue(new Error("unexpected command"));
	vi.mocked(cancelPanes).mockResolvedValue(undefined);
});

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

		const result = buildTaskPrompt(task, "full");
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
		const result = buildTaskPrompt(task, "full");
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
		const result = buildTaskPrompt(task, "full");
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

		const result = renderProgress(
			"pi-subagents",
			"w/g/pi-extensions-observability",
			"@3",
			statuses,
		);
		expect(result).toContain("Tmux session: pi-subagents");
		expect(result).toContain("Window: w/g/pi-extensions-observability (@3)");
		expect(result).toContain("Attach: tmux attach -t pi-subagents:@3");
		expect(result).toContain("1 succeeded");
		expect(result).toContain("1 running");
		expect(result).toContain("1 failed");
		expect(result).toContain("task-1 (worker) [gpt-4o] succeeded");
		expect(result).toContain("task-2 (reviewer) [gpt-4o] running");
		expect(result).toContain("task-3 (tester) [gpt-4o] failed");
		expect(result).toContain("1 running");
		expect(result).toContain("1 failed");
	});

	it("shows 'starting' when no statuses", () => {
		const result = renderProgress(
			"pi-subagents",
			"w/g/pi-extensions",
			"@3",
			[],
		);
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

		const result = renderProgress(
			"pi-subagents",
			"w/g/pi-extensions",
			"@3",
			statuses,
		);
		expect(result).toContain("1 running");
		expect(result).toContain("task-1 (worker) [gpt-4o] running");
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
		expect(result).toContain(
			"=== worker / task-1 (succeeded) — model: gpt-4o ===",
		);
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
		expect(result).toContain(
			"=== worker / task-1 (failed) — model: gpt-4o ===",
		);
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
		expect(result).toContain(
			"=== worker / task-1 (succeeded) — model: gpt-4o ===",
		);
		expect(result).toContain(
			"=== reviewer / task-2 (failed) — model: gpt-4o ===",
		);
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

describe("validateAndExportSummaryResults", () => {
	const mockRenameSync = vi.fn();
	const mockWriteFile = vi.mocked(fs.promises.writeFile);
	const mockMkdir = vi.mocked(fs.promises.mkdir);
	const mockRm = vi.mocked(fs.promises.rm);

	beforeEach(() => {
		vi.spyOn(fs, "renameSync").mockImplementation(mockRenameSync);
		mockWriteFile.mockReset();
		mockMkdir.mockReset();
		mockRm.mockReset();
		mockRenameSync.mockReset();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	function makeStatus(overrides: Partial<TaskStatus> = {}): TaskStatus {
		return {
			taskId: "task-1",
			agent: "scout",
			state: "succeeded",
			startedAt: "2024-01-01T00:00:00Z",
			model: "test-model",
			result: `<coordinator-summary>
Status: succeeded
Outcome: done
Evidence added: 1
Key changes: none
Contradictions/blockers: none
Recommended next action: proceed
</coordinator-summary>`,
			...overrides,
		};
	}

	function makePrepared(overrides: Partial<PreparedTask> = {}): PreparedTask {
		return {
			task: { agent: "scout", objective: "test" },
			profile: {
				name: "scout",
				description: "scout",
				model: "test",
				tools: [],
				access: "read",
				systemPrompt: "prompt",
				filePath: "/p",
				source: "bundled",
			},
			cwd: "/tmp",
			timeoutSeconds: 300,
			taskId: "task-1",
			...overrides,
		};
	}

	it("succeeds when coordinator-summary is present and valid", async () => {
		const statuses = [makeStatus()];
		const prepared = [makePrepared()];
		await validateAndExportSummaryResults(statuses, prepared);
		expect(statuses[0].state).toBe("succeeded");
		expect((statuses[0] as any).parsedResult).toBeDefined();
		expect((statuses[0] as any).parsedResult.summary.status).toBe("succeeded");
	});

	it("fails when coordinator-summary block is missing", async () => {
		const statuses = [makeStatus({ result: "no summary here" })];
		const prepared = [makePrepared()];
		await validateAndExportSummaryResults(statuses, prepared);
		expect(statuses[0].state).toBe("failed");
		expect(statuses[0].errorMessage).toContain(
			"Structured result validation failed",
		);
		expect(statuses[0].errorMessage).toContain(
			"Missing <coordinator-summary> block",
		);
	});

	it("fails when coordinator-summary is malformed (invalid status)", async () => {
		const result = `<coordinator-summary>
Status: unknown
Outcome: done
Evidence added: 1
Key changes: none
Contradictions/blockers: none
Recommended next action: proceed
</coordinator-summary>`;
		const statuses = [makeStatus({ result })];
		const prepared = [makePrepared()];
		await validateAndExportSummaryResults(statuses, prepared);
		expect(statuses[0].state).toBe("failed");
		expect(statuses[0].errorMessage).toContain("invalid Status value");
	});

	it("skips non-succeeded tasks", async () => {
		const statuses = [makeStatus({ state: "failed", errorMessage: "err" })];
		const prepared = [makePrepared()];
		await validateAndExportSummaryResults(statuses, prepared);
		expect(statuses[0].state).toBe("failed");
		expect(statuses[0].errorMessage).toBe("err");
	});

	it("exports artifact atomically when result_path is supplied", async () => {
		const result = `<coordinator-summary>
Status: succeeded
Outcome: done
Evidence added: 1
Key changes: none
Contradictions/blockers: none
Recommended next action: proceed
</coordinator-summary>
<artifact>artifact payload</artifact>`;
		const statuses = [makeStatus({ result })];
		const prepared = [
			makePrepared({
				task: {
					agent: "scout",
					objective: "test",
					result_path: "/data/out.org",
				},
			}),
		];
		mockWriteFile.mockResolvedValue(undefined as any);
		mockMkdir.mockResolvedValue(undefined as any);
		mockRenameSync.mockReturnValue(undefined as any);

		await validateAndExportSummaryResults(statuses, prepared);

		expect(statuses[0].state).toBe("succeeded");
		expect(mockMkdir).toHaveBeenCalledWith("/data", { recursive: true });
		expect(mockWriteFile).toHaveBeenCalled();
		expect(mockRenameSync).toHaveBeenCalledWith(
			expect.stringContaining(".tmp"),
			"/data/out.org",
		);
	});

	it("does not require artifact when result_path is not supplied", async () => {
		const result = `<coordinator-summary>
Status: succeeded
Outcome: done
Evidence added: 1
Key changes: none
Contradictions/blockers: none
Recommended next action: proceed
</coordinator-summary>`;
		const statuses = [makeStatus({ result })];
		const prepared = [makePrepared()];
		await validateAndExportSummaryResults(statuses, prepared);
		expect(statuses[0].state).toBe("succeeded");
		expect(mockWriteFile).not.toHaveBeenCalled();
	});

	it("fails when artifact is required but missing", async () => {
		const result = `<coordinator-summary>
Status: succeeded
Outcome: done
Evidence added: 1
Key changes: none
Contradictions/blockers: none
Recommended next action: proceed
</coordinator-summary>`;
		const statuses = [makeStatus({ result })];
		const prepared = [
			makePrepared({
				task: {
					agent: "scout",
					objective: "test",
					result_path: "/data/out.org",
				},
			}),
		];
		await validateAndExportSummaryResults(statuses, prepared);
		expect(statuses[0].state).toBe("failed");
		expect(statuses[0].errorMessage).toContain("Missing <artifact> block");
	});

	it("fails the task when export rename fails and cleans up temp", async () => {
		const result = `<coordinator-summary>
Status: succeeded
Outcome: done
Evidence added: 1
Key changes: none
Contradictions/blockers: none
Recommended next action: proceed
</coordinator-summary>
<artifact>artifact payload</artifact>`;
		const statuses = [makeStatus({ result })];
		const prepared = [
			makePrepared({
				task: {
					agent: "scout",
					objective: "test",
					result_path: "/data/out.org",
				},
			}),
		];
		mockWriteFile.mockResolvedValue(undefined as any);
		mockMkdir.mockResolvedValue(undefined as any);
		mockRenameSync.mockImplementation(() => {
			throw new Error("Permission denied");
		});
		mockRm.mockResolvedValue(undefined as any);

		await validateAndExportSummaryResults(statuses, prepared);

		expect(statuses[0].state).toBe("failed");
		expect(statuses[0].errorMessage).toContain("Result export failed");
		expect(mockRm).toHaveBeenCalled();
	});

	it("preserves the target path when export rename fails", async () => {
		// If the target path already exists, rename failure should not remove it.
		const result = `<coordinator-summary>
Status: succeeded
Outcome: done
Evidence added: 1
Key changes: none
Contradictions/blockers: none
Recommended next action: proceed
</coordinator-summary>
<artifact>artifact payload</artifact>`;
		const statuses = [makeStatus({ result })];
		const prepared = [
			makePrepared({
				task: {
					agent: "scout",
					objective: "test",
					result_path: "/data/out.org",
				},
			}),
		];
		mockWriteFile.mockResolvedValue(undefined as any);
		mockMkdir.mockResolvedValue(undefined as any);
		mockRenameSync.mockImplementation(() => {
			throw new Error("EEXIST");
		});
		mockRm.mockResolvedValue(undefined as any);

		await validateAndExportSummaryResults(statuses, prepared);

		expect(statuses[0].state).toBe("failed");
		// Target path should not have been touched by the cleanup.
		expect(mockRm).toHaveBeenCalledWith(expect.stringContaining(".tmp"), {
			force: true,
		});
	});

	it("includes parsed result and result_path on statuses", async () => {
		const result = `<coordinator-summary>
Status: partial
Outcome: partial work
Evidence added: 2
Key changes: item1
Contradictions/blockers: blocker1
Recommended next action: retry
</coordinator-summary>
<artifact>org fragment content</artifact>`;
		const statuses = [makeStatus({ result })];
		const prepared = [
			makePrepared({
				task: {
					agent: "scout",
					objective: "test",
					result_path: "/data/out.org",
				},
			}),
		];
		await validateAndExportSummaryResults(statuses, prepared);
		const s = statuses[0] as any;
		expect(s.parsedResult.summary.status).toBe("partial");
		expect(s.parsedResult.summary.outcome).toBe("partial work");
		expect(s.parsedResult.summary.keyChanges).toEqual(["item1"]);
		expect(s.parsedResult.summary.contradictions).toEqual(["blocker1"]);
		expect(s.result_path).toBe("/data/out.org");
	});

	it.skip("schema exposes result_path in the TypeBox TaskItem", () => {
		vi.spyOn(configMod, "loadSubagentConfiguration").mockReturnValue({
			config: {
				models: {},
				toolAccess: {},
				agentDirs: [],
				maxTasks: 4,
				defaultTimeoutSeconds: 300,
				retainArtifacts: "on_failure",
				childExtensions: [],
				loadContextFiles: true,
				webSearchMaxLookups: 0,
				webSearchMaxFetches: 0,
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
		});
		const registered: any[] = [];
		const mockPi = {
			registerTool: (tool: any) => registered.push(tool),
			on: vi.fn(),
		};
		piTmuxSubagent(mockPi as any);
		const tool = registered.find((t: any) => t.name === "run_subagents");
		expect(tool).toBeDefined();
		// The mocked Type.Object returns the props object directly.
		// C1: result_path must be present in the schema definition.
		const paramsSchema = tool!.parameters;
		expect(paramsSchema).toHaveProperty("tasks");
		const taskItemSchema = (paramsSchema as any).tasks;
		expect(taskItemSchema).toBeDefined();
		const taskItemProps = (taskItemSchema as any).item;
		expect(taskItemProps).toHaveProperty("result_path");
	});

	it.skip("rejects a relative result_path upfront", async () => {
		vi.spyOn(configMod, "loadSubagentConfiguration").mockReturnValue({
			config: {
				models: {},
				toolAccess: {},
				agentDirs: [],
				maxTasks: 4,
				defaultTimeoutSeconds: 300,
				retainArtifacts: "on_failure",
				childExtensions: [],
				loadContextFiles: true,
				webSearchMaxLookups: 0,
				webSearchMaxFetches: 0,
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
		});
		const registered: any[] = [];
		const mockPi = {
			registerTool: (tool: any) => registered.push(tool),
			on: vi.fn(),
		};
		piTmuxSubagent(mockPi as any);
		const tool = registered.find((t: any) => t.name === "run_subagents");
		expect(tool).toBeDefined();

		const mockExecFile = vi.mocked(execFile);
		mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
			if (_cmd === "tmux" && _args?.[0] === "-V") {
				cb!(null, "3.4.0", "");
			} else {
				cb!(new Error("unexpected command"), "", "");
			}
			return undefined as any;
		});
		const mockAccess = vi.mocked(fs.promises.access);
		mockAccess.mockResolvedValue(undefined as any);
		const mockStat = vi.mocked(fs.promises.stat);
		mockStat.mockResolvedValue({ isDirectory: () => true } as any);

		await expect(
			tool!.execute(
				"call-id",
				{
					tasks: [
						{
							agent: "worker",
							objective: "test",
							result_path: "relative/path.org", // not absolute
						},
					],
				},
				new AbortController().signal,
				undefined,
				{ cwd: "/tmp" },
			),
		).rejects.toThrow("result_path must be an absolute path");
	});

	it.skip("accepts an absolute result_path", async () => {
		vi.spyOn(configMod, "loadSubagentConfiguration").mockReturnValue({
			config: {
				models: {},
				toolAccess: {},
				agentDirs: [],
				maxTasks: 4,
				defaultTimeoutSeconds: 300,
				retainArtifacts: "on_failure",
				childExtensions: [],
				loadContextFiles: true,
				webSearchMaxLookups: 0,
				webSearchMaxFetches: 0,
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
		});
		const registered: any[] = [];
		const mockPi = {
			registerTool: (tool: any) => registered.push(tool),
			on: vi.fn(),
		};
		piTmuxSubagent(mockPi as any);
		const tool = registered.find((t: any) => t.name === "run_subagents");
		expect(tool).toBeDefined();

		const mockExecFile = vi.mocked(execFile);
		mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
			if (_cmd === "tmux" && _args?.[0] === "-V") {
				cb!(null, "3.4.0", "");
			} else {
				cb!(new Error("unexpected command"), "", "");
			}
			return undefined as any;
		});
		const mockAccess = vi.mocked(fs.promises.access);
		mockAccess.mockResolvedValue(undefined as any);
		const mockStat = vi.mocked(fs.promises.stat);
		mockStat.mockResolvedValue({ isDirectory: () => true } as any);
		vi.mocked(fs.promises.realpath).mockImplementation(async () => "/tmp");
		vi.mocked(fs.promises.mkdtemp).mockImplementation(
			async () => "/tmp/pi-subagent-test",
		);
		// vi.restoreAllMocks() in this describe's afterEach wipes module-mock
		// implementations (os.tmpdir etc.) — re-establish what execute() needs.
		vi.mocked(os.tmpdir).mockReturnValue("/tmp");
		vi.mocked(os.homedir).mockReturnValue("/home/user");

		// Should not throw the absolute-path error; any later error is expected.
		await expect(
			tool!.execute(
				"call-id",
				{
					tasks: [
						{
							agent: "worker",
							objective: "test",
							result_path: "/absolute/path.org",
						},
					],
				},
				new AbortController().signal,
				undefined,
				{ cwd: "/tmp" },
			),
		).rejects.toThrow("unexpected command");
	});
});

/**
 * NOTE: The "active research session budget enforcement" suite tests the
 * `run_subagents` tool which was removed from the tmux extension (Task 5).
 */
describe.skip("active research session budget enforcement", () => {
	function buildTool() {
		vi.spyOn(configMod, "loadSubagentConfiguration").mockReturnValue({
			config: {
				models: {},
				toolAccess: {},
				agentDirs: [],
				maxTasks: 4,
				defaultTimeoutSeconds: 300,
				retainArtifacts: "on_failure",
				childExtensions: [],
				loadContextFiles: true,
				webSearchMaxLookups: 10,
				webSearchMaxFetches: 5,
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
		});
		const registered: any[] = [];
		const mockPi = {
			registerTool: (tool: any) => registered.push(tool),
			on: vi.fn(),
		};
		piTmuxSubagent(mockPi as any);
		return registered.find((t: any) => t.name === "run_subagents");
	}

	function stubTmuxCalls() {
		const mockExecFile = vi.mocked(execFile);
		mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
			// -V and new-session must succeed so execute() reaches the requests loop
			// (request.json gets written there); new-window then rejects, which lets
			// the test capture the request file and observe the rejection.
			if (
				_cmd === "tmux" &&
				(_args?.[0] === "-V" || _args?.[0] === "new-session")
			) {
				cb!(null, "3.4.0", "");
			} else {
				cb!(new Error("unexpected command"), "", "");
			}
			return undefined as any;
		});
		vi.mocked(fs.promises.access).mockResolvedValue(undefined as any);
		vi.mocked(fs.promises.stat).mockResolvedValue({
			isDirectory: () => true,
		} as any);
		vi.mocked(fs.promises.realpath).mockImplementation(async () => "/tmp");
		vi.mocked(fs.promises.mkdtemp).mockImplementation(
			async () => "/tmp/pi-subagent-test",
		);
		vi.mocked(os.tmpdir).mockReturnValue("/tmp");
		vi.mocked(os.homedir).mockReturnValue("/home/user");
		// Terminal status so the finally-block shutdown poll exits immediately
		// instead of burning its 6s deadline (which exceeds the 5s test timeout).
		vi.mocked(fs.promises.readFile).mockResolvedValue(
			JSON.stringify({
				taskId: "task-1",
				agent: "worker",
				state: "succeeded",
				startedAt: "2024-01-01T00:00:00Z",
				model: "gpt-4o",
			}) as any,
		);
	}

	function captureRequest(): {
		webSearchMaxLookups: number;
		webSearchMaxFetches: number;
	} | null {
		const writtenFiles = vi.mocked(fs.promises.writeFile).mock.calls;
		const requestFile = writtenFiles.find(
			(call: unknown[]) =>
				String(call[0]).includes("request") &&
				String(call[0]).endsWith(".json"),
		);
		if (!requestFile) return null;
		return JSON.parse(requestFile[1] as string) as {
			webSearchMaxLookups: number;
			webSearchMaxFetches: number;
		};
	}

	beforeEach(() => {
		vi.mocked(fs.promises.writeFile).mockClear();
	});

	it("falls back to config defaults when no active research session exists", async () => {
		vi.mocked(getActiveResearchBudgets).mockReturnValue({
			maxSearchesPerAgent: null,
			maxFetchesPerAgent: null,
		});
		const tool = buildTool();
		stubTmuxCalls();

		await expect(
			tool!.execute(
				"call-id",
				{ tasks: [{ agent: "worker", objective: "test" }] },
				new AbortController().signal,
				undefined,
				{ cwd: "/tmp" },
			),
		).rejects.toThrow("unexpected command");

		const req = captureRequest();
		expect(req).not.toBeNull();
		expect(req!.webSearchMaxLookups).toBe(10); // from config
		expect(req!.webSearchMaxFetches).toBe(5); // from config
	});

	it("applies active research budget as hard cap even when task arg is absent", async () => {
		vi.mocked(getActiveResearchBudgets).mockReturnValue({
			maxSearchesPerAgent: 3,
			maxFetchesPerAgent: 2,
		});
		const tool = buildTool();
		stubTmuxCalls();

		await expect(
			tool!.execute(
				"call-id",
				{ tasks: [{ agent: "worker", objective: "test" }] },
				new AbortController().signal,
				undefined,
				{ cwd: "/tmp" },
			),
		).rejects.toThrow("unexpected command");

		const req = captureRequest();
		expect(req).not.toBeNull();
		expect(req!.webSearchMaxLookups).toBe(3); // active budget cap
		expect(req!.webSearchMaxFetches).toBe(2); // active budget cap
	});

	it("BYPASS TEST: task arg cannot exceed a stricter active budget", async () => {
		// Active session budget is 5 searches, 4 fetches.
		vi.mocked(getActiveResearchBudgets).mockReturnValue({
			maxSearchesPerAgent: 5,
			maxFetchesPerAgent: 4,
		});
		const tool = buildTool();
		stubTmuxCalls();

		await expect(
			tool!.execute(
				"call-id",
				{
					tasks: [
						{
							agent: "worker",
							objective: "test",
							webSearchMaxLookups: 100, // task tries to bypass
							webSearchMaxFetches: 200, // task tries to bypass
						},
					],
				},
				new AbortController().signal,
				undefined,
				{ cwd: "/tmp" },
			),
		).rejects.toThrow("unexpected command");

		const req = captureRequest();
		expect(req).not.toBeNull();
		// Task arg of 100 must be capped at active budget of 5.
		expect(req!.webSearchMaxLookups).toBe(5);
		// Task arg of 200 must be capped at active budget of 4.
		expect(req!.webSearchMaxFetches).toBe(4);
	});

	it("honours a looser task arg when no active research session is present", async () => {
		vi.mocked(getActiveResearchBudgets).mockReturnValue({
			maxSearchesPerAgent: null,
			maxFetchesPerAgent: null,
		});
		const tool = buildTool();
		stubTmuxCalls();

		await expect(
			tool!.execute(
				"call-id",
				{
					tasks: [
						{
							agent: "worker",
							objective: "test",
							webSearchMaxLookups: 50,
							webSearchMaxFetches: 25,
						},
					],
				},
				new AbortController().signal,
				undefined,
				{ cwd: "/tmp" },
			),
		).rejects.toThrow("unexpected command");

		const req = captureRequest();
		expect(req).not.toBeNull();
		// No active session → task arg wins.
		expect(req!.webSearchMaxLookups).toBe(50);
		expect(req!.webSearchMaxFetches).toBe(25);
	});

	it("0 in active budget means unlimited (task arg is respected)", async () => {
		// 0 = unlimited active budget; task arg should pass through.
		vi.mocked(getActiveResearchBudgets).mockReturnValue({
			maxSearchesPerAgent: 0,
			maxFetchesPerAgent: 0,
		});
		const tool = buildTool();
		stubTmuxCalls();

		await expect(
			tool!.execute(
				"call-id",
				{
					tasks: [
						{
							agent: "worker",
							objective: "test",
							webSearchMaxLookups: 7,
							webSearchMaxFetches: 3,
						},
					],
				},
				new AbortController().signal,
				undefined,
				{ cwd: "/tmp" },
			),
		).rejects.toThrow("unexpected command");

		const req = captureRequest();
		expect(req).not.toBeNull();
		// Active budget 0 = unlimited, so task arg is not capped.
		expect(req!.webSearchMaxLookups).toBe(7);
		expect(req!.webSearchMaxFetches).toBe(3);
	});
});
