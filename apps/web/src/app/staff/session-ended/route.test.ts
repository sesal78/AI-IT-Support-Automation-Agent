import { describe, expect, it, vi } from "vitest";

// The denial endpoint (P5-T16): a signed-in user who is not active staff must
// end at a 403 with the session cleared. A Server Component cannot delete
// cookies (installed Next 16 cookies.md), so the guard redirects here: this
// Route Handler is the one place allowed to clear them, and it answers 403.
const createServerSupabaseClient = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient }));

async function load() {
  vi.resetModules();
  return import("./route");
}

describe("GET /staff/session-ended", () => {
  it("clears the local session and answers 403 as plain HTML", async () => {
    const signOut = vi.fn(async () => ({ error: null }));
    createServerSupabaseClient.mockResolvedValue({ auth: { signOut } });
    const { GET } = await load();

    const response = await GET();

    expect(signOut).toHaveBeenCalledWith({ scope: "local" });
    expect(response.status).toBe(403);
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("shows no account detail, only the denial", async () => {
    const signOut = vi.fn(async () => ({ error: null }));
    createServerSupabaseClient.mockResolvedValue({ auth: { signOut } });
    const { GET } = await load();

    const body = await (await GET()).text();

    expect(body).toContain("You do not have access");
    expect(body).not.toMatch(/@/);
  });

  it("still answers 403 when the session is already gone", async () => {
    const signOut = vi.fn(async () => ({ error: null }));
    createServerSupabaseClient.mockResolvedValue({ auth: { signOut } });
    const { GET } = await load();

    expect((await GET()).status).toBe(403);
  });
});
