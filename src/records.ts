// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Records: memory as a database. Every note gets one typed row (what kind of thing it
// is about, who did what, how much, and when), so recall can hand out every note of a
// kind instead of the ten most similar ones, and agents can count, sum and list with
// sources. A cheap model files the notes in batches after extraction; the note text
// stays the source of truth and a record is dropped whenever its note changes.
// Everything here is pure; src/memory-object.ts wires it to SQLite and Workers AI.

/** Fast instruct model, outside the paid models' per-minute limit. */
export const DEFAULT_RECORDS_MODEL = "@cf/meta/llama-4-scout-17b-16e-instruct";
export const RECORD_TYPES = ["event", "state", "preference", "other"] as const;
export type RecordType = (typeof RECORD_TYPES)[number];

/** Notes per model call, and calls per job run. */
export const RECORDS_BATCH = 20;
export const RECORDS_PARALLEL = 4;
/** Categories shown to the model so it reuses names instead of inventing synonyms. */
export const RECORDS_VOCABULARY = 80;

/**
 * Query to label similarity (bge-m3) at which a category counts as asked for.
 * Measured: "How many weddings did I attend" -> "wedding" 0.65, "celebration" 0.51;
 * "What is the name of my dog" -> "dog" 0.75, "pet" 0.64, unrelated labels <= 0.5.
 */
export const LABEL_SIMILARITY = 0.6;
/** Labels this close to the best one are asked for too ("wedding" and "wedding attendance"). */
export const LABEL_MARGIN = 0.05;
export const MAX_LABELS = 3;
/** Rows recall adds at most, and the share of its token budget they may take. */
export const MAX_RECORD_ROWS = 25;
export const RECORD_BUDGET_SHARE = 0.35;

export const RECORDS_PROMPT = `You file the notes of a personal memory into a database. Input: the categories already in use, then numbered notes, each with the date it was written. Output only one line of JSON, no prose, no code fence:
{"r":[[<note number>,"<type>","<category>",["<tag>"],<quantity|null>,"<unit>"|null,"<YYYY-MM-DD>"|null]]}
One array per note, in the order of the notes, for every note:
- type: "event" for something that happened at one time (attended, bought, visited, finished, met, started, was born), "state" for something that holds for a while (owns, lives in, works at, has, uses), "preference" for likes, dislikes, wishes and rules, "other" for anything else.
- category: what kind of thing the note is about, the generic word a question that counts or lists such things would use: English, singular, lowercase, 1 to 3 words, e.g. "wedding", "concert", "bike repair", "musical instrument", "pet", "baby", "job", "trip", "doctor appointment", "deploy tool". Never a name, a date or a sentence. Use a category from the list when it is the same kind of thing.
- tags: up to 3 broader or related generic words, e.g. "celebration", "expense", "family event", "guitar". May be empty.
- quantity and unit: the main number the note states (a price with unit "USD" or "EUR", a duration with "hours" or "days", a count with what is counted), else null and null.
- date: when it happened or became true, if the note says so, as YYYY-MM-DD; resolve relative dates against the note's date. Else null.
Do not invent anything that is not in the note.`;

export interface TypedRecord {
  type: RecordType;
  category: string;
  tags: string[];
  quantity: number | null;
  unit: string | null;
  /** Epoch ms of the date the model read from the note, or null. */
  date: number | null;
}

/** "Weddings!" -> "wedding"-like label: lowercase words, no punctuation, at most 3 words and 40 characters. */
export function normalizeLabel(raw: unknown): string {
  if (typeof raw !== "string") return "";
  const words = raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 3);
  return words.join(" ").slice(0, 40).trim();
}

const short = (v: unknown, max: number): string | null => {
  if (typeof v !== "string") return null;
  const s = v.trim().replace(/\s+/g, " ").slice(0, max);
  return s && s.toLowerCase() !== "null" ? s : null;
};

function parseDay(v: unknown): number | null {
  if (typeof v !== "string") return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v.trim());
  if (!m) return null;
  const t = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const d = new Date(t);
  return d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? t : null;
}

/** Records per note index from the model's answer. Notes it skipped or filed without a category stay null.
 * Takes the compact array form of RECORDS_PROMPT; an array without a note number counts by its position. */
