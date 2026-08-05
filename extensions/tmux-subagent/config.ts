import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentAccess = "read" | "shell" | "write";

export interface AgentProfile {
	name: string;
	description: string;
	model: string;
	thinking?: string;
	tools: string[];
	access: AgentAccess;
	timeoutSeconds?: number;
	systemPrompt: string;
	filePath: string;
	source: "bundled" | "user" | "custom";
}

export interface SubagentConfiguration {
	models: Record<string, string>;
	childExtensions: string[];
	toolAccess: Record<string, AgentAccess>;
	agentDirs: string[];
	loadContextFiles: boolean;
	maxTasks: number;
	defaultTimeoutSeconds: number;
	retainArtifacts: "never" | "on_failure" | "always";
}

interface RawConfiguration {
	models?: unknown;
	childExtensions?: unknown;
	toolAccess?: unknown;
	agentDirs?: unknown;
	loadContextFiles?: unknown;
	maxTasks?: unknown;
	defaultTimeoutSeconds?: unknown;
	retainArtifacts?: unknown;
}

const BUILTIN_TOOL_ACCESS: Record<string, AgentAccess> = {
	read: "read",
	grep: "read",
	find: "read",
	ls: "read",
	bash: "shell",
	edit: "write",
	write: "write",
};
const ACCESS_RANK: Record<AgentAccess, number> = {
	read: 0,
	shell: 1,
	write: 2,
};
const ACCESS_VALUES = new Set(Object.keys(ACCESS_RANK));
const THINKING_VALUES = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

export function expandPath(value: string, baseDir: string): string {
	if (value === "$PI_AGENT_DIR") return getAgentDir();
	if (value.startsWith("$PI_AGENT_DIR/"))
		return path.join(getAgentDir(), value.slice(14));
	if (value === "~") return os.homedir();
	if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
	return path.isAbsolute(value) ? value : path.resolve(baseDir, value);
}

export function readConfiguration(
	filePath: string,
	required: boolean,
): RawConfiguration | null {
	try {
		const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error("configuration root must be an object");
		}
		return value as RawConfiguration;
	} catch (error) {
		if (!required && (error as NodeJS.ErrnoException).code === "ENOENT")
			return null;
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(
			`Cannot load tmux-subagent configuration ${filePath}: ${message}`,
		);
	}
}

export function normalizePaths(
	values: unknown,
	baseDir: string,
	field: string,
): string[] {
	if (values === undefined) return [];
	if (
		!Array.isArray(values) ||
		values.some((value) => typeof value !== "string" || !value.trim())
	) {
		throw new Error(`${field} must be an array of non-empty paths.`);
	}
	return values.map((value) => expandPath(value, baseDir));
}

export function normalizeModels(
	value: unknown,
	field: string,
): Record<string, string> {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error(
			`${field} must be an object mapping aliases to model identifiers.`,
		);
	}
	const models: Record<string, string> = Object.create(null);
	for (const [alias, model] of Object.entries(value)) {
		if (!alias.trim() || typeof model !== "string" || !model.trim()) {
			throw new Error(
				`${field} must map non-empty aliases to non-empty model identifiers.`,
			);
		}
		models[alias] = model;
	}
	return models;
}

export function normalizeToolAccess(
	value: unknown,
): Record<string, AgentAccess> {
	if (value === undefined) return {};
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("toolAccess must map tool names to read, shell, or write.");
	}
	const result: Record<string, AgentAccess> = Object.create(null);
	for (const [tool, access] of Object.entries(value)) {
		if (
			!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(tool) ||
			typeof access !== "string" ||
			!ACCESS_VALUES.has(access)
		) {
			throw new Error(
				"toolAccess must map valid tool names to read, shell, or write.",
			);
		}
		result[tool] = access as AgentAccess;
	}
	return result;
}

export function mergeToolAccess(
	...sources: Record<string, AgentAccess>[]
): Record<string, AgentAccess> {
	const result: Record<string, AgentAccess> = Object.create(null);
	for (const source of sources) {
		for (const [tool, access] of Object.entries(source)) {
			if (!result[tool] || ACCESS_RANK[access] > ACCESS_RANK[result[tool]])
				result[tool] = access;
		}
	}
	return result;
}

