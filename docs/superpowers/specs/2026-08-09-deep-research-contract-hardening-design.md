# Deep Research Contract Hardening — Design Spec

**Date:** 2026-08-09

## Goal

Make the deep-research program an executable, lossless, and code-enforced contract. The coordinator must receive enough structured information to choose the next action without carrying full research reports in context. A run may be marked complete only after its report and profile-specific verification checks pass.

## Scope

This design covers:

- durable subagent result export;
- actionable coordinator summaries;
- explicit and overrideable research configuration;
- research-specific agent ownership;
- override-aware checkpoint behavior;
- profile-specific verification and completion gates;
- cap handling, repair flow, org-mode consistency, tests, and documentation migration.

It does not replace the generic `worker` profile, create a research database, introduce project-controlled privilege overrides, or move research methodology into TypeScript.

## Architecture

The research working directory is the durable boundary for one run:

```text
<research-dir>/
├── score.md
├── notes.md
├── report.org
├── fragments/
│   └── findings-<n>.org
├── scout-outputs/
│   ├── <round>-<slug>-scout.md
│   └── <round>-<slug>-fetch.md
└── verification/
    ├── judge.json
    ├── citations.json
    ├── sources.json
    └── contradictions.json
```

Temporary `/tmp/pi-subagent-*` JSONL transcripts remain debugging artifacts. They are not research inputs and are not required for later rounds.

### Durable task results

`run_subagents` gains an optional `result_path` on each task. When it is supplied, the response contains a coordinator-summary block and a separate artifact block. After a successful child process finishes, the tool atomically writes only the complete artifact payload to `result_path`; summary metadata never contaminates Markdown, org, or JSON artifacts. It writes a temporary sibling file and renames it only after the payload is durable. An export failure changes the task to failed; downstream consolidation must not proceed.

Research tasks that produce durable artifacts use absolute `result_path` values under the active research directory:

- scouts and fetchers write full Markdown reports to `scout-outputs/`;
- synthesis workers write org fragments to `fragments/`;
- verification agents write strict JSON to `verification/`.

The consolidator reads complete exported reports rather than coordinator-visible digests. This removes the current summary-truncation data loss.

## Actionable Coordinator Summary

`return_mode: "summary"` no longer means “return the first 600 characters.” Every subagent used in summary mode must return this block:

```text
<coordinator-summary>
Status: succeeded | partial | blocked | failed
Outcome: one-sentence result
Evidence added: count or none
Key changes: up to 3 concise items
Contradictions/blockers: concise list or none
Recommended next action: one concrete action
</coordinator-summary>
```

When a task supplies `result_path`, it must also return a separate artifact block:

```text
<artifact>
Complete durable report, org fragment, or strict JSON payload
</artifact>
```

Verification agents include their verdict, failed checks, and required fixes in the summary fields. Their artifact block contains only schema-valid JSON.

`run_subagents` always validates the coordinator-summary block. When `result_path` is supplied, it also validates the artifact block and writes that block's exact payload to the path. Its summary response contains:

- agent/profile and execution state;
- the complete coordinator-summary envelope;
- durable `result_path`, when supplied;
- token and tool usage.

A missing or malformed required block fails the task. There is no truncation fallback: orchestration must not continue using inadequate information. When exported, the durable payload remains available at `result_path`, while the coordinator uses only the summary envelope to select the next action. The raw combined response exists only in retained debugging transcripts.

## Configuration Ownership

Operational configuration moves out of `program.v2.md` into `config/deep-research.json`. The program remains a methodology and artifact-contract document.

### Configuration contents

The JSON configuration owns:

