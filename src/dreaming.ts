// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Dreaming: a slow care pass over everything stored, not just what changed today.
// A cheap model reads small neighbourhoods of related notes and proposes edits:
// merge notes that say the same thing, mark notes that a later one replaced,
// rewrite unclear notes so they stand on their own, fix a note's kind, and write
// rollup notes that list every instance of one kind of thing (all weddings, all
// trips) with dates. The code below decides what of that is safe to apply; the
// Durable Object (memory-object.ts) runs it from its alarm and writes an audit row
// per change. Nothing is deleted: merged and replaced notes keep their history.

import { cosine, DEFAULT_EXTRACTION_MODEL, TRUST_RANK } from "./intel";

/**
 * DeepSeek V4.1 Flash without thinking: about 1 s and 40 neurons per group of 9 to 16
 * notes in a test (2026-11-27). Gemma 4 ignores reasoning_effort and thinks for a minute.
 */
export const DEFAULT_DREAM_MODEL = DEFAULT_EXTRACTION_MODEL;
/** Notes per neighbourhood sent to the model. */
export const DREAM_GROUP = 16;
/** Neighbours must be at least this similar to the seed to join its neighbourhood. */
export const DREAM_NEIGHBOUR = 0.6;
/** Neighbourhoods per alarm run; the job comes back until the pass is done or the day's budget is spent. */
export const DREAM_GROUPS_PER_RUN = 6;
/** Default cap of neighbourhoods (model calls) per person and UTC day: DREAM_DAILY_LIMIT. */
export const DREAM_DAILY_LIMIT = 100;
/** Production waits this long after the last write or recall before dreaming. */
export const DREAM_IDLE_MS = 10 * 60_000;
/** A merge needs the two notes at least this close; a replacement at least this. */
export const MERGE_SIMILARITY = 0.8;
export const SUPERSEDE_SIMILARITY = 0.5;
/** Rollups have at least this many members and at most this many characters. */
export const ROLLUP_MIN = 2;
export const ROLLUP_CHARS = 1500;

const KINDS = ["preference", "decision", "fact", "learning", "note"] as const;

export const DREAM_PROMPT = `You look after a personal memory that all AI agents of one person share. Below is a small group of related notes from it, each with a number, the date it refers to, its kind, who it comes from and its text. Notes marked ROLLUP are summaries written earlier by you, with the numbers of the notes they list.

Propose only changes that clearly make the memory better. Most groups need few or none. Never invent facts: every name, number and date you write must already be in the notes.

- "merge": notes that state the same fact (paraphrases, repeats). "keep" is the clearest one, "drop" the others. Not for notes that are merely about the same topic.
- "supersede": a later note replaces an earlier one because something changed (new job, moved, changed preference, a newer number). "old" and "new" are note numbers; "new" must be the later note.
- "rewrite": a note that cannot be understood on its own (missing subject, "it", "that thing", fragments). Give the full new text. Keep every fact, name, number and date. Not for notes that are fine.
- "kind": a note with the wrong kind (preference, decision, fact, learning, note).
- "rollups": when two or more notes are separate instances of one kind of thing the person did, owns, attended, bought, visited or counts (weddings, trips, purchases, pets, courses, books read, ...), write one rollup that lists every instance on its own line with the date shown for its note (YYYY-MM-DD), so a later question like "how many weddings did I attend" finds them together. Start with a short title line naming the category, for example "Weddings attended:". "members" are the note numbers listed. If a ROLLUP for that category is in the group, include it in "members" and write the updated full list. List only things that happened or are true, not plans: when a plan and its outcome are both there, list the outcome once. Do not roll up notes that are the same instance (merge those).

Output only JSON, with empty lists where nothing applies:
{"merge":[{"keep":0,"drop":[3]}],"supersede":[{"old":1,"new":4}],"rewrite":[{"note":2,"text":"..."}],"kind":[{"note":5,"kind":"preference"}],"rollups":[{"members":[0,6,7],"text":"Weddings attended:\\n- ... (2023-03-12)\\n- ..."}]}`;

