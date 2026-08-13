# Research — Feature Spec (authoritative)

> **Status: authoritative.** Supersedes `docs/001-deep-research.org`,
> `docs/002-deep-research-notes.md`, `docs/004-deep-research-loop-poc.md`,
> `docs/005-deep-research-techniques.org`, and
> `docs/007-early-research-for-websearch.org` (each marked SUPERSEDED).
> Matches the implementation on `research-loop-refactor` (Tasks 1–14).
>
> The old `extensions/deep-research/`, `config/deep-research.json`, and
> `skills/deep-research/` are deleted. The feature is now one generic loop
> engine (`/loop`) with `/research` as a preset and policy over it, owned by
> `extensions/research/` and configured by `config/research.json`.

---

## 1. Overview

`/loop` is a generic repetition engine: one continuation message per agent
end, round/token/no-progress accounting, pause/resume/clear, reload safety,
and a `complete_loop` tool gated by a pluggable `CompletionPolicy`.

`/research` is a preset over the same engine. It adds:

- a bundled methodology program (`skills/research/program.md`, snapshot at
  run start),
- a retained per-run workspace in the project root (never `/tmp`),
- a frozen run contract (models, provider, profile thresholds, hard caps),
- code-enforced checkpoints over `score.md` + `notes.md` evidence,
- a verification matrix over strict JSON artifacts,
- completion gates audited from disk before `complete_loop` is accepted,
- a lifecycle (`active`, `paused`, `no_progress`, `budget_limited`,
  `complete`, `failed`, `integrity_error`, `abandoned`, `replaced`) and
  resume with full integrity validation.

Subagent dispatch is provider-neutral: `extensions/subagent-dispatch/`
registers one `run_subagents` tool façade; providers (tmux adapter, fake in
tests) advertise themselves over `pi.events`; `ResearchPolicy` middleware
freezes the manifest during an active run.

## 2. Configuration — single owner

`config/research.json` is the **only** config owner for research. There is
no compatibility alias: old `deep-research` config paths (`config/
deep-research.json`, `$PI_AGENT_DIR/deep-research/config.json`) are ignored,
never migrated.

Layer precedence (later wins, strict validation, unknown fields rejected):

1. packaged `config/research.json`
2. user override `$PI_AGENT_DIR/research/config.json`
3. CLI flags (`--profile`, `--max-rounds`, `--tokens`, `--no-progress`,
   `--max-searches-per-agent`, `--max-fetches-per-agent`, `--yes`)

The resolved document owns:

- `defaultProgram` — the bundled program identifier
  (`skills/research/program.md`),
- `defaultProfile` / `defaultProvider`,
- `defaults` — finite `maxIterations`, `maxTokens`, `noProgress`,
  `scoreThreshold`, `retryCount`, `maxSearches`, `maxFetches`,
- `profiles` — per-profile `minRounds`/`maxRounds` (nullable = unlimited),
  `minSources`, `maxScouts`, `maxFetchers`, `verification` kinds,
- `roles` — logical roles (scout, fetcher, judge, citation_agent,
  source_auditor, contradiction_resolver) with model alias, thinking,
  tools, access, timeout, `promptPath`, result format, total/concurrent
  dispatch, per-role web budgets, retention. The assembler has **no** role:
  `program.md` dispatches it as the generic `worker` profile.
- `capabilities` + `childExtensions` — package-owned names resolve to
  bundled paths; user/provider extensions are explicit paths only.

Runtime model resolution and provider negotiation happen in
`validateStartupContract` (`extensions/research/startup.ts`), never in the
config loader.

## 3. Workspace and run identity

A run's workspace is `<project-root>/<mission-slug>[-N]/` (slugified
mission, suffix allocated on collision via an exclusive hidden
`.claim-<slug>-<transitionId>` directory and a same-parent staging rename).
Old workspaces are never reused or deleted.

