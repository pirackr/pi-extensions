/**
 * Research startup and atomic activation.
 *
 * Validates the run contract against config + model registry views,
 * then performs an atomic staging → commit → transition → policy-claim
 * workflow so that a failed startup never corrupts an existing run.
 *
 * Runtime dependencies are explicit test doubles; configuration code
 * never imports live Pi registries.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { ResolvedResearchConfig } from "./config.ts";
import type { Workspace, WorkspaceClaim, StagedRun } from "./workspace.ts";
import type { RunState, RunLease } from "./state.ts";
import type { RunManifest } from "./manifest.ts";
import type { Verdict, CheckpointResult } from "./checkpoint.ts";
import type { VerificationResult } from "./verification.ts";
import type { ResearchPolicy, FrozenConfig } from "./policy.ts";
import { formatRunId, slugify, formatTimestamp } from "./workspace.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single entry in the model registry view. */
export interface ModelEntry {
	id: string;
	name: string;
	provider: string;
	capabilities: string[];
}

/** Test-doubleable view into Pi's model registry. */
export interface ModelRegistryView {
	get(name: string): ModelEntry | undefined;
	has(name: string): boolean;
}

/**
 * Immutable snapshot of a single research role contribution.
 *
 * Produced by `validateStartupContract`: the role's alias is resolved against
 * the config `models` map to a concrete model id, its prompt is read,
 * tool/access conflicts are checked, and the frozen contribution is
 * returned keyed by role name. Generic code must never reinterpret access
 * or re-resolve these — they are already resolved and frozen.
 */
export interface ResolvedProfile {
	/** Role name (the config role key). */
	name: string;
	/** Role description. */
	description: string;
	/** Concrete model id resolved from config.models → model registry. */
	model: string;
	/** Reasoning/thinking level. */
	thinking: "minimal" | "low" | "medium" | "high";
	/** Exact tool set contributed by the role. */
	tools: string[];
	/** Access level (read | write). */
	access: "read" | "write";
	/** Complete, read system prompt. */
	systemPrompt: string;
	/** Timeout ceiling in seconds. */
	timeoutSeconds: number;
}

/**
 * Frozen snapshot produced by validateStartupContract.
 * Immutable once returned — used for display and activation.
 */
export interface ResolvedRunContract {
	runId: string;
	transitionId: string;
	mission: string;
	profile: string;
	programPath: string;
	profileConfig: {
		minRounds: number;
		maxRounds: number | null;
		minSources: number;
		maxScouts: number;
		maxFetchers: number;
		verification: string[];
	};
	defaults: {
		maxIterations: number;
		maxTokens: number;
		noProgress: number | "off";
		scoreThreshold: number;
		retryCount: number;
		maxSearches: number;
		maxFetches: number;
	};
	/**
	 * Frozen, already-resolved role contributions keyed by role name. Each
	 * carries its concrete model, complete prompt, exact tools, and access.
	 * This supersedes the old provider-negotiated display; `resolvedModels`
	 * is retained for resume integrity checks.
	 */
	resolvedProfiles: Record<string, ResolvedProfile>;
	resolvedModels: Record<string, ModelEntry>;
	hardCeilings: {
		maxConcurrentAttempts: number;
		maxAttemptsPerTask: number;
		hardTimeoutSeconds: number;
	};
}

/** Parsed CLI request for a new research run. */
export interface ResearchStartRequest {
	mission: string;
	profile: string;
	programPath: string | null; // null → use config default
	profileOverride: string | null; // null → use config default
	yes: boolean; // --yes flag — skip confirmation
}

/** A single transition record stored in the transitions file. */
export interface TransitionRecord {
	transitionId: string;
	runId: string;
	mission: string;
	profile: string;
	status: "active" | "replaced" | "resumable" | "terminal";
	claimedAt: number;
}

/**
 * All runtime dependencies — explicit test doubles.
 * Startup code never imports live Pi registries.
 */
