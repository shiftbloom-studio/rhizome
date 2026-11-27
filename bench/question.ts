// SPDX-License-Identifier: AGPL-3.0-or-later
//
// One LongMemEval question against one fresh memory: its sessions are saved as
// episodes at their original dates, the background work (embeddings, extraction)
// finishes, and the question goes through the same recall an agent calls.
// Runs on Node (bench/harness.ts) and inside a Durable Object on Cloudflare
// (bench/worker.ts).

import { RECALL_TOOL, recallText } from "../src/mcp";
import type { EpisodeInput, MemoryItem, MemoryObject, RecallInput } from "../src/memory-object";
import type { Client } from "../src/scopes";
import { estimateTokens } from "../src/text";
import { isAbstention, parseDate, type Question, type Turn } from "./longmemeval";
import { scoreQuestion, sessionOrder, type Evidence, type ItemRef, type ResultRecord } from "./metrics";
import { officialRetrieval } from "./official";

/** Scope of every question's history. It has no ":" in it, so the episode files also work on Windows. */
export const SCOPE = "profile";

/** Variables of the memory code a run may set over the Worker's vars. */
export const MEMORY_VARS = [
  "EMBEDDING_MODEL",
  "RERANK_MODEL",
  "EXTRACTION_MODEL",
  "REFLECTION_MODEL",
  "RECALL_FEATURES",
  "CHUNKING",
  "DISPUTE_RESOLUTION",
  "DREAMING",
  "DREAM_MODEL",
  "DREAM_DAILY_LIMIT",
] as const;

/** What a question needs of a memory: a store stub on Node, the Durable Object itself on Cloudflare. */
export type Memory = Pick<MemoryObject, "addEpisode" | "stats" | "recall" | "detail" | "requestReflection">;

export interface QuestionOptions {
  /** Recall steps, sent with every recall (RecallInput.features). Unset: the memory code's default (RECALL_FEATURES); [] turns all off. */
  features?: string[];
  /** Episode chunking, sent with every session (EpisodeInput.chunking). Unset: the memory code's default (CHUNKING). */
  chunking?: EpisodeInput["chunking"];
  /**
   * Also send the question date as asOf. Default off: agents recall without it, and
   * recall as of a time adds an exact search over the stored vectors to the index search.
   */
  asOf?: boolean;
  /** Run one reflection after the sessions, before recall. Default off. */
  reflect?: boolean;
  /** Longest wait for embeddings and extraction to finish. */
  idleTimeoutMs: number;
  /** Runs once the background work is done, before the question is asked (on Cloudflare: until the vector index has caught up). */
  afterIngest?: () => Promise<void>;
  /** Also recall as the recall tool does for an agent, for a reader to answer from (bench/official.ts). */
  agentView?: boolean;
}

/** What a reader answers from: the recall tool's text for the question, and the question as LongMemEval states it. */
export interface AgentView {
  /** The recall tool's text (src/mcp.ts): up to 8 items in 4,000 tokens. */
  text: string;
  items: number;
  tokens: number;
  question: string;
  questionDate: string;
  type: string;
  /** LongMemEval's answers are strings and whole numbers. */
  answer: string | number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface SessionIndex {
  /** The transcript with every run of whitespace as one space. Chunks are trimmed, and round chunks rejoin trimmed rounds, so they are matched in this form. */
  flat: string;
  /** Where each character of `flat` sits in the transcript. */
  at: number[];
  /** Where each turn sits in the transcript. */
  turns: { start: number; end: number }[];
}

/** A session as transcript() writes it, and where each turn sits in it. */
export function indexSession(turns: Turn[]): SessionIndex {
  let text = "";
  const spans: SessionIndex["turns"] = [];
  turns.forEach((t, i) => {
    if (i > 0) text += "\n";
    const piece = `[${t.role}] ${t.content}`;
    spans.push({ start: text.length, end: text.length + piece.length });
    text += piece;
  });
  let flat = "";
  const at: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const space = /\s/.test(text[i]!);
    if (space && (!flat || flat.endsWith(" "))) continue;
    flat += space ? " " : text[i];
    at.push(i);
  }
  return { flat, at, turns: spans };
}

