// extensions/web-search/engines/duckduckgo.ts
import type { SearchEngineAdapter, SearchResult, WebLookupRequest } from "../types.ts";
import { classifyError, errorText } from "../errors.ts";

const USER_AGENT =
	"Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/115.0";

export function decodeDdgUrl(encoded: string): string {
	// Remove the duckduckgo redirect prefix
	const raw = encoded.replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, "");
	// Strip everything from the first & (or &amp; HTML entity) onward — DDG appends &rut=<64-hex hash>
	const clean = raw.replace(/&.*$/, "");
	try {
		return decodeURIComponent(clean);
	} catch {
		// Guard against URIError from bare % in non-prefix URLs
		return clean;
	}
}

export function stripHtml(html: string): string {
	return html.replace(/<[^>]*>/g, "").trim();
}

/**
 * DuckDuckGo Search adapter.
 *
 * On HTTP errors, throws a categorized error so the router can surface it as
 * a partialFailure instead of silently returning [].
 */
export class DuckDuckGoEngine implements SearchEngineAdapter {
	name = "duckduckgo";

	async search(
		request: WebLookupRequest,
		signal?: AbortSignal,
	): Promise<SearchResult[]> {
		const limit = Math.min(Math.max(request.limit, 1), 50);
		const encodedQuery = encodeURIComponent(request.query);

		const response = await fetch(
			`https://duckduckgo.com/html/?q=${encodedQuery}`,
			{
				headers: { "User-Agent": USER_AGENT },
				signal,
			},
		);

		if (!response.ok) {
			const category = classifyError(response.status, null);
			const msg = errorText(category);
			const err = new Error(msg);
			(err as any).statusCode = response.status;
			throw err;
		}

		const html = await response.text();

		// Extract result blocks: title + URL from result__a links
		const results: SearchResult[] = [];
		const linkRegex = /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>/gi;
		const titleRegex = /<a[^>]*class="result__a"[^>]*>([^<]*)<\/a>/gi;
		// Use [\s\S]*? to match across newlines and allow inner tags like <b>
		const snippetRegex =
			/<a[^>]*class="result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/gi;

		const links = [...html.matchAll(linkRegex)];
		const titles = [...html.matchAll(titleRegex)];
		const snippets = [...html.matchAll(snippetRegex)];

		for (let i = 0; i < Math.min(links.length, limit); i++) {
			const urlMatch = links[i]?.[1];
			const titleMatch = titles[i]?.[1];
			const snippetMatch = snippets[i]?.[1];
			if (!urlMatch) continue;

			const url = decodeDdgUrl(urlMatch);
			results.push({
				title: titleMatch?.trim() || "No title",
				url,
				snippet: stripHtml(snippetMatch || ""),
				engine: "duckduckgo",
			});
		}

		return results;
	}
}
