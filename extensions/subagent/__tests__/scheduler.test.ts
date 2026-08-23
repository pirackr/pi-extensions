import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, unlink, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	acquireManagerLease,
	type ManagerLease,
	type LeaseDeps,
} from "../locks.ts";
import {
	enqueueWithSequence,
	type ArtifactStore,
	createArtifactStore,
} from "../storage.ts";
import {
	occupiedOwnershipTrees,
	selectEligibleQueued,
	isNestedEligible,
	descendantIds,
	createScheduler,
	type Scheduler,
	type SchedulerDeps,
} from "../scheduler.ts";
import {
	AgentWindow,
	type TmuxClient,
} from "../tmux.ts";
import {
	AgentManifest,
	type ResolvedProfile,
	type TerminalResult,
	type StatusUpdate,
	type DeliveryRecord,
	type GroupRecord,
} from "../types.ts";

// ---------------------------------------------------------------------------
// Deterministic seams
// ---------------------------------------------------------------------------

const CUR_START = "cur-process-start-hash";
const ALIVE_PID = 1000;

function leaseDeps(overrides: Partial<LeaseDeps> = {}): LeaseDeps {
	return {
		now: () => 1_700_000_000_000,
		currentPid: () => ALIVE_PID,
		processStart: () => CUR_START,
		randomGeneration: () => `gen-${Math.random().toString(36).slice(2, 10)}`,
		isProcessAlive: async (pid: number) => pid === ALIVE_PID,
		maxRetries: 8,
		baseDelayMs: 0,
		maxDelayMs: 0,
		...overrides,
	};
}

function makeProfile(
	overrides: Partial<NonNullable<AgentManifest["profile"]>> = {},
) {
	return {
		name: "reviewer",
		description: "Audit authentication",
		model: "qwen3-coder:30b",
		thinking: "off",
		tools: ["grep", "bash", "edit"],
		access: "write",
		timeoutSeconds: 300,
		systemPrompt: "You are a reviewer.",
		source: "bundled",
		...overrides,
	} as ResolvedProfile;
}

let seqCounter = 0;

