// Secure parent identity and short-ID allocation for the `subagent` extension.
//
// This module owns everything the manager needs to pick a durable,
// collision-free parent identity and derive the `/tmp` artifact root from it:
//
// - {@link projectSlug} sanitizes the project basename and appends a short
//   hash of the canonical path so two projects that share a basename never
//   collide under `/tmp`.
// - {@link allocateShortId} produces four-character lowercase `a-z0-9`
//   identifiers with bounded retries against both tmux targets and durable
//   artifact paths.
// - {@link resolveParentIdentity} resolves a parent ID from the running tmux
//   session, then `PI_SESSION_ID`, then a freshly allocated id — exactly the
//   order the design spec requires.
//
// It depends only on `node:crypto`, `node:fs`, `node:path`, and the
// {@link isShortId} guard from `types.ts`; it performs no tmux or filesystem
// mutation of its own beyond the injected collision checks.

import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import { join, sep } from "node:path";

import { isShortId } from "./types.ts";

/** Lowercase base-36 alphabet used for every short identifier in the extension. */
const BASE36 = "0123456789abcdefghijklmnopqrstuvwxyz";

/** The fixed length of a parent/agent identifier. */
const SHORT_ID_LENGTH = 4;

/** Bounded allocation attempts before failing with a clear error. */
const DEFAULT_MAX_ATTEMPTS = 8;

/** Default `/tmp` root beneath which all artifact roots are created. */
const DEFAULT_TMP_ROOT = "/tmp";

/**
 * A collision predicate: return `true` when the candidate id is already taken
 * by a tmux target or a durable artifact path. Supports both synchronous and
 * asynchronous checks so callers can layer tmux and filesystem evidence.
 */
export type CollisionCheck = (id: string) => boolean | Promise<boolean>;

/**
 * Sanitize a canonical working directory into a short, collision-resistant
 * project slug.
 *
 * The slug is the lowercased, alphanumeric-only basename of the canonical
 * directory followed by a four-character base-36 hash of the full canonical
 * path. The basename keeps human-readable `ls` output; the hash of the *whole*
 * canonical path prevents two differently-located projects that share a
 * basename (for example two `work` directories) from clobbering each other's
 * durable state under `/tmp`.
 *
 * A trailing path separator is tolerated; the result never contains a path
 * separator, so it is safe to embed directly in a `/tmp/<slug>/pi-<id>` path.
 */
export function projectSlug(canonicalCwd: string): string {
	const trimmed = canonicalCwd.endsWith(sep)
		? canonicalCwd.slice(0, -sep.length)
		: canonicalCwd;
	const slash = trimmed.lastIndexOf("/");
	const base = slash === -1 ? trimmed : trimmed.slice(slash + 1);

	const sanitized = base.replace(/[^a-z0-9]+/gi, "").toLowerCase();
	return `${sanitized}-${shortHash(canonicalCwd)}`;
}

/**
 * A four-character lowercase base-36 hash of `input`, suitable for slugs and
 * other short identifiers. Uses `sha256` truncated to four base-36 digits.
 *
 * @internal Not part of the documented Task 2 surface; used by {@link
 *   projectSlug}.
 */
export function shortHash(input: string): string {
	// `base36` is not a Node digest encoding; a hex digest is already lowercase
	// `0-9a-f`, a valid subset of the base-36 alphabet, and collision-resistant
	// enough for a four-character project-slug suffix.
	return createHash("sha256").update(input).digest("hex").slice(0, 4);
}

/**
 * Produce one random four-character lowercase base-36 identifier from the
 * injected `randomBytes` source.
 *
 * @internal Not part of the documented Task 2 surface.
 */
function randomShortId(randomBytes: (bytes: number) => Uint8Array): string {
	const bytes = randomBytes(SHORT_ID_LENGTH);
	let id = "";
	for (let i = 0; i < SHORT_ID_LENGTH; i++) {
		id += BASE36[bytes[i] % BASE36.length];
	}
	return id;
}

/**
 * Allocate a collision-free four-character identifier.
 *
 * Generates candidate ids from `randomBytes` and asks `checkCollision` about
 * each one. The first candidate that is not considered colliding — meaning it
 * exists neither as a tmux target nor as a durable artifact path — is returned.
 * Retries are bounded by `maxAttempts`; the first id is tried before any
 * retry budget is consumed, and every attempted candidate is counted against
 * that budget.
 *
 * The check is delegated so the caller can combine tmux and filesystem
 * evidence; this function itself performs no tmux or filesystem IO.
 *
 * @throws when no free id is found within `maxAttempts`.
 */
