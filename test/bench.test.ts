// SPDX-License-Identifier: AGPL-3.0-or-later
// The LongMemEval harness: dataset checks, scores, the cached and rate-limited
// AI client, and a small end-to-end run on the real MemoryObject with the Node stand-ins.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AiCache, BenchAi, FakeAi, RateWindow, isRetryable, stableJson, type AiRunner, type Clock } from "../bench/ai";
import { coveredTurns, indexSession, readResults, runBenchmark, workerVars } from "../bench/harness";
import { parseDate, select, typeKey, validateDataset, type Question, type Turn } from "../bench/longmemeval";
import { compareRuns, mcnemar, rankingScores, scoreQuestion, sessionOrder, summarize, turnCoverage } from "../bench/metrics";
import { chunk, roundChunks, transcript } from "../src/text";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rhizome-bench-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const filler = (topic: string, n: number): Turn[] =>
  Array.from({ length: n }, (_, i) => ({
    role: i % 2 ? "assistant" : "user",
    content: `${topic} ${i}: ` + `Some general talk about ${topic} with many words that repeat in long sentences. `.repeat(6),
  }));

function question(id: string, type: string, text: string, evidence: { id: string; date: string; turns: Turn[] }[], date = "2023/06/01 (Thu) 10:00"): Question {
  const sessions = [
    { id: `${id}_filler_1`, date: "2023/05/01 (Mon) 09:00", turns: filler("gardening tomatoes", 4) },
    ...evidence,
    { id: `${id}_filler_2`, date: "2023/05/20 (Sat) 18:30", turns: filler("python programming errors", 4) },
  ].sort((a, b) => parseDate(a.date) - parseDate(b.date));
  return {
    question_id: id,
    question_type: type,
    question: text,
    answer: "",
    question_date: date,
    haystack_session_ids: sessions.map((s) => s.id),
    haystack_dates: sessions.map((s) => s.date),
    haystack_sessions: sessions.map((s) => s.turns),
    answer_session_ids: evidence.map((e) => e.id),
  };
}

const DATASET: Question[] = [
  question("q1", "single-session-user", "What is the name of my cat?", [
    {
      id: "answer_q1_1",
      date: "2023/05/10 (Wed) 12:00",
      turns: [
        { role: "user", content: "I adopted a cat last spring, her name is Luna.", has_answer: true },
        { role: "assistant", content: "Luna is a lovely name for a cat." },
      ],
    },
  ]),
  question("q2", "knowledge-update", "Which company do I work for now?", [
    { id: "answer_q2_1", date: "2023/03/02 (Thu) 08:00", turns: [{ role: "user", content: "I work for Acme as a designer, the company is great.", has_answer: true }] },
    { id: "answer_q2_2", date: "2023/05/15 (Mon) 08:00", turns: [{ role: "user", content: "I switched jobs, my company is now Globex.", has_answer: true }] },
  ]),
  question("q3", "temporal-reasoning", "When did I run the Berlin marathon?", [
    { id: "answer_q3_1", date: "2023/04/09 (Sun) 20:00", turns: [{ role: "user", content: "Today I ran the Berlin marathon in four hours.", has_answer: true }] },
  ]),
  question("q4_abs", "single-session-user", "What is the name of my dog?", [
    { id: "answer_q4_1", date: "2023/05/10 (Wed) 12:00", turns: [{ role: "user", content: "I adopted a cat last spring, her name is Luna." }] },
  ]),
];

describe("LongMemEval data", () => {
  it("reads its dates as UTC", () => {
    expect(parseDate("2023/05/20 (Sat) 02:21")).toBe(Date.UTC(2023, 4, 20, 2, 21));
    expect(parseDate("2023/05/20")).toBe(Date.UTC(2023, 4, 20));
    expect(() => parseDate("May 20, 2023")).toThrow(/unrecognised/);
  });

  it("checks the shape before a run", () => {
    expect(validateDataset(JSON.parse(JSON.stringify(DATASET)))).toHaveLength(4);
    const broken = JSON.parse(JSON.stringify(DATASET)) as Question[];
    broken[1]!.haystack_dates.pop();
    expect(() => validateDataset(broken)).toThrow(/question 1/);
    expect(() => validateDataset({})).toThrow(/array/);
  });

  it("selects by id, type, limit and a stratified, seeded sample", () => {
    expect(typeKey(DATASET[3]!)).toBe("abstention");
    expect(select(DATASET, { ids: ["q2", "q4_abs"] }).map((q) => q.question_id)).toEqual(["q2", "q4_abs"]);
    expect(select(DATASET, { types: ["abstention"] }).map((q) => q.question_id)).toEqual(["q4_abs"]);
    expect(select(DATASET, { limit: 2 })).toHaveLength(2);
    const many = Array.from({ length: 100 }, (_, i) => ({ ...DATASET[0]!, question_id: `x${i}`, question_type: i < 60 ? "a" : "b" }));
    const a = select(many, { sample: 10, seed: 7 });
    expect(a).toHaveLength(10);
    expect(a.filter((q) => q.question_type === "a")).toHaveLength(6);
    expect(select(many, { sample: 10, seed: 7 })).toEqual(a);
    expect(select(many, { sample: 10, seed: 8 }).map((q) => q.question_id)).not.toEqual(a.map((q) => q.question_id));
  });
});

