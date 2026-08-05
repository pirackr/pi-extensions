# Implementation Plan: Deep Research — Subagent-Heavy Research Engine

> Design spec: `docs/006-deep-research-spec.md`
> Basis: `docs/004-deep-research-loop-poc.md`, `docs/002-deep-research-notes.md`,
> `docs/003-implement-loop.org`, `docs/005-deep-research-research.org` (20 sources)
> Pattern: thin orchestration + let the model drive (the bitter lesson)
> Subagent-heavy: program.md declares roles, /loop dispatches, subagents do specialized work

---

## 1. Scope

Build the research tooling that turns the existing `/loop` engine + `program.md` methodology into a full subagent-driven deep research system:

- **research_checkpoint tool** — code-enforced floor against early stopping
- **Plan approval gate** — scope confirmation before tokens are spent
- **Profile-aware thresholds** — /research reads profile settings from program.md
- **Updated program.md** — new profiles (quick/standard/intermediate/deep), org output, verification rules, subagent dispatch instructions
- **Updated SKILL.md** — replaced with a pointer to the spec
- **Web-search skill reformatting** — lint cleanup (auto-fixed)

### Not in scope (v1)

- MCP integration
- PDF export
- Mermaid mind maps
- JSONL audit log
- Tavily API support (deferred to web-search skill enhancement)

---

## 2. Existing Infrastructure (DO NOT MODIFY)

These are already built and working. The plan builds ON TOP of them:

| Component | File | What it does |
| ----------- | ------ | -------------- |
| `/loop` engine | `extensions/loop/index.ts` (691 lines) | Continuation loop, round/token accounting, pause/resume/clear, complete_loop, no-progress detection, stale-turn guard |
| `/research` front-end | Same file (lines 546-554) | Plugs into /loop with bundled program.md and max-rounds=6 |
| tmux-subagent dispatch | `extensions/tmux-subagent/index.ts` (691 lines) | `run_subagents` tool — spawns isolated Pi agents in tmux windows, polls results |
| tmux-subagent profiles | `extensions/tmux-subagent/config.ts` (373 lines) | Agent profiles (reviewer, scout, tester, worker) with model/tools/thinking settings |
| web-search skill | `extensions/web-search/index.ts`, `search.ts`, `strategies/readability.ts` | `lookup_web` + `fetch_web_content` tools — DuckDuckGo + Exa engines, Readability extraction |
| program.md | `examples/deep-research/program.md` | Research methodology file (needs updating) |

---

## 3. Implementation Tasks

### Task 1: `research_checkpoint` tool (~40 lines)

**File:** `extensions/loop/index.ts` — add to the `piLoop` export function.

**What:** A code-enforced tool that prevents premature conclusion. Reads thresholds from program.md, evaluates min_rounds/min_sources/max_rounds, returns CONTINUE/PROCEED verdict.

**Why it belongs in loop/index.ts (not a new file):**

- The spec says the tool lives in the extension (Section 6.1)
- It operates on the existing `loop` state and the program file
- It's the one piece of task-specific code the spec allows in the /loop extension
- It follows the existing pattern: tools are registered in `piLoop()` alongside `complete_loop`

**Implementation:**

```typescript
// Add to piLoop() function, after the complete_loop tool registration (around line 535)

// research_checkpoint tool — code-enforced floor against early stopping
const profileThresholds = {
  quick:    { minRounds: 10, minSources: 15, maxRounds: 10 },
  standard: { minRounds: 6,  minSources: 20, maxRounds: 6 },
  intermediate: { minRounds: 8, minSources: 30, maxRounds: 8 },
  deep: { minRounds: 10, minSources: 40, maxRounds: 10 },
};

pi.registerTool({
  name: "research_checkpoint",
  label: "Research Checkpoint",
  description: "MANDATORY after each search round. Returns CONTINUE or PROCEED based on code-enforced thresholds read from the active program.md.",
  parameters: Type.Object({
    profile: Type.String({
      description: "Research profile: quick | standard | intermediate | deep",
    }),
    round: Type.Number({
      description: "Current round number (1-indexed)",
    }),
    totalSources: Type.Number({
      description: "Number of unique sources collected so far",
    }),
    contradictions: Type.Optional(
      Type.Array(Type.String(), {
        description: "List of unresolved contradictions",
      })
    ),
  }),
  async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
    const p = params as {
      profile?: string;
      round?: number;
      totalSources?: number;
      contradictions?: string[];
    };
    const profile = p.profile ?? "standard";
    const thresholds = profileThresholds[profile as keyof typeof profileThresholds];
    if (!thresholds) {
      return {
        content: [{ type: "text", text: `Unknown profile "${profile}".` }],
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
    return {
      content: [
        {
          type: "text",
          text: issues.length
            ? `🔴 CONTINUE — ${issues.join("; ")}`
            : `🟢 PROCEED — criteria met.`,
        },
      ],
    };
  },
});
```

