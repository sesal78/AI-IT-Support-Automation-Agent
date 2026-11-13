import { describe, expect, it, vi } from "vitest";
import { createRateLimiter } from "@/lib/intake/rate-limit";

// Staff sign-in (P5-T16). One generic answer for a wrong password and an
// unknown email, the same status for both, and the sixth attempt from one IP
// in ten minutes refused with 429 — reusing the intake limiter.
const signInWithPassword = vi.hoisted(() => vi.fn());

type Client = Parameters<(typeof import("./login"))["handleStaffLogin"]>[1]["supabase"];

function supabase(overrides: { error?: unknown; data?: unknown } = {}) {
  signInWithPassword.mockResolvedValue({
    data: overrides.data ?? { user: { id: "user-1" } },
    error: overrides.error ?? null,
  });
  return { auth: { signInWithPassword } } as unknown as Client;
}

function loginRequest(body: unknown, headers: Record<string, string> = {}) {
  return new Request("https://example.test/staff/login", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

const good = { email: "Agent@Example.test", password: "a-long-password" };

function gate() {
  let now = 0;
  return createRateLimiter({ limit: 5, windowMs: 10 * 60 * 1000, now: () => now, maxKeys: 10 });
}

async function load() {
  vi.resetModules();
  return import("./login");
}

describe("handleStaffLogin", () => {
  it("signs in with a normalized email and answers 200", async () => {
    const { handleStaffLogin } = await load();
    const response = await handleStaffLogin(loginRequest(good), {
      supabase: supabase(),
      limiter: gate(),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(signInWithPassword).toHaveBeenCalledWith({
      email: "agent@example.test",
      password: "a-long-password",
    });
  });

  it("gives the same message and status for a wrong password and an unknown email", async () => {
    const { handleStaffLogin, STAFF_LOGIN_ERROR } = await load();

    const wrong = await handleStaffLogin(loginRequest(good), {
      supabase: supabase({ error: { message: "Invalid login credentials" } }),
      limiter: gate(),
    });
    const unknown = await handleStaffLogin(
      loginRequest({ email: "nobody@example.test", password: "a-long-password" }),
      { supabase: supabase({ error: { message: "User not found" } }), limiter: gate() },
    );

    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(await wrong.json()).toEqual({ message: STAFF_LOGIN_ERROR });
    expect(await unknown.json()).toEqual({ message: STAFF_LOGIN_ERROR });
    expect(STAFF_LOGIN_ERROR).toBe("Email or password is wrong");
  });

  it("refuses the sixth attempt in ten minutes from one IP with 429", async () => {
    const { handleStaffLogin } = await load();
    const limiter = gate();
    const attempts = [];
    for (let i = 0; i < 6; i += 1) {
      attempts.push(
        await handleStaffLogin(loginRequest(good, { "cf-connecting-ip": "203.0.113.9" }), {
          supabase: supabase(),
          limiter,
        }),
      );
    }
    expect(attempts.slice(0, 5).map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(attempts[5]?.status).toBe(429);
    expect((await attempts[5]?.json()) as { message: string }).toMatchObject({
      message: expect.stringMatching(/too many/i),
    });
  });

  it("counts each IP separately", async () => {
    const { handleStaffLogin } = await load();
    const limiter = gate();
    const one = { "cf-connecting-ip": "203.0.113.9" };
    const two = { "cf-connecting-ip": "203.0.113.10" };
    for (let i = 0; i < 5; i += 1) {
      await handleStaffLogin(loginRequest(good, one), { supabase: supabase(), limiter });
    }
    expect(
      (await handleStaffLogin(loginRequest(good, two), { supabase: supabase(), limiter })).status,
    ).toBe(200);
  });

  it("counts a missing IP under one shared key", async () => {
    const { handleStaffLogin } = await load();
    const limiter = gate();
    for (let i = 0; i < 5; i += 1) {
      await handleStaffLogin(loginRequest(good), { supabase: supabase(), limiter });
    }
    expect(
      (await handleStaffLogin(loginRequest(good), { supabase: supabase(), limiter })).status,
    ).toBe(429);
  });

  it.each([
    ["not JSON", "not-json"],
    ["an invalid email", { email: "nope", password: "a-long-password" }],
    ["an empty password", { email: "agent@example.test", password: "" }],
  ])("answers 400 for %s, without calling GoTrue", async (_label, body) => {
    const { handleStaffLogin } = await load();
    signInWithPassword.mockClear();
    const response = await handleStaffLogin(loginRequest(body), {
      supabase: supabase(),
      limiter: gate(),
    });
    expect(response.status).toBe(400);
    expect(signInWithPassword).not.toHaveBeenCalled();
  });

  it("never echoes the provider error text", async () => {
    const { handleStaffLogin } = await load();
    const response = await handleStaffLogin(loginRequest(good), {
      supabase: supabase({ error: { message: "relation auth.users does not exist" } }),
      limiter: gate(),
    });
    expect(await response.text()).not.toContain("auth.users");
  });
});
