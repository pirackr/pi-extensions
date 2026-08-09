import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentAccess, AgentProfile } from "../tmux-subagent/config.ts";

export type DeepResearchResultFormat = "markdown" | "json" | "org";

export interface RawDeepResearchAgent {
	description: string;
	model: string;
	thinking: string;
	tools: string[];
	access: AgentAccess;
	timeoutSeconds: number;
	promptPath: string;
	resultFormat: DeepResearchResultFormat;
}

export interface RawDeepResearchProfile {
	minRounds: number;
	maxRounds: number;
	minSources: number;
	maxScouts: number;
	maxFetchers: number;
	verification: string[];
}

export interface RawDeepResearchConfig {
	defaultProfile: string;
	defaults: {
		maxSearchesPerAgent: number;
		maxFetchesPerAgent: number;
		scoreThreshold: number;
		retryCount: number;
	};
	profiles: Record<string, RawDeepResearchProfile>;
	agents: Record<string, RawDeepResearchAgent>;
}

export interface ResolvedDeepResearchConfig {
	defaultProfile: string;
	defaults: {
		maxSearchesPerAgent: number;
		maxFetchesPerAgent: number;
		scoreThreshold: number;
		retryCount: number;
	};
	profiles: Record<string, RawDeepResearchProfile>;
	agents: Record<string, RawDeepResearchAgent>;
}

const KNOWN_TOP_LEVEL_FIELDS = new Set([
	"defaultProfile",
	"defaults",
	"profiles",
	"agents",
]);

const KNOWN_AGENT_FIELDS = new Set([
	"description",
	"model",
	"thinking",
	"tools",
	"access",
	"timeoutSeconds",
	"promptPath",
	"resultFormat",
]);

const KNOWN_PROFILE_FIELDS = new Set([
	"minRounds",
	"maxRounds",
	"minSources",
	"maxScouts",
	"maxFetchers",
	"verification",
]);

const KNOWN_DEFAULTS_FIELDS = new Set([
	"maxSearchesPerAgent",
	"maxFetchesPerAgent",
	"scoreThreshold",
	"retryCount",
]);

const VALID_THINKING = new Set([
	"off",
	"minimal",
	"low",
	"medium",
	"high",
	"xhigh",
	"max",
]);

const VALID_ACCESS = new Set(["read", "shell", "write"]);

const VALID_RESULT_FORMATS = new Set(["markdown", "json", "org"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value)
	);
}

