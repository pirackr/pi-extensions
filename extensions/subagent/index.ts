import { randomBytes } from "node:crypto";
import { lstat, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
	ExtensionAPI,
	ExtensionContext,
	Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
	discoverProfiles,
	loadSubagentConfiguration,
} from "./config.ts";
import { projectSlug, resolveParentIdentity } from "./identity.ts";
import {
	acquireManagerLease,
	type ManagerLease,
} from "./locks.ts";
import {
	createSubagentManager,
	type ManagerCallContext,
	type ManagerResolvedCall,
	type SubagentManager,
} from "./manager.ts";
import {
	createNotificationCoordinator,
	type NotificationCoordinator,
} from "./notifications.ts";
import {
	countAgents,
	createToolRenderers,
	renderFooter,
	renderNotificationMessage,
	renderWidgetLines,
	runAgentsCommand,
	stopSummary,
	type AgentWidgetRow,
	type AgentsCommandContext,
} from "./render.ts";
import {
	createScheduler,
	type Scheduler,
	type SchedulerDeps,
} from "./scheduler.ts";
import { createArtifactStore } from "./storage.ts";
import {
	createTmuxClient,
	nodeTmuxExecutor,
	type TmuxExecFile,
} from "./tmux.ts";
import {
	normalizeAgentRequest,
	type AgentManifest,
	type AgentReceipt,
	type NotificationItem,
	type ProfilePolicyAdapter,
	type ResultResponse,
	type TaskStatus,
} from "./types.ts";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));
const TERMINAL_STATES = new Set<TaskStatus>([
	"succeeded",
	"failed",
	"timed_out",
	"cancelled",
	"interrupted",
]);
const WIDGET_KEY = "subagent-agents";
const DEFAULT_WIDGET_WIDTH = 100;
const POLL_MS = 250;

type Environment = Readonly<Record<string, string | undefined>>;

export interface RuntimeFactoryContext {
	readonly pi: ExtensionAPI;
	readonly context: ExtensionContext;
	readonly nested: boolean;
	readonly env: Environment;
	readonly getContext: () => ExtensionContext;
	readonly onTasksChanged: () => Promise<void>;
}

/**
 * Lifecycle seam owned by the entrypoint. `initialize` obtains durable
 * ownership with dispatch deferred; the entrypoint then restores UI and
 * recovers deliveries before `activate` starts queue dispatch.
 */
export interface ExtensionRuntime {
	readonly mode: "manager" | "nested-producer";
	readonly manager: SubagentManager;
	coordinator: NotificationCoordinator | null;
	initialize(context: ManagerCallContext): Promise<void>;
	activate(): void;
	shutdown(): Promise<void>;
}

export interface InstallSubagentOptions {
	readonly createRuntime?: (
		context: RuntimeFactoryContext,
	) => Promise<ExtensionRuntime>;
	readonly env?: Environment;
}

const AgentParameters = Type.Object(
	{
		description: Type.String({
			minLength: 1,
			description: "Short UI label; do not repeat the full prompt.",
		}),
		prompt: Type.String({
			minLength: 1,
			description: "Complete, self-contained task contract.",
		}),
		subagent_type: Type.String({
			minLength: 1,
			description: "Configured subagent profile name.",
		}),
		run_in_background: Type.Optional(Type.Boolean({
			description: "Return a durable receipt instead of waiting. Defaults to true.",
		})),
	},
	{ additionalProperties: false },
);

const GetResultParameters = Type.Object(
	{
		agent_id: Type.String({ minLength: 1 }),
		wait: Type.Optional(Type.Boolean({
			description: "Wait interruptibly for a terminal result. Defaults to false.",
		})),
	},
	{ additionalProperties: false },
);

const StopParameters = Type.Object(
	{ agent_id: Type.String({ minLength: 1 }) },
	{ additionalProperties: false },
);

function abortSignal(signal: AbortSignal | undefined): AbortSignal {
	return signal ?? new AbortController().signal;
}

function isResultResponse(
	value: AgentReceipt | ResultResponse,
): value is ResultResponse {
	return "result" in value;
}

function receiptText(receipt: AgentReceipt): string {
	const lines = [
		`subagent-${receipt.agentId}: ${receipt.state}`,
		`Parent tmux: ${receipt.tmuxSession ?? "not started"}`,
		`Window: ${receipt.tmuxWindow ?? "not started"}`,
		`Attach: ${receipt.attachCommand ?? "not available"}`,
		`Artifacts: ${receipt.artifactDir ?? "not available"}`,
	];
	return lines.join("\n");
}

