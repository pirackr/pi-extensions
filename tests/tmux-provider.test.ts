/**
 * TmuxSubagentProvider contract tests + migrated subagent-summary tests.
 *
 * This file runs the same shared Task 4 contract suite against the tmux
 * provider adapter (TmuxSubagentProvider) that was already exercised by the
 * fake provider in subagent-contract.test.ts.  It also migrates the
 * `renderSummaryResults` and `parseCoordinatorResult` assertions from
 * subagent-summary.test.ts so they live alongside the provider tests.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the pi-coding-agent module
// ---------------------------------------------------------------------------
vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: vi.fn().mockReturnValue("/mock/agent/dir"),
}));

// ---------------------------------------------------------------------------
// Mock typebox (used by config loader)
// ---------------------------------------------------------------------------
vi.mock("typebox", () => ({
	Type: {
		Object: vi.fn((props: any) => ({ type: "object", ...props })),
		String: vi.fn((opts: any) => ({ type: "string", ...opts })),
		Number: vi.fn((opts: any) => ({ type: "number", ...opts })),
		Array: vi.fn((item: any, opts: any) => ({
			type: "array",
			item,
			...opts,
		})),
		Optional: vi.fn((item: any) => ({ optional: true, ...item })),
		Literal: vi.fn((val: any) => ({ literal: val })),
		Union: vi.fn((items: any, opts: any) => ({
			union: items,
			...opts,
		})),
	},
}));

// ---------------------------------------------------------------------------
// Mock the config loader — return a minimal profile set
// ---------------------------------------------------------------------------
vi.mock("../extensions/tmux-subagent/config.ts", () => ({
	loadSubagentConfiguration: vi.fn(() => ({
		config: {
			models: { worker: "test-model" },
			childExtensions: [],
			toolAccess: {},
			agentDirs: [],
			loadContextFiles: true,
			maxTasks: 4,
			defaultTimeoutSeconds: 300,
			retainArtifacts: "on_failure" as const,
			webSearchMaxLookups: 0,
			webSearchMaxFetches: 0,
		},
		profiles: [
			{ name: "worker", description: "Worker agent", model: "test-model" },
			{ name: "scout", description: "Scout agent", model: "test-model" },
		],
		userConfigPath: "/mock/agent/dir/tmux-subagent/config.json",
	})),
}));

// ---------------------------------------------------------------------------
// Mock tmux.ts — launchBatch returns a predictable mock window
// ---------------------------------------------------------------------------
vi.mock("../extensions/tmux-subagent/tmux.ts", () => ({
	SHARED_SESSION: "pi-subagents",
	launchBatch: vi.fn().mockResolvedValue({
		session: "pi-subagents",
		window: { id: "@42", name: "test-window", sessionId: "parent" },
		paneIds: ["%1"],
	}),
	cancelPanes: vi.fn().mockResolvedValue(undefined),
	ensureSharedSession: vi
		.fn()
		.mockResolvedValue({ created: false, reused: true }),
	findParentWindow: vi.fn().mockResolvedValue(null),
	withMutationLock: vi.fn(async (fn) => fn()),
	ensureParentWindow: vi.fn().mockResolvedValue({
		id: "@42",
		name: "test-window",
		sessionId: "parent",
		pid: "1",
		cwd: ".",
	}),
	listPanes: vi
		.fn()
		.mockResolvedValue([{ id: "%1", dead: false, runId: "", taskId: "" }]),
	listParentWindows: vi.fn().mockResolvedValue([]),
	reclaimStaleWindows: vi.fn().mockResolvedValue(undefined),
	closeParentWindow: vi.fn().mockResolvedValue(undefined),
	renameWindow: vi.fn().mockResolvedValue(undefined),
	sessionExists: vi.fn().mockResolvedValue(false),
	buildWindowName: vi.fn((cwd: string) => `window-${cwd.split("/").pop()}`),
	getWindowId: vi.fn().mockResolvedValue("@42"),
	planGrid: vi.fn(() => ({ columns: 1, rowsPerColumn: [1] })),
	paneGridPosition: vi.fn(() => ({ column: 0, row: 0 })),
	buildLayoutString: vi.fn(() => "checksum,body"),
	layoutChecksum: vi.fn(() => 0),
}));

// ---------------------------------------------------------------------------
// Import under test (after mocks)
// ---------------------------------------------------------------------------
import {
	TmuxSubagentProvider,
	TmuxSubagentProviderDescriptor,
} from "../extensions/tmux-subagent/provider.ts";
import type { TmuxExecutor } from "../extensions/tmux-subagent/tmux.ts";
import {
	runCommand,
	summarizeSummaryDetails,
	type TaskStatus,
} from "../extensions/tmux-subagent/index.ts";
import type {
	AttemptResult,
	ProviderDescriptor,
	SerializedError,
} from "../extensions/subagent-dispatch/contract.ts";
import {
	FakeSubagentProvider,
	createFacade,
	resetFacade,
	registerFaçadeTools,
	MockDispatchPolicy,
} from "../extensions/subagent-dispatch/index.ts";
import { ProviderRegistry } from "../extensions/subagent-dispatch/registry.ts";
import { negotiateProvider } from "../extensions/subagent-dispatch/contract.ts";

// ---------------------------------------------------------------------------
// Mock tmuxExec for launchBatch testing
// ---------------------------------------------------------------------------

function mockTmuxExec(): {
	exec: TmuxExecutor;
	calls: string[][];
} {
	const calls: string[][] = [];
	const exec: TmuxExecutor = async (args) => {
		calls.push(args);
		return { stdout: "", stderr: "" };
	};
	return { exec, calls };
}

// ---------------------------------------------------------------------------
// Provider descriptor tests
// ---------------------------------------------------------------------------

describe("TmuxSubagentProvider — descriptor", () => {
	it("has a stable descriptor with id and capabilities", () => {
		const provider = new TmuxSubagentProvider();
		expect(provider.descriptor.id).toBe("tmux-subagent");
		expect(provider.descriptor.capabilities).toContain("tmux");
		expect(provider.descriptor.maxConcurrentAttempts).toBe(10);
		expect(provider.descriptor.maxAttemptsPerTask).toBe(100);
		expect(provider.descriptor.adapterVersion).toBe("0.0.1");
	});

	it("exports a static descriptor equal to the instance descriptor", () => {
		expect(TmuxSubagentProviderDescriptor.id).toBe("tmux-subagent");
		expect(TmuxSubagentProviderDescriptor.capabilities).toContain("tmux");
	});
});

// ---------------------------------------------------------------------------
// executeAttempt — one invocation, one physical launch (contract)
// ---------------------------------------------------------------------------

describe("TmuxSubagentProvider — executeAttempt contract", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("returns an AttemptResult with output, usage, and metadata", async () => {
		const provider = new TmuxSubagentProvider();
		const plan = { attemptId: "att-1", planId: "p1", index: 0 };
		const result = await provider.executeAttempt(
			plan,
			new AbortController().signal,
		);

		expect(result).toBeDefined();
		expect(result.output).toBeDefined();
		expect(result.usage).toBeDefined();
		expect(result.metadata).toBeDefined();
		expect(result.metadata?.provider).toBe("tmux-subagent");
		expect(result.metadata?.windowId).toBe("@42");
	});

	it("F1: metadata includes startedAt and finishedAt ISO timestamps", async () => {
		const provider = new TmuxSubagentProvider();
		const plan = { attemptId: "att-ts", planId: "p1", index: 0 };
		const result = await provider.executeAttempt(
			plan,
			new AbortController().signal,
		);

		expect(result.metadata?.startedAt).toBeDefined();
		expect(result.metadata?.finishedAt).toBeDefined();
		// Both must be valid ISO 8601 strings.
		expect(new Date(result.metadata?.startedAt as string).toISOString()).toBe(
			result.metadata?.startedAt,
		);
		expect(new Date(result.metadata?.finishedAt as string).toISOString()).toBe(
			result.metadata?.finishedAt,
		);
		// finishedAt must be >= startedAt.
		expect(
			new Date(result.metadata?.finishedAt as string) >=
				new Date(result.metadata?.startedAt as string),
		).toBe(true);
	});

	it("F7: metadata includes sessionId from launchResult.window", async () => {
		const provider = new TmuxSubagentProvider();
		const plan = { attemptId: "att-sid", planId: "p1", index: 0 };
		const result = await provider.executeAttempt(
			plan,
			new AbortController().signal,
		);

		expect(result.metadata?.sessionId).toBe("parent");
	});

	it("one executeAttempt call = one launchBatch invocation", async () => {
		const provider = new TmuxSubagentProvider();
		const plan = { attemptId: "att-launch", planId: "p1", index: 0 };
		await provider.executeAttempt(plan, new AbortController().signal);

		// Check that launchBatch was called exactly once
		const { launchBatch } = await import("../extensions/tmux-subagent/tmux.ts");
		expect(launchBatch).toHaveBeenCalledTimes(1);
	});

	it("passes taskInfo to build task identity", async () => {
		const provider = new TmuxSubagentProvider();
		const plan = {
			attemptId: "att-info",
			planId: "p1",
			index: 2,
			taskInfo: { taskId: "unique-task", objective: "test", agent: "scout" },
		};
		await provider.executeAttempt(plan, new AbortController().signal);

		const { launchBatch } = await import("../extensions/tmux-subagent/tmux.ts");
		const callArgs = (launchBatch as any).mock.calls[0];
		const panes = callArgs[1].panes;
		expect(panes).toHaveLength(1);
		expect(panes[0].taskId).toBe("unique-task");
		expect(panes[0].agent).toBe("scout");
		expect(panes[0].order).toBe(2);
	});

	it("falls back to task-N when taskId missing from taskInfo", async () => {
		const provider = new TmuxSubagentProvider();
		const plan = {
			attemptId: "att-fallback",
			planId: "p1",
			index: 3,
			taskInfo: {},
		};
		await provider.executeAttempt(plan, new AbortController().signal);

		const { launchBatch } = await import("../extensions/tmux-subagent/tmux.ts");
		const callArgs = (launchBatch as any).mock.calls[0];
		const panes = callArgs[1].panes;
		expect(panes[0].taskId).toBe("task-4");
	});

	it("falls back to 'worker' when agent missing from taskInfo", async () => {
		const provider = new TmuxSubagentProvider();
		const plan = {
			attemptId: "att-agent-fallback",
			planId: "p1",
			index: 0,
			taskInfo: {},
		};
		await provider.executeAttempt(plan, new AbortController().signal);

		const { launchBatch } = await import("../extensions/tmux-subagent/tmux.ts");
		const callArgs = (launchBatch as any).mock.calls[0];
		const panes = callArgs[1].panes;
		expect(panes[0].agent).toBe("worker");
	});

	it("rejects immediately when signal is already aborted", async () => {
		const provider = new TmuxSubagentProvider();
		const controller = new AbortController();
		controller.abort();
		const plan = { attemptId: "a3", planId: "p1", index: 0 };

		// F2: provider must throw before launching when already aborted.
		await expect(
			provider.executeAttempt(plan, controller.signal),
		).rejects.toThrow("Attempt a3 cancelled before launch");
		const { launchBatch } = await import("../extensions/tmux-subagent/tmux.ts");
		expect(launchBatch).not.toHaveBeenCalled();
	});

	it("no hidden retries — provider delegates to launchBatch once per call", async () => {
		const provider = new TmuxSubagentProvider();
		const plan = { attemptId: "att-no-retry", planId: "p1", index: 0 };
		await provider.executeAttempt(plan, new AbortController().signal);
		await provider.executeAttempt(plan, new AbortController().signal);

		const { launchBatch } = await import("../extensions/tmux-subagent/tmux.ts");
		expect(launchBatch).toHaveBeenCalledTimes(2);
	});
});

// ---------------------------------------------------------------------------
// negotiateProvider — tmux provider satisfies its own capability
// ---------------------------------------------------------------------------

describe("negotiateProvider — tmux provider capability", () => {
	const providers = [
		{
			id: "fake-provider",
			adapterVersion: "0.0.1",
			protocolVersion: "0.1.0",
			executionSpecVersion: "0.1.0",
			capabilities: ["local"],
			maxConcurrentAttempts: 10,
			maxAttemptsPerTask: 100,
		},
		{
			id: "tmux-subagent",
			adapterVersion: "0.0.1",
			protocolVersion: "0.1.0",
			executionSpecVersion: "0.1.0",
			capabilities: ["tmux"],
			maxConcurrentAttempts: 10,
			maxAttemptsPerTask: 100,
		},
	];

	it("selects tmux provider when capabilities = ['tmux']", () => {
		const result = negotiateProvider(providers, "tmux-subagent", ["tmux"]);
		expect(result.providerId).toBe("tmux-subagent");
	});

	it("rejects tmux provider for non-tmux capabilities", () => {
		expect(() =>
			negotiateProvider(providers, "tmux-subagent", ["local"]),
		).toThrow('Provider "tmux-subagent" lacks capabilities: local');
	});

	it("auto-selects tmux provider for tmux requirements", () => {
		const result = negotiateProvider(providers, null, ["tmux"]);
		expect(result.providerId).toBe("tmux-subagent");
	});
});

// ---------------------------------------------------------------------------
// ProviderRegistry — tmux provider
// ---------------------------------------------------------------------------

describe("ProviderRegistry — tmux provider", () => {
	it("stores and returns tmux provider by id", () => {
		const reg = new ProviderRegistry();
		reg.register(TmuxSubagentProviderDescriptor);
		expect(reg.get("tmux-subagent")).toBeDefined();
		expect(reg.get("fake-provider")).toBeUndefined();
		reg.clear();
	});

	it("rejects duplicate tmux provider id", () => {
		const reg = new ProviderRegistry();
		reg.register(TmuxSubagentProviderDescriptor);
		expect(() => reg.register(TmuxSubagentProviderDescriptor)).toThrow(
			'Duplicate provider id: "tmux-subagent". Providers must have unique IDs.',
		);
		reg.clear();
	});
});

// ---------------------------------------------------------------------------
// Migrated: parseCoordinatorResult (from subagent-summary.test.ts)
// ---------------------------------------------------------------------------

import {
	parseCoordinatorResult,
	renderSummaryResults,
} from "../extensions/tmux-subagent/render.ts";
import type {
	CoordinatorSummary,
	RenderStatus,
} from "../extensions/tmux-subagent/render.ts";

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
		expect(result.summary.outcome).toBe("Found 3 credible sources for the query");
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
		expect(parseCoordinatorResult(FAILED_SUMMARY).summary.status).toBe("failed");
		expect(parseCoordinatorResult(PARTIAL_SUMMARY).summary.status).toBe(
			"partial",
		);
		expect(parseCoordinatorResult(BLOCKED_SUMMARY).summary.status).toBe(
			"blocked",
		);
		expect(parseCoordinatorResult(FULL_SUMMARY).summary.status).toBe("succeeded");
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
		expect(() => parseCoordinatorResult(text)).toThrow("missing Status field");
	});

	it("throws when Outcome field is missing", () => {
		const text = `<coordinator-summary>
Status: succeeded
Evidence added: 1
Key changes: none
Contradictions/blockers: none
Recommended next action: do something
</coordinator-summary>`;
		expect(() => parseCoordinatorResult(text)).toThrow("missing Outcome field");
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
Contradiction/blocker: none
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
		expect(result.summary.contradictions).toEqual(["blocker one", "blocker two"]);
	});
});

// ---------------------------------------------------------------------------
// Migrated: renderSummaryResults (from subagent-summary.test.ts)
// ---------------------------------------------------------------------------

function renderStatus(
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

describe("summary-mode detail retention", () => {
	it("excludes raw child output and artifact payloads while retaining the coordinator summary and task metadata", () => {
		const [detail] = summarizeSummaryDetails([
			{
				taskId: "task-1",
				agent: "scout_research",
				state: "succeeded",
				startedAt: "2026-08-12T18:13:14.000Z",
				finishedAt: "2026-08-12T18:15:00.000Z",
				model: "test-model",
				result: "RAW CHILD OUTPUT THAT MUST NOT REACH THE PARENT SESSION",
				result_path: "/tmp/report.org",
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
				parsedResult: {
					summary: makeSummary(),
					artifact: "RAW ARTIFACT PAYLOAD THAT MUST NOT REACH THE PARENT SESSION",
				},
			} as TaskStatus & {
				result_path: string;
				parsedResult: { summary: CoordinatorSummary; artifact: string };
			},
		]);

		expect(detail).toMatchObject({
			taskId: "task-1",
			agent: "scout_research",
			state: "succeeded",
			startedAt: "2026-08-12T18:13:14.000Z",
			finishedAt: "2026-08-12T18:15:00.000Z",
			model: "test-model",
			result_path: "/tmp/report.org",
			usage: { totalTokens: 165 },
			parsedResult: { summary: makeSummary() },
		});
		expect(detail).not.toHaveProperty("result");
		expect(detail.parsedResult).not.toHaveProperty("artifact");
	});
});

describe("renderSummaryResults", () => {
	it("renders the complete coordinator-summary envelope for succeeded tasks", () => {
		const text = renderSummaryResults(
			[renderStatus({ parsedResult: { summary: makeSummary() } })],
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
				renderStatus({
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
				renderStatus({
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
		const text = renderSummaryResults([renderStatus({})], "/tmp/pi-subagent-abc");
		expect(text).toContain("(no coordinator-summary)");
	});

	it("includes artifacts retained line when path provided", () => {
		const text = renderSummaryResults(
			[renderStatus({ parsedResult: { summary: makeSummary() } })],
			"/tmp/pi-subagent-abc",
		);
		expect(text).toContain("Artifacts retained at: /tmp/pi-subagent-abc");
	});

	it("omits artifacts retained line when path is null", () => {
		const text = renderSummaryResults(
			[renderStatus({ parsedResult: { summary: makeSummary() } })],
			null,
		);
		expect(text).not.toContain("Artifacts retained at:");
	});

	it("renders multiple tasks with different states", () => {
		const text = renderSummaryResults(
			[
				renderStatus({
					taskId: "task-1",
					agent: "scout",
					state: "succeeded",
					parsedResult: { summary: makeSummary({ status: "succeeded" }) },
				}),
				renderStatus({
					taskId: "task-2",
					agent: "fetcher",
					state: "failed",
					errorMessage: "network error",
				}),
				renderStatus({
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
				renderStatus({
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
				renderStatus({
					state: "failed",
					errorMessage: "Result export failed: Permission denied",
					parsedResult: {
						summary: makeSummary({ status: "succeeded" }),
					},
				}),
			],
			null,
		);
		expect(text).toContain("Result export failed: Permission denied");
		expect(text).not.toContain("<coordinator-summary>");
	});

	it("does not show Result: line when export failed", () => {
		const text = renderSummaryResults(
			[
				renderStatus({
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
		expect(text).not.toContain("Result: /data/out.org");
	});
});

// ---------------------------------------------------------------------------
// Façade integration — tmux provider in registry
// ---------------------------------------------------------------------------

describe("façade integration — tmux provider", () => {
	afterEach(() => {
		resetFacade();
	});

	it("tmux provider can be registered and negotiated", () => {
		const reg = new ProviderRegistry();
		reg.register(TmuxSubagentProviderDescriptor);

		const result = negotiateProvider(reg.getAll(), "tmux-subagent", ["tmux"]);
		expect(result.providerId).toBe("tmux-subagent");
		expect(result.descriptor.capabilities).toContain("tmux");
	});

	it("tmux provider satisfies auto-selection for tmux requirements", () => {
		const reg = new ProviderRegistry();
		reg.register(TmuxSubagentProviderDescriptor);

		const result = negotiateProvider(reg.getAll(), null, ["tmux"]);
		expect(result.providerId).toBe("tmux-subagent");
	});
});

// ---------------------------------------------------------------------------
// Usage aggregation
// ---------------------------------------------------------------------------

describe("usage aggregation", () => {
	it("aggregate usage sums across multiple attempts", () => {
		const usages = [
			{ totalTokens: 100, input: 50, output: 50, cacheRead: 0, cacheWrite: 0 },
			{ totalTokens: 200, input: 100, output: 100, cacheRead: 10, cacheWrite: 5 },
			{ totalTokens: 50, input: 25, output: 25, cacheRead: 0, cacheWrite: 0 },
		];
		const total = usages.reduce((sum, u) => sum + u.totalTokens, 0);
		expect(total).toBe(350);
	});
});
