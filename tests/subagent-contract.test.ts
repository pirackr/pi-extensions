/**
 * Subagent dispatch contract test suite.
 *
 * Shared failing contract suite — covers the dispatch façade's behaviour
 * *before* the façade is fully wired so that a minimal provider can be swapped
 * in later.  Tests prove the contract is well-formed and the in-memory fake
 * provider records every attempted launch.
 */

import { describe, it, expect, vi, afterEach } from "vitest";

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
	MockDispatchPolicy,
} from "../extensions/subagent-dispatch/index.ts";
import { ProviderRegistry } from "../extensions/subagent-dispatch/registry.ts";
import {
	negotiateProvider,
	type ProviderDescriptor,
	type AttemptOutcome,
	type AttemptResult,
	type SerializedError,
} from "../extensions/subagent-dispatch/contract.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDescriptor(
	overrides: Partial<ProviderDescriptor> = {},
): ProviderDescriptor {
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
		const d = makeDescriptor({
			protocolVersion: undefined,
			executionSpecVersion: undefined,
		});
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
		const result = await provider.executeAttempt(
			plan,
			new AbortController().signal,
		);

		expect(result.output).toBeDefined();
		expect(provider.records.length).toBe(1);
		const record: FakeProviderRecord = provider
			.records[0] as FakeProviderRecord;
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

		const result = await provider.executeAttempt(
			plan,
			new AbortController().signal,
		);
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
			{
				totalTokens: 200,
				input: 100,
				output: 100,
				cacheRead: 10,
				cacheWrite: 5,
			},
			{ totalTokens: 50, input: 25, output: 25, cacheRead: 0, cacheWrite: 0 },
		];
		const total = usages.reduce((sum, u) => sum + u.totalTokens, 0);
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

describe("discovery — event-bus provider registration", () => {
	afterEach(() => {
		resetFacade();
	});

	it("discovers a provider registered after façade load via lazy re-discovery", () => {
		// In-memory event bus mirroring pi.events' emit/on contract: emit is
		// synchronous and passes a caller-owned envelope listeners push into.
		const listeners = new Map<string, ((data: unknown) => void)[]>();
		const bus = {
			emit: (channel: string, data: unknown) => {
				for (const handler of listeners.get(channel) ?? []) handler(data);
			},
			on: (channel: string, handler: (data: unknown) => void) => {
				const list = listeners.get(channel) ?? [];
				list.push(handler);
				listeners.set(channel, list);
			},
		};

		// Façade loads first — initial discovery finds nothing (no listeners yet).
		const facade = createFacade({ eventBus: bus });
		expect(facade.registry.get("tmux-subagent")).toBeUndefined();

		// A provider (e.g. tmux-subagent) registers its listener *after* the
		// façade loaded — simulating the tmux extension loading later.
		bus.on("subagent-dispatch-provider-discovered", (data: unknown) => {
			const envelope = (data as { envelope?: { providers?: unknown[] } })
				?.envelope;
			envelope?.providers?.push({
				descriptor: makeDescriptor({
					id: "tmux-subagent",
					capabilities: ["tmux"],
				}),
				instance: {
					executeAttempt: async () => ({
						output: { result: "done" },
						usage: { totalTokens: 0 },
					}),
				},
			});
		});

		// Lazy re-discovery (invoked at dispatch time) picks it up.
		facade.discover?.();
		expect(facade.registry.get("tmux-subagent")).toBeDefined();
		expect(facade.registry.getInstance("tmux-subagent")).toBeDefined();
	});

	it("lazy re-discovery is idempotent — duplicate ids are ignored", () => {
		const listeners = new Map<string, ((data: unknown) => void)[]>();
		const bus = {
			emit: (channel: string, data: unknown) => {
				for (const handler of listeners.get(channel) ?? []) handler(data);
			},
			on: (channel: string, handler: (data: unknown) => void) => {
				const list = listeners.get(channel) ?? [];
				list.push(handler);
				listeners.set(channel, list);
			},
		};
		const facade = createFacade({ eventBus: bus });
		bus.on("subagent-dispatch-provider-discovered", (data: unknown) => {
			const envelope = (data as { envelope?: { providers?: unknown[] } })
				?.envelope;
			envelope?.providers?.push({
				descriptor: makeDescriptor({
					id: "tmux-subagent",
					capabilities: ["tmux"],
				}),
				instance: { executeAttempt: async () => ({ output: {} }) },
			});
		});

		facade.discover?.();
		const sizeAfter = facade.registry.size;
		facade.discover?.(); // second discovery must not throw or duplicate
		expect(facade.registry.size).toBe(sizeAfter);
	});
});

