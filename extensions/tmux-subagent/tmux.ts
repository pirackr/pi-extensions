import * as path from "node:path";
import { homedir as osHomedir } from "node:os";

/**
 * Shared tmux orchestration for run_subagents.
 *
 * Tasks 1-3 live in this module: pure naming/layout planning, shared-session
 * and parent-window lifecycle, and pane launch/rollover/rollback. The module
 * accepts an injectable command executor so all tmux command planning is
 * testable without a real tmux server.
 *
 * Identity model (see docs/superpowers/specs/2026-08-09-shared-tmux-subagent-session-design.md):
 * - One shared session named `pi-subagents`.
 * - One window per parent Pi session, discovered by the `@pi_parent_session_id`
 *   window metadata (never by display name, which can collide).
 * - One pane per subagent task, created by splitting an anchor pane, carrying
 *   run/task metadata so a batch can roll back exactly the panes it created.
 * - Completed panes stay visible via `remain-on-exit` (a window option in
 *   tmux 3.7); dead panes are pruned only when a later batch acquires the lock.
 */

// ---------------------------------------------------------------------------
// Naming helpers (pure)
// ---------------------------------------------------------------------------

export interface WindowNameOptions {
	/** Home directory used to make paths home-relative (defaults to os.homedir()). */
	homedir?: string;
	/** Explicit Pi session name set via /name. */
	topic?: string;
	/** First user prompt used to derive a deterministic topic when unnamed. */
	firstPrompt?: string;
	/** Hard cap on the complete window display name. */
	maxNameLength?: number;
	/** Hard cap on the topic slug portion. */
	maxTopicLength?: number;
}

const DEFAULT_MAX_NAME_LENGTH = 60;
const DEFAULT_MAX_TOPIC_LENGTH = 40;

/** First lowercase alphanumeric character of a segment, or "_" if none. */
function firstAlphanumeric(segment: string): string {
	const match = segment.toLowerCase().match(/[a-z0-9]/);
	return match?.[0] ?? "_";
}

/** Slugify a path segment: lowercase, keep [a-z0-9-], collapse runs. */
function slugifySegment(segment: string): string {
	return slugifyTopic(segment, undefined);
}

/**
 * Shorten an absolute working directory for display:
 * - paths below the home directory become home-relative;
 * - ancestor segments are shortened to their first lowercase alphanumeric
 *   character;
 * - the final segment stays readable and is slugified.
 *
 * Returns "" for the home directory itself.
 */
export function shortenPath(cwd: string, homedir = osHomedir()): string {
	const normalized = path.normalize(cwd);
	const home = path.normalize(homedir);

	let rel: string;
	if (normalized === home) return "";
	const fromHome = path.relative(home, normalized);
	if (fromHome && !fromHome.startsWith("..") && !path.isAbsolute(fromHome)) {
		rel = fromHome;
	} else {
		rel = normalized;
	}

	const segments = rel.split(path.sep).filter((s) => s.length > 0);
	if (segments.length === 0) return "";

	if (segments.length === 1) return slugifySegment(segments[0]);

	const ancestors = segments
		.slice(0, -1)
		.map((s) => firstAlphanumeric(s))
		.join("/");
	const finalSegment = slugifySegment(segments.at(-1) ?? "");
	return `${ancestors}/${finalSegment}`;
}

/**
 * Slugify a topic: lowercase, reduce to hyphen-separated [a-z0-9] words,
 * trim edge hyphens, and bound the length without ending on a hyphen.
 * Returns "" when the input has no usable ASCII alphanumerics.
 */
export function slugifyTopic(topic: string, maxLength = DEFAULT_MAX_TOPIC_LENGTH): string {
	const slug = topic
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");

	if (maxLength !== undefined && slug.length > maxLength) {
		return slug.slice(0, maxLength).replace(/-+$/, "");
	}
	return slug;
}

/**
 * Deterministically derive a topic slug from the first user prompt. Uses the
 * first non-empty line; no model call is made. Returns undefined when the
 * prompt has no usable text.
 */
export function topicFromFirstPrompt(
	prompt: string,
	maxLength = DEFAULT_MAX_TOPIC_LENGTH,
): string | undefined {
	const lines = (prompt || "")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const source = lines[0] ?? "";
	const slug = slugifyTopic(source, maxLength);
	return slug || undefined;
}

/**
 * Build the tmux window display name for a parent Pi session:
 * `<shortPath>-<topic>` capped at maxNameLength. The explicit topic wins over
 * the first-prompt fallback; when neither yields a topic the bare shortened
 * path is used; when the path also shortens to nothing, "session" is used.
 */
export function buildWindowName(
	cwd: string,
	options: WindowNameOptions = {},
): string {
	const homedir = options.homedir ?? osHomedir();
	const maxName = options.maxNameLength ?? DEFAULT_MAX_NAME_LENGTH;

	const shortPath = shortenPath(cwd, homedir);

	let topic =
		slugifyTopic(options.topic ?? "", options.maxTopicLength) ||
		topicFromFirstPrompt(options.firstPrompt ?? "", options.maxTopicLength) ||
		"";

	if (shortPath && topic) {
		const budget = Math.max(1, maxName - shortPath.length - 1);
		topic = topic.slice(0, budget).replace(/-+$/, "");
		const name = topic ? `${shortPath}-${topic}` : shortPath;
		return name.length <= maxName ? name : name.slice(0, maxName).replace(/-+$/, "");
	}
	if (shortPath) return shortPath;
	if (topic) return topic;
	return "session";
}

