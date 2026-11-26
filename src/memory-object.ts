// SPDX-License-Identifier: AGPL-3.0-or-later
//
// MemoryObject: one Durable Object per human. It is the single writer for all
// of that person's memory, whichever agent or provider the write comes from.

import { DurableObject } from "cloudflare:workers";
import { DEFAULT_EMBEDDING_MODEL, DEFAULT_RERANK_MODEL, runAi, type Env } from "./env";
import { MIGRATIONS } from "./schema";
import { admitNamed, heldTarget, isValidWallName, isWallableScope, wallOf, WALL_LIMIT, type Walls } from "./walls";
import { can, type Client } from "./scopes";
import { chunk, estimateTokens, ftsQuery, roundChunks, rrf, transcript } from "./text";
import { newId } from "./ids";
import { assignFactKeys, confidence, diversify, keywordCoverage, keywordTerms, parseFeatures, shouldAbstain, SIMILARITY_FLOOR } from "./recall";
import { parseTimeWindow } from "./timewindow";
import {
  DEFAULT_EXTRACTION_MODEL,
  DEFAULT_REFLECTION_MODEL,
  DISPUTE_PROMPT,
  DUPLICATE_SIMILARITY,
  EXTRACTION_PROMPT,
  LINK_SIMILARITY,
  NOTE_ENTITIES_PROMPT,
  PROFILE_PROMPT,
  PROJECT_PROMPT,
  RELATED_SIMILARITY,
  RESOLVER_PROMPT,
  TRUST_RANK,
  aiText,
  capTrust,
  closeValidity,
  cosine,
  decodeVector,
  encodeVector,
  entityKey,
  importance,
  nearest,
  parseJsonObject,
  relatedNotes,
  relatedSection,
  settleByTrust,
  shouldArchive,
  targetScope,
  validateExtraction,
  validateNoteEntities,
  validateRelations,
  validateVerdicts,
  type DisputeVerdict,
  type Extraction,
  type Relation,
} from "./intel";

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
  /** How a conversation is cut for search: "fixed" (1,200 characters) or "rounds". Default: the CHUNKING variable, else "fixed". */
  chunking?: "fixed" | "rounds";
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
  /** Up to four more wordings or parts of the question, supplied by the calling agent. */
  queries?: string[];
  /** Time window supplied by the calling agent, epoch milliseconds (from inclusive, to exclusive). */
  from?: number;
  to?: number;
  /** Optional recall steps for this request (see RECALL_FEATURES). Default: the RECALL_FEATURES variable. */
  features?: string[];
  /** Time that words like "last week" are read against (epoch milliseconds). Default: now. */
  referenceTime?: number;
  /**
   * Recall as of this time (epoch milliseconds): notes that were true then,
   * including ones replaced since, and excerpts from before it.
   */
  asOf?: number;
  /**
   * Scopes the call named. Walled projects not in this list are left out (see walls.ts).
   * Leave it out when every requested scope was asked for explicitly.
   */
  named?: string[];
}

export interface RecallEvidence {
  id: string;
  episodeId: string;
  content: string;
  tEvent: string;
}

interface RecallWindow {
  from: number;
  to: number;
  source: "agent" | "query";
  text?: string;
}

export interface RecallResult {
  items: MemoryItem[];
  text: string;
  tookMs: number;
  sources: Record<string, number>;
  /** Set when the abstain step ran: true when nothing was relevant enough to return. */
  abstained?: boolean;
  /** The time window recall was limited to, if any. */
  window?: { from: string; to: string | null; source: "agent" | "query"; text?: string };
  /** Set when recall ran as of a past time. */
  asOf?: string;
  /** What was left out and why, for the calling agent (walls). */
  notices?: string[];
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
  status: string;
  origin: string;
  importance: number;
  confirmations: number;
  supersededBy: string | null;
  /** When the fact became true. */
  validFrom: string | null;
  /** When it stopped being true; null while it still holds. */
  validTo: string | null;
  /** When rhizome stopped treating this row as current (replaced or merged); null while current. */
  expiredAt: string | null;
  score?: number;
  /** Recall only: how sure rhizome is that this result is relevant, 0 to 1. */
  confidence?: number;
  /** Recall only (evidence step): the source excerpt this note was extracted from. */
  evidence?: RecallEvidence;
}

export interface GraphNode {
  id: string;
  type: "note" | "episode" | "entity";
  label: string;
  scope: string | null;
  kind: string | null;
  trust: string | null;
  status: string | null;
  importance: number;
  agent: string | null;
  provider: string | null;
  t: string | null;
  weight: number;
}

export interface GraphEdge {
  source: string;
  target: string;
  kind: string;
  weight: number;
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
const JOBS_PER_ALARM = 3;
const MAX_JOB_ATTEMPTS = 4;
/** Notes compared against when resolving a new fact. Personal memories stay far below this. */
const MAX_CANDIDATES = 5000;
/** Disputed pairs per reflection run that go to the model, in one request. */
const MAX_DISPUTES = 20;
const DAY_MS = 86_400_000;
const RECALLABLE = "('active', 'disputed')";
const SYSTEM_EXTRACTION = "system:extraction";

/**
 * SQL condition on table alias `t` for what recall may return, with its
 * parameters. A window limits by event time. As of a past time, excerpts must
 * be from before it and notes must have been true then, including notes replaced
 * since; merged duplicates and the losing side of a settled dispute carry no end
 * of validity and stay out.
 */
function recallCondition(t: string, window?: { from: number; to: number }, asOf?: number): { sql: string; args: number[] } {
  const parts: string[] = [];
  const args: number[] = [];
  if (asOf === undefined) parts.push(`${t}.status IN ${RECALLABLE}`);
  else {
    parts.push(`(${t}.status IN ${RECALLABLE} OR (${t}.status = 'superseded' AND ${t}.valid_to IS NOT NULL))`);
    parts.push(
      `(CASE WHEN ${t}.kind = 'chunk' THEN ${t}.t_event <= ?
             ELSE (${t}.valid_from IS NULL OR ${t}.valid_from <= ?) AND (${t}.valid_to IS NULL OR ${t}.valid_to > ?) END)`,
    );
    args.push(asOf, asOf, asOf);
  }
  if (window) {
    parts.push(`${t}.t_event >= ? AND ${t}.t_event < ?`);
    args.push(window.from, window.to);
  }
  return { sql: parts.join(" AND "), args };
}
const SYSTEM_REFLECTION = "system:reflection";

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

