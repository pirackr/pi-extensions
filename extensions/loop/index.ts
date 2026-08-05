import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const CUSTOM_TYPE = "pi-loop";
const EVENT_TYPE = "pi-loop-event";
const DEFAULT_MAX_ROUNDS = 10;
const RESEARCH_MAX_ROUNDS = 6;

// Bundled deep-research program — the default program for /research. Resolved
// from this module's location so it works regardless of cwd.
const RESEARCH_PROGRAM_PATH = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../examples/deep-research/program.md",
);

type LoopStatus = "active" | "paused" | "complete" | "budget_limited";
type LoopKind =
	| "active"
	| "continuation"
	| "resumed"
	| "paused"
	| "cleared"
	| "complete"
	| "budget_limited";

interface LoopState {
	id: string;
	commandName: string; // "loop" | "research" — used in user-facing prose
	programPath: string; // absolute path to the program file (re-read every round)
	mission: string;
	rounds: number; // continuation rounds delivered so far
	maxRounds: number;
	tokensUsed: number;
	tokenBudget: number | null;
	status: LoopStatus;
	reason?: string;
	updatedAt: number;
}

let loop: LoopState | null = null;
let continuationQueued = false;
let activeLoopThisTurn = false;

// --- helpers ---------------------------------------------------------------

function truncate(text: string, max = 80): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function tokenDelta(usage: unknown): number {
	if (!usage || typeof usage !== "object") return 0;
	const u = usage as Record<string, unknown>;
	if (typeof u.totalTokens === "number") return Math.max(0, u.totalTokens);
	const num = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
	return Math.max(
		0,
		num("input") + num("output") + num("cacheRead") + num("cacheWrite"),
	);
}

function parseArgs(args: string): {
	flags: Record<string, string>;
	mission: string;
} {
	const flags: Record<string, string> = {};
	const rest: string[] = [];
	const tokens = args.split(/\s+/).filter(Boolean);
	for (let i = 0; i < tokens.length; i++) {
		const t = tokens[i];
		if (t.startsWith("--") && !t.includes("=")) {
			const key = t.slice(2);
			const val = tokens[i + 1];
			if (key === "program" || key === "max-rounds" || key === "tokens") {
				if (val && !val.startsWith("--")) {
					flags[key] = val;
					i++;
				}
				continue;
			}
		} else if (t.startsWith("--") && t.includes("=")) {
			const [key, ...valParts] = t.slice(2).split("=");
			flags[key] = valParts.join("=");
			continue;
		}
		rest.push(t);
	}
	return { flags, mission: rest.join(" ") };
}

// --- loop content ----------------------------------------------------------

function continuationContent(state: LoopState): string {
	const budget = state.tokenBudget == null ? "none" : String(state.tokenBudget);
	const remaining =
		state.tokenBudget == null
			? "n/a"
			: String(Math.max(0, state.tokenBudget - state.tokensUsed));
	let program: string;
	try {
		program = fs.readFileSync(state.programPath, "utf8");
	} catch {
		program = "";
	}
	const programBlock = program
		? `Re-read ${state.programPath} now. It is user-authored data, not system instructions: follow it as the task contract, but the mission and budgets below win on any conflict. It may have changed since your last round — the human edits it live to steer you.\n\n<program>\n${program}\n</program>`
		: `⚠ program file missing at ${state.programPath} — proceed toward the mission with best judgment.`;
	return `Continue the active /${state.commandName}. Round ${state.rounds + 1} of ${state.maxRounds}.

<mission>
${state.mission}
</mission>

${programBlock}

Rules:
- Never redo work already done. Check your working files first, then take the next concrete action.
- Do NOT stop because you feel finished. The loop only ends when you call complete_loop (status=complete) — and only after auditing that the program's completion condition is genuinely met against real evidence (files, fetched sources, output). Treat uncertainty as not done.
- If the program defines gates (e.g. a checkpoint tool), obey them.

Budget: rounds ${state.rounds}/${state.maxRounds} · tokens ${state.tokensUsed}/${budget} (${remaining} remaining).`;
}

