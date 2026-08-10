# Web Search Provider Options Reference

Complete reference for provider-specific advanced options accepted by `web_lookup` and `fetch_web`. All options are passed under `advancedOptions.<provider>`. Unknown provider keys or unknown fields within a provider's schema are rejected at the tool boundary.

## Canonical Mappings

| Tool-level field | Provider-native field | Notes |
|---|---|---|
| `query` | `query` | Rejected inside `advancedOptions`; always at the top level |
| `limit` | varies per provider | Clamped to `1..50` by the tool; provider-specific max may be stricter |
| `url` | `urls` | Rejected inside `advancedOptions`; always at the top level |
| `advancedOptions.tinyfish.format` | `format` | Default: `markdown`; mapped directly |
| `advancedOptions.exa.type` | `type` | Default: `auto` (plus `contents.text: true`); mapped directly |
| `advancedOptions.tavily.searchDepth` | `search_depth` | Default: `advanced`; mapped directly |

Markdown is the preferred output format for both search snippets and fetch content. The unified tool intentionally does **not** expose streaming modes, auth fields, or provider-native request fields that are not useful to the LLM caller.

## Retry Accounting

Every physical attempt (including retries) reserves capacity in the shared rate-limit coordinator and is recorded in `partialFailures` (search) or `attempts` (fetch). Transient failures are retried up to the provider's configured `maxRetries` (default: 1). A 429 does **not** retry immediately — it publishes a shared cooldown and continues (automatic mode) or returns the failure (explicit mode).

## Routing Behavior

- `engine: "auto"` (default): walks `tinyfish → exa → duckduckgo`.
- `engine: "tinyfish" | "exa" | "duckduckgo"`: runs that provider alone.
- `engine: "tavily"`: runs Tavily alone. Tavily never enters the automatic chain.
- Explicit provider selection never falls through to another provider.

---

## TinyFish Search

**Schema:** `advancedOptions.tinyfish` of type `TinyFishSearchOptionsSchema`

**API reference:** <https://docs.tinyfish.ai/search-api/reference>
**Last verified:** 2026-08-10

### Fields

| Tool field path | Provider-native API field | Type | Default | Allowed values | Constraints | Cost / credits | Tool behavior |
|---|---|---|---|---|---|---|---|
| `advancedOptions.tinyfish.purpose` | `purpose` | `string` (max 2000 chars) | omitted | free text | Must be non-empty when provided; whitespace-only rejected | Search does not consume credits (access required) | Accepted |
| `advancedOptions.tinyfish.location` | `location` | `string` | `US` (when language omitted) | ISO 3166-1 alpha-2 code (e.g. `US`, `GB`, `DE`) | Auto-resolves `language` from location when omitted | Accepted |
| `advancedOptions.tinyfish.language` | `language` | `string` | `en` (when location omitted) | ISO 639 language code (e.g. `en`, `fr`, `de`) | Auto-resolves `location` from language when omitted | Accepted |
| `advancedOptions.tinyfish.include_domains` | `include_domains` | `string` | omitted | Comma-separated domain list (e.g. `github.com,arxiv.org`) | No validation beyond string | Accepted |
| `advancedOptions.tinyfish.exclude_domains` | `exclude_domains` | `string` | omitted | Comma-separated domain list (e.g. `pinterest.com,quora.com`) | No validation beyond string | Accepted |
| `advancedOptions.tinyfish.after_date` | `after_date` | `string` (YYYY-MM-DD) | omitted | ISO date | Must be ≤ `before_date` when both provided; mutually exclusive with `recency_minutes` | Accepted |
| `advancedOptions.tinyfish.before_date` | `before_date` | `string` (YYYY-MM-DD) | omitted | ISO date | Must be ≥ `after_date` when both provided; mutually exclusive with `recency_minutes` | Accepted |
| `advancedOptions.tinyfish.recency_minutes` | `recency_minutes` | `number` (int 1..5256000, i.e. 10 years) | omitted | Positive integer | Mutually exclusive with `after_date` and `before_date` | Accepted |
| `advancedOptions.tinyfish.domain_type` | `domain_type` | `string` | `web` | `web`, `news`, `research_paper` | `research_paper` does not support `after_date`, `before_date`, or `recency_minutes`; use `pub_year_min`/`pub_year_max` instead | Accepted |
| `advancedOptions.tinyfish.pub_year_min` | `pub_year_min` | `number` (int 0..9999) | omitted | Positive integer | Only supported for `domain_type=research_paper`; must be ≤ `pub_year_max` when both set | Accepted |
| `advancedOptions.tinyfish.pub_year_max` | `pub_year_max` | `number` (int 0..9999) | omitted | Positive integer | Only supported for `domain_type=research_paper`; must be ≥ `pub_year_min` when both set | Accepted |
| `advancedOptions.tinyfish.page` | `page` | `number` | 0 | Integer, max 10 | Pagination offset (0-indexed) | Accepted |

