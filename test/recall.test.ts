// SPDX-License-Identifier: AGPL-3.0-or-later
// Recall steps: confidence, abstention, diversity, evidence, time windows and sub-queries.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EXTRACTION_PROMPT } from "../src/intel";
import { MemoryObject } from "../src/memory-object";
import {
  assignFactKeys,
  confidence,
  diversify,
  fillCards,
  joinExcerpts,
  keywordCoverage,
  keywordTerms,
  parseFeatures,
  sentenceWindows,
  shouldAbstain,
  splitTurns,
  turnUnits,
} from "../src/recall";
import { chunk, roundChunks, transcript } from "../src/text";
import type { Client } from "../src/scopes";
import { fakeEnv, fakeState } from "./support/fake-do";

describe("recall helpers", () => {
  it("files facts under the excerpt they came from", () => {
    const chunks = [
      { rid: 1, content: "[user] we deploy with Workers Builds", vec: null },
      { rid: 2, content: "[user] tabs, not spaces", vec: null },
    ];
    expect(assignFactKeys(["The user indents with tabs.", "Deploys run through Workers Builds."], [], chunks)).toEqual(
      new Map([[2, ["The user indents with tabs."]], [1, ["Deploys run through Workers Builds."]]]),
    );
    const embedded = [
      { rid: "a", content: "x", vec: [1, 0] },
      { rid: "b", content: "y", vec: [0, 1] },
    ];
    expect(assignFactKeys(["f"], [[0.1, 0.9]], embedded)).toEqual(new Map([["b", ["f"]]]));
  });

  it("parses feature lists", () => {
    expect([...parseFeatures("abstain, diversity,unknown")]).toEqual(["abstain", "diversity"]);
    expect(parseFeatures("all").size).toBe(6);
    // Unset means every step; "none" or an empty list turns them all off.
    expect(parseFeatures(undefined).size).toBe(6);
    expect(parseFeatures(null).size).toBe(6);
    expect(parseFeatures("none").size).toBe(0);
    expect(parseFeatures("").size).toBe(0);
    expect(parseFeatures([]).size).toBe(0);
    expect([...parseFeatures(["evidence"])]).toEqual(["evidence"]);
  });

  it("keeps meaningful keywords in English and German and matches inside compounds", () => {
    expect(keywordTerms("What did the user say about the deploy license?")).toEqual(["deploy", "license"]);
    expect(keywordTerms("Welche Lizenz nutze ich für die Projekte?")).toEqual(["lizenz", "nutze", "projekte"]);
    expect(keywordCoverage(["speicher"], "Der Arbeitsspeicher ist voll")).toBe(1);
    expect(keywordCoverage(["deploy", "license"], "Deployments run on Workers Builds")).toBe(0.5);
    expect(keywordCoverage(["vpn"], "the vpns are down")).toBe(0);
    expect(keywordCoverage([], "anything")).toBe(0);
  });

  it("scores confidence from similarity and keywords", () => {
    expect(confidence(0.3, 0)).toBe(0);
    expect(confidence(0.7, 0)).toBe(0.95);
    expect(confidence(null, 1)).toBe(0.6);
    expect(confidence(0.55, 1)).toBeGreaterThan(confidence(0.55, 0));
    expect(confidence(0.9, 1)).toBeLessThanOrEqual(1);
  });

  it("abstains only when no result shares a keyword and none is similar enough", () => {
    expect(shouldAbstain([])).toBe(true);
    expect(shouldAbstain([{ similarity: 0.42, coverage: 0 }, { similarity: 0.3, coverage: 0 }])).toBe(true);
    expect(shouldAbstain([{ similarity: 0.42, coverage: 0.5 }])).toBe(false);
    expect(shouldAbstain([{ similarity: 0.55, coverage: 0 }])).toBe(false);
    // No embeddings at all: never silent.
    expect(shouldAbstain([{ similarity: null, coverage: 0 }])).toBe(false);
  });

  it("keeps one excerpt per episode and pushes near duplicates down", () => {
    const a = [1, 0, 0];
    const out = diversify([
      { id: "c1", kind: "chunk" as const, episodeId: "e1", score: 1, vec: a },
      { id: "c2", kind: "chunk" as const, episodeId: "e1", score: 0.9, vec: [0, 1, 0] },
      { id: "n1", kind: "note" as const, episodeId: null, score: 0.8, vec: a },
      { id: "n2", kind: "note" as const, episodeId: null, score: 0.7, vec: [0, 0, 1] },
      { id: "n3", kind: "note" as const, episodeId: null, score: 0.6, vec: null },
    ]);
    // n1 repeats c1, so the unrelated n3 overtakes it.
    expect(out.map((c) => c.id)).toEqual(["c1", "n2", "n3", "n1"]);
  });

  it("rebuilds a conversation from its excerpts", () => {
    const messages = [
      { role: "user", content: "Short question about the garden?" },
      { role: "assistant", content: "Plant tomatoes in May. ".repeat(80).trim() },
      { role: "user", content: "And the roses?" },
      { role: "assistant", content: "Roses like sun.\n\nWater them twice a week. ".repeat(40).trim() },
    ];
    const parts = roundChunks(messages);
    expect(parts.length).toBeGreaterThan(3);
    expect(joinExcerpts(parts)).toBe(transcript(messages));
    expect(joinExcerpts(chunk("word ".repeat(700).trim()))).toBe("word ".repeat(700).trim());
    // Excerpts that do not overlap, e.g. after one was forgotten, are joined by a line break.
    expect(joinExcerpts(["[user] first round", "", "[user] third round"])).toBe("[user] first round\n[user] third round");
  });

  it("splits a transcript into turns", () => {
    const text = transcript([
      { role: "user", content: "line one\nline two" },
      { role: "assistant", content: "[x] a checkbox, not a turn" },
    ]);
    expect(splitTurns(text)).toEqual([
      { role: "user", content: "line one\nline two" },
      { role: "assistant", content: "[x] a checkbox, not a turn" },
    ]);
    expect(splitTurns("…the end of a turn whose start was forgotten\n[user] next")).toEqual([
      { role: "text", content: "…the end of a turn whose start was forgotten" },
      { role: "user", content: "next" },
    ]);
    expect(splitTurns("plain text without turns")).toEqual([]);
    expect(sentenceWindows("One. Two! Three?\n- four\n- five")).toEqual(["One. Two!", "Three? - four", "- five"]);
  });

  it("makes a unit of every user turn and of the best window of every reply", () => {
    const turns = [
      { role: "user", content: "I adopted a cat named Miso." },
      { role: "assistant", content: "Congratulations! Cats are great. Miso is a lovely name. Do you need feeding tips?" },
      { role: "user", content: "x".repeat(3100) },
    ];
    const units = turnUnits("e1", turns, [keywordTerms("my cat Miso")]);
    expect(units.map((u) => [u.key, u.order, u.text])).toEqual([
      ["e1", 0, "[user] I adopted a cat named Miso."],
      ["e1", 1001, "[assistant] … Miso is a lovely name. Do you need feeding tips?"],
      ["e1", 2000, `[user] ${"x".repeat(1500)} …`],
      ["e1", 2001, `[user] … ${"x".repeat(1500)} …`],
      ["e1", 2002, `[user] … ${"x".repeat(300)}`],
    ]);
    // The reranker also reads the start of the reply to a user turn.
    expect(units[0]!.rank).toBe("[user] I adopted a cat named Miso. [assistant] Congratulations! Cats are great. Miso is a lovely name. Do you need feeding tips?");
    expect(units[1]!.rank).toBe(units[1]!.text);
  });

  it("fills the budget with the best units, without a cap per card", () => {
    const u = (key: string, score: number, chars = 40) => ({ key, score, text: "x".repeat(chars) });
    const units = [u("a", 0.9), u("a", 0.8), u("a", 0.7), u("b", 0.6), u("c", 0.5), u("d", 0.85, 4000)];
    // d is too long for the budget, so it is passed over; a brings all three of its units.
    expect(fillCards(units, 80, 8).map((x) => [x.key, x.score])).toEqual([["a", 0.9], ["a", 0.8], ["a", 0.7], ["b", 0.6]]);
    expect(fillCards(units, 1000, 2).map((x) => x.key)).toEqual(["a", "a", "a", "b"]);
    // The first unit always comes, even over the budget.
    expect(fillCards(units, 10, 8).map((x) => x.key)).toEqual(["a"]);
  });
});

