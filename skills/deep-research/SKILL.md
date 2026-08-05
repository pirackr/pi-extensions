---
name: deep-research
description: Perform autonomous multi-step web research with structured reports and claim-level citations
disable-model-invocation: true
---

# Deep Research

Perform autonomous multi-step web research and produce structured markdown reports with claim-level citations.

## Usage

```
/research <topic> [--profile <name>] [--max-depth <n>] [--yes]
/research --resume <run-id> [--extend-elapsed <seconds>] [--extend-finalization <seconds>] [--yes]
/research --cancel <run-id>
```

## Commands

### Start New Research

```
/research "AI safety alignment techniques" --profile deep --yes
```

- **topic** (required): Research topic or question
- **--profile** (optional): Budget profile — `fast`, `default`, or `deep`
- **--max-depth** (optional): Maximum research tree depth (1-5)
- **--yes** (required for non-TUI): Skip confirmation prompts

### Resume Research

```
/research --resume run-1690000000-abc123 --yes
```

- **--resume** (required): Run ID from previous session
- **--extend-elapsed** (optional): Additional elapsed time budget in seconds
- **--extend-finalization** (optional): Additional finalization time budget in seconds
- **--yes** (required): Confirm resume

### Cancel Research

```
/research --cancel run-1690000000-abc123
```

- **--cancel** (required): Run ID to cancel

## Profiles

| Profile | Depth | Nodes | Concurrency | Search Calls | Model Calls | Tokens | Time |
|---------|-------|-------|-------------|--------------|-------------|--------|------|
| fast    | 0     | 2     | 2           | 4            | 4           | 8K     | 2m   |
| default | 2     | 24    | 4           | 48           | 36          | 64K    | 10m  |
| deep    | 5     | 100   | 6           | 200          | 150         | 256K   | 30m  |

## How It Works

1. **Prefilter**: Generates a research brief with scope, key questions, and constraints
2. **Research**: Autonomous workers investigate questions, search the web, and fetch sources
3. **Synthesis**: Compiles findings into a structured report with citations
4. **Verification**: Validates that every claim is supported by fetched evidence
5. **Repair**: Removes unsupported claims and adds limitation notices
6. **Judge**: Independently evaluates report quality across factual accuracy, completeness, and source quality

## Output

Reports are saved to:
- `research/<slug>-YYYY-MM-DD-<run-id>.md` — Markdown report
- `research/<slug>-YYYY-MM-DD-<run-id>.jsonl` — Structured data
- `research/.runs/<run-id>/checkpoint.json` — Recovery checkpoint
- `research/.runs/<run-id>/audit.jsonl` — Audit log

## Configuration

Settings cascade (highest precedence first):
1. Command-line flags
2. `PI_RESEARCH_*` environment variables
3. Project `.pi/deep-research.json` (trusted projects only)
4. Global `~/.pi/agent/deep-research.json`
5. Selected profile preset
6. Built-in defaults

## Safety

- Workers only have access to web search and fetch tools — no file system, shell, or code execution
- URLs are validated: no localhost, private IPs, or credentials
- Search queries are screened for high-entropy blobs and sensitive data
- Budget caps prevent runaway consumption
- Checkpoints enable crash recovery