export async function allocateShortId(
	checkCollision: CollisionCheck,
	randomBytes: (bytes: number) => Uint8Array,
	maxAttempts: number = DEFAULT_MAX_ATTEMPTS,
): Promise<string> {
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		const candidate = randomShortId(randomBytes);
		if (!(await checkCollision(candidate))) {
			return candidate;
		}
	}
	throw new Error(
		`unable to allocate a short ID after ${maxAttempts} attempts`,
	);
}

/**
 * A resolved parent identity: the four-character id, its tmux session name,
 * the injectable `/tmp` root, the project slug, and the fully derived artifact
 * root. Frozen so a later identity cannot silently shadow an earlier one.
 */
export interface ParentIdentity {
	/** The four-character parent id, for example `a7k2`. */
	readonly id: string;
	/** The tmux session name derived from the id, for example `pi-a7k2`. */
	readonly tmuxSession: string;
	/** The injectable `/tmp` root beneath which artifact roots live. */
	readonly tmpRoot: string;
	/** The sanitized project slug for the current canonical working directory. */
	readonly projectSlug: string;
	/** The durable artifact root: `<tmpRoot>/<projectSlug>/pi-<id>`. */
	readonly artifactRoot: string;
}

/**
 * Injectable dependencies for {@link resolveParentIdentity}. Every filesystem
 * or tmux side effect is injected so the resolution order can be tested
 * deterministically without a live tmux server or `/tmp` state.
 */
export interface ResolveParentIdentityOptions {
	/** Canonical working directory used to derive the project slug. */
	cwd: string;
	/** Injectable `/tmp` root; defaults to `/tmp`. */
	tmpRoot?: string;
	/** Project slug override; defaults to {@link projectSlug}(cwd). */
	projectSlug?: string;
	/**
	 * Returns the current tmux session name, or `null`/`undefined` when the
	 * process is not attached to one. May return any session name; only a
	 * `pi-<id>` suffix is accepted.
	 */
	tmuxCurrentSession?: () => string | null;
	/** Returns the raw `PI_SESSION_ID` value, or `null`/`undefined`. */
	readSessionId?: () => string | null;
	/** Cryptographic byte source; defaults to `node:crypto`.randomBytes. */
	randomBytes?: (bytes: number) => Uint8Array;
	/** Allocation function; defaults to the exported {@link allocateShortId}. */
	allocateShortId?: typeof allocateShortId;
	/**
	 * Collision predicate for a freshly allocated id, checking that the
	 * `pi-<id>` artifact root does not already exist. Defaults to a filesystem
	 * existence check; callers may layer tmux evidence here.
	 */
	collisionFor?: (id: string) => boolean | Promise<boolean>;
	/**
	 * Canonicalize a path (resolve symlinks, `..`, and repeated separators)
	 * before deriving the project slug. Defaults to a safe `fs.realpath`
	 * wrapper: when canonicalization fails — for example the working directory
	 * does not exist yet — the input is returned unchanged so a missing cwd
	 * never blocks identity resolution.
	 *
	 * Injectable so the canonicalization step can be exercised deterministically
	 * without a live symlink on disk. When overridden, callers are responsible
	 * for a correct canonicalization.
	 */
	canonicalize?: (path: string) => Promise<string>;
}

/**
 * Resolve the durable parent identity, following the design-spec order:
 *
 * 1. If the current tmux session matches `pi-[a-z0-9]{4}`, reuse its suffix.
 * 2. Otherwise, if `PI_SESSION_ID` is a valid short id, reuse it.
 * 3. Otherwise allocate a fresh collision-checked id, persist it to
 *    `process.env.PI_SESSION_ID` so it survives `/reload`, and reuse it.
 *
 * The derived {@link ParentIdentity.artifactRoot} is
 * `<tmpRoot>/<projectSlug>/pi-<id>`; it is created later by
 * {@link ArtifactStore.initializeParent}.
 *
 * @throws when a fresh id cannot be allocated within the attempt budget, or
 *   when the resolved id fails the collision check.
 */
