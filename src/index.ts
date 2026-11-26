// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Gateway worker: authentication, scope checks and routing to the person's
// MemoryObject. All memory logic lives in the Durable Object.

import { Hono, type Context } from "hono";
import { authenticate, createClient, createKey, createUser, listClients, listKeys, parseExpiresAt, parseGrants, revokeClient, revokeKey, safeEqual, validGrantPattern } from "./auth";
import type { Env } from "./env";
import { ForbiddenError, NOTE_KINDS, TRUST_LEVELS, type NoteKind, type Trust } from "./memory-object";
import { can, isValidScope, isValidSlug, recallScopes, type Client, type Grants } from "./scopes";
import { parseRangeBound } from "./timewindow";
import { explorer } from "./explorer";
import { FAVICON, fontCss, fontFile } from "./fonts";
import { LEGAL_PATHS, legalPage } from "./legal";
import { IMPORT_FORMATS, MAX_IMPORT_CHARS, parseMemoryFile, type ImportFormat } from "./importers";
import { analyticsHost, sendStats, type McpStat } from "./analytics";
import { mcpResponse, rpcError } from "./mcp";
import { cleanupOAuth, oauth, resourceMetadataUrl } from "./oauth";
import { login } from "./login";

export { MemoryObject } from "./memory-object";

const VERSION = "0.3.0";

type App = { Bindings: Env; Variables: { client: Client } };
const app = new Hono<App>();

class HttpError extends Error {
  constructor(public status: 400 | 401 | 403 | 404 | 413 | 429, message: string) {
    super(message);
  }
}

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  if (err instanceof ForbiddenError) return c.json({ error: err.message }, 403);
  if (err instanceof SyntaxError) return c.json({ error: "invalid JSON body" }, 400);
  const message = err instanceof Error ? err.message : String(err);
  // Validation errors thrown inside the Durable Object arrive as plain errors.
  if (/empty|limit is|must be|unknown user|invalid grant/.test(message)) return c.json({ error: message }, 400);
  console.error(err);
  return c.json({ error: "internal error" }, 500);
});

app.get("/v1/health", (c) => c.json({ ok: true, version: VERSION }));

