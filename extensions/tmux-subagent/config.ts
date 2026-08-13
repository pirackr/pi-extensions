import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

/**
 * Minimal research-agent shape (inlined from the deep-research config so
 * tmux-subagent has no production dependency on deep-research/ — Task 14
 * deletes that directory). Only the fields loadResearchProfiles needs.
 */
export interface ResearchAgentConfig {
	description: string;
	model: string;
	thinking: string;
	tools: string[];
	access: AgentAccess;
	timeoutSeconds: number;
	promptPath: string;
	resultFormat: string;
}

/**
 * Minimal deep-research config shape used by loadResearchProfiles.
 * Structurally compatible with the full ResolvedDeepResearchConfig.
 */
export interface ResearchProfilesConfig {
	agents: Record<string, ResearchAgentConfig>;
}

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
	source: "bundled" | "user" | "custom" | "research";
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
	/** Default hard cap on web_lookup calls per subagent process (overridable per-task). 0/unset = unlimited. */
	webSearchMaxLookups: number;
	/** Default hard cap on fetch_web calls per subagent process (overridable per-task). 0/unset = unlimited. */
	webSearchMaxFetches: number;
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
	webSearchMaxLookups?: unknown;
	webSearchMaxFetches?: unknown;
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

/**
 * Normalize a web-search budget: undefined/null → 0 (unlimited); must be a
 * non-negative integer otherwise.
 */
export function normalizeWebSearchBudget(
	value: unknown,
	field: string,
): number {
	if (value === undefined || value === null) return 0;
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new Error(`${field} must be a non-negative integer (0 = unlimited).`);
	}
	return value;
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
		webSearchMaxLookups: normalizeWebSearchBudget(
			user?.webSearchMaxLookups ?? bundled.webSearchMaxLookups,
			"webSearchMaxLookups",
		),
		webSearchMaxFetches: normalizeWebSearchBudget(
			user?.webSearchMaxFetches ?? bundled.webSearchMaxFetches,
			"webSearchMaxFetches",
		),
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

	// Register research agents from the packaged deep-research config
	try {
		const packageRoot = path.resolve(extensionDir, "../..");
		const agentDir = getAgentDir();
		const deepConfig = loadResearchAgentConfig(packageRoot, agentDir);
		const researchProfiles = loadResearchProfiles(
			deepConfig,
			config.models,
			config.toolAccess,
		);
		for (const profile of researchProfiles) {
			profileMap.set(profile.name, profile);
		}
	} catch {
		// Deep-research config is optional; silently skip if unavailable.
	}

	if (profileMap.size === 0)
		throw new Error("No tmux-subagent profiles were discovered.");

	return { config, profiles: [...profileMap.values()], userConfigPath };
}

/**
 * Load the research agents portion of the deep-research config (packaged
 * defaults merged with the optional user override at
 * `$PI_AGENT_DIR/deep-research/config.json`), resolving relative prompt
 * paths against the config directory that supplied each agent.
 *
 * Inlined here so tmux-subagent does not import deep-research/ (which is
 * slated for deletion). Validation of agents happens in loadResearchProfiles.
 */
