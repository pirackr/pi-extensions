import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import {
	commitStaging,
	acquireWorkspaceClaim,
	prepareStaging,
	ensureGitExclude,
	reconcileTransition,
	discoverVisibleEntries,
} from "../extensions/research/workspace.ts";
import { createRunManifest, readManifest } from "../extensions/research/manifest.ts";
import {
	newRunState,
	readRunState,
	updateRunState,
	acquireLease,
	releaseLease,
} from "../extensions/research/state.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "research-ws-test-"));
}

function cleanup(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

function writeManifestInStaging(
	stagingPath: string,
	mission: string,
	transitionId: string,
): void {
	// Create a fake workspace structure in staging
	const researchDir = path.join(stagingPath, ".research");
	fs.mkdirSync(researchDir, { recursive: false });

	// Write a placeholder manifest using the final dir name
	const manifest: any = {
		runId: `${transitionId}-${path.basename(stagingPath).replace(".staging-", "")}`,
		mission,
		workspace: path.join(path.dirname(stagingPath), path.basename(stagingPath).replace(".staging-", "")),
		manifestPath: "placeholder",
		createdAt: Date.now(),
		snapshotSha256: null,
	};
	fs.writeFileSync(
		path.join(researchDir, "run.json"),
		JSON.stringify(manifest, null, 2),
		"utf-8",
	);

	// Write initial state
	const state = {
		revision: 1,
		status: "active" as const,
		createdAt: Date.now(),
		updatedAt: Date.now(),
		mission,
		runId: manifest.runId,
		coordinatorUsage: 0,
		nestedUsage: 0,
		tokensUsed: 0,
	};
	fs.writeFileSync(
		path.join(researchDir, "run-state.json"),
		JSON.stringify(state, null, 2),
		"utf-8",
	);
}

// ===========================================================================
// acquireWorkspaceClaim — exclusive claims
// ===========================================================================

describe("acquireWorkspaceClaim", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("creates an exclusive hidden claim directory", () => {
		const claim = acquireWorkspaceClaim(tmpDir, "my research", "t1");
		expect(claim.finalDir).toBe("my-research");
		expect(claim.claimPath).toMatch(/\.claim-my-research-t1$/);
		expect(fs.statSync(claim.claimPath).isDirectory()).toBe(true);
	});

	it("stores metadata inside the claim dir", () => {
		const claim = acquireWorkspaceClaim(tmpDir, "deep dive", "t2");
		const metaPath = path.join(claim.claimPath, ".meta.json");
		expect(fs.existsSync(metaPath)).toBe(true);
		const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
		expect(meta.mission).toBe("deep dive");
		expect(meta.finalDir).toBe("deep-dive");
		expect(meta.transitionId).toBe("t2");
	});

	it("throws for non-existent project root", () => {
		const nonExistent = path.join(tmpDir, "does-not-exist");
		expect(() =>
			acquireWorkspaceClaim(nonExistent, "mission", "t1"),
		).toThrow("Project root does not exist");
	});

	it("slugifies mission to URL-safe form", () => {
		const claim = acquireWorkspaceClaim(tmpDir, "Hello World 123!", "t1");
		expect(claim.finalDir).toBe("hello-world-123");
	});

	it("truncates long slugs to 30 chars", () => {
		const longMission = "a".repeat(100);
		const claim = acquireWorkspaceClaim(tmpDir, longMission, "t1");
		expect(claim.finalDir.length).toBe(30);
	});
});

// ===========================================================================
// Suffix allocation
// ===========================================================================

describe("suffix allocation", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("allocates -2 when -1 is taken", () => {
		const first = acquireWorkspaceClaim(tmpDir, "same mission", "t1");
		const second = acquireWorkspaceClaim(tmpDir, "same mission", "t2");
		expect(first.finalDir).toBe("same-mission");
		expect(second.finalDir).toBe("same-mission-2");
	});

	it("allocates -3 after -2 is taken", () => {
		acquireWorkspaceClaim(tmpDir, "same mission", "t1");
		acquireWorkspaceClaim(tmpDir, "same mission", "t2");
		const third = acquireWorkspaceClaim(tmpDir, "same mission", "t3");
		expect(third.finalDir).toBe("same-mission-3");
	});

	it("throws when all three suffixes are exhausted", () => {
		acquireWorkspaceClaim(tmpDir, "same mission", "t1");
		acquireWorkspaceClaim(tmpDir, "same mission", "t2");
		acquireWorkspaceClaim(tmpDir, "same mission", "t3");
		expect(() =>
			acquireWorkspaceClaim(tmpDir, "same mission", "t4"),
		).toThrow("all suffixes taken");
	});

	it("different missions can use the same base slug", () => {
		const claim1 = acquireWorkspaceClaim(tmpDir, "mission alpha", "t1");
		expect(claim1.finalDir).toBe("mission-alpha");
		const claim2 = acquireWorkspaceClaim(tmpDir, "mission beta", "t2");
		expect(claim2.finalDir).toBe("mission-beta");
	});
});

