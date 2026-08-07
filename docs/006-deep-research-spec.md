# Deep Research — Feature Spec

> Replacement for `skills/deep-research/SKILL.md` (the old 6-stage pipeline draft).
> Driven by: `docs/004-deep-research-loop-poc.md`, `docs/002-deep-research-notes.md`,
> `docs/003-implement-loop.org`, `docs/005-deep-research-research.org` (20 sources).
> Design philosophy: thin orchestration + let the model drive (the bitter lesson).
> Subagent-heavy: program.md declares roles, /loop dispatches, subagents do specialized work.

---

## 1. Architecture Overview

```
user: /research "topic"
  │
  ▼
┌──────────────────────────────────┐
│  Plan phase                     │
│  Coordinator → score.md + plan  │
│  → ctx.ui.confirm() (Gate)      │
└──────────────┬───────────────────┘
               │ approved
               ▼
┌──────────────────────────────────┐
│  /loop engine (existing)         │
│  Reads program.md each round     │
│  Round counter + token accounting│
│  Caps: --max-rounds, --tokens    │
│  No-progress guard (FR-6)        │
└──────────────┬───────────────────┘
               │
               ▼
┌──────────────────────────────────┐
│  Research loop (per profile)     │
│  Coordinator searches via         │
│    web-search skill               │
│  Dispatches subagents:            │
│    scouts (breadth)               │
│    fetch (deep reads)             │
│    judge (verification, mid+)     │
│    CitationAgent (intermediate+)  │
│    SourceAuditor (deep)           │
│    ContradictionResolver (deep)   │
└──────────────┬───────────────────┘
               │
               ▼
┌──────────────────────────────────┐
│  Verification pass               │
│  Judge subagent (intermediate+)   │
│  Coordinator fixes flagged claims│
└──────────────┬───────────────────┘
               │
               ▼
┌──────────────────────────────────┐
│  research_checkpoint tool        │
│  Reads thresholds from program.md│
│  🔴 CONTINUE or 🟢 PROCEED       │
└──────────────┬───────────────────┘
               │ PROCEED
               ▼
┌──────────────────────────────────┐
│  report.org in the research dir  │
│  complete_loop                   │
└──────────────────────────────────┘
```

---

## 2. The /loop Engine (Existing)

`/loop` is the generic continuation loop engine. `/research` is the deep-research specialization that plugs into it.

### Capabilities

- **Continuation loop:** re-reads program.md every round, delivers one continuation message per agent end
- **Round & token accounting:** `--max-rounds N`, `--tokens N`
- **Pause / resume / clear / status:** session-scoped state, reload-pause
- **No-progress detection:** auto-pauses on identical output (FR-6)
- **Stale-turn guard:** guard-id rotation on resume (FR-7)
- **Idle-boundary continuation:** queues next turn only when agent is settled (FR-8)
- **Reload safety:** pauses on /reload, resumes from session state (FR-9)
- **Budget ceiling behavior:** wrap-up message on cap hit, never silent stop (FR-10)
- **Completion audit:** `complete_loop` tool — complete-only, exposed only while active (FR-3)

### Non-goals (what /loop is NOT)

- NOT a deep-research state machine — no search logic, no report template inside /loop
- NOT a scheduler
- NOT a multi-agent orchestrator — subagent dispatch is a specialization

---

## 3. Depth Profiles

Profiles define the research intensity: subagent count × round count. Thresholds are stored in program.md so they're tunable without code changes.

| Profile | Subagents | Rounds | Min Sources | Workers/Round | Character |
| --------- | ----------- | -------- | ------------- | --------------- | ----------- |
| quick | **None** (single agent) | 10 | 15 | 1 | Thorough but serial — no parallelism, doesn't stop early |
| standard | **5 scouts** | 6 | 20 | 6 | Balanced parallel breadth |
| intermediate | **8 scouts + 3 fetch** | 8 | 30 | 12 | Substantial — scouts search + deep reads in parallel |
| deep | **12 scouts + 5 fetch** | 10 | 40 | 18 | Maximum parallelism — very extensive |

**Token estimates (rough, single-agent models):**

- quick: ~20–35K
- standard: ~50–80K
- intermediate: ~80–150K
- deep: ~150–300K

**Defaults:**

- `/research "topic"` → standard profile
- `/research --profile quick "topic"` → quick profile
- `/research --profile deep "topic"` → deep profile
- `--yes` flag skips plan approval (automated/scripted runs)
- `--no-confirm` is equivalent to `--yes`

---

## 4. Subagent Roles

Subagents are dispatched via tmux-subagent infrastructure. Each role has a specific job and returns structured output to the coordinator via the filesystem.

