// SPDX-License-Identifier: AGPL-3.0-or-later
//
// rhizome on Node, without Cloudflare. The same Worker code runs on top of
// local stand-ins for its bindings:
//
//   Durable Objects  one SQLite file per person         DATA_DIR/memory/
//   D1               SQLite                             DATA_DIR/control.sqlite
//   R2               files                              DATA_DIR/episodes/
//   Vectorize        exact cosine search in SQLite      DATA_DIR/vectors.sqlite
//   Workers AI       any OpenAI-compatible server (Ollama, LM Studio, ...) or Workers AI over REST
//
// Configuration comes from environment variables or a .env file, see .env.example.

import { existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { serve } from "@hono/node-server";
import type { Env } from "../env";
import { signInProblem, authMode } from "../identity";
import worker, { MemoryObject } from "../index";
import { localAssets } from "./assets";
import { LocalAi, type AiConfig } from "./ai";
import { LocalBucket } from "./blobs";
import { LocalD1 } from "./d1";
import { LocalNamespace } from "./durable";
import { LocalVectorIndex } from "./vectors";

if (existsSync(".env")) process.loadEnvFile(".env");
const vars = process.env;

const here = dirname(fileURLToPath(import.meta.url));
// The build puts this file in dist/node/; migrations/ and web/dist/ sit next to dist/.
const appRoot = resolve(here, "..", "..");
const dataDir = resolve(vars.DATA_DIR ?? "data");
const port = Number(vars.PORT ?? 8787);
const host = vars.HOST ?? "127.0.0.1";
const publicUrl = vars.PUBLIC_URL ? new URL(vars.PUBLIC_URL) : null;
const trustProxy = vars.TRUST_PROXY === "true";

function fail(message: string): never {
  console.error(`rhizome: ${message}`);
  process.exit(1);
  throw new Error(message);
}

// ------------------------------------------------------------------ AI

const provider = (vars.AI_PROVIDER ?? "openai").toLowerCase();
if (provider !== "openai" && provider !== "cloudflare") fail(`AI_PROVIDER must be "openai" or "cloudflare", not "${provider}"`);
const ai: AiConfig =
  provider === "cloudflare"
    ? { provider, accountId: vars.CLOUDFLARE_ACCOUNT_ID, apiKey: vars.CLOUDFLARE_API_TOKEN }
    : { provider, baseUrl: vars.AI_BASE_URL ?? "http://localhost:11434/v1", apiKey: vars.AI_API_KEY, rerankUrl: vars.AI_RERANK_URL };
if (provider === "cloudflare" && (!ai.accountId || !ai.apiKey)) fail("AI_PROVIDER=cloudflare needs CLOUDFLARE_ACCOUNT_ID and CLOUDFLARE_API_TOKEN");
if (provider === "openai") {
  // The defaults are Workers AI model ids, which an OpenAI-compatible server doesn't know.
  if (!vars.EMBEDDING_MODEL) fail("set EMBEDDING_MODEL to an embedding model your AI server serves, e.g. bge-m3 on Ollama");
  if (vars.EXTRACTION !== "off" && !vars.EXTRACTION_MODEL) fail("set EXTRACTION_MODEL to a chat model (e.g. qwen3:8b on Ollama), or EXTRACTION=off");
  if (!vars.RERANK_MODEL) vars.RERANK_MODEL = "reranker";
  if (!vars.REFLECTION_MODEL && vars.EXTRACTION_MODEL) vars.REFLECTION_MODEL = vars.EXTRACTION_MODEL;
  if (!vars.REFLECTION_MODEL) console.warn("rhizome: no REFLECTION_MODEL or EXTRACTION_MODEL, nightly profile summaries will fail");
}

// ------------------------------------------------------------- bindings

mkdirSync(dataDir, { recursive: true });
const control = new LocalD1(join(dataDir, "control.sqlite"));
const applied = control.migrate(join(appRoot, "migrations"));
if (applied.length) console.log(`applied migrations: ${applied.join(", ")}`);

const vectors = new LocalVectorIndex(join(dataDir, "vectors.sqlite"));

/** Fixed one-minute windows per key, like the Workers rate limiting binding. */
function rateLimiter(limit: number, periodMs: number) {
  const windows = new Map<string, { start: number; count: number }>();
  setInterval(() => {
    const now = Date.now();
    for (const [k, w] of windows) if (now - w.start > periodMs) windows.delete(k);
  }, periodMs).unref();
  return {
    async limit({ key }: { key: string }) {
      const now = Date.now();
      const w = windows.get(key);
      if (!w || now - w.start > periodMs) {
        windows.set(key, { start: now, count: 1 });
        return { success: true };
      }
      w.count++;
      return { success: w.count <= limit };
    },
  };
}

const passthrough = Object.fromEntries(Object.entries(vars).filter(([, v]) => typeof v === "string")) as Record<string, string>;
let env: Env;
const memory = new LocalNamespace(join(dataDir, "memory"), MemoryObject, () => env);
env = {
  ...passthrough,
  MEMORY: memory as unknown as Env["MEMORY"],
  CONTROL_DB: control as unknown as D1Database,
  EPISODES: new LocalBucket(join(dataDir, "episodes")) as unknown as R2Bucket,
  VECTORS: vectors as unknown as VectorizeIndex,
  AI: new LocalAi(ai) as unknown as Ai,
  RATE_LIMITER: rateLimiter(Number(vars.RATE_LIMIT ?? 120), 60_000) as unknown as RateLimit,
  ASSETS: (await localAssets(join(appRoot, "web", "dist"))) as unknown as Fetcher,
};

const ctx = {
  waitUntil: (p: Promise<unknown>) => void Promise.resolve(p).catch((e) => console.error(e)),
  passThroughOnException: () => {},
  props: {},
} as unknown as ExecutionContext;

// --------------------------------------------------------------- server

/** Rebuilds the request with the public origin and a trustworthy client address. */
function incoming(req: Request, remote: string | undefined): Request {
  const url = new URL(req.url);
  const headers = new Headers(req.headers);
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  if (publicUrl) {
    url.protocol = publicUrl.protocol;
    url.host = publicUrl.host;
  } else if (trustProxy) {
    const proto = headers.get("x-forwarded-proto");
    const fwdHost = headers.get("x-forwarded-host");
    if (proto === "https" || proto === "http") url.protocol = `${proto}:`;
    if (fwdHost) url.host = fwdHost;
  }
  // The Worker reads the client address from cf-connecting-ip. Never take it from the client.
  headers.set("cf-connecting-ip", (trustProxy && forwarded) || remote || "unknown");
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, { method: req.method, headers, body: hasBody ? req.body : undefined, duplex: "half", redirect: "manual" } as RequestInit);
}