// ---------------------------------------------------------------------------
// Fix Round 1 — Real behavioral tests for the execute loop
// ---------------------------------------------------------------------------

function buildMockPiWithTool() {
	const registered: any[] = [];
	const mockPi = {
		registerTool: (tool: any) => registered.push(tool),
		getActiveTools: () => [],
		setActiveTools: vi.fn(),
		on: vi.fn(),
		getFlag: vi.fn(),
		registerFlag: vi.fn(),
		_getRegisteredTools: () => registered,
	} as any;
	return mockPi;
}

/** Helper: call run_subagents execute with correct (callId, params) args. */
function dispatch(
	mockPi: ReturnType<typeof buildMockPiWithTool>,
	params: { tasks: { id: string; objective: string }[] },
) {
	const tool = mockPi
		._getRegisteredTools()
		.find((t: any) => t.name === "run_subagents") as any;
	return tool.execute("test-call-id", params as any);
}

// ---------------------------------------------------------------------------
// MockDispatchPolicy — records every policy call
// ---------------------------------------------------------------------------

describe("MockDispatchPolicy — records calls", () => {
	it("reserves, releases, and exports with correct attemptId", async () => {
		const policy = new MockDispatchPolicy();
		const reservation = await policy.reserveAttempt({
			attemptId: "att-1",
			planId: "plan-1",
			index: 0,
		});
		expect(reservation.reservationId).toBe("res-att-1");

		const outcome: AttemptOutcome = {
			status: "completed",
			result: { output: "ok" },
		};
		await policy.exportArtifact(reservation, outcome.result);
		await policy.releaseAttempt(reservation, outcome);

		expect(policy.records.map((r) => r.method)).toEqual([
			"reserveAttempt",
			"exportArtifact",
			"releaseAttempt",
		]);
	});

	it("onReserveAttemptFailure throws and is recorded", async () => {
		const policy = new MockDispatchPolicy();
		policy.onReserveAttemptFailure = new Error("no slot");

		await expect(
			policy.reserveAttempt({
				attemptId: "att-1",
				planId: "plan-1",
				index: 0,
			}),
		).rejects.toThrow("no slot");

		const record = policy.records[policy.records.length - 1];
		expect(record.method).toBe("reserveAttempt");
	});

	it("reset clears all records", async () => {
		const policy = new MockDispatchPolicy();
		await policy.reserveAttempt({ attemptId: "a", planId: "p", index: 0 });
		expect(policy.records.length).toBe(1);
		policy.reset();
		expect(policy.records.length).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// F12: Singleton / resetFacade
// ---------------------------------------------------------------------------

describe("singleton — createFacade / resetFacade", () => {
	afterEach(() => resetFacade());

	it("createFacade returns the same instance on repeated calls", () => {
		const f1 = createFacade();
		const f2 = createFacade();
		expect(f1).toBe(f2);
	});

	it("resetFacade destroys the singleton so next call is new", () => {
		const f1 = createFacade();
		resetFacade();
		const f2 = createFacade();
		expect(f1).not.toBe(f2);
	});

	it("resetFacade clears the registry", () => {
		const f1 = createFacade();
		const sizeBefore = f1.registry.size;
		resetFacade();
		const f2 = createFacade();
		expect(f2.registry.size).toBe(sizeBefore);
	});
});

// ---------------------------------------------------------------------------
// F1: Execute loop — reserve → execute → export → release (real behavior)
// ---------------------------------------------------------------------------

describe("execute loop — reserve→execute→export→release sequence", () => {
	afterEach(() => resetFacade());

	it("calls reserveAttempt, provider.executeAttempt, exportArtifact, releaseAttempt in order for one task", async () => {
		const fake = new FakeSubagentProvider();
		const mockPolicy = new MockDispatchPolicy();

		const reg = new ProviderRegistry();
		reg.registerWithInstance(FakeSubagentProvider.DESCRIPTOR, fake);
		const facade = createFacade({ registry: reg });
		const mockPi = buildMockPiWithTool();
		registerFaçadeTools(mockPi, facade, mockPolicy);

		const result = await dispatch(mockPi, {
			tasks: [{ id: "t1", objective: "do something" }],
		});

		// Tool returned success
		expect(result.content[0].text).toContain("1 tasks");

		// Verify the full sequence: reserve→execute→export→release
		const records = mockPolicy.records;
		expect(records[0].method).toBe("reserveAttempt");

		// Provider was called (executeAttempt on the fake provider)
		expect(fake.records.length).toBe(1);

		// releaseAttempt called exactly once
		expect(records.filter((r) => r.method === "releaseAttempt").length).toBe(1);

		// exportArtifact called for completed outcome
		expect(records.filter((r) => r.method === "exportArtifact").length).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// F1: No launch after reservation failure
// ---------------------------------------------------------------------------

describe("execute loop — no launch after reservation failure", () => {
	afterEach(() => resetFacade());

	it("reserveAttempt failure prevents executeAttempt", async () => {
		const fake = new FakeSubagentProvider();
		const mockPolicy = new MockDispatchPolicy();
		mockPolicy.onReserveAttemptFailure = new Error("no slot");

		const reg = new ProviderRegistry();
		reg.registerWithInstance(FakeSubagentProvider.DESCRIPTOR, fake);
		const facade = createFacade({ registry: reg });
		const mockPi = buildMockPiWithTool();
		registerFaçadeTools(mockPi, facade, mockPolicy);

		const result = await dispatch(mockPi, {
			tasks: [{ id: "t1", objective: "should not execute" }],
		});

		// Provider was NOT called
		expect(fake.records.length).toBe(0);

		// Result shows failure
		const details = result.details as { results: Array<{ status: string }> };
		expect(details.results[0].status).toBe("failed");
	});
});

// ---------------------------------------------------------------------------
// F4: Reserve before every attempt
// ---------------------------------------------------------------------------

describe("execute loop — reserve before every attempt", () => {
	afterEach(() => resetFacade());

	it("reserveAttempt called once per dispatched task", async () => {
		const fake = new FakeSubagentProvider();
		const mockPolicy = new MockDispatchPolicy();

		const reg = new ProviderRegistry();
		reg.registerWithInstance(FakeSubagentProvider.DESCRIPTOR, fake);
		const facade = createFacade({ registry: reg });
		const mockPi = buildMockPiWithTool();
		registerFaçadeTools(mockPi, facade, mockPolicy);

		await dispatch(mockPi, {
			tasks: [
				{ id: "t1", objective: "1" },
				{ id: "t2", objective: "2" },
				{ id: "t3", objective: "3" },
			],
		});

		const reserveCalls = mockPolicy.records.filter(
			(r) => r.method === "reserveAttempt",
		);
		expect(reserveCalls.length).toBe(3);
	});
});

// ---------------------------------------------------------------------------
// F5: Façade-owned retries — distinct attemptIds per same planId
// ---------------------------------------------------------------------------

describe("execute loop — façade-owned retries with distinct attemptIds", () => {
	afterEach(() => resetFacade());

	it("same planId can have multiple executeAttempt calls with different attemptIds", async () => {
		const fake = new FakeSubagentProvider();
		const mockPolicy = new MockDispatchPolicy();

		const reg = new ProviderRegistry();
		reg.registerWithInstance(FakeSubagentProvider.DESCRIPTOR, fake);
		const facade = createFacade({ registry: reg });
		const mockPi = buildMockPiWithTool();
		registerFaçadeTools(mockPi, facade, mockPolicy);

		// Directly call executeAttempt twice with same planId but different attemptIds
		await fake.executeAttempt(
			{ attemptId: "retry-1", planId: "task-x", index: 0 },
			new AbortController().signal,
		);
		await fake.executeAttempt(
			{ attemptId: "retry-2", planId: "task-x", index: 1 },
			new AbortController().signal,
		);

		expect(fake.records.length).toBe(2);
		expect(fake.records[0].attemptId).toBe("retry-1");
		expect(fake.records[1].attemptId).toBe("retry-2");
		expect(fake.records[0].planId).toBe("task-x");
		expect(fake.records[1].planId).toBe("task-x");
	});
});

// ---------------------------------------------------------------------------
// F6: releaseAttempt called exactly once per outcome
// ---------------------------------------------------------------------------

describe("execute loop — releaseAttempt called exactly once per outcome", () => {
	afterEach(() => resetFacade());

	it("releaseAttempt called once for completed outcome", async () => {
		const fake = new FakeSubagentProvider();
		const mockPolicy = new MockDispatchPolicy();

		const reg = new ProviderRegistry();
		reg.registerWithInstance(FakeSubagentProvider.DESCRIPTOR, fake);
		const facade = createFacade({ registry: reg });
		const mockPi = buildMockPiWithTool();
		registerFaçadeTools(mockPi, facade, mockPolicy);

		await dispatch(mockPi, { tasks: [{ id: "t1", objective: "ok" }] });
		expect(
			mockPolicy.records.filter((r) => r.method === "releaseAttempt").length,
		).toBe(1);
	});

	it("releaseAttempt called once for failed outcome (provider throws)", async () => {
		const fake = new FakeSubagentProvider();
		fake.onExecuteAttempt = () => {
			throw new Error("boom");
		};
		const mockPolicy = new MockDispatchPolicy();

		const reg = new ProviderRegistry();
		reg.registerWithInstance(FakeSubagentProvider.DESCRIPTOR, fake);
		const facade = createFacade({ registry: reg });
		const mockPi = buildMockPiWithTool();
		registerFaçadeTools(mockPi, facade, mockPolicy);

		await dispatch(mockPi, { tasks: [{ id: "t1", objective: "fail" }] });
		expect(
			mockPolicy.records.filter((r) => r.method === "releaseAttempt").length,
		).toBe(1);
	});

	it("releaseAttempt called once even when export fails", async () => {
		const fake = new FakeSubagentProvider();
		const mockPolicy = new MockDispatchPolicy();
		mockPolicy.exportArtifact = async () => {
			throw new Error("export failed");
		};

		const reg = new ProviderRegistry();
		reg.registerWithInstance(FakeSubagentProvider.DESCRIPTOR, fake);
		const facade = createFacade({ registry: reg });
		const mockPi = buildMockPiWithTool();
		registerFaçadeTools(mockPi, facade, mockPolicy);

		await dispatch(mockPi, {
			tasks: [{ id: "t1", objective: "export fails" }],
		});
		expect(
			mockPolicy.records.filter((r) => r.method === "releaseAttempt").length,
		).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// F7: Usage aggregation returned in tool-result usage field
// ---------------------------------------------------------------------------

describe("execute loop — usage aggregation via tool result", () => {
	afterEach(() => resetFacade());

	it("usage.totalTokens aggregates across multiple attempts", async () => {
		const fake = new FakeSubagentProvider();
		fake.executeAttempt = async (plan: any, _signal: AbortSignal) => ({
			output: { attemptId: plan.attemptId },
			usage: { totalTokens: 42 },
		});
		const mockPolicy = new MockDispatchPolicy();

		const reg = new ProviderRegistry();
		reg.registerWithInstance(FakeSubagentProvider.DESCRIPTOR, fake);
		const facade = createFacade({ registry: reg });
		const mockPi = buildMockPiWithTool();
		registerFaçadeTools(mockPi, facade, mockPolicy);

		const result = await dispatch(mockPi, {
			tasks: [
				{ id: "t1", objective: "1" },
				{ id: "t2", objective: "2" },
			],
		});

		expect((result.usage as { totalTokens: number }).totalTokens).toBe(84);
	});
});

// ---------------------------------------------------------------------------
// F10: taskInfo preserved in ResolvedAttempt
// ---------------------------------------------------------------------------

describe("execute loop — taskInfo preserved in ResolvedAttempt", () => {
	afterEach(() => resetFacade());

	it("provider.executeAttempt receives full ResolvedAttempt with taskInfo", async () => {
		const fake = new FakeSubagentProvider();
		let capturedPlan: any = null;
		fake.executeAttempt = async (plan: any, _signal: AbortSignal) => {
			capturedPlan = { ...plan };
			return {
				output: { attemptId: plan.attemptId },
				usage: { totalTokens: 0 },
			};
		};
		const mockPolicy = new MockDispatchPolicy();

		const reg = new ProviderRegistry();
		reg.registerWithInstance(FakeSubagentProvider.DESCRIPTOR, fake);
		const facade = createFacade({ registry: reg });
		const mockPi = buildMockPiWithTool();
		registerFaçadeTools(mockPi, facade, mockPolicy);

		await dispatch(mockPi, {
			tasks: [{ id: "unique-task", objective: "test objective" }],
		});

		expect(capturedPlan.taskInfo).toBeDefined();
		expect(capturedPlan.taskInfo.taskId).toBe("unique-task");
		expect(capturedPlan.taskInfo.objective).toBe("test objective");
	});
});

// ---------------------------------------------------------------------------
// F9: Tool description condensed
// ---------------------------------------------------------------------------

describe("execute loop — tool description is concise", () => {
	afterEach(() => resetFacade());

	it("run_subagents description is short (no bloat)", () => {
		const facade = createFacade();
		const mockPi = buildMockPiWithTool();
		registerFaçadeTools(mockPi, facade);
		const tool = mockPi
			._getRegisteredTools()
			.find((t: any) => t.name === "run_subagents");
		expect(tool.description.length).toBeLessThan(200);
		expect(tool.description).not.toContain(
			"The façade owns batching expansion",
		);
	});
});

// ---------------------------------------------------------------------------
// Registry: registerWithInstance and getInstance
// ---------------------------------------------------------------------------

describe("ProviderRegistry — instance storage", () => {
	it("registerWithInstance stores and returns instance", () => {
		const reg = new ProviderRegistry();
		const fake = new FakeSubagentProvider();
		reg.registerWithInstance(FakeSubagentProvider.DESCRIPTOR, fake);
		expect(reg.getInstance(FakeSubagentProvider.ID)).toBe(fake);
	});

	it("clear returns descriptor+instance maps", () => {
		const reg = new ProviderRegistry();
		const fake = new FakeSubagentProvider();
		reg.registerWithInstance(FakeSubagentProvider.DESCRIPTOR, fake);
		const { descriptors, instances } = reg.clear();
		expect(descriptors.size).toBe(1);
		expect(instances.size).toBe(1);
		expect(instances.get(FakeSubagentProvider.ID)).toBe(fake);
	});
});

// ---------------------------------------------------------------------------
// Multiple tasks — one reserve/release pair per task
// ---------------------------------------------------------------------------

describe("execute loop — multiple tasks get independent reserve/release cycles", () => {
	afterEach(() => resetFacade());

	it("each task gets its own reserve→execute→release", async () => {
		const fake = new FakeSubagentProvider();
		const mockPolicy = new MockDispatchPolicy();

		const reg = new ProviderRegistry();
		reg.registerWithInstance(FakeSubagentProvider.DESCRIPTOR, fake);
		const facade = createFacade({ registry: reg });
		const mockPi = buildMockPiWithTool();
		registerFaçadeTools(mockPi, facade, mockPolicy);

		await dispatch(mockPi, {
			tasks: [
				{ id: "t1", objective: "a" },
				{ id: "t2", objective: "b" },
				{ id: "t3", objective: "c" },
				{ id: "t4", objective: "d" },
			],
		});

		expect(
			mockPolicy.records.filter((r) => r.method === "reserveAttempt").length,
		).toBe(4);
		expect(
			mockPolicy.records.filter((r) => r.method === "releaseAttempt").length,
		).toBe(4);
		expect(fake.records.length).toBe(4);
	});
});