### 4.1 Scout (breadth)

**Purpose:** Explore one angle of the research question in parallel with other scouts.

**Behavior:**

- Receives a specific sub-question from the coordinator
- Searches the web (via web-search skill) for that angle
- Evaluates results, identifies the 2–3 best sources
- Returns: list of key findings + source URLs + confidence per finding

**Dispatch:** used in every round ≥ 1 for standard/intermediate/deep profiles.

### 4.2 Fetch (deep read)

**Purpose:** Do a deep read of the most authoritative sources identified by scouts.

**Behavior:**

- Receives URLs from scouts
- Fetches and extracts full content (Readability)
- Evaluates source quality, extracts key claims
- Returns: extracted content summary + key claims + source metadata (author, date, type)

**Dispatch:** used in rounds 1+ for intermediate/deep profiles.

### 4.3 Judge (verification)

**Purpose:** Independently verify the draft report before it's finalized. Profile-dependent.

**Behavior:**

- Receives draft report + all sources + score.md
- Evaluates against rubric:
  - Every [n] citation: does the source actually support the claim?
  - Any unresolved contradiction: properly noted?
  - Any claim with confidence < 60%: flagged for re-verification
- Returns: structured verdict with flagged claims + confidence scores

**Profile dispatch:**

- quick/standard: self-judge (coordinator verifies its own findings)
- intermediate/deep: judge subagent dispatched once after synthesis

### 4.4 CitationAgent (Citation verification)

**Purpose:** Separate pass — reads the draft report and maps every factual claim to its exact source location.

**Behavior:**

- Receives draft report + all source content
- For every factual claim: finds the exact sentence/passages that support it
- Returns: verified citation table [claim → source_url → exact_quote]
- Flags: claims without adequate sources, mismatched citations

**Profile dispatch:**

- quick/standard/intermediate: coordinator self-verifies (no subagent)
- deep: CitationAgent subagent dispatched after synthesis, before judge

### 4.5 Source Quality Auditor

**Purpose:** Rate all sources and flag low-quality ones (SEO farms, outdated info, unverifiable claims).

**Behavior:**

- Receives all collected sources with metadata
- Rates each: authoritative/primary (⭐), independent/secondary (🔵), community (🟡), low-quality (🔴)
- Flags: potential SEO farms, unverifiable statistics, conflicting metadata (author, date)
- Returns: source quality report with ratings + flagged sources

**Profile dispatch:**

- quick/standard/intermediate: no auditor
- deep: SourceAuditor subagent dispatched after all sources collected

### 4.6 Contradiction Resolver

**Purpose:** Investigate and resolve contradictions between sources.

**Behavior:**

- Receives list of contradictions from notes.md
- For each contradiction: searches for additional sources, evaluates authority
- Returns: resolution per contradiction — which source is more credible and why

**Profile dispatch:**

- quick/standard/intermediate: coordinator resolves (program.md instruction)
- deep: ContradictionResolver subagent dispatched after synthesis

---

## 5. The Research Program File (`program.md`)

The program file is the methodology — the 90% of deep research. It lives at the run's working directory (a per-run scratch dir created by /research under `/tmp/<project-folder>/research/<research-id>-<research-slug>/`) and is re-read at the start of every round by /loop.

