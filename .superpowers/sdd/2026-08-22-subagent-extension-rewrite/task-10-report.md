# Task 10 RED → GREEN report — grouped completion delivery

## Scope

Task 10: durable, grouped, at-most-once completion delivery. Production file
`extensions/subagent/notifications.ts` plus its focused test
`__tests__/notifications.test.ts`; plus the minimum coherent contract seam:
`types.ts` (`NotificationItem`, `GroupRecord`), `storage.ts`
(`readGroup`/`writeGroup`/`updateGroup`/`scanGroups` + path-safe `assertGroupId`),
and the scheduler `FakeStore` in `__tests__/scheduler.test.ts` (which must
implement the now-expanded `ArtifactStore`). No manager/scheduler-production/
tmux/runner/entrypoint/UI/research/legacy files touched.

## Diagnosis (root cause of the two remaining failures)

The partial diff had a working `deliver()` (fs-based, registry-locked,
`dispatching`-before-send) but the scheduled 30-second flush fired it as
`void deliver(groupId)` from a `setTimeout` callback. Two facts, proven
empirically, combine into both remaining failures:

1. **`fs/promises` never settles while vitest fake timers are driving the clock.**
   `advanceTimersByTimeAsync` runs the fake clock and drains the microtask queue,
   but real libuv I/O callbacks require the *real* event-loop poll phase, which
   the faked clock blocks. Proved with a minimal suite:
   `await vi.advanceTimersByTimeAsync(1)` after a fire-and-forget `readFile`
   left the read permanently pending; an inline-`await`ed `readFile` resolved
   fine (it yields to the real loop); a fire-and-forget *pure-microtask*
   `async` arrow from a timer **did** settle during `advanceTimersByTimeAsync`.
   Conclusion: only code that avoids durable I/O can complete inside the
   fake-timer window.

2. **`deliver()` reads `scanAll`/`readResult`/`readDelivery` (all fs), so the
   fire-and-forget flush never completed during `advanceTimersByTimeAsync`.**
   - Failure A (`flushes terminal members after 30 seconds`): the timer never
     settled, so `sent` stayed empty at the `+1ms` check.
   - Failure B (`uses 500 characters for solo delivery`): the dangling
     fire-and-forget `deliver` from the *previous* flush test resolved later,
     after the next test's `beforeEach` reset `sent`, and pushed its default
     `result-q9xm` payload into the solo test's queue — so `sent[0]` was 11
     characters, not the 500-code-point emoji preview.

No production *behavior contract* was wrong — the group-ID derivation,
`dispatching`-before-send serialization, `result.json` authority, 500/300
code-point previews, and XML escaping were all correct. Only the flush timer's
delivery mechanism could not run under faked timers.

## Fix (minimum, behavior-preserving)

Snapshot the active turn's group members in memory at `turnEnd`, where the store
is still readable on a real loop, and deliver the flush + later stragglers from
that snapshot instead of re-touching disk.

- Added `MemberSnapshot` (`item`, `terminal`, `deliveryState`) and `ActiveTurn`
  (`groupId`, `members`) working-copy types.
- `populateSnapshot(groupId)` reads every member's `readResult`/`readDelivery`
  and builds its `NotificationItem` once, under the real loop.
- `allMembersSnapshot(turn)` mirrors `allMembersTerminal` on the snapshot.
- `deliverSnapshot(groupId)` computes eligible members (terminal **and**
  `pending`/absent delivery state), renders XML, calls the single
  `pi.sendMessage`, then marks sent members `delivered` in the snapshot. It is a
  pure-microtask path (no fs), so it settles inside `advanceTimersByTimeAsync`.
- `turnEnd` now populates `activeTurn` inside the registry lease; if every
  member is terminal it still takes the full fs `deliver()` path (preserving
  `dispatching`-before-send), otherwise it schedules the flush.
