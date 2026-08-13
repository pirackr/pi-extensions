import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { loadDeepResearchConfiguration } from "../extensions/deep-research/config.ts";

/**
 * Create a temporary deep-research config with real files on disk.
 * Returns the package root (the parent of the config/ directory).
 */
function createTempConfig(overrides?: Record<string, unknown>): string {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "deep-research-test-"));
	const configDir = path.join(tmpDir, "config");
	const agentsDir = path.join(tmpDir, "skills", "research", "agents");
	fs.mkdirSync(configDir, { recursive: true });
	fs.mkdirSync(agentsDir, { recursive: true });

	// Write all prompt files so relative paths resolve
	const promptFiles: Record<string, string> = {
		planner: "# Planner prompt",
		scout: "# Scout prompt",
		fetcher: "# Fetcher prompt",
		consolidator: "# Consolidator prompt",
		"fragment-writer": "# Fragment writer prompt",
		judge: "# Judge prompt",
		"citation-agent": "# Citation agent prompt",
		"source-auditor": "# Source auditor prompt",
		"contradiction-resolver": "# Contradiction resolver prompt",
	};
	for (const [name, content] of Object.entries(promptFiles)) {
		fs.writeFileSync(path.join(agentsDir, `${name}.md`), content);
	}

	const defaults: Record<string, unknown> = {
		defaultProfile: "standard",
		defaults: {
			maxSearchesPerAgent: 20,
			maxFetchesPerAgent: 20,
			scoreThreshold: 80,
			retryCount: 1,
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
				verification: [
					"judge",
					"citation_agent",
					"source_auditor",
					"contradiction_resolver",
				],
			},
		},
		agents: {
			planner: {
				description:
					"Plan research sub-questions and initialize score tracking",
				model: "strong",
				thinking: "high",
				tools: ["read", "grep", "find", "ls"],
				access: "read",
				timeoutSeconds: 300,
				promptPath: "../skills/research/agents/planner.md",
				resultFormat: "markdown",
			},
			scout_research: {
				description:
					"Discover and evaluate sources — finds URLs, assesses credibility, returns findings + source list",
				model: "strong",
				thinking: "high",
				tools: ["read", "grep", "find", "ls", "web_lookup", "fetch_web"],
				access: "read",
				timeoutSeconds: 1800,
				promptPath: "../skills/research/agents/scout.md",
				resultFormat: "markdown",
			},
			fetcher: {
				description:
					"Deep read of URLs — extracts full content, summarizes key findings, flags credibility",
				model: "strong",
				thinking: "minimal",
				tools: ["read", "web_lookup", "fetch_web"],
				access: "read",
				timeoutSeconds: 720,
				promptPath: "../skills/research/agents/fetcher.md",
				resultFormat: "markdown",
			},
			consolidator: {
				description:
					"Consolidate new research reports into notes and score tracking",
				model: "strong",
				thinking: "high",
				tools: ["read", "write", "edit", "grep", "find", "ls"],
				access: "write",
				timeoutSeconds: 900,
				promptPath: "../skills/research/agents/consolidator.md",
				resultFormat: "markdown",
			},
			fragment_writer: {
				description:
					"Write org-mode report fragments with claim-level citations",
				model: "strong",
				thinking: "high",
				tools: ["read", "grep", "find", "ls"],
				access: "read",
				timeoutSeconds: 1200,
				promptPath: "../skills/research/agents/fragment-writer.md",
				resultFormat: "org",
			},
			judge: {
				description:
					"Evaluate draft research report against credibility rubric — returns pass/fail with specific findings",
				model: "eval",
				thinking: "medium",
				tools: ["read", "grep", "find", "ls", "web_lookup", "fetch_web"],
				access: "read",
				timeoutSeconds: 1200,
				promptPath: "../skills/research/agents/judge.md",
				resultFormat: "markdown",
			},
			citation_agent: {
				description:
					"Map claims to exact source locations — returns claim→URL→snippet mapping",
				model: "strong",
				thinking: "low",
				tools: ["read", "grep", "find", "ls", "web_lookup", "fetch_web"],
				access: "read",
				timeoutSeconds: 720,
				promptPath: "../skills/research/agents/citation-agent.md",
				resultFormat: "markdown",
			},
			source_auditor: {
				description:
					"Rate all sources used in research — flag low-quality sources, suggest replacements",
				model: "strong",
				thinking: "low",
				tools: ["read", "grep", "find", "ls", "web_lookup", "fetch_web"],
				access: "read",
				timeoutSeconds: 720,
				promptPath: "../skills/research/agents/source-auditor.md",
				resultFormat: "markdown",
			},
			contradiction_resolver: {
				description:
					"Investigate and resolve contradictions between sources — returns resolution or flags as unresolved",
				model: "light",
				thinking: "medium",
				tools: ["read", "grep", "find", "ls", "web_lookup", "fetch_web"],
				access: "read",
				timeoutSeconds: 960,
				promptPath: "../skills/research/agents/contradiction-resolver.md",
				resultFormat: "markdown",
			},
		},
		...overrides,
	};

	fs.writeFileSync(
		path.join(configDir, "deep-research.json"),
		JSON.stringify(defaults, null, 2),
	);

	return tmpDir;
}

