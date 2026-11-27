// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure helpers for recall: confidence per result, abstention, diversity (one hit
// per episode plus MMR), turn cards and the switches for these steps.
// Deterministic and unit tested; the Durable Object wires them to storage.

import { cosine } from "./intel";
import { chunk, estimateTokens } from "./text";

/**
 * Recall steps. All of them run unless the request (`features`) or the
 * RECALL_FEATURES variable names fewer; "none" turns them all off.
 * - abstain: return nothing when no result is relevant enough.
 * - diversity: at most one excerpt per episode, then MMR on the stored embeddings.
 * - evidence: a note brings its best source excerpt when the token budget allows.
 * - time: English and German time expressions in the query become a time window.
 * - keys: excerpts are also found through the facts extracted from them.
 * - turns: conversations come back as turn cards: the turns of the best
 *   conversations are scored one by one and the best of them fill the budget.
 * - records: when the query asks for a kind of thing ("how many weddings"), every note
 *   filed under it (src/records.ts) comes along as a list, not only the most similar ones.
 */
export const RECALL_FEATURES = ["abstain", "diversity", "evidence", "time", "keys", "turns", "records"] as const;
export type RecallFeature = (typeof RECALL_FEATURES)[number];

/**
 * Parses a comma list such as "abstain,diversity", "all" or "none". Unknown
 * names are ignored. Unset (undefined or null) means all steps; an empty list
 * or string means none.
 */
export function parseFeatures(value: string | string[] | undefined | null): Set<RecallFeature> {
  if (value === undefined || value === null) return new Set(RECALL_FEATURES);
  const list = Array.isArray(value) ? value : value.split(",");
  const out = new Set<RecallFeature>();
  for (const raw of list) {
    const name = String(raw).trim().toLowerCase();
    if (name === "all") RECALL_FEATURES.forEach((f) => out.add(f));
    else if ((RECALL_FEATURES as readonly string[]).includes(name)) out.add(name as RecallFeature);
  }
  return out;
}

// ------------------------------------------------------------- keywords

const STOPWORDS = new Set(
  (
    // English
    "the and for are but not you all any can had her was one our out his has how its may new now old see two who did get got let say she too use " +
    "what when where which while with would could should about after again also been before being both does doing from have here into just more most " +
    "only other over same some such than that their them then there these they this those through very were your ever last week month year today " +
    "user users said told tell know remember did does done like want wants wanted please thing things " +
    // German
    "der die das den dem des ein eine einen einem einer eines und oder aber nicht ist sind war waren bin bist hat habe haben hatte hatten wird werden " +
    "mit von bei aus auf für über unter nach vor zum zur ich du er sie es wir ihr mein dein sein unser euer man was wer wie wo wann warum welche " +
    "welcher welches dass auch noch schon nur sehr mehr als wenn dann doch mal kann können soll sollen muss müssen will wollen gibt letzte letzten " +
    "letztes woche monat jahr heute gestern nochmal bitte weißt wieder"
  )
    .split(" ")
    .map((w) => fold(w)),
);

