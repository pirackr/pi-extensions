// Task 11 — compact rendering, widget/footer, and `/agents`.
//
// The compact/widget/footer/notification helpers are pure and dependency-free
// so they are usable by both the TUI (Task 12 wires it into `setWidget`
// / `setFooter` / `registerMessageRenderer`) and RPC/tool-call wiring (which
// expects plain string arrays). The one exception is the live `/agents` selector
// (`runAgentsCommand`) and the tool renderers (`createToolRenderers`), which own
// the real Pi `Text` / `SelectList` components; they compose the pure helpers
// above and call `ctx.ui.requestRender()` / `performAgentAction` after every
// state change. The only runtime import is `@earendil-works/pi-tui`.
//
// Scope rulings (see task-11-brief.md):
//   - Compact output never echoes the task prompt.
//   - Expanded background output shows labeled `Tmux:` / `Attach:` / `Artifacts:` rows.
//   - No pane-grid, pane-border, window-title, or parent-window renaming logic.
//   - `/agents` uses only the public `SubagentManager` API (`list`, `stop`, `getResult`).
//   - Attach is exposed as an exact command string; it is never executed through a shell.

import type {
	AgentManifest,
	AgentReceipt,
	AgentRequest,
	ResultResponse,
	StopResponse,
	TaskStatus,
	TerminalResult,
} from "./types.ts";

import type { SubagentManager } from "./manager.ts";

import type { NotificationItem } from "./notifications.ts";

import { type SelectItem, type SelectListTheme, Container, Key, matchesKey, SelectList, Text } from "@earendil-works/pi-tui";

// ---------------------------------------------------------------------------
// State markers — one glyph per lifecycle state. Kept in one place so the
// widget, the compact tool result, and notification summaries stay consistent.
// ---------------------------------------------------------------------------

const STATE_MARKERS: Record<TaskStatus, string> = {
	queued: "⏳",
	starting: "⠙",
	running: "⠋",
	succeeded: "✓",
	failed: "✗",
	timed_out: "⏰",
	cancelled: "−",
	interrupted: "⚠",
};

const TERMINAL_STATES: readonly TaskStatus[] = [
	"succeeded",
	"failed",
	"timed_out",
	"cancelled",
	"interrupted",
];

function isTerminalState(state: TaskStatus): boolean {
	return TERMINAL_STATES.includes(state);
}

// ---------------------------------------------------------------------------
// Small pure helpers (visible-width aware, no ANSI/emoji width assumptions)
// ---------------------------------------------------------------------------

/** Display width of `value`, ignoring ANSI/SGR escape sequences. */
export function visibleWidth(value: string): number {
	let width = 0;
	let inEscape = false;
	for (const ch of value) {
		if (inEscape) {
			if (ch === "m") inEscape = false;
			continue;
		}
		if (ch === "\x1b") {
			inEscape = true;
			continue;
		}
		width++;
	}
	return width;
}

/**
 * Truncate `value` so its visible width never exceeds `width`. ANSI escapes are
 * preserved when they fit and skipped when they would overflow. An ellipsis is
 * appended only when truncation actually drops characters, so an already-fitting
 * line is returned verbatim.
 */
export function truncateToWidth(
	value: string,
	width: number,
	ellipsis = "…",
): string {
	if (visibleWidth(value) <= width) return value;
	if (width <= 0) return "";
	if (visibleWidth(ellipsis) >= width) return value.slice(0, width);
	const budget = width - visibleWidth(ellipsis);
	let out = "";
	let seen = 0;
	let inEscape = false;
	for (const ch of value) {
		if (inEscape) {
			if (ch === "m") inEscape = false;
			continue;
		}
		if (ch === "\x1b") {
			inEscape = true;
			continue;
		}
		if (seen >= budget) break;
		out += ch;
		seen++;
	}
	return out + ellipsis;
}

/** Compact token count: `1234` → `1.2k`, `500` → `500`. */
function compactTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
	return String(tokens);
}

/** Elapsed milliseconds rendered as `12.3s` (one decimal place). */
function formatDurationMs(ms: number): string {
	const seconds = Math.max(0, ms) / 1000;
	return `${seconds.toFixed(1)}s`;
}

