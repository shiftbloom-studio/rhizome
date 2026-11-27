// SPDX-License-Identifier: AGPL-3.0-or-later
// BEAM on the benchmark Worker (bench/beam.ts): BEAM's prompts and scores against its
// own code (test/fixtures/beam-official.json), the dataset import, run params, and a
// whole run of the Workflow on the Node stand-ins with a fake OpenAI.
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WorkflowStep, WorkflowStepConfig } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FakeAi } from "../bench/ai";
import {
  BEAM_UPSTREAM,
  SessionCutter,
  batchesOf,
  beamConversationKey,
  beamFileUrl,
  beamJudgePrompt,
  beamMetrics,
  beamQuestions,
  beamReaderPrompt,
  beamReaderRequest,
  equivalenceMessages,
  importConversation,
  kendallTauB,
  orderingScore,
  parseAnchor,
  parseJudgeReply,
  type BeamAnswer,
  type BeamSession,
} from "../bench/beam";
import { AiGate, BeamWorkflow, BenchMemory, beamSettings, type BeamOutput, type BeamParams, type BenchEnv } from "../bench/worker";
import { LocalBucket } from "../src/node/blobs";
import { LocalNamespace } from "../src/node/durable";
import { LocalVectorIndex } from "../src/node/vectors";

const fixture = JSON.parse(readFileSync("test/fixtures/beam-official.json", "utf8")) as {
  upstream: { commit: string };
  readerPrompt: string;
  judgePrompt: string;
  equivalence: { role: string; content: string }[];
  ordering: { reference: string[]; system: string[]; score: { precision: number; recall: number; f1: number; tau_norm: number | null; final_score: number | null } }[];
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rhizome-beam-"));
});
afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe("BEAM's own evaluation", () => {
  it("uses the prompts of BEAM's code at the pinned commit", () => {
    expect(BEAM_UPSTREAM.commit).toBe(fixture.upstream.commit);
    expect(beamReaderPrompt("CONTEXT TEXT", "QUESTION TEXT")).toBe(fixture.readerPrompt);
    expect(beamJudgePrompt("RUBRIC ITEM", "RESPONSE TEXT")).toBe(fixture.judgePrompt);
    expect(equivalenceMessages("First event", "Second event")).toEqual(fixture.equivalence);
    // As Python's str.replace: "$&" stays literal, and every placeholder is filled.
    expect(beamReaderPrompt("echo $& and $1", "Q")).toContain("CONTEXT:\necho $& and $1\n");
    expect(beamJudgePrompt("R", "see <rubric_item>")).toContain("RESPONSE TO EVALUATE: see <rubric_item>");
  });

  it("scores event ordering as event_ordering_score() with scipy's Kendall tau-b", () => {
    for (const c of fixture.ordering) {
      const s = orderingScore(c.reference, c.system);
      for (const key of ["precision", "recall", "f1"] as const) expect(s[key]).toBeCloseTo(c.score[key], 12);
      if (c.score.tau_norm === null) expect(s.tau_norm).toBeNull();
      else expect(s.tau_norm).toBeCloseTo(c.score.tau_norm, 12);
      if (c.score.final_score === null) expect(s.final_score).toBeNull();
      else expect(s.final_score).toBeCloseTo(c.score.final_score!, 12);
    }
    expect(kendallTauB([1, 2, 3], [3, 2, 1])).toBe(-1);
    expect(kendallTauB([1, 1, 1], [1, 2, 3])).toBeNaN();
  });

  it("reads the judge's reply as parse_json_response() does", () => {
    expect(parseJudgeReply('{"score": 1.0, "reason": "ok"}')).toEqual({ score: 1, reason: "ok" });
    expect(parseJudgeReply('```json\n{"score": 0.5, "reason": "partly"}\n```')).toEqual({ score: 0.5, reason: "partly" });
    expect(parseJudgeReply('Here: {"score": 0.0, "reason": "missing"} done')).toEqual({ score: 0, reason: "missing" });
    expect(parseJudgeReply("{'score': 1, 'reason': 'single quotes'}")).toEqual({ score: 1 });
    expect(() => parseJudgeReply("no idea")).toThrow(/no score/);
  });

  it("asks the reader as BEAM does, and a reasoning reader with room to think", () => {
    expect(beamReaderRequest("gpt-4o", "P")).toEqual({ model: "gpt-4o", messages: [{ role: "user", content: "P" }], n: 1, temperature: 0 });
    expect(beamReaderRequest("gpt-6.1-terra", "P", "medium")).toEqual({ model: "gpt-6.1-terra", messages: [{ role: "user", content: "P" }], n: 1, max_completion_tokens: 16_000, reasoning_effort: "medium" });
  });

  it("averages per conversation and ability, then over the conversations, as report_results.py does", () => {
    const a = (conversation: string, ability: BeamAnswer["ability"], score: number): BeamAnswer => ({
      id: `${conversation}-${ability}-${score}`,
      conversation,
      ability,
      question: "?",
      verdict: { score, llm_judge_score: score, items: [], calls: 1, promptTokens: 1, completionTokens: 1, model: "m" },
      evidence: 2,
      evidenceCovered: 1,
      contextTokens: 100,
    });
    const m = beamMetrics([a("c1", "abstention", 1), a("c1", "abstention", 0), a("c1", "abstention", 0), a("c2", "abstention", 1), a("c1", "summarization", 0.5), { id: "x", conversation: "c2", ability: "summarization", question: "?", error: "reader: boom" }]);
    // c1: 1/3, c2: 1 → 2/3; summarization only c1.
    expect(m.byAbility.abstention!.score).toBeCloseTo(2 / 3, 12);
    expect(m.byAbility.summarization).toEqual({ conversations: 1, questions: 1, score: 0.5 });
    expect(m.overall).toBeCloseTo((2 / 3 + 0.5) / 2, 12);
    expect(m).toMatchObject({ conversations: 2, questions: 6, judged: 5, failed: 1, evidenceCoverage: 0.5, evidenceAll: 0, contextTokens: 100 });
  });
});

