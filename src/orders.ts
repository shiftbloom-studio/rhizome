// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Standing orders: rules the person stated once ("never close GitHub issues"),
// kept as data and checked against an agent's tool call before it runs.
//
// rhizome stores the orders, hands them to agents with their context and answers
// a check for one tool call. Whether a check happens before every tool call is
// up to the agent's harness: it needs a pre-tool-call hook that asks rhizome (see
// docs/standing-orders.md). Without one, an order is a written rule like any
// other memory, and the agent may still break it.
//
// An order is never code. Each order has `when` clauses: a tool name pattern and
// conditions on fields of the call. Orders can only restrict (deny, ask, warn),
// so the worst a wrong order can do is stop a call; it can never let one through.
//
// On by default; STANDING_ORDERS=off turns them off (src/flags.ts).

import { BudgetError, linearRegex, PatternError, type Budget, type LinearRegex } from "./linear-regex";
import { trimEndChars } from "./text";

export const ORDER_ACTIONS = ["deny", "ask", "warn"] as const;
export type OrderAction = (typeof ORDER_ACTIONS)[number];
export const ORDER_OPS = ["eq", "in", "contains", "regex", "exists"] as const;
export type OrderOp = (typeof ORDER_OPS)[number];
/** active: checked. proposed: an agent wrote it without the person's own words; checked once the person activates it. disabled: kept, not checked. */
export const ORDER_STATES = ["active", "proposed", "disabled"] as const;
export type OrderState = (typeof ORDER_STATES)[number];
export const HOOK_FORMATS = ["claude", "codex", "cursor", "gemini"] as const;
export type HookFormat = (typeof HOOK_FORMATS)[number];

export interface OrderCondition {
  /** `text` (the command or written content), `file` (the path written to), or a dotted path such as tool_input.state. */
  path: string;
  op: OrderOp;
  value?: string | string[];
  /** Regex flags, only `i`, `m` and `s`. Default: i. */
  flags?: string;
}

export interface OrderClause {
  /** Tool name pattern with `*` wildcards, or a group: @shell, @write. */
  tool: string;
  /** Every condition has to hold. An empty list matches every call of the tool. */
  all?: OrderCondition[];
}

export interface OrderRule {
  says: string;
  action: OrderAction;
  when: OrderClause[];
}

