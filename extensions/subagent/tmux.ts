// Full-window tmux client for the `subagent` extension.
//
// Task 5 owns only the tmux *topology* the manager needs to launch and
// inspect child windows: one tmux session per parent (`pi-<parent-id>`) with a
// detached `main` keeper window, and one full window per child
// (`subagent-<agent-id>`). Every tmux command is built as an argument array
// and run through an injected {@link TmuxExecFile} (Node `execFile`
// semantics) — no shell is ever invoked and no path or prompt is interpolated
// into a command string.
//
// Identity model (see
// docs/superpowers/specs/2026-08-22-subagent-extension-rewrite-design.md):
//
// - Parent tmux session — `pi-<parent-id>`
// - Child agent window — `subagent-<agent-id>`
//
// Both names are derived only from validated four-character
// lowercase `a-z0-9` ids (see {@link isShortId}); anything else is rejected
// before a name is constructed.

import { execFile as defaultExecFile } from "node:child_process";

import { isShortId } from "./types.ts";

/** Prefix for the per-parent tmux session, e.g. `pi-a7k2`. */
export const PARENT_SESSION_PREFIX = "pi-";

/** Prefix for the per-child full window, e.g. `subagent-q9xm`. */
export const AGENT_WINDOW_PREFIX = "subagent-";

/** The fixed keeper window name created inside a freshly made parent session. */
export const MAIN_KEEPER_WINDOW = "main";

/** Result returned by a tmux command: captured stdout and stderr. */
export interface TmuxResult {
	stdout: string;
	stderr: string;
}

/**
 * An injected tmux executor with Node `execFile` semantics: run the tmux
 * binary with an argument array, resolve with captured output, and reject on
 * any non-zero exit (including a missing binary). The program is never a shell
 * and arguments are never string-joined.
 */
export type TmuxExecFile = (args: string[]) => Promise<TmuxResult>;

/** A resolved child agent window inside the parent session. */
export interface AgentWindow {
	/** The full window name, e.g. `subagent-q9xm`. */
	readonly name: string;
	/** The session-scoped tmux target, e.g. `pi-a7k2:subagent-q9xm`. */
	readonly target: string;
	/** The parent session this window lives in. */
	readonly sessionName: string;
}

/** Options accepted by {@link createAgentWindow}. */
export interface CreateAgentWindowOptions {
	/** Validated four-character agent id; the window name is `subagent-<id>`. */
	agentId: string;
	/** Working directory for the window program, passed as a single argv element. */
	cwd: string;
	/** Program the window runs (runner request), passed as one argv element. */
	launchCommand: string;
	/**
	 * Optional lifecycle signal forwarded to the underlying `new-window` call so
	 * a deliberate scheduler `stop()` cancels an in-flight window creation. The
	 * window is only created once the call resolves; aborting before then leaves
	 * nothing behind.
	 */
	signal?: AbortSignal;
}

/**
 * Validate and freeze a {@link CreateAgentWindowOptions} object. The agent id
 * is checked up front so a name is only ever derived from an id that is
 * already known to be a valid `subagent-xxxx` candidate.
 *
 * @throws when `agentId` is not a valid short id.
 */
export function createAgentWindowInput(
	input: CreateAgentWindowOptions,
): CreateAgentWindowOptions {
	if (!isShortId(input.agentId)) {
		throw new Error(
			`invalid agent id: ${stringifyInput(input.agentId)} (expected a four-character a-z0-9 id)`,
		);
	}
	return Object.freeze({ ...input });
}

function stringifyInput(value: unknown): string {
	if (typeof value === "string") return value;
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	try {
		return JSON.stringify(value) ?? String(value);
	} catch {
		return String(value);
	}
}

