// SPDX-License-Identifier: AGPL-3.0-or-later
//
// BEAM (Tavakoli et al., "Beyond a Million Tokens", ICLR 2026, arXiv 2510.27246): 100
// conversations of 100K, 500K, 1M and 10M tokens between a user and an assistant, with
// 20 probing questions each, two for each of ten memory abilities. Every question has
// a rubric of nuggets; an LLM judge scores the answer against each nugget (1, 0.5 or 0)
// and the question scores their mean. Event-ordering questions score the normalised
// Kendall tau-b between the rubric's order and the answer's lines instead.
//
// This file holds what the run needs from BEAM's repository
// (https://github.com/mohammadtavakoli78/BEAM at BEAM_UPSTREAM.commit, MIT licence, data and code):
// - the conversations, cut into one episode per turn at the date of its batch,
// - the reader prompt of src/prompts.py (answer_generation_for_rag), filled with what
//   rhizome's recall tool returns for the question, as the paper's RAG baselines fill it,
// - the judge of src/evaluation/compute_metrics.py: unified_llm_judge_base_prompt per
//   rubric item at temperature 0, parse_json_response(), and for event ordering
//   align_with_llm() with llm_equivalence() and event_ordering_score(),
// - the averages of src/evaluation/report_results.py: per conversation and ability,
//   then over the conversations.
// The prompts are copied character for character; test/bench-beam.test.ts checks them
// against test/fixtures/beam-official.json, written by bench/beam-fixture.py.

import { RECALL_TOOL, recallText } from "../src/mcp";
import type { EpisodeInput, RecallInput } from "../src/memory-object";
import type { Client } from "../src/scopes";
import { estimateTokens } from "../src/text";
import { JsonArraySplitter } from "./longmemeval";
import { REASONING_READER_MAX_TOKENS, chatCompletion, type ChatReply, type ChatRequest, type OpenAiOptions, type ReaderEffort } from "./official";
import { SCOPE, indexSession, itemRefs, waitIdle, type Memory, type SessionIndex } from "./question";

export const BEAM_UPSTREAM = { repo: "https://github.com/mohammadtavakoli78/BEAM", commit: "b2da22eac88bb0874c64665f13457eb99835774a" } as const;

/** The judge of compute_metrics.py (gpt_llm in src/llm.py). */
export const BEAM_JUDGE_MODEL = "gpt-4.1-mini";

export const BEAM_TIERS = ["100K", "500K", "1M", "10M"] as const;
export type BeamTier = (typeof BEAM_TIERS)[number];
/** Conversations per tier, numbered from 1 (chats/<tier>/<n>/). */
export const BEAM_CONVERSATIONS: Record<BeamTier, number> = { "100K": 20, "500K": 35, "1M": 35, "10M": 10 };

/** The ten abilities, in the order of probing_questions.json and report_results.py. */
export const BEAM_ABILITIES = [
  "abstention",
  "contradiction_resolution",
  "event_ordering",
  "information_extraction",
  "instruction_following",
  "knowledge_update",
  "multi_session_reasoning",
  "preference_following",
  "summarization",
  "temporal_reasoning",
] as const;
export type BeamAbility = (typeof BEAM_ABILITIES)[number];

/** A file of a conversation in BEAM's repository, at the pinned commit. */
export const beamFileUrl = (tier: BeamTier, n: number, file: string) =>
  `https://raw.githubusercontent.com/mohammadtavakoli78/BEAM/${BEAM_UPSTREAM.commit}/chats/${tier}/${n}/${file}`;

/**
 * The chat files of a conversation, in the order answer_generation.py looks for them:
 * where BEAM cut a conversation to its tier's length (chat_trunecated.json, sic), that is the one it answers from.
 */
export const BEAM_CHAT_FILES = ["chat_trunecated.json", "chat.json"] as const;

// ------------------------------------------------------------------- dataset

export interface BeamMessage {
  /** The message's id in the conversation: the probing questions name their evidence by it. */
  id: number;
  role: string;
  content: string;
}

/** One turn of the conversation (a user message and the assistant's reply, sometimes a follow-up): one episode. */
export interface BeamSession {
  id: string;
  /** Epoch milliseconds: the date of its batch, a few minutes after the turn before. */
  time: number;
  batch: number;
  messages: BeamMessage[];
}

export interface BeamQuestion {
  /** `${tier}-${n}-${ability}-${index}`. */
  id: string;
  ability: BeamAbility;
  /** Its place among the ability's questions in probing_questions.json. */
  index: number;
  question: string;
  rubric: string[];
  /** Message ids the question names as its evidence (source_chat_ids), where it names any. */
  evidence: number[];
  difficulty?: string;
}

