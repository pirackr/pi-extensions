import { describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-coding-agent", () => ({
	CONFIG_DIR_NAME: ".pi",
	getAgentDir: () => "/tmp/pi-agent-test",
	parseFrontmatter: () => ({ frontmatter: {}, body: "" }),
}));

import {
	installSubagentExtension,
	type ExtensionRuntime,
	type RuntimeFactoryContext,
} from "../index.ts";
import type { NotificationCoordinator } from "../notifications.ts";
import type { SubagentManager } from "../manager.ts";
import type {
	AgentManifest,
	AgentReceipt,
	ResultResponse,
	StopResponse,
} from "../types.ts";

const signal = new AbortController().signal;

function manifest(
	agentId: string,
	state: AgentManifest["state"],
	parentAgentId: string | null = null,
): AgentManifest {
	const now = 100;
	return {
		schema: 1,
		generation: "generation-1",
		revision: 1,
		parentId: "p001",
		agentId,
		parentAgentId,
		ownershipTreeId: parentAgentId ? "a001" : agentId,
		origin: "conversation-1",
		groupId: null,
		description: `task ${agentId}`,
		prompt: `prompt ${agentId}`,
		profile: {
			name: "worker",
			description: "worker",
			model: "test/model",
			thinking: "medium",
			tools: ["read"],
			timeoutSeconds: 60,
			systemPrompt: "", 
			source: "bundled",
			access: "read",
		},
		state,
		sequence: 1,
		queuedAt: now,
		startedAt: state === "queued" ? null : now,
		heartbeatAt: state === "running" ? now : null,
		finishedAt: ["succeeded", "failed", "timed_out", "cancelled", "interrupted"].includes(state)
			? now
			: null,
		runnerPid: state === "running" ? 42 : null,
		processStart: state === "running" ? "42:1" : "",
		tmuxSession: state === "running" ? "pi-p001" : null,
		tmuxWindow: state === "running" ? `subagent-${agentId}` : null,
		timeoutSeconds: 60,
		terminalReason: null,
	};
}

function receipt(state: AgentReceipt["state"] = "running"): AgentReceipt {
	return {
		agentId: "a001",
		state,
		tmuxSession: state === "running" ? "pi-p001" : null,
		tmuxWindow: state === "running" ? "subagent-a001" : null,
		attachCommand: state === "running"
			? "tmux attach -t pi-p001 \\; select-window -t subagent-a001"
			: null,
		artifactDir: "/tmp/project/pi-p001/subagents/a001",
	};
}

function result(): ResultResponse {
	return {
		agentId: "a001",
		state: "succeeded",
		activity: null,
		elapsedMs: 25,
		usage: { totalTokens: 10, toolUses: 2, durationMs: 25 },
		tmuxTarget: "pi-p001:subagent-a001",
		artifactDir: "/tmp/project/pi-p001/subagents/a001",
		consumed: true,
		result: {
			agentId: "a001",
			state: "succeeded",
			output: "complete output",
			usage: { totalTokens: 10, toolUses: 2, durationMs: 25 },
			finishedAt: 125,
			terminalReason: null,
		},
		notFound: false,
	};
}

interface FakeUI {
	widgets: Map<string, string[] | undefined>;
	statuses: Map<string, string | undefined>;
	notifications: string[];
	setWidget(key: string, content: string[] | undefined): void;
	setStatus(key: string, content: string | undefined): void;
	notify(message: string): void;
}

function fakeContext(
	mode: "tui" | "rpc" | "json" | "print" = "tui",
	sessionId = "conversation-1",
) {
	const ui: FakeUI = {
		widgets: new Map(),
		statuses: new Map(),
		notifications: [],
		setWidget(key, content) {
			this.widgets.set(key, content);
		},
		setStatus(key, content) {
			this.statuses.set(key, content);
		},
		notify(message) {
			this.notifications.push(message);
		},
	};
	return {
		mode,
		hasUI: mode === "tui",
		cwd: "/work/project",
		ui,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionName: () => undefined,
			getEntries: () => [],
			getBranch: () => [],
		},
		isProjectTrusted: () => true,
	};
}

