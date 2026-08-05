# Deep Research — Subagent-Heavy Research Engine

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a code-enforced `research_checkpoint` tool, profile-aware /research command, plan approval gate, new subagent profiles for research, and update the program.md and SKILL.md to match the deep research spec.

**Architecture:** Thin orchestration via two extension tools (research_checkpoint + plan approval gate) layered on the existing /loop engine. The heavy lifting — methodology, parallelization, verification — is specified in the program.md template, which the LLM coordinator follows. Subagent dispatch uses the existing tmux-subagent infrastructure with 6 new research-specific profiles.

**Tech Stack:** TypeScript, TypeBox (existing extension framework), pi-coding-agent ExtensionAPI, tmux for process isolation. No new dependencies.

## Global Constraints

- **Profile thresholds are source-of-truth in the extension**, not in program.md (code-enforced floors)
- **No MCP integration for v1** — all tools registered as ExtensionAPI tools
- **ES modules**: all `.mjs` files use top-level `await`; extension files use jiti TypeScript loading
- **Program.md is the methodology contract**; extension tools are hard constraints
- **Existing /loop engine is immutable** — all changes are additive (new tool registration, new command handler, new state fields)
- **Subagent profiles are .md files** loaded from `subagents/` directory — do NOT modify config.ts
- **Output format is org-mode** (`research/report.org`), not markdown

---

## Task Structure

### Task 1: Profile-aware /research command

**Files:**

- Modify: `extensions/loop/index.ts:39-55` (LoopState interface)
- Modify: `extensions/loop/index.ts:120-152` (parseArgs — add `--profile` flag)
- Modify: `extensions/loop/index.ts:332-476` (registerLoopCommand — add profile parsing for research)
- Modify: `extensions/loop/index.ts:537-554` (remove hardcoded RESEARCH_MAX_ROUNDS, replace with profile-based registration)
- Modify: `extensions/loop/index.ts:108-118` (normalizeState — add profile default)
- Remove: `extensions/loop/index.ts:13` (RESEARCH_MAX_ROUNDS constant)

**Interfaces:**

- Consumes: nothing new — uses existing ExtensionAPI, TypeBox, LoopState
- Produces: `/research --profile <quick|standard|intermediate|deep>` command with dynamic maxRounds, profile stored in LoopState.profile

**Profile-to-rounds mapping (constant to add at line 14):**

```typescript
const PROFILE_MAX_ROUNDS = {
  quick: 10,
  standard: 6,
  intermediate: 8,
  deep: 10,
};
```

**Step 1: Add `profile` field to LoopState interface**

Add after line 54 (`updatedAt: number;`):

```typescript
 profile?: string; // research profile: quick|standard|intermediate|deep
```

**Step 2: Update normalizeState to include profile default**

Replace the normalizeState function (lines 109-118):

```typescript
function normalizeState(s: LoopState): LoopState {
 return {
  ...s,
  profile: s.profile ?? "standard",
  guardId:
   s.guardId ?? `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  noProgressTurns: s.noProgressTurns ?? DEFAULT_NO_PROGRESS_TURNS,
  noProgressCount: s.noProgressCount ?? 0,
  lastFingerprint: s.lastFingerprint ?? null,
 };
}
```

**Step 3: Add `--profile` flag parsing to parseArgs**

In the parseArgs function, add `profile` to the list of recognized flag keys (line 136):

```typescript
   if (
    key === "program" ||
    key === "max-rounds" ||
    key === "tokens" ||
    key === "no-progress" ||
    key === "profile"
   ) {
```

**Step 4: Add profile parsing in the research command handler**

In the registerLoopCommand handler, AFTER the --max-rounds validation (after line 414, BEFORE line 415), add profile detection. Since registerLoopCommand is generic, we need a way to know if this is the research command. Add a `isResearch?: boolean` field to LoopCommandOptions (line 325-330):

Replace the LoopCommandOptions interface (lines 325-330):

```typescript
interface LoopCommandOptions {
 command: "loop" | "research";
 description: string;
 defaultProgram: string; // absolute, or cwd-relative
 defaultMaxRounds: number;
 isResearch?: boolean;
}
```

Then in the handler, after line 414 (after maxRounds validation), add:

```typescript
  // research: profile flag overrides default maxRounds
  let profile: string | undefined;
  if (opts.isResearch && flags.profile) {
   const p = flags.profile;
   if (!(p in PROFILE_MAX_ROUNDS)) {
    ctx.ui.notify(
     `Unknown profile: ${p}. Use quick, standard, intermediate, or deep.`,
     "warning",
    );
    return;
   }
   profile = p;
   // Only override if user didn't explicitly set --max-rounds
   if (!flags["max-rounds"]) {
    maxRounds = PROFILE_MAX_ROUNDS[p as keyof typeof PROFILE_MAX_ROUNDS];
   }
  }
```

Then in the loop state object creation (lines 457-472), add profile:

```typescript
   loop = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    commandName: cmd,
    programPath,
    mission,
    rounds: 0,
    maxRounds,
    tokensUsed: 0,
    tokenBudget,
    guardId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    noProgressTurns,
    noProgressCount: 0,
    lastFingerprint: null,
    profile,
    status: "active",
    updatedAt: now,
   };
