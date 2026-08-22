import { describe, it, expect } from "vitest";

import {
	createTmuxClient,
	createAgentWindowInput,
	nodeTmuxExecutor,
	PARENT_SESSION_PREFIX,
	AGENT_WINDOW_PREFIX,
	type TmuxExecFile,
	type TmuxResult,
} from "../tmux.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * An executor spy that records every argument array and delegates to an
 * optional handler that can inspect args or return/fake results.
 */
function spyExec(
	handler?: (args: string[]) => TmuxResult | Promise<TmuxResult>,
): { exec: TmuxExecFile; calls: string[][] } {
	const calls: string[][] = [];
	const exec: TmuxExecFile = async (args) => {
		calls.push(args);
		if (handler) return handler(args);
		return { stdout: "", stderr: "" };
	};
	return { exec, calls };
}

/** An executor that always rejects, simulating a missing tmux binary. */
function failingExec(
	error: unknown = Object.assign(new Error("tmux: not found"), {
		code: "ENOENT",
	}),
): TmuxExecFile {
	return async () => {
		throw error;
	};
}

const PARENT = "a7k2";
const SESSION = `${PARENT_SESSION_PREFIX}${PARENT}`;

// ---------------------------------------------------------------------------
// Client construction + id validation
// ---------------------------------------------------------------------------

describe("createTmuxClient", () => {
	it("binds the parent session name and derives per-parent identity", async () => {
		const client = createTmuxClient(spyExec().exec, PARENT);
		expect(client.sessionName).toBe(SESSION);
		await expect(client.currentSessionId()).resolves.toBe(SESSION);
	});

	it("rejects an invalid parent id before deriving any tmux name", () => {
		for (const bad of [
			"",
			"a7k",
			"abcd1",
			"A7K2",
			"a7k_",
			"a7k2zz",
			undefined,
			null,
			1234,
		]) {
			expect(
				() => createTmuxClient(spyExec().exec, bad as unknown as string),
			).toThrow(/invalid parent id/);
		}
	});
});

// ---------------------------------------------------------------------------
// ensureParentSession — current-session reuse and detached keeper creation
// ---------------------------------------------------------------------------

describe("ensureParentSession", () => {
	it("reuses the current pi-xxxx session without creating anything", async () => {
		const { exec, calls } = spyExec((args) => {
			if (args[0] === "has-session") return { stdout: "", stderr: "" };
			return { stdout: "", stderr: "" };
		});
		const client = createTmuxClient(exec, PARENT);

		const result = await client.ensureParentSession();

		expect(result).toEqual({ created: false, reused: true });
		expect(calls).toEqual([["has-session", "-t", SESSION]]);
		expect(calls.some((c) => c[0] === "new-session")).toBe(false);
	});

	it("creates the parent session detached with a main keeper window when absent", async () => {
		const { exec, calls } = spyExec((args) => {
			if (args[0] === "has-session") {
				throw new Error("no current session");
			}
			return { stdout: "", stderr: "" };
		});
		const client = createTmuxClient(exec, PARENT);

		const result = await client.ensureParentSession();

		expect(result).toEqual({ created: true, reused: false });
		const created = calls.find((c) => c[0] === "new-session");
		expect(created, "new-session must be called").toBeDefined();
		// Detached keeper: -d, session name, and a 'main' keeper window.
		expect(created).toEqual([
			"new-session",
			"-d",
			"-s",
			SESSION,
			"-n",
			"main",
		]);
	});

	it("treats a duplicate-session race as a reuse after re-checking", async () => {
		let hasSessionCalls = 0;
		const { exec, calls } = spyExec((args) => {
			if (args[0] === "has-session") {
				hasSessionCalls++;
				// First probe reports the session absent; after the losing
				// new-session the re-check confirms it now exists.
				if (hasSessionCalls === 1) throw new Error("no current session");
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "new-session") {
				throw new Error("duplicate session");
			}
			return { stdout: "", stderr: "" };
		});
		const client = createTmuxClient(exec, PARENT);

		const result = await client.ensureParentSession();

		expect(result).toEqual({ created: false, reused: true });
		// has-session (absent), then new-session (losing race), then the
		// re-checking has-session (now confirmed).
		expect(calls[0]).toEqual(["has-session", "-t", SESSION]);
		expect(calls[1]).toEqual([
			"new-session",
			"-d",
			"-s",
			SESSION,
			"-n",
			"main",
		]);
		expect(calls[2]).toEqual(["has-session", "-t", SESSION]);
	});

	it("surfaces a missing tmux error instead of masking it", async () => {
		const exec = failingExec();
		const client = createTmuxClient(exec, PARENT);

		await expect(client.ensureParentSession()).rejects.toThrow();
	});
});

// ---------------------------------------------------------------------------
// createAgentWindow — detached full windows, no focus changes, arg safety
// ---------------------------------------------------------------------------

