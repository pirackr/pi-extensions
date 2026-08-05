# web-search extension rewrite — v1 design

## Goal

Replace `open-websearch` with direct API calls. Three tools, zero browser dependencies, no `npx` overhead.

## Tools

| Tool name | Purpose | Implementation |
| ----------- | --------- | --------------- |
| `web_lookup` | Search the web | Exa API + DuckDuckGo HTML scrape |
| `fetch_web` | Fetch and extract URL content | Native `fetch()` + `@mozilla/readability` |

## Data types

```typescript
interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engine: "exa" | "duckduckgo";
}

interface SearchResponse {
  query: string;
  results: SearchResult[];
  engines: ("exa" | "duckduckgo")[];
  partialFailures: { engine: string; error: string }[];
}

interface ExtractedContent {
  url: string;
  title: string;
  content: string;  // HTML from Readability
  error: string | null;
}
```

## searchExa(query, limit, signal)

- `POST https://api.exa.ai/search`
- Header: `x-api-key` from `.env` (`EXA_API_KEY`)
- Body: `{ query, type: "auto", numResults: limit, contents: { text: true } }`
- Returns `Array<{ title, url, text }>` mapped to `SearchResult`
- If no API key configured: return empty results (skip silently)
- If API error: return `partialFailures` entry, continue with DDG

## searchDuckDuckGo(query, limit)

- `GET https://duckduckgo.com/html/?q=<encoded-query>`
- Header: `User-Agent: Mozilla/5.0 (X11; Linux x86_64; rv:109.0) Gecko/20100101 Firefox/115.0`
- Parse HTML for `<a class="result__a" href="...">` links
- Decode `uddg=` URL parameter to get real URLs
- Map to `SearchResult` (snippet from `.result__snippet` or empty)
- If scrape fails: return `partialFailures` entry, continue with Exa

## mergeResults(exa, ddg, query)

- Combine both result arrays
- Deduplicate by URL (Exa results keep priority)
- Attach `engine` label to each result
- Return `SearchResponse`

## fetchWeb(url, signal)

- `fetch(url)` with browser-like User-Agent
- Check content-type: skip if not `text/html` or `application/xhtml+xml`
- Read response as text
- Parse with `DOMParser` (built-in Node 24)
- Run `Readability(document).parse()`
- Extract `title` and `content` (HTML string)
- Return `ExtractedContent`
- If fetch fails: `{ url, title: "", content: "", error: "HTTP NNN" }`
- If Readability fails: `{ url, title: "", content: "", error: "Could not extract content" }`
- Respect `AbortSignal` for cancellation

## fetchGitHubReadme(url, signal)

- Parse `https://github.com/{owner}/{repo}` from URL
- `GET https://api.github.com/repos/{owner}/{repo}/readme`
- Header: `Accept: application/vnd.github.v3.raw`
- Response body is raw markdown — return as-is
- If repo not found: `{ error: "Repository not found" }`
- If API error: `{ error: "GitHub API error NNN" }`

## Error handling

- Exa missing API key → skip Exa, return only DDG results
- Exa API error → record in `partialFailures`, continue with DDG
- DDG scrape failure → record in `partialFailures`, continue with Exa
- Both fail → `SearchResponse` with empty results and two `partialFailures` entries
- Fetch URL unreachable → `ExtractedContent { error: "HTTP 404" }`
- Readability fails → `ExtractedContent { error: "Could not extract content" }`

## Dependencies

- **Remove:** `open-websearch`
- **Add:** `@mozilla/readability@^0.6.0`
- **Built-in:** `fetch`, `DOMParser` (Node 24)
- **Zero browser dependencies**

## Tool parameters

### web_lookup
- `query` (required): Search query string
- `limit` (optional): Max results per engine, 1-50, default 10

### fetch_web
- `url` (required): Public HTTP(S) URL to fetch
- `max_chars` (optional): Accepted for schema compatibility, ignored in v1 (no truncation)

## Files changed

- `extensions/web-search/index.ts` — complete rewrite
- `skills/web-search/SKILL.md` — update to reflect new implementation
- `package.json` — remove `open-websearch`, add `@mozilla/readability`