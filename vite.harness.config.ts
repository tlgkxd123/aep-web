import { defineConfig } from "vite";

// Bundles the renderer test harness into one script for scripts/pixel-report.ts; AEP_HARNESS_DIR gives runs in
// parallel folders of their own.
export default defineConfig({
  build: {
    outDir: process.env.AEP_HARNESS_DIR ?? "dist-harness",
    emptyOutDir: true,
    minify: false,
    lib: { entry: "src/render/harness.ts", name: "AepHarness", formats: ["iife"], fileName: () => "harness.js" },
  },
});
