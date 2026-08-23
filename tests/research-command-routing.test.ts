/**
 * Task 10 follow-up: /research workspace-scoped command routing.
 *
 * Drives the REAL registerLoopCommand handler (via piLoop) with a mocked pi
 * and verifies that /research list/status/pause/clear/resume route to the
 * retained-workspace modules (history.ts / lifecycle.ts / resume.ts), while
 * the generic /loop path keeps its loop-level status/pause/clear behavior.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import piLoop from "../extensions/loop/index.ts";
import type { Workspace } from "../extensions/research/workspace.ts";
import { newRunState } from "../extensions/research/state.ts";
import { createRunManifest } from "../extensions/research/manifest.ts";
import { loadPackagedConfig } from "../extensions/research/config.ts";
import {
	createLifecycleSnapshot,
	persistLifecycle,
	type LifecycleState,
} from "../extensions/research/lifecycle.ts";

vi.mock("@earendil-works/pi-coding-agent", () => ({
	getAgentDir: vi.fn().mockReturnValue("/mock/agent/dir"),
	parseFrontmatter: vi.fn(),
}));

interface MockCommandDef {
	handler: (args: string, ctx: unknown) => Promise<void>;
	getArgumentCompletions?: (prefix: string) => Array<{ value: string }> | null;
}

function makeMockPi() {
	const commands: Record<string, MockCommandDef> = {};
	const eventListeners = new Map<string, Array<(data: unknown) => void>>();
	const events = {
		on: (channel: string, listener: (data: unknown) => void) => {
			const listeners = eventListeners.get(channel) ?? [];
			listeners.push(listener);
			eventListeners.set(channel, listeners);
		},
		emit: (channel: string, data: unknown) => {
			for (const listener of eventListeners.get(channel) ?? []) listener(data);
		},
	};
	const pi = {
		registerCommand: (cmd: string, def: MockCommandDef) => {
			commands[cmd] = def;
		},
		registerTool: () => {},
		on: () => {},
		events,
		sendMessage: () => {},
		appendEntry: vi.fn(),
		getActiveTools: () => [] as string[],
		setActiveTools: () => {},
	};
	return { pi, commands };
}

interface NotifyCall {
	message: string;
	level: string;
}

/**
 * Fake Pi model registry with the concrete targets of research-owned aliases.
 */
function fakeModelRegistry() {
	const models = [
		{
			id: "opencode-zen/x-preview-f-free",
			name: "x-preview-f-free",
			provider: "opencode-zen",
			reasoning: true,
			input: ["text"],
		},
		{
			id: "local/XYZAILab_XYZ-Aquila-mini-GGUF-Q4_K_M",
			name: "XYZAILab_XYZ-Aquila-mini-GGUF-Q4_K_M",
			provider: "local",
			reasoning: false,
			input: ["text"],
		},
		{
			id: "opencode-zen/mimo-v2.5-free",
			name: "mimo-v2.5-free",
			provider: "opencode-zen",
			reasoning: true,
			input: ["text"],
		},
	];
	return {
		getAll: () => models,
		getRegisteredProviderIds: () => ["local"],
		getProvider: () => undefined,
	};
}

function mockCtx(cwd: string) {
	const notifications: NotifyCall[] = [];
	const ctx = {
		cwd,
		ui: {
			notify: (message: string, level = "info") => {
				notifications.push({ message, level });
			},
			confirm: async () => true,
			setStatus: () => {},
		},
		isIdle: () => false,
		modelRegistry: fakeModelRegistry(),
		getNotifications: () => notifications,
	};
	return ctx;
}

/**
 * Build a retained workspace with full metadata (run-state + manifest +
 * lifecycle snapshot), like one created by the research startup engine.
 */
function buildRetainedWorkspace(
	projectRoot: string,
	dirName: string,
	mission: string,
	lifecycleState: LifecycleState = "active",
): string {
	const wsPath = path.join(projectRoot, ".research", dirName);
	fs.mkdirSync(path.join(wsPath, ".research"), { recursive: true });
	const ws: Workspace = {
		path: wsPath,
		projectRoot,
		mission,
		runId: `run-${dirName}`,
		transitionId: "tr-test",
	};
	fs.writeFileSync(
		path.join(wsPath, ".research", "run-state.json"),
		JSON.stringify(newRunState(ws), null, 2),
		"utf-8",
	);
	const snapshots = activationSnapshots(ws);
	createRunManifest(
		ws,
		undefined,
		snapshots.contract,
		snapshots.frozenConfig,
	);
	persistLifecycle(ws, createLifecycleSnapshot(lifecycleState, "test-setup"));
	return wsPath;
}

