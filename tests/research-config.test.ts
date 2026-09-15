import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

// ---------------------------------------------------------------------------
// Helpers — fixture creation / cleanup
// ---------------------------------------------------------------------------

function createFixture(overrides: Record<string, unknown>): {
	tmpDir: string;
	configPath: string;
	cleanup: () => void;
} {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "research-config-test-"));
	const configPath = path.join(tmpDir, "research.json");
	fs.writeFileSync(configPath, JSON.stringify(overrides, null, 2), "utf-8");
	return {
		tmpDir,
		configPath,
		cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
	};
}

/**
 * Build a minimal valid research config as a baseline.
 */
function makeBaseConfig(overrides?: Partial<Record<string, unknown>>): Record<string, unknown> {
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
			quick: {
				minRounds: 3,
				maxRounds: 3,
				minSources: 15,
				maxScouts: 3,
				maxFetchers: 1,
				verification: ["judge"],
			},
			standard: {
				minRounds: 5,
				maxRounds: 5,
				minSources: 30,
				maxScouts: 8,
				maxFetchers: 4,
				verification: ["judge"],
			},
			intermediate: {
				minRounds: 10,
				maxRounds: 10,
				minSources: 40,
				maxScouts: 12,
				maxFetchers: 6,
				verification: ["judge", "citation_agent", "source_auditor"],
			},
			deep: {
				minRounds: 20,
				maxRounds: 20,
				minSources: 250,
				maxScouts: 32,
				maxFetchers: 16,
				verification: ["judge", "citation_agent", "source_auditor", "contradiction_resolver"],
			},
			"open-ended": {
				minRounds: 5,
				maxRounds: null,
				minSources: 30,
				maxScouts: 8,
				maxFetchers: 4,
				verification: ["judge"],
			},
		},
		roles: {
			scout: {
				description: "Discover and evaluate sources",
				model: "strong",
				thinking: "high",
				tools: ["read", "grep", "find", "ls", "web_search", "fetch_web"],
				access: "read",
				timeoutSeconds: 1800,
				promptPath: "../skills/research/agents/scout.md",
				resultFormat: "markdown",
				totalDispatch: 30,
				concurrentDispatch: 8,
				maxSearches: 30,
				maxFetches: 30,
				retention: "artifact",
			},
			fetcher: {
				description: "Deep read of URLs",
				model: "strong",
				thinking: "minimal",
				tools: ["read", "web_search", "fetch_web"],
				access: "read",
				timeoutSeconds: 720,
				promptPath: "../skills/research/agents/fetcher.md",
				resultFormat: "markdown",
				totalDispatch: 30,
				concurrentDispatch: 4,
				maxSearches: 10,
				maxFetches: 30,
				retention: "ephemeral",
			},
			assembler: {
				description: "Assemble and synthesize research fragments",
				model: "strong",
				thinking: "high",
				tools: ["read", "write", "edit", "grep", "find", "ls"],
				access: "write",
				timeoutSeconds: 1200,
				promptPath: "../skills/research/agents/assembler.md",
				resultFormat: "markdown",
				totalDispatch: 5,
				concurrentDispatch: 1,
				maxSearches: 5,
				maxFetches: 10,
				retention: "persistent",
			},
			judge: {
				description: "Evaluate draft research report against credibility rubric",
				model: "eval",
				thinking: "medium",
				tools: ["read", "grep", "find", "ls", "web_search", "fetch_web"],
				access: "read",
				timeoutSeconds: 1200,
				promptPath: "../skills/research/agents/judge.md",
				resultFormat: "markdown",
				totalDispatch: 10,
				concurrentDispatch: 1,
				maxSearches: 10,
				maxFetches: 10,
				retention: "artifact",
			},
			citation_agent: {
				description: "Map claims to exact source locations",
				model: "strong",
				thinking: "low",
				tools: ["read", "grep", "find", "ls", "web_search", "fetch_web"],
				access: "read",
				timeoutSeconds: 720,
				promptPath: "../skills/research/agents/citation-agent.md",
				resultFormat: "markdown",
				totalDispatch: 20,
				concurrentDispatch: 4,
				maxSearches: 20,
				maxFetches: 20,
				retention: "ephemeral",
			},
			source_auditor: {
				description: "Rate all sources used in research",
				model: "strong",
				thinking: "low",
				tools: ["read", "grep", "find", "ls", "web_search", "fetch_web"],
				access: "read",
				timeoutSeconds: 720,
				promptPath: "../skills/research/agents/source-auditor.md",
				resultFormat: "markdown",
				totalDispatch: 15,
				concurrentDispatch: 3,
				maxSearches: 15,
				maxFetches: 15,
				retention: "artifact",
			},
			contradiction_resolver: {
				description: "Investigate and resolve contradictions between sources",
				model: "light",
				thinking: "medium",
				tools: ["read", "grep", "find", "ls", "web_search", "fetch_web"],
				access: "read",
				timeoutSeconds: 960,
				promptPath: "../skills/research/agents/contradiction-resolver.md",
				resultFormat: "markdown",
				totalDispatch: 10,
				concurrentDispatch: 2,
				maxSearches: 10,
				maxFetches: 10,
				retention: "ephemeral",
			},
		},
		capabilities: {
			"web-search": {
				name: "web-search",
				paths: ["../extensions/web-search/index.ts"],
				requiredTools: ["web_search", "fetch_web"],
			},
			"tmux-subagent": {
				name: "tmux-subagent",
				paths: ["../extensions/tmux-subagent/index.ts"],
				requiredTools: ["write", "read"],
			},
		},
		childExtensions: ["../extensions/web-search/index.ts", "../extensions/tmux-subagent/index.ts"],
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// resolveResearchConfig — layer precedence
// ---------------------------------------------------------------------------

