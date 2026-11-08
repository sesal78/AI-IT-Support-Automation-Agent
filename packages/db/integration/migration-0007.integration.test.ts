import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  clientFor,
  removePgContainer,
  runSql,
  startPgContainer,
  type PgContainer,
} from "./pg-container.js";

// Migration 0007: the built-in helpdesk tables (staff, helpdesk_tickets,
// helpdesk_notes, helpdesk_assignments, helpdesk_state_transitions), the
// columns tickets.helpdesk and reviews.staff_id, and the reviews decider check
// that replaces 0005's reviews_slack_user_check (P5-T10a). 0001 to 0006 are
// applied first, with Supabase-like default privileges set before 0001, then
// phase-4-shaped rows are seeded (SEED: four tickets with a triage review
// each, approved and rejected in Slack, timed out and still open; their
// redactions, events and one notification). So the reviews check swap runs on
// a populated table, as at H28b, and the row count and an md5 of every
// table's pre-0007 columns are compared after each step. All data is fake
// (the repo is public): example.test addresses, U000TEST Slack user IDs,
// fixed test UUIDs, waitpoint_test_* tokens.

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../supabase");
const read = (file: string) => readFileSync(resolve(dir, file), "utf8");
const PRIOR = [
  "0001_itsupport_foundation",
  "0002_itsupport_intake",
  "0003_itsupport_triage_kb",
  "0004_itsupport_lock_sequences",
  "0005_itsupport_reviews",
  "0006_itsupport_helpdesk",
];
const M4 = "0004_itsupport_lock_sequences";
const M7 = "0007_itsupport_builtin_helpdesk";
const up = read(`migrations/${M7}.sql`);
const down = read(`migrations/${M7}.down.sql`);
const OLD = ["0003_itsupport_triage_kb", "0005_itsupport_reviews", "0006_itsupport_helpdesk"];
const TABLES = [
  "staff",
  "helpdesk_tickets",
  "helpdesk_notes",
  "helpdesk_assignments",
  "helpdesk_state_transitions",
];
const LOGS = ["helpdesk_notes", "helpdesk_assignments"];
// Global and per-schema defaults, as a Supabase project sets them for public.
const DEFAULTS = ["", "in schema itsupport "]
  .flatMap((scope) =>
    ["tables", "sequences", "functions"].map(
      (o) =>
        `alter default privileges ${scope}grant all on ${o} to anon, authenticated, service_role;`,
    ),
  )
  .join(" ");

let container: PgContainer | undefined;
let db: pg.Client;

const applied = (sql: string) => {
  const result = runSql(container!, sql);
  expect(result.stderr).not.toMatch(/ERROR/);
  expect(result.status).toBe(0);
};
type Attempt =
  | { ok: true; rows: Record<string, unknown>[] }
  | { ok: false; code?: string; constraint?: string; message?: string };
/** Runs `sql` in a transaction that is always rolled back; `prep` runs as postgres before `set local role`. */
const attempt = async (sql: string, role?: string, prep = ""): Promise<Attempt> => {
  await db.query("begin");
  try {
    if (prep) await db.query(prep);
    if (role) await db.query(`set local role ${role}`);
    const result = await db.query(sql);
    return { ok: true, rows: (Array.isArray(result) ? result.at(-1) : result).rows };
  } catch (error) {
    const { code, constraint, message } = error as Record<string, string | undefined>;
    return { ok: false, code, constraint, message };
  } finally {
    await db.query("rollback");
  }
};
const fails = (code: string, constraint?: string) =>
  expect.objectContaining({ ok: false, code, ...(constraint ? { constraint } : {}) });
const appendOnly = (table: string, op: string) =>
  expect.objectContaining({
    ok: false,
    code: "42501",
    message: `${table} is append-only: ${op} is not allowed`,
  });
const denied = expect.objectContaining({
  ok: false,
  code: "42501",
  message: expect.stringMatching(/^permission denied for table/),
});
const passes = expect.objectContaining({ ok: true });
/** Rows of a check query, run in a read-only transaction (it writes nothing). */
const check = async (name: string) => {
  await db.query("begin transaction read only");
  try {
    return (await db.query<{ object: string; ok: boolean }>(read(`checks/${name}.check.sql`))).rows;
  } finally {
    await db.query("commit");
  }
};
const notOk = async (name: string) => (await check(name)).filter((r) => !r.ok).map((r) => r.object);
/** Not-ok rows of check `name` after `sql`, rolled back. */
const notOkAfter = async (sql: string, name = M7) => {
  await db.query("begin");
  try {
    await db.query(sql);
    const { rows } = await db.query<{ object: string; ok: boolean }>(
      read(`checks/${name}.check.sql`),
    );
    return rows.filter((r) => !r.ok).map((r) => r.object);
  } finally {
    await db.query("rollback");
  }
};
/**
 * The 0004 check with this file's Supabase-like defaults revoked (rolled back):
 * its two default-privilege rows are false while they are in place (as in the
 * 0004 test), so this asks the sequence rows and the stack's real defaults.
 */
const notOk4 = () =>
  notOkAfter(DEFAULTS.replace(/grant all on (\w+) to/g, "revoke all on $1 from"), M4);
