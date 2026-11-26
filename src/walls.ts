// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Walls keep one client's projects apart from another's. A wall is a name and a
// list of project scopes, set by the person in the explorer. Walls are off by
// default: a project outside every wall behaves exactly as without walls.
//
// Rule 1: a walled project is searched only when the call names it. A recall
// that names no project leaves walled projects out and says so.
// Rule 3: a fact from a walled conversation stays in its project. Where it wanted
// to go (usually the profile) is kept as a held promotion until the person
// releases or dismisses it in the explorer.

import { isValidSlug } from "./scopes";

/** Wall name -> its project scopes. */
export type Walls = Record<string, string[]>;

export const WALL_LIMIT = 50;
export const LEFT_OUT_NOTICE = "Walled projects were left out. Name the project to search one.";

export function isValidWallName(name: string): boolean {
  return isValidSlug(name);
}

/** Only projects can be walled: the profile and agent scopes are not one client's. */
export function isWallableScope(scope: string): boolean {
  const [kind, slug, ...rest] = scope.split(":");
  return kind === "project" && rest.length === 0 && slug !== undefined && isValidSlug(slug);
}

export function wallOf(scope: string, walls: Walls): string | null {
  for (const [name, scopes] of Object.entries(walls)) if (scopes.includes(scope)) return name;
  return null;
}

/**
 * Which of the requested scopes a call may search. `named` lists the scopes the
 * call named; undefined means every requested scope was named (explicit scope
 * lists over the REST API, the explorer).
 */
export function admitNamed(scopes: string[], named: string[] | undefined, walls: Walls): { scopes: string[]; notices: string[] } {
  if (named === undefined || Object.keys(walls).length === 0) return { scopes, notices: [] };
  const out = scopes.filter((s) => wallOf(s, walls) === null || named.includes(s));
  return { scopes: out, notices: out.length < scopes.length ? [LEFT_OUT_NOTICE] : [] };
}

/**
 * Rule 3: a fact said in a walled conversation stays inside that wall. Returns the
 * scope the fact wanted to go to when it has to be held instead, else null.
 */
export function heldTarget(episodeScope: string, target: string, walls: Walls): string | null {
  const from = wallOf(episodeScope, walls);
  if (from === null || target === episodeScope || wallOf(target, walls) === from) return null;
  return target;
}
