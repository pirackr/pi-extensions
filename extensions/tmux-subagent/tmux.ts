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

// ---------------------------------------------------------------------------
// Pane launch, rollover, layout, and rollback (Task 3)
// ---------------------------------------------------------------------------

export interface PaneSpec {
	runId: string;
	taskId: string;
	agent: string;
	/** Shell command that launches the runner for this task. */
	command: string;
	cwd: string;
	/** Creation order within the batch (0-based). */
	order: number;
}

export interface BatchLaunchOptions {
	sessionId: string;
	pid: number;
	cwd: string;
	windowName: string;
	/** Control-mode runner command for the transient bootstrap window. */
	controlCommand: string;
	/** Prepared task panes in creation order. */
	panes: PaneSpec[];
	isAlive?: (pid: number) => boolean;
}

export interface BatchLaunchResult {
	session: string;
	window: ParentWindow;
	/** Pane ids created by this batch (rollback scope). */
	paneIds: string[];
	/** Non-fatal layout warning, when the custom layout could not be applied. */
	layoutWarning?: string;
}

export interface PaneInfo {
	id: string;
	dead: boolean;
	runId: string;
	taskId: string;
}

const PANE_FORMAT = 
	"#{pane_id}|#{pane_dead}|#{@pi_run_id}|#{@pi_task_id}";

async function listPanes(
	exec: TmuxExecutor,
	windowId: string,
): Promise<PaneInfo[]> {
	const { stdout } = await exec([
		"list-panes",
		"-t",
		windowId,
		"-F",
		PANE_FORMAT,
	]);
	return stdout
		.split("\n")
		.filter(Boolean)
		.map((line) => {
			const [id, dead, runId, taskId] = line.split("|");
			return { id, dead: dead === "1", runId: runId ?? "", taskId: taskId ?? "" };
		});
}

async function getWindowSize(
	exec: TmuxExecutor,
	windowId: string,
): Promise<{ width: number; height: number }> {
	const { stdout } = await exec([
		"display-message",
		"-p",
		"-t",
		windowId,
		"#{window_width}x#{window_height}",
	]);
	const [width, height] = stdout.trim().split("x").map(Number);
	if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
		throw new Error(`could not read window size for ${windowId}: ${stdout}`);
	}
	return { width, height };
}

async function setPaneMeta(
	exec: TmuxExecutor,
	paneId: string,
	spec: PaneSpec,
): Promise<void> {
	await exec(["set-option", "-p", "-t", paneId, "@pi_run_id", spec.runId]);
	await exec(["set-option", "-p", "-t", paneId, "@pi_task_id", spec.taskId]);
}

async function splitPane(
	exec: TmuxExecutor,
	anchorId: string,
	spec: PaneSpec,
): Promise<string> {
	const { stdout } = await exec([
		"split-window",
		"-P",
		"-F",
		"#{pane_id}",
		"-t",
		anchorId,
		"-c",
		spec.cwd,
		spec.command,
	]);
	const paneId = stdout.trim();
	if (!paneId.startsWith("%")) {
		throw new Error(`unexpected pane id from split-window: ${paneId}`);
	}
	await setPaneMeta(exec, paneId, spec);
	return paneId;
}

async function killPane(exec: TmuxExecutor, paneId: string): Promise<void> {
	await exec(["kill-pane", "-t", paneId]);
}

/** Kill exactly the given pane ids (batch-local cancellation / rollback). */
export async function cancelPanes(
	exec: TmuxExecutor,
	paneIds: string[],
): Promise<void> {
	for (const paneId of paneIds) {
		await killPane(exec, paneId).catch(() => undefined);
	}
}

/**
 * Remove the transient bootstrap window if the shared session still hosts it.
 * Removing the last window of the session lets the session disappear naturally.
 */
async function removeBootstrapWindow(exec: TmuxExecutor): Promise<void> {
	const { stdout } = await exec([
		"list-windows",
		"-t",
		SHARED_SESSION,
		"-F",
		"#{window_id}|#{window_name}",
	]);
	for (const line of stdout.split("\n")) {
		const [windowId, name] = line.split("|");
		if (name === BOOTSTRAP_WINDOW) {
			await exec(["kill-window", "-t", windowId]).catch(() => undefined);
			return;
		}
	}
}

