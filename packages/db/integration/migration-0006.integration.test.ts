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

// Migration 0006: itsupport.notifications, the index on
// tickets.servicenow_sys_id and the ticket number (P5-T1a), and the backfill
// that numbers existing tickets (P5-T1b). 0001 to 0005 are applied first, with
// Supabase-like default privileges set before 0001, then phase-4-shaped rows
// are seeded (SEED: three tickets, triaged with route auto, approved and
// rejected, two of them with one created_at; their redactions, triage rows and
// events, one decided review, ai_calls and security_events rows; the approved
// one has a ServiceNow incident). So 0006 runs on data as H28b will (T5.I.07,
// T5.I.09): the whole up file, the whole down file and the up file again, with
// the row count and an md5 of every table's pre-0006 columns compared after
// each step. All data is fake (the repo is public): example.test addresses,
// U000TEST Slack user IDs, fixed test UUIDs, waitpoint_test_* tokens.

const dir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../supabase");
const read = (file: string) => readFileSync(resolve(dir, file), "utf8");
const M = ["0001_itsupport_foundation", "0002_itsupport_intake", "0003_itsupport_triage_kb"];
const M4 = "0004_itsupport_lock_sequences";
const M5 = "0005_itsupport_reviews";
const M6 = "0006_itsupport_helpdesk";
const up = read(`migrations/${M6}.sql`);
const down = read(`migrations/${M6}.down.sql`);
const ROLES = ["public", "anon", "authenticated", "service_role"];
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
  { ok: true; rows: Record<string, unknown>[] } | { ok: false; code?: string; constraint?: string };
/** Runs `sql` in a transaction that is always rolled back; `prep` runs as postgres before `set local role`. */
const attempt = async (sql: string, role?: string, prep = ""): Promise<Attempt> => {
  await db.query("begin");
  try {
    if (prep) await db.query(prep);
    if (role) await db.query(`set local role ${role}`);
    const result = await db.query(sql);
    return { ok: true, rows: (Array.isArray(result) ? result.at(-1) : result).rows };
  } catch (error) {
    const { code, constraint } = error as Record<string, string | undefined>;
    return { ok: false, code, constraint };
  } finally {
    await db.query("rollback");
  }
};
const fails = (code: string, constraint?: string) =>
  expect.objectContaining({ ok: false, code, ...(constraint ? { constraint } : {}) });
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
/**
 * The 0004 check with this file's Supabase-like defaults revoked (rolled back):
 * its two default-privilege rows are false while they are in place (as in the
 * 0004 test), so this asks the sequence rows and the stack's real defaults.
 */
const notOk4 = async () => {
  await db.query("begin");
  try {
    await db.query(DEFAULTS.replace(/grant all on (\w+) to/g, "revoke all on $1 from"));
    const { rows } = await db.query<{ object: string; ok: boolean }>(
      read(`checks/${M4}.check.sql`),
    );
    return rows.filter((r) => !r.ok).map((r) => r.object);
  } finally {
    await db.query("rollback");
  }
};
const exists = async (sql: string) => (await db.query(`select (${sql}) as e`)).rows[0].e as boolean;
/** Another connection as postgres, with an error listener (a dropped connection must not crash the run). */
const connect = async (name: string) => {
  const c = clientFor(container!);
  c.on("error", (error) => console.error(`migration-0006 ${name} client error:`, error));
  await c.connect();
  return c;
};
/** Runs `body` while another client holds ACCESS SHARE on itsupport.tickets, as a long select would. */
const whileLocked = async <T>(body: () => Promise<T> | T): Promise<T> => {
  const holder = await connect("holder");
  try {
    await holder.query("begin; lock table itsupport.tickets in access share mode");
    return await body();
  } finally {
    await holder.query("rollback").catch(() => undefined);
    await holder.end().catch(() => undefined);
  }
};
const timed = async <T>(body: () => Promise<T> | T) => {
  const start = Date.now();
  const result = await body();
  return { result, ms: Date.now() - start };
};
// Only bounds a run whose lock_timeout is missing: it then fails with 57014, not 55P03.
const GUARD = "set local statement_timeout = '20s';\n";
/** psql --single-transaction while tickets is locked; VERBOSITY prints the SQLSTATE. */
const lockedRun = (sql: string) =>
  whileLocked(() => timed(() => runSql(container!, `\\set VERBOSITY verbose\n${GUARD}${sql}`)));
