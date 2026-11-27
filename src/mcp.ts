// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Remote MCP server (Streamable HTTP, stateless). Every request is one JSON-RPC
// message answered with plain JSON, so no session state lives in the Worker.
// Authentication happens before this module: the caller passes the client that
// the bearer token (API key or OAuth access token) belongs to.

import { IMPORT_FORMATS, MAX_IMPORT_CHARS, parseMemoryFile, type ImportFormat } from "./importers";
import type { MemoryItem, NoteKind, Trust } from "./memory-object";
import { NOTE_KINDS } from "./memory-object";
import { agentScope, can, isValidSlug, recallScopes, type Client } from "./scopes";
import { isValidDue, MAX_LOOP_CHARS, MAX_OUTCOME_CHARS } from "./loops";
import type { McpStat } from "./analytics";
import { parseRangeBound } from "./timewindow";
import type { Tracked } from "./walls";
import { ORDER_ACTIONS, ordersText, type Decision, type Order, type OrderState, type ToolCall } from "./orders";
import { aggregate, RECORD_TYPES, recordLine, recordsSection, type RecordOp, type RecordRow, type RecordType } from "./records";

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/** What one recall tool call returns unless the agent asks for more items: the benchmark recalls the same way. */
export const RECALL_TOOL = { limit: 8, budgetTokens: 4000 } as const;

/** The part of the MemoryObject the MCP tools use. A Durable Object stub fits. */
export interface MemoryApi {
  recall(
    client: Client,
    input: { query: string; scopes: string[]; limit?: number; budgetTokens?: number; queries?: string[]; from?: number; to?: number; asOf?: number; named?: string[]; track?: Tracked },
  ): Promise<{ items: MemoryItem[]; notices?: string[]; corrections?: string[]; records?: { label: string; total: number; rows: RecordRow[] }[] }>;
  context(
    client: Client,
    scopes: string[],
    budgetTokens?: number,
    opts?: { track?: Tracked },
  ): Promise<{ text: string; notices?: string[]; conversation?: string; corrections?: string[] }> | { text: string; notices?: string[]; conversation?: string; corrections?: string[] };
  addNote(client: Client, input: { scope: string; content: string; kind?: NoteKind; trust?: Trust; track?: Tracked }): Promise<{ id: string; scope?: string; heldFor?: string }>;
  addEpisode(
    client: Client,
    input: { scope: string; sessionId?: string; model?: string; messages?: { role: string; content: string }[]; text?: string; track?: Tracked },
  ): Promise<{ id: string; chunks: number; scope?: string; wanted?: string }>;
  importNotes(
    client: Client,
    input: { scope: string; notes: string[]; kind?: NoteKind; trust?: Trust; source?: string; track?: Tracked },
  ): Promise<{ added: number; skipped: number; scope?: string; heldFor?: string }>;
  forget(client: Client, id: string): Promise<{ deleted: number }>;
  scopes(client: Client): Promise<string[]> | string[];
  /** Open loops (OPEN_LOOPS=on). */
  openLoop?(client: Client, input: { scope: string; content: string; dueAt?: number; track?: Tracked }): Promise<{ id: string; scope: string; dueAt: string | null }> | { id: string; scope: string; dueAt: string | null };
  closeLoop?(client: Client, id: string, outcome?: string): Promise<{ id: string; scope: string } | null> | { id: string; scope: string } | null;
  /** Standing orders (src/orders.ts). Only called when they are on. */
  listOrders?(client: Client, scopes: string[]): Promise<{ version: string; orders: Order[] }> | { version: string; orders: Order[] };
  addOrder?(client: Client, input: { scope: string; rule: unknown; state?: OrderState }): Promise<Order> | Order;
  checkToolCall?(client: Client, scopes: string[], call: ToolCall, session?: string): Promise<Decision | null> | Decision | null;
  /** Records (RECORDS=on, src/records.ts). */
  queryRecords?(
    client: Client,
    input: { scopes: string[]; category?: string; query?: string; type?: RecordType; from?: number; to?: number; limit?: number },
  ): Promise<{ labels: string[]; rows: RecordRow[]; total: number }>;
}

/** Server options that change what the MCP server offers. */
export interface McpOptions {
  /** Offer open_loop and close_loop (OPEN_LOOPS=on). */
  loops?: boolean;
  /** Standing orders are on (STANDING_ORDERS=on): their tools are listed and get_context names the active ones. */
  orders?: boolean;
  /** Usage analytics is on (MCP_ANALYTICS=on): every tool offers the optional intent category. */
  intent?: boolean;
  /** Offer query_records (RECORDS=on). */
  records?: boolean;
}

interface JsonRpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

