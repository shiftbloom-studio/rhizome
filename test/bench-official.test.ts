// SPDX-License-Identifier: AGPL-3.0-or-later
// LongMemEval's own evaluation (bench/official.ts) held to LongMemEval's own code:
// the prompts, files and scores in test/fixtures/longmemeval-official.json come
// from the upstream scripts (bench/official-fixture.py). The OpenAI calls run
// against a fake endpoint.
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import type { Question } from "../bench/longmemeval";
import {
  JUDGE_MODEL,
  OpenAiError,
  UPSTREAM,
  chatCompletion,
  evalResultLine,
  hypothesisLine,
  judgePrompt,
  judgeRequest,
  judgedCorrect,
  officialMarkdown,
  officialRetrieval,
  pyJson,
  pyRound4,
  qaMetrics,
  qaMetricsPrintout,
  readerPrompt,
  readerRequest,
} from "../bench/official";

interface Fixture {
  upstream: { repo: string; commit: string };
  judge: { task: string; question: string; answer: string | number; response: string; abstention: boolean; prompt: string }[];
  reader: { history: string; date: string; question: string; prompt: string }[];
  files: { question_id: string; hypothesis: string; label: boolean; hypothesis_line: string; eval_line: string }[];
  qa: { judged: { id: string; type: string; label: boolean }[]; printout: string };
  retrieval: { question: Pick<Question, "question_id" | "haystack_session_ids" | "haystack_sessions">; order: string[]; counted: boolean; scores: Record<string, number> | null }[];
}

const fixture = JSON.parse(readFileSync("test/fixtures/longmemeval-official.json", "utf8")) as Fixture;

describe("LongMemEval's own evaluation", () => {
  it("is pinned to the commit the fixture was written from", () => {
    expect(fixture.upstream.commit).toBe(UPSTREAM.commit);
    expect(fixture.judge.map((c) => c.task)).toEqual(expect.arrayContaining(["single-session-user", "single-session-assistant", "multi-session", "temporal-reasoning", "knowledge-update", "single-session-preference"]));
  });

  it("asks the judge exactly as evaluate_qa.py does", () => {
    for (const c of fixture.judge) expect(judgePrompt(c.task, c.question, c.answer, c.response, c.abstention)).toBe(c.prompt);
    expect(() => judgePrompt("open-domain", "q", "a", "r", false)).toThrow(/no answer check/);
    expect(() => judgePrompt("multi-session", "q", 2.5, "r", false)).toThrow(/whole numbers/);
    expect(judgeRequest("p")).toEqual({ model: "gpt-4o-2024-08-06", messages: [{ role: "user", content: "p" }], n: 1, temperature: 0, max_tokens: 10 });
  });

  it("prompts the reader exactly as run_generation.py does", () => {
    for (const c of fixture.reader) expect(readerPrompt(c.history, c.date, c.question)).toBe(c.prompt);
    expect(readerRequest("gpt-4o-2024-08-06", "p")).toEqual({ model: "gpt-4o-2024-08-06", messages: [{ role: "user", content: "p" }], n: 1, temperature: 0, max_tokens: 800 });
  });

  it("counts a reply as correct when it has yes in it, as evaluate_qa.py does", () => {
    expect(judgedCorrect(" Yes.")).toBe(true);
    expect(judgedCorrect("YES")).toBe(true);
    expect(judgedCorrect("No")).toBe(false);
    expect(judgedCorrect("")).toBe(false);
  });

  it("writes the scripts' files byte for byte", () => {
    for (const c of fixture.files) {
      expect(hypothesisLine(c.question_id, c.hypothesis)).toBe(c.hypothesis_line);
      expect(evalResultLine(c.question_id, c.hypothesis, c.label)).toBe(c.eval_line);
    }
    expect(pyJson({ a: [1, true, null], b: undefined })).toBe('{"a": [1, true, null]}');
    expect(() => pyJson(0.5)).toThrow(/whole numbers/);
  });

  it("averages as print_qa_metrics.py and prints what it prints", () => {
    const m = qaMetrics(fixture.qa.judged);
    expect(qaMetricsPrintout(m) + "\n").toBe(fixture.qa.printout);
    expect(m.questions).toBe(fixture.qa.judged.length);
    expect(() => qaMetrics([{ id: "x", type: "open-domain", label: true }])).toThrow(/no question type/);
    // A type without questions makes the task average nan, as numpy does.
    expect(Number.isNaN(qaMetrics([{ id: "x", type: "multi-session", label: true }]).taskAveraged)).toBe(true);
  });

  it("rounds as numpy rounds", () => {
    // Values from round(np.float64(x), 4) in numpy 2.5.
    const cases: [number, string][] = [
      [1, "1.0"],
      [0, "0.0"],
      [0.03125, "0.0312"],
      [0.00015, "0.0001"],
      [0.12345, "0.1234"],
      [2 / 3, "0.6667"],
      [5 / 7, "0.7143"],
      [0.99995, "1.0"],
      [0.00005, "0.0"],
      [0.015625, "0.0156"],
      [Number.NaN, "nan"],
    ];
    for (const [x, printed] of cases) expect(pyRound4(x)).toBe(printed);
  });

  it("scores retrieval as run_retrieval.py does and leaves out the questions it leaves out", () => {
    for (const c of fixture.retrieval) {
      const got = officialRetrieval(c.question, c.order);
      if (!c.counted) {
        expect(got).toBeUndefined();
        continue;
      }
      expect(Object.keys(got!).sort()).toEqual(Object.keys(c.scores!).sort());
      for (const [k, v] of Object.entries(c.scores!)) expect(got![k]).toBeCloseTo(v, 12);
    }
  });

  it("reports the scores and what they rest on", () => {
    const m = qaMetrics(fixture.qa.judged);
    const md = officialMarkdown({
      runId: "smoke",
      reader: "gpt-4o-2024-08-06",
      dataset: "d6f21ea9d60a0d56f34a05b609c79c88a451d2ae03597821ea3d5a9678c3a442",
      records: [
        { id: "a", type: "multi-session", abstention: false, hypothesis: "h", label: true, readerModel: "gpt-4o-2024-08-06", judgeModel: JUDGE_MODEL, readerFinish: "length", readerTokens: { prompt: 10, completion: 5 }, judgeTokens: { prompt: 7, completion: 1 } },
        { id: "b", type: "multi-session", abstention: false, error: "reader: OpenAI answered HTTP 400" },
      ],
      metrics: m,
      retrieval: { questions: 2, scores: { "recall_all@5": 0.5 } },
    });
    expect(md).toContain("**1 failed**");
    expect(md).toContain(`| **Overall accuracy** | **${(100 * m.overall).toFixed(1)}** |`);
    expect(md).toContain(fixture.qa.printout.trim());
    expect(md).toContain("stopped at its token limit on 1 questions");
    expect(md).toContain("- b: reader: OpenAI answered HTTP 400");
    expect(md).toContain("| 50.0 |");
  });
});

