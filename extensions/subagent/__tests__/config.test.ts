import { describe, it, expect, vi, beforeEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

// Mock node:fs before importing config
vi.mock("node:fs", async () => {
	const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
	return {
		...actual,
		default: {
			...actual,
			existsSync: vi.fn(),
			statSync: vi.fn(),
			readFileSync: vi.fn(),
			readdirSync: vi.fn(),
		},
		existsSync: vi.fn(),
		statSync: vi.fn(),
		readFileSync: vi.fn(),
		readdirSync: vi.fn(),
	};
});

// Mock the pi-coding-agent module before importing config
vi.mock("@earendil-works/pi-coding-agent", () => ({
	CONFIG_DIR_NAME: ".pi",
	getAgentDir: vi.fn().mockReturnValue("/mock/agent/dir"),
	parseFrontmatter: vi.fn(),
}));

import * as fs from "node:fs";
import {
	expandPath,
	readConfiguration,
	normalizePaths,
	normalizeModels,
	normalizeToolAccess,
	mergeToolAccess,
	normalizeWebSearchBudget,
	validateConfiguration,
	loadSubagentConfiguration,
	loadGenericProfilesFromDir,
	discoverProfiles,
	type SubagentConfiguration,
	type LoadedSubagentConfiguration,
} from "../config.ts";
import {
	getAgentDir,
	parseFrontmatter,
} from "@earendil-works/pi-coding-agent";
import type { AgentAccess } from "../types.ts";
import type { EventsBus } from "../config.ts";

const mockExistsSync = vi.mocked(fs.existsSync);
const mockStatSync = vi.mocked(fs.statSync);
const mockReadFileSync = vi.mocked(fs.readFileSync);
const mockReaddirSync = vi.mocked(fs.readdirSync);
const mockParseFrontmatter = vi.mocked(parseFrontmatter);
const mockGetAgentDir = vi.mocked(getAgentDir);

function mockDirent(name: string): any {
	return {
		name,
		isFile: () => true,
		isSymbolicLink: () => false,
		isDirectory: () => false,
	};
}

// --- discoverProfiles test harness: a controllable pi.events bus ------------

interface Harness {
	pi: { events: EventsBus };
	contributions: Array<(env: { contributions: any[] }) => void>;
	register(fn: (env: { contributions: any[] }) => void): void;
	emit(): void;
}

function createHarness(): Harness {
	const contributions: Array<(env: { contributions: any[] }) => void> = [];
	const pi = {
		events: {
			emit(channel: string, data: unknown) {
				expect(channel).toBe("subagent:discover-profiles");
				for (const fn of contributions) fn(data as any);
			},
		},
	};
	return {
		pi,
		contributions,
		register(fn) {
			contributions.push(fn);
		},
		emit() {
			pi.events.emit("subagent:discover-profiles", { contributions: [] });
		},
	};
}

// ---------------------------------------------------------------------------
// expandPath
// ---------------------------------------------------------------------------

describe("expandPath", () => {
	it("expands $PI_AGENT_DIR", () => {
		expect(expandPath("$PI_AGENT_DIR", "/base")).toBe("/mock/agent/dir");
	});

	it("expands $PI_AGENT_DIR/relative", () => {
		expect(expandPath("$PI_AGENT_DIR/subdir", "/base")).toBe(
			path.join("/mock/agent/dir", "subdir"),
		);
	});

	it("expands ~ to homedir", () => {
		expect(expandPath("~", "/base")).toBe(os.homedir());
	});

	it("expands ~/relative to homedir", () => {
		expect(expandPath("~/projects", "/base")).toBe(
			path.join(os.homedir(), "projects"),
		);
	});

	it("returns absolute paths unchanged", () => {
		expect(expandPath("/absolute/path", "/base")).toBe("/absolute/path");
	});

	it("resolves relative paths against baseDir", () => {
		expect(expandPath("relative/path", "/base")).toBe("/base/relative/path");
	});
});

// ---------------------------------------------------------------------------
// readConfiguration
// ---------------------------------------------------------------------------

describe("readConfiguration", () => {
	beforeEach(() => {
		mockReadFileSync.mockReset();
	});

	it("reads and parses valid JSON configuration", () => {
		mockReadFileSync.mockReturnValue('{"maxConcurrent": 8}');
		const result = readConfiguration("/config.json", true);
		expect(result).toEqual({ maxConcurrent: 8 });
	});

	it("throws for invalid JSON", () => {
		mockReadFileSync.mockReturnValue("not json");
		expect(() => readConfiguration("/config.json", true)).toThrow(
			"Cannot load subagent configuration",
		);
	});

	it("throws for non-object root", () => {
		mockReadFileSync.mockReturnValue("[]");
		expect(() => readConfiguration("/config.json", true)).toThrow(
			"configuration root must be an object",
		);
	});

	it("returns null for missing file when not required", () => {
		mockReadFileSync.mockImplementation(() => {
			const err = new Error("ENOENT") as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});
		expect(readConfiguration("/missing.json", false)).toBeNull();
	});

	it("throws for missing file when required", () => {
		mockReadFileSync.mockImplementation(() => {
			const err = new Error("ENOENT") as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});
		expect(() => readConfiguration("/missing.json", true)).toThrow(
			"Cannot load subagent configuration",
		);
	});
});

// ---------------------------------------------------------------------------
// normalizers
// ---------------------------------------------------------------------------

describe("normalizeModels", () => {
	it("returns empty object for undefined", () => {
		expect(normalizeModels(undefined, "field")).toEqual({});
	});
	it("normalizes valid model mapping", () => {
		expect(normalizeModels({ fast: "gpt-4o-mini" }, "field")).toEqual({
			fast: "gpt-4o-mini",
		});
	});
	it("throws for non-object", () => {
		expect(() => normalizeModels("not-object", "field")).toThrow(
			"field must be an object mapping aliases to model identifiers",
		);
	});
	it("throws for empty alias", () => {
		expect(() => normalizeModels({ "": "model" }, "field")).toThrow(
			"field must map non-empty aliases to non-empty model identifiers",
		);
	});
});

describe("normalizeToolAccess", () => {
	it("returns empty object for undefined", () => {
		expect(normalizeToolAccess(undefined)).toEqual({});
	});
	it("normalizes valid tool access mapping", () => {
		expect(normalizeToolAccess({ read: "read", bash: "shell" })).toEqual({
			read: "read",
			bash: "shell",
		});
	});
	it("throws for invalid access value", () => {
		expect(() => normalizeToolAccess({ read: "admin" })).toThrow(
			"toolAccess must map valid tool names to read, shell, or write",
		);
	});
});

describe("mergeToolAccess", () => {
	it("takes highest access level", () => {
		expect(
			mergeToolAccess({ tool1: "read" }, { tool1: "write" }, { tool1: "shell" }),
		).toEqual({ tool1: "write" });
	});
	it("combines different tools", () => {
		expect(mergeToolAccess({ read: "read" }, { edit: "write" })).toEqual({
			read: "read",
			edit: "write",
		});
	});
});

describe("normalizeWebSearchBudget", () => {
	it("treats undefined/null as 0", () => {
		expect(normalizeWebSearchBudget(undefined, "webSearchMaxLookups")).toBe(0);
		expect(normalizeWebSearchBudget(null, "webSearchMaxLookups")).toBe(0);
	});
	it("rejects negative or fractional values", () => {
		expect(() => normalizeWebSearchBudget(-1, "webSearchMaxLookups")).toThrow(
			"webSearchMaxLookups must be a non-negative integer",
		);
		expect(() => normalizeWebSearchBudget(1.5, "webSearchMaxLookups")).toThrow(
			"webSearchMaxLookups must be a non-negative integer",
		);
	});
});

// ---------------------------------------------------------------------------
// validateConfiguration
// ---------------------------------------------------------------------------

describe("validateConfiguration", () => {
	const validConfig: SubagentConfiguration = {
		models: {},
		childExtensions: [],
		toolAccess: {},
		agentDirs: [],
		loadContextFiles: true,
		defaultTimeoutSeconds: 300,
		webSearchMaxLookups: 0,
		webSearchMaxFetches: 0,
		maxConcurrent: 10,
		notificationGroupWaitSeconds: 30,
		soloPreviewCharacters: 500,
		groupPreviewCharacters: 300,
	};

	it("passes for valid configuration", () => {
		expect(() => validateConfiguration(validConfig)).not.toThrow();
	});
	it("throws for maxConcurrent out of range", () => {
		expect(() =>
			validateConfiguration({ ...validConfig, maxConcurrent: 0 }),
		).toThrow("maxConcurrent must be an integer between 1 and 64");
		expect(() =>
			validateConfiguration({ ...validConfig, maxConcurrent: 65 }),
		).toThrow("maxConcurrent must be an integer between 1 and 64");
	});
	it("throws for non-integer defaultTimeoutSeconds", () => {
		expect(() =>
			validateConfiguration({ ...validConfig, defaultTimeoutSeconds: 5 }),
		).toThrow("defaultTimeoutSeconds must be an integer between 10 and 1800");
	});
	it("throws for empty model alias", () => {
		expect(() =>
			validateConfiguration({
				...validConfig,
				models: { "": "x" } as Record<string, string>,
			}),
		).toThrow("models must map non-empty aliases");
	});
});

// ---------------------------------------------------------------------------
// loadSubagentConfiguration
// ---------------------------------------------------------------------------

function mockPackagedConfig(overrides: Record<string, unknown> = {}) {
	const bundled = {
		models: { strong: "bundled-strong", light: "bundled-light" },
		childExtensions: ["../extensions/a/index.ts"],
		toolAccess: { web_lookup: "read" },
		agentDirs: [],
		...overrides,
	};
	mockReadFileSync.mockImplementation(
		(filePath: fs.PathOrFileDescriptor) => {
			const p = String(filePath);
			if (p.endsWith("config/subagent.json")) {
				return JSON.stringify(bundled);
			}
			if (p.includes("config.json")) {
				// user/project files default to missing unless overridden below
				const err = new Error("ENOENT") as NodeJS.ErrnoException;
				err.code = "ENOENT";
				throw err;
			}
			return "";
		},
	);
	return bundled;
}

describe("loadSubagentConfiguration — packaged defaults", () => {
	beforeEach(() => {
		mockReadFileSync.mockReset();
		mockExistsSync.mockReset();
		mockStatSync.mockReset();
		mockReaddirSync.mockReset();
		mockParseFrontmatter.mockReset();
		mockGetAgentDir.mockReturnValue("/mock/agent/dir");
		mockPackagedConfig();
	});

	it("resolves packaged defaults for every scalar", () => {
		const { config, userConfigPath, subagentsDir, userAgentsDir } =
			loadSubagentConfiguration("/repo/extensions/subagent");
		expect(config.maxConcurrent).toBe(10);
		expect(config.notificationGroupWaitSeconds).toBe(30);
		expect(config.soloPreviewCharacters).toBe(500);
		expect(config.groupPreviewCharacters).toBe(300);
		expect(config.defaultTimeoutSeconds).toBe(300);
		expect(config.loadContextFiles).toBe(true);
		expect(userConfigPath).toBe(
			path.join("/mock/agent/dir", "subagent", "config.json"),
		);
		expect(subagentsDir).toBe(
			path.resolve("/repo/extensions/subagent", "subagents"),
		);
		expect(userAgentsDir).toBe(
			path.join("/mock/agent/dir", "subagent", "agents"),
		);
	});

	it("exposes user and project paths", () => {
		const { userConfigPath, projectConfigPath, projectDir } =
			loadSubagentConfiguration("/repo/extensions/subagent");
		expect(userConfigPath).toBe(
			path.join("/mock/agent/dir", "subagent", "config.json"),
		);
		expect(projectConfigPath).toBeNull();
		expect(projectDir).toBeNull();
	});
});

describe("loadSubagentConfiguration — layered precedence", () => {
	beforeEach(() => {
		mockReadFileSync.mockReset();
		mockExistsSync.mockReset();
		mockStatSync.mockReset();
		mockReaddirSync.mockReset();
		mockParseFrontmatter.mockReset();
		mockGetAgentDir.mockReturnValue("/mock/agent/dir");
	});

	it("user overrides packaged scalars", () => {
		mockPackagedConfig();
		mockReadFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
			const p = String(filePath);
			if (p.endsWith("config/subagent.json")) return JSON.stringify({ maxConcurrent: 7 });
			if (p.includes("/mock/agent/dir/subagent/config.json"))
				return JSON.stringify({ maxConcurrent: 9, soloPreviewCharacters: 420 });
			const err = new Error("ENOENT") as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});

		const { config } = loadSubagentConfiguration("/repo/extensions/subagent");
		expect(config.maxConcurrent).toBe(9);
		expect(config.soloPreviewCharacters).toBe(420);
		// Unpackaged scalar keeps its packaged default.
		expect(config.groupPreviewCharacters).toBe(300);
	});

	it("trusted project overrides user", () => {
		mockReadFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
			const p = String(filePath);
			if (p.endsWith("config/subagent.json"))
				return JSON.stringify({ maxConcurrent: 7 });
			if (p.includes("/mock/agent/dir/subagent/config.json"))
				return JSON.stringify({ maxConcurrent: 9 });
			if (p.includes("/.pi/subagent/config.json"))
				return JSON.stringify({ maxConcurrent: 12, soloPreviewCharacters: 777 });
			const err = new Error("ENOENT") as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});

		const { config, projectConfigPath } =
			loadSubagentConfiguration("/repo/extensions/subagent", {
				projectRoot: "/mock/project",
				projectTrusted: true,
			});
		expect(projectConfigPath).toBe(
			path.join("/mock/project", ".pi", "subagent", "config.json"),
		);
		expect(config.maxConcurrent).toBe(12);
		expect(config.soloPreviewCharacters).toBe(777);
	});

	it("ignores the project layer when the project is untrusted", () => {
		let readProjectConfig = false;
		mockReadFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
			const p = String(filePath);
			if (p.includes("/.pi/subagent/config.json")) {
				readProjectConfig = true;
				return "{}";
			}
			if (p.endsWith("config/subagent.json"))
				return JSON.stringify({ maxConcurrent: 7 });
			const err = new Error("ENOENT") as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});

		const { config, projectConfigPath } =
			loadSubagentConfiguration("/repo/extensions/subagent", {
				projectRoot: "/mock/project",
				projectTrusted: false,
			});
		expect(readProjectConfig).toBe(false);
		expect(projectConfigPath).toBeNull();
		expect(config.maxConcurrent).toBe(7);
	});

	it("merges models per key across layers", () => {
		mockReadFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
			const p = String(filePath);
			if (p.endsWith("config/subagent.json"))
				return JSON.stringify({ models: { strong: "bundled-strong" } });
			if (p.includes("/mock/agent/dir/subagent/config.json"))
				return JSON.stringify({ models: { light: "user-light" } });
			if (p.includes("/.pi/subagent/config.json"))
				return JSON.stringify({ models: { strong: "project-strong" } });
			const err = new Error("ENOENT") as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});

		const { config } = loadSubagentConfiguration("/repo/extensions/subagent", {
			projectRoot: "/mock/project",
			projectTrusted: true,
		});
		expect(config.models).toEqual({
			strong: "project-strong",
			light: "user-light",
		});
	});

	it("replaces childExtensions with the highest layer that specifies them", () => {
		mockReadFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
			const p = String(filePath);
			if (p.endsWith("config/subagent.json"))
				return JSON.stringify({ childExtensions: ["a"] });
			if (p.includes("/mock/agent/dir/subagent/config.json"))
				return JSON.stringify({ childExtensions: ["b"] });
			if (p.includes("/.pi/subagent/config.json"))
				return JSON.stringify({ childExtensions: ["c"] });
			const err = new Error("ENOENT") as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});

		const { config } = loadSubagentConfiguration("/repo/extensions/subagent", {
			projectRoot: "/mock/project",
			projectTrusted: true,
		});
		// Highest layer that specifies childExtensions wins, resolved to absolute.
		expect(config.childExtensions).toEqual([
			path.resolve("/mock/project/.pi/subagent", "c"),
		]);
	});

	it("keeps packaged childExtensions when user and project omit them", () => {
		mockReadFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
			const p = String(filePath);
			if (p.endsWith("config/subagent.json"))
				return JSON.stringify({ childExtensions: ["bundled"] });
			if (p.includes("/mock/agent/dir/subagent/config.json")) return "{}";
			if (p.includes("/.pi/subagent/config.json")) return "{}";
			const err = new Error("ENOENT") as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});

		const { config } = loadSubagentConfiguration("/repo/extensions/subagent", {
			projectRoot: "/mock/project",
			projectTrusted: true,
		});
		expect(config.childExtensions).toEqual([
			path.resolve("/repo/config", "bundled"),
		]);
	});

	it("merges toolAccess per key with highest access, seeded by built-ins", () => {
		mockReadFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
			const p = String(filePath);
			if (p.endsWith("config/subagent.json"))
				return JSON.stringify({ toolAccess: { web_lookup: "read" } });
			if (p.includes("/mock/agent/dir/subagent/config.json"))
				return JSON.stringify({ toolAccess: { edit: "read" } });
			if (p.includes("/.pi/subagent/config.json"))
				return JSON.stringify({ toolAccess: { edit: "write" } });
			const err = new Error("ENOENT") as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});

		const { config } = loadSubagentConfiguration("/repo/extensions/subagent", {
			projectRoot: "/mock/project",
			projectTrusted: true,
		});
		// built-in `edit: write` plus user read plus project write → write
		expect(config.toolAccess.edit).toBe("write");
		expect(config.toolAccess.web_lookup).toBe("read");
	});

	it("concatenates agentDirs across layers, each canonicalized to its own base", () => {
		mockReadFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
			const p = String(filePath);
			if (p.endsWith("config/subagent.json"))
				return JSON.stringify({ agentDirs: ["packaged-dir"] });
			if (p.includes("/mock/agent/dir/subagent/config.json"))
				return JSON.stringify({ agentDirs: ["./user-dir"] });
			if (p.includes("/.pi/subagent/config.json"))
				return JSON.stringify({ agentDirs: ["/abs/project-dir"] });
			const err = new Error("ENOENT") as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});

		const { config } = loadSubagentConfiguration("/repo/extensions/subagent", {
			projectRoot: "/mock/project",
			projectTrusted: true,
		});
		// package config dir is /repo/config; user base is /mock/agent/dir/subagent
		expect(config.agentDirs).toEqual([
			path.resolve("/repo/config", "packaged-dir"),
			path.join("/mock/agent/dir", "subagent", "user-dir"),
			"/abs/project-dir",
		]);
	});

	it("canonicalizes relative childExtensions against the supplying layer", () => {
		mockReadFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
			const p = String(filePath);
			if (p.endsWith("config/subagent.json"))
				return JSON.stringify({ childExtensions: ["../a"] });
			if (p.includes("/mock/agent/dir/subagent/config.json"))
				return JSON.stringify({ childExtensions: ["./b"] });
			if (p.includes("/.pi/subagent/config.json"))
				return JSON.stringify({ childExtensions: ["c"] });
			const err = new Error("ENOENT") as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});

		const { config } = loadSubagentConfiguration("/repo/extensions/subagent", {
			projectRoot: "/mock/project",
			projectTrusted: true,
		});
		// project specifies childExtensions → it alone wins, relative to project config dir
		expect(config.childExtensions).toEqual([
			path.resolve("/mock/project/.pi/subagent", "c"),
		]);
	});
});

