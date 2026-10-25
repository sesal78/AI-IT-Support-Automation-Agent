import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applied,
  check,
  client,
  connect,
  read,
  run,
  snapshot,
  startWithPhase2Rows,
  stop,
} from "./migration-0003-harness.js";

// Migration 0005, part 1: the itsupport.reviews table (plan §6.2). 0001 to
// 0004 are applied first, with Supabase-like default privileges set before
// 0001, so the table is created while those defaults would grant it to anon,
// authenticated and service_role.

const up = (n: string) => read(`migrations/${n}.sql`);
const down = (n: string) => read(`migrations/${n}.down.sql`);
const M5 = "0005_itsupport_reviews";
const CHECK5 = `checks/${M5}.check.sql`;
// Fake Slack user IDs and proposal IDs; never real ones (the repo is public).
const U1 = "U000TEST01";
const U2 = "U000TEST02";
const P1 = "00000000-0000-4000-8000-000000000001";
const P2 = "00000000-0000-4000-8000-000000000002";
const TICKET = "(select id from itsupport.tickets where idempotency_key = 'web:it-0003-a')";
const OTHER = "(select id from itsupport.tickets where idempotency_key = 'email:it-0003-b')";
const ALL_RIGHTS = ["select", "insert", "update", "delete", "truncate", "references", "trigger"];
const DENIED = { ok: false, code: "42501" };

// Global and per-schema defaults, as a Supabase project sets them for public.
const defaults = (verb: "grant" | "revoke") =>
  ["", "in schema itsupport "]
    .flatMap((scope) =>
      ["tables", "sequences", "functions"].map(
        (o) =>
          `alter default privileges ${scope}${verb} all on ${o} ` +
          `${verb === "grant" ? "to" : "from"} anon, authenticated, service_role;`,
      ),
    )
    .join(" ");

/** A review insert; `cols` may override any column. */
const review = (cols: Record<string, string> = {}) => {
  const row: Record<string, string> = {
    ticket_id: TICKET,
    kind: "'triage'",
    wait_token_id: "'waitpoint_test_1'",
    ...cols,
  };
  return `insert into itsupport.reviews (${Object.keys(row).join(", ")})
    values (${Object.values(row).join(", ")})`;
};

type Attempt = { ok: true } | { ok: false; code?: string; constraint?: string; message?: string };

/**
 * Runs `sql` (one or more statements) in a transaction that is always rolled
 * back. With `role`, `prep` runs first as postgres, then the role is set.
 */
const attempt = async (sql: string, role?: string, prep = ""): Promise<Attempt> => {
  await client().query("begin");
  try {
    if (prep) await client().query(prep);
    if (role) await client().query(`set local role ${role}`);
    await client().query(sql);
    return { ok: true };
  } catch (error) {
    const { code, constraint, message } = error as Record<string, string | undefined>;
    return { ok: false, code, constraint, message };
  } finally {
    await client().query("rollback");
  }
};
const fails = (code: string, constraint?: string) =>
  expect.objectContaining({ ok: false, code, ...(constraint ? { constraint } : {}) });

/** The 0005 check, in a read-only transaction (which proves it writes nothing). */
const check5 = async (sql = read(CHECK5)) => {
  await client().query("begin transaction read only");
  try {
    return (await client().query<{ object: string; ok: boolean }>(sql)).rows;
  } finally {
    await client().query("commit");
  }
};
const notOk5 = async () => (await check5()).filter((row) => !row.ok).map((row) => row.object);
const reviewsExists = async () =>
  (await client().query("select to_regclass('itsupport.reviews') is not null as e")).rows[0].e;

/**
 * A snapshot of everything in the itsupport schema and what refers to it:
 * relations with owner, ACL and RLS flags, columns, constraints, indexes,
 * triggers, policies, functions, the schema ACL and its default privileges.
 */
