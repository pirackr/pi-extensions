import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import type { Workspace } from "../extensions/research/workspace.ts";
import {
	newRunState,
	readRunState,
	updateRunState,
} from "../extensions/research/state.ts";
import { createRunManifest } from "../extensions/research/manifest.ts";
import {
	evaluateCheckpoint,
	canonicalizeUrl,
	parseScoreTable,
	parseLedger,
	type ScoreRow,
	type LedgerRow,
	type CheckpointResult,
} from "../extensions/research/checkpoint.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "checkpoint-test-"));
}

function cleanup(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

function makeFakeWorkspace(
	tmpDir: string,
	mission: string,
	transitionId: string,
): Workspace {
	const wsPath = path.join(tmpDir, mission.replace(/\s+/g, "-"));
	fs.mkdirSync(wsPath, { recursive: false });
	fs.mkdirSync(path.join(wsPath, ".research"), { recursive: false });
	return {
		path: wsPath,
		projectRoot: tmpDir,
		mission,
		runId: `${transitionId}-${mission.replace(/\s+/g, "-")}`,
		transitionId,
	};
}

function initWorkspace(ws: Workspace, profile = "standard", researchRound = 0): void {
	const init = newRunState(ws);
	init.checkpointProfile = profile;
	init.researchRound = researchRound;
	fs.writeFileSync(
		path.join(ws.path, ".research", "run-state.json"),
		JSON.stringify(init, null, 2),
		"utf-8",
	);
	// Write a minimal manifest (required by evaluateCheckpoint for run identity)
	createRunManifest(ws);
}

function writeScoreTable(ws: Workspace, rows: Array<{ id: string; score: number }>): void {
	const header = "| ID | Question | Score | Notes |";
	const sep = "| --- | --- | ---: | --- |";
	const body = rows
		.map((r) => `| ${r.id} | some question | ${r.score} | some notes |`)
		.join("\n");
	fs.writeFileSync(path.join(ws.path, "score.md"), `${header}\n${sep}\n${body}\n`);
}

function writeLedger(ws: Workspace, rows: Array<{ url: string; title: string }>): void {
	const header = "| URL | Title | Tier | Retrieved | Claims |";
	const sep = "| --- | --- | --- | --- | --- |";
	const body = rows
		.map((r) => `| ${r.url} | ${r.title} | tier1 | 2024-01-01 | 1 |`)
		.join("\n");
	fs.writeFileSync(path.join(ws.path, "notes.md"), `${header}\n${sep}\n${body}\n`);
}

function buildWs(tmpDir: string, name: string, transitionId: string): Workspace {
	const wsPath = path.join(tmpDir, name);
	fs.mkdirSync(wsPath, { recursive: false });
	fs.mkdirSync(path.join(wsPath, ".research"), { recursive: false });
	return {
		path: wsPath,
		projectRoot: tmpDir,
		mission: name,
		runId: `${transitionId}-${name}`,
		transitionId,
	};
}

// ===========================================================================
// parseScoreTable — exact columns, unique IDs, 0–100 integer scores, 5–8 rows
// ===========================================================================

describe("parseScoreTable", () => {
	it("parses a valid 5-row score table", () => {
		const text = [
			"| ID | Question | Score | Notes |",
			"| --- | --- | ---: | --- |",
			"| q1 | What is the capital? | 90 | good answer |",
			"| q2 | Is it safe? | 85 | yes |",
			"| q3 | Cost effective? | 80 | yes |",
			"| q4 | Performance? | 95 | excellent |",
			"| q5 | Usability? | 70 | okay |",
		].join("\n");
		const result = parseScoreTable(text);
		expect(result).toEqual<ScoreRow[]>([
			{ id: "q1", score: 90 },
			{ id: "q2", score: 85 },
			{ id: "q3", score: 80 },
			{ id: "q4", score: 95 },
			{ id: "q5", score: 70 },
		]);
	});

	it("parses an 8-row score table (max structural range)", () => {
		const rows = Array.from({ length: 8 }, (_, i) => `| q${i + 1} | q | 80 | n |`);
		const text = ["| ID | Question | Score | Notes |", "| --- | --- | ---: | --- |", ...rows].join("\n");
		const result = parseScoreTable(text);
		expect(result.length).toBe(8);
		expect(result[0].id).toBe("q1");
		expect(result[7].id).toBe("q8");
	});

	it("rejects table with fewer than 5 rows", () => {
		const rows = ["| q1 | q | 80 | n |", "| q2 | q | 80 | n |", "| q3 | q | 80 | n |", "| q4 | q | 80 | n |"];
		const text = ["| ID | Question | Score | Notes |", "| --- | --- | ---: | --- |", ...rows].join("\n");
		expect(() => parseScoreTable(text)).toThrow("outside range");
	});

	it("rejects table with more than 8 rows", () => {
		const rows = Array.from({ length: 9 }, (_, i) => `| q${i + 1} | q | 80 | n |`);
		const text = ["| ID | Question | Score | Notes |", "| --- | --- | ---: | --- |", ...rows].join("\n");
		expect(() => parseScoreTable(text)).toThrow("outside range");
	});

	it("rejects duplicate IDs", () => {
		const text = [
			"| ID | Question | Score | Notes |",
			"| --- | --- | ---: | --- |",
			"| q1 | q | 80 | n |",
			"| q2 | q | 80 | n |",
			"| q3 | q | 80 | n |",
			"| q1 | dup | 80 | n |",
			"| q5 | q | 80 | n |",
		].join("\n");
		expect(() => parseScoreTable(text)).toThrow(/duplicate.*q1/i);
	});

	it("rejects scores outside 0–100", () => {
		const text = [
			"| ID | Question | Score | Notes |",
			"| --- | --- | ---: | --- |",
			"| q1 | q | 101 | n |",
			"| q2 | q | 80 | n |",
			"| q3 | q | 80 | n |",
			"| q4 | q | 80 | n |",
			"| q5 | q | 80 | n |",
		].join("\n");
		expect(() => parseScoreTable(text)).toThrow(/score.*q1/i);
	});

	it("rejects negative scores", () => {
		const text = [
			"| ID | Question | Score | Notes |",
			"| --- | --- | ---: | --- |",
			"| q1 | q | -1 | n |",
			"| q2 | q | 80 | n |",
			"| q3 | q | 80 | n |",
			"| q4 | q | 80 | n |",
			"| q5 | q | 80 | n |",
		].join("\n");
		expect(() => parseScoreTable(text)).toThrow(/score.*q1/i);
	});

	it("rejects non-integer scores (floats)", () => {
		const text = [
			"| ID | Question | Score | Notes |",
			"| --- | --- | ---: | --- |",
			"| q1 | q | 80.5 | n |",
			"| q2 | q | 80 | n |",
			"| q3 | q | 80 | n |",
			"| q4 | q | 80 | n |",
			"| q5 | q | 80 | n |",
		].join("\n");
		expect(() => parseScoreTable(text)).toThrow(/score.*q1/i);
	});

	it("rejects non-integer scores (strings)", () => {
		const text = [
			"| ID | Question | Score | Notes |",
			"| --- | --- | ---: | --- |",
			"| q1 | q | high | n |",
			"| q2 | q | 80 | n |",
			"| q3 | q | 80 | n |",
			"| q4 | q | 80 | n |",
			"| q5 | q | 80 | n |",
		].join("\n");
		expect(() => parseScoreTable(text)).toThrow(/score.*q1/i);
	});

	it("rejects wrong header columns", () => {
		const text = [
			"| Question | Score | Notes |",
			"| --- | ---: | --- |",
			"| q1 | 80 | n |",
			"| q2 | 80 | n |",
			"| q3 | 80 | n |",
			"| q4 | 80 | n |",
			"| q5 | 80 | n |",
		].join("\n");
		expect(() => parseScoreTable(text)).toThrow(/header/i);
	});

	// F4 edge cases
	it("throws when input has only header and separator (no data rows)", () => {
		const text = "| ID | Question | Score | Notes |\n| --- | --- | ---: | --- |";
		expect(() => parseScoreTable(text)).toThrow("outside range");
	});

	it("accepts boundary score 0", () => {
		const text = [
			"| ID | Question | Score | Notes |",
			"| --- | --- | ---: | --- |",
			"| q1 | q | 0 | n |",
			"| q2 | q | 0 | n |",
			"| q3 | q | 0 | n |",
			"| q4 | q | 0 | n |",
			"| q5 | q | 0 | n |",
		].join("\n");
		const result = parseScoreTable(text);
		expect(result).toEqual<ScoreRow[]>([
			{ id: "q1", score: 0 },
			{ id: "q2", score: 0 },
			{ id: "q3", score: 0 },
			{ id: "q4", score: 0 },
			{ id: "q5", score: 0 },
		]);
	});

	it("accepts boundary score 100", () => {
		const text = [
			"| ID | Question | Score | Notes |",
			"| --- | --- | ---: | --- |",
			"| q1 | q | 100 | n |",
			"| q2 | q | 100 | n |",
			"| q3 | q | 100 | n |",
			"| q4 | q | 100 | n |",
			"| q5 | q | 100 | n |",
		].join("\n");
		const result = parseScoreTable(text);
		expect(result).toEqual<ScoreRow[]>([
			{ id: "q1", score: 100 },
			{ id: "q2", score: 100 },
			{ id: "q3", score: 100 },
			{ id: "q4", score: 100 },
			{ id: "q5", score: 100 },
		]);
	});
});

// ===========================================================================
// parseLedger — URL row counting, URLs outside table ignored, empty = 0
// ===========================================================================

describe("parseLedger", () => {
	it("parses a valid ledger with 3 sources", () => {
		const text = [
			"| URL | Title | Tier | Retrieved | Claims |",
			"| --- | --- | --- | --- | --- |",
			"| https://example.com/a | A | tier1 | 2024-01-01 | 1 |",
			"| https://example.com/b | B | tier1 | 2024-01-01 | 2 |",
			"| https://example.com/c | C | tier2 | 2024-01-02 | 1 |",
		].join("\n");
		const result = parseLedger(text);
		expect(result.length).toBe(3);
		expect(result[0].url).toBe("https://example.com/a");
		expect(result[1].url).toBe("https://example.com/b");
		expect(result[2].url).toBe("https://example.com/c");
	});

	it("rejects ledger with wrong header columns", () => {
		const text = [
			"| URL | Title | Tier |",
			"| --- | --- | --- |",
			"| https://example.com/a | A | tier1 |",
		].join("\n");
		expect(() => parseLedger(text)).toThrow(/header/i);
	});

	it("returns 0 for an empty ledger (header only, no rows)", () => {
		const text = "| URL | Title | Tier | Retrieved | Claims |\n| --- | --- | --- | --- | --- |\n";
		const result = parseLedger(text);
		expect(result.length).toBe(0);
	});

	it("ignores text outside the table (footnotes, etc.)", () => {
		const text = [
			"| URL | Title | Tier | Retrieved | Claims |",
			"| --- | --- | --- | --- | --- |",
			"| https://example.com/a | A | tier1 | 2024-01-01 | 1 |",
			"",
			"## Notes",
			"This is a footnote that should be ignored.",
			"https://example.com/b is NOT in the table",
		].join("\n");
		const result = parseLedger(text);
		expect(result.length).toBe(1);
		expect(result[0].url).toBe("https://example.com/a");
	});

	it("parses ledger with 10 sources", () => {
		const rows = Array.from({ length: 10 }, (_, i) =>
			`| https://example.com/${i} | Title ${i} | tier1 | 2024-01-01 | 1 |`,
		);
		const text = ["| URL | Title | Tier | Retrieved | Claims |", "| --- | --- | --- | --- | --- |", ...rows].join("\n");
		const result = parseLedger(text);
		expect(result.length).toBe(10);
	});
});

// ===========================================================================
// canonicalizeUrl — exact canonicalization vectors
// ===========================================================================

describe("canonicalizeUrl", () => {
	it("lowercases scheme and host", () => {
		expect(canonicalizeUrl("HTTPS://Example.COM/path")).toBe("https://example.com/path");
	});

	it("drops default ports (80 for http, 443 for https)", () => {
		expect(canonicalizeUrl("http://example.com:80/path")).toBe("http://example.com/path");
		expect(canonicalizeUrl("https://example.com:443/path")).toBe("https://example.com/path");
	});

	it("keeps non-default ports", () => {
		expect(canonicalizeUrl("http://example.com:8080/path")).toBe("http://example.com:8080/path");
		expect(canonicalizeUrl("https://example.com:8443/path")).toBe("https://example.com:8443/path");
	});

	it("drops fragments", () => {
		expect(canonicalizeUrl("https://example.com/page#section")).toBe("https://example.com/page");
	});

	it("drops all tracked UTM / ad params (utm_source, utm_medium, fbclid, gclid, dclid, msclkid)", () => {
		expect(canonicalizeUrl("https://example.com/page?utm_source=newsletter&utm_medium=email")).toBe(
			"https://example.com/page",
		);
		expect(canonicalizeUrl("https://example.com/page?fbclid=abc123")).toBe("https://example.com/page");
		expect(canonicalizeUrl("https://example.com/page?gclid=xyz&dclid=uvw")).toBe("https://example.com/page");
		expect(canonicalizeUrl("https://example.com/page?msclkid=abc")).toBe("https://example.com/page");
		expect(canonicalizeUrl("https://example.com/page?utm_source=x&fbclid=y")).toBe("https://example.com/page");
	});

	it("keeps and sorts remaining query params", () => {
		expect(canonicalizeUrl("https://example.com/page?z=1&a=2")).toBe("https://example.com/page?a=2&z=1");
		expect(canonicalizeUrl("https://example.com/page?b=2&a=1&utm_source=x")).toBe("https://example.com/page?a=1&b=2");
	});

	it("handles URL with only fragment", () => {
		expect(canonicalizeUrl("https://example.com/page#frag")).toBe("https://example.com/page");
	});

	it("handles empty query string", () => {
		expect(canonicalizeUrl("https://example.com/page?")).toBe("https://example.com/page");
	});

	it("drops multiple trailing slashes to single slash", () => {
		expect(canonicalizeUrl("https://example.com//path")).toBe("https://example.com/path");
	});

	it("preserves query-only URLs (no path → /)", () => {
		expect(canonicalizeUrl("https://example.com?foo=bar")).toBe("https://example.com/?foo=bar");
	});

	it("handles https with non-default port and params", () => {
		expect(canonicalizeUrl("https://example.com:8443/page?b=2&a=1&c=3")).toBe(
			"https://example.com:8443/page?a=1&b=2&c=3",
		);
	});
});

// ===========================================================================
// evaluateCheckpoint — idempotence, fail-closed, verdicts, digest
// ===========================================================================

describe("evaluateCheckpoint", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	// ── Run identity verification (F1) ───────────────────────────────────

	it("throws on runId mismatch between manifest and state", async () => {
		const ws = buildWs(tmpDir, "run-identity", "ri");
		// Write a state with one runId, then a manifest with a different one
		const init = newRunState(ws);
		init.runId = "run-actual-123";
		init.researchRound = 5;
		fs.writeFileSync(
			path.join(ws.path, ".research", "run-state.json"),
			JSON.stringify(init, null, 2),
			"utf-8",
		);
		// Overwrite manifest to have a different runId
		const manifest = {
			runId: "run-different-456",
			mission: ws.mission,
			workspace: ws.path,
			manifestPath: path.join(ws.path, ".research", "run.json"),
			createdAt: Date.now(),
			snapshotSha256: null,
		};
		fs.writeFileSync(
			path.join(ws.path, ".research", "run.json"),
			JSON.stringify(manifest, null, 2),
			"utf-8",
		);

		writeScoreTable(ws, [
			{ id: "q1", score: 90 },
			{ id: "q2", score: 90 },
			{ id: "q3", score: 90 },
			{ id: "q4", score: 90 },
			{ id: "q5", score: 90 },
		]);
		writeLedger(ws, [{ url: "https://example.com/a", title: "A" }]);

		await expect(evaluateCheckpoint(ws, 1, init.revision)).rejects.toThrow(/Run-identity.*mismatch/);
	});

	it("throws on workspace mismatch between manifest and state", async () => {
		const ws = buildWs(tmpDir, "ws-identity", "wi");
		const init = newRunState(ws);
		init.researchRound = 5;
		fs.writeFileSync(
			path.join(ws.path, ".research", "run-state.json"),
			JSON.stringify(init, null, 2),
			"utf-8",
		);
		// Overwrite manifest with a different workspace path
		const manifest = {
			runId: ws.runId,
			mission: ws.mission,
			workspace: "/wrong/path/workspace",
			manifestPath: path.join(ws.path, ".research", "run.json"),
			createdAt: Date.now(),
			snapshotSha256: null,
		};
		fs.writeFileSync(
			path.join(ws.path, ".research", "run.json"),
			JSON.stringify(manifest, null, 2),
			"utf-8",
		);

		writeScoreTable(ws, [
			{ id: "q1", score: 90 },
			{ id: "q2", score: 90 },
			{ id: "q3", score: 90 },
			{ id: "q4", score: 90 },
			{ id: "q5", score: 90 },
		]);
		writeLedger(ws, [{ url: "https://example.com/a", title: "A" }]);

		await expect(evaluateCheckpoint(ws, 1, init.revision)).rejects.toThrow(/Run-identity.*mismatch/);
	});

	it("passes run identity when manifest matches state", async () => {
		const ws = buildWs(tmpDir, "run-match", "rm");
		initWorkspace(ws, "standard");
		writeScoreTable(ws, [
			{ id: "q1", score: 90 },
			{ id: "q2", score: 90 },
			{ id: "q3", score: 90 },
			{ id: "q4", score: 90 },
			{ id: "q5", score: 90 },
		]);
		writeLedger(ws, [{ url: "https://example.com/a", title: "A" }]);

		const result = await evaluateCheckpoint(ws, 1, 1);
		// Standard profile: minRounds=5, not met yet → CONTINUE (identity check passed)
		expect(result.verdict).toBe("CONTINUE");
		expect(result.round).toBe(1);
	});

	it("tolerates missing run.json (no manifest yet)", async () => {
		const ws = buildWs(tmpDir, "no-manifest", "nm2");
		const init = newRunState(ws);
		init.researchRound = 5;
		init.checkpointProfile = "open-ended";
		fs.writeFileSync(
			path.join(ws.path, ".research", "run-state.json"),
			JSON.stringify(init, null, 2),
			"utf-8",
		);
		// No run.json written

		writeScoreTable(ws, [
			{ id: "q1", score: 90 },
			{ id: "q2", score: 90 },
			{ id: "q3", score: 90 },
			{ id: "q4", score: 90 },
			{ id: "q5", score: 90 },
		]);
		writeLedger(ws, [{ url: "https://example.com/a", title: "A" }]);

		// Should NOT throw — missing manifest is tolerated (pre-manifest runs)
		const result = await evaluateCheckpoint(ws, 1, init.revision);
		expect(result.verdict).toBe("CONTINUE");
		expect(result.round).toBe(6);
	});

	// -----------------------------------------------------------------------
	// Idempotence: one-increment-per-iteration
	// -----------------------------------------------------------------------

	it("increments researchRound only on first call per iteration", async () => {
		const ws = buildWs(tmpDir, "idemp", "idemp");
		initWorkspace(ws, "standard");

		writeScoreTable(ws, [
			{ id: "q1", score: 90 },
			{ id: "q2", score: 90 },
			{ id: "q3", score: 90 },
			{ id: "q4", score: 90 },
			{ id: "q5", score: 90 },
		]);
		writeLedger(ws, [
			{ url: "https://example.com/a", title: "A" },
			{ url: "https://example.com/b", title: "B" },
		]);

		// First call: should succeed and increment round
		const result1 = await evaluateCheckpoint(ws, 1, 1);
		expect(result1.round).toBe(1);

		// Second call in same iteration: should return same round
		const result2 = await evaluateCheckpoint(ws, 1, 2); // stale revision but same iteration
		expect(result2.round).toBe(1); // round still 1
	});

	// -----------------------------------------------------------------------
	// Fail-closed: missing/malformed evidence
	// -----------------------------------------------------------------------

	it("fails closed when score.md is missing", async () => {
		const ws = buildWs(tmpDir, "no-score", "ns");
		initWorkspace(ws, "standard");
		writeLedger(ws, [{ url: "https://example.com/a", title: "A" }]);

		const result = await evaluateCheckpoint(ws, 1, 1);
		expect(result.verdict).toBe("CONTINUE");
		expect(result.round).toBe(0); // no increment
		expect(result.unmet.length).toBeGreaterThan(0);
	});

	it("fails closed when run-state is missing", async () => {
		const ws = buildWs(tmpDir, "no-run-state", "nr");
		// Note: no initWorkspace — no run-state.json exists.

		const result = await evaluateCheckpoint(ws, 1, 1);
		expect(result.verdict).toBe("CONTINUE");
		expect(result.round).toBe(0); // no increment
		expect(result.unmet).toContain("run-state not found");
		expect(result.state).toBeUndefined();
	});

	it("fails closed when score.md is malformed", async () => {
		const ws = buildWs(tmpDir, "malformed-score", "ms");
		initWorkspace(ws, "standard");
		fs.writeFileSync(path.join(ws.path, "score.md"), "this is not a table\n");
		writeLedger(ws, [{ url: "https://example.com/a", title: "A" }]);

		const result = await evaluateCheckpoint(ws, 1, 1);
		expect(result.verdict).toBe("CONTINUE");
		expect(result.round).toBe(0);
	});

	it("fails closed when notes.md is missing", async () => {
		const ws = buildWs(tmpDir, "no-notes", "nn");
		initWorkspace(ws, "standard");
		writeScoreTable(ws, [
			{ id: "q1", score: 90 },
			{ id: "q2", score: 90 },
			{ id: "q3", score: 90 },
			{ id: "q4", score: 90 },
			{ id: "q5", score: 90 },
		]);

		const result = await evaluateCheckpoint(ws, 1, 1);
		expect(result.verdict).toBe("CONTINUE");
		expect(result.round).toBe(0);
	});

	it("fails closed when notes.md has no ledger table", async () => {
		const ws = buildWs(tmpDir, "no-ledger", "nl");
		initWorkspace(ws, "standard");
		writeScoreTable(ws, [
			{ id: "q1", score: 90 },
			{ id: "q2", score: 90 },
			{ id: "q3", score: 90 },
			{ id: "q4", score: 90 },
			{ id: "q5", score: 90 },
		]);
		fs.writeFileSync(path.join(ws.path, "notes.md"), "just some text\nno table here\n");

		const result = await evaluateCheckpoint(ws, 1, 1);
		expect(result.verdict).toBe("CONTINUE");
		expect(result.round).toBe(0);
	});

	it("fails closed when score table has duplicate IDs", async () => {
		const ws = buildWs(tmpDir, "dup-ids", "di");
		initWorkspace(ws, "standard");
		const text = [
			"| ID | Question | Score | Notes |",
			"| --- | --- | ---: | --- |",
			"| q1 | q | 80 | n |",
			"| q2 | q | 80 | n |",
			"| q3 | q | 80 | n |",
			"| q1 | dup | 80 | n |",
			"| q5 | q | 80 | n |",
		].join("\n");
		fs.writeFileSync(path.join(ws.path, "score.md"), text);
		writeLedger(ws, [{ url: "https://example.com/a", title: "A" }]);

		const result = await evaluateCheckpoint(ws, 1, 1);
		expect(result.verdict).toBe("CONTINUE");
		expect(result.round).toBe(0);
	});

	// -----------------------------------------------------------------------
	// Verdict combinations — use pre-set researchRound to isolate single criteria
	// -----------------------------------------------------------------------

	it("returns CONTINUE when minRounds not met (round=0, minRounds=3, quick profile)", async () => {
		const ws = buildWs(tmpDir, "continue-min-rounds", "cmr");
		initWorkspace(ws, "quick"); // minRounds=3
		writeScoreTable(ws, [
			{ id: "q1", score: 90 },
			{ id: "q2", score: 90 },
			{ id: "q3", score: 90 },
			{ id: "q4", score: 90 },
			{ id: "q5", score: 90 },
		]);
		writeLedger(ws, [
			{ url: "https://example.com/a", title: "A" },
			{ url: "https://example.com/b", title: "B" },
		]);

		const result = await evaluateCheckpoint(ws, 1, 1);
		expect(result.verdict).toBe("CONTINUE");
		expect(result.round).toBe(1);
		expect(result.unmet.some(u => u.includes("min rounds"))).toBe(true);
	});

	it("returns CONTINUE when minSources not met (round≥5, sources<30, standard profile)", async () => {
		const ws = buildWs(tmpDir, "continue-min-sources", "cms");
		// Standard profile: minRounds=5, maxRounds=5, minSources=30, scoreThreshold=80
		// Set researchRound=4: passes minRounds (4>=5? NO, so both fail → CONTINUE since round<max)
		// researchRound=4 means: rounds unmet AND sources unmet → CONTINUE (not at max yet)
		const init = newRunState(ws);
		init.researchRound = 4;
		init.checkpointProfile = "standard";
		fs.writeFileSync(
			path.join(ws.path, ".research", "run-state.json"),
			JSON.stringify(init, null, 2),
			"utf-8",
		);
		createRunManifest(ws);

		writeScoreTable(ws, [
			{ id: "q1", score: 90 },
			{ id: "q2", score: 90 },
			{ id: "q3", score: 90 },
			{ id: "q4", score: 90 },
			{ id: "q5", score: 90 },
		]);
		writeLedger(ws, [
			{ url: "https://example.com/a", title: "A" },
			{ url: "https://example.com/b", title: "B" },
		]);

		const result = await evaluateCheckpoint(ws, 1, 1);
		expect(result.verdict).toBe("CONTINUE");
		expect(result.round).toBe(5);
		expect(result.unmet.some(u => u.includes("min sources"))).toBe(true);
	});

	it("returns CONTINUE when score below threshold (round<max, sources≥30, score<80)", async () => {
		const ws = buildWs(tmpDir, "continue-below-score", "cbs");
		// Standard profile: minRounds=5, maxRounds=5, minSources=30, scoreThreshold=80
		// Set researchRound=4: round not at max → CONTINUE even with multiple unmet
		const init = newRunState(ws);
		init.researchRound = 4;
		init.checkpointProfile = "standard";
		fs.writeFileSync(
			path.join(ws.path, ".research", "run-state.json"),
			JSON.stringify(init, null, 2),
			"utf-8",
		);
		createRunManifest(ws);

		writeScoreTable(ws, [
			{ id: "q1", score: 90 },
			{ id: "q2", score: 90 },
			{ id: "q3", score: 70 },
			{ id: "q4", score: 90 },
			{ id: "q5", score: 90 },
		]);
		// 35 sources (above minSources=30)
		const ledgerRows = Array.from({ length: 35 }, (_, i) => ({
			url: `https://example.com/${i}`,
			title: `Source ${i}`,
		}));
		writeLedger(ws, ledgerRows);

		const result = await evaluateCheckpoint(ws, 1, 1);
		expect(result.verdict).toBe("CONTINUE");
		expect(result.round).toBe(5);
		expect(result.unmet.some(u => u.includes("score threshold"))).toBe(true);
	});

	// F5: isolated score-below-threshold — ONLY score unmet (not confounded by round state)
	it("returns CONTINUE with ONLY score threshold unmet (round≥min, sources≥floor, score<80)", async () => {
		const ws = buildWs(tmpDir, "only-score-unmet", "osu");
		// open-ended profile: minRounds=5, maxRounds=null, minSources=30
		// researchRound=5 meets minRounds; sources=35 meets minSources;
		// one score below 80 → only score threshold unmet → CONTINUE (max=null)
		const init = newRunState(ws);
		init.researchRound = 5;
		init.checkpointProfile = "open-ended";
		fs.writeFileSync(
			path.join(ws.path, ".research", "run-state.json"),
			JSON.stringify(init, null, 2),
			"utf-8",
		);
		createRunManifest(ws);

		writeScoreTable(ws, [
			{ id: "q1", score: 90 },
			{ id: "q2", score: 90 },
			{ id: "q3", score: 70 },
			{ id: "q4", score: 90 },
			{ id: "q5", score: 90 },
		]);
		writeLedger(ws, Array.from({ length: 35 }, (_, i) => ({
			url: `https://example.com/${i}`,
			title: `Source ${i}`,
		})));

		const result = await evaluateCheckpoint(ws, 1, 1);
		expect(result.verdict).toBe("CONTINUE");
		expect(result.round).toBe(6);
		expect(result.unmet).toEqual(["score threshold: q3 below 80"]);
		expect(result.unmet.length).toBe(1); // ONLY score unmet
	});

	it("returns PROCEED when all criteria met (round≥5, sources≥30, scores≥80, standard)", async () => {
		const ws = buildWs(tmpDir, "proceed", "pr");
		// Standard profile: minRounds=5, maxRounds=5, minSources=30, scoreThreshold=80
		const init = newRunState(ws);
		init.researchRound = 5;
		fs.writeFileSync(
			path.join(ws.path, ".research", "run-state.json"),
			JSON.stringify(init, null, 2),
			"utf-8",
		);
		createRunManifest(ws);

		writeScoreTable(ws, [
			{ id: "q1", score: 90 },
			{ id: "q2", score: 90 },
			{ id: "q3", score: 90 },
			{ id: "q4", score: 90 },
			{ id: "q5", score: 90 },
		]);
		// 35 sources (above minSources=30)
		const ledgerRows = Array.from({ length: 35 }, (_, i) => ({
			url: `https://example.com/${i}`,
			title: `Source ${i}`,
		}));
		writeLedger(ws, ledgerRows);

		const result = await evaluateCheckpoint(ws, 1, 1);
		expect(result.verdict).toBe("PROCEED");
		expect(result.round).toBe(6);
		expect(result.unmet).toEqual([]);
	});

	it("returns PROCEED_WITH_GAPS when maxRounds finite and floors unmet", async () => {
		const ws = buildWs(tmpDir, "gaps-finite-max", "gfm");
		// Quick profile: minRounds=3, maxRounds=3, minSources=15
		// researchRound=3 means maxRounds reached → PROCEED_WITH_GAPS if floors unmet
		const init = newRunState(ws);
		init.researchRound = 3;
		init.checkpointProfile = "quick";
		fs.writeFileSync(
			path.join(ws.path, ".research", "run-state.json"),
			JSON.stringify(init, null, 2),
			"utf-8",
		);
		createRunManifest(ws);

		writeScoreTable(ws, [
			{ id: "q1", score: 90 },
			{ id: "q2", score: 90 },
			{ id: "q3", score: 90 },
			{ id: "q4", score: 90 },
			{ id: "q5", score: 90 },
		]);
		// Only 5 sources, need 15
		writeLedger(ws, [
			{ url: "https://example.com/a", title: "A" },
			{ url: "https://example.com/b", title: "B" },
			{ url: "https://example.com/c", title: "C" },
			{ url: "https://example.com/d", title: "D" },
			{ url: "https://example.com/e", title: "E" },
		]);

		const result = await evaluateCheckpoint(ws, 1, 1);
		expect(result.verdict).toBe("PROCEED_WITH_GAPS");
		expect(result.round).toBe(4);
		expect(result.unmet.some(u => u.includes("min sources"))).toBe(true);
	});

	it("returns CONTINUE when maxRounds is null (open-ended) even with unmet floors", async () => {
		const ws = buildWs(tmpDir, "null-max-rounds", "nmr");
		// Open-ended profile: minRounds=5, maxRounds=null, minSources=30
		const init = newRunState(ws);
		init.researchRound = 5; // meet minRounds
		init.checkpointProfile = "open-ended";
		fs.writeFileSync(
			path.join(ws.path, ".research", "run-state.json"),
			JSON.stringify(init, null, 2),
			"utf-8",
		);
		createRunManifest(ws);

		writeScoreTable(ws, [
			{ id: "q1", score: 90 },
			{ id: "q2", score: 90 },
			{ id: "q3", score: 90 },
			{ id: "q4", score: 90 },
			{ id: "q5", score: 90 },
		]);
		writeLedger(ws, [
			{ url: "https://example.com/a", title: "A" },
		]);

		const result = await evaluateCheckpoint(ws, 1, 1);
		expect(result.verdict).toBe("CONTINUE");
		expect(result.round).toBe(6);
		expect(result.unmet.some(u => u.includes("min sources"))).toBe(true);
	});

	// -----------------------------------------------------------------------
	// Digest stability
	// -----------------------------------------------------------------------

	it("evidenceDigest is stable for same input", async () => {
		const ws = buildWs(tmpDir, "digest-stability", "ds");
		const init = newRunState(ws);
		init.researchRound = 5;
		fs.writeFileSync(
			path.join(ws.path, ".research", "run-state.json"),
			JSON.stringify(init, null, 2),
			"utf-8",
		);
		createRunManifest(ws);
		writeScoreTable(ws, [
			{ id: "q1", score: 90 },
			{ id: "q2", score: 90 },
			{ id: "q3", score: 90 },
			{ id: "q4", score: 90 },
			{ id: "q5", score: 90 },
		]);
		writeLedger(ws, [
			{ url: "https://example.com/a", title: "A" },
			{ url: "https://example.com/b", title: "B" },
		]);

		const result1 = await evaluateCheckpoint(ws, 1, 1);
		expect(result1.evidenceDigest).toBeTruthy();
		expect(result1.evidenceDigest!.length).toBe(64); // SHA-256 hex

		// Re-read the state to get fresh revision
		const freshState = readRunState(ws);
		const result2 = await evaluateCheckpoint(ws, 1, freshState.revision);
		expect(result2.evidenceDigest).toBe(result1.evidenceDigest);
	});

	it("evidenceDigest differs when evidence changes", async () => {
		const ws1 = buildWs(tmpDir, "digest-diff-1", "dd1");
		const init1 = newRunState(ws1);
		init1.researchRound = 5;
		fs.writeFileSync(
			path.join(ws1.path, ".research", "run-state.json"),
			JSON.stringify(init1, null, 2),
			"utf-8",
		);
		createRunManifest(ws1);
		writeScoreTable(ws1, [
			{ id: "q1", score: 90 },
			{ id: "q2", score: 90 },
			{ id: "q3", score: 90 },
			{ id: "q4", score: 90 },
			{ id: "q5", score: 90 },
		]);
		writeLedger(ws1, [{ url: "https://example.com/a", title: "A" }]);

		const ws2 = buildWs(tmpDir, "digest-diff-2", "dd2");
		const init2 = newRunState(ws2);
		init2.researchRound = 5;
		fs.writeFileSync(
			path.join(ws2.path, ".research", "run-state.json"),
			JSON.stringify(init2, null, 2),
			"utf-8",
		);
		createRunManifest(ws2);
		writeScoreTable(ws2, [
			{ id: "q1", score: 90 },
			{ id: "q2", score: 90 },
			{ id: "q3", score: 90 },
			{ id: "q4", score: 90 },
			{ id: "q5", score: 90 },
		]);
		writeLedger(ws2, [{ url: "https://example.com/b", title: "B" }]);

		const result1 = await evaluateCheckpoint(ws1, 1, 1);
		const result2 = await evaluateCheckpoint(ws2, 1, 1);
		expect(result1.evidenceDigest).not.toBe(result2.evidenceDigest);
	});

	// -----------------------------------------------------------------------
	// State persistence
	// -----------------------------------------------------------------------

	it("persists verdict and unmet criteria to run-state", async () => {
		const ws = buildWs(tmpDir, "persist-state", "ps");
		const init = newRunState(ws);
		init.researchRound = 5;
		init.checkpointProfile = "standard";
		fs.writeFileSync(
			path.join(ws.path, ".research", "run-state.json"),
			JSON.stringify(init, null, 2),
			"utf-8",
		);
		createRunManifest(ws);
		writeScoreTable(ws, [
			{ id: "q1", score: 90 },
			{ id: "q2", score: 90 },
			{ id: "q3", score: 90 },
			{ id: "q4", score: 90 },
			{ id: "q5", score: 90 },
		]);
		writeLedger(ws, [
			{ url: "https://example.com/a", title: "A" },
		]);

		const result = await evaluateCheckpoint(ws, 1, 1);
		const persisted = readRunState(ws);
		expect(persisted.researchRound).toBe(6);
		expect(persisted.checkpointVerdict).toBe("PROCEED_WITH_GAPS");
		expect(persisted.checkpointUnmet.length).toBeGreaterThan(0);
	});

	it("increments researchRound counter in run-state", async () => {
		const ws = buildWs(tmpDir, "round-counter", "rc");
		initWorkspace(ws, "standard");
		writeScoreTable(ws, [
			{ id: "q1", score: 90 },
			{ id: "q2", score: 90 },
			{ id: "q3", score: 90 },
			{ id: "q4", score: 90 },
			{ id: "q5", score: 90 },
		]);
		writeLedger(ws, [
			{ url: "https://example.com/a", title: "A" },
		]);

		// First checkpoint
		await evaluateCheckpoint(ws, 1, 1);
		expect(readRunState(ws).researchRound).toBe(1);

		// Second call at next loop iteration — should increment to 2
		const freshState = readRunState(ws);
		writeLedger(ws, [
			{ url: "https://example.com/a", title: "A" },
			{ url: "https://example.com/b", title: "B" },
		]);
		await evaluateCheckpoint(ws, 2, freshState.revision);
		expect(readRunState(ws).researchRound).toBe(2);
	});
});

