import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Integration tests against a throwaway local postgres + PostgREST stack (the
// harness lives in packages/db/integration). Kept out of `pnpm test`, which
// stays green without Docker.
export default defineConfig({
  resolve: {
    alias: {
      // Tests run against shared source, so they do not need a prior build of dist/.
      "@ai-it-support/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  test: {
    name: "helpdesk-integration",
    include: ["integration/**/*.integration.test.ts"],
    // Container pull + start can be slow on a cold machine.
    hookTimeout: 300_000,
    testTimeout: 60_000,
    fileParallelism: false,
    coverage: { enabled: false },
  },
});