const exists = async (sql: string) => (await db.query(`select (${sql}) as e`)).rows[0].e as boolean;

const SLACK = "00000000-0000-4000-8000-000000000701";
const REJECTED = "00000000-0000-4000-8000-000000000702";
const TIMEOUT = "00000000-0000-4000-8000-000000000703";
const OPEN = "00000000-0000-4000-8000-000000000704";
/** Phase-4-shaped rows, written the way intake, triage and the review flow write them. */
const SEED = `
  insert into itsupport.tickets (id, source, raw_title, raw_description, requester_email,
      idempotency_key, status, created_at) values
    ('${SLACK}', 'web', 'VPN down', 'Cannot connect', 'demo.user@example.test', 'web:seed-1',
     'approved', timestamptz '2026-10-20 01:00:00+00'),
    ('${REJECTED}', 'email', 'New laptop', 'Send one', 'demo.other@example.test', 'email:seed-2',
     'rejected', timestamptz '2026-10-20 01:05:00+00'),
    ('${TIMEOUT}', 'web', 'Payroll', 'Wrong amount', 'demo.third@example.test', 'web:seed-3',
     'escalated_manual', timestamptz '2026-10-20 01:10:00+00'),
    ('${OPEN}', 'web', 'Access', 'HR folder', 'demo.fourth@example.test', 'web:seed-4',
     'review_pending', timestamptz '2026-10-20 01:15:00+00');
  insert into itsupport.ticket_redactions (ticket_id, redacted_title, redacted_description)
    select id, raw_title, raw_description from itsupport.tickets;
  insert into itsupport.ticket_events (ticket_id, type, payload)
    select t.id, e.type, '{}'::jsonb from itsupport.tickets t,
      unnest(array['received', 'redacted', 'triaged', 'review_requested']) as e (type)
    order by t.id;
  insert into itsupport.reviews (ticket_id, kind, slack_user_id, decision, decided_at, wait_token_id) values
    ('${SLACK}', 'triage', 'U000TEST01', 'approve', timestamptz '2026-10-20 02:00:00+00', 'waitpoint_test_1'),
    ('${REJECTED}', 'triage', 'U000TEST02', 'reject', timestamptz '2026-10-20 02:05:00+00', 'waitpoint_test_2'),
    ('${TIMEOUT}', 'triage', null, 'timeout', timestamptz '2026-10-20 02:10:00+00', 'waitpoint_test_3'),
    ('${OPEN}', 'triage', null, null, null, 'waitpoint_test_4');
  insert into itsupport.notifications (ticket_id, channel, kind, status, provider_id)
    values ('${SLACK}', 'email', 'incident_reply', 'sent', 're_msg_seed');
`;

type Shape = { name: string; pk: string | null; cols: string };
/** Every itsupport table with its primary key and columns, taken before 0007. */
let shapes: Shape[] = [];
type TableRows = Record<string, { rows: number; md5: string }>;
/** Row count and an md5 of each table's pre-0007 columns, rows ordered by primary key. */
const tableRows = async (): Promise<TableRows> => {
  const out: TableRows = {};
  for (const { name, pk, cols } of shapes) {
    if (!pk) throw new Error(`itsupport.${name} has no primary key to order its rows by`);
    const { rows } = await db.query<{ rows: number; md5: string }>(
      `select count(*)::int as rows,
         md5(coalesce(string_agg(row(${cols})::text, E'\\n' order by ${pk}), '')) as md5
       from itsupport.${name}`,
    );
    out[name] = rows[0]!;
  }
  return out;
};
let seeded: TableRows = {};

/** Every itsupport object, with owner, ACL, columns, constraints, indexes, triggers and functions. */
const catalog = async () =>
  (
    await db.query<{ item: string }>(`
      select 'rel ' || c.relname || ' ' || c.relkind::text || ' ' || coalesce(c.relacl::text, '-') as item
      from pg_catalog.pg_class c where c.relnamespace = 'itsupport'::regnamespace
      union all
      select 'col ' || a.attrelid::regclass::text || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
        || ' ' || a.attnotnull || ' ' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-')
      from pg_catalog.pg_attribute a
      join pg_catalog.pg_class c on c.oid = a.attrelid and c.relnamespace = 'itsupport'::regnamespace
      left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where a.attnum > 0 and not a.attisdropped
      union all
      select 'con ' || k.conrelid::regclass::text || ' ' || k.conname || ' ' || pg_get_constraintdef(k.oid)
      from pg_catalog.pg_constraint k where k.connamespace = 'itsupport'::regnamespace
      union all
      select 'idx ' || indexdef from pg_catalog.pg_indexes where schemaname = 'itsupport'
      union all
      select 'trg ' || t.tgrelid::regclass::text || ' ' || t.tgname from pg_catalog.pg_trigger t
      join pg_catalog.pg_class c on c.oid = t.tgrelid and c.relnamespace = 'itsupport'::regnamespace
      where not t.tgisinternal
      union all
      select 'fn ' || p.oid::regprocedure::text || ' ' || coalesce(p.proacl::text, '-')
      from pg_catalog.pg_proc p where p.pronamespace = 'itsupport'::regnamespace
      order by 1`)
  ).rows.map((r) => r.item);

