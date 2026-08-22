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
			const costLabel = formatCost(costTotalOf(u.cost));
			parts.push(
				`Tokens: ${u.totalTokens} (in: ${u.input}, out: ${u.output}, cache read: ${u.cacheRead}, cache write: ${u.cacheWrite})`,
			);
			if (costLabel) parts.push(`Cost: ${costLabel}`);
			parts.push(`Turns: ${u.turns}`);
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

/**
 * Format a USD cost estimate for display: `~$` prefix marks it as pi's
 * estimate rather than a billed figure. Figures keep cents at minimum and
 * four decimals at most. Returns "" when there is nothing to show — a model
 * pi has no pricing data for reports zero, and "$0.00" beside its tokens
 * would say the run was measured and found free rather than never measured.
 */
export function formatCost(cost: number): string {
	if (!Number.isFinite(cost) || cost <= 0) return "";
	if (cost < 0.0001) return "<$0.0001";
	let s = cost.toFixed(4);
	while (s.endsWith("0") && /\.\d{3,}$/.test(s)) s = s.slice(0, -1);
	return `~$${s}`;
}

/** Normalize a usage.cost that may be a scalar or a {total} object. */
export function costTotalOf(
	cost: number | { total?: number } | undefined | null,
): number {
	if (typeof cost === "number") return Number.isFinite(cost) ? cost : 0;
	return typeof cost?.total === "number" && Number.isFinite(cost.total)
		? cost.total
		: 0;
}

// ---------------------------------------------------------------------------
// Per-agent identity colors (stable hash -> palette)
// ---------------------------------------------------------------------------

/** Theme color keys cycled by agent-name hash. Identity, not state. */
export const AGENT_COLOR_KEYS = [
	"accent",
	"warning",
	"success",
	"muted",
] as const;

/** tmux 256-colour counterparts of AGENT_COLOR_KEYS (cyan, orange, green, gray). */
const AGENT_ANSI_COLORS = [45, 214, 114, 245];

