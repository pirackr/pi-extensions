import { beforeEach, describe, expect, it, vi } from "vitest";

import { Key, Text, matchesKey } from "@earendil-works/pi-tui";

import type {
	AgentManifest,
	AgentReceipt,
	AgentRequest,
	ResultResponse,
	StopResponse,
	TaskStatus,
	TerminalResult,
	Usage,
} from "../types.ts";
import type { SubagentManager } from "../manager.ts";
import type { NotificationItem } from "../notifications.ts";

import {
	attachCommandFor,
	artifactPathFor,
	classifyAgentRow,
	countAgents,
	createToolRenderers,
	expandedToolDetails,
	isAgentsCommandContext,
	performAgentAction,
	renderFooter,
	renderNotificationMessage,
	renderWidgetLines,
	retrieveSummary,
	stopSummary,
	runAgentsCommand,
	AgentsView,
	type AgentWidgetRow,
	type AgentsCommandContext,
	type AgentsSelectable,
} from "../render.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PROFILE = {
	name: "general",
	description: "General worker",
	model: "provider/model",
	thinking: "medium",
	tools: ["read", "bash"],
	access: "write" as const,
	timeoutSeconds: 300,
	systemPrompt: "Work carefully.",
	source: "/profiles/general.md",
};

const USAGE: Usage = { totalTokens: 1234, toolUses: 3, durationMs: 12_000 };

const RESULT: TerminalResult = {
	agentId: "a1b2",
	state: "succeeded",
	output: "final output",
	usage: USAGE,
	finishedAt: 5_000,
	terminalReason: null,
};

const RUNNING_RECEIPT: AgentReceipt = {
	agentId: "a1b2",
	state: "running",
	tmuxSession: "pi-k7m2",
	tmuxWindow: "subagent-a1b2",
	attachCommand: "tmux attach -t pi-k7m2 \\; select-window -t subagent-a1b2",
	artifactDir: "/tmp/proj/pi-k7m2/subagents/a1b2",
};

const QUEUED_RECEIPT: AgentReceipt = {
	agentId: "a1b2",
	state: "queued",
	tmuxSession: null,
	tmuxWindow: null,
	attachCommand: null,
	artifactDir: "/tmp/proj/pi-k7m2/subagents/a1b2",
};

const FOREGROUND_RESULT: ResultResponse = {
	agentId: "a1b2",
	state: "succeeded",
	result: RESULT,
	activity: null,
	elapsedMs: 12_000,
	usage: USAGE,
	tmuxTarget: null,
	artifactDir: null,
	consumed: true,
	notFound: false,
};

function manifest(
	agentId: string,
	state: TaskStatus,
	overrides: Partial<AgentManifest> = {},
): AgentManifest {
	return {
		schema: 1,
		generation: `gen-${agentId}`,
		revision: 1,
		parentId: "p001",
		agentId,
		parentAgentId: null,
		ownershipTreeId: agentId,
		origin: "conversation-123",
		groupId: null,
		description: "do abc xyz",
		prompt: "SECRET: do abc xyz thoroughly with the system prompt",
		profile: PROFILE,
		state,
		sequence: 1,
		queuedAt: 0,
		startedAt: null,
		heartbeatAt: null,
		finishedAt: null,
		runnerPid: null,
		processStart: "",
		tmuxSession: null,
		tmuxWindow: null,
		timeoutSeconds: 300,
		terminalReason: null,
		...overrides,
	};
}

const RUNNING: AgentWidgetRow = {
	agentId: "a1b2",
	parentAgentId: null,
	depth: 0,
	profile: "general",
	description: "do abc xyz",
	state: "running",
	startedAt: 0,
	finishedAt: null,
	timeoutSeconds: 300,
	toolUses: 3,
	totalTokens: 1234,
	activity: null,
};