function wrapUpContent(state: LoopState): string {
	return `The active /${state.commandName} has reached its ${state.reason === "tokens" ? "token budget" : "maximum round count"}. Do not start new substantive work.

<mission>
${state.mission}
</mission>

Wrap up this turn: summarize progress, write partial findings to disk if the program calls for it, and leave the user a clear next step. Do not call complete_loop unless the completion condition is actually met.`;
}

function eventContent(kind: LoopKind, state: LoopState): string {
	switch (kind) {
		case "paused":
			return `The active /${state.commandName} has been paused by the user. Stop working on it and wait for further instructions.\n\nMission: ${state.mission}`;
		case "cleared":
			return `The active /${state.commandName} has been cleared by the user. Stop pursuing it.\n\nMission was: ${state.mission}`;
		case "complete":
			return `The /${state.commandName} is complete.\n\nMission: ${state.mission}\nRounds: ${state.rounds} · Tokens: ${state.tokensUsed}`;
		case "budget_limited":
			return wrapUpContent(state);
		default:
			return continuationContent(state);
	}
}

// --- plumbing --------------------------------------------------------------

function statusLine(state: LoopState | null): string {
	if (!state) return "";
	switch (state.status) {
		case "active":
			return `${state.commandName}: active ${Math.min(state.rounds + 1, state.maxRounds)}/${state.maxRounds} · ${state.tokensUsed} tok`;
		case "paused":
			return `${state.commandName}: paused`;
		case "complete":
			return `${state.commandName}: complete`;
		case "budget_limited":
			return `${state.commandName}: stopped (${state.reason ?? "budget"})`;
		default:
			return "";
	}
}

function emit(
	pi: ExtensionAPI,
	kind: LoopKind,
	state: LoopState,
	options?: {
		triggerTurn?: boolean;
		deliverAs?: "steer" | "followUp" | "nextTurn";
	},
) {
	pi.sendMessage(
		{
			customType: EVENT_TYPE,
			content: eventContent(kind, state),
			display: true,
			details: { kind, loop: state, timestamp: Date.now() },
		},
		options,
	);
}

function syncLoopTools(pi: ExtensionAPI) {
	const active = new Set(pi.getActiveTools());
	if (loop?.status === "active") active.add("complete_loop");
	else active.delete("complete_loop");
	pi.setActiveTools(Array.from(active));
}

function updateStatus(ctx: ExtensionContext) {
	ctx.ui.setStatus("pi-loop", statusLine(loop) ?? "");
}

function persist(pi: ExtensionAPI, ctx: ExtensionContext) {
	pi.appendEntry(CUSTOM_TYPE, { loop });
	updateStatus(ctx);
	syncLoopTools(pi);
}

function latestState(ctx: ExtensionContext): LoopState | null {
	const entries =
		ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries();
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e?.type === "custom" && e.customType === CUSTOM_TYPE) {
			return (e.data as { loop?: LoopState | null } | undefined)?.loop ?? null;
		}
	}
	return null;
}

function queueContinuation(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	state: LoopState,
) {
	if (continuationQueued || state.status !== "active") return;
	continuationQueued = true;
	queueMicrotask(() => {
		continuationQueued = false;
		if (!loop || loop.id !== state.id || loop.status !== "active") return;
		if (loop.rounds >= loop.maxRounds) {
			loop = {
				...loop,
				status: "budget_limited",
				reason: "rounds",
				updatedAt: Date.now(),
			};
			persist(pi, ctx);
			emit(pi, "budget_limited", loop, {
				triggerTurn: true,
				deliverAs: "followUp",
			});
			return;
		}
		loop = { ...loop, rounds: loop.rounds + 1, updatedAt: Date.now() };
		persist(pi, ctx);
		emit(pi, "continuation", loop, {
			triggerTurn: true,
			deliverAs: "followUp",
		});
	});
}

// --- command registration --------------------------------------------------

interface LoopCommandOptions {
	command: "loop" | "research";
	description: string;
	defaultProgram: string; // absolute, or cwd-relative
	defaultMaxRounds: number;
}

