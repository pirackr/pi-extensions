// extensions/web-search/errors.ts
// Normalized error categories and retryability rules for provider failures.

// ---------------------------------------------------------------------------
// Categories
// ---------------------------------------------------------------------------

export type ErrorCategory =
	| "authentication"
	| "validation"
	| "permission"
	| "rate_limit"
	| "quota_exhausted"
	| "timeout"
	| "transport"
	| "service"
	| "empty_results"
	| "provider_result"
	| "unavailable_credentials"
	| "cancellation";

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/**
 * Classifies an HTTP status code + raw error object into a normalized
 * ErrorCategory. `status` is null for network/abort errors. `raw` may be an
 * Error, a response body, or null.
 */
export function classifyError(
	status: number | null,
	raw: unknown,
): ErrorCategory {
	// User cancellation — never a provider failure.
	if (raw instanceof Error && raw.name === "AbortError") {
		return "cancellation";
	}

	// Network / transport errors — also check for timeout clues in message.
	if (status === null && raw instanceof Error) {
		const msg = raw.message.toLowerCase();
		if (
			msg.includes("timeout") ||
			msg.includes("timed out") ||
			msg.includes("abort")
		) {
			return "timeout";
		}
		return "transport";
	}

	if (status === null) return "transport";

	// HTTP status → category.
	switch (status) {
		case 401:
			return "authentication";
		case 403:
			return "permission";
		case 400:
		case 422:
			return "validation";
		case 429:
			return "rate_limit";
		case 408:
			return "timeout";
		case 500:
		case 502:
		case 503:
		case 504:
			return "service";
		case 507:
			return "quota_exhausted";
		default:
			// 2xx with empty results.
			if (status >= 200 && status < 300) {
				if (
					raw &&
					typeof raw === "object" &&
					"results" in (raw as Record<string, unknown>)
				) {
					const results = (raw as Record<string, unknown>).results;
					if (Array.isArray(results) && results.length === 0) {
						return "empty_results";
					}
				}
				return "provider_result";
			}
			return "service";
	}
}

// ---------------------------------------------------------------------------
// Retryability
// ---------------------------------------------------------------------------

/**
 * Returns true for transient failures that should be retried (once by default).
 * rate_limit publishes a cooldown and routes immediately — never retried.
 */
export function isRetryable(category: ErrorCategory): boolean {
	return (
		category === "timeout" ||
		category === "transport" ||
		category === "service"
	);
}

// ---------------------------------------------------------------------------
// Error text
// ---------------------------------------------------------------------------

/**
 * Returns concise, actionable error text for a category.
 * Never includes API keys, authorization headers, SDK request objects, or
 * untrusted response bodies.
 */
export function errorText(category: ErrorCategory, _raw?: unknown): string {
	switch (category) {
		case "authentication":
			return "provider authentication failed — check API key";
		case "validation":
			return "provider rejected the request (validation error)";
		case "permission":
			return "provider permission denied — check API key scopes";
		case "rate_limit":
			return "provider rate-limited the request";
		case "quota_exhausted":
			return "provider quota exhausted";
		case "timeout":
			return "provider request timed out";
		case "transport":
			return "provider transport error (network failure)";
		case "service":
			return "provider returned a server error";
		case "empty_results":
			return "provider returned no results";
		case "provider_result":
			return "";
		case "unavailable_credentials":
			return "provider credentials unavailable";
		case "cancellation":
			return "request cancelled by caller";
		default:
			return "provider error";
	}
}
