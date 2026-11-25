// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Who is the person in the browser? The memory explorer and the OAuth consent
// page need a signed-in person, matched to a user by email address. Three ways
// to sign in, chosen with AUTH_MODE:
//
//   access    Cloudflare Access in front of the app (default). The Access JWT is verified here too.
//   password  Built-in sign-in with LOGIN_EMAIL and LOGIN_PASSWORD, kept in a signed cookie.
//   proxy     A reverse proxy you run (Authelia, oauth2-proxy, Tailscale, ...) sets a header with the email,
//             plus a shared secret header (or, on Node, it connects from PROXY_TRUSTED_IPS).
//
// Agents never use this: they authenticate with API keys or OAuth tokens.

import { verifyAccess } from "./access";
import { safeEqual } from "./auth";
import type { Env } from "./env";

export type AuthMode = "access" | "password" | "proxy";

export interface Identity {
  email: string;
  /**
   * A value only this sign-in knows (the Access JWT, the session cookie, or a
   * server secret bound to the email). Keys the consent page's CSRF token.
   */
  key: string;
}

export const SESSION_COOKIE = "rz_session";
export const SESSION_TTL = 7 * 86_400_000;

export function authMode(env: Env): AuthMode {
  const m = (env.AUTH_MODE ?? "").trim().toLowerCase();
  return m === "password" || m === "proxy" ? m : "access";
}

/** Null when the configured sign-in is complete, otherwise what is missing. */
export function signInProblem(env: Env): string | null {
  switch (authMode(env)) {
    case "access":
      return env.ACCESS_AUD && env.ACCESS_TEAM_DOMAIN ? null : "no Cloudflare Access configured (ACCESS_AUD, ACCESS_TEAM_DOMAIN)";
    case "password":
      if (!env.LOGIN_EMAIL || !env.LOGIN_PASSWORD) return "AUTH_MODE=password needs LOGIN_EMAIL and LOGIN_PASSWORD";
      if (env.LOGIN_PASSWORD.length < 12) return "LOGIN_PASSWORD must be at least 12 characters";
      if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) return "AUTH_MODE=password needs a SESSION_SECRET of at least 32 characters";
      return null;
    case "proxy":
      if (!env.PROXY_AUTH_HEADER) return "AUTH_MODE=proxy needs PROXY_AUTH_HEADER";
      if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) return "AUTH_MODE=proxy needs a SESSION_SECRET of at least 32 characters";
      // Without proof that the request passed the proxy, anyone could send the email header.
      if (env.PROXY_AUTH_SECRET) return env.PROXY_AUTH_SECRET.length < 32 ? "PROXY_AUTH_SECRET must be at least 32 characters" : null;
      if (!trustedRanges(env.PROXY_TRUSTED_IPS).length) return "AUTH_MODE=proxy needs PROXY_AUTH_SECRET, or PROXY_TRUSTED_IPS on Node";
      return null;
  }
}

/** Where a signed-out browser should go, or null when sign-in happens in front of the app. */
export function signInUrl(env: Env, next?: string): string | null {
  if (authMode(env) !== "password") return null;
  return next ? `/auth/login?next=${encodeURIComponent(next)}` : "/auth/login";
}

/** One sentence for pages that need a signed-in person. */
export function signInHint(env: Env): string {
  switch (authMode(env)) {
    case "access":
      return "Sign in through Cloudflare Access with the email address linked to your memory";
    case "password":
      return "Sign in with the email address linked to your memory";
    case "proxy":
      return "Sign in through your sign-in proxy with the email address linked to your memory";
  }
}

export async function identify(env: Env, req: Request): Promise<Identity | null> {
  if (signInProblem(env)) return null;
  switch (authMode(env)) {
    case "access": {
      const jwt = req.headers.get("cf-access-jwt-assertion") ?? undefined;
      const id = await verifyAccess(jwt, env.ACCESS_TEAM_DOMAIN!, env.ACCESS_AUD!);
      return id && jwt ? { email: id.email, key: jwt } : null;
    }
    case "password": {
      const token = cookie(req, SESSION_COOKIE);
      const email = token ? await verifySession(sessionKey(env), token) : null;
      return email && token && email === env.LOGIN_EMAIL!.trim().toLowerCase() ? { email, key: token } : null;
    }
    case "proxy": {
      if (env.PROXY_AUTH_SECRET) {
        if (!safeEqual(req.headers.get("x-rhizome-proxy-secret") ?? "", env.PROXY_AUTH_SECRET)) return null;
      } else {
        // Only the Node server records the socket address; on Workers this is never set, so it fails closed.
        const peer = peers.get(req);
        if (!peer || !ipAllowed(peer, trustedRanges(env.PROXY_TRUSTED_IPS))) return null;
      }
      const email = (req.headers.get(env.PROXY_AUTH_HEADER!) ?? "").trim().toLowerCase();
      if (!/^[^@\s]+@[^@\s]+$/.test(email) || email.length > 254) return null;
      return { email, key: await hmacHex(env.SESSION_SECRET!, `proxy\n${email}`) };
    }
  }
}

