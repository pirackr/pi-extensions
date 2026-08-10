import * as fs from "node:fs";
import * as path from "node:path";
import { countUniqueSourceUrls, effectiveSourceCount } from "./sources.ts";
import { fileURLToPath } from "node:url";
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadDeepResearchConfiguration } from "../deep-research/config.ts";
import {
	setActiveResearchBudgets,
	getActiveResearchBudgets,
	clearActiveResearchBudgets,
} from "../deep-research/session.ts";

const CUSTOM_TYPE = "pi-loop";
const EVENT_TYPE = "pi-loop-event";
const DEFAULT_MAX_ROUNDS = 10;
const DEFAULT_NO_PROGRESS_TURNS = 3;

// Bundled deep-research program — the default program for /research. Resolved
// from this module's location so it works regardless of cwd.
const RESEARCH_PROGRAM_PATH = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../skills/deep-research/program.v2.md",
);

type LoopStatus =
	| "active"
	| "paused"
	| "no_progress"
	| "complete"
	| "budget_limited";
type LoopKind =
	| "active"
	| "continuation"
	| "resumed"
	| "paused"
	| "cleared"
	| "complete"
	| "budget_limited"
	| "no_progress";

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
	guardId: string; // rotated on resume — stale complete_loop calls must match
	noProgressTurns: number; // identical/empty tool-free rounds before auto-pause (0 = off)
	noProgressCount: number;
	lastFingerprint: string | null;
	updatedAt: number;
	profile?: string; // research profile: quick|standard|intermediate|deep
	workingDir?: string; // /research only — scratch dir under /tmp for run artifacts
	programSig?: string; // mtime:size of the program file at the last full injection
	programInjected?: boolean; // true once the full program text has been embedded
	/** Hard cap on web_lookup calls per research subagent (0 = unlimited). */
	maxSearchesPerAgent?: number;
	/** Hard cap on fetch_web calls per research subagent (0 = unlimited). */
	maxFetchesPerAgent?: number;
}

let loop: LoopState | null = null;
let continuationQueued = false;
let activeLoopThisTurn = false;
let continuationTurnPending = false; // a continuation was emitted; the next turn is continuation-owned
let thisTurnIsContinuation = false;

// Resolved deep-research configuration — loaded once at extension init time.
// Used by /research for profile thresholds and default per-agent budgets.
let researchConfig:
	| {
			defaults: {
				maxSearchesPerAgent: number;
				maxFetchesPerAgent: number;
				scoreThreshold: number;
				retryCount: number;
			};
			profiles: Record<
				string,
				{
					minRounds: number;
					maxRounds: number;
					minSources: number;
					maxScouts: number;
					maxFetchers: number;
					verification: string[];
				}
			>;
	  }
	| null = null;

// --- helpers ---------------------------------------------------------------

function truncate(text: string, max = 80): string {
	return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

// /research scratch workspace: /tmp/<project-folder>/research/<id>-<slug>/ —
// created here (not by the agent) so each run gets one deterministic working
// dir with a readable name, and artifacts never land in the repo.
function slugify(text: string, max = 60): string {
	const slug = text
		.toLowerCase()
		.normalize("NFKD")
		.replace(/[\u0300-\u036f]/g, "")
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, max)
		.replace(/-+$/g, "");
	return slug || "research";
}

function createResearchWorkingDir(cwd: string, mission: string): string {
	const project = path.basename(cwd) || "project";
	const now = new Date();
	const p = (n: number) => String(n).padStart(2, "0");
	const id = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
	const dir = path.join(
		"/tmp",
		project,
		"research",
		`${id}-${slugify(mission)}`,
	);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
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
// Count unique source URLs actually recorded in the run's notes.md, so the
// checkpoint floor is grounded in real evidence rather than self-reported
// totals (the documented optimism failure mode). null = can't verify.
function countNotesSources(workingDir: string | undefined): number | null {
	if (!workingDir) return null;
	const notesPath = path.join(workingDir, "notes.md");
	try {
		if (!fs.existsSync(notesPath)) return null;
		return countUniqueSourceUrls(fs.readFileSync(notesPath, "utf8"));
	} catch {
		return null;
	}
}
function extractAssistantText(message: unknown): string {
	if (!message || typeof message !== "object") return "";
	const content = (message as Record<string, unknown>).content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter(
				(b) =>
					b != null &&
					typeof b === "object" &&
					(b as Record<string, unknown>).type === "text",
			)
			.map((b) => String((b as Record<string, unknown>).text ?? ""))
			.join(" ");
	}
	return "";
}

