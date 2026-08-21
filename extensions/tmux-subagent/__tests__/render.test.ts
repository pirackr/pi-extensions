import { describe, it, expect } from "vitest";
import {
	renderTaskRow,
	renderPaneTitle,
	renderSectionHeading,
	type WidgetTask,
	type WidgetTheme,
} from "../render.ts";

function makeTask(overrides: Partial<WidgetTask> = {}): WidgetTask {
	return {
		taskId: "task-1",
		agent: "worker",
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

/** Theme stub that wraps text in visible markers so assertions stay exact. */
const theme: WidgetTheme = {
	fg: (color, text) => `<${color}>${text}</${color}>`,
	bold: (text) => `**${text}**`,
};

describe("renderTaskRow starting vs running", () => {
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
});

describe("renderPaneTitle starting vs running", () => {
	it("includes (starting) for starting tasks", () => {
		const title = renderPaneTitle(makeTask({ state: "starting" }), {
			frame: 0,
		});
		expect(title).toContain("(starting)");
	});

	it("omits (starting) for running tasks", () => {
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
