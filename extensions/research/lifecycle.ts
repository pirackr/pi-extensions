/**
 * Research lifecycle state machine.
 *
 * States: active → paused / no_progress / budget_limited / complete / failed
 *          paused → active (resume) / no_progress / budget_limited / failed / abandoned / replaced
 *          failed / complete / integrity_error → abandoned / replaced
 *          abandoned → replaced
 *          replaced → abandoned (defensive — shouldn't normally happen)
 *
 * Every transition carries a structured reason and timestamp.
 * Persistence is via lifecycle.json inside the workspace's .research/ dir.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Workspace } from "./workspace.ts";
import { readRunState, updateRunState, type RunState } from "./state.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LifecycleState =
  | "active"
  | "paused"
  | "no_progress"
  | "budget_limited"
  | "complete"
  | "failed"
  | "integrity_error"
  | "abandoned"
  | "replaced";

export interface LifecycleTransition {
  from: LifecycleState | null;
  to: LifecycleState;
  reason: string;
  timestamp: number;
}

export interface LifecycleSnapshot {
  current: LifecycleState;
  reason: string | null;
  timestamp: number;
  history: LifecycleTransition[];
}

// ---------------------------------------------------------------------------
// Valid transition matrix
// ---------------------------------------------------------------------------

export const VALID_LIFECYCLE_TRANSITIONS: Record<LifecycleState, LifecycleState[]> = {
  active: ["paused", "no_progress", "budget_limited", "complete", "failed", "integrity_error", "abandoned", "replaced"],
  paused: ["active", "no_progress", "budget_limited", "failed", "abandoned", "replaced"],
  no_progress: ["active", "paused", "budget_limited", "failed", "abandoned", "replaced"],
  budget_limited: ["active", "paused", "failed", "abandoned", "replaced"],
  complete: ["abandoned", "replaced"],
  failed: ["active", "abandoned", "replaced"],
  integrity_error: ["active", "abandoned", "replaced"],
  abandoned: ["replaced"],
  replaced: ["abandoned"],
};

// ---------------------------------------------------------------------------
// Snapshot helpers
// ---------------------------------------------------------------------------

/**
 * Create a new lifecycle snapshot with an initial state.
 */
export function createLifecycleSnapshot(
  initialState: LifecycleState,
  reason: string = "initialized",
): LifecycleSnapshot {
  return {
    current: initialState,
    reason,
    timestamp: Date.now(),
    history: [{ from: null, to: initialState, reason, timestamp: Date.now() }],
  };
}

/**
 * Transition the lifecycle to a new state.
 * Throws if the transition is not allowed from the current state.
 */
export function transitionLifecycle(
  snapshot: LifecycleSnapshot,
  to: LifecycleState,
  reason: string,
): LifecycleSnapshot {
  const allowed = VALID_LIFECYCLE_TRANSITIONS[snapshot.current];
  if (!allowed || !allowed.includes(to)) {
    throw new Error(
      `Invalid lifecycle transition: ${snapshot.current} → ${to}. Allowed: ${allowed?.join(", ")}`,
    );
  }

  return {
    current: to,
    reason,
    timestamp: Date.now(),
    history: [
      ...snapshot.history,
      { from: snapshot.current, to, reason, timestamp: Date.now() },
    ],
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

const LIFECYCLE_FILE = "lifecycle.json";

/**
 * Persist lifecycle snapshot to the workspace.
 */
export function persistLifecycle(workspace: Workspace, snapshot: LifecycleSnapshot): void {
  const lifecyclePath = path.join(workspace.path, ".research", LIFECYCLE_FILE);
  fs.writeFileSync(lifecyclePath, JSON.stringify(snapshot, null, 2), "utf-8");
}

/**
 * Load lifecycle snapshot from the workspace.
 * Returns null if no lifecycle file exists.
 */
export function loadLifecycleSnapshot(workspace: Workspace): LifecycleSnapshot | null {
  const lifecyclePath = path.join(workspace.path, ".research", LIFECYCLE_FILE);
  if (!fs.existsSync(lifecyclePath)) return null;
  try {
    const raw = fs.readFileSync(lifecyclePath, "utf-8");
    return JSON.parse(raw) as LifecycleSnapshot;
  } catch {
    return null;
  }
}

/**
 * Update the run-state status to match the lifecycle current state.
 */
export function syncRunStateStatus(
  workspace: Workspace,
  lifecycleCurrent: LifecycleState,
): RunState {
  const state = readRunState(workspace);
  const statusMap: Record<LifecycleState, RunState["status"]> = {
    active: "active",
    paused: "paused",
    no_progress: "active", // engine treats as paused via status line
    budget_limited: "active",
    complete: "active",
    failed: "error",
    integrity_error: "error",
    abandoned: "active",
    replaced: "active",
  };
  const mapped = statusMap[lifecycleCurrent] ?? state.status;

  if (mapped === state.status) return state; // no change

  return updateRunStateSync(workspace, (current) => ({
    ...current,
    status: mapped,
    updatedAt: Date.now(),
  }));
}

function updateRunStateSync(
  workspace: Workspace,
  mutate: (current: Readonly<RunState>) => RunState,
): RunState {
  const current = readRunState(workspace);
  const updated = mutate(current);
  updated.revision = current.revision + 1;
  updated.updatedAt = Date.now();

  const statePath = path.join(workspace.path, ".research", "run-state.json");
  const tmpPath = statePath + ".tmp";
  fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2), "utf-8");

  try {
    const fd = fs.openSync(tmpPath, "r");
    fs.fdatasyncSync(fd);
    fs.closeSync(fd);
  } catch {
    // best-effort
  }

  fs.renameSync(tmpPath, statePath);
  return updated;
}

