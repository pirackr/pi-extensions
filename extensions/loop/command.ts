/**
 * Command registration: /loop and /research (thin wrappers that use the
 * generic engine for core loop mechanics and defer to research-specific
 * logic where needed).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { LoopEngine } from "./engine.ts";
import type { LoopStatus } from "./state.ts";
import { truncate } from "./program.ts";
import type {
	ActiveResearchPointer,
	ResearchStartRequest,
} from "../research/startup.ts";
import {
	listWorkspaces,
	lookupWorkspace,
	getLifecycle,
	getActiveWorkspace,
	type WorkspaceEntry,
} from "../research/history.ts";
import {
	pauseLifecycle,
	markResumed,
	markAbandoned,
} from "../research/lifecycle.ts";
import {
	resumeWorkspace,
	type ResumeDependencies,
} from "../research/resume.ts";
import type { Workspace } from "../research/workspace.ts";

/**
 * /research start handler — injected by the wiring layer (loop/index.ts).
 * Calls prepareAndActivateResearch with the runtime StartupDependencies.
 */
export type ResearchStartHandler = (
	request: ResearchStartRequest,
	ctx: ExtensionCommandContext,
) => Promise<ActiveResearchPointer>;

export interface LoopCommandOptions {
	command: "loop" | "research";
	description: string;
	defaultProgram: string;
	defaultMaxRounds: number;
	isResearch?: boolean;
	config?: unknown; // ResearchConfigShape — kept as unknown to keep this file generic
	/** Research-only: startup engine handler (prepareAndActivateResearch wiring). */
	onResearchStart?: ResearchStartHandler;
	/** Research-only: resume deps factory (config + model/provider views). */
	onResumeDeps?: (ctx: ExtensionCommandContext) => ResumeDependencies | null;
}

/**
 * Register a loop-style command (generic /loop or /research) on the pi API.
 * The engine handles persistence, continuation, and budget enforcement.
 * Research-specific flags (profile, per-agent budgets) are handled here
 * because they affect the initial state, not the generic engine.
 */