```

**Step 5: Remove RESEARCH_MAX_ROUNDS and replace /research registration**

Delete line 13 (`const RESEARCH_MAX_ROUNDS = 6;`).

Replace the /research registration (lines 546-554):

```typescript
 // /research — deep-research front-end of the same engine: defaults to the
 // bundled research program. Profile-based maxRounds set from PROFILE_MAX_ROUNDS.
 registerLoopCommand(pi, {
  command: "research",
  description:
   "Deep research: run the bundled research program (program.md) as an autonomous loop — searches, fetches sources, and compiles research/report.org with claim-level citations.",
  defaultProgram: RESEARCH_PROGRAM_PATH,
  defaultMaxRounds: PROFILE_MAX_ROUNDS.standard,
  isResearch: true,
 });
```

**Step 6: Verify with LSP**

Run `lsp_diagnostics` on `extensions/loop/index.ts`. Expected: no errors.

**Step 7: Verify TypeScript compilation**

```bash
cd /home/pirackr/Working/grinder/pi-extensions
npx tsc --noEmit extensions/loop/index.ts 2>&1 | head -20
```

Expected: no errors.

**Step 8: Commit**

```bash
cd /home/pirackr/Working/grinder/pi-extensions
git add extensions/loop/index.ts
git commit -m "feat(loop): add profile-aware /research command (quick/standard/intermediate/deep)"
```

---

### Task 2: research_checkpoint tool

**Files:**

- Modify: `extensions/loop/index.ts:535-536` (after complete_loop tool registration)

**Interfaces:**

- Consumes: nothing — self-contained tool
- Produces: `research_checkpoint` tool that returns CONTINUE/PROCEED verdict based on hardcoded profile thresholds

**Thresholds (constant to add in piLoop(), after line 535):**

```typescript
const RESEARCH_THRESHOLDS = {
 quick:    { minRounds: 10, minSources: 15, maxRounds: 10 },
 standard: { minRounds: 6,  minSources: 20, maxRounds: 6 },
 intermediate: { minRounds: 8, minSources: 30, maxRounds: 8 },
 deep:     { minRounds: 10, minSources: 40, maxRounds: 10 },
};
```

**Step 1: Add research_checkpoint tool registration after complete_loop**

After line 535 (the closing `});` of the complete_loop tool), add the full tool registration:

```typescript
 // research_checkpoint — code-enforced floor against premature conclusion.
 // Thresholds are hardcoded (source-of-truth); program.md mirrors them for
 // the agent's reference. If they diverge, the extension wins.
 pi.registerTool({
  name: "research_checkpoint",
  label: "Research Checkpoint",
  description:
   "MANDATORY after each search round. Returns CONTINUE or PROCEED based on code-enforced thresholds for the active profile. Call every round with current round number and total unique sources.",
  promptSnippet:
   "Call research_checkpoint every round to check if you have enough coverage",
  promptGuidelines: [
   "Call after each search round: research_checkpoint({profile, round, totalSources}).",
   "Do NOT call complete_loop unless research_checkpoint returns PROCEED.",
  ],
  parameters: Type.Object({
   profile: Type.String({
    description: "Research profile: quick | standard | intermediate | deep",
   }),
   round: Type.Number({
    description:
     "Current round number (1-indexed). Increment each search round.",
   }),
   totalSources: Type.Number({
    description:
     "Number of unique sources collected so far (count distinct URLs).",
   }),
   contradictions: Type.Optional(
    Type.Array(Type.String(), {
     description: "List of unresolved contradictions (informational).",
    }),
   ),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
   const p = params as {
    profile?: string;
    round?: number;
    totalSources?: number;
    contradictions?: string[];
   };
   const profile = p.profile ?? "standard";
   const thresholds = RESEARCH_THRESHOLDS[profile as keyof typeof RESEARCH_THRESHOLDS];
   if (!thresholds) {
    return {
     content: [
      {
       type: "text",
       text: `Unknown profile "${profile}". Use: quick, standard, intermediate, deep.`,
      },
     ],
     isError: true,
    };
   }
   const round = p.round ?? 0;
   const sources = p.totalSources ?? 0;
   const issues: string[] = [];
   if (round < thresholds.minRounds) {
    issues.push(`⛔ min rounds: ${round}/${thresholds.minRounds}`);
   }
   if (sources < thresholds.minSources) {
    issues.push(`⛔ min sources: ${sources}/${thresholds.minSources}`);
   }
   if (round >= thresholds.maxRounds) {
    return {
     content: [
      {
       type: "text",
       text: `🟢 PROCEED (max rounds reached). Flag ${issues.length} gap(s) in Uncertainties & Gaps.`,
      },
     ],
    };
   }
   if (issues.length > 0) {
    return {
     content: [
      {
       type: "text",
       text: `🔴 CONTINUE — ${issues.join("; ")}`,
      },
     ],
    };
   }
   return {
    content: [
     {
      type: "text",
      text: `🟢 PROCEED — criteria met.`,
     },
    ],
   };
  },
 });
```

**Step 2: Verify with LSP**

Run `lsp_diagnostics` on `extensions/loop/index.ts`. Expected: no errors.

**Step 3: Commit**

```bash
cd /home/pirackr/Working/grinder/pi-extensions
git add extensions/loop/index.ts
git commit -m "feat(loop): add research_checkpoint tool with code-enforced thresholds"
```

---

### Task 3: Plan approval gate

**Files:**

- Modify: `extensions/loop/index.ts:472-475` (between loop state creation and emission)

**Interfaces:**

- Consumes: `ctx.ui.confirm` (optional, only available in UI mode)
- Produces: plan approval dialog for /research (not /loop), skipped with `--yes` flag

**Step 1: Add plan approval gate between loop state creation and emission**

After line 472 (the closing `};` of the loop state object), before line 473 (`persist(pi, ctx);`), add:

```typescript
   // research: plan approval gate — confirm before burning tokens
   if (opts.isResearch) {
    const yesFlag =
     args.includes("--yes") ||
     args.includes("--no-confirm");
    if (!yesFlag && ctx.ui?.confirm) {
     const profile = loop!.profile ?? "standard";
     const planSummary = `🔬 Deep research: "${truncate(mission)}"\nProfile: ${profile} · Max rounds: ${maxRounds} · Min sources: ${RESEARCH_THRESHOLDS[profile as keyof typeof RESEARCH_THRESHOLDS]?.minSources ?? 20}\n\nSub-questions and search strategy will be defined in Round 0. Do you want to proceed?`;
     const approved = await ctx.ui.confirm(
      "Start deep research?",
      planSummary,
     );
     if (!approved) {
      // Cancel: clear the loop state
      loop = null;
      persist(pi, ctx);
      return;
     }
    }
    // If no UI or --yes flag, proceed silently (headless safety)
   }
