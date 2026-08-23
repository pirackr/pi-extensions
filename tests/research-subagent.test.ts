/**
 * Research-owned ProfilePolicyAdapter — TDD integration suite (Task 14).
 *
 * Characterizes the research-owned adapter that maps the owner-neutral generic
 * {@link ProfilePolicyAdapter} contract (reserve/settle) onto the frozen
 * ResearchPolicy (reserveAttempt/releaseAttempt/exportArtifact). Also covers
 * the registration/integration primitive.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import type {
	ProfilePolicyAdapter,
	ProfileReservation,
	ProfileSettlement,
} from "../extensions/subagent/types.ts";
import type { ResolvedRole } from "../extensions/research/policy.ts";
import {
	newRunState,
} from "../extensions/research/state.ts";
import { createRunManifest } from "../extensions/research/manifest.ts";
import type { Workspace } from "../extensions/research/workspace.ts";
import {
	createResearchPolicyAdapter,
	registerResearchSubagentIntegration,
	type PolicyAdapterContribution,
} from "../extensions/research/subagent.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "research-subagent-test-"));
}

function cleanup(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

function makeFakeWorkspace(
	tmpDir: string,
	mission: string,
	transitionId: string,
): Workspace {
	const wsPath = path.join(tmpDir, mission.replace(/\s+/g, "-"));
	fs.mkdirSync(wsPath, { recursive: false });
	fs.mkdirSync(path.join(wsPath, ".research"), { recursive: false });

	const init = newRunState({
		path: wsPath,
		projectRoot: tmpDir,
		mission,
		runId: `${transitionId}-${mission.replace(/\s+/g, "-")}`,
		transitionId,
	});
	const statePath = path.join(wsPath, ".research", "run-state.json");
	fs.writeFileSync(statePath, JSON.stringify(init, null, 2), "utf-8");
	createRunManifest({
		path: wsPath,
		projectRoot: tmpDir,
		mission,
		runId: init.runId,
		transitionId,
	});

	return { path: wsPath, projectRoot: tmpDir, mission, runId: init.runId, transitionId };
}

function makeRole(name: string): ResolvedRole {
	return {
		description: `${name} role`,
		model: "strong",
		thinking: "high",
		tools: ["read"],
		access: "read",
		timeoutSeconds: 720,
		promptPath: "/dev/null",
		resultFormat: "markdown",
		totalDispatch: 10,
		concurrentDispatch: 2,
		maxSearches: 5,
		maxFetches: 5,
		retention: "ephemeral",
	};
}

function makeAdapter(workspace: Workspace, frozenRoles: Record<string, ResolvedRole> = { scout: makeRole("scout") }) {
	return createResearchPolicyAdapter({
		workspace,
		frozenConfig: { roles: frozenRoles, hardTimeoutSeconds: 1800 },
	});
}

/** Simulate a fresh adapter instance after a restart: same workspace + config. */
function makeFreshAdapter(workspace: Workspace) {
	return makeAdapter(workspace);
}

function outcome(state: ProfileSettlement["state"], reason: string | null, agentId = "a001") {
	return {
		owner: "research",
		profile: "scout",
		agentId,
		state,
		terminalReason: reason,
		artifactPath: "/tmp/artifacts/subagents/" + agentId,
		result: {
			agentId,
			state,
			output: state === "succeeded" ? "done" : "",
			usage: { totalTokens: 0, toolUses: 0, durationMs: 1 },
			finishedAt: 1,
			terminalReason: reason,
		},
	} as Omit<ProfileSettlement, "reservation">;
}

// ===========================================================================
// Integration primitive
// ===========================================================================

describe("registerResearchSubagentIntegration", () => {
	let tmpDir: string;
	beforeEach(() => { tmpDir = createTempDir(); });
	afterEach(() => { cleanup(tmpDir); });

	it("contributes exactly one research-owned policy adapter on the integration event", () => {
		const workspace = makeFakeWorkspace(tmpDir, "integration", "t1");
		const contributions: PolicyAdapterContribution[] = [];
		const pi = {
			events: {
				emit: (channel: string, data: { contributions: PolicyAdapterContribution[] }) => {
					expect(channel).toBe("subagent:register-policy-adapters");
					contributions.push(...data.contributions);
				},
			},
		};

		registerResearchSubagentIntegration(pi as never, {
			workspace,
			frozenConfig: { roles: { scout: makeRole("scout") }, hardTimeoutSeconds: 1800 },
		});

		expect(contributions).toHaveLength(1);
		expect(contributions[0].owner).toBe("research");
		expect(typeof contributions[0].adapter.reserve).toBe("function");
		expect(typeof contributions[0].adapter.settle).toBe("function");
	});
});

