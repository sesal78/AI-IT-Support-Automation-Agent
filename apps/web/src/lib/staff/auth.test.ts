import { describe, expect, it, vi } from "vitest";

// The policy half of the guard (P5-T16): what a page does (redirect) and what
// an action does (throw 401/403) with the lookup's answer.
const createServerSupabaseClient = vi.hoisted(() => vi.fn());
const resolveStaffAccess = vi.hoisted(() => vi.fn());
const redirect = vi.hoisted(() =>
  vi.fn((url: string) => {
    throw new Error(`NEXT_REDIRECT:${url}`);
  }),
);

vi.mock("@/lib/supabase/server", () => ({ createServerSupabaseClient }));
vi.mock("./staff-access", () => ({ resolveStaffAccess }));
vi.mock("next/navigation", () => ({ redirect }));

const allowed = {
  ok: true,
  userId: "user-1",
  staff: { id: "staff-1", displayName: "A. Agent", role: "agent", active: true },
};

async function load() {
  vi.resetModules();
  redirect.mockClear();
  return import("./auth");
}

describe("requireStaff", () => {
  it("redirects a page request with no session to the login page", async () => {
    const { requireStaff, STAFF_LOGIN_PATH } = await load();
    resolveStaffAccess.mockResolvedValue({ ok: false, reason: "no_user" });
    await expect(requireStaff()).rejects.toThrow(`NEXT_REDIRECT:${STAFF_LOGIN_PATH}`);
    expect(redirect).toHaveBeenCalledWith(STAFF_LOGIN_PATH);
  });

  it.each(["no_staff", "wrong_role", "unconfirmed"])(
    "sends a page request refused for %s to the denial endpoint",
    async (reason) => {
      const { requireStaff, STAFF_DENIED_PATH } = await load();
      resolveStaffAccess.mockResolvedValue({ ok: false, reason });
      await expect(requireStaff()).rejects.toThrow(`NEXT_REDIRECT:${STAFF_DENIED_PATH}`);
    },
  );

  it("throws 401 for an action with no session", async () => {
    const { requireStaff, StaffAccessError } = await load();
    resolveStaffAccess.mockResolvedValue({ ok: false, reason: "no_user" });
    await expect(requireStaff(undefined, "action")).rejects.toMatchObject({
      status: 401,
      reason: "no_user",
    });
    await expect(requireStaff(undefined, "action")).rejects.toBeInstanceOf(StaffAccessError);
  });

  it("throws 403 for an action with a wrong role", async () => {
    const { requireStaff } = await load();
    resolveStaffAccess.mockResolvedValue({ ok: false, reason: "wrong_role" });
    await expect(requireStaff("admin", "action")).rejects.toMatchObject({
      status: 403,
      reason: "wrong_role",
    });
  });

  it("returns the staff context when access is allowed", async () => {
    const { requireStaff } = await load();
    resolveStaffAccess.mockResolvedValue(allowed);
    await expect(requireStaff("agent")).resolves.toMatchObject({
      userId: "user-1",
      staff: { role: "agent" },
    });
  });

  it("reads the session through its own client, one per call", async () => {
    const { requireStaff } = await load();
    resolveStaffAccess.mockResolvedValue(allowed);
    await requireStaff();
    expect(createServerSupabaseClient).toHaveBeenCalledTimes(1);
  });
});
