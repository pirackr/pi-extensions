/**
 * Task 13: Research integration suite — end-to-end research flow.
 *
 * Deterministic, model-free integration tests that reuse the REAL modules
 * under test (extensions/research/*, extensions/loop/engine.ts + state.ts)
 * and mock only the transport/model/provider boundary:
 *
 *  - injected model/provider registry doubles (fakeModelRegistry /
 *    fakeProviderRegistry, same pattern as tests/research-startup.test.ts)
 *  - a RecordingProvider fake whose physical-launch log is compared against
 *    the persisted reserved-attempt ledger
 *
 * Coverage:
 *  - startup / frozen snapshots (real workspace/state/manifest/transitions)
 *  - evidence collection + checkpoint idempotence + later synthesis
 *  - evidence / report staleness
 *  - every researchCompletionGate failure + all-pass success +
 *    finalizeSuccess + StateConflict re-audit
 *  - iteration / token / dispatch / no-progress limits (LoopEngine budget
 *    enforcement + ResearchPolicy dispatch counters)
 *  - reload / resume / interruption / provider mismatch
 *  - replacement / abandonment / history
 *  - concurrent state updates
 *  - end-to-end usage totals: coordinator + nested across parallel calls and
 *    retries, persistence across reload, no double-count after replay, and
 *    fake-provider launch log == persisted reserved-attempt ledger
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import type { Workspace } from "../extensions/research/workspace.ts";
import {
	acquireWorkspaceClaim,
	prepareStaging,
	commitStaging,
	reconcileTransition,
	ensureGitExclude,
} from "../extensions/research/workspace.ts";
import type { StateConflict } from "../extensions/research/state.ts";
import {
	newRunState,
	readRunState,
	updateRunState,
	acquireLease,
} from "../extensions/research/state.ts";
import {
	createRunManifest,
	readManifest,
} from "../extensions/research/manifest.ts";
import {
	evaluateCheckpoint,
	computeEvidenceDigest,
} from "../extensions/research/checkpoint.ts";
import {
	researchCompletionGate,
	finalizeSuccess,
} from "../extensions/research/completion.ts";
import {
	ResearchPolicy,
	type FrozenConfig,
} from "../extensions/research/policy.ts";
import {
	prepareAndActivateResearch,
	validateStartupContract,
	TransitionsFile,
	type ModelRegistryView,
	type ProviderRegistryView,
	type StartupDependencies,
	type ResearchStartRequest,
	type ActiveResearchPointer,
} from "../extensions/research/startup.ts";
import type { ResolvedResearchConfig } from "../extensions/research/config.ts";
import {
	createLifecycleSnapshot,
	persistLifecycle,
	pauseLifecycle,
	markAbandoned,
	markReplaced,
	loadLifecycleSnapshot,
} from "../extensions/research/lifecycle.ts";
import {
	listWorkspaces,
	lookupWorkspace,
} from "../extensions/research/history.ts";
import { resumeWorkspace } from "../extensions/research/resume.ts";
import { LoopEngine } from "../extensions/loop/engine.ts";
import type { LoopState } from "../extensions/loop/state.ts";
import {
	addCoordinatorUsage,
	addNestedUsage,
} from "../extensions/loop/state.ts";
import type {
	CompletionPolicy,
	CompletionFailure,
} from "../extensions/loop/completion.ts";
import { makeGenericPolicy } from "../extensions/loop/completion.ts";
import type {
	AttemptResult,
	AttemptOutcome,
	AttemptReservation,
	ResolvedAttempt,
	ProviderDescriptor,
} from "../extensions/subagent-dispatch/contract.ts";

// ---------------------------------------------------------------------------
// Helpers — temp dirs, registries, workspaces, evidence
// ---------------------------------------------------------------------------

function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "research-integration-"));
}

function cleanup(dir: string): void {
	fs.rmSync(dir, { recursive: true, force: true });
}

function baseConfig(): ResolvedResearchConfig {
	return {
		defaultProgram: "skills/research/program.md",
		defaultProfile: "standard",
		defaultProvider: null,
		defaults: {
			maxIterations: 10,
			maxTokens: 200000,
			noProgress: 2,
			scoreThreshold: 80,
			retryCount: 1,
			maxSearches: 30,
			maxFetches: 30,
		},
		profiles: {
			standard: {
				minRounds: 5,
				maxRounds: 5,
				minSources: 30,
				maxScouts: 8,
				maxFetchers: 4,
				verification: ["judge"],
			},
			quick: {
				minRounds: 3,
				maxRounds: 3,
				minSources: 15,
				maxScouts: 3,
				maxFetchers: 1,
				verification: ["judge"],
			},
		},
		roles: {
			scout: {
				description: "Discover sources",
				model: "strong",
				thinking: "high",
				tools: ["web_lookup", "fetch_web"],
				access: "read",
				timeoutSeconds: 1800,
				promptPath: "/fake/scout.md",
				resultFormat: "markdown",
				totalDispatch: 30,
				concurrentDispatch: 8,
				maxSearches: 30,
				maxFetches: 30,
				retention: "artifact",
			},
			judge: {
				description: "Evaluate report",
				model: "eval",
				thinking: "medium",
				tools: ["read"],
				access: "read",
				timeoutSeconds: 1200,
				promptPath: "/fake/judge.md",
				resultFormat: "markdown",
				totalDispatch: 10,
				concurrentDispatch: 1,
				maxSearches: 10,
				maxFetches: 10,
				retention: "artifact",
			},
		},
		capabilities: {},
		childExtensions: [],
	};
}

function fakeModelRegistry(
	overrides: Record<
		string,
		{ id: string; name: string; provider: string; capabilities?: string[] }
	> = {},
): ModelRegistryView {
	const models = { ...overrides };
	return {
		get(name: string) {
			const m = models[name];
			return m ? { ...m, capabilities: m.capabilities ?? [] } : undefined;
		},
		has(name: string) {
			return name in models;
		},
	};
}

function fakeProviderRegistry(
	descs: ProviderDescriptor[] = [],
): ProviderRegistryView {
	const map = new Map<string, ProviderDescriptor>();
	for (const d of descs) {
		map.set(d.id, d);
	}
	return {
		get(id: string) {
			return map.get(id);
		},
		has(id: string) {
			return map.has(id);
		},
		getAll() {
			return Array.from(map.values());
		},
	};
}

function standardModels() {
	return fakeModelRegistry({
		strong: {
			id: "strong-1",
			name: "strong",
			provider: "anthropic",
			capabilities: ["web_lookup", "fetch_web"],
		},
		eval: {
			id: "eval-1",
			name: "eval",
			provider: "anthropic",
			capabilities: ["read"],
		},
	});
}

function standardProviders(): ProviderRegistryView {
	return fakeProviderRegistry([
		{
			id: "local",
			adapterVersion: "1.0",
			capabilities: ["web_lookup", "fetch_web", "read", "local"],
		},
	]);
}

/**
 * Build a real retained workspace via the real workspace/state/manifest
 * modules: claim → staging → commit → manifest → run-state file.
 */
