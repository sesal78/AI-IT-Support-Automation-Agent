import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

export default defineProject({
  resolve: {
    alias: {
      // Tests run against shared source, so they do not need a prior build of dist/.
      "@ai-it-support/shared": fileURLToPath(new URL("../shared/src/index.ts", import.meta.url)),
    },
  },
  test: {
    name: "ai",
    include: ["src/**/*.test.ts"],
  },
});
