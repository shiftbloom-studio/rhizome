// SPDX-License-Identifier: AGPL-3.0-or-later
// Fills the <PLACEHOLDERS> in wrangler.jsonc from environment variables (or a local .env.deploy file)
// and writes wrangler.deploy.jsonc. Keeps installation-specific values out of the repository.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const KEYS = {
  RHIZOME_HOSTNAME: "Hostname of the API, e.g. memory.example.com",
  RHIZOME_D1_DATABASE_ID: "ID of the rhizome-control D1 database (wrangler d1 list)",
};

const env = { ...process.env };
if (existsSync(".env.deploy")) {
  for (const line of readFileSync(".env.deploy", "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !(m[1] in process.env)) env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

const missing = Object.keys(KEYS).filter((k) => !env[k]);
if (missing.length) {
  console.error("Missing deploy settings:\n" + missing.map((k) => `  ${k}: ${KEYS[k]}`).join("\n"));
  console.error("Set them as environment variables (Workers Builds: Settings > Build > Variables) or in .env.deploy.");
  process.exit(1);
}

let config = readFileSync("wrangler.jsonc", "utf8");
for (const k of Object.keys(KEYS)) config = config.replaceAll(`<${k}>`, JSON.stringify(env[k]).slice(1, -1));
const left = config.replace(/^\s*\/\/.*$/gm, "").match(/<[A-Z0-9_]+>/);
if (left) {
  console.error(`Unfilled placeholder ${left[0]} in wrangler.jsonc`);
  process.exit(1);
}
writeFileSync("wrangler.deploy.jsonc", config);
console.log("wrote wrangler.deploy.jsonc");
