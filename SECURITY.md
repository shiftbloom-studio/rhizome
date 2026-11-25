# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Write to **safety@shiftbloom.studio**, or use GitHub's private vulnerability reporting: **Security → Report a vulnerability** on this repository. We answer within a few days and credit reporters who want to be credited.

## How rhizome is protected

rhizome stores what AI agents learn about a person, so it treats every memory as private data.

* **API keys per agent.** Every agent client has its own key. Keys are random 32-character secrets, stored only as SHA-256 hashes in D1 and shown once at creation. A key can be revoked on its own.
* **Scopes are enforced on the server.** A client can only read and write the scopes its grants allow. Another agent's private `agent:<id>` scope is never returned, not by recall, not by export.
* **One Durable Object per person.** Memory of different people never shares a database. The Durable Object refuses calls for a client of another user.
* **Vectorize namespaces.** Every vector query is pinned to the person's namespace and filtered by the allowed scopes.
* **Admin API is off by default.** `/v1/admin/*` only exists when the `ADMIN_TOKEN` secret is set, and the token is compared in constant time.
* **No second hostname.** `workers_dev` and preview URLs are disabled.
* **Browser sign-in is checked by the app.** The explorer and the OAuth consent page verify the Cloudflare Access JWT, rhizome's own HMAC-signed session cookie (HttpOnly, SameSite=Lax, seven days) or the sign-in proxy's header, depending on `AUTH_MODE`. The consent form carries a CSRF token keyed with a value only that sign-in knows, and cross-site form posts are refused.
* **Built-in password sign-in** compares hashes in constant time, allows 10 attempts a minute per client address and only redirects to paths on the same site.
* **Memories are data, not instructions.** Recall results carry their scope, source agent and trust level. Clients should present them to their model as quoted data.
* **Forget means delete.** `DELETE /v1/memory/items/:id` removes the item from SQLite, the full-text index, Vectorize and, for episodes, the raw copy in R2.

## Running it yourself on Node

* rhizome listens on `127.0.0.1` by default. Expose it through a reverse proxy with TLS, not directly.
* With `AUTH_MODE=proxy` rhizome only accepts the email header together with `PROXY_AUTH_SECRET` (32+ characters), or from a TCP peer in `PROXY_TRUSTED_IPS`. Without either, proxy mode stays off.
* Only set `TRUST_PROXY=true` when a proxy is the only way in. rhizome then takes the client address from the last `X-Forwarded-For` entry, which is the one the proxy added.
* Sessions are bound to `LOGIN_EMAIL`, `LOGIN_PASSWORD` and `SESSION_SECRET`: changing any of them signs everyone out. Sign-out only clears the cookie in that browser.
* `DATA_DIR` holds every memory in plain SQLite files and JSON. Protect it like a password store and encrypt its backups.

## Installation-specific values

`wrangler.jsonc` only contains placeholders. Hostname and D1 database id live in build variables or a local `.env.deploy`, which is git-ignored. None of these values is a credential, but they don't belong in a public template either.
