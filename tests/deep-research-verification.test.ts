import { describe, it, expect } from "vitest";
import {
	parseScoreTable,
	validateJudgeArtifact,
	validateCitationsArtifact,
	validateSourcesArtifact,
	validateContradictionsArtifact,
	judgePasses,
	citationsPasses,
	sourcesPasses,
	contradictionsPasses,
	resolveVerificationFile,
	VERIFICATION_AGENT_TO_FILE,
	loadAndValidateVerificationArtifact,
} from "../extensions/deep-research/verification.ts";

describe("parseScoreTable", () => {
	const validHeader = "| ID | Question | Score | Notes |";
	const validSep = "| --- | --- | ---: | --- |";

	function makeTable(rows: Array<{ id: string; score: number }>): string {
		const body = rows
			.map((r) => `| ${r.id} | some question | ${r.score} | some notes |`)
			.join("\n");
		return `${validHeader}\n${validSep}\n${body}`;
	}

	it("accepts exactly 5 rows", () => {
		const result = parseScoreTable(
			makeTable([
				{ id: "q1", score: 80 },
				{ id: "q2", score: 85 },
				{ id: "q3", score: 90 },
				{ id: "q4", score: 75 },
				{ id: "q5", score: 80 },
			]),
		);
		expect(result.ids).toEqual(["q1", "q2", "q3", "q4", "q5"]);
		expect(result.scores).toEqual([80, 85, 90, 75, 80]);
		expect(result.rows).toHaveLength(5);
	});

	it("accepts 8 rows", () => {
		const rows = Array.from({ length: 8 }, (_, i) => ({
			id: `q${i + 1}`,
			score: 80,
		}));
		const result = parseScoreTable(makeTable(rows));
		expect(result.ids).toHaveLength(8);
		expect(result.rows).toHaveLength(8);
	});

	it("accepts scores 0 and 100", () => {
		const result = parseScoreTable(
			makeTable([
				{ id: "q1", score: 0 },
				{ id: "q2", score: 100 },
				{ id: "q3", score: 50 },
				{ id: "q4", score: 80 },
				{ id: "q5", score: 25 },
			]),
		);
		expect(result.scores).toEqual([0, 100, 50, 80, 25]);
	});

	it("rejects 4 rows (below minimum)", () => {
		expect(() =>
			parseScoreTable(
				makeTable([
					{ id: "q1", score: 80 },
					{ id: "q2", score: 80 },
					{ id: "q3", score: 80 },
					{ id: "q4", score: 80 },
				]),
			),
		).toThrow("between 5 and 8");
	});

	it("rejects 9 rows (above maximum)", () => {
		expect(() =>
			parseScoreTable(
				makeTable(
					Array.from({ length: 9 }, (_, i) => ({ id: `q${i + 1}`, score: 80 })),
				),
			),
		).toThrow("between 5 and 8");
	});

	it("rejects duplicate IDs", () => {
		expect(() =>
			parseScoreTable(
				makeTable([
					{ id: "q1", score: 80 },
					{ id: "q1", score: 90 },
					{ id: "q3", score: 80 },
					{ id: "q4", score: 80 },
					{ id: "q5", score: 80 },
				]),
			),
		).toThrow("duplicate ID");
	});

	it("rejects score -1", () => {
		expect(() =>
			parseScoreTable(
				makeTable([
					{ id: "q1", score: -1 },
					{ id: "q2", score: 80 },
					{ id: "q3", score: 80 },
					{ id: "q4", score: 80 },
					{ id: "q5", score: 80 },
				]),
			),
		).toThrow("between 0 and 100");
	});

	it("rejects score 101", () => {
		expect(() =>
			parseScoreTable(
				makeTable([
					{ id: "q1", score: 101 },
					{ id: "q2", score: 80 },
					{ id: "q3", score: 80 },
					{ id: "q4", score: 80 },
					{ id: "q5", score: 80 },
				]),
			),
		).toThrow("between 0 and 100");
	});

	it("rejects malformed header", () => {
		expect(() =>
			parseScoreTable(
				`| Id | Question | Score | Notes |\n| --- | --- | ---: | --- |\n| q1 | ? | 80 | n |\n| q2 | ? | 80 | n |\n| q3 | ? | 80 | n |\n| q4 | ? | 80 | n |\n| q5 | ? | 80 | n |`,
			),
		).toThrow("header mismatch");
	});

	it("rejects wrong column count in separator", () => {
		expect(() =>
			parseScoreTable(
				"| ID | Question | Score | Notes |\n| --- | --- |\n| q1 | ? | 80 | n |\n| q2 | ? | 80 | n |\n| q3 | ? | 80 | n |\n| q4 | ? | 80 | n |\n| q5 | ? | 80 | n |",
			),
		).toThrow("separator row");
	});

	it("rejects non-integer score", () => {
		expect(() =>
			parseScoreTable(
				`| ID | Question | Score | Notes |\n| --- | --- | ---: | --- |\n| q1 | ? | 80.5 | n |\n| q2 | ? | 80 | n |\n| q3 | ? | 80 | n |\n| q4 | ? | 80 | n |\n| q5 | ? | 80 | n |`,
			),
		).toThrow("non-integer score");
	});

	it("rejects data row with wrong column count", () => {
		expect(() =>
			parseScoreTable(
				`| ID | Question | Score | Notes |\n| --- | --- | ---: | --- |\n| q1 | ? | 80 |\n| q2 | ? | 80 | n |\n| q3 | ? | 80 | n |\n| q4 | ? | 80 | n |\n| q5 | ? | 80 | n |`,
			),
		).toThrow("4 columns");
	});

	it("rejects empty text", () => {
		expect(() => parseScoreTable("")).toThrow("non-empty lines");
	});

	it("rejects too few lines", () => {
		expect(() => parseScoreTable("| ID | Question | Score | Notes |")).toThrow(
			"non-empty lines",
		);
	});
});

