---
name: customize-pi
description: "Use when customizing pi coding agent: adding custom models/providers, writing or hot-reloading extensions, editing settings.json/models.json packages, and resolving project trust or API key auth."
---

# Customizing Pi Configuration & Extensions

## Overview

Pi configures behavior through a stack of JSON files plus TypeScript extensions. This skill gives you the **locations, precedence, key commands, and decision flows** for the whole stack — from `settings.json` (behavior: theme, compaction, retry, model defaults) to `models.json` (custom providers/models) to extensions (custom tools, providers, event hooks). It does **not** duplicate pi's full API; it cross-references the bundled docs so you fetch heavy reference on demand.

**Core principle:** one concern per file.
- Settings (behavior) → `~/.pi/agent/settings.json`
- Models/providers (catalog) → `~/.pi/agent/models.json`
- Custom logic (tools, providers, hooks) → extensions
- Sharing (extensions/skills/prompts/themes) → package.json + `pi install`

## Config File Map

| File | Scope | Purpose | Reload |
|------|-------|---------|--------|
| `~/.pi/agent/settings.json` | Global | Behavior: theme, compaction, retry, model defaults, resource paths | Restart / `/reload` |
| `.pi/settings.json` | Project | Overrides global (deep-merged) | Restart / `/reload` |
| `~/.pi/agent/models.json` | Global | Custom providers + models (Ollama, vLLM, proxies) | On `/model` open |
| `~/.pi/agent/trust.json` | Global | Saved project trust decisions | Restart |
| `~/.pi/agent/auth.json` | Global | API keys + OAuth tokens (0600) | Live |
| `~/.pi/agent/skills/`, `.pi/skills/` | Global/Project | Skill directories | `/reload` |
| `~/.pi/agent/prompts/`, `.pi/prompts/` | Global/Project | Prompt templates (`/name`) | `/reload` |
| `~/.pi/agent/themes/`, `.pi/themes` | Global/Project | Themes | `/reload` |

### Resource paths in `settings.json`

`packages`, `extensions`, `skills`, `prompts`, `themes` arrays in `settings.json` point at extra locations (absolute, `~`, or relative to `~/.pi/agent` global / `.pi` project). Arrays support globs, `!exclusions`, `+exact-include`, `-exact-exclude`. In extensions, build project-local paths with `CONFIG_DIR_NAME` — **never hardcode `.pi`** (rebranded distributions use a different config dir).

### Precedence & locations

Project-local (`.pi/`) overrides global (`~/.pi/agent/`). Nested `settings.json` objects are merged deeply (`theme` stays, `compaction.reserveTokens` is overridden).

- **Extensions** auto-discovered from:
  - Global: `~/.pi/agent/extensions/*.ts`, `~/.pi/agent/extensions/*/index.ts`
  - Project (`.pi/extensions/`, only after trust): `.pi/extensions/*.ts`, `.pi/extensions/*/index.ts`
  - Plus `settings.json` `extensions` array; or CLI `pi -e ./path.ts` (temp, current run only)
- **npm packages** install to `~/.pi/agent/npm/` (global) or `.pi/npm/` (project).
- **git packages** clone to `~/.pi/agent/git/<host>/<path>` (global) or `.pi/git/<host>/<path>` (project).
- Skills/prompts/themes follow the same global/project auto-discovery; project dirs load only after trust.

## Quick Reference: Commands

| Command | Purpose |
|---------|---------|
| `pi config` | Enable/disable extensions, skills, prompts, themes (`Tab` to switch global/project) |
| `pi install npm:@foo/bar@1` | Add package → user settings (`~/.pi/agent/settings.json`) |
| `pi install -l npm:@foo/bar` | Add to project settings (`.pi/settings.json`) |
| `pi install git:github.com/user/repo@v1` | Add git package (pinned ref) |
| `pi install ./local/path` | Add local package/extension |
| `pi -e ./ext.ts` | Load a local extension for one run (no install) |
| `pi remove npm:@foo/bar` | Remove package |
| `pi list` | Show packages from settings |
| `pi update`, `pi update --all`, `pi update --extensions`, `pi update --models` | Update pi / packages+git refs / model catalogs |
| `/settings` | Interactive settings: `enableSkillCommands`, `defaultProjectTrust`, compaction, retry, etc. |
| `/login <provider>`, `/logout` | Store/clear API key or OAuth token |
| `/model` | Pick model (re-reads `models.json` on open) |
| `/trust` | Save project trust decision to `trust.json` |
| `/reload` | Reload extensions, skills, prompts, themes, context files |
| `pi --list-models` | List available models (incl. registered providers) |
| `PI_SKIP_VERSION_CHECK=1`, `--offline`/`PI_OFFLINE=1` | Disable version check / all startup network |

