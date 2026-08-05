// extensions/web-search/engines/tavily.ts
import type { SearchEngine, SearchResult } from "../types.ts";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function loadTavilyApiKey(): string | null {
	// Check env first
	if (process.env.TAVILY_API_KEY) return process.env.TAVILY_API_KEY.trim();
	// Fall back to .env file
	try {
		const envPath = resolve(import.meta.dirname, "../../../.env");
		const lines = readFileSync(envPath, "utf-8").split("\n");
		for (const line of lines) {
			const m = line.match(/^TAVILY_API_KEY=(.+)$/);
			if (m) return m[1].trim();
		}
	} catch {
		/* .env may not exist */
	}
	return null;
}

export class TavilyEngine implements SearchEngine {
	name = "tavily";

	isAvailable(): boolean {
		return !!loadTavilyApiKey();
	}

	async search(
		query: string,
		limit: number,
		signal?: AbortSignal,
	): Promise<SearchResult[]> {
		const apiKey = loadTavilyApiKey();
		if (!apiKey) return [];

		const response = await fetch("https://api.tavily.com/search", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				api_key: apiKey,
				query,
				search_depth: "advanced",
				max_results: Math.min(Math.max(limit, 1), 20),
			}),
			signal,
		});

		if (!response.ok) {
			return [];
		}

		const data = (await response.json()) as {
			results?: Array<{ title?: string; url?: string; content?: string }>;
		};
		const results: SearchResult[] = [];
		for (const item of data.results ?? []) {
			if (!item.url) continue;
			results.push({
				title: item.title || "No title",
				url: item.url,
				snippet: item.content?.trim().slice(0, 500) || "",
				engine: "tavily",
			});
		}
		return results;
	}
}
