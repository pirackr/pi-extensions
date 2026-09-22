# Project backlog store — design

Date: 2026-09-22

Status: Chat design approved; written specification awaiting user review.

## 1. Purpose and boundary

Build a durable, project-scoped backlog that people, Pi agents, and independent local processes can use. It will eventually supply work to a Software Factory, but **the backlog is the product being built now**. No factory or workflow runner is part of this specification.

The backlog accepts both high-level requests and implementation-ready tasks. Projects have configurable stages because the user's eventual development workflow is not yet known. Execution authorization can be approval-based or autonomous, independently of stage names.

Success means a user can register a directory, capture and refine work, configure its lifecycle, and inspect or update the same backlog from unrelated Pi sessions and standalone processes without losing updates.

### In scope

- Explicit project registration, stable project identity, and directory-based discovery.
- One SQLite backlog per project and a central project registry.
- Requests and tasks, acceptance criteria, priority, dependencies, and artifact references.
- Configurable project stages and transitions, with versioned definitions.
- Approval/autonomy policy, authorization records, and change history.
- Revision-checked mutations and basic task claims, renewal, release, and explicit recovery.
- Pi slash commands, model-callable tools, and a standalone JSON-capable CLI.

### Out of scope

Agent launching, scheduling, automatic decomposition, model calls, test execution, Git/worktree management, deployment, a background daemon, network access, multi-machine coordination, issue-tracker synchronization, a graphical board, nested epics, arbitrary workflow scripts/plugins, and a security boundary between processes running as the same OS user.

Adding an item, authorizing it, claiming it, opening Pi, or restoring a session never starts execution. A custom stage describes backlog state; it does not run an action.

## 2. Decisions and alternatives

The selected approach is **SQLite + a shared library + thin CLI and Pi adapters**. Transactions protect multiple processes on one machine without requiring a service.

JSON/Markdown files were considered for manual readability, but reliable concurrent writes and atomic ownership would require additional locking and recovery machinery. A local HTTP service would provide a remote integration boundary but adds an unnecessary daemon for the agreed single-machine scope.

Project registration uses a central registry, not a marker inside a repository. A project is an explicitly registered directory, including a non-Git directory or monorepo subdirectory. Neither a Git root nor a Pi session is project identity.

## 3. Components and runtime

Keep the domain and storage code independent of Pi:

| Component | Responsibility | Dependencies |
| --- | --- | --- |
| `modules/backlog/registry.ts` | Register, identify, rename, and relocate projects | Filesystem/path helpers and registry SQLite connection |
| `modules/backlog/workflows.ts` | Validate lifecycle definitions and legal transitions | Domain types; no Pi imports |
| `modules/backlog/policy.ts` | Resolve authorization policy and validate recorded authority | Domain types and project/item records |
| `modules/backlog/store.ts` | Transactional item, relationship, authorization, history, and claim operations | SQLite, policy, workflow validation |
| `modules/backlog/service.ts` | Validated operation boundary shared by adapters | Registry and store |
| `modules/backlog/cli.ts` | Argument parsing, input files/stdin, output envelopes, exit codes | Shared service; no Pi imports |
| `bin/pi-backlog.mjs` | Standalone executable bootstrap | Node and a directly declared `jiti` runtime dependency |
| `extensions/backlog/index.ts` and adapter modules | `/backlog`, tools, and Pi lifecycle integration | Shared service and Pi extension API |
| `skills/backlog/SKILL.md` | Guidance on project selection, records, policy, and safe updates | Public backlog interface documentation |

These are responsibility boundaries, not a requirement to put all storage operations in one large file. Split focused repositories or validators as the implementation grows; do not duplicate domain rules in adapters.

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

Each project allocates monotonically increasing item IDs such as `B-1`; IDs are never reused. The durable external reference is `(project UUID, item ID)`.

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
- Parent reassignment is permitted only while the task is in a draft-category stage and unclaimed. It invalidates the task's scope binding and any standalone authorization.
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

Workflow versions are immutable. Publishing a new version makes it the default for new items of that type; existing items remain pinned to their old version.

Migration is explicit, operates on a selected set of nonterminal items, and supplies an old-stage-to-new-stage mapping. All mapped stages must preserve semantic category. Validate the whole selected set and migrate it transactionally, or change none of it. Recorded claims, including expired unresolved claims, block migration of the task or its parent request.

Migration changes the execution contract and invalidates affected scope authorizations/bindings. It does not complete work, skip a gate, or reinterpret historical events. Old definitions remain available for interpreting existing items and history.

## 7. Authorization policy and scope

