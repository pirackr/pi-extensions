import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Workspace {
	/** Absolute path to the workspace directory. */
	path: string;
	/** Absolute path to the project root. */
	projectRoot: string;
	/** Human-readable mission statement. */
	mission: string;
	/** Unique run identifier. */
	runId: string;
	/** Transition identifier used for recovery. */
	transitionId: string;
}

export interface WorkspaceClaim {
	/** The eventual workspace directory name (not hidden). */
	finalDir: string;
	/** Hidden claim directory path (same-parent as finalDir). */
	claimPath: string;
	/** Transition identifier. */
	transitionId: string;
}

export interface StagedRun {
	/** Hidden staging directory path. */
	stagingPath: string;
	/** Final workspace directory name. */
	finalDir: string;
	/** Project root. */
	projectRoot: string;
	/** Transition identifier. */
	transitionId: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Derive a short URL-friendly slug from a mission string. */
export function slugify(mission: string): string {
	return (
		mission
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 30) || "research"
	);
}

/** Generate a unique run ID. */
export function generateRunId(): string {
	return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * Format the canonical run ID for a transition + final workspace dir.
 *
 * Single source of truth for run identity: the contract's runId, the
 * workspace runId, the state runId, the manifest runId, and the loop id
 * must all be `${transitionId}-${finalDir}` so resume and the completion
 * gates can compare them.
 */
export function formatRunId(transitionId: string, finalDir: string): string {
	return `${transitionId}-${finalDir}`;
}

// ---------------------------------------------------------------------------
// Claim management
// ---------------------------------------------------------------------------

/**
 * Acquire an exclusive workspace claim.
 *
 * Selects `<slug>`, then `-2`, `-3` by exclusively creating a hidden
 * same-parent claim directory like `.claim-<slug>-<transitionId>` using
 * non-recursive `mkdir`.  The claim reserves a final path without creating
 * that path.  A collision retries the next suffix; all suffixes exhausted
 * throws.
 */
export function acquireWorkspaceClaim(
	projectRoot: string,
	mission: string,
	transitionId: string,
): WorkspaceClaim {
	if (!fs.existsSync(projectRoot)) {
		throw new Error(`Project root does not exist: ${projectRoot}`);
	}

	const s = slugify(mission);
	const suffixes: Array<string | undefined> = [undefined, "-2", "-3"];

	// Scan existing claims to find used finalDirs (across all transition IDs)
	const usedFinalDirs = new Set<string>();
	try {
		const entries = fs.readdirSync(projectRoot, { withFileTypes: true });
		for (const entry of entries) {
			if (entry.isDirectory() && entry.name.startsWith(".claim-")) {
				const metaPath = path.join(projectRoot, entry.name, ".meta.json");
				if (fs.existsSync(metaPath)) {
					try {
						const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as {
							finalDir: string;
						};
						usedFinalDirs.add(meta.finalDir);
					} catch {
						// Skip broken metadata
					}
				}
			}
		}
	} catch {
		// Directory unreadable — fall through
	}

	for (const suffix of suffixes) {
		const finalDir = suffix ? `${s}${suffix}` : s;
		// Skip if another claim already reserves this finalDir
		if (usedFinalDirs.has(finalDir)) {
			continue;
		}
		// Skip if the final path already exists on disk (e.g. a prior completed
		// run whose claim was cleaned up, leaving the visible directory behind).
		if (fs.existsSync(path.join(projectRoot, finalDir))) {
			continue;
		}

		const claimPath = path.join(
			projectRoot,
			`.claim-${finalDir}-${transitionId}`,
		);

		try {
			// Non-recursive mkdir for exclusive creation (EEXIST = collision)
			fs.mkdirSync(claimPath, { recursive: false });
			// Persist metadata for recovery
			const metaPath = path.join(claimPath, ".meta.json");
			fs.writeFileSync(
				metaPath,
				JSON.stringify({ mission, finalDir, transitionId }),
				"utf-8",
			);
			return { finalDir, claimPath, transitionId };
		} catch (err: unknown) {
			if (
				err &&
				typeof err === "object" &&
				"code" in err &&
				(err as { code: string }).code === "EEXIST"
			) {
				continue; // try next suffix
			}
			throw err;
		}
	}

	throw new Error(
		`Could not acquire workspace claim for mission: "${mission}" — all suffixes taken`,
	);
}

// ---------------------------------------------------------------------------
// Staging
// ---------------------------------------------------------------------------

/**
 * Prepare a staging directory for the claimed final path.
 *
 * Creates a hidden staging directory `.staging-<finalDir>` alongside the
 * claim dir.  Callers populate this directory, then call `commitStaging`.
 */
export function prepareStaging(claim: WorkspaceClaim): StagedRun {
	const stagingPath = path.join(
		path.dirname(claim.claimPath),
		`.staging-${claim.finalDir}`,
	);

	fs.mkdirSync(stagingPath, { recursive: false });

	return {
		stagingPath,
		finalDir: claim.finalDir,
		projectRoot: path.dirname(claim.claimPath),
		transitionId: claim.transitionId,
	};
}

/**
 * Commit a staged run: verify target absent, rename staging → final,
 * clean up claim, create .research/ directory, return Workspace.
 *
 * If the target already exists (collision), quarantines the claim and
 * throws so the caller can retry with a new suffix.
 */
export function commitStaging(
	staged: StagedRun,
	claim: WorkspaceClaim,
): Workspace {
	const finalPath = path.join(staged.projectRoot, staged.finalDir);

	// Verify target is still absent (race-condition guard)
	if (fs.existsSync(finalPath)) {
		// Collision — quarantine claim and clean up staging
		quarantineClaim(claim);
		if (fs.existsSync(staged.stagingPath)) {
			fs.rmSync(staged.stagingPath, { recursive: true, force: true });
		}
		throw new Error(`Workspace target appeared before commit: ${finalPath}`);
	}

	// Atomic rename: staging → final (same-parent, same filesystem)
	fs.renameSync(staged.stagingPath, finalPath);

	// Read mission from claim metadata for the returned Workspace
	const metaPath = path.join(claim.claimPath, ".meta.json");
	let mission = "";
	if (fs.existsSync(metaPath)) {
		const meta = JSON.parse(fs.readFileSync(metaPath, "utf-8")) as {
			mission: string;
		};
		mission = meta.mission ?? "";
	}

	// Clean up claim directory
	fs.rmSync(claim.claimPath, { recursive: true, force: true });

	// Ensure .research/ directory exists for state files
	const researchPath = path.join(finalPath, ".research");
	if (!fs.existsSync(researchPath)) {
		fs.mkdirSync(researchPath, { recursive: false });
	}

	const runId = formatRunId(staged.transitionId, staged.finalDir);

	return {
		path: finalPath,
		projectRoot: staged.projectRoot,
		mission,
		runId,
		transitionId: staged.transitionId,
	};
}

// ---------------------------------------------------------------------------
// Quarantine / recovery helpers
// ---------------------------------------------------------------------------

/** Move a claim dir to `.quarantine-<original>` (best-effort). */
function quarantineClaim(claim: WorkspaceClaim): void {
	try {
		if (!fs.existsSync(claim.claimPath)) return;
		const quarantinePath = claim.claimPath.replace(".claim-", ".quarantine-");
		fs.renameSync(claim.claimPath, quarantinePath);
	} catch {
		// Best-effort quarantine — ignore errors
	}
}

/**
 * Reconcile an interrupted transition by its transition ID.
 *
 * Returns the appropriate action:
 * - `"clean"` — nothing to do (or already complete)
 * - `"rollback"` — remove stale claim/staging (transition was interrupted)
 * - `"resume"` — staging exists, caller should rename → final
 */
export function reconcileTransition(
	projectRoot: string,
	transitionId: string,
	finalDir: string,
): {
	status: "clean" | "rollback" | "resume";
	claimPath?: string;
	stagingPath?: string;
} {
	const claimPath = path.join(
		projectRoot,
		`.claim-${finalDir}-${transitionId}`,
	);
	const stagingPath = path.join(projectRoot, `.staging-${finalDir}`);
	const finalPath = path.join(projectRoot, finalDir);

	if (fs.existsSync(finalPath)) {
		// Already complete — clean up leftover claim/staging
		if (fs.existsSync(claimPath)) {
			fs.rmSync(claimPath, { recursive: true, force: true });
		}
		if (fs.existsSync(stagingPath)) {
			fs.rmSync(stagingPath, { recursive: true, force: true });
		}
		return { status: "clean" };
	}

	if (fs.existsSync(claimPath)) {
		if (fs.existsSync(stagingPath)) {
			// Staging is ready to be renamed to final
			return { status: "resume", claimPath, stagingPath };
		}
		// Stale claim with no staging — rollback
		fs.rmSync(claimPath, { recursive: true, force: true });
		return { status: "rollback", claimPath };
	}

	if (fs.existsSync(stagingPath)) {
		// Orphaned staging — clean up
		fs.rmSync(stagingPath, { recursive: true, force: true });
		return { status: "rollback" };
	}

	return { status: "clean" };
}

// ---------------------------------------------------------------------------
// Git exclusion
// ---------------------------------------------------------------------------

/**
 * Idempotently add `/.research/` to the Git-resolved repository root's
 * `.gitignore`.  No-op outside Git.
 */
export function ensureGitExclude(projectRoot: string): void {
	let dir = projectRoot;
	let gitRoot: string | null = null;

	// Walk up to find the git root
	while (dir !== path.parse(dir).root) {
		if (fs.existsSync(path.join(dir, ".git"))) {
			gitRoot = dir;
			break;
		}
		dir = path.dirname(dir);
	}

	if (!gitRoot) {
		// Not in a Git repository — no-op
		return;
	}

	const gitignorePath = path.join(gitRoot, ".gitignore");
	const exclusionEntry = ".research/";

	if (fs.existsSync(gitignorePath)) {
		const content = fs.readFileSync(gitignorePath, "utf-8");
		// Idempotent: skip if already present
		if (content.includes(exclusionEntry)) {
			return;
		}
	}

	// Append entry
	fs.appendFileSync(gitignorePath, `\n${exclusionEntry}`, "utf-8");
}

// ---------------------------------------------------------------------------
// Hidden-entry discovery
// ---------------------------------------------------------------------------

/**
 * List entries in a directory, excluding hidden (dot-prefixed) entries.
 * Useful for discovery that should ignore claim/staging dirs.
 */
export function discoverVisibleEntries(dir: string): string[] {
	if (!fs.existsSync(dir)) {
		return [];
	}
	return fs.readdirSync(dir).filter((entry) => !entry.startsWith("."));
}
