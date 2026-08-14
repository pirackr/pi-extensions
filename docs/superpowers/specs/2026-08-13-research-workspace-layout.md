# Research Workspace Layout — Design

**Date:** 2026-08-13
**Status:** Approved (user: "go ahead with your implementation")
**Scope:** research extension workspace location + naming; one-off migration of existing runs.

## Problem

`/research` runs create workspaces directly in the project root
(`<project-root>/<mission-slug>[-N]/`), which clutters the repo with untracked
research folders. Duplicate missions produce collision suffixes (`-2`, `-3`)
that are hard to disambiguate, and crashed runs leave stray `.quarantine-*`
dirs behind.

## Decisions (from brainstorming)

1. **Location:** all research workspaces live under a top-level
   `.research/` directory at the project root — `<project-root>/.research/<finalDir>/`.
   The top-level `.research/` is already git-ignored (`/.research/` in
   `.gitignore`).
2. **Naming:** `finalDir = <YYYYMMDD-HHmm>-<mission-slug>` — timestamp
   **prefix** (local time), e.g. `20260813-1432-how-to-deal-with-toddler-at-2`.
   Timestamp is generated **once** per run and shared by claim / staging /
   commit / runId. The `-2`/`-3` suffix fallback stays for same-minute
   collisions.
3. **runId unchanged:** still `<transitionId>-<finalDir>`.
4. **Inner state dir unchanged:** each workspace keeps its own `.research/`
   (run.json, run-state.json, lifecycle.json) — now nested at
   `.research/<finalDir>/.research/`.
5. **Claims/staging stay at the project root** (hidden, transient,
   dot-prefixed — excluded from discovery). `reconcileTransition` additionally
   sweeps any stale `.claim-*`/`.staging-*` dirs from crashed runs.
6. **Migration:** move all existing root-level research dirs into
   `.research/<mtime-ts>-<slug>/`, dropping `--N` collision suffixes.
   Delete the orphaned `.quarantine-*` leftover.
7. **No state-file rewrites needed:** state.ts stores no absolute paths.

## Target layout

```
<project-root>/
  .research/                          ← git-ignored
    cache/                            ← web cache (untouched)
    20260813-0718-local-models-state-in-2026/
    20260813-1432-how-to-deal-with-toddler-at-2/
      .research/                      ← inner state dir (unchanged)
      report.org, notes.md, score.md, scout-outputs/, ...
  .claim-<finalDir>-<tr>/             ← transient (swept by reconcile)
  .staging-<finalDir>/                ← transient (swept by reconcile)
  transitions.json                    ← pointer file (unchanged)
```

## Code changes

| File | Change |
| ------ | -------- |
| `extensions/research/workspace.ts` | `formatTimestamp()`; `acquireWorkspaceClaim(..., finalDirBase?)`; `commitStaging` renames into `.research/`; `reconcileTransition` final path under `.research/` + stale-claim sweep |
| `extensions/research/startup.ts` | compute `finalDir = formatTimestamp(new Date()) + "-" + slugify(mission)` once; pass as `finalDirBase` to claim |
| `extensions/research/history.ts` | discovery/lookup scan `.research/`; timestamp-prefix-stripped matching |
| `extensions/loop/command.ts` | no change (discovery lives in history.ts) |
| `extensions/research/resume.ts` | no change (projectRoot unused downstream) |
| `docs/006-deep-research-spec.md`, `skills/research/SKILL.md` | workspace location prose |
| `tests/research-workspace.test.ts`, `tests/research-startup.test.ts`, `tests/research-history.test.ts` (+ any asserting layout) | updated |

## Verification

`npx vitest run` — all tests pass; `.research/` contains the 8 migrated
workspaces; `git status` shows no research dirs at root.
