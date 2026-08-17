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
		throw new Error("Missing <coordinator-summary> block in subagent output");
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
		throw new Error("Malformed <coordinator-summary>: missing Status field");
	}
	const status = fields["status"][0].toLowerCase();
	if (!["succeeded", "partial", "blocked", "failed"].includes(status)) {
		throw new Error(
			`Malformed <coordinator-summary>: invalid Status value "${fields["status"][0]}"`,
		);
	}

	if (!fields["outcome"]?.[0]) {
		throw new Error("Malformed <coordinator-summary>: missing Outcome field");
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
		throw new Error("Missing <artifact> block in subagent output");
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
				`Key changes: ${s.keyChanges.length ? s.keyChanges.join("; ") : "none"}`,
				`Contradictions/blockers: ${
					s.contradictions.length ? s.contradictions.join("; ") : "none"
				}`,
				`Recommended next action: ${s.recommendedNextAction}`,
				"</coordinator-summary>",
			);
		} else if (status.state === "succeeded") {
			parts.push("(no coordinator-summary)");
		} else {
			parts.push(status.errorMessage || "(no output)");
		}

		if (status.result_path && status.state === "succeeded") {
			parts.push(`Result: ${status.result_path}`);
		}

		if (status.usage) {
			const u = status.usage;
			const costTotal = typeof u.cost === "number" ? u.cost : (u.cost?.total ?? 0);
			parts.push(
				`Tokens: ${u.totalTokens} (in: ${u.input}, out: ${u.output}, cache read: ${u.cacheRead}, cache write: ${u.cacheWrite})`,
				`Cost: $${Number.isFinite(costTotal) ? costTotal.toFixed(4) : "0.0000"}`,
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
	"⠋",
	"⠙",
	"⠹",
	"⠸",
	"⠼",
	"⠴",
	"⠦",
	"⠧",
	"⠇",
	"⠏",
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
		(typeof startedAt === "number" ? startedAt : new Date(startedAt).getTime());
	if (diff < 1000) return `${diff}ms`;
	if (diff < 60_000) return `${(diff / 1000).toFixed(1)}s`;
	if (diff < 3_600_000) {
		const totalSeconds = Math.floor(diff / 1000);
		return `${Math.floor(totalSeconds / 60)}m${totalSeconds % 60}s`;
	}
	const totalMinutes = Math.floor(diff / 60_000);
	return `${Math.floor(totalMinutes / 60)}h${totalMinutes % 60}m`;
}

export function truncateVisibleWidth(text: string, maxVisible: number): string {
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

export function toWidgetTask(status: {
	taskId: string;
	agent: string;
	state: string;
	startedAt?: string;
	finishedAt?: string;
	model: string;
	usage?: { totalTokens?: number; turns?: number };
	/** Backward-compatible distinct tool names from older runner statuses. */
	tools?: number | readonly string[];
	/** Cumulative tool executions, matching pi-subagents' "tool uses" stat. */
	toolUses?: number;
	activity?: string;
	contextUsage?: { percent?: number | null };
	compactionCount?: number;
	result?: string;
	errorMessage?: string;
}): WidgetTask {
	return {
		taskId: status.taskId,
		agent: status.agent,
		state: status.state,
		model: status.model,
		objective: (status as any).objective,
		turns: status.usage?.turns ?? 0,
		tools:
			status.toolUses ??
			(typeof status.tools === "number"
				? status.tools
				: Array.isArray(status.tools)
					? status.tools.length
					: 0),
		tokenCount: status.usage?.totalTokens ?? 0,
		percent: status.contextUsage?.percent ?? null,
		elapsed: formatElapsed(status.startedAt, status.finishedAt),
		activity: status.activity,
		compactionCount: status.compactionCount,
		result: status.result,
		errorMessage: status.errorMessage,
	};
}

export type WidgetTheme = {
	fg(color: string, text: string): string;
	bold?(text: string): string;
};

function tokenSegment(task: WidgetTask, theme?: WidgetTheme): string {
	const tokenText = formatTokens(task.tokenCount).replace(" tok", " token");
	const annotations: string[] = [];
	if (task.percent !== null) {
		const percent = `${Math.round(task.percent)}%`;
		const color =
			task.percent >= 85 ? "error" : task.percent >= 70 ? "warning" : "dim";
		annotations.push(theme ? theme.fg(color, percent) : percent);
	}
	if (task.compactionCount && task.compactionCount > 0) {
		const compactions = `${COMPACTION_GLYPH}${task.compactionCount}`;
		annotations.push(theme ? theme.fg("dim", compactions) : compactions);
	}
	return annotations.length > 0
		? `${tokenText} (${annotations.join(" · ")})`
		: tokenText;
}

function statsParts(task: WidgetTask, theme?: WidgetTheme): string[] {
	const parts: string[] = [];
	if (task.turns > 0) {
		parts.push(`${task.turns} turn${task.turns === 1 ? "" : "s"}`);
	}
	if (task.tools > 0) {
		parts.push(`${task.tools} tool use${task.tools === 1 ? "" : "s"}`);
	}
	if (task.tokenCount > 0) parts.push(tokenSegment(task, theme));
	if (task.elapsed) parts.push(task.elapsed);
	return parts;
}

function statsLine(task: WidgetTask, theme?: WidgetTheme): string {
	return statsParts(task, theme).join(" · ");
}

function wrapStats(
	task: WidgetTask,
	width: number,
	theme?: WidgetTheme,
): string[] {
	const plainParts = statsParts(task);
	const styledParts = statsParts(task, theme);
	const plainDivider = " · ";
	const divider = theme ? theme.fg("dim", "·") : "·";
	const styledDivider = ` ${divider} `;
	const lines: string[] = [];
	let plainLine = "";
	let styledLine = "";

	for (let index = 0; index < plainParts.length; index++) {
		const plainPart = plainParts[index];
		const styledPart = styledParts[index];
		const nextPlain = plainLine
			? `${plainLine}${plainDivider}${plainPart}`
			: plainPart;
		if (plainLine && nextPlain.length > width) {
			lines.push(styledLine);
			plainLine = plainPart;
			styledLine = styledPart;
		} else {
			plainLine = nextPlain;
			styledLine = styledLine
				? `${styledLine}${styledDivider}${styledPart}`
				: styledPart;
		}
	}
	if (styledLine) lines.push(styledLine);
	return lines;
}

export function renderStatsRow(task: WidgetTask): string {
	return statsLine(task);
}

function iconFor(state: string, frame: number, theme?: WidgetTheme): string {
	const ch = statusIcon(state as any, frame);
	if (!theme) return ch;
	switch (state) {
		case "succeeded":
			return theme.fg("success", ch);
		case "failed":
		case "timed_out":
			return theme.fg("error", ch);
		case "cancelled":
			return theme.fg("dim", ch);
		default:
			return theme.fg("accent", ch);
	}
}

function truncateActivity(s: string): string {
	if (!s) return "";
	const firstLine =
		s
			.split("\n")
			.find((line) => line.trim())
			?.trim() ?? "";
	const maxActivity = 58;
	return firstLine.length > maxActivity
		? firstLine.slice(0, maxActivity - 1) + "…"
		: firstLine;
}

function isActiveState(state: string): boolean {
	return state === "starting" || state === "running";
}

export function renderTaskRow(
	task: WidgetTask,
	{
		frame,
		theme,
		width,
	}: { frame: number; theme?: WidgetTheme; width?: number },
): string[] {
	const icon = iconFor(task.state, frame, theme);
	const agent = theme?.bold ? theme.bold(task.agent) : task.agent;
	const objective = task.objective
		? ` ${theme ? theme.fg("muted", task.objective) : task.objective}`
		: "";
	const header = `${icon} ${agent}${objective}`;
	const plainHeader = `${statusIcon(task.state as any, frame)} ${task.agent}${task.objective ? ` ${task.objective}` : ""}`;
	const stats = statsLine(task, theme);
	const plainStats = statsLine(task);
	const divider = theme ? theme.fg("dim", "·") : "·";
	const statsDoNotFit =
		width !== undefined &&
		plainStats.length > 0 &&
		plainHeader.length + 3 + plainStats.length > width;
	const lines = statsDoNotFit
		? [header, ...wrapStats(task, width, theme)]
		: [`${header}${stats ? ` ${divider} ${stats}` : ""}`];
	if (isActiveState(task.state) && task.activity) {
		const activity = `${ACTIVITY_GLYPH} ${truncateActivity(task.activity)}`;
		lines.push(theme ? theme.fg("dim", activity) : activity);
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
		return toWidgetTask({
			...raw,
			taskId: t.taskId,
			agent: t.agent,
			// Task objectives can contain arbitrary multi-line prompt content.
			// Keep the persistent live widget to agent state and stats only.
			model: "",
		} as any);
	});
}

const WIDGET_HEADER = "Agents";
const WIDGET_MAX_LINES = 12;

export function renderWidgetLines(
	runs: WidgetRun[],
	{ frame, theme, width }: { frame: number; theme?: WidgetTheme; width: number },
): string[] {
	const tasks = runs.flatMap(widgetRunToWidgetTasks);
	const hasActive = tasks.some((task) => isActiveState(task.state));
	const headingColor = hasActive ? "accent" : "dim";
	const headingIcon = hasActive ? "●" : "○";
	const header = theme
		? theme.fg(headingColor, `${headingIcon} ${WIDGET_HEADER}`)
		: `${headingIcon} ${WIDGET_HEADER}`;
	// Three columns are reserved for the tree connector (for example, `├─ `).
	const entryWidth = Math.max(1, width - 3);
	const entries = tasks.map((task) =>
		renderTaskRow(task, { frame, theme, width: entryWidth }),
	);
	const lines: string[] = [header];
	let used = 0;
	let visibleEntries = 0;
	const bodyBudget = WIDGET_MAX_LINES - 1;

	for (const entry of entries) {
		if (used + entry.length > bodyBudget) break;
		visibleEntries++;
		used += entry.length;
	}
	const hidden = entries.length - visibleEntries;
	if (hidden > 0 && used >= bodyBudget) {
		visibleEntries = Math.max(0, visibleEntries - 1);
	}

	for (let index = 0; index < visibleEntries; index++) {
		const entry = entries[index];
		const isLast = hidden === 0 && index === visibleEntries - 1;
		const connector = isLast ? "└─" : "├─";
		const styledConnector = theme ? theme.fg("dim", connector) : connector;
		lines.push(`${styledConnector} ${entry[0]}`);
		const branch = isLast ? "   " : "│  ";
		const styledBranch = theme ? theme.fg("dim", branch) : branch;
		for (const continuation of entry.slice(1)) {
			lines.push(`${styledBranch}${continuation}`);
		}
	}
	if (hidden > 0) {
		const overflow = `└─ +${hidden} more`;
		lines.push(theme ? theme.fg("dim", overflow) : overflow);
	}
	return lines
		.slice(0, WIDGET_MAX_LINES)
		.map((line) => truncateVisibleWidth(line, width));
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

	const icon = allSucceeded
		? "✓"
		: anyFailed
			? "✗"
			: anyCancelled
				? "■"
				: SPINNER_FRAMES[frame % SPINNER_FRAMES.length];
	const agents = [...agentSet].join("+");
	const now = Date.now();
	const startedAt =
		runs.length > 0 ? new Date(runs[0].startedAt).getTime() : now;
	const elapsed = formatElapsed(startedAt, now);
	return `${icon} ${agents} · ${doneTasks}/${totalTasks} done · ${elapsed}`;
}

export function renderPaneTitle(
	task: WidgetTask,
	{ frame }: { frame: number },
): string {
	const icon = statusIcon(task.state as any, frame);
	const parts: string[] = [`${icon} ${task.agent}`];
	parts.push(`${task.turns} turn${task.turns === 1 ? "" : "s"}`);
	if (task.tools > 0) {
		const toolWord = task.tools === 1 ? "tool" : "tools";
		parts.push(`${TOOL_GLYPH} ${task.tools} ${toolWord}`);
	}
	return parts.join(" · ");
}

export function renderNotification(task: WidgetTask): string[] {
	const icon = statusIcon(task.state as any, 0);
	const label = task.objective ?? task.taskId;
	const outcome =
		task.state === "succeeded"
			? "completed"
			: task.state === "cancelled"
				? "stopped"
				: task.state === "timed_out"
					? "timed out"
					: "failed";
	const lines = [`${icon} ${label} ${outcome}`];
	const stats = renderStatsRow(task);
	if (stats) lines.push(stats);
	if (task.result) {
		lines.push(`${ACTIVITY_GLYPH} ${truncateVisibleWidth(task.result, 120)}`);
	} else if (task.errorMessage) {
		lines.push(
			`${ACTIVITY_GLYPH} ${truncateVisibleWidth(task.errorMessage, 120)}`,
		);
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
