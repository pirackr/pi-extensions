import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createSubagentManager,
	type ManagerCallContext,
	type ManagerResolvedCall,
	type SubagentManager,
	type SubagentManagerDeps,
} from "../manager.ts";
import { createArtifactStore, type ArtifactStore } from "../storage.ts";
import type { ManagerLease } from "../locks.ts";
import type { Scheduler, SchedulerDeps } from "../scheduler.ts";
import type { TmuxClient } from "../tmux.ts";
import type {
	AgentManifest,
	AgentRequest,
	ProfilePolicyAdapter,
	ResolvedProfile,
	TerminalResult,
} from "../types.ts";

const roots: string[] = [];

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const PROFILE: ResolvedProfile = {
	name: "general",
	description: "General worker",
	model: "provider/model",
	thinking: "medium",
	tools: ["read", "bash"],
	access: "write",
	timeoutSeconds: 90,
	systemPrompt: "Work carefully.",
	source: "/profiles/general.md",
};

const REQUEST: AgentRequest = {
	description: "Inspect queue",
	prompt: "Inspect the durable queue and report findings.",
	subagent_type: "general",
	run_in_background: true,
};

const CALL_CONTEXT: ManagerCallContext = {
	cwd: "/workspace/project",
	origin: "conversation-123",
	groupId: "turn-1-nonce",
};

const CONFIG: ManagerResolvedCall["config"] = {
	models: {},
	childExtensions: ["/extensions/subagent/index.ts"],
	toolAccess: { read: "read", bash: "write" },
	agentDirs: [],
	loadContextFiles: false,
	defaultTimeoutSeconds: 120,
	webSearchMaxLookups: 7,
	webSearchMaxFetches: 3,
	maxConcurrent: 2,
	notificationGroupWaitSeconds: 30,
	soloPreviewCharacters: 500,
	groupPreviewCharacters: 300,
};

function usage() {
	return { totalTokens: 3, toolUses: 4, durationMs: 500 };
}

function result(agentId: string, state: TerminalResult["state"] = "succeeded"): TerminalResult {
	return {
		agentId,
		state,
		output: state === "succeeded" ? "complete output" : "",
		usage: usage(),
		finishedAt: 2_000,
		terminalReason: state === "succeeded" ? null : "startup failed",
	};
}

function manifest(agentId: string, overrides: Partial<AgentManifest> = {}): AgentManifest {
	return {
		schema: 1,
		generation: `generation-${agentId}`,
		revision: 1,
		parentId: "p001",
		agentId,
		parentAgentId: null,
		ownershipTreeId: agentId,
		origin: "conversation-123",
		groupId: null,
		description: "Existing task",
		prompt: "Existing prompt",
		profile: PROFILE,
		state: "queued",
		sequence: 1,
		queuedAt: 1_000,
		startedAt: null,
		heartbeatAt: null,
		finishedAt: null,
		runnerPid: null,
		processStart: "",
		tmuxSession: null,
		tmuxWindow: null,
		timeoutSeconds: 90,
		terminalReason: null,
		...overrides,
	};
}

function runnerRequest(agentId: string): Record<string, unknown> {
	return {
		schema: 1,
		parentId: "p001",
		agentId,
		parentAgentId: null,
		origin: "conversation-123",
		groupId: null,
		sequence: 1,
		queuedAt: 1_000,
		description: "Existing task",
		prompt: "Existing prompt",
		artifactRoot: "/tmp/artifacts",
		cwd: "/workspace/project",
		profile: PROFILE,
		pi: { command: "pi", args: ["--mode", "rpc"] },
		childExtensions: [],
		loadContextFiles: false,
		webSearchMaxLookups: 0,
		webSearchMaxFetches: 0,
	};
}

interface HarnessOptions {
	mode?: "manager" | "nested-producer";
	currentAgentId?: string;
	onPump?: (deps: SchedulerDeps) => Promise<void>;
	onSleep?: (store: ArtifactStore, signal: AbortSignal) => Promise<void>;
	tmuxFailure?: Error;
	leaseFailure?: Error;
	resolved?: ManagerResolvedCall | readonly ManagerResolvedCall[];
	store?: ArtifactStore;
}

