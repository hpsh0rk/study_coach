import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const VENDOR_CHUNKS: Record<string, RegExp> = {
  echarts: /node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?(echarts|zrender)\//,
  pdfjs: /node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?pdfjs-dist\//,
  katex: /node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?katex\//,
};

export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        manualChunks(id) {
          for (const [name, re] of Object.entries(VENDOR_CHUNKS)) if (re.test(id)) return name;
          return undefined;
        },
      },
    },
  },
  server: {
    // `pnpm --filter @kj/web dev` for fast UI iteration against a running `wrangler dev`.
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});
