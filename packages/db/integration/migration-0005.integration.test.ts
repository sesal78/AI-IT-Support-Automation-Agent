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

// Migration 0005: the itsupport.reviews table (plan §6.2).
//
// Part 1 (P4-T1a): 0001 to 0004 are applied first, with Supabase-like default
// privileges set before 0001, so the table is created while those defaults
// would grant it to anon, authenticated and service_role.
//
// Part 2 (P4-T1b, T4.I.07): before 0005 runs, the two phase-2 tickets are
// brought to the shape phase 3 leaves on the shared database (SEED_PHASE3):
// one `triaged` and one `review_pending`, triage rows with the route review,
// events up to `triaged`, KB articles, ai_calls and security_events rows. So
// every test below runs 0005 on top of phase-3 data, as human step H15 will.
// The last block adds one decided review, then runs the whole up file, the
// whole down file and the up file again. After each step it compares the row
// count and an md5 of the rows (ordered by primary key) of every itsupport
// table, listed from the catalog, so only the review row may change; then
// 0001's down file must still drop the whole schema.
//
// All data is fake (the repo is public): example.test addresses, U000TEST
// Slack user IDs, fixed test UUIDs, waitpoint_test_* tokens.

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
 * Phase-3-shaped rows on top of startWithPhase2Rows (two tickets, each with a
 * redaction, a sensitive-check triage row and events up to sensitive_checked),
 * written the way phase 3's intake and triage tasks write them.
 */
const SEED_PHASE3 = `
  insert into itsupport.kb_articles (slug, title, content, category, assignment_group) values
    ('vpn-reconnect', 'Reconnect the VPN client',
     'Quit the VPN client, sign in again and pick the nearest gateway.', 'network', 'Network'),
    ('printer-tray-jam', 'Clear a paper jam in tray 2',
     'Open tray 2, remove the jammed sheet and reseat the tray.', 'hardware', 'Hardware');

  update itsupport.tickets
    set status = case idempotency_key when 'web:it-0003-a' then 'triaged' else 'review_pending' end;

  update itsupport.triage_results r
    set category = s.category, subcategory = s.subcategory, priority = s.priority,
      urgency = s.urgency, assignment_group = s.assignment_group, route = 'review',
      probabilities = s.probabilities::jsonb, flags = s.flags::text[],
      grounding_score = s.grounding_score::numeric,
      kb_article_ids = array[(select a.id from itsupport.kb_articles a where a.slug = s.slug)],
      suggested_fix = s.fix::jsonb,
      model_versions = '{"judgments": "jev-test", "fix_steps": "llm-test"}'::jsonb,
      triaged_at = timestamptz '2026-10-20 01:00:00+00'
    from (values
      ('web:it-0003-a', 'network', 'vpn', 'P2', 'high', 'Network',
       '{"category": 0.91, "priority": 0.62}', '{needs_info}', '0.48', 'vpn-reconnect',
       '{"steps": ["Quit the VPN client", "Sign in again"]}'),
      ('email:it-0003-b', 'hardware', 'printer', 'P4', 'low', 'Hardware',
       '{"category": 0.88, "priority": 0.71}', '{ungrounded_fix}', '0.35', 'printer-tray-jam',
       '{"steps": ["Open tray 2", "Remove the jammed sheet"]}')
    ) as s (key, category, subcategory, priority, urgency, assignment_group, probabilities,
            flags, grounding_score, slug, fix)
    join itsupport.tickets t on t.idempotency_key = s.key
    where r.ticket_id = t.id;

  insert into itsupport.ticket_events (ticket_id, type, payload)
    select t.id, e.type, e.payload::jsonb
    from itsupport.tickets t, (values
      (1, 'kb_matched', '{"count": 1}'),
      (2, 'fix_drafted', '{"steps": 2}'),
      (3, 'policy_decided', '{"route": "review", "reasons": ["flags"]}'),
      (4, 'triaged', '{"route": "review"}')
    ) as e (n, type, payload)
    order by t.idempotency_key, e.n;

  insert into itsupport.ai_calls (ticket_id, provider, kind, calls, tokens_in, tokens_out, cost_usd, environment, at)
    select t.id, c.provider, c.kind, c.calls, c.tokens_in, c.tokens_out, c.cost_usd, 'staging',
      timestamptz '2026-10-20 00:59:00+00'
    from itsupport.tickets t, (values
      ('typesafe', 'sensitive_check', 1, null::integer, null::integer, 0.001),
      ('typesafe', 'triage_judgments', 4, null, null, 0.004),
      ('llm', 'fix_steps', 1, 812, 164, 0.0021)
    ) as c (provider, kind, calls, tokens_in, tokens_out, cost_usd);

  insert into itsupport.security_events (source, kind, window_start, count, sample) values
    ('internal_api', 'bad_token', timestamptz '2026-10-20 00:58:00+00', 3,
     '{"path": "/api/internal/tickets", "method": "POST"}');
  select itsupport.security_event_record('pipeline', 'alert:typesafe_cap_reached', '{}');
`;