const LOCK_TIMEOUT = /ERROR: +55P03: canceling statement due to lock timeout/;

// Fixed ids: the approved ticket's id sorts before the auto one's, the reverse
// of their insert order, so only an id tie-break numbers them as expected.
const AUTO = "00000000-0000-4000-8000-000000000602";
const APPROVED = "00000000-0000-4000-8000-000000000601";
const REJECTED = "00000000-0000-4000-8000-000000000603";
const SYS_ID = "0123456789abcdef0123456789abcdef";
/** Phase-4-shaped rows, written the way intake, triage and the review flow write them. */
const SEED = `
  insert into itsupport.tickets (id, source, raw_title, raw_description, requester_email,
      idempotency_key, status, servicenow_sys_id, servicenow_number, created_at) values
    ('${AUTO}', 'web', 'VPN down', 'Cannot connect to VPN', 'demo.user@example.test',
     'web:seed-auto', 'triaged', null, null, timestamptz '2026-10-20 01:00:00+00'),
    ('${APPROVED}', 'email', 'Printer jam', 'Tray 2 jams', 'demo.other@example.test',
     'email:seed-approved', 'approved', '${SYS_ID}', 'INC0010001', timestamptz '2026-10-20 01:00:00+00'),
    ('${REJECTED}', 'web', 'New laptop', 'Please send a laptop', 'demo.third@example.test',
     'web:seed-rejected', 'rejected', null, null, timestamptz '2026-10-19 23:00:00+00');
  insert into itsupport.ticket_redactions (ticket_id, redacted_title, redacted_description)
    select id, raw_title, raw_description from itsupport.tickets;
  insert into itsupport.triage_results (ticket_id, sensitive, sensitive_flags, checker, category,
      priority, route, triaged_at)
    select id, false, '[]'::jsonb, 'keywords+typesafe', 'network', 'P3',
      case id when '${AUTO}' then 'auto' else 'review' end, created_at + interval '1 minute'
    from itsupport.tickets;
  insert into itsupport.ticket_events (ticket_id, type, payload)
    select t.id, e.type, '{}'::jsonb from itsupport.tickets t,
      unnest(array['received', 'redacted', 'sensitive_checked', 'triaged']) as e (type)
    order by t.id;
  insert into itsupport.reviews (ticket_id, kind, slack_user_id, decision, decided_at, wait_token_id)
    values ('${APPROVED}', 'triage', 'U000TEST01', 'approve', timestamptz '2026-10-20 02:00:00+00',
      'waitpoint_test_seed');
  insert into itsupport.ai_calls (ticket_id, provider, kind, calls, cost_usd, environment, at)
    select id, 'typesafe', 'triage_judgments', 4, 0.004, 'staging', created_at from itsupport.tickets;
  insert into itsupport.security_events (source, kind, window_start, count, sample) values
    ('internal_api', 'bad_token', timestamptz '2026-10-20 00:58:00+00', 3, '{"method": "POST"}');
`;

type Shape = { name: string; pk: string | null; cols: string };
/** Every itsupport table with its primary key and columns, taken before 0006. */
let shapes: Shape[] = [];
type TableRows = Record<string, { rows: number; md5: string }>;
/** Row count and an md5 of each table's pre-0006 columns, rows ordered by primary key. */
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
/** The seeded tickets' numbers, in created_at and id order. */
const numbers = async () =>
  (
    await db.query<{ key: string; n: string }>(
      `select idempotency_key as key, ticket_number as n from itsupport.tickets
       where idempotency_key like '%seed-%' order by created_at, id`,
    )
  ).rows;
