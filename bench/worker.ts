// SPDX-License-Identifier: AGPL-3.0-or-later
//
// LongMemEval on Cloudflare, as the Worker "rhizome-bench" (wrangler.bench.jsonc).
// A Workflow takes the questions of a run, one step each and several at a time.
// Every question gets a fresh Durable Object with rhizome's memory code
// (BenchMemory), its own Vectorize namespace and Workers AI through the binding:
// the services the deployed rhizome uses. The Worker has no route; runs are
// started and read through the Cloudflare API. See bench/README.md, "On Cloudflare".

import { DurableObject, WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep, type WorkflowStepConfig } from "cloudflare:workers";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { DEFAULT_EMBEDDING_MODEL, runAi, type Env } from "../src/env";
import { MemoryObject, type EpisodeInput } from "../src/memory-object";
import { RECALL_FEATURES } from "../src/recall";
import { DEFAULT_GRANTS, type Client } from "../src/scopes";
import { PAID_MODELS, isRetryableAiError, stableJson } from "./limits";
import { DATASET_URL, JsonArraySplitter, isAbstention, select, validateQuestion, type Question, type Selection } from "./longmemeval";
import { compareRuns, comparisonMarkdown, parseResults, summarize, summaryMarkdown, type ResultRecord, type Summary } from "./metrics";
import {
  EVAL_RESULTS_SUFFIX,
  JUDGE_MODEL,
  OpenAiError,
  READER_EFFORTS,
  REASONING_READER,
  UPSTREAM,
  chatCompletion,
  evalResultLine,
  hypothesisLine,
  isAbstentionId,
  judgePrompt,
  judgeRequest,
  judgedCorrect,
  officialMarkdown,
  qaMetrics,
  readerPrompt,
  readerRequest,
  type ChatReply,
  type ChatRequest,
  type OpenAiOptions,
  type QaMetrics,
  type QaRecord,
  type ReaderEffort,
} from "./official";
import { MEMORY_VARS, askQuestion, type AgentView } from "./question";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

type MemoryVar = (typeof MEMORY_VARS)[number];

export interface BenchEnv extends Partial<Record<MemoryVar, string>> {
  AI: Ai;
  /** One memory per question attempt. */
  MEMORY: DurableObjectNamespace<BenchMemory>;
  /** One object for the account, named "workers-ai": paces the calls to paid models. */
  AI_GATE: DurableObjectNamespace<AiGate>;
  /** The dataset (data/) and the runs (runs/). */
  BENCH: R2Bucket;
  /** Raw episodes, written by the memory code (users/) and deleted with their question. */
  EPISODES: R2Bucket;
  /** The benchmark's own index, never the deployed one. */
  VECTORS: Vectorize;
  CF_VERSION_METADATA?: { id: string; tag?: string; timestamp?: string };
  /** Secret, only for runs with a reader (the official evaluation, bench/official.ts). */
  OPENAI_API_KEY?: string;
  /** Default https://api.openai.com/v1. */
  OPENAI_BASE_URL?: string;
}

// ------------------------------------------------------------------ dataset

/** The dataset in the BENCH bucket: index.json and one object per question. */
export const DATA_PREFIX = "data/longmemeval-s-cleaned";
export const questionKey = (id: string) => `${DATA_PREFIX}/questions/${encodeURIComponent(id)}.json`;
export const runFile = (runId: string, file: string) => `runs/${runId}/${file}`;

export interface DatasetIndex {
  source: string;
  sha256: string;
  bytes: number;
  stored: string;
  questions: Pick<Question, "question_id" | "question_type">[];
}

/**
 * Copies LongMemEval-S into the bucket once, one object per question, checking each
 * on the way. The file is a few hundred megabytes, so it is split while it streams in.
 */
export async function importDataset(bucket: R2Bucket, url = DATASET_URL): Promise<DatasetIndex> {
  const existing = await bucket.get(`${DATA_PREFIX}/index.json`);
  if (existing) return existing.json<DatasetIndex>();
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`dataset download failed: HTTP ${res.status}`);
  const hash = createHash("sha256");
  const decoder = new TextDecoder();
  const splitter = new JsonArraySplitter();
  const questions: DatasetIndex["questions"] = [];
  const seen = new Set<string>();
  let bytes = 0;
  const store = async (texts: string[]) => {
    for (const text of texts) {
      const q = validateQuestion(JSON.parse(text), questions.length);
      if (seen.has(q.question_id)) throw new Error(`question ${questions.length}: question_id ${q.question_id} appears twice`);
      seen.add(q.question_id);
      await bucket.put(questionKey(q.question_id), text, { httpMetadata: { contentType: "application/json" } });
      questions.push({ question_id: q.question_id, question_type: q.question_type });
    }
  };
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
    bytes += value.byteLength;
    await store(splitter.push(decoder.decode(value, { stream: true })));
  }
  await store(splitter.push(decoder.decode()));
  splitter.end();
  if (!questions.length) throw new Error("the dataset has no questions");
  const index: DatasetIndex = { source: url, sha256: hash.digest("hex"), bytes, stored: new Date().toISOString(), questions };
  await bucket.put(`${DATA_PREFIX}/index.json`, JSON.stringify(index), { httpMetadata: { contentType: "application/json" } });
  return index;
}

