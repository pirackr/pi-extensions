# Deep Research — Feature Spec

> Replacement for `skills/deep-research/SKILL.md` (the old 6-stage pipeline draft).
> Driven by: `docs/004-deep-research-loop-poc.md`, `docs/002-deep-research-notes.md`,
> `docs/003-implement-loop.org`, `docs/005-deep-research-research.org` (20 sources).
> Design philosophy: thin orchestration + let the model drive (the bitter lesson).
> Subagent-heavy: program.v2.md declares roles, /loop dispatches, subagents do specialized work.

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
│  Reads program.v2.md each round  │
│  Round counter + token accounting│
│  Caps: --max-rounds, --tokens    │
│  No-progress guard (FR-6)        │
└──────────────┬───────────────────┘
               │
               ▼
┌──────────────────────────────────┐
│  Research loop (per profile)     │
│  Coordinator dispatches subagents│
│  via result_path into working dir│
│  Scouts, fetchers, synthesizers  │
│  All subagent I/O is durable     │
└──────────────┬───────────────────┘
               │
               ▼
┌──────────────────────────────────┐
│  research_checkpoint tool        │
│  Reads thresholds from config/   │
│    deep-research.json            │
│  🔴 CONTINUE or 🟢 PROCEED/       │
│    PROCEED_WITH_GAPS             │
└──────────────┬───────────────────┘
               │ PROCEED or       │
               │ PROCEED_WITH_GAPS│
               ▼
┌──────────────────────────────────┐
│  Synthesis: fragment writers     │
│  → assembler → report.org        │
│  → verification agents           │
└──────────────┬───────────────────┘
               │
               ▼