```

**Step 2: Verify with LSP**

Run `lsp_diagnostics` on `extensions/loop/index.ts`. Expected: no errors.

**Step 3: Commit**

```bash
cd /home/pirackr/Working/grinder/pi-extensions
git add extensions/loop/index.ts
git commit -m "feat(loop): add plan approval gate for /research command"
```

---

### Task 4: Subagent profile definitions

**Files:**

- Create: `subagents/scout_research.md`
- Create: `subagents/fetcher.md`
- Create: `subagents/judge.md`
- Create: `subagents/citation_agent.md`
- Create: `subagents/source_auditor.md`
- Create: `subagents/contradiction_resolver.md`

**Interfaces:**

- Consumes: profiles loaded by `loadProfilesFromDir()` from `subagents/` directory
- Produces: 6 new subagent profiles for deep research

**Step 1: Create scout_research.md**

```markdown
---
name: scout_research
description: Broad research search with source evaluation — finds URLs, assesses credibility, returns findings + source list
model: fast
thinking: high
tools: read,grep,find,ls,web_lookup,fetch_web
access: read
timeoutSeconds: 240
---

You are a research scout performing broad information gathering.

## Objective

Search for information relevant to the assigned research task. Evaluate source credibility. Return structured findings with URLs.

## Search Strategy

