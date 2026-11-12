import { describe, expect, it } from "vitest";
import {
  HELPDESK_HEALTH_TASK_ID,
  healthConfigSchema,
  helpdeskHealthOutputSchema,
} from "./health.js";

const valid = {
  version: "1.0.0",
  helpdesk: "builtin",
  features: {
    database: true,
    migration0003: false,
    migration0005: true,
    migration0006: true,
    pipelineTrigger: true,
    turnstile: true,
    internalApi: true,
    e2eMode: false,
    slackInteractivity: true,
    helpdeskReachable: true,
    helpdeskAsleep: false,
    builtinHelpdesk: true,
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

  it.each(["true", 1, null])("rejects a missing or non-boolean migration0006 (%j)", (value) => {
    const features: Partial<typeof valid.features> = { ...valid.features };
    delete features.migration0006;
    expect(healthConfigSchema.safeParse({ ...valid, features }).success).toBe(false);
    const body = { ...valid, features: { ...valid.features, migration0006: value } };
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

  it.each(["helpdeskReachable", "helpdeskAsleep"] as const)("rejects a missing %s", (name) => {
    const features: Partial<typeof valid.features> = { ...valid.features };
    delete features[name];
    expect(healthConfigSchema.safeParse({ ...valid, features }).success).toBe(false);
  });

  it.each(["helpdeskReachable", "helpdeskAsleep"] as const)("rejects a non-boolean %s", (name) => {
    for (const value of ["true", 1, null, "INC0010001", { host: "x.service-now.com" }]) {
      const body = { ...valid, features: { ...valid.features, [name]: value } };
      expect(healthConfigSchema.safeParse(body).success).toBe(false);
    }
  });

  it.each(["servicenow", "builtin"])("accepts the configured helpdesk %s", (helpdesk) => {
    expect(healthConfigSchema.parse({ ...valid, helpdesk }).helpdesk).toBe(helpdesk);
  });

  it.each(["jira", "ServiceNow", "", true, null, "https://x.service-now.com"])(
    "rejects the helpdesk value %j, and a missing one",
    (helpdesk) => {
      expect(healthConfigSchema.safeParse({ ...valid, helpdesk }).success).toBe(false);
    },
  );

  it("requires helpdesk at the top level and builtinHelpdesk as a boolean feature", () => {
    const withoutHelpdesk: Partial<typeof valid> = { ...valid };
    delete withoutHelpdesk.helpdesk;
    expect(healthConfigSchema.safeParse(withoutHelpdesk).success).toBe(false);
    const features: Partial<typeof valid.features> = { ...valid.features };
    delete features.builtinHelpdesk;
    expect(healthConfigSchema.safeParse({ ...valid, features }).success).toBe(false);
    for (const value of ["true", "builtin", 1, null]) {
      const body = { ...valid, features: { ...valid.features, builtinHelpdesk: value } };
      expect(healthConfigSchema.safeParse(body).success).toBe(false);
    }
    const misplaced = { ...valid, features: { ...valid.features, helpdesk: "builtin" } };
    expect(healthConfigSchema.safeParse(misplaced).success).toBe(false);
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

  it.each(["servicenow", "builtin", "unknown"])("accepts the connector %s", (connector) => {
    expect(helpdeskHealthOutputSchema.safeParse({ ...output, connector }).success).toBe(true);
  });

  it("rejects another connector, an invalid time and an extra key", () => {
    for (const connector of ["jira", "ServiceNow", "", null]) {
      expect(helpdeskHealthOutputSchema.safeParse({ ...output, connector }).success).toBe(false);
    }
    expect(
      helpdeskHealthOutputSchema.safeParse({ ...output, checkedAt: "yesterday" }).success,
    ).toBe(false);
    expect(helpdeskHealthOutputSchema.safeParse({ ...output, error: "boom" }).success).toBe(false);
  });
});
