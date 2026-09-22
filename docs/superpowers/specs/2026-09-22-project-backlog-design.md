# Project backlog store — design

Date: 2026-09-22

Status: Reduced v1 direction approved in chat; revised written specification awaiting user review.

## 1. Purpose and boundary

Build a durable, project-scoped backlog that people, Pi agents, and independent local processes can use. It will eventually supply work to a Software Factory, but **the backlog is the product being built now**. No factory or workflow runner is part of this specification.

The backlog accepts both high-level requests and implementation-ready tasks. Projects have configurable stages because the user's eventual development workflow is not yet known. Execution authorization can be approval-based or autonomous, independently of stage names.

Success means a user can register a directory, capture and refine work, configure its lifecycle, and inspect or update the same backlog from unrelated Pi sessions and standalone processes without losing updates.

### In scope

- Explicit project registration, stable project identity, and directory-based discovery.
- One SQLite backlog per project and a central project registry.
- Requests and tasks, acceptance criteria, priority, dependencies, and artifact references.
- Configurable project stages and transitions; new definitions apply only to new items.
- Approval/autonomy policy, authorization records, and change history.
- Revision-checked mutations and basic task claims, renewal, release, and explicit recovery.
- Pi slash commands, model-callable tools, and a standalone JSON-capable CLI.

### Out of scope

Agent launching, scheduling, automatic decomposition, model calls, test execution, Git/worktree management, deployment, a background daemon, network access, multi-machine coordination, issue-tracker synchronization, a graphical board, nested epics, arbitrary workflow scripts/plugins, and a security boundary between processes running as the same OS user.

V1 also defers workflow migration, separate child scope-binding records/commands, built-in heartbeat workers, and online backup tooling. It keeps revision checks, approval freshness, transactional claims, and explicit recovery.

Adding an item, authorizing it, claiming it, opening Pi, or restoring a session never starts execution. A custom stage describes backlog state; it does not run an action.

## 2. Decisions and alternatives

The selected approach is **SQLite + a shared library + thin CLI and Pi adapters**: one shared rule set for local clients, with no service or separate database executable.

Beads is a credible alternative with Git-free, embedded operation, dependencies, claims, and leases. It is not rejected for requiring a daemon. This design instead favors the exact shared mutation/approval contract below over adapting to Beads' native semantics. The trade-off is maintaining our own tracker and its correctness tests; this is not a runtime-performance claim.

JSON/Markdown would require additional concurrent-write machinery. A local HTTP service adds an unnecessary daemon for the single-machine scope.

Project registration uses a central registry, not a marker inside a repository. A project is an explicitly registered directory, including a non-Git directory or monorepo subdirectory. Neither a Git root nor a Pi session is project identity.

## 3. Components and runtime

Keep the domain and storage code independent of Pi:

| Component | Responsibility |
| --- | --- |
| `modules/backlog/` | Registry, records, lifecycle/policy validation, transactional storage, and one shared service boundary; no Pi imports |
| `modules/backlog/cli.ts` + `bin/pi-backlog.mjs` | Standalone argument/input handling, JSON output, and executable bootstrap over that service |
| `extensions/backlog/` | Thin `/backlog` and model-tool adapters |
| `skills/backlog/SKILL.md` | Usage guidance, including ownership and recovery limitations |

Split the core into focused modules during planning; do not build a plugin/backend abstraction or duplicate rules in adapters.

Use Node's built-in `node:sqlite` on Node **22.19 or newer**, matching the installed Pi package's minimum. Keep TypeScript source loading and the repository's no-build development model. The standalone bootstrap uses a direct `jiti` dependency rather than relying on Pi's private/transitive dependencies. No native SQLite npm addon or Pi process is required by the CLI.

## 4. Data location and project registration

### Location

The default data root is `<Pi agent directory>/backlog`, normally `~/.pi/agent/backlog`. The Pi adapter obtains the agent directory through Pi's public API. The standalone CLI uses `PI_CODING_AGENT_DIR`, falling back to `~/.pi/agent`.