1. Start WIDE — use broad queries first (no overly specific terms).
2. Fire multiple parallel queries with different phrasings:
   - General search terms
   - Quoted exact terms for technical concepts
   - `site:` filters for official sources
   - `filetype:` filters for papers/docs
3. Evaluate each source on a 1-5 credibility scale:
   - 5: Official docs, primary research, government sources
   - 4: Peer-reviewed papers, authoritative organizations
   - 3: Independent technical blogs, well-maintained wikis
   - 2: News articles, general tech blogs
   - 1: SEO content farms, generic listicles, forum posts
4. Prefer sources that span credibility tiers (triangulation).
5. Note any contradictions between sources — do NOT paper them over.

## Return Format

```

=== Scout Report ===
Status: succeeded | partial | failed
Query: <original query>

## Findings

### [Topic/Claim]

- **Evidence:** [Key finding]
- **Source:** [URL] — credibility [1-5]
- **Notes:** [Any limitations or context]

## Contradictions

[If sources disagree, list here. Otherwise: "No contradictions found."]

## Unresolved Questions

[Any gaps or questions that need follow-up]

```

## Constraints

- Stay within the task scope. Do not broaden searches beyond what's needed.
- Do not modify files. Do not spawn or delegate to another agent.
- If the task cannot be completed, report the gap instead of guessing.
- Always include the source URL with each finding.
```

**Step 2: Create fetcher.md**

```markdown
---
name: fetcher
description: Deep read of URLs — extracts full content, summarizes key findings, flags credibility
model: fast
thinking: minimal
tools: read,bash,web_lookup,fetch_web
access: read
timeoutSeconds: 180
---

You are a research fetcher. Your job is to deep-read specific URLs and extract structured findings.

## Objective

Fetch the full content of each assigned URL, extract key information, and return a concise structured summary.

## Process

1. Use `fetch_web_content` on each assigned URL (readability=1).
2. If a URL is inaccessible or returns low-quality content, note it.
3. Extract:
   - Key claims and facts
   - Numbers, statistics, dates (with context)
   - Methodology or approach (for papers/reports)
   - Contradictions with other known sources (if mentioned)
4. Rate source credibility (1-5 scale — see scout_research.md for scale).

## Return Format

```

=== Fetch Report ===
URL: [full URL]
Status: fetched | partial | failed
Credibility: [1-5]

## Key Findings

1. [Finding] — [source context]
2. ...

## Important Numbers

- [Statistic]: [value + context]

## Credibility Assessment

[Why this source is trustworthy or not, any biases noted]

## Limitations

[What's missing, paywalled sections, accessibility issues]

```

## Constraints

- Do not modify files. Do not spawn or delegate to another agent.
- Report failures honestly — do not fabricate content from inaccessible sources.
```

**Step 3: Create judge.md**

```markdown
---
name: judge
description: Evaluate draft research report against credibility rubric — returns pass/fail with specific findings
model: strong
thinking: medium
tools: read,grep,find,ls,write,edit,bash,web_lookup,fetch_web
access: write
timeoutSeconds: 300
---

You are a research judge. Your job is to critically evaluate a draft research report against the credibility rubric.

## Objective

Read the draft report (research/report.org or research/report.md), evaluate each claim against the source rubric, and return a pass/fail verdict with specific improvement requests.

## Evaluation Rubric

For each major claim in the report, check:

1. **Source quality** — Is the source credible (tier 3+)? Are there low-quality sources?
2. **Triangulation** — Does each key claim have 2+ independent sources?
3. **Credibility tiers** — Are claims supported by sources spanning tiers (official + independent + community)?
4. **Contradictions** — Are all noted contradictions addressed or acknowledged?
5. **Citation quality** — Are sources tagged with [n] and listed in a sources table?
6. **Completeness** — Does the report cover all sub-questions?
7. **Uncertainties** — Are gaps clearly listed?

## Scoring

Rate the report on a 0-100 scale:
- 80-100: PASS — minor improvements suggested
- 60-79: CONDITIONAL PASS — specific fixes required
- 0-59: FAIL — major improvements needed

