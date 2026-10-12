/** Module boundaries for the core slice (docs/architecture.md). Run with `pnpm lint:deps`. */
const BROWSER_ONLY = "^(packages/(templates|widgets)/src/render|packages/player|packages/pdf-structure/src/browser\\.ts|apps/web)|node_modules/(react|react-dom|react-router|echarts|zrender|katex|pdfjs-dist)/";
const MODEL_CALLERS = "^packages/(planner|writer)/";

module.exports = {
  forbidden: [
    { name: "no-circular", severity: "error", from: {}, to: { circular: true } },
    {
      name: "schema-is-a-leaf",
      comment: "@kj/schema holds types and zod schemas only.",
      severity: "error",
      from: { path: "^packages/schema/" },
      to: { path: "^(packages|apps)/", pathNot: "^packages/schema/" },
    },
    {
      name: "packages-never-import-apps",
      severity: "error",
      from: { path: "^packages/" },
      to: { path: "^apps/" },
    },
    {
      name: "server-code-is-dom-free",
      comment: "The Worker, model callers and rules must not pull in DOM renderers, the player, pdf.js or React.",
      severity: "error",
      from: { path: "^(apps/app|packages/(ai|planner|writer|pedagogy|schema)|packages/(templates|widgets|pdf-structure)/src/(?!render|browser))" },
      to: { path: BROWSER_ONLY },
    },
    {
      name: "model-calls-stay-on-the-server",
      comment: "The browser never imports the AI layer, planner or writer.",
      severity: "error",
      from: { path: "^(apps/web|packages/player)" },
      to: { path: "^packages/(ai|planner|writer)/" },
    },
    {
      name: "only-the-server-and-evals-orchestrate",
      comment: "Planner and writer are called by the Worker routes and the eval runner, nobody else.",
      severity: "error",
      from: { path: "^packages/", pathNot: MODEL_CALLERS },
      to: { path: MODEL_CALLERS },
    },
    {
      name: "planner-and-writer-are-independent",
      severity: "error",
      from: { path: "^packages/planner/" },
      to: { path: "^packages/writer/" },
    },
    {
      name: "writer-does-not-plan",
      severity: "error",
      from: { path: "^packages/writer/" },
      to: { path: "^packages/planner/" },
    },
    {
      name: "ai-layer-is-generic",
      comment: "packages/ai knows nothing about lessons, templates or pedagogy.",
      severity: "error",
      from: { path: "^packages/ai/" },
      to: { path: "^packages/", pathNot: "^packages/(ai|schema)/" },
    },
    {
      name: "pedagogy-has-no-io",
      severity: "error",
      from: { path: "^packages/pedagogy/" },
      to: { path: "^packages/(ai|planner|writer|player|pdf-structure)/" },
    },
  ],
  options: {
    doNotFollow: { path: "node_modules" },
    exclude: { path: "(^|/)(dist|\\.wrangler|test-results|playwright-report)/" },
    tsPreCompilationDeps: true,
    tsConfig: { fileName: "tsconfig.base.json" },
    enhancedResolveOptions: { exportsFields: ["exports"], conditionNames: ["import", "default", "types"], extensions: [".ts", ".tsx", ".js", ".mjs"] },
    combinedDependencies: true,
  },
};
