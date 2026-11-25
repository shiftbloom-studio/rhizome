-- SPDX-License-Identifier: AGPL-3.0-or-later
-- OAuth 2.1 for MCP connectors (Claude, ChatGPT and other MCP clients).
-- Access tokens are ordinary API keys with a short expiry (label "oauth"), so
-- revoking a client in the token manager also ends every OAuth connection of it.

-- Dynamically registered OAuth clients (RFC 7591).
CREATE TABLE oauth_clients (
  id            TEXT PRIMARY KEY,
  secret_hash   TEXT,           -- NULL for public clients (PKCE only)
  name          TEXT NOT NULL,
  redirect_uris TEXT NOT NULL,  -- JSON array, matched exactly
  created_at    INTEGER NOT NULL
);

-- One approval by the person: links an OAuth client to a rhizome client.
-- Holds the pending authorization code and the current refresh token, both hashed.
CREATE TABLE oauth_grants (
  id                 TEXT PRIMARY KEY,
  oauth_client_id    TEXT NOT NULL REFERENCES oauth_clients (id) ON DELETE CASCADE,
  client_id          TEXT NOT NULL REFERENCES clients (id) ON DELETE CASCADE,
  code_hash          TEXT UNIQUE,
  code_challenge     TEXT,
  redirect_uri       TEXT,
  code_expires_at    INTEGER,
  refresh_hash       TEXT UNIQUE,
  refresh_expires_at INTEGER,
  created_at         INTEGER NOT NULL,
  revoked_at         INTEGER
);
CREATE INDEX oauth_grants_client ON oauth_grants (client_id);
CREATE INDEX oauth_grants_oauth_client ON oauth_grants (oauth_client_id);