The project default is `approval_required`. An operator can set it to `autonomous`. Requests and standalone tasks can explicitly override that default; child tasks inherit their parent's effective policy. Resolve the effective policy on every relevant operation, not once in a worker's memory.

**Ready is not equivalent to authorized.** The API reports the stage, effective policy, current authorization, and eligibility reasons separately.

- In `approval_required` mode, an operator records approval of the current request or standalone task scope and acceptance criteria.
- In `autonomous` mode, an automation actor can record authorization itself, including its rationale. Autonomous policy permits this operation; it does not silently authorize every captured item.
- Approval of a request permits decomposition and execution of child tasks within its scope without individual human approval of every task.
- A child task must record a scope-binding statement referencing the current request scope revision and its own scope revision before it is claimable. The statement explains how the task fits the request. The tracker checks the references and their freshness, not their semantic truth.

Approval and automated authorization require a nonempty description and acceptance criteria, and apply only to nonterminal requests or standalone tasks. Authorization records include actor, source channel, timestamp, rationale, effective policy, and the authorized scope/policy versions. Project policy changes invalidate records for nonterminal items inheriting that policy; request overrides and terminal historical records are unaffected. Reapplying the same policy is a no-op.

Scope-affecting edits include title, description, acceptance criteria, parent/dependencies, workflow migration, and policy changes. They invalidate affected authorization or child scope bindings. Priority changes, appended notes, and artifact references do not invalidate approval. Adding a child within the approved scope does not itself invalidate the request's approval; that child still needs its own current scope binding.

A request's scope revision change invalidates its authorization and every child's binding to the old revision. A task scope change invalidates its own authorization or binding. Stage changes do not by themselves change scope. Invalidation changes eligibility, not the displayed stage automatically.

Executable scope is frozen while a task has a recorded claim, including an expired unresolved claim. Request scope/policy changes are similarly rejected while any affected child has such a claim. Project policy changes are rejected while any affected task has one. An operator may revoke authorization immediately; revocation prevents further claim renewal, active/completion transitions, and new claims, but does not terminate processes. Release and explicit recovery remain available so ownership can be cleared safely.

Request transitions into active/done require current authorization. A child task is eligible only while its request is ready or active and authorized. Moving a request out of ready/active is rejected while any child has a recorded claim; first revoke if necessary, then release or recover ownership. The factory, not the backlog, determines whether work is actually within scope or adequately verified.

### Trusted-local boundary

Actor attribution is an audit aid, not authentication. Pi tools always use automation attribution and cannot supply a human identity, record human approval, change policy, register/relocate projects, or publish/migrate workflows. Those are operator operations exposed by slash commands and the standalone CLI.

The CLI's operator interface assumes a trusted caller. A process with the same filesystem permissions can invoke it, import the library, or edit a database directly. The API checks protect cooperating clients; this design does not claim tamper-proof human approval or sandbox enforcement.

## 8. Claims and concurrent workers

Claims protect a **task**, independently of its current stage. Requests are edited through revision checks, not worker leases. There is no worker registry, dispatcher, background expiry timer, or automatic next-task selection.

A task is claimable when:

1. Its current category is ready or active.
2. Required scope fields and any parent scope binding are current.
3. Its effective authorization is current; its parent, if present, is ready or active.
4. All prerequisites are done.
5. No claim is recorded, including an expired unresolved claim.

`item list --eligible` reports candidates using these rules, but is only a snapshot. `claim acquire <id>` rechecks them transactionally and checks the supplied expected item revision. Concurrent attempts can yield only one successful owner.

A claim returns a worker label, lease ID, monotonically increasing claim generation, opaque ownership token, and expiry. The default lease duration is 300 seconds; callers may request 30–3600 seconds. The same duration is used for renewal, measured from the renewal time. A worker should renew before one third of its lease duration has elapsed.

- Generate a cryptographically random token of at least 256 bits. Keep it only in private claim/acquisition-receipt records. Return it only on acquisition or replay of that caller's acquisition receipt; omit it from general reads, history, and diagnostics.
- Renewal, claimed progress, release, and completion validate lease ID, generation, token, and unexpired ownership inside the transaction. Renewal additionally rechecks authorization. A revoked owner may still release an otherwise valid claim.
- Renewal changes lease data, not item content revision. Progress edits and transitions use expected item revisions normally.
- Content defining scope, dependencies, and workflow version cannot be changed while a claim is recorded. The owner can append progress/results and make legal transitions. Other clients can append notes and change priority with revision checks.
- A voluntary release preserves the current stage, allowing a handoff from one worker to another. The next claim gets a new token/generation and rechecks all eligibility conditions.
- Done, blocked, or canceled transitions close a valid claim atomically with the transition.

