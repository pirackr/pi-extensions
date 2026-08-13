/**
 * Research history — workspace discovery, listing, and lifecycle queries.
 *
 * Operates on retained workspaces (workspace directories in the project root).
 * Discovery excludes `.research/cache/web/` directories.
 * Malformed or partial workspaces are reported but do not abort the listing.
 *
 * /research list  → lists all retained workspaces
 * /research status [<slug>]  → looks up a single workspace
 * /research pause  → pauses the active workspace (via lifecycle)
 * /research clear  → abandons the active workspace (via lifecycle)
 * /research resume [<slug>]  → resumes a paused workspace (via resume module)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { Workspace } from "./workspace.ts";
import {
  newRunState,
  readRunState,
  type RunState,
} from "./state.ts";
import type { LifecycleState } from "./lifecycle.ts";
import {
  loadLifecycleSnapshot,
  createLifecycleSnapshot,
  persistLifecycle,
} from "./lifecycle.ts";
import { TransitionsFile } from "./startup.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WorkspaceEntry {
  /** Absolute path to the workspace directory. */
  path: string;
  /** Unique run identifier. */
  runId: string;
  /** Human-readable mission statement. */
  mission: string;
  /** Profile used for this workspace. */
  profile: string;
  /** Current lifecycle state. */
  status: LifecycleState;
  /** Reason for the current state, or null. */
  reason: string | null;
  /** Epoch milliseconds at creation. */
  createdAt: number;
  /** Epoch milliseconds at last update. */
  updatedAt: number;
  /** Transition identifier. */
  transitionId: string;
  /** Whether the workspace could be fully parsed. */
  isMalformed: boolean;
  /** If malformed, the error message. */
  malformedReason: string | null;
}

