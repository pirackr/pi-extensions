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
	const finalSegment = slugifySegment(segments[segments.length - 1]);
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
