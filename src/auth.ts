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
      WHERE k.hash = ? AND k.revoked_at IS NULL AND c.revoked_at IS NULL
        AND (k.expires_at IS NULL OR k.expires_at > ?)`,
  )
    .bind(hash, Date.now())
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

/** Optional label and expiry (epoch ms) for a new key. */
export interface KeyOptions {
  label?: string | null;
  expiresAt?: number | null;
}

/** Accepts epoch ms or an ISO date. Must lie in the future. */
export function parseExpiresAt(v: unknown, now = Date.now()): number | null {
  if (v === undefined || v === null || v === "") return null;
  const ms = typeof v === "number" ? v : typeof v === "string" ? Date.parse(v) : Number.NaN;
  if (!Number.isFinite(ms)) throw new Error("expiresAt must be epoch milliseconds or an ISO date");
  if (ms <= now) throw new Error("expiresAt must be in the future");
  return Math.floor(ms);
}

function keyRow(env: Env, key: string, hash: string, clientId: string, now: number, opts: KeyOptions = {}) {
  return env.CONTROL_DB.prepare(
    "INSERT INTO api_keys (hash, prefix, client_id, created_at, label, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(hash, key.slice(0, 10), clientId, now, opts.label ?? null, opts.expiresAt ?? null);
}

/** Issues an additional key for an existing client. The plain key is returned once. */
export async function createKey(env: Env, clientId: string, opts: KeyOptions = {}) {
  const client = await env.CONTROL_DB.prepare("SELECT id FROM clients WHERE id = ? AND revoked_at IS NULL").bind(clientId).first();
  if (!client) throw new Error("unknown client");
  const key = newSecret(KEY_PREFIX);
  const now = Date.now();
  await keyRow(env, key, await sha256Hex(key), clientId, now, opts).run();
  return { apiKey: key, prefix: key.slice(0, 10), label: opts.label ?? null, expiresAt: opts.expiresAt ?? null };
}

export async function listKeys(env: Env, clientId: string) {
  const { results } = await env.CONTROL_DB.prepare(
    "SELECT prefix, label, created_at, expires_at, last_used_at, revoked_at FROM api_keys WHERE client_id = ? ORDER BY created_at",
  )
    .bind(clientId)
    .all();
  return results;
}

/** Revokes the keys of a client that start with `prefix` (the first 10 characters shown in lists). */
export async function revokeKey(env: Env, clientId: string, prefix: string) {
  const r = await env.CONTROL_DB.prepare("UPDATE api_keys SET revoked_at = ? WHERE client_id = ? AND prefix = ? AND revoked_at IS NULL")
    .bind(Date.now(), clientId, prefix)
    .run();
  return r.meta.changes ?? 0;
}

export async function createClient(
  env: Env,
  input: { userId: string; name: string; agent: string; provider: string; grants?: Grants } & KeyOptions,
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
    keyRow(env, key, await sha256Hex(key), id, now, input),
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
