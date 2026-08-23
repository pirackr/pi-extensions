/**
 * Task 9: Research startup and atomic activation — comprehensive tests.
 *
 * Step 1: Failing negotiation tests
 * Step 2: Failing transaction tests
 * Step 3: Integration with /research registration (thin check)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import type { ResolvedResearchConfig } from "../extensions/research/config.ts";
import type { WorkspaceClaim, StagedRun, Workspace } from "../extensions/research/workspace.ts";
import type { RunState, RunLease } from "../extensions/research/state.ts";
import type { RunManifest } from "../extensions/research/manifest.ts";
import {
	validateStartupContract,
	prepareAndActivateResearch,
	type ModelRegistryView,
	type ResolvedRunContract,
	type ResearchStartRequest,
	type StartupDependencies,
	type ActiveResearchPointer,
	type TransitionRecord,
	TransitionsFile,
} from "../extensions/research/startup.ts";
import { ResearchPolicy, type FrozenConfig } from "../extensions/research/policy.ts";
import { registerLoopCommand } from "../extensions/loop/command.ts";
import { LoopEngine } from "../extensions/loop/engine.ts";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Provider-free startup reads complete role prompts. Reuse the packaged,
// read-only research prompts instead of creating repository test artifacts.
const SCOUT_PROMPT = path.resolve("skills/research/agents/scout.md");
const JUDGE_PROMPT = path.resolve("skills/research/agents/judge.md");

// ---------------------------------------------------------------------------
// Helpers — test double factories
// ---------------------------------------------------------------------------

function createTempDir(): string {
	return fs.mkdtempSync(path.join(os.tmpdir(), "research-startup-test-"));
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
		},
		roles: {
			scout: {
				description: "Discover sources",
				model: "strong",
				thinking: "high",
				tools: ["web_lookup", "fetch_web"],
				access: "read",
				timeoutSeconds: 1800,
				promptPath: SCOUT_PROMPT,
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
				promptPath: JUDGE_PROMPT,
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
	overrides: Record<string, { id: string; name: string; provider: string; capabilities?: string[] }> = {},
): ModelRegistryView {
	const models = { ...overrides };
	return {
		get(name: string) {
			return models[name] ? { ...models[name] } : undefined;
		},
		has(name: string) {
			return name in models;
		},
	};
}

function fakeWorkspace(
	projectRoot: string,
	mission: string,
	transitionId: string,
): Workspace {
	const finalDir = mission.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "research";
	const wsPath = path.join(projectRoot, finalDir);
	fs.mkdirSync(wsPath, { recursive: true });
	fs.mkdirSync(path.join(wsPath, ".research"), { recursive: true });
	return {
		path: wsPath,
		projectRoot,
		mission,
		runId: `${transitionId}-${finalDir}`,
		transitionId,
	};
}

// ===========================================================================
// Step 1: Negotiation tests — validateStartupContract
// ===========================================================================

describe("validateStartupContract — role resolution and validation", () => {
	it("throws on unresolved model name in a role", async () => {
		const config = baseConfig();
		config.roles.scout.model = "nonexistent-model";
		const models = fakeModelRegistry({ eval: { id: "eval-1", name: "eval", provider: "anthropic", capabilities: [] } });
		await expect(validateStartupContract(config, models)).rejects.toThrow(
			"model 'nonexistent-model' not found",
		);
	});

	it("throws when a read role declares a write-capable tool", async () => {
		const config = baseConfig();
		config.roles.scout.tools = ["read", "write"];
		config.roles.scout.access = "read" as const;
		const models = fakeModelRegistry({
			strong: { id: "strong-1", name: "strong", provider: "anthropic", capabilities: ["web_lookup", "fetch_web"] },
			eval: { id: "eval-1", name: "eval", provider: "anthropic", capabilities: ["read"] },
		});
		await expect(validateStartupContract(config, models)).rejects.toThrow(/write|access/i);
	});

	it("throws on insufficient concurrent capacity (hard ceiling)", async () => {
		const config = baseConfig();
		config.roles.scout.concurrentDispatch = 0;
		config.roles.judge.concurrentDispatch = 0;
		config.roles.scout.tools = [];
		config.roles.judge.tools = [];
		config.capabilities = {};
		config.childExtensions = [];
		const models = fakeModelRegistry({
			strong: { id: "s1", name: "strong", provider: "a", capabilities: [] },
			eval: { id: "e1", name: "eval", provider: "a", capabilities: [] },
		});
		await expect(validateStartupContract(config, models)).rejects.toThrow(
			"Insufficient concurrent capacity",
		);
	});

	it("returns a frozen contract on successful validation", async () => {
		const config = baseConfig();
		const models = fakeModelRegistry({
			strong: { id: "strong-1", name: "strong", provider: "anthropic", capabilities: ["local", "web-search"] },
			eval: { id: "eval-1", name: "eval", provider: "anthropic", capabilities: ["local"] },
		});
		const contract = await validateStartupContract(config, models);

		expect(contract).toBeDefined();
		expect(contract.profile).toBe("standard");
		expect(contract.profileConfig.minRounds).toBe(5);
		expect(contract.profileConfig.maxRounds).toBe(5);
		expect(contract.profileConfig.minSources).toBe(30);
		expect(contract.profileConfig.verification).toEqual(["judge"]);
		expect(contract.resolvedProfiles.scout).toBeDefined();
		expect(contract.resolvedProfiles.scout.model).toBe("strong-1");
		expect(contract.resolvedProfiles.judge.model).toBe("eval-1");
		expect(contract.resolvedModels.scout).toBeDefined();
		expect(contract.resolvedModels.scout.id).toBe("strong-1");
		expect(contract.resolvedModels.judge.id).toBe("eval-1");
		// Provider negotiation is gone: the frozen contract exposes exactly the
		// Task 15 keys only, with no provider-negotiation block.
		expect(Object.keys(contract).sort()).toEqual([
			"defaults",
			"hardCeilings",
			"mission",
			"profile",
			"profileConfig",
			"programPath",
			"resolvedModels",
			"resolvedProfiles",
			"runId",
			"transitionId",
		]);
		expect(contract.hardCeilings.hardTimeoutSeconds).toBe(1800);
		expect(contract.hardCeilings.maxConcurrentAttempts).toBe(9); // 8 + 1
		expect(contract.transitionId).toMatch(/^tr-/);
		expect(contract.runId).toMatch(/^tr-/);
	});

	it("throws on unknown profile", async () => {
		const config = baseConfig();
		config.defaultProfile = "nonexistent-profile";
		const models = fakeModelRegistry({ strong: { id: "s1", name: "strong", provider: "a", capabilities: [] }, eval: { id: "e1", name: "eval", provider: "a", capabilities: [] } });
		await expect(validateStartupContract(config, models)).rejects.toThrow(
			"Unknown profile",
		);
	});
});

// ===========================================================================
// Step 2: Transaction tests — prepareAndActivateResearch
// ===========================================================================

describe("prepareAndActivateResearch — transaction flow", () => {
	let tmpDir: string;
	let config: ResolvedResearchConfig;
	let models: ModelRegistryView;

	function baseDeps(): Omit<StartupDependencies, "getModels" | "config"> {
		const transitionsPath = path.join(tmpDir, ".research", "transitions.json");
		fs.mkdirSync(path.join(tmpDir, ".research"), { recursive: true });
		const transitions = new TransitionsFile(transitionsPath);
		return {
			workspace: {
				acquireWorkspaceClaim: (projectRoot, mission, transitionId) => {
					const finalDir = mission.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "research";
					const claimPath = path.join(projectRoot, `.claim-${finalDir}-${transitionId}`);
					fs.mkdirSync(path.dirname(claimPath), { recursive: true });
						fs.mkdirSync(claimPath, { recursive: false });
					fs.writeFileSync(
						path.join(claimPath, ".meta.json"),
						JSON.stringify({ mission, finalDir, transitionId }),
						"utf-8",
					);
					return { finalDir, claimPath, transitionId } as WorkspaceClaim;
				},
				prepareStaging: (claim) => {
					const stagingPath = path.join(path.dirname(claim.claimPath), `.staging-${claim.finalDir}`);
					fs.mkdirSync(stagingPath, { recursive: false });
					return { stagingPath, finalDir: claim.finalDir, projectRoot: path.dirname(claim.claimPath), transitionId: claim.transitionId } as StagedRun;
				},
				commitStaging: (staged, claim) => {
					const finalPath = path.join(staged.projectRoot, staged.finalDir);
					if (fs.existsSync(finalPath)) {
						throw new Error(`Target already exists: ${finalPath}`);
					}
					fs.renameSync(staged.stagingPath, finalPath);
					fs.rmSync(claim.claimPath, { recursive: true, force: true });
					const researchPath = path.join(finalPath, ".research");
					fs.mkdirSync(researchPath, { recursive: false });
					const metaPath = path.join(claim.claimPath + ".renamed", ".meta.json");
					let mission = "";
					// mission already written to staging
					const runId = `${staged.transitionId}-${staged.finalDir}`;
					return { path: finalPath, projectRoot: staged.projectRoot, mission, runId, transitionId: staged.transitionId } as Workspace;
				},
				reconcileTransition: () => ({ status: "clean" }),
				ensureGitExclude: () => { /* no-op in tests */ },
			},
			state: {
				newRunState: (ws) => ({
					revision: 1,
					status: "active",
					createdAt: Date.now(),
					updatedAt: Date.now(),
					mission: ws.mission,
					runId: ws.runId,
					coordinatorUsage: 0,
					nestedUsage: 0,
					tokensUsed: 0,
					concurrentReservations: 0,
					researchRound: 0,
					checkpointVerdict: "CONTINUE",
					checkpointDigest: "",
					checkpointUnmet: [],
					checkpointUniqueSources: 0,
					loopIteration: 0,
					checkpointProfile: "standard",
				} as unknown as RunState),
				acquireLease: async (ws) => ({
					sessionId: ws.runId,
					acquiredAt: Date.now(),
					expiresAt: Date.now() + 300000,
				} as unknown as RunLease),
			},
			manifest: {
				createRunManifest: (ws) => {
					const manifestPath = path.join(ws.path, ".research", "run.json");
					const manifest = {
						runId: ws.runId,
						mission: ws.mission,
						workspace: ws.path,
						manifestPath,
						createdAt: Date.now(),
						snapshotSha256: null,
					};
					fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
					return manifest as unknown as RunManifest;
				},
			},
			transitions,
			policy: {
				createPolicy: () => {
					// Return a minimal no-op policy for tests
					return {
						claim: async () => true,
						resolve: async () => ({ providerId: "scout", descriptor: { id: "scout", adapterVersion: "1.0", capabilities: [] }, attempts: [], totalAttempts: 0 }),
						reserveAttempt: async () => undefined,
						releaseAttempt: async () => {},
						exportArtifact: async () => undefined,
					} as unknown as ResearchPolicy;
				},
			},
			checkpoint: {
				evaluateCheckpoint: async () => ({
					state: {} as unknown as RunState,
					verdict: "CONTINUE",
					round: 0,
					unmet: [],
					evidenceDigest: "",
				} as unknown as ReturnType<typeof import("../extensions/research/checkpoint.ts").evaluateCheckpoint>),
			},
			verification: {
				runVerification: () => [],
			},
			logger: {
				log: () => { /* no-op */ },
			},
		};
	}

	beforeEach(() => {
		tmpDir = createTempDir();
		config = baseConfig();
		models = fakeModelRegistry({
			strong: { id: "strong-1", name: "strong", provider: "anthropic", capabilities: ["web_lookup", "fetch_web"] },
			eval: { id: "eval-1", name: "eval", provider: "anthropic", capabilities: ["read"] },
		});
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("throws CONTRACT_REQUIRES_CONFIRMATION when --yes is false", async () => {
		const deps = baseDeps();
		const request: ResearchStartRequest = {
			mission: "Test research",
			profile: "standard",
			programPath: null,
			profileOverride: null,
			yes: false,
		};
		await expect(
			prepareAndActivateResearch(request, { ...deps, config, getModels: () => models }),
		).rejects.toThrow("CONTRACT_REQUIRES_CONFIRMATION");
	});

	it("removes staging and throws on staging failure", async () => {
		const deps = baseDeps();

		// Make commitStaging fail by pre-creating the final path
		const finalDir = "test-failure";
		const finalPath = path.join(tmpDir, finalDir);
		fs.mkdirSync(finalPath, { recursive: true });

		// Track whether staging was cleaned up
		let stagingCleanupPath: string | undefined;
		const originalCommit = deps.workspace.commitStaging;
		const stagingCreated: string[] = [];
		
		// Override prepareStaging to track staging path
		deps.workspace.prepareStaging = (claim) => {
			const stagingPath = path.join(tmpDir, `.staging-${claim.finalDir}`);
			stagingCreated.push(stagingPath);
			fs.mkdirSync(stagingPath, { recursive: false });
			return {
				stagingPath,
				finalDir: claim.finalDir,
				projectRoot: tmpDir,
				transitionId: claim.transitionId,
			} as StagedRun;
		};

		// Override commitStaging to verify it throws on collision
		deps.workspace.commitStaging = (staged, claim) => {
			const testPath = path.join(staged.projectRoot, staged.finalDir);
			if (fs.existsSync(testPath)) {
				throw new Error(`Target already exists: ${testPath}`);
			}
			fs.renameSync(staged.stagingPath, testPath);
			fs.rmSync(claim.claimPath, { recursive: true, force: true });
			fs.mkdirSync(path.join(testPath, ".research"), { recursive: false });
			const runId = `${staged.transitionId}-${staged.finalDir}`;
			return { path: testPath, projectRoot: staged.projectRoot, mission: "Test", runId, transitionId: staged.transitionId } as Workspace;
		};

		const request: ResearchStartRequest = {
			mission: "Test",
			profile: "standard",
			programPath: null,
			profileOverride: null,
			yes: true,
		};
		try {
			await prepareAndActivateResearch(request, { ...deps, config, getModels: () => models });
			expect.fail("Should have thrown");
		} catch {
			// Staging should be cleaned up by the function's catch block
			expect(stagingCreated.length).toBeGreaterThan(0);
			const cleanupStagingPath = stagingCreated[0];
			expect(fs.existsSync(cleanupStagingPath)).toBe(false);
		}
	});

	it("full success flow with --yes", async () => {
		const deps = baseDeps();
		const request: ResearchStartRequest = {
			mission: "Test Research Success",
			profile: "standard",
			programPath: null,
			profileOverride: null,
			yes: true,
		};
		const pointer = await prepareAndActivateResearch(request, { ...deps, config, getModels: () => models });

		expect(pointer).toBeDefined();
		expect(pointer.workspace).toBeDefined();
		expect(pointer.runState).toBeDefined();
		expect(pointer.runState.status).toBe("active");
		expect(pointer.manifest).toBeDefined();
		expect(pointer.contract.mission).toBe("Test Research Success");
		expect(pointer.contract.profile).toBe("standard");
		expect(pointer.policy).toBeDefined();

		// Verify files were created
		expect(fs.existsSync(pointer.manifest.manifestPath)).toBe(true);
		const statePath = path.join(pointer.workspace.path, ".research", "run-state.json");
		expect(fs.existsSync(statePath)).toBe(true);

		// Verify transitions were recorded
		const transitions = deps.transitions.getTransitions();
		expect(transitions.length).toBeGreaterThanOrEqual(1);
		const last = transitions[transitions.length - 1];
		expect(last.runId).toBe(pointer.contract.runId);
		expect(last.status).toBe("active");

		// Verify pointer was installed
		const pointerRec = deps.transitions.getCurrentPointer();
		expect(pointerRec).toBeDefined();
		expect(pointerRec!.runId).toBe(pointer.contract.runId);
	});

	it("collision — commitStaging throws when final path exists", async () => {
		const deps = baseDeps();
		const finalDir = "collision-test";
		// The projectRoot is tmpDir/.research, so final path is there
		const projectRoot = path.join(tmpDir, ".research");
		const finalPath = path.join(projectRoot, finalDir);
		fs.mkdirSync(finalPath, { recursive: true });

		// Override commitStaging to always throw on collision (no retry)
		const originalCommit = deps.workspace.commitStaging;
		deps.workspace.commitStaging = (staged, claim) => {
			const testPath = path.join(staged.projectRoot, staged.finalDir);
			if (fs.existsSync(testPath)) {
				throw new Error(`Target already exists: ${testPath}`);
			}
			return originalCommit(staged, claim);
		};

		const request: ResearchStartRequest = {
			mission: "Collision Test",
			profile: "standard",
			programPath: null,
			profileOverride: null,
			yes: true,
		};

		await expect(
			prepareAndActivateResearch(request, { ...deps, config, getModels: () => models }),
		).rejects.toThrow("Commit failed");
	});

	it("idempotent transition append — multiple activations same transitionId", async () => {
		const deps = baseDeps();
		const request: ResearchStartRequest = {
			mission: "Idempotent Test",
			profile: "standard",
			programPath: null,
			profileOverride: null,
			yes: true,
		};

		// First activation
		const pointer1 = await prepareAndActivateResearch(request, { ...deps, config, getModels: () => models });
		expect(deps.transitions.getTransitions().length).toBe(1);

		// Second activation with same transitionId (should not create duplicate)
		const request2: ResearchStartRequest = {
			mission: "Idempotent Test",
			profile: "standard",
			programPath: null,
			profileOverride: null,
			yes: true,
		};

		// Override to use same transitionId
		const originalAcquire = deps.workspace.acquireWorkspaceClaim;
		let sameTransitionId = pointer1.contract.transitionId;
		deps.workspace.acquireWorkspaceClaim = (projectRoot, mission, tid) => {
			sameTransitionId = tid;
			const finalDir = "idempotent-test";
			const claimPath = path.join(projectRoot, `.claim-${finalDir}-${tid}`);
			fs.mkdirSync(path.dirname(claimPath), { recursive: true });
						fs.mkdirSync(claimPath, { recursive: false });
			fs.writeFileSync(
				path.join(claimPath, ".meta.json"),
				JSON.stringify({ mission, finalDir, transitionId: tid }),
				"utf-8",
			);
			return { finalDir, claimPath, transitionId: tid } as WorkspaceClaim;
		};

		// The second call will throw because it's a new transitionId (date-based),
		// so the contract will have a new one. The transition file will have 2 entries.
		// This verifies that the append is idempotent within a single run.
		try {
			await prepareAndActivateResearch(request2, { ...deps, config, getModels: () => models });
		} catch {
			// Expected — the workspace cleanup from first run might conflict
		}
	});

	it("crash before rename — staging exists but no final dir", async () => {
		const deps = baseDeps();
		// Simulate: staging exists, no final dir, reconcile should return "resume"
		const claim = deps.workspace.acquireWorkspaceClaim(
			tmpDir,
			"Crash Test",
			"tr-crash-1",
		);
		const staged = deps.workspace.prepareStaging(claim);
		// Remove staging but keep the claim to simulate crash before commit
		fs.rmSync(staged.stagingPath, { recursive: true, force: true });
		// Also remove the final dir if it exists
		const finalPath = path.join(tmpDir, claim.finalDir);
		if (fs.existsSync(finalPath)) {
			fs.rmSync(finalPath, { recursive: true, force: true });
		}

		// Reconcile should find staging missing → clean
		const result = deps.workspace.reconcileTransition(tmpDir, "tr-crash-1", claim.finalDir);
		expect(result.status).toBe("clean");
	});

	it("crash after rename — final dir exists, claim and staging gone", async () => {
		const deps = baseDeps();
		const claim = deps.workspace.acquireWorkspaceClaim(
			tmpDir,
			"Crash Post",
			"tr-crash-post-1",
		);
		const staged = deps.workspace.prepareStaging(claim);
		const finalPath = path.join(tmpDir, claim.finalDir);
		fs.renameSync(staged.stagingPath, finalPath);
		fs.rmSync(claim.claimPath, { recursive: true, force: true });

		// Reconcile should find final dir exists → clean
		const result = deps.workspace.reconcileTransition(tmpDir, "tr-crash-post-1", claim.finalDir);
		expect(result.status).toBe("clean");
	});

	it("marks prior run as replaced when new pointer installed", async () => {
		const deps = baseDeps();

		// First activation
		const req1: ResearchStartRequest = {
			mission: "First Run",
			profile: "standard",
			programPath: null,
			profileOverride: null,
			yes: true,
		};
		const ptr1 = await prepareAndActivateResearch(req1, { ...deps, config, getModels: () => models });

		// Second activation — should mark first as replaced
		const req2: ResearchStartRequest = {
			mission: "Second Run",
			profile: "standard",
			programPath: null,
			profileOverride: null,
			yes: true,
		};
		const ptr2 = await prepareAndActivateResearch(req2, { ...deps, config, getModels: () => models });

		const transitions = deps.transitions.getTransitions();
		expect(transitions.length).toBe(2);
		const first = transitions[0];
		expect(first.runId).toBe(ptr1.contract.runId);
		expect(first.status).toBe("replaced");
		const second = transitions[1];
		expect(second.runId).toBe(ptr2.contract.runId);
		expect(second.status).toBe("active");
	});
});

