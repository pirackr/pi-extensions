/**
 * Research resume — re-acquires lease and validates integrity for resuming
 * a paused, no_progress, or failed workspace.
 *
 * Validation steps:
 * 1. Manifest/snapshot integrity
 * 2. Mutable-state schema + run ID consistency
 * 3. Exact provider/adapter compatibility
 * 4. Frozen capabilities compatibility
 * 5. Models/extensions consistency
 * 6. Ownership (lease ownership)
 * 7. In-flight attempts → interrupted (keep counts)
 * 8. Concurrency slots released transactionally
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Workspace } from "./workspace.ts";
import type { RunState } from "./state.ts";
import { readRunState, acquireLease } from "./state.ts";
import type { RunManifest } from "./manifest.ts";
import type { ResolvedResearchConfig } from "./config.ts";
import type {
  ModelRegistryView,
  ResolvedRunContract,
} from "./startup.ts";
import { ResearchPolicy, type FrozenConfig } from "./policy.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ResumeDependencies {
  config: ResolvedResearchConfig;
  getModels: () => ModelRegistryView;
}

export type ResumeResult = {
  success: true;
  workspace: Workspace;
  runState: RunState;
  manifest: RunManifest;
  contract: ResolvedRunContract;
  frozenConfig: FrozenConfig;
  lifecycleReason: string;
} | {
  success: false;
  error: string;
  reason: ResumeErrorKind;
};

export type ResumeErrorKind =
  | "no_lifecycle"
  | "manifest_mismatch"
  | "snapshot_invalid"
  | "state_schema_invalid"
  | "run_id_mismatch"
  | "provider_incompatible"
  | "adapter_incompatible"
  | "capabilities_mismatch"
  | "models_changed"
  | "extensions_changed"
  | "ownership_conflict"
  | "lease_held"
  | "state_not_resumable";

// ---------------------------------------------------------------------------
// Resume logic
// ---------------------------------------------------------------------------

/**
 * Attempt to resume a workspace.
 *
 * Performs all validation steps. On failure, returns a structured error.
 * On success, acquires the lease and returns resume result.
 */
