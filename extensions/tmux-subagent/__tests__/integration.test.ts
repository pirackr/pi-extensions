import { describe, it, expect, vi, beforeEach } from "vitest";

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

vi.mock("node:child_process", () => ({ execFile: vi.fn() }));

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

// The tmux orchestration module is replaced: the tool must drive everything
// through launchBatch/cancelPanes, never by issuing raw tmux session commands.
vi.mock("../tmux.ts", async () => {
	const actual = await vi.importActual<typeof import("../tmux.ts")>(
		"../tmux.ts",
	);
	return {
		...actual,
		launchBatch: vi.fn(),
		cancelPanes: vi.fn().mockResolvedValue(undefined),
		findParentWindow: vi.fn().mockResolvedValue(null),
		renameWindow: vi.fn().mockResolvedValue(undefined),
		closeParentWindow: vi.fn().mockResolvedValue(undefined),
	};
});

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as configMod from "../config.ts";
import piTmuxSubagent from "../index.ts";
import {
	cancelPanes,
	closeParentWindow,
	findParentWindow,
	launchBatch,
	renameWindow,
} from "../tmux.ts";

describe("shared tmux integration", () => {
	function setupSharedTool() {
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
		const onCalls: Array<[string, (...args: unknown[]) => unknown]> = [];
		const mockPi = {
			registerTool: (tool: any) => registered.push(tool),
			on: (event: string, handler: (...args: unknown[]) => unknown) => {
				onCalls.push([event, handler]);
			},
		};
		piTmuxSubagent(mockPi as any);
		const tool = registered.find((t: any) => t.name === "run_subagents");
		return { tool, onCalls };
	}

	function stubBasicFs() {
		vi.mocked(fs.promises.access).mockResolvedValue(undefined as any);
		vi.mocked(fs.promises.stat).mockResolvedValue({ isDirectory: () => true } as any);
		vi.mocked(fs.promises.realpath).mockImplementation(async () => "/tmp");
		vi.mocked(fs.promises.mkdtemp).mockImplementation(async () => "/tmp/pi-subagent-test");
		vi.mocked(os.tmpdir).mockReturnValue("/tmp");
		vi.mocked(os.homedir).mockReturnValue("/home/user");
		vi.mocked(fs.promises.mkdir).mockResolvedValue(undefined as any);
		vi.mocked(fs.promises.chmod).mockResolvedValue(undefined as any);
		vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined as any);
		vi.mocked(fs.promises.rm).mockResolvedValue(undefined as any);
		const mockExecFile = vi.mocked(execFile);
		mockExecFile.mockImplementation((_cmd, _args, _opts, cb) => {
			if (_cmd === "tmux" && _args?.[0] === "-V") {
				cb!(null, "3.4.0", "");
			} else {
				cb!(new Error("unexpected command"), "", "");
			}
			return undefined as any;
		});
	}

	function sessionCtx(overrides: Record<string, unknown> = {}) {
		return {
			cwd: "/tmp",
			sessionManager: {
				getSessionId: () => "sess-1",
				getSessionName: () => "Observability",
				getEntries: () => [],
				getBranch: () => [],
			},
			...overrides,
		};
	}

	function launchResult(overrides: Record<string, unknown> = {}) {
		return {
			session: "pi-subagents",
			window: {
				id: "@3",
				name: "tmp-observability",
				sessionId: "sess-1",
				pid: "1",
				cwd: "/tmp",
			},
			paneIds: ["%5"],
			...overrides,
		} as any;
	}

	function terminalStatus() {
		return JSON.stringify({
			taskId: "task-1",
			agent: "worker",
			state: "succeeded",
			startedAt: "2024-01-01T00:00:00Z",
			model: "gpt-4o",
			result: "done",
		});
	}

	beforeEach(() => {
		vi.mocked(launchBatch).mockReset();
		vi.mocked(cancelPanes).mockReset();
		vi.mocked(findParentWindow).mockReset();
		vi.mocked(renameWindow).mockReset();
		vi.mocked(closeParentWindow).mockReset();
		vi.mocked(cancelPanes).mockResolvedValue(undefined);
		vi.mocked(renameWindow).mockResolvedValue(undefined);
		vi.mocked(closeParentWindow).mockResolvedValue(undefined);
	});

	it("derives parent identity from SessionManager and launches through the shared session", async () => {
		const { tool } = setupSharedTool();
		stubBasicFs();
		vi.mocked(fs.promises.readFile).mockResolvedValue(terminalStatus() as any);
		vi.mocked(launchBatch).mockResolvedValue(launchResult());

		const result = await tool!.execute(
			"call-id",
			{
				tasks: [{ agent: "worker", objective: "test" }],
				retain_artifacts: "always",
			},
			new AbortController().signal,
			undefined,
			sessionCtx(),
		);

		const launchCall = vi.mocked(launchBatch).mock.calls[0][1] as any;
		expect(launchCall.sessionId).toBe("sess-1");
		expect(launchCall.windowName).toBe("tmp-observability");
		expect(launchCall.panes).toHaveLength(1);
		expect(launchCall.panes[0].taskId).toBe("task-1");
		// No per-batch session or per-agent window is ever created.
		const tmuxCalls = vi.mocked(execFile).mock.calls.filter((c) => c[0] === "tmux");
		expect(tmuxCalls.some((c) => c[1]?.includes("new-session"))).toBe(false);
		expect(tmuxCalls.some((c) => c[1]?.includes("new-window"))).toBe(false);
		// Compatibility fields survive in the details.
		expect((result as any).details.session).toBe("pi-subagents");
		expect((result as any).details.windowId).toBe("@3");
		expect((result as any).details.attachCommand).toBe(
			"tmux attach -t pi-subagents:@3",
		);
		expect((result as any).details.artifactsPath).toBe("/tmp/pi-subagent-test");
		expect(Array.isArray((result as any).details.results)).toBe(true);
	});

	it("creates 0700 transcript dirs and carries transcript paths in requests", async () => {
		const { tool } = setupSharedTool();
		stubBasicFs();
		vi.mocked(launchBatch).mockResolvedValue(launchResult());

		await tool!.execute(
			"call-id",
			{ tasks: [{ agent: "worker", objective: "test" }] },
			new AbortController().signal,
			undefined,
			sessionCtx(),
		);

		const mkdirCalls = vi.mocked(fs.promises.mkdir).mock.calls;
		const transcriptMkdirs = mkdirCalls.filter((call) =>
			String(call[0]).includes("pi-subagent-transcripts"),
		);
		expect(transcriptMkdirs.length).toBeGreaterThanOrEqual(2);
		for (const call of transcriptMkdirs) {
			expect((call[1] as any).mode).toBe(0o700);
		}
		expect(transcriptMkdirs.some((c) => String(c[0]).includes("/sess-1/"))).toBe(
			true,
		);

		const written = vi.mocked(fs.promises.writeFile).mock.calls;
		const requestFile = written.find((call) =>
			String(call[0]).endsWith("task-1.json"),
		);
		const request = JSON.parse(requestFile![1] as string);
		expect(request.transcriptPath).toBe(
			"/tmp/pi-subagent-transcripts/sess-1/pi-subagent-test/task-1.log",
		);
	});

	it("keeps artifact cleanup exactly per retain_artifacts policy", async () => {
		const { tool } = setupSharedTool();
		stubBasicFs();
		vi.mocked(launchBatch).mockResolvedValue(launchResult());
		const mockRm = vi.mocked(fs.promises.rm);

		// never: run artifacts are removed after the run.
		await tool!.execute(
			"call-id",
			{ tasks: [{ agent: "worker", objective: "test" }], retain_artifacts: "never" },
			new AbortController().signal,
			undefined,
			sessionCtx(),
		);
		expect(mockRm).toHaveBeenCalledWith("/tmp/pi-subagent-test", {
			recursive: true,
			force: true,
		});

		// always: artifacts survive.
		mockRm.mockClear();
		const ok = await tool!.execute(
			"call-id",
			{ tasks: [{ agent: "worker", objective: "test" }], retain_artifacts: "always" },
			new AbortController().signal,
			undefined,
			sessionCtx(),
		);
		expect(mockRm).not.toHaveBeenCalled();
		expect((ok as any).details.artifactsPath).toBe("/tmp/pi-subagent-test");
	});

	it("abort cancels only the panes launched by that call", async () => {
		const { tool } = setupSharedTool();
		stubBasicFs();
		vi.mocked(launchBatch).mockResolvedValue(
			launchResult({ paneIds: ["%5", "%6"] }),
		);
		const controller = new AbortController();
		controller.abort();

		await expect(
			tool!.execute(
				"call-id",
				{ tasks: [{ agent: "worker", objective: "test" }] },
				controller.signal,
				undefined,
				sessionCtx(),
			),
		).rejects.toThrow("Subagent run cancelled");
		expect(vi.mocked(cancelPanes)).toHaveBeenCalledWith(
			expect.anything(),
			["%5", "%6"],
		);
	});

	it("supervisor timeout cancels only the panes launched by that call", async () => {
		vi.useFakeTimers();
		try {
			const { tool } = setupSharedTool();
			stubBasicFs();
			// Status never becomes terminal: the poll loop runs to the deadline.
			vi.mocked(fs.promises.readFile).mockRejectedValue(
				Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
			);
			vi.mocked(launchBatch).mockResolvedValue(
				launchResult({ paneIds: ["%5", "%6"] }),
			);

			const promise = tool!.execute(
				"call-id",
				{ tasks: [{ agent: "worker", objective: "test" }] },
				new AbortController().signal,
				undefined,
				sessionCtx(),
			);
			// Profile timeout 600s + 15s supervisor margin.
			await vi.advanceTimersByTimeAsync(620_000);
			const result = await promise;
			expect(vi.mocked(cancelPanes)).toHaveBeenCalledWith(
				expect.anything(),
				["%5", "%6"],
			);
			const statuses = (result as any).details.results;
			expect(statuses[0].state).toBe("timed_out");
		} finally {
			vi.useRealTimers();
		}
	});

	it("session_info_changed renames the metadata-matched window", async () => {
		const { onCalls } = setupSharedTool();
		const handler = onCalls.find(([event]) => event === "session_info_changed")![1];
		vi.mocked(findParentWindow).mockResolvedValue({
			id: "@3",
			name: "tmp-observability",
			sessionId: "sess-1",
			pid: "1",
			cwd: "/tmp",
		} as any);
		await handler({ name: "New Topic" }, sessionCtx());
		await vi.waitFor(() => {
			expect(vi.mocked(renameWindow)).toHaveBeenCalledWith(
				expect.anything(),
				"@3",
				expect.stringContaining("new-topic"),
			);
		});
	});

	it("session_shutdown closes only the matched parent window", async () => {
		const { onCalls } = setupSharedTool();
		const handler = onCalls.find(([event]) => event === "session_shutdown")![1];
		vi.mocked(findParentWindow).mockResolvedValue({
			id: "@3",
			name: "tmp-observability",
			sessionId: "sess-1",
			pid: "1",
			cwd: "/tmp",
		} as any);
		await handler({}, sessionCtx());
		await vi.waitFor(() => {
			expect(vi.mocked(closeParentWindow)).toHaveBeenCalledWith(
				expect.anything(),
				"@3",
			);
		});
		// findParentWindow was resolved against this session's id.
		expect(vi.mocked(findParentWindow)).toHaveBeenCalledWith(
			expect.anything(),
			"sess-1",
		);
	});
});