function harness(options: {
	mode?: ExtensionRuntime["mode"];
	manifests?: AgentManifest[];
	startBlocked?: Promise<void>;
} = {}) {
	const calls: string[] = [];
	let listed = options.manifests ?? [manifest("a001", "running")];
	const enqueue = vi.fn(async () => receipt());
	const getResult = vi.fn(async () => result());
	const stopResponse: StopResponse = {
		agentId: "a001",
		state: "cancelled",
		stopped: true,
		message: "stop requested",
	};
	const stop = vi.fn(async () => stopResponse);
	const manager: SubagentManager = {
		start: vi.fn(async () => undefined),
		enqueue,
		getResult,
		stop,
		list: vi.fn(async () => listed),
		shutdown: vi.fn(async () => undefined),
	};
	const coordinator: NotificationCoordinator = {
		turnStart: vi.fn(async (turn: number) => {
			calls.push(`turn:${turn}`);
			return `turn-${turn}-nonce`;
		}),
		turnEnd: vi.fn(async () => {
			calls.push("turn-end");
		}),
		evaluate: vi.fn(async () => undefined),
		consume: vi.fn(async () => undefined),
		recover: vi.fn(async () => {
			calls.push("recover");
		}),
	};
	let resolveStart!: () => void;
	const startGate = options.startBlocked ?? new Promise<void>((resolve) => {
		resolveStart = resolve;
	});
	if (options.startBlocked) resolveStart = () => undefined;
	const runtime: ExtensionRuntime = {
		mode: options.mode ?? "manager",
		manager,
		coordinator: options.mode === "nested-producer" ? null : coordinator,
		initialize: vi.fn(async () => {
			calls.push("initialize");
		}),
		activate: vi.fn(() => {
			calls.push("activate");
		}),
		shutdown: vi.fn(async () => {
			calls.push("shutdown-begin");
			await startGate;
			calls.push("shutdown-end");
		}),
	};
	const tools = new Map<string, any>();
	const commands = new Map<string, any>();
	const handlers = new Map<string, Array<(event: any, ctx: any) => any>>();
	const renderers = new Map<string, any>();
	const pi = {
		registerTool(tool: any) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, command: any) {
			commands.set(name, command);
		},
		registerMessageRenderer(name: string, renderer: any) {
			renderers.set(name, renderer);
		},
		on(name: string, handler: (event: any, ctx: any) => any) {
			const bucket = handlers.get(name) ?? [];
			bucket.push(handler);
			handlers.set(name, bucket);
		},
		sendMessage: vi.fn(),
		events: { emit: vi.fn(), on: vi.fn() },
	};
	const factory = vi.fn(async (_ctx: RuntimeFactoryContext) => runtime);
	installSubagentExtension(pi as never, {
		createRuntime: factory,
		env: options.mode === "nested-producer" ? { PI_SUBAGENT: "1" } : {},
	});
	return {
		pi,
		tools,
		commands,
		handlers,
		renderers,
		runtime,
		manager,
		coordinator,
		calls,
		factory,
		setListed(value: AgentManifest[]) {
			listed = value;
		},
		resolveShutdown: resolveStart,
	};
}

async function emit(
	h: ReturnType<typeof harness>,
	name: string,
	event: any,
	ctx: any,
): Promise<any[]> {
	return Promise.all((h.handlers.get(name) ?? []).map((handler) => handler(event, ctx)));
}