const grants = { read: ["profile", "project:*", "agent:self"], write: ["profile", "project:*", "agent:self"] };
const claude: Client = { id: "c1", userId: "u1", name: "Claude Code", agent: "claude-code", provider: "anthropic", grants };

function generate(_model: string, system: string, user: string): string {
  if (system === EXTRACTION_PROMPT && user.includes("EDITOR")) {
    return JSON.stringify({
      facts: [
        { statement: "The user's favourite editor is Zed.", kind: "preference", scope: "profile", trust: "user_explicit", entities: [] },
        { statement: "The user values a fast rust based editor.", kind: "preference", scope: "profile", trust: "user_explicit", entities: [] },
      ],
      entities: [],
    });
  }
  if (system === EXTRACTION_PROMPT && user.includes("RATE")) {
    return JSON.stringify({
      facts: [{ statement: "The user charges a day rate of 900 euros.", kind: "fact", scope: "profile", trust: "user_explicit", entities: [] }],
      entities: [],
    });
  }
  if (system === EXTRACTION_PROMPT && user.includes("TABS")) {
    return JSON.stringify({
      facts: [{ statement: "The user indents code with tabs, never spaces.", kind: "preference", scope: "profile", trust: "user_explicit", entities: [] }],
      entities: [],
    });
  }
  return JSON.stringify({ facts: [], entities: [] });
}

