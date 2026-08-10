// extensions/web-search/config.ts
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Type, TSchema } from "typebox";

// ---------------------------------------------------------------------------
// Packaged defaults (mirrors config/web-search.json)
// ---------------------------------------------------------------------------

const PACKAGED_DEFAULTS = {
	routing: {
		searchAuto: ["tinyfish", "exa", "duckduckgo"],
		fetch: ["tinyfish", "readability"],
	},
	providers: {
		tinyfish: {
			search: { capacity: 30, windowMs: 60000, maxRetries: 1 },
			fetch: { capacity: 150, windowMs: 60000, maxRetries: 1 },
		},
		exa: {
			search: { capacity: 10, windowMs: 1000, maxRetries: 1 },
		},
		tavily: {
			search: { capacity: 100, windowMs: 60000, maxRetries: 1 },
		},
		duckduckgo: {
			search: {
				capacity: null,
				windowMs: 60000,
				maxRetries: 1,
				fallbackCooldownMs: 60000,
			},
		},
	},
} as const;

// ---------------------------------------------------------------------------
// Known values for validation
// ---------------------------------------------------------------------------

const KNOWN_PROVIDERS = new Set([
	"tinyfish",
	"exa",
	"tavily",
	"duckduckgo",
]);

const KNOWN_OPERATIONS = new Set(["search", "fetch"]);

const KNOWN_ROUTING_ENGINES = new Set([
	"tinyfish",
	"exa",
	"duckduckgo",
	"readability",
	"tavily",
]);

// Fields that should never contain secret values
const SENSITIVE_FIELD_PATTERNS = [
	/sk-/i,
	/key$/i,
	/authorization/i,
	/token/i,
];

// ---------------------------------------------------------------------------
// Deep merge
// ---------------------------------------------------------------------------

/**
 * Deep-merges `overrides` over `base`. Plain objects merge recursively;
 * arrays and primitives are replaced wholesale.
 */