### Unsupported / Rejected Fields

The following TinyFish Search API fields are **deliberately not exposed** by the unified tool:

- `query` — canonical tool-level field, rejected inside `advancedOptions`
- `api_key` / auth fields — resolved from environment, never accepted as tool input
- Streaming endpoints — not supported for synchronous Pi tool results

### Cross-Field Constraints (enforced at validation)

- `recency_minutes` is mutually exclusive with `after_date` and `before_date`.
- `after_date` must be ≤ `before_date` when both are present.
- `pub_year_min` must be ≤ `pub_year_max` when both are present.
- `domain_type=research_paper` does not support `after_date`, `before_date`, or `recency_minutes`.

### Rate Limits

| Plan | Requests / minute |
|---|---|
| Free | 30 |
| Pay As You Go | 30 |
| Starter | 60 |
| Pro | 120 |

Source: <https://docs.tinyfish.ai/search-api/reference#rate-limits>

---

## TinyFish Fetch

**Schema:** `advancedOptions.tinyfish` of type `TinyFishFetchOptionsSchema`

**API reference:** <https://docs.tinyfish.ai/fetch-api/reference>
**Last verified:** 2026-08-10

### Fields

| Tool field path | Provider-native API field | Type | Default | Allowed values | Constraints | Cost / credits | Tool behavior |
|---|---|---|---|---|---|---|---|
| `advancedOptions.tinyfish.purpose` | `purpose` | `string` (max 2000 chars) | omitted | free text | Must be non-empty when provided; whitespace-only rejected | Fetch does not use credits (access required) | Accepted |
| `advancedOptions.tinyfish.format` | `format` | `string` | `markdown` | `markdown`, `html`, `json` | — | Accepted |
| `advancedOptions.tinyfish.include_html_head` | `include_html_head` | `boolean` | `false` | `true`, `false` | — | Accepted |
| `advancedOptions.tinyfish.links` | `links` | `boolean` | `false` | `true`, `false` | Only present in response when `true` | Accepted |
| `advancedOptions.tinyfish.image_links` | `image_links` | `boolean` | `false` | `true`, `false` | Only present in response when `true` | Accepted |
| `advancedOptions.tinyfish.ttl` | `ttl` | `integer` | omitted | `0` (live fetch) or positive integer (seconds) | Omit to accept any cached entry | Accepted |
| `advancedOptions.tinyfish.per_url_timeout_ms` | `per_url_timeout_ms` | `integer` | omitted | 1..110000 (ms) | Per-URL wall-clock timeout; other URLs in a batch continue independently | Accepted |
| `advancedOptions.tinyfish.if_none_match` | `if_none_match` | `string` | omitted | ETag value from prior fetch | Single URL only; mutually exclusive with `if_modified_since` | Accepted |
| `advancedOptions.tinyfish.if_modified_since` | `if_modified_since` | `string` | omitted | Last-Modified value from prior fetch | Single URL only; mutually exclusive with `if_none_match` | Accepted |
| `advancedOptions.tinyfish.include_etag_and_last_modified` | `include_etag_and_last_modified` | `boolean` | `false` | `true`, `false` | Returns `etag` and `last_modified` on each result for replay | Accepted |

### Unsupported / Rejected Fields

The following TinyFish Fetch API fields are **deliberately not exposed** by the unified tool:

- `urls` — canonical tool-level field (`url`), rejected inside `advancedOptions`
- `include_selectors` / `exclude_selectors` — unsupported by the unified tool's single-URL contract
- `api_key` / auth fields — resolved from environment, never accepted as tool input

### Cross-Field Constraints (enforced at validation)

- `if_none_match` and `if_modified_since` are mutually exclusive; at most one may be provided.

### Rate Limits

| Plan | URLs / minute |
|---|---|
| Free | 150 |
| Pay As You Go | 150 |
| Starter | 300 |
| Pro | 600 |

Source: <https://docs.tinyfish.ai/fetch-api/reference#rate-limits>

---

## Exa Search

