/**
 * Research Completion Gates — TDD test suite (Task 11).
 *
 * Step 1 (this file): generic policy success/failure, each completion gate
 *   rejected independently, all-gates-pass success, stale-revision re-audit,
 *   completion-versus-usage contention, one-write atomic finalize, and
 *   run.json untouched.
 * Step 2: implement extensions/research/completion.ts (researchCompletionGate
 *   + finalizeSuccess), extend RunState with final-outcome fields, and export
 *   computeEvidenceDigest from checkpoint.ts.
 * Step 3: run tests — expect PASS.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import type { Workspace } from "../extensions/research/workspace.ts";
import type { RunState, StateConflict } from "../extensions/research/state.ts";
import {
	newRunState,
	readRunState,
	updateRunState,
} from "../extensions/research/state.ts";
import { createRunManifest } from "../extensions/research/manifest.ts";
import { computeEvidenceDigest } from "../extensions/research/checkpoint.ts";
import {
	researchCompletionGate,
	finalizeSuccess,
} from "../extensions/research/completion.ts";
import {
	makeGenericPolicy,
	type CompletionPolicy,
	type CompletionFailure,
} from "../extensions/loop/completion.ts";
import type { LoopState } from "../extensions/loop/state.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "research-completion-test-"));
}

function cleanup(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

/** Build a workspace mirroring commitStaging's runId convention. */
function makeWorkspace(
	tmpDir: string,
	mission: string,
	transitionId: string,
): Workspace {
	const slug =
		mission
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 30) || "research";
	const wsPath = path.join(tmpDir, slug);
	fs.mkdirSync(wsPath, { recursive: false });
	fs.mkdirSync(path.join(wsPath, ".research"), { recursive: false });
	fs.mkdirSync(path.join(wsPath, "verification"), { recursive: true });
	return {
		path: wsPath,
		projectRoot: tmpDir,
		mission,
		runId: `${transitionId}-${slug}`,
		transitionId,
	};
}

const SCORE_MD =
	"| ID | Question | Score | Notes |\n" +
	"| --- | --- | ---: | --- |\n" +
	"| q1 | question | 90 | note |\n" +
	"| q2 | question | 90 | note |\n" +
	"| q3 | question | 90 | note |\n" +
	"| q4 | question | 90 | note |\n" +
	"| q5 | question | 90 | note |\n";

const NOTES_MD =
	"- Claim → https://example.com/one\n" +
	"- Claim → https://example.com/two\n";

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

interface ValidWorkspace {
	ws: Workspace;
	evidenceDigest: string;
	revision: number;
}

/**
 * Build a fully passable research workspace: manifest with snapshot binding,
 * checkpointed evidence (PROCEED + digest), non-empty report.org, and a
 * passing judge.json bound to the workspace runId.
 */
async function buildValidWorkspace(
	tmpDir: string,
	opts?: { profile?: string },
): Promise<ValidWorkspace> {
	const profile = opts?.profile ?? "quick";
	const ws = makeWorkspace(tmpDir, "completion gate test", "tr-1");
	createRunManifest(
		ws,
		JSON.stringify({ mission: ws.mission, profile, createdAt: Date.now() }),
	);
	const init = newRunState(ws);
	fs.writeFileSync(
		path.join(ws.path, ".research", "run-state.json"),
		JSON.stringify(init, null, 2),
		"utf-8",
	);
	fs.writeFileSync(path.join(ws.path, "score.md"), SCORE_MD, "utf-8");
	fs.writeFileSync(path.join(ws.path, "notes.md"), NOTES_MD, "utf-8");
	const evidenceDigest = computeEvidenceDigest(SCORE_MD, NOTES_MD);
	const updated = await updateRunState(ws, 1, (c) => ({
		...c,
		checkpointVerdict: "PROCEED" as const,
		checkpointDigest: evidenceDigest,
		checkpointUnmet: [],
		checkpointUniqueSources: 2,
		researchRound: 3,
		loopIteration: 1,
		checkpointProfile: profile,
	}));
	fs.writeFileSync(
		path.join(ws.path, "report.org"),
		"* Report\n\nSome findings.\n",
		"utf-8",
	);
	writeJudge(ws.path, ws.runId);
	return { ws, evidenceDigest, revision: updated.revision };
}

function writeJudge(
	dir: string,
	runId: string,
	opts?: { pass?: boolean; verdict?: string },
): void {
	const artifact = {
		version: 1,
		runId,
		pass: opts?.pass ?? true,
		verdict: opts?.verdict ?? "PASS",
		failedChecks: [],
		fixes: [],
	};
	fs.mkdirSync(path.join(dir, "verification"), { recursive: true });
	fs.writeFileSync(
		path.join(dir, "verification", "judge.json"),
		JSON.stringify(artifact),
	);
}

