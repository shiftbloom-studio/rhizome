// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Ledger: rhizome remembers which connector was given which memory. When a
// memory it was given is replaced later, or the person deletes it, exactly that
// connector is told once, on its next get_context or recall. Connectors that
// never saw the old version hear nothing.
//
// Only calls from an agent's conversation (MCP) are recorded and corrected. The
// explorer, the REST API and recall as of a past time are left out. Off unless
// LEDGER=on.

/** Corrections for replaced memories told per call; the rest follow on the next call. */
export const MAX_REPLACED = 5;
/** Deleted memories named per call. */
export const MAX_DELETED = 20;
/** Characters of a memory's text quoted in a correction. */
export const QUOTE_CHARS = 240;
/** Rows of corrections already told are dropped after this long. */
export const TOLD_TTL_MS = 30 * 86_400_000;
/** A connector not given a memory again for this long is no longer told when it changes. */
export const UNTOLD_TTL_MS = 365 * 86_400_000;

export function ledgerEnabled(flag: string | undefined): boolean {
  return (flag ?? "").trim().toLowerCase() === "on";
}

export interface Replaced {
  /** The memory the connector was given. */
  id: string;
  oldText: string;
  givenAt: number;
  /** Its current version. */
  newId: string;
  newText: string;
  newScope: string;
  changedAt: number;
}

export interface Deleted {
  id: string;
  givenAt: number;
}

export interface Corrections {
  replaced: Replaced[];
  deleted: Deleted[];
}

/** One step of a memory's version chain, old -> new. */
export interface Step {
  merged: boolean;
}

/**
 * A chain of merges only (duplicates folded into one note) tells the connector
 * nothing new: it already holds that fact. Any real replacement on the way does.
 */
export function needsCorrection(steps: Step[]): boolean {
  return steps.some((s) => !s.merged);
}

const day = (ms: number) => new Date(ms).toISOString().slice(0, 10);

function quote(text: string): string {
  const t = text.replace(/\s+/g, " ").trim();
  return `"${t.length > QUOTE_CHARS ? `${t.slice(0, QUOTE_CHARS - 1)}…` : t}"`;
}

/** The lines an agent reads. Empty when there is nothing to correct. */
export function correctionLines(c: Corrections): string[] {
  const lines: string[] = [];
  for (const r of c.replaced) {
    lines.push(`- You were given ${quote(r.oldText)} on ${day(r.givenAt)}. Since ${day(r.changedAt)} it is: ${quote(r.newText)} [${r.newId}]`);
  }
  if (c.deleted.length) {
    const ids = c.deleted.map((d) => d.id).join(", ");
    lines.push(
      c.deleted.length === 1
        ? `- The person deleted a memory you were given on ${day(c.deleted[0]!.givenAt)} [${ids}]. Do not rely on it.`
        : `- The person deleted ${c.deleted.length} memories you were given earlier [${ids}]. Do not rely on them.`,
    );
  }
  return lines.length ? ["Corrections to memory you were given earlier (told once):", ...lines] : [];
}
