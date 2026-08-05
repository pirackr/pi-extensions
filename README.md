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
