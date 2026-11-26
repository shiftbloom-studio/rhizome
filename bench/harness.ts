// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Runs LongMemEval against rhizome's own memory code. Every question gets a
// fresh MemoryObject on the Node stand-ins (SQLite, files, exact vector
// search), is fed its sessions at their original dates and is then asked the
// question through the same recall an agent calls. No deployed rhizome and no
// real memory is involved.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import type { Env } from "../src/env";
import { MemoryObject, type EpisodeInput, type MemoryItem, type RecallInput } from "../src/memory-object";
import { DEFAULT_GRANTS, type Client } from "../src/scopes";
import { estimateTokens } from "../src/text";
import { LocalBucket } from "../src/node/blobs";
import { LocalNamespace } from "../src/node/durable";
import { LocalVectorIndex } from "../src/node/vectors";
import { stableJson, type AiRunner } from "./ai";
import { isAbstention, parseDate, typeKey, type Question, type Turn } from "./longmemeval";
import { latestRecords, scoreQuestion, sessionOrder, summarize, summaryMarkdown, type Evidence, type ItemRef, type ResultRecord, type Summary } from "./metrics";

/** Scope of every question's history. It has no ":" in it, so the episode files also work on Windows. */
const SCOPE = "profile";

export interface BenchOptions {
  /** Run directory with config.json, results.jsonl, summary.json and summary.md. An existing run is resumed. */
  out: string;
  ai: AiRunner;
  /** Variables for the memory code, e.g. EMBEDDING_MODEL or RECALL_FEATURES. */
  vars?: Record<string, string>;
  /** Extract notes from every session. Default off: recall searches the session chunks only. */
  extraction?: boolean;
  /** Recall steps, sent with every recall (RecallInput.features). Unset: the memory code's default (RECALL_FEATURES); [] turns all off. */
  features?: string[];
  /** Episode chunking, sent with every session (EpisodeInput.chunking). Unset: the memory code's default (CHUNKING). */
  chunking?: EpisodeInput["chunking"];
  /** Send the question date as asOf, besides referenceTime. Default true. */
  asOf?: boolean;
  /** Questions in parallel. Default 4. */
  concurrency?: number;
  /** Epoch ms after which no new question starts. */
  deadline?: number;
  /** Longest wait per question for embeddings and extraction to finish. */
  idleTimeoutMs?: number;
  /** Keep each question's memory store in <out>/stores. */
  keepStores?: boolean;
  /** Stored in config.json by the first run and compared on every resume. */
  settings?: Record<string, unknown>;
  /** Stored in config.json by the first run, not compared (commit, Node version). */
  meta?: Record<string, unknown>;
  /** Resume even when the settings differ. */
  force?: boolean;
  log?: (line: string) => void;
  /** Checked before every new question, e.g. after Ctrl+C. */
  stopped?: () => boolean;
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
async function waitIdle(stub: MemoryObject, client: Client, timeoutMs: number) {
  const until = Date.now() + timeoutMs;
  let quiet = 0;
  for (;;) {
    const s = await stub.stats(client);
    if (s.pendingVectors === 0 && s.pendingJobs === 0) {
      if (++quiet >= 2) return s;
    } else quiet = 0;
    if (Date.now() > until) {
      throw new Error(`background work not done after ${Math.round(timeoutMs / 1000)} s (${s.pendingVectors} vectors, ${s.pendingJobs} jobs pending)`);
    }
    await sleep(250);
  }
}

/** Maps recalled items to the sessions and turns they stand for. A note stands for the episodes it was extracted from. */
function itemRefs(stub: MemoryObject, client: Client, sessionOf: Map<string, string>, indexes: Map<string, SessionIndex>) {
  const noteSessions = new Map<string, string[]>();
  const chunkRef = (episodeId: string | null | undefined, content: string): ItemRef => {
    const session = episodeId ? sessionOf.get(episodeId) : undefined;
    if (!session) return { sessions: [], turns: [] };
    return { sessions: [session], turns: coveredTurns(indexes.get(session)!, content).map((n) => `${session}#${n}`) };
  };
  return async (items: MemoryItem[]): Promise<ItemRef[]> => {
    const out: ItemRef[] = [];
    for (const item of items) {
      if (item.kind === "chunk") {
        out.push(chunkRef(item.episodeId, item.content));
        continue;
      }
      let sessions = noteSessions.get(item.id);
      if (!sessions) {
        const d = await stub.detail(client, item.id);
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

async function runQuestion(q: Question, opts: BenchOptions, runId: string, storesDir: string): Promise<ResultRecord> {
  const abstention = isAbstention(q);
  const dir = join(storesDir, q.question_id.replace(/[^A-Za-z0-9_-]/g, "_"));
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  const vectors = new LocalVectorIndex(join(dir, "vectors.sqlite"));
  let env: Env;
  const memory = new LocalNamespace(join(dir, "memory"), MemoryObject, () => env);
  env = {
    ...opts.vars,
    EXTRACTION: opts.extraction ? "on" : "off",
    // One question replays months of sessions at once; the per-day cap is for live use.
    EXTRACTION_DAILY_LIMIT: "1000000",
    MEMORY: memory,
    EPISODES: new LocalBucket(join(dir, "episodes")),
    VECTORS: vectors,
    AI: opts.ai,
  } as unknown as Env;
  try {
    const client: Client = {
      id: "bench",
      userId: `eval-${q.question_id.replace(/[^A-Za-z0-9_-]/g, "_")}`,
      name: "LongMemEval",
      agent: "bench",
      provider: "longmemeval",
      grants: DEFAULT_GRANTS,
    };
    const stub = memory.get(memory.idFromName(`eval:${runId}:${q.question_id}`));
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
      const res = await stub.addEpisode(client, input);
      sessionOf.set(res.id, sessionId);
      chunks += res.chunks;
    }
    const stats = await waitIdle(stub, client, opts.idleTimeoutMs ?? (opts.extraction ? 3_600_000 : 900_000));
    const ingestMs = Date.now() - started;

    // The question is asked at its own date: time words resolve against it, and with asOf only what was true then counts.
    const askedAt = parseDate(q.question_date);
    const ask: RecallInput = {
      query: q.question,
      scopes: [SCOPE],
      referenceTime: askedAt,
      ...(opts.asOf !== false ? { asOf: askedAt } : {}),
      ...(opts.features ? { features: opts.features } : {}),
    };
    const deep = await stub.recall(client, { ...ask, limit: 50, budgetTokens: 1_000_000 });
    const shown = await stub.recall(client, ask);

    const refs = itemRefs(stub, client, sessionOf, indexes);
    const ranked = await refs(deep.items);
    const delivered = await refs(shown.items);
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
      record.metrics = { ...scoreQuestion(ranked, delivered, evidence), delivered_items: shown.items.length, delivered_tokens: deliveredTokens };
    }
    return record;
  } finally {
    memory.close();
    vectors.close();
    if (!opts.keepStores) rmSync(dir, { recursive: true, force: true });
  }
}

/** Walks JSON text, handing every character outside strings to `other`, which returns what to keep. */
function outsideStrings(text: string, other: (i: number) => { keep: string; skip?: number }): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') {
      const start = i;
      for (i++; i < text.length && text[i] !== '"'; i++) if (text[i] === "\\") i++;
      out += text.slice(start, i + 1);
      continue;
    }
    const r = other(i);
    out += r.keep;
    i += r.skip ?? 0;
  }
  return out;
}

