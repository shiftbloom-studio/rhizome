# rhizome.

rhizome is a long-horizon memory that belongs to a person, not to an agent. Claude, ChatGPT, Hermes, Cursor and your own agents all read and write the same memory, so each of them knows how you work, what you decided and what you prefer, whichever provider it comes from.

It runs entirely on Cloudflare: one Durable Object per person, Vectorize for semantic search, R2 for the raw history and Workers AI for embeddings and reranking. There is no server, database or GPU to run yourself, and an idle memory costs only its storage.

> Status: milestone 1 (store and find). Fact extraction, the temporal knowledge graph, the remote MCP server and the nightly reflection ("dreaming") follow in the next milestones. See [Roadmap](#roadmap).

## How it works

```
agents (any provider) ─> gateway worker ─> one MemoryObject per person (SQLite)
                         auth, scopes       episodes, notes, blocks, FTS5, audit log
                                                 │
                         ┌───────────────────────┼───────────────────────┐
                         v                       v                       v
                   R2 raw episodes      outbox ─> Workers AI bge-m3 ─> Vectorize
                                                  (namespace = person, filter = scope)

recall: bge-m3 + Vectorize ─┐
        FTS5 / BM25 ────────┼─> reciprocal rank fusion ─> bge-reranker ─> token budget ─> context
        recent items ───────┘
```

* **The person is the unit.** Every person gets one Durable Object. It is the single writer for all their memory, so Claude and Hermes never race each other.
* **Scopes** split the memory:
  * `profile`: working style, preferences, values. Every agent reads it.
  * `project:<slug>`: decisions and conventions of one project.
  * `agent:<slug>`: private notes of one agent, invisible to the others.
* **Clients** are agents of a provider (`claude-code` by `anthropic`, `hermes` by `nous`). Each has its own API key and grants that say which scopes it may read and write. Every memory records which agent, provider and model wrote it.
* **Lossless at the bottom.** Episodes are stored verbatim in R2. Chunks, notes and vectors are derived and can be rebuilt, for example after switching the embedding model.
* **Cheap reads.** Recall uses no generative model: an embedding, a vector query, SQLite full-text search and a small reranker.
* **Trust levels** on notes (`user_explicit`, `user_confirmed`, `agent_inference`, `tool`) feed ranking now and conflict resolution later: what you said yourself beats what an agent guessed.

## API

All memory endpoints take `Authorization: Bearer <client api key>`.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/v1/memory/episodes` | Store a conversation turn or any text (`messages` or `text`, optional `scope`, `sessionId`, `model`, `tEvent`) |
| `POST` | `/v1/memory/notes` | Store a note (`content`, `kind`: preference, decision, fact, learning, note; `trust`) |
| `POST` | `/v1/memory/recall` | Hybrid search (`query`, optional `scopes`, `project`, `limit`, `budgetTokens`) |
| `GET` | `/v1/memory/context` | Cache-friendly core for a system prompt: blocks plus the most trusted notes. Supports `ETag` |
| `GET` | `/v1/memory/blocks` | List working-memory blocks |
| `PUT` | `/v1/memory/blocks/:label` | Create or replace a block (`scope`, `value`, `charLimit`) |
| `GET` | `/v1/memory/episodes` | List episodes, newest first |
| `GET` | `/v1/memory/episodes/:id` | Raw episode from R2 |
| `DELETE` | `/v1/memory/items/:id` | Forget a note or a whole episode, everywhere |
| `GET` | `/v1/memory/export` | Page through everything the client may read |
| `GET` | `/v1/memory/stats` | Counts and database size |
| `GET` | `/v1/memory/me` | The calling client and its grants |

```sh
# remember something about yourself
curl -X POST https://memory.example.com/v1/memory/notes \
  -H "Authorization: Bearer $RHIZOME_KEY" -H "Content-Type: application/json" \
  -d '{"scope":"profile","kind":"preference","trust":"user_explicit","content":"Use the AGPL-3.0-or-later license for every project."}'

# ask from any other agent
curl -X POST https://memory.example.com/v1/memory/recall \
  -H "Authorization: Bearer $RHIZOME_KEY" -H "Content-Type: application/json" \
  -d '{"query":"Which license should this repo use?","budgetTokens":800}'
```

Admin endpoints (`/v1/admin/users`, `/v1/admin/clients`) create people and agent clients. They take `Authorization: Bearer <ADMIN_TOKEN>` and are disabled when no `ADMIN_TOKEN` secret is set.

## Self-hosting

You need a Cloudflare account with Workers Paid and a zone for the hostname.

1. **Create the resources**

   ```sh
   npm install
   npx wrangler d1 create rhizome-control
   npx wrangler r2 bucket create rhizome-episodes
   npx wrangler vectorize create rhizome-memory --dimensions=1024 --metric=cosine
   npx wrangler vectorize create-metadata-index rhizome-memory --propertyName=scope --type=string
   npx wrangler vectorize create-metadata-index rhizome-memory --propertyName=kind --type=string
   ```

2. **Fill in your settings.** `wrangler.jsonc` is a template with placeholders. Copy `.env.deploy.example` to `.env.deploy` and set your hostname and the D1 database id. `npm run deploy` renders them into `wrangler.deploy.jsonc`, which is not committed. In Workers Builds, set the same names as build variables.

3. **Deploy**

   ```sh
   npm run migrate
   npm run deploy
   npx wrangler secret put ADMIN_TOKEN    # any long random string
   ```

4. **Create yourself and your agents**

   ```sh
   curl -X POST https://memory.example.com/v1/admin/users \
     -H "Authorization: Bearer $ADMIN_TOKEN" -d '{"name":"me"}'
   curl -X POST https://memory.example.com/v1/admin/clients \
     -H "Authorization: Bearer $ADMIN_TOKEN" \
     -d '{"userId":"<id from above>","agent":"claude-code","provider":"anthropic"}'
   ```

   The response contains the client's API key once. Repeat for every agent.

If your zone challenges bots, add a WAF skip rule for requests to your hostname that carry an `Authorization` header, otherwise agents get a challenge page instead of JSON.

## Costs

Measured list prices on Workers AI and Vectorize (November 2026). An idle memory costs only storage, roughly $0.20 a month after a year of heavy use. Active use is dominated by the embedding of new episodes in milestone 1, and by fact extraction once milestone 4 lands. Details in [docs/m0-spike.md](docs/m0-spike.md).

## Roadmap

| Milestone | Scope |
| --- | --- |
| M0 | Spike: model comparison, FTS5 in Durable Objects, Vectorize latency ([results](docs/m0-spike.md)) |
| **M1** | **Store and find: gateway, MemoryObject with scopes, R2, Vectorize, hybrid recall, API keys** |
| M2 | Remote MCP server for Claude, ChatGPT and other MCP clients; import of CLAUDE.md and Hermes memory files |
| M3 | Evaluation harness (LongMemEval, LOCOMO, own data) in CI |
| M4 | Fact extraction and update resolver (add, update, invalidate) via Queues |
| M5 | Bi-temporal knowledge graph, entity resolution, as-of queries |
| M6 | Reflection and dreaming: profile distillation, decay, communities, block rewriting |
| M7 | Retrieval v2: query planning, deep mode, feedback |
| M8 | Procedural memory (skills) and a Hermes memory provider plugin |
| M9 | Memory explorer UI and a memory proxy for any OpenAI- or Anthropic-compatible client |
| M10 | Hosted version and control plane |

## License

[AGPL-3.0-or-later](LICENSE). If you run a modified version as a service, you share your changes under the same license.
