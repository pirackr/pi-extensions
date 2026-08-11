import { Minimatch } from "minimatch";

// ---------------------------------------------------------------------------
// Types (aligned with the design doc Configuration Schema)
// ---------------------------------------------------------------------------

export type ConfigLayerSource = "packaged" | "user" | "project" | "none";

export interface ConfigLayer {
	source: ConfigLayerSource;
	enabled?: boolean;
	default?: ModelRuleDefault;
	rules?: ModelRule[];
}

export type ModelRuleDefault =
	| { percent: number }
	| { tokens: number };

export interface ModelRule {
	match: string;
	enabled?: boolean;
	percent?: number;
	tokens?: number;
}

export interface ResolvedPolicy {
	source: ConfigLayerSource;
	matchedPattern: string;
	enabled: boolean;
	effectiveThresholdTokens: number | null;
	warnings: PolicyWarning[];
}

export interface PolicyWarning {
	code: string;
	message: string;
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Resolve the effective auto-compaction policy for a given model key.
 *
 * Layers are ordered lowest → highest precedence: [packaged, user, project].
 * Resolution searches from highest to lowest precedence; within each layer
 * the first matching rule wins (first-match ordering).
 *
 * @param layers      Ordered from lowest to highest precedence.
 * @param modelKey    Canonical `provider/model-id` key (case-sensitive).
 * @param contextWindow  Active model's context window in tokens.
 */
export function resolveModelPolicy(
	layers: ConfigLayer[],
	modelKey: string,
	contextWindow: number,
): ResolvedPolicy {
	const warnings: PolicyWarning[] = [];

	// Determine global enablement from the highest-precedence layer that
	// specifies `enabled`.
	const enabled = resolveGlobalEnablement(layers);

	// Search layers from highest to lowest precedence; first rule match wins.
	const reversed = [...layers].reverse();
	for (const layer of reversed) {
		const rules = layer.rules ?? [];
		for (const rule of rules) {
			if (matchesPattern(modelKey, rule.match)) {
				return resolveRule(layer.source, rule, contextWindow, warnings, enabled);
			}
		}
	}

	// No rule matched — fall back to the highest-precedence specified default.
	const defaultValue = resolveDefault(layers);
	if (defaultValue) {
		return resolveDefaultAsPolicy(
			reversed[0].source,
			defaultValue,
			contextWindow,
			warnings,
			enabled,
		);
	}

	// Nothing specified anywhere.
	return {
		source: "none",
		matchedPattern: "default",
		enabled: false,
		effectiveThresholdTokens: null,
		warnings,
	};
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function matchesPattern(modelKey: string, pattern: string): boolean {
	return new Minimatch(pattern, { nonegate: true, nobrace: true }).match(modelKey);
}

function resolveGlobalEnablement(layers: ConfigLayer[]): boolean {
	for (let i = layers.length - 1; i >= 0; i--) {
		if (layers[i].enabled !== undefined) {
			return layers[i].enabled;
		}
	}
	return false;
}

function resolveDefault(layers: ConfigLayer[]): ModelRuleDefault | undefined {
	for (let i = layers.length - 1; i >= 0; i--) {
		if (layers[i].default !== undefined) {
			return layers[i].default;
		}
	}
	return undefined;
}

function resolveRule(
	source: ConfigLayerSource,
	rule: ModelRule,
	contextWindow: number,
	warnings: PolicyWarning[],
	globalEnabled: boolean,
): ResolvedPolicy {
	const ruleEnabled = rule.enabled ?? true;
	const effectiveEnabled = globalEnabled && ruleEnabled;

	let thresholdTokens: number | null = null;

	if (ruleEnabled) {
		if (rule.percent !== undefined) {
			thresholdTokens = Math.floor((contextWindow * rule.percent) / 100);
		} else if (rule.tokens !== undefined) {
			thresholdTokens = rule.tokens;
			if (thresholdTokens > contextWindow) {
				warnings.push({
					code: "oversized-absolute-threshold",
					message: `Absolute threshold ${thresholdTokens} exceeds context window ${contextWindow}; not clamped.`,
				});
			}
		}
	}

	return {
		source,
		matchedPattern: rule.match,
		enabled: effectiveEnabled,
		effectiveThresholdTokens: thresholdTokens,
		warnings,
	};
}

function resolveDefaultAsPolicy(
	source: ConfigLayerSource,
	defaultValue: ModelRuleDefault,
	contextWindow: number,
	warnings: PolicyWarning[],
	globalEnabled: boolean,
): ResolvedPolicy {
	let thresholdTokens: number | null = null;

	if ("percent" in defaultValue) {
		thresholdTokens = Math.floor((contextWindow * defaultValue.percent) / 100);
	} else if ("tokens" in defaultValue) {
		thresholdTokens = defaultValue.tokens;
		if (thresholdTokens > contextWindow) {
			warnings.push({
				code: "oversized-absolute-threshold",
				message: `Absolute threshold ${thresholdTokens} exceeds context window ${contextWindow}; not clamped.`,
			});
		}
	}

	return {
		source,
		matchedPattern: "default",
		enabled: globalEnabled,
		effectiveThresholdTokens: globalEnabled ? thresholdTokens : null,
		warnings,
	};
}