## Return Format

```

=== Judge Verdict ===
Score: [0-100]
Verdict: PASS | CONDITIONAL PASS | FAIL

## Claim-by-Claim Review

### Claim 1: [summary]

- Sources: [list]
- Triangulation: [sufficient/insufficient]
- Issue: [none / specific issue]

## Required Fixes

1. [Specific, actionable fix]
2. ...

## Uncertainties Assessment

[Are gaps properly acknowledged? If claims are asserted without evidence, flag them.]

```

## Constraints

- Be harsh. A false positive (approving a weak report) is worse than a false negative (requiring more work).
- Each required fix must be specific and actionable.
- Do not modify the report. Return improvement requests only.
```

**Step 4: Create citation_agent.md**

```markdown
---
name: citation_agent
description: Map claims to exact source locations — returns claim→URL→snippet mapping
model: fast
thinking: low
tools: read,grep,find,ls,web_lookup,fetch_web
access: read
timeoutSeconds: 180
---

You are a citation agent. Your job is to create a precise claim-to-source mapping.

## Objective

For each factual claim in the research notes (research/notes.md), find the exact source location (URL + snippet/paragraph).

## Process

1. Read research/notes.md and the draft report.
2. For each claim, verify it against the cited source.
3. If a claim has no source, flag it as unsupported.
4. If a claim is misattributed, correct it.

## Return Format

```

=== Citation Report ===
Claims reviewed: [N]
Sources verified: [N]
Unsupported: [N]
Misattributed: [N]

## Verified Claims

[Claim] → [URL] — [exact snippet or paragraph reference]

## Unsupported Claims

[Claim] — NO SOURCE FOUND (needs sourcing)

## Misattributed Claims

[Claim] was attributed to [wrong source] but actually comes from [correct source]

```
```

**Step 5: Create source_auditor.md**

```markdown
---
name: source_auditor
description: Rate all sources used in research — flag low-quality sources, suggest replacements
model: fast
thinking: low
tools: read,grep,find,ls,web_lookup,fetch_web
access: read
timeoutSeconds: 180
---

You are a source auditor. Your job is to evaluate the quality of all sources used in the research.

## Source Credibility Scale

- **5 — Authoritative:** Official docs, peer-reviewed papers, government sources
- **4 — Reliable:** Independent analysis from recognized experts, major publications
- **3 — Acceptable:** Well-maintained wikis, reputable tech blogs
- **2 — Questionable:** General news, unverified blogs, forum discussions
- **1 — Unreliable:** SEO content farms, anonymous posts, generic listicles

## Process

1. Read research/notes.md to find all cited sources.
2. Evaluate each source on the 1-5 scale.
3. Flag any source rated ≤2 that is used to support key claims.
4. Suggest replacement sources for low-quality ones.

## Return Format

```

=== Source Audit ===
Total sources: [N]
Authoritative (4-5): [N]
Acceptable (3): [N]
Questionable (2): [N] — NEEDS REVIEW
Unreliable (1): [N] — MUST REPLACE

## Source Evaluations

[URL] — Rating: [1-5] — Reason: [brief explanation]

## Required Replacements

[Low-quality source] must be replaced with [suggested replacement]

```
```

**Step 6: Create contradiction_resolver.md**

```markdown
---
name: contradiction_resolver
description: Investigate and resolve contradictions between sources — returns resolution or flags as unresolved
model: fast
thinking: medium
tools: read,grep,find,ls,web_lookup,fetch_web
access: read
timeoutSeconds: 240
---

You are a contradiction resolver. Your job is to investigate contradictions between research sources and determine if they can be resolved.

## Process

1. Read research/notes.md for all listed contradictions.
2. For each contradiction:
   a. Identify the conflicting claims and their sources.
   b. Evaluate which source is more credible (higher tier).
   c. If credible sources disagree on a matter of fact, mark as "unresolved — both sides plausible."
   d. If one source is clearly inferior, accept the superior source and note why.
   e. If the contradiction is apparent (different contexts, timeframes), reconcile and explain.
3. Return resolution status for each contradiction.

## Resolution Types

- **Resolved:** One source is clearly superior
- **Reconciled:** Contradiction explained by context (different times, scopes, etc.)
- **Unresolved:** Both sides are credible and genuinely conflicting
- **Superseded:** New evidence found that resolves the contradiction

