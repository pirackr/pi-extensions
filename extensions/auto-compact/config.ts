import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import type {
	ConfigLayer,
	ConfigLayerSource,
	ModelRule,
	ModelRuleDefault,
	PolicyWarning,
} from "./policy.ts";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface LoadConfigurationOptions {
	packageRoot: string;
	agentDir: string;
	cwd: string;
	projectTrusted: boolean;
}

export interface LoadedConfiguration {
	layers: ConfigLayer[];
	loadedPaths: string[];
	ignoredPaths: { path: string; reason: string }[];
	warnings: PolicyWarning[];
}

// ---------------------------------------------------------------------------
// Validation helpers
// ---------------------------------------------------------------------------

const KNOWN_TOP_LEVEL_FIELDS = new Set(["enabled", "default", "rules"]);
const KNOWN_RULE_FIELDS = new Set(["match", "enabled", "percent", "tokens"]);

function validateDefault(
	raw: unknown,
	filePath: string,
	warnings: PolicyWarning[],
): ModelRuleDefault | null {
	if (raw === undefined || raw === null) return null;
	if (typeof raw !== "object" || Array.isArray(raw) || raw === null) {
		warnings.push({
			code: "invalid-threshold",
			message: `Invalid 'default' field in ${filePath}: must be an object with exactly one of 'percent' or 'tokens'.`,
		});
		return null;
	}
	const obj = raw as Record<string, unknown>;
	const keys = Object.keys(obj);
	const hasPercent = "percent" in obj;
	const hasTokens = "tokens" in obj;

	if (keys.length !== 1 || !(hasPercent || hasTokens)) {
		warnings.push({
			code: "invalid-threshold",
			message: `Invalid 'default' field in ${filePath}: must be an object with exactly one of 'percent' or 'tokens'.`,
		});
		return null;
	}

	if (hasPercent) {
		const p = obj.percent;
		if (typeof p !== "number" || p <= 0 || p > 100) {
			warnings.push({
				code: "invalid-threshold",
				message: `Invalid 'default' field in ${filePath}: 'percent' must be a number in (0, 100].`,
			});
			return null;
		}
		return { percent: p };
	}

	if (hasTokens) {
		const t = obj.tokens;
		if (typeof t !== "number" || !Number.isInteger(t) || t <= 0) {
			warnings.push({
				code: "invalid-threshold",
				message: `Invalid 'default' field in ${filePath}: 'tokens' must be a positive integer.`,
			});
			return null;
		}
		return { tokens: t };
	}

	return null;
}

function validateRule(
	raw: unknown,
	filePath: string,
	warnings: PolicyWarning[],
): ModelRule | null {
	if (typeof raw !== "object" || Array.isArray(raw) || raw === null) {
		warnings.push({
			code: "invalid-rule",
			message: `Invalid rule in ${filePath}: each rule must be an object.`,
		});
		return null;
	}
	const obj = raw as Record<string, unknown>;

	// Strict unknown-field rejection at rule level
	for (const key of Object.keys(obj)) {
		if (!KNOWN_RULE_FIELDS.has(key)) {
			warnings.push({
				code: "invalid-unknown-field",
				message: `Unknown field '${key}' in rule object in ${filePath}.`,
			});
			return null;
		}
	}

	const match = obj.match;
	if (typeof match !== "string" || match === "") {
		warnings.push({
			code: "invalid-rule",
			message: `Invalid rule in ${filePath}: 'match' is required and must be a non-empty string.`,
		});
		return null;
	}

	const hasEnabled = "enabled" in obj;
	const enabled = hasEnabled ? (obj.enabled as boolean) : true;
	if (hasEnabled && typeof enabled !== "boolean") {
		warnings.push({
			code: "invalid-rule",
			message: `Invalid rule in ${filePath}: 'enabled' must be a boolean.`,
		});
		return null;
	}

	const hasPercent = "percent" in obj;
	const hasTokens = "tokens" in obj;

	if (enabled) {
		if (hasPercent && hasTokens) {
			warnings.push({
				code: "invalid-threshold",
				message: `Invalid rule in ${filePath}: enabled rule must have exactly one of 'percent' or 'tokens'.`,
			});
			return null;
		}
		if (!hasPercent && !hasTokens) {
			warnings.push({
				code: "invalid-threshold",
				message: `Invalid rule in ${filePath}: enabled rule must have exactly one of 'percent' or 'tokens'.`,
			});
			return null;
		}
		if (hasPercent) {
			const p = obj.percent;
			if (typeof p !== "number" || p <= 0 || p > 100) {
				warnings.push({
					code: "invalid-threshold",
					message: `Invalid rule in ${filePath}: 'percent' must be a number in (0, 100].`,
				});
				return null;
			}
		}
		if (hasTokens) {
			const t = obj.tokens;
			if (typeof t !== "number" || !Number.isInteger(t) || t <= 0) {
				warnings.push({
					code: "invalid-threshold",
					message: `Invalid rule in ${filePath}: 'tokens' must be a positive integer.`,
				});
				return null;
			}
		}
	} else {
		// Disabled rule must have neither percent nor tokens
		if (hasPercent || hasTokens) {
			warnings.push({
				code: "invalid-threshold",
				message: `Invalid rule in ${filePath}: disabled rule must not have 'percent' or 'tokens'.`,
			});
			return null;
		}
	}

	return {
		match,
		...(hasEnabled ? { enabled: enabled as boolean } : {}),
		...(hasPercent ? { percent: obj.percent as number } : {}),
		...(hasTokens ? { tokens: obj.tokens as number } : {}),
	};
}

