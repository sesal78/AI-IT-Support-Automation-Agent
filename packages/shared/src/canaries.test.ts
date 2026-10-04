import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildCanaries, canaryTicketText, findCanaries, type CanaryType } from "./index.js";

const RUN = "run0001";

// The oracle (plan §4.3). Every value is joined from fragments at run time, so
// this file holds no secret-shaped literal: only canaries.ts is allow-listed.
const EXPECTED: Array<[CanaryType, string]> = [
  ["ssn", ["078", "05", "1120"].join("-")],
  ["card", ["4111", "1111", "1111", "1111"].join(" ")],
  ["email", [`canary+${RUN}`, "example.com"].join("@")],
  ["phone", ["+61", "412", "345", "678"].join(" ")],
  ["ipv4", [203, 0, 113, 42].join(".")],
  ["ipv6", ["2001", "db8", "", "42"].join(":")],
  ["api_key", ["sk", "test", `CANARY${RUN}`].join("-")],
  ["aws_key", ["AKIA", "IOSFODNN7", "EXAMPLE"].join("")],
  ["github_token", ["ghp", `CANARY${RUN}`.padEnd(36, "0")].join("_")],
  ["password", ["Hunter2", `Canary${RUN}`].join("!")],
];
const TYPES = EXPECTED.map(([type]) => type);

const valueOf = (type: CanaryType) =>
  buildCanaries(RUN).find((canary) => canary.type === type)?.value ?? "";
const compact = (value: string) => value.replaceAll(" ", "");

describe("buildCanaries", () => {
  it("returns the 10 plan canaries, in order, with the run ID filled in", () => {
    expect(buildCanaries(RUN)).toEqual(EXPECTED.map(([type, value]) => ({ type, value })));
  });

  it("pads the GitHub token to 36 characters after the prefix for every run ID length", () => {
    for (const runId of ["abcd", "abcdefghijkl"]) {
      const token = buildCanaries(runId).find((canary) => canary.type === "github_token")?.value;
      expect(token).toMatch(new RegExp(`^ghp_CANARY${runId}0+$`));
      expect(token).toHaveLength(40);
    }
  });

  it.each([
    ["an empty run ID", ""],
    ["a run ID with a space and upper case", "A B"],
    ["a run ID longer than 12 characters", "abcdefghijklm"],
    ["a run ID shorter than 4 characters", "abc"],
    ["an upper-case run ID", "RUN0001"],
  ])("throws a TypeError that names runId for %s", (_label, runId) => {
    expect(() => buildCanaries(runId)).toThrow(TypeError);
    expect(() => buildCanaries(runId)).toThrow(/runId/);
  });

  it("does not echo a rejected run ID in the error", () => {
    expect(() => buildCanaries("Not A Run")).not.toThrow(/Not A Run/);
  });
});

describe("canaryTicketText", () => {
  it("contains every canary value and fits a ticket description", () => {
    const text = canaryTicketText(RUN);
    for (const { value } of buildCanaries(RUN)) expect(text).toContain(value);
    expect(text.length).toBeGreaterThanOrEqual(10);
    expect(text.length).toBeLessThanOrEqual(5000);
  });

  it("carries the password on its own `Password:` line", () => {
    expect(canaryTicketText(RUN).split("\n")).toContain(`Password: ${valueOf("password")}`);
  });

  it("throws a TypeError that names runId for an invalid run ID", () => {
    expect(() => canaryTicketText("")).toThrow(TypeError);
    expect(() => canaryTicketText("")).toThrow(/runId/);
  });
});

describe("findCanaries", () => {
  it("finds all 10 types, once each, in the canary ticket text", () => {
    expect(findCanaries(canaryTicketText(RUN), RUN)).toEqual(
      TYPES.map((type) => ({ type, count: 1 })),
    );
  });

  it.each(["printer is jammed", ""])("returns [] for the clean text %j", (text) => {
    expect(findCanaries(text, RUN)).toEqual([]);
  });

  it("finds the card and the phone with the separators removed", () => {
    const text = `card ${compact(valueOf("card"))} phone ${compact(valueOf("phone"))}`;
    expect(findCanaries(text, RUN)).toEqual([
      { type: "card", count: 1 },
      { type: "phone", count: 1 },
    ]);
  });

  it("counts every occurrence, spaced or compact", () => {
    const card = valueOf("card");
    expect(findCanaries(`${card} / ${compact(card)} / ${card}`, RUN)).toEqual([
      { type: "card", count: 3 },
    ]);
  });

  it("does not report another run's run-unique canaries", () => {
    const found = findCanaries(canaryTicketText("run0002"), RUN).map((hit) => hit.type);
    expect(found).toEqual(["ssn", "card", "phone", "ipv4", "ipv6", "aws_key"]);
  });

  it("returns types and counts only, never a canary value", () => {
    const hits = findCanaries(canaryTicketText(RUN), RUN);
    for (const hit of hits) expect(Object.keys(hit).sort()).toEqual(["count", "type"]);
    const serialised = JSON.stringify(hits);
    for (const { value } of buildCanaries(RUN)) expect(serialised).not.toContain(value);
  });

  it("throws a TypeError that names runId for an invalid run ID", () => {
    expect(() => findCanaries("printer is jammed", "A B")).toThrow(TypeError);
    expect(() => findCanaries("printer is jammed", "A B")).toThrow(/runId/);
  });

  it("throws a TypeError that names text when the text is not a string", () => {
    // A missing sink body must never read as "no canaries found".
    expect(() => findCanaries(undefined as unknown as string, RUN)).toThrow(TypeError);
    expect(() => findCanaries(undefined as unknown as string, RUN)).toThrow(/text/);
  });
});

describe("canaries.test.ts", () => {
  it("holds no canary value as a literal", () => {
    const source = readFileSync(fileURLToPath(import.meta.url), "utf8");
    for (const { value } of buildCanaries(RUN)) {
      expect(source).not.toContain(value);
      expect(source).not.toContain(compact(value));
    }
  });
});
