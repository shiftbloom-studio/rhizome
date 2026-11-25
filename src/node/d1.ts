// SPDX-License-Identifier: AGPL-3.0-or-later
// The part of the D1 API rhizome uses, on a local SQLite file (node:sqlite).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export function toSqlParam(v: unknown): SQLInputValue {
  if (v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof ArrayBuffer) return new Uint8Array(v);
  return v as SQLInputValue;
}

class Statement {
  constructor(
    private db: DatabaseSync,
    readonly query: string,
    readonly params: unknown[] = [],
  ) {}
  bind(...params: unknown[]) {
    return new Statement(this.db, this.query, params);
  }
  private rows() {
    return this.db.prepare(this.query).all(...this.params.map(toSqlParam)) as Record<string, unknown>[];
  }
  async first<T>(column?: string): Promise<T | null> {
    const row = this.rows()[0];
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }
  async all<T>() {
    return { success: true, results: this.rows() as T[], meta: {} };
  }
  async raw<T>() {
    return this.rows().map((r) => Object.values(r)) as T[];
  }
  runSync() {
    const r = this.db.prepare(this.query).run(...this.params.map(toSqlParam));
    return { success: true, results: [], meta: { changes: Number(r.changes), last_row_id: Number(r.lastInsertRowid) } };
  }
  async run() {
    return this.runSync();
  }
}

export class LocalD1 {
  readonly db: DatabaseSync;
  constructor(file: string) {
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;");
  }
  prepare(query: string) {
    return new Statement(this.db, query);
  }
  async batch(statements: Statement[]) {
    this.db.exec("BEGIN");
    try {
      const out = statements.map((s) => s.runSync());
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  async exec(query: string) {
    this.db.exec(query);
    return { count: 0, duration: 0 };
  }

  /** Applies migrations/*.sql in order, tracked in the same table wrangler uses. */
  migrate(dir: string): string[] {
    this.db.exec("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)");
    const done = new Set((this.db.prepare("SELECT name FROM d1_migrations").all() as { name: string }[]).map((r) => r.name));
    const applied: string[] = [];
    for (const name of readdirSync(dir).filter((f) => f.endsWith(".sql")).sort()) {
      if (done.has(name)) continue;
      this.db.exec("BEGIN");
      try {
        this.db.exec(readFileSync(join(dir, name), "utf8"));
        this.db.prepare("INSERT INTO d1_migrations (name) VALUES (?)").run(name);
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw new Error(`migration ${name} failed: ${String(e)}`);
      }
      applied.push(name);
    }
    return applied;
  }
}
