import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The Next 16 `cookies()` store (docs/01-app/03-api-reference/04-functions/
// cookies.md: async, read anywhere, write only in a Server Action or Route
// Handler). This suite proves the SSR client is wired to that store and that
// every write carries the staff cookie policy.
const cookieStore = vi.hoisted(() => ({ getAll: vi.fn(), set: vi.fn() }));
const createServerClient = vi.hoisted(() => vi.fn());

vi.mock("next/headers", () => ({ cookies: async () => cookieStore }));
vi.mock("@supabase/ssr", () => ({ createServerClient }));

const POLICY = { httpOnly: true, secure: true, sameSite: "lax", path: "/" };

type Options = {
  cookieOptions: Record<string, unknown>;
  cookies: {
    getAll: () => { name: string; value: string }[];
    setAll: (
      cookies: { name: string; value: string; options: Record<string, unknown> }[],
    ) => void;
  };
};

function optionsOf(call: number): Options {
  return createServerClient.mock.calls[call]?.[2] as Options;
}

async function loadClient() {
  vi.stubEnv("NEXT_PHASE", undefined);
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fake-service-role-key");
  vi.stubEnv("SUPABASE_ANON_KEY", "fake-anon-key");
  vi.stubEnv("TRIGGER_SECRET_KEY", "fake-trigger-secret");
  vi.stubEnv("ADMIN_HEALTH_TOKEN", "fake-admin-health-token");
  vi.stubEnv("APP_VERSION", "9.9.9-test");
  const { createServerSupabaseClient } = await import("./server");
  await createServerSupabaseClient();
  return optionsOf(0);
}

describe("createServerSupabaseClient", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.unstubAllEnvs();
    createServerClient.mockReset();
    cookieStore.getAll.mockReset();
    cookieStore.set.mockReset();
    createServerClient.mockReturnValue({ auth: {} });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("builds one client per call with the URL and the anon key, never the service role", async () => {
    await loadClient();
    await loadClient();
    vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fake-service-role-key");
    expect(createServerClient).toHaveBeenCalledTimes(2);
    expect(createServerClient.mock.calls[0]?.[0]).toBe("https://example.supabase.co");
    expect(createServerClient.mock.calls[0]?.[1]).toBe("fake-anon-key");
  });

  it("applies httpOnly, secure, sameSite=lax and path=/ to every cookie write", async () => {
    const options = await loadClient();
    expect(options.cookieOptions).toEqual(POLICY);
  });

  it("reads every request cookie through getAll", async () => {
    const options = await loadClient();
    cookieStore.getAll.mockReturnValue([{ name: "sb-auth-token", value: "abc" }]);
    expect(options.cookies.getAll()).toEqual([{ name: "sb-auth-token", value: "abc" }]);
  });

  it("writes refreshed cookies through the store with the policy", async () => {
    const options = await loadClient();
    options.cookies.setAll([{ name: "sb-auth-token", value: "new", options: POLICY }]);
    expect(cookieStore.set).toHaveBeenCalledWith("sb-auth-token", "new", POLICY);
  });

  it("tolerates the Server Component refusal, because the proxy owns the refresh", async () => {
    const options = await loadClient();
    // Next throws this in a Server Component (cookies.md, "Setting cookies is
    // not supported during Server Component rendering").
    cookieStore.set.mockImplementation(() => {
      throw new Error("Cookies can only be modified in a Server Action or Route Handler");
    });
    expect(() =>
      options.cookies.setAll([{ name: "sb-auth-token", value: "new", options: POLICY }]),
    ).not.toThrow();
  });
});
