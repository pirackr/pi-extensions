import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type {
	ExtensionAPI,
	ExtensionContext,
	SessionStartEvent,
	ModelSelectEvent,
	AgentSettledEvent,
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
/**
 * Timestamp of the last compaction entry written (by this extension or by Pi).
 * Guards the double-compaction race: Pi's native auto-compaction may complete
 * right before our post-run trigger evaluates, leaving a stale over-threshold
 * usage snapshot that would otherwise fire a second compact.
 */
let lastCompactAt = 0;
const COMPACT_COOLDOWN_MS = 5000;

/** Reset module-level state for testing. */
export function resetExtensionState(): void {
	controller.resetSession("unknown");
	loadedConfig = null;
	currentPolicy = null;
	lastCompactAt = 0;
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

/**
 * Pi's native auto-compaction can run concurrently with this extension's
 * agent_settled trigger. When it wins the race, our manual `ctx.compact()`
 * call fails with a benign error that means "nothing to do", not "compaction
 * is broken". Treat these as a completed cycle so the controller rearms
 * instead of recording a spurious failure.
 */
function isBenignCompactionError(error: Error): boolean {
	const message = error.message;
	return (
		message.includes("Already compacted") ||
		message.includes("Nothing to compact") ||
		message.includes("Compaction cancelled")
	);
}

/**
 * Launch the extension's own compaction. Only call at an idle (post-run)
 * point: ctx.compact() maps to session.compact(), which aborts the active
 * agent run before summarizing.
 */
function fireCompact(ctx: ExtensionContext): void {
	const options: CompactOptions = {
		onComplete: () => {
			lastCompactAt = Date.now();
			controller.recordComplete();
			if (ctx.hasUI) {
				ctx.ui.notify("Auto-compaction completed", "info");
			}
		},
		onError: (error: Error) => {
			if (isBenignCompactionError(error)) {
				// Pi's native auto-compaction already compacted (or the session is
				// too small to compact) — a benign race with this extension's own
				// post-run trigger. Treat it as a completed cycle, not an error.
				lastCompactAt = Date.now();
				controller.recordComplete();
				return;
			}
			controller.recordFailure(error);
			if (ctx.hasUI) {
				ctx.ui.notify(`Auto-compaction failed: ${error.message}`, "error");
			}
		},
	};
	ctx.compact(options);
}

/**
 * Evaluate context usage and fire compaction only when safe: the session must
 * be idle (never mid-run, where compact()'s abort would kill the run) and no
 * compaction entry may have been written within the cooldown window (a stale
 * over-threshold snapshot from Pi's just-completed native compaction).
 */
function maybeFireAtIdle(ctx: ExtensionContext): void {
	const result = evaluateUsage(ctx);
	if (!result?.triggered) {
		return;
	}
	if (!ctx.isIdle()) {
		// Run still active (possible at model_select; agent_settled is always
		// idle). Firing now would abort the live run — defer to the next
		// evaluation instead.
		controller.deferTrigger();
		return;
	}
	if (Date.now() - lastCompactAt < COMPACT_COOLDOWN_MS) {
		// Pi's native auto-compaction just wrote a compaction entry — this
		// usage snapshot is stale, not a new crossing. Drop the trigger.
		controller.deferTrigger();
		return;
	}
	fireCompact(ctx);
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
			lines.push(`Threshold: ${currentPolicy.effectiveThresholdTokens} tokens`);
		} else {
			lines.push("Threshold: disabled");
		}
	} else {
		lines.push("Rule: none matched");
		lines.push("Threshold: unknown");
	}

	// Controller state
	lines.push(`Controller: armed=${status.armed}, in-flight=${status.inFlight}`);

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
			// A resumed session may already exceed the effective threshold;
			// session start is always run-free, so fire immediately.
			maybeFireAtIdle(ctx);
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
			maybeFireAtIdle(ctx);
		} catch {
			// Non-fatal.
		}
	});

	// agent_settled — post-run trigger.
	//
	// Compaction MUST NOT be fired from turn_end: that event is emitted between
	// tool-call batches INSIDE an active agent run (pi-agent-core agent-loop),
	// and session.compact() begins with abort(), which kills the live run
	// ("This operation was aborted" + a dead session). agent_settled fires once
	// per prompt run, after the run fully finishes AND after Pi's own native
	// compaction check (_handlePostAgentRun), so it is the safe point: abort()
	// is a no-op and the native attempt has already won or lost.
	pi.on("agent_settled", (_event: AgentSettledEvent, ctx: ExtensionContext) => {
		try {
			// Re-resolve policy in case model changed without model_select.
			const model = ctx.model;
			if (model) {
				const modelKey = canonicalModelKey(model);
				if (!currentPolicy || controller.status().modelKey !== modelKey) {
					if (loadedConfig) {
						currentPolicy = resolveModelPolicy(
							loadedConfig.layers,
							modelKey,
							model.contextWindow,
						);
					}
				}
			}
			// A compaction entry was written moments ago (Pi's native
			// auto-compaction completing while our session_compact handler was
			// missed) but the controller still reports in-flight — unstick it
			// so the next threshold crossing can trigger normally.
			if (
				controller.status().inFlight &&
				Date.now() - lastCompactAt < COMPACT_COOLDOWN_MS
			) {
				controller.recordComplete();
			}
			maybeFireAtIdle(ctx);
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
	pi.on(
		"session_compact",
		(_event: SessionCompactEvent, _ctx: ExtensionContext) => {
			try {
				lastCompactAt = Date.now();
				controller.recordComplete();
			} catch {
				// Non-fatal.
			}
		},
	);

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
