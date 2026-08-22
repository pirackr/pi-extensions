/**
 * Tmux-subagent extension.
 *
 * Exports:
 * - Type helpers: TaskItem, RunnerRequest, TaskStatus, PreparedTask, etc.
 * - tmux orchestration: launchBatch, cancelPanes, buildWindowName, ...
 * - Rendering: parseCoordinatorResult, renderSummaryResults, renderResults, ...
 * - Configuration: loadSubagentConfiguration, AgentProfile, ...
 * - Provider adapter: TmuxSubagentProvider (via ./provider.ts)
 *
 * Discovery: the extension advertises its provider descriptor via
 * `pi.events` so that the subagent-dispatch façade can discover it.
 *
 * NOTE: `run_subagents` tool registration was removed (Task 5). The
 * subagent-dispatch façade now owns tool registration and dispatch.
 * The tmux extension only provides the provider adapter and lifecycle
 * helpers.
 */

import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
	InputEvent,
	InputEventResult,
} from "@earendil-works/pi-coding-agent";
import {
	buildWindowName,
	cancelPanes,
	closeParentWindow,
	findParentWindow,
	launchBatch,
	renameWindow,
	SHARED_SESSION,
	type PaneSpec,
	type TmuxExecutor,
} from "./tmux.ts";
import {
	parseCoordinatorResult,
	renderSummaryResults,
	renderWidgetLines,
	renderWindowTitle,
	renderPaneTitle,
	renderNotification,
	renderSectionHeading,
	renderTaskRow,
	toWidgetTask,
	truncateVisibleWidth,
	agentAnsiColor,
	costTotalOf,
	formatCost,
	type ParsedCoordinatorResult,
	type WidgetRun,
	type WidgetTheme,
} from "./render.ts";
import { Type } from "typebox";
import { loadSubagentConfiguration } from "./config.ts";

const MAX_RESULT_BYTES = 50 * 1024;
const POLL_INTERVAL_MS = 250;
const TERMINAL_STATES = new Set([
	"succeeded",
	"failed",
	"timed_out",
	"cancelled",
]);

// ---------------------------------------------------------------------------
// Re-export render.ts for downstream consumers
// ---------------------------------------------------------------------------
export {
	parseCoordinatorResult,
	renderSummaryResults,
	renderWidgetLines,
	renderWindowTitle,
	renderPaneTitle,
	renderNotification,
	renderSectionHeading,
	renderTaskRow,
	toWidgetTask,
	formatCost,
	costTotalOf,
	agentColorKey,
	agentAnsiColor,
	AGENT_COLOR_KEYS,
} from "./render.ts";
export type {
	CoordinatorSummary,
	RenderStatus,
	WidgetRun,
	WidgetTask,
	WidgetTheme,
} from "./render.ts";

// ---------------------------------------------------------------------------
// Shared widget registry for live UI (Tasks 6-9)
// ---------------------------------------------------------------------------
// Structurally compatible with WidgetTask fields — used for type-safe casting.
export interface TaskStatusLike {
	taskId: string;
	agent: string;
	state: string;
	startedAt?: string;
	finishedAt?: string;
	model: string;
	usage?: { totalTokens?: number; turns?: number };
	tools?: number | string[];
	toolUses?: number;
	activity?: string;
	contextUsage?: { percent?: number | null };
	compactionCount?: number;
	result?: string;
	errorMessage?: string;
}

export const widgetRuns = new Map<string, WidgetRun>();
/**
 * Runs that finished but whose widget stays visible above the editor.
 * The widget keeps showing the final ✓/✗ state until the user sends their
 * next message (pi.on("input")) or a new run starts — completion summaries
 * used to flash and vanish the instant the last agent finished.
 */
export const finishedRuns: WidgetRun[] = [];
let frame = 0;

// ---------------------------------------------------------------------------
// Best-effort tmux helper (Task 7)
// ---------------------------------------------------------------------------
function bestEffort<T>(fn: () => Promise<T>): void {
	fn().catch(() => {
		// Non-fatal: a tmux failure must never fail the tool.
	});
}

/**
 * Dismiss the finished-agents widget: drop retained finished runs and clear
 * the TUI widget/footer. No-op when nothing is retained.
 */
interface DismissableUI {
	// Method shorthand keeps parameter checking bivariant, so pi's overloaded
	// ExtensionUI methods remain assignable to these looser shapes.
	setWidget?(key: string, widget: unknown): void;
	setStatus?(key: string, status: unknown): void;
}

function dismissFinishedWidget(ctx: {
	mode?: string;
	ui?: DismissableUI;
}): void {
	if (finishedRuns.length === 0) return;
	finishedRuns.length = 0;
	if (ctx.mode === "tui") {
		ctx.ui?.setWidget?.("tmux-subagents", undefined);
		ctx.ui?.setStatus?.("tmux-subagents", undefined);
	}
}

export interface PiInvocation {
	command: string;
	args: string[];
}

export interface RunnerRequest {
	taskId: string;
	agent: string;
	model: string;
	thinking?: string;
	tools: string[];
	cwd: string;
	timeoutMs: number;
	promptPath: string;
	taskPath: string;
	outputPath: string;
	stderrPath: string;
	statusPath: string;
	pi: PiInvocation;
	childExtensions: string[];
	loadContextFiles: boolean;
	/** Best-effort private human-readable transcript file (0600). */
	transcriptPath?: string;
	/** Hard cap on web_lookup calls for this subagent process (0 = unlimited). */
	webSearchMaxLookups?: number;
	/** Hard cap on fetch_web calls for this subagent process (0 = unlimited). */
	webSearchMaxFetches?: number;
}

export interface TaskItem {
	agent: string;
	objective: string;
	scope?: string[];
	non_goals?: string[];
	constraints?: string[];
	acceptance_criteria?: string[];
	inputs?: string[];
	expected_output?: string;
	cwd?: string;
	/** Absolute path where the artifact block payload will be written. When supplied, the agent must also return an <artifact> block. */
	result_path?: string;
	/** Hard cap on web_lookup calls for this task (overrides config default). 0/unset = use config. */
	webSearchMaxLookups?: number;
	/** Hard cap on fetch_web calls for this task (overrides config default). 0/unset = use config. */
	webSearchMaxFetches?: number;
}

