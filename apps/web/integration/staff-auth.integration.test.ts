import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveStaffAccess } from "@/lib/staff/auth";
import { createTestStaffUser } from "../../../packages/db/integration/test-users.js";
import { clientOn, getStack, signIn, startStaffStack, stopStaffStack } from "./staff-stack.js";

// The signed-in happy path against the private stack (P5-T16): a real password
// sign-in through the route handler writes the secure cookie, and the guard
// resolves the active staff row with the user's own JWT.
beforeAll(async () => {
  await startStaffStack();
}, 240_000);
afterAll(async () => {
  await stopStaffStack();
});

describe("staff sign-in on the private stack", () => {
  it("signs an active agent in, writes the secure cookie, and resolves the row", async () => {
    const user = await createTestStaffUser(getStack(), { role: "agent" });
    const { jar, response } = await signIn(user.email, user.password);

    expect(response.status).toBe(200);
    const authCookies = jar.authTokenKeys();
    expect(authCookies.length).toBeGreaterThan(0);
    for (const name of authCookies) {
      expect(jar.options(name)).toMatchObject({
        httpOnly: true,
        secure: true,
        sameSite: "lax",
        path: "/",
      });
    }

    expect(await resolveStaffAccess(clientOn(jar))).toMatchObject({
      ok: true,
      userId: user.userId,
      staff: { id: user.staffId, role: "agent", active: true },
    });
  });

  it("gives a wrong password and an unknown email the same 401 answer", async () => {
    const user = await createTestStaffUser(getStack(), { role: "agent" });
    const wrong = await signIn(user.email, "definitely-not-the-password");
    const unknown = await signIn(
      `nobody-${Date.now()}@example.test`,
      "definitely-not-the-password",
    );

    expect(wrong.response.status).toBe(401);
    expect(unknown.response.status).toBe(401);
    expect(await wrong.response.json()).toEqual({ message: "Email or password is wrong" });
    expect(await unknown.response.json()).toEqual({ message: "Email or password is wrong" });
  });

  it("clears the auth cookies on sign-out", async () => {
    const user = await createTestStaffUser(getStack(), { role: "agent" });
    const { jar, supabase } = await signIn(user.email, user.password);
    expect(jar.authTokenKeys().length).toBeGreaterThan(0);

    const { error } = await supabase.auth.signOut();
    expect(error).toBeNull();
    expect(jar.authTokenKeys()).toEqual([]);
  });
});
