import type { LoopState } from "./state.ts";

export interface CompletionFailure {
	code: string;
	message: string;
}

export interface CompletionPolicy {
	audit(state: Readonly<LoopState>): Promise<CompletionFailure[]>;
}

/**
 * Default (generic) policy: always permits completion.
 * No verification gates for the generic /loop command.
 * Research supplies its own policy (e.g. with checkpoints and verification
 * artifacts) — Task 11 replaces the default for /research.
 */
export function makeGenericPolicy(): CompletionPolicy {
	return {
		async audit(_state: Readonly<LoopState>): Promise<CompletionFailure[]> {
			return [];
		},
	};
}