function codes(failures: CompletionFailure[]): string[] {
	return failures.map((f) => f.code);
}

function messages(failures: CompletionFailure[]): string {
	return failures.map((f) => `${f.code}: ${f.message}`).join("\n");
}

function fakeLoopState(): Readonly<LoopState> {
	return {
		id: "loop-1",
		commandName: "loop",
		programPath: "/fake.md",
		mission: "test",
		rounds: 1,
		maxRounds: 5,
		tokensUsed: 0,
		tokenBudget: null,
		status: "active",
		guardId: "g",
		noProgressTurns: 3,
		noProgressCount: 0,
		lastFingerprint: null,
		updatedAt: Date.now(),
		coordinatorUsage: 0,
		nestedUsage: 0,
		processedToolCallIds: [],
	} as Readonly<LoopState>;
}

// ===========================================================================
// Generic completion policy (unchanged by Task 11)
// ===========================================================================

describe("generic completion policy", () => {
	it("succeeds — makeGenericPolicy always returns empty failures", async () => {
		const policy = makeGenericPolicy();
		expect(await policy.audit(fakeLoopState())).toEqual([]);
	});

	it("succeeds even with a research-shaped state (no gates for /loop)", async () => {
		const policy = makeGenericPolicy();
		const state = fakeLoopState();
		expect(await policy.audit(state)).toEqual([]);
	});

	it("fails with typed failures from a custom policy implementation", async () => {
		const custom: CompletionPolicy = {
			async audit(): Promise<CompletionFailure[]> {
				return [
					{ code: "program", message: "immutable program contract violated" },
				];
			},
		};
		const failures = await custom.audit(fakeLoopState());
		expect(failures).toHaveLength(1);
		expect(failures[0].code).toBe("program");
	});
});

// ===========================================================================
// researchCompletionGate — manifest / snapshot gate
// ===========================================================================

describe("researchCompletionGate — manifest/snapshot gate", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("rejects when run.json is missing", async () => {
		const { ws } = await buildValidWorkspace(tmpDir);
		fs.rmSync(path.join(ws.path, ".research", "run.json"));
		const failures = await researchCompletionGate(ws);
		expect(codes(failures)).toContain("manifest");
		expect(messages(failures)).toContain("run.json");
	});

	it("rejects when the manifest workspace path does not match", async () => {
		const { ws } = await buildValidWorkspace(tmpDir);
		const manifestPath = path.join(ws.path, ".research", "run.json");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
		manifest.workspace = "/elsewhere";
		fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
		const failures = await researchCompletionGate(ws);
		expect(codes(failures)).toContain("manifest");
		expect(messages(failures)).toContain("workspace mismatch");
	});

	it("rejects when the manifest has no snapshot binding", async () => {
		const { ws } = await buildValidWorkspace(tmpDir);
		const manifestPath = path.join(ws.path, ".research", "run.json");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
		manifest.snapshotSha256 = null;
		fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
		const failures = await researchCompletionGate(ws);
		expect(codes(failures)).toContain("manifest");
		expect(messages(failures)).toContain("no snapshot recorded");
	});
});

// ===========================================================================
// researchCompletionGate — checkpoint / verdict / evidence-digest gate
// ===========================================================================

describe("researchCompletionGate — checkpoint gate", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("rejects when no checkpoint evidence was recorded", async () => {
		const { ws, revision } = await buildValidWorkspace(tmpDir);
		await updateRunState(ws, revision, (c) => ({
			...c,
			checkpointDigest: "",
		}));
		const failures = await researchCompletionGate(ws);
		expect(codes(failures)).toContain("checkpoint");
		expect(messages(failures)).toContain("missing (no evidence recorded)");
	});

	it("rejects when the checkpoint verdict is CONTINUE", async () => {
		const { ws, revision } = await buildValidWorkspace(tmpDir);
		await updateRunState(ws, revision, (c) => ({
			...c,
			checkpointVerdict: "CONTINUE" as const,
		}));
		const failures = await researchCompletionGate(ws);
		expect(codes(failures)).toContain("checkpoint");
		expect(messages(failures)).toContain("verdict is 'CONTINUE'");
	});

	it("rejects when evidence changed after the checkpoint (stale digest)", async () => {
		const { ws } = await buildValidWorkspace(tmpDir);
		// Edit notes.md after the checkpoint was recorded — the recorded
		// evidence digest no longer matches the current bytes.
		fs.writeFileSync(
			path.join(ws.path, "notes.md"),
			NOTES_MD + "- Claim → https://example.com/three\n",
			"utf-8",
		);
		const failures = await researchCompletionGate(ws);
		expect(codes(failures)).toContain("checkpoint");
		expect(messages(failures)).toContain("stale");
	});

	it("rejects when manifest and state disagree on the run identity", async () => {
		const { ws } = await buildValidWorkspace(tmpDir);
		const manifestPath = path.join(ws.path, ".research", "run.json");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
		manifest.runId = "tr-other-different-run";
		fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
		const failures = await researchCompletionGate(ws);
		expect(codes(failures)).toContain("checkpoint");
		expect(messages(failures)).toContain("run identity mismatch");
	});

	it("rejects when the caller passes a workspace with a foreign runId", async () => {
		const { ws } = await buildValidWorkspace(tmpDir);
		const foreign = { ...ws, runId: "tr-other-run" };
		const failures = await researchCompletionGate(foreign);
		expect(codes(failures)).toContain("checkpoint");
		expect(messages(failures)).toContain("run identity mismatch");
	});
});

