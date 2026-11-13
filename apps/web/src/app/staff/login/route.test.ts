import { beforeEach, describe, expect, it, vi } from "vitest";

// The sign-in route is a thin wrapper: it builds the request's own Supabase
// client (so the refreshed cookie lands on this response) and hands the
// decision to `handleStaffLogin`. The handler's own suite covers the rules.
const createServerSupabaseClient = vi.hoisted(() => vi.fn());

vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient }));

function request(body: unknown) {
  return new Request("https://example.test/staff/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
    body: JSON.stringify(body),
  });
}

describe("POST /staff/login", () => {
  beforeEach(() => {
    createServerSupabaseClient.mockReset();
  });
  it("returns the generic message for bad credentials", async () => {
    createServerSupabaseClient.mockResolvedValue({
      auth: { signInWithPassword: vi.fn(async () => ({ error: { message: "bad" } })) },
    });
    const { POST } = await import("./route");
    const response = await POST(request({ email: "agent@example.test", password: "wrong" }));
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ message: "Email or password is wrong" });
  });

  it("returns 200 on a good password", async () => {
    createServerSupabaseClient.mockResolvedValue({
      auth: { signInWithPassword: vi.fn(async () => ({ data: { user: {} }, error: null })) },
    });
    const { POST } = await import("./route");
    const response = await POST(request({ email: "agent@example.test", password: "right" }));
    expect(response.status).toBe(200);
    expect(createServerSupabaseClient).toHaveBeenCalledTimes(1);
  });
});
