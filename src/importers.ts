// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Turns memory files of other agents into notes:
//   claude-md   CLAUDE.md and similar instruction files (AGENTS.md, GEMINI.md)
//   hermes      Hermes Agent MEMORY.md / USER.md, entries separated by a line with "§"
//   markdown    any other Markdown list or prose
//   chatgpt     the list ChatGPT and Gemini keep under "Saved memories" / "Saved info"
// Each bullet or paragraph becomes one note. A heading is kept as context, so
// "- run npm test" under "## Testing" becomes "Testing: run npm test".

export type ImportFormat = "claude-md" | "hermes" | "markdown" | "chatgpt" | "gemini";
export const IMPORT_FORMATS: ImportFormat[] = ["claude-md", "hermes", "markdown", "chatgpt", "gemini"];

export const MAX_IMPORT_CHARS = 200_000;
export const MAX_IMPORT_ENTRIES = 500;
const MAX_ENTRY_CHARS = 2000;
const MIN_ENTRY_CHARS = 8;

const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/;
const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const FENCE = /^\s*(```|~~~)/;
const DATE = /^(?:\d{4}-\d{2}-\d{2}|\d{1,2}[/.]\d{1,2}[/.]\d{2,4}|\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4})\s*[-–—:,]*\s*/;

/** Splits a memory file into note texts, in file order, without duplicates. */
export function parseMemoryFile(content: string, format: ImportFormat): string[] {
  const text = content.replace(/\r\n?/g, "\n").slice(0, MAX_IMPORT_CHARS);
  const entries =
    format === "hermes" && /^\s*§\s*$/m.test(text)
      ? hermesEntries(text)
      : format === "chatgpt" || format === "gemini"
        ? memoryListEntries(text)
        : markdownEntries(text);
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of entries) {
    const entry = clean(raw);
    if (entry.length < MIN_ENTRY_CHARS || seen.has(entry.toLowerCase())) continue;
    seen.add(entry.toLowerCase());
    out.push(entry.length > MAX_ENTRY_CHARS ? `${entry.slice(0, MAX_ENTRY_CHARS - 1)}…` : entry);
    if (out.length >= MAX_IMPORT_ENTRIES) break;
  }
  return out;
}

function hermesEntries(text: string): string[] {
  return text.split(/^\s*§\s*$/m).map((e) => e.trim());
}

/** One memory per line, with its bullet and any date stamp in front of it removed. */
function memoryListEntries(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(BULLET, "").replace(DATE, ""))
    .filter((line) => line.trim().length > 0);
}

function markdownEntries(text: string): string[] {
  const out: string[] = [];
  const headings: string[] = [];
  let current: string[] = [];
  let inFence = false;

  const flush = () => {
    const body = current.join("\n").trim();
    current = [];
    if (!body) return;
    // The top heading is usually the file title ("CLAUDE.md", "Memory"), so it adds nothing.
    const context = headings.slice(1).filter(Boolean).join(" / ");
    out.push(context ? `${context}: ${body}` : body);
  };

  for (const line of text.split("\n")) {
    if (FENCE.test(line)) {
      inFence = !inFence;
      current.push(line);
      continue;
    }
    if (inFence) {
      current.push(line);
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      const level = h[1]!.length;
      headings.length = level;
      headings[level - 1] = h[2]!.trim();
      for (let i = 0; i < level - 1; i++) headings[i] ??= "";
      continue;
    }
    if (BULLET.test(line) && leadingSpaces(line) < 2) {
      flush();
      current.push(line.replace(BULLET, ""));
      continue;
    }
    if (!line.trim()) {
      // A blank line ends the current entry.
      flush();
      continue;
    }
    current.push(BULLET.test(line) ? `; ${line.replace(BULLET, "").trim()}` : line.trim());
  }
  flush();
  return out;
}

function leadingSpaces(line: string): number {
  return line.length - line.trimStart().length;
}

function clean(s: string): string {
  const lines = s.split("\n");
  const fenced = lines.some((l) => FENCE.test(l));
  // Prose collapses to one line; code blocks keep their line breaks.
  return (fenced ? lines.map((l) => l.trimEnd()).join("\n") : lines.map((l) => l.trim()).join(" ")).replace(/ ; /g, "; ").replace(/([.!?:]); /g, "$1 ").replace(/[ \t]{2,}/g, " ").trim();
}
