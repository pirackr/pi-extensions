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

Every tool shells out to `npx open-websearch <subcommand> ... --json` through a single `runOpenWebSearch` helper (`execFile`, 60s timeout, 10MB buffer) and then hand-formats `result.data` into readable text for the model while returning the raw JSON in `details`. Consequences to keep in mind:

- No API keys and no daemon; the first invocation pays an ~10–20MB `npx` download.
- Adding a tool means adding a subcommand mapping, not new HTTP code.
- `ALLOWED_ENGINES` is declared but the `engine` parameter is a free-form `Type.String()`, so engine names are not validated before being passed to the CLI.

## `.pi/` in this repo

`.pi/settings.json` is this workspace's own pi config and includes `".."` — the repo installs itself so the extensions and skills under development are live while working here. It also pulls `git:github.com/obra/superpowers` and the `pi-hashline-edit` / `pi-lens` / `pi-lean-ctx` npm packages.

`.pi/git/` and `.pi/npm/` are pi's local package caches (each self-ignores via its own `.gitignore`). Don't commit `.pi/` contents or treat vendored code under `.pi/git/` as part of this project.
