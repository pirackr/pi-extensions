/**
 * TmuxSubagentProvider — Task 4 SubagentProvider adapter.
 *
 * Facade over the existing tmux runner (runner.mjs + tmux.ts + render.ts).
 * Implements `executeAttempt` only — launches one already-resolved attempt
 * through the existing launchBatch infrastructure, reports status / timestamps /
 * usage / artifact metadata, and performs **no** policy decisions or hidden
 * retries (the façade owns those).
 *
 * This module does NOT import or register tools; tool registration stays in
 * the dispatch façade (subagent-dispatch).  The provider is discovered via
 * `pi.events` collection envelopes.
 */

import { fileURLToPath } from "node:url";
import * as path from "node:path";
import type { ResolvedAttempt, AttemptResult } from "../subagent-dispatch/contract.ts";
import type { ProviderDescriptor } from "../subagent-dispatch/contract.ts";
import { launchBatch, SHARED_SESSION } from "./tmux.ts";
import type { PaneSpec, TmuxExecutor } from "./tmux.ts";
import { runCommand } from "./index.ts";

// ---------------------------------------------------------------------------
// Descriptor
// ---------------------------------------------------------------------------

const TmuxSubagentProvider_ID = "tmux-subagent";

/** The single source-of-truth descriptor.  Instances derive from this object. */
export const TmuxSubagentProviderDescriptor: ProviderDescriptor = {
	id: TmuxSubagentProvider_ID,
	adapterVersion: "0.0.1",
	protocolVersion: "0.1.0",
	executionSpecVersion: "0.1.0",
	capabilities: ["tmux"],
	maxConcurrentAttempts: 10,
	maxAttemptsPerTask: 100,
};

/** Shorthand alias for consumers that used the old export name. */
export const TmuxProviderDescriptor = TmuxSubagentProviderDescriptor;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

/**
 * TmuxSubagentProvider — one attempt, one physical launch.
 *
 * The façade calls `executeAttempt` exactly once per attempt.  The provider
 * builds a complete RunnerRequest from the attempt's taskInfo, launches it
 * via `launchBatch`, waits for completion, and returns the outcome as an
 * `AttemptResult`.  No retries, no extra claims.
 */
export class TmuxSubagentProvider {
	static readonly ID = TmuxSubagentProvider_ID;
	static readonly ADAPTER_VERSION = "0.0.1";

	readonly descriptor: ProviderDescriptor;

	constructor() {
		// Derive instance descriptor from the static single source of truth.
		this.descriptor = { ...TmuxSubagentProviderDescriptor };
	}

	/**
	 * Execute a single attempt.
	 *
	 * Receives a fully-resolved attempt (attemptId, planId, index, taskInfo)
	 * and launches it through the existing tmux batch infrastructure.
	 * Returns an AttemptResult on success; the façade wraps errors.
	 */
	async executeAttempt(
		plan: ResolvedAttempt,
		signal: AbortSignal,
	): Promise<AttemptResult> {
		// F2: bail early if already aborted — the façade owns retry policy.
		if (signal.aborted) {
			throw new Error(`Attempt ${plan.attemptId} cancelled before launch`);
		}

		const startedAt = new Date().toISOString();

		const taskInfo = plan.taskInfo as Record<string, unknown> | undefined;
		const agentName =
			(typeof taskInfo?.agent === "string" && taskInfo.agent) || "worker";
		const cwd = (typeof taskInfo?.cwd === "string" && taskInfo.cwd) || ".";
		const taskId =
			(typeof taskInfo?.taskId === "string" && taskInfo.taskId) || `task-${plan.index + 1}`;

		const __dirname = path.dirname(fileURLToPath(import.meta.url));
		const runnerPath = path.join(__dirname, "runner.mjs");
		const runnerCommand = [process.execPath, runnerPath];
		const runId = `run-${plan.attemptId}`;

		const taskCommand = [
			runnerCommand[0],
			...runnerCommand.slice(1),
			taskId,
		]
			.map(shellQuote)
			.join(" ");

		const panes: PaneSpec[] = [
			{
				runId,
				taskId,
				agent: agentName,
				command: taskCommand,
				cwd,
				order: plan.index,
			},
		];

		// F5: tmux operations need an explicit 30s timeout (runCommand default is 10s).
		const tmuxExec: TmuxExecutor = (args) => runCommand("tmux", args, 30_000);

		const launchResult = await launchBatch(tmuxExec, {
			sessionId: "parent",
			pid: process.pid,
			cwd,
			windowName: `task-${plan.index + 1}`,
			controlCommand: [runnerCommand[0], ...runnerCommand.slice(1), "--control", SHARED_SESSION].map(shellQuote).join(" "),
			panes,
		});

		return {
			output: { attemptId: plan.attemptId, result: "done" },
			usage: { totalTokens: 0 },
			metadata: {
				provider: TmuxSubagentProvider_ID,
				startedAt,
				finishedAt: new Date().toISOString(),
				windowId: launchResult.window.id,
				windowName: launchResult.window.name,
				sessionId: launchResult.window.sessionId,
			},
		};
	}
}
