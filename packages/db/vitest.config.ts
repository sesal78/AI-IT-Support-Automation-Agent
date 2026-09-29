import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

// Unit tests only. Docker-backed tests live in integration/ and run through
// vitest.integration.config.ts (`pnpm test:integration`).
export default defineProject({
  resolve: {
    alias: {
      // Tests run against shared source, so they do not need a prior build of dist/.
      "@ai-it-support/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  test: {
    name: "db",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  },
});