export interface StartupDependencies {
	/** Resolved configuration — test doubles provide it directly. */
	config: ResolvedResearchConfig;
	/** Test-doubleable model registry view. */
	getModels: () => ModelRegistryView;
	workspace: {
		acquireWorkspaceClaim: (
			projectRoot: string,
			mission: string,
			transitionId: string,
			finalDirBase?: string,
		) => WorkspaceClaim;
		prepareStaging: (claim: WorkspaceClaim) => StagedRun;
		commitStaging: (staged: StagedRun, claim: WorkspaceClaim) => Workspace;
		reconcileTransition: (
			projectRoot: string,
			transitionId: string,
			finalDir: string,
		) => {
			status: "clean" | "rollback" | "resume";
			claimPath?: string;
			stagingPath?: string;
		};
		ensureGitExclude: (projectRoot: string) => void;
	};
	state: {
		newRunState: (ws: Workspace) => RunState;
		acquireLease: (ws: Workspace, sessionId: string) => Promise<RunLease>;
	};
	manifest: {
		createRunManifest: (
			ws: Workspace,
			snapshotContent?: string,
			resolvedContract?: ResolvedRunContract,
			frozenConfig?: FrozenConfig,
		) => RunManifest;
	};
	transitions: {
		getPath: () => string;
		appendTransition: (record: TransitionRecord) => void;
		getTransitions: () => ReadonlyArray<TransitionRecord>;
		markTransitionAsReplaced: (runId: string) => void;
		getCurrentPointer: () => { runId: string; transitionId: string } | null;
		setPointer: (runId: string, transitionId: string) => void;
	};
	policy: {
		createPolicy: (
			workspace: Workspace,
			config: FrozenConfig,
			hardTimeoutSeconds: number,
		) => ResearchPolicy;
	};
	checkpoint: {
		evaluateCheckpoint: (
			ws: Workspace,
			loopIteration: number,
			expectedRevision: number,
		) => Promise<CheckpointResult>;
	};
	verification: {
		runVerification: (
			ws: Workspace,
			profileName: string,
		) => VerificationResult[];
	};
	logger: {
		log: (message: string) => void;
	};
}

/** Returned after a successful atomic activation. */
export interface ActiveResearchPointer {
	workspace: Workspace;
	runState: RunState;
	manifest: RunManifest;
	contract: ResolvedRunContract;
	policy: ResearchPolicy;
	/**
	 * The frozen policy configuration used by the policy at activation.
	 * Persisted with the manifest and republished on resume so activation and
	 * resume publish the identical snapshot (never rebuilt from mutable config).
	 */
	frozenConfig: FrozenConfig;
}

// ---------------------------------------------------------------------------
// Helper: transitions file management
// ---------------------------------------------------------------------------

/**
 * Minimal transitions file reader/writer.
 * A single JSON file: `{ transitions: TransitionRecord[], pointer: { runId, transitionId } | null }`
 */
export class TransitionsFile {
	private path: string;

	constructor(path: string) {
		this.path = path;
	}

	private read(): {
		transitions: TransitionRecord[];
		pointer: { runId: string; transitionId: string } | null;
	} {
		try {
			const raw = fs.readFileSync(this.path, "utf-8");
			return JSON.parse(raw) as {
				transitions: TransitionRecord[];
				pointer: { runId: string; transitionId: string } | null;
			};
		} catch {
			return { transitions: [], pointer: null };
		}
	}

	private write(data: {
		transitions: TransitionRecord[];
		pointer: { runId: string; transitionId: string } | null;
	}): void {
		const dir = path.dirname(this.path);
		if (!fs.existsSync(dir)) {
			fs.mkdirSync(dir, { recursive: true });
		}
		const tmpPath = this.path + ".tmp";
		fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), "utf-8");
		fs.renameSync(tmpPath, this.path);
	}

	appendTransition(record: TransitionRecord): void {
		const data = this.read();
		data.transitions.push(record);
		this.write(data);
	}

	getTransitions(): ReadonlyArray<TransitionRecord> {
		return this.read().transitions;
	}

	getPath(): string {
		return this.path;
	}

	markTransitionAsReplaced(runId: string): void {
		const data = this.read();
		for (const t of data.transitions) {
			if (t.runId === runId) {
				t.status = "replaced";
			}
		}
		this.write(data);
	}

	getCurrentPointer(): { runId: string; transitionId: string } | null {
		return this.read().pointer;
	}

	setPointer(runId: string, transitionId: string): void {
		const data = this.read();
		data.pointer = { runId, transitionId };
		this.write(data);
	}
}

