// SPDX-License-Identifier: AGPL-3.0-or-later
// Serves the built explorer (web/dist) like Workers static assets: single-page
// fallback to index.html and the header rules from _headers.
import { readFile, stat } from "node:fs/promises";
import { extname, join, resolve, sep } from "node:path";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
};

type Rule = { pattern: RegExp; headers: [string, string][] };

function parseHeaders(text: string): Rule[] {
  const rules: Rule[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim() || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(line)) {
      const glob = line.trim().replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      rules.push({ pattern: new RegExp(`^${glob}$`), headers: [] });
    } else {
      const i = line.indexOf(":");
      if (i > 0 && rules.length) rules.at(-1)!.headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
    }
  }
  return rules;
}

export async function localAssets(dir: string) {
  const root = resolve(dir);
  const rules = parseHeaders(await readFile(join(root, "_headers"), "utf8").catch(() => ""));

  async function file(path: string): Promise<string | null> {
    const p = resolve(join(root, decodeURIComponent(path)));
    if (p !== root && !p.startsWith(root + sep)) return null;
    if (p.endsWith(`${sep}_headers`) || p.endsWith(`${sep}_redirects`)) return null;
    const s = await stat(p).catch(() => null);
    if (s?.isFile()) return p;
    if (s?.isDirectory()) return file(join(path, "index.html"));
    return null;
  }

  return {
    async fetch(input: Request | string): Promise<Response> {
      const req = typeof input === "string" ? new Request(input) : input;
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405 });
      const { pathname } = new URL(req.url);
      const found = (await file(pathname)) ?? (await file("/index.html"));
      if (!found) return new Response("not found (run npm run build:web)", { status: 404 });
      const headers = new Headers({ "content-type": TYPES[extname(found)] ?? "application/octet-stream" });
      // Later rules win, like on Cloudflare (header values from several rules are merged there; overriding is close enough).
      for (const r of rules) if (r.pattern.test(pathname)) for (const [k, v] of r.headers) headers.set(k, v);
      const body = req.method === "HEAD" ? null : await readFile(found);
      return new Response(body, { status: 200, headers });
    },
  };
}