export function loadResearchAgentConfig(
	packageRoot: string,
	agentDir: string,
): ResearchProfilesConfig {
	const packageConfigPath = path.join(
		packageRoot,
		"config",
		"deep-research.json",
	);
	const userConfigPath = path.join(agentDir, "deep-research", "config.json");

	const readJson = (
		p: string,
	): { agents?: Record<string, ResearchAgentConfig> } => {
		const raw = JSON.parse(fs.readFileSync(p, "utf8")) as {
			agents?: Record<string, ResearchAgentConfig>;
		};
		return raw ?? {};
	};

	const packaged = readJson(packageConfigPath);
	let user: { agents?: Record<string, ResearchAgentConfig> } | null = null;
	try {
		user = readJson(userConfigPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
		// User override is optional
	}

	const mergedAgents: Record<string, ResearchAgentConfig> = {
		...(packaged.agents ?? {}),
		...(user?.agents ?? {}),
	};

	// Resolve prompt paths:
	// - Packaged agents resolve relative to the packaged config directory
	// - Override agents resolve relative to the override file directory
	const packageConfigDir = path.dirname(packageConfigPath);
	const userConfigDir = user ? path.dirname(userConfigPath) : null;
	for (const [agentName, agent] of Object.entries(mergedAgents)) {
		let resolvedPath = agent.promptPath;
		if (!path.isAbsolute(resolvedPath)) {
			const isFromOverride =
				user !== null && Object.hasOwn(user.agents ?? {}, agentName);
			const baseDir =
				isFromOverride && userConfigDir ? userConfigDir : packageConfigDir;
			resolvedPath = path.resolve(baseDir, resolvedPath);
		}
		mergedAgents[agentName] = { ...agent, promptPath: resolvedPath };
	}

	return { agents: mergedAgents };
}

/**
 * Register research agents from the deep-research config as tmux-subagent
 * profiles. The profile names match the research registry names
 * (scout_research, fetcher, consolidator, fragment_writer, judge, citation_agent,
 * source_auditor, contradiction_resolver, planner) and do NOT collide with generic profiles
 * (worker, reviewer, tester, scout).
 *
 * @param config - The resolved research-agent configuration
 * @param models - Model alias registry (from tmux-subagent config)
 * @param toolAccess - Tool access registry (from tmux-subagent config)
 * @returns AgentProfile entries for each research agent
 */
export function loadResearchProfiles(
	config: ResearchProfilesConfig,
	models: Record<string, string>,
	toolAccess: Record<string, AgentAccess>,
): AgentProfile[] {
	const ACCESS_RANK: Record<AgentAccess, number> = {
		read: 0,
		shell: 1,
		write: 2,
	};

	const VALID_ACCESS = new Set<AgentAccess>(["read", "shell", "write"]);

	// Generic profile names that must not be collided with
	const GENERIC_PROFILE_NAMES = new Set([
		"worker",
		"reviewer",
		"tester",
		"scout",
	]);

	const profiles: AgentProfile[] = [];
	for (const [name, agent] of Object.entries(config.agents)) {
		if (GENERIC_PROFILE_NAMES.has(name)) {
			throw new Error(
				`Research agent '${name}' collides with a generic profile name and cannot be registered.`,
			);
		}

		// Validate model alias
		const concreteModel = models[agent.model];
		if (concreteModel === undefined) {
			throw new Error(
				`Agent '${name}' has an invalid model: '${agent.model}' — not found in models registry.`,
			);
		}

		// Validate tools
		const unknownTools = agent.tools.filter(
			(tool) => !Object.hasOwn(toolAccess, tool),
		);
		if (unknownTools.length > 0) {
			throw new Error(
				`Agent '${name}' uses unavailable tools: ${unknownTools.join(", ")}.`,
			);
		}

		// Validate access
		if (!VALID_ACCESS.has(agent.access)) {
			throw new Error(
				`Agent '${name}' has an invalid access level: '${agent.access}'.`,
			);
		}

		// Compute minimum required access from tools
		const minimumAccess = agent.tools.reduce<AgentAccess>(
			(required, tool) =>
				ACCESS_RANK[toolAccess[tool]] > ACCESS_RANK[required]
					? (toolAccess[tool] as AgentAccess)
					: required,
			"read",
		);
		if (ACCESS_RANK[agent.access] < ACCESS_RANK[minimumAccess]) {
			throw new Error(
				`Agent '${name}' declares access ${agent.access}, but tools require at least ${minimumAccess}.`,
			);
		}

		// Validate prompt path exists
		if (!fs.existsSync(agent.promptPath)) {
			throw new Error(
				`Agent '${name}' has an unresolvable prompt path: '${agent.promptPath}'.`,
			);
		}
		const promptBody = fs.readFileSync(agent.promptPath, "utf8");
		if (!promptBody.trim()) {
			throw new Error(
				`Agent '${name}' prompt file is empty: '${agent.promptPath}'.`,
			);
		}

		profiles.push({
			name,
			description: agent.description,
			model: concreteModel,
			thinking: agent.thinking,
			tools: [...new Set(agent.tools)],
			access: agent.access,
			timeoutSeconds: agent.timeoutSeconds,
			systemPrompt: promptBody.trim(),
			filePath: agent.promptPath,
			source: "research" as const,
		});
	}
	return profiles;
}
