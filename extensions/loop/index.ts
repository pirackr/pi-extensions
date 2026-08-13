/**
 * pi-loop extension — thin wiring layer.
 *
 * Core loop mechanics live in engine.ts, state in state.ts, program helpers
 * in program.ts, completion policy in completion.ts, and command registration
 * in command.ts. This file wires them together and adds research-specific
 * tools (research_checkpoint, complete_loop research gates).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { countUniqueSourceUrls, effectiveSourceCount } from "./sources.ts";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadPackagedConfig } from "../research/config.ts";
import {
  verificationDefinitions,
  getProfileVerifications,
  getVerificationDefinition,
} from "../research/verification.ts";
import { parseScoreTable } from "../research/checkpoint.ts";
import { LoopEngine, LoopEngineOptions } from "./engine.ts";
import { registerLoopCommand } from "./command.ts";
import {
	prepareAndActivateResearch,
	TransitionsFile,
} from "../research/startup.ts";
import type {
	ModelRegistryView,
	ProviderRegistryView,
	ResearchStartRequest,
	StartupDependencies,
} from "../research/startup.ts";
import {
	acquireWorkspaceClaim,
	prepareStaging,
	commitStaging,
	reconcileTransition,
	ensureGitExclude,
} from "../research/workspace.ts";
import { newRunState, acquireLease } from "../research/state.ts";
import { createRunManifest } from "../research/manifest.ts";
import { ResearchPolicy } from "../research/policy.ts";
import { evaluateCheckpoint } from "../research/checkpoint.ts";
import { runVerification } from "../research/verification.ts";
import type { ProviderDescriptor } from "../subagent-dispatch/contract.ts";
import type { ResolvedResearchConfig } from "../research/config.ts";
import {
	LoopState,
	LoopStatus,
	LoopUsage,
	CompletionFailure,
	CompletionPolicy,
	normalizeState,
	addCoordinatorUsage,
	addNestedUsage,
} from "./state.ts";
import { makeGenericPolicy } from "./completion.ts";
import { programBlockFor } from "./program.ts";

const CUSTOM_TYPE = "pi-loop";
const EVENT_TYPE = "pi-loop-event";
const DEFAULT_MAX_ROUNDS = 10;

// Bundled deep-research program — the default program for /research.
const RESEARCH_PROGRAM_PATH = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../skills/deep-research/program.v2.md",
);

// --- Research configuration (loaded once at init time) ----------------------

/**
 * Research config shape for the completion policy.
 * Derived from the ResolvedResearchConfig packaged config.
 */
interface ResearchConfigShape {
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
			maxRounds: number | null;
			minSources: number;
			maxScouts: number;
			maxFetchers: number;
			verification: string[];
		}
	>;
}
let researchConfig: ResearchConfigShape | null = null;
let resolvedResearchConfig: ResolvedResearchConfig | null = null;

// --- Research-specific completion policy -----------------------------------

/**
 * Research completion policy: validates checkpoint evidence, report.org,
 * and verification artifacts against code-enforced thresholds.
 * Used by /research; the generic /loop uses makeGenericPolicy (no gates).
 */
class ResearchCompletionPolicy implements CompletionPolicy {
	private config: ResearchConfigShape;
	private workingDir: string;
	private loopId: string;
	private profile: string;

	constructor(
		config: ResearchConfigShape,
		state: Readonly<LoopState>,
	) {
		this.config = config;
		this.workingDir = state.workingDir!;
		this.loopId = state.id;
		this.profile = state.profile ?? "standard";
	}

