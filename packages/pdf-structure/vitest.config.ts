import { defineConfig } from "vitest/config";

// The browser entry runs under Node in tests; pdf.js ships a legacy build for runtimes without the newest built-ins.
export default defineConfig({
  resolve: { alias: [{ find: /^pdfjs-dist$/, replacement: "pdfjs-dist/legacy/build/pdf.mjs" }] },
});