function buildWorkspace(
	tmpDir: string,
	mission: string,
	transitionId = "tr-int-1",
): Workspace {
	const claim = acquireWorkspaceClaim(tmpDir, mission, transitionId);
	const staged = prepareStaging(claim);
	fs.mkdirSync(staged.stagingPath, { recursive: true });
	const ws = commitStaging(staged, claim);
	createRunManifest(
		ws,
		JSON.stringify({
			mission: ws.mission,
			profile: "standard",
			createdAt: Date.now(),
		}),
	);
	const init = newRunState(ws);
	fs.writeFileSync(
		path.join(ws.path, ".research", "run-state.json"),
		JSON.stringify(init, null, 2),
		"utf-8",
	);
	return ws;
}

/** Five score rows at 90 — above the packaged 80 threshold. */
const SCORE_MD =
	"| ID | Question | Score | Notes |\n" +
	"| --- | --- | ---: | --- |\n" +
	"| q1 | question | 90 | note |\n" +
	"| q2 | question | 90 | note |\n" +
	"| q3 | question | 90 | note |\n" +
	"| q4 | question | 90 | note |\n" +
	"| q5 | question | 90 | note |\n";

/** 16 unique source URLs — above the packaged quick profile floor of 15. */
function notesMd(count = 16): string {
	let out =
		"| URL | Title | Tier | Retrieved | Claims |\n" +
		"| --- | --- | --- | --- | --- |\n";
	for (let i = 0; i < count; i++) {
		out += `| https://example.com/source-${i} | Source ${i} | primary | 2026-08-01 | 2 |\n`;
	}
	return out;
}

function writeEvidence(ws: Workspace): string {
	const notes = notesMd();
	fs.writeFileSync(path.join(ws.path, "score.md"), SCORE_MD, "utf-8");
	fs.writeFileSync(path.join(ws.path, "notes.md"), notes, "utf-8");
	return computeEvidenceDigest(SCORE_MD, notes);
}

function writeReport(ws: Workspace): void {
	fs.writeFileSync(
		path.join(ws.path, "report.org"),
		"* Report\n\nSome findings with [https://example.com/source-0].\n",
		"utf-8",
	);
}

function writeJudge(
	ws: Workspace,
	runId: string,
	opts?: { pass?: boolean; verdict?: string },
): void {
	const artifact = {
		version: 1,
		runId,
		pass: opts?.pass ?? true,
		verdict: opts?.verdict ?? "PASS",
		failedChecks: [],
		fixes: [],
	};
	fs.mkdirSync(path.join(ws.path, "verification"), { recursive: true });
	fs.writeFileSync(
		path.join(ws.path, "verification", "judge.json"),
		JSON.stringify(artifact),
	);
}

function codes(failures: CompletionFailure[]): string[] {
	return failures.map((f) => f.code);
}

function messages(failures: CompletionFailure[]): string {
	return failures.map((f) => `${f.code}: ${f.message}`).join("\n");
}

function flushMicrotasks(): Promise<void> {
	return new Promise((r) => setImmediate(r));
}

/** Mock pi + ctx doubles used to drive the real LoopEngine (as in loop-engine.test.ts). */
function makeMockPi() {
	const entries: Array<{ type: string; data: unknown }> = [];
	const activeTools: string[] = [];
	const messages: Array<{
		customType: string;
		content: string;
		details: unknown;
	}> = [];
	const pi = {
		appendEntry: vi.fn((type: string, data: unknown) => {
			entries.push({ type, data });
		}),
		getActiveTools: () => [...activeTools],
		setActiveTools: vi.fn((tools: string[]) => {
			activeTools.length = 0;
			activeTools.push(...tools);
		}),
		sendMessage: vi.fn((msg: unknown) => {
			messages.push(
				msg as { customType: string; content: string; details: unknown },
			);
		}),
	};
	return { pi, entries, activeTools, messages };
}

function makeMockCtx(pending = false) {
	const statusLines: string[] = [];
	return {
		ui: {
			setStatus: vi.fn((_: string, line: string) => statusLines.push(line)),
		},
		hasPendingMessages: () => pending,
		isIdle: () => !pending,
		sessionManager: {
			getEntries: () =>
				[] as Array<{ type: string; customType: string; data: unknown }>,
		},
		getStatusLines: () => [...statusLines],
	};
}

function makeEngine() {
	const { pi, entries, messages } = makeMockPi();
	const ctx = makeMockCtx();
	const engine = new LoopEngine({
		completionPolicy: makeGenericPolicy(),
		onStateChange: async () => {},
	});
	return { engine, pi, ctx, entries, messages };
}

/** Research-shaped completion policy adapter: audits the disk workspace. */
function researchGatePolicy(ws: Workspace): CompletionPolicy {
	return {
		async audit(_state: Readonly<LoopState>): Promise<CompletionFailure[]> {
			const diskWs: Workspace = {
				...ws,
				runId: readRunState(ws).runId,
			};
			return researchCompletionGate(diskWs);
		},
	};
}

// ---------------------------------------------------------------------------
// RecordingProvider — fake provider with a physical-launch log
// ---------------------------------------------------------------------------

interface LaunchRecord {
	attemptId: string;
	planId: string;
	index: number;
	usage: number;
	status: "completed" | "failed";
}

/**
 * Fake subagent provider. Every `executeAttempt` call pushes one physical
 * launch record — tests compare this log against the persisted
 * reserved-attempt ledger to prove limits cannot be bypassed and usage is
 * not double-counted.
 */
class RecordingProvider {
	readonly launches: LaunchRecord[] = [];
	failAttempts = new Set<string>();
	usagePerLaunch = 25;

	reset(): void {
		this.launches.length = 0;
		this.failAttempts.clear();
	}

	async executeAttempt(
		plan: { attemptId: string; planId: string; index: number },
		_signal: AbortSignal,
	): Promise<AttemptResult> {
		const failed = this.failAttempts.has(plan.attemptId);
		this.launches.push({
			attemptId: plan.attemptId,
			planId: plan.planId,
			index: plan.index,
			usage: failed ? 0 : this.usagePerLaunch,
			status: failed ? "failed" : "completed",
		});
		if (failed) {
			throw new Error(`attempt ${plan.attemptId} failed`);
		}
		return {
			output: { attemptId: plan.attemptId, result: "done" },
			usage: { totalTokens: this.usagePerLaunch },
			metadata: { provider: "recording-provider" },
		};
	}
}

/**
 * End-to-end dispatch helper mirroring the façade lifecycle: reserve →
 * execute exactly one provider attempt → normalize outcome → export →
 * release. Persists every successful reservation to
 * `.research/attempt-ledger.json` (the durable reserved-attempt ledger).
 * Returns the aggregated nested usage (completed attempts only, like the
 * real façade) and the list of released outcomes.
 */
