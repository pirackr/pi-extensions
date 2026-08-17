import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import piLoop from "../extensions/loop/index.ts";
import {
	countUniqueSourceUrls,
	effectiveSourceCount,
} from "../extensions/loop/sources.ts";
import { readRunState, updateRunState } from "../extensions/research/state.ts";
import { computeEvidenceDigest } from "../extensions/research/checkpoint.ts";
import type { Workspace } from "../extensions/research/workspace.ts";

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
		// Model registry view backing buildResearchDeps (loop/index.ts).
		modelRegistry: fakeModelRegistry(),
	};
}

/**
 * Fake Pi model registry with the research role aliases (strong/eval/light)
 * plus one registered provider id. Backs the ModelRegistryView/ProviderRegistryView
 * injected into prepareAndActivateResearch by loop/index.ts.
 */
function fakeModelRegistry() {
	const models = [
		{ id: "local/strong", name: "strong", provider: "local", reasoning: true, input: ["text"] },
		{ id: "local/fast", name: "fast", provider: "local", reasoning: false, input: ["text"] },
		{ id: "local/eval", name: "eval", provider: "local", reasoning: true, input: ["text"] },
		{ id: "local/light", name: "light", provider: "local", reasoning: false, input: ["text"] },
	];
	return {
		getAll: () => models,
		getRegisteredProviderIds: () => ["local"],
		getProvider: () => undefined,
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

	it("defaults come from config/research.json when flags are absent", async () => {
		const ctx = mockCtx(cwd);
		// Note: no --yes flag so the startup contract confirm is shown.
		await mock.commands.research.handler("test mission", ctx);
		expect(mock.pi.appendEntry).toHaveBeenCalled();
		// The startup engine shows the resolved contract (default profile = standard)
		const calls = ctx.getConfirmCalls();
		expect(calls).toHaveLength(1);
		const flat = calls[0].message
			.replace(/[^\w\s:.]/g, " ")
			.replace(/\s+/g, " ");
		expect(flat).toContain("Profile: standard");
		expect(flat).toContain("Max Rounds: 5");
		expect(flat).toContain("Min Sources: 30");
	});

	it("CLI flag overrides JSON default", async () => {
		const ctx = mockCtx(cwd);
		// Note: no --yes flag so the startup contract confirm is shown (then approved).
		await mock.commands.research.handler(
			"--max-searches-per-agent 5 --max-fetches-per-agent 3 test mission",
			ctx,
		);
		const calls = ctx.getConfirmCalls();
		expect(calls).toHaveLength(1);
		// The CLI flags override the JSON defaults in the persisted loop state.
		const appendCalls = (mock.pi.appendEntry as ReturnType<typeof vi.fn>).mock
			.calls;
		const loopData = appendCalls[appendCalls.length - 1][1] as {
			loop?: Record<string, unknown>;
		};
		expect(loopData.loop?.maxSearchesPerAgent).toBe(5);
		expect(loopData.loop?.maxFetchesPerAgent).toBe(3);
	});

	it("resolved-value confirmation text contains the requested profile", async () => {
		const ctx = mockCtx(cwd);
		// Note: no --yes flag so the startup contract confirm is shown.
		await mock.commands.research.handler("--profile quick test mission", ctx);
		const calls = ctx.getConfirmCalls();
		expect(calls).toHaveLength(1);
		const msg = calls[0].message;
		const flat = msg.replace(/[^\w\s:.]/g, " ").replace(/\s+/g, " ");
		expect(flat).toContain("Mission: test mission");
		expect(flat).toContain("Profile: quick");
	});

	it("persistence captures loop with budgets via appendEntry", async () => {
		await mock.commands.research.handler(
			"--yes --max-searches-per-agent 7 --max-fetches-per-agent 4 test mission",
			mockCtx(cwd),
		);
		const appendCalls = (mock.pi.appendEntry as ReturnType<typeof vi.fn>).mock
			.calls;
		expect(appendCalls.length).toBeGreaterThan(0);
		const loopData = appendCalls[appendCalls.length - 1][1] as {
			loop?: Record<string, unknown>;
		};
		expect(loopData.loop).toBeDefined();
		expect(loopData.loop?.maxSearchesPerAgent).toBe(7);
		expect(loopData.loop?.maxFetchesPerAgent).toBe(4);
	});
});