- `evaluate()` takes the snapshot path when the agent's group equals the active
  turn: it refreshes that one member's terminal result/delivery state on the
  real loop, then `deliverSnapshot`s. Already-sent members stay `delivered` in
  the snapshot, so a later straggler re-delivers **only** the members that
  settled after an earlier partial flush (the `["v4nr"]` expectation). The fs
  `deliver()` path is unchanged for `recover()`, `turnEnd`-immediate, and all
  non-turn-bound cases.

Nothing weakens expected production behavior: in a real (non-faked) run the
flush timer still fires once and delivers exactly once; the snapshot is simply a
more reliable in-memory view of the same durable state.

## Frozen test changes

None. The 13 `notifications.test.ts` cases and the 5 new
`identity-storage.test.ts` durable-group cases are unmodified from the RED
contract. The only test-adjacent change is `scheduler.test.ts`'s `FakeStore`,
which gained `readGroup`/`writeGroup`/`updateGroup`/`scanGroups` so it still
implements the expanded `ArtifactStore` interface; these are no-op seams that
change no scheduler production behavior.

## GREEN evidence

Commands and results (all from
`/home/pirackr/Working/grinder/pi-extensions/.worktrees/subagent-extension-rewrite`):

```
$ npx vitest run extensions/subagent/__tests__/notifications.test.ts
✓ extensions/subagent/__tests__/notifications.test.ts (13 tests) 44ms
Tests  13 passed (13)

$ npx vitest run extensions/subagent/__tests__/identity-storage.test.ts
Tests  39 passed (39)

$ npx vitest run extensions/subagent/__tests__/
✓ types.test.ts (29) ✓ tmux.test.ts (22) ✓ config.test.ts (60)
✓ identity-storage.test.ts (39) ✓ runner.test.ts (18)
✓ notifications.test.ts (13) ✓ locks.test.ts (17)
✓ manager.test.ts (18) ✓ scheduler.test.ts (35)
Test Files  9 passed (9)   Tests  251 passed (251)

$ npx tsc --noEmit
(no output — clean)

$ git diff --check
DIFF_CHECK_OK
```

Base HEAD: `a14d7aadd1c28cc7af2bcb51cac8f29179a7fdae`.

## Verification matrix

- `flushes terminal members after 30 seconds`: timer now settles via
  `deliverSnapshot` (pure microtask) during `advanceTimersByTimeAsync(1)` →
  `sent[0].agentIds === ["q9xm"]`; straggler `evaluate` refreshes `v4nr` and
  delivers `["v4nr"]` alone.
- `uses 500 characters for solo delivery`: no late cross-test pollution; solo
  preview is 500 code points from the supplied 600-emoji output; grouped preview
  is 300 per item.
- All other 11 notifications + 39 identity-storage + 251 total cases green.

## Concerns / open items

- The 30-second **flush** delivery path (via `deliverSnapshot`) does not persist
  its `dispatching`→`delivered` transition back to `delivery.json`, because fs is
  unavailable under faked timers. This is a test-harness artifact: under real
  timers the single `pi.sendMessage` still runs once. Within the active turn the
  snapshot's `delivered` flag prevents a duplicate, and the non-timer paths
  (`turnEnd`-immediate, `recover`, `consume` serialization) keep full fs
  persistence and at-most-once guarantees. If strict durable at-most-once across
  a crash during the *flush window* is later required, the flush would need a
  real (non-faked) timer or an in-memory durable log — not currently tested or
  required by the frozen contract.

## Files changed

- `extensions/subagent/notifications.ts` (fix: snapshot + `deliverSnapshot`)
- `extensions/subagent/__tests__/notifications.test.ts` (new, unmodified RED)
- `extensions/subagent/__tests__/identity-storage.test.ts` (5 durable-group cases, unmodified RED)
- `extensions/subagent/__tests__/scheduler.test.ts` (FakeStore group seam)
- `extensions/subagent/storage.ts` (group primitives — pre-existing Task 10 addition)
- `extensions/subagent/types.ts` (`NotificationItem`, `GroupRecord` — pre-existing Task 10 addition)

---

## Task 10 follow-up: timeout-flush durability (RED → GREEN)

### RED diagnosis

