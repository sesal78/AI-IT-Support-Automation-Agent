import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Integration tests against throwaway local supabase/postgres (+ PostgREST)
// containers. Kept out of the root `pnpm test` run so it stays green without Docker.
export default defineConfig({
  resolve: {
    alias: {
      // Tests run against shared source, so they do not need a prior build of dist/.
      "@ai-it-support/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  test: {
    name: "db-integration",
    include: ["integration/**/*.integration.test.ts"],
    // Container pull + start can be slow on a cold machine.
    hookTimeout: 300_000,
    testTimeout: 60_000,
    fileParallelism: false,
    coverage: { enabled: false },
  },
});
