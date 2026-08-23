/**
 * Research-owned ProfilePolicyAdapter (Task 14).
 *
 * This module is the single place where the owner-neutral generic
 * {@link ProfilePolicyAdapter} contract (`reserve` / `settle`) is adapted onto
 * the frozen {@link ResearchPolicy}. It deliberately imports only the generic,
 * owner-neutral reservation types from `../subagent` — never any generic
 * runtime internals or research workspace details leak through the adapter
 * boundary. The generic `subagent` extension stays research-free: it only ever
 * calls {@link ProfilePolicyAdapter.reserve} / {@link ProfilePolicyAdapter.settle}
 * with the neutral {@link ProfileReservation} / {@link ProfileSettlement}
 * payloads.
 *
 * Responsibilities:
 *  - Map `reserve(owner, profile, agentId)` to one
 *    {@link ResearchPolicy.reserveAttempt}, returning a durable,
 *    JSON-serializable {@link ProfileReservation} whose
 *    token is the policy reservation id (stable across restarts).
 *  - Map `settle(settlement)` to one idempotent
 *    {@link ResearchPolicy.releaseAttempt}, releasing concurrency exactly once
 *    after the terminal result is published and never restoring the consumed
 *    total.
 *  - Expose {@link registerResearchSubagentIntegration}, a minimal, explicit
 *    event-contribution seam that publishes one research-owned adapter without
 *    editing the generic loop, the research startup/config, packaged config,
 *    skills, or the legacy provider runtime. Profile contribution and
 *    startup/config migration are owned by Task 15.
 */

import type {
	ProfilePolicyAdapter,
	ProfileReservation,
	ProfileSettlement,
} from "../subagent/types.ts";
import type {
	AttemptOutcome,
	AttemptReservation,
	AttemptResult,
	ArtifactMetadata,
} from "./dispatch-contracts.ts";
import {
	ResearchPolicy,
	type FrozenConfig,
} from "./policy.ts";
import type { Workspace } from "./workspace.ts";

// ---------------------------------------------------------------------------
// Integration seam
// ---------------------------------------------------------------------------

/** One owner-owned policy adapter contributed by an owner. */
export interface PolicyAdapterContribution {
	/** Owner label (for example `"research"`). */
	readonly owner: string;
	/** The owner-neutral policy adapter. */
	readonly adapter: ProfilePolicyAdapter;
}

/**
 * Inputs for {@link createResearchPolicyAdapter}. The frozen role set and hard
 * timeout are the research manifest snapshot; the workspace binds the policy
 * to one active run so reservations and releases resolve its durable state.
 */
export interface ResearchAdapterDeps {
	/** The active research workspace whose durable state gates reservations. */
	readonly workspace: Workspace;
	/** Frozen manifest roles + hard timeout ceiling. */
	readonly frozenConfig: FrozenConfig;
}

/**
 * The event channel the research integration contributes policy adapters on.
 * Consumed by the generic subagent extension (Task 15); the channel name is
 * owner-neutral so no generic runtime import is required here.
 */
export const POLICY_ADAPTERS_CHANNEL = "subagent:register-policy-adapters";

/** Minimal synchronous events bus needed by {@link registerResearchSubagentIntegration}. */
export interface IntegrationEvents {
	readonly events: {
		emit(channel: string, data: { contributions: PolicyAdapterContribution[] }): void;
	};
}

/**
 * Register the research-owned policy adapter contribution on the generic
 * subagent integration channel. This is a pure, side-effecting primitive that
 * publishes the adapter for later consumption by the generic lifecycle; it does
 * not register profiles, touch the loop, or migrate config (Task 15 owns
 * those).
 */
export function registerResearchSubagentIntegration(
	pi: IntegrationEvents,
	deps: ResearchAdapterDeps & { readonly owner?: string },
): void {
	const owner = deps.owner ?? "research";
	const adapter = createResearchPolicyAdapter(deps);
	pi.events.emit(POLICY_ADAPTERS_CHANNEL, {
		contributions: [{ owner, adapter }],
	});
}

// ---------------------------------------------------------------------------
// State → attempt-outcome mapping
// ---------------------------------------------------------------------------

