import { defineConfig } from "vitest/config";

// Integration tests that run the pinned Semgrep Docker image. Kept out of the
// root `pnpm test` run so it stays green without Docker.
export default defineConfig({
  test: {
    name: "shared-integration",
    include: ["integration/**/*.integration.test.ts"],
    // The image pull and the rule download can be slow on a cold machine.
    testTimeout: 300_000,
    fileParallelism: false,
    coverage: { enabled: false },
  },
});