export interface WorkspaceList {
  entries: WorkspaceEntry[];
  malformed: Array<{ path: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RESEARCH_CACHE_DIR = ".research/cache/web";
const LIFECYCLE_FILE = "lifecycle.json";
const RUN_STATE_FILE = "run-state.json";
const RUN_MANIFEST_FILE = "run.json";
const TRANSITION_FILE = "transitions.json";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check if a path is inside the research cache (excluded from listings).
 */
function isInResearchCache(dir: string): boolean {
  return dir.includes("/" + RESEARCH_CACHE_DIR + "/")
    || dir.includes("/" + RESEARCH_CACHE_DIR);
}

/**
 * Read a workspace's lifecycle snapshot, creating a default if missing.
 */
function readWorkspaceLifecycle(
  workspacePath: string,
): LifecycleState {
  const snapshot = loadLifecycleSnapshot({ path: workspacePath, projectRoot: path.dirname(workspacePath), mission: "", runId: "", transitionId: "" } as Workspace);
  if (snapshot) return snapshot.current;
  // Check run-state.json for status
  try {
    const state = readRunState({ path: workspacePath, projectRoot: path.dirname(workspacePath), mission: "", runId: "", transitionId: "" } as Workspace);
    const lifecycleMap: Record<RunState["status"], LifecycleState> = {
      active: "active",
      paused: "paused",
      complete: "complete",
      error: "failed",
    };
    return lifecycleMap[state.status] ?? "active";
  } catch {
    return "active";
  }
}

// ---------------------------------------------------------------------------
// Workspace discovery
// ---------------------------------------------------------------------------

/**
 * Discover retained workspace directories in a project root.
 *
 * - Scans top-level directory entries
 * - Excludes hidden entries (.claim-, .staging-, .research/, etc.)
 * - Excludes directories inside .research/cache/web/
 * - For each candidate, tries to read its lifecycle/state
 * - Reports malformed workspaces without aborting
 */
export function discoverWorkspaces(projectRoot: string): WorkspaceList {
  const entries: WorkspaceEntry[] = [];
  const malformed: Array<{ path: string; reason: string }> = [];

  if (!fs.existsSync(projectRoot)) {
    return { entries: [], malformed };
  }

  const dirs = fs.readdirSync(projectRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."));

  for (const dir of dirs) {
    const dirPath = path.join(projectRoot, dir.name);

    // Skip directories inside .research/cache/web/
    if (isInResearchCache(dirPath)) {
      continue;
    }

    try {
      const entry = buildWorkspaceEntry(dirPath);
      if (entry) {
        if (entry.isMalformed) {
          malformed.push({ path: dirPath, reason: entry.malformedReason ?? "incomplete workspace metadata" });
        } else {
          entries.push(entry);
        }
      } else {
        malformed.push({
          path: dirPath,
          reason: "incomplete workspace metadata",
        });
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      malformed.push({ path: dirPath, reason });
    }
  }

  return { entries, malformed };
}

/**
 * Build a WorkspaceEntry from a workspace directory path.
 * Returns null if the directory is incomplete (no state or manifest).
 */
function buildWorkspaceEntry(workspacePath: string): WorkspaceEntry | null {
  const lifecyclePath = path.join(workspacePath, ".research", LIFECYCLE_FILE);
  const statePath = path.join(workspacePath, ".research", RUN_STATE_FILE);
  const manifestPath = path.join(workspacePath, ".research", RUN_MANIFEST_FILE);

  let lifecycle: LifecycleState = "active";
  let reason: string | null = null;
  let createdAt = Date.now();
  let updatedAt = Date.now();
  let isMalformed = false;
  let malformedReason: string | null = null;

  // Try to read lifecycle.json first
  if (fs.existsSync(lifecyclePath)) {
    try {
      const snapshot = JSON.parse(
        fs.readFileSync(lifecyclePath, "utf-8"),
      ) as { current: string; reason?: string | null; timestamp: number; history: Array<{ from: string | null; to: string; reason: string; timestamp: number }> };
      lifecycle = snapshot.current as LifecycleState;
      reason = snapshot.reason ?? null;
      createdAt = snapshot.history[0]?.timestamp ?? createdAt;
      updatedAt = snapshot.timestamp;
      // Derive transitionId from the initial transition (from === null)
      const firstTransition = snapshot.history.find((h) => h.from === null);
      if (firstTransition) {
        // Extract transition ID from the reason field if it contains one
        // (e.g., "created tr-abc: initial") or just use a placeholder
      }
    } catch {
      isMalformed = true;
      malformedReason = "lifecycle.json parse error";
    }
  }

  // Fall back to run-state.json if no lifecycle
  if (!isMalformed && !fs.existsSync(lifecyclePath)) {
    if (fs.existsSync(statePath)) {
      try {
        const state = JSON.parse(
          fs.readFileSync(statePath, "utf-8"),
        ) as { status: string; runId: string; mission: string; createdAt: number; updatedAt: number; checkpointProfile?: string };
        const lifecycleMap: Record<string, LifecycleState> = {
          active: "active",
          paused: "paused",
          complete: "complete",
          error: "failed",
        };
        lifecycle = lifecycleMap[state.status] ?? "active";
        createdAt = state.createdAt ?? createdAt;
        updatedAt = state.updatedAt ?? updatedAt;

        // Build a default lifecycle snapshot for persistence
        const ws = { path: workspacePath, projectRoot: path.dirname(workspacePath) } as unknown as Workspace;
        const defaultSnapshot = createLifecycleSnapshot(lifecycle, "restored from run-state");
        persistLifecycle(ws, defaultSnapshot);
      } catch {
        isMalformed = true;
        malformedReason = "run-state.json parse error";
      }
    } else {
      // No lifecycle or state — check manifest
      if (fs.existsSync(manifestPath)) {
        try {
          const manifest = JSON.parse(
            fs.readFileSync(manifestPath, "utf-8"),
          ) as { runId: string; mission: string; createdAt: number; workspace: string; checkpointProfile?: string };
          createdAt = manifest.createdAt ?? createdAt;
        } catch {
          isMalformed = true;
          malformedReason = "run.json parse error";
        }
      } else {
        return null; // incomplete workspace — no metadata at all
      }
    }
  }

  // Try to read manifest for runId, mission, profile
  let runId = "";
  let mission = path.basename(workspacePath);
  let profile = "standard";
  let transitionId = "";

  if (fs.existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(
        fs.readFileSync(manifestPath, "utf-8"),
      ) as {
        runId?: string;
        mission?: string;
        workspace?: string;
        profile?: string;
      };
      runId = manifest.runId ?? "";
      mission = manifest.mission ?? mission;
      if (manifest.profile) {
        profile = manifest.profile;
      }
    } catch {
      if (!isMalformed) {
        isMalformed = true;
        malformedReason = "run.json malformed";
      }
    }
  }

  // Fall back to run-state for runId and profile if manifest didn't provide them
  if (!runId || profile === "standard") {
    if (fs.existsSync(statePath)) {
      try {
        const state = JSON.parse(
          fs.readFileSync(statePath, "utf-8"),
        ) as { runId?: string; mission?: string; checkpointProfile?: string };
        if (state.runId) runId = state.runId;
        if (state.mission) mission = state.mission;
        if (state.checkpointProfile && state.checkpointProfile !== "standard") {
          profile = state.checkpointProfile;
        }
      } catch {
        if (!isMalformed) {
          isMalformed = true;
          malformedReason = "run-state.json malformed";
        }
      }
    }
  }

  // Try to derive transitionId from runId or from the lifecycle history
  if (!transitionId && runId) {
    transitionId = runId.split("-")[0] || "";
  }
  // Also check if lifecycle has a transitionId embedded in the reason
  if (!transitionId || transitionId === "run") {
    if (reason && /^tr-[a-z0-9]+/.test(reason)) {
      transitionId = reason.match(/^tr-[a-z0-9]+/)![0];
    }
  }

  return {
    path: workspacePath,
    runId,
    mission,
    profile,
    status: lifecycle,
    reason,
    createdAt,
    updatedAt,
    transitionId,
    isMalformed,
    malformedReason,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * List all retained workspaces.
 * Excludes .research/cache/web/ directories.
 * Reports malformed workspaces without aborting.
 */
export function listWorkspaces(projectRoot: string): WorkspaceList {
  return discoverWorkspaces(projectRoot);
}

/**
 * Lookup a single workspace by directory name or absolute path.
 * If the argument is an absolute path, use it directly.
 * Otherwise, search projectRoot for a directory matching the slug.
 * Returns null if not found.
 */
export function lookupWorkspace(
  projectRoot: string,
  slugOrPath: string,
): WorkspaceEntry | null {
  // Try as absolute path first
  if (path.isAbsolute(slugOrPath)) {
    if (fs.existsSync(slugOrPath)) {
      return buildWorkspaceEntry(slugOrPath);
    }
    return null;
  }

  // Search for exact name match first, then prefix match
  if (!fs.existsSync(projectRoot)) return null;

  const dirs = fs.readdirSync(projectRoot, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith("."));

  // Try exact match
  for (const dir of dirs) {
    if (dir.name === slugOrPath) {
      return buildWorkspaceEntry(path.join(projectRoot, dir.name));
    }
  }

  // Try prefix match
  for (const dir of dirs) {
    if (dir.name.startsWith(slugOrPath + "-")) {
      return buildWorkspaceEntry(path.join(projectRoot, dir.name));
    }
  }

  return null;
}

/**
 * Get the lifecycle snapshot for a workspace.
 */
export function getLifecycle(workspacePath: string): LifecycleState | null {
  if (!fs.existsSync(workspacePath)) return null;
  return readWorkspaceLifecycle(workspacePath);
}

/**
 * Get the workspace entry for the current active workspace (if any).
 * Uses the transitions file pointer if available.
 */
export function getActiveWorkspace(
  projectRoot: string,
  transitionsPath: string,
): WorkspaceEntry | null {
  try {
    const tf = new TransitionsFile(transitionsPath);
    const pointer = tf.getCurrentPointer();
    if (!pointer) return null;

    const runIdParts = pointer.runId.split("-");
    const transitionId = runIdParts[0] || "";
    const slug = runIdParts.slice(1).join("-") || "";

    // Find workspace by transitionId/slug
    if (!fs.existsSync(projectRoot)) return null;
    const dirs = fs.readdirSync(projectRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith("."));

    for (const dir of dirs) {
      if (dir.name === slug || dir.name === slug) {
        const entry = buildWorkspaceEntry(path.join(projectRoot, dir.name));
        if (entry) {
          entry.transitionId = transitionId;
          return entry;
        }
      }
    }
  } catch {
    // Transitions file missing — fall through
  }

  // Fallback: search for any active workspace
  const { entries } = listWorkspaces(projectRoot);
  const active = entries.find((e) => e.status === "active");
  return active ?? null;
}
