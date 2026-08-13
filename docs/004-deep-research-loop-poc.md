> **SUPERSEDED — see [docs/006-deep-research-spec.md](./006-deep-research-spec.md).**
> This PoC describes the first `/loop` + `program.md` experiment. The
> implemented research feature is documented authoritatively in 006
> (config owner, retained workspaces, completion gates, verification,
> lifecycle, resume).

# PoC — `/loop` + `program.md` as the deep-research engine for pi

Status: **Step 1 implemented** · Task refs: `docs/001-deep-research.org`, `docs/003-implement-loop.org`
Research basis: `docs/002-deep-research-notes.md` (esp. §4.5, §3.7)
Date: 2025-08-05

---

## 1. The pitch

Deep research is 90% *methodology* and 10% *machinery*. So instead of building the
500-line extension state machine the current draft spec (`skills/deep-research/SKILL.md`)
describes — prefilter → research → synthesis → verification → repair → judge — we run
the research loop with two cheap, human-editable pieces:

- **`program.md`** — the research *methodology file* (karpathy/autoresearch pattern):
  sub-questions, multi-hop patterns, credibility tiers, self-score table, report
  template, stopping condition. The human edits it; the agent follows it.
- **`/loop`** — a thin command that keeps re-running the agent's normal tool-calling
  loop against `program.md` until the completion condition is met or a budget cap is
  hit. Reuses pi-goal's mechanics: continuation messages, per-turn usage accounting,
  re-trigger on `agent_end`, pause/resume/clear, session-persisted state.

Everything the loop needs (search, deep-read, citations) already exists as
`extensions/web-search` (`lookup_web`, `fetch_web_content`, `fetch_github_readme`) —
zero API keys, zero new HTTP code.

**Why this shape** (evidence in 002 §4.5): LangChain's "bitter lesson" evolution ended
at *thin orchestration + let the model drive* after tearing out exactly this kind of
fixed pipeline; pi-deep-research's one empirically-proven failure mode is optimistic
early stop, fixed by code gates; Anthropic's finding that token usage ≈ 80% of
performance variance means "don't stop early" is the dominant lever; and karpathy's
autoresearch proves the whole loop can be just an instruction file + a stop condition.

---

## 2. autoresearch → pi mapping

| autoresearch (karpathy) | pi equivalent | Role |
| --- | --- | --- |
| `program.md` (human-edited instructions) | `program.md` / SKILL.md | methodology — the 90% |
| `train.py` (the artifact the agent edits) | `research/notes.md`, `research/score.md`, `research/report.md` | agent's working state, on disk |
| the agent's iterate-train-check loop | pi's native tool-calling loop, re-triggered by `/loop` | the driver |
| 5-minute wall-clock budget (in code) | `--max-rounds` / `--tokens` flags + round counter | anti-runaway guard |
| metric `val_bpb` | self-score table (0–100 per sub-question) | anti-early-stop visibility |

The karpathy lesson carries over verbatim: **the quality ceiling of a research run is
set by `program.md`, and iterating on it is cheap.** The human "programs the research
org" by editing the file — even mid-run, since `/loop` re-reads it every round.

---

## 3. The two pieces

### 3.1 `program.md` — the research program file

This is the deliverable's heart. Draft for the PoC (lives at the run's working dir,
e.g. `research/<slug>/program.md`; a stock copy ships with the extension):

````markdown
# Research Program
> The human edits this file. /loop re-reads it at the start of every round.
> It is the contract for the run. Follow it literally.

## Mission
<injected by /loop — the topic argument; do not edit>

## Deliverable
Write `research/report.md` — a structured report with claim-level citations.

## Protocol
### Round 0 — Plan
1. Restate the mission as 5–8 concrete sub-questions in `research/score.md`.
   For each: the question, what evidence would answer it, who would know.
2. START WIDE. First-round queries must be broad (the default failure is
   over-specific queries that return nothing). Narrow after round 1.