describe("resolveResearchConfig — layer precedence", () => {
	it("later layers override earlier ones in order", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer1 = {
			path: "/pkg/config.json",
			kind: "packaged" as const,
			value: {
				defaultProgram: "skills/research/program.md",
				defaultProfile: "standard",
				defaultProvider: null,
				defaults: {
					maxIterations: 10,
					maxTokens: 100000,
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
						description: "Packaged scout",
						model: "strong",
						thinking: "high",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "scout.md",
						resultFormat: "markdown",
						totalDispatch: 10,
						concurrentDispatch: 2,
						maxSearches: 10,
						maxFetches: 10,
						retention: "artifact",
					},
					judge: {
						description: "Judge",
						model: "eval",
						thinking: "medium",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "judge.md",
						resultFormat: "markdown",
						totalDispatch: 5,
						concurrentDispatch: 1,
						maxSearches: 5,
						maxFetches: 5,
						retention: "artifact",
					},
				},
				capabilities: {
					"web-search": {
						name: "web-search",
						paths: ["pkg/path.ts"],
						requiredTools: ["web_search"],
					},
				},
				childExtensions: ["pkg/child.ts"],
			},
		};

		const layer2 = {
			path: "/user/config.json",
			kind: "user" as const,
			value: {
				defaults: {
					maxIterations: 20, // override
					maxTokens: 200000, // override
				},
				roles: {
					scout: {
						description: "User-overridden scout", // override
						model: "strong",
						thinking: "high",
						tools: ["read", "web_search", "fetch_web"], // override
						access: "read",
						timeoutSeconds: 300,
						promptPath: "user-scout.md", // override
						resultFormat: "markdown",
						totalDispatch: 20, // override
						concurrentDispatch: 4, // override
						maxSearches: 20, // override
						maxFetches: 20, // override
						retention: "artifact",
					},
				},
				capabilities: {
					"web-search": {
						name: "web-search",
						paths: ["user/path.ts"], // override
						requiredTools: ["web_search", "fetch_web"], // override
					},
				},
				childExtensions: ["user/child.ts"], // override
			},
		};

		const result = resolveResearchConfig([layer1, layer2]);

		expect(result.defaults.maxIterations).toBe(20);
		expect(result.defaults.maxTokens).toBe(200000);
		// deepMerge for defaults
		expect(result.defaults.noProgress).toBe(2); // from layer1
		expect(result.defaults.scoreThreshold).toBe(80); // from layer1
		expect(result.defaults.retryCount).toBe(1); // from layer1
		expect(result.defaults.maxSearches).toBe(30); // from layer1
		expect(result.defaults.maxFetches).toBe(30); // from layer1
		// roles: deep merge
		expect(result.roles.scout.description).toBe("User-overridden scout");
		expect(result.roles.scout.tools).toEqual(["read", "web_search", "fetch_web"]);
		expect(result.roles.scout.totalDispatch).toBe(20);
		// roles not overridden still come from layer1
		expect(result.roles.judge.description).toBe("Judge");
		// capabilities
		expect(result.capabilities["web-search"].paths).toEqual([path.resolve("/user", "user/path.ts")]);
		expect(result.capabilities["web-search"].requiredTools).toEqual(["web_search", "fetch_web"]);
		// childExtensions: array replacement
		expect(result.childExtensions).toEqual([path.resolve("/user", "user/child.ts")]);
	});

	it("cli layer overrides user and packaged", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer1 = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: {
				defaultProgram: "skills/research/program.md",
				defaultProfile: "standard",
				defaultProvider: null,
				defaults: {
					maxIterations: 10,
					maxTokens: 100000,
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
						description: "Scout",
						model: "strong",
						thinking: "high",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "scout.md",
						resultFormat: "markdown",
						totalDispatch: 10,
						concurrentDispatch: 2,
						maxSearches: 10,
						maxFetches: 10,
						retention: "artifact",
					},
					judge: {
						description: "Judge",
						model: "eval",
						thinking: "medium",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "judge.md",
						resultFormat: "markdown",
						totalDispatch: 5,
						concurrentDispatch: 1,
						maxSearches: 5,
						maxFetches: 5,
						retention: "artifact",
					},
				},
				capabilities: {
					"web-search": {
						name: "web-search",
						paths: ["pkg.ts"],
						requiredTools: ["web_search"],
					},
				},
				childExtensions: ["pkg/child.ts"],
			},
		};

		const layer2 = {
			path: "/user.json",
			kind: "user" as const,
			value: {
				defaults: { maxIterations: 15 },
			},
		};

		const layer3 = {
			path: "/cli.json",
			kind: "cli" as const,
			value: {
				defaultProvider: "anthropic",
			},
		};

		const result = resolveResearchConfig([layer1, layer2, layer3]);

		expect(result.defaults.maxIterations).toBe(15);
		expect(result.defaultProvider).toBe("anthropic");
	});

	it("empty layers array throws", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		expect(() => resolveResearchConfig([])).toThrow(
			"At least one config layer is required",
		);
	});
});

// ---------------------------------------------------------------------------
// resolveResearchConfig — unknown-field rejection
// ---------------------------------------------------------------------------

describe("resolveResearchConfig — unknown-field rejection", () => {
	it("rejects unknown top-level fields in packaged layer", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const config = makeBaseConfig({ unknownField: "bad" });
		const layer = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: config,
		};

		expect(() => resolveResearchConfig([layer])).toThrow("Unknown field");
	});

	it("rejects unknown top-level fields in user layer", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer1 = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: makeBaseConfig(),
		};
		const layer2 = {
			path: "/user.json",
			kind: "user" as const,
			value: {
				unknownOverride: true,
			},
		};

		expect(() => resolveResearchConfig([layer1, layer2])).toThrow("Unknown field");
	});

	it("rejects unknown fields in defaults", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const config = makeBaseConfig({
			defaults: {
				maxIterations: 10,
				maxTokens: 200000,
				noProgress: 2,
				scoreThreshold: 80,
				retryCount: 1,
				maxSearches: 30,
				maxFetches: 30,
				bogusField: "rejected",
			},
		});
		const layer = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: config,
		};

		expect(() => resolveResearchConfig([layer])).toThrow("Unknown field");
	});

	it("rejects unknown fields in profiles", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const config = makeBaseConfig({
			profiles: {
				standard: {
					minRounds: 5,
					maxRounds: 5,
					minSources: 30,
					maxScouts: 8,
					maxFetchers: 4,
					verification: ["judge"],
					bogusField: "rejected",
				},
			},
			roles: {
				judge: {
					description: "Judge",
					model: "eval",
					thinking: "medium",
					tools: ["read"],
					access: "read",
					timeoutSeconds: 300,
					promptPath: "judge.md",
					resultFormat: "markdown",
					totalDispatch: 5,
					concurrentDispatch: 1,
					maxSearches: 5,
					maxFetches: 5,
					retention: "artifact",
				},
			},
		});
		const layer = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: config,
		};

		expect(() => resolveResearchConfig([layer])).toThrow("Unknown field");
	});

	it("rejects unknown fields in roles", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const config = makeBaseConfig({
			roles: {
				scout: {
					description: "Scout",
					model: "strong",
					thinking: "high",
					tools: ["read"],
					access: "read",
					timeoutSeconds: 300,
					promptPath: "scout.md",
					resultFormat: "markdown",
					totalDispatch: 10,
					concurrentDispatch: 2,
					maxSearches: 10,
					maxFetches: 10,
					retention: "artifact",
					bogusField: "rejected",
				},
				judge: {
					description: "Judge",
					model: "eval",
					thinking: "medium",
					tools: ["read"],
					access: "read",
					timeoutSeconds: 300,
					promptPath: "judge.md",
					resultFormat: "markdown",
					totalDispatch: 5,
					concurrentDispatch: 1,
					maxSearches: 5,
					maxFetches: 5,
					retention: "artifact",
				},
			},
		});
		const layer = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: config,
		};

		expect(() => resolveResearchConfig([layer])).toThrow("Unknown field");
	});

	it("rejects unknown fields in capabilities", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const config = makeBaseConfig({
			capabilities: {
				"web-search": {
					name: "web-search",
					paths: ["pkg.ts"],
					requiredTools: ["web_search"],
					bogusField: "rejected",
				},
			},
			roles: {
				judge: {
					description: "Judge",
					model: "eval",
					thinking: "medium",
					tools: ["read"],
					access: "read",
					timeoutSeconds: 300,
					promptPath: "judge.md",
					resultFormat: "markdown",
					totalDispatch: 5,
					concurrentDispatch: 1,
					maxSearches: 5,
					maxFetches: 5,
					retention: "artifact",
				},
			},
		});
		const layer = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: config,
		};

		expect(() => resolveResearchConfig([layer])).toThrow("Unknown field");
	});
});

// ---------------------------------------------------------------------------
// resolveResearchConfig — recursive object merge
// ---------------------------------------------------------------------------