export interface TaskStatus {
	taskId: string;
	agent: string;
	state:
		| "starting"
		| "running"
		| "succeeded"
		| "failed"
		| "timed_out"
		| "cancelled";
	pid?: number;
	exitCode?: number | null;
	startedAt: string;
	finishedAt?: string;
	model: string;
	stopReason?: string;
	errorMessage?: string;
	result?: string;
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
	/** Active tool names (from runner live status). */
	tools?: string[];
	/** Cumulative tool executions for pi-subagents-compatible UI stats. */
	toolUses?: number;
	/** Current activity string (from runner live status). */
	activity?: string;
	/** Live context usage (from runner live status). */
	contextUsage?: {
		tokens: number;
		contextWindow: number;
		percent: number | null;
	};
	/** Number of compactions (from runner live status). */
	compactionCount?: number;
}

export interface SummaryTaskStatus extends Omit<TaskStatus, "result"> {
	result_path?: string;
	parsedResult?: Pick<ParsedCoordinatorResult, "summary">;
}

/**
 * Remove full child output after summary-mode validation/export so Pi does not
 * serialize it in the parent tool-result details. Full output remains only in
 * the retained run artifacts and transcripts.
 */
export function summarizeSummaryDetails(
	statuses: TaskStatus[],
): SummaryTaskStatus[] {
	return statuses.map((rawStatus) => {
		const {
			result: _result,
			parsedResult,
			...status
		} = rawStatus as TaskStatus & {
			result_path?: string;
			parsedResult?: ParsedCoordinatorResult;
		};
		return parsedResult
			? { ...status, parsedResult: { summary: parsedResult.summary } }
			: status;
	});
}

export interface SubagentDetails {
	session: string;
	/** Attach command that selects the parent window. */
	attachCommand: string;
	/** Immutable tmux window id ("@N") of the parent Pi session's window. */
	windowId: string;
	/** Readable display name of the parent window. */
	windowName: string;
	/** Private transcript directory for this run. */
	transcriptDir: string;
	/** Non-fatal layout warning from the tmux orchestration, if any. */
	layoutWarning?: string;
	artifactsPath: string | null;
	results: TaskStatus[];
	objectives: Record<string, string>;
}

export interface PreparedTask {
	task: TaskItem;
	profile: import("./config.ts").AgentProfile;
	cwd: string;
	timeoutSeconds: number;
	taskId: string;
}

// ---------------------------------------------------------------------------
// Helpers (used by provider, tests, and downstream consumers)
// ---------------------------------------------------------------------------

const extensionDir = path.dirname(fileURLToPath(import.meta.url));
const runnerPath = path.join(extensionDir, "runner.mjs");

export function runCommand(
	command: string,
	args: string[],
	timeout = 10_000,
): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		execFile(
			command,
			args,
			{ timeout, maxBuffer: 1024 * 1024, encoding: "utf8" },
			(error: Error | null, stdout: string, stderr: string) => {
				if (error) {
					const detail = stderr.trim() || error.message;
					reject(new Error(`${command} ${args.join(" ")} failed: ${detail}`));
					return;
				}
				resolve({ stdout, stderr });
			},
		);
	});
}

export function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function getPiInvocation(): PiInvocation {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	if (!/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: process.execPath, args: [] };
	}

	return { command: "pi", args: [] };
}

export function getRunnerInvocation(): PiInvocation {
	const execName = path.basename(process.execPath).toLowerCase();
	if (/^(node|bun)(\.exe)?$/.test(execName)) {
		return { command: process.execPath, args: [runnerPath] };
	}
	return { command: "node", args: [runnerPath] };
}

export function buildTaskPrompt(
	task: {
		objective: string;
		scope?: string[];
		non_goals?: string[];
		constraints?: string[];
		acceptance_criteria?: string[];
		inputs?: string[];
		expected_output?: string;
		result_path?: string;
	},
	returnMode: "full" | "summary",
): string {
	const sections = [
		`# Objective\n${task.objective}`,
		`# Scope\n${task.scope?.map((item) => `- ${item}`).join("\n") || "- Use only the scope needed for the objective."}`,
		`# Non-Goals\n${task.non_goals?.map((item) => `- ${item}`).join("\n") || "- Do not broaden the task."}`,
		`# Constraints\n${task.constraints?.map((item) => `- ${item}`).join("\n") || "- Follow repository instructions and existing conventions."}`,
		`# Acceptance Criteria\n${task.acceptance_criteria?.map((item) => `- ${item}`).join("\n") || "- Satisfy the objective with verifiable evidence."}`,
		`# Inputs\n${task.inputs?.map((item) => `- ${item}`).join("\n") || "- Inspect primary artifacts rather than relying on assumptions."}`,
		`# Expected Output\n${task.expected_output || "Return status, concise results, evidence, checks performed, unresolved risks, and the recommended next action."}`,
		"# Delegation Boundary\nDo not spawn, invoke, or delegate to other agents. Report any need for additional specialization to the parent agent.",
	];
	if (returnMode === "summary") {
		const resultFormatLines = [
			"# Result Format",
			'When return_mode is "summary", your output MUST include a <coordinator-summary> block with these exact fields:',
			"- Status: succeeded | partial | blocked | failed",
			"- Outcome: one-sentence result",
			"- Evidence added: count or none",
			"- Key changes: up to 3 concise items",
			"- Contradictions/blockers: concise list or none",
			"- Recommended next action: one concrete action",
		];
		if (task.result_path) {
			resultFormatLines.push(
				`When a result_path is supplied, your output MUST ALSO include a separate <artifact> block containing the complete durable payload. The exact text between <artifact> and </artifact> will be written to ${task.result_path}.`,
			);
		}
		sections.push(...resultFormatLines);
	}
	return sections.join("\n\n");
}

export async function readStatus(
	statusPath: string,
): Promise<TaskStatus | null> {
	try {
		return JSON.parse(
			await fs.promises.readFile(statusPath, "utf8"),
		) as TaskStatus;
	} catch (error) {
		if (
			(error as NodeJS.ErrnoException).code === "ENOENT" ||
			error instanceof SyntaxError
		)
			return null;
		throw error;
	}
}

export async function readStderrTail(stderrPath: string): Promise<string> {
	try {
		const text = await fs.promises.readFile(stderrPath, "utf8");
		return text.slice(-8 * 1024).trim();
	} catch {
		return "";
	}
}

