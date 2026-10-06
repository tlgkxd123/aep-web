import { defineConfig } from "vite";

// Bundles the renderer test harness into one script for scripts/pixel-report.ts.
export default defineConfig({
  build: {
    outDir: "dist-harness",
    emptyOutDir: true,
    minify: false,
    lib: { entry: "src/render/harness.ts", name: "AepHarness", formats: ["iife"], fileName: () => "harness.js" },
  },
});
