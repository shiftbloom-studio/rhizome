// SPDX-License-Identifier: AGPL-3.0-or-later
// Walls: two clients' projects in one memory, through the real MCP layer.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
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

type ToolBody = { result: { content: { text: string }[]; isError?: boolean; structuredContent?: { results?: { scope: string; content: string }[]; notices?: string[] } } };
let rpcId = 0;
async function tool(memory: MemoryObject, client: Client, name: string, args: Record<string, unknown>) {
  const res = await mcpResponse(memory as unknown as MemoryApi, client, { jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name, arguments: args } }, "test");
  const body = (await res.json()) as ToolBody;
  return { text: body.result.content[0]!.text, results: body.result.structuredContent?.results ?? [], notices: body.result.structuredContent?.notices, isError: body.result.isError === true };
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