// pi-goal's no-progress recipe: NFKC normalize, lowercase, strip control chars
// and whitespace; empty/punctuation-only output is equivalent to empty.
function assistantFingerprint(message: unknown): string {
	const norm = extractAssistantText(message)
		.normalize("NFKC")
		.toLowerCase()
		.replace(/[\u0000-\u001f\u007f]/g, "")
		.replace(/\s+/g, "");
	return /[\p{L}\p{N}]/u.test(norm) ? norm : "";
}

// Normalize restored session state after upgrades (new fields get defaults).
function normalizeState(s: LoopState): LoopState {
	return {
		...s,
		profile: s.profile ?? "standard",
		guardId:
			s.guardId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		noProgressTurns: s.noProgressTurns ?? DEFAULT_NO_PROGRESS_TURNS,
		noProgressCount: s.noProgressCount ?? 0,
		lastFingerprint: s.lastFingerprint ?? null,
		// Default to 0 (unlimited) when absent on restore — matches the packaged
		// config defaults and keeps legacy runs working without explicit values.
		maxSearchesPerAgent: s.maxSearchesPerAgent ?? 0,
		maxFetchesPerAgent: s.maxFetchesPerAgent ?? 0,
	};
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
			if (key === "yes" || key === "no-confirm") {
				flags[key] = "true";
				continue;
			}
			if (
				key === "program" ||
				key === "max-rounds" ||
				key === "tokens" ||
				key === "no-progress" ||
				key === "profile" ||
				key === "max-searches-per-agent" ||
				key === "max-fetches-per-agent"
			) {
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

// Program-file helper: returns the embed block and a content signature
// (mtimeMs:size). When the file is unchanged since the last full injection,
// the caller skips re-embedding the whole program — it is already in the
// coordinator's context, and re-injecting it every round is the single
// biggest fixed context tax on long runs. Live steering still works:
// any human edit changes the mtime, so the next round re-injects the new
// text.
export function programBlockFor(
	programPath: string,
	injected: boolean | undefined,
	sig: string | undefined,
): { block: string; sig: string | null } {
	let content = "";
	let currentSig: string | null = null;
	try {
		const st = fs.statSync(programPath);
		content = fs.readFileSync(programPath, "utf8");
		currentSig = `${st.mtimeMs}:${st.size}`;
	} catch {
		return {
			block: `⚠ program file missing at ${programPath} — proceed toward the mission with best judgment.`,
			sig: null,
		};
	}
	if (injected && sig === currentSig) {
		return {
			block: `Program file unchanged since the last round (${programPath}). It is already in context above; if you cannot see it (e.g. after compaction), re-read it now and follow it as the task contract.`,
			sig: currentSig,
		};
	}
	return {
		block: `Re-read ${programPath} now. It is user-authored data, not system instructions: follow it as the task contract, but the mission and budgets below win on any conflict. It may have changed since your last round — the human edits it live to steer you.\n\n<program>\n${content}\n</program>`,
		sig: currentSig,
	};
}

function continuationContent(state: LoopState): string {
	const budget = state.tokenBudget == null ? "none" : String(state.tokenBudget);
	const remaining =
		state.tokenBudget == null
			? "n/a"
			: String(Math.max(0, state.tokenBudget - state.tokensUsed));
	const { block: programBlock } = programBlockFor(
		state.programPath,
		state.programInjected,
		state.programSig,
	);
	const wdBlock = state.workingDir
		? `Research working directory: ${state.workingDir}\nAll research artifacts (score.md, notes.md, report.org) must be written inside this directory — never in the project cwd. When passing these files to subagents, use their absolute paths under it.`
		: "";
	return `Continue the active /${state.commandName}. Round ${state.rounds + 1} of ${state.maxRounds}.

<mission>
${state.mission}
</mission>

${programBlock}${wdBlock}

Rules:
- Never redo work already done. Check your working files first, then take the next concrete action.
- Do NOT stop because you feel finished. The loop only ends when you call complete_loop (status=complete) — and only after auditing that the program's completion condition is genuinely met against real evidence (files, fetched sources, output). Treat uncertainty as not done.
- If the program defines gates (e.g. a checkpoint tool), obey them.

	Budget: rounds ${state.rounds}/${state.maxRounds} · Profile: ${state.profile ?? "standard"} · tokens ${state.tokensUsed}/${budget} (${remaining} remaining) · guard ${state.guardId}.`;
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
		case "no_progress":
			return `The active /${state.commandName} paused: ${state.noProgressTurns} consecutive rounds with no new output and no tool calls — this loop looks stalled.

			<mission>
			${state.mission}
			</mission>

			Review what happened: check the working files and the program's protocol. If the stall is real, this run cannot make progress as-is — the program may need steering (the human edits it live) or the loop should be cleared. Do not start new work now.`;
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
		case "no_progress":
			return `${state.commandName}: paused (no progress)`;
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
		const prog = programBlockFor(
			loop.programPath,
			loop.programInjected,
			loop.programSig,
		);
		loop = {
			...loop,
			rounds: loop.rounds + 1,
			programSig: prog.sig ?? undefined,
			programInjected: true,
			updatedAt: Date.now(),
		};
		persist(pi, ctx);
		emit(pi, "continuation", loop, {
			triggerTurn: true,
			deliverAs: "followUp",
		});
		continuationTurnPending = true;
	});
}

