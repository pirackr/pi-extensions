---
name: deep-research
description: Subagent-driven deep research with code-enforced floors. Use for research tasks requiring multi-source verification, contradiction analysis, and structured reports.
disable-model-invocation: true
---

# Deep Research

The `/research` command runs the bundled research program (program.md) as an
autonomous loop. See the full spec:
`docs/006-deep-research-spec.md`

## Quick Start

```

/research --profile standard "Compare N100 vs Ryzen 7 7730U for a 4-node homelab"

```

Profiles: `quick` (10 rounds, 15 sources, self-judge) | `standard` (6 rounds, 20 sources, self-judge) | `intermediate` (8 rounds, 30 sources, judge subagent) | `deep` (10 rounds, 40 sources, full subagent verification)

## Available Subagent Profiles

| Profile | Tools | Access | Use Case |
| --------- | ------- | -------- | ---------- |
| scout_research | read, grep, find, ls, web_lookup, fetch_web | read | Broad search + credibility assessment |
| fetcher | read, bash, web_lookup, fetch_web | read | Deep URL reads, content extraction |
| judge | all tools | write | Report evaluation against rubric |
| citation_agent | read, grep, find, ls, web_lookup, fetch_web | read | Claim-to-source mapping |
| source_auditor | read, grep, find, ls, web_lookup, fetch_web | read | Source credibility ratings |
| contradiction_resolver | read, grep, find, ls, web_lookup, fetch_web | read | Investigate and resolve contradictions |

## Research Artifacts

`/research` creates a per-run scratch workspace at
`/tmp/<project-folder>/research/<research-id>-<research-slug>/` — project-folder
= session cwd basename, research-id = local timestamp, research-slug = mission.
All artifacts are written there, never in the repo:

| File | Purpose |
| ------ | --------- |
| `score.md` | Sub-question scores (0-100) and notes |
| `notes.md` | Claim → source → confidence log |
| `report.org` | Final org-mode report |
| `docs/006-deep-research-spec.md` | Full spec with profiles and architecture |
