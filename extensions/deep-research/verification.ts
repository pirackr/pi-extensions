import * as fs from "node:fs";

// Pure parser for the score.md table contract.
// Throws descriptive errors on any malformation so the checkpoint can turn
// them into repair instructions.
export interface ScoreTableRow {
	id: string;
	score: number;
}

export function parseScoreTable(text: string): {
	ids: string[];
	scores: number[];
	rows: ScoreTableRow[];
} {
	const lines = text
		.split("\n")
		.map((l) => l.trimEnd())
		.filter((l) => l.length > 0);

	if (lines.length < 3) {
		throw new Error(
			"score.md must be a markdown table with at least a header, separator, and one data row — got only " +
				lines.length +
				" non-empty lines",
		);
	}

	// Header: '| ID | Question | Score | Notes |'
	const headerLine = lines[0].replace(/^\|/, "").replace(/\|$/, "").trim();
	const expectedHeader = "ID | Question | Score | Notes";
	if (headerLine !== expectedHeader) {
		throw new Error(
			`score.md header mismatch: expected '| ID | Question | Score | Notes |' but got '| ${headerLine} |'`,
		);
	}

	// Separator line (must have at least 4 columns with dashes)
	const sepLine = lines[1];
	const sepParts = sepLine
		.replace(/^\|/, "")
		.replace(/\|$/, "")
		.split("|")
		.map((s) => s.trim());
	if (sepParts.length < 4 || sepParts.some((p) => !/^\-+:?\s*$/.test(p))) {
		throw new Error(
			"score.md separator row must have at least 4 columns of dashes — got: " +
				sepLine,
		);
	}

	// Data rows
	const dataLines = lines.slice(2);
	const rows: ScoreTableRow[] = [];
	const seenIds = new Set<string>();

	for (const line of dataLines) {
		// Strip leading/trailing pipe characters
		const cells = line
			.replace(/^\|/, "")
			.replace(/\|$/, "")
			.split("|")
			.map((s) => s.trim());

		if (cells.length < 4) {
			throw new Error(
				`score.md data row must have at least 4 columns — got: ${line}`,
			);
		}

		const id = cells[0];
		const scoreStr = cells[2];

		if (!id || id.trim() === "") {
			throw new Error(
				"score.md data row has an empty ID — all rows must have a non-empty ID",
			);
		}

		if (seenIds.has(id)) {
			throw new Error(
				`score.md contains a duplicate ID '${id}' — all IDs must be unique`,
			);
		}
		seenIds.add(id);

		const score = Number(scoreStr);
		if (!Number.isInteger(score)) {
			throw new Error(
				`score.md row for ID '${id}' has a non-integer score '${scoreStr}' — scores must be integers`,
			);
		}
		if (score < 0 || score > 100) {
			throw new Error(
				`score.md row for ID '${id}' has score ${score} — scores must be between 0 and 100`,
			);
		}

		rows.push({ id, score });
	}

	if (rows.length < 5) {
		throw new Error(
			`score.md must contain between 5 and 8 sub-question rows — got ${rows.length}`,
		);
	}
	if (rows.length > 8) {
		throw new Error(
			`score.md must contain between 5 and 8 sub-question rows — got ${rows.length}`,
		);
	}

	return {
		ids: rows.map((r) => r.id),
		scores: rows.map((r) => r.score),
		rows,
	};
}

// --- Verification artifact schemas and strict validators -------------------
//
// Each artifact is a versioned JSON object written by a verification agent into
// the run's verification/ directory. complete_loop reads and validates them
// before allowing a /research run to be marked complete. Malformed or failing
// artifacts are treated as hard failures — no heuristic interpretation.
//
// Profile → file mapping (from config/deep-research.json verification arrays):
//   judge               → judge.json
//   citation_agent      → citations.json
//   source_auditor      → sources.json
//   contradiction_resolver → contradictions.json

export interface JudgeArtifact {
	version: 1;
	runId: string;
	pass: boolean;
	verdict: "PASS" | "FAIL" | "CONDITIONAL_PASS";
	failedChecks: string[];
	fixes: string[];
}

export interface CitationsArtifact {
	version: 1;
	runId: string;
	pass: boolean;
	unsupportedClaims: string[];
	misattributedClaims: string[];
}

