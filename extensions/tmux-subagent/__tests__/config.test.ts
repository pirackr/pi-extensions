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
	normalizeWebSearchBudget,
	normalizeToolAccess,
	mergeToolAccess,
	validateConfiguration,
	requiredAccess,
	loadProfilesFromDir,
	loadSubagentConfiguration,
	loadResearchProfiles,
	type AgentAccess,
	type SubagentConfiguration,
} from "../config.ts";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

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
		isBlockDevice: () => false,
		isCharacterDevice: () => false,
		isFIFO: () => false,
		isSocket: () => false,
		parentPath: "/mock",
		path: "/mock",
	};
}

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

describe("readConfiguration", () => {
	beforeEach(() => {
		mockReadFileSync.mockReset();
	});

	it("reads and parses valid JSON configuration", () => {
		mockReadFileSync.mockReturnValue('{"maxTasks": 8}');
		const result = readConfiguration("/config.json", true);
		expect(result).toEqual({ maxTasks: 8 });
	});

	it("throws for invalid JSON", () => {
		mockReadFileSync.mockReturnValue("not json");
		expect(() => readConfiguration("/config.json", true)).toThrow(
			"Cannot load tmux-subagent configuration",
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
		const result = readConfiguration("/missing.json", false);
		expect(result).toBeNull();
	});

	it("throws for missing file when required", () => {
		mockReadFileSync.mockImplementation(() => {
			const err = new Error("ENOENT") as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});
		expect(() => readConfiguration("/missing.json", true)).toThrow(
			"Cannot load tmux-subagent configuration",
		);
	});
});

describe("normalizePaths", () => {
	it("returns empty array for undefined", () => {
		expect(normalizePaths(undefined, "/base", "field")).toEqual([]);
	});

	it("expands and normalizes paths", () => {
		const result = normalizePaths(["./a", "~/b", "/c"], "/base", "field");
		expect(result).toEqual(["/base/a", path.join(os.homedir(), "b"), "/c"]);
	});

	it("throws for non-array", () => {
		expect(() => normalizePaths("not-array", "/base", "field")).toThrow(
			"field must be an array of non-empty paths",
		);
	});

	it("throws for empty strings in array", () => {
		expect(() => normalizePaths(["valid", ""], "/base", "field")).toThrow(
			"field must be an array of non-empty paths",
		);
	});

	it("throws for non-string elements", () => {
		expect(() => normalizePaths(["valid", 123], "/base", "field")).toThrow(
			"field must be an array of non-empty paths",
		);
	});
});

describe("normalizeModels", () => {
	it("returns empty object for undefined", () => {
		expect(normalizeModels(undefined, "field")).toEqual({});
	});

	it("normalizes valid model mapping", () => {
		const result = normalizeModels(
			{ fast: "gpt-4o-mini", slow: "gpt-4o" },
			"field",
		);
		expect(result).toEqual({ fast: "gpt-4o-mini", slow: "gpt-4o" });
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

	it("throws for empty model identifier", () => {
		expect(() => normalizeModels({ alias: "" }, "field")).toThrow(
			"field must map non-empty aliases to non-empty model identifiers",
		);
	});

	it("throws for non-string model", () => {
		expect(() => normalizeModels({ alias: 123 }, "field")).toThrow(
			"field must map non-empty aliases to non-empty model identifiers",
		);
	});
});

describe("normalizeToolAccess", () => {
	it("returns empty object for undefined", () => {
		expect(normalizeToolAccess(undefined)).toEqual({});
	});

	it("normalizes valid tool access mapping", () => {
		const result = normalizeToolAccess({
			read: "read",
			bash: "shell",
			edit: "write",
		});
		expect(result).toEqual({ read: "read", bash: "shell", edit: "write" });
	});

	it("throws for non-object", () => {
		expect(() => normalizeToolAccess("not-object")).toThrow(
			"toolAccess must map tool names to read, shell, or write",
		);
	});

	it("throws for invalid tool name", () => {
		expect(() => normalizeToolAccess({ "!invalid": "read" })).toThrow(
			"toolAccess must map valid tool names to read, shell, or write",
		);
	});

	it("throws for invalid access value", () => {
		expect(() => normalizeToolAccess({ read: "admin" })).toThrow(
			"toolAccess must map valid tool names to read, shell, or write",
		);
	});
});

describe("mergeToolAccess", () => {
	it("merges multiple sources", () => {
		const result = mergeToolAccess(
			{ read: "read", bash: "shell" },
			{ bash: "write" },
		);
		expect(result).toEqual({ read: "read", bash: "write" });
	});

	it("takes highest access level", () => {
		const result = mergeToolAccess(
			{ tool1: "read" },
			{ tool1: "write" },
			{ tool1: "shell" },
		);
		expect(result).toEqual({ tool1: "write" });
	});

	it("combines different tools", () => {
		const result = mergeToolAccess({ read: "read" }, { edit: "write" });
		expect(result).toEqual({ read: "read", edit: "write" });
	});
});

describe("validateConfiguration", () => {
	const validConfig: SubagentConfiguration = {
		models: {},
		childExtensions: [],
		toolAccess: {},
		agentDirs: [],
		loadContextFiles: true,
		maxTasks: 4,
		defaultTimeoutSeconds: 300,
		retainArtifacts: "on_failure",
		webSearchMaxLookups: 0,
		webSearchMaxFetches: 0,
	};

	it("passes for valid configuration", () => {
		expect(() => validateConfiguration(validConfig)).not.toThrow();
	});

	it("throws for maxTasks < 1", () => {
		expect(() =>
			validateConfiguration({ ...validConfig, maxTasks: 0 }),
		).toThrow("maxTasks must be an integer between 1 and 16");
	});

	it("throws for maxTasks > 16", () => {
		expect(() =>
			validateConfiguration({ ...validConfig, maxTasks: 17 }),
		).toThrow("maxTasks must be an integer between 1 and 16");
	});

	it("throws for non-integer maxTasks", () => {
		expect(() =>
			validateConfiguration({ ...validConfig, maxTasks: 3.5 }),
		).toThrow("maxTasks must be an integer between 1 and 16");
	});

	it("throws for defaultTimeoutSeconds < 10", () => {
		expect(() =>
			validateConfiguration({ ...validConfig, defaultTimeoutSeconds: 5 }),
		).toThrow("defaultTimeoutSeconds must be an integer between 10 and 1800");
	});

	it("throws for defaultTimeoutSeconds > 1800", () => {
		expect(() =>
			validateConfiguration({ ...validConfig, defaultTimeoutSeconds: 2000 }),
		).toThrow("defaultTimeoutSeconds must be an integer between 10 and 1800");
	});

	it("throws for invalid retainArtifacts", () => {
		expect(() =>
			validateConfiguration({
				...validConfig,
				retainArtifacts: "sometimes" as never,
			}),
		).toThrow('retainArtifacts must be "never", "on_failure", or "always"');
	});

	it("throws for non-boolean loadContextFiles", () => {
		expect(() =>
			validateConfiguration({
				...validConfig,
				loadContextFiles: "yes" as never,
			}),
		).toThrow("loadContextFiles must be a boolean");
	});

	it("normalizes webSearchMaxLookups from config", () => {
		expect(normalizeWebSearchBudget(10, "webSearchMaxLookups")).toBe(10);
		expect(normalizeWebSearchBudget(undefined, "webSearchMaxLookups")).toBe(0);
		expect(normalizeWebSearchBudget(null, "webSearchMaxLookups")).toBe(0);
		expect(normalizeWebSearchBudget(0, "webSearchMaxLookups")).toBe(0);
	});

	it("rejects negative or fractional webSearchMaxLookups", () => {
		expect(() => normalizeWebSearchBudget(-1, "webSearchMaxLookups")).toThrow(
			"webSearchMaxLookups must be a non-negative integer",
		);
		expect(() => normalizeWebSearchBudget(1.5, "webSearchMaxLookups")).toThrow(
			"webSearchMaxLookups must be a non-negative integer",
		);
		expect(() => normalizeWebSearchBudget("10", "webSearchMaxLookups")).toThrow(
			"webSearchMaxLookups must be a non-negative integer",
		);
	});
});

describe("requiredAccess", () => {
	const toolAccess: Record<string, AgentAccess> = {
		read: "read",
		grep: "read",
		bash: "shell",
		edit: "write",
	};

	it("returns read for read-only tools", () => {
		expect(requiredAccess(["read", "grep"], toolAccess)).toBe("read");
	});

	it("returns shell for shell tools", () => {
		expect(requiredAccess(["read", "bash"], toolAccess)).toBe("shell");
	});

	it("returns write for write tools", () => {
		expect(requiredAccess(["read", "edit"], toolAccess)).toBe("write");
	});

	it("returns highest required access", () => {
		expect(requiredAccess(["read", "bash", "edit"], toolAccess)).toBe("write");
	});

	it("defaults to read for unknown tools", () => {
		expect(requiredAccess(["unknown"], toolAccess)).toBe("read");
	});
});

describe("loadProfilesFromDir", () => {
	beforeEach(() => {
		mockReaddirSync.mockReset();
		mockReadFileSync.mockReset();
		mockExistsSync.mockReset();
		mockStatSync.mockReset();
		mockParseFrontmatter.mockReset();
	});

	it("returns empty array for non-existent directory", () => {
		mockExistsSync.mockReturnValue(false);
		const result = loadProfilesFromDir("/nonexistent", "bundled", {}, {});
		expect(result).toEqual([]);
	});

	it("throws for non-directory path", () => {
		mockExistsSync.mockReturnValue(true);
		mockStatSync.mockReturnValue({ isDirectory: () => false } as fs.Stats);
		expect(() => loadProfilesFromDir("/file.md", "bundled", {}, {})).toThrow(
			"Agent profile path is not a directory",
		);
	});

	it("loads valid profile from markdown file", () => {
		mockExistsSync.mockReturnValue(true);
		mockStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
		mockReaddirSync.mockReturnValue([mockDirent("worker.md")]);
		mockReadFileSync.mockReturnValue(
			"---\nname: worker\ndescription: A worker agent\nmodel: gpt-4o\ntools: read,edit\n---\n\nYou are a worker.",
		);
		mockParseFrontmatter.mockReturnValue({
			frontmatter: {
				name: "worker",
				description: "A worker agent",
				model: "gpt-4o",
				tools: "read,edit",
			},
			body: "You are a worker.",
		});

		const result = loadProfilesFromDir(
			"/agents",
			"bundled",
			{},
			{
				read: "read",
				edit: "write",
			},
		);

		expect(result).toHaveLength(1);
		expect(result[0]).toMatchObject({
			name: "worker",
			description: "A worker agent",
			model: "gpt-4o",
			tools: ["read", "edit"],
			access: "write",
			source: "bundled",
		});
	});

	it("resolves model aliases", () => {
		mockExistsSync.mockReturnValue(true);
		mockStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
		mockReaddirSync.mockReturnValue([mockDirent("agent.md")]);
		mockReadFileSync.mockReturnValue(
			"---\nname: agent\ndescription: Test\nmodel: fast\ntools: read\n---\n\nPrompt.",
		);
		mockParseFrontmatter.mockReturnValue({
			frontmatter: {
				name: "agent",
				description: "Test",
				model: "fast",
				tools: "read",
			},
			body: "Prompt.",
		});

		const result = loadProfilesFromDir(
			"/agents",
			"bundled",
			{ fast: "gpt-4o-mini" },
			{ read: "read" },
		);
		expect(result[0].model).toBe("gpt-4o-mini");
	});

	it("throws for missing required frontmatter fields", () => {
		mockExistsSync.mockReturnValue(true);
		mockStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
		mockReaddirSync.mockReturnValue([mockDirent("bad.md")]);
		mockReadFileSync.mockReturnValue("---\nname: bad\n---\n\nNo description.");
		mockParseFrontmatter.mockReturnValue({
			frontmatter: { name: "bad" },
			body: "No description.",
		});

		expect(() => loadProfilesFromDir("/agents", "bundled", {}, {})).toThrow(
			"requires name, description, model, tools, and a prompt body",
		);
	});

	it("throws for invalid thinking level", () => {
		mockExistsSync.mockReturnValue(true);
		mockStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
		mockReaddirSync.mockReturnValue([mockDirent("agent.md")]);
		mockReadFileSync.mockReturnValue(
			"---\nname: agent\ndescription: Test\nmodel: gpt-4o\ntools: read\nthinking: invalid\n---\n\nPrompt.",
		);
		mockParseFrontmatter.mockReturnValue({
			frontmatter: {
				name: "agent",
				description: "Test",
				model: "gpt-4o",
				tools: "read",
				thinking: "invalid",
			},
			body: "Prompt.",
		});

		expect(() =>
			loadProfilesFromDir("/agents", "bundled", {}, { read: "read" }),
		).toThrow("invalid thinking level");
	});

	it("throws for invalid profile name", () => {
		mockExistsSync.mockReturnValue(true);
		mockStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
		mockReaddirSync.mockReturnValue([mockDirent("agent.md")]);
		mockReadFileSync.mockReturnValue(
			"---\nname: !bad\ndescription: Test\nmodel: gpt-4o\ntools: read\n---\n\nPrompt.",
		);
		mockParseFrontmatter.mockReturnValue({
			frontmatter: {
				name: "!bad",
				description: "Test",
				model: "gpt-4o",
				tools: "read",
			},
			body: "Prompt.",
		});

		expect(() =>
			loadProfilesFromDir("/agents", "bundled", {}, { read: "read" }),
		).toThrow("invalid name");
	});

	it("throws for duplicate profile names", () => {
		mockExistsSync.mockReturnValue(true);
		mockStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
		mockReaddirSync.mockReturnValue([mockDirent("a.md"), mockDirent("b.md")]);
		mockReadFileSync.mockReturnValue(
			"---\nname: dup\ndescription: Test\nmodel: gpt-4o\ntools: read\n---\n\nPrompt.",
		);
		mockParseFrontmatter.mockReturnValue({
			frontmatter: {
				name: "dup",
				description: "Test",
				model: "gpt-4o",
				tools: "read",
			},
			body: "Prompt.",
		});

		expect(() =>
			loadProfilesFromDir("/agents", "bundled", {}, { read: "read" }),
		).toThrow('Duplicate agent profile "dup"');
	});

	it("throws for unavailable tools", () => {
		mockExistsSync.mockReturnValue(true);
		mockStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
		mockReaddirSync.mockReturnValue([mockDirent("agent.md")]);
		mockReadFileSync.mockReturnValue(
			"---\nname: agent\ndescription: Test\nmodel: gpt-4o\ntools: unknown_tool\n---\n\nPrompt.",
		);
		mockParseFrontmatter.mockReturnValue({
			frontmatter: {
				name: "agent",
				description: "Test",
				model: "gpt-4o",
				tools: "unknown_tool",
			},
			body: "Prompt.",
		});

		expect(() =>
			loadProfilesFromDir("/agents", "bundled", {}, { read: "read" }),
		).toThrow("unavailable child tools: unknown_tool");
	});

	it("throws for access below minimum required", () => {
		mockExistsSync.mockReturnValue(true);
		mockStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
		mockReaddirSync.mockReturnValue([mockDirent("agent.md")]);
		mockReadFileSync.mockReturnValue(
			"---\nname: agent\ndescription: Test\nmodel: gpt-4o\ntools: edit\naccess: read\n---\n\nPrompt.",
		);
		mockParseFrontmatter.mockReturnValue({
			frontmatter: {
				name: "agent",
				description: "Test",
				model: "gpt-4o",
				tools: "edit",
				access: "read",
			},
			body: "Prompt.",
		});

		expect(() =>
			loadProfilesFromDir("/agents", "bundled", {}, { edit: "write" }),
		).toThrow("declares access read, but tools require at least write");
	});

	it("throws for invalid timeoutSeconds", () => {
		mockExistsSync.mockReturnValue(true);
		mockStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
		mockReaddirSync.mockReturnValue([mockDirent("agent.md")]);
		mockReadFileSync.mockReturnValue(
			"---\nname: agent\ndescription: Test\nmodel: gpt-4o\ntools: read\ntimeoutSeconds: 5\n---\n\nPrompt.",
		);
		mockParseFrontmatter.mockReturnValue({
			frontmatter: {
				name: "agent",
				description: "Test",
				model: "gpt-4o",
				tools: "read",
				timeoutSeconds: 5,
			},
			body: "Prompt.",
		});

		expect(() =>
			loadProfilesFromDir("/agents", "bundled", {}, { read: "read" }),
		).toThrow("timeoutSeconds must be an integer between 10 and 1800");
	});

	it("deduplicates tools", () => {
		mockExistsSync.mockReturnValue(true);
		mockStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
		mockReaddirSync.mockReturnValue([mockDirent("agent.md")]);
		mockReadFileSync.mockReturnValue(
			"---\nname: agent\ndescription: Test\nmodel: gpt-4o\ntools: read,read,edit\n---\n\nPrompt.",
		);
		mockParseFrontmatter.mockReturnValue({
			frontmatter: {
				name: "agent",
				description: "Test",
				model: "gpt-4o",
				tools: "read,read,edit",
			},
			body: "Prompt.",
		});

		const result = loadProfilesFromDir(
			"/agents",
			"bundled",
			{},
			{ read: "read", edit: "write" },
		);
		expect(result[0].tools).toEqual(["read", "edit"]);
	});

	it("skips non-markdown files", () => {
		mockExistsSync.mockReturnValue(true);
		mockStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);
		mockReaddirSync.mockReturnValue([
			{ ...mockDirent("readme.txt"), isFile: () => true },
			mockDirent("agent.md"),
		]);
		mockReadFileSync.mockReturnValue(
			"---\nname: agent\ndescription: Test\nmodel: gpt-4o\ntools: read\n---\n\nPrompt.",
		);
		mockParseFrontmatter.mockReturnValue({
			frontmatter: {
				name: "agent",
				description: "Test",
				model: "gpt-4o",
				tools: "read",
			},
			body: "Prompt.",
		});

		const result = loadProfilesFromDir(
			"/agents",
			"bundled",
			{},
			{ read: "read" },
		);
		expect(result).toHaveLength(1);
		expect(result[0].name).toBe("agent");
	});
});

describe("loadSubagentConfiguration", () => {
	beforeEach(() => {
		mockReadFileSync.mockReset();
		mockExistsSync.mockReset();
		mockStatSync.mockReset();
		mockReaddirSync.mockReset();
		mockParseFrontmatter.mockReset();
		mockGetAgentDir.mockReturnValue("/mock/agent/dir");
	});

	it("loads bundled configuration and profiles", () => {
		mockReadFileSync.mockImplementation((path: fs.PathOrFileDescriptor) => {
			if (typeof path === "string" && path.includes("tmux-subagent.json")) {
				return JSON.stringify({
					maxTasks: 4,
					defaultTimeoutSeconds: 300,
					retainArtifacts: "on_failure",
					agentDirs: [],
				});
			}
			if (typeof path === "string" && path.includes("research.json")) {
				return JSON.stringify({ roles: {} });
			}
			if (typeof path === "string" && path.includes(".md")) {
				return "---\nname: worker\ndescription: Test worker\nmodel: gpt-4o\ntools: read\n---\n\nPrompt.";
			}
			if (typeof path === "string" && path.includes("config.json")) {
				const err = new Error("ENOENT") as NodeJS.ErrnoException;
				err.code = "ENOENT";
				throw err;
			}
			return "";
		});

		mockExistsSync.mockImplementation((path: fs.PathLike) => {
			const p = String(path);
			return p.includes("subagents") || p.includes("tmux-subagent.json");
		});

		mockStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);

		mockReaddirSync.mockReturnValue([mockDirent("worker.md")]);

		mockParseFrontmatter.mockReturnValue({
			frontmatter: {
				name: "worker",
				description: "Test worker",
				model: "gpt-4o",
				tools: "read",
			},
			body: "Prompt.",
		});

		const result = loadSubagentConfiguration("/ext/tmux-subagent");

		expect(result.config.maxTasks).toBe(4);
		expect(result.config.defaultTimeoutSeconds).toBe(300);
		expect(result.profiles).toHaveLength(1);
		expect(result.profiles[0].name).toBe("worker");
		expect(result.userConfigPath).toBe(
			"/mock/agent/dir/tmux-subagent/config.json",
		);
	});

	it("throws when no profiles are discovered", () => {
		mockReadFileSync.mockImplementation((path: fs.PathOrFileDescriptor) => {
			if (typeof path === "string" && path.includes("tmux-subagent.json")) {
				return JSON.stringify({ maxTasks: 4, defaultTimeoutSeconds: 300 });
			}
			if (typeof path === "string" && path.includes("research.json")) {
				return JSON.stringify({ roles: {} });
			}
			if (typeof path === "string" && path.includes("config.json")) {
				const err = new Error("ENOENT") as NodeJS.ErrnoException;
				err.code = "ENOENT";
				throw err;
			}
			return "";
		});

		mockExistsSync.mockReturnValue(false);

		expect(() => loadSubagentConfiguration("/ext/tmux-subagent")).toThrow(
			"No tmux-subagent profiles were discovered",
		);
	});

	it("merges user configuration over bundled", () => {
		mockReadFileSync.mockImplementation((path: fs.PathOrFileDescriptor) => {
			if (typeof path === "string" && path.includes("tmux-subagent.json")) {
				return JSON.stringify({ maxTasks: 2, defaultTimeoutSeconds: 300 });
			}
			if (typeof path === "string" && path.includes("research.json")) {
				return JSON.stringify({ roles: {} });
			}
			if (typeof path === "string" && path.includes("config.json")) {
				return JSON.stringify({ maxTasks: 8 });
			}
			if (typeof path === "string" && path.includes(".md")) {
				return "---\nname: worker\ndescription: Test\nmodel: gpt-4o\ntools: read\n---\n\nPrompt.";
			}
			return "";
		});

		mockExistsSync.mockImplementation((path: fs.PathLike) => {
			const p = String(path);
			return (
				p.includes("subagents") ||
				p.includes("tmux-subagent.json") ||
				p.includes("config.json")
			);
		});

		mockStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);

		mockReaddirSync.mockReturnValue([mockDirent("worker.md")]);

		mockParseFrontmatter.mockReturnValue({
			frontmatter: {
				name: "worker",
				description: "Test",
				model: "gpt-4o",
				tools: "read",
			},
			body: "Prompt.",
		});

		const result = loadSubagentConfiguration("/ext/tmux-subagent");
		expect(result.config.maxTasks).toBe(8);
	});

	it("applies the project layer with highest precedence when trusted", () => {
		mockReadFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
			const p = String(filePath);
			if (p.includes("tmux-subagent.json")) {
				return JSON.stringify({
					maxTasks: 2,
					models: { strong: "bundled-model", eval: "bundled-eval" },
				});
			}
			if (p.includes("research.json")) {
				return JSON.stringify({ roles: {} });
			}
			if (p.includes("/.pi/tmux-subagent/config.json")) {
				return JSON.stringify({
					maxTasks: 6,
					models: { strong: "project-model" },
				});
			}
			if (p.includes("config.json")) {
				return JSON.stringify({ maxTasks: 4, models: { eval: "user-eval" } });
			}
			if (p.includes(".md")) {
				return "---\nname: worker\ndescription: Test\nmodel: strong\ntools: read\n---\n\nPrompt.";
			}
			return "";
		});

		mockExistsSync.mockImplementation((filePath: fs.PathLike) => {
			const p = String(filePath);
			return (
				p.includes("subagents") ||
				p.includes("tmux-subagent.json") ||
				p.includes("config.json")
			);
		});

		mockStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);

		mockReaddirSync.mockReturnValue([mockDirent("worker.md")]);

		mockParseFrontmatter.mockReturnValue({
			frontmatter: {
				name: "worker",
				description: "Test",
				model: "strong",
				tools: "read",
			},
			body: "Prompt.",
		});

		const result = loadSubagentConfiguration("/ext/tmux-subagent", {
			projectRoot: "/mock/project",
			projectTrusted: true,
		});

		expect(result.projectConfigPath).toBe(
			path.join("/mock/project", ".pi", "tmux-subagent", "config.json"),
		);
		// Scalars: project > user > bundled.
		expect(result.config.maxTasks).toBe(6);
		// Models merge per-key: strong from project, eval from user.
		expect(result.config.models.strong).toBe("project-model");
		expect(result.config.models.eval).toBe("user-eval");
		// Profiles resolve through the merged alias map.
		expect(result.profiles[0].model).toBe("project-model");
	});

	it("ignores the project layer when the project is untrusted", () => {
		let readProjectConfig = false;
		mockReadFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
			const p = String(filePath);
			if (p.includes("/.pi/tmux-subagent/config.json")) {
				readProjectConfig = true;
			}
			if (p.includes("tmux-subagent.json")) {
				return JSON.stringify({ maxTasks: 2 });
			}
			if (p.includes("research.json")) {
				return JSON.stringify({ roles: {} });
			}
			if (p.includes(".md")) {
				return "---\nname: worker\ndescription: Test\nmodel: gpt-4o\ntools: read\n---\n\nPrompt.";
			}
			const err = new Error("ENOENT") as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});

		mockExistsSync.mockImplementation((filePath: fs.PathLike) => {
			return String(filePath).includes("subagents");
		});

		mockStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);

		mockReaddirSync.mockReturnValue([mockDirent("worker.md")]);

		mockParseFrontmatter.mockReturnValue({
			frontmatter: {
				name: "worker",
				description: "Test",
				model: "gpt-4o",
				tools: "read",
			},
			body: "Prompt.",
		});

		const result = loadSubagentConfiguration("/ext/tmux-subagent", {
			projectRoot: "/mock/project",
			projectTrusted: false,
		});

		expect(readProjectConfig).toBe(false);
		expect(result.projectConfigPath).toBeNull();
		expect(result.config.maxTasks).toBe(2);
	});

	it("tolerates a missing project layer file", () => {
		mockReadFileSync.mockImplementation((filePath: fs.PathOrFileDescriptor) => {
			const p = String(filePath);
			if (p === "/mock/project/.pi/tmux-subagent/config.json") {
				const err = new Error("ENOENT") as NodeJS.ErrnoException;
				err.code = "ENOENT";
				throw err;
			}
			if (p.includes("tmux-subagent.json")) {
				return JSON.stringify({ maxTasks: 3 });
			}
			if (p.includes("research.json")) {
				return JSON.stringify({ roles: {} });
			}
			if (p.includes(".md")) {
				return "---\nname: worker\ndescription: Test\nmodel: gpt-4o\ntools: read\n---\n\nPrompt.";
			}
			const err = new Error("ENOENT") as NodeJS.ErrnoException;
			err.code = "ENOENT";
			throw err;
		});

		mockExistsSync.mockImplementation((filePath: fs.PathLike) => {
			const p = String(filePath);
			return p.includes("subagents") || p.includes("tmux-subagent.json");
		});

		mockStatSync.mockReturnValue({ isDirectory: () => true } as fs.Stats);

		mockReaddirSync.mockReturnValue([mockDirent("worker.md")]);

		mockParseFrontmatter.mockReturnValue({
			frontmatter: {
				name: "worker",
				description: "Test",
				model: "gpt-4o",
				tools: "read",
			},
			body: "Prompt.",
		});

		const result = loadSubagentConfiguration("/ext/tmux-subagent", {
			projectRoot: "/mock/project",
			projectTrusted: true,
		});

		expect(result.projectConfigPath).toBe(
			path.join("/mock/project", ".pi", "tmux-subagent", "config.json"),
		);
		expect(result.config.maxTasks).toBe(3);
	});
});