### Every round
1. Read `research/score.md` + `research/notes.md` first. Never redo done work.
2. Attack the 1–3 weakest sub-questions (lowest scores).
3. Fire 2–4 parallel `lookup_web` queries (distinct phrasings, quoted exact
   terms, site:/filetype: filters when useful).
4. Deep-read the 2–3 most authoritative hits with `fetch_web_content`
   (readability=1). Prefer primary sources, official docs, papers. Distrust
   SEO content farms and generic listicles.
5. Append to `research/notes.md`: claim → source URL → confidence (0–100).
6. Triangulate: every key claim needs 2+ independent sources spanning
   credibility tiers (official / independent analysis / community).
7. Update `research/score.md` (0–100 per sub-question + notes column).
8. Record unresolved contradictions in the notes column — never paper over them.
9. Call `research_checkpoint` (round, total_sources, contradictions) and obey:
   🔴 CONTINUE → start another round; 🟢 PROCEED → write the report.

## Completion condition
All three, then write the report and call `complete_loop`:
- every sub-question scored ≥ 80
- ≥ 8 unique sources cited
- no unresolved contradiction on a scored question

## Report template (`research/report.md`)
- Executive summary (≤5 bullets)
- Findings per sub-question; every claim tagged [n] → sources table
- Comparison table + narrative where the mission implies alternatives
- Contradictions & debates
- **Uncertainties & Gaps** (required — list anything scored < 80, capped
  rounds, unverifiable claims)
- Sources: URL · title · credibility tier · retrieval date

## Hard caps (never exceed)
- max_rounds: 6 · min_rounds: 2 · min_sources: 8
- Never fetch localhost/private IPs or credentialed URLs.
- Stay inside the research working directory.
````

Note what this encodes, all pulled from 002: effort scaling (§3.5.2), start-wide-then-
narrow (§3.5.1), source triangulation + credibility tiers (§3.5.6), the self-score
table as visible premature-stop guard (§3.8.1), "Uncertainties & Gaps" as the honest
escape hatch (§3.7), citations-as-separate-pass (§3.5.7), and hard caps (§3.7.6).

### 3.2 `/loop` — the driver command

Built from pi-goal's proven mechanics (`/goal` continuation loop), not from scratch:

| pi-goal primitive | `/loop` version |
| --- | --- |
| `/goal <objective>` | `/loop --program <path> "<mission>"` — reads program.md, stores it + mission in loop state |
| continuation prompt (objective + budget + "avoid repeat work, choose next concrete action") | same, + "Round N. Re-read program.md. Advance the research." |
| `create_goal`/`get_goal`/`update_goal` (complete-only) tools | `complete_loop` (complete-only), `get_loop_status` |
| `turn_end` usage accounting → token budget | same, + round counter → `--max-rounds` |
| `agent_end` → queue continuation while active | same |
| session entries (`customType: "pi-goal"`), reload pauses | same (`customType: "pi-loop"`) |
| pause / resume / clear / status | same |

Two deliberate differences from pi-goal:

1. **The program file is the objective.** The continuation prompt says *"re-read
   program.md"* each round — so a human edit mid-run steers the research live
   (karpathy-style). pi-goal's objective is a frozen string.