An explicit `--data-dir` (standalone) or `--backlog-data-dir` (Pi) overrides `PI_BACKLOG_DIR`, which overrides the default. The core library receives the resolved data root explicitly. All clients must use the same root to share projects; list/show output reports the resolved root.

```text
<data-root>/
  registry.sqlite
  projects/
    <project-uuid>/
      backlog.sqlite
```

SQLite may create WAL and shared-memory sidecars alongside these files. Data must reside on a local filesystem, not a shared/network filesystem. Do not put it under a package cache, `/tmp`, or a session directory.

### Registration behavior

```text
/backlog project register . --name pi-extensions
pi-backlog project register ~/work/my-app --name my-app
pi-backlog project list
```

Registration records a generated UUID, display name, canonical directory, timestamps, and registry revision. Names are display labels, not identity, and need not be unique. Explicit project selection uses the UUID; output always includes it.

- The target must exist and be a directory. Resolve relative paths against the caller's cwd and use `realpath` to resolve symlinks.
- A canonical directory belongs to exactly one registered project. Registering it again returns that registration without changing its name, policy, or backlog.
- Initialize a new project database before publishing its registry row. The registry's unique directory constraint resolves concurrent registration: one identity wins and all successful callers receive it. Unpublished databases left by a crash are not discoverable projects and must not be adopted implicitly.
- Opening an unregistered directory does not register it or create a backlog.
- Automatic selection finds the deepest registered ancestor of the canonical cwd using path-component containment, not string-prefix matching.
- An explicit `--project <uuid>` selects that project regardless of cwd. Unknown IDs fail; there is no fallback to another project.
- A nested registered directory wins over its parent. Worktrees outside the registered directory need explicit project selection; there is no Git-based association in v1.

`project rename` changes only the display name. `project relocate` explicitly replaces the registered directory while preserving the UUID and backlog. It validates the new directory, checks the expected registry revision, and rejects an already-registered target. Relocation changes metadata only; it neither moves files nor redirects a running worker. Callers must coordinate ongoing filesystem work separately.

A missing registered directory is reported as unavailable but does not delete or replace the project. Its backlog remains accessible by ID for inspection and maintenance. No unregister, purge, or automatic stale-project cleanup is included in v1.

## 5. Backlog item model

### Types and identity

- **Request:** an intended outcome, its scope, and acceptance criteria.
- **Task:** an executable unit of work, optionally belonging to one request.

The hierarchy is one level deep. A task cannot contain children, and a request cannot be another request's child. Standalone tasks are first-class. Item kind is immutable.

Each project allocates monotonically increasing item IDs such as `B-1`; IDs are never reused within retained database history. The durable external reference is `(project UUID, item ID)`. Restoring an older backup is an explicit rollback of that history, including counters and revisions (section 9).

### Stored fields

Every item has:

- ID, immutable kind, title, Markdown description, and an ordered list of acceptance criteria.
- Priority: `urgent`, `high`, `normal` (default), or `low`.
- Workflow version and current stage ID.
- Revision, scope revision, created/updated timestamps, and actor attribution.
- Append-only notes and result records; artifact references contain a label and a path or URI.

Tasks additionally have an optional parent request ID and a set of prerequisite task IDs. Requests and standalone tasks can override project authorization policy. Child tasks inherit their request's policy and cannot override it independently.

A title is enough to capture a draft. Entering a ready or active stage requires a nonempty description and at least one nonempty acceptance criterion. Dependencies may still be incomplete: readiness of the description and current execution eligibility are separate facts.

Text is data, not instructions for the tracker to execute. Artifact references are not fetched, opened, copied, or executed automatically. Relative paths are interpreted relative to the registered project directory when displayed to a caller; the stored reference remains unchanged on relocation.

### Relationships

- Parent and dependency references must resolve within the same project.
- Dependencies are task-to-task, reject self-reference and cycles, and are satisfied only by the prerequisite's `done` category. A canceled prerequisite is not successful completion.
- New children cannot be attached to terminal requests.
- Parent reassignment is permitted only while the task is in a draft-category stage and unclaimed. It increments the task's scope revision and invalidates any standalone authorization.
- Completing or canceling a request requires all children to be terminal and no unresolved claims. There is no automatic cascade.
- Completing all children does not complete the request. Request completion is a separate, explicit acceptance record.