- default profile;
- profile minimum rounds, maximum rounds, minimum sources, and dispatch caps;
- default per-agent web-search and fetch limits;
- score threshold and retry policy;
- profile-specific verification matrix;
- logical research roles and their agent profiles;
- research-agent descriptions, models, thinking levels, tools, access, timeouts, prompt paths, and output formats.

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
    }
  },
  "agents": {
    "scout": {
      "description": "Discover and evaluate sources",
      "model": "strong",
      "thinking": "high",
      "tools": ["read", "web_lookup", "fetch_web"],
      "access": "read",
      "timeoutSeconds": 1800,
      "promptPath": "../skills/deep-research/agents/scout.md",
      "resultFormat": "markdown"
    }
  }
}
```

The full file defines quick, standard, intermediate, and deep profiles and every logical role used by the program.

### Research-agent files

Research-specific prompts move out of the global `subagents/` directory:

```text
skills/deep-research/agents/
├── planner.md
├── scout.md
├── fetcher.md
├── judge.md
├── citation-agent.md
├── source-auditor.md
└── contradiction-resolver.md
```

The generic global `worker` remains the implementation profile for consolidation, fragment writing, and assembly. The research configuration references it rather than duplicating it.

Long prompts remain readable Markdown; the JSON file references them and owns their machine-readable runtime profile. The loader validates unknown fields, prompt paths, models, thinking levels, available tools, access requirements, timeouts, limits, role references, verification-role availability, and result formats.

### Overrides

Configuration precedence is:

1. packaged `config/deep-research.json`;
2. per-Pi-instance `$PI_AGENT_DIR/deep-research/config.json`;
3. per-run CLI flags.

The user override is deep-merged with packaged defaults and then fully revalidated. Prompt paths from the override resolve relative to that override file. This permits an installed Pi instance to customize models, profiles, agents, prompts, and limits without changing package files.

Project repositories do not automatically override agent tools or access. This prevents an untrusted project from escalating child-agent privileges.

## Command Interface

The supported resource controls are explicit CLI options:

```text
/research "XYZ" --profile deep \
  --max-searches-per-agent 100 \
  --max-fetches-per-agent 50
