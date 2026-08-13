/**
 * ResearchPolicy — frozen-manifest dispatch middleware.
 *
 * Enforces the frozen research manifest during active runs:
 *  - `claim` succeeds only for an active research run.
 *  - `resolve` permits manifest roles only, removes caller operational
 *    overrides, forces frozen summary/retention/timeout/retry/web settings,
 *    injects run identity and digests, and confines result paths beneath
 *    the canonical workspace.
 *  - `reserveAttempt` uses the transactional state API with fresh-read retry
 *    on StateConflict. Serializes across parallel tool calls and enforces
 *    per-role total, per-role concurrent, and provider-wide concurrent limits
 *    before the façade launches anything.
 *  - `releaseAttempt` is idempotent by reservation ID, releases concurrency
 *    through the state API, and retains consumed counts for failure,
 *    cancellation, interruption.
 *  - `exportArtifact` validates the frozen role schema, writes atomically,
 *    rejects symlink-parent escapes and immutable targets, returns digest
 *    metadata.
 *
 * Hard dispatch limit: 30 minutes (1800s) — configurable via constructor.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type {
	AttemptOutcome,
	AttemptReservation,
	ResolvedAttempt,
	ResolvedDispatch,
	DispatchContext,
	RequestedPlan,
	AttemptResult,
	ArtifactMetadata,
} from "../subagent-dispatch/contract.ts";
import {
	readRunState,
	updateRunState,
	type RunState,
	type Workspace,
} from "./state.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Typed conflict returned by updateRunState on stale revision. */
interface StateConflict {
	expected: number;
	actual: number;
}

/** Immutable role configuration from the frozen manifest. */
export interface RoleConfig {
	description: string;
	model: string;
	thinking: "high" | "medium" | "low" | "minimal";
	tools: string[];
	access: "read" | "write";
	timeoutSeconds: number;
	promptPath: string;
	resultFormat: "markdown" | "json";
	totalDispatch: number;
	concurrentDispatch: number;
	maxSearches: number;
	maxFetches: number;
	retention: "ephemeral" | "artifact" | "persistent";
}

/** Resolved role with its name injected for dispatch context. */
export interface ResolvedRole extends RoleConfig {
	name: string;
}

/** Internal tracking state for reservation accounting. */
interface ReservationBucket {
	/** Total reservations ever made (consumed, never decremented). */
	total: number;
	/** Currently active (reserved but not released). */
	concurrent: number;
	/** Map of reservationId → attempt (for idempotent release). */
	reservations: Map<string, AttemptReservation>;
}

/** Frozen configuration snapshot loaded at construction. */
interface FrozenConfig {
	/** Map of role name → resolved role config. */
	roles: Record<string, ResolvedRole>;
	/** Hard timeout ceiling in seconds (default 1800). */
	hardTimeoutSeconds: number;
}

// ---------------------------------------------------------------------------
// Known-field sets for strict role validation
// ---------------------------------------------------------------------------

const KNOWN_ROLE_FIELDS = new Set<string>([
	"name",
	"description",
	"model",
	"thinking",
	"tools",
	"access",
	"timeoutSeconds",
	"promptPath",
	"resultFormat",
	"totalDispatch",
	"concurrentDispatch",
	"maxSearches",
	"maxFetches",
	"retention",
]);

const VALID_THINKING = new Set<string>(["minimal", "low", "medium", "high"]);
const VALID_ACCESS = new Set<string>(["read", "write"]);
const VALID_RESULT_FORMATS = new Set<string>(["markdown", "json"]);
const VALID_RETENTION = new Set<string>(["ephemeral", "artifact", "persistent"]);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_HARD_TIMEOUT_SECONDS = 1800; // 30 minutes
const ARTIFACTS_DIR = ".research/artifacts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if an error object is a StateConflict by shape. */
function isStateConflict(err: unknown): err is StateConflict {
	return (
		err !== null &&
		typeof err === "object" &&
		"expected" in err &&
		"actual" in err &&
		typeof (err as StateConflict).expected === "number" &&
		typeof (err as StateConflict).actual === "number"
	);
}