const catalog = async () =>
  (
    await client().query<{ item: string }>(`
      select 'rel ' || c.relname || ' ' || c.relkind || ' ' || pg_get_userbyid(c.relowner) || ' '
        || coalesce(c.relacl::text, '-') || ' ' || c.relrowsecurity || c.relforcerowsecurity as item
      from pg_catalog.pg_class c where c.relnamespace = 'itsupport'::regnamespace
      union all
      select 'col ' || c.relname || '.' || a.attname || ' ' || format_type(a.atttypid, a.atttypmod)
        || ' ' || a.attnotnull || ' ' || coalesce(pg_get_expr(d.adbin, d.adrelid), '-')
        || ' ' || coalesce(a.attacl::text, '-')
      from pg_catalog.pg_attribute a
      join pg_catalog.pg_class c on c.oid = a.attrelid
      left join pg_catalog.pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where c.relnamespace = 'itsupport'::regnamespace and a.attnum > 0 and not a.attisdropped
      union all
      select 'con ' || k.conrelid::regclass::text || ' ' || k.conname || ' ' || pg_get_constraintdef(k.oid)
      from pg_catalog.pg_constraint k where k.connamespace = 'itsupport'::regnamespace
      union all
      select 'idx ' || i.indexdef from pg_catalog.pg_indexes i where i.schemaname = 'itsupport'
      union all
      select 'trg ' || t.tgrelid::regclass::text || ' ' || t.tgname || ' ' || t.tgisinternal
      from pg_catalog.pg_trigger t join pg_catalog.pg_class c on c.oid = t.tgrelid
      where c.relnamespace = 'itsupport'::regnamespace
      union all
      select 'pol ' || y.polrelid::regclass::text || ' ' || y.polname
      from pg_catalog.pg_policy y join pg_catalog.pg_class c on c.oid = y.polrelid
      where c.relnamespace = 'itsupport'::regnamespace
      union all
      select 'fn ' || p.oid::regprocedure::text || ' ' || coalesce(p.proacl::text, '-') || ' '
        || md5(p.prosrc)
      from pg_catalog.pg_proc p where p.pronamespace = 'itsupport'::regnamespace
      union all
      select 'nsp ' || coalesce(n.nspacl::text, '-') from pg_catalog.pg_namespace n
      where n.nspname = 'itsupport'
      union all
      select 'defacl ' || pg_get_userbyid(d.defaclrole) || ' ' || d.defaclnamespace::regnamespace::text
        || ' ' || d.defaclobjtype || ' ' || d.defaclacl::text
      from pg_catalog.pg_default_acl d
      order by 1`)
  ).rows.map((row) => row.item);

// Every object the check reports on (32 rows).
const CHECK_OBJECTS = [
  "table itsupport.reviews",
  ...[
    "id",
    "ticket_id",
    "kind",
    "proposal_id",
    "slack_user_id",
    "decision",
    "decided_at",
    "wait_token_id",
    "slack_ts",
    "created_at",
  ].map((c) => `column itsupport.reviews.${c}`),
  ...[
    "pkey",
    "ticket_id_fkey",
    "ticket_kind_proposal_key",
    "kind_check",
    "decision_check",
    "decided_check",
    "slack_user_check",
    "proposal_check",
  ].map((c) => `constraint itsupport.reviews.reviews_${c}`),
  ...["checks", "columns", "grants", "rls", "indexes", "triggers", "rules", "publications"].map(
    (k) => `${k} itsupport.reviews`,
  ),
  ...["public", "anon", "authenticated", "service_role"].map(
    (r) => `privileges ${r} itsupport.reviews`,
  ),
  "owner itsupport.reviews",
].sort();

let phase2: Record<string, unknown[]> = {};
let before: string[] = [];
let check3: { object: string; ok: boolean }[] = [];

beforeAll(async () => {
  phase2 = await startWithPhase2Rows(`create schema itsupport; ${defaults("grant")}`);
  applied(up("0003_itsupport_triage_kb"));
  applied(up("0004_itsupport_lock_sequences"));
  before = await catalog();
  check3 = await check();
});

afterAll(stop);