// ===========================================================================
// Two concurrent starts (sequential claim attempts)
// ===========================================================================

describe("two concurrent starts", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("sequential claims yield distinct final dirs", () => {
		const claim1 = acquireWorkspaceClaim(tmpDir, "research project", "start-1");
		const claim2 = acquireWorkspaceClaim(tmpDir, "research project", "start-2");
		expect(claim1.finalDir).not.toBe(claim2.finalDir);
		expect(fs.statSync(claim1.claimPath).isDirectory()).toBe(true);
		expect(fs.statSync(claim2.claimPath).isDirectory()).toBe(true);
	});
});

// ===========================================================================
// Stale claims
// ===========================================================================

describe("stale claims", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("detects and cleans stale claim during reconciliation", () => {
		const claim = acquireWorkspaceClaim(tmpDir, "stale test", "t1");
		// Simulate crash: claim exists, no staging, no final
		const result = reconcileTransition(tmpDir, "t1", claim.finalDir);
		expect(result.status).toBe("rollback");
		expect(fs.existsSync(claim.claimPath)).toBe(false); // cleaned up
	});
});

// ===========================================================================
// Staging and commit — target appearance before rename
// ===========================================================================

describe("staging and commitStaging", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("prepares staging directory", () => {
		const claim = acquireWorkspaceClaim(tmpDir, "staging test", "t1");
		const staged = prepareStaging(claim);
		expect(staged.finalDir).toBe(claim.finalDir);
		expect(staged.stagingPath).toMatch(/\.staging-staging-test$/);
		expect(fs.statSync(staged.stagingPath).isDirectory()).toBe(true);
	});

	it("commitStaging renames staging to final and returns Workspace", () => {
		const claim = acquireWorkspaceClaim(tmpDir, "commit test", "t1");
		const staged = prepareStaging(claim);
		// Write manifest/state in staging so commit succeeds
		writeManifestInStaging(staged.stagingPath, "commit test", "t1");

		const ws = commitStaging(staged, claim);
		expect(ws.path).toBe(path.join(tmpDir, claim.finalDir));
		expect(ws.mission).toBe("commit test");
		expect(ws.transitionId).toBe("t1");
		expect(fs.statSync(ws.path).isDirectory()).toBe(true);
		expect(fs.existsSync(claim.claimPath)).toBe(false); // claim removed
	});

	it("target appearance before rename triggers rollback", () => {
		const claim = acquireWorkspaceClaim(tmpDir, "collision test", "t1");
		const staged = prepareStaging(claim);

		// Pre-create the target directory (simulating race)
		const finalPath = path.join(tmpDir, claim.finalDir);
		fs.mkdirSync(finalPath, { recursive: false });

		expect(() => commitStaging(staged, claim)).toThrow(
			"Workspace target appeared before commit",
		);
		expect(fs.existsSync(staged.stagingPath)).toBe(false); // staging cleaned
	});
});

// ===========================================================================
// Final-path manifest values
// ===========================================================================