// Unit coverage for the source-counting helpers (restored after the Task 3
// rewrite dropped them — the checkpoint integration test covers the happy
// path, these pin the edge cases).
describe("countUniqueSourceUrls", () => {
	it("counts unique URLs, dedupes, ignores non-URL lines", () => {
		const text = [
			"- Claim A → https://example.com/a",
			"- Claim B → https://example.com/b",
			"- Claim C → https://example.com/a (duplicate)",
			"Source: https://arxiv.org/abs/2402.02716",
			"no url here",
		].join("\n");
		expect(countUniqueSourceUrls(text)).toBe(3);
	});

	it("strips trailing punctuation from URLs", () => {
		expect(countUniqueSourceUrls("see https://example.com/x.")).toBe(1);
	});

	it("ignores non-http schemes", () => {
		expect(countUniqueSourceUrls("mailto:a@b.c and ftp://x")).toBe(0);
	});

	it("returns 0 for empty text", () => {
		expect(countUniqueSourceUrls("")).toBe(0);
	});
});

describe("effectiveSourceCount", () => {
	it("uses min(reported, counted) and hints when the model over-reports", () => {
		const result = effectiveSourceCount(24, 18);
		expect(result.sources).toBe(18);
		expect(result.hint).toContain("reported 24");
		expect(result.hint).toContain("18");
	});

	it("trusts reported when counted >= reported", () => {
		expect(effectiveSourceCount(18, 24)).toEqual({ sources: 18, hint: "" });
	});

	it("falls back to reported when notes.md is unavailable (null)", () => {
		expect(effectiveSourceCount(20, null)).toEqual({ sources: 20, hint: "" });
	});
});

// --- End-to-end mocked /research runs (Task 7) ------------------------------
// These tests drive the REAL extension engine through the full happy path
// (start → write artifacts → checkpoint → complete_loop) and the capped-run
// counterpart (partial artifacts survive but complete_loop rejects).

function latestLoopState(
	entries: Array<{ type: string; data: unknown }>,
): {
	loop?: {
		id?: string;
		status?: string;
		checkpointEvidence?: unknown;
		profile?: string;
		workingDir?: string;
	};
} | null {
	const last = entries[entries.length - 1];
	return last
		? (last.data as {
				loop?: {
					id?: string;
					status?: string;
					checkpointEvidence?: unknown;
					profile?: string;
					workingDir?: string;
				};
			})
		: null;
}

function writeScoreTable(
	dir: string,
	rows: Array<{ id: string; score: number }>,
): void {
	const header = "| ID | Question | Score | Notes |";
	const sep = "| --- | --- | ---: | --- |";
	const body = rows
		.map((r) => `| ${r.id} | some question | ${r.score} | some notes |`)
		.join("\n");
	fs.writeFileSync(path.join(dir, "score.md"), `${header}\n${sep}\n${body}\n`);
}

function writeJudge(
	dir: string,
	runId: string,
	opts?: { pass?: boolean; verdict?: string },
): void {
	const a = {
		version: 1,
		runId,
		pass: opts?.pass ?? true,
		verdict: opts?.verdict ?? "PASS",
		failedChecks: [],
		fixes: [],
	};
	fs.mkdirSync(path.join(dir, "verification"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, "verification", "judge.json"),
		JSON.stringify(a),
	);
}

