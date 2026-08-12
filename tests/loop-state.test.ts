import { describe, it, expect } from "vitest";
import {
	addCoordinatorUsage,
	addNestedUsage,
	normalizeState,
} from "../extensions/loop/state.ts";

function makeBaseState(overrides: Partial<Record<keyof import("../extensions/loop/state.ts").LoopState, unknown>> = {}) {
	return {
		id: "test-1",
		commandName: "loop",
		programPath: "/fake/program.md",
		mission: "test mission",
		rounds: 0,
		maxRounds: 10,
		tokensUsed: 0,
		tokenBudget: null,
		status: "active" as const,
		guardId: "test-guard",
		noProgressTurns: 3,
		noProgressCount: 0,
		lastFingerprint: null,
		updatedAt: 1000,
		coordinatorUsage: 0,
		nestedUsage: 0,
		processedToolCallIds: [],
		...overrides,
	} as import("../extensions/loop/state.ts").LoopState;
}

describe("addCoordinatorUsage", () => {
	it("adds totalTokens directly", () => {
		const state = makeBaseState();
		const result = addCoordinatorUsage(state, { totalTokens: 1500 });
		expect(result.coordinatorUsage).toBe(1500);
		expect(result.tokensUsed).toBe(1500);
		expect(result.updatedAt).toBeGreaterThan(1000);
	});

	it("adds sum of input+output+cacheRead+cacheWrite", () => {
		const state = makeBaseState();
		const result = addCoordinatorUsage(state, {
			input: 500,
			output: 300,
			cacheRead: 200,
			cacheWrite: 100,
		});
		expect(result.coordinatorUsage).toBe(1100);
		expect(result.tokensUsed).toBe(1100);
	});

	it("ignores invalid input", () => {
		const state = makeBaseState({ tokensUsed: 100 });
		const result = addCoordinatorUsage(state, "not-an-object");
		expect(result.coordinatorUsage).toBe(0);
		expect(result.tokensUsed).toBe(100);
	});

	it("clamps negative deltas to zero", () => {
		const state = makeBaseState({ tokensUsed: 100 });
		const result = addCoordinatorUsage(state, { totalTokens: -500 });
		expect(result.coordinatorUsage).toBe(0);
		expect(result.tokensUsed).toBe(100);
	});

	it("accumulates across multiple calls", () => {
		let s = makeBaseState();
		s = addCoordinatorUsage(s, { totalTokens: 100 });
		s = addCoordinatorUsage(s, { totalTokens: 200 });
		expect(s.coordinatorUsage).toBe(300);
		expect(s.tokensUsed).toBe(300);
	});
});

describe("addNestedUsage", () => {
	it("adds totalTokens directly", () => {
		const state = makeBaseState();
		const result = addNestedUsage(state, { totalTokens: 800 });
		expect(result.nestedUsage).toBe(800);
		expect(result.tokensUsed).toBe(800);
	});

	it("accumulates independently from coordinator", () => {
		let s = makeBaseState();
		s = addCoordinatorUsage(s, { totalTokens: 100 });
		s = addNestedUsage(s, { totalTokens: 50 });
		expect(s.coordinatorUsage).toBe(100);
		expect(s.nestedUsage).toBe(50);
		expect(s.tokensUsed).toBe(150);
	});

	it("ignores invalid input", () => {
		const state = makeBaseState({ tokensUsed: 100 });
		const result = addNestedUsage(state, null as never);
		expect(result.nestedUsage).toBe(0);
		expect(result.tokensUsed).toBe(100);
	});
});

describe("normalizeState", () => {
	it("provides defaults for missing fields", () => {
		const old = {
			id: "old-1",
			commandName: "loop",
			programPath: "/fake.md",
			mission: "old",
			rounds: 0,
			maxRounds: 10,
			tokensUsed: 0,
			tokenBudget: null,
			status: "active" as const,
			updatedAt: 100,
			noProgressTurns: undefined,
			noProgressCount: undefined,
			lastFingerprint: undefined,
			coordinatorUsage: undefined,
			nestedUsage: undefined,
			processedToolCallIds: undefined,
			maxSearchesPerAgent: undefined,
			maxFetchesPerAgent: undefined,
			guardId: undefined,
		} as unknown as import("../extensions/loop/state.ts").LoopState;

		const result = normalizeState(old);
		expect(result.noProgressTurns).toBe(3);
		expect(result.noProgressCount).toBe(0);
		expect(result.lastFingerprint).toBeNull();
		expect(result.guardId).toBeTruthy(); // generated
		expect(result.coordinatorUsage).toBe(0);
		expect(result.nestedUsage).toBe(0);
		expect(result.processedToolCallIds).toEqual([]);
		expect(result.maxSearchesPerAgent).toBe(0);
		expect(result.maxFetchesPerAgent).toBe(0);
		expect(result.checkpointEvidence).toBeUndefined();
		expect(result.profile).toBe("standard");
	});

	it("preserves existing values", () => {
		const state = makeBaseState({
			guardId: "my-guard",
			noProgressTurns: 5,
			noProgressCount: 3,
			lastFingerprint: "hello",
			coordinatorUsage: 42,
			nestedUsage: 17,
			processedToolCallIds: ["tool-1", "tool-2"],
			maxSearchesPerAgent: 100,
			maxFetchesPerAgent: 200,
			profile: "deep",
		});
		const result = normalizeState(state);
		expect(result.guardId).toBe("my-guard");
		expect(result.noProgressTurns).toBe(5);
		expect(result.noProgressCount).toBe(3);
		expect(result.lastFingerprint).toBe("hello");
		expect(result.coordinatorUsage).toBe(42);
		expect(result.nestedUsage).toBe(17);
		expect(result.processedToolCallIds).toEqual(["tool-1", "tool-2"]);
		expect(result.maxSearchesPerAgent).toBe(100);
		expect(result.maxFetchesPerAgent).toBe(200);
		expect(result.profile).toBe("deep");
	});
});