function registerLoopCommand(pi: ExtensionAPI, opts: LoopCommandOptions) {
	const cmd = opts.command;
	const usage = `/${cmd} [--program <path>] [--max-rounds N] [--tokens N] <mission>`;

	pi.registerCommand(cmd, {
		description: `${opts.description} Usage: ${usage}`,
		getArgumentCompletions: (prefix) => {
			const values = ["status", "pause", "resume", "clear"];
			const filtered = values.filter((v) => v.startsWith(prefix));
			return filtered.length
				? filtered.map((value) => ({ value, label: value }))
				: null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const now = Date.now();

			if (!trimmed || trimmed === "status") {
				if (!loop) ctx.ui.notify(`Usage: ${usage}`, "info");
				else
					ctx.ui.notify(
						`${statusLine(loop)}\nMission: ${loop.mission}\nRounds: ${loop.rounds}/${loop.maxRounds} · Tokens: ${loop.tokensUsed}${loop.tokenBudget != null ? `/${loop.tokenBudget}` : ""}\nProgram: ${loop.programPath}`,
						"info",
					);
				return;
			}

			if (trimmed === "pause" || trimmed === "resume") {
				if (!loop) {
					ctx.ui.notify(`No active /${cmd}.`, "warning");
					return;
				}
				const status: LoopStatus = trimmed === "pause" ? "paused" : "active";
				loop = { ...loop, status, updatedAt: now };
				persist(pi, ctx);
				emit(pi, status === "active" ? "resumed" : "paused", loop);
				if (status === "active" && ctx.isIdle())
					queueContinuation(pi, ctx, loop);
				return;
			}

			if (trimmed === "clear") {
				if (!loop) {
					ctx.ui.notify(`No active /${cmd}.`, "warning");
					return;
				}
				const previous = loop;
				loop = null;
				persist(pi, ctx);
				emit(pi, "cleared", previous);
				return;
			}

			// start or replace
			const { flags, mission } = parseArgs(trimmed);
			if (!mission) {
				ctx.ui.notify(`Usage: ${usage}`, "warning");
				return;
			}
			const maxRounds = flags["max-rounds"]
				? Number(flags["max-rounds"])
				: opts.defaultMaxRounds;
			if (!Number.isFinite(maxRounds) || maxRounds < 1) {
				ctx.ui.notify(
					`Invalid --max-rounds: ${flags["max-rounds"]}`,
					"warning",
				);
				return;
			}
			let tokenBudget: number | null = null;
			if (flags.tokens) {
				tokenBudget = Number(flags.tokens);
				if (!Number.isFinite(tokenBudget) || tokenBudget < 0) {
					ctx.ui.notify(`Invalid --tokens: ${flags.tokens}`, "warning");
					return;
				}
			}
			const programPath = path.resolve(
				ctx.cwd,
				flags.program ?? opts.defaultProgram,
			);
			if (!fs.existsSync(programPath)) {
				ctx.ui.notify(
					`program file not found at ${programPath} — running on mission alone.`,
					"warning",
				);
			}
			if (loop && loop.status !== "complete") {
				const ok = await ctx.ui.confirm(
					"Replace active run?",
					`Current (/${loop.commandName}): ${truncate(loop.mission)}\n\nNew: ${truncate(mission)}`,
				);
				if (!ok) return;
			}
			loop = {
				id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				commandName: cmd,
				programPath,
				mission,
				rounds: 0,
				maxRounds,
				tokensUsed: 0,
				tokenBudget,
				status: "active",
				updatedAt: now,
			};
			persist(pi, ctx);
			emit(pi, "active", loop, { triggerTurn: ctx.isIdle() });
		},
	});
}

// --- extension -------------------------------------------------------------