// ---------------------------------------------------------------------------
// validateStartupContract
// ---------------------------------------------------------------------------

/**
 * Mutation-capable tools. A role declared `access: "read"` may not declare
 * any of these — the access/tool conflict check in `validateStartupContract`
 * enforces read-only roles.
 */
const MUTATION_TOOLS = new Set([
	"write",
	"edit",
	"create",
	"append",
	"delete",
	"del",
	"remove",
	"rename",
	"move",
	"copy",
	"exec",
	"bash",
	"shell",
	"apply_patch",
	"ctx_shell",
	"ctx_execute",
	"ctx_edit",
	"ctx_patch",
	"ctx_refactor",
	"ast_grep_replace",
]);

/**
 * Validates configuration, resolves role models and prompts, checks
 * access/tool conflicts, and checks hard ceilings — returning a frozen run
 * contract with already-resolved, frozen role contributions.
 *
 * The contract's runId is derived from the canonical workspace formula
 * (`transitionId-finalDir`) via formatRunId. When a mission is supplied
 * the slug is mission-derived; `prepareAndActivateResearch` re-derives it
 * from the actually-claimed final directory so it always matches the
 * workspace runId even when a suffix was allocated.
 *
 * Provider negotiation is gone: each role alias is resolved against the
 * config `models` map and then against Pi's model registry, the complete
 * system prompt is read and frozen, and access/tool conflicts are checked.
 *
 * Throws if any validation step fails.
 */