let now = Date.UTC(2026, 10, 26, 10);
vi.spyOn(Date, "now").mockImplementation(() => now);
afterAll(() => vi.restoreAllMocks());

describe("MemoryObject recall steps", () => {
  let mo: MemoryObject;
  let fake: ReturnType<typeof fakeEnv>;
  let db: ReturnType<typeof fakeState>["db"];

  const settle = async () => {
    for (let i = 0; i < 12; i++) {
      now += 5_000;
      await mo.alarm();
    }
  };

  beforeEach(() => {
    const s = fakeState();
    db = s.db;
    fake = fakeEnv(generate);
    mo = new MemoryObject(s.state as never, fake.env as never);
  });

  it("adds a confidence to every result without changing the default order", async () => {
    await mo.addNote(claude, { scope: "profile", content: "The user deploys every app through Workers Builds." });
    await mo.addNote(claude, { scope: "profile", content: "The user drinks green tea in the morning." });
    await settle();
    const res = await mo.recall(claude, { query: "Workers Builds deploys", scopes: ["profile"], rerank: false, features: [] });
    expect(res.items[0]!.content).toContain("Workers Builds");
    expect(res.items[0]!.confidence).toBeGreaterThan(0.5);
    expect(res.abstained).toBeUndefined();
    expect(res.items.every((i) => typeof i.confidence === "number")).toBe(true);
  });

  it("abstains when nothing is relevant, only with the abstain step", async () => {
    await mo.addNote(claude, { scope: "profile", content: "The user drinks green tea in the morning." });
    await settle();
    const plain = await mo.recall(claude, { query: "kubernetes cluster upgrade", scopes: ["profile"], rerank: false, features: [] });
    // The newest items always join the pool, so default recall returns the tea note.
    expect(plain.items).toHaveLength(1);
    const res = await mo.recall(claude, { query: "kubernetes cluster upgrade", scopes: ["profile"], rerank: false, features: ["abstain"] });
    expect(res).toMatchObject({ items: [], abstained: true });
    const hit = await mo.recall(claude, { query: "green tea", scopes: ["profile"], rerank: false, features: ["abstain"] });
    expect(hit.abstained).toBe(false);
    expect(hit.items).toHaveLength(1);
  });

  it("brings a note's source excerpt as evidence and keeps one excerpt per episode", async () => {
    await mo.addEpisode(claude, {
      scope: "profile",
      messages: [
        { role: "user", content: "TABS: please indent with tabs. ".repeat(60) },
        { role: "assistant", content: "Understood, tabs it is. ".repeat(60) },
      ],
    });
    await settle();
    const res = await mo.recall(claude, { query: "tabs indent", scopes: ["profile"], rerank: false, features: ["evidence", "diversity"], budgetTokens: 4000 });
    const note = res.items.find((i) => i.kind === "note")!;
    expect(note.content).toBe("The user indents code with tabs, never spaces.");
    expect(note.evidence?.content).toContain("tabs");
    expect(res.text).toContain("source (2026-11-26)");
    const chunks = res.items.filter((i) => i.kind === "chunk");
    expect(chunks.length).toBeLessThanOrEqual(1);
    expect(chunks.map((c) => c.id)).not.toContain(note.evidence!.id);

    const plain = await mo.recall(claude, { query: "tabs indent", scopes: ["profile"], rerank: false, budgetTokens: 4000, features: [] });
    expect(plain.items.filter((i) => i.kind === "chunk").length).toBeGreaterThan(1);
    expect(plain.items.some((i) => i.evidence)).toBe(false);
  });

  it("passes a note's source excerpt only when the recall may read the conversation's scope", async () => {
    // A profile fact said in a project conversation: the note is in profile, its source in the project.
    await mo.addEpisode(claude, {
      scope: "project:acme",
      messages: [
        { role: "user", content: "RATE: for Acme I bill 900 euros a day, and the Orion launch is fixed for March 3." },
        { role: "assistant", content: "Noted: 900 euros per day, Orion launches on March 3." },
      ],
    });
    await settle();
    const opts = { query: "day rate euros", rerank: false, features: ["evidence"], budgetTokens: 4000 };
    const narrow = await mo.recall(claude, { ...opts, scopes: ["profile"] });
    const note = narrow.items.find((i) => i.kind === "note")!;
    expect(note.scope).toBe("profile");
    expect(note.evidence).toBeUndefined();
    expect(narrow.text).not.toContain("Orion");

    // With the project readable too, the excerpt comes along (limit 1 keeps the chunk itself out of the results).
    const wide = await mo.recall(claude, { ...opts, scopes: ["profile", "project:acme"], limit: 1 });
    const same = wide.items.find((i) => i.id === note.id)!;
    expect(same.evidence?.content).toContain("Orion launch");
  });

  it("limits recall to the agent's time range and to time words in the query", async () => {
    const day = 86_400_000;
    await mo.addNote(claude, { scope: "profile", content: "Decision about the database: D1 for va-dispatcher.", tEvent: now - 20 * day });
    await mo.addNote(claude, { scope: "profile", content: "Decision about the database: Postgres stays for roots.", tEvent: now - 2 * day });
    await settle();
    const all = await mo.recall(claude, { query: "database decision", scopes: ["profile"], rerank: false });
    expect(all.items).toHaveLength(2);

    const ranged = await mo.recall(claude, { query: "database decision", scopes: ["profile"], rerank: false, from: now - 7 * day });
    expect(ranged.items.map((i) => i.content)).toEqual(["Decision about the database: Postgres stays for roots."]);
    expect(ranged.window).toMatchObject({ source: "agent", to: null });

    // "letzte Woche" = 16 to 22 November; the D1 note is from 6 November.
    const off = await mo.recall(claude, { query: "Datenbank database decision letzte Woche", scopes: ["profile"], rerank: false });
    expect(off.items).toHaveLength(2);
    const timed = await mo.recall(claude, { query: "database decision in den letzten 5 Tagen", scopes: ["profile"], rerank: false, features: ["time"] });
    expect(timed.items.map((i) => i.content)).toEqual(["Decision about the database: Postgres stays for roots."]);
    expect(timed.window).toMatchObject({ source: "query", text: "letzten 5 tagen" });

    // Nothing inside a window read from the query: recall falls back to no window.
    const empty = await mo.recall(claude, { query: "database decision yesterday", scopes: ["profile"], rerank: false, features: ["time"] });
    expect(empty.items).toHaveLength(2);
    expect(empty.window).toBeUndefined();

    // Time words are read against a reference time when one is given.
    const then = await mo.recall(claude, { query: "database decision 2 weeks ago", scopes: ["profile"], rerank: false, features: ["time"], referenceTime: now - 5 * day });
    expect(then.items.map((i) => i.content)).toEqual(["Decision about the database: D1 for va-dispatcher."]);
  });

  it("searches sub-queries too", async () => {
    await mo.addNote(claude, { scope: "profile", content: "The user's laptop is a ThinkPad X1.", tEvent: now - 86_400_000 });
    const plants = ["tomatoes", "basil", "roses", "carrots", "lettuce", "tulips", "peppers", "onions", "garlic", "mint", "thyme", "beans"];
    for (const p of plants) await mo.addNote(claude, { scope: "profile", content: `Gardening: the user grows ${p}.` });
    await settle();
    const without = await mo.recall(claude, { query: "gardening", scopes: ["profile"], rerank: false, limit: 12 });
    expect(without.items.map((i) => i.content)).not.toContain("The user's laptop is a ThinkPad X1.");
    const withSub = await mo.recall(claude, { query: "gardening", queries: ["ThinkPad laptop"], scopes: ["profile"], rerank: false, limit: 12 });
    expect(withSub.items.map((i) => i.content)).toContain("The user's laptop is a ThinkPad X1.");
  });

  it("answers as of a past time with the version that was true then", async () => {
    const day = 86_400_000;
    const t0 = now;
    const old = await mo.addNote(claude, { scope: "profile", content: "The user's main laptop is a ThinkPad.", tEvent: t0 - 30 * day });
    const fresh = await mo.addNote(claude, { scope: "profile", content: "The user's main laptop is a MacBook.", tEvent: t0 - 10 * day });
    const merged = await mo.addNote(claude, { scope: "profile", content: "The user's main laptop is a Framework.", tEvent: t0 - 40 * day });
    await settle();
    // An update closed the ThinkPad note's validity; the Framework note is a merged duplicate (no end).
    db.prepare("UPDATE items SET status = 'superseded', superseded_by = ?, valid_to = ?, expired_at = ? WHERE id = ?").run(fresh.id, t0 - 10 * day, t0, old.id);
    db.prepare("UPDATE items SET status = 'superseded', superseded_by = ?, expired_at = ? WHERE id = ?").run(fresh.id, t0, merged.id);

    const today = await mo.recall(claude, { query: "main laptop", scopes: ["profile"], rerank: false });
    expect(today.items.map((i) => i.content)).toEqual(["The user's main laptop is a MacBook."]);
    const then = await mo.recall(claude, { query: "main laptop", scopes: ["profile"], rerank: false, asOf: t0 - 20 * day });
    expect(then.items.map((i) => i.content)).toEqual(["The user's main laptop is a ThinkPad."]);
    expect(then.asOf).toBe(new Date(t0 - 20 * day).toISOString());
    // Before anything was true, there is nothing.
    const before = await mo.recall(claude, { query: "main laptop", scopes: ["profile"], rerank: false, asOf: t0 - 50 * day });
    expect(before.items).toEqual([]);
  });

  it("cuts conversations into rounds when asked to", async () => {
    const long = (x: string) => x.repeat(40);
    const messages = [
      { role: "user", content: long("Which license? ") },
      { role: "assistant", content: long("AGPL. ") },
      { role: "user", content: long("Which runtime? ") },
      { role: "assistant", content: long("Node 26. ") },
    ];
    const fixed = await mo.addEpisode(claude, { scope: "profile", messages });
    const rounds = await mo.addEpisode(claude, { scope: "profile", messages, chunking: "rounds" });
    expect(rounds.chunks).toBe(2);
    const contents = (id: string) => (db.prepare("SELECT content FROM items WHERE episode_id = ? ORDER BY rowid").all(id) as { content: string }[]).map((r) => r.content);
    expect(contents(rounds.id)[1]!.startsWith("[user] Which runtime?")).toBe(true);
    // Fixed chunks cut the second question off from where it starts.
    expect(contents(fixed.id).some((c) => c.startsWith("[user] Which runtime?"))).toBe(false);
  });

  it("finds an excerpt through the facts extracted from it", async () => {
    const day = 86_400_000;
    await mo.addEpisode(claude, {
      scope: "profile",
      tEvent: now - 5 * day,
      messages: [{ role: "user", content: "EDITOR: these days I mostly write code in that new rust based editor, it is fast." }],
    });
    for (const n of ["apples", "pears", "plums", "cherries", "grapes", "melons"]) await mo.addNote(claude, { scope: "profile", content: `The user buys ${n}.` });
    await settle();
    const chunk = db.prepare("SELECT id FROM items WHERE kind = 'chunk'").get() as { id: string };
    expect(db.prepare("SELECT keys FROM chunk_keys").all()).toEqual([{ keys: "The user's favourite editor is Zed.\nThe user values a fast rust based editor." }]);

    const without = await mo.recall(claude, { query: "Zed", scopes: ["profile"], rerank: false, features: [] });
    expect(without.items.map((i) => i.id)).not.toContain(chunk.id);
    const withKeys = await mo.recall(claude, { query: "Zed", scopes: ["profile"], rerank: false, features: ["keys"] });
    expect(withKeys.items.map((i) => i.id)).toContain(chunk.id);

    // Reflection backfills keys for episodes extracted before keys existed.
    db.prepare("DELETE FROM chunk_keys").run();
    await mo.requestReflection();
    await settle();
    expect(db.prepare("SELECT keys FROM chunk_keys").all()).toEqual([{ keys: "The user's favourite editor is Zed.\nThe user values a fast rust based editor." }]);

    // Forgetting the note removes its wording from the excerpt's keys.
    const web = { ...claude, id: "web:u1", grants: { read: ["profile"], write: ["profile"] } };
    const note = db.prepare("SELECT id FROM items WHERE content = ?").get("The user's favourite editor is Zed.") as { id: string };
    await mo.forget(web, note.id);
    expect(db.prepare("SELECT keys FROM chunk_keys").all()).toEqual([{ keys: "The user values a fast rust based editor." }]);
    const gone = await mo.recall(claude, { query: "Zed", scopes: ["profile"], rerank: false, features: ["keys"] });
    expect(gone.items.map((i) => i.id)).not.toContain(chunk.id);

    // Forgetting the episode removes its keys.
    const ep = db.prepare("SELECT id FROM episodes").get() as { id: string };
    await mo.forget(web, ep.id);
    expect(db.prepare("SELECT COUNT(*) AS n FROM chunk_keys").get()).toEqual({ n: 0 });
  });
});