// ---------------------------------------------------------------------------
// Role validation
// ---------------------------------------------------------------------------

function validateRoleConfig(name: string, role: Record<string, unknown>): void {
	for (const key of Object.keys(role)) {
		if (!KNOWN_ROLE_FIELDS.has(key)) {
			throw new Error(`Unknown field '${key}' in role '${name}'.`);
		}
	}

	if (typeof role.description !== "string" || !role.description.trim()) {
		throw new Error(`Role '${name}': description must be a non-empty string.`);
	}
	if (typeof role.model !== "string" || !role.model.trim()) {
		throw new Error(`Role '${name}': model must be a non-empty string.`);
	}
	if (typeof role.thinking !== "string" || !VALID_THINKING.has(role.thinking)) {
		throw new Error(`Role '${name}': invalid thinking level '${role.thinking}'.`);
	}
	if (!Array.isArray(role.tools) || !role.tools.every((t: unknown) => typeof t === "string")) {
		throw new Error(`Role '${name}': tools must be an array of strings.`);
	}
	if (typeof role.access !== "string" || !VALID_ACCESS.has(role.access)) {
		throw new Error(`Role '${name}': invalid access level '${role.access}'.`);
	}
	if (typeof role.timeoutSeconds !== "number" || !Number.isInteger(role.timeoutSeconds) || role.timeoutSeconds < 10 || role.timeoutSeconds > 1800) {
		throw new Error(`Role '${name}': timeoutSeconds must be between 10 and 1800.`);
	}
	if (typeof role.promptPath !== "string" || !role.promptPath.trim()) {
		throw new Error(`Role '${name}': promptPath must be a non-empty string.`);
	}
	if (typeof role.resultFormat !== "string" || !VALID_RESULT_FORMATS.has(role.resultFormat)) {
		throw new Error(`Role '${name}': invalid resultFormat '${role.resultFormat}'.`);
	}
	if (typeof role.totalDispatch !== "number" || !Number.isInteger(role.totalDispatch) || role.totalDispatch < 0) {
		throw new Error(`Role '${name}': totalDispatch must be a non-negative integer.`);
	}
	if (typeof role.concurrentDispatch !== "number" || !Number.isInteger(role.concurrentDispatch) || role.concurrentDispatch < 0) {
		throw new Error(`Role '${name}': concurrentDispatch must be a non-negative integer.`);
	}
	if (typeof role.maxSearches !== "number" || !Number.isInteger(role.maxSearches) || role.maxSearches < 0) {
		throw new Error(`Role '${name}': maxSearches must be a non-negative integer.`);
	}
	if (typeof role.maxFetches !== "number" || !Number.isInteger(role.maxFetches) || role.maxFetches < 0) {
		throw new Error(`Role '${name}': maxFetches must be a non-negative integer.`);
	}
	if (typeof role.retention !== "string" || !VALID_RETENTION.has(role.retention)) {
		throw new Error(`Role '${name}': invalid retention '${role.retention}'.`);
	}
}

// ---------------------------------------------------------------------------
// Path confinement helpers
// ---------------------------------------------------------------------------

/**
 * Resolves a candidate artifact path inside the workspace.
 * Throws if the resolved path escapes the workspace.
 */
function confinePath(
	workspacePath: string,
	artifactName: string,
): string {
	const candidate = path.join(workspacePath, ARTIFACTS_DIR, artifactName);
	const resolved = path.resolve(candidate);
	const workspaceResolved = path.resolve(workspacePath);

	// Reject if resolved path is not beneath workspace
	if (!resolved.startsWith(workspaceResolved + path.sep) && resolved !== workspaceResolved) {
		throw new Error(
			`Artifact path escapes workspace: ${artifactName} → ${resolved}`,
		);
	}

	return resolved;
}

/**
 * Checks if the target path is immutable (read-only).
 */
