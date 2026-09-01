# Pi Extensions

A Pi package of production extensions, skills, and a planning prompt. It adds
subagent orchestration, web research, autonomous research loops, adaptive
compaction, completion notifications, and OpenCode Zen models.

> Extensions execute with your user permissions. Review this package and only
> install sources you trust.

## Install

```sh
# Install globally (default): ~/.pi/agent/settings.json
pi install /absolute/path/to/pi-extensions

# Install for one trusted project: .pi/settings.json
cd /path/to/project
pi install -l /absolute/path/to/pi-extensions

# Try a single extension without installing the package
pi -e /absolute/path/to/pi-extensions/extensions/web-search/index.ts
```

Pi auto-discovers `extensions/`, `skills/`, and `prompts/`. After changing a
local installation, run `/reload` in Pi. Git and npm package installs resolve
runtime dependencies automatically; for repository development, install them
with `npm install`.

## Included resources

| Resource | What it provides |
| --- | --- |
| `extensions/subagent` | Durable, tmux-backed Pi subagents with scheduling, profiles, and a TUI status widget. |
| `extensions/web-search` | `web_lookup` and `fetch_web` tools with direct-provider routing, validation, retries, and shared rate limits. |
| `extensions/loop` (with research modules) | `/loop` for general autonomous programs and `/research` for retained, evidence-driven research runs. |
| `extensions/auto-compact` | Per-model context thresholds and a `/auto-compact` status command. |
| `extensions/ntfy` | Opt-in session completion notifications via `/ntfy`. |
| `extensions/opencode-zen` | OpenCode Zen model providers, including anonymous free-tier discovery. |
| `skills/` | `customize-pi`, `grill-me`, `handoff`, `org2pdf`, `research`, `subagent`, and `web-search`. |
| `prompts/plan.md` | The `/plan` implementation-planning prompt. |

## Subagents

The subagent extension registers three model-callable tools:

- `Agent` — queue one independently scoped subagent. Background execution is
  the default and returns a durable four-character receipt ID.
- `get_subagent_result` — inspect a run or retrieve and consume its terminal
  result; pass `wait: true` to wait for completion.
- `stop_subagent` — cancel queued work or request cancellation of a running
  agent.

Use `/agents` to inspect and control durable agents in the TUI. Agents run in
tmux, so `tmux` and Node.js must be on `PATH`. Subagents with shell or write
access must use separate worktrees when they run concurrently.

The bundled default profile is `general-purpose` at
`extensions/subagent/subagents/general-purpose.md`. Configuration is layered
from packaged defaults, user settings, and (for trusted projects) project
settings:

| Layer | Configuration | Profiles |
| --- | --- | --- |
| Packaged | `config/subagent.json` | `extensions/subagent/subagents/*.md` |
| User | `$PI_AGENT_DIR/subagent/config.json` | `$PI_AGENT_DIR/subagent/agents/*.md` |
| Trusted project | `<project>/.pi/subagent/config.json` | project-provided profile directories |

`$PI_AGENT_DIR` is normally `~/.pi/agent`. The project layer has highest
precedence; models are merged and additional `agentDirs` are combined. Run
`/reload` after changing configuration or profiles.

## Web search

`web_lookup` searches the web and `fetch_web` extracts a public page. The
default search chain is **TinyFish → Exa → DuckDuckGo**; the first engine that
returns results wins. Tavily is available only when explicitly requested.
TinyFish, Exa, and Tavily use `TINYFISH_API_KEY`, `EXA_API_KEY`, and
`TAVILY_API_KEY`, respectively; DuckDuckGo needs no key.

- `web_lookup({ query, limit, engine, advancedOptions })`
- `fetch_web({ url, max_chars, advancedOptions })`

API keys resolve from the environment or the repository-root `.env` file and
are never accepted as tool inputs. Search limits and retries are coordinated
across Pi and subagent processes in `$PI_AGENT_DIR/cache/web-search/`.

