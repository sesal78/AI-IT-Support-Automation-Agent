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

describe("instrumentation register()", () => {
  let exit: ReturnType<typeof vi.spyOn>;
  let logError: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("NEXT_PHASE", undefined);
    exit = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    logError = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("exits non-zero at server boot and logs SUPABASE_URL when it is unset", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    stubAll({ SUPABASE_URL: undefined });
    const { register } = await import("./instrumentation");
    await register();
    expect(exit).toHaveBeenCalledWith(1);
    expect(String(logError.mock.calls[0]?.[0])).toMatch(/SUPABASE_URL/);
  });

  it("does not exit when all variables are set", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    stubAll();
    const { register } = await import("./instrumentation");
    await register();
    expect(exit).not.toHaveBeenCalled();
  });

  it("does not load the server env module in the edge runtime", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    stubAll({ SUPABASE_URL: undefined });
    const { register } = await import("./instrumentation");
    await register();
    expect(exit).not.toHaveBeenCalled();
  });
});