/** A single `Key:` + space + value row for the expanded tool block. */
function labeledRow(key: string, value: string): string {
	return `${key.padEnd(10)} ${value}`;
}

// ---------------------------------------------------------------------------
// Compact tool call / result rendering (never echo the prompt)
// ---------------------------------------------------------------------------

/** Compact call header: `▸ <profile> (<description>)`. */
export function renderCall(
	request: AgentRequest,
	_context?: unknown,
	_theme?: unknown,
): string {
	return `▸ ${request.subagent_type} (${request.description})`;
}

/** Compact result line for a receipt or foreground completion. */
export function renderResult(
	value: AgentReceipt | ResultResponse,
	options: { expanded?: boolean } = {},
	_theme?: unknown,
): string {
	if (options.expanded && isReceipt(value)) {
		return expandedToolDetails(value).join("\n");
	}
	return compactResultText(value);
}

/** The plain compact result line for a receipt or foreground completion. */
function compactResultText(value: AgentReceipt | ResultResponse): string {
	const handle = `subagent-${value.agentId}`;
	if (isForegroundCompletion(value)) return "⎿ Done";
	if (value.state === "queued") return `⎿ Queued as ${handle}…`;
	return `⎿ Running as ${handle}…`;
}

/** Minimal subset of the pi theme the renderers may use when available. */
interface RendererTheme {
	readonly fg: (color: string, text: string) => string;
	readonly bold: (text: string) => string;
}

/**
 * Apply optional pi theming. When the renderer receives a real `theme`
 * (as `pi` does at call time) the text is painted; when `theme` is absent or
 * shape-less (as in the RPC/string harness) the raw text is returned verbatim.
 */
function themed(theme: RendererTheme | unknown | undefined, text: string): string {
	if (
		theme &&
		typeof theme === "object" &&
		typeof (theme as RendererTheme).fg === "function" &&
		typeof (theme as RendererTheme).bold === "function"
	) {
		return (theme as RendererTheme).fg("toolTitle", (theme as RendererTheme).bold(text));
	}
	return text;
}

/**
 * Factory mirroring the pi tool-renderer contract
 * (`renderCall(args, theme, context)` / `renderResult(result, options, theme, context)`).
 * Both return real pi `Text` components so the TUI layer can theme them; the
 * compact form never echoes the prompt. RPC wiring can render the same
 * components to plain strings via `component.render(width)`.
 */
export function createToolRenderers() {
	return {
		renderCall: (
			args: AgentRequest,
			theme?: RendererTheme,
			_context?: unknown,
		): Text =>
			new Text(themed(theme, `▸ ${args.subagent_type} (${args.description})`), 0, 0),
		renderResult: (
			value: AgentReceipt | ResultResponse,
			options: { expanded?: boolean } = {},
			theme?: RendererTheme,
			_context?: unknown,
		): Text | Container => {
			if (options.expanded && isReceipt(value)) {
				const container = new Container();
				for (const line of expandedToolDetails(value)) {
					container.addChild(new Text(themed(theme, line), 0, 0));
				}
				return container;
			}
			return new Text(
				themed(theme, compactResultText(value)),
				0,
				0,
			);
		},
	};
}

/** True for an `AgentReceipt` (background enqueue confirmation). */
function isReceipt(
	value: AgentReceipt | ResultResponse,
): value is AgentReceipt {
	return !("result" in value) || !("consumed" in value);
}

/** True when the value is a consumed foreground completion (`⎿ Done`). */
function isForegroundCompletion(
	value: AgentReceipt | ResultResponse,
): value is ResultResponse & { result: NonNullable<unknown> } {
	const response = value as ResultResponse;
	return (
		"result" in response &&
		"consumed" in response &&
		!!response.result &&
		response.consumed
	);
}

/**
 * Expanded background output: labeled `Tmux:` / `Attach:` / `Artifacts:` rows.
 * `Tmux` and `Attach` are omitted until the window has actually started.
 */