// Public pages: imprint, privacy policy, fonts and icon (bypassed in Cloudflare Access).
for (const [path, kind] of Object.entries(LEGAL_PATHS)) app.get(path, (c) => legalPage(kind, c.env));
app.get("/fonts/fonts.css", (c) => fontCss(c.executionCtx));
app.get("/fonts/:host{fs|gs}/:path{.+}", (c) => fontFile(c.req.param("host"), c.req.param("path")));
app.get("/favicon.svg", () => new Response(FAVICON, { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=604800" } }));

// Memory explorer API, for the signed-in person (Cloudflare Access, password or proxy, see identity.ts).
app.route("/ui/api", explorer);
app.route("/", oauth);
app.route("/", login);

// ---------------------------------------------------------------------- mcp

app.post("/mcp", async (c) => {
  const client = await authenticate(c.env, bearer(c), c.executionCtx);
  if (!client) {
    return new Response(JSON.stringify({ error: "invalid_token", error_description: "missing or invalid access token" }), {
      status: 401,
      headers: {
        "content-type": "application/json",
        "www-authenticate": `Bearer realm="rhizome", resource_metadata="${resourceMetadataUrl(c.req.url)}"`,
      },
    });
  }
  if (c.env.RATE_LIMITER) {
    const { success } = await c.env.RATE_LIMITER.limit({ key: client.id });
    if (!success) return rpcError(null, -32000, "rate limit exceeded", 429);
  }
  const text = await c.req.text();
  if (text.length > 1024 * 1024) return rpcError(null, -32600, "request is larger than 1 MB", 413);
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return rpcError(null, -32700, "parse error");
  }
  const stub = c.env.MEMORY.get(c.env.MEMORY.idFromName(`user:${client.userId}`));
  if (!analyticsHost(c.env)) return mcpResponse(stub, client, raw, VERSION);
  // Anonymous usage analytics (MCP_ANALYTICS=on): sent after the answer, never in its way.
  const stats: McpStat[] = [];
  const res = await mcpResponse(stub, client, raw, VERSION, (s) => stats.push(s));
  if (stats.length) c.executionCtx.waitUntil(sendStats(c.env, stats, client, { serverVersion: VERSION, userAgent: c.req.header("user-agent") }));
  return res;
});
// Stateless server: no server-initiated stream and no sessions to end.
app.on(["GET", "DELETE"], "/mcp", () => new Response(null, { status: 405, headers: { allow: "POST" } }));

// ------------------------------------------------------------------ helpers

function bearer(c: Context<App>): string {
  const h = c.req.header("authorization") ?? "";
  return h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
}

async function body<T>(c: Context<App>, maxBytes = 256 * 1024): Promise<T> {
  const len = Number(c.req.header("content-length") ?? 0);
  if (len > maxBytes) throw new HttpError(413, `body larger than ${maxBytes} bytes`);
  const text = await c.req.text();
  if (text.length > maxBytes) throw new HttpError(413, `body larger than ${maxBytes} bytes`);
  return (text ? JSON.parse(text) : {}) as T;
}

function memory(c: Context<App>) {
  const client = c.get("client");
  return c.env.MEMORY.get(c.env.MEMORY.idFromName(`user:${client.userId}`));
}

function writableScope(client: Client, scope: unknown): string {
  const s = typeof scope === "string" && scope ? scope : "profile";
  if (!isValidScope(s)) throw new HttpError(400, `invalid scope: ${s}`);
  if (!can(client, "write", s)) throw new HttpError(403, `no write access to scope ${s}`);
  return s;
}

function scopeList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const list = raw.split(",").map((s) => s.trim()).filter(Boolean);
  for (const s of list) if (!isValidScope(s)) throw new HttpError(400, `invalid scope: ${s}`);
  return list;
}

function parseTime(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  const t = typeof v === "number" ? v : Date.parse(String(v));
  if (!Number.isFinite(t)) throw new HttpError(400, "invalid timestamp");
  return t;
}

function str(v: unknown, field: string, max: number): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new HttpError(400, `${field} must be a string`);
  if (v.length > max) throw new HttpError(400, `${field} is longer than ${max} characters`);
  return v;
}

// -------------------------------------------------------------------- admin

function expiresAt(v: unknown): number | null {
  try {
    return parseExpiresAt(v);
  } catch (e) {
    throw new HttpError(400, e instanceof Error ? e.message : String(e));
  }
}

const admin = new Hono<App>();
admin.use("*", async (c, next) => {
  const token = c.env.ADMIN_TOKEN;
  if (!token) throw new HttpError(404, "admin API is disabled (no ADMIN_TOKEN set)");
  if (!safeEqual(bearer(c), token)) throw new HttpError(401, "invalid admin token");
  await next();
});

admin.post("/users", async (c) => {
  const b = await body<{ name?: string }>(c);
  const name = str(b.name, "name", 120)?.trim();
  if (!name) throw new HttpError(400, "name is required");
  return c.json(await createUser(c.env, name), 201);
});

admin.post("/clients", async (c) => {
  const b = await body<{ userId?: string; name?: string; agent?: string; provider?: string; grants?: Grants; label?: string; expiresAt?: number | string }>(c);
  if (!b.userId || !b.agent || !b.provider) throw new HttpError(400, "userId, agent and provider are required");
  const grants = b.grants ? parseGrants(JSON.stringify(b.grants)) : undefined;
  if (grants) for (const p of [...grants.read, ...grants.write]) if (!validGrantPattern(p)) throw new HttpError(400, `invalid grant pattern: ${p}`);
  const created = await createClient(c.env, {
    userId: b.userId,
    name: str(b.name, "name", 120) ?? `${b.agent} (${b.provider})`,
    agent: b.agent,
    provider: b.provider,
    grants,
    label: str(b.label, "label", 120)?.trim() || null,
    expiresAt: expiresAt(b.expiresAt),
  });
  return c.json({ ...created, note: "Store the apiKey now. It is not shown again." }, 201);
});

