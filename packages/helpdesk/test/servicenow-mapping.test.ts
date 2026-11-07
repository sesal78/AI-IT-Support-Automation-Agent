import { describe, expect, it } from "vitest";
import {
  CLOSE_CODE,
  CLOSE_NOTES,
  toImpactUrgency,
  toServiceNowCategory,
  toServiceNowState,
} from "../src/index.js";

const CATEGORIES = ["database", "inquiry", "software", "hardware", "password_reset", "network"];

// T5.U.01
describe("T5.U.01 ServiceNow mapping", () => {
  it.each(CATEGORIES)("toServiceNowCategory returns %s unchanged", (category) => {
    expect(toServiceNowCategory(category)).toBe(category);
  });

  it.each(["Hardware", "", "other", " hardware", "__proto__", "toString"])(
    "toServiceNowCategory(%j) throws a TypeError that does not echo the value",
    (value) => {
      let error: unknown;
      try {
        toServiceNowCategory(value);
      } catch (caught) {
        error = caught;
      }
      expect(error).toBeInstanceOf(TypeError);
      if (value !== "") expect((error as Error).message).not.toContain(value);
    },
  );

  it.each([undefined, null, 4, {}])("toServiceNowCategory rejects the non-string %j", (value) => {
    expect(() => toServiceNowCategory(value)).toThrow(TypeError);
  });

  it.each([
    ["P1", 1, 1],
    ["P2", 1, 2],
    ["P3", 2, 2],
    ["P4", 2, 3],
  ])("toImpactUrgency(%s) is impact %i, urgency %i", (priority, impact, urgency) => {
    expect(toImpactUrgency(priority)).toEqual({ impact, urgency });
  });

  it.each(["P5", "p1", "", "toString", undefined])("toImpactUrgency rejects %j", (value) => {
    expect(() => toImpactUrgency(value)).toThrow(TypeError);
  });

  it("toServiceNowState maps the five states", () => {
    expect(toServiceNowState("new")).toEqual({ state: 1 });
    expect(toServiceNowState("in_progress")).toEqual({ state: 2 });
    expect(toServiceNowState("on_hold")).toEqual({ state: 3, hold_reason: 1 });
    expect(toServiceNowState("resolved")).toEqual({
      state: 6,
      close_code: "Closed/Resolved by Caller",
      close_notes: CLOSE_NOTES,
    });
    expect(toServiceNowState("closed")).toEqual({
      state: 7,
      close_code: CLOSE_CODE,
      close_notes: CLOSE_NOTES,
    });
  });

  it("toServiceNowState rejects an unknown state", () => {
    expect(() => toServiceNowState("deleted" as never)).toThrow(TypeError);
  });
});