// --------------------------------------------------------------- run params

/** What a run takes: the Workflow instance's params. Without any, all 500 questions run as deployed. */
export interface RunParams {
  /** Question ids, as a list or comma separated. */
  questions?: string[] | string;
  /** Question types, or "abstention", as a list or comma separated. */
  types?: string[] | string;
  /** This many questions, stratified by type, drawn with `seed` (default 1). */
  sample?: number;
  seed?: number;
  /** The first n questions, after the other filters. */
  limit?: number;
  /** Recall steps for every recall: a list, "all" or "none". Default: RECALL_FEATURES from the vars. */
  features?: string[] | string;
  /** Episode chunking. Default: CHUNKING from the vars. */
  chunking?: "fixed" | "rounds";
  /** Extract notes from every session. Slow: paid models allow 20 requests a minute. */
  extraction?: boolean;
  /** Run one nightly reflection per question after its sessions, before recall. Use it with extraction. */
  reflect?: boolean;
  /** Also send the question date as asOf. */
  asOf?: boolean;
  /** Questions in parallel. Default 8, or 4 with extraction (at most 8 then). */
  concurrency?: number;
  /** Variables for the memory code (MEMORY_VARS), over the Worker's vars. */
  vars?: Record<string, string>;
  /** The id of an earlier run, compared with this one in comparison.md. */
  baseline?: string;
  /** Requests a minute to each paid model, all questions together. Default 15 of the account's 20. */
  paidRpm?: number;
  /**
   * An OpenAI model, e.g. gpt-4o-2024-08-06: it answers every question from what the recall
   * tool returns, and GPT-4o judges the answer, as LongMemEval's own scripts do (bench/official.ts).
   * Needs the Worker secret OPENAI_API_KEY.
   */
  reader?: string;
  /**
   * Reasoning effort of a reasoning reader (o-series, GPT-5 and later): none, low, medium,
   * high, xhigh or max. Default medium for those, none for other readers (GPT-4o).
   */
  readerEffort?: string;
  /**
   * Keep every answer of the paid models (extraction, reflection) in the BENCH bucket
   * (cache/ai/) and reuse it when the same request comes again, so a rerun pays for and
   * waits on only what changed. Default true.
   */
  aiCache?: boolean;
  /**
   * Keep every question's embeddings in the BENCH bucket (cache/embeddings/) and reuse
   * them, so a rerun embeds only texts it has not seen. Default true.
   */
  embeddingCache?: boolean;
}

export interface RunSettings {
  selection: Selection;
  /** null: the memory code's default, RECALL_FEATURES. */
  features: string[] | null;
  /** null: the memory code's default, CHUNKING. */
  chunking: NonNullable<EpisodeInput["chunking"]> | null;
  extraction: boolean;
  reflect: boolean;
  asOf: boolean;
  concurrency: number;
  /** Variables for the memory code: the Worker's vars, then the run's. */
  vars: Record<string, string>;
  baseline: string | null;
  paidRpm: number;
  /** null: no answers, retrieval scores only. */
  reader: string | null;
  /** null: the reader takes no reasoning effort. */
  readerEffort: ReaderEffort | null;
  aiCache: boolean;
  embeddingCache: boolean;
}

export const MAX_CONCURRENCY = 32;
/**
 * With extraction, every question waits for its slots at the gate inside its alarms,
 * which may run 15 minutes each; more questions at a time would not finish sooner anyway.
 */
export const MAX_EXTRACTION_CONCURRENCY = 8;
const RUN_ID = /^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/;
const PARAMS = new Set([
  "questions",
  "types",
  "sample",
  "seed",
  "limit",
  "features",
  "chunking",
  "extraction",
  "reflect",
  "asOf",
  "concurrency",
  "vars",
  "baseline",
  "paidRpm",
  "reader",
  "readerEffort",
  "aiCache",
  "embeddingCache",
]);
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/;

function bad(message: string): never {
  throw new Error(`bad run params: ${message}`);
}

function wholeNumber(name: string, v: unknown, min: number, max: number): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) bad(`${name} must be a whole number from ${min} to ${max}`);
  return v;
}

function names(name: string, v: unknown): string[] | undefined {
  if (v === undefined || v === null) return undefined;
  const list = typeof v === "string" ? v.split(",") : Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : bad(`${name} must be a list of strings`);
  return list.map((s) => s.trim()).filter(Boolean);
}

function flag(name: string, v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v !== "boolean") bad(`${name} must be true or false`);
  return v;
}

/** features as a list; "none" or [] turns every step off. A misspelt step would otherwise be dropped without a word. */
function featureList(v: unknown): string[] | null {
  const list = names("features", v)?.map((n) => n.toLowerCase());
  if (list === undefined || (typeof v === "string" && list.length === 0)) return null;
  if (list.length === 1 && list[0] === "none") return [];
  for (const n of list) {
    if (n !== "all" && !(RECALL_FEATURES as readonly string[]).includes(n)) {
      bad(`unknown recall step "${n}" in features (known: ${RECALL_FEATURES.join(", ")}, all, none)`);
    }
  }
  return list;
}