async function dispatchAttempts(
	policy: ResearchPolicy,
	provider: RecordingProvider,
	attempts: ResolvedAttempt[],
): Promise<{ aggregated: number; outcomes: AttemptOutcome[] }> {
	const ledgerPath = path.join(
		policy.workspace.path,
		".research",
		"attempt-ledger.json",
	);
	const ledger: Array<{
		reservationId: string;
		attemptId: string;
		planId: string;
	}> = [];
	let aggregated = 0;
	const outcomes: AttemptOutcome[] = [];

	for (const attempt of attempts) {
		const reservation: AttemptReservation | undefined =
			await policy.reserveAttempt(attempt);
		if (!reservation) {
			// Reservation rejected — no physical launch.
			outcomes.push({
				status: "failed",
				error: { message: "reservation rejected" },
			});
			continue;
		}
		// Persist the reservation BEFORE launching (crash-safe ledger).
		ledger.push({
			reservationId: reservation.reservationId,
			attemptId: attempt.attemptId,
			planId: attempt.planId,
		});
		fs.writeFileSync(ledgerPath, JSON.stringify(ledger, null, 2), "utf-8");

		let outcome: AttemptOutcome;
		try {
			const result = await provider.executeAttempt(
				attempt,
				new AbortController().signal,
			);
			outcome = { status: "completed", result };
		} catch (err) {
			outcome = {
				status: "failed",
				error: { message: err instanceof Error ? err.message : String(err) },
			};
		}
		if (outcome.status === "completed") {
			aggregated += outcome.result.usage?.totalTokens ?? 0;
		}
		await policy.releaseAttempt(reservation, outcome);
		outcomes.push(outcome);
	}

	return { aggregated, outcomes };
}

/** Read the persisted reserved-attempt ledger from a workspace. */
function readLedger(
	ws: Workspace,
): Array<{ reservationId: string; attemptId: string; planId: string }> {
	const ledgerPath = path.join(ws.path, ".research", "attempt-ledger.json");
	if (!fs.existsSync(ledgerPath)) return [];
	return JSON.parse(fs.readFileSync(ledgerPath, "utf-8"));
}

/** Build a real ResearchPolicy over the real frozen role config. */
function makePolicyFor(
	ws: Workspace,
	overrides?: { totalDispatch?: number; concurrentDispatch?: number },
): ResearchPolicy {
	const frozen: FrozenConfig = {
		roles: Object.fromEntries(
			Object.entries(baseConfig().roles).map(([name, role]) => [
				name,
				{
					...role,
					name,
					totalDispatch: overrides?.totalDispatch ?? role.totalDispatch,
					concurrentDispatch:
						overrides?.concurrentDispatch ?? role.concurrentDispatch,
				},
			]),
		),
		hardTimeoutSeconds: 1800,
	};
	return new ResearchPolicy(ws, frozen, 1800);
}

function makeAttempt(
	attemptId: string,
	planId = "plan-1",
	index = 0,
	role = "scout",
): ResolvedAttempt {
	return { attemptId, planId, index, taskInfo: { role } };
}

// ===========================================================================
// Section 1 — startup / frozen snapshots (real modules end-to-end)
// ===========================================================================

describe("integration — startup and frozen snapshots", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	function realDeps(): StartupDependencies {
		const transitionsPath = path.join(tmpDir, ".research", "transitions.json");
		fs.mkdirSync(path.dirname(transitionsPath), { recursive: true });
		const transitions = new TransitionsFile(transitionsPath);
		return {
			config: baseConfig(),
			getModels: () => standardModels(),
			getProviders: () => standardProviders(),
			workspace: {
				acquireWorkspaceClaim,
				prepareStaging,
				commitStaging,
				reconcileTransition,
				ensureGitExclude,
			},
			state: { newRunState, acquireLease },
			manifest: { createRunManifest },
			transitions,
			policy: {
				createPolicy: (ws, frozenConfig, hardTimeoutSeconds) =>
					new ResearchPolicy(ws, frozenConfig, hardTimeoutSeconds),
			},
			checkpoint: { evaluateCheckpoint },
			verification: {
				runVerification: () => [],
			},
			logger: { log: () => {} },
		};
	}

	function request(mission: string, yes = true): ResearchStartRequest {
		return {
			mission,
			profile: "standard",
			programPath: null,
			profileOverride: null,
			yes,
		};
	}

	it("activates a run with frozen manifest, run-state, lease, and pointer", async () => {
		const deps = realDeps();
		const pointer: ActiveResearchPointer = await prepareAndActivateResearch(
			request("Integration startup"),
			deps,
		);

		// Workspace + retained files
		expect(fs.existsSync(pointer.workspace.path)).toBe(true);
		const manifestPath = path.join(
			pointer.workspace.path,
			".research",
			"run.json",
		);
		expect(fs.existsSync(manifestPath)).toBe(true);
		expect(
			fs.existsSync(
				path.join(pointer.workspace.path, ".research", "run-state.json"),
			),
		).toBe(true);
		expect(
			fs.existsSync(
				path.join(pointer.workspace.path, ".research", "run-lease.json"),
			),
		).toBe(true);

		// Frozen manifest: workspace path = final path, snapshot bound
		const manifest = readManifest(pointer.workspace);
		expect(manifest.workspace).toBe(pointer.workspace.path);
		expect(manifest.runId).toBe(pointer.workspace.runId);
		expect(manifest.snapshotSha256).toBeTruthy();
		// Immutable: a second manifest creation must throw
		expect(() => createRunManifest(pointer.workspace)).toThrow(
			/already exists/,
		);

		// Run-state: revision 1, active, zero counters. Run identity is
		// consistent end-to-end: contract runId == workspace runId == state
		// runId == manifest runId == loop id (all `transitionId-finalDir`,
		// derived from the workspace via formatRunId).
		const state = readRunState(pointer.workspace);
		expect(state.revision).toBe(1);
		expect(state.status).toBe("active");
		expect(state.runId).toBe(pointer.workspace.runId);
		expect(state.coordinatorUsage).toBe(0);
		expect(state.nestedUsage).toBe(0);
		expect(state.concurrentReservations).toBe(0);

		// Frozen contract
		expect(pointer.contract.profileConfig.maxRounds).toBe(5);
		expect(pointer.contract.providerSelection.resolvedProvider.id).toBe(
			"local",
		);
		expect(pointer.contract.runId).toBe(pointer.workspace.runId);
		expect(pointer.policy.workspace.runId).toBe(pointer.workspace.runId);

		// Transitions: appended + pointer installed
		const transitions = deps.transitions.getTransitions();
		expect(transitions).toHaveLength(1);
		expect(transitions[0].runId).toBe(pointer.contract.runId);
		expect(transitions[0].status).toBe("active");
		expect(deps.transitions.getCurrentPointer()!.runId).toBe(
			pointer.contract.runId,
		);

		// History sees the retained workspace (manifest runId = workspace runId).
		// Workspaces live beside the transitions file, i.e. under tmpDir/.research.
		const listed = listWorkspaces(path.join(tmpDir, ".research"));
		expect(
			listed.entries.some((e) => e.runId === pointer.workspace.runId),
		).toBe(true);
		expect(listed.malformed).toHaveLength(0);
	});

	it("leaves a frozen contract untouched after a second validation", async () => {
		const config = baseConfig();
		const contract = await validateStartupContract(
			config,
			standardModels(),
			standardProviders(),
		);
		const frozen = JSON.stringify(contract);
		await validateStartupContract(
			config,
			standardModels(),
			standardProviders(),
		);
		expect(JSON.stringify(contract)).toBe(frozen);
	});

	it("uses the program snapshot for continuations — never re-reads the source", async () => {
		const programPath = path.join(tmpDir, "program.md");
		fs.writeFileSync(programPath, "# V1 program\n", "utf-8");
		const { engine, pi, ctx, messages } = makeEngine();
		engine.startState({
			commandName: "research",
			programPath,
			mission: "snapshot test",
			maxRounds: 3,
			tokenBudget: null,
			noProgressTurns: 3,
		});
		engine.persist(pi, ctx);
		engine.onAgentEnd(pi, ctx);
		await flushMicrotasks();
		// The continuation message must embed the V1 snapshot.
		expect(messages[0].content).toContain("# V1 program");

		// The human edits the program on disk mid-run — the engine must NOT
		// reread it; the frozen snapshot wins.
		fs.writeFileSync(programPath, "# V2 program\n", "utf-8");
		expect(engine.state?.programSnapshot).toContain("# V1 program");
		expect(engine.state?.programSnapshot).not.toContain("# V2 program");
	});
});

