// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Open loops: things an agent was asked to come back to. A loop is a short text in
// one scope with an optional due time. Like a note's validity (valid_from), the due
// time says from when the loop applies: before it the loop stays quiet, from it on
// get_context leads with a short "Due now" section until an agent closes the loop.
// A loop without a due time is due the next time its scope is loaded.
//
// Due is decided when context is read, so nothing runs on the due date itself and
// no model is called. On by default; OPEN_LOOPS=off turns them off (src/flags.ts).

/** Loop ids carry a prefix, so forget can tell them from notes and episodes. */
export const LOOP_PREFIX = "loop_";
/** Open loops per person. Closing one frees a slot. */
export const MAX_OPEN_LOOPS = 200;
export const MAX_LOOP_CHARS = 500;
export const MAX_OUTCOME_CHARS = 500;
/** Loops shown in one context; the rest are counted. */
export const DUE_SHOWN = 5;
/** Characters of a loop's text shown in context. */
export const DUE_LINE_CHARS = 200;

/** Latest due time that can be stored and shown: the end of the year 9999, UTC. */
export const MAX_DUE_AT = Date.UTC(9999, 11, 31, 23, 59, 59, 999);

/** A due time in ms that Date can render (0 up to MAX_DUE_AT). */
export function isValidDue(dueAt: number): boolean {
  return Number.isFinite(dueAt) && dueAt >= 0 && dueAt <= MAX_DUE_AT;
}

export function loopsEnabled(env: { OPEN_LOOPS?: string }): boolean {
  return env.OPEN_LOOPS === "on";
}

export function isLoopId(id: string): boolean {
  return id.startsWith(LOOP_PREFIX);
}

export interface DueLoop {
  id: string;
  scope: string;
  content: string;
  dueAt: number | null;
}

/** The "Due now" section of get_context, or "" when nothing is due. */
export function dueSection(loops: DueLoop[], total: number): string {
  if (!loops.length) return "";
  const lines = loops.map((l) => {
    const text = l.content.length > DUE_LINE_CHARS ? `${l.content.slice(0, DUE_LINE_CHARS - 1)}…` : l.content;
    const when = l.dueAt === null ? "next time" : new Date(l.dueAt).toISOString().slice(0, 10);
    return `- [${l.id}] (${l.scope} · ${when}) ${text}`;
  });
  if (total > loops.length) lines.push(`- and ${total - loops.length} more`);
  return `## Due now (close_loop once handled)\n${lines.join("\n")}`;
}