/** Checks a run's params and fills in the defaults, so a typo fails before any question runs. */
export function runSettings(raw: unknown, env: Partial<Record<MemoryVar, string>>): RunSettings {
  // The API takes params as JSON text; accept it here too, in case it arrives undecoded.
  let p = (raw ?? {}) as Record<string, unknown>;
  if (typeof raw === "string") {
    try {
      p = raw.trim() ? JSON.parse(raw) : {};
    } catch {
      bad("params must be a JSON object");
    }
  }
  if (!p || typeof p !== "object" || Array.isArray(p)) bad("params must be a JSON object");
  for (const key of Object.keys(p)) if (!PARAMS.has(key)) bad(`unknown param "${key}" (known: ${[...PARAMS].join(", ")})`);

  const chunking = (p.chunking ?? null) as RunSettings["chunking"];
  if (chunking !== null && chunking !== "fixed" && chunking !== "rounds") bad(`chunking must be "fixed" or "rounds"`);

  const overrides = p.vars ?? {};
  if (typeof overrides !== "object" || Array.isArray(overrides)) bad("vars must be an object of strings");
  const vars: Record<string, string> = {};
  for (const key of MEMORY_VARS) {
    const value = env[key];
    if (value) vars[key] = value;
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!(MEMORY_VARS as readonly string[]).includes(key)) bad(`vars.${key} is not a variable of the memory code (known: ${MEMORY_VARS.join(", ")})`);
    if (typeof value !== "string") bad(`vars.${key} must be a string`);
    vars[key] = value;
  }

  const baseline = (p.baseline ?? null) as string | null;
  if (baseline !== null && (typeof baseline !== "string" || !RUN_ID.test(baseline))) bad("baseline must be the id of an earlier run");
  const paidRpm = p.paidRpm ?? 15;
  if (typeof paidRpm !== "number" || !(paidRpm > 0) || !Number.isFinite(paidRpm)) bad("paidRpm must be a positive number");
  const reader = (p.reader ?? null) as string | null;
  if (reader !== null && (typeof reader !== "string" || !MODEL_ID.test(reader))) bad("reader must be an OpenAI model id, e.g. gpt-4o-2024-08-06");
  const effort = p.readerEffort ?? null;
  if (effort !== null && (typeof effort !== "string" || !(READER_EFFORTS as readonly string[]).includes(effort))) bad(`readerEffort must be one of ${READER_EFFORTS.join(", ")}`);
  if (effort !== null && (reader === null || !REASONING_READER.test(reader))) bad("readerEffort needs a reasoning reader (o-series, GPT-5 or later)");
  const readerEffort = (effort ?? (reader !== null && REASONING_READER.test(reader) ? "medium" : null)) as ReaderEffort | null;

  const extraction = flag("extraction", p.extraction);
  const concurrency = wholeNumber("concurrency", p.concurrency, 1, MAX_CONCURRENCY) ?? (extraction ? 4 : 8);
  if (extraction && concurrency > MAX_EXTRACTION_CONCURRENCY) bad(`with extraction, concurrency can be at most ${MAX_EXTRACTION_CONCURRENCY}`);
  return {
    selection: {
      ids: names("questions", p.questions),
      types: names("types", p.types),
      sample: wholeNumber("sample", p.sample, 0, Number.MAX_SAFE_INTEGER),
      seed: wholeNumber("seed", p.seed, 0, 2 ** 32 - 1),
      limit: wholeNumber("limit", p.limit, 0, Number.MAX_SAFE_INTEGER),
    },
    features: featureList(p.features),
    chunking,
    extraction,
    reflect: flag("reflect", p.reflect),
    asOf: flag("asOf", p.asOf),
    concurrency,
    vars,
    baseline,
    paidRpm,
    reader,
    readerEffort,
    aiCache: p.aiCache === undefined || p.aiCache === null ? true : flag("aiCache", p.aiCache),
    embeddingCache: p.embeddingCache === undefined || p.embeddingCache === null ? true : flag("embeddingCache", p.embeddingCache),
  };
}

// ----------------------------------------------------------------- Workers AI

/**
 * One object for the account: hands out request slots per paid model, so all
 * questions of all runs together stay under the model's per-minute limit.
 */
export class AiGate extends DurableObject<BenchEnv> {
  constructor(ctx: DurableObjectState, env: BenchEnv) {
    super(ctx, env);
    ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS slots (model TEXT PRIMARY KEY, next INTEGER NOT NULL)");
  }

  /** Reserves the next request slot for `model` and returns how many milliseconds to wait for it. */
  reserve(model: string, rpm: number): number {
    if (!(rpm > 0)) throw new Error("rpm must be positive");
    const sql = this.ctx.storage.sql;
    const now = Date.now();
    const row = sql.exec("SELECT next FROM slots WHERE model = ?", model).toArray()[0];
    const at = Math.max(now, Number(row?.next ?? 0));
    sql.exec(
      "INSERT INTO slots (model, next) VALUES (?, ?) ON CONFLICT (model) DO UPDATE SET next = excluded.next",
      model,
      at + Math.ceil(60_000 / rpm),
    );
    return at - now;
  }
}

