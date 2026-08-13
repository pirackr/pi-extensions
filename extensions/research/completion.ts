/**
 * Research completion gates (Task 11).
 *
 * `researchCompletionGate(ws)` audits a retained research workspace purely
 * from disk — the immutable manifest (run.json), the mutable run-state
 * (run-state.json), the evidence files (score.md + notes.md), report.org,
 * and the verification artifacts — and returns typed `CompletionFailure`s.
 * It never reads the in-memory LoopState and never mutates anything.
 *
 * `finalizeSuccess(ws, expectedRevision, outcome)` records the final
 * outcome + digests through Task 3's single transactional state update
 * (updateRunState). A stale revision surfaces as `StateConflict` — the
 * caller re-audits instead of blind-retrying. `run.json` (the immutable
 * manifest) is never written here.
 *
 * Consumes: manifest.ts (intact manifest + snapshot binding), state.ts
 * (run identity + checkpoint verdict/digest), checkpoint.ts (current
 * evidence digest), verification.ts (profile → kinds → pass predicates),
 * and the generic CompletionFailure type from loop/completion.ts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Workspace } from "./workspace.ts";
import type { RunState } from "./state.ts";
import { readRunState, updateRunState } from "./state.ts";
import { readManifest, type RunManifest } from "./manifest.ts";
import {
	computeRunDigests,
	getProfileVerifications,
	getVerificationDefinition,
} from "./verification.ts";
import { computeEvidenceDigest } from "./checkpoint.ts";
import type { CompletionFailure } from "../loop/completion.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Read a workspace file, treating a missing file as empty content. */
function readOptional(ws: Workspace, fileName: string): string {
	try {
		return fs.readFileSync(path.join(ws.path, fileName), "utf8");
	} catch {
		return "";
	}
}

/**
 * Recompute the evidence digest from the current score.md + notes.md bytes.
 * Used to detect evidence edits made after the checkpoint was recorded.
 */
function evidenceDigestFromDisk(ws: Workspace): string {
	return computeEvidenceDigest(
		readOptional(ws, "score.md"),
		readOptional(ws, "notes.md"),
	);
}

// ---------------------------------------------------------------------------
// researchCompletionGate
// ---------------------------------------------------------------------------

/**
 * Audit every research completion gate from disk.
 *
 * Gate 1 — manifest/snapshot integrity: run.json exists and parses, belongs
 *   to this workspace path, carries the creation-time snapshot binding, and
 *   produces a manifest digest.
 * Gate 2 — current checkpoint/verdict/evidence digest: the recorded run
 *   identity matches the manifest, the verdict is PROCEED or
 *   PROCEED_WITH_GAPS, and the recorded evidence digest still matches a
 *   fresh digest of the current score.md + notes.md bytes.
 * Gate 3 — structurally valid non-empty report.org.
 * Gate 4 — required verification artifacts for the checkpoint profile,
 *   each validated with its pass predicate and bound to the run.
 *
 * Returns typed failures; an empty list means every gate passed. Does not
 * mutate any state.
 */