function makeManifest(overrides: Partial<AgentManifest> = {}): AgentManifest {
	seqCounter += 1;
	const agentId = overrides.agentId ?? `a${seqCounter}`;
	return {
		schema: 1,
		generation: `g${seqCounter}`,
		revision: 1,
		parentId: "p000",
		agentId,
		parentAgentId: null,
		ownershipTreeId: overrides.ownershipTreeId ?? agentId,
		origin: "origin-uuid",
		groupId: null,
		description: `task ${seqCounter}`,
		prompt: `prompt ${seqCounter}`,
		profile: makeProfile(),
		state: "queued",
		sequence: seqCounter,
		queuedAt: 1000 + seqCounter,
		startedAt: null,
		heartbeatAt: null,
		finishedAt: null,
		runnerPid: null,
		processStart: CUR_START,
		tmuxSession: "pi-p000",
		tmuxWindow: null,
		timeoutSeconds: 300,
		terminalReason: null,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("occupiedOwnershipTrees", () => {
	it("counts one slot per occupied top-level tree", () => {
		const trees = occupiedOwnershipTrees([
			makeManifest({ agentId: "a1", state: "running" }),
			makeManifest({ agentId: "a2", state: "starting" }),
			makeManifest({ agentId: "a3", state: "queued" }),
			makeManifest({ agentId: "a4", state: "succeeded" }),
		]);
		expect(trees).toEqual(new Set(["a1", "a2"]));
	});

	it("collapses nested descendants into their top-level tree", () => {
		const trees = occupiedOwnershipTrees([
			makeManifest({
				agentId: "a1",
				state: "running",
				parentAgentId: null,
			}),
			makeManifest({
				agentId: "a2",
				state: "running",
				parentAgentId: "a1",
				ownershipTreeId: "a1",
			}),
		]);
		expect(trees).toEqual(new Set(["a1"]));
	});
});

describe("selectEligibleQueued", () => {
	it("returns the lowest-sequence eligible queued task", () => {
		const chosen = selectEligibleQueued([
			makeManifest({ agentId: "a3", sequence: 3, state: "queued" }),
			makeManifest({ agentId: "a1", sequence: 1, state: "queued" }),
			makeManifest({ agentId: "a2", sequence: 2, state: "running" }),
		]);
		expect(chosen?.agentId).toBe("a1");
	});

	it("ignores a nested queued task whose ancestor is missing", () => {
		const chosen = selectEligibleQueued([
			makeManifest({
				agentId: "a1",
				sequence: 1,
				state: "queued",
				parentAgentId: "a0",
				ownershipTreeId: "a0",
			}),
			makeManifest({ agentId: "a2", sequence: 2, state: "queued" }),
		]);
		expect(chosen?.agentId).toBe("a2");
	});

	it("includes an eligible nested task in global sequence order", () => {
		const chosen = selectEligibleQueued([
			makeManifest({
				agentId: "root",
				sequence: 1,
				state: "running",
				ownershipTreeId: "root",
			}),
			makeManifest({ agentId: "top", sequence: 3, state: "queued" }),
			makeManifest({
				agentId: "nest",
				sequence: 2,
				state: "queued",
				parentAgentId: "root",
				ownershipTreeId: "root",
			}),
		]);
		expect(chosen?.agentId).toBe("nest");
	});
});

// ---------------------------------------------------------------------------
// Nested ownership-tree helpers
// ---------------------------------------------------------------------------

describe("isNestedEligible", () => {
	it("accepts only a queued nested task in an occupied live ancestor tree", () => {
		const root = makeManifest({
			agentId: "root",
			sequence: 1,
			state: "running",
			ownershipTreeId: "root",
		});
		const child = makeManifest({
			agentId: "child",
			sequence: 2,
			parentAgentId: "root",
			ownershipTreeId: "root",
		});

		expect(isNestedEligible(child, [root, child])).toBe(true);
		expect(isNestedEligible(root, [root, child])).toBe(false);
	});

	it("fails closed for missing, terminal, or mismatched ancestor trees", () => {
		const liveRoot = makeManifest({
			agentId: "live",
			state: "running",
			ownershipTreeId: "live",
		});
		const terminalRoot = makeManifest({
			agentId: "root",
			state: "succeeded",
			ownershipTreeId: "root",
		});
		const missing = makeManifest({
			agentId: "missing-child",
			parentAgentId: "absent",
			ownershipTreeId: "absent",
		});
		const terminal = makeManifest({
			agentId: "terminal-child",
			parentAgentId: "root",
			ownershipTreeId: "root",
		});
		const mismatched = makeManifest({
			agentId: "wrong-tree",
			parentAgentId: "live",
			ownershipTreeId: "other",
		});

		expect(isNestedEligible(missing, [missing])).toBe(false);
		expect(isNestedEligible(terminal, [terminalRoot, terminal])).toBe(false);
		expect(isNestedEligible(mismatched, [liveRoot, mismatched])).toBe(false);
	});

	it("allows one active nested descendant per tree without cross-tree blocking", () => {
		const rootA = makeManifest({
			agentId: "roota",
			state: "running",
			ownershipTreeId: "roota",
		});
		const activeA = makeManifest({
			agentId: "activea",
			state: "starting",
			parentAgentId: "roota",
			ownershipTreeId: "roota",
		});
		const queuedA = makeManifest({
			agentId: "queueda",
			parentAgentId: "roota",
			ownershipTreeId: "roota",
		});
		const rootB = makeManifest({
			agentId: "rootb",
			state: "running",
			ownershipTreeId: "rootb",
		});
		const queuedB = makeManifest({
			agentId: "queuedb",
			parentAgentId: "rootb",
			ownershipTreeId: "rootb",
		});
		const tasks = [rootA, activeA, queuedA, rootB, queuedB];

		expect(isNestedEligible(queuedA, tasks)).toBe(false);
		expect(isNestedEligible(queuedB, tasks)).toBe(true);
	});
});

describe("descendantIds", () => {
	it("returns descendants deepest-first with sequence-stable siblings", () => {
		const tasks = [
			makeManifest({ agentId: "root", sequence: 1 }),
			makeManifest({
				agentId: "later",
				sequence: 3,
				parentAgentId: "root",
				ownershipTreeId: "root",
			}),
			makeManifest({
				agentId: "grand",
				sequence: 4,
				parentAgentId: "later",
				ownershipTreeId: "root",
			}),
			makeManifest({
				agentId: "first",
				sequence: 2,
				parentAgentId: "root",
				ownershipTreeId: "root",
			}),
			makeManifest({ agentId: "other", sequence: 5 }),
		];

		expect(descendantIds("root", tasks)).toEqual(["first", "grand", "later"]);
		expect(descendantIds("absent", tasks)).toEqual([]);
	});

	it("terminates cycles without returning duplicates or the requested root", () => {
		const tasks = [
			makeManifest({
				agentId: "a1",
				sequence: 1,
				parentAgentId: "a2",
				ownershipTreeId: "a1",
			}),
			makeManifest({
				agentId: "a2",
				sequence: 2,
				parentAgentId: "a1",
				ownershipTreeId: "a1",
			}),
		];

		expect(descendantIds("a1", tasks)).toEqual(["a2"]);
	});
});

// ---------------------------------------------------------------------------
// enqueueWithSequence — sequence allocation under the registry lock
// ---------------------------------------------------------------------------

describe("enqueueWithSequence", () => {
	let root: string;
	let registryPath: string;
	let store: ArtifactStore;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "subagent-seq-"));
		registryPath = join(root, "registry.lock");
		store = createArtifactStore({
			id: "p000",
			tmuxSession: "pi-p000",
			tmpRoot: root,
			projectSlug: "proj",
			artifactRoot: join(root, "pi-p000"),
		});
		await store.initializeParent();
	});

	afterEach(async () => {
		await cleanup(root);
	});

	it("allocates strictly increasing, collision-free sequences under the lock", async () => {
		const published = await Promise.all(
			[0, 1, 2, 3, 4].map((i) =>
				enqueueWithSequence(
					store,
					makeManifest({ agentId: `seq${i}` }),
					{ i },
					registryPath,
					"manager",
					new AbortController().signal,
					leaseDeps(),
				),
			),
		);

		const sequences = published.map((m) => m.sequence).sort((a, b) => a - b);
		expect(sequences).toEqual([1, 2, 3, 4, 5]);
		const all = await store.scanAll();
		expect(new Set(all.map((m) => m.sequence)).size).toBe(5);
	});

	it("continues past the highest on-disk sequence after a restart", async () => {
		const first = await enqueueWithSequence(
			store,
			makeManifest({ agentId: "seqa" }),
			{},
			registryPath,
			"manager",
			new AbortController().signal,
			leaseDeps(),
		);
		expect(first.sequence).toBe(1);

		const second = await enqueueWithSequence(
			store,
			makeManifest({ agentId: "seqb" }),
			{},
			registryPath,
			"manager",
			new AbortController().signal,
			leaseDeps(),
		);
		expect(second.sequence).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// Test harness: in-memory store + tmux topology
// ---------------------------------------------------------------------------

class FakeStore implements ArtifactStore {
	readonly identity = {
		id: "p000",
		tmuxSession: "pi-p000",
		tmpRoot: "/tmp/subagent-fake",
		projectSlug: "proj",
		artifactRoot: "/tmp/subagent-fake/pi-p000",
	};
	readonly tmpRoot = "/tmp/subagent-fake";
	readonly projectSlug = "proj";
	readonly artifactRoot = "/tmp/subagent-fake/pi-p000";

	readonly tasks = new Map<string, AgentManifest>();
	readonly results = new Map<string, TerminalResult>();

	async initializeParent(): Promise<void> {}

	async enqueue(
		manifest: AgentManifest,
		_request: Record<string, unknown>,
	): Promise<string> {
		this.tasks.set(manifest.agentId, { ...manifest });
		return manifest.agentId;
	}

	async scan(): Promise<AgentManifest[]> {
		return this.scanAll();
	}

	async scanAll(): Promise<AgentManifest[]> {
		return [...this.tasks.values()].sort((a, b) => a.sequence - b.sequence);
	}

	async scanActive(): Promise<AgentManifest[]> {
		return (await this.scanAll()).filter(
			(m) =>
				m.state === "queued" ||
				m.state === "starting" ||
				m.state === "running",
		);
	}

	async readTask(agentId: string): Promise<AgentManifest | null> {
		const m = this.tasks.get(agentId);
		return m ? { ...m } : null;
	}

	async readResult(agentId: string): Promise<TerminalResult | null> {
		const result = this.results.get(agentId);
		return result ? { ...result } : null;
	}

	async writeStatus(update: StatusUpdate): Promise<AgentManifest> {
		const existing = this.tasks.get(update.agentId);
		if (existing === undefined) {
			throw new Error(`no status to update: ${update.agentId}`);
		}
		if (update.revision !== undefined && update.revision <= existing.revision) {
			throw new Error(
				`revision must increase: stored ${existing.revision}, got ${update.revision}`,
			);
		}
		const merged: AgentManifest = {
			...existing,
			...update,
			revision: update.revision ?? existing.revision + 1,
		};
		this.tasks.set(update.agentId, merged);
		return merged;
	}

	async publishTerminal(
		agentId: string,
		result: TerminalResult,
	): Promise<void> {
		const existing = this.tasks.get(agentId);
		if (existing === undefined) throw new Error(`no status to settle: ${agentId}`);
		this.results.set(agentId, { ...result });
		this.tasks.set(agentId, {
			...existing,
			state: result.state,
			finishedAt: result.finishedAt,
			terminalReason: result.terminalReason,
			revision: existing.revision + 1,
		});
	}

	async requestCancellation(agentId: string): Promise<boolean> {
		return this.tasks.has(agentId);
	}

	async readDelivery(_agentId: string): Promise<DeliveryRecord | null> {
		return null;
	}

	async updateDelivery(
		_agentId: string,
		update: Partial<DeliveryRecord>,
	): Promise<DeliveryRecord> {
		return {
			groupId: "",
			agentIds: [_agentId],
			state: "pending",
			notificationId: "",
			createdAt: 0,
			dispatchedAt: null,
			consumedAt: null,
			...update,
		};
	}

	async readGroup(_groupId: string): Promise<GroupRecord | null> {
		return null;
	}

	async writeGroup(record: GroupRecord): Promise<GroupRecord> {
		return record;
	}

	async updateGroup(
		_groupId: string,
		update: Partial<GroupRecord>,
	): Promise<GroupRecord> {
		return { ...update } as GroupRecord;
	}

	async scanGroups(): Promise<GroupRecord[]> {
		return [];
	}
}

class FakeTmux implements TmuxClient {
	readonly sessionName = "pi-p000";
	readonly created: Array<{
		agentId: string;
		cwd: string;
		launchCommand: string;
	}> = [];
	readonly closed: string[] = [];
	windows = new Set<string>();

	async currentSessionId(): Promise<string> {
		return this.sessionName;
	}

	async ensureParentSession(): Promise<{
		created: boolean;
		reused: boolean;
	}> {
		return { created: false, reused: true };
	}

	async createAgentWindow(options: {
		agentId: string;
		cwd: string;
		launchCommand: string;
		signal?: AbortSignal;
	}): Promise<AgentWindow> {
		this.created.push(options);
		const name = `subagent-${options.agentId}`;
		this.windows.add(name);
		return {
			name,
			target: `pi-p000:${name}`,
			sessionName: this.sessionName,
		};
	}

	async windowExists(name: string): Promise<boolean> {
		return this.windows.has(name);
	}

	async listAgentWindows(): Promise<AgentWindow[]> {
		return [...this.windows].map((name) => ({
			name,
			target: `pi-p000:${name}`,
			sessionName: this.sessionName,
		}));
	}

	async closeVerifiedWindow(
		name: string,
		opts: { durableResult: boolean },
	): Promise<boolean> {
		if (!opts?.durableResult) return false;
		this.closed.push(name);
		this.windows.delete(name);
		return true;
	}

	targetFor(name: string): string {
		return `pi-p000:${name}`;
	}

	attachCommand(name: string): string {
		return `tmux attach -t ${this.sessionName} \\; select-window -t ${name}`;
	}
}

interface Harness {
	scheduler: Scheduler;
	store: FakeStore;
	tmux: FakeTmux;
	manager: ManagerLease;
	controller: AbortController;
}

let harnessRoot: string;

beforeEach(async () => {
	harnessRoot = await mkdtemp(join(tmpdir(), "subagent-harness-"));
});

afterEach(async () => {
	await cleanup(harnessRoot);
});

async function startHarness(
	overrides: Partial<SchedulerDeps> = {},
): Promise<Harness> {
	const store = new FakeStore();
	const tmux = new FakeTmux();
	const controller = new AbortController();
	const manager = await acquireManagerLease(
		join(harnessRoot, "manager.lock"),
		"manager",
		controller.signal,
		leaseDeps(),
	);
	const scheduler = createScheduler({
		store,
		tmux,
		managerLease: manager,
		maxConcurrent: 10,
		registryLockPath: join(harnessRoot, "registry.lock"),
		owner: "manager",
		signal: controller.signal,
		leaseDeps: leaseDeps(),
		...overrides,
	});
	return { scheduler, store, tmux, manager, controller };
}

async function cleanup(root: string): Promise<void> {
	try {
		const entries = await readdir(root);
		for (const entry of entries) await unlink(join(root, entry));
	} catch {
		// ignore
	}
}

// ---------------------------------------------------------------------------
// Scheduler — strict top-level FIFO
// ---------------------------------------------------------------------------

describe("scheduler — FIFO dispatch", () => {
	it("starts queued tasks in ascending sequence order", async () => {
		const { scheduler, store, tmux } = await startHarness();
		for (let i = 0; i < 4; i++) {
			store.tasks.set(`a${i}`, makeManifest({ agentId: `a${i}`, sequence: i }));
		}

		await scheduler.pump();

		expect(tmux.created.map((c) => c.agentId)).toEqual([
			"a0",
			"a1",
			"a2",
			"a3",
		]);
		const snap = await scheduler.snapshot();
		expect(snap.starting).toBe(4);
		expect(snap.queued).toBe(0);
		await scheduler.stop();
	});
});

// ---------------------------------------------------------------------------
// Scheduler — slot accounting and ceiling
// ---------------------------------------------------------------------------

describe("scheduler — starting + running slots", () => {
	it("counts both starting and running against the ceiling", async () => {
		const { scheduler, store } = await startHarness({ maxConcurrent: 3 });
		store.tasks.set("a1", makeManifest({ agentId: "a1", sequence: 1, state: "running" }));
		store.tasks.set("a2", makeManifest({ agentId: "a2", sequence: 2, state: "starting" }));
		store.tasks.set("a3", makeManifest({ agentId: "a3", sequence: 3, state: "running" }));
		store.tasks.set("a4", makeManifest({ agentId: "a4", sequence: 4, state: "queued" }));
		store.tasks.set("a5", makeManifest({ agentId: "a5", sequence: 5, state: "queued" }));

		await scheduler.pump();

		const snap = await scheduler.snapshot();
		expect(snap.slotsUsed).toBe(3);
		expect(snap.slotsFree).toBe(0);
		expect(snap.queued).toBe(2);
		await scheduler.stop();
	});

	it("starts exactly maxConcurrent of eleven tasks", async () => {
		const { scheduler, store, tmux } = await startHarness({ maxConcurrent: 10 });
		for (let i = 0; i < 11; i++) {
			store.tasks.set(`a${i}`, makeManifest({ agentId: `a${i}`, sequence: i + 1 }));
		}

		await scheduler.pump();

		expect(tmux.created.length).toBe(10);
		expect(tmux.created.map((c) => c.agentId)).toEqual([
			"a0", "a1", "a2", "a3", "a4", "a5", "a6", "a7", "a8", "a9",
		]);
		const snap = await scheduler.snapshot();
		expect(snap.starting).toBe(10);
		expect(snap.queued).toBe(1);
		expect(snap.slotsFree).toBe(0);
		await scheduler.stop();
	});
});

// ---------------------------------------------------------------------------
// Scheduler — nested ownership-tree dispatch
// ---------------------------------------------------------------------------

describe("scheduler — nested ownership trees", () => {
	it("dispatches a nested child inside its parent's slot at maxConcurrent one", async () => {
		const { scheduler, store, tmux } = await startHarness({ maxConcurrent: 1 });
		store.tasks.set(
			"r001",
			makeManifest({
				agentId: "r001",
				sequence: 1,
				state: "running",
				ownershipTreeId: "r001",
			}),
		);
		store.tasks.set(
			"c001",
			makeManifest({
				agentId: "c001",
				sequence: 2,
				parentAgentId: "r001",
				ownershipTreeId: "r001",
			}),
		);

		await scheduler.pump();

		expect(tmux.created.map((entry) => entry.agentId)).toEqual(["c001"]);
		expect(store.tasks.get("c001")?.state).toBe("starting");
		const snap = await scheduler.snapshot();
		expect(snap.slotsUsed).toBe(1);
		expect(snap.slotsFree).toBe(0);
		await scheduler.stop();
	});

	it("starts one descendant per tree at a time in sequence order", async () => {
		const { scheduler, store, tmux } = await startHarness({ maxConcurrent: 10 });
		store.tasks.set(
			"r001",
			makeManifest({
				agentId: "r001",
				sequence: 1,
				state: "running",
				ownershipTreeId: "r001",
			}),
		);
		for (const [agentId, sequence] of [["c001", 2], ["c002", 3]] as const) {
			store.tasks.set(
				agentId,
				makeManifest({
					agentId,
					sequence,
					parentAgentId: "r001",
					ownershipTreeId: "r001",
				}),
			);
		}

		await scheduler.pump();
		expect(tmux.created.map((entry) => entry.agentId)).toEqual(["c001"]);
		expect(store.tasks.get("c002")?.state).toBe("queued");

		store.tasks.set("c001", {
			...store.tasks.get("c001")!,
			state: "succeeded",
			finishedAt: 2000,
		});
		await scheduler.pump();

		expect(tmux.created.map((entry) => entry.agentId)).toEqual(["c001", "c002"]);
		await scheduler.stop();
	});

	it("preserves global sequence order when nested work is earlier and a slot is free", async () => {
		const { scheduler, store, tmux } = await startHarness({ maxConcurrent: 2 });
		store.tasks.set(
			"r001",
			makeManifest({
				agentId: "r001",
				sequence: 1,
				state: "running",
				ownershipTreeId: "r001",
			}),
		);
		store.tasks.set(
			"c001",
			makeManifest({
				agentId: "c001",
				sequence: 2,
				parentAgentId: "r001",
				ownershipTreeId: "r001",
			}),
		);
		store.tasks.set(
			"t001",
			makeManifest({ agentId: "t001", sequence: 3, ownershipTreeId: "t001" }),
		);

		await scheduler.pump();

		expect(tmux.created.map((entry) => entry.agentId)).toEqual(["c001", "t001"]);
		await scheduler.stop();
	});

	it("preserves global sequence order when top-level work is earlier and a slot is free", async () => {
		const { scheduler, store, tmux } = await startHarness({ maxConcurrent: 2 });
		store.tasks.set(
			"r001",
			makeManifest({
				agentId: "r001",
				sequence: 1,
				state: "running",
				ownershipTreeId: "r001",
			}),
		);
		store.tasks.set(
			"t001",
			makeManifest({ agentId: "t001", sequence: 2, ownershipTreeId: "t001" }),
		);
		store.tasks.set(
			"c001",
			makeManifest({
				agentId: "c001",
				sequence: 3,
				parentAgentId: "r001",
				ownershipTreeId: "r001",
			}),
		);

		await scheduler.pump();

		expect(tmux.created.map((entry) => entry.agentId)).toEqual(["t001", "c001"]);
		await scheduler.stop();
	});

	it("bypasses an earlier top-level task when only an occupied tree can run", async () => {
		const { scheduler, store, tmux } = await startHarness({ maxConcurrent: 1 });
		store.tasks.set(
			"r001",
			makeManifest({
				agentId: "r001",
				sequence: 1,
				state: "running",
				ownershipTreeId: "r001",
			}),
		);
		store.tasks.set(
			"t001",
			makeManifest({ agentId: "t001", sequence: 2, ownershipTreeId: "t001" }),
		);
		store.tasks.set(
			"c001",
			makeManifest({
				agentId: "c001",
				sequence: 3,
				parentAgentId: "r001",
				ownershipTreeId: "r001",
			}),
		);

		await scheduler.pump();

		expect(tmux.created.map((entry) => entry.agentId)).toEqual(["c001"]);
		expect(store.tasks.get("t001")?.state).toBe("queued");
		await scheduler.stop();
	});

	it("claims at most one nested descendant when pumps race", async () => {
		const { scheduler, store, tmux } = await startHarness({ maxConcurrent: 1 });
		store.tasks.set(
			"r001",
			makeManifest({
				agentId: "r001",
				sequence: 1,
				state: "running",
				ownershipTreeId: "r001",
			}),
		);
		for (const [agentId, sequence] of [["c001", 2], ["c002", 3]] as const) {
			store.tasks.set(
				agentId,
				makeManifest({
					agentId,
					sequence,
					parentAgentId: "r001",
					ownershipTreeId: "r001",
				}),
			);
		}

		await Promise.all([scheduler.pump(), scheduler.pump()]);

		expect(tmux.created.map((entry) => entry.agentId)).toEqual(["c001"]);
		expect(store.tasks.get("c002")?.state).toBe("queued");
		await scheduler.stop();
	});

	it("retains a nested task without dispatch when its ancestor is missing", async () => {
		const { scheduler, store, tmux } = await startHarness({ maxConcurrent: 1 });
		store.tasks.set(
			"c001",
			makeManifest({
				agentId: "c001",
				sequence: 1,
				parentAgentId: "gone",
				ownershipTreeId: "gone",
			}),
		);

		await scheduler.pump();

		expect(store.tasks.get("c001")?.state).toBe("queued");
		expect(tmux.created).toHaveLength(0);
		await scheduler.stop();
	});

	it("retains a nested task without dispatch when the manager is absent", async () => {
		const { scheduler, store, tmux, manager } = await startHarness({ maxConcurrent: 1 });
		store.tasks.set(
			"r001",
			makeManifest({
				agentId: "r001",
				sequence: 1,
				state: "running",
				ownershipTreeId: "r001",
			}),
		);
		store.tasks.set(
			"c001",
			makeManifest({
				agentId: "c001",
				sequence: 2,
				parentAgentId: "r001",
				ownershipTreeId: "r001",
			}),
		);
		await manager.release();

		await expect(scheduler.pump()).rejects.toThrow();

		expect(store.tasks.get("c001")?.state).toBe("queued");
		expect(tmux.created).toHaveLength(0);
		await scheduler.stop();
	});
});

// ---------------------------------------------------------------------------
// Scheduler — startup claim atomicity
// ---------------------------------------------------------------------------

describe("scheduler — atomic startup claim", () => {
	it("claims a single queued task even when two pumps run concurrently", async () => {
		const { scheduler, store, tmux } = await startHarness();
		store.tasks.set("a1", makeManifest({ agentId: "a1", sequence: 1 }));

		await Promise.all([scheduler.pump(), scheduler.pump()]);

		expect(store.tasks.get("a1")?.state).toBe("starting");
		expect(tmux.created.length).toBe(1);
		await scheduler.stop();
	});
});

// ---------------------------------------------------------------------------
// Scheduler — pause without a manager
// ---------------------------------------------------------------------------

describe("scheduler — pause without a manager", () => {
	it("pump throws when the manager lease is no longer current", async () => {
		const { scheduler, manager } = await startHarness();
		await manager.release();
		await expect(scheduler.pump()).rejects.toThrow();
		await scheduler.stop();
	});

	it("parks the pump loop when the manager is lost mid-run", async () => {
		// Gate on the pump reaching its idle tick with a live manager (via
		// `onClaimed`) so the assertion does not depend on fake-timer
		// advancement awaiting the real `assertCurrent` fs read, then poll for
		// the pause rather than sleeping a fixed amount.
		let onClaimed: (() => void) | null = null;
		const { scheduler, store, manager } = await startHarness({
			pumpIntervalMs: 20,
			onClaimed: () => onClaimed?.(),
		});
		try {
			store.tasks.set("a1", makeManifest({ agentId: "a1", sequence: 1 }));

			scheduler.start();
			await new Promise<void>((resolve) => (onClaimed = resolve));

			await manager.release();
			const deadline = Date.now() + 1000;
			while (!scheduler.isPaused() && Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, 5));
			}

			expect(scheduler.isPaused()).toBe(true);
		} finally {
			await scheduler.stop();
		}
	});
});

