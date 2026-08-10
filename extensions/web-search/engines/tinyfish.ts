// extensions/web-search/engines/tinyfish.ts
import type { SearchEngineAdapter, SearchResult, WebLookupRequest } from "../types.ts";
import { TinyFish } from "@tiny-fish/sdk";
import { classifyError, errorText, type ErrorCategory } from "../errors.ts";

/**
 * TinyFish Search adapter using the official @tiny-fish/sdk.
 *
 * Uses standard web-search defaults; the router slices the returned page to
 * the canonical limit.
 *
 * SDK retries are disabled (maxRetries: 0) so every physical attempt is
 * represented in shared quota accounting.
 */
export class TinyFishEngine implements SearchEngineAdapter {
	name = "tinyfish";

	private readonly client: TinyFish;

	constructor(apiKey: string) {
		// Disable SDK retries — the router reserves and retries instead.
		this.client = new TinyFish({ apiKey, maxRetries: 0 });
	}

	async search(
		request: WebLookupRequest,
		signal?: AbortSignal,
	): Promise<SearchResult[]> {
		const limit = Math.min(Math.max(request.limit, 1), 50);
		const opts = request.advancedOptions?.tinyfish;

		try {
			const response = await this.client.search.query(
				{
					query: request.query,
					...(opts?.purpose ? { purpose: opts.purpose } : {}),
					...(opts?.location ? { location: opts.location } : {}),
					...(opts?.language ? { language: opts.language } : {}),
					...(opts?.include_domains ? { include_domains: opts.include_domains } : {}),
					...(opts?.exclude_domains ? { exclude_domains: opts.exclude_domains } : {}),
					...(opts?.after_date ? { after_date: opts.after_date } : {}),
					...(opts?.before_date ? { before_date: opts.before_date } : {}),
					...(opts?.recency_minutes != null ? { recency_minutes: opts.recency_minutes } : {}),
					...(opts?.domain_type ? { domain_type: opts.domain_type } : {}),
					...(opts?.pub_year_min != null ? { pub_year_min: opts.pub_year_min } : {}),
					...(opts?.pub_year_max != null ? { pub_year_max: opts.pub_year_max } : {}),
					...(opts?.page != null ? { page: opts.page } : {}),
				},
				{ signal },
			);

			const results: SearchResult[] = [];
			for (const item of response.results.slice(0, limit)) {
				results.push({
					title: item.title,
					url: item.url,
					snippet: item.snippet,
					engine: "tinyfish",
				});
			}
			return results;
		} catch (err: unknown) {
			// Cancellation — re-throw as-is so the router detects it by name.
			if (
				err &&
				typeof err === "object" &&
				(err as Error).name === "AbortError"
			) {
				throw err;
			}
			const category = classifyError(
				err && typeof err === "object" && "statusCode" in err
					? (err as { statusCode: number }).statusCode
					: null,
				err,
			);
			// Re-throw so the router can handle retries / partialFailures.
			const typed = err as Error & { statusCode?: number; retryAfter?: number };
			const msg = errorText(category, err);
			const wrapped = new Error(msg);
			wrapped.name = (err as Error).name ?? "Error";
			if (typed.statusCode != null) {
				(wrapped as any).statusCode = typed.statusCode;
			}
			if (typed.retryAfter != null) {
				(wrapped as any).retryAfter = typed.retryAfter;
			}
			throw wrapped;
		}
	}
}