type JsonRpcResponse = { jsonrpc: "2.0"; id: string | number | null } & ({ result: unknown } | { error: { code: number; message: string } });

const INSTRUCTIONS = [
  "rhizome is the person's long-term memory, shared by all their agents and AI providers.",
  "At the start of a task call get_context (with the project slug when you work in a project).",
  "Before answering something that may depend on their preferences, earlier decisions or past work, call recall.",
  "When the person states a preference, makes a decision or corrects you, call remember with one short, self-contained sentence.",
  "Never store secrets, credentials or other people's personal data.",
].join(" ");

const projectProp = {
  type: "string",
  description: "Project slug, lowercase, e.g. \"rhizome\" or \"website\". Use the repository or folder name.",
  pattern: "^[a-z0-9][a-z0-9._-]{0,47}$",
};
const conversationProp = {
  type: "string",
  maxLength: 200,
  description: "Handle of this conversation: the one get_context returned, or your own session id. Pass the same value on every memory call of the conversation.",
};
/** Why a tool is called, as a fixed category. Free text is never asked for, so nothing about the memory reaches analytics. */
export const INTENTS = [
  "task_start",
  "answer_question",
  "check_before_acting",
  "save_preference",
  "save_decision",
  "save_correction",
  "save_fact",
  "session_summary",
  "cleanup",
  "other",
] as const;
export type Intent = (typeof INTENTS)[number];
const intentProp = {
  type: "string",
  enum: INTENTS,
  description: "Optional, for anonymous usage statistics only: the closest reason for this call. Never changes the result.",
};
const isIntent = (v: unknown): v is Intent => typeof v === "string" && (INTENTS as readonly string[]).includes(v);

const scopeProp = {
  type: "string",
  enum: ["profile", "project", "private"],
  description: "profile: about the person, shared by every agent. project: about one project (needs project). private: only for you, this agent.",
};

