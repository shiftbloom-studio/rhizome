// SPDX-License-Identifier: AGPL-3.0-or-later
// Bundles the benchmark runner (bench/run.ts) into dist/bench/run.mjs.
// The Worker's "cloudflare:workers" import is replaced by the Node stand-in.
import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
  entryPoints: ["bench/run.ts"],
  outfile: "dist/bench/run.mjs",
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node26",
  sourcemap: true,
  alias: { "cloudflare:workers": fileURLToPath(new URL("../src/node/cloudflare-workers.ts", import.meta.url)) },
  logLevel: "warning",
});
