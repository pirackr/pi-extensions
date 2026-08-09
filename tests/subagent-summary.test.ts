import { describe, it, expect } from "vitest";
import {
	parseCoordinatorResult,
	renderSummaryResults,
} from "../extensions/tmux-subagent/render.ts";
import type {
	CoordinatorSummary,
	RenderStatus,
} from "../extensions/tmux-subagent/render.ts";

// --- parseCoordinatorResult ---

const FULL_SUMMARY = `<coordinator-summary>
Status: succeeded
Outcome: Found 3 credible sources for the query
Evidence added: 3
Key changes:
- Updated findings-1.org with source A
- Updated findings-2.org with source B
- Added contradiction note for source C
Contradictions/blockers: none
Recommended next action: run fetch on source A primary URL
</coordinator-summary>
Some trailing text.`;

const FAILED_SUMMARY = `<coordinator-summary>
Status: failed
Outcome: Timeout after 300 seconds
Evidence added: 0
Key changes: none
Contradictions/blockers:
- Network timeout on primary query
- Fallback engine returned empty results
Recommended next action: retry with expanded query
</coordinator-summary>`;

const PARTIAL_SUMMARY = `<coordinator-summary>
Status: partial
Outcome: Found 1 of 3 expected sources
Evidence added: 1
Key changes: initialized findings-1.org
Contradictions/blockers: none
Recommended next action: dispatch another scout for remaining queries
</coordinator-summary>`;

const BLOCKED_SUMMARY = `<coordinator-summary>
Status: blocked
Outcome: Auth token expired
Evidence added: 0
Key changes: none
Contradictions/blockers: API key invalid
Recommended next action: rotate API key and retry
</coordinator-summary>`;

