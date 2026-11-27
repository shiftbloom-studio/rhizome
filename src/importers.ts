// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Turns memory files of other agents into notes:
//   claude-md   CLAUDE.md and similar instruction files (AGENTS.md, GEMINI.md)
//   hermes      Hermes Agent MEMORY.md / USER.md, entries separated by a line with "§"
//   markdown    any other Markdown list or prose
// Each bullet or paragraph becomes one note. A heading is kept as context, so
// "- run npm test" under "## Testing" becomes "Testing: run npm test".

import { trimEndChars } from "./text";

export type ImportFormat = "claude-md" | "hermes" | "markdown";
export const IMPORT_FORMATS: ImportFormat[] = ["claude-md", "hermes", "markdown"];

export const MAX_IMPORT_CHARS = 200_000;
export const MAX_IMPORT_ENTRIES = 500;
const MAX_ENTRY_CHARS = 2000;
const MIN_ENTRY_CHARS = 8;

const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?/;
// The closing "#"s of a heading are stripped in headingText, not here: a regex for them backtracks on long lines.
const HEADING = /^(#{1,6})\s(.*)$/;
const FENCE = /^\s*(```|~~~)/;

/** Splits a memory file into note texts, in file order, without duplicates. */
export function parseMemoryFile(content: string, format: ImportFormat): string[] {
  const text = content.replace(/\r\n?/g, "\n").slice(0, MAX_IMPORT_CHARS);
  const entries = format === "hermes" && text.split("\n").some(isHermesSeparator) ? hermesEntries(text) : markdownEntries(text);
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
  const entries: string[] = [];
  let current: string[] = [];
  for (const line of text.split("\n")) {
    if (isHermesSeparator(line)) {
      entries.push(current.join("\n").trim());
      current = [];
    } else current.push(line);
  }
  entries.push(current.join("\n").trim());
  return entries;
}

/** A line that holds only "§", with optional whitespace around it. */
function isHermesSeparator(line: string): boolean {
  return line.trim() === "§";
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
      headings[level - 1] = headingText(h[2]!);
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

/** A heading's text without trailing whitespace and closing "#"s, like "Title ##". */
function headingText(raw: string): string {
  return trimEndChars(raw.trimEnd(), "#").trim();
}
