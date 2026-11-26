// SPDX-License-Identifier: AGPL-3.0-or-later
// Open loops: opened and closed through the real MCP layer, shown by get_context once due.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { dueSection, MAX_OPEN_LOOPS } from "../src/loops";
import { mcpResponse, type MemoryApi } from "../src/mcp";
import { MemoryObject } from "../src/memory-object";
import { DEFAULT_GRANTS, type Client } from "../src/scopes";
import { fakeEnv, fakeState } from "./support/fake-do";

const claudeCode: Client = { id: "c-claude", userId: "u1", name: "Claude Code", agent: "claude-code", provider: "anthropic", grants: DEFAULT_GRANTS };
const codex: Client = { id: "c-codex", userId: "u1", name: "Codex", agent: "codex", provider: "openai", grants: DEFAULT_GRANTS };
const reader: Client = { ...codex, id: "c-reader", grants: { read: ["*"], write: [] } };

let now = Date.UTC(2026, 10, 26, 9);
vi.spyOn(Date, "now").mockImplementation(() => now);
afterAll(() => vi.restoreAllMocks());

type Body = { result?: { tools?: { name: string }[]; content: { text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> }; error?: { message: string } };
let rpcId = 0;
async function rpc(memory: MemoryObject, client: Client, method: string, params: Record<string, unknown>, loops: boolean) {
  const res = await mcpResponse(memory as unknown as MemoryApi, client, { jsonrpc: "2.0", id: ++rpcId, method, params }, "test", undefined, { loops });
  return (await res.json()) as Body;
}
async function tool(memory: MemoryObject, client: Client, name: string, args: Record<string, unknown>, loops = true) {
  const body = await rpc(memory, client, "tools/call", { name, arguments: args }, loops);
  if (body.error) return { text: body.error.message, isError: true, sc: undefined };
  return { text: body.result!.content[0]!.text, isError: body.result!.isError === true, sc: body.result!.structuredContent };
}
const day = (d: number, h = 0) => Date.UTC(2026, 10, d, h);

function memory(vars: Record<string, string> = { OPEN_LOOPS: "on" }) {
  const s = fakeState();
  const env = { ...fakeEnv(() => JSON.stringify({ facts: [], entities: [] })).env, ...vars };
  return new MemoryObject(s.state as never, env as never);
}

describe("open loops are off by default", () => {
  it("list no loop tools, refuse them and leave get_context as it was", async () => {
    const mo = memory({});
    const list = await rpc(mo, claudeCode, "tools/list", {}, false);
    expect(list.result!.tools!.map((t) => t.name)).not.toContain("open_loop");
    const res = await tool(mo, claudeCode, "open_loop", { content: "Ask about the invoice." }, false);
    expect(res.isError).toBe(true);
    expect(() => mo.openLoop(claudeCode, { scope: "profile", content: "Ask about the invoice." })).toThrow(/not allowed/);
    await mo.addNote(claudeCode, { scope: "profile", content: "The user prefers short replies.", kind: "preference", trust: "user_explicit" });
    expect(mo.context(claudeCode, ["profile"]).text).not.toContain("Due now");
  });

  it("leave get_context byte for byte as it was, even with loops stored before the switch went off", async () => {
    const mo = memory();
    await mo.addNote(claudeCode, { scope: "profile", content: "The user prefers short replies.", kind: "preference", trust: "user_explicit" });
    const before = mo.context(claudeCode, ["profile"]);
    mo.openLoop(claudeCode, { scope: "profile", content: "Ask about the invoice." });
    expect(mo.context(claudeCode, ["profile"]).text).toContain("Due now");
    delete (mo as unknown as { env: Record<string, string> }).env.OPEN_LOOPS;
    const after = mo.context(claudeCode, ["profile"]);
    expect(after.text).toBe(before.text);
    expect(after.version).toBe(before.version);
  });
});

describe("open loops", () => {
  let mo: MemoryObject;
  beforeEach(() => {
    now = day(26, 9);
    mo = memory();
  });

  it("are listed as tools when switched on", async () => {
    const list = await rpc(mo, claudeCode, "tools/list", {}, true);
    expect(list.result!.tools!.map((t) => t.name)).toEqual(expect.arrayContaining(["get_context", "open_loop", "close_loop"]));
  });

  it("stay quiet before the due date and lead get_context from it on, for any agent", async () => {
    const opened = await tool(mo, claudeCode, "open_loop", { content: "Check whether the invoice was paid.", due: "2026-11-30", project: "acme" });
    expect(opened.isError).toBe(false);
    expect(opened.text).toMatch(/^Opened loop_\S+ in project:acme, due 2026-11-30 00:00 UTC\.$/);
    const id = String(opened.sc!.id);
    await mo.addNote(claudeCode, { scope: "project:acme", content: "Acme pays within 30 days.", kind: "fact", trust: "user_confirmed" });

    now = day(29, 23);
    expect((await tool(mo, codex, "get_context", { project: "acme" })).text).not.toContain("Due now");

    now = day(30, 8);
    const ctx = (await tool(mo, codex, "get_context", { project: "acme" })).text;
    expect(ctx.startsWith(`## Due now (close_loop once handled)\n- [${id}] (project:acme · 2026-11-30) Check whether the invoice was paid.`)).toBe(true);
    expect(ctx).toContain("Acme pays within 30 days.");
  });

  it("show only in the scopes that were loaded", async () => {
    await tool(mo, claudeCode, "open_loop", { content: "Send Acme the draft.", project: "acme" });
    expect((await tool(mo, claudeCode, "get_context", { project: "globex" })).text).not.toContain("Send Acme the draft.");
    expect((await tool(mo, claudeCode, "get_context", { project: "acme" })).text).toContain("Send Acme the draft.");
  });

  it("without a due date are due the next time their scope is loaded", async () => {
    const opened = await tool(mo, claudeCode, "open_loop", { content: "Ask how the move went." });
    expect(opened.text).toContain("in profile, due the next time get_context loads it");
    expect(mo.context(claudeCode, ["profile"]).text).toContain("Ask how the move went.");
  });

  it("are gone from get_context once closed, and keep the outcome", async () => {
    const id = String((await tool(mo, claudeCode, "open_loop", { content: "Ask how the move went." })).sc!.id);
    const closed = await tool(mo, codex, "close_loop", { id, outcome: "The move went fine." });
    expect(closed).toMatchObject({ isError: false, text: `Closed ${id}.` });
    expect(mo.context(claudeCode, ["profile"]).text).not.toContain("Due now");
    expect((await tool(mo, codex, "close_loop", { id })).text).toBe("no open loop with this id");
    const exported = mo.exportPage(claudeCode);
    expect(exported.loops).toEqual([expect.objectContaining({ id, outcome: "The move went fine.", closedAt: new Date(now).toISOString() })]);
  });

  it("list the soonest five, count the rest and pay for them out of the context budget", async () => {
    for (let i = 1; i <= 7; i++) mo.openLoop(claudeCode, { scope: "profile", content: `Follow-up number ${i}.`, dueAt: day(26, i) });
    await mo.addNote(claudeCode, { scope: "profile", content: "x ".repeat(300), kind: "fact", trust: "user_explicit" });
    now = day(27);
    const full = mo.context(claudeCode, ["profile"], 1500).text;
    expect(full.match(/Follow-up number/g)).toHaveLength(5);
    expect(full).toContain("Follow-up number 1.");
    expect(full).not.toContain("Follow-up number 6.");
    expect(full).toContain("- and 2 more");
    // The due section counts against the budget: with a tight budget the long note is dropped, the loops stay.
    const tight = mo.context(claudeCode, ["profile"], 200).text;
    expect(tight).toContain("Follow-up number 5.");
    expect(tight).not.toContain("x x x");
  });

  it("render long texts short", () => {
    const section = dueSection([{ id: "loop_1", scope: "profile", content: "a".repeat(400), dueAt: null }], 1);
    expect(section).toContain("(profile · next time)");
    expect(section.length).toBeLessThan(300);
  });

  it("check write access and the due date", async () => {
    expect((await tool(mo, reader, "open_loop", { content: "Nope." })).text).toBe("this connection may not write to profile");
    expect((await tool(mo, claudeCode, "open_loop", { content: "Later.", due: "next week" })).text).toMatch(/^due must be an ISO 8601/);
    // Out of Date's range: refused before anything is stored, so get_context keeps working.
    for (const due of [-1e16, 1e16, "+275760-09-13T00:00:00Z"]) {
      expect((await tool(mo, claudeCode, "open_loop", { content: "Broken.", due })).text).toMatch(/^due must be an ISO 8601/);
    }
    expect(() => mo.openLoop(claudeCode, { scope: "profile", content: "Broken.", dueAt: -1e16 })).toThrow(/due must be/);
    expect(mo.context(claudeCode, ["profile"]).text).not.toContain("Broken.");
    const id = String((await tool(mo, claudeCode, "open_loop", { content: "Ask Acme." })).sc!.id);
    expect((await tool(mo, reader, "close_loop", { id })).text).toBe("no open loop with this id");
  });

  it("keep a private loop to the agent that opened it", async () => {
    await tool(mo, claudeCode, "open_loop", { content: "Rerun the flaky test.", scope: "private" });
    expect((await tool(mo, claudeCode, "get_context", {})).text).toContain("Rerun the flaky test.");
    expect((await tool(mo, codex, "get_context", {})).text).not.toContain("Rerun the flaky test.");
  });

  it("are capped per person", () => {
    for (let i = 0; i < MAX_OPEN_LOOPS; i++) mo.openLoop(claudeCode, { scope: "profile", content: `Loop ${i}.` });
    expect(() => mo.openLoop(claudeCode, { scope: "profile", content: "One too many." })).toThrow(/limit is/);
  });

  it("can be forgotten", async () => {
    const id = String((await tool(mo, claudeCode, "open_loop", { content: "Ask about the invoice." })).sc!.id);
    expect((await tool(mo, claudeCode, "forget", { id })).text).toBe(`Forgot ${id}.`);
    expect(mo.context(claudeCode, ["profile"]).text).not.toContain("Due now");
    expect(mo.exportPage(claudeCode).loops).toBeUndefined();
  });

  it("opened from behind a wall stay inside it", async () => {
    await mo.addNote(claudeCode, { scope: "project:acme", content: "Acme's budget is 60,000 euros.", kind: "fact", trust: "user_confirmed" });
    mo.setWall(claudeCode, "acme", ["project:acme"]);
    await tool(mo, claudeCode, "get_context", { project: "acme", conversation: "s1" });
    const opened = await tool(mo, claudeCode, "open_loop", { content: "Tell the user about the Acme budget.", conversation: "s1" });
    expect(opened.sc!.scope).toBe("project:acme");
    expect(mo.context(claudeCode, ["profile"]).text).not.toContain("Acme budget");
  });

  it("from another wall stay out of a conversation that was given one", async () => {
    mo.setWall(claudeCode, "acme", ["project:acme"]);
    mo.setWall(claudeCode, "globex", ["project:globex"]);
    await mo.addNote(claudeCode, { scope: "project:acme", content: "Acme's budget is 60,000 euros.", kind: "fact", trust: "user_confirmed" });
    mo.openLoop(claudeCode, { scope: "project:globex", content: "Chase the Globex contract." });
    await tool(mo, claudeCode, "get_context", { project: "acme", conversation: "s1" });
    expect((await tool(mo, claudeCode, "get_context", { project: "globex", conversation: "s1" })).text).not.toContain("Globex contract");
    expect((await tool(mo, claudeCode, "get_context", { project: "globex", conversation: "s2" })).text).toContain("Globex contract");
  });
});
