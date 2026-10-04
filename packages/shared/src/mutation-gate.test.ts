import { describe, expect, it } from "vitest";
import { checkMutationReport, guardFilesTouched, MutationReportError } from "./mutation-gate.js";

const redact = { path: "packages/shared/src/redact.ts", statements: 90, mutation: null };
const request = { path: "apps/web/src/lib/intake/request.ts", statements: 90, mutation: 80 };
const list = [redact, request];

/** A Stryker JSON report with one file whose mutants have the given statuses. */
function report(path: string, counts: Record<string, number>) {
  const mutants = Object.entries(counts).flatMap(([status, n]) =>
    Array.from({ length: n }, (_, i) => ({ id: `${status}${String(i)}`, status })),
  );
  return {
    schemaVersion: "1.0",
    thresholds: { high: 80, low: 60 },
    files: { [path]: { mutants } },
  };
}

describe("guardFilesTouched", () => {
  it.each([
    [[], false],
    [["README.md"], false],
    [["apps/web/src/lib/intake/request.ts"], true],
    [["packages/shared/src/redact.ts"], false],
    [["guard-modules.json"], true],
    [["apps\\web\\src\\lib\\intake\\request.ts"], true],
    [["README.md", "packages/shared/scripts/mutation-gate.mjs"], true],
  ])("%j is %s", (changed, expected) => {
    expect(guardFilesTouched(changed, list)).toBe(expected);
  });
});

describe("checkMutationReport", () => {
  it("passes 8 killed and 2 survived at floor 80", () => {
    const [check] = checkMutationReport(report(request.path, { Killed: 8, Survived: 2 }), list);
    expect(check).toMatchObject({ path: request.path, score: 80, passed: true });
  });

  it("fails 7 killed and 3 survived, naming the file and 70", () => {
    const [check] = checkMutationReport(report(request.path, { Killed: 7, Survived: 3 }), list);
    expect(check?.passed).toBe(false);
    expect(check?.message).toContain(request.path);
    expect(check?.message).toContain("70");
  });

  it.each([
    ["a timeout counts as killed", { Killed: 7, Timeout: 1, Survived: 2 }, 80],
    ["no coverage counts as survived", { Killed: 7, Survived: 1, NoCoverage: 2 }, 70],
    [
      "ignored and invalid mutants are left out",
      { Killed: 4, Survived: 1, Ignored: 3, CompileError: 2, RuntimeError: 1 },
      80,
    ],
  ])("%s", (_case, counts, score) => {
    expect(checkMutationReport(report(request.path, counts), list)).toMatchObject([{ score }]);
  });

  it("checks only modules with a floor", () => {
    expect(checkMutationReport(report(redact.path, { Survived: 5 }), [redact])).toEqual([]);
  });

  it.each([
    ["missing from the report", report(redact.path, { Killed: 5 })],
    ["with only left-out mutants", report(request.path, { Ignored: 2, CompileError: 1 })],
  ])("fails a floored module %s with 'no mutants reported'", (_case, input) => {
    const [check] = checkMutationReport(input, list);
    expect(check).toMatchObject({ passed: false, score: null });
    expect(check?.message).toBe(`${request.path}: no mutants reported`);
  });

  it.each([
    ["null", null],
    ["an empty object", {}],
    ["a report without schemaVersion", { files: {} }],
    ["a mutant with an unknown status", report(request.path, { Exploded: 1 })],
  ])("throws a MutationReportError for %s", (_case, input) => {
    expect(() => checkMutationReport(input, list)).toThrow(MutationReportError);
  });
});
