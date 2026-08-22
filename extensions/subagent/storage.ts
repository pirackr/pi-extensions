// Secure durable artifact storage for the `subagent` extension.
//
// {@link ArtifactStore} owns the exact `/tmp` layout described in the design
// spec:
//
// ```
// /tmp/<project-slug>/pi-a7k2/
// ├── parent.json
// ├── groups/<group-id>.json
// └── subagents/q9xm/
//     ├── request.json
//     ├── profile.json
//     ├── status.json
//     ├── result.json
//     ├── delivery.json
//     ├── events.jsonl
//     ├── stderr.log
//     ├── transcript.log
//     └── control/
// ```
//
// Every write is an atomic temp-file-plus-fsync-plus-rename inside the
// destination directory; every directory is `0700` and every file `0600`; and
// existing symlinks or unexpected file types are rejected rather than
// followed. Completed artifacts are never cleaned up — `publishTerminal`
// writes the terminal result before the terminal status and flushes the
// append-only logs, but it does not delete anything.
//
// This module is deliberately owner-neutral: it stores generic manifests,
// results, and delivery records and never interprets an owner's policy.

import {
	mkdir,
	open,
	rename,
	chmod,
	readFile,
	lstat,
	readdir,
	type FileHandle,
} from "node:fs/promises";
import { dirname, join } from "node:path";

import {
	AgentManifest,
	DeliveryRecord,
	TaskStatus,
	TerminalResult,
	isShortId,
} from "./types.ts";
import {
	CANCEL_MARKER,
	CONTROL_DIR,
	DELIVERY_FILE,
	EVENTS_LOG,
	FILE_MODE,
	GROUPS_DIR,
	PROFILE_FILE,
	RESULT_FILE,
	REQUEST_FILE,
	STATUS_FILE,
	STDERR_LOG,
	SUBAGENTS_DIR,
	TRANSCRIPT_LOG,
	ParentIdentity,
	DIR_MODE,
} from "./identity.ts";

/**
 * Injectable dependencies for {@link createArtifactStore}. Every side effect is
 * injectable so ordering, modes, and security can be verified deterministically
 * without racing a live filesystem.
 */
export interface ArtifactStoreDeps {
	/** Monotonic-ish clock; defaults to `Date.now`. */
	now?: () => number;
	/** Records every atomic destination write, in order, for ordering tests. */
	recordWrites?: Array<{ op: string; path: string }>;
}

/**
 * A partial, runtime status update merged into an existing manifest. Only the
 * fields supplied are changed; the rest of the durable manifest is preserved.
 */
export interface StatusUpdate {
	readonly agentId: string;
	/** Optional explicit revision; defaults to stored revision + 1 (monotonic). */
	readonly revision?: number;
	readonly state?: TaskStatus;
	readonly startedAt?: number | null;
	readonly heartbeatAt?: number | null;
	readonly finishedAt?: number | null;
	readonly runnerPid?: number | null;
	readonly tmuxWindow?: string | null;
	readonly terminalReason?: string | null;
	readonly sequence?: number;
}

/**
 * The durable artifact store for one parent. All paths are derived from the
 * resolved {@link ParentIdentity}; there is one store per parent process.
 */
export interface ArtifactStore {
	/** The parent identity this store writes beneath. */
	readonly identity: ParentIdentity;
	/** The injectable `/tmp` root. */
	readonly tmpRoot: string;
	/** The sanitized project slug. */
	readonly projectSlug: string;
	/** The durable artifact root this parent owns. */
	readonly artifactRoot: string;

	/** Create the parent root layout: `parent.json`, `subagents/`, `groups/`. */
	initializeParent(): Promise<void>;

	/**
	 * Create a subagent workspace, write its `request.json`, `profile.json`,
	 * and an initial `queued` `status.json` manifest, and return the agent id.
	 *
	 * @throws when the id is not a valid four-character identifier, when the
	 *   workspace path already exists (including as a symlink), or when an
	 *   intermediate path component is not a real directory.
	 */
	enqueue(manifest: AgentManifest, runnerRequest: Record<string, unknown>): Promise<string>;

	/**
	 * List durable queue manifests — every queued task under this parent —
	 * ordered by ascending FIFO sequence. Symlinked or non-directory entries
	 * are rejected, never followed.
	 */
	scan(): Promise<AgentManifest[]>;

