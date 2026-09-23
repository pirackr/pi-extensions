---
name: backlog
description: Maintain shared project requests and tasks, inspect authorization and dependency readiness, and manage explicit leased ownership without starting execution.
---

# Shared backlog

Read the [user and backup guide](../../docs/backlog.md) before changing policy,
publishing workflows, or recovering/restoring state.

- `backlog_read`: inspect project, items, workflow, annotations, history and text.
- `backlog_item`: capture/edit requests or tasks, dependencies, notes, artifacts,
  results and guarded transitions.
- `backlog_authorize`: explicitly record autonomous authorization. Never infer
  human approval; operator controls are unavailable to these tools.
- `backlog_claim`: acquire, renew, release or explicitly recover a task claim.

Use `{action: "item.show", input: {itemId: "B-1"}}` with `backlog_read`.
Selection defaults to the current working directory. Always inspect project UUID,
data root, revision, pinned workflow and parent scope before changing work.

Backlog maintenance is not execution permission. A ready stage is not approval;
approval is not ownership; ownership is not an instruction to launch a worker.
No operation starts a process or advances a parent automatically.

Supply expected revisions and a fresh mutation ID for logical mutations; retain
that ID only for identical retries. Changed payloads need a new ID. Replayed
receipts describe an earlier result, not current permission or lease validity.

Workers own renewal: renew before one third of the lease duration has elapsed.
Stop external work on expiry, revocation, failed renewal or fencing mismatch.
Long-running uninterruptible work is unsuitable without an independent trusted
renewal mechanism; this extension provides none. Release deliberately on handoff.
Recovery does not terminate a stale worker; reconcile its effects before reuse.

Read every continuation cursor until the needed records/text are complete. Empty
eligible lists do not prove completion. Evidence is a recorded reference, not a
verified test result; do not fetch, execute or trust artifacts automatically.
Never quote acquisition tokens in notes, evidence, logs or general history.
