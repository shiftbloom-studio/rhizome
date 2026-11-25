// SPDX-License-Identifier: AGPL-3.0-or-later
// The whole connector flow through the Worker: discovery, dynamic registration,
// consent behind Access, code exchange with PKCE, refresh rotation, MCP tool calls
// with the issued token, revocation and the import endpoint.
import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/access", () => ({
  verifyAccess: async (jwt: string | undefined) => (jwt === "good-jwt" ? { email: "person@example.com", sub: "s1" } : null),
}));

import worker from "../src/index";
import { MemoryObject } from "../src/memory-object";
import { fakeD1 } from "./support/fake-d1";
import { fakeEnv, fakeState } from "./support/fake-do";

const HOST = "https://memory.example.com";
const REDIRECT = "https://claude.ai/api/mcp/auth_callback";

let env: Record<string, unknown>;
let d1: ReturnType<typeof fakeD1>;

beforeEach(() => {
  d1 = fakeD1();
  d1.db.exec("INSERT INTO users (id, name, created_at, email) VALUES ('u1', 'Person', 0, 'person@example.com')");
  const fake = fakeEnv(() => JSON.stringify({ facts: [], entities: [] }));
  const s = fakeState();
  const mo = new MemoryObject(s.state as never, { ...fake.env, EXTRACTION: "off" } as never);
  env = {
    ...fake.env,
    CONTROL_DB: d1.binding,
    ACCESS_AUD: "aud",
    ACCESS_TEAM_DOMAIN: "team.example.com",
    MEMORY: { idFromName: (n: string) => n, get: () => mo },
  };
});

const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const call = (path: string, init: RequestInit = {}) => worker.fetch(new Request(HOST + path, init), env as never, ctx);
const form = (o: Record<string, string>) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(o).toString(),
});
const b64url = (b: Buffer) => b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

async function connect() {
  const reg = await call("/oauth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [REDIRECT], token_endpoint_auth_method: "none" }),
  });
  expect(reg.status).toBe(201);
  const { client_id } = (await reg.json()) as { client_id: string };
  const verifier = b64url(Buffer.from("v".repeat(48)));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  const q = new URLSearchParams({ response_type: "code", client_id, redirect_uri: REDIRECT, state: "xyz", code_challenge: challenge, code_challenge_method: "S256", scope: "memory", resource: `${HOST}/mcp` });

  const consent = await call(`/oauth/authorize?${q}`, { headers: { "cf-access-jwt-assertion": "good-jwt" } });
  expect(consent.status).toBe(200);
  const html = await consent.text();
  expect(html).toContain("Connect Claude?");
  expect(html).toContain('value="claude"');
  expect(html).toContain('value="anthropic"');
  expect(consent.headers.get("content-security-policy")).toContain("form-action 'self' https://claude.ai");

  const consentToken = /name="consent" value="([^"]+)"/.exec(html)![1]!;
  const fields = { client_id, redirect_uri: REDIRECT, state: "xyz", code_challenge: challenge, resource: `${HOST}/mcp`, agent: "claude", provider: "anthropic", decision: "allow" };
  const post = (extra: Record<string, string>, headers: Record<string, string> = {}) =>
    call("/oauth/authorize", {
      ...form({ ...fields, ...extra }),
      // Browsers send Origin: null here when the page came through the Access sign-in redirects.
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-access-jwt-assertion": "good-jwt", origin: "null", "sec-fetch-site": "same-origin", ...headers },
    });
  expect((await post({})).status).toBe(403); // no consent token
  expect((await post({ consent: consentToken.replace(/.$/, (ch) => (ch === "0" ? "1" : "0")) })).status).toBe(403);
  expect((await post({ consent: consentToken, state: "other" })).status).toBe(403); // token bound to the request
  expect((await post({ consent: consentToken }, { "sec-fetch-site": "cross-site" })).status).toBe(403);
  const approve = await post({ consent: consentToken });
  expect(approve.status).toBe(302);
  const back = new URL(approve.headers.get("location")!);
  expect(back.origin + back.pathname).toBe(REDIRECT);
  expect(back.searchParams.get("state")).toBe("xyz");
  const code = back.searchParams.get("code")!;

  const tok = await call("/oauth/token", form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id, redirect_uri: REDIRECT }));
  expect(tok.status).toBe(200);
  const tokens = (await tok.json()) as { access_token: string; refresh_token: string; expires_in: number };
  expect(tokens.expires_in).toBe(3600);
  return { client_id, code, verifier, ...tokens };
}