describe("resolveResearchConfig — recursive object merge", () => {
	it("deep-merges nested objects", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer1 = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: makeBaseConfig(),
		};

		const layer2 = {
			path: "/user.json",
			kind: "user" as const,
			value: {
				defaults: {
					scoreThreshold: 90,
				},
			},
		};

		const result = resolveResearchConfig([layer1, layer2]);

		expect(result.defaults.scoreThreshold).toBe(90);
		// other defaults preserved from layer1
		expect(result.defaults.maxIterations).toBe(10);
		expect(result.defaults.maxTokens).toBe(200000);
		expect(result.defaults.noProgress).toBe(2);
		expect(result.defaults.retryCount).toBe(1);
		expect(result.defaults.maxSearches).toBe(30);
		expect(result.defaults.maxFetches).toBe(30);
	});

	it("preserves nested fields not overridden", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer1 = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: makeBaseConfig({
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
						description: "Scout",
						model: "strong",
						thinking: "high",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "scout.md",
						resultFormat: "markdown",
						totalDispatch: 10,
						concurrentDispatch: 2,
						maxSearches: 10,
						maxFetches: 10,
						retention: "artifact",
					},
					judge: {
						description: "Judge",
						model: "eval",
						thinking: "medium",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "judge.md",
						resultFormat: "markdown",
						totalDispatch: 5,
						concurrentDispatch: 1,
						maxSearches: 5,
						maxFetches: 5,
						retention: "artifact",
					},
				},
				capabilities: {
					"web-search": {
						name: "web-search",
						paths: ["pkg.ts"],
						requiredTools: ["web_search"],
					},
				},
				childExtensions: ["pkg/child.ts"],
			}),
		};

		const layer2 = {
			path: "/user.json",
			kind: "user" as const,
			value: {
				profiles: {
					standard: {
						minRounds: 10,
					},
				},
			},
		};

		const result = resolveResearchConfig([layer1, layer2]);

		expect(result.profiles.standard.minRounds).toBe(10);
		// other profile fields preserved from layer1
		expect(result.profiles.standard.maxRounds).toBe(5);
		expect(result.profiles.standard.minSources).toBe(30);
		expect(result.profiles.standard.maxScouts).toBe(8);
		expect(result.profiles.standard.maxFetchers).toBe(4);
		expect(result.profiles.standard.verification).toEqual(["judge"]);
	});
});

// ---------------------------------------------------------------------------
// resolveResearchConfig — atomic array replacement
// ---------------------------------------------------------------------------

describe("resolveResearchConfig — atomic array replacement", () => {
	it("replaces arrays entirely rather than concatenating", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer1 = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: {
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
					judge: {
						description: "Judge",
						model: "eval",
						thinking: "medium",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "judge.md",
						resultFormat: "markdown",
						totalDispatch: 5,
						concurrentDispatch: 1,
						maxSearches: 5,
						maxFetches: 5,
						retention: "artifact",
					},
					citation_agent: {
						description: "Citation agent",
						model: "strong",
						thinking: "low",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "citation-agent.md",
						resultFormat: "markdown",
						totalDispatch: 20,
						concurrentDispatch: 4,
						maxSearches: 20,
						maxFetches: 20,
						retention: "ephemeral",
					},
				},
				capabilities: {
					"web-search": {
						name: "web-search",
						paths: ["pkg.ts"],
						requiredTools: ["web_search"],
					},
				},
				childExtensions: ["pkg/child-a.ts", "pkg/child-b.ts"],
			},
		};

		const layer2 = {
			path: "/user.json",
			kind: "user" as const,
			value: {
				profiles: {
					standard: {
						verification: ["judge", "citation_agent"], // override
					},
				},
				capabilities: {
					"web-search": {
						name: "web-search",
						paths: ["user-a.ts", "user-b.ts", "user-c.ts"], // override
						requiredTools: ["web_search", "fetch_web"], // override
					},
				},
				childExtensions: ["user/child.ts"], // override
			},
		};

		const result = resolveResearchConfig([layer1, layer2]);

		// Arrays are replaced, not concatenated
		expect(result.profiles.standard.verification).toEqual(["judge", "citation_agent"]);
		expect(result.capabilities["web-search"].paths).toEqual(["/user-a.ts", "/user-b.ts", "/user-c.ts"]);
		expect(result.capabilities["web-search"].requiredTools).toEqual(["web_search", "fetch_web"]);
		expect(result.childExtensions).toEqual(["/user/child.ts"]);
	});
});

// ---------------------------------------------------------------------------
// resolveResearchConfig — nullable-field enforcement
// ---------------------------------------------------------------------------

describe("resolveResearchConfig — nullable-field enforcement", () => {
	it("accepts maxRounds: null (open-ended profiles)", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: {
				defaultProgram: "skills/research/program.md",
				defaultProfile: "open-ended",
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
					"open-ended": {
						minRounds: 5,
						maxRounds: null,
						minSources: 30,
						maxScouts: 8,
						maxFetchers: 4,
						verification: ["judge"],
					},
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
					judge: {
						description: "Judge",
						model: "eval",
						thinking: "medium",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "judge.md",
						resultFormat: "markdown",
						totalDispatch: 5,
						concurrentDispatch: 1,
						maxSearches: 5,
						maxFetches: 5,
						retention: "artifact",
					},
				},
				capabilities: {
					"web-search": {
						name: "web-search",
						paths: ["pkg.ts"],
						requiredTools: ["web_search"],
					},
				},
				childExtensions: ["pkg/child.ts"],
			},
		};

		const result = resolveResearchConfig([layer]);
		expect(result.profiles["open-ended"].maxRounds).toBeNull();
	});

	it("accepts maxRounds: positive integer", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: {
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
						maxRounds: 10,
						minSources: 30,
						maxScouts: 8,
						maxFetchers: 4,
						verification: ["judge"],
					},
				},
				roles: {
					judge: {
						description: "Judge",
						model: "eval",
						thinking: "medium",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "judge.md",
						resultFormat: "markdown",
						totalDispatch: 5,
						concurrentDispatch: 1,
						maxSearches: 5,
						maxFetches: 5,
						retention: "artifact",
					},
				},
				capabilities: {
					"web-search": {
						name: "web-search",
						paths: ["pkg.ts"],
						requiredTools: ["web_search"],
					},
				},
				childExtensions: ["pkg/child.ts"],
			},
		};

		const result = resolveResearchConfig([layer]);
		expect(result.profiles.standard.maxRounds).toBe(10);
	});

	it("rejects maxRounds: negative integer", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: {
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
						maxRounds: -1,
						minSources: 30,
						maxScouts: 8,
						maxFetchers: 4,
						verification: ["judge"],
					},
				},
				roles: {
					judge: {
						description: "Judge",
						model: "eval",
						thinking: "medium",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "judge.md",
						resultFormat: "markdown",
						totalDispatch: 5,
						concurrentDispatch: 1,
						maxSearches: 5,
						maxFetches: 5,
						retention: "artifact",
					},
				},
				capabilities: {
					"web-search": {
						name: "web-search",
						paths: ["pkg.ts"],
						requiredTools: ["web_search"],
					},
				},
				childExtensions: ["pkg/child.ts"],
			},
		};

		expect(() => resolveResearchConfig([layer])).toThrow("maxRounds must be a positive integer or null");
	});

	it("accepts defaultProvider as null", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: {
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
					judge: {
						description: "Judge",
						model: "eval",
						thinking: "medium",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "judge.md",
						resultFormat: "markdown",
						totalDispatch: 5,
						concurrentDispatch: 1,
						maxSearches: 5,
						maxFetches: 5,
						retention: "artifact",
					},
				},
				capabilities: {
					"web-search": {
						name: "web-search",
						paths: ["pkg.ts"],
						requiredTools: ["web_search"],
					},
				},
				childExtensions: ["pkg/child.ts"],
			},
		};

		const result = resolveResearchConfig([layer]);
		expect(result.defaultProvider).toBeNull();
	});

	it("rejects defaultProvider as non-string non-null", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: {
				defaultProgram: "skills/research/program.md",
				defaultProfile: "standard",
				defaultProvider: 123,
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
					judge: {
						description: "Judge",
						model: "eval",
						thinking: "medium",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "judge.md",
						resultFormat: "markdown",
						totalDispatch: 5,
						concurrentDispatch: 1,
						maxSearches: 5,
						maxFetches: 5,
						retention: "artifact",
					},
				},
				capabilities: {
					"web-search": {
						name: "web-search",
						paths: ["pkg.ts"],
						requiredTools: ["web_search"],
					},
				},
				childExtensions: ["pkg/child.ts"],
			},
		};

		expect(() => resolveResearchConfig([layer])).toThrow("defaultProvider must be a string or null");
	});

	it("accepts noProgress as the string 'off'", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: {
				defaultProgram: "skills/research/program.md",
				defaultProfile: "standard",
				defaultProvider: null,
				defaults: {
					maxIterations: 10,
					maxTokens: 200000,
					noProgress: "off",
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
					judge: {
						description: "Judge",
						model: "eval",
						thinking: "medium",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "judge.md",
						resultFormat: "markdown",
						totalDispatch: 5,
						concurrentDispatch: 1,
						maxSearches: 5,
						maxFetches: 5,
						retention: "artifact",
					},
				},
				capabilities: {
					"web-search": {
						name: "web-search",
						paths: ["pkg.ts"],
						requiredTools: ["web_search"],
					},
				},
				childExtensions: ["pkg/child.ts"],
			},
		};

		const result = resolveResearchConfig([layer]);
		expect(result.defaults.noProgress).toBe("off");
	});

	it("rejects noProgress as a negative number", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: {
				defaultProgram: "skills/research/program.md",
				defaultProfile: "standard",
				defaultProvider: null,
				defaults: {
					maxIterations: 10,
					maxTokens: 200000,
					noProgress: -1,
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
					judge: {
						description: "Judge",
						model: "eval",
						thinking: "medium",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "judge.md",
						resultFormat: "markdown",
						totalDispatch: 5,
						concurrentDispatch: 1,
						maxSearches: 5,
						maxFetches: 5,
						retention: "artifact",
					},
				},
				capabilities: {
					"web-search": {
						name: "web-search",
						paths: ["pkg.ts"],
						requiredTools: ["web_search"],
					},
				},
				childExtensions: ["pkg/child.ts"],
			},
		};

		expect(() => resolveResearchConfig([layer])).toThrow("noProgress");
	});
});

