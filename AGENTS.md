# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

A **pi package** (the `pi` coding agent from `@earendil-works/pi-coding-agent`) that ships extensions and skills. It is not an application and has no build output.

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

Frontmatter drives behaviour: `name` + `description` are required, and `disable-model-invocation: true` makes a skill user-invoked only (`/handoff`, `/grill-me`) rather than something the model reaches for on its own.

## Extension ↔ skill pairing

The pattern here is that an extension and a skill of the same name are two halves of one feature:

- `skills/web-search/SKILL.md` carries the *judgment* — engine-selection heuristics, when to fetch vs. search, prompt-injection safety rules, error-recovery table. None of that belongs in a tool description.

When adding a feature, decide which half it needs. Guidance-only additions (`customize-pi`, `subagent`, `handoff`, `grill-me`) are skills with no extension.

## web-search extension

Direct API calls — no `open-websearch`, no `npx`, no daemon. Architecture:

- `extensions/web-search/search.ts` — `webLookup()` walks an ordered fallback chain (`resolveChain`): the first engine that returns results wins. `chainEngines` (Exa default, DuckDuckGo backup) is what `engine: "auto"` walks; the exported `searchEngines` registry adds opt-in engines (Tavily) that run only when explicitly selected. Tracks `partialFailures` for unavailable/empty/errored engines so the agent sees why a backup was used.
- `extensions/web-search/engines/exa.ts` — ExaEngine. `POST https://api.exa.ai/search` with `x-api-key` from env `EXA_API_KEY` or the repo-root `.env` file (resolved via `../../../.env` from `engines/`). Skipped silently (`isAvailable()` false) when no key.
- `extensions/web-search/engines/duckduckgo.ts` — DuckDuckGoEngine. Scrapes `duckduckgo.com/html/` with a Firefox UA; decodes `uddg=` redirect URLs and strips the `&rut=` suffix; no API key needed.
- `extensions/web-search/strategies/readability.ts` — ReadabilityStrategy. Native `fetch()` + `linkedom` parse + `@mozilla/readability` extraction; 30s abort timeout; returns `{url, title, content, error}`.
- `extensions/web-search/index.ts` — registers `web_lookup` (search) and `fetch_web` (fetch + extract) tools with typebox params.

Dependencies: `@mozilla/readability` + `linkedom` (DOMParser doesn't exist in Node — that's why linkedom, not the plan's original approach) + `typebox`. Tests in `tests/web-search.test.ts` (run with `npx vitest run`; note the `vi.mock('node:fs')` that neutralizes the real `.env` so tests are deterministic).


## `.pi/` in this repo

`.pi/settings.json` is this workspace's own pi config and includes `".."` — the repo installs itself so the extensions and skills under development are live while working here. It also pulls `git:github.com/obra/superpowers` and the `pi-hashline-edit` / `pi-lens` / `pi-lean-ctx` npm packages.

`.pi/git/` and `.pi/npm/` are pi's local package caches (each self-ignores via its own `.gitignore`). Don't commit `.pi/` contents or treat vendored code under `.pi/git/` as part of this project.

<!-- lean-ctx -->
## lean-ctx

lean-ctx is active — the MCP tools replace native equivalents.
Full rules: LEAN-CTX.md (open on demand — do not auto-load).
<!-- /lean-ctx -->