// ===========================================================================
// Research rounds are separate from loop iterations
// ===========================================================================

describe("research rounds vs loop iterations", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("loop iteration 1 and 2 each get their own research round", async () => {
		const ws = buildWs(tmpDir, "rounds-separate-iterations", "ws-rounds");
		initWorkspace(ws, "standard");
		writeScoreTable(ws, [
			{ id: "q1", score: 90 },
			{ id: "q2", score: 90 },
			{ id: "q3", score: 90 },
			{ id: "q4", score: 90 },
			{ id: "q5", score: 90 },
		]);
		writeLedger(ws, [
			{ url: "https://example.com/a", title: "A" },
		]);

		const r1 = await evaluateCheckpoint(ws, 1, 1);
		expect(r1.round).toBe(1);
		expect(readRunState(ws).researchRound).toBe(1);

		const freshState = readRunState(ws);
		const r2 = await evaluateCheckpoint(ws, 2, freshState.revision);
		expect(r2.round).toBe(2);
		expect(readRunState(ws).researchRound).toBe(2);
	});
});

// ===========================================================================
// Ledger deduplication via canonicalized URLs
// ===========================================================================

describe("ledger deduplication", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("counts unique canonicalized URLs only", async () => {
		const ws = buildWs(tmpDir, "dedup", "dedup");
		// quick profile: minRounds=3, maxRounds=3, minSources=15
		const init = newRunState(ws);
		init.researchRound = 3; // at maxRounds
		init.checkpointProfile = "quick";
		fs.writeFileSync(
			path.join(ws.path, ".research", "run-state.json"),
			JSON.stringify(init, null, 2),
			"utf-8",
		);
		createRunManifest(ws);
		writeScoreTable(ws, [
			{ id: "q1", score: 90 },
			{ id: "q2", score: 90 },
			{ id: "q3", score: 90 },
			{ id: "q4", score: 90 },
			{ id: "q5", score: 90 },
		]);
		// Same URL with different params/fragments — canonicalizes to one
		writeLedger(ws, [
			{ url: "https://example.com/page?utm_source=foo", title: "A" },
			{ url: "https://example.com/page?utm_source=bar", title: "B" },
			{ url: "https://example.com/page", title: "C" },
		]);

		const result = await evaluateCheckpoint(ws, 1, 1);
		expect(result.round).toBe(4);
		expect(result.verdict).toBe("PROCEED_WITH_GAPS");
		// uniqueCount should be 1, not 3
		expect(result.state.checkpointUniqueSources).toBe(1);
	});
});
