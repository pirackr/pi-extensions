# Shared project backlog

The backlog is a trusted-local SQLite record system, **not a runner**. It never
launches workers, schedules jobs, renews leases, or interprets project files.
Authorization, lifecycle stage, and temporary ownership are separate.

## Install and storage selection

Use Node >=22.19. Run `npm install` in this package, then invoke
`node /absolute/package/bin/pi-backlog.mjs`, or use `pi-backlog` after an npm
installation links its bin. Pi loads `extensions/backlog/index.ts` directly;
install the package with `pi install /absolute/package` and `/reload`.
There is no build or daemon.

Keep the data on a **local** filesystem with SQLite locking, not NFS, synced
cloud folders or shared multi-host storage. Root precedence is:

1. CLI `--data-dir`; Pi command `--data-dir` or Pi `--backlog-data-dir` flag.
2. `PI_BACKLOG_DIR`.
3. Pi's public `getAgentDir()` plus `/backlog`; CLI `PI_CODING_AGENT_DIR` plus
   `/backlog`, falling back to `~/.pi/agent/backlog`.

Relative overrides resolve against the operation's current cwd. Project names
never become database paths. UUID-selected databases are under `projects/`.
Registration is explicit and canonicalizes an existing directory. Cwd selection
chooses its deepest registered ancestor, with path-component boundaries. Separate
Git worktrees do not share selection unless registered under a common ancestor;
use `--project <UUID>` to share deliberately. Renaming/relocating registration
preserves identity and items. An unavailable project directory does not erase
its backlog; explicit UUID selection still works. Project configuration is never
loaded as code or policy.

## Commands

The same families work as `pi-backlog ...` and `/backlog ...`:

| Family | Operations |
|---|---|
| project | register, list, show, rename, relocate, policy |
| item | add, list, show, update, transition, read-text |
| dependency | add, remove |
| note | append, list |
| artifact | attach, list |
| result | append, list |
| authorization | approve, authorize, revoke |
| claim | acquire, renew, release, recover |
| workflow | show, publish |
| history | list |

Bare invocation shows the selected project and category counts. Example:

```sh
pi-backlog project register . --name my-app
pi-backlog item add --kind request --title "Add authentication"
pi-backlog item add --kind task --title "Implement session validation"
pi-backlog item update B-2 --expected-revision 1 --input scope.json
pi-backlog item list --kind task --eligible --json
pi-backlog item show B-2 --section criteria --limit 20 --json
pi-backlog item read-text B-2 --field description --json
```

`scope.json` is an operation input object, e.g. description, criteria and optional
`parent: {projectId: "<UUID>", itemId: "B-1"}`. Flags are kebab-case input fields;
`--item` aliases `itemId`. Nested values (criteria, parent, prerequisite, proof,
result, completion, artifacts, definition) accept JSON flags or `--input <file>`.
CLI accepts `--input -` for stdin; Pi rejects stdin and uses files only. No shell
substitutions are evaluated. Duplicate/unknown fields and flag/payload conflicts
are errors, even if values match.

Existing-item mutations require `--expected-revision`; registry rename/relocate
require `--expected-registry-revision`. Policies use `--expected-policy-version`
and workflows `--expected-workflow-version`. Optional `--mutation-id` provides
same-caller/channel/database retry deduplication for **identical** payloads. Read
a fresh revision after conflicts; do not silently retry a changed intent.

`--json` returns exactly one stdout envelope with `apiVersion: 1`, `ok: true` and
`data`, or `ok: false` and `error: {code,message,details}`. Diagnostics go to stderr.
Exit codes: 0 success, 2 validation/usage, 3 domain conflict/precondition, 1 storage
or runtime failure. `STORE_BUSY` is bounded and retryable. No JSON-mode prompts.
Human output is also structured, rather than an interactive board.

## Policy, scope and workflows

The default policy is `approval_required`. Operator-only `project policy` sets a
project default or `--item B-N` override (`--policy null` clears an item override).
Children inherit the request's effective policy. `authorization approve` and
`authorization revoke` are operator actions; `authorization authorize` records
explicit permission only under effective autonomous policy. Every authorization
requires a rationale. CLI/commands assign trusted-local operator attribution;
`--actor` is only a label, **not authentication**. Model tools always assign
`automation/pi-tool`; shell access is not a security boundary.

Scope edits invalidate affected authorization. Claimed task scope and request
scope with recorded child claims are frozen; release/recover ownership first.
Notes and artifacts do not change scope. Terminal scope cannot reopen. A canceled
prerequisite does not satisfy a dependency. Completion requires a nonempty summary,
verification explanation and evidence references, and commits result, stage,
audit and ownership release together. Recorded evidence is **not verified test
results** and references are never fetched or executed by the service.

`workflow show --kind task` returns the current graph; `workflow publish --kind
task --expected-workflow-version 1 --input graph.json` publishes an immutable
version. `graph.json` contains `definition: {initial, stages}`; stages have `id`,
`name`, semantic `category`, and `next` IDs. Custom testing/review stages are
ordinary `active` categories, not hidden human gates or executable hooks. Graphs
must pass draft/ready/active ordering, reachability and terminal rules. New items
use the new default; existing items and approvals remain pinned. No migration,
implicit parent acceptance, cascade cancellation or background execution exists.

## Claims and bounded reads