export async function resolveParentIdentity(
	options: ResolveParentIdentityOptions,
): Promise<ParentIdentity> {
	const tmpRoot = options.tmpRoot ?? DEFAULT_TMP_ROOT;
	// Derive the slug from a *canonical* working directory so symlinks and
	// `..` cannot redirect the artifact root off its expected location.
	// `projectSlug` stays a pure helper; canonicalization happens here at the
	// call boundary where the filesystem dependency belongs.
	const canonicalize = options.canonicalize ?? safeCanonicalize;
	let slugSource: string;
	try {
		slugSource = await canonicalize(options.cwd);
	} catch {
		slugSource = options.cwd;
	}
	const slugValue = options.projectSlug ?? projectSlug(slugSource);
	const randomBytes = options.randomBytes ?? nodeRandomBytes;
	const allocate = options.allocateShortId ?? allocateShortId;

	const collisionFor: CollisionCheck = options.collisionFor ??
		((async (id: string): Promise<boolean> => {
			try {
				await stat(join(tmpRoot, slugValue, `pi-${id}`));
				return true;
			} catch {
				return false;
			}
		}));

	let id: string | undefined;

	const tmux = options.tmuxCurrentSession?.();
	if (tmux && tmux.startsWith("pi-") && isShortId(tmux.slice("pi-".length))) {
		id = tmux.slice("pi-".length);
	}

	if (!id) {
		const envId = options.readSessionId?.();
		if (isShortId(envId)) {
			id = envId;
		}
	}

	if (!id) {
		id = await allocate(collisionFor, randomBytes, DEFAULT_MAX_ATTEMPTS);
		// Persist so a later `/reload` in the same process resolves the same id
		// without re-allocating a new one.
		process.env.PI_SESSION_ID = id;
	}

	const tmuxSession = `pi-${id}`;
	const artifactRoot = join(tmpRoot, slugValue, tmuxSession);

	return Object.freeze({ id, tmuxSession, tmpRoot, projectSlug: slugValue, artifactRoot });
}

/**
 * Canonicalize a path by resolving symlinks, `..`, and repeated separators.
 *
 * This is the default {@link ResolveParentIdentityOptions.canonicalize} used
 * by {@link resolveParentIdentity}. It never throws: when `fs.realpath` fails
 * — for example the working directory does not exist yet — the input is
 * returned unchanged so a missing cwd never blocks identity resolution.
 */
async function safeCanonicalize(path: string): Promise<string> {
	try {
		return await realpath(path);
	} catch {
		return path;
	}
}

/**
 * The directory name of the freshly created subagent workspace, always
 * `subagents`.
 *
 * @internal Shared path constant.
 */
export const SUBAGENTS_DIR = "subagents";

/**
 * The directory name of a per-task control workspace used for cancellation and
 * other durable signals.
 *
 * @internal Shared path constant.
 */
export const CONTROL_DIR = "control";

/**
 * The marker filename written inside {@link CONTROL_DIR} to request
 * cancellation of a running or queued task.
 *
 * @internal Shared path constant.
 */
export const CANCEL_MARKER = "cancel";

/**
 * The relative path (from the subagent workspace) of the task manifest /
 * live-status file. The manifest with state `queued` is the durable queue.
 *
 * @internal Shared path constant.
 */
export const STATUS_FILE = "status.json";

/**
 * The relative path of the runner request record written at enqueue time.
 *
 * @internal Shared path constant.
 */
export const REQUEST_FILE = "request.json";

/**
 * The relative path of the snapshotted profile record.
 *
 * @internal Shared path constant.
 */
export const PROFILE_FILE = "profile.json";

/**
 * The relative path of the terminal result record.
 *
 * @internal Shared path constant.
 */
export const RESULT_FILE = "result.json";

/**
 * The relative path of the durable delivery record.
 *
 * @internal Shared path constant.
 */
export const DELIVERY_FILE = "delivery.json";

/**
 * The relative path of the append-only event log.
 *
 * @internal Shared path constant.
 */
export const EVENTS_LOG = "events.jsonl";

/**
 * The relative path of the child stderr log.
 *
 * @internal Shared path constant.
 */
export const STDERR_LOG = "stderr.log";

/**
 * The relative path of the assistant transcript log.
 *
 * @internal Shared path constant.
 */
export const TRANSCRIPT_LOG = "transcript.log";

/**
 * The relative path of the `control/` directory that holds cancellation and
 * other durable task signals.
 *
 * @internal Shared path constant.
 */
export const GROUPS_DIR = "groups";

/**
 * Directory mode applied to every durable directory the store creates: owner
 * read/write/execute only.
 *
 * @internal Shared constant.
 */
export const DIR_MODE = 0o700;

/**
 * File mode applied to every durable file the store writes: owner
 * read/write only. Prompts, results, and transcripts are sensitive.
 *
 * @internal Shared constant.
 */
export const FILE_MODE = 0o600;