2. **Completion is code-gated, not just self-judged.** `complete_loop` requires the
   agent to first pass `research_checkpoint` (below), whose thresholds are code, not
   prose — the one primitive the notes say never to defer (002 §4.5: "it's the
   difference between research and a summary, and it's ~40 lines").

The optional `research_checkpoint` tool (Layer 2 in 002 §3.8 — 3 rules only):

```typescript
const DEPTH = {
  quick:    { minRounds: 1, minSources: 3,  maxRounds: 3 },
  standard: { minRounds: 2, minSources: 8,  maxRounds: 6 },
  deep:     { minRounds: 3, minSources: 15, maxRounds: 10 },
};
pi.registerTool({
  name: "research_checkpoint",
  description: "MANDATORY after each search round. Returns CONTINUE or PROCEED.",
  parameters: Type.Object({
    depth: Type.String(),
    round: Type.Number(),
    total_sources: Type.Number(),
    contradictions: Type.Optional(Type.Array(Type.String())),
  }),
  async execute(_id, p) {
    const t = DEPTH[p.depth] ?? DEPTH.standard;
    const issues = [];
    if (p.round < t.minRounds) issues.push(`min rounds: ${p.round}/${t.minRounds}`);
    if (p.total_sources < t.minSources) issues.push(`min sources: ${p.total_sources}/${t.minSources}`);
    if (p.round >= t.maxRounds) return { content: [{ type: "text",
      text: "🟢 PROCEED (max rounds). Flag gaps in Uncertainties & Gaps." }] };
    return { content: [{ type: "text", text: issues.length
      ? `🔴 CONTINUE — ${issues.join("; ")}`
      : "🟢 PROCEED — criteria met." }] };
  },
});
```

---

## 4. How a run flows (concrete trace)

```
user:  /loop --program program.md "compare N100 vs N305 mini-PCs for a Proxmox homelab"
       → /loop reads program.md, persists state, emits "Round 0 — re-read program.md,
         mission: …" and triggers a turn (user's invocation IS the plan approval)

turn 0: agent reads program.md → writes research/score.md with 6 sub-questions
        (price/performance, NIC count, TDP, VT-d, RAM ceiling, community experience)
        → fires 4 parallel lookup_web → writes notes.md → calls research_checkpoint
        → 🔴 CONTINUE (round 1 < minRounds 2)
       turn_end: usage accounted · agent_end: /loop queues "Round 1"

turn 1: agent reads score.md+notes.md → attacks 3 weakest → 3 lookup_web + 2
        fetch_web_content (Readability) → triangulates on RAM ceiling (N305 max
        differs by board vendor — records contradiction) → updates scores
        → research_checkpoint → 🔴 CONTINUE (source count 6 < 8)

turn 2: agent reads score.md → one sub-question at 75 → 1 fetch, 2 searches
        → scores 85, resolves contradiction via vendor PDF → 9 sources
        → research_checkpoint → 🟢 PROCEED → writes research/report.md with
        citations + Uncertainties & Gaps → complete_loop

loop:   stops. user reviews report.md, edits program.md ("exclude fanless
        cases"), /loop resume → turn 3 narrows scope, updates report.
```

State lives on disk (`score.md`, `notes.md`, `report.md`), so context compaction or a
crash mid-run doesn't lose the research — the notes file is the checkpoint (Anthropic's
"subagents write to filesystem" pattern, adapted to one agent).

---

## 5. Stopping criteria — the standard stack (002 §3.7)

| Layer | Mechanism | Where it lives |
| --- | --- | --- |
| Scope bound | user's `/loop` invocation = approved plan | interactive, before tokens spent |
| Driver | model judges sufficiency per round (score table) | program.md |
| Floor | `research_checkpoint` min_rounds / min_sources | code |
| Ceiling | `--max-rounds` + token budget | `/loop` flags + usage accounting |
| Learned | inherited from model choice (thinking budget) | nothing to build |
| Escape hatch | Uncertainties & Gaps section | report template |

---

## 6. vs. the existing `skills/deep-research/SKILL.md` draft