export function expandedToolDetails(receipt: AgentReceipt): string[] {
	const lines: string[] = [];
	if (receipt.tmuxWindow && receipt.tmuxSession) {
		lines.push(labeledRow("Tmux:", `${receipt.tmuxSession}:${receipt.tmuxWindow}`));
		if (receipt.attachCommand) {
			lines.push(labeledRow("Attach:", receipt.attachCommand));
		}
	}
	if (receipt.artifactDir) {
		lines.push(labeledRow("Artifacts:", receipt.artifactDir));
	}
	return lines;
}

// ---------------------------------------------------------------------------
// Widget rows — hierarchy, elapsed/timeout, tool/token use, terminal state
// ---------------------------------------------------------------------------

/** A single row of the live agents widget. */
export interface AgentWidgetRow {
	readonly agentId: string;
	readonly parentAgentId: string | null;
	readonly depth: number;
	readonly profile: string;
	readonly description: string;
	readonly state: TaskStatus;
	readonly startedAt: number | null;
	readonly finishedAt: number | null;
	readonly timeoutSeconds: number | null;
	readonly toolUses: number;
	readonly totalTokens: number;
	readonly activity: string | null;
}

export interface RenderWidgetOptions {
	/** Current animation frame (kept for parity with the pi widget contract). */
	readonly frame: number;
	readonly width: number;
	readonly now: number;
}

/** One line per row, each already truncated to the supplied visible width. */
export function renderWidgetLines(
	rows: AgentWidgetRow[],
	{ width, now }: RenderWidgetOptions,
): string[] {
	return rows.map((row) => formatWidgetRow(row, width, now));
}

function formatWidgetRow(
	row: AgentWidgetRow,
	width: number,
	now: number,
): string {
	const indent = "  ".repeat(Math.max(0, row.depth));
	const marker = STATE_MARKERS[row.state] ?? "·";

	const startedAt = row.startedAt ?? 0;
	const elapsedMs =
		row.finishedAt != null ? row.finishedAt - startedAt : now - startedAt;

	const elapsed = formatDurationMs(elapsedMs);
	const timeout =
		row.timeoutSeconds != null ? `/${row.timeoutSeconds}s` : "";
	const tools =
		`${row.toolUses} ${row.toolUses === 1 ? "tool" : "tools"}`;
	const tokens = `${compactTokens(row.totalTokens)} tok`;
	const terminal =
		row.finishedAt != null ? ` ${row.state}` : "";

	const line =
		`${indent}${marker} subagent-${row.agentId} ${row.profile} ${row.description} ${elapsed}${timeout} ${tools} ${tokens}${terminal}`;

	return truncateToWidth(line, width);
}

// ---------------------------------------------------------------------------
// Footer
// ---------------------------------------------------------------------------

export interface FooterCounts {
	readonly running: number;
	readonly queued: number;
	readonly finished: number;
}

export function renderFooter({ running, queued, finished }: FooterCounts): string {
	return `Agents: ${running} running · ${queued} queued · ${finished} finished`;
}

/** Bucket durable manifests into running (+starting), queued, and finished. */
export function countAgents(
	manifests: readonly AgentManifest[],
): FooterCounts {
	let running = 0;
	let queued = 0;
	let finished = 0;
	for (const manifest of manifests) {
		if (manifest.state === "queued") {
			queued++;
		} else if (manifest.state === "running" || manifest.state === "starting") {
			running++;
		} else if (isTerminalState(manifest.state)) {
			finished++;
		}
	}
	return { running, queued, finished };
}

// ---------------------------------------------------------------------------
// Compact notifications (summary + usage only, never the output body)
// ---------------------------------------------------------------------------

export function renderNotificationMessage(items: readonly NotificationItem[]): string {
	return items.map(renderNotificationItem).join("\n");
}

function renderNotificationItem(item: NotificationItem): string {
	const marker = STATE_MARKERS[item.state as TaskStatus] ?? "·";
	const usage = item.usage;
	const parts = [
		`${marker} ${item.summary}`,
		`${usage.toolUses} ${usage.toolUses === 1 ? "tool" : "tools"}`,
		`${compactTokens(usage.totalTokens)} tok`,
		formatDurationMs(usage.durationMs),
	];
	return parts.join(" · ");
}

// ---------------------------------------------------------------------------
// `/agents` action logic
// ---------------------------------------------------------------------------

