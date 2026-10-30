import { describe, expect, it } from "vitest";
import {
  effectiveTestOverrides,
  TestOverridesError,
  testOverridesSchema,
} from "./test-overrides.js";

const requested = { llmCallCap: 0, langfuseDown: true };

describe("effectiveTestOverrides", () => {
  it("returns the requested switches only when e2eMode and isTest are both true", () => {
    expect(effectiveTestOverrides({ e2eMode: true, isTest: true, requested })).toEqual(requested);
    expect(effectiveTestOverrides({ e2eMode: true, isTest: false, requested })).toEqual({});
    expect(effectiveTestOverrides({ e2eMode: false, isTest: true, requested })).toEqual({});
    expect(effectiveTestOverrides({ e2eMode: false, isTest: false, requested })).toEqual({});
  });

  it("returns {} for undefined and {}", () => {
    expect(effectiveTestOverrides({ e2eMode: true, isTest: true })).toEqual({});
    expect(effectiveTestOverrides({ e2eMode: true, isTest: true, requested: {} })).toEqual({});
  });

  it("throws a typed error for bad switches, also when the result is {}", () => {
    for (const bad of [
      { unknownSwitch: true },
      { llmCallCap: -1 },
      { llmCallCap: 100001 },
      { llmCallCap: 0.5 },
      { llmCallCap: "0" },
      { llmCallCap: null },
      { llmCallCap: Number.NaN },
      { langfuseDown: "yes" },
      [],
      null,
      "x",
    ]) {
      for (const [e2eMode, isTest] of [
        [true, true],
        [false, false],
      ] as const) {
        expect(() => effectiveTestOverrides({ e2eMode, isTest, requested: bad })).toThrow(
          TestOverridesError,
        );
      }
    }
  });

  it("accepts the bounds and 1e5", () => {
    expect(testOverridesSchema.parse({ llmCallCap: 1e5 })).toEqual({ llmCallCap: 100000 });
    expect(testOverridesSchema.parse({ llmCallCap: 0 })).toEqual({ llmCallCap: 0 });
  });

  it("does not leak the offending value in the error", () => {
    const secret = "s".repeat(12);
    try {
      effectiveTestOverrides({ e2eMode: true, isTest: true, requested: { [secret]: 1 } });
    } catch (error) {
      expect(String(error)).not.toContain(secret);
    }
  });
});

describe("reviewTimeout switch", () => {
  it("accepts whole minutes from 1m to 60m", () => {
    for (const value of ["1m", "30m", "60m"]) {
      expect(testOverridesSchema.parse({ reviewTimeout: value })).toEqual({ reviewTimeout: value });
    }
  });

  it.each(["2h", "0m", "61m", "99m", "05m", "30", "m", " 30m", 30])("rejects %j", (value) => {
    expect(testOverridesSchema.safeParse({ reviewTimeout: value }).success).toBe(false);
  });
});
