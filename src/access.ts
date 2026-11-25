// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Verifies the Cloudflare Access JWT on requests to the memory explorer.
// Access already blocks unauthenticated visitors at the edge; checking the
// token here as well means a misconfigured Access app never exposes memory.

export interface AccessIdentity {
  email: string;
  sub: string;
}

interface Jwk extends JsonWebKey {
  kid: string;
}

let cache: { team: string; keys: Map<string, CryptoKey>; at: number } | null = null;

async function keys(team: string, refresh = false): Promise<Map<string, CryptoKey>> {
  const age = cache && cache.team === team ? Date.now() - cache.at : Infinity;
  // A forced refresh (unknown kid after a key rotation) is allowed at most once a minute.
  if (cache && age < (refresh ? 60_000 : 3_600_000)) return cache.keys;
  const res = await fetch(`https://${team}/cdn-cgi/access/certs`);
  if (!res.ok) throw new Error(`Access certs: HTTP ${res.status}`);
  const body = (await res.json()) as { keys: Jwk[] };
  const map = new Map<string, CryptoKey>();
  for (const k of body.keys) {
    map.set(k.kid, await crypto.subtle.importKey("jwk", k, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
  }
  cache = { team, keys: map, at: Date.now() };
  return map;
}

function b64url(input: string): Uint8Array {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const bin = atob(input.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodePart<T>(part: string): T {
  return JSON.parse(new TextDecoder().decode(b64url(part))) as T;
}

/** Returns the identity when the token is valid for this application, otherwise null. */
export async function verifyAccess(token: string | undefined, team: string, aud: string, now = Date.now()): Promise<AccessIdentity | null> {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  let header: { alg?: string; kid?: string };
  let payload: { aud?: string | string[]; iss?: string; exp?: number; nbf?: number; email?: string; sub?: string };
  try {
    header = decodePart(h);
    payload = decodePart(p);
  } catch {
    return null;
  }
  if (header.alg !== "RS256" || !header.kid) return null;
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (!auds.includes(aud)) return null;
  if (payload.iss !== `https://${team}`) return null;
  const seconds = now / 1000;
  if (!payload.exp || payload.exp < seconds - 30) return null;
  if (payload.nbf && payload.nbf > seconds + 30) return null;
  const key = (await keys(team)).get(header.kid) ?? (await keys(team, true)).get(header.kid);
  if (!key) return null;
  const ok = await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, b64url(s), new TextEncoder().encode(`${h}.${p}`));
  if (!ok || !payload.email) return null;
  return { email: payload.email.toLowerCase(), sub: payload.sub ?? "" };
}
