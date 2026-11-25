// SPDX-License-Identifier: AGPL-3.0-or-later
//
// SQLite schema of one person's memory (inside their Durable Object).
// Migrations run in order and are recorded in `meta.schema_version`.

export const MIGRATIONS: string[] = [
  // 1: episodes, searchable items, blocks, vector outbox, audit log
  `
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE episodes (
    id         TEXT PRIMARY KEY,
    scope      TEXT NOT NULL,
    session_id TEXT,
    client_id  TEXT NOT NULL,
    agent      TEXT NOT NULL,
    provider   TEXT NOT NULL,
    model      TEXT,
    t_event    INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    r2_key     TEXT NOT NULL,
    chars      INTEGER NOT NULL,
    preview    TEXT NOT NULL
  );
  CREATE INDEX episodes_scope_time ON episodes (scope, t_event DESC);

  -- Everything recall can return: episode chunks and notes.
  CREATE TABLE items (
    id            TEXT PRIMARY KEY,
    kind          TEXT NOT NULL CHECK (kind IN ('chunk', 'note')),
    episode_id    TEXT REFERENCES episodes (id) ON DELETE CASCADE,
    scope         TEXT NOT NULL,
    content       TEXT NOT NULL,
    note_kind     TEXT,
    trust         TEXT NOT NULL,
    client_id     TEXT NOT NULL,
    agent         TEXT NOT NULL,
    provider      TEXT NOT NULL,
    model         TEXT,
    t_event       INTEGER NOT NULL,
    created_at    INTEGER NOT NULL,
    access_count  INTEGER NOT NULL DEFAULT 0,
    last_accessed INTEGER
  );
  CREATE INDEX items_scope_time ON items (scope, t_event DESC);
  CREATE INDEX items_episode ON items (episode_id);

  CREATE VIRTUAL TABLE items_fts USING fts5 (
    content,
    content = 'items',
    content_rowid = 'rowid',
    tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER items_ai AFTER INSERT ON items BEGIN
    INSERT INTO items_fts (rowid, content) VALUES (new.rowid, new.content);
  END;
  CREATE TRIGGER items_ad AFTER DELETE ON items BEGIN
    INSERT INTO items_fts (items_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
  END;
  CREATE TRIGGER items_au AFTER UPDATE OF content ON items BEGIN
    INSERT INTO items_fts (items_fts, rowid, content) VALUES ('delete', old.rowid, old.content);
    INSERT INTO items_fts (rowid, content) VALUES (new.rowid, new.content);
  END;

  -- Working memory, always injected into the system prompt (Letta-style blocks).
  CREATE TABLE blocks (
    scope       TEXT NOT NULL,
    label       TEXT NOT NULL,
    value       TEXT NOT NULL,
    description TEXT,
    char_limit  INTEGER NOT NULL,
    version     INTEGER NOT NULL DEFAULT 1,
    updated_at  INTEGER NOT NULL,
    updated_by  TEXT NOT NULL,
    PRIMARY KEY (scope, label)
  );

  -- Pending Vectorize writes. Drained by the alarm so the index converges with SQLite.
  CREATE TABLE outbox (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    op         TEXT NOT NULL CHECK (op IN ('upsert', 'delete')),
    item_id    TEXT NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );

  -- Who read and wrote what. Shown in the memory explorer later.
  CREATE TABLE audit (
    seq       INTEGER PRIMARY KEY AUTOINCREMENT,
    at        INTEGER NOT NULL,
    client_id TEXT NOT NULL,
    action    TEXT NOT NULL,
    detail    TEXT
  );
  CREATE INDEX audit_time ON audit (at DESC);
  `,
  // 2: background intelligence: lifecycle, importance, local embeddings, links, entities, jobs
  `
  ALTER TABLE items ADD COLUMN status TEXT NOT NULL DEFAULT 'active'; -- active | disputed | superseded | archived
  ALTER TABLE items ADD COLUMN superseded_by TEXT;
  ALTER TABLE items ADD COLUMN origin TEXT NOT NULL DEFAULT 'agent'; -- agent | extracted | reflection | user | import
  ALTER TABLE items ADD COLUMN importance REAL NOT NULL DEFAULT 0.5;
  ALTER TABLE items ADD COLUMN confirmations INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE items ADD COLUMN updated_at INTEGER;
  CREATE INDEX items_status ON items (status, kind, scope);

  -- Embeddings kept next to the items: exact similarity for linking and
  -- deduplication without waiting for the vector index to catch up.
  CREATE TABLE embeddings (
    item_id TEXT PRIMARY KEY,
    model   TEXT NOT NULL,
    vec     BLOB NOT NULL
  );

  -- Typed edges between items and episodes: similar, derived_from, supersedes,
  -- contradicts, merged_into.
  CREATE TABLE links (
    src        TEXT NOT NULL,
    dst        TEXT NOT NULL,
    kind       TEXT NOT NULL,
    weight     REAL NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (src, dst, kind)
  );
  CREATE INDEX links_dst ON links (dst);

  -- Things the memory talks about: people, projects, tools, devices, orgs, concepts.
  CREATE TABLE entities (
    id         TEXT PRIMARY KEY,
    key        TEXT NOT NULL UNIQUE,
    name       TEXT NOT NULL,
    type       TEXT NOT NULL,
    mentions   INTEGER NOT NULL DEFAULT 0,
    first_seen INTEGER NOT NULL,
    last_seen  INTEGER NOT NULL
  );

  -- Which item or episode mentions which entity.
  CREATE TABLE mentions (
    ref       TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    PRIMARY KEY (ref, entity_id)
  );
  CREATE INDEX mentions_entity ON mentions (entity_id);

  -- Background work: fact extraction per episode, reflection runs.
  CREATE TABLE jobs (
    seq        INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT NOT NULL,
    ref        TEXT NOT NULL,
    attempts   INTEGER NOT NULL DEFAULT 0,
    not_before INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_error TEXT
  );
  CREATE INDEX jobs_due ON jobs (not_before);
  `,
];
