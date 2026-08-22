// Layered configuration and generic external-profile discovery for the
// `subagent` extension.
//
// This module owns exactly two public contracts for Task 4:
//
//   - {@link loadSubagentConfiguration} — resolve the packaged < user <
//     trusted-project layered JSON configuration for the subagent extension.
//   - {@link discoverProfiles} — collect already-resolved
//     {@link ProfileContribution}s through Pi’s synchronous, load-order
//     independent `subagent:discover-profiles` event, merge them with the
//     generic `.md` profile sources, deduplicate by owner plus profile name,
//     and fail closed on conflicting owners for the same reserved profile.
//
// The configuration shape is intentionally a generic subset of the legacy
// `tmux-subagent` config (see `extensions/tmux-subagent/config.ts`, a
// read-only porting reference). No research configuration is imported or
// interpreted here — research contributes resolved profiles through the same
// {@link ProfileContribution} contract, and the ownership/precedence logic in
// {@link discoverProfiles} stays owner-neutral.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	parseFrontmatter,
} from "@earendil-works/pi-coding-agent";

import {
	AgentAccess,
	ProfileContribution,
	ResolvedProfile,
} from "./types.ts";

// ---------------------------------------------------------------------------
// Configuration shape
// ---------------------------------------------------------------------------

/**
 * The resolved subagent configuration produced by {@link loadSubagentConfiguration}.
 *
 * Every field has a packaged default and is layered `packaged < user < trusted
 * project`. See the design spec “Configuration → Settings” for the field
 * semantics and defaults.
 */
export interface SubagentConfiguration {
	/** Alias → concrete-model map consumed when resolving profile models. */
	models: Record<string, string>;
	/**
	 * Child extension entrypoints. The highest layer that specifies the array
	 * replaces all lower layers (unlike `agentDirs`, which concatenates).
	 */
	childExtensions: string[];
	/** Tool → access registry: built-in base plus per-key layered merge. */
	toolAccess: Record<string, AgentAccess>;
	/** Extra directories scanned for generic `.md` profiles. */
	agentDirs: string[];
	/** Whether child profiles load the parent’s context files. */
	loadContextFiles: boolean;
	/** Default hard per-task timeout in seconds. */
	defaultTimeoutSeconds: number;
	/** Default hard cap on web_lookup calls per subagent process (0 = unlimited). */
	webSearchMaxLookups: number;
	/** Default hard cap on fetch_web calls per subagent process (0 = unlimited). */
	webSearchMaxFetches: number;
	/** Maximum concurrently running subagents. Replaces the legacy `maxTasks`. */
	maxConcurrent: number;
	/** Seconds a completion group waits before delivering partially. */
	notificationGroupWaitSeconds: number;
	/** Preview characters for a solo completion. */
	soloPreviewCharacters: number;
	/** Preview characters per member of a grouped completion. */
	groupPreviewCharacters: number;
}

/**
 * Optional project-layer options for {@link loadSubagentConfiguration}.
 *
 * The project layer at `<projectRoot>/.pi/subagent/config.json` is loaded only
 * when `projectTrusted` is true and participates with the highest precedence.
 * Untrusted projects never contribute a layer.
 */
export interface ProjectLayerOptions {
	projectRoot?: string;
	projectTrusted?: boolean;
}

interface RawConfiguration {
	models?: unknown;
	childExtensions?: unknown;
	toolAccess?: unknown;
	agentDirs?: unknown;
	loadContextFiles?: unknown;
	defaultTimeoutSeconds?: unknown;
	webSearchMaxLookups?: unknown;
	webSearchMaxFetches?: unknown;
	maxConcurrent?: unknown;
	notificationGroupWaitSeconds?: unknown;
	soloPreviewCharacters?: unknown;
	groupPreviewCharacters?: unknown;
}

/**
 * Everything {@link discoverProfiles} needs from the loaded configuration: the
 * resolved config plus the absolute paths of every profile source.
 */