describe("full mocked /research run with quick profile", () => {
	let entries: Array<{ type: string; data: unknown }>;
	let cwd: string;
	let mock: ReturnType<typeof makeMockPi>;

	beforeEach(() => {
		mock = makeMockPi();
		// Capture appendEntry calls so we can inspect persisted loop state.
		entries = [];
		(mock.pi.appendEntry as ReturnType<typeof vi.fn>).mockImplementation(
			(type: string, data: unknown) => {
				entries.push({ type, data });
			},
		);
		piLoop(mock.pi as never);
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loop-test-"));
	});

	afterEach(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	async function startResearch(mission: string, flags = ""): Promise<string> {
		await mock.commands.research.handler(
			`--yes ${flags} "${mission}"`,
			mockCtx(cwd),
		);
		// The research workspace (workingDir) is set on the loop state by the
		// startup engine wiring (prepareAndActivateResearch).
		const ls = latestLoopState(entries);
		const workingDir = ls?.loop?.workingDir;
		expect(workingDir).toBeTruthy();
		return workingDir!;
	}

	async function checkpoint(
		dir: string,
		profile: string,
		round: number,
		totalSources: number,
	): Promise<string> {
		const tool = mock.tools.research_checkpoint;
		const result = await tool.execute(
			"test-call",
			{ profile, round, totalSources },
			undefined,
			undefined,
			mockCtx(cwd),
		);
		const text = result.content?.[0]?.text ?? "";
		// Task 11: complete_loop's researchCompletionGate reads the checkpoint
		// from the workspace run-state on disk, so persist the recorded verdict
		// + evidence digest here (mirrors evaluateCheckpoint's persistence).
		const verdict: "PROCEED" | "PROCEED_WITH_GAPS" | "CONTINUE" = text.includes(
			"PROCEED_WITH_GAPS",
		)
			? "PROCEED_WITH_GAPS"
			: text.includes("PROCEED")
				? "PROCEED"
				: "CONTINUE";
		await persistCheckpoint(dir, profile, verdict);
		return text;
	}

	/** Authoritative runId from the workspace run-state on disk. */
	function diskRunId(dir: string): string {
		return readRunState({ path: dir } as Workspace).runId;
	}

	/** Persist a checkpoint verdict + evidence digest to run-state.json. */
	async function persistCheckpoint(
		dir: string,
		profile: string,
		verdict: "PROCEED" | "PROCEED_WITH_GAPS" | "CONTINUE",
	): Promise<void> {
		const ws = { path: dir } as Workspace;
		const state = readRunState(ws);
		const score = fs.readFileSync(path.join(dir, "score.md"), "utf8");
		let notes = "";
		try {
			notes = fs.readFileSync(path.join(dir, "notes.md"), "utf8");
		} catch {
			// notes.md missing — digest covers what's available
		}
		const digest = computeEvidenceDigest(score, notes);
		await updateRunState(ws, state.revision, (c) => ({
			...c,
			checkpointVerdict: verdict,
			checkpointDigest: digest,
			checkpointUnmet: [],
			checkpointUniqueSources: 20,
			researchRound: c.researchRound,
			loopIteration: 1,
			checkpointProfile: profile,
		}));
	}

	async function completeLoop(): Promise<{ text: string; isError?: boolean }> {
		const tool = mock.tools.complete_loop;
		const result = await tool.execute(
			"test-call",
			{ status: "complete" },
			undefined,
			undefined,
			mockCtx(cwd),
		);
		return { text: result.content?.[0]?.text ?? "", isError: result.isError };
	}

	it("succeeds end-to-end: plan → artifacts → checkpoint → complete_loop", async () => {
		const dir = await startResearch("test mission full e2e", "--profile quick");
		const ls = latestLoopState(entries);
		const loopId = ls!.loop!.id!;

		// Write score.md (5 rows, all scores >= 80 — threshold is 80).
		writeScoreTable(dir, [
			{ id: "q1", score: 90 },
			{ id: "q2", score: 85 },
			{ id: "q3", score: 95 },
			{ id: "q4", score: 80 },
			{ id: "q5", score: 88 },
		]);

		// Write notes.md with real URLs (quick minSources=15).
		const notesUrls = Array.from(
			{ length: 18 },
			(_, i) => `https://example.com/source-${i}`,
		)
			.map((u) => `- Claim → ${u}`)
			.join("\n");
		fs.writeFileSync(path.join(dir, "notes.md"), `${notesUrls}\n`);

		// Write scout-outputs (round 3, any slug).
		fs.mkdirSync(path.join(dir, "scout-outputs"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, "scout-outputs", "3-findings-scout.md"),
			"# Scout report\n\nSome scout findings.\n",
		);

		// Write report.org (non-empty, with inline [[URL][description]] citations).
		fs.writeFileSync(
			path.join(dir, "report.org"),
			"* Deep Research — test mission full e2e\n\n** Executive Summary\n\n** Findings\n\n[[https://example.com/source-0][Source 0]]\n\n",
		);

		// Write verification/judge.json (version 1, runId === workspace runId, pass=true, verdict=PASS).
		writeJudge(dir, diskRunId(dir));

		// Invoke research_checkpoint: round=3 (quick minRounds=3, maxRounds=3), sources=18 (>= quick minSources=15).
		const cpText = await checkpoint(dir, "quick", 3, 18);
		expect(cpText).toContain("PROCEED");

		// Verify checkpointEvidence was recorded in persisted state.
		const cpState = latestLoopState(entries);
		expect(cpState?.loop?.checkpointEvidence).toBeDefined();
		const ce = cpState!.loop!.checkpointEvidence as {
			runId: string;
			verdict: string;
		};
		expect(ce.runId).toBe(loopId);
		expect(ce.verdict).toBe("PROCEED");

		// Invoke complete_loop — should succeed.
		const result = await completeLoop();
		expect(result.isError).toBeFalsy();
		expect(result.text).toContain("complete");

		// Verify loop.status is now "complete" in persisted state.
		const finalState = latestLoopState(entries);
		expect(finalState!.loop!.status).toBe("complete");
	});

	it("preserves partial artifacts in a capped run and rejects completion", async () => {
		const dir = await startResearch(
			"test mission capped",
			"--profile quick --max-rounds 2",
		);

		// Write score.md with scores BELOW threshold (80).
		writeScoreTable(dir, [
			{ id: "q1", score: 50 },
			{ id: "q2", score: 60 },
			{ id: "q3", score: 70 },
			{ id: "q4", score: 55 },
			{ id: "q5", score: 65 },
		]);

		// Write notes.md with only a few URLs (below minSources=15).
		fs.writeFileSync(
			path.join(dir, "notes.md"),
			"- Claim → https://example.com/one\n- Claim → https://example.com/two\n",
		);

		// Write partial report.org.
		fs.writeFileSync(
			path.join(dir, "report.org"),
			"* Partial Report\n\nSome partial findings.\n",
		);

		// Write scout output but intentionally MISSING verification/judge.json.
		fs.mkdirSync(path.join(dir, "scout-outputs"), { recursive: true });
		fs.writeFileSync(
			path.join(dir, "scout-outputs", "2-partial-scout.md"),
			"# Partial scout\n\n",
		);

		// Invoke research_checkpoint at round=2 (effective max=2 reached).
		const cpText = await checkpoint(dir, "quick", 2, 3);
		expect(cpText).toContain("PROCEED_WITH_GAPS");

		// Verify loop status is still "active" (not complete).
		const afterCp = latestLoopState(entries);
		expect(afterCp!.loop!.status).toBe("active");

		// Invoke complete_loop — should reject with unmet gates.
		const result = await completeLoop();
		expect(result.isError).toBe(true);
		// Should list missing verification artifact (judge.json) since checkpoint evidence is present.
		expect(result.text).toContain("verification:");

		// Assert partial artifacts still exist (never deleted).
		expect(fs.existsSync(path.join(dir, "score.md"))).toBe(true);
		expect(fs.existsSync(path.join(dir, "notes.md"))).toBe(true);
		expect(fs.existsSync(path.join(dir, "report.org"))).toBe(true);
		expect(
			fs.existsSync(path.join(dir, "scout-outputs", "2-partial-scout.md")),
		).toBe(true);

		// Verify loop is NOT marked complete.
		const finalState = latestLoopState(entries);
		expect(finalState!.loop!.status).not.toBe("complete");
	});
});