/**
 * Workers AI as the memory code calls it, with the paid models paced through `reserve`
 * and further tries on rate limits, capacity and server errors.
 */
export function pacedAi(ai: Ai, reserve: (model: string) => Promise<number>, tries = 6, backoffMs = 2_000): Ai {
  const run = async (model: string, input: unknown): Promise<unknown> => {
    for (let attempt = 1; ; attempt++) {
      if (PAID_MODELS.test(model)) {
        const wait = await reserve(model);
        if (wait > 0) await sleep(wait);
      }
      try {
        return await runAi<unknown>(ai, model, input);
      } catch (err) {
        if (attempt >= tries || !isRetryableAiError(err)) throw err;
        await sleep(Math.min(60_000, backoffMs * 2 ** (attempt - 1)));
      }
    }
  };
  return { run } as unknown as Ai;
}

/** Where a question's embeddings for one model are kept between runs. */
export const embeddingCacheKey = (question: string, model: string) =>
  `cache/embeddings/${encodeURIComponent(model)}/${encodeURIComponent(question.split("/").pop() ?? question)}`;

const textKey = (text: string) => createHash("sha256").update(text).digest("base64url").slice(0, 24);

function encodeVector(v: ArrayLike<number>): string {
  return Buffer.from(new Float32Array(Array.from(v)).buffer).toString("base64");
}

function decodeVector(text: string): number[] {
  const bytes = Buffer.from(text, "base64");
  const out = new Float32Array(bytes.byteLength / 4);
  new Uint8Array(out.buffer).set(bytes);
  return Array.from(out);
}

/**
 * The embeddings of one question, kept in the BENCH bucket between runs: every
 * run replays the same sessions, so a rerun embeds only the texts it has not
 * seen before (a new chunking, a new wording). Vectors are kept as 32-bit
 * floats, as rhizome stores them. Losing the cache only costs embeddings.
 */
export class EmbeddingCache {
  private readonly vectors = new Map<string, number[]>();
  private added = 0;
  hits = 0;
  misses = 0;

  constructor(
    private readonly bucket: Pick<R2Bucket, "get" | "put">,
    private readonly key: string,
    private readonly model: string,
  ) {}

  async load(): Promise<void> {
    try {
      const object = await this.bucket.get(this.key);
      if (!object) return;
      const data = (await object.json()) as { model?: string; vectors?: Record<string, string> };
      if (data.model !== this.model) return;
      for (const [k, v] of Object.entries(data.vectors ?? {})) this.vectors.set(k, decodeVector(v));
    } catch (err) {
      console.error("bench: could not read the embedding cache", String(err));
    }
  }

  /** Writes the cache back when the question embedded something new. */
  async save(): Promise<void> {
    if (this.added === 0) return;
    try {
      const vectors = Object.fromEntries([...this.vectors].map(([k, v]) => [k, encodeVector(v)]));
      await this.bucket.put(this.key, JSON.stringify({ model: this.model, vectors }), { httpMetadata: { contentType: "application/json" } });
      this.added = 0;
    } catch (err) {
      console.error("bench: could not write the embedding cache", String(err));
    }
  }

  /** Workers AI with the embedding model's calls answered from the cache where it can. */
  wrap(ai: Ai): Ai {
    const run = async (model: string, input: unknown): Promise<unknown> => {
      const texts = (input as { text?: unknown } | null)?.text;
      if (model !== this.model || !Array.isArray(texts) || !texts.every((t) => typeof t === "string")) return runAi<unknown>(ai, model, input);
      const keys = (texts as string[]).map(textKey);
      const missing = [...new Set(keys.filter((k) => !this.vectors.has(k)))];
      this.hits += keys.length - missing.length;
      this.misses += missing.length;
      if (missing.length) {
        const byKey = new Map(keys.map((k, i) => [k, (texts as string[])[i]!] as const));
        const res = await runAi<{ data?: number[][] }>(ai, model, { ...(input as object), text: missing.map((k) => byKey.get(k)!) });
        if (!Array.isArray(res?.data) || res.data.length !== missing.length) throw new Error("embedding model returned an unexpected shape");
        missing.forEach((k, i) => {
          // As rhizome stores it, so a cached run sees the same numbers as a fresh one.
          this.vectors.set(k, decodeVector(encodeVector(res.data![i]!)));
          this.added++;
        });
      }
      const data = keys.map((k) => this.vectors.get(k)!);
      return { shape: [data.length, data[0]?.length ?? 0], data };
    };
    return { run } as unknown as Ai;
  }
}