/**
 * The action(s) the `/agents` UI performs for a task. Terminal tasks expose
 * both full-result retrieval and a display/copy of the artifact path; live
 * tasks expose attach or stop. The selector offers every listed action for a
 * row, so no action is reachable only through a direct function call.
 */
export type AgentRowAction = "attach" | "stop" | "retrieve" | "path";

/** Classify a durable manifest into the single primary `/agents` action. */
export function classifyAgentRow(manifest: AgentManifest): AgentRowAction {
	if (isTerminalState(manifest.state)) return "retrieve";
	if (manifest.state === "running" || manifest.state === "starting") {
		return "attach";
	}
	return "stop";
}

/** Actions offered for a row in its lifecycle state. */
function actionsFor(manifest: AgentManifest): AgentRowAction[] {
	if (isTerminalState(manifest.state)) return ["retrieve", "path"];
	if (manifest.state === "running" || manifest.state === "starting") return ["attach"];
	return ["stop"];
}

/** The exact attach command for a task, or `null` when no window has started. */
export function attachCommandFor(
	task: { readonly tmuxSession: string | null; readonly tmuxWindow: string | null },
): string | null {
	if (!task.tmuxWindow || !task.tmuxSession) return null;
	return `tmux attach -t ${task.tmuxSession} \\; select-window -t ${task.tmuxWindow}`;
}

/** Compact summary of a terminal result with usage and artifact path. */
export function retrieveSummary(result: ResultResponse): string {
	const terminal = result.result;
	if (!terminal) return "✗ no result available";
	const marker = STATE_MARKERS[terminal.state as TaskStatus] ?? "·";
	const usage = terminal.usage;
	const parts = [
		`${marker} ${terminal.state}`,
		`${usage.toolUses} ${usage.toolUses === 1 ? "tool" : "tools"}`,
		`${compactTokens(usage.totalTokens)} tok`,
		formatDurationMs(usage.durationMs),
	];
	if (result.artifactDir) parts.push(`artifacts: ${result.artifactDir}`);
	return parts.join(" · ");
}

/** Human-readable outcome of a stop request. */
export function stopSummary(response: StopResponse): string {
	if (response.stopped) {
		return `stopped ${response.agentId} (${response.state})`;
	}
	return `${response.agentId} is already terminal (${response.state})`;
}

/** The artifact directory for a result, or a sentinel when absent. */
export function artifactPathFor(result: ResultResponse): string {
	return result.artifactDir ?? "(no artifact path)";
}

// ---------------------------------------------------------------------------
// `/agents` selection model + action dispatch
// ---------------------------------------------------------------------------

/** A selectable row in the `/agents` selector. */
export interface AgentsSelectable {
	readonly agentId: string;
	readonly label: string;
	/** Ordered actions the selector offers for this row (primary first). */
	readonly actions: readonly (AgentRowAction | "refresh")[];
	readonly state: TaskStatus;
	readonly profile: string;
	readonly depth: number;
	readonly parentAgentId: string | null;
	readonly tmuxSession: string | null;
	readonly tmuxWindow: string | null;
}

/** Result of a selector key event. */
export type AgentsDispatch =
	| "rerender"
	| "done"
	| { readonly action: AgentRowAction; readonly id: string };

/** Durable state groups in selector order: active work first, then finished. */
const STATE_GROUP_ORDER: readonly TaskStatus[] = [
	"queued",
	"starting",
	"running",
	"succeeded",
	"failed",
	"timed_out",
	"cancelled",
	"interrupted",
];

/**
 * Immutable, selector-ready view over durable manifests. The refresh action is
 * always offered first, then durable tasks grouped by state (active work first)
 * with one selectable row per task. Labels are indented by the task's depth so
 * parent/descendant hierarchy is preserved in the displayed/selectable labels.
 */
export class AgentsView {
	/** Refresh sentinel followed by one selectable row per durable task. */
	readonly rows: AgentsSelectable[];
	/** SelectList items matching `rows`, in order. */
	readonly items: SelectItem[];
	/** Stable lookup of each selectable by its agent id, including refresh. */
	readonly byId: Map<string, AgentsSelectable>;
	private selectedIndex: number;