export function registerLoopCommand(
	pi: ExtensionAPI,
	opts: LoopCommandOptions,
	engine: LoopEngine,
) {
	const cmd = opts.command;
	const usage = `/${cmd} [--program <path>] [--max-rounds N] [--tokens N] [--no-progress N|off]${
		opts.isResearch ? " [--profile <p>] [--max-searches-per-agent N] [--max-fetches-per-agent N] [--yes]" : ""
	} <mission>`;

	pi.registerCommand(cmd, {
		description: `${opts.description} Usage: ${usage}`,
		getArgumentCompletions: (prefix) => {
			const values = opts.isResearch
				? ["list", "status", "pause", "resume", "clear"]
				: ["status", "pause", "resume", "clear"];
			const filtered = values.filter((v) => v.startsWith(prefix));
			return filtered.length
				? filtered.map((value) => ({ value, label: value }))
				: null;
		},
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			const now = Date.now();

			// Research-only: workspace-scoped subcommands (list/status/pause/
			// clear/resume) operate on retained workspaces via history.ts /
			// lifecycle.ts / resume.ts. /loop never routes here — it keeps its
			// loop-level status/pause/resume/clear behavior on the active loop.
			if (
				opts.isResearch &&
				RESEARCH_SUBCOMMANDS.has(trimmed.split(/\s+/)[0])
			) {
				await routeResearchWorkspaceCommand(trimmed, ctx, engine, opts);
				return;
			}

			if (!trimmed || trimmed === "status") {
				if (!engine.state) ctx.ui.notify(`Usage: ${usage}`, "info");
				else
					ctx.ui.notify(
						`${engine.getStatusLine()}\nMission: ${engine.state!.mission}\nRounds: ${engine.state!.rounds}/${engine.state!.maxRounds} · Tokens: ${engine.state!.tokensUsed}${engine.state!.tokenBudget != null ? `/${engine.state!.tokenBudget}` : ""}\nProgram: ${engine.state!.programPath}${engine.state!.workingDir ? `\nWorking dir: ${engine.state!.workingDir}` : ""}`,
						"info",
					);
				return;
			}

			if (trimmed === "pause" || trimmed === "resume") {
				if (!engine.state) {
					ctx.ui.notify(`No active /${cmd}.`, "warning");
					return;
				}
				const status: LoopStatus = trimmed === "pause" ? "paused" : "active";
				if (trimmed === "resume") {
					const resumed = engine.resumeState(now);
					engine.persist(pi, ctx);
					engine.emit(pi, "resumed", "steer");
					if (status === "active" && ctx.isIdle()) {
						// Re-queue continuation from agent_end, not here.
					}
					return;
				} else {
					engine.pauseState(now);
					engine.persist(pi, ctx);
					engine.emit(pi, "paused");
					return;
				}
			}

			if (trimmed === "clear") {
				if (!engine.state) {
					ctx.ui.notify(`No active /${cmd}.`, "warning");
					return;
				}
				const previous = engine.clearState();
				engine.persist(pi, ctx);
				engine.emit(pi, "cleared", "steer");

				return;
			}

			// Start or replace: parse args
			const { flags, mission } = parseArgs(trimmed);
			if (!mission) {
				ctx.ui.notify(`Usage: ${usage}`, "warning");
				return;
			}

			// Resolve maxRounds
			let maxRounds = flags["max-rounds"]
				? Number(flags["max-rounds"])
				: opts.defaultMaxRounds;
			if (!Number.isFinite(maxRounds) || maxRounds < 1) {
				ctx.ui.notify(
					`Invalid --max-rounds: ${flags["max-rounds"]}`,
					"warning",
				);
				return;
			}

			// Research: profile override
			let profile: string | undefined;
			if (opts.isResearch && flags.profile) {
				const p = flags.profile;
				const profileCfg =
					(opts.config as { profiles?: Record<string, unknown> })
						?.profiles?.[p];
				if (!profileCfg) {
					ctx.ui.notify(
						`Unknown profile: ${p}. Use quick, standard, intermediate, or deep.`,
						"warning",
					);
					return;
				}
				profile = p;
				if (!flags["max-rounds"]) {
					maxRounds = (profileCfg as { maxRounds: number }).maxRounds;
				}
			}

			// Validate per-agent budgets
			function parseNonNegInt(
				val: string | undefined,
				flag: string,
			): number | null {
				if (val === undefined) return null;
				const n = Number(val);
				if (!Number.isInteger(n) || n < 0) {
					ctx.ui.notify(
						`Invalid ${flag}: ${val} (must be a non-negative integer; 0 = unlimited)`,
						"warning",
					);
					return NaN;
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
				(opts.config as { defaults?: { maxSearchesPerAgent: number } })
					?.defaults?.maxSearchesPerAgent ??
				0;
			const maxFetchesPerAgent =
				maxFetchesPerAgentParsed ??
				(opts.config as { defaults?: { maxFetchesPerAgent: number } })
					?.defaults?.maxFetchesPerAgent ??
				0;

			// Token budget
			let tokenBudget: number | null = null;
			if (flags.tokens) {
				tokenBudget = Number(flags.tokens);
				if (!Number.isFinite(tokenBudget) || tokenBudget < 0) {
					ctx.ui.notify(`Invalid --tokens: ${flags.tokens}`, "warning");
					return;
				}
			}

			// No-progress turns
			let noProgressTurns = 3;
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

			// Program path
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

			// Replace-confirm
			const previous = engine.state;
			if (previous && previous.status !== "complete") {
				const ok = await ctx.ui.confirm(
					"Replace active run?",
					`Current (/${previous.commandName}): ${truncate(previous.mission)}\n\nNew: ${truncate(mission)}`,
				);
				if (!ok) return;
			}

			if (opts.isResearch) {
				// /research start routes through the research startup engine
				// (prepareAndActivateResearch, wired via opts.onResearchStart in
				// loop/index.ts). The returned ActiveResearchPointer drives the
				// loop engine as iteration 1 (workingDir = workspace, profile =
				// contract, loop id = research runId).
				const started = await startResearchRun(engine, ctx, {
					mission,
					programPath,
					maxRounds,
					tokenBudget,
					noProgressTurns,
					profile,
					maxSearchesPerAgent,
					maxFetchesPerAgent,
					yes: flags["yes"] !== undefined || flags["no-confirm"] !== undefined,
					onResearchStart: opts.onResearchStart,
				});
				if (!started) return;
				engine.persist(pi, ctx);
				engine.emit(pi, "active", ctx.isIdle() ? "steer" : undefined);
				return;
			}

			// Create new state via engine (generic /loop path — unchanged)
			engine.startState({
				commandName: cmd,
				programPath,
				mission,
				maxRounds,
				tokenBudget,
				noProgressTurns,
			});

			engine.persist(pi, ctx);
			engine.emit(pi, "active", ctx.isIdle() ? "steer" : undefined);
		},
	});
}

// ---------------------------------------------------------------------------
// Research workspace-scoped subcommands (list/status/pause/clear/resume)
// ---------------------------------------------------------------------------

const RESEARCH_SUBCOMMANDS = new Set([
	"list",
	"status",
	"pause",
	"resume",
	"clear",
]);

/**
 * Route a /research workspace subcommand against retained workspaces.
 *
 *   list         → listWorkspaces(projectRoot) — excludes .research/cache/web,
 *                  reports malformed entries without aborting
 *   status       → lookupWorkspace + getLifecycle (workspace lifecycle, not
 *                  just the active loop state)
 *   pause        → pauseLifecycle
 *   clear        → markAbandoned
 *   resume       → resumeWorkspace (validation + lease) then markResumed
 *
 * A bare subcommand (no slug) targets the active workspace: the active loop
 * state's workingDir when set, else getActiveWorkspace (transitions pointer).
 * projectRoot for discovery is ctx.cwd — the same convention startup/index.ts
 * uses for the transitions/workspace root.
 *
 * This is gated by opts.isResearch at the call site; /loop never reaches it.
 */
async function routeResearchWorkspaceCommand(
	trimmed: string,
	ctx: ExtensionCommandContext,
	engine: LoopEngine,
	opts: LoopCommandOptions,
): Promise<void> {
	const projectRoot = ctx.cwd;
	const transitionsPath = path.join(projectRoot, "transitions.json");
	const [sub, ...rest] = trimmed.split(/\s+/);
	const slug = rest.join(" ").trim() || undefined;

	const resolveEntry = (): WorkspaceEntry | null => {
		if (slug) {
			const entry = lookupWorkspace(projectRoot, slug);
			if (!entry) {
				ctx.ui.notify(
					`No research workspace found for "${slug}". Use /research list to see retained workspaces.`,
					"warning",
				);
				return null;
			}
			return entry;
		}
		// No slug → active loop state's workingDir, then the transitions pointer.
		if (engine.state?.workingDir) {
			const byDir = lookupWorkspace(
				projectRoot,
				path.basename(engine.state.workingDir),
			);
			if (byDir) return byDir;
		}
		const active = getActiveWorkspace(projectRoot, transitionsPath);
		if (!active) {
			ctx.ui.notify(
				"No active research workspace. Start one with /research <mission> or pass a workspace slug.",
				"warning",
			);
			return null;
		}
		return active;
	};

	const toWorkspace = (entry: WorkspaceEntry): Workspace => ({
		path: entry.path,
		projectRoot,
		mission: entry.mission,
		runId: entry.runId,
		transitionId: entry.transitionId,
	});

	switch (sub) {
		case "list": {
			const result = listWorkspaces(projectRoot);
			if (result.entries.length === 0 && result.malformed.length === 0) {
				ctx.ui.notify(
					"No research workspaces found. Start one with /research <mission>.",
				"info",
			);
			return;
		}
			const lines: string[] = [];
			for (const e of result.entries) {
				const when = new Date(e.updatedAt)
					.toISOString()
					.slice(0, 16)
					.replace("T", " ");
				lines.push(
					`• ${path.basename(e.path)} — ${e.status} (${e.profile}) · ${when}${e.mission ? ` — ${truncate(e.mission)}` : ""}`,
				);
			}
			for (const m of result.malformed) {
				lines.push(`⚠ ${path.basename(m.path)} — malformed: ${m.reason}`);
			}
			ctx.ui.notify(lines.join("\n"), "info");
			return;
		}
		case "status": {
			const entry = resolveEntry();
			if (!entry) return;
			const lifecycle = getLifecycle(entry.path);
			ctx.ui.notify(
				[
					`Workspace: ${path.basename(entry.path)}`,
					`Status: ${lifecycle ?? "unknown"}`,
					`Run: ${entry.runId || "unknown"}`,
					entry.mission ? `Mission: ${truncate(entry.mission)}` : "",
				]
					.filter(Boolean)
					.join("\n"),
				"info",
			);
			return;
		}
		case "pause": {
			const entry = resolveEntry();
			if (!entry) return;
			try {
				const snapshot = pauseLifecycle(
					toWorkspace(entry),
					"paused via /research pause",
				);
				ctx.ui.notify(
					`Paused ${path.basename(entry.path)} — lifecycle: ${snapshot.current}.`,
					"info",
				);
			} catch (err) {
				ctx.ui.notify(
					`Cannot pause ${path.basename(entry.path)}: ${err instanceof Error ? err.message : String(err)}`,
					"warning",
				);
			}
			return;
		}
		case "clear": {
			const entry = resolveEntry();
			if (!entry) return;
			try {
				const snapshot = markAbandoned(
					toWorkspace(entry),
					"cleared via /research clear",
				);
				ctx.ui.notify(
					`Cleared ${path.basename(entry.path)} — lifecycle: ${snapshot.current}.`,
					"info",
				);
			} catch (err) {
				ctx.ui.notify(
					`Cannot clear ${path.basename(entry.path)}: ${err instanceof Error ? err.message : String(err)}`,
					"warning",
				);
			}
			return;
		}
		case "resume": {
			const entry = resolveEntry();
			if (!entry) return;
			if (!opts.onResumeDeps) {
				ctx.ui.notify(
					"Research resume engine not wired (missing onResumeDeps).",
					"error",
				);
				return;
			}
			const deps = opts.onResumeDeps(ctx);
			if (!deps) {
				ctx.ui.notify(
					"Research configuration not loaded — cannot resume.",
					"error",
				);
				return;
			}
			const sessionManager = (
				ctx as { sessionManager?: { getSessionId?: () => string } }
			).sessionManager;
			const sessionId =
				typeof sessionManager?.getSessionId === "function"
					? sessionManager.getSessionId()
					: "resume-session";
			try {
				const result = await resumeWorkspace(entry.path, deps, sessionId);
				if (!result.success) {
					ctx.ui.notify(
						`Cannot resume ${path.basename(entry.path)}: ${result.error} (${result.reason}).`,
						"warning",
					);
					return;
				}
				markResumed(result.workspace, "resumed via /research resume");
				ctx.ui.notify(
					`Resumed ${path.basename(entry.path)} — lease acquired, lifecycle active.`,
					"info",
				);
			} catch (err) {
				ctx.ui.notify(
					`Cannot resume ${path.basename(entry.path)}: ${err instanceof Error ? err.message : String(err)}`,
					"error",
				);
			}
			return;
		}
		default:
			// Not a research workspace subcommand — caller gates before invoking.
			return;
	}
}

/**
 * Generic argument parser (not strict — used by command handlers).
 * Returns flags (key→value) and the remaining mission text.
 */
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

/**
 * /research start path — routes through the research startup engine.
 *
 * Calls prepareAndActivateResearch (via the injected onResearchStart
 * handler) and drives the returned ActiveResearchPointer into the loop
 * engine as iteration 1. When the startup engine asks for confirmation
 * (CONTRACT_REQUIRES_CONFIRMATION), presents the contract to the user
 * and re-invokes with --yes semantics on approval.
 *
 * Returns false when the run was declined or startup failed (nothing
 * started — the previous run, if any, is left untouched).
 */
async function startResearchRun(
	engine: LoopEngine,
	ctx: ExtensionCommandContext,
	opts: {
		mission: string;
		programPath: string;
		maxRounds: number;
		tokenBudget: number | null;
		noProgressTurns: number;
		profile?: string;
		maxSearchesPerAgent: number;
		maxFetchesPerAgent: number;
		yes: boolean;
		onResearchStart?: ResearchStartHandler;
	},
): Promise<boolean> {
	if (!opts.onResearchStart) {
		ctx.ui.notify(
			"Research startup engine not wired (missing onResearchStart).",
			"error",
		);
		return false;
	}

	const request: ResearchStartRequest = {
		mission: opts.mission,
		profile: "standard",
		programPath: opts.programPath,
		profileOverride: opts.profile ?? null,
		yes: opts.yes,
	};

	const activate = async (yes: boolean): Promise<ActiveResearchPointer> =>
		opts.onResearchStart!({ ...request, yes }, ctx);

	let pointer: ActiveResearchPointer;
	try {
		pointer = await activate(opts.yes);
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (!message.startsWith("CONTRACT_REQUIRES_CONFIRMATION")) {
			ctx.ui.notify(`Research startup failed: ${message}`, "error");
			return false;
		}
		const display = message
			.slice("CONTRACT_REQUIRES_CONFIRMATION:".length)
			.trim();
		const approved = await ctx.ui.confirm("Start deep research?", display);
		if (!approved) return false;
		try {
			pointer = await activate(true);
		} catch (err2) {
			ctx.ui.notify(
				`Research startup failed: ${err2 instanceof Error ? err2.message : String(err2)}`,
				"error",
			);
			return false;
		}
	}

	// Drive the activated research pointer into the loop engine as iteration 1.
	const newLoop = engine.startState({
		commandName: "research",
		programPath: opts.programPath,
		mission: opts.mission,
		maxRounds: opts.maxRounds,
		tokenBudget: opts.tokenBudget,
		noProgressTurns: opts.noProgressTurns,
	});
	engine.state = {
		...newLoop,
		id: pointer.contract.runId,
		guardId: pointer.contract.runId,
		profile: pointer.contract.profile,
		workingDir: pointer.workspace.path,
		maxSearchesPerAgent: opts.maxSearchesPerAgent,
		maxFetchesPerAgent: opts.maxFetchesPerAgent,
	};
	return true;
}
