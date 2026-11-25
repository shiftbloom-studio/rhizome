-- SPDX-License-Identifier: AGPL-3.0-or-later
-- Links a person to the email address they sign in with through Cloudflare Access,
-- so the memory explorer can open their memory.
ALTER TABLE users ADD COLUMN email TEXT;
CREATE UNIQUE INDEX users_email ON users (email);
