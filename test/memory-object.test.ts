// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs the MemoryObject against node:sqlite and fake AI, R2 and Vectorize
// bindings: extraction, conflict resolution, merging, recall, forgetting and reflection.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { DISPUTE_PROMPT, EXTRACTION_PROMPT, NOTE_ENTITIES_PROMPT, PROFILE_PROMPT, RESOLVER_PROMPT } from "../src/intel";
import { MemoryObject } from "../src/memory-object";
import { MIGRATIONS } from "../src/schema";
import type { Client } from "../src/scopes";
import { fakeEnv, fakeState } from "./support/fake-do";

const grants = { read: ["profile", "project:*", "agent:self"], write: ["profile", "project:*", "agent:self"] };
const claude: Client = { id: "c1", userId: "u1", name: "Claude Code", agent: "claude-code", provider: "anthropic", grants };
const hermes: Client = { id: "c2", userId: "u1", name: "Hermes", agent: "hermes", provider: "nous", grants };
const web: Client = { id: "web:u1", userId: "u1", name: "explorer", agent: "web", provider: "rhizome", grants: { read: ["profile", "project:*", "agent:*"], write: ["profile", "project:*", "agent:*"] } };

/** Extraction answers keyed by a marker in the episode. */
const EXTRACTIONS: Record<string, unknown> = {
  AGPL: { facts: [{ statement: "The user wants the AGPL license for every project.", kind: "preference", scope: "profile", trust: "user_explicit", entities: ["AGPL"] }], entities: [{ name: "AGPL", type: "concept" }] },
  APACHE: { facts: [{ statement: "The user wants the Apache license for every project.", kind: "preference", scope: "profile", trust: "user_explicit", entities: ["Apache"] }], entities: [] },
  STYLE: {
    facts: [
      { statement: "The user prefers short replies that lead with the result.", kind: "preference", scope: "profile", trust: "user_explicit", entities: [] },
      { statement: "Deploys run through Workers Builds connected to GitHub.", kind: "decision", scope: "project", trust: "user_confirmed", entities: ["Workers Builds", "GitHub"] },
    ],
    entities: [{ name: "Workers Builds", type: "tool" }, { name: "GitHub", type: "org" }],
  },
  SMALLTALK: { facts: [], entities: [] },
  // Labelled by the extraction model against the notes shown under "Related memory".
  MOVED: { facts: [{ statement: "The user wants the Apache license for every project.", kind: "preference", scope: "profile", trust: "user_explicit", valid_from: "2026-11-27", relation: "update", related: 0, entities: [] }], entities: [] },
  TEA: { facts: [{ statement: "The user drinks green tea every morning.", kind: "preference", scope: "profile", trust: "user_explicit", relation: "same", related: 0, entities: [] }], entities: [] },
  COFFEE: { facts: [{ statement: "The user drinks black coffee after lunch.", kind: "preference", scope: "profile", trust: "user_explicit", relation: "update", related: 0, entities: [] }], entities: [] },
  VERCEL: { facts: [{ statement: "The user hosted the homepage on Vercel.", kind: "fact", scope: "profile", trust: "user_explicit", valid_to: "2026-11-01", entities: [] }], entities: [] },
};