/** FNV-1a over the profile name — stable across processes for a given name. */
export function agentColorIndex(name: string): number {
	let hash = 0x811c9dc5;
	for (let i = 0; i < name.length; i++) {
		hash ^= name.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash % AGENT_COLOR_KEYS.length;
}

export function agentColorKey(name: string): string {
	return AGENT_COLOR_KEYS[agentColorIndex(name)];
}

export function agentAnsiColor(name: string): number {
	return AGENT_ANSI_COLORS[agentColorIndex(name)];
}

function elapsedMsOf(
	startedAt?: string | number,
	finishedAt?: string | number,
): number | null {
	if (startedAt == null) return null;
	const end =
		typeof finishedAt === "number"
			? finishedAt
			: typeof finishedAt === "string"
				? new Date(finishedAt).getTime()
				: Date.now();
	const start =
		typeof startedAt === "number" ? startedAt : new Date(startedAt).getTime();
	return end - start;
}

export function formatElapsed(
	startedAt?: string | number,
	finishedAt?: string | number,
): string {
	const diff = elapsedMsOf(startedAt, finishedAt);
	if (diff == null) return "";
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
	/** Stable identity color key derived from the agent name. */
	agentColor: string;
	state: string;
	objective?: string;
	model: string;
	turns: number;
	tools: number;
	tokenCount: number;
	percent: number | null;
	elapsed: string;
	/** Raw elapsed milliseconds — deadline-fraction math in statsParts. */
	elapsedMs?: number;
	/** Per-task time budget in seconds; null/undefined = unlimited. */
	timeoutSeconds?: number | null;
	/** Estimated USD cost of the run so far; 0 = no pricing data (not shown). */
	cost?: number;
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
		agentColor: agentColorKey(status.agent),
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
		elapsedMs: elapsedMsOf(status.startedAt, status.finishedAt) ?? undefined,
		timeoutSeconds:
			typeof (status as any).timeoutSeconds === "number"
				? (status as any).timeoutSeconds
				: null,
		cost: costTotalOf((status as any).usage?.cost) || undefined,
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

function deadlineSegment(task: WidgetTask, theme?: WidgetTheme): string {
	const budget = Math.round(task.timeoutSeconds ?? 0);
	const label = `⏱ ${task.elapsed}/${budget}s`;
	if (!theme) return label;
	const fraction =
		task.elapsedMs != null && budget > 0 ? task.elapsedMs / (budget * 1000) : 0;
	const color = fraction >= 0.95 ? "error" : fraction >= 0.8 ? "warning" : "dim";
	return theme.fg(color, label);
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
	// Cost is only pushed when there is one — formatCost returns "" for runs
	// with no pricing data rather than printing a measured-and-free "$0.00".
	const costLabel = formatCost(task.cost ?? 0);
	if (costLabel) {
		parts.push(theme ? theme.fg("dim", costLabel) : costLabel);
	}
	if (task.elapsed) {
		parts.push(
			task.timeoutSeconds != null && task.timeoutSeconds > 0
				? deadlineSegment(task, theme)
				: task.elapsed,
		);
	}
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

/** Theme color key for a task state — shared by icon and text styling. */
function stateColor(state: string): string {
	switch (state) {
		case "succeeded":
			return "success";
		case "failed":
		case "timed_out":
			return "error";
		case "cancelled":
			return "dim";
		default:
			return "accent";
	}
}

function iconFor(state: string, frame: number, theme?: WidgetTheme): string {
	const ch = statusIcon(state as any, frame);
	if (!theme) return ch;
	return theme.fg(stateColor(state), ch);
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
	// Agent name carries the identity color (badge-like); state coloring
	// stays on the icon so identity and status never read as each other.
	const boldName = theme?.bold ? theme.bold(task.agent) : task.agent;
	const agent = task.agentColor && theme
		? theme.fg(task.agentColor, boldName)
		: boldName;
	const objective = task.objective
		? ` (${theme ? theme.fg("muted", task.objective) : task.objective})`
		: "";
	// "starting" means the runner has not yet confirmed the pi child —
	// distinct from "running" (model alive) so a stalled launch is visible.
	const starting =
		task.state === "starting"
			? ` ${theme ? theme.fg("dim", "(starting)") : "(starting)"}`
			: "";
	const header = `${icon} ${agent}${objective}${starting}`;
	const plainHeader = `${statusIcon(task.state as any, frame)} ${task.agent}${task.objective ? ` (${task.objective})` : ""}${task.state === "starting" ? " (starting)" : ""}`;
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
	// Live activity while active; a persistent outcome line once terminal —
	// the message under an agent row used to vanish the instant the task
	// finished, leaving completed agents with no visible result.
	const rowMessage = isActiveState(task.state)
		? task.activity
		: task.result || task.errorMessage;
	if (rowMessage) {
		const line = `${ACTIVITY_GLYPH} ${truncateActivity(rowMessage)}`;
		lines.push(theme ? theme.fg("dim", line) : line);
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
	tasks: Array<{
		taskId: string;
		agent: string;
		objective: string;
		/** Per-task time budget in seconds, when configured. */
		timeoutSeconds?: number;
	}>;
	statuses: Record<string, { state: string }>;
}

/**
 * Collapse an objective to a single short line for the live widget —
 * objectives are free-text prompts and can span multiple lines.
 */
export function compactObjective(objective?: string): string | undefined {
	if (!objective) return undefined;
	const firstLine =
		objective
			.split("\n")
			.find((line) => line.trim())
			?.trim() ?? "";
	if (!firstLine) return undefined;
	return firstLine.length > 64 ? `${firstLine.slice(0, 63)}…` : firstLine;
}

function widgetRunToWidgetTasks(run: WidgetRun): WidgetTask[] {
	return run.tasks.map((t) => {
		const raw = run.statuses[t.taskId] ?? { state: "starting" };
		return toWidgetTask({
			...raw,
			taskId: t.taskId,
			agent: t.agent,
			timeoutSeconds: t.timeoutSeconds,
			// Show a compacted one-line objective in the row header so the
			// widget reads as "agent (doing X)" instead of a bare agent name.
			objective: compactObjective(t.objective),
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
	const parts: string[] = [
		`${icon} ${task.agent}${task.state === "starting" ? " (starting)" : ""}`,
	];
	parts.push(`${task.turns} turn${task.turns === 1 ? "" : "s"}`);
	if (task.tools > 0) {
		const toolWord = task.tools === 1 ? "tool" : "tools";
		parts.push(`${TOOL_GLYPH} ${task.tools} ${toolWord}`);
	}
	return parts.join(" · ");
}

/**
 * Render a per-task section heading for result blocks.
 *
 * Accepts an optional WidgetTheme so user-facing surfaces (tool-result
 * components, future viewers) get the same state coloring as widget rows.
 * The default remains plain text: headings embedded in model-facing tool
 * results must stay ANSI-free.
 */
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
	{ theme }: { theme?: WidgetTheme } = {},
): string {
	const icon = iconFor(status.state as any, 0, theme);
	const stateText = theme
		? theme.fg(stateColor(status.state as any), status.state)
		: status.state;
	let segs = `=== ${icon} ${status.agent} · ${status.taskId} · ${stateText}`;
	if (status.usage) {
		if (status.usage.turns) segs += ` — ${status.usage.turns} turns`;
		if (status.usage.totalTokens) {
			const tok = formatTokens(status.usage.totalTokens).replace(" tok", " token");
			segs += ` · ${tok}`;
		}
		// Cost only when there is one to show (no pricing data → omitted).
		const total = costTotalOf((status.usage as any).cost);
		if (total > 0) segs += ` · ${formatCost(total)}`;
	}
	return segs + " ===";
}