/** Where one answer of a paid model is kept between runs. */
export const aiCacheKey = async (model: string, input: unknown) => {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${model}\n${stableJson(input)}`));
  return `cache/ai/${encodeURIComponent(model)}/${Buffer.from(digest).toString("hex")}.json`;
};

/**
 * The answers of the paid models (extraction, reflection, dispute verdicts), kept in the
 * BENCH bucket, one object per request. Every run replays the same sessions in the same
 * order at temperature 0, so the requests repeat as long as the ingest code does: a rerun
 * that changes only recall answers every paid call from here, at no cost and without
 * waiting for the paid models' per-minute limit. A request that differs (new prompt, other
 * related notes) misses and is paid once. Losing the cache only costs the calls again.
 */
export class AiOutputCache {
  hits = 0;
  misses = 0;

  constructor(
    private readonly bucket: Pick<R2Bucket, "get" | "put">,
    /** Which models' answers to keep. Default: the paid ones. */
    private readonly cached: (model: string) => boolean = (model) => PAID_MODELS.test(model),
  ) {}

  /** Workers AI with the paid models' calls answered from the cache where it can. Hits skip the pacing of `ai` too. */
  wrap(ai: Ai): Ai {
    const run = async (model: string, input: unknown): Promise<unknown> => {
      if (!this.cached(model)) return runAi<unknown>(ai, model, input);
      const key = await aiCacheKey(model, input);
      try {
        const hit = await this.bucket.get(key);
        if (hit) {
          const out = (await hit.json()) as { output?: unknown };
          if (out && "output" in out) {
            this.hits++;
            return out.output;
          }
        }
      } catch (err) {
        console.error("bench: could not read the AI cache", String(err));
      }
      this.misses++;
      const output = await runAi<unknown>(ai, model, input);
      try {
        await this.bucket.put(key, JSON.stringify({ model, output }), { httpMetadata: { contentType: "application/json" } });
      } catch (err) {
        console.error("bench: could not write the AI cache", String(err));
      }
      return output;
    };
    return { run } as unknown as Ai;
  }
}

// ------------------------------------------------------------------ Vectorize

type VectorIndex = Pick<Vectorize, "upsert" | "deleteByIds" | "query"> & Partial<Pick<Vectorize, "describe">>;

/**
 * The benchmark's index as the memory code sees it, remembering the question's last
 * writes, so the question can wait until Vectorize has applied them.
 */
export class TrackedVectors {
  /** The question's vectors not deleted since, in write order: the last one is the probe. */
  private readonly live = new Map<string, VectorizeVector>();
  private lastMutation: string | null = null;

  constructor(private readonly index: VectorIndex) {}

  async upsert(vectors: VectorizeVector[]): Promise<VectorizeAsyncMutation> {
    const res = await this.index.upsert(vectors);
    for (const v of vectors) {
      this.live.delete(v.id);
      this.live.set(v.id, v);
    }
    this.lastMutation = res?.mutationId ? String(res.mutationId) : null;
    return res;
  }

  async deleteByIds(ids: string[]): Promise<VectorizeAsyncMutation> {
    const res = await this.index.deleteByIds(ids);
    // A deleted vector can never be found again, so it must not stay the probe.
    for (const id of ids) this.live.delete(id);
    this.lastMutation = res?.mutationId ? String(res.mutationId) : null;
    return res;
  }

  query(vector: VectorFloatArray | number[], options?: VectorizeQueryOptions): Promise<VectorizeMatches> {
    return this.index.query(vector, options);
  }

  /**
   * Waits until a search finds the question's last vector, or the index reports its last
   * write as processed. Vectorize applies writes in order, in the background (usually
   * within a minute), so the whole history is searchable by then, as it would be for an
   * agent asking later. Deletes still pending do not matter: recall skips ids it no longer has.
   */
  async searchable(timeoutMs: number, pollMs = 2_000): Promise<void> {
    const probe = [...this.live.values()].at(-1);
    if (!probe) return;
    const scope = probe.metadata?.scope;
    const until = Date.now() + timeoutMs;
    for (;;) {
      const res = await this.index.query(probe.values, { topK: 10, namespace: probe.namespace, ...(typeof scope === "string" ? { filter: { scope } } : {}) });
      if (res.matches.some((m) => m.id === probe.id)) return;
      if (this.lastMutation && this.index.describe) {
        const info = await this.index.describe();
        if (String(info.processedUpToMutation) === this.lastMutation) return;
      }
      if (Date.now() >= until) throw new Error(`Vectorize had not applied this question's vectors after ${Math.round(timeoutMs / 1000)} s`);
      await sleep(pollMs);
    }
  }
}

// ------------------------------------------------------------------- memory

/** What a question step hands its memory. */
export interface QuestionJob {
  /** The question in the BENCH bucket. */
  key: string;
  /** Owner of the memory, and so its Vectorize namespace: at most 64 bytes. */
  userId: string;
  /** Variables for the memory code. */
  vars: Record<string, string>;
  features?: string[];
  chunking?: EpisodeInput["chunking"];
  extraction: boolean;
  reflect: boolean;
  asOf: boolean;
  paidRpm: number;
  /** Longest wait for embeddings and extraction. */
  idleTimeoutMs: number;
  /** Longest wait for Vectorize to apply the question's vectors. */
  vectorTimeoutMs: number;
  /** Also recall as the recall tool does, for the reader. */
  agentView?: boolean;
  /** Reuse and keep the question's embeddings (EmbeddingCache). */
  embeddingCache?: boolean;
  /** Reuse and keep the paid models' answers (AiOutputCache). */
  aiCache?: boolean;
}

function benchClient(userId: string): Client {
  return { id: "bench", userId, name: "LongMemEval", agent: "bench", provider: "longmemeval", grants: DEFAULT_GRANTS };
}