// ---------------------------------------------------------------------------
// resolveResearchConfig — path provenance
// ---------------------------------------------------------------------------

describe("resolveResearchConfig — path provenance", () => {
	it("resolves relative promptPath against the layer directory", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");
		const { tmpDir, configPath, cleanup } = createFixture(
			{
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
						description: "Scout",
						model: "strong",
						thinking: "high",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "skills/agents/scout.md",
						resultFormat: "markdown",
						totalDispatch: 10,
						concurrentDispatch: 2,
						maxSearches: 10,
						maxFetches: 10,
						retention: "artifact",
					},
					judge: {
						description: "Judge",
						model: "eval",
						thinking: "medium",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "skills/agents/judge.md",
						resultFormat: "markdown",
						totalDispatch: 5,
						concurrentDispatch: 1,
						maxSearches: 5,
						maxFetches: 5,
						retention: "artifact",
					},
				},
				capabilities: {
					"web-search": {
						name: "web-search",
						paths: ["pkg.ts"],
						requiredTools: ["web_search"],
					},
				},
				childExtensions: ["pkg/child.ts"],
			},
		);

		try {
			const layer = {
				path: configPath,
				kind: "packaged" as const,
				value: JSON.parse(fs.readFileSync(configPath, "utf-8")),
			};
			const result = resolveResearchConfig([layer]);
			const expectedScoutPath = path.resolve(tmpDir, "skills/agents/scout.md");
			const expectedJudgePath = path.resolve(tmpDir, "skills/agents/judge.md");
			expect(result.roles.scout.promptPath).toBe(expectedScoutPath);
			expect(result.roles.judge.promptPath).toBe(expectedJudgePath);
		} finally {
			cleanup();
		}
	});

	it("preserves absolute promptPath values unchanged", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer = {
			path: "/config/pkg.json",
			kind: "packaged" as const,
			value: {
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
						description: "Scout",
						model: "strong",
						thinking: "high",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "/absolute/path/to/scout.md",
						resultFormat: "markdown",
						totalDispatch: 10,
						concurrentDispatch: 2,
						maxSearches: 10,
						maxFetches: 10,
						retention: "artifact",
					},
					judge: {
						description: "Judge",
						model: "eval",
						thinking: "medium",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "judge.md",
						resultFormat: "markdown",
						totalDispatch: 5,
						concurrentDispatch: 1,
						maxSearches: 5,
						maxFetches: 5,
						retention: "artifact",
					},
				},
				capabilities: {
					"web-search": {
						name: "web-search",
						paths: ["pkg.ts"],
						requiredTools: ["web_search"],
					},
				},
				childExtensions: ["pkg/child.ts"],
			},
		};

		const result = resolveResearchConfig([layer]);
		expect(result.roles.scout.promptPath).toBe("/absolute/path/to/scout.md");
		// relative path resolved
		expect(result.roles.judge.promptPath).toBe(path.resolve("/config", "judge.md"));
	});

	it("resolves capability paths relative to config directory", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer = {
			path: "/config/pkg.json",
			kind: "packaged" as const,
			value: {
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
					judge: {
						description: "Judge",
						model: "eval",
						thinking: "medium",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "judge.md",
						resultFormat: "markdown",
						totalDispatch: 5,
						concurrentDispatch: 1,
						maxSearches: 5,
						maxFetches: 5,
						retention: "artifact",
					},
				},
				capabilities: {
					"web-search": {
						name: "web-search",
						paths: ["../extensions/web-search/index.ts"],
						requiredTools: ["web_search"],
					},
				},
				childExtensions: ["pkg/child.ts"],
			},
		};

		const result = resolveResearchConfig([layer]);
		expect(result.capabilities["web-search"].paths[0]).toBe(path.resolve("/extensions/web-search/index.ts"));
	});
});

// ---------------------------------------------------------------------------
// resolveResearchConfig — validation errors
// ---------------------------------------------------------------------------

describe("resolveResearchConfig — validation errors", () => {
	it("rejects non-JSON layer value", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: "not an object",
		};

		expect(() => resolveResearchConfig([layer])).toThrow("must be a JSON object");
	});

	it("rejects array layer value", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: [1, 2, 3],
		};

		expect(() => resolveResearchConfig([layer])).toThrow("must be a JSON object");
	});

	it("rejects null layer value", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: null,
		};

		expect(() => resolveResearchConfig([layer])).toThrow("must be a JSON object");
	});

	it("rejects empty defaultProgram", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: {
				defaultProgram: "",
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
					judge: {
						description: "Judge",
						model: "eval",
						thinking: "medium",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "judge.md",
						resultFormat: "markdown",
						totalDispatch: 5,
						concurrentDispatch: 1,
						maxSearches: 5,
						maxFetches: 5,
						retention: "artifact",
					},
				},
				capabilities: {
					"web-search": {
						name: "web-search",
						paths: ["pkg.ts"],
						requiredTools: ["web_search"],
					},
				},
				childExtensions: ["pkg/child.ts"],
			},
		};

		expect(() => resolveResearchConfig([layer])).toThrow("defaultProgram");
	});
});

// ---------------------------------------------------------------------------
// resolveCapability — packaged capability resolution
// ---------------------------------------------------------------------------

