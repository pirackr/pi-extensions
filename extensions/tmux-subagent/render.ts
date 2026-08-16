import * as path from "node:path";

// Pure result renderers for run_subagents — kept free of pi imports so they
// are unit-testable in isolation (same pattern as extensions/loop/sources.ts).

export interface CoordinatorSummary {
	status: "succeeded" | "partial" | "blocked" | "failed";
	outcome: string;
	evidenceAdded: string;
	keyChanges: string[];
	contradictions: string[];
	recommendedNextAction: string;
}

export interface ParsedCoordinatorResult {
	summary: CoordinatorSummary;
	artifact?: string;
}

export interface RenderStatus {
	taskId: string;
	agent: string;
	state:
		| "starting"
		| "running"
		| "succeeded"
		| "failed"
		| "timed_out"
		| "cancelled";
	model: string;
	result?: string;
	errorMessage?: string;
	result_path?: string;
	parsedResult?: ParsedCoordinatorResult;
	usage?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		totalTokens: number;
		cost: {
			input: number;
			output: number;
			cacheRead: number;
			cacheWrite: number;
			total: number;
		};
		turns: number;
	};
}

/**
 * Parse a subagent's full output for the coordinator-summary envelope
 * and an optional artifact block.
 *
 * Throws a descriptive error when the required block is missing or
 * malformed — callers must not fall back to truncation.
 */
export function parseCoordinatorResult(
	fullText: string,
	opts: { requireArtifact?: boolean } = {},
): ParsedCoordinatorResult {
	const summaryMatch = fullText.match(
		/<coordinator-summary>([\s\S]*?)<\/coordinator-summary>/,
	);
	if (!summaryMatch) {
		throw new Error(
			"Missing <coordinator-summary> block in subagent output",
		);
	}

	const summaryBlock = summaryMatch[1].trim();
	const lines = summaryBlock
		.split("\n")
		.map((l) => l.trimEnd())
		.filter((l) => l.length > 0);

	const fields: Record<string, string[]> = {};
	let currentField: string | null = null;

	for (const line of lines) {
		const match = line.match(
			/^(Status|Outcome|Evidence added|Key changes|Contradictions\/blockers|Recommended next action):\s*(.*)$/i,
		);
		if (match) {
			if (currentField !== null) {
				fields[currentField.toLowerCase()] =
					fields[currentField.toLowerCase()] || [];
			}
			currentField = match[1].toLowerCase();
			const value = match[2]?.trim() || "";
			fields[currentField] = value ? [value] : [];
		} else if (currentField !== null) {
			// Continuation line — strip leading bullet marker if present.
			const bullet = line.replace(/^-[\s]*/, "");
			if (!fields[currentField]) fields[currentField] = [];
			fields[currentField].push(bullet);
		}
	}

	// Validate required scalar fields.
	if (!fields["status"]?.[0]) {
		throw new Error(
			"Malformed <coordinator-summary>: missing Status field",
		);
	}
	const status = fields["status"][0].toLowerCase();
	if (
		!["succeeded", "partial", "blocked", "failed"].includes(status)
	) {
		throw new Error(
			`Malformed <coordinator-summary>: invalid Status value "${fields["status"][0]}"`,
		);
	}

	if (!fields["outcome"]?.[0]) {
		throw new Error(
			"Malformed <coordinator-summary>: missing Outcome field",
		);
	}
	if (!fields["evidence added"]?.[0]) {
		throw new Error(
			"Malformed <coordinator-summary>: missing Evidence added field",
		);
	}
	if (!fields["recommended next action"]?.[0]) {
		throw new Error(
			"Malformed <coordinator-summary>: missing Recommended next action field",
		);
	}

	// Optional artifact block.
	let artifact: string | undefined;
	const artifactMatch = fullText.match(/<artifact>([\s\S]*?)<\/artifact>/);
	if (artifactMatch) {
		artifact = artifactMatch[1].trim();
	} else if (opts.requireArtifact) {
		throw new Error(
			"Missing <artifact> block in subagent output",
		);
	}

	return {
		summary: {
			status: status as CoordinatorSummary["status"],
			outcome: fields["outcome"][0],
			evidenceAdded: fields["evidence added"][0],
			keyChanges: fields["key changes"] || [],
			contradictions: fields["contradictions/blockers"] || [],
			recommendedNextAction: fields["recommended next action"][0],
		},
		artifact,
	};
}

