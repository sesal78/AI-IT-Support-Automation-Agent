import { describe, expect, it } from "vitest";
import { helpdeskEnvShape, parseEnv, parseHelpdeskEnv } from "./env.js";

const servicenow = {
  SERVICENOW_INSTANCE_URL: "https://example.service-now.com",
  SERVICENOW_USERNAME: "svc.itsupport",
  SERVICENOW_PASSWORD: "MarkerSnPassword-0123456789",
  SERVICENOW_DEFAULT_CALLER: "a".repeat(32),
};

function message(source: Record<string, string | undefined>): string {
  try {
    parseHelpdeskEnv(source);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected parseHelpdeskEnv to throw");
}

describe("helpdeskEnvShape and parseHelpdeskEnv (G1)", () => {
  it("HELPDESK is required, with no default", () => {
    expect(() => parseEnv(helpdeskEnvShape, {})).toThrow(/HELPDESK/);
    expect(message({})).toContain("HELPDESK");
    expect(message({ HELPDESK: "" })).toContain("HELPDESK");
  });

  it.each(["ServiceNow", "jira", "BUILTIN", " builtin", "builtin ", "fake", "true"])(
    "the value %j fails at boot, naming the variable",
    (value) => {
      expect(message({ HELPDESK: value, ...servicenow })).toContain("HELPDESK");
    },
  );

  it("builtin boots without any ServiceNow variable, and ignores ones that are set badly", () => {
    expect(parseHelpdeskEnv({ HELPDESK: "builtin" })).toEqual({ HELPDESK: "builtin" });
    const noisy = { HELPDESK: "builtin", SERVICENOW_INSTANCE_URL: "not a url" };
    expect(parseHelpdeskEnv(noisy)).toEqual({ HELPDESK: "builtin" });
  });

  it("servicenow needs every ServiceNow variable, named when missing", () => {
    const text = message({ HELPDESK: "servicenow" });
    for (const name of Object.keys(servicenow)) expect(text).toContain(name);
    expect(message({ HELPDESK: "servicenow", ...servicenow, SERVICENOW_USERNAME: "" })).toContain(
      "SERVICENOW_USERNAME",
    );
  });

  it("servicenow with all of them gives the typed values", () => {
    expect(parseHelpdeskEnv({ HELPDESK: "servicenow", ...servicenow })).toEqual({
      HELPDESK: "servicenow",
      ...servicenow,
    });
  });

  it("never echoes the password", () => {
    const text = message({ HELPDESK: "servicenow", ...servicenow, SERVICENOW_PASSWORD: "short" });
    expect(text).toContain("SERVICENOW_PASSWORD");
    expect(text).not.toContain("short");
  });
});