function deepMerge<T extends Record<string, unknown>>(
	base: T,
	overrides: Record<string, unknown>,
): T {
	const result = { ...base } as Record<string, unknown>;
	for (const [key, overrideValue] of Object.entries(overrides)) {
		if (
			overrideValue !== null &&
			typeof overrideValue === "object" &&
			!Array.isArray(overrideValue) &&
			result[key] !== null &&
			typeof result[key] === "object" &&
			!Array.isArray(result[key])
		) {
			result[key] = deepMerge(
				result[key] as Record<string, unknown>,
				overrideValue as Record<string, unknown>,
			);
		} else {
			result[key] = overrideValue;
		}
	}
	return result as T;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

interface ValidationError {
	path: string;
	message: string;
}

function validateConfig(
	config: Record<string, unknown>,
): { valid: boolean; errors: ValidationError[]; warnings: string[] } {
	const errors: ValidationError[] = [];
	const warnings: string[] = [];

	// --- routing ---
	const routing = config.routing;
	if (routing && typeof routing === "object") {
		for (const op of ["searchAuto", "fetch"] as const) {
			const arr = (routing as Record<string, unknown>)[op];
			if (Array.isArray(arr)) {
				for (const engine of arr) {
					if (typeof engine === "string" && !KNOWN_ROUTING_ENGINES.has(engine)) {
						errors.push({
							path: `routing.${op}`,
							message: `unknown engine "${engine}"`,
						});
					}
				}
			}
		}
	}

	// --- providers ---
	const providers = config.providers;
	if (providers && typeof providers === "object") {
		for (const [provider, providerCfg] of Object.entries(providers)) {
			if (typeof providerCfg !== "object" || providerCfg === null) continue;
			const providerObj = providerCfg as Record<string, unknown>;

			// Warn for unknown providers
			if (!KNOWN_PROVIDERS.has(provider)) {
				warnings.push(`unknown provider "${provider}" in configuration`);
			}

			// Check for sensitive fields
			for (const [field, value] of Object.entries(providerObj)) {
				for (const pattern of SENSITIVE_FIELD_PATTERNS) {
					if (pattern.test(field) && typeof value === "string" && value.length > 0) {
						warnings.push(
							`provider.${provider}.${field}: secret values are not permitted in JSON configuration`,
						);
						// Remove the sensitive field so it doesn't pollute the config
						delete (providerObj as Record<string, unknown>)[field];
					}
				}
			}

			for (const [operation, opCfg] of Object.entries(providerObj)) {
				if (typeof opCfg !== "object" || opCfg === null) continue;
				const opObj = opCfg as Record<string, unknown>;
				const path = `providers.${provider}.${operation}`;

				// Check for sensitive fields within the operation object too
				for (const [field, value] of Object.entries(opObj)) {
					for (const pattern of SENSITIVE_FIELD_PATTERNS) {
						if (pattern.test(field) && typeof value === "string" && value.length > 0) {
							warnings.push(
								`provider.${provider}.${operation}.${field}: secret values are not permitted in JSON configuration`,
							);
							// Remove the sensitive field so it doesn't pollute the config
							delete (opObj as Record<string, unknown>)[field];
						}
					}
				}

				// capacity: number > 0 or null
				if ("capacity" in opObj) {
					const cap = opObj.capacity;
					if (cap !== null && (typeof cap !== "number" || cap <= 0)) {
						errors.push({
							path,
							message: `capacity must be a positive number or null, got ${JSON.stringify(cap)}`,
						});
					}
				}

				// windowMs: number > 0
				if ("windowMs" in opObj) {
					const wm = opObj.windowMs;
					if (typeof wm !== "number" || wm <= 0) {
						errors.push({
							path,
							message: `windowMs must be a positive number, got ${JSON.stringify(wm)}`,
						});
					}
				}

				// maxRetries: integer >= 0
				if ("maxRetries" in opObj) {
					const mr = opObj.maxRetries;
					if (
						typeof mr !== "number" ||
						mr < 0 ||
						!Number.isInteger(mr)
					) {
						errors.push({
							path,
							message: `maxRetries must be a non-negative integer, got ${JSON.stringify(mr)}`,
						});
					}
				}

				// fallbackCooldownMs: number > 0 (where present)
				if ("fallbackCooldownMs" in opObj) {
					const fcm = opObj.fallbackCooldownMs;
					if (typeof fcm !== "number" || fcm <= 0) {
						errors.push({
							path,
							message: `fallbackCooldownMs must be a positive number, got ${JSON.stringify(fcm)}`,
						});
					}
				}
			}
		}
	}

	return {
		valid: errors.length === 0,
		errors,
		warnings,
	};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface WebSearchConfig {
	routing: {
		searchAuto: string[];
		fetch: string[];
	};
	providers: Record<
		string,
		Record<
			string,
			{
				capacity: number | null;
				windowMs: number;
				maxRetries: number;
				fallbackCooldownMs?: number;
			}
		>
	>;
}

export interface LoadConfigResult {
	config: WebSearchConfig;
	warnings: string[];
}

/**
 * Loads and validates the web-search configuration.
 *
 * Layering order:
 * 1. Packaged defaults from config/web-search.json
 * 2. User override from $PI_AGENT_DIR/web-search.json (deep-merged)
 *
 * Invalid user configuration produces visible warnings and falls back to the
 * validated packaged defaults. API keys are never permitted in JSON files.
 */
export async function loadWebSearchConfig(): Promise<LoadConfigResult> {
	const warnings: string[] = [];

	// 1. Load packaged defaults
	let config = JSON.parse(
		readFileSync(
			resolve(import.meta.dirname, "../../config/web-search.json"),
			"utf-8",
		),
	) as Record<string, unknown>;

	// 2. Load user override if present
	const agentDir =
		process.env.PI_AGENT_DIR || resolve(process.env.HOME || "", ".pi", "agent");
	const userConfigPath = resolve(agentDir, "web-search.json");
	try {
		const userRaw = readFileSync(userConfigPath, "utf-8");
		const userConfig = JSON.parse(userRaw) as Record<string, unknown>;
		config = deepMerge(config, userConfig);
	} catch (err: unknown) {
		// User config doesn't exist or is unreadable — that's fine
		if (err && typeof err === "object" && "code" in err) {
			const code = (err as { code: string }).code;
			if (code !== "ENOENT") {
				warnings.push(`could not read user config: ${String(err)}`);
			}
		}
	}

	// 3. Validate
	const { valid, errors, warnings: validationWarnings } = validateConfig(config);
	warnings.push(...validationWarnings);

	if (!valid) {
		// Invalid user configuration — log warnings and fall back to packaged defaults
		for (const err of errors) {
			warnings.push(`invalid config at ${err.path}: ${err.message}`);
		}
		config = JSON.parse(
			readFileSync(
				resolve(import.meta.dirname, "../../config/web-search.json"),
				"utf-8",
			),
		) as Record<string, unknown>;
	}

	return {
		config: config as unknown as WebSearchConfig,
		warnings,
	};
}
