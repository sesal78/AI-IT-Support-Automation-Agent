import { describe, expect, it, vi } from "vitest";

// `POST /staff/logout` (P5-T16): the only way out. It revokes the session and
// clears the auth cookies on this response, then sends the browser to the
// sign-in screen. There is no GET: a link must not sign anyone out.
const createServerSupabaseClient = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient }));

describe("POST /staff/logout", () => {
  it("signs out and redirects to the sign-in screen", async () => {
    const signOut = vi.fn(async () => ({ error: null }));
    createServerSupabaseClient.mockResolvedValue({ auth: { signOut } });
    const route = await import("./route");

    const response = await route.POST();

    expect(signOut).toHaveBeenCalledTimes(1);
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/staff/login");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("has no GET handler", async () => {
    const route = await import("./route");
    expect((route as { GET?: unknown }).GET).toBeUndefined();
  });

  it("still redirects when GoTrue refuses the revoke", async () => {
    const signOut = vi.fn(async () => ({ error: { message: "network" } }));
    createServerSupabaseClient.mockResolvedValue({ auth: { signOut } });
    const route = await import("./route");

    expect((await route.POST()).status).toBe(303);
  });
});
