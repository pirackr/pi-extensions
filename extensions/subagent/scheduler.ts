// Durable FIFO scheduler and reconciliation for the `subagent` extension.
//
// The connected manager runs one independent asynchronous scheduler loop that,
// every tick:
//
//   1. reconciles `starting`/`running` manifests (live re-adoption, dead
//      `interrupted`, and verified orphan-window closure), then
//   2. dispatches the lowest-sequence eligible queued task until the hard
//      concurrency ceiling is reached.
//
// No external queue service or queue library is used: the durable queue is the
// set of `queued` manifests on disk, and dispatch only ever moves a manifest
// from `queued` to `starting` under a short-lived {@link registry.lock}.
//
// Invariants enforced here:
//
// - **Durable FIFO with nested eligibility.** {@link selectEligibleQueued}
//   returns the lowest-`sequence` dispatchable queued task. A nested task runs
//   only inside its already-occupied ownership tree; it never opens a slot.
// - **Concurrency counted by ownership tree.** {@link occupiedOwnershipTrees}
//   counts a slot per occupied top-level tree, so `starting` and `running`
//   both consume a slot and nested descendants never add a global one.
// - **Manager-generation checks before every claim/mutation.** The manager
//   {@link ManagerLease} generation is asserted before each registry claim and
//   before each reconciliation write, so a stale lease can neither dispatch nor
//   mutate.
// - **Atomic startup claim.** A `queued`→`starting` transition and its window
//   creation happen inside one registry lock, so two pumps can never start the
//   same task.
// - **Pause without a manager.** A lost manager lease stops the pump and parks
//   it rather than dispatching stale work. A deliberate `stop` aborts owned
//   work and ends the pump stopped with `paused` left false.
// - **Abortable timers outside tool waits.** The loop only `await`s between
//   pumps; the tick timer is created outside every tool/files call and is
//   cleared the moment the lifecycle signal aborts.

import {
	withRegistryLock,
	type LeaseDeps,
	type ManagerLease,
} from "./locks.ts";
import { type ArtifactStore } from "./storage.ts";
import { AGENT_WINDOW_PREFIX, type TmuxClient } from "./tmux.ts";
import { type AgentManifest, type StatusUpdate, type TaskStatus } from "./types.ts";

/** Terminal states that no longer occupy a concurrency slot. */
const NON_TERMINAL: readonly TaskStatus[] = ["queued", "starting", "running"];

/** Default pump tick interval for the independent loop (ms). */
const DEFAULT_PUMP_INTERVAL_MS = 250;

/** Whether a task owns a global slot rather than running inside one. */
function isTopLevel(task: AgentManifest): boolean {
	return task.parentAgentId === null || task.parentAgentId === undefined;
}

/** Return the durable top-level ownership-tree id for slot accounting. */
function topLevelTreeId(task: AgentManifest): string {
	return task.ownershipTreeId;
}

/**
 * Whether a queued nested task may run inside its already-occupied tree.
 * Every ancestor must be present, active, and in the same durable tree. At
 * most one nested descendant in a tree may be `starting` or `running`.
 */
export function isNestedEligible(
	task: AgentManifest,
	tasks: readonly AgentManifest[],
): boolean {
	if (task.state !== "queued" || isTopLevel(task)) return false;

	const byId = new Map(tasks.map((item) => [item.agentId, item] as const));
	const seen = new Set<string>([task.agentId]);
	let parentId: string | null = task.parentAgentId;
	let reachedRoot = false;

	while (parentId !== null) {
		if (seen.has(parentId)) return false;
		seen.add(parentId);
		const parent = byId.get(parentId);
		if (parent === undefined) return false;
		if (parent.ownershipTreeId !== task.ownershipTreeId) return false;
		if (parent.state !== "starting" && parent.state !== "running") return false;
		if (isTopLevel(parent)) {
			reachedRoot =
				parent.agentId === task.ownershipTreeId &&
				parent.ownershipTreeId === task.ownershipTreeId;
			break;
		}
		parentId = parent.parentAgentId;
	}
	if (!reachedRoot) return false;

	return !tasks.some(
		(other) =>
			other.agentId !== task.agentId &&
			!isTopLevel(other) &&
			other.ownershipTreeId === task.ownershipTreeId &&
			(other.state === "starting" || other.state === "running"),
	);
}