**Schema:** `advancedOptions.exa` of type `ExaSearchOptionsSchema`

**API reference:** <https://exa.ai/docs/reference/search-api-guide-for-coding-agents>
**Rate limits:** <https://exa.ai/docs/reference/rate-limits>
**Last verified:** 2026-08-10

### Top-Level Fields

| Tool field path | Provider-native API field | Type | Default | Allowed values | Constraints | Cost / credits | Tool behavior |
|---|---|---|---|---|---|---|---|
| `advancedOptions.exa.contents` | `contents` | `object \| true \| false` | `{ text: true }` (implicit default) | `true`, `false`, or `ExaContentsOptionsSchema` | See nested fields below | Accepted |
| `advancedOptions.exa.includeDomains` | `includeDomains` | `string[]` | omitted | Array of domain strings | — | Accepted |
| `advancedOptions.exa.excludeDomains` | `excludeDomains` | `string[]` | omitted | Array of domain strings | Not supported with `category=company` or `category=people` | Accepted |
| `advancedOptions.exa.startCrawlDate` | `startCrawlDate` | `string` | omitted | ISO date string | **Deprecated** — preserved for schema parity; not recommended | Accepted |
| `advancedOptions.exa.endCrawlDate` | `endCrawlDate` | `string` | omitted | ISO date string | **Deprecated** — preserved for schema parity; not recommended | Accepted |
| `advancedOptions.exa.startPublishedDate` | `startPublishedDate` | `string` | omitted | ISO date string | Not supported with `category=company` or `category=people` | Accepted |
| `advancedOptions.exa.endPublishedDate` | `endPublishedDate` | `string` | omitted | ISO date string | Not supported with `category=company` or `category=people` | Accepted |
| `advancedOptions.exa.category` | `category` | `string` | omitted | `company`, `publication`, `news`, `personal site`, `financial report`, `people` | `company`/`people` disable date, text, and domain filters | Accepted |
| `advancedOptions.exa.includeText` | `includeText` | `string[]` | omitted | Array of phrases (max 5 words each) | Not supported with `category=company` or `category=people`; each entry max 5 words | Accepted |
| `advancedOptions.exa.excludeText` | `excludeText` | `string[]` | omitted | Array of phrases (max 5 words each) | Not supported with `category=company` or `category=people`; each entry max 5 words | Accepted |
| `advancedOptions.exa.flags` | `flags` | `string[]` | omitted | Array of flag strings | — | Accepted |
| `advancedOptions.exa.userLocation` | `userLocation` | `string` | omitted | Location string | — | Accepted |
| `advancedOptions.exa.modulation` | `modulation` | `boolean` | omitted | `true`, `false` | — | Accepted |
| `advancedOptions.exa.useAutoprompt` | `useAutoprompt` | `boolean` | omitted | `true`, `false` | — | Accepted |
| `advancedOptions.exa.systemPrompt` | `systemPrompt` | `string` | omitted | Free text | — | Accepted |
| `advancedOptions.exa.outputSchema` | `outputSchema` | `ExaOutputSchema` | omitted | Object with `type` (`text` or `object`) | `type=object` supports at most 10 properties | Accepted |
| `advancedOptions.exa.type` | `type` | `string` | `auto` | `keyword`, `neural`, `auto`, `hybrid`, `fast`, `instant`, `deep-lite`, `deep`, `deep-reasoning` | — | Accepted |

### Nested `contents` Fields

