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
  // 3: time-aware notes. valid_from/valid_to say when a fact was true in the
  // world, created_at/expired_at say when rhizome held the row as current. An
  // update closes the old note's interval; the old note itself stays.
  `
  ALTER TABLE items ADD COLUMN valid_from INTEGER; -- when the fact became true (defaults to t_event); NULL = unknown start
  ALTER TABLE items ADD COLUMN valid_to INTEGER;   -- when it stopped being true; NULL = still true
  ALTER TABLE items ADD COLUMN expired_at INTEGER; -- when rhizome stopped treating the row as current; NULL = current
  CREATE INDEX items_valid ON items (kind, valid_from);
  CREATE INDEX items_expired ON items (expired_at);

  -- Inserts that leave valid_from empty take the event time. A fact that came with
  -- only an end date ("until March") keeps an open, unknown start.
  CREATE TRIGGER items_valid_from AFTER INSERT ON items WHEN new.valid_from IS NULL AND new.valid_to IS NULL BEGIN
    UPDATE items SET valid_from = new.t_event WHERE rowid = new.rowid;
  END;

  -- Backfill, without a model: every row became true at its event time.
  UPDATE items SET valid_from = t_event WHERE valid_from IS NULL;
  -- Replaced and merged rows stopped being current when they were last touched.
  UPDATE items SET expired_at = COALESCE(updated_at, created_at) WHERE status = 'superseded' AND expired_at IS NULL;
  -- Only a real update (a supersedes edge) ends the old fact's validity. A merged
  -- duplicate is still true, it just lives on in its survivor, and the losing side
  -- of a dispute the person settled was never true, so both keep valid_to empty.
  UPDATE items SET valid_to = MAX(
      valid_from,
      COALESCE((SELECT n.valid_from FROM items n WHERE n.id = items.superseded_by), COALESCE(updated_at, created_at))
    )
    WHERE status = 'superseded' AND valid_to IS NULL
      AND EXISTS (SELECT 1 FROM links l WHERE l.kind = 'supersedes' AND l.dst = items.id AND l.src = items.superseded_by)
      AND NOT EXISTS (
        SELECT 1 FROM links c WHERE c.kind = 'contradicts'
          AND ((c.src = items.id AND c.dst = items.superseded_by) OR (c.dst = items.id AND c.src = items.superseded_by))
      );
  `,
  // 4: fact keys. Episode chunks are also found through the facts extracted
  // from them (recall feature "keys"). Keyed by the chunk's rowid.
  `
  CREATE VIRTUAL TABLE chunk_keys USING fts5 (
    keys,
    tokenize = 'unicode61 remove_diacritics 2'
  );
  CREATE TRIGGER items_keys_ad AFTER DELETE ON items WHEN old.kind = 'chunk' BEGIN
    DELETE FROM chunk_keys WHERE rowid = old.rowid;
  END;
  `,
  // 5: walls. A wall groups project scopes of one client; a scope is behind at most one wall.
  `
  CREATE TABLE walls (
    scope      TEXT PRIMARY KEY,
    wall       TEXT NOT NULL,
    created_at INTEGER NOT NULL
  ) WITHOUT ROWID;
  CREATE INDEX walls_wall ON walls (wall);
  `,
  // 6: held promotions. A fact from a walled conversation that would have left the
  // wall (usually for the profile) stays in its project until the person releases it.
  `
  CREATE TABLE promotions (
    seq         INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id     TEXT NOT NULL,
    from_scope  TEXT NOT NULL,
    to_scope    TEXT NOT NULL,
    via         TEXT NOT NULL,             -- extraction | remember | import
    state       TEXT NOT NULL DEFAULT 'held', -- held | released | dismissed
    created_at  INTEGER NOT NULL,
    decided_at  INTEGER
  );
  CREATE INDEX promotions_state ON promotions (state, seq);
  CREATE INDEX promotions_item ON promotions (item_id);
  `,
  // 7: which wall each conversation was given memory from (walls rule 2).
  // conversation is h:<client>:<handle> or c:<client> for calls without a handle.
  `
  CREATE TABLE wall_reads (
    conversation TEXT NOT NULL,
    wall         TEXT NOT NULL,
    scope        TEXT NOT NULL,
    last_at      INTEGER NOT NULL,
    PRIMARY KEY (conversation, wall)
  ) WITHOUT ROWID;
  CREATE INDEX wall_reads_time ON wall_reads (last_at);
  `,
  // 8: ledger. Which connector was given which memory, and whether it was told
  // that the memory changed since (see ledger.ts). One row per (memory, connector).
  `
  CREATE TABLE deliveries (
    item_id      TEXT NOT NULL,
    client_id    TEXT NOT NULL,
    agent        TEXT NOT NULL,
    provider     TEXT NOT NULL,
    scope        TEXT NOT NULL,
    first_at     INTEGER NOT NULL,
    last_at      INTEGER NOT NULL,
    times        INTEGER NOT NULL DEFAULT 1,
    corrected_at INTEGER,
    PRIMARY KEY (item_id, client_id)
  ) WITHOUT ROWID;
  CREATE INDEX deliveries_pending ON deliveries (client_id, corrected_at);
  `,
  // 9: open loops (see loops.ts). due_at works like a note's valid_from: the loop
  // applies from then on (NULL = the next time its scope is loaded); closed_at ends it.
  `
  CREATE TABLE loops (
    id         TEXT PRIMARY KEY,
    scope      TEXT NOT NULL,
    content    TEXT NOT NULL,
    due_at     INTEGER,
    client_id  TEXT NOT NULL,
    agent      TEXT NOT NULL,
    provider   TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    closed_at  INTEGER,
    closed_by  TEXT,
    outcome    TEXT
  );
  CREATE INDEX loops_open ON loops (scope, due_at) WHERE closed_at IS NULL;
  `,
  // 10: standing orders (src/orders.ts): rules the person stated, checked against
  // tool calls, and the calls they stopped. A strike keeps the tool name, never its input.
  `
  CREATE TABLE orders (
    id         TEXT PRIMARY KEY,
    scope      TEXT NOT NULL,
    says       TEXT NOT NULL,
    action     TEXT NOT NULL,              -- deny | ask | warn
    rule       TEXT NOT NULL,              -- JSON: the when clauses
    state      TEXT NOT NULL,              -- active | proposed | disabled
    created_by TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX orders_scope ON orders (scope, state);

  CREATE TABLE order_strikes (
    seq       INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id  TEXT NOT NULL,
    at        INTEGER NOT NULL,
    client_id TEXT NOT NULL,
    tool      TEXT NOT NULL,
    action    TEXT NOT NULL,
    session   TEXT
  );
  CREATE INDEX order_strikes_order ON order_strikes (order_id, at);
  CREATE INDEX order_strikes_time ON order_strikes (at);
  `,
  // 11: records (src/records.ts). One typed row per note: what kind of thing it is about
  // (category, broader tags), how much and when, so recall and agents can list, count and
  // sum every note of a kind. The note stays the source of truth: when it is deleted or its
  // text changes, its record goes and the note is filed again. type 'none' marks a note the
  // model could not file, so it is not asked again until the note changes.
  `
  CREATE TABLE records (
    item_id     TEXT PRIMARY KEY,
    type        TEXT NOT NULL,             -- event | state | preference | other | none
    category    TEXT NOT NULL,
    tags        TEXT NOT NULL DEFAULT '',  -- broader labels, joined by " | " (also in record_tags)
    quantity    REAL,
    unit        TEXT,
    occurred_at INTEGER,                   -- when it happened or became true, if the note says
    model       TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );
  CREATE INDEX records_category ON records (category, occurred_at);

  -- The broader labels of each record, for lookups by label.
  CREATE TABLE record_tags (
    label   TEXT NOT NULL,
    item_id TEXT NOT NULL,
    PRIMARY KEY (label, item_id)
  ) WITHOUT ROWID;
  CREATE INDEX record_tags_item ON record_tags (item_id);
  CREATE TRIGGER records_tags_ad AFTER DELETE ON records BEGIN
    DELETE FROM record_tags WHERE item_id = old.item_id;
  END;

  -- Labels (categories and tags) with their embeddings, matched against the query.
  CREATE TABLE record_labels (
    label TEXT PRIMARY KEY,
    model TEXT NOT NULL,
    vec   BLOB NOT NULL
  ) WITHOUT ROWID;

  CREATE TRIGGER items_records_ad AFTER DELETE ON items BEGIN
    DELETE FROM records WHERE item_id = old.id;
  END;
  CREATE TRIGGER items_records_au AFTER UPDATE OF content ON items BEGIN
    DELETE FROM records WHERE item_id = new.id;
  END;

  -- Existing memory: write every vector again (stored embeddings, no model calls) so it
  -- carries the event day, and file every note.
  INSERT INTO outbox (op, item_id, created_at) SELECT 'upsert', id, 0 FROM items;
  INSERT INTO jobs (kind, ref, not_before, created_at) SELECT 'type', 'all', 0, 0 WHERE EXISTS (SELECT 1 FROM items WHERE kind = 'note');
  `,
];