/** A conversation in the BENCH bucket: its questions, and its sessions in parts of at most a batch each. */
export interface BeamConversation {
  id: string;
  tier: BeamTier;
  n: number;
  source: string;
  sha256: string;
  bytes: number;
  sessions: number;
  messages: number;
  characters: number;
  /** Keys of the parts, in order: each a JSON list of sessions. */
  parts: string[];
  /** When the questions are asked: a day after the last turn. */
  askedAt: number;
  questions: BeamQuestion[];
  /** probing_questions.json as BEAM has it, so the answers can be written in its own shape. */
  raw: Record<string, unknown[]>;
}

const MONTHS = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];

/** "March-15-2024" (BEAM's time anchors) as epoch milliseconds, UTC. */
export function parseAnchor(text: string): number {
  const m = /^([A-Za-z]+)[-\s](\d{1,2}),?[-\s](\d{4})$/.exec(text.trim());
  const month = m ? MONTHS.findIndex((name) => name === m[1]!.toLowerCase() || name.slice(0, 3) === m[1]!.toLowerCase()) : -1;
  if (!m || month < 0) throw new Error(`unrecognised BEAM time anchor: ${text}`);
  const at = Date.UTC(Number(m[3]), month, Number(m[2]));
  if (new Date(at).getUTCDate() !== Number(m[2])) throw new Error(`unrecognised BEAM time anchor: ${text}`);
  return at;
}

interface RawMessage {
  role?: unknown;
  id?: unknown;
  content?: unknown;
  time_anchor?: unknown;
}

interface RawBatch {
  batch_number?: unknown;
  turns?: unknown;
}

/** The batches of one item of a chat file: a batch itself, or (10M) a plan, {"plan-k": [batches]}. */
export function batchesOf(item: unknown): RawBatch[] {
  if (!item || typeof item !== "object" || Array.isArray(item)) throw new Error("a chat file must be a list of objects");
  if ("turns" in item) return [item as RawBatch];
  const values = Object.values(item);
  if (values.length === 1 && Array.isArray(values[0])) return values[0] as RawBatch[];
  throw new Error("an item of a chat file must be a batch (with turns) or a plan of batches");
}

const DAY = 86_400_000;
/** A batch starts at 08:00 on its date, and every turn comes five minutes after the one before. */
const BATCH_START = 8 * 3_600_000;
const TURN_GAP = 5 * 60_000;

/** Cuts batches into sessions, one per turn, numbered in order. */
export class SessionCutter {
  private turn = 0;
  private batch = 0;
  private last = -Infinity;
  private anchor: number | null = null;
  messages = 0;
  characters = 0;

  get lastTime(): number {
    return this.last;
  }

  get sessions(): number {
    return this.turn;
  }

  /** Batches before the first time anchor, waiting for it. */
  private pending: RawBatch[] = [];

  /**
   * The sessions of the next batch. The date sits on a batch's first user message; a batch
   * without one follows the one before by a day, and batches before the first anchor (one
   * 10M conversation starts so) precede it by a day each, so they come out with the batch that has it.
   */
  cut(raw: RawBatch): BeamSession[] {
    if (!Array.isArray(raw.turns)) throw new Error(`batch ${this.batch + this.pending.length + 1} has no list of turns`);
    const anchor = (raw.turns as unknown[])
      .flatMap((t) => (Array.isArray(t) ? (t as RawMessage[]) : []))
      .map((m) => m?.time_anchor)
      .find((a): a is string => typeof a === "string" && a.trim() !== "");
    if (anchor) {
      const at = parseAnchor(anchor);
      const before = this.pending.splice(0);
      const out = before.flatMap((b, i) => this.sessionsOf(b, at - (before.length - i) * DAY));
      return [...out, ...this.sessionsOf(raw, at)];
    }
    if (this.anchor === null) {
      this.pending.push(raw);
      return [];
    }
    return this.sessionsOf(raw, this.anchor + DAY);
  }

  /** Throws when batches are still waiting for a time anchor that never came. */
  end(): void {
    if (this.pending.length) throw new Error(`no batch of the conversation has a time anchor`);
  }

  private sessionsOf(raw: RawBatch, date: number): BeamSession[] {
    const batch = ++this.batch;
    this.anchor = date;
    const out: BeamSession[] = [];
    (raw.turns as unknown[]).forEach((t, i) => {
      if (!Array.isArray(t)) throw new Error(`batch ${batch}, turn ${i + 1} is not a list of messages`);
      const messages = (t as RawMessage[]).map((m, j) => {
        if (!m || typeof m.role !== "string" || typeof m.content !== "string" || typeof m.id !== "number") {
          throw new Error(`batch ${batch}, turn ${i + 1}, message ${j + 1} must have a role, an id and content`);
        }
        return { id: m.id, role: m.role, content: m.content };
      });
      if (!messages.length) return;
      const time = Math.max(date + BATCH_START + i * TURN_GAP, this.last + 60_000);
      this.last = time;
      this.messages += messages.length;
      this.characters += messages.reduce((n, m) => n + m.content.length, 0);
      out.push({ id: `t${++this.turn}`, time, batch, messages });
    });
    return out;
  }
}

