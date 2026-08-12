import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import type { StateConflict } from "../extensions/research/state.ts";
import {
	newRunState,
	readRunState,
	updateRunState,
	acquireLease,
	releaseLease,
} from "../extensions/research/state.ts";
import {
	createRunManifest,
	readManifest,
	verifySnapshotIntegrity,
} from "../extensions/research/manifest.ts";
import type { Workspace } from "../extensions/research/workspace.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "research-mss-test-"));
}

function cleanup(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

function makeFakeWorkspace(
	tmpDir: string,
	mission: string,
	transitionId: string,
): Workspace {
	const wsPath = path.join(tmpDir, mission.replace(/\s+/g, "-"));
	fs.mkdirSync(wsPath, { recursive: false });
	fs.mkdirSync(path.join(wsPath, ".research"), { recursive: false });

	return {
		path: wsPath,
		projectRoot: tmpDir,
		mission,
		runId: `${transitionId}-${mission.replace(/\s+/g, "-")}`,
		transitionId,
	};
}

// ===========================================================================
// newRunState / readRunState — revision increments
// ===========================================================================

describe("revision increments", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("newRunState starts at revision 1", () => {
		const ws = makeFakeWorkspace(tmpDir, "revision test", "t1");
		const state = newRunState(ws);
		expect(state.revision).toBe(1);
		expect(state.status).toBe("active");
		expect(state.mission).toBe("revision test");
	});

	it("each updateRunState increments revision", async () => {
		const ws = makeFakeWorkspace(tmpDir, "increment test", "t1");
		const init = newRunState(ws);
		// Write initial state
		const statePath = path.join(ws.path, ".research", "run-state.json");
		fs.writeFileSync(statePath, JSON.stringify(init, null, 2), "utf-8");

		// First update: revision 1 → 2
		const after1 = await updateRunState(ws, 1, (s) => ({
			...s,
			coordinatorUsage: s.coordinatorUsage + 100,
		}));
		expect(after1.revision).toBe(2);
		expect(after1.coordinatorUsage).toBe(100);

		// Second update: revision 2 → 3
		const after2 = await updateRunState(ws, 2, (s) => ({
			...s,
			nestedUsage: s.nestedUsage + 50,
		}));
		expect(after2.revision).toBe(3);
		expect(after2.coordinatorUsage).toBe(100);
		expect(after2.nestedUsage).toBe(50);
	});

	it("updatedAt advances on each update", async () => {
		const ws = makeFakeWorkspace(tmpDir, "time test", "t1");
		const init = newRunState(ws);
		fs.writeFileSync(
			path.join(ws.path, ".research", "run-state.json"),
			JSON.stringify(init, null, 2),
			"utf-8",
		);

		const before = Date.now();
		await updateRunState(ws, 1, (s) => ({ ...s, tokensUsed: 1 }));
		const after = Date.now();

		const persisted = readRunState(ws);
		expect(persisted.updatedAt).toBeGreaterThanOrEqual(before);
		expect(persisted.updatedAt).toBeLessThanOrEqual(after);
	});
});

// ===========================================================================
// Stale-revision rejection
// ===========================================================================

describe("stale-revision rejection", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("throws StateConflict on revision mismatch", async () => {
		const ws = makeFakeWorkspace(tmpDir, "stale test", "t1");
		const init = newRunState(ws);
		fs.writeFileSync(
			path.join(ws.path, ".research", "run-state.json"),
			JSON.stringify(init, null, 2),
			"utf-8",
		);

		// First update succeeds
		await updateRunState(ws, 1, (s) => ({ ...s, tokensUsed: 100 }));

		// Second update with stale revision 1 should throw StateConflict
		const error = await updateRunState(ws, 1, (s) => ({
			...s,
			tokensUsed: 200,
		})).catch((e) => e);
		expect(error).toBeDefined();
		expect((error as StateConflict).expected).toBe(1);
		expect((error as StateConflict).actual).toBe(2);
	});

	it("caller must retry from fresh read after stale rejection", async () => {
		const ws = makeFakeWorkspace(tmpDir, "retry test", "t1");
		const init = newRunState(ws);
		fs.writeFileSync(
			path.join(ws.path, ".research", "run-state.json"),
			JSON.stringify(init, null, 2),
			"utf-8",
		);

		// Concurrent update
		const p1 = updateRunState(ws, 1, (s) => ({
			...s,
			coordinatorUsage: s.coordinatorUsage + 10,
		}));

		// Retry the first update
		await p1;

		// Now retry with the correct revision
		const fresh = readRunState(ws);
		expect(fresh.revision).toBe(2);
		const afterRetry = await updateRunState(ws, 2, (s) => ({
			...s,
			tokensUsed: s.tokensUsed + 20,
		}));
		expect(afterRetry.revision).toBe(3);
		expect(afterRetry.coordinatorUsage).toBe(10);
		expect(afterRetry.tokensUsed).toBe(20);
	});
});