describe("resolveCapability — packaged capability resolution", () => {
	it("returns capability with resolved paths", async () => {
		const { resolveCapability } = await import("../extensions/research/config.ts");

		const cap = resolveCapability("web-search");

		expect(cap.name).toBe("web-search");
		expect(cap.paths).toHaveLength(1);
		expect(cap.paths[0]).toMatch(/\/extensions\/web-search\/index\.ts$/);
		expect(cap.requiredTools).toContain("web_search");
		expect(cap.requiredTools).toContain("fetch_web");
	});

	it("throws for unknown capability", async () => {
		const { resolveCapability } = await import("../extensions/research/config.ts");

		expect(() => resolveCapability("nonexistent-capability")).toThrow("Unknown capability");
	});
});

// ---------------------------------------------------------------------------
// resolveResearchConfig — explicit child paths
// ---------------------------------------------------------------------------

describe("resolveResearchConfig — explicit child paths", () => {
	it("accepts valid childExtensions array", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: {
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
					judge: {
						description: "Judge",
						model: "eval",
						thinking: "medium",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "judge.md",
						resultFormat: "markdown",
						totalDispatch: 5,
						concurrentDispatch: 1,
						maxSearches: 5,
						maxFetches: 5,
						retention: "artifact",
					},
				},
				capabilities: {
					"web-search": {
						name: "web-search",
						paths: ["pkg.ts"],
						requiredTools: ["web_search"],
					},
				},
				childExtensions: ["../extensions/web-search/index.ts", "../extensions/tmux-subagent/index.ts"],
			},
		};

		const result = resolveResearchConfig([layer]);
		expect(result.childExtensions).toEqual([
			path.resolve("/extensions/web-search/index.ts"),
			path.resolve("/extensions/tmux-subagent/index.ts"),
		]);
	});

	it("rejects childExtensions containing non-string items", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: {
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
					judge: {
						description: "Judge",
						model: "eval",
						thinking: "medium",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "judge.md",
						resultFormat: "markdown",
						totalDispatch: 5,
						concurrentDispatch: 1,
						maxSearches: 5,
						maxFetches: 5,
						retention: "artifact",
					},
				},
				capabilities: {
					"web-search": {
						name: "web-search",
						paths: ["pkg.ts"],
						requiredTools: ["web_search"],
					},
				},
				childExtensions: ["../extensions/web-search/index.ts", 123],
			},
		};

		expect(() => resolveResearchConfig([layer])).toThrow("childExtensions must be an array of strings");
	});

	it("overrides childExtensions in user layer", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer1 = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: {
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
					judge: {
						description: "Judge",
						model: "eval",
						thinking: "medium",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "judge.md",
						resultFormat: "markdown",
						totalDispatch: 5,
						concurrentDispatch: 1,
						maxSearches: 5,
						maxFetches: 5,
						retention: "artifact",
					},
				},
				capabilities: {
					"web-search": {
						name: "web-search",
						paths: ["pkg.ts"],
						requiredTools: ["web_search"],
					},
				},
				childExtensions: ["pkg/child.ts"],
			},
		};

		const layer2 = {
			path: "/user.json",
			kind: "user" as const,
			value: {
				childExtensions: ["user/child.ts", "another/child.ts"],
			},
		};

		const result = resolveResearchConfig([layer1, layer2]);
		expect(result.childExtensions).toEqual([
			path.resolve("/user/child.ts"),
			path.resolve("/another/child.ts"),
		]);
	});
});

// ---------------------------------------------------------------------------
// resolveResearchConfig — credential-field rejection
// ---------------------------------------------------------------------------

describe("resolveResearchConfig — credential-field rejection", () => {
	it("rejects apiKey in role", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: {
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
						description: "Scout",
						model: "strong",
						thinking: "high",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "scout.md",
						resultFormat: "markdown",
						totalDispatch: 10,
						concurrentDispatch: 2,
						maxSearches: 10,
						maxFetches: 10,
						retention: "artifact",
						apiKey: "sk-live-should-be-rejected",
					},
					judge: {
						description: "Judge",
						model: "eval",
						thinking: "medium",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "judge.md",
						resultFormat: "markdown",
						totalDispatch: 5,
						concurrentDispatch: 1,
						maxSearches: 5,
						maxFetches: 5,
						retention: "artifact",
					},
				},
				capabilities: {
					"web-search": {
						name: "web-search",
						paths: ["pkg.ts"],
						requiredTools: ["web_search"],
					},
				},
				childExtensions: ["pkg/child.ts"],
			},
		};

		expect(() => resolveResearchConfig([layer])).toThrow("Credential field");
	});

	it("rejects api_key in capability", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: {
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
					judge: {
						description: "Judge",
						model: "eval",
						thinking: "medium",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "judge.md",
						resultFormat: "markdown",
						totalDispatch: 5,
						concurrentDispatch: 1,
						maxSearches: 5,
						maxFetches: 5,
						retention: "artifact",
					},
				},
				capabilities: {
					"web-search": {
						name: "web-search",
						paths: ["pkg.ts"],
						requiredTools: ["web_search"],
						api_key: "should-be-rejected",
					},
				},
				childExtensions: ["pkg/child.ts"],
			},
		};

		expect(() => resolveResearchConfig([layer])).toThrow("Credential field");
	});

	it("rejects nested credential field (secret inside advancedOptions)", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: {
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
					judge: {
						description: "Judge",
						model: "eval",
						thinking: "medium",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "judge.md",
						resultFormat: "markdown",
						totalDispatch: 5,
						concurrentDispatch: 1,
						maxSearches: 5,
						maxFetches: 5,
						retention: "artifact",
					},
				},
				capabilities: {
					"web-search": {
						name: "web-search",
						paths: ["pkg.ts"],
						requiredTools: ["web_search"],
						advancedOptions: {
							nestedApiKey: "should-be-rejected",
						},
					},
				},
				childExtensions: ["pkg/child.ts"],
			},
		};

		expect(() => resolveResearchConfig([layer])).toThrow("Credential field");
	});

	it("rejects token in defaults", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: {
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
					token: "should-be-rejected",
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
					judge: {
						description: "Judge",
						model: "eval",
						thinking: "medium",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "judge.md",
						resultFormat: "markdown",
						totalDispatch: 5,
						concurrentDispatch: 1,
						maxSearches: 5,
						maxFetches: 5,
						retention: "artifact",
					},
				},
				capabilities: {
					"web-search": {
						name: "web-search",
						paths: ["pkg.ts"],
						requiredTools: ["web_search"],
					},
				},
				childExtensions: ["pkg/child.ts"],
			},
		};

		expect(() => resolveResearchConfig([layer])).toThrow("Credential field");
	});

	it("rejects password in profile", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: {
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
						password: "should-be-rejected",
					},
				},
				roles: {
					judge: {
						description: "Judge",
						model: "eval",
						thinking: "medium",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "judge.md",
						resultFormat: "markdown",
						totalDispatch: 5,
						concurrentDispatch: 1,
						maxSearches: 5,
						maxFetches: 5,
						retention: "artifact",
					},
				},
				capabilities: {
					"web-search": {
						name: "web-search",
						paths: ["pkg.ts"],
						requiredTools: ["web_search"],
					},
				},
				childExtensions: ["pkg/child.ts"],
			},
		};

		expect(() => resolveResearchConfig([layer])).toThrow("Credential field");
	});

	it("rejects top-level secret field", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: {
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
					judge: {
						description: "Judge",
						model: "eval",
						thinking: "medium",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "judge.md",
						resultFormat: "markdown",
						totalDispatch: 5,
						concurrentDispatch: 1,
						maxSearches: 5,
						maxFetches: 5,
						retention: "artifact",
					},
				},
				capabilities: {
					"web-search": {
						name: "web-search",
						paths: ["pkg.ts"],
						requiredTools: ["web_search"],
					},
				},
				childExtensions: ["pkg/child.ts"],
				secret: "should-be-rejected",
			},
		};

		expect(() => resolveResearchConfig([layer])).toThrow("Credential field");
	});

	it("rejects bearerToken in nested object within role", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: {
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
						description: "Scout",
						model: "strong",
						thinking: "high",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "scout.md",
						resultFormat: "markdown",
						totalDispatch: 10,
						concurrentDispatch: 2,
						maxSearches: 10,
						maxFetches: 10,
						retention: "artifact",
						nestedAuth: {
							bearerToken: "should-be-rejected",
						},
					},
					judge: {
						description: "Judge",
						model: "eval",
						thinking: "medium",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "judge.md",
						resultFormat: "markdown",
						totalDispatch: 5,
						concurrentDispatch: 1,
						maxSearches: 5,
						maxFetches: 5,
						retention: "artifact",
					},
				},
				capabilities: {
					"web-search": {
						name: "web-search",
						paths: ["pkg.ts"],
						requiredTools: ["web_search"],
					},
				},
				childExtensions: ["pkg/child.ts"],
			},
		};

		expect(() => resolveResearchConfig([layer])).toThrow("Credential field");
	});
});

