/**
 * The boundaries tsc and package.json cannot see (docs/architecture.md §2). Package-to-package edges are governed
 * by each package.json: an undeclared workspace import fails tsc. Run with `pnpm lint:deps`.
 */
const BROWSER_ONLY = "^(packages/(templates|widgets)/src/render|packages/player|packages/textbook/src/browser\\.ts|apps/web)|node_modules/(react|react-dom|react-router|echarts|zrender|katex|pdfjs-dist)/";

module.exports = {
  forbidden: [
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
    {
      name: "server-code-is-dom-free",
      comment: "The Worker, model callers and rules must not pull in DOM renderers, the player, pdf.js or React.",
      severity: "error",
      from: { path: "^(apps/app|packages/(ai|generation|pedagogy|schema)|packages/(templates|widgets|textbook)/src/(?!render|browser))" },
      to: { path: BROWSER_ONLY },
    },
    {
      name: "model-calls-stay-on-the-server",
      comment: "The browser never imports the AI layer or the generation pipeline.",
      severity: "error",
      from: { path: "^(apps/web|packages/player)" },
      to: { path: "^packages/(ai|generation)/" },
    },
    {
      name: "product-code-never-imports-tools",
      comment: "tools/eval (ablation driver, renderer) lives outside the product.",
      severity: "error",
      from: { path: "^(apps|packages)/" },
      to: { path: "^tools/" },
    },
    {
      name: "ai-layer-is-generic",
      comment: "packages/ai knows nothing about lessons, templates or pedagogy.",
      severity: "error",
      from: { path: "^packages/ai/" },
      to: { path: "^packages/", pathNot: "^packages/(ai|schema)/" },
    },
    {
      name: "textbook-tables-are-private",
      comment: "documents / pages / chapters are read and written only inside apps/app/src/textbook; db/schema.ts imports them for the lessons foreign key only.",
      severity: "error",
      from: { path: "^apps/app/src/", pathNot: "^apps/app/src/(textbook/|db/schema\\.ts$)" },
      to: { path: "^apps/app/src/textbook/tables\\.ts$" },
    },
    {
      name: "only-textbook-ingest-loads-pdfjs",
      comment: "In the web app only the textbook ingest (apps/web/src/textbook) loads pdf.js.",
      severity: "error",
      from: { path: "^apps/web/src/", pathNot: "^apps/web/src/textbook/" },
      to: { path: "^packages/textbook/src/browser\\.ts$|node_modules/pdfjs-dist/|^pdfjs-dist" },
    },
    {
      name: "only-textbook-ingest-cuts-pdfs",
      comment: "Cutting sub-PDFs (pdf-lib) happens in apps/web/src/textbook only.",
      severity: "error",
      from: { path: "^apps/web/src/", pathNot: "^apps/web/src/textbook/" },
      to: { path: "node_modules/pdf-lib/|^pdf-lib$" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)(dist|\\.next|\\.wrangler|test-results|playwright-report)/|^apps/web/public/offline/" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "default", "types"], extensions: [".ts", ".tsx", ".js", ".mjs"] },
    combinedDependencies: true,
  },
};