// ===========================================================================
// reserve — durable, JSON-serializable reservation metadata
// ===========================================================================

describe("ProfilePolicyAdapter.reserve", () => {
	let tmpDir: string;
	beforeEach(() => { tmpDir = createTempDir(); });
	afterEach(() => { cleanup(tmpDir); });

	it("returns a JSON-serializable reservation whose token is durable", async () => {
		const workspace = makeFakeWorkspace(tmpDir, "reserve durable", "t1");
		const adapter = makeAdapter(workspace);

		const reservation = await adapter.reserve("research", "scout", "a001");
		expect(reservation).toBeDefined();
		const json = JSON.parse(JSON.stringify(reservation)) as ProfileReservation;
		expect(json).toMatchObject({ owner: "research", profile: "scout" });
		expect(typeof json.token).toBe("string");
		expect(json.token.length).toBeGreaterThan(0);
	});

	it("maps each reserve call to one distinct reservation (one reservation per enqueue)", async () => {
		const workspace = makeFakeWorkspace(tmpDir, "reserve distinct", "t1");
		const adapter = makeAdapter(workspace);

		const a = await adapter.reserve("research", "scout", "a001");
		const b = await adapter.reserve("research", "scout", "a002");
		expect(a).toBeDefined();
		expect(b).toBeDefined();
		expect(a!.token).not.toBe(b!.token);
	});

	it("re-serving the same agent admission is idempotent", async () => {
		const workspace = makeFakeWorkspace(tmpDir, "reserve idempotent", "t1");
		const adapter = makeAdapter(workspace);
		const a = await adapter.reserve("research", "scout", "a001");
		const b = await adapter.reserve("research", "scout", "a001");
		expect(b).toEqual(a);
		const state = JSON.parse(fs.readFileSync(path.join(workspace.path, ".research", "run-state.json"), "utf-8"));
		expect(state.concurrentReservations).toBe(1);
		expect(state.reservationTotals.scout).toBe(1);
	});

	it("rejects a non-manifest profile (frozen whitelist) with undefined", async () => {
		const workspace = makeFakeWorkspace(tmpDir, "reserve whitelist", "t1");
		const adapter = makeAdapter(workspace);
		await expect(adapter.reserve("research", "ghost", "a001")).resolves.toBeUndefined();
	});

	it("never mutates the frozen config snapshot", () => {
		const roles = { scout: makeRole("scout") };
		const before = JSON.stringify(roles);
		const workspace = makeFakeWorkspace(tmpDir, "reserve immutability", "t1");
		makeAdapter(workspace, roles);
		expect(JSON.stringify(roles)).toBe(before);
	});
});

// ===========================================================================
// settle — durable release, exactly-once, recovered by a fresh instance
// ===========================================================================