export function validateConfiguration(config: SubagentConfiguration): void {
	if (
		!Number.isInteger(config.maxTasks) ||
		config.maxTasks < 1 ||
		config.maxTasks > 16
	) {
		throw new Error("maxTasks must be an integer between 1 and 16.");
	}
	if (
		!Number.isInteger(config.defaultTimeoutSeconds) ||
		config.defaultTimeoutSeconds < 10 ||
		config.defaultTimeoutSeconds > 1800
	) {
		throw new Error(
			"defaultTimeoutSeconds must be an integer between 10 and 1800.",
		);
	}
	if (!["never", "on_failure", "always"].includes(config.retainArtifacts)) {
		throw new Error(
			'retainArtifacts must be "never", "on_failure", or "always".',
		);
	}
	if (typeof config.loadContextFiles !== "boolean") {
		throw new Error("loadContextFiles must be a boolean.");
	}
	for (const [alias, model] of Object.entries(config.models)) {
		if (!alias.trim() || typeof model !== "string" || !model.trim()) {
			throw new Error(
				"models must map non-empty aliases to non-empty model identifiers.",
			);
		}
	}
}

export function requiredAccess(
	tools: string[],
	toolAccess: Record<string, AgentAccess>,
): AgentAccess {
	return tools.reduce<AgentAccess>(
		(required, tool) =>
			ACCESS_RANK[toolAccess[tool]] > ACCESS_RANK[required]
				? toolAccess[tool]
				: required,
		"read",
	);
}

export function loadProfilesFromDir(
	dir: string,
	source: AgentProfile["source"],
	models: Record<string, string>,
	toolAccess: Record<string, AgentAccess>,
): AgentProfile[] {
	if (!fs.existsSync(dir)) return [];
	const stat = fs.statSync(dir);
	if (!stat.isDirectory())
		throw new Error(`Agent profile path is not a directory: ${dir}`);

	const profiles: AgentProfile[] = [];
	const names = new Set<string>();
	const entries = fs
		.readdirSync(dir, { withFileTypes: true })
		.sort((a, b) => a.name.localeCompare(b.name));
	for (const entry of entries) {
		if (
			!entry.name.endsWith(".md") ||
			(!entry.isFile() && !entry.isSymbolicLink())
		)
			continue;
		const filePath = path.join(dir, entry.name);
		const content = fs.readFileSync(filePath, "utf8");
		const { frontmatter, body } =
			parseFrontmatter<Record<string, unknown>>(content);
		const stringField = (name: string): string | undefined => {
			const value = frontmatter[name];
			return typeof value === "string" ? value.trim() : undefined;
		};
		const name = stringField("name");
		const description = stringField("description");
		const modelSetting = stringField("model");
		const thinking = stringField("thinking");
		const tools = stringField("tools")
			?.split(",")
			.map((tool) => tool.trim())
			.filter(Boolean);

		if (
			!name ||
			!description ||
			!modelSetting ||
			!tools?.length ||
			!body.trim()
		) {
			throw new Error(
				`Agent profile ${filePath} requires name, description, model, tools, and a prompt body.`,
			);
		}
		if (thinking && !THINKING_VALUES.has(thinking)) {
			throw new Error(
				`Agent profile ${filePath} has an invalid thinking level: ${thinking}`,
			);
		}
		if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) {
			throw new Error(`Agent profile ${filePath} has an invalid name: ${name}`);
		}
		if (names.has(name))
			throw new Error(`Duplicate agent profile "${name}" in ${dir}.`);
		names.add(name);

		const unknownTools = tools.filter(
			(tool) => !Object.hasOwn(toolAccess, tool),
		);
		if (unknownTools.length > 0) {
			throw new Error(
				`Agent profile ${filePath} uses unavailable child tools: ${unknownTools.join(", ")}.`,
			);
		}

		const minimumAccess = requiredAccess(tools, toolAccess);
		const accessSetting = stringField("access") || minimumAccess;
		if (!ACCESS_VALUES.has(accessSetting)) {
			throw new Error(
				`Agent profile ${filePath} access must be read, shell, or write.`,
			);
		}
		const access = accessSetting as AgentAccess;
		if (ACCESS_RANK[access] < ACCESS_RANK[minimumAccess]) {
			throw new Error(
				`Agent profile ${filePath} declares access ${access}, but tools require at least ${minimumAccess}.`,
			);
		}

		let timeoutSeconds: number | undefined;
		if (frontmatter.timeoutSeconds !== undefined) {
			timeoutSeconds = Number(frontmatter.timeoutSeconds);
			if (
				!Number.isInteger(timeoutSeconds) ||
				timeoutSeconds < 10 ||
				timeoutSeconds > 1800
			) {
				throw new Error(
					`Agent profile ${filePath} timeoutSeconds must be an integer between 10 and 1800.`,
				);
			}
		}

		profiles.push({
			name,
			description,
			model: Object.hasOwn(models, modelSetting)
				? models[modelSetting]
				: modelSetting,
			thinking,
			tools: [...new Set(tools)],
			access,
			timeoutSeconds,
			systemPrompt: body.trim(),
			filePath,
			source,
		});
	}
	return profiles;
}