export interface DreamNote {
  id: string;
  content: string;
  kind: string;
  trust: string;
  /** Event time, epoch milliseconds. */
  t: number;
  /** Stored embedding. */
  vec: ArrayLike<number>;
  /** Set for rollup notes: ids of the notes it lists. */
  rollupOf?: string[];
}

export interface DreamPlan {
  merge: { keep: string; drop: string[] }[];
  supersede: { old: string; new: string }[];
  rewrite: { id: string; content: string }[];
  kind: { id: string; kind: string }[];
  rollups: { members: string[]; replaces: string[]; content: string; t: number }[];
  /** Proposals the guards turned down, with the reason, for the audit log. */
  rejected: string[];
}

const day = (t: number) => new Date(t).toISOString().slice(0, 10);

/** The group as the model sees it. */
export function dreamInput(notes: DreamNote[]): string {
  const index = new Map(notes.map((n, i) => [n.id, i]));
  return notes
    .map((n, i) => {
      const of = n.rollupOf?.map((id) => index.get(id)).filter((x) => x !== undefined);
      const head = n.rollupOf ? `ROLLUP${of?.length ? ` of ${of.join(", ")}` : ""}` : `${n.kind}, ${n.trust}`;
      // One line per note: a rollup's lines are joined with " | ".
      return `${i}. (${day(n.t)}, ${head}) ${n.content.slice(0, n.rollupOf ? 1500 : 800).replace(/\s*\n\s*/g, " | ")}`;
    })
    .join("\n");
}

/** Numbers in a text, without leading zeros, so "03" and "3" count as the same. */
export function numbers(text: string): Set<string> {
  return new Set([...text.matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => m[0].replace(",", ".").replace(/^0+(?=\d)/, "")));
}

const subset = (a: Set<string>, b: Set<string>) => [...a].every((x) => b.has(x));

/**
 * Turns the model's answer into changes that are safe to apply. Guards:
 * a note takes part in at most one merge, replacement or rewrite; merges need
 * close embeddings; a replacement needs a later note that is at least as
 * trusted; a rewrite keeps exactly the numbers it had and never touches what
 * the person said in their own words; a rollup may only use numbers and dates
 * found in its members. Rollups themselves are only changed by a new rollup.
 */
