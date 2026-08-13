import { describe, it, expect, beforeEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { LoopEngine } from "../extensions/loop/engine.ts";
import type { LoopState, LoopUsage } from "../extensions/loop/state.ts";
import type {
	CompletionFailure,
	CompletionPolicy,
} from "../extensions/loop/completion.ts";
import { addCoordinatorUsage } from "../extensions/loop/state.ts";

// --- Mock helpers ----------------------------------------------------------

function makeMockPi() {
	const entries: Array<{ type: string; data: unknown }> = [];
	const activeTools: string[] = [];
	const messages: Array<{
		customType: string;
		content: string;
		details: unknown;
	}> = [];
	const pi = {
		appendEntry: vi.fn((type: string, data: unknown) => {
			entries.push({ type, data });
		}),
		getActiveTools: () => [...activeTools],
		setActiveTools: vi.fn((tools: string[]) => {
			activeTools.length = 0;
			activeTools.push(...tools);
		}),
		sendMessage: vi.fn((msg: unknown) => {
			messages.push(
				msg as { customType: string; content: string; details: unknown },
			);
		}),
	};
	return { pi, entries, activeTools, messages };
}

function makeMockCtx(pending = false) {
	const statusLines: string[] = [];
	return {
		ui: {
			setStatus: vi.fn((_: string, line: string) => statusLines.push(line)),
		},
		hasPendingMessages: () => pending,
		isIdle: () => !pending,
		sessionManager: {
			getEntries: () =>
				[] as Array<{ type: string; customType: string; data: unknown }>,
		},
		getStatusLines: () => [...statusLines],
	};
}

function makePolicy(): CompletionPolicy {
	return {
		async audit() {
			return [];
		},
	};
}

function makeEngine() {
	const { pi, entries } = makeMockPi();
	const ctx = makeMockCtx();
	const engine = new LoopEngine({
		completionPolicy: makePolicy(),
		onStateChange: async (state: LoopState) => {
			// persist is called by the engine; this hook is for logging
		},
	});
	return { engine, pi, ctx, entries };
}

// Helper to flush microtask queue
async function flushMicrotasks(): Promise<void> {
	await new Promise((r) => setImmediate(r));
}

// --- Tests -----------------------------------------------------------------

describe("LoopEngine — state lifecycle", () => {
	let { engine, pi, ctx, entries } = makeEngine();

	beforeEach(() => {
		({ engine, pi, ctx, entries } = makeEngine());
	});

	it("starts a new loop via startState", () => {
		const state = engine.startState({
			commandName: "loop",
			programPath: "/fake.md",
			mission: "do the thing",
			maxRounds: 10,
			tokenBudget: null,
			noProgressTurns: 3,
		});
		expect(engine.state).toBe(state);
		expect(state.id).toBeTruthy();
		expect(state.rounds).toBe(0);
		expect(state.status).toBe("active");
		expect(state.coordinatorUsage).toBe(0);
		expect(state.nestedUsage).toBe(0);
		expect(state.processedToolCallIds).toEqual([]);
	});

	it("persists to appendEntry", () => {
		engine.startState({
			commandName: "loop",
			programPath: "/fake.md",
			mission: "persist test",
			maxRounds: 5,
			tokenBudget: null,
			noProgressTurns: 3,
		});
		engine.persist(pi, ctx);
		expect(pi.appendEntry).toHaveBeenCalledWith("pi-loop", expect.anything());
		const loopData = (pi.appendEntry as ReturnType<typeof vi.fn>).mock
			.calls[0][1] as { loop?: LoopState };
		expect(loopData.loop?.mission).toBe("persist test");
	});

	it("syncs complete_loop tool when active", () => {
		engine.startState({
			commandName: "loop",
			programPath: "/fake.md",
			mission: "tool sync test",
			maxRounds: 5,
			tokenBudget: null,
			noProgressTurns: 3,
		});
		engine.persist(pi, ctx);
		expect(pi.setActiveTools).toHaveBeenCalledWith(
			expect.arrayContaining(["complete_loop"]),
		);
	});

	it("resets complete_loop tool when not active", () => {
		engine.startState({
			commandName: "loop",
			programPath: "/fake.md",
			mission: "tool sync test",
			maxRounds: 5,
			tokenBudget: null,
			noProgressTurns: 3,
		});
		engine.completeState();
		engine.persist(pi, ctx);
		expect(pi.setActiveTools).toHaveBeenCalledWith(
			expect.not.arrayContaining(["complete_loop"]),
		);
	});
});

describe("LoopEngine — persistence at turn start", () => {
	let { engine, pi, ctx, entries } = makeEngine();

	beforeEach(() => {
		({ engine, pi, ctx, entries } = makeEngine());
	});

	it("turn_start marks active this turn", () => {
		engine.startState({
			commandName: "loop",
			programPath: "/fake.md",
			mission: "turn test",
			maxRounds: 5,
			tokenBudget: null,
			noProgressTurns: 3,
		});
		engine.startTurn();
		expect(engine.state?.status).toBe("active");
	});
});

describe("LoopEngine — agent_settled scheduling", () => {
	it("queues continuation from agent_end", async () => {
		const { engine, pi, ctx } = makeEngine();
		engine.startState({
			commandName: "loop",
			programPath: "/fake.md",
			mission: "agent_end test",
			maxRounds: 10,
			tokenBudget: null,
			noProgressTurns: 3,
		});
		engine.onAgentEnd(pi, ctx);
		// Flush microtask
		await flushMicrotasks();
		// Round should have incremented
		expect(engine.state?.rounds).toBe(1);
	});

	it("does NOT queue continuation when agent has pending messages", () => {
		const { engine, pi } = makeEngine();
		engine.startState({
			commandName: "loop",
			programPath: "/fake.md",
			mission: "pending test",
			maxRounds: 10,
			tokenBudget: null,
			noProgressTurns: 3,
		});
		const ctxWithPending = {
			hasPendingMessages: () => true,
			ui: { setStatus: () => {} },
		};
		engine.onAgentEnd(pi, ctxWithPending as never);
		// No continuation should be queued
		expect(engine.state?.rounds).toBe(0);
	});

	it("does NOT queue continuation when loop is not active", () => {
		const { engine, pi, ctx } = makeEngine();
		engine.startState({
			commandName: "loop",
			programPath: "/fake.md",
			mission: "inactive test",
			maxRounds: 10,
			tokenBudget: null,
			noProgressTurns: 3,
		});
		engine.completeState();
		engine.onAgentEnd(pi, ctx);
		expect(engine.state?.status).toBe("complete");
	});
});

describe("LoopEngine — coordinator-only and nested-only usage", () => {
	it("total = coordinatorUsage + nestedUsage", () => {
		const { engine } = makeEngine();
		engine.startState({
			commandName: "loop",
			programPath: "/fake.md",
			mission: "usage test",
			maxRounds: 5,
			tokenBudget: null,
			noProgressTurns: 3,
		});
		const usage: LoopUsage = engine.usage;
		expect(usage.coordinator).toBe(0);
		expect(usage.nested).toBe(0);
		expect(usage.total).toBe(0);
	});
});

describe("LoopEngine — budget enforcement", () => {
	it("hits token budget and transitions to budget_limited", async () => {
		const { engine, pi, ctx } = makeEngine();
		engine.startState({
			commandName: "loop",
			programPath: "/fake.md",
			mission: "budget test",
			maxRounds: 10,
			tokenBudget: 200,
			noProgressTurns: 3,
		});
		engine.startTurn();
		await engine.endTurn(pi, ctx, {
			message: {
				usage: { totalTokens: 200 },
			},
		});
		expect(engine.state?.status).toBe("budget_limited");
		expect(engine.state?.reason).toBe("tokens");
		expect(engine.state?.tokensUsed).toBe(200);
	});

	it("stays active when under budget", async () => {
		const { engine, pi, ctx } = makeEngine();
		engine.startState({
			commandName: "loop",
			programPath: "/fake.md",
			mission: "under budget test",
			maxRounds: 10,
			tokenBudget: 200,
			noProgressTurns: 3,
		});
		engine.startTurn();
		await engine.endTurn(pi, ctx, {
			message: { usage: { totalTokens: 100 } },
		});
		expect(engine.state?.status).toBe("active");
		expect(engine.state?.tokensUsed).toBe(100);
	});
});

describe("LoopEngine — round budget_limited from rounds", async () => {
	it("transitions to budget_limited when maxRounds reached", async () => {
		const { engine, pi, ctx } = makeEngine();
		engine.startState({
			commandName: "loop",
			programPath: "/fake.md",
			mission: "round budget test",
			maxRounds: 1,
			tokenBudget: null,
			noProgressTurns: 3,
		});
		// First onAgentEnd: increments round 0→1 (still active, 1 continuation done)
		engine.onAgentEnd(pi, ctx);
		await flushMicrotasks();
		expect(engine.state?.rounds).toBe(1);
		expect(engine.state?.status).toBe("active");
		// Second onAgentEnd: rounds 1 >= maxRounds 1 → budget_limited
		engine.onAgentEnd(pi, ctx);
		await flushMicrotasks();
		expect(engine.state?.status).toBe("budget_limited");
		expect(engine.state?.reason).toBe("rounds");
	});
});

describe("LoopEngine — no-progress detection", () => {
	it("detects no-progress after N consecutive tool-free rounds", async () => {
		const { engine, pi, ctx } = makeEngine();
		engine.startState({
			commandName: "loop",
			programPath: "/fake.md",
			mission: "no-progress test",
			maxRounds: 10,
			tokenBudget: null,
			noProgressTurns: 2,
		});
		// agent_end fires after each turn, queueing the next continuation
		// Turn 1 (no tools): queue continuation
		engine.onAgentEnd(pi, ctx);
		await flushMicrotasks();
		engine.startTurn();
		await engine.endTurn(pi, ctx, {
			message: { content: "same output" },
			toolResults: [],
		});
		expect(engine.state?.noProgressCount).toBe(1);
		expect(engine.state?.status).toBe("active");
		// Turn 2 (no tools): queue continuation
		engine.onAgentEnd(pi, ctx);
		await flushMicrotasks();
		engine.startTurn();
		await engine.endTurn(pi, ctx, {
			message: { content: "same output" },
			toolResults: [],
		});
		expect(engine.state?.status).toBe("no_progress");
	});

	it("resets no-progress counter on tool calls", async () => {
		const { engine, pi, ctx } = makeEngine();
		engine.startState({
			commandName: "loop",
			programPath: "/fake.md",
			mission: "no-progress-reset test",
			maxRounds: 10,
			tokenBudget: null,
			noProgressTurns: 2,
		});
		// Turn 1: no tool calls (count goes to 1)
		engine.onAgentEnd(pi, ctx);
		await flushMicrotasks();
		engine.startTurn();
		await engine.endTurn(pi, ctx, {
			message: { content: "same" },
			toolResults: [],
		});
		expect(engine.state?.noProgressCount).toBe(1);
		expect(engine.state?.status).toBe("active");
		// Turn 2: tool call resets counter
		engine.onAgentEnd(pi, ctx);
		await flushMicrotasks();
		engine.startTurn();
		await engine.endTurn(pi, ctx, {
			message: { content: "same" },
			toolResults: [{ id: "tool-1" }],
		});
		expect(engine.state?.noProgressCount).toBe(0);
	});

	it("does not detect no-progress when no-progress is off", async () => {
		const { engine, pi, ctx } = makeEngine();
		engine.startState({
			commandName: "loop",
			programPath: "/fake.md",
			mission: "no-progress-off test",
			maxRounds: 10,
			tokenBudget: null,
			noProgressTurns: 0,
		});
		engine.onAgentEnd(pi, ctx);
		await flushMicrotasks();
		engine.startTurn();
		await engine.endTurn(pi, ctx, {
			message: { content: "same output" },
			toolResults: [],
		});
		expect(engine.state?.status).toBe("active");
	});

	it("no-progress does not trigger when not in continuation turn", async () => {
		const { engine, pi, ctx } = makeEngine();
		engine.startState({
			commandName: "loop",
			programPath: "/fake.md",
			mission: "not-continuation test",
			maxRounds: 10,
			tokenBudget: null,
			noProgressTurns: 1,
		});
		// No prior queueContinuation — this is a normal (initial) turn, not a continuation
		engine.startTurn();
		await engine.endTurn(pi, ctx, {
			message: { content: "same output" },
			toolResults: [],
		});
		expect(engine.state?.status).toBe("active");
	});
});

describe("LoopEngine — restore and replay", () => {
	it("state survives persistence roundtrip", () => {
		const { engine, pi, ctx, entries } = makeEngine();
		engine.startState({
			commandName: "loop",
			programPath: "/fake.md",
			mission: "restore test",
			maxRounds: 5,
			tokenBudget: null,
			noProgressTurns: 3,
		});
		engine.startTurn();
		engine.endTurn(pi, ctx, { message: { usage: { totalTokens: 50 } } });
		engine.persist(pi, ctx);

		// Verify persisted data
		expect(pi.appendEntry).toHaveBeenCalled();
		const call = (pi.appendEntry as ReturnType<typeof vi.fn>).mock
			.calls[0][1] as { loop?: LoopState };
		expect(call.loop?.rounds).toBe(0);
		expect(call.loop?.tokensUsed).toBe(50);
	});
});

describe("LoopEngine — resume and pause state management", () => {
	it("resume returns new state with fresh guard", () => {
		const { engine } = makeEngine();
		engine.startState({
			commandName: "loop",
			programPath: "/fake.md",
			mission: "resume test",
			maxRounds: 5,
			tokenBudget: null,
			noProgressTurns: 3,
		});
		const resumed = engine.resumeState(Date.now());
		expect(resumed.status).toBe("active");
		expect(resumed.guardId).toBeTruthy();
		expect(resumed.noProgressCount).toBe(0);
		expect(resumed.lastFingerprint).toBeNull();
	});

	it("pause returns new state with paused status", () => {
		const { engine } = makeEngine();
		engine.startState({
			commandName: "loop",
			programPath: "/fake.md",
			mission: "pause test",
			maxRounds: 5,
			tokenBudget: null,
			noProgressTurns: 3,
		});
		const paused = engine.pauseState(Date.now());
		expect(paused.status).toBe("paused");
	});

	it("clear returns the previous state and nullifies engine state", () => {
		const { engine } = makeEngine();
		const initialState = engine.startState({
			commandName: "loop",
			programPath: "/fake.md",
			mission: "clear test",
			maxRounds: 5,
			tokenBudget: null,
			noProgressTurns: 3,
		});
		const cleared = engine.clearState();
		expect(cleared).toBe(initialState);
		expect(engine.state).toBeNull();
	});

	it("complete returns completed state", () => {
		const { engine } = makeEngine();
		engine.startState({
			commandName: "loop",
			programPath: "/fake.md",
			mission: "complete test",
			maxRounds: 5,
			tokenBudget: null,
			noProgressTurns: 3,
		});
		const completed = engine.completeState();
		expect(completed.status).toBe("complete");
		expect(engine.state?.status).toBe("complete");
	});
});

// ---- F1 regression: resume/pause persist state ----

describe("LoopEngine — F1: resume persists state into this.loop", () => {
	it("resumeState assigns to this.loop and persisted state reflects the resume", () => {
		const { engine, pi, ctx } = makeEngine();
		const beforeGuard = "original-guard";
		engine.startState({
			commandName: "loop",
			programPath: "/fake.md",
			mission: "resume-persist test",
			maxRounds: 5,
			tokenBudget: null,
			noProgressTurns: 3,
		});
		// Pretend it was paused so we can resume
		engine.state = {
			...engine.state!,
			status: "paused" as const,
			updatedAt: 1000,
		};
		const resumed = engine.resumeState(Date.now());
		expect(resumed.status).toBe("active");
		expect(engine.state).toBe(resumed); // F1: this.loop was mutated
		expect(engine.state?.status).toBe("active");
		expect(engine.state?.noProgressCount).toBe(0);
		expect(engine.state?.guardId).not.toBe(beforeGuard);
		// Persist and verify the persisted state is the resumed state
		engine.persist(pi, ctx);
		const call = (pi.appendEntry as ReturnType<typeof vi.fn>).mock
			.calls[0][1] as { loop?: LoopState };
		expect(call.loop?.status).toBe("active");
		expect(call.loop?.noProgressCount).toBe(0);
	});

	it("pauseState assigns to this.loop and persisted state reflects the pause", () => {
		const { engine, pi, ctx } = makeEngine();
		engine.startState({
			commandName: "loop",
			programPath: "/fake.md",
			mission: "pause-persist test",
			maxRounds: 5,
			tokenBudget: null,
			noProgressTurns: 3,
		});
		const paused = engine.pauseState(Date.now());
		expect(paused.status).toBe("paused");
		expect(engine.state).toBe(paused); // F1: this.loop was mutated
		expect(engine.state?.status).toBe("paused");
		engine.persist(pi, ctx);
		const call = (pi.appendEntry as ReturnType<typeof vi.fn>).mock
			.calls[0][1] as { loop?: LoopState };
		expect(call.loop?.status).toBe("paused");
	});
});

// ---- F3: addCoordinatorUsage wired into endTurn ----

describe("LoopEngine — F3: addCoordinatorUsage wired into endTurn", () => {
	it("endTurn calls addCoordinatorUsage and tracks coordinatorUsage", async () => {
		const { engine, pi, ctx } = makeEngine();
		engine.startState({
			commandName: "loop",
			programPath: "/fake.md",
			mission: "coord-usage test",
			maxRounds: 5,
			tokenBudget: null,
			noProgressTurns: 3,
		});
		engine.startTurn();
		await engine.endTurn(pi, ctx, {
			message: { usage: { totalTokens: 1200 } },
		});
		expect(engine.state?.coordinatorUsage).toBe(1200);
		expect(engine.state?.tokensUsed).toBe(1200);
		expect(engine.state?.status).toBe("active");
	});

	it("endTurn respects token budget with addCoordinatorUsage", async () => {
		const { engine, pi, ctx } = makeEngine();
		engine.startState({
			commandName: "loop",
			programPath: "/fake.md",
			mission: "budget-coord test",
			maxRounds: 5,
			tokenBudget: 1000,
			noProgressTurns: 3,
		});
		engine.startTurn();
		await engine.endTurn(pi, ctx, {
			message: { usage: { totalTokens: 1000 } },
		});
		expect(engine.state?.status).toBe("budget_limited");
		expect(engine.state?.reason).toBe("tokens");
		expect(engine.state?.coordinatorUsage).toBe(1000);
	});

	it("endTurn with no usage leaves coordinatorUsage at 0", async () => {
		const { engine, pi, ctx } = makeEngine();
		engine.startState({
			commandName: "loop",
			programPath: "/fake.md",
			mission: "no-usage test",
			maxRounds: 5,
			tokenBudget: null,
			noProgressTurns: 3,
		});
		engine.startTurn();
		await engine.endTurn(pi, ctx, { message: { usage: {} } });
		expect(engine.state?.coordinatorUsage).toBe(0);
		expect(engine.state?.tokensUsed).toBe(0);
	});
});

// ---- F5: snapshotProgram integration ----

describe("LoopEngine — F5: programSnapshot prevents disk reread", () => {
	it("first getProgramBlock captures snapshot from disk", () => {
		const { engine, pi, ctx } = makeEngine();
		const programPath = path.resolve(
			__dirname,
			"../skills/research/program.md",
		);
		const realProgram = fs.readFileSync(programPath, "utf8");
		engine.startState({
			commandName: "loop",
			programPath,
			mission: "snapshot test",
			maxRounds: 5,
			tokenBudget: null,
			noProgressTurns: 3,
		});
		engine.state = { ...engine.state!, programInjected: false };
		(engine as never).getProgramBlock?.();
		expect(engine.state?.programSnapshot).toBeDefined();
		expect(engine.state?.programSnapshot).toContain("<program>");
		expect(engine.state?.programSnapshot).toContain("Research Program");
	});

	it("onAgentEnd uses snapshot for program block instead of reading disk", () => {
		const { engine, pi, ctx } = makeEngine();
		engine.startState({
			commandName: "loop",
			programPath: path.resolve(__dirname, "../skills/research/program.md"),
			mission: "queue-snapshot test",
			maxRounds: 5,
			tokenBudget: null,
			noProgressTurns: 3,
		});
		engine.state = {
			...engine.state!,
			programSnapshot: "<program>cached</program>",
		};
		engine.onAgentEnd(pi, ctx);
		const microtask = Promise.resolve();
		expect(engine.state?.programSnapshot).toBe("<program>cached</program>");
	});
});

describe("LoopEngine — onRoundIncrement callback", () => {
	it("calls onRoundIncrement after round is incremented", async () => {
		const onInc = vi.fn((s: LoopState) => ({ ...s, mission: "modified" }));
		const { engine, pi, ctx } = makeEngine();
		const actualEngine = new LoopEngine({
			completionPolicy: makePolicy(),
			onStateChange: async () => {},
			onRoundIncrement: onInc,
		});
		actualEngine.startState({
			commandName: "loop",
			programPath: "/fake.md",
			mission: "callback test",
			maxRounds: 2,
			tokenBudget: null,
			noProgressTurns: 3,
		});
		actualEngine.onAgentEnd(pi, ctx);
		await flushMicrotasks();
		expect(onInc).toHaveBeenCalled();
		expect(actualEngine.state?.mission).toBe("modified");
	});

	it("round is incremented before callback", async () => {
		const onInc = vi.fn((s: LoopState) => s); // identity — don't mutate state
		const { engine, pi, ctx } = makeEngine();
		const actualEngine = new LoopEngine({
			completionPolicy: makePolicy(),
			onStateChange: async () => {},
			onRoundIncrement: onInc,
		});
		actualEngine.startState({
			commandName: "loop",
			programPath: "/fake.md",
			mission: "increment-order test",
			maxRounds: 2,
			tokenBudget: null,
			noProgressTurns: 3,
		});
		actualEngine.onAgentEnd(pi, ctx);
		await flushMicrotasks();
		// Verify rounds was already incremented
		const calls = onInc.mock.calls;
		expect(calls).toHaveLength(1);
		const passedState = calls[0][0] as LoopState;
		expect(passedState.rounds).toBe(1);
	});
});

describe("LoopEngine — status line", () => {
	it("returns a readable line for active state", () => {
		const { engine, pi, ctx } = makeEngine();
		engine.startState({
			commandName: "loop",
			programPath: "/fake.md",
			mission: "status test",
			maxRounds: 5,
			tokenBudget: null,
			noProgressTurns: 3,
		});
		expect(engine.getStatusLine()).toContain("loop: active");
		expect(engine.getStatusLine()).toContain("1/5");
	});

	it("returns a readable line for complete state", () => {
		const { engine, pi, ctx } = makeEngine();
		engine.startState({
			commandName: "loop",
			programPath: "/fake.md",
			mission: "budget status test",
			maxRounds: 5,
			tokenBudget: null,
			noProgressTurns: 3,
		});
		engine.completeState();
		engine.persist(pi, ctx);
		expect(engine.getStatusLine()).toContain("loop: complete");
	});
});