async function createRemainingPanes(
	exec: TmuxExecutor,
	specs: PaneSpec[],
	anchorId: string,
	createdIds: string[],
): Promise<void> {
	for (const spec of specs) {
		const paneId = await splitPane(exec, anchorId, spec);
		createdIds.push(paneId);
		anchorId = paneId;
	}
}

/**
 * Launch a batch of task panes in the shared session:
 * - ensures the shared session exists (race-tolerant);
 * - serializes all mutations under `pi-subagents-mutation`;
 * - finds or creates the parent window (first task pane initializes it);
 * - prunes dead panes while preserving live panes;
 * - rolls over an all-dead window by creating a replacement anchor first;
 * - applies the deterministic balanced layout (tiled fallback on failure);
 * - removes the bootstrap window it created.
 *
 * On failure, only the pane ids created by this call are killed and the
 * failure is rethrown; pre-existing live panes are never cancelled.
 */
export async function launchBatch(
	exec: TmuxExecutor,
	opts: BatchLaunchOptions,
): Promise<BatchLaunchResult> {
	const sessionState = await ensureSharedSession(exec, {
		cwd: opts.cwd,
		controlCommand: opts.controlCommand,
	});
	const createdIds: string[] = [];
	let window: ParentWindow | null = null;
	let layoutWarning: string | undefined;

	await withMutationLock(exec, async () => {
		try {
			const preexisting = await findParentWindow(exec, opts.sessionId);
			window = await ensureParentWindow(exec, {
				sessionId: opts.sessionId,
				pid: opts.pid,
				cwd: opts.cwd,
				name: opts.windowName,
				firstCommand: opts.panes[0]?.command ?? "",
				isAlive: opts.isAlive,
			});

			const existingPanes = await listPanes(exec, window.id);
			const live = existingPanes.filter((pane) => !pane.dead);
			const dead = existingPanes.filter((pane) => pane.dead);
			const firstSpec = opts.panes[0];

			if (!preexisting) {
				// The window's initial pane is our first task pane.
				const anchor = existingPanes[0];
				if (!anchor) throw new Error(`parent window ${window.id} has no panes`);
				createdIds.push(anchor.id);
				await setPaneMeta(exec, anchor.id, firstSpec);
				await createRemainingPanes(
					exec,
					opts.panes.slice(1),
					anchor.id,
					createdIds,
				);
			} else if (live.length > 0) {
				// Prune dead panes, then split every new pane from the last pane so
				// the window pane list (and thus tmux's layout assignment order)
				// stays in creation order: old live panes first, new panes appended.
				for (const pane of dead) await killPane(exec, pane.id);
				const remaining = existingPanes.filter((pane) => !pane.dead);
				const anchor = remaining.at(-1) ?? live[0];
				await createRemainingPanes(
					exec,
					opts.panes,
					anchor.id,
					createdIds,
				);
			} else {
				// Every old pane is dead: create a replacement anchor from a dead
				// pane before removing the final old pane so the window survives.
				const anchorId = await splitPane(exec, dead[0].id, firstSpec);
				createdIds.push(anchorId);
				for (const pane of dead) await killPane(exec, pane.id);
				await createRemainingPanes(
					exec,
					opts.panes.slice(1),
					anchorId,
					createdIds,
				);
			}

			const allPanes = await listPanes(exec, window.id);
			if (allPanes.length > 1) {
				try {
					const size = await getWindowSize(exec, window.id);
					// tmux assigns panes to layout cells in window pane-list order
					// (the ids inside a layout string are parsed but not used for
					// assignment), so the split anchors above keep the list in
					// creation order: old live panes first, new panes appended.
					const layout = buildLayoutString(
						allPanes.map((pane) => paneIdNumber(pane.id)),
						size,
					);
					await exec(["select-layout", "-t", window.id, layout]);
				} catch {
					layoutWarning = "could not apply balanced layout; using tiled fallback";
					try {
						await exec(["select-layout", "-t", window.id, "tiled"]);
					} catch {
						// Agents keep running; the layout warning is reported.
					}
				}
			}

			if (sessionState.created) {
				await removeBootstrapWindow(exec).catch(() => undefined);
			}
		} catch (error) {
			// Batch-local rollback: kill only panes created by this call.
			await cancelPanes(exec, createdIds).catch(() => undefined);
			if (sessionState.created) {
				await removeBootstrapWindow(exec).catch(() => undefined);
			}
			throw error;
		}
	});

	return { session: SHARED_SESSION, window: window!, paneIds: createdIds, layoutWarning };
}

