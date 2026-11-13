import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The proxy refresh (P5-T16): Next 16 `proxy.ts` runs before rendering, so it
// is the only place a request can rewrite auth cookies. Every refreshed chunk
// must keep httpOnly/secure/lax, and the cache headers the library returns
// must land on the same response (installed @supabase/ssr types.d.ts: "Headers
// that must be set on the HTTP response alongside the cookies").
const createServerClient = vi.hoisted(() => vi.fn());
const getUser = vi.hoisted(() => vi.fn());

vi.mock("@supabase/ssr", () => ({ createServerClient }));

const POLICY = { httpOnly: true, secure: true, sameSite: "lax", path: "/" };

type Cookie = { name: string; value: string; options: Record<string, unknown> };
type SetAll = (cookies: Cookie[], headers: Record<string, string>) => void;
type Options = { cookieOptions: Record<string, unknown>; cookies: { setAll: SetAll } };

let session: SetAll;

function request(path = "/staff/tickets") {
  return new NextRequest(`https://example.test${path}`, {
    headers: { cookie: "sb-refresh-token=old" },
  });
}

function setCookieHeader(response: Response): string {
  return response.headers.get("set-cookie") ?? "";
}

/** A token refresh: the library calls `setAll` while `getUser()` is awaited. */
function refreshWrites(cookies: Cookie[], headers: Record<string, string> = {}) {
  getUser.mockImplementation(async () => {
    session(cookies, headers);
    return { data: { user: { id: "user-1" } }, error: null };
  });
}

describe("refreshStaffSession", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    vi.stubEnv("NEXT_PHASE", undefined);
    vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fake-service-role-key");
    vi.stubEnv("SUPABASE_ANON_KEY", "fake-anon-key");
    vi.stubEnv("TRIGGER_SECRET_KEY", "fake-trigger-secret");
    vi.stubEnv("ADMIN_HEALTH_TOKEN", "fake-admin-health-token");
    vi.stubEnv("APP_VERSION", "9.9.9-test");
    createServerClient.mockReset();
    getUser.mockReset();
    getUser.mockResolvedValue({ data: { user: { id: "user-1" } }, error: null });
    createServerClient.mockImplementation((_url: string, _key: string, options: Options) => {
      session = options.cookies.setAll;
      return { auth: { getUser } };
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("verifies the session once and writes refresh cookies to the response", async () => {
    refreshWrites([{ name: "sb-access-token", value: "new", options: POLICY }], {
      "cache-control": "private, no-store",
    });
    const { refreshStaffSession } = await import("./session");
    const response = await refreshStaffSession(request());

    expect(getUser).toHaveBeenCalledTimes(1);
    expect(setCookieHeader(response)).toContain("sb-access-token=new");
    expect(setCookieHeader(response)).toContain("HttpOnly");
    expect(setCookieHeader(response)).toContain("Secure");
    expect(setCookieHeader(response)).toContain("SameSite=lax");
    expect(setCookieHeader(response)).toContain("Path=/");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
  });

  it("keeps every chunk of a split cookie on the same response", async () => {
    refreshWrites([
      { name: "sb-access-token.0", value: "a", options: POLICY },
      { name: "sb-access-token.1", value: "b", options: POLICY },
    ]);
    const { refreshStaffSession } = await import("./session");
    const response = await refreshStaffSession(request());

    const header = setCookieHeader(response);
    expect(header).toContain("sb-access-token.0=a");
    expect(header).toContain("sb-access-token.1=b");
    expect(header.match(/HttpOnly/gi)).toHaveLength(2);
  });

  it("sends the refreshed cookies to the app on the forwarded request", async () => {
    refreshWrites([{ name: "sb-access-token", value: "new", options: POLICY }]);
    const { refreshStaffSession } = await import("./session");
    const incoming = request();
    await refreshStaffSession(incoming);
    expect(incoming.cookies.get("sb-access-token")?.value).toBe("new");
  });

  it("returns a plain continue response when nothing needs refreshing", async () => {
    const { refreshStaffSession } = await import("./session");
    const response = await refreshStaffSession(request());
    expect(response.status).toBe(200);
    expect(setCookieHeader(response)).toBe("");
    expect(getUser).toHaveBeenCalledTimes(1);
  });
});