const DESCENDANT: AgentWidgetRow = {
	agentId: "c3d4",
	parentAgentId: "a1b2",
	depth: 1,
	profile: "summarize",
	description: "cleanup",
	state: "succeeded",
	startedAt: 0,
	finishedAt: 5_000,
	timeoutSeconds: null,
	toolUses: 1,
	totalTokens: 500,
	activity: null,
};

const NOTIFICATION: NotificationItem = {
	agentId: "a1b2",
	state: "succeeded",
	summary: "worker: do abc xyz",
	output: "<task-notifications><task-notification><result>system prompt text</result></task-notification></task-notifications>",
	usage: USAGE,
};

// ---------------------------------------------------------------------------
// Exports exist (RED: none exist yet)
// ---------------------------------------------------------------------------

describe("render exports", () => {
	it("exposes createToolRenderers", () => {
		expect(typeof createToolRenderers).toBe("function");
	});
	it("exposes renderWidgetLines", () => {
		expect(typeof renderWidgetLines).toBe("function");
	});
	it("exposes renderFooter", () => {
		expect(typeof renderFooter).toBe("function");
	});
	it("exposes renderNotificationMessage", () => {
		expect(typeof renderNotificationMessage).toBe("function");
	});
	it("exposes runAgentsCommand", () => {
		expect(typeof runAgentsCommand).toBe("function");
	});
});

// ---------------------------------------------------------------------------
// Compact tool call/result rendering (never echo the prompt)
// ---------------------------------------------------------------------------

describe("compact tool rendering", () => {
	const { renderCall, renderResult } = createToolRenderers();

	it("returns real pi Text components, not strings", () => {
		const request: AgentRequest = {
			description: "do abc xyz",
			prompt: "SECRET system prompt",
			subagent_type: "worker",
			run_in_background: true,
		};
		expect(renderCall(request, {} as never, {} as never)).toBeInstanceOf(Text);
	});

	it("renders the canonical compact call header from the profile + description", () => {
		const request: AgentRequest = {
			description: "do abc xyz",
			prompt: "SECRET system prompt that must never render",
			subagent_type: "worker",
			run_in_background: true,
		};
		expect(renderText(renderCall(request, {} as never, {} as never))).toBe(
			"▸ worker (do abc xyz)",
		);
	});

	it("never echoes the prompt in the compact header", () => {
		const call = renderCall(
			{
				description: "do abc xyz",
				prompt: "SECRET system prompt",
				subagent_type: "worker",
				run_in_background: true,
			},
			{} as never,
			{} as never,
		);
		expect(renderText(call)).not.toContain("SECRET");
	});

	it("renders the canonical running receipt with a truncated handle", () => {
		expect(
			renderText(renderResult(RUNNING_RECEIPT, { expanded: false }, {} as never)),
		).toBe("⎿ Running as subagent-a1b2…");
	});

	it("says Queued when capacity is full", () => {
		expect(
			renderText(renderResult(QUEUED_RECEIPT, { expanded: false }, {} as never)),
		).toBe("⎿ Queued as subagent-a1b2…");
	});

	it("says Done for a foreground completion", () => {
		expect(
			renderText(renderResult(FOREGROUND_RESULT, { expanded: false }, {} as never)),
		).toBe("⎿ Done");
	});

	it("never echoes the prompt in the compact result", () => {
		const text = renderText(
			renderResult(RUNNING_RECEIPT, { expanded: false }, {} as never),
		);
		expect(text).not.toContain("SECRET");
	});

	it("expands Tmux, Attach, and Artifacts rows for a running background call", () => {
		expect(expandedToolDetails(RUNNING_RECEIPT)).toEqual([
			"Tmux:      pi-k7m2:subagent-a1b2",
			"Attach:    tmux attach -t pi-k7m2 \\; select-window -t subagent-a1b2",
			"Artifacts: /tmp/proj/pi-k7m2/subagents/a1b2",
		]);
	});

	it("omits tmux/attach rows when the window has not started yet", () => {
		expect(expandedToolDetails(QUEUED_RECEIPT)).toEqual([
			"Artifacts: /tmp/proj/pi-k7m2/subagents/a1b2",
		]);
	});
});

