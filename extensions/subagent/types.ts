// Durable public contracts for the `subagent` extension.
//
// This module freezes the type/state surface that every later task
// (storage, scheduler, runner, manager, UI, registration) consumes. It is
// intentionally dependency-free and fully JSON-serializable so that manifests,
// profile snapshots, and delivery records can be written to durable storage
// and later reconciled without importing any runtime dependency.
//
// It owns nothing research-specific: profiles are owner-neutral snapshots and
// are contributed by generic providers (including research) through
// {@link ProfileContribution}.

/**
 * Lifecycle state of a single subagent task.
 *
 * The only legal edges between these states are enforced by
 * {@link assertTransition}; see the state machine in the design spec:
 *
 * ```
 * queued → starting → running → succeeded
 *                             → failed
 *                             → timed_out
 *                             → cancelled
 *                             → interrupted
 * queued → cancelled
 * ```
 */
export type TaskStatus =
	| "queued"
	| "starting"
	| "running"
	| "succeeded"
	| "failed"
	| "timed_out"
	| "cancelled"
	| "interrupted";

/** Tool access level, shared with the config/type surface. */
export type AgentAccess = "read" | "shell" | "write";

/**
 * A resolved profile snapshot captured at enqueue time.
 *
 * Snapshotting at enqueue means later configuration or profile edits never
 * mutate queued or running work. It is owner-neutral (no research imports) and
 * fully serializable so it can live inside a durable manifest.
 */
export interface ResolvedProfile {
	readonly name: string;
	readonly description: string;
	readonly model: string;
	readonly thinking: string;
	readonly tools: string[];
	readonly access: AgentAccess;
	readonly timeoutSeconds: number;
	readonly systemPrompt: string;
	readonly source: string;
}

/**
 * A generic, owner-contributed profile descriptor. Other extensions (including
 * research) append already-resolved descriptors with an owner ID through this
 * contract; the subagent extension never interprets the owner.
 */
export interface ProfileContribution {
	readonly owner: string;
	readonly profile: ResolvedProfile;
}

/**
 * Durable, JSON-serializable metadata returned by
 * {@link ProfilePolicyAdapter.reserve}. The scheduler/persistence layer writes
 * this to disk so the same reservation can be released idempotently after a
 * crash; it is intentionally owner-neutral and research-free.
 */
export interface ProfileReservation {
	/** Owner that acquired the reservation. */
	readonly owner: string;
	/** Reserved profile name. */
	readonly profile: string;
	/** Idempotency token; repeated admission for the same owner/profile/agent matches. */
	readonly token: string;
	/** Epoch milliseconds the reservation was first acquired. */
	readonly acquiredAt: number;
}

/**
 * Generic, owner-neutral terminal context handed to
 * {@link ProfilePolicyAdapter.settle}. It carries only enough information for
 * an owner to release its reservation, retain artifacts, and export results
 * idempotently — never research-specific data. Owners interpret it through
 * their own {@link ProfilePolicyAdapter}; the subagent extension does not.
 */
export interface ProfileSettlement {
	/** Owner that holds the reservation. */
	readonly owner: string;
	/** Reserved profile name the settlement resolves. */
	readonly profile: string;
	/** Settled task identifier. */
	readonly agentId: string;
	/** Terminal lifecycle state. */
	readonly state: TerminalResult["state"];
	/** Human-readable terminal reason, or `null`. */
	readonly terminalReason: string | null;
	/**
	 * The durable, JSON-serializable reservation this settlement releases.
	 * The owner releases it exactly once by this token; the generic surface
	 * never interprets it beyond passing it to the owner.
	 */
	readonly reservation: ProfileReservation;
	/**
	 * Confined artifact path for the settled task, when one exists. Passed
	 * owner-neutral so the owner can retain/export idempotently.
	 */
	readonly artifactPath: string | null;
	/** Durable terminal result, published before settlement is attempted. */
	readonly result: TerminalResult;
}

/**
 * Owner-neutral concurrency/reservation policy contract.
 *
 * This is the shared durable type that Task 1 freezes and Task 4 instantiates:
 * `types.ts` owns the contract, the configuration layer builds in-memory
 * adapters, and later tasks consume it. The generic subagent extension never
 * interprets an owner's policy — it only calls {@link reserve} at enqueue and
 * {@link settle} at settlement, both of which are idempotent.
 */
export interface ProfilePolicyAdapter {
	/**
	 * Acquire a concurrency reservation for `profile`, owned by `owner`.
	 *
	 * Resolves to durable, JSON-serializable reservation metadata the
	 * persistence layer can write to disk. Idempotent for the same
	 * `(owner, profile, agentId)`: re-serving an existing reservation must not
	 * count concurrency twice, while a different agent gets a distinct slot.
	 */
	reserve(
		owner: string,
		profile: string,
		agentId: string,
	): Promise<ProfileReservation | undefined>;

	/**
	 * Release the reservation and — when the owner's policy requires it —
	 * retain and export the settled artifacts.
	 *
	 * Receives only generic {@link ProfileSettlement}; the owner never sees
	 * research-specific data here. Idempotent: a settlement that has already
	 * been applied is a no-op on a second call.
	 */
	settle(settlement: ProfileSettlement): Promise<void>;
}