No hard deletion or reopening of terminal items is included in v1. Their scope, relationships, workflow version, and item-level policy override are immutable; notes, artifact references, and priority may still be updated. Follow-up work is a new item with a reference to the previous one.

## 6. Configurable lifecycle, not a workflow runner

Each project has separate current workflow definitions for requests and tasks. Definitions are declarative data: stable stage IDs, display names, semantic categories, one initial stage, and allowed directed transitions. There are no expressions, hooks, embedded commands, or user-supplied executable code.

### Stable semantic categories

| Category | Meaning |
| --- | --- |
| `draft` | Captured or being refined; not claimable |
| `ready` | Defined work; task claims still depend on authorization and prerequisites |
| `active` | Work underway, including implementation, verification, or review |
| `blocked` | Explicitly paused; not claimable |
| `done` | Successfully completed and terminal |
| `canceled` | Abandoned with a reason and terminal |

Custom names do not change these meanings. For example, `testing`, `security_review`, and `human_review` can all be active-category stages. A name such as `human_review` alone does not add a new human-approval gate; v1 authorization is governed by the separate policy in section 7.

Every definition has an initial draft stage, at least one ready stage and one active stage, and exactly one stage each for blocked, done, and canceled. Stage IDs are unique. All stages must be reachable from the initial stage and have a path to a terminal stage. Terminal stages have no outgoing transitions. Rework cycles are allowed.

The graph must not allow a route from initial draft to done that bypasses ready and active categories. Custom transitions cannot bypass the fixed validation, authorization, dependency, ownership, or completion-record requirements.

### Default workflows

Requests:

| Stage | Category | Allowed next stages |
| --- | --- | --- |
| `inbox` | draft | shaping, canceled |
| `shaping` | draft | inbox, ready, blocked, canceled |
| `ready` | ready | shaping, delivering, blocked, canceled |
| `delivering` | active | shaping, done, blocked, canceled |
| `blocked` | blocked | shaping, canceled |
| `done` | done | none |
| `canceled` | canceled | none |

Tasks:

| Stage | Category | Allowed next stages |
| --- | --- | --- |
| `draft` | draft | ready, canceled |
| `ready` | ready | draft, implementing, blocked, canceled |
| `implementing` | active | verifying, blocked, canceled |
| `verifying` | active | implementing, done, blocked, canceled |
| `blocked` | blocked | draft, canceled |
| `done` | done | none |
| `canceled` | canceled | none |

Transitions are explicit operations with an expected item revision. Generic item updates cannot set stage, workflow version, revision counters, authorization, or ownership fields; those have dedicated operations. Blocked and canceled transitions require a reason. Task transitions into active or done categories require a valid claim; a claimed task's transitions require its current token. Entering blocked or a terminal stage releases a valid claim in the same transaction.

Task completion requires a result summary, a verification statement, and at least one evidence reference, as well as satisfied prerequisites. Request completion has the same result requirements and the child-terminal constraint. These are recorded assertions, not independently verified test results: the tracker does not run tests or judge natural-language acceptance criteria.

### Workflow changes

Workflow versions are immutable. Publishing a new version makes it the default for new items of that type; existing items stay pinned to their original definition for their entire lifetime. Old definitions remain readable and usable for transitions.

There is no migration operation, stage-mapping engine, or per-item version override in v1. Publishing a definition does not change existing items, claims, or approvals. Work requiring a different lifecycle is captured as a new item with a reference to the old one; cancel the old item explicitly if it is being replaced.

## 7. Authorization policy and scope

The project default is `approval_required`; an operator can select `autonomous`. Requests and standalone tasks can override the default. Children inherit their request's effective policy and authorization. Resolve policy on every relevant operation. **Ready is not authorized**: expose stage, policy, authorization, and eligibility reasons separately.

