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
 * /research supplies its own gates via extensions/research/completion.ts
 * (researchCompletionGate + finalizeSuccess) — Task 11.
 */
export function makeGenericPolicy(): CompletionPolicy {
	return {
		async audit(_state: Readonly<LoopState>): Promise<CompletionFailure[]> {
			return [];
		},
	};
}