/**
 * A single task assembled for notification rendering: the terminal result and
 * its manifest's profile summary. Produced by the notification coordinator from
 * durable `result.json` / `status.json` and rendered to XML.
 */
export interface NotificationItem {
	readonly agentId: string;
	readonly state: TerminalResult["state"];
	readonly summary: string;
	readonly output: string;
	readonly usage: Usage;
}

/**
 * The normalized input contract for the `Agent` tool.
 *
 * `description` is a short UI label (never the whole prompt), `prompt` is the
 * complete task contract, `subagent_type` selects a configured profile, and
 * `run_in_background` defaults to `true`.
 */
export interface AgentRequest {
	readonly description: string;
	readonly prompt: string;
	readonly subagent_type: string;
	readonly run_in_background: boolean;
}

/**
 * Coerce a loose caller-supplied request into a strict, frozen
 * {@link AgentRequest}.
 *
 * Required string fields are validated; `run_in_background` defaults to `true`
 * when omitted or `null`. This is the single source of truth for background
 * defaulting and must not be duplicated elsewhere.
 *
 * @throws when any required field is missing or not a non-empty string, or when
 *   `run_in_background` is present but not a boolean.
 */
export function normalizeAgentRequest(
	input: unknown,
): AgentRequest {
	if (typeof input !== "object" || input === null) {
		throw new Error("agent request must be an object");
	}

	const raw = input as Record<string, unknown>;

	if (typeof raw.description !== "string" || raw.description.length === 0) {
		throw new Error("description is required and must be a non-empty string");
	}
	if (typeof raw.prompt !== "string" || raw.prompt.length === 0) {
		throw new Error("prompt is required and must be a non-empty string");
	}
	if (
		typeof raw.subagent_type !== "string" ||
		raw.subagent_type.length === 0
	) {
		throw new Error(
			"subagent_type is required and must be a non-empty string",
		);
	}

	const runInBackground = normalizeRunInBackground(raw.run_in_background);

	return Object.freeze({
		description: raw.description,
		prompt: raw.prompt,
		subagent_type: raw.subagent_type,
		run_in_background: runInBackground,
	});
}

function normalizeRunInBackground(value: unknown): boolean {
	if (value === undefined || value === null) {
		return true;
	}
	if (typeof value !== "boolean") {
		throw new Error("run_in_background must be a boolean");
	}
	return value;
}

/**
 * Returns `true` only for a four-character, lowercase, collision-free
 * identifier such as `a7k2` or `q9xm` (lowercase `a-z0-9`).
 */
export function isShortId(value: unknown): value is string {
	return typeof value === "string" && /^[a-z0-9]{4}$/.test(value);
}

/**
 * Legal lifecycle edges keyed by source state. The runner is the sole writer of
 * terminal states; the manager may write `interrupted` only after reconciling a
 * nonterminal task.
 */
const ALLOWED_TRANSITIONS: Partial<Record<TaskStatus, readonly TaskStatus[]>> =
{
	queued: ["starting", "cancelled"],
	starting: ["running"],
	running: ["succeeded", "failed", "timed_out", "cancelled", "interrupted"],
};

/**
 * Throw unless `from → to` is an allowed lifecycle edge. Terminal states accept
 * no outgoing transition, so any edge out of them throws.
 *
 * @throws `illegal state transition: <from> → <to>` for forbidden edges.
 */
export function assertTransition(from: TaskStatus, to: TaskStatus): void {
	const allowed = ALLOWED_TRANSITIONS[from];
	if (allowed === undefined || !allowed.includes(to)) {
		throw new Error(`illegal state transition: ${from} → ${to}`);
	}
}

/** Usage and cost collected at settlement, matching the notification schema. */
export interface Usage {
	readonly totalTokens: number;
	readonly toolUses: number;
	readonly durationMs: number;
}

/**
 * The final captured output of a settled task. Published before the terminal
 * `status.json`, making terminal status the commit marker.
 */
export interface TerminalResult {
	readonly agentId: string;
	readonly state: "succeeded" | "failed" | "timed_out" | "cancelled" |
		"interrupted";
	readonly output: string;
	readonly usage: Usage;
	readonly finishedAt: number;
	readonly terminalReason: string | null;
}

/**
 * A partial, runtime status update merged into an existing durable manifest.
 * Only the fields supplied are changed; the rest of the durable manifest is
 * preserved. This is the single contract shared by the durable store and the
 * scheduler's generation-checked `mutate`. Monotonic revision enforcement is
 * owned by the store that writes it.
 */
export interface StatusUpdate {
	/** Task whose manifest is being updated. Required so a write targets one record. */
	readonly agentId: string;
	/** Optional explicit revision; defaults to stored revision + 1 (monotonic). */
	readonly revision?: number;
	readonly state?: TaskStatus;
	readonly startedAt?: number | null;
	readonly heartbeatAt?: number | null;
	readonly finishedAt?: number | null;
	readonly runnerPid?: number | null;
	readonly tmuxWindow?: string | null;
	readonly terminalReason?: string | null;
	readonly sequence?: number;
}