**Notes:**

- Thresholds are hardcoded in the extension (matching the spec Section 6.1)
- The program.md also stores thresholds for the agent's reference — they must match
- If they diverge, the extension's version wins (code-enforced)
- The `contradictions` parameter is accepted but not yet evaluated — it's a future enhancement

**Validation:**

- Call with `quick` profile, round 5, sources 10 → 🔴 CONTINUE (min rounds: 5/10, min sources: 10/15)
- Call with `standard` profile, round 6, sources 25 → 🟢 PROCEED
- Call with `deep` profile, round 10, sources 35 → 🟢 PROCEED (max rounds)
- Call with unknown profile → error

---

### Task 2: Plan approval gate (~15 lines)

**File:** `extensions/loop/index.ts` — modify the research command handler.

**What:** Before the first continuation round, show the user a plan summary and require confirmation (unless `--yes` flag is used).

**Current code:** The research command handler starts the loop immediately at line 474: `emit(pi, "active", loop, { triggerTurn: ctx.isIdle() })`.

**Modification:** Add a confirmation step between loop state initialization (line 457-472) and emission (line 474), but only for the `/research` command (not `/loop`).

**Implementation approach:**

- Detect `command === "research"` in the handler
- Before emitting the first continuation, show plan summary
- If `ctx.ui.confirm()` available: show summary, wait for confirm/modify/cancel
- If `--yes` flag present: skip confirmation
- If no UI and no `--yes`: proceed (headless safety)
- The plan summary includes: sub-questions (if available), profile, estimated cost

**Concrete changes in the handler (after line 472, before line 474):**

```typescript
// For /research: show plan approval gate
if (cmd === "research") {
  const yesFlag = args.includes("--yes") || args.includes("--no-confirm");
  if (!yesFlag && ctx.ui.confirm) {
    const planSummary = `🔬 Deep research: "${truncate(mission)}"\nProfile: ${profile}\nRounds: ${maxRounds} max · Min sources: ${minSources}\n\nSub-questions will be defined in the first round. Do you want to proceed?`;
    const approved = await ctx.ui.confirm("Start research?", planSummary);
    if (!approved) {
      return;
    }
  }
}
```

**Notes:**

- The profile and minSources come from parsing program.md's Depth Profiles section
- If program.md can't be parsed or doesn't have Depth Profiles, default to standard (6 rounds, 20 sources)
- The plan summary is a preview — the actual sub-questions are written in Round 0
- This is the "cheapest waste-prevention" gate (002 §3.8)

**Profile parsing:** Need a small helper to extract profile/min_sources from program.md:

```typescript
function parseProfileThresholds(program: string): { profile: string; minRounds: number; minSources: number } {
  // Extract "## Depth Profiles" section, parse key=value lines
  // Default to standard if not found
  const defaultProfile = { profile: "standard", minRounds: 6, minSources: 20 };
  // ... regex parsing of program.md
  return defaultProfile;
}
```

**Validation:**

- `--yes` flag → no confirmation dialog
- No `--yes`, has UI → confirmation dialog appears
- No `--yes`, no UI → proceeds (headless safety)
- User cancels → loop does not start

---

### Task 3: Profile-aware /research command

**File:** `extensions/loop/index.ts` — modify the research command registration.

**What:** Add `--profile` flag to `/research`, parse profile thresholds from program.md, set appropriate `maxRounds` and pass profile info to research_checkpoint.

**Current code:** Line 546-554:

