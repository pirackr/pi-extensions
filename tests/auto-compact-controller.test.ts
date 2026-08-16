import { describe, expect, it, vi, beforeEach } from "vitest";
import createExtension, {
	resetExtensionState,
	controller,
} from "../extensions/auto-compact/index.ts";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import type * as fs from "node:fs";

// Packaged config path, computed from this test file's location so the mock
// matches index.ts's resolution in ANY checkout (worktree, main, CI).
const PACKAGED_CONFIG_PATH = resolve(
	dirname(fileURLToPath(import.meta.url)),
	"../config/auto-compact.json",
);

// ---------------------------------------------------------------------------
// Mock node:fs before importing config
// ---------------------------------------------------------------------------
vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		default: {
			...actual,
			readFileSync: vi.fn(),
		},
		readFileSync: vi.fn(),
	};
});

vi.mock("@earendil-works/pi-coding-agent", () => ({
	CONFIG_DIR_NAME: ".pi",
	getAgentDir: () => "/mock/agent",
}));

import * as fsReal from "node:fs";
const mockReadFileSync = vi.mocked(fsReal.readFileSync);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFakePi(overrides: Partial<FakePi> = {}): FakePi {
	return {
		registerTool: vi.fn(),
		registerCommand: vi.fn(),
		registerFlag: vi.fn(),
		getFlag: vi.fn(),
		sendMessage: vi.fn(),
		appendEntry: vi.fn(),
		on: vi.fn(),
		getActiveTools: vi.fn(),
		setActiveTools: vi.fn(),
		...overrides,
	};
}

interface FakePi {
	registerTool: ReturnType<typeof vi.fn>;
	registerCommand: ReturnType<typeof vi.fn>;
	registerFlag: ReturnType<typeof vi.fn>;
	getFlag: ReturnType<typeof vi.fn>;
	sendMessage: ReturnType<typeof vi.fn>;
	appendEntry: ReturnType<typeof vi.fn>;
	on: ReturnType<typeof vi.fn>;
	getActiveTools: ReturnType<typeof vi.fn>;
	setActiveTools: ReturnType<typeof vi.fn>;
}

function getHandler(pi: FakePi, event: string) {
	const call = pi.on.mock.calls.find((c) => c[0] === event);
	return call?.[1] as ((event: unknown, ctx: unknown) => unknown) | undefined;
}

function makeCtx(
	overrides: {
		hasUI?: boolean;
		model?: { provider: string; id: string; contextWindow: number };
		usage?: {
			tokens: number | null;
			contextWindow: number;
			percent: number | null;
		};
		trusted?: boolean;
		isIdle?: boolean;
	} = {},
) {
	return {
		hasUI: overrides.hasUI ?? false,
		ui: {
			notify: vi.fn(),
		},
		model: overrides.model,
		getContextUsage: () => overrides.usage,
		isProjectTrusted: () => overrides.trusted ?? false,
		compact: vi.fn(),
		cwd: "/mock/project",
		mode: "tui",
		sessionManager: {
			getEntries: () => [],
			getBranch: () => [],
			getSessionId: () => "sess-1",
			getSessionName: () => "test",
		},
		isIdle: () => overrides.isIdle ?? true,
		hasPendingMessages: () => false,
	};
}

function makeModel(provider: string, id: string, contextWindow: number) {
	return { provider, id, contextWindow };
}

// ---------------------------------------------------------------------------
// 1. Registration
// ---------------------------------------------------------------------------

beforeEach(() => {
	resetExtensionState();
});

describe("registration", () => {
	it("registers /auto-compact command", () => {
		const pi = makeFakePi();
		createExtension(pi);
		expect(pi.registerCommand).toHaveBeenCalledWith(
			"auto-compact",
			expect.objectContaining({
				description: expect.stringContaining("auto-compaction status"),
			}),
		);
	});

	it("registers all five events", () => {
		const pi = makeFakePi();
		createExtension(pi);
		const eventCalls = pi.on.mock.calls.map((c) => c[0]);
		expect(eventCalls).toContain("session_start");
		expect(eventCalls).toContain("model_select");
		expect(eventCalls).toContain("agent_settled");
		expect(eventCalls).toContain("session_before_compact");
		expect(eventCalls).toContain("session_compact");
	});
});

// ---------------------------------------------------------------------------
// 2. session_start
// ---------------------------------------------------------------------------

