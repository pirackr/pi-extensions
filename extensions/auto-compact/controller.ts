import type { ResolvedPolicy } from "./policy.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface EvaluateSnapshot {
	modelKey: string;
	contextWindow: number;
	usageTokens: number | null;
	policy: ResolvedPolicy;
}

export interface EvaluateResult {
	triggered: boolean;
}

export type GateReason = "manual" | "overflow" | "threshold";

export interface GateAttempt {
	reason: GateReason;
	tokens: number | null;
	policy: ResolvedPolicy | null;
}

export interface ControllerStatus {
	armed: boolean;
	inFlight: boolean;
	modelKey: string | null;
	lastPolicy: ResolvedPolicy | null;
	lastError: string | null;
	lastUsageTokens: number | null;
}

// ---------------------------------------------------------------------------
// AutoCompactController
// ---------------------------------------------------------------------------

/**
 * Session-local state machine for model-aware auto-compaction.
 *
 * Edge-triggered threshold semantics:
 * - Fires once when usage first reaches or exceeds the threshold.
 * - Stays disarmed while usage remains at or above the threshold.
 * - Rearms only after usage is observed below the threshold.
 * - A successful completion leaves it disarmed until reliable post-compaction
 *   usage is available and below threshold.
 * - A failure leaves it disarmed (no immediate retry loop).
 * - A model change resets and rearms evaluation for the new model.
 */
export class AutoCompactController {
	private modelKey: string | null = null;
	private armed = false;
	private inFlight = false;
	/** Set after recordComplete/recordFailure to prevent immediate re-trigger. */
	private awaitingBelowThreshold = false;
	private lastPolicy: ResolvedPolicy | null = null;
	private lastError: string | null = null;
	private lastUsageTokens: number | null = null;

	// ------------------------------------------------------------------
	// Session management
	// ------------------------------------------------------------------

	/**
	 * Reset session state for a new model. Clears armed/in-flight state and
	 * all last-known values. Call this on session_start or model_select, then
	 * follow with evaluate() to rearm for the new model.
	 */
	resetSession(modelKey: string): void {
		this.modelKey = modelKey;
		this.armed = false;
		this.inFlight = false;
		this.awaitingBelowThreshold = false;
		this.lastPolicy = null;
		this.lastError = null;
		this.lastUsageTokens = null;
	}

	// ------------------------------------------------------------------
	// Evaluation
	// ------------------------------------------------------------------

	/**
	 * Evaluate a usage snapshot against the resolved policy.
	 *
	 * - Skips silently when usageTokens is null/undefined.
	 * - Skips silently when policy is null or effectiveThresholdTokens is null.
	 * - Skips silently when policy.enabled is false.
	 * - Atomically marks in-flight when threshold is first crossed.
	 *
	 * Returns `{ triggered: true }` when compaction is initiated;
	 * `{ triggered: false }` otherwise.
	 */
	evaluate(snapshot: EvaluateSnapshot): EvaluateResult {
		const { modelKey: _mk, contextWindow: _cw, usageTokens, policy } =
			snapshot;

		// Fail-open: skip when usage is unknown.
		if (usageTokens === null || usageTokens === undefined) {
			return { triggered: false };
		}

		// Fail-open: skip when policy or threshold cannot be resolved.
		if (policy === null || policy.effectiveThresholdTokens === null) {
			return { triggered: false };
		}

		// Skip when the matched rule (or global setting) disables compaction.
		if (!policy.enabled) {
			return { triggered: false };
		}

		const threshold = policy.effectiveThresholdTokens;

		// Track last known state for status reporting.
		this.lastPolicy = policy;
		this.lastUsageTokens = usageTokens;

		if (this.armed) {
			if (usageTokens >= threshold) {
				if (!this.inFlight) {
					// Atomically arm → in-flight.
					this.inFlight = true;
					this.armed = false;
					return { triggered: true };
				}
				// Already in flight — dedupe.
				return { triggered: false };
			}
			// Still below threshold — stay armed.
			return { triggered: false };
		}

		// Disarmed state.
		if (this.inFlight) {
			// Still waiting for a previous compaction to complete.
			return { triggered: false };
		}

		if (this.awaitingBelowThreshold) {
			// Post-completion/failure: stay disarmed until usage drops below.
			if (usageTokens < threshold) {
				this.awaitingBelowThreshold = false;
				this.armed = true;
			}
			return { triggered: false };
		}

		if (usageTokens < threshold) {
			// Below threshold — arm and wait.
			this.armed = true;
			return { triggered: false };
		}

		// At or above threshold while disarmed (e.g. resumed session).
		// Fire immediately.
		this.inFlight = true;
		this.armed = false;
		return { triggered: true };
	}

