import { describe, expect, it } from "vitest";
import { coverageThresholds, GuardModulesError, parseGuardModules } from "./guard-modules.js";

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

  it("accepts an empty list", () => {
    expect(parseGuardModules([])).toEqual([]);
  });

  it.each([
    ["statements below 90", { ...redact, statements: 89.9 }, "statements"],
    ["mutation below 80", { ...redact, mutation: 79.9 }, "mutation"],
    ["a fractional statements floor", { ...redact, statements: 90.5 }, "statements"],
    ["a fractional mutation floor", { ...redact, mutation: 80.5 }, "mutation"],
    ["tests that are not a list", { ...redact, tests: "a/b.test.ts" }, "tests"],
    ["an empty tests list", { ...redact, tests: [] }, "tests"],
    ["a test that is not a test file", { ...redact, tests: ["a/b.ts"] }, "tests: 0"],
    ["a test with a back-slash", { ...redact, tests: ["a\\b.test.ts"] }, "tests: 0"],
    ["a test glob", { ...redact, tests: ["a/*.test.ts"] }, "tests: 0"],
    ["a repeated test", { ...redact, tests: ["a/b.test.ts", "a/b.test.ts"] }, "duplicate test"],
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