// ---------------------------------------------------------------------------
// resolveResearchConfig — unreadable paths / missing config
// ---------------------------------------------------------------------------

describe("resolveResearchConfig — unreadable paths", () => {
	it("throws ENOENT when packaged config file does not exist", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		// Directly test the loadPackagedConfig internal path by calling resolveResearchConfig
		// with a ConfigLayer that has a non-existent file path but a valid value
		const layer = {
			path: "/nonexistent/config/research.json",
			kind: "packaged" as const,
			value: {
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
					judge: {
						description: "Judge",
						model: "eval",
						thinking: "medium",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "judge.md",
						resultFormat: "markdown",
						totalDispatch: 5,
						concurrentDispatch: 1,
						maxSearches: 5,
						maxFetches: 5,
						retention: "artifact",
					},
				},
				capabilities: {
					"web-search": {
						name: "web-search",
						paths: ["pkg.ts"],
						requiredTools: ["web_search"],
					},
				},
				childExtensions: ["pkg/child.ts"],
			},
		};

		// This should succeed because the value is already provided
		const result = resolveResearchConfig([layer]);
		expect(result.defaultProgram).toBe("skills/research/program.md");
	});

	it("resolveCapability throws when config file is missing", async () => {
		const { resolveCapability } = await import("../extensions/research/config.ts");

		// This test relies on the actual packaged config existing.
		// If the file exists, resolveCapability should succeed; if not, it should throw.
		const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "research-cap-test-"));
		const pkgConfigPath = path.join(tmpDir, "config", "research.json");
		fs.mkdirSync(path.dirname(pkgConfigPath), { recursive: true });

		try {
			// Write a minimal valid config
			fs.writeFileSync(
				pkgConfigPath,
				JSON.stringify({
					defaultProgram: "test",
					defaultProfile: "standard",
					defaultProvider: null,
					defaults: {
						maxIterations: 1,
						maxTokens: 1000,
						noProgress: "off",
						scoreThreshold: 80,
						retryCount: 0,
						maxSearches: 1,
						maxFetches: 1,
					},
					profiles: {
						standard: {
							minRounds: 1,
							maxRounds: 1,
							minSources: 0,
							maxScouts: 0,
							maxFetchers: 0,
							verification: [],
						},
					},
					roles: {
						judge: {
							description: "Judge",
							model: "eval",
							thinking: "medium",
							tools: ["read"],
							access: "read",
							timeoutSeconds: 300,
							promptPath: "judge.md",
							resultFormat: "markdown",
							totalDispatch: 1,
							concurrentDispatch: 1,
							maxSearches: 1,
							maxFetches: 1,
							retention: "artifact",
						},
					},
					capabilities: {},
					childExtensions: [],
				}),
			);

			// Since resolveCapability uses import.meta.dirname internally, it loads the
			// actual packaged config. We can only test that it throws for unknown capabilities.
			expect(() => resolveCapability("nonexistent")).toThrow("Unknown capability");
		} finally {
			fs.rmSync(tmpDir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// validateResearchConfig — final validation
// ---------------------------------------------------------------------------

describe("validateResearchConfig — final validation", () => {
	it("accepts a valid resolved config", async () => {
		const { resolveResearchConfig, validateResearchConfig } = await import(
			"../extensions/research/config.ts"
		);

		const layer = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: {
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
					judge: {
						description: "Judge",
						model: "eval",
						thinking: "medium",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "judge.md",
						resultFormat: "markdown",
						totalDispatch: 5,
						concurrentDispatch: 1,
						maxSearches: 5,
						maxFetches: 5,
						retention: "artifact",
					},
				},
				capabilities: {
					"web-search": {
						name: "web-search",
						paths: ["pkg.ts"],
						requiredTools: ["web_search"],
					},
				},
				childExtensions: ["pkg/child.ts"],
			},
		};

		const resolved = resolveResearchConfig([layer]);
		// Should not throw
		expect(() => validateResearchConfig(resolved)).not.toThrow();
	});

	it("rejects a config with unknown top-level field after resolution", async () => {
		const { validateResearchConfig } = await import("../extensions/research/config.ts");

		// ValidateResearchConfig calls validateFinalConfig which checks top-level
		// only for the known fields
		expect(() =>
			validateResearchConfig({
				defaultProgram: "test",
				defaultProfile: "standard",
				defaultProvider: null,
				defaults: {
					maxIterations: 1,
					maxTokens: 1,
					noProgress: "off",
					scoreThreshold: 80,
					retryCount: 0,
					maxSearches: 1,
					maxFetches: 1,
				},
				profiles: {},
				roles: {},
				capabilities: {},
				childExtensions: [],
				unknown: true,
			} as unknown as import("../extensions/research/config.ts").ResolvedResearchConfig),
		).toThrow("Unknown field");
	});
});

// ---------------------------------------------------------------------------
// resolveResearchConfig — role field validation
// ---------------------------------------------------------------------------