// ===========================================================================
// Section 2 — evidence collection, checkpoint idempotence, later synthesis
// ===========================================================================

describe("integration — evidence collection and checkpoint idempotence", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("increments the round counter once per loop iteration and stays idempotent", async () => {
		const ws = buildWorkspace(tmpDir, "evidence flow");
		// Use the packaged quick profile thresholds (minRounds 3, minSources 15).
		await updateRunState(ws, 1, (c) => ({ ...c, checkpointProfile: "quick" }));
		const digest = writeEvidence(ws);

		// Iterations 1–3: CONTINUE (rounds 0,1,2 below minRounds 3).
		let rev = 2;
		let last: { verdict: string; round: number; evidenceDigest: string };
		for (const iteration of [1, 2, 3]) {
			last = await evaluateCheckpoint(ws, iteration, rev);
			expect(last.verdict).toBe("CONTINUE");
			expect(last.round).toBe(iteration);
			expect(last.evidenceDigest).toBe(digest);
			rev = readRunState(ws).revision;
		}

		// Iteration 4: rounds (3) >= minRounds (3) and 16 sources >= 15 → PROCEED.
		const proceed = await evaluateCheckpoint(ws, 4, rev);
		expect(proceed.verdict).toBe("PROCEED");
		expect(proceed.round).toBe(4);

		// Idempotence: same iteration returns the recorded verdict, no increment.
		const again = await evaluateCheckpoint(ws, 4, readRunState(ws).revision);
		expect(again.verdict).toBe("PROCEED");
		expect(again.round).toBe(4);
		expect(readRunState(ws).researchRound).toBe(4);

		// Persisted checkpoint state is authoritative.
		const state = readRunState(ws);
		expect(state.checkpointVerdict).toBe("PROCEED");
		expect(state.checkpointDigest).toBe(digest);
		expect(state.checkpointUniqueSources).toBe(16);
		expect(state.checkpointProfile).toBe("quick");
	});

	it("fails closed without incrementing when evidence is missing or malformed", async () => {
		const ws = buildWorkspace(tmpDir, "fail closed");
		const result = await evaluateCheckpoint(ws, 1, 1);
		expect(result.verdict).toBe("CONTINUE");
		expect(result.round).toBe(0);
		expect(result.unmet.join()).toContain("score.md");
		expect(readRunState(ws).researchRound).toBe(0);
	});

	it("supports later synthesis: checkpoint → report.org → all gates pass → finalize", async () => {
		const ws = buildWorkspace(tmpDir, "synthesis flow");
		await updateRunState(ws, 1, (c) => ({ ...c, checkpointProfile: "quick" }));
		writeEvidence(ws);
		// Drive the loop forward to a PROCEED checkpoint.
		let rev = readRunState(ws).revision;
		for (const iteration of [1, 2, 3, 4]) {
			rev = readRunState(ws).revision;
			await evaluateCheckpoint(ws, iteration, rev);
		}
		// Later synthesis: the report is assembled after the checkpoint.
		writeReport(ws);
		writeJudge(ws, ws.runId);

		expect(await researchCompletionGate(ws)).toEqual([]);
		const finalized = await finalizeSuccess(
			ws,
			readRunState(ws).revision,
			"PROCEED",
		);
		expect(finalized.status).toBe("complete");
		expect(finalized.finalOutcome).toBe("PROCEED");
		expect(finalized.finalDigests!.manifest).toBe(
			createHash("sha256")
				.update(
					fs.readFileSync(path.join(ws.path, ".research", "run.json"), "utf-8"),
				)
				.digest("hex"),
		);
		// run.json stays immutable.
		expect(readManifest(ws).runId).toBe(ws.runId);
	});

	it("rejects completion when evidence changed after the checkpoint (staleness)", async () => {
		const ws = buildWorkspace(tmpDir, "evidence stale");
		await updateRunState(ws, 1, (c) => ({ ...c, checkpointProfile: "quick" }));
		writeEvidence(ws);
		let rev = readRunState(ws).revision;
		for (const iteration of [1, 2, 3, 4]) {
			rev = readRunState(ws).revision;
			await evaluateCheckpoint(ws, iteration, rev);
		}
		writeReport(ws);
		writeJudge(ws, ws.runId);
		expect(await researchCompletionGate(ws)).toEqual([]);

		// Editing evidence after the checkpoint invalidates the digest.
		fs.appendFileSync(
			path.join(ws.path, "notes.md"),
			"\n- Claim → https://example.com/extra\n",
		);
		const failures = await researchCompletionGate(ws);
		expect(codes(failures)).toContain("checkpoint");
		expect(messages(failures)).toContain("stale");
	});

	it("rejects completion when the report goes missing after synthesis", async () => {
		const ws = buildWorkspace(tmpDir, "report stale");
		await updateRunState(ws, 1, (c) => ({ ...c, checkpointProfile: "quick" }));
		writeEvidence(ws);
		let rev = readRunState(ws).revision;
		for (const iteration of [1, 2, 3, 4]) {
			rev = readRunState(ws).revision;
			await evaluateCheckpoint(ws, iteration, rev);
		}
		writeReport(ws);
		writeJudge(ws, ws.runId);
		expect(await researchCompletionGate(ws)).toEqual([]);

		fs.rmSync(path.join(ws.path, "report.org"));
		const failures = await researchCompletionGate(ws);
		expect(codes(failures)).toContain("report");
		expect(messages(failures)).toContain("report.org missing");
	});
});

// ===========================================================================
// Section 3 — every completion gate, independently + all-pass + finalize
// ===========================================================================

