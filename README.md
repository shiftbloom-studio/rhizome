# rhizome.

rhizome is a long-horizon memory that belongs to a person, not to an agent. Claude, ChatGPT, Hermes, Cursor and your own agents all read and write the same memory, so each of them knows how you work, what you decided and what you prefer, whichever provider it comes from.

It runs entirely on Cloudflare: one Durable Object per person, Vectorize for semantic search, R2 for the raw history and Workers AI for embeddings and reranking. There is no server, database or GPU to run yourself, and an idle memory costs only its storage.

> Status: version 0.2. Store and find, fact extraction with conflict resolution, nightly reflection and a 3D memory explorer work. The remote MCP server and the bi-temporal knowledge graph come next. See [Roadmap](#roadmap).

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
* **Trust levels** on notes (`user_explicit`, `user_confirmed`, `agent_inference`, `tool`) feed ranking and conflict resolution: what you said yourself beats what an agent guessed.

## What happens in the background

Everything runs on Workers AI inside the person's Durable Object, triggered by its alarm.

1. **Extraction.** A few seconds after an episode arrives, DeepSeek V4.1 Flash turns it into short English notes (preference, decision, fact, learning) with a scope, a trust level and the people, projects and tools it mentions. An episode without user messages can never produce a note that claims the user said something.
2. **Resolution.** Each new fact is compared with the notes of its scope using the embeddings stored next to them, so nothing waits for the vector index.
   * At a similarity of 0.93 or more it is the same fact: the existing note gains a confirmation, and keeps the higher of both trust levels.
   * Between 0.78 and 0.93 the model decides between *same*, *update*, *contradicts* and *new*. An update replaces the old note (`superseded`), and recall follows the chain to the current version.
   * A guess never replaces what the person said. Such a conflict is stored as `disputed` and shown in the explorer for review, where confirming one side settles it.
3. **Linking.** New notes get `similar` edges to their nearest neighbours. Notes written directly through the API are merged with an existing equal note, or linked.
4. **Reflection**, nightly at 03:17 UTC and on demand:
   * Importance is recomputed from trust, confirmations, recall count and a decay whose half-life depends on trust (a year for what you said, two months for an agent's guess).
   * Episode chunks that are older than a year, were never recalled and are unimportant are archived. Their raw episode stays in R2.
   * Duplicates the day produced are merged.
   * GLM 5.3 rewrites the `distilled-profile` block from the profile notes, and a `summary` block for each changed project. It only runs when the notes changed.

Set `EXTRACTION=off` to store episodes without extraction, and `EXTRACTION_MODEL` or `REFLECTION_MODEL` to use other Workers AI models.

## Memory explorer

The web UI at `/` shows the memory as a 3D graph.

* Notes are coloured by trust, and their size follows importance.
* Conversations and the people, projects and tools they mention are nodes too.
* Search runs the same hybrid recall as the agents and shows the scores and sources of every result.
* A detail panel shows where a memory came from, what it replaced and what contradicts it. From there you can confirm or forget it, everywhere.
* You can also write notes about yourself, and start a reflection.

The explorer is meant to sit behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/applications/). The Worker verifies the Access token itself and opens the memory of the person whose email address matches the signed-in user. Without `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` its API answers 404.

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

Recall leaves out superseded and archived notes, and returns disputed ones with a lower score.

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

Admin endpoints (`/v1/admin/users`, `/v1/admin/clients`) create people and agent clients, and `PATCH /v1/admin/users/:id` with `{"email": "..."}` links a person to the address they sign in to the explorer with. They take `Authorization: Bearer <ADMIN_TOKEN>` and are disabled when no `ADMIN_TOKEN` secret is set.

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

2. **Fill in your settings.** `wrangler.jsonc` is a template with placeholders. Copy `.env.deploy.example` to `.env.deploy` and set your hostname and the D1 database id. Optional settings are the Access application of the explorer and the operator details for `/imprint` and `/privacy`; both pages answer 404 without them. `npm run deploy` renders everything into `wrangler.deploy.jsonc`, which is not committed. In Workers Builds, set the same names as build variables, use `npm ci && npm ci --prefix web && npm run build:web && npm run config` as the build command and `npx wrangler deploy -c wrangler.deploy.jsonc` as the deploy command.

3. **Deploy**

   ```sh
   npm run setup
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

5. **Protect the explorer.** Create a Cloudflare Access application for your hostname. Add a second one with a Bypass policy for `/v1/*`, `/privacy`, `/datenschutz`, `/imprint`, `/impressum`, `/fonts/*` and `/favicon.svg`, so agents and the legal pages stay reachable. Agents still need their API key. Then set `ACCESS_AUD` (the application's audience tag) and `ACCESS_TEAM_DOMAIN`.

If your zone challenges bots, add a WAF skip rule for requests to your hostname that carry an `Authorization` header, otherwise agents get a challenge page instead of JSON.

## Costs

Measured list prices on Workers AI and Vectorize (November 2026). An idle memory costs only storage, roughly $0.20 a month after a year of heavy use. Active use is dominated by fact extraction, about $0.0006 per short episode with DeepSeek V4.1 Flash, and by the nightly reflection, which only calls GLM 5.3 when notes changed. Details in [docs/m0-spike.md](docs/m0-spike.md).

## Roadmap

| Milestone | Scope |
| --- | --- |
| M0 | Spike: model comparison, FTS5 in Durable Objects, Vectorize latency ([results](docs/m0-spike.md)) |
| M1 | Store and find: gateway, MemoryObject with scopes, R2, Vectorize, hybrid recall, API keys |
| **0.2** | **First parts of M4, M6 and M9: extraction with conflict resolution, links, decay, nightly reflection, 3D memory explorer behind Access** |
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
