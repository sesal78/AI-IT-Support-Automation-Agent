import { afterAll, beforeAll, expect, it } from "vitest";
import { clientFor } from "../../../packages/db/integration/pg-container.js";
import { createTestStaffUser } from "../../../packages/db/integration/test-users.js";
import { getStack, signIn, startStaffStack, stopStaffStack } from "./staff-stack.js";

beforeAll(startStaffStack);
afterAll(stopStaffStack);

it("T5.S.04: denies outsider reads across the schema and raw columns to staff", async () => {
  const stack = getStack();
  const agent = await createTestStaffUser(stack, { role: "agent" });
  const outsider = await createTestStaffUser(stack);
  const staff = await signIn(agent.email, agent.password);
  const guest = await signIn(outsider.email, outsider.password);
  expect(staff.response.ok).toBe(true);
  expect(guest.response.ok).toBe(true);

  const db = clientFor(stack.pg);
  await db.connect();
  try {
    await db.query(`
      insert into itsupport.tickets
        (source, raw_title, raw_description, requester_email, idempotency_key)
      values ('web', 'Private fixture title', 'Private fixture body', 'staff-rls@example.test',
              'staff-rls-test')
    `);
    const { rows } = await db.query<{ table_name: string; readable: string | null }>(`
      select tablename as table_name, (
        select column_name from information_schema.columns
        where table_schema = schemaname and table_name = tablename
          and has_column_privilege('authenticated', format('%I.%I', schemaname, tablename),
                                   column_name, 'select')
        order by ordinal_position limit 1
      ) as readable
      from pg_tables where schemaname = 'itsupport'
      order by tablename
    `);
    expect(rows.map(({ table_name }) => table_name)).toContain("tickets");
    expect(rows.find(({ table_name }) => table_name === "tickets")?.readable).toBe("id");
    const visible = await staff.supabase.from("tickets").select("id");
    expect(visible.error).toBeNull();
    expect(visible.data).toHaveLength(1);

    for (const { table_name, readable } of rows) {
      const { data, error } = await guest.supabase.from(table_name).select(readable ?? "*");
      if (error) expect(error.code, table_name).toBe("42501");
      else expect(data, table_name).toEqual([]);
    }
    for (const column of ["raw_title", "raw_description", "requester_email", "requester_name"]) {
      const { error } = await staff.supabase.from("tickets").select(column);
      expect(error?.code, column).toBe("42501");
    }
  } finally {
    await db.end();
  }
});