/** Every number in a source_chat_ids value: a list, or an object of lists. */
function numbers(v: unknown): number[] {
  if (typeof v === "number" && Number.isInteger(v)) return [v];
  if (typeof v === "string" && /^\d+$/.test(v.trim())) return [Number(v)];
  if (Array.isArray(v)) return v.flatMap(numbers);
  if (v && typeof v === "object") return Object.values(v).flatMap(numbers);
  return [];
}

/** Checks probing_questions.json and lists its questions. */
export function beamQuestions(tier: BeamTier, n: number, raw: unknown): BeamQuestion[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("probing_questions.json must be an object of abilities");
  const out: BeamQuestion[] = [];
  for (const [key, list] of Object.entries(raw as Record<string, unknown>)) {
    if (!(BEAM_ABILITIES as readonly string[]).includes(key)) throw new Error(`unknown ability "${key}" in probing_questions.json`);
    if (!Array.isArray(list)) throw new Error(`${key} must be a list of questions`);
    list.forEach((q, index) => {
      const p = q as { question?: unknown; rubric?: unknown; source_chat_ids?: unknown; difficulty?: unknown };
      if (!p || typeof p.question !== "string") throw new Error(`${key} ${index}: question must be a string`);
      if (!Array.isArray(p.rubric) || !p.rubric.length || !p.rubric.every((r) => typeof r === "string")) throw new Error(`${key} ${index}: rubric must be a list of strings`);
      out.push({
        id: `${tier}-${n}-${key}-${index}`,
        ability: key as BeamAbility,
        index,
        question: p.question,
        rubric: p.rubric as string[],
        evidence: [...new Set(numbers(p.source_chat_ids))].sort((a, b) => a - b),
        ...(typeof p.difficulty === "string" ? { difficulty: p.difficulty } : {}),
      });
    });
  }
  return out;
}

/** Where the dataset lives in the BENCH bucket, by commit. */
export const BEAM_PREFIX = `data/beam/${BEAM_UPSTREAM.commit.slice(0, 12)}`;
/** The last part of the key is unique across tiers and LongMemEval's questions: the embedding cache is named after it. */
export const beamConversationKey = (tier: BeamTier, n: number) => `${BEAM_PREFIX}/conversations/beam-${tier}-${n}.json`;
export const beamPartKey = (tier: BeamTier, n: number, part: number) => `${BEAM_PREFIX}/sessions/beam-${tier}-${n}/${part}.json`;

type Bucket = Pick<R2Bucket, "get" | "put">;

const BEAM_FILES = `https://raw.githubusercontent.com/mohammadtavakoli78/BEAM/${BEAM_UPSTREAM.commit}/chats/`;

/** Fetches a file of BEAM's repository at the pinned commit, and nothing else. */
async function fetchBeamFile(fetcher: typeof fetch, url: string): Promise<Response> {
  if (!url.startsWith(BEAM_FILES) || new URL(url).host !== "raw.githubusercontent.com" || url.includes("..")) throw new Error(`not a BEAM file: ${url}`);
  return fetcher(url);
}