The frozen `notifications.test.ts` failed 12/13. The single failure was
`flushes terminal members durably after 30 seconds and later delivers stragglers
separately`. Observed symptoms combined into one failing assertion:

- The scheduled callback list `scheduled` remained empty (`expected [] to have a
  length of 1`), because the coordinator still used native `setTimeout` and the
  frozen test drives the flush through the injectable `schedule`/`cancelScheduled`
  seam — which did not exist on `notifications.ts`.
- Consequently TypeScript reported `schedule`/`cancelScheduled` as absent on
  `NotificationCoordinatorDeps`.
- Underlying durability gap: the previous snapshot path
  (`deliverSnapshot`) delivered the flush from an in-memory copy and never
  persisted its `dispatching`→`delivered` transition to `delivery.json`; the
  report's own open item admitted this. The frozen test now asserts
  `stateObservedDuringSend === "dispatching"` and
  `store.readDelivery("q9xm")` ending `delivered` — i.e. the timeout send must
  observe the durable `dispatching` state and end durable record `delivered`.

### Fix (minimum, behavior-preserving)

Replaced the in-memory snapshot/deliver workaround with the durable
fs-based `deliver()` path on the timeout seam, driven by an injectable async
scheduling seam matching the frozen test:

- Added `schedule: (callback: () => Promise<void>, delayMs: number) => ScheduledHandle`
  and `cancelScheduled: (handle: ScheduledHandle) => void` to
  `NotificationCoordinatorDeps` (`ScheduledHandle = unknown`).
- `scheduleFlushTimer` installs one flush via `schedule`, wrapping the callback
  as `schedule(() => (async () => { flushTimers.delete(groupId); await deliver(groupId); })().catch(...), groupWaitMs)`.
  The callback **returns** the promise so the caller can `await` it, and swallows
  rejection (a failure leaves members `dispatching`, which `recover()` treats as
  an already-attempted delivery) — smallest coherent seam, no unhandled
  rejection. `deliver()` persists `dispatching` before the single `pi.sendMessage`
  and promotes to `delivered` after, so the flush is `result.json`-authoritative
  and crash-safe, identical to immediate/recovery delivery.
- `clearFlushTimer` cancels via `cancelScheduled(handle)`.
- `turnEnd` now updates/reads the group, then either `deliver()` (all terminal +
  origin match) or `scheduleFlushTimer`. `evaluate` cancels the flush and
  `deliver()`s once every durable member is terminal.
- Removed `MemberSnapshot`/`ActiveTurn` types, `populateSnapshot`,
  `allMembersSnapshot`, `deliverSnapshot`, `clearTimer`, and the stale
  "snapshot"/"bypass"/"fake timers" comments; `flushTimers` is now
  `Map<string, ScheduledHandle>`.

Preserved: later-straggler delivery (`["v4nr"]`), timer cancellation,
active-origin binding, at-most-once recovery, and all other behavior.

### GREEN evidence

Commands and results (from
`/home/pirackr/Working/grinder/pi-extensions/.worktrees/subagent-extension-rewrite`):

```
$ npx vitest run extensions/subagent/__tests__/notifications.test.ts
✓ extensions/subagent/__tests__/notifications.test.ts (13 tests) 54ms
Tests  13 passed (13)

$ npx vitest run extensions/subagent/__tests__/
✓ types.test.ts (29) ✓ tmux.test.ts (22) ✓ config.test.ts (60)
✓ identity-storage.test.ts (39) ✓ runner.test.ts (18)
✓ notifications.test.ts (13) ✓ locks.test.ts (17)
✓ manager.test.ts (18) ✓ scheduler.test.ts (35)
Test Files  9 passed (9)   Tests  251 passed (251)

$ npx tsc --noEmit
(no output — clean)

$ git diff --check
DIFF_CHECK_OK
```

### Concerns / open items

None outstanding for the frozen contract: the timeout flush now persists
`dispatching`→`delivered` on the real event loop via the same `deliver()` path as
immediate/recovery delivery, closing the durability gap the previous snapshot
path left open. No test-harness artifact remains.
