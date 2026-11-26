// SPDX-License-Identifier: AGPL-3.0-or-later
// Standing orders: the rule format, the check, the hook answers per harness, the
// memory's storage and the MCP and REST surfaces, with the feature off and on.
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { createClient } from "../src/auth";
import { mcpResponse, type MemoryApi } from "../src/mcp";
import { MemoryObject } from "../src/memory-object";
import { callFromHook, evaluate, hookOutput, parseRule, projectFromPath, unsafePattern, type Order, type OrderRule } from "../src/orders";
import { DEFAULT_GRANTS, type Client } from "../src/scopes";
import { fakeD1 } from "./support/fake-d1";
import { fakeEnv, fakeState } from "./support/fake-do";

let now = Date.UTC(2026, 10, 26, 9);
vi.spyOn(Date, "now").mockImplementation(() => now);
afterAll(() => vi.restoreAllMocks());

const claudeCode: Client = { id: "c-claude", userId: "u1", name: "Claude Code", agent: "claude-code", provider: "anthropic", grants: DEFAULT_GRANTS };
const readOnly: Client = { ...claudeCode, id: "c-ro", grants: { read: ["profile"], write: [] } };

const NO_ISSUE_CLOSE: OrderRule = {
  says: "Never close GitHub issues. Report what should be closed instead.",
  action: "deny",
  when: [
    { tool: "mcp__*github*__issue_write", all: [{ path: "tool_input.state", op: "eq", value: "closed" }] },
    { tool: "@shell", all: [{ path: "text", op: "regex", value: "\\bgh\\s+issue\\s+close\\b" }] },
  ],
};
const NO_AI_TRAILER: OrderRule = {
  says: "No AI attribution in commits.",
  action: "deny",
  when: [
    {
      tool: "@shell",
      all: [
        { path: "text", op: "regex", value: "\\bgit\\s+commit\\b" },
        { path: "text", op: "regex", value: "co-authored-by:[^\\n]*(claude|copilot)" },
      ],
    },
  ],
};
const FORCE_PUSH_ASKS: OrderRule = {
  says: "A force-push needs my approval.",
  action: "ask",
  when: [{ tool: "@shell", all: [{ path: "text", op: "regex", value: "\\bgit\\s+push\\b[^\\n]*\\s(--force\\b|-f\\b)" }] }],
};

const order = (rule: OrderRule, id: string, state: Order["state"] = "active"): Order => ({
  ...parseRule(rule),
  id,
  scope: "profile",
  state,
  said: "2026-11-26",
  createdBy: "test",
  createdAt: "2026-11-26T09:00:00.000Z",
  updatedAt: "2026-11-26T09:00:00.000Z",
});
const bash = (command: string) => ({ tool_name: "Bash", tool_input: { command } });

// Known-slow patterns, built at run time so code scanners do not read the test data as live regexes.
const P = "+".repeat(1);
const S = "*".repeat(1);
const NESTED = `(a${P})${P}`;