/** One decided triage review of the review_pending ticket (needs 0005). */
const SEED_REVIEW = `insert into itsupport.reviews
    (ticket_id, kind, slack_user_id, decision, decided_at, wait_token_id, slack_ts, created_at)
  values (${OTHER}, 'triage', '${U1}', 'approve', timestamptz '2026-10-20 02:00:00+00',
    'waitpoint_test_seed', '1700000000.000300', timestamptz '2026-10-20 01:00:00+00')`;

type TableRows = Record<string, { rows: number; md5: string }>;
const EMPTY = { rows: 0, md5: "d41d8cd98f00b204e9800998ecf8427e" }; // md5('')

/**
 * Row count and an md5 of all rows, ordered by primary key, for every table
 * in itsupport. The table list and the keys come from the catalog, so a table
 * added later is compared too; a table without a primary key fails loudly.
 */
const tableRows = async (): Promise<TableRows> => {
  const tables = (
    await client().query<{ name: string; pk: string | null }>(`
      select c.relname as name,
        (select string_agg(quote_ident(a.attname), ', ' order by k.ord)
         from pg_catalog.pg_index i
         cross join lateral unnest(i.indkey::int2[]) with ordinality as k (attnum, ord)
         join pg_catalog.pg_attribute a on a.attrelid = i.indrelid and a.attnum = k.attnum
         where i.indrelid = c.oid and i.indisprimary) as pk
      from pg_catalog.pg_class c
      where c.relnamespace = 'itsupport'::regnamespace and c.relkind in ('r', 'p')
      order by 1`)
  ).rows;
  const out: TableRows = {};
  for (const { name, pk } of tables) {
    if (!pk) throw new Error(`itsupport.${name} has no primary key to order its rows by`);
    const { rows } = await client().query<{ rows: number; md5: string }>(
      `select count(*)::int as rows, md5(coalesce(string_agg(t::text, E'\\n' order by ${pk}), '')) as md5
       from itsupport."${name.replace(/"/g, '""')}" t`,
    );
    out[name] = rows[0]!;
  }
  return out;
};
const withoutReviews = (rows: TableRows): TableRows =>
  Object.fromEntries(Object.entries(rows).filter(([name]) => name !== "reviews"));

/**
 * A snapshot of everything in the itsupport schema and what refers to it:
 * relations with owner, ACL and RLS flags, columns, constraints, indexes,
 * triggers, policies, functions, the schema ACL and its default privileges.
 */