┌──────────────────────────────────┐
│  complete_loop                   │
│  Enforces: checkpoint evidence,  │
│  report.org non-empty,           │
│  profile-required verification   │
│  artifacts parse and pass        │
└──────────────────────────────────┘
```

---

## 2. The /loop Engine (Existing)

`/loop` is the generic continuation loop engine. `/research` is the deep-research specialization that plugs into it.

### Capabilities

- **Continuation loop:** re-reads program.v2.md every round, delivers one continuation message per agent end
- **Round & token accounting:** `--max-rounds N`, `--tokens N`
- **Pause / resume / clear / status:** session-scoped state, reload-pause
- **No-progress detection:** auto-pauses on identical output (FR-6)
- **Stale-turn guard:** guard-id rotation on resume (FR-7)
- **Idle-boundary continuation:** queues next turn only when agent is settled (FR-8)
- **Reload safety:** pauses on /reload, resumes from session state (FR-9)
- **Budget ceiling behavior:** wrap-up message on cap hit, never silent stop (FR-10)
- **Completion audit:** `complete_loop` tool — complete-only, exposed only while active (FR-3)
- **Terminal statuses:** `active`, `paused`, `no_progress`, `complete`, `budget_limited`

### Non-goals (what /loop is NOT)

- NOT a deep-research state machine — no search logic, no report template inside /loop
- NOT a scheduler
- NOT a multi-agent orchestrator — subagent dispatch is a specialization

---

## 3. Depth Profiles

Profiles define the research intensity: subagent count × round count. Thresholds are loaded from `config/deep-research.json` (source of truth); `program.v2.md` mirrors them for the agent's reference.

| Profile | Min Rounds | Max Rounds | Min Sources | Verification Artifacts | Character |
| --------- | ----------- | -------- | ------------- | ---------------------- | ----------- |
| quick | 10 | 10 | 15 | judge.json | Thorough but serial — no parallelism, doesn't stop early |
| standard | 8 | 8 | 30 | judge.json | Balanced parallel breadth |
| intermediate | 10 | 10 | 40 | judge.json, citations.json, sources.json | Substantial — scouts search + deep reads in parallel |
| deep | 20 | 20 | 250 | judge.json, citations.json, sources.json, contradictions.json | Maximum parallelism — very extensive |

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

Subagents are dispatched via the `run_subagents` tool with `result_path` so every durable artifact is written atomically to the run's working directory. The coordinator never writes report bodies directly — fragment writers and the assembler handle synthesis; verification agents write strict JSON to the `verification/` directory.

### 4.1 Scout (breadth)

**Purpose:** Explore one angle of the research question in parallel with other scouts.

**Behavior:**

- Receives a specific sub-question from the coordinator
- Searches the web (via web-search skill) for that angle
- Evaluates results, identifies the 2–3 best sources
- Writes a full Markdown report to `scout-outputs/<round>-<slug>-scout.md`
- Returns coordinator summary: status, outcome, evidence added, key changes, contradictions, recommended next action

**Dispatch:** used in every round ≥ 1 for all profiles.

### 4.2 Fetch (deep read)

**Purpose:** Do a deep read of the most authoritative sources identified by scouts.

**Behavior:**

- Receives URLs from scouts
- Fetches and extracts full content (Readability)
- Evaluates source quality, extracts key claims
- Writes a Markdown report to `scout-outputs/<round>-<slug>-fetch.md`

**Dispatch:** used in rounds 1+ for intermediate/deep profiles.

### 4.3 Judge (verification)

**Purpose:** Independently verify the draft report before it's finalized. Required for all profiles.

**Behavior:**

- Receives draft report + all sources + score.md
- Evaluates against rubric:
  - Every inline `[[URL][description]]` citation: does the source actually support the claim?
  - Any unresolved contradiction: properly noted?
  - Any claim with confidence < 60%: flagged for re-verification
- Writes strict JSON to `verification/judge.json` (version 1, runId, pass, verdict, failedChecks, fixes)

**Profile dispatch:**

- All profiles (quick, standard, intermediate, deep): judge verification agent dispatched after synthesis

### 4.4 CitationAgent (Citation verification)

**Purpose:** Separate pass — reads the draft report and maps every factual claim to its exact source location.

**Behavior:**

- Receives draft report + all source content
- For every factual claim: finds the exact sentence/passages that support it
- Writes `verification/citations.json` (version 1, runId, pass, unsupportedClaims, misattributedClaims)

**Profile dispatch:**

- intermediate/deep: CitationAgent dispatched after synthesis

### 4.5 Source Quality Auditor

**Purpose:** Rate all sources and flag low-quality ones (SEO farms, outdated info, unverifiable claims).

**Behavior:**

- Receives all collected sources with metadata
- Rates each: authoritative/primary (⭐), independent/secondary (🔵), community (🟡), low-quality (🔴)
- Writes `verification/sources.json` (version 1, runId, pass, unresolvedReplacements)

**Profile dispatch:**

- intermediate/deep: SourceAuditor dispatched after synthesis

### 4.6 Contradiction Resolver

**Purpose:** Investigate and resolve contradictions between sources.

**Behavior:**

- Receives list of contradictions from notes.md
- For each contradiction: searches for additional sources, evaluates authority
- Writes `verification/contradictions.json` (version 1, runId, pass, unhandled, acknowledged)

**Profile dispatch:**

- deep: ContradictionResolver dispatched after synthesis

---

## 5. Configuration

### 5.1 Configuration Precedence

Configuration is resolved in this order (later sources override earlier):

1. **Packaged config:** `config/deep-research.json` (bundled with the pi package)
2. **Per-instance override:** `$PI_AGENT_DIR/deep-research/config.json`
3. **Per-run CLI flags:** `--max-searches-per-agent N`, `--max-fetches-per-agent N`, `--max-rounds N`, `--profile`

User overrides are deep-merged with packaged defaults and then fully revalidated. Prompt paths from the override resolve relative to that override file. Project repositories do not automatically override agent tools or access.

### 5.2 Configuration Shape

The JSON configuration owns:

- default profile
- profile minimum rounds, maximum rounds, minimum sources, dispatch caps
- default per-agent web-search and fetch limits
- score threshold (default 80) and retry policy
- profile-specific verification matrix
- logical research roles and their agent profiles

Illustrative shape:

```json
{
  "defaultProfile": "standard",
  "defaults": {
    "maxSearchesPerAgent": 20,
    "maxFetchesPerAgent": 20,
    "scoreThreshold": 80,
    "retryCount": 1
  },
  "profiles": {
    "quick": {
      "minRounds": 10,
      "maxRounds": 10,
      "minSources": 15,
      "maxScouts": 3,
      "maxFetchers": 1,
      "verification": ["judge"]
    },
    "standard": {
      "minRounds": 8,
      "maxRounds": 8,
      "minSources": 30,
      "maxScouts": 8,
      "maxFetchers": 4,
      "verification": ["judge"]
    },
    "intermediate": {
      "minRounds": 10,
      "maxRounds": 10,
      "minSources": 40,
      "maxScouts": 12,
      "maxFetchers": 6,
      "verification": ["judge", "citation_agent", "source_auditor"]
    },
    "deep": {
      "minRounds": 20,
      "maxRounds": 20,
      "minSources": 250,
      "maxScouts": 32,
      "maxFetchers": 16,
      "verification": ["judge", "citation_agent", "source_auditor", "contradiction_resolver"]
    }
  },
  "agents": {
    "planner": { "model": "strong", "thinking": "high", "tools": ["read", "grep", "find", "ls"], "access": "read", "timeoutSeconds": 300, "promptPath": "../skills/deep-research/agents/planner.md", "resultFormat": "markdown" },
    "scout_research": { "model": "strong", "thinking": "high", "tools": ["read", "grep", "find", "ls", "web_lookup", "fetch_web"], "access": "read", "timeoutSeconds": 1800, "promptPath": "../skills/deep-research/agents/scout.md", "resultFormat": "markdown" },
    "fetcher": { "model": "strong", "thinking": "minimal", "tools": ["read", "web_lookup", "fetch_web"], "access": "read", "timeoutSeconds": 720, "promptPath": "../skills/deep-research/agents/fetcher.md", "resultFormat": "markdown" },
    "judge": { "model": "eval", "thinking": "medium", "tools": ["read", "grep", "find", "ls", "web_lookup", "fetch_web"], "access": "read", "timeoutSeconds": 1200, "promptPath": "../skills/deep-research/agents/judge.md", "resultFormat": "markdown" },
    "citation_agent": { "model": "strong", "thinking": "low", "tools": ["read", "grep", "find", "ls", "web_lookup", "fetch_web"], "access": "read", "timeoutSeconds": 720, "promptPath": "../skills/deep-research/agents/citation-agent.md", "resultFormat": "markdown" },
    "source_auditor": { "model": "strong", "thinking": "low", "tools": ["read", "grep", "find", "ls", "web_lookup", "fetch_web"], "access": "read", "timeoutSeconds": 720, "promptPath": "../skills/deep-research/agents/source-auditor.md", "resultFormat": "markdown" },
    "contradiction_resolver": { "model": "light", "thinking": "medium", "tools": ["read", "grep", "find", "ls", "web_lookup", "fetch_web"], "access": "read", "timeoutSeconds": 960, "promptPath": "../skills/deep-research/agents/contradiction-resolver.md", "resultFormat": "markdown" }
  }
}
```

### 5.3 CLI Flags

```
/research "XYZ" --profile deep \
  --max-searches-per-agent 100 \
  --max-fetches-per-agent 50
