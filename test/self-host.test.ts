// SPDX-License-Identifier: AGPL-3.0-or-later
// Self-hosting without Cloudflare: the password and proxy sign-ins, and the
// Node stand-ins for D1, Durable Objects, R2, Vectorize and Workers AI.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createSession, identify, ipAllowed, sessionKey, setPeerAddress, signInProblem, verifySession } from "../src/identity";
import worker from "../src/index";
import { MemoryObject } from "../src/memory-object";
import type { Client } from "../src/scopes";
import { LocalAi } from "../src/node/ai";
import { LocalBucket } from "../src/node/blobs";
import { LocalD1 } from "../src/node/d1";
import { LocalNamespace } from "../src/node/durable";
import { LocalVectorIndex } from "../src/node/vectors";
import { embedText, fakeEnv } from "./support/fake-do";

const HOST = "https://memory.example.com";
const SECRET = "s".repeat(32);
const MIGRATIONS = fileURLToPath(new URL("../migrations/", import.meta.url).href);
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rhizome-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("sessions", () => {
  it("round-trips, expires and rejects tampering", async () => {
    const t = await createSession(SECRET, "me@example.com", 1_000);
    expect(await verifySession(SECRET, t, 2_000)).toBe("me@example.com");
    expect(await verifySession("x".repeat(32), t, 2_000)).toBeNull();
    expect(await verifySession(SECRET, t, 1_000 + 8 * 86_400_000)).toBeNull();
    const [, exp, nonce, mac] = t.split(".");
    const other = btoa("evil@example.com").replace(/=+$/, "");
    expect(await verifySession(SECRET, `${other}.${exp}.${nonce}.${mac}`, 2_000)).toBeNull();
  });

  it("names what a sign-in mode is missing", () => {
    expect(signInProblem({} as never)).toMatch(/Cloudflare Access/);
    expect(signInProblem({ AUTH_MODE: "password", LOGIN_EMAIL: "a@b.c", LOGIN_PASSWORD: "short", SESSION_SECRET: SECRET } as never)).toMatch(/12 characters/);
    expect(signInProblem({ AUTH_MODE: "password", LOGIN_EMAIL: "a@b.c", LOGIN_PASSWORD: "long enough pw", SESSION_SECRET: "short" } as never)).toMatch(/SESSION_SECRET/);
    // Proxy mode without proof that requests passed the proxy stays off.
    expect(signInProblem({ AUTH_MODE: "proxy", PROXY_AUTH_HEADER: "remote-email", SESSION_SECRET: SECRET } as never)).toMatch(/PROXY_AUTH_SECRET/);
    expect(signInProblem({ AUTH_MODE: "proxy", PROXY_AUTH_HEADER: "remote-email", SESSION_SECRET: SECRET, PROXY_AUTH_SECRET: "short" } as never)).toMatch(/32 characters/);
    expect(signInProblem({ AUTH_MODE: "proxy", PROXY_AUTH_HEADER: "remote-email", SESSION_SECRET: SECRET, PROXY_AUTH_SECRET: SECRET } as never)).toBeNull();
    expect(signInProblem({ AUTH_MODE: "proxy", PROXY_AUTH_HEADER: "remote-email", SESSION_SECRET: SECRET, PROXY_TRUSTED_IPS: "127.0.0.1" } as never)).toBeNull();
  });

  it("refuses a spoofed proxy header without a secret, even with the email header set", async () => {
    const env = { AUTH_MODE: "proxy", PROXY_AUTH_HEADER: "Remote-Email", SESSION_SECRET: SECRET } as never;
    expect(await identify(env, new Request(HOST, { headers: { "remote-email": "anyone@example.com" } }))).toBeNull();
  });

  it("trusts the proxy header from trusted socket addresses only", async () => {
    const env = { AUTH_MODE: "proxy", PROXY_AUTH_HEADER: "Remote-Email", PROXY_TRUSTED_IPS: "::1, 172.18.0.0/16", SESSION_SECRET: SECRET } as never;
    const from = (peer: string | null, h: Record<string, string> = {}) => {
      const r = new Request(HOST, { headers: { "remote-email": "me@example.com", ...h } });
      if (peer) setPeerAddress(r, peer);
      return identify(env, r);
    };
    expect((await from("::ffff:172.18.3.4"))?.email).toBe("me@example.com");
    expect((await from("::1"))?.email).toBe("me@example.com");
    expect(await from("172.19.0.1")).toBeNull();
    expect(await from(null, { "x-forwarded-for": "172.18.0.2", "cf-connecting-ip": "172.18.0.2" })).toBeNull(); // headers don't count
    expect(ipAllowed("10.1.2.3", ["10.0.0.0/8"])).toBe(true);
    expect(ipAllowed("11.1.2.3", ["10.0.0.0/8"])).toBe(false);
  });

  it("trusts the proxy header only with the shared secret when one is set", async () => {
    const env = { AUTH_MODE: "proxy", PROXY_AUTH_HEADER: "Remote-Email", PROXY_AUTH_SECRET: "proxy-secret".padEnd(32, "x"), SESSION_SECRET: SECRET } as never;
    const req = (h: Record<string, string>) => new Request(HOST, { headers: h });
    expect(await identify(env, req({ "remote-email": "Me@Example.com" }))).toBeNull();
    expect(await identify(env, req({ "remote-email": "Me@Example.com", "x-rhizome-proxy-secret": "proxy-secret" }))).toBeNull();
    const id = await identify(env, req({ "remote-email": "Me@Example.com", "x-rhizome-proxy-secret": "proxy-secret".padEnd(32, "x") }));
    expect(id?.email).toBe("me@example.com");
    expect(id?.key).toMatch(/^[0-9a-f]{64}$/);
    expect(await identify(env, req({ "remote-email": "not an email", "x-rhizome-proxy-secret": "proxy-secret".padEnd(32, "x") }))).toBeNull();
  });
});