	async audit(state: Readonly<LoopState>): Promise<CompletionFailure[]> {
		const failures: CompletionFailure[] = [];

		// Gate 1: valid checkpoint evidence
		const ce = state.checkpointEvidence;
		if (!ce) {
			failures.push({ code: "checkpoint", message: "missing (no evidence recorded)" });
		} else if (ce.runId !== state.id) {
			failures.push({ code: "checkpoint", message: `stale (run ${ce.runId}, expected ${state.id})` });
		} else if (ce.round < 1) {
			failures.push({ code: "checkpoint", message: `invalid round ${ce.round} (must be >= 1)` });
		} else if (ce.verdict !== "PROCEED" && ce.verdict !== "PROCEED_WITH_GAPS") {
			failures.push({ code: "checkpoint", message: `verdict is '${ce.verdict}' (need PROCEED or PROCEED_WITH_GAPS)` });
		}

		// Gate 2: report.org exists and is non-empty
		if (!this.workingDir) {
			failures.push({ code: "report", message: "no workingDir (report.org cannot be found)" });
		} else {
			const reportPath = path.join(this.workingDir, "report.org");
			let reportExists = false;
			try {
				const stat = fs.statSync(reportPath);
				reportExists = stat.isFile();
				if (reportExists) {
					const content = fs.readFileSync(reportPath, "utf8");
					if (content.trim().length === 0) {
						failures.push({ code: "report", message: "report.org is empty" });
					}
				}
			} catch {
				failures.push({ code: "report", message: "report.org missing" });
			}
		}

		// Gate 3: verification artifacts
		const profileCfg = this.config.profiles[this.profile];
		const requiredAgents = profileCfg?.verification ?? [];

		for (const agentName of requiredAgents) {
			const def = getVerificationDefinition(agentName);
			if (!def) {
				failures.push({ code: "verification", message: `unknown agent '${agentName}'` });
				continue;
			}
			// artifact path from definition's outputPath
			const fileName = path.basename(def.outputPath);
			if (!this.workingDir) {
				failures.push({ code: "verification", message: `${fileName} missing (no workingDir)` });
				continue;
			}
			const filePath = path.join(this.workingDir, "verification", fileName);
			try {
				let artifactResult: unknown;
				let artifactPass = false;
				try {
					const content = fs.readFileSync(filePath, "utf8");
					artifactResult = JSON.parse(content);
					// Use the definition's pass predicate
					artifactPass = def.passPredicate(artifactResult);
				} catch (readErr) {
					const msg = readErr instanceof Error ? readErr.message : String(readErr);
					failures.push({ code: "verification", message: `${fileName} read error — ${msg}` });
					continue;
				}
				// Check runId if present in artifact
				const artifactRunId = (artifactResult as Record<string, unknown>)?.runId as string | undefined;
				if (artifactRunId && artifactRunId !== state.id) {
					failures.push({ code: "verification", message: `${fileName} runId mismatch (${artifactRunId} ≠ ${state.id})` });
				} else if (!artifactPass) {
					failures.push({ code: "verification", message: `${fileName} failed (pass predicate false)` });
				}
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				failures.push({ code: "verification", message: `${fileName} malformed — ${msg}` });
			}
		}

		return failures;
	}
}

// --- Reusable tool execute functions (avoids duplication in registration) --

