---
name: research
description: Subagent-driven deep research with code-enforced floors. Use for research tasks requiring multi-source verification, contradiction analysis, and structured reports.
disable-model-invocation: true
---

# Research

The `/research` command runs the canonical research program (`program.md`, in
this folder) as an autonomous loop. Configuration lives in
`config/research.json` — profiles, role dispatch limits, the verification
suite, and per-agent web-search and fetch limits. The program is methodology;
the configuration owns the runtime parameters.

## Quick Start

```

/research --profile standard "Compare N100 vs Ryzen 7 7730U for a 4-node homelab"

```

Profiles, thresholds, and verification suites are defined in
`config/research.json` — the program never embeds them. See the full
architecture spec: `docs/006-deep-research-spec.md`.

## Program and Configuration

- `skills/research/program.md` — the canonical methodology contract: the
  nine research steps, role boundaries, dispatch examples, robustness rules,
  and completion gates. Editable mid-run; the loop re-injects it when it
  changes (mtime).
- `config/research.json` — runtime parameters: profile round/source targets,
  role dispatch limits, verification suite, per-agent web-search and fetch
  limits. The engine applies these as hard constraints.
- `skills/research/agents/*.md` — role prompts (scout, fetcher, consolidator,
  planner, judge, citation agent, source auditor, contradiction resolver,
  fragment writer).

## Research Artifacts

`/research` creates a per-run workspace under `.research/` at the project
root, named `<YYYYMMDD-HHmm>-<mission-slug>` — the timestamp prefix keeps
duplicate missions in distinct, chronologically sortable directories. All
artifacts are written there, never in the repo:

| File | Purpose |
| ------ | --------- |
| `.research/run.json` | Immutable run manifest |
| `.research/run-state.json` | Mutable run state (contract + progress) |
| `score.md` | Sub-question scores (0-100) and notes |
| `notes.md` | Claim → source → confidence log |
| `scout-outputs/` | Immutable scout/fetcher reports |
| `fragments/` | Org fragments written by fragment writers |
| `report.org` | Final org-mode report with claim-level citations |
| `verification/` | Strict JSON verification artifacts |
