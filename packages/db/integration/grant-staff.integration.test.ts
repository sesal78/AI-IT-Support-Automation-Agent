import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migration } from "./migration-0008-harness.js";
import {
  clientFor,
  removePgContainer,
  runSql,
  startPgContainer,
  type PgContainer,
} from "./pg-container.js";
import { MIGRATIONS } from "./rest-stack.js";

// supabase/scripts/grant-staff.sql (Seun's H30) on a throwaway supabase/postgres
// with every migration applied. Fake users only; never run on the shared stack.
const SCRIPT = readFileSync(
  new URL("../../../supabase/scripts/grant-staff.sql", import.meta.url),
  "utf8",
);
const EMAIL = "person@example.com";
const NAME = "Display Name";
const ROLE = "'agent'";

let pg: PgContainer;
const userId = randomUUID();

async function query<T>(text: string, values: unknown[] = []): Promise<T[]> {
  const db = clientFor(pg);
  await db.connect();
  try {
    return (await db.query(text, values)).rows as T[];
  } finally {
    await db.end();
  }
}
/** Runs the script with the three values filled in, as Seun would after editing it. */
const grant = (email: string, name: string, role: string) => {
  for (const marker of [EMAIL, NAME, ROLE]) expect(SCRIPT.split(marker)).toHaveLength(2);
  return runSql(pg, SCRIPT.replace(EMAIL, email).replace(NAME, name).replace(ROLE, `'${role}'`));
};
const staff = () =>
  query<{
    auth_user_id: string;
    email: string;
    display_name: string;
    role: string;
    active: boolean;
  }>("select auth_user_id, email, display_name, role, active from itsupport.staff order by email");

beforeAll(async () => {
  pg = await startPgContainer();
  for (const name of MIGRATIONS) expect(runSql(pg, migration(name)).status).toBe(0);
  await query("insert into auth.users (id, email) values ($1, 'ada@example.test')", [userId]);
}, 300_000);
afterAll(() => removePgContainer(pg));

describe("supabase/scripts/grant-staff.sql", () => {
  it("adds the staff row for an invited user and prints it; a second run keeps one row", async () => {
    const first = grant("Ada@Example.test", "Ada", "agent");
    expect(first.status).toBe(0);
    expect(first.stdout).toContain("ada@example.test");
    const second = grant("ada@example.test", "Ada L", "admin");
    expect(second.status).toBe(0);
    expect(second.stdout).toContain("Ada L");
    expect(await staff()).toEqual([
      {
        auth_user_id: userId,
        email: "ada@example.test",
        display_name: "Ada L",
        role: "admin",
        active: true,
      },
    ]);
  });

  it("re-activates a deactivated staff row", async () => {
    await query("update itsupport.staff set active = false");
    expect(grant("ada@example.test", "Ada L", "admin").status).toBe(0);
    expect(await staff()).toMatchObject([{ active: true }]);
  });

  it.each([
    ["an unknown email", "nobody@example.test", "agent", "no Supabase Auth user has this email"],
    ["a role outside agent|admin", "ada@example.test", "owner", "role must be agent or admin"],
  ])("refuses %s with a clear error and writes no row", async (_, email, role, message) => {
    const before = await staff();
    const run = grant(email, "X", role);
    expect(run.status).not.toBe(0);
    expect(run.stderr).toContain(message);
    expect(run.stderr).not.toContain(email);
    expect(await staff()).toEqual(before);
  });
});
