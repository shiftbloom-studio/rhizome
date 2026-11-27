// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure helpers for the background intelligence: vector math, importance and
// decay, entity keys, and validation of what the language models return.
// Everything here is deterministic and unit tested; the Durable Object wires it
// to storage and Workers AI.

export const DEFAULT_EXTRACTION_MODEL = "@cf/deepseek-ai/deepseek-v4.1-flash-1017";
export const DEFAULT_REFLECTION_MODEL = "@cf/zai-org/glm-5.3";

/** Same fact said again: merge into the existing note. */
export const DUPLICATE_SIMILARITY = 0.93;
/** Related enough that a model has to decide: same, update, contradiction or new. */
export const RELATED_SIMILARITY = 0.78;
/**
 * Draw a "similar" edge in the graph above this. Notes on related topics land at
 * 0.55 to 0.7 with bge-m3 (unrelated ones well below 0.5), so 0.8 left the graph
 * without a single edge.
 */
export const LINK_SIMILARITY = 0.55;

// ------------------------------------------------------------------ vectors

export function encodeVector(v: number[]): ArrayBuffer {
  return new Float32Array(v).buffer;
}

export function decodeVector(blob: ArrayBuffer | Uint8Array): Float32Array {
  if (blob instanceof Uint8Array) {
    const copy = blob.slice();
    return new Float32Array(copy.buffer, 0, copy.byteLength / 4);
  }
  return new Float32Array(blob);
}

export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = a[i]!;
    const y = b[i]!;
    dot += x * y;
    na += x * x;
    nb += y * y;
  }
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

/** The k most similar candidates above a threshold, best first. */
export function nearest<T extends { vec: ArrayLike<number> }>(
  query: ArrayLike<number>,
  candidates: T[],
  k: number,
  threshold = 0,
): { item: T; similarity: number }[] {
  const out: { item: T; similarity: number }[] = [];
  for (const item of candidates) {
    const similarity = cosine(query, item.vec);
    if (similarity >= threshold) out.push({ item, similarity });
  }
  return out.sort((a, b) => b.similarity - a.similarity).slice(0, k);
}

// -------------------------------------------------------- importance, decay

export const TRUST_RANK: Record<string, number> = { user_explicit: 3, user_confirmed: 2, agent_inference: 1, tool: 0 };
const TRUST_BASE: Record<string, number> = { user_explicit: 1, user_confirmed: 0.85, agent_inference: 0.55, tool: 0.4 };
/** Half-life in days: what the person said fades much slower than what an agent guessed. */
const HALF_LIFE_DAYS: Record<string, number> = { user_explicit: 365, user_confirmed: 180, agent_inference: 60, tool: 30 };

export interface ImportanceInput {
  trust: string;
  kind: "chunk" | "note";
  confirmations: number;
  accessCount: number;
  /** Most recent of event time, last confirmation and last access. */
  lastTouched: number;
}

/**
 * Importance in [0, 1]. Combines trust, how often the memory was confirmed or
 * recalled, and an exponential decay since it was last touched.
 */
export function importance(i: ImportanceInput, now = Date.now()): number {
  const base = TRUST_BASE[i.trust] ?? 0.5;
  const ageDays = Math.max(0, (now - i.lastTouched) / 86_400_000);
  const recency = Math.pow(0.5, ageDays / (HALF_LIFE_DAYS[i.trust] ?? 90));
  const confirmed = Math.min(1, Math.log2(1 + Math.max(0, i.confirmations - 1)) / 3);
  const used = Math.min(1, Math.log2(1 + i.accessCount) / 5);
  const kindFactor = i.kind === "note" ? 1 : 0.7;
  const score = kindFactor * (0.5 * base + 0.2 * recency + 0.15 * confirmed + 0.15 * used);
  return Math.round(Math.min(1, Math.max(0, score)) * 1000) / 1000;
}

