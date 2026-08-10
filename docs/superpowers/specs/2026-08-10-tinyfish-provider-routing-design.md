# TinyFish Provider Routing and Advanced Options — Design Spec

**Date:** 2026-08-10

## Goal

Integrate TinyFish into the existing `web_lookup` and `fetch_web` tools without adding provider-specific tools. Search should prefer TinyFish, retain Exa and DuckDuckGo fallbacks, and keep Tavily as an explicit advanced engine. Fetch should prefer TinyFish's Markdown output and fall back to local Mozilla Readability when that fallback can preserve the caller's intent.

At the same time, migrate every supported provider integration to its official JavaScript SDK, expose strictly typed provider-specific advanced options, and coordinate proactive rate limiting, retries, and cooldowns across all Pi and subagent processes that share provider credentials.

## Scope

This design covers:

- TinyFish Search and Fetch integration;
- migration of Exa and Tavily search implementations to official SDKs;
- the existing direct DuckDuckGo HTML and local Readability implementations;
- unified search and fetch routing;
- provider-keyed `advancedOptions` schemas;
- layered non-secret configuration;
- cross-process rate-limit accounting and cooldowns;
- retry and fallback behavior;
- common result and error contracts;
- a provider-options reference document;
- tests and documentation updates.

It does not add TinyFish Agent or Browser APIs, Tavily Extract/Crawl/Research APIs, Exa Contents as a separate tool, provider login commands, stored API keys, HTML-to-Markdown conversion, or provider-specific Pi tools.

## Public Tool Contracts

The existing tool names remain stable.

### `web_lookup`

Conceptual input:

```typescript
{
  query: string;
  limit?: number;
  engine?: "auto" | "tinyfish" | "exa" | "duckduckgo" | "tavily";
  advancedOptions?: {
    tinyfish?: TinyFishSearchOptions;
    exa?: ExaSearchOptions;
    tavily?: TavilySearchOptions;
  };
}
```

Routing behavior:

- `engine: "auto"` or an omitted engine uses `tinyfish -> exa -> duckduckgo`.
- `engine: "tinyfish"`, `"exa"`, or `"duckduckgo"` runs that provider alone.
- `engine: "tavily"` runs Tavily alone. Tavily remains an explicit advanced-search choice and never enters the automatic chain.
- Explicit provider selection never falls through to another provider.

`query` and `limit` are canonical tool-level fields. Provider-native query and result-count fields are not duplicated under `advancedOptions`. The adapter maps `limit` to the provider's native field and applies the provider's own maximum. The public tool continues to clamp `limit` to `1..50`; the provider-options reference records stricter or broader provider limits.

`advancedOptions` is provider-keyed so every candidate in an automatic route receives only its own options. Unknown fields are rejected before any quota reservation or network request. Authentication fields are never accepted as tool input.

### `fetch_web`

Conceptual input:

```typescript
{
  url: string;
  max_chars?: number;
  advancedOptions?: {
    tinyfish?: TinyFishFetchOptions;
  };
}
```

Routing behavior:

- TinyFish Fetch is attempted first.
- Local Mozilla Readability is the fallback when fallback can preserve the caller's intent.
- TinyFish requests Markdown by default.
- A caller may explicitly request TinyFish HTML or JSON through `advancedOptions.tinyfish.format`.
- Readability retains its native semantic HTML output. No HTML-to-Markdown conversion dependency is added.

`content` means readable extracted content in the successful strategy's native format. JSON results are serialized into readable JSON text for Pi's text content while the structured value may also remain in result details. `max_chars` is applied after extraction. Output must also obey Pi's tool-output safety limits and explicitly report truncation.

`FetchResponse` adds:

```typescript
{
  url: string;
  title: string;
  content: string;
  strategy: string;
  format: "markdown" | "html" | "json" | "text" | "unknown";
  error: string | null;
  attempts: Array<{
    strategy: string;
    outcome: "success" | "skipped" | "failed" | "rate_limited";
    reason?: string;
  }>;
}
```

The existing `strategy` field remains the successful strategy. Failed or skipped attempts are preserved in `attempts` without exposing credentials or sensitive headers.

## Provider Implementations

Official SDKs are used wherever an applicable official JavaScript SDK exists:

| Provider | Operation | Implementation |
| --- | --- | --- |
| TinyFish | Search, Fetch | `@tiny-fish/sdk` |
| Exa | Search | `exa-js` |
| Tavily | Search | `@tavily/core` |
| DuckDuckGo | Search | Existing direct HTML endpoint parser |
| Readability | Fetch | Existing `@mozilla/readability` + `linkedom` strategy |

DuckDuckGo and Readability remain direct implementations because there is no applicable official provider SDK to adopt.

Provider defaults remain explicit and deterministic when no advanced options are supplied:

- TinyFish Search uses its standard web-search defaults; the adapter slices the returned page to the canonical `limit`.
- TinyFish Fetch requests Markdown.
- Exa Search uses `type: "auto"` and requests Markdown page text, preserving the current integration's behavior.
- Tavily Search uses `searchDepth: "advanced"`, preserving its advanced-only role. A caller may override documented Tavily request options explicitly.
- DuckDuckGo behavior remains unchanged.

Provider adapters own SDK construction, option mapping, abort handling, response mapping, and provider-error normalization. Routers do not import SDK-specific response types. SDK-internal automatic retries are disabled where supported; retries are coordinated above the adapters so every physical attempt is represented in shared quota accounting. If an SDK cannot disable or expose retries, the adapter must conservatively reserve the configured maximum attempt count and document that behavior.

Search adapters map provider responses into the existing common shape:

```typescript
interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  engine: string;
}
```

Provider-specific metadata may remain in tool-result details, but the LLM-facing list remains title, URL, snippet, and engine. Adapters choose the densest readable source available for snippets. Markdown is preferred when a provider offers it.

## Advanced Option Schemas

Schemas are split from routing and adapters:

```text
extensions/web-search/
├── options/
│   ├── tinyfish.ts
│   ├── exa.ts
│   ├── tavily.ts
│   └── validate.ts
```

The TypeBox schemas are strict and use Google-compatible string enums. They expose every current option applicable to these integrated endpoints except:

- API keys or authentication configuration;
- canonical query, URL, and result-count inputs;
- streaming modes that cannot produce a normal synchronous Pi tool result.

Unsupported and deprecated options are recorded in documentation with the reason they are unavailable. They are not accepted as opaque pass-through fields.

Cross-field validation supplements JSON-schema validation. It covers at least:

- TinyFish recency versus calendar-date exclusivity;
- TinyFish date and publication-year ordering;
- TinyFish research-paper filter restrictions;
- TinyFish conditional-fetch and selector constraints;
- Exa category/filter incompatibilities;
- Exa nested contents and output-schema constraints represented by the SDK;
- Tavily date, topic, depth, raw-content, and other documented option dependencies.

Validation happens before rate-limit reservation. A validation error is terminal for the tool call and cannot trigger provider fallback.

## Routing and Retry Flow

### Search

For each resolved candidate:

1. Check provider availability and credential presence.
2. Ask the shared coordinator to reserve capacity for one attempt.
3. Invoke the official SDK or direct DuckDuckGo adapter.
4. If the attempt returns results, stop and return them.
5. If the attempt returns no results, record the outcome and continue only when the route is automatic.
6. If a transient non-429 failure occurs, reserve capacity again and retry up to the provider's configured `maxRetries` value; the default is one retry.
7. If a retry fails, record the failure and continue only when the route is automatic.
8. If a `429` occurs, do not retry immediately. Publish a shared cooldown and continue only when the route is automatic.

Transient failures are network errors, request timeouts, HTTP 408, and retryable 5xx responses. Authentication, permission, and provider validation failures are not retried. In automatic mode they are recorded in `partialFailures` before routing continues. In explicit mode they are returned as the sole provider failure.

Every physical attempt counts against the local proactive limiter. Provider documentation does not guarantee that failed requests are excluded from request-rate accounting; billing credits and request-rate quotas are treated as separate concerns.

### Fetch

TinyFish is attempted and retried using the same reservation policy. Readability fallback is allowed for:

- missing TinyFish credentials;
- proactive local quota exhaustion;
- an active shared cooldown;
- HTTP 429;
- timeout, transport, or retryable service failure;
- bot blocking;
- target unreachability;
- empty extracted content.

Readability fallback is not allowed for:

- invalid tool or provider options;
- invalid URL;
- selector mismatch or unsupported selectors;
- conditional-request misuse or unsupported conditional behavior;
- any other semantic failure where Readability cannot honor the requested operation.

These failures return the precise TinyFish error rather than silently returning unrelated full-page HTML.

## Configuration

Non-secret configuration is layered in this order:

1. packaged `config/web-search.json`;
2. optional user override at `$PI_AGENT_DIR/web-search.json`, with `~/.pi/agent/web-search.json` as the normal default location.

The override is deep-merged with packaged defaults and then fully validated. Invalid user configuration produces a visible warning and uses the validated packaged defaults. API keys are not permitted in either JSON file.

Credentials continue to resolve from environment variables first and the repository-root `.env` second:

- `TINYFISH_API_KEY`
- `EXA_API_KEY`
- `TAVILY_API_KEY`

Illustrative configuration shape:

```json
{
  "routing": {
    "searchAuto": ["tinyfish", "exa", "duckduckgo"],
    "fetch": ["tinyfish", "readability"]
  },
  "providers": {
    "tinyfish": {
      "search": { "capacity": 30, "windowMs": 60000, "maxRetries": 1 },
      "fetch": { "capacity": 150, "windowMs": 60000, "maxRetries": 1 }
    },
    "exa": {
      "search": { "capacity": 10, "windowMs": 1000, "maxRetries": 1 }
    },
    "tavily": {
      "search": { "capacity": 100, "windowMs": 60000, "maxRetries": 1 }
    },
    "duckduckgo": {
      "search": {
        "capacity": null,
        "windowMs": 60000,
        "maxRetries": 1,
        "fallbackCooldownMs": 60000
      }
    }
  }
}
```

Packaged defaults reflect currently documented entry-level limits:

- TinyFish Search: 30 requests/minute;
- TinyFish Fetch: 150 URLs/minute;
- Exa Search: 10 queries/second;
- Tavily development keys: 100 requests/minute.

Tavily production keys and higher TinyFish plans are configured through the user override. DuckDuckGo's scraped HTML endpoint has no published quota, so it participates in shared tracking and reactive cooldowns but has no invented proactive capacity by default. A user may configure one.

Existing `--web-search-max-lookups` and `--web-search-max-fetches` process budgets remain independent hard call-count caps. They govern research-agent behavior; provider rate limits govern shared provider capacity over time.

## Cross-Process Rate-Limit Coordinator

The coordinator persists runtime state under `$PI_AGENT_DIR/cache/web-search/`. State is shared by every Pi and subagent process for the current user.

Buckets are keyed by:

- provider;
- operation (`search` or `fetch`);
- a non-reversible fingerprint of the API key;
- a fixed anonymous identity for DuckDuckGo.

No API key is written to disk. State files use restrictive permissions and contain only request timestamps, cooldown deadlines, and minimal version metadata.

Reservation uses an atomic lock file created with exclusive-create semantics. The complete read-prune-reserve-write sequence occurs while holding the lock. The implementation includes bounded lock acquisition, jittered retry, stale-lock recovery, atomic state replacement, and schema-version recovery. A crashed process may leave a reservation until its time window expires; conservative temporary over-reservation is preferable to exceeding a provider limit.

Before each physical request, the caller reserves capacity. If the configured rolling window is full, the provider is skipped without making a request. A `429` sets `blockedUntil` for the corresponding shared bucket. The coordinator uses `Retry-After` when a provider supplies it and otherwise applies the configured fallback cooldown.

TinyFish Search and Fetch use separate buckets because their limits use different units. Fetch reservations count URLs, not HTTP batches; the current tool sends one URL, so one tool attempt reserves one URL. Tavily and TinyFish use minute windows, while Exa uses its documented one-second QPS window.

## Error Model and Observability

Provider adapters normalize failures into:

- `authentication`;
- `validation`;
- `permission`;
- `rate_limit`;
- `quota_exhausted`;
- `timeout`;
- `transport`;
- `service`;
- `empty_results`;
- `provider_result`.

Search `partialFailures` and fetch `attempts` distinguish unavailable credentials, proactive skips, cooldown skips, retries, provider errors, and empty results. Error text is concise and actionable. It never includes API keys, authorization headers, full SDK request objects, or untrusted response bodies.

