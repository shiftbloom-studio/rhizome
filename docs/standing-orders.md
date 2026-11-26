# Standing orders

A standing order is a rule you gave your agents once, such as "never close GitHub
issues" or "a force-push needs my approval", kept in rhizome as data. Every agent
that loads its context sees the active orders, and an agent's harness can ask
rhizome before each tool call whether an order stops it.

Standing orders are off by default. Turn them on with `STANDING_ORDERS=on`
(a Worker variable in `wrangler.jsonc`, or in `.env` on Node). While they are off,
rhizome behaves exactly as without them: no extra MCP tools, nothing added to
`get_context`, and the endpoints below answer 404.

## What rhizome does and what it doesn't

rhizome stores the orders, lists them for agents and answers a check for one tool
call. It does not sit between an agent and its tools. A call is only stopped where
the agent's harness runs a pre-tool-call hook that asks rhizome and honours the
answer:

| Harness | Hook | rhizome's answer |
| --- | --- | --- |
| Claude Code | `PreToolUse`, as an `http` hook or the command hook below | `deny`, `ask` or a warning as context |
| Codex | `PreToolUse` command hook | `deny` (Codex has no `ask`, so `ask` becomes `deny` and the agent is told to ask you) |
| Cursor | `preToolUse` or `beforeShellExecution` command hook | `deny` (`ask` becomes `deny`) |
| Gemini CLI | `BeforeTool` command hook | `deny` (`ask` becomes `deny`) |

Without a hook, for example in a chat app, an order is a written rule in the
agent's context like any other memory, and the agent may still break it. The
hooks are optional adapters; each harness's hook format can change, so check its
documentation when one stops working.

The check matches patterns, not intent. It stops the calls an order describes and
lets through what it doesn't: a command written another way, or the same action
through a tool the order doesn't name, goes through. Write orders for the ways
your agents actually do things, and keep tool permissions in the harness for what
must never happen.

## An order

```json
{
  "says": "Never close GitHub issues. Report what should be closed instead.",
  "action": "deny",
  "when": [
    { "tool": "mcp__*github*__issue_write", "all": [{ "path": "tool_input.state", "op": "eq", "value": "closed" }] },
    { "tool": "@shell", "all": [{ "path": "text", "op": "regex", "value": "\\bgh\\s+issue\\s+close\\b" }] }
  ]
}
```

* `says`: the rule in your words. Agents see it, and it is the reason they get when a call is stopped.
* `action`: `deny` stops the call, `ask` has you confirm it (where the harness can ask), `warn` lets it run and reminds the agent.
* `when`: the order applies when any clause matches. A clause names a `tool` and lists conditions that must `all` hold.
  * `tool` is a tool name with `*` wildcards (`Bash`, `mcp__*github*__issue_write`), or a group: `@shell` (the shell tool of every harness) or `@write` (their file-writing tools).
  * `path` is `text` (a shell command, or the content a tool writes), `file` (the path written to) or `tool_input.<field>`.
  * `op` is `eq`, `in`, `contains` (case-insensitive), `regex` (case-insensitive unless `flags` says otherwise) or `exists`.

Orders can only restrict: there is no `allow`, so a wrong order can stop a call but
never let one through. Patterns that can run for a very long time (a repeated group
inside a repeated group, backreferences, lookarounds) are refused, and a check reads
at most the first 20,000 characters of a call. There are at most 100 orders.

Patterns do not run on JavaScript's `RegExp`. rhizome runs them on its own matcher,
whose time grows with the length of the text and never backtracks
([`src/linear-regex.ts`](../src/linear-regex.ts)). It understands the usual syntax:
literals, `.`, character classes, `\d` `\w` `\s` and their negations, `\b`, `^`, `$`,
groups, `|`, and `*` `+` `?` `{n,m}` (counts up to 100). One check has a fixed amount
of pattern work; if a set of very large patterns uses it up, the rest of the
patterns count as not matching and the call goes on.

An order is in the profile (every project) or in one project. A check looks at the
profile's orders plus the project's: the `project` you pass, or else the name of the
folder the agent works in.

## Who can change orders

