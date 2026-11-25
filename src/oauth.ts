// SPDX-License-Identifier: AGPL-3.0-or-later
//
// OAuth 2.1 authorization server for MCP connectors, following the MCP
// authorization spec: protected resource metadata (RFC 9728), authorization
// server metadata (RFC 8414), dynamic client registration (RFC 7591),
// authorization code with PKCE S256 only, refresh token rotation, revocation.
//
// The consent page needs a signed-in person (Cloudflare Access, the built-in
// password sign-in or a sign-in proxy, see identity.ts), so only they can approve
// a connector. Approving maps the connector to a rhizome client (one agent of
// one provider) and issues short-lived API keys as access tokens.

import { Hono } from "hono";
import { KEY_PREFIX } from "./auth";
import type { Env } from "./env";
import { identify, hmacHex, signInHint, signInUrl } from "./identity";
import { newId, newSecret, sha256Hex } from "./ids";
import { DEFAULT_GRANTS, isValidSlug } from "./scopes";

export const ACCESS_TOKEN_TTL = 3600_000;
export const REFRESH_TOKEN_TTL = 90 * 86_400_000;
const CODE_TTL = 5 * 60_000;
const REFRESH_PREFIX = "rzr_";
const CLIENT_PREFIX = "rzc_";
const SCOPE = "memory";

type OAuth = { Bindings: Env };
export const oauth = new Hono<OAuth>();

const origin = (url: string) => new URL(url).origin;
const noStore = { "cache-control": "no-store", pragma: "no-cache" };
/** Metadata, registration and token endpoints are called from browser-based MCP clients too. No cookies are involved. */
const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, mcp-protocol-version", "access-control-allow-methods": "GET, POST, OPTIONS" };

function oauthError(error: string, description: string, status = 400, extra: Record<string, string> = {}): Response {
  return Response.json({ error, error_description: description }, { status, headers: { ...noStore, ...cors, ...extra } });
}

export function resourceMetadataUrl(url: string): string {
  return `${origin(url)}/.well-known/oauth-protected-resource/mcp`;
}

// ------------------------------------------------------------------ metadata

const protectedResource = (url: string) =>
  Response.json(
    {
      resource: `${origin(url)}/mcp`,
      authorization_servers: [origin(url)],
      scopes_supported: [SCOPE],
      bearer_methods_supported: ["header"],
      resource_name: "rhizome memory",
      resource_documentation: "https://github.com/shiftbloom-studio/rhizome#mcp",
    },
    { headers: { ...cors, "cache-control": "public, max-age=3600" } },
  );

const authorizationServer = (url: string) => {
  const o = origin(url);
  return Response.json(
    {
      issuer: o,
      authorization_endpoint: `${o}/oauth/authorize`,
      token_endpoint: `${o}/oauth/token`,
      registration_endpoint: `${o}/oauth/register`,
      revocation_endpoint: `${o}/oauth/revoke`,
      scopes_supported: [SCOPE],
      response_types_supported: ["code"],
      response_modes_supported: ["query"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
      code_challenge_methods_supported: ["S256"],
      service_documentation: "https://github.com/shiftbloom-studio/rhizome#mcp",
    },
    { headers: { ...cors, "cache-control": "public, max-age=3600" } },
  );
};

oauth.get("/.well-known/oauth-protected-resource", (c) => protectedResource(c.req.url));
oauth.get("/.well-known/oauth-protected-resource/mcp", (c) => protectedResource(c.req.url));
oauth.get("/.well-known/oauth-authorization-server", (c) => authorizationServer(c.req.url));
oauth.get("/.well-known/oauth-authorization-server/mcp", (c) => authorizationServer(c.req.url));
oauth.options("/oauth/*", () => new Response(null, { status: 204, headers: cors }));
oauth.options("/.well-known/*", () => new Response(null, { status: 204, headers: cors }));

// -------------------------------------------------------------- registration

/** Redirect URIs must be HTTPS, a loopback address over HTTP, or a private-use scheme of a native app. */
export function validRedirectUri(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length > 500) return false;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.hash || u.username || u.password) return false;
  if (u.protocol === "https:") return true;
  if (u.protocol === "http:") return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  // Native apps (e.g. cursor://, vscode://). Never script-capable schemes.
  return /^[a-z][a-z0-9+.-]*:$/.test(u.protocol) && !["javascript:", "data:", "file:", "blob:", "vbscript:", "about:", "ftp:", "ws:", "wss:"].includes(u.protocol);
}

