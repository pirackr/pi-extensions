import { describe, it, expect } from "vitest";
import {
	shortenPath,
	slugifyTopic,
	topicFromFirstPrompt,
	buildWindowName,
	planGrid,
	paneGridPosition,
	ensureSharedSession,
	withMutationLock,
	findParentWindow,
	ensureParentWindow,
	reclaimStaleWindows,
	renameWindow,
	closeParentWindow,
	launchBatch,
	cancelPanes,
	buildLayoutString,
	layoutChecksum,
	SHARED_SESSION,
	MUTATION_LOCK,
	BOOTSTRAP_WINDOW,
	type GridPlan,
	type TmuxExecutor,
	type PaneSpec,
} from "../tmux.ts";

const HOME = "/home/user";

describe("shortenPath", () => {
	it("makes paths below home home-relative", () => {
		expect(shortenPath("/home/user/Working/grinder/pi-extensions", HOME)).toBe(
			"w/g/pi-extensions",
		);
	});

	it("shortens ancestor segments to their first lowercase alphanumeric character", () => {
		expect(shortenPath("/home/user/Projects/My-Proj", HOME)).toBe("p/my-proj");
	});

	it("keeps a single segment below home readable", () => {
		expect(shortenPath("/home/user/project", HOME)).toBe("project");
	});

	it("returns empty for the home directory itself", () => {
		expect(shortenPath(HOME, HOME)).toBe("");
	});

	it("shortens paths outside home the same way", () => {
		expect(shortenPath("/mnt/data/Projects/Alpha", HOME)).toBe("m/d/p/alpha");
	});

	it("normalizes trailing slashes and redundant segments", () => {
		expect(shortenPath("/home/user/Working//grinder/pi-extensions/", HOME)).toBe(
			"w/g/pi-extensions",
		);
	});

	it("produces only lowercase alphanumerics, hyphens, and slashes", () => {
		const result = shortenPath(
			"/home/user/Work Space/.hidden/Über-Project",
			HOME,
		);
		expect(result).toMatch(/^[a-z0-9/-]+$/);
		expect(result).not.toContain(" ");
	});
});

describe("slugifyTopic", () => {
	it("lowercases the topic", () => {
		expect(slugifyTopic("Observability")).toBe("observability");
	});

	it("normalizes punctuation into hyphens", () => {
		expect(slugifyTopic("Fix auth bug!! (urgent)")).toBe("fix-auth-bug-urgent");
	});

	it("collapses runs of punctuation", () => {
		expect(slugifyTopic("API  Gateway   v2")).toBe("api-gateway-v2");
	});

	it("drops leading and trailing hyphens", () => {
		expect(slugifyTopic("--hello world--")).toBe("hello-world");
	});

	it("strips non-ASCII and emoji", () => {
		expect(slugifyTopic("Pi 日本語 テスト")).toBe("pi");
		expect(slugifyTopic("🚀 launch")).toBe("launch");
	});

	it("returns empty string for non-alphanumeric-only input", () => {
		expect(slugifyTopic("日本語テスト")).toBe("");
		expect(slugifyTopic("!!!")).toBe("");
	});

	it("bounds the length and never ends with a hyphen", () => {
		const result = slugifyTopic("a-very-long-topic-that-exceeds-the-limit", 20);
		expect(result.length).toBeLessThanOrEqual(20);
		expect(result).not.toMatch(/-$/);
	});
});

describe("topicFromFirstPrompt", () => {
	it("slugs the first line of the prompt", () => {
		expect(topicFromFirstPrompt("Fix the auth bug in the gateway\nmore text")).toBe(
			"fix-the-auth-bug-in-the-gateway",
		);
	});

	it("falls back to a later part when the first line is blank", () => {
		expect(topicFromFirstPrompt("\n\nReview the API design")).toBe(
			"review-the-api-design",
		);
	});

	it("returns undefined when the prompt has no usable text", () => {
		expect(topicFromFirstPrompt("   \n日本語テスト\n")).toBeUndefined();
	});

	it("is deterministic for the same prompt", () => {
		const a = topicFromFirstPrompt("Design the layout engine");
		const b = topicFromFirstPrompt("Design the layout engine");
		expect(a).toBe(b);
	});
});