function validateRawConfig(raw: unknown, sourceLabel: string): RawDeepResearchConfig {
	if (!isPlainObject(raw)) {
		throw new Error(
			`deep-research configuration (${sourceLabel}) must be a JSON object.`,
		);
	}

	// Check for unknown top-level fields
	for (const key of Object.keys(raw)) {
		if (!KNOWN_TOP_LEVEL_FIELDS.has(key)) {
			throw new Error(
				`Unknown field '${key}' in deep-research configuration (${sourceLabel}).`,
			);
		}
	}

	// Validate defaults
	if (!isPlainObject(raw.defaults)) {
		throw new Error("defaults must be an object.");
	}
	for (const key of Object.keys(raw.defaults)) {
		if (!KNOWN_DEFAULTS_FIELDS.has(key)) {
			throw new Error(
				`Unknown field '${key}' in defaults (${sourceLabel}).`,
			);
		}
	}
	const defaults = raw.defaults as {
		maxSearchesPerAgent: number;
		maxFetchesPerAgent: number;
		scoreThreshold: number;
		retryCount: number;
	};
	if (
		typeof defaults.maxSearchesPerAgent !== "number" ||
		!Number.isInteger(defaults.maxSearchesPerAgent) ||
		defaults.maxSearchesPerAgent < 0
	) {
		throw new Error(
			"defaults.maxSearchesPerAgent must be a non-negative integer.",
		);
	}
	if (
		typeof defaults.maxFetchesPerAgent !== "number" ||
		!Number.isInteger(defaults.maxFetchesPerAgent) ||
		defaults.maxFetchesPerAgent < 0
	) {
		throw new Error(
			"defaults.maxFetchesPerAgent must be a non-negative integer.",
		);
	}
	if (
		typeof defaults.scoreThreshold !== "number" ||
		!Number.isInteger(defaults.scoreThreshold) ||
		defaults.scoreThreshold < 0 ||
		defaults.scoreThreshold > 100
	) {
		throw new Error(
			"defaults.scoreThreshold must be an integer between 0 and 100.",
		);
	}
	if (
		typeof defaults.retryCount !== "number" ||
		!Number.isInteger(defaults.retryCount) ||
		defaults.retryCount < 0
	) {
		throw new Error("defaults.retryCount must be a non-negative integer.");
	}

	// Validate profiles
	if (!isPlainObject(raw.profiles)) {
		throw new Error("profiles must be an object.");
	}
	for (const [profileName, profile] of Object.entries(raw.profiles)) {
		if (!isPlainObject(profile)) {
			throw new Error(
				`Profile '${profileName}' must be an object.`,
			);
		}
		for (const key of Object.keys(profile)) {
			if (!KNOWN_PROFILE_FIELDS.has(key)) {
				throw new Error(
					`Unknown field '${key}' in profile '${profileName}'.`,
				);
			}
		}
		const p = profile as Record<string, unknown>;
		if (
			typeof p.minRounds !== "number" ||
			!Number.isInteger(p.minRounds) ||
			p.minRounds < 1
		) {
			throw new Error(
				`Profile '${profileName}': minRounds must be a positive integer.`,
			);
		}
		if (
			typeof p.maxRounds !== "number" ||
			!Number.isInteger(p.maxRounds) ||
			p.maxRounds < 1
		) {
			throw new Error(
				`Profile '${profileName}': maxRounds must be a positive integer.`,
			);
		}
		if (
			typeof p.minSources !== "number" ||
			!Number.isInteger(p.minSources) ||
			p.minSources < 0
		) {
			throw new Error(
				`Profile '${profileName}': minSources must be a non-negative integer.`,
			);
		}
		if (
			typeof p.maxScouts !== "number" ||
			!Number.isInteger(p.maxScouts) ||
			p.maxScouts < 0
		) {
			throw new Error(
				`Profile '${profileName}': maxScouts must be a non-negative integer.`,
			);
		}
		if (
			typeof p.maxFetchers !== "number" ||
			!Number.isInteger(p.maxFetchers) ||
			p.maxFetchers < 0
		) {
			throw new Error(
				`Profile '${profileName}': maxFetchers must be a non-negative integer.`,
			);
		}
		if (
			!Array.isArray(p.verification) ||
			!p.verification.every((v: unknown) => typeof v === "string")
		) {
			throw new Error(
				`Profile '${profileName}': verification must be an array of strings.`,
			);
		}
	}

	// Validate agents
	if (!isPlainObject(raw.agents)) {
		throw new Error("agents must be an object.");
	}
	const agentNames = new Set(Object.keys(raw.agents));
	for (const [agentName, agent] of Object.entries(raw.agents)) {
		if (!isPlainObject(agent)) {
			throw new Error(
				`Agent '${agentName}' must be an object.`,
			);
		}
		for (const key of Object.keys(agent)) {
			if (!KNOWN_AGENT_FIELDS.has(key)) {
				throw new Error(
					`Unknown field '${key}' in agent '${agentName}'.`,
				);
			}
		}
		const a = agent as Record<string, unknown>;
		if (typeof a.description !== "string" || !a.description.trim()) {
			throw new Error(
				`Agent '${agentName}': description must be a non-empty string.`,
			);
		}
		if (typeof a.model !== "string" || !a.model.trim()) {
			throw new Error(
				`Agent '${agentName}': model must be a non-empty string.`,
			);
		}
		if (typeof a.thinking !== "string" || !VALID_THINKING.has(a.thinking)) {
			throw new Error(
				`Agent '${agentName}': has an invalid thinking level: '${a.thinking}'.`,
			);
		}
		if (
			!Array.isArray(a.tools) ||
			!a.tools.every((t: unknown) => typeof t === "string")
		) {
			throw new Error(
				`Agent '${agentName}': tools must be an array of strings.`,
			);
		}
		if (typeof a.access !== "string" || !VALID_ACCESS.has(a.access)) {
			throw new Error(
				`Agent '${agentName}': has an invalid access level: '${a.access}'.`,
			);
		}
		if (
			typeof a.timeoutSeconds !== "number" ||
			!Number.isInteger(a.timeoutSeconds) ||
			a.timeoutSeconds < 10 ||
			a.timeoutSeconds > 1800
		) {
			throw new Error(
				`Agent '${agentName}': timeoutSeconds must be an integer between 10 and 1800.`,
			);
		}
		if (typeof a.promptPath !== "string" || !a.promptPath.trim()) {
			throw new Error(
				`Agent '${agentName}': promptPath must be a non-empty string.`,
			);
		}
		if (
			typeof a.resultFormat !== "string" ||
			!VALID_RESULT_FORMATS.has(a.resultFormat)
		) {
			throw new Error(
				`Agent '${agentName}': has an invalid resultFormat: '${a.resultFormat}'.`,
			);
		}
	}

	// Validate verification role references
	for (const [profileName, profile] of Object.entries(raw.profiles)) {
		const p = profile as Record<string, unknown>;
		const verification = p.verification as string[];
		for (const verifier of verification) {
			if (!agentNames.has(verifier)) {
				throw new Error(
					`Profile '${profileName}': verification references unknown agent '${verifier}'.`,
				);
			}
		}
	}

	return raw as RawDeepResearchConfig;
}

