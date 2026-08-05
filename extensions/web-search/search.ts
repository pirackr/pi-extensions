// extensions/web-search/search.ts
import type {
	EngineChoice,
	SearchEngine,
	SearchResponse,
	SearchResult,
} from "./types.ts";
import { ExaEngine } from "./engines/exa.ts";
import { DuckDuckGoEngine } from "./engines/duckduckgo.ts";

/**
 * Ordered fallback chain. webLookup walks this list and uses the first engine
 * that yields results: Exa is the default, DuckDuckGo is the first backup.
 * New engines append here and automatically join the chain.
 */
export const searchEngines: SearchEngine[] = [
	new ExaEngine(),
	new DuckDuckGoEngine(),
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

export function resolveChain(engine?: EngineChoice): SearchEngine[] {
	if (!engine || engine === "auto") return searchEngines;
	const match = searchEngines.find((e) => e.name === engine);
	// Unknown choices (e.g. a future engine name) degrade to the default chain.
	return match ? [match] : searchEngines;
}

export async function webLookup(
	query: string,
	limit: number = 10,
	signal?: AbortSignal,
	engine?: EngineChoice,
): Promise<SearchResponse> {
	const allResults: SearchResult[] = [];
	const engines: string[] = [];
	const partialFailures: { engine: string; error: string }[] = [];

	for (const candidate of resolveChain(engine)) {
		if (candidate.isAvailable?.() === false) {
			partialFailures.push({
				engine: candidate.name,
				error: "engine not available (e.g. missing API key) — skipped",
			});
			continue;
		}

		try {
			const results = await candidate.search(query, limit, signal);
			if (results.length > 0) {
				// First engine in the chain that returns results wins.
				engines.push(candidate.name);
				allResults.push(...results);
				break;
			}
			partialFailures.push({
				engine: candidate.name,
				error: "engine returned no results — falling back",
			});
		} catch (err) {
			partialFailures.push({
				engine: candidate.name,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return {
		query,
		results: dedupeResults(allResults),
		engines,
		partialFailures,
	};
}
