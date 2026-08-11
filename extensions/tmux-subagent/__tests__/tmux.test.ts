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
	SHARED_SESSION,
	MUTATION_LOCK,
	BOOTSTRAP_WINDOW,
	type GridPlan,
	type TmuxExecutor,
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