async function sha256Hex(chunks: Uint8Array[]): Promise<string> {
  const size = chunks.reduce((n, c) => n + c.byteLength, 0);
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  const digest = await crypto.subtle.digest("SHA-256", all);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Copies one conversation into the bucket once: its questions, and its sessions in parts
 * of one batch (or one plan, for 10M) each. The chat file streams in and is split item by
 * item, so a 10M conversation of tens of megabytes never has to fit in memory as text.
 */
export async function importConversation(bucket: Bucket, tier: BeamTier, n: number, fetcher: typeof fetch = fetch): Promise<BeamConversation> {
  const key = beamConversationKey(tier, n);
  const existing = await bucket.get(key);
  if (existing) return existing.json<BeamConversation>();

  const questionsUrl = beamFileUrl(tier, n, "probing_questions/probing_questions.json");
  const qres = await fetchBeamFile(fetcher, questionsUrl);
  if (!qres.ok) throw new Error(`BEAM download failed: HTTP ${qres.status} for ${questionsUrl}`);
  const raw = (await qres.json()) as Record<string, unknown[]>;
  const questions = beamQuestions(tier, n, raw);

  let res: Response | null = null;
  let source = "";
  for (const file of BEAM_CHAT_FILES) {
    source = beamFileUrl(tier, n, file);
    const r = await fetchBeamFile(fetcher, source);
    if (r.ok && r.body) {
      res = r;
      break;
    }
    if (r.status !== 404) throw new Error(`BEAM download failed: HTTP ${r.status} for ${source}`);
  }
  if (!res?.body) throw new Error(`BEAM conversation ${tier}/${n} has no chat file`);

  const cutter = new SessionCutter();
  const splitter = new JsonArraySplitter();
  const decoder = new TextDecoder();
  const hashed: Uint8Array[] = [];
  const parts: string[] = [];
  let bytes = 0;
  const store = async (items: string[]) => {
    for (const text of items) {
      const sessions = batchesOf(JSON.parse(text)).flatMap((b) => cutter.cut(b));
      if (!sessions.length) continue;
      const partKey = beamPartKey(tier, n, parts.length);
      await bucket.put(partKey, JSON.stringify(sessions), { httpMetadata: { contentType: "application/json" } });
      parts.push(partKey);
    }
  };
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hashed.push(value);
    bytes += value.byteLength;
    await store(splitter.push(decoder.decode(value, { stream: true })));
  }
  await store(splitter.push(decoder.decode()));
  splitter.end();
  cutter.end();
  if (!parts.length) throw new Error(`BEAM conversation ${tier}/${n} has no turns`);

  const conversation: BeamConversation = {
    id: `beam-${tier}-${n}`,
    tier,
    n,
    source,
    sha256: await sha256Hex(hashed),
    bytes,
    sessions: cutter.sessions,
    messages: cutter.messages,
    characters: cutter.characters,
    parts,
    askedAt: cutter.lastTime + DAY,
    questions,
    raw,
  };
  await bucket.put(key, JSON.stringify(conversation), { httpMetadata: { contentType: "application/json" } });
  return conversation;
}

// -------------------------------------------------------------------- memory

export interface ConversationOptions {
  features?: string[];
  chunking?: EpisodeInput["chunking"];
  asOf?: boolean;
  reflect?: boolean;
  idleTimeoutMs: number;
  afterIngest?: () => Promise<void>;
  /** Only these questions are asked (ids); default all. */
  questions?: string[];
}

/** What the reader answers one question from, and how much of the question's evidence it holds. */
export interface BeamView {
  id: string;
  ability: BeamAbility;
  /** The recall tool's text (src/mcp.ts): up to 8 items in 4,000 tokens. */
  text: string;
  items: number;
  tokens: number;
  recallMs: number;
  /** Evidence messages of the question (source_chat_ids) and how many of them the text covers. */
  evidence: number;
  evidenceCovered: number;
}

export interface ConversationRecord {
  id: string;
  tier: BeamTier;
  sessions: number;
  chunks: number;
  notes: number;
  ingestMs: number;
  views: BeamView[];
}

/**
 * Saves a conversation's turns as episodes at their dates, waits for the background work
 * (embeddings, extraction, one reflection if asked), then asks each question through the
 * recall an agent's recall tool makes, a day after the last turn.
 */
export async function runConversation(
  memory: Memory,
  client: Client,
  conversation: BeamConversation,
  loadPart: (key: string) => Promise<BeamSession[]>,
  opts: ConversationOptions,
): Promise<ConversationRecord> {
  const started = Date.now();
  const sessionOf = new Map<string, string>();
  const indexes = new Map<string, SessionIndex>();
  /** Message id → `${sessionId}#${turn}`, as itemRefs names turns. */
  const where = new Map<number, string>();
  let chunks = 0;
  for (const key of conversation.parts) {
    for (const s of await loadPart(key)) {
      indexes.set(s.id, indexSession(s.messages));
      s.messages.forEach((m, i) => where.set(m.id, `${s.id}#${i}`));
      const res = await memory.addEpisode(client, {
        scope: SCOPE,
        sessionId: s.id,
        tEvent: s.time,
        messages: s.messages.map((m) => ({ role: m.role, content: m.content })),
        ...(opts.chunking ? { chunking: opts.chunking } : {}),
      });
      sessionOf.set(res.id, s.id);
      chunks += res.chunks;
    }
  }
  let stats = await waitIdle(memory, client, opts.idleTimeoutMs);
  if (opts.reflect) {
    await memory.requestReflection(client, conversation.askedAt);
    stats = await waitIdle(memory, client, opts.idleTimeoutMs);
  }
  await opts.afterIngest?.();
  const ingestMs = Date.now() - started;

  const refs = itemRefs(memory, client, sessionOf, indexes);
  const wanted = opts.questions?.length ? new Set(opts.questions) : null;
  const views: BeamView[] = [];
  for (const q of conversation.questions) {
    if (wanted && !wanted.has(q.id)) continue;
    const ask: RecallInput = {
      query: q.question,
      scopes: [SCOPE],
      referenceTime: conversation.askedAt,
      ...(opts.asOf ? { asOf: conversation.askedAt } : {}),
      ...(opts.features ? { features: opts.features } : {}),
      ...RECALL_TOOL,
    };
    const tool = await memory.recall(client, ask);
    const text = recallText(tool);
    const covered = new Set((await refs(tool.items)).flatMap((r) => r.turns));
    const evidence = q.evidence.filter((id) => where.has(id));
    views.push({
      id: q.id,
      ability: q.ability,
      text,
      items: tool.items.length,
      tokens: estimateTokens(text),
      recallMs: tool.tookMs,
      evidence: evidence.length,
      evidenceCovered: evidence.filter((id) => covered.has(where.get(id)!)).length,
    });
  }
  return { id: conversation.id, tier: conversation.tier, sessions: sessionOf.size, chunks, notes: stats.notes, ingestMs, views };
}