function createTempUserConfig(
	agentDir: string,
	overrides: Record<string, unknown>,
): void {
	const userDir = path.join(agentDir, "deep-research");
	fs.mkdirSync(userDir, { recursive: true });
	fs.writeFileSync(
		path.join(userDir, "config.json"),
		JSON.stringify(overrides, null, 2),
	);
}

describe("loadDeepResearchConfiguration", () => {
	it("loads packaged defaults when no user override exists", () => {
		const tmpDir = createTempConfig();
		const agentDir = path.join(tmpDir, "user-agent-dir");
		const result = loadDeepResearchConfiguration(tmpDir, agentDir);

		expect(result.defaultProfile).toBe("standard");
		expect(result.defaults).toEqual({
			maxSearchesPerAgent: 20,
			maxFetchesPerAgent: 20,
			scoreThreshold: 80,
			retryCount: 1,
		});

		// Cleanup
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("packages consolidation as a dedicated strong write-capable agent", () => {
		const agentDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "deep-research-agent-"),
		);
		const packagedConfig = loadDeepResearchConfiguration(
			path.resolve("."),
			agentDir,
		);

		expect(packagedConfig.agents.consolidator).toMatchObject({
			model: "strong",
			access: "write",
			promptPath: expect.stringContaining(
				"skills/research/agents/consolidator.md",
			),
		});
		fs.rmSync(agentDir, { recursive: true, force: true });
	});
	it("packages fragment writing as a dedicated strong read-only research agent", () => {
		const agentDir = fs.mkdtempSync(
			path.join(os.tmpdir(), "deep-research-agent-"),
		);
		const packagedConfig = loadDeepResearchConfiguration(
			path.resolve("."),
			agentDir,
		);

		expect(packagedConfig.agents.fragment_writer).toMatchObject({
			model: "strong",
			access: "read",
			promptPath: expect.stringContaining(
				"skills/research/agents/fragment-writer.md",
			),
		});
		fs.rmSync(agentDir, { recursive: true, force: true });
	});

	it("defines all four profiles with correct values", () => {
		const tmpDir = createTempConfig();
		const agentDir = path.join(tmpDir, "user-agent-dir");
		const result = loadDeepResearchConfiguration(tmpDir, agentDir);

		expect(result.profiles.quick).toEqual({
			minRounds: 3,
			maxRounds: 3,
			minSources: 15,
			maxScouts: 3,
			maxFetchers: 1,
			verification: ["judge"],
		});
		expect(result.profiles.standard).toEqual({
			minRounds: 5,
			maxRounds: 5,
			minSources: 30,
			maxScouts: 8,
			maxFetchers: 4,
			verification: ["judge"],
		});
		expect(result.profiles.intermediate).toEqual({
			minRounds: 10,
			maxRounds: 10,
			minSources: 40,
			maxScouts: 12,
			maxFetchers: 6,
			verification: ["judge", "citation_agent", "source_auditor"],
		});
		expect(result.profiles.deep).toEqual({
			minRounds: 20,
			maxRounds: 20,
			minSources: 250,
			maxScouts: 32,
			maxFetchers: 16,
			verification: [
				"judge",
				"citation_agent",
				"source_auditor",
				"contradiction_resolver",
			],
		});

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("includes all nine research agents with correct metadata", () => {
		const tmpDir = createTempConfig();
		const agentDir = path.join(tmpDir, "user-agent-dir");
		const result = loadDeepResearchConfiguration(tmpDir, agentDir);

		const agentNames = Object.keys(result.agents);
		expect(agentNames).toContain("planner");
		expect(agentNames).toContain("scout_research");
		expect(agentNames).toContain("fetcher");
		expect(agentNames).toContain("consolidator");
		expect(agentNames).toContain("fragment_writer");
		expect(agentNames).toContain("judge");
		expect(agentNames).toContain("citation_agent");
		expect(agentNames).toContain("source_auditor");
		expect(agentNames).toContain("contradiction_resolver");

		expect(result.agents.scout_research).toMatchObject({
			description: expect.stringContaining("source"),
			model: "strong",
			thinking: "high",
			tools: expect.arrayContaining(["web_lookup", "fetch_web"]),
			access: "read",
			timeoutSeconds: 1800,
		});
		expect(result.agents.consolidator).toMatchObject({
			model: "strong",
			thinking: "high",
			tools: expect.arrayContaining(["read", "write", "edit"]),
			access: "write",
			timeoutSeconds: 900,
		});
		expect(result.agents.fragment_writer).toMatchObject({
			model: "strong",
			thinking: "high",
			tools: expect.arrayContaining(["read", "grep", "find", "ls"]),
			access: "read",
			timeoutSeconds: 1200,
		});

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("resolves prompt paths relative to the config file directory", () => {
		const tmpDir = createTempConfig();
		const agentDir = path.join(tmpDir, "user-agent-dir");
		const result = loadDeepResearchConfiguration(tmpDir, agentDir);

		const configDir = path.join(tmpDir, "config");
		expect(result.agents.scout_research.promptPath).toBe(
			path.join(
				configDir,
				"..",
				"skills",
				"research",
				"agents",
				"scout.md",
			),
		);
		expect(result.agents.judge.promptPath).toBe(
			path.join(
				configDir,
				"..",
				"skills",
				"research",
				"agents",
				"judge.md",
			),
		);

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("rejects unknown fields at the top level", () => {
		const tmpDir = createTempConfig({
			unknownField: "should be rejected",
		});
		const agentDir = path.join(tmpDir, "user-agent-dir");

		expect(() => loadDeepResearchConfiguration(tmpDir, agentDir)).toThrow(
			"Unknown field",
		);

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("rejects unknown fields inside agents", () => {
		const tmpDir = createTempConfig({
			agents: {
				scout: {
					description: "Test",
					model: "strong",
					thinking: "high",
					tools: ["read"],
					access: "read",
					timeoutSeconds: 300,
					promptPath: "../skills/research/agents/scout.md",
					resultFormat: "markdown",
					unknownField: "should be rejected",
				},
			},
		});
		const agentDir = path.join(tmpDir, "user-agent-dir");

		expect(() => loadDeepResearchConfiguration(tmpDir, agentDir)).toThrow(
			"Unknown field",
		);

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("rejects invalid model values", () => {
		const tmpDir = createTempConfig({
			profiles: {},
			agents: {
				scout: {
					description: "Test",
					model: "",
					thinking: "high",
					tools: ["read"],
					access: "read",
					timeoutSeconds: 300,
					promptPath: "../skills/research/agents/scout.md",
					resultFormat: "markdown",
				},
			},
		});
		const agentDir = path.join(tmpDir, "user-agent-dir");

		expect(() => loadDeepResearchConfiguration(tmpDir, agentDir)).toThrow(
			"model must be a non-empty string",
		);

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("rejects invalid thinking levels", () => {
		const tmpDir = createTempConfig({
			agents: {
				scout: {
					description: "Test",
					model: "strong",
					thinking: "ultra",
					tools: ["read"],
					access: "read",
					timeoutSeconds: 300,
					promptPath: "../skills/research/agents/scout.md",
					resultFormat: "markdown",
				},
			},
		});
		const agentDir = path.join(tmpDir, "user-agent-dir");

		expect(() => loadDeepResearchConfiguration(tmpDir, agentDir)).toThrow(
			"invalid thinking level",
		);

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("rejects invalid access levels", () => {
		const tmpDir = createTempConfig({
			agents: {
				scout: {
					description: "Test",
					model: "strong",
					thinking: "high",
					tools: ["read"],
					access: "admin",
					timeoutSeconds: 300,
					promptPath: "../skills/research/agents/scout.md",
					resultFormat: "markdown",
				},
			},
		});
		const agentDir = path.join(tmpDir, "user-agent-dir");

		expect(() => loadDeepResearchConfiguration(tmpDir, agentDir)).toThrow(
			"invalid access",
		);

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("rejects invalid tools", () => {
		const tmpDir = createTempConfig({
			profiles: {},
			agents: {
				scout: {
					description: "Test",
					model: "strong",
					thinking: "high",
					tools: "not-an-array",
					access: "read",
					timeoutSeconds: 300,
					promptPath: "../skills/research/agents/scout.md",
					resultFormat: "markdown",
				},
			},
		});
		const agentDir = path.join(tmpDir, "user-agent-dir");

		expect(() => loadDeepResearchConfiguration(tmpDir, agentDir)).toThrow(
			"tools must be an array of strings",
		);

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("rejects unresolvable prompt paths", () => {
		const tmpDir = createTempConfig({
			profiles: {},
			agents: {
				scout: {
					description: "Test",
					model: "strong",
					thinking: "high",
					tools: ["read"],
					access: "read",
					timeoutSeconds: 300,
					promptPath: "../skills/research/agents/nonexistent.md",
					resultFormat: "markdown",
				},
			},
		});
		const agentDir = path.join(tmpDir, "user-agent-dir");

		expect(() => loadDeepResearchConfiguration(tmpDir, agentDir)).toThrow(
			"unresolvable prompt path",
		);

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("rejects invalid timeoutSeconds", () => {
		const tmpDir = createTempConfig({
			agents: {
				scout: {
					description: "Test",
					model: "strong",
					thinking: "high",
					tools: ["read"],
					access: "read",
					timeoutSeconds: 5,
					promptPath: "../skills/research/agents/scout.md",
					resultFormat: "markdown",
				},
			},
		});
		const agentDir = path.join(tmpDir, "user-agent-dir");

		expect(() => loadDeepResearchConfiguration(tmpDir, agentDir)).toThrow(
			"timeoutSeconds",
		);

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("rejects invalid resultFormat values", () => {
		const tmpDir = createTempConfig({
			agents: {
				scout: {
					description: "Test",
					model: "strong",
					thinking: "high",
					tools: ["read"],
					access: "read",
					timeoutSeconds: 300,
					promptPath: "../skills/research/agents/scout.md",
					resultFormat: "html",
				},
			},
		});
		const agentDir = path.join(tmpDir, "user-agent-dir");

		expect(() => loadDeepResearchConfiguration(tmpDir, agentDir)).toThrow(
			"invalid resultFormat",
		);

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("rejects bad verification-role references in profiles", () => {
		const tmpDir = createTempConfig({
			profiles: {
				quick: {
					minRounds: 10,
					maxRounds: 10,
					minSources: 15,
					maxScouts: 3,
					maxFetchers: 1,
					verification: ["nonexistent_verifier"],
				},
			},
			agents: {
				judge: {
					description: "Judge",
					model: "eval",
					thinking: "medium",
					tools: ["read"],
					access: "read",
					timeoutSeconds: 1200,
					promptPath: "../skills/research/agents/judge.md",
					resultFormat: "markdown",
				},
			},
		});
		const agentDir = path.join(tmpDir, "user-agent-dir");

		expect(() => loadDeepResearchConfiguration(tmpDir, agentDir)).toThrow(
			"verification",
		);

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("applies user override deep-merge with precedence over packaged", () => {
		const tmpDir = createTempConfig();
		const agentDir = path.join(tmpDir, "user-agent-dir");
		// Create skills dir under user-agent-dir so the override's relative promptPath resolves
		const userAgentsDir = path.join(
			agentDir,
			"skills",
			"research",
			"agents",
		);
		fs.mkdirSync(userAgentsDir, { recursive: true });
		fs.writeFileSync(path.join(userAgentsDir, "scout.md"), "# Scout prompt");
		createTempUserConfig(agentDir, {
			defaults: {
				scoreThreshold: 90,
			},
			profiles: {},
			agents: {
				scout: {
					description: "User-overridden scout",
					model: "strong",
					thinking: "high",
					tools: ["read"],
					access: "read",
					timeoutSeconds: 600,
					promptPath: "../skills/research/agents/scout.md",
					resultFormat: "markdown",
				},
			},
		});

		const result = loadDeepResearchConfiguration(tmpDir, agentDir);

		// User override should deep-merge, not replace
		expect(result.defaults.scoreThreshold).toBe(90);
		expect(result.defaults.maxSearchesPerAgent).toBe(20); // from packaged
		expect(result.agents.scout.description).toBe("User-overridden scout");
		expect(result.agents.scout.timeoutSeconds).toBe(600);
		expect(result.agents.scout.model).toBe("strong"); // from packaged

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("resolves override prompt paths relative to the override file", () => {
		const tmpDir = createTempConfig({
			profiles: {},
			agents: {},
		});
		const agentDir = path.join(tmpDir, "user-agent-dir");
		const overrideDir = path.join(agentDir, "deep-research");
		const overrideAgentsDir = path.join(overrideDir, "agents");
		fs.mkdirSync(overrideAgentsDir, { recursive: true });
		fs.writeFileSync(
			path.join(overrideAgentsDir, "custom.md"),
			"# Custom agent prompt",
		);
		fs.writeFileSync(
			path.join(overrideDir, "config.json"),
			JSON.stringify({
				defaults: {},
				profiles: {},
				agents: {
					custom: {
						description: "Custom agent",
						model: "strong",
						thinking: "high",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "agents/custom.md",
						resultFormat: "markdown",
					},
				},
			}),
		);

		const result = loadDeepResearchConfiguration(tmpDir, agentDir);
		expect(result.agents.custom.promptPath).toBe(
			path.join(overrideDir, "agents", "custom.md"),
		);

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("rejects project-local overrides (no cwd-based override loading)", () => {
		const tmpDir = createTempConfig({
			profiles: {},
			agents: {},
		});
		const agentDir = path.join(tmpDir, "user-agent-dir");
		// Create a project-local override that should NOT be loaded
		const projectOverrideDir = path.join(tmpDir, "project-deep-research");
		fs.mkdirSync(projectOverrideDir, { recursive: true });
		fs.writeFileSync(
			path.join(projectOverrideDir, "config.json"),
			JSON.stringify({
				defaultProfile: "project-profile",
				agents: {
					project_scout: {
						description: "Should not exist",
						model: "strong",
						thinking: "high",
						tools: ["read"],
						access: "write",
						timeoutSeconds: 300,
						promptPath: "../skills/research/agents/scout.md",
						resultFormat: "markdown",
					},
				},
			}),
		);

		const result = loadDeepResearchConfiguration(tmpDir, agentDir);
		// Should NOT have project-local agents
		expect(result.agents).not.toHaveProperty("project_scout");
		expect(result.defaultProfile).toBe("standard");

		fs.rmSync(tmpDir, { recursive: true, force: true });
	});
});
