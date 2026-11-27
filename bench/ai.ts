// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Workers AI for benchmark runs. Every answer is cached on disk, keyed by model
// and input (embeddings per text), so a rerun with the same inputs costs
// nothing and scores the same. Calls stay under Workers AI's per-model limits
// and the Cloudflare API limit, and retry on rate limits and server errors.

import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync, type StatementSync } from "node:sqlite";
import { DEFAULT_API_LIMIT, RetryableError, defaultRpm, isRetryable, stableJson } from "./limits";

/** What MemoryObject calls as env.AI: `run(model, input)`. */
export interface AiRunner {
  run(model: string, input: unknown): Promise<unknown>;
}

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export { stableJson };

/** SQLite file with embeddings (per model and text) and all other model answers (per model and input). */
export class AiCache {
  private db: DatabaseSync;
  private readVector: StatementSync;
  private writeVector: StatementSync;
  private readOutput: StatementSync;
  private writeOutput: StatementSync;

  constructor(file: string) {
    mkdirSync(dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS embeddings (model TEXT NOT NULL, text_hash TEXT NOT NULL, vec BLOB NOT NULL, PRIMARY KEY (model, text_hash)) WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS outputs (input_hash TEXT PRIMARY KEY, model TEXT NOT NULL, output TEXT NOT NULL, created_at INTEGER NOT NULL) WITHOUT ROWID;`);
    this.readVector = this.db.prepare("SELECT vec FROM embeddings WHERE model = ? AND text_hash = ?");
    this.writeVector = this.db.prepare("INSERT OR REPLACE INTO embeddings (model, text_hash, vec) VALUES (?, ?, ?)");
    this.readOutput = this.db.prepare("SELECT output FROM outputs WHERE input_hash = ?");
    this.writeOutput = this.db.prepare("INSERT OR REPLACE INTO outputs (input_hash, model, output, created_at) VALUES (?, ?, ?, ?)");
  }

  embedding(model: string, textHash: string): Float32Array | undefined {
    const row = this.readVector.get(model, textHash) as { vec: Uint8Array } | undefined;
    if (!row) return undefined;
    const copy = row.vec.slice();
    return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
  }

  saveEmbedding(model: string, textHash: string, vec: Float32Array): void {
    this.writeVector.run(model, textHash, new Uint8Array(vec.buffer, vec.byteOffset, vec.byteLength));
  }

  output(inputHash: string): unknown {
    const row = this.readOutput.get(inputHash) as { output: string } | undefined;
    return row ? (JSON.parse(row.output) as unknown) : undefined;
  }

  saveOutput(inputHash: string, model: string, output: unknown): void {
    this.writeOutput.run(inputHash, model, JSON.stringify(output), Date.now());
  }

  size(): { embeddings: number; outputs: number } {
    const n = (table: string) => Number((this.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
    return { embeddings: n("embeddings"), outputs: n("outputs") };
  }

  close(): void {
    this.db.close();
  }
}

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

const realClock: Clock = { now: () => Date.now(), sleep: wait };

/** At most `limit` starts per sliding window of `periodMs`. */
export class RateWindow {
  private starts: number[] = [];

  constructor(
    readonly limit: number,
    readonly periodMs: number,
    private clock: Clock = realClock,
  ) {}

  async take(): Promise<void> {
    if (!(this.limit > 0) || !Number.isFinite(this.limit)) return;
    for (;;) {
      const now = this.clock.now();
      while (this.starts.length && now - this.starts[0]! >= this.periodMs) this.starts.shift();
      if (this.starts.length < this.limit) {
        this.starts.push(now);
        return;
      }
      await this.clock.sleep(this.starts[0]! + this.periodMs - now + 1);
    }
  }
}

export { DEFAULT_API_LIMIT, defaultRpm, isRetryable } from "./limits";

export interface ModelStats {
  /** Requests sent, retries included. */
  requests: number;
  /** Calls answered from the cache. */
  cached: number;
  /** Embedding texts asked for, and how many of them came from the cache. */
  texts: number;
  cachedTexts: number;
  retries: number;
  failed: number;
  ms: number;
}

export interface BenchAiOptions {
  cache?: AiCache;
  /** Requests per minute for a model. Default: defaultRpm. */
  rpm?: (model: string) => number;
  /** Requests per five minutes across all models. Default: DEFAULT_API_LIMIT. */
  apiLimit?: number;
  /** Retries after a rate limit, timeout or server error. Default 10 (about five minutes of backoff). */
  retries?: number;
  clock?: Clock;
}

function isEmbeddingInput(input: unknown): input is { text: string | string[] } {
  const i = input as Record<string, unknown> | null;
  return !!i && typeof i === "object" && "text" in i && !("messages" in i) && !("query" in i);
}

export class BenchAi implements AiRunner {
  readonly stats = new Map<string, ModelStats>();
  private windows = new Map<string, RateWindow>();
  private api: RateWindow;
  private clock: Clock;

  constructor(
    private inner: AiRunner,
    private opts: BenchAiOptions = {},
  ) {
    this.clock = opts.clock ?? realClock;
    this.api = new RateWindow(opts.apiLimit ?? DEFAULT_API_LIMIT, 300_000, this.clock);
  }

  private stat(model: string): ModelStats {
    let s = this.stats.get(model);
    if (!s) this.stats.set(model, (s = { requests: 0, cached: 0, texts: 0, cachedTexts: 0, retries: 0, failed: 0, ms: 0 }));
    return s;
  }

  async run(model: string, input: unknown): Promise<unknown> {
    const s = this.stat(model);
    if (isEmbeddingInput(input)) return this.embed(model, input, s);
    const key = sha256(`${model}\n${stableJson(input)}`);
    const hit = this.opts.cache?.output(key);
    if (hit !== undefined) {
      s.cached++;
      return hit;
    }
    const out = await this.call(model, input, s);
    this.opts.cache?.saveOutput(key, model, out);
    return out;
  }

  /** Embeddings are cached per text, so the same chunk in another question or batch is never embedded twice. */
  private async embed(model: string, input: { text: string | string[] }, s: ModelStats): Promise<{ shape: number[]; data: number[][] }> {
    const texts = Array.isArray(input.text) ? input.text : [input.text];
    const hashes = texts.map((t) => sha256(t));
    const vectors = hashes.map((h) => this.opts.cache?.embedding(model, h));
    const missing = [...new Set(hashes.filter((_, i) => !vectors[i]))];
    s.texts += texts.length;
    s.cachedTexts += vectors.filter(Boolean).length;
    if (missing.length) {
      const textOf = new Map(hashes.map((h, i) => [h, texts[i]!]));
      const res = (await this.call(model, { ...input, text: missing.map((h) => textOf.get(h)!) }, s)) as { data?: unknown };
      const data = res?.data;
      if (!Array.isArray(data) || data.length !== missing.length) {
        throw new Error(`${model}: expected ${missing.length} embeddings, got ${Array.isArray(data) ? data.length : typeof data}`);
      }
      const fresh = new Map<string, Float32Array>();
      missing.forEach((h, n) => {
        const vec = Float32Array.from(data[n] as number[]);
        fresh.set(h, vec);
        this.opts.cache?.saveEmbedding(model, h, vec);
      });
      hashes.forEach((h, i) => (vectors[i] ??= fresh.get(h)));
    } else {
      s.cached++;
    }
    // Vectors pass through float32 either way, as Vectorize and the Durable Object store them,
    // so a rerun from the cache ranks exactly like the first run.
    return { shape: [texts.length, vectors[0]?.length ?? 0], data: vectors.map((v) => Array.from(v!)) };
  }

  private window(model: string): RateWindow {
    let w = this.windows.get(model);
    if (!w) this.windows.set(model, (w = new RateWindow((this.opts.rpm ?? defaultRpm)(model), 60_000, this.clock)));
    return w;
  }

  private async call(model: string, input: unknown, s: ModelStats): Promise<unknown> {
    const retries = this.opts.retries ?? 10;
    for (let attempt = 0; ; attempt++) {
      await this.window(model).take();
      await this.api.take();
      const started = Date.now();
      s.requests++;
      try {
        const out = await this.inner.run(model, input);
        if (out === undefined || out === null) throw new RetryableError(`${model}: empty answer`);
        return out;
      } catch (err) {
        if (attempt >= retries || !isRetryable(err)) {
          s.failed++;
          throw err;
        }
        s.retries++;
        await this.clock.sleep(Math.min(60_000, 1000 * 2 ** attempt) * (0.75 + Math.random() * 0.5));
      } finally {
        s.ms += Date.now() - started;
      }
    }
  }
}

function words(text: string): string[] {
  return text
    .toLowerCase()
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 2);
}

/** Hashed bag of words: texts that share words are similar. */
export function fakeEmbedding(text: string): number[] {
  const v = new Array<number>(256).fill(0);
  for (const w of words(text)) {
    let h = 0x811c9dc5;
    for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 0x01000193) >>> 0;
    v[h % 256]! += 1;
  }
  return v;
}

/**
 * Offline stand-in for smoke tests of the harness: bag-of-words embeddings,
 * word-overlap reranking, and an extraction that finds nothing. Scores from it say nothing about rhizome.
 */
export class FakeAi implements AiRunner {
  async run(_model: string, input: unknown): Promise<unknown> {
    const i = input as { text?: string | string[]; query?: string; contexts?: { text: string }[]; messages?: unknown };
    if (i.text !== undefined) return { data: (Array.isArray(i.text) ? i.text : [i.text]).map(fakeEmbedding) };
    if (i.query !== undefined && i.contexts) {
      const q = new Set(words(i.query));
      return {
        response: i.contexts.map((c, id) => {
          const w = words(c.text);
          return { id, score: w.length ? w.filter((x) => q.has(x)).length / w.length : 0 };
        }),
      };
    }
    if (i.messages) return { response: JSON.stringify({ facts: [], entities: [] }) };
    throw new Error("unsupported AI input");
  }
}
