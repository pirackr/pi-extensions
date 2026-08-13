import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConfigLayer {
	path: string;
	kind: "packaged" | "user" | "cli";
	value: unknown;
}

export interface PackagedCapability {
	name: string;
	paths: string[];
	requiredTools: string[];
}

export interface ResolvedResearchConfig {
	defaultProgram: string;
	defaultProfile: string;
	defaultProvider: string | null;
	defaults: {
		maxIterations: number;
		maxTokens: number;
		noProgress: number | "off";
		scoreThreshold: number;
		retryCount: number;
		maxSearches: number;
		maxFetches: number;
	};
	profiles: Record<
		string,
		{
			minRounds: number;
			maxRounds: number | null;
			minSources: number;
			maxScouts: number;
			maxFetchers: number;
			verification: string[];
		}
	>;
	roles: Record<
		string,
		{
			description: string;
			model: string;
			thinking: "high" | "medium" | "low" | "minimal";
			tools: string[];
			access: "read" | "write";
			timeoutSeconds: number;
			promptPath: string;
			resultFormat: "markdown" | "json";
			totalDispatch: number;
			concurrentDispatch: number;
			maxSearches: number;
			maxFetches: number;
			retention: "ephemeral" | "artifact" | "persistent";
		}
	>;
	capabilities: Record<
		string,
		{
			name: string;
			paths: string[];
			requiredTools: string[];
			advancedOptions?: Record<string, unknown>;
		}
	>;
	childExtensions: string[];
}

// ---------------------------------------------------------------------------
// Known-field sets for strict validation
// ---------------------------------------------------------------------------

const KNOWN_TOP_LEVEL_FIELDS = new Set([
	"defaultProgram",
	"defaultProfile",
	"defaultProvider",
	"defaults",
	"profiles",
	"roles",
	"capabilities",
	"childExtensions",
]);

const KNOWN_DEFAULTS_FIELDS = new Set([
	"maxIterations",
	"maxTokens",
	"noProgress",
	"scoreThreshold",
	"retryCount",
	"maxSearches",
	"maxFetches",
]);

const KNOWN_PROFILE_FIELDS = new Set([
	"minRounds",
	"maxRounds",
	"minSources",
	"maxScouts",
	"maxFetchers",
	"verification",
]);

const KNOWN_ROLE_FIELDS = new Set([
	"description",
	"model",
	"thinking",
	"tools",
	"access",
	"timeoutSeconds",
	"promptPath",
	"resultFormat",
	"totalDispatch",
	"concurrentDispatch",
	"maxSearches",
	"maxFetches",
	"retention",
]);

const KNOWN_CAPABILITY_FIELDS = new Set([
	"name",
	"paths",
	"requiredTools",
	"advancedOptions",
]);

const VALID_THINKING = new Set(["minimal", "low", "medium", "high"]);

const VALID_ACCESS = new Set(["read", "write"]);

const VALID_RESULT_FORMATS = new Set(["markdown", "json"]);

const VALID_RETENTION = new Set(["ephemeral", "artifact", "persistent"]);

// Fields that indicate credentials — rejected at any nesting depth
const CREDENTIAL_FIELD_NAMES = new Set([
	"apiKey",
	"api_key",
	"token",
	"password",
	"secret",
	"credentials",
	"authToken",
	"bearerToken",
	"accessToken",
	"privateKey",
	"sshKey",
	"auth",
	"credential",
]);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return (
		value !== null &&
		typeof value === "object" &&
		!Array.isArray(value)
	);
}

/**
 * Checks whether any key in an object (at any nesting depth) matches a
 * credential-like field name. Throws on the first match.
 */
function rejectCredentialFields(
	obj: Record<string, unknown>,
	context: string,
): void {
	for (const [key, value] of Object.entries(obj)) {
		if (isCredentialField(key)) {
			throw new Error(
				`Credential field '${key}' is not permitted in ${context}.`,
			);
		}
		if (isPlainObject(value)) {
			rejectCredentialFields(value, `${context}.${key}`);
		}
	}
}

function isCredentialField(key: string): boolean {
	const lower = key.toLowerCase();
	for (const kw of CREDENTIAL_FIELD_NAMES) {
		const lowerKw = kw.toLowerCase();
		// Compound keywords (contain uppercase) match as substring
		if (kw !== lowerKw) {
			if (lower.includes(lowerKw)) return true;
		}
		// Standalone keywords match exactly
		else if (lower === lowerKw) {
			return true;
		}
	}
	return false;
}