// --- Verification artifact schemas and validators --------------------------

describe("resolveVerificationFile", () => {
	it("maps judge to judge.json", () => {
		expect(resolveVerificationFile("judge")).toBe("judge.json");
	});
	it("maps citation_agent to citations.json", () => {
		expect(resolveVerificationFile("citation_agent")).toBe("citations.json");
	});
	it("maps source_auditor to sources.json", () => {
		expect(resolveVerificationFile("source_auditor")).toBe("sources.json");
	});
	it("maps contradiction_resolver to contradictions.json", () => {
		expect(resolveVerificationFile("contradiction_resolver")).toBe("contradictions.json");
	});
	it("throws for unknown agent", () => {
		expect(() => resolveVerificationFile("bogus")).toThrow("Unknown verification agent");
	});
	it("VERIFICATION_AGENT_TO_FILE covers all four agents", () => {
		expect(Object.keys(VERIFICATION_AGENT_TO_FILE)).toEqual([
			"judge",
			"citation_agent",
			"source_auditor",
			"contradiction_resolver",
		]);
	});
});

describe("validateJudgeArtifact", () => {
	const valid = { version: 1, runId: "r1", pass: true, verdict: "PASS", failedChecks: [], fixes: [] };

	it("accepts a fully valid artifact", () => {
		const a = validateJudgeArtifact(valid);
		expect(a).toEqual(valid);
		expect(judgePasses(a)).toBe(true);
	});

	it("accepts CONDITIONAL_PASS with pass=true", () => {
		const a = validateJudgeArtifact({ ...valid, verdict: "CONDITIONAL_PASS" });
		expect(a.verdict).toBe("CONDITIONAL_PASS");
		// CONDITIONAL_PASS does NOT pass the gate even when pass=true
		expect(judgePasses(a)).toBe(false);
	});

	it("rejects FAIL verdict even when pass=true", () => {
		const a = validateJudgeArtifact({ ...valid, verdict: "FAIL" });
		expect(judgePasses(a)).toBe(false);
	});

	it("rejects pass=false even with PASS verdict", () => {
		const a = validateJudgeArtifact({ ...valid, pass: false });
		expect(judgePasses(a)).toBe(false);
	});

	it("rejects bad version", () => {
		expect(() => validateJudgeArtifact({ ...valid, version: 2 })).toThrow("version must be 1");
	});

	it("rejects empty runId", () => {
		expect(() => validateJudgeArtifact({ ...valid, runId: "" })).toThrow("non-empty string");
	});

	it("rejects non-boolean pass", () => {
		expect(() => validateJudgeArtifact({ ...valid, pass: "yes" as never })).toThrow("must be a boolean");
	});

	it("rejects unknown top-level field", () => {
		expect(() => validateJudgeArtifact({ ...valid, extra: 1 })).toThrow("unknown field 'extra'");
	});

	it("rejects non-array failedChecks", () => {
		expect(() => validateJudgeArtifact({ ...valid, failedChecks: "x" as never })).toThrow("must be an array");
	});

	it("rejects non-string element in failedChecks", () => {
		expect(() => validateJudgeArtifact({ ...valid, failedChecks: [1 as never] })).toThrow("must be a string");
	});

	it("rejects bad verdict", () => {
		expect(() => validateJudgeArtifact({ ...valid, verdict: "MAYBE" as never })).toThrow("'PASS', 'FAIL', or 'CONDITIONAL_PASS'");
	});
});