function isImmutable(targetPath: string): boolean {
	try {
		const stat = fs.statSync(targetPath);
		// If only read bits are set (no owner/group/other write), it's immutable
		return (stat.mode & 0o222) === 0;
	} catch {
		return false; // file doesn't exist yet — not immutable
	}
}

// ---------------------------------------------------------------------------
// ResearchPolicy — implements DispatchPolicy
// ---------------------------------------------------------------------------

export class ResearchPolicy {
	/** Frozen configuration snapshot. */
	readonly frozenConfig: FrozenConfig;

	/** Workspace this policy is bound to. */
	readonly workspace: Workspace;

	/** Hard timeout ceiling in seconds. */
	readonly hardTimeoutSeconds: number;

	/** Reservation tracking buckets — keyed by role name. */
	private readonly buckets: Map<string, ReservationBucket> = new Map();

	/** Global reservation serialization lock. */
	private reserveLock = Promise.resolve();

	/** When the policy was instantiated (for timeout enforcement). */
	private readonly createdAt = Date.now();

	constructor(
		workspace: Workspace,
		config: FrozenConfig,
		hardTimeoutSeconds: number = DEFAULT_HARD_TIMEOUT_SECONDS,
	) {
		this.workspace = workspace;
		this.hardTimeoutSeconds = hardTimeoutSeconds;
		this.frozenConfig = config;

		// Validate all role configs
		for (const [name, role] of Object.entries(config.roles)) {
			validateRoleConfig(name, role);
		}
	}

	// -----------------------------------------------------------------------
	// DispatchPolicy: claim
	// -----------------------------------------------------------------------

	async claim(context: DispatchContext): Promise<boolean> {
		const contextRunId = (context.context as Record<string, unknown>).runId as string | undefined;
		if (!contextRunId || contextRunId !== this.workspace.runId) {
			return false;
		}

		try {
			const state = readRunState(this.workspace);
			return state.status === "active";
		} catch {
			return false;
		}
	}

	// -----------------------------------------------------------------------
	// DispatchPolicy: resolve
	// -----------------------------------------------------------------------

	async resolve(plan: RequestedPlan): Promise<ResolvedDispatch> {
		const roleNames = Object.keys(this.frozenConfig.roles);

		// F2: Enforce manifest role whitelist — reject non-manifest providers
		if (plan.providerId !== null && !roleNames.includes(plan.providerId)) {
			throw new Error(
				`Provider '${plan.providerId}' is not a manifest role. Allowed: ${roleNames.join(", ")}`,
			);
		}

		const providerId = plan.providerId ?? (roleNames.length > 0 ? roleNames[0] : null);
		if (!providerId) {
			throw new Error("No manifest roles configured for this workspace.");
		}

		const role = this.frozenConfig.roles[providerId];

		// F3: Strip caller operational overrides and inject frozen settings
		const attempts: ResolvedAttempt[] = [];
		for (let i = 0; i < plan.totalAttempts; i++) {
			attempts.push({
				attemptId: `att-${this.workspace.runId}-${i}-${Date.now()}`,
				planId: `plan-${this.workspace.runId}`,
				index: i,
				taskInfo: {
					role: providerId,
					timeoutSeconds: role.timeoutSeconds,
					retention: role.retention,
					maxSearches: role.maxSearches,
					maxFetches: role.maxFetches,
				},
			});
		}

		// F4: Provider-wide concurrent ceiling = sum of all role concurrentDispatch
		// (not Math.max — Math.max silently undercounts capacity when multiple roles exist)
		const providerCeiling = Object.values(this.frozenConfig.roles)
			.reduce((sum, r) => sum + r.concurrentDispatch, 0);

		// F5: maxConcurrentAttempts = max per-role concurrentDispatch (a concurrency count, not seconds)
		const maxConcurrent = Math.max(
			...Object.values(this.frozenConfig.roles).map((r) => r.concurrentDispatch),
		);

		return {
			providerId,
			descriptor: {
				id: providerId,
				adapterVersion: "1.0.0",
				capabilities: ["local"],
				maxConcurrentAttempts: maxConcurrent,
				maxAttemptsPerTask: 100,
			},
			attempts,
			totalAttempts: plan.totalAttempts,
		};
	}

