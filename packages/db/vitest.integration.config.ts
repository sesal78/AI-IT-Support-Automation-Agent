import { defineConfig } from "vitest/config";

// Integration tests against a throwaway local supabase/postgres container.
// Kept out of the root `pnpm test` run so it stays green without Docker.
export default defineConfig({
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