describe("session_start", () => {
	beforeEach(() => {
		mockReadFileSync.mockReset();
		mockReadFileSync.mockImplementation((path: fs.PathOrFileDescriptor) => {
			const p = typeof path === "string" ? path : String(path);
			if (p === PACKAGED_CONFIG_PATH) {
				return JSON.stringify({
					enabled: true,
					default: { percent: 80 },
					rules: [],
				});
			}
			const err = new Error(`ENOENT`) as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});
	});

	it("loads packaged + user config on startup", () => {
		mockReadFileSync.mockImplementation((path: fs.PathOrFileDescriptor) => {
			const p = typeof path === "string" ? path : String(path);
			if (p === PACKAGED_CONFIG_PATH) {
				return JSON.stringify({
					enabled: true,
					default: { percent: 80 },
					rules: [],
				});
			}
			if (p === "/mock/agent/auto-compact/config.json") {
				return JSON.stringify({ default: { percent: 70 } });
			}
			const err = new Error(`ENOENT`) as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});

		const pi = makeFakePi();
		createExtension(pi);
		const handler = getHandler(pi, "session_start");
		const ctx = makeCtx({
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 50000, contextWindow: 200000, percent: 25 },
		});

		handler!({ type: "session_start", reason: "startup" }, ctx as any);

		// Controller should have been reset and evaluate called
		const compactCalls = (ctx as any).compact.mock.calls;
		// Not triggered since 50000 < 80% of 200000 = 160000
		expect(compactCalls).toHaveLength(0);
	});

	it("compacts immediately on resumed session with above-threshold usage", () => {
		const pi = makeFakePi();
		createExtension(pi);
		const handler = getHandler(pi, "session_start");
		const ctx = makeCtx({
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 170000, contextWindow: 200000, percent: 85 },
		});
		handler!({ type: "session_start", reason: "resume" }, ctx as any);
		// Session start is run-free, so the extension fires its own compact
		// immediately for a resumed session that already exceeds the threshold.
		expect(ctx.compact).toHaveBeenCalledTimes(1);
		expect(controller.status().inFlight).toBe(true);
	});

	it("skips project config when untrusted", () => {
		const pi = makeFakePi();
		createExtension(pi);
		const handler = getHandler(pi, "session_start");
		const ctx = makeCtx({
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 50000, contextWindow: 200000, percent: 25 },
			trusted: false,
		});

		handler!({ type: "session_start", reason: "resume" }, ctx as any);

		const compactCalls = (ctx as any).compact.mock.calls;
		expect(compactCalls).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// 3. model_select
// ---------------------------------------------------------------------------

describe("model_select", () => {
	beforeEach(() => {
		mockReadFileSync.mockReset();
		mockReadFileSync.mockImplementation((path: fs.PathOrFileDescriptor) => {
			const p = typeof path === "string" ? path : String(path);
			if (p === PACKAGED_CONFIG_PATH) {
				return JSON.stringify({
					enabled: true,
					default: { percent: 80 },
					rules: [],
				});
			}
			const err = new Error(`ENOENT`) as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});
	});

	it("resets controller for new model", () => {
		const pi = makeFakePi();
		createExtension(pi);
		const handler = getHandler(pi, "model_select");
		const ctx = makeCtx({
			model: makeModel("openai", "gpt-4o", 128000),
			usage: { tokens: null, contextWindow: 128000, percent: null },
		});

		handler!(
			{
				type: "model_select",
				model: makeModel("openai", "gpt-4o", 128000),
				previousModel: makeModel("anthropic", "claude-3-opus", 200000),
				source: "set",
			},
			ctx as any,
		);

		// No compact since usage is unknown (null)
		const compactCalls = (ctx as any).compact.mock.calls;
		expect(compactCalls).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// 4. agent_settled — threshold crossing triggers compact
// ---------------------------------------------------------------------------

describe("agent_settled threshold crossing", () => {
	beforeEach(() => {
		mockReadFileSync.mockReset();
		mockReadFileSync.mockImplementation((path: fs.PathOrFileDescriptor) => {
			const p = typeof path === "string" ? path : String(path);
			if (p === PACKAGED_CONFIG_PATH) {
				return JSON.stringify({
					enabled: true,
					default: { percent: 80 },
					rules: [],
				});
			}
			const err = new Error(`ENOENT`) as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});
	});

	it("calls ctx.compact when usage crosses threshold", () => {
		const pi = makeFakePi();
		createExtension(pi);

		// First: session_start to load config
		const startHandler = getHandler(pi, "session_start");
		const ctx = makeCtx({
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 50000, contextWindow: 200000, percent: 25 },
		});
		startHandler!({ type: "session_start", reason: "startup" }, ctx as any);

		// Then: agent_settled with usage above threshold (80% of 200000 = 160000)
		const settleHandler = getHandler(pi, "agent_settled");
		const ctx2 = makeCtx({
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 170000, contextWindow: 200000, percent: 85 },
		});
		settleHandler!({ type: "agent_settled" }, ctx2 as any);

		expect(ctx2.compact).toHaveBeenCalledTimes(1);
		const compactOpts = ctx2.compact.mock.calls[0][0];
		expect(compactOpts).toHaveProperty("onComplete");
		expect(compactOpts).toHaveProperty("onError");
	});

	it("does not call compact when usage is below threshold", () => {
		const pi = makeFakePi();
		createExtension(pi);

		const startHandler = getHandler(pi, "session_start");
		const ctx = makeCtx({
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 50000, contextWindow: 200000, percent: 25 },
		});
		startHandler!({ type: "session_start", reason: "startup" }, ctx as any);

		const settleHandler = getHandler(pi, "agent_settled");
		const ctx2 = makeCtx({
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 100000, contextWindow: 200000, percent: 50 },
		});
		settleHandler!({ type: "agent_settled" }, ctx2 as any);

		expect(ctx2.compact).not.toHaveBeenCalled();
	});

	it("skips compact when usage is unknown (null)", () => {
		const pi = makeFakePi();
		createExtension(pi);

		const startHandler = getHandler(pi, "session_start");
		const ctx = makeCtx({
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: null, contextWindow: 200000, percent: null },
		});
		startHandler!({ type: "session_start", reason: "startup" }, ctx as any);

		const settleHandler = getHandler(pi, "agent_settled");
		const ctx2 = makeCtx({
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: null, contextWindow: 200000, percent: null },
		});
		settleHandler!({ type: "agent_settled" }, ctx2 as any);

		expect(ctx2.compact).not.toHaveBeenCalled();
	});

	it("defers when the session is not idle (mid-run) and fires at the next idle settle", () => {
		const pi = makeFakePi();
		createExtension(pi);

		const startHandler = getHandler(pi, "session_start");
		const ctx = makeCtx({
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 50000, contextWindow: 200000, percent: 25 },
		});
		startHandler!({ type: "session_start", reason: "startup" }, ctx as any);

		// agent_settled while a run is still active: must NOT fire, because
		// session.compact() aborts the live run ("This operation was aborted").
		const settleHandler = getHandler(pi, "agent_settled");
		const ctxBusy = makeCtx({
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 170000, contextWindow: 200000, percent: 85 },
			isIdle: false,
		});
		settleHandler!({ type: "agent_settled" }, ctxBusy as any);
		expect(ctxBusy.compact).not.toHaveBeenCalled();
		expect(controller.status().inFlight).toBe(false);

		// Next settle while idle: fires.
		const ctxIdle = makeCtx({
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 170000, contextWindow: 200000, percent: 85 },
		});
		settleHandler!({ type: "agent_settled" }, ctxIdle as any);
		expect(ctxIdle.compact).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// 5. session_before_compact — gate
