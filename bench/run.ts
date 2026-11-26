// SPDX-License-Identifier: AGPL-3.0-or-later
//
// rhizome benchmarks from the command line: npm run bench -- --help
// See bench/README.md.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { parseArgs } from "node:util";
import type { EpisodeInput } from "../src/memory-object";
import { LocalAi } from "../src/node/ai";
import { RECALL_FEATURES } from "../src/recall";
import { AiCache, BenchAi, DEFAULT_API_LIMIT, FakeAi, defaultRpm, type AiRunner } from "./ai";
import { readResults, runBenchmark, workerVars } from "./harness";
import { DATASET_FILE, DATASET_URL, loadDataset, select } from "./longmemeval";
import { compareRuns, comparisonMarkdown } from "./metrics";
import { MEMORY_VARS } from "./question";

const HELP = `rhizome benchmark: LongMemEval against rhizome's memory code

  npm run bench -- download                 fetch LongMemEval-S (cleaned) to bench/data/
  npm run bench -- [run] [options]          run the benchmark
  npm run bench -- compare <runA> <runB>    compare two runs (paired, McNemar's test)

Run options:
  --data <file>         dataset (default bench/data/${DATASET_FILE})
  --out <dir>           run directory (default bench/runs/<time>); an existing run is resumed
  --sample <n>          n questions, stratified by question type (--seed <n>, default 1)
  --limit <n>           the first n questions
  --questions <ids>     comma-separated question ids
  --types <types>       comma-separated question types, or "abstention"
  --extraction          extract notes from every session (slow: paid models allow 20 requests a minute)
  --features <list>     recall steps for every recall: ${RECALL_FEATURES.join(", ")}, all or none
                        (default: RECALL_FEATURES from the Worker's vars, as deployed)
  --chunking <mode>     episode chunking, fixed or rounds (default: CHUNKING, as deployed)
  --as-of               also send the question date as asOf (recall then adds an exact vector search)
  --concurrency <n>     questions in parallel (default 4)
  --max-minutes <n>     start no new question after n minutes; run again with the same --out to go on
  --cache <file>        AI cache (default bench/cache/ai.sqlite); --no-cache turns it off
  --ai <provider>       cloudflare (default), openai, or fake (offline smoke test, scores mean nothing)
  --rpm <model=n,...>   requests per minute per model (default 18 for paid models, 300 for others)
  --api-limit <n>       Cloudflare API requests per five minutes, all models together (default ${DEFAULT_API_LIMIT})
  --set KEY=VALUE       variable for the memory code, repeatable; overrides the Worker's vars
  --no-worker-vars      ignore the vars in wrangler.jsonc
  --env-file <file>     read environment variables from a file first
  --keep                keep each question's memory store in <out>/stores
  --force               resume even if the settings differ from the first run

Workers AI needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (Workers AI Read and Edit).
`;

function fail(message: string): never {
  console.error(`bench: ${message}`);
  process.exit(1);
  throw new Error(message);
}

const list = (v: string | undefined) => (v ? v.split(",").map((s) => s.trim()).filter(Boolean) : undefined);

function int(name: string, v: string | undefined): number | undefined {
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) fail(`--${name} must be a whole number, not "${v}"`);
  return n;
}

/** --features as a list; "none" turns every step off. A misspelt step would otherwise be dropped without a word. */
function featureList(v: string | undefined): string[] | undefined {
  if (v === "none") return [];
  const names = list(v);
  for (const name of names ?? []) {
    const key = name.toLowerCase();
    if (key !== "all" && !(RECALL_FEATURES as readonly string[]).includes(key)) {
      fail(`unknown recall step "${name}" in --features (known: ${RECALL_FEATURES.join(", ")}, all, none)`);
    }
  }
  return names;
}

function chunkingMode(v: string | undefined): EpisodeInput["chunking"] {
  if (v === undefined || v === "fixed" || v === "rounds") return v;
  fail(`--chunking must be fixed or rounds, not "${v}"`);
}

function commit(): string | undefined {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA;
  const git = spawnSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
  return git.status === 0 ? git.stdout.trim() : undefined;
}

