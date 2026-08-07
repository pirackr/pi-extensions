import { describe, it, expect } from "vitest";
import { renderSummaryResults } from "../extensions/tmux-subagent/render.ts";
import type { RenderStatus } from "../extensions/tmux-subagent/render.ts";

// Summary mode exists so the /research coordinator never carries full
// subagent payloads in context: digests + artifact paths in, full outputs
// stay on disk. These tests pin the digest shape.

function status(partial: Partial<RenderStatus>): RenderStatus {
	return {
		taskId: "task-1",
		agent: "scout_research",
		state: "succeeded",
		model: "test-model",
		...partial,
	};
}

const LONG_RESULT = "x".repeat(10_000);

describe("renderSummaryResults", () => {
	it("returns a digest, not the full result, and points at the on-disk output", () => {
		const text = renderSummaryResults(
			[status({ result: LONG_RESULT })],
			"/tmp/pi-subagent-abc",
		);
		expect(text).toContain("scout_research / task-1 (succeeded)");
		expect(text).toContain("9400 more chars");
		expect(text).toContain(
			"Full output: /tmp/pi-subagent-abc/output/task-1.jsonl",
		);
		expect(text).toContain("Artifacts retained at: /tmp/pi-subagent-abc");
		expect(text).not.toContain(LONG_RESULT);
	});

	it("keeps short results in full", () => {
		const text = renderSummaryResults(
			[status({ result: "found 3 credible sources" })],
			"/tmp/pi-subagent-abc",
		);
		expect(text).toContain("found 3 credible sources");
		expect(text).not.toContain("more chars");
	});

	it("never echoes the prompt — only outputs", () => {
		const text = renderSummaryResults(
			[status({ result: "findings" })],
			"/tmp/pi-subagent-abc",
		);
		expect(text).not.toContain("Prompt sent:");
		expect(text).not.toContain("# System");
	});

	it("shows errorMessage for failed tasks instead of a bare result", () => {
		const text = renderSummaryResults(
			[status({ state: "failed", errorMessage: "timeout after 300s" })],
			null,
		);
		expect(text).toContain("timeout after 300s");
		expect(text).not.toContain("Full output:");
		expect(text).not.toContain("Artifacts retained at");
	});

	it("handles a missing result gracefully", () => {
		const text = renderSummaryResults(
			[status({ result: undefined })],
			"/tmp/pi-subagent-abc",
		);
		expect(text).toContain("(no output)");
		// no result on disk → no path line
		expect(text).not.toContain("Full output:");
	});
});
