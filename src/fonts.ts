// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Brand fonts (Clash Display, General Sans, JetBrains Mono) are proxied
// through the Worker, so visitors never connect to Fontshare or Google.

const FONT_CSS = [
  // Fontshare returns only the first family per request, so one URL per family.
  "https://api.fontshare.com/v2/css?f[]=clash-display@500,600&display=swap",
  "https://api.fontshare.com/v2/css?f[]=general-sans@400,500,600&display=swap",
  "https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap",
];
const FONT_HOSTS: Record<string, string> = { fs: "https://cdn.fontshare.com/", gs: "https://fonts.gstatic.com/" };
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

export async function fontCss(ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
  const cache = (caches as unknown as { default: Cache }).default;
  const key = new Request("https://rhizome.internal/fonts.css?v=1");
  const hit = await cache.match(key);
  if (hit) return hit;
  const parts = await Promise.all(FONT_CSS.map((u) => fetch(u, { headers: { "user-agent": UA } }).then((r) => (r.ok ? r.text() : ""))));
  const css = parts
    .join("\n")
    .replace(
      /url\((['"]?)(?:https?:)?\/\/(cdn\.fontshare\.com|fonts\.gstatic\.com)\/([^'")]+)\1\)/g,
      (_m, _q, host: string, path: string) => `url(/fonts/${host.startsWith("cdn") ? "fs" : "gs"}/${path})`,
    );
  const res = new Response(css, { headers: { "content-type": "text/css; charset=utf-8", "cache-control": "public, max-age=86400" } });
  if (css.length > 100) ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

export async function fontFile(kind: string, path: string): Promise<Response> {
  const base = FONT_HOSTS[kind];
  if (!base || path.includes("..") || !/^[A-Za-z0-9_\-/.]+$/.test(path)) return new Response("Not found", { status: 404 });
  const r = await fetch(base + path, { headers: { "user-agent": UA }, cf: { cacheEverything: true, cacheTtl: 2_592_000 } });
  if (!r.ok) return new Response("Not found", { status: 404 });
  return new Response(r.body, {
    headers: {
      "content-type": r.headers.get("content-type") || "font/woff2",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}

/** Solid bloom (brand rule: below 32 px the mark is drawn solid). */
export const FAVICON = (() => {
  const petal = (r: number, w: number) => {
    const a = w * r, b = w * r * 0.55, y1 = -r * 0.32, y2 = -r * 0.78;
    return `M0 0C${a} ${y1} ${b} ${y2} 0 ${-r}C${-b} ${y2} ${-a} ${y1} 0 0Z`;
  };
  let body = "";
  for (const [r, n, w, rot] of [[100, 10, 0.27, 0], [74, 10, 0.29, 18]] as const) {
    for (let k = 0; k < n; k++) body += `<path d="${petal(r, w)}" transform="rotate(${rot + (360 / n) * k})" fill="#FF2E52"/>`;
  }
  return `<svg viewBox="-105 -105 210 210" xmlns="http://www.w3.org/2000/svg">${body}<circle r="7" fill="#C81040"/></svg>`;
})();