let resolverAnswer = "update";
let disputeAnswer = "newer";
let disputeInputs: string[] = [];
let tagCalls = 0;
let resolverCalls = 0;
let extractionInputs: string[] = [];
function generate(_model: string, system: string, user: string): string {
  if (system === EXTRACTION_PROMPT) {
    extractionInputs.push(user);
    // Markers count only in the episode itself, not in the related memory appended to it.
    const episode = user.split("\n\nRelated memory:")[0]!;
    const key = Object.keys(EXTRACTIONS).find((k) => episode.includes(k))!;
    return "```json\n" + JSON.stringify(EXTRACTIONS[key]) + "\n```";
  }
  if (system === DISPUTE_PROMPT) {
    disputeInputs.push(user);
    const pairs = user.split("\n\n").length;
    return JSON.stringify({ results: Array.from({ length: pairs }, (_, pair) => ({ pair, verdict: disputeAnswer })) });
  }
  if (system === RESOLVER_PROMPT) resolverCalls++;
  if (system === RESOLVER_PROMPT) return JSON.stringify({ results: [{ pair: 0, relation: resolverAnswer }] });
  if (system === NOTE_ENTITIES_PROMPT) {
    tagCalls++;
    // Tags every note that mentions Cloudflare; the rest get nothing.
    const notes = user.split("\n").map((line) => ({ note: Number(line.split(".")[0]), entities: /cloudflare/i.test(line) ? [{ name: "Cloudflare", type: "org" }] : [] }));
    return JSON.stringify({ notes });
  }
  if (system === PROFILE_PROMPT) return "## Rules\n- AGPL for everything.\n- Short replies.";
  return "## Project\n- Workers Builds.";
}

let now = Date.UTC(2026, 10, 25, 12);
vi.spyOn(Date, "now").mockImplementation(() => now);
afterAll(() => vi.restoreAllMocks());

async function settle(mo: MemoryObject) {
  for (let i = 0; i < 20; i++) {
    now += 5_000;
    await mo.alarm();
  }
}

describe("schema migration 3", () => {
  it("backfills validity from event times and supersede edges, without a model", () => {
    const { db, state } = fakeState();
    db.exec(MIGRATIONS[0]!);
    db.exec(MIGRATIONS[1]!);
    db.exec("INSERT INTO meta (key, value) VALUES ('schema_version', '2')");
    const add = (id: string, t: number, status = "active", by: string | null = null, updated: number | null = null) =>
      db
        .prepare(
          `INSERT INTO items (id, kind, scope, content, trust, client_id, agent, provider, t_event, created_at, status, superseded_by, updated_at)
           VALUES (?, 'note', 'profile', ?, 'user_explicit', 'c1', 'a', 'p', ?, ?, ?, ?, ?)`,
        )
        .run(id, `note ${id}`, t, t, status, by, updated);
    add("old", 100, "superseded", "new", 500);
    add("new", 300);
    add("dup", 150, "superseded", "new", 600);
    add("wrong", 120, "superseded", "new", 700);
    const link = db.prepare("INSERT INTO links (src, dst, kind, weight, created_at) VALUES (?, ?, ?, 1, 0)");
    link.run("new", "old", "supersedes");
    link.run("dup", "new", "merged_into");
    link.run("new", "wrong", "supersedes");
    link.run("wrong", "new", "contradicts");

    new MemoryObject(state as never, fakeEnv(() => "").env as never);
    const rows = Object.fromEntries(
      (db.prepare("SELECT id, valid_from, valid_to, expired_at FROM items").all() as { id: string }[]).map((r) => [r.id, r]),
    );
    expect(rows.old).toEqual({ id: "old", valid_from: 100, valid_to: 300, expired_at: 500 });
    expect(rows.new).toEqual({ id: "new", valid_from: 300, valid_to: null, expired_at: null });
    expect(rows.dup).toEqual({ id: "dup", valid_from: 150, valid_to: null, expired_at: 600 });
    expect(rows.wrong).toEqual({ id: "wrong", valid_from: 120, valid_to: null, expired_at: 700 });
    expect(db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()).toEqual({ value: String(MIGRATIONS.length) });
  });
});