export interface LoadedSubagentConfiguration {
	config: SubagentConfiguration;
	/** Absolute path to the extension directory (`extensions/subagent`). */
	subagentDir: string;
	/** Absolute path to the packaged generic profiles (`subagentDir/subagents`). */
	subagentsDir: string;
	/** Absolute user config root (`$PI_AGENT_DIR/subagent`). */
	userDir: string;
	/** Absolute directory of generic user profiles (`userDir/agents`). */
	userAgentsDir: string;
	/** Absolute path to the user config file. */
	userConfigPath: string;
	/** Absolute project root, or `null` when no project layer participates. */
	projectDir: string | null;
	/** Absolute path to the trusted project config file, or `null`. */
	projectConfigPath: string | null;
}

/**
 * Context handed to {@link discoverProfiles}. Only the discovery trigger and a
 * couple of convenience paths are required today; the surface is intentionally
 * forward-compatible so later tasks can pass project-scoped inputs without
 * changing the signature.
 */
export interface DiscoverProfilesContext {
	/** Current working directory, for diagnostics and future project paths. */
	cwd: string;
	/** Whether the current project is trusted (project layer participates). */
	projectTrusted: boolean;
}

/**
 * The discovery envelope emitted on the `subagent:discover-profiles` channel.
 * Listeners synchronously append caller-owned {@link ProfileContribution}s.
 */
export interface DiscoveryEnvelope {
	contributions: ProfileContribution[];
}

/**
 * The result of {@link discoverProfiles}: the merged, validated profile list
 * plus the deduplicated external contributions (kept for auditing and for the
 * scheduler/policy layers that need the owning extension of each profile).
 */
export interface DiscoveredProfiles {
	profiles: ResolvedProfile[];
	contributions: ProfileContribution[];
}

/** Synthetic owner shared by every generic `.md` profile source. */
const GENERIC_OWNER = "generic";

// ---------------------------------------------------------------------------
// Validation constants
// ---------------------------------------------------------------------------

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

const TOOL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

// Default configuration values (packaged defaults for every scalar).
const DEFAULTS = {
	maxConcurrent: 10,
	notificationGroupWaitSeconds: 30,
	soloPreviewCharacters: 500,
	groupPreviewCharacters: 300,
	defaultTimeoutSeconds: 300,
	loadContextFiles: true,
};

// ---------------------------------------------------------------------------
// Small normalizers (ported from the tmux-subagent reference, research-free)
// ---------------------------------------------------------------------------

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
			`Cannot load subagent configuration ${filePath}: ${message}`,
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
			!TOOL_NAME_RE.test(tool) ||
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

/**
 * Per-key layered tool-access merge: the highest access level across all
 * sources wins for each tool, seeded with the built-in base.
 */
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

function normalizeScalarNumber(
	value: unknown,
	field: string,
	{ min, max }: { min: number; max?: number },
): number {
	if (typeof value !== "number" || !Number.isInteger(value)) {
		throw new Error(`${field} must be an integer.`);
	}
	if (value < min || (max !== undefined && value > max)) {
		throw new Error(
			`${field} must be an integer between ${min} ${
				max !== undefined ? `and ${max}` : ""
			}.`,
		);
	}
	return value;
}

// ---------------------------------------------------------------------------
// Configuration loading
// ---------------------------------------------------------------------------

/**
 * Resolve the layered subagent configuration.
 *
 * Precedence is `packaged < user < trusted project`:
 *
 * - `models` — per-key merge across all three layers.
 * - `toolAccess` — built-in base plus per-key layered merge (highest access
 *   wins).
 * - `childExtensions` — the highest layer that specifies the array replaces
 *   lower layers.
 * - `agentDirs` — the concatenated, individually-canonicalized packaged, user,
 *   and project directories.
 * - scalars — the highest layer that specifies a value wins.
 *
 * Paths are expanded relative to the configuration file that supplied them, so
 * a relative `agentDirs`/`childExtensions` entry in the user file resolves
 * against `$PI_AGENT_DIR/subagent`, never the caller’s cwd. Malformed layers,
 * paths, models, tools, or access combinations fail closed.
 *
 * @param extensionDir Absolute path to `extensions/subagent`.
 */