/**
 * The plain values of the Worker's "vars" in wrangler.jsonc, without the <PLACEHOLDERS> that
 * deploys fill in. A run uses them, so it measures the configuration that is deployed.
 */
export function workerVars(jsonc: string): Record<string, string> {
  const noComments = outsideStrings(jsonc, (i) => {
    if (jsonc.startsWith("//", i)) {
      const end = jsonc.indexOf("\n", i);
      return { keep: "\n", skip: (end < 0 ? jsonc.length : end) - i };
    }
    if (jsonc.startsWith("/*", i)) {
      const end = jsonc.indexOf("*/", i + 2);
      return { keep: " ", skip: (end < 0 ? jsonc.length : end + 1) - i };
    }
    return { keep: jsonc[i]! };
  });
  const json = outsideStrings(noComments, (i) => ({ keep: noComments[i] === "," && /^\s*[}\]]/.test(noComments.slice(i + 1)) ? "" : noComments[i]! }));
  const vars = (JSON.parse(json) as { vars?: Record<string, unknown> }).vars ?? {};
  return Object.fromEntries(Object.entries(vars).flatMap(([k, v]) => (typeof v === "string" && !/^<[A-Z0-9_]+\??>$/.test(v) ? [[k, v]] : [])));
}

export function readResults(file: string): ResultRecord[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as ResultRecord);
}