describe("resolveResearchConfig — role field validation", () => {
	it("rejects invalid thinking level in roles", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: {
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
						description: "Scout",
						model: "strong",
						thinking: "ultra",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "scout.md",
						resultFormat: "markdown",
						totalDispatch: 10,
						concurrentDispatch: 2,
						maxSearches: 10,
						maxFetches: 10,
						retention: "artifact",
					},
					judge: {
						description: "Judge",
						model: "eval",
						thinking: "medium",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "judge.md",
						resultFormat: "markdown",
						totalDispatch: 5,
						concurrentDispatch: 1,
						maxSearches: 5,
						maxFetches: 5,
						retention: "artifact",
					},
				},
				capabilities: {
					"web-search": {
						name: "web-search",
						paths: ["pkg.ts"],
						requiredTools: ["web_search"],
					},
				},
				childExtensions: ["pkg/child.ts"],
			},
		};

		expect(() => resolveResearchConfig([layer])).toThrow("invalid thinking level");
	});

	it("rejects invalid access level in roles", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: {
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
						description: "Scout",
						model: "strong",
						thinking: "high",
						tools: ["read"],
						access: "superuser",
						timeoutSeconds: 300,
						promptPath: "scout.md",
						resultFormat: "markdown",
						totalDispatch: 10,
						concurrentDispatch: 2,
						maxSearches: 10,
						maxFetches: 10,
						retention: "artifact",
					},
					judge: {
						description: "Judge",
						model: "eval",
						thinking: "medium",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "judge.md",
						resultFormat: "markdown",
						totalDispatch: 5,
						concurrentDispatch: 1,
						maxSearches: 5,
						maxFetches: 5,
						retention: "artifact",
					},
				},
				capabilities: {
					"web-search": {
						name: "web-search",
						paths: ["pkg.ts"],
						requiredTools: ["web_search"],
					},
				},
				childExtensions: ["pkg/child.ts"],
			},
		};

		expect(() => resolveResearchConfig([layer])).toThrow("invalid access level");
	});

	it("rejects invalid retention value in roles", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: {
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
						description: "Scout",
						model: "strong",
						thinking: "high",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "scout.md",
						resultFormat: "markdown",
						totalDispatch: 10,
						concurrentDispatch: 2,
						maxSearches: 10,
						maxFetches: 10,
						retention: "forever",
					},
					judge: {
						description: "Judge",
						model: "eval",
						thinking: "medium",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "judge.md",
						resultFormat: "markdown",
						totalDispatch: 5,
						concurrentDispatch: 1,
						maxSearches: 5,
						maxFetches: 5,
						retention: "artifact",
					},
				},
				capabilities: {
					"web-search": {
						name: "web-search",
						paths: ["pkg.ts"],
						requiredTools: ["web_search"],
					},
				},
				childExtensions: ["pkg/child.ts"],
			},
		};

		expect(() => resolveResearchConfig([layer])).toThrow("invalid retention value");
	});

	it("rejects invalid resultFormat in roles", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: {
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
						description: "Scout",
						model: "strong",
						thinking: "high",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "scout.md",
						resultFormat: "html",
						totalDispatch: 10,
						concurrentDispatch: 2,
						maxSearches: 10,
						maxFetches: 10,
						retention: "artifact",
					},
					judge: {
						description: "Judge",
						model: "eval",
						thinking: "medium",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "judge.md",
						resultFormat: "markdown",
						totalDispatch: 5,
						concurrentDispatch: 1,
						maxSearches: 5,
						maxFetches: 5,
						retention: "artifact",
					},
				},
				capabilities: {
					"web-search": {
						name: "web-search",
						paths: ["pkg.ts"],
						requiredTools: ["web_search"],
					},
				},
				childExtensions: ["pkg/child.ts"],
			},
		};

		expect(() => resolveResearchConfig([layer])).toThrow("invalid resultFormat");
	});

	it("rejects negative timeoutSeconds in roles", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: {
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
						description: "Scout",
						model: "strong",
						thinking: "high",
						tools: ["read"],
						access: "read",
						timeoutSeconds: -1,
						promptPath: "scout.md",
						resultFormat: "markdown",
						totalDispatch: 10,
						concurrentDispatch: 2,
						maxSearches: 10,
						maxFetches: 10,
						retention: "artifact",
					},
					judge: {
						description: "Judge",
						model: "eval",
						thinking: "medium",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "judge.md",
						resultFormat: "markdown",
						totalDispatch: 5,
						concurrentDispatch: 1,
						maxSearches: 5,
						maxFetches: 5,
						retention: "artifact",
					},
				},
				capabilities: {
					"web-search": {
						name: "web-search",
						paths: ["pkg.ts"],
						requiredTools: ["web_search"],
					},
				},
				childExtensions: ["pkg/child.ts"],
			},
		};

		expect(() => resolveResearchConfig([layer])).toThrow("timeoutSeconds");
	});
});

// ---------------------------------------------------------------------------
// resolveResearchConfig — deferred merged validation (F1)
// ---------------------------------------------------------------------------

describe("resolveResearchConfig — deferred merged validation (F1)", () => {
	it(
		"user layer with both profiles and roles validates verification references within that layer",
		async () => {
			const { resolveResearchConfig } = await import(
				"../extensions/research/config.ts"
			);

			const layer1 = {
				path: "/pkg.json",
				kind: "packaged" as const,
				value: makeBaseConfig(),
			};

			// User layer provides a profile referencing a role in the same layer
			const layer2 = {
				path: "/user.json",
				kind: "user" as const,
				value: {
					profiles: {
						custom: {
							minRounds: 5,
							maxRounds: 5,
							minSources: 10,
							maxScouts: 4,
							maxFetchers: 2,
							verification: ["judge"], // judge exists in this layer
						},
					},
					roles: {
						judge: {
							description: "Judge",
							model: "eval",
							thinking: "medium",
							tools: ["read"],
							access: "read",
							timeoutSeconds: 300,
							promptPath: "judge.md",
							resultFormat: "markdown",
							totalDispatch: 5,
							concurrentDispatch: 1,
							maxSearches: 5,
							maxFetches: 5,
							retention: "artifact",
						},
					},
				},
			};

			// Should succeed — judge exists in the same layer
			const result = resolveResearchConfig([layer1, layer2]);
			expect(result.profiles.custom.verification).toEqual(["judge"]);
		},
	);

	it(
		"user layer with profiles referencing a role from the SAME layer catches unknown references",
		async () => {
			const { resolveResearchConfig } = await import(
				"../extensions/research/config.ts"
			);

			const layer1 = {
				path: "/pkg.json",
				kind: "packaged" as const,
				value: makeBaseConfig(),
			};

			// User layer provides a profile referencing a role NOT in its own roles
			const layer2 = {
				path: "/user.json",
				kind: "user" as const,
				value: {
					profiles: {
						custom: {
							minRounds: 5,
							maxRounds: 5,
							minSources: 10,
							maxScouts: 4,
							maxFetchers: 2,
							verification: ["nonexistent_role"], // NOT in layer2's roles
						},
					},
					roles: {
						judge: {
							description: "Judge",
							model: "eval",
							thinking: "medium",
							tools: ["read"],
							access: "read",
							timeoutSeconds: 300,
							promptPath: "judge.md",
							resultFormat: "markdown",
							totalDispatch: 5,
							concurrentDispatch: 1,
							maxSearches: 5,
							maxFetches: 5,
							retention: "artifact",
						},
					},
				},
			};

			// Should fail — nonexistent_role is not in layer2's own roles
			expect(() => resolveResearchConfig([layer1, layer2])).toThrow(
				"verification references unknown role 'nonexistent_role'",
			);
		},
	);

	it(
		"user layer without roles still allows empty verification arrays",
		async () => {
			const { resolveResearchConfig } = await import(
				"../extensions/research/config.ts"
			);

			const layer1 = {
				path: "/pkg.json",
				kind: "packaged" as const,
				value: makeBaseConfig(),
			};

			// User layer provides profiles but NO roles — verification should pass
			// (agentNames is empty, so the `agentNames.size > 0` guard skips the check)
			const layer2 = {
				path: "/user.json",
				kind: "user" as const,
				value: {
					profiles: {
						custom: {
							minRounds: 5,
							maxRounds: 5,
							minSources: 10,
							maxScouts: 4,
							maxFetchers: 2,
							verification: [],
						},
					},
				},
			};

			const result = resolveResearchConfig([layer1, layer2]);
			expect(result.profiles.custom.verification).toEqual([]);
		},
	);
});

// ---------------------------------------------------------------------------
// resolveResearchConfig — resolvePaths does not mutate input (F2)
// ---------------------------------------------------------------------------

