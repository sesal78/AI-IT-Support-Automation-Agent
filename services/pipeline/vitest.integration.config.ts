import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const src = (pkg: string) =>
  fileURLToPath(new URL(`../../packages/${pkg}/src/index.ts`, import.meta.url));

// Every integration test file starts the egress recorder (setup file) and gets
// the PII clean check after each test. Kept out of the root `pnpm test` run.
export const setupFiles = ["./test-support/egress-setup.ts"];

export default defineConfig({
  resolve: {
    alias: {
      // Tests run against workspace source, so they do not need a prior build of dist/.
      "@ai-it-support/ai": src("ai"),
      "@ai-it-support/db": src("db"),
      "@ai-it-support/shared": src("shared"),
      "@ai-it-support/slack": src("slack"),
    },
  },
  test: {
    name: "pipeline-integration",
    include: ["integration/**/*.integration.test.ts"],
    setupFiles,
    testTimeout: 60_000,
    fileParallelism: false,
    coverage: { enabled: false },
  },
});
