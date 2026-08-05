// extensions/web-search/index.ts
import { Type } from 'typebox';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { webLookup } from './search.ts';
import type { FetchStrategy, FetchResponse } from './types.ts';
import { ReadabilityStrategy } from './strategies/readability.ts';

export const fetchStrategies: FetchStrategy[] = [
  new ReadabilityStrategy(),
];

async function fetchWeb(url: string, signal?: AbortSignal): Promise<FetchResponse> {
  for (const strategy of fetchStrategies) {
    try {
      const result = await strategy.fetch(url, signal);
      if (result !== null) {
        return {
          url: result.url,
          title: result.title,
          content: result.content,
          strategy: strategy.name,
          error: result.error,
        };
      }
    } catch (err) {
      // Strategy failed — try the next one.
    }
  }
  return { url, title: '', content: '', strategy: 'none', error: 'No strategy could fetch this URL' };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: 'web_lookup',
    label: 'Web Search',
    description:
      'Search the web using Exa and DuckDuckGo. Returns search results with title, URL, and snippet. ' +
      'Use for finding documentation, facts, code examples, or discovering relevant pages.',
    parameters: Type.Object({
      query: Type.String({ description: 'Search query string' }),
      limit: Type.Optional(Type.Number({ description: 'Max results per engine, 1-50. Defaults to 10 if omitted.' })),
    }),
    async execute(_id: string, params: any, signal?: AbortSignal) {
      const limit = Math.min(Math.max(params.limit ?? 10, 1), 50);
      const result = await webLookup(params.query, limit, signal);

      let text = `Query: "${result.query}"\n`;
      text += `Engines: ${result.engines.join(', ') || 'none'}\n`;
      text += `Total results: ${result.results.length}\n\n`;
      if (result.results.length) {
        result.results.forEach((r, i) => {
          text += `${i + 1}. ${r.title}\n   URL: ${r.url}\n   ${r.snippet}\n   [${r.engine}]\n\n`;
        });
      }
      if (result.partialFailures.length) {
        text += `Partial failures: ${result.partialFailures.length}\n`;
        for (const pf of result.partialFailures) {
          text += `  - ${pf.engine}: ${pf.error}\n`;
        }
      }

      return {
        content: [{ type: 'text', text }],
        details: result,
      };
    },
  });

  pi.registerTool({
    name: 'fetch_web',
    label: 'Fetch Web Content',
    description:
      'Fetch and extract readable content from a public URL. Uses Mozilla Readability for clean extraction. ' +
      'Returns the page title and HTML content. Use for reading documentation, articles, or any public web page.',
    parameters: Type.Object({
      url: Type.String({ description: 'Public HTTP(S) URL to fetch' }),
      max_chars: Type.Optional(Type.Number({ description: 'Max characters to return. Defaults to no truncation.' })),
    }),
    async execute(_id: string, params: any, signal?: AbortSignal) {
      const result = await fetchWeb(params.url, signal);

      let content = result.content;
      if (params.max_chars && content.length > params.max_chars) {
        content = content.slice(0, params.max_chars) + '\n\n[Content truncated]';
      }

      const text = `Title: ${result.title || '(none)'}\nURL: ${result.url}\nStrategy: ${result.strategy}\n\n${content}`;

      return {
        content: [{ type: 'text', text }],
        details: result,
      };
    },
  });
}