	/** Read a task's durable manifest, or `null` when it does not exist. */
	readTask(agentId: string): Promise<AgentManifest | null>;

	/**
	 * Atomically publish a complete manifest snapshot. The revision must be
	 * strictly greater than the currently stored revision, enforcing monotonic
	 * durable revisions.
	 */
	writeStatus(update: StatusUpdate): Promise<AgentManifest>;

	/**
	 * Publish a terminal result and then the terminal status. Writes
	 * `result.json` before `status.json` (making terminal status the commit
	 * marker), flushes the append-only logs, and never removes completed
	 * artifacts.
	 */
	publishTerminal(agentId: string, result: TerminalResult): Promise<void>;

	/** Write a cancellation marker under the task's `control/` workspace. */
	requestCancellation(agentId: string): Promise<boolean>;

	/** Read a task's durable delivery record, or `null` when absent. */
	readDelivery(agentId: string): Promise<DeliveryRecord | null>;

	/**
	 * Merge a partial delivery update into the task's delivery record and
	 * persist it atomically. Creates a fresh `pending` record when none
	 * exists.
	 */
	updateDelivery(agentId: string, update: Partial<DeliveryRecord>): Promise<DeliveryRecord>;
}

/**
 * Build an {@link ArtifactStore} bound to a resolved {@link ParentIdentity}.
 */