describe("loadSubagentConfiguration — fail closed", () => {
	beforeEach(() => {
		mockReadFileSync.mockReset();
		mockExistsSync.mockReset();
		mockStatSync.mockReset();
		mockReaddirSync.mockReset();
		mockParseFrontmatter.mockReset();
		mockGetAgentDir.mockReturnValue("/mock/agent/dir");
	});

	it("throws on a malformed packaged layer", () => {
		mockReadFileSync.mockReturnValue("not json");
		expect(() => loadSubagentConfiguration("/repo/extensions/subagent")).toThrow(
			"Cannot load subagent configuration",
		);
	});

	it("throws on a malformed user layer", () => {
		mockReadFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
			const p = String(filePath);
			if (p.endsWith("config/subagent.json")) return "{}";
			if (p.includes("/mock/agent/dir/subagent/config.json")) return "not json";
			const err = new Error("ENOENT") as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});
		expect(() => loadSubagentConfiguration("/repo/extensions/subagent")).toThrow(
			"Cannot load subagent configuration",
		);
	});

	it("throws for a non-integer maxConcurrent in a layer", () => {
		mockReadFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
			const p = String(filePath);
			if (p.endsWith("config/subagent.json"))
				return JSON.stringify({ maxConcurrent: 3.5 });
			const err = new Error("ENOENT") as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});
		expect(() => loadSubagentConfiguration("/repo/extensions/subagent")).toThrow(
			"maxConcurrent must be an integer",
		);
	});

	it("throws for an invalid toolAccess value", () => {
		mockReadFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
			const p = String(filePath);
			if (p.endsWith("config/subagent.json"))
				return JSON.stringify({ toolAccess: { read: "admin" } });
			const err = new Error("ENOENT") as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});
		expect(() => loadSubagentConfiguration("/repo/extensions/subagent")).toThrow(
			"toolAccess must map valid tool names",
		);
	});

	it("throws for a malformed path in agentDirs", () => {
		mockReadFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
			const p = String(filePath);
			if (p.endsWith("config/subagent.json"))
				return JSON.stringify({ agentDirs: ["ok", ""] });
			const err = new Error("ENOENT") as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});
		expect(() => loadSubagentConfiguration("/repo/extensions/subagent")).toThrow(
			"agentDirs must be an array of non-empty paths",
		);
	});
});

