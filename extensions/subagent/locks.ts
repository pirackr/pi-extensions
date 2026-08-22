// Generation-safe filesystem leases for the `subagent` extension.
//
// This module implements the two durable locks the design spec reserves at the
// parent root:
//
// ```
// /tmp/<project-slug>/pi-a7k2/
// ├── manager.lock   (long-lived lease)
// └── registry.lock  (short-lived lease)
// ```
//
// Both are the *same* primitive — {@link acquireManagerLease} — used at
// different lifetimes. The manager lease is held for the life of the connected
// manager process so two parent Pi processes never pump the same queue; the
// registry lease is held only across a single enqueue, group, or manifest
// publication so concurrent submissions serialize.
//
// Safety invariants (see the spec's security requirements):
//
// - **Exclusive creation, never check-then-create.** The lock file is created
//   with an atomic `open(..., { create: true, exclusive: true })`, so exactly
//   one contender wins. Contenders never unlink what they did not create.
// - **Flushed identity.** The winning owner writes and fsyncs its identity
//   (owner, pid, process-start, generation, timestamp) before performing any
//   protected mutation.
// - **Incomplete payloads are retried, never stolen.** A contender that races
//   a just-created-but-not-yet-flushed lock retries with bounded backoff; it
//   does not reclaim a live owner's in-progress file.
// - **Stale reclamation is provable and atomic.** A lock is reclaimed only when
//   its owner is provably gone: the PID is not alive, or its process-start
//   identity is foreign to the current manager. Reclamation first renames the
//   stale lock to a *unique* quarantine name, then retries exclusive creation,
//   so competing reclaimers converge on one winner.
// - **Generation checks guard every protected mutation.** {@link ManagerLease.assertCurrent}
//   proves the on-disk lock still matches this lease's generation, PID, and
//   process-start before any mutation; a superseded lease can neither mutate
//   nor unlink a successor.
// - **Release is owner-only and idempotent.** {@link ManagerLease.release}
//   unlinks the lock only when the on-disk generation matches this lease;
//   otherwise it is a no-op, so a stale owner never removes another owner's or
//   a successor's lock.
//
// It depends only on `node:crypto`, `node:fs/promises`, and `node:path`; every
// side effect (clock, process identity, liveness, generation source) is
// injectable so the semantics are tested deterministically without racing a
// live filesystem or process table.

import {
	open,
	rename,
	unlink,
	lstat,
	readFile,
	chmod,
	type FileHandle,
} from "node:fs/promises";
import { createHash, randomBytes } from "node:crypto";

/** File mode applied to every lock file: owner read/write only. */
const LOCK_FILE_MODE = 0o600;

/** Default bounded-retry budget for an incomplete or just-reclaimed lock. */
const DEFAULT_MAX_RETRIES = 8;

/** Default exponential-backoff start (ms) and ceiling (ms). */
const DEFAULT_BASE_DELAY_MS = 5;
const DEFAULT_MAX_DELAY_MS = 60;

/**
 * The durable identity written into a lease. Mirrors the process/generation
 * fields of {@link AgentManifest} (Task 1): a lock proves *who* holds it via
 * `(pid, processStart)` and proves *which* acquisition holds it via
 * `generation`.
 */
export interface LeaseIdentity {
	/** Opaque owner label, typically the owning parent/manager id. */
	readonly owner: string;
	/** Owning process PID, for liveness-based stale detection. */
	readonly pid: number;
	/** Process-start identity; matches {@link processStartIdentity} when live. */
	readonly processStart: string;
	/** Random token distinguishing successive acquisitions of the path. */
	readonly generation: string;
	/** Epoch milliseconds the lease was acquired. */
	readonly acquiredAt: number;
}

/**
 * A held lease. Callers mutate durable state only between
 * {@link ManagerLease.assertCurrent} and {@link ManagerLease.release}; the
 * manager and scheduler read {@link path}, {@link owner}, and {@link
 * generation} to report ownership and to serialize mutations.
 */
export interface ManagerLease {
	/** The locked file path. */
	readonly path: string;
	/** The owner that holds this lease. */
	readonly owner: string;
	/** The generation token of this acquisition. */
	readonly generation: string;
	/** The owning PID recorded on disk. */
	readonly pid: number;
	/** The owning process-start identity recorded on disk. */
	readonly processStart: string;