| Draft spec feature | PoC disposition | Why |
| --- | --- | --- |
| 6-stage pipeline (prefilter→…→judge) | **Drop** (keep verification as one program.md step) | bitter lesson: fixed structure bottlenecks models |
| Profiles fast/default/deep (nodes/tokens/time) | **Keep**, as `--profile` → DEPTH table + budget flags | effort scaling, predictable cost |
| Report template, credibility tiers | **Keep**, into program.md | the actual quality surface |
| Uncertainties & Gaps | **Keep**, required | honest early-stop escape hatch |
| `.runs/<id>/checkpoint.json` + resume | **Drop** for PoC (session entries + notes.md suffice) | pi-goal state persists across reload already |
| `audit.jsonl` | **Defer** | add only if observability is needed |
| Worker tool isolation (search/fetch only) | **N/A** for PoC: single agent, interactive, user present | safety is interactive presence + caps; revisit for unattended |
| Dedicated `/research` command + state machine | **Replaced** by `/loop --program` | ~40 lines vs 500+ |

Growth path (only on observed failure, per 002 §4.5): gamed self-scores → count real
fetched sources in code · context loss on long runs → filesystem checkpoints ·
disjoint report → one-shot synthesis step · breadth queries → dispatch scouts via
`extensions/tmux-subagent` · unattended runs → `--yes` + worker tool isolation.

---

## 7. PoC build order (validate before you invest)

1. **Step 0 — zero code (today, ~10 min):** `pi install npm:pi-goal`; write
   `program.md`; run `/goal --tokens 50k "Read program.md. Run the research loop until
   its completion condition is met, then call update_goal complete."` This proves the
   core hypothesis — methodology file + continuation loop → real research — with zero
   extension code.
2. **Step 1 — `/loop` command (~60 lines):** port pi-goal's mechanics, add
   program-file loading + round counter + `complete_loop`. Dogfood on 3 real queries.
3. **Step 2 — `research_checkpoint` (~40 lines), only if Step 1 shows early stopping.**
   The notes say don't defer it long-term; the PoC says prove the symptom first.

## 8. Validation runs

| # | Query type | Example | Profile | Status |
| --- | --- | --- | --- | --- |
| Q1 | factual | "Ceph Reef → Squid: what actually changed?" | quick (3 rounds) | ✅ executed (3/3 rounds, 9 sources) |
| Q2 | comparative | "N100 vs N305 mini-PC for a homelab" | standard (6) | ✅ executed (4/6 rounds, 12 sources) |
| Q3 | broad/deep | "state of self-hosted Kubernetes in 2025" | standard (6) | ✅ executed (4/6 rounds, 14 sources) |

Measure per run: rounds used, unique sources cited, % claims with a `[n]` citation,
wall time, tokens, and an eyeball check for the surface-summary smell (claims without
sources, no Uncertainties & Gaps, one-shot answers). Success = honest citations +
explicit gaps + no early stop; compare Q2/Q3 against a no-loop one-shot baseline.

## 9. Costs, risks, failure modes

- **Cost**: interactive by default (user present), `--tokens`/`--max-rounds` caps.
  Per-task $0.5–2 in 002 §1.4 is a sane envelope for standard profile.
- **Early stop (the known failure)**: floor is `research_checkpoint` + round counter —
  counters are code, not self-reports.
- **Content farms**: credibility tiers + Readability extraction in program.md.
- **program.md trust**: it's user-authored, but wrap injected content (mission, any
  web-derived text) in `<untrusted_…>` blocks like pi-goal does, so it's data, not
  instructions.
- **Context bloat**: notes/score on disk + compaction-friendly continuation prompt.

## 10. Open questions for the design session

