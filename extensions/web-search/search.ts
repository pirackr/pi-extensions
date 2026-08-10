// extensions/web-search/search.ts
import type {
	EngineChoice,
	SearchResponse,
	SearchResult,
	WebLookupRequest,
	WebLookupContext,
	Credentials,
} from "./types.ts";
import { TinyFishEngine } from "./engines/tinyfish.ts";
import { ExaEngine } from "./engines/exa.ts";
import { DuckDuckGoEngine } from "./engines/duckduckgo.ts";
import { TavilyEngine } from "./engines/tavily.ts";
import { loadCredentials } from "./credentials.ts";
import { loadWebSearchConfig } from "./config.ts";
import { createCoordinator } from "./rate-limit.ts";
import {
	classifyError,
	isRetryable,
	errorText,
	type ErrorCategory,
} from "./errors.ts";
import { resolve, join } from "node:path";

/**
 * Default state directory for the rate-limit coordinator.
 */
function defaultStateDir(): string {
	const agentDir =
		process.env.PI_AGENT_DIR ||
		resolve(process.env.HOME || "", ".pi", "agent");
	return join(agentDir, "cache", "web-search");
}

/**
 * Fallback chain walked by engine: "auto" — TinyFish first, then Exa, then
 * DuckDuckGo.
 */
const chainEngines: (new (key: string) => import("./types.ts").SearchEngineAdapter)[] =
	[TinyFishEngine, ExaEngine, DuckDuckGoEngine];

/**
 * Every available engine. Engines NOT in chainEngines are opt-in only:
 * they run solely when the model passes engine: "<name>" explicitly.
 */
export const searchEngines: { name: string; Engine: new (key: string) => import("./types.ts").SearchEngineAdapter }[] = [
	...chainEngines.map((Engine) => ({ name: new Engine("unused").name, Engine })),
	{ name: "tavily", Engine: TavilyEngine },
];

function dedupeResults(results: SearchResult[]): SearchResult[] {
	const seen = new Set<string>();
	const deduped: SearchResult[] = [];
	for (const r of results) {
		if (seen.has(r.url)) continue;
		seen.add(r.url);
		deduped.push(r);
	}
	return deduped;
}

export function resolveChain(
	potentialEngine?: EngineChoice,
	autoChain?: string[],
): string[] {
	const chain = autoChain ?? ["tinyfish", "exa", "duckduckgo"];
	if (!potentialEngine || potentialEngine === "auto") return chain;
	const match = searchEngines.find((e) => e.name === potentialEngine);
	// Unknown choices degrade to the default chain.
	return match ? [match.name] : chain;
}

/**
 * Lazily-constructed context for webLookup. Tests inject a context via the
 * optional second argument; production loads from env/config/coordinator.
 */
async function resolveContext(
	override?: WebLookupContext,
): Promise<WebLookupContext> {
	if (override) return override;
	const [credentials, { config }] = await Promise.all([
		loadCredentials(),
		loadWebSearchConfig(),
	]);
	const stateDir = defaultStateDir();
	const coordinator = createCoordinator(
		stateDir,
		config.providers as any,
	);
	return { credentials, config, coordinator };
}

/**
 * Invoke a single adapter attempt, with retry for transient failures.
 * Every physical attempt reserves capacity before calling the SDK.
 *
 * Returns the results on success, or throws a categorized error on failure.
 */
async function invokeWithRetry(
	Engine: new (key: string) => import("./types.ts").SearchEngineAdapter,
	provider: string,
	request: WebLookupRequest,
	signal: AbortSignal | undefined,
	maxRetries: number,
	apiKey: string | null,
	coordinator: import("./rate-limit.ts").RateLimitCoordinator,
): Promise<SearchResult[]> {
	let lastError: Error | null = null;
	let lastCategory: ErrorCategory | null = null;

	for (let attempt = 0; attempt <= maxRetries; attempt++) {
		// Reserve before every physical attempt (including retries).
		const reserveResult = await coordinator.reserve(
			provider,
			"search",
			apiKey || undefined,
		);
		if (
			reserveResult === "capacity-blocked" ||
			reserveResult === "cooldown-blocked" ||
			reserveResult === "contention"
		) {
			const msg =
				reserveResult === "capacity-blocked"
					? "provider capacity blocked — skipped"
					: reserveResult === "cooldown-blocked"
						? "provider cooldown active — skipped"
						: "rate-limit lock contention — skipped";
			throw Object.assign(new Error(msg), {
				__category: "rate_limit" as ErrorCategory,
				__message: msg,
			});
		}

		try {
			const engine = new Engine(apiKey!);
			return await engine.search(request, signal);
		} catch (err: unknown) {
			// User cancellation — never retry, never record as provider failure.
			if (
				err &&
				typeof err === "object" &&
				(err as Error).name === "AbortError"
			) {
				const cancelErr = new Error("request cancelled by caller");
				(cancelErr as any).name = "AbortError";
				throw cancelErr;
			}

			const status =
				err && typeof err === "object" && "statusCode" in err
					? (err as { statusCode: number }).statusCode
					: null;
			const category = classifyError(status, err);
			lastCategory = category;
			lastError = err instanceof Error ? err : new Error(String(err));

			// 429 / rate_limit — publish cooldown, do NOT retry.
			if (category === "rate_limit") {
				const retryAfter =
					err && typeof err === "object" && "retryAfter" in err
						? (err as { retryAfter?: number }).retryAfter
						: undefined;
				// Publish cooldown (best-effort, fire-and-forget).
				coordinator
					.publishCooldown(provider, "search", retryAfter, apiKey || undefined)
					.catch(() => {});
				throw Object.assign(lastError, {
					__category: category,
					__retryAfter: retryAfter,
				});
			}

			// Non-retryable errors — stop immediately.
			if (!isRetryable(category)) {
				throw Object.assign(lastError, { __category: category });
			}

			// Transient failure — retry if we have attempts left.
			if (attempt < maxRetries) continue;
		}
	}

	// Exhausted all retries.
	throw Object.assign(lastError!, { __category: lastCategory! });
}