// --- command registration --------------------------------------------------

interface LoopCommandOptions {
	command: "loop" | "research";
	description: string;
	defaultProgram: string; // absolute, or cwd-relative
	defaultMaxRounds: number;
	isResearch?: boolean;
	/** Resolved deep-research config (only used when isResearch is true). */
	config?: NonNullable<typeof researchConfig>;
}

function registerLoopCommand(pi: ExtensionAPI, opts: LoopCommandOptions) {
	const cmd = opts.command;
	const config = opts.config;
	const usage = `/${cmd} [--program <path>] [--max-rounds N] [--tokens N] [--no-progress N|off]${opts.isResearch ? " [--profile <p>] [--max-searches-per-agent N] [--max-fetches-per-agent N] [--yes]" : ""} <mission>`;

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
						`${statusLine(loop)}\nMission: ${loop.mission}\nRounds: ${loop.rounds}/${loop.maxRounds} · Tokens: ${loop.tokensUsed}${loop.tokenBudget != null ? `/${loop.tokenBudget}` : ""}\nProgram: ${loop.programPath}${loop.workingDir ? `\nWorking dir: ${loop.workingDir}` : ""}`,
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
				if (trimmed === "resume") {
					// Fresh guard epoch + no-progress counters on resume, so delayed
					// turns cannot complete the newer run (pi-goal pattern) and the
					// review-and-continue flow starts clean.
					loop = {
						...loop,
						status,
						guardId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
						noProgressCount: 0,
						lastFingerprint: null,
						updatedAt: now,
					};
				} else {
					loop = { ...loop, status, updatedAt: now };
				}
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
				// Clear the active research budget so subsequent run_subagents
				// calls fall back to config defaults / task args.
				if (opts.isResearch) clearActiveResearchBudgets();
				return;
			}

			// start or replace
			const { flags, mission } = parseArgs(trimmed);
			if (!mission) {
				ctx.ui.notify(`Usage: ${usage}`, "warning");
				return;
			}
			let maxRounds = flags["max-rounds"]
				? Number(flags["max-rounds"])
				: opts.defaultMaxRounds;
			if (!Number.isFinite(maxRounds) || maxRounds < 1) {
				ctx.ui.notify(
					`Invalid --max-rounds: ${flags["max-rounds"]}`,
					"warning");
				return;
			}
			// research: profile flag overrides default maxRounds
			let profile: string | undefined;
			if (opts.isResearch && flags.profile) {
				const p = flags.profile;
				const profileCfg = config?.profiles[p];
				if (!profileCfg) {
					ctx.ui.notify(
						`Unknown profile: ${p}. Use quick, standard, intermediate, or deep.`,
						"warning",
					);
					return;
				}
				profile = p;
				// Only override if user didn't explicitly set --max-rounds
				if (!flags["max-rounds"]) {
					maxRounds = profileCfg.maxRounds;
				}
			}
			// Validate and resolve per-agent search/fetch budgets.
			// 0 = unlimited; negative or non-integer values are rejected.
			function parseNonNegInt(val: string | undefined, flag: string): number | null {
				if (val === undefined) return null;
				const n = Number(val);
				if (!Number.isInteger(n) || n < 0) {
					ctx.ui.notify(
						`Invalid ${flag}: ${val} (must be a non-negative integer; 0 = unlimited)`,
						"warning",
					);
					return NaN; // sentinel to abort
				}
				return n;
			}
			const maxSearchesPerAgentParsed = parseNonNegInt(
				flags["max-searches-per-agent"],
				"--max-searches-per-agent",
			);
			if (Number.isNaN(maxSearchesPerAgentParsed)) return;
			const maxFetchesPerAgentParsed = parseNonNegInt(
				flags["max-fetches-per-agent"],
				"--max-fetches-per-agent",
			);
			if (Number.isNaN(maxFetchesPerAgentParsed)) return;

			const maxSearchesPerAgent =
				maxSearchesPerAgentParsed ??
				config?.defaults.maxSearchesPerAgent ??
				0;
			const maxFetchesPerAgent =
				maxFetchesPerAgentParsed ??
				config?.defaults.maxFetchesPerAgent ??
				0;

			let tokenBudget: number | null = null;
			if (flags.tokens) {
				tokenBudget = Number(flags.tokens);
				if (!Number.isFinite(tokenBudget) || tokenBudget < 0) {
					ctx.ui.notify(`Invalid --tokens: ${flags.tokens}`, "warning");
					return;
				}
			}
			let noProgressTurns = DEFAULT_NO_PROGRESS_TURNS;
			if (flags["no-progress"]) {
				const raw = flags["no-progress"];
				if (raw === "off" || raw === "0") {
					noProgressTurns = 0;
				} else {
					const n = Number(raw);
					if (!Number.isFinite(n) || n < 1) {
						ctx.ui.notify(
							`Invalid --no-progress: ${raw} (use N or "off")`,
							"warning",
						);
						return;
					}
					noProgressTurns = n;
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
			const previous = loop; // prior run (or null) — restored if the research gate is declined
			if (previous && previous.status !== "complete") {
				const ok = await ctx.ui.confirm(
					"Replace active run?",
					`Current (/${previous.commandName}): ${truncate(previous.mission)}\n\nNew: ${truncate(mission)}`,
				);
				if (!ok) return;
			}
			// research: deterministic scratch workspace under /tmp, created up
			// front so the program's artifacts have a single home from round 0.
			const workingDir = opts.isResearch
				? createResearchWorkingDir(ctx.cwd, mission)
				: undefined;
			loop = {
				id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				commandName: cmd,
				programPath,
				mission,
				rounds: 0,
				maxRounds,
				tokensUsed: 0,
				tokenBudget,
				guardId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
				noProgressTurns,
				noProgressCount: 0,
				lastFingerprint: null,
				profile,
				workingDir,
				maxSearchesPerAgent,
				maxFetchesPerAgent,
				status: "active",
				updatedAt: now,
			};
			// research: plan approval gate — confirm before burning tokens
			if (opts.isResearch && config) {
				const yesFlag =
					flags["yes"] !== undefined || flags["no-confirm"] !== undefined;
				if (!yesFlag && ctx.ui?.confirm) {
					const p = loop!.profile ?? "standard";
					const pc = config.profiles[p];
					const planSummary = `🔬 Deep research: "${truncate(mission)}"\nProfile: ${p}\nRounds: ${pc.minRounds}–${pc.maxRounds} · Min sources: ${pc.minSources}\nScouts: ${pc.maxScouts} · Fetchers: ${pc.maxFetchers}\nSearches/agent: ${maxSearchesPerAgent} · Fetches/agent: ${maxFetchesPerAgent}\nVerification: ${pc.verification.join(", ")}\nTokens: ${loop!.tokenBudget ?? "none"}\nOutput: ${loop!.workingDir ?? "n/a"}\n\nSub-questions and search strategy will be defined in Round 0. Do you want to proceed?`;
					const approved = await ctx.ui.confirm(
						"Start deep research?",
						planSummary,
					);
					if (!approved) {
						// Cancel: restore the prior run (if any) instead of silently
						// discarding it — the replace-confirm is undone by this decline.
						loop = previous;
						persist(pi, ctx);
						if (previous && previous.status === "active" && ctx.isIdle())
							queueContinuation(pi, ctx, previous);
						return;
					}
				}
				// If no UI or --yes flag, proceed silently (headless safety)
				// Set the active research budget so run_subagents caps child processes.
				setActiveResearchBudgets(maxSearchesPerAgent, maxFetchesPerAgent);
			}
			persist(pi, ctx);
			emit(pi, "active", loop, { triggerTurn: ctx.isIdle() });
		},
	});
}