/**
 * Deep-merges `overrides` over `base`. Plain objects merge recursively;
 * arrays and primitives are replaced wholesale.
 */
function deepMerge(
	base: Record<string, unknown>,
	overrides: Record<string, unknown>,
): Record<string, unknown> {
	const result = { ...base };
	for (const [key, overrideValue] of Object.entries(overrides)) {
		if (
			overrideValue !== null &&
			typeof overrideValue === "object" &&
			!Array.isArray(overrideValue) &&
			isPlainObject(result[key])
		) {
			result[key] = deepMerge(
				result[key] as Record<string, unknown>,
				overrideValue as Record<string, unknown>,
			);
		} else {
			result[key] = overrideValue;
		}
	}
	return result;
}

/**
 * Resolves all relative paths (promptPath, capability paths, childExtensions)
 * in a config object against the given base directory.  Absolute paths are
 * left untouched.  Returns a new object; the input is never mutated.
 */
function resolvePaths(obj: Record<string, unknown>, baseDir: string): Record<string, unknown> {
	const result: Record<string, unknown> = { ...obj };
	for (const [key, value] of Object.entries(result)) {
		// promptPath on roles
		if (key === "promptPath" && typeof value === "string" && !path.isAbsolute(value)) {
			result[key] = path.resolve(baseDir, value);
		}
		// paths on capabilities
		else if (key === "paths" && Array.isArray(value)) {
			result[key] = (value as unknown[]).map((p) =>
				typeof p === "string" && !path.isAbsolute(p)
					? path.resolve(baseDir, p)
					: p,
			);
		}
		// childExtensions
		else if (key === "childExtensions" && Array.isArray(value)) {
			result[key] = (value as unknown[]).map((p) =>
				typeof p === "string" && !path.isAbsolute(p)
					? path.resolve(baseDir, p)
					: p,
			);
		}
		// recurse into nested plain objects (clone to preserve immutability)
		else if (isPlainObject(value)) {
			result[key] = resolvePaths(value as Record<string, unknown>, baseDir);
		}
		// recurse into arrays of plain objects (clone items)
		else if (Array.isArray(value)) {
			result[key] = (value as unknown[]).map((item) =>
				isPlainObject(item)
					? resolvePaths(item as Record<string, unknown>, baseDir)
					: item,
			);
		}
	}
	return result;
}

// ---------------------------------------------------------------------------
// Per-layer validation
// ---------------------------------------------------------------------------

function validateTopLevel(raw: Record<string, unknown>, sourceLabel: string): void {
	for (const key of Object.keys(raw)) {
		if (!KNOWN_TOP_LEVEL_FIELDS.has(key)) {
			throw new Error(
				`Unknown field '${key}' in research configuration (${sourceLabel}).`,
			);
		}
	}
	rejectCredentialFields(raw, sourceLabel);
}

/**
 * Partial top-level validation for user/cli layers: only rejects unknown
 * fields; does not require any specific fields to be present.
 */
function validatePartialTopLevel(raw: Record<string, unknown>, sourceLabel: string): void {
	for (const key of Object.keys(raw)) {
		if (!KNOWN_TOP_LEVEL_FIELDS.has(key)) {
			throw new Error(
				`Unknown field '${key}' in research configuration (${sourceLabel}).`,
			);
		}
	}
	rejectCredentialFields(raw, sourceLabel);
}