// ---------------------------------------------------------------------------
// loadGenericProfilesFromDir
// ---------------------------------------------------------------------------

describe("loadGenericProfilesFromDir", () => {
	beforeEach(() => {
		mockExistsSync.mockReset();
		mockStatSync.mockReset();
		mockReaddirSync.mockReset();
		mockReadFileSync.mockReset();
		mockParseFrontmatter.mockReset();
	});

	it("returns [] for a missing directory", () => {
		mockExistsSync.mockReturnValue(false);
		expect(loadGenericProfilesFromDir("/nope", "bundled", {}, {}, 300)).toEqual([]);
	});

	it("throws for a non-directory path", () => {
		mockExistsSync.mockReturnValue(true);
		mockStatSync.mockReturnValue({ isDirectory: () => false } as fs.Stats);
		expect(() =>
			loadGenericProfilesFromDir("/file", "bundled", {}, {}, 300),
		).toThrow("subagent profile path is not a directory");
	});

	it("loads a valid profile from markdown", () => {
		mockExistsSync.mockReturnValue(true);
		mockStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
		mockReaddirSync.mockReturnValue([mockDirent("worker.md")]);
		mockReadFileSync.mockReturnValue(
			"---\nname: worker\ndescription: A worker agent\nmodel: strong\ntools: read,edit\n---\n\nYou are a worker.",
		);
		mockParseFrontmatter.mockReturnValue({
			frontmatter: {
				name: "worker",
				description: "A worker agent",
				model: "strong",
				tools: "read,edit",
			},
			body: "You are a worker.",
		});

		const result = loadGenericProfilesFromDir(
			"/agents",
			"bundled",
			{ strong: "qwen-strong" },
			{ read: "read", edit: "write" },
			300,
		);
		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			name: "worker",
			model: "qwen-strong",
			access: "write", // edit requires write
			source: "bundled",
		});
	});

	it("defaults access to the tools' minimum requirement", () => {
		mockExistsSync.mockReturnValue(true);
		mockStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
		mockReaddirSync.mockReturnValue([mockDirent("worker.md")]);
		mockReadFileSync.mockReturnValue(
			"---\nname: worker\ndescription: Test\nmodel: gpt\ntools: read\n---\n\nPrompt.",
		);
		mockParseFrontmatter.mockReturnValue({
			frontmatter: {
				name: "worker",
				description: "Test",
				model: "gpt",
				tools: "read",
			},
			body: "Prompt.",
		});
		const result = loadGenericProfilesFromDir(
			"/agents",
			"bundled",
			{},
			{ read: "read" },
			300,
		);
		expect(result[0].access).toBe("read");
	});

	it("throws when declared access is below the tools' minimum", () => {
		mockExistsSync.mockReturnValue(true);
		mockStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
		mockReaddirSync.mockReturnValue([mockDirent("worker.md")]);
		mockReadFileSync.mockReturnValue(
			"---\nname: worker\ndescription: Test\nmodel: gpt\ntools: edit\naccess: read\n---\n\nPrompt.",
		);
		mockParseFrontmatter.mockReturnValue({
			frontmatter: {
				name: "worker",
				description: "Test",
				model: "gpt",
				tools: "edit",
				access: "read",
			},
			body: "Prompt.",
		});
		expect(() =>
			loadGenericProfilesFromDir("/agents", "bundled", {}, { edit: "write" }, 300),
		).toThrow("declares access read, but tools require at least write");
	});

	it("treats an unknown model setting as a concrete model name", () => {
		mockExistsSync.mockReturnValue(true);
		mockStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
		mockReaddirSync.mockReturnValue([mockDirent("worker.md")]);
		mockReadFileSync.mockReturnValue(
			"---\nname: worker\ndescription: Test\nmodel: nope\ntools: read\n---\n\nPrompt.",
		);
		mockParseFrontmatter.mockReturnValue({
			frontmatter: {
				name: "worker",
				description: "Test",
				model: "nope",
				tools: "read",
			},
			body: "Prompt.",
		});
		const result = loadGenericProfilesFromDir(
			"/agents",
			"bundled",
			{},
			{ read: "read" },
			300,
		);
		expect(result[0].model).toBe("nope");
	});

	it("throws for unavailable child tools", () => {
		mockExistsSync.mockReturnValue(true);
		mockStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
		mockReaddirSync.mockReturnValue([mockDirent("worker.md")]);
		mockReadFileSync.mockReturnValue(
			"---\nname: worker\ndescription: Test\nmodel: gpt\ntools: nope\n---\n\nPrompt.",
		);
		mockParseFrontmatter.mockReturnValue({
			frontmatter: {
				name: "worker",
				description: "Test",
				model: "gpt",
				tools: "nope",
			},
			body: "Prompt.",
		});
		expect(() =>
			loadGenericProfilesFromDir("/agents", "bundled", {}, { read: "read" }, 300),
		).toThrow("unavailable child tools: nope");
	});

	it("throws on duplicate profile names in a directory", () => {
		mockExistsSync.mockReturnValue(true);
		mockStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
		mockReaddirSync.mockReturnValue([mockDirent("a.md"), mockDirent("b.md")]);
		mockReadFileSync.mockReturnValue(
			"---\nname: dup\ndescription: Test\nmodel: gpt\ntools: read\n---\n\nPrompt.",
		);
		mockParseFrontmatter.mockReturnValue({
			frontmatter: {
				name: "dup",
				description: "Test",
				model: "gpt",
				tools: "read",
			},
			body: "Prompt.",
		});
		expect(() =>
			loadGenericProfilesFromDir("/agents", "bundled", {}, { read: "read" }, 300),
		).toThrow('Duplicate subagent profile "dup"');
	});
});