// ------------------------------------------------------------------- reader

/**
 * Python's str.replace: every occurrence, and the replacement taken literally ("$&" in an
 * answer or a code snippet stays as it is), so the prompts come out as BEAM's code builds them.
 */
export const pyReplace = (text: string, old: string, value: string) => text.split(old).join(value);

/** src/prompts.py, answer_generation_for_rag. */
export const BEAM_READER_PROMPT = `
You are an assistant that MUST answer questions using ONLY the information provided in the context below.\u0020

STRICT INSTRUCTIONS:
1. Answer ONLY based on the provided context
2. Do NOT use your internal knowledge

CONTEXT:
<context>

QUESTION:
<question>

ANSWER REQUIREMENTS:
- Be direct and concise
- Only output the answer to the question without any explanation\u0020

RESPONSE:
`;

/** The reader's prompt, as long_term_memory_methods.py fills it. */
export const beamReaderPrompt = (context: string, question: string) => pyReplace(pyReplace(BEAM_READER_PROMPT, "<context>", context), "<question>", question);

/**
 * The reader call: BEAM's reader runs at temperature 0 with no output limit. A reasoning
 * model gets a reasoning effort and room for its reasoning instead, and no temperature unless the effort is "none".
 */
export function beamReaderRequest(model: string, prompt: string, effort?: ReaderEffort | null): ChatRequest {
  const messages: ChatRequest["messages"] = [{ role: "user", content: prompt }];
  if (!effort) return { model, messages, n: 1, temperature: 0 };
  return { model, messages, n: 1, ...(effort === "none" ? { temperature: 0 as const } : {}), max_completion_tokens: REASONING_READER_MAX_TOKENS, reasoning_effort: effort };
}

// -------------------------------------------------------------------- judge

/** src/prompts.py, unified_llm_judge_base_prompt. */
export const BEAM_JUDGE_PROMPT = `
You are an expert evaluator tasked with judging whether the LLM's response demonstrates compliance with the specified RUBRIC CRITERION.

## EVALUATION INPUTS
- RUBRIC CRITERION (what to check): <rubric_item>
- RESPONSE TO EVALUATE: <llm_response>

## EVALUATION RUBRIC:
The rubric defines a specific requirement, constraint, or expected behavior that the LLM response should demonstrate.\u0020

**IMPORTANT**: Pay careful attention to whether the rubric specifies:
- **Positive requirements** (things the response SHOULD include/do)
- **Negative constraints** (things the response SHOULD NOT include/do, often indicated by "no", "not", "avoid", "absent")

## RESPONSIVENESS REQUIREMENT
A compliant response must be **on-topic** and attempt to answer it.
- If the response does not address the QUESTION, score **0.0** and stop.
- For negative constraints, both must hold: (a) the response is responsive to the QUESTION, and (b) the prohibited element is absent.

## SEMANTIC TOLERANCE RULES:
Judge by meaning, not exact wording.
- Accept **paraphrases** and **synonyms** that preserve intent.
- **Case/punctuation/whitespace** differences must be ignored.
- **Numbers/currencies/dates** may appear in equivalent forms (e.g., “$68,000”, “68k”, “68,000 USD”, or “sixty-eight thousand dollars”). Treat them as equal when numerically equivalent.
- If the rubric expects a number or duration, prefer **normalized comparison** (extract and compare values) over string matching.

## STYLE NEUTRALITY (prevents style contamination):
Ignore tone, politeness, length, and flourish unless the rubric explicitly requires a format/structure (e.g., “itemized list”, “no citations”, “one sentence”).
- Do **not** penalize hedging, voice, or verbosity if content satisfies the rubric.
- Only evaluate format when the rubric **explicitly** mandates it.

## SCORING SCALE:
- **1.0 (Complete Compliance)**: Fully complies with the rubric criterion.
  - Positive: required element present, accurate, properly executed (allowing semantic equivalents).
  - Negative: prohibited element **absent** AND response is **responsive**.
\u0020\u0020
- **0.5 (Partial Compliance)**: Partially complies.
  - Positive: element present but minor inaccuracies/incomplete execution.
  - Negative: generally responsive and mostly avoids the prohibited element but with minor/edge violations.
\u0020\u0020
- **0.0 (No Compliance)**: Fails to comply.
  - Positive: required element missing or incorrect.
  - Negative: prohibited element present **or** response is non-responsive/evasive even if the element is absent.

## EVALUATION INSTRUCTIONS:
1. **Understand the Requirement**: Determine if the rubric is asking for something to be present (positive) or absent (negative/constraint).

2. **Parse Compound Statements**: If the rubric contains multiple elements connected by "and" or commas, evaluate whether:
   - **All elements** must be present for full compliance (1.0)
   - **Some elements** present indicates partial compliance (0.5)
   - **No elements** present indicates no compliance (0.0)
\u0020\u0020\u0020
3. **Check Compliance**:\u0020
   - For positive requirements: Look for the presence and quality of the required element
   - For negative constraints: Look for the absence of the prohibited element

4. **Assign Score**: Based on compliance with the specific rubric criterion according to the scoring scale above.

5. **Provide Reasoning**: Explain whether the rubric criterion was satisfied and justify the score.

## OUTPUT FORMAT:
Return your evaluation in JSON format with two fields:

{
   "score": [your score: 1.0, 0.5, or 0.0],
   "reason": "[detailed explanation of whether the rubric criterion was satisfied and why this justified the assigned score]"
}

NOTE: ONLY output the json object, without any explanation before or after that
`;

