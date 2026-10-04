import { readFileSync } from "node:fs";
import { defineConfig } from "vitest/config";
import { coverageThresholds, parseGuardModules } from "./packages/shared/src/guard-modules.js";

// Local-only folders that are never tracked source. Patterns are relative to
// the repo root, so a clone that itself lives inside a `.worktrees/` folder
// is not excluded by accident.
const localOnly = [".worktrees/**", ".loop-evidence/**", "**/node_modules/**"];

// Guard modules and their floors. An invalid list fails the run at load.
const guardModules = parseGuardModules(
  JSON.parse(readFileSync(new URL("./guard-modules.json", import.meta.url), "utf8")),
);

export default defineConfig({
  test: {
    projects: ["apps/*", "services/*", "packages/*"],
    exclude: localOnly,
    coverage: {
      enabled: true,
      provider: "v8",
      include: ["apps/*/src/**/*.{ts,tsx}", "services/*/src/**/*.ts", "packages/*/src/**/*.ts"],
      exclude: [...localOnly, "**/*.test.{ts,tsx}", "**/*.d.ts"],
      reporter: ["text", "json-summary"],
      // Coverage floor from docs/PROJECT.md §9: only ever raised, never lowered.
      thresholds: {
        // One per-file statements floor for each guard module. The global
        // floor below still counts every file, guard modules included.
        ...coverageThresholds(guardModules),
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
