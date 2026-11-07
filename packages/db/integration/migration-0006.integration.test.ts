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

// Migration 0006, part 1 (P5-T1a): itsupport.notifications, the index on
// tickets.servicenow_sys_id and the ticket number. 0001 to 0005 are applied
// first, with Supabase-like default privileges set before 0001, and no ticket
// (the backfill of existing tickets is P5-T1b). All data is fake.

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
  await db.connect();
  await db.query(`create schema itsupport; ${DEFAULTS}`);
  for (const name of [...M, M4, M5]) applied(read(`migrations/${name}.sql`));
  before = await catalog();
  for (const name of OLD) checksBefore[name] = await check(name);
});

afterAll(async () => {
  await db?.end().catch(() => undefined);
  removePgContainer(container);
});

describe("migration 0006 (part 1) on 0001-0005 with Supabase-like default privileges", () => {
  it("before 0006 every check row is ok = false; the 0003-0005 checks are all true", async () => {
    expect((await check(M6)).filter((r) => r.ok)).toEqual([]);
    for (const name of ["0003_itsupport_triage_kb", M5])
      expect(await notOk(name), name).toEqual([]);
    expect(await notOk4()).toEqual([]);
  });

  it("up (twice) exits 0: 8 columns, the index, every check row true", async () => {
    applied(up);
    applied(up);
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
    // 0004's sequence lock holds; 0003's exact list of ticket checks now also has the format check.
    expect(await notOk4()).toEqual([]);
    expect(await notOk(M5)).toEqual([]);
    expect(await notOk("0003_itsupport_triage_kb")).toEqual(["checks itsupport.tickets"]);
  });

  it("service_role tickets get ITS-000001, ITS-000002, ITS-000003 from the default", async () => {
    const r = await attempt(
      `${ticket("web:a")}; ${ticket("web:b")}; ${ticket("web:c")}; select ticket_number from itsupport.tickets order by 1`,
      "service_role",
    );
    expect(r).toEqual({
      ok: true,
      rows: ["ITS-000001", "ITS-000002", "ITS-000003"].map((n) => ({ ticket_number: n })),
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
    const last = (await db.query("select last_value from itsupport.ticket_number_seq")).rows[0]
      .last_value;
    try {
      const r = await attempt(
        ticket("web:max"),
        "service_role",
        "select setval('itsupport.ticket_number_seq', 999998)",
      );
      expect(r).toEqual({ ok: true, rows: [{ ticket_number: "ITS-999999" }] });
      expect(await attempt(ticket("web:over"), "service_role")).toEqual(fails("2200H"));
      expect(
        await exists(
          "select count(*) = 0 from itsupport.tickets where ticket_number > 'ITS-999999'",
        ),
      ).toBe(true);
    } finally {
      await db.query("select setval('itsupport.ticket_number_seq', $1)", [last]);
    }
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
    expect(await attempt(withTicket(`${note()}; delete from itsupport.tickets`))).toEqual(
      fails("23503", "notifications_ticket_id_fkey"),
    );
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

  it("down (twice) exits 0 and removes only 0006: every 0001-0005 object and check as before", async () => {
    for (const sql of [down, down]) {
      applied(sql);
      expect(await catalog()).toEqual(before);
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
    const result = runSql(container!, `${lf.slice(0, at)}select 1 / 0;\n${lf.slice(at)}`);
    expect(result.status).not.toBe(0);
    expect(await catalog()).toEqual(before);
  });

  it("up after down works: every check row true and the numbering starts at ITS-000001 again", async () => {
    applied(up);
    expect(await notOk(M6)).toEqual([]);
    expect(await attempt(ticket("web:again"), "service_role")).toEqual({
      ok: true,
      rows: [{ ticket_number: "ITS-000001" }],
    });
  });
});