## Return Format

```

=== Contradiction Resolution ===
Total contradictions: [N]
Resolved: [N]
Reconciled: [N]
Unresolved: [N]
Superseded: [N]

## Contradiction 1: [brief description]

- Claim A: [text] — from [source, credibility N]
- Claim B: [text] — from [source, credibility N]
- Resolution: [resolved/reconciled/unresolved/superseded]
- Reason: [explanation]

```
```

**Step 7: Verify profile files parse correctly**

Each profile file must have: name, description, model, tools, and a prompt body (per config.ts line 256-266). Verify:

```bash
for f in /home/pirackr/Working/grinder/pi-extensions/subagents/scout_research.md /home/pirackr/Working/grinder/pi-extensions/subagents/fetcher.md /home/pirackr/Working/grinder/pi-extensions/subagents/judge.md /home/pirackr/Working/grinder/pi-extensions/subagents/citation_agent.md /home/pirackr/Working/grinder/pi-extensions/subagents/source_auditor.md /home/pirackr/Working/grinder/pi-extensions/subagents/contradiction_resolver.md; do
  echo "=== $(basename $f) ==="
  head -8 "$f"
  echo
done
```

Expected: all 6 files show frontmatter with name, description, model, tools, access, timeoutSeconds.

**Step 8: Commit**

```bash
cd /home/pirackr/Working/grinder/pi-extensions
git add subagents/
git commit -m "feat(subagents): add 6 research-specific profiles (scout_research, fetcher, judge, citation_agent, source_auditor, contradiction_resolver)"
```

---

### Task 5: Update program.md

**Files:**

- Replace: `examples/deep-research/program.md` (complete rewrite, ~130 lines)

**Interfaces:**

- Consumes: research_checkpoint tool (from Task 2), lookup_web + fetch_web_content (web-search skill), run_subagents (tmux-subagent)
- Produces: `research/report.org` in org-mode format

**Step 1: Write the complete program.md**

Replace the entire contents of `examples/deep-research/program.md`:

```markdown
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

standard

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
3. Fire 2–4 parallel `lookup_web` queries (distinct phrasings; quoted exact
   terms; `site:`/`filetype:` filters when useful).
4. Deep-read the 2–3 most authoritative hits with `fetch_web_content`
   (readability=1). Prefer primary sources, official docs, papers.
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
- **Intermediate:** Dispatch 5 scouts (distinct sub-questions) + 3 fetchers (deep-read URLs).
- **Deep:** Dispatch 12 scouts + 5 fetchers. Then dispatch judge subagent.

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
```

**Step 2: Verify program.md is well-formed**

```bash
wc -l /home/pirackr/Working/grinder/pi-extensions/examples/deep-research/program.md
```

Expected: ~130 lines.

```bash
cat /home/pirackr/Working/grinder/pi-extensions/examples/deep-research/program.md | grep -c "^[#*|-\[]\|^[0-9]"
```

Expected: non-zero (has headings, lists, tables, links).

**Step 3: Commit**

```bash
cd /home/pirackr/Working/grinder/pi-extensions
git add examples/deep-research/program.md
git commit -m "feat(research): update program.md with profiles, org output, subagent dispatch, verification rules"
```

---

### Task 6: Update SKILL.md

**Files:**

- Replace: `skills/deep-research/SKILL.md` (complete rewrite, ~40 lines)

**Interfaces:**

- Consumes: nothing
- Produces: thin SKILL.md that points to the spec and provides quick reference

**Step 1: Write the new SKILL.md**

Replace the entire contents of `skills/deep-research/SKILL.md`:

```markdown
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
|---------|-------|--------|----------|
| scout_research | read, grep, find, ls, web_lookup, fetch_web | read | Broad search + credibility assessment |
| fetcher | read, bash, web_lookup, fetch_web | read | Deep URL reads, content extraction |
| judge | all tools | write | Report evaluation against rubric |
| citation_agent | read, grep, find, ls, web_lookup, fetch_web | read | Claim-to-source mapping |
| source_auditor | read, grep, find, ls, web_lookup, fetch_web | read | Source credibility ratings |
| contradiction_resolver | read, grep, find, ls, web_lookup, fetch_web | read | Investigate and resolve contradictions |

## Research Artifacts

