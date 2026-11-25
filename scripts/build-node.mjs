// SPDX-License-Identifier: AGPL-3.0-or-later
// Bundles the Node server (src/node/server.ts) into dist/node/server.mjs.
// The Worker's "cloudflare:workers" import is replaced by a small stand-in.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
  entryPoints: ["src/node/server.ts"],
  outfile: "dist/node/server.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
  sourcemap: true,
  alias: { "cloudflare:workers": fileURLToPath(new URL("../src/node/cloudflare-workers.ts", import.meta.url)) },
  banner: { js: "// rhizome for Node. SPDX-License-Identifier: AGPL-3.0-or-later. Source: https://github.com/shiftbloom-studio/rhizome" },
  logLevel: "info",
});
