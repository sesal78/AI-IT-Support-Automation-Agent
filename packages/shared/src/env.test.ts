import { describe, expect, it } from "vitest";
import {
  e2eEnvShape,
  formatEnvIssues,
  intakeEnvShape,
  internalEnvShape,
  parseEnv,
  phase1EnvShape,
  sensitiveCheckEnvShape,
  triggerProjectEnvShape,
} from "./env.js";

const valid = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "fake-service-role-key",
  SUPABASE_DB_SCHEMA: "itsupport",
  TRIGGER_SECRET_KEY: "fake-trigger-secret",
  SHADOW_MODE: "false",
  ADMIN_HEALTH_TOKEN: "fake-admin-health-token",
  APP_VERSION: "1.2.3",
};

describe("parseEnv", () => {
  it("parses a complete environment", () => {
    expect(parseEnv(phase1EnvShape, valid)).toEqual({ ...valid, SHADOW_MODE: false });
  });

  it("applies defaults for SUPABASE_DB_SCHEMA and SHADOW_MODE", () => {
    const env = parseEnv(phase1EnvShape, {
      ...valid,
      SUPABASE_DB_SCHEMA: undefined,
      SHADOW_MODE: "",
    });
    expect(env.SUPABASE_DB_SCHEMA).toBe("itsupport");
    expect(env.SHADOW_MODE).toBe(true);
  });

  it("names a missing variable in the error", () => {
    expect(() => parseEnv(phase1EnvShape, { ...valid, SUPABASE_URL: undefined })).toThrow(
      /SUPABASE_URL/,
    );
  });

  it("rejects SHADOW_MODE values other than true/false", () => {
    expect(() => parseEnv(phase1EnvShape, { ...valid, SHADOW_MODE: "maybe" })).toThrow(
      /SHADOW_MODE/,
    );
  });

  it("does not echo variable values in the error", () => {
    let message = "";
    try {
      parseEnv(phase1EnvShape, { ...valid, SUPABASE_URL: "not-a-url-secret-ish" });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("SUPABASE_URL");
    expect(message).not.toContain("not-a-url-secret-ish");
  });
});

describe("intakeEnvShape", () => {
  const turnstile = { TURNSTILE_SECRET_KEY: "fake-secret", TURNSTILE_SITE_KEY: "fake-site-key" };

  it("parses both Turnstile keys", () => {
    expect(parseEnv(intakeEnvShape, turnstile)).toEqual(turnstile);
  });

  it.each(["TURNSTILE_SECRET_KEY", "TURNSTILE_SITE_KEY"])("names %s when it is unset", (key) => {
    expect(() => parseEnv(intakeEnvShape, { ...turnstile, [key]: "" })).toThrow(key);
  });
});

describe("internalEnvShape", () => {
  const parse = (value: string | undefined) =>
    parseEnv(internalEnvShape, { INTERNAL_API_TOKEN: value });

  it("accepts exactly 32 letters and digits", () => {
    expect(parse("aB3".repeat(10) + "xy").INTERNAL_API_TOKEN).toHaveLength(32);
  });

  it.each([
    ["unset", undefined],
    ["31 characters", "a".repeat(31)],
    ["a hyphen", `${"a".repeat(31)}-`],
    ["an underscore", `${"a".repeat(31)}_`],
    [
      "a trailing newline",
      `${"a".repeat(32)}
`,
    ],
  ])("names INTERNAL_API_TOKEN when it is %s", (_label, value) => {
    expect(() => parse(value)).toThrow(/INTERNAL_API_TOKEN/);
  });
});

describe("formatEnvIssues", () => {
  it("handles object path segments and root issues", () => {
    const message = formatEnvIssues([
      { path: [{ key: "APP_VERSION" }], message: "Required" },
      { message: "Bad input" },
    ]);
    expect(message).toContain("APP_VERSION: Required");
    expect(message).toContain("(root): Bad input");
  });
});

describe("sensitiveCheckEnvShape", () => {
  const base = { TYPESAFE_API_KEY: "fake-typesafe-key" };

  it("defaults SENSITIVE_THRESHOLD to 0.5 when unset or empty", () => {
    expect(parseEnv(sensitiveCheckEnvShape, base).SENSITIVE_THRESHOLD).toBe(0.5);
    expect(
      parseEnv(sensitiveCheckEnvShape, { ...base, SENSITIVE_THRESHOLD: "" }).SENSITIVE_THRESHOLD,
    ).toBe(0.5);
  });

  it.each(["0", "0.35", "1"])("accepts SENSITIVE_THRESHOLD=%s as a number", (value) => {
    expect(
      parseEnv(sensitiveCheckEnvShape, { ...base, SENSITIVE_THRESHOLD: value }).SENSITIVE_THRESHOLD,
    ).toBe(Number(value));
  });

  it.each(["abc", "-0.1", "1.5"])("rejects SENSITIVE_THRESHOLD=%s, naming it", (value) => {
    expect(() => parseEnv(sensitiveCheckEnvShape, { ...base, SENSITIVE_THRESHOLD: value })).toThrow(
      /SENSITIVE_THRESHOLD/,
    );
  });

  it("requires TYPESAFE_API_KEY", () => {
    expect(() => parseEnv(sensitiveCheckEnvShape, {})).toThrow(/TYPESAFE_API_KEY/);
  });
});

describe("triggerProjectEnvShape", () => {
  it("accepts a Trigger.dev project ref", () => {
    const env = { TRIGGER_PROJECT_REF: "proj_abc123" };
    expect(parseEnv(triggerProjectEnvShape, env)).toEqual(env);
  });

  it.each([undefined, ""])("leaves TRIGGER_PROJECT_REF undefined for %j", (value) => {
    expect(
      parseEnv(triggerProjectEnvShape, { TRIGGER_PROJECT_REF: value }).TRIGGER_PROJECT_REF,
    ).toBeUndefined();
  });

  it.each(["my project", "PROJ_ABC", "proj_"])('rejects "%s", naming the variable', (value) => {
    expect(() => parseEnv(triggerProjectEnvShape, { TRIGGER_PROJECT_REF: value })).toThrow(
      /TRIGGER_PROJECT_REF/,
    );
  });
});

describe("e2eEnvShape", () => {
  const parse = (value: string | undefined) => parseEnv(e2eEnvShape, { E2E_MODE: value });

  it.each([
    ["unset", undefined, false],
    ["empty", "", false],
    ["false", "false", false],
    ["true", "true", true],
  ])("E2E_MODE %s parses to %s", (_label, value, expected) => {
    expect(parse(value).E2E_MODE).toBe(expected);
  });

  it.each(["TRUE", "True", "1", "yes", "false ", " true", "0"])(
    "rejects %j, naming E2E_MODE",
    (value) => {
      expect(() => parse(value)).toThrow(/E2E_MODE/);
    },
  );
});