- Approval-based mode requires operator approval of a request or standalone task's current scope. Autonomous mode lets automation explicitly authorize that scope with a rationale; it does not silently authorize captured items.
- Both operations require a nonterminal request or standalone task with a nonempty description and acceptance criteria. Record actor/channel, timestamp, rationale, scope revision, and effective policy/version.
- Request approval covers children within that scope; children need no separate approval or prose binding. On every child claim, the caller supplies the expected request scope revision as well as the task's expected item revision. The transaction rejects stale references and records both scope revisions in the claim. This acknowledges current scope, not its semantic correctness. Assessing whether a task fits remains the caller's responsibility.

Title, description, acceptance criteria, parent, dependency, and item-policy changes increment scope revision and invalidate that item's authorization, if any. Request edits therefore invalidate the authority inherited by its children without rewriting child records. A child edit does not invalidate request approval; the next claim acknowledges the edited task and current request. Priority, notes, artifacts, and stage changes do not invalidate approval. Adding a child does not itself alter request scope.

Project policy changes invalidate authorizations of nonterminal items inheriting that policy; overrides and terminal history are unaffected. Reapplying an unchanged policy is a no-op. Changing an override invalidates that item's authorization even when the newly resolved policy has the same name.

While any claim is recorded, including an expired unresolved one, reject changes to that task's scope and to its governing request/project policy or request scope. An operator can still revoke authorization immediately: new claims, renewal, active transitions, and completion then fail. Revocation does not terminate workers; release and recovery remain available.

Request transitions into active/done require current authorization. Child claims and active/done transitions require a ready/active, authorized parent. Moving a request out of ready/active is rejected while a child has a recorded claim; release or recover first. Scope invalidation changes eligibility, not the displayed stage.

### Trusted-local boundary

Attribution is not authentication. Pi tools use automation attribution and cannot record human approval, change policy, register/relocate projects, or publish workflows. Operator controls are slash commands and CLI operations. Automated authorization is allowed only under autonomous policy; claiming a child under an approved request is allowed in either mode.

The CLI trusts its caller. A same-user process can invoke operator commands or edit the database. These checks protect cooperating clients, not a tamper-proof human-approval boundary.

## 8. Claims and concurrent workers

Only tasks have claims; requests use revision-checked edits. There is no worker registry, dispatcher, or automatic task selection.

A task is claimable when its category is ready/active, its description and acceptance criteria are present, its own or inherited authorization is current, its parent (if any) is ready/active, all prerequisites are done, and no claim is recorded—even an expired one.

`item list --eligible` is a candidate snapshot, not permission to execute. `claim acquire` rechecks eligibility and the expected item revision transactionally; child claims also require the expected parent scope revision. Only one competing owner can succeed. No separate binding command or binding store is needed.

A claim records task/parent scope revisions and returns worker label, lease ID, monotonically increasing generation, private token, and expiry. Default duration is 300 seconds; explicit durations are 30–3600 seconds. Renewal uses the original duration measured from renewal time.

- Tokens are cryptographically random (at least 256 bits), stored only in private claim/acquisition receipts, and returned only on acquisition or that caller's receipt replay. General reads, history, and diagnostics omit them.
- Renewal, claimed progress, release, and completion check lease ID, generation, token, and unexpired ownership transactionally. Renewal and active/done transitions recheck authorization. A revoked but unexpired owner can release.
- Heartbeats change lease data, not item revision. Progress and transitions still require expected item revisions. Scope stays frozen while a claim exists; other clients may append notes or change priority with revision checks.
- Release preserves stage. A new acquisition gets a new generation/token and rechecks eligibility. Done, blocked, and canceled transitions release valid ownership atomically.

### Heartbeat responsibility

The owner—not the model's next turn—must maintain the lease. Automated callers need renewal independent of model turns, normally before one third of the duration elapses. This feature supplies the renewal API, not a timer, heartbeat process, or runner integration.

Humans and Pi sessions without such a caller use the same lease protocol for bounded claimed work: choose an adequate duration, renew explicitly, and release before an extended wait once work has stopped. Ordinary capture/refinement needs no claim. Do not leave work running after release, or start an unattended operation likely to outlast the lease without a renewal mechanism. There is no nonexpiring manual-claim bypass.

On loss of ownership or inability to confirm renewal before expiry, the caller must stop further work and reconcile ownership before proceeding. Backlog checks fence database mutations, not filesystem effects or running commands; stopping those is the caller's responsibility. Pi startup, reload, and session restoration never renew claims automatically.

