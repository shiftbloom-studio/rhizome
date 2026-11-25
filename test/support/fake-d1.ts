// SPDX-License-Identifier: AGPL-3.0-or-later
// A D1 double backed by node:sqlite with every migration applied.
import { readdirSync, readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export function fakeD1() {
  const db = new DatabaseSync(":memory:");
  const dir = fileURLToPath(new URL("../../migrations/", import.meta.url).href);
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".sql")).sort()) db.exec(readFileSync(join(dir, f), "utf8"));
  const statement = (query: string, params: unknown[] = []) => ({
    bind: (...p: unknown[]) => statement(query, p),
    first: async <T>() => ((db.prepare(query).all(...(params as never[]))[0] as T | undefined) ?? null),
    all: async <T>() => ({ results: db.prepare(query).all(...(params as never[])) as T[] }),
    run: async () => {
      const r = db.prepare(query).run(...(params as never[]));
      return { meta: { changes: Number(r.changes) } };
    },
  });
  return {
    db,
    binding: {
      prepare: (q: string) => statement(q),
      batch: async (stmts: { run: () => Promise<unknown> }[]) => {
        db.exec("BEGIN");
        try {
          const out = [];
          for (const s of stmts) out.push(await s.run());
          db.exec("COMMIT");
          return out;
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      },
    },
  };
}
