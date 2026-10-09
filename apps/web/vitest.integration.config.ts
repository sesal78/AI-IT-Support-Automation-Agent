import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const here = (path: string) => fileURLToPath(new URL(path, import.meta.url));

// The internal API route handlers run against the local REST stack (Docker),
// with the egress recorder on. Kept out of the unit run (`pnpm test`).
export default defineConfig({
  resolve: {
    alias: {
      "@": here("./src"),
      "@ai-it-support/shared": here("../../packages/shared/src/index.ts"),
      "@ai-it-support/db": here("../../packages/db/src/index.ts"),
    },
  },
  test: {
    name: "web-integration",
    environment: "node",
    include: ["integration/**/*.integration.test.ts"],
    // Starts the recorder at the top level of the setup file and runs the PII
    // clean check after every test. Shared with the pipeline integration run.
    setupFiles: [here("../../services/pipeline/test-support/egress-setup.ts")],
    testTimeout: 60_000,
    hookTimeout: 240_000,
    fileParallelism: false,
    coverage: { enabled: false },
  },
});