```
<project-root>/<slug>/
├── score.md                 # 5–8 row table: ID | Question | Score | Notes
├── notes.md                 # source ledger: URL | Title | Tier | Retrieved | Claims
├── report.org               # final report (assembler)
├── fragments/               # org fragments from writers
├── scout-outputs/           # read-only scout/fetcher reports
├── verification/            # strict JSON artifacts (judge.json, ...)
└── .research/
    ├── run.json             # immutable manifest (SHA-256-bound snapshot)
    ├── run-state.json       # ONLY mutable store (revisioned, atomic writes)
    ├── run-lease.json       # one driving session
    └── lifecycle.json       # lifecycle snapshot + history
```

**Run identity** — one formula, one source of truth:

```
runId = formatRunId(transitionId, finalDir)   // `${transitionId}-${finalDir}`
```

`formatRunId` lives in `extensions/research/workspace.ts` and is used by
`commitStaging` and `prepareAndActivateResearch`, so the contract's runId ==
workspace runId == state runId == manifest runId == loop id. Resume,
checkpoints, and completion gates compare these directly.

`run.json` contains no counters/statuses/outcomes and no credentials.
`run-state.json` is the only authoritative mutable store: every write goes
through `updateRunState` with an expected revision; stale revisions return a
typed `StateConflict` and callers retry from a fresh read. Temp-file +
flush + atomic rename prevents torn writes.

## 4. Checkpoints and evidence

`evaluateCheckpoint(ws, loopIteration, expectedRevision)` (checkpoint.ts)
derives every threshold from the manifest/run-state/workspace — callers
cannot supply profile/round/source counts:

1. verifies run identity + state revision,
2. reads + validates `score.md` / `notes.md` (regular files, exact table
   columns, unique IDs, integer 0–100 scores, row count in the configured
   range, canonicalized unique HTTP(S) ledger URLs),
3. increments the research-round counter **once** per loop iteration,
4. computes SHA-256 over the exact bytes,
5. evaluates min rounds / source floor / score threshold / optional max,

returning `CONTINUE | PROCEED | PROCEED_WITH_GAPS` with the evidence digest
and explicit unmet criteria. Missing/malformed evidence fails closed and
does not increment. `PROCEED_WITH_GAPS` only when gaps remain at a finite
maximum; a null maximum never forces it.

URL canonicalization: lowercase scheme+host, drop default ports/fragments,
delete `utm_*`/`fbclid`/`gclid`/`dclid`/`msclkid`, sort remaining query
params. `notes.md` bytes stay untouched.

## 5. Verification

`extensions/research/verification.ts` defines one definition per
verification kind: logical role, output filename, schema version, validator
ID, pass predicate, and the profiles requiring it. `runVerification(ws)`
executes the matrix and returns per-kind results.

Digest binding: verification agents receive the current run ID, manifest
digest, evidence digest, and report digest via policy injection. Editing
`report.org` invalidates report-bound artifacts; editing evidence
invalidates both checkpoint and verification artifacts. Every artifact
carries `runId` and must equal the state's runId to pass the completion
gate.

## 6. Completion gates

`researchCompletionGate(ws)` (`extensions/research/completion.ts`) audits
the retained workspace purely from disk and returns typed
`CompletionFailure[]`:

1. **Manifest/snapshot** — `run.json` exists, parses, belongs to this
   workspace path, carries its snapshot binding, digests compute.
2. **Checkpoint/evidence** — manifest/state/workspace runIds agree, the
   recorded verdict is `PROCEED`/`PROCEED_WITH_GAPS`, and a fresh digest of
   the current `score.md` + `notes.md` bytes matches the recorded
   checkpoint digest (evidence edited since the checkpoint fails).
3. **Report** — `report.org` exists and is non-empty.
4. **Verification artifacts** — every profile-required artifact parses and
   its pass predicate holds, and its `runId` matches the state.

`finalizeSuccess(ws, expectedRevision, outcome)` records the final outcome
and digests through the single transactional state update; a stale revision
is re-audited, never blindly retried. `run.json` is never written.

