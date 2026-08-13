/**
 * Core loop engine: state persistence, continuation scheduling,
 * budget enforcement, and no-progress detection.
 *
 * Research-specific behavior (profiles, scores, verification gates)
 * is kept OUT of this module.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LoopState, LoopStatus, LoopUsage } from "./state.ts";
import type { CompletionPolicy, CompletionFailure } from "./completion.ts";
import { addCoordinatorUsage } from "./state.ts";
import { programBlockFor, extractAssistantText, assistantFingerprint } from "./program.ts";

const CUSTOM_TYPE = "pi-loop";
const EVENT_TYPE = "pi-loop-event";

export interface LoopEngineOptions {
	completionPolicy: CompletionPolicy;
	onStateChange(state: LoopState): Promise<void>;
	/** Called after each round increment. Return a (possibly modified) state. */
	onRoundIncrement?: (state: LoopState) => LoopState;
}

export class LoopEngine {
	private loop: LoopState | null = null;
	private _continuationQueued = false;
	private _activeThisTurn = false;
	private _continuationTurnPending = false;
	private _thisTurnIsContinuation = false;

	constructor(
		private readonly options: LoopEngineOptions,
	) {}

	get state(): LoopState | null {
		return this.loop;
	}

	set state(s: LoopState | null) {
		this.loop = s;
	}

	get completionPolicy(): CompletionPolicy {
		return this.options.completionPolicy;
	}

	get usage(): LoopUsage {
		const s = this.loop;
		if (!s) return { coordinator: 0, nested: 0, total: 0 };
		return {
			coordinator: s.coordinatorUsage,
			nested: s.nestedUsage,
			total: s.coordinatorUsage + s.nestedUsage,
		};
	}

	// ---- persistence -------------------------------------------------------

	persist(pi: ExtensionAPI, ctx: ExtensionContext): void {
		pi.appendEntry(CUSTOM_TYPE, { loop: this.loop });
		this.syncLoopTools(pi);
		this.updateStatus(ctx);
	}

