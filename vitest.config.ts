// SPDX-License-Identifier: AGPL-3.0-or-later
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "cloudflare:workers": fileURLToPath(new URL("./test/support/cloudflare-workers.ts", import.meta.url)) } },
  test: { include: ["test/**/*.test.ts"] },
});