describe("password sign-in", () => {
  let control: LocalD1;
  let env: Record<string, unknown>;
  const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(HOST + path, init), env as never, ctx);
  const login = (email: string, password: string, next = "/") =>
    call("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "same-origin" },
      body: new URLSearchParams({ email, password, next }).toString(),
    });

  beforeEach(() => {
    control = new LocalD1(join(dir, "control.sqlite"));
    control.migrate(MIGRATIONS);
    const fake = fakeEnv(() => "{}");
    const memory = new LocalNamespace(join(dir, "memory"), MemoryObject, () => env as never);
    env = { ...fake.env, CONTROL_DB: control, MEMORY: memory, AUTH_MODE: "password", LOGIN_EMAIL: "me@example.com", LOGIN_PASSWORD: "correct horse battery", SESSION_SECRET: SECRET, EXTRACTION: "off" };
  });
  afterEach(() => control.db.close());

  it("signs in, creates the person on first sign-in and opens the explorer", async () => {
    expect((await call("/auth/login")).status).toBe(200);
    const anon = await call("/ui/api/me");
    expect(anon.status).toBe(401);
    expect(await anon.json()).toMatchObject({ signIn: "/auth/login" });

    expect((await login("me@example.com", "wrong password!")).status).toBe(401);
    expect((await login("other@example.com", "correct horse battery")).status).toBe(401);
    const ok = await login("Me@Example.com", "correct horse battery", "//evil.example/x");
    expect(ok.status).toBe(303);
    expect(ok.headers.get("location")).toBe("/"); // no open redirect
    const cookie = ok.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly; SameSite=Lax/);
    expect(cookie).toContain("Secure");

    const me = await call("/ui/api/me", { headers: { cookie: cookie.split(";")[0]! } });
    expect(await me.json()).toMatchObject({ email: "me@example.com", linked: true, signOut: "/auth/logout" });
    expect((control.db.prepare("SELECT email FROM users").all() as unknown[]).length).toBe(1);
    await login("me@example.com", "correct horse battery");
    expect((control.db.prepare("SELECT email FROM users").all() as unknown[]).length).toBe(1);

    // A new password signs existing sessions out.
    env.LOGIN_PASSWORD = "another long password";
    expect((await call("/ui/api/me", { headers: { cookie: cookie.split(";")[0]! } })).status).toBe(401);
  });

  it("signs the session for the configured email only", async () => {
    const forged = await createSession(sessionKey(env as never), "other@example.com");
    expect((await call("/ui/api/me", { headers: { cookie: `rz_session=${forged}` } })).status).toBe(401);
  });

  it("limits sign-in attempts with its own limiter", async () => {
    let n = 0;
    env.LOGIN_RATE_LIMITER = { limit: async () => ({ success: ++n <= 2 }) };
    await login("me@example.com", "wrong password!");
    await login("me@example.com", "wrong password!");
    expect((await login("me@example.com", "correct horse battery")).status).toBe(429);
  });

  it("refuses cross-site sign-ins and sends the OAuth consent through sign-in", async () => {
    const cross = await call("/auth/login", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", "sec-fetch-site": "cross-site" },
      body: new URLSearchParams({ email: "me@example.com", password: "correct horse battery" }).toString(),
    });
    expect(cross.status).toBe(403);

    const reg = (await (
      await call("/oauth/register", { method: "POST", body: JSON.stringify({ client_name: "Claude", redirect_uris: ["https://claude.ai/cb"] }) })
    ).json()) as { client_id: string };
    const q = new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: "https://claude.ai/cb", code_challenge: "c".repeat(43), code_challenge_method: "S256" });
    const res = await call(`/oauth/authorize?${q}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(`/auth/login?next=${encodeURIComponent(`/oauth/authorize?${q}`)}`);

    const cookie = (await login("me@example.com", "correct horse battery")).headers.get("set-cookie")!.split(";")[0]!;
    const consent = await call(`/oauth/authorize?${q}`, { headers: { cookie } });
    expect(consent.status).toBe(200);
    expect(await consent.text()).toContain("Connect Claude?");
  });

  it("is off in the default Access mode", async () => {
    env.AUTH_MODE = undefined;
    expect((await call("/auth/login")).status).toBe(404);
  });
});

describe("Node bindings", () => {
  it("D1: migrates once, binds, batches atomically", async () => {
    const d1 = new LocalD1(join(dir, "c.sqlite"));
    expect(d1.migrate(MIGRATIONS).length).toBeGreaterThan(0);
    expect(d1.migrate(MIGRATIONS)).toEqual([]);
    await d1.prepare("INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)").bind("u1", "A", 1).run();
    expect(await d1.prepare("SELECT name FROM users WHERE id = ?").bind("u1").first("name")).toBe("A");
    await expect(
      d1.batch([d1.prepare("INSERT INTO users (id, name, created_at) VALUES ('u2', 'B', 1)"), d1.prepare("INSERT INTO users (id, name, created_at) VALUES ('u1', 'dup', 1)")]),
    ).rejects.toThrow();
    expect((await d1.prepare("SELECT id FROM users").all()).results).toHaveLength(1);
    d1.db.close();
  });

  it("R2: stores files and refuses keys outside its folder", async () => {
    const b = new LocalBucket(join(dir, "blobs"));
    await b.put("u1/e1.json", JSON.stringify({ a: 1 }));
    expect(await (await b.get("u1/e1.json"))!.json()).toEqual({ a: 1 });
    expect(await b.get("missing")).toBeNull();
    await expect(b.put("../escape", "x")).rejects.toThrow(/invalid/);
    await b.delete("u1/e1.json");
    expect(await b.get("u1/e1.json")).toBeNull();
  });

  it("Vectorize: cosine ranking within a namespace and scope filter", async () => {
    const v = new LocalVectorIndex(join(dir, "v.sqlite"));
    await v.upsert([
      { id: "a", values: [1, 0, 0], namespace: "u1", metadata: { scope: "profile", kind: "note" } },
      { id: "b", values: [0.9, 0.1, 0], namespace: "u1", metadata: { scope: "project:x", kind: "note" } },
      { id: "c", values: [1, 0, 0], namespace: "u2", metadata: { scope: "profile", kind: "note" } },
    ]);
    expect((await v.query([1, 0, 0], { topK: 5, namespace: "u1" })).matches.map((m) => m.id)).toEqual(["a", "b"]);
    expect((await v.query([1, 0, 0], { topK: 5, namespace: "u1", filter: { scope: { $in: ["project:x"] } } })).matches.map((m) => m.id)).toEqual(["b"]);
    await v.deleteByIds(["a"]);
    expect((await v.query([1, 0, 0], { namespace: "u1", filter: { scope: "profile" } })).matches).toEqual([]);
    v.close();
  });

  it("Workers AI: maps embeddings, chat and rerank to an OpenAI-compatible server", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      seen.push(new URL(url).pathname);
      const b = JSON.parse(String(init.body)) as { input?: string[]; documents?: string[] };
      if (url.endsWith("/embeddings")) return Response.json({ data: b.input!.map((t, index) => ({ index, embedding: embedText(t) })).reverse() });
      if (url.endsWith("/rerank")) return Response.json({ results: [{ index: 1, relevance_score: 0.9 }] });
      return Response.json({ choices: [{ message: { content: "<think>plan</think>{\"ok\":true}" } }] });
    });
    const ai = new LocalAi({ provider: "openai", baseUrl: "http://ai.local/v1/", rerankUrl: "http://ai.local/v1/rerank" });
    const emb = (await ai.run("bge-m3", { text: ["one", "two"] })) as { data: number[][] };
    expect(emb.data[0]).toEqual(embedText("one"));
    expect(await ai.run("qwen", { messages: [{ role: "user", content: "hi" }] })).toEqual({ response: '{"ok":true}' });
    expect(await ai.run("rr", { query: "q", contexts: [{ text: "a" }, { text: "b" }] })).toEqual({ response: [{ id: 1, score: 0.9 }] });
    expect(seen).toEqual(["/v1/embeddings", "/v1/chat/completions", "/v1/rerank"]);
    await expect(new LocalAi({ provider: "openai", baseUrl: "http://ai.local/v1" }).run("rr", { query: "q", contexts: [] })).rejects.toThrow(/reranker/);
    vi.unstubAllGlobals();
  });

  it("Durable Objects: a MemoryObject on SQLite files keeps its memory across restarts", async () => {
    const fake = fakeEnv(() => "{}");
    const client: Client = { id: "c1", userId: "u1", name: "Claude", agent: "claude", provider: "anthropic", grants: { read: ["profile"], write: ["profile"] } };
    const env = { ...fake.env, EXTRACTION: "off" };
    const first = new LocalNamespace(join(dir, "memory"), MemoryObject, () => env as never);
    const stub = first.get(first.idFromName("user:u1"));
    const { id } = await stub.addNote(client, { scope: "profile", content: "The user prefers tabs over spaces.", kind: "preference" });
    first.close();

    const second = new LocalNamespace(join(dir, "memory"), MemoryObject, () => env as never);
    expect(await second.resumeAll()).toBe(1);
    const res = await second.get(second.idFromName("user:u1")).recall(client, { query: "tabs or spaces", scopes: ["profile"], rerank: false });
    expect(res.items.map((i) => i.id)).toContain(id);
    second.close();
  });
});
