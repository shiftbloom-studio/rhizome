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

export const PROTOCOL_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

/** The part of the MemoryObject the MCP tools use. A Durable Object stub fits. */
export interface MemoryApi {
  recall(client: Client, input: { query: string; scopes: string[]; limit?: number; budgetTokens?: number }): Promise<{ items: MemoryItem[] }>;
  context(client: Client, scopes: string[], budgetTokens?: number): Promise<{ text: string }> | { text: string };
  addNote(client: Client, input: { scope: string; content: string; kind?: NoteKind; trust?: Trust }): Promise<{ id: string }>;
  addEpisode(client: Client, input: { scope: string; sessionId?: string; model?: string; messages?: { role: string; content: string }[]; text?: string }): Promise<{ id: string; chunks: number }>;
  importNotes(client: Client, input: { scope: string; notes: string[]; kind?: NoteKind; trust?: Trust; source?: string }): Promise<{ added: number; skipped: number }>;
  forget(client: Client, id: string): Promise<{ deleted: number }>;
  scopes(client: Client): Promise<string[]> | string[];
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
    inputSchema: { type: "object", properties: { project: projectProp }, additionalProperties: false },
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
        limit: { type: "integer", minimum: 1, maximum: 20, default: 8 },
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
  return `- [${i.id}] (${i.scope} · ${what} · ${i.trust} · ${i.agent} · ${i.tEvent.slice(0, 10)}${flag}) ${i.content}`;
}

type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean; structuredContent?: Record<string, unknown> };
const text = (t: string, structured?: Record<string, unknown>): ToolResult => ({
  content: [{ type: "text", text: t }],
  ...(structured ? { structuredContent: structured } : {}),
});

async function callTool(memory: MemoryApi, client: Client, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  switch (name) {
    case "get_context": {
      const proj = project(args.project);
      const scopes = recallScopes(client, undefined, proj);
      const res = await memory.context(client, scopes, 2000);
      return text(res.text || "Nothing stored yet for these scopes.");
    }
    case "recall": {
      const query = str(args.query, "query", 2000, true)!.trim();
      const proj = project(args.project);
      const limit = typeof args.limit === "number" ? Math.min(Math.max(Math.round(args.limit), 1), 20) : 8;
      // Recall sees the profile, this agent's own notes and the project. Without a
      // project it also looks into every project the client may read.
      const scopes = proj ? recallScopes(client, undefined, proj) : await readableScopes(memory, client);
      const res = await memory.recall(client, { query, scopes, limit, budgetTokens: 4000 });
      if (!res.items.length) return text("No matching memories.");
      return text(res.items.map(line).join("\n"), {
        results: res.items.map((i) => ({ id: i.id, scope: i.scope, kind: i.kind, content: i.content, trust: i.trust, status: i.status, date: i.tEvent })),
      });
    }
    case "remember": {
      const content = str(args.content, "content", 8000, true)!.trim();
      if (!content) throw new ToolError("content is empty");
      const kind = args.kind === undefined ? "note" : args.kind;
      if (!NOTE_KINDS.includes(kind as NoteKind)) throw new ToolError(`kind must be one of ${NOTE_KINDS.join(", ")}`);
      const scope = writeScope(client, args.scope, project(args.project));
      const trust: Trust = args.said_by_user === true ? "user_explicit" : "agent_inference";
      const res = await memory.addNote(client, { scope, content, kind: kind as NoteKind, trust });
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
      });
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
      });
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

/** Every scope the client may read: profile, its own notes and each of its projects. */
async function readableScopes(memory: MemoryApi, client: Client): Promise<string[]> {
  const all = await memory.scopes(client);
  return [...new Set([...recallScopes(client), ...all.filter((s) => s.startsWith("project:") && can(client, "read", s))])];
}

async function handle(memory: MemoryApi, client: Client, req: JsonRpcRequest, version: string): Promise<unknown> {
  const params = req.params ?? {};
  switch (req.method) {
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      return {
        protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "rhizome", title: "rhizome memory", version },
        instructions: INSTRUCTIONS,
      };
    }
    case "ping":
      return {};
    case "tools/list":
      return { tools: TOOLS };
    case "tools/call": {
      const name = typeof params.name === "string" ? params.name : "";
      const args = params.arguments && typeof params.arguments === "object" ? (params.arguments as Record<string, unknown>) : {};
      try {
        return await callTool(memory, client, name, args);
      } catch (e) {
        if (e instanceof RpcError) throw e;
        const message = e instanceof ToolError ? e.message : e instanceof Error && /must be|empty|limit is|not allowed|may not/.test(e.message) ? e.message : "the memory service failed, try again";
        if (!(e instanceof ToolError)) console.error(e);
        return { content: [{ type: "text", text: message }], isError: true } satisfies ToolResult;
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

/** Answers one Streamable HTTP POST body (a single message or a batch). */
export async function mcpResponse(memory: MemoryApi, client: Client, raw: unknown, version: string): Promise<Response> {
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
      const result = await handle(memory, client, msg as JsonRpcRequest, version);
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
