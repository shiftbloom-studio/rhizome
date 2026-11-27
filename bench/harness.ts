// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Runs LongMemEval against rhizome's own memory code. Every question gets a
// fresh MemoryObject on the Node stand-ins (SQLite, files, exact vector
// search), is fed its sessions at their original dates and is then asked the
// question through the same recall an agent calls. No deployed rhizome and no
// real memory is involved.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Env } from "../src/env";
import { MemoryObject, type EpisodeInput } from "../src/memory-object";
import { DEFAULT_GRANTS, type Client } from "../src/scopes";
import { LocalBucket } from "../src/node/blobs";
import { LocalNamespace } from "../src/node/durable";
import { LocalVectorIndex } from "../src/node/vectors";
import { stableJson, type AiRunner } from "./ai";
import { isAbstention, typeKey, type Question } from "./longmemeval";
import { latestRecords, parseResults, summarize, summaryMarkdown, type ResultRecord, type Summary } from "./metrics";
import { askQuestion } from "./question";

export interface BenchOptions {
  /** Run directory with config.json, results.jsonl, summary.json and summary.md. An existing run is resumed. */
  out: string;
  ai: AiRunner;
  /** Variables for the memory code, e.g. EMBEDDING_MODEL or RECALL_FEATURES. */
  vars?: Record<string, string>;
  /** Extract notes from every session. Default off: recall searches the session chunks only. */
  extraction?: boolean;
  /** Run one reflection after a question's sessions, before recall. Default off. */
  reflect?: boolean;
  /** Recall steps, sent with every recall (RecallInput.features). Unset: the memory code's default (RECALL_FEATURES); [] turns all off. */
  features?: string[];
  /** Episode chunking, sent with every session (EpisodeInput.chunking). Unset: the memory code's default (CHUNKING). */
  chunking?: EpisodeInput["chunking"];
  /** Also send the question date as asOf (see QuestionOptions.asOf). Default off. */
  asOf?: boolean;
  /** Questions in parallel. Default 4. */
  concurrency?: number;
  /** Epoch ms after which no new question starts. */
  deadline?: number;
  /** Longest wait per question for embeddings and extraction to finish. */
  idleTimeoutMs?: number;
  /** Keep each question's memory store in <out>/stores. */
  keepStores?: boolean;
  /** Stored in config.json by the first run and compared on every resume. */
  settings?: Record<string, unknown>;
  /** Stored in config.json by the first run, not compared (commit, Node version). */
  meta?: Record<string, unknown>;
  /** Resume even when the settings differ. */
  force?: boolean;
  log?: (line: string) => void;
  /** Checked before every new question, e.g. after Ctrl+C. */
  stopped?: () => boolean;
}

/** One question on its own Node stores, removed afterwards unless keepStores is set. */
async function runQuestion(q: Question, opts: BenchOptions, runId: string, storesDir: string): Promise<ResultRecord> {
  const dir = join(storesDir, q.question_id.replace(/[^A-Za-z0-9_-]/g, "_"));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const vectors = new LocalVectorIndex(join(dir, "vectors.sqlite"));
  let env: Env;
  const memory = new LocalNamespace(join(dir, "memory"), MemoryObject, () => env);
  env = {
    ...opts.vars,
    EXTRACTION: opts.extraction ? "on" : "off",
    // One question replays months of sessions at once; the per-day cap is for live use.
    EXTRACTION_DAILY_LIMIT: "1000000",
    MEMORY: memory,
    EPISODES: new LocalBucket(join(dir, "episodes")),
    VECTORS: vectors,
    AI: opts.ai,
  } as unknown as Env;
  try {
    const client: Client = {
      id: "bench",
      userId: `eval-${q.question_id.replace(/[^A-Za-z0-9_-]/g, "_")}`,
      name: "LongMemEval",
      agent: "bench",
      provider: "longmemeval",
      grants: DEFAULT_GRANTS,
    };
    const stub = memory.get(memory.idFromName(`eval:${runId}:${q.question_id}`));
    return await askQuestion(stub, client, q, {
      features: opts.features,
      chunking: opts.chunking,
      asOf: opts.asOf,
      reflect: opts.reflect,
      idleTimeoutMs: opts.idleTimeoutMs ?? (opts.extraction ? 3_600_000 : 900_000),
    });
  } finally {
    memory.close();
    vectors.close();
    if (!opts.keepStores) rmSync(dir, { recursive: true, force: true });
  }
}

/** Walks JSON text, handing every character outside strings to `other`, which returns what to keep. */
function outsideStrings(text: string, other: (i: number) => { keep: string; skip?: number }): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      // Copy the string as it is, stepping over escapes like \".
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === "\\" ? 2 : 1;
      out += text.slice(i, end + 1);
      i = end + 1;
      continue;
    }
    const r = other(i);
    out += r.keep;
    i += 1 + (r.skip ?? 0);
  }
  return out;
}

/**
 * The plain values of the Worker's "vars" in wrangler.jsonc, without the <PLACEHOLDERS> that
 * deploys fill in. A run uses them, so it measures the configuration that is deployed.
 */
