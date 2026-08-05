# Deep Research Program

> Human-edited contract for a `/research` run (driven by the shared `/loop`
> engine). The loop re-reads this file at the start of every round, so edits
> apply from the next round on — steer the run live. The mission argument
> passed to `/research` overrides the placeholder below (or start the same
> run via `/loop --program <this file> ...`).

## Mission

<injected by /research — do not edit>

## Deliverable

Write `research/report.md` — a structured markdown report with claim-level citations.

## Protocol

### Round 0 — Plan

1. Restate the mission as 5–8 concrete sub-questions in `research/score.md`.
   For each: the question, what evidence would answer it, who would know.
2. START WIDE — first-round queries must be broad. Narrow after round 1
   (the default failure is over-specific queries that return nothing).

### Every round

1. Read `research/score.md` and `research/notes.md` first. Never redo done work.
2. Attack the 1–3 weakest sub-questions (lowest scores).
3. Fire 2–4 parallel `lookup_web` queries (distinct phrasings; quoted exact
   terms; `site:`/`filetype:` filters when useful).
4. Deep-read the 2–3 most authoritative hits with `fetch_web_content`
   (readability=1). Prefer primary sources, official docs, papers. Distrust
   SEO content farms and generic listicles.
5. Append to `research/notes.md`: claim → source URL → confidence (0–100).
6. Triangulate: every key claim needs 2+ independent sources spanning
   credibility tiers (official / independent analysis / community).
7. Update `research/score.md` (0–100 per sub-question + notes column).
8. Record unresolved contradictions in the notes column — never paper over them.
9. If a `research_checkpoint` tool is available, call it and obey its verdict.
   Otherwise self-audit against the Completion condition below.

## Completion condition

All three, then write the report and call `complete_loop` (status=complete):

- every sub-question scored ≥ 80
- ≥ 8 unique sources cited
- no unresolved contradiction on a scored question

If the loop hits its round/token caps first, still write `research/report.md`
with the best evidence gathered, and list every gap in Uncertainties & Gaps.

## Report template (`research/report.md`)

- Executive summary (≤5 bullets)
- Findings per sub-question; every claim tagged [n] → sources table
- Comparison table + narrative where the mission implies alternatives
- Contradictions & debates
- **Uncertainties & Gaps** (required — anything scored < 80, capped rounds,
  unverifiable claims)
- Sources: URL · title · credibility tier · retrieval date

## Safety

- Never fetch localhost/private IPs or credentialed URLs.
- Stay inside the research working directory.