/** Turns a chunk covers: half of the turn, or 300 characters of it. */
export function coveredTurns(index: SessionIndex, content: string): number[] {
  const needle = content.replace(/\s+/g, " ").trim();
  const found = needle ? index.flat.indexOf(needle) : -1;
  if (found < 0) return [];
  const start = index.at[found]!;
  const end = index.at[found + needle.length - 1]! + 1;
  const out: number[] = [];
  index.turns.forEach((t, i) => {
    const overlap = Math.min(end, t.end) - Math.max(start, t.start);
    if (overlap > 0 && overlap >= Math.min(300, Math.ceil((t.end - t.start) / 2))) out.push(i);
  });
  return out;
}

/** Waits until embeddings and jobs are done, looking twice in a row so a finishing alarm can write its last rows. */
export async function waitIdle(memory: Memory, client: Client, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  let quiet = 0;
  for (;;) {
    const s = await memory.stats(client);
    if (s.pendingVectors === 0 && s.pendingJobs === 0) {
      if (++quiet >= 2) return s;
    } else quiet = 0;
    if (Date.now() > until) {
      throw new Error(`background work not done after ${Math.round(timeoutMs / 1000)} s (${s.pendingVectors} vectors, ${s.pendingJobs} jobs pending)`);
    }
    await sleep(250);
  }
}

/**
 * The turn a part of a turn card shows (src/recall.ts turnUnits): its text
 * without the role and the "…" marks of a cut, found in the session, in the turn
 * it overlaps most. A window of a reply stands for the whole reply.
 */
export function partTurn(index: SessionIndex, part: string): number | undefined {
  const needle = part
    .replace(/^\[[^\]\n]{1,32}\] /, "")
    .replace(/^… /, "")
    .replace(/ …$/, "")
    .replace(/\s+/g, " ")
    .trim();
  const found = needle ? index.flat.indexOf(needle) : -1;
  if (found < 0) return undefined;
  const start = index.at[found]!;
  const end = index.at[found + needle.length - 1]! + 1;
  let best: number | undefined;
  let most = 0;
  index.turns.forEach((t, i) => {
    const overlap = Math.min(end, t.end) - Math.max(start, t.start);
    if (overlap > most) {
      most = overlap;
      best = i;
    }
  });
  return best;
}

/** Maps recalled items to the sessions and turns they stand for. A note stands for the episodes it was extracted from. */
export function itemRefs(memory: Memory, client: Client, sessionOf: Map<string, string>, indexes: Map<string, SessionIndex>) {
  const noteSessions = new Map<string, string[]>();
  const chunkRef = (episodeId: string | null | undefined, content: string, parts?: string[]): ItemRef => {
    const session = episodeId ? sessionOf.get(episodeId) : undefined;
    if (!session) return { sessions: [], turns: [] };
    const index = indexes.get(session)!;
    const turns = parts ? [...new Set(parts.flatMap((p) => partTurn(index, p) ?? []))] : coveredTurns(index, content);
    return { sessions: [session], turns: turns.map((n) => `${session}#${n}`) };
  };
  return async (items: MemoryItem[]): Promise<ItemRef[]> => {
    const out: ItemRef[] = [];
    for (const item of items) {
      if (item.kind === "chunk") {
        out.push(chunkRef(item.episodeId, item.content, item.parts));
        continue;
      }
      let sessions = noteSessions.get(item.id);
      if (!sessions) {
        const d = await memory.detail(client, item.id);
        const neighbours = d && "neighbours" in d ? (d.neighbours ?? []) : [];
        const episodes = neighbours.filter((n) => n.kind === "derived_from" && n.type === "episode").map((n) => n.id);
        sessions = [...new Set(episodes.flatMap((e) => sessionOf.get(e) ?? []))];
        noteSessions.set(item.id, sessions);
      }
      // With the evidence recall step a note brings its source excerpt, which can cover turns.
      const ev = item.evidence;
      out.push({ sessions, turns: ev ? chunkRef(ev.episodeId, ev.content).turns : [] });
    }
    return out;
  };
}