| Tool field path | Provider-native API field | Type | Default | Allowed values | Constraints | Cost / credits | Tool behavior |
|---|---|---|---|---|---|---|---|
| `advancedOptions.exa.contents.text` | `contents.text` | `object \| true` | omitted | `true` or `ExaTextContentsOptionsSchema` | — | Accepted |
| `advancedOptions.exa.contents.text.maxCharacters` | `contents.text.maxCharacters` | `number` | omitted | Positive integer | — | Accepted |
| `advancedOptions.exa.contents.text.includeHtmlTags` | `contents.text.includeHtmlTags` | `boolean` | `false` | `true`, `false` | — | Accepted |
| `advancedOptions.exa.contents.text.verbosity` | `contents.text.verbosity` | `string` | omitted | `compact`, `standard`, `full` | Requires `contents.maxAgeHours: 0` when set | Accepted |
| `advancedOptions.exa.contents.text.includeSections` | `contents.text.includeSections` | `ExaSectionTag[]` | omitted | `unspecified`, `header`, `navigation`, `banner`, `body`, `sidebar`, `footer`, `metadata` | Requires `contents.maxAgeHours: 0` when set | Accepted |
| `advancedOptions.exa.contents.text.excludeSections` | `contents.text.excludeSections` | `ExaSectionTag[]` | omitted | Same tags as `includeSections` | Requires `contents.maxAgeHours: 0` when set | Accepted |
| `advancedOptions.exa.contents.highlights` | `contents.highlights` | `object \| true` | omitted | `true` or `ExaHighlightsContentsOptionsSchema` | — | Accepted |
| `advancedOptions.exa.contents.highlights.query` | `contents.highlights.query` | `string` | omitted | Free text | — | Accepted |
| `advancedOptions.exa.contents.highlights.maxCharacters` | `contents.highlights.maxCharacters` | `number` | omitted | Positive integer | — | Accepted |
| `advancedOptions.exa.contents.summary` | `contents.summary` | `object \| true` | omitted | `true` or `ExaSummaryContentsOptionsSchema` | — | Accepted |
| `advancedOptions.exa.contents.summary.query` | `contents.summary.query` | `string` | omitted | Free text | — | Accepted |
| `advancedOptions.exa.contents.summary.schema` | `contents.summary.schema` | `Record<string, unknown>` | omitted | JSON Schema-like object | — | Accepted |
| `advancedOptions.exa.contents.livecrawl` | `contents.livecrawl` | `string` | omitted | `never`, `fallback`, `always`, `auto`, `preferred` | — | Accepted |
| `advancedOptions.exa.contents.maxAgeHours` | `contents.maxAgeHours` | `number` | omitted | Non-negative integer | Required to be `0` when `text.verbosity` or section filters are set | Accepted |
| `advancedOptions.exa.contents.filterEmptyResults` | `contents.filterEmptyResults` | `boolean` | omitted | `true`, `false` | — | Accepted |
| `advancedOptions.exa.contents.subpages` | `contents.subpages` | `number` | omitted | Positive integer | — | Accepted |
| `advancedOptions.exa.contents.subpageTarget` | `contents.subpageTarget` | `string \| string[]` | omitted | Single string or array of strings | — | Accepted |
| `advancedOptions.exa.contents.extras` | `contents.extras` | `ExaExtrasOptionsSchema` | omitted | Object with `links` and `imageLinks` (numbers) | — | Accepted |
| `advancedOptions.exa.contents.extras.links` | `contents.extras.links` | `number` | omitted | Positive integer | — | Accepted |
| `advancedOptions.exa.contents.extras.imageLinks` | `contents.extras.imageLinks` | `number` | omitted | Positive integer | — | Accepted |

### Unsupported / Rejected Fields

The following Exa Search API fields are **deliberately not exposed** by the unified tool:

- `query` / `numResults` — canonical tool-level fields, rejected inside `advancedOptions`
- `api_key` / auth fields — resolved from environment, never accepted as tool input
- Agent API fields (`agent.*`) — outside scope
- `startCrawlDate` / `endCrawlDate` — deprecated by Exa; accepted for schema parity but documented as deprecated

### Cross-Field Constraints (enforced at validation)

- `includeText` and `excludeText` entries must be at most 5 words each.
- `contents.text` with `verbosity` or section filters requires `contents.maxAgeHours: 0`.
- `outputSchema.type=object` supports at most 10 properties.
- `category=company` or `category=people` disables `includeText`, `excludeText`, `excludeDomains`, `startPublishedDate`, and `endPublishedDate`.

### Rate Limits

| Endpoint | Limit |
|---|---|
| Search | 10 queries/second (per API key) |

Source: <https://exa.ai/docs/reference/rate-limits>

---

## Tavily Search

**Schema:** `advancedOptions.tavily` of type `TavilySearchOptionsSchema`

**API reference:** <https://docs.tavily.com/documentation/api-reference/endpoint/search>
**Rate limits:** <https://docs.tavily.com/documentation/rate-limits>
**Last verified:** 2026-08-10

### Fields

