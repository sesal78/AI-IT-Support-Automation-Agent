import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "ai",
    include: ["src/**/*.test.ts"],
  },
});