/** Saves the question's sessions, asks it and scores the answer. The memory must be empty and belong to `client`. */
export async function askQuestion(memory: Memory, client: Client, q: Question, opts: QuestionOptions): Promise<ResultRecord & { view?: AgentView }> {
  const abstention = isAbstention(q);
  const sessionOf = new Map<string, string>();
  const indexes = new Map<string, SessionIndex>();
  const evidence: Evidence = { sessions: new Set(), turns: new Set() };
  const answerSessions = new Set(q.answer_session_ids);
  let chunks = 0;
  const started = Date.now();
  for (let i = 0; i < q.haystack_sessions.length; i++) {
    const sessionId = q.haystack_session_ids[i]!;
    const turns = q.haystack_sessions[i]!;
    indexes.set(sessionId, indexSession(turns));
    if (answerSessions.has(sessionId)) evidence.sessions.add(sessionId);
    turns.forEach((t, n) => {
      if (t.has_answer === true) evidence.turns.add(`${sessionId}#${n}`);
    });
    if (turns.length === 0) continue;
    const input: EpisodeInput = {
      scope: SCOPE,
      sessionId,
      tEvent: parseDate(q.haystack_dates[i]!),
      messages: turns.map((t) => ({ role: t.role, content: t.content })),
      ...(opts.chunking ? { chunking: opts.chunking } : {}),
    };
    const res = await memory.addEpisode(client, input);
    sessionOf.set(res.id, sessionId);
    chunks += res.chunks;
  }
  let stats = await waitIdle(memory, client, opts.idleTimeoutMs);
  if (opts.reflect) {
    // As of the question's date. At today's date every session would be years old, and the reflection would archive its chunks.
    await memory.requestReflection(client, parseDate(q.question_date));
    stats = await waitIdle(memory, client, opts.idleTimeoutMs);
  }
  await opts.afterIngest?.();
  const ingestMs = Date.now() - started;

  // The question is asked at its own date, so time words resolve against it.
  const askedAt = parseDate(q.question_date);
  const ask: RecallInput = {
    query: q.question,
    scopes: [SCOPE],
    referenceTime: askedAt,
    ...(opts.asOf ? { asOf: askedAt } : {}),
    ...(opts.features ? { features: opts.features } : {}),
  };
  // The deep ranking scores excerpts, so it asks for them instead of turn cards.
  const deep = await memory.recall(client, { ...ask, limit: 50, budgetTokens: 1_000_000, cards: false });
  const shown = await memory.recall(client, ask);
  const tool = opts.agentView ? await memory.recall(client, { ...ask, ...RECALL_TOOL }) : undefined;

  const refs = itemRefs(memory, client, sessionOf, indexes);
  const ranked = await refs(deep.items);
  const delivered = await refs(shown.items);
  const read = tool ? await refs(tool.items) : undefined;
  const text = tool ? recallText(tool) : undefined;
  const deliveredTokens = estimateTokens(shown.text);
  const abstained = shown.abstained;
  const confidence = shown.items[0]?.confidence;
  const record: ResultRecord = {
    id: q.question_id,
    type: q.question_type,
    abstention,
    sessions: q.haystack_sessions.length,
    chunks,
    notes: stats.notes,
    ingestMs,
    recallMs: deep.tookMs,
    deliveredItems: shown.items.length,
    deliveredTokens,
    top: sessionOrder(ranked).slice(0, 10),
    ...(abstained !== undefined ? { abstained } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
  };
  if (!abstention && evidence.sessions.size > 0) {
    record.metrics = { ...scoreQuestion(ranked, delivered, evidence, read), delivered_items: shown.items.length, delivered_tokens: deliveredTokens };
    if (tool) Object.assign(record.metrics, { reader_items: tool.items.length, reader_tokens: estimateTokens(text!) });
  }
  const official = officialRetrieval(q, sessionOrder(ranked));
  if (official) record.official = official;
  if (!tool) return record;
  const view: AgentView = { text: text!, items: tool.items.length, tokens: estimateTokens(text!), question: q.question, questionDate: q.question_date, type: q.question_type, answer: q.answer as string | number };
  return { ...record, view };
}