```typescript
registerLoopCommand(pi, {
  command: "research",
  description: "Deep research...",
  defaultProgram: RESEARCH_PROGRAM_PATH,
  defaultMaxRounds: RESEARCH_MAX_ROUNDS, // hardcoded to 6
});
```

**Modification:** Create a separate registration function for /research that:

1. Adds `--profile` flag parsing
2. Parses program.md for profile thresholds
3. Sets maxRounds based on profile
4. Passes profile info through state (or makes it available to research_checkpoint)

**State change:** Need to add `profile` field to `LoopState` interface:

```typescript
interface LoopState {
  // ... existing fields
  profile?: string; // research profile: quick/standard/intermediate/deep
}
```

**Profile-to-rounds mapping:** The spec defines:

- quick: 10 rounds
- standard: 6 rounds
- intermediate: 8 rounds
- deep: 10 rounds

**Implementation:**

```typescript
const PROFILE_MAX_ROUNDS = {
  quick: 10,
  standard: 6,
  intermediate: 8,
  deep: 10,
};

// In the research handler:
let profile = "standard";
if (flags.profile) {
  const p = flags.profile;
  if (PROFILE_MAX_ROUNDS[p as keyof typeof PROFILE_MAX_ROUNDS]) {
    profile = p;
  } else {
    ctx.ui.notify(`Unknown profile: ${p}. Use quick/standard/intermediate/deep.`, "warning");
    return;
  }
}
const maxRounds = flags["max-rounds"]
  ? Number(flags["max-rounds"])
  : PROFILE_MAX_ROUNDS[profile as keyof typeof PROFILE_MAX_ROUNDS];
```

**Notes:**

- `--max-rounds` flag still overrides profile default (user can manually set rounds)
- The profile field in LoopState is used by research_checkpoint to know which thresholds to apply

---

### Task 4: Update program.md

**File:** `examples/deep-research/program.md`

**What:** Rewrite the program file to match the spec — new profiles, org output format, verification rules, subagent dispatch instructions.

**Current state:** 82 lines, markdown report, no profiles, no subagent instructions, research_checkpoint is optional.

**Changes needed:**

1. Output: `research/report.md` → `research/report.org` (org-mode)
2. Add `## Depth Profiles` section with all 4 profiles
3. Add `## Profile` section with `standard` as default
4. Add subagent dispatch instructions (rounds 1+ for standard+, fetch for intermediate+)
5. Add `## Verification Pass` section (self-judge for quick/standard, judge subagent for intermediate/deep)
6. Add CitationAgent, SourceAuditor, ContradictionResolver dispatch rules for deep
7. Add credibility tiers matching the spec
8. Add profile-specific min_sources thresholds

**The updated program.md should be a complete, self-contained research program that:**

- Works with the existing /loop engine (no /loop code changes needed for program.md format)
- Uses the `lookup_web` and `fetch_web_content` tools from web-search skill
- Uses `run_subagents` tool from tmux-subagent extension
- Uses `research_checkpoint` tool (which we add in Task 1)
- Produces org-mode output

**This is a large edit — ~120-150 lines for the new program.md.**

---

### Task 5: Update SKILL.md

**File:** `skills/deep-research/SKILL.md`

**What:** Replace the old 6-stage pipeline spec with a thin pointer to the new spec.

**Current state:** 3610 bytes, references prefilter→research→synthesis→verification→repair→judge pipeline.

**New content:** A short SKILL.md that:

1. References `docs/006-deep-research-spec.md` as the full spec
2. Contains the quick-reference program.md template (the most important part)
3. Lists available subagent profiles (scout, fetcher, judge, etc.)
4. Links to profile definitions

**Alternative:** Delete the file entirely and let the program.md be the primary artifact. The spec says "this replaces the old SKILL.md draft" — so deleting is valid. But having a thin SKILL.md that points to the spec is helpful for discoverability (the agent can find it via system prompt).

**Decision:** Keep a thin SKILL.md (~200 lines) that acts as a launcher and quick reference.

---

### Task 6: Subagent profile definitions (tmux-subagent config)

**File:** `extensions/tmux-subagent/config.ts`

**What:** Add new subagent profiles for deep research: scout, fetcher, judge, citation_agent, source_auditor, contradiction_resolver.

**Current profiles:** reviewer, scout, tester, worker (defined in config.ts).

**New profiles needed:**

