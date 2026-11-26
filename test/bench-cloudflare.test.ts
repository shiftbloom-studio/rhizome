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
import {
  AiGate,
  BenchMemory,
  BenchWorkflow,
  DATA_PREFIX,
  TrackedVectors,
  pacedAi,
  questionKey,
  runSettings,
  type BenchEnv,
  type RunOutput,
  type RunParams,
} from "../bench/worker";
import { runAi } from "../src/env";
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

function benchEnv(root: string): { env: BenchEnv; close: () => void } {
  const vectors = new LocalVectorIndex(join(root, "vectors.sqlite"));
  const bucket = new LocalBucket(join(root, "bucket"));
  let env!: BenchEnv;
  const memory = new LocalNamespace(join(root, "memory"), BenchMemory, () => env);
  const gate = new LocalNamespace(join(root, "gate"), GateClass, () => env);
  env = { AI: new FakeAi(), MEMORY: memory, AI_GATE: gate, BENCH: bucket, EPISODES: bucket, VECTORS: vectors, RECALL_FEATURES: "all", CHUNKING: "rounds" } as unknown as BenchEnv;
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
    });
    expect(runSettings({ extraction: true }, env).concurrency).toBe(4);
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
});

describe("benchmark Worker", () => {
  it("measures the deployed configuration and has no route", () => {
    const bench = readFileSync("wrangler.bench.jsonc", "utf8");
    const deployed = workerVars(readFileSync("wrangler.jsonc", "utf8"));
    const vars = workerVars(bench);
    for (const key of ["RECALL_FEATURES", "CHUNKING"]) expect(vars[key]).toBe(deployed[key]);
    expect(vars.EXTRACTION).toBe("off");
    expect(bench).toMatch(/"workers_dev":\s*false/);
    expect(bench).not.toMatch(/"routes"/);
  });

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
});
