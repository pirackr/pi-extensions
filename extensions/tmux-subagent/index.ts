import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadSubagentConfiguration } from "./config.ts";
import { parseCoordinatorResult, renderSummaryResults } from "./render.ts";
import { getActiveResearchBudgets } from "../deep-research/session.ts";
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

const MAX_RESULT_BYTES = 50 * 1024;
const POLL_INTERVAL_MS = 250;
const TERMINAL_STATES = new Set([
	"succeeded",
	"failed",
	"timed_out",
	"cancelled",
]);

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

export interface RunSubagentsParams {
	tasks: TaskItem[];
	timeout_seconds?: number;
	retain_artifacts?: string;
	return_mode?: "full" | "summary";
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
			"When return_mode is \"summary\", your output MUST include a <coordinator-summary> block with these exact fields:",
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
	if (details.layoutWarning) lines.push(`Layout warning: ${details.layoutWarning}`);
	if (details.transcriptDir) lines.push(`Transcripts: ${details.transcriptDir}`);
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

export interface PreparedTask {
	task: TaskItem;
	profile: import("./config.ts").AgentProfile;
	cwd: string;
	timeoutSeconds: number;
	taskId: string;
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
					await fs.promises
						.rm(tmpPath, { force: true })
						.catch(() => undefined);
					statuses[index].state = "failed";
					statuses[index].errorMessage = `Result export failed: ${renameError instanceof Error ? renameError.message : String(renameError)}`;
				}
			}
		} catch (error) {
			statuses[index].state = "failed";
			statuses[index].errorMessage = `Structured result validation failed: ${error instanceof Error ? error.message : String(error)}`;
		}
	}
}

export default function (pi: ExtensionAPI) {
	const { config, profiles, userConfigPath } =
		loadSubagentConfiguration(extensionDir);
	const profileMap = new Map(
		profiles.map((profile) => [profile.name, profile]),
	);
	const profileSummary = profiles
		.map((profile) => `${profile.name}: ${profile.description}`)
		.join("; ");
	const TaskItem = Type.Object({
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
		tasks: Type.Array(TaskItem, {
			description:
				"Independent tasks to execute concurrently; use one item for a single agent",
			minItems: 1,
			maxItems: config.maxTasks,
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
					'"full" (default) returns each agent\'s complete output plus the prompts sent. "summary" returns a ~600-char digest per agent and paths to the full outputs — pair with retain_artifacts: "always" so full outputs stay on disk (research loops).',
			}),
		),
	});

	pi.registerTool({
		name: "run_subagents",
		label: "Tmux Subagents",
		description:
			"Run one or more independently scoped Pi agents in visible tmux windows. " +
			"Use one task for single-agent delegation or multiple non-overlapping tasks for parallel work. " +
			"The tool owns process isolation, timeouts, cancellation, status capture, and cleanup; chaining remains parent-driven. " +
			`Configured profiles: ${profileSummary}. User configuration: ${userConfigPath}. For research loops: pass return_mode: "summary" with retain_artifacts: "always" to keep the coordinator context thin — the tool returns digests plus artifact paths, and full outputs stay on disk.`,
		parameters: Params,

		async execute(_toolCallId, params, signal, onUpdate, ctx) {
			const typedParams = params as RunSubagentsParams;
			const returnMode = (typedParams.return_mode ?? "full") as
				| "full"
				| "summary";
			if (
				typedParams.tasks.length === 0 ||
				typedParams.tasks.length > config.maxTasks
			) {
				throw new Error(`Provide between 1 and ${config.maxTasks} tasks.`);
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
				await fs.promises
					.access(childExtension, fs.constants.R_OK)
					.catch(() => {
						throw new Error(
							`Configured child extension not found: ${childExtension}`,
						);
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
								: path.resolve(ctx!.cwd, cwdSetting);
					const stat = await fs.promises.stat(cwd);
					if (!stat.isDirectory())
						throw new Error(
							`Task working directory is not a directory: ${cwd}`,
						);
					const timeoutSeconds =
						timeoutOverride ??
						profile.timeoutSeconds ??
						config.defaultTimeoutSeconds;
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
			const parentSessionId = ctx?.sessionManager?.getSessionId() ?? "unknown";
			const parentCwd = ctx?.cwd ?? process.cwd();
			const windowName = buildWindowName(parentCwd, {
				homedir: os.homedir(),
				topic: ctx?.sessionManager?.getSessionName(),
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
			const promptContents = new Map<
				string,
				{ system: string; task: string }
			>();
			const statuses: TaskStatus[] = prepared.map(
				(item: (typeof prepared)[number]) => ({
					taskId: item.taskId,
					agent: item.task.agent,
					state: "starting",
					startedAt: new Date().toISOString(),
					model: item.profile.model,
				}),
			);
			let keepArtifacts = true;
			let launchedPaneIds: string[] = [];
			const tmuxExec: TmuxExecutor = (args) => runCommand("tmux", args);

			const getAttachCommand = () =>
				windowId
					? `tmux attach -t ${session}:${windowId}`
					: `tmux attach -t ${session}`;

			const emitUpdate = () => {
				onUpdate?.({					content: [
						{
							type: "text",
							text: renderProgress(
								session,
								windowName,
								windowId,
								statuses,
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
					} satisfies SubagentDetails,
				});
			};

			try {
				// Defensive: the research-session module may be absent (e.g. not
				// registered in tests); treat it as no active budgets.
				const activeResearchBudgets = getActiveResearchBudgets() ?? {
					maxSearchesPerAgent: null,
					maxFetchesPerAgent: null,
				};
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
					const taskPath = path.join(
						runDir,
						"request",
						`${item.taskId}-task.md`,
					);
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
							// Active budget 0 = unlimited (falls through to task arg / config);
							// a positive active budget is a hard cap task args cannot exceed.
							activeResearchBudgets.maxSearchesPerAgent != null &&
							activeResearchBudgets.maxSearchesPerAgent > 0
								? Math.min(
										item.task.webSearchMaxLookups ?? Infinity,
										activeResearchBudgets.maxSearchesPerAgent,
								  )
								: item.task.webSearchMaxLookups ?? config.webSearchMaxLookups,
						webSearchMaxFetches:
							activeResearchBudgets.maxFetchesPerAgent != null &&
							activeResearchBudgets.maxFetchesPerAgent > 0
								? Math.min(
										item.task.webSearchMaxFetches ?? Infinity,
										activeResearchBudgets.maxFetchesPerAgent,
								  )
								: item.task.webSearchMaxFetches ?? config.webSearchMaxFetches,
					};
					requests.push(request);
					const requestPath = path.join(
						runDir,
						"request",
						`${item.taskId}.json`,
					);
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
				emitUpdate();

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

					const progress = statuses
						.map((status) => `${status.taskId}:${status.state}`)
						.join("|");
					if (progress !== lastProgress) {
						lastProgress = progress;
						emitUpdate();
					}

					if (statuses.every((status) => TERMINAL_STATES.has(status.state)))
						break;
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
						statuses[index].errorMessage =
							statuses[index].errorMessage || stderr;
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
					results: statuses,
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
					firstPrompt: firstUserPrompt(ctx.sessionManager),
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