### Expiry and recovery

Expiry changes neither stage nor ownership record. Reads report `recovery_required`; expired tokens cannot renew, release, transition, or complete work, and another worker cannot claim it.

Explicit recovery supplies the observed lease ID/generation and a reason. It rejects live leases, closes an expired claim transactionally, preserves stage, and records history. Reclaiming is a separate normal acquisition. Recovery cannot prove an old worker stopped: confirm that and reconcile its effects before retrying. No automatic recovery or requeue runs in v1.

## 9. Transactions, history, and failure behavior

Use SQLite WAL mode, foreign-key enforcement, `synchronous=FULL`, parameterized SQL, and a 1000 ms busy timeout on every writable connection. Hold write transactions only around database work; never around prompts, model calls, file reads for CLI input, or external commands.

Each successful logical mutation and its audit event commit in one transaction. Current tables are the source of truth; the event log provides history, not a second event-sourced state engine.

Item revisions are monotonically increasing. Mutations to an item or its relationships require the expected revision; stale writes return a conflict with the actual revision and leave state unchanged. Ownership/authorization operations recheck the referenced item/scope/policy versions and their own records. Lease heartbeats do not invalidate an item editor's revision.

Events contain a project-local sequence, timestamp, operation, affected IDs, actor/channel, relevant revisions, reason, and changed fields. Authorization, policy, lifecycle publication, claims, renewal, release, and recovery are auditable. Registry metadata changes have corresponding events in the registry database. Ownership tokens are not included in events.

Mutating operations accept an optional caller-supplied mutation ID. Within the relevant database, persist a canonical payload digest and receipt in the same transaction as the operation. A matching retry returns the original receipt without repeating the change; reusing an ID with a different payload returns an error. Scope receipt keys by project (or registry) and caller identity/channel. Replayed lease receipts do not extend ownership: later token-bearing operations still enforce current expiry and generation. Persist receipts containing acquisition tokens privately with the same protections as the database; do not expose them through general history/list operations.

Errors have stable codes, a human-readable message, and structured details, including:

- `PROJECT_NOT_FOUND`, `PROJECT_UNREGISTERED`, `DIRECTORY_UNAVAILABLE`.
- `VALIDATION_ERROR`, `INVALID_TRANSITION`, `DEPENDENCY_CYCLE`.
- `REVISION_CONFLICT` (including a stale parent scope revision), `AUTHORIZATION_REQUIRED`.
- `CLAIM_CONFLICT`, `LEASE_EXPIRED`, `RECOVERY_REQUIRED`.
- `MUTATION_ID_CONFLICT`, `STORE_BUSY`, `STORE_CORRUPT`, `SCHEMA_UNSUPPORTED`.

A busy timeout produces a retryable error; there is no unbounded retry loop. Failed operations do not leave partial items, relationships, events, or receipts. Unknown/newer schema versions and corruption fail closed: never silently replace, reset, downgrade, or recreate a registered backlog. Registry and backlog schema versions start at 1; automatic schema upgrades are not part of v1.

The library creates private data directories/files (0700/0600 where supported), checks data-path containment, and does not derive filesystem names from item titles or project names. Existing data paths must not silently follow symlinks outside the configured store. SQLite sidecars and mutation receipts receive the same private storage protections. No project-local configuration is loaded or executed.

### Offline backup and restore

V1 documents an operator procedure, not a new backup service or command:

1. Stop every client/worker using the data root, close database connections, and prevent restarts for the entire copy. No worker may continue external side effects during restoration.
2. Copy the **entire data root** into a fresh private backup directory outside it: registry, every project database, and any remaining WAL/SHM sidecars. Never copy just a live `.sqlite` file or delete its WAL to make a backup. Only a completed copy is usable.
3. Validate the copy with SQLite integrity/foreign-key checks on each database and verify that every registry project has its database. Include these checks in the user guide; do not run normal backlog mutations against a backup.
4. To restore, keep clients stopped, preserve the current root separately, and restore into an empty root with private permissions. Never merge database files and sidecars from different snapshots. Validate before reopening.
5. Invalidate client caches and pending retry queues; do not replay pre-restore operations under old or fresh mutation IDs without reconciling retained state and external effects. Keep workers stopped until restored leases have expired, explicitly recover recorded claims, and acquire fresh claims only after reconciliation.