export async function researchCompletionGate(
	ws: Workspace,
): Promise<CompletionFailure[]> {
	const failures: CompletionFailure[] = [];
	const digests = computeRunDigests(ws);

	// --- Gate 1: intact manifest / snapshot binding -------------------------
	let manifest: RunManifest | null = null;
	try {
		manifest = readManifest(ws);
	} catch (err) {
		failures.push({
			code: "manifest",
			message: `run.json missing or malformed — ${errMessage(err)}`,
		});
	}
	if (manifest) {
		if (digests.manifest == null) {
			failures.push({
				code: "manifest",
				message: "manifest digest unavailable (run.json unreadable)",
			});
		}
		if (manifest.workspace !== ws.path) {
			failures.push({
				code: "manifest",
				message: `workspace mismatch: ${manifest.workspace} ≠ ${ws.path}`,
			});
		}
		if (manifest.snapshotSha256 == null) {
			failures.push({
				code: "manifest",
				message: "no snapshot recorded (snapshotSha256 is null)",
			});
		}
	}

	// --- Gate 2: current checkpoint verdict + evidence digest ---------------
	let state: RunState | null = null;
	try {
		state = readRunState(ws);
	} catch (err) {
		failures.push({
			code: "checkpoint",
			message: `run-state.json missing or malformed — ${errMessage(err)}`,
		});
	}
	if (state) {
		if (manifest && manifest.runId !== state.runId) {
			failures.push({
				code: "checkpoint",
				message: `run identity mismatch: manifest ${manifest.runId} ≠ state ${state.runId}`,
			});
		}
		if (state.runId !== ws.runId) {
			failures.push({
				code: "checkpoint",
				message: `run identity mismatch: state ${state.runId} ≠ workspace ${ws.runId}`,
			});
		}
		if (!state.checkpointDigest) {
			failures.push({
				code: "checkpoint",
				message: "missing (no evidence recorded)",
			});
		} else if (state.checkpointDigest !== digests.evidence) {
			failures.push({
				code: "checkpoint",
				message: "stale (recorded digest differs from current run-state)",
			});
		} else if (evidenceDigestFromDisk(ws) !== state.checkpointDigest) {
			// Evidence bytes changed after the checkpoint was recorded.
			failures.push({
				code: "checkpoint",
				message: "stale (evidence changed since checkpoint)",
			});
		}
		const verdict = state.checkpointVerdict;
		if (verdict !== "PROCEED" && verdict !== "PROCEED_WITH_GAPS") {
			failures.push({
				code: "checkpoint",
				message: `verdict is '${verdict}' (need PROCEED or PROCEED_WITH_GAPS)`,
			});
		}
	}

	// --- Gate 3: structurally valid non-empty report.org -------------------
	try {
		const content = fs.readFileSync(path.join(ws.path, "report.org"), "utf8");
		if (content.trim().length === 0) {
			failures.push({
				code: "report",
				message: "report.org is empty",
			});
		}
	} catch {
		failures.push({ code: "report", message: "report.org missing" });
	}

	// --- Gate 4: required verification artifacts ---------------------------
	const profile = state?.checkpointProfile ?? "standard";
	const requiredKinds = getProfileVerifications(profile);
	if (!requiredKinds) {
		failures.push({
			code: "verification",
			message: `unknown profile: ${profile}`,
		});
	} else {
		for (const kind of requiredKinds) {
			const def = getVerificationDefinition(kind);
			if (!def) {
				failures.push({
					code: "verification",
					message: `unknown verification kind '${kind}'`,
				});
				continue;
			}
			const fileName = path.basename(def.outputPath);
			const filePath = path.join(ws.path, def.outputPath);
			let artifact: unknown;
			try {
				const content = fs.readFileSync(filePath, "utf8");
				artifact = JSON.parse(content);
			} catch (err) {
				failures.push({
					code: "verification",
					message: `${fileName} missing or malformed — ${errMessage(err)}`,
				});
				continue;
			}
			const artifactRunId = (
				artifact as Record<string, unknown> | null
			)?.runId as string | undefined;
			const pass = def.passPredicate(artifact);
			if (state && artifactRunId && artifactRunId !== state.runId) {
				failures.push({
					code: "verification",
					message: `${fileName} runId mismatch (${artifactRunId} ≠ ${state.runId})`,
				});
			} else if (!pass) {
				failures.push({
					code: "verification",
					message: `${fileName} failed (pass predicate false)`,
				});
			}
		}
	}

	return failures;
}

// ---------------------------------------------------------------------------
// finalizeSuccess
// ---------------------------------------------------------------------------

/**
 * Record the final completion outcome and digests through a single
 * transactional `updateRunState(expectedRevision)` write.
 *
 * - Sets status to "complete".
 * - Records the caller-supplied outcome and the final run/manifest/evidence/
 *   report digests (freshly computed from disk).
 * - `updateRunState` bumps `updatedAt` and `revision` atomically.
 *
 * A stale `expectedRevision` rejects with `StateConflict` — the caller
 * re-audits the gates rather than blind-retrying the write. `run.json` is
 * never touched here; the manifest stays immutable.
 */
export async function finalizeSuccess(
	ws: Workspace,
	expectedRevision: number,
	outcome: string,
): Promise<RunState> {
	const digests = computeRunDigests(ws);
	return updateRunState(ws, expectedRevision, (current) => ({
		...current,
		status: "complete" as const,
		finalOutcome: outcome,
		finalDigests: {
			manifest: digests.manifest,
			evidence: digests.evidence,
			report: digests.report,
		},
	}));
}