// ===========================================================================
// researchCompletionGate — report gate
// ===========================================================================

describe("researchCompletionGate — report gate", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("rejects when report.org is missing", async () => {
		const { ws } = await buildValidWorkspace(tmpDir);
		fs.rmSync(path.join(ws.path, "report.org"));
		const failures = await researchCompletionGate(ws);
		expect(codes(failures)).toContain("report");
		expect(messages(failures)).toContain("report.org missing");
	});

	it("rejects when report.org is empty", async () => {
		const { ws } = await buildValidWorkspace(tmpDir);
		fs.writeFileSync(path.join(ws.path, "report.org"), "   \n\t\n", "utf-8");
		const failures = await researchCompletionGate(ws);
		expect(codes(failures)).toContain("report");
		expect(messages(failures)).toContain("report.org is empty");
	});
});

// ===========================================================================
// researchCompletionGate — verification artifact gate
// ===========================================================================

describe("researchCompletionGate — verification gate", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("rejects when a required verification artifact is missing", async () => {
		const { ws } = await buildValidWorkspace(tmpDir);
		fs.rmSync(path.join(ws.path, "verification", "judge.json"));
		const failures = await researchCompletionGate(ws);
		expect(codes(failures)).toContain("verification");
		expect(messages(failures)).toContain("judge.json");
	});

	it("rejects when a required artifact fails its pass predicate", async () => {
		const { ws } = await buildValidWorkspace(tmpDir);
		writeJudge(ws.path, ws.runId, { pass: false, verdict: "FAIL" });
		const failures = await researchCompletionGate(ws);
		expect(codes(failures)).toContain("verification");
		expect(messages(failures)).toContain("judge.json failed");
	});

	it("rejects when a required artifact is bound to a different run", async () => {
		const { ws } = await buildValidWorkspace(tmpDir);
		writeJudge(ws.path, "tr-some-other-run");
		const failures = await researchCompletionGate(ws);
		expect(codes(failures)).toContain("verification");
		expect(messages(failures)).toContain("runId mismatch");
	});

	it("rejects an unknown checkpoint profile (cannot derive requirements)", async () => {
		const { ws, revision } = await buildValidWorkspace(tmpDir);
		await updateRunState(ws, revision, (c) => ({
			...c,
			checkpointProfile: "bogus-profile",
		}));
		const failures = await researchCompletionGate(ws);
		expect(codes(failures)).toContain("verification");
		expect(messages(failures)).toContain("unknown profile");
	});

	it("requires every kind for the deep profile", async () => {
		const { ws } = await buildValidWorkspace(tmpDir, { profile: "deep" });
		// judge passes; citations + sources + contradictions are missing.
		const failures = await researchCompletionGate(ws);
		const msgs = messages(failures);
		expect(msgs).toContain("citations.json");
		expect(msgs).toContain("sources.json");
		expect(msgs).toContain("contradictions.json");
		expect(codes(failures)).not.toContain("checkpoint");
	});
});

// ===========================================================================
// researchCompletionGate — all gates pass
// ===========================================================================

describe("researchCompletionGate — all gates pass", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("returns no failures for a fully passable workspace", async () => {
		const { ws } = await buildValidWorkspace(tmpDir);
		const failures = await researchCompletionGate(ws);
		expect(failures).toEqual([]);
	});

	it("does not mutate any state while auditing", async () => {
		const { ws } = await buildValidWorkspace(tmpDir);
		const statePath = path.join(ws.path, ".research", "run-state.json");
		const manifestPath = path.join(ws.path, ".research", "run.json");
		const stateBefore = fs.readFileSync(statePath, "utf-8");
		const manifestBefore = fs.readFileSync(manifestPath, "utf-8");
		await researchCompletionGate(ws);
		expect(fs.readFileSync(statePath, "utf-8")).toBe(stateBefore);
		expect(fs.readFileSync(manifestPath, "utf-8")).toBe(manifestBefore);
	});
});

