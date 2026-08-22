import { describe, expect, it } from "vitest";

import {
	ACTIVITY_GLYPH,
	COMPACTION_GLYPH,
	SPINNER_FRAMES,
	TOOL_GLYPH,
	TURN_GLYPH,
	formatElapsed,
	formatTokens,
	renderStatsRow,
	renderTaskRow,
	renderWidgetLines,
	renderWindowTitle,
	renderPaneTitle,
	renderSectionHeading,
	renderSummaryResults,
	statusIcon,
	truncateVisibleWidth,
} from "../extensions/tmux-subagent/render.ts";

// ---------------------------------------------------------------------------
// Glyph constants
// ---------------------------------------------------------------------------

describe("glyph constants", () => {
	it("SPINNER_FRAMES has 10 braille dot frames", () => {
		expect(SPINNER_FRAMES).toHaveLength(10);
		expect(SPINNER_FRAMES[2]).toBe("⠹");
	});

	it("TURN_GLYPH", () => {
		expect(TURN_GLYPH).toBe("↻");
	});

	it("TOOL_GLYPH", () => {
		expect(TOOL_GLYPH).toBe("⚙");
	});

	it("ACTIVITY_GLYPH", () => {
		expect(ACTIVITY_GLYPH).toBe("⎿");
	});

	it("COMPACTION_GLYPH", () => {
		expect(COMPACTION_GLYPH).toBe("⇊");
	});
});

// ---------------------------------------------------------------------------
// statusIcon
// ---------------------------------------------------------------------------

describe("statusIcon", () => {
	it("returns ✓ for succeeded", () => {
		expect(statusIcon("succeeded", 0)).toBe("✓");
	});

	it("returns ✗ for failed", () => {
		expect(statusIcon("failed", 0)).toBe("✗");
	});

	it("returns ✗ for timed_out", () => {
		expect(statusIcon("timed_out", 0)).toBe("✗");
	});

	it("returns ■ for cancelled", () => {
		expect(statusIcon("cancelled", 0)).toBe("■");
	});

	it("returns the frame-indexed spinner for starting", () => {
		for (let i = 0; i < SPINNER_FRAMES.length; i++) {
			expect(statusIcon("starting", i)).toBe(SPINNER_FRAMES[i]);
		}
		expect(statusIcon("starting", 10)).toBe(SPINNER_FRAMES[0]);
		expect(statusIcon("starting", 13)).toBe(SPINNER_FRAMES[3]);
	});

	it("returns the frame-indexed spinner for running", () => {
		for (let i = 0; i < SPINNER_FRAMES.length; i++) {
			expect(statusIcon("running", i)).toBe(SPINNER_FRAMES[i]);
		}
	});
});

// ---------------------------------------------------------------------------
// formatTokens
// ---------------------------------------------------------------------------

describe("formatTokens", () => {
	it("returns '0 tok' for 0", () => {
		expect(formatTokens(0)).toBe("0 tok");
	});

	it("returns '812 tok' for 812", () => {
		expect(formatTokens(812)).toBe("812 tok");
	});

	it("returns '12.4k tok' for 12400", () => {
		expect(formatTokens(12400)).toBe("12.4k tok");
	});

	it("returns '1.2M tok' for 1200000", () => {
		expect(formatTokens(1200000)).toBe("1.2M tok");
	});

	it("returns '1.0k tok' at 1000", () => {
		expect(formatTokens(1000)).toBe("1.0k tok");
	});

	it("returns '999 tok' just below 1k", () => {
		expect(formatTokens(999)).toBe("999 tok");
	});

	it("returns '10.0k tok' at 10000", () => {
		expect(formatTokens(10000)).toBe("10.0k tok");
	});

	it("returns '999.9k tok' just below 1M", () => {
		expect(formatTokens(999900)).toBe("999.9k tok");
	});
});

// ---------------------------------------------------------------------------
// formatElapsed
// ---------------------------------------------------------------------------

