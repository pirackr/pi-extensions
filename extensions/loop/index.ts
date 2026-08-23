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
import type {
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { loadPackagedConfig } from "../research/config.ts";
import {
	parseScoreTable,
	computeEvidenceDigest,
} from "../research/checkpoint.ts";
import { pauseLifecycle } from "../research/lifecycle.ts";
import { LoopEngine } from "./engine.ts";
import { registerLoopCommand } from "./command.ts";
import {
	prepareAndActivateResearch,
	TransitionsFile,
} from "../research/startup.ts";
import type {
	ModelRegistryView,
	ResearchStartRequest,
	ResolvedRunContract,
	StartupDependencies,
} from "../research/startup.ts";
import {
	acquireWorkspaceClaim,
	prepareStaging,
	commitStaging,
	reconcileTransition,
	ensureGitExclude,
	type Workspace,
} from "../research/workspace.ts";
import {
	newRunState,
	acquireLease,
	readRunState,
	updateRunState,
	type StateConflict,
} from "../research/state.ts";
import {
	researchCompletionGate,
	finalizeSuccess,
} from "../research/completion.ts";
import { createRunManifest } from "../research/manifest.ts";
import { ResearchPolicy, type FrozenConfig } from "../research/policy.ts";
import { evaluateCheckpoint } from "../research/checkpoint.ts";
import { runVerification } from "../research/verification.ts";
import { registerResearchSubagentIntegration } from "../research/subagent.ts";
import type { ResolvedResearchConfig } from "../research/config.ts";
import type { ProfileContribution } from "../subagent/types.ts";
import { type LoopState, type LoopStatus, normalizeState } from "./state.ts";
import { makeGenericPolicy } from "./completion.ts";
import { programBlockFor, truncate } from "./program.ts";

const DEFAULT_MAX_ROUNDS = 10;

// Bundled research program — the default program for /research. Resolved
// from this module's location so it works regardless of cwd.
const RESEARCH_PROGRAM_PATH = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"../../skills/research/program.md",
);

// --- Research configuration (loaded once at init time) ----------------------