const NUMBERED = [
  { key: "web:seed-rejected", n: "ITS-000001" },
  { key: "email:seed-approved", n: "ITS-000002" },
  { key: "web:seed-auto", n: "ITS-000003" },
];
const seq = async () =>
  (await db.query("select last_value::int as v, is_called as c from itsupport.ticket_number_seq"))
    .rows[0] as { v: number; c: boolean };
/** Sets the sequence for `body`, then puts it back exactly (setval is not rolled back). */
const withSeq = async (v: number, body: () => Promise<void>) => {
  const saved = await seq();
  try {
    await db.query("select setval('itsupport.ticket_number_seq', $1, true)", [v]);
    await body();
  } finally {
    await db.query("select setval('itsupport.ticket_number_seq', $1, $2)", [saved.v, saved.c]);
  }
  expect(await seq()).toEqual(saved);
};
let seeded: TableRows = {};

/** A ticket insert; without `number` the default numbers it. */
const ticket = (key: string, number?: string) =>
  `insert into itsupport.tickets (source, raw_title, raw_description, requester_email, idempotency_key` +
  `${number === undefined ? "" : ", ticket_number"}) values ('web', 'VPN down', 'No VPN', ` +
  `'demo.user@example.test', '${key}'${number === undefined ? "" : `, ${number}`}) returning ticket_number`;
const T = "(select id from itsupport.tickets where idempotency_key = 'web:n-1')";
const withTicket = (sql: string) => `${ticket("web:n-1", "'ITS-900001'")}; ${sql}`;
const note = (cols: Record<string, string> = {}) => {
  const row = {
    ticket_id: T,
    channel: "'email'",
    kind: "'incident_reply'",
    status: "'sent'",
    ...cols,
  };
  if (row.status === "'sent'" && !("provider_id" in cols))
    Object.assign(row, { provider_id: "'re_msg_1'" });
  return `insert into itsupport.notifications (${Object.keys(row).join(", ")}) values (${Object.values(row).join(", ")})`;
};