describe("formatElapsed", () => {
	it('returns "" when startedAt is missing', () => {
		expect(formatElapsed()).toBe("");
	});

	it("returns '0ms' for 0 ms", () => {
		const now = Date.now();
		expect(formatElapsed(now, now)).toBe("0ms");
	});

	it("returns '812ms' for 812 ms", () => {
		const start = Date.now();
		const end = start + 812;
		expect(formatElapsed(start, end)).toBe("812ms");
	});

	it("returns '12.3s' for 12300 ms", () => {
		const start = Date.now();
		const end = start + 12300;
		expect(formatElapsed(start, end)).toBe("12.3s");
	});

	it("returns '2m17s' for 137000 ms", () => {
		const start = Date.now();
		const end = start + 137000;
		expect(formatElapsed(start, end)).toBe("2m17s");
	});

	it("returns '2h5m' for 7500000 ms", () => {
		const start = Date.now();
		const end = start + 7500000;
		expect(formatElapsed(start, end)).toBe("2h5m");
	});

	it("returns '1m0s' for 60000 ms — switches to minutes at 60s", () => {
		const start = Date.now();
		const end = start + 60000;
		expect(formatElapsed(start, end)).toBe("1m0s");
	});

	it("returns '1h0m' for 3600000 ms — switches to hours at 3600s", () => {
		const start = Date.now();
		const end = start + 3600000;
		expect(formatElapsed(start, end)).toBe("1h0m");
	});
});

// ---------------------------------------------------------------------------
// renderStatsRow
// ---------------------------------------------------------------------------

describe("renderStatsRow", () => {
	const base = {
		taskId: "t1",
		agent: "scout",
		state: "running",
		model: "test",
		turns: 3,
		tools: 5,
		tokenCount: 12400,
		percent: 8,
		elapsed: "12.3s",
	};

	it("matches pi-subagents turn, tool-use, token, and elapsed wording", () => {
		expect(renderStatsRow({ ...base } as any)).toBe(
			"3 turns · 5 tool uses · 12.4k token (8%) · 12.3s",
		);
	});

	it("uses singular 'tool use' at 1", () => {
		expect(renderStatsRow({ ...base, tools: 1 } as any)).toBe(
			"3 turns · 1 tool use · 12.4k token (8%) · 12.3s",
		);
	});

	it("omits zero-valued tool and token segments", () => {
		expect(renderStatsRow({ ...base, tools: 0, tokenCount: 0 } as any)).toBe(
			"3 turns · 12.3s",
		);
	});

	it("omits (NN%) when percent is null", () => {
		expect(renderStatsRow({ ...base, percent: null } as any)).toBe(
			"3 turns · 5 tool uses · 12.4k token · 12.3s",
		);
	});

	it("groups compaction count with context utilization", () => {
		expect(renderStatsRow({ ...base, compactionCount: 1 } as any)).toBe(
			"3 turns · 5 tool uses · 12.4k token (8% · ⇊1) · 12.3s",
		);
	});
});

// ---------------------------------------------------------------------------
// renderTaskRow
// ---------------------------------------------------------------------------