const server = serve({
  hostname: host,
  port,
  fetch: (req, info: { incoming?: { socket?: { remoteAddress?: string } } }) =>
    worker.fetch(incoming(req, info?.incoming?.socket?.remoteAddress) as never, env, ctx),
});

// ------------------------------------------------------------ schedules

/** Nightly reflection, at 03:17 UTC like the Worker's cron trigger (REFLECTION_TIME=HH:MM to change). */
function scheduleReflection() {
  const [h, m] = (vars.REFLECTION_TIME ?? "03:17").split(":").map(Number);
  const next = new Date();
  next.setUTCHours(h ?? 3, m ?? 17, 0, 0);
  if (next.getTime() <= Date.now()) next.setUTCDate(next.getUTCDate() + 1);
  setTimeout(async () => {
    try {
      await worker.scheduled({ cron: "nightly", scheduledTime: next.getTime(), noRetry() {} } as ScheduledController, env, ctx);
    } catch (e) {
      console.error("nightly reflection failed", e);
    }
    scheduleReflection();
  }, next.getTime() - Date.now()).unref();
}
scheduleReflection();

const resumed = await memory.resumeAll();
const users = (await control.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>())?.n ?? 0;

console.log(`rhizome listening on http://${host}:${port}${publicUrl ? ` (public URL ${publicUrl.origin})` : ""}`);
console.log(`data in ${dataDir}, ${resumed} memory store(s), AI via ${provider === "openai" ? ai.baseUrl : "Workers AI REST"}`);
const problem = signInProblem(env);
console.log(problem ? `explorer and OAuth consent are off: ${problem}` : `explorer sign-in: ${authMode(env)}`);
if (!users && !vars.ADMIN_TOKEN && authMode(env) !== "password") {
  console.log("no people yet: set ADMIN_TOKEN to use /v1/admin, or AUTH_MODE=password to create yourself on first sign-in");
}

function shutdown() {
  server.close();
  memory.close();
  vectors.close();
  control.db.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