SDK request cancellation uses Pi's supplied `AbortSignal` wherever the SDK supports it. Adapters must stop routing after cancellation and must not treat user cancellation as a retryable provider failure.

## Provider Options Reference

Implementation adds `docs/web-search-provider-options.md`. It covers only the endpoints integrated here:

- TinyFish Search;
- TinyFish Fetch;
- Exa Search, including nested content options;
- Tavily Search.

For each option, the document records:

- exact tool field path;
- provider-native SDK/API field;
- type, default, and allowed values;
- constraints and incompatible combinations;
- cost or credit effects where officially documented;
- whether the unified tool changes or caps it;
- unsupported or deprecated status;
- official source URL;
- last-verified date.

The reference also explains canonical mappings for `query`, `limit`, and `url`, Markdown preference, retry accounting, and routing behavior. A contract test ensures every accepted provider schema property appears in the reference. The document may describe provider-native fields that the unified tool deliberately rejects, but must label them clearly.

Primary sources for the initial reference include:

- TinyFish Search: <https://docs.tinyfish.ai/search-api/reference>
- TinyFish Fetch: <https://docs.tinyfish.ai/fetch-api/reference>
- TinyFish integration guidance: <https://docs.tinyfish.ai/for-coding-agents>
- Exa Search: <https://exa.ai/docs/reference/search-api-guide-for-coding-agents>
- Exa rate limits: <https://exa.ai/docs/reference/rate-limits>
- Tavily Search: <https://docs.tavily.com/documentation/api-reference/endpoint/search>
- Tavily rate limits: <https://docs.tavily.com/documentation/rate-limits>

## Testing

Automated coverage includes:

1. packaged configuration loading and strict validation;
2. user override deep-merge precedence;
3. invalid override warning and packaged-default recovery;
4. credential precedence without exposing secrets;
5. strict provider option schemas and unknown-field rejection;
6. provider cross-field validation;
7. SDK argument mapping for TinyFish, Exa, and Tavily;
8. common search-result mapping for every provider;
9. TinyFish Markdown, HTML, JSON, and error-result mapping;
10. automatic search order and first-success behavior;
11. explicit-provider isolation, including Tavily;
12. transient retry accounting and failed-retry fallback;
13. immediate 429 cooldown and fallback;
14. fetch fallback versus terminal semantic errors;
15. cross-process rolling-window reservations using temporary state files;
16. concurrent lock contention and atomic updates;
17. stale timestamp, stale lock, and incompatible-state cleanup;
18. API-key fingerprint isolation and DuckDuckGo's anonymous bucket;
19. independent enforcement of existing research call budgets;
20. fetch format metadata and output truncation;
21. abort behavior without retry or fallback;
22. schema-to-reference-document coverage;
23. updated extension tool schemas and descriptions.

Provider SDKs and network calls are mocked in deterministic unit tests. Existing live DuckDuckGo and Readability smoke tests may remain separate from routing tests so provider availability cannot make core behavior nondeterministic. The full Vitest suite and diagnostics must pass.

## Documentation Updates

In addition to the provider-options reference:

- `skills/web-search/SKILL.md` documents the new automatic chain, explicit Tavily behavior, `advancedOptions`, TinyFish-first fetch, native format reporting, retries, and shared limits;
- `AGENTS.md` documents SDK ownership, config locations, shared state, and routing boundaries;
- tool descriptions describe TinyFish preference and provider-specific options without overloading the prompt with the entire reference;
- the skill version is incremented.

## Migration

1. Add official SDK dependencies.
2. Add provider option schemas and validation.
3. Add packaged/user configuration loading.
4. Add the shared rate-limit coordinator and deterministic concurrency tests.
5. Implement the TinyFish Search and Fetch adapters.
6. Migrate Exa and Tavily adapters to their official SDKs.
7. Extend common interfaces and response details.
8. Update search and fetch routing.
9. Add the complete provider-options reference.
10. Update the web-search skill and `AGENTS.md`.
11. Run the full test and diagnostic suite.

The migration preserves the existing tool names, top-level search/fetch inputs, research budget flags, and Tavily's explicit-only status. The only public additions are `engine: "tinyfish"`, provider-keyed `advancedOptions`, and richer fetch-result metadata.