### Expiry and recovery

Expiry does not requeue a task or change its stage. Reads report the expired claim and `recovery_required`; a new worker cannot claim it. Expired tokens cannot renew, release, transition, or complete work.

An explicit recovery operation supplies the observed lease ID/generation and a reason. It rejects an unexpired lease, closes an expired claim transactionally, and preserves the stage. A subsequent claim is a separate operation with normal policy checks. No background process performs recovery. Historical ownership and recovery decisions remain visible.

A token fences backlog mutations, not filesystem or external side effects. Recovery cannot prove that an old process stopped. Worker termination, workspace isolation, and deciding whether retry is safe remain outside this tool.

## 9. Transactions, history, and failure behavior

Use SQLite WAL mode, foreign-key enforcement, `synchronous=FULL`, parameterized SQL, and a 1000 ms busy timeout on every writable connection. Hold write transactions only around database work; never around prompts, model calls, file reads for CLI input, or external commands.

Each successful logical mutation and its audit event commit in one transaction. Current tables are the source of truth; the event log provides history, not a second event-sourced state engine.

Item revisions are monotonically increasing. Mutations to an item or its relationships require the expected revision; stale writes return a conflict with the actual revision and leave state unchanged. Ownership/authorization operations recheck the referenced item/scope/policy versions and their own records. Lease heartbeats do not invalidate an item editor's revision.

Events contain a project-local sequence, timestamp, operation, affected IDs, actor/channel, relevant revisions, reason, and changed fields. Authorization, policy, lifecycle publication/migration, claims, renewal, release, and recovery are auditable. Registry metadata changes have corresponding events in the registry database. Ownership tokens are not included in events.

Mutating operations accept an optional caller-supplied mutation ID. Within the relevant database, persist a canonical payload digest and receipt in the same transaction as the operation. A matching retry returns the original receipt without repeating the change; reusing an ID with a different payload returns an error. Scope receipt keys by project (or registry) and caller identity/channel. Replayed lease receipts do not extend ownership: later token-bearing operations still enforce current expiry and generation. Persist receipts containing acquisition tokens privately with the same protections as the database; do not expose them through general history/list operations.

Errors have stable codes, a human-readable message, and structured details, including:

- `PROJECT_NOT_FOUND`, `PROJECT_UNREGISTERED`, `DIRECTORY_UNAVAILABLE`.
- `VALIDATION_ERROR`, `INVALID_TRANSITION`, `DEPENDENCY_CYCLE`.
- `REVISION_CONFLICT`, `AUTHORIZATION_REQUIRED`, `SCOPE_BINDING_STALE`.
- `CLAIM_CONFLICT`, `LEASE_EXPIRED`, `RECOVERY_REQUIRED`.
- `MUTATION_ID_CONFLICT`, `STORE_BUSY`, `STORE_CORRUPT`, `SCHEMA_UNSUPPORTED`.

A busy timeout produces a retryable error; there is no unbounded retry loop. Failed operations do not leave partial items, relationships, events, or receipts. Unknown/newer schema versions and corruption fail closed: never silently replace, reset, downgrade, or recreate a registered backlog. Registry and backlog schema versions start at 1; automatic schema upgrades are not part of v1.

The library creates private data directories/files (0700/0600 where supported), checks data-path containment, and does not derive filesystem names from item titles or project names. Existing data paths must not silently follow symlinks outside the configured store. SQLite sidecars and mutation receipts receive the same private storage protections. No project-local configuration is loaded or executed.

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
| authorization | approve (operator), authorize (automation), revoke, bind-scope |
| claim | acquire, renew, release, recover |
| workflow | show, publish, migrate |
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

Long descriptions, workflow definitions, transition/results payloads, and scope bindings can be supplied as JSON using `--input <file>` or `--input -` for stdin. Input is validated as data before beginning a transaction. Mutation IDs and expected revisions are explicit inputs. No input payload is evaluated as shell or JavaScript.

`--json` emits exactly one versioned envelope on stdout: `{apiVersion: 1, ok: true, data: ...}` or `{apiVersion: 1, ok: false, error: {code, message, details}}`. Diagnostics and Node warnings go to stderr. Exit codes are 0 for success, 2 for usage/validation, 3 for domain conflicts or unmet preconditions, and 1 for storage/runtime failures. JSON mode never prompts. Human-only operations are explicit commands, not ordinary item field updates.

