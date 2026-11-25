# Security policy

## Reporting a vulnerability

Please do not open a public issue for security problems. Use GitHub's private vulnerability reporting instead: **Security → Report a vulnerability** on this repository. We answer within a few days and credit reporters who want to be credited.

## How rhizome is protected

rhizome stores what AI agents learn about a person, so it treats every memory as private data.

* **API keys per agent.** Every agent client has its own key. Keys are random 32-character secrets, stored only as SHA-256 hashes in D1 and shown once at creation. A key can be revoked on its own.
* **Scopes are enforced on the server.** A client can only read and write the scopes its grants allow. Another agent's private `agent:<id>` scope is never returned, not by recall, not by export.
* **One Durable Object per person.** Memory of different people never shares a database. The Durable Object refuses calls for a client of another user.
* **Vectorize namespaces.** Every vector query is pinned to the person's namespace and filtered by the allowed scopes.
* **Admin API is off by default.** `/v1/admin/*` only exists when the `ADMIN_TOKEN` secret is set, and the token is compared in constant time.
* **No second hostname.** `workers_dev` and preview URLs are disabled.
* **Memories are data, not instructions.** Recall results carry their scope, source agent and trust level. Clients should present them to their model as quoted data.
* **Forget means delete.** `DELETE /v1/memory/items/:id` removes the item from SQLite, the full-text index, Vectorize and, for episodes, the raw copy in R2.

## Installation-specific values

`wrangler.jsonc` only contains placeholders. Hostname and D1 database id live in build variables or a local `.env.deploy`, which is git-ignored. None of these values is a credential, but they don't belong in a public template either.
