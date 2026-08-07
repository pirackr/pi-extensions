// extensions/web-search/search.ts
import type {
	EngineChoice,
	SearchEngine,
	SearchResponse,
	SearchResult,
} from "./types.ts";
import { ExaEngine } from "./engines/exa.ts";
import { DuckDuckGoEngine } from "./engines/duckduckgo.ts";
import { TavilyEngine } from "./engines/tavily.ts";

/**
 * Fallback chain walked by engine: "auto" — Exa default, DuckDuckGo backup.
 * Engines here run in order until one returns results.
 */
const chainEngines: SearchEngine[] = [
	new ExaEngine(),
	new DuckDuckGoEngine(),
];

/**
 * Every available engine. Engines NOT in chainEngines are opt-in only:
 * they run solely when the model passes engine: "<name>" explicitly.
 */
export const searchEngines: SearchEngine[] = [
	...chainEngines,
	new TavilyEngine(),
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
	if (!engine || engine === "auto") return chainEngines;
	const match = searchEngines.find((e) => e.name === engine);
	// Unknown choices (e.g. a future engine name) degrade to the default chain.
	return match ? [match] : chainEngines;
}

export async function webLookup(
	query: string,
	limit: number = 20,
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
