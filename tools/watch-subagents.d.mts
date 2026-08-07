export interface RunInfo {
	dir: string;
	session: string;
	start: Date;
	counts: Record<string, number>;
	live: boolean;
}
export interface TaskInfo {
	taskId: string;
	agent: string;
	model: string;
	cwd: string;
	statusPath: string;
	outputPath: string;
	stderrPath: string;
	status?: Record<string, unknown> | null;
}
export interface Run {
	dir: string;
	session: string;
	tasks: TaskInfo[];
}
export interface TailState {
	offset: number;
	partial: string;
}
export interface StreamState {
	lines: string[];
	current: string;
	maxLines: number;
}
export const LIVE_STATES: Set<string>;
export const TERMINAL_STATES: Set<string>;
export function findRuns(baseDir?: string): RunInfo[];
export function inspectDir(dir: string): RunInfo | null;
export function readStatus(statusPath: string): Record<string, unknown> | null;
export function listRunsText(runs: RunInfo[]): string;
export function resolveRunArg(
	arg: string | undefined,
	baseDir?: string,
): { run: RunInfo | null; error: string | null };
export function formatAge(ms: number): string;
export function loadRun(dir: string): Run;
export function createTailState(): TailState;
export function nextEvents(
	outputPath: string,
	state: TailState,
): { events: Record<string, unknown>[]; state: TailState };
export function createStreamState(maxLines?: number): StreamState;
export function accumulate(acc: StreamState, event: unknown): void;
export function summarizeArgs(args: unknown): string;
export function summarizeResult(
	toolName: string,
	event: Record<string, unknown>,
): string;
export function renderFullOutput(task: TaskInfo): string;
export function formatDuration(startedAt?: string, finishedAt?: string): string;
export function formatTokens(n: number): string;
export function aggregateStats(
	statuses: Array<Record<string, unknown> | null>,
): {
	counts: Record<string, number>;
	totalTokens: number;
	totalCost: number;
	turns: number;
};
export function formatStatus(task: TaskInfo): string;
export function computeGrid(n: number): { cols: number; rows: number };
export function truncateLine(s: string, width: number): string;
export function renderTaskLines(
	task: TaskInfo,
	stream: StreamState,
	width: number,
	height: number,
	selected: boolean,
): { lines: string[]; title: { text: string; selected: boolean } };
export function renderHeader(opts: {
	run: Run;
	paused: boolean;
	live: boolean;
	width: number;
}): string[];
export function renderFrame(opts: {
	run: Run;
	streams: Map<string, StreamState>;
	selected: number;
	paused: boolean;
	live: boolean;
	width: number;
	height: number;
}): {
	text: string;
	titles: Array<{
		row: number;
		col: number;
		len: number;
		state: string;
		selected: boolean;
	}>;
};
export function applyTuiStyles(
	text: string,
	titles: Array<{
		row: number;
		col: number;
		len: number;
		state: string;
		selected: boolean;
	}>,
): string;
