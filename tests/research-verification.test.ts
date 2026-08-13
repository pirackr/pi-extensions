/**
 * Research Verification Registry — TDD test suite.
 *
 * Step 1 (this file): schema validation, pass predicates, per-kind
 *   definitions, invalidation matrix (report edit / evidence edit / no-change).
 * Step 2: implement extensions/research/verification.ts.
 * Step 3: run tests — expect PASS.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import type { Workspace } from "../extensions/research/workspace.ts";
import { newRunState } from "../extensions/research/state.ts";
import { createRunManifest } from "../extensions/research/manifest.ts";

// Import from the verification module under test
import {
	type VerificationDefinition,
	type VerificationResult,
	type VerificationArtifact,
	type InvalidationKind,
	verificationDefinitions,
	getVerificationDefinition,
	runVerification,
	computeRunDigests,
	evaluateInvalidations,
} from "../extensions/research/verification.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "research-verification-test-"));
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
	fs.mkdirSync(path.join(wsPath, "verification"), { recursive: true });

	const init = newRunState({
		path: wsPath,
		projectRoot: tmpDir,
		mission,
		runId: `${transitionId}-${mission.replace(/\s+/g, "-")}`,
		transitionId,
	});
	const statePath = path.join(wsPath, ".research", "run-state.json");
	fs.writeFileSync(statePath, JSON.stringify(init, null, 2), "utf-8");

	return {
		path: wsPath,
		projectRoot: tmpDir,
		mission,
		runId: init.runId,
		transitionId,
	};
}

function sha256(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

// ===========================================================================
// Step 1: Per-kind verification definitions
// ===========================================================================

describe("Verification Registry — per-kind definitions", () => {
	it("defines judge verification", () => {
		const def = getVerificationDefinition("judge");
		expect(def).toBeDefined();
		expect(def?.name).toBe("judge");
		expect(def?.description).toBeTruthy();
		expect(def?.description.length).toBeGreaterThan(0);
		expect(def?.outputPath).toContain("judge");
		expect(def?.schemaVersion).toBeTruthy();
		expect(def?.validatorId).toBeTruthy();
		expect(typeof def?.passPredicate).toBe("function");
		expect(def?.profiles).toContain("standard");
		expect(def?.profiles).toContain("deep");
		expect(def?.profiles).toContain("quick");
	});

	it("defines citation_agent verification", () => {
		const def = getVerificationDefinition("citation_agent");
		expect(def).toBeDefined();
		expect(def?.name).toBe("citation_agent");
		expect(def?.outputPath).toContain("citation");
		expect(def?.profiles).toContain("intermediate");
		expect(def?.profiles).toContain("deep");
		expect(def?.profiles).not.toContain("quick");
		expect(def?.profiles).not.toContain("standard");
	});

	it("defines source_auditor verification", () => {
		const def = getVerificationDefinition("source_auditor");
		expect(def).toBeDefined();
		expect(def?.name).toBe("source_auditor");
		expect(def?.outputPath).toContain("source");
		expect(def?.profiles).toContain("intermediate");
		expect(def?.profiles).toContain("deep");
		expect(def?.profiles).not.toContain("quick");
		expect(def?.profiles).not.toContain("standard");
	});

	it("defines contradiction_resolver verification", () => {
		const def = getVerificationDefinition("contradiction_resolver");
		expect(def).toBeDefined();
		expect(def?.name).toBe("contradiction_resolver");
		expect(def?.outputPath).toContain("contradiction");
		expect(def?.profiles).toContain("deep");
		expect(def?.profiles).not.toContain("quick");
		expect(def?.profiles).not.toContain("standard");
		expect(def?.profiles).not.toContain("intermediate");
	});

	it("returns undefined for unknown verification kind", () => {
		expect(getVerificationDefinition("nonexistent")).toBeUndefined();
	});

	it("all definitions have unique validator IDs", () => {
		const ids = verificationDefinitions.map((d) => d.validatorId);
		const unique = new Set(ids);
		expect(unique.size).toBe(ids.length);
	});

	it("all definitions have unique schema versions", () => {
		const versions = verificationDefinitions.map((d) => d.schemaVersion);
		const unique = new Set(versions);
		expect(unique.size).toBe(versions.length);
	});

	it("all required fields are non-empty for every definition", () => {
		for (const def of verificationDefinitions) {
			expect(def.name).toBeTruthy();
			expect(def.description).toBeTruthy();
			expect(def.outputPath).toBeTruthy();
			expect(def.schemaVersion).toBeTruthy();
			expect(def.validatorId).toBeTruthy();
			expect(Array.isArray(def.profiles) && def.profiles.length > 0).toBe(true);
		}
	});
});

// ===========================================================================
// Step 1: Schema validation — VerificationDefinition shape
// ===========================================================================

describe("Verification Registry — definition schema validation", () => {
	it("each definition satisfies the schema contract", () => {
		const requiredKeys = ["name", "description", "outputPath", "schemaVersion", "validatorId", "passPredicate", "profiles"];
		for (const def of verificationDefinitions) {
			for (const key of requiredKeys) {
				expect(key in def).toBe(true);
			}
			expect(typeof def.name).toBe("string");
			expect(typeof def.description).toBe("string");
			expect(typeof def.outputPath).toBe("string");
			expect(typeof def.schemaVersion).toBe("string");
			expect(typeof def.validatorId).toBe("string");
			expect(typeof def.passPredicate).toBe("function");
			expect(Array.isArray(def.profiles)).toBe(true);
		}
	});

	it("profile lists are a subset of registered profiles", () => {
		const knownProfiles = ["quick", "standard", "intermediate", "deep", "open-ended"];
		for (const def of verificationDefinitions) {
			for (const profile of def.profiles) {
				expect(knownProfiles).toContain(profile);
			}
		}
	});
});

// ===========================================================================
// Step 1: Pass predicates
// ===========================================================================

describe("Verification Registry — pass predicates", () => {
	it("judge pass predicate passes when score meets threshold (80)", () => {
		const def = getVerificationDefinition("judge");
		expect(def).toBeDefined();
		// Score at threshold
		expect(def!.passPredicate({ score: 80, findings: [] })).toBe(true);
		// Score above threshold
		expect(def!.passPredicate({ score: 90, findings: [] })).toBe(true);
		// Score below threshold
		expect(def!.passPredicate({ score: 79, findings: [] })).toBe(false);
	});

	it("judge pass predicate fails on low scores", () => {
		const def = getVerificationDefinition("judge");
		expect(def!.passPredicate({ score: 50, findings: ["poor quality"] })).toBe(false);
	});

	it("judge pass predicate fails on missing score", () => {
		const def = getVerificationDefinition("judge");
		expect(def!.passPredicate({ findings: [] })).toBe(false);
	});

	it("citation_agent pass predicate passes when no unverified claims", () => {
		const def = getVerificationDefinition("citation_agent");
		expect(def!.passPredicate({ claimMap: [], unverifiedClaims: [] })).toBe(true);
		expect(def!.passPredicate({ claimMap: [{ claim: "a", url: "b" }] })).toBe(true);
	});

	it("citation_agent pass predicate fails on unverified claims", () => {
		const def = getVerificationDefinition("citation_agent");
		expect(
			def!.passPredicate({ unverifiedClaims: ["unsourced claim 1"] }),
		).toBe(false);
	});

	it("source_auditor pass predicate passes when no low-quality sources", () => {
		const def = getVerificationDefinition("source_auditor");
		expect(def!.passPredicate({ lowQualityCount: 0, averageCredibility: 85 })).toBe(true);
	});

	it("source_auditor pass predicate fails on low-quality sources", () => {
		const def = getVerificationDefinition("source_auditor");
		expect(
			def!.passPredicate({ lowQualityCount: 2, lowQualityUrls: ["http://spam.com"] }),
		).toBe(false);
	});

	it("source_auditor pass predicate fails on low credibility", () => {
		const def = getVerificationDefinition("source_auditor");
		expect(
			def!.passPredicate({ lowQualityCount: 0, averageCredibility: 30 }),
		).toBe(false);
	});

	it("contradiction_resolver pass predicate passes when no unresolved contradictions", () => {
		const def = getVerificationDefinition("contradiction_resolver");
		expect(def!.passPredicate({ unresolvedContradictions: [] })).toBe(true);
	});

	it("contradiction_resolver pass predicate fails on unresolved contradictions", () => {
		const def = getVerificationDefinition("contradiction_resolver");
		expect(
			def!.passPredicate({ unresolvedContradictions: [{ left: "a", right: "b" }] }),
		).toBe(false);
	});

	it("contradiction_resolver pass predicate handles missing field", () => {
		const def = getVerificationDefinition("contradiction_resolver");
		expect(def!.passPredicate({})).toBe(false);
	});
});

// ===========================================================================
// Step 1: runVerification — executes the matrix and returns per-kind results
// ===========================================================================

describe("Verification Registry — runVerification", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("standard profile runs only judge verification", () => {
		const ws = makeFakeWorkspace(tmpDir, "standard verify", "t1");
		const results = runVerification(ws, "standard");
		const kinds = results.map((r) => r.kind);
		expect(kinds).toContain("judge");
		expect(kinds).not.toContain("citation_agent");
		expect(kinds).not.toContain("source_auditor");
		expect(kinds).not.toContain("contradiction_resolver");
	});

	it("intermediate profile runs judge + citation_agent + source_auditor", () => {
		const ws = makeFakeWorkspace(tmpDir, "intermediate verify", "t1");
		const results = runVerification(ws, "intermediate");
		const kinds = results.map((r) => r.kind);
		expect(kinds).toContain("judge");
		expect(kinds).toContain("citation_agent");
		expect(kinds).toContain("source_auditor");
		expect(kinds).not.toContain("contradiction_resolver");
	});

	it("deep profile runs all four verifications", () => {
		const ws = makeFakeWorkspace(tmpDir, "deep verify", "t1");
		const results = runVerification(ws, "deep");
		const kinds = results.map((r) => r.kind);
		expect(kinds).toContain("judge");
		expect(kinds).toContain("citation_agent");
		expect(kinds).toContain("source_auditor");
		expect(kinds).toContain("contradiction_resolver");
	});

	it("quick profile runs only judge verification", () => {
		const ws = makeFakeWorkspace(tmpDir, "quick verify", "t1");
		const results = runVerification(ws, "quick");
		const kinds = results.map((r) => r.kind);
		expect(kinds).toHaveLength(1);
		expect(kinds).toContain("judge");
	});

	it("each result has a kind and pass boolean", () => {
		const ws = makeFakeWorkspace(tmpDir, "result shape", "t1");
		const results = runVerification(ws, "standard");
		for (const result of results) {
			expect(typeof result.kind).toBe("string");
			expect(typeof result.pass).toBe("boolean");
		}
	});

	it("runVerification computes digests for each result", () => {
		const ws = makeFakeWorkspace(tmpDir, "digests", "t1");
		const results = runVerification(ws, "standard");
		for (const result of results) {
			expect(typeof result.digest).toBe("string");
			expect(result.digest.length).toBeGreaterThan(0);
		}
	});

	it("runVerification binds artifacts to verification results", () => {
		const ws = makeFakeWorkspace(tmpDir, "artifact bindings", "t1");
		const results = runVerification(ws, "deep");
		for (const result of results) {
			expect(Array.isArray(result.artifacts)).toBe(true);
			for (const artifact of result.artifacts) {
				expect(typeof artifact.name).toBe("string");
				expect(typeof artifact.kind).toBe("string");
				expect(typeof artifact.digest).toBe("string");
				expect(typeof artifact.invalidated).toBe("boolean");
			}
		}
	});

	it("judge result artifact is bound to report", () => {
		const ws = makeFakeWorkspace(tmpDir, "judge binds report", "t1");
		const results = runVerification(ws, "standard");
		const judgeResult = results.find((r) => r.kind === "judge");
		expect(judgeResult).toBeDefined();
		const reportArtifact = judgeResult!.artifacts.find((a) => a.boundTo === "report");
		expect(reportArtifact).toBeDefined();
	});
});

// ===========================================================================
// Step 1: Digest binding — computeRunDigests
// ===========================================================================

describe("Verification Registry — digest binding (computeRunDigests)", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("computes manifest digest from run.json content", () => {
		const wsPath = path.join(tmpDir, "digest manifest");
		fs.mkdirSync(wsPath, { recursive: false });
		fs.mkdirSync(path.join(wsPath, ".research"), { recursive: false });

		const runManifest = {
			runId: "test-run",
			mission: "test mission",
			workspace: wsPath,
			createdAt: Date.now(),
		};
		const manifestPath = path.join(wsPath, ".research", "run.json");
		fs.writeFileSync(manifestPath, JSON.stringify(runManifest), "utf-8");

		const ws: Workspace = {
			path: wsPath,
			projectRoot: tmpDir,
			mission: "test mission",
			runId: "test-run",
			transitionId: "t1",
		};

		const digests = computeRunDigests(ws);
		expect(digests.manifest).toBe(sha256(JSON.stringify(runManifest)));
	});

	it("evidence digest comes from checkpointDigest in state", () => {
		const ws = makeFakeWorkspace(tmpDir, "digest evidence", "t1");
		const statePath = path.join(ws.path, ".research", "run-state.json");
		const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as ReturnType<typeof newRunState>;
		const evidenceDigest = sha256("test evidence");
		state.checkpointDigest = evidenceDigest;
		fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

		const digests = computeRunDigests(ws);
		expect(digests.evidence).toBe(evidenceDigest);
	});

	it("evidence digest is empty when no checkpoint evidence", () => {
		const ws = makeFakeWorkspace(tmpDir, "no evidence", "t1");
		const digests = computeRunDigests(ws);
		expect(digests.evidence).toBe("");
	});

	it("report digest comes from report.org content when present", () => {
		const ws = makeFakeWorkspace(tmpDir, "digest report", "t1");
		const reportContent = "# Research Report\n\nTest report content.";
		const reportPath = path.join(ws.path, "report.org");
		fs.writeFileSync(reportPath, reportContent, "utf-8");

		const digests = computeRunDigests(ws);
		expect(digests.report).toBe(sha256(reportContent));
	});

	it("report digest is null when report.org does not exist", () => {
		const ws = makeFakeWorkspace(tmpDir, "no report", "t1");
		const digests = computeRunDigests(ws);
		expect(digests.report).toBeNull();
	});

	it("all three digests are present in a complete workspace", () => {
		const ws = makeFakeWorkspace(tmpDir, "full digests", "t1");
		// Create manifest so computeRunDigests can find it
		createRunManifest({
			path: ws.path,
			projectRoot: tmpDir,
			mission: ws.mission,
			runId: ws.runId,
			transitionId: ws.transitionId,
		});
		// Write evidence digest
		const statePath = path.join(ws.path, ".research", "run-state.json");
		const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as ReturnType<typeof newRunState>;
		state.checkpointDigest = sha256("evidence bytes");
		fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");
		// Write report
		fs.writeFileSync(path.join(ws.path, "report.org"), "# Report", "utf-8");

		const digests = computeRunDigests(ws);
		expect(digests.manifest).toBeTruthy();
		expect(digests.evidence).toBe(sha256("evidence bytes"));
		expect(digests.report).toBe(sha256("# Report"));
	});

	it("digests contain runId in result metadata", () => {
		const ws = makeFakeWorkspace(tmpDir, "runId in digests", "t1");
		const results = runVerification(ws, "standard");
		for (const result of results) {
			// The result object should have a runId property
			expect((result as unknown as Record<string, unknown>).runId).toBe(ws.runId);
		}
	});
});

// ===========================================================================
// Step 1: Invalidation matrix
// ===========================================================================

describe("Verification Registry — invalidation matrix", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	function setupDeepWorkspace(): Workspace {
		const ws = makeFakeWorkspace(tmpDir, "invalidation test", "t1");
		// Pre-populate verification artifacts for all kinds under verification/
		const results = runVerification(ws, "deep");
		for (const result of results) {
			const dir = path.join(ws.path, "verification");
			fs.mkdirSync(dir, { recursive: true });
			const artifactPath = path.join(dir, result.artifacts[0].name);
			fs.writeFileSync(artifactPath, JSON.stringify({ kind: result.kind, pass: result.pass }), "utf-8");
		}
		return ws;
	}

	it("report edit invalidates report-bound artifacts only", () => {
		const ws = setupDeepWorkspace();
		// Edit report.org
		fs.writeFileSync(path.join(ws.path, "report.org"), "# Edited Report", "utf-8");

		const invalidations = evaluateInvalidations(ws, "report");

		// judge is bound to report — should be invalidated
		const judgeInvalidated = invalidations.find((a) => a.kind === "judge");
		expect(judgeInvalidated).toBeDefined();
		expect(judgeInvalidated!.invalidated).toBe(true);

		// citation/source/contradiction are NOT bound to report — should remain valid
		const citationInvalidated = invalidations.find((a) => a.kind === "citation_agent");
		expect(citationInvalidated?.invalidated).toBe(false);
	});

	it("evidence edit invalidates checkpoint AND verification artifacts", () => {
		const ws = setupDeepWorkspace();
		// Edit checkpoint evidence
		const statePath = path.join(ws.path, ".research", "run-state.json");
		const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as ReturnType<typeof newRunState>;
		state.checkpointDigest = sha256("new evidence");
		fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

		const invalidations = evaluateInvalidations(ws, "evidence");

		// Evidence-bound (citation, source) and checkpoint-bound (contradiction) artifacts are invalidated
		// Report-bound (judge) artifacts are NOT invalidated by evidence edit
		const judge = invalidations.find((a) => a.kind === "judge");
		expect(judge).toBeDefined();
		expect(judge!.invalidated).toBe(false);

		const citation = invalidations.find((a) => a.kind === "citation_agent");
		expect(citation!.invalidated).toBe(true);

		const source = invalidations.find((a) => a.kind === "source_auditor");
		expect(source!.invalidated).toBe(true);

		const contradiction = invalidations.find((a) => a.kind === "contradiction_resolver");
		expect(contradiction!.invalidated).toBe(true);
	});

	it("no-change: report edit only affects report-bound artifacts", () => {
		const ws = setupDeepWorkspace();
		// No edit made — evaluate report invalidation
		const invalidations = evaluateInvalidations(ws, "report");

		// Report-bound artifact (judge) is affected by report invalidation
		const judge = invalidations.find((a) => a.kind === "judge");
		expect(judge).toBeDefined();
		expect(judge!.invalidated).toBe(true);

		// Evidence-bound and checkpoint-bound artifacts are NOT affected
		const citation = invalidations.find((a) => a.kind === "citation_agent");
		expect(citation!.invalidated).toBe(false);

		const contradiction = invalidations.find((a) => a.kind === "contradiction_resolver");
		expect(contradiction!.invalidated).toBe(false);
	});

	it("checkpoint invalidation marks checkpoint-bound artifacts", () => {
		const ws = makeFakeWorkspace(tmpDir, "checkpoint invalidation", "t1");
		// Write a contradiction artifact (which is checkpoint-bound) under verification/
		const contradictionArtifactPath = path.join(ws.path, "verification", "contradiction.json");
		fs.mkdirSync(path.join(ws.path, "verification"), { recursive: true });
		fs.writeFileSync(contradictionArtifactPath, JSON.stringify({ contradiction: true }), "utf-8");

		const invalidations = evaluateInvalidations(ws, "checkpoint");
		// The contradiction artifact exists and is now invalidated
		const found = invalidations.find((a) => a.name === "verification/contradiction.json");
		expect(found).toBeDefined();
		expect(found?.boundTo).toBe("checkpoint");
		expect(found?.invalidated).toBe(true);
	});

	it("invalidation respects artifact kind — report only touches report-bound", () => {
		const ws = setupDeepWorkspace();
		const reportInvalidations = evaluateInvalidations(ws, "report");

		// Verify that non-report-bound artifacts are not touched
		for (const artifact of reportInvalidations) {
			if (artifact.boundTo !== "report") {
				// Non-report artifacts should exist but not be invalidated
				expect(artifact.invalidated).toBe(false);
			}
		}
	});

	it("invalidation matrix: evidence > report scope", () => {
		const ws = setupDeepWorkspace();
		// Edit evidence
		const statePath = path.join(ws.path, ".research", "run-state.json");
		const state = JSON.parse(fs.readFileSync(statePath, "utf-8")) as ReturnType<typeof newRunState>;
		state.checkpointDigest = sha256("tampered evidence");
		fs.writeFileSync(statePath, JSON.stringify(state, null, 2), "utf-8");

		const evidenceInvalidations = evaluateInvalidations(ws, "evidence");
		const reportInvalidations = evaluateInvalidations(ws, "report");

		// Evidence invalidation should cover more artifacts than report
		expect(evidenceInvalidations.filter((a) => a.invalidated).length).toBeGreaterThanOrEqual(
			reportInvalidations.filter((a) => a.invalidated).length,
		);
	});
});

// ===========================================================================
// Integration: runVerification with all profiles
// ===========================================================================

describe("Verification Registry — profile coverage", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("every profile definition has a corresponding runVerification result set", () => {
		const profiles = ["quick", "standard", "intermediate", "deep", "open-ended"];
		for (const profile of profiles) {
			const ws = makeFakeWorkspace(tmpDir, `profile-${profile}`, "t1");
			const results = runVerification(ws, profile);
			expect(results.length).toBeGreaterThan(0);
			// Each result kind should correspond to a definition
			for (const result of results) {
				expect(getVerificationDefinition(result.kind)).toBeDefined();
			}
		}
	});

	it("result kinds match profile verification lists", () => {
		const ws = makeFakeWorkspace(tmpDir, "profile matrix", "t1");
		// Deep profile should have all verifications
		const deepResults = runVerification(ws, "deep");
		expect(deepResults.map((r) => r.kind)).toEqual(
			["judge", "citation_agent", "source_auditor", "contradiction_resolver"],
		);
	});
});