export interface SourcesArtifact {
	version: 1;
	runId: string;
	pass: boolean;
	unresolvedReplacements: string[];
}

export interface ContradictionsArtifact {
	version: 1;
	runId: string;
	pass: boolean;
	unhandled: string[];
	acknowledged: Array<{ claim: string; whereInReport: string }>;
}

export type VerificationArtifact =
	| JudgeArtifact
	| CitationsArtifact
	| SourcesArtifact
	| ContradictionsArtifact;

// --- Strict schema checkers -----------------------------------------------

function assertIsObject(v: unknown, label: string): Record<string, unknown> {
	if (v == null || typeof v !== "object" || Array.isArray(v)) {
		throw new Error(`${label} must be a JSON object — got ${v == null ? "null" : typeof v}`);
	}
	return v as Record<string, unknown>;
}

function assertString(v: unknown, path: string): string {
	if (typeof v !== "string") {
		throw new Error(`${path} must be a string — got ${v == null ? "null" : typeof v}`);
	}
	return v;
}

function assertBoolean(v: unknown, path: string): boolean {
	if (typeof v !== "boolean") {
		throw new Error(`${path} must be a boolean — got ${v == null ? "null" : typeof v}`);
	}
	return v;
}

function assertArray(v: unknown, path: string): unknown[] {
	if (!Array.isArray(v)) {
		throw new Error(`${path} must be an array — got ${v == null ? "null" : typeof v}`);
	}
	return v;
}

function assertArrayOfStrings(v: unknown, path: string): string[] {
	const arr = assertArray(v, path);
	for (let i = 0; i < arr.length; i++) {
		if (typeof arr[i] !== "string") {
			throw new Error(`${path}[${i}] must be a string — got ${arr[i] == null ? "null" : typeof arr[i]}`);
		}
	}
	return arr as string[];
}

function assertNonEmptyString(v: unknown, path: string): string {
	const s = assertString(v, path);
	if (s.trim() === "") {
		throw new Error(`${path} must be a non-empty string`);
	}
	return s;
}

function assertUnknownFields(obj: Record<string, unknown>, known: Set<string>, label: string): void {
	for (const key of Object.keys(obj)) {
		if (!known.has(key)) {
			throw new Error(`${label} has unknown field '${key}' — only ${[...known].join(", ")} are allowed`);
		}
	}
}

// --- Verdict-specific pass rules ------------------------------------------

export function validateJudgeArtifact(raw: unknown): JudgeArtifact {
	const obj = assertIsObject(raw, "judge.json");
	assertUnknownFields(obj, new Set(["version", "runId", "pass", "verdict", "failedChecks", "fixes"]), "judge.json");

	const version = obj.version;
	if (version !== 1) throw new Error(`judge.json: version must be 1 — got ${version}`);

	const runId = assertNonEmptyString(obj.runId, "judge.json.runId");
	const pass = assertBoolean(obj.pass, "judge.json.pass");
	const verdict = obj.verdict;
	if (verdict !== "PASS" && verdict !== "FAIL" && verdict !== "CONDITIONAL_PASS") {
		throw new Error(`judge.json.verdict must be 'PASS', 'FAIL', or 'CONDITIONAL_PASS' — got ${verdict == null ? "null" : JSON.stringify(verdict)}`);
	}
	const failedChecks = assertArrayOfStrings(obj.failedChecks, "judge.json.failedChecks");
	const fixes = assertArrayOfStrings(obj.fixes, "judge.json.fixes");

	return { version: 1, runId, pass, verdict: verdict as JudgeArtifact["verdict"], failedChecks, fixes };
}

export function validateCitationsArtifact(raw: unknown): CitationsArtifact {
	const obj = assertIsObject(raw, "citations.json");
	assertUnknownFields(obj, new Set(["version", "runId", "pass", "unsupportedClaims", "misattributedClaims"]), "citations.json");

	const version = obj.version;
	if (version !== 1) throw new Error(`citations.json: version must be 1 — got ${version}`);

	const runId = assertNonEmptyString(obj.runId, "citations.json.runId");
	const pass = assertBoolean(obj.pass, "citations.json.pass");
	const unsupportedClaims = assertArrayOfStrings(obj.unsupportedClaims, "citations.json.unsupportedClaims");
	const misattributedClaims = assertArrayOfStrings(obj.misattributedClaims, "citations.json.misattributedClaims");

	return { version: 1, runId, pass, unsupportedClaims, misattributedClaims };
}

