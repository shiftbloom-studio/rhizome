// SPDX-License-Identifier: AGPL-3.0-or-later
// Recall steps: confidence, abstention, diversity, evidence, time windows and sub-queries.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EXTRACTION_PROMPT } from "../src/intel";
import { MemoryObject } from "../src/memory-object";
import { confidence, diversify, keywordCoverage, keywordTerms, parseFeatures, shouldAbstain } from "../src/recall";
import type { Client } from "../src/scopes";
import { fakeEnv, fakeState } from "./support/fake-do";

describe("recall helpers", () => {
  it("parses feature lists", () => {
    expect([...parseFeatures("abstain, diversity,unknown")]).toEqual(["abstain", "diversity"]);
    expect(parseFeatures("all").size).toBe(4);
    expect(parseFeatures(undefined).size).toBe(0);
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
});

const grants = { read: ["profile", "project:*", "agent:self"], write: ["profile", "project:*", "agent:self"] };
const claude: Client = { id: "c1", userId: "u1", name: "Claude Code", agent: "claude-code", provider: "anthropic", grants };

function generate(_model: string, system: string, user: string): string {
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

  const settle = async () => {
    for (let i = 0; i < 12; i++) {
      now += 5_000;
      await mo.alarm();
    }
  };

  beforeEach(() => {
    const s = fakeState();
    fake = fakeEnv(generate);
    mo = new MemoryObject(s.state as never, fake.env as never);
  });

  it("adds a confidence to every result without changing the default order", async () => {
    await mo.addNote(claude, { scope: "profile", content: "The user deploys every app through Workers Builds." });
    await mo.addNote(claude, { scope: "profile", content: "The user drinks green tea in the morning." });
    await settle();
    const res = await mo.recall(claude, { query: "Workers Builds deploys", scopes: ["profile"], rerank: false });
    expect(res.items[0]!.content).toContain("Workers Builds");
    expect(res.items[0]!.confidence).toBeGreaterThan(0.5);
    expect(res.abstained).toBeUndefined();
    expect(res.items.every((i) => typeof i.confidence === "number")).toBe(true);
  });

  it("abstains when nothing is relevant, only with the abstain step", async () => {
    await mo.addNote(claude, { scope: "profile", content: "The user drinks green tea in the morning." });
    await settle();
    const plain = await mo.recall(claude, { query: "kubernetes cluster upgrade", scopes: ["profile"], rerank: false });
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

    const plain = await mo.recall(claude, { query: "tabs indent", scopes: ["profile"], rerank: false, budgetTokens: 4000 });
    expect(plain.items.filter((i) => i.kind === "chunk").length).toBeGreaterThan(1);
    expect(plain.items.some((i) => i.evidence)).toBe(false);
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
});
