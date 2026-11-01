import { defineConfig } from "vite";

// Bundles the Electron main process to desktop/build/main.cjs; Electron supplies `electron` and Node's builtins.
export default defineConfig({
  ssr: { external: ["electron"] },
  build: {
    ssr: "desktop/main.ts",
    outDir: "desktop/build",
    emptyOutDir: true,
    target: "node22",
    minify: false,
    rollupOptions: { output: { format: "cjs", entryFileNames: "main.cjs" } },
  },
});
