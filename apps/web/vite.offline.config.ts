import { defineConfig, type Plugin } from "vite";

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

/** The offline player runtime (player + slide templates + widgets) as one IIFE + one CSS file in public/offline/. */
export default defineConfig({
  plugins: [stripFontFaces()],
  publicDir: false,
  build: {
    outDir: "public/offline",
    emptyOutDir: true,
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    lib: { entry: "src/offline/runtime.ts", formats: ["iife"], name: "KjOffline", fileName: () => "runtime.js", cssFileName: "runtime" },
    rollupOptions: { output: { assetFileNames: (a) => (a.names?.[0]?.endsWith(".css") ? "runtime.css" : "unused/[name][extname]") } },
  },
});