describe("OpenAI calls", () => {
  const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
  const ok = { model: "gpt-4o-2024-08-06", choices: [{ message: { content: " Yes" }, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 1 } };

  it("sends the request as it is and reads the reply", async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => reply(ok));
    const out = await chatCompletion(judgeRequest("p"), { apiKey: "sk-test", baseUrl: "https://example.test/v1/", fetch: fetch as unknown as typeof globalThis.fetch });
    expect(out).toEqual({ content: " Yes", model: "gpt-4o-2024-08-06", finishReason: "stop", promptTokens: 12, completionTokens: 1 });
    const [url, init] = fetch.mock.calls[0]!;
    expect(url).toBe("https://example.test/v1/chat/completions");
    expect(JSON.parse(String(init.body))).toEqual(judgeRequest("p"));
    expect((init.headers as Record<string, string>).authorization).toBe("Bearer sk-test");
  });

  it("waits as long as a rate limit asks, and tries again", async () => {
    const answers = [reply({ error: { code: "rate_limit_exceeded", message: "slow down" } }, 429, { "retry-after-ms": "1500" }), reply({}, 503), reply(ok)];
    const fetch = vi.fn(async () => answers.shift()!);
    const sleep = vi.fn(async () => {});
    const out = await chatCompletion(judgeRequest("p"), { apiKey: "k", fetch: fetch as unknown as typeof globalThis.fetch, sleep });
    expect(out.content).toBe(" Yes");
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => (c as unknown[])[0])).toEqual([1500, 4000]);
  });

  it("does not try again when the balance is empty or the request is wrong, and never shows the key", async () => {
    for (const [status, body] of [
      [429, { error: { code: "insufficient_quota", message: "You exceeded your current quota" } }],
      [400, { error: { code: "invalid_request_error", message: "bad model" } }],
      [401, { error: { code: "invalid_api_key", message: "Incorrect API key provided" } }],
    ] as const) {
      const fetch = vi.fn(async () => reply(body, status));
      const err = (await chatCompletion(judgeRequest("p"), { apiKey: "test-key-123", fetch: fetch as unknown as typeof globalThis.fetch, sleep: async () => {} }).catch((e: unknown) => e)) as OpenAiError;
      expect(err).toBeInstanceOf(OpenAiError);
      expect(err.retryable).toBe(false);
      expect(err.message).toContain(`HTTP ${status}`);
      expect(err.message).not.toContain("test-key-123");
      expect(fetch).toHaveBeenCalledTimes(1);
    }
  });

  it("gives up after its tries when OpenAI stays unreachable", async () => {
    const fetch = vi.fn(async () => {
      throw new TypeError("network down");
    });
    const err = (await chatCompletion(judgeRequest("p"), { apiKey: "k", tries: 3, fetch: fetch as unknown as typeof globalThis.fetch, sleep: async () => {} }).catch((e: unknown) => e)) as OpenAiError;
    expect(err.retryable).toBe(true);
    expect(err.message).toMatch(/could not be reached/);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
