import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, readFile, stat, readdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
	acquireManagerLease,
	withRegistryLock,
	type ManagerLease,
	type LeaseDeps,
} from "../locks.ts";

// ---------------------------------------------------------------------------
// Deterministic identity / liveness seams
//
// The lock contract reasons about (pid, process-start) owner identity. All of
// that is injected so the tests never depend on the real test process and can
// model a dead / foreign / live owner deterministically.
// ---------------------------------------------------------------------------

/** A pid that the injected liveness predicate treats as alive. */
const ALIVE_PID = 1000;
/** A pid the injected liveness predicate treats as dead. */
const DEAD_PID = 2_147_418_246;
/** The current process's injected start identity. */
const CUR_START = "cur-process-start-hash";
/** A foreign process's start identity (not the current one). */
const FOREIGN_START = "foreign-process-start-hash";

function baseDeps(overrides: Partial<LeaseDeps> = {}): LeaseDeps {
	return {
		now: () => 1_700_000_000_000,
		currentPid: () => ALIVE_PID,
		processStart: () => CUR_START,
		randomGeneration: () =>
			`gen-${Math.random().toString(36).slice(2, 10)}`,
		isProcessAlive: async (pid: number) => pid === ALIVE_PID,
		maxRetries: 8,
		baseDelayMs: 0,
		maxDelayMs: 0,
		...overrides,
	};
}

async function writeSeed(
	path: string,
	identity: {
		owner: string;
		pid: number;
		processStart: string;
		generation: string;
		acquiredAt: number;
	},
): Promise<void> {
	await writeFile(path, `${JSON.stringify(identity, null, 2)}\n`, {
		mode: 0o600,
	});
}

async function readSeed(path: string): Promise<Record<string, unknown>> {
	return JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
}

let root: string;
let path: string;

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "subagent-locks-"));
	path = join(root, "manager.lock");
});

afterEach(async () => {
	// best-effort cleanup of any quarantined leftovers
	try {
		const entries = await readdir(root);
		for (const entry of entries) {
			if (entry !== "manager.lock") await unlink(join(root, entry));
		}
	} catch {
		// ignore
	}
});

// ---------------------------------------------------------------------------
// acquireManagerLease — exclusive creation + flushed identity payload
// ---------------------------------------------------------------------------

describe("acquireManagerLease — exclusive creation", () => {
	it("creates the lock and flushes a complete identity payload", async () => {
		const lease = await acquireManagerLease(path, "ownerA", signal(), baseDeps());

		expect(lease.owner).toBe("ownerA");
		expect(lease.pid).toBe(ALIVE_PID);
		expect(lease.processStart).toBe(CUR_START);

		// the on-disk payload is present, non-empty, and fully formed
		const text = await readFile(path, "utf8");
		expect(text.length).toBeGreaterThan(0);
		const payload = JSON.parse(text) as Record<string, unknown>;
		expect(payload.owner).toBe("ownerA");
		expect(payload.pid).toBe(ALIVE_PID);
		expect(payload.processStart).toBe(CUR_START);
		expect(payload.generation).toBe(lease.generation);
		expect(typeof payload.acquiredAt).toBe("number");
	});

	it("refuses a second live owner (exactly one holder)", async () => {
		const first = await acquireManagerLease(path, "ownerA", signal(), baseDeps());
		expect(first.owner).toBe("ownerA");

		await expect(
			acquireManagerLease(path, "ownerB", signal(), baseDeps()),
		).rejects.toThrow(/held by ownerA/);

		await first.release();
	});

	it("converges to a single winner under concurrent acquisition", async () => {
		const results = await Promise.allSettled([
			acquireManagerLease(path, "ownerA", signal(), baseDeps()),
			acquireManagerLease(path, "ownerB", signal(), baseDeps()),
		]);
		const fulfilled = results.filter((r) => r.status === "fulfilled");
		const rejected = results.filter((r) => r.status === "rejected");

		expect(fulfilled).toHaveLength(1);
		expect(rejected).toHaveLength(1);
		expect(["ownerA", "ownerB"]).toContain(
			(fulfilled[0] as PromiseFulfilledResult<ManagerLease>).value.owner,
		);
	});
});