Lease duration defaults to **300 seconds**, with integer bounds **30–3600**.
Acquire with item revision, worker label, and (for children)
`--expected-parent-scope-revision`, corresponding to `expectedParentScopeRevision`.
Acquire returns lease ID, fencing generation and a private token. Supply all three
as `proof` or `--lease-id`, `--generation`, `--token` on renew/release/claimed
transitions and result writes. Prefer a private input file over command-line
tokens visible to local process inspection.

The caller must renew **before one third** of its duration elapses. There are no
adapter heartbeats or background timers. Stop external work immediately on loss
of ownership or authorization. Renewal rechecks authorization; release remains
possible after revocation while ownership is live. Expired claims remain recorded
until explicit `claim recover` with revision, observed lease/generation and reason.
Recovery is not worker termination and never automatically reacquires.

`project show` includes the default policy and its current `policyVersion`.
`item show` and `item list` include `status`: effective policy, authorization,
eligibility and blocking reasons. Recorded ownership appears as token-free
`claim` metadata with current expiry, `expired`, lease ID and generation. Use
these observations plus the item's revision for recovery; never infer ownership
from an old acquisition receipt. Each read uses one database snapshot.

Lists default to 50 records, max 200, with opaque query-bound `nextCursor`.
Use `--cursor` with the same selection/filters. Item lists sort priority, creation
time, numeric item ID. Filters: kind, stage/category, parent, priority, literal
text and eligibility (evaluated before limits). Show criteria/dependencies via
`--section`; annotations and history have separate lists. Text chunks are capped
at 8 KiB UTF-8. Follow the locator's field/record/revision and returned cursor;
revision changes fail rather than splice text. Pi may return fewer records to
stay below 50 KiB/2000 lines; its cursor follows the last **emitted** record.

## Library and Pi surfaces

Import `createBacklogService` from `modules/backlog/service.ts` through a
TypeScript-aware ESM runtime (the executable uses the direct `jiti` dependency).
Pass absolute `dataRoot`, optionally injected epoch-ms `now`, `uuid`, `randomToken`.
Call synchronous `execute(context, operation, input)` and always `close()` in
`finally`. `OperationMap` and `OperationContext` in `types.ts` are the contracts;
context supplies cwd, optional projectId and trusted actor ID/channel/role.
Errors are `BacklogError` with stable code and safe details. SQL is not a public
integration interface. The library imports neither Pi nor session state.

Pi tools are `backlog_read`, `backlog_item`, `backlog_authorize`, `backlog_claim`.
Each takes a strict `{action, input, projectId?}` envelope. Approval/revocation,
project/policy mutation and workflow publication are not model-callable. Sessions
never reconstruct or rewind this store, and lifecycle hooks only close cached
connections. Tools and commands work without interactive dialogs.

## Offline backup and restore

This is an operator procedure requiring cooperative downtime, not a backup API.

1. Stop **every** Pi, CLI, library client and external worker using this data root.
   Close their connections and prevent restarts throughout copying/restoration.
   No worker may continue external side effects during restoration.
2. Copy the **entire root** into a fresh private directory outside it. Include
   `registry.sqlite`, `projects/<UUID>/backlog.sqlite`, and **all** remaining
   `-wal`, `-shm`, and `-journal` sidecars. Never copy only a live database or
   delete its WAL. Record a relative-path SHA-256 manifest before copying; compare
   source and destination inventories/hashes **before opening either copy**.
   An omitted committed WAL can leave a valid but outdated database: integrity
   checks alone cannot detect that omission. Only a completed copy is usable.
3. Validate the copy without normal backlog mutations. On Node >=22.19, a local
   validation script can use `DatabaseSync(path, {readOnly:true})` from
   `node:sqlite`. For the registry and each database it references, run:
   ```sql
   PRAGMA integrity_check;   -- every row must say ok
   PRAGMA foreign_key_check; -- must return no rows
   PRAGMA user_version;      -- must be 1
   ```
   Enumerate `SELECT id FROM projects` in the registry. Each UUID must have
   `projects/<UUID>/backlog.sqlite`, whose metadata `projectId` equals that UUID
   and metadata `kind` is `project`; registry metadata `kind` must be `registry`.
   Missing databases, corrupt files, wrong identities, or unsupported schemas
   invalidate the snapshot. Fail closed; never initialize replacements.
4. Keep clients stopped. Preserve the current root separately, then restore the
   whole snapshot into an **empty** root, with directories 0700 and files 0600
   (where supported). Do not merge files or sidecars from different snapshots.
   Verify the inventory and SQLite checks again before reopening. Do not restore
   into a symlink or bypass data-path safety checks.
5. Discard cached state and pending retry queues. Reconcile retained records and
   external effects before retrying pre-restore commands under *any* mutation ID.
   Keep external workers stopped until restored leases expire. Explicitly run
   `claim recover` with the observed lease ID, generation, item revision, and a
   reconciliation reason, then acquire a **fresh** claim. Neither the recovery
   operation nor the backlog itself stops an external worker.

Restore rolls back registry, items, counters, revisions and mutation receipts
**together**. Post-backup data is lost, so identifiers/revisions can be reused.
External references to post-backup work must be reconciled before reuse. Project
files and external actions are not rolled back; monotonic IDs and exactly-once
behavior do not survive snapshot rollback. Replayed acquisition receipts do not
renew ownership or bypass expiry/generation checks.
