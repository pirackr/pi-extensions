import { describe, it, expect } from "vitest";
import {
	renderTaskRow,
	renderPaneTitle,
	renderSectionHeading,
	formatCost,
	costTotalOf,
	agentColorKey,
	agentColorIndex,
	agentAnsiColor,
	AGENT_COLOR_KEYS,
	type WidgetTask,
	type WidgetTheme,
} from "../render.ts";

/** Theme stub that wraps text in visible markers so assertions stay exact. */
const theme: WidgetTheme = {
	fg: (color, text) => `<${color}>${text}</${color}>`,
	bold: (text) => `**${text}**`,
};

function makeTask(overrides: Partial<WidgetTask> = {}): WidgetTask {
	return {
		taskId: "task-1",
		agent: "worker",
		agentColor: agentColorKey("worker"),
		state: "running",
		model: "",
		turns: 3,
		tools: 5,
		tokenCount: 12_400,
		percent: null,
		elapsed: "4.1s",
		...overrides,
	};
}

describe("formatCost (#1)", () => {
	it("returns empty for missing/zero/negative/NaN — never $0.00", () => {
		for (const value of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(formatCost(value)).toBe("");
		}
	});

	it("floors sub-$0.0001 runs", () => {
		expect(formatCost(0.00005)).toBe("<$0.0001");
	});

	it("keeps cents minimum, four decimals maximum", () => {
		expect(formatCost(0.0042)).toBe("~$0.0042");
		expect(formatCost(0.05)).toBe("~$0.05");
		expect(formatCost(1.24)).toBe("~$1.24");
		expect(formatCost(1.2)).toBe("~$1.20");
		expect(formatCost(1234.5)).toBe("~$1234.50");
	});

	it("normalizes scalar and object cost shapes", () => {
		expect(costTotalOf(0.5)).toBe(0.5);
		expect(costTotalOf({ total: 0.25 })).toBe(0.25);
		expect(costTotalOf(undefined)).toBe(0);
		expect(costTotalOf({ total: Number.NaN })).toBe(0);
	});
});

describe("renderTaskRow outcome line", () => {
	it("succeeded rows keep their result visible under the agent row", () => {
		const lines = renderTaskRow(
			makeTask({ state: "succeeded", result: "Report written to report.md" }),
			{ frame: 0 },
		);
		expect(lines.some((l) => l.includes("⎿ Report written to report.md"))).toBe(
			true,
		);
	});

	it("failed rows keep their error message visible", () => {
		const lines = renderTaskRow(
			makeTask({ state: "failed", errorMessage: "Connection timeout" }),
			{ frame: 0 },
		);
		expect(lines.some((l) => l.includes("⎿ Connection timeout"))).toBe(true);
	});

	it("active rows prefer live activity over stale results", () => {
		const lines = renderTaskRow(
			makeTask({
				state: "running",
				activity: "Reading files",
				result: "stale",
			}),
			{ frame: 0 },
		);
		expect(lines.some((l) => l.includes("⎿ Reading files"))).toBe(true);
		expect(lines.some((l) => l.includes("stale"))).toBe(false);
	});

	it("terminal rows without an outcome render no message line", () => {
		const lines = renderTaskRow(makeTask({ state: "succeeded" }), { frame: 0 });
		expect(lines.every((l) => !l.startsWith("⎿ "))).toBe(true);
	});
});

describe("per-agent identity colors (#6)", () => {
	it("maps names to palette keys deterministically", () => {
		for (const name of ["worker", "reviewer", "tester", "scout", "fetcher"]) {
			const key = agentColorKey(name);
			expect(AGENT_COLOR_KEYS).toContain(key);
			expect(agentColorKey(name)).toBe(key);
		}
	});

	it("ansi and theme-key palettes stay index-aligned", () => {
		const idx = agentColorIndex("reviewer");
		expect(agentColorKey("reviewer")).toBe(AGENT_COLOR_KEYS[idx]);
		expect(agentAnsiColor("reviewer")).toEqual(agentAnsiColor("reviewer"));
	});

	it("colors the agent name in themed rows, not plain ones", () => {
		const task = makeTask({ agentColor: "warning" });
		const styled = renderTaskRow(task, { frame: 0, theme });
		expect(styled[0]).toContain(theme.fg("warning", `**${task.agent}**`));
		const plain = renderTaskRow(task, { frame: 0 });
		expect(plain.join("\n")).not.toContain("<warning>");
	});
});