For record text, cap title at 240 characters, each description/note/result text at 64 KiB UTF-8, and each criterion at 4096 characters with at most 100 criteria per item. Limit each mutation to 100 artifact references, with labels up to 240 characters and paths/URIs up to 4096 characters each. Lists and history are paginated. Pi tool text output additionally obeys Pi's 50 KiB/2000-line limit and clearly identifies truncation; structured results must also be bounded rather than hiding an unlimited backlog in tool details. Large text fields support chunked reads with explicit continuation so Pi can retrieve the complete value without one oversized tool result.

### Pi tools and lifecycle

Expose focused tools for reading, editing, authorization/binding under automation policy, and claim operations. Their action schemas are strict and reuse the service validation rules. Do not expose operator-only project/policy/workflow controls or human approval as model-callable actions. Tool descriptions and skill guidance explicitly distinguish backlog maintenance from permission to execute work.

Resolve project context from the operation's current `ctx.cwd`, unless an explicit project ID is provided. Never retain another session's project selection or replay session tool results into the database. Tool results may contain IDs, revisions, and display snapshots, but are not durable backlog state.

`session_start`, `/reload`, `/new`, `/resume`, `/fork`, and `/tree` neither replay mutations nor rewind the shared backlog. Open database connections lazily; close session-owned connections on shutdown/reload. No factory-time timers, background polling, queued continuation, automatic claims, or startup registration. Noninteractive operations must not depend on TUI dialogs.

## 11. Validation and testing

Use the repository's Vitest test command with temporary data roots. Test core behavior independently of Pi and test adapters against the same service contract.

Required coverage:

1. **Registration:** existing/nonexistent directories; symlink canonicalization; duplicate and simultaneous registration; nested directory precedence; component-boundary matching; explicit project selection; rename/relocation preserves identity and data; missing project directories do not erase backlogs.
2. **Isolation:** identical item IDs in different projects remain distinct; cross-project parent/dependency references fail; registry and project database selection never fall back silently.
3. **Records:** draft capture, readiness validation, immutable kinds, parent rules, dependency cycle rejection, canceled prerequisites, evidence requirements, terminal requests, and no implicit parent completion.
4. **Workflow:** default graphs, valid custom review stages, invalid categories/edges, rework cycles, no bypass to done, pinned historical versions, explicit category-preserving migrations, all-or-nothing migration failures, and rejection while claims exist.
5. **Policy:** project defaults, request/standalone overrides, child inheritance, human approval versus automated authorization, policy/scope invalidation, scope bindings, revocation during a claim, and the absence of operator actions from model tools.
6. **Concurrency:** genuinely separate OS processes competing to claim one task, edit the same revision, register the same directory, and replay the same mutation ID. In-memory queues alone are not sufficient evidence.
7. **Claims:** acquisition, renewal, active-stage handoff, expiry, explicit recovery, generations, rejected stale tokens, authorization rechecks, and atomic completion/release. Use an injected clock rather than sleeps for deterministic lease logic.
8. **Durability:** kill a process before a write transaction commits and verify rollback; retry after a committed mutation loses its response; reopen from a fresh process; reject corruption and unsupported schemas without resetting data.
9. **Interfaces:** equivalent CLI/Pi operations, stable JSON envelopes and exit codes, stdin/file inputs, bounded output, no interactive prompts in JSON mode, and clean error propagation.
10. **Pi lifecycle:** switching projects/sessions, reload cleanup, and session branching neither duplicates nor restores old mutations. Startup never claims or executes work.

A manual Pi smoke test registers a temporary directory, adds a request and child task, reads/updates them with the standalone CLI, and confirms the same state in a fresh Pi session. A custom testing/review stage must work without changing the core implementation or launching a worker.

## 12. Repository fit and acceptance boundary

The current checkout provides useful durable-state and command/tool patterns but no dedicated backlog implementation. The subagent store is session-/runner-oriented, and research state is tied to research workspaces. Do not reuse either as the backlog's identity or source of truth, and do not refactor those subsystems for this feature.

The implementation will add the isolated core, thin adapters, tests, a paired guidance skill, a user guide, and package metadata needed for the standalone executable/runtime. This specification does not authorize changes to existing research/subagent behavior or automatic factory integration.

References consulted:

- Repository `README.md`, `package.json`, `extensions/subagent/identity.ts`, and `extensions/research/state.ts`.
- Installed Pi documentation: `README.md`, `docs/extensions.md`, `docs/packages.md`, and `docs/skills.md`.
- Installed Pi example `examples/extensions/todo.ts`: useful for command/tool shape, but its session-reconstructed persistence is deliberately not used here.
- Installed Pi 0.86.0 package metadata: Node minimum `>=22.19.0`.

The next gate is **user review of this written specification**. Only after that approval should the writing-plans skill produce an implementation plan. No implementation is part of this design task.
