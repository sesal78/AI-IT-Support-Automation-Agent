import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { format } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createEgressRecorder } from "../../shared/test-support/egress-recorder.js";
import { clientFor } from "./pg-container.js";
import {
  GOTRUE_VERSION,
  mintJwt,
  removeRestStack,
  startRestStack,
  type RestStack,
} from "./rest-stack.js";
import { createTestStaffUser, type TestStaffUser } from "./test-users.js";

// The local GoTrue of the REST stack (P5-T15): pinned version, sign-up off, a
// password sign-in that PostgREST accepts as `authenticated`, the test-user
// helper, no generated password in any output, and a clean teardown.
// Every value is generated at run time; nothing real is used.

let stack: RestStack | undefined;
const egress = createEgressRecorder();
const passwords: string[] = [];
const output: string[] = [];
let stopOutputRecorder: () => void = () => undefined;

/**
 * The log recorder (P5-T15 criterion 4): wraps every console method and raw
 * stdout/stderr write of this file, passes each call through and keeps its
 * text for the leak check. Plain wrappers, not `vi.spyOn`: Vitest resets spy
 * calls between tests, which would empty the record.
 */
function recordOutput(): () => void {
  const restores: Array<() => void> = [];
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write;
    stream.write = function (this: NodeJS.WriteStream, chunk: unknown, ...rest: unknown[]) {
      output.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString());
      return (original as (...args: unknown[]) => boolean).call(this, chunk, ...rest);
    } as typeof stream.write;
    restores.push(() => (stream.write = original));
  }
  for (const name of ["log", "info", "warn", "error", "debug"] as const) {
    const original = console[name];
    console[name] = (...args: unknown[]) => {
      output.push(format(...args));
      original(...args);
    };
    restores.push(() => (console[name] = original));
  }
  return () => restores.forEach((restore) => restore());
}

function live(): RestStack {
  if (!stack) throw new Error("stack not started");
  return stack;
}

async function newUser(options: Parameters<typeof createTestStaffUser>[1]) {
  const user = await createTestStaffUser(live(), options);
  passwords.push(user.password);
  egress.forbid(user.password);
  return user;
}