* An agent stores an order with the MCP tool `add_standing_order` or `POST /v1/memory/orders`. With `said_by_user: true` (REST: `saidByUser`), meaning you gave the rule in your own words, it is checked right away. Otherwise it waits as **proposed** until you activate it. rhizome cannot verify `said_by_user`: the agent sets it. Because orders only restrict, the worst an agent can do with it is stop calls (its own or other agents'), and you can disable the order in the explorer.
* Only you activate, disable or delete an order, in the memory explorer. No agent can turn off a rule it is held to.

Each stopped or flagged call is recorded as a strike: the order, the connector, the
tool name, the session and the time, never the call's input. Strikes are kept for 90
days and shown in the explorer next to each order.

## MCP

With standing orders on, the MCP server has three more tools:

| Tool | What it does |
| --- | --- |
| `standing_orders` | Lists the active orders for the profile and, with `project`, one project |
| `check_tool_call` | Checks a call (`tool_name`, `tool_input`) the agent is about to make: `deny`, `ask`, `warn` or `ok` |
| `add_standing_order` | Stores an order (`says`, `action`, `when`, `project`, `said_by_user`) |

`get_context` ends with the active orders.

## REST

| Method and path | What it does |
| --- | --- |
| `GET /v1/memory/orders?project=` | The orders for the profile and the project, with an `ETag` |
| `POST /v1/memory/orders` | Stores an order: `says`, `action`, `when`, optional `project` and `saidByUser` |
| `POST /v1/memory/orders/check?format=&project=` | The hook endpoint. The body is the hook's own input; the answer is in the harness's format: `claude` (default), `codex`, `cursor` or `gemini`. An empty object means no order applies |

All three need an API key of the agent's connector.

## Hooks

Each hook needs an API key of the agent's connector. Use a key with the default
grants or one that can read the profile and your projects.

### Claude Code, as an HTTP hook

In `~/.claude/settings.json` (all projects) or a project's `.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "http",
            "url": "https://memory.example.com/v1/memory/orders/check",
            "headers": { "Authorization": "Bearer $RHIZOME_API_KEY" },
            "allowedEnvVars": ["RHIZOME_API_KEY"],
            "timeout": 5
          }
        ]
      }
    ]
  }
}
```

If rhizome cannot be reached, the call goes on (Claude Code treats a failed HTTP
hook as non-blocking).

### Command hook for every harness

[`hooks/rhizome-orders.mjs`](../hooks/rhizome-orders.mjs) is a small Node script
without dependencies. It sends the hook input to the check endpoint and prints the
answer. Set `RHIZOME_URL`, `RHIZOME_API_KEY` and `RHIZOME_HOOK_FORMAT`; optional are
`RHIZOME_PROJECT`, `RHIZOME_TIMEOUT_MS` (default 3000) and `RHIZOME_FAIL_CLOSED=1`,
which stops calls while rhizome cannot be asked. By default it fails open.

Codex, `~/.codex/hooks.json` (Codex asks you to trust a new hook once):

```json
{
  "hooks": {
    "PreToolUse": [
      { "hooks": [{ "type": "command", "command": "RHIZOME_HOOK_FORMAT=codex node /path/to/rhizome/hooks/rhizome-orders.mjs" }] }
    ]
  }
}
```

Cursor, `~/.cursor/hooks.json`:

```json
{
  "version": 1,
  "hooks": {
    "preToolUse": [{ "command": "RHIZOME_HOOK_FORMAT=cursor node /path/to/rhizome/hooks/rhizome-orders.mjs", "timeout": 5 }],
    "beforeShellExecution": [{ "command": "RHIZOME_HOOK_FORMAT=cursor node /path/to/rhizome/hooks/rhizome-orders.mjs", "timeout": 5 }]
  }
}
```

Gemini CLI, `~/.gemini/settings.json`:

```json
{
  "hooks": {
    "BeforeTool": [
      {
        "matcher": "*",
        "hooks": [{ "type": "command", "command": "RHIZOME_HOOK_FORMAT=gemini node /path/to/rhizome/hooks/rhizome-orders.mjs", "timeout": 5000 }]
      }
    ]
  }
}
```

Tool names differ between harnesses: Claude Code calls MCP tools
`mcp__<server>__<tool>`, Gemini CLI `mcp_<server>_<tool>` and Cursor `MCP:<tool>`.
Use wildcards or one clause per harness when an order is about an MCP tool. The
`@shell` and `@write` groups already cover the built-in tools of all four.

The HTTP hook above was run in Claude Code 2.1.332 against rhizome on Node: the
blocked command did not run and the agent quoted the order instead of working
around it. The Codex, Cursor and Gemini CLI answers follow their documentation and
were not run against those harnesses.
