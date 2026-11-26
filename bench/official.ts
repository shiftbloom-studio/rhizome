// SPDX-License-Identifier: AGPL-3.0-or-later
//
// LongMemEval's own evaluation, as its repository runs it
// (https://github.com/xiaowu0162/LongMemEval at UPSTREAM.commit, MIT licence):
// - the reader prompt of src/generation/run_generation.py with its default
//   reading method ("con": one call, step by step, at most 800 tokens, temperature 0),
// - the answer check of src/evaluation/evaluate_qa.py: GPT-4o (gpt-4o-2024-08-06)
//   with the prompt for the question's type, temperature 0, at most 10 tokens; a
//   reply with "yes" anywhere in it counts as correct,
// - the averages of src/evaluation/print_qa_metrics.py,
// - the session-level retrieval scores of src/retrieval/run_retrieval.py and eval_utils.py,
// - the files those scripts write, byte for byte (Python's json.dumps).
// The prompts are copied character for character; test/bench-official.test.ts checks
// them against what the upstream code produces (test/fixtures/longmemeval-official.json,
// written by bench/official-fixture.py).

import type { Question } from "./longmemeval";

export const UPSTREAM = { repo: "https://github.com/xiaowu0162/LongMemEval", commit: "9e0b455f4ef0e2ab8f2e582289761153549043fc" } as const;

/** The judge of evaluate_qa.py ("gpt-4o" in its model_zoo). print_qa_metrics.py accepts no other. */
export const JUDGE_MODEL = "gpt-4o-2024-08-06";
/** The suffix evaluate_qa.py gives its results file: `${hyp_file}.eval-results-${metric_model_short}`. */
export const EVAL_RESULTS_SUFFIX = ".eval-results-gpt-4o";
/** run_generation.py: 500 tokens to answer, 800 when it answers step by step. */
export const READER_MAX_TOKENS = 800;

// ------------------------------------------------------------------ prompts

/** run_generation.py, prepare_prompt(): cot true, no fact expansion. */
export function readerPrompt(history: string, questionDate: string, question: string): string {
  return (
    "I will give you several history chats between you and a user. Please answer the question based on the relevant chat history. " +
    "Answer the question step by step: first extract all the relevant information, and then reason over the information to get the answer." +
    `\n\n\nHistory Chats:\n\n${history}\n\nCurrent Date: ${questionDate}\nQuestion: ${question}\nAnswer (step by step):`
  );
}

/** How Python's str.format writes the dataset's answers: strings as they are, whole numbers in decimal. */
function pyFormat(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  throw new Error(`answer ${JSON.stringify(value)}: only strings and whole numbers are written as Python writes them`);
}

const CHECK = "I will give you a question, a correct answer, and a response from a model. Please answer yes if the response contains the correct answer. Otherwise, answer no.";
const STEPS = " If the response is equivalent to the correct answer or contains all the intermediate steps to get the correct answer, you should also answer yes. If the response only contains a subset of the information required by the answer, answer no.";
const ENDING = "\n\nIs the model response correct? Answer yes or no only.";

/** evaluate_qa.py, get_anscheck_prompt(). */
export function judgePrompt(task: string, question: string, answer: unknown, response: string, abstention: boolean): string {
  const a = pyFormat(answer);
  if (abstention) {
    return (
      "I will give you an unanswerable question, an explanation, and a response from a model. Please answer yes if the model correctly identifies the question as unanswerable. " +
      "The model could say that the information is incomplete, or some other information is given but the asked information is not." +
      `\n\nQuestion: ${question}\n\nExplanation: ${a}\n\nModel Response: ${response}\n\nDoes the model correctly identify the question as unanswerable? Answer yes or no only.`
    );
  }
  switch (task) {
    case "single-session-user":
    case "single-session-assistant":
    case "multi-session":
      return `${CHECK}${STEPS} \n\nQuestion: ${question}\n\nCorrect Answer: ${a}\n\nModel Response: ${response}${ENDING}`;
    case "temporal-reasoning":
      return (
        `${CHECK}${STEPS} In addition, do not penalize off-by-one errors for the number of days. If the question asks for the number of days/weeks/months, etc., ` +
        `and the model makes off-by-one errors (e.g., predicting 19 days when the answer is 18), the model's response is still correct. ` +
        `\n\nQuestion: ${question}\n\nCorrect Answer: ${a}\n\nModel Response: ${response}${ENDING}`
      );
    case "knowledge-update":
      return (
        `${CHECK} If the response contains some previous information along with an updated answer, the response should be considered as correct as long as the updated answer is the required answer.` +
        `\n\nQuestion: ${question}\n\nCorrect Answer: ${a}\n\nModel Response: ${response}${ENDING}`
      );
    case "single-session-preference":
      return (
        "I will give you a question, a rubric for desired personalized response, and a response from a model. Please answer yes if the response satisfies the desired response. Otherwise, answer no. " +
        "The model does not need to reflect all the points in the rubric. The response is correct as long as it recalls and utilizes the user's personal information correctly." +
        `\n\nQuestion: ${question}\n\nRubric: ${a}\n\nModel Response: ${response}${ENDING}`
      );
    default:
      throw new Error(`LongMemEval has no answer check for the question type ${task}`);
  }
}