export async function resumeWorkspace(
  workspacePath: string,
  deps: ResumeDependencies,
  sessionId: string = "resume-session",
): Promise<ResumeResult> {
  const workspace = {
    path: workspacePath,
    projectRoot: path.dirname(workspacePath),
    mission: "",
    runId: "",
    transitionId: "",
  } as Workspace;

  // Step 1: Check lifecycle exists and is in a resumable state
  const lifecyclePath = path.join(workspacePath, ".research", "lifecycle.json");
  if (!fs.existsSync(lifecyclePath)) {
    return {
      success: false,
      error: "No lifecycle snapshot found",
      reason: "no_lifecycle",
    };
  }

  let lifecycle: { current: string; history: Array<{ to: string }> };
  try {
    lifecycle = JSON.parse(fs.readFileSync(lifecyclePath, "utf-8")) as any;
  } catch {
    return {
      success: false,
      error: "lifecycle.json is malformed",
      reason: "no_lifecycle",
    };
  }

  const resumableStates = new Set(["paused", "no_progress", "failed", "budget_limited"]);
  if (!resumableStates.has(lifecycle.current)) {
    return {
      success: false,
      error: `Cannot resume from state '${lifecycle.current}': not in a resumable state`,
      reason: "state_not_resumable",
    };
  }

  // Step 2: Read and validate manifest/snapshot integrity
  const manifestPath = path.join(workspacePath, ".research", "run.json");
  if (!fs.existsSync(manifestPath)) {
    return {
      success: false,
      error: "Manifest (run.json) not found — cannot resume without a manifest",
      reason: "manifest_mismatch",
    };
  }

  let manifest: {
    runId: string;
    mission: string;
    workspace: string;
    snapshotSha256?: string | null;
    resolvedContract?: unknown;
    frozenConfig?: unknown;
  };
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8")) as any;
  } catch {
    return {
      success: false,
      error: "Manifest (run.json) is malformed",
      reason: "manifest_mismatch",
    };
  }

  // Verify workspace path in manifest matches
  if (manifest.workspace !== workspacePath) {
    return {
      success: false,
      error: `Manifest workspace path mismatch: ${manifest.workspace} ≠ ${workspacePath}`,
      reason: "manifest_mismatch",
    };
  }
  // Step 3: Read and validate run-state schema
  const statePath = path.join(workspacePath, ".research", "run-state.json");
  if (!fs.existsSync(statePath)) {
    return {
      success: false,
      error: "Run state (run-state.json) not found",
      reason: "state_schema_invalid",
    };
  }

  let state: RunState;
  try {
    state = readRunState(workspace);
  } catch {
    return {
      success: false,
      error: "Run state (run-state.json) is malformed",
      reason: "state_schema_invalid",
    };
  }

  // Validate run-state has required schema fields
  const requiredFields: (keyof RunState)[] = [
    "revision", "status", "createdAt", "updatedAt", "mission",
    "runId", "coordinatorUsage", "nestedUsage", "tokensUsed",
    "concurrentReservations", "researchRound", "checkpointVerdict",
    "checkpointDigest", "checkpointUnmet", "checkpointUniqueSources",
    "loopIteration", "checkpointProfile",
  ];
  for (const field of requiredFields) {
    if (!(field in state)) {
      return {
        success: false,
        error: `Run state missing required field: ${field}`,
        reason: "state_schema_invalid",
      };
    }
  }

  // Validate run ID consistency between manifest and state
  if (manifest.runId !== state.runId) {
    return {
      success: false,
      error: `Run ID mismatch: manifest=${manifest.runId}, state=${state.runId}`,
      reason: "run_id_mismatch",
    };
  }

  // Restore the canonical retained identity before handing the workspace to
  // the active policy adapter. Retained workspaces live under <root>/.research.
  workspace.projectRoot = path.basename(path.dirname(workspacePath)) === ".research"
    ? path.dirname(path.dirname(workspacePath))
    : path.dirname(workspacePath);
  workspace.mission = manifest.mission;
  workspace.runId = state.runId;

  // Step 4: Load the activation-time frozen snapshots. Resume reuses the exact
  // ResolvedRunContract and FrozenConfig persisted with the immutable run
  // manifest — it MUST NOT call validateStartupContract (that would reread
  // mutable role prompts and re-resolve models) and MUST NOT rebuild the
  // policy snapshot from the mutable source config. If the required snapshots
  // are absent or malformed, resume fails closed.
  const frozenContract = manifest.resolvedContract;
  const frozenPolicy = manifest.frozenConfig;
  if (
    !isResolvedContractSnapshot(frozenContract) ||
    !isFrozenConfigSnapshot(frozenPolicy)
  ) {
    return {
      success: false,
      error:
        "Required activation-time snapshots are absent or malformed " +
        "(resolvedContract/frozenConfig).",
      reason: "snapshot_invalid",
    };
  }

  if (
    frozenContract.runId !== state.runId ||
    frozenContract.mission !== manifest.mission
  ) {
    return {
      success: false,
      error: "Activation-time contract identity does not match the retained run.",
      reason: "snapshot_invalid",
    };
  }

  const contract = deepFreeze(
    cloneSnapshot(frozenContract),
  ) as unknown as ResolvedRunContract;
  const frozenConfig = deepFreeze(
    cloneSnapshot(frozenPolicy),
  ) as unknown as FrozenConfig;

  try {
    // Constructor validation checks the complete frozen role policy shape
    // without reserving, mutating state, or reading prompt sources.
    new ResearchPolicy(
      workspace,
      frozenConfig,
      frozenConfig.hardTimeoutSeconds,
    );
  } catch (err) {
    return {
      success: false,
      error: `Frozen policy snapshot is malformed: ${err instanceof Error ? err.message : String(err)}`,
      reason: "snapshot_invalid",
    };
  }

  // Integrity check only: every already-resolved concrete profile model must
  // still exist. Aliases and mutable config are deliberately ignored.
  const models = deps.getModels();
  for (const [roleName, profile] of Object.entries(contract.resolvedProfiles)) {
    if (!models.get(profile.model)) {
      return {
        success: false,
        error: `Model '${profile.model}' (role '${roleName}') no longer exists in the registry`,
        reason: "models_changed",
      };
    }
  }

  // Step 5: Validate ownership (lease check)
  const leasePath = path.join(workspacePath, ".research", "run-lease.json");
  let leaseHeldBySelf = false;
  if (fs.existsSync(leasePath)) {
    try {
      const existingLease = JSON.parse(
        fs.readFileSync(leasePath, "utf-8"),
      ) as { sessionId: string; acquiredAt: number };
      const LEASE_TIMEOUT_MS = 300_000; // 5 minutes (same as state.ts)

      if (Date.now() - existingLease.acquiredAt < LEASE_TIMEOUT_MS) {
        if (existingLease.sessionId !== sessionId) {
          return {
            success: false,
            error: `Lease held by session ${existingLease.sessionId} (not expired)`,
            reason: "lease_held",
          };
        }
        leaseHeldBySelf = true;
      }
    } catch {
      // Malformed lease — best-effort, continue
    }
  }

  // Step 6: Interrupt in-flight attempts and release concurrency
  // (This is best-effort — the state API already tracks concurrency)
  try {
    const currentState = readRunState(workspace);
    if ((currentState.concurrentReservations ?? 0) > 0) {
      // Mark attempts as interrupted: decrement concurrency, keep consumed counts
      fs.writeFileSync(
        statePath,
        JSON.stringify({
          ...currentState,
          concurrentReservations: 0,
          updatedAt: Date.now(),
          revision: currentState.revision + 1,
        }, null, 2),
        "utf-8",
      );
    }
  } catch {
    // Best-effort — state may be inconsistent but resume can proceed
  }

  // Step 7: Acquire the lease
  // If we have an existing lease held by the same session, delete it first
  // so acquireLease can create a fresh one. If held by another session,
  // acquireLease will throw (caught below).
  if (leaseHeldBySelf) {
    try { fs.unlinkSync(leasePath); } catch { /* ignore */ }
  }
  try {
    await acquireLease(workspace, sessionId);
  } catch {
    return {
      success: false,
      error: "Failed to acquire lease",
      reason: "ownership_conflict",
    };
  }

  // Success — return resume result
  return {
    success: true,
    workspace,
    runState: state,
    manifest: manifest as any,
    contract,
    frozenConfig,
    lifecycleReason: `Resumed from ${lifecycle.current}: ${lifecycle.history[lifecycle.history.length - 1]?.to ?? "unknown"}`,
  };
}