describe("scores", () => {
  it("ranks unique sessions and scores them like LongMemEval", () => {
    const order = sessionOrder([{ sessions: ["s3"], turns: [] }, { sessions: ["s1"], turns: [] }, { sessions: ["s3"], turns: [] }, { sessions: ["s2"], turns: [] }]);
    expect(order).toEqual(["s3", "s1", "s2"]);
    const ev = new Set(["s1", "s2"]);
    expect(rankingScores(order, ev, 1)).toEqual({ any: 0, all: 0, ndcg: 0 });
    const at3 = rankingScores(order, ev, 3);
    expect(at3.any).toBe(1);
    expect(at3.all).toBe(1);
    // Ranks 2 and 3 hit: (1 + 1/log2(3)) / (1 + 1), with LongMemEval's weights.
    expect(at3.ndcg).toBeCloseTo((1 + 1 / Math.log2(3)) / 2, 6);
  });

  it("measures turn coverage and what a default recall delivered", () => {
    const ranked = [
      { sessions: ["s9"], turns: [] },
      { sessions: ["s1"], turns: ["s1#0"] },
    ];
    expect(turnCoverage(ranked, new Set(["s1#0", "s1#4"]))).toBe(0.5);
    expect(turnCoverage(ranked, new Set())).toBeUndefined();
    const m = scoreQuestion(ranked, ranked.slice(0, 1), { sessions: new Set(["s1"]), turns: new Set(["s1#0"]) });
    expect(m).toMatchObject({ "recall_any@1": 0, "recall_any@3": 1, delivered_any: 0, delivered_turns: 0, "turn_recall@5": 1 });
  });

  it("finds the turns of fixed and round chunks, also where trimming changed the whitespace", () => {
    const turns: Turn[] = [
      { role: "user", content: "My trip to Lisbon starts on Friday.\n\n" },
      { role: "assistant", content: "Lisbon is lovely in spring.  \n" },
      { role: "user", content: "Which museum did I like there?" },
      { role: "assistant", content: "You liked the tile museum.\r\n" },
    ];
    const index = indexSession(turns);
    const [round] = roundChunks(turns);
    expect(round).not.toBe(chunk(transcript(turns))[0]);
    expect(coveredTurns(index, round!)).toEqual([0, 1, 2, 3]);
    expect(coveredTurns(index, chunk(transcript(turns))[0]!)).toEqual([0, 1, 2, 3]);
    expect(coveredTurns(index, "Which museum did I like there?")).toEqual([2]);
    expect(coveredTurns(index, "not in this session")).toEqual([]);
  });

  it("tests paired changes with McNemar's exact test", () => {
    expect(mcnemar(0, 0)).toBe(1);
    expect(mcnemar(5, 5)).toBe(1);
    expect(mcnemar(10, 0)).toBeCloseTo(2 / 1024, 8);
    const a = [{ id: "1", type: "t", abstention: false, metrics: { "recall_any@5": 0 } }, { id: "2", type: "t", abstention: false, metrics: { "recall_any@5": 1 } }];
    const b = [{ id: "1", type: "t", abstention: false, metrics: { "recall_any@5": 1 } }, { id: "2", type: "t", abstention: false, metrics: { "recall_any@5": 1 } }];
    const c = compareRuns(a, b);
    expect(c.questions).toBe(2);
    expect(c.metrics[0]).toMatchObject({ metric: "recall_any@5", a: 0.5, b: 1, better: 1, worse: 0, p: 1 });
  });
});