// ---------------------------------------------------------------------------
// Layout planning (pure)
// ---------------------------------------------------------------------------

export interface GridPlan {
	/** Number of columns. */
	columns: number;
	/** Panes per column, top to bottom; earlier columns have at most one more. */
	rowsPerColumn: number[];
}

/**
 * Plan a balanced columns-first grid for n panes:
 * `columns = ceil(sqrt(n))`, panes distributed so earlier columns have at most
 * one more pane than later columns. Pane creation order runs top to bottom
 * within each column, then left to right across columns.
 */
export function planGrid(n: number): GridPlan {
	if (n < 1) throw new Error(`planGrid requires at least one pane, got ${n}`);
	const columns = Math.ceil(Math.sqrt(n));
	const rowsPerColumn: number[] = [];
	let remaining = n;
	for (let column = 0; column < columns; column++) {
		const columnsLeft = columns - column;
		const rows = Math.ceil(remaining / columnsLeft);
		rowsPerColumn.push(rows);
		remaining -= rows;
	}
	return { columns, rowsPerColumn };
}

/** Map a pane's creation index to its (column, row) position in the grid. */
export function paneGridPosition(
	n: number,
	index: number,
): { column: number; row: number } {
	if (index < 0 || index >= n) {
		throw new Error(`pane index ${index} out of range for ${n} panes`);
	}
	const { rowsPerColumn } = planGrid(n);
	let column = 0;
	let seen = 0;
	while (seen + rowsPerColumn[column] <= index) {
		seen += rowsPerColumn[column];
		column++;
	}
	return { column, row: index - seen };
}

// ---------------------------------------------------------------------------
// Shared session and window lifecycle (Task 2)
// ---------------------------------------------------------------------------

export const SHARED_SESSION = "pi-subagents";
export const MUTATION_LOCK = "pi-subagents-mutation";
export const BOOTSTRAP_WINDOW = "__bootstrap";

export const META_SESSION_ID = "@pi_parent_session_id";
export const META_PID = "@pi_parent_pid";
export const META_CWD = "@pi_parent_cwd";

export interface TmuxResult {
	stdout: string;
	stderr: string;
}

/** A tmux command executor; rejects with an Error on non-zero exit. */
export type TmuxExecutor = (args: string[]) => Promise<TmuxResult>;

export interface ParentWindow {
	/** Immutable tmux window id, e.g. "@3". */
	id: string;
	/** Display name (may collide across parents). */
	name: string;
	/** Pi session id stored in window metadata. */
	sessionId: string;
	/** Owning Pi process id, when recorded. */
	pid?: string;
	/** Normalized owning project path, when recorded. */
	cwd?: string;
}

export interface SharedSessionState {
	created: boolean;
	reused: boolean;
}

function isDuplicateSession(error: unknown): boolean {
	return error instanceof Error && /duplicate session/i.test(error.message);
}

function normalizePath(cwd: string): string {
	return path.resolve(cwd);
}

/** Whether the shared session exists (any tmux error means it does not). */
export async function sessionExists(exec: TmuxExecutor): Promise<boolean> {
	try {
		await exec(["has-session", "-t", SHARED_SESSION]);
		return true;
	} catch {
		return false;
	}
}

/**
 * Ensure the shared `pi-subagents` session exists. When absent it is created
 * with a transient `__bootstrap` window running the control-mode runner. A
 * duplicate-session error from a concurrent creator is treated as reuse after
 * re-checking the session.
 */
export async function ensureSharedSession(
	exec: TmuxExecutor,
	opts: { cwd: string; controlCommand: string },
): Promise<SharedSessionState> {
	if (await sessionExists(exec)) return { created: false, reused: true };
	try {
		await exec([
			"new-session",
			"-d",
			"-s",
			SHARED_SESSION,
			"-n",
			BOOTSTRAP_WINDOW,
			"-c",
			opts.cwd,
			opts.controlCommand,
		]);
		return { created: true, reused: false };
	} catch (error) {
		if (isDuplicateSession(error) && (await sessionExists(exec))) {
			return { created: false, reused: true };
		}
		throw error;
	}
}

/**
 * Serialize shared tmux mutations. The lock is released in a finally path so
 * it is released after both success and failure. A crashed client releases the
 * server-side lock automatically when its connection drops.
 */
export async function withMutationLock<T>(
	exec: TmuxExecutor,
	fn: () => Promise<T>,
): Promise<T> {
	await exec(["wait-for", "-L", MUTATION_LOCK]);
	try {
		return await fn();
	} finally {
		await exec(["wait-for", "-U", MUTATION_LOCK]).catch(() => undefined);
	}
}

