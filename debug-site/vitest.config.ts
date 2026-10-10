import { defineConfig } from "vitest/config";

// The installed debug-site preflight still invokes this suite; it is empty by policy.
export default defineConfig({
  test: { include: ["src/**/*.test.ts"], passWithNoTests: true },
});