/** evaluate_qa.py: `'_abs' in entry['question_id']`. */
export const isAbstentionId = (questionId: string) => questionId.includes("_abs");

/** evaluate_qa.py: `'yes' in completion.choices[0].message.content.strip().lower()`. */
export const judgedCorrect = (reply: string) => reply.trim().toLowerCase().includes("yes");

// ----------------------------------------------------------------- requests

export interface ChatRequest {
  model: string;
  messages: { role: "user"; content: string }[];
  n: 1;
  temperature: 0;
  max_tokens: number;
}

/** The reader call of run_generation.py. */
export function readerRequest(model: string, prompt: string): ChatRequest {
  return { model, messages: [{ role: "user", content: prompt }], n: 1, temperature: 0, max_tokens: READER_MAX_TOKENS };
}

/** The judge call of evaluate_qa.py. */
export function judgeRequest(prompt: string): ChatRequest {
  return { model: JUDGE_MODEL, messages: [{ role: "user", content: prompt }], n: 1, temperature: 0, max_tokens: 10 };
}

export interface ChatReply {
  content: string;
  /** The model OpenAI says answered, e.g. gpt-4o-2024-08-06. */
  model: string;
  finishReason: string | null;
  promptTokens: number;
  completionTokens: number;
}

export class OpenAiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Worth another try later: rate limits, timeouts and server errors. An empty balance is not. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "OpenAiError";
  }
}

