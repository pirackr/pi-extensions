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
import { cancelPanes, launchBatch } from "../tmux.ts";

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
				cost: {
					input: 0.0005,
					output: 0.001,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0.0015,
				},
				turns: 1,
			},
			tools: ["read", "edit"],
			toolUses: 5,
			activity: "Working on it",
			contextUsage: { tokens: 10000, contextWindow: 128000, percent: 8 },
			compactionCount: 0,
		};
		if (state === "succeeded") base.result = "All done";
		if (state === "failed") base.errorMessage = "boom";
		return JSON.stringify({ ...base, ...extra });
	}

	function tmuxArgs(): string[][] {
		return vi
			.mocked(execFile)
			.mock.calls.filter(([cmd]) => cmd === "tmux")
			.map(([, args]) => args as string[]);
	}

	const renames = () =>
		tmuxArgs()
			.filter((a) => a[0] === "rename-window")
			.map((a) => a[3]);
	const panePushes = () =>
		tmuxArgs()
			.filter((a) => a[0] === "select-pane")
			.map((a) => a[2]);
	const footerCalls = () =>
		ctx.ui.setStatus.mock.calls.filter(
			([key]: any[]) => key === "tmux-subagents",
		);

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

		vi
			.mocked(launchBatch)
			.mockReset()
			.mockResolvedValue({
				session: "pi-subagents",
				window: {
					id: "@3",
					name: "tmp-observability",
					sessionId: "sess-1",
					pid: "1",
					cwd: "/tmp",
				},
				paneIds: ["%5"],
			} as any);
		vi
			.mocked(cancelPanes)
			.mockReset()
			.mockResolvedValue(undefined as any);

		vi
			.mocked(execFile)
			.mockImplementation((_cmd: any, args: any, _opts: any, cb: any) => {
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
			});
		vi.mocked(fs.promises.access).mockResolvedValue(undefined as any);
		vi
			.mocked(fs.promises.stat)
			.mockResolvedValue({ isDirectory: () => true } as any);
		vi
			.mocked(fs.promises.realpath)
			.mockImplementation(async (p: any) => String(p));
		vi
			.mocked(fs.promises.mkdtemp)
			.mockImplementation(async () => `/tmp/pi-subagent-run${++runDirCounter}`);
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

		// The widget renders agent state and stats without leaking the task prompt.
		const theme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		};
		const component = setWidgetCalls[0][1]({ requestRender: () => {} }, theme);
		const lines = component.render(100).join("\n");
		expect(lines).toContain("● Agents");
		expect(lines).toContain("worker");
		expect(lines).not.toContain("Find the docs");
		expect(lines).toContain("5 tool uses");
		expect(lines).toContain("12.4k token (8%)");

		// The tool itself uses the same Claude-style call and live-result renderer.
		const callText = tool
			.renderCall(
				{ tasks: [{ agent: "worker", objective: "Find the docs" }] },
				theme,
				{},
			)
			.render(100)
			.join("\n");
		expect(callText).toBe("▸ worker");
		const batchCallText = tool
			.renderCall(
				{
					tasks: [
						{ agent: "worker", objective: "Find the docs" },
						{ agent: "scout", objective: "Verify the tests" },
					],
				},
				theme,
				{},
			)
			.render(100)
			.join("\n");
		expect(batchCallText).toBe(
			"▸ worker\n\n▸ scout",
		);
		const liveText = tool
			.renderResult(
				updates.at(-1) as any,
				{ expanded: false, isPartial: true },
				theme,
				{},
			)
			.render(100)
			.join("\n");
		expect(liveText).toBe("⎿ Running as pi-subagent-run1…");
		expect(liveText).not.toContain("worker");
		expect(liveText).not.toContain("Find the docs");

		// Keep the run live for >1s so the animation interval fires several times.
		await settle(1_300);
		statuses[statusPath(1)] = statusJson("task-1", "succeeded");
		await settle(300);
		const result: any = await exec;
		expect(result.details.results[0].state).toBe("succeeded");
		const completedText = tool
			.renderResult(result, { expanded: false, isPartial: false }, theme, {})
			.render(100)
			.join("\n");
		expect(completedText).toBe("⎿ Done");
		expect(completedText).not.toContain("worker");
		expect(completedText).not.toContain("Find the docs");

		// Footer was written with the aggregated title ...
		const footers = footerCalls();
		expect(footers.length).toBeGreaterThan(0);
		expect(
			footers.some(
				([, v]: any[]) => typeof v === "string" && v.includes("worker"),
			),
		).toBe(true);
		expect(
			footers.some(
				([, v]: any[]) => typeof v === "string" && v.includes("1/1 done"),
			),
		).toBe(true);
		// ... and was never blanked by the animation interval.
		for (const [, value] of footers.slice(0, -1)) {
			expect(typeof value).toBe("string");
			expect((value as string).length).toBeGreaterThan(0);
		}
		// ... then cleared exactly once together with the widget.
		expect(ctx.ui.setWidget).toHaveBeenLastCalledWith(
			"tmux-subagents",
			undefined,
		);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
			"tmux-subagents",
			undefined,
		);
		expect(widgetRuns.size).toBe(0);

		// Inline progress rows reached the UI with the attach block + objective.
		const lastText = updates[updates.length - 1].content[0].text;
		expect(lastText).toContain("Tmux session: pi-subagents");
		expect(lastText).toContain("Attach: tmux attach -t pi-subagents:@3");
		expect(lastText).toContain("worker (Find the docs)");
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
			"set-window-option",
			"-t",
			"@3",
			"pane-border-status",
			"top",
		]);
		expect(tmuxArgs()).toContainEqual([
			"set-window-option",
			"-t",
			"@3",
			"pane-border-format",
			"#{pane_title}",
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
			expect(push).toContain("⚙ 5 tools");
		}
	});

	it("emits exactly one notification per terminal task with the right type", async () => {
		// One task per call: two concurrent single-task runs. Toasts are held
		// until the LAST run finishes, then flushed as ONE combined message
		// (pi's TUI would otherwise coalesce/overwrite back-to-back toasts).
		statuses[statusPath(1, "task-1")] = statusJson("task-1", "running");
		statuses[statusPath(2, "task-1")] = statusJson("task-1", "running");
		const exec1 = tool.execute(
			"call-1",
			{ tasks: [{ agent: "worker", objective: "Do A" }] },
			new AbortController().signal,
			(u: any) => updates.push(u),
			ctx,
		);
		await settle(10);
		const exec2 = tool.execute(
			"call-2",
			{ tasks: [{ agent: "worker", objective: "Do B" }] },
			new AbortController().signal,
			(u: any) => updates.push(u),
			ctx,
		);
		// Let both runs register their widget entries before either finishes,
		// otherwise the first run's cleanup would see an empty registry and
		// flush early.
		await settle(20);
		statuses[statusPath(1, "task-1")] = statusJson("task-1", "failed");
		statuses[statusPath(2, "task-1")] = statusJson("task-1", "succeeded");
		await settle(300);
		await exec1;
		await exec2;

		const notifies = ctx.ui.notify.mock.calls;
		// Combined into a single toast by the notify debounce queue.
		expect(notifies).toHaveLength(1);
		const [combinedText, combinedType] = notifies[0];
		expect(combinedType).toBe("error"); // batch contains a failure
		expect(combinedText).toContain("✗");
		expect(combinedText).toContain("✓");
		expect(combinedText).toContain("Do A");
		expect(combinedText).toContain("Do B");
		expect(combinedText).toContain("boom");
		// The aggregate window title flags the failure.
		expect(renames().some((r) => r.includes("✗"))).toBe(true);
	});

	it("rejects multi-task batches and instructs separate calls", async () => {
		await expect(
			tool.execute(
				"call-1",
				{
					tasks: [
						{ agent: "worker", objective: "Do A" },
						{ agent: "worker", objective: "Do B" },
					],
				},
				new AbortController().signal,
				(u: any) => updates.push(u),
				ctx,
			),
		).rejects.toThrow(/exactly ONE task per call/);
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
		expect(summarized.parsedResult.summary.outcome).toBe(
			"Verified the hypothesis",
		);
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
			footerCalls().some(
				([, v]: any[]) => typeof v === "string" && v.includes("0/2 done"),
			),
		).toBe(true);

		// First run finishes — widget and footer must stay alive.
		statuses[statusPath(1)] = statusJson("task-1", "succeeded");
		await settle(300);
		const r1: any = await exec1;
		expect(r1.details.results[0].state).toBe("succeeded");
		expect(ctx.ui.setWidget).not.toHaveBeenCalledWith(
			"tmux-subagents",
			undefined,
		);
		expect(ctx.ui.setStatus).not.toHaveBeenCalledWith(
			"tmux-subagents",
			undefined,
		);

		// Second run finishes — both cleared exactly once.
		statuses[statusPath(2)] = statusJson("task-1", "succeeded");
		await settle(300);
		await exec2;
		const setWidgetCalls = ctx.ui.setWidget.mock.calls as any[];
		expect(setWidgetCalls.filter(([, c]) => typeof c === "function").length).toBe(
			2,
		); // one registration per run
		expect(ctx.ui.setWidget).toHaveBeenLastCalledWith(
			"tmux-subagents",
			undefined,
		);
		expect(ctx.ui.setStatus).toHaveBeenLastCalledWith(
			"tmux-subagents",
			undefined,
		);
		expect(widgetRuns.size).toBe(0);
	});
});