// ===========================================================================
// finalizeSuccess
// ===========================================================================

describe("finalizeSuccess", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("records final outcome + digests in a single transactional write", async () => {
		const { ws, evidenceDigest, revision } = await buildValidWorkspace(tmpDir);
		const manifestContent = fs.readFileSync(
			path.join(ws.path, ".research", "run.json"),
			"utf-8",
		);
		const reportContent = fs.readFileSync(path.join(ws.path, "report.org"), "utf-8");

		// Gates must pass before finalizing.
		expect(await researchCompletionGate(ws)).toEqual([]);

		const finalized = await finalizeSuccess(ws, revision, "PROCEED");

		expect(finalized.status).toBe("complete");
		expect(finalized.revision).toBe(revision + 1);
		expect(finalized.finalOutcome).toBe("PROCEED");
		expect(finalized.finalDigests).toBeDefined();
		expect(finalized.finalDigests!.manifest).toBe(sha256(manifestContent));
		expect(finalized.finalDigests!.evidence).toBe(evidenceDigest);
		expect(finalized.finalDigests!.report).toBe(sha256(reportContent));
		expect(finalized.updatedAt).toBeGreaterThanOrEqual(
			finalized.createdAt,
		);

		// Persisted state matches (exactly one write: revision + 1).
		const onDisk = readRunState(ws);
		expect(onDisk.revision).toBe(revision + 1);
		expect(onDisk.status).toBe("complete");
		expect(onDisk.finalOutcome).toBe("PROCEED");
	});

	it("throws StateConflict on a stale revision without mutating state", async () => {
		const { ws, revision } = await buildValidWorkspace(tmpDir);

		// Concurrent writer bumps the revision before we finalize.
		await updateRunState(ws, revision, (c) => ({
			...c,
			tokensUsed: c.tokensUsed + 100,
		}));

		// A stale finalize attempt must NOT blind-retry or mark complete.
		let conflict: StateConflict | null = null;
		try {
			await finalizeSuccess(ws, revision, "PROCEED");
		} catch (err) {
			conflict = err as StateConflict;
		}
		expect(conflict).not.toBeNull();
		expect(conflict!.expected).toBe(revision);
		expect(conflict!.actual).toBe(revision + 1);

		const after = readRunState(ws);
		expect(after.status).not.toBe("complete");
		expect(after.revision).toBe(revision + 1);

		// Re-audit path: the gates still pass, then finalize with the fresh
		// revision succeeds.
		expect(await researchCompletionGate(ws)).toEqual([]);
		const finalized = await finalizeSuccess(ws, after.revision, "PROCEED");
		expect(finalized.status).toBe("complete");
	});

	it("completion-versus-usage contention: exactly one concurrent write wins", async () => {
		const { ws, revision } = await buildValidWorkspace(tmpDir);

		const [completion, usage] = await Promise.allSettled([
			finalizeSuccess(ws, revision, "PROCEED"),
			updateRunState(ws, revision, (c) => ({
				...c,
				tokensUsed: c.tokensUsed + 50,
			})),
		]);

		expect(completion.status).toBe("fulfilled");
		expect(usage.status).toBe("rejected");
		const reason = (usage as PromiseRejectedResult).reason as StateConflict;
		expect(reason.expected).toBe(revision);
		expect(reason.actual).toBe(revision + 1);

		// No lost update: the completion write won, the usage update did not
		// silently overwrite it.
		const final = readRunState(ws);
		expect(final.status).toBe("complete");
		expect(final.tokensUsed).toBe(0);
		expect(final.revision).toBe(revision + 1);
	});

	it("never touches run.json (manifest)", async () => {
		const { ws, revision } = await buildValidWorkspace(tmpDir);
		const manifestPath = path.join(ws.path, ".research", "run.json");
		const before = fs.readFileSync(manifestPath, "utf-8");

		await finalizeSuccess(ws, revision, "PROCEED");

		const after = fs.readFileSync(manifestPath, "utf-8");
		expect(after).toBe(before);
		// The manifest is still readable and unchanged in every field.
		const manifest = JSON.parse(after) as {
			runId: string;
			workspace: string;
			snapshotSha256: string | null;
		};
		expect(manifest.runId).toBe(ws.runId);
		expect(manifest.workspace).toBe(ws.path);
		expect(manifest.snapshotSha256).toBeTruthy();
	});
});
