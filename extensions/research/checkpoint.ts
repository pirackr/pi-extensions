import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { Workspace } from "./workspace.ts";
import type { RunState, StateConflict, Verdict } from "./state.ts";
import {
	newRunState,
	readRunState,
	updateRunState,
	Verdict,
} from "./state.ts";
import { loadPackagedConfig } from "./config.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** @deprecated Verdict is now defined in state.ts; re-exported for backwards compat. */
export type { Verdict };

export interface ScoreRow {
	id: string;
	score: number;
}

export interface LedgerRow {
	url: string;
	title: string;
}

export interface CheckpointResult {
	state: RunState;
	verdict: Verdict;
	round: number;
	unmet: string[];
	evidenceDigest: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCORE_HEADER = "| ID | Question | Score | Notes |";
const SCORE_SEPARATOR = "| --- | --- | ---: | --- |";
const LEDGER_HEADER = "| URL | Title | Tier | Retrieved | Claims |";
const LEDGER_SEPARATOR = "| --- | --- | --- | --- | --- |";
const MIN_SCORE_ROWS = 5;
const MAX_SCORE_ROWS = 8;

// Params to strip from URLs (non-UTM tracking params only —
// all utm_* params are caught by startsWith("utm_") below)
const STRIPPED_PARAMS = new Set([
	"fbclid",
	"gclid",
	"dclid",
	"msclkid",
]);

// ---------------------------------------------------------------------------
// parseScoreTable
// ---------------------------------------------------------------------------

/**
 * Parse a markdown table from score.md.
 *
 * Expects exact header columns: `ID | Question | Score | Notes`
 * Returns parsed rows with integer scores 0–100 and unique IDs.
 * Row count must be within [MIN_SCORE_ROWS, MAX_SCORE_ROWS].
 */
export function parseScoreTable(text: string): ScoreRow[] {
	const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
	if (lines.length < 2) {
		throw new Error("score.md table must have at least a header and separator row");
	}

	const header = lines[0];
	const sep = lines[1];

	// Validate header columns (split by |, trim, filter empty)
	const headerCols = header.split("|").map((c) => c.trim()).filter(Boolean);
	if (
		headerCols.length !== 4 ||
		headerCols[0] !== "ID" ||
		headerCols[1] !== "Question" ||
		headerCols[2] !== "Score" ||
		headerCols[3] !== "Notes"
	) {
		throw new Error("score.md must have exact header columns: ID | Question | Score | Notes");
	}

	// Validate separator row has at least 4 cells
	const sepCols = sep.split("|").map((c) => c.trim()).filter(Boolean);
	if (sepCols.length < 4) {
		throw new Error("score.md separator row has too few columns");
	}

	// Parse data rows
	const rows: ScoreRow[] = [];
	const seenIds = new Set<string>();

	for (let i = 2; i < lines.length; i++) {
		const cols = lines[i].split("|").map((c) => c.trim()).filter(Boolean);
		if (cols.length < 4) continue; // skip malformed rows

		const id = cols[0];
		const scoreStr = cols[2];

		// Validate ID uniqueness
		if (seenIds.has(id)) {
			throw new Error(`score.md has duplicate ID: ${id}`);
		}
		seenIds.add(id);

		// Validate score is integer 0–100
		if (!/^-?\d+$/.test(scoreStr)) {
			throw new Error(`score.md row '${id}': score '${scoreStr}' is not a valid integer`);
		}
		const score = parseInt(scoreStr, 10);
		if (score < 0 || score > 100) {
			throw new Error(`score.md row '${id}': score ${score} is outside range 0–100`);
		}

		rows.push({ id, score });
	}

	// Validate row count
	if (rows.length < MIN_SCORE_ROWS) {
		throw new Error(`score.md: row count ${rows.length} outside range ${MIN_SCORE_ROWS}–${MAX_SCORE_ROWS}`);
	}
	if (rows.length > MAX_SCORE_ROWS) {
		throw new Error(`score.md: row count ${rows.length} outside range ${MIN_SCORE_ROWS}–${MAX_SCORE_ROWS}`);
	}

	return rows;
}

// ---------------------------------------------------------------------------
// parseLedger
// ---------------------------------------------------------------------------

/**
 * Parse a markdown table from notes.md (Source Ledger section).
 *
 * Expects exact header columns: `URL | Title | Tier | Retrieved | Claims`
 * Only parses rows within the table (ignores footnotes, etc.).
 */
export function parseLedger(text: string): LedgerRow[] {
	const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
	if (lines.length < 2) {
		throw new Error("notes.md ledger must have at least a header and separator row");
	}

	const header = lines[0];
	const sep = lines[1];

	// Validate header
	const headerCols = header.split("|").map((c) => c.trim()).filter(Boolean);
	if (
		headerCols.length !== 5 ||
		headerCols[0] !== "URL" ||
		headerCols[1] !== "Title" ||
		headerCols[2] !== "Tier" ||
		headerCols[3] !== "Retrieved" ||
		headerCols[4] !== "Claims"
	) {
		throw new Error("notes.md ledger must have exact header columns: URL | Title | Tier | Retrieved | Claims");
	}

	// Validate separator
	const sepCols = sep.split("|").map((c) => c.trim()).filter(Boolean);
	if (sepCols.length < 5) {
		throw new Error("notes.md ledger separator row has too few columns");
	}

	// Parse data rows (table ends when we encounter a line that isn't a table row)
	const rows: LedgerRow[] = [];

	for (let i = 2; i < lines.length; i++) {
		const line = lines[i];
		const cols = line.split("|").map((c) => c.trim()).filter(Boolean);
		if (cols.length < 5) break; // table ended or malformed — stop

		const url = cols[0];
		const title = cols[1];

		// Only count valid HTTP(S) URLs
		if (url.startsWith("http://") || url.startsWith("https://")) {
			rows.push({ url, title });
		}
	}

	return rows;
}

// ---------------------------------------------------------------------------
// canonicalizeUrl
// ---------------------------------------------------------------------------

/**
 * Canonicalize a URL per the Global Constraints rules:
 * - Lowercase scheme + host
 * - Drop default ports (80 for http, 443 for https)
 * - Drop fragments
 * - Delete utm_*, fbclid, gclid, dclid, msclkid params
 * - Sort remaining query params alphabetically
 * - Normalize double slashes to single
 *
 * notes.md bytes stay untouched (this is a pure function).
 */
export function canonicalizeUrl(u: string): string {
	let url: URL;
	try {
		url = new URL(u);
	} catch {
		return u; // Not a valid URL, return as-is
	}

	// Lowercase scheme and host
	url.protocol = url.protocol.toLowerCase();
	url.hostname = url.hostname.toLowerCase();

	// Drop default ports
	if ((url.protocol === "http:" && url.port === "80") ||
		(url.protocol === "https:" && url.port === "443")) {
		url.port = "";
	}

	// Drop fragment
	url.hash = "";

	// Process query params
	if (url.search && url.search !== "?") {
		const params = new URLSearchParams(url.search);
		// Delete tracked ad/UTM params (collect keys first to avoid mutation during iteration)
		const allKeys = Array.from(params.keys());
		for (const key of allKeys) {
			if (key.startsWith("utm_") || STRIPPED_PARAMS.has(key)) {
				params.delete(key);
			}
		}
		// Rebuild sorted query string
		const sortedKeys = Array.from(params.keys()).sort();
		if (sortedKeys.length > 0) {
			const sortedParams = new URLSearchParams();
			for (const key of sortedKeys) {
				sortedParams.set(key, params.get(key)!);
			}
			url.search = sortedParams.toString();
		} else {
			url.search = "";
		}
	}

	// Normalize double slashes in path
	url.pathname = url.pathname.replace(/\/+/g, "/");

	// Ensure path has at least /
	if (!url.pathname) {
		url.pathname = "/";
	}

	const result = url.toString();
	// Node.js URL.toString() preserves trailing '?' when search is empty — strip it
	if (result.endsWith("?")) {
		return result.slice(0, -1);
	}
	return result;
}

// ---------------------------------------------------------------------------
// Evidence digest computation
// ---------------------------------------------------------------------------

/**
 * Compute a SHA-256 hex digest over the canonicalized evidence bytes:
 * score.md content (UTF-8) + "||" + notes.md content (UTF-8).
 *
 * If either file is missing, the digest is over what's available.
 */
function computeEvidenceDigest(scoreContent: string, ledgerContent: string): string {
	const combined = `${scoreContent}\n||\n${ledgerContent}`;
	return createHash("sha256").update(combined).digest("hex");
}

// ---------------------------------------------------------------------------
// evaluateCheckpoint
// ---------------------------------------------------------------------------

/**
 * Evaluate research checkpoint criteria and persist the verdict.
 *
 * On the first valid call in a loop iteration:
 * 1. Verify run identity + state revision
 * 2. Read + validate score.md and notes.md
 * 3. Parse both tables
 * 4. Canonicalize unique HTTP(S) ledger URLs
 * 5. Increment the research-round counter ONCE
 * 6. Compute SHA-256 over exact bytes
 * 7. Evaluate minRounds / minSources / scoreThreshold / optional maxRounds
 * 8. Persist verdict + round via conflict-checked transaction
 *
 * Repeated calls in the same iteration return the recorded result
 * WITHOUT incrementing the round counter.
 *
 * Missing / unreadable / malformed evidence fails closed and does
 * NOT increment the round counter.
 *
 * PROCEED_WITH_GAPS is returned only when gaps remain AND the profile
 * has a finite maxRounds; a null maxRounds never forces PROCEED_WITH_GAPS.
 */
export async function evaluateCheckpoint(
	ws: Workspace,
	loopIteration: number,
	expectedRevision: number,
): Promise<CheckpointResult> {
	const statePath = path.join(ws.path, ".research", "run-state.json");

	// Read current state
	let currentState: RunState;
	try {
		currentState = readRunState(ws);
	} catch {
		// State file doesn't exist — cannot evaluate
		return {
			state: currentState,
			verdict: "CONTINUE" as const,
			round: 0,
			unmet: ["run-state not found"],
			evidenceDigest: "",
		};
	}

	// ── F1: Verify run identity against the immutable manifest ────────────
	const manifestPath = path.join(ws.path, ".research", "run.json");
	if (fs.existsSync(manifestPath)) {
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as {
			runId: string;
			workspace: string;
		};
		if (manifest.runId !== currentState.runId) {
			throw new Error(
				`Run-identity mismatch: manifest runId="${manifest.runId}" but state runId="${currentState.runId}". ` +
					"Possible stale state from a different run.",
			);
		}
		if (manifest.workspace !== ws.path) {
			throw new Error(
				`Run-identity mismatch: manifest workspace="${manifest.workspace}" but workspace="${ws.path}". ` +
					"Possible stale state from a different run.",
			);
		}
	}

	// Check if we already have a recorded verdict for this loop iteration
	const lastLoopIteration = currentState.loopIteration;
	if (lastLoopIteration === loopIteration) {
		// Already evaluated this iteration — return recorded result
		const unmet = currentState.checkpointUnmet ?? [];
		const digest = currentState.checkpointDigest ?? "";
		const verdict = currentState.checkpointVerdict ?? "CONTINUE";
		const round = currentState.researchRound ?? 0;
		return {
			state: currentState,
			verdict,
			round,
			unmet,
			evidenceDigest: digest,
		};
	}

	// Read score.md
	let scoreContent = "";
	let scoreRows: ScoreRow[] | null = null;
	try {
		const scorePath = path.join(ws.path, "score.md");
		scoreContent = fs.readFileSync(scorePath, "utf-8");
		scoreRows = parseScoreTable(scoreContent);
	} catch {
		// score.md missing or malformed — fail closed
		scoreRows = null;
	}

	// Read notes.md
	let ledgerContent = "";
	let ledgerRows: LedgerRow[] | null = null;
	try {
		const notesPath = path.join(ws.path, "notes.md");
		ledgerContent = fs.readFileSync(notesPath, "utf-8");
		ledgerRows = parseLedger(ledgerContent);
	} catch {
		// notes.md missing or malformed — fail closed
		ledgerRows = null;
	}

	// If either file is missing/malformed, fail closed immediately
	if (scoreRows === null || ledgerRows === null) {
		const unmet: string[] = [];
		if (scoreRows === null) unmet.push("score.md missing or malformed");
		if (ledgerRows === null) unmet.push("notes.md missing or malformed");
		return {
			state: currentState,
			verdict: "CONTINUE" as const,
			round: 0,
			unmet,
			evidenceDigest: "",
		};
	}

	// Count unique canonicalized URLs
	const canonicalUrls = new Set<string>();
	for (const row of ledgerRows) {
		canonicalUrls.add(canonicalizeUrl(row.url));
	}
	const uniqueSourceCount = canonicalUrls.size;

	// Compute evidence digest over exact bytes
	const evidenceDigest = computeEvidenceDigest(scoreContent, ledgerContent);

	// Load profile thresholds from config
	const config = loadPackagedConfig();
	const profileName = currentState.checkpointProfile ?? "standard";
	const profileCfg = config.profiles[profileName];
	if (!profileCfg) {
		// Unknown profile — treat as having no thresholds (will fail all checks)
		return {
			state: currentState,
			verdict: "CONTINUE" as const,
			round: 0,
			unmet: [`unknown profile: ${profileName}`],
			evidenceDigest,
		};
	}

	const {
		minRounds,
		maxRounds,
		minSources,
	} = profileCfg;

	// Evaluate criteria
	const unmet: string[] = [];

	// Min rounds check
	const currentRound = currentState.researchRound ?? 0;
	if (currentRound < minRounds) {
		unmet.push(`min rounds: ${currentRound}/${minRounds}`);
	}

	// Min sources check
	if (uniqueSourceCount < minSources) {
		unmet.push(`min sources: ${uniqueSourceCount}/${minSources}`);
	}

	// Score threshold check (from defaults)
	const scoreThreshold = config.defaults.scoreThreshold;
	const belowThreshold: string[] = [];
	for (const row of scoreRows) {
		if (row.score < scoreThreshold) {
			belowThreshold.push(row.id);
		}
	}
	if (belowThreshold.length > 0) {
		unmet.push(`score threshold: ${belowThreshold.join(", ")} below ${scoreThreshold}`);
	}

	// Determine verdict
	let verdict: Verdict;

	if (unmet.length === 0) {
		verdict = "PROCEED";
	} else if (maxRounds !== null && currentRound >= maxRounds) {
		// Finite max reached but floors still unmet → PROCEED_WITH_GAPS
		verdict = "PROCEED_WITH_GAPS";
	} else {
		// Still have rounds remaining (or maxRounds is null/open-ended)
		verdict = "CONTINUE";
	}

	// Increment researchRound counter (only on first valid call)
	const newRound = currentRound + 1;

	// Persist via conflict-checked transaction
	let updatedState: RunState;
	try {
		updatedState = await updateRunState(ws, expectedRevision, (current) => ({
			...current,
			researchRound: newRound,
			checkpointVerdict: verdict,
			checkpointDigest: evidenceDigest,
			checkpointUnmet: unmet,
			checkpointUniqueSources: uniqueSourceCount,
			loopIteration,
			checkpointProfile: profileName,
		}));
	} catch (conflict) {
		const stateConflict = conflict as StateConflict;
		// Retry with the fresh state's revision — but do NOT increment round
		// on retry, as the first call already incremented (the queue serializes)
		const freshState = readRunState(ws);
		const unmetRetry = freshState.checkpointUnmet ?? [];
		const digestRetry = freshState.checkpointDigest ?? "";
		const verdictRetry = freshState.checkpointVerdict ?? "CONTINUE";
		const roundRetry = freshState.researchRound ?? currentRound;
		return {
			state: freshState,
			verdict: verdictRetry,
			round: roundRetry,
			unmet: unmetRetry,
			evidenceDigest: digestRetry,
		};
	}

	return {
		state: updatedState,
		verdict,
		round: newRound,
		unmet,
		evidenceDigest,
	};
}

// ── Re-export from config for loadPackagedConfig ───────────────────────
// Exported so consumers of checkpoint.ts can access the packaged config
// without importing config.ts directly (backwards-compatibility surface).
export { loadPackagedConfig } from "./config.ts";