// ---------------------------------------------------------------------------
// Scheduler — reconciliation
// ---------------------------------------------------------------------------

describe("scheduler — reconciliation", () => {
	it("re-adopts a live runner whose window still exists", async () => {
		const { scheduler, store, tmux } = await startHarness();
		store.tasks.set(
			"a1",
			makeManifest({
				agentId: "a1",
				sequence: 1,
				state: "starting",
				tmuxWindow: "subagent-a1",
				runnerPid: ALIVE_PID,
			}),
		);
		tmux.windows.add("subagent-a1");

		await scheduler.reconcile();

		expect(store.tasks.get("a1")?.state).toBe("running");
		await scheduler.stop();
	});

	it("records interrupted for a running task whose window is gone and has no durable result", async () => {
		const { scheduler, store } = await startHarness();
		store.tasks.set(
			"a1",
			makeManifest({
				agentId: "a1",
				sequence: 1,
				state: "running",
				tmuxWindow: "subagent-a1",
				runnerPid: ALIVE_PID,
			}),
		);

		await scheduler.reconcile();

		const reconciled = store.tasks.get("a1");
		expect(reconciled?.state).toBe("interrupted");
		expect(reconciled?.terminalReason).toMatch(/disappeared/i);
		await scheduler.stop();
	});

	it("does not clobber a runner that already published a durable terminal result", async () => {
		const { scheduler, store } = await startHarness();
		store.tasks.set(
			"a1",
			makeManifest({
				agentId: "a1",
				sequence: 1,
				state: "running",
				tmuxWindow: "subagent-a1",
				runnerPid: ALIVE_PID,
			}),
		);
		store.results.set("a1", {
			agentId: "a1",
			state: "succeeded",
			output: "done",
			usage: { totalTokens: 1, toolUses: 1, durationMs: 1 },
			finishedAt: 42,
			terminalReason: null,
		} as TerminalResult);

		await scheduler.reconcile();

		expect(store.tasks.get("a1")?.state).toBe("running");
		await scheduler.stop();
	});

	it("closes a verified terminal orphan window and refuses one without a durable result", async () => {
		const { scheduler, store, tmux } = await startHarness();
		store.tasks.set(
			"a1",
			makeManifest({
				agentId: "a1",
				sequence: 1,
				state: "succeeded",
				tmuxWindow: "subagent-a1",
			}),
		);
		store.results.set("a1", {
			agentId: "a1",
			state: "succeeded",
			output: "done",
			usage: { totalTokens: 1, toolUses: 1, durationMs: 1 },
			finishedAt: 42,
			terminalReason: null,
		} as TerminalResult);
		store.tasks.set(
			"a2",
			makeManifest({
				agentId: "a2",
				sequence: 2,
				state: "failed",
				tmuxWindow: "subagent-a2",
			}),
		);
		tmux.windows.add("subagent-a1");
		tmux.windows.add("subagent-a2");

		await scheduler.reconcile();

		expect(tmux.closed).toEqual(["subagent-a1"]);
		expect(tmux.windows.has("subagent-a2")).toBe(true);
		await scheduler.stop();
	});
});