describe("MemoryObject turn cards", () => {
  let mo: MemoryObject;
  let fake: ReturnType<typeof fakeEnv>;
  const day = 86_400_000;

  const settle = async () => {
    for (let i = 0; i < 12; i++) {
      now += 5_000;
      await mo.alarm();
    }
  };

  beforeEach(async () => {
    const s = fakeState();
    fake = fakeEnv(generate);
    mo = new MemoryObject(s.state as never, fake.env as never);
    await mo.addEpisode(claude, {
      scope: "profile",
      tEvent: now - 10 * day,
      messages: [
        { role: "user", content: "I adopted a cat named Miso last spring." },
        { role: "assistant", content: "Congratulations! Cats are great company. Miso is a lovely name. Do you need tips on feeding?" },
        { role: "user", content: "What is the weather like in Lisbon in May?" },
        { role: "assistant", content: "Lisbon is warm in May. Expect sunny days." },
      ],
    });
    await mo.addEpisode(claude, {
      scope: "profile",
      tEvent: now - 2 * day,
      messages: [
        { role: "user", content: "Miso and I moved to Berlin in October." },
        { role: "assistant", content: "Berlin is a great city for cats." },
      ],
    });
    await settle();
  });

  it("hands out the best turns, one card per conversation, in the order things happened", async () => {
    const res = await mo.recall(claude, { query: "Where does my cat Miso live?", scopes: ["profile"], features: ["turns"], budgetTokens: 70 });
    expect(res.items.map((i) => i.parts)).toEqual([
      ["[user] I adopted a cat named Miso last spring.", "[assistant] … Miso is a lovely name. Do you need tips on feeding?"],
      ["[user] Miso and I moved to Berlin in October."],
    ]);
    expect(res.items.map((i) => i.kind)).toEqual(["chunk", "chunk"]);
    expect(res.items[0]!.content).toBe(res.items[0]!.parts!.join("\n"));
    expect(res.items[0]!.tEvent < res.items[1]!.tEvent).toBe(true);
    expect(res.text).toContain("[user] Miso and I moved to Berlin in October.");

    // With room for everything, a card shows all of its turns in order.
    const wide = await mo.recall(claude, { query: "Where does my cat Miso live?", scopes: ["profile"], features: ["turns"] });
    expect(wide.items[0]!.parts).toHaveLength(4);
    expect(wide.items[0]!.parts![2]).toBe("[user] What is the weather like in Lisbon in May?");
  });

  it("lets notes compete with turns and keeps plain excerpts on request or without the reranker", async () => {
    await mo.addNote(claude, { scope: "profile", content: "The user's cat Miso lives in Berlin." });
    await settle();
    const res = await mo.recall(claude, { query: "Where does my cat Miso live?", scopes: ["profile"], features: ["turns"] });
    expect(res.items.map((i) => i.kind)).toEqual(["chunk", "chunk", "note"]);
    expect(res.items[2]!.parts).toBeUndefined();

    const plain = await mo.recall(claude, { query: "Where does my cat Miso live?", scopes: ["profile"], features: ["turns"], cards: false });
    expect(plain.items.some((i) => i.parts)).toBe(false);
    expect(plain.items.find((i) => i.kind === "chunk")!.content).toContain("[user] I adopted a cat named Miso last spring.\n[assistant]");

    const run = fake.env.AI.run;
    fake.env.AI.run = async (model, input) => {
      if (input.contexts) throw new Error("reranker down");
      return run(model, input);
    };
    const down = await mo.recall(claude, { query: "Where does my cat Miso live?", scopes: ["profile"], features: ["turns"] });
    expect(down.items.length).toBeGreaterThan(0);
    expect(down.items.some((i) => i.parts)).toBe(false);
  });
});