function resultText(response: ResultResponse): string {
	if (response.notFound) return `Unknown subagent: ${response.agentId}`;
	if (response.result) return response.result.output;
	const usage = response.usage
		? `${response.usage.toolUses} tools, ${response.usage.totalTokens} tokens`
		: "usage unavailable";
	return `subagent-${response.agentId}: ${response.state}\n${response.activity ?? "waiting"}\n${usage}\nArtifacts: ${response.artifactDir ?? "not available"}`;
}

function toolResult(value: AgentReceipt | ResultResponse) {
	return {
		content: [{
			type: "text" as const,
			text: isResultResponse(value) ? resultText(value) : receiptText(value),
		}],
		details: value,
	};
}

function terminal(state: TaskStatus): boolean {
	return TERMINAL_STATES.has(state);
}

function depthFor(
	manifest: AgentManifest,
	byId: ReadonlyMap<string, AgentManifest>,
): number {
	let depth = 0;
	let parent = manifest.parentAgentId;
	const seen = new Set<string>([manifest.agentId]);
	while (parent && !seen.has(parent)) {
		seen.add(parent);
		depth++;
		parent = byId.get(parent)?.parentAgentId ?? null;
	}
	return depth;
}

function widgetRows(manifests: readonly AgentManifest[]): AgentWidgetRow[] {
	const byId = new Map(manifests.map((item) => [item.agentId, item]));
	return manifests.map((item) => ({
		agentId: item.agentId,
		parentAgentId: item.parentAgentId,
		depth: depthFor(item, byId),
		profile: item.profile.name,
		description: item.description,
		state: item.state,
		startedAt: item.startedAt,
		finishedAt: item.finishedAt,
		timeoutSeconds: item.timeoutSeconds,
		toolUses: 0,
		totalTokens: 0,
		activity: null,
	}));
}

function xmlText(value: string): string {
	return value
		.replaceAll("&lt;", "<")
		.replaceAll("&gt;", ">")
		.replaceAll("&quot;", '"')
		.replaceAll("&apos;", "'")
		.replaceAll("&amp;", "&");
}

