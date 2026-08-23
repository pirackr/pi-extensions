import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import type { Workspace } from "./workspace.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RunManifest {
	/** Run identifier. */
	runId: string;
	/** Human-readable mission statement. */
	mission: string;
	/** Absolute path to workspace (always the final path, never staging). */
	workspace: string;
	/** Absolute path to run.json. */
	manifestPath: string;
	/** Epoch milliseconds at creation. */
	createdAt: number;
	/** SHA-256 hex digest of initial snapshot content, or null. */
	snapshotSha256: string | null;
	/**
	 * Frozen activation-time run contract snapshot ({@link ResolvedRunContract}).
	 * Persisted so resume can reuse the exact contract without re-resolving
	 * roles or re-reading mutable prompt sources. Optional for backward
	 * compatibility with manifests written before snapshots were persisted.
	 */
	resolvedContract?: unknown;
	/**
	 * Frozen activation-time policy configuration snapshot
	 * ({@link FrozenConfig}). Persisted so resume can claim policy using the
	 * identical snapshot activation published. Optional for backward
	 * compatibility.
	 */
	frozenConfig?: unknown;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function manifestFilePath(ws: Workspace): string {
	return path.join(ws.path, ".research", "run.json");
}

function snapshotSha256(content: string | undefined): string | null {
	if (!content) return null;
	return createHash("sha256").update(content).digest("hex");
}

function cloneSnapshot<T>(value: T | undefined): T | undefined {
	return value === undefined
		? undefined
		: JSON.parse(JSON.stringify(value)) as T;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Exclusively create an immutable `run.json` manifest inside the workspace's
 * `.research/` directory.
 *
 * Manifest paths always name the eventual final workspace, never a hidden
 * staging path.  Throws if the manifest already exists (immutable contract).
 *
 * The frozen activation-time run contract ({@link resolvedContract}) and the
 * frozen policy configuration ({@link frozenConfig}) are persisted alongside
 * the run identity so resume can reuse the exact activation-time snapshots
 * instead of re-resolving roles or re-reading mutable prompt sources.
 */
export function createRunManifest(
	ws: Workspace,
	snapshotContent?: string,
	resolvedContract?: unknown,
	frozenConfig?: unknown,
): RunManifest {
	const manifestPath = manifestFilePath(ws);

	// Exclusively create — throw if already exists
	if (fs.existsSync(manifestPath)) {
		throw new Error(`Manifest already exists at ${manifestPath}`);
	}

	const manifest: RunManifest = {
		runId: ws.runId,
		mission: ws.mission,
		workspace: ws.path, // final path, never staging
		manifestPath,
		createdAt: Date.now(),
		snapshotSha256: snapshotSha256(snapshotContent),
		resolvedContract: cloneSnapshot(resolvedContract),
		frozenConfig: cloneSnapshot(frozenConfig),
	};

	fs.writeFileSync(
		manifestPath,
		JSON.stringify(manifest, null, 2),
		"utf-8",
	);

	return manifest;
}

/**
 * Read and parse an existing manifest.  Throws if not found.
 */
export function readManifest(ws: Workspace): RunManifest {
	const manifestPath = manifestFilePath(ws);
	const raw = fs.readFileSync(manifestPath, "utf-8");
	return JSON.parse(raw) as RunManifest;
}

/**
 * Verify a manifest's snapshot SHA-256 against current content.
 * Returns true if the snapshot matches (integrity check).
 */
export function verifySnapshotIntegrity(
	ws: Workspace,
	content: string,
): boolean {
	const manifest = readManifest(ws);
	if (!manifest.snapshotSha256) return true; // no snapshot to verify
	return snapshotSha256(content) === manifest.snapshotSha256;
}