function validateConfig(
	raw: unknown,
	filePath: string,
	source: ConfigLayerSource,
	warnings: PolicyWarning[],
): ConfigLayer | null {
	if (typeof raw !== "object" || Array.isArray(raw) || raw === null) {
		warnings.push({
			code: source === "packaged" ? "invalid-project-config" : "invalid-user-config",
			message: `Invalid configuration in ${filePath}: root must be an object.`,
		});
		return null;
	}
	const obj = raw as Record<string, unknown>;

	// Strict unknown-field rejection at top level
	for (const key of Object.keys(obj)) {
		if (!KNOWN_TOP_LEVEL_FIELDS.has(key)) {
			warnings.push({
				code: "invalid-unknown-field",
				message: `Unknown field '${key}' in ${filePath}.`,
			});
			return null;
		}
	}

	const result: ConfigLayer = { source };

	// enabled
	if ("enabled" in obj) {
		if (typeof obj.enabled !== "boolean") {
			warnings.push({
				code: "invalid-user-config",
				message: `Invalid 'enabled' field in ${filePath}: must be a boolean.`,
			});
			return null;
		}
		result.enabled = obj.enabled;
	}

	// default
	if ("default" in obj) {
		const defaultResult = validateDefault(obj.default, filePath, warnings);
		if (defaultResult === null) return null;
		result.default = defaultResult;
	}

	// rules
	if ("rules" in obj) {
		if (!Array.isArray(obj.rules)) {
			warnings.push({
				code: "invalid-rule",
				message: `Invalid 'rules' field in ${filePath}: must be an array.`,
			});
			return null;
		}
		const validRules: ModelRule[] = [];
		const ruleCount = (obj.rules as unknown[]).length;
		for (const rule of obj.rules) {
			const validated = validateRule(rule, filePath, warnings);
			if (validated) {
				validRules.push(validated);
			}
		}
		// Any invalid rule makes the whole layer invalid
		if (validRules.length < ruleCount) {
			return null;
		}
		result.rules = validRules;
	}

	return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load, parse, strictly validate, and layer auto-compaction configuration.
 *
 * Layers are ordered lowest → highest precedence: packaged, user, project.
 * Packaged configuration errors are fatal. User/project errors cause the
 * offending layer to be ignored atomically while lower valid layers remain.
 */
export function loadAutoCompactConfiguration(
	options: LoadConfigurationOptions,
): LoadedConfiguration {
	const { packageRoot, agentDir, cwd, projectTrusted } = options;
	const layers: ConfigLayer[] = [];
	const loadedPaths: string[] = [];
	const ignoredPaths: { path: string; reason: string }[] = [];
	const warnings: PolicyWarning[] = [];

	// ------------------------------------------------------------------
	// 1. Packaged config (mandatory — fatal if missing/unparseable/invalid)
	// ------------------------------------------------------------------
	const packagedPath = resolve(packageRoot, "config", "auto-compact.json");
	try {
		const raw = JSON.parse(
			readFileSync(packagedPath, "utf-8"),
		) as Record<string, unknown>;
		const layer = validateConfig(raw, packagedPath, "packaged", warnings);
		if (layer === null) {
			throw new Error(
				`Packaged auto-compaction configuration is invalid: ${packagedPath}`,
			);
		}
		layers.push(layer);
		loadedPaths.push(packagedPath);
	} catch (err) {
		if (err instanceof Error && err.message.startsWith("Packaged")) {
			throw err;
		}
		throw new Error(
			`Cannot load packaged auto-compaction configuration from ${packagedPath}: ${String(err)}`,
		);
	}

	// ------------------------------------------------------------------
	// 2. User config (optional — ignored atomically if invalid)
	// ------------------------------------------------------------------
	const userPath = resolve(agentDir, "auto-compact", "config.json");
	try {
		const raw = JSON.parse(
			readFileSync(userPath, "utf-8"),
		) as Record<string, unknown>;
		const layer = validateConfig(raw, userPath, "user", warnings);
		if (layer === null) {
			ignoredPaths.push({
				path: userPath,
				reason: "invalid configuration",
			});
		} else {
			layers.push(layer);
			loadedPaths.push(userPath);
		}
	} catch (err: unknown) {
		if (
			err &&
			typeof err === "object" &&
			"code" in err &&
			(err as { code: string }).code === "ENOENT"
		) {
			// User config doesn't exist — fine.
		} else {
			ignoredPaths.push({
				path: userPath,
				reason: "unreadable configuration",
			});
		}
	}

	// ------------------------------------------------------------------
	// 3. Project config (optional — ignored if untrusted or invalid)
	// ------------------------------------------------------------------
	if (!projectTrusted) {
		const projectPath = resolve(cwd, CONFIG_DIR_NAME, "auto-compact.json");
		ignoredPaths.push({
			path: projectPath,
			reason: "project not trusted",
		});
	} else {
		const projectPath = resolve(cwd, CONFIG_DIR_NAME, "auto-compact.json");
		try {
			const raw = JSON.parse(
				readFileSync(projectPath, "utf-8"),
			) as Record<string, unknown>;
			const layer = validateConfig(raw, projectPath, "project", warnings);
			if (layer === null) {
				ignoredPaths.push({
					path: projectPath,
					reason: "invalid configuration",
				});
			} else {
				layers.push(layer);
				loadedPaths.push(projectPath);
			}
		} catch (err: unknown) {
			if (
				err &&
				typeof err === "object" &&
				"code" in err &&
				(err as { code: string }).code === "ENOENT"
			) {
				// Project config doesn't exist — fine.
			} else {
				ignoredPaths.push({
					path: projectPath,
					reason: "unreadable configuration",
				});
			}
		}
	}

	return { layers, loadedPaths, ignoredPaths, warnings };
}