Restore rolls back the registry, items, ID counters, revisions, and mutation receipts together. Post-backup changes are lost; external references to post-backup work must be reconciled before reuse. It does not roll back project files or external actions, and does not preserve monotonic IDs or exactly-once behavior across that rollback. This procedure requires cooperative downtime, not a new global locking subsystem.

## 10. Public interfaces

### Shared service

All adapters use the same operation contracts and validators. Library callers supply a resolved data root, project selection, actor context, and operation input. Time and identity generation are injectable for deterministic tests. Core modules import neither Pi nor its session manager.

The supported integration surfaces are the library/service operations and the CLI, not direct SQL writes. Raw database schema is not a stable external API.

### Human commands and standalone CLI

The command families are shared between `/backlog ...` and `pi-backlog ...`:

| Family | Operations |
| --- | --- |
| project | register, list, show, rename, relocate, policy |
| item | add, list, show, update, transition |
| dependency | add, remove |
| note / artifact / result | append or attach, list |
| authorization | approve (operator), authorize (automation), revoke (operator) |
| claim | acquire, renew, release, recover |
| workflow | show, publish |
| history | list for project or item |

`/backlog` alone shows the selected project and a compact backlog summary. No custom board or full-screen UI is required. Lists filter by kind, category/stage, parent, priority, eligibility, and simple text search. Default ordering is priority, creation time, then item ID; default page size is 50, maximum 200, with an explicit continuation cursor. Empty results do not imply successful completion of anything.

CLI examples:

```text
pi-backlog project register . --name my-app
pi-backlog item add --kind request --title "Add authentication"
pi-backlog item list --kind task --eligible --json
pi-backlog item show B-12 --json
pi-backlog claim acquire B-12 --worker verifier-1 --expected-revision 7 --json
```

A child claim additionally supplies `--expected-parent-scope-revision <revision>` after inspecting its request. A stale value fails rather than silently accepting newer scope.

Long descriptions, workflow definitions, and transition/results payloads can be supplied as JSON using `--input <file>` or `--input -` for stdin. Validate input before beginning a transaction. Mutation IDs and expected revisions are explicit inputs. No input payload is evaluated as shell or JavaScript.

`--json` emits exactly one versioned envelope on stdout: `{apiVersion: 1, ok: true, data: ...}` or `{apiVersion: 1, ok: false, error: {code, message, details}}`. Diagnostics and Node warnings go to stderr. Exit codes are 0 for success, 2 for usage/validation, 3 for domain conflicts or unmet preconditions, and 1 for storage/runtime failures. JSON mode never prompts. Human-only operations are explicit commands, not ordinary item field updates.

For record text, cap title at 240 characters, each description/note/result text at 64 KiB UTF-8, and each criterion at 4096 characters with at most 100 criteria per item. Limit each mutation to 100 artifact references, with labels up to 240 characters and paths/URIs up to 4096 characters each. Lists and history are paginated. Pi tool text output additionally obeys Pi's 50 KiB/2000-line limit and clearly identifies truncation; structured results must also be bounded rather than hiding an unlimited backlog in tool details. Large text fields support chunked reads with explicit continuation so Pi can retrieve the complete value without one oversized tool result.

### Pi tools and lifecycle

Expose focused tools for reading, editing, autonomous authorization, and claims. Strict action schemas reuse service validation. No operator-only project/policy/workflow controls or human approval are model-callable. Tool guidance distinguishes backlog maintenance from execution permission and makes caller-owned renewal explicit.

Resolve project context from the operation's current `ctx.cwd`, unless an explicit project ID is provided. Never retain another session's project selection or replay session tool results into the database. Tool results may contain IDs, revisions, and display snapshots, but are not durable backlog state.

