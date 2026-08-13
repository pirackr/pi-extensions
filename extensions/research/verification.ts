/**
 * Research Verification Registry.
 *
 * Provides one definition per verification kind — logical role, output
 * filename, schema version, validator ID, pass predicate, profiles requiring
 * it — plus `runVerification(ws)` executing the matrix and returning per-kind
 * results.
 *
 * Digest binding: verification agents receive current run ID, manifest
 * digest, evidence digest, and report digest via policy injection; editing
 * `report.org` invalidates report-bound artifacts; editing evidence
 * invalidates both checkpoint and verification artifacts.
 *
 * Consumers: config (Task 1) for profile/role contracts; policy (Task 6)
 * for digest injection.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { Workspace } from "./workspace.ts";
import type { RunState } from "./state.ts";
import { readRunState } from "./state.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Per-verification-kind definition.
 * Each kind maps one-to-one to a role in the program config.
 */
export interface VerificationDefinition {
  /** Logical role name (matches the role key in config). */
  name: string;
  /** Human-readable description of the logical role. */
  description: string;
  /** Output filename relative to workspace (where the verification agent writes). */
  outputPath: string;
  /** Schema version for the output artifact. */
  schemaVersion: string;
  /** Identifier for the validator that processes this kind's output. */
  validatorId: string;
  /** Pure function: evaluate verification result → pass/fail. */
  passPredicate: (result: unknown) => boolean;
  /** Profile names that require this verification kind. */
  profiles: string[];
}

/** Result for a single verification kind run. */
export interface VerificationResult {
  /** Verification kind name. */
  kind: string;
  /** Whether the pass predicate returned true. */
  pass: boolean;
  /** Raw verification output (if the agent produced one). */
  result: unknown;
  /** SHA-256 hex digest of the verification output. */
  digest: string;
  /** Artifacts bound to this verification. */
  artifacts: VerificationArtifact[];
  /** The run ID this verification belongs to. */
  runId: string;
}

/** An artifact bound to a verification kind. */
export interface VerificationArtifact {
  /** Relative path/name of the artifact. */
  name: string;
  /** Verification kind this artifact belongs to. */
  kind: string;
  /** What this artifact is bound to: "report", "evidence", or "checkpoint". */
  boundTo: string;
  /** SHA-256 hex digest. */
  digest: string;
  /** Whether this artifact is currently invalidated. */
  invalidated: boolean;
}

/**
 * The kind of edit that triggers invalidation.
 * - "report"  — editing report.org invalidates report-bound artifacts
 * - "evidence" — editing evidence invalidates checkpoint AND verification artifacts
 * - "checkpoint" — checkpoint-level edit
 */
export type InvalidationKind = "report" | "evidence" | "checkpoint";

/**
 * Return type for computeRunDigests — the digests that verification agents
 * receive via policy injection.
 */
export interface RunDigests {
  /** SHA-256 of the manifest (run.json) content, or null if not found. */
  manifest: string | null;
  /** SHA-256 of the checkpoint evidence (from state). */
  evidence: string;
  /** SHA-256 of report.org content, or null if not found. */
  report: string | null;
}

// ---------------------------------------------------------------------------
// Canonical artifact paths per verification kind
// ---------------------------------------------------------------------------

/**
 * Canonical artifact paths per verification kind.
 * Verification agents write strict JSON under verification/ per role boundaries.
 */
function verificationArtifactPath(ws: Workspace, verificationKind: string, suffix: string = ".json"): string {
  return path.join(ws.path, "verification", `${verificationKind}${suffix}`);
}

// ---------------------------------------------------------------------------
// Per-kind definitions (the registry)
// ---------------------------------------------------------------------------

function computeDigest(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Read file content or return null. */
function readOptionalFile(filePath: string): string | null {
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, "utf-8");
}

/** Read run-state file or throw. */
function readState(ws: Workspace): RunState {
  return readRunState(ws);
}

// ---------------------------------------------------------------------------
// Registry: one definition per verification kind
// ---------------------------------------------------------------------------