function tag(block: string, name: string): string {
	const match = block.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`));
	return xmlText(match?.[1]?.trim() ?? "");
}

function notificationItems(xml: string): NotificationItem[] {
	const items: NotificationItem[] = [];
	for (const match of xml.matchAll(
		/<task-notification>([\s\S]*?)<\/task-notification>/g,
	)) {
		const block = match[1];
		const state = tag(block, "status") as TaskStatus;
		if (!terminal(state)) continue;
		items.push({
			agentId: tag(block, "task-id"),
			state: state as NotificationItem["state"],
			summary: tag(block, "summary"),
			output: "",
			usage: {
				totalTokens: Number(tag(block, "total_tokens")) || 0,
				toolUses: Number(tag(block, "tool_uses")) || 0,
				durationMs: Number(tag(block, "duration_ms")) || 0,
			},
		});
	}
	return items;
}

/** Register tools and lifecycle without performing startup I/O. */
export function installSubagentExtension(
	pi: ExtensionAPI,
	options: InstallSubagentOptions = {},
): void {
	const env = options.env ?? process.env;
	const createRuntime = options.createRuntime ?? createProductionRuntime;
	const nested = env.PI_SUBAGENT === "1";
	const renderers = createToolRenderers();
	const dismissedTerminal = new Set<string>();
	let currentGroupId: string | null = null;
	let activeContext: ExtensionContext | null = null;
	let runtimePromise: Promise<ExtensionRuntime> | null = null;
	let shutdownPromise: Promise<void> | null = null;

	const runtimeIfStarted = async (): Promise<ExtensionRuntime | null> =>
		runtimePromise ? runtimePromise : null;

	const requireRuntime = async (): Promise<ExtensionRuntime> => {
		if (!runtimePromise) throw new Error("subagent manager has not started");
		return runtimePromise;
	};

	const refreshUI = async (
		runtimeOverride?: ExtensionRuntime,
	): Promise<void> => {
		const ctx = activeContext;
		const runtime = runtimeOverride ?? await runtimeIfStarted();
		if (!ctx || !runtime || ctx.mode !== "tui") return;
		const all = await runtime.manager.list();
		const visible = all.filter((item) => !dismissedTerminal.has(item.agentId));
		ctx.ui.setWidget(
			WIDGET_KEY,
			renderWidgetLines(widgetRows(visible), {
				frame: 0,
				width: DEFAULT_WIDGET_WIDTH,
				now: Date.now(),
			}),
			{ placement: "aboveEditor" },
		);
		ctx.ui.setStatus(WIDGET_KEY, renderFooter(countAgents(all)));
	};

	pi.registerTool({
		name: "Agent",
		label: "Agent",
		description: nested
			? "Run one nested subagent in the foreground. Set run_in_background to false."
			: "Run one independently scoped subagent. Background execution defaults to true.",
		parameters: AgentParameters,
		renderCall: renderers.renderCall as never,
		renderResult: (result, renderOptions, theme, context) => {
			const value = result.details as AgentReceipt | ResultResponse | undefined;
			return value
				? renderers.renderResult(value, renderOptions, theme as never, context)
				: new Text(result.content.map((part) => part.text).join("\n"), 0, 0);
		},
		execute: async (_toolCallId, raw, signal, _onUpdate, ctx) => {
			const runtime = await requireRuntime();
			const request = normalizeAgentRequest(raw);
			if (runtime.mode === "nested-producer" && request.run_in_background) {
				throw new Error(
					"Nested subagents must run in the foreground; set run_in_background to false.",
				);
			}
			const response = await runtime.manager.enqueue(
				request,
				{
					cwd: ctx.cwd,
					origin: ctx.sessionManager.getSessionId(),
					groupId: request.run_in_background ? currentGroupId : null,
				},
				abortSignal(signal),
			);
			await refreshUI();
			return toolResult(response);
		},
	});

	pi.registerTool({
		name: "get_subagent_result",
		label: "Get subagent result",
		description: "Inspect live state or retrieve and consume a durable terminal result.",
		parameters: GetResultParameters,
		execute: async (
			_toolCallId,
			raw,
			signal,
			_onUpdate,
			_ctx,
		) => {
			const params = raw as { agent_id: string; wait?: boolean };
			const runtime = await requireRuntime();
			const response = await runtime.manager.getResult(
				params.agent_id,
				params.wait ?? false,
				abortSignal(signal),
			);
			return toolResult(response);
		},
	});

	pi.registerTool({
		name: "stop_subagent",
		label: "Stop subagent",
		description: "Cancel queued work or request cancellation of a running subagent.",
		parameters: StopParameters,
		execute: async (_toolCallId, raw) => {
			const params = raw as { agent_id: string };
			const runtime = await requireRuntime();
			const response = await runtime.manager.stop(params.agent_id);
			await refreshUI();
			return {
				content: [{ type: "text" as const, text: stopSummary(response) }],
				details: response,
			};
		},
	});

	pi.registerCommand("agents", {
		description: "Inspect and control durable subagents.",
		handler: async (_args, ctx) => {
			const runtime = await requireRuntime();
			if (ctx.mode === "tui") {
				try {
					await runAgentsCommand(
						ctx as unknown as AgentsCommandContext,
						runtime.manager,
					);
				} catch (error) {
					ctx.ui.notify(
						`Unable to open agents: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
				return;
			}
			const items = await runtime.manager.list();
			ctx.ui.notify(
				items.length === 0
					? "No subagents."
					: items.map((item) =>
						`subagent-${item.agentId} ${item.profile.name}: ${item.description} [${item.state}]`
					).join("\n"),
			);
		},
	});

	pi.registerMessageRenderer(
		"subagent-notification",
		(message, renderOptions, theme: Theme) => {
			const items = typeof message.content === "string"
				? notificationItems(message.content)
				: [];
			const text = items.length > 0
				? renderNotificationMessage(items)
				: "Subagent task update";
			return new Text(theme.fg("muted", text), renderOptions.outputPad, 0);
		},
	);

	pi.on("session_start", async (_event, ctx) => {
		activeContext = ctx;
		currentGroupId = null;
		if (!runtimePromise) {
			runtimePromise = (async () => {
				const runtime = await createRuntime({
					pi,
					context: ctx,
					nested,
					env,
					getContext: () => activeContext ?? ctx,
					onTasksChanged: refreshUI,
				});
				await runtime.initialize({
					cwd: ctx.cwd,
					origin: ctx.sessionManager.getSessionId(),
					groupId: null,
				});
				await refreshUI(runtime);
				await runtime.coordinator?.recover();
				runtime.activate();
				return runtime;
			})();
			await runtimePromise;
			return;
		}
		const runtime = await runtimePromise;
		await refreshUI();
		await runtime.coordinator?.recover();
	});

	pi.on("turn_start", async (event: unknown) => {
		const runtime = await runtimeIfStarted();
		if (!runtime?.coordinator) return;
		const turnIndex = (event as { turnIndex?: number }).turnIndex ?? 0;
		currentGroupId = await runtime.coordinator.turnStart(turnIndex);
	});

	pi.on("turn_end", async () => {
		const runtime = await runtimeIfStarted();
		await runtime?.coordinator?.turnEnd();
		currentGroupId = null;
		await refreshUI();
	});

	pi.on("input", async (_event, ctx) => {
		activeContext = ctx;
		const runtime = await runtimeIfStarted();
		if (runtime && ctx.mode === "tui") {
			for (const item of await runtime.manager.list()) {
				if (terminal(item.state)) dismissedTerminal.add(item.agentId);
			}
			await refreshUI();
		}
		return { action: "continue" as const };
	});

	pi.on("session_shutdown", async () => {
		if (!shutdownPromise) {
			shutdownPromise = (async () => {
				const runtime = await runtimeIfStarted();
				if (runtime) await runtime.shutdown();
				const ctx = activeContext;
				if (ctx?.mode === "tui") {
					ctx.ui.setWidget(WIDGET_KEY, undefined);
					ctx.ui.setStatus(WIDGET_KEY, undefined);
				}
			})();
		}
		await shutdownPromise;
	});
}

