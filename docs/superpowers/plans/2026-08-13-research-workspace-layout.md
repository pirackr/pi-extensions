# Research Workspace Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move `/research` workspaces under `.research/<YYYYMMDD-HHmm>-<slug>/` and migrate existing root-level runs there.

**Architecture:** Timestamped `finalDir` generated once in `startup.ts`, threaded through claim/staging/commit/reconcile; discovery and lookup scan `.research/` with timestamp-prefix-stripped matching. One-off shell migration for existing dirs.

**Tech Stack:** TypeScript (jiti-loaded pi extension), vitest, node:fs, shell.

## Global Constraints

- `finalDir = formatTimestamp(new Date()) + "-" + slugify(mission)` — timestamp prefix, local time, format `YYYYMMDD-HHmm`.
- `runId` stays `${transitionId}-${finalDir}` — single source of truth.
- Workspaces land at `<projectRoot>/.research/<finalDir>/`; claims/staging stay at project root.
- Inner `.research/` state dir per workspace unchanged.
- Collision fallback `-2`/`-3` suffixes retained in `acquireWorkspaceClaim`.

---

### Task 1: workspace.ts — timestamp + `.research/` layout

**Files:**

- Modify: `extensions/research/workspace.ts`
- Test: `tests/research-workspace.test.ts`

**Interfaces:**

- Produces: `formatTimestamp(date: Date): string` → `YYYYMMDD-HHmm`; `acquireWorkspaceClaim(projectRoot, mission, transitionId, finalDirBase?)`; `commitStaging` final under `.research/`; `reconcileTransition` final under `.research/` + stale `.claim-*`/`.staging-*` sweep.

- [ ] **Step 1: Add `formatTimestamp`**

```ts
export function formatTimestamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`;
}
```

- [ ] **Step 2: `acquireWorkspaceClaim` accepts `finalDirBase?`** — `const s = finalDirBase ?? slugify(mission);` (slugify already has `|| "research"` fallback).
- [ ] **Step 3: `commitStaging`** — mkdir `<projectRoot>/.research` (recursive:true) before rename; `finalPath = path.join(projectRoot, ".research", staged.finalDir)`.
- [ ] **Step 4: `reconcileTransition`** — `finalPath` under `.research/`; sweep any `.claim-*`/`.staging-*` dirs not matching the current finalDir (best-effort, before status computation).
- [ ] **Step 5: Update `tests/research-workspace.test.ts`** — claim path regex (`/.claim-\d{8}-\d{4}-my-research-t1$/` when base passed), commitStaging final under `.research/`, reconcile final path, formatTimestamp unit test.
- [ ] **Step 6: Run `npx vitest run tests/research-workspace.test.ts`** — PASS.
- [ ] **Step 7: Commit** `feat(research): timestamped workspaces under .research/ (workspace core)`

### Task 2: startup.ts — single timestamped finalDir

**Files:**

- Modify: `extensions/research/startup.ts:520-524, 553-557`
- Test: `tests/research-startup.test.ts`

**Interfaces:**

- Consumes: `formatTimestamp`, `slugify` from `./workspace.ts`.
- Produces: `finalDir` timestamped; `acquireWorkspaceClaim(projectRoot, mission, transitionId, finalDir)`.

- [ ] **Step 1:** Replace inline slug computation with `const finalDir = \`${formatTimestamp(new Date())}-${slugify(mission)}\`;` and import `formatTimestamp` (line 38 import site).
- [ ] **Step 2:** Pass `finalDir` as 4th arg to `acquireWorkspaceClaim`.
- [ ] **Step 3:** Update mock workspace deps in `tests/research-startup.test.ts` (claim/staging/commit mirrors: timestamped base, `.research/` final; update finalDir local computation).
- [ ] **Step 4: Run `npx vitest run tests/research-startup.test.ts`** — PASS.
- [ ] **Step 5: Commit** `feat(research): timestamped finalDir from startup`

### Task 3: history.ts — discovery/lookup under `.research/`

**Files:**

- Modify: `extensions/research/history.ts`
- Test: `tests/research-history.test.ts`

**Interfaces:**

- Produces: `discoverWorkspaces(projectRoot)` scans `<root>/.research/`; `lookupWorkspace(projectRoot, slugOrPath)` exact → stripped-exact → stripped-prefix; `getActiveWorkspace` uses same matching; private `stripTimestampPrefix(name)` (`/^\d{8}-\d{4}-/`) and `findWorkspaceDir(projectRoot, name)`.

- [ ] **Step 1:** Add `stripTimestampPrefix` + `findWorkspaceDir` helpers (scan `<root>/.research/`, skip dot-dirs and `cache`).
- [ ] **Step 2:** Rewrite `discoverWorkspaces` to scan `.research/`; keep `isInResearchCache` exclusion.
- [ ] **Step 3:** Rewrite `lookupWorkspace` name-search branch via `findWorkspaceDir`.
- [ ] **Step 4:** `getActiveWorkspace` — replace root-dir scan with `findWorkspaceDir(projectRoot, slug)`.
- [ ] **Step 5:** Update `tests/research-history.test.ts` — `buildWorkspace` helper creates dirs under `<root>/.research/`; adjust discovery/lookup assertions (timestamps optional in fixture names).
- [ ] **Step 6: Run `npx vitest run tests/research-history.test.ts`** — PASS.
- [ ] **Step 7: Commit** `feat(research): discovery/lookup under .research/`

### Task 4: docs + full suite

**Files:**

- Modify: `docs/006-deep-research-spec.md:26,77`, `skills/research/SKILL.md` (artifacts intro)
- Modify: any remaining tests asserting root layout (`research-integration`, `loop-research`, `research-resume`, `research-manifest-state`)

- [ ] **Step 1:** Update spec doc + SKILL.md prose: workspace = `<project-root>/.research/<YYYYMMDD-HHmm>-<slug>/`.
- [ ] **Step 2:** Fix any remaining layout-asserting tests.
- [ ] **Step 3: Run `npx vitest run`** — full suite PASS.
- [ ] **Step 4: Commit** `docs(research): workspace location under .research/`

### Task 5: migrate existing runs

**Files:**

- Modify: none (filesystem only)

- [ ] **Step 1:** `mkdir -p .research`
- [ ] **Step 2:** For each of the 8 dirs, `mv` into `.research/<mtime-ts>-<slug>/` (drop `--N` collision suffixes; keep typo'd slugs):
  - `how-to-deal-with-toddler-at-2-` → `how-to-deal-with-toddler-at-2`
  - `how-to-deal-with-toddler-at-2--2` → `how-to-deal-with-toddler-at-2`
  - `how-to-parenting-a-2-years-old` → same
  - `pokemon-go-1500cp-team-easy-to` → same
  - `local-model-sate-in-2026`, `local-models-in-2026`, `local-models-state-in-2026` → same names
- [ ] **Step 3:** `rm -rf .quarantine-how-to-deal-with-toddler-at-2--tr-19e0b2eb`
- [ ] **Step 4:** Verify `ls -la .research/` (8 dirs, timestamped) and `git status` (no research dirs at root; `.research/` ignored).
- [ ] **Step 5: Run `npx vitest run`** — still PASS (integration tests may exercise real paths).
- [ ] **Step 6: Commit** `chore(research): migrate retained workspaces under .research/` (docs-only commit — migrated dirs are gitignored)