// ------------------------------------------------------------------ dataset

const msg = (id: number, role: string, content: string, anchor?: string) => ({ role, id, content, ...(anchor ? { time_anchor: anchor, index: "1,1", question_type: "main_question" } : {}) });

/** A conversation as BEAM's chat.json has it: batches of turns, a time anchor on each batch's first message. */
const CHAT = [
  {
    batch_number: 1,
    time_anchor: null,
    turns: [
      [msg(0, "user", "I am building a budget tracker with Flask. ->-> 1,1", "March-15-2024"), msg(1, "assistant", "Great, let us start with user authentication.")],
      [msg(2, "user", "My first sprint ends on March 29, focusing on login. ->-> 1,2"), msg(3, "assistant", "Noted: the first sprint ends on March 29.")],
    ],
  },
  {
    batch_number: 2,
    time_anchor: null,
    turns: [
      [msg(4, "user", "Next I added transaction error handling to the tracker.", "April-05-2024"), msg(5, "assistant", "Error handling for transactions is in place.")],
      [msg(6, "user", "Finally I hardened security before deployment."), msg(7, "assistant", "Security hardening done.")],
    ],
  },
];

const QUESTIONS = {
  information_extraction: [
    { question: "When does my first sprint end?", answer: "March 29", difficulty: "easy", source_chat_ids: [2], rubric: ["LLM response should state: March 29"] },
  ],
  event_ordering: [
    { question: "In which order did I work on my tracker?", source_chat_ids: { first: [0], second: [4, 6] }, rubric: ["Authentication", "Transaction error handling", "Security hardening"] },
  ],
  abstention: [{ question: "Which bank did I connect?", ideal_response: "There is no information about a bank.", rubric: ["Based on the provided chat, there is no information related to a bank"] }],
};

