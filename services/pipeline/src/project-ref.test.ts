import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { resolveProjectRef } from "./project-ref.js";

const MAIN_REF = "proj_sefqgwbhymcyikibqjmo";
const E2E_REF = "proj_vfnbcjuxsprwbkuzjrlc";

describe("resolveProjectRef", () => {
  it("returns the main project when TRIGGER_PROJECT_REF is unset", () => {
    expect(resolveProjectRef({})).toBe(MAIN_REF);
  });

  it("returns TRIGGER_PROJECT_REF when it is set", () => {
    expect(resolveProjectRef({ TRIGGER_PROJECT_REF: E2E_REF })).toBe(E2E_REF);
  });

  it("treats an empty TRIGGER_PROJECT_REF as unset", () => {
    expect(resolveProjectRef({ TRIGGER_PROJECT_REF: "" })).toBe(MAIN_REF);
  });

  it.each(["my project", "PROJ_ABC", "proj_", "proj_abc-1"])(
    'rejects TRIGGER_PROJECT_REF="%s", naming the variable',
    (value) => {
      expect(() => resolveProjectRef({ TRIGGER_PROJECT_REF: value })).toThrow(
        /TRIGGER_PROJECT_REF/,
      );
    },
  );

  it("does not echo the invalid value in the error", () => {
    expect(() => resolveProjectRef({ TRIGGER_PROJECT_REF: "my project" })).not.toThrow(
      /my project/,
    );
  });

  // The trigger CLI's config loader (jiti) fails on @ai-it-support/shared: see project-ref.ts.
  it("has no imports, so the trigger CLI can load trigger.config.ts", () => {
    const source = readFileSync(new URL("./project-ref.ts", import.meta.url), "utf8");
    expect(source).not.toMatch(/^\s*import\s|\brequire\(/m);
  });
});
