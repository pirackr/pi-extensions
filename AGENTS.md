# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A **pi package** (the `pi` coding agent from `@earendil-works/pi-coding-agent`) that ships extensions, skills, and prompt templates. It is not an application and has no build output.

`package.json` has no `scripts` and no `dependencies` — the `"keywords": ["pi-package"]` entry is what marks the directory as an installable pi package. There is **nothing to build, lint, or test**; pi loads the TypeScript directly via jiti at runtime.

## Development loop

```bash
pi install -l ../pi-extensions   # register in a project's .pi/settings.json
pi install ~/Working/grinder/pi-extensions   # or globally, in ~/.pi/agent/settings.json
pi -e ./extensions/web-search/index.ts       # load one extension for a throwaway run
```

Iterate by editing a file and running `/reload` inside pi — extensions, skills, prompts and themes hot-reload with no restart. Verify a tool registered with `pi list` / `pi config`; watch the TUI for load errors. The only way to "test" a change is to exercise the tool in a pi session.

## Layout conventions (auto-discovery)

Pi discovers resources by path, so directory shape is load-bearing:

- `extensions/*.ts` or `extensions/<name>/index.ts` — an extension module. Default-exports `function (pi: ExtensionAPI)` and calls `pi.registerTool(...)` / `pi.on(...)` / `pi.registerCommand(...)`.
- `skills/<name>/SKILL.md` — a skill. **Must** be a directory containing `SKILL.md`; a flat `skills/foo.md` is not discovered (this is why `skills/subagent-skill.md` became `skills/subagent/SKILL.md`).
- `prompts/<name>.md` — a prompt template, invoked as `/name` (e.g. `prompts/plan.md` → `/plan`). Filename becomes the command name; `description` + optional `argument-hint` frontmatter drive autocomplete; `$@`/`${@:-default}` substitute arguments.

Frontmatter drives behaviour: `name` + `description` are required, and `disable-model-invocation: true` makes a skill user-invoked only (`/handoff`, `/grill-me`) rather than something the model reaches for on its own.

## Extension ↔ skill pairing

The pattern here is that an extension and a skill of the same name are two halves of one feature:

- `skills/web-search/SKILL.md` carries the *judgment* — engine-selection heuristics, when to fetch vs. search, prompt-injection safety rules, error-recovery table. None of that belongs in a tool description.

When adding a feature, decide which half it needs. Guidance-only additions (`customize-pi`, `subagent`, `handoff`, `grill-me`) are skills with no extension.

## web-search extension

Direct API calls — no `open-websearch`, no `npx`, no daemon. Architecture:

- `extensions/web-search/search.ts` — `webLookup()` walks an ordered fallback chain (`resolveChain`): the first engine that returns results wins. `chainEngines` (TinyFish default, Exa backup, DuckDuckGo last) is what `engine: "auto"` walks; the exported `searchEngines` registry adds opt-in engines (Tavily) that run only when explicitly selected. Tracks `partialFailures` for unavailable/empty/errored engines so the agent sees why a backup was used.
- `extensions/web-search/engines/tinyfish.ts` — TinyFishEngine. Uses `@tiny-fish/sdk` (`TinyFish.search.query()`). Skipped silently when no `TINYFISH_API_KEY`.
- `extensions/web-search/engines/exa.ts` — ExaEngine. Uses `exa-js` (`Exa.search()`). Skipped silently when no `EXA_API_KEY`.
- `extensions/web-search/engines/duckduckgo.ts` — DuckDuckGoEngine. Scrapes `duckduckgo.com/html/` with a Firefox UA; decodes `uddg=` redirect URLs and strips the `&rut=` suffix; no API key needed.
- `extensions/web-search/engines/tavily.ts` — TavilyEngine. Uses `@tavily/core` (`tavily.search()`). Skipped silently when no `TAVILY_API_KEY`.
- `extensions/web-search/strategies/tinyfish.ts` — TinyFishFetchStrategy. Uses `@tiny-fish/sdk` (`TinyFish.fetch.getContents()`); requests Markdown by default.
- `extensions/web-search/strategies/readability.ts` — ReadabilityStrategy. Native `fetch()` + `linkedom` parse + `@mozilla/readability` extraction; 30s abort timeout; returns `{url, title, content, error}`.
- `extensions/web-search/options/{tinyfish,exa,tavily}.ts` — strict TypeBox schemas (`TinyFishSearchOptionsSchema`, `TinyFishFetchOptionsSchema`, `ExaSearchOptionsSchema`, `TavilySearchOptionsSchema`) with `additionalProperties: false`. Cross-field validation in `options/validate.ts`.
- `extensions/web-search/index.ts` — registers `web_lookup` (search) and `fetch_web` (fetch + extract) tools with typebox params. Tool schemas use the strict provider-keyed schemas so unknown fields are rejected at the tool boundary.

