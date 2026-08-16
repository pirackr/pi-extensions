import { describe, expect, it } from "vitest";

import {
	parseCoordinatorResult,
	renderSummaryResults,
	type CoordinatorSummary,
	type RenderStatus,
} from "../extensions/tmux-subagent/render.ts";

// ---------------------------------------------------------------------------
// parseCoordinatorResult — basic parsing
// ---------------------------------------------------------------------------

describe("parseCoordinatorResult", () => {
	it("extracts all required fields from a well-formed envelope", () => {
		const fullText = [
			"Before text",
			"<coordinator-summary>",
			"Status: succeeded",
			"Outcome: Found the docs",
			"Evidence added: 2 sources",
			"Key changes: Updated config",
			"Fixed bug",
			"Contradictions/blockers: none",
			"Recommended next action: Merge PR",
			"</coordinator-summary>",
			"After text",
		].join("\n");
		const parsed = parseCoordinatorResult(fullText);
		expect(parsed.summary.status).toBe("succeeded");
		expect(parsed.summary.outcome).toBe("Found the docs");
		expect(parsed.summary.evidenceAdded).toBe("2 sources");
		expect(parsed.summary.keyChanges).toEqual([
			"Updated config",
			"Fixed bug",
		]);
		expect(parsed.summary.contradictions).toEqual(["none"]);
		expect(parsed.summary.recommendedNextAction).toBe("Merge PR");
	});

	it("throws when <coordinator-summary> is missing", () => {
		expect(() => parseCoordinatorResult("no summary here")).toThrow(
			"Missing <coordinator-summary> block",
		);
	});

	it("throws when Status is missing", () => {
		expect(
			() =>
				parseCoordinatorResult(
					"<coordinator-summary>\nOutcome: x\n</coordinator-summary>",
				),
		).toThrow("missing Status field");
	});

	it("throws when Status value is invalid", () => {
		expect(
			() =>
				parseCoordinatorResult(
					"<coordinator-summary>\nStatus: running\n</coordinator-summary>",
				),
		).toThrow("invalid Status value");
	});

	it("throws when Outcome is missing", () => {
		expect(
			() =>
				parseCoordinatorResult(
					"<coordinator-summary>\nStatus: succeeded\n</coordinator-summary>",
				),
		).toThrow("missing Outcome field");
	});

	it("throws when Recommended next action is missing", () => {
		expect(
			() =>
				parseCoordinatorResult(
					"<coordinator-summary>\nStatus: succeeded\nOutcome: done\nEvidence added: 1\nKey changes: x\nContradictions/blockers: none\nRecommended next action: \n</coordinator-summary>",
				),
		).toThrow("missing Recommended next action field");
	});

	it("extracts optional artifact block", () => {
		const fullText = [
			"<coordinator-summary>",
			"Status: succeeded",
			"Outcome: done",
			"Evidence added: 1",
			"Key changes: x",
			"Contradictions/blockers: none",
			"Recommended next action: next",
			"</coordinator-summary>",
			"<artifact>",
			"artifact content",
			"</artifact>",
		].join("\n");
		const parsed = parseCoordinatorResult(fullText);
		expect(parsed.artifact).toBe("artifact content");
	});

	it("artifact is undefined when block is absent", () => {
		const fullText = [
			"<coordinator-summary>",
			"Status: succeeded",
			"Outcome: done",
			"Evidence added: 1",
			"Key changes: x",
			"Contradictions/blockers: none",
			"Recommended next action: next",
			"</coordinator-summary>",
		].join("\n");
		const parsed = parseCoordinatorResult(fullText);
		expect(parsed.artifact).toBeUndefined();
	});

	it("throws when requireArtifact and no artifact block", () => {
		const fullText = [
			"<coordinator-summary>",
			"Status: succeeded",
			"Outcome: done",
			"Evidence added: 1",
			"Key changes: x",
			"Contradictions/blockers: none",
			"Recommended next action: next",
			"</coordinator-summary>",
		].join("\n");
		expect(() =>
			parseCoordinatorResult(fullText, { requireArtifact: true }),
		).toThrow("Missing <artifact> block");
	});
});

// ---------------------------------------------------------------------------
// renderSummaryResults
// ---------------------------------------------------------------------------

function status(
	partial: Partial<RenderStatus> & {
		parsedResult?: RenderStatus["parsedResult"];
		result_path?: string;
		usage?: RenderStatus["usage"];
	},
): RenderStatus {
	return {
		taskId: "task-1",
		agent: "scout_research",
		state: "succeeded",
		model: "test-model",
		...partial,
	};
}

function makeSummary(
	overrides: Partial<CoordinatorSummary> = {},
): CoordinatorSummary {
	return {
		status: "succeeded",
		outcome: "done",
		evidenceAdded: "3",
		keyChanges: ["a", "b"],
		contradictions: [],
		recommendedNextAction: "next",
		...overrides,
	};
}

