import { defineConfig } from "vitest/config";

// Local-only folders that are never tracked source. Patterns are relative to
// the repo root, so a clone that itself lives inside a `.worktrees/` folder
// is not excluded by accident.
const localOnly = [".worktrees/**", ".loop-evidence/**", "**/node_modules/**"];

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
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