function inner(kind: string): AiRunner {
  if (kind === "fake") return new FakeAi();
  if (kind === "cloudflare") {
    const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiKey = process.env.CLOUDFLARE_API_TOKEN;
    if (!accountId || !apiKey) fail("Workers AI needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN (an API token with Workers AI Read and Edit). See bench/README.md.");
    return new LocalAi({ provider: "cloudflare", accountId, apiKey });
  }
  if (kind === "openai") {
    if (!process.env.EMBEDDING_MODEL) fail("--ai openai needs EMBEDDING_MODEL (and RERANK_MODEL with AI_RERANK_URL for reranking)");
    return new LocalAi({ provider: "openai", baseUrl: process.env.AI_BASE_URL ?? "http://localhost:11434/v1", apiKey: process.env.AI_API_KEY, rerankUrl: process.env.AI_RERANK_URL });
  }
  fail(`--ai must be cloudflare, openai or fake, not "${kind}"`);
}

async function download(args: string[]) {
  const { values } = parseArgs({ args, options: { data: { type: "string" } } });
  const target = resolve(values.data ?? join("bench", "data", DATASET_FILE));
  mkdirSync(dirname(target), { recursive: true });
  console.log(`downloading ${DATASET_URL}`);
  const res = await fetch(DATASET_URL);
  if (!res.ok || !res.body) fail(`download failed: HTTP ${res.status}`);
  const part = `${target}.part`;
  await pipeline(Readable.fromWeb(res.body as never), createWriteStream(part));
  renameSync(part, target);
  const hash = createHash("sha256");
  await pipeline(createReadStream(target), hash);
  console.log(`saved ${target} (sha256 ${hash.digest("hex")})`);
}

async function compare(args: string[]) {
  const { positionals } = parseArgs({ args, allowPositionals: true });
  if (positionals.length !== 2) fail("compare needs two run directories: compare <runA> <runB>");
  const [a, b] = positionals.map((p) => join(resolve(p), "results.jsonl")) as [string, string];
  for (const file of [a, b]) if (!existsSync(file)) fail(`no results at ${file}`);
  const result = compareRuns(readResults(a), readResults(b));
  if (!result.questions) fail("the two runs have no scored question in common");
  process.stdout.write(comparisonMarkdown(result, positionals[0], positionals[1]));
}