interface NestedEnvironment {
	readonly parentId: string;
	readonly agentId: string;
	readonly artifactRoot: string;
}

function nestedEnvironment(env: Environment): NestedEnvironment {
	const parentId = env.PI_SUBAGENT_PARENT;
	const agentId = env.PI_SUBAGENT_AGENT;
	const artifactRoot = env.PI_SUBAGENT_ARTIFACT_ROOT;
	if (!parentId || !agentId || !artifactRoot) {
		throw new Error(
			"PI_SUBAGENT=1 requires PI_SUBAGENT_PARENT, PI_SUBAGENT_AGENT, and PI_SUBAGENT_ARTIFACT_ROOT",
		);
	}
	return { parentId, agentId, artifactRoot: resolve(artifactRoot) };
}

function piInvocation(): { command: string; args: string[] } {
	return {
		command: process.execPath,
		args: process.argv[1] ? [process.argv[1]] : [],
	};
}

function childConfig<T extends { childExtensions: string[] }>(
	config: T,
): T {
	const own = join(EXTENSION_DIR, "index.ts");
	return {
		...config,
		childExtensions: [...new Set([...config.childExtensions, own])],
	};
}

function resolvedCall(
	pi: ExtensionAPI,
	context: ExtensionContext,
	call: ManagerCallContext,
): ManagerResolvedCall {
	const loaded = loadSubagentConfiguration(EXTENSION_DIR, {
		projectRoot: call.cwd,
		projectTrusted: context.isProjectTrusted(),
	});
	const discovered = discoverProfiles(pi, loaded, {
		cwd: call.cwd,
		projectTrusted: context.isProjectTrusted(),
	});
	return {
		config: childConfig(loaded.config),
		profiles: discovered.profiles,
		contributions: discovered.contributions,
		policyAdapters: Object.create(null) as Readonly<
			Record<string, ProfilePolicyAdapter>
		>,
	};
}

function deferredSchedulerFactory(): {
	create(deps: SchedulerDeps): Scheduler;
	activate(): void;
} {
	let scheduler: Scheduler | null = null;
	let startRequested = false;
	return {
		create(deps) {
			scheduler = createScheduler(deps);
			return {
				pump: () => scheduler!.pump(),
				reconcile: () => scheduler!.reconcile(),
				snapshot: () => scheduler!.snapshot(),
				start: () => {
					startRequested = true;
				},
				stop: () => scheduler!.stop(),
				isPaused: () => scheduler!.isPaused(),
			};
		},
		activate() {
			if (startRequested) scheduler?.start();
		},
	};
}

async function tmuxSession(exec: TmuxExecFile): Promise<string | null> {
	if (!process.env.TMUX) return null;
	try {
		const result = await exec(["display-message", "-p", "#S"]);
		return result.stdout.trim() || null;
	} catch {
		return null;
	}
}

async function pathExists(path: string): Promise<boolean> {
	try {
		await lstat(path);
		return true;
	} catch {
		return false;
	}
}