	/**
	 * Throw unless the on-disk lock still belongs to this exact lease
	 * (matching generation, PID, and process-start). Call this before every
	 * protected mutation so a superseded lease can never mutate or unlink a
	 * successor's state.
	 *
	 * @throws when the lock is absent, incomplete, or owned by another lease.
	 */
	assertCurrent(): Promise<void>;

	/**
	 * Release the lease by unlinking the lock **only if it still belongs to
	 * this lease**. Idempotent and owner-only: a lock owned by another
	 * generation (a successor or foreign owner) is left untouched, and a
	 * lock already gone resolves to `false`.
	 *
	 * @returns `true` when this lease unlinked the lock, `false` otherwise.
	 */
	release(): Promise<boolean>;
}

/**
 * Injectable dependencies for {@link acquireManagerLease} / {@link
 * withRegistryLock}. Every side effect is injectable so acquisition ordering,
 * stale detection, bounded backoff, and generation safety are tested
 * deterministically.
 */
export interface LeaseDeps {
	/** Monotonic-ish clock; defaults to `Date.now`. */
	now?: () => number;
	/** Owning PID source; defaults to the current `process.pid`. */
	currentPid?: () => number;
	/** Current process-start identity; defaults to {@link processStartIdentity}. */
	processStart?: () => string;
	/** Fresh generation token source; defaults to 8 random hex characters. */
	randomGeneration?: () => string;
	/** Liveness predicate for a PID; defaults to `process.kill(pid, 0)`. */
	isProcessAlive?: (pid: number) => Promise<boolean>;
	/** Bounded retry budget before failing an incomplete lock; default 8. */
	maxRetries?: number;
	/** Exponential-backoff start in ms; default 5. */
	baseDelayMs?: number;
	/** Exponential-backoff ceiling in ms; default 60. */
	maxDelayMs?: number;
	/**
	 * Test hook fired right before each backoff retry (after an incomplete or
	 * stale observation), with the 1-based attempt number. Lets a test resolve
	 * a racing incomplete payload or assert the retry happened.
	 */
	onRetry?: (attempt: number) => void | Promise<void>;
}

/**
 * A stable, process-lifetime identity for the current process, used as the
 * lease `processStart` field. Prefers `process._startInfo` (pid, ppid, start
 * time, executable, argv) when available and falls back to a captured
 * high-resolution start time, so a lock can prove it was written by *this*
 * process rather than a foreign or restarted one.
 */
let cachedProcessStart: string | undefined;

export function processStartIdentity(): string {
	if (cachedProcessStart === undefined) {
		const info = (process as unknown as { _startInfo?: Record<string, unknown> })
			._startInfo;
		if (info && typeof info === "object") {
			cachedProcessStart = hashParts([
				String(info.pid),
				String(info.startMs ?? ""),
				String(info.ppid ?? ""),
				String(info.execPath ?? ""),
				Array.isArray(info.args) ? info.args.join("\u0000") : "",
			]);
		} else {
			const [sec, nsec] = process.hrtime();
			cachedProcessStart = hashParts([
				String(process.pid),
				`${sec}.${nsec}`,
				process.execPath,
			]);
		}
	}
	return cachedProcessStart;
}

/**
 * Liveness check for a PID: alive when `kill(pid, 0)` reports no error.
 * `ESRCH` means the process is gone; `EPERM` means it exists but we may not
 * signal it, which is still "alive".
 */
async function defaultIsProcessAlive(pid: number): Promise<boolean> {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return false;
		if (code === "EPERM") return true;
		return false;
	}
}

function hashParts(parts: readonly string[]): string {
	return createHash("sha256")
		.update(parts.join("\u0000"))
		.digest("hex")
		.slice(0, 16);
}

function defaultGeneration(): string {
	return randomBytes(4).toString("hex");
}