// ------------------------------------------------------- proxy peer address

const peers = new WeakMap<Request, string>();

/** Called by the Node server with the TCP peer of each request. Headers can't fake it. */
export function setPeerAddress(req: Request, address: string): void {
  peers.set(req, address);
}

function ipv4(ip: string): number | null {
  const m = /^(?:::ffff:)?(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/i.exec(ip.trim());
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  if (parts.some((p) => p > 255)) return null;
  return ((parts[0]! << 24) | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!) >>> 0;
}

/** PROXY_TRUSTED_IPS: comma-separated addresses and IPv4 ranges, e.g. "127.0.0.1, ::1, 172.18.0.0/16". */
export function trustedRanges(raw: string | undefined): string[] {
  return (raw ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}

export function ipAllowed(ip: string, ranges: string[]): boolean {
  const v4 = ipv4(ip);
  for (const r of ranges) {
    const [base, bits] = r.split("/");
    if (bits === undefined) {
      if (r.toLowerCase() === ip.toLowerCase() || (v4 !== null && ipv4(r) === v4)) return true;
      continue;
    }
    const b = ipv4(base!);
    const n = Number(bits);
    if (v4 === null || b === null || !Number.isInteger(n) || n < 0 || n > 32) continue;
    const mask = n === 0 ? 0 : (~0 << (32 - n)) >>> 0;
    if (((v4 & mask) >>> 0) === ((b & mask) >>> 0)) return true;
  }
  return false;
}

// ------------------------------------------------------------------ sessions

/** Changing LOGIN_EMAIL, LOGIN_PASSWORD or SESSION_SECRET signs every session out. */
export function sessionKey(env: Env): string {
  return `${env.SESSION_SECRET}\n${(env.LOGIN_EMAIL ?? "").trim().toLowerCase()}\n${env.LOGIN_PASSWORD}`;
}

function b64url(text: string): string {
  return btoa(String.fromCharCode(...new TextEncoder().encode(text))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(input: string): string {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const bin = atob(input.replace(/-/g, "+").replace(/_/g, "/") + pad);
  return new TextDecoder().decode(Uint8Array.from(bin, (ch) => ch.charCodeAt(0)));
}

export async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(message)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Compares the SHA-256 of both values, so neither content nor length leaks through timing. */
export async function safeEqualHashed(a: string, b: string): Promise<boolean> {
  const h = async (v: string) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(v)))].join(",");
  return safeEqual(await h(a), await h(b));
}

/** `<email>.<expiry>.<nonce>.<hmac>`. The nonce makes every sign-in's token (and so its CSRF key) unique. */
export async function createSession(secret: string, email: string, now = Date.now()): Promise<string> {
  const nonce = [...crypto.getRandomValues(new Uint8Array(12))].map((b) => b.toString(16).padStart(2, "0")).join("");
  const body = `${b64url(email)}.${now + SESSION_TTL}.${nonce}`;
  return `${body}.${await hmacHex(secret, `session\n${body}`)}`;
}

export async function verifySession(secret: string, token: string, now = Date.now()): Promise<string | null> {
  const parts = token.split(".");
  if (parts.length !== 4) return null;
  const [email, exp, nonce, mac] = parts as [string, string, string, string];
  if (!/^\d+$/.test(exp) || Number(exp) < now || !/^[0-9a-f]{24}$/.test(nonce)) return null;
  if (!safeEqual(mac, await hmacHex(secret, `session\n${email}.${exp}.${nonce}`))) return null;
  try {
    return unb64url(email).toLowerCase();
  } catch {
    return null;
  }
}

export function cookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}