/** Durable FIFO queue is the set of task manifests with state `queued`. */
export type QueueState = "queued";

/** Delivery lifecycle of a group notification (at-most-once dispatch). */
export type DeliveryState = "pending" | "dispatching" | "delivered" | "consumed";

/**
 * Independent-of-artifacts delivery tracking. Serialized with result
 * consumption; `dispatching` is persisted before sending so a crash in the
 * tiny interval is treated as already-attempted.
 */
export interface DeliveryRecord {
	readonly groupId: string;
	readonly agentIds: string[];
	readonly state: DeliveryState;
	readonly notificationId: string;
	readonly createdAt: number;
	readonly dispatchedAt: number | null;
	readonly consumedAt: number | null;
}

/**
 * Durable record for a single notification group, atomically written to
 * `groups/<group-id>.json` under the registry lease. The grouped-notification
 * coordinator owns these records; {@link ArtifactStore} persists them.
 */
export interface GroupRecord {
	/** Path-safe, derived identifier for the group. */
	readonly groupId: string;
	/** Origin conversation this group belongs to; used for `/new` suppression. */
	readonly origin: string;
	/** Manager generation that allocated the group. */
	readonly managerGeneration: string;
	/** Background turn index the group was allocated for. */
	readonly turnIndex: number;
	/** Nonce that disambiguates same-turn groups. */
	readonly nonce: string;
	/** Epoch milliseconds the group was allocated. */
	readonly createdAt: number;
	/** Epoch milliseconds the group ended, or `null` while active. */
	readonly endedAt: number | null;
}

/**
 * Durable manifest for a single task. Every field is present at publication;
 * nullable fields stay `null` until the relevant lifecycle point. The resolved
 * profile is snapshotted at enqueue and never mutated afterward.
 */
export interface AgentManifest {
	/** Schema version; bump only on breaking durable-shape changes. */
	readonly schema: number;
	/**
	 * Monotonic-or-random generation token distinguishing successive durable
	 * publishes of this record (see spec security requirements). Required so
	 * stale reclamation and generation checks converge on one winner.
	 */
	readonly generation: string;
	/** Monotonic revision under a short-lived registry lease. */
	readonly revision: number;
	readonly parentId: string;
	readonly agentId: string;
	/** Present only for explicitly enabled nested tasks. */
	readonly parentAgentId: string | null;
	/**
	 * Top-level ownership-tree id this task runs in. A top-level task uses its
	 * own `agentId`; every descendant carries the same root id. Task 9 populates
	 * this field before publication when nested enqueue is wired.
	 */
	readonly ownershipTreeId: string;
	/** Immutable origin conversation UUID. */
	readonly origin: string;
	/** Notification group token, or `null` for foreground tasks. */
	readonly groupId: string | null;
	readonly description: string;
	readonly prompt: string;
	readonly profile: ResolvedProfile;
	readonly state: TaskStatus;
	/** Monotonic FIFO sequence allocated under a registry lease. */
	readonly sequence: number;
	readonly queuedAt: number;
	readonly startedAt: number | null;
	readonly heartbeatAt: number | null;
	readonly finishedAt: number | null;
	readonly runnerPid: number | null;
	/** Process-start identity of the runner process group. */
	readonly processStart: string;
	readonly tmuxSession: string | null;
	readonly tmuxWindow: string | null;
	readonly timeoutSeconds: number | null;
	readonly terminalReason: string | null;
	/**
	 * Owner-neutral reservation captured at enqueue from the owning adapter's
	 * `reserve` return. Persisted verbatim so the scheduler can settle it on
	 * terminal detection or recovery, including after a restart. `null` (or
	 * absent) when no owner reserved (generic profiles).
	 */
	readonly reservation?: ProfileReservation | null;
}

/**
 * Returned by a background `Agent` call: durable enqueue confirmation plus,
 * when a window has started, the tmux target and artifact path.
 */
export interface AgentReceipt {
	readonly agentId: string;
	readonly state: TaskStatus;
	readonly tmuxSession: string | null;
	readonly tmuxWindow: string | null;
	readonly attachCommand: string | null;
	readonly artifactDir: string | null;
}

/**
 * Returned by `get_subagent_result`. Terminal results carry the complete
 * captured output; non-terminal results carry live activity, elapsed time, and
 * usage. `notFound` scopes the result to the current parent registry.
 */
export interface ResultResponse {
	readonly agentId: string;
	readonly state: TaskStatus;
	readonly result: TerminalResult | null;
	readonly activity: string | null;
	readonly elapsedMs: number | null;
	readonly usage: Usage | null;
	readonly tmuxTarget: string | null;
	readonly artifactDir: string | null;
	readonly consumed: boolean;
	readonly notFound: boolean;
}

/** Returned by `stop_subagent`. */
export interface StopResponse {
	readonly agentId: string;
	readonly state: TaskStatus;
	readonly stopped: boolean;
	readonly message: string;
}