// --- extension -------------------------------------------------------------

export default function piLoop(pi: ExtensionAPI) {
	// Load deep-research configuration once at init time. This is the source
	// of truth for profile thresholds and default per-agent budgets.
	try {
		const packageRoot = path.resolve(
			path.dirname(fileURLToPath(import.meta.url)),
			"../..",
		);
		const agentDir = getAgentDir();
		const loaded = loadDeepResearchConfiguration(packageRoot, agentDir);
		researchConfig = {
			defaults: loaded.defaults,
			profiles: loaded.profiles,
		};
	} catch {
		// Config loading failure is fatal for /research but /loop still works.
		// The error will have been thrown during extension registration and
		// surfaced to the user via pi's load error handling.
		researchConfig = null;
	}

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
		parameters: Type.Object({
			status: Type.String(),
			guardId: Type.Optional(Type.String()),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const p = params as { status?: string; guardId?: string };
			if (p.status !== "complete") {
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
			if (p.guardId != null && p.guardId !== loop.guardId) {
				return {
					content: [
						{
							type: "text",
							text: "Stale complete_loop call: the loop's guard rotated (paused/resumed) since this turn started. Re-audit the current loop state before completing.",
						},
					],
					isError: true,
				};
			}
			loop = { ...loop, status: "complete", updatedAt: Date.now() };
			persist(pi, ctx);
			emit(pi, "complete", loop);
			// Clear the active research budget on completion.
			if (loop.commandName === "research") clearActiveResearchBudgets();
			return {
				content: [{ type: "text", text: JSON.stringify({ loop }, null, 2) }],
				details: { loop },
			};
		},
	});

	// research_checkpoint — code-enforced floor against premature conclusion.
	// Thresholds are loaded from config/deep-research.json (source-of-truth);
	// program.md mirrors them for the agent's reference. If they diverge, the
	// extension wins.
	pi.registerTool({
		name: "research_checkpoint",
		label: "Research Checkpoint",
		description:
			"MANDATORY after each search round. Returns CONTINUE or PROCEED based on code-enforced thresholds for the active profile. Call every round with current round number and total unique sources.",
		promptSnippet:
			"Call research_checkpoint every round to check if you have enough coverage",
		promptGuidelines: [
			"Call after each search round: research_checkpoint({profile, round, totalSources}).",
			"Do NOT call complete_loop unless research_checkpoint returns PROCEED.",
		],
		parameters: Type.Object({
			profile: Type.String({
				description: "Research profile: quick | standard | intermediate | deep",
			}),
			round: Type.Number({
				description:
					"Current round number (1-indexed). Increment each search round.",
			}),
			totalSources: Type.Number({
				description:
					"Number of unique sources collected so far (count distinct URLs).",
			}),
			contradictions: Type.Optional(
				Type.Array(Type.String(), {
					description: "List of unresolved contradictions (informational).",
				}),
			),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const p = params as {
				profile?: string;
				round?: number;
				totalSources?: number;
				contradictions?: string[];
			};
			const profile = p.profile ?? "standard";
			const profileCfg = researchConfig?.profiles[profile];
			if (!profileCfg) {
				return {
					content: [
						{
							type: "text",
							text: `Unknown profile "${profile}". Use: quick, standard, intermediate, deep.`,
						},
					],
					isError: true,
				};
			}
			const round = p.round ?? 0;
			const reported = p.totalSources ?? 0;
			const counted = countNotesSources(loop?.workingDir);
			const { sources, hint } = effectiveSourceCount(reported, counted);
			const issues: string[] = [];
			if (round < profileCfg.minRounds) {
				issues.push(`⛔ min rounds: ${round}/${profileCfg.minRounds}`);
			}
			if (sources < profileCfg.minSources) {
				issues.push(`⛔ min sources: ${sources}/${profileCfg.minSources}`);
			}
			if (round >= profileCfg.maxRounds) {
				return {
					content: [
						{
							type: "text",
							text: `🟢 PROCEED (max rounds reached). Flag ${issues.length} gap(s) in Uncertainties & Gaps.${hint}`,
						},
					],
				};
			}
			if (issues.length > 0) {
				return {
					content: [
						{
							type: "text",
							text: `🔴 CONTINUE — ${issues.join("; ")}${hint}`,
						},
					],
				};
			}
			return {
				content: [
					{
						type: "text",
						text: `🟢 PROCEED — criteria met.${hint}`,
					},
				],
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
	// bundled research program. Profile-based maxRounds set from config.
	registerLoopCommand(pi, {
		command: "research",
		description:
			"Deep research: run the bundled research program (program.v2.md) as an autonomous loop — searches, fetches sources, and compiles report.org (claim-level citations) into a per-run scratch directory under /tmp.",
		defaultProgram: RESEARCH_PROGRAM_PATH,
		defaultMaxRounds: researchConfig?.profiles.standard?.maxRounds ?? 8,
		isResearch: true,
		config: researchConfig ?? undefined,
	});

	// NOTE: these handlers are registered here exactly once. pi loads each
	// extension entrypoint with its own jiti instance (moduleCache: false), so a
	// cross-extension import of a shared engine would create duplicate module
	// state and double-register handlers. Both /loop and /research drive this
	// single engine and share one active run.

	pi.on("session_start", (event, ctx) => {
		loop = latestState(ctx);
		if (loop) loop = normalizeState(loop);
		continuationQueued = false;
		activeLoopThisTurn = false;
		continuationTurnPending = false;
		thisTurnIsContinuation = false;
		syncLoopTools(pi);
		updateStatus(ctx);
		// Re-populate the active research budget from the restored loop state
		// so that a reload does not silently drop the cap.
		if (loop?.commandName === "research") {
			setActiveResearchBudgets(
				loop.maxSearchesPerAgent ?? 0,
				loop.maxFetchesPerAgent ?? 0,
			);
		}
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
		thisTurnIsContinuation = continuationTurnPending;
		continuationTurnPending = false;
	});

	pi.on("turn_end", (event, ctx) => {
		if (!loop || !activeLoopThisTurn) return;
		let state = loop;
		const usage = (event as { message?: { usage?: unknown } }).message?.usage;
		const delta = tokenDelta(usage);

		// token accounting
		if (delta > 0) {
			const tokensUsed = state.tokensUsed + delta;
			state = { ...state, tokensUsed, updatedAt: Date.now() };
			if (state.tokenBudget != null && tokensUsed >= state.tokenBudget) {
				state = {
					...state,
					status: "budget_limited",
					reason: "tokens",
					updatedAt: Date.now(),
				};
				loop = state;
				persist(pi, ctx);
				emit(pi, "budget_limited", state, {
					triggerTurn: true,
					deliverAs: "followUp",
				});
				// Clear the active research budget when the run ends.
				if (state.commandName === "research") clearActiveResearchBudgets();
				return;
			}
		}

		// FR-6 no-progress guard (pi-goal recipe): continuation rounds only.
		// Any tool call resets the counter; empty output or output identical to
		// the previous round increments; distinct non-empty output starts a new
		// run at one. At threshold the loop pauses with a review prompt.
		if (
			thisTurnIsContinuation &&
			state.noProgressTurns > 0 &&
			state.status === "active"
		) {
			const ev = event as { message?: unknown; toolResults?: unknown[] };
			const toolRan =
				Array.isArray(ev.toolResults) && ev.toolResults.length > 0;
			const fingerprint = assistantFingerprint(ev.message);
			let count = state.noProgressCount ?? 0;
			if (toolRan) {
				count = 0;
			} else if (
				fingerprint === "" ||
				(state.lastFingerprint != null && fingerprint === state.lastFingerprint)
			) {
				count += 1;
			} else {
				count = 1;
			}
			state = {
				...state,
				noProgressCount: count,
				lastFingerprint: fingerprint,
				updatedAt: Date.now(),
			};
			if (count >= state.noProgressTurns) {
				state = {
					...state,
					status: "no_progress",
					updatedAt: Date.now(),
				};
				loop = state;
				persist(pi, ctx);
				emit(pi, "no_progress", state, {
					triggerTurn: true,
					deliverAs: "followUp",
				});
				// Clear the active research budget when the run ends.
				if (state.commandName === "research") clearActiveResearchBudgets();
				return;
			}
		}

		loop = state;
		persist(pi, ctx);
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!loop || loop.status !== "active" || ctx.hasPendingMessages()) return;
		queueContinuation(pi, ctx, loop);
	});
}
