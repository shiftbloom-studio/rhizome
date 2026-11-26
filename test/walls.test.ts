// SPDX-License-Identifier: AGPL-3.0-or-later
// Walls: two clients' projects in one memory, through the real MCP layer.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EXTRACTION_PROMPT } from "../src/intel";
import { mcpResponse, type MemoryApi } from "../src/mcp";
import { MemoryObject } from "../src/memory-object";
import { DEFAULT_GRANTS, type Client } from "../src/scopes";
import { admitNamed, LEFT_OUT_NOTICE } from "../src/walls";
import { fakeEnv, fakeState } from "./support/fake-do";

const claudeCode: Client = { id: "c-claude", userId: "u1", name: "Claude Code", agent: "claude-code", provider: "anthropic", grants: DEFAULT_GRANTS };
const cursor: Client = { id: "c-cursor", userId: "u1", name: "Cursor", agent: "cursor", provider: "cursor", grants: DEFAULT_GRANTS };

let now = Date.UTC(2026, 10, 26, 9);
vi.spyOn(Date, "now").mockImplementation(() => now);
afterAll(() => vi.restoreAllMocks());

type ToolBody = { result: { content: { text: string }[]; isError?: boolean; structuredContent?: { results?: { scope: string; content: string }[]; notices?: string[]; conversation?: string; scope?: string; heldFor?: string } } };
let rpcId = 0;
async function tool(memory: MemoryObject, client: Client, name: string, args: Record<string, unknown>) {
  const res = await mcpResponse(memory as unknown as MemoryApi, client, { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }, "test");
  const body = (await res.json()) as ToolBody;
  const sc = body.result.structuredContent;
  return { text: body.result.content[0]!.text, results: sc?.results ?? [], notices: sc?.notices, conversation: sc?.conversation, scope: sc?.scope, heldFor: sc?.heldFor, isError: body.result.isError === true };
}
const count = (rows: { scope: string }[], scope: string) => rows.filter((r) => r.scope === scope).length;

describe("admitNamed", () => {
  const walls = { acme: ["project:acme"], globex: ["project:globex"] };
  it("changes nothing without walls or when every scope was named", () => {
    expect(admitNamed(["profile", "project:acme"], [], {})).toEqual({ scopes: ["profile", "project:acme"], notices: [] });
    expect(admitNamed(["profile", "project:acme"], undefined, walls)).toEqual({ scopes: ["profile", "project:acme"], notices: [] });
  });
  it("leaves out walled scopes the call did not name, with a notice", () => {
    expect(admitNamed(["profile", "project:acme", "project:globex", "project:site"], ["project:globex"], walls)).toEqual({
      scopes: ["profile", "project:globex", "project:site"],
      notices: [LEFT_OUT_NOTICE],
    });
  });
});