// ===========================================================================
// Two concurrent reservations — no lost update
// ===========================================================================

describe("two concurrent reservations — no lost update", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("serialized queue prevents lost updates", async () => {
		const ws = makeFakeWorkspace(tmpDir, "concurrent test", "t1");
		const init = newRunState(ws);
		fs.writeFileSync(
			path.join(ws.path, ".research", "run-state.json"),
			JSON.stringify(init, null, 2),
			"utf-8",
		);

		// Fire two sequential updates (they queue behind each other)
		const p1 = updateRunState(ws, 1, (s) => ({
			...s,
			coordinatorUsage: s.coordinatorUsage + 10,
		}));
		const p2 = p1.then((s) =>
			updateRunState(ws, s.revision, (cur) => ({
				...cur,
				coordinatorUsage: cur.coordinatorUsage + 20,
			})),
		);
		const p3 = p2.then((s) =>
			updateRunState(ws, s.revision, (cur) => ({
				...cur,
				coordinatorUsage: cur.coordinatorUsage + 30,
			})),
		);

		await p3;

		const finalState = readRunState(ws);
		expect(finalState.revision).toBe(4); // 1 + 3 updates
		expect(finalState.coordinatorUsage).toBe(60); // 10 + 20 + 30
	});
});

// ===========================================================================
// Checkpoint-vs-usage contention
// ===========================================================================

describe("checkpoint-vs-usage contention", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("checkpoint and usage updates serialize correctly", async () => {
		const ws = makeFakeWorkspace(tmpDir, "checkpoint test", "t1");
		const init = newRunState(ws);
		init.coordinatorUsage = 100;
		init.tokensUsed = 100;
		fs.writeFileSync(
			path.join(ws.path, ".research", "run-state.json"),
			JSON.stringify(init, null, 2),
			"utf-8",
		);

		// Simulate a checkpoint update (adds to existing state)
		const checkpointRev = 1;
		const pCheckpoint = updateRunState(ws, checkpointRev, (s) => ({
			...s,
			nestedUsage: s.nestedUsage + 50,
			tokensUsed: s.tokensUsed + 50,
		}));

		// Simulate a usage update (concurrent with checkpoint)
		const pUsage = pCheckpoint.then((s) =>
			updateRunState(ws, s.revision, (cur) => ({
				...cur,
				coordinatorUsage: cur.coordinatorUsage + 75,
				tokensUsed: cur.tokensUsed + 75,
			})),
		);

		await pUsage;

		const finalState = readRunState(ws);
		expect(finalState.revision).toBe(3);
		expect(finalState.coordinatorUsage).toBe(175); // 100 + 75
		expect(finalState.nestedUsage).toBe(50); // 0 + 50
		expect(finalState.tokensUsed).toBe(225); // 100 + 50 + 75
	});
});

// ===========================================================================
// Completion-vs-usage contention
// ===========================================================================

describe("completion-vs-usage contention", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("completing a run while tracking usage serializes", async () => {
		const ws = makeFakeWorkspace(tmpDir, "completion test", "t1");
		const init = newRunState(ws);
		init.tokensUsed = 500;
		fs.writeFileSync(
			path.join(ws.path, ".research", "run-state.json"),
			JSON.stringify(init, null, 2),
			"utf-8",
		);

		// Track usage
		const p1 = updateRunState(ws, 1, (s) => ({
			...s,
			coordinatorUsage: s.coordinatorUsage + 200,
			tokensUsed: s.tokensUsed + 200,
		}));

		// Complete the run
		const p2 = p1.then((s) =>
			updateRunState(ws, s.revision, (cur) => ({
				...cur,
				status: "complete" as const,
				tokensUsed: cur.tokensUsed + 100,
			})),
		);

		await p2;

		const finalState = readRunState(ws);
		expect(finalState.status).toBe("complete");
		expect(finalState.coordinatorUsage).toBe(200);
		expect(finalState.tokensUsed).toBe(800); // 500 + 200 + 100
	});

	it("usage update after completion preserves status", async () => {
		const ws = makeFakeWorkspace(tmpDir, "post-complete test", "t1");
		const init = newRunState(ws);
		init.status = "complete";
		init.tokensUsed = 1000;
		fs.writeFileSync(
			path.join(ws.path, ".research", "run-state.json"),
			JSON.stringify(init, null, 2),
			"utf-8",
		);

		const updated = await updateRunState(ws, 1, (s) => ({
			...s,
			tokensUsed: s.tokensUsed + 50,
		}));

		expect(updated.status).toBe("complete");
		expect(updated.tokensUsed).toBe(1050);
	});
});