function activationSnapshots(ws: Workspace) {
	const config = loadPackagedConfig();
	const available = fakeModelRegistry().getAll();
	const resolvedProfiles: Record<string, unknown> = {};
	const resolvedModels: Record<string, unknown> = {};
	const frozenRoles: Record<string, unknown> = {};
	for (const [name, role] of Object.entries(config.roles)) {
		const target = config.models[role.model] ?? role.model;
		const model = available.find((entry) =>
			entry.id === target || entry.name === target || entry.id.endsWith(`/${target}`)
		);
		if (!model) throw new Error(`Missing test model fixture for ${target}`);
		resolvedProfiles[name] = {
			name,
			description: role.description,
			model: model.id,
			thinking: role.thinking,
			tools: [...role.tools],
			access: role.access,
			systemPrompt: fs.readFileSync(role.promptPath, "utf-8"),
			timeoutSeconds: role.timeoutSeconds,
		};
		resolvedModels[name] = {
			id: model.id,
			name: model.name,
			provider: model.provider,
			capabilities: [],
		};
		frozenRoles[name] = { ...role, name, model: model.id };
	}
	const hardCeilings = {
		maxConcurrentAttempts: Object.values(config.roles)
			.reduce((sum, role) => sum + role.concurrentDispatch, 0),
		maxAttemptsPerTask: Math.max(
			...Object.values(config.roles).map((role) => role.totalDispatch),
		),
		hardTimeoutSeconds: 1800,
	};
	return {
		contract: {
			runId: ws.runId,
			transitionId: ws.transitionId,
			mission: ws.mission,
			profile: config.defaultProfile,
			programPath: config.defaultProgram,
			profileConfig: config.profiles[config.defaultProfile],
			defaults: config.defaults,
			resolvedProfiles,
			resolvedModels,
			hardCeilings,
		},
		frozenConfig: {
			roles: frozenRoles,
			hardTimeoutSeconds: hardCeilings.hardTimeoutSeconds,
		},
	};
}

function lifecycleCurrent(wsPath: string): string | null {
	const p = path.join(wsPath, ".research", "lifecycle.json");
	if (!fs.existsSync(p)) return null;
	return (JSON.parse(fs.readFileSync(p, "utf-8")) as { current: string })
		.current;
}

