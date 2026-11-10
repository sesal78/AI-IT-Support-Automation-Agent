import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { migration, UP } from "./migration-0008-harness.js";
import {
  clientFor,
  removePgContainer,
  runSql,
  startPgContainer,
  type PgContainer,
} from "./pg-container.js";
import { MIGRATIONS } from "./rest-stack.js";

// P5-T11b: the 0008 staff action functions on a throwaway supabase/postgres.
// A caller is an auth user ID (auth.uid()); null = anon. PostgREST + GoTrue
// JWTs are in migration-0008-actions-rest.integration.test.ts.
let pg: PgContainer;
const ids = { ticket: "", hd: "", agent: "", agentUser: "", inactive: "", inactiveUser: "" };
const NOBODY = "00000000-0000-4000-8000-000000000001";

async function query<T = Record<string, unknown>>(text: string, params: unknown[] = []) {
  const db = clientFor(pg);
  await db.connect();
  try {
    return (await db.query(text, params)).rows as T[];
  } finally {
    await db.end();
  }
}

/** Calls itsupport.<fn>(...args) in its own transaction as `user` (null = anon). */
async function call(user: string | null, fn: string, ...args: unknown[]): Promise<unknown> {
  const db = clientFor(pg);
  await db.connect();
  try {
    await db.query("begin");
    await db.query(`set local role ${user ? "authenticated" : "anon"}`);
    // This image's auth.uid() reads only request.jwt.claim.sub (GoTrue's reads either).
    if (user) await db.query("select set_config('request.jwt.claim.sub', $1, true)", [user]);
    const list = args.map((_, i) => `$${i + 1}`).join(", ");
    const row = (await db.query(`select itsupport.${fn}(${list}) as r`, args)).rows[0];
    await db.query("commit");
    return row?.r;
  } finally {
    await db.end();
  }
}

// Every row a staff action may write or change.
const STATE = `select md5(concat_ws('|', ${[
  "helpdesk_tickets",
  "helpdesk_notes",
  "helpdesk_assignments",
  "ticket_events",
]
  .map((t) => `(select string_agg(t::text, ',' order by t::text) from itsupport.${t} t)`)
  .join(", ")})) as s`;
const state = async () => (await query<{ s: string }>(STATE))[0]?.s;
const lastEvent = async () =>
  (
    await query(
      "select ticket_id, type, payload from itsupport.ticket_events order by id desc limit 1",
    )
  )[0];
/** Expects the call to fail with `code` and to leave every row as it was. */
async function refuse(user: string | null, fn: string, args: unknown[], code: string) {
  const before = await state();
  await expect(call(user, fn, ...args)).rejects.toMatchObject({ code });
  expect(await state()).toBe(before);
}

async function staff(active: boolean) {
  const [row] = await query<{ id: string; auth_user_id: string }>(
    `insert into itsupport.staff (auth_user_id, email, display_name, role, active)
     values (gen_random_uuid(), 'u' || gen_random_uuid() || '@example.test', 'S', 'agent', $1)
     returning id, auth_user_id`,
    [active],
  );
  return row!;
}

beforeAll(async () => {
  pg = await startPgContainer();
  for (const text of [...MIGRATIONS.map(migration), UP]) expect(runSql(pg, text).status).toBe(0);
  ids.ticket = (
    await query<{ id: string }>(
      `insert into itsupport.tickets (source, raw_title, raw_description, requester_email, idempotency_key)
       values ('web', 'r', 'r', 'r@example.test', 'k') returning id`,
    )
  )[0]!.id;
  ids.hd = (
    await query<{ id: string }>(
      `insert into itsupport.helpdesk_tickets (ticket_id, priority, category, updated_at)
       values ($1, 'P3', 'network', '2000-01-01') returning id`,
      [ids.ticket],
    )
  )[0]!.id;
  ({ id: ids.agent, auth_user_id: ids.agentUser } = await staff(true));
  ({ id: ids.inactive, auth_user_id: ids.inactiveUser } = await staff(false));
}, 300_000);
afterAll(() => removePgContainer(pg));