// ---------------------------------------------------------------------------
// Scheduler — coalesced reconcile
// ---------------------------------------------------------------------------

describe("scheduler — coalesced reconcile", () => {
	it("runs a single reconcile for concurrent triggers", async () => {
		const { scheduler, store } = await startHarness();

		let scanActiveCalls = 0;
		const original = store.scanActive.bind(store);
		store.scanActive = async () => {
			scanActiveCalls += 1;
			return original();
		};

		await Promise.all([scheduler.reconcile(), scheduler.reconcile()]);

		expect(scanActiveCalls).toBe(1);
		await scheduler.stop();
	});
});

// ---------------------------------------------------------------------------
// Scheduler — durable failures before/without a runner result
// ---------------------------------------------------------------------------

describe("scheduler — durable startup and interruption failures", () => {
	it("publishes result before failed status when tmux window creation fails", async () => {
		const { scheduler, store, tmux } = await startHarness({ now: () => 2_000 });
		store.tasks.set("a1", makeManifest({ agentId: "a1", sequence: 1 }));
		tmux.createAgentWindow = async () => {
			throw new Error("tmux launch refused");
		};
		const publications: string[] = [];
		store.publishTerminal = async (agentId, terminal) => {
			publications.push(`result:${terminal.state}`);
			store.results.set(agentId, terminal);
			publications.push(`status:${terminal.state}`);
			await store.writeStatus({
				agentId,
				state: terminal.state,
				finishedAt: terminal.finishedAt,
				terminalReason: terminal.terminalReason,
			});
		};

		await scheduler.pump();

		expect(publications).toEqual(["result:failed", "status:failed"]);
		expect(await store.readResult("a1")).toEqual({
			agentId: "a1",
			state: "failed",
			output: "",
			usage: { totalTokens: 0, toolUses: 0, durationMs: 0 },
			finishedAt: 2_000,
			terminalReason: "tmux launch failed: tmux launch refused",
		});
		expect((await store.readTask("a1"))?.state).toBe("failed");
		await scheduler.stop();
	});

	it("publishes an interrupted result before terminal status when a live window disappears", async () => {
		const { scheduler, store } = await startHarness({ now: () => 3_000 });
		store.tasks.set("a1", makeManifest({
			agentId: "a1",
			state: "running",
			startedAt: 1_500,
			tmuxWindow: "subagent-a1",
		}));
		const publications: string[] = [];
		store.publishTerminal = async (agentId, terminal) => {
			publications.push(`result:${terminal.state}`);
			store.results.set(agentId, terminal);
			publications.push(`status:${terminal.state}`);
			await store.writeStatus({
				agentId,
				state: terminal.state,
				finishedAt: terminal.finishedAt,
				terminalReason: terminal.terminalReason,
			});
		};

		await scheduler.reconcile();

		expect(publications).toEqual(["result:interrupted", "status:interrupted"]);
		expect(await store.readResult("a1")).toEqual({
			agentId: "a1",
			state: "interrupted",
			output: "",
			usage: { totalTokens: 0, toolUses: 0, durationMs: 1_500 },
			finishedAt: 3_000,
			terminalReason: "runner or window disappeared without a durable result",
		});
		await scheduler.stop();
	});
});