describe("migration 0005 (reviews) on 0001-0004 with Supabase-like default privileges", () => {
  it("before 0005 the check returns every row, each ok = false (wrong variant)", async () => {
    const rows = await check5();
    expect(rows.map((row) => row.object)).toEqual(CHECK_OBJECTS);
    expect(rows.filter((row) => row.ok !== false)).toEqual([]);
    expect(check3.filter((row) => !row.ok)).toEqual([]);
  });

  it("up exits 0 and information_schema.columns shows the 10 columns, types and nullability", async () => {
    applied(up(M5));
    const { rows } = await client().query(
      `select column_name, data_type, is_nullable, column_default from information_schema.columns
       where table_schema = 'itsupport' and table_name = 'reviews' order by ordinal_position`,
    );
    expect(rows).toEqual(
      [
        ["id", "uuid", "NO", "gen_random_uuid()"],
        ["ticket_id", "uuid", "NO", null],
        ["kind", "text", "NO", null],
        ["proposal_id", "uuid", "YES", null],
        ["slack_user_id", "text", "YES", null],
        ["decision", "text", "YES", null],
        ["decided_at", "timestamp with time zone", "YES", null],
        ["wait_token_id", "text", "NO", null],
        ["slack_ts", "text", "YES", null],
        ["created_at", "timestamp with time zone", "NO", "now()"],
      ].map(([column_name, data_type, is_nullable, column_default]) => ({
        column_name,
        data_type,
        is_nullable,
        column_default,
      })),
    );
    expect(await notOk5()).toEqual([]);
    expect(await snapshot()).toEqual(phase2);
  });

  it("up twice exits 0; constraints and grants are re-applied without error", async () => {
    applied(up(M5));
    applied(up(M5));
    expect(await notOk5()).toEqual([]);
    expect((await check()).filter((row) => !row.ok)).toEqual([]);
  });

  it("a ticket has at most one triage review: the second fails with 23505 (both proposal_id null)", async () => {
    expect(await attempt(review())).toEqual({ ok: true });
    expect(await attempt(`${review()}; ${review({ wait_token_id: "'waitpoint_test_2'" })}`)).toEqual(
      fails("23505", "reviews_ticket_kind_proposal_key"),
    );
    // Another ticket, or an auto-fix review of the same ticket, does not collide.
    expect(
      await attempt(
        `${review()}; ${review({ ticket_id: OTHER })}; ` +
          review({ kind: "'autofix'", proposal_id: `'${P1}'` }),
      ),
    ).toEqual({ ok: true });
  });

  it("autofix reviews: two proposals of one ticket insert; the same proposal twice fails with 23505", async () => {
    const fix = (p: string) => review({ kind: "'autofix'", proposal_id: `'${p}'` });
    expect(await attempt(`${fix(P1)}; ${fix(P2)}`)).toEqual({ ok: true });
    expect(await attempt(`${fix(P1)}; ${fix(P1)}`)).toEqual(
      fails("23505", "reviews_ticket_kind_proposal_key"),
    );
  });

  it("each invalid row fails with 23514 from its own named check", async () => {
    const cases: [string, Record<string, string>, string][] = [
      ["kind = 'other'", { kind: "'other'" }, "reviews_kind_check"],
      [
        "decision = 'maybe'",
        { decision: "'maybe'", decided_at: "now()", slack_user_id: `'${U1}'` },
        "reviews_decision_check",
      ],
      [
        "approve with decided_at null",
        { decision: "'approve'", slack_user_id: `'${U1}'` },
        "reviews_decided_check",
      ],
      ["decided_at set with decision null", { decided_at: "now()" }, "reviews_decided_check"],
      [
        "approve with slack_user_id null",
        { decision: "'approve'", decided_at: "now()" },
        "reviews_slack_user_check",
      ],
      [
        "reject with slack_user_id null",
        { decision: "'reject'", decided_at: "now()" },
        "reviews_slack_user_check",
      ],
      [
        "timeout with a slack_user_id",
        { decision: "'timeout'", decided_at: "now()", slack_user_id: `'${U1}'` },
        "reviews_slack_user_check",
      ],
      ["undecided with a slack_user_id", { slack_user_id: `'${U1}'` }, "reviews_slack_user_check"],
      ["triage row with a proposal_id", { proposal_id: `'${P1}'` }, "reviews_proposal_check"],
      ["autofix row without a proposal_id", { kind: "'autofix'" }, "reviews_proposal_check"],
    ];
    for (const [name, cols, constraint] of cases)
      expect(await attempt(review(cols)), name).toEqual(fails("23514", constraint));
  });

  it("not null columns reject nulls with 23502", async () => {
    for (const col of ["ticket_id", "kind", "wait_token_id"])
      expect(await attempt(review({ [col]: "null" })), col).toEqual(fails("23502"));
  });

  it("valid rows insert: triage open, triage approved, autofix rejected, timeout, slack_ts", async () => {
    const valid: Record<string, string>[] = [
      {},
      { decision: "'approve'", decided_at: "now()", slack_user_id: `'${U1}'` },
      { decision: "'reject'", decided_at: "now()", slack_user_id: `'${U2}'` },
      { decision: "'timeout'", decided_at: "now()" },
      { slack_ts: "'1700000000.000100'" },
    ];
    for (const cols of valid) {
      expect(await attempt(review(cols)), JSON.stringify(cols)).toEqual({ ok: true });
      const fix = { ...cols, kind: "'autofix'", proposal_id: `'${P1}'` };
      expect(await attempt(review(fix)), JSON.stringify(fix)).toEqual({ ok: true });
    }
  });

  it("an unknown ticket_id fails with 23503; deleting a ticket that has a review fails with 23503", async () => {
    expect(await attempt(review({ ticket_id: `'${P1}'` }))).toEqual(
      fails("23503", "reviews_ticket_id_fkey"),
    );
    // A fresh ticket with no other rows, so only the reviews foreign key can block the delete.
    const fresh = `insert into itsupport.tickets (source, raw_title, raw_description, requester_email, idempotency_key)
      values ('web', 'Probe', 'Probe', 'probe@example.test', 'web:it-0005-probe')`;
    const freshId = "(select id from itsupport.tickets where idempotency_key = 'web:it-0005-probe')";
    const del = `delete from itsupport.tickets where idempotency_key = 'web:it-0005-probe'`;
    expect(await attempt(`${fresh}; ${del}`)).toEqual({ ok: true });
    expect(await attempt(`${fresh}; ${review({ ticket_id: freshId })}; ${del}`)).toEqual(
      fails("23503", "reviews_ticket_id_fkey"),
    );
  });

  it("the compare-and-set decision update changes 1 row the first time and 0 the second", async () => {
    await client().query("begin");
    try {
      const { rows } = await client().query<{ id: string }>(`${review()} returning id`);
      const id = rows[0]!.id;
      const cas = `update itsupport.reviews set decision = 'approve', decided_at = now(),
        slack_user_id = '${U1}' where id = $1 and decision is null`;
      expect((await client().query(cas, [id])).rowCount).toBe(1);
      expect((await client().query(cas, [id])).rowCount).toBe(0);
      const after = await client().query(
        "select decision, slack_user_id, decided_at is not null as decided from itsupport.reviews where id = $1",
        [id],
      );
      expect(after.rows).toEqual([{ decision: "approve", slack_user_id: U1, decided: true }]);
    } finally {
      await client().query("rollback");
    }
  });

  it("anon and authenticated get 42501 on select, insert, update and delete, with or without schema USAGE", async () => {
    const statements = [
      "select * from itsupport.reviews",
      review(),
      "update itsupport.reviews set slack_ts = 'x'",
      "delete from itsupport.reviews",
    ];
    // With USAGE on the schema, the 42501 can only come from the table itself.
    const usage = "grant usage on schema itsupport to anon, authenticated";
    for (const role of ["anon", "authenticated"])
      for (const sql of statements) {
        expect(await attempt(sql, role), `${role}: ${sql}`).toEqual(fails("42501"));
        expect(await attempt(sql, role, usage), `${role} with usage: ${sql}`).toEqual({
          ...DENIED,
          constraint: undefined,
          message: "permission denied for table reviews",
        });
      }
  });

  it("that 42501 depends on 0005's revoke: the defaults would grant anon a new table, and a grant opens reviews", async () => {
    const usage = "grant usage on schema itsupport to anon, authenticated";
    expect(
      await attempt(
        "select * from itsupport.probe",
        "anon",
        `${usage}; create table itsupport.probe (id int)`,
      ),
    ).toEqual({ ok: true });
    expect(
      await attempt(
        "select * from itsupport.reviews",
        "anon",
        `${usage}; grant select on itsupport.reviews to anon`,
      ),
    ).toEqual({ ok: true });
  });

  it("service_role inserts, selects and updates; delete fails with 42501", async () => {
    expect(
      await attempt(
        `${review()}; select * from itsupport.reviews;
         update itsupport.reviews set decision = 'timeout', decided_at = now() where decision is null`,
        "service_role",
      ),
    ).toEqual({ ok: true });
    expect(await attempt("delete from itsupport.reviews", "service_role")).toEqual({
      ...DENIED,
      constraint: undefined,
      message: "permission denied for table reviews",
    });
  });

  it("has_table_privilege: public, anon and authenticated hold no right; service_role exactly select, insert, update", async () => {
    const { rows } = await client().query<{ r: string; p: string }>(
      `select r, p from unnest(array['public', 'anon', 'authenticated', 'service_role']) r,
         unnest($1::text[]) p
       where has_table_privilege(r, 'itsupport.reviews', p) order by 1, 2`,
      [[...ALL_RIGHTS, "maintain"]],
    );
    expect(rows).toEqual(
      ["insert", "select", "update"].map((p) => ({ r: "service_role", p })),
    );
    const columns = await client().query(
      `select r from unnest(array['public', 'anon', 'authenticated']) r
       where has_any_column_privilege(r, 'itsupport.reviews', 'select, insert, update, references')`,
    );
    expect(columns.rows).toEqual([]);
  });

  it("RLS is enabled and not forced, and no policy exists", async () => {
    const { rows } = await client().query(
      `select c.relrowsecurity, c.relforcerowsecurity,
         (select count(*)::int from pg_catalog.pg_policy y where y.polrelid = c.oid) as policies
       from pg_catalog.pg_class c where c.oid = 'itsupport.reviews'::regclass`,
    );
    expect(rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: false, policies: 0 }]);
  });

  it("the check flips the matching rows when a right, a policy or a check comes back", async () => {
    const variants: [string, string[]][] = [
      ["grant delete on itsupport.reviews to service_role", ["grants", "privileges service_role"]],
      ["grant select on itsupport.reviews to anon", ["grants", "privileges anon"]],
      ["grant select (slack_ts) on itsupport.reviews to authenticated", ["grants", "privileges authenticated"]],
      ["grant references on itsupport.reviews to public", ["grants", "privileges public"]],
      ["revoke update on itsupport.reviews from service_role", ["grants", "privileges service_role"]],
      ["create policy probe on itsupport.reviews using (true)", ["rls"]],
      ["alter table itsupport.reviews disable row level security", ["rls"]],
      [
        "alter table itsupport.reviews add constraint reviews_probe_check check (slack_ts <> '')",
        ["checks"],
      ],
      ["create index reviews_probe_idx on itsupport.reviews (slack_ts)", ["indexes"]],
      [
        "alter table itsupport.reviews drop constraint reviews_slack_user_check",
        ["checks", "constraint itsupport.reviews.reviews_slack_user_check"],
      ],
      ["alter table itsupport.reviews alter column slack_ts set not null", ["column itsupport.reviews.slack_ts"]],
    ];
    for (const [sql, wrong] of variants) {
      await client().query("begin");
      try {
        await client().query(sql);
        const rows = (await client().query<{ object: string; ok: boolean }>(read(CHECK5))).rows;
        expect(
          rows.filter((row) => !row.ok).map((row) => row.object),
          sql,
        ).toEqual(
          wrong
            .map((w) => (w.includes("itsupport.reviews") ? w : `${w} itsupport.reviews`))
            .sort(),
        );
      } finally {
        await client().query("rollback");
      }
    }
    expect(await notOk5()).toEqual([]);
  });

  it("the check is all true as postgres and supabase_admin, with LF and CRLF, in a read-only transaction", async () => {
    const lf = read(CHECK5).replace(/\r\n/g, "\n");
    expect(lf).not.toContain("\r");
    for (const user of ["postgres", "supabase_admin"]) {
      const as = await connect(user);
      try {
        for (const sql of [lf, lf.replace(/\n/g, "\r\n")]) {
          await as.query("begin transaction read only");
          try {
            const { rows } = await as.query<{ object: string; ok: boolean }>(sql);
            expect(rows.map((row) => row.object)).toEqual(CHECK_OBJECTS);
            expect(rows.filter((row) => row.ok !== true)).toEqual([]);
          } finally {
            await as.query("rollback");
          }
        }
      } finally {
        await as.end();
      }
    }
  });

  it("down (twice) exits 0, drops the table and leaves every 0001-0004 object and row as before", async () => {
    for (const sql of [down(M5), down(M5)]) {
      applied(sql);
      expect(await reviewsExists()).toBe(false);
      expect(await catalog()).toEqual(before);
      expect(await snapshot()).toEqual(phase2);
      expect(await check()).toEqual(check3);
      const rows = await check5();
      expect(rows.map((row) => row.object)).toEqual(CHECK_OBJECTS);
      expect(rows.filter((row) => row.ok !== false)).toEqual([]);
    }
  });

  it("a failure anywhere in the up file leaves nothing behind (one transaction)", async () => {
    const sql = up(M5);
    const marks = [
      "alter table itsupport.reviews\n  add constraint",
      "alter table itsupport.reviews enable row level security",
      "grant select, insert, update",
    ];
    const lf = sql.replace(/\r\n/g, "\n");
    for (const mark of marks) {
      const at = lf.indexOf(mark);
      expect(at, mark).toBeGreaterThan(0);
      const broken = `${lf.slice(0, at)}select 1 / 0;\n${lf.slice(at)}`;
      const result = run(broken);
      expect(result.status, mark).not.toBe(0);
      expect(result.stderr).toMatch(/division by zero/);
      expect(await reviewsExists()).toBe(false);
      expect(await catalog()).toEqual(before);
    }
    // Failing after the last statement rolls back the whole file too.
    const result = run(`${lf}\nselect 1 / 0;\n`);
    expect(result.status).not.toBe(0);
    expect(await reviewsExists()).toBe(false);
  });

  it("up after down works: all true again and a review inserts", async () => {
    applied(up(M5));
    expect(await notOk5()).toEqual([]);
    expect(await attempt(review(), "service_role")).toEqual({ ok: true });
    expect((await check()).filter((row) => !row.ok)).toEqual([]);
  });
});
