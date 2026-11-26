// SPDX-License-Identifier: AGPL-3.0-or-later
import { describe, expect, it, vi } from "vitest";
import { analyticsHost, buildBatch, dailyPseudonym, sendStats, type McpStat } from "../src/analytics";
import type { Env } from "../src/env";
import { legalPage } from "../src/legal";
import { mcpResponse, type MemoryApi } from "../src/mcp";
import { DEFAULT_GRANTS, type Client } from "../src/scopes";

const client: Client = { id: "c-secret-id", userId: "u-secret", name: "Work laptop", agent: "claude-code", provider: "anthropic", grants: DEFAULT_GRANTS };
const SECRET_QUERY = "what is the private launch date of project zebra";
const SECRET_NOTE = "Zebra launches on 12 March";

const memory = {
  recall: async () => ({ items: [{ id: "n1", scope: "project:zebra", kind: "fact", content: SECRET_NOTE, trust: "user_explicit", status: "active", agent: "claude-code", tEvent: "2026-11-01T00:00:00.000Z" }] }),
  context: () => ({ text: SECRET_NOTE }),
  addNote: async () => ({ id: "n2" }),
  addEpisode: async () => ({ id: "e1", chunks: 1 }),
  importNotes: async () => ({ added: 0, skipped: 0 }),
  forget: async () => ({ deleted: 0 }),
  scopes: () => ["profile", "project:zebra"],
} as unknown as MemoryApi;

const on = { MCP_ANALYTICS: "on", POSTHOG_KEY: "phc_test", POSTHOG_HOST: "https://eu.i.posthog.com" };

async function observed(raw: unknown): Promise<McpStat[]> {
  const stats: McpStat[] = [];
  await mcpResponse(memory, client, raw, "test", (s) => stats.push(s));
  return stats;
}

describe("analyticsHost", () => {
  it("is off unless the flag, the key and an https host are set", () => {
    expect(analyticsHost({})).toBeNull();
    expect(analyticsHost({ ...on, MCP_ANALYTICS: "" })).toBeNull();
    expect(analyticsHost({ ...on, POSTHOG_KEY: "" })).toBeNull();
    expect(analyticsHost({ ...on, POSTHOG_HOST: "" })).toBeNull();
    expect(analyticsHost({ ...on, POSTHOG_HOST: "http://eu.i.posthog.com" })).toBeNull();
    expect(analyticsHost({ ...on, POSTHOG_HOST: "https://us.i.posthog.com/" })).toBe("https://us.i.posthog.com");
  });
});

describe("mcp observe hook", () => {
  it("reports tool name, outcome, latency and size, nothing from the arguments", async () => {
    const stats = await observed({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "recall", arguments: { query: SECRET_QUERY, project: "zebra" } } });
    expect(stats).toHaveLength(1);
    const s = stats[0]!;
    expect(s).toMatchObject({ kind: "tool_call", tool: "recall", ok: true });
    expect(s.kind === "tool_call" && s.responseBytes).toBeGreaterThan(0);
    expect(JSON.stringify(stats)).not.toMatch(/zebra|Zebra|launch/);
  });

  it("classes bad input as validation and failures as internal", async () => {
    const bad = await observed({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "remember", arguments: { content: "" } } });
    expect(bad[0]).toMatchObject({ ok: false, errorType: "validation" });
    const failing = { ...memory, addNote: async () => { throw new Error("boom"); } } as unknown as MemoryApi;
    const stats: McpStat[] = [];
    vi.spyOn(console, "error").mockImplementationOnce(() => {});
    await mcpResponse(failing, client, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "remember", arguments: { content: "x" } } }, "test", (s) => stats.push(s));
    expect(stats[0]).toMatchObject({ ok: false, errorType: "internal" });
    const unknown = await observed({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "steal_everything", arguments: {} } });
    expect(unknown[0]).toMatchObject({ ok: false, errorType: "validation" });
  });

  it("reports the client software on initialize", async () => {
    const stats = await observed({ jsonrpc: "2.0", id: 5, method: "initialize", params: { protocolVersion: "2025-11-25", clientInfo: { name: "claude-code", version: "2.1.0" } } });
    expect(stats).toEqual([{ kind: "initialize", clientName: "claude-code", clientVersion: "2.1.0", protocolVersion: "2025-11-25" }]);
  });

  it("does nothing without a hook", async () => {
    const res = await mcpResponse(memory, client, { jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "recall", arguments: { query: "x" } } }, "test");
    expect(res.status).toBe(200);
  });
});