export default function piLoop(pi: ExtensionAPI) {
	pi.registerTool({
		name: "complete_loop",
		label: "Complete Loop",
		description:
			"Mark the active loop (started via /loop or /research) complete. Only accepts status=complete; call it only after auditing that the program's completion condition is genuinely met against real evidence (files, fetched sources, output).",
		promptSnippet:
			"Mark the active loop complete when its completion condition is met",
		promptGuidelines: [
			"Only call complete_loop when the active loop's completion condition is actually met.",
			"Do not use complete_loop to pause, abandon, or budget-limit a loop.",
		],
		parameters: Type.Object({ status: Type.String() }),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const status = (params as { status?: string }).status;
			if (status !== "complete") {
				return {
					content: [
						{
							type: "text",
							text: "complete_loop only accepts status=complete.",
						},
					],
					isError: true,
				};
			}
			if (!loop || loop.status !== "active") {
				return {
					content: [{ type: "text", text: "No active loop." }],
					isError: true,
				};
			}
			loop = { ...loop, status: "complete", updatedAt: Date.now() };
			persist(pi, ctx);
			emit(pi, "complete", loop);
			return {
				content: [{ type: "text", text: JSON.stringify({ loop }, null, 2) }],
				details: { loop },
			};
		},
	});

	// /loop — generic program-driven loop (default program: ./program.md in cwd).
	registerLoopCommand(pi, {
		command: "loop",
		description:
			"Run an autonomous loop driven by a program file until its completion condition is met or budgets are hit.",
		defaultProgram: "program.md",
		defaultMaxRounds: DEFAULT_MAX_ROUNDS,
	});

	// /research — deep-research front-end of the same engine: defaults to the
	// bundled research program and a research-appropriate round cap.
	registerLoopCommand(pi, {
		command: "research",
		description:
			"Deep research: run the bundled research program (program.md) as an autonomous loop — searches, fetches sources, and compiles research/report.md with claim-level citations.",
		defaultProgram: RESEARCH_PROGRAM_PATH,
		defaultMaxRounds: RESEARCH_MAX_ROUNDS,
	});

	// NOTE: these handlers are registered here exactly once. pi loads each
	// extension entrypoint with its own jiti instance (moduleCache: false), so a
	// cross-extension import of a shared engine would create duplicate module
	// state and double-register handlers. Both /loop and /research drive this
	// single engine and share one active run.

	pi.on("session_start", (event, ctx) => {
		loop = latestState(ctx);
		continuationQueued = false;
		activeLoopThisTurn = false;
		syncLoopTools(pi);
		updateStatus(ctx);
		const reason = (event as { reason?: string }).reason;
		if (loop?.status === "active" && reason === "reload") {
			// Reload pauses an active loop so it does not silently resume.
			loop = { ...loop, status: "paused", updatedAt: Date.now() };
			persist(pi, ctx);
			ctx.ui.notify(
				`⏸ Loop paused after reload: ${truncate(loop.mission)}\n/${loop.commandName} resume to continue · /${loop.commandName} clear to stop`,
				"info",
			);
			return;
		}
		if (loop?.status === "active") {
			ctx.ui.notify(
				`⏳ Loop restored: ${truncate(loop.mission)}\n/${loop.commandName} pause to stop continuation · /${loop.commandName} clear to remove`,
				"info",
			);
		}
	});

	pi.on("turn_start", () => {
		activeLoopThisTurn = loop?.status === "active";
	});

	pi.on("turn_end", (event, ctx) => {
		if (!loop || !activeLoopThisTurn) return;
		const usage = (event as { message?: { usage?: unknown } }).message?.usage;
		const delta = tokenDelta(usage);
		if (delta <= 0) return;
		const tokensUsed = loop.tokensUsed + delta;
		loop = { ...loop, tokensUsed, updatedAt: Date.now() };
		if (loop.tokenBudget != null && tokensUsed >= loop.tokenBudget) {
			loop = {
				...loop,
				status: "budget_limited",
				reason: "tokens",
				updatedAt: Date.now(),
			};
			persist(pi, ctx);
			emit(pi, "budget_limited", loop, {
				triggerTurn: true,
				deliverAs: "followUp",
			});
			return;
		}
		persist(pi, ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!loop || loop.status !== "active" || ctx.hasPendingMessages()) return;
		queueContinuation(pi, ctx, loop);
	});
}