async function createHarness(options: HarnessOptions = {}): Promise<{
	manager: SubagentManager;
	store: ArtifactStore;
	tmux: TmuxClient;
	lease: ManagerLease;
	scheduler: Scheduler;
	start: () => Promise<void>;
}> {
	const root = await mkdtemp(join(tmpdir(), "subagent-manager-"));
	roots.push(root);
	const artifactRoot = join(root, "project-abc", "pi-p001");
	const baseStore = createArtifactStore({
		id: "p001",
		tmuxSession: "pi-p001",
		tmpRoot: root,
		projectSlug: "project-abc",
		artifactRoot,
	}, { now: () => 1_000 });
	const store = options.store ?? baseStore;
	const managerArtifactRoot = store.artifactRoot;

	const tmux: TmuxClient = {
		sessionName: "pi-p001",
		currentSessionId: async () => "pi-p001",
		ensureParentSession: vi.fn(async () => {
			if (options.tmuxFailure) throw options.tmuxFailure;
			return { created: false, reused: true };
		}),
		createAgentWindow: vi.fn(async ({ agentId }) => ({
			name: `subagent-${agentId}`,
			target: `pi-p001:subagent-${agentId}`,
			sessionName: "pi-p001",
		})),
		windowExists: vi.fn(async () => false),
		listAgentWindows: vi.fn(async () => []),
		closeVerifiedWindow: vi.fn(async () => false),
		targetFor: (name) => `pi-p001:${name}`,
		attachCommand: (name) => `tmux attach -t pi-p001:${name}`,
	};

	const lease: ManagerLease = {
		path: join(managerArtifactRoot, "manager.lock"),
		owner: "manager-new",
		generation: "lease-new",
		pid: 123,
		processStart: "start-new",
		assertCurrent: vi.fn(async () => undefined),
		release: vi.fn(async () => true),
	};

	let schedulerDeps!: SchedulerDeps;
	const scheduler: Scheduler = {
		start: vi.fn(),
		pump: vi.fn(async () => options.onPump?.(schedulerDeps)),
		reconcile: vi.fn(async () => undefined),
		snapshot: vi.fn(async () => ({
			queued: 0,
			starting: 0,
			running: 0,
			slotsUsed: 0,
			slotsFree: 2,
			maxConcurrent: 2,
			paused: false,
			generation: "lease-new",
			managerOwner: "manager-new",
		})),
		stop: vi.fn(async () => undefined),
		isPaused: () => false,
	};

	let id = 0;
	const defaultResolved: ManagerResolvedCall = {
		config: CONFIG,
		profiles: [PROFILE],
		contributions: [],
		policyAdapters: {},
	};
	const resolutions = Array.isArray(options.resolved)
		? [...options.resolved]
		: [options.resolved ?? defaultResolved];
	let resolutionIndex = 0;
	const deps: SubagentManagerDeps = {
		store,
		tmux,
		managerLockPath: join(managerArtifactRoot, "manager.lock"),
		registryLockPath: join(managerArtifactRoot, "registry.lock"),
		owner: "manager-new",
		mode: options.mode ?? "manager",
		currentAgentId: options.currentAgentId ?? null,
		runnerScriptPath: "/extension/runner.mjs",
		nodePath: "/usr/bin/node",
		pi: { command: "pi", args: ["--mode", "rpc"] },
		resolveCall: vi.fn(async () =>
			resolutions[Math.min(resolutionIndex++, resolutions.length - 1)] as ManagerResolvedCall),
		allocateAgentId: vi.fn(async () => `a00${++id}`),
		generation: () => `task-generation-${id}`,
		now: () => 1_000,
		sleep: (signal) => options.onSleep?.(store, signal) ?? Promise.resolve(),
		acquireManagerLease: vi.fn(async () => {
			if (options.leaseFailure) throw options.leaseFailure;
			return lease;
		}),
		createScheduler: (input) => {
			schedulerDeps = input;
			return scheduler;
		},
	};
	const manager = createSubagentManager(deps);
	return {
		manager,
		store,
		tmux,
		lease,
		scheduler,
		start: () => manager.start(CALL_CONTEXT),
	};
}

async function readRequest(store: ArtifactStore, agentId: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(join(store.artifactRoot, "subagents", agentId, "request.json"), "utf8"));
}

