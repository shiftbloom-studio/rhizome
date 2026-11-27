// SPDX-License-Identifier: AGPL-3.0-or-later
// Records (memory as a database): the pure helpers, and the MemoryObject filing notes,
// listing them in recall and answering query_records.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mcpResponse } from "../src/mcp";
import { MemoryObject } from "../src/memory-object";
import { aggregate, normalizeLabel, pickLabels, RECORDS_PROMPT, recordsSection, validateRecords, type RecordRow } from "../src/records";
import { MIGRATIONS } from "../src/schema";
import { LocalVectorIndex } from "../src/node/vectors";
import type { Client } from "../src/scopes";
import { fakeEnv, fakeState } from "./support/fake-do";

const grants = { read: ["profile", "project:*", "agent:self"], write: ["profile", "project:*", "agent:self"] };
const claude: Client = { id: "c1", userId: "u1", name: "Claude Code", agent: "claude-code", provider: "anthropic", grants };

describe("records helpers", () => {
  it("reads the compact answer, by note number or by position", () => {
    const out = validateRecords(
      {
        r: [
          [0, "event", "Weddings!", ["Celebration", "wedding", "family event", "x", "y"], null, null, "2023-03-12"],
          ["attended a concert", "event", "concert", [], "null", null, "2023-02-30"],
          [2, "state", "musical instrument", ["guitar"], "450", "USD", null],
          [9, "event", "trip", [], null, null, null],
        ],
      },
      4,
    );
    expect(out[0]).toEqual({ type: "event", category: "weddings", tags: ["celebration", "wedding", "family event"], quantity: null, unit: null, date: Date.UTC(2023, 2, 12) });
    // No note number: its position counts. An impossible date is dropped, "null" is no amount.
    expect(out[1]).toMatchObject({ category: "concert", quantity: null, date: null });
    expect(out[2]).toMatchObject({ type: "state", quantity: 450, unit: "USD" });
    expect(out[3]).toBeNull();
    expect(() => validateRecords({ records: "x" }, 1)).toThrow();
  });

  it("keeps labels short and generic", () => {
    expect(normalizeLabel("  Bike Repair, at the shop ")).toBe("bike repair at");
    expect(normalizeLabel(42)).toBe("");
  });

  it("picks the labels a query names or comes close to", () => {
    const scored = [
      { label: "wedding", similarity: 0.65 },
      { label: "wedding attendance", similarity: 0.69 },
      { label: "celebration", similarity: 0.51 },
      { label: "bike repair", similarity: 0.3 },
    ];
    expect(pickLabels(scored, "How many weddings did I attend?")).toEqual(["wedding", "wedding attendance"]);
    // Nothing close enough and nothing named: no labels.
    expect(pickLabels(scored.map((s) => ({ ...s, similarity: s.similarity - 0.2 })), "What did I eat?")).toEqual([]);
    // A named category needs only 0.45; a named tag or a barely related label does not count.
    expect(pickLabels(scored.map((s) => ({ ...s, similarity: 0.5 })), "my last bike repairs")).toEqual(["bike repair"]);
    expect(pickLabels(scored.map((s) => ({ ...s, similarity: 0.3 })), "my last bike repairs")).toEqual([]);
    expect(pickLabels([{ label: "family", kind: "tag", similarity: 0.5 }], "my family dinner")).toEqual([]);
  });

  const row = (id: string, date: string, quantity: number | null, unit: string | null): RecordRow => ({
    id, scope: "profile", type: "event", category: "bike repair", tags: [], quantity, unit, date, content: `note ${id}`, status: "active", sources: [],
  });

  it("counts, sums per unit and names the latest", () => {
    const rows = [row("a", "2023-01-02T00:00:00.000Z", 85, "USD"), row("b", "2023-05-01T00:00:00.000Z", 40.5, "USD"), row("c", "2023-03-01T00:00:00.000Z", null, null), row("d", "2023-02-01T00:00:00.000Z", 2, "hours")];
    expect(aggregate(rows, "count")).toEqual({ count: 4 });
    expect(aggregate(rows, "sum")).toEqual({ sums: [{ unit: "USD", total: 125.5 }, { unit: "hours", total: 2 }], withoutQuantity: 1 });
    expect(aggregate(rows, "latest")).toEqual({ latest: "b", date: "2023-05-01T00:00:00.000Z" });
    expect(recordsSection([{ label: "bike repair", total: 4, rows: rows.slice(0, 2) }])).toBe(
      'Records filed as "bike repair" (4 on file, 2 shown, oldest first):\n- 2023-01-02 [a] (event · 85 USD) note a\n- 2023-05-01 [b] (event · 40.5 USD) note b',
    );
  });

  it("filters ranges on the Node vector index as Vectorize does", async () => {
    const index = new LocalVectorIndex(":memory:");
    await index.upsert([
      { id: "a", values: [1, 0], namespace: "u", metadata: { scope: "profile", day: 10 } },
      { id: "b", values: [1, 0], namespace: "u", metadata: { scope: "profile", day: 20 } },
      { id: "c", values: [1, 0], namespace: "u", metadata: { scope: "profile" } },
    ]);
    const res = await index.query([1, 0], { topK: 5, namespace: "u", filter: { scope: "profile", day: { $gte: 15, $lte: 25 } } } as never);
    expect(res.matches.map((m: { id: string }) => m.id)).toEqual(["b"]);
    index.close();
  });
});