// ---------------------------------------------------------------------------
// Documented tool-renderer signature: renderCall(args, theme, context) and
// renderResult(result, options, theme, context).
// ---------------------------------------------------------------------------

describe("tool-renderer documented signatures", () => {
	const { renderCall, renderResult } = createToolRenderers();

	it("renderResult honours the options argument in the documented (result, options, …) position", () => {
		// Expanded rendering is selected through the second `options` argument;
		// the result itself is the first argument. Proves the documented order.
		const expanded = renderText(
			renderResult(RUNNING_RECEIPT, { expanded: true }, {} as never, {} as never),
		);
		const collapsed = renderText(
			renderResult(RUNNING_RECEIPT, { expanded: false }, {} as never, {} as never),
		);
		expect(expanded).toContain("Tmux:");
		expect(expanded).toContain("Attach:");
		expect(expanded).toContain("Artifacts:");
		expect(collapsed).not.toContain("Tmux:");
	});
});

// ---------------------------------------------------------------------------
// Widget rows: hierarchy, elapsed/timeout, tool/token use, terminal state
// ---------------------------------------------------------------------------

describe("renderWidgetLines", () => {
	it("renders an active row with id, profile, description, elapsed/timeout, tool and token use", () => {
		const lines = renderWidgetLines([RUNNING], {
			frame: 0,
			width: 80,
			now: 12_000,
		});
		expect(lines).toEqual([
			"⠋ subagent-a1b2 general do abc xyz 12.0s/300s 3 tools 1.2k tok",
		]);
	});

	it("indents descendants and appends the terminal state word", () => {
		const lines = renderWidgetLines([DESCENDANT], {
			frame: 0,
			width: 80,
			now: 20_000,
		});
		expect(lines).toEqual([
			"  ✓ subagent-c3d4 summarize cleanup 5.0s 1 tool 500 tok succeeded",
		]);
	});

	it("stays within the supplied visible width", () => {
		const wide: AgentWidgetRow = {
			...RUNNING,
			description:
				"an unusually long description that certainly will not fit inside a narrow widget row here",
		};
		const lines = renderWidgetLines([wide], { frame: 0, width: 40, now: 12_000 });
		for (const line of lines) {
			expect(visibleWidthTestOnly(line)).toBeLessThanOrEqual(40);
		}
	});
});

// Visible-width helper (ignores ANSI escapes) shared by the width test.
function visibleWidthTestOnly(value: string): number {
	let width = 0;
	let inEscape = false;
	for (const ch of value) {
		if (inEscape) {
			if (ch === "m") inEscape = false;
			continue;
		}
		if (ch === "\x1b") {
			inEscape = true;
			continue;
		}
		width++;
	}
	return width;
}

