# Pi Extensions

Pi extensions and skills workspace. Uses [convention directories](https://pi.dev/docs/latest/packages) for auto-discovery.

## Structure

```
pi-extensions/
├── config/
│   └── tmux-subagent.json   # Bundled model and runtime defaults
├── package.json
├── README.md
├── extensions/              # Pi auto-discovers *.ts and */index.ts here
│   ├── tmux-subagent/       # Tmux-backed Pi subprocess supervisor
│   └── web-search/
│       └── index.ts         # Extension — registers pi tools
├── skills/                  # Pi auto-discovers SKILL.md directories here
│   ├── subagent/            # Delegation policy for run_subagents
│   └── web-search/
│       └── SKILL.md         # Skill — agent guidance
└── subagents/               # Bundled declarative agent profiles
```

## Install

```bash
# Project-local (adds to .pi/settings.json)
cd your-project
pi install -l ../pi-extensions

# Or global (adds to ~/.pi/agent/settings.json)
pi install ~/Working/grinder/pi-extensions
```

No `npm install` needed — `pi install` registers the path in settings and auto-discovers resources on the next run or `/reload`.

## Tmux Subagents

The `run_subagents` tool launches one or more independent Pi processes in a private tmux session. Bundled profiles provide `scout`, `worker`, `reviewer`, and `tester`; profile files control prompts, models, tools, access, and timeouts without changing the supervisor.

Requirements:

- `tmux` and Node.js available on `PATH`
- Provider extensions and models referenced by the active configuration

Use one task for a single agent or multiple non-overlapping tasks for parallel work. Agents with shell or write access must not share a Git worktree. During a run, attach using the session command reported by the tool.

Bundled defaults live in `config/tmux-subagent.json` and `subagents/*.md`. Override them without modifying the package:

- User configuration: `$PI_AGENT_DIR/tmux-subagent/config.json` (normally `~/.pi/agent/tmux-subagent/config.json`)
- User profiles: `$PI_AGENT_DIR/tmux-subagent/agents/*.md` (normally `~/.pi/agent/tmux-subagent/agents/*.md`)
- Additional profile directories: `agentDirs` in user configuration

Configuration values override bundled values. User profiles override bundled profiles with the same `name`. Run `/reload` after changing configuration or profiles.

Example configuration:

```json
{
  "models": {
    "fast": "provider/fast-model-id",
    "strong": "provider/strong-model-id"
  },
  "childExtensions": [],
  "toolAccess": {},
  "agentDirs": [],
  "loadContextFiles": true,
  "maxTasks": 4,
  "defaultTimeoutSeconds": 300,
  "retainArtifacts": "on_failure"
}
```

`$PI_AGENT_DIR` resolves through Pi's active agent directory, including `PI_CODING_AGENT_DIR` overrides. Setting `childExtensions` in user configuration replaces the bundled list. Register extension-provided tools in `toolAccess` with their minimum `read`, `shell`, or `write` capability before using them in a profile.

Example profile:

```markdown
---
name: scout
description: Bounded codebase reconnaissance
model: fast
thinking: high
tools: read,grep,find,ls
access: read
timeoutSeconds: 180
---

System prompt for the agent.
```

`model` resolves through the configured `models` aliases and may also be a literal model identifier. `thinking` optionally fixes the Pi reasoning level instead of inheriting ambient settings. Valid access levels are `read`, `shell`, and `write`; profiles cannot declare less access than their tools require. Access controls worktree scheduling, not OS sandboxing: a `bash`-enabled profile can modify files even when its prompt says not to. Child skills and ambient extensions are disabled; `loadContextFiles` controls whether repository `AGENTS.md` and `CLAUDE.md` instructions remain available. Because project-controlled profiles can grant shell access, project profile discovery is intentionally not automatic.

## Auto-Compact

The auto-compaction extension automatically compacts a session when context usage reaches a configurable per-model threshold. Thresholds may be expressed as a percentage of the active model's context window or as an absolute token count, and may be customized with ordered `provider/model-id` glob rules. The extension works both earlier and later than Pi's built-in compaction threshold while preserving manual `/compact`, Pi's overflow recovery, Pi's normal summary generation, and Pi's existing `keepRecentTokens` behavior.

The extension operates without model-context messages or interactive prompts. In UI-capable modes it reports automatic compaction start, completion, and failure through notifications.

### Configuration

Configuration is layered from three sources, ordered lowest → highest precedence:

1. **Packaged defaults**: `config/auto-compact.json` in the extension package. Invalid packaged configuration is fatal (package defect).
2. **User configuration**: `$PI_AGENT_DIR/auto-compact/config.json` (normally `~/.pi/agent/auto-compact/config.json`). Invalid user configuration is ignored atomically while lower valid layers remain active.
3. **Project configuration**: `<cwd>/${CONFIG_DIR_NAME}/auto-compact.json` (loaded only when `ctx.isProjectTrusted()` is true; the implementation uses Pi's exported `CONFIG_DIR_NAME` rather than hardcoding `.pi`). Invalid project configuration is ignored atomically. An untrusted project is reported as inactive by `/auto-compact`.

Configuration values override bundled defaults. Invalid optional layers degrade safely with visible diagnostics (logged as `Ignored:` and `Warning:` lines in `/auto-compact` output).

### Schema

The packaged default:

```json
{
  "enabled": true,
  "default": { "percent": 80 },
  "rules": []
}
```

A user or project file may be partial:

```json
{
  "default": { "percent": 80 },
  "rules": [
    {
      "match": "anthropic/claude-*",
      "percent": 75
    },
    {
      "match": "openai/gpt-5.4",
      "tokens": 180000
    },
    {
      "match": "google/gemini-*",
      "enabled": false
    }
  ]
}
```

Top-level fields:

- `enabled`: optional boolean. The highest-precedence layer that specifies `enabled` wins.
- `default`: optional threshold object containing exactly one of `percent` or `tokens`.
- `rules`: optional ordered array of complete model rules.

Rule fields:

- `match`: required non-empty glob matched against the case-sensitive canonical key `provider/model-id` (e.g. `anthropic/claude-sonnet-4-20250514`). Uses `minimatch` semantics — case-sensitive, no basename matching.
- `enabled`: optional boolean, defaulting to `true`.
- `percent`: context-usage percentage greater than `0` and at most `100`.
- `tokens`: positive integer context-usage threshold in tokens.

An enabled rule must contain exactly one of `percent` or `tokens`. A disabled rule must contain neither. Unknown fields are rejected.

### Precedence and First-Match

- Layers are retained rather than deep-merged: rules arrays are not combined across layers.
- Global extension enablement is determined by the highest-precedence layer that specifies `enabled`.
- Resolution searches project rules first, then user rules, then packaged rules — the first matching rule wins and is used atomically (no field-merging with lower layers).
- If no rule matches, the highest-precedence specified `default` threshold is used.
- Percentage thresholds are floored: `effectiveThresholdTokens = floor(contextWindow * percent / 100)`.
- An absolute token threshold larger than the model's context window is not silently clamped; `/auto-compact` reports a warning instead.

### Disabled Rules

- A rule with `enabled: false` cancels auto-compaction for that model — Pi's threshold compaction is blocked for the matched model.
- A global `enabled: false` (in any layer) leaves Pi's built-in compaction behavior entirely untouched; the extension is inert.

### Manual Compaction and Overflow Recovery

Manual `/compact` invocations and Pi's overflow recovery are never blocked by this extension. Pi continues to own summary generation, cut-point selection, file tracking, and `keepRecentTokens`.

### Behavior

The extension triggers its own compaction **after a run fully settles** (the `agent_settled` point, once per prompt run), never from `turn_end` — `turn_end` fires *inside* an active agent run, and compaction's internal abort would kill the live run. A resumed session that already exceeds its threshold compacts immediately at startup. A short cooldown plus the in-flight dedup prevents double compaction when Pi's native auto-compaction wins the race.

When the custom threshold is *later* than Pi's built-in threshold (`contextWindow − reserveTokens`), Pi's native compaction keeps firing at its own threshold in the band between the two, and the extension cancels those attempts as premature — you will see an `Auto-compaction cancelled` status until usage reaches the custom threshold, at which point Pi's compaction is allowed through. If that band is noisy, align the thresholds: lower the extension's `percent`/`tokens`, or raise Pi's `compaction.reserveTokens` in `settings.json` so both fire at the same point.

### Reloading Configuration

Configuration changes take effect through Pi's normal `/reload` flow. The extension re-reads configuration from all layers on each session start and model change.

### Status Command

`/auto-compact` (takes no arguments) reports:

- whether the extension is globally enabled or disabled;
- the active `provider/model-id` and context window;
- current token and percentage usage, when known;
- the matched rule pattern, its source layer, and the effective token threshold (or `disabled`);
- controller state: armed (awaiting threshold), in-flight (compaction triggered), or disarmed;
- loaded configuration paths;
- ignored configuration paths and the reason (e.g. "project not trusted", "invalid configuration");
- configuration warnings; and
- the most recent compaction error, if any.

The status command is UI-guarded: when UI is available the report is emitted through Pi's extension UI; it does not use `pi.sendMessage()` and therefore does not consume model context.

When no model or usage is available, the report explicitly marks those values as unavailable rather than guessing.

## Add a New Extension

```bash
# 1. Create extension code
mkdir extensions/my-ext
cat > extensions/my-ext/index.ts << 'EOF'
import { Type } from "typebox";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "my_tool",
    label: "My Tool",
    description: "Does something useful",
    parameters: Type.Object({ input: Type.String() }),
    async execute(_id, params) {
      return { content: [{ type: "text", text: params.input }] };
    },
  });
}
EOF

# 2. Create skill guidance
mkdir skills/my-ext
cat > skills/my-ext/SKILL.md << 'EOF'
---
name: my-ext
description: Does something useful. Use when...
---

# My Ext

Usage instructions here.
EOF

# 3. Reload in pi
/reload
```

Done — pi auto-discovers both the extension and skill.