  /** Makes sure the alarm runs within `delayMs`. */
  private async kick(delayMs = 500): Promise<void> {
    const at = Date.now() + delayMs;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > at) await this.ctx.storage.setAlarm(at);
  }

  private enqueue(kind: "extract" | "reflect", ref: string, delayMs = 0): void {
    const now = Date.now();
    this.sql.exec("INSERT INTO jobs (kind, ref, not_before, created_at) VALUES (?, ?, ?, ?)", kind, ref, now + delayMs, now);
  }

  /**
   * Caps fact extraction per person and UTC day (EXTRACTION_DAILY_LIMIT, default 200),
   * so a chatty or misbehaving agent cannot run up Workers AI usage. Episodes over
   * the cap are still stored and searchable, they just get no extracted notes.
   */
  private takeExtractionBudget(): boolean {
    const limit = Number(this.env.EXTRACTION_DAILY_LIMIT ?? 200);
    const day = new Date().toISOString().slice(0, 10);
    const [d, n] = (this.meta("extraction_budget") ?? "").split("|");
    const used = d === day ? Number(n) || 0 : 0;
    if (Number.isFinite(limit) && used >= limit) return false;
    this.setMeta("extraction_budget", `${day}|${used + 1}`);
    return true;
  }

  private get extractionEnabled(): boolean {
    return (this.env.EXTRACTION ?? "on") !== "off";
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
    const chunking = input.chunking ?? (this.env.CHUNKING === "rounds" ? "rounds" : "fixed");
    const parts = chunking === "rounds" && input.messages?.length ? roundChunks(input.messages) : chunk(text);
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
      if (this.extractionEnabled && text.length >= 40 && this.takeExtractionBudget()) this.enqueue("extract", id, 2_000);
    });
    await this.kick();
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
        `INSERT INTO items (id, kind, episode_id, scope, content, note_kind, trust, client_id, agent, provider, model, t_event, created_at,
                            origin, importance, updated_at)
         VALUES (?, 'note', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, input.scope, content, input.kind ?? "note", input.trust ?? "agent_inference",
        client.id, client.agent, client.provider, input.model ?? null, input.tEvent ?? now, now,
        client.agent === "web" ? "user" : "agent",
        importance({ trust: input.trust ?? "agent_inference", kind: "note", confirmations: 1, accessCount: 0, lastTouched: input.tEvent ?? now }, now),
        now,
      );
      this.sql.exec("INSERT INTO outbox (op, item_id, created_at) VALUES ('upsert', ?, ?)", id, now);
      this.audit(client, "note.add", { id, scope: input.scope });
    });
    await this.kick();
    return { id };
  }

  /**
   * Adds many notes at once, e.g. from an imported CLAUDE.md. Notes whose exact
   * text already exists in the scope are skipped, so importing a file twice is
   * harmless. Near duplicates are merged later by the background resolver.
   */
  async importNotes(
    client: Client,
    input: { scope: string; notes: string[]; kind?: NoteKind; trust?: Trust; source?: string },
  ): Promise<{ added: number; skipped: number; ids: string[] }> {
    this.userId(client);
    if (!can(client, "write", input.scope)) throw new ForbiddenError(input.scope);
    const now = Date.now();
    const trust = input.trust ?? "user_confirmed";
    const ids: string[] = [];
    let skipped = 0;
    this.ctx.storage.transactionSync(() => {
      const existing = new Set(
        this.sql
          .exec("SELECT lower(content) AS c FROM items WHERE kind = 'note' AND scope = ? AND status != 'superseded'", input.scope)
          .toArray()
          .map((r) => String(r.c)),
      );
      for (const raw of input.notes) {
        const content = raw.trim();
        if (!content || existing.has(content.toLowerCase())) {
          skipped++;
          continue;
        }
        existing.add(content.toLowerCase());
        const id = newId();
        this.sql.exec(
          `INSERT INTO items (id, kind, episode_id, scope, content, note_kind, trust, client_id, agent, provider, model, t_event, created_at,
                              origin, importance, updated_at)
           VALUES (?, 'note', NULL, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, 'import', ?, ?)`,
          id, input.scope, content, input.kind ?? "note", trust, client.id, client.agent, client.provider, now, now,
          importance({ trust, kind: "note", confirmations: 1, accessCount: 0, lastTouched: now }, now),
          now,
        );
        this.sql.exec("INSERT INTO outbox (op, item_id, created_at) VALUES ('upsert', ?, ?)", id, now);
        ids.push(id);
      }
      this.audit(client, "notes.import", { scope: input.scope, added: ids.length, skipped, source: input.source ?? null });
    });
    if (ids.length) await this.kick();
    return { added: ids.length, skipped, ids };
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
            `SELECT * FROM items WHERE kind = 'note' AND status = 'active' AND scope IN (${marks})
             ORDER BY CASE trust WHEN 'user_explicit' THEN 0 WHEN 'user_confirmed' THEN 1 WHEN 'agent_inference' THEN 2 ELSE 3 END,
                      importance DESC, t_event DESC
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

  async recall(client: Client, input: RecallInput): Promise<RecallResult> {
    const userId = this.userId(client);
    const started = Date.now();
    const gate = admitNamed(input.scopes, input.named, this.walls());
    const scopes = gate.scopes;
    const notices = gate.notices.length ? { notices: gate.notices } : {};
    if (scopes.length === 0) return { items: [], text: "", tookMs: 0, sources: {}, ...notices };
    const limit = Math.min(Math.max(input.limit ?? 10, 1), 50);
    const budget = input.budgetTokens ?? 2000;
    const features = input.features ? parseFeatures(input.features) : parseFeatures(this.env.RECALL_FEATURES);
    const marks = scopes.map(() => "?").join(", ");
    // Sub-queries from the calling agent (other wordings, parts of a question) widen the candidate pool.
    const queries = [input.query, ...(input.queries ?? [])].map((q) => q.trim()).filter(Boolean).slice(0, 5);
    const terms = queries.map(keywordTerms);

    // Time window: given by the agent, or (feature "time") read from the query. A window from the
    // query is a hint: when nothing falls inside it, recall runs without it.
    let window: RecallWindow | undefined;
    if (input.from !== undefined || input.to !== undefined) {
      window = { from: input.from ?? 0, to: input.to ?? Number.MAX_SAFE_INTEGER, source: "agent" };
    } else if (features.has("time")) {
      const parsed = parseTimeWindow(input.query, input.referenceTime ?? input.asOf ?? started);
      if (parsed) window = { from: parsed.from, to: parsed.to, source: "query", text: parsed.text };
    }

    const queryVectors = this.embed(queries).catch(() => [] as number[][]);
    const vectorIds = queryVectors.then((vs) =>
      Promise.all(vs.map((v) => this.vectorSearch(userId, v, scopes).catch(() => [] as string[]))),
    );

    const asOf = input.asOf;
    const search = (w: RecallWindow | undefined) => {
      const cond = recallCondition("items", w, asOf);
      const fts = queries.map((q) => {
        const match = ftsQuery(q);
        return match
          ? this.sql
              .exec(
                `SELECT items.id AS id FROM items_fts JOIN items ON items.rowid = items_fts.rowid
                 WHERE items_fts MATCH ? AND items.scope IN (${marks}) AND ${cond.sql}
                 ORDER BY bm25(items_fts) LIMIT 50`,
                match,
                ...scopes,
                ...cond.args,
              )
              .toArray()
              .map((r) => String(r.id))
          : [];
      });
      // Feature "keys": excerpts found through the facts extracted from them.
      const keys = features.has("keys")
        ? queries.map((q) => {
            const match = ftsQuery(q);
            return match
              ? this.sql
                  .exec(
                    `SELECT items.id AS id FROM chunk_keys JOIN items ON items.rowid = chunk_keys.rowid
                     WHERE chunk_keys MATCH ? AND items.kind = 'chunk' AND items.scope IN (${marks}) AND ${cond.sql}
                     ORDER BY bm25(chunk_keys) LIMIT 50`,
                    match,
                    ...scopes,
                    ...cond.args,
                  )
                  .toArray()
                  .map((r) => String(r.id))
              : [];
          })
        : [];
      const recent = this.sql
        .exec(`SELECT id FROM items WHERE scope IN (${marks}) AND ${recallCondition("items", w, asOf).sql} ORDER BY t_event DESC LIMIT 10`, ...scopes, ...cond.args)
        .toArray()
        .map((r) => String(r.id));
      return { fts: [...fts, ...keys], recent };
    };

    let { fts: ftsLists, recent: recentIds } = search(window);
    const vecLists = await vectorIds;
    const qvecs = await queryVectors;
    // Inside a window the stored embeddings are scored exactly: the vector index
    // can neither filter by time nor see writes of the last minute or so.
    // The same holds for recall as of a past time.
    const exact = (w: RecallWindow | undefined) => (w || asOf !== undefined ? qvecs.map((v) => this.exactSearch(v, scopes, recallCondition("i", w, asOf))) : []);
    let windowVecLists: string[][] = exact(window);
    if (window?.source === "query" && ftsLists.every((l) => l.length === 0) && windowVecLists.every((l) => l.length === 0)) {
      window = undefined;
      ({ fts: ftsLists, recent: recentIds } = search(undefined));
      windowVecLists = exact(undefined);
    }

    // Superseded or merged memories are replaced by their current version, unless
    // recall runs as of a past time: then the version that was true back then counts.
    const current = (ids: string[]) => (asOf !== undefined ? ids : ids.map((id) => this.currentVersion(id)));
    const fused = rrf([...vecLists.map(current), ...windowVecLists.map(current), ...ftsLists.map(current), recentIds.slice(0, 5)]);
    const ranked = [...fused.entries()].sort((a, b) => b[1] - a[1]).slice(0, 24);
    const vectorCount = vecLists.reduce((n, l) => n + l.length, 0) + windowVecLists.reduce((n, l) => n + l.length, 0);
    const ftsCount = ftsLists.reduce((n, l) => n + l.length, 0);
    const sources = { vector: vectorCount, fts: ftsCount, recent: recentIds.length };
    const asOfOut = asOf !== undefined ? { asOf: iso(asOf) } : {};
    const windowOut = window && { from: iso(window.from), to: window.to >= Number.MAX_SAFE_INTEGER ? null : iso(window.to), source: window.source, ...(window.text ? { text: window.text } : {}) };
    if (ranked.length === 0) {
      return { items: [], text: "", tookMs: Date.now() - started, sources, ...(features.has("abstain") ? { abstained: true } : {}), ...(windowOut ? { window: windowOut } : {}), ...asOfOut };
    }

    const idMarks = ranked.map(() => "?").join(", ");
    const cond = recallCondition("items", window, asOf);
    const rows = new Map(
      this.sql
        .exec(
          `SELECT * FROM items WHERE id IN (${idMarks}) AND scope IN (${marks}) AND ${cond.sql}`,
          ...ranked.map(([id]) => id),
          ...scopes,
          ...cond.args,
        )
        .toArray()
        .map((r) => [String(r.id), toItem(r)] as const),
    );
    const vecs = this.storedVectors([...rows.keys()]);
    let candidates = ranked.flatMap(([id, s]) => {
      const item = rows.get(id);
      if (!item) return [];
      const vec = vecs.get(id) ?? null;
      const similarity = vec && qvecs.length ? Math.max(...qvecs.map((q) => cosine(q, vec))) : null;
      const coverage = Math.max(...terms.map((t) => keywordCoverage(t, item.content)));
      return [{ ...item, score: s, similarity, coverage, vec }];
    });

    if (features.has("abstain") && shouldAbstain(candidates)) {
      this.audit(client, "recall", { scopes, results: 0, abstained: true });
      return { items: [], text: "", tookMs: Date.now() - started, sources, abstained: true, ...(windowOut ? { window: windowOut } : {}), ...asOfOut };
    }

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
            0.1 * c.importance -
            (c.status === "disputed" ? 0.1 : 0),
        }));
      } catch {
        // reranker unavailable: keep fused order
      }
    }
    candidates.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    if (features.has("diversity")) candidates = diversify(candidates);

    const items: MemoryItem[] = [];
    let used = 0;
    for (const c of candidates) {
      if (items.length >= limit) break;
      const cost = estimateTokens(c.content) + 12;
      if (used + cost > budget && items.length > 0) continue;
      used += cost;
      const { similarity, coverage, vec: _vec, ...item } = c;
      items.push({ ...item, score: Number((c.score ?? 0).toFixed(4)), confidence: confidence(similarity, coverage) });
    }

    if (features.has("evidence")) {
      const shown = new Set(items.map((i) => i.id));
      for (const item of items) {
        if (item.kind !== "note") continue;
        const ev = this.bestEvidence(item.id, vecs.get(item.id) ?? null, qvecs, shown);
        if (!ev) continue;
        const cost = estimateTokens(ev.content) + 8;
        if (used + cost > budget) continue;
        used += cost;
        shown.add(ev.id);
        item.evidence = ev;
      }
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
      .map((i) => {
        const head = `- [${i.scope} · ${i.kind === "note" ? i.noteKind : "episode"} · ${i.agent}/${i.provider} · ${i.tEvent.slice(0, 10)}] ${i.content}`;
        return i.evidence ? `${head}\n  source (${i.evidence.tEvent.slice(0, 10)}): ${i.evidence.content}` : head;
      })
      .join("\n");
    return {
      items,
      text,
      tookMs: now - started,
      sources,
      ...(features.has("abstain") ? { abstained: false } : {}),
      ...(windowOut ? { window: windowOut } : {}),
      ...asOfOut,
      ...notices,
    };
  }

  private async vectorSearch(userId: string, vector: number[], scopes: string[]): Promise<string[]> {
    const res = await this.env.VECTORS.query(vector, {
      topK: 50,
      namespace: userId,
      filter: scopes.length === 1 ? { scope: scopes[0]! } : { scope: { $in: scopes } },
    });
    return res.matches.map((m) => m.id);
  }

  /** Top 50 by exact cosine over the stored embeddings of the items that pass `cond` (on alias i). */
  private exactSearch(vector: number[], scopes: string[], cond: { sql: string; args: number[] }): string[] {
    const rows = this.sql
      .exec(
        `SELECT i.id, e.vec FROM items i JOIN embeddings e ON e.item_id = i.id AND e.model = ?
         WHERE i.scope IN (SELECT value FROM json_each(?)) AND ${cond.sql}
         ORDER BY i.t_event DESC LIMIT ?`,
        this.embeddingModel,
        JSON.stringify(scopes),
        ...cond.args,
        MAX_CANDIDATES,
      )
      .toArray()
      .map((r) => ({ id: String(r.id), vec: decodeVector(r.vec as ArrayBuffer) }));
    return nearest(vector, rows, 50, SIMILARITY_FLOOR).map((n) => n.item.id);
  }

  /** Stored embeddings of the given items (current embedding model only). */
  private storedVectors(ids: string[]): Map<string, Float32Array> {
    if (ids.length === 0) return new Map();
    return new Map(
      this.sql
        .exec("SELECT item_id, vec FROM embeddings WHERE model = ? AND item_id IN (SELECT value FROM json_each(?))", this.embeddingModel, JSON.stringify(ids))
        .toArray()
        .map((r) => [String(r.item_id), decodeVector(r.vec as ArrayBuffer)] as const),
    );
  }

  /**
   * The excerpt a note was extracted from that best supports it: among the chunks
   * of its source episodes, the one closest to the note and the query. Falls back
   * to keyword overlap with the note when embeddings are missing.
   */
  private bestEvidence(noteId: string, noteVec: Float32Array | null, qvecs: number[][], skip: Set<string>): RecallEvidence | null {
    const rows = this.sql
      .exec(
        `SELECT c.id, c.content, c.episode_id, c.t_event, e.vec FROM links l
         JOIN items c ON c.episode_id = l.dst AND c.kind = 'chunk'
         LEFT JOIN embeddings e ON e.item_id = c.id AND e.model = ?
         WHERE l.src = ? AND l.kind = 'derived_from' LIMIT 200`,
        this.embeddingModel,
        noteId,
      )
      .toArray()
      .filter((r) => !skip.has(String(r.id)));
    if (rows.length === 0) return null;
    const note = this.sql.exec("SELECT content FROM items WHERE id = ?", noteId).toArray()[0];
    const noteTerms = keywordTerms(String(note?.content ?? ""));
    let best: (typeof rows)[number] | null = null;
    let bestScore = -Infinity;
    for (const r of rows) {
      const vec = r.vec ? decodeVector(r.vec as ArrayBuffer) : null;
      const score =
        vec && noteVec
          ? cosine(noteVec, vec) + (qvecs.length ? Math.max(...qvecs.map((q) => cosine(q, vec))) : 0)
          : keywordCoverage(noteTerms, String(r.content));
      if (score > bestScore) {
        bestScore = score;
        best = r;
      }
    }
    if (!best) return null;
    return { id: String(best.id), episodeId: String(best.episode_id), content: String(best.content), tEvent: iso(best.t_event) };
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
        for (const c of chunks) this.dropDerived(c);
        this.dropDerived(id);
        this.sql.exec("DELETE FROM items WHERE episode_id = ?", id);
        this.sql.exec("DELETE FROM episodes WHERE id = ?", id);
        for (const c of chunks) this.sql.exec("INSERT INTO outbox (op, item_id, created_at) VALUES ('delete', ?, ?)", c, now);
        this.audit(client, "forget.episode", { id, chunks: chunks.length });
        this.dropOrphanEntities();
      });
      await this.env.EPISODES.delete(String(episode.r2_key));
      await this.kick();
      return { deleted: chunks.length + 1 };
    }
    const item = this.sql.exec("SELECT scope FROM items WHERE id = ?", id).toArray()[0];
    if (!item) return { deleted: 0 };
    if (!can(client, "write", String(item.scope))) throw new ForbiddenError(String(item.scope));
    // Fact keys hold the note's wording on its source excerpts: drop them, then rebuild from the notes that stay.
    const sources = this.sql
      .exec("SELECT dst FROM links WHERE src = ? AND kind = 'derived_from'", id)
      .toArray()
      .map((r) => String(r.dst));
    this.ctx.storage.transactionSync(() => {
      for (const ep of sources) {
        this.sql.exec("DELETE FROM chunk_keys WHERE rowid IN (SELECT rowid FROM items WHERE episode_id = ? AND kind = 'chunk')", ep);
      }
      this.dropDerived(id);
      // Anything that pointed at the forgotten item as its newer version becomes current again.
      this.sql.exec("UPDATE items SET status = 'active', superseded_by = NULL, valid_to = NULL, expired_at = NULL WHERE superseded_by = ?", id);
      this.sql.exec("DELETE FROM items WHERE id = ?", id);
      this.sql.exec("INSERT INTO outbox (op, item_id, created_at) VALUES ('delete', ?, ?)", id, now);
      this.audit(client, "forget.item", { id });
      this.dropOrphanEntities();
    });
    for (const ep of sources) this.rebuildFactKeys(ep);
    await this.kick();
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
      disputed: one("SELECT COUNT(*) AS n FROM items WHERE status = 'disputed'"),
      superseded: one("SELECT COUNT(*) AS n FROM items WHERE status = 'superseded'"),
      archived: one("SELECT COUNT(*) AS n FROM items WHERE status = 'archived'"),
      entities: one("SELECT COUNT(*) AS n FROM entities"),
      links: one("SELECT COUNT(*) AS n FROM links"),
      pendingJobs: one("SELECT COUNT(*) AS n FROM jobs WHERE attempts < " + MAX_JOB_ATTEMPTS),
      lastReflection: this.meta("last_reflection_at"),
      bytes: this.ctx.storage.sql.databaseSize,
    };
  }

  // ------------------------------------------------------------ explorer

  /** Nodes and edges for the memory explorer: notes, episodes and the entities they mention. */
  graph(client: Client, scopes: string[], limit = 900): { nodes: GraphNode[]; edges: GraphEdge[]; truncated: boolean } {
    this.userId(client);
    if (scopes.length === 0) return { nodes: [], edges: [], truncated: false };
    const scopeJson = JSON.stringify(scopes);
    const noteLimit = Math.min(Math.max(limit, 50), 2000);
    const notes = this.sql
      .exec(
        `SELECT id, scope, content, note_kind, trust, status, importance, confirmations, agent, provider, t_event FROM items
         WHERE kind = 'note' AND status != 'archived' AND scope IN (SELECT value FROM json_each(?))
         ORDER BY importance DESC, t_event DESC LIMIT ?`,
        scopeJson,
        noteLimit + 1,
      )
      .toArray();
    const truncated = notes.length > noteLimit;
    const episodes = this.sql
      .exec(
        `SELECT id, scope, agent, provider, t_event, preview, chars FROM episodes
         WHERE scope IN (SELECT value FROM json_each(?)) ORDER BY t_event DESC LIMIT ?`,
        scopeJson,
        Math.round(noteLimit / 3),
      )
      .toArray();
    const nodes: GraphNode[] = [];
    for (const n of notes.slice(0, noteLimit)) {
      nodes.push({
        id: String(n.id), type: "note", label: String(n.content).slice(0, 220), scope: String(n.scope), kind: String(n.note_kind ?? "note"),
        trust: String(n.trust), status: String(n.status), importance: Number(n.importance), agent: String(n.agent),
        provider: String(n.provider), t: iso(n.t_event), weight: Number(n.confirmations),
      });
    }
    for (const e of episodes) {
      nodes.push({
        id: String(e.id), type: "episode", label: String(e.preview).slice(0, 220), scope: String(e.scope), kind: "episode",
        trust: null, status: null, importance: 0.3, agent: String(e.agent), provider: String(e.provider), t: iso(e.t_event),
        weight: Number(e.chars),
      });
    }
    const ids = JSON.stringify(nodes.map((n) => n.id));
    const entities = this.sql
      .exec(
        `SELECT e.id, e.name, e.type, e.mentions, e.last_seen, COUNT(*) AS visible FROM mentions m JOIN entities e ON e.id = m.entity_id
         WHERE m.ref IN (SELECT value FROM json_each(?)) GROUP BY e.id ORDER BY visible DESC LIMIT 300`,
        ids,
      )
      .toArray();
    for (const e of entities) {
      nodes.push({
        id: String(e.id), type: "entity", label: String(e.name), scope: null, kind: String(e.type), trust: null, status: null,
        importance: Math.min(1, 0.3 + Math.log2(1 + Number(e.mentions)) / 6), agent: null, provider: null, t: iso(e.last_seen),
        weight: Number(e.mentions),
      });
    }
    const all = JSON.stringify(nodes.map((n) => n.id));
    const edges: GraphEdge[] = this.sql
      .exec(
        `SELECT src, dst, kind, weight FROM links
         WHERE src IN (SELECT value FROM json_each(?1)) AND dst IN (SELECT value FROM json_each(?1))`,
        all,
      )
      .toArray()
      .map((l) => ({ source: String(l.src), target: String(l.dst), kind: String(l.kind), weight: Number(l.weight) }));
    for (const m of this.sql
      .exec(
        `SELECT ref, entity_id FROM mentions
         WHERE ref IN (SELECT value FROM json_each(?1)) AND entity_id IN (SELECT value FROM json_each(?1))`,
        all,
      )
      .toArray()) {
      edges.push({ source: String(m.ref), target: String(m.entity_id), kind: "mentions", weight: 0.5 });
    }
    return { nodes, edges, truncated };
  }

  /** One node with its provenance, neighbours and history, for the explorer's detail panel. */
  async detail(client: Client, id: string) {
    this.userId(client);
    const neighbours = () => {
      const rows = this.sql
        .exec(
          `SELECT l.kind, l.weight, l.src, l.dst,
                  COALESCE(i.content, e.preview) AS label, COALESCE(i.scope, e.scope) AS scope, i.status AS status, i.trust AS trust,
                  CASE WHEN i.id IS NOT NULL THEN 'note' ELSE 'episode' END AS type
           FROM links l
           LEFT JOIN items i ON i.id = CASE WHEN l.src = ?1 THEN l.dst ELSE l.src END
           LEFT JOIN episodes e ON e.id = CASE WHEN l.src = ?1 THEN l.dst ELSE l.src END
           WHERE l.src = ?1 OR l.dst = ?1
           ORDER BY l.weight DESC LIMIT 60`,
          id,
        )
        .toArray();
      return rows
        .filter((r) => r.scope === null || can(client, "read", String(r.scope)))
        .map((r) => ({
          id: String(r.src === id ? r.dst : r.src),
          direction: r.src === id ? "out" : "in",
          kind: String(r.kind),
          weight: Number(r.weight),
          type: String(r.type),
          label: r.label === null ? null : String(r.label).slice(0, 240),
          scope: r.scope === null ? null : String(r.scope),
          status: r.status === null ? null : String(r.status),
          trust: r.trust === null ? null : String(r.trust),
        }));
    };
    const entitiesOf = (ref: string) =>
      this.sql
        .exec("SELECT e.id, e.name, e.type FROM mentions m JOIN entities e ON e.id = m.entity_id WHERE m.ref = ? LIMIT 40", ref)
        .toArray()
        .map((e) => ({ id: String(e.id), name: String(e.name), type: String(e.type) }));

    const item = this.sql.exec("SELECT * FROM items WHERE id = ?", id).toArray()[0];
    if (item) {
      if (!can(client, "read", String(item.scope))) return null;
      return { type: (item.kind === "note" ? "note" : "chunk") as "note" | "chunk", item: toItem(item), neighbours: neighbours(), entities: entitiesOf(id), accessCount: Number(item.access_count) };
    }
    const episode = this.sql.exec("SELECT * FROM episodes WHERE id = ?", id).toArray()[0];
    if (episode) {
      if (!can(client, "read", String(episode.scope))) return null;
      const obj = await this.env.EPISODES.get(String(episode.r2_key));
      const raw = obj ? ((await obj.json()) as { messages?: unknown; text?: unknown }) : null;
      return {
        type: "episode" as const,
        episode: {
          id, scope: String(episode.scope), agent: String(episode.agent), provider: String(episode.provider),
          model: (episode.model as string | null) ?? null, tEvent: iso(episode.t_event), chars: Number(episode.chars),
          messages: raw?.messages ?? null, text: raw?.text ?? null,
        },
        neighbours: neighbours(),
        entities: entitiesOf(id),
      };
    }
    const entity = this.sql.exec("SELECT * FROM entities WHERE id = ?", id).toArray()[0];
    if (entity) {
      const refs = this.sql
        .exec(
          `SELECT m.ref AS id, COALESCE(i.content, e.preview) AS label, COALESCE(i.scope, e.scope) AS scope,
                  CASE WHEN i.id IS NOT NULL THEN 'note' ELSE 'episode' END AS type, COALESCE(i.t_event, e.t_event) AS t
           FROM mentions m LEFT JOIN items i ON i.id = m.ref LEFT JOIN episodes e ON e.id = m.ref
           WHERE m.entity_id = ? ORDER BY t DESC LIMIT 80`,
          id,
        )
        .toArray()
        .filter((r) => r.scope !== null && can(client, "read", String(r.scope)))
        .map((r) => ({ id: String(r.id), label: String(r.label).slice(0, 240), scope: String(r.scope), type: String(r.type), t: iso(r.t) }));
      return {
        type: "entity" as const,
        entity: { id, name: String(entity.name), type: String(entity.type), mentions: Number(entity.mentions), firstSeen: iso(entity.first_seen), lastSeen: iso(entity.last_seen) },
        mentions: refs,
      };
    }
    return null;
  }

  /** The person confirms a memory: it becomes trusted and, if it was disputed, wins the dispute. */
  confirm(client: Client, id: string): MemoryItem | null {
    this.userId(client);
    const row = this.sql.exec("SELECT * FROM items WHERE id = ? AND kind = 'note'", id).toArray()[0];
    if (!row) return null;
    if (!can(client, "write", String(row.scope))) throw new ForbiddenError(String(row.scope));
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      if (TRUST_RANK[String(row.trust)]! < TRUST_RANK.user_confirmed!) {
        this.sql.exec("UPDATE items SET trust = 'user_confirmed' WHERE id = ?", id);
      }
      // A replaced note the person confirms is current again; an end date the fact had on its own stays.
      this.sql.exec(
        `UPDATE items SET valid_to = CASE WHEN status = 'superseded' THEN NULL ELSE valid_to END, expired_at = NULL,
           status = 'active', superseded_by = NULL, updated_at = ?, confirmations = confirmations + 1 WHERE id = ?`,
        now, id,
      );
      // A confirmed side of a dispute supersedes the other side. The other side was wrong, not outdated,
      // so only its record expires; it never had a time when it was true.
      for (const l of this.sql.exec("SELECT dst FROM links WHERE src = ? AND kind = 'contradicts'", id).toArray()) {
        this.supersede(String(l.dst), id, now, false);
      }
      for (const l of this.sql.exec("SELECT src FROM links WHERE dst = ? AND kind = 'contradicts'", id).toArray()) {
        this.supersede(String(l.src), id, now, false);
      }
      this.rescore(id, now);
      this.audit(client, "note.confirm", { id });
    });
    return toItem(this.sql.exec("SELECT * FROM items WHERE id = ?", id).toArray()[0]!);
  }

  /** The person's walls, name -> project scopes. Empty when walls are off. */
  walls(): Walls {
    const out: Walls = {};
    for (const r of this.sql.exec("SELECT wall, scope FROM walls ORDER BY wall, scope").toArray()) {
      (out[String(r.wall)] ??= []).push(String(r.scope));
    }
    return out;
  }

  listWalls(client: Client): { name: string; scopes: string[] }[] {
    this.userId(client);
    return Object.entries(this.walls()).map(([name, scopes]) => ({ name, scopes }));
  }

  /**
   * Puts exactly these project scopes behind the wall `name`. An empty list removes
   * the wall. A scope that is behind another wall has to leave that one first.
   */
  setWall(client: Client, name: string, scopes: string[]): { name: string; scopes: string[] } {
    this.userId(client);
    if (!isValidWallName(name)) throw new Error("wall name must be a lowercase slug");
    const wanted = [...new Set(scopes)];
    const bad = wanted.find((s) => !isWallableScope(s));
    if (bad !== undefined) throw new Error(`only projects can be walled, not ${bad}`);
    const walls = this.walls();
    for (const s of wanted) {
      const other = wallOf(s, walls);
      if (other !== null && other !== name) throw new Error(`${s} is already behind the wall ${other}`);
    }
    if (!walls[name] && wanted.length && Object.keys(walls).length >= WALL_LIMIT) throw new Error(`the limit is ${WALL_LIMIT} walls`);
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      this.sql.exec("DELETE FROM walls WHERE wall = ?", name);
      for (const s of wanted) this.sql.exec("INSERT INTO walls (scope, wall, created_at) VALUES (?, ?, ?)", s, name, now);
    });
    this.audit(client, "wall", { name, scopes: wanted });
    return { name, scopes: wanted.sort() };
  }

  private hold(itemId: string, fromScope: string, toScope: string, via: "extraction" | "remember", now: number): void {
    this.sql.exec(
      "INSERT INTO promotions (item_id, from_scope, to_scope, via, created_at) VALUES (?, ?, ?, ?, ?)",
      itemId, fromScope, toScope, via, now,
    );
  }

  /** Facts kept inside a wall that wanted to go elsewhere, oldest first. Forgotten notes drop out. */
  listHeld(client: Client) {
    this.userId(client);
    return this.sql
      .exec(
        `SELECT p.seq, p.item_id, p.from_scope, p.to_scope, p.via, p.created_at, i.content, i.note_kind, i.status FROM promotions p
         JOIN items i ON i.id = p.item_id
         WHERE p.state = 'held' ORDER BY p.seq LIMIT 500`,
      )
      .toArray()
      .map((r) => ({
        id: Number(r.seq),
        itemId: String(r.item_id),
        content: String(r.content),
        kind: r.note_kind === null ? null : String(r.note_kind),
        status: String(r.status),
        from: String(r.from_scope),
        to: String(r.to_scope),
        via: String(r.via),
        at: iso(r.created_at),
      }));
  }

  /**
   * Decides a held promotion. release moves the note to where it wanted to go;
   * dismiss keeps it in its project for good. Returns null when there is nothing to decide.
   */
  async decideHeld(client: Client, id: number, decision: "release" | "dismiss"): Promise<{ id: number; itemId: string; scope: string } | null> {
    this.userId(client);
    const row = this.sql
      .exec(
        "SELECT p.item_id, p.from_scope, p.to_scope, i.scope FROM promotions p JOIN items i ON i.id = p.item_id WHERE p.seq = ? AND p.state = 'held'",
        id,
      )
      .toArray()[0];
    if (!row) return null;
    const itemId = String(row.item_id);
    const scope = decision === "release" ? String(row.to_scope) : String(row.scope);
    if (!can(client, "write", scope)) throw new ForbiddenError(scope);
    const now = Date.now();
    this.ctx.storage.transactionSync(() => {
      if (decision === "release" && String(row.scope) !== scope) {
        this.sql.exec("UPDATE items SET scope = ?, updated_at = ? WHERE id = ?", scope, now, itemId);
        // The vector index filters by scope: write the new scope there too.
        this.sql.exec("INSERT INTO outbox (op, item_id, created_at) VALUES ('upsert', ?, ?)", itemId, now);
      }
      this.sql.exec("UPDATE promotions SET state = ?, decided_at = ? WHERE seq = ?", decision === "release" ? "released" : "dismissed", now, id);
      this.audit(client, `held.${decision}`, { id: itemId, from: String(row.from_scope), to: String(row.to_scope) });
    });
    if (decision === "release") await this.kick();
    return { id, itemId, scope };
  }

  /** Every scope that holds something, for the explorer's filters. */
  scopes(client: Client): string[] {
    this.userId(client);
    return this.sql
      .exec("SELECT scope FROM items UNION SELECT scope FROM episodes UNION SELECT scope FROM blocks ORDER BY scope")
      .toArray()
      .map((r) => String(r.scope))
      .filter((s) => can(client, "read", s));
  }

  activity(client: Client, limit = 50) {
    this.userId(client);
    return this.sql
      .exec("SELECT at, client_id, action, detail FROM audit ORDER BY seq DESC LIMIT ?", Math.min(Math.max(Number.isFinite(limit) ? Math.trunc(limit) : 50, 1), 200))
      .toArray()
      .map((r) => ({ at: iso(r.at), client: String(r.client_id), action: String(r.action), detail: r.detail ? JSON.parse(String(r.detail)) : null }));
  }

  /**
   * Schedules a reflection run (consolidation, decay, profile distillation). Called nightly and from the explorer.
   * `at` runs it as of that time instead of now, for histories replayed from the past (bench/).
   */
  async requestReflection(client?: Client, at?: number): Promise<{ scheduled: boolean }> {
    if (client) this.userId(client);
    else if (!this.meta("user_id")) return { scheduled: false };
    if (at !== undefined && !Number.isFinite(at)) throw new Error("reflection time must be epoch milliseconds");
    const pending = this.sql.exec("SELECT 1 FROM jobs WHERE kind = 'reflect' AND attempts < ? LIMIT 1", MAX_JOB_ATTEMPTS).toArray()[0];
    if (!pending) this.enqueue("reflect", at === undefined ? "all" : `at:${at}`);
    await this.kick(1_000);
    return { scheduled: true };
  }

  // ----------------------------------------------------------------- alarm

  /**
   * Background work, in order: Vectorize outbox (with local embeddings, links
   * and deduplication of new notes), then due jobs (fact extraction, reflection).
   */
  async alarm(): Promise<void> {
    const userId = this.meta("user_id");
    if (!userId) return;
    const outboxLeft = await this.drainOutbox(userId);
    if (outboxLeft === "retry") return;

    const due = this.sql
      .exec("SELECT seq, kind, ref, attempts FROM jobs WHERE attempts < ? AND not_before <= ? ORDER BY seq LIMIT ?", MAX_JOB_ATTEMPTS, Date.now(), JOBS_PER_ALARM)
      .toArray();
    for (const job of due) {
      try {
        if (job.kind === "extract") await this.extract(String(job.ref));
        else if (job.kind === "reflect") await this.reflect(String(job.ref).startsWith("at:") ? Number(String(job.ref).slice(3)) : Date.now());
        this.sql.exec("DELETE FROM jobs WHERE seq = ?", job.seq);
      } catch (err) {
        const attempts = Number(job.attempts) + 1;
        this.sql.exec(
          "UPDATE jobs SET attempts = ?, not_before = ?, last_error = ? WHERE seq = ?",
          attempts,
          Date.now() + Math.min(2 ** attempts * 30_000, 3_600_000),
          String(err).slice(0, 500),
          job.seq,
        );
        console.error(`job ${job.kind} ${job.ref} failed`, String(err));
      }
    }

    const outboxPending = Number(this.sql.exec("SELECT COUNT(*) AS n FROM outbox WHERE attempts < 8").toArray()[0]?.n ?? 0);
    if (outboxPending > 0) {
      await this.ctx.storage.setAlarm(Date.now() + 100);
      return;
    }
    const next = this.sql.exec("SELECT MIN(not_before) AS t FROM jobs WHERE attempts < ?", MAX_JOB_ATTEMPTS).toArray()[0]?.t;
    if (next !== null && next !== undefined) await this.ctx.storage.setAlarm(Math.max(Number(next), Date.now() + 100));
  }

  /** Writes pending items to Vectorize, reusing stored embeddings. Returns "retry" when it backed off. */
  private async drainOutbox(userId: string): Promise<"ok" | "retry"> {
    const batch = this.sql
      .exec("SELECT seq, op, item_id, attempts FROM outbox WHERE attempts < 8 ORDER BY seq LIMIT ?", OUTBOX_BATCH)
      .toArray();
    if (batch.length === 0) return "ok";
    const model = this.embeddingModel;
    const upserts = [...new Set(batch.filter((r) => r.op === "upsert").map((r) => String(r.item_id)))];
    const deletes = batch.filter((r) => r.op === "delete").map((r) => String(r.item_id));
    const seqs = JSON.stringify(batch.map((r) => Number(r.seq)));
    try {
      const fresh: string[] = [];
      if (upserts.length) {
        const items = this.sql
          .exec(
            `SELECT i.id, i.kind, i.scope, i.content, e.vec FROM items i LEFT JOIN embeddings e ON e.item_id = i.id AND e.model = ?
             WHERE i.id IN (SELECT value FROM json_each(?))`,
            model,
            JSON.stringify(upserts),
          )
          .toArray();
        const missing = items.filter((i) => i.vec === null);
        const vectors = new Map<string, number[]>();
        for (const i of items) if (i.vec !== null) vectors.set(String(i.id), Array.from(decodeVector(i.vec as ArrayBuffer)));
        if (missing.length) {
          const emb = await this.embed(missing.map((i) => String(i.content)));
          missing.forEach((i, n) => {
            vectors.set(String(i.id), emb[n]!);
            this.sql.exec(
              "INSERT INTO embeddings (item_id, model, vec) VALUES (?, ?, ?) ON CONFLICT (item_id) DO UPDATE SET model = excluded.model, vec = excluded.vec",
              i.id, model, encodeVector(emb[n]!),
            );
            if (i.kind === "note") fresh.push(String(i.id));
          });
        }
        if (items.length) {
          await this.env.VECTORS.upsert(
            items.map((i) => ({
              id: String(i.id),
              values: vectors.get(String(i.id))!,
              namespace: userId,
              metadata: { scope: String(i.scope), kind: String(i.kind) },
            })),
          );
        }
      }
      if (deletes.length) await this.env.VECTORS.deleteByIds(deletes);
      this.sql.exec("DELETE FROM outbox WHERE seq IN (SELECT value FROM json_each(?))", seqs);
      // Notes written directly by agents: merge exact repeats, link the rest.
      for (const id of fresh) this.settleNote(id);
      return "ok";
    } catch (err) {
      this.sql.exec("UPDATE outbox SET attempts = attempts + 1 WHERE seq IN (SELECT value FROM json_each(?))", seqs);
      const attempts = Math.max(...batch.map((r) => Number(r.attempts))) + 1;
      await this.ctx.storage.setAlarm(Date.now() + Math.min(2 ** attempts * 1000, 300_000));
      console.error("outbox drain failed", String(err));
      return "retry";
    }
  }

  private get embeddingModel(): string {
    return this.env.EMBEDDING_MODEL ?? DEFAULT_EMBEDDING_MODEL;
  }

  private async embed(texts: string[]): Promise<number[][]> {
    const out: number[][] = [];
    for (let i = 0; i < texts.length; i += 50) {
      const emb = await runAi<{ data: number[][] }>(this.env.AI, this.embeddingModel, { text: texts.slice(i, i + 50).map((t) => t.slice(0, 8000)) });
      out.push(...emb.data);
    }
    return out;
  }

  private async generate(model: string, system: string, user: string, maxTokens: number, extra?: Record<string, unknown>): Promise<string> {
    const res = await runAi<unknown>(this.env.AI, model, {
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      max_tokens: maxTokens,
      temperature: 0,
      ...extra,
    });
    return aiText(res);
  }

  /** Asks a model for JSON, validates it and retries once with the error. */
  private async generateJson<T>(
    model: string,
    system: string,
    user: string,
    validate: (raw: unknown) => T,
    maxTokens = 3000,
    extra?: Record<string, unknown>,
  ): Promise<T> {
    let prompt = user;
    let lastError = "";
    for (let attempt = 0; attempt < 2; attempt++) {
      const text = await this.generate(model, system, prompt, maxTokens, extra);
      try {
        return validate(parseJsonObject(text));
      } catch (err) {
        lastError = String(err);
        prompt = `${user}\n\nYour previous answer could not be used (${lastError}). Answer again with only the JSON object.`;
      }
    }
    throw new Error(`model output invalid twice: ${lastError}`);
  }

  // ------------------------------------------------------ fact extraction

  /** Notes of the given scopes with their embeddings, for exact similarity. */
  private candidates(scopes: string[], excludeIds: string[] = []) {
    return this.sql
      .exec(
        `SELECT i.id, i.scope, i.content, i.trust, i.status, i.valid_from, e.vec FROM items i JOIN embeddings e ON e.item_id = i.id AND e.model = ?
         WHERE i.kind = 'note' AND i.status IN ${RECALLABLE} AND i.scope IN (SELECT value FROM json_each(?))
           AND i.id NOT IN (SELECT value FROM json_each(?))
         ORDER BY i.importance DESC LIMIT ?`,
        this.embeddingModel,
        JSON.stringify(scopes),
        JSON.stringify(excludeIds),
        MAX_CANDIDATES,
      )
      .toArray()
      .map((r) => ({
        id: String(r.id), scope: String(r.scope), content: String(r.content), trust: String(r.trust),
        validFrom: r.valid_from == null ? null : Number(r.valid_from), vec: decodeVector(r.vec as ArrayBuffer),
      }));
  }

  /**
   * Turns one episode into notes: the extraction model proposes facts, exact
   * repeats are merged, near matches go to the resolver (same, update,
   * contradiction, new), and the trust ladder decides who wins a conflict.
   */
  private async extract(episodeId: string): Promise<void> {
    const ep = this.sql.exec("SELECT * FROM episodes WHERE id = ?", episodeId).toArray()[0];
    if (!ep) return; // forgotten in the meantime
    const obj = await this.env.EPISODES.get(String(ep.r2_key));
    if (!obj) return;
    const raw = (await obj.json()) as { messages?: { role: string; content: string }[] | null; text?: string | null };
    const messages = raw.messages?.length ? raw.messages : [{ role: "text", content: String(raw.text ?? "") }];
    const hasUser = messages.some((m) => m.role === "user");
    const tEvent = Number(ep.t_event);
    const when = new Date(tEvent);
    let body = messages.map((m) => `[${m.role}] ${m.content}`).join("\n");
    if (body.length > 30_000) body = `${body.slice(0, 15_000)}\n[…]\n${body.slice(-15_000)}`;
    // Memory first: the notes most related to this episode go into the same
    // prompt, so the model can say which of them a fact repeats, updates or contradicts.
    const related = await this.relatedToEpisode(String(ep.scope), messages, body);
    const user =
      `Episode time: ${when.toISOString()} (${when.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" })})\n` +
      `Agent: ${ep.agent} (provider ${ep.provider})\nEpisode scope: ${ep.scope}\nMessages:\n${body}` +
      relatedSection(related);
    const model = this.env.EXTRACTION_MODEL ?? DEFAULT_EXTRACTION_MODEL;
    const extraction = await this.generateJson<Extraction>(model, EXTRACTION_PROMPT, user, validateExtraction);
    const now = Date.now();
    if (extraction.facts.length === 0 && extraction.entities.length === 0) {
      this.sql.exec("INSERT INTO audit (at, client_id, action, detail) VALUES (?, ?, 'extract.none', ?)", now, SYSTEM_EXTRACTION, JSON.stringify({ episodeId }));
      return;
    }

    // Rule 3 of walls: a fact from a walled conversation stays inside its wall. Where
    // the extractor wanted it to go is kept as a held promotion (see promotions).
    const walls = this.walls();
    const facts = extraction.facts.map((f) => {
      const target = targetScope(f.scope, String(ep.scope));
      const held = heldTarget(String(ep.scope), target, walls);
      return { ...f, scope: held ? String(ep.scope) : target, heldFor: held, trust: capTrust(f.trust, hasUser) };
    });
    const vectors = facts.length ? await this.embed(facts.map((f) => f.statement)) : [];
    const pool = this.candidates([...new Set(facts.map((f) => f.scope))]);

    type Plan = { fact: (typeof facts)[number]; vec: number[]; relation: Relation; target?: (typeof pool)[number]; similarity: number };
    const plans: Plan[] = [];
    const ask: Plan[] = [];
    let labelled = 0;
    facts.forEach((fact, n) => {
      const vec = vectors[n]!;
      // The same fact twice in one episode counts once.
      if (plans.some((p) => p.fact.scope === fact.scope && nearest(vec, [{ vec: p.vec }], 1, DUPLICATE_SIMILARITY).length)) return;
      // The extraction model labelled the fact against a related note of the same scope.
      const shown = fact.related !== null ? related[fact.related] : undefined;
      if (fact.relation && fact.relation !== "new" && shown && shown.scope === fact.scope) {
        const similarity = cosine(vec, shown.vec);
        // The label needs real overlap: "same" drops the new wording, and an update
        // or contradiction against a wrongly numbered note would hide or dispute an
        // unrelated one. Below that the fallback decides.
        if (similarity >= LINK_SIMILARITY) {
          labelled++;
          plans.push({ fact, vec, relation: fact.relation, target: shown, similarity });
          return;
        }
      }
      // Fallback: cosine thresholds and the separate resolver, as before.
      const best = nearest(vec, pool.filter((c) => c.scope === fact.scope), 1, RELATED_SIMILARITY)[0];
      const plan: Plan = { fact, vec, relation: "new", target: best?.item, similarity: best?.similarity ?? 0 };
      if (best && best.similarity >= DUPLICATE_SIMILARITY) plan.relation = "same";
      else if (best && fact.relation === "new" && related.some((r) => r.id === best.item.id)) labelled++; // already compared, nothing to resolve
      else if (best) ask.push(plan);
      plans.push(plan);
    });

    if (ask.length) {
      const pairs = ask.map((p, i) => `Pair ${i}\nEXISTING: ${p.target!.content}\nNEW: ${p.fact.statement}`).join("\n\n");
      try {
        const relations = await this.generateJson(model, RESOLVER_PROMPT, pairs, (r) => validateRelations(r, ask.length), 1500);
        ask.forEach((p, i) => (p.relation = relations[i]!));
      } catch (err) {
        console.error("resolver failed, keeping facts as new", String(err));
      }
    }

    const created: string[] = [];
    const counts: Record<string, number> = { same: 0, update: 0, contradicts: 0, new: 0 };
    this.ctx.storage.transactionSync(() => {
      const entityIds = this.upsertEntities(extraction.entities, tEvent);
      for (const id of entityIds.values()) this.mention(episodeId, id);
      for (const p of plans) {
        let relation = p.relation;
        const target = p.target;
        if (target) {
          const newRank = TRUST_RANK[p.fact.trust] ?? 1;
          const oldRank = TRUST_RANK[target.trust] ?? 1;
          // Trust ladder: a guess never replaces what the person said, and what the person said settles a dispute.
          if (relation === "update" && newRank < oldRank) relation = "contradicts";
          if (relation === "contradicts" && newRank > oldRank && newRank >= TRUST_RANK.user_confirmed!) relation = "update";
        }
        counts[relation] = (counts[relation] ?? 0) + 1;
        if (relation === "same" && target) {
          this.sql.exec(
            `UPDATE items SET confirmations = confirmations + 1, updated_at = ?,
               trust = CASE WHEN ? > (CASE trust WHEN 'user_explicit' THEN 3 WHEN 'user_confirmed' THEN 2 WHEN 'agent_inference' THEN 1 ELSE 0 END) THEN ? ELSE trust END
             WHERE id = ?`,
            now, TRUST_RANK[p.fact.trust] ?? 1, p.fact.trust, target.id,
          );
          this.link(target.id, episodeId, "derived_from", 1, now);
          for (const name of p.fact.entities) {
            const e = entityIds.get(entityKey(name));
            if (e) this.mention(target.id, e);
          }
          this.rescore(target.id, now);
          continue;
        }
        const id = newId();
        created.push(id);
        // A fact that already ended before the episode ("used X until March") has an unknown start.
        const endedBefore = p.fact.validFrom === null && p.fact.validTo !== null && p.fact.validTo <= tEvent;
        const validFrom = endedBefore ? null : (p.fact.validFrom ?? tEvent);
        const validTo = p.fact.validTo !== null && (validFrom === null || p.fact.validTo > validFrom) ? p.fact.validTo : null;
        const tFact = p.fact.validFrom ?? tEvent;
        this.sql.exec(
          `INSERT INTO items (id, kind, episode_id, scope, content, note_kind, trust, client_id, agent, provider, model, t_event, created_at,
                              origin, importance, updated_at, status, valid_from, valid_to)
           VALUES (?, 'note', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'extracted', ?, ?, ?, ?, ?)`,
          id, p.fact.scope, p.fact.statement, p.fact.kind, p.fact.trust, ep.client_id, ep.agent, ep.provider, model,
          tFact, now,
          importance({ trust: p.fact.trust, kind: "note", confirmations: 1, accessCount: 0, lastTouched: tFact }, now),
          now, relation === "contradicts" ? "disputed" : "active",
          validFrom, validTo,
        );
        this.sql.exec(
          "INSERT INTO embeddings (item_id, model, vec) VALUES (?, ?, ?)",
          id, this.embeddingModel, encodeVector(p.vec),
        );
        this.sql.exec("INSERT INTO outbox (op, item_id, created_at) VALUES ('upsert', ?, ?)", id, now);
        this.link(id, episodeId, "derived_from", 1, now);
        if (p.fact.heldFor) this.hold(id, p.fact.scope, p.fact.heldFor, "extraction", now);
        if (relation === "update" && target) this.supersede(target.id, id, now);
        if (relation === "contradicts" && target) this.link(id, target.id, "contradicts", p.similarity, now);
        for (const name of p.fact.entities) {
          const e = entityIds.get(entityKey(name));
          if (e) this.mention(id, e);
        }
      }
      for (const id of created) this.linkSimilar(id, now);
      this.sql.exec(
        "INSERT INTO audit (at, client_id, action, detail) VALUES (?, ?, 'extract', ?)",
        now, SYSTEM_EXTRACTION, JSON.stringify({ episodeId, model, ...counts, labelled, resolved: ask.length, related: related.length, entities: extraction.entities.length }),
      );
    });
    this.storeFactKeys(episodeId, facts.map((f) => f.statement), vectors);
    if (created.length) await this.kick(100);
  }

  /** Fact keys for up to 200 episodes that have derived notes but no keys yet. Returns how many got keys. */
  private backfillFactKeys(): number {
    const episodes = this.sql
      .exec(
        `SELECT ep.id FROM episodes ep
         WHERE EXISTS (SELECT 1 FROM links l WHERE l.dst = ep.id AND l.kind = 'derived_from')
           AND NOT EXISTS (SELECT 1 FROM items c JOIN chunk_keys k ON k.rowid = c.rowid WHERE c.episode_id = ep.id)
         ORDER BY ep.t_event DESC LIMIT 200`,
      )
      .toArray();
    let keyed = 0;
    for (const ep of episodes) if (this.rebuildFactKeys(String(ep.id))) keyed++;
    return keyed;
  }

  /** Fact keys of one episode from the notes currently derived from it. False when it has none. */
  private rebuildFactKeys(episodeId: string): boolean {
    const notes = this.sql
      .exec(
        `SELECT n.content, e.vec FROM links l JOIN items n ON n.id = l.src AND n.kind = 'note'
         LEFT JOIN embeddings e ON e.item_id = n.id AND e.model = ?
         WHERE l.dst = ? AND l.kind = 'derived_from' LIMIT 50`,
        this.embeddingModel,
        episodeId,
      )
      .toArray();
    if (notes.length === 0) return false;
    const vectors = notes.map((n) => (n.vec ? Array.from(decodeVector(n.vec as ArrayBuffer)) : undefined));
    // assignFactKeys uses cosine only when every fact and excerpt has an embedding.
    this.storeFactKeys(episodeId, notes.map((n) => String(n.content)), vectors.every(Boolean) ? (vectors as number[][]) : []);
    return true;
  }

  /**
   * Fact keys: each extracted fact is filed under the excerpt of its episode it
   * most likely came from (closest stored embedding, or keyword overlap when the
   * excerpt has none yet), so recall can find excerpts through their facts. No
   * model call.
   */
  private storeFactKeys(episodeId: string, statements: string[], vectors: (number[] | undefined)[]): void {
    if (statements.length === 0) return;
    const chunks = this.sql
      .exec(
        `SELECT c.rowid AS rid, c.content, e.vec FROM items c LEFT JOIN embeddings e ON e.item_id = c.id AND e.model = ?
         WHERE c.episode_id = ? AND c.kind = 'chunk'`,
        this.embeddingModel,
        episodeId,
      )
      .toArray()
      .map((r) => ({ rid: Number(r.rid), content: String(r.content), vec: r.vec ? decodeVector(r.vec as ArrayBuffer) : null }));
    if (chunks.length === 0) return;
    const keys = assignFactKeys(statements, vectors, chunks);
    this.ctx.storage.transactionSync(() => {
      for (const [rid, list] of keys) {
        this.sql.exec("DELETE FROM chunk_keys WHERE rowid = ?", rid);
        this.sql.exec("INSERT INTO chunk_keys (rowid, keys) VALUES (?, ?)", rid, list.join("\n"));
      }
    });
  }

  /**
   * Up to 12 current notes most related to an episode, from full-text search and
   * the stored embeddings (one embedding call for the episode, no vector index).
   */
  private async relatedToEpisode(scope: string, messages: { role: string; content: string }[], body: string) {
    const scopes = [...new Set([scope, "profile"])];
    const pool = this.candidates(scopes);
    if (pool.length === 0) return [];
    const said = messages.filter((m) => m.role === "user").map((m) => m.content).join("\n") || body;
    const match = ftsQuery(said.slice(-4000));
    const ftsIds = match
      ? this.sql
          .exec(
            `SELECT items.id AS id FROM items_fts JOIN items ON items.rowid = items_fts.rowid
             WHERE items_fts MATCH ? AND items.kind = 'note' AND items.status IN ${RECALLABLE}
               AND items.scope IN (SELECT value FROM json_each(?))
             ORDER BY bm25(items_fts) LIMIT 24`,
            match,
            JSON.stringify(scopes),
          )
          .toArray()
          .map((r) => String(r.id))
      : [];
    let episodeVec: number[] | null = null;
    try {
      const text = said.length > 2000 ? `${said.slice(0, 1000)}\n${said.slice(-1000)}` : said;
      episodeVec = (await this.embed([text]))[0] ?? null;
    } catch (err) {
      console.error("episode embedding failed, related notes from full text only", String(err));
    }
    return relatedNotes(episodeVec, pool, ftsIds);
  }

  /** Inserts or bumps entities, returns entity ids by key. */
  private upsertEntities(entities: Extraction["entities"], seenAt: number): Map<string, string> {
    const ids = new Map<string, string>();
    for (const e of entities) {
      const key = entityKey(e.name);
      if (!key) continue;
      const existing = this.sql.exec("SELECT id FROM entities WHERE key = ?", key).toArray()[0];
      if (existing) {
        this.sql.exec(
          "UPDATE entities SET mentions = mentions + 1, last_seen = MAX(last_seen, ?), type = CASE WHEN type = 'concept' THEN ? ELSE type END WHERE id = ?",
          seenAt, e.type, existing.id,
        );
        ids.set(key, String(existing.id));
      } else {
        const id = newId();
        this.sql.exec(
          "INSERT INTO entities (id, key, name, type, mentions, first_seen, last_seen) VALUES (?, ?, ?, ?, 1, ?, ?)",
          id, key, e.name, e.type, seenAt, seenAt,
        );
        ids.set(key, id);
      }
    }
    return ids;
  }

  private mention(ref: string, entityId: string): void {
    this.sql.exec("INSERT OR IGNORE INTO mentions (ref, entity_id) VALUES (?, ?)", ref, entityId);
  }

  private link(src: string, dst: string, kind: string, weight: number, now: number): void {
    this.sql.exec(
      "INSERT INTO links (src, dst, kind, weight, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT (src, dst, kind) DO UPDATE SET weight = MAX(weight, excluded.weight)",
      src, dst, kind, Math.round(weight * 1000) / 1000, now,
    );
  }

  /**
   * Replaces a note with a newer one. The old note stays, so the history of how a
   * memory changed can still be read: it gets status superseded, its record
   * expires now and, for an update over time (`endValidity`), its validity
   * interval closes where the new note's starts.
   */
  private supersede(oldId: string, newId_: string, now: number, endValidity = true): void {
    const old = this.sql.exec("SELECT valid_from FROM items WHERE id = ?", oldId).toArray()[0];
    const next = this.sql.exec("SELECT valid_from FROM items WHERE id = ?", newId_).toArray()[0];
    const validTo = endValidity
      ? closeValidity(old?.valid_from == null ? null : Number(old.valid_from), next?.valid_from == null ? null : Number(next.valid_from), now)
      : null;
    this.sql.exec(
      `UPDATE items SET status = 'superseded', superseded_by = ?, updated_at = ?, expired_at = COALESCE(expired_at, ?),
         valid_to = CASE WHEN ? IS NULL THEN valid_to ELSE COALESCE(valid_to, ?) END
       WHERE id = ?`,
      newId_, now, now, validTo, validTo, oldId,
    );
    this.link(newId_, oldId, "supersedes", 1, now);
  }

  /** Follows superseded_by to the current version of a memory (at most 8 steps). */
  private currentVersion(id: string): string {
    let current = id;
    for (let i = 0; i < 8; i++) {
      const row = this.sql.exec("SELECT superseded_by FROM items WHERE id = ? AND status = 'superseded'", current).toArray()[0];
      if (!row?.superseded_by) return current;
      current = String(row.superseded_by);
    }
    return current;
  }

  /** "similar" edges from one note to its closest neighbours in the same scope. */
  private linkSimilar(id: string, now: number, pools?: Map<string, ReturnType<MemoryObject["candidates"]>>): void {
    const row = this.sql
      .exec("SELECT i.scope, e.vec FROM items i JOIN embeddings e ON e.item_id = i.id WHERE i.id = ?", id)
      .toArray()[0];
    if (!row) return;
    const vec = decodeVector(row.vec as ArrayBuffer);
    const scope = String(row.scope);
    // A batch (reflection) shares one candidate list per scope instead of reading all vectors per note.
    let pool = pools?.get(scope);
    if (pools && !pool) pools.set(scope, (pool = this.candidates([scope, "profile"])));
    const candidates = pool ? pool.filter((c) => c.id !== id) : this.candidates([scope, "profile"], [id]);
    const near = nearest(vec, candidates, 5, LINK_SIMILARITY);
    for (const n of near) {
      if (n.similarity >= DUPLICATE_SIMILARITY) continue; // merges handle these
      this.link(id, n.item.id, "similar", n.similarity, now);
    }
  }

  /** A note an agent wrote directly: merge it into an existing equal note, otherwise link it. */
  private settleNote(id: string): void {
    const row = this.sql
      .exec("SELECT i.scope, i.trust, i.status, e.vec FROM items i JOIN embeddings e ON e.item_id = i.id WHERE i.id = ?", id)
      .toArray()[0];
    if (!row || row.status !== "active") return;
    const now = Date.now();
    const vec = decodeVector(row.vec as ArrayBuffer);
    const dup = nearest(vec, this.candidates([String(row.scope)], [id]), 1, DUPLICATE_SIMILARITY)[0];
    this.ctx.storage.transactionSync(() => {
      if (dup) this.merge(dup.item.id, id, now);
      else this.linkSimilar(id, now);
    });
  }

  /** Merges `loser` into `survivor`: confirmations add up, the higher trust wins, edges move over. */
  private merge(survivor: string, loser: string, now: number): void {
    const s = this.sql.exec("SELECT trust, confirmations FROM items WHERE id = ?", survivor).toArray()[0];
    const l = this.sql.exec("SELECT trust, confirmations FROM items WHERE id = ?", loser).toArray()[0];
    if (!s || !l) return;
    const trust = (TRUST_RANK[String(l.trust)] ?? 0) > (TRUST_RANK[String(s.trust)] ?? 0) ? String(l.trust) : String(s.trust);
    this.sql.exec(
      "UPDATE items SET trust = ?, confirmations = confirmations + ?, updated_at = ? WHERE id = ?",
      trust, Number(l.confirmations), now, survivor,
    );
    // A merged duplicate is still true (it lives on in the survivor); only its record expires.
    this.sql.exec("UPDATE items SET status = 'superseded', superseded_by = ?, updated_at = ?, expired_at = COALESCE(expired_at, ?) WHERE id = ?", survivor, now, now, loser);
    this.sql.exec("UPDATE OR IGNORE mentions SET ref = ? WHERE ref = ?", survivor, loser);
    this.sql.exec("UPDATE OR IGNORE links SET src = ? WHERE src = ? AND kind IN ('derived_from', 'similar')", survivor, loser);
    this.link(loser, survivor, "merged_into", 1, now);
    this.rescore(survivor, now);
  }

  private rescore(id: string, now: number): void {
    const r = this.sql.exec("SELECT kind, trust, confirmations, access_count, t_event, updated_at, last_accessed FROM items WHERE id = ?", id).toArray()[0];
    if (!r) return;
    const value = importance(
      {
        trust: String(r.trust), kind: r.kind as "chunk" | "note", confirmations: Number(r.confirmations), accessCount: Number(r.access_count),
        lastTouched: Math.max(Number(r.t_event), Number(r.updated_at ?? 0), Number(r.last_accessed ?? 0)),
      },
      now,
    );
    this.sql.exec("UPDATE items SET importance = ? WHERE id = ?", value, id);
  }

  /** Forgotten memories take the names only they mentioned with them. */
  private dropOrphanEntities(): void {
    this.sql.exec("DELETE FROM entities WHERE id NOT IN (SELECT entity_id FROM mentions)");
  }

  /** Removes derived rows of an item or episode before it is deleted. */
  private dropDerived(id: string): void {
    this.sql.exec("DELETE FROM embeddings WHERE item_id = ?", id);
    this.sql.exec("DELETE FROM links WHERE src = ? OR dst = ?", id, id);
    this.sql.exec("DELETE FROM mentions WHERE ref = ?", id);
    this.sql.exec("DELETE FROM jobs WHERE ref = ?", id);
  }

  // ------------------------------------------------------------ reflection

  /**
   * Sleep-time work on Workers AI: decay and importance for every memory,
   * archiving of stale chunks, merging of duplicates the day produced, and a
   * rewrite of the distilled profile and project summaries when their notes changed.
   */
  private async reflect(now = Date.now()): Promise<void> {
    const since = Number(this.meta("last_reflection_at") ?? 0);
    const report: Record<string, unknown> = {};

    // 1. importance and decay, archive stale chunks
    let archived = 0;
    this.ctx.storage.transactionSync(() => {
      for (const r of this.sql
        .exec("SELECT id, kind, trust, confirmations, access_count, t_event, updated_at, last_accessed, status FROM items WHERE status != 'superseded'")
        .toArray()) {
        const input = {
          trust: String(r.trust), kind: r.kind as "chunk" | "note", confirmations: Number(r.confirmations), accessCount: Number(r.access_count),
          lastTouched: Math.max(Number(r.t_event), Number(r.updated_at ?? 0), Number(r.last_accessed ?? 0)),
        };
        const value = importance(input, now);
        const archive = r.status === "active" && shouldArchive({ ...input, importance: value }, now);
        if (archive) archived++;
        this.sql.exec("UPDATE items SET importance = ?, status = CASE WHEN ? THEN 'archived' ELSE status END WHERE id = ?", value, archive ? 1 : 0, r.id);
      }
    });
    report.archived = archived;

    // 2. duplicates among notes changed since the last run
    let merged = 0;
    const changed = this.sql
      .exec("SELECT id, scope FROM items WHERE kind = 'note' AND status = 'active' AND COALESCE(updated_at, created_at) > ? LIMIT 500", since)
      .toArray();
    for (const c of changed) {
      const row = this.sql.exec("SELECT i.status, e.vec FROM items i JOIN embeddings e ON e.item_id = i.id WHERE i.id = ?", c.id).toArray()[0];
      if (!row || row.status !== "active") continue;
      const dup = nearest(decodeVector(row.vec as ArrayBuffer), this.candidates([String(c.scope)], [String(c.id)]), 1, 0.95)[0];
      if (!dup) continue;
      // The older note survives, so ids agents already hold stay valid.
      const [survivor, loser] = String(c.id) < dup.item.id ? [String(c.id), dup.item.id] : [dup.item.id, String(c.id)];
      this.ctx.storage.transactionSync(() => this.merge(survivor, loser, now));
      merged++;
    }
    report.merged = merged;

    // 2b. disputed notes, settled by trust and time (feature flag, see settleDisputes)
    if (this.env.DISPUTE_RESOLUTION === "on") report.disputes = await this.settleDisputes(now);

    // 3. "similar" edges for notes that have none yet, e.g. notes written before the threshold fit the embedding model
    const linksBefore = Number(this.sql.exec("SELECT COUNT(*) AS n FROM links WHERE kind = 'similar'").toArray()[0]?.n ?? 0);
    const unlinked = this.sql
      .exec(
        `SELECT id FROM items i WHERE kind = 'note' AND status = 'active'
           AND NOT EXISTS (SELECT 1 FROM links l WHERE l.src = i.id AND l.kind = 'similar')
         ORDER BY importance DESC LIMIT 500`,
      )
      .toArray();
    const pools = new Map<string, ReturnType<MemoryObject["candidates"]>>();
    this.ctx.storage.transactionSync(() => {
      for (const r of unlinked) this.linkSimilar(String(r.id), now, pools);
    });
    report.linked = Number(this.sql.exec("SELECT COUNT(*) AS n FROM links WHERE kind = 'similar'").toArray()[0]?.n ?? 0) - linksBefore;

    // 4. entities for notes that did not come from an episode (remembered, imported, written in the explorer)
    report.tagged = this.extractionEnabled ? await this.tagNoteEntities() : 0;

    // 4b. fact keys for episodes extracted before keys existed, from the notes derived from them (no model call)
    report.keyed = this.backfillFactKeys();

    // 5. distilled profile and project summaries
    const model = this.env.REFLECTION_MODEL ?? DEFAULT_REFLECTION_MODEL;
    const fallback = this.env.EXTRACTION_MODEL ?? DEFAULT_EXTRACTION_MODEL;
    const write = async (scope: string, label: string, prompt: string, description: string, charLimit: number) => {
      const notes = this.sql
        .exec(
          `SELECT content, note_kind, trust, confirmations, t_event FROM items
           WHERE kind = 'note' AND status = 'active' AND scope = ? ORDER BY importance DESC LIMIT 200`,
          scope,
        )
        .toArray();
      if (notes.length < 3) return false;
      const fingerprint = fnv1a(notes.map((n) => `${n.content}|${n.trust}|${n.confirmations}`).join("\n"));
      if (this.meta(`digest:${scope}:${label}`) === fingerprint) return false;
      const input = notes
        .map((n) => `- (${n.note_kind}, ${n.trust}, confirmed ${n.confirmations}x, ${iso(n.t_event).slice(0, 10)}) ${n.content}`)
        .join("\n")
        .slice(0, 60_000);
      let text = "";
      for (const m of [model, fallback]) {
        try {
          text = (await this.generate(m, prompt, input, 1500)).replace(/<think>[\s\S]*?<\/think>/g, "").trim();
          if (text) break;
        } catch (err) {
          console.error(`reflection with ${m} failed`, String(err));
        }
      }
      if (!text) return false;
      if (text.length > charLimit) text = text.slice(0, text.lastIndexOf("\n", charLimit) > 0 ? text.lastIndexOf("\n", charLimit) : charLimit);
      this.sql.exec(
        `INSERT INTO blocks (scope, label, value, description, char_limit, version, updated_at, updated_by)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)
         ON CONFLICT (scope, label) DO UPDATE SET value = excluded.value, version = blocks.version + 1,
           updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
        scope, label, text, description, charLimit, now, SYSTEM_REFLECTION,
      );
      this.setMeta(`digest:${scope}:${label}`, fingerprint);
      return true;
    };
    report.profile = await write("profile", "distilled-profile", PROFILE_PROMPT, "Written by nightly reflection from the profile notes. Edit the notes, not this block.", 2000);
    const projects = this.sql
      .exec("SELECT DISTINCT scope FROM items WHERE kind = 'note' AND scope LIKE 'project:%' AND COALESCE(updated_at, created_at) > ?", since)
      .toArray()
      .map((r) => String(r.scope));
    const summarised: string[] = [];
    for (const scope of projects.slice(0, 10)) {
      if (await write(scope, "summary", PROJECT_PROMPT, "Written by nightly reflection from the project notes.", 1500)) summarised.push(scope);
    }
    report.projects = summarised;

    this.setMeta("last_reflection_at", String(now));
    this.sql.exec("INSERT INTO audit (at, client_id, action, detail) VALUES (?, ?, 'reflect', ?)", now, SYSTEM_REFLECTION, JSON.stringify(report));
  }

  /**
   * Settles contradicting notes over time. What the person said or confirmed wins
   * over a guess, and of two things the person said the later one wins. The
   * extraction model judges the pairs the trust ladder cannot decide, at most
   * MAX_DISPUTES a run in one request; a pair it was unsure about waits a week.
   * A note replaced because time moved on (or whose open question got answered)
   * keeps its history and its validity ends where the newer note's starts; a note
   * that was simply wrong only expires. Nothing is deleted.
   */
  private async settleDisputes(now: number): Promise<Record<string, number>> {
    const counts: Record<DisputeVerdict | "reopened", number> = { newer: 0, older: 0, both: 0, unsure: 0, reopened: 0 };
    const live = (id: string) => {
      const status = this.sql.exec("SELECT status FROM items WHERE id = ?", id).toArray()[0]?.status;
      return status === "active" || status === "disputed";
    };
    const opposite = (id: string) =>
      this.sql
        .exec("SELECT dst AS o, weight FROM links WHERE src = ?1 AND kind = 'contradicts' UNION SELECT src AS o, weight FROM links WHERE dst = ?1 AND kind = 'contradicts'", id)
        .toArray()
        .map((r) => ({ id: String(r.o), weight: Number(r.weight) }));
    const disputed = this.sql
      .exec("SELECT id FROM items WHERE kind = 'note' AND status = 'disputed' ORDER BY importance DESC LIMIT 500")
      .toArray()
      .map((r) => String(r.id));

    // Open pairs. When the other side was replaced since, the dispute moves on to its current version.
    const pairs = new Map<string, [string, string]>();
    this.ctx.storage.transactionSync(() => {
      for (const id of disputed) {
        for (const o of opposite(id)) {
          const current = this.currentVersion(o.id);
          if (current === id || !live(current)) continue;
          if (current !== o.id) this.link(id, current, "contradicts", o.weight, now);
          pairs.set([id, current].sort().join("|"), [id, current]);
        }
      }
    });

    type Side = { id: string; content: string; trust: string; t: number; created: number };
    const side = (id: string): Side => {
      const r = this.sql.exec("SELECT content, trust, t_event, created_at FROM items WHERE id = ?", id).toArray()[0]!;
      return { id, content: String(r.content), trust: String(r.trust), t: Number(r.t_event), created: Number(r.created_at) };
    };
    // Older is what was said first; written at the same time, what was stored first.
    const before = (x: Side, y: Side) => x.t < y.t || (x.t === y.t && (x.created < y.created || (x.created === y.created && x.id < y.id)));
    const settle = (older: Side, newer: Side, verdict: DisputeVerdict, by: "trust" | "model") => {
      if (!live(older.id) || !live(newer.id)) return;
      if (verdict === "newer") this.supersede(older.id, newer.id, now);
      else if (verdict === "older") this.supersede(newer.id, older.id, now, false);
      else if (verdict === "both") {
        this.sql.exec("DELETE FROM links WHERE kind = 'contradicts' AND ((src = ?1 AND dst = ?2) OR (src = ?2 AND dst = ?1))", older.id, newer.id);
      } else return;
      counts[verdict]++;
      this.sql.exec(
        "INSERT INTO audit (at, client_id, action, detail) VALUES (?, ?, 'dispute.settle', ?)",
        now, SYSTEM_REFLECTION, JSON.stringify({ older: older.id, newer: newer.id, verdict, by }),
      );
    };

    const ordered = [...pairs.entries()].map(([key, [a, b]]) => {
      const [x, y] = [side(a), side(b)];
      return { key, older: before(x, y) ? x : y, newer: before(x, y) ? y : x };
    });
    const ask: typeof ordered = [];
    const unsure: Record<string, number> = JSON.parse(this.meta("dispute_unsure") ?? "{}");
    this.ctx.storage.transactionSync(() => {
      for (const p of ordered) {
        const verdict = settleByTrust(p.older.trust, p.newer.trust);
        if (verdict) settle(p.older, p.newer, verdict, "trust");
        else if (now - (unsure[p.key] ?? 0) >= 7 * DAY_MS && ask.length < MAX_DISPUTES) ask.push(p);
      }
    });

    if (ask.length && this.extractionEnabled) {
      const model = this.env.EXTRACTION_MODEL ?? DEFAULT_EXTRACTION_MODEL;
      const day = (t: number) => new Date(t).toISOString().slice(0, 10);
      const input = ask
        .map((p, i) => `Pair ${i}\nOLDER (${day(p.older.t)}, ${p.older.trust}): ${p.older.content.slice(0, 600)}\nNEWER (${day(p.newer.t)}, ${p.newer.trust}): ${p.newer.content.slice(0, 600)}`)
        .join("\n\n");
      try {
        // A short judgement per pair: no thinking, so the flash model answers within the budget.
        const verdicts = await this.generateJson(model, DISPUTE_PROMPT, input, (r) => validateVerdicts(r, ask.length), 1000, { reasoning_effort: "none" });
        this.ctx.storage.transactionSync(() => {
          ask.forEach((p, i) => {
            if (verdicts[i] === "unsure") {
              counts.unsure++;
              unsure[p.key] = now;
            } else settle(p.older, p.newer, verdicts[i]!, "model");
          });
        });
      } catch (err) {
        console.error("dispute resolution failed", String(err));
      }
    }
    // Only pairs that are still open keep their "unsure" mark.
    for (const key of Object.keys(unsure)) if (!pairs.has(key)) delete unsure[key];
    this.setMeta("dispute_unsure", JSON.stringify(unsure));

    // A disputed note with no open dispute left is active again.
    this.ctx.storage.transactionSync(() => {
      for (const id of disputed) {
        if (!live(id) || opposite(id).some((o) => live(o.id))) continue;
        this.sql.exec("UPDATE items SET status = 'active', updated_at = ? WHERE id = ? AND status = 'disputed'", now, id);
        counts.reopened++;
      }
    });
    return counts;
  }

  /**
   * Asks the extraction model which entities each note is about, in batches of
   * 20 and at most 100 notes per run. A cursor (created_at, id) remembers how far
   * it got, so notes without any entity are not sent again.
   */
  private async tagNoteEntities(): Promise<number> {
    const model = this.env.EXTRACTION_MODEL ?? DEFAULT_EXTRACTION_MODEL;
    const [cursorAt, cursorId] = (this.meta("entity_cursor") ?? "0|").split("|");
    let at = Number(cursorAt) || 0;
    let lastId = cursorId ?? "";
    let tagged = 0;
    for (let batch = 0; batch < 5; batch++) {
      const notes = this.sql
        .exec(
          `SELECT id, content, t_event, created_at FROM items
           WHERE kind = 'note' AND origin != 'extracted' AND status IN ('active', 'disputed')
             AND (created_at > ?1 OR (created_at = ?1 AND id > ?2))
           ORDER BY created_at, id LIMIT 20`,
          at,
          lastId,
        )
        .toArray();
      if (notes.length === 0) break;
      const input = notes.map((n, i) => `${i}. ${String(n.content).slice(0, 600)}`).join("\n");
      let entities: Extraction["entities"][];
      try {
        // Tagging needs no thinking: with reasoning on, the flash model spends the whole budget before it answers.
        // Workers AI understands reasoning_effort; the self-hosted AI client only forwards the fields it knows.
        entities = await this.generateJson(model, NOTE_ENTITIES_PROMPT, input, (r) => validateNoteEntities(r, notes.length), 2000, { reasoning_effort: "none" });
      } catch (err) {
        console.error("note tagging failed", String(err));
        break;
      }
      const last = notes[notes.length - 1]!;
      at = Number(last.created_at);
      lastId = String(last.id);
      this.ctx.storage.transactionSync(() => {
        notes.forEach((n, i) => {
          if (!entities[i]!.length) return;
          for (const id of this.upsertEntities(entities[i]!, Number(n.t_event)).values()) this.mention(String(n.id), id);
          tagged++;
        });
        this.setMeta("entity_cursor", `${at}|${lastId}`);
      });
    }
    return tagged;
  }

  private meta(key: string): string | null {
    const row = this.sql.exec("SELECT value FROM meta WHERE key = ?", key).toArray()[0];
    return row ? String(row.value) : null;
  }

  private setMeta(key: string, value: string): void {
    this.sql.exec("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
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
    status: String(r.status ?? "active"),
    origin: String(r.origin ?? "agent"),
    importance: Number(r.importance ?? 0.5),
    confirmations: Number(r.confirmations ?? 1),
    supersededBy: (r.superseded_by as string | null) ?? null,
    validFrom: r.valid_from == null ? null : iso(r.valid_from),
    validTo: r.valid_to == null ? null : iso(r.valid_to),
    expiredAt: r.expired_at == null ? null : iso(r.expired_at),
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