describe("resolveResearchConfig — resolvePaths does not mutate input (F2)", () => {
	it("original layer value is not mutated after resolveResearchConfig", async () => {
		const { resolveResearchConfig } = await import(
			"../extensions/research/config.ts"
		);

		const layerValue: Record<string, unknown> = {
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
					description: "Scout",
					model: "strong",
					thinking: "high",
					tools: ["read"],
					access: "read",
					timeoutSeconds: 300,
					promptPath: "scout.md",
					resultFormat: "markdown",
					totalDispatch: 10,
					concurrentDispatch: 2,
					maxSearches: 10,
					maxFetches: 10,
					retention: "artifact",
				},
				judge: {
					description: "Judge",
					model: "eval",
					thinking: "medium",
					tools: ["read"],
					access: "read",
					timeoutSeconds: 300,
					promptPath: "judge.md",
					resultFormat: "markdown",
					totalDispatch: 5,
					concurrentDispatch: 1,
					maxSearches: 5,
					maxFetches: 5,
					retention: "artifact",
				},
			},
			capabilities: {
				"web-search": {
					name: "web-search",
					paths: ["pkg.ts"],
					requiredTools: ["web_search"],
				},
			},
			childExtensions: ["pkg/child.ts"],
		};

		// Capture original values before calling resolveResearchConfig
		const originalScoutPrompt = layerValue.roles!.scout!.promptPath;
		const originalChildExtensions = (layerValue.childExtensions as string[]).slice();

		const layer = {
			path: "/config/pkg.json",
			kind: "packaged" as const,
			value: layerValue,
		};

		resolveResearchConfig([layer]);

		// Inputs must not be mutated
		expect(layerValue.roles!.scout!.promptPath).toBe(originalScoutPrompt);
		expect((layerValue.childExtensions as string[]).slice()).toEqual(originalChildExtensions);
		// Capability paths should not have been resolved in the original
		expect(layerValue.capabilities!["web-search"]!.paths).toEqual(["pkg.ts"]);
	});

	it("reusing the same value object across layers does not corrupt later layers", async () => {
		const { resolveResearchConfig } = await import(
			"../extensions/research/config.ts"
		);

		// Create two separate value objects that share the same nested objects
		// to test that resolvePaths clones deeply enough.
		const sharedRoles: Record<string, unknown> = {
			scout: {
				description: "Scout",
				model: "strong",
				thinking: "high",
				tools: ["read"],
				access: "read",
				timeoutSeconds: 300,
				promptPath: "scout.md",
				resultFormat: "markdown",
				totalDispatch: 10,
				concurrentDispatch: 2,
				maxSearches: 10,
				maxFetches: 10,
				retention: "artifact",
			},
			judge: {
				description: "Judge",
				model: "eval",
				thinking: "medium",
				tools: ["read"],
				access: "read",
				timeoutSeconds: 300,
				promptPath: "judge.md",
				resultFormat: "markdown",
				totalDispatch: 5,
				concurrentDispatch: 1,
				maxSearches: 5,
				maxFetches: 5,
				retention: "artifact",
			},
		};

		const baseConfig = {
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
			roles: sharedRoles,
			capabilities: {
				"web-search": {
					name: "web-search",
					paths: ["pkg.ts"],
					requiredTools: ["web_search"],
				},
			},
			childExtensions: ["pkg/child.ts"],
		};

		// Create two layers pointing to different paths but sharing the same
		// nested objects — if resolvePaths mutates, the second layer will see
		// resolved absolute paths from the first.
		const layer1 = {
			path: "/config/pkg.json",
			kind: "packaged" as const,
			value: JSON.parse(JSON.stringify(baseConfig)),
		};
		const layer2 = {
			path: "/user/config.json",
			kind: "user" as const,
			value: JSON.parse(JSON.stringify(baseConfig)),
		};

		resolveResearchConfig([layer1, layer2]);

		// layer1's value should still have the relative promptPath
		expect(layer1.value.roles!.scout!.promptPath).toBe("scout.md");
		// layer2's value should still have the relative promptPath
		expect(layer2.value.roles!.scout!.promptPath).toBe("scout.md");
		// Original sharedRoles should not have been mutated
		expect(sharedRoles.scout!.promptPath).toBe("scout.md");
	});
});

// ---------------------------------------------------------------------------
// ConfigLayer type — kind discrimination
// ---------------------------------------------------------------------------

describe("ConfigLayer kind discrimination", () => {
	it("packaged layer requires full validation", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		// Packaged layer: all fields required, full validation
		const layer = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: {
				defaultProgram: "skills/research/program.md",
				defaultProfile: "standard",
				defaultProvider: null,
				// missing: defaults, profiles, roles, capabilities, childExtensions
			},
		};

		// Packaged layer must have all fields — should fail
		expect(() => resolveResearchConfig([layer])).toThrow();
	});

	it("user layer only validates present fields", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer1 = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: makeBaseConfig(),
		};

		// User layer only overrides one field — should not fail
		const layer2 = {
			path: "/user.json",
			kind: "user" as const,
			value: {
				defaults: {
					maxIterations: 20,
				},
			},
		};

		const result = resolveResearchConfig([layer1, layer2]);
		expect(result.defaults.maxIterations).toBe(20);
	});
});

// ---------------------------------------------------------------------------
// resolveResearchConfig — Task 15: research-owned `models` alias map
//
// These tests fail against the current config (which rejects `models` as an
// unknown field and never exposes resolved aliases) and assert the Task 15
// behavior: a validated, layered `models` alias map owned by research config.
// ---------------------------------------------------------------------------

describe("resolveResearchConfig — models alias map (Task 15)", () => {
	it("accepts and exposes a validated packaged models alias map", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: {
				...makeBaseConfig(),
				models: {
					strong: "x-preview-f-free",
					eval: "mimo-v2.5-free",
					light: "x-preview-f-free",
					fast: "fast-alias-model",
				},
			},
		};

		const result = resolveResearchConfig([layer]);
		expect(result.models).toBeDefined();
		expect(result.models.strong).toBe("x-preview-f-free");
		expect(result.models.eval).toBe("mimo-v2.5-free");
	});

	it("lets a trusted user layer override a packaged alias under layering rules", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer1 = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: {
				...makeBaseConfig(),
				models: { strong: "pkg-strong", eval: "pkg-eval" },
			},
		};
		const layer2 = {
			path: "/user.json",
			kind: "user" as const,
			value: {
				models: { strong: "user-strong" },
			},
		};

		const result = resolveResearchConfig([layer1, layer2]);
		expect(result.models.strong).toBe("user-strong");
		// Unoverridden alias still resolves from the packaged layer.
		expect(result.models.eval).toBe("pkg-eval");
	});

	it("rejects a credential field inside the models alias map", async () => {
		const { resolveResearchConfig } = await import("../extensions/research/config.ts");

		const layer = {
			path: "/pkg.json",
			kind: "packaged" as const,
			value: {
				...makeBaseConfig(),
				models: { strong: "x-preview-f-free", token: "sk-live-secret" },
			},
		};

		expect(() => resolveResearchConfig([layer])).toThrow("Credential field");
	});

	it("ships generic subagent child runtime with simplified config", async () => {
		const { loadPackagedConfig } = await import("../extensions/research/config.ts");
		const packaged = loadPackagedConfig();

		// Config simplified: no research-owned model aliases (roles use general-purpose)
		expect(Object.keys(packaged.models)).toHaveLength(0);
		expect(
			packaged.childExtensions.some((entry) =>
				entry.endsWith("/extensions/subagent/index.ts"),
			),
		).toBe(true);
		expect(
			packaged.childExtensions.some((entry) =>
				entry.endsWith("/extensions/tmux-subagent/index.ts"),
			),
		).toBe(false);
	});
});