### SDK Ownership

| Provider | SDK | Operation |
| --- | --- | --- |
| TinyFish | `@tiny-fish/sdk` | Search, Fetch |
| Exa | `exa-js` | Search |
| Tavily | `@tavily/core` | Search |
| DuckDuckGo | (none — direct HTML) | Search |
| Readability | `@mozilla/readability` + `linkedom` | Fetch |

### Config and Shared State

- Packaged defaults: `config/web-search.json` (not user-editable).
- User override: `$PI_AGENT_DIR/web-search.json` (deep-merged with packaged defaults; unusual default: `~/.pi/agent/web-search.json`).
- Shared rate-limit state: `$PI_AGENT_DIR/cache/web-search/` — rolling-window buckets keyed by provider + operation + API-key fingerprint. Cross-process, shared by all Pi and subagent processes.
- API keys resolve from env vars (`TINYFISH_API_KEY`, `EXA_API_KEY`, `TAVILY_API_KEY`) or repo-root `.env`; never accepted as tool input, never written to config files.

### Routing Boundaries

- `engine: "auto"` → TinyFish → Exa → DuckDuckGo (first with results wins).
- Explicit engine (`tinyfish`, `exa`, `duckduckgo`, `tavily`) runs that provider alone — no fallback.
- Tavily is opt-in only; never enters the automatic chain.
- `advancedOptions` is provider-keyed; unknown provider keys and unknown fields are rejected before any quota reservation.
- Fetch: TinyFish attempted first (Markdown); Readability fallback for infrastructure failures only (not validation errors).
- Every physical attempt reserves capacity in the shared coordinator; retries count against quota.
- Hard per-process budgets (`--web-search-max-lookups`, `--web-search-max-fetches`) are independent of provider rate limits.

Dependencies: `@mozilla/readability` + `linkedom` (DOMParser doesn't exist in Node — that's why linkedom, not the plan's original approach) + `typebox`. Tests in `tests/web-search.test.ts` (run with `npx vitest run`; note the `vi.mock('node:fs')` that neutralizes the real `.env` so tests are deterministic).


## opencode-zen extension

`extensions/opencode-zen/index.ts` registers an `opencode-zen` provider so pi can use OpenCode Zen's hosted models — including the free tier (`deepseek-v4-flash-free`, `nemotron-3-ultra-free`, `big-pickle`, ...) with no account. This is how the opencode CLI itself works: it authenticates anonymously with the shared credential `public` plus opencode client headers (`x-opencode-client`, `x-opencode-session`, `x-opencode-project`, `x-opencode-request`) and a CLI User-Agent; the Zen gateway grants the free models, rate-limited.

- Key resolution: `OPENCODE_API_KEY` env → `auth.json` `opencode-zen` entry → anonymous `public`. Anonymous mode filters the catalog to free models (models.dev `cost.input === 0`).
- `baseUrl` `https://opencode.ai/zen/v1`, `api: "openai-completions"` — only models served over `/chat/completions` are registered (all free models plus the DeepSeek/MiniMax/GLM/Kimi paid families). Claude/GPT/Gemini lines need other streaming APIs and are omitted.
- Model list is refined at load: live `GET /zen/v1/models` narrows, models.dev `status: deprecated` drops, anonymous mode keeps free only. `staticModels` in the file is the offline fallback — refresh it when the Zen catalog rotates.
- Data caveat: free models are limited-time promos and some log data for model improvement (see opencode.ai/docs/zen).

## `.pi/` in this repo

`.pi/settings.json` is this workspace's own pi config and includes `".."` — the repo installs itself so the extensions and skills under development are live while working here. It also pulls `git:github.com/obra/superpowers` and the `pi-hashline-edit` / `pi-lens` / `pi-lean-ctx` npm packages.

`.pi/git/` and `.pi/npm/` are pi's local package caches (each self-ignores via its own `.gitignore`). Don't commit `.pi/` contents or treat vendored code under `.pi/git/` as part of this project.

<!-- lean-ctx -->
## lean-ctx

lean-ctx is active — the MCP tools replace native equivalents.
Full rules: LEAN-CTX.md (open on demand — do not auto-load).
<!-- /lean-ctx -->
<!-- /lean-ctx -->