export interface OpenAiOptions {
  apiKey: string;
  /** Default https://api.openai.com/v1, as the openai package uses it. */
  baseUrl?: string;
  /** Tries in all, on rate limits, timeouts and server errors. */
  tries?: number;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** OpenAI's own messages quote part of a wrong key ("sk-proj-ab***yz"): no part of a key goes into an error. */
function redact(message: string, apiKey: string): string {
  const out = apiKey ? message.split(apiKey).join("[key]") : message;
  return out.replace(/\bsk-[A-Za-z0-9_*.-]+/g, "[key]");
}

/** How long OpenAI asks to wait (retry-after-ms, retry-after), else doubling from 2 s; at most a minute. */
function waitMs(headers: Headers, attempt: number): number {
  const ms = Number(headers.get("retry-after-ms"));
  if (Number.isFinite(ms) && ms > 0) return Math.min(60_000, ms);
  const s = Number(headers.get("retry-after"));
  if (Number.isFinite(s) && s > 0) return Math.min(60_000, s * 1000);
  return Math.min(60_000, 2_000 * 2 ** (attempt - 1));
}

/** One chat completion, with further tries where they can help. The key never appears in an error. */
export async function chatCompletion(request: ChatRequest, opts: OpenAiOptions): Promise<ChatReply> {
  const url = `${(opts.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "")}/chat/completions`;
  const tries = opts.tries ?? 8;
  const call = opts.fetch ?? fetch;
  const sleep = opts.sleep ?? pause;
  for (let attempt = 1; ; attempt++) {
    let res: Response;
    try {
      res = await call(url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${opts.apiKey}` },
        body: JSON.stringify(request),
      });
    } catch (err) {
      if (attempt >= tries) throw new OpenAiError(redact(`OpenAI could not be reached: ${String((err as Error)?.message ?? err)}`, opts.apiKey), 0, true);
      await sleep(Math.min(60_000, 2_000 * 2 ** (attempt - 1)));
      continue;
    }
    if (res.ok) {
      const body = (await res.json()) as {
        model?: string;
        choices?: { message?: { content?: string | null }; finish_reason?: string | null }[];
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      const choice = body.choices?.[0];
      const content = choice?.message?.content;
      if (typeof content !== "string") throw new OpenAiError(`OpenAI returned no text (finish_reason ${choice?.finish_reason ?? "none"})`, res.status, false);
      return {
        content,
        model: String(body.model ?? ""),
        finishReason: choice?.finish_reason ?? null,
        promptTokens: body.usage?.prompt_tokens ?? 0,
        completionTokens: body.usage?.completion_tokens ?? 0,
      };
    }
    const text = await res.text();
    let code = "";
    let message = text.slice(0, 300);
    try {
      const e = (JSON.parse(text) as { error?: { code?: string | null; type?: string; message?: string } }).error;
      code = e?.code || e?.type || "";
      message = e?.message ?? message;
    } catch {
      // not JSON: keep the start of the text
    }
    const retryable = (res.status === 429 && code !== "insufficient_quota") || res.status === 408 || res.status === 409 || res.status >= 500;
    if (!retryable || attempt >= tries) throw new OpenAiError(redact(`OpenAI answered HTTP ${res.status}${code ? ` (${code})` : ""}: ${message}`, opts.apiKey), res.status, retryable);
    await sleep(waitMs(res.headers, attempt));
  }
}

// -------------------------------------------------------------------- files

function pyString(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (c >= 0x20 && c <= 0x7e) out += ch;
    else if (c <= 0xffff) out += `\\u${c.toString(16).padStart(4, "0")}`;
    else {
      const v = c - 0x10000;
      out += `\\u${(0xd800 | (v >> 10)).toString(16)}\\u${(0xdc00 | (v & 0x3ff)).toString(16)}`;
    }
  }
  return out + '"';
}

/** JSON as Python's json.dumps writes it by default: ", " and ": " between items, all but printable ASCII escaped. */
export function pyJson(value: unknown): string {
  if (value === null) return "null";
  if (value === true) return "true";
  if (value === false) return "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error(`pyJson writes whole numbers only, not ${value}`);
    return String(value);
  }
  if (typeof value === "string") return pyString(value);
  if (Array.isArray(value)) return `[${value.map(pyJson).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    return `{${entries.map(([k, v]) => `${pyString(k)}: ${pyJson(v)}`).join(", ")}}`;
  }
  throw new Error(`pyJson cannot write a ${typeof value}`);
}

/** A line of the reader's output file, as run_generation.py writes it. evaluate_qa.py reads these. */
export const hypothesisLine = (questionId: string, hypothesis: string) => pyJson({ question_id: questionId, hypothesis });

/** A line of evaluate_qa.py's results file. print_qa_metrics.py reads these. */
export const evalResultLine = (questionId: string, hypothesis: string, label: boolean) =>
  pyJson({ question_id: questionId, hypothesis, autoeval_label: { model: JUDGE_MODEL, label } });

// ------------------------------------------------------------------ metrics

/** The question types in print_qa_metrics.py's order. */
export const QA_TYPES = ["single-session-user", "single-session-preference", "single-session-assistant", "multi-session", "temporal-reasoning", "knowledge-update"] as const;

export interface QaMetrics {
  /** Every judged question in its type, abstention questions too, as print_qa_metrics.py counts them. */
  byType: Record<string, { n: number; accuracy: number }>;
  /** The mean of the six per-type accuracies; NaN when a type has no question (numpy gives nan too). */
  taskAveraged: number;
  overall: number;
  abstention: { n: number; accuracy: number };
  questions: number;
}

const average = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : Number.NaN);

/** print_qa_metrics.py over judged questions. */
export function qaMetrics(judged: { id: string; type: string; label: boolean }[]): QaMetrics {
  const byType: QaMetrics["byType"] = {};
  const all: number[] = [];
  for (const type of QA_TYPES) {
    const v = judged.filter((j) => j.type === type).map((j) => (j.label ? 1 : 0));
    byType[type] = { n: v.length, accuracy: average(v) };
    all.push(...v);
  }
  const unknown = judged.find((j) => !(QA_TYPES as readonly string[]).includes(j.type));
  if (unknown) throw new Error(`print_qa_metrics.py knows no question type ${unknown.type}`);
  const abs = judged.filter((j) => isAbstentionId(j.id)).map((j) => (j.label ? 1 : 0));
  return {
    byType,
    taskAveraged: average(QA_TYPES.map((t) => byType[t]!.accuracy)),
    overall: average(all),
    abstention: { n: abs.length, accuracy: average(abs) },
    questions: judged.length,
  };
}

export const OFFICIAL_KS = [1, 3, 5, 10, 30, 50] as const;

/** eval_utils.py, dcg(): ranks 1 and 2 weigh 1, then 1/log2(rank). */
function dcg(relevances: number[], k: number): number {
  return relevances.slice(0, k).reduce((sum, r, i) => sum + (i === 0 ? r : r / Math.log2(i + 1)), 0);
}

/**
 * Session-level scores as run_retrieval.py computes them: the corpus is every session
 * of the history (an id twice is two entries); a session counts as evidence when its
 * id has "answer" in it and one of its user turns has_answer (others become "noans_").
 * rhizome ranks only what it recalls, so the remaining sessions follow in history
 * order, giving the full ranking the upstream retrievers produce. Undefined for
 * questions run_retrieval.py leaves out of its averages: abstention questions and
 * those without an evidence turn on the user side.
 */
export function officialRetrieval(q: Pick<Question, "question_id" | "haystack_session_ids" | "haystack_sessions">, order: string[]): Record<string, number> | undefined {
  if (isAbstentionId(q.question_id)) return undefined;
  const userTurns = (n: number) => q.haystack_sessions[n]!.filter((t) => t.role === "user");
  if (!q.haystack_sessions.some((_, n) => userTurns(n).some((t) => t.has_answer === true))) return undefined;
  const corpus = q.haystack_session_ids.map((id, n) => (id.includes("answer") && userTurns(n).every((t) => !t.has_answer) ? id.replaceAll("answer", "noans") : id));
  const correct = new Set(corpus.filter((id) => id.includes("answer")));
  const ranking: number[] = [];
  const placed = new Set<number>();
  for (const session of order) {
    q.haystack_session_ids.forEach((id, n) => {
      if (id === session && !placed.has(n)) {
        placed.add(n);
        ranking.push(n);
      }
    });
  }
  q.haystack_session_ids.forEach((_, n) => {
    if (!placed.has(n)) ranking.push(n);
  });
  const relevance = corpus.map((id) => (correct.has(id) ? 1 : 0));
  const ideal = [...relevance].sort((a, b) => b - a);
  const out: Record<string, number> = {};
  for (const k of OFFICIAL_KS) {
    const recalled = new Set(ranking.slice(0, k).map((n) => corpus[n]!));
    const best = dcg(ideal, k);
    out[`recall_any@${k}`] = [...correct].some((d) => recalled.has(d)) ? 1 : 0;
    out[`recall_all@${k}`] = [...correct].every((d) => recalled.has(d)) ? 1 : 0;
    out[`ndcg_any@${k}`] = best === 0 ? 0 : dcg(ranking.map((n) => relevance[n]!), k) / best;
  }
  return out;
}

// ------------------------------------------------------------------ reports

/** One question of an official evaluation: the reader's answer and the judge's verdict (qa.jsonl). */
export interface QaRecord {
  id: string;
  type: string;
  abstention: boolean;
  /** What the reader got: items and estimated tokens of the recall tool's text. */
  contextItems?: number;
  contextTokens?: number;
  hypothesis?: string;
  /** The judge's verdict: true when its reply has "yes" in it. */
  label?: boolean;
  judgeReply?: string;
  /** The models OpenAI says answered. */
  readerModel?: string;
  judgeModel?: string;
  readerFinish?: string | null;
  readerTokens?: { prompt: number; completion: number };
  judgeTokens?: { prompt: number; completion: number };
  error?: string;
}

/**
 * A score as print_qa_metrics.py prints round(x, 4) of a numpy float: "0.9143", "1.0", "nan".
 * numpy rounds as rint(x * 10^4) / 10^4, halves to even, which is not always Python's own round().
 */
export function pyRound4(x: number): string {
  if (Number.isNaN(x)) return "nan";
  const y = x * 10_000;
  const floor = Math.floor(y);
  const rest = y - floor;
  const n = rest > 0.5 ? floor + 1 : rest < 0.5 ? floor : floor % 2 === 0 ? floor : floor + 1;
  const r = n / 10_000;
  return Number.isInteger(r) ? `${r}.0` : String(r);
}

/** What print_qa_metrics.py prints for these results, line for line. */
export function qaMetricsPrintout(m: QaMetrics): string {
  return [
    "",
    "Evaluation results by task:",
    ...QA_TYPES.map((t) => `\t${t}: ${pyRound4(m.byType[t]!.accuracy)} (${m.byType[t]!.n})`),
    "",
    `Task-averaged Accuracy: ${pyRound4(m.taskAveraged)}`,
    `Overall Accuracy: ${pyRound4(m.overall)}`,
    `Abstention Accuracy: ${pyRound4(m.abstention.accuracy)} (${m.abstention.n})`,
  ].join("\n");
}

const pct = (x: number) => (Number.isNaN(x) ? "–" : (100 * x).toFixed(1));

export interface OfficialReport {
  runId: string;
  reader: string;
  dataset: string;
  records: QaRecord[];
  metrics: QaMetrics;
  /** Session-level retrieval scores as run_retrieval.py averages them (Summary.official). */
  retrieval?: { questions: number; scores: Record<string, number> };
}

const models = (values: (string | undefined)[]) => [...new Set(values.filter((v): v is string => !!v))].join(", ") || "–";
const total = (records: QaRecord[], pick: (r: QaRecord) => number | undefined) => records.reduce((s, r) => s + (pick(r) ?? 0), 0);

/** official.md: the scores as LongMemEval's scripts compute them, and what they rest on. */
export function officialMarkdown(r: OfficialReport): string {
  const m = r.metrics;
  const failed = r.records.filter((x) => x.error);
  const lines = [
    `## LongMemEval, official evaluation: run ${r.runId}`,
    "",
    `Scored as LongMemEval's own scripts score it (${UPSTREAM.repo}, commit ${UPSTREAM.commit.slice(0, 7)}): ` +
      `the reader prompt of src/generation/run_generation.py (reading method "con") with ${r.reader}, ` +
      `the answer check of src/evaluation/evaluate_qa.py with ${JUDGE_MODEL}, the averages of src/evaluation/print_qa_metrics.py. ` +
      `The reader gets what rhizome's recall tool hands an agent for the question: up to 8 items in 4,000 tokens. Dataset LongMemEval_S, cleaned (sha256 ${r.dataset.slice(0, 12)}…).`,
    "",
    `${m.questions} of ${r.records.length} questions answered and judged` + (failed.length ? `, **${failed.length} failed**` : "") + ". Accuracy in percent.",
    "",
    "| Question type | Accuracy | Questions |",
    "| --- | ---: | ---: |",
    ...QA_TYPES.map((t) => `| ${t} | ${pct(m.byType[t]!.accuracy)} | ${m.byType[t]!.n} |`),
    `| **Task-averaged accuracy** | **${pct(m.taskAveraged)}** | |`,
    `| **Overall accuracy** | **${pct(m.overall)}** | ${m.questions} |`,
    `| Abstention accuracy | ${pct(m.abstention.accuracy)} | ${m.abstention.n} |`,
    "",
    "print_qa_metrics.py prints for hypotheses.jsonl.eval-results-gpt-4o:",
    "",
    "```",
    qaMetricsPrintout(m).replace(/^\n/, ""),
    "```",
    "",
    `OpenAI named the reader ${models(r.records.map((x) => x.readerModel))} and the judge ${models(r.records.map((x) => x.judgeModel))}. ` +
      `Tokens: reader ${total(r.records, (x) => x.readerTokens?.prompt)} in, ${total(r.records, (x) => x.readerTokens?.completion)} out; ` +
      `judge ${total(r.records, (x) => x.judgeTokens?.prompt)} in, ${total(r.records, (x) => x.judgeTokens?.completion)} out. ` +
      `The reader stopped at its token limit on ${r.records.filter((x) => x.readerFinish === "length").length} questions.`,
  ];
  if (r.retrieval) {
    const keys = ["recall_any@5", "recall_all@5", "ndcg_any@5", "recall_any@10", "recall_all@10", "ndcg_any@10"];
    lines.push(
      "",
      `Retrieval, session level, as src/retrieval/run_retrieval.py averages it over ${r.retrieval.questions} questions (abstention questions and those without an evidence turn on the user side left out):`,
      "",
      `| ${keys.join(" | ")} |`,
      `| ${keys.map(() => "---:").join(" | ")} |`,
      `| ${keys.map((k) => pct(r.retrieval!.scores[k] ?? Number.NaN)).join(" | ")} |`,
    );
  }
  if (failed.length) {
    lines.push("", "Failed:", "", ...failed.slice(0, 20).map((x) => `- ${x.id}: ${x.error}`));
    if (failed.length > 20) lines.push(`- and ${failed.length - 20} more, see qa.jsonl`);
  }
  lines.push(
    "",
    "Files: hypotheses.jsonl (the answers, as run_generation.py writes them; `python3 src/evaluation/evaluate_qa.py gpt-4o hypotheses.jsonl longmemeval_s_cleaned.json` judges them again), " +
      "hypotheses.jsonl.eval-results-gpt-4o (the verdicts, as evaluate_qa.py writes them; `python3 src/evaluation/print_qa_metrics.py` reads it), " +
      "qa.jsonl (per question: answer, verdict, models, tokens), contexts.jsonl (what the reader got).",
  );
  return lines.join("\n") + "\n";
}