export async function validateStartupContract(
	config: ResolvedResearchConfig,
	models: ModelRegistryView,
	mission: string = "",
): Promise<ResolvedRunContract> {
	const profileName = config.defaultProfile;
	const profileConfig = config.profiles[profileName];
	if (!profileConfig) {
		throw new Error(`Unknown profile '${profileName}' in configuration.`);
	}

	// Validate profile thresholds
	if (profileConfig.minRounds < 1) {
		throw new Error(
			`Profile '${profileName}': minRounds must be a positive integer.`,
		);
	}
	if (
		profileConfig.maxRounds !== null &&
		profileConfig.maxRounds < profileConfig.minRounds
	) {
		throw new Error(
			`Profile '${profileName}': maxRounds (${profileConfig.maxRounds}) < minRounds (${profileConfig.minRounds}).`,
		);
	}

	// Resolve each role: alias → concrete model, read prompt, check access/tool.
	const resolvedModels: Record<string, ModelEntry> = {};
	const resolvedProfiles: Record<string, ResolvedProfile> = {};
	for (const [roleName, role] of Object.entries(config.roles)) {
		const modelAlias = role.model;
		// Resolve the role alias through the config `models` map first, then
		// fall back to matching the alias directly against the registry (by
		// name/id). Reject a missing alias/model.
		const concreteAlias = config.models?.[modelAlias];
		const lookupName = concreteAlias ?? modelAlias;
		const modelEntry = models.get(lookupName);
		if (!modelEntry) {
			if (concreteAlias) {
				throw new Error(
					`Role '${roleName}': model alias '${modelAlias}' resolves to '${concreteAlias}', which is not found in the model registry.`,
				);
			}
			throw new Error(
				`Role '${roleName}': model '${modelAlias}' not found in model registry.`,
			);
		}
		const modelSnapshot = Object.freeze({
			...modelEntry,
			capabilities: Object.freeze([...modelEntry.capabilities]) as unknown as string[],
		});
		resolvedModels[roleName] = modelSnapshot;

		// Read and validate the complete system prompt.
		let systemPrompt: string;
		try {
			systemPrompt = fs.readFileSync(role.promptPath, "utf-8");
		} catch (err) {
			const reason = err instanceof Error ? err.message : String(err);
			throw new Error(
				`Role '${roleName}': cannot read prompt at '${role.promptPath}': ${reason}`,
			);
		}
		if (!systemPrompt.trim()) {
			throw new Error(
				`Role '${roleName}': prompt at '${role.promptPath}' is empty.`,
			);
		}

		// Access/tool conflict: a read-only role may not declare a
		// write-capable (mutation) tool.
		for (const tool of role.tools) {
			if (role.access === "read" && MUTATION_TOOLS.has(tool)) {
				throw new Error(
					`Role '${roleName}': access 'read' cannot include write-capable tool '${tool}'.`,
				);
			}
		}

		resolvedProfiles[roleName] = Object.freeze({
			name: roleName,
			description: role.description,
			model: modelSnapshot.id,
			thinking: role.thinking,
			tools: Object.freeze([...role.tools]) as unknown as string[],
			access: role.access,
			systemPrompt,
			timeoutSeconds: role.timeoutSeconds,
		});
	}

	// Compute hard ceilings
	const roleEntries = Object.entries(config.roles);
	const maxConcurrentAttempts = roleEntries.length > 0
		? roleEntries.reduce((sum, [, r]) => sum + r.concurrentDispatch, 0)
		: 1; // Default: 1 concurrent for general-purpose
	const maxAttemptsPerTask = roleEntries.length > 0
		? Math.max(...roleEntries.map(([, r]) => r.totalDispatch))
		: 100; // Default: 100 attempts for general-purpose
	const hardTimeoutSeconds = 1800; // 30 minutes

	// Validate hard ceilings are sufficient (skip when using general-purpose fallback)
	if (roleEntries.length > 0 && maxConcurrentAttempts < roleEntries.length) {
		throw new Error(
			`Insufficient concurrent capacity: ${maxConcurrentAttempts} < ${roleEntries.length} roles.`,
		);
	}
	if (hardTimeoutSeconds < 60) {
		throw new Error(
			`Hard timeout ceiling too low: ${hardTimeoutSeconds}s (minimum 60s).`,
		);
	}

	const transitionId = `tr-${randomUUID().slice(0, 8)}`;
	const runId = formatRunId(transitionId, slugify(mission));

	return {
		runId,
		transitionId,
		mission: "", // populated during prepareAndActivateResearch
		profile: profileName,
		programPath: config.defaultProgram,
		profileConfig: {
			minRounds: profileConfig.minRounds,
			maxRounds: profileConfig.maxRounds,
			minSources: profileConfig.minSources,
			maxScouts: profileConfig.maxScouts,
			maxFetchers: profileConfig.maxFetchers,
			verification: profileConfig.verification,
		},
		defaults: {
			maxIterations: config.defaults.maxIterations,
			maxTokens: config.defaults.maxTokens,
			noProgress: config.defaults.noProgress,
			scoreThreshold: config.defaults.scoreThreshold,
			retryCount: config.defaults.retryCount,
			maxSearches: config.defaults.maxSearches,
			maxFetches: config.defaults.maxFetches,
		},
		resolvedProfiles: Object.freeze(resolvedProfiles),
		resolvedModels: Object.freeze(resolvedModels),
		hardCeilings: {
			maxConcurrentAttempts,
			maxAttemptsPerTask,
			hardTimeoutSeconds,
		},
	};
}

// ---------------------------------------------------------------------------
// prepareAndActivateResearch
// ---------------------------------------------------------------------------

/**
 * Full atomic startup: parse CLI → resolve config → validate → display
 * contract (unless --yes) → stage in hidden dir → commit → append
 * transition → mark prior run replaced → install new pointer → claim
 * policy → activate iteration 1.
 *
 * On validation failure, decline, or staging failure: removes staging
 * and leaves the previous run untouched.
 *
 * Recovery uses the shared transition ID; a committed manifest is
 * retained with an explicit resumable or terminal state.
 */