/** The public tmux topology client. */
export interface TmuxClient {
	/** The parent tmux session this client manages, e.g. `pi-a7k2`. */
	readonly sessionName: string;
	/** The current parent session name (equal to {@link sessionName}). */
	currentSessionId(): Promise<string>;
	/** Ensure the parent session exists, creating a detached keeper when absent. */
	ensureParentSession(): Promise<{ created: boolean; reused: boolean }>;
	/** Create (or reuse) a detached full window for one agent. */
	createAgentWindow(
		options: CreateAgentWindowOptions,
	): Promise<AgentWindow>;
	/** Whether an agent window with the given name exists in the parent session. */
	windowExists(name: string): Promise<boolean>;
	/** List agent windows known to the parent session. */
	listAgentWindows(): Promise<AgentWindow[]>;
	/**
	 * Close an agent window, but only once the caller has established a durable
	 * terminal result for it. Returns `true` when the window was killed and
	 * `false` when the close was refused.
	 */
	closeVerifiedWindow(
		name: string,
		opts: { durableResult: boolean },
	): Promise<boolean>;
	/** Build the session-scoped tmux target for a window name. */
	targetFor(name: string): string;
	/**
	 * Build the exact, human-readable attach display text for a window. This is
	 * display-only: it is never executed through a shell by this client.
	 */
	attachCommand(name: string): string;
}

class TmuxClientImpl implements TmuxClient {
	readonly sessionName: string;

	private readonly exec: TmuxExecFile;

	constructor(exec: TmuxExecFile, parentId: string) {
		if (!isShortId(parentId)) {
			throw new Error(
				`invalid parent id: ${stringifyInput(parentId)} (expected a four-character a-z0-9 id)`,
			);
		}
		this.exec = exec;
		this.sessionName = `${PARENT_SESSION_PREFIX}${parentId}`;
	}

	currentSessionId(): Promise<string> {
		return Promise.resolve(this.sessionName);
	}

	async ensureParentSession(): Promise<{
		created: boolean;
		reused: boolean;
	}> {
		if (await this.sessionExists()) {
			return { created: false, reused: true };
		}
		try {
			await this.exec([
				"new-session",
				"-d",
				"-s",
				this.sessionName,
				"-n",
				MAIN_KEEPER_WINDOW,
			]);
			return { created: true, reused: false };
		} catch (error) {
			// A concurrent creator may win the race; treat a duplicate-session
			// error as a reuse after re-confirming the session now exists.
			if (isDuplicateSession(error) && (await this.sessionExists())) {
				return { created: false, reused: true };
			}
			throw error;
		}
	}

	async createAgentWindow(
		options: CreateAgentWindowOptions,
	): Promise<AgentWindow> {
		const { agentId, signal } = options;
		// Re-validate here so the caller cannot bypass createAgentWindowInput.
		if (!isShortId(agentId)) {
			throw new Error(
				`invalid agent id: ${stringifyInput(agentId)} (expected a four-character a-z0-9 id)`,
			);
		}
		const name = `${AGENT_WINDOW_PREFIX}${agentId}`;
		if (await this.windowExists(name)) {
			return { name, target: this.targetFor(name), sessionName: this.sessionName };
		}
		// Abort before touching tmux if the lifecycle signal fires first.
		signal?.throwIfAborted();
		// The parent session may have disappeared since the extension resolved
		// its identity (e.g. the tmux server restarted); recreate the detached
		// keeper so the spawn target always exists instead of failing with
		// "can't find window".
		await this.ensureParentSession();
		// Detached full window: created off-screen and never focused. The cwd and
		// launch command are passed as distinct argv elements so hostile paths or
		// shell metacharacters never reach a shell interpreter.
		await this.exec([
			"new-window",
			"-d",
			"-t",
			this.sessionName,
			"-n",
			name,
			"-c",
			options.cwd,
			options.launchCommand,
		]);
		return { name, target: this.targetFor(name), sessionName: this.sessionName };
	}

