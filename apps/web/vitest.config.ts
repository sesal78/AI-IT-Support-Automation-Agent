import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

export default defineProject({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      // Tests run against shared source, so they do not need a prior build of dist/.
      "@ai-it-support/shared": fileURLToPath(
        new URL("../../packages/shared/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    name: "web",
    environment: "node",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