	constructor(manifests: readonly AgentManifest[]) {
		this.selectedIndex = 0;
		const depthBy = buildDepths(manifests);
		// Stable grouping by state (active tasks first), preserving list order.
		const ordered = [...manifests].sort((a, b) =>
			stateGroupIndex(a.state) - stateGroupIndex(b.state),
		);
		const body: AgentsSelectable[] = ordered.map((manifest) => ({
			agentId: manifest.agentId,
			label: applyDepth(depthBy.get(manifest.agentId) ?? 0, `${manifest.profile.name}: ${manifest.description}`),
			actions: actionsFor(manifest),
			state: manifest.state,
			profile: manifest.profile.name,
			depth: depthBy.get(manifest.agentId) ?? 0,
			parentAgentId: manifest.parentAgentId ?? null,
			tmuxSession: manifest.tmuxSession,
			tmuxWindow: manifest.tmuxWindow,
		}));
		const refresh: AgentsSelectable = {
			agentId: "__refresh__",
			label: "Refresh",
			actions: ["refresh"],
			state: "queued",
			profile: "",
			depth: 0,
			parentAgentId: null,
			tmuxSession: null,
			tmuxWindow: null,
		};
		this.rows = [refresh, ...body];
		this.byId = new Map([
			[refresh.agentId, refresh],
			...body.map((row) => [row.agentId, row] as const),
		]);
		this.items = [
			{ value: refresh.agentId, label: refresh.label, description: refresh.actions.join(" · ") },
			...body.map((row) => ({
				value: row.agentId,
				label: row.label,
				description: `${row.profile} · ${row.state} · ${row.actions.join(" · ")}`,
			})),
		];
	}

	selected(): AgentsSelectable {
		return this.rows[this.selectedIndex];
	}

	/** AgentsView holds no render cache; invalidate is a documented no-op. */
	invalidate(): void {}

	/**
	 * Dispatch a raw terminal key. Real terminals deliver escape sequences
	 * (`\x1b[B` for Down, `\x1b` for Escape, `\r` for Enter); we match them
	 * against the pi `Key` identifiers rather than the literal tokens, so the
	 * selector navigates and exits correctly in a live TUI.
	 */
	dispatch(input: string): AgentsDispatch {
		if (matchesKey(input, Key.down)) {
			this.selectedIndex = Math.min(this.selectedIndex + 1, this.rows.length - 1);
			return "rerender";
		}
		if (matchesKey(input, Key.up)) {
			this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
			return "rerender";
		}
		if (matchesKey(input, Key.escape)) {
			this.selectedIndex = this.rows.length - 1;
			return "done";
		}
		if (matchesKey(input, Key.enter)) {
			const selected = this.selected();
			// Entering on the refresh sentinel returns the selection to the
			// bottom; any real row yields its primary action.
			if (selected.agentId === "__refresh__") return "rerender";
			return { action: selected.actions[0] as AgentRowAction, id: selected.agentId };
		}
		return "rerender";
	}
}

/** Indent `text` by `depth` two-space steps, preserving any leading marker. */
function applyDepth(depth: number, text: string): string {
	return "  ".repeat(Math.max(0, depth)) + text;
}

function stateGroupIndex(state: TaskStatus): number {
	return STATE_GROUP_ORDER.indexOf(state);
}

/** Map each agent id to its depth computed via the parent chain. */
function buildDepths(manifests: readonly AgentManifest[]): Map<string, number> {
	const byId = new Map(manifests.map((m) => [m.agentId, m]));
	const depthOf = (agentId: string): number => {
		let depth = 0;
		let current = byId.get(agentId);
		while (current?.parentAgentId && byId.has(current.parentAgentId)) {
			depth++;
			current = byId.get(current.parentAgentId);
		}
		return depth;
	};
	const out = new Map<string, number>();
	for (const manifest of manifests) {
		out.set(manifest.agentId, depthOf(manifest.agentId));
	}
	return out;
}

// ---------------------------------------------------------------------------
// `/agents` runtime context + action dispatch
// ---------------------------------------------------------------------------

