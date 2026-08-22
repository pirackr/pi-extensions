/**
 * Invocation-guard invariants for research.
 *
 * Guarantee: research is never kicked off (started OR resumed) without an
 * explicit user invocation. The only start path is the user-typed /research
 * command; a restored loop from a previous session must NOT auto-continue —
 * session_start pauses it and demands /research resume (user-typed); and the
 * research_checkpoint tool is only reachable while a user-started research
 * run is active.
 *
 * These tests drive the REAL extension against a mock pi API and a real
 * retained workspace under a tmpdir.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import piLoop from "../extensions/loop/index.ts";
import type { LoopState } from "../extensions/loop/state.ts";

vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: vi.fn().mockReturnValue("/mock/agent/dir"),
	parseFrontmatter: vi.fn(),
}));

interface MockTool {
	name: string;
	execute: (
		...args: unknown[]
	) => Promise<{ content?: { text?: string }[]; isError?: boolean }>;
}
interface MockCommand {
	handler: (args: string, ctx: unknown) => Promise<void>;
	getArgumentCompletions?: (prefix: string) => Array<{ value: string }> | null;
}

/**
 * Mock pi API that keeps a raw entry log (type + data), a normalized session
 * log (type: "custom", customType) that engine.latestState reads at
 * session_start, an active-tools list with loopback, and a sendMessage log to
 * detect (non-)queued continuations.
 */
function makeMockPi() {
	const tools: Record<string, MockTool> = {};
	const commands: Record<string, MockCommand> = {};
	const entries: Array<{ type: string; data: unknown }> = [];
	const sessionEntries: Array<{
		type: string;
		customType: string;
		data: unknown;
	}> = [];
	const handlers: Record<string, Array<(...args: unknown[]) => void>> = {};
	let activeTools: string[] = [];
	const sendMessages: Array<unknown> = [];
	const pi = {
		registerTool: (def: MockTool) => {
			tools[def.name] = def;
		},
		registerCommand: (cmd: string, def: MockCommand) => {
			commands[cmd] = def;
		},
		on: (event: string, handler: (...args: unknown[]) => void) => {
			if (!handlers[event]) handlers[event] = [];
			handlers[event].push(handler);
		},
		getHandler: (event: string) => handlers[event]?.[0] ?? null,
		sendMessage: (_msg: unknown, opts?: unknown) => {
			sendMessages.push(opts);
		},
		appendEntry: vi.fn((type: string, data: unknown) => {
			entries.push({ type, data });
			sessionEntries.push({ type: "custom", customType: type, data });
		}),
		getActiveTools: () => [...activeTools],
		setActiveTools: vi.fn((next: string[]) => {
			activeTools = [...next];
		}),
	};
	return {
		pi,
		tools,
		commands,
		entries,
		sessionEntries,
		handlers,
		sendMessages,
		getActiveTools: () => [...activeTools],
	};
}

/** Fake model registry backing buildResearchDeps (research role aliases). */
function fakeModelRegistry() {
	const models = [
		{
			id: "local/strong",
			name: "strong",
			provider: "local",
			reasoning: true,
			input: ["text"],
		},
		{
			id: "local/fast",
			name: "fast",
			provider: "local",
			reasoning: false,
			input: ["text"],
		},
		{
			id: "local/eval",
			name: "eval",
			provider: "local",
			reasoning: true,
			input: ["text"],
		},
		{
			id: "local/light",
			name: "light",
			provider: "local",
			reasoning: false,
			input: ["text"],
		},
	];
	return {
		getAll: () => models,
		getRegisteredProviderIds: () => ["local"],
		getProvider: () => undefined,
	};
}

interface NotifyCall {
	message: string;
	level: string;
}

function mockCtx(
	cwd: string,
	sessionEntries: Array<{ type: string; customType: string; data: unknown }>,
) {
	const notifications: NotifyCall[] = [];
	return {
		cwd,
		ui: {
			notify: (message: string, level = "info") => {
				notifications.push({ message, level });
			},
			confirm: async () => true,
			setStatus: () => {},
		},
		isIdle: () => false,
		hasPendingMessages: () => false,
		modelRegistry: fakeModelRegistry(),
		sessionManager: {
			getEntries: () => sessionEntries,
			getSessionId: () => "test-session",
		},
		getNotifications: () => notifications,
	};
}

function latestLoopEntry(
	mock: ReturnType<typeof makeMockPi>,
): { loop: LoopState } | null {
	const loopEntries = mock.entries.filter((e) => e.type === "pi-loop");
	if (loopEntries.length === 0) return null;
	return loopEntries[loopEntries.length - 1].data as { loop: LoopState };
}

function latestWorkingDir(mock: ReturnType<typeof makeMockPi>): string | null {
	return latestLoopEntry(mock)?.loop.workingDir ?? null;
}