- `scout` — broad search, evaluate results, return findings + URLs
- `fetcher` — deep read of URLs, extract content, return summary
- `judge` — evaluate draft report against rubric, return verdict
- `citation_agent` — map claims to exact source locations
- `source_auditor` — rate sources, flag low-quality ones
- `contradiction_resolver` — investigate and resolve contradictions

**Implementation:** Add profile definitions to the config. These profiles need:

- `name` — profile name
- `description` — what the agent does
- `model` — which model to use (prefer cheaper/fast models for subagents)
- `tools` — tool restrictions (search/fetch only for scouts and fetchers; all tools for judge)
- `thinking` — thinking level (minimal for scouts, moderate for judge)

**Notes:**

- Scout and fetcher subagents should have restricted tools (search/fetch only)
- Judge subagent can use all tools since it needs to read/write files
- The coordinator (main agent) uses all tools — no restriction needed

---

## 4. Task Dependencies & Order

```
Task 1 (research_checkpoint) — no dependencies, can do first
Task 3 (profile-aware /research) — depends on Task 1 (profile thresholds)
Task 2 (plan approval gate) — can be done in parallel with Task 1
Task 6 (subagent profiles) — no dependencies, can be done in parallel
Task 4 (update program.md) — depends on Task 1 (checkpoint tool exists)
Task 5 (update SKILL.md) — no dependencies, can be done last
```

**Recommended order:**

1. Task 1: research_checkpoint tool (core enforcement, enables the rest)
2. Task 3: Profile-aware /research (pairs with Task 1)
3. Task 2: Plan approval gate (independent, good to have early)
4. Task 6: Subagent profile definitions (needed before program.md references them)
5. Task 4: Update program.md (depends on Tasks 1, 3, 6)
6. Task 5: Update SKILL.md (cleanup, can be done anytime)

---

## 5. Files Modified Summary

| File | Lines Changed | Nature |
| ------ | --------------- | -------- |
| `extensions/loop/index.ts` | ~80 lines added, ~10 lines modified | Add research_checkpoint tool, plan approval gate, profile parsing |
| `examples/deep-research/program.md` | ~120 lines replaced | New profiles, org output, verification rules, subagent dispatch |
| `skills/deep-research/SKILL.md` | ~180 lines replaced (net) | Thin pointer to spec + quick reference |
| `extensions/tmux-subagent/config.ts` | ~60 lines added | New subagent profiles for research |

**Total: ~250 lines of new code, ~130 lines replaced.**

---

## 6. Testing Strategy

Each task has its own testable unit:

### Task 1 tests

- Call research_checkpoint with each profile, verify CONTINUE/PROCEED verdicts
- Call with unknown profile, verify error
- Call at max rounds, verify PROCEED with gap flag

### Task 2 tests

- Call /research without --yes, with UI → confirm dialog appears
- Call /research --yes → no dialog
- Cancel dialog → loop does not start

### Task 3 tests

- Call /research --profile quick → maxRounds = 10
- Call /research --profile deep → maxRounds = 10
- Call /research --profile invalid → error message
- Call /research --max-rounds 3 (overrides profile) → maxRounds = 3

### Task 4 tests

- Run /research with updated program.md → produces research/report.org
- Report contains org-mode formatting (*, **, |, etc.)
- Verification pass instructions are followed by agent

### Task 5 tests

- Agent loads SKILL.md, finds pointer to spec
- Quick reference is accessible

### Task 6 tests

- Run subagents with new profile names → succeeds
- Scout profile has restricted tools
- Judge profile has full tools

---

## 7. Risks & Mitigations

| Risk | Likelihood | Impact | Mitigation |
| ------ | ----------- | -------- | ------------ |
| research_checkpoint thresholds conflict with program.md | Medium | High | Hardcode thresholds in extension (source of truth); program.md mirrors them |
| Plan approval dialog blocks headless runs | Low | Medium | --yes flag skips; headless fallback proceeds |
| Subagent profiles clash with existing configs | Low | Low | New names (scout_research, fetcher_research, etc.) if needed |
| program.md too complex for agent to follow | Medium | Medium | Keep instructions concise; test with real runs |
| Token budget exceeded on deep profile | High | Low | --max-rounds and --tokens flags still work as caps |
