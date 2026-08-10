// extensions/web-search/engines/tavily.ts
import type { SearchEngineAdapter, SearchResult, WebLookupRequest } from "../types.ts";
import { tavily } from "@tavily/core";
import { classifyError, errorText } from "../errors.ts";

/**
 * Tavily Search adapter using the official @tavily/core SDK.
 *
 * Uses searchDepth "advanced" (explicit-only), preserving its advanced-only
 * role. A caller may override documented Tavily request options explicitly.
 *
 * The Tavily SDK does not expose a retry option; every physical attempt is
 * counted against the shared reservation.
 */
export class TavilyEngine implements SearchEngineAdapter {
	name = "tavily";

	private readonly client: ReturnType<typeof tavily>;

	constructor(apiKey: string) {
		this.client = tavily({ apiKey });
	}

	async search(
		request: WebLookupRequest,
		// @tavily/core does not expose AbortSignal on search(); we accept it for
		// interface consistency but cannot propagate it.
		_signal?: AbortSignal,
	): Promise<SearchResult[]> {
		const limit = Math.min(Math.max(request.limit, 1), 20);
		const opts = request.advancedOptions?.tavily;

		const searchOpts: Record<string, unknown> = {
			searchDepth: "advanced",
			maxResults: limit,
		};

		// Forward explicitly provided advanced options (preserving defaults).
		if (opts) {
			if (opts.searchDepth) searchOpts.searchDepth = opts.searchDepth;
			if (opts.topic) searchOpts.topic = opts.topic;
			if (opts.days != null) searchOpts.days = opts.days;
			if (opts.includeImages != null) searchOpts.includeImages = opts.includeImages;
			if (opts.includeImageDescriptions != null)
				searchOpts.includeImageDescriptions = opts.includeImageDescriptions;
			if (opts.includeAnswer != null) searchOpts.includeAnswer = opts.includeAnswer;
			if (opts.includeRawContent != null) searchOpts.includeRawContent = opts.includeRawContent;
			if (opts.includeDomains) searchOpts.includeDomains = opts.includeDomains;
			if (opts.excludeDomains) searchOpts.excludeDomains = opts.excludeDomains;
			if (opts.maxTokens != null) searchOpts.maxTokens = opts.maxTokens;
			if (opts.timeRange) searchOpts.timeRange = opts.timeRange;
			if (opts.chunksPerSource != null) searchOpts.chunksPerSource = opts.chunksPerSource;
			if (opts.country) searchOpts.country = opts.country;
			if (opts.startDate) searchOpts.startDate = opts.startDate;
			if (opts.endDate) searchOpts.endDate = opts.endDate;
			if (opts.autoParameters != null) searchOpts.autoParameters = opts.autoParameters;
			if (opts.includeFavicon != null) searchOpts.includeFavicon = opts.includeFavicon;
			if (opts.includeUsage != null) searchOpts.includeUsage = opts.includeUsage;
			if (opts.exactMatch != null) searchOpts.exactMatch = opts.exactMatch;
		}

		try {
			const response = await (this.client as any).search(
				request.query,
				searchOpts,
			);

			const results: SearchResult[] = [];
			for (const item of response.results ?? []) {
				if (!item.url) continue;
				results.push({
					title: item.title || "No title",
					url: item.url,
					snippet: (item.content ?? "").trim().slice(0, 500),
					engine: "tavily",
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
			const status =
				err && typeof err === "object" && "statusCode" in err
					? (err as { statusCode: number }).statusCode
					: null;
			const category = classifyError(status, err);
			const msg = errorText(category, err);
			const wrapped = new Error(msg);
			wrapped.name = (err as Error).name ?? "Error";
			if (status != null) (wrapped as any).statusCode = status;
			throw wrapped;
		}
	}
}
