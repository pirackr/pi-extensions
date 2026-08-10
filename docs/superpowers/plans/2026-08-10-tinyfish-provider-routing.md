# TinyFish Provider Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add TinyFish-first search and fetch routing, official provider SDKs, strict advanced options, and shared cross-process rate limiting while preserving the unified tools.

**Architecture:** Provider adapters translate official SDKs into common search/fetch contracts. Thin routers apply validated options, shared reservations, retries, cooldowns, and fallback policy; `index.ts` only registers tools and formats responses.

**Tech Stack:** TypeScript, TypeBox, Vitest, `@tiny-fish/sdk`, `exa-js`, `@tavily/core`, Readability, linkedom.

**Spec:** `docs/superpowers/specs/2026-08-10-tinyfish-provider-routing-design.md`

## Global Constraints

- Keep tool names `web_lookup` and `fetch_web`.
- Search auto-chain is TinyFish → Exa → DuckDuckGo; Tavily remains explicit-only.
- Fetch chain is TinyFish → Readability, with Markdown preferred only from TinyFish.
- Do not convert Readability HTML to Markdown.
- Keep API keys in environment variables or repository `.env`; JSON configuration contains no secrets.
- Disable SDK retries where possible. Every physical attempt, including retries, consumes a shared reservation.
- Retry transient non-429 failures once by default; publish `429` cooldowns and route immediately.
- Explicit search engines never fall back.
- Reject unknown advanced-option fields before consuming quota.
- Packaged limits are TinyFish Search 30/minute, TinyFish Fetch 150 URLs/minute, Exa Search 10/second, Tavily Search 100/minute, and no invented DuckDuckGo capacity.
- User overrides load from `$PI_AGENT_DIR/web-search.json`; shared state lives under `$PI_AGENT_DIR/cache/web-search/`.
- Follow TDD and commit after each task.

## File Structure

**Create:**

- `config/web-search.json` — packaged routing and quota defaults.
- `extensions/web-search/credentials.ts` — environment and `.env` key resolution.
- `extensions/web-search/config.ts` — layered configuration loading and validation.
- `extensions/web-search/errors.ts` — normalized provider errors and retry classification.
- `extensions/web-search/rate-limit.ts` — shared reservations, locking, and cooldowns.
- `extensions/web-search/options/{tinyfish,exa,tavily,validate}.ts` — strict schemas and cross-field checks.
- `extensions/web-search/engines/tinyfish.ts` — TinyFish Search SDK adapter.
- `extensions/web-search/strategies/tinyfish.ts` — TinyFish Fetch SDK adapter.
- `extensions/web-search/fetch.ts` — fetch retry and fallback router.
- `docs/web-search-provider-options.md` — complete provider option reference.
- `tests/web-search-{options,config,rate-limit,providers}.test.ts` — focused unit tests.
- `tests/fixtures/rate-limit-worker.mjs` — cross-process limiter fixture.

**Modify:**

- `package.json`, `package-lock.json`
- `extensions/web-search/types.ts`
- `extensions/web-search/engines/{exa,tavily,duckduckgo}.ts`
- `extensions/web-search/strategies/readability.ts`
- `extensions/web-search/search.ts`
- `extensions/web-search/index.ts`
- `tests/web-search.test.ts`
- `skills/web-search/SKILL.md`
- `AGENTS.md`

---

### Task 1: Dependencies, Contracts, and Advanced Options

**Files:** `package.json`, `package-lock.json`, `extensions/web-search/types.ts`, `extensions/web-search/options/*.ts`, `tests/web-search-options.test.ts`

**Interfaces:** Define `WebLookupRequest`, `FetchWebRequest`, provider-keyed `AdvancedOptions`, normalized attempt records, fetch `format`, and request-object-based engine/strategy methods.

- [ ] Add failing tests for accepted provider fields, unknown-field rejection, canonical-field exclusion, and all documented cross-field constraints.
- [ ] Run `npx vitest run tests/web-search-options.test.ts` and confirm the new tests fail.
- [ ] Install the three official SDKs and add the shared contracts and strict TypeBox schemas.
- [ ] Implement cross-field validation without consuming quota or invoking providers.
- [ ] Rerun the focused test and existing `tests/web-search.test.ts` until both pass.
- [ ] Commit as `feat: add web provider option contracts`.

### Task 2: Credentials and Layered Configuration

**Files:** `config/web-search.json`, `extensions/web-search/credentials.ts`, `extensions/web-search/config.ts`, `tests/web-search-config.test.ts`

**Interfaces:** `loadCredentials()` returns TinyFish, Exa, and Tavily keys; `loadWebSearchConfig()` returns one validated effective configuration and warning metadata.

- [ ] Add failing tests for packaged defaults, user deep merge, invalid override recovery, and environment-over-`.env` credential precedence.
- [ ] Run `npx vitest run tests/web-search-config.test.ts` and confirm failure.
- [ ] Implement the packaged defaults and `$PI_AGENT_DIR/web-search.json` override loader.
- [ ] Centralize credential loading and remove provider-owned `.env` parsing in later adapters.
- [ ] Run the focused tests and confirm invalid config never exposes secrets.
- [ ] Commit as `feat: add web search configuration`.

### Task 3: Shared Limiter and Error Model