export const verificationDefinitions: VerificationDefinition[] = [
  {
    name: "judge",
    description: "Evaluate draft research report against credibility rubric — returns pass/fail with specific findings",
    outputPath: "verification/judge.json",
    schemaVersion: "1.0.0",
    validatorId: "judge-v1",
    passPredicate: (result: unknown): boolean => {
      if (!result || typeof result !== "object") return false;
      const obj = result as Record<string, unknown>;
      const score = obj.score;
      if (typeof score !== "number") return false;
      return score >= 80;
    },
    profiles: ["quick", "standard", "intermediate", "deep", "open-ended"],
  },
  {
    name: "citation_agent",
    description: "Map claims to exact source locations — returns claim→URL→snippet mapping",
    outputPath: "verification/citation.json",
    schemaVersion: "1.1.0",
    validatorId: "citation-v1",
    passPredicate: (result: unknown): boolean => {
      if (!result || typeof result !== "object") return false;
      const obj = result as Record<string, unknown>;
      const unverified = obj.unverifiedClaims;
      if (!Array.isArray(unverified)) return true; // no claims to verify = pass
      return unverified.length === 0;
    },
    profiles: ["intermediate", "deep"],
  },
  {
    name: "source_auditor",
    description: "Rate all sources used in research — flag low-quality sources, suggest replacements",
    outputPath: "verification/source.json",
    schemaVersion: "1.1.1",
    validatorId: "source-auditor-v1",
    passPredicate: (result: unknown): boolean => {
      if (!result || typeof result !== "object") return false;
      const obj = result as Record<string, unknown>;
      // Fail if any low-quality sources exist
      const lowQualityCount = obj.lowQualityCount;
      if (typeof lowQualityCount === "number" && lowQualityCount > 0) {
        return false;
      }
      // Fail if average credibility is too low
      const avgCred = obj.averageCredibility;
      if (typeof avgCred === "number" && avgCred < 50) {
        return false;
      }
      return true;
    },
    profiles: ["intermediate", "deep"],
  },
  {
    name: "contradiction_resolver",
    description: "Investigate and resolve contradictions between sources — returns resolution or flags as unresolved",
    outputPath: "verification/contradiction.json",
    schemaVersion: "1.2.0",
    validatorId: "contradiction-v1",
    passPredicate: (result: unknown): boolean => {
      if (!result || typeof result !== "object") return false;
      const obj = result as Record<string, unknown>;
      const unresolved = obj.unresolvedContradictions;
      if (!Array.isArray(unresolved)) return false;
      return unresolved.length === 0;
    },
    profiles: ["deep"],
  },
];

// ---------------------------------------------------------------------------
// Registry API
// ---------------------------------------------------------------------------

/**
 * Look up a verification definition by name.
 * Returns undefined for unknown kinds.
 */
export function getVerificationDefinition(name: string): VerificationDefinition | undefined {
  return verificationDefinitions.find((d) => d.name === name);
}

// ---------------------------------------------------------------------------
// Digest binding — compute run digests for policy injection
// ---------------------------------------------------------------------------

/**
 * Compute the three digests that verification agents receive:
 *  - manifest: SHA-256 of run.json content
 *  - evidence: from RunState.checkpointDigest
 *  - report: SHA-256 of report.org content (if present)
 */
export function computeRunDigests(ws: Workspace): RunDigests {
  // Manifest digest: read the raw run.json and hash it
  let manifestDigest: string | null = null;
  try {
    const manifestContent = fs.readFileSync(path.join(ws.path, ".research", "run.json"), "utf-8");
    manifestDigest = computeDigest(manifestContent);
  } catch {
    manifestDigest = null;
  }

  // Evidence digest: from checkpoint digest in state
  let evidenceDigest = "";
  try {
    const state = readState(ws);
    evidenceDigest = state.checkpointDigest ?? "";
  } catch {
    evidenceDigest = "";
  }

  // Report digest: SHA-256 of report.org content
  const reportPath = path.join(ws.path, "report.org");
  const reportContent = readOptionalFile(reportPath);
  const reportDigest = reportContent !== null ? computeDigest(reportContent) : null;

  return {
    manifest: manifestDigest,
    evidence: evidenceDigest,
    report: reportDigest,
  };
}

// ---------------------------------------------------------------------------
// Invalidation matrix
// ---------------------------------------------------------------------------

/**
 * Evaluate which artifacts are invalidated by an edit of a given kind.
 *
 * Rules:
 * - "report"  — invalidates artifacts bound to "report"
 * - "evidence" — invalidates artifacts bound to "evidence" AND "checkpoint"
 * - "checkpoint" — invalidates artifacts bound to "checkpoint"
 *
 * This function builds its artifact list from the verification definitions
 * (not from file scanning) so it returns a complete picture regardless of
 * whether verification agents have written their outputs yet.
 */