function validatePartialDefaults(
	raw: Record<string, unknown>,
	sourceLabel: string,
): void {
	if (!isPlainObject(raw.defaults)) {
		throw new Error("defaults must be an object.");
	}
	const defaults = raw.defaults as Record<string, unknown>;
	for (const key of Object.keys(defaults)) {
		if (!KNOWN_DEFAULTS_FIELDS.has(key)) {
			throw new Error(
				`Unknown field '${key}' in defaults (${sourceLabel}).`,
			);
		}
	}
	rejectCredentialFields(defaults, `${sourceLabel}.defaults`);

	const maxIterations = defaults.maxIterations;
	if (
		typeof maxIterations !== "undefined" &&
		(typeof maxIterations !== "number" ||
			!Number.isInteger(maxIterations) ||
			maxIterations < 0)
	) {
		throw new Error("defaults.maxIterations must be a non-negative integer.");
	}

	const maxTokens = defaults.maxTokens;
	if (
		typeof maxTokens !== "undefined" &&
		(typeof maxTokens !== "number" ||
			!Number.isInteger(maxTokens) ||
			maxTokens < 0)
	) {
		throw new Error("defaults.maxTokens must be a non-negative integer.");
	}

	const noProgress = defaults.noProgress;
	if (
		typeof noProgress !== "undefined" &&
		typeof noProgress !== "number" &&
		noProgress !== "off"
	) {
		throw new Error(
			"defaults.noProgress must be a non-negative integer or the string 'off'.",
		);
	}
	if (typeof noProgress === "number" && (noProgress < 0 || !Number.isInteger(noProgress))) {
		throw new Error("defaults.noProgress must be a non-negative integer.");
	}

	const scoreThreshold = defaults.scoreThreshold;
	if (
		typeof scoreThreshold !== "undefined" &&
		(typeof scoreThreshold !== "number" ||
			!Number.isInteger(scoreThreshold) ||
			scoreThreshold < 0 ||
			scoreThreshold > 100)
	) {
		throw new Error(
			"defaults.scoreThreshold must be an integer between 0 and 100.",
		);
	}

	const retryCount = defaults.retryCount;
	if (
		typeof retryCount !== "undefined" &&
		(typeof retryCount !== "number" ||
			!Number.isInteger(retryCount) ||
			retryCount < 0)
	) {
		throw new Error("defaults.retryCount must be a non-negative integer.");
	}

	const maxSearches = defaults.maxSearches;
	if (
		typeof maxSearches !== "undefined" &&
		(typeof maxSearches !== "number" ||
			!Number.isInteger(maxSearches) ||
			maxSearches < 0)
	) {
		throw new Error("defaults.maxSearches must be a non-negative integer.");
	}

	const maxFetches = defaults.maxFetches;
	if (
		typeof maxFetches !== "undefined" &&
		(typeof maxFetches !== "number" ||
			!Number.isInteger(maxFetches) ||
			maxFetches < 0)
	) {
		throw new Error("defaults.maxFetches must be a non-negative integer.");
	}
}

function validateDefaults(
	raw: Record<string, unknown>,
	sourceLabel: string,
): void {
	if (!isPlainObject(raw.defaults)) {
		throw new Error("defaults must be an object.");
	}
	const defaults = raw.defaults as Record<string, unknown>;
	for (const key of Object.keys(defaults)) {
		if (!KNOWN_DEFAULTS_FIELDS.has(key)) {
			throw new Error(
				`Unknown field '${key}' in defaults (${sourceLabel}).`,
			);
		}
	}
	rejectCredentialFields(defaults, `${sourceLabel}.defaults`);

	const maxIterations = defaults.maxIterations;
	if (
		typeof maxIterations !== "number" ||
		!Number.isInteger(maxIterations) ||
		maxIterations < 0
	) {
		throw new Error("defaults.maxIterations must be a non-negative integer.");
	}

	const maxTokens = defaults.maxTokens;
	if (
		typeof maxTokens !== "number" ||
		!Number.isInteger(maxTokens) ||
		maxTokens < 0
	) {
		throw new Error("defaults.maxTokens must be a non-negative integer.");
	}

	const noProgress = defaults.noProgress;
	if (
		typeof noProgress !== "number" &&
		noProgress !== "off"
	) {
		throw new Error(
			"defaults.noProgress must be a non-negative integer or the string 'off'.",
		);
	}
	if (typeof noProgress === "number" && (noProgress < 0 || !Number.isInteger(noProgress))) {
		throw new Error("defaults.noProgress must be a non-negative integer.");
	}

	const scoreThreshold = defaults.scoreThreshold;
	if (
		typeof scoreThreshold !== "number" ||
		!Number.isInteger(scoreThreshold) ||
		scoreThreshold < 0 ||
		scoreThreshold > 100
	) {
		throw new Error(
			"defaults.scoreThreshold must be an integer between 0 and 100.",
		);
	}

	const retryCount = defaults.retryCount;
	if (
		typeof retryCount !== "number" ||
		!Number.isInteger(retryCount) ||
		retryCount < 0
	) {
		throw new Error("defaults.retryCount must be a non-negative integer.");
	}

	const maxSearches = defaults.maxSearches;
	if (
		typeof maxSearches !== "number" ||
		!Number.isInteger(maxSearches) ||
		maxSearches < 0
	) {
		throw new Error("defaults.maxSearches must be a non-negative integer.");
	}

	const maxFetches = defaults.maxFetches;
	if (
		typeof maxFetches !== "number" ||
		!Number.isInteger(maxFetches) ||
		maxFetches < 0
	) {
		throw new Error("defaults.maxFetches must be a non-negative integer.");
	}
}

