import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/baselines/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000
  }
});