// ---------------------------------------------------------------------------

describe("session_before_compact gate", () => {
	beforeEach(() => {
		mockReadFileSync.mockReset();
		mockReadFileSync.mockImplementation((path: fs.PathOrFileDescriptor) => {
			const p = typeof path === "string" ? path : String(path);
			if (p === PACKAGED_CONFIG_PATH) {
				return JSON.stringify({
					enabled: true,
					default: { percent: 80 },
					rules: [],
				});
			}
			const err = new Error(`ENOENT`) as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});
	});

	it("allows manual compaction", () => {
		const pi = makeFakePi();
		createExtension(pi);
		const handler = getHandler(pi, "session_before_compact");
		const ctx = makeCtx({
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 50000, contextWindow: 200000, percent: 25 },
		});
		const result = handler!(
			{
				type: "session_before_compact",
				preparation: { firstKeptEntryId: "e1", tokensBefore: 50000 },
				branchEntries: [],
				reason: "manual",
				willRetry: false,
				signal: new AbortController().signal,
			},
			ctx as any,
		);
		expect(result).toEqual({});
	});

	it("allows overflow compaction", () => {
		const pi = makeFakePi();
		createExtension(pi);
		const handler = getHandler(pi, "session_before_compact");
		const ctx = makeCtx({
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 50000, contextWindow: 200000, percent: 25 },
		});
		const result = handler!(
			{
				type: "session_before_compact",
				preparation: { firstKeptEntryId: "e1", tokensBefore: 190000 },
				branchEntries: [],
				reason: "overflow",
				willRetry: true,
				signal: new AbortController().signal,
			},
			ctx as any,
		);
		expect(result).toEqual({});
	});

	it("allows overflow compaction with willRetry true", () => {
		const pi = makeFakePi();
		createExtension(pi);
		const handler = getHandler(pi, "session_before_compact");
		const ctx = makeCtx({
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 50000, contextWindow: 200000, percent: 25 },
		});
		const result = handler!(
			{
				type: "session_before_compact",
				preparation: { firstKeptEntryId: "e1", tokensBefore: 190000 },
				branchEntries: [],
				reason: "overflow",
				willRetry: true,
				signal: new AbortController().signal,
			},
			ctx as any,
		);
		expect(result).toEqual({});
	});

	it("cancels premature threshold compaction", () => {
		const pi = makeFakePi();
		createExtension(pi);

		// Load config so currentPolicy is resolved
		const startHandler = getHandler(pi, "session_start");
		const ctx0 = makeCtx({
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 50000, contextWindow: 200000, percent: 25 },
		});
		startHandler!({ type: "session_start", reason: "startup" }, ctx0 as any);

		const handler = getHandler(pi, "session_before_compact");
		const ctx = makeCtx({
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 50000, contextWindow: 200000, percent: 25 },
		});
		const result = handler!(
			{
				type: "session_before_compact",
				preparation: { firstKeptEntryId: "e1", tokensBefore: 70000 },
				branchEntries: [],
				reason: "threshold",
				willRetry: false,
				signal: new AbortController().signal,
			},
			ctx as any,
		);
		expect(result).toEqual({ cancel: true });
	});

	it("allows threshold compaction at or above custom threshold", () => {
		const pi = makeFakePi();
		createExtension(pi);
		const handler = getHandler(pi, "session_before_compact");
		const ctx = makeCtx({
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 170000, contextWindow: 200000, percent: 85 },
		});
		const result = handler!(
			{
				type: "session_before_compact",
				preparation: { firstKeptEntryId: "e1", tokensBefore: 170000 },
				branchEntries: [],
				reason: "threshold",
				willRetry: false,
				signal: new AbortController().signal,
			},
			ctx as any,
		);
		expect(result).toEqual({});
	});

	it("cancels duplicate threshold when already in flight", () => {
		const pi = makeFakePi();
		createExtension(pi);

		// session_start over threshold already set inFlight (compact fired)
		const startHandler = getHandler(pi, "session_start");
		const ctx1 = makeCtx({
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 170000, contextWindow: 200000, percent: 85 },
		});
		startHandler!({ type: "session_start", reason: "startup" }, ctx1 as any);
		expect(ctx1.compact).toHaveBeenCalledTimes(1);

		// A later settle while still in flight dedupes
		const settleHandler = getHandler(pi, "agent_settled");
		const ctx2 = makeCtx({
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 170000, contextWindow: 200000, percent: 85 },
		});
		settleHandler!({ type: "agent_settled" }, ctx2 as any);
		expect(ctx2.compact).not.toHaveBeenCalled();

		// Pi also tries threshold compaction — should be cancelled
		const beforeHandler = getHandler(pi, "session_before_compact");
		const ctx3 = makeCtx({
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 170000, contextWindow: 200000, percent: 85 },
		});
		const result = beforeHandler!(
			{
				type: "session_before_compact",
				preparation: { firstKeptEntryId: "e1", tokensBefore: 170000 },
				branchEntries: [],
				reason: "threshold",
				willRetry: false,
				signal: new AbortController().signal,
			},
			ctx3 as any,
		);
		expect(result).toEqual({ cancel: true });
	});
});