describe("deadline visibility (#2)", () => {
	it("shows elapsed/budget when a timeout is configured", () => {
		const lines = renderTaskRow(
			makeTask({ elapsed: "90.0s", elapsedMs: 90_000, timeoutSeconds: 100 }),
			{ frame: 0 },
		);
		expect(lines.join("\n")).toContain("⏱ 90.0s/100s");
	});

	it("warns past 80% and errors past 95% of budget", () => {
		const warn = renderTaskRow(
			makeTask({ elapsed: "85.0s", elapsedMs: 85_000, timeoutSeconds: 100 }),
			{ frame: 0, theme },
		);
		expect(warn.join("\n")).toContain(theme.fg("warning", "⏱ 85.0s/100s"));
		const error = renderTaskRow(
			makeTask({ elapsed: "96.0s", elapsedMs: 96_000, timeoutSeconds: 100 }),
			{ frame: 0, theme },
		);
		expect(error.join("\n")).toContain(theme.fg("error", "⏱ 96.0s/100s"));
	});

	it("shows plain elapsed without a budget", () => {
		const lines = renderTaskRow(makeTask(), { frame: 0 });
		expect(lines.join("\n")).toContain("4.1s");
		expect(lines.join("\n")).not.toContain("⏱");
	});
});

describe("cost in rendered surfaces (#1)", () => {
	it("stats rows include the cost estimate when present", () => {
		const row = renderTaskRow(makeTask({ cost: 0.02 }), { frame: 0 });
		expect(row.join("\n")).toContain("~$0.02");
	});

	it("stats rows omit cost entirely without pricing data", () => {
		const row = renderTaskRow(makeTask({ cost: undefined }), { frame: 0 });
		expect(row.join("\n")).not.toContain("$");
	});

	it("section headings append the estimate", () => {
		const heading = renderSectionHeading({
			state: "succeeded",
			agent: "reviewer",
			taskId: "task-2",
			model: "",
			usage: {
				turns: 3,
				totalTokens: 5000,
				cost: {
					input: 3000,
					output: 2000,
					cacheRead: 0,
					cacheWrite: 0,
					total: 0.0042,
				},
			},
		});
		expect(heading).toContain("· ~$0.0042 ===");
	});
});

describe("starting vs running (#9)", () => {
	it("labels starting tasks with plain-text (starting)", () => {
		const lines = renderTaskRow(makeTask({ state: "starting" }), { frame: 0 });
		expect(lines[0]).toContain("(starting)");
	});

	it("does not label running tasks", () => {
		const lines = renderTaskRow(makeTask({ state: "running" }), { frame: 0 });
		expect(lines.join("\n")).not.toContain("(starting)");
	});

	it("styles the starting label dim under a theme", () => {
		const lines = renderTaskRow(makeTask({ state: "starting" }), {
			frame: 0,
			theme,
		});
		expect(lines[0]).toContain(theme.fg("dim", "(starting)"));
	});

	it("keeps terminal states unlabeled", () => {
		for (const state of ["succeeded", "failed", "timed_out", "cancelled"]) {
			const lines = renderTaskRow(makeTask({ state }), { frame: 0 });
			expect(lines.join("\n")).not.toContain("(starting)");
		}
	});

	it("includes (starting) in pane titles for starting tasks", () => {
		const title = renderPaneTitle(makeTask({ state: "starting" }), {
			frame: 0,
		});
		expect(title).toContain("(starting)");
	});

	it("omits (starting) from pane titles for running tasks", () => {
		const title = renderPaneTitle(makeTask({ state: "running" }), {
			frame: 0,
		});
		expect(title).not.toContain("(starting)");
	});
});

describe("renderSectionHeading theming (#11)", () => {
	const status = {
		state: "failed",
		agent: "reviewer",
		taskId: "task-2",
		model: "",
	};

	it("stays plain text without a theme", () => {
		expect(renderSectionHeading(status)).toBe(
			"=== ✗ reviewer · task-2 · failed ===",
		);
	});

	it("colors icon and state word under a theme", () => {
		const heading = renderSectionHeading(status, { theme });
		expect(heading).toContain(theme.fg("error", "✗"));
		expect(heading).toContain(theme.fg("error", "failed"));
		expect(heading).toBe(
			`=== ${theme.fg("error", "✗")} reviewer · task-2 · ${theme.fg("error", "failed")} ===`,
		);
	});

	it("uses success color for succeeded tasks", () => {
		const heading = renderSectionHeading(
			{ ...status, state: "succeeded" },
			{ theme },
		);
		expect(heading).toContain(theme.fg("success", "✓"));
	});
});
