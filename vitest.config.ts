import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Keep the suite output readable; the logger is exercised directly instead.
    env: { LOG_LEVEL: "error" },
    // A verification turn is bounded well below the Arena's five-minute ceiling;
    // no test should ever need longer than this.
    testTimeout: 30_000,
  },
});
