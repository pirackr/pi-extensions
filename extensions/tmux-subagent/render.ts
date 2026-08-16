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
		const heading = renderSectionHeading(status);
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

// ---------------------------------------------------------------------------
// Widget task adapter and row renderers (Task 2)
// ---------------------------------------------------------------------------

export interface WidgetTask {
	taskId: string;
	agent: string;
	state: string;
	objective?: string;
	model: string;
	turns: number;
	tools: number;
	tokenCount: number;
	percent: number | null;
	elapsed: string;
	activity?: string;
	compactionCount?: number;
	result?: string;
	errorMessage?: string;
}

export function toWidgetTask(
	status:
		| {
				taskId: string;
				agent: string;
				state: string;
				startedAt?: string;
				finishedAt?: string;
				model: string;
				usage?: { totalTokens?: number; turns?: number };
				tools?: number;
				activity?: string;
				contextUsage?: { percent?: number | null };
				compactionCount?: number;
				result?: string;
				errorMessage?: string;
		  },
): WidgetTask {
	return {
		taskId: status.taskId,
		agent: status.agent,
		state: status.state,
		model: status.model,
		objective: (status as any).objective,
		turns: status.usage?.turns ?? 0,
		tools: status.tools ?? 0,
		tokenCount: status.usage?.totalTokens ?? 0,
		percent: status.contextUsage?.percent ?? null,
		elapsed: formatElapsed(status.startedAt, status.finishedAt),
		activity: status.activity,
		compactionCount: status.compactionCount,
		result: status.result,
		errorMessage: status.errorMessage,
	};
}

export type WidgetTheme = { fg(color: string, text: string): string };

function tokenSegment(task: WidgetTask): string {
	const tokLabel = "token";
	let seg = `${formatTokens(task.tokenCount).replace(" tok", ` ${tokLabel}`)}`;
	if (task.percent !== null) {
		seg = seg.replace(/\s*$/, ` (${task.percent}%)`);
	}
	return seg;
}

function statsLine(task: WidgetTask): string {
	const parts: string[] = [];
	parts.push(`${TURN_GLYPH}${task.turns}`);
	if (task.tools > 0) {
		const toolWord = task.tools === 1 ? "tool" : "tools";
		parts.push(`${TOOL_GLYPH} ${task.tools} ${toolWord}`);
	}
	parts.push(tokenSegment(task));
	parts.push(task.elapsed);
	if (task.compactionCount && task.compactionCount > 0) {
		parts.push(`${COMPACTION_GLYPH}${task.compactionCount}`);
	}
	return parts.join(" · ");
}

export function renderStatsRow(task: WidgetTask): string {
	return statsLine(task);
}

function iconFor(state: string, frame: number, theme?: WidgetTheme): string {
	const ch = statusIcon(state as any, frame);
	if (!theme) return ch;
	switch (state) {
		case "succeeded":
			return theme.fg("green", ch);
		case "failed":
		case "timed_out":
			return theme.fg("red", ch);
		case "cancelled":
			return theme.fg("dim", ch);
		default:
			return theme.fg("cyan", ch);
	}
}

function truncateActivity(s: string): string {
	if (!s) return "";
	// 60 chars total for the line, minus "⎿ " (2 chars)
	const maxActivity = 60 - 2; // "⎿ " prefix
	return s.length > maxActivity ? s.slice(0, maxActivity - 1) + "…" : s;
}

export function renderTaskRow(
	task: WidgetTask,
	{ frame, theme }: { frame: number; theme?: WidgetTheme },
): string[] {
	const icon = iconFor(task.state, frame, theme);
	const segments: string[] = [`${icon} ${task.agent}`];
	if (task.objective) segments.push(task.objective);
	segments.push(statsLine(task));
	const lines: string[] = [segments.join(" · ")];
	if (task.activity) {
		lines.push(`${ACTIVITY_GLYPH} ${truncateActivity(task.activity)}`);
	}
	return lines;
}

// ---------------------------------------------------------------------------
// Widget lines, window title, pane title, notifications, results restyle
// (Task 3)
// ---------------------------------------------------------------------------

export interface WidgetRun {
	runId: string;
	startedAt: string;
	tasks: Array<{ taskId: string; agent: string; objective: string }>;
	statuses: Record<string, { state: string }>;
}

function widgetRunToWidgetTasks(run: WidgetRun): WidgetTask[] {
	return run.tasks.map((t) => {
		const raw = run.statuses[t.taskId] ?? { state: "starting" };
		return toWidgetTask({ ...raw, taskId: t.taskId, agent: t.agent, objective: t.objective, model: "" } as any);
	});
}

function footerStatus(runs: WidgetRun[]): string {
	let running = 0;
	let done = 0;
	for (const run of runs) {
		for (const s of Object.values(run.statuses)) {
			if (s.state === "starting" || s.state === "running") running++;
			else done++;
		}
	}
	const parts: string[] = [];
	if (running > 0) parts.push(`${running} running`);
	if (done > 0) parts.push(`${done} done`);
	return parts.join(" · ") || "starting";
}

