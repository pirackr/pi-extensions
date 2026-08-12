import { minimatch } from "minimatch";

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
	const { enabled: globalEnabled, source: globalSource } = resolveGlobalEnablement(layers);

	// If globally disabled, short-circuit immediately: do not search rules.
	// This preserves the invariant that the gate discriminator
	// `matchedPattern === "default"` distinguishes global-disable from
	// disabled-rule. (See task-5-report.md round-4 fix.)
	if (!globalEnabled) {
		return {
			source: globalSource,
			matchedPattern: "default",
			enabled: false,
			effectiveThresholdTokens: null,
			warnings,
		};
	}

	// Search layers from highest to lowest precedence; first rule match wins.
	const reversed = [...layers].reverse();
	for (const layer of reversed) {
		const rules = layer.rules ?? [];
		for (const rule of rules) {
			if (matchesPattern(modelKey, rule.match)) {
				return resolveRule(layer.source, rule, contextWindow, warnings, true);
			}
		}
	}

	// No rule matched — fall back to the highest-precedence specified default.
	const defaultResult = resolveDefault(layers);
	if (defaultResult) {
		return resolveDefaultAsPolicy(
			defaultResult.source,
			defaultResult.value,
			contextWindow,
			warnings,
			true,
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
	return minimatch(modelKey, pattern, { nonegate: true, nobrace: true });
}

function resolveGlobalEnablement(layers: ConfigLayer[]): { enabled: boolean; source: ConfigLayerSource } {
	for (let i = layers.length - 1; i >= 0; i--) {
		if (layers[i].enabled !== undefined) {
			return { enabled: layers[i].enabled!, source: layers[i].source };
		}
	}
	return { enabled: false, source: "none" };
}

function resolveDefault(
	layers: ConfigLayer[],
): { source: ConfigLayerSource; value: ModelRuleDefault } | undefined {
	for (let i = layers.length - 1; i >= 0; i--) {
		if (layers[i].default !== undefined) {
			return { source: layers[i].source, value: layers[i].default! };
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
		const hasPercent = rule.percent !== undefined;
		const hasTokens = rule.tokens !== undefined;
		if (hasPercent && hasTokens) {
			warnings.push({
				code: "both-percent-and-tokens-defined",
				message: `Rule matches '${rule.match}': both percent and tokens defined; percent takes priority.`,
			});
		} else if (!hasPercent && !hasTokens) {
			warnings.push({
				code: "neither-percent-nor-tokens-defined",
				message: `Rule matches '${rule.match}': neither percent nor tokens defined; threshold is null.`,
			});
		}
		if (hasPercent) {
			thresholdTokens = Math.floor((contextWindow * rule.percent!) / 100);
		} else if (hasTokens) {
			thresholdTokens = rule.tokens!;
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
