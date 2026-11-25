// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Built-in sign-in for AUTH_MODE=password: one email address and password from
// the configuration, kept in a signed, HttpOnly cookie for seven days. Meant for
// self-hosting without Cloudflare Access or a sign-in proxy.

import { Hono } from "hono";
import { createUser } from "./auth";
import type { Env } from "./env";
import { SESSION_COOKIE, SESSION_TTL, authMode, createSession, safeEqualHashed, sessionKey, signInProblem } from "./identity";
import { esc, page } from "./oauth";

type Login = { Bindings: Env };
export const login = new Hono<Login>();

/** Only same-site paths, so the sign-in page can't be used as an open redirect. */
function safeNext(raw: unknown): string {
  return typeof raw === "string" && /^\/(?![/\\])[^\s]*$/.test(raw) && raw.length <= 2000 ? raw : "/";
}

function form(next: string, error = ""): string {
  return `${error ? `<p class="warn">${esc(error)}</p>` : ""}<form method="post" action="/auth/login"><input type="hidden" name="next" value="${esc(next)}">
<div class="row"><label>email<input name="email" type="email" autocomplete="username" required></label></div>
<div class="row"><label>password<input name="password" type="password" autocomplete="current-password" required></label></div>
<div class="actions"><button class="btn">Sign in</button></div></form>`;
}

login.use("/auth/*", async (c, next) => {
  if (authMode(c.env) !== "password") return c.json({ error: "not found" }, 404);
  const problem = signInProblem(c.env);
  if (problem) return page("Sign-in is not set up", `<p>${esc(problem)}.</p>`, 503);
  await next();
});

login.get("/auth/login", (c) => page("Sign in", form(safeNext(c.req.query("next")))));

login.post("/auth/login", async (c) => {
  const site = c.req.header("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return page("Request refused", "<p>This sign-in did not come from the rhizome page.</p>", 403);
  const limiter = c.env.LOGIN_RATE_LIMITER ?? c.env.RATE_LIMITER;
  if (limiter) {
    const { success } = await limiter.limit({ key: `login:${c.req.header("cf-connecting-ip") ?? "?"}` });
    if (!success) return page("Slow down", "<p>Too many sign-in attempts. Wait a minute and try again.</p>", 429);
  }
  const body = await c.req.parseBody();
  const next = safeNext(body.next);
  const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
  const password = typeof body.password === "string" ? body.password : "";
  const expected = c.env.LOGIN_EMAIL!.trim().toLowerCase();
  // Both checks always run, so timing does not tell which one failed.
  const okPassword = await safeEqualHashed(password, c.env.LOGIN_PASSWORD!);
  if (!(email === expected && okPassword)) return page("Sign in", form(next, "That email address and password don't match."), 401);

  // First sign-in on a fresh install: create the person, linked to this address.
  const db = c.env.CONTROL_DB;
  const user = await db.prepare("SELECT id FROM users WHERE email = ?").bind(email).first<{ id: string }>();
  if (!user) {
    const created = await createUser(c.env, email.split("@")[0] || "owner");
    await db.prepare("UPDATE users SET email = ? WHERE id = ?").bind(email, created.id).run();
  }

  const token = await createSession(sessionKey(c.env), email);
  const secure = new URL(c.req.url).protocol === "https:" ? "; Secure" : "";
  return new Response(null, {
    status: 303,
    headers: {
      location: next,
      "set-cookie": `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_TTL / 1000}${secure}`,
      "cache-control": "no-store",
    },
  });
});

login.post("/auth/logout", (c) => {
  const site = c.req.header("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return page("Request refused", "<p>This did not come from the rhizome page.</p>", 403);
  return new Response(null, {
    status: 303,
    headers: { location: "/auth/login", "set-cookie": `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`, "cache-control": "no-store" },
  });
});