// ---------------------------------------------------------------------------
// State helpers
// ---------------------------------------------------------------------------

/**
 * Pause a lifecycle in the active state.
 */
export function pauseLifecycle(
  workspace: Workspace,
  reason: string = "paused by user",
): LifecycleSnapshot {
  const snapshot = loadLifecycleSnapshot(workspace) ?? createLifecycleSnapshot("active");
  const updated = transitionLifecycle(snapshot, "paused", reason);
  persistLifecycle(workspace, updated);
  syncRunStateStatus(workspace, "paused");
  return updated;
}

/**
 * Resume a paused or no_progress lifecycle back to active.
 * The actual resume (lease, validation) is handled by the resume module.
 * This just updates the lifecycle snapshot.
 *
 * Also accepts "failed" → "active" for retry after failure.
 */
export function markResumed(
  workspace: Workspace,
  reason: string = "resumed",
): LifecycleSnapshot {
  const snapshot = loadLifecycleSnapshot(workspace);
  if (!snapshot) {
    throw new Error(`No lifecycle found at ${workspace.path}`);
  }
  const allowed = VALID_LIFECYCLE_TRANSITIONS[snapshot.current];
  if (!allowed.includes("active")) {
    throw new Error(
      `Cannot resume from ${snapshot.current}: not in a resumable state`,
    );
  }
  const updated = transitionLifecycle(snapshot, "active", reason);
  persistLifecycle(workspace, updated);
  syncRunStateStatus(workspace, "active");
  return updated;
}

/**
 * Mark lifecycle as abandoned (clear/cancel).
 */
export function markAbandoned(
  workspace: Workspace,
  reason: string = "abandoned by user",
): LifecycleSnapshot {
  const snapshot = loadLifecycleSnapshot(workspace) ?? createLifecycleSnapshot("active");
  const updated = transitionLifecycle(snapshot, "abandoned", reason);
  persistLifecycle(workspace, updated);
  syncRunStateStatus(workspace, "abandoned");
  return updated;
}

/**
 * Mark lifecycle as replaced (new run started).
 */
export function markReplaced(
  workspace: Workspace,
  reason: string = "replaced by new run",
): LifecycleSnapshot {
  const snapshot = loadLifecycleSnapshot(workspace) ?? createLifecycleSnapshot("active");
  const updated = transitionLifecycle(snapshot, "replaced", reason);
  persistLifecycle(workspace, updated);
  syncRunStateStatus(workspace, "replaced");
  return updated;
}

/**
 * Mark lifecycle as failed.
 */
export function markFailed(
  workspace: Workspace,
  reason: string = "failed",
): LifecycleSnapshot {
  const snapshot = loadLifecycleSnapshot(workspace) ?? createLifecycleSnapshot("active");
  const updated = transitionLifecycle(snapshot, "failed", reason);
  persistLifecycle(workspace, updated);
  syncRunStateStatus(workspace, "failed");
  return updated;
}