function makeCompleteLoopExecute(
	pi: ExtensionAPI,
	engine: LoopEngine,
	researchConfig: ResearchConfigShape | null,
) {
	return async (
		_toolCallId: string,
		params: unknown,
		_signal: AbortSignal,
		_onUpdate: () => void,
		ctx: ExtensionContext,
	): Promise<{ content?: { type: string; text: string }[]; isError?: boolean; details?: unknown }> => {
		const p = params as { status?: string; guardId?: string };
		if (p.status !== "complete") {
			return {
				content: [
					{ type: "text", text: "complete_loop only accepts status=complete." },
				],
				isError: true,
			};
		}
		if (!engine.state || engine.state.status !== "active") {
			return { content: [{ type: "text", text: "No active loop." }], isError: true };
		}
		if (p.guardId != null && p.guardId !== engine.state.guardId) {
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

		// Research-specific completion gates
		if (engine.state.commandName === "research") {
			if (!researchConfig) {
				return {
					content: [
						{
							type: "text",
							text: "No research config loaded — cannot enforce verification gates.",
						},
					],
					isError: true,
				};
			}
			const policy = new ResearchCompletionPolicy(
				researchConfig,
				engine.state,
			);
			const failures = await policy.audit(engine.state);
			if (failures.length > 0) {
				return {
					content: [
						{
							type: "text",
							text: "Research completion gates not met:\n" +
								failures.map((f) => `  • ${f.code}: ${f.message}`).join("\n"),
						},
					],
					isError: true,
				};
			}
		}

		const completed = engine.completeState();
		engine.persist(pi, ctx);
		engine.emit(pi, "complete", "steer");
		return {
			content: [{ type: "text", text: JSON.stringify({ loop: completed }, null, 2) }],
			details: { loop: completed },
		};
	};
}

function makeResearchCheckpointExecute(
	pi: ExtensionAPI,
	engine: LoopEngine,
	researchConfig: ResearchConfigShape | null,
) {
	return async (
		_toolCallId: string,
		params: unknown,
		_signal: AbortSignal,
		_onUpdate: () => void,
		ctx: ExtensionContext,
	): Promise<{ content?: { type: string; text: string }[]; isError?: boolean }> => {
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
		if (round < 1) {
			return {
				content: [
					{
						type: "text",
						text: "Round 0 is planning only — do not checkpoint before round 1.",
					},
				],
				isError: true,
			};
		}
		const reported = p.totalSources ?? 0;
		const counted = countNotesSources(engine.state?.workingDir);
		const { sources, hint } = effectiveSourceCount(reported, counted);

		let scoreState = { satisfied: true, belowThreshold: [] as string[] };
		const scoreThreshold = researchConfig?.defaults.scoreThreshold ?? 80;
		if (engine.state?.workingDir) {
			const scorePath = path.join(engine.state.workingDir, "score.md");
			if (!fs.existsSync(scorePath)) {
				return {
					content: [
						{
							type: "text",
							text: `🔴 CONTINUE — score.md not found at ${scorePath}. Create it with the required table (5–8 unique IDs, integer scores 0–100) and re-run.`,
						},
					],
				};
			}
			try {
				const parsed = parseScoreTable(fs.readFileSync(scorePath, "utf8"));
				const below: string[] = [];
				for (const row of parsed) {
					if (row.score < scoreThreshold) {
						below.push(row.id);
					}
				}
				scoreState = { satisfied: below.length === 0, belowThreshold: below };
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				return {
					content: [
						{
							type: "text",
							text: `🔴 CONTINUE — score.md malformed: ${msg} — repair it and re-run.`,
						},
					],
				};
			}
		}

		const issues: string[] = [];
		if (round < profileCfg.minRounds) {
			issues.push(`⛔ min rounds: ${round}/${profileCfg.minRounds}`);
		}
		if (sources < profileCfg.minSources) {
			issues.push(`⛔ min sources: ${sources}/${profileCfg.minSources}`);
		}
		if (!scoreState.satisfied) {
			issues.push(
				`⛔ score threshold (${scoreThreshold}): ${scoreState.belowThreshold.join(", ")}`,
			);
		}

		const effectiveMax = engine.state?.maxRounds ?? profileCfg.maxRounds;
		if (round >= effectiveMax) {
			const verdict = issues.length > 0 ? "PROCEED_WITH_GAPS" : "PROCEED";
			const verdictText =
				verdict === "PROCEED_WITH_GAPS"
					? `🟢 PROCEED_WITH_GAPS — max rounds reached with ${issues.length} gap(s): ${issues.join("; ")}${hint}`
					: `🟢 PROCEED — criteria met.${hint}`;
			if (engine.state) {
				engine.state = {
					...engine.state,
					checkpointEvidence: {
						runId: engine.state.id,
						round,
						sources,
						scoreState,
						verdict,
					},
					updatedAt: Date.now(),
				};
				engine.persist(pi, ctx);
			}
			return { content: [{ type: "text", text: verdictText }] };
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
		if (engine.state) {
			engine.state = {
				...engine.state,
				checkpointEvidence: {
					runId: engine.state.id,
					round,
					sources,
					scoreState,
					verdict: "PROCEED",
				},
				updatedAt: Date.now(),
			};
			engine.persist(pi, ctx);
		}
		return {
			content: [
				{
					type: "text",
					text: `🟢 PROCEED — criteria met.${hint}`,
				},
			],
		};
	};
}

// --- helpers ---------------------------------------------------------------

// Count unique source URLs from notes.md (research only)
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

// --- Extension entrypoint ---------------------------------------------------

export default function piLoop(pi: ExtensionAPI) {
	// Load research configuration once at init time.
	try {
		const loaded = loadPackagedConfig();
		resolvedResearchConfig = loaded;
		researchConfig = {
			defaults: {
				maxSearchesPerAgent: loaded.defaults.maxSearches ?? 0,
				maxFetchesPerAgent: loaded.defaults.maxFetches ?? 0,
				scoreThreshold: loaded.defaults.scoreThreshold,
				retryCount: loaded.defaults.retryCount,
			},
			profiles: loaded.profiles,
		};
	} catch {
		researchConfig = null;
	}

	// --- Create the generic loop engine -----------------------------------
	const engine = new LoopEngine({
		completionPolicy: makeGenericPolicy(),
		onStateChange: async (state) => {
			// onStateChange is called via engine.persist() which appends the
			// entry. This hook exists for future use (e.g. metrics, logging).
		},
		onRoundIncrement: (state: LoopState): LoopState => {
			// Research-specific: invalidate checkpoint evidence on a new round.
			// Generic engine has no knowledge of research — this callback
			// is the bridge.
			if (state.commandName === "research") {
				return { ...state, checkpointEvidence: undefined };
			}
			return state;
		},
	});

	// --- Register /loop command (generic) --------------------------------
	registerLoopCommand(pi, {
		command: "loop",
		description:
			"Run an autonomous loop driven by a program file until its completion condition is met or budgets are hit.",
		defaultProgram: "program.md",
		defaultMaxRounds: DEFAULT_MAX_ROUNDS,
	}, engine);

	// --- Register /research command (deep research) ----------------------
	registerLoopCommand(pi, {
		command: "research",
		description:
			"Deep research: run the bundled research program (program.v2.md) as an autonomous loop — searches, fetches sources, and compiles report.org (claim-level citations) into a retained per-run workspace under the project root.",
		defaultProgram: RESEARCH_PROGRAM_PATH,
		defaultMaxRounds: researchConfig?.profiles.standard?.maxRounds ?? 8,
		isResearch: true,
		config: researchConfig ?? undefined,
		onResearchStart: async (request: ResearchStartRequest, ctx) => {
			if (!resolvedResearchConfig) {
				throw new Error(
					"Research configuration not loaded — cannot start research.",
				);
			}
			return prepareAndActivateResearch(
				request,
				buildResearchDeps(ctx, resolvedResearchConfig),
			);
		},
	}, engine);

	// --- Register complete_loop tool -------------------------------------
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
		execute: makeCompleteLoopExecute(pi, engine, researchConfig),
	});

	// --- Register research_checkpoint tool -------------------------------
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
		execute: makeResearchCheckpointExecute(pi, engine, researchConfig),
	});

	// --- Event handlers --------------------------------------------------

	let continuationTurnPending = false;

	pi.on("session_start", (event, ctx) => {
		let restored = engine.latestState(ctx);
		if (restored) restored = normalizeState(restored);
		engine.state = restored;
		continuationTurnPending = false;
		syncLoopTools(pi, engine);
		updateStatus(ctx, engine);
		const reason = (event as { reason?: string }).reason;
		if (restored?.status === "active" && reason === "reload") {
			engine.state = { ...restored, status: "paused" as LoopStatus, updatedAt: Date.now() };
			engine.persist(pi, ctx);
			ctx.ui.notify(
				`⏸ Loop paused after reload: ${truncate(restored.mission)}\n/${restored.commandName} resume to continue · /${restored.commandName} clear to stop`,
				"info",
			);
			return;
		}
		if (restored?.status === "active") {
			ctx.ui.notify(
				`⏳ Loop restored: ${truncate(restored.mission)}\n/${restored.commandName} pause to stop continuation · /${restored.commandName} clear to remove`,
				"info",
			);
		}
	});

	pi.on("turn_start", () => {
		engine.startTurn();
	});

	pi.on("turn_end", async (event, ctx) => {
		await engine.endTurn(pi, ctx, event);
	});

	pi.on("agent_end", (_event, ctx) => {
		engine.onAgentEnd(pi, ctx);
	});
}

