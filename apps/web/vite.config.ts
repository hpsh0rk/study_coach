import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1500,
  },
  server: {
    // `pnpm --filter @kj/web dev` for fast UI iteration against a running `wrangler dev`.
    proxy: {
      "/api": { target: "http://127.0.0.1:8787", ws: true },
      "/sim": "http://127.0.0.1:8787",
    },
  },
});
