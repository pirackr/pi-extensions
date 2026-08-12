import { describe, it, expect, vi } from "vitest";
import {
	CompletionFailure,
	CompletionPolicy,
	makeGenericPolicy,
} from "../extensions/loop/completion.ts";
import type { LoopState } from "../extensions/loop/state.ts";

function makeState(overrides: Partial<LoopState> = {}): Readonly<LoopState> {
	return {
		id: "test-1",
		commandName: "loop",
		programPath: "/fake.md",
		mission: "test",
		rounds: 5,
		maxRounds: 10,
		tokensUsed: 1000,
		tokenBudget: null,
		status: "active",
		guardId: "g",
		noProgressTurns: 3,
		noProgressCount: 0,
		lastFingerprint: null,
		updatedAt: Date.now(),
		coordinatorUsage: 0,
		nestedUsage: 0,
		processedToolCallIds: [],
		...overrides,
	} as Readonly<LoopState>;
}

describe("makeGenericPolicy", () => {
	it("always returns an empty failure list", async () => {
		const policy = makeGenericPolicy();
		const failures = await policy.audit(makeState());
		expect(failures).toEqual([]);
	});

	it("returns empty failures regardless of state", async () => {
		const policy = makeGenericPolicy();
		const failures = await policy.audit(makeState({ status: "complete" }));
		expect(failures).toEqual([]);
	});

	it("is async — returns a Promise", () => {
		const policy = makeGenericPolicy();
		const result = policy.audit(makeState());
		expect(result).toBeInstanceOf(Promise);
		result.then((f) => expect(f).toEqual([]));
	});
});

describe("CompletionFailure type", () => {
	it("accepts { code, message } objects", () => {
		const failure: CompletionFailure = {
			code: "checkpoint",
			message: "missing evidence",
		};
		expect(failure.code).toBe("checkpoint");
		expect(failure.message).toBe("missing evidence");
	});
});

describe("custom CompletionPolicy", () => {
	it("can be implemented to return typed failures", async () => {
		const fakePolicy: CompletionPolicy = {
			async audit(_state: Readonly<LoopState>): Promise<CompletionFailure[]> {
				return [
					{ code: "gate-a", message: "gate A failed" },
					{ code: "gate-b", message: "gate B failed" },
				];
			},
		};
		const failures = await fakePolicy.audit(makeState());
		expect(failures).toHaveLength(2);
		expect(failures[0].code).toBe("gate-a");
		expect(failures[0].message).toBe("gate A failed");
		expect(failures[1].code).toBe("gate-b");
	});

	it("can delay with async logic (simulated with vi)", async () => {
		const delayMs = 10;
		const fakePolicy: CompletionPolicy = {
			async audit(_state: Readonly<LoopState>): Promise<CompletionFailure[]> {
				await new Promise((r) => setTimeout(r, delayMs));
				return [];
			},
		};
		const start = Date.now();
		await fakePolicy.audit(makeState());
		expect(Date.now() - start).toBeGreaterThanOrEqual(delayMs);
	});
});

describe("generic /loop has no research checkpoint or verification gates", () => {
	it("generic policy does not check for checkpointEvidence", async () => {
		const policy = makeGenericPolicy();
		// State with no checkpointEvidence
		const state = makeState({ checkpointEvidence: undefined });
		const failures = await policy.audit(state);
		expect(failures).toEqual([]);
	});

	it("generic policy does not check for report.org", async () => {
		const policy = makeGenericPolicy();
		const state = makeState({ workingDir: "/nonexistent" });
		const failures = await policy.audit(state);
		expect(failures).toEqual([]);
	});

	it("generic policy does not check verification artifacts", async () => {
		const policy = makeGenericPolicy();
		const state = makeState({ profile: "deep" });
		const failures = await policy.audit(state);
		expect(failures).toEqual([]);
	});
});