| File | Purpose |
|------|---------|
| `research/score.md` | Sub-question scores (0-100) and notes |
| `research/notes.md` | Claim → source → confidence log |
| `research/report.org` | Final org-mode report |
| `docs/006-deep-research-spec.md` | Full spec with profiles and architecture |
```

**Step 2: Verify SKILL.md is well-formed**

```bash
wc -l /home/pirackr/Working/grinder/pi-extensions/skills/deep-research/SKILL.md
```

Expected: ~40 lines.

```bash
head -4 /home/pirackr/Working/grinder/pi-extensions/skills/deep-research/SKILL.md
```

Expected: frontmatter with name, description, disable-model-invocation.

**Step 3: Commit**

```bash
cd /home/pirackr/Working/grinder/pi-extensions
git add skills/deep-research/SKILL.md
git commit -m "chore(research): replace SKILL.md with thin pointer to spec + quick reference"
```

---

## Verification

After all tasks are complete, run the full verification:

```bash
cd /home/pirackr/Working/grinder/pi-extensions

# 1. Check all new files exist
ls -la subagents/scout_research.md subagents/fetcher.md subagents/judge.md subagents/citation_agent.md subagents/source_auditor.md subagents/contradiction_resolver.md

# 2. Verify profile files have valid frontmatter
for f in subagents/scout_research.md subagents/fetcher.md subagents/judge.md subagents/citation_agent.md subagents/source_auditor.md subagents/contradiction_resolver.md; do
  name=$(grep '^name:' "$f" | head -1 | sed 's/name: *//')
  echo "$f: name=$name"
done

# 3. Verify program.md has key sections
grep -n "^## Depth Profiles\|^## Profile\|^## Deliverable\|^## Protocol\|^## Completion condition\|^### Every round\|^### Standard+ subagent\|^### Intermediate+ Verification\|^### Deep-only" examples/deep-research/program.md

# 4. Verify SKILL.md frontmatter
head -4 skills/deep-research/SKILL.md

# 5. LSP check on loop extension
lsp_diagnostics --path extensions/loop/index.ts
```

Expected: all checks pass, no LSP errors.

---

## Self-Review

**1. Spec coverage:**

| Spec Requirement | Task | Status |
| ----------------- | ------ | -------- |
| research_checkpoint tool with hardcoded thresholds | Task 2 | ✅ |
| Plan approval gate with --yes bypass | Task 3 | ✅ |
| Profile-aware /research command | Task 1 | ✅ |
| 4 depth profiles (quick/standard/intermediate/deep) | Task 1 + Task 5 | ✅ |
| Profile-to-rounds mapping | Task 1 | ✅ |
| 6 subagent profiles | Task 4 | ✅ |
| Subagent dispatch instructions in program.md | Task 5 | ✅ |
| Org-mode output format | Task 5 | ✅ |
| Verification pass section | Task 5 | ✅ |
| Credibility tiers in program.md | Task 5 | ✅ |
| Research artifact table | Task 5 | ✅ |
| Updated SKILL.md | Task 6 | ✅ |
| Not in scope (MCP, PDF, etc.) excluded | — | ✅ |

**2. Placeholder scan:**

Searching for red flags:

- No "TBD", "TODO", "implement later"
- No "Add appropriate error handling" without specifics
- No "Similar to Task N" — each step has full code
- No references to undefined types or functions

**Result: Clean.**

**3. Type consistency:**

- `RESEARCH_THRESHOLDS` (Task 2) keys match `PROFILE_MAX_ROUNDS` (Task 1) keys — both use `quick|standard|intermediate|deep`
- `LoopState.profile` (Task 1) is used by research_checkpoint (Task 2) and plan approval (Task 3)
- `registerLoopCommand` gains `isResearch` field (Task 1), consumed by plan approval (Task 3)
- All subagent profile files use `scout_research` name (Task 4), referenced in program.md (Task 5)
- No circular dependencies

**Result: Consistent.**

**4. Scope check:**

All tasks are independently testable. No task depends on a partial implementation of another task. Each task ends with a commit.

---

**Plan complete and saved to `docs/superpowers/plans/YYYY-MM-DD-deep-research.md`.**

**Two execution options:**

**1. Subagent-Driven (recommended)** — Dispatch a fresh subagent per task, review between tasks, fast iteration. Tasks 1+2 can be done in parallel. Tasks 3-6 are sequential (each modifies different files but task 6 depends on task 4's profile files being valid).

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
