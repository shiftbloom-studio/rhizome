// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MemoryObject: one Durable Object per human. It is the single writer for all
// of that person's memory, whichever agent or provider the write comes from.

import { DurableObject } from "cloudflare:workers";
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_RERANK_MODEL, runAi, type Env } from "./env";
import { MIGRATIONS } from "./schema";
import { can, type Client } from "./scopes";
import { chunk, estimateTokens, ftsQuery, rrf, transcript } from "./text";
import { newId } from "./ids";

export type Trust = "user_explicit" | "user_confirmed" | "agent_inference" | "tool";
export const TRUST_LEVELS: Trust[] = ["user_explicit", "user_confirmed", "agent_inference", "tool"];
export type NoteKind = "preference" | "decision" | "fact" | "learning" | "note";
export const NOTE_KINDS: NoteKind[] = ["preference", "decision", "fact", "learning", "note"];

export interface EpisodeInput {
  scope: string;
  sessionId?: string;
  model?: string;
  tEvent?: number;
  messages?: { role: string; content: string }[];
  text?: string;
  metadata?: Record<string, unknown>;
}

export interface NoteInput {
  scope: string;
  content: string;
  kind?: NoteKind;
  trust?: Trust;
  model?: string;
  tEvent?: number;
}

export interface RecallInput {
  query: string;
  scopes: string[];
  limit?: number;
  budgetTokens?: number;
  rerank?: boolean;
}

export interface MemoryItem {
  id: string;
  kind: "chunk" | "note";
  scope: string;
  content: string;
  noteKind: string | null;
  trust: string;
  agent: string;
  provider: string;
  episodeId: string | null;
  tEvent: string;
  score?: number;
}

export interface Block {
  scope: string;
  label: string;
  value: string;
  description: string | null;
  charLimit: number;
  version: number;
  updatedAt: string;
  updatedBy: string;
}

type Row = Record<string, SqlStorageValue>;

const OUTBOX_BATCH = 50;
const TRUST_WEIGHT: Record<string, number> = { user_explicit: 1, user_confirmed: 0.9, agent_inference: 0.6, tool: 0.4 };

