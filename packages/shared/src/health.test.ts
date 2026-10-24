import { describe, expect, it } from "vitest";
import { healthConfigSchema } from "./health.js";

const valid = {
  version: "1.0.0",
  features: {
    database: true,
    migration0003: false,
    pipelineTrigger: true,
    turnstile: true,
    internalApi: true,
    e2eMode: false,
  },
};

describe("healthConfigSchema", () => {
  it("accepts a complete body", () => {
    expect(healthConfigSchema.parse(valid)).toEqual(valid);
  });

  it("rejects an extra top-level key", () => {
    expect(healthConfigSchema.safeParse({ ...valid, error: "boom" }).success).toBe(false);
  });

  it("rejects an extra feature key", () => {
    const body = { ...valid, features: { ...valid.features, secret: true } };
    expect(healthConfigSchema.safeParse(body).success).toBe(false);
  });

  it("rejects a missing feature", () => {
    const features: Partial<typeof valid.features> = { ...valid.features };
    delete features.database;
    expect(healthConfigSchema.safeParse({ ...valid, features }).success).toBe(false);
  });

  it.each(["true", 1, null, "marker-value"])("rejects a non-boolean feature value %j", (value) => {
    const body = { ...valid, features: { ...valid.features, database: value } };
    expect(healthConfigSchema.safeParse(body).success).toBe(false);
  });

  it("rejects a non-string version", () => {
    expect(healthConfigSchema.safeParse({ ...valid, version: 1 }).success).toBe(false);
  });
});