`session_start`, `/reload`, `/new`, `/resume`, `/fork`, and `/tree` neither replay mutations nor rewind the shared backlog. Open database connections lazily; close session-owned connections on shutdown/reload. No factory-time timers, background polling, queued continuation, automatic claims, or startup registration. Noninteractive operations must not depend on TUI dialogs.

## 11. Validation and testing

Use the repository's Vitest test command with temporary data roots. Test core behavior independently of Pi and test adapters against the same service contract.

Required coverage:

1. **Registration:** existing/nonexistent directories; symlink canonicalization; duplicate and simultaneous registration; nested directory precedence; component-boundary matching; explicit project selection; rename/relocation preserves identity and data; missing project directories do not erase backlogs.
2. **Isolation:** identical item IDs in different projects remain distinct; cross-project parent/dependency references fail; registry and project database selection never fall back silently.
3. **Records:** draft capture, readiness validation, immutable kinds, parent rules, dependency cycle rejection, canceled prerequisites, evidence requirements, terminal requests, and no implicit parent completion.
4. **Workflow:** default/custom graphs, category/edge validation, rework cycles, no bypass to done, and pinned definitions. Publishing affects only new items; old transitions and approvals remain valid. Generic updates cannot change an item's workflow version; migration is not exposed.
5. **Policy:** defaults/overrides, inheritance, operator approval versus autonomous authorization, scope/policy invalidation, and revocation during a claim. Child acquisition rejects missing/stale parent scope revisions and records current scope without a binding record or prose. Operator controls are absent from model tools.
6. **Concurrency:** genuinely separate OS processes competing to claim one task, edit the same revision, register the same directory, and replay the same mutation ID. In-memory queues alone are not sufficient evidence.
7. **Claims:** acquisition, caller-driven renewal, handoff, expiry after an extended wait, explicit recovery, generations, rejected stale tokens, authorization rechecks, and atomic completion/release. Test default/explicit durations with an injected clock, not sleeps; no adapter heartbeat is assumed.
8. **Durability:** rollback on process death before commit; receipt replay after a lost response; fresh-process reopen; corruption/schema rejection without reset. Exercise the offline backup/restore procedure, including committed WAL left by a crashed client, registry/project consistency, and restored-claim recovery.
9. **Interfaces:** equivalent CLI/Pi operations, stable JSON envelopes and exit codes, stdin/file inputs, bounded output, no interactive prompts in JSON mode, and clean error propagation.
10. **Pi lifecycle:** switching projects/sessions, reload cleanup, and session branching neither duplicate nor restore mutations. Startup/reload never claim, renew, recover, or execute work.

A manual Pi smoke test registers a temporary directory, adds a request and child task, reads/updates them with the standalone CLI, and confirms the same state in a fresh Pi session. A custom testing/review stage must work without changing the core implementation or launching a worker.

## 12. Repository fit and acceptance boundary

The current checkout provides useful durable-state and command/tool patterns but no dedicated backlog implementation. The subagent store is session-/runner-oriented, and research state is tied to research workspaces. Do not reuse either as the backlog's identity or source of truth, and do not refactor those subsystems for this feature.

The implementation will add the isolated core, thin adapters, tests, a paired guidance skill, a user guide, and package metadata needed for the standalone executable/runtime. This specification does not authorize changes to existing research/subagent behavior or automatic factory integration.

References consulted:

- Repository `README.md`, `package.json`, `extensions/subagent/identity.ts`, and `extensions/research/state.ts`.
- Installed Pi documentation: `README.md`, `docs/extensions.md`, `docs/packages.md`, and `docs/skills.md`.
- Installed Pi example `examples/extensions/todo.ts`: useful for command/tool shape, but its session-reconstructed persistence is deliberately not used here.
- Installed Pi 0.86.0 package metadata: Node minimum `>=22.19.0`.
- Beads comparison: [embedded/server architecture](https://github.com/gastownhall/beads/blob/main/docs/architecture/dolt.md) and [v1.3.0 claim leasing](https://github.com/gastownhall/beads/blob/v1.3.0/internal/storage/issueops/lease.go). Read-only evaluation, not a deployment benchmark.

The next gate is **user review of this written specification**. Only after that approval should the writing-plans skill produce an implementation plan. No implementation is part of this design task.
