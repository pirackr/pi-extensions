import { randomBytes } from "node:crypto";
import { join } from "node:path";

import type { RunnerInvocation, RunnerRequest } from "./runner.mjs";
import { summarizeAgent, type SummarizerDeps } from "./summarizer.ts";
import { allocateShortId, type CollisionCheck } from "./identity.ts";
import {
	acquireManagerLease as acquireLease,
	type LeaseDeps,
	type ManagerLease,
	withRegistryLock,
} from "./locks.ts";
import {
	createScheduler as buildScheduler,
	descendantIds,
	type Scheduler,
	type SchedulerDeps,
} from "./scheduler.ts";
import type { ArtifactStore } from "./storage.ts";
import type { TmuxClient } from "./tmux.ts";
import type { SubagentConfiguration } from "./config.ts";
import {
	normalizeAgentRequest,
	type AgentManifest,
	type AgentReceipt,
	type AgentRequest,
	type ProfileContribution,
	type ProfilePolicyAdapter,
	type ProfileReservation,
	type ResolvedProfile,
	type ResultResponse,
	type StopResponse,
	type TaskStatus,
	type TerminalResult,
	type Usage,
} from "./types.ts";

const TERMINAL_STATES: readonly TaskStatus[] = [
	"succeeded",
	"failed",
	"timed_out",
	"cancelled",
	"interrupted",
];

const ZERO_USAGE: Usage = {
	totalTokens: 0,
	toolUses: 0,
	durationMs: 0,
};

/** Context captured at manager startup and supplied by each public tool call. */
export interface ManagerCallContext {
	readonly cwd: string;
	readonly origin: string;
	readonly groupId?: string | null;
}

/** Per-call layered configuration and owner-neutral profile discovery result. */
export interface ManagerResolvedCall {
	readonly config: SubagentConfiguration;
	readonly profiles: readonly ResolvedProfile[];
	readonly contributions: readonly ProfileContribution[];
	readonly policyAdapters: Readonly<Record<string, ProfilePolicyAdapter>>;
}

/** Runtime mode: one lease-owning manager or a child process that only produces nested work. */
export type ManagerMode = "manager" | "nested-producer";

/** Injectable dependencies for {@link createSubagentManager}. */
export interface SubagentManagerDeps {
	readonly store: ArtifactStore;
	readonly tmux: TmuxClient;
	readonly managerLockPath: string;
	readonly registryLockPath: string;
	readonly owner: string;
	readonly mode?: ManagerMode;
	readonly currentAgentId?: string | null;
	readonly runnerScriptPath: string;
	readonly nodePath?: string;
	readonly pi: RunnerInvocation;
	readonly resolveCall: (context: ManagerCallContext) => Promise<ManagerResolvedCall>;
	readonly allocateAgentId?: () => Promise<string>;
	readonly generation?: () => string;
	readonly now?: () => number;
	readonly sleep?: (signal: AbortSignal) => Promise<void>;
	readonly pollIntervalMs?: number;
	readonly acquireManagerLease?: typeof acquireLease;
	readonly createScheduler?: (deps: SchedulerDeps) => Scheduler;
	readonly leaseDeps?: LeaseDeps;
	readonly isProcessAlive?: (pid: number) => Promise<boolean>;
	readonly pumpIntervalMs?: number;
}

/** Public durable manager operations consumed by the extension entrypoint and UI. */
export interface SubagentManager {
	start(context: ManagerCallContext): Promise<void>;
	enqueue(
		request: AgentRequest | unknown,
		callContext: ManagerCallContext,
		signal: AbortSignal,
	): Promise<AgentReceipt | ResultResponse>;
	getResult(agentId: string, wait: boolean, signal: AbortSignal): Promise<ResultResponse>;
	stop(agentId: string): Promise<StopResponse>;
	list(): Promise<AgentManifest[]>;
	shutdown(): Promise<void>;
}

function isTerminal(state: TaskStatus): state is TerminalResult["state"] {
	return TERMINAL_STATES.includes(state);
}