export class MemoryObject extends DurableObject<Env> {
  private sql: SqlStorage;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    ctx.blockConcurrencyWhile(async () => this.migrate());
  }

  private migrate(): void {
    let version = 0;
    try {
      const row = this.sql.exec("SELECT value FROM meta WHERE key = 'schema_version'").toArray()[0];
      version = row ? Number(row.value) : 0;
    } catch {
      version = 0; // meta table does not exist yet
    }
    for (let i = version; i < MIGRATIONS.length; i++) {
      this.sql.exec(MIGRATIONS[i]!);
      this.sql.exec(
        "INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        String(i + 1),
      );
    }
  }

  private userId(client: Client): string {
    const row = this.sql.exec("SELECT value FROM meta WHERE key = 'user_id'").toArray()[0];
    if (row) {
      if (row.value !== client.userId) throw new Error("client does not belong to this memory");
      return String(row.value);
    }
    this.sql.exec("INSERT INTO meta (key, value) VALUES ('user_id', ?)", client.userId);
    return client.userId;
  }

  private audit(client: Client, action: string, detail?: unknown): void {
    this.sql.exec(
      "INSERT INTO audit (at, client_id, action, detail) VALUES (?, ?, ?, ?)",
      Date.now(),
      client.id,
      action,
      detail === undefined ? null : JSON.stringify(detail),
    );
  }

  private async kickOutbox(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 500);
  }

  // ---------------------------------------------------------------- writes

  async addEpisode(client: Client, input: EpisodeInput): Promise<{ id: string; chunks: number }> {
    const userId = this.userId(client);
    const text = input.messages?.length ? transcript(input.messages) : (input.text ?? "").trim();
    if (!text) throw new Error("episode is empty");
    const id = newId();
    const now = Date.now();
    const tEvent = input.tEvent ?? now;
    const r2Key = `users/${userId}/${input.scope}/episodes/${new Date(tEvent).toISOString().slice(0, 7)}/${id}.json`;
    await this.env.EPISODES.put(
      r2Key,
      JSON.stringify({
        id,
        scope: input.scope,
        sessionId: input.sessionId ?? null,
        client: { id: client.id, agent: client.agent, provider: client.provider },
        model: input.model ?? null,
        tEvent: new Date(tEvent).toISOString(),
        messages: input.messages ?? null,
        text: input.messages?.length ? null : text,
        metadata: input.metadata ?? null,
      }),
      { httpMetadata: { contentType: "application/json" } },
    );
    const parts = chunk(text);
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO episodes (id, scope, session_id, client_id, agent, provider, model, t_event, created_at, r2_key, chars, preview)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, input.scope, input.sessionId ?? null, client.id, client.agent, client.provider, input.model ?? null,
        tEvent, now, r2Key, text.length, text.slice(0, 280),
      );
      for (const part of parts) {
        const itemId = newId();
        this.sql.exec(
          `INSERT INTO items (id, kind, episode_id, scope, content, note_kind, trust, client_id, agent, provider, model, t_event, created_at)
           VALUES (?, 'chunk', ?, ?, ?, NULL, 'agent_inference', ?, ?, ?, ?, ?, ?)`,
          itemId, id, input.scope, part, client.id, client.agent, client.provider, input.model ?? null, tEvent, now,
        );
        this.sql.exec("INSERT INTO outbox (op, item_id, created_at) VALUES ('upsert', ?, ?)", itemId, now);
      }
      this.audit(client, "episode.add", { id, scope: input.scope, chunks: parts.length });
    });
    await this.kickOutbox();
    return { id, chunks: parts.length };
  }

  async addNote(client: Client, input: NoteInput): Promise<{ id: string }> {
    this.userId(client);
    const content = input.content.trim();
    if (!content) throw new Error("note is empty");
    const id = newId();
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec(
        `INSERT INTO items (id, kind, episode_id, scope, content, note_kind, trust, client_id, agent, provider, model, t_event, created_at)
         VALUES (?, 'note', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, input.scope, content, input.kind ?? "note", input.trust ?? "agent_inference",
        client.id, client.agent, client.provider, input.model ?? null, input.tEvent ?? now, now,
      );
      this.sql.exec("INSERT INTO outbox (op, item_id, created_at) VALUES ('upsert', ?, ?)", id, now);
      this.audit(client, "note.add", { id, scope: input.scope });
    });
    await this.kickOutbox();
    return { id };
  }

  async putBlock(
    client: Client,
    input: { scope: string; label: string; value: string; description?: string; charLimit?: number },
  ): Promise<Block> {
    this.userId(client);
    const existing = this.sql
      .exec("SELECT char_limit, version FROM blocks WHERE scope = ? AND label = ?", input.scope, input.label)
      .toArray()[0];
    const charLimit = input.charLimit ?? (existing ? Number(existing.char_limit) : 2000);
    if (input.value.length > charLimit) {
      throw new Error(`block value has ${input.value.length} characters, limit is ${charLimit}; condense it first`);
    }
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO blocks (scope, label, value, description, char_limit, version, updated_at, updated_by)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?)
       ON CONFLICT (scope, label) DO UPDATE SET
         value = excluded.value,
         description = COALESCE(excluded.description, blocks.description),
         char_limit = excluded.char_limit,
         version = blocks.version + 1,
         updated_at = excluded.updated_at,
         updated_by = excluded.updated_by`,
      input.scope, input.label, input.value, input.description ?? null, charLimit, now, client.id,
    );
    this.audit(client, "block.put", { scope: input.scope, label: input.label });
    return this.listBlocks(client, [input.scope]).find((b) => b.label === input.label)!;
  }

  // ----------------------------------------------------------------- reads

  listBlocks(client: Client, scopes: string[]): Block[] {
    this.userId(client);
    if (scopes.length === 0) return [];
    const marks = scopes.map(() => "?").join(", ");
    return this.sql
      .exec(`SELECT * FROM blocks WHERE scope IN (${marks}) ORDER BY scope, label`, ...scopes)
      .toArray()
      .map(toBlock);
  }

  /**
   * The cache-friendly core for a system prompt: blocks of the given scopes plus
   * the most trusted recent notes. Changes only when memory changes, so agents
   * keep their prompt cache.
   */
  context(client: Client, scopes: string[], budgetTokens = 1500): { text: string; blocks: Block[]; notes: MemoryItem[]; version: string } {
    const blocks = this.listBlocks(client, scopes);
    let used = blocks.reduce((n, b) => n + estimateTokens(b.value) + 8, 0);
    const marks = scopes.map(() => "?").join(", ");
    const candidates = scopes.length
      ? this.sql
          .exec(
            `SELECT * FROM items WHERE kind = 'note' AND scope IN (${marks})
             ORDER BY CASE trust WHEN 'user_explicit' THEN 0 WHEN 'user_confirmed' THEN 1 WHEN 'agent_inference' THEN 2 ELSE 3 END,
                      t_event DESC
             LIMIT 200`,
            ...scopes,
          )
          .toArray()
          .map(toItem)
      : [];
    const notes: MemoryItem[] = [];
    for (const n of candidates) {
      const cost = estimateTokens(n.content) + 6;
      if (used + cost > budgetTokens) continue;
      used += cost;
      notes.push(n);
    }
    const lines: string[] = [];
    for (const b of blocks) lines.push(`## ${b.label} (${b.scope})\n${b.value}`);
    if (notes.length) {
      lines.push("## Remembered notes");
      for (const n of notes) lines.push(`- [${n.scope}, ${n.noteKind}, ${n.trust}] ${n.content}`);
    }
    const text = lines.join("\n\n");
    return { text, blocks, notes, version: fnv1a(text) };
  }

  async recall(client: Client, input: RecallInput): Promise<{ items: MemoryItem[]; text: string; tookMs: number; sources: Record<string, number> }> {
    const userId = this.userId(client);
    const started = Date.now();
    const scopes = input.scopes;
    if (scopes.length === 0) return { items: [], text: "", tookMs: 0, sources: {} };
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
    const budget = input.budgetTokens ?? 2000;
    const marks = scopes.map(() => "?").join(", ");

    const vectorIds = this.vectorSearch(userId, input.query, scopes).catch(() => [] as string[]);

    const match = ftsQuery(input.query);
    const ftsIds = match
      ? this.sql
          .exec(
            `SELECT items.id AS id FROM items_fts JOIN items ON items.rowid = items_fts.rowid
             WHERE items_fts MATCH ? AND items.scope IN (${marks})
             ORDER BY bm25(items_fts) LIMIT 50`,
            match,
            ...scopes,
          )
          .toArray()
          .map((r) => String(r.id))
      : [];

    const recentIds = this.sql
      .exec(`SELECT id FROM items WHERE scope IN (${marks}) ORDER BY t_event DESC LIMIT 10`, ...scopes)
      .toArray()
      .map((r) => String(r.id));

    const vec = await vectorIds;
    const fused = rrf([vec, ftsIds, recentIds.slice(0, 5)]);
    const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24);
    if (ranked.length === 0) return { items: [], text: "", tookMs: Date.now() - started, sources: { vector: 0, fts: 0, recent: 0 } };

    const idMarks = ranked.map(() => "?").join(", ");
    const rows = new Map(
      this.sql
        .exec(`SELECT * FROM items WHERE id IN (${idMarks}) AND scope IN (${marks})`, ...ranked.map(([id]) => id), ...scopes)
        .toArray()
        .map((r) => [String(r.id), toItem(r)] as const),
    );
    let candidates = ranked.flatMap(([id, s]) => {
      const item = rows.get(id);
      return item ? [{ ...item, score: s }] : [];
    });

    const maxRrf = Math.max(...candidates.map((c) => c.score ?? 0), 1e-9);
    if (input.rerank !== false && candidates.length > 1) {
      try {
        const res = await runAi<{ response?: { id: number; score: number }[] }>(
          this.env.AI,
          this.env.RERANK_MODEL ?? DEFAULT_RERANK_MODEL,
          { query: input.query, contexts: candidates.map((c) => ({ text: c.content.slice(0, 2000) })) },
        );
        // bge-reranker scores are tiny and skewed, so normalise against the best hit.
        const rerank = new Map((res.response ?? []).map((r) => [r.id, r.score]));
        const maxRerank = Math.max(...rerank.values(), 1e-9);
        candidates = candidates.map((c, i) => ({
          ...c,
          score:
            0.6 * ((rerank.get(i) ?? 0) / maxRerank) +
            0.3 * ((c.score ?? 0) / maxRrf) +
            0.1 * (TRUST_WEIGHT[c.trust] ?? 0.5),
        }));
      } catch {
        // reranker unavailable: keep fused order
      }
    }
    candidates.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    const items: MemoryItem[] = [];
    let used = 0;
    for (const c of candidates) {
      if (items.length >= limit) break;
      const cost = estimateTokens(c.content) + 12;
      if (used + cost > budget && items.length > 0) continue;
      used += cost;
      items.push({ ...c, score: Number((c.score ?? 0).toFixed(4)) });
    }

    const now = Date.now();
    if (items.length) {
      const hit = items.map(() => "?").join(", ");
      this.sql.exec(
        `UPDATE items SET access_count = access_count + 1, last_accessed = ? WHERE id IN (${hit})`,
        now,
        ...items.map((i) => i.id),
      );
    }
    this.audit(client, "recall", { scopes, results: items.length });

    const text = items
      .map((i) => `- [${i.scope} · ${i.kind === "note" ? i.noteKind : "episode"} · ${i.agent}/${i.provider} · ${i.tEvent.slice(0, 10)}] ${i.content}`)
      .join("\n");
    return { items, text, tookMs: now - started, sources: { vector: vec.length, fts: ftsIds.length, recent: recentIds.length } };
  }

  private async vectorSearch(userId: string, query: string, scopes: string[]): Promise<string[]> {
    const emb = await runAi<{ data: number[][] }>(this.env.AI, this.env.EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL, {
      text: [query],
    });
    const vector = emb.data[0];
    if (!vector) return [];
    const res = await this.env.VECTORS.query(vector, {
      topK: 50,
      namespace: userId,
      filter: scopes.length === 1 ? { scope: scopes[0]! } : { scope: { $in: scopes } },
    });
    return res.matches.map((m) => m.id);
  }

  listEpisodes(client: Client, scopes: string[], cursor?: number, limit = 50) {
    this.userId(client);
    const marks = scopes.map(() => "?").join(", ");
    const rows = this.sql
      .exec(
        `SELECT id, scope, session_id, agent, provider, model, t_event, chars, preview FROM episodes
         WHERE scope IN (${marks}) AND t_event < ? ORDER BY t_event DESC LIMIT ?`,
        ...scopes,
        cursor ?? Number.MAX_SAFE_INTEGER,
        Math.min(limit, 200),
      )
      .toArray();
    return {
      episodes: rows.map((r) => ({
        id: String(r.id), scope: String(r.scope), sessionId: r.session_id as string | null, agent: String(r.agent),
        provider: String(r.provider), model: r.model as string | null, tEvent: iso(r.t_event), chars: Number(r.chars), preview: String(r.preview),
      })),
      nextCursor: rows.length ? Number(rows[rows.length - 1]!.t_event) : null,
    };
  }

  async getEpisode(client: Client, id: string) {
    this.userId(client);
    const row = this.sql.exec("SELECT r2_key, scope FROM episodes WHERE id = ?", id).toArray()[0];
    if (!row || !can(client, "read", String(row.scope))) return null;
    const obj = await this.env.EPISODES.get(String(row.r2_key));
    return obj ? await obj.json() : null;
  }

  // ---------------------------------------------------------------- forget

  /** Hard delete of one item, or of an episode with all its chunks and its raw copy. */
  async forget(client: Client, id: string): Promise<{ deleted: number }> {
    this.userId(client);
    const episode = this.sql.exec("SELECT scope, r2_key FROM episodes WHERE id = ?", id).toArray()[0];
    const now = Date.now();
    if (episode) {
      if (!can(client, "write", String(episode.scope))) throw new ForbiddenError(String(episode.scope));
      const chunks = this.sql.exec("SELECT id FROM items WHERE episode_id = ?", id).toArray().map((r) => String(r.id));
      this.ctx.storage.transactionSync(() => {
        this.sql.exec("DELETE FROM items WHERE episode_id = ?", id);
        this.sql.exec("DELETE FROM episodes WHERE id = ?", id);
        for (const c of chunks) this.sql.exec("INSERT INTO outbox (op, item_id, created_at) VALUES ('delete', ?, ?)", c, now);
        this.audit(client, "forget.episode", { id, chunks: chunks.length });
      });
      await this.env.EPISODES.delete(String(episode.r2_key));
      await this.kickOutbox();
      return { deleted: chunks.length + 1 };
    }
    const item = this.sql.exec("SELECT scope FROM items WHERE id = ?", id).toArray()[0];
    if (!item) return { deleted: 0 };
    if (!can(client, "write", String(item.scope))) throw new ForbiddenError(String(item.scope));
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM items WHERE id = ?", id);
      this.sql.exec("INSERT INTO outbox (op, item_id, created_at) VALUES ('delete', ?, ?)", id, now);
      this.audit(client, "forget.item", { id });
    });
    await this.kickOutbox();
    return { deleted: 1 };
  }

  /** Everything the person owns, page by page, for export. */
  exportPage(client: Client, after = "", limit = 500) {
    this.userId(client);
    const items = this.sql
      .exec("SELECT * FROM items WHERE id > ? ORDER BY id LIMIT ?", after, Math.min(limit, 1000))
      .toArray()
      .map(toItem);
    const next = items.length ? items[items.length - 1]!.id : null;
    const blocks = after === "" ? this.sql.exec("SELECT * FROM blocks").toArray().map(toBlock) : [];
    // Only what this client may read, e.g. another agent's private scope stays out.
    return {
      items: items.filter((i) => can(client, "read", i.scope)),
      blocks: blocks.filter((b) => can(client, "read", b.scope)),
      next,
    };
  }

  stats(client: Client) {
    this.userId(client);
    const one = (q: string) => Number(this.sql.exec(q).toArray()[0]?.n ?? 0);
    return {
      episodes: one("SELECT COUNT(*) AS n FROM episodes"),
      items: one("SELECT COUNT(*) AS n FROM items"),
      notes: one("SELECT COUNT(*) AS n FROM items WHERE kind = 'note'"),
      blocks: one("SELECT COUNT(*) AS n FROM blocks"),
      pendingVectors: one("SELECT COUNT(*) AS n FROM outbox"),
      bytes: this.ctx.storage.sql.databaseSize,
    };
  }

  // ----------------------------------------------------------------- alarm

  /** Drains the outbox into Vectorize. Retries with backoff; gives up after 8 attempts. */
  async alarm(): Promise<void> {
    const userRow = this.sql.exec("SELECT value FROM meta WHERE key = 'user_id'").toArray()[0];
    if (!userRow) return;
    const userId = String(userRow.value);
    const batch = this.sql
      .exec("SELECT seq, op, item_id, attempts FROM outbox WHERE attempts < 8 ORDER BY seq LIMIT ?", OUTBOX_BATCH)
      .toArray();
    if (batch.length === 0) return;

    const upserts = batch.filter((r) => r.op === "upsert");
    const deletes = batch.filter((r) => r.op === "delete").map((r) => String(r.item_id));
    try {
      if (upserts.length) {
        const marks = upserts.map(() => "?").join(", ");
        const items = this.sql
          .exec(`SELECT id, kind, scope, content FROM items WHERE id IN (${marks})`, ...upserts.map((r) => r.item_id))
          .toArray();
        if (items.length) {
          const emb = await runAi<{ data: number[][] }>(this.env.AI, this.env.EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL, {
            text: items.map((i) => String(i.content).slice(0, 8000)),
          });
          await this.env.VECTORS.upsert(
            items.map((i, n) => ({
              id: String(i.id),
              values: emb.data[n]!,
              namespace: userId,
              metadata: { scope: String(i.scope), kind: String(i.kind) },
            })),
          );
        }
      }
      if (deletes.length) await this.env.VECTORS.deleteByIds(deletes);
      const done = batch.map(() => "?").join(", ");
      this.sql.exec(`DELETE FROM outbox WHERE seq IN (${done})`, ...batch.map((r) => r.seq));
    } catch (err) {
      const done = batch.map(() => "?").join(", ");
      this.sql.exec(`UPDATE outbox SET attempts = attempts + 1 WHERE seq IN (${done})`, ...batch.map((r) => r.seq));
      const attempts = Math.max(...batch.map((r) => Number(r.attempts))) + 1;
      await this.ctx.storage.setAlarm(Date.now() + Math.min(2 ** attempts * 1000, 300_000));
      console.error("outbox drain failed", String(err));
      return;
    }
    const left = Number(this.sql.exec("SELECT COUNT(*) AS n FROM outbox WHERE attempts < 8").toArray()[0]?.n ?? 0);
    if (left > 0) await this.ctx.storage.setAlarm(Date.now() + 100);
  }
}

export class ForbiddenError extends Error {
  constructor(scope: string) {
    super(`no write access to scope ${scope}`);
    this.name = "ForbiddenError";
  }
}

function iso(v: SqlStorageValue | undefined): string {
  return new Date(Number(v)).toISOString();
}

function toItem(r: Row): MemoryItem {
  return {
    id: String(r.id),
    kind: r.kind as "chunk" | "note",
    scope: String(r.scope),
    content: String(r.content),
    noteKind: (r.note_kind as string | null) ?? null,
    trust: String(r.trust),
    agent: String(r.agent),
    provider: String(r.provider),
    episodeId: (r.episode_id as string | null) ?? null,
    tEvent: iso(r.t_event),
  };
}

function toBlock(r: Row): Block {
  return {
    scope: String(r.scope),
    label: String(r.label),
    value: String(r.value),
    description: (r.description as string | null) ?? null,
    charLimit: Number(r.char_limit),
    version: Number(r.version),
    updatedAt: iso(r.updated_at),
    updatedBy: String(r.updated_by),
  };
}

/** Small stable hash so clients can tell whether their cached context changed. */
export function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
