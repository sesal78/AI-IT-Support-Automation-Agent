import { afterEach, describe, expect, it, vi } from "vitest";

describe("GET /api/health", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("returns 200 with status ok and APP_VERSION", async () => {
    vi.stubEnv("NEXT_PHASE", undefined);
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fake-service-role-key");
    vi.stubEnv("SUPABASE_DB_SCHEMA", undefined);
    vi.stubEnv("TRIGGER_SECRET_KEY", "fake-trigger-secret");
    vi.stubEnv("SHADOW_MODE", undefined);
    vi.stubEnv("ADMIN_HEALTH_TOKEN", "fake-admin-health-token");
    vi.stubEnv("APP_VERSION", "1.4.2-test");

    const { GET } = await import("./route");
    const res = GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", version: "1.4.2-test" });
  });
});