function validateProfiles(
	raw: Record<string, unknown>,
	sourceLabel: string,
	agentNames: Set<string>,
): void {
	if (!isPlainObject(raw.profiles)) {
		throw new Error("profiles must be an object.");
	}
	for (const [profileName, profile] of Object.entries(raw.profiles)) {
		if (!isPlainObject(profile)) {
			throw new Error(`Profile '${profileName}' must be an object.`);
		}
		const p = profile as Record<string, unknown>;
		for (const key of Object.keys(p)) {
			if (!KNOWN_PROFILE_FIELDS.has(key)) {
				throw new Error(`Unknown field '${key}' in profile '${profileName}'.`);
			}
		}
		rejectCredentialFields(p, `${sourceLabel}.profiles.${profileName}`);

		const minRounds = p.minRounds;
		if (
			typeof minRounds !== "number" ||
			!Number.isInteger(minRounds) ||
			minRounds < 1
		) {
			throw new Error(`Profile '${profileName}': minRounds must be a positive integer.`);
		}

		const maxRounds = p.maxRounds;
		if (maxRounds !== null) {
			if (
				typeof maxRounds !== "number" ||
				!Number.isInteger(maxRounds) ||
				maxRounds < 1
			) {
				throw new Error(
					`Profile '${profileName}': maxRounds must be a positive integer or null.`,
				);
			}
		}

		const minSources = p.minSources;
		if (
			typeof minSources !== "number" ||
			!Number.isInteger(minSources) ||
			minSources < 0
		) {
			throw new Error(`Profile '${profileName}': minSources must be a non-negative integer.`);
		}

		const maxScouts = p.maxScouts;
		if (
			typeof maxScouts !== "number" ||
			!Number.isInteger(maxScouts) ||
			maxScouts < 0
		) {
			throw new Error(`Profile '${profileName}': maxScouts must be a non-negative integer.`);
		}

		const maxFetchers = p.maxFetchers;
		if (
			typeof maxFetchers !== "number" ||
			!Number.isInteger(maxFetchers) ||
			maxFetchers < 0
		) {
			throw new Error(`Profile '${profileName}': maxFetchers must be a non-negative integer.`);
		}

		const verification = p.verification;
		if (!Array.isArray(verification) || !verification.every((v: unknown) => typeof v === "string")) {
			throw new Error(`Profile '${profileName}': verification must be an array of strings.`);
		}
		for (const verifier of verification) {
			if (!agentNames.has(verifier)) {
				throw new Error(`Profile '${profileName}': verification references unknown role '${verifier}'.`);
			}
		}
	}
}

/**
 * Partial profile validation for user/cli layers: only checks fields that
 * are present.
 */
function validatePartialProfiles(
	raw: Record<string, unknown>,
	sourceLabel: string,
	agentNames: Set<string>,
): void {
	if (!isPlainObject(raw.profiles)) {
		throw new Error("profiles must be an object.");
	}
	for (const [profileName, profile] of Object.entries(raw.profiles)) {
		if (!isPlainObject(profile)) {
			throw new Error(`Profile '${profileName}' must be an object.`);
		}
		const p = profile as Record<string, unknown>;
		for (const key of Object.keys(p)) {
			if (!KNOWN_PROFILE_FIELDS.has(key)) {
				throw new Error(`Unknown field '${key}' in profile '${profileName}'.`);
			}
		}
		rejectCredentialFields(p, `${sourceLabel}.profiles.${profileName}`);

		if ("minRounds" in p) {
			const v = p.minRounds;
			if (
				typeof v !== "number" ||
				!Number.isInteger(v) ||
				v < 1
			) {
				throw new Error(`Profile '${profileName}': minRounds must be a positive integer.`);
			}
		}
		if ("maxRounds" in p) {
			const v = p.maxRounds;
			if (v !== null) {
				if (
					typeof v !== "number" ||
					!Number.isInteger(v) ||
					v < 1
				) {
					throw new Error(
						`Profile '${profileName}': maxRounds must be a positive integer or null.`,
					);
				}
			}
		}
		if ("minSources" in p) {
			const v = p.minSources;
			if (
				typeof v !== "number" ||
				!Number.isInteger(v) ||
				v < 0
			) {
				throw new Error(`Profile '${profileName}': minSources must be a non-negative integer.`);
			}
		}
		if ("maxScouts" in p) {
			const v = p.maxScouts;
			if (
				typeof v !== "number" ||
				!Number.isInteger(v) ||
				v < 0
			) {
				throw new Error(`Profile '${profileName}': maxScouts must be a non-negative integer.`);
			}
		}
		if ("maxFetchers" in p) {
			const v = p.maxFetchers;
			if (
				typeof v !== "number" ||
				!Number.isInteger(v) ||
				v < 0
			) {
				throw new Error(`Profile '${profileName}': maxFetchers must be a non-negative integer.`);
			}
		}
		if ("verification" in p) {
			const v = p.verification;
			if (!Array.isArray(v) || !v.every((x: unknown) => typeof x === "string")) {
				throw new Error(`Profile '${profileName}': verification must be an array of strings.`);
			}
			for (const verifier of v) {
				if (agentNames.size > 0 && !agentNames.has(verifier)) {
					throw new Error(`Profile '${profileName}': verification references unknown role '${verifier}'.`);
				}
			}
		}
	}
}