export const TOOLS = [
  {
    name: "get_context",
    title: "Load standing context",
    description: "Loads the person's profile, working style and, with a project, the project summary and its most trusted notes. Call once at the start of a task.",
    inputSchema: { type: "object", properties: { project: projectProp, conversation: conversationProp }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "recall",
    title: "Search memory",
    description: "Searches long-term memory by meaning and keywords and returns the best matching notes and conversation excerpts, newest version first.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "What you want to know, in plain words." },
        project: projectProp,
        conversation: conversationProp,
        limit: { type: "integer", minimum: 1, maximum: 20, default: RECALL_TOOL.limit },
        queries: {
          type: "array",
          items: { type: "string", maxLength: 500 },
          maxItems: 4,
          description: "Optional: other wordings or the separate parts of a question with several parts. Each one is searched too.",
        },
        from: { type: "string", description: "Optional: only memories from this date or time on (ISO 8601, e.g. 2026-11-01)." },
        to: { type: "string", description: "Optional: only memories up to this date or time (ISO 8601; a date includes that whole day)." },
        as_of: {
          type: "string",
          description: "Optional: answer as of this date or time (ISO 8601): what was true then, including notes that were replaced later.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "remember",
    title: "Remember a note",
    description: "Stores one fact, preference, decision or learning. Write one short sentence that makes sense without the conversation. Contradictions with older notes are resolved in the background.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", maxLength: 8000 },
        kind: { type: "string", enum: NOTE_KINDS, default: "note" },
        scope: scopeProp,
        project: projectProp,
        said_by_user: { type: "boolean", description: "true only when the person said this explicitly in their own words.", default: false },
        conversation: conversationProp,
      },
      required: ["content"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "save_conversation",
    title: "Save a conversation",
    description: "Stores a conversation or work log verbatim. Facts and decisions are extracted from it in the background. Use at the end of a longer session.",
    inputSchema: {
      type: "object",
      properties: {
        messages: {
          type: "array",
          maxItems: 500,
          items: { type: "object", properties: { role: { type: "string" }, content: { type: "string" } }, required: ["role", "content"] },
        },
        text: { type: "string", description: "Use instead of messages for a summary or log." },
        project: projectProp,
        session_id: { type: "string", maxLength: 200 },
        conversation: conversationProp,
        model: { type: "string", maxLength: 200 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "import_memory_file",
    title: "Import a memory file",
    description: "Imports a CLAUDE.md, AGENTS.md, Hermes MEMORY.md or USER.md, or any Markdown notes file. Each bullet or paragraph becomes one note; notes that already exist are skipped.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", description: "The whole file.", maxLength: MAX_IMPORT_CHARS },
        format: { type: "string", enum: IMPORT_FORMATS, default: "markdown" },
        scope: scopeProp,
        project: projectProp,
        file_name: { type: "string", maxLength: 200 },
        conversation: conversationProp,
      },
      required: ["content"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: "forget",
    title: "Forget a memory",
    description: "Deletes a note or a whole conversation by its id, including its search index. Only when the person asks for it.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  },
] as const;

const conditionSchema = {
  type: "object",
  properties: {
    path: { type: "string", description: "text (the command or the written content), file (the path written to), or tool_input.<field>." },
    op: { type: "string", enum: ["eq", "in", "contains", "regex", "exists"] },
    value: { description: "A string, or a list of strings for in. Regexes are case-insensitive by default." },
    flags: { type: "string", description: "Regex flags made of i, m and s." },
  },
  required: ["path", "op"],
  additionalProperties: false,
};

/** Tools that exist only while standing orders are on. */
export const ORDER_TOOLS = [
  {
    name: "standing_orders",
    title: "List standing orders",
    description: "Lists the person's standing orders: rules they gave once that apply to every agent, such as never closing GitHub issues. Follow them.",
    inputSchema: { type: "object", properties: { project: projectProp }, additionalProperties: false },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "check_tool_call",
    title: "Check a tool call",
    description: "Checks a tool call you are about to make against the person's standing orders. Returns deny, ask, warn or ok, with the reason.",
    inputSchema: {
      type: "object",
      properties: {
        tool_name: { type: "string", maxLength: 200, description: "The tool's name as your harness calls it, e.g. Bash or mcp__github__issue_write." },
        tool_input: { type: "object", description: "The arguments you would pass." },
        project: projectProp,
      },
      required: ["tool_name"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "add_standing_order",
    title: "Add a standing order",
    description:
      "Stores a rule the person gave for every agent as a standing order that a pre-tool-call hook can enforce. Write when as precise clauses on tool names and fields of the call; an order can only stop or flag calls. " +
      "It is checked right away only when said_by_user is true; otherwise the person activates it in the explorer.",
    inputSchema: {
      type: "object",
      properties: {
        says: { type: "string", maxLength: 500, description: "The rule in the person's words, one sentence." },
        action: { type: "string", enum: ORDER_ACTIONS, default: "deny", description: "deny stops the call, ask has the person confirm it, warn only reminds you." },
        when: {
          type: "array",
          minItems: 1,
          maxItems: 10,
          description: "Any clause that matches triggers the order.",
          items: {
            type: "object",
            properties: {
              tool: { type: "string", description: "Tool name with * wildcards (e.g. mcp__*github*__issue_write), or @shell / @write for the shell and file tools of every harness." },
              all: { type: "array", maxItems: 8, items: conditionSchema, description: "Conditions that must all hold. Empty: every call of the tool." },
            },
            required: ["tool"],
            additionalProperties: false,
          },
        },
        project: { ...projectProp, description: "Only for this project. Without it the order applies everywhere." },
        said_by_user: { type: "boolean", default: false, description: "true only when the person gave this rule explicitly in their own words." },
      },
      required: ["says", "when"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
] as const;

/** Listed only with OPEN_LOOPS=on. */
export const LOOP_TOOLS = [
  {
    name: "open_loop",
    title: "Open a loop",
    description: "Keeps something to come back to, e.g. a follow-up the person asked for. From its due date on, get_context lists it under Due now until close_loop is called. Without due it shows the next time get_context loads it.",
    inputSchema: {
      type: "object",
      properties: {
        content: { type: "string", maxLength: MAX_LOOP_CHARS, description: "What to do, in one short sentence that makes sense without the conversation." },
        due: { type: "string", description: "Optional: from when it is due (ISO 8601: a date such as 2026-12-01 means the start of that day in UTC; for the person's local time add a time and offset, e.g. 2026-12-01T09:00+01:00)." },
        scope: scopeProp,
        project: projectProp,
        conversation: conversationProp,
      },
      required: ["content"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  },
  {
    name: "close_loop",
    title: "Close a loop",
    description: "Closes an open loop by its id once it is handled, so it no longer shows under Due now.",
    inputSchema: {
      type: "object",
      properties: {
        id: { type: "string" },
        outcome: { type: "string", maxLength: MAX_OUTCOME_CHARS, description: "Optional: what came of it, in one short sentence." },
      },
      required: ["id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
] as const;

const RECORD_OPS = ["list", "count", "sum", "latest"] as const;
export const RECORD_TOOLS = [
  {
    name: "query_records",
    title: "Count and list records",
    description:
      "Memory as a table: every note filed under a kind of thing (e.g. wedding, concert, bike repair, pet), with its date, amount and source. Use it to count, sum or list things across all conversations, e.g. how many weddings, how much was spent on repairs, or the latest job. Give a category, or a question and the matching categories are picked. Check the rows: a total is only as good as the notes behind it.",
    inputSchema: {
      type: "object",
      properties: {
        category: { type: "string", maxLength: 60, description: "A kind of thing, generic and singular, e.g. \"wedding\" or \"musical instrument\"." },
        query: { type: "string", maxLength: 500, description: "Or a question in plain words; the categories it asks for are used." },
        op: { type: "string", enum: RECORD_OPS, default: "list", description: "list the rows, count them, sum their amounts per unit, or name the latest." },
        type: { type: "string", enum: RECORD_TYPES, description: "Optional: only events, states, preferences or other." },
        from: { type: "string", description: "Optional: only things from this date on (ISO 8601)." },
        to: { type: "string", description: "Optional: only things up to this date (ISO 8601; a date includes that whole day)." },
        project: projectProp,
        limit: { type: "integer", minimum: 1, maximum: 200, default: 50 },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
] as const;

class ToolError extends Error {}
class RpcError extends Error {
  constructor(public code: number, message: string) {
    super(message);
  }
}

const str = (v: unknown, field: string, max: number, required = false): string | undefined => {
  if (v === undefined || v === null || v === "") {
    if (required) throw new ToolError(`${field} is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new ToolError(`${field} must be a string`);
  if (v.length > max) throw new ToolError(`${field} is longer than ${max} characters`);
  return v;
};

function project(v: unknown): string | undefined {
  const p = str(v, "project", 48);
  if (p !== undefined && !isValidSlug(p)) throw new ToolError("project must be a lowercase slug, e.g. my-app");
  return p;
}

/** Maps the tool-level scope choice to a real scope the client may write. */
function writeScope(client: Client, scope: unknown, proj: string | undefined): string {
  const choice = scope ?? (proj ? "project" : "profile");
  let target: string;
  if (choice === "profile") target = "profile";
  else if (choice === "private") target = agentScope(client.agent);
  else if (choice === "project") {
    if (!proj) throw new ToolError("scope project needs a project slug");
    target = `project:${proj}`;
  } else throw new ToolError("scope must be profile, project or private");
  if (!can(client, "write", target)) throw new ToolError(`this connection may not write to ${target}`);
  return target;
}

function line(i: MemoryItem): string {
  const what = i.kind === "note" ? i.noteKind : "conversation";
  const flag = i.status === "disputed" ? " · disputed" : "";
  const head = `- [${i.id}] (${i.scope} · ${what} · ${i.trust} · ${i.agent} · ${i.tEvent.slice(0, 10)}${flag}) ${i.content}`;
  return i.evidence ? `${head}\n  source (${i.evidence.tEvent.slice(0, 10)}): ${i.evidence.content}` : head;
}

/** The text the recall tool hands an agent: notices first, then one line per item. The benchmark reads the same text. */
export function recallText(res: { items: MemoryItem[]; notices?: string[]; corrections?: string[]; records?: { label: string; total: number; rows: RecordRow[] }[] }): string {
  const head = [res.corrections, res.notices].map((l) => (l?.length ? l.join("\n") + "\n\n" : "")).join("");
  const records = res.records?.length ? recordsSection(res.records) : "";
  if (!res.items.length && !records) return head + "No matching memories.";
  return head + [records, res.items.map(line).join("\n")].filter(Boolean).join("\n\n");
}

function subQueries(v: unknown): string[] {
  if (!Array.isArray(v) || v.length > 4 || v.some((q) => typeof q !== "string" || q.length > 500)) {
    throw new ToolError("queries must be at most 4 strings of up to 500 characters");
  }
  return (v as string[]).map((q) => q.trim()).filter(Boolean);
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };
const text = (t: string, structured?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: t }],
  ...(structured ? { structuredContent: structured } : {}),
});

async function callTool(memory: MemoryApi, client: Client, name: string, args: Record<string, unknown>, opts: McpOptions): Promise<ToolResult> {
  if ((name === "open_loop" || name === "close_loop") && opts.loops && memory.openLoop && memory.closeLoop) return loopTool(memory, client, name, args);
  if (opts.orders && ORDER_TOOLS.some((t) => t.name === name)) return orderTool(memory, client, name, args);
  if (name === "query_records" && opts.records && memory.queryRecords) return recordsTool(memory, client, args);
  switch (name) {
    case "get_context": {
      const proj = project(args.project);
      const scopes = recallScopes(client, undefined, proj);
      const res = await memory.context(client, scopes, 2000, { track: track(args) });
      const parts = [...(res.corrections?.length ? [res.corrections.join("\n")] : []), ...(res.notices ?? []), res.text || "Nothing stored yet for these scopes."];
      // With walls set, a conversation without a handle gets one (see walls.ts, rule 2).
      if (res.conversation) parts.push(`Conversation handle: ${res.conversation}. Pass it as conversation on every memory call in this conversation.`);
      // Standing orders lead nothing and change nothing else in the context: they are added after it.
      if (opts.orders && memory.listOrders) {
        const orders = ordersText((await memory.listOrders(client, orderScopes(client, proj))).orders);
        if (orders) parts.push(orders);
      }
      const extra = {
        ...(res.conversation ? { conversation: res.conversation } : {}),
        ...(res.notices?.length ? { notices: res.notices } : {}),
        ...(res.corrections?.length ? { corrections: res.corrections } : {}),
      };
      return text(parts.join("\n\n"), Object.keys(extra).length ? extra : undefined);
    }
    case "recall": {
      const query = str(args.query, "query", 2000, true)!.trim();
      const proj = project(args.project);
      const limit = typeof args.limit === "number" ? Math.min(Math.max(Math.round(args.limit), 1), 20) : RECALL_TOOL.limit;
      // Recall sees the profile, this agent's own notes and the project. Without a
      // project it also looks into every project the client may read, except walled ones.
      const scopes = proj ? recallScopes(client, undefined, proj) : await readableScopes(memory, client);
      const queries = args.queries === undefined ? undefined : subQueries(args.queries);
      let from: number | undefined;
      let to: number | undefined;
      let asOf: number | undefined;
      try {
        from = parseRangeBound(args.from, false);
        to = parseRangeBound(args.to, true);
        asOf = parseRangeBound(args.as_of, true);
      } catch {
        throw new ToolError("from, to and as_of must be ISO 8601 dates or times, e.g. 2026-11-01");
      }
      // A date as as_of means the end of that day.
      if (asOf !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(String(args.as_of).trim())) asOf -= 1;
      // Walled projects are only searched when the call names them (see walls.ts).
      const named = proj ? [`project:${proj}`] : [];
      const res = await memory.recall(client, { query, scopes, limit, budgetTokens: RECALL_TOOL.budgetTokens, queries, from, to, asOf, named, track: track(args) });
      const notices = { ...(res.notices?.length ? { notices: res.notices } : {}), ...(res.corrections?.length ? { corrections: res.corrections } : {}) };
      const records = res.records?.length ? { records: res.records.map((g) => ({ label: g.label, total: g.total, rows: g.rows.map(recordOut) })) } : {};
      if (!res.items.length && !res.records?.length) return text(recallText(res), Object.keys(notices).length ? { results: [], ...notices } : undefined);
      return text(recallText(res), {
        ...notices,
        ...records,
        results: res.items.map((i) => ({
          id: i.id,
          scope: i.scope,
          kind: i.kind,
          content: i.content,
          trust: i.trust,
          status: i.status,
          date: i.tEvent,
          ...(i.confidence !== undefined ? { confidence: i.confidence } : {}),
          ...(i.evidence ? { evidence: { id: i.evidence.id, content: i.evidence.content, date: i.evidence.tEvent } } : {}),
        })),
      });
    }
    case "remember": {
      const content = str(args.content, "content", 8000, true)!.trim();
      if (!content) throw new ToolError("content is empty");
      const kind = args.kind === undefined ? "note" : args.kind;
      if (!NOTE_KINDS.includes(kind as NoteKind)) throw new ToolError(`kind must be one of ${NOTE_KINDS.join(", ")}`);
      const scope = writeScope(client, args.scope, project(args.project));
      const trust: Trust = args.said_by_user === true ? "user_explicit" : "agent_inference";
      const res = await memory.addNote(client, { scope, content, kind: kind as NoteKind, trust, track: track(args) });
      if (res.heldFor && res.scope) {
        return text(`Kept in ${res.scope} (id ${res.id}): this conversation was given memory from behind a wall. It moves to ${res.heldFor} once the person releases it.`, { id: res.id, scope: res.scope, heldFor: res.heldFor });
      }
      return text(`Remembered in ${scope} (id ${res.id}).`, { id: res.id, scope });
    }
    case "save_conversation": {
      const proj = project(args.project);
      const scope = proj ? writeScope(client, "project", proj) : writeScope(client, "private", undefined);
      let messages: { role: string; content: string }[] | undefined;
      if (args.messages !== undefined) {
        if (!Array.isArray(args.messages) || args.messages.length > 500) throw new ToolError("messages must be an array of at most 500 items");
        messages = args.messages.map((m) => {
          const r = m as { role?: unknown; content?: unknown };
          if (typeof r?.role !== "string" || typeof r?.content !== "string") throw new ToolError("each message needs role and content strings");
          return { role: r.role.slice(0, 32), content: r.content };
        });
      }
      const body = str(args.text, "text", 500_000);
      if (!messages?.length && !body?.trim()) throw new ToolError("messages or text is required");
      const res = await memory.addEpisode(client, {
        scope,
        messages,
        text: messages?.length ? undefined : body,
        sessionId: str(args.session_id, "session_id", 200),
        model: str(args.model, "model", 200),
        // Without a conversation handle, the session id names the conversation. It may not
        // have been passed on reads, so what the connector read lately counts too.
        track: args.conversation === undefined ? { ...track({ conversation: args.session_id }), window: true } : track(args),
      });
      if (res.scope && res.wanted) {
        return text(
          `Saved to ${res.scope} (id ${res.id}) instead of ${res.wanted}: this conversation was given memory from behind a wall. Facts are extracted in the background within a minute and stay there until the person releases them.`,
          { id: res.id, scope: res.scope, wanted: res.wanted },
        );
      }
      return text(`Saved to ${scope} (id ${res.id}). Facts are extracted in the background within a minute.`, { id: res.id, scope });
    }
    case "import_memory_file": {
      const content = str(args.content, "content", MAX_IMPORT_CHARS, true)!;
      const format = (args.format ?? "markdown") as ImportFormat;
      if (!IMPORT_FORMATS.includes(format)) throw new ToolError(`format must be one of ${IMPORT_FORMATS.join(", ")}`);
      const scope = writeScope(client, args.scope, project(args.project));
      const notes = parseMemoryFile(content, format);
      if (!notes.length) throw new ToolError("found nothing to import");
      const res = await memory.importNotes(client, {
        scope,
        notes,
        trust: format === "hermes" ? "agent_inference" : "user_confirmed",
        source: str(args.file_name, "file_name", 200) ?? format,
        track: track(args),
      });
      if (res.scope && res.heldFor) {
        return text(
          `Imported ${res.added} notes into ${res.scope} instead of ${res.heldFor}, skipped ${res.skipped}: this conversation was given memory from behind a wall. They move once the person releases them.`,
          { scope: res.scope, heldFor: res.heldFor, added: res.added, skipped: res.skipped },
        );
      }
      return text(`Imported ${res.added} notes into ${scope}, skipped ${res.skipped} that already existed.`, { scope, ...res });
    }
    case "forget": {
      const id = str(args.id, "id", 64, true)!;
      const res = await memory.forget(client, id);
      if (!res.deleted) throw new ToolError("nothing found with this id");
      return text(`Forgot ${id}.`);
    }
    default:
      throw new RpcError(-32602, `unknown tool: ${name}`);
  }
}

/** Scopes standing orders are read from: the profile and the project, if any. */
function orderScopes(client: Client, proj: string | undefined): string[] {
  return ["profile", ...(proj ? [`project:${proj}`] : [])].filter((s) => can(client, "read", s));
}

async function orderTool(memory: MemoryApi, client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  if (!memory.listOrders || !memory.addOrder || !memory.checkToolCall) throw new ToolError("standing orders are not available");
  const proj = project(args.project);
  switch (name) {
    case "standing_orders": {
      const { orders } = await memory.listOrders(client, orderScopes(client, proj));
      const shown = orders.filter((o) => o.state === "active");
      if (!shown.length) return text("No standing orders.", { orders: [] });
      return text(ordersText(shown), { orders: shown.map((o) => ({ id: o.id, scope: o.scope, says: o.says, action: o.action, when: o.when })) });
    }
    case "check_tool_call": {
      const tool = str(args.tool_name, "tool_name", 200, true)!;
      const input = args.tool_input;
      if (input !== undefined && (input === null || typeof input !== "object" || Array.isArray(input))) throw new ToolError("tool_input must be an object");
      if (input !== undefined && JSON.stringify(input).length > 200_000) throw new ToolError("tool_input is longer than 200000 characters");
      const decision = await memory.checkToolCall(client, orderScopes(client, proj), { tool_name: tool, tool_input: (input ?? {}) as Record<string, unknown> }, str(args.conversation, "conversation", 200));
      if (!decision) return text("ok: no standing order applies to this call.", { action: "ok" });
      return text(`${decision.action}: ${decision.reason}`, { action: decision.action, order: decision.order, reason: decision.reason });
    }
    case "add_standing_order": {
      const scope = proj ? `project:${proj}` : "profile";
      if (!can(client, "write", scope)) throw new ToolError(`this connection may not write to ${scope}`);
      const order = await memory.addOrder(client, {
        scope,
        rule: { says: args.says, action: args.action, when: args.when },
        state: args.said_by_user === true ? "active" : "proposed",
      });
      const note = order.state === "active" ? "It is checked from now on where a hook asks rhizome before tool calls." : "It is checked once the person activates it in the memory explorer.";
      return text(`Stored standing order ${order.id} in ${scope}. ${note}`, { id: order.id, scope, state: order.state });
    }
    default:
      throw new RpcError(-32602, `unknown tool: ${name}`);
  }
}

function recordOut(r: RecordRow) {
  return {
    id: r.id,
    date: r.date,
    type: r.type,
    category: r.category,
    ...(r.tags.length ? { tags: r.tags } : {}),
    ...(r.quantity !== null ? { quantity: r.quantity, unit: r.unit } : {}),
    content: r.content,
    status: r.status,
    scope: r.scope,
    sources: r.sources,
  };
}

async function recordsTool(memory: MemoryApi, client: Client, args: Record<string, unknown>): Promise<ToolResult> {
  const category = str(args.category, "category", 60)?.trim();
  const query = str(args.query, "query", 500)?.trim();
  const op = (args.op ?? "list") as RecordOp;
  if (!(RECORD_OPS as readonly string[]).includes(op)) throw new ToolError(`op must be one of ${RECORD_OPS.join(", ")}`);
  const type = args.type === undefined ? undefined : (args.type as RecordType);
  if (type !== undefined && !(RECORD_TYPES as readonly string[]).includes(type)) throw new ToolError(`type must be one of ${RECORD_TYPES.join(", ")}`);
  const limit = typeof args.limit === "number" ? Math.min(Math.max(Math.round(args.limit), 1), 200) : 50;
  let from: number | undefined;
  let to: number | undefined;
  try {
    from = parseRangeBound(args.from, false);
    to = parseRangeBound(args.to, true);
  } catch {
    throw new ToolError("from and to must be ISO 8601 dates or times, e.g. 2026-11-01");
  }
  const proj = project(args.project);
  const scopes = proj ? recallScopes(client, undefined, proj) : await readableScopes(memory, client);
  // Every row counts for count and sum; limit only shortens the list shown.
  const res = await memory.queryRecords!(client, { scopes, category, query, type, from, to, limit: 500 });
  const result = aggregate(res.rows, op);
  const shown = res.rows.slice(0, limit);
  const what = res.labels.length ? res.labels.map((l) => `"${l}"`).join(", ") : category || query ? "nothing on file for that" : "all records";
  const summary =
    op === "count" ? `${res.total} records (${what}).`
    : op === "sum"
      ? `Sum (${what}): ${(result.sums as { unit: string | null; total: number }[]).map((s) => `${s.total}${s.unit ? ` ${s.unit}` : ""}`).join(", ") || "no amounts"}` +
        (result.withoutQuantity ? `; ${result.withoutQuantity} of ${res.total} rows have no amount.` : ".")
      : op === "latest" ? `Latest (${what}): ${(result.latest as string | null) ?? "none"}.`
        : `${res.total} records (${what})${res.total > shown.length ? `, ${shown.length} shown` : ""}, oldest first.`;
  const body = shown.length ? `\n${shown.map(recordLine).join("\n")}` : "";
  return text(summary + body, { labels: res.labels, total: res.total, ...result, rows: shown.map(recordOut) });
}

async function loopTool(memory: MemoryApi, client: Client, name: "open_loop" | "close_loop", args: Record<string, unknown>): Promise<ToolResult> {
  if (name === "close_loop") {
    const id = str(args.id, "id", 64, true)!;
    const res = await memory.closeLoop!(client, id, str(args.outcome, "outcome", MAX_OUTCOME_CHARS));
    if (!res) throw new ToolError("no open loop with this id");
    return text(`Closed ${id}.`, { id, scope: res.scope });
  }
  const content = str(args.content, "content", MAX_LOOP_CHARS, true)!.trim();
  if (!content) throw new ToolError("content is empty");
  let dueAt: number | undefined;
  try {
    dueAt = parseRangeBound(args.due, false);
    if (dueAt !== undefined && !isValidDue(dueAt)) throw new Error("out of range");
  } catch {
    throw new ToolError("due must be an ISO 8601 date or time, e.g. 2026-12-01");
  }
  const scope = writeScope(client, args.scope, project(args.project));
  const res = await memory.openLoop!(client, { scope, content, dueAt, track: track(args) });
  const when = res.dueAt ? `due ${res.dueAt.slice(0, 16).replace("T", " ")} UTC` : "due the next time get_context loads it";
  return text(`Opened ${res.id} in ${res.scope}, ${when}.`, { id: res.id, scope: res.scope, due: res.dueAt });
}

/** Marks a call as coming from an agent's conversation, with its handle when it passed one. */
function track(args: Record<string, unknown>): Tracked {
  const conversation = str(args.conversation, "conversation", 200)?.trim();
  return conversation ? { conversation } : {};
}

/** Every scope the client may read: profile, its own notes and each of its projects. */
async function readableScopes(memory: MemoryApi, client: Client): Promise<string[]> {
  const all = await memory.scopes(client);
  return [...new Set([...recallScopes(client), ...all.filter((s) => s.startsWith("project:") && can(client, "read", s))])];
}

type Observe = (stat: McpStat) => void;

async function handle(memory: MemoryApi, client: Client, req: JsonRpcRequest, version: string, observe?: Observe, opts: McpOptions = {}): Promise<unknown> {
  const params = req.params ?? {};
  switch (req.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const protocolVersion = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
      if (observe) {
        const info = (params.clientInfo ?? {}) as { name?: unknown; version?: unknown };
        observe({
          kind: "initialize",
          clientName: typeof info.name === "string" ? info.name : undefined,
          clientVersion: typeof info.version === "string" ? info.version : undefined,
          protocolVersion,
        });
      }
      return {
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "rhizome", title: "rhizome memory", version },
        instructions: INSTRUCTIONS,
      };
    }
    case "ping":
      return {};
    case "tools/list": {
      const tools = [...TOOLS, ...(opts.loops ? LOOP_TOOLS : []), ...(opts.orders ? ORDER_TOOLS : []), ...(opts.records && memory.queryRecords ? RECORD_TOOLS : [])];
      if (!opts.intent) return { tools };
      return {
        tools: tools.map((t) => ({ ...t, inputSchema: { ...t.inputSchema, properties: { ...t.inputSchema.properties, intent: intentProp } } })),
      };
    }
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const args = params.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
      const started = Date.now();
      // Only the tool name, the outcome, the time taken, the size of the answer, the intent
      // category and the conversation handle (hashed in analytics.ts) are reported.
      const conversation = typeof args.conversation === "string" ? args.conversation.trim().slice(0, 200) : "";
      const intent = isIntent(args.intent) ? args.intent : undefined;
      const report = (result: ToolResult | null, errorType?: "validation" | "internal") =>
        observe?.({
          kind: "tool_call",
          tool: name,
          ok: !errorType,
          errorType,
          durationMs: Date.now() - started,
          responseBytes: result ? JSON.stringify(result).length : 0,
          ...(conversation ? { conversation } : {}),
          ...(intent ? { intent } : {}),
        });
      try {
        const result = await callTool(memory, client, name, args, opts);
        report(result);
        return result;
      } catch (e) {
        if (e instanceof RpcError) {
          report(null, "validation");
          throw e;
        }
        const validation = e instanceof ToolError || (e instanceof Error && /must be|empty|limit is|not allowed|may not/.test(e.message));
        const message = e instanceof ToolError ? e.message : validation ? (e as Error).message : "the memory service failed, try again";
        if (!(e instanceof ToolError)) console.error(e);
        const result = { content: [{ type: "text", text: message }], isError: true } satisfies ToolResult;
        report(result, validation ? "validation" : "internal");
        return result;
      }
    }
    case "resources/list":
      return { resources: [] };
    case "prompts/list":
      return { prompts: [] };
    default:
      throw new RpcError(-32601, `method not found: ${req.method}`);
  }
}

/**
 * Answers one Streamable HTTP POST body (a single message or a batch). `observe`, when
 * given, hears about each initialize and tool call (see analytics.ts).
 */
export async function mcpResponse(memory: MemoryApi, client: Client, raw: unknown, version: string, observe?: Observe, opts: McpOptions = {}): Promise<Response> {
  const messages = Array.isArray(raw) ? raw : [raw];
  if (!messages.length) return rpcError(null, -32600, "empty batch");
  const out: JsonRpcResponse[] = [];
  for (const m of messages) {
    const msg = m as Partial<JsonRpcRequest>;
    if (!msg || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
      // Responses to server requests (we send none) and malformed input.
      if (msg && "id" in msg && !("method" in msg)) continue;
      out.push({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "invalid JSON-RPC message" } });
      continue;
    }
    const isNotification = msg.id === undefined;
    try {
      const result = await handle(memory, client, msg as JsonRpcRequest, version, observe, opts);
      if (!isNotification) out.push({ jsonrpc: "2.0", id: msg.id ?? null, result });
    } catch (e) {
      if (isNotification) continue;
      const err = e instanceof RpcError ? e : new RpcError(-32603, "internal error");
      if (!(e instanceof RpcError)) console.error(e);
      out.push({ jsonrpc: "2.0", id: msg.id ?? null, error: { code: err.code, message: err.message } });
    }
  }
  if (!out.length) return new Response(null, { status: 202 });
  return Response.json(Array.isArray(raw) ? out : out[0], { headers: { "cache-control": "no-store" } });
}

export function rpcError(id: string | number | null, code: number, message: string, status = 400): Response {
  return Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status });
}
