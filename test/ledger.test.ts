// SPDX-License-Identifier: AGPL-3.0-or-later
// Ledger: corrections go once to exactly the connectors that were given the old version.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EXTRACTION_PROMPT, RESOLVER_PROMPT } from "../src/intel";
import { correctionLines, ledgerEnabled, needsCorrection, QUOTE_CHARS } from "../src/ledger";
import { mcpResponse, type MemoryApi } from "../src/mcp";
import { MemoryObject } from "../src/memory-object";
import { DEFAULT_GRANTS, type Client } from "../src/scopes";
import { fakeEnv, fakeState } from "./support/fake-do";

const claudeCode: Client = { id: "c-claude", userId: "u1", name: "Claude Code", agent: "claude-code", provider: "anthropic", grants: DEFAULT_GRANTS };
const chatgpt: Client = { id: "c-chatgpt", userId: "u1", name: "ChatGPT", agent: "chatgpt", provider: "openai", grants: DEFAULT_GRANTS };
const cursor: Client = { id: "c-cursor", userId: "u1", name: "Cursor", agent: "cursor", provider: "cursor", grants: DEFAULT_GRANTS };

const PNPM = "The user wants pnpm in every project.";
const BUN = "The user wants bun in every project.";

/** Extraction answers keyed by a marker in the episode. */
const EXTRACTIONS: Record<string, unknown> = {
  PNPM: { facts: [{ statement: PNPM, kind: "preference", scope: "profile", trust: "user_explicit", entities: [] }], entities: [] },
  BUN: { facts: [{ statement: BUN, kind: "preference", scope: "profile", trust: "user_explicit", relation: "update", related: 0, entities: [] }], entities: [] },
  ACME: { facts: [{ statement: "Acme deploys on Fridays.", kind: "fact", scope: "project", trust: "user_explicit", entities: [] }], entities: [] },
  GLOBEX: { facts: [{ statement: "Globex reviews every release.", kind: "fact", scope: "project", trust: "user_explicit", entities: [] }], entities: [] },
  MONDAY: { facts: [{ statement: "Acme deploys on Mondays.", kind: "fact", scope: "project", trust: "user_explicit", relation: "update", related: 0, entities: [] }], entities: [] },
};

function generate(_model: string, system: string, user: string): string {
  if (system === EXTRACTION_PROMPT) {
    const episode = user.split("\n\nRelated memory:")[0]!;
    const key = Object.keys(EXTRACTIONS).find((k) => episode.includes(k))!;
    return JSON.stringify(EXTRACTIONS[key]);
  }
  if (system === RESOLVER_PROMPT) return JSON.stringify({ results: [{ pair: 0, relation: "update" }] });
  return "";
}

let now = Date.UTC(2026, 10, 26, 9);
vi.spyOn(Date, "now").mockImplementation(() => now);
afterAll(() => vi.restoreAllMocks());

type Body = { result: { content: { text: string }[]; structuredContent?: { corrections?: string[] } } };
let rpcId = 0;
async function tool(memory: MemoryObject, client: Client, name: string, args: Record<string, unknown>) {
  const res = await mcpResponse(memory as unknown as MemoryApi, client, { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }, "test");
  const body = (await res.json()) as Body;
  return { text: body.result.content[0]!.text, corrections: body.result.structuredContent?.corrections };
}

async function settle(mo: MemoryObject) {
  for (let i = 0; i < 20; i++) {
    now += 5_000;
    await mo.alarm();
  }
}

async function say(mo: MemoryObject, client: Client, scope: string, content: string) {
  await mo.addEpisode(client, { scope, messages: [{ role: "user", content }] });
  await settle(mo);
}

function setup(ledger: string | undefined) {
  const s = fakeState();
  const fake = fakeEnv(generate);
  const mo = new MemoryObject(s.state as never, { ...fake.env, ...(ledger === undefined ? {} : { LEDGER: ledger }) } as never);
  return { mo, db: s.db };
}