**Files:** `extensions/web-search/errors.ts`, `extensions/web-search/rate-limit.ts`, `tests/web-search-rate-limit.test.ts`, `tests/fixtures/rate-limit-worker.mjs`

**Interfaces:** The coordinator reserves provider/operation/fingerprint units, records `blockedUntil`, and returns explicit allowed, capacity-blocked, or cooldown-blocked outcomes.

- [ ] Add failing tests for rolling windows, API-key isolation, anonymous DuckDuckGo state, URL-unit accounting, and `Retry-After` precedence.
- [ ] Add failing spawned-process tests for lock contention, atomic updates, stale locks, stale timestamps, and restrictive file permissions.
- [ ] Run `npx vitest run tests/web-search-rate-limit.test.ts` and confirm failure.
- [ ] Implement normalized error categories and retryability rules.
- [ ] Implement the lock-protected state coordinator under `$PI_AGENT_DIR/cache/web-search/`.
- [ ] Run the focused suite repeatedly to catch concurrency flakiness, then commit as `feat: coordinate web provider rate limits`.

### Task 4: Official Search Adapters and Routing

**Files:** `extensions/web-search/engines/{tinyfish,exa,tavily,duckduckgo}.ts`, `extensions/web-search/search.ts`, `extensions/web-search/types.ts`, `tests/web-search-providers.test.ts`, `tests/web-search.test.ts`

**Interfaces:** Adapters consume `WebLookupRequest`; `webLookup(request, context?)` reserves every attempt, retries transient failures, records `partialFailures`, and returns the first successful provider.

- [ ] Add failing SDK-mock tests for TinyFish defaults, Exa `type: auto` plus Markdown text, Tavily advanced depth, limit mapping, option forwarding, cancellation, and result mapping.
- [ ] Add failing routing tests for TinyFish → Exa → DuckDuckGo, explicit-only Tavily, proactive skips, retry, 429 cooldown, cancellation, and DuckDuckGo HTTP failures.
- [ ] Run provider and search tests and confirm the new expectations fail.
- [ ] Implement TinyFish Search, migrate Exa and Tavily to official SDKs, and make DuckDuckGo surface normalized failures.
- [ ] Refactor the router around request objects, effective config, and shared reservations; preserve deduplication, engine reporting, and process budgets.
- [ ] Disable SDK retries where exposed; otherwise reserve the conservative maximum attempt count.
- [ ] Run provider, routing, and legacy tests, then commit as `feat: route search through official providers`.

### Task 5: TinyFish Fetch and Semantic Fallback

**Files:** `extensions/web-search/strategies/tinyfish.ts`, `extensions/web-search/strategies/readability.ts`, `extensions/web-search/fetch.ts`, `extensions/web-search/types.ts`, `tests/web-search-providers.test.ts`, `tests/web-search.test.ts`

**Interfaces:** `fetchWeb(request, context?)` returns native content, `format`, successful `strategy`, and ordered attempt outcomes.

- [ ] Add failing tests for Markdown default, explicit HTML/JSON, selector and conditional options, title/content mapping, truncation, and cancellation.
- [ ] Add failing tests for allowed infrastructure fallbacks and terminal semantic errors that must not reach Readability.
- [ ] Run fetch-focused tests and confirm failure.
- [ ] Implement the TinyFish SDK strategy and mark Readability output as HTML.
- [ ] Move fetch orchestration from `index.ts` into `fetch.ts`, including reservations, retry, cooldown, and semantic fallback classification.
- [ ] Run all fetch tests, then commit as `feat: add TinyFish-first web fetching`.

### Task 6: Tool Schemas and User-Facing Documentation

**Files:** `extensions/web-search/index.ts`, `docs/web-search-provider-options.md`, `skills/web-search/SKILL.md`, `AGENTS.md`, `tests/web-search-options.test.ts`, `tests/web-search.test.ts`

**Interfaces:** Registered tools expose strict provider-keyed `advancedOptions`; fetch details include `format` and `attempts` while existing call-budget flags remain unchanged.

- [ ] Add failing extension tests for the TinyFish engine enum, advanced schemas, formatted attempts, native format labels, and truncation notices.
- [ ] Update `index.ts` to validate and delegate only; retain budget accounting and concise text rendering.
- [ ] Write the complete TinyFish Search/Fetch, Exa Search, and Tavily Search options reference from official docs and installed SDK types.
- [ ] Add the schema-to-reference coverage assertion and label unsupported, deprecated, canonical, and streaming fields.
- [ ] Update the skill version, routing guidance, Markdown preference, config paths, retries, shared limits, and `AGENTS.md` architecture notes.
- [ ] Run extension and documentation-contract tests, then commit as `docs: document advanced web providers`.

### Task 7: Final Verification

**Files:** All changed files

- [ ] Run `npx vitest run` and require a clean pass.
- [ ] Run `lsp_diagnostics` on `extensions/web-search`, new tests, and `extensions/web-search/index.ts`; resolve all errors.
- [ ] Run `lens_diagnostics mode=all` and resolve blocking findings in edited files.
- [ ] Load the extension with `pi -e ./extensions/web-search/index.ts` and confirm both tools register without load errors.
- [ ] Exercise schema rejection locally without making provider requests, then test configured providers only when credentials are available.
- [ ] Confirm `git status --short` contains no generated secrets or shared rate-state files; commit final fixes as `test: verify web provider integration` only if needed.
