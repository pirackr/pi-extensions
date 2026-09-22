export type StoreKind = 'registry' | 'project';
const common = `
CREATE TABLE metadata(key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
CREATE TABLE events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, operation TEXT NOT NULL, timestamp TEXT NOT NULL, actor TEXT NOT NULL, payload TEXT NOT NULL) STRICT;
CREATE TABLE receipts(actor TEXT NOT NULL, channel TEXT NOT NULL, mutation_id TEXT NOT NULL, digest TEXT NOT NULL, receipt TEXT NOT NULL, PRIMARY KEY(actor,channel,mutation_id)) STRICT;
`;
const registry = `
CREATE TABLE projects(id TEXT PRIMARY KEY, name TEXT NOT NULL, directory TEXT NOT NULL UNIQUE, revision INTEGER NOT NULL CHECK(revision>0), created_at TEXT NOT NULL, updated_at TEXT NOT NULL) STRICT;
`;
const project = `
CREATE TABLE counters(name TEXT PRIMARY KEY, value INTEGER NOT NULL CHECK(value>=0)) STRICT;
INSERT INTO counters VALUES ('items',0);
CREATE TABLE workflows(kind TEXT NOT NULL CHECK(kind IN ('request','task')), version INTEGER NOT NULL CHECK(version>0), definition TEXT NOT NULL, PRIMARY KEY(kind,version)) STRICT;
CREATE TABLE items(
 id TEXT PRIMARY KEY, number INTEGER NOT NULL UNIQUE, kind TEXT NOT NULL CHECK(kind IN ('request','task')),
 title TEXT NOT NULL, description TEXT NOT NULL, criteria TEXT NOT NULL,
 priority TEXT NOT NULL CHECK(priority IN ('urgent','high','normal','low')), workflow_version INTEGER NOT NULL, stage TEXT NOT NULL,
 revision INTEGER NOT NULL CHECK(revision>0), scope_revision INTEGER NOT NULL CHECK(scope_revision>0),
 parent_id TEXT REFERENCES items(id), policy_override TEXT CHECK(policy_override IN ('approval_required','autonomous')),
 created_at TEXT NOT NULL, updated_at TEXT NOT NULL, created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
 FOREIGN KEY(kind,workflow_version) REFERENCES workflows(kind,version)
) STRICT;
CREATE INDEX items_parent ON items(parent_id);
CREATE INDEX items_order ON items(priority,created_at,number);
CREATE TABLE dependencies(task_id TEXT NOT NULL REFERENCES items(id), prerequisite_id TEXT NOT NULL REFERENCES items(id), CHECK(task_id<>prerequisite_id), PRIMARY KEY(task_id,prerequisite_id)) STRICT;
CREATE TABLE annotations(id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL REFERENCES items(id), kind TEXT NOT NULL CHECK(kind IN ('note','artifact','result')), body TEXT NOT NULL, timestamp TEXT NOT NULL, actor TEXT NOT NULL) STRICT;
CREATE INDEX annotations_item ON annotations(item_id,id);
CREATE TABLE authorizations(id INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL REFERENCES items(id), scope_revision INTEGER NOT NULL, policy TEXT NOT NULL, policy_version TEXT NOT NULL, rationale TEXT NOT NULL, actor TEXT NOT NULL, timestamp TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0 CHECK(revoked IN (0,1))) STRICT;
CREATE INDEX authorization_item ON authorizations(item_id,id);
CREATE TABLE current_authorizations(item_id TEXT PRIMARY KEY REFERENCES items(id), authorization_id INTEGER NOT NULL REFERENCES authorizations(id)) STRICT;
CREATE TABLE generations(item_id TEXT PRIMARY KEY REFERENCES items(id), value INTEGER NOT NULL CHECK(value>0)) STRICT;
CREATE TABLE claims(item_id TEXT PRIMARY KEY REFERENCES items(id), lease_id TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL CHECK(generation>0), token TEXT NOT NULL, worker TEXT NOT NULL, expires_at INTEGER NOT NULL, duration_seconds INTEGER NOT NULL CHECK(duration_seconds BETWEEN 30 AND 3600), task_scope_revision INTEGER NOT NULL, parent_scope_revision INTEGER) STRICT;
`;
export function schema(kind: StoreKind): string { return common + (kind==='registry' ? registry : project); }