admin.patch("/users/:id", async (c) => {
  const b = await body<{ email?: string | null }>(c);
  const email = b.email === null ? null : str(b.email, "email", 254)?.trim().toLowerCase();
  if (email !== null && (!email || !/^[^@\s]+@[^@\s]+$/.test(email))) throw new HttpError(400, "email must be an email address or null");
  const res = await c.env.CONTROL_DB.prepare("UPDATE users SET email = ? WHERE id = ?").bind(email, c.req.param("id")).run();
  if (!res.meta.changes) throw new HttpError(404, "unknown user");
  return c.json({ id: c.req.param("id"), email });
});

admin.get("/users/:id/clients", async (c) => c.json({ clients: await listClients(c.env, c.req.param("id")) }));

admin.post("/clients/:id/keys", async (c) => {
  const b = await body<{ label?: string; expiresAt?: number | string }>(c);
  try {
    const created = await createKey(c.env, c.req.param("id"), { label: str(b.label, "label", 120)?.trim() || null, expiresAt: expiresAt(b.expiresAt) });
    return c.json({ ...created, note: "Store the apiKey now. It is not shown again." }, 201);
  } catch (e) {
    if (e instanceof Error && e.message === "unknown client") throw new HttpError(404, e.message);
    throw e;
  }
});

admin.get("/clients/:id/keys", async (c) => c.json({ keys: await listKeys(c.env, c.req.param("id")) }));

admin.delete("/clients/:id/keys/:prefix", async (c) => {
  const n = await revokeKey(c.env, c.req.param("id"), c.req.param("prefix"));
  if (!n) throw new HttpError(404, "no active key with this prefix");
  return c.json({ revoked: n });
});

admin.delete("/clients/:id", async (c) => {
  await revokeClient(c.env, c.req.param("id"));
  return c.json({ revoked: true });
});

app.route("/v1/admin", admin);

// ------------------------------------------------------------------- memory

const mem = new Hono<App>();
mem.use("*", async (c, next) => {
  const client = await authenticate(c.env, bearer(c), c.executionCtx);
  if (!client) throw new HttpError(401, "missing or invalid API key");
  if (c.env.RATE_LIMITER) {
    const { success } = await c.env.RATE_LIMITER.limit({ key: client.id });
    if (!success) throw new HttpError(429, "rate limit exceeded");
  }
  c.set("client", client);
  await next();
});

mem.get("/me", (c) => {
  const { id, name, agent, provider, grants } = c.get("client");
  return c.json({ id, name, agent, provider, grants });
});

mem.post("/episodes", async (c) => {
  const client = c.get("client");
  const b = await body<{
    scope?: string; sessionId?: string; model?: string; tEvent?: string | number;
    messages?: { role: string; content: string }[]; text?: string; metadata?: Record<string, unknown>;
  }>(c, 1024 * 1024);
  const scope = writableScope(client, b.scope);
  if (b.messages !== undefined) {
    if (!Array.isArray(b.messages) || b.messages.length > 500) throw new HttpError(400, "messages must be an array of at most 500 items");
    for (const m of b.messages) {
      if (typeof m?.role !== "string" || typeof m?.content !== "string") throw new HttpError(400, "each message needs role and content strings");
    }
  }
  const res = await memory(c).addEpisode(client, {
    scope,
    sessionId: str(b.sessionId, "sessionId", 200),
    model: str(b.model, "model", 200),
    tEvent: parseTime(b.tEvent),
    messages: b.messages?.map((m) => ({ role: m.role.slice(0, 32), content: m.content })),
    text: str(b.text, "text", 500_000),
    metadata: b.metadata,
  });
  return c.json(res, 201);
});

mem.post("/notes", async (c) => {
  const client = c.get("client");
  const b = await body<{ scope?: string; content?: string; kind?: string; trust?: string; model?: string; tEvent?: string | number }>(c);
  const scope = writableScope(client, b.scope);
  const content = str(b.content, "content", 8000)?.trim();
  if (!content) throw new HttpError(400, "content is required");
  if (b.kind && !NOTE_KINDS.includes(b.kind as NoteKind)) throw new HttpError(400, `kind must be one of ${NOTE_KINDS.join(", ")}`);
  if (b.trust && !TRUST_LEVELS.includes(b.trust as Trust)) throw new HttpError(400, `trust must be one of ${TRUST_LEVELS.join(", ")}`);
  const res = await memory(c).addNote(client, {
    scope,
    content,
    kind: b.kind as NoteKind | undefined,
    trust: b.trust as Trust | undefined,
    model: str(b.model, "model", 200),
    tEvent: parseTime(b.tEvent),
  });
  return c.json(res, 201);
});