// ---------------------------------------------------------------------------
// 6. session_compact — sync
// ---------------------------------------------------------------------------

describe("session_compact sync", () => {
	beforeEach(() => {
		mockReadFileSync.mockReset();
		mockReadFileSync.mockImplementation((path: fs.PathOrFileDescriptor) => {
			const p = typeof path === "string" ? path : String(path);
			if (p === PACKAGED_CONFIG_PATH) {
				return JSON.stringify({
					enabled: true,
					default: { percent: 80 },
					rules: [],
				});
			}
			const err = new Error(`ENOENT`) as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});
	});

	it("calls recordComplete after successful compaction", () => {
		const pi = makeFakePi();
		createExtension(pi);
		const handler = getHandler(pi, "session_compact");
		const ctx = makeCtx({
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 50000, contextWindow: 200000, percent: 25 },
		});

		// Trigger a compact so the controller is in-flight (session_start
		// fires immediately for an over-threshold session).
		const startHandler = getHandler(pi, "session_start");
		const ctx1 = makeCtx({
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 170000, contextWindow: 200000, percent: 85 },
		});
		startHandler!({ type: "session_start", reason: "startup" }, ctx1 as any);
		expect(ctx1.compact).toHaveBeenCalledTimes(1);

		// Now session_compact fires
		handler!(
			{
				type: "session_compact",
				compactionEntry: { id: "c1" },
				fromExtension: true,
				reason: "threshold",
				willRetry: false,
			},
			ctx as any,
		);

		// After completion, the next agent_settled must not re-trigger:
		// the controller waits for usage to drop below the threshold.
		const settleHandler = getHandler(pi, "agent_settled");
		const ctx3 = makeCtx({
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 170000, contextWindow: 200000, percent: 85 },
		});
		settleHandler!({ type: "agent_settled" }, ctx3 as any);
		expect(ctx3.compact).not.toHaveBeenCalled();
		expect(controller.status().inFlight).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 7. UI-guarded notifications
// ---------------------------------------------------------------------------

describe("UI notifications", () => {
	beforeEach(() => {
		mockReadFileSync.mockReset();
		mockReadFileSync.mockImplementation((path: fs.PathOrFileDescriptor) => {
			const p = typeof path === "string" ? path : String(path);
			if (p === PACKAGED_CONFIG_PATH) {
				return JSON.stringify({
					enabled: true,
					default: { percent: 80 },
					rules: [],
				});
			}
			const err = new Error(`ENOENT`) as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});
	});

	it("sends notification on compact completion when UI available", () => {
		const pi = makeFakePi();
		createExtension(pi);

		const startHandler = getHandler(pi, "session_start");
		const ctx = makeCtx({
			hasUI: true,
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 50000, contextWindow: 200000, percent: 25 },
		});
		startHandler!({ type: "session_start", reason: "startup" }, ctx as any);

		const settleHandler = getHandler(pi, "agent_settled");
		const ctx2 = makeCtx({
			hasUI: true,
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 170000, contextWindow: 200000, percent: 85 },
		});
		settleHandler!({ type: "agent_settled" }, ctx2 as any);

		// Invoke onComplete callback from compact
		const compactOpts = ctx2.compact.mock.calls[0][0] as {
			onComplete?: (result: {
				summary: string;
				firstKeptEntryId: string;
				tokensBefore: number;
			}) => void;
		};
		compactOpts.onComplete!({
			summary: "summarized",
			firstKeptEntryId: "e1",
			tokensBefore: 170000,
		});

		expect(ctx2.ui.notify).toHaveBeenCalledWith(
			"Auto-compaction completed",
			"info",
		);
	});

	it("sends notification on compact failure when UI available", () => {
		const pi = makeFakePi();
		createExtension(pi);

		const startHandler = getHandler(pi, "session_start");
		const ctx = makeCtx({
			hasUI: true,
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 50000, contextWindow: 200000, percent: 25 },
		});
		startHandler!({ type: "session_start", reason: "startup" }, ctx as any);

		const settleHandler = getHandler(pi, "agent_settled");
		const ctx2 = makeCtx({
			hasUI: true,
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 170000, contextWindow: 200000, percent: 85 },
		});
		settleHandler!({ type: "agent_settled" }, ctx2 as any);

		const compactOpts = ctx2.compact.mock.calls[0][0] as {
			onError?: (e: Error) => void;
		};
		compactOpts.onError!(new Error("compaction failed"));

		expect(ctx2.ui.notify).toHaveBeenCalledWith(
			"Auto-compaction failed: compaction failed",
			"error",
		);
	});

	it("treats benign compaction races (Already compacted) as completion, not failure", () => {
		const pi = makeFakePi();
		createExtension(pi);

		const startHandler = getHandler(pi, "session_start");
		const ctx = makeCtx({
			hasUI: true,
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 50000, contextWindow: 200000, percent: 25 },
		});
		startHandler!({ type: "session_start", reason: "startup" }, ctx as any);

		const settleHandler = getHandler(pi, "agent_settled");
		const ctx2 = makeCtx({
			hasUI: true,
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 170000, contextWindow: 200000, percent: 85 },
		});
		settleHandler!({ type: "agent_settled" }, ctx2 as any);

		const compactOpts = ctx2.compact.mock.calls[0][0] as {
			onError?: (e: Error) => void;
		};
		compactOpts.onError!(new Error("Already compacted"));

		expect(ctx2.ui.notify).not.toHaveBeenCalled();
		expect(controller.status().inFlight).toBe(false);
	});

	it("treats benign compaction races (Nothing to compact) as completion, not failure", () => {
		const pi = makeFakePi();
		createExtension(pi);

		const startHandler = getHandler(pi, "session_start");
		const ctx = makeCtx({
			hasUI: true,
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 50000, contextWindow: 200000, percent: 25 },
		});
		startHandler!({ type: "session_start", reason: "startup" }, ctx as any);

		const settleHandler = getHandler(pi, "agent_settled");
		const ctx2 = makeCtx({
			hasUI: true,
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 170000, contextWindow: 200000, percent: 85 },
		});
		settleHandler!({ type: "agent_settled" }, ctx2 as any);

		const compactOpts = ctx2.compact.mock.calls[0][0] as {
			onError?: (e: Error) => void;
		};
		compactOpts.onError!(new Error("Nothing to compact (session too small)"));

		expect(ctx2.ui.notify).not.toHaveBeenCalled();
		expect(controller.status().inFlight).toBe(false);
	});

	it("does not call ui.notify when UI is not available", () => {
		const pi = makeFakePi();
		createExtension(pi);

		const startHandler = getHandler(pi, "session_start");
		const ctx = makeCtx({
			hasUI: false,
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 50000, contextWindow: 200000, percent: 25 },
		});
		startHandler!({ type: "session_start", reason: "startup" }, ctx as any);

		const settleHandler = getHandler(pi, "agent_settled");
		const ctx2 = makeCtx({
			hasUI: false,
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 170000, contextWindow: 200000, percent: 85 },
		});
		settleHandler!({ type: "agent_settled" }, ctx2 as any);

		const compactOpts = ctx2.compact.mock.calls[0][0] as {
			onComplete?: (result: {
				summary: string;
				firstKeptEntryId: string;
				tokensBefore: number;
			}) => void;
		};
		compactOpts.onComplete!({
			summary: "summarized",
			firstKeptEntryId: "e1",
			tokensBefore: 170000,
		});

		expect(ctx2.ui.notify).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// 8. /auto-compact status command
