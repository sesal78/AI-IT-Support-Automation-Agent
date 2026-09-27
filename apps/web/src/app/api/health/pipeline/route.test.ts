import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const trigger = vi.hoisted(() => vi.fn());

vi.mock("@trigger.dev/sdk", () => ({ tasks: { trigger } }));

const TOKEN = "fake-admin-health-token";

function stubEnv() {
  vi.stubEnv("NEXT_PHASE", undefined);
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fake-service-role-key");
  vi.stubEnv("SUPABASE_DB_SCHEMA", undefined);
  vi.stubEnv("TRIGGER_SECRET_KEY", "fake-trigger-secret");
  vi.stubEnv("SHADOW_MODE", undefined);
  vi.stubEnv("ADMIN_HEALTH_TOKEN", TOKEN);
  vi.stubEnv("APP_VERSION", "1.0.0-test");
}

function request(token?: string) {
  const headers = new Headers();
  if (token !== undefined) headers.set("x-admin-token", token);
  return new Request("http://localhost/api/health/pipeline", { method: "POST", headers });
}

async function loadPost() {
  const { POST } = await import("./route");
  return POST;
}

describe("POST /api/health/pipeline", () => {
  beforeEach(() => {
    vi.resetModules();
    trigger.mockReset();
    stubEnv();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("returns 401 without the x-admin-token header and does not trigger", async () => {
    const POST = await loadPost();
    const res = await POST(request());
    expect(res.status).toBe(401);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("returns 401 with a wrong token of the same length and does not trigger", async () => {
    const POST = await loadPost();
    const wrong = "x".repeat(TOKEN.length);
    const res = await POST(request(wrong));
    expect(res.status).toBe(401);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("returns 401 with a wrong token of a different length and does not trigger", async () => {
    const POST = await loadPost();
    const res = await POST(request("short"));
    expect(res.status).toBe(401);
    expect(trigger).not.toHaveBeenCalled();
  });

  it("returns 202 with the runId from tasks.trigger for the right token", async () => {
    trigger.mockResolvedValue({ id: "run_test_123" });
    const POST = await loadPost();
    const res = await POST(request(TOKEN));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ runId: "run_test_123" });
    expect(trigger).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith("healthcheck", { requestedBy: "api" });
  });

  it("returns 502 pipeline_unavailable when tasks.trigger throws", async () => {
    trigger.mockRejectedValue(new Error("network down"));
    const POST = await loadPost();
    const res = await POST(request(TOKEN));
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "pipeline_unavailable" });
  });
});