function jitteredBackoff(attempt: number, deps: LeaseDeps): number {
	const base = deps.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
	const max = deps.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
	const exponential = Math.min(max, base * 2 ** (attempt - 1));
	// Half-scale jitter keeps early retries quick while spreading collisions.
	return Math.min(max, exponential * (0.5 + Math.random() * 0.5));
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The parsed state of a lock file at a path.
 *
 * - `null` — the lock does not exist (free to create).
 * - `{ kind: "incomplete" }` — a file exists but has no parseable, complete
 *   identity: another owner is mid-creation, or a creator crashed writing it.
 *   Contenders retry rather than reclaim.
 * - `{ kind: "complete", identity }` — a full, verifiable identity.
 */
type LockState =
	| null
	| { kind: "incomplete" }
	| { kind: "complete"; identity: LeaseIdentity };

function isLeaseIdentity(value: unknown): value is LeaseIdentity {
	if (typeof value !== "object" || value === null) return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.owner === "string" &&
		typeof v.pid === "number" &&
		typeof v.processStart === "string" &&
		typeof v.generation === "string" &&
		typeof v.acquiredAt === "number"
	);
}

/**
 * Securely read a lock file. Symlinks and non-files are rejected (never
 * followed); a missing file is `null`; an empty or malformed or
 * incomplete-identity file is `{ kind: "incomplete" }`.
 */
async function readLockState(path: string): Promise<LockState> {
	let info;
	try {
		info = await lstat(path);
	} catch {
		return null;
	}
	if (info.isSymbolicLink()) {
		throw new Error(`refusing to follow symlink: ${path}`);
	}
	if (!info.isFile()) {
		throw new Error(`unexpected non-file lock: ${path}`);
	}
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return null;
	}
	if (text.length === 0) return { kind: "incomplete" };
	let identity: unknown;
	try {
		identity = JSON.parse(text);
	} catch {
		return { kind: "incomplete" };
	}
	if (!isLeaseIdentity(identity)) return { kind: "incomplete" };
	return { kind: "complete", identity };
}

/**
 * Atomically create the lock at `path` under `identity`. Returns `true` when
 * this caller won the exclusive create, or `false` on `EEXIST` when another
 * file is present (a live owner, an incomplete just-created payload, or a
 * just-quarantined path). Never unlinks anything.
 */
async function tryCreateExclusive(
	path: string,
	identity: LeaseIdentity,
): Promise<boolean> {
	let fd: FileHandle;
	try {
		fd = await open(path, "wx");
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "EEXIST") return false;
		throw err;
	}
	try {
		await fd.writeFile(`${JSON.stringify(identity, null, 2)}\n`);
		await fd.sync();
	} finally {
		await fd.close();
	}
	await chmod(path, LOCK_FILE_MODE);
	return true;
}

/**
 * Move a stale lock to a unique quarantine name so competing reclaimers
 * converge on one winner. An `ENOENT` (a competitor already reclaimed it) is
 * treated as success, not an error.
 */
async function quarantineStale(path: string): Promise<void> {
	const quarantine = `${path}.quarantine.${Date.now()}.${randomBytes(3)
		.toString("hex")}`;
	try {
		await rename(path, quarantine);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return;
		throw err;
	}
}

function isStale(
	identity: LeaseIdentity,
	isAlive: (pid: number) => Promise<boolean>,
	currentProcessStart: string,
): boolean {
	// Provable staleness: the owning PID is not alive, or the recorded
	// process-start identity is foreign to the current manager. A lock owned by
	// the current manager (matching PID alive + matching start) is never stale.
	return !isAlive(identity.pid) || identity.processStart !== currentProcessStart;
}

/**
 * Acquire an exclusive, generation-safe lease on `path`, owned by `owner`.
 *
 * The owner creates the lock with an atomic exclusive open, flushes its
 * identity, and returns a {@link ManagerLease}. If the path is occupied the
 * caller either:
 *
 * - retries with bounded exponential backoff when the existing file is an
 *   incomplete just-created payload, or
 * - reclaims it when the existing identity is stale (dead PID or foreign
 *   process-start), renaming the stale lock to a unique quarantine name before
 *   retrying exclusive creation — so competing reclaimers converge on one
 *   winner.
 *
 * A live, non-stale owner always wins; contenders throw once the retry budget
 * is exhausted or when a live owner refuses.
 *
 * @param path  The lock file path (for example `<parentRoot>/manager.lock`).
 * @param owner The owner label recorded in the flushed identity.
 * @param signal Optional {@link AbortSignal}; aborting stops retrying and
 *   throws the abort reason.
 * @param deps Injectable dependencies (defaults used when omitted).
 *
 * @throws when the signal is aborted, when a live owner refuses, or when the
 *   retry budget is exhausted on a persistent incomplete payload.
 */