export async function getWorktreeIdentity(cwd: string): Promise<string> {
	try {
		const { stdout } = await runCommand("git", [
			"-C",
			cwd,
			"rev-parse",
			"--show-toplevel",
		]);
		return await fs.promises.realpath(stdout.trim());
	} catch {
		return await fs.promises.realpath(cwd);
	}
}

export function aggregateUsage(statuses: TaskStatus[]) {
	const usage = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
	for (const status of statuses) {
		if (!status.usage) continue;
		usage.input += status.usage.input;
		usage.output += status.usage.output;
		usage.cacheRead += status.usage.cacheRead;
		usage.cacheWrite += status.usage.cacheWrite;
		usage.totalTokens += status.usage.totalTokens;
		// get_session_stats may surface cost as a scalar number — normalize.
		const statusCost =
			typeof status.usage.cost === "number"
				? status.usage.cost
				: (status.usage.cost?.total ?? 0);
		usage.cost.total += statusCost;
		const cost = status.usage.cost;
		if (typeof cost === "object" && cost !== null) {
			usage.cost.input += cost.input ?? 0;
			usage.cost.output += cost.output ?? 0;
			usage.cost.cacheRead += cost.cacheRead ?? 0;
			usage.cost.cacheWrite += cost.cacheWrite ?? 0;
		}
	}
	return usage;
}

export function truncateResult(text: string): string {
	if (Buffer.byteLength(text, "utf8") <= MAX_RESULT_BYTES) return text;
	let truncated = text.slice(0, MAX_RESULT_BYTES);
	while (Buffer.byteLength(truncated, "utf8") > MAX_RESULT_BYTES)
		truncated = truncated.slice(0, -1);
	return `${truncated}\n\n[Output truncated.]`;
}

interface RenderComponent {
	render(width: number): string[];
	invalidate(): void;
}

function textComponent(text: string): RenderComponent {
	return {
		render: (width) =>
			text.split("\n").map((line) => truncateVisibleWidth(line, width)),
		invalidate: () => undefined,
	};
}

export function renderSubagentToolCall(
	tasks: TaskItem[],
	details: SubagentDetails | undefined,
	theme: WidgetTheme,
): string {
	const parts: string[] = [];

	if (details?.session) {
		const sessionDisplay = details.windowId
			? `${details.session}:${details.windowId}`
			: details.session;
		parts.push(`Running as pi in tmux (session: ${sessionDisplay})`);
	}

	if (tasks.length === 0) {
		parts.unshift(`${theme.bold?.("Subagents") ?? "Subagents"}`);
		return parts.join("\n\n");
	}

	const block = tasks
		.map((task) => `▸ ${theme.bold?.(task.agent) ?? task.agent}`)
		.join("\n\n");
	parts.push(block);
	return parts.join("\n\n");
}

export function renderSubagentToolResult(
	details: SubagentDetails | undefined,
	text: string,
	options: { expanded: boolean; isPartial: boolean },
	theme: WidgetTheme,
): string {
	if (!details?.results?.length) return text;

	if (options.isPartial) {
		const runName = details.artifactsPath
			? path.basename(details.artifactsPath)
			: "pi-subagent";
		return theme.fg("dim", `⎿ Running as ${runName}…`);
	}

	const failed = details.results.find((status) =>
		["failed", "timed_out", "cancelled"].includes(status.state),
	);
	return failed ? theme.fg("error", "⎿ Failed") : theme.fg("dim", "⎿ Done");
}

function createToolRenderers() {
	return {
		renderCall(args: unknown, theme: WidgetTheme): RenderComponent {
			const callArgs = args as {
				tasks?: TaskItem[];
				result?: { details?: SubagentDetails };
			};
			const tasks = callArgs.tasks ?? [];
			const details = callArgs.result?.details;
			return textComponent(renderSubagentToolCall(tasks, details, theme));
		},
		renderResult(
			result: {
				content?: Array<{ type: string; text: string }>;
				details?: unknown;
			},
			options: { expanded: boolean; isPartial: boolean },
			theme: WidgetTheme,
		): RenderComponent {
			const content = result.content?.[0];
			const text = content?.type === "text" ? content.text : "";
			return textComponent(
				renderSubagentToolResult(
					result.details as SubagentDetails | undefined,
					text,
					options,
					theme,
				),
			);
		},
	};
}

/**
 * Deterministic topic source: the first user message of the session. No model
 * call is made; the text is slugified by the naming helper in tmux.ts.
 */
export function firstUserPrompt(
	sessionManager: { getEntries?: () => unknown[] } | undefined,
): string | undefined {
	const entries = sessionManager?.getEntries?.() ?? [];
	for (const entry of entries) {
		const candidate = entry as {
			type?: string;
			message?: { role?: string; content?: unknown };
		};
		if (candidate.type !== "message" || candidate.message?.role !== "user") {
			continue;
		}
		const content = candidate.message.content;
		if (typeof content === "string" && content.trim()) return content;
		if (Array.isArray(content)) {
			const text = (content as Array<{ type?: string; text?: string }>)
				.filter((part) => part.type === "text" && typeof part.text === "string")
				.map((part) => part.text as string)
				.join(" ")
				.trim();
			if (text) return text;
		}
	}
	return undefined;
}

/** Human-readable window/attach/transcript info appended to results. */
export function renderTmuxInfo(details: SubagentDetails): string {
	const lines = [
		`Tmux session: ${details.session}`,
		`Window: ${details.windowName} (${details.windowId})`,
		`Attach: ${details.attachCommand}`,
	];
	if (details.layoutWarning)
		lines.push(`Layout warning: ${details.layoutWarning}`);
	if (details.transcriptDir) lines.push(`Transcripts: ${details.transcriptDir}`);
	return lines.join("\n");
}

export function renderProgress(
	session: string,
	windowName: string,
	windowId: string,
	statuses: TaskStatus[],
	objectives?: Record<string, string>,
	timeouts?: Record<string, number>,
): string {
	const counts = statuses.reduce<Record<string, number>>((acc, status) => {
		acc[status.state] = (acc[status.state] || 0) + 1;
		return acc;
	}, {});
	const summary = Object.entries(counts)
		.map(([state, count]) => `${count} ${state}`)
		.join(", ");
	const attach = windowId
		? `tmux attach -t ${session}:${windowId}`
		: `tmux attach -t ${session}`;

	// Build inline progress rows using widget row format (Task 8)
	const rows: string[] = [];
	const attachLines = [
		`Tmux session: ${session}`,
		`Window: ${windowName} (${windowId})`,
		`Attach: ${attach}`,
	];
	// Add widget-style task rows
	for (const status of statuses) {
		const widgetTask = toWidgetTask(status as TaskStatusLike);
		const objective = objectives?.[status.taskId];
		if (objective) widgetTask.objective = objective;
		const timeout = timeouts?.[status.taskId];
		if (timeout != null) widgetTask.timeoutSeconds = timeout;
		rows.push(...renderTaskRow(widgetTask, { frame }));
	}

	return [...attachLines, ...rows, `Progress: ${summary || "starting"}`].join(
		"\n",
	);
}