export function createArtifactStore(
	identity: ParentIdentity,
	deps?: ArtifactStoreDeps,
): ArtifactStore {
	const now = deps?.now ?? Date.now;
	const recordWrites = deps?.recordWrites;

	const subagentsRoot = join(identity.artifactRoot, SUBAGENTS_DIR);
	const groupsRoot = join(identity.artifactRoot, GROUPS_DIR);
	const workspace = (agentId: string) => join(subagentsRoot, agentId);
	const statusPath = (agentId: string) => join(workspace(agentId), STATUS_FILE);
	const controlCancelPath = (agentId: string) =>
		join(workspace(agentId), CONTROL_DIR, CANCEL_MARKER);

	/**
	 * Ensure every component of `target` between `base` and the target is an
	 * existing real directory (not a symlink, not a regular file). Components
	 * that do not yet exist are left alone; the caller creates the leaf.
	 *
	 * @throws when an existing component is a symlink or an unexpected type.
	 */
	async function assertRealDirChain(base: string, target: string): Promise<void> {
		const rel = target.slice(base.length);
		const parts = rel.split("/").filter((p) => p.length > 0);
		let cursor = base;
		for (const part of parts) {
			cursor = join(cursor, part);
			let info;
			try {
				info = await lstat(cursor);
			} catch {
				return; // created later by the caller
			}
			if (info.isSymbolicLink()) {
				throw new Error(`refusing to follow symlink: ${cursor}`);
			}
			if (!info.isDirectory()) {
				throw new Error(`unexpected non-directory at ${cursor}`);
			}
		}
	}

	/**
	 * Create-or-verify a durable directory as a real `0700` directory. When
	 * `exclusive` is set the target must not already exist.
	 *
	 * @throws when any existing path component is a symlink or non-directory,
	 *   when the target is a symlink or non-directory, or when `exclusive` is
	 *   set and the target already exists.
	 */
	async function ensureDir(target: string, exclusive = false): Promise<void> {
		const base = dirname(target);
		await assertRealDirChain(base, target);
		let info;
		try {
			info = await lstat(target);
		} catch {
			info = undefined;
		}
		if (info === undefined) {
			await mkdir(target, { recursive: true });
			// mkdir is masked by umask; force 0700 on every newly created
			// component so the whole durable tree is owner-only.
			let cursor = base;
			for (const part of target
				.slice(base.length)
				.split("/")
				.filter((p) => p.length > 0)) {
				cursor = join(cursor, part);
				await chmod(cursor, DIR_MODE);
			}
		} else if (info.isSymbolicLink() || !info.isDirectory()) {
			if (info.isSymbolicLink()) {
				throw new Error(`refusing to use symlink: ${target}`);
			}
			throw new Error(`unexpected non-directory at ${target}`);
		} else if (exclusive) {
			throw new Error(`path already exists: ${target}`);
		} else {
			await chmod(target, DIR_MODE);
		}
	}

	/**
	 * Atomically write `value` as pretty-printed JSON to `filePath`: a temp
	 * file in the destination directory is written and fsync'd, then renamed
	 * into place and chmod'd to `0600`, and finally the destination directory
	 * is fsync'd so the rename is durable.
	 */
	async function atomicWriteJson(
		filePath: string,
		value: unknown,
	): Promise<void> {
		const dir = dirname(filePath);
		const tmp = join(dir, `.${basenameOf(filePath)}.tmp.${process.pid}.${Math.random()
			.toString(36)
			.slice(2)}`);

		const handle = await open(tmp, "w", FILE_MODE);
		try {
			await handle.write(Buffer.from(`${JSON.stringify(value, null, 2)}\n`));
			await handle.sync();
		} finally {
			await handle.close();
		}

		await rename(tmp, filePath);
		await chmod(filePath, FILE_MODE);
		recordWrites?.push({ op: "write", path: filePath });
		await fsyncDir(dir);
	}

	/**
	 * Read and parse a JSON file, rejecting symlinks and non-files.
	 *
	 * @returns `null` when the file does not exist.
	 * @throws on a symlink or an unexpected file type.
	 */
	async function readJsonSecure<T>(filePath: string): Promise<T | null> {
		let info;
		try {
			info = await lstat(filePath);
		} catch {
			return null;
		}
		if (info.isSymbolicLink()) {
			throw new Error(`refusing to read through symlink: ${filePath}`);
		}
		if (!info.isFile()) {
			throw new Error(`unexpected non-file at ${filePath}`);
		}
		const text = await readFile(filePath, "utf8");
		return JSON.parse(text) as T;
	}

	/** Best-effort fsync of a directory so a preceding rename is durable. */
	async function fsyncDir(dir: string): Promise<void> {
		let dirHandle: FileHandle | undefined;
		try {
			dirHandle = await open(dir, "r");
			await dirHandle.sync();
		} catch {
			// Directory fsync is not guaranteed on every platform; the rename
			// itself is atomic, so this stays best-effort.
		} finally {
			await dirHandle?.close().catch(() => undefined);
		}
	}

	async function flushLogs(agentId: string): Promise<void> {
		const logs = [
			join(workspace(agentId), EVENTS_LOG),
			join(workspace(agentId), STDERR_LOG),
			join(workspace(agentId), TRANSCRIPT_LOG),
		];
		for (const log of logs) {
			let info;
			try {
				info = await lstat(log);
			} catch {
				continue;
			}
			if (!info.isFile() || info.isSymbolicLink()) continue;
			let handle: FileHandle | undefined;
			try {
				handle = await open(log, "r");
				await handle.sync();
			} catch {
				// best-effort flush of an existing log
			} finally {
				await handle?.close().catch(() => undefined);
			}
		}
	}

	return Object.freeze({
		identity,
		tmpRoot: identity.tmpRoot,
		projectSlug: identity.projectSlug,
		artifactRoot: identity.artifactRoot,

		async initializeParent(): Promise<void> {
			await ensureDir(identity.artifactRoot, true);
			await ensureDir(subagentsRoot, true);
			await ensureDir(groupsRoot, true);
			await atomicWriteJson(join(identity.artifactRoot, "parent.json"), {
				id: identity.id,
				tmuxSession: identity.tmuxSession,
				tmpRoot: identity.tmpRoot,
				projectSlug: identity.projectSlug,
				createdAt: now(),
			});
		},

		async enqueue(
			manifest: AgentManifest,
			runnerRequest: Record<string, unknown>,
		): Promise<string> {
			if (typeof manifest.agentId !== "string" || !isShortId(manifest.agentId)) {
				throw new Error(
					`invalid agent id for enqueue: ${String(manifest.agentId)}`,
				);
			}
			const dir = workspace(manifest.agentId);
			await ensureDir(dir, true);
			await atomicWriteJson(join(dir, REQUEST_FILE), runnerRequest);
			await atomicWriteJson(join(dir, PROFILE_FILE), manifest.profile);
			await atomicWriteJson(join(dir, STATUS_FILE), manifest);
			return manifest.agentId;
		},

		async scan(): Promise<AgentManifest[]> {
			let entries: string[];
			try {
				entries = await readdir(subagentsRoot);
			} catch {
				return [];
			}
			const manifests: AgentManifest[] = [];
			for (const entry of entries) {
				if (!isShortId(entry)) continue;
				const info = await lstat(join(subagentsRoot, entry));
				if (info.isSymbolicLink()) {
					throw new Error(
						`refusing to follow symlink in scan: ${join(subagentsRoot, entry)}`,
					);
				}
				if (!info.isDirectory()) {
					throw new Error(
						`unexpected non-directory in scan: ${join(subagentsRoot, entry)}`,
					);
				}
				const manifest = await readJsonSecure<AgentManifest>(
					join(subagentsRoot, entry, STATUS_FILE),
				);
				if (manifest === null || manifest.state !== "queued") continue;
				manifests.push(manifest);
			}
			return manifests.sort((a, b) => a.sequence - b.sequence);
		},

		async readTask(agentId: string): Promise<AgentManifest | null> {
			if (!isShortId(agentId)) return null;
			return readJsonSecure<AgentManifest>(statusPath(agentId));
		},

		async writeStatus(update: StatusUpdate): Promise<AgentManifest> {
			if (!isShortId(update.agentId)) {
				throw new Error(`invalid agent id for writeStatus: ${String(update.agentId)}`);
			}
			const existing = await readJsonSecure<AgentManifest>(
				statusPath(update.agentId),
			);
			if (existing === null) {
				throw new Error(`no status to update: ${update.agentId}`);
			}
			if (update.revision !== undefined && update.revision <= existing.revision) {
				throw new Error(
					`revision must increase: stored ${existing.revision}, got ${update.revision}`,
				);
			}
			const merged: AgentManifest = {
				...existing,
				...update,
				revision: update.revision ?? existing.revision + 1,
			};
			await atomicWriteJson(statusPath(update.agentId), merged);
			return merged;
		},

		async publishTerminal(agentId: string, result: TerminalResult): Promise<void> {
			if (!isShortId(agentId)) {
				throw new Error(`invalid agent id for publishTerminal: ${String(agentId)}`);
			}
			const existing = await readJsonSecure<AgentManifest>(
				statusPath(agentId),
			);
			if (existing === null) {
				throw new Error(`no status to settle: ${agentId}`);
			}
			// Flush append-only logs before terminal publication.
			await flushLogs(agentId);

			const resultPath = join(workspace(agentId), RESULT_FILE);
			await atomicWriteJson(resultPath, {
				agentId,
				state: result.state,
				output: result.output,
				usage: result.usage,
				finishedAt: result.finishedAt,
				terminalReason: result.terminalReason,
			});

			await atomicWriteJson(statusPath(agentId), {
				...existing,
				state: result.state,
				finishedAt: result.finishedAt,
				terminalReason: result.terminalReason,
				revision: existing.revision + 1,
			});
		},

		async requestCancellation(agentId: string): Promise<boolean> {
			if (!isShortId(agentId)) return false;
			await ensureDir(join(workspace(agentId), CONTROL_DIR), true);
			await atomicWriteJson(controlCancelPath(agentId), {
				agentId,
				requestedAt: now(),
			});
			return true;
		},

		async readDelivery(agentId: string): Promise<DeliveryRecord | null> {
			if (!isShortId(agentId)) return null;
			return readJsonSecure<DeliveryRecord>(
				join(workspace(agentId), DELIVERY_FILE),
			);
		},

		async updateDelivery(
			agentId: string,
			update: Partial<DeliveryRecord>,
		): Promise<DeliveryRecord> {
			if (!isShortId(agentId)) {
				throw new Error(`invalid agent id for delivery: ${String(agentId)}`);
			}
			const existing = await readJsonSecure<DeliveryRecord>(
				join(workspace(agentId), DELIVERY_FILE),
			);
			const merged: DeliveryRecord = {
				...(existing ?? {
					groupId: "",
					agentIds: [agentId],
					state: "pending",
					notificationId: "",
					createdAt: now(),
					dispatchedAt: null,
					consumedAt: null,
				}),
				...update,
			};
			await atomicWriteJson(
				join(workspace(agentId), DELIVERY_FILE),
				merged,
			);
			return merged;
		},
	});
}

/**
 * @internal Basename without importing `node:path`'s `basename` at every call
 * site — kept local to avoid an extra import in runner-facing call paths.
 */
function basenameOf(destination: string): string {
	const slash = destination.lastIndexOf("/");
	return slash === -1 ? destination : destination.slice(slash + 1);
}