	latestState(ctx: ExtensionContext): LoopState | null {
		const entries =
			ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const e = entries[i];
			if (e?.type === "custom" && e.customType === CUSTOM_TYPE) {
				return (e.data as { loop?: LoopState | null } | undefined)?.loop ?? null;
			}
		}
		return null;
	}

	getStatusLine(): string {
		return this.statusLine(this.loop) ?? "";
	}

	// ---- event handling -----------------------------------------------------

	/** Call at the start of each turn. */
	startTurn(): void {
		this._activeThisTurn = this.loop?.status === "active";
		this._thisTurnIsContinuation = this._continuationTurnPending;
		this._continuationTurnPending = false;
	}

	/** Call at turn_end to account for tokens, check budgets, detect no-progress. */
	async endTurn(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		event: unknown,
	): Promise<void> {
		if (!this.loop || !this._activeThisTurn) return;
		let state = this.loop;
		const usage = (event as { message?: { usage?: unknown } }).message?.usage;

		// F3: Wire addCoordinatorUsage for assistant-turn usage
		state = addCoordinatorUsage(state, usage);

		// Token budget check (tokensUsed already updated by addCoordinatorUsage)
		if (state.tokenBudget != null && state.tokensUsed >= state.tokenBudget) {
			state = {
				...state,
				status: "budget_limited" as LoopStatus,
				reason: "tokens",
				updatedAt: Date.now(),
			};
			this.loop = state;
			await this.persistAndEmit(pi, ctx, state, "budget_limited");
			return;
		}

		// No-progress guard (continuation rounds only)
		if (
			this._thisTurnIsContinuation &&
			state.noProgressTurns > 0 &&
			state.status === "active"
		) {
			const ev = event as { message?: unknown; toolResults?: unknown[] };
			const toolRan =
				Array.isArray(ev.toolResults) && ev.toolResults.length > 0;
			const fingerprint = assistantFingerprint(ev.message);
			let count = state.noProgressCount ?? 0;
			if (toolRan) {
				count = 0;
			} else if (
				fingerprint === "" ||
				(state.lastFingerprint != null && fingerprint === state.lastFingerprint)
			) {
				count += 1;
			} else {
				count = 1;
			}
			state = {
				...state,
				noProgressCount: count,
				lastFingerprint: fingerprint,
				updatedAt: Date.now(),
			};
			if (count >= state.noProgressTurns) {
				state = {
					...state,
					status: "no_progress" as LoopStatus,
					updatedAt: Date.now(),
				};
				this.loop = state;
				await this.persistAndEmit(pi, ctx, state, "no_progress");
				return;
			}
		}

		this.loop = state;
		await this.persist(pi, ctx);
	}

	/** Call from `agent_end` handler — queues continuation only from agent_settled. */
	onAgentEnd(pi: ExtensionAPI, ctx: ExtensionContext): void {
		if (!this.loop || this.loop.status !== "active" || ctx.hasPendingMessages())
			return;
		this.queueContinuation(pi, ctx);
	}

	// ---- command helpers ----------------------------------------------------

	/**
	 * Build /resume state: fresh guard epoch + reset no-progress counters.
	 */
	resumeState(now: number): LoopState {
		if (!this.loop) throw new Error("No active loop to resume");
		const state = {
			...this.loop,
			status: "active" as LoopStatus,
			guardId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
			noProgressCount: 0,
			lastFingerprint: null,
			updatedAt: now,
		};
		this.loop = state;
		return state;
	}

	/**
	 * Pause the loop.
	 */
	pauseState(now: number): LoopState {
		if (!this.loop) throw new Error("No active loop to pause");
		const state = {
			...this.loop,
			status: "paused" as LoopStatus,
			updatedAt: now,
		};
		this.loop = state;
		return state;
	}

	/**
	 * Clear (cancel) the loop.
	 */
	clearState(): LoopState | null {
		const result = this.loop;
		this.loop = null;
		return result;
	}

	/**
	 * Start a new loop run.
	 */
	startState(opts: {
		commandName: string;
		programPath: string;
		mission: string;
		maxRounds: number;
		tokenBudget: number | null;
		noProgressTurns: number;
	}): LoopState {
		const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
		const state: LoopState = {
			id,
			commandName: opts.commandName,
			programPath: opts.programPath,
			mission: opts.mission,
			rounds: 0,
			maxRounds: opts.maxRounds,
			tokensUsed: 0,
			tokenBudget: opts.tokenBudget,
			guardId: id,
			noProgressTurns: opts.noProgressTurns,
			noProgressCount: 0,
			lastFingerprint: null,
			status: "active" as LoopStatus,
			updatedAt: Date.now(),
			coordinatorUsage: 0,
			nestedUsage: 0,
			processedToolCallIds: [],
		};
		this.loop = state;
		return state;
	}

	/**
	 * Mark the loop complete.
	 */
	completeState(): LoopState {
		if (!this.loop) throw new Error("No active loop to complete");
		const state = {
			...this.loop,
			status: "complete" as LoopStatus,
			updatedAt: Date.now(),
		};
		this.loop = state;
		return state;
	}

	/**
	 * Check completion policy. Returns failures if any gates fail.
	 */
	async checkCompletion(state: LoopState): Promise<CompletionFailure[]> {
		return this.completionPolicy.audit(state);
	}

	/**
	 * Increment the round counter for the next continuation.
	 */
	incrementRound(): void {
		if (!this.loop) return;
		this.loop = {
			...this.loop,
			rounds: this.loop.rounds + 1,
			updatedAt: Date.now(),
		};
	}

	/**
	 * Update program injection state after getting a new block.
	 */
	updateProgramBlock(sig: string | null): void {
		if (!this.loop) return;
		this.loop = {
			...this.loop,
			programSig: sig ?? undefined,
			programInjected: true,
			updatedAt: Date.now(),
		};
	}

	// ---- internal -----------------------------------------------------------

	private async persistAndEmit(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		state: LoopState,
		kind: "budget_limited" | "no_progress",
	): Promise<void> {
		this.loop = state;
		await this.persist(pi, ctx);
		this.emit(pi, kind, "followUp");
	}

	/**
	 * Emit a loop event message (public engine API — used by command.ts and
	 * the wiring layer to notify the agent of state transitions).
	 */
	emit(
		pi: ExtensionAPI,
		kind: string,
		deliverAs?: "steer" | "followUp" | "nextTurn",
	): void {
		if (!this.loop) return;
		pi.sendMessage(
			{
				customType: EVENT_TYPE,
				content: this.eventContent(kind),
				display: true,
				details: { kind, loop: this.loop, timestamp: Date.now() },
			},
			{
				triggerTurn:
					kind === "continuation" ||
					kind === "budget_limited" ||
					kind === "no_progress",
				deliverAs,
			},
		);
	}

	private eventContent(kind: string): string {
		if (!this.loop) return "";
		const state = this.loop;
		switch (kind) {
			case "paused":
				return `The active /${state.commandName} has been paused by the user. Stop working on it and wait for further instructions.\n\nMission: ${state.mission}`;
			case "cleared":
				return `The active /${state.commandName} has been cleared by the user. Stop pursuing it.\n\nMission was: ${state.mission}`;
			case "complete":
				return `The /${state.commandName} is complete.\n\nMission: ${state.mission}\nRounds: ${state.rounds} · Tokens: ${state.tokensUsed}`;
			case "budget_limited":
				return this.wrapUpContent(state);
			case "no_progress":
				return `The active /${state.commandName} paused: ${state.noProgressTurns} consecutive rounds with no new output and no tool calls — this loop looks stalled.\n\n<mission>\n${state.mission}\n</mission>\n\nReview what happened: check the working files and the program's protocol. If the stall is real, this run cannot make progress as-is — the program may need steering (the human edits it live) or the loop should be cleared. Do not start new work now.`;
			default:
				return this.continuationContent(state);
		}
	}

	private getProgramBlock(): { block: string; sig: string | null } {
		if (!this.loop) return { block: "", sig: null };
		// F5: Use snapshot if available — source is never reread during a run
		if (this.loop.programSnapshot) {
			return { block: this.loop.programSnapshot, sig: this.loop.programSig ?? null };
		}
		// First read: capture snapshot from disk for future rounds
		const result = programBlockFor(
			this.loop.programPath,
			this.loop.programInjected,
			this.loop.programSig,
		);
		this.loop = { ...this.loop, programSnapshot: result.block };
		return result;
	}

	private continuationContent(state: LoopState): string {
		const budget = state.tokenBudget == null ? "none" : String(state.tokenBudget);
		const remaining =
			state.tokenBudget == null
				? "n/a"
				: String(Math.max(0, state.tokenBudget - state.tokensUsed));
		const { block: programBlock } = this.getProgramBlock();
		const wdBlock = state.workingDir
			? `Research working directory: ${state.workingDir}\nAll research artifacts (score.md, notes.md, report.org) must be written inside this directory — never in the project cwd. When passing these files to subagents, use their absolute paths under it.`
			: "";
		return `Continue the active /${state.commandName}. Round ${state.rounds + 1} of ${state.maxRounds}.

<mission>
${state.mission}
</mission>

${programBlock}${wdBlock}

Rules:
- Never redo work already done. Check your working files first, then take the next concrete action.
- Do NOT stop because you feel finished. The loop only ends when you call complete_loop (status=complete) — and only after auditing that the program's completion condition is genuinely met against real evidence (files, fetched sources, output). Treat uncertainty as not done.
- If the program defines gates (e.g. a checkpoint tool), obey them.

	Budget: rounds ${state.rounds}/${state.maxRounds} · Profile: ${state.profile ?? "standard"} · tokens ${state.tokensUsed}/${budget} (${remaining} remaining) · guard ${state.guardId}.`;
	}

	private wrapUpContent(state: LoopState): string {
		return `The active /${state.commandName} has reached its ${state.reason === "tokens" ? "token budget" : "maximum round count"}. Do not start new substantive work.

<mission>
${state.mission}
</mission>

Wrap up this turn: summarize progress, write partial findings to disk if the program calls for it, and leave the user a clear next step. Do not call complete_loop unless the completion condition is actually met.`;
	}

	private queueContinuation(pi: ExtensionAPI, ctx: ExtensionContext): void {
		if (this._continuationQueued || this.loop?.status !== "active") return;
		this._continuationQueued = true;
		const self = this;
		queueMicrotask(() => {
			self._continuationQueued = false;
			if (!self.loop || self.loop.status !== "active") return;
			if (self.loop.rounds >= self.loop.maxRounds) {
				self.loop = {
					...self.loop,
					status: "budget_limited" as LoopStatus,
					reason: "rounds",
					updatedAt: Date.now(),
				};
				self.persist(pi, ctx);
				self.emit(pi, "budget_limited", "followUp");
				return;
			}
			self.incrementRound();
			// Apply post-increment callback (e.g. research checkpointEvidence invalidation)
			if (self.options.onRoundIncrement && self.loop) {
				self.loop = self.options.onRoundIncrement(self.loop);
			}
			// F5: Use snapshot instead of rereading from disk
			const prog = self.getProgramBlock();
			self.updateProgramBlock(prog.sig);
			self.persist(pi, ctx);
			self.emit(pi, "continuation", "followUp");
			self._continuationTurnPending = true;
		});
	}

	private syncLoopTools(pi: ExtensionAPI): void {
		const active = new Set(pi.getActiveTools());
		if (this.loop?.status === "active") active.add("complete_loop");
		else active.delete("complete_loop");
		pi.setActiveTools(Array.from(active));
	}

	private updateStatus(ctx: ExtensionContext): void {
		ctx.ui.setStatus("pi-loop", this.statusLine(this.loop) ?? "");
	}

	private statusLine(state: LoopState | null): string {
		if (!state) return "";
		switch (state.status) {
			case "active":
				return `${state.commandName}: active ${Math.min(state.rounds + 1, state.maxRounds)}/${state.maxRounds} · ${state.tokensUsed} tok`;
			case "paused":
				return `${state.commandName}: paused`;
			case "complete":
				return `${state.commandName}: complete`;
			case "no_progress":
				return `${state.commandName}: paused (no progress)`;
			case "budget_limited":
				return `${state.commandName}: stopped (${state.reason ?? "budget"})`;
			default:
				return "";
		}
	}

}
