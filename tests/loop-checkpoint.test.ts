import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import piLoop from "../extensions/loop/index.ts";

// Integration coverage for research_checkpoint's honest source counting
// (Task 3 of deep-research-program-v2). These tests drive the REAL extension
// code — register it against a mock pi API, start a /research run (which
// creates a real working dir under /tmp and sets the module-level loop
// state), write notes.md into it, then invoke research_checkpoint's execute
// and assert the min(reported, counted) floor and the over-report hint.

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
		appendEntry: () => {},
		getActiveTools: () => [] as string[],
		setActiveTools: () => {},
	};
	return { pi, tools, commands };
}

function mockCtx(cwd: string) {
	return {
		cwd,
		ui: {
			notify: () => {},
			confirm: async () => true,
			setStatus: () => {},
		},
		isIdle: () => false,
	};
}

describe("research_checkpoint counts real sources from notes.md (integration)", () => {
	let mock: ReturnType<typeof makeMockPi>;
	let cwd: string;
	let researchDir: string;

	beforeEach(() => {
		mock = makeMockPi();
		piLoop(mock.pi as never);
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loop-test-"));
	});

	afterEach(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	// Starts a /research --yes --profile quick run and returns the run's
	// working dir (the newest dir under <cwd>/research/).
	async function startResearch(mission: string): Promise<string> {
		await mock.commands.research.handler(
			`--yes --profile quick "${mission}"`,
			mockCtx(cwd),
		);
		const researchRoot = path.join(cwd, "research");
		const dirs = fs
			.readdirSync(researchRoot)
			.map((d) => path.join(researchRoot, d))
			.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
		researchDir = dirs[0];
		return researchDir;
	}

	async function checkpoint(params: Record<string, unknown>): Promise<string> {
		const tool = mock.tools.research_checkpoint;
		const result = await tool.execute(
			"test-call",
			params,
			undefined,
			undefined,
			mockCtx(cwd),
		);
		return result.content?.[0]?.text ?? "";
	}

	it("applies min(reported, counted) and hints when the model over-reports", async () => {
		const dir = await startResearch("test mission one");
		fs.writeFileSync(
			path.join(dir, "notes.md"),
			[
				"- Claim A → https://example.com/a",
				"- Claim B → https://example.com/b",
				"- Claim C → https://example.com/c",
			].join("\n"),
		);
		const text = await checkpoint({
			profile: "quick",
			round: 1,
			totalSources: 10,
		});
		expect(text).toContain("🔴 CONTINUE");
		expect(text).toContain("min sources: 3/15"); // floor uses counted, not reported
		expect(text).toContain(
			"⚠ reported 10 sources but notes.md lists 3 unique URLs",
		);
	});

	it("falls back to the reported count when notes.md is absent (no hint)", async () => {
		await startResearch("test mission two");
		const text = await checkpoint({
			profile: "quick",
			round: 1,
			totalSources: 10,
		});
		expect(text).toContain("min sources: 10/15");
		expect(text).not.toContain("pass the real count");
	});

	it("counts zero URLs in a URL-less notes.md and still hints", async () => {
		const dir = await startResearch("test mission three");
		fs.writeFileSync(path.join(dir, "notes.md"), "no urls here\n");
		const text = await checkpoint({
			profile: "quick",
			round: 1,
			totalSources: 5,
		});
		expect(text).toContain(
			"⚠ reported 5 sources but notes.md lists 0 unique URLs",
		);
	});

	it("appends the hint to the max-rounds PROCEED verdict", async () => {
		const dir = await startResearch("test mission four");
		fs.writeFileSync(
			path.join(dir, "notes.md"),
			"- Claim → https://example.com/a\n",
		);
		const text = await checkpoint({
			profile: "quick",
			round: 10,
			totalSources: 10,
		});
		expect(text).toContain("🟢 PROCEED (max rounds reached)");
		expect(text).toContain(
			"⚠ reported 10 sources but notes.md lists 1 unique URLs",
		);
	});

	it("rejects unknown profiles with isError", async () => {
		const tool = mock.tools.research_checkpoint;
		const result = await tool.execute(
			"test-call",
			{ profile: "bogus", round: 1, totalSources: 5 },
			undefined,
			undefined,
			mockCtx(cwd),
		);
		expect(result.isError).toBe(true);
		expect(result.content?.[0]?.text).toContain('Unknown profile "bogus"');
	});

	it("is happy without an active loop (reported fallback, no hint)", async () => {
		// Explicitly clear any loop state left by earlier tests.
		await mock.commands.research.handler("clear", mockCtx(cwd));
		const text = await checkpoint({
			profile: "quick",
			round: 1,
			totalSources: 5,
		});
		expect(text).toContain("min sources: 5/15");
		expect(text).not.toContain("pass the real count");
	});
});
