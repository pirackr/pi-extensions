/**
 * Command registration: /loop and /research (thin wrappers that use the
 * generic engine for core loop mechanics and defer to research-specific
 * logic where needed).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LoopEngine } from "./engine.ts";
import type { LoopState, LoopStatus } from "./state.ts";
import { truncate } from "./program.ts";

export interface LoopCommandOptions {
	command: "loop" | "research";
	description: string;
	defaultProgram: string;
	defaultMaxRounds: number;
	isResearch?: boolean;
	config?: unknown; // ResearchConfigShape — kept as unknown to keep this file generic
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
				// research: clear active budgets
				if (opts.isResearch) {
					try {
						const { clearActiveResearchBudgets } = await import(
							"../deep-research/session.ts"
						);
						clearActiveResearchBudgets();
					} catch {
						/* ignore */
					}
				}
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

			// Research: create working dir
			const workingDir = opts.isResearch
				? createResearchWorkingDir(ctx.cwd, mission)
				: undefined;

			// Create new state via engine
			const newLoop = engine.startState({
				commandName: cmd,
				programPath,
				mission,
				maxRounds,
				tokenBudget,
				noProgressTurns,
			});
			// Research-specific fields
			if (opts.isResearch) {
				engine.state = {
					...newLoop,
					profile,
					workingDir,
					maxSearchesPerAgent,
					maxFetchesPerAgent,
				};
			}

			// Research: plan approval gate
			if (opts.isResearch && (opts.config as { profiles?: Record<string, unknown> })?.profiles) {
				const yesFlag =
					flags["yes"] !== undefined || flags["no-confirm"] !== undefined;
				if (!yesFlag && ctx.ui?.confirm) {
					const p = (engine.state as LoopState).profile ?? "standard";
					const profileCfg = (opts.config as {
						profiles?: Record<string, { minRounds: number; maxRounds: number; minSources: number; maxScouts: number; maxFetchers: number; verification: string[] }>;
					}).profiles?.[p];
					const planSummary = `🔬 Deep research: "${truncate(mission)}"\nProfile: ${p}\nRounds: ${profileCfg?.minRounds ?? 3}–${profileCfg?.maxRounds ?? 10} · Min sources: ${profileCfg?.minSources ?? 15}\nScouts: ${profileCfg?.maxScouts ?? 3} · Fetchers: ${profileCfg?.maxFetchers ?? 1}\nSearches/agent: ${maxSearchesPerAgent} · Fetches/agent: ${maxFetchesPerAgent}\nVerification: ${(profileCfg?.verification ?? ["judge"]).join(", ")}\nTokens: ${engine.state!.tokenBudget ?? "none"}\nOutput: ${engine.state!.workingDir ?? "n/a"}\n\nSub-questions and search strategy will be defined in Round 0. Do you want to proceed?`;
					const approved = await ctx.ui.confirm(
						"Start deep research?",
						planSummary,
					);
					if (!approved) {
						// Cancel: restore prior run
						engine.state = previous;
						engine.persist(pi, ctx);
						if (
							previous &&
							previous.status === "active" &&
							ctx.isIdle()
						) {
							// Continuation will be queued by agent_end handler
						}
						return;
					}
				}
				// Set active research budget
				if (opts.isResearch) {
					try {
						const { setActiveResearchBudgets } = await import(
							"../deep-research/session.ts"
						);
						setActiveResearchBudgets(maxSearchesPerAgent, maxFetchesPerAgent);
					} catch {
						/* ignore */
					}
				}
			}

			engine.persist(pi, ctx);
			engine.emit(pi, "active", ctx.isIdle() ? "steer" : undefined);
		},
	});
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
 * /research scratch workspace: /tmp/<project>/research/<id>-<slug>/
 */
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
