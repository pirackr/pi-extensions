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
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { TmuxSubagentProvider } from "./provider.ts";
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
import { parseCoordinatorResult, renderSummaryResults } from "./render.ts";

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
export { parseCoordinatorResult, renderSummaryResults } from "./render.ts";
export type { CoordinatorSummary, RenderStatus } from "./render.ts";

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
		usage.cost.input += status.usage.cost.input;
		usage.cost.output += status.usage.cost.output;
		usage.cost.cacheRead += status.usage.cost.cacheRead;
		usage.cost.cacheWrite += status.usage.cost.cacheWrite;
		usage.cost.total += status.usage.cost.total;
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
	if (details.transcriptDir)
		lines.push(`Transcripts: ${details.transcriptDir}`);
	return lines.join("\n");
}

export function renderProgress(
	session: string,
	windowName: string,
	windowId: string,
	statuses: TaskStatus[],
): string {
	const counts = statuses.reduce<Record<string, number>>((acc, status) => {
		acc[status.state] = (acc[status.state] || 0) + 1;
		return acc;
	}, {});
	const summary = Object.entries(counts)
		.map(([state, count]) => `${count} ${state}`)
		.join(", ");
	const detail = statuses
		.map(
			(status) =>
				`  ${status.taskId} (${status.agent}) [${status.model}] ${status.state}`,
		)
		.join("\n");
	const attach = windowId
		? `tmux attach -t ${session}:${windowId}`
		: `tmux attach -t ${session}`;
	return `Tmux session: ${session}\nWindow: ${windowName} (${windowId})\nAttach: ${attach}\nProgress: ${summary || "starting"}\n${detail}`;
}

export function renderResults(
	statuses: TaskStatus[],
	artifactsPath: string | null,
	prompts?: Record<string, { system: string; task: string }>,
): string {
	const sections = statuses.map((status) => {
		const heading = `=== ${status.agent} / ${status.taskId} (${status.state}) — model: ${status.model} ===`;
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
// Default export — advertise provider via pi.events; no tool registration
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// Discover the tmux-subagent provider: the subagent-dispatch façade emits a
	// discovery channel with a caller-owned envelope; this listener pushes our
	// descriptor + instance so the façade can register and execute attempts.
	// Listening (rather than emitting) makes discovery load-order independent:
	// whether this extension loads before or after the façade, the next
	// discovery emit collects us.
	const provider = new TmuxSubagentProvider();
	if (pi.events) {
		pi.events.on("subagent-dispatch-provider-discovered", (data: unknown) => {
			const envelope = (data as { envelope?: { providers?: unknown[] } })
				?.envelope;
			if (!envelope?.providers) return;
			envelope.providers.push({
				descriptor: provider.descriptor,
				instance: provider,
			});
		});
	}

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
}