export async function prepareAndActivateResearch(
	request: ResearchStartRequest,
	deps: StartupDependencies,
): Promise<ActiveResearchPointer> {
	const mission = request.mission;
	const profile = request.profileOverride ?? request.profile;

	// --- Step 1: Validate contract (config provided via deps) ---

	// Validate the contract (resolves role models + prompts, checks access)
	const contract = await validateStartupContract(
		deps.config,
		deps.getModels!(),
		mission,
	);

	// Update mission in the contract
	contract.mission = mission;
	contract.profile = profile;

	// --- Step 2: Display contract (skip if --yes) ---

	if (!request.yes) {
		const lines: string[] = [];
		lines.push("┌───────────────────────────────────────────────");
		lines.push("│  Research Run Contract");
		lines.push("├───────────────────────────────────────────────");
		lines.push(`│  Mission:     ${mission}`);
		lines.push(`│  Profile:     ${profile}`);
		for (const [roleName, resolved] of Object.entries(
			contract.resolvedProfiles,
		)) {
			lines.push(`│  Role ${roleName}:  ${resolved.model}`);
		}
		lines.push(`│  Max Rounds:  ${contract.profileConfig.maxRounds ?? "∞"}`);
		lines.push(`│  Min Sources: ${contract.profileConfig.minSources}`);
		lines.push(`│  Timeout:     ${contract.hardCeilings.hardTimeoutSeconds}s`);
		lines.push("└───────────────────────────────────────────────");
		const display = lines.join("\n");
		deps.logger.log(display);

		// In a real implementation, this would prompt for confirmation.
		// For now we throw to signal the caller needs to confirm.
		// TODO [F4 — integration layer]: Replace this throw with an actual
		// `ctx.ui.confirm()` call in the command handler that invokes this
		// module. The handler should catch CONTRACT_REQUIRES_CONFIRMATION,
		// present the contract to the user, and re-invoke with `yes: true`
		// when confirmed (or clean up staging on rejection).
		throw new Error(`CONTRACT_REQUIRES_CONFIRMATION: ${display}`);
	}

	// --- Step 3: Resolve project root and transition ---

	const transitionsPath = deps.transitions.getPath();
	const projectRoot = path.dirname(transitionsPath);
	const transitionId = contract.transitionId;

	// --- Step 4: Reconcile any interrupted transition ---

	// Timestamped final workspace dir name (single source for claim, staging,
	// commit, and runId): `<YYYYMMDD-HHmm>-<mission-slug>`. The timestamp prefix
	// keeps duplicate missions in distinct, chronologically sortable dirs.
	const finalDir = `${formatTimestamp(new Date())}-${slugify(mission)}`;

	const reconciliation = deps.workspace.reconcileTransition(
		projectRoot,
		transitionId,
		finalDir,
	);

	if (reconciliation.status === "rollback") {
		// Clean up stale claim/staging from a previous interrupted transition
		if (
			reconciliation.stagingPath &&
			fs.existsSync(reconciliation.stagingPath)
		) {
			fs.rmSync(reconciliation.stagingPath, { recursive: true, force: true });
		}
	} else if (reconciliation.status === "resume") {
		// Staging exists and is ready — we can reuse it
		// This shouldn't happen in a fresh startup, but handle gracefully
		throw new Error(
			`Previous interrupted transition found (resume mode). Clean up and retry.`,
		);
	}
	// "clean" — nothing to do

	// --- Step 5: Acquire workspace claim and prepare staging ---

	let claim: WorkspaceClaim;
	let staged: StagedRun;
	let cleanupStaging = false;

	try {
		claim = deps.workspace.acquireWorkspaceClaim(
			projectRoot,
			mission,
			transitionId,
			finalDir,
		);
		staged = deps.workspace.prepareStaging(claim);
	} catch (err) {
		// Acquisition failed — nothing to clean up (no staging created yet)
		throw err;
	}

	cleanupStaging = true;

	// --- Step 6: Build and verify the complete run in staging ---

	// Populate staging directory with initial workspace structure
	const stagingPath = staged.stagingPath;
	fs.mkdirSync(stagingPath, { recursive: true });

	// Create a snapshot content string (initial workspace state)
	const snapshotContent = JSON.stringify(
		{ mission, profile, createdAt: Date.now() },
		null,
		2,
	);

	// Commit staging → final path (collision-safe rename)
	let workspace: Workspace;
	try {
		workspace = deps.workspace.commitStaging(staged, claim);
	} catch {
		// Commit failed — clean up staging
		if (fs.existsSync(stagingPath)) {
			fs.rmSync(stagingPath, { recursive: true, force: true });
		}
		throw new Error(`Commit failed for ${staged.stagingPath}`);
	}

	cleanupStaging = false;

	// Canonical run identity: the workspace runId (transitionId-finalDir) is
	// the single source of truth. Align the frozen contract with it so lease,
	// transitions, pointer, loop id, state, and manifest all agree.
	contract.runId = workspace.runId;
	const runId = workspace.runId;

	// --- Step 6.5: Build the frozen policy configuration ---
	// Build the FrozenConfig snapshot exactly once, before the manifest is
	// written, so the identical snapshot is both persisted with the immutable
	// run manifest and used to claim the policy (activation and resume
	// publication never rebuild it from mutable source config).
	const frozenConfig: FrozenConfig = Object.freeze({
		roles: Object.freeze(
			Object.fromEntries(
				Object.entries(deps.config.roles).map(([name, role]) => {
					const resolved = contract.resolvedProfiles[name];
					return [
						name,
						Object.freeze({
							...role,
							name,
							model: resolved.model,
							thinking: resolved.thinking,
							tools: Object.freeze([...resolved.tools]) as unknown as string[],
							access: resolved.access,
							timeoutSeconds: resolved.timeoutSeconds,
						}),
					];
				}),
			),
		),
		hardTimeoutSeconds: contract.hardCeilings.hardTimeoutSeconds,
	});

	// --- Step 7: Create manifest (persist the frozen snapshots) ---

	const manifest = deps.manifest.createRunManifest(
		workspace,
		snapshotContent,
		contract,
		frozenConfig,
	);

	// --- Step 8: Create and initialize run state ---

	const runState = deps.state.newRunState(workspace);
	const statePath = path.join(workspace.path, ".research", "run-state.json");
	fs.writeFileSync(statePath, JSON.stringify(runState, null, 2), "utf-8");

	// --- Step 9: Acquire lease ---

	const lease = await deps.state.acquireLease(workspace, runId);
	// Lease released when the session ends (handled by caller)

	// --- Step 10: Ensure .research/ is Git-excluded ---

	deps.workspace.ensureGitExclude(projectRoot);

	// --- Step 11: Mark prior run as replaced ---

	const priorPointer = deps.transitions.getCurrentPointer();
	if (priorPointer && priorPointer.runId !== runId) {
		deps.transitions.markTransitionAsReplaced(priorPointer.runId);
	}

	// --- Step 12: Append new transition record ---

	deps.transitions.appendTransition({
		transitionId,
		runId,
		mission,
		profile,
		status: "active",
		claimedAt: Date.now(),
	});

	// --- Step 13: Install the new pointer ---

	deps.transitions.setPointer(runId, transitionId);

	// --- Step 14: Claim the research policy ---

	const policy = deps.policy.createPolicy(
		workspace,
		frozenConfig,
		contract.hardCeilings.hardTimeoutSeconds,
	);

	// --- Step 15: Activate iteration 1 (run checkpoint and verification) ---

	// Initial checkpoint evaluation — should return CONTINUE (round 0)
	await deps.checkpoint.evaluateCheckpoint(
		workspace,
		0, // loop iteration
		runState.revision,
	);

	// Run verification — should return empty for a fresh run
	deps.verification.runVerification(workspace, profile);

	// --- Done ---

	deps.logger.log(`✅ Research activated: ${runId} (${workspace.path})`);

	return {
		workspace,
		runState,
		manifest,
		contract,
		policy,
		frozenConfig,
	};
}