/**
 * Unified web search entry point.
 *
 * For each resolved candidate engine:
 *  1. Check credentials — missing key → partialFailure, skip.
 *  2. Reserve capacity — blocked → partialFailure, skip (auto) or return (explicit).
 *  3. Invoke adapter (with built-in retry) — results win; no results → partialFailure, continue (auto).
 *  4. 429 → publishCooldown + partialFailure, continue (auto).
 *  5. Non-retryable → partialFailure, continue (auto).
 *  6. Explicit engines never fall back.
 *  7. Cancellation stops immediately, never retried, never a partialFailure.
 *
 * Deduplicates by URL, reports engines[] and partialFailures[].
 */
export async function webLookup(
	request: WebLookupRequest,
	overrideContext?: WebLookupContext,
): Promise<SearchResponse> {
	const context = await resolveContext(overrideContext);
	const { credentials, config, coordinator } = context;

	const chain = resolveChain(
		request.engine,
		config.routing.searchAuto,
	);
	const isAuto = !request.engine || request.engine === "auto";

	const allResults: SearchResult[] = [];
	const engines: string[] = [];
	const partialFailures: { engine: string; error: string }[] = [];
	// Pass AbortSignal through a non-enumerable property so adapters can read it.
	// Preserve an already-set __signal (e.g. set by index.ts or tests) rather than
	// overwriting it with request.signal (which is undefined on WebLookupRequest).
	if (!(request as any).__signal) {
		(request as any)["__signal"] =
			(request as any).signal as AbortSignal | undefined;
	}

	for (const provider of chain) {
		// Resolve the engine constructor and API key.
		const engineDef = searchEngines.find((e) => e.name === provider);
		if (!engineDef) continue;

		const apiKey = credentials[provider as keyof Credentials] as string | null;

		// 1. Check credentials.
		if (!apiKey) {
			partialFailures.push({
				engine: provider,
				error: errorText("unavailable_credentials"),
			});
			continue;
		}

		const opConfig =
			config.providers[provider]?.search ?? {
				capacity: null,
				windowMs: 60000,
				maxRetries: 1,
				fallbackCooldownMs: 60000,
			};
		const maxRetries = opConfig.maxRetries ?? 1;

		// 2-5. Invoke with retry (reserves each attempt internally).
		try {
			const results = await invokeWithRetry(
				engineDef.Engine,
				provider,
				request,
				(request as any)["__signal"],
				maxRetries,
				apiKey,
				coordinator,
			);

			if (results.length > 0) {
				engines.push(provider);
				allResults.push(...results);
				break; // First provider with results wins.
			}

			// No results — record and continue (auto only).
			partialFailures.push({
				engine: provider,
				error: "engine returned no results — falling back",
			});
			if (!isAuto) break;
		} catch (err: unknown) {
			const categorized = err as Error & {
				__category?: ErrorCategory;
				__retryAfter?: number;
				__message?: string;
			};
			const category =
				categorized.__category ??
				classifyError(
					err && typeof err === "object" && "statusCode" in err
						? (err as { statusCode: number }).statusCode
						: null,
					err,
				);

			// Cancellation — stop immediately, never a partialFailure.
			if ((err as Error).name === "AbortError") {
				break;
			}

			// 429 / rate_limit — already published cooldown inside invokeWithRetry.
			if (category === "rate_limit") {
				partialFailures.push({
					engine: provider,
					error: categorized.__message ?? errorText("rate_limit"),
				});
				if (!isAuto) break;
				continue;
			}

			// Record partialFailure and continue (auto only).
			partialFailures.push({
				engine: provider,
				error: errorText(category, err),
			});
			if (!isAuto) break;
		}
	}

	return {
		query: request.query,
		results: dedupeResults(allResults),
		engines,
		partialFailures,
	};
}
