// SPDX-License-Identifier: AGPL-3.0-or-later
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true, chunkSizeWarningLimit: 1500, sourcemap: false },
  server: { proxy: { "/ui/api": "http://localhost:8787", "/fonts": "http://localhost:8787", "/favicon.svg": "http://localhost:8787" } },
});