describe("ProfilePolicyAdapter.settle", () => {
	let tmpDir: string;
	beforeEach(() => { tmpDir = createTempDir(); });
	afterEach(() => { cleanup(tmpDir); });

	async function readConcurrent(workspace: Workspace): Promise<number> {
		return JSON.parse(
			fs.readFileSync(path.join(workspace.path, ".research", "run-state.json"), "utf-8"),
		).concurrentReservations as number;
	}

	it("releases concurrency after a successful terminal", async () => {
		const workspace = makeFakeWorkspace(tmpDir, "settle success", "t1");
		const adapter = makeAdapter(workspace);
		const reservation = await adapter.reserve("research", "scout", "a001");
		expect(await readConcurrent(workspace)).toBe(1);

		await adapter.settle({ ...outcome("succeeded", null), reservation });
		expect(await readConcurrent(workspace)).toBe(0);
	});

	it("releases concurrency for failure, cancellation, and interruption", async () => {
		for (const state of ["failed", "cancelled", "interrupted", "timed_out"] as const) {
			const workspace = makeFakeWorkspace(tmpDir, `settle ${state}`, "t1");
			const adapter = makeAdapter(workspace);
			const reservation = await adapter.reserve("research", "scout", "a001");
			expect(await readConcurrent(workspace)).toBe(1);
			await adapter.settle({ ...outcome(state, "done"), reservation });
			expect(await readConcurrent(workspace)).toBe(0);
			cleanup(tmpDir);
			tmpDir = createTempDir();
		}
	});

	it("is idempotent: repeated settlement releases concurrency only once", async () => {
		const workspace = makeFakeWorkspace(tmpDir, "settle idempotent", "t1");
		const adapter = makeAdapter(workspace);
		const reservation = await adapter.reserve("research", "scout", "a001");
		expect(await readConcurrent(workspace)).toBe(1);

		await adapter.settle({ ...outcome("succeeded", null), reservation });
		expect(await readConcurrent(workspace)).toBe(0);
		// Repeated settlement must be a no-op and must not throw.
		await expect(
			adapter.settle({ ...outcome("succeeded", null), reservation }),
		).resolves.toBeUndefined();
		expect(await readConcurrent(workspace)).toBe(0);
	});

	it("releases only the settled slot when multiple reservations are active", async () => {
		const workspace = makeFakeWorkspace(tmpDir, "settle one of two", "t1");
		const adapter = makeAdapter(workspace);
		const first = await adapter.reserve("research", "scout", "a001");
		const second = await adapter.reserve("research", "scout", "a002");
		expect(first).toBeDefined();
		expect(second).toBeDefined();
		expect(await readConcurrent(workspace)).toBe(2);

		await adapter.settle({ ...outcome("failed", "boom", "a001"), reservation: first });
		expect(await readConcurrent(workspace)).toBe(1);
	});

	it("never restores the consumed total, including after adapter restart", async () => {
		const workspace = makeFakeWorkspace(tmpDir, "settle total retained", "t1");
		const role = makeRole("scout");
		role.totalDispatch = 1;
		role.concurrentDispatch = 1;
		const adapter = makeAdapter(workspace, { scout: role });
		const reservation = await adapter.reserve("research", "scout", "a001");
		expect(reservation).toBeDefined();
		await adapter.settle({ ...outcome("failed", "boom"), reservation });
		// The consumed total is durable and never restored after a restart.
		const fresh = makeAdapter(workspace, { scout: role });
		await expect(fresh.reserve("research", "scout")).resolves.toBeUndefined();
	});

	it("exports a successful terminal result once before releasing", async () => {
		const workspace = makeFakeWorkspace(tmpDir, "settle export", "t1");
		const adapter = makeAdapter(workspace);
		const reservation = await adapter.reserve("research", "scout", "a001");
		const settlement = {
			...outcome("succeeded", null),
			reservation,
			result: {
				agentId: "a001",
				state: "succeeded" as const,
				output: "final research output",
				usage: { totalTokens: 7, toolUses: 2, durationMs: 100 },
				finishedAt: 2_000,
				terminalReason: null,
			},
		};

		await adapter.settle(settlement);
		await adapter.settle(settlement);
		const artifactDir = path.join(workspace.path, ".research", "artifacts");
		const artifacts = fs.readdirSync(artifactDir).filter((name) => name.startsWith("artifact-"));
		expect(artifacts).toHaveLength(1);
		const exported = JSON.parse(fs.readFileSync(path.join(artifactDir, artifacts[0]), "utf-8"));
		expect(exported.output).toBe("final research output");
		expect(exported.usage.totalTokens).toBe(7);
		expect(await readConcurrent(workspace)).toBe(0);
	});

	it("releases concurrency even when successful-result export fails", async () => {
		const workspace = makeFakeWorkspace(tmpDir, "settle export failure", "t1");
		const adapter = makeAdapter(workspace);
		const reservation = await adapter.reserve("research", "scout", "a001");
		fs.writeFileSync(path.join(workspace.path, ".research", "artifacts"), "not a directory");

		await expect(adapter.settle({
			...outcome("succeeded", null),
			reservation,
		})).rejects.toThrow();
		expect(await readConcurrent(workspace)).toBe(0);
	});

	it("settles durably by a fresh adapter instance after a restart", async () => {
		const workspace = makeFakeWorkspace(tmpDir, "settle recovered", "t1");
		const role = makeRole("scout");
		role.totalDispatch = 10;
		role.concurrentDispatch = 1;
		const adapter = makeAdapter(workspace, { scout: role });

		// Reserve in the original instance, then drop it (fresh process).
		const reservation = await adapter.reserve("research", "scout", "a001");
		expect(await readConcurrent(workspace)).toBe(1);
		const staleToken = reservation!.token;

		const fresh = makeFreshAdapter(workspace);
		await fresh.settle({ ...outcome("succeeded", null), reservation: { ...reservation } });
		expect(await readConcurrent(workspace)).toBe(0);

		// And repeated recovery settlement is a no-op.
		await expect(
			fresh.settle({ ...outcome("succeeded", null), reservation: { ...reservation, token: staleToken } }),
		).resolves.toBeUndefined();
		expect(await readConcurrent(workspace)).toBe(0);
	});
});

