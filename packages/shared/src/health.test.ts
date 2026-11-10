import { describe, expect, it } from "vitest";
import {
  HELPDESK_HEALTH_TASK_ID,
  healthConfigSchema,
  helpdeskHealthOutputSchema,
} from "./health.js";

const valid = {
  version: "1.0.0",
  features: {
    database: true,
    migration0003: false,
    migration0005: true,
    pipelineTrigger: true,
    turnstile: true,
    internalApi: true,
    e2eMode: false,
    slackInteractivity: true,
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

describe("helpdeskHealthOutputSchema", () => {
  const output = { connector: "servicenow", status: "ok", checkedAt: "2026-11-10T10:00:00.000Z" };

  it("names the scheduled task", () => {
    expect(HELPDESK_HEALTH_TASK_ID).toBe("helpdesk-health");
  });

  it.each(["ok", "asleep", "down"])("accepts status %s", (status) => {
    expect(helpdeskHealthOutputSchema.parse({ ...output, status })).toEqual({ ...output, status });
  });

  it.each(["", "OK", "up", 1, null])("rejects status %j", (status) => {
    expect(helpdeskHealthOutputSchema.safeParse({ ...output, status }).success).toBe(false);
  });

  it("rejects another connector, an invalid time and an extra key", () => {
    expect(helpdeskHealthOutputSchema.safeParse({ ...output, connector: "builtin" }).success).toBe(
      false,
    );
    expect(
      helpdeskHealthOutputSchema.safeParse({ ...output, checkedAt: "yesterday" }).success,
    ).toBe(false);
    expect(helpdeskHealthOutputSchema.safeParse({ ...output, error: "boom" }).success).toBe(false);
  });
});