	// ------------------------------------------------------------------
	// Gate
	// ------------------------------------------------------------------

	/**
	 * Gate a Pi compaction attempt.
	 *
	 * - "manual" → always allow.
	 * - "overflow" → always allow.
	 * - "threshold" + policy null → allow (fail open).
	 * - "threshold" + globally disabled (matchedPattern === "default", enabled=false) → allow.
	 * - "threshold" + disabled model rule (matchedPattern !== "default", enabled=false) → cancel.
	 * - "threshold" + threshold null → allow (fail open).
	 * - "threshold" + in flight → cancel (dedup).
	 * - "threshold" + tokens below effectiveThresholdTokens → cancel (premature).
	 * - "threshold" + tokens at/above effectiveThresholdTokens → allow.
	 */
	gate(attempt: GateAttempt): boolean {
		const { reason, tokens, policy } = attempt;

		if (reason === "manual" || reason === "overflow") {
			return true;
		}

		// reason === "threshold"
		if (policy === null) {
			return true; // fail open
		}

		if (!policy.enabled) {
			if (policy.matchedPattern === "default") {
				return true; // globally disabled — allow unchanged Pi behavior
			}
			return false; // disabled model rule — cancel
		}

		if (policy.effectiveThresholdTokens === null) {
			return true; // fail open
		}

		if (this.inFlight) {
			return false; // in-flight dedup
		}

		if (tokens === null || tokens === undefined) {
			return true; // fail open
		}

		return tokens >= policy.effectiveThresholdTokens;
	}

	// ------------------------------------------------------------------
	// Completion / failure
	// ------------------------------------------------------------------

	/**
	 * Record a successful compaction. Clears in-flight state and leaves the
	 * controller disarmed until usage is observed below the threshold again.
	 */
	recordComplete(): void {
		this.inFlight = false;
		this.armed = false;
		this.awaitingBelowThreshold = true;
		this.lastError = null;
	}

	/**
	 * Record a compaction failure. Clears in-flight state, records the error,
	 * and leaves the controller disarmed to avoid an immediate retry loop.
	 */
	recordFailure(error: unknown): void {
		this.inFlight = false;
		this.armed = false;
		this.awaitingBelowThreshold = true;
		this.lastError = error instanceof Error ? error.message : String(error);
	}

	/**
	 * Clear a triggered-but-unfired state so the next evaluate() can re-trigger
	 * at a safer point (e.g. the run was still active when the threshold was
	 * crossed, so no compact() was launched). Only call when no compaction was
	 * actually started; callers that launched a compact must use
	 * recordComplete/recordFailure instead.
	 */
	deferTrigger(): void {
		this.inFlight = false;
		this.armed = false;
		this.awaitingBelowThreshold = false;
	}

	// ------------------------------------------------------------------
	// Status
	// ------------------------------------------------------------------

	/**
	 * Return the current session-local controller state for /auto-compact.
	 */
	status(): ControllerStatus {
		return {
			armed: this.armed,
			inFlight: this.inFlight,
			modelKey: this.modelKey,
			lastPolicy: this.lastPolicy,
			lastError: this.lastError,
			lastUsageTokens: this.lastUsageTokens,
		};
	}
}