describe("validateCitationsArtifact", () => {
	const valid = {
		version: 1,
		runId: "r1",
		pass: true,
		unsupportedClaims: [],
		misattributedClaims: [],
	};

	it("accepts a fully valid artifact", () => {
		const a = validateCitationsArtifact(valid);
		expect(citationsPasses(a)).toBe(true);
	});

	it("rejects unsupported claims", () => {
		const a = validateCitationsArtifact({ ...valid, unsupportedClaims: ["c1"] });
		expect(citationsPasses(a)).toBe(false);
	});

	it("rejects misattributed claims", () => {
		const a = validateCitationsArtifact({ ...valid, misattributedClaims: ["c1"] });
		expect(citationsPasses(a)).toBe(false);
	});

	it("rejects pass=false even with empty arrays", () => {
		const a = validateCitationsArtifact({ ...valid, pass: false });
		expect(citationsPasses(a)).toBe(false);
	});

	it("rejects bad version", () => {
		expect(() => validateCitationsArtifact({ ...valid, version: 2 })).toThrow("version must be 1");
	});

	it("rejects empty runId", () => {
		expect(() => validateCitationsArtifact({ ...valid, runId: "" })).toThrow("non-empty string");
	});

	it("rejects unknown top-level field", () => {
		expect(() => validateCitationsArtifact({ ...valid, extra: 1 })).toThrow("unknown field 'extra'");
	});
});

describe("validateSourcesArtifact", () => {
	const valid = { version: 1, runId: "r1", pass: true, unresolvedReplacements: [] };

	it("accepts a fully valid artifact", () => {
		const a = validateSourcesArtifact(valid);
		expect(sourcesPasses(a)).toBe(true);
	});

	it("rejects unresolved replacements", () => {
		const a = validateSourcesArtifact({ ...valid, unresolvedReplacements: ["url1"] });
		expect(sourcesPasses(a)).toBe(false);
	});

	it("rejects pass=false even with empty array", () => {
		const a = validateSourcesArtifact({ ...valid, pass: false });
		expect(sourcesPasses(a)).toBe(false);
	});

	it("rejects bad version", () => {
		expect(() => validateSourcesArtifact({ ...valid, version: 2 })).toThrow("version must be 1");
	});

	it("rejects empty runId", () => {
		expect(() => validateSourcesArtifact({ ...valid, runId: "" })).toThrow("non-empty string");
	});

	it("rejects unknown top-level field", () => {
		expect(() => validateSourcesArtifact({ ...valid, extra: 1 })).toThrow("unknown field 'extra'");
	});
});

