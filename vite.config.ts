/// <reference types="vitest/config" />
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { localFootage } from "./server/local-footage.ts";
import { pmatchTrainer } from "./server/pmatch-trainer.ts";

export default defineConfig({
  plugins: [react(), localFootage(), pmatchTrainer()],
  test: {
    globals: true,
    environment: "node",
    testTimeout: 120_000,
  },
});
