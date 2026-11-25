// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Env } from "./env";
import { newId, newSecret, sha256Hex } from "./ids";
import { DEFAULT_GRANTS, isValidScope, isValidSlug, type Client, type Grants } from "./scopes";

export const KEY_PREFIX = "rz_";

/** Resolves a bearer key to its client, or null. Updates last_used_at at most once a minute. */
export async function authenticate(env: Env, key: string, ctx?: { waitUntil(p: Promise<unknown>): void }): Promise<Client | null> {
  if (!key.startsWith(KEY_PREFIX)) return null;
  const hash = await sha256Hex(key);
  const row = await env.CONTROL_DB.prepare(
    `SELECT c.id, c.user_id, c.name, c.agent, c.provider, c.grants, k.last_used_at
       FROM api_keys k JOIN clients c ON c.id = k.client_id
      WHERE k.hash = ? AND k.revoked_at IS NULL AND c.revoked_at IS NULL`,
  )
    .bind(hash)
    .first<{ id: string; user_id: string; name: string; agent: string; provider: string; grants: string; last_used_at: number | null }>();
  if (!row) return null;
  const now = Date.now();
  if (!row.last_used_at || now - row.last_used_at > 60_000) {
    const touch = env.CONTROL_DB.prepare("UPDATE api_keys SET last_used_at = ? WHERE hash = ?").bind(now, hash).run();
    if (ctx) ctx.waitUntil(touch);
    else await touch;
  }
  return { id: row.id, userId: row.user_id, name: row.name, agent: row.agent, provider: row.provider, grants: parseGrants(row.grants) };
}

export function parseGrants(json: string): Grants {
  try {
    const g = JSON.parse(json) as Partial<Grants>;
    return { read: Array.isArray(g.read) ? g.read : [], write: Array.isArray(g.write) ? g.write : [] };
  } catch {
    return { read: [], write: [] };
  }
}

export function validGrantPattern(p: string): boolean {
  return p === "agent:self" || p === "project:*" || p === "agent:*" || isValidScope(p);
}

/** Constant-time string comparison for the admin token. */
export function safeEqual(a: string, b: string): boolean {
  const x = new TextEncoder().encode(a);
  const y = new TextEncoder().encode(b);
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0);
  return diff === 0;
}

export async function createUser(env: Env, name: string) {
  const id = newId();
  await env.CONTROL_DB.prepare("INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)").bind(id, name, Date.now()).run();
  return { id, name };
}

export async function createClient(
  env: Env,
  input: { userId: string; name: string; agent: string; provider: string; grants?: Grants },
) {
  if (!isValidSlug(input.agent)) throw new Error("agent must be a lowercase slug, e.g. claude-code");
  if (!isValidSlug(input.provider)) throw new Error("provider must be a lowercase slug, e.g. anthropic");
  const grants = input.grants ?? DEFAULT_GRANTS;
  for (const p of [...grants.read, ...grants.write]) if (!validGrantPattern(p)) throw new Error(`invalid grant pattern: ${p}`);
  const user = await env.CONTROL_DB.prepare("SELECT id FROM users WHERE id = ?").bind(input.userId).first();
  if (!user) throw new Error("unknown user");
  const id = newId();
  const key = newSecret(KEY_PREFIX);
  const now = Date.now();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare(
      "INSERT INTO clients (id, user_id, name, agent, provider, grants, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(id, input.userId, input.name, input.agent, input.provider, JSON.stringify(grants), now),
    env.CONTROL_DB.prepare("INSERT INTO api_keys (hash, prefix, client_id, created_at) VALUES (?, ?, ?, ?)").bind(
      await sha256Hex(key),
      key.slice(0, 10),
      id,
      now,
    ),
  ]);
  return { client: { id, userId: input.userId, name: input.name, agent: input.agent, provider: input.provider, grants }, apiKey: key };
}

export async function revokeClient(env: Env, clientId: string) {
  const now = Date.now();
  await env.CONTROL_DB.batch([
    env.CONTROL_DB.prepare("UPDATE clients SET revoked_at = ? WHERE id = ?").bind(now, clientId),
    env.CONTROL_DB.prepare("UPDATE api_keys SET revoked_at = ? WHERE client_id = ? AND revoked_at IS NULL").bind(now, clientId),
  ]);
}

export async function listClients(env: Env, userId: string) {
  const { results } = await env.CONTROL_DB.prepare(
    "SELECT id, name, agent, provider, grants, created_at, revoked_at FROM clients WHERE user_id = ? ORDER BY created_at",
  )
    .bind(userId)
    .all<{ id: string; name: string; agent: string; provider: string; grants: string; created_at: number; revoked_at: number | null }>();
  return results.map((r) => ({ ...r, grants: parseGrants(r.grants) }));
}