describe("renderSummaryResults", () => {
	it("renders the complete coordinator-summary envelope for succeeded tasks", () => {
		const text = renderSummaryResults(
			[status({ parsedResult: { summary: makeSummary() } })],
			"/tmp/pi-subagent-abc",
		);
		expect(text).toContain("scout_research · task-1 · succeeded");
		expect(text).toContain("<coordinator-summary>");
		expect(text).toContain("Status: succeeded");
		expect(text).toContain("Outcome: done");
		expect(text).toContain("Evidence added: 3");
		expect(text).toContain("Key changes: a; b");
		expect(text).toContain("Contradictions/blockers: none");
		expect(text).toContain("Recommended next action: next");
		expect(text).toContain("</coordinator-summary>");
	});

	it("includes result_path when supplied and excludes artifact body", () => {
		const text = renderSummaryResults(
			[
				status({
					parsedResult: {
						summary: makeSummary(),
						artifact: "DONT SHOW THIS",
					},
					result_path: "/data/report.org",
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
				}),
			],
			"/tmp/pi-subagent-abc",
		);
		expect(text).toContain("Result: /data/report.org");
		expect(text).toContain(
			"On-disk transcript: /tmp/pi-subagent-abc/output/task-1.jsonl",
		);
		expect(text).toContain("Tokens: 165");
		expect(text).toContain("Cost: $0.0033");
		expect(text).toContain("Turns: 3");
		expect(text).not.toContain("DONT SHOW THIS");
	});

	it("shows errorMessage for failed tasks instead of an envelope", () => {
		const text = renderSummaryResults(
			[
				status({
					state: "failed",
					errorMessage: "timeout after 300s",
				}),
			],
			null,
		);
		expect(text).toContain("timeout after 300s");
		expect(text).not.toContain("<coordinator-summary>");
	});

	it("shows (no coordinator-summary) for succeeded without parsed result", () => {
		const text = renderSummaryResults(
			[status({})],
			"/tmp/pi-subagent-abc",
		);
		expect(text).toContain("(no coordinator-summary)");
	});

	it("includes artifacts retained line when path provided", () => {
		const text = renderSummaryResults(
			[status({ parsedResult: { summary: makeSummary() } })],
			"/tmp/pi-subagent-abc",
		);
		expect(text).toContain("Artifacts retained at: /tmp/pi-subagent-abc");
	});

	it("omits artifacts retained line when path is null", () => {
		const text = renderSummaryResults(
			[status({ parsedResult: { summary: makeSummary() } })],
			null,
		);
		expect(text).not.toContain("Artifacts retained at:");
	});

	it("renders multiple tasks with different states", () => {
		const text = renderSummaryResults(
			[
				status({
					taskId: "task-1",
					agent: "scout",
					state: "succeeded",
					parsedResult: { summary: makeSummary({ status: "succeeded" }) },
				}),
				status({
					taskId: "task-2",
					agent: "fetcher",
					state: "failed",
					errorMessage: "network error",
				}),
				status({
					taskId: "task-3",
					agent: "synth",
					state: "succeeded",
					parsedResult: {
						summary: makeSummary({
							status: "partial",
							outcome: "partial work",
						}),
					},
					result_path: "/data/out.org",
				}),
			],
			"/tmp/pi-subagent-abc",
		);
		expect(text).toContain("scout · task-1 · succeeded");
		expect(text).toContain("fetcher · task-2 · failed");
		expect(text).toContain("synth · task-3 · succeeded");
		expect(text).toContain("Status: succeeded");
		expect(text).toContain("Status: partial");
		expect(text).toContain("Result: /data/out.org");
	});

	it("shows none for empty key changes and contradictions", () => {
		const text = renderSummaryResults(
			[
				status({
					parsedResult: {
						summary: makeSummary({
							keyChanges: [],
							contradictions: [],
						}),
					},
				}),
			],
			null,
		);
		expect(text).toContain("Key changes: none");
		expect(text).toContain("Contradictions/blockers: none");
	});

	it("renders errorMessage for a failed export even when parsedResult exists", () => {
		const text = renderSummaryResults(
			[
				status({
					state: "failed",
					errorMessage: "Result export failed: Permission denied",
					parsedResult: {
						summary: makeSummary({ status: "succeeded" }),
					},
				}),
			],
			null,
		);
		// I2: errorMessage must be visible even when parsedResult is present
		expect(text).toContain("Result export failed: Permission denied");
		expect(text).not.toContain("<coordinator-summary>");
	});

	it("does not show Result: line when export failed", () => {
		const text = renderSummaryResults(
			[
				status({
					state: "failed",
					errorMessage: "Result export failed: Permission denied",
					result_path: "/data/out.org",
					parsedResult: {
						summary: makeSummary({ status: "succeeded" }),
					},
				}),
			],
			null,
		);
		// I3: Result: path must not appear when state is not succeeded
		expect(text).not.toContain("Result: /data/out.org");
	});
});