export function loadSubagentConfiguration(
	extensionDir: string,
	options: ProjectLayerOptions = {},
): LoadedSubagentConfiguration {
	const packageRoot = path.resolve(extensionDir, "../..");
	const packageConfigPath = path.join(
		packageRoot,
		"config",
		"subagent.json",
	);
	const subagentsDir = path.join(extensionDir, "subagents");
	const userRoot = path.join(getAgentDir(), "subagent");
	const userConfigPath = path.join(userRoot, "config.json");
	// Project layer (optional): `<projectRoot>/.pi/subagent/config.json` —
	// highest precedence, only when the project is trusted.
	const projectConfigPath =
		options.projectTrusted && options.projectRoot
			? path.join(
					options.projectRoot,
					CONFIG_DIR_NAME,
					"subagent",
					"config.json",
				)
			: null;

	const bundled = readConfiguration(packageConfigPath, true) || {};
	const user = readConfiguration(userConfigPath, false);
	const project = projectConfigPath
		? readConfiguration(projectConfigPath, false)
		: null;
	const packageConfigDir = path.dirname(packageConfigPath);
	const userConfigDir = path.dirname(userConfigPath);
	const projectConfigDir = projectConfigPath
		? path.dirname(projectConfigPath)
		: null;

	const config: SubagentConfiguration = {
		models: Object.assign(
			Object.create(null),
			normalizeModels(bundled.models, "bundled models"),
			normalizeModels(user?.models, "user models"),
			normalizeModels(project?.models, "project models"),
		),
		// Highest layer that specifies childExtensions wins outright.
		childExtensions:
			project?.childExtensions !== undefined
				? normalizePaths(
						project.childExtensions,
						projectConfigDir!,
						"childExtensions",
					)
				: user?.childExtensions !== undefined
					? normalizePaths(
							user.childExtensions,
							userConfigDir,
							"childExtensions",
						)
					: normalizePaths(
							bundled.childExtensions,
							packageConfigDir,
							"childExtensions",
						),
		toolAccess: mergeToolAccess(
			BUILTIN_TOOL_ACCESS,
			normalizeToolAccess(bundled.toolAccess),
			normalizeToolAccess(user?.toolAccess),
			normalizeToolAccess(project?.toolAccess),
		),
		agentDirs: [
			...normalizePaths(bundled.agentDirs, packageConfigDir, "agentDirs"),
			...normalizePaths(user?.agentDirs, userConfigDir, "agentDirs"),
			...normalizePaths(
				project?.agentDirs,
				projectConfigDir ?? ".",
				"agentDirs",
			),
		],
		loadContextFiles: Boolean(
			project?.loadContextFiles ??
				user?.loadContextFiles ??
				bundled.loadContextFiles ??
				DEFAULTS.loadContextFiles,
		),
		defaultTimeoutSeconds: normalizeScalarNumber(
			project?.defaultTimeoutSeconds ??
				user?.defaultTimeoutSeconds ??
				bundled.defaultTimeoutSeconds ??
				DEFAULTS.defaultTimeoutSeconds,
			"defaultTimeoutSeconds",
			{ min: 10, max: 1800 },
		),
		webSearchMaxLookups: normalizeWebSearchBudget(
			project?.webSearchMaxLookups ??
				user?.webSearchMaxLookups ??
				bundled.webSearchMaxLookups,
			"webSearchMaxLookups",
		),
		webSearchMaxFetches: normalizeWebSearchBudget(
			project?.webSearchMaxFetches ??
				user?.webSearchMaxFetches ??
				bundled.webSearchMaxFetches,
			"webSearchMaxFetches",
		),
		maxConcurrent: normalizeScalarNumber(
			project?.maxConcurrent ??
				user?.maxConcurrent ??
				bundled.maxConcurrent ??
				DEFAULTS.maxConcurrent,
			"maxConcurrent",
			{ min: 1, max: 64 },
		),
		notificationGroupWaitSeconds: normalizeScalarNumber(
			project?.notificationGroupWaitSeconds ??
				user?.notificationGroupWaitSeconds ??
				bundled.notificationGroupWaitSeconds ??
				DEFAULTS.notificationGroupWaitSeconds,
			"notificationGroupWaitSeconds",
			{ min: 0 },
		),
		soloPreviewCharacters: normalizeScalarNumber(
			project?.soloPreviewCharacters ??
				user?.soloPreviewCharacters ??
				bundled.soloPreviewCharacters ??
				DEFAULTS.soloPreviewCharacters,
			"soloPreviewCharacters",
			{ min: 1 },
		),
		groupPreviewCharacters: normalizeScalarNumber(
			project?.groupPreviewCharacters ??
				user?.groupPreviewCharacters ??
				bundled.groupPreviewCharacters ??
				DEFAULTS.groupPreviewCharacters,
			"groupPreviewCharacters",
			{ min: 1 },
		),
	};
	validateConfiguration(config);

	return {
		config,
		subagentDir: path.resolve(extensionDir),
		subagentsDir,
		userDir: userRoot,
		userAgentsDir: path.join(userRoot, "agents"),
		userConfigPath,
		projectDir: projectConfigPath
			? path.resolve(options.projectRoot!)
			: null,
		projectConfigPath,
	};
}

