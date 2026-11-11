import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDbClient } from "../src/client.js";
import { createRepositories, type Repositories } from "../src/repositories.js";
import { clientFor } from "./pg-container.js";
import { removeRestStack, startRestStack, type RestStack } from "./rest-stack.js";

// P5-T14: probeBuiltinHelpdesk over supabase-js and PostgREST, on a throwaway
// stack with migrations 0001 to 0008. Missing objects are made by renaming
// them for the length of one case (the stack is private to this file).
let stack: RestStack | undefined;
let db: ReturnType<typeof clientFor> | undefined;
let repos: Repositories;

const sql = (): ReturnType<typeof clientFor> => {
  if (!db) throw new Error("database client not connected");
  return db;
};

beforeAll(async () => {
  stack = await startRestStack();
  db = clientFor(stack.pg);
  await db.connect();
  repos = createRepositories(
    createDbClient({
      SUPABASE_URL: stack.url,
      SUPABASE_SERVICE_ROLE_KEY: stack.serviceRoleKey,
      SUPABASE_DB_SCHEMA: "itsupport",
    }),
  );
});

afterAll(async () => {
  await db?.end().catch(() => undefined);
  await removeRestStack(stack);
});

/** Runs the DDL, tells PostgREST to reload its schema and waits until the probe answers `want`. */
async function until(ddl: string, want: boolean): Promise<boolean> {
  await sql().query(ddl);
  await sql().query("notify pgrst, 'reload schema'");
  let last = !want;
  for (let i = 0; i < 40 && last !== want; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    last = await repos.probeBuiltinHelpdesk();
  }
  return last;
}

describe("probeBuiltinHelpdesk on the REST stack", () => {
  it("is true with migrations 0007 and 0008 applied", async () => {
    expect(await repos.probeBuiltinHelpdesk()).toBe(true);
  });

  it.each([
    [
      "a 0007 table",
      "alter table itsupport.helpdesk_notes rename to helpdesk_notes_x",
      "alter table itsupport.helpdesk_notes_x rename to helpdesk_notes",
    ],
    [
      "a 0007 column",
      "alter table itsupport.tickets rename column helpdesk to helpdesk_x",
      "alter table itsupport.tickets rename column helpdesk_x to helpdesk",
    ],
    [
      "a 0008 function",
      "alter function itsupport.staff_assign(uuid, uuid) rename to staff_assign_x",
      "alter function itsupport.staff_assign_x(uuid, uuid) rename to staff_assign",
    ],
  ])("is false while %s is missing, and true again after", async (_label, drop, restore) => {
    expect(await until(drop, false)).toBe(false);
    expect(await until(restore, true)).toBe(true);
  });

  it("changes no data: the probe wrote nothing", async () => {
    const before = await sql().query(
      "select (select count(*) from itsupport.helpdesk_notes) n, (select count(*) from itsupport.ticket_events) e, (select count(*) from itsupport.helpdesk_assignments) a",
    );
    await repos.probeBuiltinHelpdesk();
    const after = await sql().query(
      "select (select count(*) from itsupport.helpdesk_notes) n, (select count(*) from itsupport.ticket_events) e, (select count(*) from itsupport.helpdesk_assignments) a",
    );
    expect(after.rows).toEqual(before.rows);
  });
});