```

Both new options are optional; their defaults come from `config/deep-research.json`. `0` means unlimited. Each value is propagated as the hard per-process budget for every web-capable research or verification agent.

Existing options remain supported, including `--profile`, `--max-rounds`, and `--tokens`.

Before approval, `/research` displays all resolved operational values:

- profile;
- minimum and maximum rounds;
- minimum source target;
- scout/fetch dispatch caps;
- per-agent search and fetch limits;
- verification suite;
- token budget;
- output directory.

No runtime cap remains implicit in `program.v2.md`.

## Research Protocol

### Round 0

Round 0 is planning only. A planner creates five to eight sub-questions and initializes `score.md`. It does not call the 1-indexed `research_checkpoint`.

`score.md` uses one strict table contract so the checkpoint can validate quality without interpreting prose:

```text
| ID | Question | Score | Notes |
| --- | --- | ---: | --- |
| q1 | ... | 0 | ... |
```

It contains five to eight unique IDs and integer scores from 0 through 100. A malformed table fails the checkpoint with a repair instruction.

### Research rounds

Every research round is sequential because the configured `run_subagents` task limit is one:

1. Read `score.md` and select the weakest sub-question.
2. Dispatch one scout at a time with a unique durable result path.
3. Dispatch fetchers only for primary URLs capable of changing an answer.
4. Run one consolidator over the new complete scout/fetch files.
5. Use the consolidator's structured summary to choose the next action.
6. Call `research_checkpoint` once for the completed research round.

Profile scout and fetch counts are dispatch caps. Synthesis and verification dispatches are accounted for separately and are not misleadingly included as one “synth” task.

### Synthesis and repair

After checkpoint progression permits synthesis:

1. Fragment workers write findings sequentially.
2. The assembler writes one valid org-mode report.
3. Profile-required verification agents run sequentially.
4. Any failed check produces a structured repair list.
5. Affected fragment writers rerun with the repair list.
6. The assembler reruns.
7. Every verification check whose input changed reruns.
8. Completion is attempted only when every required check passes.

All report producers and verifiers use inline `[[URL][description]]` citations. The report structure uses valid `*`, `**`, and `***` org headings. Judge and citation rubrics use the same citation contract.

## Checkpoint Semantics

`research_checkpoint` uses the active run's effective maximum round count instead of the profile's packaged maximum when `--max-rounds` overrides it.

- Profile minimum rounds, sources, and the configured per-question score threshold remain quality floors.
- The checkpoint parses `score.md` and requires every sub-question to meet the score threshold unless the effective maximum round is reached.
- Reaching a lower user-supplied cap returns `PROCEED_WITH_GAPS` so a best-effort report can be synthesized while preserving explicit uncertainty.
- A higher cap permits continued research when source or quality floors remain unmet.
- A successful checkpoint is recorded in persisted loop state.
- Starting another research round invalidates the recorded checkpoint.

Completion cannot rely on a checkpoint from stale evidence.

## Verification Matrix

| Profile | Required passing artifacts |
| --- | --- |
| Quick | `judge.json` |
| Standard | `judge.json` |
| Intermediate | `judge.json`, `citations.json`, `sources.json` |
| Deep | all intermediate artifacts plus `contradictions.json` |

Each verification file has a versioned strict JSON schema and an explicit `pass` boolean. Required outcome rules are:

- judge verdict is `PASS`;
- citation verification reports no unsupported or misattributed claims;
- source audit reports no unresolved required replacements;
- contradiction verification reports no unhandled contradiction. A genuine unresolved disagreement passes only when the verification artifact identifies where it is explicitly acknowledged in `report.org`.

Malformed files fail verification rather than being interpreted heuristically.

## Completion and Cap Handling

For an active `/research`, `complete_loop` requires:

1. the latest checkpoint belongs to the current run and remains valid;
2. that checkpoint returned `PROCEED` or `PROCEED_WITH_GAPS`;
3. `report.org` exists and is non-empty;
4. every profile-required verification artifact parses and passes;
5. verification artifacts identify the current run.

The engine validates these conditions directly. File existence alone is insufficient.

If a round or token cap stops a run before these gates pass, the run remains `budget_limited`. Existing partial artifacts are preserved, but `complete_loop` is not called and the run is not represented as successful. A partial `report.org` may exist without changing that status.

## Error Handling

- **Missing/malformed coordinator summary:** fail the task and retry once with the format requirement emphasized.
- **Result export failure:** fail the task; do not consolidate or verify it.
- **Scout/fetch failure:** preserve successful sibling outputs and retry only the failed scope.
- **Consolidator failure:** retry idempotently over the same explicit input files before checkpointing.
- **Verification failure:** preserve diagnostics, repair affected fragments, reassemble, and rerun invalidated checks.
- **Malformed verification JSON:** treat as failed verification and retry the verifier once.
- **Cap reached:** preserve partial work and remain `budget_limited`.
- **Invalid packaged or user configuration:** reject `/research` before creating or replacing an active run, with the exact field and validation error.

## Program Content Boundary

`program.v2.md` keeps judgment-heavy methodology:

- broad-to-narrow query strategy;
- source credibility and UGC treatment;
- triangulation requirements;
- contradiction handling;
- report structure and org formatting;
- notes-pruning and uncertainty guidance.

It no longer owns:

- profile thresholds or defaults;
- search/fetch budgets;
- task timeouts;
- agent names, descriptions, tools, models, or access;
- dispatch counts;
- retention/return-mode settings;
- verification matrices;
- completion enforcement claims not implemented by the engine.

## Testing

Automated coverage includes:

1. packaged configuration loading and strict schema validation;
2. user deep-merge precedence and relative prompt resolution;
3. CLI parsing and propagation of per-agent search/fetch limits;
4. access/tool validation for configured research agents;
5. atomic result export, export failure, and cleanup behavior;
6. valid coordinator-summary extraction;
7. missing and malformed summary failures;
8. override-aware checkpoint behavior;
9. stale-checkpoint invalidation after another round;
10. versioned verification JSON parsing and profile-specific gates;
11. rejection of completion for failed/missing verification or report files;
12. successful completion after all gates pass;
13. preservation of `budget_limited` for capped incomplete runs;
14. valid org heading/citation contract in generated instructions;
15. a contract test preventing operational configuration from returning to `program.v2.md`.

Existing loop and tmux-subagent tests remain green. New behavior follows test-driven implementation, including failure-first tests for each contract defect.

## Migration

1. Add and validate `config/deep-research.json`.
2. Add the user override loader.
3. Move research-specific profiles to `skills/deep-research/agents/`; retain global `worker`.
4. Add durable `result_path` and structured summary enforcement to `run_subagents`.
5. Add CLI resource-limit flags and resolved-config display.
6. Make checkpoint state override-aware and persistent.
7. Add strict verification schemas and completion gates.
8. Rewrite `program.v2.md` around logical roles, sequential dispatch, durable outputs, repair loops, and valid org formatting.
9. Update `docs/006-deep-research-spec.md` and affected tests/documentation.

Existing `/research` invocations continue to work because new flags are optional and packaged defaults are complete.
