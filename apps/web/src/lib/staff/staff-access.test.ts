import { describe, expect, it, vi } from "vitest";

// The lookup half of the guard (P5-T16, G6): the decision table with no
// redirects. The private GoTrue/PostgREST run proves it against a real stack.
type Client = Parameters<(typeof import("./staff-access"))["resolveStaffAccess"]>[0];

type Row = { id: string; display_name: string; role: string; active: boolean };

interface Fake {
  user?: { id: string; email?: string; email_confirmed_at?: string } | null;
  getUserError?: unknown;
  staffId?: string | null;
  rpcError?: unknown;
  row?: Row | null;
  selectError?: unknown;
  getSession?: ReturnType<typeof vi.fn>;
}

function client(fake: Fake = {}) {
  const getSession = fake.getSession ?? vi.fn();
  const rpc = vi.fn(async () => ({
    data: fake.staffId === undefined ? "staff-1" : fake.staffId,
    error: fake.rpcError ?? null,
  }));
  const maybeSingle = vi.fn(async () => ({
    data:
      fake.row === undefined
        ? { id: "staff-1", display_name: "A. Agent", role: "agent", active: true }
        : fake.row,
    error: fake.selectError ?? null,
  }));
  const eq = vi.fn(() => ({ maybeSingle }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  const supabase = {
    auth: {
      getUser: vi.fn(async () => ({
        data: {
          user:
            fake.user === undefined
              ? { id: "user-1", email: "a@example.test", email_confirmed_at: "2026-01-01" }
              : fake.user,
        },
        error: fake.getUserError ?? null,
      })),
      getSession,
    },
    rpc,
    from,
  };
  return supabase as unknown as Client;
}

async function load() {
  vi.resetModules();
  return import("./staff-access");
}

describe("resolveStaffAccess", () => {
  it("returns the active staff row for a verified session", async () => {
    const { resolveStaffAccess } = await load();
    const result = await resolveStaffAccess(client());
    expect(result).toEqual({
      ok: true,
      userId: "user-1",
      staff: { id: "staff-1", displayName: "A. Agent", role: "agent", active: true },
    });
  });

  it("does not call getSession", async () => {
    const { resolveStaffAccess } = await load();
    const getSession = vi.fn();
    await resolveStaffAccess(client({ getSession }));
    expect(getSession).not.toHaveBeenCalled();
  });

  it.each([
    ["no user", { user: null }],
    ["a getUser error (expired or tampered token)", { getUserError: { message: "bad jwt" } }],
  ])("refuses on %s", async (_label, fake) => {
    const { resolveStaffAccess } = await load();
    expect(await resolveStaffAccess(client(fake))).toEqual({ ok: false, reason: "no_user" });
  });

  it("refuses an unconfirmed email", async () => {
    const { resolveStaffAccess } = await load();
    const result = await resolveStaffAccess(
      client({ user: { id: "user-1", email: "a@example.test", email_confirmed_at: undefined } }),
    );
    expect(result).toEqual({ ok: false, reason: "unconfirmed" });
  });

  it("refuses a user with no active staff row", async () => {
    const { resolveStaffAccess } = await load();
    expect(await resolveStaffAccess(client({ staffId: null }))).toEqual({
      ok: false,
      reason: "no_staff",
    });
  });

  it.each([
    ["a missing row", { row: null }],
    [
      "an inactive row",
      { row: { id: "staff-1", display_name: "A", role: "agent", active: false } },
    ],
  ])("refuses %s", async (_label, fake) => {
    const { resolveStaffAccess } = await load();
    expect(await resolveStaffAccess(client(fake))).toEqual({ ok: false, reason: "no_staff" });
  });

  it("refuses a row with a role the app does not know", async () => {
    const { resolveStaffAccess } = await load();
    const result = await resolveStaffAccess(
      client({ row: { id: "staff-1", display_name: "A", role: "owner", active: true } }),
    );
    expect(result).toEqual({ ok: false, reason: "no_staff" });
  });

  it("refuses the wrong role", async () => {
    const { resolveStaffAccess } = await load();
    const result = await resolveStaffAccess(client(), "admin");
    expect(result).toEqual({ ok: false, reason: "wrong_role" });
  });

  it("allows the requested role", async () => {
    const { resolveStaffAccess } = await load();
    const admin = client({
      row: { id: "staff-9", display_name: "A. Admin", role: "admin", active: true },
    });
    expect(await resolveStaffAccess(admin, "admin")).toMatchObject({ ok: true });
  });

  it("fails loudly when the staff lookup errors", async () => {
    const { resolveStaffAccess } = await load();
    await expect(resolveStaffAccess(client({ rpcError: { message: "db down" } }))).rejects.toThrow(
      /staff lookup failed/,
    );
  });

  it("fails loudly when the staff row read errors", async () => {
    const { resolveStaffAccess } = await load();
    await expect(
      resolveStaffAccess(client({ selectError: { message: "db down" } })),
    ).rejects.toThrow(/staff lookup failed/);
  });
});
