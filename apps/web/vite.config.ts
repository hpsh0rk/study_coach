import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const VENDOR_CHUNKS: Record<string, RegExp> = {
  echarts: /node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?(echarts|zrender)\//,
  pdfjs: /node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?pdfjs-dist\//,
  katex: /node_modules\/(\.pnpm\/[^/]+\/node_modules\/)?katex\//,
};

const PDFJS_DIR = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));
const PDFJS_ASSET_DIRS = ["cmaps", "standard_fonts"];

/** Serves pdfjs-dist's CMaps and standard fonts at /pdfjs/ (dev) and copies them into the build. */
function pdfjsAssets(): Plugin {
  return {
    name: "kj-pdfjs-assets",
    configureServer(server) {
      server.middlewares.use("/pdfjs/", (req, res, next) => {
        const [dir, file, ...rest] = decodeURIComponent((req.url ?? "").split("?")[0]!).replace(/^\/+/, "").split("/");
        if (!dir || !file || rest.length || !PDFJS_ASSET_DIRS.includes(dir) || file.startsWith(".")) return next();
        try {
          res.end(readFileSync(join(PDFJS_DIR, dir, file)));
        } catch {
          next();
        }
      });
    },
    generateBundle() {
      for (const dir of PDFJS_ASSET_DIRS) {
        for (const file of readdirSync(join(PDFJS_DIR, dir))) this.emitFile({ type: "asset", fileName: `pdfjs/${dir}/${file}`, source: readFileSync(join(PDFJS_DIR, dir, file)) });
      }
    },
  };
}

export default defineConfig(({ command }) => ({
  plugins: [react(), pdfjsAssets()],
  // /dev/gallery and /dev/render are public tools for tests and evals: production builds leave them out.
  define: { __KJ_DEV_PAGES__: JSON.stringify(command === "serve" || process.env.KJ_DEV_PAGES === "1") },
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
}));