function validateRoles(
	raw: Record<string, unknown>,
	sourceLabel: string,
): void {
	if (!isPlainObject(raw.roles)) {
		throw new Error("roles must be an object.");
	}
	const roleNames = new Set(Object.keys(raw.roles));
	for (const [roleName, role] of Object.entries(raw.roles)) {
		if (!isPlainObject(role)) {
			throw new Error(`Role '${roleName}' must be an object.`);
		}
		const r = role as Record<string, unknown>;
		for (const key of Object.keys(r)) {
			if (!KNOWN_ROLE_FIELDS.has(key)) {
				throw new Error(`Unknown field '${key}' in role '${roleName}'.`);
			}
		}
		rejectCredentialFields(r, `${sourceLabel}.roles.${roleName}`);

		if (typeof r.description !== "string" || !r.description.trim()) {
			throw new Error(`Role '${roleName}': description must be a non-empty string.`);
		}
		if (typeof r.model !== "string" || !r.model.trim()) {
			throw new Error(`Role '${roleName}': model must be a non-empty string.`);
		}
		if (typeof r.thinking !== "string" || !VALID_THINKING.has(r.thinking)) {
			throw new Error(
				`Role '${roleName}': has an invalid thinking level: '${r.thinking}'.`,
			);
		}
		if (!Array.isArray(r.tools) || !r.tools.every((t: unknown) => typeof t === "string")) {
			throw new Error(`Role '${roleName}': tools must be an array of strings.`);
		}
		if (typeof r.access !== "string" || !VALID_ACCESS.has(r.access)) {
			throw new Error(
				`Role '${roleName}': has an invalid access level: '${r.access}'.`,
			);
		}
		if (
			typeof r.timeoutSeconds !== "number" ||
			!Number.isInteger(r.timeoutSeconds) ||
			r.timeoutSeconds < 10 ||
			r.timeoutSeconds > 1800
		) {
			throw new Error(
				`Role '${roleName}': timeoutSeconds must be an integer between 10 and 1800.`,
			);
		}
		if (typeof r.promptPath !== "string" || !r.promptPath.trim()) {
			throw new Error(`Role '${roleName}': promptPath must be a non-empty string.`);
		}
		if (
			typeof r.resultFormat !== "string" ||
			!VALID_RESULT_FORMATS.has(r.resultFormat)
		) {
			throw new Error(
				`Role '${roleName}': has an invalid resultFormat: '${r.resultFormat}'.`,
			);
		}
		if (
			typeof r.totalDispatch !== "number" ||
			!Number.isInteger(r.totalDispatch) ||
			r.totalDispatch < 0
		) {
			throw new Error(`Role '${roleName}': totalDispatch must be a non-negative integer.`);
		}
		if (
			typeof r.concurrentDispatch !== "number" ||
			!Number.isInteger(r.concurrentDispatch) ||
			r.concurrentDispatch < 0
		) {
			throw new Error(
				`Role '${roleName}': concurrentDispatch must be a non-negative integer.`,
			);
		}
		if (
			typeof r.maxSearches !== "number" ||
			!Number.isInteger(r.maxSearches) ||
			r.maxSearches < 0
		) {
			throw new Error(`Role '${roleName}': maxSearches must be a non-negative integer.`);
		}
		if (
			typeof r.maxFetches !== "number" ||
			!Number.isInteger(r.maxFetches) ||
			r.maxFetches < 0
		) {
			throw new Error(`Role '${roleName}': maxFetches must be a non-negative integer.`);
		}
		if (typeof r.retention !== "string" || !VALID_RETENTION.has(r.retention)) {
			throw new Error(
				`Role '${roleName}': has an invalid retention value: '${r.retention}'.`,
			);
		}
	}
}

