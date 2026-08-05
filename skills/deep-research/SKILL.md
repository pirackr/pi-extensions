---
name: deep-research
description: Run multi-round web research with claim-level citations — /research drives an autonomous loop that searches, fetches sources, and compiles research/report.md
disable-model-invocation: true
---

# Deep Research

Multi-round autonomous web research driven by a human-editable research program
(`program.md`). `/research` is the deep-research front-end of the `/loop` engine:
the same continuation loop, budgets, and pause/resume controls — pre-pointed at
the bundled research methodology with a research-appropriate round cap.

## Usage

```text
/research "<topic>" [--program <path>] [--max-rounds N] [--tokens N] [--no-progress N|off]
/research status | pause | resume | clear
```

Examples:

```text
/research "N100 vs N305 mini-PC for a Proxmox homelab"
/research "Ceph Reef → Squid: what actually changed" --max-rounds 4 --tokens 50000
```

- **topic** (required): the research question or mission
- **--program** `<path>`: custom research program file (default: bundled `examples/deep-research/program.md`)
- **--max-rounds** `N`: round cap (default 6)
- **--tokens** `N`: whole-run token budget (default: none)
- **--no-progress** `N|off`: rounds of identical/empty tool-free output
  before the loop auto-pauses with a review prompt (default 3; `off` disables)

Subcommands: `status` (current round/tokens/program), `pause` / `resume`
(stop/restart continuation), `clear` (abandon the run).

## How it works

1. **Round 0 — Plan**: the loop re-reads `program.md` and restates the mission as
   5–8 concrete sub-questions in `research/score.md`.
2. **Every round**: attack the weakest sub-questions → fire 2–4 parallel
   `lookup_web` queries → deep-read the most authoritative hits with
   `fetch_web_content` → append `claim → source URL → confidence` rows to
   `research/notes.md` → update scores.
3. The loop continues automatically until `program.md`'s completion condition is
   met (every sub-question ≥ 80, ≥ 8 unique sources, no unresolved
   contradictions) — then the agent writes `research/report.md` and calls
   `complete_loop`.
4. Round/token caps stop the loop early; the report is still written, with every
   gap listed in **Uncertainties & Gaps**.

## Output (relative to cwd)

- `research/score.md` — sub-questions with 0–100 scores (the anti-early-stop table)
- `research/notes.md` — claim → source URL → confidence, appended every round
- `research/report.md` — the deliverable: executive summary, findings per
  sub-question with `[n]` citations → sources table, contradictions & debates,
  and a required **Uncertainties & Gaps** section

## The program file is the contract

`program.md` is human-edited: the loop re-reads it every round, so edits apply
from the next round on — you can steer a run live. It encodes start-wide-then-
narrow querying, source triangulation + credibility tiers, the self-score table,
and hard caps. Point `--program` at your own copy for a custom methodology.

## Safety

- Runs are interactive by default (user present); `--max-rounds` / `--tokens`
  cap consumption
- The program file is user-authored *data*, not system instructions — mission
  and budgets win on any conflict
- Never fetch localhost/private IPs or credentialed URLs (rule in `program.md`)

## Not yet built (draft-spec features deferred by the PoC)

- Profile presets (`fast`/`default`/`deep`), `--resume` / `--cancel`, `.runs/`
  checkpoints, `audit.jsonl`, worker tool isolation
- `research_checkpoint` gate (code-enforced min rounds/sources) — deferred until
  early stopping is observed