Generic `/loop` uses `ProgramCompletionPolicy` — immutable program/guard
contract only, no research gates. `complete_loop` awaits the active policy's
`audit`; typed failures leave the loop active.

## 7. Lifecycle, history, and resume

`/research list | status [<slug>] | pause | clear | resume [<slug>]`
operate on retained workspaces (`extensions/research/history.ts`,
`lifecycle.ts`, `resume.ts`). Discovery excludes `.research/cache/web/` and
reports malformed workspaces without aborting the listing.

Resume (`resumeWorkspace`) re-acquires the lease and validates: manifest +
snapshot integrity, mutable-state schema + run ID, exact provider/adapter
compatibility, frozen capabilities, models/extensions, and ownership.
In-flight attempts become `interrupted`, keep consumed dispatch counts, and
release concurrency transactionally. Clearing/replacing marks
`abandoned`/`replaced` without deleting artifacts.

## 8. Program and skill

`skills/research/SKILL.md` links the program and configuration.
`skills/research/program.md` is the canonical methodology (steps 1–9) and
role boundaries; `skills/research/agents/*.md` are the role prompts. The
program contains no model identifiers, thresholds, budgets, timeouts,
provider names, or dispatch caps — those come from the resolved-run
contract. The assembler dispatches as the generic `worker` profile.

## 9. Legacy migration and restore behavior

Deleted: `extensions/deep-research/` (session.ts, config.ts,
verification.ts), `config/deep-research.json`, `skills/deep-research/`, and
the `tests/deep-research-*.test.ts` suites. Nothing imports them;
`extensions/tmux-subagent/config.ts` now loads research roles from
`config/research.json` (user override `$PI_AGENT_DIR/research/config.json`)
and surfaces a clear error instead of silently skipping when the packaged
research config is missing or malformed.

Legacy restore behavior:

- a legacy run (old `/tmp` scratch workspace with `session.json` /
  old-format `run-state.json`, no `.research/lifecycle.json`) **cannot be
  resumed** — `/research resume` reports an explicit cannot-resume message
  (`no_lifecycle` / `state_not_resumable`) and the old session data is
  preserved untouched;
- no legacy state resume under the new engine;
- old `/tmp` workspaces are never imported into the project-root
  retained-workspace listing;
- the old user-override path `$PI_AGENT_DIR/deep-research/config.json` is
  ignored;
- generic `/loop` remains fully available.

## 10. Acceptance checklist

- [x] Generic `/loop` works with any program; `/research` is a preset.
- [x] Finite + unlimited modes (`--max-rounds unlimited`, `--no-progress off`).
- [x] Separate counters: loop iterations vs research rounds.
- [x] Retained runs under the project root, listed by `/research list`.
- [x] Single config owner (`config/research.json`).
- [x] No silent tmux/web-search/model-alias inheritance — research config
      errors are loud; research never imports tmux profiles, web-search
      config, or model aliases.
- [x] Startup failure clarity (contract confirm, validation errors).
- [x] Frozen files (`run.json`, program/role snapshots, SHA-256 verified).
- [x] Single authoritative mutable store (`run-state.json`, revisioned).
- [x] First-class provider selection (subagent-dispatch façade).
- [x] Shared contract suite across fake + tmux providers.
- [x] All limits enforced (iteration, token, no-progress, dispatch,
      concurrency, retry, per-role web budgets).
- [x] Persisted reserved-attempt ledger == physical launch log.
- [x] Evidence-derived checkpoints; digest-validity rules.
- [x] Precise completion rejection (typed failures, runIds checked).
- [x] Generic availability outside research (complete_loop on /loop).
- [x] Model-free automated tests; no benchmark framework; no web-result
      cache implementation.

## 11. Non-goals

- No MCP integration, PDF export, or JSONL audit log.
- No complete-subagent-output caching; no web-result cache.
- No benchmark framework.
- No compatibility alias for the old `deep-research` config namespace.