let before: string[] = [];
let afterUp: string[] = [];
const checksBefore: Record<string, unknown> = {};

// Rows for the constraint and grant tests, inserted in a rolled-back transaction.
const STAFF = "00000000-0000-4000-8000-0000000007a1";
const ADMIN = "00000000-0000-4000-8000-0000000007a2";
const HD = "00000000-0000-4000-8000-0000000007b1";
const staffRow = (id: string, cols: Record<string, string> = {}) => {
  const row = {
    id: `'${id}'`,
    auth_user_id: "gen_random_uuid()",
    email: `'staff-${id.slice(-3)}@example.test'`,
    display_name: "'Test Staff'",
    role: "'agent'",
    ...cols,
  };
  return `insert into itsupport.staff (${Object.keys(row).join(", ")}) values (${Object.values(row).join(", ")})`;
};
const hdRow = (cols: Record<string, string> = {}) => {
  const row = {
    id: `'${HD}'`,
    ticket_id: `'${OPEN}'`,
    priority: "'P3'",
    category: "'network'",
    ...cols,
  };
  return `insert into itsupport.helpdesk_tickets (${Object.keys(row).join(", ")}) values (${Object.values(row).join(", ")})`;
};
const noteRow = (cols: Record<string, string> = {}) => {
  const row = {
    helpdesk_ticket_id: `'${HD}'`,
    author_kind: "'staff'",
    author_staff_id: `'${STAFF}'`,
    body: "'Checked the cable'",
    ...cols,
  };
  return `insert into itsupport.helpdesk_notes (${Object.keys(row).join(", ")}) values (${Object.values(row).join(", ")})`;
};
const assignRow = `insert into itsupport.helpdesk_assignments (helpdesk_ticket_id, assignee_id, assigned_by_staff_id)
  values ('${HD}', '${STAFF}', '${ADMIN}')`;
/** A staff member, an admin, a helpdesk ticket, one note and one assignment. */
const BASE = `${staffRow(STAFF)}; ${staffRow(ADMIN, { role: "'admin'" })}; ${hdRow()}; ${noteRow()}; ${assignRow}`;
const USAGE = "grant usage on schema itsupport to anon, authenticated";
/** One insert per new table, for the grant tests (staff ids differ from BASE). */
const INSERTS: Record<string, string> = {
  staff: staffRow("00000000-0000-4000-8000-0000000007a9"),
  helpdesk_tickets: hdRow({ id: "gen_random_uuid()", ticket_id: `'${SLACK}'` }),
  helpdesk_notes: noteRow({ author_kind: "'system'", author_staff_id: "null" }),
  helpdesk_assignments: assignRow,
  helpdesk_state_transitions:
    "insert into itsupport.helpdesk_state_transitions values ('closed', 'new')",
};
const UPDATES: Record<string, string> = {
  staff: "update itsupport.staff set active = false",
  helpdesk_tickets: "update itsupport.helpdesk_tickets set state = 'in_progress'",
  helpdesk_notes: "update itsupport.helpdesk_notes set body = 'changed'",
  helpdesk_assignments: "update itsupport.helpdesk_assignments set assigned_by_staff_id = null",
  helpdesk_state_transitions:
    "update itsupport.helpdesk_state_transitions set to_state = to_state where from_state = 'new'",
};
const review = (cols: string, values: string) =>
  `insert into itsupport.reviews (ticket_id, kind, wait_token_id, decided_at, ${cols})
   values ((select id from itsupport.tickets where idempotency_key = 'web:r'), 'triage', 'waitpoint_test_r',
     now(), ${values})`;
const withTicket = (sql: string) =>
  `${staffRow(STAFF)}; insert into itsupport.tickets (source, raw_title, raw_description,
     requester_email, idempotency_key)
   values ('web', 'Disk full', 'C: is full', 'demo.user@example.test', 'web:r'); ${sql}`;

/**
 * Runs `sql` with psql while a second session holds ACCESS SHARE on
 * itsupport.tickets. A 20 s session lock_timeout stops psql from waiting
 * forever (spawnSync blocks this process) if the file's own 5 s one is missing.
 */
const withTicketsLocked = async (sql: string) => {
  const other = clientFor(container!);
  other.on("error", () => undefined);
  await other.connect();
  try {
    await other.query("begin; lock table itsupport.tickets in access share mode");
    const started = Date.now();
    const result = runSql(container!, `\\set VERBOSITY verbose\nset lock_timeout = '20s';\n${sql}`);
    return { ...result, ms: Date.now() - started };
  } finally {
    await other.query("rollback").catch(() => undefined);
    await other.end().catch(() => undefined);
  }
};

