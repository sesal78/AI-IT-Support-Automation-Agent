import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveStaffAccess } from "@/lib/staff/auth";
import { clientFor } from "../../../packages/db/integration/pg-container.js";
import { mintJwt } from "../../../packages/db/integration/rest-stack.js";
import { createTestStaffUser } from "../../../packages/db/integration/test-users.js";
import {
  anonKey,
  clientOn,
  getStack,
  signIn,
  startStaffStack,
  stopStaffStack,
} from "./staff-stack.js";

// The refusal half against the private stack (P5-T16): non-staff, inactive,
// unconfirmed, wrong role, forged tokens and row-level security.
beforeAll(async () => {
  await startStaffStack();
}, 240_000);
afterAll(async () => {
  await stopStaffStack();
});

describe("staff refusals on the private stack", () => {
  it("refuses a signed-in user with no staff row", async () => {
    const user = await createTestStaffUser(getStack());
    const { jar } = await signIn(user.email, user.password);
    expect(await resolveStaffAccess(clientOn(jar))).toEqual({ ok: false, reason: "no_staff" });
  });

  it("refuses an inactive staff row", async () => {
    const user = await createTestStaffUser(getStack(), { role: "agent", active: false });
    const { jar } = await signIn(user.email, user.password);
    expect(await resolveStaffAccess(clientOn(jar))).toEqual({ ok: false, reason: "no_staff" });
  });

  it("refuses an unconfirmed email", async () => {
    const user = await createTestStaffUser(getStack(), { role: "agent" });
    const { jar } = await signIn(user.email, user.password);
    const db = clientFor(getStack().pg);
    await db.connect();
    try {
      await db.query("update auth.users set email_confirmed_at = null where id = $1", [
        user.userId,
      ]);
    } finally {
      await db.end();
    }
    expect(await resolveStaffAccess(clientOn(jar))).toEqual({ ok: false, reason: "unconfirmed" });
  });

  it("refuses the wrong role but allows the right one", async () => {
    const agent = await createTestStaffUser(getStack(), { role: "agent" });
    const agentJar = (await signIn(agent.email, agent.password)).jar;
    expect(await resolveStaffAccess(clientOn(agentJar), "admin")).toEqual({
      ok: false,
      reason: "wrong_role",
    });

    const admin = await createTestStaffUser(getStack(), { role: "admin" });
    const adminJar = (await signIn(admin.email, admin.password)).jar;
    expect(await resolveStaffAccess(clientOn(adminJar), "admin")).toMatchObject({ ok: true });
  });

  it("refuses an expired, a tampered and a foreign-secret JWT", async () => {
    const user = await createTestStaffUser(getStack(), { role: "agent" });
    const real = (await signIn(user.email, user.password)).jar;
    const token = real.readSession().access_token as string;

    const now = Math.floor(Date.now() / 1000);
    const claims = { sub: user.userId, role: "authenticated", aud: "authenticated" };
    const forged = [
      mintJwt(getStack().jwtSecret, { ...claims, exp: now - 60 }),
      `${token.slice(0, -4)}AAAA`,
      mintJwt("f".repeat(64), { ...claims, exp: now + 3600 }),
    ];

    for (const accessToken of forged) {
      const jar = real.clone();
      // A bogus refresh token stops a silent refresh from masking the forgery.
      jar.writeSession({
        ...real.readSession(),
        access_token: accessToken,
        refresh_token: "not-a-refresh-token",
      });
      expect(await resolveStaffAccess(clientOn(jar))).toEqual({ ok: false, reason: "no_user" });
    }
  });

  it("reads staff through the user's JWT, so a non-staff user sees nothing", async () => {
    const staff = await createTestStaffUser(getStack(), { role: "agent" });
    const staffJar = (await signIn(staff.email, staff.password)).jar;
    const staffRows = await clientOn(staffJar).from("staff").select("id");

    const outsider = await createTestStaffUser(getStack());
    const outsiderJar = (await signIn(outsider.email, outsider.password)).jar;
    const outsiderRows = await clientOn(outsiderJar).from("staff").select("id");

    expect(staffRows.error).toBeNull();
    expect(outsiderRows.error).toBeNull();
    // Staff may see the staff list (the assignee picker needs it); a signed-in
    // user with no active staff row sees nothing at all.
    expect(staffRows.data?.length).toBeGreaterThan(0);
    expect(staffRows.data?.some((row) => row.id === staff.staffId)).toBe(true);
    expect(outsiderRows.data).toEqual([]);
  });
});

// `anonKey` is exported for suite symmetry; a direct anonymous read must also
// see nothing, proving the anon key is not the service role.
describe("the anonymous key", () => {
  it("is not the service role", () => {
    expect(anonKey()).not.toBe(getStack().serviceRoleKey);
  });
});
