import * as fs from "node:fs";
import * as path from "node:path";
import type { Workspace } from "./workspace.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Typed conflict returned by `updateRunState` on stale revision. */
export interface StateConflict {
	expected: number;
	actual: number;
}

export interface RunState {
	/** Monotonically increasing revision number. */
	revision: number;
	/** Current run status. */
	status: "active" | "paused" | "complete" | "error";
	/** Epoch milliseconds at creation. */
	createdAt: number;
	/** Epoch milliseconds of last mutation. */
	updatedAt: number;
	/** Human-readable mission statement. */
	mission: string;
	/** Unique run identifier. */
	runId: string;
	/** Coordinator token usage (convenience accessor). */
	coordinatorUsage: number;
	/** Nested / subagent token usage. */
	nestedUsage: number;
	/** Total tokens consumed. */
	tokensUsed: number;
}

export interface RunLease {
	/** Session identifier that holds the lease. */
	sessionId: string;
	/** Epoch milliseconds at acquisition. */
	acquiredAt: number;
	/** Epoch milliseconds at expiration (stale threshold). */
	expiresAt: number;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const STATE_FILE = "run-state.json";
const LEASE_FILE = "run-lease.json";
const LEASE_TIMEOUT_MS = 300_000; // 5 minutes

// ---------------------------------------------------------------------------
// Per-workspace serialized queue
// ---------------------------------------------------------------------------

/**
 * Per-workspace queue ensures state updates are applied serially,
 * preventing lost updates from concurrent callers.
 */
const stateQueues = new Map<string, Promise<RunState>>();

function getStateQueue(ws: Workspace): Promise<RunState> {
	const key = ws.path;
	if (!stateQueues.has(key)) {
		stateQueues.set(key, Promise.resolve(readRunState(ws)));
	}
	return stateQueues.get(key)!;
}

// ---------------------------------------------------------------------------
// State management
// ---------------------------------------------------------------------------

/**
 * Create an initial RunState for the workspace.
 *
 * This is a convenience helper — the actual file is written by the first
 * call to `updateRunState`.
 */
export function newRunState(ws: Workspace): RunState {
	const now = Date.now();
	return {
		revision: 1,
		status: "active",
		createdAt: now,
		updatedAt: now,
		mission: ws.mission,
		runId: ws.runId,
		coordinatorUsage: 0,
		nestedUsage: 0,
		tokensUsed: 0,
	};
}

/**
 * Read the current RunState from disk.
 *
 * Throws `Error` with code `ENOENT` if the state file doesn't exist.
 */
export function readRunState(ws: Workspace): RunState {
	const statePath = path.join(ws.path, ".research", STATE_FILE);
	const raw = fs.readFileSync(statePath, "utf-8");
	return JSON.parse(raw) as RunState;
}

/**
 * Update the RunState atomically.
 *
 * - Caller supplies `expectedRevision`; a mismatch throws `StateConflict`.
 * - Per-workspace serialized queue prevents lost updates.
 * - Writes via temp file → flush → atomic rename (no torn writes).
 * - The `mutate` callback receives the current state and returns the
 *   updated state; `updateRunState` increments revision and updatedAt.
 *
 * Returns the updated state.
 */
export async function updateRunState(
	ws: Workspace,
	expectedRevision: number,
	mutate: (current: Readonly<RunState>) => RunState,
): Promise<RunState> {
	const queue = getStateQueue(ws);

	const next = queue.then(async (current) => {
		// Read fresh from disk to catch external mutations
		const fresh = readRunState(ws);

		// Revision check — stale revision means another update happened
		if (fresh.revision !== expectedRevision) {
			throw { expected: expectedRevision, actual: fresh.revision } as StateConflict;
		}

		// Apply mutation
		const updated = mutate(fresh);
		updated.revision = fresh.revision + 1;
		updated.updatedAt = Date.now();

		// Atomic write: temp file → flush → rename
		const statePath = path.join(ws.path, ".research", STATE_FILE);
		const tmpPath = statePath + ".tmp";
		const content = JSON.stringify(updated, null, 2);

		fs.writeFileSync(tmpPath, content, "utf-8");

		// If the platform supports fdatasync/fsync, do it here for durability
		// (fs.writeFileSync already flushes on Node, but we're explicit)
		try {
			const fd = fs.openSync(tmpPath, "r");
			fs.fdatasyncSync(fd);
			fs.closeSync(fd);
		} catch {
			// fdatasync not supported on all platforms — best-effort
		}

		fs.renameSync(tmpPath, statePath);

		// Update the queue with the new state
		stateQueues.set(ws.path, Promise.resolve(updated));

		return updated;
	});

	// Enqueue this update behind any pending ones
	stateQueues.set(ws.path, next);

	return next;
}

// ---------------------------------------------------------------------------
// Lease management
// ---------------------------------------------------------------------------

/**
 * Acquire an exclusive lease for the workspace.
 *
 * - If no lease exists, creates one.
 * - If a non-stale lease exists, throws.
 * - If a stale lease exists (beyond `LEASE_TIMEOUT_MS`), overwrites it.
 *
 * All writes to run-state go through `updateRunState`, so the lease
 * simply gates the "driving session".
 */
export async function acquireLease(
	ws: Workspace,
	sessionId: string,
): Promise<RunLease> {
	const leasePath = path.join(ws.path, ".research", LEASE_FILE);

	if (fs.existsSync(leasePath)) {
		const existing = JSON.parse(
			fs.readFileSync(leasePath, "utf-8"),
		) as RunLease;

		// Check staleness
		if (Date.now() - existing.acquiredAt > LEASE_TIMEOUT_MS) {
			// Stale — overwrite
		} else {
			throw new Error(
				`Lease already held by session ${existing.sessionId}`,
			);
		}
	}

	const lease: RunLease = {
		sessionId,
		acquiredAt: Date.now(),
		expiresAt: Date.now() + LEASE_TIMEOUT_MS,
	};

	fs.writeFileSync(leasePath, JSON.stringify(lease, null, 2), "utf-8");

	return lease;
}

/**
 * Release the lease for this session.
 *
 * Throws if the session doesn't hold the lease.
 * No-op if no lease exists.
 */
export async function releaseLease(
	ws: Workspace,
	sessionId: string,
): Promise<void> {
	const leasePath = path.join(ws.path, ".research", LEASE_FILE);

	if (!fs.existsSync(leasePath)) {
		return; // already released
	}

	const existing = JSON.parse(
		fs.readFileSync(leasePath, "utf-8"),
	) as RunLease;

	if (existing.sessionId !== sessionId) {
		throw new Error(
			`Lease belongs to ${existing.sessionId}, not ${sessionId}`,
		);
	}

	fs.unlinkSync(leasePath);
}
