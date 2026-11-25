// SPDX-License-Identifier: AGPL-3.0-or-later
import type { Block, Detail, Graph, Me, SearchResult } from "./types";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/ui/api${path}`, {
    method,
    credentials: "same-origin",
    headers: { "x-rhizome": "1", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401) {
    // The session ended. With the built-in sign-in the server names its page; behind
    // Cloudflare Access or a sign-in proxy, reloading goes through sign-in again.
    const { signIn } = (await res.json().catch(() => ({}))) as { signIn?: string | null };
    if (signIn) window.location.assign(`${signIn}?next=${encodeURIComponent(window.location.pathname + window.location.search)}`);
    else window.location.reload();
    throw new Error("signed out");
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

export const api = {
  me: () => call<Me>("GET", "/me"),
  graph: (scopes?: string[]) => call<Graph>("GET", `/graph${scopes?.length ? `?scopes=${encodeURIComponent(scopes.join(","))}` : ""}`),
  search: (query: string, scopes?: string[]) => call<SearchResult>("POST", "/search", { query, scopes }),
  detail: (id: string) => call<Detail>("GET", `/items/${encodeURIComponent(id)}`),
  confirm: (id: string) => call<unknown>("POST", `/items/${encodeURIComponent(id)}/confirm`),
  forget: (id: string) => call<{ deleted: number }>("DELETE", `/items/${encodeURIComponent(id)}`),
  remember: (content: string, scope: string, kind: string) => call<{ id: string }>("POST", "/notes", { content, scope, kind }),
  blocks: () => call<{ blocks: Block[] }>("GET", "/blocks"),
  reflect: () => call<{ scheduled: boolean }>("POST", "/reflect"),
};