oauth.post("/oauth/register", async (c) => {
  if (c.env.RATE_LIMITER) {
    const { success } = await c.env.RATE_LIMITER.limit({ key: `oauth-register:${c.req.header("cf-connecting-ip") ?? "?"}` });
    if (!success) return oauthError("slow_down", "too many registrations", 429);
  }
  const text = await c.req.text();
  if (text.length > 16_384) return oauthError("invalid_client_metadata", "registration request is too large");
  let b: Record<string, unknown>;
  try {
    b = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return oauthError("invalid_client_metadata", "body must be JSON");
  }
  const uris = b.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10 || !uris.every(validRedirectUri)) {
    return oauthError("invalid_redirect_uri", "redirect_uris must be 1 to 10 https, loopback or app URIs");
  }
  const grantTypes = Array.isArray(b.grant_types) ? b.grant_types : ["authorization_code", "refresh_token"];
  if (!grantTypes.every((g) => g === "authorization_code" || g === "refresh_token")) {
    return oauthError("invalid_client_metadata", "only authorization_code and refresh_token are supported");
  }
  const authMethod = typeof b.token_endpoint_auth_method === "string" ? b.token_endpoint_auth_method : "none";
  if (!["none", "client_secret_post", "client_secret_basic"].includes(authMethod)) {
    return oauthError("invalid_client_metadata", "token_endpoint_auth_method must be none, client_secret_post or client_secret_basic");
  }
  const name = (typeof b.client_name === "string" ? b.client_name : "MCP client").replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, 80) || "MCP client";
  const id = `${CLIENT_PREFIX}${newId()}`;
  const secret = authMethod === "none" ? null : newSecret("rzs_");
  const now = Date.now();
  await c.env.CONTROL_DB.prepare("INSERT INTO oauth_clients (id, secret_hash, name, redirect_uris, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, secret ? await sha256Hex(secret) : null, name, JSON.stringify(uris), now)
    .run();
  return Response.json(
    {
      client_id: id,
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_id_issued_at: Math.floor(now / 1000),
      client_name: name,
      redirect_uris: uris,
      grant_types: grantTypes,
      response_types: ["code"],
      token_endpoint_auth_method: authMethod,
      scope: SCOPE,
    },
    { status: 201, headers: { ...noStore, ...cors } },
  );
});

interface OAuthClientRow {
  id: string;
  secret_hash: string | null;
  name: string;
  redirect_uris: string;
}

async function oauthClient(env: Env, id: unknown): Promise<OAuthClientRow | null> {
  if (typeof id !== "string" || !id.startsWith(CLIENT_PREFIX) || id.length > 64) return null;
  return env.CONTROL_DB.prepare("SELECT id, secret_hash, name, redirect_uris FROM oauth_clients WHERE id = ?").bind(id).first<OAuthClientRow>();
}

// ------------------------------------------------------------- authorization

interface AuthorizeParams {
  client_id: string;
  redirect_uri: string;
  state: string;
  code_challenge: string;
  resource: string;
}