```markdown
# Deep Research Program

## Mission
<injected by /research — do not edit>

## Deliverable
Write `report.org` — a structured org-mode report with claim-level citations — in the research working directory.

## Depth Profiles
quick:    min_rounds=10, min_sources=15, max_rounds=10
standard: min_rounds=8,  min_sources=30, max_rounds=8
intermediate: min_rounds=10, min_sources=40, max_rounds=10
deep:     min_rounds=20, min_sources=250, max_rounds=20

## Profile
standard  ← the default (overridable via --profile)

## Protocol

### Round 0 — Plan
1. Restate the mission as 5–8 concrete sub-questions in `score.md`.
   For each: the question, what evidence would answer it, who would know.
2. START WIDE — first-round queries must be broad. Narrow after round 1.

### Every Research Round
1. Read `score.md` and `notes.md` first. Never redo done work.
2. Attack the 1–3 weakest sub-questions (lowest scores).
3. Fire 2–4 parallel `lookup_web` queries via the web-search skill (distinct phrasings,
   quoted exact terms, site:/filetype: filters when useful).
4. Dispatch scout subagents for breadth (if profile ≥ standard). Each scout gets a
   specific sub-question. Scouts return findings + source URLs to the filesystem.
5. Dispatch fetch subagents for deep reads of the best hits (if profile ≥ intermediate).
   Fetch agents return content summaries + key claims to the filesystem.
6. Append to `notes.md`: claim → source URL → confidence (0–100).
7. Triangulate: every key claim needs 2+ independent sources spanning credibility
   tiers (official / independent analysis / community).
8. Update `score.md` (0–100 per sub-question + notes column).
9. Record unresolved contradictions in the notes column — never paper over them.
10. If contradictions exist, dispatch a ContradictionResolver subagent (deep profile).
11. Call `research_checkpoint` (profile, round, total_sources, contradictions) and obey:
    🔴 CONTINUE → start another round; 🟢 PROCEED → advance to verification.

### Verification Pass
After synthesis and before writing the final report:

**quick/standard:**
1. Coordinator self-verifies: re-read draft findings + all sources.
2. Fix any broken claims → update draft.

**intermediate/deep:**
1. Dispatch a judge subagent with the evaluation rubric:
   - Every [n] citation: does the source actually support the claim?
   - Any unresolved contradiction: properly noted?
   - Any claim with confidence < 60%: flagged for re-verification
2. Review judge's verdict. Fix flagged claims → update draft.

**deep only:**
3. Dispatch a CitationAgent subagent: map every factual claim to exact source location.
4. Dispatch a Source Quality Auditor subagent: rate all sources, flag low-quality ones.
5. Fix any issues raised by CitationAgent or Source Auditor.

## Completion Condition
All three, then write the report and call `complete_loop`:
- every sub-question scored ≥ 80
- ≥ min_sources unique sources cited (from profile)
- no unresolved contradiction on a scored question

## Report Template (`report.org` — in the research working directory)
* Deep Research — <Topic>

** Executive Summary (≤5 bullets)

** Findings Per Sub-Question
   Every claim tagged [n] → sources table

** Comparison Table + Narrative (where the mission implies alternatives)

** Contradictions & Debates

** Uncertainties & Gaps (required — anything scored < 80, capped rounds, unverifiable claims)

** Sources
   | # | Source | URL | Credibility Tier | Retrieved |
   |---|--------|-----|-----------------|-----------|
   Credibility tiers: ⭐ Official (vendor primary), 🔵 Independent, 🟡 Community, 🟠 Academic

** Org-mode formatting: use * for headings, | for tables, / for italic, *bold*, ~code~

## Hard Caps (never exceed)
- Max rounds: defined by profile or --max-rounds flag
- Min rounds: defined by profile
- Min sources: defined by profile
- Token budget: --tokens flag
- Never fetch localhost/private IPs or credentialed URLs.
- Stay inside the research working directory.
```

The authoritative copy of the program lives at
`skills/deep-research/program.v2.md` (program v2 — adds plan revision,
selective query refinement, skim→gist→expand, robustness/UGC discipline,
context management with an evolving draft, agentic judge, and honest source
counting). The template above is illustrative only.

---

## 6. Extension Tools

### 6.1 `research_checkpoint`

**Purpose:** Code-enforced floor — prevents premature conclusion. ~40 lines.

**Parameters:**

```typescript
Type.Object({
  profile: Type.String(),           // quick | standard | intermediate | deep
  round: Type.Number(),             // current round
  total_sources: Type.Number(),     // unique sources so far
  contradictions: Type.Optional(Type.Array(Type.String())),
})
```

**Behavior:**

1. Reads thresholds from `program.md` (not hardcoded)
2. Evaluates: min_rounds, min_sources, max_rounds
3. Returns:
   - `🔴 CONTINUE — {specific guidance: which questions to attack, what to corroborate}` if rules fail
   - `🟢 PROCEED — criteria met.` if all rules pass
   - `🟢 PROCEED (max rounds). Flag {N} gap(s) in Uncertainties & Gaps.` if max rounds hit

**Thresholds come from program.md:**

```markdown
quick:    min_rounds=10, min_sources=15, max_rounds=10
standard: min_rounds=8,  min_sources=30, max_rounds=8
intermediate: min_rounds=10, min_sources=40, max_rounds=10
deep:     min_rounds=20, min_sources=250, max_rounds=20
```

> **Reality (2026-08-05, program v2):** thresholds are hardcoded in
> `extensions/loop/index.ts` (`RESEARCH_THRESHOLDS`) and are the source of
> truth; program.v2.md mirrors them for the agent's reference. If they diverge,
> the extension wins. `research_checkpoint` also cross-checks the reported
> source count against unique URLs recorded in the run's `notes.md` and uses
> the minimum, appending a mismatch hint when the model over-reports.

### 6.2 Subagent Dispatch (tmux-subagent integration)