describe("validateContradictionsArtifact", () => {
	const valid = {
		version: 1,
		runId: "r1",
		pass: true,
		unhandled: [],
		acknowledged: [],
	};

	it("accepts a fully valid artifact", () => {
		const a = validateContradictionsArtifact(valid);
		expect(contradictionsPasses(a)).toBe(true);
	});

	it("rejects unhandled contradictions", () => {
		const a = validateContradictionsArtifact({ ...valid, unhandled: ["c1"] });
		expect(contradictionsPasses(a)).toBe(false);
	});

	it("accepts acknowledged with non-empty whereInReport", () => {
		const a = validateContradictionsArtifact({
			...valid,
			unhandled: [],
			acknowledged: [{ claim: "c1", whereInReport: "Section 2" }],
		});
		expect(contradictionsPasses(a)).toBe(true);
	});

	it("rejects acknowledged with empty whereInReport", () => {
		expect(() =>
			validateContradictionsArtifact({
				...valid,
				acknowledged: [{ claim: "c1", whereInReport: "" } as never],
			}),
		).toThrow("whereInReport");
	});

	it("rejects acknowledged with empty claim", () => {
		expect(() =>
			validateContradictionsArtifact({
				...valid,
				acknowledged: [{ claim: "", whereInReport: "Section 2" } as never],
			}),
		).toThrow("claim");
	});

	it("rejects pass=false even with empty arrays", () => {
		const a = validateContradictionsArtifact({ ...valid, pass: false });
		expect(contradictionsPasses(a)).toBe(false);
	});

	it("rejects bad version", () => {
		expect(() => validateContradictionsArtifact({ ...valid, version: 2 })).toThrow("version must be 1");
	});

	it("rejects empty runId", () => {
		expect(() => validateContradictionsArtifact({ ...valid, runId: "" })).toThrow("non-empty string");
	});

	it("rejects unknown top-level field", () => {
		expect(() => validateContradictionsArtifact({ ...valid, extra: 1 })).toThrow("unknown field 'extra'");
	});

	it("rejects non-object in acknowledged array", () => {
		expect(() => validateContradictionsArtifact({ ...valid, acknowledged: ["bad" as never] })).toThrow("must be an object");
	});

	it("rejects unknown field in acknowledged entry", () => {
		expect(() =>
			validateContradictionsArtifact({
				...valid,
				acknowledged: [{ claim: "c1", whereInReport: "S2", extra: 1 } as never],
			}),
		).toThrow("unknown field 'extra'");
	});
});

describe("loadAndValidateVerificationArtifact", () => {
	it("parses valid judge JSON from a file path", async () => {
		const fs = await import("node:fs");
		const os = await import("node:os");
		const path = await import("node:path");
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-verify-"));
		try {
			const filePath = path.join(dir, "judge.json");
			fs.writeFileSync(filePath, JSON.stringify({ version: 1, runId: "r1", pass: true, verdict: "PASS", failedChecks: [], fixes: [] }));
			const a = loadAndValidateVerificationArtifact(filePath, validateJudgeArtifact);
			expect(a.runId).toBe("r1");
			expect(judgePasses(a)).toBe(true);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("throws descriptive error for missing file", async () => {
		const fs = await import("node:fs");
		const path = await import("node:path");
		const badPath = path.join("/tmp", "nonexistent-judge-" + Date.now() + ".json");
		expect(() => loadAndValidateVerificationArtifact(badPath, validateJudgeArtifact)).toThrow("read/parse failed");
	});

	it("throws descriptive error for malformed JSON", async () => {
		const fs = await import("node:fs");
		const os = await import("node:os");
		const path = await import("node:path");
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-verify-bad-"));
		try {
			const filePath = path.join(dir, "judge.json");
			fs.writeFileSync(filePath, "not json");
			expect(() => loadAndValidateVerificationArtifact(filePath, validateJudgeArtifact)).toThrow("read/parse failed");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