function deepMergeConfig(
	base: RawDeepResearchConfig,
	override: RawDeepResearchConfig,
): RawDeepResearchConfig {
	return {
		defaultProfile: override.defaultProfile ?? base.defaultProfile,
		defaults:
			override.defaults !== undefined
				? { ...base.defaults, ...override.defaults }
				: base.defaults,
		profiles: { ...base.profiles, ...override.profiles },
		agents: { ...base.agents, ...override.agents },
	};
}

/**
 * Load and validate the deep-research configuration, merging packaged defaults
 * with an optional user override at `$PI_AGENT_DIR/deep-research/config.json`.
 *
 * Project-local overrides are intentionally not supported — only the bundled
 * config and the user override are loaded.
 */
export function loadDeepResearchConfiguration(
	packageRoot: string,
	agentDir: string,
): ResolvedDeepResearchConfig {
	const packageConfigPath = path.join(
		packageRoot,
		"config",
		"deep-research.json",
	);
	const userConfigPath = path.join(agentDir, "deep-research", "config.json");

	let packaged: RawDeepResearchConfig;
	try {
		const raw = JSON.parse(
			fs.readFileSync(packageConfigPath, "utf8"),
		) as unknown;
		packaged = validateRawConfig(raw, packageConfigPath);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			throw new Error(
				`Cannot load packaged deep-research configuration: ${packageConfigPath} not found.`,
			);
		}
		throw error;
	}

	let userOverride: RawDeepResearchConfig | null = null;
	try {
		const raw = JSON.parse(
			fs.readFileSync(userConfigPath, "utf8"),
		) as unknown;
		// Parse but don't fully validate the user override — only merged
		// config is validated, since partial overrides are expected.
		userOverride = raw as RawDeepResearchConfig;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
			throw error;
		}
		// User override is optional
	}

	const merged = userOverride
		? deepMergeConfig(packaged, userOverride)
		: packaged;

	// Resolve prompt paths:
	// - Packaged agents resolve relative to the packaged config directory
	// - Override agents resolve relative to the override file directory
	const packageConfigDir = path.dirname(packageConfigPath);
	const userConfigDir = userOverride ? path.dirname(userConfigPath) : null;
	for (const [agentName, agent] of Object.entries(merged.agents)) {
		let resolvedPath = agent.promptPath;
		if (!path.isAbsolute(resolvedPath)) {
			// Check if this agent came from the override
			const isFromOverride =
				userOverride !== null &&
				Object.hasOwn(userOverride.agents, agentName);
			const baseDir = isFromOverride && userConfigDir
				? userConfigDir
				: packageConfigDir;
			resolvedPath = path.resolve(baseDir, resolvedPath);
		}
		merged.agents[agentName] = { ...agent, promptPath: resolvedPath };
		// Validate prompt path exists
		if (!fs.existsSync(merged.agents[agentName].promptPath)) {
			throw new Error(
				`Agent '${agentName}' has an unresolvable prompt path: '${merged.agents[agentName].promptPath}'.`,
			);
		}
		const promptBody = fs.readFileSync(merged.agents[agentName].promptPath, "utf8");
		if (!promptBody.trim()) {
			throw new Error(
				`Agent '${agentName}' prompt file is empty: '${merged.agents[agentName].promptPath}'.`,
			);
		}
	}

	// Fully revalidate after merge (user overrides may introduce invalid refs)
	return validateRawConfig(merged, "merged deep-research config") as ResolvedDeepResearchConfig;
}