```

| Flag | Default | Notes |
|------|---------|-------|
| `--profile <p>` | `standard` | `quick`, `standard`, `intermediate`, `deep` |
| `--max-rounds N` | profile max | Hard cap; effective max used by checkpoint |
| `--tokens N` | none | Hard token budget |
| `--max-searches-per-agent N` | from config (20) | 0 = unlimited; per-process hard budget for web_lookup |
| `--max-fetches-per-agent N` | from config (20) | 0 = unlimited; per-process hard budget for fetch_web |
| `--yes` / `--no-confirm` | off | Skip plan approval gate |
| `--no-progress N\|off` | 3 | Auto-pause after N identical/empty continuation rounds |

Before approval, `/research` displays all resolved operational values: profile, min/max rounds, min source target, scout/fetch dispatch caps, per-agent search and fetch limits, verification suite, token budget, and output directory.

---

## 6. Artifact Layout

The research working directory is the durable boundary for one run:

```
/tmp/<project-folder>/research/<research-id>-<research-slug>/
├── score.md                 # 5–8 row markdown table: ID | Question | Score (0–100) | Notes
├── notes.md                 # claim → source URL → confidence per round
├── report.org               # final org-mode report (written by assembler)
├── fragments/               # org fragments from synthesis workers
│   └── findings-<n>.org
├── scout-outputs/           # raw scout/fetcher reports (read-only)
│   ├── <round>-<slug>-scout.md
│   └── <round>-<slug>-fetch.md
└── verification/            # strict JSON artifacts (version 1, runId, pass)
    ├── judge.json
    ├── citations.json       # intermediate+
    ├── sources.json         # intermediate+
    └── contradictions.json  # deep only
