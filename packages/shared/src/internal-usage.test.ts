import { describe, expect, it } from "vitest";
import { internalSecurityEventsSchema, internalUsageSchema } from "./internal-usage.js";

const totals = { calls: 12, tokensIn: 100, tokensOut: 50, costUsd: null };
const usage = { month: "2026-10", llm: totals, typesafe: { ...totals, costUsd: 1.5 } };
const event = {
  source: "internal_api",
  kind: "bad_token",
  windowStart: "2026-10-01T10:00:00.000Z",
  count: 2,
};

describe("internalUsageSchema", () => {
  it("accepts a month with null and numeric costs", () => {
    expect(internalUsageSchema.parse(usage)).toEqual(usage);
  });
  it.each(["2026-13", "26-10", "2026-1", "2026-10-01"])("rejects month %s", (month) => {
    expect(internalUsageSchema.safeParse({ ...usage, month }).success).toBe(false);
  });
  it("rejects extra keys and negative counts", () => {
    expect(internalUsageSchema.safeParse({ ...usage, extra: 1 }).success).toBe(false);
    expect(internalUsageSchema.safeParse({ ...usage, llm: { ...totals, calls: -1 } }).success).toBe(
      false,
    );
    expect(internalUsageSchema.safeParse({ ...usage, llm: { ...totals, x: 1 } }).success).toBe(
      false,
    );
  });
});

describe("internalSecurityEventsSchema", () => {
  it("accepts events and an empty list", () => {
    expect(internalSecurityEventsSchema.parse({ events: [event] })).toEqual({ events: [event] });
    expect(internalSecurityEventsSchema.parse({ events: [] })).toEqual({ events: [] });
  });
  it("rejects a sample key and a zero count", () => {
    expect(
      internalSecurityEventsSchema.safeParse({ events: [{ ...event, sample: {} }] }).success,
    ).toBe(false);
    expect(
      internalSecurityEventsSchema.safeParse({ events: [{ ...event, count: 0 }] }).success,
    ).toBe(false);
  });
});