describe("final-path manifest values", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("manifest workspace references final path, not staging", () => {
		const claim = acquireWorkspaceClaim(tmpDir, "manifest path test", "t1");
		const staged = prepareStaging(claim);

		const stagingBase = path.basename(staged.stagingPath);

		// Write manifest in staging with the final path
		const finalPath = path.join(tmpDir, claim.finalDir);
		const researchDir = path.join(staged.stagingPath, ".research");
		fs.mkdirSync(researchDir, { recursive: false });
		const manifest: any = {
			runId: "test-run",
			mission: "manifest path test",
			workspace: finalPath,
			manifestPath: path.join(researchDir, "run.json"),
			createdAt: Date.now(),
			snapshotSha256: null,
		};
		fs.writeFileSync(
			path.join(researchDir, "run.json"),
			JSON.stringify(manifest, null, 2),
			"utf-8",
		);
		const state = {
			revision: 1,
			status: "active" as const,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			mission: "manifest path test",
			runId: "test-run",
			coordinatorUsage: 0,
			nestedUsage: 0,
			tokensUsed: 0,
		};
		fs.writeFileSync(
			path.join(researchDir, "run-state.json"),
			JSON.stringify(state, null, 2),
			"utf-8",
		);

		const ws = commitStaging(staged, claim);

		// Manifest was written with the final path in staging
		const manifestPath = path.join(ws.path, ".research", "run.json");
		const readManifestData = JSON.parse(
			fs.readFileSync(manifestPath, "utf-8"),
		) as typeof manifest;
		expect(readManifestData.workspace).toBe(ws.path); // final path
		expect(readManifestData.workspace).not.toContain(stagingBase); // never staging
	});
});

// ===========================================================================
// Hidden-entry discovery exclusion
// ===========================================================================

describe("hidden-entry discovery exclusion", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("discoverVisibleEntries excludes hidden dirs", () => {
		// Create visible and hidden entries
		fs.mkdirSync(path.join(tmpDir, "visible-dir"));
		fs.mkdirSync(path.join(tmpDir, ".hidden-claim"));
		fs.mkdirSync(path.join(tmpDir, ".staging-something"));
		fs.writeFileSync(path.join(tmpDir, "visible-file"), "data");
		fs.writeFileSync(path.join(tmpDir, ".hidden-file"), "data");

		const visible = discoverVisibleEntries(tmpDir);
		expect(visible).toContain("visible-dir");
		expect(visible).toContain("visible-file");
		expect(visible).not.toContain(".hidden-claim");
		expect(visible).not.toContain(".staging-something");
		expect(visible).not.toContain(".hidden-file");
	});

	it("hidden claim dirs are not visible during discovery", () => {
		const claim = acquireWorkspaceClaim(tmpDir, "discover test", "t1");
		const staged = prepareStaging(claim);
		const visible = discoverVisibleEntries(tmpDir);
		expect(visible).not.toContain(
			path.basename(claim.claimPath),
		);
		expect(visible).not.toContain(
			path.basename(staged.stagingPath),
		);
		expect(visible).not.toContain(".claim-" + claim.finalDir);
		expect(visible).not.toContain(".staging-" + staged.finalDir);
	});
});

// ===========================================================================
// Git exclusion
// ===========================================================================

describe("ensureGitExclude", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("adds .research/ to .gitignore in a git repo", () => {
		// Set up a fake git repo
		fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: false });
		const gitignore = path.join(tmpDir, ".gitignore");
		fs.writeFileSync(gitignore, "# existing\n\n", "utf-8");

		ensureGitExclude(tmpDir);

		const content = fs.readFileSync(gitignore, "utf-8");
		expect(content).toContain(".research/");
	});

	it("is idempotent — no duplicate entry", () => {
		fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: false });
		const gitignore = path.join(tmpDir, ".gitignore");
		fs.writeFileSync(
			gitignore,
			"# existing\n.research/\n",
			"utf-8",
		);

		ensureGitExclude(tmpDir);

		const content = fs.readFileSync(gitignore, "utf-8");
		const count = (content.match(/\.research\//g) || []).length;
		expect(count).toBe(1);
	});

	it("is a no-op outside git", () => {
		const gitignore = path.join(tmpDir, ".gitignore");
		fs.writeFileSync(gitignore, "# other\n", "utf-8");

		ensureGitExclude(tmpDir); // no .git directory

		const content = fs.readFileSync(gitignore, "utf-8");
		expect(content).toBe("# other\n");
	});
});

// ===========================================================================
// Transition recovery in both directions
// ===========================================================================

