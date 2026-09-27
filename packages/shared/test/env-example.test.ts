import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseEnv, phase1EnvShape } from "../src/env.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const example = readFileSync(resolve(repoRoot, ".env.example"), "utf8");

// KEY=value lines only; comments and blank lines are ignored.
const entries = example
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line !== "" && !line.startsWith("#"))
  .map((line) => {
    const eq = line.indexOf("=");
    return [line.slice(0, eq), line.slice(eq + 1)] as const;
  });

describe(".env.example", () => {
  it("has exactly the keys of the env schemas", () => {
    const keys = entries.map(([key]) => key).sort();
    expect(keys).toEqual(Object.keys(phase1EnvShape).sort());
  });

  it("contains only short placeholder values", () => {
    for (const [key, value] of entries) {
      expect(value.length, key).toBeLessThanOrEqual(40);
    }
  });

  it("contains nothing that looks like a real secret", () => {
    expect(example).not.toMatch(/(^|[^A-Za-z0-9])(sk-|eyJ|xoxb-)/);
  });

  it("parses against the schema", () => {
    expect(() => parseEnv(phase1EnvShape, Object.fromEntries(entries))).not.toThrow();
  });
});