/**
 * Return descendants in deterministic post-order: deepest descendants first,
 * with siblings visited by ascending durable sequence. The requested task is
 * excluded, unrelated trees are ignored, and malformed cycles terminate.
 */
export function descendantIds(
	agentId: string,
	tasks: readonly AgentManifest[],
): string[] {
	const root = tasks.find((task) => task.agentId === agentId);
	if (root === undefined) return [];

	const children = new Map<string, AgentManifest[]>();
	for (const task of tasks) {
		if (task.parentAgentId === null) continue;
		if (task.ownershipTreeId !== root.ownershipTreeId) continue;
		const siblings = children.get(task.parentAgentId) ?? [];
		siblings.push(task);
		children.set(task.parentAgentId, siblings);
	}
	for (const siblings of children.values()) {
		siblings.sort(
			(a, b) => a.sequence - b.sequence || a.agentId.localeCompare(b.agentId),
		);
	}

	const result: string[] = [];
	const visited = new Set<string>([agentId]);
	const visit = (parentId: string): void => {
		for (const child of children.get(parentId) ?? []) {
			if (visited.has(child.agentId)) continue;
			visited.add(child.agentId);
			visit(child.agentId);
			result.push(child.agentId);
		}
	};
	visit(agentId);
	return result;
}

/**
 * Return the set of top-level ownership trees that currently occupy a slot: a
 * tree is occupied when any task in it is `starting` or `running`. Nested
 * descendants never add a second global slot.
 */
export function occupiedOwnershipTrees(
	tasks: readonly AgentManifest[],
): Set<string> {
	const occupied = new Set<string>();
	for (const task of tasks) {
		if (task.state !== "starting" && task.state !== "running") continue;
		occupied.add(topLevelTreeId(task));
	}
	return occupied;
}

/** Return the lowest-sequence dispatchable queued task, or `null`. */
export function selectEligibleQueued(
	tasks: readonly AgentManifest[],
): AgentManifest | null {
	let best: AgentManifest | null = null;
	for (const task of tasks) {
		if (task.state !== "queued") continue;
		if (!isTopLevel(task) && !isNestedEligible(task, tasks)) continue;
		if (best === null || task.sequence < best.sequence) best = task;
	}
	return best;
}

/** Lowest eligible nested task for an already-full global slot set. */
function selectEligibleNested(
	tasks: readonly AgentManifest[],
): AgentManifest | null {
	let best: AgentManifest | null = null;
	for (const task of tasks) {
		if (!isNestedEligible(task, tasks)) continue;
		if (best === null || task.sequence < best.sequence) best = task;
	}
	return best;
}

/** Live counts and lifecycle flags reported by {@link Scheduler.snapshot}. */
export interface SchedulerSnapshot {
	/** Queued top-level tasks awaiting dispatch. */
	readonly queued: number;
	/** Tasks currently transitioning to running. */
	readonly starting: number;
	/** Tasks confirmed running by a live runner. */
	readonly running: number;
	/** Occupied top-level slots after this run. */
	readonly slotsUsed: number;
	/** Occupied top-level slots before this run. */
	readonly slotsFree: number;
	/** The configured hard concurrency ceiling. */
	readonly maxConcurrent: number;
	/** Whether the pump has paused (for example, after losing the manager). */
	readonly paused: boolean;
	/** The manager lease generation currently observed. */
	readonly generation: string;
	/** The manager lease owner currently observed. */
	readonly managerOwner: string;
}

/**
 * The durable FIFO scheduler. `start` launches the independent async pump; the
 * remaining methods are single-shot triggers used directly by tests and by the
 * manager lifecycle.
 */
