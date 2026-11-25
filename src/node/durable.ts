// SPDX-License-Identifier: AGPL-3.0-or-later
// Durable Objects on Node: one SQLite file per object, one in-process instance
// per name, alarms on timers that survive restarts. Covers what MemoryObject uses.
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { toSqlParam } from "./d1";

const ROW_RETURNING = /^\s*(SELECT|WITH|PRAGMA|VALUES|EXPLAIN)\b|\bRETURNING\b/i;
const MAX_TIMER = 2_000_000_000; // setTimeout's limit is 2^31-1 ms
const ALARM_RETRIES = 6;

function fromSql(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = v instanceof Uint8Array ? v.slice().buffer : v;
  return out;
}

class Cursor<T extends Record<string, unknown>> implements Iterable<T> {
  constructor(private rows: T[]) {}
  toArray(): T[] {
    return this.rows;
  }
  one(): T {
    if (this.rows.length !== 1) throw new Error(`expected exactly one row, got ${this.rows.length}`);
    return this.rows[0]!;
  }
  raw() {
    return this.rows.map((r) => Object.values(r))[Symbol.iterator]();
  }
  [Symbol.iterator]() {
    return this.rows[Symbol.iterator]();
  }
  get rowsRead() {
    return this.rows.length;
  }
  get rowsWritten() {
    return 0;
  }
}

class LocalStorage {
  private alarmTimer: NodeJS.Timeout | null = null;
  private retries = 0;
  readonly sql;

  constructor(
    readonly db: DatabaseSync,
    private runAlarm: () => Promise<void>,
  ) {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    db.exec("CREATE TABLE IF NOT EXISTS _node_alarm (id INTEGER PRIMARY KEY CHECK (id = 1), at INTEGER NOT NULL)");
    this.sql = {
      exec(query: string, ...params: unknown[]) {
        // Schema scripts hold several statements and return nothing: run them as a script.
        if (params.length === 0 && !ROW_RETURNING.test(query)) {
          db.exec(query);
          return new Cursor([]);
        }
        const rows = db.prepare(query).all(...params.map(toSqlParam)) as Record<string, unknown>[];
        return new Cursor(rows.map(fromSql));
      },
      get databaseSize() {
        const r = db.prepare("SELECT page_count * page_size AS n FROM pragma_page_count(), pragma_page_size()").get() as { n: number };
        return Number(r.n);
      },
    };
  }

  transactionSync<T>(fn: () => T): T {
    this.db.exec("SAVEPOINT tx");
    try {
      const r = fn();
      this.db.exec("RELEASE tx");
      return r;
    } catch (e) {
      this.db.exec("ROLLBACK TO tx");
      this.db.exec("RELEASE tx");
      throw e;
    }
  }

  async getAlarm(): Promise<number | null> {
    const row = this.db.prepare("SELECT at FROM _node_alarm WHERE id = 1").get() as { at: number } | undefined;
    return row ? Number(row.at) : null;
  }

  async setAlarm(at: number | Date): Promise<void> {
    const t = typeof at === "number" ? at : at.getTime();
    this.db.prepare("INSERT INTO _node_alarm (id, at) VALUES (1, ?) ON CONFLICT (id) DO UPDATE SET at = excluded.at").run(t);
    this.schedule(t);
  }

  async deleteAlarm(): Promise<void> {
    this.db.exec("DELETE FROM _node_alarm");
    if (this.alarmTimer) clearTimeout(this.alarmTimer);
    this.alarmTimer = null;
  }

  /** Re-arms a stored alarm, e.g. after a restart. */
  async resume(): Promise<void> {
    const at = await this.getAlarm();
    if (at !== null) this.schedule(at);
  }

  private schedule(at: number) {
    if (this.alarmTimer) clearTimeout(this.alarmTimer);
    const wait = Math.max(0, at - Date.now());
    this.alarmTimer = setTimeout(() => (wait > MAX_TIMER ? this.schedule(at) : void this.fire(at)), Math.min(wait, MAX_TIMER));
    this.alarmTimer.unref();
  }

  private async fire(at: number) {
    this.alarmTimer = null;
    // Like Durable Objects: the alarm is cleared before the handler runs, and the handler may set a new one.
    if ((await this.getAlarm()) !== at) return;
    this.db.exec("DELETE FROM _node_alarm");
    try {
      await this.runAlarm();
      this.retries = 0;
    } catch (err) {
      console.error("alarm failed", err);
      if (this.retries++ < ALARM_RETRIES && (await this.getAlarm()) === null) await this.setAlarm(Date.now() + 2 ** this.retries * 1000);
      else this.retries = 0;
    }
  }

  close() {
    if (this.alarmTimer) clearTimeout(this.alarmTimer);
    this.db.close();
  }
}

interface ObjectClass<E, T> {
  new (ctx: DurableObjectState, env: E): T;
}

/**
 * A DurableObjectNamespace stand-in. `get()` returns a stub whose methods are
 * always async, like RPC calls to a real Durable Object.
 */
export class LocalNamespace<E, T extends { alarm?: () => Promise<void> }> {
  private live = new Map<string, { instance: T; storage: LocalStorage; ready: Promise<void>; stub: T }>();

  constructor(
    private dir: string,
    private cls: ObjectClass<E, T>,
    private env: () => E,
  ) {
    mkdirSync(dir, { recursive: true });
  }

  idFromName(name: string) {
    return { name, toString: () => name, equals: (o: { name?: string }) => o?.name === name };
  }

  get(id: { name: string }): T {
    return this.open(id.name).stub;
  }

  /** Opens every object stored on disk, so pending alarms run after a restart. */
  async resumeAll(): Promise<number> {
    let n = 0;
    for (const f of readdirSync(this.dir).filter((x) => x.endsWith(".sqlite"))) {
      const entry = this.open(decodeURIComponent(f.slice(0, -".sqlite".length)));
      await entry.ready;
      await entry.storage.resume();
      n++;
    }
    return n;
  }

  close() {
    for (const e of this.live.values()) e.storage.close();
    this.live.clear();
  }

  private open(name: string) {
    const existing = this.live.get(name);
    if (existing) return existing;
    const file = join(this.dir, `${encodeURIComponent(name)}.sqlite`);
    const fresh = !existsSync(file);
    let ready: Promise<void> = Promise.resolve();
    let instance!: T;
    const storage = new LocalStorage(new DatabaseSync(file), async () => {
      await ready;
      await instance.alarm?.();
    });
    const state = {
      storage,
      id: this.idFromName(name),
      blockConcurrencyWhile: async <R>(fn: () => Promise<R> | R): Promise<R> => {
        const p = Promise.resolve().then(fn);
        ready = p.then(() => undefined);
        return p;
      },
      waitUntil: (p: Promise<unknown>) => void p.catch((e) => console.error(e)),
    };
    instance = new this.cls(state as unknown as DurableObjectState, this.env());
    const stub = new Proxy(instance, {
      get(target, prop, receiver) {
        const v = Reflect.get(target, prop, receiver);
        if (typeof v !== "function") return v;
        return async (...args: unknown[]) => {
          await ready;
          return v.apply(target, args);
        };
      },
    });
    const entry = { instance, storage, ready: Promise.resolve().then(() => ready), stub };
    this.live.set(name, entry);
    if (fresh) console.log(`created memory store ${name}`);
    return entry;
  }
}