const catalog = async () =>
  (
    await client().query<{ item: string }>(`
      select 'rel ' || c.relname || ' ' || c.relkind::text || ' ' || pg_get_userbyid(c.relowner) || ' '
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
        || ' ' || d.defaclobjtype::text || ' ' || d.defaclacl::text
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

// The phase-2 columns of the seeded rows (taken after SEED_PHASE3).
let phase2: Record<string, unknown[]> = {};
// Every itsupport table's row count and md5 after SEED_PHASE3, before 0005.
let seeded: TableRows = {};
let before: string[] = [];
let check3: { object: string; ok: boolean }[] = [];

beforeAll(async () => {
  await startWithPhase2Rows(`create schema itsupport; ${defaults("grant")}`);
  applied(up("0003_itsupport_triage_kb"));
  applied(up("0004_itsupport_lock_sequences"));
  await client().query(SEED_PHASE3);
  phase2 = await snapshot();
  seeded = await tableRows();
  before = await catalog();
  check3 = await check();
});

afterAll(stop);

describe("migration 0005 (reviews) on 0001-0004 with Supabase-like default privileges", () => {
  it("the seed is phase-3-shaped: one triaged and one review_pending ticket, every table holds rows", async () => {
    expect(
      Object.fromEntries(Object.entries(seeded).map(([name, { rows }]) => [name, rows])),
    ).toEqual({
      tickets: 2,
      ticket_redactions: 2,
      triage_results: 2,
      ticket_events: 14,
      kb_articles: 2,
      ai_calls: 6,
      security_events: 2,
    });
    const tickets = await client().query(
      `select t.idempotency_key, t.status, r.route, r.category, r.priority, r.triaged_at is not null as triaged,
         cardinality(r.kb_article_ids) as kb,
         (select e.type from itsupport.ticket_events e where e.ticket_id = t.id order by e.id desc limit 1) as last_event,
         (select count(*)::int from itsupport.ai_calls c where c.ticket_id = t.id) as ai_calls
       from itsupport.tickets t join itsupport.triage_results r on r.ticket_id = t.id order by 1`,
    );
    expect(tickets.rows).toEqual([
      {
        idempotency_key: "email:it-0003-b",
        status: "review_pending",
        route: "review",
        category: "hardware",
        priority: "P4",
        triaged: true,
        kb: 1,
        last_event: "triaged",
        ai_calls: 3,
      },
      {
        idempotency_key: "web:it-0003-a",
        status: "triaged",
        route: "review",
        category: "network",
        priority: "P2",
        triaged: true,
        kb: 1,
        last_event: "triaged",
        ai_calls: 3,
      },
    ]);
    expect(check3.filter((row) => !row.ok)).toEqual([]);
  });

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
    expect(await tableRows()).toEqual({ ...seeded, reviews: EMPTY });
  });

  it("up twice exits 0; constraints and grants are re-applied without error", async () => {
    applied(up(M5));
    applied(up(M5));
    expect(await notOk5()).toEqual([]);
    expect((await check()).filter((row) => !row.ok)).toEqual([]);
  });

  it("a ticket has at most one triage review: the second fails with 23505 (both proposal_id null)", async () => {
    expect(await attempt(review())).toEqual({ ok: true });
    expect(
      await attempt(`${review()}; ${review({ wait_token_id: "'waitpoint_test_2'" })}`),
    ).toEqual(fails("23505", "reviews_ticket_kind_proposal_key"));
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
    const freshId =
      "(select id from itsupport.tickets where idempotency_key = 'web:it-0005-probe')";
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
    expect(rows).toEqual(["insert", "select", "update"].map((p) => ({ r: "service_role", p })));
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
      [
        "grant select (slack_ts) on itsupport.reviews to authenticated",
        ["grants", "privileges authenticated"],
      ],
      // A right for public reaches every role, so every privileges row flips.
      [
        "grant references on itsupport.reviews to public",
        [
          "grants",
          ...["public", "anon", "authenticated", "service_role"].map((r) => `privileges ${r}`),
        ],
      ],
      [
        "revoke update on itsupport.reviews from service_role",
        ["grants", "privileges service_role"],
      ],
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
      [
        "alter table itsupport.reviews alter column slack_ts set not null",
        ["column itsupport.reviews.slack_ts"],
      ],
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
          wrong.map((w) => (w.includes("itsupport.reviews") ? w : `${w} itsupport.reviews`)).sort(),
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
      expect(await tableRows()).toEqual(seeded);
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

// Runs after the block above, which leaves 0005 applied with no review row.
describe("T4.I.07: up, down, up with the phase-3 rows and a decided review present", () => {
  let base: TableRows = {};

  it("one decided triage review is seeded for the review_pending ticket", async () => {
    expect(await tableRows()).toEqual({ ...seeded, reviews: EMPTY });
    await client().query(SEED_REVIEW);
    base = await tableRows();
    expect(base).toEqual({ ...seeded, reviews: expect.objectContaining({ rows: 1 }) });
    const { rows } = await client().query(
      `select t.status, r.kind, r.decision, r.slack_user_id, r.decided_at is not null as decided
       from itsupport.reviews r join itsupport.tickets t on t.id = r.ticket_id`,
    );
    expect(rows).toEqual([
      {
        status: "review_pending",
        kind: "triage",
        decision: "approve",
        slack_user_id: U1,
        decided: true,
      },
    ]);
  });

  it("the whole up file exits 0 and changes no row, the review row included", async () => {
    applied(up(M5));
    expect(await tableRows()).toEqual(base);
    expect(await notOk5()).toEqual([]);
  });

  it("the whole down file exits 0 and removes only the review row: every other table is unchanged", async () => {
    applied(down(M5));
    expect(await reviewsExists()).toBe(false);
    expect(await tableRows()).toEqual(withoutReviews(base));
    expect(withoutReviews(base)).toEqual(seeded);
    expect(await catalog()).toEqual(before);
    expect(await check()).toEqual(check3);
  });

  it("the up file again exits 0: other rows unchanged, reviews empty, the check only ok = true", async () => {
    applied(up(M5));
    expect(await tableRows()).toEqual({ ...seeded, reviews: EMPTY });
    const rows = await check5();
    expect(rows.map((row) => row.object)).toEqual(CHECK_OBJECTS);
    expect(rows.filter((row) => row.ok !== true)).toEqual([]);
    expect((await check()).filter((row) => !row.ok)).toEqual([]);
  });

  it("a second triage review for a seeded ticket fails with 23505", async () => {
    // The first one is committed, as service_role (the pipeline's role).
    await client().query("begin");
    try {
      await client().query("set local role service_role");
      await client().query(review());
      await client().query("commit");
    } catch (error) {
      await client().query("rollback");
      throw error;
    }
    expect((await tableRows()).reviews?.rows).toBe(1);
    expect(await attempt(review({ wait_token_id: "'waitpoint_test_2'" }), "service_role")).toEqual(
      fails("23505", "reviews_ticket_kind_proposal_key"),
    );
    // The seeded review of the other ticket went with the down file, so its slot is free again.
    expect(await attempt(review({ ticket_id: OTHER }), "service_role")).toEqual({ ok: true });
  });

  it("0001's down file still removes the whole schema with 0005 applied, and keeps vector", async () => {
    applied(down("0001_itsupport_foundation"));
    const { rows } = await client().query(
      `select (select count(*)::int from pg_catalog.pg_namespace where nspname = 'itsupport') as schemas,
         (select count(*)::int from pg_catalog.pg_class where relname = 'reviews'
            and relnamespace not in (select oid from pg_catalog.pg_namespace
              where nspname in ('pg_catalog', 'information_schema'))) as reviews,
         (select count(*)::int from pg_catalog.pg_extension where extname = 'vector') as vector`,
    );
    expect(rows).toEqual([{ schemas: 0, reviews: 0, vector: 1 }]);
  });
});