function validateCapabilities(
	raw: Record<string, unknown>,
	sourceLabel: string,
): void {
	if (!isPlainObject(raw.capabilities)) {
		throw new Error("capabilities must be an object.");
	}
	for (const [capName, cap] of Object.entries(raw.capabilities)) {
		if (!isPlainObject(cap)) {
			throw new Error(`Capability '${capName}' must be an object.`);
		}
		const c = cap as Record<string, unknown>;
		for (const key of Object.keys(c)) {
			if (!KNOWN_CAPABILITY_FIELDS.has(key)) {
				throw new Error(`Unknown field '${key}' in capability '${capName}'.`);
			}
		}
		rejectCredentialFields(c, `${sourceLabel}.capabilities.${capName}`);

		if (typeof c.name !== "string" || !c.name.trim()) {
			throw new Error(`Capability '${capName}': name must be a non-empty string.`);
		}
		if (!Array.isArray(c.paths) || !c.paths.every((p: unknown) => typeof p === "string")) {
			throw new Error(`Capability '${capName}': paths must be an array of strings.`);
		}
		if (!Array.isArray(c.requiredTools) || !c.requiredTools.every((t: unknown) => typeof t === "string")) {
			throw new Error(
				`Capability '${capName}': requiredTools must be an array of strings.`,
			);
		}
	}
}

/**
 * Validates a layer value. Packaged layers are fully validated (all fields
 * required); user/cli layers are partially validated (only present fields
 * are checked, but unknown fields are still rejected).
 */
