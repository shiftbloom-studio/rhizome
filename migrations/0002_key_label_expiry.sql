-- SPDX-License-Identifier: AGPL-3.0-or-later
-- A key can carry a label ("laptop", "ci") and an expiry date. Expired keys are refused.
ALTER TABLE api_keys ADD COLUMN label TEXT;
ALTER TABLE api_keys ADD COLUMN expires_at INTEGER; -- epoch ms, NULL = never
