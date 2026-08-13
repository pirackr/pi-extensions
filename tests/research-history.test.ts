/**
 * Task 10: Research lifecycle and history tests.
 *
 * Tests for:
 * - Lifecycle state machine with structured reason/timestamp
 * - /research list/status/pause/clear/resume operate on retained workspaces
 * - Cache/web exclusion from discovery
 * - Malformed/partial workspaces reported without aborting
 * - Abandonment and replacement
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "os";
import { createHash } from "node:crypto";
import type { Workspace } from "../extensions/research/workspace.ts";
import {
  newRunState,
  readRunState,
} from "../extensions/research/state.ts";
import {
  createLifecycleSnapshot,
  transitionLifecycle,
  pauseLifecycle,
  markAbandoned,
  markReplaced,
  markFailed,
  loadLifecycleSnapshot,
  persistLifecycle,
  syncRunStateStatus,
  VALID_LIFECYCLE_TRANSITIONS,
  markResumed,
  type LifecycleState,
} from "../extensions/research/lifecycle.ts";
import {
  listWorkspaces,
  lookupWorkspace,
  getActiveWorkspace,
  discoverWorkspaces,
  type WorkspaceEntry,
} from "../extensions/research/history.ts";
import { TransitionsFile } from "../extensions/research/startup.ts";

const TRANSITION_FILE = "transitions.json";

// ===========================================================================
// Helpers
// ===========================================================================

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "research-history-test-"));
}

function cleanup(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

function buildWorkspace(
  projectRoot: string,
  dirName: string,
  mission: string,
  runId: string,
  transitionId: string,
  profile = "standard",
  lifecycleState?: LifecycleState,
): Workspace {
  const wsPath = path.join(projectRoot, dirName);
  fs.mkdirSync(wsPath, { recursive: true });
  const researchPath = path.join(wsPath, ".research");
  fs.mkdirSync(researchPath, { recursive: true });

  const state = newRunState({ path: wsPath, projectRoot, mission, runId, transitionId } as Workspace);
  state.checkpointProfile = profile;
  fs.writeFileSync(
    path.join(wsPath, ".research", "run-state.json"),
    JSON.stringify(state, null, 2),
    "utf-8",
  );

  const manifest = {
    runId,
    mission,
    workspace: wsPath,
    manifestPath: path.join(wsPath, ".research", "run.json"),
    createdAt: state.createdAt,
    snapshotSha256: null,
  };
  fs.writeFileSync(
    path.join(wsPath, ".research", "run.json"),
    JSON.stringify(manifest, null, 2),
    "utf-8",
  );

  if (lifecycleState) {
    const snapshot = createLifecycleSnapshot(lifecycleState, "test-setup");
    persistLifecycle({ path: wsPath, projectRoot, mission, runId, transitionId } as Workspace, snapshot);
  }

  return { path: wsPath, projectRoot, mission, runId, transitionId };
}

// ===========================================================================
// Lifecycle state machine — transitions with reason and timestamp
// ===========================================================================

describe("lifecycle state machine", () => {
  it("creates initial snapshot with correct state and timestamp", () => {
    const snap = createLifecycleSnapshot("active", "test start");
    expect(snap.current).toBe("active");
    expect(snap.reason).toBe("test start");
    expect(snap.timestamp).toBeGreaterThan(0);
    expect(snap.history).toHaveLength(1);
    expect(snap.history[0].from).toBeNull();
    expect(snap.history[0].to).toBe("active");
    expect(snap.history[0].reason).toBe("test start");
    expect(snap.history[0].timestamp).toBeGreaterThan(0);
  });

  it("validates allowed transitions from active", () => {
    const snap = createLifecycleSnapshot("active");
    // Valid
    expect(() => transitionLifecycle(snap, "paused", "user request")).not.toThrow();
    expect(() => transitionLifecycle(snap, "complete", "done")).not.toThrow();
    expect(() => transitionLifecycle(snap, "failed", "error")).not.toThrow();
    expect(() => transitionLifecycle(snap, "integrity_error", "bad data")).not.toThrow();
    expect(() => transitionLifecycle(snap, "abandoned", "clear")).not.toThrow();
    expect(() => transitionLifecycle(snap, "replaced", "new run")).not.toThrow();
  });

  it("validates allowed transitions from paused", () => {
    const snap = createLifecycleSnapshot("paused");
    expect(() => transitionLifecycle(snap, "active", "resumed")).not.toThrow();
    expect(() => transitionLifecycle(snap, "abandoned", "cancel")).not.toThrow();
    expect(() => transitionLifecycle(snap, "replaced", "new run")).not.toThrow();
    // Invalid
    expect(() => transitionLifecycle(snap, "complete", "done")).toThrow(/Invalid.*paused.*complete/);
  });

  it("validates allowed transitions from failed", () => {
    const snap = createLifecycleSnapshot("failed");
    expect(() => transitionLifecycle(snap, "active", "retry")).not.toThrow();
    expect(() => transitionLifecycle(snap, "abandoned", "give up")).not.toThrow();
    expect(() => transitionLifecycle(snap, "replaced", "new run")).not.toThrow();
    // Invalid
    expect(() => transitionLifecycle(snap, "complete", "done")).toThrow();
  });

  it("tracks transition history with timestamps", () => {
    const snap = createLifecycleSnapshot("active", "initial");
    const s1 = transitionLifecycle(snap, "paused", "user pause");
    expect(s1.history).toHaveLength(2);
    expect(s1.history[1].from).toBe("active");
    expect(s1.history[1].to).toBe("paused");
    expect(s1.history[1].reason).toBe("user pause");

    const s2 = transitionLifecycle(s1, "abandoned", "cancel");
    expect(s2.history).toHaveLength(3);
    expect(s2.history[2].from).toBe("paused");
    expect(s2.history[2].to).toBe("abandoned");
    expect(s2.history[2].reason).toBe("cancel");
  });

  it("updates reason and timestamp on each transition", () => {
    const snap = createLifecycleSnapshot("active", "initial");
    const reason = "test reason";
    const before = snap.timestamp;
    const updated = transitionLifecycle(snap, "paused", reason);
    expect(updated.reason).toBe(reason);
    // Timestamp may be the same millisecond — just check it doesn't decrease
    expect(updated.timestamp).toBeGreaterThanOrEqual(before);
  });
});

// ===========================================================================
// Lifecycle persistence
// ===========================================================================

describe("lifecycle persistence", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it("persists and loads lifecycle snapshot", () => {
    const ws = buildWorkspace(tmpDir, "persist-test", "persist", "run-1", "tr-1");
    const snapshot = createLifecycleSnapshot("active", "initial");
    persistLifecycle(ws, snapshot);

    const loaded = loadLifecycleSnapshot(ws);
    expect(loaded).not.toBeNull();
    expect(loaded!.current).toBe("active");
    expect(loaded!.reason).toBe("initial");
    expect(loaded!.history).toHaveLength(1);
  });

  it("returns null for missing lifecycle file", () => {
    const ws = buildWorkspace(tmpDir, "no-lifecycle", "no-lifecycle", "run-1", "tr-1");
    expect(loadLifecycleSnapshot(ws)).toBeNull();
  });

  it("returns null for malformed lifecycle file", () => {
    const ws = buildWorkspace(tmpDir, "malformed-lifecycle", "malformed", "run-1", "tr-1");
    fs.writeFileSync(
      path.join(ws.path, ".research", "lifecycle.json"),
      "not json{{}",
      "utf-8",
    );
    expect(loadLifecycleSnapshot(ws)).toBeNull();
  });

  it("syncRunStateStatus updates state status", () => {
    const ws = buildWorkspace(tmpDir, "sync-test", "sync", "run-1", "tr-1", "standard", "paused");
    const state = readRunState(ws);
    expect(state.status).toBe("active"); // initial state is active

    const updated = syncRunStateStatus(ws, "paused");
    expect(updated.status).toBe("paused");
  });

  it("syncRunStateStatus maps failed → error", () => {
    const ws = buildWorkspace(tmpDir, "sync-failed", "sync", "run-1", "tr-1");
    const updated = syncRunStateStatus(ws, "failed");
    expect(updated.status).toBe("error");
  });
});

// ===========================================================================
// Lifecycle convenience helpers
// ===========================================================================

describe("lifecycle convenience helpers", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it("pauseLifecycle transitions active → paused", () => {
    const ws = buildWorkspace(tmpDir, "pause-test", "pause", "run-1", "tr-1", "standard", "active");
    const result = pauseLifecycle(ws, "user paused");
    expect(result.current).toBe("paused");
    expect(result.reason).toBe("user paused");

    // Verify persisted
    const loaded = loadLifecycleSnapshot(ws);
    expect(loaded!.current).toBe("paused");
  });

  it("markAbandoned transitions to abandoned", () => {
    const ws = buildWorkspace(tmpDir, "abandon-test", "abandon", "run-1", "tr-1");
    const result = markAbandoned(ws, "cancelled");
    expect(result.current).toBe("abandoned");
    expect(result.reason).toBe("cancelled");
  });

  it("markReplaced transitions to replaced", () => {
    const ws = buildWorkspace(tmpDir, "replace-test", "replace", "run-1", "tr-1");
    const result = markReplaced(ws, "new run");
    expect(result.current).toBe("replaced");
    expect(result.reason).toBe("new run");
  });

  it("markFailed transitions to failed", () => {
    const ws = buildWorkspace(tmpDir, "failed-test", "fail", "run-1", "tr-1");
    const result = markFailed(ws, "crashed");
    expect(result.current).toBe("failed");
    expect(result.reason).toBe("crashed");
  });

  it("markResumed throws when not in resumable state", () => {
    const ws = buildWorkspace(tmpDir, "resume-throw", "resume", "run-1", "tr-1", "standard", "complete");
    expect(() => markResumed(ws)).toThrow(/Cannot resume/);
  });

  it("markResumed succeeds from paused", () => {
    const ws = buildWorkspace(tmpDir, "resume-ok", "resume", "run-1", "tr-1", "standard", "paused");
    const result = markResumed(ws, "resumed");
    expect(result.current).toBe("active");
  });

  it("markResumed succeeds from failed", () => {
    const ws = buildWorkspace(tmpDir, "resume-failed", "resume", "run-1", "tr-1", "standard", "failed");
    const result = markResumed(ws, "retry");
    expect(result.current).toBe("active");
  });
});

// ===========================================================================
// /research list — workspace discovery, cache exclusion, malformed
// ===========================================================================

describe("/research list — workspace discovery", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it("discovers valid workspaces with manifest", () => {
    buildWorkspace(tmpDir, "my-research", "my research", "run-1", "tr-1");
    buildWorkspace(tmpDir, "another-research", "another research", "run-2", "tr-2");

    const { entries } = listWorkspaces(tmpDir);
    expect(entries.length).toBe(2);
    expect(entries.find((e) => e.mission === "my research")).toBeDefined();
    expect(entries.find((e) => e.mission === "another research")).toBeDefined();
    expect(entries[0].isMalformed).toBe(false);
    expect(entries[0].malformedReason).toBeNull();
  });

  it("excludes hidden directories", () => {
    buildWorkspace(tmpDir, "visible-workspace", "visible", "run-1", "tr-1");
    // Create hidden dirs
    fs.mkdirSync(path.join(tmpDir, ".claim-visible-tr-1"));
    fs.mkdirSync(path.join(tmpDir, ".staging-visible"));
    fs.mkdirSync(path.join(tmpDir, ".hidden-research"));

    const { entries } = listWorkspaces(tmpDir);
    expect(entries.length).toBe(1);
    expect(entries[0].path).toBe(path.join(tmpDir, "visible-workspace"));
  });

  it("excludes .research/cache/web/ directories", () => {
    buildWorkspace(tmpDir, "normal-workspace", "normal", "run-1", "tr-1");
    // Create cache dirs
    fs.mkdirSync(path.join(tmpDir, ".research/cache/web/cache-1"), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, ".research/cache/web/cache-2"), { recursive: true });

    const { entries } = listWorkspaces(tmpDir);
    expect(entries.length).toBe(1);
    expect(entries[0].path).toBe(path.join(tmpDir, "normal-workspace"));
  });

  it("reports malformed workspace (no state, no manifest)", () => {
    buildWorkspace(tmpDir, "complete-workspace", "complete", "run-1", "tr-1");
    // Create a partial workspace (empty dir)
    fs.mkdirSync(path.join(tmpDir, "partial-workspace"));

    const { entries, malformed } = listWorkspaces(tmpDir);
    expect(entries.length).toBe(1);
    expect(malformed.length).toBe(1);
    expect(malformed[0].path).toBe(path.join(tmpDir, "partial-workspace"));
    expect(malformed[0].reason).toBe("incomplete workspace metadata");
  });

  it("reports malformed workspace with parse errors", () => {
    buildWorkspace(tmpDir, "good-workspace", "good", "run-1", "tr-1");
    // Create a workspace with bad JSON
    const badDir = path.join(tmpDir, "bad-workspace");
    fs.mkdirSync(badDir, { recursive: true });
    fs.mkdirSync(path.join(badDir, ".research"), { recursive: true });
    fs.writeFileSync(path.join(badDir, ".research", "run.json"), "not json{{}", "utf-8");

    const { entries, malformed } = listWorkspaces(tmpDir);
    expect(entries.length).toBe(1);
    expect(malformed.length).toBe(1);
    expect(malformed[0].path).toBe(path.join(tmpDir, "bad-workspace"));
  });

  it("does not abort listing when encountering malformed workspaces", () => {
    buildWorkspace(tmpDir, "valid-1", "valid 1", "run-1", "tr-1");
    buildWorkspace(tmpDir, "valid-2", "valid 2", "run-2", "tr-2");
    buildWorkspace(tmpDir, "valid-3", "valid 3", "run-3", "tr-3");
    // Multiple malformed
    fs.mkdirSync(path.join(tmpDir, "bad-1"));
    fs.mkdirSync(path.join(tmpDir, "bad-2"));

    const { entries, malformed } = listWorkspaces(tmpDir);
    expect(entries.length).toBe(3); // All valid ones found
    expect(malformed.length).toBe(2); // Both malformed reported
  });

  it("includes lifecycle status in entries", () => {
    buildWorkspace(tmpDir, "paused-ws", "paused ws", "run-1", "tr-1", "standard", "paused");
    buildWorkspace(tmpDir, "abandoned-ws", "abandoned ws", "run-2", "tr-2");
    markAbandoned({ path: path.join(tmpDir, "abandoned-ws"), projectRoot: tmpDir, mission: "abandoned", runId: "run-2", transitionId: "tr-2" } as Workspace, "user cancel");

    const { entries } = listWorkspaces(tmpDir);
    expect(entries.length).toBe(2);
    const paused = entries.find((e) => e.mission === "paused ws");
    const abandoned = entries.find((e) => e.mission === "abandoned ws");
    expect(paused!.status).toBe("paused");
    expect(abandoned!.status).toBe("abandoned");
  });

  it("entries have correct field types", () => {
    buildWorkspace(tmpDir, "typed-ws", "typed", "run-123", "tr-abc", "quick");
    const { entries } = listWorkspaces(tmpDir);
    const entry = entries[0];
    expect(entry.path).toBe(path.join(tmpDir, "typed-ws"));
    expect(entry.runId).toBe("run-123");
    expect(entry.mission).toBe("typed");
    expect(entry.status).toBe("active");
    expect(entry.reason).toBeNull();
    expect(typeof entry.createdAt).toBe("number");
    expect(typeof entry.updatedAt).toBe("number");
    // transitionId is derived from runId when not explicitly stored
    expect(entry.transitionId).toBeTruthy();
    expect(entry.isMalformed).toBe(false);
    expect(entry.malformedReason).toBeNull();
  });

  it("discovers workspaces from legacy state only (no lifecycle file)", () => {
    buildWorkspace(tmpDir, "legacy-ws", "legacy", "run-1", "tr-1", "standard", undefined);
    // No lifecycle file — should read from run-state.json
    const { entries } = listWorkspaces(tmpDir);
    expect(entries.length).toBe(1);
    expect(entries[0].status).toBe("active");
  });
});

// ===========================================================================
// /research status — single workspace lookup
// ===========================================================================

describe("/research status — workspace lookup", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it("looks up workspace by exact name", () => {
    buildWorkspace(tmpDir, "exact-name", "exact", "run-1", "tr-1");
    const entry = lookupWorkspace(tmpDir, "exact-name");
    expect(entry).not.toBeNull();
    expect(entry!.path).toBe(path.join(tmpDir, "exact-name"));
    expect(entry!.mission).toBe("exact");
  });

  it("returns null for non-existent workspace", () => {
    expect(lookupWorkspace(tmpDir, "nonexistent")).toBeNull();
  });

  it("looks up workspace by absolute path", () => {
    buildWorkspace(tmpDir, "abs-test", "absolute", "run-1", "tr-1");
    const entry = lookupWorkspace(tmpDir, path.join(tmpDir, "abs-test"));
    expect(entry).not.toBeNull();
    expect(entry!.mission).toBe("absolute");
  });
});

// ===========================================================================
// /research pause — lifecycle pause
// ===========================================================================

describe("/research pause — lifecycle pause", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it("pauses the active lifecycle", () => {
    const ws = buildWorkspace(tmpDir, "pause-active", "pause", "run-1", "tr-1", "standard", "active");
    const result = pauseLifecycle(ws, "test pause");
    expect(result.current).toBe("paused");
    expect(result.reason).toBe("test pause");
  });
});

// ===========================================================================
// /research clear — lifecycle abandonment
// ===========================================================================

describe("/research clear — lifecycle abandonment", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it("abandons the workspace without deleting artifacts", () => {
    const ws = buildWorkspace(tmpDir, "clear-ws", "clear", "run-1", "tr-1");
    const result = markAbandoned(ws, "user clear");
    expect(result.current).toBe("abandoned");

    // Verify artifacts still exist
    expect(fs.existsSync(path.join(ws.path, ".research", "run.json"))).toBe(true);
    expect(fs.existsSync(path.join(ws.path, ".research", "run-state.json"))).toBe(true);
  });

  it("replaces a workspace lifecycle", () => {
    const ws = buildWorkspace(tmpDir, "replace-ws", "replace", "run-1", "tr-1");
    const result = markReplaced(ws, "new run");
    expect(result.current).toBe("replaced");

    // Verify artifacts still exist
    expect(fs.existsSync(path.join(ws.path, ".research", "run.json"))).toBe(true);
  });
});

// ===========================================================================
// /research resume — transition from paused/failed back to active
// ===========================================================================

describe("/research resume — lifecycle resume", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = createTempDir();
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it("resumes from paused state", () => {
    const ws = buildWorkspace(tmpDir, "resume-paused", "resume", "run-1", "tr-1", "standard", "paused");
    const result = markResumed(ws, "resume from pause");
    expect(result.current).toBe("active");
  });

  it("resumes from failed state", () => {
    const ws = buildWorkspace(tmpDir, "resume-failed", "resume", "run-1", "tr-1", "standard", "failed");
    const result = markResumed(ws, "resume from failed");
    expect(result.current).toBe("active");
  });

  it("throws when not in resumable state (complete)", () => {
    const ws = buildWorkspace(tmpDir, "resume-complete", "resume", "run-1", "tr-1", "standard", "complete");
    expect(() => markResumed(ws)).toThrow(/Cannot resume/);
  });

  it("throws when not in resumable state (replaced)", () => {
    const ws = buildWorkspace(tmpDir, "resume-replaced", "resume", "run-1", "tr-1", "standard", "replaced");
    expect(() => markResumed(ws)).toThrow(/Cannot resume/);
  });

  it("throws when not in resumable state (abandoned)", () => {
    const ws = buildWorkspace(tmpDir, "resume-abandoned", "resume", "run-1", "tr-1", "standard", "abandoned");
    expect(() => markResumed(ws)).toThrow(/Cannot resume/);
  });

  it("throws when no lifecycle exists", () => {
    const ws = buildWorkspace(tmpDir, "resume-no-lifecycle", "resume", "run-1", "tr-1", "standard", "active");
    // Remove lifecycle file
    fs.unlinkSync(path.join(ws.path, ".research", "lifecycle.json"));
    expect(() => markResumed(ws)).toThrow(/No lifecycle found/);
  });
});

// ===========================================================================
// getActiveWorkspace — transitions pointer lookup
// ===========================================================================

describe("getActiveWorkspace", () => {
  let tmpDir: string;
  let transitionsPath: string;

  beforeEach(() => {
    tmpDir = createTempDir();
    transitionsPath = path.join(tmpDir, TRANSITION_FILE);
  });

  afterEach(() => {
    cleanup(tmpDir);
  });

  it("returns the active workspace from transitions pointer", () => {
    buildWorkspace(tmpDir, "active-ws", "active", "run-1", "tr-1");
    const tf = new TransitionsFile(transitionsPath);
    tf.setPointer("run-1", "tr-1");

    const active = getActiveWorkspace(tmpDir, transitionsPath);
    expect(active).not.toBeNull();
    expect(active!.path).toBe(path.join(tmpDir, "active-ws"));
  });

  it("returns null when no transitions pointer", () => {
    buildWorkspace(tmpDir, "no-pointer", "no-pointer", "run-1", "tr-1");
    // No pointer set

    const active = getActiveWorkspace(tmpDir, transitionsPath);
    expect(active).toBeNull();
  });

  it("falls back to first active workspace when pointer points to nothing", () => {
    buildWorkspace(tmpDir, "fallback-ws", "fallback", "run-1", "tr-1", "standard", "active");
    buildWorkspace(tmpDir, "paused-ws", "paused", "run-2", "tr-2", "standard", "paused");
    const tf = new TransitionsFile(transitionsPath);
    tf.setPointer("run-nonexistent", "tr-nonexistent");

    const active = getActiveWorkspace(tmpDir, transitionsPath);
    // Should fall back to the first active workspace
    expect(active).not.toBeNull();
    expect(active!.path).toBe(path.join(tmpDir, "fallback-ws"));
  });
});
