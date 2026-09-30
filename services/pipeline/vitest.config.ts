import { fileURLToPath } from "node:url";
import { defineProject } from "vitest/config";

const src = (pkg: string) =>
  fileURLToPath(new URL(`../../packages/${pkg}/src/index.ts`, import.meta.url));

export default defineProject({
  resolve: {
    alias: {
      // Tests run against workspace source, so they do not need a prior build of dist/.
      "@ai-it-support/ai": src("ai"),
      "@ai-it-support/db": src("db"),
      "@ai-it-support/shared": src("shared"),
    },
  },
  test: {
    name: "pipeline",
    include: ["src/**/*.test.ts"],
  },
});