export function planDream(raw: unknown, notes: DreamNote[]): DreamPlan {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const plan: DreamPlan = { merge: [], supersede: [], rewrite: [], kind: [], rollups: [], rejected: [] };
  const at = (v: unknown): DreamNote | undefined => (Number.isInteger(v) ? notes[v as number] : undefined);
  const list = (k: string) => (Array.isArray(r[k]) ? (r[k] as unknown[]) : []);
  const used = new Set<string>();
  const rank = (n: DreamNote) => TRUST_RANK[n.trust] ?? 1;
  const reject = (why: string) => plan.rejected.push(why);

  for (const m of list("merge") as { keep?: unknown; drop?: unknown }[]) {
    const keep = at(m?.keep);
    if (!keep || keep.rollupOf || used.has(keep.id)) continue;
    const drop: string[] = [];
    for (const d of Array.isArray(m.drop) ? m.drop : []) {
      const n = at(d);
      if (!n || n === keep || n.rollupOf || used.has(n.id)) continue;
      const sim = cosine(keep.vec, n.vec);
      if (sim < MERGE_SIMILARITY) {
        reject(`merge ${n.id} into ${keep.id}: similarity ${sim.toFixed(2)}`);
        continue;
      }
      // Merging keeps one wording; it must not lose a number only the other note has.
      if (!subset(numbers(n.content), numbers(keep.content))) {
        reject(`merge ${n.id} into ${keep.id}: numbers differ`);
        continue;
      }
      drop.push(n.id);
      used.add(n.id);
    }
    if (drop.length) {
      used.add(keep.id);
      plan.merge.push({ keep: keep.id, drop });
    }
  }

  for (const s of list("supersede") as { old?: unknown; new?: unknown }[]) {
    const old = at(s?.old);
    const next = at(s?.new);
    if (!old || !next || old === next || old.rollupOf || next.rollupOf || used.has(old.id)) continue;
    if (next.t < old.t) {
      reject(`supersede ${old.id} by ${next.id}: replacement is older`);
      continue;
    }
    if (rank(next) < rank(old)) {
      reject(`supersede ${old.id} by ${next.id}: replacement is less trusted`);
      continue;
    }
    if (cosine(old.vec, next.vec) < SUPERSEDE_SIMILARITY) {
      reject(`supersede ${old.id} by ${next.id}: not about the same thing`);
      continue;
    }
    used.add(old.id);
    plan.supersede.push({ old: old.id, new: next.id });
  }

  for (const w of list("rewrite") as { note?: unknown; text?: unknown }[]) {
    const n = at(w?.note);
    const text = typeof w?.text === "string" ? w.text.trim() : "";
    if (!n || n.rollupOf || used.has(n.id) || !text || text === n.content) continue;
    if (n.trust === "user_explicit") {
      reject(`rewrite ${n.id}: the person's own words`);
      continue;
    }
    // Every number stays; the only new ones allowed are the note's own date.
    const a = numbers(n.content);
    const b = numbers(text);
    const dated = new Set([...a, ...numbers(day(n.t))]);
    if (!subset(a, b) || !subset(b, dated)) {
      reject(`rewrite ${n.id}: numbers changed`);
      continue;
    }
    if (text.length < 8 || text.length > Math.max(2 * n.content.length, n.content.length + 200, 600)) {
      reject(`rewrite ${n.id}: length`);
      continue;
    }
    used.add(n.id);
    plan.rewrite.push({ id: n.id, content: text });
  }

  for (const k of list("kind") as { note?: unknown; kind?: unknown }[]) {
    const n = at(k?.note);
    if (!n || n.rollupOf || used.has(n.id) || !KINDS.includes(k.kind as (typeof KINDS)[number]) || k.kind === n.kind) continue;
    plan.kind.push({ id: n.id, kind: String(k.kind) });
  }

  for (const u of list("rollups") as { members?: unknown; text?: unknown }[]) {
    const text = typeof u?.text === "string" ? u.text.trim() : "";
    const picked = [...new Set((Array.isArray(u?.members) ? u.members : []).map(at).filter((n): n is DreamNote => !!n))];
    const replaces = picked.filter((n) => n.rollupOf);
    const members = new Map<string, DreamNote | undefined>();
    for (const n of picked) if (!n.rollupOf) members.set(n.id, n);
    // An earlier rollup's members stay listed even when they are outside this group.
    for (const old of replaces) for (const id of old.rollupOf!) if (!members.has(id)) members.set(id, notes.find((n) => n.id === id));
    if (!text || text.length > ROLLUP_CHARS || members.size < ROLLUP_MIN) {
      if (text) reject(`rollup: ${members.size} members, ${text.length} characters`);
      continue;
    }
    const allowed = new Set<string>();
    for (const n of [...picked, ...members.values()]) {
      if (!n) continue;
      for (const x of numbers(n.content)) allowed.add(x);
      for (const x of numbers(day(n.t))) allowed.add(x);
    }
    const unknown = [...numbers(text)].filter((x) => !allowed.has(x));
    if (unknown.length) {
      reject(`rollup: numbers not in its members (${unknown.slice(0, 5).join(", ")})`);
      continue;
    }
    const t = Math.max(...picked.map((n) => n.t));
    plan.rollups.push({ members: [...members.keys()], replaces: replaces.map((n) => n.id), content: text, t });
  }
  return plan;
}

/** Number of changes in a plan. */
export function planSize(p: DreamPlan): number {
  return p.merge.reduce((n, m) => n + m.drop.length, 0) + p.supersede.length + p.rewrite.length + p.kind.length + p.rollups.length;
}
