# Benchmarks

`bench/` scores rhizome on [LongMemEval](https://github.com/xiaowu0162/LongMemEval) (ICLR 2025): 500 questions about a person's past chats, each with its own history of about 50 sessions (roughly 115k tokens). The dataset marks the sessions and turns that hold each answer, so retrieval is scored from these labels, without an LLM judge.

Every question runs in a fresh `MemoryObject` on the Node stand-ins from `src/node/` (SQLite, files, exact vector search), with the same Workers AI models as the Worker. Its sessions are saved as episodes at their original dates, and the question is asked through the same `recall` an agent calls, dated to the day it was asked. Nothing touches a deployed rhizome or anyone's memory. The same questions also run on Cloudflare itself, with Durable Objects, Vectorize and Workers AI: see [On Cloudflare](#on-cloudflare).

## Run it

You need Node 26, your Cloudflare account ID and an API token with **Workers AI - Read** and **Workers AI - Edit**. The dashboard creates one: Workers AI > Use REST API > Create a Workers AI API Token.

```sh
npm ci
npm run bench -- download                      # LongMemEval-S, cleaned (a few hundred MB), to bench/data/
export CLOUDFLARE_ACCOUNT_ID=...                # never commit these
export CLOUDFLARE_API_TOKEN=...
npm run bench -- --sample 50                    # 50 questions, stratified by type
npm run bench                                   # all 500
```

A run writes to `bench/runs/<time>/` (or `--out <dir>`):

| File | Content |
| --- | --- |
| `summary.md`, `summary.json` | scores overall and per question type |
| `results.jsonl` | one line per question: scores, the top ten sessions, timings |
| `config.json` | settings, dataset hash, commit |
| `ai-calls.json` | requests, retries and cache hits per model |

Run the same command with the same `--out` to continue a stopped run; finished questions are skipped, failed ones are tried again. `--max-minutes <n>` stops starting new questions after n minutes, which keeps a run inside a CI job limit.

`npm run bench -- --help` lists every option. The ones that change what is measured:

| Option | Effect |
| --- | --- |
| `--extraction` | Extracts notes from every session, as in production. Without it, recall searches the session chunks only. |
| `--reflect` | Runs one nightly reflection per question after its sessions, before recall. Use it with `--extraction`; compare `--set DISPUTE_RESOLUTION=on` against `off` to measure dispute resolution. Each reflection can also call the reflection model once for the profile summary. |
| `--features <list>` | Recall steps for every recall, or `none`. Default: `RECALL_FEATURES` from the Worker's vars in `wrangler.jsonc`, so a run measures what is deployed. |
| `--chunking <mode>` | Episode chunking. Default: `CHUNKING` from the Worker's vars. |
| `--set KEY=VALUE` | Any other variable for the memory code, e.g. `EMBEDDING_MODEL`. |
| `--as-of` | Also sends the question date as `asOf` (what was true then). Agents recall without it, and with it recall adds an exact search over the stored vectors. The date always goes as `referenceTime`, which anchors words like "last week". |

`--ai fake` runs offline with bag-of-words embeddings. It tests the harness, its scores say nothing about rhizome.

## Scores

Abstention questions (ids ending in `_abs`) have no evidence and get no retrieval scores. With the `abstain` recall step on, the summary reports how often recall returned nothing for them, and for answerable questions.

| Metric | Meaning |
| --- | --- |
| `recall_any@k` | An evidence session is among the first k sessions recall returned (unique sessions, in order of their first item). |
| `recall_all@k` | All evidence sessions are among the first k. |
| `ndcg_any@k` | nDCG over the same session ranking, with LongMemEval's weights. |
| `turn_recall@k` | Share of the evidence turns that the first k items cover (half of the turn, or 300 characters of it). |
| `delivered_*` | The same for what a default recall hands an agent: limit 10, a 2,000-token budget. `delivered_tokens` is its size. `delivered_turns_all`: every evidence turn is there. |
| `reader_*` | The same for what the recall tool hands an agent (8 items, 4,000 tokens), which is what the reader answers from. Runs with a reader only. |

The ranking comes from a recall with limit 50 that asks for plain excerpts (`cards: false`), which today returns at most 24 items after reranking. A turn card counts for the turns it shows; a part of a reply counts for the whole reply. A note counts for the sessions it was extracted from. When the `abstain` step returns nothing for an answerable question, every score of that question is a miss, as it would be for an agent.

## Compare two runs

```sh
npm run bench -- compare bench/runs/<before> bench/runs/<after>
```

The table shows every metric for both runs over the questions both scored. For the yes/no metrics it counts the questions that got better and worse and gives the p-value of McNemar's exact test. At 100 questions a difference has to be large to mean anything; use the full set before deciding.

## Cache, rate limits and time

Every Workers AI answer is stored in `bench/cache/ai.sqlite`: embeddings per text, everything else per model and exact input. A rerun with unchanged inputs makes no model calls and scores the same. A change to chunking, prompts or recall only pays for the inputs it changes. `--no-cache` turns it off, `--cache <file>` moves it. With every chunk of LongMemEval-S in it, the file grows to roughly 1 GB.

Calls stay under the Workers AI limits: 18 requests a minute for models that need the Workers Paid plan (the extraction and reflection models), 300 for the others, and 1,000 requests per five minutes in total, below the Cloudflare API limit of 1,200. Rate limits, timeouts and server errors are retried with backoff. `--rpm` and `--api-limit` change the limits.

Rough times on an empty cache: a retrieval run over all 500 questions makes about 6,000 embedding calls and takes about 30 to 60 minutes. With `--extraction` every session is one or two calls to the extraction model, so the 18-a-minute limit sets the pace: about 8 hours for 150 questions and more than a day for all 500. On a full cache both take minutes.

## On Cloudflare

`bench/worker.ts` runs the benchmark on Cloudflare, as the Worker `rhizome-bench` (`wrangler.bench.jsonc`). A Workflow takes the questions of a run, one step each and several at a time. Every question gets a fresh Durable Object with rhizome's memory code, its own namespace in a Vectorize index of its own, and Workers AI through the binding: the services the deployed Worker uses, with its `RECALL_FEATURES` and `CHUNKING` (a test keeps them equal to `wrangler.jsonc`). When a question is done, its vectors, raw episodes and storage are deleted. The Worker has no route; runs are started and read with Wrangler, the dashboard or the Cloudflare API.

Once per account:

```sh
npx wrangler r2 bucket create rhizome-bench
npx wrangler vectorize create rhizome-bench --dimensions 1024 --metric cosine
npx wrangler vectorize create-metadata-index rhizome-bench --propertyName scope --type string
npx wrangler vectorize create-metadata-index rhizome-bench --propertyName kind --type string
npx wrangler deploy -c wrangler.bench.jsonc
```

Create the metadata indexes before the first run: Vectorize filters only the vectors written after them.

A run is an instance of the Workflow, and the instance id names it:

```sh
npx wrangler workflows trigger rhizome-bench '{"sample": 10}' --id smoke
npx wrangler workflows trigger rhizome-bench '{"features": "none", "chunking": "fixed"}' --id baseline
npx wrangler workflows trigger rhizome-bench '{"baseline": "baseline"}' --id deployed
```

The first run copies LongMemEval-S from Hugging Face into the bucket (`data/`), one object per question; later runs reuse it. The params are checked before any question runs, so a typo fails the run at once:

| Param | Effect |
| --- | --- |
| `questions`, `types`, `sample`, `seed`, `limit` | Which questions, as with the options of the same names. Default: all 500. |
| `features` | Recall steps for every recall: a list, `"all"` or `"none"`. Default: `RECALL_FEATURES`, as deployed. |
| `chunking` | `"fixed"` or `"rounds"`. Default: `CHUNKING`, as deployed. |
| `extraction` | `true` extracts notes from every session. |
| `reflect` | `true` runs one nightly reflection per question after its sessions, before recall. Use it with `extraction`; `vars.DISPUTE_RESOLUTION` (default as deployed) decides whether disputes are settled. |
| `asOf` | `true` also sends the question date as `asOf`. |
| `vars` | Other variables for the memory code, e.g. `{"RERANK_MODEL": "..."}`. Another embedding model needs an index of its dimensions. |
| `concurrency` | Questions at a time: 8 (at most 32), or 4 with extraction (at most 8). |
| `paidRpm` | Requests a minute to each paid model, for all questions together. Default 15: the account allows 20, and the deployed rhizome needs some of them. |
| `baseline` | The id of an earlier run, compared with this one in `comparison.md`. |
| `reader` | An OpenAI model, e.g. `"gpt-4o-2024-08-06"`: LongMemEval's own evaluation, see below. Needs the Worker secret `OPENAI_API_KEY`. |
| `embeddingCache` | Default `true`: every question's embeddings are kept in the bucket under `cache/embeddings/` and reused, so a rerun embeds only texts it has not seen. A full run fills about 1 GB. `false` embeds everything again. |

The instance's output is the summary. The files go to `runs/<id>/` in the bucket: `config.json`, `results.jsonl`, `summary.json`, `summary.md` and, with `baseline`, `comparison.md`.

```sh
npx wrangler workflows instances describe rhizome-bench deployed
npx wrangler r2 object get rhizome-bench/runs/deployed/summary.md --remote --pipe
```

Every run also writes LongMemEval's own session-level retrieval scores (`recall_any`, `recall_all` and `ndcg_any` at 1, 3, 5, 10, 30 and 50) to `results.jsonl` and `summary.md`. They count what `src/retrieval/run_retrieval.py` counts: a session is evidence when its id has `answer` in it and one of its user turns has `has_answer`, and questions without such a turn (most single-session-assistant ones) and abstention questions are left out. rhizome ranks only what it recalls (50 items), so the sessions it did not recall follow in history order.

### LongMemEval's own evaluation

With `reader`, every question is also answered and judged the way LongMemEval's own scripts do it ([xiaowu0162/LongMemEval](https://github.com/xiaowu0162/LongMemEval) at commit `9e0b455`), so the score compares with published LongMemEval results:

1. rhizome recalls as its recall tool does for an agent (8 items in 4,000 tokens) and the reader gets that text in the prompt of `src/generation/run_generation.py` with its default reading method (`con`: answer step by step, at most 800 tokens, temperature 0), with the question's date as the current date.
2. GPT-4o (`gpt-4o-2024-08-06`) judges the answer with the prompt of `src/evaluation/evaluate_qa.py` for the question's type, temperature 0, at most 10 tokens. A reply with "yes" in it counts as correct.
3. `official.md` and `official.json` hold the averages of `src/evaluation/print_qa_metrics.py`: accuracy per question type, task-averaged, overall and on abstention questions.

```sh
npx wrangler secret put OPENAI_API_KEY -c wrangler.bench.jsonc
npx wrangler workflows trigger rhizome-bench '{"sample": 20, "reader": "gpt-4o-2024-08-06"}' --id official-smoke
npx wrangler workflows trigger rhizome-bench '{"reader": "gpt-4o-2024-08-06", "concurrency": 32}' --id official
```

The run directory then also holds the files the upstream scripts write and read, byte for byte: `hypotheses.jsonl` (the answers, as `run_generation.py` writes them) and `hypotheses.jsonl.eval-results-gpt-4o` (the verdicts, as `evaluate_qa.py` writes them). Anyone can judge the answers again with the upstream scripts:

```sh
python3 src/evaluation/evaluate_qa.py gpt-4o hypotheses.jsonl longmemeval_s_cleaned.json
python3 src/evaluation/print_qa_metrics.py hypotheses.jsonl.eval-results-gpt-4o longmemeval_s_cleaned.json
```

`qa.jsonl` has every question's answer, verdict, the models OpenAI named and the tokens; `contexts.jsonl` has what the reader got. A full run of 500 questions with GPT-4o as reader and judge sends about 2 million tokens to OpenAI. The prompts and scores are checked against the upstream code in `test/bench-official.test.ts`; `bench/official-fixture.py` writes its fixture from an upstream checkout.

A question gets three tries, each on a fresh memory; one that fails every time is recorded with its error, and the run goes on. Nothing is cached here, so every run pays for its own Workers AI calls. A question takes about three minutes without extraction, most of it waiting for Vectorize to make its vectors searchable, so all 500 questions take about three hours at the default concurrency of 8; more at a time (up to 32) shortens that. With extraction, the paid-model limit sets the pace: about 10 hours for 150 questions. Deploy before a run, not during one: a deploy resets the Durable Objects of the questions in progress, and they start over.

## On GitHub

The Benchmark workflow (Actions > Benchmark > Run workflow) runs the same command on a GitHub-hosted runner. It needs the repository secrets `CLOUDFLARE_ACCOUNT_ID` and `CLOUDFLARE_API_TOKEN`, keeps the AI cache between runs, writes the summary to the job page and uploads the run directory as an artifact. One job stops starting questions after 300 minutes; run the workflow again to go on from the cache.

## How this differs from production

* On Node, vector search is exact, while Vectorize is approximate and makes new vectors searchable after about a minute. A Node run measures ranking, not Vectorize. On Cloudflare, a question waits until Vectorize has applied its vectors, as it would have long before an agent asks about months-old chats.
* A question replays months of sessions within minutes, so the nightly reflection (merging, decay, summaries, disputes) does not run between them. `--reflect` (on Cloudflare: the param `reflect`) runs it once, after the last session and as of the question's date, so the sessions are as old as they were then.
* The dataset's dates have no time zone and are read as UTC.
