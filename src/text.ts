// SPDX-License-Identifier: AGPL-3.0-or-later

/** Rough token estimate (about 4 characters per token for mixed English/German text). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/**
 * Splits text into chunks of at most `max` characters, preferring paragraph,
 * then sentence, then word boundaries. Chunks overlap by `overlap` characters
 * so a fact that straddles a boundary is still found.
 */
export function chunk(text: string, max = 1200, overlap = 150): string[] {
  const clean = text.replace(/\r\n/g, "\n").trim();
  if (clean.length <= max) return clean ? [clean] : [];
  const out: string[] = [];
  let start = 0;
  while (start < clean.length) {
    let end = Math.min(start + max, clean.length);
    if (end < clean.length) {
      const window = clean.slice(start, end);
      const cut = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf(". "), window.lastIndexOf("\n"));
      if (cut > max * 0.5) end = start + cut + 1;
      else {
        const space = window.lastIndexOf(" ");
        if (space > max * 0.5) end = start + space;
      }
    }
    out.push(clean.slice(start, end).trim());
    if (end >= clean.length) break;
    start = Math.max(end - overlap, start + 1);
  }
  return out.filter(Boolean);
}

/**
 * Turns free text into a safe FTS5 MATCH expression: every word becomes a
 * quoted term, terms are OR-ed and the last one also matches as a prefix.
 * Returns null when nothing searchable is left.
 */
export function ftsQuery(input: string): string | null {
  const words = input
    .toLowerCase()
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((w) => w.replace(/^-+|-+$/g, ""))
    .filter((w) => w.length > 1)
    .slice(0, 24);
  if (words.length === 0) return null;
  const terms = [...new Set(words)].map((w) => `"${w.replace(/"/g, "")}"`);
  const last = terms.length - 1;
  terms[last] = `${terms[last]}*`;
  return terms.join(" OR ");
}

/** Reciprocal rank fusion over ranked id lists. Higher score = better. */
export function rrf(lists: string[][], k = 60): Map<string, number> {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, rank) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + rank + 1)));
  }
  return scores;
}

/** Flattens chat messages into one transcript string. */
export function transcript(messages: { role: string; content: string }[]): string {
  return messages.map((m) => `[${m.role}] ${m.content}`).join("\n");
}
