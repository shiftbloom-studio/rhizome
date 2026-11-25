# M0 spike results (2026-11-25)

The spike answered three questions before building on them: which Workers AI model extracts memory well enough, whether full-text search works inside a Durable Object, and how fast Vectorize is.

## Extraction models

Test set: 12 real episodes from one person's agent sessions (German and English, from Claude Code, ChatGPT and Hermes). They cover explicit rules, a decision that is later superseded, a relative date ("last Friday"), an agent's own observation and pure small talk. Every model got the same system prompt and had to return JSON with facts, scope, trust level and a resolved date. All 12 calls per model ran in parallel from a Workflow.

| Model | Valid JSON | Small talk ignored | Accepted proposal marked `user_confirmed` | "Last Friday" resolved | Meaning of the attribution rule kept | p50 latency | Price per M tokens (in / out) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `@cf/deepseek-ai/deepseek-v4.1-flash-1017` | 12/12 | yes | yes | yes | yes | 3.7 s | $0.30 / $1.20 |
| `@cf/zai-org/glm-5.3` | 11/12 | yes | yes | yes | yes | 6.1 s | $1.40 / $4.40 |
| `@cf/meta/llama-4-scout-17b-16e-instruct` | 12/12 | yes | yes | yes | no (inverted) | 4.2 s | $0.27 / $0.85 |
| `@cf/openai/gpt-oss-120b` | 12/12 | no (invented a fact) | no | yes | yes | 6.5 s | $0.35 / $0.75 |
| `@cf/mistralai/mistral-small-3.1-24b-instruct` | 12/12 | no (invented a fact) | yes | no (wrong day) | partly | 4.1 s | $0.351 / $0.555 |
| `@cf/openai/gpt-oss-20b` | 12/12 | not graded | | | | 10.8 s | $0.20 / $0.30 |
| `@cf/zai-org/glm-4.7-flash` | 11/12 | not graded | | | | 25.6 s | $0.0605 / $0.40 |
| `@cf/qwen/qwen3.8-27b` | 12/12 | not graded | | | | 23.7 s | $0.45 / $3.20 |
| `@cf/google/gemma-4-26b-a4b-it` | 12/12 | not graded | | | | 22.1 s | $0.10 / $0.30 |

Models with a p50 above 10 seconds were not graded in detail; they spend most of their tokens reasoning.

**Decision**

* **Extraction and update resolver (M4): DeepSeek V4.1 Flash.** Best result on every check, fastest, and its cached-input price ($0.006 per M) makes the fixed system prompt almost free. About $0.0006 per short episode in this test.
* **Reflection and dreaming (M6): GLM 5.3.** Same quality, 1M-token context for whole-history passes, too expensive per episode but fine for a nightly run. Fallback: DeepSeek V4.1 Flash. All of it stays on Workers AI.
* Both need schema validation and one retry, since even the best models produced one invalid JSON object in 24 calls.

## Full-text search in a Durable Object

SQLite-backed Durable Objects support FTS5 including `bm25()`, `snippet()`, prefix queries, the `unicode61 remove_diacritics` tokenizer and the `trigram` tokenizer. Queries over a small table take under 1 ms. rhizome uses an external-content FTS5 table kept in sync by triggers.

## Vectorize and Workers AI latency

Measured from a Worker in the same account:

| Step | Result |
| --- | --- |
| bge-m3 embedding, 6 texts in one call | 366 ms |
| bge-m3 embedding, 1 query | 91 ms |
| Vectorize upsert, 6 vectors | 1.4 s |
| **New vectors become queryable after** | **about 75 s** |
| Vectorize query, topK 20 with metadata filter, p50 / max of 10 | 78 ms / 241 ms |
| bge-reranker-base, 6 passages | 269 ms |

The 75-second indexing delay is why recall also searches FTS5 and the most recent items in SQLite: a memory written a moment ago is found right away, the vector index catches up later. bge-reranker-base returns small absolute scores (top hit 0.03), so rhizome normalises them against the best hit before mixing them with the fused rank.
