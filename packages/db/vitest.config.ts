import { defineProject } from "vitest/config";

// Unit tests only. Docker-backed tests live in integration/ and run through
// vitest.integration.config.ts (`pnpm test:integration`).
export default defineProject({
  test: {
    name: "db",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  },
});
