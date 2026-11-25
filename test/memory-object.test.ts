// SPDX-License-Identifier: AGPL-3.0-or-later
// Runs the MemoryObject against node:sqlite and fake AI, R2 and Vectorize
// bindings: extraction, conflict resolution, merging, recall, forgetting and reflection.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EXTRACTION_PROMPT, PROFILE_PROMPT, RESOLVER_PROMPT } from "../src/intel";
import { MemoryObject } from "../src/memory-object";
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
};

let resolverAnswer = "update";
function generate(_model: string, system: string, user: string): string {
  if (system === EXTRACTION_PROMPT) {
    const key = Object.keys(EXTRACTIONS).find((k) => user.includes(k))!;
    return "```json\n" + JSON.stringify(EXTRACTIONS[key]) + "\n```";
  }
  if (system === RESOLVER_PROMPT) return JSON.stringify({ results: [{ pair: 0, relation: resolverAnswer }] });
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
});