export interface Scheduler {
	/** Launch the independent, abortable async pump. Idempotent. */
	start(): void;
	/** Run one reconcile + dispatch cycle. Throws when the manager is gone. */
	pump(): Promise<void>;
	/** Reconcile live runners, dead tasks, and verified orphan windows. */
	reconcile(): Promise<void>;
	/** Snapshot current queue/slot counts. */
	snapshot(): Promise<SchedulerSnapshot>;
	/** Stop the pump and abort in-flight work. */
	stop(): Promise<void>;
	/** Whether the pump has paused. */
	isPaused(): boolean;
}

/** Injectable dependencies for {@link createScheduler}. */
export interface SchedulerDeps {
	/** Durable store for the current parent. */
	readonly store: ArtifactStore;
	/** Tmux topology client for starting, inspecting, and closing windows. */
	readonly tmux: TmuxClient;
	/**
	 * The long-lived manager lease. Its generation is asserted before every
	 * claim and mutation so a stale lease cannot dispatch or mutate.
	 */
	readonly managerLease: ManagerLease;
	/** Hard cap on concurrently occupied top-level slots (for example 10). */
	readonly maxConcurrent: number;
	/** Path to the short-lived registry lock used to claim tasks atomically. */
	readonly registryLockPath: string;
	/** Owner label recorded in the registry lease. */
	readonly owner: string;
	/** Lifecycle abort signal; aborting stops the pump and in-flight work. */
	readonly signal: AbortSignal;
	/** Injectable lease dependencies forwarded to {@link withRegistryLock}. */
	readonly leaseDeps?: LeaseDeps;
	/** Pump tick interval in ms for the independent loop. Default 250. */
	readonly pumpIntervalMs?: number;
	/** Injectable clock. Defaults to `Date.now`. */
	readonly now?: () => number;
	/** Injectable runner-process liveness predicate for live re-adoption. */
	readonly isProcessAlive?: (pid: number) => Promise<boolean>;
	/** Working directory passed to tmux window creation. */
	readonly cwd?: string;
	/**
	 * Seam for the runner launch command. Empty by default so Task 6 can start
	 * a bare window; Task 7/8 supply the concrete runner invocation.
	 */
	readonly launchCommandFor?: (task: AgentManifest) => string;
	/** Test hook fired after a successful claim, with the claimed task. */
	readonly onClaimed?: (task: AgentManifest) => void;
}

/**
 * Build a {@link Scheduler} bound to the given dependencies. The returned
 * scheduler is frozen; use {@link start}/{@link stop} to drive the pump and the
 * single-shot methods to step it manually.
 */