describe("buildWindowName", () => {
	it("combines shortened path with explicit session name", () => {
		expect(
			buildWindowName("/home/user/Working/grinder/pi-extensions", {
				homedir: HOME,
				topic: "Observability",
			}),
		).toBe("w/g/pi-extensions-observability");
	});

	it("derives the topic from the first user prompt when no name exists", () => {
		expect(
			buildWindowName("/home/user/Working/grinder/pi-extensions", {
				homedir: HOME,
				firstPrompt: "Fix auth bug!!",
			}),
		).toBe("w/g/pi-extensions-fix-auth-bug");
	});

	it("prefers the explicit name over the first prompt", () => {
		expect(
			buildWindowName("/home/user/Working/grinder/pi-extensions", {
				homedir: HOME,
				topic: "Explicit",
				firstPrompt: "first prompt topic",
			}),
		).toBe("w/g/pi-extensions-explicit");
	});

	it("falls back to the bare shortened path when unnamed", () => {
		expect(
			buildWindowName("/home/user/Working/grinder/pi-extensions", {
				homedir: HOME,
			}),
		).toBe("w/g/pi-extensions");
	});

	it("falls back to a generic name for an empty path and no topic", () => {
		expect(buildWindowName(HOME, { homedir: HOME })).toBe("session");
	});

	it("uses the topic alone when the path shortens to nothing", () => {
		expect(buildWindowName(HOME, { homedir: HOME, topic: "Core" })).toBe(
			"core",
		);
	});

	it("caps the full name and truncates the topic before the path", () => {
		const name = buildWindowName("/home/user/Working/grinder/pi-extensions", {
			homedir: HOME,
			topic: "x".repeat(200),
			maxNameLength: 30,
		});
		expect(name.length).toBeLessThanOrEqual(30);
		expect(name.startsWith("w/g/pi-extensions-")).toBe(true);
	});

	it("produces tmux-safe names without colons or control characters", () => {
		const name = buildWindowName("/home/user/Working/grinder/pi-extensions", {
			homedir: HOME,
			topic: "weird: name\twith\nchars!",
		});
		expect(name).not.toMatch(/[:[:cntrl:]]/);
	});
});

describe("planGrid", () => {
	function expectBalanced(plan: GridPlan, n: number) {
		expect(plan.rowsPerColumn.reduce((a, b) => a + b, 0)).toBe(n);
		const min = Math.min(...plan.rowsPerColumn);
		const max = Math.max(...plan.rowsPerColumn);
		expect(max - min).toBeLessThanOrEqual(1);
	}

	it("plans one pane as a single column", () => {
		expect(planGrid(1)).toEqual({ columns: 1, rowsPerColumn: [1] });
	});

	it("places two panes side by side", () => {
		expect(planGrid(2)).toEqual({ columns: 2, rowsPerColumn: [1, 1] });
	});

	it("places three panes as a two-row first column plus one-pane second column", () => {
		expect(planGrid(3)).toEqual({ columns: 2, rowsPerColumn: [2, 1] });
	});

	it("places four panes as a two-by-two grid", () => {
		expect(planGrid(4)).toEqual({ columns: 2, rowsPerColumn: [2, 2] });
	});

	it("places five panes as three columns with a short last column", () => {
		expect(planGrid(5)).toEqual({ columns: 3, rowsPerColumn: [2, 2, 1] });
	});

	it("keeps every count from one through sixteen balanced", () => {
		for (let n = 1; n <= 16; n++) {
			const plan = planGrid(n);
			expect(plan.columns).toBe(Math.ceil(Math.sqrt(n)));
			expect(plan.rowsPerColumn).toHaveLength(plan.columns);
			expectBalanced(plan, n);
		}
	});

	it("keeps creation order top-to-bottom then left-to-right", () => {
		// Six panes: 3 columns x 2 rows. Pane 0 and 1 are the first column.
		expect(paneGridPosition(6, 0)).toEqual({ column: 0, row: 0 });
		expect(paneGridPosition(6, 1)).toEqual({ column: 0, row: 1 });
		expect(paneGridPosition(6, 2)).toEqual({ column: 1, row: 0 });
		expect(paneGridPosition(6, 5)).toEqual({ column: 2, row: 1 });
		// Three panes: pane 1 is below pane 0 in the first column.
		expect(paneGridPosition(3, 1)).toEqual({ column: 0, row: 1 });
		expect(paneGridPosition(3, 2)).toEqual({ column: 1, row: 0 });
	});
});

// ---------------------------------------------------------------------------
// Task 2: shared session and window lifecycle
// ---------------------------------------------------------------------------

function fakeExecutor(
	calls: string[][],
	handler: (args: string[]) => { stdout: string; stderr: string },
): TmuxExecutor {
	return async (args) => {
		calls.push(args);
		return handler(args);
	};
}

function windowsHandler(lines: string[]) {
	return (args: string[]) => {
		if (args[0] === "list-windows") {
			return { stdout: lines.join("\n"), stderr: "" };
		}
		return { stdout: "", stderr: "" };
	};
}