/** rhizome's memory code for one question: fed its sessions, asked, scored and emptied again. */
export class BenchMemory extends MemoryObject {
  private readonly bench: BenchEnv;
  private running = false;

  constructor(ctx: DurableObjectState, env: BenchEnv) {
    super(ctx, env as unknown as Env);
    this.bench = env;
  }

  /** Runs one question on this empty memory, then deletes everything it stored, also when it fails. */
  async benchRun(job: QuestionJob): Promise<ResultRecord & { view?: AgentView }> {
    if (this.running) throw new Error("this memory is already running a question");
    this.running = true;
    const vectors = new TrackedVectors(this.bench.VECTORS);
    const gate = this.bench.AI_GATE.get(this.bench.AI_GATE.idFromName("workers-ai"));
    const paced = pacedAi(this.bench.AI, (model) => gate.reserve(model, job.paidRpm));
    const model = job.vars.EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
    const cache = job.embeddingCache ? new EmbeddingCache(this.bench.BENCH, embeddingCacheKey(job.key, model), model) : null;
    await cache?.load();
    const outputs = job.aiCache ? new AiOutputCache(this.bench.BENCH) : null;
    const ai = outputs ? outputs.wrap(paced) : paced;
    this.env = {
      ...job.vars,
      EXTRACTION: job.extraction ? "on" : "off",
      // One question replays months of sessions at once; the per-day cap is for live use.
      EXTRACTION_DAILY_LIMIT: "1000000",
      EPISODES: this.bench.EPISODES,
      VECTORS: vectors,
      AI: cache ? cache.wrap(ai) : ai,
    } as unknown as Env;
    try {
      const object = await this.bench.BENCH.get(job.key);
      if (!object) throw new Error(`no question at ${job.key}`);
      const q = validateQuestion(await object.json(), 0);
      const record = await askQuestion(this, benchClient(job.userId), q, {
        features: job.features,
        chunking: job.chunking,
        asOf: job.asOf,
        reflect: job.reflect,
        idleTimeoutMs: job.idleTimeoutMs,
        afterIngest: () => vectors.searchable(job.vectorTimeoutMs),
        agentView: job.agentView,
      });
      return outputs ? { ...record, aiCache: { hits: outputs.hits, misses: outputs.misses } } : record;
    } finally {
      await cache?.save();
      await this.wipe();
      this.running = false;
    }
  }

  /** An alarm outside a run belongs to a question that was given up, e.g. after a restart: clear it away. */
  override async alarm(): Promise<void> {
    if (!this.running) return this.wipe();
    return super.alarm();
  }

  /** Deletes the question's vectors, raw episodes and storage. Never throws: leftovers sit in benchmark-only stores. */
  private async wipe(): Promise<void> {
    const rows = (query: string) => {
      try {
        return this.ctx.storage.sql.exec(query).toArray();
      } catch {
        return []; // already wiped
      }
    };
    const ids = rows("SELECT id FROM items").map((r) => String(r.id));
    const keys = rows("SELECT r2_key FROM episodes").map((r) => String(r.r2_key));
    try {
      // Vectorize deletes at most 100 ids at a time.
      for (let i = 0; i < ids.length; i += 100) await this.bench.VECTORS.deleteByIds(ids.slice(i, i + 100));
    } catch (err) {
      console.error("bench: could not delete a question's vectors", String(err));
    }
    try {
      for (let i = 0; i < keys.length; i += 1000) await this.bench.EPISODES.delete(keys.slice(i, i + 1000));
    } catch (err) {
      console.error("bench: could not delete a question's raw episodes", String(err));
    }
    try {
      await this.ctx.storage.deleteAlarm();
      // The Node stand-in used in tests has no deleteAll.
      await (this.ctx.storage as Partial<DurableObjectStorage>).deleteAll?.();
    } catch (err) {
      console.error("bench: could not clear a question's storage", String(err));
    }
  }
}

// ----------------------------------------------------------------- workflow

export interface RunOutput {
  runId: string;
  questions: number;
  failed: number;
  summary: Summary;
  markdown: string;
  comparison?: string;
  /** Runs with a reader: LongMemEval's own scores (official.md). */
  official?: { reader: string; judged: number; failed: number; metrics: QaMetrics };
}

const DATASET_STEP: WorkflowStepConfig = { retries: { limit: 3, delay: "1 minute", backoff: "exponential" }, timeout: "30 minutes" };
const FILES_STEP: WorkflowStepConfig = { retries: { limit: 5, delay: "10 seconds", backoff: "exponential" }, timeout: "5 minutes" };
/** An answer or a verdict: chatCompletion already tries again on rate limits, these tries come on top. */
const QA_STEP: WorkflowStepConfig = { retries: { limit: 3, delay: "1 minute", backoff: "exponential" }, timeout: "15 minutes" };

type StepReply = ChatReply | { error: string };

/** One OpenAI call in a step. An error no later try can fix comes back as the result, so the step is not tried again. */
async function openAiStep(request: ChatRequest, opts: OpenAiOptions): Promise<StepReply> {
  try {
    return await chatCompletion(request, opts);
  } catch (err) {
    if (err instanceof OpenAiError && !err.retryable) return { error: err.message.slice(0, 500) };
    throw err;
  }
}

