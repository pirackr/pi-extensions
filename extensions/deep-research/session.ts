/**
 * Shared state for the active /research session's per-agent web budgets.
 *
 * 0 = unlimited. `null` = no active research session (run_subagents falls back
 * to its config defaults / task args).
 *
 * The loop sets this when a research run starts and clears it when the run
 * ends (complete / cleared / budget_limited). A session_start restore
 * re-populates it from the persisted LoopState so the cap survives a reload.
 */
let activeMaxSearchesPerAgent: number | null = null;
let activeMaxFetchesPerAgent: number | null = null;

export function setActiveResearchBudgets(
	searches: number | null,
	fetches: number | null,
): void {
	activeMaxSearchesPerAgent = searches;
	activeMaxFetchesPerAgent = fetches;
}

export function getActiveResearchBudgets(): {
	maxSearchesPerAgent: number | null;
	maxFetchesPerAgent: number | null;
} {
	return {
		maxSearchesPerAgent: activeMaxSearchesPerAgent,
		maxFetchesPerAgent: activeMaxFetchesPerAgent,
	};
}

export function clearActiveResearchBudgets(): void {
	activeMaxSearchesPerAgent = null;
	activeMaxFetchesPerAgent = null;
}