/**
 * Structural and range validation for the resolved {@link SubagentConfiguration}.
 *
 * @throws a descriptive error on the first invalid field so a malformed layer
 *   fails closed rather than silently degrading.
 */
export function validateConfiguration(config: SubagentConfiguration): void {
	if (
		!Number.isInteger(config.defaultTimeoutSeconds) ||
		config.defaultTimeoutSeconds < 10 ||
		config.defaultTimeoutSeconds > 1800
	) {
		throw new Error(
			"defaultTimeoutSeconds must be an integer between 10 and 1800.",
		);
	}
	if (
		!Number.isInteger(config.maxConcurrent) ||
		config.maxConcurrent < 1 ||
		config.maxConcurrent > 64
	) {
		throw new Error(
			"maxConcurrent must be an integer between 1 and 64.",
		);
	}
	for (const [alias, model] of Object.entries(config.models)) {
		if (!alias.trim() || typeof model !== "string" || !model.trim()) {
			throw new Error(
				"models must map non-empty aliases to non-empty model identifiers.",
			);
		}
	}
}

// ---------------------------------------------------------------------------
// Generic `.md` profile sources
// ---------------------------------------------------------------------------

function requiredString(
	frontmatter: Record<string, unknown>,
	name: string,
	where: string,
): string {
	const value = frontmatter[name];
	if (typeof value !== "string" || !value.trim()) {
		throw new Error(
			`subagent profile ${where} requires a non-empty ${name}.`,
		);
	}
	return value.trim();
}

/**
 * Load the generic `.md` profiles from a single directory. Profiles are keyed
 * by name; later files in the same directory do not override earlier ones —
 * duplicates are rejected so a mis-packaged profile fails closed.
 *
 * @throws on a missing directory (returns `[]`), a non-directory path, a
 *   malformed profile, an invalid model alias, unavailable tools, an access
 *   below the tools' minimum requirement, or duplicate names.
 *
 * An omitted `timeoutSeconds` frontmatter value is resolved against the
 * `defaultTimeoutSeconds` supplied by the {@link SubagentConfiguration} used for
 * this exact discovery call, so the resolved snapshot is concrete and later
 * config edits cannot mutate it.
 */
