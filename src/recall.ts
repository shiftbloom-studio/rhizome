// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pure helpers for recall: confidence per result, abstention, diversity (one hit
// per episode plus MMR) and the switches that turn these steps on. Deterministic
// and unit tested; the Durable Object wires them to storage.

import { cosine } from "./intel";

/**
 * Optional recall steps. Each one is off unless the request or the
 * RECALL_FEATURES variable turns it on, so default recall stays as it was until
 * a benchmark shows the step helps.
 * - abstain: return nothing when no result is relevant enough.
 * - diversity: at most one excerpt per episode, then MMR on the stored embeddings.
 * - evidence: a note brings its best source excerpt when the token budget allows.
 * - time: English and German time expressions in the query become a time window.
 * - keys: excerpts are also found through the facts extracted from them.
 */
export const RECALL_FEATURES = ["abstain", "diversity", "evidence", "time", "keys"] as const;
export type RecallFeature = (typeof RECALL_FEATURES)[number];

/** Parses a comma list such as "abstain,diversity" or "all". Unknown names are ignored. */
export function parseFeatures(value: string | string[] | undefined | null): Set<RecallFeature> {
  const list = Array.isArray(value) ? value : (value ?? "").split(",");
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
