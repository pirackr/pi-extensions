// Type-only declarations for the standalone Pi RPC runner.
//
// This declaration module owns the runner-only contract that Task 1 never put
// into `types.ts`: the persisted {@link RunnerRequest} launch record, its
// serializable profile / invocation shapes, the injectable {@link RunnerDeps}
// seams the deterministic tests rely on, and the two async entrypoints
// {@link runTaskMode} and {@link main}.
//
// It is intentionally a declaration-only (`.d.mts`) module: it adds no runtime
// dependency and imports nothing. Task 9 may `import type { RunnerRequest }`
// from here later. Plain `node runner.mjs` never reads this file.

import type { ProfileReservation } from "./types.ts";

/**
 * Snapshotted, immutable profile fields the runner needs to launch Pi without
 * the parent process in memory. Mirrors
 * {@link import("./types").ResolvedProfile} minus the owner-neutral fields.
 */
export interface RunnerProfile {
	readonly model: string;
	readonly thinking: string | null;
	readonly tools: string[];
	readonly systemPrompt: string;
	readonly timeoutSeconds: number | null;
}

/**
 * The Pi invocation the runner spawns: an executable plus an argument array.
 * Spawned with `shell: false`, so every argument is a literal element.
 */
export interface RunnerInvocation {
	readonly command: string;
	readonly args: string[];
}

/**
 * A durable, JSON-serializable launch request persisted to `request.json`
 * beneath a parent-scoped artifact root. Task 8 reads only this file to launch;
 * all output paths are derived from `dirname(requestPath)`, never accepted as
 * input. Task 9 writes it at enqueue time.
 */
export interface RunnerRequest {
	/** Schema version; bump only on breaking durable-shape changes. */
	readonly schema: number;
	/** Four-character parent id. */
	readonly parentId: string;
	/** Four-character agent (task) id — this runner's identity. */
	readonly agentId: string;
	/** Present only for explicitly enabled nested tasks. */
	readonly parentAgentId: string | null;
	/** Immutable origin conversation UUID. */
	readonly origin: string;
	/** Notification group token, or `null` for foreground tasks. */
	readonly groupId: string | null;
	/** Monotonic FIFO sequence allocated at enqueue. */
	readonly sequence: number;
	/** Epoch milliseconds the task was queued. */
	readonly queuedAt: number | null;
	/** Short UI label (never the full prompt). */
	readonly description: string;
	/** The complete, immutable task prompt delivered to Pi. */
	readonly prompt: string;
	/** Canonical parent artifact root, for the child environment. */
	readonly artifactRoot: string;
	/** Working directory for the spawned Pi process. */
	readonly cwd: string;
	/** Snapshotted profile fields used to build the spawn arguments. */
	readonly profile: RunnerProfile;
	/** Pi executable + prefix arguments. */
	readonly pi: RunnerInvocation;
	/** Child extension entrypoints passed as `--extension`. */
	readonly childExtensions: readonly string[];
	/** Whether repository context files stay enabled (`--no-context-files` when false). */
	readonly loadContextFiles: boolean;
	/** Hard cap on web_lookup calls (0 disables the flag). */
	readonly webSearchMaxLookups: number;
	/** Hard cap on fetch_web calls (0 disables the flag). */
	readonly webSearchMaxFetches: number;
	/**
	 * Owner-neutral reservation captured at enqueue, mirrored from the durable
	 * manifest so the launch record is self-contained. The runner ignores it;
	 * it exists so the reservation survives alongside the request it launches.
	 */
	readonly reservation: ProfileReservation | null;
}

/**
 * A manually controllable clock injected into the runner so timeout,
 * SIGKILL grace, cancellation polling, and the stats fallback can be advanced
 * deterministically in tests — no real timers, no arbitrary sleeps.
 */
export interface RunnerClock {
	readonly now: () => number;
	readonly setTimeout: (
		cb: () => void,
		ms: number,
	) => NodeJS.Timeout;
	readonly clearTimeout: (id: NodeJS.Timeout) => void;
}

/**
 * Injectable dependencies for {@link runTaskMode}. Every external side effect
 * (process spawn, process-group termination, the clock, and the writable
 * streams) is injected so the runner can be driven deterministically. The only
 * non-test seam is {@link RunnerDeps.onWrite}, which records the destination
 * path of each atomic durable write so publication order can be asserted.
 */
export interface RunnerChildStream {
	on(event: "data" | "end", listener: (...args: unknown[]) => void): unknown;
}

export interface RunnerChild {
	readonly pid?: number;
	readonly stdin: {
		readonly ended?: boolean;
		write(data: string): boolean;
		end(): void;
	};
	readonly stdout: RunnerChildStream;
	readonly stderr: RunnerChildStream;
	on(event: "error" | "close", listener: (...args: unknown[]) => void): unknown;
}

export type RunnerSpawn = (
	command: string,
	args: string[],
	options: Record<string, unknown>,
) => RunnerChild;

export interface RunnerDeps {
	/**
	 * Spawn implementation; defaults to `node:child_process`.spawn. The fake
	 * child must expose the minimal {@link RunnerChild} event/stream surface.
	 */
	spawn?: RunnerSpawn;
	/**
	 * Kill a process group. Defaults to `process.kill(-pid, signal)`. Records
	 * each `(pid, signal)` pair so escalation can be asserted.
	 */
	killProcessGroup?: (pid: number, signal: NodeJS.Signals) => void;
	/** Controllable clock; defaults to a real `Date.now` + `setTimeout`. */
	clock?: RunnerClock;
	/** Milliseconds between SIGTERM and SIGKILL; defaults to `5000`. */
	killGraceMs?: number;
	/** Milliseconds the runner waits for authoritative stats before giving up; defaults to `3000`. */
	statsFallbackMs?: number;
	/** Milliseconds between cancellation-marker polls; defaults to `200`. */
	cancelPollMs?: number;
	/** Records each atomic durable write path, in order (test seam). */
	onWrite?: (destination: string) => void;
	/** Writable for runner output; defaults to `process.stdout`. */
	stdout?: { write(data: string): boolean };
	/** Writable for child stderr echo; defaults to `process.stderr`. */
	stderr?: { write(data: string): boolean };
}

/**
 * Run a single task in the standalone runner mode: read the persisted
 * {@link RunnerRequest}, launch Pi, drive the RPC until settlement, and publish
 * durable `result.json` then terminal `status.json`. Resolves only after the
 * terminal artifacts are written and logs are closed so the tmux window can
 * close naturally on return.
 */
export function runTaskMode(
	requestPath: string,
	deps?: RunnerDeps,
): Promise<void>;

/**
 * CLI entrypoint: `node runner.mjs <request.json>`. Resolves once the runner
 * finishes; the process exit code reflects the terminal state so a tmux window
 * closes when the runner returns.
 */
export function main(
	argv?: readonly string[],
	deps?: RunnerDeps,
): Promise<void>;