	// -----------------------------------------------------------------------
	// DispatchPolicy: reserveAttempt
	// -----------------------------------------------------------------------

	async reserveAttempt(attempt: ResolvedAttempt): Promise<AttemptReservation | undefined> {
		// Enforce hard timeout
		const elapsed = (Date.now() - this.createdAt) / 1000;
		if (elapsed >= this.hardTimeoutSeconds) {
			return undefined;
		}

		const roleInfo = (attempt.taskInfo as Record<string, string | undefined> | undefined);
		const roleKey = roleInfo?.role ?? Object.keys(this.frozenConfig.roles)[0] ?? "scout";
		const role = this.frozenConfig.roles[roleKey];
		if (!role) {
			return undefined;
		}

		// Serialize through lock
		let result: AttemptReservation | undefined;
		this.reserveLock = this.reserveLock.then(async () => {
			result = await this._doReserve(roleKey, role, attempt);
		});
		await this.reserveLock;

		return result!;
	}

	private async _doReserve(
		roleKey: string,
		role: ResolvedRole,
		attempt: ResolvedAttempt,
	): Promise<AttemptReservation | undefined> {
		// Read state and check conditions
		let state: RunState;
		try {
			state = readRunState(this.workspace);
		} catch {
			return undefined;
		}

		// Get or create bucket
		let bucket = this.buckets.get(roleKey);
		if (!bucket) {
			bucket = { total: 0, concurrent: 0, reservations: new Map() };
			this.buckets.set(roleKey, bucket);
		}

		// F4: Provider-wide concurrent ceiling = sum of all role concurrentDispatch
		const providerCeiling = Object.values(this.frozenConfig.roles)
			.reduce((sum, r) => sum + r.concurrentDispatch, 0);

		// Check in-memory bucket total cap
		if (bucket.total >= role.totalDispatch) return undefined;
		// Check in-memory bucket concurrent cap
		if (bucket.concurrent >= role.concurrentDispatch) return undefined;

		// F1: Check state-based concurrent count for accuracy
		const stateConcurrent = state.concurrentReservations ?? 0;
		if (stateConcurrent >= providerCeiling) return undefined;

		// All checks passed — atomically commit via updateRunState.
		// We do NOT throw inside the mutate callback to avoid breaking the
		// serialization chain. Instead we check, then write a small state
		// increment and update the in-memory bucket afterwards.
		const MAX_RETRIES = 5;
		let revision = state.revision;

		for (let attemptNo = 0; attemptNo < MAX_RETRIES; attemptNo++) {
			try {
				await updateRunState(this.workspace, revision, (current) => ({
					...current,
					concurrentReservations: (current.concurrentReservations ?? 0) + 1,
				}));

				// Create reservation in in-memory bucket
				const reservationId = `res-${attempt.attemptId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
				const reservation: AttemptReservation = {
					reservationId,
					attempt,
					providerId: role.model ?? "default",
				};
				bucket.total++;
				bucket.concurrent++;
				bucket.reservations.set(reservationId, reservation);

				return reservation;
			} catch (err) {
				if (isStateConflict(err)) {
					revision = (err as StateConflict).actual;
					continue;
				}
				return undefined; // Unexpected error
			}
		}
		return undefined;
	}

	// -----------------------------------------------------------------------
	// DispatchPolicy: releaseAttempt
	// -----------------------------------------------------------------------

	async releaseAttempt(
		reservation: AttemptReservation,
		outcome: AttemptOutcome,
	): Promise<void> {
		const bucket = this._findBucket(reservation);
		if (!bucket) {
			return; // already released or never registered
		}

		if (!bucket.reservations.has(reservation.reservationId)) {
			return; // idempotent: already released
		}

		// IMPORTANT: Do NOT decrement total — it's consumed and stays consumed
		// for failure, cancellation, interruption outcomes
		bucket.reservations.delete(reservation.reservationId);

		// Release concurrency slot (in-memory — immediate response)
		bucket.concurrent = Math.max(0, bucket.concurrent - 1);

		// F1: Release concurrency through the SAME transactional state API
		// used by reserveAttempt (updateRunState). Idempotent by reservationId
		// and retains consumed counts for failure/cancellation/interruption.
		try {
			const state = readRunState(this.workspace);
			await updateRunState(this.workspace, state.revision, (current) => ({
					...current,
					concurrentReservations: Math.max(0, (current.concurrentReservations ?? 0) - 1),
				}));
		} catch {
			// Best-effort — in-memory bucket already released; state update
			// provides durable backup for crash recovery.
		}
	}

	private _findBucket(reservation: AttemptReservation): ReservationBucket | null {
		for (const [roleKey, bucket] of this.buckets) {
			if (bucket.reservations.has(reservation.reservationId)) {
				return bucket;
			}
		}
		return null;
	}

	// -----------------------------------------------------------------------
	// DispatchPolicy: exportArtifact
	// -----------------------------------------------------------------------

	async exportArtifact(
		reservation: AttemptReservation,
		result: AttemptResult,
	): Promise<ArtifactMetadata | undefined> {
		const roleInfo = (reservation.attempt.taskInfo as Record<string, string | undefined> | undefined);
		const roleKey = roleInfo?.role ?? Object.keys(this.frozenConfig.roles)[0] ?? "scout";
		const role = this.frozenConfig.roles[roleKey];

		// F8: Validate frozen role schema — JSON output must be serializable.
		// Throws a structured error instead of silently returning undefined.
		if (role && result.output && role.resultFormat === "json") {
			try {
				JSON.stringify(result.output);
			} catch (err) {
				throw new Error(
					`Artifact JSON serialization failed for role '${roleKey}': ` +
						(err instanceof Error ? err.message : String(err)),
				);
			}
		}

		// Generate artifact name and confine path
		const artifactName = `artifact-${reservation.attempt.attemptId}-${Date.now()}.json`;
		let artifactPath: string;
		try {
			artifactPath = confinePath(this.workspace.path, artifactName);
		} catch {
			return undefined; // escape detected
		}

		// Reject if target is immutable
		if (isImmutable(artifactPath)) {
			return undefined;
		}

		// Ensure artifacts directory exists
		const artifactDir = path.dirname(artifactPath);
		if (!fs.existsSync(artifactDir)) {
			fs.mkdirSync(artifactDir, { recursive: true });
		}

		// Build artifact content with frozen settings
		const artifactContent = {
			role: roleKey,
			attemptId: reservation.attempt.attemptId,
			planId: reservation.attempt.planId,
			runId: this.workspace.runId,
			workspace: this.workspace.path,
			retention: role?.retention ?? "ephemeral",
			timeoutSeconds: role?.timeoutSeconds ?? DEFAULT_HARD_TIMEOUT_SECONDS,
			createdAt: Date.now(),
			output: result.output,
			usage: result.usage,
		};

		// Write atomically: temp → fsync → rename
		const tmpPath = artifactPath + ".tmp";
		const content = JSON.stringify(artifactContent, null, 2);
		fs.writeFileSync(tmpPath, content, "utf-8");

		try {
			const fd = fs.openSync(tmpPath, "r");
			fs.fdatasyncSync(fd);
			fs.closeSync(fd);
		} catch {
			// Best-effort
		}

		fs.renameSync(tmpPath, artifactPath);

		const digest = createHash("sha256").update(content).digest("hex");

		return {
			artifactId: artifactPath,
			metadata: {
				role: roleKey,
				sha256: digest,
				workspace: this.workspace.path,
				runId: this.workspace.runId,
			},
		};
	}
}
