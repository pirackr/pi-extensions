# Tavily opt-in engine — v2.2.0 design

## Goal

Add Tavily as an **opt-in** search engine for `web_lookup`. Tavily never runs in the
automatic fallback chain — it executes only when the model explicitly passes
`engine: "tavily"`. Purpose: heavy deep-research queries where the caller wants
Tavily's advanced-depth crawl instead of (or in addition to) Exa/DuckDuckGo.

## Decisions (from discussion)

- **Not in the chain.** The `"auto"` fallback chain stays `exa → duckduckgo`,
  byte-for-byte unchanged. Tavily is reachable only via explicit selection.
- **`search_depth: "advanced"`** — the caller opted into Tavily deliberately for
  heavy research; advanced depth is the point of the call. Cost lands only on
  explicit calls.
- **Runs alone.** Forcing `engine: "tavily"` runs Tavily only — no chain, no
  fallback if it fails (same as forcing any other engine).
- **Out of scope:** no changes to the `/research` loop or `examples/deep-research/`
  program (user will wire Tavily into the research flow later).

## Engine: `engines/tavily.ts` (new)

Mirrors `engines/exa.ts`:

- Key: `TAVILY_API_KEY` — env first, then `.env` via the shared
  `../../../.env` loader pattern. `isAvailable()` returns false without a key.
- Call: `POST https://api.tavily.com/search`
  - Body: `{ api_key, query, search_depth: "advanced", max_results: clamp(limit, 1, 20) }`
  - Tavily's hard `max_results` cap is 20 (vs Exa's 50); the tool-level 1–50
    clamp still applies upstream.
- Response mapping: `results[].content` → `snippet` (trimmed, ≤500 chars),
  `title`/`url` direct, `engine: "tavily"`. Non-ok HTTP response → `[]`
  (consistent with Exa, which the chain treats as a fallback trigger).

## Registry split: `search.ts`

Separate the auto-chain from the full registry so opt-in engines can't leak
into `"auto"`:

- `chainEngines` (module-private): `[ExaEngine, DuckDuckGoEngine]` — walked by
  `engine: "auto"`.
- `searchEngines` (exported): `[...chainEngines, TavilyEngine]` — full registry
  used for explicit selection.
- `resolveChain`:
  - `"auto"` / `undefined` / unknown → `chainEngines` (Tavily absent)
  - `"exa"` / `"duckduckgo"` / `"tavily"` → `[that engine]` only

`webLookup` itself is unchanged — it already walks `resolveChain(engine)` and
reports unavailable/empty/error cases in `partialFailures`.

## Types: `types.ts`

- `EngineChoice = "auto" | "exa" | "duckduckgo" | "tavily"` — add `"tavily"`.

## Tool schema: `index.ts`

- Add `Type.Literal("tavily")` to the `engine` union.
- Update the tool description: Tavily requires `TAVILY_API_KEY`, uses advanced
  depth, and runs only when explicitly requested (for heavy research).

## Docs

- `skills/web-search/SKILL.md` → v2.2.0: new "Opt-in engines" note — Tavily
  (advanced depth, key required) is excluded from the chain and used only on
  explicit `engine: "tavily"` calls, e.g. heavy deep research.
- `AGENTS.md`: update the `search.ts` architecture line to mention the
  chain/full-registry split and Tavily.

## Tests (`tests/web-search.test.ts`)

- Registry: `searchEngines` has 3 entries incl. `tavily`; chain resolution for
  `"auto"`/`undefined` yields exactly `["exa", "duckduckgo"]` (tavily absent).
- `resolveChain("tavily")` → `["tavily"]`.
- Forced `"tavily"` with no key (env cleared, fs mock active): no results,
  `engines: []`, `partialFailures` contains a `tavily` "not available" entry.
- Default `webLookup` (no keys) still falls back to DuckDuckGo and never
  touches Tavily.

## Error handling

| Case | Behavior |
| ---- | -------- |
| No `TAVILY_API_KEY` | `isAvailable()` false → skipped with `partialFailures` note when forced; never part of auto |
| Non-ok HTTP / network error | `search()` returns `[]` / throws → reported via `partialFailures` |
| `max_results` > 20 requested | clamped to 20 inside the engine |
