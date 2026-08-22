# Task 2 Report: Secure identity and artifact storage

## Takeover note

I took over Task 2 from a prior implementer who timed out before committing. At
handoff the three Task 2 files existed on disk but were **uncommitted and
diagnosably broken**:

- `storage.ts` imported `stat` from `node:fs/promises` but called `lstat` at
  five sites (assertRealDirChain, ensureDir, readJsonSecure, scan, flushLogs),
  producing **five** TypeScript diagnostics (`TS2552: Cannot find name 'lstat'`).
  (The task brief's "six diagnostics" count was slightly high; the actual set
  was five, all the `lstat` reference.)
- The scoped test file was present and **red**: `npx vitest run
  extensions/subagent/__tests__/identity-storage.test.ts` failed 3 of 25 cases.
- No `task-2-report.md` had been published, and the brief's "verify
  missing-module failure" RED step had been performed by the timed-out worker
  but never documented.

I inspected and owned the existing partial implementation rather than
restarting. I did **not** rewrite the modules: the implementation correctly
covers every named brief requirement (canonical basename+hash slug, crypto
base-36 collision retries, tmux → PI_SESSION_ID → allocation order, exact root
layout, 0700/0600 modes, symlink/type rejection, monotonic revisions,
temp-file+fsync+rename atomic JSON, append-log flush, result-before-terminal
order).

## Implementation

Minimal, non-restart edits:

1. **`storage.ts`** — replaced the `stat` import with `lstat` (the five call
   sites all want `lstat`, i.e. no symlink following). This cleared all five
   diagnostics. No logic changed.
2. **`__tests__/identity-storage.test.ts`** — fixed two **bugs in the inherited
   tests** that were inconsistent with the documented contracts (the
   implementation is the source of truth):
   - `allocateShortId > fixedRandom`: the old byte encoder
     (`chars[...].charCodeAt(0) % 36`) fed `randomShortId`'s `BASE36[byte % 36]`
     and produced `cdqr`, not the asserted `aa00/bb11/cc22`. Rewrote the seed to
     emit the base36 *index* of each expected id character (clamping
     non-alphabet input into the bucket), and passed the candidate-id sequences
     (`["aa00","bb11","cc22"]`) instead of the char lists. Collision-retry
     coverage is unchanged; the assertions now actually exercise it.
   - `resolveParentIdentity > prefers a running pi-xxxx tmux session suffix`:
     expected `artifactRoot` used a bare `coolproject`, which contradicts the
     basename+hash slug contract (`coolproject-5c02`) that the top-level
     `projectSlug` tests correctly encode. Changed the expected string to
     `${FAKE_TMP}/${projectSlug(resolve("/tmp/CoolProject"))}/pi-q9xm`, keeping
     the genuine layout/order assertion.
3. **`identity.ts`, `types.ts`** — no changes. The scoped tests, tsc, and the
   full suite pass without any type/contract change (Task 1 contracts
   preserved).

## Tests

- `npx vitest run extensions/subagent/__tests__/identity-storage.test.ts` →
  **25 passed** (was 22 passed / 3 failed).
- Covers every named behavior: canonical basename+hash slug + determinism +
  basename-collision divergence + trailing-slash tolerance; allocateShortId
  first-free, tmux+artifact collision retries, exhaustion error, alphabet
  bound; resolveParentIdentity tmux > PI_SESSION_ID > allocation order + malformed
  env rejection; exact parent layout with 0700 dirs / 0600 files; 0600 files on
  enqueue; symlink dir + symlink-file rejection; scan FIFO ordering; readTask
  null; monotonic revisions; result-before-terminal publication + log retain;
  cancellation marker 0600; delivery read/merge/null.
- `npx tsc --noEmit` → clean (exit 0).
- Full suite → **1566 passed, 2 skipped, 1 failed**. The single failure is
  `tests/loop-completion.test.ts > can delay with async logic`
  (`expected 9 >= 10`ms) — a timing-sensitive test in a module **outside Task 2
  scope**. Verified flaky: it passed 2 of 3 consecutive runs. Not introduced by
  this work.

## Red provenance

The brief's "verify missing-module failure" step was performed by the
timed-out worker prior to handoff; its exact output was **not** recorded
anywhere. I did not re-run the pristine missing-module RED (the modules are
already present on disk), and I am **not fabricating** its output here. The
five `TS2552 Cannot find name 'lstat'` diagnostics observed at handoff are the
concrete, reproducible evidence that the files arrived in a broken (red) state.
All evidence below is GREEN and reproducible from the committed files.

## Files

- `extensions/subagent/storage.ts` — import `stat` → `lstat`.
- `extensions/subagent/__tests__/identity-storage.test.ts` — fixed two inherited
  test bugs (see above); coverage preserved.
- `extensions/subagent/identity.ts` — unchanged.
- `extensions/subagent/types.ts` — unchanged.
- `.superpowers/sdd/2026-08-22-subagent-extension-rewrite/task-2-report.md` —
  this report.