## Decision: How to Add a Custom Model or Provider

```dot
digraph how-to-add-model {
    "Need a custom\nmodel or provider?" [shape=diamond];
    "Standard OpenAI-compatible API?\n(Ollama, vLLM, LM Studio, SGLang)" [shape=diamond];
    "Needs custom streaming\nor OAuth/SSO?" [shape=diamond];
    "Only overriding a built-in\nprovider's endpoint?" [shape=diamond];
    "models.json" [shape=box];
    "registerProvider()\nvia extension" [shape=box];
    "models.json provider\noverride" [shape=box];

    "Need a custom\nmodel or provider?" -> "Standard OpenAI-compatible API?\n(Ollama, vLLM, LM Studio, SGLang)";
    "Standard OpenAI-compatible API?\n(Ollama, vLLM, LM Studio, SGLang)" -> "models.json" [label="yes"];
    "Standard OpenAI-compatible API?\n(Ollama, vLLM, LM Studio, SGLang)" -> "Needs custom streaming\nor OAuth/SSO?" [label="no"];
    "Needs custom streaming\nor OAuth/SSO?" -> "registerProvider()\nvia extension" [label="yes"];
    "Needs custom streaming\nor OAuth/SSO?" -> "Only overriding a built-in\nprovider's endpoint?" [label="no"];
    "Only overriding a built-in\nprovider's endpoint?" -> "models.json provider\noverride" [label="yes"];
    "Only overriding a built-in\nprovider's endpoint?" -> "models.json" [label="no"];
}
```

- **models.json** (`~/.pi/agent/models.json`): declarative providers + models — `api` (`openai-completions`/`openai-responses`/`anthropic-messages`/`google-generative-ai`), `apiKey`/headers with env resolution, `compat`, `thinkingLevelMap`. Re-merges built-ins: custom `id` *replaces* a built-in of the same id, new `id` is *added*. `modelOverrides` tweak built-ins without redefining the list.
- **Extension** (`pi.registerProvider()`): imperative — use `createProvider()` for custom auth/streaming/OAuth; legacy name-only form to override `baseUrl`/`headers` of a built-in provider while keeping its models/auth. Registered providers are live during startup and visible to `pi --list-models`.

## Writing & Iterating an Extension

Extensions are TypeScript loaded via jiti (no compile). Factory may be sync or async (async runs before startup, so dynamic `registerProvider`/`registerTool` land before `session_start`). **Do not start background resources in the factory** — defer to `session_start` and clean up in `session_shutdown` (the factory may run without a session).

Workflow:
1. Sketch in `pi -e ./ext.ts` for a throwaway run (no install).
2. For iteration: place under `~/.pi/agent/extensions/` (or `.pi/extensions/` after trust) and hit `/reload` — hot-reloads with no restart.
3. For deps: add a `package.json` beside the extension, `npm install`, and list runtime deps in `dependencies` (NOT `devDependencies`, which production installs omit). Bundle other pi packages via `bundledDependencies`; list core APIs (`@earendil-works/pi-*`, `typebox`) in `peerDependencies` with `*`.

### Minimal extension (tools + event hooks)

Based on the official `hello.ts` + `confirm-destructive.ts` examples:

```typescript
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Hook events (tool_call can block before execution)
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName === "bash" && event.input.command?.includes("rm -rf")) {
      const ok = await ctx.ui.confirm("Dangerous!", "Allow rm -rf?");
      if (!ok) return { block: true, reason: "Blocked by user" };
    }
  });

  // Custom tool (registered; appears in prompt; refresh is immediate)
  pi.registerTool({
    name: "greet",
    label: "Greet",
    description: "Greet someone by name",
    parameters: Type.Object({ name: Type.String({ description: "Name" }) }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: `Hello, ${params.name}!` }], details: {} };
    },
  });

  // Command (/greet)
  pi.registerCommand("greet", {
    description: "Say hello",
    handler: async (args, ctx) => ctx.ui.notify(`Hello ${args || "world"}!`, "info"),
  });
}
```

### Custom provider via extension (override endpoint)

Based on `custom-provider.md`:

```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
export default function (pi: ExtensionAPI) {
  // Redirect a built-in provider; existing models + auth are preserved
  pi.registerProvider("anthropic", { baseUrl: "https://proxy.example.com" });
  // Add custom headers to an existing provider
  pi.registerProvider("openai", { headers: { "X-Custom-Header": "value" } });
}
// For a brand-new provider with custom streaming/OAuth, use createProvider() +
// registerProvider("id", { streamSimple, oauth, models }). See custom-provider.md.
```

