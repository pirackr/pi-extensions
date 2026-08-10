// extensions/web-search/rate-limit.ts
// Cross-process rate-limit coordinator under $PI_AGENT_DIR/cache/web-search/.
// Uses lock-protected state files with rolling windows and cooldowns.

import { createHash } from "node:crypto";
import {
	chmodSync,
	closeSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
	writeSync,
} from "node:fs";
import { resolve } from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ReserveOutcome =
	| "allowed"
	| "capacity-blocked"
	| "cooldown-blocked"
	| "contention";

export interface RateLimitBucketConfig {
	capacity: number | null;
	windowMs: number;
	maxRetries: number;
	fallbackCooldownMs: number;
}

export interface RateLimitState {
	/** Schema version — bumped on structural changes; mismatched states are discarded. */
	version: number;
	/** Millisecond timestamps of recent reservations (rolling window). */
	timestamps: number[];
	/** Millisecond epoch when the current cooldown expires, or null. */
	blockedUntil: number | null;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCHEMA_VERSION = 1;
const LOCK_SUFFIX = ".lock";
const STATE_SUFFIX = ".json";
const DEFAULT_STATE_DIR = ".cache/web-search";
const DEFAULT_FALLBACK_COOLDOWN_MS = 10_000;
const STALE_LOCK_MS = 30_000;
const MAX_LOCK_RETRIES = 20;
const LOCK_RETRY_BASE_MS = 5;

// Fixed anonymous fingerprint for providers without API keys (e.g. DuckDuckGo).
const ANONYMOUS_FINGERPRINT = createHash("sha256")
	.update("anonymous-ddg")
	.digest("hex");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function fingerprint(key: string | undefined): string {
	if (!key) return ANONYMOUS_FINGERPRINT;
	return createHash("sha256").update(key).digest("hex");
}

function bucketPath(stateDir: string, provider: string, operation: string, apiKey?: string): string {
	const fp = fingerprint(apiKey);
	return resolve(stateDir, `${provider}.${operation}.${fp}${STATE_SUFFIX}`);
}

function lockPath(stateDir: string, provider: string, operation: string, apiKey?: string): string {
	const fp = fingerprint(apiKey);
	return resolve(stateDir, `${provider}.${operation}.${fp}${LOCK_SUFFIX}`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// State I/O
// ---------------------------------------------------------------------------

function readState(file: string): RateLimitState {
	try {
		const raw = readFileSync(file, "utf-8");
		const parsed = JSON.parse(raw) as Record<string, unknown>;
		if (typeof parsed.version !== "number") {
			// Schema mismatch — start fresh.
			return initialState();
		}
		if (!Array.isArray(parsed.timestamps)) {
			return initialState();
		}
		const timestamps = (parsed.timestamps as unknown[]).filter(
			(v): v is number => typeof v === "number",
		);
		const blockedUntil =
			typeof parsed.blockedUntil === "number" ? parsed.blockedUntil : null;
		return { version: SCHEMA_VERSION, timestamps, blockedUntil };
	} catch {
		return initialState();
	}
}

function initialState(): RateLimitState {
	return { version: SCHEMA_VERSION, timestamps: [], blockedUntil: null };
}

function writeState(file: string, state: RateLimitState): void {
	const dir = resolve(file, "..");
	mkdirSync(dir, { recursive: true });
	// Use a process-unique tmp name to avoid races when multiple processes
	// write concurrently (they hold the lock, but the tmp path is shared).
	const tmp = file + ".tmp." + process.pid + "." + Date.now();
	writeFileSync(tmp, JSON.stringify(state), "utf-8");
	chmodSync(tmp, 0o600);
	renameSync(tmp, file);
}

// ---------------------------------------------------------------------------
// Locking
// ---------------------------------------------------------------------------

/**
 * Acquires an exclusive lock file with bounded retries and jittered back-off.
 * Stale locks (older than STALE_LOCK_MS) are stolen.
 * Returns the fd on success, -1 on failure after all retries exhausted.
 */
function acquireLock(lockFile: string): Promise<number> {
	const start = Date.now();
	return (async () => {
		for (let i = 0; i < MAX_LOCK_RETRIES; i++) {
			try {
				// Try exclusive create (O_EXCL via fs.open flag).
				const fd = openSync(lockFile, "wx", 0o600);
				// Write PID + timestamp for stale-lock detection.
				const payload = `${process.pid}:${Date.now()}\n`;
				writeSync(fd, payload);
				return fd;
			} catch (err: unknown) {
				// If the lock file exists but is stale, remove and retry.
				const isLockError =
					err &&
					typeof err === "object" &&
					"code" in (err as object) &&
					((err as { code: string }).code === "EEXIST" ||
						(err as { code: string }).code === "EACCES");
				if (!isLockError) {
					// Non-lock error — give up.
					return -1;
				}
				// Check if stale.
				try {
					const content = readFileSync(lockFile, "utf-8");
					const parts = content.trim().split(":");
					// Treat empty or unparseable locks as FRESH — a crashed
					// process leaves a valid timestamp (written at create-time);
					// an empty/partially-written file means another process is
					// in the middle of creating it and we must not steal it.
					const lockTime = parts.length >= 2 ? Number(parts[1]) : 0;
					if (lockTime > 0 && Date.now() - lockTime > STALE_LOCK_MS) {
						// Steal the stale lock.
						unlinkSync(lockFile);
						continue;
					}
				} catch {
					// File vanished — retry.
					continue;
				}
				// Not stale — jittered sleep between retries.
				const jitter = Math.random() * LOCK_RETRY_BASE_MS;
				const wait = LOCK_RETRY_BASE_MS + jitter;
				// Check total timeout (max 2 seconds).
				if (Date.now() - start > 2000) return -1;
				await sleep(wait);
			}
		}
		return -1;
	})();
}

function releaseLock(lockFile: string, fd: number): void {
	try {
		if (fd >= 0) {
			closeSync(fd);
		}
	} catch {
		// Best-effort.
	}
	try {
		unlinkSync(lockFile);
	} catch {
		// Best-effort.
	}
}

// ---------------------------------------------------------------------------
// Reserve logic
// ---------------------------------------------------------------------------

function pruneTimestamps(state: RateLimitState, now: number, windowMs: number): void {
	const cutoff = now - windowMs;
	state.timestamps = state.timestamps.filter((t) => t > cutoff);
}

function checkCooldown(state: RateLimitState, now: number): ReserveOutcome | null {
	if (state.blockedUntil !== null && now < state.blockedUntil) {
		return "cooldown-blocked";
	}
	return null;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates a RateLimitCoordinator backed by `stateDir` and `config`.
 * Tests pass temp dirs; production passes $PI_AGENT_DIR/cache/web-search/.
 */
export function createCoordinator(
	stateDir: string,
	config: Record<string, Record<string, RateLimitBucketConfig>>,
): RateLimitCoordinator {
	return new RateLimitCoordinator(stateDir, config);
}

export class RateLimitCoordinator {
	private stateDir: string;
	private config: Record<string, Record<string, RateLimitBucketConfig>>;

	constructor(
		stateDir: string,
		config: Record<string, Record<string, RateLimitBucketConfig>>,
	) {
		mkdirSync(stateDir, { recursive: true });
		this.stateDir = stateDir;
		this.config = config;
	}

	/**
	 * Reserve capacity for one provider+operation attempt.
	 *
	 * Returns:
	 * - `'allowed'` — capacity was available and the reservation succeeded.
	 * - `'capacity-blocked'` — the rolling window is full; the caller must not
	 *   make a request for this provider/operation.
	 * - `'cooldown-blocked'` — a shared cooldown is active (e.g. from a 429);
	 *   the caller must not make a request until it expires.
	 * - `'contention'` — the exclusive lock could not be acquired after bounded
	 *   retries. This is a temporary condition: the caller should back off and
	 *   retry the reservation after a short delay rather than making a request.
	 */
	async reserve(
		provider: string,
		operation: "search" | "fetch",
		apiKey?: string,
	): Promise<ReserveOutcome> {
		const stateFile = bucketPath(this.stateDir, provider, operation, apiKey);
		const lockFile = lockPath(this.stateDir, provider, operation, apiKey);
		const opConfig = this.config[provider]?.[operation];
		const capacity = opConfig?.capacity ?? null;
		const windowMs = opConfig?.windowMs ?? 60_000;
		const fallbackCooldownMs =
			opConfig?.fallbackCooldownMs ?? DEFAULT_FALLBACK_COOLDOWN_MS;

		const fd = await acquireLock(lockFile);
		if (fd < 0) return "contention";

		try {
			const state = readState(stateFile);
			const now = Date.now();

			// Prune expired timestamps.
			pruneTimestamps(state, now, windowMs);

			// Check active cooldown.
			const cooldownResult = checkCooldown(state, now);
			if (cooldownResult !== null) {
				writeState(stateFile, state);
				return cooldownResult;
			}

			// Check capacity.
			if (capacity !== null && state.timestamps.length >= capacity) {
				writeState(stateFile, state);
				return "capacity-blocked";
			}

			// Reserve: append timestamp.
			state.timestamps.push(now);
			writeState(stateFile, state);
			return "allowed";
		} finally {
			releaseLock(lockFile, fd);
		}
	}

	/**
	 * Publish a cooldown deadline for a bucket (e.g. after a 429).
	 * `retryAfterMs` takes precedence over the configured fallbackCooldownMs.
	 */
	async publishCooldown(
		provider: string,
		operation: "search" | "fetch",
		retryAfterMs?: number,
		apiKey?: string,
	): Promise<void> {
		const stateFile = bucketPath(this.stateDir, provider, operation, apiKey);
		const lockFile = lockPath(this.stateDir, provider, operation, apiKey);
		const opConfig = this.config[provider]?.[operation];
		const fallbackCooldownMs =
			opConfig?.fallbackCooldownMs ?? DEFAULT_FALLBACK_COOLDOWN_MS;
		const cooldownMs = retryAfterMs ?? fallbackCooldownMs;

		const fd = await acquireLock(lockFile);
		if (fd < 0) return; // Best-effort.

		try {
			const state = readState(stateFile);
			const blockedUntil = Date.now() + cooldownMs;
			state.blockedUntil = blockedUntil;
			writeState(stateFile, state);
		} finally {
			releaseLock(lockFile, fd);
		}
	}
}