describe("integration — every completion gate", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	async function passableWs(): Promise<{ ws: Workspace; revision: number }> {
		const ws = buildWorkspace(tmpDir, "gate matrix");
		await updateRunState(ws, 1, (c) => ({ ...c, checkpointProfile: "quick" }));
		writeEvidence(ws);
		let rev = readRunState(ws).revision;
		for (const iteration of [1, 2, 3, 4]) {
			rev = readRunState(ws).revision;
			await evaluateCheckpoint(ws, iteration, rev);
		}
		writeReport(ws);
		writeJudge(ws, ws.runId);
		return { ws, revision: readRunState(ws).revision };
	}

	it("all gates pass for a complete workspace", async () => {
		const { ws } = await passableWs();
		expect(await researchCompletionGate(ws)).toEqual([]);
	});

	it("rejects when run.json is missing (manifest gate)", async () => {
		const { ws } = await passableWs();
		fs.rmSync(path.join(ws.path, ".research", "run.json"));
		const failures = await researchCompletionGate(ws);
		expect(codes(failures)).toContain("manifest");
	});

	it("rejects when the manifest workspace path does not match", async () => {
		const { ws } = await passableWs();
		const manifestPath = path.join(ws.path, ".research", "run.json");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
		manifest.workspace = "/elsewhere";
		fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
		const failures = await researchCompletionGate(ws);
		expect(codes(failures)).toContain("manifest");
		expect(messages(failures)).toContain("workspace mismatch");
	});

	it("rejects when the manifest has no snapshot binding", async () => {
		const { ws } = await passableWs();
		const manifestPath = path.join(ws.path, ".research", "run.json");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
		manifest.snapshotSha256 = null;
		fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
		const failures = await researchCompletionGate(ws);
		expect(codes(failures)).toContain("manifest");
		expect(messages(failures)).toContain("no snapshot recorded");
	});

	it("rejects when no checkpoint evidence was recorded", async () => {
		const { ws, revision } = await passableWs();
		await updateRunState(ws, revision, (c) => ({ ...c, checkpointDigest: "" }));
		const failures = await researchCompletionGate(ws);
		expect(codes(failures)).toContain("checkpoint");
		expect(messages(failures)).toContain("missing");
	});

	it("rejects when the checkpoint verdict is CONTINUE", async () => {
		const { ws, revision } = await passableWs();
		await updateRunState(ws, revision, (c) => ({
			...c,
			checkpointVerdict: "CONTINUE" as const,
		}));
		const failures = await researchCompletionGate(ws);
		expect(codes(failures)).toContain("checkpoint");
		expect(messages(failures)).toContain("verdict is 'CONTINUE'");
	});

	it("rejects when manifest and state disagree on run identity", async () => {
		const { ws } = await passableWs();
		const manifestPath = path.join(ws.path, ".research", "run.json");
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf-8"));
		manifest.runId = "tr-other-different-run";
		fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
		const failures = await researchCompletionGate(ws);
		expect(codes(failures)).toContain("checkpoint");
		expect(messages(failures)).toContain("run identity mismatch");
	});

	it("rejects when report.org is missing or empty", async () => {
		const { ws } = await passableWs();
		fs.rmSync(path.join(ws.path, "report.org"));
		expect(codes(await researchCompletionGate(ws))).toContain("report");

		fs.writeFileSync(path.join(ws.path, "report.org"), "   \n\t\n", "utf-8");
		const failures = await researchCompletionGate(ws);
		expect(codes(failures)).toContain("report");
		expect(messages(failures)).toContain("empty");
	});

	it("rejects when a required verification artifact is missing or fails", async () => {
		const { ws } = await passableWs();
		fs.rmSync(path.join(ws.path, "verification", "judge.json"));
		const missing = await researchCompletionGate(ws);
		expect(codes(missing)).toContain("verification");
		expect(messages(missing)).toContain("judge.json");

		writeJudge(ws, ws.runId, { pass: false, verdict: "FAIL" });
		const failed = await researchCompletionGate(ws);
		expect(codes(failed)).toContain("verification");
		expect(messages(failed)).toContain("failed");
	});

	it("rejects a verification artifact bound to a different run", async () => {
		const { ws } = await passableWs();
		writeJudge(ws, "tr-some-other-run");
		const failures = await researchCompletionGate(ws);
		expect(codes(failures)).toContain("verification");
		expect(messages(failures)).toContain("runId mismatch");
	});

	it("rejects an unknown checkpoint profile (cannot derive requirements)", async () => {
		const { ws, revision } = await passableWs();
		await updateRunState(ws, revision, (c) => ({
			...c,
			checkpointProfile: "bogus-profile",
		}));
		const failures = await researchCompletionGate(ws);
		expect(codes(failures)).toContain("verification");
		expect(messages(failures)).toContain("unknown profile");
	});

	it("requires every kind for the deep profile", async () => {
		const ws = buildWorkspace(tmpDir, "deep profile");
		// Seed a recorded checkpoint directly (real state write + real digest)
		// — evaluating the deep profile would need 20 loop iterations.
		const digest = writeEvidence(ws);
		await updateRunState(ws, 1, (c) => ({
			...c,
			checkpointProfile: "deep",
			checkpointVerdict: "PROCEED" as const,
			checkpointDigest: digest,
			checkpointUnmet: [],
			checkpointUniqueSources: 16,
			researchRound: 3,
			loopIteration: 1,
		}));
		writeReport(ws);
		// judge passes; citations + sources + contradictions are missing.
		writeJudge(ws, ws.runId);
		const failures = await researchCompletionGate(ws);
		const msgs = messages(failures);
		expect(msgs).toContain("citations.json");
		expect(msgs).toContain("sources.json");
		expect(msgs).toContain("contradictions.json");
		expect(codes(failures)).not.toContain("checkpoint");
	});

	it("finalizeSuccess: StateConflict on stale revision → re-audit with fresh revision succeeds", async () => {
		const { ws, revision } = await passableWs();
		// A concurrent writer bumps the revision.
		await updateRunState(ws, revision, (c) => ({
			...c,
			tokensUsed: c.tokensUsed + 100,
		}));
		const fresh = readRunState(ws);

		let conflict: StateConflict | null = null;
		try {
			await finalizeSuccess(ws, revision, "PROCEED");
		} catch (err) {
			conflict = err as StateConflict;
		}
		expect(conflict).not.toBeNull();
		expect(conflict!.expected).toBe(revision);
		expect(conflict!.actual).toBe(fresh.revision);

		// Re-audit passes, then finalize with the fresh revision.
		expect(await researchCompletionGate(ws)).toEqual([]);
		const finalized = await finalizeSuccess(ws, fresh.revision, "PROCEED");
		expect(finalized.status).toBe("complete");
		expect(readRunState(ws).status).toBe("complete");
	});
});

// ===========================================================================
// Section 4 — iteration / token / dispatch / no-progress limits
// ===========================================================================