describe("renderTaskRow", () => {
	const base = {
		taskId: "t1",
		agent: "scout",
		state: "running",
		model: "test",
		objective: "Find relevant docs",
		turns: 3,
		tools: 5,
		tokenCount: 12400,
		percent: 8,
		elapsed: "12.3s",
	};

	it("matches the pi-subagents agent/description/stats layout", () => {
		const lines = renderTaskRow({ ...base } as any, { frame: 2 });
		expect(lines[0]).toBe(
			"⠹ scout (Find relevant docs) · 3 turns · 5 tool uses · 12.4k token (8%) · 12.3s",
		);
	});

	it("moves stats to continuation lines instead of clipping them at narrow widths", () => {
		const lines = renderTaskRow({ ...base } as any, { frame: 2, width: 55 });
		expect(lines).toEqual([
			"⠹ scout (Find relevant docs)",
			"3 turns · 5 tool uses · 12.4k token (8%) · 12.3s",
		]);
	});

	it("drops objective when absent", () => {
		const lines = renderTaskRow({ ...base, objective: undefined } as any, {
			frame: 2,
		});
		expect(lines[0]).toBe(
			"⠹ scout · 3 turns · 5 tool uses · 12.4k token (8%) · 12.3s",
		);
	});

	it("shows activity line when present", () => {
		const lines = renderTaskRow(
			{ ...base, activity: "searching for docs…" } as any,
			{ frame: 2 },
		);
		expect(lines[1]).toBe("⎿ searching for docs…");
	});

	it("truncates activity at 60 chars", () => {
		const longActivity = "x".repeat(70);
		const lines = renderTaskRow({ ...base, activity: longActivity } as any, {
			frame: 2,
		});
		expect(lines[1].length).toBeLessThanOrEqual(60);
		expect(lines[1].startsWith("⎿ ")).toBe(true);
	});

	it("omits activity line when absent", () => {
		const lines = renderTaskRow({ ...base } as any, { frame: 2 });
		expect(lines).toHaveLength(1);
	});

	it("applies theme color for success", () => {
		const theme = {
			fg: (color: string, text: string) => `[${color}:${text}]`,
		};
		const lines = renderTaskRow({ ...base, state: "succeeded" } as any, {
			frame: 0,
			theme,
		});
		expect(lines[0]).toContain("[success:✓]");
	});

	it("applies dim theme for cancelled", () => {
		const theme = {
			fg: (color: string, text: string) => `[${color}:${text}]`,
		};
		const lines = renderTaskRow({ ...base, state: "cancelled" } as any, {
			frame: 0,
			theme,
		});
		expect(lines[0]).toContain("[dim:■]");
	});
});

// ---------------------------------------------------------------------------
// renderWidgetLines
// ---------------------------------------------------------------------------

