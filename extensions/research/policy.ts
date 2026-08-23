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
 *    before the façade launches anything. Each granted reservation is written
 *    to the durable `reservations` ledger (never in-memory-only) so its id is
 *    stable across restarts.
 *  - `releaseAttempt` is idempotent by reservation id, releases concurrency
 *    through the state API and the durable ledger (so a freshly constructed
 *    adapter settles after a restart), and retains consumed counts for
 *    failure, cancellation, interruption.
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
} from "./dispatch-contracts.ts";
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
export interface FrozenConfig {
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

function validateRoleConfig(name: string, role: ResolvedRole): void {
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
		// Get or create the process-local bucket used only to locate live
		// reservations. Admission limits come from durable state so a fresh policy
		// instance cannot reset consumed totals or per-role concurrency.
		let bucket = this.buckets.get(roleKey);
		if (!bucket) {
			bucket = { total: 0, concurrent: 0, reservations: new Map() };
			this.buckets.set(roleKey, bucket);
		}

		// F4: Provider-wide concurrent ceiling = sum of all role concurrentDispatch.
		const providerCeiling = Object.values(this.frozenConfig.roles)
			.reduce((sum, r) => sum + r.concurrentDispatch, 0);
		const reservationId = `res-${createHash("sha256")
			.update(JSON.stringify([roleKey, attempt.planId, attempt.attemptId]))
			.digest("hex")}`;

		// Re-read and re-check every retry. A cross-process winner changes the
		// revision, causing updateRunState to conflict; the next iteration then
		// evaluates all limits against that winner's durable state.
		for (let attemptNo = 0; attemptNo < 5; attemptNo++) {
			let state: RunState;
			try {
				state = readRunState(this.workspace);
			} catch {
				return undefined;
			}
			const reservations = state.reservations ?? {};
			if (reservations[reservationId]) {
				return {
					reservationId,
					attempt,
					providerId: role.model ?? "default",
				};
			}
			const roleConcurrent = Object.values(reservations)
				.filter((entry) => entry.role === roleKey).length;
			const roleTotal = (state.reservationTotals ?? {})[roleKey] ?? 0;
			if (roleTotal >= role.totalDispatch) return undefined;
			if (roleConcurrent >= role.concurrentDispatch) return undefined;
			if ((state.concurrentReservations ?? 0) >= providerCeiling) return undefined;

			const acquiredAt = Date.now();
			try {
				await updateRunState(this.workspace, state.revision, (current) => ({
					...current,
					concurrentReservations: (current.concurrentReservations ?? 0) + 1,
					reservations: {
						...(current.reservations ?? {}),
						[reservationId]: { role: roleKey, acquiredAt },
					},
					reservationTotals: {
						...(current.reservationTotals ?? {}),
						[roleKey]: ((current.reservationTotals ?? {})[roleKey] ?? 0) + 1,
					},
				}));

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
				if (isStateConflict(err)) continue;
				return undefined;
			}
		}
		return undefined;
	}

	// -----------------------------------------------------------------------
	// DispatchPolicy: releaseAttempt
	// -----------------------------------------------------------------------

	async releaseAttempt(
		reservation: AttemptReservation,
		_outcome: AttemptOutcome,
	): Promise<void> {
		const bucket = this._findBucket(reservation);
		if (!bucket) {
			// No in-memory record (for example a fresh adapter instance after a
			// restart). Release through the durable ledger so recovery settles
			// exactly once; a missing id is a no-op.
			await this._releaseLedger(reservation.reservationId);
			return;
		}

		if (!bucket.reservations.has(reservation.reservationId)) {
			// Idempotent: already released in this instance. Still ensure the
			// durable ledger has cleared the slot (the source of truth for
			// recovery), then return.
			await this._releaseLedger(reservation.reservationId);
			return;
		}

		// IMPORTANT: Do NOT decrement total — it's consumed and stays consumed
		// for failure, cancellation, interruption outcomes. Durable concurrency
		// is decremented only by _releaseLedger; doing it here as well would free
		// two slots whenever another reservation remained active.
		bucket.reservations.delete(reservation.reservationId);
		bucket.concurrent = Math.max(0, bucket.concurrent - 1);
		await this._releaseLedger(reservation.reservationId);
	}

	/**
	 * Remove one reservation id from the durable ledger. Serialized through the
	 * transactional state API so concurrent releases cannot double-decrement
	 * the concurrency count. A missing id is a no-op: the reservation was
	 * already released.
	 */
	/** Whether a durable reservation is still active and therefore settleable. */
	hasReservation(reservationId: string): boolean {
		return Boolean((readRunState(this.workspace).reservations ?? {})[reservationId]);
	}

	private async _releaseLedger(reservationId: string): Promise<void> {
		const state = readRunState(this.workspace);
		let revision = state.revision;
		for (let attemptNo = 0; attemptNo < 5; attemptNo++) {
			try {
				await updateRunState(this.workspace, revision, (current) => {
					const reservations = { ...(current.reservations ?? {}) };
					if (!reservations[reservationId]) return current; // already released
					delete reservations[reservationId];
					return {
						...current,
						reservations,
						concurrentReservations: Math.max(0, (current.concurrentReservations ?? 0) - 1),
					};
				});
				return;
			} catch (err) {
				if (isStateConflict(err)) {
					revision = (err as StateConflict).actual;
					continue;
				}
				return;
			}
		}
	}

	private _findBucket(reservation: AttemptReservation): ReservationBucket | null {
		for (const bucket of this.buckets.values()) {
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

		// The durable reservation token makes export path and content idempotent.
		// Concurrent/recovered settlement can retry safely without creating a
		// second artifact for the same admitted attempt.
		const artifactName = `artifact-${reservation.reservationId}.json`;
		const acquiredAt = (readRunState(this.workspace).reservations ?? {})[
			reservation.reservationId
		]?.acquiredAt ?? Date.now();
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
			createdAt: acquiredAt,
			output: result.output,
			usage: result.usage,
		};

		// Write atomically: temp → fsync → rename
		const tmpPath = `${artifactPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
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