describe.each(["staff_add_note(uuid,text)", "staff_assign(uuid,uuid)"])("%s privileges", (fn) => {
  it("is security definer with an empty search_path; only authenticated may execute", async () => {
    const [row] = await query(
      `select p.prosecdef, p.proconfig, array(select coalesce(nullif(a.grantee, 0)::regrole::text, 'public')
         from aclexplode(p.proacl) a where a.privilege_type = 'EXECUTE' and a.grantee <> p.proowner) as roles
       from pg_proc p where p.oid = to_regprocedure('itsupport.' || $1)`,
      [fn],
    );
    expect(row).toEqual({
      prosecdef: true,
      proconfig: ['search_path=""'],
      roles: ["authenticated"],
    });
  });
});

describe("staff_add_note (Postgres)", () => {
  it("refuses anon, non-staff and inactive staff with 42501 and an unknown ticket with P0002", async () => {
    for (const user of [null, NOBODY, ids.inactiveUser])
      await refuse(user, "staff_add_note", [ids.hd, "x"], "42501");
    await refuse(ids.agentUser, "staff_add_note", [NOBODY, "x"], "P0002");
  });

  it("adds one note and one staff_note_added event without the text; sets updated_at", async () => {
    const body = "'); drop table itsupport.tickets; -- <b onclick=x>hi</b> ‮שלום‬ 😀";
    const noteId = await call(ids.agentUser, "staff_add_note", ids.hd, body);
    expect(
      await query(
        "select body, author_kind, author_staff_id from itsupport.helpdesk_notes where id = $1",
        [noteId],
      ),
    ).toEqual([{ body, author_kind: "staff", author_staff_id: ids.agent }]);
    expect(await lastEvent()).toEqual({
      ticket_id: ids.ticket,
      type: "staff_note_added",
      payload: { noteId, staffId: ids.agent },
    });
    const [hd] = await query(
      "select updated_at > '2000-01-02' as u from itsupport.helpdesk_tickets",
    );
    expect(hd).toEqual({ u: true });
  });

  it("refuses an empty or 5 001-code-point body; accepts 5 000 code points", async () => {
    await refuse(ids.agentUser, "staff_add_note", [ids.hd, ""], "23514");
    await refuse(ids.agentUser, "staff_add_note", [ids.hd, "😀".repeat(5001)], "23514");
    const noteId = await call(ids.agentUser, "staff_add_note", ids.hd, "😀".repeat(5000));
    expect(
      await query("select char_length(body) as n from itsupport.helpdesk_notes where id = $1", [
        noteId,
      ]),
    ).toEqual([{ n: 5000 }]);
  });
});

describe("staff_assign (Postgres)", () => {
  it("refuses anon, non-staff and inactive staff with 42501 and an unknown ticket with P0002", async () => {
    for (const user of [null, NOBODY, ids.inactiveUser])
      await refuse(user, "staff_assign", [ids.hd, ids.agent], "42501");
    await refuse(ids.agentUser, "staff_assign", [NOBODY, ids.agent], "P0002");
  });

  it("refuses an inactive or unknown assignee with 22023, writing nothing", async () => {
    await refuse(ids.agentUser, "staff_assign", [ids.hd, ids.inactive], "22023");
    await refuse(ids.agentUser, "staff_assign", [ids.hd, NOBODY], "22023");
  });

  it("assigns active staff: one assignment row, one staff_assigned event, updated_at", async () => {
    await query("update itsupport.helpdesk_tickets set updated_at = '2000-01-01'");
    const assignmentId = await call(ids.agentUser, "staff_assign", ids.hd, ids.agent);
    expect(
      await query(
        `select a.assignee_id, a.assigned_by_staff_id, h.assignee_id as current,
           h.updated_at > '2000-01-02' as u, (select count(*)::int from itsupport.helpdesk_assignments) as n
         from itsupport.helpdesk_assignments a join itsupport.helpdesk_tickets h on h.id = a.helpdesk_ticket_id
         where a.id = $1`,
        [assignmentId],
      ),
    ).toEqual([
      {
        assignee_id: ids.agent,
        assigned_by_staff_id: ids.agent,
        current: ids.agent,
        u: true,
        n: 1,
      },
    ]);
    expect(await lastEvent()).toEqual({
      ticket_id: ids.ticket,
      type: "staff_assigned",
      payload: { helpdeskTicketId: ids.hd, staffId: ids.agent, assigneeId: ids.agent },
    });
  });
});
