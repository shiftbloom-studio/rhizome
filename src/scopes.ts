// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Scopes partition one person's memory:
//   profile            working style, preferences, values. Shared by every agent.
//   project:<slug>     decisions and conventions of one project.
//   agent:<slug>       private notes of one agent (tool quirks and the like).
//
// A client (one agent of one provider) holds grants: scope patterns it may
// read and write. `agent:self` resolves to the client's own agent scope and
// `project:*` matches every project.

const SLUG = /^[a-z0-9][a-z0-9._-]{0,47}$/;

export type Access = "read" | "write";

export interface Grants {
  read: string[];
  write: string[];
}

export interface Client {
  id: string;
  userId: string;
  name: string;
  agent: string;
  provider: string;
  grants: Grants;
}

export function isValidScope(scope: string): boolean {
  if (scope === "profile") return true;
  const [kind, slug, ...rest] = scope.split(":");
  if (rest.length > 0 || slug === undefined) return false;
  return (kind === "project" || kind === "agent") && SLUG.test(slug);
}

export function isValidSlug(slug: string): boolean {
  return SLUG.test(slug);
}

export function agentScope(agent: string): string {
  return `agent:${agent}`;
}

function patternMatches(pattern: string, scope: string, agent: string): boolean {
  if (pattern === "agent:self") return scope === agentScope(agent);
  if (pattern.endsWith(":*")) return scope.startsWith(pattern.slice(0, -1));
  return pattern === scope;
}

export function can(client: Client, access: Access, scope: string): boolean {
  if (!isValidScope(scope)) return false;
  const patterns = access === "read" ? client.grants.read : client.grants.write;
  return patterns.some((p) => patternMatches(p, scope, client.agent));
}

/**
 * Scopes a recall looks at. Without an explicit list a client sees its profile,
 * its own agent scope and the given project, if any. Scopes the client may not
 * read are dropped silently, so a recall never fails because of one bad scope.
 */
export function recallScopes(client: Client, requested?: string[], project?: string): string[] {
  const wanted = requested?.length
    ? requested
    : ["profile", agentScope(client.agent), ...(project ? [`project:${project}`] : [])];
  return [...new Set(wanted)].filter((s) => can(client, "read", s));
}

export const DEFAULT_GRANTS: Grants = {
  read: ["profile", "project:*", "agent:self"],
  write: ["profile", "project:*", "agent:self"],
};