beforeAll(async () => {
  container = await startPgContainer();
  db = clientFor(container);
  // A dropped connection emits "error"; without a listener it would crash the run.
  db.on("error", (error) => console.error("migration-0007 db client error:", error));
  await db.connect();
  await db.query(`create schema itsupport; ${DEFAULTS}`);
  for (const name of PRIOR) applied(read(`migrations/${name}.sql`));
  await db.query(SEED);
  shapes = (
    await db.query<Shape>(`
      select c.relname as name,
        (select string_agg(quote_ident(a.attname), ', ' order by k.ord)
         from pg_catalog.pg_index i
         cross join lateral unnest(i.indkey::int2[]) with ordinality as k (attnum, ord)
         join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
         where i.indrelid = c.oid and i.indisprimary) as pk,
        (select string_agg(quote_ident(a.attname), ', ' order by a.attnum)
         from pg_catalog.pg_attribute a
         where a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped) as cols
      from pg_catalog.pg_class c
      where c.relnamespace = 'itsupport'::regnamespace and c.relkind in ('r', 'p')
      order by 1`)
  ).rows;
  seeded = await tableRows();
  before = await catalog();
  for (const name of OLD) checksBefore[name] = await check(name);
});

afterAll(async () => {
  await db?.end().catch(() => undefined);
  removePgContainer(container);
});