describe("loadResearchProfiles", () => {
	it("registers all nine research agents with correct tmux profile names", () => {
		mockExistsSync.mockReturnValue(true);
		const result = loadResearchProfiles(
			{
				roles: {
					planner: {
						description: "Plan research",
						model: "strong",
						thinking: "high",
						tools: ["read", "grep"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "/mock/agents/planner.md",
						resultFormat: "markdown",
					},
					scout_research: {
						description: "Research scout",
						model: "strong",
						thinking: "high",
						tools: ["read", "web_lookup"],
						access: "read",
						timeoutSeconds: 1800,
						promptPath: "/mock/agents/scout.md",
						resultFormat: "markdown",
					},
					fetcher: {
						description: "Deep fetch",
						model: "strong",
						thinking: "minimal",
						tools: ["read", "fetch_web"],
						access: "read",
						timeoutSeconds: 720,
						promptPath: "/mock/agents/fetcher.md",
						resultFormat: "markdown",
					},
					consolidator: {
						description: "Consolidate research",
						model: "strong",
						thinking: "high",
						tools: ["read", "write", "edit"],
						access: "write",
						timeoutSeconds: 900,
						promptPath: "/mock/agents/consolidator.md",
						resultFormat: "markdown",
					},
					fragment_writer: {
						description: "Write report fragments",
						model: "strong",
						thinking: "high",
						tools: ["read", "grep"],
						access: "read",
						timeoutSeconds: 1200,
						promptPath: "/mock/agents/fragment-writer.md",
						resultFormat: "org",
					},
					judge: {
						description: "Judge report",
						model: "eval",
						thinking: "medium",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 1200,
						promptPath: "/mock/agents/judge.md",
						resultFormat: "markdown",
					},
					citation_agent: {
						description: "Citation mapping",
						model: "strong",
						thinking: "low",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 720,
						promptPath: "/mock/agents/citation-agent.md",
						resultFormat: "markdown",
					},
					source_auditor: {
						description: "Source audit",
						model: "strong",
						thinking: "low",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 720,
						promptPath: "/mock/agents/source-auditor.md",
						resultFormat: "markdown",
					},
					contradiction_resolver: {
						description: "Resolve contradictions",
						model: "light",
						thinking: "medium",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 960,
						promptPath: "/mock/agents/contradiction-resolver.md",
						resultFormat: "markdown",
					},
				},
			},
			{
				strong: "Qwen3.6-35B-A3B-MTP-GGUF",
				eval: "Gemma-4-31B-it-MTP-GGUF",
				light: "gpt-oss-20b-GGUF-Q4_K_M",
			},
			{
				read: "read",
				write: "write",
				edit: "write",
				grep: "read",
				web_lookup: "read",
				fetch_web: "read",
			},
		);

		const names = result.map((p) => p.name);
		expect(names).toContain("planner");
		expect(names).toContain("scout_research");
		expect(names).toContain("fetcher");
		expect(names).toContain("consolidator");
		expect(names).toContain("fragment_writer");
		expect(names).toContain("judge");
		expect(names).toContain("citation_agent");
		expect(names).toContain("source_auditor");
		expect(names).toContain("contradiction_resolver");
		expect(result).toHaveLength(9);
	});

	it("resolves model aliases to concrete model identifiers", () => {
		mockExistsSync.mockReturnValue(true);
		const result = loadResearchProfiles(
			{
				roles: {
					test_agent: {
						description: "Test",
						model: "strong",
						thinking: "high",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "/mock/agents/test.md",
						resultFormat: "markdown",
					},
				},
			},
			{ strong: "Qwen3.6-35B-A3B-MTP-GGUF" },
			{ read: "read" },
		);
		expect(result[0].model).toBe("Qwen3.6-35B-A3B-MTP-GGUF");
	});

	it("returns profiles with source marked as research", () => {
		mockExistsSync.mockReturnValue(true);
		const result = loadResearchProfiles(
			{
				roles: {
					test_agent: {
						description: "Test",
						model: "strong",
						thinking: "high",
						tools: ["read"],
						access: "read",
						timeoutSeconds: 300,
						promptPath: "/mock/agents/test.md",
						resultFormat: "markdown",
					},
				},
			},
			{ strong: "Qwen3.6-35B-A3B-MTP-GGUF" },
			{ read: "read" },
		);
		expect(result[0].source).toBe("research");
	});

	it("rejects profiles that would collide with generic profile names", () => {
		expect(() =>
			loadResearchProfiles(
				{
					roles: {
						worker: {
							description: "Should collide",
							model: "strong",
							thinking: "high",
							tools: ["read"],
							access: "read",
							timeoutSeconds: 300,
							promptPath: "/mock/agents/worker.md",
							resultFormat: "markdown",
						},
					},
				},
				{ strong: "Qwen3.6-35B-A3B-MTP-GGUF" },
				{ read: "read" },
			),
		).toThrow("collides");
	});
});
