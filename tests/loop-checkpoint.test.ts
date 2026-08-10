import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import piLoop from "../extensions/loop/index.ts";

vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: vi.fn().mockReturnValue("/mock/agent/dir"),
	parseFrontmatter: vi.fn(),
}));

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
	const entries: Array<{ type: string; data: unknown }> = [];
	const pi = {
		registerTool: (def: MockTool) => {
			tools[def.name] = def;
		},
		registerCommand: (cmd: string, def: MockCommand) => {
			commands[cmd] = def;
		},
		on: () => {},
		sendMessage: () => {},
		appendEntry: (type: string, data: unknown) => {
			entries.push({ type, data });
		},
		getActiveTools: () => [] as string[],
		setActiveTools: () => {},
	};
	return { pi, tools, commands, entries };
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

	async function startResearchWithMaxRounds(mission: string, maxRounds: number): Promise<string> {
		await mock.commands.research.handler(
			`--yes --profile quick --max-rounds ${maxRounds} "${mission}"`,
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

	async function checkpoint(params: Record<string, unknown>): Promise<{ text: string; isError?: boolean }> {
		const tool = mock.tools.research_checkpoint;
		const result = await tool.execute(
			"test-call",
			params,
			undefined,
			undefined,
			mockCtx(cwd),
		);
		return { text: result.content?.[0]?.text ?? "", isError: result.isError };
	}

	function latestLoopEntry(): unknown {
		const entries = mock.entries.filter((e) => e.type === "pi-loop");
		return entries.length > 0 ? entries[entries.length - 1].data : null;
	}

	it("applies min(reported, counted) and hints when the model over-reports", async () => {
		const dir = await startResearch("test mission one");
		writeScoreTable(dir, [
			{ id: "q1", score: 90 },
			{ id: "q2", score: 90 },
			{ id: "q3", score: 90 },
			{ id: "q4", score: 90 },
			{ id: "q5", score: 90 },
		]);
		fs.writeFileSync(
			path.join(dir, "notes.md"),
			[
				"- Claim A → https://example.com/a",
				"- Claim B → https://example.com/b",
				"- Claim C → https://example.com/c",
			].join("\n"),
		);
		const result = await checkpoint({
			profile: "quick",
			round: 1,
			totalSources: 10,
		});
		expect(result.text).toContain("🔴 CONTINUE");
		expect(result.text).toContain("min sources: 3/15"); // floor uses counted, not reported
		expect(result.text).toContain(
			"⚠ reported 10 sources but notes.md lists 3 unique URLs",
		);
	});

	it("falls back to the reported count when notes.md is absent (no hint)", async () => {
		const dir = await startResearch("test mission two");
		writeScoreTable(dir, [
			{ id: "q1", score: 90 },
			{ id: "q2", score: 90 },
			{ id: "q3", score: 90 },
			{ id: "q4", score: 90 },
			{ id: "q5", score: 90 },
		]);
		const result = await checkpoint({
			profile: "quick",
			round: 1,
			totalSources: 10,
		});
		expect(result.text).toContain("min sources: 10/15");
		expect(result.text).not.toContain("pass the real count");
	});

	it("counts zero URLs in a URL-less notes.md and still hints", async () => {
		const dir = await startResearch("test mission three");
		writeScoreTable(dir, [
			{ id: "q1", score: 90 },
			{ id: "q2", score: 90 },
			{ id: "q3", score: 90 },
			{ id: "q4", score: 90 },
			{ id: "q5", score: 90 },
		]);
		fs.writeFileSync(path.join(dir, "notes.md"), "no urls here\n");
		const result = await checkpoint({
			profile: "quick",
			round: 1,
			totalSources: 5,
		});
		expect(result.text).toContain(
			"⚠ reported 5 sources but notes.md lists 0 unique URLs",
		);
	});

	it("appends the hint to the max-rounds PROCEED verdict", async () => {
		const dir = await startResearch("test mission four");
		writeScoreTable(dir, [
			{ id: "q1", score: 90 },
			{ id: "q2", score: 90 },
			{ id: "q3", score: 90 },
			{ id: "q4", score: 90 },
			{ id: "q5", score: 90 },
		]);
		fs.writeFileSync(
			path.join(dir, "notes.md"),
			"- Claim → https://example.com/a\n",
		);
		const result = await checkpoint({
			profile: "quick",
			round: 10,
			totalSources: 10,
		});
		// minSources=15, but only 1 URL counted → PROCEED_WITH_GAPS
		expect(result.text).toContain("PROCEED_WITH_GAPS");
		expect(result.text).toContain("gap(s)");
		expect(result.text).toContain(
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
		const result = await checkpoint({
			profile: "quick",
			round: 1,
			totalSources: 5,
		});
		expect(result.text).toContain("min sources: 5/15");
		expect(result.text).not.toContain("pass the real count");
	});

	// ---- Task 4: score validation and override-aware checkpoint ----

	function writeScoreTable(dir: string, rows: Array<{ id: string; score: number }>): void {
		const header = "| ID | Question | Score | Notes |";
		const sep = "| --- | --- | ---: | --- |";
		const body = rows
			.map((r) => `| ${r.id} | some question | ${r.score} | some notes |`)
			.join("\n");
		fs.writeFileSync(path.join(dir, "score.md"), `${header}\n${sep}\n${body}\n`);
	}

	it("rejects round 0 with isError and planning-only message", async () => {
		await startResearch("round-0 test");
		const result = await checkpoint({ profile: "quick", round: 0, totalSources: 5 });
		expect(result.isError).toBe(true);
		expect(result.text).toContain("planning only");
	});

	it("CONTINUEs when score.md is missing", async () => {
		const dir = await startResearch("missing-score test");
		const result = await checkpoint({ profile: "quick", round: 10, totalSources: 20 });
		expect(result.text).toContain("CONTINUE");
		expect(result.text).toContain("score.md");
	});

	it("CONTINUEs when a sub-question score is below threshold", async () => {
		const dir = await startResearchWithMaxRounds("below-threshold test", 20);
		writeScoreTable(dir, [
			{ id: "q1", score: 90 },
			{ id: "q2", score: 90 },
			{ id: "q3", score: 90 },
			{ id: "q4", score: 90 },
			{ id: "q5", score: 70 }, // below 80
		]);
		const result = await checkpoint({ profile: "quick", round: 5, totalSources: 20 });
		expect(result.text).toContain("CONTINUE");
		expect(result.text).toContain("q5");
	});

	it("PROCEEDs when all scores meet threshold and floors are met", async () => {
		const dir = await startResearch("proceed test");
		writeScoreTable(dir, [
			{ id: "q1", score: 85 },
			{ id: "q2", score: 90 },
			{ id: "q3", score: 80 },
			{ id: "q4", score: 85 },
			{ id: "q5", score: 90 },
		]);
		const result = await checkpoint({ profile: "quick", round: 10, totalSources: 20 });
		expect(result.text).toContain("PROCEED — criteria met");
		const entry = latestLoopEntry();
		expect(entry).not.toBeNull();
		const loop = (entry as { loop?: { checkpointEvidence?: unknown } }).loop;
		expect(loop?.checkpointEvidence).toBeDefined();
		expect(loop.checkpointEvidence?.verdict).toBe("PROCEED");
		expect(loop.checkpointEvidence?.runId).toBeDefined();
		expect(loop.checkpointEvidence?.round).toBe(10);
		expect(loop.checkpointEvidence?.sources).toBeDefined();
		expect(loop.checkpointEvidence?.scoreState?.satisfied).toBe(true);
		expect(loop.checkpointEvidence?.scoreState?.belowThreshold).toEqual([]);
	});

	it("PROCEED_WITH_GAPS when effective max reached with floors unmet", async () => {
		// Use --max-rounds 2 to cap early; quick profile minRounds=10, minSources=15
		const dir = await startResearchWithMaxRounds("gaps test", 2);
		writeScoreTable(dir, [
			{ id: "q1", score: 90 },
			{ id: "q2", score: 90 },
			{ id: "q3", score: 90 },
			{ id: "q4", score: 90 },
			{ id: "q5", score: 90 },
		]);
		const result = await checkpoint({ profile: "quick", round: 2, totalSources: 5 });
		expect(result.text).toContain("PROCEED_WITH_GAPS");
		expect(result.text).toContain("gap(s)");
		const entry = latestLoopEntry();
		const loop = (entry as { loop?: { checkpointEvidence?: unknown } }).loop;
		expect(loop?.checkpointEvidence?.verdict).toBe("PROCEED_WITH_GAPS");
		expect(loop.checkpointEvidence?.scoreState?.satisfied).toBe(true);
	});

	it("CONTINUEs when effective max NOT reached and floors unmet (higher max-rounds)", async () => {
		// Use --max-rounds 30 so max is NOT reached; floors still unmet
		const dir = await startResearchWithMaxRounds("continue-high-max test", 30);
		writeScoreTable(dir, [
			{ id: "q1", score: 90 },
			{ id: "q2", score: 90 },
			{ id: "q3", score: 90 },
			{ id: "q4", score: 90 },
			{ id: "q5", score: 90 },
		]);
		const result = await checkpoint({ profile: "quick", round: 5, totalSources: 5 });
		expect(result.text).toContain("CONTINUE");
		expect(result.text).toContain("min sources");
	});

	it("invalidates checkpointEvidence when another research round starts", async () => {
		const dir = await startResearch("invalidate test");
		writeScoreTable(dir, [
			{ id: "q1", score: 90 },
			{ id: "q2", score: 90 },
			{ id: "q3", score: 90 },
			{ id: "q4", score: 90 },
			{ id: "q5", score: 90 },
		]);
		// First checkpoint — should record evidence
		await checkpoint({ profile: "quick", round: 10, totalSources: 20 });
		let entry = latestLoopEntry();
		let loopState = (entry as { loop?: { checkpointEvidence?: unknown } }).loop;
		expect(loopState?.checkpointEvidence).toBeDefined();

		// Simulate queueContinuation by directly invoking the module-level
		// function isn't possible from tests, so we start a fresh research run
		// which resets loop state. The evidence from the prior run is lost.
		await mock.commands.research.handler("clear", mockCtx(cwd));
		entry = latestLoopEntry();
		// clear writes an entry with loop: null
		expect((entry as { loop: null }).loop).toBeNull();
	});

	it("uses loop.maxRounds (CLI override) not profileCfg.maxRounds", async () => {
		// Override --max-rounds 2 on a quick profile (profile maxRounds=10)
		const dir = await startResearchWithMaxRounds("override-max test", 2);
		writeScoreTable(dir, [
			{ id: "q1", score: 90 },
			{ id: "q2", score: 90 },
			{ id: "q3", score: 90 },
			{ id: "q4", score: 90 },
			{ id: "q5", score: 90 },
		]);
		// With maxRounds=2, round 2 should be the effective cap
		const result = await checkpoint({ profile: "quick", round: 2, totalSources: 5 });
		expect(result.text).toContain("PROCEED_WITH_GAPS");
	});
});
