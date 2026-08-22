# Task 3 Report — Generation-safe filesystem locks

## Status: GREEN (audit complete, tests pass, committed)

## Provenance (honest record)

The files for this task were inherited mid-flight: a prior worker timed out
before committing `extensions/subagent/locks.ts` and
`extensions/subagent/__tests__/locks.test.ts`. No prior `task-3-report.md`
survived in this worktree (the report did not exist before this run), and the
only surviving evidence of the earlier pass is the controller's note that the
focused test passed **14/14** and that the LSP was clean. That RED run was
performed **before** the inherited files were present, so I could not re-verify
its exact per-test output — this report does not fabricate those numbers. This
run re-runs the focused test, `tsc --noEmit`, and the full suite from scratch
against the inherited files and records that fresh evidence below.

## Scope

- `extensions/subagent/locks.ts` — audit only (reviewed against brief + spec).
- `extensions/subagent/__tests__/locks.test.ts` — audit only.
- `.superpowers/sdd/2026-08-22-subagent-extension-rewrite/task-3-report.md` — written.
- `types.ts` — reviewed for contract consistency (no change needed; the lease
  types mirror `AgentManifest`'s `generation` / `processStart` / `pid`).

## Audit: brief scenarios vs. implementation & tests

The brief enumerated ten scenarios. All are implemented in `locks.ts` and
covered by a dedicated test:

| # | Scenario | Implementation | Test |
|---|----------|----------------|------|
| 1 | Exclusive creation | atomic `open(path, "wx")`, never check-then-create | `creates the lock and flushes a complete identity payload` |
| 2 | Incomplete-payload retry | retry budget + backoff on `{kind:"incomplete"}` | `retries an incomplete payload…` / `fails … after the retry budget is exhausted` |
| 3 | Live-owner refusal | live (non-stale) owner throws without reclaiming | `refuses a second live owner (exactly one holder)` |
| 4 | PID **+** start-time stale detection | `isStale = !alive(pid) || processStart !== currentProcessStart` | `reclaims a dead-PID lock` / `reclaims a lock whose process-start identity is foreign` |
| 5 | Competing quarantine renames | unique `.quarantine.<time>.<rand>` name then retry | `converges to one winner when two owners reclaim a stale lock` |
| 6 | Successor generation protection | `assertCurrent` checks generation/pid/processStart | `assertCurrent rejects a superseded lease` |
| 7 | Stale-owner release refusal | `release` unlinks only on matching generation (owner-only) | `never unlinks a lock owned by another generation` |
| 8 | Bounded abortable backoff | `signal.throwIfAborted()` each iteration + `maxRetries` | `rejects an already-aborted signal` / `stops retrying when aborted mid-wait` |
| 9 | One winner under contention | exclusive create guarantees single holder | `converges to a single winner under concurrent acquisition` |
| 10 | Generation checks | `assertCurrent` + owner-only `release` | `is released owner-only and idempotently` |

**No real gaps found.** The implementation is complete and matches the design
spec's security requirements (`specs/…-design.md` "Durable FIFO scheduler"
section): atomic exclusive creation, flushed identity, retry-incomplete,
PID+start stale detection, unique quarantine + retry, and generation guards.

One benign observation (not a fix): `withRegistryLock`'s `finally` swallows
release errors (`catch(() => undefined)`) so a failed release during teardown
never masks the `fn` result — this matches the documented "always release"
intent.

## Tests / output

- `npx vitest run extensions/subagent/__tests__/locks.test.ts` → **14/14 passed**
  (221 ms). Test count (14) matches the controller's inherited note.
- `npx tsc --noEmit` → **exit 0, no errors**.
- Full suite `npx vitest run` → **1588 passed, 2 skipped** (50 files), no
  regressions.

## Files

- `extensions/subagent/locks.ts` — inherited, uncommitted; unchanged (audit passed).
- `extensions/subagent/__tests__/locks.test.ts` — inherited, uncommitted; unchanged.
- `.superpowers/.../task-3-report.md` — authored this file.

## Commit

`feat(subagent): add generation-safe registry leases` — staged and committed.

## Self-review

- Honest about provenance: no prior report survived; RED-before-files claim not
  re-verified; numbers below are from this run.
- Scoped: no implementation change, no unrelated edits, no subagents.
- Exact commit subject used.

## Concerns

- `types.ts` is untouched here; Task 3's lease identity deliberately mirrors
  `AgentManifest.generation`/`processStart`/`pid`. If those manifest fields ever
  change shape, the lease's `isLeaseIdentity` guard should be reviewed for
  consistency — out of scope for this audit.

## Recommended next action

Proceed to Task 4 (registry/scheduler) which consumes these leases; the lease
contract surface is stable and covered.