/** Render a Text/Container component to its trimmed visible string form. */
function renderText(node: { render(width: number): string[] }, width = 200): string {
	return node.render(width).map((line) => line.replace(/\s+$/, "")).join("\n");
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

describe("renderFooter", () => {
	it("follows the required Agents wording across all three categories", () => {
		expect(renderFooter({ running: 2, queued: 1, finished: 3 })).toBe(
			"Agents: 2 running · 1 queued · 3 finished",
		);
	});
});

describe("countAgents", () => {
	it("buckets running(+starting), queued, and finished", () => {
		const manifests = [
			manifest("a1b2", "running"),
			manifest("c3d4", "starting"),
			manifest("q1w2", "queued"),
			manifest("s3d4", "succeeded"),
			manifest("f5g6", "failed"),
			manifest("h7j8", "queued"),
		];
		expect(countAgents(manifests)).toEqual({ running: 2, queued: 2, finished: 2 });
	});
});

// ---------------------------------------------------------------------------
// Compact notifications (summary + usage only, never the output body)
// ---------------------------------------------------------------------------

describe("renderNotificationMessage", () => {
	it("renders a compact human-readable summary with usage", () => {
		expect(renderNotificationMessage([NOTIFICATION])).toBe(
			"✓ worker: do abc xyz · 3 tools · 1.2k tok · 12.0s",
		);
	});

	it("never echoes the notification output body", () => {
		const text = renderNotificationMessage([NOTIFICATION]);
		expect(text).not.toContain("task-notifications");
		expect(text).not.toContain("system prompt text");
	});
});

// ---------------------------------------------------------------------------
// /agents action logic
// ---------------------------------------------------------------------------

describe("classifyAgentRow", () => {
	it("attaches running and starting windows", () => {
		expect(classifyAgentRow(manifest("a1b2", "running"))).toBe("attach");
		expect(classifyAgentRow(manifest("c3d4", "starting"))).toBe("attach");
	});
	it("stops queued work", () => {
		expect(classifyAgentRow(manifest("q1w2", "queued"))).toBe("stop");
	});
	it("retrieves terminal work", () => {
		expect(classifyAgentRow(manifest("s3d4", "succeeded"))).toBe("retrieve");
	});
});

describe("attachCommandFor", () => {
	it("exposes the exact attach command", () => {
		expect(
			attachCommandFor(
				manifest("a1b2", "running", {
					tmuxSession: "pi-k7m2",
					tmuxWindow: "subagent-a1b2",
				}),
			),
		).toBe("tmux attach -t pi-k7m2 \\; select-window -t subagent-a1b2");
	});
	it("returns null when no window is attached", () => {
		expect(attachCommandFor(manifest("q1w2", "running"))).toBeNull();
	});
});

describe("retrieveSummary and stopSummary", () => {
	it("summarises a terminal result with usage and artifacts", () => {
		expect(
			retrieveSummary({
				...FOREGROUND_RESULT,
				artifactDir: "/tmp/proj/pi-k7m2/subagents/a1b2",
			}),
		).toBe(
			"✓ succeeded · 3 tools · 1.2k tok · 12.0s · artifacts: /tmp/proj/pi-k7m2/subagents/a1b2",
		);
	});

	it("reports a stop request and an idempotent no-op", () => {
		const stopped: StopResponse = {
			agentId: "a1b2",
			state: "running",
			stopped: true,
			message: "stop requested",
		};
		const terminal: StopResponse = {
			agentId: "a1b2",
			state: "succeeded",
			stopped: false,
			message: "subagent is already terminal",
		};
		expect(stopSummary(stopped)).toBe("stopped a1b2 (running)");
		expect(stopSummary(terminal)).toBe("a1b2 is already terminal (succeeded)");
	});
});

describe("artifactPathFor", () => {
	it("returns the artifact path", () => {
		expect(
			artifactPathFor({ ...FOREGROUND_RESULT, artifactDir: "/tmp/proj/x" }),
		).toBe("/tmp/proj/x");
	});
	it("signals an absent path", () => {
		expect(artifactPathFor({ ...FOREGROUND_RESULT, artifactDir: null })).toBe(
			"(no artifact path)",
		);
	});
});

// ---------------------------------------------------------------------------
// /agents selection model + action dispatch
// ---------------------------------------------------------------------------

const ESC_DOWN = "\x1b[B";
const ESC_UP = "\x1b[A";
const ESC_ENTER = "\r";
const ESC_ESCAPE = "\x1b";

describe("AgentsView", () => {
	let view: AgentsView;
	beforeEach(() => {
		view = new AgentsView([
			manifest("a1b2", "running", { tmuxSession: "pi-k7m2", tmuxWindow: "subagent-a1b2" }),
			manifest("q1w2", "queued"),
			manifest("s3d4", "succeeded"),
		]);
	});

	it("offers refresh first, then one selectable row per task grouped by state", () => {
		// The refresh sentinel is first; durable rows follow in state-group order
		// (queued before running before terminal), which is the grouping invariant.
		expect(view.rows.map((r) => r.agentId)).toEqual([
			"__refresh__",
			"q1w2",
			"a1b2",
			"s3d4",
		]);
		const order = view.rows.map((r) => r.state);
		// Every non-terminal group precedes every terminal group.
		const firstTerminal = order.indexOf("succeeded");
		expect(order.slice(0, firstTerminal)).not.toContain("succeeded");
	});

	it("navigates on the raw CSI-down escape sequence, not the literal token", () => {
		// Real terminals deliver "\x1b[B", not the string "down".
		expect(matchesKey(ESC_DOWN, Key.down)).toBe(true);
		expect(matchesKey("down", Key.down)).toBe(false);
		expect(view.dispatch(ESC_DOWN)).toBe("rerender");
		expect(view.selected().agentId).toBe("q1w2");
	});

	it("navigates up on the raw CSI-up escape sequence", () => {
		view.dispatch(ESC_DOWN);
		expect(view.dispatch(ESC_UP)).toBe("rerender");
		expect(view.selected().agentId).toBe("__refresh__");
	});

	it("resolves the correct action per task on raw Enter", () => {
		// Navigate to the running row (grouped after the queued row) and confirm
		// Enter yields its primary action, then to the terminal row.
		view.dispatch(ESC_DOWN); // q1w2 (queued -> stop)
		expect(view.selected().actions[0]).toBe("stop");
		view.dispatch(ESC_DOWN); // a1b2 (running -> attach)
		expect(view.selected().actions[0]).toContain("attach");
		expect(view.dispatch(ESC_ENTER)).toEqual({ action: "attach", id: "a1b2" });
		view.dispatch(ESC_DOWN); // s3d4 (succeeded -> retrieve)
		expect(view.selected().actions[0]).toContain("retrieve");
		expect(view.dispatch(ESC_ENTER)).toEqual({ action: "retrieve", id: "s3d4" });
	});

	it("offers the artifact-path action for terminal tasks through the selector", () => {
		const terminal = view.rows.find((r) => r.agentId === "s3d4");
		expect(terminal).toBeDefined();
		expect(terminal!.actions).toEqual(
			expect.arrayContaining(["retrieve", "path"]),
		);
	});

	it("preserves parent/descendant hierarchy in selectable labels", () => {
		const descendant = new AgentsView([
			manifest("a1b2", "running"),
			manifest("c3d4", "running", { parentAgentId: "a1b2" }),
		]);
		const byLabel = new Map(descendant.rows.map((r) => [r.agentId, r.label]));
		expect(byLabel.get("a1b2")!).not.toMatch(/^  /);
		expect(byLabel.get("c3d4")!).toMatch(/^  /);
	});
});

/** Build a selectable with the real multi-action shape the selector expects. */
function selectable(
	agentId: string,
	state: TaskStatus,
	actions: readonly ("attach" | "stop" | "retrieve" | "path" | "refresh")[],
	overrides: Partial<AgentsSelectable> = {},
): AgentsSelectable {
	return {
		agentId,
		label: agentId,
		actions: [...actions],
		state,
		profile: "general",
		depth: 0,
		parentAgentId: null,
		tmuxSession: null,
		tmuxWindow: null,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// performAgentAction: real manager calls via a thin ctx
// ---------------------------------------------------------------------------

function makeCtx(): {
	ctx: AgentsCommandContext;
	notify: ReturnType<typeof vi.fn>;
	requestRender: ReturnType<typeof vi.fn>;
} {
	const notify = vi.fn();
	const requestRender = vi.fn();
	const ctx = {
		ui: {
			theme: { fg: (color: string, text: string) => text },
			custom: vi.fn(),
			notify: (...args: unknown[]) => notify(...args),
			requestRender: (...args: unknown[]) => requestRender(...args),
		},
	} as unknown as AgentsCommandContext;
	return { ctx, notify, requestRender };
}

describe("performAgentAction", () => {
	it("exposes the attach command without running a shell", async () => {
		const { ctx, notify } = makeCtx();
		const manager = { stop: vi.fn(), getResult: vi.fn(), list: vi.fn() };
		await performAgentAction(
			"attach",
			selectable("a1b2", "running", ["attach"], {
				tmuxSession: "pi-k7m2",
				tmuxWindow: "subagent-a1b2",
			}),
			ctx,
			manager as unknown as SubagentManager,
		);
		expect(notify).toHaveBeenCalledWith(
			"tmux attach -t pi-k7m2 \\; select-window -t subagent-a1b2",
		);
	});

	it("stops a nonterminal task through the manager and reports the outcome", async () => {
		const { ctx, notify } = makeCtx();
		const stop = vi.fn(async (): Promise<StopResponse> => ({
			agentId: "a1b2",
			state: "running",
			stopped: true,
			message: "stop requested",
		}));
		await performAgentAction(
			"stop",
			selectable("a1b2", "running", ["stop"]),
			ctx,
			{ stop } as unknown as SubagentManager,
		);
		expect(stop).toHaveBeenCalledWith("a1b2");
		expect(notify).toHaveBeenCalledWith("stopped a1b2 (running)");
	});

	it("retrieves a terminal result with wait=false and a concrete AbortSignal", async () => {
		const { ctx, notify } = makeCtx();
		const getResult = vi.fn(
			async (_agentId: string, _wait: boolean, _signal: AbortSignal): Promise<ResultResponse> =>
				({
					...FOREGROUND_RESULT,
					artifactDir: "/tmp/proj/x",
				}),
		);
		await performAgentAction(
			"retrieve",
			selectable("a1b2", "succeeded", ["retrieve", "path"]),
			ctx,
			{ getResult } as unknown as SubagentManager,
		);
		expect(getResult.mock.calls[0][0]).toBe("a1b2");
		expect(getResult.mock.calls[0][1]).toBe(false);
		expect(getResult.mock.calls[0][2]).toBeInstanceOf(AbortSignal);
		expect(notify).toHaveBeenCalledWith(
			"✓ succeeded · 3 tools · 1.2k tok · 12.0s · artifacts: /tmp/proj/x",
		);
	});

	it("copies the artifact path for a terminal task", async () => {
		const { ctx, notify } = makeCtx();
		const getResult = vi.fn(async (): Promise<ResultResponse> => ({
			...FOREGROUND_RESULT,
			artifactDir: "/tmp/proj/artifacts",
		}));
		await performAgentAction(
			"path",
			selectable("a1b2", "succeeded", ["retrieve", "path"]),
			ctx,
			{ getResult } as unknown as SubagentManager,
		);
		expect(getResult).toHaveBeenCalledTimes(1);
		expect(notify).toHaveBeenCalledWith("/tmp/proj/artifacts");
	});

	it("re-durables state on refresh", async () => {
		const { ctx, requestRender } = makeCtx();
		const manager = { stop: vi.fn(), getResult: vi.fn(), list: vi.fn() };
		await performAgentAction(
			"refresh",
			selectable("__refresh__", "queued", ["refresh"]),
			ctx,
			manager as unknown as SubagentManager,
		);
		expect(requestRender).toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// runAgentsCommand: real SelectList, raw terminal input, rerender on input
// ---------------------------------------------------------------------------

/**
 * Drive runAgentsCommand with a fake `ctx.ui.custom` that captures the component
 * it returns, so we can feed real terminal key data through SelectList.
 */
describe("runAgentsCommand", () => {
	it("drives a real SelectList with raw terminal escape sequences and rerenders", async () => {
		const manager = {
			list: vi.fn(async () => [
				manifest("a1b2", "running", { tmuxSession: "pi-k7m2", tmuxWindow: "subagent-a1b2" }),
				manifest("q1w2", "queued"),
				manifest("s3d4", "succeeded"),
			]),
			stop: vi.fn(),
			getResult: vi.fn(async () => ({ ...FOREGROUND_RESULT })),
		};

		let component: {
			render(width: number): string[];
			invalidate(): void;
			handleInput(data: string): void;
		} | undefined;

		const requestRender = vi.fn();
		const ctx = {
			mode: "tui",
			ui: {
				theme: { fg: (_color: string, text: string) => text, bold: (t: string) => t },
				notify: vi.fn(),
				requestRender,
				custom: ((_factory: (tui: { requestRender(): void }, theme: unknown, kb: unknown, done: unknown) => unknown) => {
					const result = _factory(
						{ requestRender: () => requestRender() },
						{},
						{},
						() => {},
					);
					component = result as { render(width: number): string[]; invalidate(): void; handleInput(data: string): void };
					return Promise.resolve(result);
				}),
			},
		} as unknown as AgentsCommandContext;

		await runAgentsCommand(ctx, manager as unknown as SubagentManager);

		expect(component).toBeDefined();
		expect(component!.render(80).length).toBeGreaterThan(0);

		// Real CSI-down is delivered by a live terminal and must rerender via
		// the factory's `tui`, exactly as pi would pass it.
		component!.handleInput(ESC_DOWN);
		expect(requestRender).toHaveBeenCalled();

		// A literal "down" token is not how a real terminal delivers the key;
		// the selector matches the escape sequence, not the token.
		expect(matchesKey(ESC_DOWN, "down")).toBe(true);
		expect(matchesKey("down", "down")).toBe(false);
	});
});

describe("isAgentsCommandContext", () => {
	it("guards the runtime ctx shape", () => {
		expect(isAgentsCommandContext({ ui: { notify: vi.fn() } } as never)).toBe(true);
		expect(isAgentsCommandContext(null as never)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// runAgentsCommand: refresh rebuilds and the artifact path is a real selection.
//
// These drive the real `ctx.ui.custom` callback and the real `SelectList`.
// A custom `ctx.ui.custom` resolves its promise via `done`, so we capture every
// selector instance in call order and feed raw terminal escape sequences through
// it — exactly what a live host passes. There is no `await` on the command in
// most cases: refresh leaves the selector open, so the command dangles until we
// cancel it; a dangling command never rejects.
// ---------------------------------------------------------------------------

/** Drive one `/agents` command, capturing every SelectList in call order. */
function makeAgentsSession() {
	const components: Array<{
		render(width: number): string[];
		invalidate(): void;
		handleInput(data: string): void;
	}> = [];
	const requestRender = vi.fn();
	const notify = vi.fn();
	const ctx = {
		mode: "tui",
		ui: {
			theme: { fg: (_color: string, text: string) => text, bold: (t: string) => t },
			notify: (...args: unknown[]) => notify(...args),
			requestRender: (...args: unknown[]) => requestRender(...args),
			custom: (factory: (tui: { requestRender(): void }, theme: unknown, kb: unknown, done: (value?: unknown) => void) => unknown) =>
				new Promise((resolve) => {
					const returned = factory(
						{ requestRender: () => requestRender() },
						{},
						{},
						resolve,
					);
					Promise.resolve(returned).then((component) => {
						components.push(component as typeof components[number]);
					});
				}),
		},
	} as unknown as AgentsCommandContext;
	return { ctx, components, requestRender, notify };
}

/** Drain microtasks/macrotasks so awaited `custom`/`manager.list()` settles. */
async function settle() {
	for (let i = 0; i < 12; i++) {
		await new Promise((r) => setTimeout(r, 0));
	}
}

describe("runAgentsCommand refresh rebuilds the selector", () => {
	it("re-lists and rebuilds the displayed SelectList when refresh re-queries", async () => {
		let listCalls = 0;
		const list = vi.fn(async () =>
			listCalls++ === 0
				? [manifest("a1b2", "running")]
				: [
					manifest("a1b2", "running"),
					manifest("z9z9", "queued", { description: "do new thing" }),
				],
		);
		const manager = { list, stop: vi.fn(), getResult: vi.fn() };
		const { ctx, components, notify } = makeAgentsSession();
		const runner = runAgentsCommand(ctx, manager as unknown as SubagentManager);
		runner.catch(() => {});
		await settle();

		// Initial listing has only the running task; no durable history yet.
		const initial = components[0].render(80).join("\n").toLowerCase();
		expect(initial).toContain("general: do abc xyz");
		expect(initial).not.toContain("do new thing");
		expect(list).toHaveBeenCalledTimes(1);

		// The refresh sentinel is the first selectable row.
		components[0].handleInput(ESC_ENTER);
		await settle();

		// Refresh re-queried the manager once more…
		expect(list).toHaveBeenCalledTimes(2);
		// …and a rebuilt SelectList surfaced from the new manifests.
		expect(components.length).toBeGreaterThan(1);
		const rebuilt = components[components.length - 1].render(80).join("\n").toLowerCase();
		expect(rebuilt).toContain("general: do abc xyz");
		expect(rebuilt).toContain("do new thing");
		// Refresh does not perform a retrieval or stop.
		expect(notify).not.toHaveBeenCalled();
	});
});

describe("runAgentsCommand terminal actions", () => {
	it("offers the distinct artifact-path action that displays the path", async () => {
		const getResult = vi.fn(
			async (_agentId: string, _wait: boolean, _signal: AbortSignal): Promise<ResultResponse> =>
				({ ...FOREGROUND_RESULT, artifactDir: "/tmp/proj/artifacts" }),
		);
		const manager = {
			list: vi.fn(async () => [manifest("s3d4", "succeeded", { description: "do finalize" })]),
			stop: vi.fn(),
			getResult,
		};
		const { ctx, components, notify } = makeAgentsSession();
		const runner = runAgentsCommand(ctx, manager as unknown as SubagentManager);
		runner.catch(() => {});
		await settle();

		// The single terminal task is the second selectable row; navigate to it.
		components[0].handleInput(ESC_DOWN);
		await settle();
		components[0].handleInput(ESC_ENTER);
		await settle();

		// Selecting a terminal task opens a distinct action picker (retrieve
		// plus path); the path action is a real selectable item, not dead code.
		expect(components.length).toBeGreaterThan(1);
		components[1].handleInput(ESC_DOWN);
		await settle();
		components[1].handleInput(ESC_ENTER);
		await settle();

		// The path action goes through the real public getResult signature.
		expect(getResult).toHaveBeenCalledWith("s3d4", false, expect.any(AbortSignal));
		// …and displays the artifact path.
		expect(notify).toHaveBeenCalledWith("/tmp/proj/artifacts");
	});
});

describe("runAgentsCommand nested action picker cancel", () => {
	it("dismisses the action picker on Escape without getResult, stop, or notify", async () => {
		const getResult = vi.fn();
		const stop = vi.fn();
		const list = vi.fn(
			async () => [manifest("s3d4", "succeeded", { description: "do finalize" })],
		);
		const manager = { list, stop, getResult };
		const { ctx, components, notify } = makeAgentsSession();
		let resolved = false;
		const runner = runAgentsCommand(ctx, manager as unknown as SubagentManager);
		runner.then(() => {
			resolved = true;
		}).catch(() => {});
		await settle();

		// Navigate to the single terminal task and open its action picker.
		components[0].handleInput(ESC_DOWN);
		await settle();
		components[0].handleInput(ESC_ENTER);
		await settle();

		// The nested action picker is a distinct SelectList (retrieve + path).
		expect(components.length).toBeGreaterThan(1);

		// Escape cancels the nested action picker through the real SelectList.
		components[components.length - 1].handleInput("\x1b");
		await settle();

		// Cancel dismisses without side effects and lets the command resolve.
		expect(getResult).not.toHaveBeenCalled();
		expect(stop).not.toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
		expect(resolved).toBe(true);
	});
});
