import { createServerClient } from "@supabase/ssr";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRateLimiter } from "@/lib/intake/rate-limit";
import { handleStaffLogin } from "@/lib/staff/login";
import { resolveStaffAccess } from "@/lib/staff/auth";
import { clientFor } from "../../../packages/db/integration/pg-container.js";
import {
  mintJwt,
  removeRestStack,
  startRestStack,
  type RestStack,
} from "../../../packages/db/integration/rest-stack.js";
import { createTestStaffUser } from "../../../packages/db/integration/test-users.js";

// The guard boundary against the private GoTrue/PostgREST stack (P5-T16): a
// real password sign-in, the cookie policy it writes, the active-staff lookup
// with the user's own JWT, and the refusal for non-staff, inactive, unconfirmed
// and forged sessions. Every value is generated per run and never printed.

const POLICY = { httpOnly: true, secure: true, sameSite: "lax", path: "/" } as const;

/** An SSR cookie store, as `next/headers` behaves inside a Route Handler. */
class Jar {
  private readonly cookies = new Map<string, { value: string; options: Record<string, unknown> }>();

  getAll = () => [...this.cookies].map(([name, cookie]) => ({ name, value: cookie.value }));

  setAll = (list: { name: string; value: string; options: Record<string, unknown> }[]) => {
    for (const { name, value, options } of list) {
      if (options.maxAge === 0) this.cookies.delete(name);
      else this.cookies.set(name, { value, options });
    }
  };

  keys = () => [...this.cookies.keys()];

  options(name: string) {
    return this.cookies.get(name)?.options ?? {};
  }

  /** A session cookie value is `base64-` + base64url(JSON). */
  readSession(): Record<string, unknown> {
    const key = this.authCookieKey();
    const raw = this.cookies.get(key)!.value.slice("base64-".length);
    return JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<string, unknown>;
  }

  writeSession(session: Record<string, unknown>) {
    const key = this.authCookieKey();
    this.cookies.get(key)!.value =
      `base64-${Buffer.from(JSON.stringify(session)).toString("base64url")}`;
  }

  clone(): Jar {
    const copy = new Jar();
    for (const [name, cookie] of this.cookies) copy.cookies.set(name, { ...cookie });
    return copy;
  }

  authCookieKey() {
    const key = this.keys().find((name) => name.endsWith("-auth-token"));
    if (!key) throw new Error("no auth cookie was written");
    return key;
  }

  authTokenKeys() {
    return this.keys().filter((name) => name.includes("auth-token"));
  }
}

let stack: RestStack;

function anonKey() {
  return mintJwt(stack.jwtSecret, { role: "anon" });
}

function clientOn(jar: Jar) {
  return createServerClient(stack.url, anonKey(), {
    db: { schema: "itsupport" },
    cookieOptions: POLICY,
    cookies: { getAll: jar.getAll, setAll: jar.setAll },
  });
}

/** Signs in through the real route handler and keeps the cookies it writes. */
async function signIn(email: string, password: string) {
  const jar = new Jar();
  const supabase = clientOn(jar);
  const limiter = createRateLimiter({ limit: 5, windowMs: 10 * 60 * 1000 });
  const response = await handleStaffLogin(
    new Request("https://example.test/staff/login", {
      method: "POST",
      headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.20" },
      body: JSON.stringify({ email, password }),
    }),
    { supabase, limiter },
  );
  return { jar, response, supabase };
}

beforeAll(async () => {
  stack = await startRestStack();
}, 240_000);

afterAll(async () => {
  await removeRestStack(stack);
});

describe("staff auth boundary on the private stack", () => {
  it("signs an active agent in, writes the secure cookie, and resolves the row", async () => {
    const user = await createTestStaffUser(stack, { role: "agent" });
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
    const user = await createTestStaffUser(stack, { role: "agent" });
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

  it("refuses a signed-in user with no staff row", async () => {
    const user = await createTestStaffUser(stack);
    const { jar } = await signIn(user.email, user.password);
    expect(await resolveStaffAccess(clientOn(jar))).toEqual({ ok: false, reason: "no_staff" });
  });

  it("refuses an inactive staff row", async () => {
    const user = await createTestStaffUser(stack, { role: "agent", active: false });
    const { jar } = await signIn(user.email, user.password);
    expect(await resolveStaffAccess(clientOn(jar))).toEqual({ ok: false, reason: "no_staff" });
  });

  it("refuses an unconfirmed email", async () => {
    const user = await createTestStaffUser(stack, { role: "agent" });
    const { jar } = await signIn(user.email, user.password);
    const db = clientFor(stack.pg);
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
    const agent = await createTestStaffUser(stack, { role: "agent" });
    const agentJar = (await signIn(agent.email, agent.password)).jar;
    expect(await resolveStaffAccess(clientOn(agentJar), "admin")).toEqual({
      ok: false,
      reason: "wrong_role",
    });

    const admin = await createTestStaffUser(stack, { role: "admin" });
    const adminJar = (await signIn(admin.email, admin.password)).jar;
    expect(await resolveStaffAccess(clientOn(adminJar), "admin")).toMatchObject({ ok: true });
  });

  it("refuses an expired, a tampered and a foreign-secret JWT", async () => {
    const user = await createTestStaffUser(stack, { role: "agent" });
    const real = (await signIn(user.email, user.password)).jar;
    const token = real.readSession().access_token as string;

    const now = Math.floor(Date.now() / 1000);
    const claims = { sub: user.userId, role: "authenticated", aud: "authenticated" };
    const forged = [
      mintJwt(stack.jwtSecret, { ...claims, exp: now - 60 }),
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
    const staff = await createTestStaffUser(stack, { role: "agent" });
    const staffJar = (await signIn(staff.email, staff.password)).jar;
    const staffRows = await clientOn(staffJar).from("staff").select("id");

    const outsider = await createTestStaffUser(stack);
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

  it("clears the auth cookies on sign-out", async () => {
    const user = await createTestStaffUser(stack, { role: "agent" });
    const { jar, supabase } = await signIn(user.email, user.password);
    expect(jar.authTokenKeys().length).toBeGreaterThan(0);

    const { error } = await supabase.auth.signOut();
    expect(error).toBeNull();
    expect(jar.authTokenKeys()).toEqual([]);
  });
});