**Purpose:** Coordinator dispatches subagents (scouts, fetch, judge, CitationAgent, etc.) when the program.md says to.

**Interface:** Not a separate tool — the coordinator invokes tmux-subagent via the existing infrastructure. The program.md specifies *when* to dispatch and *what* each subagent does. The dispatch mechanism is the coordinator calling `tmux-subagent` with the appropriate profile and prompt.

**Subagent profiles (tmux-subagent):**

- `scout`: broad search, evaluate results, return findings + URLs
- `fetcher`: deep read of URLs, extract content, return summary
- `judge`: evaluate draft report against rubric, return verdict
- `citation_agent`: map claims to exact source locations
- `source_auditor`: rate sources, flag low-quality ones
- `contradiction_resolver`: investigate and resolve contradictions

### 6.3 Plan Approval Gate

**Purpose:** Scope approval before tokens are spent. ~5 lines.

**Behavior:**

1. Coordinator writes `score.md` with sub-questions and search plan
2. If `--yes` flag: skip, proceed
3. If `ctx.ui.confirm()` available: show plan in TUI, wait for user to confirm/modify/cancel
4. If no UI and no `--yes`: proceed (headless safety)

---

## 7. Safety

### 7.1 Search Safety

- All searches use the web-search skill (DuckDuckGo/Brave/Bing + Readability extraction)
- No localhost/private IPs or credentialed URLs
- URL validation on all fetched content
- Rate limiting via web-search skill's built-in backoff

### 7.2 Token/Time Safety

- `--max-rounds N` — hard cap on rounds
- `--tokens N` — hard cap on token budget
- Profile-defined min_rounds — anti-early-stop floor (enforced by research_checkpoint)
- No-progress detection (FR-6) — auto-pauses on identical output

### 7.3 Subagent Safety

- Subagents use the same tool restrictions as the coordinator (search/fetch only)
- Subagents cannot modify program.md or core extension code
- Subagent output goes to the filesystem (coordinator reads, never blindly trusts)

---

## 8. Program vs Extension — Responsibility Split

| Responsibility | Location | Why |
| --------------- | ---------- | ----- |
| Methodology (sub-questions, report template, credibility tiers) | program.v2.md | The 90% — user-authored, editable mid-run |
| Subagent roles and dispatch rules | program.v2.md | User can customize when/what to dispatch |
| Profile thresholds (min_rounds, min_sources) | program.v2.md | Tunable without code changes |
| Verification rubric | program.v2.md | Customizable per user needs |
| Report format (org-mode) | program.v2.md | User preference |
| Loop mechanics (continuation, accounting, caps) | /loop extension | Generic engine, not task-specific |
| research_checkpoint tool | Extension | Code-enforced — can't be gamed by prompts |
| Plan approval gate | Extension | Needs ctx.ui.confirm() |
| No-progress detection | /loop extension | Already built (FR-6) |
| Subagent dispatch mechanism | Extension (tmux-subagent integration) | Reuses existing infrastructure |

---

## 9. Open Decisions (Deferred)

| Decision | Reason | When to revisit |
| ---------- | -------- | ----------------- |
| MCP integration | No proven MCP tools for research yet | When a verified MCP research tool exists |
| PDF export | Adds system dependencies (pandoc, weasyprint) | If users request it |
| Mermaid mind maps | Low-signal, user can generate via program.md | If users request it |
| JSONL audit log | Not yet needed for visibility | If debugging needs arise |
| Tavily API key support | Via web-search skill, not separate tool | When we enhance web-search skill |
| Research compactor subagent | Helps with very long runs | If runs exceed ~8 rounds with context bloat |
| Expert source hunter subagent | Can use program.md filetype:/site: filters | If primary source discovery is a repeated pain point |

---

## 10. Migration Notes

This spec replaces the old `skills/deep-research/SKILL.md` draft which specified:

- ~~6-stage pipeline (prefilter → research → synthesis → verification → repair → judge)~~ → replaced by program.md methodology + program-level steps
- ~~Profiles as node/token/time budgets~~ → replaced by profile subagent counts + round counts
- ~~Worker tool isolation~~ → replaced by tmux-subagent restrictions + program.md constraints
- ~~`.runs/<id>/checkpoint.json` + resume~~ → deferred (session entries + notes.md suffice)
- ~~`audit.jsonl`~~ → deferred

Artifacts now live in a per-run scratch workspace created by /research at `/tmp/<project-folder>/research/<research-id>-<research-slug>/` (project-folder = session cwd basename, research-id = local timestamp, research-slug = mission): `score.md`, `notes.md`, `report.org`. See §5.