// ===========================================================================
// Preserved ResearchPolicy behavior through the adapter
// ===========================================================================

describe("ProfilePolicyAdapter — preserved ResearchPolicy behavior", () => {
	let tmpDir: string;
	beforeEach(() => { tmpDir = createTempDir(); });
	afterEach(() => { cleanup(tmpDir); });

	it("validates the frozen role schema at construction (validation)", () => {
		const workspace = makeFakeWorkspace(tmpDir, "adapter validation", "t1");
		const role = makeRole("scout");
		// @ts-expect-error — inject unknown field
		role.unknownField = "rejected";
		expect(
			() => createResearchPolicyAdapter({
				workspace,
				frozenConfig: { roles: { scout: role }, hardTimeoutSeconds: 1800 },
			}),
		).toThrow(/Unknown field/i);
	});

	it("enforces per-role concurrent ceilings (limits)", async () => {
		const workspace = makeFakeWorkspace(tmpDir, "adapter limits", "t1");
		const role = makeRole("scout");
		role.concurrentDispatch = 1;
		const adapter = makeAdapter(workspace, { scout: role });
		const first = await adapter.reserve("research", "scout", "a001");
		expect(first).toBeDefined();
		await expect(adapter.reserve("research", "scout", "a002")).resolves.toBeUndefined();
	});

	it("enforces hard timeout (defaults to 1800s)", async () => {
		const workspace = makeFakeWorkspace(tmpDir, "adapter timeout", "t1");
		const adapter = createResearchPolicyAdapter({
			workspace,
			frozenConfig: { roles: { scout: makeRole("scout") }, hardTimeoutSeconds: 0 },
		});
		await expect(adapter.reserve("research", "scout", "a001")).resolves.toBeUndefined();
	});

	it("validates retention levels (budgets/retention)", () => {
		const workspace = makeFakeWorkspace(tmpDir, "adapter retention", "t1");
		const role = makeRole("scout");
		role.retention = "persistent" as const;
		expect(() => makeAdapter(workspace, { scout: role })).not.toThrow();
	});

	it("confines exported artifacts beneath the canonical workspace", async () => {
		const workspace = makeFakeWorkspace(tmpDir, "adapter confinement", "t1");
		const adapter = makeAdapter(workspace);
		const reservation = await adapter.reserve("research", "scout", "a001");
		const meta = await (adapter as never).exportArtifact(
			reservation as never,
			{ output: { data: "x" }, usage: { totalTokens: 1 } } as never,
		);
		expect(meta).toBeDefined();
		expect(meta!.artifactId.startsWith(workspace.path)).toBe(true);
	});

	it("JSON serializes failure throws structured errors (JSON)", async () => {
		const workspace = makeFakeWorkspace(tmpDir, "adapter json", "t1");
		const role = makeRole("scout");
		role.resultFormat = "json";
		const adapter = makeAdapter(workspace, { scout: role });
		const reservation = await adapter.reserve("research", "scout", "a001");
		const circular: Record<string, unknown> = { label: "circular" };
		circular.self = circular;
		await expect(
			(adapter as never).exportArtifact(reservation as never, { output: circular } as never),
		).rejects.toThrow(/JSON serialization failed/);
	});
});