export function validateRecords(raw: unknown, notes: number): (TypedRecord | null)[] {
  const list = (raw as { r?: unknown; records?: unknown })?.r ?? (raw as { records?: unknown })?.records;
  if (!Array.isArray(list)) throw new Error("records output has no r array");
  const out: (TypedRecord | null)[] = Array.from({ length: notes }, () => null);
  list.forEach((entry, pos) => {
    const r = Array.isArray(entry)
      ? { note: entry[0], type: entry[1], category: entry[2], tags: entry[3], quantity: entry[4], unit: entry[5], date: entry[6] }
      : (entry as Record<string, unknown> | null);
    if (!r || typeof r !== "object") return;
    const i = typeof r.note === "number" ? r.note : pos;
    if (!Number.isInteger(i) || i < 0 || i >= notes || out[i]) return;
    const category = normalizeLabel(r.category);
    if (!category) return;
    const type = (RECORD_TYPES as readonly string[]).includes(r.type as string) ? (r.type as RecordType) : "other";
    const tags = Array.isArray(r.tags) ? ([...new Set(r.tags.map(normalizeLabel))].filter((t) => t && t !== category).slice(0, 3) as string[]) : [];
    const q = typeof r.quantity === "number" ? r.quantity : typeof r.quantity === "string" && /\d/.test(r.quantity) ? Number(r.quantity.replace(/[^\d.-]/g, "")) : Number.NaN;
    const quantity = Number.isFinite(q) ? q : null;
    out[i] = { type, category, tags, quantity, unit: quantity === null ? null : short(r.unit, 20), date: parseDay(r.date) };
  });
  return out;
}

/** The model's input: the vocabulary, then one line per note with its date. */
export function recordsInput(vocabulary: string[], notes: { content: string; at: number }[]): string {
  const vocab = vocabulary.length ? vocabulary.join(", ") : "(none yet)";
  const lines = notes.map((n, i) => `${i}. (${new Date(n.at).toISOString().slice(0, 10)}) ${n.content.replace(/\s+/g, " ").slice(0, 600)}`);
  return `Categories in use: ${vocab}\n\nNotes:\n${lines.join("\n")}`;
}

/**
 * Which labels a query asks for: those at least LABEL_SIMILARITY from the query and within
 * LABEL_MARGIN of the best, at most MAX_LABELS. A label the query names word for word
 * (after a simple plural fold) always counts.
 */
export function pickLabels(scored: { label: string; similarity: number }[], query: string): string[] {
  const words = new Set(
    query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length > 2)
      .map(singular),
  );
  const named = scored.filter((s) => s.label.split(" ").every((w) => words.has(singular(w))));
  const best = Math.max(...scored.map((s) => s.similarity), 0);
  const close = scored.filter((s) => s.similarity >= LABEL_SIMILARITY && s.similarity >= best - LABEL_MARGIN);
  const out: string[] = [];
  for (const s of [...named, ...close.sort((a, b) => b.similarity - a.similarity)]) {
    if (!out.includes(s.label)) out.push(s.label);
    if (out.length >= MAX_LABELS) break;
  }
  return out;
}

function singular(w: string): string {
  if (w.length > 4 && w.endsWith("ies")) return w.slice(0, -3) + "y";
  if (w.length > 3 && w.endsWith("es") && /(ss|x|ch|sh)es$/.test(w)) return w.slice(0, -2);
  if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

export interface RecordRow {
  /** The note's id. */
  id: string;
  scope: string;
  type: RecordType;
  category: string;
  tags: string[];
  quantity: number | null;
  unit: string | null;
  /** When it happened or became true (ISO), from the record's date or the note's. */
  date: string;
  /** The note itself, the row's source of truth. */
  content: string;
  status: string;
  /** Episodes the note was extracted from. */
  sources: string[];
}

export type RecordOp = "list" | "count" | "sum" | "latest";

/** count, sum per unit, or the newest row. Sums leave out rows without a quantity and say how many. */
export function aggregate(rows: RecordRow[], op: RecordOp): Record<string, unknown> {
  if (op === "count") return { count: rows.length };
  if (op === "latest") {
    const latest = [...rows].sort((a, b) => b.date.localeCompare(a.date))[0];
    return latest ? { latest: latest.id, date: latest.date } : { latest: null };
  }
  if (op === "sum") {
    const sums: Record<string, number> = {};
    let without = 0;
    for (const r of rows) {
      if (r.quantity === null) {
        without++;
        continue;
      }
      const unit = r.unit ?? "";
      sums[unit] = (sums[unit] ?? 0) + r.quantity;
    }
    return { sums: Object.entries(sums).map(([unit, total]) => ({ unit: unit || null, total: Math.round(total * 1e6) / 1e6 })), withoutQuantity: without };
  }
  return {};
}

/** One line per row for a reader: date, what it is, the note. */
export function recordLine(r: RecordRow): string {
  const amount = r.quantity !== null ? ` · ${r.quantity}${r.unit ? ` ${r.unit}` : ""}` : "";
  const flag = r.status === "disputed" ? " · disputed" : "";
  return `- ${r.date.slice(0, 10)} [${r.id}] (${r.type}${amount}${flag}) ${r.content}`;
}

/** The section recall adds when a query asks for a kind of thing: every row on file, oldest first. */
export function recordsSection(groups: { label: string; rows: RecordRow[]; total: number }[]): string {
  return groups
    .filter((g) => g.rows.length)
    .map((g) => {
      const more = g.total > g.rows.length ? `, ${g.rows.length} shown` : "";
      return `Records filed as "${g.label}" (${g.total} on file${more}, oldest first):\n${g.rows.map(recordLine).join("\n")}`;
    })
    .join("\n\n");
}