/** Every 0001-0005 object in itsupport, with owner, ACL, columns, constraints, indexes and functions. */
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
      select 'fn ' || p.oid::regprocedure::text || ' ' || coalesce(p.proacl::text, '-')
      from pg_catalog.pg_proc p where p.pronamespace = 'itsupport'::regnamespace
      order by 1`)
  ).rows.map((r) => r.item);

let before: string[] = [];
const checksBefore: Record<string, unknown> = {};
const OLD = ["0003_itsupport_triage_kb", M4, M5];

beforeAll(async () => {
  container = await startPgContainer();
  db = clientFor(container);
  // A dropped connection emits "error"; without a listener it would crash the run.
  db.on("error", (error) => console.error("migration-0006 db client error:", error));
  await db.connect();
  await db.query(`create schema itsupport; ${DEFAULTS}`);
  for (const name of [...M, M4, M5]) applied(read(`migrations/${name}.sql`));
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

describe("migration 0006 on 0001-0005 with phase-4 rows and Supabase-like default privileges", () => {
  it("the seed is phase-4-shaped: every pre-0006 table holds rows", () => {
    expect(
      Object.fromEntries(Object.entries(seeded).map(([name, { rows }]) => [name, rows])),
    ).toEqual({
      tickets: 3,
      ticket_redactions: 3,
      triage_results: 3,
      ticket_events: 12,
      reviews: 1,
      kb_articles: 0,
      ai_calls: 3,
      security_events: 1,
    });
  });

  it("before 0006 every check row is ok = false; the 0003-0005 checks are all true", async () => {
    expect((await check(M6)).filter((r) => r.ok)).toEqual([]);
    for (const name of ["0003_itsupport_triage_kb", M5])
      expect(await notOk(name), name).toEqual([]);
    expect(await notOk4()).toEqual([]);
  });

  it("while another client holds a lock on tickets, up fails with 55P03 within about 5 s and leaves nothing behind", async () => {
    const psql = await lockedRun(up);
    expect(psql.result.status).not.toBe(0);
    expect(psql.result.stderr).toMatch(LOCK_TIMEOUT);
    // One simple-protocol query without begin, as Supabase Studio sends a script:
    // Postgres runs it as one implicit transaction, in which `set local` holds.
    const studio = await connect("studio");
    try {
      await studio.query("set statement_timeout = '20s'");
      const run = await whileLocked(() =>
        timed(() =>
          studio.query(up).then(
            () => ({ code: "none" }),
            (error: { code?: string }) => ({ code: error.code }),
          ),
        ),
      );
      expect(run.result).toEqual({ code: "55P03" });
      for (const ms of [psql.ms, run.ms]) {
        expect(ms).toBeGreaterThanOrEqual(4_500);
        expect(ms).toBeLessThan(10_000);
      }
    } finally {
      await studio.end().catch(() => undefined);
    }
    expect(await catalog()).toEqual(before);
    expect(await tableRows()).toEqual(seeded);
    expect((await check(M6)).filter((r) => r.ok)).toEqual([]);
  });

  it("up numbers the seeded tickets ITS-000001 upwards in created_at, then id order", async () => {
    applied(up);
    expect(await numbers()).toEqual(NUMBERED);
    expect(await seq()).toEqual({ v: 3, c: true });
    expect(await tableRows()).toEqual(seeded);
  });

  it("a second up changes no number and does not move the sequence, even when it is ahead", async () => {
    applied(up);
    expect(await numbers()).toEqual(NUMBERED);
    expect(await seq()).toEqual({ v: 3, c: true });
    expect(await tableRows()).toEqual(seeded);
    // Numbers taken by rolled-back inserts leave the sequence ahead of the highest number.
    await withSeq(40, async () => {
      applied(up);
      expect(await seq()).toEqual({ v: 40, c: true });
      expect(await numbers()).toEqual(NUMBERED);
      expect(await tableRows()).toEqual(seeded);
    });
  });

  it("up (twice) exits 0: 8 columns, the index, every check row true", async () => {
    const { rows } = await db.query(
      `select column_name, data_type, is_nullable from information_schema.columns
       where table_schema = 'itsupport' and table_name = 'notifications' order by ordinal_position`,
    );
    expect(rows.map((r) => Object.values(r).join(" "))).toEqual([
      "id uuid NO",
      "ticket_id uuid NO",
      "channel text NO",
      "kind text NO",
      "status text NO",
      "provider_id text YES",
      "reason text YES",
      "at timestamp with time zone NO",
    ]);
    expect(
      await exists(
        "select count(*) = 1 from pg_indexes where indexname = 'tickets_servicenow_sys_id_idx'",
      ),
    ).toBe(true);
    expect(await check(M6)).toHaveLength(26);
    expect(await notOk(M6)).toEqual([]);
    // After 0001-0006 the 0003, 0004 and 0005 checks stay all ok = true (H28b runs them all).
    expect(await notOk4()).toEqual([]);
    expect(await notOk(M5)).toEqual([]);
    expect(await notOk("0003_itsupport_triage_kb")).toEqual([]);
  });

  it("while another client holds a lock on tickets, down fails with 55P03 and 0006 stays in place", async () => {
    const run = await lockedRun(down);
    expect(run.result.status).not.toBe(0);
    expect(run.result.stderr).toMatch(LOCK_TIMEOUT);
    expect(run.ms).toBeLessThan(10_000);
    expect(await notOk(M6)).toEqual([]);
    expect(await numbers()).toEqual(NUMBERED);
  });

  it("the 0003 tickets checks row accepts the format check only: any other new check turns it false", async () => {
    const r = await attempt(
      `alter table itsupport.tickets add constraint tickets_probe_check check (true);
       select object from (${read("checks/0003_itsupport_triage_kb.check.sql").replace(/;\s*$/, "")}) c
       where not ok`,
    );
    expect(r).toEqual({ ok: true, rows: [{ object: "checks itsupport.tickets" }] });
  });

  it("the next service_role tickets get ITS-000004, ITS-000005, ITS-000006 from the default", async () => {
    const r = await attempt(
      `${ticket("web:a")}; ${ticket("web:b")}; ${ticket("web:c")};
       select ticket_number from itsupport.tickets where idempotency_key like 'web:_' order by 1`,
      "service_role",
    );
    expect(r).toEqual({
      ok: true,
      rows: ["ITS-000004", "ITS-000005", "ITS-000006"].map((n) => ({ ticket_number: n })),
    });
  });

  it("bad, duplicate and null ticket numbers fail with 23514, 23505 and 23502", async () => {
    for (const n of ["'ITS-1'", "'its-000004'", "'ITS-0000005'"])
      expect(await attempt(ticket("web:x", n), "service_role"), n).toEqual(
        fails("23514", "tickets_ticket_number_format"),
      );
    expect(
      await attempt(
        `${ticket("web:x", "'ITS-000777'")}; ${ticket("web:y", "'ITS-000777'")}`,
        "service_role",
      ),
    ).toEqual(fails("23505", "tickets_ticket_number_key"));
    expect(await attempt(ticket("web:x", "null"), "service_role")).toEqual(fails("23502"));
  });

  it("anon and authenticated get 42501 from next_ticket_number(); no role holds a right on the sequence", async () => {
    const usage = "grant usage on schema itsupport to anon, authenticated";
    for (const role of ["anon", "authenticated"])
      expect(await attempt("select itsupport.next_ticket_number()", role, usage), role).toEqual(
        fails("42501"),
      );
    expect(await attempt("select nextval('itsupport.ticket_number_seq')", "service_role")).toEqual(
      fails("42501"),
    );
    const { rows } = await db.query(
      `select r, p from unnest($1::text[]) r, unnest(array['usage', 'select', 'update']) p
       where has_sequence_privilege(r, 'itsupport.ticket_number_seq', p)`,
      [ROLES],
    );
    expect(rows).toEqual([]);
    expect(await notOk4()).toEqual([]);
  });

  it("at 999999 the last number is ITS-999999 and the next insert fails with 2200H", async () => {
    // withSeq restores last_value and is_called exactly, and checks it did.
    await withSeq(999998, async () => {
      const r = await attempt(ticket("web:max"), "service_role");
      expect(r).toEqual({ ok: true, rows: [{ ticket_number: "ITS-999999" }] });
      expect(await attempt(ticket("web:over"), "service_role")).toEqual(fails("2200H"));
      // No cycle: the sequence stays at its maximum after the failed insert.
      expect(await seq()).toEqual({ v: 999999, c: true });
    });
  });

  it("one email per ticket and kind: a second incident_reply fails with 23505, a needs_info inserts", async () => {
    expect(await attempt(withTicket(note()))).toEqual(passes);
    expect(await attempt(withTicket(`${note()}; ${note({ provider_id: "'re_msg_2'" })}`))).toEqual(
      fails("23505", "notifications_ticket_channel_kind_key"),
    );
    expect(await attempt(withTicket(`${note()}; ${note({ kind: "'needs_info'" })}`))).toEqual(
      passes,
    );
    expect(
      await attempt(withTicket(note({ status: "'skipped'", reason: "'not_allow_listed'" }))),
    ).toEqual(passes);
    expect(
      await attempt(withTicket(note({ status: "'failed'", reason: "'provider_error'" }))),
    ).toEqual(passes);
  });

  it("each invalid row fails with 23514 from its own check", async () => {
    const bad: [Record<string, string>, string][] = [
      [{ channel: "'sms'" }, "channel"],
      [{ kind: "'other'" }, "kind"],
      [{ status: "'queued'" }, "status"],
      [{ provider_id: "null" }, "sent"],
      [{ reason: "'provider_error'" }, "sent"],
      [{ status: "'skipped'", reason: "'provider_error'" }, "skipped"],
      [{ status: "'skipped'", reason: "'not_allow_listed'", provider_id: "'re_msg_1'" }, "skipped"],
      [{ status: "'skipped'" }, "skipped"],
      [{ status: "'failed'" }, "failed"],
    ];
    for (const [cols, name] of bad)
      expect(await attempt(withTicket(note(cols))), JSON.stringify(cols)).toEqual(
        fails("23514", `notifications_${name}_check`),
      );
  });

  it("an unknown ticket_id fails with 23503; deleting a ticket that has a notification fails with 23503", async () => {
    expect(await attempt(note({ ticket_id: "gen_random_uuid()" }))).toEqual(
      fails("23503", "notifications_ticket_id_fkey"),
    );
    expect(
      await attempt(
        withTicket(`${note()}; delete from itsupport.tickets where idempotency_key = 'web:n-1'`),
      ),
    ).toEqual(fails("23503", "notifications_ticket_id_fkey"));
  });

  it("anon and authenticated get 42501 on select and insert; service_role inserts, selects, updates but cannot delete", async () => {
    const usage = "grant usage on schema itsupport to anon, authenticated";
    for (const role of ["anon", "authenticated"])
      for (const sql of [
        "select * from itsupport.notifications",
        note({ ticket_id: "gen_random_uuid()" }),
      ])
        expect(await attempt(sql, role, usage), `${role}: ${sql}`).toEqual(fails("42501"));
    const prep = ticket("web:n-1", "'ITS-900001'");
    const sr = (sql: string) => attempt(`${note()}; ${sql}`, "service_role", prep);
    expect(await sr("select status from itsupport.notifications")).toEqual({
      ok: true,
      rows: [{ status: "sent" }],
    });
    expect(
      await sr("update itsupport.notifications set provider_id = 're_msg_9' returning provider_id"),
    ).toEqual({
      ok: true,
      rows: [{ provider_id: "re_msg_9" }],
    });
    expect(await sr("delete from itsupport.notifications")).toEqual(fails("42501"));
  });

  it("the check flips the matching row when a right comes back or a check is dropped", async () => {
    const variants: [string, string[]][] = [
      [
        "grant delete on itsupport.notifications to service_role",
        ["privileges service_role itsupport.notifications"],
      ],
      [
        "grant usage on sequence itsupport.ticket_number_seq to service_role",
        ["grants itsupport.ticket_number_seq"],
      ],
      [
        "grant execute on function itsupport.next_ticket_number() to anon",
        ["execute itsupport.next_ticket_number()"],
      ],
      [
        "alter table itsupport.tickets alter column ticket_number drop default",
        ["column itsupport.tickets.ticket_number"],
      ],
      [
        "alter function itsupport.next_ticket_number() security invoker",
        ["function itsupport.next_ticket_number()"],
      ],
      [
        `create or replace function itsupport.next_ticket_number() returns text language sql
         volatile security definer set search_path = '' as $$ select 'ITS-000001' $$`,
        ["function itsupport.next_ticket_number()"],
      ],
      [
        "grant create on schema itsupport to service_role; " +
          "alter function itsupport.next_ticket_number() owner to service_role",
        ["execute itsupport.next_ticket_number()", "function itsupport.next_ticket_number()"],
      ],
      [
        "grant select on itsupport.notifications to anon",
        ["privileges anon itsupport.notifications"],
      ],
      [
        "alter table itsupport.notifications drop constraint notifications_sent_check",
        ["constraint itsupport.notifications.notifications_sent_check"],
      ],
    ];
    for (const [sql, wrong] of variants) {
      await db.query("begin");
      try {
        await db.query(sql);
        const rows = (
          await db.query<{ object: string; ok: boolean }>(read(`checks/${M6}.check.sql`))
        ).rows;
        expect(
          rows.filter((r) => !r.ok).map((r) => r.object),
          sql,
        ).toEqual(wrong);
      } finally {
        await db.query("rollback");
      }
    }
  });

  it("with notification rows for seeded tickets, the pre-0006 rows are still unchanged", async () => {
    await db.query(`insert into itsupport.notifications (ticket_id, channel, kind, status, provider_id, reason)
      values ('${APPROVED}', 'email', 'incident_reply', 'sent', 're_msg_seed', null),
             ('${REJECTED}', 'email', 'incident_reply', 'skipped', null, 'not_allow_listed')`);
    expect(await exists("select count(*) = 2 from itsupport.notifications")).toBe(true);
    expect(await numbers()).toEqual(NUMBERED);
    expect(await tableRows()).toEqual(seeded);
  });

  it("down (twice) exits 0 and removes only 0006: every 0001-0005 object, row and check as before", async () => {
    for (const sql of [down, down]) {
      applied(sql);
      expect(await catalog()).toEqual(before);
      expect(await tableRows()).toEqual(seeded);
      expect(
        await exists(
          "select count(*) = 0 from information_schema.columns where column_name = 'ticket_number'",
        ),
      ).toBe(true);
      for (const name of OLD) expect(await check(name), name).toEqual(checksBefore[name]);
      expect((await check(M6)).filter((r) => r.ok)).toEqual([]);
      expect(await exists("to_regclass('itsupport.notifications') is null")).toBe(true);
      expect(await exists("to_regclass('itsupport.ticket_number_seq') is null")).toBe(true);
      expect(await exists("to_regprocedure('itsupport.next_ticket_number()') is null")).toBe(true);
    }
  });

  it("a failure late in the up file leaves nothing behind (one transaction)", async () => {
    const lf = up.replace(/\r\n/g, "\n");
    const at = lf.lastIndexOf("alter table itsupport.tickets\n  add constraint");
    expect(at).toBeGreaterThan(0);
    // After the backfill, so the numbering is rolled back with everything else.
    expect(lf.lastIndexOf("select setval(")).toBeLessThan(at);
    const result = runSql(container!, `${lf.slice(0, at)}select 1 / 0;\n${lf.slice(at)}`);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/division by zero/);
    expect(await catalog()).toEqual(before);
    expect(await tableRows()).toEqual(seeded);
  });

  it("up after down: the same numbers, every check true and the rows unchanged", async () => {
    applied(up);
    expect(await numbers()).toEqual(NUMBERED);
    expect(await seq()).toEqual({ v: 3, c: true });
    expect(await tableRows()).toEqual(seeded);
    expect(await exists("select count(*) = 0 from itsupport.notifications")).toBe(true);
    expect(await notOk(M6)).toEqual([]);
    for (const name of ["0003_itsupport_triage_kb", M5])
      expect(await notOk(name), name).toEqual([]);
    expect(await notOk4()).toEqual([]);
  });

  it("after the second up: a second incident_reply fails with 23505 and the sys_id lookup uses the index", async () => {
    const reply = (id: string) =>
      `insert into itsupport.notifications (ticket_id, channel, kind, status, provider_id)
       values ('${APPROVED}', 'email', 'incident_reply', 'sent', '${id}')`;
    expect(await attempt(`${reply("re_msg_a")}; ${reply("re_msg_b")}`, "service_role")).toEqual(
      fails("23505", "notifications_ticket_channel_kind_key"),
    );
    const r = await attempt(
      `explain select id from itsupport.tickets where servicenow_sys_id = '${SYS_ID}'`,
      undefined,
      "set local enable_seqscan = off",
    );
    expect(r.ok && r.rows.map((row) => row["QUERY PLAN"]).join("\n")).toMatch(
      /Index.* using tickets_servicenow_sys_id_idx/,
    );
  });

  it("the next new ticket gets ITS-000004", async () => {
    expect(await attempt(ticket("web:again"), "service_role")).toEqual({
      ok: true,
      rows: [{ ticket_number: "ITS-000004" }],
    });
  });

  it("up continues after the highest existing number: one ticket at ITS-000005, the others get ITS-000006 and ITS-000007", async () => {
    applied(down);
    expect(await catalog()).toEqual(before);
    // The column already exists and one ticket holds a number (as after a partial manual run).
    await db.query(`alter table itsupport.tickets add column ticket_number text;
      update itsupport.tickets set ticket_number = 'ITS-000005' where id = '${APPROVED}'`);
    applied(up);
    expect(await numbers()).toEqual([
      { key: "web:seed-rejected", n: "ITS-000006" },
      { key: "email:seed-approved", n: "ITS-000005" },
      { key: "web:seed-auto", n: "ITS-000007" },
    ]);
    expect(await seq()).toEqual({ v: 7, c: true });
    expect(await tableRows()).toEqual(seeded);
    expect(await notOk(M6)).toEqual([]);
  });

  it("an insert that arrives while 0006 runs waits, then gets the next number: no duplicate, set not null succeeds", async () => {
    applied(down);
    expect(await catalog()).toEqual(before);
    const lf = up.replace(/\r\n/g, "\n");
    // Split right after the first statement that locks tickets (the notifications foreign key).
    const at = lf.indexOf("-- Row checks and the unique key");
    expect(at).toBeGreaterThan(lf.indexOf("create table if not exists itsupport.notifications"));
    const [runner, app] = [await connect("runner"), await connect("app")];
    try {
      await runner.query("begin");
      await runner.query(lf.slice(0, at));
      const { pid } = (await app.query<{ pid: number }>("select pg_backend_pid() as pid")).rows[0]!;
      await app.query("set statement_timeout = '20s'; set role service_role");
      // Sent before the column exists; it waits for the runner's lock on tickets.
      const inserted = app.query<{ ticket_number: string }>(ticket("web:during-0006")).then(
        (r) => ({ ok: true, rows: r.rows }),
        (error: { code?: string }) => ({ ok: false, code: error.code }),
      );
      const deadline = Date.now() + 10_000;
      const waiting = async () =>
        (await db.query("select wait_event_type as w from pg_stat_activity where pid = $1", [pid]))
          .rows[0]?.w === "Lock";
      while (!(await waiting())) {
        expect(Date.now()).toBeLessThan(deadline);
        await new Promise((r) => setTimeout(r, 100));
      }
      await runner.query(lf.slice(at));
      await runner.query("commit");
      expect(await inserted).toEqual({ ok: true, rows: [{ ticket_number: "ITS-000004" }] });
    } finally {
      await runner.query("rollback").catch(() => undefined);
      await Promise.all([runner.end(), app.end()].map((p) => p.catch(() => undefined)));
    }
    expect(await numbers()).toEqual(NUMBERED);
    const dupes = await db.query(
      "select ticket_number from itsupport.tickets group by 1 having count(*) > 1",
    );
    expect(dupes.rows).toEqual([]);
    expect(await seq()).toEqual({ v: 4, c: true });
    // Includes the column row (not null, with the default) and no ticket without a number.
    expect(await notOk(M6)).toEqual([]);
  });

  it("0001's down file still removes the whole schema with 0006 applied", async () => {
    applied(read("migrations/0001_itsupport_foundation.down.sql"));
    expect(await exists("to_regnamespace('itsupport') is null")).toBe(true);
  });
});