describe("walls in recall", () => {
  let mo: MemoryObject;

  beforeEach(async () => {
    now = Date.UTC(2026, 10, 26, 9);
    const s = fakeState();
    mo = new MemoryObject(s.state as never, fakeEnv(() => JSON.stringify({ facts: [], entities: [] })).env as never);
    await mo.addNote(claudeCode, { scope: "profile", content: "The user prefers short replies that lead with the budget.", kind: "preference", trust: "user_explicit" });
    await mo.addNote(claudeCode, { scope: "project:acme", content: "Acme's budget for the Orion feature is 60,000 euros.", kind: "fact", trust: "user_confirmed" });
    await mo.addNote(claudeCode, { scope: "project:acme", content: "Acme's contract forbids subcontracting.", kind: "fact", trust: "user_confirmed" });
    await mo.addNote(cursor, { scope: "project:globex", content: "Globex's budget for the redesign is 40,000 euros.", kind: "fact", trust: "user_confirmed" });
    await mo.addNote(cursor, { scope: "project:site", content: "The site's budget for hosting is 20 euros a month.", kind: "fact", trust: "user_confirmed" });
    for (let i = 0; i < 12; i++) {
      now += 5_000;
      await mo.alarm();
    }
  });

  it("are off by default: a recall without a project searches every project", async () => {
    expect(mo.listWalls(claudeCode)).toEqual([]);
    const open = await tool(mo, cursor, "recall", { query: "budget euros" });
    expect(count(open.results, "project:acme")).toBeGreaterThan(0);
    expect(count(open.results, "project:globex")).toBeGreaterThan(0);
    expect(open.notices).toBeUndefined();
    expect(open.text).not.toContain("Walled");
  });

  it("leave a walled project out of a recall that does not name it, and say so", async () => {
    mo.setWall(claudeCode, "acme", ["project:acme"]);
    mo.setWall(claudeCode, "globex", ["project:globex"]);
    const open = await tool(mo, cursor, "recall", { query: "budget euros" });
    expect(count(open.results, "project:acme")).toBe(0);
    expect(count(open.results, "project:globex")).toBe(0);
    // Projects outside every wall and the profile behave as before.
    expect(count(open.results, "project:site")).toBe(1);
    expect(count(open.results, "profile")).toBe(1);
    expect(open.text.startsWith(LEFT_OUT_NOTICE)).toBe(true);
    expect(open.notices).toEqual([LEFT_OUT_NOTICE]);

    const named = await tool(mo, cursor, "recall", { query: "budget euros", project: "globex" });
    expect(count(named.results, "project:globex")).toBe(1);
    expect(count(named.results, "project:acme")).toBe(0);
    expect(named.notices).toBeUndefined();
  });

  it("say what was left out even when nothing else matched", async () => {
    mo.setWall(claudeCode, "acme", ["project:acme"]);
    const res = await tool(mo, cursor, "recall", { query: "subcontracting" });
    expect(res.results.some((r) => r.content.includes("subcontracting"))).toBe(false);
    expect(res.text).toContain(LEFT_OUT_NOTICE);
  });

  it("do not limit explicit scope lists (REST API, explorer)", async () => {
    mo.setWall(claudeCode, "acme", ["project:acme"]);
    const res = await mo.recall(claudeCode, { query: "budget euros", scopes: ["profile", "project:acme"], rerank: false });
    expect(count(res.items, "project:acme")).toBeGreaterThan(0);
    expect(res.notices).toBeUndefined();
  });

  it("are set per project, one wall per project, and removed with an empty list", () => {
    expect(mo.setWall(claudeCode, "acme", ["project:acme", "project:acme-app"])).toEqual({ name: "acme", scopes: ["project:acme", "project:acme-app"] });
    expect(() => mo.setWall(claudeCode, "other", ["project:acme"])).toThrow("project:acme is already behind the wall acme");
    expect(() => mo.setWall(claudeCode, "bad", ["profile"])).toThrow("only projects can be walled");
    expect(() => mo.setWall(claudeCode, "bad", ["agent:cursor"])).toThrow("only projects can be walled");
    expect(() => mo.setWall(claudeCode, "Not A Slug", ["project:site"])).toThrow("wall name must be");
    mo.setWall(claudeCode, "acme", ["project:acme"]);
    expect(mo.listWalls(claudeCode)).toEqual([{ name: "acme", scopes: ["project:acme"] }]);
    mo.setWall(claudeCode, "acme", []);
    expect(mo.listWalls(claudeCode)).toEqual([]);
  });
});

function extract(_model: string, system: string, user: string): string {
  if (system === EXTRACTION_PROMPT && user.includes("RATE")) {
    return JSON.stringify({
      facts: [
        // The extractor files the rate under the profile because it is about the person.
        { statement: "The user charges Acme a day rate of 900 euros.", kind: "fact", scope: "profile", trust: "user_explicit", entities: [] },
        { statement: "Acme launches the Orion feature on March 3.", kind: "decision", scope: "project", trust: "user_explicit", entities: [] },
      ],
      entities: [],
    });
  }
  return JSON.stringify({ facts: [], entities: [] });
}