const WIDGET_HEADER = "● Subagents (tmux)";
const WIDGET_MAX_LINES = 12;

function buildRunnerLines(runs: WidgetRun[], frame: number): string[] {
	const lines: string[] = [];
	for (let ri = 0; ri < runs.length; ri++) {
		if (ri > 0) lines.push(`─ Run ${ri + 1} ─`);
		const widgets = widgetRunToWidgetTasks(runs[ri]);
		for (const w of widgets) {
			const row = renderTaskRow(w, { frame });
			lines.push(row[0]);
			if (row[1]) lines.push(row[1]);
		}
	}
	return lines;
}

export function renderWidgetLines(
	runs: WidgetRun[],
	{ frame, theme, width }: { frame: number; theme?: WidgetTheme; width: number },
): string[] {
	const header = WIDGET_HEADER;
	const footer = footerStatus(runs);
	const body = buildRunnerLines(runs, frame);

	// Cap at 12: header + body rows + footer; header/footer always retained
	if (body.length <= WIDGET_MAX_LINES - 2) {
		const lines = [header, ...body, footer];
		return lines.map((l) => truncateVisibleWidth(l, width));
	}
	// Truncate body: keep header + (12-2) body rows (with truncation indicator) + footer
	const available = WIDGET_MAX_LINES - 3; // 12 - header - ellipsis - footer
	const truncated = [header, ...body.slice(0, available), "…", footer];
	return truncated.map((l) => truncateVisibleWidth(l, width));
}

export function renderWindowTitle(
	runs: WidgetRun[],
	{ frame }: { frame: number },
): string {
	// Aggregate state across all runs
	let allSucceeded = true;
	let anyFailed = false;
	let anyCancelled = false;
	let totalTasks = 0;
	let doneTasks = 0;
	const agentSet = new Set<string>();

	for (const run of runs) {
		totalTasks += run.tasks.length;
		for (const t of run.tasks) {
			const s = run.statuses[t.taskId];
			switch (s?.state) {
				case "succeeded":
					doneTasks++;
					break;
				case "failed":
				case "timed_out":
					anyFailed = true;
					allSucceeded = false;
					break;
				case "cancelled":
					anyCancelled = true;
					allSucceeded = false;
					break;
				default:
					allSucceeded = false;
			}
		}
		for (const t of run.tasks) agentSet.add(t.agent);
	}

	const icon = allSucceeded ? "✓" : anyFailed ? "✗" : anyCancelled ? "■" : SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
	const agents = [...agentSet].join("+");
	const now = Date.now();
	const startedAt = runs.length > 0 ? new Date(runs[0].startedAt).getTime() : now;
	const elapsed = formatElapsed(startedAt, now);
	return `${icon} ${agents} · ${doneTasks}/${totalTasks} done · ${elapsed}`;
}

export function renderPaneTitle(
	task: WidgetTask,
	{ frame }: { frame: number },
): string {
	const icon = statusIcon(task.state as any, frame);
	const parts: string[] = [`${icon} ${task.agent}`];
	parts.push(`${TURN_GLYPH}${task.turns}`);
	if (task.tools > 0) {
		const toolWord = task.tools === 1 ? "tool" : "tools";
		parts.push(`${TOOL_GLYPH} ${task.tools} ${toolWord}`);
	}
	return parts.join(" · ");
}

export function renderNotification(task: WidgetTask): string[] {
	const icon = statusIcon(task.state as any, 0);
	const title = task.objective ? `${icon} ${task.agent} · ${task.objective}` : `${icon} ${task.agent} · ${task.taskId}`;
	const lines = [title, renderStatsRow(task)];
	if (task.result) {
		lines.push(`${ACTIVITY_GLYPH} ${truncateVisibleWidth(task.result, 120)}`);
	} else if (task.errorMessage) {
		lines.push(`${ACTIVITY_GLYPH} ${truncateVisibleWidth(task.errorMessage, 120)}`);
	}
	return lines;
}

export function renderSectionHeading(
	status:
		| {
				state: string;
				agent: string;
				taskId: string;
				model: string;
				usage?: { totalTokens?: number; turns?: number };
		  }
		| RenderStatus,
): string {
	const icon = statusIcon(status.state as any, 0);
	let segs = `=== ${icon} ${status.agent} · ${status.taskId} · ${status.state}`;
	if (status.usage) {
		if (status.usage.turns) segs += ` — ${status.usage.turns} turns`;
		if (status.usage.totalTokens) {
			const tok = formatTokens(status.usage.totalTokens).replace(" tok", " token");
			segs += ` · ${tok}`;
		}
	}
	return segs + " ===";
}
