-- SPDX-License-Identifier: AGPL-3.0-or-later
-- A readable label per API key and an optional expiry (milliseconds since the epoch).
ALTER TABLE api_keys ADD COLUMN label TEXT;
ALTER TABLE api_keys ADD COLUMN expires_at INTEGER;