export function loadGenericProfilesFromDir(
	dir: string,
	source: ResolvedProfile["source"],
	models: Record<string, string>,
	toolAccess: Record<string, AgentAccess>,
	defaultTimeoutSeconds: number,
): ResolvedProfile[] {
	if (!fs.existsSync(dir)) return [];
	const stat = fs.statSync(dir);
	if (!stat.isDirectory())
		throw new Error(`subagent profile path is not a directory: ${dir}`);

	const profiles: ResolvedProfile[] = [];
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
		const where = `subagent profile ${filePath}`;

		const name = requiredString(frontmatter, "name", where);
		const description = requiredString(frontmatter, "description", where);
		const modelSetting = requiredString(frontmatter, "model", where);
		const thinking = frontmatter.thinking;
		const tools = requiredString(frontmatter, "tools", where)
			.split(",")
			.map((tool) => tool.trim())
			.filter(Boolean);

		if (
			thinking !== undefined &&
			(typeof thinking !== "string" || !THINKING_VALUES.has(thinking))
		) {
			throw new Error(`${where} has an invalid thinking level: ${thinking}`);
		}
		if (!TOOL_NAME_RE.test(name)) {
			throw new Error(`${where} has an invalid name: ${name}`);
		}
		if (names.has(name))
			throw new Error(`Duplicate subagent profile "${name}" in ${dir}.`);
		names.add(name);

		const unknownTools = tools.filter(
			(tool) => !Object.hasOwn(toolAccess, tool),
		);
		if (unknownTools.length > 0) {
			throw new Error(
				`${where} uses unavailable child tools: ${unknownTools.join(", ")}.`,
			);
		}

		const minimumAccess = requiredAccess(tools, toolAccess);
		const accessSetting =
			frontmatter.access !== undefined &&
			typeof frontmatter.access === "string"
				? frontmatter.access
				: minimumAccess;
		if (!ACCESS_VALUES.has(accessSetting)) {
			throw new Error(
				`${where} access must be read, shell, or write (defaulting to ${minimumAccess}).`,
			);
		}
		const access = accessSetting as AgentAccess;
		if (ACCESS_RANK[access] < ACCESS_RANK[minimumAccess]) {
			throw new Error(
				`${where} declares access ${access}, but tools require at least ${minimumAccess}.`,
			);
		}

		let timeoutSeconds: number;
		if (frontmatter.timeoutSeconds !== undefined) {
			timeoutSeconds = Number(frontmatter.timeoutSeconds);
			if (
				!Number.isInteger(timeoutSeconds) ||
				timeoutSeconds < 10 ||
				timeoutSeconds > 1800
			) {
				throw new Error(
					`${where} timeoutSeconds must be an integer between 10 and 1800.`,
				);
			}
		} else {
			// Omitted frontmatter timeout resolves against the concrete default of
			// the configuration used for this discovery call, keeping the snapshot
			// immutable against later config edits (never a mutable reference).
			timeoutSeconds = defaultTimeoutSeconds;
		}

		const concreteModel = Object.hasOwn(models, modelSetting)
			? models[modelSetting]
			: modelSetting;

		profiles.push({
			name,
			description,
			model: concreteModel,
			thinking: typeof thinking === "string" ? thinking : "off",
			tools: [...new Set(tools)],
			access,
			timeoutSeconds,
			systemPrompt: body.trim(),
			source,
		});
	}
	return profiles;
}

