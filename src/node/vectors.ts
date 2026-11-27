// SPDX-License-Identifier: AGPL-3.0-or-later
// The part of the Vectorize API rhizome uses: exact cosine search over a SQLite
// table, with namespaces and metadata filters. One person's memory holds
// thousands of vectors, not millions, so a full scan in memory is fast enough.
import { DatabaseSync } from "node:sqlite";

type Meta = Record<string, string | number | boolean>;
type Range = { $lt?: string | number; $lte?: string | number; $gt?: string | number; $gte?: string | number };
type Filter = Record<string, string | number | boolean | ({ $eq?: unknown; $ne?: unknown; $in?: unknown[]; $nin?: unknown[] } & Range)>;
interface Row {
  id: string;
  metadata: Meta;
  values: Float32Array;
  norm: number;
}

function norm(v: ArrayLike<number>): number {
  let s = 0;
  for (let i = 0; i < v.length; i++) s += v[i]! * v[i]!;
  return Math.sqrt(s);
}

function matches(meta: Meta, filter: Filter | undefined): boolean {
  if (!filter) return true;
  for (const [k, cond] of Object.entries(filter)) {
    const v = meta[k];
    if (cond !== null && typeof cond === "object") {
      if ("$eq" in cond && v !== cond.$eq) return false;
      if ("$ne" in cond && v === cond.$ne) return false;
      if (cond.$in && !cond.$in.includes(v)) return false;
      if (cond.$nin && cond.$nin.includes(v)) return false;
      // Ranges match values of the bound's type only, as in Vectorize.
      const r = cond as Range;
      for (const [op, bound] of [["$lt", r.$lt], ["$lte", r.$lte], ["$gt", r.$gt], ["$gte", r.$gte]] as const) {
        if (bound === undefined) continue;
        if (typeof v !== typeof bound) return false;
        const a = v as string | number;
        if ((op === "$lt" && !(a < bound)) || (op === "$lte" && !(a <= bound)) || (op === "$gt" && !(a > bound)) || (op === "$gte" && !(a >= bound))) return false;
      }
    } else if (v !== cond) return false;
  }
  return true;
}

export class LocalVectorIndex {
  private db: DatabaseSync;
  private cache = new Map<string, Row[]>();

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec(`PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS vectors (id TEXT PRIMARY KEY, namespace TEXT NOT NULL, metadata TEXT NOT NULL, vec BLOB NOT NULL);
      CREATE INDEX IF NOT EXISTS vectors_namespace ON vectors (namespace);`);
  }

  private rows(namespace: string): Row[] {
    let rows = this.cache.get(namespace);
    if (!rows) {
      const raw = this.db.prepare("SELECT id, metadata, vec FROM vectors WHERE namespace = ?").all(namespace) as { id: string; metadata: string; vec: Uint8Array }[];
      rows = raw.map((r) => {
        const values = new Float32Array(r.vec.slice().buffer);
        return { id: r.id, metadata: JSON.parse(r.metadata) as Meta, values, norm: norm(values) };
      });
      this.cache.set(namespace, rows);
    }
    return rows;
  }

  async upsert(vectors: { id: string; values: number[] | Float32Array; namespace?: string; metadata?: Meta }[]) {
    const stmt = this.db.prepare(
      "INSERT INTO vectors (id, namespace, metadata, vec) VALUES (?, ?, ?, ?) ON CONFLICT (id) DO UPDATE SET namespace = excluded.namespace, metadata = excluded.metadata, vec = excluded.vec",
    );
    this.db.exec("BEGIN");
    try {
      for (const v of vectors) stmt.run(v.id, v.namespace ?? "", JSON.stringify(v.metadata ?? {}), new Uint8Array(Float32Array.from(v.values).buffer));
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
    this.cache.clear();
    return { mutationId: String(Date.now()), count: vectors.length, ids: vectors.map((v) => v.id) };
  }

  async deleteByIds(ids: string[]) {
    const stmt = this.db.prepare("DELETE FROM vectors WHERE id = ?");
    for (const id of ids) stmt.run(id);
    this.cache.clear();
    return { mutationId: String(Date.now()), count: ids.length, ids };
  }

  async query(vector: number[] | Float32Array, opts: { topK?: number; namespace?: string; filter?: Filter; returnMetadata?: boolean | string } = {}) {
    const q = Float32Array.from(vector);
    const qn = norm(q) || 1;
    const scored: { id: string; score: number; metadata?: Meta }[] = [];
    for (const r of this.rows(opts.namespace ?? "")) {
      // Vectors from another embedding model (other dimensions) can't be compared.
      if (r.values.length !== q.length || !matches(r.metadata, opts.filter)) continue;
      let dot = 0;
      for (let i = 0; i < q.length; i++) dot += q[i]! * r.values[i]!;
      scored.push({ id: r.id, score: dot / (qn * (r.norm || 1)), ...(opts.returnMetadata ? { metadata: r.metadata } : {}) });
    }
    scored.sort((a, b) => b.score - a.score);
    const matchesOut = scored.slice(0, Math.min(opts.topK ?? 5, 100));
    return { matches: matchesOut, count: matchesOut.length };
  }

  close() {
    this.db.close();
  }
}
