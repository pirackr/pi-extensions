# Deep Research Program

> Human-edited contract for a `/research` run (driven by the shared `/loop`
> engine). The loop re-reads this file at the start of every round, so edits
> apply from the next round on — steer the run live. The mission argument
> passed to `/research` overrides the placeholder below.

## Mission

<injected by /research — do not edit>

## Depth Profiles

Each profile defines a different research depth. Pick one with `--profile`:

| Profile | Min Rounds | Min Sources | Max Rounds | Subagents | Verification |
|---------|-----------|-------------|------------|-----------|-------------|
| quick | 10 | 15 | 10 | None | Self-judge |
| standard | 6 | 20 | 6 | None | Self-judge |
| intermediate | 8 | 30 | 8 | scout ×5, fetch ×3 | Judge subagent |
| deep | 10 | 40 | 10 | scout ×12, fetch ×5 | Judge + CitationAgent + SourceAuditor + ContradictionResolver |

Default: `standard`. Override max rounds with `--max-rounds N`.

## Profile

<injected by /research — do not edit>

## Deliverable

Write `research/report.org` — an org-mode report with claim-level citations.

## Org-Mode Format

Use org-mode headings and markup:

- `* ` for level-1 headings, `** ` for level-2, `*** ` for level-3
- `**bold**`, `*italic*`, `=code=`
- `[[URL][description]]` for links
- `| col1 | col2 |` for tables
- `[[source:N]]` for claim-level citations
- `[[:date]]` for retrieval dates
- `----` for horizontal rules
- `- ` for bullet lists, `1. ` for numbered lists

### Report structure

```
- Executive Summary

   ≤5 bullet points summarizing key findings.

- Findings

  ** [Sub-question 1 heading]

     Finding text with inline [[URL][citation]] markers.

  ** [Sub-question 2 heading]

     ...

- Comparison Table

   | Topic | Source A | Source B | Consensus |
   |-------|----------|----------|-----------|
   | ...   | ...      | ...      | ...       |

- Contradictions & Debates

  ** [Contradiction topic]

     Source A says X, Source B says Y. Resolution: [resolved/reconciled/unresolved].

- Uncertainties & Gaps

  - [Any claims scored <80, capped rounds, unverifiable claims]

- Sources

   #+BEGIN_EXAMPLE
   [N] URL — title — credibility tier — retrieval date
   ...
   #+END_EXAMPLE

```

## Protocol

### Round 0 — Plan

1. Read the mission (injected by /research).
2. Restate the mission as 5–8 concrete sub-questions in `research/score.md`.
   For each sub-question: the question text, what evidence would answer it,
   who would know, estimated source count needed.
3. START WIDE — first-round queries must be broad. Narrow after round 1.
4. **Call `research_checkpoint`** with profile, round=0, totalSources=0.
   Obey its verdict.

### Every round (quick, standard, intermediate, deep)

1. Read `research/score.md` and `research/notes.md` first. Never redo done work.
2. Attack the 1–3 weakest sub-questions (lowest scores).
3. Fire 2–4 parallel `web_lookup` queries (distinct phrasings; quoted exact
   terms; `site:`/`filetype:` filters when useful).
4. Deep-read the 2–3 most authoritative hits with `fetch_web`.
   Prefer primary sources, official docs, papers.
   Distrust SEO content farms and generic listicles.
5. Append to `research/notes.md`: claim → source URL → confidence (0–100) → credibility (1-5).
6. Triangulate: every key claim needs 2+ independent sources spanning
   credibility tiers (official / independent analysis / community).
7. Update `research/score.md` (0–100 per sub-question + notes column).
8. Record unresolved contradictions in the notes column — never paper over them.
9. **Call `research_checkpoint`** with profile, current round, total unique sources.
   Obey its verdict — do NOT call `complete_loop` unless PROCEED.

### Standard+ subagent dispatch (rounds 1+)

When the program says "dispatch scouts," use `run_subagents`:

