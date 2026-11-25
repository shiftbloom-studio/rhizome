-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Control plane. Holds identities and keys only, never memory content.

CREATE TABLE users (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- One client per agent of one provider, e.g. "claude-code" by "anthropic".
CREATE TABLE clients (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  agent      TEXT NOT NULL,
  provider   TEXT NOT NULL,
  grants     TEXT NOT NULL, -- JSON: {"read": [...patterns], "write": [...patterns]}
  created_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX clients_user ON clients (user_id);

-- API keys are stored as SHA-256 hashes. The plain key is shown once.
CREATE TABLE api_keys (
  hash         TEXT PRIMARY KEY,
  prefix       TEXT NOT NULL,
  client_id    TEXT NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER
);
CREATE INDEX api_keys_client ON api_keys (client_id);