describe("walls and extraction (held promotions)", () => {
  let mo: MemoryObject;
  let db: ReturnType<typeof fakeState>["db"];
  const settle = async () => {
    for (let i = 0; i < 12; i++) {
      now += 5_000;
      await mo.alarm();
    }
  };
  const said = async () => {
    await mo.addEpisode(claudeCode, {
      scope: "project:acme",
      messages: [
        { role: "user", content: "RATE: for Acme I bill 900 euros a day, and their Orion launch is fixed for March 3." },
        { role: "assistant", content: "Noted." },
      ],
    });
    await settle();
  };
  const scopeOf = (text: string) => (db.prepare("SELECT scope FROM items WHERE kind = 'note' AND content LIKE ?").get(`%${text}%`) as { scope: string } | undefined)?.scope;

  beforeEach(() => {
    now = Date.UTC(2026, 10, 26, 9);
    const s = fakeState();
    db = s.db;
    mo = new MemoryObject(s.state as never, fakeEnv(extract).env as never);
  });

  it("without walls a profile fact from a project conversation goes to the profile, as before", async () => {
    await said();
    expect(scopeOf("900 euros")).toBe("profile");
    expect(mo.listHeld(claudeCode)).toEqual([]);
  });

  it("keep a fact from a walled conversation in its project and hold the promotion", async () => {
    mo.setWall(claudeCode, "acme", ["project:acme"]);
    mo.setWall(claudeCode, "globex", ["project:globex"]);
    await said();
    expect(scopeOf("900 euros")).toBe("project:acme");
    expect(scopeOf("Orion")).toBe("project:acme");
    const held = mo.listHeld(claudeCode);
    expect(held).toHaveLength(1);
    expect(held[0]).toMatchObject({ content: "The user charges Acme a day rate of 900 euros.", from: "project:acme", to: "profile", via: "extraction" });

    // Globex's agent sees nothing of it, in context or recall.
    const ctx = await tool(mo, cursor, "get_context", { project: "globex" });
    expect(ctx.text).not.toContain("900 euros");
    const rec = await tool(mo, cursor, "recall", { query: "day rate euros", project: "globex" });
    expect(rec.text).not.toContain("900 euros");
    // Inside the wall it is found as usual.
    const inside = await tool(mo, claudeCode, "recall", { query: "day rate euros", project: "acme" });
    expect(inside.results.some((r) => r.content.includes("900 euros"))).toBe(true);
  });

  it("move a released note to where it wanted to go, and keep a dismissed one", async () => {
    mo.setWall(claudeCode, "acme", ["project:acme"]);
    await said();
    const [held] = mo.listHeld(claudeCode);
    expect(await mo.decideHeld(claudeCode, held!.id, "release")).toEqual({ id: held!.id, itemId: held!.itemId, scope: "profile" });
    expect(scopeOf("900 euros")).toBe("profile");
    expect(mo.listHeld(claudeCode)).toEqual([]);
    expect(await mo.decideHeld(claudeCode, held!.id, "dismiss")).toBeNull();
    const outbox = db.prepare("SELECT op FROM outbox WHERE item_id = ?").all(held!.itemId) as { op: string }[];
    await settle();
    // The vector index got the new scope (the outbox drained after the release).
    expect(outbox.some((r) => r.op === "upsert")).toBe(true);

    await mo.forget(claudeCode, held!.itemId);
    now += 60_000;
    await said();
    const [again] = mo.listHeld(claudeCode);
    expect(await mo.decideHeld(claudeCode, again!.id, "dismiss")).toMatchObject({ scope: "project:acme" });
    expect(scopeOf("900 euros")).toBe("project:acme");
    expect(mo.listHeld(claudeCode)).toEqual([]);
  });

  it("drop a held promotion from the list when its note is forgotten", async () => {
    mo.setWall(claudeCode, "acme", ["project:acme"]);
    await said();
    const [held] = mo.listHeld(claudeCode);
    await mo.forget(claudeCode, held!.itemId);
    expect(mo.listHeld(claudeCode)).toEqual([]);
    expect(await mo.decideHeld(claudeCode, held!.id, "release")).toBeNull();
  });
});