// ---------------------------------------------------------------------------
// Scheduler — abortable stop / timers outside tool waits
// ---------------------------------------------------------------------------

describe("scheduler — abortable stop", () => {
	it("aborts an in-flight claim when stopped", async () => {
		const { scheduler, store, tmux } = await startHarness();
		store.tasks.set("a1", makeManifest({ agentId: "a1", sequence: 1 }));

		// The claim forwards the scheduler's internal lifecycle signal through
		// the create options, so this mock aborts in-flight creation when the
		// scheduler stops and records that it was aborted.
		let wasAborted = false;
		tmux.createAgentWindow = async (options) =>
			new Promise((_resolve, reject) => {
				options.signal?.addEventListener(
					"abort",
					() => {
						wasAborted = true;
						reject(
							options.signal?.reason ?? new Error("aborted"),
						);
					},
					{ once: true },
				);
			});

		scheduler.start();
		await new Promise((r) => setTimeout(r, 20));
		await scheduler.stop();

		// The claim's in-flight window creation was aborted, and a deliberate
		// `stop` ends the pump stopped with no pause.
		expect(wasAborted).toBe(true);
		expect(scheduler.isPaused()).toBe(false);
	});

	it("stops the pump timer immediately on stop", async () => {
		vi.useFakeTimers();
		try {
			let claimCount = 0;
			let onClaimed: (() => void) | null = null;
			const { scheduler, store, tmux } = await startHarness({
				pumpIntervalMs: 10_000,
				onClaimed: () => {
					claimCount += 1;
					onClaimed?.();
				},
			});
			store.tasks.set("a1", makeManifest({ agentId: "a1", sequence: 1 }));

			scheduler.start();
			// Wait until the pump has dispatched its only task and is now parked
			// on the long idle tick: the timer is genuinely pending when we stop.
			await new Promise<void>((resolve) => (onClaimed = resolve));

			await scheduler.stop();

			// A deliberate `stop` while the long timer is pending leaves the pump
			// stopped (not paused), and advancing time must not reschedule it.
			expect(scheduler.isPaused()).toBe(false);
			await vi.advanceTimersByTimeAsync(100_000);
			expect(claimCount).toBe(1);
			expect(tmux.created.length).toBe(1);
		} finally {
			vi.useRealTimers();
		}
	});
});