export function evaluateInvalidations(
  ws: Workspace,
  kind: InvalidationKind,
): VerificationArtifact[] {
  // Determine which bound categories are affected by this edit
  const affectedBounds: Set<string> = new Set();

  if (kind === "report") {
    affectedBounds.add("report");
  } else if (kind === "evidence") {
    // Evidence edit invalidates BOTH checkpoint and verification artifacts
    affectedBounds.add("evidence");
    affectedBounds.add("checkpoint");
  } else if (kind === "checkpoint") {
    affectedBounds.add("checkpoint");
  }

  // Build artifact list from definitions — each definition maps to one artifact
  const results: VerificationArtifact[] = [];

  // Mapping from verification kind name to file stem
  const kindToStem: Record<string, string> = {
    judge: "judge",
    citation_agent: "citation",
    source_auditor: "source",
    contradiction_resolver: "contradiction",
  };

  // Mapping from file stem to bound category
  const stemToBound: Record<string, string> = {
    judge: "report",
    citation: "evidence",
    source: "evidence",
    contradiction: "checkpoint",
  };

  for (const def of verificationDefinitions) {
    const stem = kindToStem[def.name];
    if (!stem) continue; // unknown kind, skip

    const boundTo = stemToBound[stem] ?? "evidence";
    const fileName = `${stem}.json`;
    const filePath = path.join(ws.path, "verification", fileName);

    // Read existing artifact content for digest
    let digest = "";
    try {
      const content = fs.readFileSync(filePath, "utf-8");
      digest = computeDigest(content);
    } catch {
      // No existing artifact — placeholder digest
      digest = computeDigest(JSON.stringify({ _kind: def.name, _placeholder: true }));
    }

    const isInvalidated = affectedBounds.has(boundTo);

    results.push({
      name: `verification/${fileName}`,
      kind: def.name,
      boundTo,
      digest,
      invalidated: isInvalidated,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// runVerification — executes the matrix and returns per-kind results
// ---------------------------------------------------------------------------

/**
 * Known profiles that require the open-ended profile's judge verification
 * (since open-ended also has verification: ["judge"]).
 */
const PROFILE_VERIFICATION = {
  quick: ["judge"],
  standard: ["judge"],
  intermediate: ["judge", "citation_agent", "source_auditor"],
  deep: ["judge", "citation_agent", "source_auditor", "contradiction_resolver"],
  "open-ended": ["judge"],
};

/**
 * Build verification artifacts for a given kind, including bound artifacts.
 */
function buildArtifacts(
  ws: Workspace,
  verificationKind: string,
): VerificationArtifact[] {
  // Determine bound category
  let boundTo: string;
  if (verificationKind === "judge") {
    boundTo = "report";
  } else if (verificationKind === "citation_agent" || verificationKind === "source_auditor") {
    boundTo = "evidence";
  } else if (verificationKind === "contradiction_resolver") {
    boundTo = "checkpoint";
  } else {
    boundTo = "evidence";
  }

  // Build artifact for this kind
  const artifactName = `${verificationKind}.json`;
  const artifactFull = verificationArtifactPath(ws, verificationKind);

  let digest = "";
  let result: unknown = {};

  // Try to read existing verification output
  try {
    const content = fs.readFileSync(artifactFull, "utf-8");
    result = JSON.parse(content);
    digest = computeDigest(content);
  } catch {
    // No existing output — agent hasn't run yet
    digest = computeDigest(JSON.stringify({ _placeholder: true }));
    result = { _placeholder: true };
  }

  return [
    {
      name: artifactName,
      kind: verificationKind,
      boundTo,
      digest,
      invalidated: false,
    },
  ];
}

/**
 * Execute the verification matrix for a given profile and return per-kind
 * results.
 *
 * For each verification kind in the profile's list:
 * 1. Look up the definition
 * 2. Read any existing verification output
 * 3. Run the pass predicate
 * 4. Compute the artifact digest
 * 5. Return the result
 */
export function runVerification(
  ws: Workspace,
  profileName: string,
): VerificationResult[] {
  // Get the verification list for this profile
  const profileKeys = PROFILE_VERIFICATION[profileName];
  if (!profileKeys) {
    // Unknown profile — fall back to empty
    return [];
  }

  const digests = computeRunDigests(ws);
  const results: VerificationResult[] = [];

  for (const verificationKind of profileKeys) {
    const def = getVerificationDefinition(verificationKind);
    if (!def) continue;

    // Read existing verification output (if any)
    const existingArtifactPath = verificationArtifactPath(ws, verificationKind);
    let existingResult: unknown = {};
    let artifactContent = JSON.stringify({ _placeholder: true });

    try {
      const content = fs.readFileSync(existingArtifactPath, "utf-8");
      existingResult = JSON.parse(content);
      artifactContent = content;
    } catch {
      // No existing output — will be created by verification agent
    }

    // Run pass predicate
    const pass = def.passPredicate(existingResult);

    // Compute digest
    const digest = createHash("sha256").update(artifactContent).digest("hex");

    // Build artifacts
    const artifacts = buildArtifacts(ws, verificationKind);

    results.push({
      kind: verificationKind,
      pass,
      result: existingResult,
      digest,
      artifacts,
      runId: ws.runId,
    });
  }

  return results;
}