// ---------------------------------------------------------------------------

describe("/auto-compact command", () => {
	beforeEach(() => {
		mockReadFileSync.mockReset();
		mockReadFileSync.mockImplementation((path: fs.PathOrFileDescriptor) => {
			const p = typeof path === "string" ? path : String(path);
			if (p === PACKAGED_CONFIG_PATH) {
				return JSON.stringify({
					enabled: true,
					default: { percent: 80 },
					rules: [],
				});
			}
			const err = new Error(`ENOENT`) as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});
	});

	it("emits report via ui.notify when UI available, never via sendMessage", async () => {
		const pi = makeFakePi();
		createExtension(pi);
		const cmdCall = pi.registerCommand.mock.calls.find(
			(c) => c[0] === "auto-compact",
		);
		const handler = cmdCall![1].handler;
		const ctx = makeCtx({
			hasUI: true,
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 50000, contextWindow: 200000, percent: 25 },
		});

		await handler!("", ctx as any);

		expect(ctx.ui.notify).toHaveBeenCalled();
		const report = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock
			.calls[0][0] as string;
		expect(report).toContain("Auto-compact");
		expect(pi.sendMessage).not.toHaveBeenCalled();
	});

	it("does not call ui.notify when UI not available", async () => {
		const pi = makeFakePi();
		createExtension(pi);
		const cmdCall = pi.registerCommand.mock.calls.find(
			(c) => c[0] === "auto-compact",
		);
		const handler = cmdCall![1].handler;
		const ctx = makeCtx({
			hasUI: false,
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 50000, contextWindow: 200000, percent: 25 },
		});

		await handler!("", ctx as any);

		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// 9. Config warnings in status
// ---------------------------------------------------------------------------

describe("config warnings in status", () => {
	beforeEach(() => {
		mockReadFileSync.mockReset();
	});

	it("reports warnings from configuration in status output", async () => {
		mockReadFileSync.mockImplementation((path: fs.PathOrFileDescriptor) => {
			const p = typeof path === "string" ? path : String(path);
			if (p === PACKAGED_CONFIG_PATH) {
				return JSON.stringify({
					enabled: true,
					default: { percent: 80 },
					rules: [],
				});
			}
			if (p === "/mock/agent/auto-compact/config.json") {
				return JSON.stringify({
					default: { percent: 70 },
					rules: [{ match: "foo/bar", percent: -1 }],
				});
			}
			const err = new Error(`ENOENT`) as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});

		const pi = makeFakePi();
		createExtension(pi);

		const startHandler = getHandler(pi, "session_start");
		const ctx = makeCtx({
			hasUI: true,
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 50000, contextWindow: 200000, percent: 25 },
		});
		await startHandler!(
			{ type: "session_start", reason: "startup" },
			ctx as any,
		);

		const cmdCall = pi.registerCommand.mock.calls.find(
			(c) => c[0] === "auto-compact",
		);
		const handler = cmdCall![1].handler;
		await handler!("", ctx as any);

		const report = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock
			.calls[0][0] as string;
		expect(report).toContain("Warning");
	});
});

// ---------------------------------------------------------------------------
// 10. Disabled model rule cancels threshold
// ---------------------------------------------------------------------------

describe("disabled model rule", () => {
	beforeEach(() => {
		mockReadFileSync.mockReset();
		mockReadFileSync.mockImplementation((path: fs.PathOrFileDescriptor) => {
			const p = typeof path === "string" ? path : String(path);
			if (p === PACKAGED_CONFIG_PATH) {
				return JSON.stringify({
					enabled: true,
					default: { percent: 80 },
					rules: [{ match: "google/gemini-*", enabled: false }],
				});
			}
			const err = new Error(`ENOENT`) as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});
	});

	it("cancels threshold compaction for disabled model rule", () => {
		const pi = makeFakePi();
		createExtension(pi);

		// Load config first so currentPolicy is resolved
		const startHandler = getHandler(pi, "session_start");
		const ctx0 = makeCtx({
			model: makeModel("google", "gemini-1.5-pro", 200000),
			usage: { tokens: 170000, contextWindow: 200000, percent: 85 },
		});
		startHandler!({ type: "session_start", reason: "startup" }, ctx0 as any);

		const handler = getHandler(pi, "session_before_compact");
		const ctx = makeCtx({
			model: makeModel("google", "gemini-1.5-pro", 200000),
			usage: { tokens: 170000, contextWindow: 200000, percent: 85 },
		});
		const result = handler!(
			{
				type: "session_before_compact",
				preparation: { firstKeptEntryId: "e1", tokensBefore: 170000 },
				branchEntries: [],
				reason: "threshold",
				willRetry: false,
				signal: new AbortController().signal,
			},
			ctx as any,
		);
		expect(result).toEqual({ cancel: true });
	});
});

// ---------------------------------------------------------------------------
// 11. Global disablement
// ---------------------------------------------------------------------------

describe("global disablement", () => {
	beforeEach(() => {
		mockReadFileSync.mockReset();
		mockReadFileSync.mockImplementation((path: fs.PathOrFileDescriptor) => {
			const p = typeof path === "string" ? path : String(path);
			if (p === PACKAGED_CONFIG_PATH) {
				return JSON.stringify({
					enabled: false,
					default: { percent: 80 },
					rules: [],
				});
			}
			const err = new Error(`ENOENT`) as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});
	});

	it("allows threshold compaction when globally disabled (unchanged Pi behavior)", () => {
		const pi = makeFakePi();
		createExtension(pi);
		const handler = getHandler(pi, "session_before_compact");
		const ctx = makeCtx({
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 170000, contextWindow: 200000, percent: 85 },
		});
		const result = handler!(
			{
				type: "session_before_compact",
				preparation: { firstKeptEntryId: "e1", tokensBefore: 170000 },
				branchEntries: [],
				reason: "threshold",
				willRetry: false,
				signal: new AbortController().signal,
			},
			ctx as any,
		);
		expect(result).toEqual({});
	});

	it("does not trigger auto-compact when globally disabled", () => {
		const pi = makeFakePi();
		createExtension(pi);

		const startHandler = getHandler(pi, "session_start");
		const ctx = makeCtx({
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 170000, contextWindow: 200000, percent: 85 },
		});
		startHandler!({ type: "session_start", reason: "startup" }, ctx as any);

		const settleHandler = getHandler(pi, "agent_settled");
		const ctx2 = makeCtx({
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 170000, contextWindow: 200000, percent: 85 },
		});
		settleHandler!({ type: "agent_settled" }, ctx2 as any);

		expect(ctx2.compact).not.toHaveBeenCalled();
	});

	it("allows threshold compaction when globally disabled even with a matching rule", () => {
		const pi = makeFakePi();
		createExtension(pi);
		const handler = getHandler(pi, "session_before_compact");
		const ctx = makeCtx({
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 170000, contextWindow: 200000, percent: 85 },
		});
		const result = handler!(
			{
				type: "session_before_compact",
				preparation: { firstKeptEntryId: "e1", tokensBefore: 170000 },
				branchEntries: [],
				reason: "threshold",
				willRetry: false,
				signal: new AbortController().signal,
			},
			ctx as any,
		);
		expect(result).toEqual({});
	});
});