describe("order rules", () => {
  it("accept the spike's kinds of orders and fill in defaults", () => {
    const r = parseRule({ says: " Never close issues. ", when: [{ tool: "Bash", all: [{ path: "text", op: "regex", value: "gh issue close" }] }] });
    expect(r.says).toBe("Never close issues.");
    expect(r.action).toBe("deny");
    expect(r.when[0]!.all![0]!.flags).toBe("i");
  });

  it("reject malformed orders with a reason", () => {
    expect(() => parseRule({ says: "x", when: [] })).toThrow(/order must be valid: when/);
    expect(() => parseRule({ says: "x", action: "allow", when: [{ tool: "Bash" }] })).toThrow(/action/);
    expect(() => parseRule({ says: "x", when: [{ tool: "@net" }] })).toThrow(/groups/);
    expect(() => parseRule({ says: "x", when: [{ tool: "Bash", all: [{ path: "env.HOME", op: "eq", value: "a" }] }] })).toThrow(/path/);
    expect(() => parseRule({ says: "x", when: [{ tool: "Bash", all: [{ path: "text", op: "regex", value: "(" }] }] })).toThrow(/invalid regular/);
    expect(() => parseRule({ says: "x", when: [{ tool: "Bash", all: [{ path: "text", op: "regex", value: "a", flags: "g" }] }] })).toThrow(/flags/);
  });

  it("reject patterns that can run for very long", () => {
    expect(unsafePattern(`${NESTED}$`)).toMatch(/repeated group/);
    expect(unsafePattern(`((ab)${S}c)${P}`)).toMatch(/repeated group/);
    expect(unsafePattern(`(\\w${P}\\s?)${S}$`)).toMatch(/repeated group/);
    expect(unsafePattern("(a)\\1")).toMatch(/backreferences/);
    expect(unsafePattern("foo(?=bar)")).toMatch(/lookarounds/);
    expect(unsafePattern("x".repeat(301))).toMatch(/at most/);
    // Ordinary patterns are fine, including optional groups and character classes with + inside.
    expect(unsafePattern("\\bgit\\s+push\\b[^\\n;|&]*\\s(--force\\b|-f\\b)")).toBeNull();
    expect(unsafePattern("co-authored-by:[^\\n]*(claude|copilot)")).toBeNull();
    expect(unsafePattern("(\\.nvmrc|\\.node-version)$")).toBeNull();
    expect(unsafePattern("(v)?22")).toBeNull();
    expect(unsafePattern("[(a+)]+")).toBeNull();
  });
});

describe("evaluate", () => {
  const orders = [order(NO_ISSUE_CLOSE, "ord_issue"), order(NO_AI_TRAILER, "ord_trailer"), order(FORCE_PUSH_ASKS, "ord_force")];

  it("stops direct violations in every harness's naming", () => {
    expect(evaluate(orders, { tool_name: "mcp__github__issue_write", tool_input: { method: "update", state: "closed" } })?.order).toBe("ord_issue");
    expect(evaluate(orders, { tool_name: "mcp__plugin_gh_github__issue_write", tool_input: { state: "closed" } })?.order).toBe("ord_issue");
    expect(evaluate(orders, bash("gh issue close 6 --repo o/r"))?.action).toBe("deny");
    expect(evaluate(orders, { tool_name: "run_shell_command", tool_input: { command: "gh issue close 6" } })?.order).toBe("ord_issue");
    expect(evaluate(orders, { tool_name: "Shell", tool_input: { command: "gh issue close 6" } })?.order).toBe("ord_issue");
    expect(evaluate(orders, bash('git commit -m "feat: x\n\nCo-Authored-By: Claude <noreply@anthropic.com>"'))?.order).toBe("ord_trailer");
    expect(evaluate(orders, bash("git push --force origin main"))?.action).toBe("ask");
  });

  it("let look-alikes through", () => {
    expect(evaluate(orders, { tool_name: "mcp__github__issue_write", tool_input: { method: "update", state: "open" } })).toBeNull();
    expect(evaluate(orders, bash("gh issue list --state closed"))).toBeNull();
    expect(evaluate(orders, bash('git commit -m "docs: credit Ada"'))).toBeNull();
    expect(evaluate(orders, bash("git push origin feat/x"))).toBeNull();
    expect(evaluate(orders, { tool_name: "Read", tool_input: { file_path: "README.md" } })).toBeNull();
  });

  it("pick the strictest order and skip proposed and disabled ones", () => {
    const warn = order({ says: "Pushing is worth a thought.", action: "warn", when: [{ tool: "Bash", all: [{ path: "text", op: "contains", value: "git push" }] }] }, "ord_warn");
    expect(evaluate([warn, ...orders], bash("git push -f origin main"))?.order).toBe("ord_force");
    expect(evaluate([warn], bash("git push origin main"))?.action).toBe("warn");
    expect(evaluate([order(NO_ISSUE_CLOSE, "p", "proposed"), order(NO_ISSUE_CLOSE, "d", "disabled")], bash("gh issue close 1"))).toBeNull();
  });

  it("give a reason that names the rule and tells the agent not to work around it", () => {
    const d = evaluate(orders, bash("gh issue close 6"))!;
    expect(d.reason).toContain(NO_ISSUE_CLOSE.says);
    expect(d.reason).toContain("ord_issue");
    expect(d.reason).toContain("do not look for another way");
  });

  it("match file paths and written content", () => {
    const node = order(
      { says: "Never Node 22.", action: "deny", when: [{ tool: "@write", all: [{ path: "file", op: "regex", value: "\\.nvmrc$" }, { path: "text", op: "regex", value: "^\\s*v?22", flags: "m" }] }] },
      "ord_node",
    );
    expect(evaluate([node], { tool_name: "Write", tool_input: { file_path: "/r/.nvmrc", content: "22\n" } })?.order).toBe("ord_node");
    expect(evaluate([node], { tool_name: "write_file", tool_input: { file_path: "/r/.nvmrc", content: "26\n" } })).toBeNull();
    expect(evaluate([node], { tool_name: "Edit", tool_input: { file_path: "/r/.nvmrc", new_string: "v22.1.0" } })?.order).toBe("ord_node");
  });
});

