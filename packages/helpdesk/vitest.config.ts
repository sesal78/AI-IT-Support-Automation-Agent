import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "helpdesk",
    include: ["src/**/*.test.ts", "test/**/*.test.ts"],
  },
});