/**
 * Summary mode for research loops: the coordinator must not carry full
 * subagent payloads in context — a coordinator-summary envelope plus
 * artifact/result paths is enough to steer, and the full outputs stay on
 * disk (pass retain_artifacts: "always" so they persist). Prompts are
 * never echoed here: the caller wrote them.
 */
export function renderSummaryResults(
	statuses: RenderStatus[],
	artifactsPath: string | null,
): string {
	const sections = statuses.map((status) => {
		const heading = `=== ${status.agent} / ${status.taskId} (${status.state}) — model: ${status.model} ===`;
		const parts: string[] = [heading];

		if (status.parsedResult && status.state === "succeeded") {
			const s = status.parsedResult.summary;
			parts.push(
				"<coordinator-summary>",
				`Status: ${s.status}`,
				`Outcome: ${s.outcome}`,
				`Evidence added: ${s.evidenceAdded}`,
				`Key changes: ${
					s.keyChanges.length
						? s.keyChanges.join("; ")
						: "none"
				}`,
				`Contradictions/blockers: ${
					s.contradictions.length
						? s.contradictions.join("; ")
						: "none"
				}`,
				`Recommended next action: ${s.recommendedNextAction}`,
				"</coordinator-summary>",
			);
		} else if (status.state !== "succeeded") {
			parts.push(status.errorMessage || "(no output)");
		} else {
			parts.push("(no coordinator-summary)");
		}

		if (status.result_path && status.state === "succeeded") {
			parts.push(`Result: ${status.result_path}`);
		}

		if (status.usage) {
			const u = status.usage;
			parts.push(
				`Tokens: ${u.totalTokens} (in: ${u.input}, out: ${u.output}, cache read: ${u.cacheRead}, cache write: ${u.cacheWrite})`,
				`Cost: $${u.cost.total.toFixed(4)}`,
				`Turns: ${u.turns}`,
			);
		}

		if (status.result_path) {
			parts.push(
				`On-disk transcript: ${path.join(
					artifactsPath || ".",
					"output",
					`${status.taskId}.jsonl`,
				)}`,
			);
		}

		return parts.join("\n");
	});

	if (artifactsPath) sections.push(`Artifacts retained at: ${artifactsPath}`);
	return sections.join("\n\n");
}

// ---------------------------------------------------------------------------
// Live-render glyphs and formatters (Task 1)
// ---------------------------------------------------------------------------

export const SPINNER_FRAMES = [
	"⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏",
];

export const TURN_GLYPH = "↻";
export const TOOL_GLYPH = "⚙";
export const ACTIVITY_GLYPH = "⎿";
export const COMPACTION_GLYPH = "⇊";

export function statusIcon(
	state:
		| "starting"
		| "running"
		| "succeeded"
		| "failed"
		| "timed_out"
		| "cancelled",
	frame: number,
): string {
	if (state === "succeeded") return "✓";
	if (state === "failed" || state === "timed_out") return "✗";
	if (state === "cancelled") return "■";
	return SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
}

export function formatTokens(n: number): string {
	if (n < 1000) return `${n} tok`;
	if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k tok`;
	return `${(n / 1_000_000).toFixed(1)}M tok`;
}

export function formatElapsed(
	startedAt?: string | number,
	finishedAt?: string | number,
): string {
	if (startedAt == null) return "";
	const diff =
		(typeof finishedAt === "number"
			? finishedAt
			: typeof finishedAt === "string"
				? new Date(finishedAt).getTime()
				: Date.now()) -
		(typeof startedAt === "number"
			? startedAt
			: new Date(startedAt).getTime());
	if (diff < 1000) return `${diff}ms`;
	if (diff < 60_000) return `${(diff / 1000).toFixed(1)}s`;
	if (diff < 3_600_000) {
		const totalSeconds = Math.floor(diff / 1000);
		return `${Math.floor(totalSeconds / 60)}m${totalSeconds % 60}s`;
	}
	const totalMinutes = Math.floor(diff / 60_000);
	return `${Math.floor(totalMinutes / 60)}h${totalMinutes % 60}m`;
}

export function truncateVisibleWidth(
	text: string,
	maxVisible: number,
): string {
	// ANSI escape sequences should not count toward visible width.
	let visible = 0;
	let inEscape = false;
	const result: string[] = [];
	for (const ch of text) {
		if (inEscape) {
			result.push(ch);
			if (ch === "m") inEscape = false;
			continue;
		}
		if (ch === "\x1b") {
			inEscape = true;
			result.push(ch);
			continue;
		}
		if (visible >= maxVisible) break;
		visible++;
		result.push(ch);
	}
	return result.join("");
}