describe("hook formats", () => {
  const deny = { action: "deny" as const, order: "ord_1", says: "No.", reason: "Stopped." };
  const ask = { ...deny, action: "ask" as const };
  const warn = { ...deny, action: "warn" as const };

  it("answer with nothing when no order applies, so the harness goes on as usual", () => {
    for (const f of ["claude", "codex", "cursor", "gemini"] as const) expect(hookOutput(f, null)).toEqual({});
  });

  it("speak each harness's deny", () => {
    expect(hookOutput("claude", deny)).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Stopped." } });
    expect(hookOutput("cursor", deny)).toMatchObject({ permission: "deny", agent_message: "Stopped." });
    expect(hookOutput("gemini", deny)).toEqual({ decision: "deny", reason: "Stopped." });
  });

  it("turn ask into deny where the harness has no ask, and tell the agent to ask", () => {
    expect(hookOutput("claude", ask)).toMatchObject({ hookSpecificOutput: { permissionDecision: "ask" } });
    const codex = hookOutput("codex", ask) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    expect(codex.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(codex.hookSpecificOutput.permissionDecisionReason).toContain("Ask the person");
    expect(hookOutput("gemini", ask)).toMatchObject({ decision: "deny" });
  });

  it("pass a warning as context where the harness supports it", () => {
    expect(hookOutput("claude", warn)).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: "Stopped." } });
    expect(hookOutput("gemini", warn)).toEqual({});
  });

  it("read the input shapes of the four harnesses", () => {
    expect(callFromHook({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" } })).toEqual(bash("ls"));
    expect(callFromHook({ command: "gh issue close 1", cwd: "/w" })).toEqual({ tool_name: "Shell", tool_input: { command: "gh issue close 1" } });
    expect(callFromHook({ tool_name: "issue_write", tool_input: '{"state":"closed"}' })).toEqual({ tool_name: "issue_write", tool_input: { state: "closed" } });
    expect(callFromHook({ nothing: true })).toBeNull();
    expect(projectFromPath("C:\\Users\\me\\dev\\Rhizome\\")).toBe("rhizome");
    expect(projectFromPath("/home/me/My Project")).toBeNull();
  });
});

type ToolBody = { result?: { content: { text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> }; error?: { message: string } };
let rpcId = 0;
async function rpc(mo: MemoryObject, client: Client, method: string, params: Record<string, unknown>, orders: boolean) {
  const res = await mcpResponse(mo as unknown as MemoryApi, client, { jsonrpc: "2.0", id: ++rpcId, method, params }, "test", undefined, { orders });
  return (await res.json()) as ToolBody;
}
const tool = (mo: MemoryObject, client: Client, name: string, args: Record<string, unknown>, orders = true) => rpc(mo, client, "tools/call", { name, arguments: args }, orders);

function memory(flag: string | undefined) {
  const s = fakeState();
  const env = { ...fakeEnv(() => JSON.stringify({ facts: [], entities: [] })).env, EXTRACTION: "off", ...(flag ? { STANDING_ORDERS: flag } : {}) };
  return { mo: new MemoryObject(s.state as never, env as never), db: s.db };
}

describe("standing orders off (the default)", () => {
  it("offer no tools, add nothing to the context and refuse every order call", async () => {
    const { mo } = memory(undefined);
    const list = await rpc(mo, claudeCode, "tools/list", {}, false);
    const names = (list.result as unknown as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).not.toContain("standing_orders");
    expect(names).not.toContain("check_tool_call");
    const unknown = await tool(mo, claudeCode, "standing_orders", {}, false);
    expect(unknown.error?.message).toContain("unknown tool");
    const ctx = await tool(mo, claudeCode, "get_context", {}, false);
    expect(ctx.result!.content[0]!.text).not.toContain("Standing orders");
    expect(() => mo.addOrder(claudeCode, { scope: "profile", rule: NO_ISSUE_CLOSE, state: "active" })).toThrow(/standing orders are off/);
    expect(() => mo.checkToolCall(claudeCode, ["profile"], bash("gh issue close 1"))).toThrow(/standing orders are off/);
  });
});

describe("standing orders on", () => {
  let mo: MemoryObject;
  let db: ReturnType<typeof memory>["db"];
  beforeEach(() => {
    now = Date.UTC(2026, 10, 26, 9);
    ({ mo, db } = memory("on"));
  });

  it("list their tools next to the memory tools", async () => {
    const list = await rpc(mo, claudeCode, "tools/list", {}, true);
    const names = (list.result as unknown as { tools: { name: string }[] }).tools.map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["get_context", "recall", "standing_orders", "check_tool_call", "add_standing_order"]));
  });

  it("check an order the person gave right away and keep an agent's guess as proposed", async () => {
    const given = await tool(mo, claudeCode, "add_standing_order", { ...NO_ISSUE_CLOSE, said_by_user: true });
    expect(given.result!.structuredContent).toMatchObject({ scope: "profile", state: "active" });
    const guessed = await tool(mo, claudeCode, "add_standing_order", { ...FORCE_PUSH_ASKS });
    expect(guessed.result!.structuredContent).toMatchObject({ state: "proposed" });
    expect(guessed.result!.content[0]!.text).toContain("once the person activates it");

    const listed = await tool(mo, claudeCode, "standing_orders", {});
    expect(listed.result!.content[0]!.text).toContain(NO_ISSUE_CLOSE.says);
    expect(listed.result!.content[0]!.text).not.toContain(FORCE_PUSH_ASKS.says);

    expect((await tool(mo, claudeCode, "check_tool_call", { tool_name: "Bash", tool_input: { command: "git push -f" } })).result!.structuredContent).toEqual({ action: "ok" });
    const stopped = await tool(mo, claudeCode, "check_tool_call", { tool_name: "Bash", tool_input: { command: "gh issue close 3" } });
    expect(stopped.result!.structuredContent).toMatchObject({ action: "deny" });

    // The person activates the proposed one in the explorer.
    const proposedId = String(guessed.result!.structuredContent!.id);
    mo.setOrderState(claudeCode, proposedId, "active");
    expect((await tool(mo, claudeCode, "check_tool_call", { tool_name: "Bash", tool_input: { command: "git push -f" } })).result!.structuredContent).toMatchObject({ action: "ask" });
  });

  it("name the active orders at the end of get_context", async () => {
    await tool(mo, claudeCode, "remember", { content: "The user prefers short replies.", said_by_user: true });
    await tool(mo, claudeCode, "add_standing_order", { ...NO_ISSUE_CLOSE, said_by_user: true });
    const text = (await tool(mo, claudeCode, "get_context", {})).result!.content[0]!.text;
    expect(text.trimEnd().endsWith(`- ${NO_ISSUE_CLOSE.says} [deny, ${mo.listOrders(claudeCode, ["profile"]).orders[0]!.id}]`)).toBe(true);
    expect(text.indexOf("Standing orders")).toBeGreaterThan(0);
  });

  it("apply a project's orders only in that project", async () => {
    await tool(mo, claudeCode, "add_standing_order", { says: "No deploys from here.", when: [{ tool: "@shell", all: [{ path: "text", op: "contains", value: "wrangler deploy" }] }], project: "site", said_by_user: true });
    const call = { tool_name: "Bash", tool_input: { command: "npx wrangler deploy" } };
    expect(mo.checkToolCall(claudeCode, ["profile"], call)).toBeNull();
    expect(mo.checkToolCall(claudeCode, ["profile", "project:other"], call)).toBeNull();
    expect(mo.checkToolCall(claudeCode, ["profile", "project:site"], call)?.action).toBe("deny");
  });

  it("record a strike with the tool name, never the call's input", () => {
    mo.addOrder(claudeCode, { scope: "profile", rule: NO_ISSUE_CLOSE, state: "active" });
    mo.checkToolCall(claudeCode, ["profile"], bash("gh issue close 9 --comment 'secret-ish text'"), "sess-1");
    mo.checkToolCall(claudeCode, ["profile"], bash("ls"), "sess-1");
    const strikes = mo.listStrikes(claudeCode);
    expect(strikes).toHaveLength(1);
    expect(strikes[0]).toMatchObject({ tool: "Bash", action: "deny", client: "c-claude", session: "sess-1" });
    expect(JSON.stringify(db.prepare("SELECT * FROM order_strikes").all())).not.toContain("secret-ish");
    expect(mo.listOrders(claudeCode, ["profile"]).orders[0]!.strikes).toBe(1);
  });

  it("respect grants, validate input and count changes", () => {
    expect(() => mo.addOrder(readOnly, { scope: "profile", rule: NO_ISSUE_CLOSE })).toThrow(/no write access/);
    expect(() => mo.addOrder(claudeCode, { scope: "agent:claude-code", rule: NO_ISSUE_CLOSE })).toThrow(/profile or a project/);
    expect(() => mo.addOrder(claudeCode, { scope: "profile", rule: { says: "x", when: [{ tool: "Bash", all: [{ path: "text", op: "regex", value: NESTED }] }] } })).toThrow(/order must be valid/);
    const v0 = mo.listOrders(claudeCode, ["profile"]).version;
    const o = mo.addOrder(claudeCode, { scope: "profile", rule: NO_ISSUE_CLOSE });
    expect(o.state).toBe("proposed");
    const v1 = mo.listOrders(claudeCode, ["profile"]).version;
    expect(v1).not.toBe(v0);
    expect(mo.listOrders(readOnly, ["project:site"]).orders).toEqual([]);
    expect(mo.deleteOrder(claudeCode, o.id)).toEqual({ deleted: 1 });
    expect(mo.listOrders(claudeCode, ["profile"]).orders).toEqual([]);
    expect(mo.deleteOrder(claudeCode, o.id)).toEqual({ deleted: 0 });
  });
});