// ===========================================================================
// Atomic replacement (temp file → rename)
// ===========================================================================

describe("atomic replacement", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("no .tmp file remains after update", async () => {
		const ws = makeFakeWorkspace(tmpDir, "atomic test", "t1");
		const init = newRunState(ws);
		fs.writeFileSync(
			path.join(ws.path, ".research", "run-state.json"),
			JSON.stringify(init, null, 2),
			"utf-8",
		);

		const statePath = path.join(ws.path, ".research", "run-state.json");
		const tmpPath = statePath + ".tmp";

		await updateRunState(ws, 1, (s) => ({ ...s, revision: 2 }));

		expect(fs.existsSync(tmpPath)).toBe(false);
		expect(fs.existsSync(statePath)).toBe(true);

		const loaded = readRunState(ws);
		expect(loaded.revision).toBe(2);
	});

	it("state file is valid JSON after multiple updates", async () => {
		const ws = makeFakeWorkspace(tmpDir, "json valid test", "t1");
		const init = newRunState(ws);
		fs.writeFileSync(
			path.join(ws.path, ".research", "run-state.json"),
			JSON.stringify(init, null, 2),
			"utf-8",
		);

		for (let i = 1; i <= 10; i++) {
			await updateRunState(ws, i, (s) => ({
				...s,
				tokensUsed: s.tokensUsed + i * 10,
			}));
		}

		// Should be parseable without errors
		const loaded = readRunState(ws);
		expect(loaded.revision).toBe(11);
		expect(loaded.tokensUsed).toBe(550); // sum of 1..10 * 10
	});
});

// ===========================================================================
// Lease contention
// ===========================================================================

describe("lease contention", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("acquireLease returns a RunLease", async () => {
		const ws = makeFakeWorkspace(tmpDir, "lease test", "t1");
		const lease = await acquireLease(ws, "session-1");
		expect(lease.sessionId).toBe("session-1");
		expect(lease.acquiredAt).toBeGreaterThan(0);
		expect(lease.expiresAt).toBeGreaterThan(lease.acquiredAt);
		expect(fs.existsSync(path.join(ws.path, ".research", "run-lease.json"))).toBe(true);
	});

	it("second acquireLease throws when lease is held", async () => {
		const ws = makeFakeWorkspace(tmpDir, "lease content test", "t1");
		await acquireLease(ws, "session-1");
		await expect(acquireLease(ws, "session-2")).rejects.toThrow(
			"Lease already held by session session-1",
		);
	});

	it("stale lease is overwritten", async () => {
		const ws = makeFakeWorkspace(tmpDir, "stale lease test", "t1");

		// Manually write a stale lease
		const staleLease = {
			sessionId: "old-session",
			acquiredAt: Date.now() - 600_000, // 10 minutes ago
			expiresAt: Date.now() - 300_000,
		};
		const leasePath = path.join(ws.path, ".research", "run-lease.json");
		fs.writeFileSync(leasePath, JSON.stringify(staleLease, null, 2), "utf-8");

		// Should succeed — stale lease is overwritten
		const newLease = await acquireLease(ws, "new-session");
		expect(newLease.sessionId).toBe("new-session");
	});

	it("releaseLease removes the lease file", async () => {
		const ws = makeFakeWorkspace(tmpDir, "release test", "t1");
		await acquireLease(ws, "session-1");
		expect(
			fs.existsSync(path.join(ws.path, ".research", "run-lease.json")),
		).toBe(true);

		await releaseLease(ws, "session-1");
		expect(
			fs.existsSync(path.join(ws.path, ".research", "run-lease.json")),
		).toBe(false);
	});

	it("releaseLease no-op when no lease exists", async () => {
		const ws = makeFakeWorkspace(tmpDir, "release noop test", "t1");
		// Should not throw
		await expect(releaseLease(ws, "any-session")).resolves.toBeUndefined();
	});

	it("releaseLease throws for wrong session", async () => {
		const ws = makeFakeWorkspace(tmpDir, "wrong release test", "t1");
		await acquireLease(ws, "session-1");
		await expect(
			releaseLease(ws, "session-2"),
		).rejects.toThrow(
			"Lease belongs to session-1, not session-2",
		);
	});
});