export function validateSourcesArtifact(raw: unknown): SourcesArtifact {
	const obj = assertIsObject(raw, "sources.json");
	assertUnknownFields(obj, new Set(["version", "runId", "pass", "unresolvedReplacements"]), "sources.json");

	const version = obj.version;
	if (version !== 1) throw new Error(`sources.json: version must be 1 — got ${version}`);

	const runId = assertNonEmptyString(obj.runId, "sources.json.runId");
	const pass = assertBoolean(obj.pass, "sources.json.pass");
	const unresolvedReplacements = assertArrayOfStrings(obj.unresolvedReplacements, "sources.json.unresolvedReplacements");

	return { version: 1, runId, pass, unresolvedReplacements };
}

export function validateContradictionsArtifact(raw: unknown): ContradictionsArtifact {
	const obj = assertIsObject(raw, "contradictions.json");
	assertUnknownFields(obj, new Set(["version", "runId", "pass", "unhandled", "acknowledged"]), "contradictions.json");

	const version = obj.version;
	if (version !== 1) throw new Error(`contradictions.json: version must be 1 — got ${version}`);

	const runId = assertNonEmptyString(obj.runId, "contradictions.json.runId");
	const pass = assertBoolean(obj.pass, "contradictions.json.pass");
	const unhandled = assertArrayOfStrings(obj.unhandled, "contradictions.json.unhandled");

	const rawAcknowledged = assertArray(obj.acknowledged, "contradictions.json.acknowledged");
	const acknowledged: Array<{ claim: string; whereInReport: string }> = [];
	for (let i = 0; i < rawAcknowledged.length; i++) {
		const entry = rawAcknowledged[i];
		if (entry == null || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error(`contradictions.json.acknowledged[${i}] must be an object — got ${entry == null ? "null" : typeof entry}`);
		}
		const o = entry as Record<string, unknown>;
		assertUnknownFields(o, new Set(["claim", "whereInReport"]), `contradictions.json.acknowledged[${i}]`);
		const claim = assertNonEmptyString(o.claim, `contradictions.json.acknowledged[${i}].claim`);
		const whereInReport = assertNonEmptyString(o.whereInReport, `contradictions.json.acknowledged[${i}].whereInReport`);
		acknowledged.push({ claim, whereInReport });
	}

	return { version: 1, runId, pass, unhandled, acknowledged };
}

// --- Outcome rules --------------------------------------------------------
// Each validator enforces its own pass condition beyond schema validity.

export function judgePasses(a: JudgeArtifact): boolean {
	return a.pass === true && a.verdict === "PASS";
}

export function citationsPasses(a: CitationsArtifact): boolean {
	return a.pass === true && a.unsupportedClaims.length === 0 && a.misattributedClaims.length === 0;
}

export function sourcesPasses(a: SourcesArtifact): boolean {
	return a.pass === true && a.unresolvedReplacements.length === 0;
}

export function contradictionsPasses(a: ContradictionsArtifact): boolean {
	return a.pass === true && a.unhandled.length === 0;
}

// --- Profile → file name mapping ------------------------------------------

export const VERIFICATION_AGENT_TO_FILE: Record<string, string> = {
	judge: "judge.json",
	citation_agent: "citations.json",
	source_auditor: "sources.json",
	contradiction_resolver: "contradictions.json",
};

export function resolveVerificationFile(agentName: string): string {
	const file = VERIFICATION_AGENT_TO_FILE[agentName];
	if (file === undefined) {
		throw new Error(`Unknown verification agent '${agentName}' — expected one of: ${[...Object.keys(VERIFICATION_AGENT_TO_FILE)].join(", ")}`);
	}
	return file;
}

// --- Generic load-and-validate harness -----------------------------------
// Reads a JSON file from disk, parses it, and runs the strict validator.
// Used by complete_loop to validate all required artifacts for a /research run.

export function loadAndValidateVerificationArtifact(
	path: string,
	validator: (raw: unknown) => VerificationArtifact,
): VerificationArtifact {
	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(path, "utf8"));
	} catch (err) {
		const basename = path.split("/").pop() ?? path;
		throw new Error(`${basename} read/parse failed: ${err instanceof Error ? err.message : String(err)}`);
	}
	return validator(raw);
}
