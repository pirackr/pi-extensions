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

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Exclusively create an immutable `run.json` manifest inside the workspace's
 * `.research/` directory.
 *
 * Manifest paths always name the eventual final workspace, never a hidden
 * staging path.  Throws if the manifest already exists (immutable contract).
 */
export function createRunManifest(
	ws: Workspace,
	snapshotContent?: string,
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
