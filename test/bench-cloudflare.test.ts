// SPDX-License-Identifier: AGPL-3.0-or-later
// The benchmark on Cloudflare (bench/worker.ts): dataset import, run params, the
// Workers AI gate, waiting for Vectorize, and whole runs of the Workflow on the
// Node stand-ins, with a fake step runner.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAi } from "../bench/ai";
import { workerVars } from "../bench/harness";
import { JsonArraySplitter, type Question, type Turn } from "../bench/longmemeval";
import { parseResults } from "../bench/metrics";
import { evalResultLine, hypothesisLine, judgePrompt, type QaRecord } from "../bench/official";
import {
  AiGate,
  AiOutputCache,
  BenchMemory,
  BenchWorkflow,
  DATA_PREFIX,
  EmbeddingCache,
  TrackedVectors,
  aiCacheKey,
  embeddingCacheKey,
  pacedAi,
  questionKey,
  runSettings,
  type BenchEnv,
  type RunOutput,
  type RunParams,
} from "../bench/worker";
import { DEFAULT_EMBEDDING_MODEL, runAi } from "../src/env";
import { LocalBucket } from "../src/node/blobs";
import { LocalNamespace } from "../src/node/durable";
import { LocalVectorIndex } from "../src/node/vectors";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rhizome-bench-cf-"));
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

const talk = (topic: string, n: number): Turn[] =>
  Array.from({ length: n }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `${topic} ${i}: some talk about ${topic}, and more about ${topic}.` }));

function question(id: string, type: string, text: string, answer: Turn[]): Question {
  return {
    question_id: id,
    question_type: type,
    question: text,
    answer: "",
    question_date: "2023/06/01 (Thu) 10:00",
    haystack_session_ids: [`${id}_a`, `${id}_b`, `${id}_c`],
    haystack_dates: ["2023/05/01 (Mon) 09:00", "2023/05/10 (Wed) 12:00", "2023/05/20 (Sat) 18:30"],
    haystack_sessions: [talk("gardening tomatoes", 4), answer, talk("python programming errors", 4)],
    answer_session_ids: [`${id}_b`],
  };
}

const DATASET: Question[] = [
  question("c1", "single-session-user", "What is the name of my cat?", [
    { role: "user", content: "I adopted a cat, her name is Luna. Her fur is café au lait.", has_answer: true },
    { role: "assistant", content: "Luna is a lovely name for a cat." },
  ]),
  question("c2", "knowledge-update", "Which company do I work for?", [{ role: "user", content: "I work for Globex as a designer now.", has_answer: true }]),
  question("c3_abs", "single-session-user", "What is the name of my dog?", [{ role: "user", content: "I adopted a cat, her name is Luna." }]),
];

/** The dataset as an HTTP response, in small pieces that split objects and characters. */
function datasetResponse(text: string, size = 97): Response {
  const bytes = new TextEncoder().encode(text);
  return new Response(
    new ReadableStream({
      start(c) {
        for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size));
        c.close();
      },
    }),
  );
}

/** The gate as LocalNamespace sees it (AiGate has no alarm of its own). */
type Gate = { reserve(model: string, rpm: number): number; alarm?: () => Promise<void> };
const GateClass = AiGate as unknown as new (ctx: DurableObjectState, env: unknown) => Gate;

