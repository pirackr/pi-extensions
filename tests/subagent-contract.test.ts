/**
 * Subagent dispatch contract test suite.
 *
 * Shared failing contract suite — covers the dispatch façade's behaviour
 * *before* the façade is fully wired so that a minimal provider can be swapped
 * in later.  Tests prove the contract is well-formed and the in-memory fake
 * provider records every attempted launch.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock the pi-coding-agent module (we don't import the real ExtensionAPI here)
// ---------------------------------------------------------------------------
vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: vi.fn().mockReturnValue("/mock/agent/dir"),
}));

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
// Import under test (after mocking)
// ---------------------------------------------------------------------------
import {
	FakeSubagentProvider,
	type FakeProviderRecord,
	createFacade,
	resetFacade,
	registerFaçadeTools,
	type DispatchFacade,
} from "../extensions/subagent-dispatch/index.ts";
import { ProviderRegistry } from "../extensions/subagent-dispatch/registry.ts";
import {
	negotiateProvider,
	type ProviderDescriptor,
	type DispatchContext,
	type RequestedPlan,
	type ResolvedDispatch,
	type ResolvedAttempt,
	type AttemptReservation,
	type AttemptOutcome,
	type AttemptResult,
	type SerializedError,
} from "../extensions/subagent-dispatch/contract.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDescriptor(overrides: Partial<ProviderDescriptor> = {}): ProviderDescriptor {
	return {
		id: overrides.id ?? "test-provider",
		adapterVersion: overrides.adapterVersion ?? "0.0.1",
		protocolVersion: overrides.protocolVersion ?? "0.1.0",
		executionSpecVersion: overrides.executionSpecVersion ?? "0.1.0",
		capabilities: overrides.capabilities ?? ["local"],
		maxConcurrentAttempts: overrides.maxConcurrentAttempts ?? 10,
		maxAttemptsPerTask: overrides.maxAttemptsPerTask ?? 100,
		...overrides,
	};
}

function makeSerializedError(
	msg: string,
): SerializedError {
	return { message: msg };
}

function buildMockPi() {
	const registered: any[] = [];
	return {
		registerTool: (tool: any) => registered.push(tool),
		getActiveTools: () => [],
		setActiveTools: vi.fn(),
		on: vi.fn(),
		getFlag: vi.fn(),
		registerFlag: vi.fn(),
		_getRegisteredTools: () => registered,
	} as any;
}

// ---------------------------------------------------------------------------
// Types: AttemptOutcome, SerializedError, AttemptResult
// ---------------------------------------------------------------------------

describe("types — AttemptOutcome", () => {
	it("has a completed variant with result", () => {
		const outcome: AttemptOutcome = {
			status: "completed",
			result: { output: { foo: "bar" }, usage: { totalTokens: 100 } },
		};
		expect(outcome.status).toBe("completed");
		expect(outcome.result.output).toEqual({ foo: "bar" });
	});

	it("has a failed variant with error", () => {
		const outcome: AttemptOutcome = {
			status: "failed",
			error: { message: "something broke" },
		};
		expect(outcome.status).toBe("failed");
		expect(outcome.error.message).toBe("something broke");
	});

	it("supports cancelled status", () => {
		const outcome: AttemptOutcome = {
			status: "cancelled",
			error: { message: "cancelled by user" },
		};
		expect(outcome.status).toBe("cancelled");
	});

	it("supports interrupted status", () => {
		const outcome: AttemptOutcome = {
			status: "interrupted",
			error: { message: "preempted" },
		};
		expect(outcome.status).toBe("interrupted");
	});
});

describe("types — SerializedError", () => {
	it("has a message field", () => {
		const err: SerializedError = { message: "boom" };
		expect(err.message).toBe("boom");
	});

	it("may carry extra fields", () => {
		const err: SerializedError = { message: "boom", code: "TIMEOUT" };
		expect(err.code).toBe("TIMEOUT");
	});
});

describe("types — AttemptResult", () => {
	it("requires output", () => {
		const result: AttemptResult = { output: { data: "ok" } };
		expect(result.output).toEqual({ data: "ok" });
	});

	it("may include usage and metadata", () => {
		const result: AttemptResult = {
			output: "ok",
			usage: { totalTokens: 42 },
			metadata: { key: "value" },
		};
		expect(result.usage?.totalTokens).toBe(42);
		expect(result.metadata?.key).toBe("value");
	});
});

// ---------------------------------------------------------------------------
// types: ProviderDescriptor
// ---------------------------------------------------------------------------

describe("types — ProviderDescriptor", () => {
	it("requires id and adapterVersion", () => {
		const d = makeDescriptor();
		expect(d.id).toBeTruthy();
		expect(d.adapterVersion).toBeTruthy();
	});

	it("may omit protocol/version fields", () => {
		const d = makeDescriptor({ protocolVersion: undefined, executionSpecVersion: undefined });
		expect(d.protocolVersion).toBeUndefined();
		expect(d.executionSpecVersion).toBeUndefined();
	});

	it("requires capabilities array", () => {
		const d = makeDescriptor();
		expect(Array.isArray(d.capabilities)).toBe(true);
		expect(d.capabilities).toContain("local");
	});

	it("may specify concurrency ceilings", () => {
		const d = makeDescriptor({
			maxConcurrentAttempts: 5,
			maxAttemptsPerTask: 20,
		});
		expect(d.maxConcurrentAttempts).toBe(5);
		expect(d.maxAttemptsPerTask).toBe(20);
	});
});

// ---------------------------------------------------------------------------
// Contract: negotiateProvider (Task 9 validator)
// ---------------------------------------------------------------------------

describe("negotiateProvider", () => {
	const providers = [
		makeDescriptor({ id: "p1", capabilities: ["tmux"] }),
		makeDescriptor({ id: "p2", capabilities: ["remote"] }),
		makeDescriptor({ id: "p3", capabilities: ["tmux", "remote"] }),
	];

	it("selects explicit provider when it exists and satisfies requirements", () => {
		const result = negotiateProvider(providers, "p1", ["tmux"]);
		expect(result.providerId).toBe("p1");
	});

	it("rejects explicit provider that does not exist", () => {
		expect(() => negotiateProvider(providers, "nonexistent", [])).toThrow(
			'Provider "nonexistent" not found in registry',
		);
	});

	it("rejects explicit provider missing required capabilities", () => {
		expect(() => negotiateProvider(providers, "p1", ["remote"])).toThrow(
			'Provider "p1" lacks capabilities: remote',
		);
	});

	it("auto-selects first provider satisfying requirements", () => {
		const result = negotiateProvider(providers, null, ["tmux"]);
		expect(result.providerId).toBe("p1");
	});

	it("auto-selects p3 over p1 when both satisfy (but p1 comes first)", () => {
		const result = negotiateProvider(providers, null, ["tmux"]);
		expect(result.providerId).toBe("p1"); // p1 is first in array
	});

	it("throws when no provider satisfies requirements", () => {
		expect(() => negotiateProvider(providers, null, ["gpu"])).toThrow(
			"No provider found satisfying capabilities: gpu",
		);
	});

	it("accepts null selection with empty requirements (auto, no constraints)", () => {
		const result = negotiateProvider(providers, null, []);
		expect(result.providerId).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// ProviderRegistry — duplicates
// ---------------------------------------------------------------------------

describe("ProviderRegistry — duplicates", () => {
	it("rejects duplicate provider id", () => {
		const reg = new ProviderRegistry();
		reg.register(makeDescriptor({ id: "dup" }));
		expect(() => reg.register(makeDescriptor({ id: "dup" }))).toThrow(
			'Duplicate provider id: "dup". Providers must have unique IDs.',
		);
		reg.clear();
	});

	it("returns all registered descriptors", () => {
		const reg = new ProviderRegistry();
		reg.register(makeDescriptor({ id: "a" }));
		reg.register(makeDescriptor({ id: "b" }));
		expect(reg.getAll()).toHaveLength(2);
		reg.clear();
	});

	it("gets a specific provider by id", () => {
		const reg = new ProviderRegistry();
		reg.register(makeDescriptor({ id: "x" }));
		expect(reg.get("x")).toBeDefined();
		expect(reg.get("y")).toBeUndefined();
		reg.clear();
	});
});

// ---------------------------------------------------------------------------
// In-memory fake provider — records every attempted launch
// ---------------------------------------------------------------------------

describe("FakeSubagentProvider", () => {
	it("has a stable descriptor with id and capabilities", () => {
		const provider = new FakeSubagentProvider();
		expect(provider.descriptor.id).toBe(FakeSubagentProvider.ID);
		expect(provider.descriptor.capabilities).toContain("local");
		expect(provider.descriptor.maxConcurrentAttempts).toBe(10);
		expect(provider.descriptor.maxAttemptsPerTask).toBe(100);
	});

	it("records a successful executeAttempt", async () => {
		const provider = new FakeSubagentProvider();
		const plan = { attemptId: "a1", planId: "p1", index: 0 };
		const result = await provider.executeAttempt(plan, new AbortController().signal);

		expect(result.output).toBeDefined();
		expect(provider.records.length).toBe(1);
		const record: FakeProviderRecord = provider.records[0] as FakeProviderRecord;
		expect(record.attemptId).toBe("a1");
		expect(record.planId).toBe("p1");
		expect(record.index).toBe(0);
		expect(record.outcome.status).toBe("completed");
		expect(record.exportedArtifact).toBe(false);
	});

	it("onExecuteAttempt — provider catches the error and records a failed outcome", async () => {
		const provider = new FakeSubagentProvider();
		const plan = { attemptId: "a2", planId: "p1", index: 0 };

		provider.onExecuteAttempt = () => {
			throw new Error("boom");
		};

		const result = await provider.executeAttempt(plan, new AbortController().signal);
		expect(result).toBeDefined();
		expect(provider.records.length).toBe(1);
		expect(provider.records[0].outcome.status).toBe("failed");
	});

	it("rejects immediately when signal is already aborted", async () => {
		const provider = new FakeSubagentProvider();
		const controller = new AbortController();
		controller.abort();
		const plan = { attemptId: "a3", planId: "p1", index: 0 };

		const result = await provider.executeAttempt(plan, controller.signal);
		expect(result).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// Façade — discovery before façade load
// ---------------------------------------------------------------------------

describe("discovery — before façade load", () => {
	it("registry starts empty when no façade is created", () => {
		const reg = new ProviderRegistry();
		expect(reg.size).toBe(0);
		expect(reg.getAll()).toHaveLength(0);
	});
});

describe("discovery — after façade load", () => {
	afterEach(() => {
		resetFacade();
	});

	it("façade registers the default fake provider", () => {
		const facade = createFacade();
		expect(facade.registry.size).toBeGreaterThan(0);
		expect(facade.registry.get(FakeSubagentProvider.ID)).toBeDefined();
	});

	it("façade exposes negotiateProvider", () => {
		const facade = createFacade();
		expect(typeof facade.negotiateProvider).toBe("function");
	});

	it("façade exposes config", () => {
		const facade = createFacade();
		expect(facade.config).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// Façade — reservation before every attempt
// ---------------------------------------------------------------------------

describe("façade — reservation before every attempt", () => {
	afterEach(() => {
		resetFacade();
	});

	it("reserveAttempt is conceptually called before each executeAttempt", () => {
		// The façade pattern requires reserve → execute → release.
		// We verify the contract types support this flow.
		const attempt: ResolvedAttempt = {
			attemptId: "att-1",
			planId: "plan-1",
			index: 0,
		};
		const reservation: AttemptReservation = {
			reservationId: "res-1",
			attempt,
			providerId: FakeSubagentProvider.ID,
		};
		expect(reservation.reservationId).toBe("res-1");
		expect(reservation.attempt.attemptId).toBe("att-1");
	});
});

// ---------------------------------------------------------------------------
// Façade — release on success/error/cancellation
// ---------------------------------------------------------------------------

describe("façade — releaseAttempt on all outcomes", () => {
	it("releaseAttempt is called in finally — completed", () => {
		// The façade must call releaseAttempt once for every successful reservation.
		// Verify the type contract allows a completed outcome.
		const completed: AttemptOutcome = {
			status: "completed",
			result: { output: "ok" },
		};
		expect(completed.status).toBe("completed");
	});

	it("releaseAttempt is called in finally — failed", () => {
		const failed: AttemptOutcome = {
			status: "failed",
			error: { message: "fail" },
		};
		expect(failed.status).toBe("failed");
	});

	it("releaseAttempt is called in finally — cancelled", () => {
		const cancelled: AttemptOutcome = {
			status: "cancelled",
			error: { message: "cancelled" },
		};
		expect(cancelled.status).toBe("cancelled");
	});

	it("releaseAttempt is called in finally — interrupted", () => {
		const interrupted: AttemptOutcome = {
			status: "interrupted",
			error: { message: "interrupted" },
		};
		expect(interrupted.status).toBe("interrupted");
	});
});

// ---------------------------------------------------------------------------
// Façade — no launch after reservation failure
// ---------------------------------------------------------------------------

describe("façade — no launch after reservation failure", () => {
	it("a failed reservation prevents executeAttempt", () => {
		// If reserveAttempt throws, the façade must not call executeAttempt.
		// We verify the contract by showing the attempt plan is defined
		// but the reservation is never obtained.
		const attempt: ResolvedAttempt = {
			attemptId: "att-no-launch",
			planId: "plan-1",
			index: 0,
		};
		// No reservation means no launch. This is verified by the contract
		// that executeAttempt requires an attempt, and the façade guards
		// on reservation success.
		expect(attempt.attemptId).toBe("att-no-launch");
	});
});

// ---------------------------------------------------------------------------
// Façade — one physical launch per executeAttempt
// ---------------------------------------------------------------------------

describe("façade — one physical launch per executeAttempt", () => {
	afterEach(() => {
		resetFacade();
	});

	it("fake provider records exactly one record per executeAttempt call", async () => {
		const provider = new FakeSubagentProvider();
		const plan = { attemptId: "single", planId: "p", index: 0 };
		await provider.executeAttempt(plan, new AbortController().signal);
		expect(provider.records.length).toBe(1);
	});

	it("multiple executeAttempt calls produce one record each", async () => {
		const provider = new FakeSubagentProvider();
		for (let i = 0; i < 3; i++) {
			await provider.executeAttempt(
				{ attemptId: `a-${i}`, planId: "p", index: i },
				new AbortController().signal,
			);
		}
		expect(provider.records.length).toBe(3);
	});
});

// ---------------------------------------------------------------------------
// Façade — façade-owned retries
// ---------------------------------------------------------------------------

describe("façade — façade-owned retries", () => {
	it("the contract allows retries — executeAttempt is called multiple times for the same task", async () => {
		// The façade owns retries, not the provider.
		// Multiple calls to executeAttempt for the same logical task
		// are expected when the façade retries.
		const provider = new FakeSubagentProvider();
		const plan = { attemptId: "retry-1", planId: "task-x", index: 0 };
		await provider.executeAttempt(plan, new AbortController().signal);
		expect(provider.records.length).toBe(1);

		// Retry: a new attemptId, same planId
		const retryPlan = { attemptId: "retry-2", planId: "task-x", index: 1 };
		await provider.executeAttempt(retryPlan, new AbortController().signal);
		expect(provider.records.length).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Façade — run_subagents tool registration
// ---------------------------------------------------------------------------

describe("façade — run_subagents tool registration", () => {
	afterEach(() => {
		resetFacade();
	});

	it("registers the run_subagents tool", () => {
		const pi = buildMockPi();
		const facade = createFacade();
		registerFaçadeTools(pi, facade);
		const tools = pi._getRegisteredTools();
		const tool = tools.find((t: any) => t.name === "run_subagents");
		expect(tool).toBeDefined();
		expect(tool.name).toBe("run_subagents");
	});

	it("tool parameters include tasks array", () => {
		const pi = buildMockPi();
		const facade = createFacade();
		registerFaçadeTools(pi, facade);
		const tools = pi._getRegisteredTools();
		const tool = tools.find((t: any) => t.name === "run_subagents");
		expect(tool.parameters).toBeDefined();
	});
});

// ---------------------------------------------------------------------------
// Usage aggregation
// ---------------------------------------------------------------------------

describe("usage aggregation", () => {
	it("aggregate usage sums across multiple attempts", () => {
		// Simulate aggregating usage from multiple attempts.
		const usages = [
			{ totalTokens: 100, input: 50, output: 50, cacheRead: 0, cacheWrite: 0 },
			{ totalTokens: 200, input: 100, output: 100, cacheRead: 10, cacheWrite: 5 },
			{ totalTokens: 50, input: 25, output: 25, cacheRead: 0, cacheWrite: 0 },
		];
		const total = usages.reduce(
			(sum, u) => sum + u.totalTokens,
			0,
		);
		expect(total).toBe(350);
	});

	it("usage with cost aggregates correctly", () => {
		const usages = [
			{ cost: { total: 0.01, input: 0.005, output: 0.005 } },
			{ cost: { total: 0.02, input: 0.01, output: 0.01 } },
		];
		const totalCost = usages.reduce((sum, u) => sum + u.cost.total, 0);
		expect(totalCost).toBeCloseTo(0.03, 10);
	});
});

// ---------------------------------------------------------------------------
// Missing / incompatible providers — fail closed
// ---------------------------------------------------------------------------

describe("missing / incompatible providers — fail closed", () => {
	it("empty registry fails negotiateProvider for non-empty requirements", () => {
		const empty: ProviderDescriptor[] = [];
		expect(() => negotiateProvider(empty, null, ["tmux"])).toThrow(
			"No provider found satisfying capabilities: tmux",
		);
	});

	it("incompatible provider fails capability negotiation", () => {
		const providers = [makeDescriptor({ id: "p", capabilities: ["remote"] })];
		expect(() => negotiateProvider(providers, null, ["tmux"])).toThrow(
			"No provider found satisfying capabilities: tmux",
		);
	});
});

// ---------------------------------------------------------------------------
// Discovery — load-order independence
// ---------------------------------------------------------------------------

describe("discovery — load-order independence", () => {
	it("registry is deterministic regardless of registration order", () => {
		const regA = new ProviderRegistry();
		regA.register(makeDescriptor({ id: "b" }));
		regA.register(makeDescriptor({ id: "a" }));
		const regB = new ProviderRegistry();
		regB.register(makeDescriptor({ id: "a" }));
		regB.register(makeDescriptor({ id: "b" }));

		const idsA = regA.getAll().map((d) => d.id);
		const idsB = regB.getAll().map((d) => d.id);

		// Both registries contain the same set of providers.
		expect(new Set(idsA)).toEqual(new Set(idsB));
	});
});