describe("buildBatch", () => {
  const now = Date.UTC(2026, 10, 26, 12);

  it("uses PostHog's MCP event shape without ids, names or content", async () => {
    const batch = await buildBatch(
      [
        { kind: "initialize", clientName: "Cursor <script>", clientVersion: "1.0", protocolVersion: "2025-11-25" },
        { kind: "tool_call", tool: "recall", ok: true, durationMs: 12.4, responseBytes: 300 },
        { kind: "tool_call", tool: "made-up", ok: false, errorType: "validation", durationMs: 1, responseBytes: 40 },
      ],
      client,
      { serverVersion: "1.0.0", userAgent: "claude-code/2.1.0 (cli)", now },
    );
    expect(batch.map((e) => e.event)).toEqual(["$mcp_initialize", "$mcp_tool_call", "$mcp_tool_call"]);
    const props = batch.map((e) => e.properties as Record<string, unknown>);
    expect(props[0]).toMatchObject({ $mcp_client_name: "claude-code", $mcp_client_version: "1.0", $mcp_source: "posthog_mcp_analytics", $process_person_profile: false });
    expect(props[1]).toMatchObject({ $mcp_tool_name: "recall", $mcp_is_error: false, $mcp_duration_ms: 12, response_bytes: 300, $mcp_client_user_agent: "claude-code/2.1.0" });
    expect(props[2]).toMatchObject({ $mcp_tool_name: "unknown", $mcp_is_error: true, $mcp_error_type: "validation" });
    const json = JSON.stringify(batch);
    for (const leak of [client.id, client.userId, client.name, "anthropic"]) expect(json).not.toContain(leak);
  });

  it("rotates the pseudonym every UTC day", async () => {
    const a = await dailyPseudonym(client, now);
    expect(await dailyPseudonym(client, now + 3600_000)).toBe(a);
    expect(await dailyPseudonym(client, now + 86_400_000)).not.toBe(a);
    expect(await dailyPseudonym({ ...client, id: "other" }, now)).not.toBe(a);
    expect(a).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("sendStats", () => {
  const stat: McpStat = { kind: "tool_call", tool: "remember", ok: true, durationMs: 3, responseBytes: 10 };

  it("posts one batch to the configured host", async () => {
    const fetcher = vi.fn(async () => new Response("{}"));
    await sendStats(on, [stat], client, { serverVersion: "1" }, fetcher as unknown as typeof fetch);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://eu.i.posthog.com/batch/");
    const body = JSON.parse(init.body as string);
    expect(body.api_key).toBe("phc_test");
    expect(body.batch).toHaveLength(1);
  });

  it("sends nothing when off and never throws", async () => {
    const fetcher = vi.fn(async () => { throw new Error("offline"); });
    await sendStats({}, [stat], client, { serverVersion: "1" }, fetcher as unknown as typeof fetch);
    expect(fetcher).not.toHaveBeenCalled();
    vi.spyOn(console, "warn").mockImplementationOnce(() => {});
    await expect(sendStats(on, [stat], client, { serverVersion: "1" }, fetcher as unknown as typeof fetch)).resolves.toBeUndefined();
  });
});

describe("privacy page", () => {
  const operator = { OPERATOR_NAME: "A", OPERATOR_STREET: "B", OPERATOR_CITY: "C", OPERATOR_COUNTRY_EN: "D", OPERATOR_COUNTRY_DE: "D", OPERATOR_EMAIL: "a@example.com" };

  it("names PostHog only when analytics is on", async () => {
    const off = await legalPage("privacy", operator as unknown as Env).text();
    expect(off).not.toContain("PostHog");
    const en = await legalPage("privacy", { ...operator, ...on } as unknown as Env).text();
    expect(en).toContain("PostHog");
    expect(en).toContain("EU (Frankfurt)");
    const de = await legalPage("datenschutz", { ...operator, ...on, POSTHOG_HOST: "https://us.i.posthog.com" } as unknown as Env).text();
    expect(de).toContain("Servern in den USA");
  });
});