describe("MemoryObject pipeline", () => {
  let mo: MemoryObject;
  let fake: ReturnType<typeof fakeEnv>;
  let db: ReturnType<typeof fakeState>["db"];

  beforeEach(() => {
    const s = fakeState();
    db = s.db;
    fake = fakeEnv(generate);
    mo = new MemoryObject(s.state as never, fake.env as never);
    resolverAnswer = "update";
    resolverCalls = 0;
    extractionInputs = [];
    disputeAnswer = "newer";
    disputeInputs = [];
  });

  const notes = () => db.prepare("SELECT id, content, trust, status, confirmations, superseded_by, origin FROM items WHERE kind = 'note' ORDER BY created_at").all() as Record<string, unknown>[];

  it("extracts facts from an episode, with entities, links and vectors", async () => {
    const ep = await mo.addEpisode(claude, { scope: "project:rhizome", messages: [{ role: "user", content: "STYLE please keep replies short and deploy via Workers Builds" }] });
    await settle(mo);
    const n = notes();
    expect(n.map((x) => x.content)).toEqual([
      "The user prefers short replies that lead with the result.",
      "Deploys run through Workers Builds connected to GitHub.",
    ]);
    const scopes = db.prepare("SELECT scope FROM items WHERE kind = 'note'").all().map((r) => (r as { scope: string }).scope);
    expect(scopes).toEqual(["profile", "project:rhizome"]);
    expect(n.every((x) => x.origin === "extracted")).toBe(true);
    const entities = db.prepare("SELECT name, type FROM entities ORDER BY name").all();
    expect(entities).toEqual([{ name: "GitHub", type: "org" }, { name: "Workers Builds", type: "tool" }]);
    const derived = db.prepare("SELECT COUNT(*) AS n FROM links WHERE kind = 'derived_from' AND dst = ?").get(ep.id) as { n: number };
    expect(derived.n).toBe(2);
    // chunk + two notes end up in Vectorize, nothing left in the outbox or job queue
    expect(fake.vectors.size).toBe(3);
    expect((db.prepare("SELECT COUNT(*) AS n FROM outbox").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS n FROM jobs").get() as { n: number }).n).toBe(0);
  });

  it("merges a repeated fact from another agent instead of storing it twice", async () => {
    await mo.addEpisode(claude, { scope: "profile", messages: [{ role: "user", content: "AGPL for all of it, every single repository from now on" }] });
    await settle(mo);
    await mo.addEpisode(hermes, { scope: "profile", messages: [{ role: "user", content: "remember: AGPL everywhere, in every repository we create" }] });
    await settle(mo);
    const n = notes();
    expect(n).toHaveLength(1);
    expect(n[0]!.confirmations).toBe(2);
    expect(db.prepare("SELECT mentions FROM entities WHERE name = 'AGPL'").get()).toEqual({ mentions: 2 });
  });

  it("keeps what the person said when an agent's guess contradicts it, and lets the person settle it", async () => {
    await mo.addEpisode(claude, { scope: "profile", messages: [{ role: "user", content: "AGPL for all of it, every single repository from now on" }] });
    await settle(mo);
    // An assistant-only episode can't claim the user said something.
    await mo.addEpisode(hermes, { scope: "profile", messages: [{ role: "assistant", content: "I think APACHE fits better for these repositories overall" }] });
    await settle(mo);
    let n = notes();
    expect(n).toHaveLength(2);
    expect(n[0]).toMatchObject({ status: "active", trust: "user_explicit" });
    expect(n[1]).toMatchObject({ status: "disputed", trust: "agent_inference" });
    expect(db.prepare("SELECT kind FROM links WHERE src = ? AND dst = ?").get(String(n[1]!.id), String(n[0]!.id))).toEqual({ kind: "contradicts" });

    const confirmed = mo.confirm(web, String(n[1]!.id));
    expect(confirmed).toMatchObject({ status: "active", trust: "user_confirmed" });
    n = notes();
    expect(n[0]).toMatchObject({ status: "superseded", superseded_by: n[1]!.id });
  });

  it("lets the person's own update replace an older statement", async () => {
    await mo.addEpisode(claude, { scope: "profile", messages: [{ role: "user", content: "AGPL for all of it, every single repository from now on" }] });
    await settle(mo);
    await mo.addEpisode(claude, { scope: "profile", messages: [{ role: "user", content: "change of plan: APACHE for every repository from today on" }] });
    await settle(mo);
    const n = notes();
    expect(n[0]).toMatchObject({ status: "superseded", superseded_by: n[1]!.id });
    expect(n[1]).toMatchObject({ status: "active" });
    // Recall finds the current version even through the old one's text.
    const res = await mo.recall(claude, { query: "AGPL license", scopes: ["profile"], rerank: false });
    expect(res.items.map((i) => i.content)).toContain("The user wants the Apache license for every project.");
    expect(res.items.map((i) => i.content)).not.toContain("The user wants the AGPL license for every project.");
  });

  it("closes the old note's validity on an update and keeps the old note", async () => {
    await mo.addEpisode(claude, { scope: "profile", messages: [{ role: "user", content: "AGPL for all of it, every single repository from now on" }] });
    await settle(mo);
    await mo.addEpisode(claude, { scope: "profile", messages: [{ role: "user", content: "change of plan: APACHE for every repository from today on" }] });
    await settle(mo);
    const rows = db.prepare("SELECT id, content, status, t_event, valid_from, valid_to, expired_at, updated_at FROM items WHERE kind = 'note' ORDER BY created_at").all() as Record<string, number | string | null>[];
    expect(rows).toHaveLength(2);
    const [old, next] = rows as [Record<string, number | string | null>, Record<string, number | string | null>];
    expect(old.content).toBe("The user wants the AGPL license for every project.");
    expect(old.valid_from).toBe(old.t_event);
    expect(old.valid_to).toBe(next.valid_from);
    expect(old.expired_at).toBe(old.updated_at);
    expect(next).toMatchObject({ status: "active", valid_to: null, expired_at: null });
    expect(db.prepare("SELECT kind FROM links WHERE src = ? AND dst = ? AND kind = 'supersedes'").get(String(next.id), String(old.id))).toBeTruthy();
    const item = (await mo.recall(claude, { query: "Apache license", scopes: ["profile"], rerank: false })).items[0]!;
    expect(item).toMatchObject({ validTo: null, expiredAt: null });
    expect(item.validFrom).toBe(new Date(Number(next.valid_from)).toISOString());
  });

  it("puts related notes into the extraction prompt and uses the model's label instead of the resolver", async () => {
    await mo.addEpisode(claude, { scope: "profile", messages: [{ role: "user", content: "AGPL for all of it, every single repository from now on" }] });
    await settle(mo);
    expect(extractionInputs[0]).not.toContain("Related memory:");
    await mo.addEpisode(claude, { scope: "profile", messages: [{ role: "user", content: "MOVED: from tomorrow on we license every repository under Apache" }] });
    await settle(mo);
    expect(extractionInputs[1]).toContain("Related memory:\n0. The user wants the AGPL license for every project. (since 2026-11-25)");
    expect(resolverCalls).toBe(0);
    const n = db.prepare("SELECT id, status, superseded_by, valid_from, valid_to FROM items WHERE kind = 'note' ORDER BY created_at").all() as Record<string, unknown>[];
    expect(n[0]).toMatchObject({ status: "superseded", superseded_by: n[1]!.id, valid_to: Date.parse("2026-11-27") });
    expect(n[1]).toMatchObject({ status: "active", valid_from: Date.parse("2026-11-27"), valid_to: null });
    const audit = db.prepare("SELECT detail FROM audit WHERE action = 'extract' ORDER BY seq DESC LIMIT 1").get() as { detail: string };
    expect(JSON.parse(audit.detail)).toMatchObject({ update: 1, labelled: 1, resolved: 0, related: 1 });
  });

  it("does not merge on a 'same' label when the notes have little in common", async () => {
    await mo.addEpisode(claude, { scope: "profile", messages: [{ role: "user", content: "AGPL for all of it, every single repository from now on" }] });
    await settle(mo);
    await mo.addEpisode(claude, { scope: "profile", messages: [{ role: "user", content: "TEA every morning, green, before anything else happens" }] });
    await settle(mo);
    const n = notes();
    expect(n).toHaveLength(2);
    expect(n.map((x) => x.status)).toEqual(["active", "active"]);
    expect(n[0]!.confirmations).toBe(1);
  });

  it("does not supersede an unrelated note the model labelled as updated", async () => {
    await mo.addEpisode(claude, { scope: "profile", messages: [{ role: "user", content: "AGPL for all of it, every single repository from now on" }] });
    await settle(mo);
    await mo.addEpisode(claude, { scope: "profile", messages: [{ role: "user", content: "COFFEE after lunch, black, every single day" }] });
    await settle(mo);
    const n = notes();
    expect(n).toHaveLength(2);
    expect(n.map((x) => x.status)).toEqual(["active", "active"]);
    expect(n[0]!.superseded_by).toBeNull();
  });

  it("stores an end date from the episode and leaves an unknown start open", async () => {
    await mo.addEpisode(claude, { scope: "profile", messages: [{ role: "user", content: "VERCEL hosted the homepage until the first of November" }] });
    await settle(mo);
    const row = db.prepare("SELECT status, valid_from, valid_to FROM items WHERE kind = 'note'").get();
    expect(row).toEqual({ status: "active", valid_from: null, valid_to: Date.parse("2026-11-01") });
  });

  it("expires the losing side of a dispute the person settles without giving it a validity end", async () => {
    await mo.addEpisode(claude, { scope: "profile", messages: [{ role: "user", content: "AGPL for all of it, every single repository from now on" }] });
    await settle(mo);
    await mo.addEpisode(hermes, { scope: "profile", messages: [{ role: "assistant", content: "I think APACHE fits better for these repositories overall" }] });
    await settle(mo);
    const [first, second] = notes() as [Record<string, unknown>, Record<string, unknown>];
    mo.confirm(web, String(second.id));
    const loser = db.prepare("SELECT status, valid_to, expired_at FROM items WHERE id = ?").get(String(first.id)) as Record<string, unknown>;
    expect(loser).toMatchObject({ status: "superseded", valid_to: null });
    expect(loser.expired_at).toBeTypeOf("number");
    // Forgetting the winner makes the old note current again.
    await mo.forget(web, String(second.id));
    expect(db.prepare("SELECT status, valid_to, expired_at FROM items WHERE id = ?").get(String(first.id))).toEqual({ status: "active", valid_to: null, expired_at: null });
  });

  it("skips small talk and merges a note an agent writes twice", async () => {
    await mo.addEpisode(claude, { scope: "profile", messages: [{ role: "user", content: "SMALLTALK how are you doing today" }] });
    const a = await mo.addNote(claude, { scope: "profile", content: "The user lives in Hamburg and works remotely.", kind: "fact" });
    await settle(mo);
    const b = await mo.addNote(hermes, { scope: "profile", content: "The user lives in Hamburg and works remotely.", kind: "fact", trust: "user_explicit" });
    await settle(mo);
    const n = notes();
    expect(n).toHaveLength(2);
    expect(n.find((x) => x.id === a.id)).toMatchObject({ status: "active", trust: "user_explicit", confirmations: 2 });
    expect(n.find((x) => x.id === b.id)).toMatchObject({ status: "superseded", superseded_by: a.id });
  });

  it("forgets an episode with everything derived from it", async () => {
    const ep = await mo.addEpisode(claude, { scope: "project:rhizome", messages: [{ role: "user", content: "STYLE notes about replies and how deploys should run" }] });
    await settle(mo);
    const before = fake.vectors.size;
    expect((await mo.forget(web, ep.id)).deleted).toBe(2);
    await settle(mo);
    expect(fake.r2.size).toBe(0);
    expect(fake.vectors.size).toBe(before - 1);
    expect(db.prepare("SELECT COUNT(*) AS n FROM links WHERE src = ? OR dst = ?").get(ep.id, ep.id)).toEqual({ n: 0 });
    expect(db.prepare("SELECT COUNT(*) AS n FROM mentions WHERE ref = ?").get(ep.id)).toEqual({ n: 0 });
    // Workers Builds and GitHub are still mentioned by the two extracted notes.
    expect(db.prepare("SELECT COUNT(*) AS n FROM entities").get()).toEqual({ n: 2 });
    for (const n of notes()) await mo.forget(web, String(n.id));
    expect(db.prepare("SELECT COUNT(*) AS n FROM entities").get()).toEqual({ n: 0 });
  });

  it("serves the explorer: graph, detail, scopes and activity", async () => {
    const ep = await mo.addEpisode(claude, { scope: "project:rhizome", messages: [{ role: "user", content: "STYLE notes about replies and how deploys should run" }] });
    await mo.addNote(claude, { scope: "agent:claude-code", content: "The sandbox cannot reach the Cloudflare API.", kind: "learning" });
    await settle(mo);
    expect(mo.scopes(web)).toEqual(["agent:claude-code", "profile", "project:rhizome"]);
    expect(mo.scopes(hermes)).toEqual(["profile", "project:rhizome"]);
    const g = mo.graph(web, mo.scopes(web));
    expect(g.nodes.filter((n) => n.type === "note")).toHaveLength(3);
    expect(g.nodes.filter((n) => n.type === "episode")).toHaveLength(1);
    expect(g.nodes.filter((n) => n.type === "entity").map((n) => n.label).sort()).toEqual(["GitHub", "Workers Builds"]);
    expect(g.edges.some((e) => e.kind === "mentions")).toBe(true);
    expect(g.edges.some((e) => e.kind === "derived_from" && e.target === ep.id)).toBe(true);

    const d = await mo.detail(web, ep.id);
    expect(d?.type).toBe("episode");
    const entity = g.nodes.find((n) => n.label === "GitHub")!;
    const de = await mo.detail(web, entity.id);
    expect(de?.type === "entity" ? de.mentions.length : 0).toBeGreaterThan(0);
    expect(mo.activity(web, 5).length).toBeGreaterThan(0);
  });

  it("reflects: writes the distilled profile once and skips unchanged notes next time", async () => {
    await mo.addEpisode(claude, { scope: "profile", messages: [{ role: "user", content: "AGPL for all of it, every single repository from now on" }] });
    await mo.addEpisode(claude, { scope: "project:rhizome", messages: [{ role: "user", content: "STYLE notes about replies and how deploys should run" }] });
    await mo.addNote(claude, { scope: "profile", content: "The user writes chat messages in German.", kind: "preference", trust: "user_explicit" });
    await settle(mo);
    await mo.requestReflection(web);
    await settle(mo);
    const block = db.prepare("SELECT value, version, updated_by FROM blocks WHERE scope = 'profile' AND label = 'distilled-profile'").get();
    expect(block).toMatchObject({ value: "## Rules\n- AGPL for everything.\n- Short replies.", version: 1, updated_by: "system:reflection" });
    await mo.requestReflection(web);
    await settle(mo);
    expect(db.prepare("SELECT version FROM blocks WHERE label = 'distilled-profile'").get()).toEqual({ version: 1 });
    expect(mo.stats(web).lastReflection).not.toBeNull();
  });
  it("reflects: links remembered notes and tags them with entities, once", async () => {
    await mo.addNote(claude, { scope: "project:rhizome", content: "rhizome runs on Cloudflare Workers with one Durable Object per person.", kind: "fact" });
    await mo.addNote(claude, { scope: "project:rhizome", content: "rhizome stores raw episodes in R2 on Cloudflare.", kind: "fact" });
    await mo.addNote(claude, { scope: "profile", content: "The user writes chat messages in German.", kind: "preference", trust: "user_explicit" });
    await settle(mo);
    await mo.requestReflection(web);
    await settle(mo);
    const mentions = db.prepare("SELECT COUNT(*) AS n FROM mentions m JOIN entities e ON e.id = m.entity_id WHERE e.name = 'Cloudflare'").get() as { n: number };
    expect(mentions.n).toBe(2);
    expect((db.prepare("SELECT mentions FROM entities WHERE name = 'Cloudflare'").get() as { mentions: number }).mentions).toBe(2);
    const g = mo.graph(web, ["profile", "project:rhizome"]);
    expect(g.edges.filter((e) => e.kind === "mentions")).toHaveLength(2);
    const before = tagCalls;
    await mo.requestReflection(web);
    await settle(mo);
    // Already tagged notes are not sent to the model again.
    expect((db.prepare("SELECT mentions FROM entities WHERE name = 'Cloudflare'").get() as { mentions: number }).mentions).toBe(2);
    expect(tagCalls).toBe(before);
  });

  describe("dispute resolution in reflection", () => {
    const row = (id: string) => db.prepare("SELECT status, superseded_by, valid_from, valid_to, expired_at FROM items WHERE id = ?").get(id) as Record<string, unknown>;
    const reflect = async () => {
      await mo.requestReflection(web);
      await settle(mo);
    };
    /** Two agent notes flagged as contradicting, the newer one disputed, as extraction leaves them. */
    async function agentDispute(older: string, newer: string) {
      const a = await mo.addNote(claude, { scope: "project:rhizome", content: older, kind: "fact", trust: "agent_inference", tEvent: Date.UTC(2026, 10, 20) });
      const b = await mo.addNote(hermes, { scope: "project:rhizome", content: newer, kind: "fact", trust: "agent_inference", tEvent: Date.UTC(2026, 10, 24) });
      await settle(mo);
      db.prepare("UPDATE items SET status = 'disputed' WHERE id = ?").run(b.id);
      db.prepare("INSERT INTO links (src, dst, kind, weight, created_at) VALUES (?, ?, 'contradicts', 0.8, ?)").run(b.id, a.id, now);
      return { older: a.id, newer: b.id };
    }

    it("is off unless DISPUTE_RESOLUTION is on", async () => {
      const { older, newer } = await agentDispute("It is an open question whether the credit cap applies after Dec 1.", "The credit cap does not apply after Dec 1; free volume only.");
      await reflect();
      expect(row(newer).status).toBe("disputed");
      expect(row(older).status).toBe("active");
      expect(disputeInputs).toHaveLength(0);
    });

    it("keeps what the person said over a contradicting guess, without a model", async () => {
      (fake.env as { DISPUTE_RESOLUTION?: string }).DISPUTE_RESOLUTION = "on";
      await mo.addEpisode(claude, { scope: "profile", messages: [{ role: "user", content: "AGPL for all of it, every single repository from now on" }] });
      await settle(mo);
      await mo.addEpisode(hermes, { scope: "profile", messages: [{ role: "assistant", content: "I think APACHE fits better for these repositories overall" }] });
      await settle(mo);
      const [said, guess] = notes();
      expect(guess).toMatchObject({ status: "disputed" });
      await reflect();
      // The guess was wrong, not outdated: its record expires, it never gets a time when it was true.
      expect(row(String(guess!.id))).toMatchObject({ status: "superseded", superseded_by: said!.id, valid_to: null });
      expect(row(String(said!.id))).toMatchObject({ status: "active", valid_to: null });
      expect(disputeInputs).toHaveLength(0);
      const settled = mo.activity(web, 20).find((a) => a.action === "dispute.settle");
      expect(settled?.detail).toMatchObject({ older: said!.id, newer: guess!.id, verdict: "older", by: "trust" });
    });

    it("lets a newer confirmed note replace an older guess and closes the old one's validity", async () => {
      (fake.env as { DISPUTE_RESOLUTION?: string }).DISPUTE_RESOLUTION = "on";
      const { older, newer } = await agentDispute("It is an open question whether the credit cap applies after Dec 1.", "The credit cap does not apply after Dec 1; free volume only.");
      db.prepare("UPDATE items SET trust = 'user_confirmed' WHERE id = ?").run(newer);
      await reflect();
      expect(row(older)).toMatchObject({ status: "superseded", superseded_by: newer, valid_to: Date.UTC(2026, 10, 24) });
      expect(row(newer)).toMatchObject({ status: "active", valid_to: null });
      expect(disputeInputs).toHaveLength(0);
    });

    it("asks the model about two guesses: an answered open question is replaced over time", async () => {
      (fake.env as { DISPUTE_RESOLUTION?: string }).DISPUTE_RESOLUTION = "on";
      const { older, newer } = await agentDispute("It is an open question whether the credit cap applies after Dec 1.", "The credit cap does not apply after Dec 1; free volume only.");
      await reflect();
      expect(disputeInputs).toHaveLength(1);
      expect(disputeInputs[0]).toContain("OLDER (2026-11-20, agent_inference): It is an open question");
      expect(disputeInputs[0]).toContain("NEWER (2026-11-24, agent_inference): The credit cap");
      expect(row(older)).toMatchObject({ status: "superseded", superseded_by: newer, valid_to: Date.UTC(2026, 10, 24) });
      expect(row(newer).status).toBe("active");
      // The old note is still there for recall as of a past time.
      const past = await mo.recall(claude, { query: "credit cap after Dec 1", scopes: ["project:rhizome"], asOf: Date.UTC(2026, 10, 22) });
      expect(past.items.map((i) => i.id)).toContain(older);
    });

    it("drops the dispute when the model says both hold", async () => {
      (fake.env as { DISPUTE_RESOLUTION?: string }).DISPUTE_RESOLUTION = "on";
      disputeAnswer = "both";
      const { older, newer } = await agentDispute("rhizome stores episodes in R2.", "rhizome stores notes in Durable Object SQLite.");
      await reflect();
      expect(row(newer).status).toBe("active");
      expect(row(older).status).toBe("active");
      expect(db.prepare("SELECT COUNT(*) AS n FROM links WHERE kind = 'contradicts'").get()).toEqual({ n: 0 });
    });

    it("leaves an unclear pair disputed and asks again only after a week", async () => {
      (fake.env as { DISPUTE_RESOLUTION?: string }).DISPUTE_RESOLUTION = "on";
      disputeAnswer = "unsure";
      const { newer } = await agentDispute("The homelab runs Proxmox.", "The homelab runs Unraid.");
      await reflect();
      await reflect();
      expect(disputeInputs).toHaveLength(1);
      expect(row(newer).status).toBe("disputed");
      now += 8 * 86_400_000;
      await reflect();
      expect(disputeInputs).toHaveLength(2);
    });

    it("makes a disputed note active again when the other side is gone", async () => {
      (fake.env as { DISPUTE_RESOLUTION?: string }).DISPUTE_RESOLUTION = "on";
      const { older, newer } = await agentDispute("The homelab runs Proxmox.", "The homelab runs Unraid.");
      await mo.forget(web, older);
      await reflect();
      expect(row(newer).status).toBe("active");
      expect(disputeInputs).toHaveLength(0);
    });
  });

  it("stops queueing extraction once the daily limit is reached", async () => {
    (fake.env as { EXTRACTION_DAILY_LIMIT?: string }).EXTRACTION_DAILY_LIMIT = "1";
    await mo.addEpisode(claude, { scope: "profile", messages: [{ role: "user", content: "AGPL for all of it, every single repository from now on" }] });
    await mo.addEpisode(claude, { scope: "profile", messages: [{ role: "user", content: "SMALLTALK how are you doing today, a long enough message" }] });
    expect((db.prepare("SELECT COUNT(*) AS n FROM jobs WHERE kind = 'extract'").get() as { n: number }).n).toBe(1);
    expect((db.prepare("SELECT COUNT(*) AS n FROM episodes").get() as { n: number }).n).toBe(2);
  });
});