async function run(args: string[]) {
  const { values } = parseArgs({
    args,
    options: {
      data: { type: "string" },
      out: { type: "string" },
      sample: { type: "string" },
      seed: { type: "string" },
      limit: { type: "string" },
      questions: { type: "string" },
      types: { type: "string" },
      extraction: { type: "boolean", default: false },
      features: { type: "string" },
      chunking: { type: "string" },
      "as-of": { type: "boolean", default: false },
      concurrency: { type: "string" },
      "max-minutes": { type: "string" },
      cache: { type: "string", default: join("bench", "cache", "ai.sqlite") },
      "no-cache": { type: "boolean", default: false },
      ai: { type: "string", default: "cloudflare" },
      rpm: { type: "string" },
      "api-limit": { type: "string" },
      set: { type: "string", multiple: true },
      "no-worker-vars": { type: "boolean", default: false },
      "env-file": { type: "string" },
      keep: { type: "boolean", default: false },
      force: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(HELP);
    return;
  }
  if (values["env-file"]) process.loadEnvFile(values["env-file"]);
  const features = featureList(values.features);
  const chunking = chunkingMode(values.chunking);

  const dataFile = resolve(values.data ?? join("bench", "data", DATASET_FILE));
  if (!existsSync(dataFile)) fail(`no dataset at ${dataFile}. Run: npm run bench -- download`);
  const dataset = await loadDataset(dataFile);
  const questions = select(dataset.questions, {
    ids: list(values.questions),
    types: list(values.types),
    sample: int("sample", values.sample),
    seed: int("seed", values.seed),
    limit: int("limit", values.limit),
  });
  if (!questions.length) fail("no question matches the selection");

  // Same configuration as the deployed Worker, then the environment, then --set.
  const vars: Record<string, string> = !values["no-worker-vars"] && existsSync("wrangler.jsonc") ? workerVars(readFileSync("wrangler.jsonc", "utf8")) : {};
  // Variables the memory code reads, taken from the environment when set.
  for (const key of MEMORY_VARS) if (process.env[key]) vars[key] = process.env[key]!;
  for (const pair of values.set ?? []) {
    const at = pair.indexOf("=");
    if (at < 1) fail(`--set needs KEY=VALUE, not "${pair}"`);
    vars[pair.slice(0, at)] = pair.slice(at + 1);
  }
  const rpm = new Map<string, number>();
  for (const pair of list(values.rpm) ?? []) {
    const at = pair.lastIndexOf("=");
    const n = Number(pair.slice(at + 1));
    if (at < 1 || !(n > 0)) fail(`--rpm needs model=requests per minute, not "${pair}"`);
    rpm.set(pair.slice(0, at), n);
  }

  const models = inner(values.ai);
  const cache = values["no-cache"] ? undefined : new AiCache(resolve(values.cache));
  // The offline stand-in has no limits to respect.
  const offline = values.ai === "fake";
  const ai = new BenchAi(models, {
    cache,
    rpm: (model) => rpm.get(model) ?? (offline ? Infinity : defaultRpm(model)),
    apiLimit: offline ? Infinity : int("api-limit", values["api-limit"]),
  });
  const out = resolve(values.out ?? join("bench", "runs", new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)));
  const maxMinutes = int("max-minutes", values["max-minutes"]);

  // A store closed after a timeout can still have an alarm in flight. Its error must not end a run of hours.
  process.on("unhandledRejection", (err: unknown) => console.error("background error:", err));

  let stop = false;
  process.on("SIGINT", () => {
    if (stop) process.exit(130);
    stop = true;
    console.log("\nstopping after the questions in progress (Ctrl+C again to quit now)");
  });

  console.log(`dataset ${dataFile} (${dataset.questions.length} questions), run ${out}`);
  const result = await runBenchmark(questions, {
    out,
    ai,
    vars,
    extraction: values.extraction,
    features,
    chunking,
    asOf: values["as-of"],
    concurrency: int("concurrency", values.concurrency),
    deadline: maxMinutes === undefined ? undefined : Date.now() + maxMinutes * 60_000,
    keepStores: values.keep,
    force: values.force,
    stopped: () => stop,
    settings: {
      dataset: dataset.sha256,
      ai: values.ai,
      vars,
      extraction: values.extraction,
      features: features ?? null,
      chunking: chunking ?? null,
      asOf: values["as-of"],
    },
    meta: { commit: commit() ?? null, node: process.version },
  });

  const calls = [...ai.stats.entries()].map(
    ([model, s]) =>
      `  ${model}: ${s.requests} requests (${s.retries} retries, ${s.failed} failed), ${s.cached} answers from the cache` +
      (s.texts ? `, ${s.cachedTexts} of ${s.texts} embeddings cached` : ""),
  );
  console.log(`\nWorkers AI:\n${calls.join("\n") || "  no calls"}`);
  if (cache) {
    const size = cache.size();
    console.log(`cache ${resolve(values.cache)}: ${size.embeddings} embeddings, ${size.outputs} other answers`);
    cache.close();
  }
  console.log(`\n${readFileSync(join(out, "summary.md"), "utf8")}`);
  if (result.remaining > 0) console.log(`${result.remaining} questions not done yet. Run the same command again to continue.`);
  writeFileSync(join(out, "ai-calls.json"), JSON.stringify(Object.fromEntries(ai.stats), null, 2) + "\n");
  if (result.summary.failed > 0) process.exitCode = 2;
}

const argv = process.argv.slice(2);
const command = argv[0] && !argv[0].startsWith("-") ? argv.shift()! : "run";
const commands: Record<string, (args: string[]) => Promise<void>> = { run, download, compare };
if (!commands[command]) fail(`unknown command "${command}"\n\n${HELP}`);
await commands[command]!(argv).catch((err: unknown) => {
  if (process.env.DEBUG) console.error(err);
  fail(err instanceof Error ? err.message : String(err));
});