	async windowExists(name: string): Promise<boolean> {
		// A lookup is a read, not a mutation, so an unvalidated name is simply
		// "not present" rather than an error — only mutation/display ops validate.
		const windows = await this.listWindows();
		return windows.includes(name);
	}

	async listAgentWindows(): Promise<AgentWindow[]> {
		const windows = await this.listWindows();
		return windows
			.filter(isAgentWindowName)
			.map((name) => ({
				name,
				target: this.targetFor(name),
				sessionName: this.sessionName,
			}));
	}

	async closeVerifiedWindow(
		name: string,
		opts: { durableResult: boolean },
	): Promise<boolean> {
		assertAgentWindowName(name);
		// Orphan windows are only removed once the caller has established a
		// durable terminal result, so a runner that is still producing output is
		// never destroyed by an early caller.
		if (!opts?.durableResult) return false;
		await this.exec(["kill-window", "-t", this.targetFor(name)]);
		return true;
	}

	targetFor(name: string): string {
		assertAgentWindowName(name);
		return `${this.sessionName}:${name}`;
	}

	attachCommand(name: string): string {
		assertAgentWindowName(name);
		// Display-only attach text: never executed through a shell here.
		return `tmux attach -t ${this.sessionName} \\; select-window -t ${name}`;
	}

	private async sessionExists(): Promise<boolean> {
		try {
			await this.exec(["has-session", "-t", this.sessionName]);
			return true;
		} catch {
			return false;
		}
	}

	private async listWindows(): Promise<string[]> {
		try {
			const { stdout } = await this.exec([
				"list-windows",
				"-t",
				this.sessionName,
				"-F",
				"#{window_name}",
			]);
			return stdout
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.length > 0);
		} catch {
			// A missing parent session has no windows rather than an error.
			return [];
		}
	}
}

/**
 * Create a tmux topology client bound to a validated parent id. The client
 * derives its session name from that id and validates every child id before
 * constructing a tmux name.
 *
 * @throws when `parentId` is not a valid four-character short id.
 */
export function createTmuxClient(
	execFile: TmuxExecFile,
	parentId: string,
): TmuxClient {
	return new TmuxClientImpl(execFile, parentId);
}

/**
 * Build a production {@link TmuxExecFile} around a Node `execFile`-style
 * function (defaults to `node:child_process.execFile`). The tmux binary is the
 * program and the tmux arguments are the argv array; output is normalized to a
 * {@link TmuxResult}. Never invokes a shell.
 */
export function nodeTmuxExecutor(
	execFile: typeof defaultExecFile = defaultExecFile,
): TmuxExecFile {
	return (args) =>
		new Promise<TmuxResult>((resolve, reject) => {
			execFile("tmux", args, (error, stdout, stderr) => {
				if (error) {
					reject(error);
					return;
				}
				resolve({
					stdout: stdout.toString(),
					stderr: stderr.toString(),
				});
			});
		});
}

// ---------------------------------------------------------------------------
// Name validation (all tmux names derive from validated four-character ids)
// ---------------------------------------------------------------------------

/** Whether `name` is a well-formed `subagent-xxxx` agent-window name. */
function isAgentWindowName(name: string): boolean {
	if (!name.startsWith(AGENT_WINDOW_PREFIX)) return false;
	const suffix = name.slice(AGENT_WINDOW_PREFIX.length);
	return isShortId(suffix);
}

/**
 * Throw unless `name` is a valid `subagent-xxxx` window name. Every tmux target
 * and display text is gated behind this so no name is ever built from an
 * unvalidated id.
 */
function assertAgentWindowName(name: string): void {
	if (!isAgentWindowName(name)) {
		throw new Error(
			`invalid agent window name: ${stringifyInput(name)} (expected ${AGENT_WINDOW_PREFIX}<four-char a-z0-9 id>)`,
		);
	}
}

function isDuplicateSession(error: unknown): boolean {
	return error instanceof Error && /duplicate session/i.test(error.message);
}
