import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({ test: {
  environment: "node",
  include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
  // The retained positive dependency assertion reads its actual static source
  // graph from disk, so import-based related selection alone cannot discover it.
  forceRerunTriggers: [...configDefaults.forceRerunTriggers,
    "**/src/babylon/diagnostics/**", "**/src/babylon/sceneUpdates.ts", "**/src/readiness.ts"],
} });