// ---------------------------------------------------------------------------
// discoverProfiles
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: SubagentConfiguration = {
	models: {},
	childExtensions: [],
	toolAccess: { read: "read", edit: "write", grep: "read" },
	agentDirs: [],
	loadContextFiles: true,
	defaultTimeoutSeconds: 300,
	webSearchMaxLookups: 0,
	webSearchMaxFetches: 0,
	maxConcurrent: 10,
	notificationGroupWaitSeconds: 30,
	soloPreviewCharacters: 500,
	groupPreviewCharacters: 300,
};

function makeLoaded(
	overrides: {
		config?: Partial<SubagentConfiguration>;
	} & Omit<Partial<LoadedSubagentConfiguration>, "config"> = {},
): LoadedSubagentConfiguration {
	const { config: _configOverride, ...rest } = overrides;
	return {
		config: { ...DEFAULT_CONFIG, ...(overrides.config ?? {}) },
		subagentDir: "/repo/extensions/subagent",
		subagentsDir: "/repo/extensions/subagent/subagents",
		userDir: "/mock/agent/dir/subagent",
		userAgentsDir: "/mock/agent/dir/subagent/agents",
		userConfigPath: "/mock/agent/dir/subagent/config.json",
		projectDir: null,
		projectConfigPath: null,
		...rest,
	} as LoadedSubagentConfiguration;
}