/**
 * Research config shape (used by the legacy research_checkpoint tool;
 * completion gates now read from the retained workspace on disk).
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

const researchDiscoveryRegistered = new WeakSet<object>();

function freezeContribution(profile: {
	name: string;
	description: string;
	model: string;
	thinking: "minimal" | "low" | "medium" | "high";
	tools: readonly string[];
	access: "read" | "write";
	timeoutSeconds: number;
	systemPrompt: string;
}): ProfileContribution {
	return Object.freeze({
		owner: "research",
		profile: Object.freeze({
			...profile,
			tools: Object.freeze([...profile.tools]) as unknown as string[],
			source: "research",
		}),
	});
}

function resolveResearchProfiles(
	config: ResolvedResearchConfig,
): readonly ProfileContribution[] {
	return Object.freeze(
		Object.entries(config.roles).map(([name, role]) => {
			const systemPrompt = fs.readFileSync(role.promptPath, "utf8");
			if (!systemPrompt.trim()) {
				throw new Error(`Research role '${name}' has an empty prompt.`);
			}
			return freezeContribution({
				name,
				description: role.description,
				model: config.models[role.model] ?? role.model,
				thinking: role.thinking,
				tools: role.tools,
				access: role.access,
				timeoutSeconds: role.timeoutSeconds,
				systemPrompt,
			});
		}),
	);
}

function contributionsFromContract(
	contract: ResolvedRunContract,
): readonly ProfileContribution[] {
	return Object.freeze(
		Object.values(contract.resolvedProfiles).map((profile) =>
			freezeContribution(profile),
		),
	);
}

function registerResearchProfileDiscovery(
	pi: ExtensionAPI,
	getContributions: () => readonly ProfileContribution[],
): void {
	const events = (pi as ExtensionAPI & {
		events?: { on?: (channel: string, handler: (data: unknown) => void) => void };
	}).events;
	if (!events?.on || researchDiscoveryRegistered.has(pi as object)) return;
	researchDiscoveryRegistered.add(pi as object);
	events.on("subagent:discover-profiles", (envelope: unknown) => {
		if (!envelope || typeof envelope !== "object") return;
		const contributions = (envelope as { contributions?: ProfileContribution[] }).contributions;
		if (!Array.isArray(contributions)) return;
		const existing = new Set(
			contributions.map((entry) => `${entry.owner}\u0000${entry.profile.name}`),
		);
		for (const contribution of getContributions()) {
			const key = `${contribution.owner}\u0000${contribution.profile.name}`;
			if (!existing.has(key)) {
				contributions.push(contribution);
				existing.add(key);
			}
		}
	});
}

// --- Reusable tool execute functions (avoids duplication in registration) --

function makeCompleteLoopExecute(pi: ExtensionAPI, engine: LoopEngine) {
	return async (
		_toolCallId: string,
		params: unknown,
		_signal: AbortSignal | undefined,
		_onUpdate:
			| ((update: {
					content: { type: string; text: string }[];
					details?: unknown;
			  }) => void)
			| undefined,
		ctx: ExtensionContext,
	): Promise<{
		content: { type: string; text: string }[];
		isError?: boolean;
		details?: unknown;
	}> => {
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
			return {
				content: [{ type: "text", text: "No active loop." }],
				isError: true,
			};
		}
		if (p.guardId != null && p.guardId !== engine.state.guardId) {
			return {
				content: [
					{
						type: "text",
						text:
							"Stale complete_loop call: the loop's guard rotated (paused/resumed) since this turn started. Re-audit the current loop state before completing.",
					},
				],
				isError: true,
			};
		}

		// Research-specific completion gates — audit the retained workspace on
		// disk (never the in-memory LoopState). Typed failures leave the loop
		// active; a clean audit finalizes the run transactionally.
		if (engine.state.commandName === "research") {
			const workingDir = engine.state.workingDir;
			if (!workingDir) {
				return {
					content: [
						{
							type: "text",
							text:
								"No research workspace (workingDir) — cannot enforce completion gates.",
						},
					],
					isError: true,
				};
			}
			const ws: Workspace = {
				path: workingDir,
				projectRoot: path.dirname(workingDir),
				mission: engine.state.mission,
				runId: "", // filled from the authoritative disk state below
				transitionId: "",
			};
			let expectedRevision = -1;
			try {
				const diskState = readRunState(ws);
				ws.runId = diskState.runId;
				expectedRevision = diskState.revision;
			} catch {
				// Unreadable run-state — the gate below reports the precise failure.
			}

			const failures = await researchCompletionGate(ws);
			if (failures.length > 0) {
				return {
					content: [
						{
							type: "text",
							text:
								"Research completion gates not met:\n" +
								failures.map((f) => `  • ${f.code}: ${f.message}`).join("\n"),
						},
					],
					isError: true,
				};
			}

			// All gates pass — record the final outcome + digests in one
			// transactional state write. A stale revision (concurrent write since
			// the audit) re-audits instead of blind-retrying.
			try {
				const outcome = readRunState(ws).checkpointVerdict ?? "PROCEED";
				await finalizeSuccess(ws, expectedRevision, outcome);
			} catch (err) {
				const conflict = err as Partial<StateConflict> | null;
				const isConflict =
					conflict != null &&
					typeof conflict === "object" &&
					typeof conflict.expected === "number" &&
					typeof conflict.actual === "number";
				return {
					content: [
						{
							type: "text",
							text: isConflict
								? "Research state changed during the completion audit — re-audit the gates and retry."
								: `Research completion finalize failed: ${err instanceof Error ? err.message : String(err)}`,
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
			content: [
				{ type: "text", text: JSON.stringify({ loop: completed }, null, 2) },
			],
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
		_signal: AbortSignal | undefined,
		_onUpdate:
			| ((update: {
					content: { type: string; text: string }[];
					details?: unknown;
			  }) => void)
			| undefined,
		ctx: ExtensionContext,
	): Promise<{
		content: { type: string; text: string }[];
		isError?: boolean;
	}> => {
		const p = params as {
			profile?: string;
			round?: number;
			totalSources?: number;
			contradictions?: string[];
		};
		// Only meaningful inside an active /research run (the loop wires
		// workingDir). Guard at execution too, so a stray call outside a
		// user-started research loop can never drive research behavior.
		if (engine.state?.commandName !== "research") {
			return {
				content: [
					{
						type: "text",
						text:
							"No active research run — research_checkpoint is only usable during a /research run the user started.",
					},
				],
				isError: true,
			};
		}
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
		// null maxRounds = open-ended profile (no cap) — never treat as reached.
		let verdict: "PROCEED" | "PROCEED_WITH_GAPS" | "CONTINUE";
		if (effectiveMax !== null && round >= effectiveMax) {
			verdict = issues.length > 0 ? "PROCEED_WITH_GAPS" : "PROCEED";
		} else if (issues.length > 0) {
			verdict = "CONTINUE";
		} else {
			verdict = "PROCEED";
		}

		// Persist the verdict + evidence digest to the retained workspace on disk
		// so the complete_loop completion gate (which audits run-state.json) sees
		// this checkpoint. Without this write, run-state.json keeps its initial
		// CONTINUE verdict and the gate rejects completion as "missing evidence".
		await persistCheckpointEvidence(
			engine,
			profile,
			round,
			sources,
			verdict,
			issues,
		);

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

		if (verdict === "PROCEED_WITH_GAPS") {
			return {
				content: [
					{
						type: "text",
						text: `🟢 PROCEED_WITH_GAPS — max rounds reached with ${issues.length} gap(s): ${issues.join("; ")}${hint}`,
					},
				],
			};
		}
		if (verdict === "CONTINUE") {
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

// Persist a checkpoint verdict + evidence digest to the retained workspace's
// run-state.json. The complete_loop gate audits that file (not the in-memory
// LoopState), so without this write the gate sees the initial CONTINUE verdict
// and rejects completion as "missing evidence".
async function persistCheckpointEvidence(
	engine: LoopEngine,
	profile: string,
	round: number,
	sources: number,
	verdict: "PROCEED" | "PROCEED_WITH_GAPS" | "CONTINUE",
	unmet: string[],
): Promise<void> {
	const workingDir = engine.state?.workingDir;
	if (!workingDir) return;
	const ws: Workspace = {
		path: workingDir,
		projectRoot: path.dirname(workingDir),
		mission: engine.state?.mission ?? "",
		runId: engine.state?.id ?? "",
		transitionId: "",
	};
	try {
		const state = readRunState(ws);
		ws.runId = state.runId;
		const scorePath = path.join(workingDir, "score.md");
		const notesPath = path.join(workingDir, "notes.md");
		const scoreContent = fs.existsSync(scorePath)
			? fs.readFileSync(scorePath, "utf8")
			: "";
		const notesContent = fs.existsSync(notesPath)
			? fs.readFileSync(notesPath, "utf8")
			: "";
		const digest = computeEvidenceDigest(scoreContent, notesContent);
		await updateRunState(ws, state.revision, (current) => ({
			...current,
			researchRound: round,
			checkpointVerdict: verdict,
			checkpointDigest: digest,
			checkpointUnmet: unmet,
			checkpointUniqueSources: sources,
			loopIteration: round,
			checkpointProfile: profile,
		}));
	} catch {
		// Best-effort: the completion gate will report the precise failure if the
		// checkpoint could not be persisted. Never fail the checkpoint tool itself.
	}
}

// --- Extension entrypoint ---------------------------------------------------

export default function piLoop(pi: ExtensionAPI) {
	let researchConfig: ResearchConfigShape | null = null;
	let resolvedResearchConfig: ResolvedResearchConfig | null = null;
	let researchProfiles: readonly ProfileContribution[] = [];

	// Load research configuration and freeze pre-activation discovery snapshots
	// once at init time. Activation/resume replaces them with the validated
	// contract snapshots rather than re-reading mutable prompt sources.
	try {
		const loaded = loadPackagedConfig();
		resolvedResearchConfig = loaded;
		researchProfiles = resolveResearchProfiles(loaded);
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
		resolvedResearchConfig = null;
		researchProfiles = [];
	}

	// Contribute the research-owned subagent profiles exactly once, per loop
	// instance, via the owner-neutral, load-order independent
	// `subagent:discover-profiles` channel. Repeated piLoop invocations on the
	// same pi instance must not register a second listener.
	registerResearchProfileDiscovery(pi, () => researchProfiles);

	// Publish the research-owned policy adapter only after activation/resume
	// succeeds, bound to the active workspace and the same frozen policy
	// snapshot that activation persisted. On resume the identical frozenConfig
	// from the manifest is used (never rebuilt from the mutable source config)
	// so activation and resume publish the same snapshot. A restored-but-paused
	// workspace remains fail closed.
	const publishResearchIntegration = (
		workspace: Workspace,
		contract: ResolvedRunContract,
		frozenConfig: FrozenConfig,
	) => {
		if (!resolvedResearchConfig || !(pi as { events?: unknown }).events) return;
		researchProfiles = contributionsFromContract(contract);
		registerResearchSubagentIntegration(pi, {
			workspace,
			frozenConfig,
		});
	};

	// --- Create the generic loop engine -----------------------------------
	const engine = new LoopEngine({
		completionPolicy: makeGenericPolicy(),
		onStateChange: async (_state) => {
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
	registerLoopCommand(
		pi,
		{
			command: "loop",
			description:
				"Run an autonomous loop driven by a program file until its completion condition is met or budgets are hit.",
			defaultProgram: "program.md",
			defaultMaxRounds: DEFAULT_MAX_ROUNDS,
		},
		engine,
	);

	// --- Register /research command (deep research) ----------------------
	registerLoopCommand(
		pi,
		{
			command: "research",
			description:
				"Deep research: run the bundled research program (program.md) as an autonomous loop — searches, fetches sources, and compiles report.org (claim-level citations) into a retained per-run workspace under the project root.",
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
				const pointer = await prepareAndActivateResearch(
					request,
					buildResearchDeps(ctx, resolvedResearchConfig),
				);
				// The run is now active: publish the research policy adapter bound
				// to the active workspace + frozen config so the generic subagent
				// manager can reserve research concurrency.
				publishResearchIntegration(pointer.workspace, pointer.contract, pointer.frozenConfig);
				return pointer;
			},
			onResumeDeps: (ctx) => {
				if (!resolvedResearchConfig) return null;
				return {
					config: resolvedResearchConfig,
					getModels: () => buildModelView(ctx),
				};
			},
			onResearchResumed: (result) => {
				publishResearchIntegration(result.workspace, result.contract, result.frozenConfig);
			},
		},
		engine,
	);

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
		execute: makeCompleteLoopExecute(pi, engine),
	});

	// --- Register research_checkpoint tool -------------------------------
	pi.registerTool({
		name: "research_checkpoint",
		label: "Research Checkpoint",
		description:
			"MANDATORY after each search round of an active /research run. Returns CONTINUE or PROCEED based on code-enforced thresholds for the active profile. Only callable while a user-started /research run is active — never call it (or run research-style loops) outside one. Call every round with current round number and total unique sources.",
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

	pi.on("session_start", (_event, ctx) => {
		let restored = engine.latestState(ctx);
		if (restored) restored = normalizeState(restored);
		engine.state = restored;
		syncLoopTools(pi, engine);
		updateStatus(ctx, engine);
		if (restored?.status === "active") {
			// Never auto-continue a restored loop across session boundaries —
			// research must not resume (web searches, subagent dispatches,
			// token spend) without an explicit user invocation. The run stays
			// paused until the user runs /<command> resume (or clears it).
			engine.state = {
				...restored,
				status: "paused" as LoopStatus,
				updatedAt: Date.now(),
			};
			engine.persist(pi, ctx);
			// Keep the retained workspace lifecycle in sync so /research resume
			// (the explicit user-invoked path) sees a resumable state. Best
			// effort — the loop pause above always blocks continuations.
			if (restored.commandName === "research" && restored.workingDir) {
				const ws: Workspace = {
					path: restored.workingDir,
					projectRoot: path.dirname(restored.workingDir),
					mission: restored.mission,
					runId: restored.id ?? "",
					transitionId: "",
				};
				try {
					pauseLifecycle(
						ws,
						"paused at session start — research requires explicit /research resume",
					);
				} catch {
					// Lifecycle not pausable (e.g. already complete) — the loop
					// pause still blocks continuations; status/clear still work.
				}
			}
			ctx.ui.notify(
				`⏸ Loop paused: ${truncate(restored.mission)}\n/${restored.commandName} resume to continue · /${restored.commandName} clear to remove`,
				"info",
			);
			return;
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
	const isActiveResearch =
		engine.state?.status === "active" && engine.state?.commandName === "research";
	// research_checkpoint is part of the /research program protocol — expose
	// it only while a user-started research run is actually active, never
	// as a standalone tool the model could reach for on its own.
	if (isActiveResearch) active.add("research_checkpoint");
	else active.delete("research_checkpoint");
	if (engine.state?.status === "active") active.add("complete_loop");
	else active.delete("complete_loop");
	pi.setActiveTools(Array.from(active));
}

// Re-exported for test compatibility
export { programBlockFor };

// --- Research startup engine wiring (Task 10) ------------------------------
//
// buildResearchDeps injects the runtime StartupDependencies into
// prepareAndActivateResearch. The model view wraps Pi's live registry;
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
	return {
		config,
		getModels: () => buildModelView(ctx),
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

/** Model registry view over Pi's live registry. Alias ownership is research config. */
function buildModelView(ctx: ExtensionContext): ModelRegistryView {
	const all = ctx.modelRegistry.getAll();
	const find = (name: string) =>
		all.find((model) =>
			model.name === name || model.id === name || model.id.endsWith(`/${name}`),
		);
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