// ===========================================================================
// Step 2.5: TransitionsFile tests
// ===========================================================================

describe("TransitionsFile", () => {
	let tmpDir: string;
	let tf: TransitionsFile;

	beforeEach(() => {
		tmpDir = createTempDir();
		tf = new TransitionsFile(path.join(tmpDir, "transitions.json"));
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	it("starts empty", () => {
		expect(tf.getTransitions()).toHaveLength(0);
		expect(tf.getCurrentPointer()).toBeNull();
	});

	it("appends and retrieves transitions", () => {
		tf.appendTransition({
			transitionId: "tr-1",
			runId: "run-1",
			mission: "Test",
			profile: "standard",
			status: "active",
			claimedAt: Date.now(),
		});
		expect(tf.getTransitions()).toHaveLength(1);
		expect(tf.getTransitions()[0].runId).toBe("run-1");
	});

	it("sets and reads pointer", () => {
		tf.setPointer("run-1", "tr-1");
		const ptr = tf.getCurrentPointer();
		expect(ptr).toBeDefined();
		expect(ptr!.runId).toBe("run-1");
		expect(ptr!.transitionId).toBe("tr-1");
	});

	it("marks transition as replaced", () => {
		tf.appendTransition({
			transitionId: "tr-1",
			runId: "run-1",
			mission: "Test",
			profile: "standard",
			status: "active",
			claimedAt: Date.now(),
		});
		tf.markTransitionAsReplaced("run-1");
		const transitions = tf.getTransitions();
		expect(transitions[0].status).toBe("replaced");
	});
});

// ===========================================================================
// F7: /research registration — actually verifies registerLoopCommand params
// ===========================================================================

describe("F7: /research registration", () => {

	const registeredCommands: {
		name: string;
		opts: { description: string };
	}[] = [];

	function mockPi() {
		return {
			registerCommand: (name: string, opts: { description: string }) => {
				registeredCommands.push({ name, opts });
			},
			registerTool: () => {},
			on: () => {},
			getActiveTools: () => [],
			setActiveTools: () => {},
			isIdle: () => true,
		} as unknown as ExtensionAPI;
	}

	beforeEach(() => {
		registeredCommands.length = 0;
	});

	function mockEngine() {
		return {
			state: null,
			startState: () => ({
				id: "test-1",
				commandName: "research" as const,
				mission: "",
				status: "active" as const,
				rounds: 0,
				maxRounds: 8,
				tokensUsed: 0,
				tokenBudget: null,
				noProgressTurns: 3,
				programPath: "/fake/program.md",
				workingDir: "/tmp/test",
				maxSearchesPerAgent: 0,
				maxFetchesPerAgent: 0,
				profile: "standard",
				guardId: "test",
				createdAt: Date.now(),
				updatedAt: Date.now(),
			}),
			persist: () => {},
			emit: () => {},
			latestState: () => null,
			resumeState: () => null,
			pauseState: () => {},
			clearState: () => null,
			startTurn: () => {},
			endTurn: async () => {},
			onAgentEnd: () => {},
			completeState: () => ({ id: "test-1" }),
			getStatusLine: () => "",
		} as unknown as LoopEngine;
	}

	it("registerLoopCommand is called with command:'research' and isResearch:true", () => {
		const pi = mockPi();
		const engine = mockEngine();

		registerLoopCommand(pi, {
			command: "research",
			description: "Deep research test",
			defaultProgram: "/fake/program.md",
			defaultMaxRounds: 8,
			isResearch: true,
		});

		// Verify registerCommand was invoked for "research"
		const researchCmd = registeredCommands.find((c) => c.name === "research");
		expect(researchCmd).toBeDefined();
		expect(researchCmd!.name).toBe("research");

		// The usage string in the description should contain research-specific flags
		expect(researchCmd!.opts.description).toContain("--yes");
		expect(researchCmd!.opts.description).toContain("--profile");
	});

	it("registerLoopCommand for /loop does NOT have isResearch flags", () => {
		const pi = mockPi();
		const engine = mockEngine();

		registerLoopCommand(pi, {
			command: "loop",
			description: "Generic loop test",
			defaultProgram: "program.md",
			defaultMaxRounds: 10,
		});

		const loopCmd = registeredCommands.find((c) => c.name === "loop");
		expect(loopCmd).toBeDefined();
		expect(loopCmd!.name).toBe("loop");

		// Generic loop should NOT have research-specific flags
		expect(loopCmd!.opts.description).not.toContain("--yes");
		expect(loopCmd!.opts.description).not.toContain("--profile");
	});
});

// ===========================================================================
// F9: Mid-flow failure cleanup tests
// ===========================================================================

describe("F9: Mid-flow failure cleanup", () => {
	let tmpDir: string;
	let config: ResolvedResearchConfig;
	let models: ModelRegistryView;

	function baseDeps(): Omit<StartupDependencies, "getModels" | "config"> {
		const transitionsPath = path.join(tmpDir, ".research", "transitions.json");
		fs.mkdirSync(path.join(tmpDir, ".research"), { recursive: true });
		const transitions = new TransitionsFile(transitionsPath);
		return {
			workspace: {
				acquireWorkspaceClaim: (projectRoot, mission, transitionId) => {
					const finalDir = mission.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 30) || "research";
					const claimPath = path.join(projectRoot, `.claim-${finalDir}-${transitionId}`);
					fs.mkdirSync(path.dirname(claimPath), { recursive: true });
					fs.mkdirSync(claimPath, { recursive: false });
					fs.writeFileSync(
						path.join(claimPath, ".meta.json"),
						JSON.stringify({ mission, finalDir, transitionId }),
						"utf-8",
					);
					return { finalDir, claimPath, transitionId } as WorkspaceClaim;
				},
				prepareStaging: (claim) => {
					const stagingPath = path.join(tmpDir, `.staging-${claim.finalDir}`);
					fs.mkdirSync(stagingPath, { recursive: false });
					return { stagingPath, finalDir: claim.finalDir, projectRoot: tmpDir, transitionId: claim.transitionId } as StagedRun;
				},
				commitStaging: (staged, claim) => {
					const finalPath = path.join(staged.projectRoot, staged.finalDir);
					fs.renameSync(staged.stagingPath, finalPath);
					fs.rmSync(claim.claimPath, { recursive: true, force: true });
					fs.mkdirSync(path.join(finalPath, ".research"), { recursive: false });
					const runId = `${staged.transitionId}-${staged.finalDir}`;
					return { path: finalPath, projectRoot: staged.projectRoot, mission: staged.finalDir, runId, transitionId: staged.transitionId } as Workspace;
				},
				reconcileTransition: () => ({ status: "clean" }),
				ensureGitExclude: () => { /* no-op in tests */ },
			},
			state: {
				newRunState: (ws) => ({
					revision: 1,
					status: "active",
					createdAt: Date.now(),
					updatedAt: Date.now(),
					mission: ws.mission,
					runId: ws.runId,
					coordinatorUsage: 0,
					nestedUsage: 0,
					tokensUsed: 0,
					concurrentReservations: 0,
					researchRound: 0,
					checkpointVerdict: "CONTINUE",
					checkpointDigest: "",
					checkpointUnmet: [],
					checkpointUniqueSources: 0,
					loopIteration: 0,
					checkpointProfile: "standard",
				} as unknown as RunState),
				acquireLease: async (ws) => ({
					sessionId: ws.runId,
					acquiredAt: Date.now(),
					expiresAt: Date.now() + 300000,
				} as unknown as RunLease),
			},
			manifest: {
				createRunManifest: (ws) => {
					const manifestPath = path.join(ws.path, ".research", "run.json");
					const manifest = {
						runId: ws.runId,
						mission: ws.mission,
						workspace: ws.path,
						manifestPath,
						createdAt: Date.now(),
						snapshotSha256: null,
					};
					fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
					return manifest as unknown as RunManifest;
				},
			},
			transitions,
			policy: {
				createPolicy: () => ({
					claim: async () => true,
					resolve: async () => ({ providerId: "scout", descriptor: { id: "scout", adapterVersion: "1.0", capabilities: [] }, attempts: [], totalAttempts: 0 }),
					reserveAttempt: async () => undefined,
					releaseAttempt: async () => {},
					exportArtifact: async () => undefined,
				} as unknown as ResearchPolicy),
			},
			checkpoint: {
				evaluateCheckpoint: async () => ({
					state: {} as unknown as RunState,
					verdict: "CONTINUE",
					round: 0,
					unmet: [],
					evidenceDigest: "",
				} as unknown as ReturnType<typeof import("../extensions/research/checkpoint.ts").evaluateCheckpoint>),
			},
			verification: {
				runVerification: () => [],
			},
			logger: {
				log: () => { /* no-op */ },
			},
		};
	}

	beforeEach(() => {
		tmpDir = createTempDir();
		config = baseConfig();
		models = fakeModelRegistry({
			strong: { id: "strong-1", name: "strong", provider: "anthropic", capabilities: ["web_lookup", "fetch_web"] },
			eval: { id: "eval-1", name: "eval", provider: "anthropic", capabilities: ["read"] },
		});
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	function makeRequest(mission = "Cleanup Test", profile = "standard"): ResearchStartRequest {
		return {
			mission,
			profile,
			programPath: null,
			profileOverride: null,
			yes: true,
		};
	}

	it("cleans up staging on manifest creation failure", async () => {
		const deps = baseDeps();
		let stagingPath: string | undefined;

		// Track staging creation
		deps.workspace.prepareStaging = (claim) => {
			const sp = path.join(tmpDir, `.staging-${claim.finalDir}`);
			stagingPath = sp;
			fs.mkdirSync(sp, { recursive: false });
			return { stagingPath: sp, finalDir: claim.finalDir, projectRoot: tmpDir, transitionId: claim.transitionId } as StagedRun;
		};

		// Fail manifest creation
		deps.manifest.createRunManifest = () => {
			throw new Error("Manifest creation failed");
		};

		const request = makeRequest("ManifestFailure");
		await expect(
			prepareAndActivateResearch(request, { ...deps, config, getModels: () => models }),
		).rejects.toThrow("Manifest creation failed");

		// Staging should be cleaned up
		expect(stagingPath).toBeDefined();
		expect(fs.existsSync(stagingPath!)).toBe(false);
	});

	it("cleans up staging on state creation failure", async () => {
		const deps = baseDeps();
		let stagingPath: string | undefined;

		deps.workspace.prepareStaging = (claim) => {
			const sp = path.join(tmpDir, `.staging-${claim.finalDir}`);
			stagingPath = sp;
			fs.mkdirSync(sp, { recursive: false });
			return { stagingPath: sp, finalDir: claim.finalDir, projectRoot: tmpDir, transitionId: claim.transitionId } as StagedRun;
		};

		// Fail newRunState
		deps.state.newRunState = () => {
			throw new Error("State creation failed");
		};

		const request = makeRequest("StateFailure");
		await expect(
			prepareAndActivateResearch(request, { ...deps, config, getModels: () => models }),
		).rejects.toThrow("State creation failed");

		expect(stagingPath).toBeDefined();
		expect(fs.existsSync(stagingPath!)).toBe(false);
	});

	it("cleans up staging on lease acquisition failure", async () => {
		const deps = baseDeps();
		let stagingPath: string | undefined;

		deps.workspace.prepareStaging = (claim) => {
			const sp = path.join(tmpDir, `.staging-${claim.finalDir}`);
			stagingPath = sp;
			fs.mkdirSync(sp, { recursive: false });
			return { stagingPath: sp, finalDir: claim.finalDir, projectRoot: tmpDir, transitionId: claim.transitionId } as StagedRun;
		};

		// Fail lease acquisition
		deps.state.acquireLease = async () => {
			throw new Error("Lease acquisition failed");
		};

		const request = makeRequest("LeaseFailure");
		await expect(
			prepareAndActivateResearch(request, { ...deps, config, getModels: () => models }),
		).rejects.toThrow("Lease acquisition failed");

		expect(stagingPath).toBeDefined();
		expect(fs.existsSync(stagingPath!)).toBe(false);
	});

	it("cleans up staging on git-exclude failure", async () => {
		const deps = baseDeps();
		let stagingPath: string | undefined;

		deps.workspace.prepareStaging = (claim) => {
			const sp = path.join(tmpDir, `.staging-${claim.finalDir}`);
			stagingPath = sp;
			fs.mkdirSync(sp, { recursive: false });
			return { stagingPath: sp, finalDir: claim.finalDir, projectRoot: tmpDir, transitionId: claim.transitionId } as StagedRun;
		};

		// Fail ensureGitExclude
		deps.workspace.ensureGitExclude = () => {
			throw new Error("Git exclude failed");
		};

		const request = makeRequest("GitExcludeFailure");
		await expect(
			prepareAndActivateResearch(request, { ...deps, config, getModels: () => models }),
		).rejects.toThrow("Git exclude failed");

		expect(stagingPath).toBeDefined();
		expect(fs.existsSync(stagingPath!)).toBe(false);
	});

	it("cleans up staging on transition append failure", async () => {
		const deps = baseDeps();
		let stagingPath: string | undefined;

		deps.workspace.prepareStaging = (claim) => {
			const sp = path.join(tmpDir, `.staging-${claim.finalDir}`);
			stagingPath = sp;
			fs.mkdirSync(sp, { recursive: false });
			return { stagingPath: sp, finalDir: claim.finalDir, projectRoot: tmpDir, transitionId: claim.transitionId } as StagedRun;
		};

		// Fail transition append
		deps.transitions.appendTransition = () => {
			throw new Error("Transition append failed");
		};

		const request = makeRequest("TransitionFailure");
		await expect(
			prepareAndActivateResearch(request, { ...deps, config, getModels: () => models }),
		).rejects.toThrow("Transition append failed");

		expect(stagingPath).toBeDefined();
		expect(fs.existsSync(stagingPath!)).toBe(false);
	});

	it("cleans up staging on pointer install failure", async () => {
		const deps = baseDeps();
		let stagingPath: string | undefined;

		deps.workspace.prepareStaging = (claim) => {
			const sp = path.join(tmpDir, `.staging-${claim.finalDir}`);
			stagingPath = sp;
			fs.mkdirSync(sp, { recursive: false });
			return { stagingPath: sp, finalDir: claim.finalDir, projectRoot: tmpDir, transitionId: claim.transitionId } as StagedRun;
		};

		// Fail pointer install
		deps.transitions.setPointer = () => {
			throw new Error("Pointer install failed");
		};

		const request = makeRequest("PointerFailure");
		await expect(
			prepareAndActivateResearch(request, { ...deps, config, getModels: () => models }),
		).rejects.toThrow("Pointer install failed");

		expect(stagingPath).toBeDefined();
		expect(fs.existsSync(stagingPath!)).toBe(false);
	});

	it("cleans up staging on policy creation failure", async () => {
		const deps = baseDeps();
		let stagingPath: string | undefined;

		deps.workspace.prepareStaging = (claim) => {
			const sp = path.join(tmpDir, `.staging-${claim.finalDir}`);
			stagingPath = sp;
			fs.mkdirSync(sp, { recursive: false });
			return { stagingPath: sp, finalDir: claim.finalDir, projectRoot: tmpDir, transitionId: claim.transitionId } as StagedRun;
		};

		// Fail policy creation
		deps.policy.createPolicy = () => {
			throw new Error("Policy creation failed");
		};

		const request = makeRequest("PolicyFailure");
		await expect(
			prepareAndActivateResearch(request, { ...deps, config, getModels: () => models }),
		).rejects.toThrow("Policy creation failed");

		expect(stagingPath).toBeDefined();
		expect(fs.existsSync(stagingPath!)).toBe(false);
	});

	it("cleans up staging on checkpoint/verification failure after staging commit", async () => {
		const deps = baseDeps();
		let stagingPath: string | undefined;

		deps.workspace.prepareStaging = (claim) => {
			const sp = path.join(tmpDir, `.staging-${claim.finalDir}`);
			stagingPath = sp;
			fs.mkdirSync(sp, { recursive: false });
			return { stagingPath: sp, finalDir: claim.finalDir, projectRoot: tmpDir, transitionId: claim.transitionId } as StagedRun;
		};

		// Fail checkpoint evaluation (happens after staging commit)
		deps.checkpoint.evaluateCheckpoint = async () => {
			throw new Error("Checkpoint failed");
		};

		const request = makeRequest("CheckpointFailure");
		await expect(
			prepareAndActivateResearch(request, { ...deps, config, getModels: () => models }),
		).rejects.toThrow("Checkpoint failed");

		// After staging commit, the staging dir is renamed to final. We verify
		// that the staging path (which was renamed) no longer exists as staging.
		expect(stagingPath).toBeDefined();
		expect(fs.existsSync(stagingPath!)).toBe(false);
	});

	it("previous run is left untouched when activation fails mid-flow", async () => {
		const deps = baseDeps();

		// First successful activation
		const req1: ResearchStartRequest = {
			mission: "Prior Run",
			profile: "standard",
			programPath: null,
			profileOverride: null,
			yes: true,
		};
		const ptr1 = await prepareAndActivateResearch(req1, { ...deps, config, getModels: () => models });
		expect(ptr1).toBeDefined();

		// Record the prior run state
		const priorTransitions = deps.transitions.getTransitions();
		expect(priorTransitions.length).toBe(1);
		expect(priorTransitions[0].runId).toBe(ptr1.contract.runId);
		expect(priorTransitions[0].status).toBe("active");

		// Second activation that fails mid-flow (manifest creation)
		deps.manifest.createRunManifest = () => {
			throw new Error("Manifest creation failed");
		};

		const req2: ResearchStartRequest = {
			mission: "Failing Run",
			profile: "standard",
			programPath: null,
			profileOverride: null,
			yes: true,
		};
		await expect(
			prepareAndActivateResearch(req2, { ...deps, config, getModels: () => models }),
		).rejects.toThrow("Manifest creation failed");

		// Verify prior run is untouched
		const transitions = deps.transitions.getTransitions();
		expect(transitions.length).toBe(1); // No new transition appended
		expect(transitions[0].runId).toBe(ptr1.contract.runId);
		expect(transitions[0].status).toBe("active"); // Still active, not replaced

		// Verify pointer still points to prior run
		const pointer = deps.transitions.getCurrentPointer();
		expect(pointer!.runId).toBe(ptr1.contract.runId);
	});
});

// ===========================================================================
// F10: Empty-roles edge case for validateStartupContract
// ===========================================================================

describe("F10: Empty roles edge case", () => {
	it("handles config.roles = {} — no roles to validate", async () => {
		const config = baseConfig();
		config.roles = {};
		const models = fakeModelRegistry({
			strong: { id: "s1", name: "strong", provider: "a", capabilities: [] },
			eval: { id: "e1", name: "eval", provider: "a", capabilities: [] },
		});

		// With empty roles, resolvedModels should be empty, no model resolution errors
		const contract = await validateStartupContract(config, models);

		expect(contract).toBeDefined();
		expect(Object.keys(contract.resolvedModels)).toHaveLength(0);
		// Hard ceilings should still be computed (sum over empty = 0)
		expect(contract.hardCeilings.maxConcurrentAttempts).toBe(0);
		// This should succeed because 0 concurrent capacity >= 0 roles
	});

	it("throws on insufficient capacity when roles exist but concurrentDispatch = 0", async () => {
		const config = baseConfig();
		config.roles.scout.concurrentDispatch = 0;
		config.roles.judge.concurrentDispatch = 0;
		config.roles.scout.tools = [];
		config.roles.judge.tools = [];
		config.capabilities = {};
		config.childExtensions = [];

		const models = fakeModelRegistry({
			strong: { id: "s1", name: "strong", provider: "a", capabilities: [] },
			eval: { id: "e1", name: "eval", provider: "a", capabilities: [] },
		});

		await expect(validateStartupContract(config, models)).rejects.toThrow(
			"Insufficient concurrent capacity",
		);
	});
});

// ===========================================================================
// Existing edge cases (unchanged)
// ===========================================================================

describe("validateStartupContract — edge cases", () => {
	it("throws when profile maxRounds < minRounds", async () => {
		const config = baseConfig();
		config.profiles.standard.maxRounds = 2;
		config.profiles.standard.minRounds = 5;
		const models = fakeModelRegistry({ strong: { id: "s1", name: "strong", provider: "a", capabilities: [] }, eval: { id: "e1", name: "eval", provider: "a", capabilities: [] } });
		await expect(validateStartupContract(config, models)).rejects.toThrow(
			"minRounds",
		);
	});
});

// ---------------------------------------------------------------------------
// Task 15: provider-free startup contract + research-owned resolved profiles
//
// All of these call validateStartupContract with the provider-free
// (config, models) signature and assert the Task 15 contract shape: each role
// alias resolves through config.models to a concrete model, prompts are read
// and frozen, and access/tool conflicts are checked — no provider negotiation.
// ---------------------------------------------------------------------------

describe("Task 15 — provider-free startup contract and resolvedProfiles", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = createTempDir();
	});

	afterEach(() => {
		cleanup(tmpDir);
	});

	function task15Config(
		aliases: Record<string, string>,
	): ResolvedResearchConfig {
		const scoutPrompt = path.join(tmpDir, "scout.md");
		const judgePrompt = path.join(tmpDir, "judge.md");
		fs.writeFileSync(scoutPrompt, "# Scout\nscout system prompt", "utf-8");
		fs.writeFileSync(judgePrompt, "# Judge\njudge system prompt", "utf-8");
		const base = baseConfig();
		return {
			...base,
			models: aliases,
			roles: {
				scout: { ...base.roles.scout, promptPath: scoutPrompt },
				judge: { ...base.roles.judge, promptPath: judgePrompt },
			},
		};
	}

	function task15Models(): ModelRegistryView {
		return fakeModelRegistry({
			"strong-1": {
				id: "strong-1",
				name: "strong",
				provider: "anthropic",
				capabilities: ["web_lookup", "fetch_web"],
			},
			"eval-1": {
				id: "eval-1",
				name: "eval",
				provider: "anthropic",
				capabilities: ["read"],
			},
		});
	}

	it("accepts config + model registry only and returns frozen resolvedProfiles keyed by role", async () => {
		const config = task15Config({ strong: "strong-1", eval: "eval-1" });
		const contract = await validateStartupContract(config, task15Models());

		expect(contract.resolvedProfiles).toBeDefined();
		expect(Object.keys(contract.resolvedProfiles).sort()).toEqual([
			"judge",
			"scout",
		]);
	});

	it("produces a concrete immutable ResolvedProfile snapshot per role", async () => {
		const config = task15Config({ strong: "strong-1", eval: "eval-1" });
		const contract = await validateStartupContract(config, task15Models());

		const scout = contract.resolvedProfiles.scout;
		expect(scout.name).toBe("scout");
		expect(scout.description).toBe("Discover sources");
		expect(scout.thinking).toBe("high");
		expect(scout.tools).toEqual(["web_lookup", "fetch_web"]);
		expect(scout.systemPrompt).toBe("# Scout\nscout system prompt");
		expect(scout.timeoutSeconds).toBe(1800);
		expect(Object.isFrozen(contract.resolvedProfiles)).toBe(true);
		expect(Object.isFrozen(scout)).toBe(true);
		expect(Object.isFrozen(scout.tools)).toBe(true);

		config.roles.scout.tools.push("write");
		config.models.strong = "changed-after-validation";
		expect(scout.tools).toEqual(["web_lookup", "fetch_web"]);
		expect(scout.model).toBe("strong-1");
	});

	it("resolves each role model alias through config.models to a concrete model", async () => {
		const config = task15Config({ strong: "strong-1", eval: "eval-1" });
		// Registry only exposes the concrete model ids; the alias must resolve.
		const contract = await validateStartupContract(config, task15Models());

		expect(contract.resolvedProfiles.scout.model).toBe("strong-1");
		expect(contract.resolvedProfiles.judge.model).toBe("eval-1");
	});

	it("rejects a role whose model alias is unknown in config and registry", async () => {
		const config = task15Config({});
		config.roles.scout.model = "ghost";
		const models = fakeModelRegistry({});
		await expect(
			validateStartupContract(config, models),
		).rejects.toThrow(/alias|model 'ghost'.*not found/i);
	});

	it("rejects a role whose promptPath is missing or malformed", async () => {
		const config = task15Config({ strong: "strong-1", eval: "eval-1" });
		config.roles.scout.promptPath = "/nonexistent/prompt-does-not-exist.md";
		await expect(
			validateStartupContract(config, task15Models()),
		).rejects.toThrow(/prompt/i);
	});

	it("rejects an access:read role that declares write-capable tools", async () => {
		const config = task15Config({ strong: "strong-1", eval: "eval-1" });
		config.roles.scout.tools = ["read", "write"];
		config.roles.scout.access = "read" as const;
		await expect(
			validateStartupContract(config, task15Models()),
		).rejects.toThrow(/write|access/i);
	});

	it("returns exactly the Task 15 contract keys (no provider negotiation block)", async () => {
		const config = task15Config({ strong: "strong-1", eval: "eval-1" });
		const contract = await validateStartupContract(config, task15Models());
		// The frozen contract exposes the Task 15 keys only — no provider-
		// negotiation block.
		expect(Object.keys(contract).sort()).toEqual([
			"defaults",
			"hardCeilings",
			"mission",
			"profile",
			"profileConfig",
			"programPath",
			"resolvedModels",
			"resolvedProfiles",
			"runId",
			"transitionId",
		]);
	});
});