describe("createSubagentManager", () => {
	it("publishes exactly one durable queued child and returns its queued background receipt", async () => {
		const h = await createHarness();
		await h.start();

		const receipt = await h.manager.enqueue(REQUEST, CALL_CONTEXT, new AbortController().signal);

		expect(receipt).toEqual({
			agentId: "a001",
			state: "queued",
			tmuxSession: null,
			tmuxWindow: null,
			attachCommand: null,
			artifactDir: join(h.store.artifactRoot, "subagents", "a001"),
		});
		const tasks = await h.store.scanAll();
		expect(tasks).toHaveLength(1);
		expect(tasks[0]).toMatchObject({
			agentId: "a001",
			state: "queued",
			sequence: 1,
			parentAgentId: null,
			ownershipTreeId: "a001",
			origin: "conversation-123",
			groupId: "turn-1-nonce",
			profile: PROFILE,
		});
		const durableRequest = await readRequest(h.store, "a001");
		expect(durableRequest).toMatchObject({ agentId: "a001", sequence: 1, prompt: REQUEST.prompt });
	});

	it("re-resolves profile snapshots, budgets, and concurrency on every enqueue call", async () => {
		const updatedProfile: ResolvedProfile = {
			...PROFILE,
			model: "provider/new-model",
			timeoutSeconds: 45,
		};
		const initial: ManagerResolvedCall = {
			config: CONFIG,
			profiles: [PROFILE],
			contributions: [],
			policyAdapters: {},
		};
		const updated: ManagerResolvedCall = {
			config: { ...CONFIG, maxConcurrent: 1, webSearchMaxLookups: 9 },
			profiles: [updatedProfile],
			contributions: [],
			policyAdapters: {},
		};
		let observedMax = 0;
		const h = await createHarness({
			resolved: [initial, updated],
			onPump: async (schedulerDeps) => {
				observedMax = schedulerDeps.maxConcurrent;
			},
		});
		await h.start();

		await h.manager.enqueue(REQUEST, CALL_CONTEXT, new AbortController().signal);

		expect((await h.store.readTask("a001"))?.profile).toEqual(updatedProfile);
		expect(await readRequest(h.store, "a001")).toMatchObject({
			profile: updatedProfile,
			webSearchMaxLookups: 9,
		});
		expect(observedMax).toBe(1);
	});

	it("waits through starting until the runner acknowledges running for a background receipt", async () => {
		let advanced = false;
		const h = await createHarness({
			onPump: async ({ store }) => {
				const [task] = await store.scanActive();
				await store.writeStatus({ agentId: task.agentId, state: "starting", startedAt: 1_000, tmuxWindow: `subagent-${task.agentId}` });
			},
			onSleep: async (store) => {
				if (advanced) return;
				advanced = true;
				const [task] = await store.scanActive();
				await store.writeStatus({ agentId: task.agentId, state: "running", runnerPid: 321 });
			},
		});
		await h.start();

		const receipt = await h.manager.enqueue(REQUEST, CALL_CONTEXT, new AbortController().signal);

		expect(receipt).toMatchObject({
			agentId: "a001",
			state: "running",
			tmuxSession: "pi-p001",
			tmuxWindow: "subagent-a001",
			attachCommand: "tmux attach -t pi-p001:subagent-a001",
		});
	});

	it("returns a durable startup failure instead of hanging in starting", async () => {
		const h = await createHarness({
			onPump: async ({ store }) => {
				const [task] = await store.scanActive();
				await store.publishTerminal(task.agentId, result(task.agentId, "failed"));
			},
		});
		await h.start();

		const receipt = await h.manager.enqueue(REQUEST, CALL_CONTEXT, new AbortController().signal);

		expect(receipt.state).toBe("failed");
		expect(await h.store.readResult("a001")).toEqual(result("a001", "failed"));
	});

	it("returns the complete foreground result and marks delivery consumed atomically", async () => {
		const h = await createHarness({
			onPump: async ({ store }) => {
				const [task] = await store.scanActive();
				await store.publishTerminal(task.agentId, result(task.agentId));
			},
		});
		await h.start();

		const response = await h.manager.enqueue(
			{ ...REQUEST, run_in_background: false },
			CALL_CONTEXT,
			new AbortController().signal,
		);

		expect(response).toMatchObject({
			agentId: "a001",
			state: "succeeded",
			result: result("a001"),
			consumed: true,
			notFound: false,
		});
		expect(await h.store.readDelivery("a001")).toMatchObject({ state: "consumed", consumedAt: 1_000 });
	});

	it("interrupts only a foreground wait and leaves the durable running child uncancelled", async () => {
		let releaseSleep!: () => void;
		const h = await createHarness({
			onPump: async ({ store }) => {
				const [task] = await store.scanActive();
				await store.writeStatus({ agentId: task.agentId, state: "running", startedAt: 1_000, runnerPid: 321 });
			},
			onSleep: async (_store, signal) => new Promise<void>((resolve, reject) => {
				releaseSleep = resolve;
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			}),
		});
		await h.start();
		const controller = new AbortController();
		const waiting = h.manager.enqueue({ ...REQUEST, run_in_background: false }, CALL_CONTEXT, controller.signal);
		await vi.waitFor(() => expect(releaseSleep).toBeTypeOf("function"));

		controller.abort(new Error("caller interrupted"));
		await expect(waiting).rejects.toThrow("caller interrupted");
		releaseSleep();
		expect((await h.store.readTask("a001"))?.state).toBe("running");
		await expect(readFile(join(h.store.artifactRoot, "subagents", "a001", "control", "cancel"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("retrieves terminal data only from result.json and returns a stable consumed response", async () => {
		const h = await createHarness();
		await h.start();
		await h.store.enqueue(manifest("x001", { state: "succeeded", finishedAt: 2_000 }), runnerRequest("x001"));

		const withoutResult = await h.manager.getResult("x001", false, new AbortController().signal);
		expect(withoutResult.result).toBeNull();
		expect(withoutResult.state).toBe("succeeded");

		await h.store.publishTerminal("x001", result("x001"));
		const first = await h.manager.getResult("x001", false, new AbortController().signal);
		const second = await h.manager.getResult("x001", false, new AbortController().signal);
		expect(first).toEqual(second);
		expect(first).toMatchObject({ result: result("x001"), consumed: true, notFound: false });
	});

	it("scopes unknown result IDs to this parent registry", async () => {
		const h = await createHarness();
		await h.start();

		await expect(h.manager.getResult("z999", false, new AbortController().signal)).resolves.toMatchObject({
			agentId: "z999",
			state: "failed",
			result: null,
			consumed: false,
			notFound: true,
			artifactDir: null,
		});
		await expect(h.manager.stop("z999")).rejects.toThrow("unknown subagent z999");
	});

	it("cancels queued work durably, requests running cancellation, and keeps terminal stop idempotent", async () => {
		const h = await createHarness();
		await h.start();
		await h.store.enqueue(manifest("q001", { sequence: 1 }), runnerRequest("q001"));
		await h.store.enqueue(manifest("r001", { sequence: 2, state: "running", startedAt: 1_000 }), runnerRequest("r001"));
		await h.store.enqueue(manifest("d001", { sequence: 3 }), runnerRequest("d001"));
		await h.store.publishTerminal("d001", result("d001"));

		await expect(h.manager.stop("q001")).resolves.toMatchObject({ state: "cancelled", stopped: true });
		expect((await h.store.readResult("q001"))?.state).toBe("cancelled");
		await expect(h.manager.stop("r001")).resolves.toMatchObject({ state: "running", stopped: true });
		expect(JSON.parse(await readFile(join(h.store.artifactRoot, "subagents", "r001", "control", "cancel"), "utf8"))).toMatchObject({ agentId: "r001" });
		await expect(h.manager.stop("d001")).resolves.toMatchObject({ state: "succeeded", stopped: false });
	});

	it("stops descendants deepest-first before their parent", async () => {
		const root = await mkdtemp(join(tmpdir(), "subagent-manager-order-"));
		roots.push(root);
		const realStore = createArtifactStore({ id: "p001", tmuxSession: "pi-p001", tmpRoot: root, projectSlug: "project-abc", artifactRoot: join(root, "project-abc", "pi-p001") }, { now: () => 1_000 });
		const order: string[] = [];
		const proxied: ArtifactStore = {
			...realStore,
			async publishTerminal(agentId, terminal) {
				order.push(agentId);
				await realStore.publishTerminal(agentId, terminal);
			},
		};
		const h = await createHarness({ store: proxied });
		await h.start();
		await proxied.enqueue(manifest("p100", { sequence: 1 }), runnerRequest("p100"));
		await proxied.enqueue(manifest("c100", { sequence: 2, parentAgentId: "p100", ownershipTreeId: "p100" }), runnerRequest("c100"));
		await proxied.enqueue(manifest("g100", { sequence: 3, parentAgentId: "c100", ownershipTreeId: "p100" }), runnerRequest("g100"));

		await h.manager.stop("p100");

		expect(order).toEqual(["g100", "c100", "p100"]);
	});

	it("rejects enqueue before publication when tmux preflight is unavailable", async () => {
		const h = await createHarness({ tmuxFailure: new Error("tmux executable not found") });
		await h.start();

		await expect(h.manager.enqueue(REQUEST, CALL_CONTEXT, new AbortController().signal)).rejects.toThrow("tmux executable not found");
		expect(await h.store.scanAll()).toEqual([]);
	});

	it("enters observer mode on live manager contention and names the current owner", async () => {
		const h = await createHarness({ leaseFailure: new Error("lock held by manager-old (pid 77) at /tmp/manager.lock") });
		await h.start();

		await expect(h.manager.enqueue(REQUEST, CALL_CONTEXT, new AbortController().signal)).rejects.toThrow("observer-only: lock held by manager-old (pid 77)");
		await expect(h.manager.stop("a001")).rejects.toThrow("observer-only: lock held by manager-old (pid 77)");
		await expect(h.manager.list()).resolves.toEqual([]);
	});

	it("rejects terminal consumption in observer mode without mutating delivery", async () => {
		const h = await createHarness({ leaseFailure: new Error("lock held by manager-old (pid 77) at /tmp/manager.lock") });
		await h.store.initializeParent();
		await h.store.enqueue(manifest("d002"), runnerRequest("d002"));
		await h.store.publishTerminal("d002", result("d002"));
		await h.start();

		await expect(h.manager.getResult("d002", false, new AbortController().signal)).rejects.toThrow(
			"observer-only: lock held by manager-old (pid 77)",
		);
		expect(await h.store.readDelivery("d002")).toBeNull();
	});

	it("asserts the current manager generation before consuming a terminal result", async () => {
		const h = await createHarness();
		await h.start();
		await h.store.enqueue(manifest("d003"), runnerRequest("d003"));
		await h.store.publishTerminal("d003", result("d003"));
		vi.mocked(h.lease.assertCurrent).mockRejectedValue(new Error("lease superseded"));

		await expect(h.manager.getResult("d003", false, new AbortController().signal)).rejects.toThrow("lease superseded");
		expect(await h.store.readDelivery("d003")).toBeNull();
	});

	it("reserves an owner policy immediately before durable publication", async () => {
		let store!: ArtifactStore;
		const events: string[] = [];
		const adapter: ProfilePolicyAdapter = {
			reserve: async (owner, profile) => {
				expect(await store.scanAll()).toEqual([]);
				events.push(`reserve:${owner}:${profile}`);
				return { owner, profile, token: "reservation-1", acquiredAt: 1_000 };
			},
			settle: async () => undefined,
		};
		const resolved: ManagerResolvedCall = {
			config: CONFIG,
			profiles: [PROFILE],
			contributions: [{ owner: "research", profile: PROFILE }],
			policyAdapters: { research: adapter },
		};
		const h = await createHarness({ resolved });
		store = h.store;
		await h.start();

		await h.manager.enqueue(REQUEST, CALL_CONTEXT, new AbortController().signal);

		expect(events).toEqual(["reserve:research:general"]);
		expect(await store.scanAll()).toHaveLength(1);
	});

	it("allows nested foreground publication with inherited ownership and rejects nested background before reserve", async () => {
		let reserves = 0;
		const adapter: ProfilePolicyAdapter = {
			reserve: async (owner, profile) => {
				reserves++;
				return { owner, profile, token: "nested", acquiredAt: 1_000 };
			},
			settle: async () => undefined,
		};
		const resolved: ManagerResolvedCall = {
			config: CONFIG,
			profiles: [PROFILE],
			contributions: [{ owner: "research", profile: PROFILE }],
			policyAdapters: { research: adapter },
		};
		const h = await createHarness({ mode: "nested-producer", currentAgentId: "n001", resolved });
		await h.store.initializeParent();
		await h.store.enqueue(manifest("n001", { state: "running", ownershipTreeId: "root", origin: "origin-root" }), runnerRequest("n001"));
		await h.start();

		await expect(h.manager.enqueue(REQUEST, CALL_CONTEXT, new AbortController().signal)).rejects.toThrow("nested subagents must run in the foreground");
		expect(reserves).toBe(0);
		expect(await h.store.scanAll()).toHaveLength(1);

		const waiting = h.manager.enqueue({ ...REQUEST, run_in_background: false }, CALL_CONTEXT, new AbortController().signal);
		await vi.waitFor(async () => expect(await h.store.readTask("a001")).not.toBeNull());
		const child = await h.store.readTask("a001");
		expect(child).toMatchObject({ parentAgentId: "n001", ownershipTreeId: "root", origin: "origin-root", groupId: null });
		await h.store.publishTerminal("a001", result("a001"));
		await expect(waiting).resolves.toMatchObject({ state: "succeeded" });
	});

	it("rejects an unknown nested parent before publication", async () => {
		const h = await createHarness({ mode: "nested-producer", currentAgentId: "none" });
		await expect(h.start()).rejects.toThrow("unknown parent subagent none");
		expect(await h.store.scanAll()).toEqual([]);
	});

	it("awaits scheduler shutdown and releases its own lease exactly once without killing durable children", async () => {
		const h = await createHarness();
		await h.start();

		await h.manager.shutdown();
		await h.manager.shutdown();

		expect(h.scheduler.stop).toHaveBeenCalledTimes(1);
		expect(h.lease.release).toHaveBeenCalledTimes(1);
		expect(h.tmux.closeVerifiedWindow).not.toHaveBeenCalled();
	});
});