describe("renderWidgetLines", () => {
	const makeRun = (
		tasks: Array<{ taskId: string; agent: string; objective: string }>,
		statuses: Record<string, { state: string; [key: string]: unknown }>,
	) =>
		({
			runId: "run-1",
			startedAt: "2025-01-01T00:00:00Z",
			tasks,
			statuses,
		}) as any;

	it("collapses multi-line objectives to their first line in the widget", () => {
		const runs = [
			makeRun(
				[
					{
						taskId: "t1",
						agent: "scout",
						objective: "Do not use tools.\n<coordinator-summary>\nStatus: succeeded",
					},
				],
				{ t1: { state: "running" } },
			),
		];
		const lines = renderWidgetLines(runs, { frame: 0, width: 80 });
		expect(lines[0]).toBe("● Agents");
		expect(lines[1]).toBe("└─ ⠋ scout (Do not use tools.)");
		expect(lines.join("\n")).not.toContain("coordinator-summary");
	});

	it("truncates long objectives to a compact one-liner", () => {
		const longObjective = "a".repeat(100);
		const lines = renderWidgetLines(
			[
				makeRun([{ taskId: "t1", agent: "scout", objective: longObjective }], {
					t1: { state: "running" },
				}),
			],
			{ frame: 0, width: 200 },
		);
		expect(lines[1]).toBe(`└─ ⠋ scout (${"a".repeat(63)}…)`);
	});

	it("caps at 12 lines and reports hidden agents", () => {
		const tasks = Array.from({ length: 20 }, (_, i) => ({
			taskId: `t${i}`,
			agent: "scout",
			objective: "do something",
		}));
		const statuses: Record<string, { state: string }> = {};
		for (const task of tasks) statuses[task.taskId] = { state: "running" };
		const lines = renderWidgetLines([makeRun(tasks, statuses)], {
			frame: 0,
			width: 80,
		});
		expect(lines.length).toBeLessThanOrEqual(12);
		expect(lines[0]).toBe("● Agents");
		expect(lines.at(-1)).toMatch(/^└─ \+\d+ more$/);
	});

	it("flattens concurrent runs into one agent tree", () => {
		const runs = [
			makeRun([{ taskId: "t1", agent: "worker", objective: "a" }], {
				t1: { state: "running" },
			}),
			makeRun([{ taskId: "t2", agent: "scout", objective: "b" }], {
				t2: { state: "succeeded" },
			}),
		];
		const text = renderWidgetLines(runs, { frame: 0, width: 80 }).join("\n");
		expect(text).toContain("├─ ⠋ worker (a)");
		expect(text).toContain("└─ ✓ scout (b)");
		expect(text).not.toContain("Run 2");
	});

	it("applies reference theme colors", () => {
		const theme = {
			fg: (color: string, text: string) => `[${color}:${text}]`,
			bold: (text: string) => `[bold:${text}]`,
		};
		const lines = renderWidgetLines(
			[
				makeRun([{ taskId: "t1", agent: "scout", objective: "Find docs" }], {
					t1: { state: "running" },
				}),
			],
			{ frame: 0, theme, width: 120 },
		);
		expect(lines[0]).toBe("[accent:● Agents]");
		expect(lines[1]).toContain("[accent:⠋]");
		expect(lines[1]).toContain("[bold:scout]");
		expect(lines[1]).toContain("[muted:Find docs]");
	});

	it("wraps live-widget stats onto a continuation line at narrow widths", () => {
		const runs = [
			makeRun([{ taskId: "t1", agent: "scout", objective: "Find docs" }], {
				t1: {
					state: "running",
					usage: { turns: 3, totalTokens: 12400 },
					toolUses: 5,
					contextUsage: { percent: 8 },
				},
			}),
		];
		const lines = renderWidgetLines(runs, { frame: 0, width: 45 });
		expect(lines).toContain("└─ ⠋ scout (Find docs)");
		expect(lines).toContain("   3 turns · 5 tool uses · 12.4k token (8%)");
	});

	it("ANSI-truncates at narrow width", () => {
		const runs = [
			makeRun(
				[
					{
						taskId: "t1",
						agent: "scout",
						objective:
							"Find relevant documentation for the project architecture and deployment pipeline",
					},
				],
				{ t1: { state: "running" } },
			),
		];
		const lines = renderWidgetLines(runs, { frame: 0, width: 40 });
		for (const line of lines) {
			const visible = line.replace(/\x1b\[[0-9;]*m/g, "").length;
			expect(visible).toBeLessThanOrEqual(40);
		}
	});
});

// ---------------------------------------------------------------------------
// renderWindowTitle
// ---------------------------------------------------------------------------

describe("renderWindowTitle", () => {
	const makeRun = () =>
		({
			runId: "run-1",
			startedAt: "2025-01-01T00:00:00Z",
			tasks: [
				{ taskId: "t1", agent: "worker", objective: "a" },
				{ taskId: "t2", agent: "scout", objective: "b" },
			],
			statuses: { t1: { state: "starting" }, t2: { state: "starting" } },
		}) as any;

	it("shows spinner + agents + done/total when running", () => {
		const runs = [makeRun()];
		const line = renderWindowTitle(runs, { frame: 0 });
		expect(line).toContain("worker+scout");
		expect(line).toContain("0/2");
	});

	it("shows ✓ when all succeeded", () => {
		const runs = [
			{
				...makeRun(),
				statuses: {
					t1: { state: "succeeded" },
					t2: { state: "succeeded" },
				},
			},
		];
		const line = renderWindowTitle(runs, { frame: 0 });
		expect(line.startsWith("✓")).toBe(true);
		expect(line).toContain("2/2");
	});

	it("shows ✗ when any failed", () => {
		const runs = [
			{
				...makeRun(),
				statuses: {
					t1: { state: "failed" },
					t2: { state: "succeeded" },
				},
			},
		];
		const line = renderWindowTitle(runs, { frame: 0 });
		expect(line.startsWith("✗")).toBe(true);
	});

	it("shows ■ when cancelled but no failures", () => {
		const runs = [
			{
				...makeRun(),
				statuses: {
					t1: { state: "cancelled" },
					t2: { state: "cancelled" },
				},
			},
		];
		const line = renderWindowTitle(runs, { frame: 0 });
		expect(line.startsWith("■")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// renderPaneTitle
// ---------------------------------------------------------------------------

describe("renderPaneTitle", () => {
	const base = {
		taskId: "t1",
		agent: "worker",
		state: "running",
		model: "test",
		turns: 3,
		tools: 5,
		tokenCount: 12400,
		percent: 8,
		elapsed: "12.3s",
	};

	it("shows icon + agent + turns + tools", () => {
		const line = renderPaneTitle({ ...base } as any, { frame: 2 });
		expect(line).toBe("⠹ worker · 3 turns · ⚙ 5 tools");
	});

	it("omits tools segment at 0", () => {
		const line = renderPaneTitle({ ...base, tools: 0 } as any, {
			frame: 2,
		});
		expect(line).toBe("⠹ worker · 3 turns");
	});
});

// ---------------------------------------------------------------------------
// renderSectionHeading
// ---------------------------------------------------------------------------

describe("renderSectionHeading", () => {
	it("shows icon + agent + taskId + state + turns + tokens", () => {
		const line = renderSectionHeading({
			taskId: "task-1",
			agent: "worker",
			state: "succeeded",
			model: "gpt-4o",
			usage: { totalTokens: 12400, turns: 3 } as any,
		} as any);
		expect(line).toBe(
			"=== ✓ worker · task-1 · succeeded — 3 turns · 12.4k token ===",
		);
	});

	it("omits segments when usage absent", () => {
		const line = renderSectionHeading({
			taskId: "task-1",
			agent: "worker",
			state: "succeeded",
			model: "gpt-4o",
		} as any);
		expect(line).toBe("=== ✓ worker · task-1 · succeeded ===");
	});
});

// ---------------------------------------------------------------------------
// truncateVisibleWidth
// ---------------------------------------------------------------------------

describe("truncateVisibleWidth", () => {
	it("truncates at max visible width", () => {
		const text = "Hello, World!";
		expect(truncateVisibleWidth(text, 5)).toBe("Hello");
	});

	it("preserves ANSI escapes when within limit", () => {
		const text = "\x1b[31mred\x1b[0m text";
		expect(truncateVisibleWidth(text, 20)).toBe(text);
	});

	it("truncates mid-text but keeps trailing ANSI open", () => {
		const text = "\x1b[31mhello";
		const result = truncateVisibleWidth(text, 3);
		// \x1b[31m is a complete escape (m terminates), then h(1)e(2)l(3) = 3 visible
		expect(result).toBe("\x1b[31mhel");
	});
});

// ---------------------------------------------------------------------------
// renderSummaryResults — envelope intact
// ---------------------------------------------------------------------------

describe("renderSummaryResults envelope", () => {
	const makeStatus = (overrides: Record<string, unknown> = {}) =>
		({
			taskId: "task-1",
			agent: "scout_research",
			state: "succeeded",
			model: "test-model",
			...overrides,
		}) as any;

	it("envelope text stays byte-identical", () => {
		const status = makeStatus({
			parsedResult: {
				summary: {
					status: "succeeded",
					outcome: "Test completed",
					evidenceAdded: "2 sources",
					keyChanges: ["Changed config"],
					contradictions: [],
					recommendedNextAction: "Proceed",
				},
			},
		});
		const result = renderSummaryResults([status], null);
		expect(result).toContain("<coordinator-summary>");
		expect(result).toContain("Status: succeeded");
		expect(result).toContain("Outcome: Test completed");
		expect(result).toContain("Recommended next action: Proceed");
		expect(result).toContain("</coordinator-summary>");
	});

	it("failed state shows errorMessage", () => {
		const status = makeStatus({
			state: "failed",
			errorMessage: "Connection timeout",
		});
		const result = renderSummaryResults([status], null);
		expect(result).toContain("Connection timeout");
	});
});
