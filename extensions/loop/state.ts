/**
 * Generic loop state type and usage helpers.
 *
 * Research-specific fields (profile, workingDir, checkpointEvidence, etc.)
 * are included for compatibility but are NOT used by the generic engine.
 */

export type LoopStatus =
	| "active"
	| "paused"
	| "no_progress"
	| "complete"
	| "budget_limited";

export interface LoopUsage {
	coordinator: number;
	nested: number;
	total: number;
}

export interface LoopState {
	id: string;
	commandName: string; // "loop" | "research"
	programPath: string; // absolute path to the program file
	mission: string;
	rounds: number;
	maxRounds: number;
	tokensUsed: number;
	tokenBudget: number | null;
	status: LoopStatus;
	reason?: string;
	guardId: string;
	noProgressTurns: number;
	noProgressCount: number;
	lastFingerprint: string | null;
	updatedAt: number;
	// Generic usage tracking
	coordinatorUsage: number;
	nestedUsage: number;
	processedToolCallIds: string[];
	// Research-specific fields (kept for compatibility, not used by generic engine)
	profile?: string;
	workingDir?: string;
	programSig?: string;
	programInjected?: boolean;
	/** Program content snapshot captured on first read (F5: never reread during a run). */
	programSnapshot?: string;
	maxSearchesPerAgent?: number;
	maxFetchesPerAgent?: number;
	checkpointEvidence?: {
		runId: string;
		round: number;
		sources: number;
		scoreState: { satisfied: boolean; belowThreshold: string[] };
		verdict: "PROCEED" | "PROCEED_WITH_GAPS" | "CONTINUE";
	};
}

/**
 * Add coordinator-turn token usage to the loop state.
 * Called from the assistant turn's `turn_end` event handler.
 * When a toolCallId is provided, it is checked against processedToolCallIds
 * for replay deduplication: already-processed IDs are silently skipped.
 */
export function addCoordinatorUsage(
	state: LoopState,
	usage: unknown,
	toolCallId?: string,
): LoopState {
	// Dedup: skip if toolCallId already processed
	if (toolCallId && state.processedToolCallIds?.includes(toolCallId)) {
		return state;
	}
	const delta = tokenDelta(usage);
	const processedIds = state.processedToolCallIds ? [...state.processedToolCallIds] : [];
	if (toolCallId && !processedIds.includes(toolCallId)) {
		processedIds.push(toolCallId);
	}
	return {
		...state,
		coordinatorUsage: state.coordinatorUsage + delta,
		tokensUsed: state.tokensUsed + delta,
		updatedAt: Date.now(),
		processedToolCallIds: processedIds,
	};
}

/**
 * Add nested (subagent) token usage to the loop state.
 * Called from finalized `run_subagents` tool-result events.
 * When a toolCallId is provided, it is checked against processedToolCallIds
 * for replay deduplication: already-processed IDs are silently skipped.
 */
export function addNestedUsage(
	state: LoopState,
	usage: unknown,
	toolCallId?: string,
): LoopState {
	// Dedup: skip if toolCallId already processed
	if (toolCallId && state.processedToolCallIds?.includes(toolCallId)) {
		return state;
	}
	const delta = tokenDelta(usage);
	const processedIds = state.processedToolCallIds ? [...state.processedToolCallIds] : [];
	if (toolCallId && !processedIds.includes(toolCallId)) {
		processedIds.push(toolCallId);
	}
	return {
		...state,
		nestedUsage: state.nestedUsage + delta,
		tokensUsed: state.tokensUsed + delta,
		updatedAt: Date.now(),
		processedToolCallIds: processedIds,
	};
}

function tokenDelta(usage: unknown): number {
	if (!usage || typeof usage !== "object") return 0;
	const u = usage as Record<string, unknown>;
	if (typeof u.totalTokens === "number") return Math.max(0, u.totalTokens);
	const num = (k: string) =>
		typeof u[k] === "number" ? (u[k] as number) : 0;
	return Math.max(
		0,
		num("input") + num("output") + num("cacheRead") + num("cacheWrite"),
	);
}

/**
 * Normalize restored session state after upgrades (new fields get defaults).
 */
export function normalizeState(s: LoopState): LoopState {
	return {
		...s,
		profile: s.profile ?? "standard",
		guardId:
			s.guardId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
		noProgressTurns: s.noProgressTurns ?? 3,
		noProgressCount: s.noProgressCount ?? 0,
		lastFingerprint: s.lastFingerprint ?? null,
		coordinatorUsage: s.coordinatorUsage ?? 0,
		nestedUsage: s.nestedUsage ?? 0,
		processedToolCallIds: s.processedToolCallIds ?? [],
		maxSearchesPerAgent: s.maxSearchesPerAgent ?? 0,
		maxFetchesPerAgent: s.maxFetchesPerAgent ?? 0,
		// checkpointEvidence is invalidated on restore — only valid for current run.
		checkpointEvidence: undefined,
	};
}