function paneIdNumber(paneId: string): number {
	const number = Number(paneId.replace(/^%/, ""));
	if (!Number.isInteger(number)) {
		throw new Error(`invalid pane id: ${paneId}`);
	}
	return number;
}

// ---------------------------------------------------------------------------
// Deterministic layout strings (pure)
// ---------------------------------------------------------------------------

/**
 * tmux layout-string checksum: the 4-hex prefix of a layout string is the
 * checksum of the body, matching layout_checksum() in tmux's layout-custom.c.
 */
export function layoutChecksum(body: string): number {
	let csum = 0;
	for (let i = 0; i < body.length; i++) {
		csum = (csum >> 1) + ((csum & 1) << 15);
		csum = (csum + body.charCodeAt(i)) & 0xffff;
	}
	return csum;
}

function checksumHex(body: string): string {
	return layoutChecksum(body).toString(16).padStart(4, "0");
}

/**
 * Build a tmux custom layout string for a balanced columns-first grid:
 * `columns = ceil(sqrt(n))`, panes fill columns top to bottom then left to
 * right, and every cell tiles the window exactly (tmux validates the sums).
 * Leaves reference panes by bare pane-id number.
 */
export function buildLayoutString(
	paneIds: number[],
	size: { width: number; height: number },
): string {
	const n = paneIds.length;
	if (n < 1) throw new Error("layout requires at least one pane");
	if (size.width < 1 || size.height < 1) {
		throw new Error(`invalid window size: ${size.width}x${size.height}`);
	}
	if (n === 1) {
		const body = `${size.width}x${size.height},0,0,${paneIds[0]}`;
		return `${checksumHex(body)},${body}`;
	}

	const { columns, rowsPerColumn } = planGrid(n);

	// Column widths: sum + (columns - 1) borders must equal the window width.
	const totalWidth = size.width - columns + 1;
	const colBase = Math.floor(totalWidth / columns);
	let colRemainder = totalWidth - colBase * columns;
	const colWidths = Array.from({ length: columns }, () => {
		const width = colBase + (colRemainder > 0 ? 1 : 0);
		if (colRemainder > 0) colRemainder--;
		return width;
	});

	let paneIndex = 0;
	let xoff = 0;
	const columnsStr: string[] = [];
	for (let col = 0; col < columns; col++) {
		const rows = rowsPerColumn[col];
		const colWidth = colWidths[col];

		// Row heights: sum + (rows - 1) borders must equal the window height.
		const totalHeight = size.height - rows + 1;
		const rowBase = Math.floor(totalHeight / rows);
		let rowRemainder = totalHeight - rowBase * rows;
		let yoff = 0;
		const leaves: string[] = [];
		for (let row = 0; row < rows; row++) {
			const height = rowBase + (rowRemainder > 0 ? 1 : 0);
			if (rowRemainder > 0) rowRemainder--;
			leaves.push(`${colWidth}x${height},${xoff},${yoff},${paneIds[paneIndex++]}`);
			yoff += height + 1;
		}

		const columnCell =
			rows === 1
				? leaves[0]
				: `${colWidth}x${size.height},${xoff},0[${leaves.join(",")}]`;
		columnsStr.push(columnCell);
		xoff += colWidth + 1;
	}

	const body = `${size.width}x${size.height},0,0{${columnsStr.join(",")}}`;
	return `${checksumHex(body)},${body}`;
}