| Tool field path | Provider-native API field | Type | Default | Allowed values | Constraints | Cost / credits | Tool behavior |
|---|---|---|---|---|---|---|---|
| `advancedOptions.tavily.searchDepth` | `searchDepth` | `string` | `advanced` | `basic`, `advanced`, `fast`, `ultra-fast` | — | Accepted |
| `advancedOptions.tavily.topic` | `topic` | `string` | `general` | `general`, `news`, `finance` | — | Accepted |
| `advancedOptions.tavily.days` | `days` | `number` | omitted | Positive integer | Mutually exclusive with `timeRange`, `startDate`, `endDate` | Accepted |
| `advancedOptions.tavily.includeImages` | `includeImages` | `boolean` | `false` | `true`, `false` | — | Accepted |
| `advancedOptions.tavily.includeImageDescriptions` | `includeImageDescriptions` | `boolean` | `false` | `true`, `false` | — | Accepted |
| `advancedOptions.tavily.includeAnswer` | `includeAnswer` | `boolean \| string` | `false` | `true`, `false`, `basic`, `advanced` | `advanced` requires `searchDepth=advanced` | Accepted |
| `advancedOptions.tavily.includeRawContent` | `includeRawContent` | `boolean \| string` | `false` | `false`, `markdown`, `text` | Requires `searchDepth=advanced`; `false` allowed with any depth | Accepted |
| `advancedOptions.tavily.includeDomains` | `includeDomains` | `string[]` | omitted | Array of domain strings | — | Accepted |
| `advancedOptions.tavily.excludeDomains` | `excludeDomains` | `string[]` | omitted | Array of domain strings | — | Accepted |
| `advancedOptions.tavily.maxTokens` | `maxTokens` | `number` | omitted | Positive integer | — | Accepted |
| `advancedOptions.tavily.timeRange` | `timeRange` | `string` | omitted | `year`, `month`, `week`, `day`, `y`, `m`, `w`, `d` | Mutually exclusive with `days`, `startDate`, `endDate` | Accepted |
| `advancedOptions.tavily.chunksPerSource` | `chunksPerSource` | `number` | omitted | Positive integer | — | Accepted |
| `advancedOptions.tavily.country` | `country` | `string` | omitted | ISO 3166-1 alpha-2 code | — | Accepted |
| `advancedOptions.tavily.startDate` | `startDate` | `string` | omitted | ISO date string | Mutually exclusive with `days` and `timeRange` | Accepted |
| `advancedOptions.tavily.endDate` | `endDate` | `string` | omitted | ISO date string | Mutually exclusive with `days` and `timeRange` | Accepted |
| `advancedOptions.tavily.autoParameters` | `autoParameters` | `boolean` | `false` | `true`, `false` | — | Accepted |
| `advancedOptions.tavily.includeFavicon` | `includeFavicon` | `boolean` | `false` | `true`, `false` | — | Accepted |
| `advancedOptions.tavily.includeUsage` | `includeUsage` | `boolean` | `false` | `true`, `false` | — | Accepted |
| `advancedOptions.tavily.exactMatch` | `exactMatch` | `boolean` | `false` | `true`, `false` | — | Accepted |

### Unsupported / Rejected Fields

The following Tavily Search API fields are **deliberately not exposed** by the unified tool:

- `query` / `maxResults` — canonical tool-level fields, rejected inside `advancedOptions`
- `api_key` / auth fields — resolved from environment, never accepted as tool input
- Extract, crawl, map, research endpoints — outside scope
- `timeout`, `sessionId`, `humanId`, `clientName` — client-side fields not relevant to the LLM caller

### Cross-Field Constraints (enforced at validation)

- `days` is mutually exclusive with `timeRange`, `startDate`, and `endDate`.
- `startDate` and `endDate` are mutually exclusive with `days` and `timeRange`.
- `includeRawContent` (when not `false`) requires `searchDepth=advanced`.
- `includeAnswer=advanced` requires `searchDepth=advanced`.

### Rate Limits

| Environment | Requests / minute |
|---|---|
| Development | 100 |
| Production | 1,000 |

Source: <https://docs.tavily.com/documentation/rate-limits>

---

## Config Paths

| Location | Purpose |
|---|---|
| `$PI_AGENT_DIR/web-search.json` | User-provided override (deep-merged with packaged defaults) |
| `$PI_AGENT_DIR/cache/web-search/` | Shared rate-limit coordinator state (timestamp buckets, cooldown deadlines) |
| `~/.pi/agent/web-search.json` | Usual default location for `$PI_AGENT_DIR/web-search.json` |
| Packaged `config/web-search.json` | Ship-default configuration (not user-editable) |

API keys resolve from environment variables (`TINYFISH_API_KEY`, `EXA_API_KEY`, `TAVILY_API_KEY`) or the repo-root `.env` file. Keys are never accepted as tool input and never written to config files.