function requiredAccess(
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

// ---------------------------------------------------------------------------
// External profile discovery
// ---------------------------------------------------------------------------

/** Minimal structural shape of `pi.events` used by {@link discoverProfiles}. */
export interface EventsBus {
	emit(channel: string, data: unknown): void;
}

/**
 * Collect external {@link ProfileContribution}s through the synchronous,
 * load-order independent `subagent:discover-profiles` channel, then merge them
 * with the generic `.md` profile sources.
 *
 * Merge semantics:
 *
 * - Generic `.md` profiles share the synthetic `generic` owner; the last source
 *   (packaged < user < agentDirs) with a given name wins.
 * - External contributions are deduplicated by `owner + profile.name`, so
 *   discovery runs repeatedly (startup + before each `Agent` call) are
 *   idempotent, and two providers with the same owner never double-count.
 * - A profile name claimed by two *different* owners fails closed: generic
 *   profiles own their names, and an external owner (for example research) may
 *   only contribute names it does not collide with. This keeps reserved
 *   profile names collision-free without importing any owner’s policy.
 *
 * Generic profiles are returned first (in last-wins order) followed by the
 * deduplicated external contributions.
 *
 * @throws when a malformed path/source is encountered, or when conflicting
 *   owners claim the same reserved profile name.
 */
export function discoverProfiles(
	pi: { events: EventsBus },
	loaded: LoadedSubagentConfiguration,
	_context: DiscoverProfilesContext,
): DiscoveredProfiles {
	// 1. Generic `.md` sources, concatenated in load order. Each is resolved
	//    against the concrete `defaultTimeoutSeconds` of this loaded config so a
	//    generic profile that omits its own timeout still captures a snapshot
	//    value — the current default of this exact discovery call, which later
	//    config edits cannot mutate.
	const defaultTimeoutSeconds = loaded.config.defaultTimeoutSeconds;
	const generic: ResolvedProfile[] = [
		...loadGenericProfilesFromDir(
			loaded.subagentsDir,
			"bundled",
			loaded.config.models,
			loaded.config.toolAccess,
			defaultTimeoutSeconds,
		),
		...loadGenericProfilesFromDir(
			loaded.userAgentsDir,
			"user",
			loaded.config.models,
			loaded.config.toolAccess,
			defaultTimeoutSeconds,
		),
		...loaded.config.agentDirs.flatMap((dir) =>
			loadGenericProfilesFromDir(
				dir,
				"custom",
				loaded.config.models,
				loaded.config.toolAccess,
				defaultTimeoutSeconds,
			),
		),
	];

	// Deduplicate generic profiles by name; last source wins (later replaces
	// earlier with the same name).
	const genericByName = new Map<string, ResolvedProfile>();
	for (const profile of generic) genericByName.set(profile.name, profile);

	// 2. External contributions via the caller-owned envelope. The bus is
	//    synchronous and returns `void`, so listeners append to the shared
	//    envelope and we collect it afterwards — load-order independent.
	const envelope: DiscoveryEnvelope = { contributions: [] };
	pi.events.emit("subagent:discover-profiles", envelope);

	// Deduplicate by owner + profile.name (idempotent on repeat discovery).
	const externalByKey = new Map<string, ProfileContribution>();
	for (const contribution of envelope.contributions) {
		const key = `${contribution.owner}\u0000${contribution.profile.name}`;
		if (!externalByKey.has(key)) externalByKey.set(key, contribution);
	}

	// 3. Conflict detection: a name owned by two different owners is a
	//    reserved-name collision and fails closed.
	const nameOwner = new Map<string, string>();
	for (const profile of genericByName.values())
		nameOwner.set(profile.name, GENERIC_OWNER);
	for (const contribution of externalByKey.values()) {
		// External contributions are already-resolved snapshots: fail closed if a
		// malformed owner left `timeoutSeconds` absent/null/invalid instead of a
		// concrete integer, rather than filling in a generic default across
		// owner boundaries.
		normalizeScalarNumber(
			contribution.profile.timeoutSeconds,
			`external profile "${contribution.profile.name}" timeoutSeconds`,
			{ min: 10, max: 1800 },
		);
		const name = contribution.profile.name;
		const existing = nameOwner.get(name);
		if (existing !== undefined && existing !== contribution.owner) {
			throw new Error(
				`subagent profile "${name}" is claimed by conflicting owners "${existing}" and "${contribution.owner}".`,
			);
		}
		nameOwner.set(name, contribution.owner);
	}

	const externalContributions = [...externalByKey.values()];

	return {
		profiles: [
			...genericByName.values(),
			...externalContributions.map((c) => c.profile),
		],
		contributions: externalContributions,
	};
}