export function renderResults(
	statuses: TaskStatus[],
	artifactsPath: string | null,
	prompts?: Record<string, { system: string; task: string }>,
): string {
	const sections = statuses.map((status) => {
		const heading = renderSectionHeading(status as TaskStatusLike);
		const prompt = prompts?.[status.taskId];
		const promptSection = prompt
			? `Prompt sent:\n${truncateResult(`# System\n${prompt.system}\n\n# Task\n${prompt.task}`)}`
			: "";
		const body =
			status.state === "succeeded"
				? status.result || "(no output)"
				: [
						status.errorMessage,
						status.result && `Partial output:\n${status.result}`,
					]
						.filter(Boolean)
						.join("\n\n") || "(no output)";
		return `${heading}\n${promptSection}${promptSection ? "\n\n" : ""}${truncateResult(body)}`;
	});
	if (artifactsPath) sections.push(`Artifacts retained at: ${artifactsPath}`);
	return sections.join("\n\n");
}
export function delay(ms: number, signal?: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		let timer: NodeJS.Timeout;
		const abort = () => {
			clearTimeout(timer);
			signal?.removeEventListener("abort", abort);
			reject(new Error("Subagent run cancelled"));
		};
		const finish = () => {
			signal?.removeEventListener("abort", abort);
			resolve();
		};
		timer = setTimeout(finish, ms);
		if (!signal) return;
		if (signal.aborted) abort();
		else signal.addEventListener("abort", abort, { once: true });
	});
}

/**
 * Validate coordinator-summary blocks and export artifact payloads for
 * summary-mode results. Mutates statuses in place when validation fails.
 */