```

run_subagents({
  tasks: [
    {
      agent: "scout_research",
      objective: "Research: [specific question, e.g. 'compare TDP and performance of Intel N100 vs AMD Ryzen 7 7730U across 10W and 15W configurations']",
      scope: ["research-homelab-hardware/models.mjs"],
      constraints: ["Use broad queries first. Rate sources 1-5. Note contradictions."],
      acceptance_criteria: ["5+ credible URLs returned with findings", "Contradictions noted"],
      inputs: ["research/score.md", "research/notes.md"],
      expected_output: "Scout report with URLs, credibility ratings, contradictions"
    },
    // ... more scouts, same agent, different objective
  ],
  timeout_seconds: 240,
  retain_artifacts: "on_failure"
})

```

- **Quick/standard:** No subagents. Coordinator does all search/fetch directly.
- **Intermediate:** Dispatch 5 scouts (distinct sub-questions) + 3 fetchers (deep-read URLs). **Note:** `run_subagents` accepts max 4 tasks per call — dispatch in batches of <=4.
- **Deep:** Dispatch 12 scouts + 5 fetchers. **Note:** `run_subagents` accepts max 4 tasks per call — dispatch in batches of <=4. Then dispatch judge subagent.

### Intermediate+ Verification Pass (after all rounds)

After the main research rounds, run a verification pass:

1. **Judge subagent** (intermediate+): Dispatch a `judge` subagent with the draft report.
   ```

   run_subagents({
     tasks: [{
       agent: "judge",
       objective: "Judge the research report against the credibility rubric. Evaluate claim quality, triangulation, contradictions, and completeness.",
       scope: ["research/report.org", "research/notes.md", "research/score.md"],
       inputs: ["docs/006-deep-research-spec.md (Section 5.2 — credibility rubric)"],
       expected_output: "Judge verdict with score, verdict, and required fixes"
     }],
     timeout_seconds: 300,
     retain_artifacts: "on_failure"
   })

   ```
   If judge returns FAIL or CONDITIONAL PASS, fix the reported issues and re-judge.

2. **CitationAgent** (intermediate+): Map every claim to its exact source.
   ```

   run_subagents({
     tasks: [{
       agent: "citation_agent",
       objective: "Verify every claim in the report has a matching source. Flag unsupported or misattributed claims.",
       scope: ["research/report.org", "research/notes.md"],
       expected_output: "Citation report with verified/unsupported/misattributed counts"
     }]
   })

   ```

3. **SourceAuditor** (intermediate+): Rate all sources and flag low-quality ones.
   ```

   run_subagents({
     tasks: [{
       agent: "source_auditor",
       objective: "Audit all sources used in research. Flag sources rated ≤2 that support key claims.",
       scope: ["research/notes.md"],
       expected_output: "Source audit with ratings and required replacements"
     }]
   })

   ```

4. **ContradictionResolver** (deep only): Investigate and resolve contradictions.
   ```

   run_subagents({
     tasks: [{
       agent: "contradiction_resolver",
       objective: "Investigate all contradictions listed in research/notes.md. Resolve, reconcile, or mark as genuinely unresolved.",
       scope: ["research/notes.md", "research/score.md"],
       expected_output: "Contradiction resolution report"
     }]
   })

   ```

### Deep-only: Extra Verification Rounds

Deep profile adds dedicated verification rounds AFTER the main research:

- **Rounds 9-10 (deep):** Verification sweep — run judge, citation, source audit, contradiction resolution in parallel.

## Completion condition

All three, then write `research/report.org` and call `complete_loop` (status=complete):

1. Every sub-question scored ≥ 80 in `research/score.md`
2. Min sources reached (per profile): quick=15, standard=20, intermediate=30, deep=40
3. No unresolved contradiction on a scored question (or it is acknowledged in Uncertainties)

**Hard floor:** `research_checkpoint` must return PROCEED before calling `complete_loop`.

If the loop hits its round/token caps first, still write `research/report.org`
with the best evidence gathered, list every gap in Uncertainties & Gaps,
and call `complete_loop` (status=complete, with a note about caps).

## Safety

- Never fetch localhost/private IPs or credentialed URLs.
- Stay inside the research working directory.
- Do not modify program.md during the run (the /loop engine reads it fresh each round).