mem.post("/recall", async (c) => {
  const client = c.get("client");
  const b = await body<{
    query?: string;
    scopes?: string[];
    project?: string;
    limit?: number;
    budgetTokens?: number;
    rerank?: boolean;
    queries?: unknown;
    from?: unknown;
    to?: unknown;
    asOf?: unknown;
    features?: unknown;
  }>(c);
  const query = str(b.query, "query", 2000)?.trim();
  if (!query) throw new HttpError(400, "query is required");
  if (b.project !== undefined && (typeof b.project !== "string" || !isValidSlug(b.project))) throw new HttpError(400, "invalid project");
  if (b.scopes !== undefined && (!Array.isArray(b.scopes) || b.scopes.some((s) => typeof s !== "string" || !isValidScope(s)))) {
    throw new HttpError(400, "scopes must be an array of valid scopes");
  }
  if (b.queries !== undefined && (!Array.isArray(b.queries) || b.queries.length > 4 || b.queries.some((q) => typeof q !== "string" || q.length > 500))) {
    throw new HttpError(400, "queries must be at most 4 strings of up to 500 characters");
  }
  if (b.features !== undefined && (!Array.isArray(b.features) || b.features.length > 10 || b.features.some((f) => typeof f !== "string" || f.length > 32))) {
    throw new HttpError(400, "features must be an array of feature names");
  }
  let from: number | undefined;
  let to: number | undefined;
  let asOf: number | undefined;
  try {
    from = parseRangeBound(b.from, false);
    to = parseRangeBound(b.to, true);
    asOf = parseRangeBound(b.asOf, true);
  } catch {
    throw new HttpError(400, "from, to and asOf must be ISO 8601 dates or times");
  }
  // A date as asOf means the end of that day.
  if (asOf !== undefined && typeof b.asOf === "string" && /^\d{4}-\d{2}-\d{2}$/.test(b.asOf.trim())) asOf -= 1;
  const scopes = recallScopes(client, b.scopes, b.project);
  const res = await memory(c).recall(client, {
    query,
    scopes,
    limit: typeof b.limit === "number" ? b.limit : undefined,
    budgetTokens: typeof b.budgetTokens === "number" ? Math.min(Math.max(b.budgetTokens, 100), 16_000) : undefined,
    rerank: b.rerank,
    queries: b.queries as string[] | undefined,
    from,
    to,
    asOf,
    features: b.features as string[] | undefined,
  });
  return c.json({ ...res, scopes });
});

mem.get("/context", async (c) => {
  const client = c.get("client");
  const project = c.req.query("project");
  if (project !== undefined && !isValidSlug(project)) throw new HttpError(400, "invalid project");
  const scopes = recallScopes(client, scopeList(c.req.query("scopes")), project);
  const budget = Number(c.req.query("budget") ?? 1500);
  const res = await memory(c).context(client, scopes, Number.isFinite(budget) ? Math.min(Math.max(budget, 100), 16_000) : 1500);
  c.header("ETag", `"${res.version}"`);
  if (c.req.header("if-none-match") === `"${res.version}"`) return c.body(null, 304);
  return c.json({ ...res, scopes });
});

mem.get("/blocks", async (c) => {
  const client = c.get("client");
  const scopes = recallScopes(client, scopeList(c.req.query("scopes")), c.req.query("project"));
  return c.json({ blocks: await memory(c).listBlocks(client, scopes) });
});

mem.put("/blocks/:label", async (c) => {
  const client = c.get("client");
  const label = c.req.param("label");
  if (!isValidSlug(label)) throw new HttpError(400, "label must be a lowercase slug, e.g. working-style");
  const b = await body<{ scope?: string; value?: string; description?: string; charLimit?: number }>(c);
  const scope = writableScope(client, b.scope);
  const value = str(b.value, "value", 20_000);
  if (value === undefined) throw new HttpError(400, "value is required");
  const charLimit = b.charLimit === undefined ? undefined : Number(b.charLimit);
  if (charLimit !== undefined && (!Number.isInteger(charLimit) || charLimit < 100 || charLimit > 20_000)) {
    throw new HttpError(400, "charLimit must be an integer between 100 and 20000");
  }
  return c.json(await memory(c).putBlock(client, { scope, label, value, description: str(b.description, "description", 500), charLimit }));
});

