import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const valid = {
  SUPABASE_URL: "https://example.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "fake-service-role-key",
  SUPABASE_DB_SCHEMA: "itsupport",
  TRIGGER_SECRET_KEY: "fake-trigger-secret",
  SHADOW_MODE: "true",
  ADMIN_HEALTH_TOKEN: "fake-admin-health-token",
  APP_VERSION: "9.9.9-test",
};

function stubAll(overrides: Record<string, string | undefined> = {}) {
  for (const [key, value] of Object.entries({ ...valid, ...overrides })) {
    vi.stubEnv(key, value);
  }
}

describe("web env module", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NEXT_PHASE", undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("parses when all variables are set", async () => {
    stubAll();
    const { env } = await import("./env");
    expect(env.SUPABASE_URL).toBe(valid.SUPABASE_URL);
    expect(env.APP_VERSION).toBe(valid.APP_VERSION);
    expect(env.SHADOW_MODE).toBe(true);
  });

  it("throws naming SUPABASE_URL when it is unset", async () => {
    stubAll({ SUPABASE_URL: undefined });
    await expect(import("./env")).rejects.toThrow(/SUPABASE_URL/);
  });

  it("throws naming SHADOW_MODE when it is not true/false", async () => {
    stubAll({ SHADOW_MODE: "maybe" });
    await expect(import("./env")).rejects.toThrow(/SHADOW_MODE/);
  });

  it("defaults SHADOW_MODE to true when unset", async () => {
    stubAll({ SHADOW_MODE: undefined });
    const { env } = await import("./env");
    expect(env.SHADOW_MODE).toBe(true);
  });

  it("skips validation during next build", async () => {
    vi.stubEnv("NEXT_PHASE", "phase-production-build");
    stubAll({ SUPABASE_URL: undefined });
    await expect(import("./env")).resolves.toBeDefined();
  });
});