const WINDOW_FORMAT = 
	"#{window_id}|#{window_name}|#{@pi_parent_session_id}|#{@pi_parent_pid}|#{@pi_parent_cwd}";

function parseWindowLine(line: string): ParentWindow {
	const [id, name, sessionId, pid, cwd] = line.split("|");
	return {
		id,
		name,
		sessionId: sessionId ?? "",
		pid: pid || undefined,
		cwd: cwd || undefined,
	};
}

/**
 * List parent windows (windows carrying a Pi session id). Returns [] when the
 * shared session is missing entirely.
 */
export async function listParentWindows(
	exec: TmuxExecutor,
): Promise<ParentWindow[]> {
	try {
		const { stdout } = await exec([
			"list-windows",
			"-t",
			SHARED_SESSION,
			"-F",
			WINDOW_FORMAT,
		]);
		return stdout
			.split("\n")
			.map(parseWindowLine)
			.filter((window) => window.sessionId !== "");
	} catch {
		return [];
	}
}

/**
 * Find the parent window owned by a Pi session id. Windows are matched by the
 * stored metadata, never by display name, so duplicate names are safe.
 */
export async function findParentWindow(
	exec: TmuxExecutor,
	sessionId: string,
): Promise<ParentWindow | null> {
	const windows = await listParentWindows(exec);
	return windows.find((window) => window.sessionId === sessionId) ?? null;
}

/**
 * Remove windows whose recorded owner process is no longer alive. Only
 * windows whose normalized cwd matches the given project and whose owner pid is
 * recorded are candidates; windows without owner metadata are never touched,
 * and a live owner always protects its window.
 */
export async function reclaimStaleWindows(
	exec: TmuxExecutor,
	cwd: string,
	isAlive: (pid: number) => boolean = defaultIsAlive,
): Promise<void> {
	const target = normalizePath(cwd);
	for (const window of await listParentWindows(exec)) {
		if (window.cwd !== target) continue;
		if (!window.pid || !/^\d+$/.test(window.pid)) continue;
		if (isAlive(Number(window.pid))) continue;
		await closeParentWindow(exec, window.id).catch(() => undefined);
	}
}

function defaultIsAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function setWindowMeta(
	exec: TmuxExecutor,
	target: string,
	key: string,
	value: string,
): Promise<void> {
	await exec(["set-option", "-w", "-t", target, key, value]);
}

/** Query the immutable window id for a target. */
export async function getWindowId(
	exec: TmuxExecutor,
	target: string,
): Promise<string> {
	const { stdout } = await exec([
		"display-message",
		"-p",
		"-t",
		target,
		"#{window_id}",
	]);
	return stdout.trim();
}

export interface EnsureParentWindowOptions {
	sessionId: string;
	pid: number;
	cwd: string;
	name: string;
	/** Shell command for the first task pane that starts the window. */
	firstCommand: string;
	/** Owner-liveness probe for stale-window reclaim (testable). */
	isAlive?: (pid: number) => boolean;
}

/**
 * Find or create the parent window for a Pi session. Creation sets owner
 * metadata (@pi_parent_session_id/@pi_parent_pid/@pi_parent_cwd), applies
 * remain-on-exit and automatic-name suppression, and reclaims stale windows
 * from crashed owners in the same project. Resume refreshes owner metadata so
 * stale detection sees the live owner.
 */
export async function ensureParentWindow(
	exec: TmuxExecutor,
	opts: EnsureParentWindowOptions,
): Promise<ParentWindow> {
	const cwd = normalizePath(opts.cwd);
	const existing = await findParentWindow(exec, opts.sessionId);
	if (existing) {
		await setWindowMeta(exec, existing.id, META_PID, String(opts.pid));
		await setWindowMeta(exec, existing.id, META_CWD, cwd);
		return { ...existing, pid: String(opts.pid), cwd };
	}

	await reclaimStaleWindows(exec, opts.cwd, opts.isAlive);

	await exec([
		"new-window",
		"-d",
		"-t",
		SHARED_SESSION,
		"-n",
		opts.name,
		"-c",
		opts.cwd,
		opts.firstCommand,
	]);

	const target = `${SHARED_SESSION}:${opts.name}`;
	await setWindowMeta(exec, target, META_SESSION_ID, opts.sessionId);
	await setWindowMeta(exec, target, META_PID, String(opts.pid));
	await setWindowMeta(exec, target, META_CWD, cwd);
	await exec(["set-window-option", "-t", target, "remain-on-exit", "on"]);
	await exec(["set-window-option", "-t", target, "automatic-rename", "off"]);

	const id = await getWindowId(exec, target);
	return { id, name: opts.name, sessionId: opts.sessionId, pid: String(opts.pid), cwd };
}

/** Rename a parent window by immutable id; metadata is untouched. */
export async function renameWindow(
	exec: TmuxExecutor,
	windowId: string,
	name: string,
): Promise<void> {
	await exec(["rename-window", "-t", windowId, name]);
}

/** Close a parent window by immutable id, never the shared session. */
export async function closeParentWindow(
	exec: TmuxExecutor,
	windowId: string,
): Promise<void> {
	await exec(["kill-window", "-t", windowId]);
}
