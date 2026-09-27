import { describe, expect, it } from "vitest";
import { formatEnvIssues, parseEnv, phase1EnvShape } from "./env.js";

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
