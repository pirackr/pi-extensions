# Native-first web search implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Automatically expose official provider-native web capabilities on every supported request, while retaining `web_lookup` and `fetch_web` as model-driven fallbacks.

**Architecture:** Add a small, pure native-capability module beside the existing web-search orchestrators. It detects supported official provider/API/endpoint combinations and idempotently augments provider payloads. The extension registers `before_provider_request`, model/session status hooks, and explicit native-first fallback guidance. Provider enablement is gated by proof that Pi preserves native server-tool results and citations.

**Tech stack:** TypeScript, Pi Extension API events, Vitest, official OpenAI Responses / Anthropic Messages / DeepSeek API payload formats.

## Global constraints

- Zero user configuration.
- Official providers/endpoints only; never infer support from a gateway model name.
- Keep `web_lookup` and `fetch_web` active.
- Never register a client tool named `web_search` because that collides with provider server-tool names.
- Preserve existing payload tools and avoid duplicates.
- Disable a provider adapter if Pi cannot round-trip its native result/citation blocks safely.
- Live tests are opt-in and must not run in the normal unit suite.

---

### Task 1: Prove Pi response compatibility before enabling providers

**Files:**

- Create: `tests/web-search-native-compat.test.ts`
- Reference only: installed `@earendil-works/pi-ai` provider serializers/parsers

- [ ] Add fixtures for OpenAI `web_search_call` output and URL citations, Anthropic `server_tool_use` + `web_search_tool_result`/`web_fetch_tool_result` + citations, and DeepSeek's documented native-search response format.
- [ ] Exercise the installed Pi provider conversion/replay helpers against each fixture.
- [ ] Assert that citation URLs/titles, provider-owned result data, and replay-required encrypted content survive conversion and serialization.
- [ ] Run `npx vitest run tests/web-search-native-compat.test.ts`.
- [ ] Record each provider as supported or unsupported. Unsupported providers must remain excluded from the capability table in Task 2; do not patch around parser loss in this package.

Expected: tests document actual installed-Pi behavior, with explicit skips/negative assertions for unsupported transports rather than false green coverage.

---

### Task 2: Implement pure capability detection and payload augmentation

**Files:**

- Create: `extensions/web-search/native.ts`
- Create: `tests/web-search-native.test.ts`

- [ ] Write failing table-driven tests for official `openai`, `anthropic`, and `deepseek` contexts, plus OpenRouter, OpenCode Zen, custom proxies, unsupported API protocols, and unsupported model families.
- [ ] Define narrow types for the active model/request context and native capability result.
- [ ] Implement `resolveNativeWebCapabilities(...)` using provider ID, API protocol, model support, and normalized effective endpoint. Do not use model-name matching as proof of an official provider.
- [ ] Write failing payload tests that preserve existing tools, add the exact provider-native definitions, and avoid duplicate definitions by server-tool type/name.
- [ ] Implement idempotent augmentation helpers for only the providers proven compatible in Task 1:
  - OpenAI Responses: native web-search tool definition.
  - Anthropic Messages: native web search and native web fetch definitions with conservative packaged limits and fetch citations enabled.
  - DeepSeek: its documented official native-search transport shape.
- [ ] Assert unsupported or malformed payloads are returned unchanged.
- [ ] Run `npx vitest run tests/web-search-native.test.ts`.

---

### Task 3: Wire native capabilities into the extension

**Files:**

- Modify: `extensions/web-search/index.ts`
- Modify: `tests/web-search.test.ts`

- [ ] Add failing extension-registration tests using a mock `pi.on` collector for `before_provider_request`, `session_start`, and `model_select`.
- [ ] Register `before_provider_request`; derive the active model and effective provider endpoint from `ctx.model`/`ctx.modelRegistry`, then call the pure augmentation helper.
- [ ] Ensure the hook returns `undefined` when no mutation is needed and a replacement payload only when a supported native definition was added.
- [ ] Add native-first prompt guidance that explicitly directs fallback to `web_lookup`/`fetch_web` after native error, empty/insufficient results, or missing fetch capability.
- [ ] Keep both existing extension tools registered and active without changing their schemas, budgets, routing, or rate-limit behavior.
- [ ] Add/update a compact status indicator: `web: native+fallback` for supported official models and `web: extension` otherwise; clear it on shutdown/reload if required by Pi lifecycle behavior.
- [ ] Run `npx vitest run tests/web-search.test.ts tests/web-search-native.test.ts`.

---

### Task 4: Test error and duplicate-tool behavior

**Files:**

- Modify: `tests/web-search-native.test.ts`
- Modify: `tests/web-search.test.ts`

- [ ] Add fixtures where native tools are already present and assert no duplicates or overwrites.
- [ ] Add fixtures with unrelated client tools and assert ordering/content are preserved.
- [ ] Add native error-result fixtures and assert the system/prompt guidance makes extension fallback available and explicit.
- [ ] Assert gateway providers with official-model-looking IDs remain extension-only.
- [ ] Assert model changes update status/capability behavior without `/reload`.
- [ ] Run the focused tests, then `npx vitest run`.

---

### Task 5: Documentation and opt-in live smoke checks

**Files:**

- Modify: `skills/web-search/SKILL.md`
- Modify: `README.md`
- Create: `tests/live-native-web.smoke.ts` (only if the repository's existing live-test convention supports exclusion from normal Vitest runs)

- [ ] Document native-first behavior, official-provider boundaries, fallback semantics, and the fact that fallback is model-driven rather than an internal retry.
- [ ] Document supported native search/fetch combinations based on Task 1 results, not assumptions.
- [ ] Add opt-in smoke cases for configured official credentials; guard every case behind an explicit environment flag and never run them in the standard suite.
- [ ] Verify OpenAI search citations, Anthropic search/fetch citations, and DeepSeek search behavior for adapters enabled by Task 1.
- [ ] Run `npx vitest run` and `lens_diagnostics mode=all` for edited files.

## Completion criteria

- Supported official models receive native web capabilities on every request with no setup.
- Gateways and unsupported providers are untouched.
- Existing extension search/fetch tools remain callable as fallbacks.
- Native definitions are idempotent and preserve client tools.
- Provider citations and replay-required blocks are proven safe.
- Full unit suite passes; live paid smoke checks remain explicit and opt-in.