/** BEAM's repository on raw.githubusercontent.com, in small pieces that split objects and characters. */
function github(files: Record<string, unknown>, size = 61) {
  return vi.fn(async (url: string) => {
    const found = Object.entries(files).find(([path]) => url === beamFileUrl("100K", 1, path) || url === beamFileUrl("10M", 1, path));
    if (!found) return new Response("Not Found", { status: 404 });
    const bytes = new TextEncoder().encode(JSON.stringify(found[1]));
    return new Response(
      new ReadableStream({
        start(c) {
          for (let i = 0; i < bytes.length; i += size) c.enqueue(bytes.slice(i, i + size));
          c.close();
        },
      }),
    );
  });
}

describe("BEAM dataset", () => {
  it("reads BEAM's time anchors", () => {
    expect(parseAnchor("March-15-2024")).toBe(Date.UTC(2024, 2, 15));
    expect(parseAnchor("Dec-01-2023")).toBe(Date.UTC(2023, 11, 1));
    expect(() => parseAnchor("February-30-2024")).toThrow(/time anchor/);
    expect(() => parseAnchor("2024-03-15")).toThrow(/time anchor/);
  });

  it("cuts batches into one session per turn, in order and at their dates", () => {
    const cutter = new SessionCutter();
    const first = cutter.cut(CHAT[0]!);
    const second = cutter.cut(CHAT[1]!);
    expect(first.map((s) => s.id)).toEqual(["t1", "t2"]);
    expect(second.map((s) => s.id)).toEqual(["t3", "t4"]);
    expect(first[0]!.time).toBe(Date.UTC(2024, 2, 15, 8));
    expect(first[1]!.time).toBe(Date.UTC(2024, 2, 15, 8, 5));
    expect(second[0]!.time).toBe(Date.UTC(2024, 3, 5, 8));
    expect(first[1]!.messages).toEqual([
      { id: 2, role: "user", content: "My first sprint ends on March 29, focusing on login. ->-> 1,2" },
      { id: 3, role: "assistant", content: "Noted: the first sprint ends on March 29." },
    ]);
    // A batch without an anchor follows the last by a day.
    const third = cutter.cut({ turns: [[msg(8, "user", "later")]] });
    expect(third[0]!.time).toBe(Date.UTC(2024, 3, 6, 8));
    expect(cutter.sessions).toBe(5);
    // Batches before the first anchor come out with it, a day apart before it.
    const late = new SessionCutter();
    expect(late.cut({ turns: [[msg(0, "user", "no date yet")]] })).toEqual([]);
    const both = late.cut(CHAT[1]!);
    expect(both.map((s) => [s.id, s.batch, s.time])).toEqual([
      ["t1", 1, Date.UTC(2024, 3, 4, 8)],
      ["t2", 2, Date.UTC(2024, 3, 5, 8)],
      ["t3", 2, Date.UTC(2024, 3, 5, 8, 5)],
    ]);
    const never = new SessionCutter();
    never.cut({ turns: [[msg(0, "user", "no date")]] });
    expect(() => never.end()).toThrow(/no batch of the conversation has a time anchor/);
    // 10M: items are plans of batches.
    expect(batchesOf({ "plan-1": CHAT })).toHaveLength(2);
    expect(() => batchesOf([1])).toThrow(/list of objects/);
  });

  it("lists the questions with their evidence messages", () => {
    const qs = beamQuestions("100K", 1, QUESTIONS);
    expect(qs.map((q) => q.id)).toEqual(["100K-1-information_extraction-0", "100K-1-event_ordering-0", "100K-1-abstention-0"]);
    expect(qs.map((q) => q.evidence)).toEqual([[2], [0, 4, 6], []]);
    expect(() => beamQuestions("100K", 1, { recall: [] })).toThrow(/unknown ability/);
    expect(() => beamQuestions("100K", 1, { abstention: [{ question: "?", rubric: [] }] })).toThrow(/rubric/);
  });

  it("copies a conversation into the bucket once, preferring the truncated chat BEAM answers from", async () => {
    const bucket = new LocalBucket(join(dir, "bucket")) as unknown as R2Bucket;
    const fetches = github({ "chat.json": [CHAT[0]], "chat_trunecated.json": CHAT, "probing_questions/probing_questions.json": QUESTIONS });
    const c = await importConversation(bucket, "100K", 1, fetches as unknown as typeof fetch);
    expect(c).toMatchObject({ id: "beam-100K-1", sessions: 4, messages: 8, source: beamFileUrl("100K", 1, "chat_trunecated.json") });
    expect(c.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(c.askedAt).toBe(Date.UTC(2024, 3, 6, 8, 5));
    expect(c.parts).toHaveLength(2);
    const part = (await (await bucket.get(c.parts[1]!))!.json()) as BeamSession[];
    expect(part.map((s) => s.id)).toEqual(["t3", "t4"]);
    expect(c.raw).toEqual(QUESTIONS);
    const again = await importConversation(bucket, "100K", 1, fetches as unknown as typeof fetch);
    expect(again).toEqual(c);
    expect(fetches).toHaveBeenCalledTimes(2);

    // 10M: a chat file of plans, and no truncated file.
    const ten = await importConversation(bucket, "10M", 1, github({ "chat.json": [{ "plan-1": CHAT }], "probing_questions/probing_questions.json": QUESTIONS }) as unknown as typeof fetch);
    expect(ten).toMatchObject({ sessions: 4, source: beamFileUrl("10M", 1, "chat.json") });
    expect(ten.parts).toHaveLength(1);
    await expect(importConversation(bucket, "500K", 3, github({}) as unknown as typeof fetch)).rejects.toThrow(/HTTP 404/);
  });
});

describe("BEAM run params", () => {
  it("default to all conversations of 100K, BEAM's judge and the deployed recall", () => {
    const s = beamSettings({}, { RECALL_FEATURES: "all" });
    expect(s).toMatchObject({ tier: "100K", abilities: null, judge: "gpt-4.1-mini" });
    expect(s.conversations).toHaveLength(20);
    expect(s.common).toMatchObject({ concurrency: 4, embeddingCache: true, aiCache: true, reader: null, features: null });
    expect(beamSettings({ tier: "1M" }, {}).common.embeddingCache).toBe(false);
    const picked = beamSettings(JSON.stringify({ conversations: "3,1", abilities: ["summarization"], reader: "gpt-6.1-terra", extraction: true, reflect: true }), {});
    expect(picked).toMatchObject({ conversations: [3, 1], abilities: ["summarization"], common: { reader: "gpt-6.1-terra", readerEffort: "medium", extraction: true, concurrency: 2 } });
    expect(beamSettings({ limit: 1 }, {}).conversations).toEqual([1]);
  });

  it("refuse typos and LongMemEval's selection", () => {
    expect(() => beamSettings({ tier: "2M" }, {})).toThrow(/tier/);
    expect(() => beamSettings({ conversations: [21] }, {})).toThrow(/1 to 20/);
    expect(() => beamSettings({ abilities: "recall" }, {})).toThrow(/unknown ability/);
    expect(() => beamSettings({ sample: 10 }, {})).toThrow(/LongMemEval param/);
    expect(() => beamSettings({ reflekt: true }, {})).toThrow(/unknown param/);
    expect(() => beamSettings({ judge: "a b" }, {})).toThrow(/judge/);
  });
});

// ------------------------------------------------------------------ workflow

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

const event = (instanceId: string, payload: BeamParams) => ({ instanceId, payload, timestamp: new Date(), workflowName: "rhizome-bench-beam" });

async function text(env: BenchEnv, key: string): Promise<string> {
  const object = await env.BENCH.get(key);
  if (!object) throw new Error(`missing ${key}`);
  return object.text();
}

describe("BEAM Workflow", () => {
  it("ingests a conversation once, asks its questions, has the reader answer and BEAM's judge score them", async () => {
    const repo = github({ "chat.json": CHAT, "probing_questions/probing_questions.json": QUESTIONS });
    const calls: { model: string; messages: { role: string; content: string }[]; body: Record<string, unknown> }[] = [];
    const reply = (content: string, model: string) =>
      new Response(JSON.stringify({ model, choices: [{ message: { content }, finish_reason: "stop" }], usage: { prompt_tokens: 50, completion_tokens: 5 } }), { status: 200 });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (!String(url).startsWith("https://openai.test/v1/")) return repo(url);
        const body = JSON.parse(String(init!.body)) as { model: string; messages: { role: string; content: string }[] };
        calls.push({ model: body.model, messages: body.messages, body });
        const content = body.messages.at(-1)!.content;
        if (body.model === "gpt-6.1-terra") {
          if (content.includes("QUESTION:\nWhen does my first sprint end?")) return reply(" March 29\n", "gpt-6.1-terra-2026");
          if (content.includes("QUESTION:\nIn which order")) return reply("Authentication\nSecurity hardening\nTransaction error handling", "gpt-6.1-terra-2026");
          return reply("There is no information about a bank.", "gpt-6.1-terra-2026");
        }
        if (body.messages[0]!.role === "system") {
          const [first, second] = [content.split("First snippet: ")[1]!.split(" \n")[0]!, content.split("Second snippet: ")[1]!.trim()];
          return reply(first === second ? "YES" : "NO", "gpt-4.1-mini-2025");
        }
        return reply('{"score": 1.0, "reason": "fine"}', "gpt-4.1-mini-2025");
      }),
    );
    const { env, close } = benchEnv(dir);
    Object.assign(env, { OPENAI_API_KEY: "test-key", OPENAI_BASE_URL: "https://openai.test/v1" });
    try {
      const workflow = new BeamWorkflow({} as ExecutionContext, env);
      const run = fakeStep();
      const out = (await workflow.run(event("beam-smoke", { conversations: [1], reader: "gpt-6.1-terra" }), run.step)) as BeamOutput;
      expect(out).toMatchObject({ tier: "100K", conversations: 1, failed: 0 });
      expect(run.ran.slice(0, 3)).toEqual(["dataset 100K/1", "config", "conversation beam-100K-1"]);
      const byName = (x: string, y: string) => x.localeCompare(y);
      expect(run.ran.slice(3, -1).sort(byName)).toEqual(["information_extraction-0", "event_ordering-0", "abstention-0"].flatMap((q) => [`answer 100K-1-${q}`, `judge 100K-1-${q}`]).sort(byName));
      expect(run.ran.at(-1)).toBe("summary");
      expect(out.metrics).toMatchObject({ questions: 3, judged: 3, failed: 0 });
      expect(out.metrics.byAbility.information_extraction!.score).toBe(1);
      expect(out.metrics.byAbility.abstention!.score).toBe(1);
      // Rubric order A, T, S against the answer's A, S, T: one swapped pair of three.
      expect(out.metrics.byAbility.event_ordering!.score).toBeCloseTo(orderingScore(["A", "T", "S"], ["A", "S", "T"]).tau_norm!, 12);

      // The reader got BEAM's prompt with the recall tool's text.
      const read = calls.find((c) => c.model === "gpt-6.1-terra" && c.messages[0]!.content.includes("QUESTION:\nWhen does my first sprint end?"))!;
      expect(read.body).toMatchObject({ n: 1, reasoning_effort: "medium", max_completion_tokens: 16_000 });
      const contexts = JSON.parse(await text(env, "runs/beam-smoke/contexts/beam-100K-1.json")) as Record<string, string>;
      expect(read.messages[0]!.content).toBe(beamReaderPrompt(contexts["100K-1-information_extraction-0"]!, "When does my first sprint end?"));
      expect(contexts["100K-1-information_extraction-0"]).toContain("March 29");
      // The judge got BEAM's rubric prompt for the trimmed answer, at temperature 0.
      const judged = calls.filter((c) => c.model === "gpt-4.1-mini" && c.messages[0]!.role === "user");
      expect(judged.map((c) => c.messages[0]!.content)).toContain(beamJudgePrompt("LLM response should state: March 29", "March 29"));
      expect(judged.every((c) => c.body.temperature === 0)).toBe(true);
      expect(calls.filter((c) => c.messages[0]!.role === "system")[0]!.messages).toEqual(equivalenceMessages("Authentication", "Authentication"));

      const answers = (await text(env, "runs/beam-smoke/answers.jsonl")).trim().split("\n").map((l) => JSON.parse(l) as BeamAnswer);
      const ie = answers.find((a) => a.ability === "information_extraction")!;
      expect(ie).toMatchObject({ hypothesis: "March 29", readerModel: "gpt-6.1-terra-2026", evidence: 1 });
      expect(ie.evidenceCovered).toBe(1);
      expect(answers.find((a) => a.ability === "abstention")!.evidence).toBe(0);
      expect(await text(env, "runs/beam-smoke/beam.md")).toContain("Overall (mean of abilities)");
      const config = JSON.parse(await text(env, "runs/beam-smoke/config.json"));
      expect(config).toMatchObject({ benchmark: "beam", tier: "100K", reader: "gpt-6.1-terra", judge: "gpt-4.1-mini", upstream: { commit: BEAM_UPSTREAM.commit } });
      // BEAM's own files, as its scripts write and read them.
      const upstream = JSON.parse(await text(env, "runs/beam-smoke/upstream/100K/1/rhizome.json"));
      expect(upstream.information_extraction[0]).toEqual({ ...QUESTIONS.information_extraction[0], llm_response: "March 29" });
      const evaluation = JSON.parse(await text(env, "runs/beam-smoke/upstream/100K/1/evaluation-results-rhizome.json"));
      expect(evaluation.event_ordering[0]).toMatchObject({ tau_norm: expect.any(Number), llm_judge_score: 1 });

      // The conversation is stored once, and nothing of the memory is left.
      expect(await env.BENCH.get(beamConversationKey("100K", 1))).not.toBeNull();
      const db = new DatabaseSync(join(dir, "vectors.sqlite"));
      expect(db.prepare("SELECT COUNT(*) AS n FROM vectors").get()).toEqual({ n: 0 });
      db.close();
      const episodes = readdirSync(join(dir, "bucket", "users"), { recursive: true, withFileTypes: true }).filter((e) => e.isFile());
      expect(episodes).toEqual([]);

      // A replay takes every finished step from its results.
      expect(await workflow.run(event("beam-smoke", { conversations: [1], reader: "gpt-6.1-terra" }), run.step)).toEqual(out);
    } finally {
      close();
    }
  }, 60_000);

  it("runs retrieval only without a reader, and records a conversation that failed", async () => {
    vi.stubGlobal("fetch", github({ "chat.json": CHAT, "probing_questions/probing_questions.json": QUESTIONS }));
    const { env, close } = benchEnv(dir);
    try {
      const workflow = new BeamWorkflow({} as ExecutionContext, env);
      await expect(workflow.run(event("no-key", { reader: "gpt-4o" }), fakeStep().step)).rejects.toThrow(/OPENAI_API_KEY/);
      const run = fakeStep();
      const out = (await workflow.run(event("retrieval", { conversations: [1], abilities: "information_extraction" }), run.step)) as BeamOutput;
      expect(run.ran.some((n) => n.startsWith("answer"))).toBe(false);
      expect(out.metrics).toMatchObject({ questions: 1, judged: 0, evidenceCoverage: 1 });
      expect(out.markdown).toContain("Retrieval only");

      // Its sessions gone, the conversation fails, and its questions say why.
      await env.BENCH.delete(JSON.parse(await text(env, beamConversationKey("100K", 1))).parts[0]);
      const broken = (await workflow.run(event("broken", { conversations: [1] }), fakeStep().step)) as BeamOutput;
      expect(broken.failed).toBe(1);
      const answers = (await text(env, "runs/broken/answers.jsonl")).trim().split("\n").map((l) => JSON.parse(l) as BeamAnswer);
      expect(answers.every((a) => /^no recall: .*no sessions at/.test(a.error!))).toBe(true);
    } finally {
      close();
    }
  }, 60_000);
});