describe("walls and conversations (rule 2)", () => {
  let mo: MemoryObject;
  const seed = async (m: MemoryObject) => {
    await m.addNote(claudeCode, { scope: "profile", content: "The user prefers offers that lead with the budget.", kind: "preference", trust: "user_explicit" });
    await m.addNote(claudeCode, { scope: "project:acme", content: "Acme's budget for the Orion feature is 60,000 euros.", kind: "fact", trust: "user_confirmed" });
    await m.addNote(cursor, { scope: "project:globex", content: "Globex's budget for the redesign is 40,000 euros.", kind: "fact", trust: "user_confirmed" });
    await m.addNote(cursor, { scope: "project:site", content: "The site's budget for hosting is 20 euros a month.", kind: "fact", trust: "user_confirmed" });
    for (let i = 0; i < 12; i++) {
      now += 5_000;
      await m.alarm();
    }
  };

  beforeEach(async () => {
    now = Date.UTC(2026, 10, 26, 9);
    const s = fakeState();
    mo = new MemoryObject(s.state as never, fakeEnv(() => JSON.stringify({ facts: [], entities: [] })).env as never);
    await seed(mo);
    mo.setWall(claudeCode, "acme", ["project:acme"]);
    mo.setWall(claudeCode, "globex", ["project:globex"]);
  });

  it("give a conversation that read one wall nothing from another, and serve a new conversation", async () => {
    const ctx = await tool(mo, claudeCode, "get_context", { project: "acme", conversation: "sess-a" });
    expect(ctx.text).toContain("60,000 euros");
    expect(ctx.conversation).toBeUndefined();

    const refused = await tool(mo, claudeCode, "recall", { query: "budget euros", project: "globex", conversation: "sess-a" });
    expect(count(refused.results, "project:globex")).toBe(0);
    expect(refused.text).toContain('Not searched: project:globex is behind a wall and this conversation has already been given memory from "acme". Use a new conversation for it.');
    // The profile and projects outside every wall are still served.
    expect(count(refused.results, "profile")).toBe(1);
    expect(count(refused.results, "project:site")).toBe(0); // named project only: site is not asked for

    const ctxOther = await tool(mo, claudeCode, "get_context", { project: "globex", conversation: "sess-a" });
    expect(ctxOther.text).not.toContain("40,000 euros");
    expect(ctxOther.notices?.[0]).toContain("Not searched: project:globex");

    const fresh = await tool(mo, claudeCode, "recall", { query: "budget euros", project: "globex", conversation: "sess-b" });
    expect(count(fresh.results, "project:globex")).toBe(1);
    expect(count(fresh.results, "project:acme")).toBe(0);
    // The same wall again is fine.
    const again = await tool(mo, claudeCode, "recall", { query: "budget euros", project: "acme", conversation: "sess-a" });
    expect(count(again.results, "project:acme")).toBe(1);
  });

  it("without a handle, count the connector as inside the wall for 30 minutes", async () => {
    await tool(mo, claudeCode, "recall", { query: "budget euros", project: "acme" });
    const refused = await tool(mo, claudeCode, "recall", { query: "budget euros", project: "globex" });
    expect(count(refused.results, "project:globex")).toBe(0);
    expect(refused.notices?.some((n) => n.includes('"acme"'))).toBe(true);
    // Another connector is a different conversation.
    const other = await tool(mo, cursor, "recall", { query: "budget euros", project: "globex" });
    expect(count(other.results, "project:globex")).toBe(1);
    now += 31 * 60_000;
    const later = await tool(mo, claudeCode, "recall", { query: "budget euros", project: "globex" });
    expect(count(later.results, "project:globex")).toBe(1);
  });

  it("hand out a handle from get_context only while walls are set", async () => {
    const withWalls = await tool(mo, cursor, "get_context", { project: "site" });
    expect(withWalls.conversation).toMatch(/^[0-9a-z]+$/);
    expect(withWalls.text).toContain(`Conversation handle: ${withWalls.conversation}.`);
    mo.setWall(claudeCode, "acme", []);
    mo.setWall(claudeCode, "globex", []);
    const without = await tool(mo, cursor, "get_context", { project: "site" });
    expect(without.conversation).toBeUndefined();
    expect(without.text).not.toContain("Conversation handle");
  });

  it("start a handle from get_context with what the connector was given in the last 30 minutes", async () => {
    await tool(mo, claudeCode, "recall", { query: "budget euros", project: "acme" });
    const ctx = await tool(mo, claudeCode, "get_context", { project: "globex" });
    expect(ctx.text).not.toContain("40,000 euros");
    const res = await tool(mo, claudeCode, "recall", { query: "budget euros", project: "globex", conversation: ctx.conversation });
    expect(count(res.results, "project:globex")).toBe(0);
  });

  it("keep what a walled conversation remembers inside the wall, held for the person", async () => {
    await tool(mo, claudeCode, "get_context", { project: "acme", conversation: "sess-a" });
    const toProfile = await tool(mo, claudeCode, "remember", { content: "The user charges Acme a day rate of 900 euros.", scope: "profile", conversation: "sess-a" });
    expect(toProfile.scope).toBe("project:acme");
    expect(toProfile.heldFor).toBe("profile");
    expect(toProfile.text).toContain("Kept in project:acme");
    const toGlobex = await tool(mo, claudeCode, "remember", { content: "Globex should get the same offer.", scope: "project", project: "globex", conversation: "sess-a" });
    expect(toGlobex).toMatchObject({ scope: "project:acme", heldFor: "project:globex" });
    const inside = await tool(mo, claudeCode, "remember", { content: "Acme wants weekly updates.", scope: "project", project: "acme", conversation: "sess-a" });
    expect(inside).toMatchObject({ scope: "project:acme", heldFor: undefined });
    expect(inside.text).toContain("Remembered in project:acme");
    expect(mo.listHeld(claudeCode).map((h) => [h.content, h.to, h.via])).toEqual([
      ["The user charges Acme a day rate of 900 euros.", "profile", "remember"],
      ["Globex should get the same offer.", "project:globex", "remember"],
    ]);
    // A conversation that read no wall writes where it asks to.
    const clean = await tool(mo, cursor, "remember", { content: "The user likes short offers.", scope: "profile", conversation: "sess-c" });
    expect(clean.text).toContain("Remembered in profile");
  });
});