## Self-review

- **Acceptance criteria**: no diagnostics in scoped files ✓; all targeted tests
  pass and cover every named behavior ✓; tsc + full suite pass (only the
  out-of-scope flake fails) ✓; exact commit with only Task 2 files ✓; report
  honest about inherited RED ✓.
- **Scope**: no locks/scheduler/runner/manager/tmux/notification code; no
  subagents/reviewers; no unrelated edits; no research-specific storage
  (Ruling P2 honored — storage primitives are owner-neutral).
- **Risk**: the two test edits changed expected values. This is justified —
  both were encoding bugs inconsistent with the brief and with the sibling
  `projectSlug` tests, and the implementation encodes the actual contract.
  Coverage of every named behavior is retained.
- **Concern**: the `loop-completion` timing flake is pre-existing and unrelated;
  flagged for the parent agent but left untouched to keep the commit scoped.

## Fix Round 1 (this follow-up)

Addressed the medium/low review findings from `task-2-review.md` with
surgical, focused changes and regression tests. No later-task code, no
unrelated edits, no rewrite of the Task 2 implementation.

### Finding 1 — `publishTerminal` / `writeStatus` skipped id validation (MEDIUM)

`workspace(agentId)` derives a path directly under `subagentsRoot`; every
sibling method guarded with `isShortId` except these two, so an `agentId`
containing `..` could escape the `subagents/<id>` boundary. Added an explicit
`throw` at the top of each method:

- `writeStatus` → `throw new Error("invalid agent id for writeStatus: …")`.
- `publishTerminal` → `throw new Error("invalid agent id for publishTerminal: …")`.

Rejecting outright (not returning null) makes a traversal attempt observable.

### Finding 2 — `scan` skipped symlinked/unexpected entries (LOW, spec gap)

`scan` did `if (info.isSymbolicLink() || !info.isDirectory()) continue;` —
safe (never followed) but the binding constraint says *reject*. Replaced the
silent skip with two throws:

- symlinked subagent entry → `refusing to follow symlink in scan: …`
- non-directory entry → `unexpected non-directory in scan: …`

`lstat` is still used, so symlinks are never dereferenced.

### Finding 3 — slug derived from non-canonical cwd (LOW, spec gap)

`resolveParentIdentity` passed `options.cwd` straight into `projectSlug`, so a
symlinked or `..`-containing cwd could redirect the artifact root. Added an
injectable `canonicalize` option (default `safeCanonicalize`, a
`fs.realpath` wrapper that returns the input unchanged on failure — so a
non-existent cwd never blocks resolution). `projectSlug` remains a pure helper;
canonicalization now happens at the call boundary. `options.projectSlug`
override still short-circuits canonicalization.

### Test file — `extensions/subagent/__tests__/identity-storage.test.ts`

Seven focused additions (25 → 32):

- `ArtifactStore id boundary enforcement` — `writeStatus` and `publishTerminal`
  reject a `"../evil"` traversal id; `publishTerminal` rejects a non-short id
  *before* touching disk.
- `ArtifactStore scan rejects non-directory entries` — scan throws on a
  symlinked `q9xm` entry (does not follow it) and on a regular file masquerading
  as a subagent id.
- `resolveParentIdentity > derives the project slug from the canonical cwd` — an
  injected canonicalizer proves only the canonical path reaches `projectSlug`.
- `resolveParentIdentity > canonicalization failure falls back to the raw cwd`.

### Commands and output

- `npx vitest run extensions/subagent/__tests__/identity-storage.test.ts` →
  **32 passed** (was 25 after Task 2; +7 focused tests this round). Exit 0.
- `npx tsc --noEmit` → **clean, exit 0**.
- Full suite: out of scope for this fix; the pre-existing `loop-completion`
  timing flake was already disclosed in the Task 2 report and is left
  untouched to keep the commit scoped.

### Changes

- `extensions/subagent/storage.ts` — `isShortId` guards in `writeStatus` and
  `publishTerminal`; `scan` throws on symlinked/non-directory entries.
- `extensions/subagent/identity.ts` — injectable `canonicalize` option +
  `safeCanonicalize` (`fs.realpath`) default; slug derived from the canonical
  cwd; `projectSlug` unchanged (still pure).
- `extensions/subagent/__tests__/identity-storage.test.ts` — 7 focused tests.

### Self-review

- Acceptance criteria: all three findings fixed with focused regression tests ✓;
  no new tsc diagnostics (exit 0) ✓; scoped targeted tests + tsc pass ✓; report
  and commit scoped ✓.
- Scope: no later-task implementation, no subagents/reviewers, no unrelated
  edits (git status shows only the three named files).
- Risk: the Finding 3 default canonicalizer swallows `realpath` failures by
  returning the raw input. This is intentional and documented — a missing cwd
  must not block identity resolution — and is covered by the fallback test.