describe("/research workspace subcommand routing", () => {
	let cwd: string;
	let mock: ReturnType<typeof makeMockPi>;

	beforeEach(() => {
		mock = makeMockPi();
		piLoop(mock.pi as never);
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-research-routing-"));
	});

	afterEach(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("/research list lists retained workspaces with lifecycle status", async () => {
		buildRetainedWorkspace(cwd, "alpha-run", "Alpha research", "paused");
		buildRetainedWorkspace(cwd, "beta-run", "Beta research", "active");
		const ctx = mockCtx(cwd);
		await mock.commands.research.handler("list", ctx);
		const msg = ctx.getNotifications()[0].message;
		expect(msg).toContain("alpha-run");
		expect(msg).toContain("beta-run");
		expect(msg).toContain("paused");
		expect(msg).toContain("active");
		expect(msg).toContain("Alpha research");
		expect(msg).toContain("Beta research");
	});

	it("/research list excludes .research/cache/web/ directories", async () => {
		buildRetainedWorkspace(cwd, "keep-me", "Keep me", "active");
		fs.mkdirSync(path.join(cwd, ".research/cache/web/cache-1"), {
			recursive: true,
		});
		const ctx = mockCtx(cwd);
		await mock.commands.research.handler("list", ctx);
		const msg = ctx.getNotifications()[0].message;
		expect(msg).toContain("keep-me");
		expect(msg).not.toContain("cache-1");
	});

	it("/research list reports malformed workspaces without aborting", async () => {
		buildRetainedWorkspace(cwd, "good-run", "Good run", "active");
		const badDir = path.join(cwd, ".research", "bad-run");
		fs.mkdirSync(path.join(badDir, ".research"), { recursive: true });
		fs.writeFileSync(
			path.join(badDir, ".research", "lifecycle.json"),
			"not json{{",
			"utf-8",
		);
		const ctx = mockCtx(cwd);
		await mock.commands.research.handler("list", ctx);
		const msg = ctx.getNotifications()[0].message;
		expect(msg).toContain("good-run");
		expect(msg).toContain("bad-run");
		expect(msg).toContain("malformed");
	});

	it("/research list with no workspaces shows an empty notice", async () => {
		const ctx = mockCtx(cwd);
		await mock.commands.research.handler("list", ctx);
		expect(ctx.getNotifications()[0].message).toContain(
			"No research workspaces found",
		);
	});

	it("/research status <slug> reads the workspace lifecycle", async () => {
		buildRetainedWorkspace(cwd, "paused-run", "Paused mission", "paused");
		const ctx = mockCtx(cwd);
		await mock.commands.research.handler("status paused-run", ctx);
		const msg = ctx.getNotifications()[0].message;
		expect(msg).toContain("paused-run");
		expect(msg).toContain("Status: paused");
		expect(msg).toContain("Paused mission");
	});

	it("/research status (no slug) uses the active loop state's workingDir", async () => {
		await mock.commands.research.handler("--yes status-mission", mockCtx(cwd));
		const ctx = mockCtx(cwd);
		await mock.commands.research.handler("status", ctx);
		const msg = ctx.getNotifications()[0].message;
		expect(msg).toContain("status-mission");
		expect(msg).toContain("Status:");
	});

	it("/research status <unknown> reports no workspace found", async () => {
		const ctx = mockCtx(cwd);
		await mock.commands.research.handler("status nope", ctx);
		expect(ctx.getNotifications()[0].level).toBe("warning");
		expect(ctx.getNotifications()[0].message).toContain(
			"No research workspace found",
		);
	});

	it("/research status with no active workspace shows a notice", async () => {
		const ctx = mockCtx(cwd);
		await mock.commands.research.handler("status", ctx);
		expect(ctx.getNotifications()[0].message).toContain(
			"No active research workspace",
		);
	});

	it("/research pause <slug> transitions the workspace lifecycle to paused", async () => {
		const wsPath = buildRetainedWorkspace(
			cwd,
			"pausable-run",
			"Pause me",
			"active",
		);
		const ctx = mockCtx(cwd);
		await mock.commands.research.handler("pause pausable-run", ctx);
		expect(lifecycleCurrent(wsPath)).toBe("paused");
		expect(ctx.getNotifications()[0].message).toContain("Paused pausable-run");
	});

	it("/research pause (no slug) pauses the active workspace without touching the engine loop", async () => {
		await mock.commands.research.handler("--yes pause-mission", mockCtx(cwd));
		const researchDir = path.join(cwd, ".research");
		// The real startup timestamps the final dir: <YYYYMMDD-HHmm>-pause-mission
		const runDir = fs
			.readdirSync(researchDir)
			.find((d) => d.includes("pause-mission"));
		expect(runDir).toBeDefined();
		const wsPath = path.join(researchDir, runDir!);
		expect(fs.existsSync(path.join(wsPath, ".research"))).toBe(true);
		const appendsBefore = (mock.pi.appendEntry as ReturnType<typeof vi.fn>).mock
			.calls.length;
		const ctx = mockCtx(cwd);
		await mock.commands.research.handler("pause", ctx);
		// Workspace lifecycle was paused...
		expect(lifecycleCurrent(wsPath)).toBe("paused");
		// ...but the engine loop state was NOT touched (no new persistence entry).
		const appendsAfter = (mock.pi.appendEntry as ReturnType<typeof vi.fn>).mock
			.calls.length;
		expect(appendsAfter).toBe(appendsBefore);
		expect(ctx.getNotifications()[0].message).toContain("Paused");
		expect(ctx.getNotifications()[0].message).toContain("pause-mission");
	});

	it("/research pause on a completed workspace reports the invalid transition", async () => {
		const wsPath = buildRetainedWorkspace(
			cwd,
			"done-pause",
			"Done",
			"complete",
		);
		const ctx = mockCtx(cwd);
		await mock.commands.research.handler("pause done-pause", ctx);
		expect(lifecycleCurrent(wsPath)).toBe("complete"); // untouched
		expect(ctx.getNotifications()[0].level).toBe("warning");
		expect(ctx.getNotifications()[0].message).toContain(
			"Cannot pause done-pause",
		);
	});

	it("/research clear <slug> abandons the workspace", async () => {
		const wsPath = buildRetainedWorkspace(
			cwd,
			"clearable-run",
			"Clear me",
			"paused",
		);
		const ctx = mockCtx(cwd);
		await mock.commands.research.handler("clear clearable-run", ctx);
		expect(lifecycleCurrent(wsPath)).toBe("abandoned");
		expect(ctx.getNotifications()[0].message).toContain(
			"Cleared clearable-run",
		);
	});

	it("/research clear with no active workspace shows a notice", async () => {
		const ctx = mockCtx(cwd);
		await mock.commands.research.handler("clear", ctx);
		expect(ctx.getNotifications()[0].message).toContain(
			"No active research workspace",
		);
	});

	it("/research resume <slug> validates, acquires the lease, marks active, and only then activates policy", async () => {
		const wsPath = buildRetainedWorkspace(
			cwd,
			"resumable-run",
			"Resume me",
			"paused",
		);
		const before = { contributions: [] as Array<{ owner: string }> };
		mock.pi.events.emit("subagent:register-policy-adapters", before);
		expect(before.contributions).toHaveLength(0);

		const ctx = mockCtx(cwd);
		await mock.commands.research.handler("resume resumable-run", ctx);
		expect(lifecycleCurrent(wsPath)).toBe("active");
		expect(
			fs.existsSync(path.join(wsPath, ".research", "run-lease.json")),
		).toBe(true);
		const after = { contributions: [] as Array<{ owner: string }> };
		mock.pi.events.emit("subagent:register-policy-adapters", after);
		expect(after.contributions.map((entry) => entry.owner)).toContain("research");
		expect(ctx.getNotifications()[0].message).toContain(
			"Resumed resumable-run",
		);
	});

	it("/research resume <slug> on a non-resumable workspace reports the error kind", async () => {
		const wsPath = buildRetainedWorkspace(cwd, "done-run", "Done", "complete");
		const ctx = mockCtx(cwd);
		await mock.commands.research.handler("resume done-run", ctx);
		expect(lifecycleCurrent(wsPath)).toBe("complete"); // untouched
		const msg = ctx.getNotifications()[0].message;
		expect(msg).toContain("Cannot resume done-run");
		expect(msg).toContain("state_not_resumable");
	});

	it("/research resume <unknown> reports no workspace found", async () => {
		const ctx = mockCtx(cwd);
		await mock.commands.research.handler("resume ghost", ctx);
		expect(ctx.getNotifications()[0].message).toContain(
			"No research workspace found",
		);
	});

	it("research completions include list; loop completions do not", async () => {
		const research = mock.commands.research.getArgumentCompletions?.("") ?? [];
		const loop = mock.commands.loop.getArgumentCompletions?.("") ?? [];
		expect(research.map((c) => c.value)).toEqual(
			expect.arrayContaining(["list", "status", "pause", "resume", "clear"]),
		);
		expect(loop.map((c) => c.value)).not.toContain("list");
	});
});

describe("/loop keeps loop-level status/pause/clear behavior", () => {
	let cwd: string;
	let mock: ReturnType<typeof makeMockPi>;

	beforeEach(() => {
		mock = makeMockPi();
		piLoop(mock.pi as never);
		cwd = fs.mkdtempSync(path.join(os.tmpdir(), "pi-loop-routing-"));
	});

	afterEach(() => {
		fs.rmSync(cwd, { recursive: true, force: true });
	});

	it("/loop status with no active loop shows usage", async () => {
		const ctx = mockCtx(cwd);
		await mock.commands.loop.handler("status", ctx);
		expect(ctx.getNotifications()[0].message).toContain("Usage: /loop");
	});

	it("/loop pause with no active loop says No active /loop", async () => {
		const ctx = mockCtx(cwd);
		await mock.commands.loop.handler("pause", ctx);
		expect(ctx.getNotifications()[0].message).toContain("No active /loop.");
	});

	it("/loop clear with no active loop says No active /loop", async () => {
		const ctx = mockCtx(cwd);
		await mock.commands.loop.handler("clear", ctx);
		expect(ctx.getNotifications()[0].message).toContain("No active /loop.");
	});

	it("/loop list is treated as a mission, not a workspace subcommand", async () => {
		const ctx = mockCtx(cwd);
		await mock.commands.loop.handler("list", ctx);
		// Falls through to the generic start path (starts a loop whose mission
		// is "list") instead of listing research workspaces.
		expect(mock.pi.appendEntry).toHaveBeenCalled();
	});
});