/** Checks an authorization request. Returns an error page, an error redirect, or the client and parameters. */
async function checkAuthorize(env: Env, url: string, p: Record<string, string | undefined>): Promise<Response | { client: OAuthClientRow; params: AuthorizeParams }> {
  const client = await oauthClient(env, p.client_id);
  if (!client) return page("Unknown app", "<p>This app is not registered with rhizome. Start the connection again from the app.</p>", 400);
  const uris = JSON.parse(client.redirect_uris) as string[];
  const redirect = p.redirect_uri ?? (uris.length === 1 ? uris[0] : undefined);
  if (!redirect || !uris.includes(redirect)) return page("Wrong return address", "<p>The app asked to return to an address it did not register. Nothing was shared.</p>", 400);
  const back = (error: string, description: string) => redirectWith(redirect, { error, error_description: description, state: p.state, iss: origin(url) });
  if (p.response_type !== "code") return back("unsupported_response_type", "only response_type=code is supported");
  if (!p.code_challenge || p.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43,128}$/.test(p.code_challenge)) {
    return back("invalid_request", "PKCE with code_challenge_method=S256 is required");
  }
  if (p.scope && !p.scope.split(" ").every((s) => s === SCOPE || s === "")) return back("invalid_scope", `the only scope is ${SCOPE}`);
  // RFC 8707: the only resource is this server's MCP endpoint (a trailing slash or the bare origin is accepted too).
  if (p.resource && ![`${origin(url)}/mcp`, `${origin(url)}/mcp/`, origin(url), `${origin(url)}/`].includes(p.resource)) {
    return back("invalid_target", "unknown resource");
  }
  return { client, params: { client_id: client.id, redirect_uri: redirect, state: p.state ?? "", code_challenge: p.code_challenge, resource: p.resource ?? "" } };
}

async function signedInUser(env: Env, req: Request): Promise<{ id: string; name: string; email: string; key: string } | null> {
  const identity = await identify(env, req);
  if (!identity) return null;
  const user = await env.CONTROL_DB.prepare("SELECT id, name FROM users WHERE email = ?").bind(identity.email).first<{ id: string; name: string }>();
  return user ? { ...user, email: identity.email, key: identity.key } : null;
}

/** Guesses agent and provider slugs from the app's name, e.g. "Claude" → claude / anthropic. */
export function guessIdentity(name: string): { agent: string; provider: string } {
  const n = name.toLowerCase();
  const slug = n.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "mcp-client";
  if (/claude|anthropic/.test(n)) return { agent: n.includes("code") ? "claude-code" : "claude", provider: "anthropic" };
  if (/chatgpt|openai|codex/.test(n)) return { agent: n.includes("codex") ? "codex" : "chatgpt", provider: "openai" };
  if (/gemini|google/.test(n)) return { agent: "gemini", provider: "google" };
  if (/cursor/.test(n)) return { agent: "cursor", provider: "cursor" };
  if (/hermes|nous/.test(n)) return { agent: "hermes", provider: "nous" };
  return { agent: slug, provider: slug };
}

oauth.get("/oauth/authorize", async (c) => {
  const checked = await checkAuthorize(c.env, c.req.url, c.req.query());
  if (checked instanceof Response) return checked;
  const user = await signedInUser(c.env, c.req.raw);
  if (!user) {
    const login = signInUrl(c.env, new URL(c.req.url).pathname + new URL(c.req.url).search);
    if (login && !(await identify(c.env, c.req.raw))) return c.redirect(login, 302);
    return page("Sign-in needed", `<p>${signInHint(c.env)}, then start the connection again.</p>`, 401);
  }
  const { client, params } = checked;
  const guess = guessIdentity(client.name);
  const target = new URL(params.redirect_uri);
  const where = target.host || target.protocol;
  const known = KNOWN_HOSTS.some((h) => target.hostname === h || target.hostname.endsWith(`.${h}`)) || target.hostname === "localhost" || target.hostname === "127.0.0.1";
  const consent = await consentToken(user.key, params);
  const hidden = [...Object.entries(params), ["consent", consent]].map(([k, v]) => `<input type="hidden" name="${k}" value="${esc(v!)}">`).join("");
  return page(
    `Connect ${esc(client.name)}?`,
    `<p><b>${esc(client.name)}</b> wants to read and write your memory as <b>${esc(user.email)}</b>. It gets the same access as an agent with a key: your profile, every project and its own private notes.</p>
<p class="${known ? "muted" : "warn"}">After you allow it, you go back to <b>${esc(where)}</b>.${known ? "" : " rhizome does not know this address. Allow it only if you started this connection yourself."}</p>
<form method="post" action="/oauth/authorize">${hidden}
<div class="row"><label>agent<input name="agent" value="${esc(guess.agent)}" pattern="[a-z0-9][a-z0-9._-]{0,47}" required></label>
<label>provider<input name="provider" value="${esc(guess.provider)}" pattern="[a-z0-9][a-z0-9._-]{0,47}" required></label></div>
<p class="muted small">Notes it writes are signed with these names. An app that uses the same names as an existing key shares that client's private notes.</p>
<div class="actions"><button name="decision" value="allow" class="btn">Allow</button><button name="decision" value="deny" class="btn ghost">Cancel</button></div>
</form>`,
    200,
    formTarget(params.redirect_uri),
  );
});