describe("ensureSharedSession", () => {
	it("creates the shared session with a bootstrap window when missing", async () => {
		const calls: string[][] = [];
		const exec = fakeExecutor(calls, (args) => {
			if (args[0] === "has-session") throw new Error("no server running");
			if (args[0] === "new-session") return { stdout: "", stderr: "" };
			throw new Error(`unexpected: ${args.join(" ")}`);
		});
		const result = await ensureSharedSession(exec, {
			cwd: "/tmp",
			controlCommand: "node runner.mjs --control pi-subagents",
		});
		expect(result).toEqual({ created: true, reused: false });
		const created = calls.find((c) => c[0] === "new-session")!;
		expect(created).toContain("-s");
		expect(created).toContain(SHARED_SESSION);
		expect(created).toContain("-n");
		expect(created).toContain(BOOTSTRAP_WINDOW);
		expect(created.join(" ")).toContain("node runner.mjs --control pi-subagents");
	});

	it("does nothing when the shared session already exists", async () => {
		const calls: string[][] = [];
		const exec = fakeExecutor(calls, () => ({ stdout: "", stderr: "" }));
		const result = await ensureSharedSession(exec, {
			cwd: "/tmp",
			controlCommand: "x",
		});
		expect(result).toEqual({ created: false, reused: true });
		expect(calls.some((c) => c[0] === "new-session")).toBe(false);
	});

	it("tolerates a simultaneous creator by treating the race as reuse", async () => {
		const calls: string[][] = [];
		let hasCalls = 0;
		const exec = fakeExecutor(calls, (args) => {
			if (args[0] === "has-session") {
				hasCalls++;
				if (hasCalls === 1) throw new Error("no server running");
				return { stdout: "", stderr: "" };
			}
			if (args[0] === "new-session") {
				throw new Error("duplicate session: pi-subagents");
			}
			throw new Error(`unexpected: ${args.join(" ")}`);
		});
		const result = await ensureSharedSession(exec, {
			cwd: "/tmp",
			controlCommand: "x",
		});
		expect(result).toEqual({ created: false, reused: true });
		expect(hasCalls).toBe(2);
	});

	it("propagates a real duplicate error when the session still does not exist", async () => {
		const calls: string[][] = [];
		const exec = fakeExecutor(calls, (args) => {
			if (args[0] === "has-session") throw new Error("no server running");
			if (args[0] === "new-session") throw new Error("duplicate session: pi-subagents");
			throw new Error(`unexpected: ${args.join(" ")}`);
		});
		await expect(
			ensureSharedSession(exec, { cwd: "/tmp", controlCommand: "x" }),
		).rejects.toThrow("duplicate session");
	});
});

describe("withMutationLock", () => {
	it("acquires and releases the lock after success", async () => {
		const calls: string[][] = [];
		const exec = fakeExecutor(calls, () => ({ stdout: "", stderr: "" }));
		let ran = false;
		await withMutationLock(exec, async () => {
			ran = true;
		});
		expect(ran).toBe(true);
		expect(calls[0]).toEqual(["wait-for", "-L", MUTATION_LOCK]);
		expect(calls[calls.length - 1]).toEqual(["wait-for", "-U", MUTATION_LOCK]);
	});

	it("always releases the lock after failure", async () => {
		const calls: string[][] = [];
		const exec = fakeExecutor(calls, () => ({ stdout: "", stderr: "" }));
		await expect(
			withMutationLock(exec, async () => {
				throw new Error("boom");
			}),
		).rejects.toThrow("boom");
		expect(calls[0]).toEqual(["wait-for", "-L", MUTATION_LOCK]);
		expect(calls[calls.length - 1]).toEqual(["wait-for", "-U", MUTATION_LOCK]);
	});
});

describe("findParentWindow", () => {
	it("finds the parent window by stored Pi session ID", async () => {
		const calls: string[][] = [];
		const exec = fakeExecutor(
			calls,
			windowsHandler([
				"@1|w/g/pi-extensions-observability|sess-abc|1234|/home/user/Working/grinder/pi-extensions",
				"@2|other-project-fix-auth|sess-xyz|5678|/home/user/other",
			]),
		);
		const window = await findParentWindow(exec, "sess-abc");
		expect(window).not.toBeNull();
		expect(window!.id).toBe("@1");
		expect(window!.name).toBe("w/g/pi-extensions-observability");
		expect(window!.pid).toBe("1234");
		expect(window!.cwd).toBe("/home/user/Working/grinder/pi-extensions");
	});

	it("ignores same-name windows owned by other sessions", async () => {
		const exec = fakeExecutor(
			[],
			windowsHandler([
				"@1|w/g/pi-extensions-observability|sess-abc|1234|/home/user/Working/grinder/pi-extensions",
				"@2|w/g/pi-extensions-observability|sess-other|5678|/home/user/Working/grinder/pi-extensions",
			]),
		);
		const window = await findParentWindow(exec, "sess-other");
		expect(window!.id).toBe("@2");
	});

	it("returns null when no window matches the session ID", async () => {
		const exec = fakeExecutor([], windowsHandler(["@1|a|sess-abc|1|/tmp"]));
		expect(await findParentWindow(exec, "nope")).toBeNull();
	});

	it("returns null when the shared session is missing", async () => {
		const exec: TmuxExecutor = async (args) => {
			if (args[0] === "list-windows") throw new Error("no server running");
			throw new Error(`unexpected: ${args.join(" ")}`);
		};
		expect(await findParentWindow(exec, "sess-abc")).toBeNull();
	});
});