Configuration is supplied by `config/web-search.json`; users can override it
with `$PI_AGENT_DIR/web-search.json`. Provider-specific advanced options are
strictly validated. See [docs/web-search-provider-options.md](docs/web-search-provider-options.md)
for the complete option reference.

## Autonomous loops and research

`/loop` runs a mission against a program file until its completion condition,
round limit, token budget, or no-progress limit is reached:

```text
/loop [--program <path>] [--max-rounds N] [--tokens N] [--no-progress N|off] <mission>
```

Use `/loop status`, `/loop pause`, `/loop resume`, or `/loop clear` to manage
the active loop. `complete_loop` is available to the model only for marking a
run complete after the program's completion condition is actually satisfied.

`/research` applies the bundled research program, uses the subagent and web
search integrations, and creates a retained workspace under the project
root's `.research/` directory:

```text
/research --profile standard "Compare N100 and Ryzen 7 7730U for a homelab"
```

Research profiles are `quick`, `standard`, `intermediate`, `deep`, and
`open-ended`; they set source, round, and dispatch limits in
`config/research.json`. A research workspace stores its immutable manifest,
mutable state, sources and notes, intermediate reports, verification evidence,
and final cited `report.org`. Use `/research list`, `status`, `pause`,
`resume`, or `clear` to operate on retained workspaces.

Research never resumes automatically after a session restart. Resume it only
with the explicit `/research resume` command. The `research_checkpoint` tool
is exposed only during an active user-started research run.

## Auto-compaction and notifications

### Auto-compaction

The auto-compaction extension evaluates context use after a run settles and
applies the first matching per-model policy. Policies may use a percentage of
the model context window or an absolute token threshold. Manual `/compact` and
overflow recovery are never blocked.

Configuration precedence is packaged `config/auto-compact.json`, then
`$PI_AGENT_DIR/auto-compact/config.json`, then trusted-project
`.pi/auto-compact.json`. Run `/auto-compact` to inspect the active policy,
threshold, source layer, warnings, and controller state.

### ntfy

The ntfy extension sends `Task finished` only after you enable it for the
current session:

```text
/ntfy          # show status
/ntfy on       # enable completion notifications
/ntfy off      # disable them
/ntfy test     # send a test notification
```

Configure a topic in `$PI_AGENT_DIR/ntfy/config.json` (normally
`~/.pi/agent/ntfy/config.json`):

```json
{
  "server": "https://ntfy.sh",
  "topic": "your-private-topic",
  "token": "optional-access-token"
}
```

`NTFY_SERVER`, `NTFY_TOPIC`, and `NTFY_TOKEN` override that file. No
project-local ntfy configuration is read.

## OpenCode Zen provider

The OpenCode Zen extension registers `opencode-zen` for chat-completions
models and `opencode-zen-responses` for models requiring the OpenAI Responses
API. It refreshes the visible model list from the Zen gateway and models.dev;
deprecated models are excluded.

Credentials resolve in this order: `OPENCODE_API_KEY`, the `opencode-zen`
entry in Pi's `auth.json`, then the anonymous `public` credential. Anonymous
mode exposes only currently free models and is rate-limited. The Zen catalog
can change without notice.

## Develop and verify

```sh
npm install
npm test

# Register this checkout in the current project's Pi settings.
pi install -l /absolute/path/to/pi-extensions
# Then use /reload in Pi after editing a resource.
```

TypeScript is loaded directly by Pi through jiti; there is no build step.
Tests use Vitest and live under `tests/`.

## Repository layout

```text
config/       Packaged defaults for extensions
extensions/   Pi extension entry points and implementation
skills/       Auto-discovered SKILL.md guidance
prompts/      Auto-discovered prompt templates
docs/         Design notes and provider-option reference
tests/        Vitest unit, integration, and smoke tests
types/        Local TypeScript declarations
```

For Pi package installation, resource filtering, and security details, see the
[Pi package documentation](https://pi.dev/docs/latest/packages).