// ---------------------------------------------------------------------------
// incomplete just-created payload — bounded retry then back off / succeed
// ---------------------------------------------------------------------------

describe("acquireManagerLease — incomplete payload", () => {
	it("retries an incomplete payload, then acquires once it is flushed", async () => {
		await writeFile(path, ""); // 0-byte / just-created-in-progress
		const retries: number[] = [];
		const deps = baseDeps({
			maxRetries: 5,
			onRetry: (n) => {
				retries.push(n);
				// resolve the race: the creator finished between retries 1 and 2
				if (n >= 2) void unlink(path);
			},
		});

		const lease = await acquireManagerLease(path, "ownerA", signal(), deps);
		expect(lease.owner).toBe("ownerA");
		expect(retries.length).toBeGreaterThanOrEqual(1);
	});

	it("fails with a clear error after the retry budget is exhausted", async () => {
		await writeFile(path, ""); // stays incomplete forever
		await expect(
			acquireManagerLease(path, "ownerA", signal(), baseDeps({ maxRetries: 3 })),
		).rejects.toThrow(/incomplete/i);
	});
});

// ---------------------------------------------------------------------------
// stale detection — PID dead, and foreign process-start identity
// ---------------------------------------------------------------------------

describe("acquireManagerLease — stale reclamation", () => {
	it("reclaims a dead-PID lock via a unique quarantine rename", async () => {
		await writeSeed(path, {
			owner: "deadowner",
			pid: DEAD_PID,
			processStart: FOREIGN_START,
			generation: "gStale",
			acquiredAt: 1,
		});

		const lease = await acquireManagerLease(
			path,
			"ownerA",
			signal(),
			baseDeps(),
		);

		expect(lease.generation).not.toBe("gStale");
		expect(lease.owner).toBe("ownerA");

		// the stale lock was renamed to a unique quarantine name, not unlinked
		const entries = await readdir(root);
		expect(entries.some((f) => f.startsWith("manager.lock.quarantine."))).toBe(
			true,
		);

		// and a fresh, complete lease now owns the path
		const onDisk = await readSeed(path);
		expect(onDisk.owner).toBe("ownerA");
	});

	it("reclaims a lock whose process-start identity is foreign", async () => {
		// pid alive but the start identity does not match the current process:
		// not our manager, so it is stale and reclaimable.
		await writeSeed(path, {
			owner: "foreign",
			pid: ALIVE_PID,
			processStart: FOREIGN_START,
			generation: "gForeign",
			acquiredAt: 1,
		});

		const lease = await acquireManagerLease(
			path,
			"ownerA",
			signal(),
			baseDeps(),
		);
		expect(lease.owner).toBe("ownerA");
	});
});

// ---------------------------------------------------------------------------
// competing reclaimers converge on one winner
// ---------------------------------------------------------------------------

describe("acquireManagerLease — competing quarantine", () => {
	it("converges to one winner when two owners reclaim a stale lock", async () => {
		await writeSeed(path, {
			owner: "dead",
			pid: DEAD_PID,
			processStart: FOREIGN_START,
			generation: "gStale",
			acquiredAt: 1,
		});

		const results = await Promise.allSettled([
			acquireManagerLease(path, "ownerA", signal(), baseDeps()),
			acquireManagerLease(path, "ownerB", signal(), baseDeps()),
		]);
		const fulfilled = results.filter((r) => r.status === "fulfilled");

		expect(fulfilled).toHaveLength(1);
		// at least one competitor performed the atomic quarantine rename
		const entries = await readdir(root);
		expect(entries.some((f) => f.startsWith("manager.lock.quarantine."))).toBe(
			true,
		);
	});
});