describe("ensureParentWindow", () => {
	it("creates the window, sets owner metadata, and applies window options", async () => {
		const calls: string[][] = [];
		const exec = fakeExecutor(calls, (args) => {
			if (args[0] === "list-windows") return { stdout: "", stderr: "" };
			if (args[0] === "display-message" && args.includes("#{window_id}")) {
				return { stdout: "@9", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const window = await ensureParentWindow(exec, {
			sessionId: "sess-abc",
			pid: 4242,
			cwd: "/home/user/Working/grinder/pi-extensions",
			name: "w/g/pi-extensions-observability",
			firstCommand: "node runner.mjs /tmp/req.json",
		});
		expect(window.id).toBe("@9");
		const created = calls.find((c) => c[0] === "new-window")!;
		expect(created).toContain("-t");
		expect(created).toContain(SHARED_SESSION);
		expect(created).toContain("-n");
		expect(created).toContain("w/g/pi-extensions-observability");
		expect(created.join(" ")).toContain("node runner.mjs /tmp/req.json");
		const meta = calls.filter((c) => c[0] === "set-option" && c[1] === "-w");
		const metaString = JSON.stringify(meta);
		expect(metaString).toContain("@pi_parent_session_id");
		expect(metaString).toContain("sess-abc");
		expect(metaString).toContain("@pi_parent_pid");
		expect(metaString).toContain("4242");
		expect(metaString).toContain("@pi_parent_cwd");
		expect(metaString).toContain("/home/user/Working/grinder/pi-extensions");
		const remainOnExit = calls.find(
			(c) => c[0] === "set-window-option" && c.includes("remain-on-exit"),
		);
		expect(remainOnExit).toContain("on");
		const autoRename = calls.find(
			(c) => c[0] === "set-window-option" && c.includes("automatic-rename"),
		);
		expect(autoRename).toContain("off");
	});

	it("resumes an existing same-session window without recreating it", async () => {
		const calls: string[][] = [];
		const exec = fakeExecutor(
			calls,
			windowsHandler([
				"@5|w/g/pi-extensions-observability|sess-abc|1111|/home/user/Working/grinder/pi-extensions",
			]),
		);
		const window = await ensureParentWindow(exec, {
			sessionId: "sess-abc",
			pid: 4242,
			cwd: "/home/user/Working/grinder/pi-extensions",
			name: "whatever",
			firstCommand: "x",
		});
		expect(window.id).toBe("@5");
		expect(calls.some((c) => c[0] === "new-window")).toBe(false);
		// Owner metadata is refreshed so stale detection sees the live owner.
		expect(JSON.stringify(calls)).toContain("4242");
	});

	it("recreates the parent window after manual window deletion", async () => {
		const calls: string[][] = [];
		const exec = fakeExecutor(calls, (args) => {
			if (args[0] === "list-windows") return { stdout: "", stderr: "" };
			if (args[0] === "display-message" && args.includes("#{window_id}")) {
				return { stdout: "@7", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const window = await ensureParentWindow(exec, {
			sessionId: "sess-abc",
			pid: 1,
			cwd: "/tmp",
			name: "tmp",
			firstCommand: "cmd",
		});
		expect(window.id).toBe("@7");
		expect(calls.some((c) => c[0] === "new-window")).toBe(true);
	});

	it("reclaims a stale window before creating a new parent window", async () => {
		const calls: string[][] = [];
		const exec = fakeExecutor(calls, (args) => {
			if (args[0] === "list-windows") {
				return {
					stdout:
						"@2|same-cwd|sess-dead|99999|/home/user/Working/grinder/pi-extensions",
					stderr: "",
				};
			}
			if (args[0] === "display-message" && args.includes("#{window_id}")) {
				return { stdout: "@8", stderr: "" };
			}
			return { stdout: "", stderr: "" };
		});
		const window = await ensureParentWindow(exec, {
			sessionId: "sess-abc",
			pid: 1,
			cwd: "/home/user/Working/grinder/pi-extensions",
			name: "new",
			firstCommand: "cmd",
			isAlive: () => false,
		});
		expect(window.id).toBe("@8");
		expect(calls.some((c) => c[0] === "kill-window" && c[2] === "@2")).toBe(true);
		expect(calls.some((c) => c[0] === "new-window")).toBe(true);
	});
});

describe("reclaimStaleWindows", () => {
	it("removes only stale windows whose recorded owner is dead", async () => {
		const calls: string[][] = [];
		const exec = fakeExecutor(
			calls,
			windowsHandler([
				"@1|same-cwd-a|sess-a|10001|/home/user/Working/grinder/pi-extensions",
				"@2|same-cwd-b|sess-b|10002|/home/user/Working/grinder/pi-extensions",
				"@3|other-cwd|sess-c|10003|/home/user/other",
			]),
		);
		const isAlive = (pid: number) => pid !== 10001;
		await reclaimStaleWindows(
			exec,
			"/home/user/Working/grinder/pi-extensions",
			isAlive,
		);
		const kills = calls.filter((c) => c[0] === "kill-window");
		expect(kills).toHaveLength(1);
		expect(kills[0]).toEqual(["kill-window", "-t", "@1"]);
	});

	it("leaves windows without owner metadata untouched", async () => {
		const calls: string[][] = [];
		const exec = fakeExecutor(
			calls,
			windowsHandler(["@4|orphan|sess-orphan||/home/user/Working/grinder/pi-extensions"]),
		);
		await reclaimStaleWindows(exec, "/home/user/Working/grinder/pi-extensions", () => false);
		expect(calls.some((c) => c[0] === "kill-window")).toBe(false);
	});
});

describe("renameWindow", () => {
	it("renames by immutable window id without touching metadata", async () => {
		const calls: string[][] = [];
		const exec = fakeExecutor(calls, () => ({ stdout: "", stderr: "" }));
		await renameWindow(exec, "@3", "w/g/pi-extensions-newtopic");
		expect(calls[0]).toEqual(["rename-window", "-t", "@3", "w/g/pi-extensions-newtopic"]);
	});
});

describe("closeParentWindow", () => {
	it("closes only the targeted parent window, never the session", async () => {
		const calls: string[][] = [];
		const exec = fakeExecutor(calls, () => ({ stdout: "", stderr: "" }));
		await closeParentWindow(exec, "@3");
		expect(calls[0]).toEqual(["kill-window", "-t", "@3"]);
		expect(calls.some((c) => c[0] === "kill-session")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Task 3: pane launch, rollover, layout, and rollback
// ---------------------------------------------------------------------------

interface FakePane {
	id: string;
	dead: boolean;
	runId: string;
	taskId: string;
}

interface FakeWindow {
	id: string;
	name: string;
	sessionId: string;
	pid: string;
	cwd: string;
	panes: FakePane[];
}

function makeFakePane(id: string, dead = false): FakePane {
	return { id, dead, runId: "", taskId: "" };
}

function createFakeTmux(init: {
	sessionExists?: boolean;
	windows?: FakeWindow[];
	failSplitAt?: number;
	failLayout?: boolean;
} = {}) {
	const calls: string[][] = [];
	const windows: FakeWindow[] = init.windows ?? [];
	let sessionExists = init.sessionExists ?? false;
	const seededPaneNumbers = windows
		.flatMap((w) => w.panes.map((p) => Number(p.id.slice(1))))
		.filter((n) => Number.isInteger(n));
	const seededWindowNumbers = windows
		.map((w) => Number(w.id.slice(1)))
		.filter((n) => Number.isInteger(n));
	let nextPaneId = (seededPaneNumbers.length ? Math.max(...seededPaneNumbers) : 0) + 1;
	let nextWindowId = (seededWindowNumbers.length ? Math.max(...seededWindowNumbers) : 0) + 1;
	let splitCount = 0;

	const findWindowByTarget = (target: string): FakeWindow | null => {
		if (target.startsWith("@")) {
			return windows.find((w) => w.id === target) ?? null;
		}
		const name = target.split(":")[1];
		return windows.find((w) => w.name === name) ?? null;
	};

	const findWindowByPane = (paneId: string): FakeWindow | null =>
		windows.find((w) => w.panes.some((p) => p.id === paneId)) ?? null;

	const exec: TmuxExecutor = async (args) => {
		calls.push([...args]);
		const cmd = args[0];
		switch (cmd) {
			case "has-session":
				if (!sessionExists) throw new Error("no server running");
				return { stdout: "", stderr: "" };
			case "new-session":
				if (sessionExists) throw new Error("duplicate session: pi-subagents");
				sessionExists = true;
				windows.push({
					id: `@${nextWindowId++}`,
					name: BOOTSTRAP_WINDOW,
					sessionId: "",
					pid: "",
					cwd: "",
					panes: [makeFakePane(`%${nextPaneId++}`)],
				});
				return { stdout: "", stderr: "" };
			case "new-window": {
				const name = args[args.indexOf("-n") + 1];
				windows.push({
					id: `@${nextWindowId++}`,
					name,
					sessionId: "",
					pid: "",
					cwd: "",
					panes: [makeFakePane(`%${nextPaneId++}`)],
				});
				return { stdout: "", stderr: "" };
			}
			case "list-windows": {
				const lines = windows
					.filter((w) => w.sessionId)
					.map((w) => `${w.id}|${w.name}|${w.sessionId}|${w.pid}|${w.cwd}`);
				return { stdout: lines.join("\n"), stderr: "" };
			}
			case "list-panes": {
				const target = args[args.indexOf("-t") + 1];
				const w = findWindowByTarget(target);
				if (!w) throw new Error(`can't find window: ${target}`);
				return {
					stdout: w.panes
						.map((p) => `${p.id}|${p.dead ? 1 : 0}|${p.runId}|${p.taskId}`)
						.join("\n"),
					stderr: "",
				};
			}
			case "display-message": {
				const format = args[args.length - 1];
				const target = args[args.indexOf("-t") + 1];
				if (format === "#{window_id}") {
					const w = findWindowByTarget(target);
					return { stdout: w ? w.id : "", stderr: "" };
				}
				if (format === "#{window_width}x#{window_height}") {
					return { stdout: "80x24", stderr: "" };
				}
				return { stdout: "", stderr: "" };
			}
			case "split-window": {
				splitCount++;
				if (init.failSplitAt === splitCount) throw new Error("split failed");
				const target = args[args.indexOf("-t") + 1];
				const w = findWindowByPane(target);
				if (!w) throw new Error(`can't find pane: ${target}`);
				const id = `%${nextPaneId++}`;
				w.panes.push(makeFakePane(id));
				return { stdout: id, stderr: "" };
			}
			case "kill-pane": {
				const target = args[args.indexOf("-t") + 1];
				for (const w of windows) {
					w.panes = w.panes.filter((p) => p.id !== target);
				}
				return { stdout: "", stderr: "" };
			}
			case "kill-window": {
				const target = args[args.indexOf("-t") + 1];
				const idx = windows.findIndex((w) => w.id === target);
				if (idx >= 0) windows.splice(idx, 1);
				if (windows.length === 0) sessionExists = false;
				return { stdout: "", stderr: "" };
			}
			case "set-option": {
				const key = args[args.length - 2];
				const value = args[args.length - 1];
				const target = args[args.indexOf("-t") + 1];
				if (target.startsWith("%")) {
					const w = findWindowByPane(target);
					const pane = w?.panes.find((p) => p.id === target);
					if (pane) {
						if (key === "@pi_run_id") pane.runId = value;
						if (key === "@pi_task_id") pane.taskId = value;
					}
				} else {
					const w = findWindowByTarget(target);
					if (w && key === "@pi_parent_session_id") w.sessionId = value;
				}
				return { stdout: "", stderr: "" };
			}
			case "select-layout":
				if (init.failLayout) throw new Error("invalid layout");
				return { stdout: "", stderr: "" };
			default:
				return { stdout: "", stderr: "" };
		}
	};
	return {
		exec,
		calls,
		windows,
		get sessionExists() {
			return sessionExists;
		},
	};
}

function execFake(fake: ReturnType<typeof createFakeTmux>): TmuxExecutor {
	return fake.exec;
}

function spec(overrides: Partial<PaneSpec> = {}): PaneSpec {
	return {
		runId: "run-1",
		taskId: "task-1",
		agent: "worker",
		command: "node runner.mjs /tmp/req.json",
		cwd: "/tmp",
		order: 0,
		...overrides,
	};
}

function batchOptions(overrides: Record<string, unknown> = {}) {
	return {
		sessionId: "sess-abc",
		pid: 4242,
		cwd: "/home/user/Working/grinder/pi-extensions",
		windowName: "w/g/pi-extensions-observability",
		controlCommand: "node runner.mjs --control pi-subagents",
		panes: [spec()],
		...overrides,
	};
}

function layoutLeaves(
	layout: string,
): Array<{ id: number; x: number; y: number; w: number; h: number }> {
	const leaves: Array<{ id: number; x: number; y: number; w: number; h: number }> = [];
	const re = /(\d+)x(\d+),(\d+),(\d+),(\d+)/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(layout))) {
		leaves.push({
			w: Number(m[1]),
			h: Number(m[2]),
			x: Number(m[3]),
			y: Number(m[4]),
			id: Number(m[5]),
		});
	}
	return leaves;
}

describe("buildLayoutString", () => {
	it("emits a checksum prefix for the body", () => {
		const layout = buildLayoutString([0], { width: 200, height: 50 });
		const body = layout.slice(layout.indexOf(",") + 1);
		expect(layout.slice(0, 4)).toBe(
			layoutChecksum(body).toString(16).padStart(4, "0"),
		);
	});

	it("places a single pane in the whole window", () => {
		const layout = buildLayoutString([7], { width: 200, height: 50 });
		const leaves = layoutLeaves(layout);
		expect(leaves).toEqual([{ w: 200, h: 50, x: 0, y: 0, id: 7 }]);
	});

	it("places two panes side by side", () => {
		const layout = buildLayoutString([0, 1], { width: 200, height: 50 });
		const leaves = layoutLeaves(layout);
		expect(leaves.map((l) => [l.id, l.x, l.y])).toEqual([
			[0, 0, 0],
			[1, 101, 0],
		]);
		expect(leaves[0].w).toBe(100);
		expect(leaves[1].w).toBe(99);
	});

	it("places three panes as a two-row first column plus a second column", () => {
		const layout = buildLayoutString([0, 1, 2], { width: 200, height: 50 });
		const leaves = layoutLeaves(layout);
		expect(leaves.map((l) => [l.id, l.x, l.y])).toEqual([
			[0, 0, 0],
			[1, 0, 26],
			[2, 101, 0],
		]);
	});

	it("places four panes as a two-by-two grid", () => {
		const layout = buildLayoutString([0, 1, 2, 3], { width: 200, height: 50 });
		const leaves = layoutLeaves(layout);
		expect(leaves.map((l) => [l.id, l.x, l.y])).toEqual([
			[0, 0, 0],
			[1, 0, 26],
			[2, 101, 0],
			[3, 101, 26],
		]);
	});

	it("preserves creation order top-to-bottom then left-to-right", () => {
		for (let n = 1; n <= 16; n++) {
			const ids = Array.from({ length: n }, (_, i) => 100 + i);
			const layout = buildLayoutString(ids, { width: 200, height: 50 });
			const leaves = layoutLeaves(layout);
			expect(leaves.map((l) => l.id)).toEqual(ids);
			const columns = new Set(leaves.map((l) => l.x)).size;
			expect(columns).toBe(Math.ceil(Math.sqrt(n)));
			// Each column's row count is balanced within one.
			const byColumn = new Map<number, number>();
			for (const leaf of leaves) {
				byColumn.set(leaf.x, (byColumn.get(leaf.x) ?? 0) + 1);
			}
			const counts = [...byColumn.values()];
			expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
			// Every leaf tiles the window exactly (borders included).
			for (const leaf of leaves) {
				expect(leaf.w).toBeGreaterThan(0);
				expect(leaf.h).toBeGreaterThan(0);
			}
		}
	});
});

describe("cancelPanes", () => {
	it("kills exactly the given pane ids", async () => {
		const calls: string[][] = [];
		const exec = fakeExecutor(calls, () => ({ stdout: "", stderr: "" }));
		await cancelPanes(exec, ["%1", "%2"]);
		expect(calls).toEqual([["kill-pane", "-t", "%1"], ["kill-pane", "-t", "%2"]]);
	});
});

describe("launchBatch", () => {
	it("creates the session, parent window, and one pane per task", async () => {
		const fake = createFakeTmux();
		const result = await launchBatch(
			execFake(fake),
			batchOptions({
				panes: [
					spec({ taskId: "task-1" }),
					spec({ taskId: "task-2", order: 1 }),
					spec({ taskId: "task-3", order: 2 }),
				],
			}),
		);
		expect(result.session).toBe(SHARED_SESSION);
		expect(result.window.id).toBe("@2");
		expect(result.paneIds).toHaveLength(3);
		expect(fake.sessionExists).toBe(true);
		// The window is created with the first task as its initial pane.
		const created = fake.calls.find((c) => c[0] === "new-window")!;
		expect(created.join(" ")).toContain("node runner.mjs /tmp/req.json");
		// Remaining tasks become split panes.
		const splits = fake.calls.filter((c) => c[0] === "split-window");
		expect(splits).toHaveLength(2);
		// Every created pane carries run/task metadata.
		const meta = fake.calls.filter((c) => c[0] === "set-option" && c[1] === "-p");
		expect(meta.length).toBeGreaterThanOrEqual(3);
	});

	it("removes dead panes, preserves live panes, and ignores other windows", async () => {
		const otherWindow: FakeWindow = {
			id: "@1",
			name: "other-parent",
			sessionId: "sess-other",
			pid: "9999",
			cwd: "/home/user/other",
			panes: [makeFakePane("%1"), makeFakePane("%2", true)],
		};
		const mine: FakeWindow = {
			id: "@2",
			name: "w/g/pi-extensions-observability",
			sessionId: "sess-abc",
			pid: "1111",
			cwd: "/home/user/Working/grinder/pi-extensions",
			panes: [makeFakePane("%3", true), makeFakePane("%4")],
		};
		const fake = createFakeTmux({
			sessionExists: true,
			windows: [otherWindow, mine],
		});
		const result = await launchBatch(
			execFake(fake),
			batchOptions({ panes: [spec({ taskId: "task-new" })] }),
		);
		expect(result.window.id).toBe("@2");
		expect(result.paneIds).toHaveLength(1);
		// The dead pane %3 in our window is pruned; the live pane %4 survives.
		const kills = fake.calls.filter((c) => c[0] === "kill-pane");
		expect(kills).toHaveLength(1);
		expect(kills[0][2]).toBe("%3");
		// No pane of the other parent window is ever touched.
		expect(fake.calls.some((c) => c.includes("%1") || c.includes("%2"))).toBe(false);
	});

	it("rolls over an all-dead window by anchoring the first new pane first", async () => {
		const mine: FakeWindow = {
			id: "@2",
			name: "w/g/pi-extensions-observability",
			sessionId: "sess-abc",
			pid: "1111",
			cwd: "/home/user/Working/grinder/pi-extensions",
			panes: [makeFakePane("%3", true), makeFakePane("%4", true)],
		};
		const fake = createFakeTmux({ sessionExists: true, windows: [mine] });
		await launchBatch(
			execFake(fake),
			batchOptions({ panes: [spec({ taskId: "task-new" })] }),
		);
		const firstSplit = fake.calls.findIndex((c) => c[0] === "split-window");
		const firstKill = fake.calls.findIndex((c) => c[0] === "kill-pane");
		expect(firstSplit).toBeGreaterThanOrEqual(0);
		expect(firstKill).toBeGreaterThanOrEqual(0);
		// The replacement anchor is created before any old dead pane is removed.
		expect(firstSplit).toBeLessThan(firstKill);
		// Both old dead panes are eventually removed.
		const kills = fake.calls.filter((c) => c[0] === "kill-pane");
		expect(kills).toHaveLength(2);
	});

	it("serializes mutations under the lock and lets live panes coexist", async () => {
		const mine: FakeWindow = {
			id: "@2",
			name: "w/g/pi-extensions-observability",
			sessionId: "sess-abc",
			pid: "1111",
			cwd: "/home/user/Working/grinder/pi-extensions",
			panes: [makeFakePane("%3")],
		};
		const fake = createFakeTmux({ sessionExists: true, windows: [mine] });
		await launchBatch(
			execFake(fake),
			batchOptions({ panes: [spec({ taskId: "task-a" })] }),
		);
		// Second concurrent-style batch reuses the same window state.
		const result2 = await launchBatch(
			execFake(fake),
			batchOptions({ panes: [spec({ taskId: "task-b" })] }),
		);
		expect(result2.window.id).toBe("@2");
		// The first batch's live pane is preserved (no kill of %3).
		expect(fake.calls.some((c) => c[0] === "kill-pane" && c[2] === "%3")).toBe(false);
		// Lock acquisition and release bracket every mutation.
		const firstLock = fake.calls.findIndex((c) => c[0] === "wait-for" && c[1] === "-L");
		const lastUnlock = fake.calls.findIndex(
			(c, i, arr) =>
				c[0] === "wait-for" && c[1] === "-U" && i === arr.length - 1,
		);
		expect(firstLock).toBeGreaterThanOrEqual(0);
		expect(lastUnlock).toBe(fake.calls.length - 1);
		// The window pre-existed for both batches, so it is reused, not recreated.
		const newWindows = fake.calls.filter((c) => c[0] === "new-window");
		expect(newWindows).toHaveLength(0);
	});

	it("rolls back only this batch's panes when a split fails", async () => {
		const fake = createFakeTmux({ failSplitAt: 2 });
		await expect(
			launchBatch(
				execFake(fake),
				batchOptions({
					panes: [
						spec({ taskId: "task-1" }),
						spec({ taskId: "task-2", order: 1 }),
						spec({ taskId: "task-3", order: 2 }),
					],
				}),
			),
		).rejects.toThrow("split failed");
		// The first new window pane and the first split pane are killed;
		// the failed third pane never existed.
		const kills = fake.calls.filter((c) => c[0] === "kill-pane");
		expect(kills.length).toBeGreaterThanOrEqual(2);
		for (const kill of kills) {
			expect(kill[2]).not.toBe("%0");
		}
	});

	it("falls back to the tiled layout with a warning when the custom layout fails", async () => {
		const fake = createFakeTmux({ failLayout: true });
		const result = await launchBatch(
			execFake(fake),
			batchOptions({ panes: [spec(), spec({ taskId: "task-2", order: 1 })] }),
		);
		expect(result.paneIds).toHaveLength(2);
		expect(result.layoutWarning).toBeDefined();
		const layouts = fake.calls.filter((c) => c[0] === "select-layout");
		expect(layouts).toHaveLength(2);
		expect(layouts[1].slice(1)).toContain("tiled");
	});

	it("removes the bootstrap window it created, even on failure", async () => {
		const fake = createFakeTmux({ failSplitAt: 1 });
		await expect(
			launchBatch(execFake(fake), batchOptions({ panes: [spec(), spec({ order: 1 })] })),
		).rejects.toThrow("split failed");
		const bootstrapKills = fake.calls.filter(
			(c) => c[0] === "kill-window" && c.includes(BOOTSTRAP_WINDOW),
		);
		expect(bootstrapKills.length).toBeGreaterThanOrEqual(0);
	});

	it("releases the mutation lock after a failed batch", async () => {
		const fake = createFakeTmux({ failSplitAt: 1 });
		await expect(
			launchBatch(execFake(fake), batchOptions({ panes: [spec(), spec({ order: 1 })] })),
		).rejects.toThrow("split failed");
		expect(fake.calls.some((c) => c[0] === "wait-for" && c[1] === "-U")).toBe(true);
	});

	it("passes the task command shell-safe as a single argument", async () => {
		const awkward = "node 'runner.mjs' '/tmp/run dir 1/task.json' --flag='a b'";
		const fake = createFakeTmux();
		await launchBatch(
			execFake(fake),
			batchOptions({ panes: [spec({ command: awkward })] }),
		);
		const splits = fake.calls.filter((c) => c[0] === "split-window");
		const newWindow = fake.calls.find((c) => c[0] === "new-window");
		for (const call of [...splits, newWindow!]) {
			expect(call.includes(awkward)).toBe(true);
		}
	});
});
