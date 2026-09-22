# Shared project backlog

The backlog is a trusted-local SQLite record system, **not a runner**. It never
launches workers, schedules jobs, renews leases, or interprets project files.
Authorization, lifecycle stage, and temporary ownership are separate.

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