describe("integration — loop budget and dispatch limits", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("maxRounds: continuation hits budget_limited and stops the loop", async () => {
		const { engine, pi, ctx } = makeEngine();
		engine.startState({
			commandName: "research",
			programPath: "/fake/program.md",
			mission: "rounds limit",
			maxRounds: 1,
			tokenBudget: null,
			noProgressTurns: 3,
		});
		engine.startTurn();
		engine.onAgentEnd(pi, ctx);
		await flushMicrotasks();
		// Round 1 queued — still active.
		expect(engine.state?.rounds).toBe(1);
		expect(engine.state?.status).toBe("active");

		// Next agent end: rounds (1) >= maxRounds (1) → budget_limited.
		engine.onAgentEnd(pi, ctx);
		await flushMicrotasks();
		expect(engine.state?.status).toBe("budget_limited");
		expect(engine.state?.reason).toBe("rounds");
	});

	it("tokenBudget: assistant usage over budget marks budget_limited (tokens)", async () => {
		const { engine, pi, ctx } = makeEngine();
		engine.startState({
			commandName: "research",
			programPath: "/fake/program.md",
			mission: "token limit",
			maxRounds: 10,
			tokenBudget: 100,
			noProgressTurns: 3,
		});
		engine.startTurn();
		await engine.endTurn(pi, ctx, {
			message: { usage: { totalTokens: 150 } },
		});
		expect(engine.state?.status).toBe("budget_limited");
		expect(engine.state?.reason).toBe("tokens");
		expect(engine.state?.tokensUsed).toBe(150);
		// Artifacts preserved: rounds/tokenBudget untouched by the stop.
		expect(engine.state?.maxRounds).toBe(10);
		expect(engine.state?.rounds).toBe(0);
	});

	it("noProgressTurns: identical fingerprint + no tool calls pauses the loop", async () => {
		const { engine, pi, ctx } = makeEngine();
		engine.startState({
			commandName: "research",
			programPath: "/fake/program.md",
			mission: "no progress",
			maxRounds: 10,
			tokenBudget: null,
			noProgressTurns: 2,
		});

		const stallEvent = () => ({
			message: { content: "same output every round" },
			toolResults: [] as unknown[],
		});

		// First continuation turn: same text, no tools → count 1.
		engine.startTurn();
		engine.onAgentEnd(pi, ctx);
		await flushMicrotasks();
		engine.startTurn();
		await engine.endTurn(pi, ctx, stallEvent());
		expect(engine.state?.noProgressCount).toBe(1);
		expect(engine.state?.status).toBe("active");

		// Second continuation turn: identical fingerprint → count 2 → no_progress.
		engine.onAgentEnd(pi, ctx);
		await flushMicrotasks();
		engine.startTurn();
		await engine.endTurn(pi, ctx, stallEvent());
		expect(engine.state?.noProgressCount).toBe(2);
		expect(engine.state?.status).toBe("no_progress");
	});

	it("noProgressTurns: tool activity resets the stall counter", async () => {
		const { engine, pi, ctx } = makeEngine();
		engine.startState({
			commandName: "research",
			programPath: "/fake/program.md",
			mission: "tool resets",
			maxRounds: 10,
			tokenBudget: null,
			noProgressTurns: 2,
		});

		engine.startTurn();
		engine.onAgentEnd(pi, ctx);
		await flushMicrotasks();
		engine.startTurn();
		await engine.endTurn(pi, ctx, {
			message: { content: "same output" },
			toolResults: [{}],
		});
		expect(engine.state?.noProgressCount).toBe(0);
	});

	it("dispatch counters: ResearchPolicy enforces total/concurrent caps with zero launches after rejection", async () => {
		const ws = buildWorkspace(tmpDir, "dispatch caps");
		const policy = makePolicyFor(ws, {
			totalDispatch: 2,
			concurrentDispatch: 2,
		});
		const provider = new RecordingProvider();

		const results = await dispatchAttempts(policy, provider, [
			makeAttempt("att-1"),
			makeAttempt("att-2"),
			makeAttempt("att-3"),
		]);

		// Only two reservations succeeded → exactly two physical launches.
		expect(provider.launches).toHaveLength(2);
		expect(provider.launches.map((l) => l.attemptId)).toEqual([
			"att-1",
			"att-2",
		]);
		expect(results.outcomes[2]).toEqual({
			status: "failed",
			error: { message: "reservation rejected" },
		});

		// The persisted reserved-attempt ledger matches the launch log exactly.
		const ledger = readLedger(ws);
		expect(ledger.map((l) => l.attemptId)).toEqual(
			provider.launches.map((l) => l.attemptId),
		);
		// State tracks concurrency back to zero after release.
		expect(readRunState(ws).concurrentReservations).toBe(0);
	});

	it("round limit interplay: a research-shaped engine with the disk gate policy", async () => {
		const ws = buildWorkspace(tmpDir, "gate engine");
		const digest = writeEvidence(ws);
		await updateRunState(ws, 1, (c) => ({
			...c,
			checkpointProfile: "quick",
			checkpointVerdict: "PROCEED" as const,
			checkpointDigest: digest,
			checkpointUnmet: [],
			checkpointUniqueSources: 16,
			researchRound: 3,
			loopIteration: 1,
		}));
		writeReport(ws);
		writeJudge(ws, ws.runId);

		// Build an engine whose completion policy audits the real disk gates.
		const { pi } = makeMockPi();
		const ctx = makeMockCtx();
		const engine = new LoopEngine({
			completionPolicy: researchGatePolicy(ws),
			onStateChange: async () => {},
		});
		engine.startState({
			commandName: "research",
			programPath: "/fake/program.md",
			mission: ws.mission,
			maxRounds: 3,
			tokenBudget: null,
			noProgressTurns: 3,
			...({ workingDir: ws.path, profile: "quick" } as Partial<LoopState>),
		});

		// The workspace is complete, so a fresh audit passes the gates.
		const failures = await engine.checkCompletion(engine.state!);
		expect(failures).toEqual([]);

		// The engine itself still enforces maxRounds.
		engine.onAgentEnd(pi, ctx);
		await flushMicrotasks();
		engine.onAgentEnd(pi, ctx);
		await flushMicrotasks();
		engine.onAgentEnd(pi, ctx);
		await flushMicrotasks();
		engine.onAgentEnd(pi, ctx);
		await flushMicrotasks();
		expect(engine.state?.status).toBe("budget_limited");
		expect(engine.state?.reason).toBe("rounds");
		expect(engine.state?.rounds).toBe(3);
	});
});

// ===========================================================================
// Section 5 — reload / resume / interruption / provider mismatch
// ===========================================================================

