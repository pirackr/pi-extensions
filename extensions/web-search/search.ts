// extensions/web-search/search.ts
import type { SearchEngine, SearchResponse, SearchResult } from './types.ts';
import { ExaEngine } from './engines/exa.ts';
import { DuckDuckGoEngine } from './engines/duckduckgo.ts';

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

export async function webLookup(
  query: string,
  limit: number = 10,
  signal?: AbortSignal,
): Promise<SearchResponse> {
  const allResults: SearchResult[] = [];
  const engines: string[] = [];
  const partialFailures: { engine: string; error: string }[] = [];

  for (const engine of searchEngines) {
    if (engine.isAvailable?.() === false) continue;

    try {
      const results = await engine.search(query, limit, signal);
      if (results.length > 0) {
        engines.push(engine.name);
        allResults.push(...results);
      }
    } catch (err) {
      partialFailures.push({
        engine: engine.name,
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