function describe(r: ResultRecord): string {
  if (r.error) return `FAILED: ${r.error}`;
  const parts: string[] = [];
  if (r.metrics) parts.push(`top-5 ${r.metrics["recall_any@5"] ? "hit" : "miss"}`, `delivered ${r.metrics.delivered_any ? "yes" : "no"}`);
  else parts.push("abstention question");
  if (r.abstained !== undefined) parts.push(`abstained ${r.abstained ? "yes" : "no"}`);
  return parts.join(", ");
}

export async function runBenchmark(
  questions: Question[],
  opts: BenchOptions,
): Promise<{ summary: Summary; records: ResultRecord[]; remaining: number }> {
  const log = opts.log ?? ((line: string) => console.log(line));
  mkdirSync(opts.out, { recursive: true });
  const configFile = join(opts.out, "config.json");
  const resultsFile = join(opts.out, "results.jsonl");
  const settings = opts.settings ?? {};
  let runId: string;
  if (existsSync(configFile)) {
    const config = JSON.parse(readFileSync(configFile, "utf8")) as { runId: string; settings: Record<string, unknown>; meta?: Record<string, unknown> };
    if (stableJson(config.settings) !== stableJson(settings) && !opts.force) {
      throw new Error(
        `${opts.out} was started with other settings. Use a new --out, or --force to continue anyway.\n` +
          `  first run: ${stableJson(config.settings)}\n  this run:  ${stableJson(settings)}`,
      );
    }
    if (config.meta?.commit && opts.meta?.commit && config.meta.commit !== opts.meta.commit) {
      log(`note: this run started on commit ${String(config.meta.commit)}, the code is now at ${String(opts.meta.commit)}`);
    }
    runId = config.runId;
  } else {
    runId = basename(resolve(opts.out)).replace(/[^A-Za-z0-9_-]/g, "-") || "run";
    writeFileSync(configFile, JSON.stringify({ runId, created: new Date().toISOString(), settings, meta: opts.meta ?? {} }, null, 2) + "\n");
  }

  const done = new Set(latestRecords(readResults(resultsFile)).filter((r) => !r.error).map((r) => r.id));
  const todo = questions.filter((q) => !done.has(q.question_id));
  log(`${questions.length} questions: ${questions.length - todo.length} already done, ${todo.length} to run`);

  const storesDir = join(opts.out, "stores");
  const started = Date.now();
  let next = 0;
  let finished = 0;
  const worker = async () => {
    for (;;) {
      if (opts.stopped?.() || (opts.deadline !== undefined && Date.now() > opts.deadline)) return;
      const q = todo[next++];
      if (!q) return;
      const t0 = Date.now();
      let record: ResultRecord;
      try {
        record = await runQuestion(q, opts, runId, storesDir);
      } catch (err) {
        record = { id: q.question_id, type: q.question_type, abstention: isAbstention(q), error: String((err as Error)?.message ?? err).slice(0, 500) };
      }
      appendFileSync(resultsFile, JSON.stringify(record) + "\n");
      finished++;
      const perQuestion = (Date.now() - started) / finished;
      const left = Math.round(((todo.length - finished) * perQuestion) / 60_000);
      log(`[${finished}/${todo.length}] ${q.question_id} (${typeKey(q)}) ${((Date.now() - t0) / 1000).toFixed(1)} s: ${describe(record)}${todo.length > finished ? `, about ${left} min left` : ""}`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, opts.concurrency ?? 4) }, worker));
  if (!opts.keepStores) rmSync(storesDir, { recursive: true, force: true });

  const ids = new Set(questions.map((q) => q.question_id));
  const records = latestRecords(readResults(resultsFile)).filter((r) => ids.has(r.id));
  const summary = summarize(records);
  writeFileSync(join(opts.out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
  writeFileSync(join(opts.out, "summary.md"), summaryMarkdown(summary));
  return { summary, records, remaining: questions.length - records.filter((r) => !r.error).length };
}
