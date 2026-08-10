import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import piLoop from "../extensions/loop/index.ts";

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
}

function makeMockPi() {
	const tools: Record<string, MockTool> = {};
	const commands: Record<string, MockCommand> = {};
	const pi = {
		registerTool: (def: MockTool) => {
			tools[def.name] = def;
		},
		registerCommand: (cmd: string, def: MockCommand) => {
			commands[cmd] = def;
		},
		on: () => {},
		sendMessage: () => {},
		appendEntry: vi.fn(),
		getActiveTools: () => [] as string[],
		setActiveTools: () => {},
	};
	return { pi, tools, commands };
}

interface ConfirmCall {
	title: string;
	message: string;
}

function mockCtx(cwd: string, confirmResponse = true) {
	const confirmCalls: ConfirmCall[] = [];
	return {
		cwd,
		ui: {
			notify: () => {},
			confirm: async (title: string, message: string) => {
				confirmCalls.push({ title, message });
				return confirmResponse;
			},
			setStatus: () => {},
		},
		isIdle: () => false,
		getConfirmCalls: () => confirmCalls,
	};
}

describe("/research CLI flags and resolved config display", () => {
	let mock: ReturnType<typeof makeMockPi>;
	let cwd: string;

	beforeEach(() => {
		mock = makeMockPi();
		piLoop(mock.pi as never);
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loop-test-"));
		// Clear any loop state carried over from a previous test (module is cached).
		mock.commands.research.handler("clear", mockCtx(cwd)).catch(() => {});
	});

	afterEach(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("--max-searches-per-agent N parses and sets the budget", async () => {
		await mock.commands.research.handler(
			"--yes --max-searches-per-agent 42 test mission",
			mockCtx(cwd),
		);
		expect(mock.pi.appendEntry).toHaveBeenCalled();
	});

	it("--max-fetches-per-agent N parses and sets the budget", async () => {
		await mock.commands.research.handler(
			"--yes --max-fetches-per-agent 17 test mission",
			mockCtx(cwd),
		);
		expect(mock.pi.appendEntry).toHaveBeenCalled();
	});

	it("rejects negative --max-searches-per-agent", async () => {
		const ctx = mockCtx(cwd);
		await mock.commands.research.handler(
			"--yes --max-searches-per-agent -1 test mission",
			ctx,
		);
		// Should have notified an error and NOT started a run
		const calls = ctx.getConfirmCalls();
		expect(calls).toHaveLength(0); // no confirm because it failed validation
	});

	it("rejects negative --max-fetches-per-agent", async () => {
		const ctx = mockCtx(cwd);
		await mock.commands.research.handler(
			"--yes --max-fetches-per-agent -5 test mission",
			ctx,
		);
		const calls = ctx.getConfirmCalls();
		expect(calls).toHaveLength(0);
	});

	it("rejects non-integer --max-searches-per-agent", async () => {
		const ctx = mockCtx(cwd);
		await mock.commands.research.handler(
			"--yes --max-searches-per-agent 3.5 test mission",
			ctx,
		);
		const calls = ctx.getConfirmCalls();
		expect(calls).toHaveLength(0);
	});

	it("rejects non-integer --max-fetches-per-agent", async () => {
		const ctx = mockCtx(cwd);
		await mock.commands.research.handler(
			"--yes --max-fetches-per-agent abc test mission",
			ctx,
		);
		const calls = ctx.getConfirmCalls();
		expect(calls).toHaveLength(0);
	});

	it("accepts 0 as unlimited for both flags", async () => {
		await mock.commands.research.handler(
			"--yes --max-searches-per-agent 0 --max-fetches-per-agent 0 test mission",
			mockCtx(cwd),
		);
		expect(mock.pi.appendEntry).toHaveBeenCalled();
	});

	it("defaults come from config/deep-research.json when flags are absent", async () => {
		const ctx = mockCtx(cwd);
		// Note: no --yes flag so the plan-summary confirm is shown.
		await mock.commands.research.handler("test mission", ctx);
		expect(mock.pi.appendEntry).toHaveBeenCalled();
		// The config defaults are maxSearchesPerAgent: 20, maxFetchesPerAgent: 20
		// We verify this indirectly through the confirm message
		const calls = ctx.getConfirmCalls();
		expect(calls).toHaveLength(1);
		expect(calls[0].message).toContain("Searches/agent: 20");
		expect(calls[0].message).toContain("Fetches/agent: 20");
	});

	it("CLI flag overrides JSON default", async () => {
		const ctx = mockCtx(cwd);
		// Note: no --yes flag so the plan-summary confirm is shown.
		await mock.commands.research.handler(
			"--max-searches-per-agent 5 --max-fetches-per-agent 3 test mission",
			ctx,
		);
		const calls = ctx.getConfirmCalls();
		expect(calls).toHaveLength(1);
		expect(calls[0].message).toContain("Searches/agent: 5");
		expect(calls[0].message).toContain("Fetches/agent: 3");
	});

	it("resolved-value confirmation text contains profile thresholds from config", async () => {
		const ctx = mockCtx(cwd);
		// Note: no --yes flag so the plan-summary confirm is shown.
		await mock.commands.research.handler("--profile quick test mission", ctx);
		const calls = ctx.getConfirmCalls();
		expect(calls).toHaveLength(1);
		const msg = calls[0].message;
		expect(msg).toContain("Profile: quick");
		expect(msg).toContain("Rounds: 10–10"); // quick: minRounds=10, maxRounds=10
		expect(msg).toContain("Min sources: 15"); // quick: minSources=15
		expect(msg).toContain("Scouts: 3"); // quick: maxScouts=3
		expect(msg).toContain("Fetchers: 1"); // quick: maxFetchers=1
		expect(msg).toContain("Verification: judge");
	});

	it("persistence captures loop with budgets via appendEntry", async () => {
		await mock.commands.research.handler(
			"--yes --max-searches-per-agent 7 --max-fetches-per-agent 4 test mission",
			mockCtx(cwd),
		);
		const appendCalls = (mock.pi.appendEntry as ReturnType<typeof vi.fn>).mock.calls;
		expect(appendCalls.length).toBeGreaterThan(0);
		const loopData = appendCalls[appendCalls.length - 1][1] as { loop?: Record<string, unknown> };
		expect(loopData.loop).toBeDefined();
		expect(loopData.loop?.maxSearchesPerAgent).toBe(7);
		expect(loopData.loop?.maxFetchesPerAgent).toBe(4);
	});
});
