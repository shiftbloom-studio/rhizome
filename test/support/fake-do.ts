// SPDX-License-Identifier: AGPL-3.0-or-later
// A Durable Object storage double backed by node:sqlite, plus fakes for R2,
// Vectorize and Workers AI, so the MemoryObject's SQL and pipeline run in tests.
import { DatabaseSync } from "node:sqlite";

export function fakeState() {
  const db = new DatabaseSync(":memory:");
  let alarm: number | null = null;
  const toParam = (v: unknown) => (v instanceof ArrayBuffer ? new Uint8Array(v) : v);
  const sql = {
    exec(query: string, ...params: unknown[]) {
      const multi = query.split(";").filter((s) => s.trim()).length > 1 && !/BEGIN[\s\S]*END/i.test(query.split(";")[0] ?? "");
      if (params.length === 0 && (multi || /CREATE TRIGGER/i.test(query))) {
        db.exec(query);
        return { toArray: () => [] as Record<string, unknown>[] };
      }
      const rows = db.prepare(query).all(...(params.map(toParam) as never[])) as Record<string, unknown>[];
      return {
        toArray: () =>
          rows.map((r) => {
            const out: Record<string, unknown> = {};
            for (const [k, v] of Object.entries(r)) out[k] = v instanceof Uint8Array ? v.slice().buffer : v;
            return out;
          }),
      };
    },
    get databaseSize() {
      return 0;
    },
  };
  return {
    db,
    state: {
      storage: {
        sql,
        transactionSync<T>(fn: () => T): T {
          db.exec("SAVEPOINT tx");
          try {
            const r = fn();
            db.exec("RELEASE tx");
            return r;
          } catch (e) {
            db.exec("ROLLBACK TO tx");
            db.exec("RELEASE tx");
            throw e;
          }
        },
        getAlarm: async () => alarm,
        setAlarm: async (t: number) => {
          alarm = t;
        },
      },
      blockConcurrencyWhile: async (fn: () => Promise<void> | void) => fn(),
    },
  };
}

/** Deterministic bag-of-words embedding: texts sharing words are similar. */
export function embedText(text: string): number[] {
  const v = new Array(64).fill(0);
  for (const w of text.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 2)) {
    let h = 0;
    for (let i = 0; i < w.length; i++) h = (h * 31 + w.charCodeAt(i)) >>> 0;
    v[h % 64] += 1;
  }
  return v;
}

export function fakeEnv(generate: (model: string, system: string, user: string) => string) {
  const r2 = new Map<string, string>();
  const vectors = new Map<string, { values: number[]; metadata: Record<string, string> }>();
  const calls: string[] = [];
  return {
    calls,
    r2,
    vectors,
    env: {
      EPISODES: {
        put: async (k: string, v: string) => void r2.set(k, v),
        get: async (k: string) => (r2.has(k) ? { json: async () => JSON.parse(r2.get(k)!) } : null),
        delete: async (k: string) => void r2.delete(k),
      },
      VECTORS: {
        upsert: async (rows: { id: string; values: number[]; metadata: Record<string, string> }[]) => rows.forEach((r) => vectors.set(r.id, r)),
        deleteByIds: async (ids: string[]) => ids.forEach((id) => vectors.delete(id)),
        query: async () => ({ matches: [] }),
      },
      AI: {
        run: async (model: string, input: { text?: string[]; messages?: { content: string }[]; query?: string; contexts?: unknown[] }) => {
          calls.push(model);
          if (input.text) return { data: input.text.map(embedText) };
          if (input.contexts) return { response: input.contexts.map((_, id) => ({ id, score: 0.01 })) };
          return { response: generate(model, input.messages![0]!.content, input.messages![1]!.content) };
        },
      },
    },
  };
}