function artifactDir(store: ArtifactStore, agentId: string): string {
	return join(store.artifactRoot, "subagents", agentId);
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

function defaultGeneration(): string {
	return randomBytes(12).toString("hex");
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise<void>((resolve, reject) => {
		signal.throwIfAborted();
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

function observerMessage(error: unknown): string | null {
	const message = error instanceof Error ? error.message : String(error);
	return message.startsWith("lock held by ") ? message : null;
}

function receiptFor(
	store: ArtifactStore,
	tmux: TmuxClient,
	task: AgentManifest,
): AgentReceipt {
	const window = task.tmuxWindow;
	return {
		agentId: task.agentId,
		state: task.state,
		tmuxSession: window ? task.tmuxSession ?? tmux.sessionName : null,
		tmuxWindow: window,
		attachCommand: window ? tmux.attachCommand(window) : null,
		artifactDir: artifactDir(store, task.agentId),
	};
}

/** Construct one parent-scoped durable subagent manager. */
export function createSubagentManager(deps: SubagentManagerDeps): SubagentManager {
	const mode = deps.mode ?? "manager";
	const now = deps.now ?? Date.now;
	const generation = deps.generation ?? defaultGeneration;
	const acquireManagerLease = deps.acquireManagerLease ?? acquireLease;
	const createScheduler = deps.createScheduler ?? buildScheduler;
	const lifecycle = new AbortController();
	const sleep = deps.sleep ?? ((signal: AbortSignal) =>
		abortableDelay(deps.pollIntervalMs ?? 25, signal));

	let started = false;
	let shutdownPromise: Promise<void> | null = null;
	let setupError: Error | null = null;
	let observerReason: string | null = null;
	let lease: ManagerLease | null = null;
	let scheduler: Scheduler | null = null;
	let nestedParent: AgentManifest | null = null;
	let maxConcurrent = 1;

	const ensureStarted = (): void => {
		if (!started) throw new Error("subagent manager has not started");
		if (setupError) throw setupError;
		if (lifecycle.signal.aborted) throw new Error("subagent manager is shut down");
	};

	const ensureMutable = (): void => {
		ensureStarted();
		if (observerReason) {
			throw new Error(`subagent manager is observer-only: ${observerReason}`);
		}
	};

	const allocateAgentId = async (): Promise<string> => {
		if (deps.allocateAgentId) return deps.allocateAgentId();
		const collision: CollisionCheck = async (candidate) =>
			(await deps.store.readTask(candidate)) !== null ||
			(mode === "manager" && await deps.tmux.windowExists(`subagent-${candidate}`));
		return allocateShortId(collision, randomBytes);
	};

	const assertManagerCurrent = async (): Promise<void> => {
		if (mode === "manager") {
			if (!lease) throw new Error("manager lease is not held");
			await lease.assertCurrent();
		}
	};

	const consumeResult = async (
		agentId: string,
		signal: AbortSignal,
	): Promise<boolean> => {
		if (observerReason) {
			throw new Error(`subagent manager is observer-only: ${observerReason}`);
		}
		await assertManagerCurrent();
		return withRegistryLock(
			deps.registryLockPath,
			deps.owner,
			async (registryLease) => {
				await registryLease.assertCurrent();
				await assertManagerCurrent();
				const current = await deps.store.readDelivery(agentId);
				if (current?.state !== "consumed") {
					await deps.store.updateDelivery(agentId, {
						state: "consumed",
						consumedAt: now(),
					});
				}
				await assertManagerCurrent();
				await registryLease.assertCurrent();
				return true;
			},
			signal,
			deps.leaseDeps,
		);
	};

	const summarizeIfNeeded = async (
		agentId: string,
		terminal: TerminalResult,
	): Promise<TerminalResult> => {
		if (
			(terminal.state === "timed_out" || terminal.state === "failed") &&
			!terminal.output
		) {
			const dir = artifactDir(deps.store, agentId);
			const summary = await summarizeAgent(dir, {
				nodeBin: deps.nodePath ?? process.execPath,
				runnerPath: deps.runnerScriptPath,
				model: "lemonade/Ornith-1.5-35B-A3B-GGUF-Q4_K_M",
				cwd: process.cwd(),
			});
			if (summary) {
				return { ...terminal, output: summary };
			}
		}
		return terminal;
	};

	const responseFor = async (
		agentId: string,
		task: AgentManifest | null,
		terminal: TerminalResult | null,
		signal: AbortSignal,
	): Promise<ResultResponse> => {
		if (task === null && terminal === null) {
			return {
				agentId,
				state: "failed",
				result: null,
				activity: null,
				elapsedMs: null,
				usage: null,
				tmuxTarget: null,
				artifactDir: null,
				consumed: false,
				notFound: true,
			};
		}

		const live = task as (AgentManifest & { activity?: string | null; usage?: Usage | null }) | null;
		const state = terminal?.state ?? task?.state ?? "failed";
		const consumed = terminal !== null ? await consumeResult(agentId, signal) : false;
		const elapsedBase = task?.startedAt ?? task?.queuedAt ?? null;
		const summarized = terminal ? await summarizeIfNeeded(agentId, terminal) : null;
		return {
			agentId,
			state,
			result: summarized ?? terminal,
			activity: terminal ? null : live?.activity ?? null,
			elapsedMs: terminal ? null : elapsedBase === null ? null : Math.max(0, now() - elapsedBase),
			usage: terminal?.usage ?? live?.usage ?? null,
			tmuxTarget: task?.tmuxWindow ? deps.tmux.targetFor(task.tmuxWindow) : null,
			artifactDir: artifactDir(deps.store, agentId),
			consumed,
			notFound: false,
		};
	};

	const getResult = async (
		agentId: string,
		wait: boolean,
		signal: AbortSignal,
	): Promise<ResultResponse> => {
		ensureStarted();
		for (;;) {
			signal.throwIfAborted();
			const [task, terminal] = await Promise.all([
				deps.store.readTask(agentId),
				deps.store.readResult(agentId),
			]);
			if (task === null && terminal === null) {
				return responseFor(agentId, null, null, signal);
			}
			if (terminal !== null || !wait) {
				return responseFor(agentId, task, terminal, signal);
			}
			await sleep(signal);
		}
	};

	const awaitBackgroundStartup = async (
		agentId: string,
		signal: AbortSignal,
	): Promise<AgentReceipt> => {
		for (;;) {
			signal.throwIfAborted();
			const task = await deps.store.readTask(agentId);
			if (!task) throw new Error(`subagent ${agentId} disappeared after enqueue`);
			if (task.state !== "starting") return receiptFor(deps.store, deps.tmux, task);
			await sleep(signal);
		}
	};

	const start = async (context: ManagerCallContext): Promise<void> => {
		if (started) return;
		if (mode === "nested-producer") {
			const parentId = deps.currentAgentId;
			if (!parentId) throw new Error("nested producer requires a current agent id");
			nestedParent = await deps.store.readTask(parentId);
			if (!nestedParent) throw new Error(`unknown parent subagent ${parentId}`);
			started = true;
			return;
		}

		await deps.store.initializeParent();
		try {
			await deps.tmux.ensureParentSession();
		} catch (error) {
			setupError = error instanceof Error ? error : new Error(String(error));
			started = true;
			return;
		}

		try {
			lease = await acquireManagerLease(
				deps.managerLockPath,
				deps.owner,
				lifecycle.signal,
				deps.leaseDeps,
			);
		} catch (error) {
			const held = observerMessage(error);
			if (held === null) throw error;
			observerReason = held;
			started = true;
			return;
		}

		const initial = await deps.resolveCall(context);
		maxConcurrent = initial.config.maxConcurrent;
		const schedulerInput: SchedulerDeps = {
			store: deps.store,
			tmux: deps.tmux,
			managerLease: lease,
			get maxConcurrent() {
				return maxConcurrent;
			},
			registryLockPath: deps.registryLockPath,
			owner: deps.owner,
			signal: lifecycle.signal,
			leaseDeps: deps.leaseDeps,
			pumpIntervalMs: deps.pumpIntervalMs,
			now,
			isProcessAlive: deps.isProcessAlive,
			cwd: context.cwd,
			launchCommandFor: (task) => {
				const requestPath = join(artifactDir(deps.store, task.agentId), "request.json");
				return [
					shellQuote(deps.nodePath ?? process.execPath),
					shellQuote(deps.runnerScriptPath),
					shellQuote(requestPath),
				].join(" ");
			},
			policyAdapters: initial.policyAdapters,
		};
		scheduler = createScheduler(schedulerInput);
		started = true;
		scheduler.start();
	};

	const enqueue = async (
		input: AgentRequest | unknown,
		callContext: ManagerCallContext,
		signal: AbortSignal,
	): Promise<AgentReceipt | ResultResponse> => {
		ensureMutable();
		const raw = normalizeAgentRequest(input);
		const request = {
			...raw,
			subagent_type: raw.subagent_type ?? "general-purpose",
		};
		if (mode === "nested-producer" && request.run_in_background) {
			throw new Error("nested subagents must run in the foreground");
		}
		signal.throwIfAborted();

		const resolved = await deps.resolveCall(callContext);
		maxConcurrent = resolved.config.maxConcurrent;
		const profile = resolved.profiles.find((candidate) => candidate.name === request.subagent_type);
		if (!profile) {
			const available = resolved.profiles.map((candidate) => `${candidate.name}: ${candidate.description}`).join(", ");
			throw new Error(`unknown subagent profile ${request.subagent_type}; available: ${available}`);
		}

		const agentId = await allocateAgentId();
		const queuedAt = now();
		const parentAgentId = mode === "nested-producer" ? nestedParent!.agentId : null;
		const ownershipTreeId = mode === "nested-producer" ? nestedParent!.ownershipTreeId : agentId;
		const origin = mode === "nested-producer" ? nestedParent!.origin : callContext.origin;
		const groupId = request.run_in_background ? callContext.groupId ?? null : null;
		const baseManifest: Omit<AgentManifest, "sequence"> = {
			schema: 1,
			generation: generation(),
			revision: 1,
			parentId: deps.store.identity.id,
			agentId,
			parentAgentId,
			ownershipTreeId,
			origin,
			groupId,
			description: request.description,
			prompt: request.prompt,
			profile,
			state: "queued",
			queuedAt,
			startedAt: null,
			heartbeatAt: null,
			finishedAt: null,
			runnerPid: null,
			processStart: "",
			tmuxSession: null,
			tmuxWindow: null,
			timeoutSeconds: profile.timeoutSeconds,
			terminalReason: null,
		};

		let published!: AgentManifest;
		await withRegistryLock(
			deps.registryLockPath,
			deps.owner,
			async (registryLease) => {
				await registryLease.assertCurrent();
				await assertManagerCurrent();
				const all = await deps.store.scanAll();
				const sequence = all.reduce((highest, task) => Math.max(highest, task.sequence), 0) + 1;
				const owner = resolved.contributions.find((item) => item.profile.name === profile.name)?.owner;
				const adapter = owner ? resolved.policyAdapters[owner] : undefined;
				// Capture the owner's durable reservation immediately before publication.
				// An owner policy returning undefined denied admission, so no unreserved
				// durable task may be published for that contributed profile.
				let reservation: ProfileReservation | undefined;
				if (adapter) {
					reservation = await adapter.reserve(owner!, profile.name, agentId);
					if (!reservation) {
						throw new Error(`policy '${owner}' rejected profile '${profile.name}'`);
					}
				}

				published = { ...baseManifest, sequence, reservation: reservation ?? null };
				const runnerRequest: RunnerRequest = {
					schema: 1,
					parentId: published.parentId,
					agentId,
					parentAgentId,
					origin,
					groupId,
					sequence,
					queuedAt,
					description: request.description,
					prompt: request.prompt,
					artifactRoot: deps.store.artifactRoot,
					cwd: callContext.cwd,
					profile,
					pi: deps.pi,
					childExtensions: resolved.config.childExtensions,
					loadContextFiles: resolved.config.loadContextFiles,
					webSearchMaxLookups: resolved.config.webSearchMaxLookups,
					webSearchMaxFetches: resolved.config.webSearchMaxFetches,
					reservation: reservation ?? null,
				};
				await deps.store.enqueue(published, runnerRequest as unknown as Record<string, unknown>);
				await assertManagerCurrent();
				await registryLease.assertCurrent();
			},
			signal,
			deps.leaseDeps,
		);

		if (mode === "manager" && scheduler) await scheduler.pump();
		if (request.run_in_background) return awaitBackgroundStartup(agentId, signal);
		return getResult(agentId, true, signal);
	};

	const stop = async (agentId: string): Promise<StopResponse> => {
		ensureMutable();
		return withRegistryLock(
			deps.registryLockPath,
			deps.owner,
			async (registryLease) => {
				await registryLease.assertCurrent();
				await assertManagerCurrent();
				const all = await deps.store.scanAll();
				const root = all.find((task) => task.agentId === agentId);
				if (!root) throw new Error(`unknown subagent ${agentId}`);
				const ordered = [...descendantIds(agentId, all), agentId];
				let responseState = root.state;
				let stopped = false;
				for (const id of ordered) {
					const task = await deps.store.readTask(id);
					if (!task || isTerminal(task.state)) continue;
					if (task.state === "queued") {
						await deps.store.publishTerminal(id, {
							agentId: id,
							state: "cancelled",
							output: "",
							usage: ZERO_USAGE,
							finishedAt: now(),
							terminalReason: "cancelled before start",
						});
						if (id === agentId) responseState = "cancelled";
						stopped = true;
					} else {
						await deps.store.requestCancellation(id);
						stopped = true;
					}
				}
				await assertManagerCurrent();
				await registryLease.assertCurrent();
				return {
					agentId,
					state: responseState,
					stopped,
					message: stopped ? "stop requested" : "subagent is already terminal",
				};
			},
			lifecycle.signal,
			deps.leaseDeps,
		);
	};

	const list = async (): Promise<AgentManifest[]> => {
		if (!started) throw new Error("subagent manager has not started");
		return deps.store.scanAll();
	};

	const shutdown = async (): Promise<void> => {
		if (shutdownPromise) return shutdownPromise;
		shutdownPromise = (async () => {
			if (scheduler) await scheduler.stop();
			lifecycle.abort(new Error("subagent manager shut down"));
			if (lease) await lease.release();
		})();
		return shutdownPromise;
	};

	return { start, enqueue, getResult, stop, list, shutdown };
}