describe("migration 0007 on 0001-0006 with phase-4 rows and Supabase-like default privileges", () => {
  it("the seed is phase-4-shaped: reviews decided in Slack, timed out and open", async () => {
    expect(seeded.reviews?.rows).toBe(4);
    expect(seeded.notifications?.rows).toBe(1);
    expect(seeded.tickets?.rows).toBe(4);
    const { rows } = await db.query(
      "select decision, slack_user_id is not null as slack from itsupport.reviews order by wait_token_id",
    );
    expect(rows).toEqual([
      { decision: "approve", slack: true },
      { decision: "reject", slack: true },
      { decision: "timeout", slack: false },
      { decision: null, slack: false },
    ]);
  });

  it("before 0007 every 0007 check row is ok = false; the 0003-0006 checks are all true", async () => {
    const rows = await check(M7);
    expect(rows).toHaveLength(97);
    expect(rows.filter((r) => r.ok)).toEqual([]);
    for (const name of OLD) expect(await notOk(name), name).toEqual([]);
    expect(await notOk4()).toEqual([]);
  });

  it("a held lock on tickets makes up fail with 55P03 after about 5 s; nothing is applied", async () => {
    const result = await withTicketsLocked(up);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/ERROR: {2}55P03: canceling statement due to lock timeout/);
    expect(result.ms).toBeGreaterThanOrEqual(4_500);
    expect(result.ms).toBeLessThan(15_000);
    expect(await catalog()).toEqual(before);
    expect(await tableRows()).toEqual(seeded);
  });

  it("up exits 0 on the populated reviews table: every column, every check row true, rows unchanged", async () => {
    applied(up);
    afterUp = await catalog();
    const { rows } = await db.query(
      `select table_name || '.' || column_name || ' ' || data_type || ' ' || is_nullable as c
       from information_schema.columns where table_schema = 'itsupport'
         and (table_name = any ($1) or column_name in ('helpdesk', 'staff_id'))
       order by table_name, ordinal_position`,
      [TABLES],
    );
    expect(rows.map((r) => r.c)).toEqual([
      "helpdesk_assignments.id uuid NO",
      "helpdesk_assignments.helpdesk_ticket_id uuid NO",
      "helpdesk_assignments.assignee_id uuid NO",
      "helpdesk_assignments.assigned_by_staff_id uuid YES",
      "helpdesk_assignments.at timestamp with time zone NO",
      "helpdesk_notes.id uuid NO",
      "helpdesk_notes.helpdesk_ticket_id uuid NO",
      "helpdesk_notes.author_kind text NO",
      "helpdesk_notes.author_staff_id uuid YES",
      "helpdesk_notes.body text NO",
      "helpdesk_notes.created_at timestamp with time zone NO",
      "helpdesk_state_transitions.from_state text NO",
      "helpdesk_state_transitions.to_state text NO",
      "helpdesk_tickets.id uuid NO",
      "helpdesk_tickets.ticket_id uuid NO",
      "helpdesk_tickets.seq integer NO",
      "helpdesk_tickets.number text NO",
      "helpdesk_tickets.state text NO",
      "helpdesk_tickets.priority text NO",
      "helpdesk_tickets.category text NO",
      "helpdesk_tickets.assignee_id uuid YES",
      "helpdesk_tickets.created_at timestamp with time zone NO",
      "helpdesk_tickets.updated_at timestamp with time zone NO",
      "reviews.staff_id uuid YES",
      "staff.id uuid NO",
      "staff.auth_user_id uuid NO",
      "staff.email text NO",
      "staff.display_name text NO",
      "staff.role text NO",
      "staff.active boolean NO",
      "staff.created_at timestamp with time zone NO",
      "tickets.helpdesk text YES",
    ]);
    expect(await check(M7)).toHaveLength(97);
    expect(await notOk(M7)).toEqual([]);
    expect(await tableRows()).toEqual(seeded);
  });

  it("up twice exits 0; after 0007 the 0003, 0004, 0005 and 0006 checks stay all ok = true", async () => {
    applied(up);
    expect(await catalog()).toEqual(afterUp);
    expect(await tableRows()).toEqual(seeded);
    expect(await notOk(M7)).toEqual([]);
    for (const name of OLD) expect(await notOk(name), name).toEqual([]);
    expect(await notOk4()).toEqual([]);
  });

  it("helpdesk_state_transitions holds exactly the G3 pairs", async () => {
    const { rows } = await db.query(
      `select from_state || ' > ' || to_state as p from itsupport.helpdesk_state_transitions
       order by from_state collate "C", to_state collate "C"`,
    );
    expect(rows.map((r) => r.p)).toEqual([
      "in_progress > on_hold",
      "in_progress > resolved",
      "new > closed",
      "new > in_progress",
      "new > on_hold",
      "new > resolved",
      "on_hold > in_progress",
      "on_hold > resolved",
      "resolved > closed",
      "resolved > in_progress",
    ]);
  });

  it("service_role's helpdesk tickets get HD0000001 and HD0000002 from the identity, with state new", async () => {
    // The identity restarts at 1 first (rolled back), so the numbers do not depend on test order.
    const r = await attempt(
      `${BASE}; ${hdRow({ id: "gen_random_uuid()", ticket_id: `'${SLACK}'` })};
       select number, state from itsupport.helpdesk_tickets order by seq`,
      "service_role",
      "alter table itsupport.helpdesk_tickets alter column seq restart with 1",
    );
    expect(r).toEqual({
      ok: true,
      rows: [
        { number: "HD0000001", state: "new" },
        { number: "HD0000002", state: "new" },
      ],
    });
  });

  it("a second helpdesk ticket for one ticket_id, a reused email or auth user fails with 23505", async () => {
    expect(await attempt(`${BASE}; ${hdRow({ id: "gen_random_uuid()" })}`, "service_role")).toEqual(
      fails("23505", "helpdesk_tickets_ticket_id_key"),
    );
    const other = "00000000-0000-4000-8000-0000000007a3";
    expect(
      await attempt(`${BASE}; ${staffRow(other, { email: `'staff-7a1@example.test'` })}`),
    ).toEqual(fails("23505", "staff_email_key"));
    expect(
      await attempt(
        `${BASE}; ${staffRow(other, { auth_user_id: `(select auth_user_id from itsupport.staff where id = '${STAFF}')` })}`,
      ),
    ).toEqual(fails("23505", "staff_auth_user_id_key"));
  });

  it("each invalid row fails with 23514 from its own check", async () => {
    const bad: [string, string][] = [
      [hdRow({ state: "'open'" }), "helpdesk_tickets_state_check"],
      [hdRow({ category: "'printer'" }), "helpdesk_tickets_category_check"],
      [hdRow({ priority: "'P5'" }), "helpdesk_tickets_priority_check"],
      [staffRow(ADMIN, { role: "'owner'" }), "staff_role_check"],
      [staffRow(ADMIN, { email: "'Admin@example.test'" }), "staff_email_check"],
      [
        noteRow({ author_kind: "'bot'", author_staff_id: "null" }),
        "helpdesk_notes_author_kind_check",
      ],
      [noteRow({ author_kind: "'system'" }), "helpdesk_notes_author_check"],
      [noteRow({ author_staff_id: "null" }), "helpdesk_notes_author_check"],
      [noteRow({ body: "''" }), "helpdesk_notes_body_check"],
      [noteRow({ body: "repeat('x', 5001)" }), "helpdesk_notes_body_check"],
      [
        "insert into itsupport.helpdesk_state_transitions values ('new', 'reopened')",
        "helpdesk_state_transitions_to_state_check",
      ],
      [
        "insert into itsupport.helpdesk_state_transitions values ('done', 'new')",
        "helpdesk_state_transitions_from_state_check",
      ],
      [
        `update itsupport.tickets set helpdesk = 'jira' where id = '${OPEN}'`,
        "tickets_helpdesk_check",
      ],
    ];
    const prep = `${staffRow(STAFF)}; ${hdRow()}`;
    for (const [sql, name] of bad)
      expect(await attempt(sql, "service_role", prep), sql).toEqual(fails("23514", name));
    // The boundaries pass: a 5000-character note, a builtin ticket, a system note.
    expect(
      await attempt(
        `${noteRow({ body: "repeat('x', 5000)" })};
         ${noteRow({ author_kind: "'system'", author_staff_id: "null" })};
         update itsupport.tickets set helpdesk = 'builtin' where id = '${OPEN}'`,
        "service_role",
        prep,
      ),
    ).toEqual(passes);
  });

  it("a number outside HD + 7 digits fails with 23514; past 9999999 the identity fails with 2200H", async () => {
    // Only `overriding system value` can set seq; the generated number never cuts digits.
    for (const seq of ["-1", "10000000"])
      expect(
        await attempt(
          `insert into itsupport.helpdesk_tickets (ticket_id, seq, priority, category)
           overriding system value values ('${OPEN}', ${seq}, 'P3', 'network')`,
        ),
        seq,
      ).toEqual(fails("23514", "helpdesk_tickets_number_check"));
    expect(
      await attempt(
        `alter table itsupport.helpdesk_tickets alter column seq restart with 9999999;
         ${hdRow()}; ${hdRow({ id: "gen_random_uuid()", ticket_id: `'${SLACK}'` })}`,
      ),
    ).toEqual(fails("2200H"));
    expect(
      await attempt(
        `alter table itsupport.helpdesk_tickets alter column seq restart with 9999999;
         ${hdRow()}; select number from itsupport.helpdesk_tickets`,
      ),
    ).toEqual({ ok: true, rows: [{ number: "HD9999999" }] });
    expect(
      await attempt(
        `insert into itsupport.helpdesk_tickets (ticket_id, seq, priority, category)
         values ('${OPEN}', 5, 'P3', 'network')`,
        "service_role",
      ),
    ).toEqual(fails("428C9"));
  });

  it("a review approve or reject names exactly one of slack_user_id and staff_id; timeout and open name neither", async () => {
    const staff = `'${STAFF}'`;
    const ok: [string, string][] = [
      ["decision, slack_user_id", "'approve', 'U000TEST09'"],
      ["decision, staff_id", `'approve', ${staff}`],
      ["decision, staff_id", `'reject', ${staff}`],
      ["decision, slack_user_id", "'reject', 'U000TEST09'"],
      ["decision", "'timeout'"],
    ];
    for (const [cols, values] of ok)
      expect(await attempt(withTicket(review(cols, values)), "service_role"), values).toEqual(
        passes,
      );
    const bad: [string, string][] = [
      ["decision, slack_user_id, staff_id", `'approve', 'U000TEST09', ${staff}`],
      ["decision, slack_user_id, staff_id", `'reject', 'U000TEST09', ${staff}`],
      ["decision", "'approve'"],
      ["decision", "'reject'"],
      ["decision, staff_id", `'timeout', ${staff}`],
      ["decision, slack_user_id", "'timeout', 'U000TEST09'"],
    ];
    for (const [cols, values] of bad)
      expect(await attempt(withTicket(review(cols, values)), "service_role"), values).toEqual(
        fails("23514", "reviews_decided_by_check"),
      );
    // An open review (no decision, no decided_at) with a decider fails too.
    expect(
      await attempt(
        withTicket(review("staff_id", staff).replace("now(), ", "null, ")),
        "service_role",
      ),
    ).toEqual(fails("23514", "reviews_decided_by_check"));
    expect(
      await attempt(withTicket(review("decision, staff_id", "'approve', gen_random_uuid()"))),
    ).toEqual(fails("23503", "reviews_staff_id_fkey"));
    // The phase 4 path still works: decideReview's compare-and-set on the open seeded row.
    expect(
      await attempt(
        `update itsupport.reviews set decision = 'approve', slack_user_id = 'U000TEST01', decided_at = now()
         where ticket_id = '${OPEN}' and decision is null returning decision`,
        "service_role",
      ),
    ).toEqual({ ok: true, rows: [{ decision: "approve" }] });
  });

  it("UPDATE, DELETE and TRUNCATE on helpdesk_notes and helpdesk_assignments fail for every role", async () => {
    // Every role gets every right and a policy that shows every row first (rolled
    // back), so only the trigger can refuse.
    const grantAll = (table: string) =>
      `${BASE}; ${USAGE}; grant all on itsupport.${table} to public, anon, authenticated, service_role;
       create policy probe on itsupport.${table} to public using (true) with check (true)`;
    for (const table of LOGS)
      for (const role of [undefined, "service_role", "authenticated", "anon"]) {
        const who = `${role ?? "postgres"} ${table}`;
        expect(
          await attempt(`update itsupport.${table} set id = id`, role, grantAll(table)),
          who,
        ).toEqual(appendOnly(table, "UPDATE"));
        expect(await attempt(`delete from itsupport.${table}`, role, grantAll(table)), who).toEqual(
          appendOnly(table, "DELETE"),
        );
        expect(await attempt(`truncate itsupport.${table}`, role, grantAll(table)), who).toEqual(
          appendOnly(table, "TRUNCATE"),
        );
      }
  });

  it("the append-only triggers are enabled ALWAYS: they refuse under session_replication_role = replica", async () => {
    const { rows } = await db.query(
      `select tgname, tgenabled from pg_catalog.pg_trigger
       where tgfoid = 'itsupport.reject_helpdesk_log_change()'::regprocedure order by tgname`,
    );
    expect(rows).toEqual(
      [
        "helpdesk_assignments_append_only_row",
        "helpdesk_assignments_append_only_truncate",
        "helpdesk_notes_append_only_row",
        "helpdesk_notes_append_only_truncate",
      ].map((tgname) => ({ tgname, tgenabled: "A" })),
    );
    const replica = `${BASE}; set local session_replication_role = replica`;
    for (const table of LOGS) {
      expect(await attempt(`update itsupport.${table} set id = id`, undefined, replica)).toEqual(
        appendOnly(table, "UPDATE"),
      );
      expect(await attempt(`delete from itsupport.${table}`, undefined, replica)).toEqual(
        appendOnly(table, "DELETE"),
      );
      expect(await attempt(`truncate itsupport.${table}`, undefined, replica)).toEqual(
        appendOnly(table, "TRUNCATE"),
      );
    }
  });

  it("anon and authenticated get 42501 on every new table; service_role selects, inserts and updates but cannot delete", async () => {
    for (const table of TABLES) {
      for (const role of ["anon", "authenticated"])
        for (const sql of [
          `select * from itsupport.${table}`,
          INSERTS[table]!,
          UPDATES[table]!,
          `delete from itsupport.${table}`,
          `truncate itsupport.${table}`,
        ])
          expect(await attempt(sql, role, `${BASE}; ${USAGE}`), `${role}: ${sql}`).toEqual(denied);
      expect(
        await attempt(`select count(*)::int as n from itsupport.${table}`, "service_role", BASE),
        table,
      ).toEqual({
        ok: true,
        rows: [{ n: table === "helpdesk_state_transitions" ? 10 : table === "staff" ? 2 : 1 }],
      });
      expect(await attempt(INSERTS[table]!, "service_role", BASE), table).toEqual(passes);
      expect(await attempt(UPDATES[table]!, "service_role", BASE), table).toEqual(
        LOGS.includes(table) ? appendOnly(table, "UPDATE") : passes,
      );
      expect(await attempt(`delete from itsupport.${table}`, "service_role", BASE), table).toEqual(
        denied,
      );
    }
    // The append-only tables still hold UPDATE (as the grant says); the trigger refuses it.
    const { rows } = await db.query(
      `select t from unnest($1::text[]) t where not has_table_privilege('service_role', 'itsupport.' || t, 'update')`,
      [LOGS],
    );
    expect(rows).toEqual([]);
  });

  it("no role holds a right on the identity sequence; the 0004 check stays all true", async () => {
    const { rows } = await db.query(
      `select r, p from unnest(array['public', 'anon', 'authenticated', 'service_role']) r,
         unnest(array['usage', 'select', 'update']) p
       where has_sequence_privilege(r, 'itsupport.helpdesk_tickets_seq_seq', p)`,
    );
    expect(rows).toEqual([]);
    expect(
      await attempt("select nextval('itsupport.helpdesk_tickets_seq_seq')", "service_role"),
    ).toEqual(fails("42501"));
    expect(await notOk4()).toEqual([]);
  });

  it("the 0007 check flips the matching row when a right comes back or an object changes", async () => {
    const variants: [string, string[]][] = [
      [
        "grant delete on itsupport.staff to service_role",
        ["grants itsupport.staff", "privileges service_role itsupport.staff"],
      ],
      [
        "grant select (id) on itsupport.helpdesk_notes to authenticated",
        ["grants itsupport.helpdesk_notes", "privileges authenticated itsupport.helpdesk_notes"],
      ],
      [
        "grant usage on sequence itsupport.helpdesk_tickets_seq_seq to service_role",
        ["grants itsupport.helpdesk_tickets_seq_seq"],
      ],
      [
        "create policy p on itsupport.helpdesk_tickets for select to authenticated using (true)",
        ["rls itsupport.helpdesk_tickets"],
      ],
      [
        "drop trigger helpdesk_assignments_append_only_row on itsupport.helpdesk_assignments",
        ["triggers itsupport.helpdesk_assignments"],
      ],
      [
        "alter table itsupport.helpdesk_notes disable trigger helpdesk_notes_append_only_row",
        ["triggers itsupport.helpdesk_notes"],
      ],
      [
        // ORIGIN (tgenabled 'O'): skipped under session_replication_role = replica.
        "alter table itsupport.helpdesk_assignments enable trigger helpdesk_assignments_append_only_truncate",
        ["triggers itsupport.helpdesk_assignments"],
      ],
      [
        "alter table itsupport.helpdesk_notes enable replica trigger helpdesk_notes_append_only_truncate",
        ["triggers itsupport.helpdesk_notes"],
      ],
      [
        "delete from itsupport.helpdesk_state_transitions where from_state = 'resolved' and to_state = 'closed'",
        ["transitions itsupport.helpdesk_state_transitions"],
      ],
      [
        "insert into itsupport.helpdesk_state_transitions values ('closed', 'new')",
        ["transitions itsupport.helpdesk_state_transitions"],
      ],
      [
        "alter function itsupport.reject_helpdesk_log_change() security definer",
        ["function itsupport.reject_helpdesk_log_change()"],
      ],
      [
        "grant execute on function itsupport.reject_helpdesk_log_change() to service_role",
        ["function itsupport.reject_helpdesk_log_change()"],
      ],
      [
        "alter table itsupport.helpdesk_tickets alter column seq set maxvalue 99999999",
        ["sequence itsupport.helpdesk_tickets_seq_seq"],
      ],
      ["alter table itsupport.staff alter column active drop default", ["columns itsupport.staff"]],
      [
        "create index probe_idx on itsupport.helpdesk_notes (helpdesk_ticket_id)",
        ["indexes itsupport.helpdesk_notes"],
      ],
      [
        "alter table itsupport.reviews alter column staff_id set default gen_random_uuid()",
        ["column itsupport.reviews.staff_id"],
      ],
      [
        "alter table itsupport.helpdesk_notes drop constraint helpdesk_notes_body_check",
        [
          "constraint itsupport.helpdesk_notes.helpdesk_notes_body_check",
          "constraints itsupport.helpdesk_notes",
        ],
      ],
      [
        "alter table itsupport.reviews drop constraint reviews_decided_by_check",
        ["checks itsupport.reviews", "constraint itsupport.reviews.reviews_decided_by_check"],
      ],
      [
        `alter table itsupport.reviews add constraint reviews_slack_user_check
           check (((decision in ('approve', 'reject')) is true) = (slack_user_id is not null))`,
        ["checks itsupport.reviews"],
      ],
    ];
    for (const [sql, wrong] of variants)
      expect((await notOkAfter(sql)).sort(), sql).toEqual(wrong.sort());
  });

  it("the 0005 check accepts 0007's reviews changes only: anything else on reviews turns it false", async () => {
    expect(
      await notOkAfter(
        "alter table itsupport.reviews add constraint reviews_probe_check check (true)",
        "0005_itsupport_reviews",
      ),
    ).toEqual(["checks itsupport.reviews"]);
    expect(
      await notOkAfter(
        "alter table itsupport.reviews add column probe text",
        "0005_itsupport_reviews",
      ),
    ).toEqual(["columns itsupport.reviews"]);
    expect(
      (
        await notOkAfter(
          "alter table itsupport.reviews drop constraint reviews_decided_by_check",
          "0005_itsupport_reviews",
        )
      ).sort(),
    ).toEqual(
      ["checks itsupport.reviews", "constraint itsupport.reviews.reviews_slack_user_check"].sort(),
    );
    // Each other 0005 constraint row still asks for its own constraint after 0007.
    expect(
      (
        await notOkAfter(
          "alter table itsupport.reviews drop constraint reviews_kind_check",
          "0005_itsupport_reviews",
        )
      ).sort(),
    ).toEqual(
      ["checks itsupport.reviews", "constraint itsupport.reviews.reviews_kind_check"].sort(),
    );
    expect(
      await notOkAfter(
        "alter table itsupport.reviews drop constraint reviews_pkey",
        "0005_itsupport_reviews",
      ),
    ).toEqual(["constraint itsupport.reviews.reviews_pkey"]);
    expect(
      await notOkAfter(
        "alter table itsupport.reviews drop constraint reviews_ticket_id_fkey",
        "0005_itsupport_reviews",
      ),
    ).toEqual(["constraint itsupport.reviews.reviews_ticket_id_fkey"]);
    expect(
      await notOkAfter(
        "alter table itsupport.tickets add constraint tickets_probe_check check (true)",
        "0003_itsupport_triage_kb",
      ),
    ).toEqual(["checks itsupport.tickets"]);
  });

  it("down fails with 23514 and changes nothing while a review was decided from the helpdesk", async () => {
    await db.query(`${staffRow(STAFF)};
      update itsupport.reviews set decision = 'reject', staff_id = '${STAFF}', decided_at = now()
      where ticket_id = '${OPEN}'`);
    const result = runSql(container!, `\\set VERBOSITY verbose\n${down}`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(
      /ERROR: {2}23514: check constraint "reviews_slack_user_check" of relation "reviews" is violated by some row/,
    );
    expect(await catalog()).toEqual(afterUp);
    await db.query(`update itsupport.reviews set decision = null, staff_id = null, decided_at = null
      where ticket_id = '${OPEN}'; delete from itsupport.staff`);
    expect(await tableRows()).toEqual(seeded);
  });

  it("a held lock on tickets makes down fail with 55P03; nothing is removed", async () => {
    const result = await withTicketsLocked(down);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/ERROR: {2}55P03: canceling statement due to lock timeout/);
    expect(result.ms).toBeGreaterThanOrEqual(4_500);
    expect(result.ms).toBeLessThan(15_000);
    expect(await catalog()).toEqual(afterUp);
  });

  it("down (twice) exits 0 and removes only 0007: every 0001-0006 object, row and check as before", async () => {
    for (const sql of [down, down]) {
      applied(sql);
      expect(await catalog()).toEqual(before);
      expect(await tableRows()).toEqual(seeded);
      for (const name of OLD) expect(await check(name), name).toEqual(checksBefore[name]);
      const rows = await check(M7);
      expect(rows).toHaveLength(97);
      expect(rows.filter((r) => r.ok)).toEqual([]);
      for (const table of TABLES)
        expect(await exists(`to_regclass('itsupport.${table}') is null`), table).toBe(true);
    }
  });

  it("a failure late in the up file leaves nothing behind (one transaction)", async () => {
    const lf = up.replace(/\r\n/g, "\n");
    const at = lf.lastIndexOf("revoke all on sequence itsupport.helpdesk_tickets_seq_seq");
    expect(at).toBeGreaterThan(lf.indexOf("add constraint reviews_decided_by_check"));
    const result = runSql(container!, `${lf.slice(0, at)}select 1 / 0;\n${lf.slice(at)}`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/division by zero/);
    expect(await catalog()).toEqual(before);
    expect(await tableRows()).toEqual(seeded);
  });

  it("up after down: every check true, the rows unchanged, the seeded reviews still valid", async () => {
    applied(up);
    expect(await catalog()).toEqual(afterUp);
    expect(await tableRows()).toEqual(seeded);
    expect(await notOk(M7)).toEqual([]);
    for (const name of OLD) expect(await notOk(name), name).toEqual([]);
    expect(await notOk4()).toEqual([]);
    expect(await attempt(BASE, "service_role")).toEqual(passes);
  });

  it("0001's down file still removes the whole schema with 0007 applied", async () => {
    applied(read("migrations/0001_itsupport_foundation.down.sql"));
    expect(await exists("to_regnamespace('itsupport') is null")).toBe(true);
  });
});
