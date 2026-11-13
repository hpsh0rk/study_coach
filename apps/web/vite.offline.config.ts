import { createRequire } from "node:module";
import { build, defineConfig, type Plugin } from "vite";

const WIDGETS_REQ = createRequire(new URL("../../packages/widgets/package.json", import.meta.url));
const VIRTUAL_CHARTS_ENTRY = "virtual:kj-offline-charts";
const RESOLVED_CHARTS_ENTRY = "\0virtual:kj-offline-charts";

const ECHARTS_SHIMS: Record<string, string> = {
  "echarts/charts": "export const BarChart = 0, LineChart = 0, ScatterChart = 0;",
  "echarts/components": "export const GridComponent = 0, LegendComponent = 0;",
  "echarts/renderers": "export const SVGRenderer = 0;",
  "echarts/core":
    'export function use() {}\nexport function init(...args) {\n  const api = globalThis.__kjEcharts;\n  if (!api) throw new Error("Offline ECharts runtime not loaded");\n  return api.init(...args);\n}',
};

/** Fonts are added per deck by the exporter (only the unicode-range chunks it needs), so the runtime CSS ships none. */
function stripFontFaces(): Plugin {
  return {
    name: "kj-strip-font-faces",
    enforce: "post",
    generateBundle(_opts, bundle) {
      for (const file of Object.values(bundle)) {
        if (file.type === "asset" && file.fileName.endsWith(".css")) file.source = String(file.source).replace(/@font-face\s*\{[^}]*\}/g, "");
      }
    },
  };
}

/** Keeps ECharts (~512 KB) out of the base offline runtime; chart/function decks embed runtime-charts.js before runtime.js. */
function externalizeOfflineEcharts(): Plugin {
  return {
    name: "kj-externalize-offline-echarts",
    enforce: "pre",
    resolveId(id) {
      if (id in ECHARTS_SHIMS) return `\0kj-echarts-shim:${id}`;
      return null;
    },
    load(id) {
      if (id.startsWith("\0kj-echarts-shim:")) return ECHARTS_SHIMS[id.slice("\0kj-echarts-shim:".length)] ?? null;
      return null;
    },
  };
}

function offlineChartsEntry(): Plugin {
  return {
    name: "kj-offline-charts-entry",
    enforce: "pre",
    resolveId(id) {
      if (id === VIRTUAL_CHARTS_ENTRY || id.endsWith(`/${VIRTUAL_CHARTS_ENTRY}`)) return RESOLVED_CHARTS_ENTRY;
      if (id.startsWith("echarts/")) return WIDGETS_REQ.resolve(id);
      return null;
    },
    load(id) {
      if (id !== RESOLVED_CHARTS_ENTRY) return null;
      return [
        'import { BarChart, LineChart, ScatterChart } from "echarts/charts";',
        'import { GridComponent, LegendComponent } from "echarts/components";',
        'import * as echarts from "echarts/core";',
        'import { SVGRenderer } from "echarts/renderers";',
        "echarts.use([BarChart, LineChart, ScatterChart, GridComponent, LegendComponent, SVGRenderer]);",
        "globalThis.__kjEcharts = echarts;",
      ].join("\n");
    },
  };
}

function emitChartsBundle(): Plugin {
  return {
    name: "kj-emit-offline-charts-bundle",
    async closeBundle() {
      await build({
        configFile: false,
        publicDir: false,
        logLevel: "warn",
        plugins: [offlineChartsEntry()],
        define: { "process.env.NODE_ENV": JSON.stringify("production") },
        build: {
          outDir: "public/offline",
          emptyOutDir: false,
          assetsInlineLimit: 0,
          lib: { entry: VIRTUAL_CHARTS_ENTRY, formats: ["iife"], name: "KjOfflineCharts", fileName: () => "runtime-charts.js" },
        },
      });
    },
  };
}

/** The offline player runtime: slim core runtime.{js,css} + optional runtime-charts.js in public/offline/. */
export default defineConfig({
  plugins: [externalizeOfflineEcharts(), stripFontFaces(), emitChartsBundle()],
  publicDir: false,
  // Library mode leaves process.env.NODE_ENV in dependencies; a file:// page has no `process`.
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "public/offline",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    lib: { entry: "src/offline/runtime.ts", formats: ["iife"], name: "KjOffline", fileName: () => "runtime.js", cssFileName: "runtime" },
    rollupOptions: { output: { assetFileNames: (a) => (a.names?.[0]?.endsWith(".css") ? "runtime.css" : "unused/[name][extname]") } },
  },
});