const lines = (rows: string[]) => (rows.length ? rows.join("\n") + "\n" : "");

/** A run: the instance id names it, and its files go to runs/<id>/ in the BENCH bucket. */
export class BenchWorkflow extends WorkflowEntrypoint<BenchEnv, RunParams> {
  async run(event: Readonly<WorkflowEvent<RunParams>>, step: WorkflowStep): Promise<RunOutput> {
    const runId = event.instanceId;
    const settings = runSettings(event.payload, this.env);
    if (settings.reader && !this.env.OPENAI_API_KEY) bad("reader needs the Worker secret OPENAI_API_KEY");
    const openai: OpenAiOptions = { apiKey: this.env.OPENAI_API_KEY ?? "", ...(this.env.OPENAI_BASE_URL ? { baseUrl: this.env.OPENAI_BASE_URL } : {}) };
    const dataset = await step.do("dataset", DATASET_STEP, () => importDataset(this.env.BENCH));
    const questions = select(dataset.questions, settings.selection);
    if (!questions.length) throw new Error("no question matches the selection");

    const put = (file: string, body: string, type: string) => this.env.BENCH.put(runFile(runId, file), body, { httpMetadata: { contentType: type } });
    await step.do("config", FILES_STEP, async () => {
      const config = {
        runId,
        created: new Date().toISOString(),
        // The keys of the Node runner's settings, so the two read alike.
        settings: {
          dataset: dataset.sha256,
          ai: "workers-ai",
          vars: settings.vars,
          extraction: settings.extraction,
          reflect: settings.reflect,
          features: settings.features,
          chunking: settings.chunking,
          asOf: settings.asOf,
          selection: settings.selection,
          embeddingCache: settings.embeddingCache,
          aiCache: settings.aiCache,
        },
        questions: questions.length,
        concurrency: settings.concurrency,
        paidRpm: settings.paidRpm,
        baseline: settings.baseline,
        ...(settings.reader ? { official: { reader: settings.reader, readerEffort: settings.readerEffort, judge: JUDGE_MODEL, upstream: UPSTREAM } } : {}),
        meta: { worker: this.env.CF_VERSION_METADATA ?? null, dataset: { source: dataset.source, bytes: dataset.bytes, stored: dataset.stored } },
      };
      await put("config.json", JSON.stringify(config, null, 2) + "\n", "application/json");
      return null;
    });

    // Longest waits per attempt; the step gives up a little after the question would. With
    // extraction, a question shares the paid-model slots with the others: allow it 120 calls.
    const idleTimeoutMs = settings.extraction ? Math.max(3_600_000, ((120 * settings.concurrency) / settings.paidRpm) * 60_000) : 900_000;
    const vectorTimeoutMs = 600_000;
    const questionStep: WorkflowStepConfig = {
      retries: { limit: 2, delay: "1 minute", backoff: "exponential" },
      timeout: idleTimeoutMs + vectorTimeoutMs + 900_000,
    };
    const ask = async (q: (typeof questions)[number]): Promise<ResultRecord & { view?: AgentView }> => {
      try {
        return await step.do(`question ${q.question_id}`, questionStep, async (ctx) => {
          // A fresh memory and namespace per attempt: a given-up attempt can never mix into the next.
          const tag = crypto.randomUUID().replace(/-/g, "").slice(0, 12);
          const memory = this.env.MEMORY.get(this.env.MEMORY.idFromName(`${runId}:${q.question_id}:${ctx.attempt}:${tag}`));
          const job: QuestionJob = {
            key: questionKey(q.question_id),
            userId: `${q.question_id.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 40)}-${tag}`,
            vars: settings.vars,
            ...(settings.features ? { features: settings.features } : {}),
            ...(settings.chunking ? { chunking: settings.chunking } : {}),
            extraction: settings.extraction,
            reflect: settings.reflect,
            asOf: settings.asOf,
            paidRpm: settings.paidRpm,
            idleTimeoutMs,
            vectorTimeoutMs,
            ...(settings.reader ? { agentView: true } : {}),
            ...(settings.embeddingCache ? { embeddingCache: true } : {}),
            ...(settings.aiCache ? { aiCache: true } : {}),
          };
          return (await memory.benchRun(job)) as ResultRecord & { view?: AgentView };
        });
      } catch (err) {
        // Every attempt failed: the question counts as failed and the run goes on.
        return { id: q.question_id, type: q.question_type, abstention: isAbstention(q), error: String((err as Error)?.message ?? err).slice(0, 500) };
      }
    };

    // The official evaluation: the reader answers from the recall tool's text, GPT-4o judges the answer.
    const answer = async (q: (typeof questions)[number], view: AgentView | undefined, failed: string | undefined): Promise<QaRecord> => {
      const base: QaRecord = { id: q.question_id, type: q.question_type, abstention: isAbstention(q) };
      if (!view) return { ...base, error: failed ? `no recall: ${failed}` : "no recall" };
      const context = { contextItems: view.items, contextTokens: view.tokens };
      try {
        const read = await step.do(`answer ${q.question_id}`, QA_STEP, () =>
          openAiStep(readerRequest(settings.reader!, readerPrompt(view.text, view.questionDate, view.question), settings.readerEffort), openai),
        );
        if ("error" in read) return { ...base, ...context, error: `reader: ${read.error}` };
        const hypothesis = read.content.trim();
        const reader = { hypothesis, readerModel: read.model, readerFinish: read.finishReason, readerTokens: { prompt: read.promptTokens, completion: read.completionTokens, ...(read.reasoningTokens !== undefined ? { reasoning: read.reasoningTokens } : {}) } };
        const prompt = judgePrompt(view.type, view.question, view.answer, hypothesis, isAbstentionId(q.question_id));
        const verdict = await step.do(`judge ${q.question_id}`, QA_STEP, () => openAiStep(judgeRequest(prompt), openai));
        if ("error" in verdict) return { ...base, ...context, ...reader, error: `judge: ${verdict.error}` };
        return {
          ...base,
          ...context,
          ...reader,
          label: judgedCorrect(verdict.content),
          judgeReply: verdict.content.trim(),
          judgeModel: verdict.model,
          judgeTokens: { prompt: verdict.promptTokens, completion: verdict.completionTokens },
        };
      } catch (err) {
        return { ...base, ...context, error: String((err as Error)?.message ?? err).slice(0, 500) };
      }
    };

    const records: ResultRecord[] = new Array(questions.length);
    const views: (AgentView | undefined)[] = new Array(questions.length);
    const answers: QaRecord[] = new Array(questions.length);
    let next = 0;
    const lane = async () => {
      for (let i = next++; i < questions.length; i = next++) {
        const { view, ...record } = await ask(questions[i]!);
        records[i] = record;
        views[i] = view;
        if (settings.reader) answers[i] = await answer(questions[i]!, view, record.error);
      }
    };
    await Promise.all(Array.from({ length: Math.min(settings.concurrency, questions.length) }, lane));

    return step.do("summary", FILES_STEP, async () => {
      const summary = summarize(records);
      const markdown = summaryMarkdown(summary, `LongMemEval retrieval, run ${runId}`);
      await put("results.jsonl", records.map((r) => JSON.stringify(r)).join("\n") + "\n", "application/x-ndjson");
      await put("summary.json", JSON.stringify(summary, null, 2) + "\n", "application/json");
      await put("summary.md", markdown, "text/markdown; charset=utf-8");
      const output: RunOutput = { runId, questions: records.length, failed: summary.failed, summary, markdown };
      if (settings.baseline) {
        const base = await this.env.BENCH.get(runFile(settings.baseline, "results.jsonl"));
        const compared = base ? compareRuns(parseResults(await base.text()), records) : null;
        output.comparison =
          !compared ? `No results for the run ${settings.baseline}.\n`
          : compared.questions === 0 ? `The runs ${settings.baseline} and ${runId} have no scored question in common.\n`
          : comparisonMarkdown(compared, settings.baseline, runId);
        await put("comparison.md", output.comparison, "text/markdown; charset=utf-8");
      }
      if (settings.reader) {
        // The files LongMemEval's scripts write and read, in the run's question order.
        const answered = answers.filter((a) => a.hypothesis !== undefined);
        const judged = answers.filter((a): a is QaRecord & { hypothesis: string; label: boolean } => a.hypothesis !== undefined && a.label !== undefined);
        const metrics = qaMetrics(judged.map((a) => ({ id: a.id, type: a.type, label: a.label })));
        await put("hypotheses.jsonl", lines(answered.map((a) => hypothesisLine(a.id, a.hypothesis!))), "application/x-ndjson");
        await put(`hypotheses.jsonl${EVAL_RESULTS_SUFFIX}`, lines(judged.map((a) => evalResultLine(a.id, a.hypothesis, a.label))), "application/x-ndjson");
        await put("qa.jsonl", lines(answers.map((a) => JSON.stringify(a))), "application/x-ndjson");
        await put("contexts.jsonl", lines(questions.flatMap((q, i) => (views[i] ? [JSON.stringify({ question_id: q.question_id, items: views[i]!.items, tokens: views[i]!.tokens, text: views[i]!.text })] : []))), "application/x-ndjson");
        const report = { runId, reader: settings.reader, readerEffort: settings.readerEffort, dataset: dataset.sha256, records: answers, metrics, ...(summary.official ? { retrieval: summary.official } : {}) };
        await put("official.md", officialMarkdown(report), "text/markdown; charset=utf-8");
        await put("official.json", JSON.stringify({ reader: settings.reader, readerEffort: settings.readerEffort, judge: JUDGE_MODEL, upstream: UPSTREAM, metrics, retrieval: summary.official ?? null }, null, 2) + "\n", "application/json");
        output.official = { reader: settings.reader, judged: judged.length, failed: answers.length - judged.length, metrics };
      }
      return output;
    });
  }
}

export default {
  async fetch(): Promise<Response> {
    return new Response("rhizome-bench has no HTTP interface. Runs start through the Cloudflare API, see bench/README.md.\n", { status: 404 });
  },
} satisfies ExportedHandler<BenchEnv>;