export function createScheduler(deps: SchedulerDeps): Scheduler {
	const now = deps.now ?? Date.now;
	const isProcessAlive =
		deps.isProcessAlive ??
		deps.leaseDeps?.isProcessAlive ??
		(async () => false);
	const pumpInterval = deps.pumpIntervalMs ?? DEFAULT_PUMP_INTERVAL_MS;
	const cwd = deps.cwd ?? deps.store.artifactRoot;

	/** Abortable lifecycle controller for the pump and its in-flight work. */
	const lifecycle = new AbortController();
	if (deps.signal) {
		if (deps.signal.aborted) {
			lifecycle.abort(deps.signal.reason);
		} else {
			deps.signal.addEventListener(
				"abort",
				() => lifecycle.abort(deps.signal.reason),
				{ once: true },
			);
		}
	}
	const signal = lifecycle.signal;

	// Coalesced reconcile: overlapping requests merge into a single run plus at
	// most one follow-up run, so a burst of dispatches never stacks reconciles.
	let reconcileInFlight: Promise<void> | null = null;
	let reconcilePending = false;

	/** Abortable timer, always created outside tool/file waits. */
	function tick(ms: number): Promise<void> {
		return new Promise<void>((resolve, reject) => {
			if (signal.aborted) {
				reject(signal.reason);
				return;
			}
			const cleanup = () => {
				clearTimeout(timer);
				signal.removeEventListener("abort", onAbort);
			};
			const timer = setTimeout(() => {
				cleanup();
				resolve();
			}, ms);
			const onAbort = () => {
				cleanup();
				reject(signal.reason);
			};
			signal.addEventListener("abort", onAbort, { once: true });
		});
	}

	const assertManagerAlive = async (): Promise<void> => {
		await deps.managerLease.assertCurrent();
	};

	/** A generation-checked durable status write. */
	const mutate = async (
		agentId: string,
		update: Partial<StatusUpdate>,
	): Promise<void> => {
		await assertManagerAlive();
		await deps.store.writeStatus({ agentId, ...update });
		await assertManagerAlive();
	};

	/**
	 * Atomically move one queued task to `starting` and start its window inside
	 * a single registry lock. Returns `true` only when this call won the claim.
	 */
	const claimStarting = async (
		task: AgentManifest,
	): Promise<boolean> => {
		await assertManagerAlive();
		let claimed = false;
		await withRegistryLock(
			deps.registryLockPath,
			deps.owner,
			async (lease) => {
				await lease.assertCurrent();
				await assertManagerAlive();
				// Re-scan under the lock: another pump may have claimed a task,
				// filled a global slot, or occupied this nested task's tree.
				const active = await deps.store.scanActive();
				const fresh = active.find((candidate) => candidate.agentId === task.agentId);
				if (
					fresh === undefined ||
					fresh.state !== "queued" ||
					fresh.generation !== task.generation
				) {
					return;
				}
				if (isTopLevel(fresh)) {
					if (occupiedOwnershipTrees(active).size >= deps.maxConcurrent) return;
				} else if (!isNestedEligible(fresh, active)) {
					return;
				}
				await mutate(fresh.agentId, {
					state: "starting",
					startedAt: now(),
				});
				await lease.assertCurrent();
				await assertManagerAlive();
				let window;
				try {
					window = await deps.tmux.createAgentWindow({
						agentId: fresh.agentId,
						cwd,
						launchCommand: deps.launchCommandFor?.(fresh) ?? "",
						signal,
					});
				} catch (error) {
					if (signal.aborted) throw error;
					await assertManagerAlive();
					const message = error instanceof Error ? error.message : String(error);
					await deps.store.publishTerminal(fresh.agentId, {
						agentId: fresh.agentId,
						state: "failed",
						output: "",
						usage: { totalTokens: 0, toolUses: 0, durationMs: 0 },
						finishedAt: now(),
						terminalReason: `tmux launch failed: ${message}`,
					});
					await lease.assertCurrent();
					await assertManagerAlive();
					return;
				}
				await mutate(fresh.agentId, { tmuxWindow: window.name });
				claimed = true;
			},
			signal,
			deps.leaseDeps,
		);
		if (claimed) deps.onClaimed?.(task);
		return claimed;
	};

	/** Dispatch eligible queued tasks until no global or in-tree work fits. */
	const dispatch = async (): Promise<number> => {
		await assertManagerAlive();
		let dispatched = 0;
		for (;;) {
			const active = await deps.store.scanActive();
			const occupied = occupiedOwnershipTrees(active).size;
			const next =
				occupied >= deps.maxConcurrent
					? selectEligibleNested(active)
					: selectEligibleQueued(active);
			if (next === null) break;
			const claimed = await claimStarting(next);
			if (!claimed) continue;
			dispatched += 1;
		}
		return dispatched;
	};

	/**
	 * Reconcile live and dead runners plus verified orphan windows. Window
	 * existence and runner liveness are the only evidence used; no durable
	 * state is assumed except a published terminal result for orphan closure.
	 */
	const runReconcile = async (): Promise<void> => {
		await assertManagerAlive();
		const active = await deps.store.scanActive();

		// 1. Live re-adoption and interrupted detection for started tasks.
		for (const task of active) {
			if (task.state !== "starting" && task.state !== "running") continue;
			if (!task.tmuxWindow) continue;
			const windowExists = await deps.tmux.windowExists(task.tmuxWindow);
			if (windowExists) {
				if (task.state === "starting") {
					const alive =
						typeof task.runnerPid === "number" &&
						(await isProcessAlive(task.runnerPid));
					if (alive) {
						await mutate(task.agentId, { state: "running" });
					}
				}
				continue;
			}
			// Window gone. Only record `interrupted` when no durable result was
			// published; a finished runner already owns its terminal state.
			const durable = await deps.store.readResult(task.agentId);
			if (durable === null) {
				await assertManagerAlive();
				const finishedAt = now();
				await deps.store.publishTerminal(task.agentId, {
					agentId: task.agentId,
					state: "interrupted",
					output: "",
					usage: {
						totalTokens: 0,
						toolUses: 0,
						durationMs: task.startedAt === null
							? 0
							: Math.max(0, finishedAt - task.startedAt),
					},
					finishedAt,
					terminalReason:
						"runner or window disappeared without a durable result",
				});
				await assertManagerAlive();
			}
		}

		// 2. Verified orphan-window closure for completed tasks.
		const windows = await deps.tmux.listAgentWindows();
		for (const win of windows) {
			const agentId = win.name.slice(AGENT_WINDOW_PREFIX.length);
			const manifest = await deps.store.readTask(agentId);
			if (manifest === null) continue;
			if (NON_TERMINAL.includes(manifest.state)) continue;
			const durable = await deps.store.readResult(agentId);
			if (durable === null) continue;
			await deps.tmux.closeVerifiedWindow(win.name, {
				durableResult: true,
			});
		}
	};

	const reconcile = async (): Promise<void> => {
		if (reconcileInFlight === null) {
			reconcileInFlight = runReconcile().finally(() => {
				reconcileInFlight = null;
				if (reconcilePending) {
					reconcilePending = false;
					void reconcile();
				}
			});
		} else {
			reconcilePending = true;
		}
		return reconcileInFlight;
	};

	const pump = async (): Promise<void> => {
		await assertManagerAlive();
		await reconcile();
		await dispatch();
	};

	let loopPromise: Promise<void> | null = null;
	let paused = false;
	let restartResolve: (() => void) | null = null;

	const pumpLoop = async (): Promise<void> => {
		while (!signal.aborted) {
			// `pump()` runs live work (reconcile + dispatch). A throw here means
			// the manager lease is gone or another unrecoverable error occurred;
			// a deliberate `stop` aborts the lifecycle instead of throwing.
			try {
				await pump();
			} catch {
				if (signal.aborted) {
					// Deliberate `stop` interrupted in-flight work: owned work was
					// aborted, so the pump ends stopped with `paused` left false.
					return;
				}
				// Manager gone (or any unrecoverable dispatch error): pause the
				// queue rather than dispatching stale work.
				paused = true;
				await new Promise<void>((resolve) => {
					restartResolve = () => {
						restartResolve = null;
						resolve();
					};
				});
				if (signal.aborted) return;
				paused = false;
				continue;
			}
			if (signal.aborted) break;
			// Idle tick created outside every tool/files call; a clean `stop`
			// aborts it and the loop stops with no mid-work state.
			await tick(pumpInterval);
		}
	};

	const start = (): void => {
		if (loopPromise !== null) return;
		paused = false;
		loopPromise = pumpLoop().then(
			() => undefined,
			() => undefined,
		);
	};

	const stop = async (): Promise<void> => {
		lifecycle.abort();
		const running = loopPromise;
		loopPromise = null;
		restartResolve?.();
		restartResolve = null;
		if (running) await running.catch(() => undefined);
	};

	const snapshot = async (): Promise<SchedulerSnapshot> => {
		const active = await deps.store.scanActive();
		let queued = 0;
		let starting = 0;
		let running = 0;
		for (const task of active) {
			if (task.state === "queued") queued += 1;
			else if (task.state === "starting") starting += 1;
			else if (task.state === "running") running += 1;
		}
		const slotsUsed = occupiedOwnershipTrees(active).size;
		return {
			queued,
			starting,
			running,
			slotsUsed,
			slotsFree: Math.max(0, deps.maxConcurrent - slotsUsed),
			maxConcurrent: deps.maxConcurrent,
			paused,
			generation: deps.managerLease.generation,
			managerOwner: deps.managerLease.owner,
		};
	};

	return Object.freeze<Scheduler>({
		start,
		pump,
		reconcile,
		snapshot,
		stop,
		isPaused: () => paused,
	});
}