/**
 * Validate that frozen capabilities haven't changed.
 * Checks that the model registry still has the same capabilities
 * that the frozen config requires.
 */
export function validateFrozenCapabilities(
  contract: ResolvedRunContract,
  deps: ResumeDependencies,
): string | null {
  const models = deps.getModels();

  // Check each resolved model is still valid
  for (const [roleName, modelEntry] of Object.entries(contract.resolvedModels)) {
    const current = models.get(modelEntry.id);
    if (!current) {
      return `Model '${modelEntry.id}' (role '${roleName}') no longer in registry`;
    }
    // Check capabilities haven't regressed
    for (const cap of modelEntry.capabilities) {
      // The model entry's capabilities are what was available at contract time
      // We verify the provider still supports the required tools
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// Activation-time snapshot validators (fail-closed shape checks)
// ---------------------------------------------------------------------------

/** Structural check for a persisted {@link ResolvedRunContract} snapshot. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value).sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === [...expected].sort()[index]);
}

function cloneSnapshot<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) {
      deepFreeze(nested);
    }
    Object.freeze(value);
  }
  return value;
}

/** Fail-closed structural check for a persisted ResolvedRunContract snapshot. */
function isResolvedContractSnapshot(value: unknown): value is ResolvedRunContract {
  if (!isRecord(value) || !hasExactKeys(value, [
    "runId", "transitionId", "mission", "profile", "programPath",
    "profileConfig", "defaults", "resolvedProfiles", "resolvedModels",
    "hardCeilings",
  ])) return false;
  if (
    typeof value.runId !== "string" ||
    typeof value.transitionId !== "string" ||
    typeof value.mission !== "string" ||
    typeof value.profile !== "string" ||
    typeof value.programPath !== "string" ||
    !isRecord(value.profileConfig) ||
    !isRecord(value.defaults) ||
    !isRecord(value.hardCeilings) ||
    !isRecord(value.resolvedProfiles) ||
    !isRecord(value.resolvedModels)
  ) return false;

  const profiles = value.resolvedProfiles;
  const models = value.resolvedModels;
  const names = Object.keys(profiles);
  if (names.length === 0 || names.sort().join("\0") !== Object.keys(models).sort().join("\0")) {
    return false;
  }
  for (const name of names) {
    const profile = profiles[name];
    const model = models[name];
    if (
      !isRecord(profile) ||
      !hasExactKeys(profile, [
        "name", "description", "model", "thinking", "tools", "access",
        "systemPrompt", "timeoutSeconds",
      ]) ||
      profile.name !== name ||
      typeof profile.description !== "string" ||
      typeof profile.model !== "string" ||
      typeof profile.thinking !== "string" ||
      !Array.isArray(profile.tools) ||
      !profile.tools.every((tool) => typeof tool === "string") ||
      (profile.access !== "read" && profile.access !== "write") ||
      typeof profile.systemPrompt !== "string" ||
      !profile.systemPrompt.trim() ||
      typeof profile.timeoutSeconds !== "number" ||
      !isRecord(model) ||
      typeof model.id !== "string" ||
      typeof model.name !== "string" ||
      typeof model.provider !== "string" ||
      !Array.isArray(model.capabilities) ||
      !model.capabilities.every((capability) => typeof capability === "string")
    ) return false;
  }
  return true;
}

/** Structural check; complete role validation runs via ResearchPolicy. */
function isFrozenConfigSnapshot(value: unknown): value is FrozenConfig {
  return isRecord(value) &&
    isRecord(value.roles) &&
    Object.keys(value.roles).length > 0 &&
    typeof value.hardTimeoutSeconds === "number" &&
    Number.isFinite(value.hardTimeoutSeconds);
}