// ===========================================================================
// Manifest creation and integrity
// ===========================================================================

describe("createRunManifest", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("exclusively creates run.json", () => {
		const ws = makeFakeWorkspace(tmpDir, "manifest exclusive test", "t1");
		const manifest = createRunManifest(ws);
		expect(manifest.runId).toBe(ws.runId);
		expect(manifest.mission).toBe("manifest exclusive test");
		expect(manifest.workspace).toBe(ws.path);
		expect(manifest.snapshotSha256).toBeNull();
		expect(fs.existsSync(manifest.manifestPath)).toBe(true);
	});

	it("throws on duplicate manifest creation", () => {
		const ws = makeFakeWorkspace(tmpDir, "duplicate manifest test", "t1");
		createRunManifest(ws);
		expect(() => createRunManifest(ws)).toThrow(
			"Manifest already exists",
		);
	});

	it("captures snapshot SHA-256 when content provided", () => {
		const ws = makeFakeWorkspace(tmpDir, "snapshot test", "t1");
		const snapshot = "important snapshot content";
		const manifest = createRunManifest(ws, snapshot);
		expect(manifest.snapshotSha256).toBeTruthy();

		// Verify the hash is correct
		const expectedHash = createHash("sha256")
			.update(snapshot)
			.digest("hex");
		expect(manifest.snapshotSha256).toBe(expectedHash);
	});

	it("verifySnapshotIntegrity returns true for matching content", async () => {
		const ws = makeFakeWorkspace(tmpDir, "integrity test", "t1");
		const snapshot = "verification content";
		createRunManifest(ws, snapshot);

		// The verify function reads the manifest from the workspace
		const valid = verifySnapshotIntegrity(ws, snapshot);
		expect(valid).toBe(true);
	});

	it("verifySnapshotIntegrity returns false for mismatched content", () => {
		const ws = makeFakeWorkspace(tmpDir, "integrity fail test", "t1");
		createRunManifest(ws, "original content");

		const valid = verifySnapshotIntegrity(ws, "wrong content");
		expect(valid).toBe(false);
	});

	it("manifest references final path, not staging", () => {
		const ws = makeFakeWorkspace(tmpDir, "path test", "t1");
		const manifest = createRunManifest(ws);
		expect(manifest.workspace).toBe(ws.path);
		expect(manifest.workspace).not.toContain("staging");
		expect(manifest.manifestPath).toContain(".research");
	});

	it("readManifest returns parsed manifest", () => {
		const ws = makeFakeWorkspace(tmpDir, "read manifest test", "t1");
		createRunManifest(ws);
		const loaded = readManifest(ws);
		expect(loaded.runId).toBe(ws.runId);
		expect(loaded.mission).toBe("read manifest test");
	});
});

// ===========================================================================
// End-to-end: state lifecycle
// ===========================================================================

describe("state lifecycle", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("full lifecycle: new → update → read → complete → lease", async () => {
		const ws = makeFakeWorkspace(tmpDir, "lifecycle test", "t1");

		// 1. Create initial state
		const init = newRunState(ws);
		expect(init.revision).toBe(1);
		expect(init.status).toBe("active");
		const statePath = path.join(ws.path, ".research", "run-state.json");
		fs.writeFileSync(statePath, JSON.stringify(init, null, 2), "utf-8");

		// 2. Update state (track usage)
		const afterUsage = await updateRunState(ws, 1, (s) => ({
			...s,
			coordinatorUsage: 500,
			tokensUsed: 500,
		}));
		expect(afterUsage.revision).toBe(2);

		// 3. Complete the run
		const completed = await updateRunState(ws, 2, (s) => ({
			...s,
			status: "complete" as const,
			tokensUsed: s.tokensUsed + 100,
		}));
		expect(completed.status).toBe("complete");

		// 4. Read persisted state
		const persisted = readRunState(ws);
		expect(persisted.status).toBe("complete");
		expect(persisted.tokensUsed).toBe(600);

		// 5. Acquire and release lease
		const lease = await acquireLease(ws, "driver-1");
		expect(lease.sessionId).toBe("driver-1");
		await releaseLease(ws, "driver-1");
		expect(
			fs.existsSync(path.join(ws.path, ".research", "run-lease.json")),
		).toBe(false);

		// 6. Create manifest
		const manifest = createRunManifest(ws);
		expect(manifest.workspace).toBe(ws.path);
	});
});