export async function validateAndExportSummaryResults(
	statuses: TaskStatus[],
	prepared: PreparedTask[],
): Promise<void> {
	for (let index = 0; index < statuses.length; index++) {
		if (statuses[index].state !== "succeeded") continue;
		const fullText = statuses[index].result || "";
		const task = prepared[index].task;
		try {
			const parsed = parseCoordinatorResult(fullText, {
				requireArtifact: !!task.result_path,
			});
			(statuses[index] as any).parsedResult = parsed;
			(statuses[index] as any).result_path = task.result_path;
			(statuses[index] as any).usage = statuses[index].usage;

			if (task.result_path && parsed.artifact !== undefined) {
				const dir = path.dirname(task.result_path);
				await fs.promises.mkdir(dir, { recursive: true });
				const tmpPath = `${task.result_path}.${process.pid}.tmp`;
				await fs.promises.writeFile(tmpPath, parsed.artifact, {
					mode: 0o600,
				});
				try {
					fs.renameSync(tmpPath, task.result_path);
				} catch (renameError) {
					await fs.promises.rm(tmpPath, { force: true }).catch(() => undefined);
					statuses[index].state = "failed";
					statuses[index].errorMessage =
						`Result export failed: ${renameError instanceof Error ? renameError.message : String(renameError)}`;
				}
			}
		} catch (error) {
			statuses[index].state = "failed";
			statuses[index].errorMessage =
				`Structured result validation failed: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
}

// ---------------------------------------------------------------------------
// Default export — register the run_subagents tool
// ---------------------------------------------------------------------------

type Notifier = (message: string, type?: "info" | "warning" | "error") => void;

const pendingNotifications: {
	text: string;
	type: "info" | "error";
	cost: number;
}[] = [];

/** Queue a terminal-task toast; flushed later by flushPendingNotifications. */
function queueTerminalNotification(
	text: string,
	type: "info" | "error",
	cost = 0,
): void {
	pendingNotifications.push({ text, type, cost });
}

/**
 * Flush queued completion toasts as ONE combined message. Called when the
 * last active run finishes (widgetRuns empty): pi's TUI coalesces
 * back-to-back `info` toasts (showStatus replaces the previous status line),
 * so per-run toasts emitted while sibling runs are still going overwrite each
 * other and earlier agents' results are lost.
 */
function flushPendingNotifications(notify: Notifier | undefined): void {
	if (!notify || pendingNotifications.length === 0) return;
	const batch = pendingNotifications.splice(0);
	const totalCost = batch.reduce((sum, n) => sum + n.cost, 0);
	const parts = batch.map((n) => n.text);
	// Batch total on top so multi-agent fan-outs don't have to be added up.
	if (batch.length > 1 && totalCost > 0) {
		parts.unshift(`${batch.length} agents · ${formatCost(totalCost)}`);
	}
	const combined = parts.join("\n\n──────────\n\n");
	const level = batch.some((n) => n.type === "error") ? "error" : "info";
	notify(combined, level);
}

export default function (pi: ExtensionAPI) {
	const { config, profiles, userConfigPath } =
		loadSubagentConfiguration(extensionDir);
	const profileMap = new Map(profiles.map((profile) => [profile.name, profile]));
	const profileSummary = profiles
		.map((profile) => `${profile.name}: ${profile.description}`)
		.join("; ");

	const TaskItemSchema = Type.Object({
		agent: Type.String({
			description: `Configured agent profile. Available: ${profileSummary}`,
		}),
		objective: Type.String({
			description: "One concrete outcome for this agent",
		}),
		scope: Type.Optional(
			Type.Array(Type.String(), {
				description: "Files, directories, or concerns owned by this task",
			}),
		),
		non_goals: Type.Optional(
			Type.Array(Type.String(), {
				description: "Work explicitly outside this task",
			}),
		),
		constraints: Type.Optional(
			Type.Array(Type.String(), {
				description: "Repository or behavioral constraints",
			}),
		),
		acceptance_criteria: Type.Optional(
			Type.Array(Type.String(), {
				description: "Observable completion conditions",
			}),
		),
		inputs: Type.Optional(
			Type.Array(Type.String(), {
				description:
					"Relevant requests, files, errors, or prior findings to verify",
			}),
		),
		expected_output: Type.Optional(
			Type.String({ description: "Required result and evidence format" }),
		),
		cwd: Type.Optional(
			Type.String({
				description:
					"Working directory; defaults to the parent Pi working directory",
			}),
		),
		webSearchMaxLookups: Type.Optional(
			Type.Number({
				description:
					"Hard cap on web_lookup calls for this task (overrides config default). 0 = unlimited.",
			}),
		),
		webSearchMaxFetches: Type.Optional(
			Type.Number({
				description:
					"Hard cap on fetch_web calls for this task (overrides config default). 0 = unlimited.",
			}),
		),
		result_path: Type.Optional(
			Type.String({
				description:
					"Absolute path where the artifact block payload will be written",
			}),
		),
	});
	const Params = Type.Object({
		tasks: Type.Array(TaskItemSchema, {
			description:
				"Exactly ONE task for this call. To run multiple subagents, issue multiple run_subagents tool calls in the same block — they execute concurrently and each renders as its own transcript entry.",
		}),
		timeout_seconds: Type.Optional(
			Type.Number({
				description: `Optional timeout override for every task; configured default is ${config.defaultTimeoutSeconds} seconds`,
			}),
		),
		retain_artifacts: Type.Optional(
			Type.String({
				description: `Artifact policy: "never", "on_failure", or "always"; configured default is "${config.retainArtifacts}"`,
			}),
		),
		return_mode: Type.Optional(
			Type.Union([Type.Literal("full"), Type.Literal("summary")], {
				description:
					'"full" (default) returns each agent\'s complete output plus the prompts sent. "summary" returns a digest per agent plus paths to the full outputs — pair with retain_artifacts: "always" so full outputs stay on disk (research loops).',
			}),
		),
	});

	pi.registerTool({
		name: "run_subagents",
		label: "Tmux Subagents",
		description:
			"Run one independently scoped Pi agent in a visible tmux window. " +
			"To run multiple subagents, issue multiple run_subagents tool calls in the same block — they execute concurrently and each renders as its own transcript entry. " +
			"The tool owns process isolation, timeouts, cancellation, status capture, and cleanup; chaining remains parent-driven. " +
			`Configured profiles: ${profileSummary}. User configuration: ${userConfigPath}. For research loops: pass return_mode: "summary" with retain_artifacts: "always" to keep the coordinator context thin — the tool returns digests plus artifact paths, and full outputs stay on disk.`,
		parameters: Params,

		...createToolRenderers(),

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const typedParams = params as {
				tasks: TaskItem[];
				timeout_seconds?: number;
				retain_artifacts?: string;
				return_mode?: "full" | "summary";
			};
			const returnMode = (typedParams.return_mode ?? "full") as "full" | "summary";
			if (typedParams.tasks.length === 0) {
				throw new Error("Provide at least one task.");
			}
			if (typedParams.tasks.length > 1) {
				throw new Error(
					"run_subagents accepts exactly ONE task per call. " +
						"To run multiple subagents, issue multiple run_subagents tool calls in the same block — they execute concurrently and each renders as its own transcript entry.",
				);
			}
			if (typedParams.tasks.length > config.maxTasks) {
				throw new Error(`At most ${config.maxTasks} task allowed.`);
			}

			const timeoutOverride = typedParams.timeout_seconds;
			if (
				timeoutOverride !== undefined &&
				(!Number.isInteger(timeoutOverride) ||
					timeoutOverride < 10 ||
					timeoutOverride > 1800)
			) {
				throw new Error("timeout_seconds must be between 10 and 1800.");
			}

			const retainArtifacts =
				typedParams.retain_artifacts ?? config.retainArtifacts;
			if (!["never", "on_failure", "always"].includes(retainArtifacts)) {
				throw new Error(
					'retain_artifacts must be "never", "on_failure", or "always".',
				);
			}

			await runCommand("tmux", ["-V"]);
			await fs.promises.access(runnerPath, fs.constants.R_OK);
			for (const childExtension of config.childExtensions) {
				await fs.promises.access(childExtension, fs.constants.R_OK).catch(() => {
					throw new Error(`Configured child extension not found: ${childExtension}`);
				});
			}

			const prepared = await Promise.all(
				typedParams.tasks.map(async (task: TaskItem, index: number) => {
					const profile = profileMap.get(task.agent);
					if (!profile)
						throw new Error(
							`Unknown agent "${task.agent}". Available agents: ${profiles.map((item) => item.name).join(", ")}.`,
						);
					const cwdSetting = task.cwd ?? ".";
					const cwd =
						cwdSetting === "~"
							? os.homedir()
							: cwdSetting.startsWith("~/")
								? path.join(os.homedir(), cwdSetting.slice(2))
								: path.resolve(ctx?.cwd ?? ".", cwdSetting);
					const stat = await fs.promises.stat(cwd);
					if (!stat.isDirectory())
						throw new Error(`Task working directory is not a directory: ${cwd}`);
					const timeoutSeconds =
						timeoutOverride ?? profile.timeoutSeconds ?? config.defaultTimeoutSeconds;
					return {
						task,
						profile,
						cwd,
						timeoutSeconds,
						taskId: `task-${index + 1}`,
					};
				}),
			);

			// I1: absolute-path guard for result_path
			for (const item of prepared) {
				if (item.task.result_path && !path.isAbsolute(item.task.result_path)) {
					throw new Error(
						`result_path must be an absolute path, got: ${item.task.result_path}`,
					);
				}
			}

			const writerDirectories = new Set<string>();
			for (const item of prepared) {
				if (item.profile.access === "read") continue;
				const worktree = await getWorktreeIdentity(item.cwd);
				if (writerDirectories.has(worktree)) {
					throw new Error(
						`Parallel agents with shell or write access cannot share a worktree: ${worktree}`,
					);
				}
				writerDirectories.add(worktree);
			}

			const runDir = await fs.promises.mkdtemp(
				path.join(os.tmpdir(), "pi-subagent-"),
			);
			await fs.promises.chmod(runDir, 0o700);
			for (const child of ["request", "output", "stderr", "status"]) {
				await fs.promises.mkdir(path.join(runDir, child), { mode: 0o700 });
			}

			// Parent identity: the immutable Pi session id owns one window in the
			// shared tmux session; display names are derived and may be renamed.
			const parentSessionId = ctx?.sessionManager?.getSessionId?.() ?? "unknown";
			const parentCwd = ctx?.cwd ?? process.cwd();
			const windowName = buildWindowName(parentCwd, {
				homedir: os.homedir(),
				topic: ctx?.sessionManager?.getSessionName?.(),
				firstPrompt: firstUserPrompt(ctx?.sessionManager),
			});

			// Private transcripts live outside the per-call artifact directory so
			// artifact cleanup can never remove them (design: 0700 dirs, 0600 files).
			const transcriptRoot = "/tmp/pi-subagent-transcripts";
			const transcriptParentDir = path.join(
				transcriptRoot,
				parentSessionId.replace(/[^A-Za-z0-9._-]/g, "_"),
			);
			const transcriptDir = path.join(transcriptParentDir, path.basename(runDir));
			await fs.promises.mkdir(transcriptParentDir, {
				recursive: true,
				mode: 0o700,
			});
			await fs.promises.mkdir(transcriptDir, { recursive: true, mode: 0o700 });
			await fs.promises.chmod(transcriptParentDir, 0o700);
			await fs.promises.chmod(transcriptDir, 0o700);

			const session = SHARED_SESSION;
			let windowId = "";
			let layoutWarning: string | undefined;
			const runner = getRunnerInvocation();
			const piInvocation = getPiInvocation();
			const requests: RunnerRequest[] = [];
			const promptContents = new Map<string, { system: string; task: string }>();
			const statuses: TaskStatus[] = prepared.map(
				(item: (typeof prepared)[number]) => ({
					taskId: item.taskId,
					agent: item.task.agent,
					state: "starting",
					startedAt: new Date().toISOString(),
					model: item.profile.model,
				}),
			);

			// A new run replaces any finished-runs widget left from the previous one.
			dismissFinishedWidget(ctx);

			// Widget registry entry (Tasks 6-9)
			widgetRuns.set(runDir, {
				runId: path.basename(runDir),
				startedAt: statuses[0]?.startedAt ?? new Date().toISOString(),
				tasks: prepared.map((p) => ({
					taskId: p.taskId,
					agent: p.task.agent,
					objective: p.task.objective,
					timeoutSeconds: p.timeoutSeconds,
				})),
				statuses: Object.fromEntries(statuses.map((s) => [s.taskId, s] as const)),
			});

			// Track which task IDs have already been notified (Task 8)
			const notifiedTaskIds = new Set<string>();
			let keepArtifacts = true;
			let launchedPaneIds: string[] = [];
			const tmuxExec: TmuxExecutor = (args) => runCommand("tmux", args);

			const getAttachCommand = () =>
				windowId
					? `tmux attach -t ${session}:${windowId}`
					: `tmux attach -t ${session}`;

			// sessionId -> objectives map for inline progress display (task ID → objective)
			// Also keep objectives for progress bar display
			const objectives = Object.fromEntries(
				prepared.map((p) => [p.taskId, p.task.objective] as const),
			);
			// Per-task time budgets for deadline display in progress rows.
			const timeouts = Object.fromEntries(
				prepared.map((p) => [p.taskId, p.timeoutSeconds] as const),
			);

			const emitUpdate = () => {
				// Increment frame for widget animation (Tasks 6-9)
				frame++;

				onUpdate?.({
					content: [
						{
							type: "text",
							text: renderProgress(
								session,
								windowName,
								windowId,
								statuses,
								objectives,
								timeouts,
							),
						},
					],
					details: {
						session,
						attachCommand: getAttachCommand(),
						windowId,
						windowName,
						transcriptDir,
						layoutWarning,
						artifactsPath: runDir,
						results: [...statuses],
						objectives,
					},
				});

				// Update footer status in TUI mode (Task 6)
				if (ctx.mode === "tui" && ctx.ui?.setStatus) {
					const aggTitle = renderWindowTitle([...widgetRuns.values()], { frame });
					ctx.ui.setStatus(
						"tmux-subagents",
						aggTitle.length > 80 ? aggTitle.slice(0, 80) + "…" : aggTitle,
					);
				}
			};

			try {
				const controlCommand = [
					runner.command,
					...runner.args,
					"--control",
					session,
				]
					.map(shellQuote)
					.join(" ");
				const panes: PaneSpec[] = [];

				for (let index = 0; index < prepared.length; index++) {
					const item = prepared[index];
					const promptPath = path.join(
						runDir,
						"request",
						`${item.taskId}-prompt.md`,
					);
					const taskPath = path.join(runDir, "request", `${item.taskId}-task.md`);
					await fs.promises.writeFile(promptPath, item.profile.systemPrompt, {
						mode: 0o600,
					});
					const taskPrompt = buildTaskPrompt(item.task, returnMode);
					await fs.promises.writeFile(taskPath, taskPrompt, {
						mode: 0o600,
					});
					promptContents.set(item.taskId, {
						system: item.profile.systemPrompt,
						task: taskPrompt,
					});
					const request: RunnerRequest = {
						taskId: item.taskId,
						agent: item.task.agent,
						model: item.profile.model,
						thinking: item.profile.thinking,
						tools: item.profile.tools,
						cwd: item.cwd,
						timeoutMs: item.timeoutSeconds * 1000,
						promptPath,
						taskPath,
						outputPath: path.join(runDir, "output", `${item.taskId}.jsonl`),
						stderrPath: path.join(runDir, "stderr", `${item.taskId}.log`),
						statusPath: path.join(runDir, "status", `${item.taskId}.json`),
						transcriptPath: path.join(transcriptDir, `${item.taskId}.log`),
						pi: piInvocation,
						childExtensions: config.childExtensions,
						loadContextFiles: config.loadContextFiles,
						webSearchMaxLookups:
							item.task.webSearchMaxLookups ?? config.webSearchMaxLookups,
						webSearchMaxFetches:
							item.task.webSearchMaxFetches ?? config.webSearchMaxFetches,
					};
					requests.push(request);
					const requestPath = path.join(runDir, "request", `${item.taskId}.json`);
					await fs.promises.writeFile(
						requestPath,
						JSON.stringify(request, null, 2),
						{ mode: 0o600 },
					);
					const taskCommand = [runner.command, ...runner.args, requestPath]
						.map(shellQuote)
						.join(" ");
					panes.push({
						runId: path.basename(runDir),
						taskId: item.taskId,
						agent: item.task.agent,
						command: taskCommand,
						cwd: item.cwd,
						order: index,
					});
				}

				// Launch everything through the shared session orchestrator: the
				// session is created once, the parent window holds one pane per task,
				// and completed panes stay visible via remain-on-exit.
				const launchResult = await launchBatch(tmuxExec, {
					sessionId: parentSessionId,
					pid: process.pid,
					cwd: parentCwd,
					windowName,
					controlCommand,
					panes,
				});
				windowId = launchResult.window.id;
				layoutWarning = launchResult.layoutWarning;
				launchedPaneIds = launchResult.paneIds;
				// launchedPaneIds are real tmux pane ids ("%9") in creation order,
				// matching prepared — map each pane to its task for title pushes.
				const paneTaskIds = new Map(
					launchedPaneIds.map((paneId, index) => [paneId, prepared[index]?.taskId]),
				);
				const paneTitleState = new Map<
					string,
					{ lastTitle: string; lastPushAt: number }
				>();
				let lastRenameAt = 0;
				emitUpdate();

				// Register widget in TUI mode (Task 6)
				let widgetDispose: (() => void) | undefined;
				if (ctx.mode === "tui" && ctx.ui?.setWidget) {
					// Capture the TUI handle so the animation interval can re-render
					// the widget without touching the footer status line.
					let widgetTui: { requestRender(): void } | undefined;
					const widgetComponent = (
						tui: { requestRender(): void },
						theme: WidgetTheme,
					) => {
						widgetTui = tui;
						return {
							render(width: number): string[] {
								return renderWidgetLines([...widgetRuns.values(), ...finishedRuns], {
									theme,
									frame,
									width,
								});
							},
							invalidate(): void {
								tui.requestRender();
							},
							dispose(): void {
								tui.requestRender();
								widgetDispose?.();
							},
						};
					};
					ctx.ui.setWidget("tmux-subagents", widgetComponent, {
						placement: "aboveEditor",
					});

					// Start animation interval
					let animationTimer: ReturnType<typeof setInterval>;
					widgetDispose = () => {
						clearInterval(animationTimer);
						widgetTui = undefined;
					};
					animationTimer = setInterval(() => {
						frame++;
						widgetTui?.requestRender();
						if (widgetRuns.size === 0) {
							clearInterval(animationTimer);
						}
					}, 120);
				}

				// Best-effort pane-border setup (Task 7)
				if (windowId) {
					bestEffort(() =>
						tmuxExec([
							"set-window-option",
							"-t",
							windowId,
							"pane-border-status",
							"top",
						]),
					);
					bestEffort(() =>
						tmuxExec([
							"set-window-option",
							"-t",
							windowId,
							"pane-border-format",
							"#{pane_title}",
						]),
					);
					// Per-pane border color from the agent's stable identity color so
					// a pane and its widget row read as the same agent at a glance.
					for (let index = 0; index < launchedPaneIds.length; index++) {
						const spec = panes[index];
						if (!spec) continue;
						const paneId = launchedPaneIds[index];
						bestEffort(() =>
							tmuxExec([
								"select-pane",
								"-P",
								"-t",
								paneId,
								`fg=colour${agentAnsiColor(spec.agent)}`,
							]),
						);
					}
				}

				let lastProgress = "";
				let deadlineHit = false;
				const overallDeadline =
					Date.now() +
					Math.max(...prepared.map((item) => item.timeoutSeconds)) * 1000 +
					15_000;
				while (true) {
					if (signal?.aborted) throw new Error("Subagent run cancelled");

					for (let index = 0; index < requests.length; index++) {
						const latest = await readStatus(requests[index].statusPath);
						if (latest) statuses[index] = latest;
					}

					// Update widgetRuns with latest statuses (Task 6)
					const widgetRun = widgetRuns.get(runDir);
					if (widgetRun) {
						for (let index = 0; index < requests.length; index++) {
							widgetRun.statuses[statuses[index].taskId] = statuses[index];
						}
					}

					const progress = statuses
						.map((status) => `${status.taskId}:${status.state}`)
						.join("|");
					const stateChanged = progress !== lastProgress;
					if (stateChanged) {
						lastProgress = progress;
						emitUpdate();

						// Emit notifications on terminal state transitions (Task 8)
						for (let index = 0; index < statuses.length; index++) {
							const status = statuses[index];
							if (
								TERMINAL_STATES.has(status.state) &&
								!notifiedTaskIds.has(status.taskId)
							) {
								notifiedTaskIds.add(status.taskId);
								const notified = toWidgetTask(status as TaskStatusLike);
								const objective = objectives[status.taskId];
								if (objective) notified.objective = objective;
								if (ctx.mode === "tui" && ctx.ui?.notify) {
									const type =
										status.state === "succeeded" || status.state === "cancelled"
											? ("info" as const)
											: ("error" as const);
									queueTerminalNotification(
										renderNotification(notified).join("\n"),
										type,
										costTotalOf(status.usage?.cost),
									);
								}
							}
						}
					}

					// Best-effort window title rename on state change or ≥5s (Task 7)
					if (windowId) {
						const now = Date.now();
						if (stateChanged || now - lastRenameAt >= 5_000) {
							lastRenameAt = now;
							bestEffort(() =>
								tmuxExec([
									"rename-window",
									"-t",
									windowId,
									renderWindowTitle([...widgetRuns.values()], { frame }),
								]),
							);
						}

						// Best-effort pane title pushes (Task 7): on every poll,
						// render each launched pane's candidate title and push it
						// only when it changed and that pane's 1s throttle elapsed.
						for (const paneId of launchedPaneIds) {
							const taskId = paneTaskIds.get(paneId);
							const paneStatus = taskId
								? statuses.find((s) => s.taskId === taskId)
								: undefined;
							if (!paneStatus) continue;
							const paneTask = toWidgetTask(paneStatus as TaskStatusLike);
							const paneTimeout = timeouts[paneStatus.taskId];
							if (paneTimeout != null) paneTask.timeoutSeconds = paneTimeout;
							const paneTitle = renderPaneTitle(paneTask, { frame });
							const state = paneTitleState.get(paneId) ?? {
								lastTitle: "",
								lastPushAt: 0,
							};
							if (
								paneTitle !== state.lastTitle &&
								Date.now() - state.lastPushAt >= 1_000
							) {
								paneTitleState.set(paneId, {
									lastTitle: paneTitle,
									lastPushAt: Date.now(),
								});
								bestEffort(() =>
									tmuxExec(["select-pane", "-T", paneTitle, "-t", paneId]),
								);
							}
						}
					}

					if (statuses.every((status) => TERMINAL_STATES.has(status.state))) break;
					if (Date.now() > overallDeadline) {
						deadlineHit = true;
						for (let index = 0; index < statuses.length; index++) {
							if (TERMINAL_STATES.has(statuses[index].state)) continue;
							statuses[index] = {
								...statuses[index],
								state: "timed_out",
								finishedAt: new Date().toISOString(),
								errorMessage:
									"Supervisor deadline exceeded before the runner published a final status.",
							};
						}
						break;
					}
					await delay(POLL_INTERVAL_MS, signal);
				}
				// A supervisor timeout means the runners are still live: kill only the
				// panes this call launched so their process groups terminate.
				if (deadlineHit) {
					try {
						await cancelPanes(tmuxExec, launchedPaneIds);
					} catch {
						// Best-effort: never mask the timeout result.
					}
				}

				for (let index = 0; index < statuses.length; index++) {
					if (statuses[index].state === "succeeded") continue;
					const stderr = await readStderrTail(requests[index].stderrPath);
					if (stderr)
						statuses[index].errorMessage = statuses[index].errorMessage || stderr;
				}

				// Summary mode: validate coordinator-summary and export artifacts.
				if (returnMode === "summary") {
					await validateAndExportSummaryResults(statuses, prepared);
				}

				const failed = statuses.some((status) => status.state !== "succeeded");
				keepArtifacts =
					retainArtifacts === "always" ||
					(retainArtifacts === "on_failure" && failed);
				const details: SubagentDetails = {
					session,
					attachCommand: getAttachCommand(),
					windowId,
					windowName,
					transcriptDir,
					layoutWarning,
					artifactsPath: keepArtifacts ? runDir : null,
					results:
						returnMode === "summary" ? summarizeSummaryDetails(statuses) : statuses,
					objectives,
				};
				const rendered =
					returnMode === "summary"
						? renderSummaryResults(statuses, details.artifactsPath)
						: renderResults(
								statuses,
								details.artifactsPath,
								Object.fromEntries(promptContents),
							);
				return {
					content: [
						{
							type: "text",
							text: `${rendered}\n\n${renderTmuxInfo(details)}`,
						},
					],
					details,
					usage: aggregateUsage(statuses),
				};
			} catch (error) {
				// Batch-local cancellation: aborts, supervisor timeouts, and launch
				// failures kill only the panes this call created (idempotent).
				try {
					await cancelPanes(tmuxExec, launchedPaneIds);
				} catch {
					// Best-effort; the original error is the reportable one.
				}
				keepArtifacts = retainArtifacts !== "never";
				const message = error instanceof Error ? error.message : String(error);
				const artifactNote = keepArtifacts
					? ` Artifacts retained at: ${runDir}`
					: "";
				throw new Error(`${message}${artifactNote}`);
			} finally {
				// Retain the finished run in the widget instead of tearing it down:
				// it keeps showing the final ✓/✗ state (dim "○ Agents" header) until
				// the user's next message dismisses it — completion summaries used to
				// flash and disappear the instant the last agent finished.
				const finishedRun = widgetRuns.get(runDir);
				widgetRuns.delete(runDir);
				if (finishedRun) finishedRuns.push(finishedRun);

				if (widgetRuns.size === 0) {
					// All runs done: flush queued completion toasts as one combined
					// message so pi's toast coalescing can't drop earlier agents.
					flushPendingNotifications(ctx.ui?.notify);
					// Widget and footer intentionally stay visible with final state;
					// dismissed by pi.on("input") below or when a new run starts.
					// Restore window name when no more runs (Task 7)
					if (windowId) {
						const restoredName = buildWindowName(ctx.cwd ?? process.cwd(), {
							homedir: os.homedir(),
							topic: ctx?.sessionManager?.getSessionName?.(),
							firstPrompt: firstUserPrompt(ctx?.sessionManager),
						});
						bestEffort(() =>
							tmuxExec(["rename-window", "-t", windowId, restoredName]),
						);
					}
				}

				if (!keepArtifacts || retainArtifacts === "never") {
					try {
						await fs.promises.rm(runDir, { recursive: true, force: true });
					} catch {
						// Best-effort cleanup.
					}
				}
			}
		},
	});

	// Parent window lifecycle: keep the window's display name in sync with
	// /name changes and close only this parent's window on shutdown. Both are
	// best-effort: a tmux failure must never take down the parent Pi session.
	const lifecycleExec: TmuxExecutor = (args) => runCommand("tmux", args);
	pi.on("session_info_changed", (event, ctx) => {
		void (async () => {
			try {
				const sessionId = ctx.sessionManager.getSessionId();
				const parentWindow = await findParentWindow(lifecycleExec, sessionId);
				if (!parentWindow) return;
				const name = buildWindowName(ctx.cwd, {
					homedir: os.homedir(),
					topic: (event as { name?: string }).name,
					firstPrompt: firstUserPrompt(ctx?.sessionManager),
				});
				await renameWindow(lifecycleExec, parentWindow.id, name);
			} catch {
				// Non-fatal.
			}
		})();
	});
	pi.on("session_shutdown", (_event, ctx) => {
		void (async () => {
			try {
				const sessionId = ctx.sessionManager.getSessionId();
				const parentWindow = await findParentWindow(lifecycleExec, sessionId);
				if (!parentWindow) return;
				// Killing the window terminates active runner process groups; the
				// shared session and other parents' windows stay untouched.
				await closeParentWindow(lifecycleExec, parentWindow.id);
			} catch {
				// Best-effort cleanup.
			}
		})();
	});
	// Keep the finished-agents widget visible until the user sends their next
	// message — completion summaries must not flash and vanish (UX fix).
	// Cast to an explicit call signature: some type-checking programs resolve
	// a stale ambient declaration of ExtensionAPI that predates the "input"
	// event overload, even though the runtime always supports it.
	const onInput = pi.on as (
		event: "input",
		handler: (
			event: InputEvent,
			ctx: ExtensionContext,
		) => void | InputEventResult | Promise<void | InputEventResult>,
	) => void;
	onInput("input", (_event, ctx) => {
		dismissFinishedWidget(ctx);
		return { action: "continue" };
	});
}