const rpc = (token: string, method: string, params: Record<string, unknown> = {}, id: number | null = 1) =>
  call("/mcp", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params }),
  });
const tool = async (token: string, name: string, args: Record<string, unknown>) =>
  ((await (await rpc(token, "tools/call", { name, arguments: args })).json()) as { result: { content: { text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> } }).result;

describe("MCP discovery", () => {
  it("answers 401 with the resource metadata pointer and serves both metadata documents", async () => {
    const res = await call("/mcp", { method: "POST", body: "{}" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain(`resource_metadata="${HOST}/.well-known/oauth-protected-resource/mcp"`);
    const pr = (await (await call("/.well-known/oauth-protected-resource/mcp")).json()) as { resource: string; authorization_servers: string[] };
    expect(pr).toMatchObject({ resource: `${HOST}/mcp`, authorization_servers: [HOST] });
    const as = (await (await call("/.well-known/oauth-authorization-server")).json()) as Record<string, unknown>;
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.registration_endpoint).toBe(`${HOST}/oauth/register`);
    expect((await call("/mcp")).status).toBe(405);
  });
});

describe("OAuth", () => {
  it("connects, refreshes with rotation and refuses reused codes and refresh tokens", async () => {
    const t = await connect();
    const again = await call("/oauth/token", form({ grant_type: "authorization_code", code: t.code, code_verifier: t.verifier, client_id: t.client_id }));
    expect(again.status).toBe(400);

    const r1 = await call("/oauth/token", form({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: t.client_id }));
    expect(r1.status).toBe(200);
    const fresh = (await r1.json()) as { access_token: string; refresh_token: string };
    expect(fresh.refresh_token).not.toBe(t.refresh_token);
    const stale = await call("/oauth/token", form({ grant_type: "refresh_token", refresh_token: t.refresh_token, client_id: t.client_id }));
    expect(stale.status).toBe(400);

    const client = d1.db.prepare("SELECT agent, provider, grants FROM clients").all();
    expect(client).toHaveLength(1);
    expect(client[0]).toMatchObject({ agent: "claude", provider: "anthropic" });

    // Revoking the refresh token ends the connection and its access tokens.
    await call("/oauth/revoke", form({ token: fresh.refresh_token, client_id: t.client_id }));
    expect((await rpc(fresh.access_token, "ping")).status).toBe(401);
  });

  it("refuses a consent without Access, a cross-site approval, a wrong verifier and an unregistered redirect", async () => {
    const reg = (await (await call("/oauth/register", { method: "POST", body: JSON.stringify({ client_name: "Evil", redirect_uris: ["https://evil.example/cb"] }) })).json()) as { client_id: string };
    const q = (extra: Record<string, string> = {}) =>
      new URLSearchParams({ response_type: "code", client_id: reg.client_id, redirect_uri: "https://evil.example/cb", code_challenge: "a".repeat(43), code_challenge_method: "S256", ...extra });
    expect((await call(`/oauth/authorize?${q()}`)).status).toBe(401);
    const page = await (await call(`/oauth/authorize?${q()}`, { headers: { "cf-access-jwt-assertion": "good-jwt" } })).text();
    expect(page).toContain("rhizome does not know this address");
    expect((await call(`/oauth/authorize?${q({ redirect_uri: "https://other.example/cb" })}`, { headers: { "cf-access-jwt-assertion": "good-jwt" } })).status).toBe(400);
    const plain = await call(`/oauth/authorize?${q({ code_challenge_method: "plain" })}`, { headers: { "cf-access-jwt-assertion": "good-jwt" } });
    expect(new URL(plain.headers.get("location")!).searchParams.get("error")).toBe("invalid_request");
    const lookalike = await call(`/oauth/authorize?${q({ resource: `${HOST}.evil.example/mcp` })}`, { headers: { "cf-access-jwt-assertion": "good-jwt" } });
    expect(new URL(lookalike.headers.get("location")!).searchParams.get("error")).toBe("invalid_target");

    const crossSite = await call("/oauth/authorize", {
      ...form({ client_id: reg.client_id, redirect_uri: "https://evil.example/cb", code_challenge: "a".repeat(43), agent: "x", provider: "y", decision: "allow" }),
      headers: { "content-type": "application/x-www-form-urlencoded", "cf-access-jwt-assertion": "good-jwt", origin: "https://evil.example", "sec-fetch-site": "cross-site" },
    });
    expect(crossSite.status).toBe(403);
    expect(d1.db.prepare("SELECT count(*) AS n FROM oauth_grants").get()).toEqual({ n: 0 });

    const t = await connect();
    const wrong = await call("/oauth/token", form({ grant_type: "authorization_code", code: t.code, code_verifier: "w".repeat(43), client_id: t.client_id }));
    expect(wrong.status).toBe(400);
    expect((await call("/oauth/register", { method: "POST", body: JSON.stringify({ redirect_uris: ["javascript:alert(1)"] }) })).status).toBe(400);
    expect((await call("/oauth/register", { method: "POST", body: JSON.stringify({ redirect_uris: ["http://evil.example/cb"] }) })).status).toBe(400);
  });
});

describe("MCP tools", () => {
  it("initializes, lists tools and remembers, recalls, imports and forgets", async () => {
    const { access_token: token } = await connect();
    const init = (await (await rpc(token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } })).json()) as { result: { protocolVersion: string; serverInfo: { name: string } } };
    expect(init.result.protocolVersion).toBe("2025-06-18");
    expect(init.result.serverInfo.name).toBe("rhizome");
    expect((await rpc(token, "notifications/initialized", {}, null)).status).toBe(202);
    const list = (await (await rpc(token, "tools/list")).json()) as { result: { tools: { name: string }[] } };
    expect(list.result.tools.map((t) => t.name)).toEqual(["get_context", "recall", "remember", "save_conversation", "import_memory_file", "forget"]);

    const saved = await tool(token, "remember", { content: "The person deploys everything with Workers Builds.", kind: "decision", project: "rhizome", said_by_user: true });
    expect(saved.isError).toBeUndefined();
    expect(saved.structuredContent).toMatchObject({ scope: "project:rhizome" });

    const imported = await tool(token, "import_memory_file", { content: "# CLAUDE.md\n## Style\n- Replies stay short.\n- Lead with the result.", format: "claude-md" });
    expect(imported.content[0]!.text).toBe("Imported 2 notes into profile, skipped 0 that already existed.");
    const twice = await tool(token, "import_memory_file", { content: "# CLAUDE.md\n## Style\n- Replies stay short.", format: "claude-md" });
    expect(twice.structuredContent).toMatchObject({ added: 0, skipped: 1 });

    // Without a project, recall still looks into every readable project.
    const found = await tool(token, "recall", { query: "Workers Builds deploys" });
    expect(found.content[0]!.text).toContain("Workers Builds");
    expect(found.content[0]!.text).toContain("project:rhizome");

    const ctxText = (await tool(token, "get_context", { project: "rhizome" })).content[0]!.text;
    expect(ctxText).toContain("Replies stay short.");

    const id = (saved.structuredContent as { id: string }).id;
    expect((await tool(token, "forget", { id })).content[0]!.text).toBe(`Forgot ${id}.`);
    expect((await tool(token, "forget", { id })).isError).toBe(true);
    expect((await tool(token, "remember", { content: "x", scope: "project" })).isError).toBe(true);
    const unknown = (await (await rpc(token, "tools/call", { name: "nope", arguments: {} })).json()) as { error: { code: number } };
    expect(unknown.error.code).toBe(-32602);
  });

  it("keeps API keys working on /mcp and imports through the REST endpoint", async () => {
    const { access_token: token } = await connect();
    const res = await call("/v1/memory/import", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ content: "Prefers German in chat.\n§\nRuns a homelab.", format: "hermes", scope: "agent:self" }),
    });
    expect(res.status).toBe(403); // agent:self is a grant pattern, not a scope
    const ok = await call("/v1/memory/import", {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ content: "Prefers German in chat.\n§\nRuns a homelab.", format: "hermes", scope: "agent:claude" }),
    });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toEqual({ scope: "agent:claude", added: 2, skipped: 0 });
  });
});

describe("consent token", () => {
  it("expires after 15 minutes and only works with the same sign-in", async () => {
    const { consentToken, verifyConsentToken } = await import("../src/oauth");
    const p = { client_id: "rzc_1", redirect_uri: REDIRECT, state: "s", code_challenge: "c".repeat(43), resource: "" };
    const t = await consentToken("jwt-a", p, 1_000_000);
    expect(await verifyConsentToken("jwt-a", p, t, 1_000_000 + 60_000)).toBe(true);
    expect(await verifyConsentToken("jwt-b", p, t, 1_000_000 + 60_000)).toBe(false);
    expect(await verifyConsentToken("jwt-a", p, t, 1_000_000 + 16 * 60_000)).toBe(false);
    expect(await verifyConsentToken("jwt-a", p, undefined)).toBe(false);
  });
});