/**
 * Map the generic owner-neutral terminal state onto the dispatch-neutral
 * {@link AttemptOutcome}. `timed_out` is reported as a failed attempt; the
 * remaining terminal states map onto their own outcome status.
 */
function toAttemptOutcome(
	settlement: ProfileSettlement,
): AttemptOutcome {
	const { state, terminalReason } = settlement;
	if (state === "succeeded") {
		return {
			status: "completed",
			result: {
				output: settlement.result.output,
				usage: { totalTokens: settlement.result.usage.totalTokens },
			},
		};
	}
	// AttemptFailed.status is "failed" | "cancelled" | "interrupted".
	const status = state === "timed_out" ? "failed" : state;
	return {
		status,
		error: { message: terminalReason ?? state },
	};
}

// ---------------------------------------------------------------------------
// ProfilePolicyAdapter — research-owned
// ---------------------------------------------------------------------------

/**
 * The research-owned {@link ProfilePolicyAdapter}: a thin, owner-neutral
 * adaptation of {@link ResearchPolicy}. `reserve` returns durable reservation
 * metadata; `settle` releases it exactly once after terminal publication.
 */
export interface ResearchProfilePolicyAdapter extends ProfilePolicyAdapter {
	/**
	 * Re-exported frozen-artifact export so the research retention/export
	 * contract stays reachable through the owner-neutral adapter surface.
	 */
	exportArtifact(
		reservation: ProfileReservation,
		result: AttemptResult,
	): Promise<ArtifactMetadata | undefined>;
}

/**
 * Build the research-owned adapter bound to one workspace + frozen manifest.
 * The returned adapter is a new object each call, so a fresh instance can
 * recover and settle reservations after a restart (the reservation id is the
 * durable identity, not an in-memory reference).
 */
export function createResearchPolicyAdapter(
	deps: ResearchAdapterDeps,
): ResearchProfilePolicyAdapter {
	const policy = new ResearchPolicy(
		deps.workspace,
		deps.frozenConfig,
		deps.frozenConfig.hardTimeoutSeconds,
	);

	/**
	 * Build a dispatch-neutral attempt whose role is the generic profile name.
	 * Research contributes profiles whose names match manifest roles, so the
	 * profile name doubles as the role key the policy uses to select a role.
	 */
	const attemptFor = (owner: string, profile: string, agentId: string) => ({
		attemptId: agentId,
		planId: `agent-${owner}-${profile}`,
		index: 0,
		taskInfo: { role: profile },
	});

	return {
		async reserve(owner: string, profile: string, agentId: string): Promise<ProfileReservation | undefined> {
			const reservation = await policy.reserveAttempt(attemptFor(owner, profile, agentId));
			if (!reservation) return undefined;
			return {
				owner,
				profile,
				token: reservation.reservationId,
				acquiredAt: Date.now(),
			};
		},

		async settle(settlement: ProfileSettlement): Promise<void> {
			const { owner, profile, reservation } = settlement;
			// The durable ledger is the idempotency source of truth. Once absent,
			// both export and release have already completed for this token.
			if (!policy.hasReservation(reservation.token)) return;
			const attempt = attemptFor(owner, profile, settlement.agentId);
			const release: AttemptReservation = {
				reservationId: reservation.token,
				attempt,
				providerId: profile,
			};
			const outcome = toAttemptOutcome(settlement);
			try {
				if (outcome.status === "completed") {
					await policy.exportArtifact(release, outcome.result);
				}
			} finally {
				// Admission totals stay consumed and concurrency must be released for
				// every terminal outcome, even when retention/export itself fails.
				await policy.releaseAttempt(release, outcome);
			}
		},

		exportArtifact(
			reservation: ProfileReservation,
			result: AttemptResult,
		): Promise<ArtifactMetadata | undefined> {
			return policy.exportArtifact(
				{
					reservationId: reservation.token,
					attempt: {
						attemptId: `att-${reservation.owner}-${reservation.profile}-${reservation.token}`,
						planId: `plan-${reservation.owner}-${reservation.profile}`,
						index: 0,
						taskInfo: { role: reservation.profile },
					},
					providerId: reservation.profile,
				} as AttemptReservation,
				result,
			);
		},
	};
}

export type { Workspace };