export interface Order extends OrderRule {
  id: string;
  scope: string;
  state: OrderState;
  /** Date the order was stored (YYYY-MM-DD), shown in the reason an agent gets. */
  said: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ToolCall {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

export interface Decision {
  action: OrderAction;
  order: string;
  says: string;
  reason: string;
}

export const ORDER_LIMIT = 100;
export const SAYS_MAX = 500;
const CLAUSE_LIMIT = 10;
const CONDITION_LIMIT = 8;
const VALUE_MAX = 300;
/** Conditions never look at more than this many characters of a call. */
export const MAX_TEXT = 20_000;
/**
 * Regex work one check may do, in matcher steps (about a second of CPU at most).
 * Past it, the remaining regex conditions do not hold: the check lets the call go
 * on rather than hold up the person's memory, as the hooks do when rhizome is slow.
 */
export const CHECK_BUDGET = 20_000_000;

/** Tool names of the shell and file-writing tools in Claude Code, Codex, Cursor and Gemini CLI. */
export const TOOL_GROUPS: Record<string, string[]> = {
  "@shell": ["Bash", "Shell", "shell", "local_shell", "exec_command", "run_shell_command"],
  "@write": ["Write", "Edit", "MultiEdit", "NotebookEdit", "write_file", "replace", "apply_patch", "edit_file"],
};

const RANK: Record<OrderAction, number> = { warn: 1, ask: 2, deny: 3 };

export function ordersEnabled(env: { STANDING_ORDERS?: string }): boolean {
  return env.STANDING_ORDERS === "on";
}

// ---------------------------------------------------------------- validation

/**
 * Rejects patterns that can take very long on some inputs: backreferences,
 * lookarounds and a quantified group that itself holds a quantifier, like (a+)+.
 * A check runs inside the person's memory, so one slow pattern would hold it up.
 * Checks never run the built-in RegExp: patterns run on a linear-time matcher
 * (linear-regex.ts), so a pattern this test misses, such as (a|a)*$, is still fast.
 */
export function unsafePattern(source: string): string | null {
  if (source.length > VALUE_MAX) return `patterns are at most ${VALUE_MAX} characters`;
  if (/\\[1-9]|\\k</.test(source)) return "backreferences are not allowed";
  if (/\(\?<?[=!]/.test(source)) return "lookarounds are not allowed";
  // Strip escapes and character classes, then look for a quantifier inside a quantified group.
  const plain = source.replace(/\\./g, "x").replace(/\[[^\]]*\]/g, "x");
  const stack: boolean[] = [];
  for (let i = 0; i < plain.length; i++) {
    const ch = plain[i];
    if (ch === "(") stack.push(false);
    else if (ch === ")") {
      const inner = stack.pop() ?? false;
      const next = plain[i + 1];
      const quantified = next === "*" || next === "+" || next === "{" || next === "?";
      if (inner && quantified && next !== "?") return "a repeated group may not repeat inside (like (a+)+)";
      if (stack.length && (inner || quantified)) stack[stack.length - 1] = true;
    } else if ((ch === "*" || ch === "+" || ch === "{") && stack.length) stack[stack.length - 1] = true;
  }
  try {
    new RegExp(source);
  } catch {
    return "invalid regular expression";
  }
  try {
    linearRegex(source);
  } catch (e) {
    return e instanceof PatternError ? e.message : "invalid regular expression";
  }
  return null;
}

function bad(message: string): never {
  throw new Error(`order must be valid: ${message}`);
}

/** Checks an order from an untrusted caller and returns a clean copy. Throws "order must be valid: ...". */
export function parseRule(input: unknown): OrderRule {
  if (!input || typeof input !== "object") bad("an object with says, action and when");
  const r = input as Record<string, unknown>;
  const says = typeof r.says === "string" ? r.says.trim() : "";
  if (!says || says.length > SAYS_MAX) bad(`says is 1 to ${SAYS_MAX} characters`);
  const action = r.action ?? "deny";
  if (!ORDER_ACTIONS.includes(action as OrderAction)) bad(`action is one of ${ORDER_ACTIONS.join(", ")}`);
  if (!Array.isArray(r.when) || r.when.length === 0 || r.when.length > CLAUSE_LIMIT) bad(`when is a list of 1 to ${CLAUSE_LIMIT} clauses`);
  const when = r.when.map((c, i): OrderClause => {
    if (!c || typeof c !== "object") bad(`when[${i}] is an object`);
    const clause = c as Record<string, unknown>;
    const tool = typeof clause.tool === "string" ? clause.tool.trim() : "";
    if (!tool || tool.length > 200 || !/^[@A-Za-z0-9_*:.\-]+$/.test(tool)) bad(`when[${i}].tool is a tool name pattern such as Bash, mcp__*github*__issue_write or @shell`);
    if (tool.startsWith("@") && !TOOL_GROUPS[tool]) bad(`when[${i}].tool: groups are ${Object.keys(TOOL_GROUPS).join(", ")}`);
    const all = clause.all ?? [];
    if (!Array.isArray(all) || all.length > CONDITION_LIMIT) bad(`when[${i}].all is a list of at most ${CONDITION_LIMIT} conditions`);
    return { tool, all: all.map((x, j) => parseCondition(x, `when[${i}].all[${j}]`)) };
  });
  return { says, action: action as OrderAction, when };
}

function parseCondition(input: unknown, at: string): OrderCondition {
  if (!input || typeof input !== "object") bad(`${at} is an object`);
  const c = input as Record<string, unknown>;
  const path = typeof c.path === "string" ? c.path.trim() : "";
  if (!/^(text|file|tool_input(\.[A-Za-z0-9_-]{1,64}){0,4})$/.test(path)) bad(`${at}.path is text, file or tool_input.<field>`);
  if (!ORDER_OPS.includes(c.op as OrderOp)) bad(`${at}.op is one of ${ORDER_OPS.join(", ")}`);
  const op = c.op as OrderOp;
  if (op === "exists") return { path, op };
  if (op === "in") {
    if (!Array.isArray(c.value) || !c.value.length || c.value.length > 20 || c.value.some((v) => typeof v !== "string" || v.length > VALUE_MAX)) {
      bad(`${at}.value is a list of 1 to 20 strings`);
    }
    return { path, op, value: c.value as string[] };
  }
  if (typeof c.value !== "string" || !c.value || c.value.length > VALUE_MAX) bad(`${at}.value is 1 to ${VALUE_MAX} characters`);
  const value = c.value as string;
  if (op !== "regex") return { path, op, value };
  const problem = unsafePattern(value);
  if (problem) bad(`${at}.value: ${problem}`);
  const flags = c.flags === undefined ? "i" : c.flags;
  if (typeof flags !== "string" || !/^[ims]{0,3}$/.test(flags) || new Set(flags).size !== flags.length) bad(`${at}.flags is made of i, m and s`);
  return { path, op, value, flags };
}

// ---------------------------------------------------------------- evaluation

const globs = new Map<string, RegExp>();
function toolMatches(pattern: string, name: string): boolean {
  const group = TOOL_GROUPS[pattern];
  if (group) return group.includes(name);
  let re = globs.get(pattern);
  if (!re) {
    re = new RegExp("^" + pattern.split("*").map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
    if (globs.size > 2000) globs.clear();
    globs.set(pattern, re);
  }
  return re.test(name);
}

/** The text an order looks at, whatever the tool calls its payload. */
export function textOf(call: ToolCall): string {
  const t = call.tool_input ?? {};
  if (typeof t.command === "string") return t.command;
  if (Array.isArray(t.command) && t.command.every((p) => typeof p === "string")) return t.command.join(" ");
  const parts: string[] = [];
  if (typeof t.content === "string") parts.push(t.content);
  if (typeof t.new_string === "string") parts.push(t.new_string);
  if (typeof t.patch === "string") parts.push(t.patch);
  if (Array.isArray(t.edits)) for (const e of t.edits) if (typeof (e as { new_string?: unknown })?.new_string === "string") parts.push((e as { new_string: string }).new_string);
  if (parts.length) return parts.join("\n");
  return JSON.stringify(t);
}

function field(call: ToolCall, path: string): unknown {
  if (path === "text") return textOf(call);
  if (path === "file") return call.tool_input?.file_path ?? call.tool_input?.path ?? call.tool_input?.absolute_path;
  let cur: unknown = call;
  for (const key of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

const regexes = new Map<string, LinearRegex>();
function holds(call: ToolCall, cond: OrderCondition, budget: Budget): boolean {
  const raw = field(call, cond.path);
  if (cond.op === "exists") return raw !== undefined && raw !== null && raw !== "";
  if (raw === undefined || raw === null) return false;
  const value = (typeof raw === "string" ? raw : JSON.stringify(raw)).slice(0, MAX_TEXT);
  switch (cond.op) {
    case "eq":
      return value === String(cond.value);
    case "in":
      return (cond.value as string[]).includes(value);
    case "contains":
      return value.toLowerCase().includes(String(cond.value).toLowerCase());
    case "regex": {
      const key = `${cond.flags ?? "i"}/${cond.value}`;
      let re = regexes.get(key);
      if (!re) {
        re = linearRegex(String(cond.value), cond.flags ?? "i");
        if (regexes.size > 2000) regexes.clear();
        regexes.set(key, re);
      }
      if (budget.left <= 0) return false;
      try {
        return re.test(value, budget);
      } catch (e) {
        if (e instanceof BudgetError) return false;
        throw e;
      }
    }
    default:
      return false;
  }
}

/** The text an agent gets when an order stops or flags its call. */
export function reasonFor(order: Pick<Order, "id" | "says" | "said" | "action">): string {
  if (order.action === "warn") return `A standing order the person gave on ${order.said} applies to this call: "${order.says}" (rhizome order ${order.id}).`;
  return (
    `Stopped by a standing order the person gave on ${order.said}: "${order.says}" (rhizome order ${order.id}). ` +
    "This is their own rule, so do not look for another way to do the same thing. If you think it should not apply here, ask them."
  );
}

/** The strictest decision over all active orders that match the call, or null when none does. */
export function evaluate(orders: Order[], call: ToolCall, budget?: Budget): Decision | null {
  budget ??= { left: CHECK_BUDGET };
  let hit: Order | null = null;
  for (const order of orders) {
    if (order.state !== "active") continue;
    if (hit && RANK[order.action] <= RANK[hit.action]) continue;
    for (const clause of order.when) {
      if (!toolMatches(clause.tool, call.tool_name)) continue;
      if (!(clause.all ?? []).every((c) => holds(call, c, budget))) continue;
      hit = order;
      break;
    }
  }
  return hit ? { action: hit.action, order: hit.id, says: hit.says, reason: reasonFor(hit) } : null;
}

// ---------------------------------------------------------------- hook formats

/**
 * Reads one hook input into a tool call. Claude Code, Codex and Gemini CLI send
 * tool_name and tool_input. Cursor's beforeShellExecution sends only command, and
 * its beforeMCPExecution sends tool_input as a JSON string.
 */
export function callFromHook(input: unknown): ToolCall | null {
  if (!input || typeof input !== "object") return null;
  const h = input as Record<string, unknown>;
  if (typeof h.tool_name === "string" && h.tool_name) {
    let toolInput = h.tool_input;
    if (typeof toolInput === "string") {
      try {
        toolInput = JSON.parse(toolInput);
      } catch {
        toolInput = { value: toolInput };
      }
    }
    return { tool_name: h.tool_name.slice(0, 200), tool_input: toolInput && typeof toolInput === "object" ? (toolInput as Record<string, unknown>) : {} };
  }
  if (typeof h.command === "string") return { tool_name: "Shell", tool_input: { command: h.command } };
  return null;
}

/** Folder the agent works in, from the hook input. Used to find the project. */
export function cwdFromHook(input: unknown): string | null {
  if (!input || typeof input !== "object") return null;
  const h = input as Record<string, unknown>;
  if (typeof h.cwd === "string" && h.cwd) return h.cwd;
  if (Array.isArray(h.workspace_roots) && typeof h.workspace_roots[0] === "string") return h.workspace_roots[0];
  return null;
}

/** The last part of a path, lowercased, when it is a valid project slug. */
export function projectFromPath(path: string | null): string | null {
  if (!path) return null;
  const last = trimEndChars(path, "\\/").split(/[\\/]/).pop()?.toLowerCase() ?? "";
  return /^[a-z0-9][a-z0-9._-]{0,47}$/.test(last) ? last : null;
}

/**
 * The answer a harness expects from its pre-tool-call hook. An empty object lets
 * the call go on through the harness's usual permission flow; it never approves one.
 * Harnesses without "ask" (Codex, Cursor's preToolUse, Gemini CLI) get "deny", and
 * the reason tells the agent to ask the person.
 */
export function hookOutput(format: HookFormat, decision: Decision | null): Record<string, unknown> {
  if (!decision) return {};
  const asked = decision.action === "ask";
  const reason = asked && format !== "claude" ? `${decision.reason} Ask the person before you try this call again.` : decision.reason;
  if (decision.action === "warn") {
    if (format === "claude" || format === "codex") return { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: reason } };
    return {};
  }
  switch (format) {
    case "claude":
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: decision.action, permissionDecisionReason: reason } };
    case "codex":
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } };
    case "cursor":
      return { permission: "deny", agent_message: reason, user_message: `rhizome standing order: ${decision.says}` };
    case "gemini":
      return { decision: "deny", reason };
  }
}

/** A short block for the agent's standing context: the orders it should keep without being stopped. */
export function ordersText(orders: Order[]): string {
  const active = orders.filter((o) => o.state === "active");
  if (!active.length) return "";
  return ["Standing orders (the person's own rules, follow them):", ...active.map((o) => `- ${o.says} [${o.action}, ${o.id}]`)].join("\n");
}