function signIn(user: Pick<TestStaffUser, "email" | "password">): Promise<Response> {
  return fetch(`${live().url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: user.email, password: user.password }),
  });
}

/** Calls the test-only `harness_whoami` RPC through the gateway. */
function whoami(token: string): Promise<Response> {
  return fetch(`${live().url}/rest/v1/rpc/harness_whoami`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      "content-profile": "itsupport",
    },
    body: "{}",
  });
}

beforeAll(async () => {
  egress.start();
  stopOutputRecorder = recordOutput();
  console.info("output recorder probe");
  stack = await startRestStack();

  // Test-only probe on this file's throwaway database: reports the role
  // PostgREST switched to and the JWT subject. 0001 revokes schema usage from
  // `authenticated`; it is granted back here, on this stack only.
  const db = clientFor(stack.pg);
  await db.connect();
  try {
    await db.query(`
      create function itsupport.harness_whoami() returns jsonb
        language sql stable set search_path = ''
        as $$ select jsonb_build_object(
          'role', current_user,
          'sub', current_setting('request.jwt.claims', true)::jsonb ->> 'sub') $$;
      revoke all on function itsupport.harness_whoami() from public;
      grant usage on schema itsupport to authenticated;
      grant execute on function itsupport.harness_whoami() to authenticated;
      notify pgrst, 'reload schema';
    `);
  } finally {
    await db.end().catch(() => undefined);
  }
  // Wait for PostgREST's schema cache to see the probe (404 until then).
  // service_role may not execute it, so the probe answers 403 once loaded.
  const deadline = Date.now() + 30_000;
  for (;;) {
    const res = await whoami(stack.serviceRoleKey);
    if (res.status !== 404) break;
    if (Date.now() > deadline) throw new Error("harness_whoami never appeared in PostgREST");
    await new Promise((done) => setTimeout(done, 250));
  }
});

afterAll(async () => {
  stopOutputRecorder();
  egress.stop();
  await removeRestStack(stack);
});

describe("local GoTrue", () => {
  it("runs the pinned version the shared stack runs", async () => {
    const res = await fetch(`${live().url}/auth/v1/health`);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { version: string }).version).toBe(GOTRUE_VERSION);
  });

  it("refuses sign-up and creates no user", async () => {
    const probePassword = randomBytes(24).toString("base64url");
    passwords.push(probePassword);
    const res = await fetch(`${live().url}/auth/v1/signup`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: "signup-probe@example.test", password: probePassword }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(((await res.json()) as { error_code?: string }).error_code).toBe("signup_disabled");

    const db = clientFor(live().pg);
    await db.connect();
    try {
      const { rowCount } = await db.query("select 1 from auth.users where email = $1", [
        "signup-probe@example.test",
      ]);
      expect(rowCount).toBe(0);
    } finally {
      await db.end().catch(() => undefined);
    }
  });

  it("signs a non-staff user in with a JWT that PostgREST accepts as authenticated", async () => {
    const user = await newUser({});
    expect(user.staffId).toBeUndefined();

    const res = await signIn(user);
    expect(res.status).toBe(200);
    const { access_token: accessToken } = (await res.json()) as { access_token: string };

    const probe = await whoami(accessToken);
    expect(probe.status).toBe(200);
    expect(await probe.json()).toEqual({ role: "authenticated", sub: user.userId });

    // The same claims signed with another secret are refused: PostgREST
    // checks the signature against the secret it shares with GoTrue.
    const forged = await whoami(
      mintJwt("y".repeat(64), { role: "authenticated", sub: user.userId }),
    );
    expect(forged.status).toBe(401);
  });

  it("refuses the password sign-in of an unconfirmed user", async () => {
    const user = await newUser({ confirmed: false });
    const res = await signIn(user);
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error_code?: string }).error_code).toBe("email_not_confirmed");
  });

  it("refuses a wrong password", async () => {
    const user = await newUser({});
    const res = await signIn({ email: user.email, password: `${user.password}x` });
    expect(res.status).toBe(400);
  });

  it("does not show the generated email or password when the user is printed", async () => {
    const user = await newUser({});
    const printed = `${JSON.stringify(user)} ${Object.keys(user).join(",")}`;
    expect(printed).not.toContain(user.password);
    expect(printed).not.toContain(user.email);
    expect(user.password.length).toBeGreaterThanOrEqual(32);
  });

  it("adds a staff row for a role once itsupport.staff exists (migration 0007, P5-B2)", async () => {
    const db = clientFor(live().pg);
    await db.connect();
    try {
      const { rows } = await db.query<{ present: boolean }>(
        "select to_regclass('itsupport.staff') is not null as present",
      );
      if (!rows[0]?.present) {
        // TODO(P5-B2): once 0007 is in MIGRATIONS only the branch below runs.
        await expect(createTestStaffUser(live(), { role: "agent" })).rejects.toThrow(
          /itsupport\.staff does not exist.*0007 \(P5-B2\)/,
        );
        return;
      }
      for (const [role, active] of [
        ["agent", true],
        ["admin", false],
      ] as const) {
        const user = await newUser({ role, active });
        const staff = await db.query<{ role: string; active: boolean; auth_user_id: string }>(
          "select role, active, auth_user_id from itsupport.staff where id = $1",
          [user.staffId],
        );
        expect(staff.rows).toEqual([{ role, active, auth_user_id: user.userId }]);
      }
    } finally {
      await db.end().catch(() => undefined);
    }
  });

  it("leaks no generated password to test output, container logs or egress", () => {
    expect(passwords.length).toBeGreaterThanOrEqual(4);
    const printed = output.join("\n");
    // The recorder works: the probe line from beforeAll was kept.
    expect(printed).toContain("output recorder probe");
    const logs = [live().authContainer, live().restContainer, live().pg.name]
      .map((name) => {
        const run = spawnSync("docker", ["logs", name], { encoding: "utf8" });
        return `${run.stdout}${run.stderr}`;
      })
      .join("\n");
    expect(logs.length).toBeGreaterThan(0);
    for (const password of passwords) {
      // Boolean checks only, so a failure never prints the password itself.
      expect(printed.includes(password)).toBe(false);
      expect(logs.includes(password)).toBe(false);
    }
    egress.assertClean();
  });

  it("teardown removes every container and the network", async () => {
    const current = live();
    const names = [current.pg.name, current.restContainer, current.authContainer];
    await removeRestStack(current);
    stack = undefined;
    for (const name of names) {
      const ps = spawnSync("docker", ["ps", "--all", "--quiet", "--filter", `name=^${name}$`], {
        encoding: "utf8",
      });
      expect(ps.stdout.trim()).toBe("");
    }
    const net = spawnSync("docker", ["network", "inspect", current.network], { encoding: "utf8" });
    expect(net.status).not.toBe(0);
  });
});