oauth.post("/oauth/authorize", async (c) => {
  // Cross-site form posts can carry the sign-in cookie. Browsers mark them in Sec-Fetch-Site,
  // and the consent token proves the form came from a page rendered for this sign-in.
  // The Origin header is not used: it can be "null" after a sign-in redirect chain.
  const site = c.req.header("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") {
    return page("Request refused", "<p>This approval did not come from the rhizome page. Nothing was shared.</p>", 403);
  }
  const form = await c.req.parseBody();
  const field = (k: string) => (typeof form[k] === "string" ? (form[k] as string) : undefined);
  const checked = await checkAuthorize(c.env, c.req.url, {
    client_id: field("client_id"),
    redirect_uri: field("redirect_uri"),
    state: field("state"),
    code_challenge: field("code_challenge"),
    code_challenge_method: "S256",
    response_type: "code",
    resource: field("resource"),
  });
  if (checked instanceof Response) return checked;
  const { client, params } = checked;
  const user = await signedInUser(c.env, c.req.raw);
  if (!user) return page("Sign-in needed", "<p>Your sign-in expired. Start the connection again.</p>", 401);
  if (!(await verifyConsentToken(user.key, params, field("consent")))) {
    return page("Request refused", "<p>This approval did not come from the rhizome page, or the page was open too long. Start the connection again from the app. Nothing was shared.</p>", 403);
  }
  const iss = origin(c.req.url);
  if (field("decision") !== "allow") {
    return redirectWith(params.redirect_uri, { error: "access_denied", error_description: "the person declined", state: params.state, iss });
  }
  const agent = field("agent")?.trim() ?? "";
  const provider = field("provider")?.trim() ?? "";
  if (!isValidSlug(agent) || !isValidSlug(provider)) return page("Check the names", "<p>Agent and provider must be lowercase slugs like <code>claude</code> or <code>openai</code>. Go back and fix them.</p>", 400);

  const now = Date.now();
  const db = c.env.CONTROL_DB;
  // Reuse the person's client for this agent and provider, so its private notes stay together.
  let rz = await db
    .prepare("SELECT id FROM clients WHERE user_id = ? AND agent = ? AND provider = ? AND revoked_at IS NULL ORDER BY created_at LIMIT 1")
    .bind(user.id, agent, provider)
    .first<{ id: string }>();
  if (!rz) {
    rz = { id: newId() };
    await db
      .prepare("INSERT INTO clients (id, user_id, name, agent, provider, grants, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(rz.id, user.id, `${client.name} (via OAuth)`, agent, provider, JSON.stringify(DEFAULT_GRANTS), now)
      .run();
  }
  const code = newSecret("rza_");
  await db
    .prepare(
      `INSERT INTO oauth_grants (id, oauth_client_id, client_id, code_hash, code_challenge, redirect_uri, code_expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(newId(), client.id, rz.id, await sha256Hex(code), params.code_challenge, params.redirect_uri, now + CODE_TTL, now)
    .run();
  return redirectWith(params.redirect_uri, { code, state: params.state, iss });
});

const CONSENT_TTL = 15 * 60_000;


const consentMessage = (issued: string, p: AuthorizeParams) =>
  [issued, p.client_id, p.redirect_uri, p.state, p.code_challenge, p.resource].join("\n");

/**
 * CSRF token for the consent form: an HMAC over the request, keyed with a value
 * only this sign-in knows (see Identity.key). Another site can neither read it nor make one.
 */
export async function consentToken(signInKey: string, p: AuthorizeParams, now = Date.now()): Promise<string> {
  const issued = String(now);
  return `${issued}.${await hmacHex(signInKey, consentMessage(issued, p))}`;
}

export async function verifyConsentToken(signInKey: string, p: AuthorizeParams, token: string | undefined, now = Date.now()): Promise<boolean> {
  const [issued, mac] = (token ?? "").split(".");
  if (!issued || !mac || !/^\d+$/.test(issued)) return false;
  const age = now - Number(issued);
  if (age < 0 || age > CONSENT_TTL) return false;
  const expected = await hmacHex(signInKey, consentMessage(issued, p));
  let diff = expected.length ^ mac.length;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ (mac.charCodeAt(i) || 0);
  return diff === 0;
}

// --------------------------------------------------------------------- token

async function clientFromRequest(env: Env, auth: string | undefined, form: Record<string, unknown>): Promise<OAuthClientRow | Response> {
  let id = typeof form.client_id === "string" ? form.client_id : undefined;
  let secret = typeof form.client_secret === "string" ? form.client_secret : undefined;
  if (auth?.toLowerCase().startsWith("basic ")) {
    try {
      const [u, s] = atob(auth.slice(6).trim()).split(":");
      id = decodeURIComponent(u ?? "");
      secret = decodeURIComponent(s ?? "");
    } catch {
      return oauthError("invalid_client", "malformed basic credentials", 401);
    }
  }
  const client = await oauthClient(env, id);
  if (!client) return oauthError("invalid_client", "unknown client", 401);
  if (client.secret_hash && (!secret || (await sha256Hex(secret)) !== client.secret_hash)) return oauthError("invalid_client", "wrong client secret", 401);
  return client;
}

async function pkceS256(verifier: string): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Issues an access token (a short-lived API key) and a fresh refresh token for a grant. */
async function issueTokens(env: Env, grantId: string, clientId: string): Promise<Response> {
  const now = Date.now();
  const access = newSecret(KEY_PREFIX);
  const refresh = newSecret(REFRESH_PREFIX);
  const db = env.CONTROL_DB;
  await db.batch([
    db
      .prepare("INSERT INTO api_keys (hash, prefix, client_id, created_at, label, expires_at) VALUES (?, ?, ?, ?, 'oauth', ?)")
      .bind(await sha256Hex(access), access.slice(0, 10), clientId, now, now + ACCESS_TOKEN_TTL),
    db.prepare("UPDATE oauth_grants SET refresh_hash = ?, refresh_expires_at = ? WHERE id = ?").bind(await sha256Hex(refresh), now + REFRESH_TOKEN_TTL, grantId),
    // Expired OAuth access tokens are useless; keep the key list short.
    db.prepare("DELETE FROM api_keys WHERE client_id = ? AND label = 'oauth' AND expires_at < ?").bind(clientId, now),
  ]);
  return Response.json(
    { access_token: access, token_type: "Bearer", expires_in: ACCESS_TOKEN_TTL / 1000, refresh_token: refresh, scope: SCOPE },
    { headers: { ...noStore, ...cors } },
  );
}

oauth.post("/oauth/token", async (c) => {
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const client = await clientFromRequest(c.env, c.req.header("authorization"), form);
  if (client instanceof Response) return client;
  const db = c.env.CONTROL_DB;
  const now = Date.now();

  if (form.grant_type === "authorization_code") {
    const code = typeof form.code === "string" ? form.code : "";
    const verifier = typeof form.code_verifier === "string" ? form.code_verifier : "";
    if (!code || !/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return oauthError("invalid_request", "code and a valid code_verifier are required");
    // Single use: the code is cleared in the same statement that reads it.
    const grant = await db
      .prepare(
        `UPDATE oauth_grants SET code_hash = NULL WHERE code_hash = ? AND revoked_at IS NULL
         RETURNING id, oauth_client_id, client_id, code_challenge, redirect_uri, code_expires_at`,
      )
      .bind(await sha256Hex(code))
      .first<{ id: string; oauth_client_id: string; client_id: string; code_challenge: string; redirect_uri: string; code_expires_at: number }>();
    if (!grant || grant.oauth_client_id !== client.id || grant.code_expires_at < now) return oauthError("invalid_grant", "the code is invalid, used or expired");
    if (typeof form.redirect_uri === "string" && form.redirect_uri !== grant.redirect_uri) return oauthError("invalid_grant", "redirect_uri does not match");
    if ((await pkceS256(verifier)) !== grant.code_challenge) return oauthError("invalid_grant", "code_verifier does not match");
    return issueTokens(c.env, grant.id, grant.client_id);
  }

  if (form.grant_type === "refresh_token") {
    const token = typeof form.refresh_token === "string" ? form.refresh_token : "";
    if (!token.startsWith(REFRESH_PREFIX)) return oauthError("invalid_grant", "unknown refresh token");
    // Rotation: the old refresh token is cleared in the same statement that reads it,
    // so two concurrent requests with one token cannot both get a new pair.
    const grant = await db
      .prepare(
        `UPDATE oauth_grants SET refresh_hash = NULL
          WHERE refresh_hash = ? AND oauth_client_id = ? AND revoked_at IS NULL AND refresh_expires_at >= ?
          RETURNING id, client_id`,
      )
      .bind(await sha256Hex(token), client.id, now)
      .first<{ id: string; client_id: string }>();
    if (!grant) return oauthError("invalid_grant", "the refresh token is invalid or expired");
    const live = await db.prepare("SELECT 1 AS ok FROM clients WHERE id = ? AND revoked_at IS NULL").bind(grant.client_id).first();
    if (!live) return oauthError("invalid_grant", "the connection was revoked");
    return issueTokens(c.env, grant.id, grant.client_id);
  }

  return oauthError("unsupported_grant_type", "use authorization_code or refresh_token");
});

/** RFC 7009. Revoking a refresh token ends the connection; revoking an access token ends only that token. */
oauth.post("/oauth/revoke", async (c) => {
  const form = await c.req.parseBody().catch(() => ({}) as Record<string, unknown>);
  const client = await clientFromRequest(c.env, c.req.header("authorization"), form);
  if (client instanceof Response) return client;
  const token = typeof form.token === "string" ? form.token : "";
  const hash = await sha256Hex(token);
  const now = Date.now();
  const db = c.env.CONTROL_DB;
  if (token.startsWith(REFRESH_PREFIX)) {
    const grant = await db
      .prepare("UPDATE oauth_grants SET revoked_at = ?, refresh_hash = NULL WHERE refresh_hash = ? AND oauth_client_id = ? RETURNING client_id")
      .bind(now, hash, client.id)
      .first<{ client_id: string }>();
    if (grant) {
      await db.prepare("UPDATE api_keys SET revoked_at = ? WHERE client_id = ? AND label = 'oauth' AND revoked_at IS NULL").bind(now, grant.client_id).run();
    }
  } else if (token.startsWith(KEY_PREFIX)) {
    await db
      .prepare(
        `UPDATE api_keys SET revoked_at = ? WHERE hash = ? AND label = 'oauth'
           AND client_id IN (SELECT client_id FROM oauth_grants WHERE oauth_client_id = ?)`,
      )
      .bind(now, hash, client.id)
      .run();
  }
  return new Response(null, { status: 200, headers: { ...noStore, ...cors } });
});

/** Housekeeping for the nightly cron: unused registrations and dead codes. */
export async function cleanupOAuth(env: Env, now = Date.now()): Promise<void> {
  const db = env.CONTROL_DB;
  await db.batch([
    db.prepare("DELETE FROM oauth_grants WHERE refresh_hash IS NULL AND code_expires_at < ?").bind(now - 86_400_000),
    db.prepare("DELETE FROM oauth_grants WHERE refresh_expires_at < ?").bind(now),
    db.prepare("DELETE FROM oauth_clients WHERE created_at < ? AND id NOT IN (SELECT oauth_client_id FROM oauth_grants)").bind(now - 7 * 86_400_000),
    db.prepare("DELETE FROM api_keys WHERE label = 'oauth' AND expires_at < ?").bind(now - 86_400_000),
  ]);
}

// ----------------------------------------------------------------- helpers

function redirectWith(uri: string, params: Record<string, string | undefined>): Response {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v) u.searchParams.set(k, v);
  return new Response(null, { status: 302, headers: { location: u.toString(), ...noStore } });
}

export function esc(s: string): string {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]!);
}

/** Browsers apply form-action to the redirect after a form post, so the app's return address must be allowed. */
function formTarget(uri: string): string {
  const u = new URL(uri);
  return u.protocol === "https:" || u.protocol === "http:" ? u.origin : u.protocol;
}

const KNOWN_HOSTS = ["claude.ai", "claude.com", "anthropic.com", "chatgpt.com", "openai.com", "cursor.com", "cursor.sh"];

export function page(title: string, body: string, status = 200, formAction = ""): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${title} · rhizome.</title><meta name="robots" content="noindex"><link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/fonts/fonts.css">
<style>
:root{--ink:#1A1216;--ink60:rgba(26,18,22,.62);--paper:#F6F1EE;--panel:#EEE6E2;--root:#C81040;--bloom:#FF2E52;--blush:#FFE9EF}
*{box-sizing:border-box}html{background:var(--panel);color:var(--ink)}
body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.6 "General Sans",system-ui,-apple-system,"Segoe UI",sans-serif;padding:24px}
::selection{background:var(--blush)}
.card{background:var(--paper);max-width:34em;width:100%;padding:32px clamp(20px,5vw,40px);border-radius:16px;box-shadow:0 1px 2px rgba(26,18,22,.06),0 12px 40px rgba(26,18,22,.06)}
.mark{font:600 22px/1 "Clash Display","General Sans",sans-serif;color:var(--ink);text-decoration:none}
.mark i{color:var(--bloom);font-style:normal}
h1{font:600 30px/1.15 "Clash Display","General Sans",sans-serif;margin:22px 0 14px;letter-spacing:-.01em}
p{margin:0 0 14px}.muted{color:var(--ink60)}.small{font-size:14px}
.warn{background:var(--blush);color:var(--ink);padding:10px 14px;border-radius:10px}
.row{display:flex;gap:12px;flex-wrap:wrap;margin:18px 0 8px}
label{flex:1;min-width:10em;font:500 12px/1 "JetBrains Mono",ui-monospace,monospace;letter-spacing:.12em;color:var(--ink60);display:grid;gap:8px}
input{font:15px/1.4 "JetBrains Mono",ui-monospace,monospace;color:var(--ink);padding:10px 12px;border:1px solid rgba(26,18,22,.16);border-radius:10px;background:var(--paper)}
input:focus{outline:2px solid var(--bloom);outline-offset:1px}
.actions{display:flex;gap:10px;margin-top:22px}
.btn{font:600 15px/1 "General Sans",sans-serif;padding:13px 22px;border-radius:999px;border:0;background:var(--root);color:#fff;cursor:pointer}
.btn:hover{background:var(--bloom)}.btn.ghost{background:transparent;color:var(--ink);border:1px solid rgba(26,18,22,.16)}
code{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:.9em}
footer{margin-top:28px;font-size:13px;color:var(--ink60)}footer a{color:var(--ink60)}
</style></head><body><main class="card"><a class="mark" href="/">rhizome<i>.</i></a><h1>${title}</h1>${body}
<footer><a href="/privacy">Privacy</a> · <a href="/imprint">Imprint</a></footer></main></body></html>`;
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      ...noStore,
      "content-security-policy": `default-src 'none'; style-src 'self' 'unsafe-inline'; font-src 'self'; img-src 'self'; form-action 'self'${formAction ? ` ${formAction}` : ""}; frame-ancestors 'none'; base-uri 'none'`,
      "x-frame-options": "DENY",
      "referrer-policy": "same-origin",
    },
  });
}
