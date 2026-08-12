import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
	ModelSelectEvent,
	TurnEndEvent,
	SessionBeforeCompactEvent,
	SessionCompactEvent,
	CompactOptions,
} from "@earendil-works/pi-coding-agent";
import { loadAutoCompactConfiguration } from "./config.ts";
import { resolveModelPolicy, resolveGlobalEnablement } from "./policy.ts";
import { AutoCompactController } from "./controller.ts";
import type { ResolvedPolicy } from "./policy.ts";

// ---------------------------------------------------------------------------
// Module-level state (session-local via reset on session_start / model_select)
// ---------------------------------------------------------------------------

const extensionDir = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(extensionDir, "../..");

const controller = new AutoCompactController();
export { controller };
let loadedConfig: ReturnType<typeof loadAutoCompactConfiguration> | null = null;
let currentPolicy: ResolvedPolicy | null = null;

/** Reset module-level state for testing. */
export function resetExtensionState(): void {
	controller.resetSession("unknown");
	loadedConfig = null;
	currentPolicy = null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function canonicalModelKey(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}

function loadConfiguration(trusted: boolean): void {
	loadedConfig = loadAutoCompactConfiguration({
		packageRoot,
		agentDir: getAgentDir(),
		cwd: process.cwd(),
		projectTrusted: trusted,
	});
}

function resolvePolicy(ctx: ExtensionContext): ResolvedPolicy | null {
	const model = ctx.model;
	if (!model) return null;
	const modelKey = canonicalModelKey(model);
	if (!loadedConfig) return null;
	const policy = resolveModelPolicy(
		loadedConfig.layers,
		modelKey,
		model.contextWindow,
	);
	return policy;
}

function evaluateUsage(ctx: ExtensionContext): { triggered: boolean } | null {
	const model = ctx.model;
	if (!model || !currentPolicy) return null;
	const usage = ctx.getContextUsage();
	if (usage === undefined) return null;
	if (usage.tokens === null) return null;
	return controller.evaluate({
		modelKey: canonicalModelKey(model),
		contextWindow: model.contextWindow,
		usageTokens: usage.tokens,
		policy: currentPolicy,
	});
}



function formatStatus(ctx: ExtensionContext): string {
	const lines: string[] = [];
	const status = controller.status();
	const config = loadedConfig;

	// Global enablement — use precedence-based resolution (highest-precedence
	// layer that *specifies* `enabled` wins, matching resolveModelPolicy).
	if (config) {
		const { enabled: globalEnabled } = resolveGlobalEnablement(config.layers);
		lines.push(`Auto-compact: ${globalEnabled ? "enabled" : "disabled"}`);
	} else {
		lines.push("Auto-compact: no configuration loaded");
	}

	// Model info
	if (ctx.model) {
		const key = canonicalModelKey(ctx.model);
		lines.push(`Model: ${key}`);
		lines.push(`Context window: ${ctx.model.contextWindow} tokens`);
	} else {
		lines.push("Model: unknown");
	}

	// Usage
	const usage = ctx.getContextUsage();
	if (usage && usage.tokens !== null) {
		lines.push(
		`Usage: ${usage.tokens} tokens (${usage.percent !== null ? `${usage.percent}%` : "unknown%"})`,
		);
	} else {
		lines.push("Usage: unknown");
	}

	// Policy
	if (currentPolicy) {
		lines.push(`Rule: ${currentPolicy.matchedPattern}`);
		lines.push(`Source: ${currentPolicy.source}`);
		if (currentPolicy.effectiveThresholdTokens !== null) {
		lines.push(
			`Threshold: ${currentPolicy.effectiveThresholdTokens} tokens`,
		);
		} else {
		lines.push("Threshold: disabled");
		}
	} else {
		lines.push("Rule: none matched");
		lines.push("Threshold: unknown");
	}

	// Controller state
	lines.push(
		`Controller: armed=${status.armed}, in-flight=${status.inFlight}`,
	);

	// Config paths
	if (config) {
		for (const p of config.loadedPaths) {
		lines.push(`Loaded: ${p}`);
		}
		for (const ig of config.ignoredPaths) {
		lines.push(`Ignored: ${ig.path} (${ig.reason})`);
		}
		for (const w of config.warnings) {
		lines.push(`Warning: ${w.message}`);
		}
	}

	if (status.lastError) {
		lines.push(`Last error: ${status.lastError}`);
	}

	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Extension factory
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	// session_start
	pi.on("session_start", (_event: SessionStartEvent, ctx: ExtensionContext) => {
		try {
		const trusted = ctx.isProjectTrusted();
		loadConfiguration(trusted);
		currentPolicy = resolvePolicy(ctx);
		controller.resetSession(
				ctx.model ? canonicalModelKey(ctx.model) : "unknown",
		);
		evaluateUsage(ctx);
		} catch {
		// Non-fatal: extension remains functional.
		}
	});

	// model_select
	pi.on("model_select", (event: ModelSelectEvent, ctx: ExtensionContext) => {
		try {
		const modelKey = canonicalModelKey(event.model);
		controller.resetSession(modelKey);
		if (loadedConfig) {
				currentPolicy = resolveModelPolicy(
					loadedConfig.layers,
					modelKey,
					event.model.contextWindow,
				);
		}
		evaluateUsage(ctx);
		} catch {
		// Non-fatal.
		}
	});

	// turn_end
	pi.on("turn_end", (_event: TurnEndEvent, ctx: ExtensionContext) => {
		try {
		// Re-resolve policy in case model changed without model_select.
		const model = ctx.model;
		if (model) {
			const modelKey = canonicalModelKey(model);
			if (
				!currentPolicy ||
				controller.status().modelKey !== modelKey
			) {
				if (loadedConfig) {
					currentPolicy = resolveModelPolicy(
						loadedConfig.layers,
						modelKey,
						model.contextWindow,
					);
				}
			}
		}
		const result = evaluateUsage(ctx);
		if (result?.triggered) {
			const options: CompactOptions = {
				onComplete: () => {
					controller.recordComplete();
					if (ctx.hasUI) {
						ctx.ui.notify("Auto-compaction completed", "info");
					}
				},
				onError: (error: Error) => {
					controller.recordFailure(error);
					if (ctx.hasUI) {
						ctx.ui.notify(
							`Auto-compaction failed: ${error.message}`,
							"error",
						);
					}
				},
			};
			ctx.compact(options);
		}
		} catch {
			// Non-fatal.
		}
	});

	// session_before_compact
	pi.on(
		"session_before_compact",
		(event: SessionBeforeCompactEvent, _ctx: ExtensionContext) => {
		try {
			const allowed = controller.gate({
				reason: event.reason,
				tokens: event.preparation.tokensBefore,
				policy: currentPolicy,
			});
			if (!allowed) {
				return { cancel: true } as const;
			}
			return {} as const;
		} catch {
			// Fail open: allow Pi to continue.
			return {} as const;
		}
		},
	);

	// session_compact
	pi.on("session_compact", (_event: SessionCompactEvent, _ctx: ExtensionContext) => {
		try {
		controller.recordComplete();
		} catch {
		// Non-fatal.
		}
	});

	// /auto-compact status command
	pi.registerCommand("auto-compact", {
		description: "Show auto-compaction status and active policy.",
		handler: async (_args: string, ctx: ExtensionContext) => {
		const report = formatStatus(ctx);
		if (ctx.hasUI) {
			ctx.ui.notify(report, "info");
		}
		},
	});
}
