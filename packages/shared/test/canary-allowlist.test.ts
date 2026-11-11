import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "smol-toml";
import { describe, expect, it } from "vitest";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const read = (file: string) => readFileSync(resolve(repoRoot, file), "utf8");

// The one file that may hold secret-shaped canary values (plan §4.3, §9).
const canaryPath = "packages/shared/src/canaries.ts";

describe(".gitleaks.toml", () => {
  const config = parse(read(".gitleaks.toml"));

  // toEqual is exact: an extra table (rules, a second allow-list, regexes,
  // commits, stopwords, disabledRules) fails this test.
  it("extends the default rules and has exactly one allow-list with one path pattern", () => {
    expect(config).toEqual({
      extend: { useDefault: true },
      allowlists: [{ description: expect.any(String), paths: [expect.any(String)] }],
    });
  });

  it("allow-lists the canary fixture path and nothing near it", () => {
    const { allowlists } = config as { allowlists: Array<{ paths: string[] }> };
    // "(?!)" matches nothing, so a missing pattern fails the first check below.
    const pattern = new RegExp(allowlists[0]?.paths[0] ?? "(?!)");

    expect(pattern.test(canaryPath)).toBe(true);
    for (const other of [
      "packages/shared/src/redact.ts",
      "packages/shared/src/canaries.test.ts",
      "packages/shared/src/canaries.tsx",
      "packages/shared/src/canariesXts",
      "packages/shared/src/more/canaries.ts",
      "apps/web/packages/shared/src/canaries.ts",
      "canaries.ts",
    ]) {
      expect(pattern.test(other), other).toBe(false);
    }
  });
});

describe(".semgrepignore", () => {
  it("lists the canary fixture path, once", () => {
    const lines = read(".semgrepignore").split(/\r?\n/);
    expect(lines.filter((line) => line.includes("canaries"))).toEqual([canaryPath]);
  });
});

describe(".gitleaksignore", () => {
  it("ignores only Seun's approved historical synthetic-marker fingerprint", () => {
    const entries = read(".gitleaksignore")
      .split(/\r?\n/)
      .filter((line) => line && !line.startsWith("#"));
    expect(entries).toEqual([
      "e043ed9d30b0c4338b361f1be9cca90a5e3e4811:packages/helpdesk/src/builtin.test.ts:generic-api-key:12",
    ]);
  });
});