describe("ledger", () => {
  beforeEach(() => {
    now = Date.UTC(2026, 10, 26, 9);
  });

  it("is off with LEDGER=off: nothing is recorded and nobody is told", async () => {
    const { mo, db } = setup("off");
    await say(mo, claudeCode, "profile", "PNPM for every project from now on, please");
    expect((await tool(mo, claudeCode, "get_context", {})).text).toContain(PNPM);
    await say(mo, claudeCode, "profile", "switching: BUN for every project from today on");
    const next = await tool(mo, claudeCode, "get_context", {});
    expect(next.text).not.toContain("Corrections");
    expect(next.corrections).toBeUndefined();
    expect(db.prepare("SELECT COUNT(*) AS n FROM deliveries").get()).toEqual({ n: 0 });
  });

  it("tells exactly the connectors that were given the old version, once", async () => {
    const { mo, db } = setup("on");
    await say(mo, claudeCode, "profile", "PNPM for every project from now on, please");
    // 2026-11-26: Claude Code and ChatGPT are given the note; Cursor is not.
    expect((await tool(mo, claudeCode, "get_context", {})).text).toContain(PNPM);
    expect((await tool(mo, chatgpt, "recall", { query: "which package manager pnpm" })).text).toContain(PNPM);

    now = Date.UTC(2026, 10, 28, 9);
    await say(mo, claudeCode, "profile", "switching: BUN for every project from today on");

    const claudeNext = await tool(mo, claudeCode, "recall", { query: "how to run tests" });
    expect(claudeNext.corrections).toHaveLength(2);
    expect(claudeNext.corrections![1]).toContain(`You were given "${PNPM}" on 2026-11-26. Since 2026-11-28 it is: "${BUN}"`);
    expect(claudeNext.text.startsWith("Corrections to memory you were given earlier (told once):")).toBe(true);

    const chatgptNext = await tool(mo, chatgpt, "get_context", {});
    expect(chatgptNext.corrections?.join("\n")).toContain(BUN);
    expect(chatgptNext.text.indexOf("Corrections")).toBeLessThan(chatgptNext.text.indexOf("## Remembered notes"));

    // Cursor never had pnpm: it gets the current note, no correction.
    const cursorNext = await tool(mo, cursor, "get_context", {});
    expect(cursorNext.text).toContain(BUN);
    expect(cursorNext.corrections).toBeUndefined();

    // Told once.
    expect((await tool(mo, claudeCode, "recall", { query: "how to run tests" })).corrections).toBeUndefined();
    expect((await tool(mo, chatgpt, "get_context", {})).corrections).toBeUndefined();
    const rows = db.prepare("SELECT d.agent, d.corrected_at FROM deliveries d JOIN items i ON i.id = d.item_id WHERE i.content = ? ORDER BY d.agent").all(PNPM);
    expect(rows).toEqual([
      { agent: "chatgpt", corrected_at: expect.any(Number) },
      { agent: "claude-code", corrected_at: expect.any(Number) },
    ]);
  });

  it("follows a later change of the corrected note", async () => {
    const { mo } = setup("on");
    await say(mo, claudeCode, "profile", "PNPM for every project from now on, please");
    await tool(mo, claudeCode, "get_context", {});
    await say(mo, claudeCode, "profile", "switching: BUN for every project from today on");
    expect((await tool(mo, claudeCode, "get_context", {})).corrections).toHaveLength(2);
    // Forgetting the bun note brings pnpm back; the connector holds bun, so it hears about the deletion.
    const bun = (await mo.recall(claudeCode, { query: "bun", scopes: ["profile"], rerank: false })).items.find((i) => i.content === BUN)!;
    await mo.forget(claudeCode, bun.id);
    const next = await tool(mo, claudeCode, "get_context", {});
    expect(next.corrections?.join("\n")).toContain(`The person deleted a memory you were given on 2026-11-26 [${bun.id}]`);
  });

  it("sends a deletion notice without the deleted text", async () => {
    const { mo } = setup("on");
    await say(mo, claudeCode, "profile", "PNPM for every project from now on, please");
    const recalled = await tool(mo, chatgpt, "recall", { query: "pnpm" });
    expect(recalled.text).toContain(PNPM);
    const note = (await mo.recall(claudeCode, { query: "pnpm", scopes: ["profile"], rerank: false })).items.find((i) => i.content === PNPM)!;
    await mo.forget(claudeCode, note.id);
    const next = await tool(mo, chatgpt, "recall", { query: "pnpm" });
    const lines = next.corrections!.join("\n");
    // The note and the excerpt it came from were both given; only the note was deleted.
    expect(lines).toContain(note.id);
    expect(lines).not.toContain("pnpm");
    expect((await tool(mo, chatgpt, "recall", { query: "pnpm" })).corrections).toBeUndefined();
  });

  it("says nothing when a note was only merged with a duplicate", async () => {
    const { mo, db } = setup("on");
    const old = await mo.addNote(claudeCode, { scope: "profile", content: PNPM, kind: "preference", trust: "user_explicit" });
    await settle(mo);
    await tool(mo, claudeCode, "get_context", {});
    const other = await mo.addNote(chatgpt, { scope: "profile", content: "pnpm is the package manager the user picks.", kind: "preference", trust: "user_explicit" });
    await settle(mo);
    // Reflection keeps the older note as the survivor; merge the other way round to reach this path.
    const inner = mo as unknown as { ctx: { storage: { transactionSync(f: () => void): void } }; merge(s: string, l: string, at: number): void };
    inner.ctx.storage.transactionSync(() => inner.merge(other.id, old.id, now));
    const next = await tool(mo, claudeCode, "get_context", {});
    expect(next.corrections).toBeUndefined();
    // The connector now holds the surviving note, so a later change of it reaches it.
    const held = db.prepare("SELECT item_id, corrected_at FROM deliveries WHERE client_id = ? ORDER BY first_at, item_id").all(claudeCode.id) as { item_id: string; corrected_at: number | null }[];
    expect(held.find((r) => r.item_id === old.id)?.corrected_at).toEqual(expect.any(Number));
    expect(held.find((r) => r.item_id === other.id)?.corrected_at).toBeNull();
  });

  it("tells a change only to a call that may read it", async () => {
    const { mo } = setup("on");
    await say(mo, claudeCode, "project:acme", "ACME ships its deploys on Fridays");
    expect((await tool(mo, claudeCode, "get_context", { project: "acme" })).text).toContain("Acme deploys on Fridays.");
    await say(mo, claudeCode, "project:acme", "MONDAY is the deploy day for Acme from now on");
    // A call without the project does not read it, so the correction waits.
    expect((await tool(mo, claudeCode, "get_context", {})).corrections).toBeUndefined();
    const inProject = await tool(mo, claudeCode, "get_context", { project: "acme" });
    expect(inProject.corrections?.join("\n")).toContain("Acme deploys on Mondays.");
  });

  it("keeps corrections inside their wall", async () => {
    const { mo } = setup("on");
    mo.setWall(claudeCode, "acme", ["project:acme"]);
    mo.setWall(claudeCode, "globex", ["project:globex"]);
    await say(mo, claudeCode, "project:acme", "ACME ships its deploys on Fridays");
    await say(mo, claudeCode, "project:globex", "GLOBEX wants a review for every release");
    expect((await tool(mo, claudeCode, "get_context", { project: "acme", conversation: "c-acme" })).text).toContain("Acme deploys on Fridays.");
    await say(mo, claudeCode, "project:acme", "MONDAY is the deploy day for Acme from now on");

    // A conversation behind the other wall, or one that names no project, hears nothing of it.
    const globex = await tool(mo, claudeCode, "get_context", { project: "globex", conversation: "c-globex" });
    expect(globex.corrections).toBeUndefined();
    expect(globex.text).toContain("Globex reviews every release.");
    expect(globex.text).not.toContain("Acme");
    expect((await tool(mo, claudeCode, "recall", { query: "deploy day", conversation: "c-plain" })).corrections).toBeUndefined();
    // The globex conversation naming acme is kept out of the second wall, corrections included.
    const crossing = await tool(mo, claudeCode, "recall", { query: "deploy day", project: "acme", conversation: "c-globex" });
    expect(crossing.corrections).toBeUndefined();
    expect(crossing.text).not.toContain("Mondays");

    // Inside the wall it is told, once.
    const inside = await tool(mo, claudeCode, "get_context", { project: "acme", conversation: "c-acme" });
    expect(inside.corrections?.join("\n")).toContain("Acme deploys on Mondays.");
    expect((await tool(mo, claudeCode, "get_context", { project: "acme", conversation: "c-acme" })).corrections).toBeUndefined();
  });

  it("does not record recall as of a past time", async () => {
    const { mo, db } = setup("on");
    await say(mo, claudeCode, "profile", "PNPM for every project from now on, please");
    await tool(mo, claudeCode, "recall", { query: "pnpm", as_of: "2026-11-27" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM deliveries").get()).toEqual({ n: 0 });
  });

  it("does not record the explorer or the REST API", async () => {
    const { mo, db } = setup("on");
    await say(mo, claudeCode, "profile", "PNPM for every project from now on, please");
    mo.context(claudeCode, ["profile"]);
    await mo.recall(claudeCode, { query: "pnpm", scopes: ["profile"], rerank: false });
    expect(db.prepare("SELECT COUNT(*) AS n FROM deliveries").get()).toEqual({ n: 0 });
  });

  it("shows who was given a memory in the explorer detail", async () => {
    const { mo } = setup("on");
    await say(mo, claudeCode, "profile", "PNPM for every project from now on, please");
    await tool(mo, chatgpt, "get_context", {});
    const note = (await mo.recall(claudeCode, { query: "pnpm", scopes: ["profile"], rerank: false })).items.find((i) => i.content === PNPM)!;
    const detail = (await mo.detail(claudeCode, note.id)) as { deliveredTo?: { agent: string; provider: string; times: number }[] };
    expect(detail.deliveredTo).toMatchObject([{ agent: "chatgpt", provider: "openai", times: 1 }]);
  });
});

describe("ledger helpers", () => {
  it("reads the flag", () => {
    expect(ledgerEnabled(undefined)).toBe(false);
    expect(ledgerEnabled("off")).toBe(false);
    expect(ledgerEnabled(" ON ")).toBe(true);
  });

  it("needs a real replacement, not only merges", () => {
    expect(needsCorrection([{ merged: true }])).toBe(false);
    expect(needsCorrection([{ merged: true }, { merged: false }])).toBe(true);
  });

  it("keeps lines short", () => {
    const long = "x".repeat(QUOTE_CHARS * 3);
    const lines = correctionLines({
      replaced: [{ id: "a", oldText: long, givenAt: 0, newId: "b", newText: "short", newScope: "profile", changedAt: 0 }],
      deleted: [{ id: "c", givenAt: 0 }, { id: "d", givenAt: 0 }],
    });
    expect(lines).toHaveLength(3);
    expect(lines[1]!.length).toBeLessThan(QUOTE_CHARS + 120);
    expect(lines[2]).toBe("- The person deleted 2 memories you were given earlier [c, d]. Do not rely on them.");
    expect(correctionLines({ replaced: [], deleted: [] })).toEqual([]);
  });
});
