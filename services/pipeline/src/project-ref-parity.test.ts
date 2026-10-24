import { readFileSync } from "node:fs";
import { parseEnv, triggerProjectEnvShape } from "@ai-it-support/shared";
import { describe, expect, it } from "vitest";
import { resolveProjectRef } from "./project-ref.js";

// The project-ref rule lives in two copies on purpose (the Trigger.dev CLI config
// loader cannot load @ai-it-support/shared). This table keeps them in step.
const VALUES: ReadonlyArray<readonly [string, boolean]> = [
  ["proj_sefqgwbhymcyikibqjmo", true],
  ["proj_vfnbcjuxsprwbkuzjrlc", true],
  ["proj_abc", true],
  ["proj_abc123", true],
  ["proj_a", true],
  ["proj_0", true],
  ["proj_123", true],
  ["proj_ABC", false],
  ["proj_abC", false],
  ["PROJ_abc", false],
  ["xproj_abc", false],
  ["proj_abc-1", false],
  ["proj_abc_1", false],
  ["proj_abc.def", false],
  ["proj__abc", false],
  ["proj_", false],
  ["proj", false],
  ["abc", false],
  ["my project", false],
  [" proj_abc", false],
  ["proj_abc ", false],
  ["proj_abc\n", false],
  ["\nproj_abc", false],
  ["proj_abc\nproj_def", false],
  ["proj_abc\r\n", false],
  ["proj_ab c", false],
  ["proj_\u00e9", false],
  ["   ", false],
  ["\t", false],
];

function pipelineAccepts(value: string): boolean {
  try {
    resolveProjectRef({ TRIGGER_PROJECT_REF: value });
    return true;
  } catch {
    return false;
  }
}

function sharedAccepts(value: string): boolean {
  try {
    parseEnv(triggerProjectEnvShape, { TRIGGER_PROJECT_REF: value });
    return true;
  } catch {
    return false;
  }
}

describe("project-ref rule parity", () => {
  it("has at least 20 values", () => {
    expect(VALUES.length).toBeGreaterThanOrEqual(20);
  });

  it.each(VALUES)("accepts or rejects %j the same in both copies (accept=%s)", (value, ok) => {
    expect(pipelineAccepts(value)).toBe(ok);
    expect(sharedAccepts(value)).toBe(ok);
  });

  it("treats a whitespace-only value as invalid in both copies, not as unset", () => {
    expect(() => resolveProjectRef({ TRIGGER_PROJECT_REF: "   " })).toThrow(/TRIGGER_PROJECT_REF/);
    expect(() => parseEnv(triggerProjectEnvShape, { TRIGGER_PROJECT_REF: "   " })).toThrow(
      /TRIGGER_PROJECT_REF/,
    );
  });

  it("treats empty as unset in both copies", () => {
    expect(resolveProjectRef({ TRIGGER_PROJECT_REF: "" })).toBe(resolveProjectRef({}));
    expect(
      parseEnv(triggerProjectEnvShape, { TRIGGER_PROJECT_REF: "" }).TRIGGER_PROJECT_REF,
    ).toBeUndefined();
  });
});

describe(".env.example", () => {
  it("sets TRIGGER_PROJECT_REF to exactly the main project ref", () => {
    const example = readFileSync(new URL("../../../.env.example", import.meta.url), "utf8");
    const match = /^TRIGGER_PROJECT_REF=(.*)$/m.exec(example);
    expect(match?.[1]?.replace(/\r$/, "")).toBe("proj_sefqgwbhymcyikibqjmo");
  });
});
