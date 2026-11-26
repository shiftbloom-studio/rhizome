// SPDX-License-Identifier: AGPL-3.0-or-later
//
// API of the memory explorer (the web UI). Every request comes from a signed-in
// person (see identity.ts); their email address selects the person's memory. The
// explorer acts as the owner and sees every scope, including agents' private ones.

import { Hono } from "hono";
import type { Env } from "./env";
import { authMode, identify, signInHint, signInProblem, signInUrl } from "./identity";
import type { MemoryObject } from "./memory-object";
import { isValidScope, type Client } from "./scopes";

type Explorer = { Bindings: Env; Variables: { client: Client; email: string } };
export const explorer = new Hono<Explorer>();

const json = (c: { json: (b: unknown, s?: number) => Response }, status: number, error: string) => c.json({ error }, status);

explorer.use("*", async (c, next) => {
  const problem = signInProblem(c.env);
  if (problem) return json(c, 404, `the explorer is disabled (${problem})`);
  const identity = await identify(c.env, c.req.raw);
  if (!identity) return c.json({ error: signInHint(c.env).toLowerCase(), signIn: signInUrl(c.env) }, 401);
  // Same-origin JSON only: a cross-site form post cannot set this header.
  if (c.req.method !== "GET" && c.req.header("x-rhizome") !== "1") return json(c, 403, "missing x-rhizome header");
  c.set("email", identity.email);
  const user = await c.env.CONTROL_DB.prepare("SELECT id, name FROM users WHERE email = ?").bind(identity.email).first<{ id: string; name: string }>();
  if (user) {
    c.set("client", {
      id: `web:${user.id}`,
      userId: user.id,
      name: "memory explorer",
      agent: "web",
      provider: "rhizome",
      grants: { read: ["profile", "project:*", "agent:*"], write: ["profile", "project:*", "agent:*"] },
    });
  }
  c.header("cache-control", "no-store");
  await next();
});

function memory(env: Env, client: Client): DurableObjectStub<MemoryObject> {
  return env.MEMORY.get(env.MEMORY.idFromName(`user:${client.userId}`));
}

/** Every scope the person has, discovered from their memory. */
async function allScopes(env: Env, client: Client): Promise<string[]> {
  return (await memory(env, client).scopes(client)).filter(isValidScope);
}

function requested(raw: string | undefined, all: string[]): string[] {
  if (!raw) return all;
  const wanted = new Set(raw.split(",").map((s) => s.trim()));
  return all.filter((s) => wanted.has(s));
}

explorer.get("/me", async (c) => {
  const client = c.get("client") as Client | undefined;
  // A sign-out button only makes sense when rhizome owns the session.
  const signOut = authMode(c.env) === "password" ? "/auth/logout" : null;
  if (!client) return c.json({ email: c.get("email"), linked: false, signOut });
  const stub = memory(c.env, client);
  const [stats, scopes] = await Promise.all([stub.stats(client), stub.scopes(client)]);
  return c.json({ email: c.get("email"), linked: true, userId: client.userId, stats, scopes, signOut });
});

explorer.use("*", async (c, next) => {
  if (!c.get("client")) return json(c, 403, "no memory is linked to this email address");
  await next();
});

explorer.get("/graph", async (c) => {
  const client = c.get("client");
  const scopes = requested(c.req.query("scopes"), await allScopes(c.env, client));
  const limit = Number(c.req.query("limit") ?? 900);
  return c.json(await memory(c.env, client).graph(client, scopes, Number.isFinite(limit) ? limit : 900));
});

explorer.post("/search", async (c) => {
  const client = c.get("client");
  const b = (await c.req.json().catch(() => ({}))) as { query?: unknown; scopes?: unknown; limit?: unknown };
  const query = typeof b.query === "string" ? b.query.trim().slice(0, 2000) : "";
  if (!query) return json(c, 400, "query is required");
  const all = await allScopes(c.env, client);
  const scopes = Array.isArray(b.scopes) && b.scopes.length ? all.filter((s) => (b.scopes as unknown[]).includes(s)) : all;
  const started = Date.now();
  const res = await memory(c.env, client).recall(client, {
    query,
    scopes,
    limit: typeof b.limit === "number" ? Math.min(Math.max(b.limit, 1), 50) : 20,
    budgetTokens: 16_000,
  });
  return c.json({ ...res, scopes, totalMs: Date.now() - started });
});

explorer.get("/items/:id", async (c) => {
  const client = c.get("client");
  const res = await memory(c.env, client).detail(client, c.req.param("id"));
  return res ? c.json(res) : json(c, 404, "not found");
});

explorer.post("/items/:id/confirm", async (c) => {
  const client = c.get("client");
  const res = await memory(c.env, client).confirm(client, c.req.param("id"));
  return res ? c.json(res) : json(c, 404, "not found");
});

explorer.delete("/items/:id", async (c) => {
  const client = c.get("client");
  const res = await memory(c.env, client).forget(client, c.req.param("id"));
  return res.deleted ? c.json(res) : json(c, 404, "not found");
});

explorer.post("/notes", async (c) => {
  const client = c.get("client");
  const b = (await c.req.json().catch(() => ({}))) as { content?: unknown; scope?: unknown; kind?: unknown };
  const content = typeof b.content === "string" ? b.content.trim() : "";
  if (!content || content.length > 8000) return json(c, 400, "content must be 1 to 8000 characters");
  const scope = typeof b.scope === "string" && isValidScope(b.scope) ? b.scope : "profile";
  const kinds = ["preference", "decision", "fact", "learning", "note"] as const;
  const kind = kinds.find((k) => k === b.kind) ?? "note";
  return c.json(await memory(c.env, client).addNote(client, { scope, content, kind, trust: "user_explicit" }), 201);
});

explorer.get("/blocks", async (c) => {
  const client = c.get("client");
  return c.json({ blocks: await memory(c.env, client).listBlocks(client, await allScopes(c.env, client)) });
});

explorer.get("/activity", async (c) => {
  const client = c.get("client");
  return c.json({ activity: await memory(c.env, client).activity(client, Number(c.req.query("limit") ?? 50)) });
});

explorer.post("/reflect", async (c) => {
  const client = c.get("client");
  return c.json(await memory(c.env, client).requestReflection(client), 202);
});

explorer.get("/walls", async (c) => {
  const client = c.get("client");
  return c.json({ walls: await memory(c.env, client).listWalls(client) });
});

explorer.put("/walls/:name", async (c) => {
  const client = c.get("client");
  const b = (await c.req.json().catch(() => ({}))) as { scopes?: unknown };
  if (!Array.isArray(b.scopes) || b.scopes.length > 200 || b.scopes.some((s) => typeof s !== "string")) return json(c, 400, "scopes must be a list of project scopes");
  try {
    return c.json(await memory(c.env, client).setWall(client, c.req.param("name"), b.scopes as string[]));
  } catch (e) {
    const message = e instanceof Error ? e.message : "";
    if (/must be|only projects|already behind|limit is/.test(message)) return json(c, 400, message);
    throw e;
  }
});

explorer.delete("/walls/:name", async (c) => {
  const client = c.get("client");
  try {
    return c.json(await memory(c.env, client).setWall(client, c.req.param("name"), []));
  } catch (e) {
    if (e instanceof Error && /must be/.test(e.message)) return json(c, 400, e.message);
    throw e;
  }
});