// --- helpers used by event handlers ----------------------------------------

function statusLine(engine: LoopEngine): string {
	return engine.getStatusLine();
}

function updateStatus(ctx: ExtensionContext, engine: LoopEngine): void {
	ctx.ui.setStatus("pi-loop", statusLine(engine) ?? "");
}

function syncLoopTools(pi: ExtensionAPI, engine: LoopEngine): void {
	const active = new Set(pi.getActiveTools());
	if (engine.state?.status === "active") active.add("complete_loop");
	else active.delete("complete_loop");
	pi.setActiveTools(Array.from(active));
}

// Re-exported for test compatibility
export { programBlockFor };

// --- Research startup engine wiring (Task 10) ------------------------------
//
// buildResearchDeps injects the runtime StartupDependencies into
// prepareAndActivateResearch. Model/provider views wrap Pi's live registries;
// the workspace/state/manifest/transitions/policy/checkpoint/verification
// deps are the real research modules. No research config code imports Pi —
// deps are injected at the wiring layer.

function buildResearchDeps(
	ctx: ExtensionContext,
	config: ResolvedResearchConfig,
): StartupDependencies {
	// Transitions file lives at the project root so retained research
	// workspaces are created alongside it (discoverable by /research list).
	const transitionsPath = path.join(ctx.cwd, "transitions.json");
	const transitions = new TransitionsFile(transitionsPath);
	const tools = researchRequiredTools(config);
	return {
		config,
		getModels: () => buildModelView(ctx),
		getProviders: () => buildProviderView(ctx, config, tools),
		workspace: {
			acquireWorkspaceClaim,
			prepareStaging,
			commitStaging,
			reconcileTransition,
			ensureGitExclude,
		},
		state: {
			newRunState,
			acquireLease,
		},
		manifest: {
			createRunManifest,
		},
		transitions,
		policy: {
			createPolicy: (ws, frozenConfig, hardTimeoutSeconds) =>
				new ResearchPolicy(ws, frozenConfig, hardTimeoutSeconds),
		},
		checkpoint: {
			evaluateCheckpoint,
		},
		verification: {
			runVerification,
		},
		logger: {
			log: (message) => ctx.ui.notify(message, "info"),
		},
	};
}