function lifecycleCurrent(wsPath: string): string | null {
	const p = path.join(wsPath, ".research", "lifecycle.json");
	if (!fs.existsSync(p)) return null;
	return (JSON.parse(fs.readFileSync(p, "utf-8")) as { current: string })
		.current;
}

describe("research invocation guard", () => {
	let mock: ReturnType<typeof makeMockPi>;
	let cwd: string;

	beforeEach(() => {
		mock = makeMockPi();
		piLoop(mock.pi as never);
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-invocation-guard-"));
	});

	afterEach(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	/** User-typed /research start (the ONLY legitimate kickoff). */
	async function startResearch(mission: string) {
		await mock.commands.research.handler(
			`--yes --profile quick ${mission}`,
			mockCtx(cwd, mock.sessionEntries),
		);
	}

	describe("session_start must not auto-continue a restored research loop", () => {
		it("pauses a restored active loop, gates research tools off, and queues no continuation", async () => {
			await startResearch("guard mission one");
			const wd = latestWorkingDir(mock);
			expect(wd).not.toBeNull();

			// During the user-started run, the research tools ARE reachable.
			expect(mock.getActiveTools()).toContain("research_checkpoint");
			expect(mock.getActiveTools()).toContain("complete_loop");

			// Simulate a session start that restores the active loop state.
			const ctx = mockCtx(cwd, mock.sessionEntries);
			mock.pi.getHandler("session_start")?.({ reason: "startup" }, ctx);

			// The loop is paused — not continued — and the user is told how
			// to explicitly resume.
			const notices = ctx.getNotifications();
			expect(notices.some((n) => n.message.includes("Loop paused"))).toBe(true);
			expect(notices.some((n) => n.message.includes("resume to continue"))).toBe(
				true,
			);
			expect(latestLoopEntry(mock)?.loop.status).toBe("paused");

			// The retained workspace lifecycle is paused too, so /research
			// resume (explicit user invocation) sees a resumable state.
			expect(lifecycleCurrent(wd!)).toBe("paused");

			// Research tools are no longer reachable while paused.
			expect(mock.getActiveTools()).not.toContain("research_checkpoint");
			expect(mock.getActiveTools()).not.toContain("complete_loop");

			// Agent settle must NOT queue a continuation while paused.
			const sendsBefore = mock.sendMessages.length;
			mock.pi.getHandler("agent_end")?.({}, mockCtx(cwd, mock.sessionEntries));
			await new Promise((r) => setTimeout(r, 5));
			expect(mock.sendMessages.length).toBe(sendsBefore);
		});
	});

	describe("explicit /research resume (user invocation) re-activates the loop", () => {
		it("resumes the workspace AND the paused loop engine, then continuations flow", async () => {
			await startResearch("guard mission two");
			const wd = latestWorkingDir(mock)!;

			// Session restart: pause + sync lifecycle, as in a fresh session.
			mock.pi.getHandler("session_start")?.(
				{ reason: "startup" },
				mockCtx(cwd, mock.sessionEntries),
			);
			expect(latestLoopEntry(mock)?.loop.status).toBe("paused");
			expect(lifecycleCurrent(wd)).toBe("paused");

			// The startup session's lease is stale by the next session (5-min
			// timeout) — model the expired lease so resume may re-acquire.
			fs.rmSync(path.join(wd, ".research", "run-lease.json"), {
				force: true,
			});

			// THE only way out: user types /research resume.
			const ctx = mockCtx(cwd, mock.sessionEntries);
			await mock.commands.research.handler("resume", ctx);

			expect(ctx.getNotifications()[0].message).toContain("Resumed");
			expect(lifecycleCurrent(wd)).toBe("active");
			// The paused loop engine was re-activated by the user invocation.
			expect(latestLoopEntry(mock)?.loop.status).toBe("active");
			expect(mock.getActiveTools()).toContain("research_checkpoint");

			// Agent settle now queues a continuation — research only resumes
			// AFTER the user typed /research resume, never by itself.
			const sendsBefore = mock.sendMessages.length;
			mock.pi.getHandler("agent_end")?.({}, mockCtx(cwd, mock.sessionEntries));
			await new Promise((r) => setTimeout(r, 5));
			expect(mock.sendMessages.length).toBeGreaterThan(sendsBefore);
		});
	});

	describe("research_checkpoint is not reachable outside a research run", () => {
		it("refuses at execution when no research loop is active", async () => {
			const tool = mock.tools.research_checkpoint;
			expect(tool).toBeDefined();
			const result = await tool.execute(
				"test-call",
				{ profile: "quick", round: 1, totalSources: 5 },
				undefined,
				undefined,
				mockCtx(cwd, mock.sessionEntries),
			);
			expect(result.isError).toBe(true);
			expect(result.content?.[0]?.text ?? "").toContain("No active research run");
		});

		it("is never registered as active outside a run", async () => {
			// No /research started — the tool must not be exposed.
			expect(mock.getActiveTools()).not.toContain("research_checkpoint");
			expect(mock.getActiveTools()).not.toContain("complete_loop");
		});
	});
});