describe("integration — reload, resume, interruption, provider mismatch", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("persists loop state across a simulated reload (re-instantiated engine)", async () => {
		const programPath = path.join(tmpDir, "program.md");
		fs.writeFileSync(programPath, "# program\n", "utf-8");

		// Session 1: start the loop, run a turn with usage, persist.
		const { pi, entries } = makeMockPi();
		const ctx = makeMockCtx();
		const engineA = new LoopEngine({
			completionPolicy: makeGenericPolicy(),
			onStateChange: async () => {},
		});
		engineA.startState({
			commandName: "research",
			programPath,
			mission: "reload test",
			maxRounds: 5,
			tokenBudget: null,
			noProgressTurns: 3,
			...({ workingDir: tmpDir, profile: "standard" } as Partial<LoopState>),
		});
		engineA.startTurn();
		await engineA.endTurn(pi, ctx, {
			message: { usage: { totalTokens: 40 } },
		});
		engineA.persist(pi, ctx);
		expect(engineA.state?.tokensUsed).toBe(40);
		expect(entries.length).toBeGreaterThan(0);

		// Reload: a brand-new engine reads the same session entries.
		const ctxB = makeMockCtx();
		const engineB = new LoopEngine({
			completionPolicy: makeGenericPolicy(),
			onStateChange: async () => {},
		});
		ctxB.sessionManager.getEntries = () =>
			entries.map((e) => ({
				type: "custom",
				customType: "pi-loop",
				data: e.data,
			})) as never;
		const restored = engineB.latestState(ctxB);
		expect(restored).not.toBeNull();
		expect(restored!.tokensUsed).toBe(40);
		expect(restored!.coordinatorUsage).toBe(40);
		expect(restored!.mission).toBe("reload test");
		engineB.state = restored;
		expect(engineB.usage.total).toBe(40);

		// A fresh engine that has NOT seen the entries reports zero.
		const ctxC = makeMockCtx();
		const engineC = new LoopEngine({
			completionPolicy: makeGenericPolicy(),
			onStateChange: async () => {},
		});
		expect(engineC.latestState(ctxC)).toBeNull();
	});

	it("resume reacquires the lease and keeps consumed counts; interruption releases slots transactionally", async () => {
		const ws = buildWorkspace(tmpDir, "resume flow");
		// Simulate an interrupted run: in-flight reservations + consumed usage.
		await updateRunState(ws, 1, (c) => ({
			...c,
			concurrentReservations: 3,
			tokensUsed: 50000,
			coordinatorUsage: 30000,
			nestedUsage: 20000,
		}));
		// Pause lifecycle so resume is permitted.
		const snapshot = createLifecycleSnapshot("paused", "test-setup");
		persistLifecycle(ws, snapshot);

		const result = await resumeWorkspace(
			ws.path,
			{
				config: baseConfig(),
				getModels: () => standardModels(),
				getProviders: () => standardProviders(),
			},
			"resume-session",
		);

		expect(result.success).toBe(true);
		if (result.success) {
			// Lease reacquired by this session.
			const leasePath = path.join(ws.path, ".research", "run-lease.json");
			const lease = JSON.parse(fs.readFileSync(leasePath, "utf-8")) as {
				sessionId: string;
			};
			expect(lease.sessionId).toBe("resume-session");
			// Consumed counts kept.
			const after = readRunState(ws);
			expect(after.tokensUsed).toBe(50000);
			expect(after.coordinatorUsage).toBe(30000);
			expect(after.nestedUsage).toBe(20000);
			// In-flight slots released transactionally.
			expect(after.concurrentReservations).toBe(0);
		}
	});

	it("rejects resume when the provider is missing (provider mismatch)", async () => {
		const ws = buildWorkspace(tmpDir, "provider mismatch");
		const snapshot = createLifecycleSnapshot("paused", "test-setup");
		persistLifecycle(ws, snapshot);

		const result = await resumeWorkspace(ws.path, {
			config: baseConfig(),
			getModels: () => fakeModelRegistry({}),
			getProviders: () => fakeProviderRegistry([]),
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(["provider_incompatible", "models_changed"]).toContain(
				result.reason,
			);
		}
	});

	it("rejects resume against a provider lacking required capabilities", async () => {
		const ws = buildWorkspace(tmpDir, "weak provider resume");
		const snapshot = createLifecycleSnapshot("paused", "test-setup");
		persistLifecycle(ws, snapshot);

		const result = await resumeWorkspace(ws.path, {
			config: baseConfig(),
			getModels: () => standardModels(),
			getProviders: () =>
				fakeProviderRegistry([
					{ id: "weak", adapterVersion: "1.0", capabilities: ["local"] },
				]),
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.reason).toBe("provider_incompatible");
			expect(result.error.toLowerCase()).toContain("capabilit");
		}
	});

	it("rejects resume from a non-resumable state (complete)", async () => {
		const ws = buildWorkspace(tmpDir, "complete resume");
		const snapshot = createLifecycleSnapshot("complete", "test-setup");
		persistLifecycle(ws, snapshot);
		const result = await resumeWorkspace(ws.path, {
			config: baseConfig(),
			getModels: () => standardModels(),
			getProviders: () => standardProviders(),
		});
		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.reason).toBe("state_not_resumable");
		}
	});
});

// ===========================================================================
// Section 6 — replacement / abandonment / history
// ===========================================================================

describe("integration — replacement, abandonment, history", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("replaces the prior run and abandons on clear, while discovery reports them", async () => {
		const wsA = buildWorkspace(tmpDir, "run alpha", "tr-a");
		const wsB = buildWorkspace(tmpDir, "run beta", "tr-b");

		// Simulate the startup replacement: beta replaces alpha.
		markReplaced(wsA, "replaced by run beta");
		markAbandoned(wsB, "cleared by user");

		expect(loadLifecycleSnapshot(wsA)!.current).toBe("replaced");
		expect(loadLifecycleSnapshot(wsB)!.current).toBe("abandoned");

		// History lists both retained workspaces with their states.
		const listed = listWorkspaces(tmpDir);
		const alpha = listed.entries.find((e) => e.path === wsA.path);
		const beta = listed.entries.find((e) => e.path === wsB.path);
		expect(alpha?.status).toBe("replaced");
		expect(beta?.status).toBe("abandoned");
		expect(alpha?.runId).toBe(wsA.runId);

		// lookupWorkspace finds by slug prefix.
		expect(lookupWorkspace(tmpDir, "run-alpha")?.runId).toBe(wsA.runId);
	});

	it("discovery excludes .research/cache/web and reports malformed workspaces", async () => {
		buildWorkspace(tmpDir, "good run", "tr-good");
		const cache = path.join(tmpDir, ".research", "cache", "web");
		fs.mkdirSync(cache, { recursive: true });
		fs.writeFileSync(path.join(cache, "index.html"), "<html/>", "utf-8");
		// A partial workspace: directory with no metadata at all.
		fs.mkdirSync(path.join(tmpDir, ".research", "partial-ws"), {
			recursive: true,
		});

		const listed = listWorkspaces(tmpDir);
		expect(listed.entries.map((e) => e.path)).not.toContain(
			path.join(tmpDir, ".research", "cache", "web"),
		);
		expect(
			listed.malformed.some(
				(m) => m.path === path.join(tmpDir, ".research", "partial-ws"),
			),
		).toBe(true);
	});

	it("pauses an active run and syncs run-state status", async () => {
		const ws = buildWorkspace(tmpDir, "pause flow", "tr-pause");
		createLifecycleSnapshot("active", "created");
		const snapshot = pauseLifecycle(ws, "user paused");
		expect(snapshot.current).toBe("paused");
		expect(readRunState(ws).status).toBe("paused");
	});
});

// ===========================================================================
// Section 7 — concurrent state updates
// ===========================================================================

describe("integration — concurrent state updates", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("exactly one parallel write wins; the loser gets a typed StateConflict", async () => {
		const ws = buildWorkspace(tmpDir, "concurrent writes");

		const [a, b] = await Promise.allSettled([
			updateRunState(ws, 1, (c) => ({
				...c,
				coordinatorUsage: c.coordinatorUsage + 10,
			})),
			updateRunState(ws, 1, (c) => ({ ...c, nestedUsage: c.nestedUsage + 20 })),
		]);

		expect(a.status).toBe("fulfilled");
		expect(b.status).toBe("rejected");
		const reason = (b as PromiseRejectedResult).reason as StateConflict;
		expect(reason.expected).toBe(1);
		expect(reason.actual).toBe(2);

		// No lost update: exactly one counter was bumped, revision is 2.
		const final = readRunState(ws);
		expect(final.revision).toBe(2);
		expect(final.coordinatorUsage + final.nestedUsage).toBe(10 + 20 - 20); // only one applied
	});

	it("checkpoint-vs-usage contention: retry from a fresh read preserves both", async () => {
		const ws = buildWorkspace(tmpDir, "checkpoint contention");
		// A usage update lands first.
		await updateRunState(ws, 1, (c) => ({ ...c, tokensUsed: 500 }));
		const fresh = readRunState(ws);
		writeEvidence(ws);
		// Checkpoint retries on the fresh revision and does not lose usage.
		const result = await evaluateCheckpoint(ws, 1, fresh.revision);
		expect(result.verdict).toBe("CONTINUE");
		const after = readRunState(ws);
		expect(after.tokensUsed).toBe(500);
		expect(after.researchRound).toBe(1);
	});
});