/** Build the real parent or nested-producer runtime from existing subsystems. */
export async function createProductionRuntime(
	factory: RuntimeFactoryContext,
): Promise<ExtensionRuntime> {
	const { context, env, pi } = factory;
	const tmuxExec = nodeTmuxExecutor();
	let identity;
	let mode: ExtensionRuntime["mode"];
	let currentAgentId: string | undefined;

	if (factory.nested) {
		const nested = nestedEnvironment(env);
		const projectDirectory = dirname(nested.artifactRoot);
		identity = {
			id: nested.parentId,
			tmuxSession: `pi-${nested.parentId}`,
			tmpRoot: dirname(projectDirectory),
			projectSlug: projectDirectory.slice(dirname(projectDirectory).length + 1),
			artifactRoot: nested.artifactRoot,
		} as const;
		mode = "nested-producer";
		currentAgentId = nested.agentId;
	} else {
		const canonicalCwd = await realpath(context.cwd).catch(() => context.cwd);
		const slug = projectSlug(canonicalCwd);
		const current = await tmuxSession(tmuxExec);
		identity = await resolveParentIdentity({
			cwd: canonicalCwd,
			projectSlug: slug,
			tmuxCurrentSession: () => current,
			readSessionId: () => env.PI_SESSION_ID ?? null,
			collisionFor: async (id) => {
				if (await pathExists(join("/tmp", slug, `pi-${id}`))) return true;
				try {
					await tmuxExec(["has-session", "-t", `pi-${id}`]);
					return true;
				} catch {
					return false;
				}
			},
		});
		mode = "manager";
	}

	const store = createArtifactStore(identity);
	const tmux = createTmuxClient(tmuxExec, identity.id);
	const managerLockPath = join(identity.artifactRoot, "manager.lock");
	const registryLockPath = join(identity.artifactRoot, "registry.lock");
	const owner = mode === "manager"
		? `parent-${identity.id}`
		: `nested-${currentAgentId}`;
	const deferred = deferredSchedulerFactory();
	let managerLease: ManagerLease | null = null;
	const scheduled = new Set<ReturnType<typeof setTimeout>>();
	let pollTimer: ReturnType<typeof setTimeout> | null = null;
	let stopped = false;
	let coordinator: NotificationCoordinator | null = null;

	const manager = createSubagentManager({
		store,
		tmux,
		managerLockPath,
		registryLockPath,
		owner,
		mode,
		currentAgentId,
		runnerScriptPath: join(EXTENSION_DIR, "runner.mjs"),
		pi: piInvocation(),
		resolveCall: async (call) => resolvedCall(pi, factory.getContext(), call),
		createScheduler: mode === "manager" ? deferred.create : undefined,
		acquireManagerLease: async (path, leaseOwner, signal, deps, options) => {
			const lease = await acquireManagerLease(
				path,
				leaseOwner,
				signal,
				deps,
				options,
			);
			managerLease = lease;
			return lease;
		},
	});

	const runtime: ExtensionRuntime = {
		mode,
		manager,
		coordinator,
		async initialize(call) {
			await manager.start(call);
			if (mode === "nested-producer" || !managerLease) return;
			const config = loadSubagentConfiguration(EXTENSION_DIR, {
				projectRoot: call.cwd,
				projectTrusted: factory.getContext().isProjectTrusted(),
			}).config;
			coordinator = createNotificationCoordinator({
				store,
				pi: {
					sendMessage: async (message, options) => {
						pi.sendMessage(message, options);
					},
				},
				registryLockPath,
				owner,
				activeOrigin: () => factory.getContext().sessionManager.getSessionId(),
				managerGeneration: managerLease.generation,
				assertManagerCurrent: () => managerLease!.assertCurrent(),
				nonce: () => randomBytes(12).toString("hex"),
				now: Date.now,
				groupWaitMs: config.notificationGroupWaitSeconds * 1_000,
				schedule: (callback, delayMs) => {
					const handle = setTimeout(() => {
						scheduled.delete(handle);
						void callback().catch(() => undefined);
					}, delayMs);
					scheduled.add(handle);
					return handle;
				},
				cancelScheduled: (handle) => {
					clearTimeout(handle as ReturnType<typeof setTimeout>);
					scheduled.delete(handle as ReturnType<typeof setTimeout>);
				},
			});
			runtime.coordinator = coordinator;
		},
		activate() {
			if (mode !== "manager") return;
			deferred.activate();
			const poll = async (): Promise<void> => {
				if (stopped) return;
				try {
					const tasks = await manager.list();
					for (const task of tasks) {
						if (terminal(task.state)) await coordinator?.evaluate(task.agentId);
					}
					await factory.onTasksChanged();
				} catch {
					// A stale manager generation stops delivery mutation in the
					// coordinator; the durable result remains directly retrievable.
				}
				if (!stopped) pollTimer = setTimeout(() => void poll(), POLL_MS);
			};
			pollTimer = setTimeout(() => void poll(), POLL_MS);
		},
		async shutdown() {
			if (stopped) return;
			stopped = true;
			if (pollTimer) clearTimeout(pollTimer);
			pollTimer = null;
			for (const handle of scheduled) clearTimeout(handle);
			scheduled.clear();
			await manager.shutdown();
		},
	};

	return runtime;
}

export default function subagentExtension(pi: ExtensionAPI): void {
	installSubagentExtension(pi);
}