/** The judge's prompt for one rubric item, as the evaluate_*() functions fill it. */
export const beamJudgePrompt = (rubricItem: string, response: string) => pyReplace(pyReplace(BEAM_JUDGE_PROMPT, "<rubric_item>", rubricItem), "<llm_response>", response);

/** llm_equivalence() in compute_metrics.py: do two snippets describe the same event? */
export function equivalenceMessages(first: string, second: string): ChatRequest["messages"] {
  return [
    {
      role: "system",
      content:
        "\n            You are a binary classifier.\n            If the TWO snippets describe the SAME event/fact, reply **YES**\n            Otherwise reply **NO**. No extra words.\n            DO NOT provide any exaplanation.\n        ",
    },
    { role: "user", content: `First snippet: ${first} \n\n                       Second snippet: ${second}\n                    ` },
  ];
}

/** ChatOpenAI(model, temperature=0).invoke(...), as src/llm.py builds the judge. */
export const judgeCall = (model: string, messages: ChatRequest["messages"]): ChatRequest => ({ model, messages, n: 1, temperature: 0 });

/**
 * parse_json_response() in compute_metrics.py, with its fallback (json_repair) cut down
 * to what a judge's reply needs: a score after "score", in any quotes.
 */
export function parseJudgeReply(reply: string): { score: number; reason?: string } {
  let text = reply.trim();
  // A fenced reply: the object or list between the fences (no regex, so a long reply cannot make it backtrack).
  if (text.startsWith("```")) {
    const close = text.lastIndexOf("```");
    let inside = close > 2 ? text.slice(3, close).trim() : "";
    if (inside.startsWith("json")) inside = inside.slice(4).trim();
    if ((inside.startsWith("{") && inside.endsWith("}")) || (inside.startsWith("[") && inside.endsWith("]"))) text = inside;
  }
  const read = (candidate: string) => {
    try {
      const v = JSON.parse(candidate) as { score?: unknown; reason?: unknown };
      const score = Number(v?.score);
      if (v && typeof v === "object" && Number.isFinite(score)) return { score, ...(typeof v.reason === "string" ? { reason: v.reason } : {}) };
    } catch {
      // not JSON
    }
    return null;
  };
  const whole = read(text);
  if (whole) return whole;
  // The first object or list, up to its first closing bracket, as the non-greedy search does.
  const braces = [text.indexOf("{"), text.indexOf("[")].filter((i) => i >= 0);
  if (braces.length) {
    const start = Math.min(...braces);
    const end = text.indexOf(text[start] === "{" ? "}" : "]", start);
    const part = end > start ? read(text.slice(start, end + 1)) : null;
    if (part) return part;
  }
  // What json_repair recovers from a judge's reply: the number after "score".
  const at = text.toLowerCase().indexOf("score");
  if (at >= 0) {
    let i = at + 5;
    while (i < text.length && " \t\n'\":[".includes(text[i]!)) i++;
    let j = i;
    while (j < text.length && /[\d.]/.test(text[j]!)) j++;
    const score = Number(text.slice(i, j));
    if (j > i && Number.isFinite(score)) return { score };
  }
  throw new Error(`the judge's reply has no score: ${reply.slice(0, 200)}`);
}

