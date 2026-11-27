// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Anonymous MCP usage analytics for PostHog, off by default. With MCP_ANALYTICS=on,
// POSTHOG_KEY and POSTHOG_HOST set, the Worker sends one event per MCP tool call
// and per initialize, shaped like PostHog's MCP analytics SDK so its MCP dashboards
// work. Events never carry memory content, queries, tool arguments or results,
// project or scope names, user or client ids, emails or tokens. What they carry:
// the tool name, success or failure, the error class, latency, the response size,
// the MCP client's software name and version, the intent category the agent picked
// from a fixed list, and a hash of the conversation handle.

import type { Client } from "./scopes";
import { INTENTS, TOOLS, type Intent } from "./mcp";

/**
 * What mcp.ts reports about one handled message. From the tool arguments only the
 * intent category and the conversation handle are taken; the handle is hashed before sending.
 */
export type McpStat =
  | { kind: "initialize"; clientName?: string; clientVersion?: string; protocolVersion?: string }
  | { kind: "tool_call"; tool: string; ok: boolean; errorType?: "validation" | "internal"; durationMs: number; responseBytes: number; conversation?: string; intent?: Intent };

export interface AnalyticsEnv {
  MCP_ANALYTICS?: string;
  POSTHOG_KEY?: string;
  POSTHOG_HOST?: string;
}

const TOOL_NAMES = new Set<string>(TOOLS.map((t) => t.name));
const INTENT_NAMES = new Set<string>(INTENTS);

/** The ingestion host, or null when analytics is off or not configured. */
export function analyticsHost(env: AnalyticsEnv): string | null {
  if ((env.MCP_ANALYTICS ?? "").trim().toLowerCase() !== "on") return null;
  if (!env.POSTHOG_KEY?.trim() || !env.POSTHOG_HOST?.trim()) return null;
  try {
    const url = new URL(env.POSTHOG_HOST.trim());
    if (url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/** Client software names like "claude-code" or "Cursor"; anything else is dropped. */
function label(value: string | undefined, max = 64): string | undefined {
  const v = value?.trim().slice(0, max);
  return v && /^[A-Za-z0-9][A-Za-z0-9 ._@/+-]*$/.test(v) ? v : undefined;
}

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * A pseudonym that changes every UTC day, so calls of one day can be counted per
 * connector without a stable id that links days. It is derived from the connector's
 * random id (never sent itself) and cannot be turned back into it.
 */
export async function dailyPseudonym(client: Client, now = Date.now()): Promise<string> {
  const day = new Date(now).toISOString().slice(0, 10);
  return (await sha256Hex(`rhizome-mcp:${client.id}:${day}`)).slice(0, 32);
}

/**
 * Groups the calls of one conversation. It is a hash of the connector's id, the
 * handle the agent passes as conversation and the UTC day, so neither id is sent, it
 * cannot be turned back into them, and like the daily pseudonym it does not link days.
 */
export async function conversationPseudonym(client: Client, conversation: string, now = Date.now()): Promise<string> {
  const day = new Date(now).toISOString().slice(0, 10);
  const h = await sha256Hex(`rhizome-mcp-conversation:${client.id}:${day}:${conversation}`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

export async function buildBatch(
  stats: McpStat[],
  client: Client,
  ctx: { serverVersion: string; userAgent?: string; now?: number },
): Promise<Record<string, unknown>[]> {
  const now = ctx.now ?? Date.now();
  const distinctId = await dailyPseudonym(client, now);
  const timestamp = new Date(now).toISOString();
  const common = {
    $mcp_interface: "mcp",
    $mcp_source: "posthog_mcp_analytics",
    $mcp_server_name: "rhizome",
    $mcp_server_version: ctx.serverVersion,
    $lib: "rhizome",
    $process_person_profile: false,
    $geoip_disable: true,
    $ip: null,
  };
  // The connector's agent slug (e.g. claude-code) stands in when the call itself has no client info.
  const agent = label(client.agent);
  const userAgent = label(ctx.userAgent?.split(" ")[0], 100);
  const conversations = new Map<string, string>();
  for (const s of stats) {
    if (s.kind === "tool_call" && s.conversation && !conversations.has(s.conversation)) {
      conversations.set(s.conversation, await conversationPseudonym(client, s.conversation, now));
    }
  }
  return stats.map((s) => {
    if (s.kind === "initialize") {
      return {
        event: "$mcp_initialize",
        distinct_id: distinctId,
        timestamp,
        properties: {
          ...common,
          $mcp_client_name: label(s.clientName) ?? agent,
          ...(label(s.clientVersion, 32) ? { $mcp_client_version: label(s.clientVersion, 32) } : {}),
          ...(s.protocolVersion ? { $mcp_protocol_version: s.protocolVersion } : {}),
          ...(userAgent ? { $mcp_client_user_agent: userAgent } : {}),
        },
      };
    }
    return {
      event: "$mcp_tool_call",
      distinct_id: distinctId,
      timestamp,
      properties: {
        ...common,
        $mcp_tool_name: TOOL_NAMES.has(s.tool) ? s.tool : "unknown",
        $mcp_is_error: !s.ok,
        ...(s.ok ? {} : { $mcp_error_type: s.errorType ?? "internal" }),
        $mcp_duration_ms: Math.round(s.durationMs),
        response_bytes: s.responseBytes,
        ...(s.intent && INTENT_NAMES.has(s.intent) ? { $mcp_intent: s.intent, $mcp_intent_source: "context_parameter" } : {}),
        ...(s.conversation ? { $mcp_conversation_id: conversations.get(s.conversation) } : {}),
        ...(agent ? { $mcp_client_name: agent } : {}),
        ...(userAgent ? { $mcp_client_user_agent: userAgent } : {}),
      },
    };
  });
}

/** Sends the stats in one batch. Never throws: analytics must not break a memory call. */
export async function sendStats(
  env: AnalyticsEnv,
  stats: McpStat[],
  client: Client,
  ctx: { serverVersion: string; userAgent?: string },
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const host = analyticsHost(env);
  if (!host || !stats.length) return;
  try {
    const batch = await buildBatch(stats, client, ctx);
    const res = await fetcher(`${host}/batch/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ api_key: env.POSTHOG_KEY!.trim(), batch }),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) console.warn(`mcp analytics: PostHog answered ${res.status}`);
  } catch (e) {
    console.warn("mcp analytics: send failed", e instanceof Error ? e.message : e);
  }
}
