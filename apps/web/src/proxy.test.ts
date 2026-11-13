import { NextRequest, NextResponse } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The /staff entry point (P5-T16, G11): the built-in helpdesk is the only
// helpdesk with staff screens. With HELPDESK=servicenow every /staff route —
// including login and logout — is a 404 before any auth work happens, so a
// ServiceNow deployment exposes no staff surface at all.
const refreshStaffSession = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/session", () => ({ refreshStaffSession }));

const STAFF_PATHS = [
  "/staff",
  "/staff/login",
  "/staff/logout",
  "/staff/tickets",
  "/staff/tickets/4c1f0f0e-8a1f-4f5a-9e37-9a3a0f6c2b11",
];

function request(path: string) {
  return new NextRequest(`https://example.test${path}`, {
    headers: { cookie: "sb-access-token=looks-valid" },
  });
}

async function loadProxy(helpdesk: "builtin" | "servicenow") {
  vi.resetModules();
  vi.stubEnv("NEXT_PHASE", undefined);
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fake-service-role-key");
  vi.stubEnv("SUPABASE_ANON_KEY", "fake-anon-key");
  vi.stubEnv("TRIGGER_SECRET_KEY", "fake-trigger-secret");
  vi.stubEnv("ADMIN_HEALTH_TOKEN", "fake-admin-health-token");
  vi.stubEnv("APP_VERSION", "9.9.9-test");
  vi.stubEnv("HELPDESK", helpdesk);
  return import("./proxy");
}

describe("proxy /staff gate", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
    refreshStaffSession.mockReset();
    refreshStaffSession.mockResolvedValue(NextResponse.next());
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("only runs under /staff", async () => {
    const { config } = await loadProxy("builtin");
    expect(config.matcher).toEqual(["/staff/:path*"]);
  });

  it.each(STAFF_PATHS)("returns 404 for %s when HELPDESK is servicenow", async (path) => {
    const { proxy } = await loadProxy("servicenow");
    const response = await proxy(request(path));
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
    expect(refreshStaffSession).not.toHaveBeenCalled();
  });

  it("returns 404 before auth work, even with a cookie that looks valid", async () => {
    const { proxy } = await loadProxy("servicenow");
    const response = await proxy(request("/staff/tickets"));
    expect(response.status).toBe(404);
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(refreshStaffSession).not.toHaveBeenCalled();
  });

  it.each(STAFF_PATHS)("refreshes the session for %s when HELPDESK is builtin", async (path) => {
    const { proxy } = await loadProxy("builtin");
    const response = await proxy(request(path));
    expect(response.status).toBe(200);
    expect(refreshStaffSession).toHaveBeenCalledTimes(1);
  });

  it("passes the refreshed response through untouched", async () => {
    const marked = NextResponse.next();
    marked.headers.set("x-refreshed", "1");
    refreshStaffSession.mockResolvedValue(marked);
    const { proxy } = await loadProxy("builtin");
    const response = await proxy(request("/staff/tickets"));
    expect(response.headers.get("x-refreshed")).toBe("1");
  });

  it("does not touch a path outside /staff", async () => {
    const { proxy } = await loadProxy("servicenow");
    const response = await proxy(request("/api/health"));
    expect(response.status).toBe(200);
    expect(refreshStaffSession).not.toHaveBeenCalled();
  });
});