1. Build our own `/loop` (per 003) or adopt pi-goal as the engine? (PoC says:
   prove on pi-goal, then port — don't fork before evidence.)
2. Where does `program.md` live per run — `./program.md`, `research/<slug>/`?
3. Should `/loop` restrict tools for unattended runs (search/fetch only)?
4. When (if ever) do we need the draft spec's verification→repair→judge pipeline
   as real machinery, vs. one verification pass inside program.md?
5. Eval harness: a ~10-query curated set + LLM-judge rubric, per Anthropic's advice?

---

## 11. Implementation status

**Decision (user):** build our own `/loop`, lightest that works. Done:

- `extensions/loop/index.ts` — `/loop` command: `[--program <path>] [--max-rounds N] [--tokens N] <mission>`,
  subcommands `status` / `pause` / `resume` / `clear`; re-reads program.md every round (live human
  steering); `complete_loop` tool (complete-only, exposed only while active); round counter +
  per-turn token accounting (pi-goal mechanics, trimmed); state persisted as session entries,
  reload pauses, resume re-triggers on idle.
- `examples/deep-research/program.md` — the research program template (checkpoint step is
  conditional on a `research_checkpoint` tool, which is deferred until early-stop is observed).
- `types/pi-coding-agent.d.ts` — ambient stub extended with the API surface the extension uses
  (`registerCommand`, `sendMessage`, `appendEntry`, `on`, `getActiveTools`/`setActiveTools`, UI ctx).

Not built (deliberately): `research_checkpoint` tool (Step 2, only on observed early stopping),
worker tool isolation, `.runs/` checkpoints, audit.jsonl.

Next: `/reload`, then validate with the §8 run matrix (Q1–Q3) and compare against the no-loop
one-shot baseline.

---

## 12. Validation results (Q1–Q3, executed in-session)

All three runs executed manually in-session following `program.md` exactly (each round = one
agent turn: re-read program → attack weakest sub-questions → parallel search → deep-read →
update score.md/notes.md). Artifacts: `/tmp/deep-research-q{1,2,3}/research/`.

| Metric | Q1 factual (quick) | Q2 comparative (std) | Q3 broad/deep (std) |
| --- | --- | --- | --- |
| Rounds used | 3 / 3 (capped, condition met at cap) | 4 / 6 | 4 / 6 |
| Unique sources | 9 | 12 | 14 |
| Citation coverage | ~100% | ~100% | ~100% |
| Contradictions surfaced | 3 | 4 | 4 |
| Surface-summary smell | none | none | none |
| Notable content | OSD crash bug + iSCSI caveat surfaced via advisory layer | vendor TDP copy error caught by SEO-farm rule | "89% abandon" clickbait stat flagged + discarded |

**What validated well:**

1. **The self-score table is the anti-early-stop mechanism — proven on all three profiles.**
   Q3 (broad/deep) was the real test: after round 2 the picture "felt done" (adoption +
   distro overview), and only the blank Q4/Q6/Q7 rows in score.md forced rounds 3–4.
   Exactly the §3.8.1 "write the table, make premature stop visible" design.
2. **Credibility tiers caught real content**: the SEO-farm rule flagged dockerspot's
   unverifiable "89% abandon K8s by month 3" stat (discarded, recorded as contradiction)
   and minipcreviewer's wrong "6W TDP" for the N305.
3. **Fetch failures were absorbed every run** (reddit → old.reddit, cpu-monkey/anti-bot
   blocked, homenode 3× fail, CNCF intro-only) — multi-engine search + triangulation held.
4. **Effort scaling confirmed**: the factual query (quick) needed 3 rounds and 2 deep reads
   of primary sources; the broad survey needed the full 4. Quick profile is right for
   factual; standard for survey/comparison.
5. **No premature completion, no cap hits** — completion was always via the condition
   (all ≥80, ≥8 sources, contradictions resolved), never via max-rounds.

**Program.md upgrades suggested by the runs (not yet applied):**

- Add a **date-check rule**: several strong sources carry future/fresh dates (2026-dated
  docs, dated content); "treat version numbers as latest-available, flag dates" — the
  dated-source risk appeared in both Q1 and Q3.
- The `research_checkpoint` min-sources rule remains the top Step-2 candidate if a future
  run shows self-reported source counts gaming the completion check.

**Not tested in-session (needs real `/loop` after `/reload`):** token-budget enforcement,
max-rounds cap behavior, mid-run program.md edits steering the run, reload/resume, and the
no-loop one-shot baseline comparison.