// ---------------------------------------------------------------------------
// 12. Precedence-based global enablement in status
// ---------------------------------------------------------------------------

describe("precedence-based global enablement in status", () => {
	beforeEach(() => {
		mockReadFileSync.mockReset();
	});

	it("reports enabled when only packaged layer specifies enabled:true", async () => {
		mockReadFileSync.mockImplementation((path: fs.PathOrFileDescriptor) => {
			const p = typeof path === "string" ? path : String(path);
			if (p === PACKAGED_CONFIG_PATH) {
				return JSON.stringify({
					enabled: true,
					default: { percent: 80 },
					rules: [],
				});
			}
			const err = new Error(`ENOENT`) as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});

		const pi = makeFakePi();
		createExtension(pi);

		const startHandler = getHandler(pi, "session_start");
		const ctx = makeCtx({
			hasUI: true,
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 50000, contextWindow: 200000, percent: 25 },
		});
		await startHandler!(
			{ type: "session_start", reason: "startup" },
			ctx as any,
		);

		const cmdCall = pi.registerCommand.mock.calls.find(
			(c) => c[0] === "auto-compact",
		);
		const handler = cmdCall![1].handler;
		await handler!("", ctx as any);

		const report = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock
			.calls[0][0] as string;
		expect(report).toContain("Auto-compact: enabled");
	});

	it("reports disabled when user layer overrides packaged enabled:true", async () => {
		mockReadFileSync.mockImplementation((path: fs.PathOrFileDescriptor) => {
			const p = typeof path === "string" ? path : String(path);
			if (p === PACKAGED_CONFIG_PATH) {
				return JSON.stringify({
					enabled: true,
					default: { percent: 80 },
					rules: [],
				});
			}
			if (p === "/mock/agent/auto-compact/config.json") {
				return JSON.stringify({ enabled: false });
			}
			const err = new Error(`ENOENT`) as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});

		const pi = makeFakePi();
		createExtension(pi);

		const startHandler = getHandler(pi, "session_start");
		const ctx = makeCtx({
			hasUI: true,
			model: makeModel("anthropic", "claude-3-opus", 200000),
			usage: { tokens: 50000, contextWindow: 200000, percent: 25 },
		});
		await startHandler!(
			{ type: "session_start", reason: "startup" },
			ctx as any,
		);

		const cmdCall = pi.registerCommand.mock.calls.find(
			(c) => c[0] === "auto-compact",
		);
		const handler = cmdCall![1].handler;
		await handler!("", ctx as any);

		const report = (ctx.ui.notify as ReturnType<typeof vi.fn>).mock
			.calls[0][0] as string;
		expect(report).toContain("Auto-compact: disabled");
	});
});
