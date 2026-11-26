// SPDX-License-Identifier: AGPL-3.0-or-later
//
// LongMemEval (Wu et al., ICLR 2025): 500 questions, each with its own chat
// history of user-assistant sessions. Labels name the sessions
// (answer_session_ids) and turns (has_answer) that hold the answer, so
// retrieval can be scored without an LLM judge.
// Data: https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const DATASET_URL = "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json";
export const DATASET_FILE = "longmemeval_s_cleaned.json";

export interface Turn {
  role: string;
  content: string;
  has_answer?: boolean;
}

export interface Question {
  question_id: string;
  question_type: string;
  question: string;
  answer: unknown;
  question_date: string;
  haystack_session_ids: string[];
  haystack_dates: string[];
  haystack_sessions: Turn[][];
  answer_session_ids: string[];
}

/** Question ids ending in `_abs` ask about something the history never mentions. */
export function isAbstention(q: Pick<Question, "question_id">): boolean {
  return q.question_id.endsWith("_abs");
}

/** Reporting group: the question type, or "abstention". */
export function typeKey(q: Pick<Question, "question_id" | "question_type">): string {
  return isAbstention(q) ? "abstention" : q.question_type;
}

/** "2023/05/20 (Sat) 02:21" as epoch milliseconds. The dataset has no time zone, so it is read as UTC. */
export function parseDate(text: string): number {
  const m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})(?:\s*\([A-Za-z]{3}\))?(?:\s+(\d{1,2}):(\d{2}))?\s*$/.exec(text.trim());
  if (!m) throw new Error(`unrecognised LongMemEval date: ${text}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4] ?? 0), Number(m[5] ?? 0));
}

function fail(index: number, problem: string): never {
  throw new Error(`question ${index}: ${problem}`);
}

const isStringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === "string");

/** Checks the shape of one question; `i` is its place in the dataset, for the error. */
export function validateQuestion(raw: unknown, i: number): Question {
  const q = raw as Partial<Question>;
  if (!q || typeof q !== "object") fail(i, "not an object");
  for (const key of ["question_id", "question_type", "question", "question_date"] as const) {
    if (typeof q[key] !== "string") fail(i, `${key} must be a string`);
  }
  if (!isStringArray(q.haystack_session_ids) || !isStringArray(q.haystack_dates) || !isStringArray(q.answer_session_ids)) {
    fail(i, "haystack_session_ids, haystack_dates and answer_session_ids must be string arrays");
  }
  if (!Array.isArray(q.haystack_sessions) || q.haystack_sessions.length !== q.haystack_session_ids.length || q.haystack_dates.length !== q.haystack_session_ids.length) {
    fail(i, "haystack_sessions, haystack_session_ids and haystack_dates must have the same length");
  }
  q.haystack_sessions.forEach((s, n) => {
    if (!Array.isArray(s) || s.some((t) => !t || typeof t.role !== "string" || typeof t.content !== "string")) {
      fail(i, `session ${n} must be a list of { role, content } turns`);
    }
  });
  parseDate(q.question_date as string);
  q.haystack_dates.forEach(parseDate);
  return q as Question;
}

/** Checks the shape of the dataset, so a wrong file fails before any model call. */
export function validateDataset(raw: unknown): Question[] {
  if (!Array.isArray(raw)) throw new Error("dataset must be a JSON array of questions");
  raw.forEach((q, i) => validateQuestion(q, i));
  return raw as Question[];
}

export async function loadDataset(file: string): Promise<{ questions: Question[]; sha256: string }> {
  const bytes = await readFile(file);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  return { questions: validateDataset(JSON.parse(bytes.toString("utf8"))), sha256 };
}

export interface Selection {
  /** Question ids to keep. */
  ids?: string[];
  /** Reporting groups to keep (question types, or "abstention"). */
  types?: string[];
  /** A sample of this many questions, spread over the groups in proportion to their size. */
  sample?: number;
  seed?: number;
  /** The first n questions, after the other filters. */
  limit?: number;
}

/** Small seeded generator (mulberry32), so a sample is the same on every machine. */
function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Picks the questions of a run. The result keeps the dataset's order. */
export function select<T extends Pick<Question, "question_id" | "question_type">>(questions: T[], sel: Selection = {}): T[] {
  let out = questions;
  if (sel.ids?.length) {
    const ids = new Set(sel.ids);
    out = out.filter((q) => ids.has(q.question_id));
  }
  if (sel.types?.length) {
    const types = new Set(sel.types);
    out = out.filter((q) => types.has(typeKey(q)));
  }
  if (sel.sample !== undefined && sel.sample < out.length) {
    const total = out.length;
    const sample = sel.sample;
    const groups = new Map<string, T[]>();
    for (const q of out) groups.set(typeKey(q), [...(groups.get(typeKey(q)) ?? []), q]);
    // Largest remainder: every group gets its share of the sample, rounded so the total fits.
    const shares = [...groups.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, qs]) => {
        const exact = (qs.length * sample) / total;
        return { key, qs, exact, take: Math.floor(exact) };
      });
    let left = sample - shares.reduce((n, s) => n + s.take, 0);
    for (const s of [...shares].sort((a, b) => b.exact - b.take - (a.exact - a.take) || a.key.localeCompare(b.key))) {
      if (left-- <= 0) break;
      s.take++;
    }
    const rand = random(sel.seed ?? 1);
    const keep = new Set<string>();
    for (const s of shares) {
      const shuffled = [...s.qs];
      for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!];
      }
      for (const q of shuffled.slice(0, s.take)) keep.add(q.question_id);
    }
    out = out.filter((q) => keep.has(q.question_id));
  }
  if (sel.limit !== undefined) out = out.slice(0, sel.limit);
  return out;
}

/**
 * Splits a JSON array of objects into the text of each object, chunk by chunk,
 * so a dataset of hundreds of megabytes never has to fit in memory at once.
 */
export class JsonArraySplitter {
  /** Before "[", after "[", after ",", inside an object, after an object, after "]". */
  private state: "start" | "open" | "comma" | "item" | "after" | "end" = "start";
  private depth = 0;
  private inString = false;
  private escaped = false;
  private parts: string[] = [];

  /** Feeds the next piece of text and returns the objects it completed. */
  push(chunk: string): string[] {
    const items: string[] = [];
    let start = this.state === "item" ? 0 : -1;
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk.charCodeAt(i);
      if (this.state === "item") {
        if (this.inString) {
          if (this.escaped) this.escaped = false;
          else if (c === 0x5c) this.escaped = true;
          else if (c === 0x22) this.inString = false;
        } else if (c === 0x22) this.inString = true;
        else if (c === 0x7b || c === 0x5b) this.depth++;
        else if ((c === 0x7d || c === 0x5d) && --this.depth === 0) {
          this.parts.push(chunk.slice(start, i + 1));
          items.push(this.parts.join(""));
          this.parts = [];
          this.state = "after";
          start = -1;
        }
        continue;
      }
      if (c === 0x20 || c === 0x0a || c === 0x0d || c === 0x09) continue;
      if (this.state === "start") {
        if (c !== 0x5b) throw new Error("the dataset is not a JSON array");
        this.state = "open";
      } else if (this.state === "open" || this.state === "comma") {
        if (c === 0x7b) {
          this.state = "item";
          this.depth = 1;
          start = i;
        } else if (c === 0x5d && this.state === "open") this.state = "end";
        else throw new Error("the dataset must be an array of objects");
      } else if (this.state === "after") {
        if (c === 0x2c) this.state = "comma";
        else if (c === 0x5d) this.state = "end";
        else throw new Error("the dataset must be an array of objects, separated by commas");
      } else throw new Error("unexpected data after the dataset's array");
    }
    if (this.state === "item" && start >= 0) this.parts.push(chunk.slice(start));
    return items;
  }

  /** Throws unless the array was closed. */
  end(): void {
    if (this.state !== "end") throw new Error("the dataset ended inside its array");
  }
}