export async function acquireManagerLease(
	path: string,
	owner: string,
	signal: AbortSignal,
	deps: LeaseDeps = {},
): Promise<ManagerLease> {
	const now = deps.now ?? Date.now;
	const currentPid = deps.currentPid ?? (() => process.pid);
	const processStartFn = deps.processStart ?? processStartIdentity;
	const currentProcessStart = processStartFn();
	const random = deps.randomGeneration ?? defaultGeneration;
	const isAlive = deps.isProcessAlive ?? defaultIsProcessAlive;
	const maxRetries = deps.maxRetries ?? DEFAULT_MAX_RETRIES;

	const identity: LeaseIdentity = {
		owner,
		pid: currentPid(),
		processStart: currentProcessStart,
		generation: random(),
		acquiredAt: now(),
	};

	const buildLease = (): ManagerLease => ({
		path,
		owner,
		generation: identity.generation,
		pid: identity.pid,
		processStart: identity.processStart,
		async assertCurrent(): Promise<void> {
			const state = await readLockState(path);
			if (state === null) {
				throw new Error(`lease not held (released by another): ${path}`);
			}
			if (state.kind === "incomplete") {
				throw new Error(`lease payload incomplete: ${path}`);
			}
			const onDisk = state.identity;
			if (
				onDisk.generation !== identity.generation ||
				onDisk.pid !== identity.pid ||
				onDisk.processStart !== identity.processStart
			) {
				throw new Error(
					`lease superseded at ${path} ` +
						`(on-disk generation ${onDisk.generation} != ${identity.generation})`,
				);
			}
		},
		async release(): Promise<boolean> {
			const state = await readLockState(path);
			if (state === null) return false; // already gone: idempotent
			if (state.kind !== "complete") return false; // not finished by owner
			const onDisk = state.identity;
			if (
				onDisk.generation !== identity.generation ||
				onDisk.pid !== identity.pid ||
				onDisk.processStart !== identity.processStart
			) {
				// Owner-only: never unlink a successor's or foreign owner's lock.
				return false;
			}
			try {
				await unlink(path);
				return true;
			} catch (err) {
				if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
				throw err;
			}
		},
	});

	let attempt = 0;
	for (;;) {
		signal.throwIfAborted();

		if (attempt > 0) {
			await sleep(jitteredBackoff(attempt, deps));
		}

		try {
			if (await tryCreateExclusive(path, identity)) {
				return buildLease();
			}
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
		}

		const state = await readLockState(path);

		if (state === null) {
			// Freed between our failed create and the read: retry creation.
			attempt++;
			continue;
		}

		if (state.kind === "incomplete") {
			if (attempt >= maxRetries) {
				throw new Error(
					`lock incomplete after ${maxRetries} retries: ${path}`,
				);
			}
			await deps.onRetry?.(attempt + 1);
			attempt++;
			continue;
		}

		if (isStale(state.identity, isAlive, currentProcessStart)) {
			// Reclaim: quarantine the stale lock to a unique name, then retry
			// exclusive creation. Competing reclaimers converge on one winner.
			if (attempt >= maxRetries) {
				throw new Error(
					`stale lock unreclaimed after ${maxRetries} retries: ${path}`,
				);
			}
			await quarantineStale(path);
			await deps.onRetry?.(attempt + 1);
			attempt++;
			continue;
		}

		throw new Error(
			`lock held by ${state.identity.owner} (pid ${state.identity.pid}) at ${path}`,
		);
	}
}

/**
 * Acquire a short-lived {@link ManagerLease}, run `fn` with it, and always
 * release it afterward. Used for the registry lock that guards a single
 * enqueue, group membership, or manifest publication.
 *
 * @throws the abort reason if `signal` is aborted, or any error `fn` throws
 *   (the lease is still released in that case).
 */
export async function withRegistryLock<T>(
	path: string,
	owner: string,
	fn: (lease: ManagerLease) => Promise<T> | T,
	signal: AbortSignal,
	deps: LeaseDeps = {},
): Promise<T> {
	const lease = await acquireManagerLease(path, owner, signal, deps);
	try {
		return await fn(lease);
	} finally {
		await lease.release().catch(() => undefined);
	}
}
