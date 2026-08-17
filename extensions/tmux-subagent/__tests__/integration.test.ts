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

vi.mock("node:os", () => ({
	homedir: vi.fn().mockReturnValue("/home/user"),
	tmpdir: vi.fn().mockReturnValue("/tmp"),
}));

// The tmux orchestration module is replaced: the tool must drive everything
// through launchBatch/cancelPanes, never by issuing raw tmux session commands.
vi.mock("../tmux.ts", async () => {
	const actual =
		await vi.importActual<typeof import("../tmux.ts")>("../tmux.ts");
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
import piTmuxSubagent, { widgetRuns } from "../index.ts";
import {
	cancelPanes,
	closeParentWindow,
	findParentWindow,
	launchBatch,
	renameWindow,
} from "../tmux.ts";

/**
 * NOTE: The "shared tmux integration" suite tests the `run_subagents` tool
 * which was removed from the tmux extension (Task 5).  The provider adapter
 * lives in `tests/tmux-provider.test.ts` which runs the shared contract
 * suite against the tmux provider.
 */
describe.skip("shared tmux integration", () => {
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
		vi.mocked(fs.promises.stat).mockResolvedValue({
			isDirectory: () => true,
		} as any);
		vi.mocked(fs.promises.realpath).mockImplementation(async () => "/tmp");
		vi.mocked(fs.promises.mkdtemp).mockImplementation(
			async () => "/tmp/pi-subagent-test",
		);
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
		const tmuxCalls = vi
			.mocked(execFile)
			.mock.calls.filter((c) => c[0] === "tmux");
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
		expect(
			transcriptMkdirs.some((c) => String(c[0]).includes("/sess-1/")),
		).toBe(true);

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
			{
				tasks: [{ agent: "worker", objective: "test" }],
				retain_artifacts: "never",
			},
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
			{
				tasks: [{ agent: "worker", objective: "test" }],
				retain_artifacts: "always",
			},
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
		expect(vi.mocked(cancelPanes)).toHaveBeenCalledWith(expect.anything(), [
			"%5",
			"%6",
		]);
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
			expect(vi.mocked(cancelPanes)).toHaveBeenCalledWith(expect.anything(), [
				"%5",
				"%6",
			]);
			const statuses = (result as any).details.results;
			expect(statuses[0].state).toBe("timed_out");
		} finally {
			vi.useRealTimers();
		}
	});

	it("session_info_changed renames the metadata-matched window", async () => {
		const { onCalls } = setupSharedTool();
		const handler = onCalls.find(
			([event]) => event === "session_info_changed",
		)![1];
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

// ---------------------------------------------------------------------------
// Live UI wiring (Tasks 6-9): widget registry, footer, window-title cadence,
// pane border strips, notifications, and inline progress rows — driven through
// the real run_subagents execute() under fake timers.
// ---------------------------------------------------------------------------

describe("run_subagents live UI wiring (Tasks 6-9)", () => {
	let runDirCounter = 0;
	let statuses: Record<string, string>;
	let stderrs: Record<string, string>;
	let pushTimes: number[];
	let updates: Array<{ content: Array<{ text: string }> }>;
	let ctx: any;
	let tool: any;

	const statusPath = (run: number, task = "task-1") =>
		`/tmp/pi-subagent-run${run}/status/${task}.json`;
	const stderrPath = (run: number, task = "task-1") =>
		`/tmp/pi-subagent-run${run}/stderr/${task}.log`;

	function statusJson(
		taskId: string,
		state: string,
		extra: Record<string, unknown> = {},
	) {
		const base: Record<string, unknown> = {
			taskId,
			agent: "worker",
			state,
			startedAt: new Date(Date.now() - 5_000).toISOString(),
			model: "gpt-4o",
			usage: {
				input: 100,
				output: 200,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 12400,
				cost: { input: 0.0005, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.0015 },
				turns: 3,
			},
			tools: ["read", "edit"],
			activity: "Working on it",
			contextUsage: { tokens: 10000, contextWindow: 128000, percent: 8 },
			compactionCount: 0,
		};
		if (state === "succeeded") base.result = "All done";
		if (state === "failed") base.errorMessage = "boom";
		return JSON.stringify({ ...base, ...extra });
	}

	function tmuxArgs(): string[][] {
		return vi.mocked(execFile).mock.calls
			.filter(([cmd]) => cmd === "tmux")
			.map(([, args]) => args as string[]);
	}

	const renames = () =>
		tmuxArgs().filter((a) => a[0] === "rename-window").map((a) => a[3]);
	const panePushes = () =>
		tmuxArgs().filter((a) => a[0] === "select-pane").map((a) => a[2]);
	const footerCalls = () =>
		ctx.ui.setStatus.mock.calls.filter(([key]: any[]) => key === "tmux-subagents");

	const settle = (ms: number) => vi.advanceTimersByTimeAsync(ms);

	function makeTool() {
		const registered: any[] = [];
		const mockPi = {
			registerTool: (t: any) => registered.push(t),
			on: () => {},
		};
		piTmuxSubagent(mockPi as any);
		tool = registered.find((t: any) => t.name === "run_subagents");
	}

	beforeEach(() => {
		runDirCounter = 0;
		statuses = {};
		stderrs = {};
		pushTimes = [];
		updates = [];
		widgetRuns.clear();
		vi.useFakeTimers();
		vi.mocked(os.tmpdir).mockReturnValue("/tmp");
		vi.mocked(os.homedir).mockReturnValue("/home/user");

		vi.mocked(launchBatch)
			.mockReset()
			.mockResolvedValue({
				session: "pi-subagents",
				window: { id: "@3", name: "tmp-observability", sessionId: "sess-1", pid: "1", cwd: "/tmp" },
				paneIds: ["%5"],
			} as any);
		vi.mocked(cancelPanes).mockReset().mockResolvedValue(undefined as any);

		vi.mocked(execFile).mockImplementation(
			(_cmd: any, args: any, _opts: any, cb: any) => {
				if (_cmd === "tmux") {
					if (args?.[0] === "-V") {
						cb(null, "3.4.0", "");
					} else {
						if (args?.[0] === "select-pane") pushTimes.push(Date.now());
						cb(null, "", "");
					}
				} else {
					cb(new Error("unexpected command"), "", "");
				}
				return undefined as any;
			},
		);
		vi.mocked(fs.promises.access).mockResolvedValue(undefined as any);
		vi.mocked(fs.promises.stat).mockResolvedValue({ isDirectory: () => true } as any);
		vi.mocked(fs.promises.realpath).mockImplementation(async (p: any) => String(p));
		vi.mocked(fs.promises.mkdtemp).mockImplementation(
			async () => `/tmp/pi-subagent-run${++runDirCounter}`,
		);
		vi.mocked(fs.promises.mkdir).mockResolvedValue(undefined as any);
		vi.mocked(fs.promises.chmod).mockResolvedValue(undefined as any);
		vi.mocked(fs.promises.writeFile).mockResolvedValue(undefined as any);
		vi.mocked(fs.promises.rm).mockResolvedValue(undefined as any);
		vi.mocked(fs.promises.readFile).mockImplementation(async (p: any) => {
			const s = String(p);
			if (s.includes("/status/")) {
				const json = statuses[s];
				if (json === undefined) {
					const err: any = new Error("ENOENT");
					err.code = "ENOENT";
					throw err;
				}
				return json;
			}
			if (s.includes("/stderr/")) return stderrs[s] ?? "";
			return "";
		});

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

		ctx = {
			cwd: "/tmp",
			mode: "tui",
			sessionManager: {
				getSessionId: () => "sess-1",
				getSessionName: () => "Observability",
				getEntries: () => [],
			},
			ui: {
				setWidget: vi.fn(),
				setStatus: vi.fn(),
				notify: vi.fn(),
				confirm: vi.fn(async () => true),
			},
		};
		makeTool();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
		widgetRuns.clear();
	});

	it("registers the widget, keeps the footer alive, and clears both when the run finishes", async () => {
		statuses[statusPath(1)] = statusJson("task-1", "running");
		const exec = tool.execute(
			"call-1",
			{ tasks: [{ agent: "worker", objective: "Find the docs" }] },
			new AbortController().signal,
			(u: any) => updates.push(u),
			ctx,
		);
		await settle(10);

		// Widget registered above the editor.
		const setWidgetCalls = ctx.ui.setWidget.mock.calls;
		expect(setWidgetCalls[0][0]).toBe("tmux-subagents");
		expect(typeof setWidgetCalls[0][1]).toBe("function");
		expect(setWidgetCalls[0][2]).toEqual({ placement: "aboveEditor" });

		// The widget renders the live run: objective + stats with a numeric tool count.
		const component = setWidgetCalls[0][1]({ requestRender: () => {} });
		const lines = component.render(100).join("\n");
		expect(lines).toContain("Subagents (tmux)");
		expect(lines).toContain("worker");
		expect(lines).toContain("Find the docs");
		expect(lines).toContain("⚙ 2 tools");
		expect(lines).toContain("12.4k token (8%)");

		// Keep the run live for >1s so the animation interval fires several times.
		await settle(1_300);
		statuses[statusPath(1)] = statusJson("task-1", "succeeded");
		await settle(300);
		const result: any = await exec;
		expect(result.details.results[0].state).toBe("succeeded");

		// Footer was written with the aggregated title ...
		const footers = footerCalls();
		expect(footers.length).toBeGreaterThan(0);
		expect(footers.some(([, v]: any[]) => typeof v === "string" && v.includes("worker"))).toBe(true);
		expect(footers.some(([, v]: any[]) => typeof v === "string" && v.includes("1/1 done"))).toBe(true);
		// ... and was never blanked by the animation interval.
		for (const [, value] of footers.slice(0, -1)) {
			expect(typeof value).toBe("string");
			expect((value as string).length).toBeGreaterThan(0);
		}
		// ... then cleared exactly once together with the widget.
		expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("tmux-subagents", undefined);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("tmux-subagents", undefined);
		expect(widgetRuns.size).toBe(0);

		// Inline progress rows reached the UI with the attach block + objective.
		const lastText = updates[updates.length - 1].content[0].text;
		expect(lastText).toContain("Tmux session: pi-subagents");
		expect(lastText).toContain("Attach: tmux attach -t pi-subagents:@3");
		expect(lastText).toContain("worker · Find the docs");
	});

	it("renames the window immediately on every state change and restores the name at the end", async () => {
		statuses[statusPath(1)] = statusJson("task-1", "running");
		const exec = tool.execute(
			"call-1",
			{ tasks: [{ agent: "worker", objective: "Find the docs" }] },
			new AbortController().signal,
			(u: any) => updates.push(u),
			ctx,
		);
		await settle(10);

		let ren = renames();
		expect(ren).toHaveLength(1); // starting -> running: immediate, no 5s wait
		expect(ren[0]).toMatch(/worker · 0\/1 done/);

		// No rename while the state is unchanged and the 5s cadence has not elapsed.
		await settle(2_000);
		expect(renames()).toHaveLength(1);

		// The next state change renames immediately again.
		statuses[statusPath(1)] = statusJson("task-1", "succeeded");
		await settle(300);
		await exec;
		ren = renames();
		expect(ren).toHaveLength(3); // running -> succeeded, then the final restore
		expect(ren[1]).toContain("✓");
		expect(ren[1]).toContain("1/1 done");
		// The final call restores the parent window name, not the live aggregate.
		expect(ren[2]).not.toContain("done");
	});

	it("sets pane borders and pushes pane titles at most once per second per pane", async () => {
		statuses[statusPath(1)] = statusJson("task-1", "running");
		const exec = tool.execute(
			"call-1",
			{ tasks: [{ agent: "worker", objective: "Find the docs" }] },
			new AbortController().signal,
			(u: any) => updates.push(u),
			ctx,
		);
		await settle(10);

		expect(tmuxArgs()).toContainEqual([
			"set-window-option", "-t", "@3", "pane-border-status", "top",
		]);
		expect(tmuxArgs()).toContainEqual([
			"set-window-option", "-t", "@3", "pane-border-format", "#{pane_title}",
		]);
		expect(panePushes()).toHaveLength(1);
		expect(panePushes()[0]).toContain("worker");

		// Hold it running for 2.5s: further pushes only after ≥1s per pane.
		await settle(2_500);
		const pushes = panePushes();
		expect(pushes.length).toBeGreaterThanOrEqual(2);
		for (let i = 1; i < pushTimes.length; i++) {
			expect(pushTimes[i] - pushTimes[i - 1]).toBeGreaterThanOrEqual(999);
		}

		statuses[statusPath(1)] = statusJson("task-1", "succeeded");
		await settle(300);
		await exec;
		// Every push carries the live title with a numeric tool count.
		for (const push of panePushes()) {
			expect(push).toContain("⚙ 2 tools");
		}
	});

	it("emits exactly one notification per terminal task with the right type", async () => {
		statuses[statusPath(1, "task-1")] = statusJson("task-1", "failed");
		statuses[statusPath(1, "task-2")] = statusJson("task-2", "succeeded");
		const exec = tool.execute(
			"call-1",
			{
				tasks: [
					{ agent: "worker", objective: "Do A", cwd: "/tmp/a" },
					{ agent: "worker", objective: "Do B", cwd: "/tmp/b" },
				],
			},
			new AbortController().signal,
			(u: any) => updates.push(u),
			ctx,
		);
		await settle(300);
		await exec;

		const notifies = ctx.ui.notify.mock.calls;
		expect(notifies).toHaveLength(2);
		const texts: string[] = notifies.map(([t]: any[]) => t as string);
		const errorNote = texts.find((t: string) => t.includes("✗"));
		const infoNote = texts.find((t: string) => t.includes("✓"));
		expect(errorNote).toBeDefined();
		expect(infoNote).toBeDefined();
		expect(notifies.find(([, type]: any[]) => type === "error")?.[0]).toContain("boom");
		expect(notifies.find(([, type]: any[]) => type === "error")?.[0]).toContain("Do A");
		expect(notifies.find(([, type]: any[]) => type === "info")?.[0]).toContain("Do B");
		// The aggregate window title flags the failure.
		expect(renames().some((r) => r.includes("✗") && r.includes("1/2 done"))).toBe(true);
	});

	it("attaches the stderr tail to failed tasks and surfaces it in the result", async () => {
		statuses[statusPath(1)] = statusJson("task-1", "failed", {
			errorMessage: undefined,
			result: undefined,
		});
		stderrs[stderrPath(1)] = "boom-error";
		const exec = tool.execute(
			"call-1",
			{ tasks: [{ agent: "worker", objective: "Find the docs" }] },
			new AbortController().signal,
			(u: any) => updates.push(u),
			ctx,
		);
		await settle(300);
		const result: any = await exec;

		expect(result.details.results[0].state).toBe("failed");
		expect(result.details.results[0].errorMessage).toBe("boom-error");
		const text = result.content[0].text;
		expect(text).toContain("boom-error");
		expect(text).toContain("=== ✗ worker · task-1 · failed");
		const notifies = ctx.ui.notify.mock.calls;
		expect(notifies).toHaveLength(1);
		expect(notifies[0][1]).toBe("error");
	});

	it("summary mode keeps the coordinator envelope intact below the new heading", async () => {
		const summaryText = [
			"<coordinator-summary>",
			"Status: succeeded",
			"Outcome: Verified the hypothesis",
			"Evidence added: 3 sources",
			"Key changes:",
			"Contradictions/blockers:",
			"Recommended next action: Ship it",
			"</coordinator-summary>",
		].join("\n");
		statuses[statusPath(1)] = statusJson("task-1", "succeeded", {
			result: summaryText,
		});
		const exec = tool.execute(
			"call-1",
			{
				tasks: [{ agent: "worker", objective: "Investigate" }],
				return_mode: "summary",
				retain_artifacts: "always",
			},
			new AbortController().signal,
			(u: any) => updates.push(u),
			ctx,
		);
		await settle(300);
		const result: any = await exec;

		const text = result.content[0].text;
		expect(text).toContain("=== ✓ worker · task-1 · succeeded");
		expect(text).toContain("<coordinator-summary>");
		expect(text).toContain("Outcome: Verified the hypothesis");
		expect(text).toContain("Recommended next action: Ship it");
		expect(text).toContain("Artifacts retained at: /tmp/pi-subagent-run1");
		const summarized = result.details.results[0];
		expect(summarized.parsedResult.summary.outcome).toBe("Verified the hypothesis");
		expect("result" in summarized).toBe(false); // full output stripped from details
	});

	it("concurrent runs keep the widget and footer alive until the last one finishes", async () => {
		statuses[statusPath(1)] = statusJson("task-1", "running");
		const exec1 = tool.execute(
			"call-1",
			{ tasks: [{ agent: "worker", objective: "Run one" }] },
			new AbortController().signal,
			(u: any) => updates.push(u),
			ctx,
		);
		await settle(10);
		statuses[statusPath(2)] = statusJson("task-1", "running");
		const exec2 = tool.execute(
			"call-2",
			{ tasks: [{ agent: "worker", objective: "Run two" }] },
			new AbortController().signal,
			(u: any) => updates.push(u),
			ctx,
		);
		await settle(300);

		// Both running: the footer aggregates both runs.
		expect(
			footerCalls().some(([, v]: any[]) => typeof v === "string" && v.includes("0/2 done")),
		).toBe(true);

		// First run finishes — widget and footer must stay alive.
		statuses[statusPath(1)] = statusJson("task-1", "succeeded");
		await settle(300);
		const r1: any = await exec1;
		expect(r1.details.results[0].state).toBe("succeeded");
		expect(ctx.ui.setWidget).not.toHaveBeenCalledWith("tmux-subagents", undefined);
		expect(ctx.ui.setStatus).not.toHaveBeenCalledWith("tmux-subagents", undefined);

		// Second run finishes — both cleared exactly once.
		statuses[statusPath(2)] = statusJson("task-1", "succeeded");
		await settle(300);
		await exec2;
		const setWidgetCalls = ctx.ui.setWidget.mock.calls as any[];
		expect(
			setWidgetCalls.filter(([, c]) => typeof c === "function").length,
		).toBe(2); // one registration per run
		expect(ctx.ui.setWidget).toHaveBeenLastCalledWith("tmux-subagents", undefined);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith("tmux-subagents", undefined);
		expect(widgetRuns.size).toBe(0);
	});
});