// ---------------------------------------------------------------------------
// generation checks + owner-only release (no stale mutation / successor unlink)
// ---------------------------------------------------------------------------

describe("ManagerLease — generation protection and release", () => {
	it("is released owner-only and idempotently", async () => {
		const lease = await acquireManagerLease(path, "ownerA", signal(), baseDeps());
		expect(await lease.release()).toBe(true);
		expect(await lease.release()).toBe(false); // idempotent
		await expect(stat(path)).rejects.toThrow();
	});

	it("assertCurrent rejects a superseded lease and release refuses to unlink the successor", async () => {
		const lease = await acquireManagerLease(path, "ownerA", signal(), baseDeps());
		const gA = lease.generation;

		// a successor reclaims + re-acquires: a fresh lock on disk
		await writeSeed(path, {
			owner: "ownerB",
			pid: ALIVE_PID,
			processStart: CUR_START,
			generation: "gSuccessor",
			acquiredAt: 2,
		});

		await expect(lease.assertCurrent()).rejects.toThrow(/superseded/i);
		expect(await lease.release()).toBe(false);

		// the stale owner never unlinked the successor's lock
		const successor = await readSeed(path);
		expect(successor.generation).toBe("gSuccessor");

		// release stays idempotent even after supersession
		expect(lease.generation).toBe(gA);
		expect(await lease.release()).toBe(false);
	});

	it("never unlinks a lock owned by another generation", async () => {
		const lease = await acquireManagerLease(path, "ownerA", signal(), baseDeps());

		// an intruder writes a complete, "live" lock under a different generation
		await writeSeed(path, {
			owner: "intruder",
			pid: ALIVE_PID,
			processStart: CUR_START,
			generation: "gIntruder",
			acquiredAt: 2,
		});

		expect(await lease.release()).toBe(false);

		// the intruder's lock is left intact — no stale unlink
		const onDisk = await readSeed(path);
		expect(onDisk.generation).toBe("gIntruder");
	});
});

// ---------------------------------------------------------------------------
// AbortSignal support
// ---------------------------------------------------------------------------

describe("acquireManagerLease — AbortSignal", () => {
	it("rejects an already-aborted signal without touching disk", async () => {
		const controller = new AbortController();
		controller.abort();

		await expect(
			acquireManagerLease(path, "ownerA", controller.signal, baseDeps()),
		).rejects.toThrow();
		await expect(stat(path)).rejects.toThrow(); // nothing created
	});

	it("stops retrying when aborted mid-wait", async () => {
		await writeFile(path, ""); // stays incomplete
		const controller = new AbortController();
		const deps = baseDeps({
			maxRetries: 10,
			onRetry: (n) => {
				if (n === 1) controller.abort();
			},
		});

		await expect(
			acquireManagerLease(path, "ownerA", controller.signal, deps),
		).rejects.toThrow();
	});
});

// ---------------------------------------------------------------------------
// withRegistryLock — short-lived lease
// ---------------------------------------------------------------------------

describe("withRegistryLock", () => {
	it("runs fn under a lease and releases the lock afterwards", async () => {
		let sawOwner = "";
		let sawGeneration = "";
		const result = await withRegistryLock(
			path,
			"ownerA",
			async (lease) => {
				sawOwner = lease.owner;
				sawGeneration = lease.generation;
				await lease.assertCurrent();
				return "ok";
			},
			signal(),
			baseDeps(),
		);

		expect(result).toBe("ok");
		expect(sawOwner).toBe("ownerA");
		expect(sawGeneration.length).toBeGreaterThan(0);

		// the short-lived lock is released once fn returns
		await expect(stat(path)).rejects.toThrow();
	});
});

/** A fresh, un-aborted AbortSignal used by every scenario above. */
function signal(): AbortSignal {
	return new AbortController().signal;
}