/** scipy.stats.kendalltau(x, y, variant="b"): NaN where it is undefined (fewer than two items, or one list all ties). */
export function kendallTauB(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2 || y.length !== n) return Number.NaN;
  let concordant = 0;
  let discordant = 0;
  let tiesX = 0;
  let tiesY = 0;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const dx = Math.sign(x[i]! - x[j]!);
      const dy = Math.sign(y[i]! - y[j]!);
      if (dx === 0) tiesX++;
      if (dy === 0) tiesY++;
      if (dx * dy > 0) concordant++;
      else if (dx * dy < 0) discordant++;
    }
  }
  const pairs = (n * (n - 1)) / 2;
  const denominator = Math.sqrt((pairs - tiesX) * (pairs - tiesY));
  if (!(denominator > 0)) return Number.NaN;
  return Math.max(-1, Math.min(1, (concordant - discordant) / denominator));
}

export interface OrderingScore {
  precision: number;
  recall: number;
  f1: number;
  /** null where Kendall's tau is undefined (scipy's NaN). */
  tau_norm: number | null;
  final_score: number | null;
}

/** event_ordering_score() after the alignment: the rubric's order against the answer's lines, aligned to the rubric. */
export function orderingScore(reference: string[], system: string[]): OrderingScore {
  const ref = new Set(reference);
  const tp = new Set(system.filter((x) => ref.has(x))).size;
  const fp = system.filter((x) => !ref.has(x)).length;
  const fn = reference.filter((x) => !system.includes(x)).length;
  const precision = tp + fp ? tp / (tp + fp) : 0;
  const recall = tp + fn ? tp / (tp + fn) : 0;
  const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
  const union = [...new Set([...reference, ...system])];
  const tieRank = union.length + 1;
  const toRank = (seq: string[]) => {
    const r = new Map<string, number>();
    seq.forEach((item, i) => r.set(item, i + 1));
    return union.map((u) => r.get(u) ?? tieRank);
  };
  const tau = kendallTauB(toRank(reference), toRank(system));
  const norm = Number.isNaN(tau) ? null : (tau + 1) / 2;
  return { precision, recall, f1, tau_norm: norm, final_score: norm === null ? null : norm * f1 };
}

export interface JudgedItem {
  rubric: string;
  score: number;
  reason?: string;
}

export interface BeamVerdict {
  /** What the question scores in report_results.py: tau_norm for event ordering, else the rubric mean. */
  score: number;
  llm_judge_score: number;
  items: JudgedItem[];
  ordering?: OrderingScore;
  calls: number;
  promptTokens: number;
  completionTokens: number;
  model: string;
}

/** Judges one answer as run_evaluation.py does for its ability. */
export async function judgeAnswer(ability: BeamAbility, rubric: string[], response: string, model: string, openai: OpenAiOptions): Promise<BeamVerdict> {
  let calls = 0;
  let promptTokens = 0;
  let completionTokens = 0;
  let served = "";
  const ask = async (messages: ChatRequest["messages"]): Promise<ChatReply> => {
    const reply = await chatCompletion(judgeCall(model, messages), openai);
    calls++;
    promptTokens += reply.promptTokens;
    completionTokens += reply.completionTokens;
    served ||= reply.model;
    return reply;
  };

  let ordering: OrderingScore | undefined;
  if (ability === "event_ordering") {
    // align_with_llm(): each of the answer's lines takes the first rubric item not taken yet that the judge calls the same.
    const used = new Set<number>();
    const aligned: string[] = [];
    for (const line of response.split("\n")) {
      let match: number | null = null;
      for (let i = 0; i < rubric.length; i++) {
        if (used.has(i)) continue;
        const reply = await ask(equivalenceMessages(rubric[i]!, line));
        if (reply.content.toLowerCase().includes("yes")) {
          match = i;
          break;
        }
      }
      if (match !== null) {
        aligned.push(rubric[match]!);
        used.add(match);
      } else aligned.push(line);
    }
    ordering = orderingScore(rubric, aligned);
  }

  const items: JudgedItem[] = [];
  for (const item of rubric) {
    const reply = await ask([{ role: "user", content: beamJudgePrompt(item, response) }]);
    items.push({ rubric: item, ...parseJudgeReply(reply.content) });
  }
  const llm = items.reduce((n, i) => n + i.score, 0) / items.length;
  // A NaN tau would make the ability's average NaN in report_results.py; it counts as 0 here.
  const score = ordering ? (ordering.tau_norm ?? 0) : llm;
  return { score, llm_judge_score: llm, items, ...(ordering ? { ordering } : {}), calls, promptTokens, completionTokens, model: served };
}

// ------------------------------------------------------------------ scores

export interface BeamAnswer {
  id: string;
  conversation: string;
  ability: BeamAbility;
  question: string;
  hypothesis?: string;
  verdict?: BeamVerdict;
  contextItems?: number;
  contextTokens?: number;
  evidence?: number;
  evidenceCovered?: number;
  readerModel?: string;
  readerTokens?: { prompt: number; completion: number; reasoning?: number };
  error?: string;
}