mem.get("/episodes", async (c) => {
  const client = c.get("client");
  const scopes = recallScopes(client, scopeList(c.req.query("scopes")), c.req.query("project"));
  const cursor = c.req.query("cursor");
  return c.json(await memory(c).listEpisodes(client, scopes, cursor ? Number(cursor) : undefined, Number(c.req.query("limit") ?? 50)));
});

mem.get("/episodes/:id", async (c) => {
  const ep = await memory(c).getEpisode(c.get("client"), c.req.param("id"));
  if (!ep) throw new HttpError(404, "episode not found");
  return c.json(ep);
});

mem.delete("/items/:id", async (c) => {
  const res = await memory(c).forget(c.get("client"), c.req.param("id"));
  if (res.deleted === 0) throw new HttpError(404, "nothing found with this id");
  return c.json(res);
});

mem.get("/export", async (c) => {
  const client = c.get("client");
  if (!client.grants.read.includes("project:*") || !can(client, "read", "profile")) {
    throw new HttpError(403, "export needs read access to profile and all projects");
  }
  return c.json(await memory(c).exportPage(client, c.req.query("after") ?? "", Number(c.req.query("limit") ?? 500)));
});

mem.post("/import", async (c) => {
  const client = c.get("client");
  const b = await body<{ content?: string; format?: string; scope?: string; kind?: string; trust?: string; fileName?: string }>(c, MAX_IMPORT_CHARS * 2);
  const content = str(b.content, "content", MAX_IMPORT_CHARS);
  if (!content?.trim()) throw new HttpError(400, "content is required");
  const format = (b.format ?? "markdown") as ImportFormat;
  if (!IMPORT_FORMATS.includes(format)) throw new HttpError(400, `format must be one of ${IMPORT_FORMATS.join(", ")}`);
  if (b.kind && !NOTE_KINDS.includes(b.kind as NoteKind)) throw new HttpError(400, `kind must be one of ${NOTE_KINDS.join(", ")}`);
  if (b.trust && !TRUST_LEVELS.includes(b.trust as Trust)) throw new HttpError(400, `trust must be one of ${TRUST_LEVELS.join(", ")}`);
  const scope = writableScope(client, b.scope);
  const notes = parseMemoryFile(content, format);
  if (!notes.length) throw new HttpError(400, "found nothing to import");
  const res = await memory(c).importNotes(client, {
    scope,
    notes,
    kind: b.kind as NoteKind | undefined,
    trust: (b.trust as Trust | undefined) ?? (format === "hermes" ? "agent_inference" : "user_confirmed"),
    source: str(b.fileName, "fileName", 200) ?? format,
  });
  return c.json({ scope, added: res.added, skipped: res.skipped }, 201);
});

mem.get("/stats", async (c) => c.json(await memory(c).stats(c.get("client"))));

app.route("/v1/memory", mem);

app.notFound(async (c) => {
  // Everything else is the explorer's single-page app.
  const api = ["/v1/", "/ui/api/", "/oauth/", "/.well-known/", "/auth/"].some((p) => c.req.path.startsWith(p));
  if (c.env.ASSETS && c.req.method === "GET" && !api) {
    return c.env.ASSETS.fetch(c.req.raw);
  }
  return c.json({ error: "not found" }, 404);
});

export default {
  fetch: app.fetch,
  /** Nightly reflection for every person: consolidation, decay, profile distillation. */
  async scheduled(_event: ScheduledController, env: Env, ctx: ExecutionContext) {
    const { results } = await env.CONTROL_DB.prepare("SELECT id FROM users").all<{ id: string }>();
    ctx.waitUntil(
      Promise.allSettled([
        ...results.map((u) => env.MEMORY.get(env.MEMORY.idFromName(`user:${u.id}`)).requestReflection()),
        cleanupOAuth(env),
      ]),
    );
  },
} satisfies ExportedHandler<Env>;