```

Temporary `/tmp/pi-subagent-*` JSONL transcripts remain debugging artifacts. They are not research inputs and are not required for later rounds.

---

## 7. The Research Program File (`program.v2.md`)

The program file is the methodology — the 90% of deep research. It lives at `skills/deep-research/program.v2.md` and is re-read at the start of every round by /loop. The engine loads operational thresholds from `config/deep-research.json`; program.v2.md is user-authored and editable mid-run.

The program defines:

- Mission statement (injected by /research)
- Depth profile (injected by /research)
- Working directory (injected by /research)
- Protocol: Round 0 planning, every-round dispatch rules, synthesis flow, repair loops
- Org-mode formatting requirements
- Hard caps (rounds, tokens, URL restrictions)

Operational configuration (thresholds, agent models, timeouts, dispatch caps, verification matrix) lives in `config/deep-research.json`, not in program.v2.md.

---

## 8. Checkpoint Semantics

`research_checkpoint` uses the active run's effective maximum round count (CLI-override-aware) instead of the profile's packaged maximum when `--max-rounds` overrides it.

**Parameters:**

```typescript
Type.Object({
  profile: Type.String(),           // quick | standard | intermediate | deep
  round: Type.Number(),             // current round (1-indexed)
  totalSources: Type.Number(),      // unique sources so far
  contradictions: Type.Optional(Type.Array(Type.String())),
})
```

**Behavior:**

1. Parses `score.md` — requires 5–8 unique IDs, integer scores 0–100
2. Reads thresholds from `config/deep-research.json` (source of truth)
3. Cross-checks reported source count against unique URLs in `notes.md`; uses `min(reported, counted)` with a mismatch hint
4. Evaluates: `minRounds`, `minSources`, `scoreThreshold`
5. Returns:
   - `🔴 CONTINUE — {specific guidance: which questions to attack, what to corroborate}` if rules fail
   - `🟢 PROCEED — criteria met.` if all rules pass (records checkpoint evidence)
   - `🟢 PROCEED_WITH_GAPS — max rounds reached with {N} gap(s): ...` if effective max reached (records checkpoint evidence)

A successful checkpoint is recorded in persisted loop state (`checkpointEvidence`). Starting another research round invalidates the recorded checkpoint.

---

## 9. Verification Matrix

| Profile | Required Passing Artifacts |
| --- | --- |
| quick | `judge.json` |
| standard | `judge.json` |
| intermediate | `judge.json`, `citations.json`, `sources.json` |
| deep | `judge.json`, `citations.json`, `sources.json`, `contradictions.json` |

Each verification file has a versioned strict JSON schema and an explicit `pass` boolean:

| Artifact | Pass Condition |
| --- | --- |
| `judge.json` | `pass === true` and `verdict === "PASS"` |
| `citations.json` | `pass === true`, `unsupportedClaims.length === 0`, `misattributedClaims.length === 0` |
| `sources.json` | `pass === true`, `unresolvedReplacements.length === 0` |
| `contradictions.json` | `pass === true`, `unhandled.length === 0` |

Malformed files fail verification rather than being interpreted heuristically. Every artifact must identify the current run via `runId === loop.id`.

---

## 10. Completion and Cap Handling

`complete_loop` requires (for `/research`):

1. The latest checkpoint belongs to the current run and remains valid (`runId === loop.id`, `verdict` is `PROCEED` or `PROCEED_WITH_GAPS`)
2. `report.org` exists and is non-empty
3. Every profile-required verification artifact parses, passes, and identifies the current run
4. `checkpointEvidence` is present in loop state

The engine validates these conditions directly. File existence alone is insufficient.

**Terminal statuses:**

| Status | Meaning |
| --- | --- |
| `active` | Research in progress |
| `paused` | Paused by user or no-progress guard |
| `no_progress` | Auto-paused: N consecutive empty/identical continuation rounds |
| `complete` | `complete_loop` called and all gates passed |
| `budget_limited` | Round or token cap reached before completion |

If a round or token cap stops a run before the completion gates pass, the run remains `budget_limited`. Existing partial artifacts are preserved; `complete_loop` is not called and the run is not represented as successful.

---

## 11. Safety

### 11.1 Search Safety

- All searches use the web-search skill (DuckDuckGo/Brave/Bing + Readability extraction)
- No localhost/private IPs or credentialed URLs
- URL validation on all fetched content
- Rate limiting via web-search skill's built-in backoff

### 11.2 Token/Time Safety

- `--max-rounds N` — hard cap on rounds
- `--tokens N` — hard cap on token budget
- Profile-defined `minRounds` — anti-early-stop floor (enforced by research_checkpoint)
- Per-agent `maxSearchesPerAgent` / `maxFetchesPerAgent` — hard per-process web budgets
- No-progress detection (FR-6) — auto-pauses on identical output

### 11.3 Subagent Safety

- Subagents use the same tool restrictions as the coordinator
- Subagent output goes to the filesystem via `result_path` (coordinator reads, never blindly trusts)
- Export failures fail the task; downstream consolidation does not proceed
- Subagents cannot modify program.v2.md or core extension code

---

## 12. Program vs Extension — Responsibility Split

| Responsibility | Location | Why |
| --------------- | ---------- | ----- |
| Methodology (sub-questions, report template, credibility tiers) | program.v2.md | The 90% — user-authored, editable mid-run |
| Profile thresholds (min/max rounds, min sources) | config/deep-research.json | Source of truth; code-enforced |
| Per-agent budgets (search/fetch limits, timeouts) | config/deep-research.json | Overrideable via CLI |
| Verification matrix | config/deep-research.json | Profile-specific, validated by engine |
| Report format (org-mode) | program.v2.md | User preference |
| Loop mechanics (continuation, accounting, caps) | /loop extension | Generic engine, not task-specific |
| research_checkpoint tool | Extension | Code-enforced — can't be gamed by prompts |
| Plan approval gate | Extension | Needs ctx.ui.confirm() |
| No-progress detection | /loop extension | Already built (FR-6) |
| Durable subagent result export | Extension (run_subagents) | `result_path` + schema validation |
| Completion gates | Extension (complete_loop) | Enforces checkpoint + report + verification |

---

## 13. Open Decisions (Deferred)

| Decision | Reason | When to revisit |
| ---------- | -------- | ----------------- |
| MCP integration | No proven MCP tools for research yet | When a verified MCP research tool exists |
| PDF export | Adds system dependencies (pandoc, weasyprint) | If users request it |
| Mermaid mind maps | Low-signal, user can generate via program.v2.md | If users request it |
| JSONL audit log | Not yet needed for visibility | If debugging needs arise |
| Tavily API key support | Via web-search skill, not separate tool | When we enhance web-search skill |
| Research compactor subagent | Helps with very long runs | If runs exceed ~8 rounds with context bloat |
| Expert source hunter subagent | Can use program.v2.md filetype:/site: filters | If primary source discovery is a repeated pain point |

---

## 14. Migration Notes

This spec replaces the old `skills/deep-research/SKILL.md` draft which specified:

- ~~6-stage pipeline (prefilter → research → synthesis → verification → repair → judge)~~ → replaced by program.v2.md methodology + program-level steps
- ~~Profiles as node/token/time budgets~~ → replaced by profile subagent counts + round counts in config
- ~~Worker tool isolation~~ → replaced by tmux-subagent restrictions + program.v2.md constraints
- ~~`.runs/<id>/checkpoint.json` + resume~~ → deferred (session entries + notes.md suffice)
- ~~`audit.jsonl`~~ → deferred
- ~~Self-judge for quick/standard~~ → all profiles now require `judge.json` verification artifact
- ~~Thresholds in program.md~~ → thresholds moved to `config/deep-research.json`

Artifacts now live in a per-run scratch workspace created by /research at `/tmp/<project-folder>/research/<research-id>-<research-slug>/` (project-folder = session cwd basename, research-id = local timestamp, research-slug = mission). See §6.