let now = Date.UTC(2026, 10, 25, 12);
vi.spyOn(Date, "now").mockImplementation(() => now);
afterAll(() => vi.restoreAllMocks());

/** Files every wedding note under "wedding" with its date, bike notes with their price, the rest as "habit". */
let recordsCalls = 0;
let failRecords = false;
function generate(_model: string, system: string, user: string): string {
  if (system !== RECORDS_PROMPT) return "{}";
  recordsCalls++;
  if (failRecords) return "not json";
  const notes = user.split("Notes:\n")[1]!.split("\n");
  return JSON.stringify({
    r: notes.map((line, i) => {
      const date = /on (\d{4}-\d{2}-\d{2})/.exec(line)?.[1] ?? null;
      if (/wedding|married/i.test(line)) return [i, "event", "wedding", ["celebration"], null, null, date];
      const usd = /\$(\d+)/.exec(line)?.[1];
      if (/bike/i.test(line)) return [i, "event", "bike repair", ["expense"], usd ? Number(usd) : null, usd ? "USD" : null, date];
      return [i, "state", "habit", [], null, null, null];
    }),
  });
}

async function settle(mo: MemoryObject) {
  for (let i = 0; i < 20; i++) {
    now += 5_000;
    await mo.alarm();
  }
}

describe("MemoryObject records", () => {
  let mo: MemoryObject;
  let fake: ReturnType<typeof fakeEnv>;
  let db: ReturnType<typeof fakeState>["db"];

  beforeEach(() => {
    const s = fakeState();
    db = s.db;
    fake = fakeEnv(generate);
    mo = new MemoryObject(s.state as never, fake.env as never);
    recordsCalls = 0;
    failRecords = false;
  });

  const remember = async (...contents: string[]) => {
    const ids: string[] = [];
    for (const content of contents) ids.push((await mo.addNote(claude, { scope: "profile", content, kind: "fact" })).id);
    await settle(mo);
    return ids;
  };

  it("files notes in one call and lists every note of the asked-for kind in recall", async () => {
    const [rachel, emily] = await remember(
      "The user attended Rachel and Mike's wedding on 2023-03-12.",
      "The user's sister Emily got married to Sarah on 2023-06-17.",
      "The user paid $85 for a bike repair on 2023-07-15.",
      "The user drinks green tea every morning.",
    );
    expect(recordsCalls).toBe(1);
    const rows = db.prepare("SELECT item_id, type, category, tags, occurred_at FROM records ORDER BY occurred_at").all();
    expect(rows).toHaveLength(4);
    expect(rows.filter((r) => (r as { category: string }).category === "wedding")).toEqual([
      { item_id: rachel, type: "event", category: "wedding", tags: "celebration", occurred_at: Date.UTC(2023, 2, 12) },
      { item_id: emily, type: "event", category: "wedding", tags: "celebration", occurred_at: Date.UTC(2023, 5, 17) },
    ]);
    expect((db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n).toBe(0);
    // Every label has an embedding to match queries against.
    expect(db.prepare("SELECT label FROM record_labels ORDER BY label").all().map((r) => (r as { label: string }).label)).toEqual(["bike repair", "celebration", "expense", "habit", "wedding"]);

    const res = await mo.recall(claude, { query: "How many wedding parties?", scopes: ["profile"] });
    expect(res.records).toHaveLength(1);
    expect(res.records![0]).toMatchObject({ label: "wedding", total: 2 });
    expect(res.records![0]!.rows.map((r) => r.id)).toEqual([rachel, emily]);
    expect(res.text).toContain('Records filed as "wedding" (2 on file, oldest first):');
    expect(res.sources.records).toBe(2);

    // A time window limits by when it happened, not by when the note was written.
    const spring = await mo.recall(claude, { query: "wedding", scopes: ["profile"], from: Date.UTC(2023, 0, 1), to: Date.UTC(2023, 4, 1) });
    expect(spring.records?.[0]?.rows.map((r) => r.id)).toEqual([rachel]);
    // A broader label (tag) finds the same rows.
    expect((await mo.queryRecords(claude, { scopes: ["profile"], category: "celebration" })).rows.map((r) => r.id)).toEqual([rachel, emily]);
    // Without the step there are no records.
    const plain = await mo.recall(claude, { query: "How many wedding parties?", scopes: ["profile"], features: ["abstain"] });
    expect(plain.records).toBeUndefined();
  });

  it("answers query_records with rows and sums, and leaves out other people's scopes", async () => {
    await remember("The user paid $85 for a bike repair on 2023-07-15.", "New brake pads on my bike came to $40 on 2023-09-01.", "A flat tyre: the bike shop fixed it for free.");
    await mo.addNote(claude, { scope: "project:other", content: "The team paid $999 for a bike repair on 2023-08-01.", kind: "fact" });
    await settle(mo);
    const res = await mo.queryRecords(claude, { scopes: ["profile"], category: "Bike Repair" });
    expect(res.labels).toEqual(["bike repair"]);
    expect(res.total).toBe(3);
    expect(aggregate(res.rows, "sum")).toEqual({ sums: [{ unit: "USD", total: 125 }], withoutQuantity: 1 });
    const byQuery = await mo.queryRecords(claude, { scopes: ["profile", "project:other"], query: "what did my bike repairs cost" });
    expect(byQuery.total).toBe(4);
    // total counts every match, rows stop at the limit.
    const first = await mo.queryRecords(claude, { scopes: ["profile"], category: "bike repair", limit: 1 });
    expect([first.total, first.rows.length]).toEqual([3, 1]);
    const none = await mo.queryRecords(claude, { scopes: ["profile"], category: "concert" });
    expect(none).toEqual({ labels: ["concert"], rows: [], total: 0 });
  });

  it("offers query_records over MCP only with RECORDS on, and sums with the rows behind it", async () => {
    await remember("The user paid $85 for a bike repair on 2023-07-15.", "New brake pads on my bike came to $40 on 2023-09-01.");
    const call = async (opts: { records?: boolean }, body: unknown) => (await (await mcpResponse(mo, claude, body, "test", undefined, opts)).json()) as { result: Record<string, unknown> };
    const list = (opts: { records?: boolean }) => call(opts, { jsonrpc: "2.0", id: 1, method: "tools/list" }).then((r) => (r.result.tools as { name: string }[]).map((t) => t.name));
    expect(await list({})).not.toContain("query_records");
    expect(await list({ records: true })).toContain("query_records");
    const res = await call({ records: true }, { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "query_records", arguments: { category: "bike repair", op: "sum" } } });
    const out = res.result as { content: { text: string }[]; structuredContent: { total: number; sums: unknown; rows: unknown[] } };
    expect(out.content[0]!.text).toMatch(/^Sum \("bike repair"\): 125 USD\.\n- 2023-07-15/);
    expect(out.structuredContent).toMatchObject({ total: 2, sums: [{ unit: "USD", total: 125 }] });
    expect(out.structuredContent.rows).toHaveLength(2);
  });

  it("files a note again when its text changes, and drops the record with the note", async () => {
    const id = (await remember("The user drinks green tea every morning."))[0]!;
    expect(recordsCalls).toBe(1);
    db.prepare("UPDATE items SET content = ? WHERE id = ?").run("The user went to a wedding on 2024-05-04.", id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM records").get()).toEqual({ n: 0 });
    await mo.addNote(claude, { scope: "profile", content: "The user cycles to work.", kind: "fact" });
    await settle(mo);
    expect(db.prepare("SELECT category FROM records WHERE item_id = ?").get(id)).toEqual({ category: "wedding" });
    await mo.forget(claude, id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM records WHERE item_id = ?").get(id)).toEqual({ n: 0 });
  });

  it("marks a batch the model cannot file as failed instead of retrying it forever, and tries again a day later", async () => {
    failRecords = true;
    await remember("The user went to a wedding on 2024-05-04.");
    expect(recordsCalls).toBe(2); // one retry inside the call
    expect(db.prepare("SELECT type, model FROM records").get()).toEqual({ type: "none", model: "@cf/meta/llama-4-scout-17b-16e-instruct#failed" });
    expect((db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n).toBe(0);
    failRecords = false;
    now += 86_400_000 + 1;
    await remember("The user cycles to work.");
    expect(db.prepare("SELECT type FROM records ORDER BY created_at").all()).toEqual([{ type: "event" }, { type: "state" }]);
  });

  it("does nothing with RECORDS=off", async () => {
    (fake.env as { RECORDS?: string }).RECORDS = "off";
    await remember("The user went to a wedding on 2024-05-04.");
    expect(recordsCalls).toBe(0);
    expect((await mo.recall(claude, { query: "weddings", scopes: ["profile"] })).records).toBeUndefined();
  });

  it("writes the event day to Vectorize and filters by it with VECTOR_FILTERS=on", async () => {
    await remember("The user went to a wedding on 2024-05-04.");
    const [stored] = [...fake.vectors.values()];
    expect(stored!.metadata).toMatchObject({ scope: "profile", kind: "note", day: Math.floor(now / 86_400_000) });
    const query = vi.spyOn(fake.env.VECTORS, "query");
    (fake.env as { VECTOR_FILTERS?: string }).VECTOR_FILTERS = "on";
    await mo.recall(claude, { query: "wedding", scopes: ["profile"], from: Date.UTC(2024, 4, 1), to: Date.UTC(2024, 5, 1) });
    const filters = query.mock.calls.map((args) => (args as unknown[])[1] as { filter: Record<string, unknown> }).map((o) => o.filter);
    expect(filters).toContainEqual({ scope: "profile", day: { $gte: Date.UTC(2024, 4, 1) / 86_400_000, $lte: Date.UTC(2024, 4, 31) / 86_400_000 } });
    expect(filters).toContainEqual({ scope: "profile" });
  });
});

describe("schema migration 11", () => {
  it("writes every vector again and files existing notes", async () => {
    const { db, state } = fakeState();
    for (const m of MIGRATIONS.slice(0, 10)) db.exec(m);
    db.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '10'), ('user_id', 'u1')");
    db.prepare(
      `INSERT INTO items (id, kind, scope, content, trust, client_id, agent, provider, t_event, created_at)
       VALUES ('n1', 'note', 'profile', 'The user went to a wedding on 2024-05-04.', 'user_explicit', 'c1', 'a', 'p', 1, 1)`,
    ).run();
    const mo = new MemoryObject(state as never, fakeEnv(generate).env as never);
    await new Promise((r) => setTimeout(r, 0));
    expect(db.prepare("SELECT op, item_id FROM outbox").all()).toEqual([{ op: "upsert", item_id: "n1" }]);
    expect(db.prepare("SELECT kind, ref FROM jobs").all()).toEqual([{ kind: "type", ref: "all" }]);
    expect(await state.storage.getAlarm()).not.toBeNull();
    recordsCalls = 0;
    await settle(mo);
    expect(db.prepare("SELECT category FROM records WHERE item_id = 'n1'").get()).toEqual({ category: "wedding" });
  });
});
