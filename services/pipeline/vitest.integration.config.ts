import { defineConfig } from "vitest/config";

// Every integration test file starts the egress recorder (setup file) and gets
// the PII clean check after each test. Kept out of the root `pnpm test` run.
export const setupFiles = ["./test-support/egress-setup.ts"];

export default defineConfig({
  test: {
    name: "pipeline-integration",
    include: ["integration/**/*.integration.test.ts"],
    setupFiles,
    testTimeout: 60_000,
    fileParallelism: false,
    coverage: { enabled: false },
  },
});
