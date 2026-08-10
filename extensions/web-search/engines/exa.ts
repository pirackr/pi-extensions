// extensions/web-search/engines/exa.ts
import type { SearchEngineAdapter, SearchResult, WebLookupRequest } from "../types.ts";
import { Exa } from "exa-js";
import { classifyError, errorText } from "../errors.ts";

/**
 * Exa Search adapter using the official exa-js SDK.
 *
 * Uses type:"auto" + Markdown page text (contents {text:true}), preserving
 * the current integration's behavior.
 *
 * The Exa SDK does not expose a retry option; we reserve the conservative
 * maximum attempt count (maxRetries+1) and document it.
 */
export class ExaEngine implements SearchEngineAdapter {
	name = "exa";

	private readonly client: Exa;

	constructor(apiKey: string) {
		this.client = new Exa(apiKey);
	}

	async search(
		request: WebLookupRequest,
		// exa-js does not expose AbortSignal on search(); we accept it for
		// interface consistency but cannot propagate it.
		_signal?: AbortSignal,
	): Promise<SearchResult[]> {
		const limit = Math.min(Math.max(request.limit, 1), 50);
		const opts = request.advancedOptions?.exa;

		const searchOpts: Record<string, unknown> = {
			type: "auto",
			numResults: limit,
			contents: { text: true },
		};

		// Forward explicitly provided advanced options (preserving defaults).
		if (opts) {
			if (opts.type) searchOpts.type = opts.type;
			if (opts.includeDomains) searchOpts.includeDomains = opts.includeDomains;
			if (opts.excludeDomains) searchOpts.excludeDomains = opts.excludeDomains;
			if (opts.startPublishedDate) searchOpts.startPublishedDate = opts.startPublishedDate;
			if (opts.endPublishedDate) searchOpts.endPublishedDate = opts.endPublishedDate;
			if (opts.category) searchOpts.category = opts.category;
			if (opts.includeText) searchOpts.includeText = opts.includeText;
			if (opts.excludeText) searchOpts.excludeText = opts.excludeText;
			if (opts.flags) searchOpts.flags = opts.flags;
			if (opts.userLocation) searchOpts.userLocation = opts.userLocation;
			if (opts.modulation != null) searchOpts.modulation = opts.modulation;
			if (opts.useAutoprompt != null) searchOpts.useAutoprompt = opts.useAutoprompt;
			if (opts.systemPrompt) searchOpts.systemPrompt = opts.systemPrompt;
			if (opts.outputSchema) searchOpts.outputSchema = opts.outputSchema;
			if (opts.contents != null) searchOpts.contents = opts.contents;
		}

		try {
			// exa-js types don't expose signal; pass options as second arg.
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
					snippet: (item.text ?? "").trim().slice(0, 500),
					engine: "exa",
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
