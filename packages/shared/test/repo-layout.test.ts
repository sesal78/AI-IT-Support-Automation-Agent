import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const allowedDirs = new Set([
  "apps",
  "services",
  "packages",
  "docs",
  "legacy",
  "supabase",
  ".github",
]);

// Root-level config files. Anything else at the root must be justified here.
const allowedFiles = new Set([
  ".gitignore",
  ".nvmrc",
  ".prettierrc.json",
  ".prettierignore",
  ".env.example",
  "README.md",
  "package.json",
  "pnpm-lock.yaml",
  "pnpm-workspace.yaml",
  "turbo.json",
  "tsconfig.base.json",
  "eslint.config.mjs",
  "vitest.config.ts",
]);

// Local-only or generated entries that are ignored by git, never tracked source.
const ignoredEntries = new Set([
  ".git",
  ".worktrees",
  ".loop-evidence",
  ".claude",
  "node_modules",
  ".turbo",
  "coverage",
]);

describe("repo layout", () => {
  it("only has allow-listed entries at the root", () => {
    const unexpected = readdirSync(repoRoot, { withFileTypes: true })
      .filter((entry) => !ignoredEntries.has(entry.name))
      .filter((entry) =>
        entry.isDirectory() ? !allowedDirs.has(entry.name) : !allowedFiles.has(entry.name),
      )
      .map((entry) => entry.name);

    expect(unexpected).toEqual([]);
  });

  it("keeps the old n8n build under legacy/", () => {
    expect(existsSync(join(repoRoot, "legacy/workflows/01-main-it-support-agent.json"))).toBe(true);
    expect(existsSync(join(repoRoot, "legacy/it_support_kb_library.json"))).toBe(true);
  });
});