describe("parseCoordinatorResult", () => {
	it("extracts all 6 fields from a succeeded summary", () => {
		const result = parseCoordinatorResult(FULL_SUMMARY);
		expect(result.summary.status).toBe("succeeded");
		expect(result.summary.outcome).toBe(
			"Found 3 credible sources for the query",
		);
		expect(result.summary.evidenceAdded).toBe("3");
		expect(result.summary.keyChanges).toEqual([
			"Updated findings-1.org with source A",
			"Updated findings-2.org with source B",
			"Added contradiction note for source C",
		]);
		expect(result.summary.contradictions).toEqual(["none"]);
		expect(result.summary.recommendedNextAction).toBe(
			"run fetch on source A primary URL",
		);
		expect(result.artifact).toBeUndefined();
	});

	it("parses all 4 statuses", () => {
		expect(parseCoordinatorResult(FAILED_SUMMARY).summary.status).toBe(
			"failed",
		);
		expect(parseCoordinatorResult(PARTIAL_SUMMARY).summary.status).toBe(
			"partial",
		);
		expect(parseCoordinatorResult(BLOCKED_SUMMARY).summary.status).toBe(
			"blocked",
		);
		expect(parseCoordinatorResult(FULL_SUMMARY).summary.status).toBe(
			"succeeded",
		);
	});

	it("extracts artifact block when present", () => {
		const text = `${FULL_SUMMARY}\n<artifact>\n{\n  "verdict": "PASS"\n}\n</artifact>`;
		const result = parseCoordinatorResult(text);
		expect(result.artifact).toBe('{\n  "verdict": "PASS"\n}');
	});

	it("returns artifact as undefined when not present", () => {
		const result = parseCoordinatorResult(FULL_SUMMARY);
		expect(result.artifact).toBeUndefined();
	});

	it("throws when coordinator-summary block is missing", () => {
		expect(() => parseCoordinatorResult("no summary here")).toThrow(
			"Missing <coordinator-summary> block",
		);
	});

	it("throws when Status field is missing", () => {
		const text = `<coordinator-summary>
Outcome: something
Evidence added: 1
Key changes: none
Contradictions/blockers: none
Recommended next action: do something
</coordinator-summary>`;
		expect(() => parseCoordinatorResult(text)).toThrow(
			"missing Status field",
		);
	});

	it("throws when Outcome field is missing", () => {
		const text = `<coordinator-summary>
Status: succeeded
Evidence added: 1
Key changes: none
Contradictions/blockers: none
Recommended next action: do something
</coordinator-summary>`;
		expect(() => parseCoordinatorResult(text)).toThrow(
			"missing Outcome field",
		);
	});

	it("throws when Evidence added field is missing", () => {
		const text = `<coordinator-summary>
Status: succeeded
Outcome: ok
Key changes: none
Contradictions/blockers: none
Recommended next action: do something
</coordinator-summary>`;
		expect(() => parseCoordinatorResult(text)).toThrow(
			"missing Evidence added field",
		);
	});

	it("throws when Recommended next action field is missing", () => {
		const text = `<coordinator-summary>
Status: succeeded
Outcome: ok
Evidence added: 1
Key changes: none
Contradictions/blocker: none
</coordinator-summary>`;
		expect(() => parseCoordinatorResult(text)).toThrow(
			"missing Recommended next action field",
		);
	});

	it("throws on invalid Status value", () => {
		const text = `<coordinator-summary>
Status: unknown
Outcome: ok
Evidence added: 1
Key changes: none
Contradictions/blockers: none
Recommended next action: do something
</coordinator-summary>`;
		expect(() => parseCoordinatorResult(text)).toThrow(
			'invalid Status value "unknown"',
		);
	});

	it("throws for artifact when requireArtifact is true and block is missing", () => {
		expect(() =>
			parseCoordinatorResult(FULL_SUMMARY, { requireArtifact: true }),
		).toThrow("Missing <artifact> block");
	});

	it("accepts artifact when requireArtifact is true and block is present", () => {
		const text = `${FULL_SUMMARY}\n<artifact>payload</artifact>`;
		const result = parseCoordinatorResult(text, { requireArtifact: true });
		expect(result.artifact).toBe("payload");
	});

	it("extracts artifact byte-for-byte (no trimming of inner content)", () => {
		const artifactBody = "line1\nline2\n  indented\nline4";
		const text = `<coordinator-summary>
Status: succeeded
Outcome: ok
Evidence added: 0
Key changes: none
Contradictions/blockers: none
Recommended next action: done
</coordinator-summary>
<artifact>\n${artifactBody}\n</artifact>`;
		const result = parseCoordinatorResult(text);
		// trim() on the captured group removes surrounding whitespace
		expect(result.artifact).toBe(artifactBody);
	});

	it("handles single-line key changes and contradictions", () => {
		const text = `<coordinator-summary>
Status: succeeded
Outcome: ok
Evidence added: 1
Key changes: single item
Contradictions/blockers: one blocker
Recommended next action: proceed
</coordinator-summary>`;
		const result = parseCoordinatorResult(text);
		expect(result.summary.keyChanges).toEqual(["single item"]);
		expect(result.summary.contradictions).toEqual(["one blocker"]);
	});

	it("handles empty arrays for key changes and contradictions", () => {
		const text = `<coordinator-summary>
Status: succeeded
Outcome: ok
Evidence added: 0
Key changes:
Contradictions/blockers:
Recommended next action: proceed
</coordinator-summary>`;
		const result = parseCoordinatorResult(text);
		expect(result.summary.keyChanges).toEqual([]);
		expect(result.summary.contradictions).toEqual([]);
	});

	it("treats continuation lines as list items", () => {
		const text = `<coordinator-summary>
Status: succeeded
Outcome: ok
Evidence added: 2
Key changes: first item
- second item
- third item
Contradictions/blockers: blocker one
- blocker two
Recommended next action: fix blockers
</coordinator-summary>`;
		const result = parseCoordinatorResult(text);
		expect(result.summary.keyChanges).toEqual([
			"first item",
			"second item",
			"third item",
		]);
		expect(result.summary.contradictions).toEqual([
			"blocker one",
			"blocker two",
		]);
	});
});

// --- renderSummaryResults ---

function status(
	partial: Partial<RenderStatus> & { parsedResult?: RenderStatus["parsedResult"]; result_path?: string; usage?: RenderStatus["usage"] },
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
		expect(text).toContain("scout_research / task-1 (succeeded)");
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
		expect(text).toContain("scout / task-1 (succeeded) — model: test-model");
		expect(text).toContain("fetcher / task-2 (failed) — model: test-model");
		expect(text).toContain("synth / task-3 (succeeded) — model: test-model");
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
});