describe("benchmark AI client", () => {
  const counting = () => {
    const seen: unknown[] = [];
    const fake = new FakeAi();
    const inner: AiRunner = { run: async (model, input) => (seen.push(input), fake.run(model, input)) };
    return { inner, seen };
  };

  it("caches embeddings per text and other answers per input", async () => {
    const cache = new AiCache(join(dir, "ai.sqlite"));
    const { inner, seen } = counting();
    const ai = new BenchAi(inner, { cache });
    const first = (await ai.run("emb", { text: ["alpha beta", "gamma delta"] })) as { data: number[][] };
    const second = (await ai.run("emb", { text: ["gamma delta", "epsilon zeta"] })) as { data: number[][] };
    expect(seen).toEqual([{ text: ["alpha beta", "gamma delta"] }, { text: ["epsilon zeta"] }]);
    expect(second.data[0]).toEqual(first.data[1]);
    const rerank = { query: "alpha", contexts: [{ text: "alpha beta" }] };
    const r1 = await ai.run("rr", rerank);
    expect(await ai.run("rr", { contexts: [{ text: "alpha beta" }], query: "alpha" })).toEqual(r1);
    expect(seen).toHaveLength(3);
    expect(ai.stats.get("emb")).toMatchObject({ texts: 4, cachedTexts: 1 });
    expect(cache.size()).toEqual({ embeddings: 3, outputs: 1 });
    cache.close();

    // A new process reads the same answers back.
    const again = new AiCache(join(dir, "ai.sqlite"));
    const { inner: inner2, seen: seen2 } = counting();
    expect(await new BenchAi(inner2, { cache: again }).run("emb", { text: ["alpha beta"] })).toEqual({ shape: [1, 256], data: [first.data[0]] });
    expect(seen2).toEqual([]);
    again.close();
  });

  it("retries rate limits and server errors, not bad requests", async () => {
    const sleeps: number[] = [];
    const clock: Clock = { now: () => 0, sleep: async (ms) => void sleeps.push(ms) };
    let calls = 0;
    const flaky: AiRunner = {
      run: async () => {
        calls++;
        if (calls < 3) throw new Error("/client/v4/accounts/x/ai/run/m: HTTP 429 Too Many Requests");
        return { response: "ok" };
      },
    };
    expect(await new BenchAi(flaky, { clock }).run("m", { messages: [] })).toEqual({ response: "ok" });
    expect(calls).toBe(3);
    expect(sleeps).toHaveLength(2);
    const bad: AiRunner = { run: async () => Promise.reject(new Error("/ai/run/m: HTTP 400 bad input")) };
    await expect(new BenchAi(bad, { clock }).run("m", { messages: [] })).rejects.toThrow(/400/);
    expect(isRetryable(new Error("HTTP 503"))).toBe(true);
    expect(isRetryable(Object.assign(new Error("timed out"), { name: "TimeoutError" }))).toBe(true);
  });

  it("keeps to a request window", async () => {
    let now = 0;
    const clock: Clock = { now: () => now, sleep: async (ms) => void (now += ms) };
    const w = new RateWindow(2, 60_000, clock);
    await w.take();
    await w.take();
    expect(now).toBe(0);
    await w.take();
    expect(now).toBeGreaterThanOrEqual(60_000);
  });

  it("builds cache keys that ignore key order", () => {
    expect(stableJson({ b: 1, a: { d: 2, c: [3, { f: 4, e: 5 }] } })).toBe('{"a":{"c":[3,{"e":5,"f":4}],"d":2},"b":1}');
  });
});

describe("Worker vars", () => {
  it("reads plain values from wrangler.jsonc and skips deploy placeholders", () => {
    const jsonc = `// comment with "quotes"
    {
      "name": "x", /* block */
      "vars": {
        "ACCESS_AUD": "<ACCESS_AUD?>",
        "RECALL_FEATURES": "all", // on in production
        "CHUNKING": "rounds",
        "URL": "https://example.com/a//b",
      },
    }`;
    expect(workerVars(jsonc)).toEqual({ RECALL_FEATURES: "all", CHUNKING: "rounds", URL: "https://example.com/a//b" });
    expect(workerVars(readFileSync("wrangler.jsonc", "utf8"))).toBeTypeOf("object");
  });
});

describe("LongMemEval run", () => {
  it("scores questions on a real MemoryObject, resumes and refuses changed settings", async () => {
    const out = join(dir, "run");
    const lines: string[] = [];
    const opts = { out, ai: new BenchAi(new FakeAi()), concurrency: 2, settings: { ai: "fake" }, log: (l: string) => lines.push(l) };
    const { summary, records } = await runBenchmark(DATASET, opts);
    expect(records).toHaveLength(4);
    expect(records.filter((r) => r.error)).toEqual([]);
    expect(summary).toMatchObject({ questions: 4, failed: 0, scored: 3 });
    for (const id of ["q1", "q2", "q3"]) {
      const r = records.find((x) => x.id === id)!;
      expect(r.metrics?.["recall_any@5"], id).toBe(1);
      expect(r.metrics?.delivered_any, id).toBe(1);
      expect(r.chunks).toBeGreaterThan(4);
    }
    // The evidence turn of q1 is found as a turn, not only as a session.
    expect(records.find((r) => r.id === "q1")!.metrics!["turn_recall@10"]).toBe(1);
    expect(records.find((r) => r.id === "q4_abs")!.metrics).toBeUndefined();
    expect(readFileSync(join(out, "summary.md"), "utf8")).toContain("Evidence session in the top 5");

    // Same settings: nothing to do. Other settings: refused unless forced.
    await runBenchmark(DATASET, opts);
    expect(lines.at(-1)).toMatch(/4 already done, 0 to run/);
    expect(readResults(join(out, "results.jsonl"))).toHaveLength(4);
    await expect(runBenchmark(DATASET, { ...opts, settings: { ai: "other" } })).rejects.toThrow(/other settings/);
    expect(summarize(readResults(join(out, "results.jsonl"))).scored).toBe(3);

    // Round chunks and every recall step, as deployed: the evidence turns are still found.
    const rounds = await runBenchmark(DATASET, { ...opts, out: join(dir, "rounds"), chunking: "rounds", features: ["all"] });
    expect(rounds.records.filter((r) => r.error)).toEqual([]);
    expect(rounds.records.find((r) => r.id === "q1")!.metrics!["turn_recall@10"]).toBe(1);
  }, 60_000);
});
