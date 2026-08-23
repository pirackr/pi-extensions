import { beforeEach, describe, expect, it, vi } from "vitest";

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

	it("renders the canonical compact call header from the profile + description", () => {
		const request: AgentRequest = {
			description: "do abc xyz",
			prompt: "SECRET system prompt that must never render",
			subagent_type: "worker",
			run_in_background: true,
		};
		expect(renderCall(request, {} as never, {} as never)).toBe("▸ worker (do abc xyz)");
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
		expect(call).not.toContain("SECRET");
	});

	it("renders the canonical running receipt with a truncated handle", () => {
		expect(renderResult(RUNNING_RECEIPT, { expanded: false }, {} as never)).toBe(
			"⎿ Running as subagent-a1b2…",
		);
	});

	it("says Queued when capacity is full", () => {
		expect(renderResult(QUEUED_RECEIPT, { expanded: false }, {} as never)).toBe(
			"⎿ Queued as subagent-a1b2…",
		);
	});

	it("says Done for a foreground completion", () => {
		expect(renderResult(FOREGROUND_RESULT, { expanded: false }, {} as never)).toBe(
			"⎿ Done",
		);
	});

	it("never echoes the prompt in the compact result", () => {
		const text = renderResult(RUNNING_RECEIPT, { expanded: false }, {} as never);
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

function selectable(
	agentId: string,
	action: "attach" | "stop" | "retrieve",
	state: TaskStatus,
	overrides: Partial<AgentsSelectable> = {},
): AgentsSelectable {
	return {
		agentId,
		label: agentId,
		action,
		state,
		profile: "general",
		tmuxSession: null,
		tmuxWindow: null,
		artifactDir: null,
		...overrides,
	};
}

describe("AgentsView", () => {
	let view: AgentsView;
	beforeEach(() => {
		view = new AgentsView([
			manifest("a1b2", "running", { tmuxSession: "pi-k7m2", tmuxWindow: "subagent-a1b2" }),
			manifest("q1w2", "queued"),
			manifest("s3d4", "succeeded"),
		]);
	});

	it("offers refresh first, then one selectable row per task", () => {
		expect(view.rows.map((r) => r.agentId)).toEqual([
			"__refresh__",
			"a1b2",
			"q1w2",
			"s3d4",
		]);
	});

	it("navigates and rerenders", () => {
		expect(view.dispatch("down")).toBe("rerender");
		expect(view.selected().agentId).toBe("a1b2");
	});

	it("resolves the correct action per task", () => {
		expect(view.dispatch("down")).toBe("rerender");
		expect(view.dispatch("enter")).toEqual({ action: "attach", id: "a1b2" });
		expect(view.dispatch("down")).toBe("rerender");
		expect(view.dispatch("down")).toBe("rerender");
		expect(view.dispatch("enter")).toEqual({ action: "retrieve", id: "s3d4" });
		expect(view.dispatch("escape")).toBe("done");
	});
});

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
			selectable("a1b2", "attach", "running", {
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
			selectable("a1b2", "stop", "running"),
			ctx,
			{ stop } as unknown as SubagentManager,
		);
		expect(stop).toHaveBeenCalledWith("a1b2");
		expect(notify).toHaveBeenCalledWith("stopped a1b2 (running)");
	});

	it("retrieves a terminal result through the manager", async () => {
		const { ctx, notify } = makeCtx();
		const getResult = vi.fn(async (): Promise<ResultResponse> => ({
			...FOREGROUND_RESULT,
			artifactDir: "/tmp/proj/x",
		}));
		await performAgentAction(
			"retrieve",
			selectable("a1b2", "retrieve", "succeeded"),
			ctx,
			{ getResult } as unknown as SubagentManager,
		);
		expect(getResult).toHaveBeenCalledWith("a1b2");
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
			selectable("a1b2", "retrieve", "succeeded"),
			ctx,
			{ getResult } as unknown as SubagentManager,
		);
		expect(notify).toHaveBeenCalledWith("/tmp/proj/artifacts");
	});

	it("re-durables state on refresh", async () => {
		const { ctx, requestRender } = makeCtx();
		const manager = { stop: vi.fn(), getResult: vi.fn(), list: vi.fn() };
		await performAgentAction(
			"refresh",
			selectable("__refresh__", "retrieve", "succeeded"),
			ctx,
			manager as unknown as SubagentManager,
		);
		expect(requestRender).toHaveBeenCalled();
	});
});

describe("isAgentsCommandContext", () => {
	it("guards the runtime ctx shape", () => {
		expect(isAgentsCommandContext({ ui: { notify: vi.fn() } } as never)).toBe(true);
		expect(isAgentsCommandContext(null as never)).toBe(false);
	});
});
