/**
 * Subagent dispatch contract — types and interfaces.
 *
 * This module owns the shared type definitions that the registry, façade,
 * provider implementations, and tests all import.
 */

// ---------------------------------------------------------------------------
// Core outcome / error types
// ---------------------------------------------------------------------------

export interface SerializedError {
	message: string;
	code?: string;
	stack?: string;
	[key: string]: unknown;
}

export type AttemptOutcomeStatus =
	| "completed"
	| "failed"
	| "cancelled"
	| "interrupted";

export interface AttemptCompleted {
	status: "completed";
	result: AttemptResult;
}

export interface AttemptFailed {
	status: "failed" | "cancelled" | "interrupted";
	error: SerializedError;
}

/** Normalised result of any physical attempt — the façade normalises
 * returns/throws/aborts into this union. */
export type AttemptOutcome = AttemptCompleted | AttemptFailed;

// ---------------------------------------------------------------------------
// Attempt result (what a provider returns on success)
// ---------------------------------------------------------------------------

export interface AttemptResult {
	/** Arbitrary structured output — typically tool results or artifacts. */
	output: unknown;
	/** Token usage reported by the provider, if available. */
	usage?: AttemptUsage;
	/** Optional metadata the provider wishes to attach. */
	metadata?: Record<string, unknown>;
}

export interface AttemptUsage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	totalTokens: number;
	cost?: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

// ---------------------------------------------------------------------------
// Provider descriptor (discovered via EventBus)
// ---------------------------------------------------------------------------

/**
 * Metadata about a provider implementation — discovered via pi.events
 * collection envelopes. Each provider registers one descriptor.
 *
 * - `id` is a unique, immutable identifier for this provider instance.
 * - `adapterVersion` identifies the subagent-dispatch adapter version.
 * - `protocolVersion` / `executionSpecVersion` are optional version signals.
 * - `capabilities` lists string capabilities (e.g. "tmux", "remote", "local").
 * - `maxConcurrentAttempts` hard ceiling on simultaneous attempts.
 * - `maxAttemptsPerTask` hard ceiling on attempts for a single task.
 */
export interface ProviderDescriptor {
	id: string;
	adapterVersion: string;
	protocolVersion?: string;
	executionSpecVersion?: string;
	capabilities: string[];
	maxConcurrentAttempts?: number;
	maxAttemptsPerTask?: number;
}

// ---------------------------------------------------------------------------
// Discovery envelope — what providers publish when the façade collects them
// ---------------------------------------------------------------------------

/**
 * A provider published during discovery. Carries the descriptor plus an
 * optional instance so the façade can both negotiate capabilities and
 * execute attempts without a second lookup or factory call.
 */
export interface DiscoveredProvider {
	descriptor: ProviderDescriptor;
	/** Optional provider instance (implements executeAttempt). */
	instance?: SubagentProvider;
}

// ---------------------------------------------------------------------------
// SubagentProvider — implemented by adapter code
// ---------------------------------------------------------------------------

/**
 * A single subagent-dispatch provider adapter.
 *
 * - `descriptor` is read-only and stable for the lifetime of the adapter.
 * - `executeAttempt` is called exactly once per attempt — no hidden retries.
 *   The provider must not implement its own retries; retries are the façade's
 *   responsibility.
 */
export interface SubagentProvider {
	readonly descriptor: ProviderDescriptor;
	executeAttempt(
		plan: ResolvedAttempt,
		signal: AbortSignal,
	): Promise<AttemptResult>;
}

// ---------------------------------------------------------------------------
// Dispatch policy — owns reservation, resolution, claims, and export
// ---------------------------------------------------------------------------

export interface DispatchContext {
	/** Arbitrary context the policy can use to decide whether to claim. */
	readonly context: Record<string, unknown>;
}

export interface RequestedPlan {
	/** Provider the caller wants to use (may be null for auto). */
	providerId: string | null;
	/** Capabilities required by the task. */
	requiredCapabilities: string[];
	/** Number of concurrent attempts needed. */
	concurrency: number;
	/** Total attempts planned (after batching expansion). */
	totalAttempts: number;
	/** Active research policy forces a frozen provider if set. */
	activePolicy?: string | null;
}

export interface ResolvedDispatch {
	/** The provider that will handle this dispatch. */
	providerId: string;
	/** The descriptor the provider published. */
	descriptor: ProviderDescriptor;
	/** Expanded attempts after batching. */
	attempts: ResolvedAttempt[];
	/** Total attempts after expansion. */
	totalAttempts: number;
}

export interface ResolvedAttempt {
	attemptId: string;
	planId: string;
	index: number;
	taskInfo?: Record<string, unknown>;
}

export interface AttemptReservation {
	reservationId: string;
	attempt: ResolvedAttempt;
	providerId: string;
}

export interface ArtifactMetadata {
	/** Path or identifier of the exported artifact. */
	artifactId: string;
	/** Arbitrary metadata the façade should pass through. */
	metadata?: Record<string, unknown>;
}

/**
 * Dispatch policy owns:
 *  - `claim` — does this policy handle the given context?
 *  - `resolve` — expands the plan, selects a provider.
 *  - `reserveAttempt` — called before every physical launch.
 *  - `releaseAttempt` — called exactly once in finally for every successful reservation.
 *  - `exportArtifact` — called for successful (completed) attempts.
 */
export interface DispatchPolicy {
	claim(context: DispatchContext): Promise<boolean>;
	resolve(plan: RequestedPlan): Promise<ResolvedDispatch>;
	reserveAttempt(attempt: ResolvedAttempt): Promise<AttemptReservation>;
	releaseAttempt(
		reservation: AttemptReservation,
		outcome: AttemptOutcome,
	): Promise<void>;
	exportArtifact(
		reservation: AttemptReservation,
		result: AttemptResult,
	): Promise<ArtifactMetadata | undefined>;
}

// ---------------------------------------------------------------------------
// Façade contract (what the façade module exports)
// ---------------------------------------------------------------------------

/**
 * Runtime provider-capability validator — consumed by Task 9.
 * Not part of configuration resolution.
 *
 * @param registry   the set of registered providers
 * @param selection  the providerId the caller requested (null = auto)
 * @param requirements capability requirements for this dispatch
 * @returns { providerId, descriptor } or throws if negotiation fails
 */
export function negotiateProvider(
	registry: ReadonlyArray<ProviderDescriptor>,
	selection: string | null,
	requirements: string[],
): { providerId: string; descriptor: ProviderDescriptor } {
	// Default: if no specific provider selected, return the first provider
	// that satisfies all requirements.
	if (selection) {
		const found = registry.find((p) => p.id === selection);
		if (!found) {
			throw new Error(`Provider "${selection}" not found in registry`);
		}
		const missing = requirements.filter(
			(req) => !found.capabilities.includes(req),
		);
		if (missing.length > 0) {
			throw new Error(
				`Provider "${selection}" lacks capabilities: ${missing.join(", ")}`,
			);
		}
		return { providerId: selection, descriptor: found };
	}

	// Auto: find first provider that satisfies all requirements
	const match = registry.find((p) =>
		requirements.every((req) => p.capabilities.includes(req)),
	);
	if (!match) {
		throw new Error(
			`No provider found satisfying capabilities: ${requirements.join(", ")}`,
		);
	}
	return { providerId: match.id, descriptor: match };
}