/** The local index with Vectorize's limit on deletes, which the stand-in does not have. */
function vectorizeLimits(index: LocalVectorIndex): LocalVectorIndex {
  return new Proxy(index, {
    get(target, prop) {
      if (prop === "deleteByIds") {
        return (ids: string[]) => {
          if (ids.length > 100) throw new Error(`VECTOR_DELETE_ERROR (code = 40007): too many ids in payload; max id count is 100, got ${ids.length}`);
          return target.deleteByIds(ids);
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

function benchEnv(root: string): { env: BenchEnv; close: () => void } {
  const vectors = new LocalVectorIndex(join(root, "vectors.sqlite"));
  const bucket = new LocalBucket(join(root, "bucket"));
  let env!: BenchEnv;
  const memory = new LocalNamespace(join(root, "memory"), BenchMemory, () => env);
  const gate = new LocalNamespace(join(root, "gate"), GateClass, () => env);
  env = { AI: new FakeAi(), MEMORY: memory, AI_GATE: gate, BENCH: bucket, EPISODES: bucket, VECTORS: vectorizeLimits(vectors), RECALL_FEATURES: "all", CHUNKING: "rounds" } as unknown as BenchEnv;
  return {
    env,
    close: () => {
      memory.close();
      gate.close();
      vectors.close();
    },
  };
}

/** Runs steps like Workflows: retried up to their limit, and a finished step's result is kept by name. */
function fakeStep() {
  const results = new Map<string, unknown>();
  const ran: string[] = [];
  const step = {
    async do(name: string, a: unknown, b?: unknown) {
      const callback = (typeof a === "function" ? a : b) as (ctx: unknown) => Promise<unknown>;
      const config = (typeof a === "function" ? {} : a) as WorkflowStepConfig;
      if (results.has(name)) return results.get(name);
      ran.push(name);
      for (let attempt = 1; ; attempt++) {
        try {
          const out = await callback({ step: { name, count: 1 }, attempt, config });
          results.set(name, out);
          return out;
        } catch (err) {
          if (attempt > (config.retries?.limit ?? 5)) throw err;
        }
      }
    },
  };
  return { step: step as unknown as WorkflowStep, ran };
}

const event = (instanceId: string, payload: RunParams) => ({ instanceId, payload, timestamp: new Date(), workflowName: "rhizome-bench" });

async function text(env: BenchEnv, key: string): Promise<string> {
  const object = await env.BENCH.get(key);
  if (!object) throw new Error(`missing ${key}`);
  return object.text();
}

describe("dataset import", () => {
  it("splits a JSON array of objects at any chunk boundary", () => {
    const items = [{ a: "x{y}[z]" }, { b: 'quote " and backslash \\', c: [1, { d: 2 }] }, { e: "ü" }];
    const json = " [\n" + items.map((i) => JSON.stringify(i)).join(" ,\n ") + "\n] \n";
    for (const size of [1, 2, 3, 7, 1000]) {
      const splitter = new JsonArraySplitter();
      const out: string[] = [];
      for (let i = 0; i < json.length; i += size) out.push(...splitter.push(json.slice(i, i + size)));
      splitter.end();
      expect(out.map((o) => JSON.parse(o))).toEqual(items);
    }
  });

  it("refuses what is not an array of objects", () => {
    const split = (json: string) => {
      const splitter = new JsonArraySplitter();
      splitter.push(json);
      splitter.end();
    };
    expect(() => split('{"a": 1}')).toThrow(/not a JSON array/);
    expect(() => split("[1, 2]")).toThrow(/array of objects/);
    expect(() => split('[{"a": 1} {"b": 2}]')).toThrow(/separated by commas/);
    expect(() => split('[{"a": 1},]')).toThrow(/array of objects/);
    expect(() => split('[{"a": 1}] x')).toThrow(/after the dataset/);
    expect(() => split('[{"a": 1}')).toThrow(/ended inside/);
    expect(() => split("[]")).not.toThrow();
  });
});

describe("run params", () => {
  const env = { RECALL_FEATURES: "all", CHUNKING: "rounds" };

  it("default to the deployed configuration", () => {
    expect(runSettings(undefined, env)).toMatchObject({
      features: null,
      chunking: null,
      extraction: false,
      asOf: false,
      concurrency: 8,
      paidRpm: 15,
      baseline: null,
      vars: { RECALL_FEATURES: "all", CHUNKING: "rounds" },
      embeddingCache: true,
    });
    expect(runSettings({ extraction: true }, env).concurrency).toBe(4);
    expect(runSettings({ embeddingCache: false }, env).embeddingCache).toBe(false);
  });

  it("take recall steps, chunking, a selection and memory variables", () => {
    expect(runSettings({ features: "none", chunking: "fixed" }, env)).toMatchObject({ features: [], chunking: "fixed" });
    expect(runSettings({ features: [] }, env).features).toEqual([]);
    expect(runSettings({ features: "abstain, Time" }, env).features).toEqual(["abstain", "time"]);
    expect(runSettings('{"sample": 10, "seed": 2, "types": "abstention"}', env).selection).toMatchObject({ sample: 10, seed: 2, types: ["abstention"] });
    expect(runSettings({ vars: { EMBEDDING_MODEL: "@cf/some/model" } }, env).vars).toEqual({ RECALL_FEATURES: "all", CHUNKING: "rounds", EMBEDDING_MODEL: "@cf/some/model" });
  });

  it("refuse typos before any question runs", () => {
    expect(() => runSettings("sample=10", env)).toThrow(/JSON object/);
    expect(() => runSettings({ feature: "all" }, env)).toThrow(/unknown param "feature"/);
    expect(() => runSettings({ features: "abstian" }, env)).toThrow(/unknown recall step "abstian"/);
    expect(() => runSettings({ chunking: "sentences" }, env)).toThrow(/chunking/);
    expect(() => runSettings({ vars: { EXTRACTION: "on" } }, env)).toThrow(/not a variable of the memory code/);
    expect(() => runSettings({ concurrency: 0 }, env)).toThrow(/concurrency/);
    expect(() => runSettings({ extraction: true, concurrency: 16 }, env)).toThrow(/with extraction/);
    expect(() => runSettings({ asOf: "yes" }, env)).toThrow(/asOf/);
    expect(() => runSettings({ baseline: "../other" }, env)).toThrow(/baseline/);
    expect(() => runSettings({ reader: "gpt 4o" }, env)).toThrow(/reader must be an OpenAI model id/);
    expect(() => runSettings({ embeddingCache: "off" }, env)).toThrow(/embeddingCache/);
  });

  it("take a reader for LongMemEval's own evaluation", () => {
    expect(runSettings(undefined, env).reader).toBeNull();
    expect(runSettings({ reader: "gpt-4o-2024-08-06" }, env).reader).toBe("gpt-4o-2024-08-06");
    expect(runSettings({ reader: "gpt-4o-2024-08-06" }, env).readerEffort).toBeNull();
    // Reasoning readers think at medium effort unless the run says otherwise.
    expect(runSettings({ reader: "gpt-6.1-terra" }, env).readerEffort).toBe("medium");
    expect(runSettings({ reader: "gpt-6.1-terra", readerEffort: "high" }, env).readerEffort).toBe("high");
    expect(() => runSettings({ reader: "gpt-6.1-terra", readerEffort: "extreme" }, env)).toThrow(/readerEffort must be one of/);
    expect(() => runSettings({ reader: "gpt-4o-2024-08-06", readerEffort: "low" }, env)).toThrow(/needs a reasoning reader/);
  });

  it("keep the paid models' answers unless told not to", () => {
    expect(runSettings(undefined, env).aiCache).toBe(true);
    expect(runSettings({ aiCache: false }, env).aiCache).toBe(false);
    expect(() => runSettings({ aiCache: "no" }, env)).toThrow(/aiCache/);
  });
});

describe("Workers AI", () => {
  it("hands out slots per paid model, for all questions together", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(1_000_000);
    const gates = new LocalNamespace(join(dir, "gate"), GateClass, () => ({}));
    const gate = gates.get(gates.idFromName("workers-ai"));
    try {
      expect(await gate.reserve("@cf/deepseek/deepseek-v4-flash", 60)).toBe(0);
      expect(await gate.reserve("@cf/deepseek/deepseek-v4-flash", 60)).toBe(1_000);
      expect(await gate.reserve("@cf/zai-org/glm-5", 60)).toBe(0);
      vi.setSystemTime(1_000_400);
      expect(await gate.reserve("@cf/deepseek/deepseek-v4-flash", 60)).toBe(1_600);
    } finally {
      gates.close();
    }
  });

  it("paces only the paid models and tries again when that is worth it", async () => {
    const calls: string[] = [];
    let busy = 2;
    const ai = {
      async run(model: string) {
        calls.push(model);
        if (model.includes("busy") && busy-- > 0) throw new Error("3040: Capacity temporarily exceeded, please try again.");
        if (model.includes("broken")) throw new Error("AiError: 400: Bad input");
        return { model };
      },
    } as unknown as Ai;
    const reserved: string[] = [];
    const paced = pacedAi(ai, async (model) => (reserved.push(model), 0), 4, 0);
    await expect(runAi(paced, "@cf/busy/model", {})).resolves.toEqual({ model: "@cf/busy/model" });
    expect(calls.filter((c) => c === "@cf/busy/model")).toHaveLength(3);
    await expect(runAi(paced, "@cf/broken/model", {})).rejects.toThrow(/400/);
    expect(calls.filter((c) => c === "@cf/broken/model")).toHaveLength(1);
    await runAi(paced, "@cf/deepseek/deepseek-v4-flash", {});
    expect(reserved).toEqual(["@cf/deepseek/deepseek-v4-flash"]);
  });

  it("answers a question's embeddings from its cache on the next run", async () => {
    const objects = new Map<string, string>();
    const bucket = {
      get: async (k: string) => (objects.has(k) ? { json: async () => JSON.parse(objects.get(k)!) } : null),
      put: async (k: string, v: string) => void objects.set(k, v),
    } as unknown as R2Bucket;
    const sent: string[][] = [];
    const ai = {
      async run(model: string, input: { text?: string[] }) {
        if (input.text) {
          sent.push(input.text);
          return { data: input.text.map((t) => [t.length + 0.1, 1 / 3]) };
        }
        return { model };
      },
    } as unknown as Ai;
    const model = "@cf/baai/bge-m3";
    const key = embeddingCacheKey(questionKey("q 1"), model);
    expect(key).toBe("cache/embeddings/%40cf%2Fbaai%2Fbge-m3/q%25201.json");

    const first = new EmbeddingCache(bucket, key, model);
    await first.load();
    const a = (await runAi(first.wrap(ai), model, { text: ["one", "two", "one"] })) as { data: number[][] };
    expect(sent).toEqual([["one", "two"]]);
    expect(a.data).toEqual([[Math.fround(3.1), Math.fround(1 / 3)], [Math.fround(3.1), Math.fround(1 / 3)], [Math.fround(3.1), Math.fround(1 / 3)]]);
    // Other models and inputs pass through untouched.
    expect(await runAi(first.wrap(ai), "@cf/baai/bge-reranker-base", { query: "q", contexts: [] })).toEqual({ model: "@cf/baai/bge-reranker-base" });
    await first.save();

    const next = new EmbeddingCache(bucket, key, model);
    await next.load();
    const b = (await runAi(next.wrap(ai), model, { text: ["two", "one", "three"] })) as { data: number[][] };
    expect(sent).toEqual([["one", "two"], ["three"]]);
    expect(b.data[1]).toEqual(a.data[0]);
    expect([next.hits, next.misses]).toEqual([2, 1]);
    // A cache of another model is ignored.
    const other = new EmbeddingCache(bucket, key, "@cf/other/model");
    await other.load();
    await runAi(other.wrap(ai), "@cf/other/model", { text: ["one"] });
    expect(sent.at(-1)).toEqual(["one"]);
  });
});

describe("AI cache", () => {
  it("answers a paid model's repeated request from the bucket, and leaves other models alone", async () => {
    const objects = new Map<string, string>();
    const bucket = {
      get: async (k: string) => (objects.has(k) ? { json: async () => JSON.parse(objects.get(k)!) } : null),
      put: async (k: string, v: string) => void objects.set(k, v),
    } as unknown as R2Bucket;
    let calls = 0;
    const ai = { run: async (model: string) => ({ response: `${model} ${++calls}` }) } as unknown as Ai;
    const paid = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
    const input = { messages: [{ role: "user", content: "x" }], max_tokens: 10, temperature: 0 };

    const first = new AiOutputCache(bucket);
    expect(await runAi(first.wrap(ai), paid, input)).toEqual({ response: `${paid} 1` });
    // Key order does not matter, the request does.
    const next = new AiOutputCache(bucket);
    expect(await runAi(next.wrap(ai), paid, { temperature: 0, max_tokens: 10, messages: [{ role: "user", content: "x" }] })).toEqual({ response: `${paid} 1` });
    expect(await runAi(next.wrap(ai), paid, { ...input, max_tokens: 11 })).toEqual({ response: `${paid} 2` });
    expect([next.hits, next.misses]).toEqual([1, 1]);
    // Free models (reranker, embeddings) are not kept.
    await runAi(next.wrap(ai), "@cf/baai/bge-reranker-base", { query: "q", contexts: [] });
    await runAi(next.wrap(ai), "@cf/baai/bge-reranker-base", { query: "q", contexts: [] });
    expect(calls).toBe(4);
    expect(objects.size).toBe(2);
    expect(await aiCacheKey(paid, input)).toMatch(/^cache\/ai\/%40cf%2Fdeepseek-ai%2Fdeepseek-v4\.1-flash-1017\/[0-9a-f]{64}\.json$/);
  });

  it("still answers when the bucket fails", async () => {
    const bucket = { get: async () => Promise.reject(new Error("R2 down")), put: async () => Promise.reject(new Error("R2 down")) } as unknown as R2Bucket;
    const ai = { run: async () => ({ response: "ok" }) } as unknown as Ai;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runAi(new AiOutputCache(bucket).wrap(ai), "@cf/zai-org/glm-5.3", { messages: [] })).toEqual({ response: "ok" });
    } finally {
      errors.mockRestore();
    }
  });
});

describe("Vectorize", () => {
  it("waits until a search finds the question's last vector", async () => {
    const local = new LocalVectorIndex(join(dir, "vectors.sqlite"));
    let hidden = 2;
    let processed = "";
    const lagging = {
      upsert: (v: VectorizeVector[]) => local.upsert(v as never),
      deleteByIds: (ids: string[]) => local.deleteByIds(ids),
      query: async (v: number[], o: VectorizeQueryOptions) => (hidden-- > 0 ? { matches: [], count: 0 } : local.query(v, o as never)),
      describe: async () => ({ processedUpToMutation: processed }),
    };
    try {
      const vectors = new TrackedVectors(lagging as unknown as Vectorize);
      await vectors.searchable(1_000, 1); // nothing written yet
      const written = await vectors.upsert([{ id: "a", values: [1, 0, 0], namespace: "n", metadata: { scope: "profile", kind: "chunk" } }]);
      await vectors.searchable(1_000, 1);
      expect(hidden).toBeLessThan(0);

      hidden = Number.POSITIVE_INFINITY;
      await expect(vectors.searchable(20, 1)).rejects.toThrow(/had not applied/);
      processed = written.mutationId;
      await vectors.searchable(1_000, 1);
    } finally {
      local.close();
    }
  });

  it("probes with a vector that still exists when the last one was deleted", async () => {
    const local = new LocalVectorIndex(join(dir, "vectors.sqlite"));
    const vectors = new TrackedVectors({
      upsert: (v: VectorizeVector[]) => local.upsert(v as never),
      deleteByIds: (ids: string[]) => local.deleteByIds(ids),
      query: (v: number[], o: VectorizeQueryOptions) => local.query(v, o as never),
    } as unknown as Vectorize);
    try {
      await vectors.upsert([{ id: "a", values: [1, 0, 0], namespace: "n", metadata: { scope: "profile", kind: "chunk" } }]);
      await vectors.upsert([{ id: "b", values: [0, 1, 0], namespace: "n", metadata: { scope: "profile", kind: "note" } }]);
      await vectors.deleteByIds(["b"]);
      await vectors.searchable(200, 1);
    } finally {
      local.close();
    }
  });
});

describe("benchmark Worker", () => {
  it("measures the deployed configuration and has no route", () => {
    const bench = readFileSync("wrangler.bench.jsonc", "utf8");
    const deployed = workerVars(readFileSync("wrangler.jsonc", "utf8"));
    const vars = workerVars(bench);
    for (const key of ["RECALL_FEATURES", "CHUNKING", "DISPUTE_RESOLUTION"]) expect(vars[key]).toBe(deployed[key]);
    expect(vars.EXTRACTION).toBe("off");
    expect(bench).toMatch(/"workers_dev":\s*false/);
    expect(bench).not.toMatch(/"routes"/);
  });

  it("deletes everything of a question with more vectors than Vectorize deletes at once", async () => {
    const { env, close } = benchEnv(dir);
    try {
      const big = question("big", "single-session-user", "What is the name of my cat?", [{ role: "user", content: "My cat is called Luna.", has_answer: true }]);
      // 120 rounds long enough to be a chunk each.
      big.haystack_sessions[0] = Array.from({ length: 240 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `garden ${i}: ` + "more about the tomatoes and the beans. ".repeat(6) }));
      await env.BENCH.put(questionKey("big"), JSON.stringify(big));
      const memory = env.MEMORY.get(env.MEMORY.idFromName("big"));
      const record = await memory.benchRun({ key: questionKey("big"), userId: "big-1", vars: { CHUNKING: "rounds" }, extraction: false, reflect: false, asOf: false, paidRpm: 15, idleTimeoutMs: 60_000, vectorTimeoutMs: 60_000 });
      expect(record.chunks).toBeGreaterThan(100);
      const db = new DatabaseSync(join(dir, "vectors.sqlite"));
      expect(db.prepare("SELECT COUNT(*) AS n FROM vectors").get()).toEqual({ n: 0 });
      db.close();
      const episodes = readdirSync(join(dir, "bucket", "users"), { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
      expect(episodes).toEqual([]);
    } finally {
      close();
    }
  }, 60_000);

  it("runs a Workflow of questions on fresh memories, cleans up after each and compares runs", async () => {
    const fetches = vi.fn(async () => datasetResponse(JSON.stringify(DATASET)));
    vi.stubGlobal("fetch", fetches);
    const { env, close } = benchEnv(dir);
    try {
      const workflow = new BenchWorkflow({} as ExecutionContext, env);
      const first = fakeStep();
      const out = (await workflow.run(event("base", { features: "none", chunking: "fixed" }), first.step)) as RunOutput;
      expect(out).toMatchObject({ runId: "base", questions: 3, failed: 0 });
      expect(out.summary.scored).toBe(2);
      expect(out.summary.overall["recall_any@5"]).toBe(1);
      expect(first.ran).toEqual(expect.arrayContaining(["dataset", "config", "question c1", "question c2", "question c3_abs", "summary"]));

      const index = JSON.parse(await text(env, `${DATA_PREFIX}/index.json`));
      expect(index.questions.map((q: Question) => q.question_id)).toEqual(["c1", "c2", "c3_abs"]);
      expect(index.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.parse(await text(env, questionKey("c1")))).toEqual(DATASET[0]);
      const config = JSON.parse(await text(env, "runs/base/config.json"));
      expect(config.settings).toMatchObject({ dataset: index.sha256, features: [], chunking: "fixed", asOf: false, vars: { RECALL_FEATURES: "all", CHUNKING: "rounds" } });
      expect(parseResults(await text(env, "runs/base/results.jsonl")).map((r) => r.id)).toEqual(["c1", "c2", "c3_abs"]);
      expect(await text(env, "runs/base/summary.md")).toContain("run base");
      // The questions' embeddings stay for the next run.
      expect(await env.BENCH.get(embeddingCacheKey(questionKey("c1"), DEFAULT_EMBEDDING_MODEL))).not.toBeNull();

      // Nothing of the questions is left: no vectors, no raw episodes.
      const db = new DatabaseSync(join(dir, "vectors.sqlite"));
      expect(db.prepare("SELECT COUNT(*) AS n FROM vectors").get()).toEqual({ n: 0 });
      db.close();
      const episodes = readdirSync(join(dir, "bucket", "users"), { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
      expect(episodes).toEqual([]);

      // The next run reuses the dataset, records a question that failed on every attempt, and compares.
      await env.BENCH.delete(questionKey("c2"));
      const second = fakeStep();
      const next = (await workflow.run(event("deployed", { baseline: "base" }), second.step)) as RunOutput;
      expect(fetches).toHaveBeenCalledTimes(1);
      expect(next).toMatchObject({ questions: 3, failed: 1 });
      const failed = parseResults(await text(env, "runs/deployed/results.jsonl")).find((r) => r.id === "c2");
      expect(failed?.error).toMatch(/no question at/);
      expect(next.comparison).toContain("base");
      expect(await text(env, "runs/deployed/comparison.md")).toBe(next.comparison);

      // A replayed run takes every finished step from its results.
      const replay = (await workflow.run(event("deployed", { baseline: "base" }), second.step)) as RunOutput;
      expect(replay).toEqual(next);
    } finally {
      close();
    }
  }, 60_000);

  it("has a reader answer from the recall tool's text and GPT-4o judge it, writing LongMemEval's files", async () => {
    const answers = ["Luna", "Globex", "You never mentioned a dog."];
    const data = DATASET.map((q, i) => ({ ...q, answer: answers[i]! }));
    const calls: { model: string; max_tokens: number; content: string }[] = [];
    const fetches = vi.fn(async (url: string, init?: RequestInit) => {
      if (!String(url).startsWith("https://openai.test/v1/")) return datasetResponse(JSON.stringify(data));
      expect(url).toBe("https://openai.test/v1/chat/completions");
      expect((init!.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
      const body = JSON.parse(String(init!.body)) as { model: string; max_tokens: number; messages: { content: string }[] };
      const content = body.messages[0]!.content;
      calls.push({ model: body.model, max_tokens: body.max_tokens, content });
      const reply = (text: string, model: string) =>
        new Response(JSON.stringify({ model, choices: [{ message: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 100, completion_tokens: 5 } }), { status: 200 });
      if (body.max_tokens === 800) {
        if (content.includes("Which company")) return new Response(JSON.stringify({ error: { code: "context_length_exceeded", message: "too long" } }), { status: 400 });
        return reply(content.includes("name of my cat") ? "  Her name is Luna.\n" : "I don't know about a dog.", "gpt-4o-2024-08-06");
      }
      return reply(content.includes("Model Response: Her name is Luna.") || content.includes("unanswerable") ? "Yes" : "No", "gpt-4o-2024-08-06");
    });
    vi.stubGlobal("fetch", fetches);
    const { env, close } = benchEnv(dir);
    try {
      const workflow = new BenchWorkflow({} as ExecutionContext, env);
      await expect(workflow.run(event("no-key", { reader: "gpt-4o-2024-08-06" }), fakeStep().step)).rejects.toThrow(/OPENAI_API_KEY/);

      Object.assign(env, { OPENAI_API_KEY: "sk-test", OPENAI_BASE_URL: "https://openai.test/v1" });
      const run = fakeStep();
      const out = (await workflow.run(event("official", { reader: "gpt-4o-2024-08-06" }), run.step)) as RunOutput;
      expect(out.failed).toBe(0);
      expect(run.ran).toEqual(expect.arrayContaining(["answer c1", "judge c1", "answer c2", "answer c3_abs", "judge c3_abs"]));
      expect(run.ran).not.toContain("judge c2");
      expect(out.official).toMatchObject({ reader: "gpt-4o-2024-08-06", judged: 2, failed: 1 });
      expect(out.official!.metrics.byType["single-session-user"]).toEqual({ n: 2, accuracy: 1 });
      expect(out.official!.metrics.abstention).toEqual({ n: 1, accuracy: 1 });

      // The reader got the recall tool's text and the question as LongMemEval states it.
      const read = calls.find((c) => c.max_tokens === 800 && c.content.includes("name of my cat"))!;
      expect(read.model).toBe("gpt-4o-2024-08-06");
      expect(read.content).toMatch(/^I will give you several history chats between you and a user\./);
      expect(read.content).toContain("(profile · conversation · ");
      expect(read.content).toContain("Luna");
      expect(read.content).toMatch(/\n\nCurrent Date: 2023\/06\/01 \(Thu\) 10:00\nQuestion: What is the name of my cat\?\nAnswer \(step by step\):$/);
      // The judge got evaluate_qa.py's prompt for the trimmed answer; the 400 was not tried again.
      const judged = calls.filter((c) => c.max_tokens === 10);
      expect(judged.map((c) => c.model)).toEqual(["gpt-4o-2024-08-06", "gpt-4o-2024-08-06"]);
      expect(judged.map((c) => c.content)).toContain(judgePrompt("single-session-user", "What is the name of my cat?", "Luna", "Her name is Luna.", false));
      expect(calls.filter((c) => c.max_tokens === 800 && c.content.includes("Which company"))).toHaveLength(1);

      expect(await text(env, "runs/official/hypotheses.jsonl")).toBe(
        [hypothesisLine("c1", "Her name is Luna."), hypothesisLine("c3_abs", "I don't know about a dog.")].join("\n") + "\n",
      );
      expect(await text(env, "runs/official/hypotheses.jsonl.eval-results-gpt-4o")).toBe(
        [evalResultLine("c1", "Her name is Luna.", true), evalResultLine("c3_abs", "I don't know about a dog.", true)].join("\n") + "\n",
      );
      const qa = (await text(env, "runs/official/qa.jsonl")).trim().split("\n").map((l) => JSON.parse(l) as QaRecord);
      expect(qa.map((r) => r.id)).toEqual(["c1", "c2", "c3_abs"]);
      expect(qa[1]!.error).toMatch(/^reader: OpenAI answered HTTP 400 \(context_length_exceeded\)/);
      expect(qa[0]).toMatchObject({ label: true, judgeReply: "Yes", readerModel: "gpt-4o-2024-08-06", judgeModel: "gpt-4o-2024-08-06", readerTokens: { prompt: 100, completion: 5 } });
      expect(qa[0]!.contextItems).toBeGreaterThan(0);
      const contexts = (await text(env, "runs/official/contexts.jsonl")).trim().split("\n").map((l) => JSON.parse(l));
      expect(contexts.map((c) => c.question_id)).toEqual(["c1", "c2", "c3_abs"]);
      expect(read.content).toContain(contexts[0].text);
      const md = await text(env, "runs/official/official.md");
      expect(md).toContain("2 of 3 questions answered and judged, **1 failed**");
      expect(md).toContain("Overall accuracy");
      expect(JSON.parse(await text(env, "runs/official/config.json")).official).toMatchObject({ reader: "gpt-4o-2024-08-06", judge: "gpt-4o-2024-08-06" });
      // results.jsonl keeps its shape: no recall text in it, LongMemEval's own retrieval scores for the questions they count.
      const results = parseResults(await text(env, "runs/official/results.jsonl"));
      expect(results.every((r) => !("view" in r))).toBe(true);
      expect(results.find((r) => r.id === "c1")!.official).toMatchObject({ "recall_any@1": expect.any(Number), "ndcg_any@50": expect.any(Number) });
      expect(results.find((r) => r.id === "c3_abs")!.official).toBeUndefined();
      expect(out.summary.official?.questions).toBe(2);
    } finally {
      close();
    }
  }, 60_000);
});
