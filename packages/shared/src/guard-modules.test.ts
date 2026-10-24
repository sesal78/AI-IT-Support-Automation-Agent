import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  coverageThresholds,
  GuardModulesError,
  missingGuardModules,
  parseGuardModules,
} from "./guard-modules.js";

const redact = { path: "packages/shared/src/redact.ts", statements: 90, mutation: null };
const request = { path: "apps/web/src/lib/intake/request.ts", statements: 95, mutation: 80 };

describe("parseGuardModules", () => {
  it("returns a valid list, floors at the minimum included", () => {
    expect(parseGuardModules([redact, request])).toEqual([redact, request]);
  });

  it("keeps an optional list of test files that kill a module's mutants", () => {
    const withTests = { ...request, tests: ["apps/web/src/app/api/tickets/route.test.ts"] };
    expect(parseGuardModules([redact, withTests])).toEqual([redact, withTests]);
  });

  it("keeps related: false, which scopes the mutation run to the module's own tests", () => {
    const scoped = { ...redact, mutation: 80, related: false };
    expect(parseGuardModules([scoped, request])).toEqual([scoped, request]);
  });

  it("accepts floors of 100", () => {
    const full = { ...redact, statements: 100, mutation: 100 };
    expect(parseGuardModules([full, request])).toEqual([full, request]);
  });

  it("accepts an empty list", () => {
    expect(parseGuardModules([])).toEqual([]);
  });

  it.each([
    ["statements below 90", { ...redact, statements: 89.9 }, "statements"],
    ["mutation below 80", { ...redact, mutation: 79.9 }, "mutation"],
    ["statements above 100", { ...redact, statements: 101 }, "statements"],
    ["mutation above 100", { ...redact, mutation: 101 }, "mutation"],
    // Whole numbers, so only the minimum can reject them.
    ["whole statements below 90", { ...redact, statements: 89 }, "statements"],
    ["whole mutation below 80", { ...redact, mutation: 79 }, "mutation"],
    ["a fractional statements floor", { ...redact, statements: 90.5 }, "statements"],
    ["a fractional mutation floor", { ...redact, mutation: 80.5 }, "mutation"],
    ["tests that are not a list", { ...redact, tests: "a/b.test.ts" }, "tests"],
    ["an empty tests list", { ...redact, tests: [] }, "tests"],
    ["a test that is not a test file", { ...redact, tests: ["a/b.ts"] }, "tests: 0"],
    ["a test with a back-slash", { ...redact, tests: ["a\\b.test.ts"] }, "tests: 0"],
    ["a test glob", { ...redact, tests: ["a/*.test.ts"] }, "tests: 0"],
    ["a repeated test", { ...redact, tests: ["a/b.test.ts", "a/b.test.ts"] }, "duplicate test"],
    ["related: true (the default is left out)", { ...redact, related: true }, "related"],
    ["a missing mutation floor", { path: redact.path, statements: 90 }, "mutation"],
    ["an unknown key", { ...redact, lines: 90 }, '"lines"'],
    ["a duplicate path", { ...redact, statements: 95 }, "duplicate path"],
  ])("rejects %s, naming the path", (_case, entry, detail) => {
    const parse = () => parseGuardModules([redact, request, entry]);
    expect(parse).toThrow(GuardModulesError);
    expect(parse).toThrow(`${redact.path}: `);
    expect(parse).toThrow(detail);
  });

  // Vitest reads a threshold key as a glob on the root-relative path and skips
  // a key that matches no file, so only a plain forward-slash path is safe. A
  // path with no folder could also replace a global key such as `statements`.
  it.each([
    "apps\\web\\src\\lib\\intake\\request.ts",
    "./packages/shared/src/redact.ts",
    "/packages/shared/src/redact.ts",
    "packages/shared/../shared/src/redact.ts",
    "packages/shared/src/*.ts",
    "apps/web/src/app/[id]/route.ts",
    "statements",
  ])('rejects the path "%s", naming it', (path) => {
    const parse = () => parseGuardModules([{ ...request, path }]);
    expect(parse).toThrow(GuardModulesError);
    expect(parse).toThrow(`${path}: path: `);
  });

  it("rejects a document that is not a list", () => {
    const parse = () => parseGuardModules({ modules: [redact] });
    expect(parse).toThrow(GuardModulesError);
    expect(parse).toThrow("(root): ");
  });

  it("names an entry by its position when it has no path", () => {
    expect(() => parseGuardModules([redact, { statements: 90, mutation: null }])).toThrow(
      "entry 1: path: ",
    );
  });
});

describe("coverageThresholds", () => {
  it("returns one key per entry, equal to its path, with the statements floor", () => {
    expect(coverageThresholds([redact, request])).toEqual({
      [redact.path]: { statements: 90 },
      [request.path]: { statements: 95 },
    });
  });

  it("adds no key for an empty list", () => {
    expect(coverageThresholds([])).toEqual({});
  });

  // no failure-path test: the list is the typed output of parseGuardModules,
  // which rejects every invalid entry before it gets here.
});

describe("missingGuardModules", () => {
  const root = mkdtempSync(join(tmpdir(), "guard-modules-"));
  mkdirSync(join(root, "packages/shared/src"), { recursive: true });
  writeFileSync(join(root, "packages/shared/src/redact.ts"), "");
  writeFileSync(join(root, "packages/shared/src/redact.test.ts"), "");
  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });
  const entry = (path: string, tests?: string[]) => ({
    path,
    statements: 90,
    mutation: null,
    ...(tests && { tests }),
  });

  it("reports nothing for a file and test that exist with the listed case", () => {
    const list = [entry("packages/shared/src/redact.ts", ["packages/shared/src/redact.test.ts"])];
    expect(missingGuardModules(list, root)).toEqual([]);
  });

  // A case-insensitive file system (Windows, macOS) finds these, but no
  // coverage key matches them, so the per-file floor would be skipped.
  it.each([
    "packages/shared/src/REDACT.ts",
    "packages/Shared/src/redact.ts",
    "Packages/shared/src/redact.ts",
  ])("reports the wrong-case path %s", (path) => {
    expect(missingGuardModules([entry(path)], root)).toEqual([path]);
  });

  it("reports a wrong-case test file", () => {
    const tests = ["packages/shared/src/Redact.test.ts"];
    expect(missingGuardModules([entry("packages/shared/src/redact.ts", tests)], root)).toEqual(
      tests,
    );
  });

  it("reports a missing file, a folder, and a path through a file", () => {
    const paths = [
      "packages/shared/src/no-such.ts",
      "packages/shared/src",
      "packages/shared/src/redact.ts/x.ts",
      "packages/no-such/src/x.ts",
    ];
    expect(
      missingGuardModules(
        paths.map((path) => entry(path)),
        root,
      ),
    ).toEqual(paths);
  });
});
