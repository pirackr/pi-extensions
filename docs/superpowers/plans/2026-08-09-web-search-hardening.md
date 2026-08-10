# Web Search Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `web_lookup` and `fetch_web` safe, bounded, cancellable, cross-provider compatible, deterministic to test, and accurate about failures.

**Architecture:** Add one public-HTTP transport boundary that validates and pins public destinations, controls redirects, time, and body size. Keep extraction and search orchestration separate; propagate cancellation, use typed operational errors, and truncate every model-visible and persisted result.

**Tech Stack:** TypeScript ESM, Pi Extension API, TypeBox/pi-ai schemas, Node HTTP/DNS/zlib APIs, Mozilla Readability, linkedom, Vitest.

## Global Constraints

- Preserve tool names `web_lookup` and `fetch_web`; never use the reserved name `web_search`.
- Keep Exa → DuckDuckGo as the `auto` chain and Tavily explicit-only.
- Permit only public HTTP(S) destinations; validate and pin every connection and redirect target.
- Use a 30-second timeout, five-redirect maximum, and 5 MiB downloaded-body maximum.
- Apply Pi's 50KB/2000-line output limits; `max_chars` may only reduce that limit.
- Caller cancellation must propagate as cancellation, not a successful result.
- Default tests must perform no external network access.
- Use test-first development and commit after every task.
- This plan intentionally contains no implementation snippets.

---

## File Structure

**Create**

- `extensions/web-search/safe-fetch.ts` — public-address validation, DNS pinning, redirects, decompression, timeout, and body limits.
- `extensions/web-search/errors.ts` — shared abort detection and typed fetch/search operational errors.
- `types/linkedom.d.ts` — narrow declaration for the used `parseHTML` API.
- `tests/web-search.integration.test.ts` — opt-in live-provider smoke tests.

**Modify**

- `extensions/web-search/index.ts` — strict schemas, error signaling, budgets, and final truncation.
- `extensions/web-search/search.ts` — cancellation-aware fallback and terminal-failure rules.
- `extensions/web-search/engines/{exa,duckduckgo,tavily}.ts` — explicit HTTP errors and deterministic parsing.
- `extensions/web-search/strategies/readability.ts` — safe transport use and nullable extraction handling.
- `extensions/web-search/types.ts` — bounded result and truncation metadata contracts.
- `tests/web-search.test.ts` — deterministic unit and integration-contract coverage.
- `skills/web-search/SKILL.md` — corrected defaults and failure/truncation behavior.
- `package.json`, `package-lock.json` — Pi peer dependencies and integration-test script.

---

### Task 1: Public HTTP transport boundary

**Files:** Create `extensions/web-search/safe-fetch.ts`, `extensions/web-search/errors.ts`; test in `tests/web-search.test.ts`.

**Interfaces:** Produce `fetchPublicHtml(url, options): Promise<SafeHtmlResponse>`, `WebFetchError`, and `isAbortError(error)`.

- [ ] Write failing tests for non-HTTP schemes, credentials, loopback/private/link-local IPv4 and IPv6, private DNS answers, mixed public/private answers, redirects to private hosts, redirect loops, oversized bodies, compressed bodies, timeout, and caller abort.
- [ ] Run the targeted transport tests and confirm they fail.
- [ ] Implement URL validation, DNS resolution, connection pinning with correct Host/SNI, redirect revalidation, gzip/deflate/Brotli decoding, and hard byte/time/redirect limits.
- [ ] Ensure abort reasons remain distinguishable from timeout and policy failures.
- [ ] Run targeted tests and confirm they pass.
- [ ] Commit as `feat: add safe public web transport`.

### Task 2: Bounded and truthful `fetch_web`

**Files:** Modify `strategies/readability.ts`, `index.ts`, `types.ts`, and `tests/web-search.test.ts`.

**Interfaces:** `ReadabilityStrategy.fetch` consumes `fetchPublicHtml`; `fetch_web` returns bounded content/details and throws terminal operational failures.

- [ ] Write failing tests for caller-abort propagation, HTTP and extraction failures, unsupported content types, null `article.content`, default truncation, stricter `max_chars`, truncated `details`, and visible truncation metadata.
- [ ] Run the targeted fetch tests and confirm they fail.
- [ ] Route Readability through the safe transport and reject missing extracted content.
- [ ] Stop swallowing strategy failures; only continue to a later strategy for explicitly recoverable unsupported-content cases.
- [ ] Truncate the formatted tool output and persisted content with Pi utilities, while preserving original-size metadata.
- [ ] Throw terminal failures so Pi marks the tool result with `isError: true`.
- [ ] Run targeted tests and confirm they pass.
- [ ] Commit as `fix: harden fetch web execution`.