function fold(text: string): string {
  return text.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/** Words of a query that carry meaning: at least three characters and not a stop word. */
export function keywordTerms(query: string): string[] {
  const words = fold(query)
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((w) => w.replace(/^-+|-+$/g, ""))
    .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
  return [...new Set(words)].slice(0, 24);
}

/**
 * Share of the query's keywords found in a text, in [0, 1]. Terms of four or
 * more characters also match inside longer words, so "deploy" finds
 * "deployments" and "speicher" finds "Arbeitsspeicher".
 */
export function keywordCoverage(terms: string[], text: string): number {
  if (terms.length === 0) return 0;
  const folded = fold(text);
  const tokens = new Set(folded.split(/[^\p{L}\p{N}_-]+/u));
  let hit = 0;
  for (const t of terms) if (t.length >= 4 ? folded.includes(t) : tokens.has(t)) hit++;
  return hit / terms.length;
}

// ----------------------------------------------------------- confidence

/** Cosine (bge-m3) below which a result counts as unrelated, and where it counts as clearly related. */
export const SIMILARITY_FLOOR = 0.4;
export const SIMILARITY_CLEAR = 0.7;
/** MemX-style abstention: without any keyword match, the best result needs at least this cosine. */
export const ABSTAIN_SIMILARITY = 0.5;

/**
 * Confidence in [0, 1] that a result is relevant to the query. Semantic
 * similarity and keyword coverage are combined like independent evidence, so a
 * keyword match lifts a weak semantic hit and either signal alone can carry a
 * clear match. `similarity` is null when no embedding is available.
 */
export function confidence(similarity: number | null, coverage: number): number {
  const semantic = similarity === null ? 0 : Math.min(1, Math.max(0, (similarity - SIMILARITY_FLOOR) / (SIMILARITY_CLEAR - SIMILARITY_FLOOR)));
  const lexical = Math.min(1, Math.max(0, coverage)) * 0.6;
  const c = 1 - (1 - 0.95 * semantic) * (1 - lexical);
  return Math.round(c * 1000) / 1000;
}

/**
 * True when nothing in the candidates is relevant: no result shares a keyword
 * with the query and the best cosine stays below ABSTAIN_SIMILARITY. Never
 * abstains without similarities (embedding unavailable), so an outage of the
 * embedding model degrades to ordinary recall instead of silence.
 */
export function shouldAbstain(candidates: { similarity: number | null; coverage: number }[]): boolean {
  if (candidates.length === 0) return true;
  if (candidates.every((c) => c.similarity === null)) return false;
  if (candidates.some((c) => c.coverage > 0)) return false;
  return Math.max(...candidates.map((c) => c.similarity ?? 0)) < ABSTAIN_SIMILARITY;
}

// ------------------------------------------------------------ diversity

export interface DiversityCandidate {
  id: string;
  kind: "chunk" | "note";
  episodeId: string | null;
  score?: number;
  vec?: ArrayLike<number> | null;
}

/**
 * Reorders scored candidates for diversity: at most one excerpt per episode
 * (the best one), then maximal marginal relevance on the stored embeddings, so
 * near-identical results do not crowd out the rest. Candidates without an
 * embedding are never penalised. Input must be sorted best first.
 */
export function diversify<T extends DiversityCandidate>(candidates: T[], lambda = 0.75): T[] {
  const seenEpisodes = new Set<string>();
  const pool: T[] = [];
  for (const c of candidates) {
    if (c.kind === "chunk" && c.episodeId) {
      if (seenEpisodes.has(c.episodeId)) continue;
      seenEpisodes.add(c.episodeId);
    }
    pool.push(c);
  }
  const max = Math.max(...pool.map((c) => c.score ?? 0), 1e-9);
  const min = Math.min(...pool.map((c) => c.score ?? 0), 0);
  const relevance = (c: T) => ((c.score ?? 0) - min) / (max - min || 1);
  const out: T[] = [];
  const rest = [...pool];
  while (rest.length) {
    let best = 0;
    let bestValue = -Infinity;
    rest.forEach((c, i) => {
      let redundancy = 0;
      if (c.vec) for (const s of out) if (s.vec) redundancy = Math.max(redundancy, cosine(c.vec, s.vec));
      const value = lambda * relevance(c) - (1 - lambda) * redundancy;
      if (value > bestValue) {
        bestValue = value;
        best = i;
      }
    });
    out.push(rest.splice(best, 1)[0]!);
  }
  return out;
}

// ------------------------------------------------------------ fact keys

/**
 * Files each fact under the excerpt it most likely came from: the closest
 * stored embedding when both sides have one, otherwise the best keyword
 * overlap. Returns the facts per excerpt key; facts that match no excerpt fall
 * back to the first one, since they came from the same episode.
 */
export function assignFactKeys<K>(
  statements: string[],
  vectors: (ArrayLike<number> | undefined)[],
  chunks: { rid: K; content: string; vec: ArrayLike<number> | null }[],
): Map<K, string[]> {
  const out = new Map<K, string[]>();
  if (chunks.length === 0) return out;
  // One measure for all excerpts of a fact: cosine only when every excerpt has an embedding.
  const allEmbedded = chunks.every((c) => c.vec);
  statements.forEach((statement, i) => {
    const v = allEmbedded ? vectors[i] : undefined;
    const terms = keywordTerms(statement);
    let best = chunks[0]!;
    let bestScore = -Infinity;
    for (const c of chunks) {
      const score = v && c.vec ? cosine(v, c.vec) : keywordCoverage(terms, c.content);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }
    const list = out.get(best.rid) ?? [];
    list.push(statement);
    out.set(best.rid, list);
  });
  return out;
}

// ----------------------------------------------------------- turn cards

/** Roles that open a turn in a transcript line "[role] text" (see transcript() in text.ts). */
const TURN_LINE = /^\[(user|assistant|system|tool|developer|human|ai|model|bot|agent|function)\] ?/i;
const USER_ROLES = new Set(["user", "human"]);

/** Conversations whose turns compete for a recall's budget: the best ones by their best excerpt. */
export const CARD_EPISODES = 10;
/** Most turns and notes scored in one recall (one reranker call). */
export const MAX_CARD_UNITS = 200;
/** A user turn is shown up to this length; longer ones are cut into pieces of it, at most MAX_TURN_PIECES. */
export const CARD_TURN_CHARS = 1500;
const MAX_TURN_PIECES = 20;
/** The reranker also sees this much of the reply to a user turn, so a question finds its answer. */
const REPLY_CHARS = 200;
/** Of a reply, one window of two sentences is shown, at most this long. */
const WINDOW_CHARS = 400;
/** The best few units of a recall (WIDE_UNITS) show more of a reply: the window and what follows, up to this length. */
const WIDE_CHARS = 800;
export const WIDE_UNITS = 3;
/** Estimated tokens for a card's header line and for each further turn on it. */
const CARD_TOKENS = 12;
const PART_TOKENS = 2;

export interface Turn {
  role: string;
  content: string;
}

/**
 * Rebuilds an episode's text from its excerpts in stored order. Excerpts of one
 * long passage overlap (chunk() repeats up to `overlap` characters), and the
 * repeat is dropped; excerpts that do not overlap are joined by a line break.
 */
export function joinExcerpts(parts: string[], overlap = 150): string {
  let out = "";
  for (const part of parts) {
    if (!part) continue;
    if (!out) {
      out = part;
      continue;
    }
    out += afterOverlap(out, part, overlap);
  }
  return out;
}

/** The rest of `next` after the longest end of `text`, at most `overlap` long, that it starts with. */
function afterOverlap(text: string, next: string, overlap: number): string {
  const probe = next.slice(0, 24);
  if (probe.length >= 16) {
    for (let at = text.indexOf(probe, Math.max(0, text.length - overlap)); at >= 0; at = text.indexOf(probe, at + 1)) {
      if (next.startsWith(text.slice(at))) return next.slice(text.length - at);
    }
  }
  return `\n${next}`;
}

/**
 * Splits a transcript into its turns. Text before the first role line becomes a
 * turn of role "text"; a text without any role line has no turns.
 */
export function splitTurns(text: string): Turn[] {
  const turns: Turn[] = [];
  let lead: string[] = [];
  for (const line of text.split("\n")) {
    const m = TURN_LINE.exec(line);
    if (m) turns.push({ role: m[1]!.toLowerCase(), content: line.slice(m[0].length) });
    else if (turns.length) turns[turns.length - 1]!.content += `\n${line}`;
    else lead.push(line);
  }
  if (!turns.length) return [];
  const before = lead.join("\n").trim();
  return before ? [{ role: "text", content: before }, ...turns] : turns;
}

/** Sentences and lines of a text. The number of a numbered list item ("1. ") stays with its item. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])(?<!(?:^|\n)[ \t]*\d{1,3}\.)\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Windows of two sentences each (lines count as sentences), at most WINDOW_CHARS long. */
export function sentenceWindows(text: string): string[] {
  const all = sentences(text);
  const out: string[] = [];
  for (let i = 0; i < all.length; i += 2) out.push(all.slice(i, i + 2).join(" ").slice(0, WINDOW_CHARS));
  return out;
}

/** Window `index` of sentenceWindows() and the sentences after it, up to `max` characters. */
export function wideWindow(text: string, index: number, max = WIDE_CHARS): { text: string; last: boolean } {
  const all = sentences(text);
  let end = Math.min(all.length, index * 2 + 2);
  let out = all.slice(index * 2, end).join(" ");
  while (end < all.length && out.length + 1 + all[end]!.length <= max) out += ` ${all[end++]}`;
  return { text: out.slice(0, max), last: end >= all.length && out.length <= max };
}

/** One candidate piece of a turn card: a user turn (or a piece of a long one), or one window of a reply. */
export interface CardUnit {
  /** The card it belongs to: its episode. */
  key: string;
  /** Position on the card. */
  order: number;
  /** What the card shows. */
  text: string;
  /** What the reranker scores. */
  rank: string;
  /** For a window of a reply: more of it, shown when the unit is among the best WIDE_UNITS. */
  wide?: string;
}

const coverage = (terms: string[][], text: string) => Math.max(0, ...terms.map((t) => keywordCoverage(t, text)));

/**
 * The units of one conversation. A user turn is a unit of its own (pieces of
 * CARD_TURN_CHARS when longer) and is scored together with the start of its
 * reply; of every other turn, the window of two sentences that shares the most
 * keywords with the query (the first one on a tie).
 */
export function turnUnits(key: string, turns: Turn[], terms: string[][]): CardUnit[] {
  const out: CardUnit[] = [];
  turns.forEach((t, i) => {
    const body = t.content.trim();
    if (!body) return;
    if (USER_ROLES.has(t.role) || t.role === "text") {
      const next = turns[i + 1];
      const reply = next && !USER_ROLES.has(next.role) ? ` [${next.role}] ${next.content.trim().slice(0, REPLY_CHARS)}` : "";
      const pieces = body.length <= CARD_TURN_CHARS ? [body] : chunk(body.slice(0, CARD_TURN_CHARS * MAX_TURN_PIECES), CARD_TURN_CHARS, 100).slice(0, MAX_TURN_PIECES);
      const head = t.role === "text" ? "" : `[${t.role}] `;
      pieces.forEach((p, j) => {
        const text = `${head}${j > 0 ? "… " : ""}${p}${j < pieces.length - 1 ? " …" : ""}`;
        out.push({ key, order: i * 1000 + j, text, rank: text + reply });
      });
      return;
    }
    const windows = sentenceWindows(body);
    if (!windows.length) return;
    let best = 0;
    let bestCoverage = -1;
    windows.forEach((w, j) => {
      const c = coverage(terms, w);
      if (c > bestCoverage) {
        bestCoverage = c;
        best = j;
      }
    });
    const text = `[${t.role}] ${best > 0 ? "… " : ""}${windows[best]}${best < windows.length - 1 ? " …" : ""}`;
    const wide = wideWindow(body, best);
    const unit: CardUnit = { key, order: i * 1000 + best, text, rank: text };
    if (wide.text.length > windows[best]!.length) unit.wide = `[${t.role}] ${best > 0 ? "… " : ""}${wide.text}${wide.last ? "" : " …"}`;
    out.push(unit);
  });
  return out;
}

/** Score of a unit: the reranker's score against the best unit's, and the share of the query's keywords it holds. */
export function unitScore(rerank: number, maxRerank: number, terms: string[][], text: string): number {
  return 0.7 * (rerank / (maxRerank || 1e-9)) + 0.3 * coverage(terms, text);
}

/**
 * Picks units best first until the token budget is spent, with at most
 * `maxCards` cards (a unit's key is its card). There is no cap per card and no
 * floor relative to the best unit: a conversation can bring several turns, and a
 * question spread over many conversations still gets all of them. The best
 * WIDE_UNITS units show their wider text when they have one and it fits. The
 * first unit is always taken. Returns the picked units, best first, with the
 * text they show.
 */
export function fillCards<T extends { key: string; text: string; score: number; wide?: string }>(units: T[], budget: number, maxCards: number): T[] {
  const order = [...units].sort((a, b) => b.score - a.score);
  const open = new Set<string>();
  const out: T[] = [];
  let used = 0;
  for (const u of order) {
    const fresh = !open.has(u.key);
    if (fresh && open.size >= maxCards) continue;
    const wide = u.wide && out.length < WIDE_UNITS && used + cardCost(u.wide, fresh) <= budget ? u.wide : undefined;
    const text = wide ?? u.text;
    const cost = cardCost(text, fresh);
    if (used + cost > budget && out.length > 0) continue;
    used += cost;
    open.add(u.key);
    out.push(wide ? { ...u, text } : u);
  }
  return out;
}

/** Estimated tokens a unit adds: its text, and a header when it opens a card. */
export function cardCost(text: string, opensCard: boolean): number {
  return estimateTokens(text) + (opensCard ? CARD_TOKENS : PART_TOKENS);
}

/**
 * Shares `room` reranker slots among the conversations, best conversation first,
 * so one very long conversation cannot crowd out the others. A conversation that
 * needs less than its share leaves the rest to the others. When a conversation
 * gets fewer slots than it has units, it keeps the units with the highest
 * `priority`, in their order on the card.
 */
export function shareUnits<T>(groups: T[][], room: number, priority: (unit: T, group: number) => number): T[] {
  const take = groups.map(() => 0);
  let left = Math.max(0, room);
  let open = groups.map((_, i) => i).filter((i) => groups[i]!.length > 0);
  while (left > 0 && open.length) {
    const share = Math.max(1, Math.floor(left / open.length));
    for (const i of open) {
      if (left === 0) break;
      const add = Math.min(share, groups[i]!.length - take[i]!, left);
      take[i]! += add;
      left -= add;
    }
    open = open.filter((i) => take[i]! < groups[i]!.length);
  }
  return groups.flatMap((g, i) =>
    g.length <= take[i]!
      ? g
      : g
          .map((u, j) => ({ u, j, p: priority(u, i) }))
          .sort((a, b) => b.p - a.p || a.j - b.j)
          .slice(0, take[i])
          .sort((a, b) => a.j - b.j)
          .map((x) => x.u),
  );
}

/**
 * How much a unit deserves a reranker slot when its conversation is too long for
 * all of them: it is part of the conversation's best excerpt (1), plus the share
 * of the query's keywords it holds.
 */
export function unitPriority(unit: Pick<CardUnit, "text">, lead: string, terms: string[][]): number {
  const body = unit.text.replace(/^\[[^\]\n]{1,32}\] /, "").replace(/^… /, "").replace(/ …$/, "").slice(0, 200);
  return (body && lead.includes(body) ? 1 : 0) + coverage(terms, unit.text);
}