export interface BeamMetrics {
  conversations: number;
  questions: number;
  judged: number;
  failed: number;
  /** report_results.py: the mean per conversation and ability, then over the conversations that have it. */
  byAbility: Record<string, { conversations: number; questions: number; score: number }>;
  /** The mean of the ten abilities, as the paper reports a tier. */
  overall: number;
  /** Event-ordering questions where Kendall's tau was undefined, counted as 0. */
  undefinedTau: number;
  /** Mean share of a question's evidence messages the reader's text covers, over questions with evidence. */
  evidenceCoverage: number | null;
  /** Share of questions with evidence where the text covers every evidence message. */
  evidenceAll: number | null;
  contextTokens: number | null;
}

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

export function beamMetrics(answers: BeamAnswer[]): BeamMetrics {
  const judged = answers.filter((a): a is BeamAnswer & { verdict: BeamVerdict } => a.verdict !== undefined);
  const byAbility: BeamMetrics["byAbility"] = {};
  for (const ability of BEAM_ABILITIES) {
    const mine = judged.filter((a) => a.ability === ability);
    if (!mine.length) continue;
    const perConversation = new Map<string, number[]>();
    for (const a of mine) perConversation.set(a.conversation, [...(perConversation.get(a.conversation) ?? []), a.verdict.score]);
    byAbility[ability] = { conversations: perConversation.size, questions: mine.length, score: mean([...perConversation.values()].map(mean)) };
  }
  const withEvidence = answers.filter((a) => (a.evidence ?? 0) > 0);
  const contexts = answers.filter((a) => a.contextTokens !== undefined);
  return {
    conversations: new Set(answers.map((a) => a.conversation)).size,
    questions: answers.length,
    judged: judged.length,
    failed: answers.length - judged.length,
    byAbility,
    overall: mean(Object.values(byAbility).map((a) => a.score)),
    undefinedTau: judged.filter((a) => a.verdict.ordering && a.verdict.ordering.tau_norm === null).length,
    evidenceCoverage: withEvidence.length ? mean(withEvidence.map((a) => a.evidenceCovered! / a.evidence!)) : null,
    evidenceAll: withEvidence.length ? withEvidence.filter((a) => a.evidenceCovered === a.evidence).length / withEvidence.length : null,
    contextTokens: contexts.length ? mean(contexts.map((a) => a.contextTokens!)) : null,
  };
}

const pct = (x: number | null) => (x === null ? "–" : (100 * x).toFixed(1));

export interface BeamReport {
  runId: string;
  tier: BeamTier;
  reader: string | null;
  readerEffort: ReaderEffort | null;
  judge: string;
  metrics: BeamMetrics;
}

export function beamMarkdown(r: BeamReport): string {
  const m = r.metrics;
  const out = [
    `# BEAM ${r.tier}, run ${r.runId}`,
    "",
    r.reader
      ? `Reader ${r.reader}${r.readerEffort ? ` (reasoning effort ${r.readerEffort})` : ""} with BEAM's RAG prompt on what rhizome's recall tool returns (up to 8 items in 4,000 tokens); judge ${r.judge} with BEAM's rubric prompt, scored as src/evaluation/report_results.py averages (event ordering: normalised Kendall tau-b). BEAM ${BEAM_UPSTREAM.commit.slice(0, 7)}.`
      : `Retrieval only: no reader, no judge. BEAM ${BEAM_UPSTREAM.commit.slice(0, 7)}.`,
    "",
    `${m.conversations} conversations, ${m.questions} questions${r.reader ? `, ${m.judged} answered and judged${m.failed ? `, **${m.failed} failed**` : ""}` : ""}.`,
    "",
  ];
  if (r.reader) {
    out.push("| Ability | Questions | Score |", "| --- | ---: | ---: |");
    for (const ability of BEAM_ABILITIES) {
      const a = m.byAbility[ability];
      out.push(`| ${ability} | ${a?.questions ?? 0} | ${a ? pct(a.score) : "–"} |`);
    }
    out.push(`| **Overall (mean of abilities)** | ${m.judged} | **${pct(m.overall)}** |`, "");
    if (m.undefinedTau) out.push(`${m.undefinedTau} event-ordering answers had an undefined Kendall tau and count as 0.`, "");
  }
  out.push(
    "| Retrieval | Value |",
    "| --- | ---: |",
    `| Evidence messages in the reader's text | ${pct(m.evidenceCoverage)} % |`,
    `| Questions with all evidence in it | ${pct(m.evidenceAll)} % |`,
    `| Tokens of the reader's text | ${m.contextTokens === null ? "–" : Math.round(m.contextTokens)} |`,
    "",
  );
  return out.join("\n");
}