describe("createAgentWindow", () => {
	it("creates a detached subagent-xxxx window with argument-array safety", async () => {
		const { exec, calls } = spyExec((args) => {
			if (args[0] === "list-windows") {
				return { stdout: "", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const client = createTmuxClient(exec, PARENT);

		const hostileCwd = "/home/a; rm -rf /";
		const launchCommand = `node /opt/run.js --prompt=${"$(whoami)"}`;

		const window = await client.createAgentWindow({
			agentId: "q9xm",
			cwd: hostileCwd,
			launchCommand,
		});

		expect(window.name).toBe(`${AGENT_WINDOW_PREFIX}q9xm`);
		expect(window.target).toBe(`${SESSION}:${AGENT_WINDOW_PREFIX}q9xm`);

		const created = calls.find((c) => c[0] === "new-window");
		expect(created).toBeDefined();
		// Detached full window: -d, targeted at the parent session, -n name.
		expect(created![0]).toBe("new-window");
		expect(created).toContain("-d");
		expect(created).toContain("-t");
		expect(created).toContain(SESSION);
		expect(created).toContain("-n");
		expect(created).toContain(`${AGENT_WINDOW_PREFIX}q9xm`);
		// The hostile cwd and launch command each survive as single argv elements.
		expect(created).toContain(hostileCwd);
		expect(created).toContain(launchCommand);
	});

	it("reuses an existing subagent window instead of creating a duplicate", async () => {
		const existing = `${AGENT_WINDOW_PREFIX}q9xm`;
		const { exec, calls } = spyExec((args) => {
			if (args[0] === "list-windows") {
				return { stdout: `${existing}\n`, stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const client = createTmuxClient(exec, PARENT);

		const window = await client.createAgentWindow({
			agentId: "q9xm",
			cwd: "/tmp/x",
			launchCommand: "noop",
		});

		expect(window.name).toBe(existing);
		expect(calls.some((c) => c[0] === "new-window")).toBe(false);
	});

	it("rejects an invalid agent id via createAgentWindowInput before deriving a name", () => {
		expect(() =>
			createAgentWindowInput({
				agentId: "bad!",
				cwd: "/tmp/x",
				launchCommand: "noop",
			}),
		).toThrow(/invalid agent id/);
	});

	it("rejects an invalid agent id via createAgentWindow before deriving a name", async () => {
		const { exec, calls } = spyExec();
		const client = createTmuxClient(exec, PARENT);

		await expect(
			client.createAgentWindow({
				agentId: "bad!",
				cwd: "/tmp/x",
				launchCommand: "noop",
			}),
		).rejects.toThrow(/invalid agent id/);
		expect(calls).toHaveLength(0);
	});

	it("never selects or focuses a window during creation", async () => {
		const { exec, calls } = spyExec((args) => {
			if (args[0] === "list-windows") return { stdout: "", stderr: "" };
			return { stdout: "", stderr: "" };
		});
		const client = createTmuxClient(exec, PARENT);

		await client.createAgentWindow({
			agentId: "q9xm",
			cwd: "/tmp/x",
			launchCommand: "noop",
		});

		for (const args of calls) {
			expect(args).not.toContain("select-window");
			expect(args).not.toContain("select-pane");
		}
	});
});

// ---------------------------------------------------------------------------
// window list / existence
// ---------------------------------------------------------------------------

describe("windowExists and listAgentWindows", () => {
	it("lists only subagent-xxxx windows from the parent session", async () => {
		const { exec } = spyExec((args) => {
			if (args[0] === "list-windows") {
				return {
					stdout: `${AGENT_WINDOW_PREFIX}q9xm\n${AGENT_WINDOW_PREFIX}4vnr\nmain\n${PARENT_SESSION_PREFIX}-junk\n`,
					stderr: "",
				};
			}
			return { stdout: "", stderr: "" };
		});
		const client = createTmuxClient(exec, PARENT);

		const windows = await client.listAgentWindows();

		expect(windows.map((w) => w.name)).toEqual([
			`${AGENT_WINDOW_PREFIX}q9xm`,
			`${AGENT_WINDOW_PREFIX}4vnr`,
		]);
		for (const window of windows) {
			expect(window.target).toBe(`${SESSION}:${window.name}`);
			expect(window.sessionName).toBe(SESSION);
		}
	});

	it("returns an empty list when the parent session has no agent windows", async () => {
		const { exec } = spyExec((args) => {
			if (args[0] === "list-windows") return { stdout: "main\n", stderr: "" };
			return { stdout: "", stderr: "" };
		});
		const client = createTmuxClient(exec, PARENT);
		expect(await client.listAgentWindows()).toEqual([]);
	});

	it("treats a missing parent session as having no windows", async () => {
		const { exec } = spyExec((args) => {
			if (args[0] === "list-windows") {
				throw new Error("no current session");
			}
			return { stdout: "", stderr: "" };
		});
		const client = createTmuxClient(exec, PARENT);
		expect(await client.listAgentWindows()).toEqual([]);
	});

	it("reports window existence precisely and never treats junk as a target", async () => {
		const existing = `${AGENT_WINDOW_PREFIX}q9xm`;
		const { exec } = spyExec((args) => {
			if (args[0] === "list-windows") {
				return { stdout: `${existing}\n`, stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const client = createTmuxClient(exec, PARENT);

		expect(await client.windowExists(existing)).toBe(true);
		// An unvalidated id is simply "not present" rather than a tmux target.
		expect(await client.windowExists("subagent-missing")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// verified close — only closes after a durable terminal result
// ---------------------------------------------------------------------------

describe("closeVerifiedWindow", () => {
	it("refuses to close without a durable terminal result", async () => {
		const { exec, calls } = spyExec();
		const client = createTmuxClient(exec, PARENT);

		const closed = await client.closeVerifiedWindow(`${AGENT_WINDOW_PREFIX}q9xm`, {
			durableResult: false,
		});

		expect(closed).toBe(false);
		expect(calls).toHaveLength(0);
	});

	it("closes only the agent window (not the parent session) once a durable result exists", async () => {
		const { exec, calls } = spyExec();
		const client = createTmuxClient(exec, PARENT);

		const closed = await client.closeVerifiedWindow(`${AGENT_WINDOW_PREFIX}q9xm`, {
			durableResult: true,
		});

		expect(closed).toBe(true);
		const killed = calls.find((c) => c[0] === "kill-window");
		expect(killed).toEqual([
			"kill-window",
			"-t",
			`${SESSION}:${AGENT_WINDOW_PREFIX}q9xm`,
		]);
		// The parent session itself is never killed.
		expect(calls.some((c) => c[0] === "kill-session")).toBe(false);
	});

	it("throws on an invalid window name for mutation/target operations", () => {
		const client = createTmuxClient(spyExec().exec, PARENT);
		expect(() => client.targetFor("subagent-missing")).toThrow(
			/invalid agent window name/,
		);
		expect(() => client.attachCommand("subagent-missing")).toThrow(
			/invalid agent window name/,
		);
	});
});

// ---------------------------------------------------------------------------
// target + attach display text
// ---------------------------------------------------------------------------

describe("targetFor and attachCommand", () => {
	it("builds a session-scoped target for a valid agent window", () => {
		const client = createTmuxClient(spyExec().exec, PARENT);
		expect(
			client.targetFor(`${AGENT_WINDOW_PREFIX}q9xm`),
		).toBe(`${SESSION}:${AGENT_WINDOW_PREFIX}q9xm`);
	});

	it("produces the exact attach display text without executing anything", () => {
		const client = createTmuxClient(spyExec().exec, PARENT);
		expect(client.attachCommand(`${AGENT_WINDOW_PREFIX}q9xm`)).toBe(
			`tmux attach -t ${SESSION} \\; select-window -t ${AGENT_WINDOW_PREFIX}q9xm`,
		);
	});
});

// ---------------------------------------------------------------------------
// nodeTmuxExecutor — argument-array wrapper around node:child_process
// ---------------------------------------------------------------------------

describe("nodeTmuxExecutor", () => {
	it("passes tmux plus an argument array and rejects on non-zero exit", async () => {
		const { execFile, calls } = mockExecFile();
		const executor = nodeTmuxExecutor(execFile);

		await executor(["has-session", "-t", SESSION]);

		expect(calls).toEqual([["tmux", ["has-session", "-t", SESSION]]]);
	});

	it("rejects with the spawned error and captured output", async () => {
		const bad = Object.assign(new Error("tmux: no current session"), {
			code: "ENOENT",
		});
		const { execFile } = mockExecFile((file, args, cb) => {
			cb(bad, "", "no current session");
		});
		const executor = nodeTmuxExecutor(execFile);

		await expect(executor(["new-session"])).rejects.toThrow(
			"no current session",
		);
	});
});

/**
 * Capture the exact positional arguments a Node `execFile`-style function is
 * called with, so the test can assert the program and argv array are distinct.
 */
function mockExecFile(
	impl?: (
		file: string,
		args: string[],
		cb: (err: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void,
	) => void,
): {
	execFile: typeof import("node:child_process").execFile;
	calls: Array<[string, string[]]>;
} {
	const calls: Array<[string, string[]]> = [];
	const execFile = ((
		file: string,
		args: string[],
		cb: (err: NodeJS.ErrnoException | null, stdout: string, stderr: string) => void,
	) => {
		calls.push([file, args]);
		if (impl) {
			impl(file, args, cb);
		} else {
			// Success by default so a bare mock resolves.
			cb(null, "", "");
		}
	}) as typeof import("node:child_process").execFile;
	return { execFile, calls };
}
