import { describe, it, expect, vi } from "vitest";
import { LoopEngine } from "../extensions/loop/engine.ts";
import type { LoopState } from "../extensions/loop/state.ts";
import type { CompletionPolicy } from "../extensions/loop/completion.ts";

function makePolicy(): CompletionPolicy {
	return {
		async audit() {
			return [];
		},
	};
}

function makeEngine() {
	const entries: Array<{ type: string; data: unknown }> = [];
	const activeTools: string[] = [];
	const pi = {
		appendEntry: vi.fn((type: string, data: unknown) => {
			entries.push({ type, data });
		}),
		getActiveTools: () => [...activeTools],
		setActiveTools: vi.fn((tools: string[]) => {
			activeTools.length = 0;
			activeTools.push(...tools);
		}),
		sendMessage: vi.fn((_msg: unknown, _opts?: unknown) => {}),
	};
	const ctx = {
		ui: { setStatus: vi.fn() },
		hasPendingMessages: () => false,
		isIdle: () => true,
		sessionManager: { getEntries: () => [] },
	};
	const engine = new LoopEngine({
		completionPolicy: makePolicy(),
		onStateChange: async (_state: LoopState) => {},
	});
	return { engine, pi, ctx, entries };
}

describe("LoopEngine.emit — first-iteration kickoff", () => {
	it("request a turn (triggerTurn=true) for the initial 'active' kind", () => {
		const { engine, pi, ctx } = makeEngine();
		engine.startState({
			commandName: "loop",
			programPath: "/fake.md",
			mission: "emit test",
			maxRounds: 5,
			tokenBudget: null,
			noProgressTurns: 3,
		});
		engine.emit(pi, "active", ctx.isIdle() ? "steer" : undefined);

		const calls = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls.length).toBe(1);
		const opts = calls[0][1] as { triggerTurn?: boolean };
		expect(opts.triggerTurn).toBe(true);
	});

	it("does not request a turn for 'paused' (steer-only) kind", () => {
		const { engine, pi } = makeEngine();
		engine.startState({
			commandName: "loop",
			programPath: "/fake.md",
			mission: "emit test",
			maxRounds: 5,
			tokenBudget: null,
			noProgressTurns: 3,
		});
		engine.emit(pi, "paused");

		const calls = (pi.sendMessage as ReturnType<typeof vi.fn>).mock.calls;
		expect(calls.length).toBe(1);
		const opts = calls[0][1] as { triggerTurn?: boolean };
		expect(opts.triggerTurn).toBeFalsy();
	});
});