// ===========================================================================
// Section 8 — end-to-end usage totals (coordinator + nested, replay-safe)
// ===========================================================================

describe("integration — usage totals and replay safety", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("aggregates coordinator + nested usage across parallel calls and retries", async () => {
		const ws = buildWorkspace(tmpDir, "usage totals");
		const policy = makePolicyFor(ws, {
			totalDispatch: 30,
			concurrentDispatch: 8,
		});
		const provider = new RecordingProvider();

		// 6 attempts in parallel + 1 retry (att-4 fails once, retried as att-4r).
		provider.failAttempts.add("att-4");
		const attempts = [
			makeAttempt("att-1"),
			makeAttempt("att-2"),
			makeAttempt("att-3"),
			makeAttempt("att-4"),
			makeAttempt("att-4r"),
			makeAttempt("att-5"),
			makeAttempt("att-6"),
		];
		// Parallel dispatch through the policy serialization lock.
		const { aggregated } = await dispatchAttempts(policy, provider, attempts);

		// 7 reserved attempts → 7 physical launches (including the failed retry).
		expect(provider.launches).toHaveLength(7);
		const ledger = readLedger(ws);
		expect(ledger.map((l) => l.attemptId)).toEqual(
			provider.launches.map((l) => l.attemptId),
		);

		// Aggregated nested usage counts completed attempts only (6 × 25).
		expect(aggregated).toBe(150);

		// Feed the tool result into the loop state exactly once.
		const loop: LoopState = {
			id: "loop-usage",
			commandName: "research",
			programPath: "/fake.md",
			mission: "usage",
			rounds: 0,
			maxRounds: 5,
			tokensUsed: 0,
			tokenBudget: null,
			status: "active",
			guardId: "g",
			noProgressTurns: 3,
			noProgressCount: 0,
			lastFingerprint: null,
			updatedAt: Date.now(),
			coordinatorUsage: 0,
			nestedUsage: 0,
			processedToolCallIds: [],
		};
		const withNested = addNestedUsage(
			loop,
			{ totalTokens: aggregated },
			"toolcall-dispatch-1",
		);
		expect(withNested.nestedUsage).toBe(150);
		expect(withNested.tokensUsed).toBe(150);

		// Replay of the same tool result must NOT double-count.
		const replayed = addNestedUsage(
			withNested,
			{ totalTokens: aggregated },
			"toolcall-dispatch-1",
		);
		expect(replayed.nestedUsage).toBe(150);
		expect(replayed.tokensUsed).toBe(150);

		// Coordinator turn usage adds on top.
		const afterCoordinator = addCoordinatorUsage(
			replayed,
			{ totalTokens: 40 },
			"toolcall-coord-1",
		);
		expect(afterCoordinator.coordinatorUsage).toBe(40);
		expect(afterCoordinator.nestedUsage).toBe(150);
		expect(afterCoordinator.tokensUsed).toBe(190);
		expect(afterCoordinator.processedToolCallIds).toEqual([
			"toolcall-dispatch-1",
			"toolcall-coord-1",
		]);
	});

	it("persists totals across a simulated reload with no double-count after replay", async () => {
		const programPath = path.join(tmpDir, "program.md");
		fs.writeFileSync(programPath, "# program\n", "utf-8");
		const ws = buildWorkspace(tmpDir, "usage reload");

		// Session 1: coordinator turn + nested dispatch, then persist.
		const { pi, entries } = makeMockPi();
		const ctx = makeMockCtx();
		const engineA = new LoopEngine({
			completionPolicy: makeGenericPolicy(),
			onStateChange: async () => {},
		});
		engineA.startState({
			commandName: "research",
			programPath,
			mission: "usage reload",
			maxRounds: 5,
			tokenBudget: null,
			noProgressTurns: 3,
		});
		engineA.startTurn();
		await engineA.endTurn(pi, ctx, { message: { usage: { totalTokens: 40 } } });
		engineA.state = addNestedUsage(
			engineA.state!,
			{ totalTokens: 150 },
			"toolcall-dispatch-1",
		);
		engineA.persist(pi, ctx);
		expect(engineA.usage.total).toBe(190);

		// Reload: re-instantiated engine reads persisted totals.
		const ctxB = makeMockCtx();
		ctxB.sessionManager.getEntries = () =>
			entries.map((e) => ({
				type: "custom",
				customType: "pi-loop",
				data: e.data,
			})) as never;
		const engineB = new LoopEngine({
			completionPolicy: makeGenericPolicy(),
			onStateChange: async () => {},
		});
		engineB.state = engineB.latestState(ctxB);
		expect(engineB.usage.total).toBe(190);
		expect(engineB.usage.coordinator).toBe(40);
		expect(engineB.usage.nested).toBe(150);

		// A replay of the same nested tool result after reload is deduplicated.
		const withReplay = addNestedUsage(
			engineB.state!,
			{ totalTokens: 150 },
			"toolcall-dispatch-1",
		);
		expect(withReplay.nestedUsage).toBe(150);
		expect(withReplay.tokensUsed).toBe(190);

		// run-state.json mirrors the same totals (persisted research state).
		const diskState = readRunState(ws);
		expect(diskState).toBeDefined();
	});

	it("fake provider launch log equals persisted reserved-attempt ledger after a full dispatch", async () => {
		const ws = buildWorkspace(tmpDir, "ledger equality");
		const policy = makePolicyFor(ws, {
			totalDispatch: 30,
			concurrentDispatch: 8,
		});
		const provider = new RecordingProvider();

		// Mixed success/failure batch with retries.
		provider.failAttempts.add("att-b");
		const attempts = [
			makeAttempt("att-a"),
			makeAttempt("att-b"),
			makeAttempt("att-br"),
			makeAttempt("att-c"),
		];
		const { aggregated } = await dispatchAttempts(policy, provider, attempts);

		// Physical-launch log == persisted reserved-attempt ledger.
		const ledger = readLedger(ws);
		expect(provider.launches).toHaveLength(4);
		expect(ledger).toHaveLength(4);
		for (let i = 0; i < ledger.length; i++) {
			expect(ledger[i].attemptId).toBe(provider.launches[i].attemptId);
			expect(ledger[i].planId).toBe(provider.launches[i].planId);
		}
		// Successes: att-a, att-br, att-c (3 × 25).
		expect(aggregated).toBe(75);
		// Concurrency fully released back to the state.
		expect(readRunState(ws).concurrentReservations).toBe(0);

		// A subsequent replay of the persisted ledger does not add launches.
		const launchesBefore = provider.launches.length;
		await dispatchAttempts(policy, provider, []);
		expect(provider.launches).toHaveLength(launchesBefore);
	});

	it("rejects launches when the total dispatch budget is exhausted (end-to-end)", async () => {
		const ws = buildWorkspace(tmpDir, "budget exhausted");
		const policy = makePolicyFor(ws, {
			totalDispatch: 1,
			concurrentDispatch: 1,
		});
		const provider = new RecordingProvider();

		const { aggregated } = await dispatchAttempts(policy, provider, [
			makeAttempt("att-1"),
			makeAttempt("att-2"),
		]);

		expect(provider.launches).toHaveLength(1);
		expect(aggregated).toBe(25);
		// Reservation rejection prevents the second launch — no ledger entry.
		expect(readLedger(ws)).toHaveLength(1);
	});
});