/** Minimal runtime context the `/agents` command needs; structural, not tied to pi. */
export interface AgentsCommandContext {
	readonly mode?: "tui" | "rpc" | "json" | "print";
	readonly ui: {
		readonly theme: { fg(color: string, text: string): string };
		readonly notify: (
			message: string,
			level?: "info" | "warning" | "error",
		) => void;
		readonly requestRender: () => void;
		readonly custom: <T = unknown>(
			factory: (
				tui: { requestRender(): void },
				theme: { fg(color: string, text: string): string },
				keybindings: unknown,
				done: (value?: T) => void,
			) => unknown,
		) => Promise<T>;
	};
}

/** Runtime guard for the `/agents` command context shape. */
export function isAgentsCommandContext(
	value: unknown,
): value is AgentsCommandContext {
	return (
		typeof value === "object" &&
		value !== null &&
		typeof (value as { ui?: { notify?: unknown } }).ui?.notify === "function"
	);
}

/**
 * Execute one `/agents` selection. Every call goes through the public
 * `SubagentManager` API (`list`, `stop`, `getResult`) and reports via
 * `ctx.ui.notify`. Retrieval always passes `wait = false` and a concrete
 * `AbortController` signal so a terminal task is not blocked waiting for a
 * result that already exists; attach is exposed as an exact command string and
 * is never executed through a shell.
 */
export async function performAgentAction(
	action: AgentRowAction | "refresh",
	selectable: AgentsSelectable,
	ctx: AgentsCommandContext,
	manager: SubagentManager,
): Promise<void> {
	const controller = new AbortController();
	switch (action) {
		case "attach":
			ctx.ui.notify(attachCommandFor(selectable) ?? "no attached tmux window");
			return;
		case "stop": {
			const response = await manager.stop(selectable.agentId);
			ctx.ui.notify(stopSummary(response));
			return;
		}
		case "retrieve": {
			const response = await manager.getResult(
				selectable.agentId,
				false,
				controller.signal,
			);
			ctx.ui.notify(retrieveSummary(response));
			return;
		}
		case "path": {
			const response = await manager.getResult(
				selectable.agentId,
				false,
				controller.signal,
			);
			ctx.ui.notify(artifactPathFor(response));
			return;
		}
		case "refresh":
			await manager.list();
			ctx.ui.requestRender();
			return;
		default:
			return;
	}
}

/**
 * The `/agents` command. Builds a durable, state-grouped selector via the public
 * manager API and drives a real Pi `SelectList`, delegating raw terminal input
 * to it and requesting a TUI rerender after every key. Task 12 owns wiring this
 * into `pi.registerCommand`; this function is the self-contained handler.
 */
export async function runAgentsCommand(
	ctx: AgentsCommandContext,
	manager: SubagentManager,
): Promise<void> {
	if (!isAgentsCommandContext(ctx)) return;
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/agents requires interactive mode", "error");
		return;
	}

	const view = new AgentsView(await manager.list());
	const theme = ctx.ui.theme;
	const selectListTheme: SelectListTheme = {
		selectedPrefix: (text) => style(theme, text),
		selectedText: (text) => style(theme, text),
		description: (text) => style(theme, text),
		scrollInfo: (text) => style(theme, text),
		noMatch: (text) => style(theme, text),
	};

	await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
		const selectList = new SelectList(view.items, Math.min(view.items.length, 10), selectListTheme);

		selectList.onCancel = () => done();
		selectList.onSelect = async (item) => {
			const selectable = view.byId.get(item.value);
			if (!selectable) {
				done();
				return;
			}
			// Refresh re-lists and rerenders; any other action dispatches through
			// the public manager API and closes the selector.
			if (selectable.actions.includes("refresh")) {
				await performAgentAction("refresh", selectable, ctx, manager);
			} else {
				await performAgentAction(selectable.actions[0], selectable, ctx, manager);
				done();
			}
		};

		return {
			render(width: number): string[] {
				return selectList.render(width);
			},
			invalidate(): void {
				selectList.invalidate();
				view.invalidate();
			},
			handleInput(data: string): void {
				// Raw terminal input (escape sequences) — delegate to the real
				// SelectList, which performs its own key handling.
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

/** Paint `text` with the live theme when available, otherwise return it raw. */
function style(theme: { fg(color: string, text: string): string }, text: string): string {
	try {
		return theme.fg("muted", text);
	} catch {
		return text;
	}
}