const CONTEXT = { cwd: "/mock/project", projectTrusted: true };

describe("discoverProfiles", () => {
	beforeEach(() => {
		mockExistsSync.mockReset();
		mockStatSync.mockReset();
		mockReaddirSync.mockReset();
		mockReadFileSync.mockReset();
		mockParseFrontmatter.mockReset();
		mockExistsSync.mockReturnValue(false);
	});

	it("collects external contributions through the events bus", () => {
		const h = createHarness();
		h.register((env) => {
			env.contributions.push({
				owner: "research",
				profile: {
					name: "scout",
					description: "Research scout",
					model: "strong",
					thinking: "high",
					tools: ["read"],
					access: "read",
					timeoutSeconds: 300,
					systemPrompt: "scout",
					source: "research",
				},
			});
		});

		const result = discoverProfiles(h.pi, makeLoaded(), CONTEXT);
		expect(result.profiles.map((p) => p.name)).toEqual(["scout"]);
		expect(result.contributions).toHaveLength(1);
		expect(result.contributions[0].owner).toBe("research");
	});

	it("is idempotent and deduplicates owner + name across repeats", () => {
		const h = createHarness();
		const contribution = {
			owner: "research",
			profile: {
				name: "scout",
				description: "Research scout",
				model: "strong",
				thinking: "high",
				tools: ["read"],
				access: "read",
				timeoutSeconds: 300,
				systemPrompt: "scout",
				source: "research",
			},
		};
		// Two listeners (e.g. two discovery passes) contribute the same owner+name.
		h.register((env) => env.contributions.push(contribution));
		h.register((env) => env.contributions.push(contribution));

		const result = discoverProfiles(h.pi, makeLoaded(), CONTEXT);
		expect(result.profiles.filter((p) => p.name === "scout")).toHaveLength(1);
		expect(result.contributions).toHaveLength(1);
	});

	it("is load-order independent for distinct owners", () => {
		const mk = (owner: string, name: string) => ({
			owner,
			profile: {
				name,
				description: name,
				model: "strong",
				thinking: "high",
				tools: ["read"],
				access: "read",
				timeoutSeconds: 300,
				systemPrompt: name,
				source: owner,
			},
		});
		const orderA = createHarness();
		orderA.register((env) =>
			env.contributions.push(mk("research", "scout"), mk("meta", "mapper")),
		);
		const a = discoverProfiles(orderA.pi, makeLoaded(), CONTEXT);

		const orderB = createHarness();
		orderB.register((env) =>
			env.contributions.push(mk("meta", "mapper"), mk("research", "scout")),
		);
		const b = discoverProfiles(orderB.pi, makeLoaded(), CONTEXT);

		expect(
			a.profiles.map((p) => `${p.source}:${p.name}`).sort(),
		).toEqual(b.profiles.map((p) => `${p.source}:${p.name}`).sort());
	});

	it("fails closed when two owners claim the same reserved name", () => {
		const h = createHarness();
		const mk = (owner: string) => ({
			owner,
			profile: {
				name: "scout",
				description: "scout",
				model: "strong",
				thinking: "high",
				tools: ["read"],
				access: "read",
				timeoutSeconds: 300,
				systemPrompt: "scout",
				source: owner,
			},
		});
		h.register((env) => env.contributions.push(mk("research")));
		h.register((env) => env.contributions.push(mk("meta")));

		expect(() => discoverProfiles(h.pi, makeLoaded(), CONTEXT)).toThrow(
			"claimed by conflicting owners",
		);
	});

	it("fails closed when an external owner reclaims a generic profile name", () => {
		// Generic .md profile owns "worker".
		mockExistsSync.mockImplementation((p: fs.PathLike) =>
			String(p).includes("/subagents"),
		);
		mockStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
		mockReaddirSync.mockReturnValue([mockDirent("worker.md")]);
		mockReadFileSync.mockReturnValue(
			"---\nname: worker\ndescription: A worker agent\nmodel: gpt\ntools: read\n---\n\nYou are a worker.",
		);
		mockParseFrontmatter.mockReturnValue({
			frontmatter: {
				name: "worker",
				description: "A worker agent",
				model: "gpt",
				tools: "read",
			},
			body: "You are a worker.",
		});

		const h = createHarness();
		h.register((env) =>
			env.contributions.push({
				owner: "research",
				profile: {
					name: "worker",
					description: "research worker",
					model: "strong",
					thinking: "high",
					tools: ["read"],
					access: "read",
					timeoutSeconds: 300,
					systemPrompt: "scout",
					source: "research",
				},
			}),
		);

		expect(() => discoverProfiles(h.pi, makeLoaded(), CONTEXT)).toThrow(
			"claimed by conflicting owners",
		);
	});

	it("merges generic .md profiles with non-colliding external profiles", () => {
		mockExistsSync.mockImplementation((p: fs.PathLike) =>
			String(p).endsWith("/subagents"),
		);
		mockStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
		mockReaddirSync.mockReturnValue([mockDirent("worker.md")]);
		mockReadFileSync.mockReturnValue(
			"---\nname: worker\ndescription: A worker agent\nmodel: gpt\ntools: read\n---\n\nYou are a worker.",
		);
		mockParseFrontmatter.mockReturnValue({
			frontmatter: {
				name: "worker",
				description: "A worker agent",
				model: "gpt",
				tools: "read",
			},
			body: "You are a worker.",
		});

		const h = createHarness();
		h.register((env) =>
			env.contributions.push({
				owner: "research",
				profile: {
					name: "scout",
					description: "scout",
					model: "strong",
					thinking: "high",
					tools: ["read"],
					access: "read",
					timeoutSeconds: 300,
					systemPrompt: "scout",
					source: "research",
				},
			}),
		);

		const result = discoverProfiles(h.pi, makeLoaded(), CONTEXT);
		const names = result.profiles.map((p) => p.name).sort();
		expect(names).toEqual(["scout", "worker"]);
		const worker = result.profiles.find((p) => p.name === "worker")!;
		expect(worker.source).toBe("bundled");
	});

	it("loads custom profiles from configured agentDirs", () => {
		const agentDir = "/custom/agents";
		mockExistsSync.mockImplementation((p: fs.PathLike) =>
			String(p) === agentDir,
		);
		mockStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
		mockReaddirSync.mockReturnValue([mockDirent("custom.md")]);
		mockReadFileSync.mockReturnValue(
			"---\nname: custom\ndescription: Custom\ntools: read\n---\n\nYou are custom.",
		);
		mockParseFrontmatter.mockReturnValue({
			frontmatter: {
				name: "custom",
				description: "Custom",
				model: "light",
				tools: "read",
			},
			body: "You are custom.",
		});

		const loaded = makeLoaded({
			config: { agentDirs: [agentDir], models: { light: "qwen-light" } },
		});
		const result = discoverProfiles(
			harnessForNoExternal().pi,
			loaded,
			CONTEXT,
		);
		expect(result.profiles.map((p) => p.name)).toEqual(["custom"]);
		expect(result.profiles[0].source).toBe("custom");
	});

	// --- timeout snapshot integrity (Fix Round 1) ---------------------------

	function mockGenericWorker() {
		mockExistsSync.mockImplementation((p: fs.PathLike) =>
			String(p).includes("/subagents"),
		);
		mockStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
		mockReaddirSync.mockReturnValue([mockDirent("worker.md")]);
		mockReadFileSync.mockReturnValue(
			"---\nname: worker\ndescription: A worker agent\nmodel: gpt\ntools: read\n---\n\nYou are a worker.",
		);
		mockParseFrontmatter.mockReturnValue({
			frontmatter: {
				name: "worker",
				description: "A worker agent",
				model: "gpt",
				tools: "read",
			},
			body: "You are a worker.",
		});
	}

	it("resolves an omitted generic timeoutSeconds against the loaded config default", () => {
		mockGenericWorker();

		const loaded = makeLoaded({ config: { defaultTimeoutSeconds: 420 } });
		const h = createHarness();
		const result = discoverProfiles(h.pi, loaded, CONTEXT);
		const worker = result.profiles.find((p) => p.name === "worker")!;
		// Concrete now — never null — captured from THIS discovery call's config.
		expect(worker.timeoutSeconds).toBe(420);
	});

	it("does not mutate an already-discovered generic profile when the config default changes", () => {
		mockGenericWorker();

		const loaded = makeLoaded({ config: { defaultTimeoutSeconds: 420 } });
		const h = createHarness();
		const first = discoverProfiles(h.pi, loaded, CONTEXT);
		// A later edit to the loaded config must not retro-mutate the snapshot.
		loaded.config.defaultTimeoutSeconds = 1200;
		const second = discoverProfiles(h.pi, loaded, CONTEXT);

		expect(first.profiles[0].timeoutSeconds).toBe(420);
		expect(second.profiles[0].timeoutSeconds).toBe(1200);
	});

	it("fails closed on an external contribution whose timeoutSeconds is null", () => {
		const h = createHarness();
		h.register((env) =>
		env.contributions.push({
			owner: "research",
			profile: {
				name: "scout",
				description: "scout",
				model: "strong",
				thinking: "high",
				tools: ["read"],
				access: "read",
				timeoutSeconds: null,
				systemPrompt: "scout",
				source: "research",
			},
		}),
	);
	expect(() => discoverProfiles(h.pi, makeLoaded(), CONTEXT)).toThrow(
		/timeoutSeconds must be an integer/
	);
});
});

function harnessForNoExternal() {
	const h = createHarness();
	return h;
}
