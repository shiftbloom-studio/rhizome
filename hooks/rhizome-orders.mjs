#!/usr/bin/env node
// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Pre-tool-call hook that asks rhizome whether a standing order stops the call.
// Works as a command hook in Claude Code, Codex, Cursor and Gemini CLI. Node 26,
// no dependencies. See docs/standing-orders.md.
//
//   RHIZOME_URL           base URL of your rhizome, e.g. https://memory.example.com
//   RHIZOME_API_KEY       an API key of this agent's connector
//   RHIZOME_HOOK_FORMAT   claude (default), codex, cursor or gemini
//   RHIZOME_PROJECT       optional: project slug; default is the working folder's name
//   RHIZOME_TIMEOUT_MS    optional: default 3000
//   RHIZOME_FAIL_CLOSED   optional: 1 stops the call when rhizome cannot be asked
//
// Fails open by default: when rhizome is unreachable, slow or answers with an
// error, the call goes on through the harness's usual permission flow.

const env = process.env;
const format = env.RHIZOME_HOOK_FORMAT || "claude";
const failClosed = env.RHIZOME_FAIL_CLOSED === "1";

function giveUp(message) {
  process.stderr.write(`[rhizome-orders] ${message}\n`);
  // Exit code 2 blocks the call in all four harnesses; 0 with no output lets it go on.
  process.exit(failClosed ? 2 : 0);
}

let raw = "";
for await (const chunk of process.stdin) raw += chunk;

if (!env.RHIZOME_URL || !env.RHIZOME_API_KEY) giveUp("set RHIZOME_URL and RHIZOME_API_KEY");

const url = new URL("/v1/memory/orders/check", env.RHIZOME_URL);
url.searchParams.set("format", format);
if (env.RHIZOME_PROJECT) url.searchParams.set("project", env.RHIZOME_PROJECT);

let res;
try {
  res = await fetch(url, {
    method: "POST",
    headers: { authorization: `Bearer ${env.RHIZOME_API_KEY}`, "content-type": "application/json" },
    body: raw || "{}",
    signal: AbortSignal.timeout(Number(env.RHIZOME_TIMEOUT_MS) || 3000),
  });
} catch (e) {
  giveUp(`cannot reach rhizome: ${e instanceof Error ? e.message : e}`);
}
if (!res.ok) giveUp(`rhizome answered ${res.status}`);

const body = await res.text();
let answer;
try {
  answer = JSON.parse(body);
} catch {
  giveUp("rhizome sent no JSON");
}
// An empty answer means no order applies: print nothing, so the harness goes on as usual.
if (answer && typeof answer === "object" && Object.keys(answer).length) process.stdout.write(JSON.stringify(answer));
process.exit(0);