/** Old, never recalled, unimportant episode chunks leave the default recall. Raw episodes stay in R2. */
export function shouldArchive(i: ImportanceInput & { importance: number }, now = Date.now()): boolean {
  return i.kind === "chunk" && i.accessCount === 0 && i.importance < 0.25 && now - i.lastTouched > 365 * 86_400_000;
}

// ----------------------------------------------------------------- entities

export const ENTITY_TYPES = ["person", "project", "tool", "device", "org", "place", "concept"] as const;
export type EntityType = (typeof ENTITY_TYPES)[number];

/** Normalised lookup key, so "Cloudflare Workers" and "cloudflare-workers" resolve to one entity. */
export function entityKey(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// --------------------------------------------------------------- extraction

export type ExtractedScope = "profile" | "project" | "agent";
export type ExtractedKind = "preference" | "decision" | "fact" | "learning";
export type ExtractedTrust = "user_explicit" | "user_confirmed" | "agent_inference" | "tool";

export interface ExtractedFact {
  statement: string;
  kind: ExtractedKind;
  scope: ExtractedScope;
  trust: ExtractedTrust;
  validFrom: number | null;
  /** When the fact stopped being true ("until March", "no longer"), if the episode says so. */
  validTo: number | null;
  entities: string[];
  /** How the fact relates to a note shown under "Related memory", if the model said so. */
  relation: Relation | null;
  /** Index of that related note. */
  related: number | null;
}

export interface Extraction {
  facts: ExtractedFact[];
  entities: { name: string; type: EntityType }[];
}

export const EXTRACTION_PROMPT = `You extract long-term memory for a personal memory that all AI agents of one person share (Claude, ChatGPT, Hermes and others). Input: one episode with its time, agent, provider and messages. Output only a JSON object, no prose:
{"facts":[{"statement":"one self-contained English sentence","kind":"preference|decision|fact|learning","scope":"profile|project|agent","trust":"user_explicit|user_confirmed|agent_inference|tool","valid_from":"YYYY-MM-DD or null","valid_to":"YYYY-MM-DD or null","relation":"new|same|update|contradiction","related":<number of the related memory or null>,"entities":["names of entities this fact is about"]}],"entities":[{"name":"string","type":"person|project|tool|device|org|place|concept"}]}
Rules:
- Keep only durable information that helps in future sessions: preferences, working style, values, decisions, conventions, facts about the person's world. Small talk, greetings and one-off task details give {"facts":[],"entities":[]}.
- Write every statement in English, about "the user", self-contained without the conversation.
- Resolve relative dates against the episode time. valid_from is when the fact became true, valid_to when it stopped ("until March", "no longer since Monday"); null when the episode does not say.
- The input may list "Related memory": numbered notes that are already stored. Compare every fact with them and set relation and related:
  - "same": a related note already says this (wording may differ). related = its number.
  - "update": the fact changes or refines a related note because something changed over time; that note is now outdated. related = its number.
  - "contradiction": the fact and a related note cannot both be true and it is unclear which one is right. related = its number.
  - "new": no related note covers it. related = null.
  Still output facts that are "same", so they count as a confirmation. Never copy a related note as a new fact. Without related memory, use "new".
- trust: user_explicit only for what the user said; an assistant proposal the user accepted is user_confirmed; observations of the assistant are agent_inference; tool output is tool.
- scope: profile for preferences and working style that hold across projects; project for one project; agent for quirks of one tool or agent.
- kind: preference (likes, dislikes, style), decision (something chosen), fact (state of the world), learning (a lesson or pitfall).
- At most 12 facts. Do not invent anything that is not in the episode.`;

export const NOTE_ENTITIES_PROMPT = `You tag notes of a personal memory with the named things they are about: projects, products, tools, services, organisations, people and places. Input: numbered notes. Output only a JSON object, no prose:
{"notes":[{"note":<number>,"entities":[{"name":"string","type":"person|project|tool|device|org|place|concept"}]}]}
Rules:
- Only proper names and product names (e.g. "rhizome", "Cloudflare Workers", "Node.js", "GitHub"). No generic words or ideas like "user", "app", "copy", "replies", "deploys"; a note about none gets an empty list.
- Write each name the same way in every note, in its usual spelling, without versions ("Node 22" and "Node 26" are both "Node.js").
- At most 5 entities per note. Do not invent anything that is not in the note.`;

/** Entities per note index, from the note tagging answer. Unknown indexes and empty names are dropped. */
export function validateNoteEntities(raw: unknown, notes: number): Extraction["entities"][] {
  const out: Extraction["entities"][] = Array.from({ length: notes }, () => []);
  const list = (raw as { notes?: unknown })?.notes;
  if (!Array.isArray(list)) throw new Error("note tagging output has no notes array");
  for (const n of list) {
    const i = Number(n?.note);
    if (!Number.isInteger(i) || i < 0 || i >= notes || !Array.isArray(n?.entities)) continue;
    const seen = new Set(out[i]!.map((e) => entityKey(e.name)));
    for (const e of n.entities) {
      const name = typeof e?.name === "string" ? e.name.trim().slice(0, 80) : "";
      const key = entityKey(name);
      if (!name || !key || seen.has(key)) continue;
      seen.add(key);
      if (out[i]!.length >= 5) break;
      out[i]!.push({ name, type: ENTITY_TYPES.includes(e.type) ? (e.type as EntityType) : "concept" });
    }
  }
  return out;
}

export const RESOLVER_PROMPT = `You keep a personal memory consistent. For each pair, compare the NEW statement with the EXISTING memory and answer with one relation:
- "same": both say the same thing (wording may differ).
- "update": NEW refines or replaces EXISTING because something changed over time; EXISTING is outdated.
- "contradicts": both cannot be true at the same time and it is unclear which one is right.
- "new": they are about different things.
Output only JSON: {"results":[{"pair":<number>,"relation":"same|update|contradicts|new"}]}`;

export const PROFILE_PROMPT = `You maintain the profile that every AI agent of one person reads before it starts working. From the remembered notes below, write a concise profile of how this person works: working style, communication preferences, values, standing rules and recurring decisions. Rules:
- English, Markdown bullet points grouped under at most five short headings.
- Only what the notes support. Prefer notes with higher trust and more confirmations; drop superseded ideas.
- Standing rules ("never", "always") come first, verbatim in meaning.
- No speculation, no flattery, no filler. Maximum 1800 characters.
Output only the profile.`;

export const PROJECT_PROMPT = `Summarise the decisions, conventions and current state of one project from the remembered notes below, for an AI agent that joins the project. English, Markdown bullet points, newest decisions first, maximum 1200 characters. Only what the notes support. Output only the summary.`;

const KINDS: ExtractedKind[] = ["preference", "decision", "fact", "learning"];
const SCOPES: ExtractedScope[] = ["profile", "project", "agent"];
const TRUSTS: ExtractedTrust[] = ["user_explicit", "user_confirmed", "agent_inference", "tool"];

/** Text of a Workers AI text-generation result, whichever response shape the model uses. */
export function aiText(res: unknown): string {
  if (typeof res === "string") return res;
  const r = res as {
    response?: unknown;
    choices?: { message?: { content?: unknown } }[];
    output_text?: unknown;
    output?: { type?: string; content?: { text?: string }[] }[];
  };
  const t = r?.response ?? r?.choices?.[0]?.message?.content ?? r?.output_text;
  if (typeof t === "string") return t;
  if (t && typeof t === "object") return JSON.stringify(t);
  if (Array.isArray(r?.output)) {
    for (const o of r.output) if (o.type === "message") return (o.content ?? []).map((c) => c.text ?? "").join("");
  }
  return "";
}

/** First JSON object in a model answer, tolerant of code fences and reasoning prefixes. */
export function parseJsonObject(text: string): unknown {
  const cleaned = text.replace(/<think>[\s\S]*?<\/think>/g, "").replace(/```(?:json)?/g, "");
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("no JSON object in model output");
  return JSON.parse(cleaned.slice(start, end + 1));
}

/** Validates and normalises an extraction. Invalid facts are dropped, not repaired. */
export function validateExtraction(raw: unknown): Extraction {
  if (!raw || typeof raw !== "object") throw new Error("extraction is not an object");
  const r = raw as { facts?: unknown; entities?: unknown };
  if (!Array.isArray(r.facts)) throw new Error("extraction has no facts array");
  const entities: Extraction["entities"] = [];
  const seen = new Set<string>();
  for (const e of Array.isArray(r.entities) ? r.entities : []) {
    const name = typeof e?.name === "string" ? e.name.trim().slice(0, 80) : "";
    const key = entityKey(name);
    if (!name || !key || seen.has(key)) continue;
    seen.add(key);
    const type = ENTITY_TYPES.includes(e.type) ? (e.type as EntityType) : "concept";
    entities.push({ name, type });
  }
  const facts: ExtractedFact[] = [];
  for (const f of r.facts.slice(0, 12)) {
    const statement = typeof f?.statement === "string" ? f.statement.trim() : "";
    if (statement.length < 8 || statement.length > 600) continue;
    const validFrom = parseDay(f.valid_from) ?? Number.NaN;
    facts.push({
      statement,
      kind: KINDS.includes(f.kind) ? f.kind : "fact",
      scope: SCOPES.includes(f.scope) ? f.scope : "profile",
      trust: TRUSTS.includes(f.trust) ? f.trust : "agent_inference",
      validFrom: Number.isFinite(validFrom) ? validFrom : null,
      validTo: parseDay(f.valid_to),
      relation: RELATION_ALIASES[String(f.relation ?? "").toLowerCase()] ?? null,
      related: Number.isInteger(f.related) && f.related >= 0 ? (f.related as number) : null,
      entities: Array.isArray(f.entities)
        ? f.entities.filter((x: unknown): x is string => typeof x === "string" && x.trim().length > 0).map((x: string) => x.trim().slice(0, 80)).slice(0, 8)
        : [],
    });
  }
  for (const f of facts) {
    for (const name of f.entities) {
      const key = entityKey(name);
      if (key && !seen.has(key)) {
        seen.add(key);
        entities.push({ name, type: "concept" });
      }
    }
  }
  return { facts, entities };
}

export type Relation = "same" | "update" | "contradicts" | "new";

const RELATION_ALIASES: Record<string, Relation> = {
  same: "same",
  update: "update",
  contradiction: "contradicts",
  contradicts: "contradicts",
  new: "new",
};

/** A "YYYY-MM-DD..." string as epoch milliseconds, else null. */
function parseDay(v: unknown): number | null {
  if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}/.test(v)) return null;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Most related notes put into the extraction prompt. */
export const MAX_RELATED = 12;

/**
 * Notes most related to an episode, best first: reciprocal rank fusion of a
 * full-text ranking and an embedding ranking, both computed from stored data.
 */
export function relatedNotes<T extends { id: string; vec: ArrayLike<number> }>(
  episodeVec: ArrayLike<number> | null,
  pool: T[],
  ftsIds: string[],
  k = MAX_RELATED,
  minSimilarity = 0.35,
): T[] {
  const byId = new Map(pool.map((c) => [c.id, c]));
  const score = new Map<string, number>();
  const add = (ids: string[]) => ids.forEach((id, rank) => byId.has(id) && score.set(id, (score.get(id) ?? 0) + 1 / (60 + rank)));
  add(ftsIds);
  if (episodeVec) add(nearest(episodeVec, pool, k * 2, minSimilarity).map((n) => n.item.id));
  return [...score.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([id]) => byId.get(id)!);
}

/**
 * The "Related memory" section of the extraction input. Times are dates only and
 * content is cut, so the prompt grows by about 2,000 tokens at most.
 */
export function relatedSection(notes: { content: string; validFrom?: number | null }[]): string {
  if (!notes.length) return "";
  const lines = notes.map((n, i) => {
    const since = n.validFrom ? ` (since ${new Date(n.validFrom).toISOString().slice(0, 10)})` : "";
    return `${i}. ${n.content.replace(/\s+/g, " ").slice(0, 400)}${since}`;
  });
  return `\n\nRelated memory:\n${lines.join("\n")}`;
}

/**
 * When an update replaces a note, the old fact ends where the new one starts,
 * but never before it began itself.
 */
export function closeValidity(oldValidFrom: number | null, newValidFrom: number | null, now: number): number {
  const end = newValidFrom ?? now;
  return oldValidFrom === null ? end : Math.max(oldValidFrom, end);
}

export function validateRelations(raw: unknown, pairs: number): Relation[] {
  const out: Relation[] = Array.from({ length: pairs }, () => "new");
  const results = (raw as { results?: unknown })?.results;
  if (!Array.isArray(results)) throw new Error("resolver output has no results array");
  for (const r of results) {
    const i = Number(r?.pair);
    if (Number.isInteger(i) && i >= 0 && i < pairs && ["same", "update", "contradicts", "new"].includes(r?.relation)) {
      out[i] = r.relation;
    }
  }
  return out;
}

export type DisputeVerdict = "newer" | "older" | "both" | "unsure";

export const DISPUTE_PROMPT = `You settle contradictions in a personal memory that all AI agents of one person share. Each pair holds two notes that were flagged as contradicting each other, the older one first, each with the date it was written and who it comes from. Answer for each pair:
- "newer": the newer note replaces the older one, because something changed over time or because it answers an open question the older note raised. The older note was true until then.
- "older": the newer note is a mistake or a misreading; the older note still holds.
- "both": they do not really contradict each other; both can be true.
- "unsure": the notes do not tell. Prefer this over guessing.
Output only JSON: {"results":[{"pair":<number>,"verdict":"newer|older|both|unsure"}]}`;

/**
 * Settles a dispute without a model where the trust ladder decides: what the
 * person said or confirmed wins over a guess, and between two things the person
 * said the later one wins. Returns null when only a model can tell.
 */
export function settleByTrust(olderTrust: string, newerTrust: string): "newer" | "older" | null {
  const person = TRUST_RANK.user_confirmed!;
  if ((TRUST_RANK[newerTrust] ?? 1) >= person) return "newer";
  if ((TRUST_RANK[olderTrust] ?? 1) >= person) return "older";
  return null;
}

export function validateVerdicts(raw: unknown, pairs: number): DisputeVerdict[] {
  const out: DisputeVerdict[] = Array.from({ length: pairs }, () => "unsure");
  const results = (raw as { results?: unknown })?.results;
  if (!Array.isArray(results)) throw new Error("dispute output has no results array");
  for (const r of results) {
    const i = Number(r?.pair);
    if (Number.isInteger(i) && i >= 0 && i < pairs && ["newer", "older", "both", "unsure"].includes(r?.verdict)) {
      out[i] = r.verdict;
    }
  }
  return out;
}

/** Which scope an extracted fact lands in, given the scope of its episode. */
export function targetScope(fact: ExtractedScope, episodeScope: string): string {
  if (fact === "project" && episodeScope.startsWith("project:")) return episodeScope;
  if (fact === "agent" && episodeScope.startsWith("agent:")) return episodeScope;
  if (fact === "profile") return "profile";
  // A project fact from a profile or agent episode has no project to go to: keep it where it was said.
  return episodeScope;
}

/** Trust of a fact can never exceed what the episode's source supports. */
export function capTrust(trust: ExtractedTrust, hasUserMessages: boolean): ExtractedTrust {
  if (!hasUserMessages && (trust === "user_explicit" || trust === "user_confirmed")) return "agent_inference";
  return trust;
}
