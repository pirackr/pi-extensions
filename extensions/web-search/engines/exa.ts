// extensions/web-search/engines/exa.ts
import type { SearchEngine, SearchResult } from '../types.ts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

function loadExaApiKey(): string | null {
  // Check env first
  if (process.env.EXA_API_KEY) return process.env.EXA_API_KEY.trim();
  // Fall back to .env file
  try {
    const envPath = resolve(import.meta.dirname, '../../../.env');
    const lines = readFileSync(envPath, 'utf-8').split('\n');
    for (const line of lines) {
      const m = line.match(/^EXA_API_KEY=(.+)$/);
      if (m) return m[1].trim();
    }
  } catch { /* .env may not exist */ }
  return null;
}

export class ExaEngine implements SearchEngine {
  name = 'exa';

  isAvailable(): boolean {
    return !!loadExaApiKey();
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<SearchResult[]> {
    const apiKey = loadExaApiKey();
    if (!apiKey) return [];

    const response = await fetch('https://api.exa.ai/search', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        type: 'auto',
        numResults: limit,
        contents: { text: true },
      }),
      signal,
    });

    if (!response.ok) {
      return [];
    }

    const data = await response.json() as { results?: Array<{ title?: string; url?: string; text?: string }> };
    const results: SearchResult[] = [];
    for (const item of data.results ?? []) {
      if (!item.url) continue;
      results.push({
        title: item.title || 'No title',
        url: item.url,
        snippet: item.text?.trim().slice(0, 500) || '',
        engine: 'exa',
      });
    }
    return results;
  }
}