describe("walls and conversations saved or imported from behind a wall", () => {
  let mo: MemoryObject;
  let db: ReturnType<typeof fakeState>["db"];
  const settle = async () => {
    for (let i = 0; i < 12; i++) {
      now += 5_000;
      await mo.alarm();
    }
  };
  const messages = [
    { role: "user", content: "RATE: for Acme I bill 900 euros a day, and their Orion launch is fixed for March 3." },
    { role: "assistant", content: "Noted." },
  ];

  beforeEach(async () => {
    now = Date.UTC(2026, 10, 26, 9);
    const s = fakeState();
    db = s.db;
    mo = new MemoryObject(s.state as never, fakeEnv(extract).env as never);
    await mo.addNote(claudeCode, { scope: "project:acme", content: "Acme's budget for the Orion feature is 60,000 euros.", kind: "fact", trust: "user_confirmed" });
    await settle();
    mo.setWall(claudeCode, "acme", ["project:acme"]);
    mo.setWall(claudeCode, "globex", ["project:globex"]);
  });

  it("save a walled conversation inside its wall, and hold what is extracted from it", async () => {
    await tool(mo, claudeCode, "get_context", { project: "acme", conversation: "sess-a" });
    const saved = await tool(mo, claudeCode, "save_conversation", { project: "globex", messages, conversation: "sess-a" });
    expect(saved.scope).toBe("project:acme");
    expect(saved.text).toContain("instead of project:globex");
    await settle();
    expect((db.prepare("SELECT DISTINCT scope FROM items WHERE kind = 'chunk'").all() as { scope: string }[]).map((r) => r.scope)).toEqual(["project:acme"]);
    expect(mo.listHeld(claudeCode).map((h) => [h.content, h.to, h.via])).toEqual([["The user charges Acme a day rate of 900 euros.", "profile", "extraction"]]);
    const globex = await tool(mo, cursor, "recall", { query: "day rate euros Orion", project: "globex" });
    expect(globex.text).not.toContain("900 euros");
  });

  it("treat a session id that was not used on reads like the connector's last 30 minutes", async () => {
    await tool(mo, claudeCode, "recall", { query: "budget", project: "acme", conversation: "handle-from-context" });
    const saved = await tool(mo, claudeCode, "save_conversation", { messages, session_id: "agent-session-1" });
    expect(saved.scope).toBe("project:acme");
    // A conversation that read no wall is saved where it asks to be.
    const other = await tool(mo, cursor, "save_conversation", { messages, session_id: "agent-session-2" });
    expect(other.scope).toBe("agent:cursor");
  });

  it("import notes from a walled conversation inside the wall, held", async () => {
    await tool(mo, claudeCode, "get_context", { project: "acme", conversation: "sess-a" });
    const res = await tool(mo, claudeCode, "import_memory_file", { content: "- Prefers dark mode.\n- Uses tabs.", format: "markdown", scope: "profile", conversation: "sess-a" });
    expect(res).toMatchObject({ scope: "project:acme", heldFor: "profile" });
    expect(mo.listHeld(claudeCode).map((h) => [h.to, h.via])).toEqual([["profile", "import"], ["profile", "import"]]);
  });
});