function validateLayer(
	raw: unknown,
	layer: ConfigLayer,
): Record<string, unknown> {
	const sourceLabel = layer.path;

	if (!isPlainObject(raw)) {
		throw new Error(
			`research configuration (${sourceLabel}) must be a JSON object.`,
		);
	}

	// Check for credential fields first (before unknown-field check so the
	// error message is specific rather than "Unknown field").
	rejectCredentialFields(raw, sourceLabel);

	if (layer.kind === "packaged") {
		// Packaged layers: full validation — all fields required.
		validateTopLevel(raw, sourceLabel);
		validateDefaults(raw, sourceLabel);
		validateRoles(raw, sourceLabel);
		validateCapabilities(raw, sourceLabel);
	} else {
		// User/cli layers: partial validation — only check present fields.
		validatePartialTopLevel(raw, sourceLabel);
		if ("defaults" in raw) validatePartialDefaults(raw, sourceLabel);
		if ("roles" in raw) validateRoles(raw, sourceLabel);
		if ("capabilities" in raw) validateCapabilities(raw, sourceLabel);
		if ("profiles" in raw) {
			// F1 fix: pass role names from this layer so cross-reference
			// validation (verification references) is performed within each
			// layer that supplies both profiles and roles.  The merged result
			// is still validated exhaustively in validateFinalConfig.
			const roleNames =
				"roles" in raw ? new Set(Object.keys(raw.roles as Record<string, unknown>)) : new Set();
			validatePartialProfiles(raw, sourceLabel, roleNames);
		}
	}

	// Resolve relative paths against the layer's directory
	// (resolvePaths returns a new object to avoid mutating the input)
	try {
		const layerDir = path.dirname(layer.path);
		return resolvePaths(raw, layerDir);
	} catch {
		// resolvePaths should never throw for well-formed input;
		// if it does, fall through with raw so the error bubbles up
		return raw;
	}
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Resolves a layered research configuration.
 *
 * Layers are merged in order (later layers override earlier ones).  Objects
 * are deep-merged recursively; arrays and primitives are replaced wholesale.
 * Relative promptPath, capability paths, and childExtensions values are
 * resolved against the directory of the layer that supplied them.
 * Packaged layers undergo full validation; user/cli layers undergo partial
 * validation (unknown fields are still rejected).
 */
export function resolveResearchConfig(
	layers: ConfigLayer[],
): ResolvedResearchConfig {
	if (layers.length === 0) {
		throw new Error("At least one config layer is required.");
	}

	// Validate and prepare each layer
	const prepared: Record<string, unknown>[] = [];
	for (const layer of layers) {
		const validated = validateLayer(layer.value, layer);
		prepared.push(validated);
	}

	// Merge layers in order
	let merged = prepared[0];
	for (let i = 1; i < prepared.length; i++) {
		merged = deepMerge(merged, prepared[i]);
	}

	// Final schema validation
	return validateFinalConfig(merged) as ResolvedResearchConfig;
}

function validateFinalConfig(raw: Record<string, unknown>): Record<string, unknown> {
	// Top-level checks
	if (!isPlainObject(raw)) {
		throw new Error("Resolved research config must be a JSON object.");
	}

	// Reject unknown top-level fields
	for (const key of Object.keys(raw)) {
		if (!KNOWN_TOP_LEVEL_FIELDS.has(key)) {
			throw new Error(`Unknown field '${key}' in resolved config.`);
		}
	}

	const defaultProgram = raw.defaultProgram;
	if (typeof defaultProgram !== "string" || !defaultProgram.trim()) {
		throw new Error("defaultProgram must be a non-empty string.");
	}

	const defaultProfile = raw.defaultProfile;
	if (typeof defaultProfile !== "string" || !defaultProfile.trim()) {
		throw new Error("defaultProfile must be a non-empty string.");
	}

	const defaultProvider = raw.defaultProvider;
	if (defaultProvider !== null && typeof defaultProvider !== "string") {
		throw new Error("defaultProvider must be a string or null.");
	}

	validateDefaults(raw, "resolved config");
	validateProfiles(raw, "resolved config", new Set(Object.keys(raw.roles ?? {})));
	validateRoles(raw, "resolved config");
	validateCapabilities(raw, "resolved config");

	const childExtensions = raw.childExtensions;
	if (!Array.isArray(childExtensions) || !childExtensions.every((c: unknown) => typeof c === "string")) {
		throw new Error("childExtensions must be an array of strings.");
	}

	return raw;
}

/**
 * Loads and validates the packaged research configuration from the
 * package's config/research.json.
 *
 * Exported for use by checkpoint evaluation and other modules that need
 * access to config thresholds without going through resolveResearchConfig.
 */
export function loadPackagedConfig(): ResolvedResearchConfig {
	const configDir = path.resolve(import.meta.dirname, "../../config");
	const configPath = path.join(configDir, "research.json");

	let raw: unknown;
	try {
		raw = JSON.parse(fs.readFileSync(configPath, "utf-8"));
	} catch (err) {
		if (err && typeof err === "object" && "code" in err) {
			const code = (err as { code: string }).code;
			if (code === "ENOENT") {
				throw new Error(
					`Cannot load packaged research configuration: ${configPath} not found.`,
				);
			}
		}
		throw err;
	}

	const layer: ConfigLayer = { path: configPath, kind: "packaged", value: raw };
	return resolveResearchConfig([layer]);
}

// ---------------------------------------------------------------------------
// Capability resolution
// ---------------------------------------------------------------------------

/**
 * Resolves a packaged capability by name.
 *
 * Only package-owned capability names are accepted.  User/provider
 * extensions must be supplied as explicit absolute paths elsewhere.
 */
export function resolveCapability(name: string): PackagedCapability {
	const config = loadPackagedConfig();
	const cap = config.capabilities[name];
	if (!cap) {
		throw new Error(`Unknown capability: '${name}'.`);
	}
	// Resolve relative paths to absolute paths based on the config directory.
	const configDir = path.resolve(import.meta.dirname, "../../config");
	const resolvedPaths = (cap.paths as string[]).map((p) =>
		path.isAbsolute(p) ? p : path.resolve(configDir, p),
	);
	return {
		name: cap.name,
		paths: resolvedPaths,
		requiredTools: cap.requiredTools,
	} as PackagedCapability;
}

// ---------------------------------------------------------------------------
// Final validation
// ---------------------------------------------------------------------------

/**
 * Validates a fully resolved research configuration.
 *
 * This is a no-op for configs produced by resolveResearchConfig (which
 * already validates), but is exposed for callers that construct configs
 * programmatically.
 */
export function validateResearchConfig(config: ResolvedResearchConfig): void {
	validateFinalConfig(config as unknown as Record<string, unknown>);
}