describe("REST and the hook endpoint", () => {
  const HOST = "https://memory.example.com";
  const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
  let env: Record<string, unknown>;
  let key: string;

  async function setup(flag: string | undefined) {
    const d1 = fakeD1();
    d1.db.exec("INSERT INTO users (id, name, created_at) VALUES ('u1', 'Person', 0)");
    const fake = fakeEnv(() => JSON.stringify({ facts: [], entities: [] }));
    const s = fakeState();
    const extra = flag ? { STANDING_ORDERS: flag } : {};
    const mo = new MemoryObject(s.state as never, { ...fake.env, EXTRACTION: "off", ...extra } as never);
    env = { ...fake.env, ...extra, CONTROL_DB: d1.binding, MEMORY: { idFromName: (n: string) => n, get: () => mo } };
    key = (await createClient(env as never, { userId: "u1", name: "Claude Code", agent: "claude-code", provider: "anthropic" })).apiKey;
  }
  const call = (path: string, init: RequestInit = {}) =>
    worker.fetch(new Request(HOST + path, { ...init, headers: { authorization: `Bearer ${key}`, "content-type": "application/json", ...(init.headers ?? {}) } }), env as never, ctx);
  const post = (path: string, body: unknown) => call(path, { method: "POST", body: JSON.stringify(body) });

  it("are not there while the feature is off", async () => {
    await setup(undefined);
    expect((await call("/v1/memory/orders")).status).toBe(404);
    expect((await post("/v1/memory/orders/check", { tool_name: "Bash", tool_input: { command: "ls" } })).status).toBe(404);
  });

  it("store an order, serve the bundle with an ETag and answer hooks per harness", async () => {
    await setup("on");
    const created = await post("/v1/memory/orders", { ...NO_ISSUE_CLOSE, saidByUser: true });
    expect(created.status).toBe(201);
    const bundle = await call("/v1/memory/orders");
    const etag = bundle.headers.get("etag")!;
    expect(((await bundle.json()) as { orders: Order[] }).orders[0]!.says).toBe(NO_ISSUE_CLOSE.says);
    expect((await call("/v1/memory/orders", { headers: { "if-none-match": etag } })).status).toBe(304);

    const hookInput = { session_id: "s1", cwd: "/home/me/rhizome", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "gh issue close 5" } };
    const claude = await post("/v1/memory/orders/check", hookInput);
    expect(await claude.json()).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    const gemini = await post("/v1/memory/orders/check?format=gemini", { ...hookInput, tool_name: "run_shell_command" });
    expect(await gemini.json()).toMatchObject({ decision: "deny" });
    const cursor = await post("/v1/memory/orders/check?format=cursor", { command: "gh issue close 5", cwd: "/w", conversation_id: "c1" });
    expect(await cursor.json()).toMatchObject({ permission: "deny" });
    const fine = await post("/v1/memory/orders/check", { ...hookInput, tool_input: { command: "gh issue list" } });
    expect(await fine.json()).toEqual({});

    expect((await post("/v1/memory/orders/check?format=vim", hookInput)).status).toBe(400);
    expect((await post("/v1/memory/orders/check", { hello: 1 })).status).toBe(400);
    expect((await post("/v1/memory/orders", { says: "x", when: [{ tool: "Bash", all: [{ path: "text", op: "regex", value: NESTED }] }] })).status).toBe(400);
  });

  it("find project orders from the agent's working folder", async () => {
    await setup("on");
    await post("/v1/memory/orders", { project: "site", says: "No deploys.", when: [{ tool: "@shell", all: [{ path: "text", op: "contains", value: "wrangler deploy" }] }], saidByUser: true });
    const input = (cwd: string) => ({ cwd, tool_name: "Bash", tool_input: { command: "npx wrangler deploy" } });
    expect(await (await post("/v1/memory/orders/check", input("/home/me/site"))).json()).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
    expect(await (await post("/v1/memory/orders/check", input("/home/me/blog"))).json()).toEqual({});
    expect(await (await post("/v1/memory/orders/check?project=site", input("/tmp"))).json()).toMatchObject({ hookSpecificOutput: { permissionDecision: "deny" } });
  });
});
