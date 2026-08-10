// extensions/web-search/fetch.ts
import type {
	FetchWebRequest,
	FetchResponse,
	WebLookupContext,
	FetchAttempt,
} from "./types.ts";
import { TinyFishFetchStrategy } from "./strategies/tinyfish.ts";
import { ReadabilityStrategy } from "./strategies/readability.ts";
import { loadCredentials } from "./credentials.ts";
import { loadWebSearchConfig } from "./config.ts";
import { createCoordinator } from "./rate-limit.ts";
import {
	classifyError,
	isRetryable,
	errorText,
	type ErrorCategory,
} from "./errors.ts";
import { validateTinyFishFetchOptions } from "./options/validate.ts";
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
 * Lazily-constructed context for fetchWeb. Tests inject a context via the
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
 * Returns true for fetch errors that allow Readability fallback.
 * Validation errors are terminal (invalid options, invalid URL, selector
 * mismatch, conditional-request misuse — Readability cannot honor any of
 * these). All other categories are allowed fallbacks.
 */
function isFetchFallbackAllowed(category: ErrorCategory): boolean {
	if (category === "cancellation") return false;
	if (category === "validation") return false;
	return true;
}

/**
 * Unified web fetch entry point.
 *
 * TinyFish is attempted first (with retry for transient failures).
 * Readability is the fallback for allowed infrastructure failures.
 *
 * Flow:
 *  1. Validate TinyFish options — terminal, never consumes quota.
 *  2. Check for cancellation — throw immediately.
 *  3. Check credentials — missing key → skipped attempt, fall through.
 *  4. Reserve capacity — blocked → skipped attempt, fall through.
 *  5. Invoke TinyFish adapter (with built-in retry) — success returns.
 *  6. Empty extracted content → skipped attempt, fall through.
 *  7. 429 → publish cooldown, skipped attempt, fall through.
 *  8. Allowed infrastructure failures → fall through to Readability.
 *  9. Terminal (validation) → return precise TinyFish error.
 * 10. Cancellation stops immediately, never retried, never recorded.
 */
export async function fetchWeb(
	request: FetchWebRequest,
	overrideContext?: WebLookupContext,
): Promise<FetchResponse> {
	const context = await resolveContext(overrideContext);
	const { credentials, config, coordinator } = context;

	const chain = config.routing.fetch ?? ["tinyfish", "readability"];
	const attempts: FetchAttempt[] = [];

	// 1. Validate TinyFish options FIRST — terminal, never consumes quota.
	const tinyfishOpts = request.advancedOptions?.tinyfish;
	if (tinyfishOpts != null) {
		const validationErrors = validateTinyFishFetchOptions(
			tinyfishOpts as Record<string, unknown>,
		);
		if (validationErrors.length > 0) {
			return {
				url: request.url,
				title: "",
				content: "",
				strategy: "none",
				format: "unknown",
				error: `Invalid value for TinyFish fetch options: ${validationErrors
					.map((e) => e.message)
					.join("; ")}`,
				attempts: [],
			};
		}
	}

	// 2. Check for cancellation before any quota reservation.
	const signal = (request as any)["__signal"];
	if (signal?.aborted) {
		const err = new Error("request cancelled by caller");
		(err as any).name = "AbortError";
		throw err;
	}

	// ------------------------------------------------------------------
	// Phase 1: TinyFish attempt (with retry for transient failures)
	// ------------------------------------------------------------------
	const apiKey = credentials.tinyfish;
	let tinyfishAttempted = false;
	let tinyfishFailed = false;

	if (apiKey) {
		tinyfishAttempted = true;
		const opConfig =
			config.providers.tinyfish?.fetch ??
			{ capacity: 150, windowMs: 60000, maxRetries: 1 };
		const maxRetries = opConfig.maxRetries ?? 1;

		for (let attempt = 0; attempt <= maxRetries; attempt++) {
			// 3/4. Reserve before every physical attempt (including retries).
			const reserveResult = await coordinator.reserve(
				"tinyfish",
				"fetch",
				apiKey,
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
				attempts.push({
					strategy: "tinyfish",
					outcome: "skipped",
					reason: msg,
				});
				// These are allowed fallbacks — break out of retry loop.
				tinyfishFailed = true;
				break;
			}

			try {
				const strategy = new TinyFishFetchStrategy(apiKey);
				const result = await strategy.fetch(request, signal);

				// 6. Empty extracted content → skipped, fall through.
				if (result.content === "" && result.format !== "json") {
					attempts.push({
						strategy: "tinyfish",
						outcome: "skipped",
						reason: "empty extracted content",
					});
					tinyfishFailed = true;
					break;
				}

				// Success — return immediately.
				return result;
			} catch (err: unknown) {
				// 10. Cancellation — stop immediately, never retried,
				//     never recorded as a provider failure.
				if (
					err &&
					typeof err === "object" &&
					(err as Error).name === "AbortError"
				) {
					throw err;
				}

				const status =
					err && typeof err === "object" && "statusCode" in err
						? (err as { statusCode: number }).statusCode
						: null;
				const category = classifyError(status, err);

				const outcome: "failed" | "rate_limited" =
					category === "rate_limit" ? "rate_limited" : "failed";
				attempts.push({
					strategy: "tinyfish",
					outcome,
					reason: errorText(category, err),
				});

				// 7. 429 → publish cooldown, skip, fall through.
				if (category === "rate_limit") {
					const retryAfter =
						err && typeof err === "object" && "retryAfter" in err
							? (err as { retryAfter?: number }).retryAfter
							: undefined;
					coordinator
						.publishCooldown("tinyfish", "fetch", retryAfter, apiKey)
						.catch(() => {});
					tinyfishFailed = true;
					break;
				}

				// 9. Terminal errors → return precise TinyFish error.
				if (!isFetchFallbackAllowed(category)) {
					return {
						url: request.url,
						title: "",
						content: "",
						strategy: "none",
						format: "unknown",
						error: errorText(category, err),
						attempts,
					};
				}

				// Non-retryable allowed failure → fall through to Readability.
				if (!isRetryable(category)) {
					tinyfishFailed = true;
					break;
				}

				// Transient → retry if we have attempts left.
				if (attempt < maxRetries) continue;

				// Exhausted retries → fall through to Readability.
				tinyfishFailed = true;
			}
		}
	} else {
		// 3. Missing credentials → skipped, fall through.
		attempts.push({
			strategy: "tinyfish",
			outcome: "skipped",
			reason: "provider credentials unavailable",
		});
		tinyfishFailed = true;
	}

	// ------------------------------------------------------------------
	// Phase 2: Readability fallback
	// ------------------------------------------------------------------
	if (tinyfishFailed && chain.includes("readability")) {
		const readabilityResult = await new ReadabilityStrategy().fetch(
			request.url,
			signal,
		);
		if (readabilityResult !== null && readabilityResult.error === null) {
			return {
				url: request.url,
				title: readabilityResult.title,
				content: readabilityResult.content,
				strategy: "readability",
				format: "html",
				error: null,
				attempts,
			};
		}
		attempts.push({
			strategy: "readability",
			outcome: "failed",
			reason: readabilityResult?.error ?? "extraction failed",
		});
	}

	return {
		url: request.url,
		title: "",
		content: "",
		strategy: "none",
		format: "unknown",
		error: "No strategy could fetch this URL",
		attempts,
	};
}
