// Task 11 — compact rendering, widget/footer, and `/agents`.
//
// Pure, dependency-free rendering primitives for the subagent extension plus the
// interactive `/agents` command. Every function here is intentionally side-effect
// free and string-oriented so it is usable by both the TUI (Task 12 wires it into
// `setWidget` / `setFooter` / `registerMessageRenderer`) and RPC/tool-call wiring
// (which expects plain string arrays). The only exception is `runAgentsCommand`,
// which owns the live TUI selector; it composes the pure helpers above and calls
// `ctx.ui.requestRender()` / `performAgentAction` after every state change.
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
	const handle = `subagent-${value.agentId}`;
	if (isForegroundCompletion(value)) return "⎿ Done";
	if (value.state === "queued") return `⎿ Queued as ${handle}…`;
	return `⎿ Running as ${handle}…`;
}

/**
 * Factory mirroring the pi tool-renderer contract
 * (`renderCall(args, theme, context)` / `renderResult(result, options, theme, context)`).
 * The compact form returns plain strings so RPC wiring is trivial; the TUI
 * layer reuses the same helpers and applies theming on top.
 */
export function createToolRenderers() {
	return {
		renderCall: (
			request: AgentRequest,
			_context?: unknown,
			_theme?: unknown,
		): string => renderCall(request),
		renderResult: (
			value: AgentReceipt | ResultResponse,
			options: { expanded?: boolean } = {},
			_theme?: unknown,
		): string => renderResult(value, options),
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

/** The action the `/agents` UI performs for a task in the given state. */
export type AgentRowAction = "attach" | "stop" | "retrieve";

/** Classify a durable manifest into the single sensible `/agents` action. */
export function classifyAgentRow(manifest: AgentManifest): AgentRowAction {
	if (isTerminalState(manifest.state)) return "retrieve";
	if (manifest.state === "running" || manifest.state === "starting") {
		return "attach";
	}
	return "stop";
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
	readonly action: AgentRowAction | "refresh";
	readonly state: TaskStatus;
	readonly profile: string;
	readonly tmuxSession: string | null;
	readonly tmuxWindow: string | null;
	readonly artifactDir: string | null;
}

/** Result of a selector key event. */
export type AgentsDispatch =
	| "rerender"
	| "done"
	| { readonly action: AgentRowAction | "refresh"; readonly id: string };

/**
 * Immutable, key-driven selector over durable manifests. The refresh action is
 * always offered first, then one row per task classified by its state.
 */
export class AgentsView {
	readonly rows: AgentsSelectable[];
	private selectedIndex: number;

	constructor(manifests: readonly AgentManifest[]) {
		this.selectedIndex = 0;
		this.rows = [
			{
				agentId: "__refresh__",
				label: "Refresh",
				action: "refresh",
				state: "queued",
				profile: "",
				tmuxSession: null,
				tmuxWindow: null,
				artifactDir: null,
			},
			...manifests.map((manifest) => ({
				agentId: manifest.agentId,
				label: `${manifest.profile.name}: ${manifest.description}`,
				action: classifyAgentRow(manifest),
				state: manifest.state,
				profile: manifest.profile.name,
				tmuxSession: manifest.tmuxSession,
				tmuxWindow: manifest.tmuxWindow,
				artifactDir: null,
			})),
		];
	}

	selected(): AgentsSelectable {
		return this.rows[this.selectedIndex];
	}

	/** AgentsView holds no render cache; invalidate is a documented no-op. */
	invalidate(): void {}

	dispatch(input: string): AgentsDispatch {
		switch (input) {
			case "down":
				this.selectedIndex = Math.min(
					this.selectedIndex + 1,
					this.rows.length - 1,
				);
				return "rerender";
			case "up":
				this.selectedIndex = Math.max(this.selectedIndex - 1, 0);
				return "rerender";
			case "escape":
				this.selectedIndex = this.rows.length - 1;
				return "done";
			case "enter": {
				const selected = this.selected();
				return { action: selected.action, id: selected.agentId };
			}
			default:
				return "rerender";
		}
	}
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

/** Extra action keys the live selector dispatches beyond the classification. */
type AgentsExecAction = AgentRowAction | "path" | "refresh";

/**
 * Minimal structural view of the public manager surface the `/agents` command
 * needs (`list`, `stop`, `getResult`). The concrete `SubagentManager` is
 * assignable to this, so the command stays decoupled from the manager's internal
 * `wait`/`signal` plumbing while still driving the real public API.
 */
export interface AgentsManagerApi {
	list(): Promise<AgentManifest[]>;
	stop(agentId: string): Promise<StopResponse>;
	getResult(agentId: string): Promise<ResultResponse>;
}

/**
 * Minimal structural view of the public manager surface the `/agents` command
 * needs (`list`, `stop`, `getResult`). The concrete `SubagentManager` is
 * assignable to this, so the command stays decoupled from the manager's internal
 * `wait`/`signal` plumbing while still driving the real public API.
 */
export interface AgentsManagerApi {
	list(): Promise<AgentManifest[]>;
	stop(agentId: string): Promise<StopResponse>;
	getResult(agentId: string): Promise<ResultResponse>;
}

/**
 * Execute one `/agents` selection. Every call goes through the public
 * `SubagentManager` API and reports via `ctx.ui.notify`. Attach is exposed as an
 * exact command string; it is never executed through a shell.
 */
export async function performAgentAction(
	action: AgentsExecAction,
	selectable: AgentsSelectable,
	ctx: AgentsCommandContext,
	manager: SubagentManager,
): Promise<void> {
	// The UI only needs the single-arg public surface; narrow to avoid the
	// manager's internal `wait`/`signal` plumbing. The real `SubagentManager`
	// satisfies this shape via structural assignability.
	const api: AgentsManagerApi = manager as unknown as AgentsManagerApi;
	switch (action) {
		case "attach":
			ctx.ui.notify(attachCommandFor(selectable) ?? "no attached tmux window");
			return;
		case "stop": {
			const response = await api.stop(selectable.agentId);
			ctx.ui.notify(stopSummary(response));
			return;
		}
		case "retrieve": {
			const response = await api.getResult(selectable.agentId);
			ctx.ui.notify(retrieveSummary(response));
			return;
		}
		case "path": {
			const response = await api.getResult(selectable.agentId);
			ctx.ui.notify(artifactPathFor(response));
			return;
		}
		case "refresh":
			await api.list();
			ctx.ui.requestRender();
			return;
		default:
			return;
	}
}

/**
 * The `/agents` command. Builds a durable, state-grouped selector via the public
 * manager API and drives TUI selection, requesting a rerender after every state
 * change and dispatching the selected action through `performAgentAction`.
 *
 * Task 12 owns wiring this into `pi.registerCommand`; this function is the
 * self-contained handler.
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

	await ctx.ui.custom<void>((tui, _theme, _keybindings, done) => {
		return {
			render(width: number): string[] {
				const selectedId = view.selected().agentId;
				return view.rows.map((row, index) => {
					const marker = row.agentId === selectedId ? "▸ " : "  ";
					return truncateToWidth(marker + row.label, width);
				});
			},
			invalidate(): void {
				view.invalidate();
			},
			handleInput(data: string): void {
				const outcome = view.dispatch(data);
				tui.requestRender();
				if (outcome === "done") {
					done();
					return;
				}
				if (
					outcome &&
					typeof outcome === "object" &&
					"action" in outcome
				) {
					done();
					void performAgentAction(
						outcome.action,
						view.selected(),
						ctx,
						manager,
					);
				}
			},
		};
	});
}