## Auth & Trust

- **Key resolution order:** `cli --api-key` → `auth.json` → env var → `models.json` provider key. Auth-file credentials take priority over environment variables.
- **Value syntax** (shared by `models.json` `apiKey`/`headers`, `auth.json` `key`, provider `headers`):
  - `!command` — runs the whole value as a shell command. **models.json**: resolved per request, no TTL/cache — wrap slow/rate-limited commands in your own script. **auth.json**: cached for the process lifetime.
  - `$ENV` / `${ENV}` — environment interpolation (`${FOO}_BAR` when `BAR` is literal). Missing var ⇒ unresolved.
  - `$$` / `$!` — literal `$`/`!` (prevents command/exec).
  - **Literal** — a plain uppercase `MY_API_KEY` is a *literal string*, NOT the env var. Use `$MY_API_KEY` for the env var.
- **Trust:** `~/.pi/agent/trust.json` holds saved decisions. `defaultProjectTrust` (`ask`/`always`/`never`) is the fallback when no decision applies and no extension decides. Non-interactive modes (`--mode json`, `--mode rpc`, `-p`) use `defaultProjectTrust`; `--approve`/`--no-approve` override per run. `/trust` saves to `trust.json` but does **not** reload — restart for effect. Project-local `.pi` resources load only after trust.

## Common Mistakes

- **Hardcoding `.pi` in extensions** → use `CONFIG_DIR_NAME`; rebranded distributions use a different config dir.
- **Starting background resources in the factory** → defer to `session_start`/`session_shutdown`; the factory may run without a session.
- **`devDependencies` for runtime deps** → production installs omit them; runtime deps go in `dependencies`.
- **Shell commands in `models.json` expecting caching/TTL** → none is applied; wrap slow commands in your own caching script.
- **`models.json` vs extension providers mixed up** → `models.json` is declarative (standard APIs); extensions are for custom streaming/OAuth. They coexist; custom `id` upserts by id.
- **Forgetting extensions run with full system permissions** → only install from trusted sources; review before installing.
- **`MY_API_KEY` treated as an env var** → it's a literal; use `$MY_API_KEY`.
- **`auth.json` not 0600** → it's created `0600`; if you edit by hand, preserve permissions.

## Verification

1. Extension: `pi -e ./ext.ts` (throwaway) or place under `~/.pi/agent/extensions/` then `/reload`; watch the TUI for load errors.
2. Models/provider: open `/model` or `pi --list-models` to confirm registration.
3. Packages: `pi list` to confirm; `pi config` to enable/disable.
4. Auth/trust: confirm `~/.pi/agent/auth.json` (0600) and `trust.json` were written; remember `/trust` needs a restart.

## Deeper Reference (load on demand)

The authoritative, complete reference is pi's bundled docs (the source for pi.dev/docs). The agent can read these via the `read` tool from the package docs dir:

```
/home/pirackr/.npm/_npx/99fca8174466655b/node_modules/@earendil-works/pi-coding-agent/docs/
```

Canonical web URLs (portable):

- [extensions](https://pi.dev/docs/latest/extensions) — full ExtensionContext, events, custom tools, custom UI
- [settings](https://pi.dev/docs/latest/settings) — all settings reference + project trust
- [models](https://pi.dev/docs/latest/models) — `models.json` + `compat` flags + `thinkingLevelMap`
- [packages](https://pi.dev/docs/latest/packages) — install/remove/update, structure, filtering, scope/dedup
- [custom-provider](https://pi.dev/docs/latest/custom-provider) — `registerProvider`, OAuth, custom streaming, overflow normalization
- [providers](https://pi.dev/docs/latest/providers) — subscriptions, API-key/env map, auth file, cloud providers
- [skills](https://pi.dev/docs/latest/skills) — skill locations, structure, naming, validation
- [prompt-templates](https://pi.dev/docs/latest/prompt-templates) — template syntax, arguments, loading rules
- [keybindings](https://pi.dev/docs/latest/keybindings) — keymap reference

Working examples (in the package `examples/extensions/`): `hello.ts` (minimal tool), `confirm-destructive.ts` (session cancel hooks), `dynamic-tools.ts` (runtime tool registration), `custom-provider-anthropic/` & `custom-provider-gitlab-duo/` (custom streaming/OAuth), `reload-runtime.ts` (trigger `/reload` from a tool).