### Task 3: Search cancellation, HTTP errors, and output limits

**Files:** Modify `search.ts`, `engines/exa.ts`, `engines/tavily.ts`, `engines/duckduckgo.ts`, `index.ts`, `types.ts`, and `tests/web-search.test.ts`.

**Interfaces:** Engines return results or throw `SearchEngineError`; `webLookup` rethrows aborts and applies explicit auto-versus-forced-engine failure semantics.

- [ ] Write failing tests for abort propagation, Exa/Tavily/DuckDuckGo 401/429/500 responses, network failures, auto fallback after operational failure, forced-engine failure, all-engines-failed behavior, valid empty results, and bounded final output.
- [ ] Run targeted search tests and confirm they fail.
- [ ] Make engines throw status-bearing errors instead of returning empty arrays for HTTP failures.
- [ ] In `auto`, record failures and continue; for forced engines or total operational failure, throw an actionable terminal error.
- [ ] Keep legitimate empty result sets distinct from failures and include fallback diagnostics in model-visible output.
- [ ] Apply Pi output truncation to search results and details.
- [ ] Run targeted tests and confirm they pass.
- [ ] Commit as `fix: preserve web search failures and cancellation`.

### Task 4: Robust DuckDuckGo parsing

**Files:** Modify `engines/duckduckgo.ts` and `tests/web-search.test.ts`.

**Interfaces:** Parse each DuckDuckGo result container atomically into one `SearchResult`.

- [ ] Write failing fixture tests for nested title/snippet markup, HTML entities, missing fields, malformed redirects, direct URLs with multiple query parameters, and result ordering.
- [ ] Run the parser tests and confirm they fail.
- [ ] Replace parallel regex arrays with DOM-based per-result parsing.
- [ ] Decode only DuckDuckGo redirect parameters; preserve direct URL query strings.
- [ ] Run parser and search-composition tests and confirm they pass.
- [ ] Commit as `fix: parse duckduckgo results atomically`.

### Task 5: Schema, dependency, typing, and skill alignment

**Files:** Create `types/linkedom.d.ts`; modify `index.ts`, `package.json`, `package-lock.json`, `skills/web-search/SKILL.md`, and `tests/web-search.test.ts`.

**Interfaces:** Tool schemas expose a Google-compatible engine enum, integer result limits of 1–50, and a positive bounded `max_chars`.

- [ ] Write failing schema tests for the simple string enum, integer/range validation, the 20-result default, and bounded `max_chars`.
- [ ] Replace literal unions with pi-ai `StringEnum` and remove `any` from tool parameters.
- [ ] Add `@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`, and `typebox` as `*` peer dependencies; keep only non-Pi runtime libraries in `dependencies`.
- [ ] Add the focused linkedom declaration and resolve nullable Readability types without broad `any` declarations.
- [ ] Correct the skill's default limit from 10 to 20 and document bounded output, explicit errors, and public-URL enforcement.
- [ ] Run schema tests and static diagnostics; confirm no blocking findings remain in web-search files.
- [ ] Commit as `chore: align web search contracts`.

### Task 6: Deterministic regression and Pi smoke verification

**Files:** Modify `tests/web-search.test.ts`, `package.json`; create `tests/web-search.integration.test.ts`.

**Interfaces:** `npm test` is offline and deterministic; `npm run test:web-search:integration` is explicitly opt-in.

- [ ] Replace default live DuckDuckGo, Rust page, and nonexistent-domain tests with mocked transport fixtures.
- [ ] Move live provider/page checks into the opt-in integration suite, guarded by required environment configuration.
- [ ] Run `npx vitest run tests/web-search.test.ts` and confirm all web-search tests pass without network access.
- [ ] Run `npm test` and confirm the full repository suite passes.
- [ ] Run LSP and `lens_diagnostics` on all modified files and resolve blocking findings.
- [ ] Reload the extension in Pi; verify a public page succeeds, localhost/private/redirect targets are blocked, cancellation stops promptly, and both tools remain registered.
- [ ] Review the final diff for unrelated changes and confirm all eight review findings are covered.
- [ ] Commit as `test: verify hardened web search plugin`.