describe("Task 12 extension integration", () => {
	it("registers exactly the public tools, /agents, notification renderer, and lifecycle handlers", () => {
		const h = harness();
		expect([...h.tools.keys()]).toEqual([
			"Agent",
			"get_subagent_result",
			"stop_subagent",
		]);
		expect([...h.commands.keys()]).toEqual(["agents"]);
		expect([...h.renderers.keys()]).toEqual(["subagent-notification"]);
		for (const name of ["session_start", "turn_start", "turn_end", "input", "session_shutdown"]) {
			expect(h.handlers.get(name)?.length).toBeGreaterThan(0);
		}
	});

	it("uses strict schemas and normalizeAgentRequest's background default", async () => {
		const h = harness();
		const ctx = fakeContext();
		await emit(h, "session_start", { type: "session_start", reason: "startup" }, ctx);
		const tool = h.tools.get("Agent");
		expect(tool.parameters.additionalProperties).toBe(false);
		expect(h.tools.get("get_subagent_result").parameters.additionalProperties).toBe(false);
		expect(h.tools.get("stop_subagent").parameters.additionalProperties).toBe(false);
		await tool.execute("call-1", {
			description: "small label",
			prompt: "complete contract",
			subagent_type: "worker",
		}, signal, undefined, ctx);
		expect(h.manager.enqueue).toHaveBeenCalledWith(
			expect.objectContaining({ run_in_background: true }),
			expect.objectContaining({ cwd: ctx.cwd, origin: "conversation-1" }),
			signal,
		);
	});

	it("wires all manager operations and returns complete foreground output", async () => {
		const h = harness();
		const ctx = fakeContext("print");
		await emit(h, "session_start", { type: "session_start", reason: "startup" }, ctx);
		h.manager.enqueue = vi.fn(async () => result());
		const foreground = await h.tools.get("Agent").execute("call", {
			description: "label",
			prompt: "contract",
			subagent_type: "worker",
			run_in_background: false,
		}, signal, undefined, ctx);
		expect(foreground.content[0].text).toContain("complete output");
		await h.tools.get("get_subagent_result").execute("get", { agent_id: "a001" }, signal, undefined, ctx);
		expect(h.manager.getResult).toHaveBeenCalledWith("a001", false, signal);
		await h.tools.get("stop_subagent").execute("stop", { agent_id: "a001" }, signal, undefined, ctx);
		expect(h.manager.stop).toHaveBeenCalledWith("a001");
	});

	it("orders initialize, initial TUI restore, pending delivery recovery, then pump activation", async () => {
		const h = harness();
		const ctx = fakeContext("tui");
		await emit(h, "session_start", { type: "session_start", reason: "startup" }, ctx);
		expect(h.calls).toEqual(["initialize", "recover", "activate"]);
		expect(ctx.ui.widgets.get("subagent-agents")?.join("\n")).toContain("subagent-a001");
		expect(ctx.ui.statuses.get("subagent-agents")).toContain("1 running");
	});

	it("does not install terminal widgets in RPC, JSON, or print modes", async () => {
		for (const mode of ["rpc", "json", "print"] as const) {
			const h = harness();
			const ctx = fakeContext(mode);
			await emit(h, "session_start", { type: "session_start", reason: "startup" }, ctx);
			expect(ctx.ui.widgets.size).toBe(0);
			expect(ctx.ui.statuses.size).toBe(0);
		}
	});

	it("updates the active conversation before recovery after a session switch", async () => {
		const h = harness();
		const first = fakeContext("rpc", "conversation-1");
		await emit(h, "session_start", { type: "session_start", reason: "startup" }, first);
		const factoryContext = h.factory.mock.calls[0][0];
		expect(factoryContext.getContext().sessionManager.getSessionId()).toBe("conversation-1");
		const second = fakeContext("rpc", "conversation-2");
		await emit(h, "session_start", { type: "session_start", reason: "new" }, second);
		expect(factoryContext.getContext().sessionManager.getSessionId()).toBe("conversation-2");
		expect(h.coordinator.recover).toHaveBeenCalledTimes(2);
	});

	it("groups a turn, excludes foreground calls, and drives turn-end delivery", async () => {
		const h = harness();
		const ctx = fakeContext();
		await emit(h, "session_start", { type: "session_start", reason: "startup" }, ctx);
		await emit(h, "turn_start", { type: "turn_start", turnIndex: 7 }, ctx);
		await h.tools.get("Agent").execute("bg", {
			description: "bg",
			prompt: "bg prompt",
			subagent_type: "worker",
		}, signal, undefined, ctx);
		await h.tools.get("Agent").execute("fg", {
			description: "fg",
			prompt: "fg prompt",
			subagent_type: "worker",
			run_in_background: false,
		}, signal, undefined, ctx);
		const contexts = (h.manager.enqueue as any).mock.calls.map((call: any[]) => call[1]);
		expect(contexts[0].groupId).toBe("turn-7-nonce");
		expect(contexts[1].groupId).toBeNull();
		await emit(h, "turn_end", { type: "turn_end", turnIndex: 7 }, ctx);
		expect(h.coordinator.turnEnd).toHaveBeenCalledOnce();
	});

	it("dismisses completed widget rows on the next input while retaining live rows", async () => {
		const done = manifest("d001", "succeeded");
		const live = manifest("a001", "running");
		const h = harness({ manifests: [done, live] });
		const ctx = fakeContext();
		await emit(h, "session_start", { type: "session_start", reason: "startup" }, ctx);
		expect(ctx.ui.widgets.get("subagent-agents")?.join("\n")).toContain("subagent-d001");
		await emit(h, "input", { type: "input", text: "next" }, ctx);
		const rendered = ctx.ui.widgets.get("subagent-agents")?.join("\n") ?? "";
		expect(rendered).not.toContain("subagent-d001");
		expect(rendered).toContain("subagent-a001");
	});

	it("renders compact notification summaries without the result body", () => {
		const h = harness();
		const renderer = h.renderers.get("subagent-notification");
		const component = renderer({
			content: `<task-notifications>\n  <task-notification>\n    <task-id>a001</task-id>\n    <status>succeeded</status>\n    <summary>worker finished</summary>\n    <result>SECRET FULL OUTPUT</result>\n    <usage>\n      <total_tokens>1200</total_tokens>\n      <tool_uses>3</tool_uses>\n      <duration_ms>2500</duration_ms>\n    </usage>\n  </task-notification>\n</task-notifications>`,
		}, { expanded: false, outputPad: 0 }, { fg: (_: string, text: string) => text });
		const text = component.render(120).join("\n");
		expect(text).toContain("worker finished");
		expect(text).toContain("3 tools");
		expect(text).not.toContain("SECRET FULL OUTPUT");
	});

	it("enforces foreground-only nested producers before manager publication", async () => {
		const h = harness({ mode: "nested-producer" });
		const ctx = fakeContext("rpc");
		await emit(h, "session_start", { type: "session_start", reason: "startup" }, ctx);
		await expect(h.tools.get("Agent").execute("nested", {
			description: "nested",
			prompt: "nested prompt",
			subagent_type: "worker",
		}, signal, undefined, ctx)).rejects.toThrow(/foreground/i);
		expect(h.manager.enqueue).not.toHaveBeenCalled();
		await h.tools.get("Agent").execute("nested", {
			description: "nested",
			prompt: "nested prompt",
			subagent_type: "worker",
			run_in_background: false,
		}, signal, undefined, ctx);
		expect(h.manager.enqueue).toHaveBeenCalledOnce();
		expect(h.factory).toHaveBeenCalledWith(expect.objectContaining({ nested: true }));
	});

	it("awaits one idempotent non-destructive cleanup promise", async () => {
		const h = harness();
		const ctx = fakeContext();
		await emit(h, "session_start", { type: "session_start", reason: "startup" }, ctx);
		const shutdownHandlers = h.handlers.get("session_shutdown") ?? [];
		const first = shutdownHandlers[0]({}, ctx);
		const second = shutdownHandlers[0]({}, ctx);
		await vi.waitFor(() => {
			expect(h.runtime.shutdown).toHaveBeenCalledOnce();
		});
		let settled = false;
		void Promise.resolve(first).then(() => { settled = true; });
		await Promise.resolve();
		expect(settled).toBe(false);
		h.resolveShutdown();
		await Promise.all([first, second]);
		expect(h.calls).toContain("shutdown-end");
	});
});