export function workerVars(jsonc: string): Record<string, string> {
  const noComments = outsideStrings(jsonc, (i) => {
    if (jsonc.startsWith("//", i)) {
      const end = jsonc.indexOf("\n", i);
      return { keep: "\n", skip: (end < 0 ? jsonc.length : end) - i };
    }
    if (jsonc.startsWith("/*", i)) {
      const end = jsonc.indexOf("*/", i + 2);
      return { keep: " ", skip: (end < 0 ? jsonc.length : end + 1) - i };
    }
    return { keep: jsonc[i]! };
  });
  const json = outsideStrings(noComments, (i) => ({ keep: noComments[i] === "," && /^\s*[}\]]/.test(noComments.slice(i + 1)) ? "" : noComments[i]! }));
  const vars = (JSON.parse(json) as { vars?: Record<string, unknown> }).vars ?? {};
  return Object.fromEntries(Object.entries(vars).flatMap(([k, v]) => (typeof v === "string" && !/^<[A-Z0-9_]+\??>$/.test(v) ? [[k, v]] : [])));
}

export function readResults(file: string): ResultRecord[] {
  if (!existsSync(file)) return [];
  return parseResults(readFileSync(file, "utf8"));
}

function describe(r: ResultRecord): string {
  if (r.error) return `FAILED: ${r.error}`;
  const parts: string[] = [];
  if (r.metrics) parts.push(`top-5 ${r.metrics["recall_any@5"] ? "hit" : "miss"}`, `delivered ${r.metrics.delivered_any ? "yes" : "no"}`);
  else parts.push("abstention question");
  if (r.abstained !== undefined) parts.push(`abstained ${r.abstained ? "yes" : "no"}`);
  return parts.join(", ");
}

export async function runBenchmark(
  questions: Question[],
  opts: BenchOptions,
): Promise<{ summary: Summary; records: ResultRecord[]; remaining: number }> {
  const log = opts.log ?? ((line: string) => console.log(line));
  mkdirSync(opts.out, { recursive: true });
  const configFile = join(opts.out, "config.json");
  const resultsFile = join(opts.out, "results.jsonl");
  const settings = opts.settings ?? {};
  let runId: string;
  if (existsSync(configFile)) {
    const config = JSON.parse(readFileSync(configFile, "utf8")) as { runId: string; settings: Record<string, unknown>; meta?: Record<string, unknown> };
    if (stableJson(config.settings) !== stableJson(settings) && !opts.force) {
      throw new Error(
        `${opts.out} was started with other settings. Use a new --out, or --force to continue anyway.\n` +
          `  first run: ${stableJson(config.settings)}\n  this run:  ${stableJson(settings)}`,
      );
    }
    if (config.meta?.commit && opts.meta?.commit && config.meta.commit !== opts.meta.commit) {
      log(`note: this run started on commit ${String(config.meta.commit)}, the code is now at ${String(opts.meta.commit)}`);
    }
    runId = config.runId;
  } else {
    runId = basename(resolve(opts.out)).replace(/[^A-Za-z0-9_-]/g, "-") || "run";
    writeFileSync(configFile, JSON.stringify({ runId, created: new Date().toISOString(), settings, meta: opts.meta ?? {} }, null, 2) + "\n");
  }

  const done = new Set(latestRecords(readResults(resultsFile)).filter((r) => !r.error).map((r) => r.id));
  const todo = questions.filter((q) => !done.has(q.question_id));
  log(`${questions.length} questions: ${questions.length - todo.length} already done, ${todo.length} to run`);

  const storesDir = join(opts.out, "stores");
  const started = Date.now();
  let next = 0;
  let finished = 0;
  const worker = async () => {
    for (;;) {
      if (opts.stopped?.() || (opts.deadline !== undefined && Date.now() > opts.deadline)) return;
      const q = todo[next++];
      if (!q) return;
      const t0 = Date.now();
      let record: ResultRecord;
      try {
        record = await runQuestion(q, opts, runId, storesDir);
      } catch (err) {
        record = { id: q.question_id, type: q.question_type, abstention: isAbstention(q), error: String((err as Error)?.message ?? err).slice(0, 500) };
      }
      appendFileSync(resultsFile, JSON.stringify(record) + "\n");
      finished++;
      const perQuestion = (Date.now() - started) / finished;
      const left = Math.round(((todo.length - finished) * perQuestion) / 60_000);
      log(`[${finished}/${todo.length}] ${q.question_id} (${typeKey(q)}) ${((Date.now() - t0) / 1000).toFixed(1)} s: ${describe(record)}${todo.length > finished ? `, about ${left} min left` : ""}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, worker));
  if (!opts.keepStores) rmSync(storesDir, { recursive: true, force: true });

  const ids = new Set(questions.map((q) => q.question_id));
  const records = latestRecords(readResults(resultsFile)).filter((r) => ids.has(r.id));
  const summary = summarize(records);
  writeFileSync(join(opts.out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  writeFileSync(join(opts.out, "summary.md"), summaryMarkdown(summary));
  return { summary, records, remaining: questions.length - records.filter((r) => !r.error).length };
}