/** Union of every tool the research config requires (roles + capabilities). */
function researchRequiredTools(config: ResolvedResearchConfig): string[] {
	const tools = new Set<string>();
	for (const role of Object.values(config.roles)) {
		for (const tool of role.tools) tools.add(tool);
	}
	for (const capability of Object.values(config.capabilities)) {
		for (const tool of capability.requiredTools) tools.add(tool);
	}
	return Array.from(tools);
}

/**
 * Research role aliases (strong/eval/light) → concrete model names, from the
 * packaged tmux-subagent models map. Best-effort: falls back to matching the
 * alias directly against Pi's model names/ids.
 */
function researchModelAliases(): Record<string, string> {
	try {
		const configPath = path.resolve(
			path.dirname(fileURLToPath(import.meta.url)),
			"../../config/tmux-subagent.json",
		);
		const raw = JSON.parse(fs.readFileSync(configPath, "utf8")) as {
			models?: Record<string, string>;
		};
		return raw.models ?? {};
	} catch {
		return {};
	}
}

/**
 * Model registry view over Pi's live model registry. Roles reference model
 * aliases (strong/eval/light); the view resolves them against model name or
 * id (and against the packaged tmux-subagent alias map when available).
 */
function buildModelView(ctx: ExtensionContext): ModelRegistryView {
	const all = ctx.modelRegistry.getAll();
	const aliases = researchModelAliases();
	const match = (m: (typeof all)[number], name: string): boolean =>
		m.name === name || m.id === name || m.id.endsWith(`/${name}`);
	const find = (name: string) => {
		const direct = all.find((m) => match(m, name));
		if (direct) return direct;
		const concrete = aliases[name];
		return concrete ? all.find((m) => match(m, concrete)) : undefined;
	};
	return {
		get(name) {
			const model = find(name);
			return model
				? {
						id: model.id,
						name: model.name,
						provider: model.provider,
						capabilities: [
							...(model.input.includes("image") ? ["image"] : []),
							...(model.reasoning ? ["reasoning"] : []),
						],
					}
				: undefined;
		},
		has(name) {
			return find(name) !== undefined;
		},
	};
}

/**
 * Provider registry view over Pi's registered providers plus the research
 * child extensions (which supply the research tool capabilities).
 */
function buildProviderView(
	ctx: ExtensionContext,
	config: ResolvedResearchConfig,
	tools: string[],
): ProviderRegistryView {
	const providers = new Map<string, ProviderDescriptor>();
	// Child extensions (web-search, tmux-subagent) supply the research tools.
	for (const child of config.childExtensions) {
		providers.set(child, {
			id: child,
			adapterVersion: "1.0",
			capabilities: tools,
		});
	}
	// Pi's registered model providers.
	for (const id of ctx.modelRegistry.getRegisteredProviderIds()) {
		providers.set(id, {
			id,
			adapterVersion: "1.0",
			capabilities: tools,
		});
	}
	return {
		get: (id) => providers.get(id),
		has: (id) => providers.has(id),
		getAll: () => Array.from(providers.values()),
	};
}