describe("transition recovery", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("rollback: claim exists, no staging, no final", () => {
		const claim = acquireWorkspaceClaim(tmpDir, "recover test", "t1");
		const result = reconcileTransition(tmpDir, "t1", claim.finalDir);
		expect(result.status).toBe("rollback");
		expect(fs.existsSync(claim.claimPath)).toBe(false);
	});

	it("resume: staging exists, claim exists, no final", () => {
		const claim = acquireWorkspaceClaim(tmpDir, "recover test", "t1");
		const staged = prepareStaging(claim);
		// Leave both claim and staging in place
		const result = reconcileTransition(tmpDir, "t1", claim.finalDir);
		expect(result.status).toBe("resume");
		expect(result.stagingPath).toBe(staged.stagingPath);
		expect(result.claimPath).toBe(claim.claimPath);
	});

	it("clean: final exists, claim cleaned up", () => {
		const claim = acquireWorkspaceClaim(tmpDir, "recover test", "t1");
		const staged = prepareStaging(claim);
		// Simulate successful completion
		const finalPath = path.join(tmpDir, claim.finalDir);
		fs.mkdirSync(finalPath, { recursive: false });
		fs.mkdirSync(path.join(finalPath, ".research"), { recursive: false });
		// Staging remains (should be cleaned)
		const result = reconcileTransition(tmpDir, "t1", claim.finalDir);
		expect(result.status).toBe("clean");
		expect(fs.existsSync(claim.claimPath)).toBe(false); // cleaned
		expect(fs.existsSync(staged.stagingPath)).toBe(false); // cleaned
		expect(fs.existsSync(finalPath)).toBe(true); // final intact
	});

	it("clean: no claim, no staging, no final", () => {
		const result = reconcileTransition(tmpDir, "t1", "nonexistent");
		expect(result.status).toBe("clean");
	});

	it("rollback: orphaned staging, no claim", () => {
		const stagingPath = path.join(tmpDir, ".staging-orphan");
		fs.mkdirSync(stagingPath, { recursive: false });
		const result = reconcileTransition(tmpDir, "t1", "orphan");
		expect(result.status).toBe("rollback");
		expect(fs.existsSync(stagingPath)).toBe(false); // cleaned
	});
});

// ===========================================================================
// CommitStaging rollback — staging cleanup
// ===========================================================================

describe("commitStaging rollback", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("staging directory is removed on collision", () => {
		const claim = acquireWorkspaceClaim(tmpDir, "rollback test", "t1");
		const staged = prepareStaging(claim);

		// Pre-create target → will trigger collision
		const finalPath = path.join(tmpDir, claim.finalDir);
		fs.mkdirSync(finalPath, { recursive: false });

		expect(() => commitStaging(staged, claim)).toThrow(
			"Workspace target appeared before commit",
		);
		// Staging should be cleaned up after collision
		expect(fs.existsSync(staged.stagingPath)).toBe(false);
	});

	it("claim is quarantined on collision", () => {
		const claim = acquireWorkspaceClaim(tmpDir, "quarantine test", "t1");
		const staged = prepareStaging(claim);

		const finalPath = path.join(tmpDir, claim.finalDir);
		fs.mkdirSync(finalPath, { recursive: false });

		expect(() => commitStaging(staged, claim)).toThrow();

		// Check that claim was quarantined (not fully deleted)
		const quarantinePath = claim.claimPath.replace(
			".claim-",
			".quarantine-",
		);
		expect(fs.existsSync(quarantinePath)).toBe(true);
	});
});

// ===========================================================================
// Integration: full staging → commit → manifest flow
// ===========================================================================

describe("full staging → commit → manifest flow", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("end-to-end: claim → staging → manifest → commit", () => {
		const claim = acquireWorkspaceClaim(tmpDir, "e2e test", "t1");
		const staged = prepareStaging(claim);

		// Write state and manifest in staging
		const researchDir = path.join(staged.stagingPath, ".research");
		fs.mkdirSync(researchDir, { recursive: false });

		const state = {
			revision: 1,
			status: "active" as const,
			createdAt: Date.now(),
			updatedAt: Date.now(),
			mission: "e2e test",
			runId: "t1-e2e-test",
			coordinatorUsage: 0,
			nestedUsage: 0,
			tokensUsed: 0,
		};
		fs.writeFileSync(
			path.join(researchDir, "run-state.json"),
			JSON.stringify(state, null, 2),
			"utf-8",
		);

		// Commit staging
		const ws = commitStaging(staged, claim);
		expect(ws.mission).toBe("e2e test");
		expect(fs.existsSync(ws.path)).toBe(true);
		expect(fs.existsSync(path.join(ws.path, ".research"))).toBe(true);
	});
});