export function loadSubagentConfiguration(extensionDir: string): {
	config: SubagentConfiguration;
	profiles: AgentProfile[];
	userConfigPath: string;
} {
	const packageRoot = path.resolve(extensionDir, "../..");
	const packageConfigPath = path.join(
		packageRoot,
		"config",
		"tmux-subagent.json",
	);
	const userRoot = path.join(getAgentDir(), "tmux-subagent");
	const userConfigPath = path.join(userRoot, "config.json");
	const bundled = readConfiguration(packageConfigPath, true) || {};
	const user = readConfiguration(userConfigPath, false);
	const packageConfigDir = path.dirname(packageConfigPath);
	const userConfigDir = path.dirname(userConfigPath);

	const config: SubagentConfiguration = {
		models: Object.assign(
			Object.create(null),
			normalizeModels(bundled.models, "bundled models"),
			normalizeModels(user?.models, "user models"),
		),
		childExtensions:
			user?.childExtensions !== undefined
				? normalizePaths(user.childExtensions, userConfigDir, "childExtensions")
				: normalizePaths(
						bundled.childExtensions,
						packageConfigDir,
						"childExtensions",
					),
		toolAccess: mergeToolAccess(
			BUILTIN_TOOL_ACCESS,
			normalizeToolAccess(bundled.toolAccess),
			normalizeToolAccess(user?.toolAccess),
		),
		agentDirs: [
			...normalizePaths(bundled.agentDirs, packageConfigDir, "agentDirs"),
			...normalizePaths(user?.agentDirs, userConfigDir, "agentDirs"),
		],
		loadContextFiles: (user?.loadContextFiles ??
			bundled.loadContextFiles ??
			true) as boolean,
		maxTasks: (user?.maxTasks ?? bundled.maxTasks ?? 4) as number,
		defaultTimeoutSeconds: (user?.defaultTimeoutSeconds ??
			bundled.defaultTimeoutSeconds ??
			300) as number,
		retainArtifacts: (user?.retainArtifacts ??
			bundled.retainArtifacts ??
			"on_failure") as SubagentConfiguration["retainArtifacts"],
	};
	validateConfiguration(config);

	const profileMap = new Map<string, AgentProfile>();
	const sources: Array<{ dir: string; source: AgentProfile["source"] }> = [
		{ dir: path.join(packageRoot, "subagents"), source: "bundled" },
		{ dir: path.join(userRoot, "agents"), source: "user" },
		...config.agentDirs.map((dir) => ({ dir, source: "custom" as const })),
	];
	for (const source of sources) {
		for (const profile of loadProfilesFromDir(
			source.dir,
			source.source,
			config.models,
			config.toolAccess,
		)) {
			profileMap.set(profile.name, profile);
		}
	}
	if (profileMap.size === 0)
		throw new Error("No tmux-subagent profiles were discovered.");

	return { config, profiles: [...profileMap.values()], userConfigPath };
}
