import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CHECK, DOWN, migration, SEED, UP } from "./migration-0008-harness.js";
import {
  clientFor,
  removePgContainer,
  runSql,
  startPgContainer,
  type PgContainer,
} from "./pg-container.js";
import { MIGRATIONS } from "./rest-stack.js";

// P5-T11a, layer A: 0008 on a throwaway supabase/postgres with seeded rows.
// The JWT and PostgREST behaviour is in migration-0008-rest.integration.test.ts.
// Every aggregate orders by its own values, so the snapshot is deterministic.
const SNAPSHOT = `select json_build_object(
  'ns', (select nspacl::text from pg_namespace where nspname = 'itsupport'),
  'rel', (select json_agg(json_build_array(relname, relacl::text, relrowsecurity) order by relname)
    from pg_class where relnamespace = 'itsupport'::regnamespace),
  'col', (select json_agg(json_build_array(attrelid::regclass::text, attname, attacl::text)
      order by attrelid::regclass::text, attname)
    from pg_attribute where attacl is not null and attrelid::regclass::text like 'itsupport.%'),
  'fn', (select json_agg(json_build_array(oid::regprocedure::text, proacl::text, md5(prosrc), prosecdef,
      proconfig) order by oid::regprocedure::text) from pg_proc where pronamespace = 'itsupport'::regnamespace),
  'pol', (select json_agg(json_build_array(tablename, policyname, permissive, roles, cmd, qual, with_check)
      order by tablename, policyname) from pg_policies where schemaname = 'itsupport'),
  'rows', (select json_object_agg(relname, query_to_xml(format(
    'select count(*) as n, md5(string_agg(t::text, %L order by t::text)) as h from itsupport.%I t',
    ',', relname), false, false, '')) from pg_class
    where relnamespace = 'itsupport'::regnamespace and relkind = 'r')) as s`;
const GRANTED = [
  "tickets",
  "ticket_redactions",
  "triage_results",
  "ticket_events",
  "reviews",
  "kb_articles",
  "staff",
  "helpdesk_tickets",
  "helpdesk_notes",
  "helpdesk_assignments",
  "helpdesk_state_transitions",
];
// False passes a B4 review reproduced: each one must turn one check row false.
const WEAKENED = [
  [
    "update (role) on staff",
    "grant update (role) on itsupport.staff to authenticated",
    "table staff",
  ],
  [
    "insert (raw_title) on tickets",
    "grant insert (raw_title) on itsupport.tickets to authenticated",
    "table tickets",
  ],
  [
    "a second select policy",
    "create policy x on itsupport.tickets for select to authenticated using (true)",
    "table tickets",
  ],
  [
    "an anon column grant and policy",
    `grant select (id) on itsupport.tickets to anon;
    create policy x on itsupport.tickets for select to anon using (true)`,
    "table tickets",
  ],
  [
    "current_staff() without active",
    `create or replace function itsupport.current_staff() returns uuid
    language sql stable security definer set search_path = ''
    as $$ select id from itsupport.staff where auth_user_id = auth.uid() $$`,
    "function current_staff()",
  ],
] as const;

let pg: PgContainer;
let before: unknown;

/** Runs each statement on one connection; returns the last one's rows. */
async function sql<T>(...texts: string[]): Promise<T[]> {
  const db = clientFor(pg);
  await db.connect();
  let rows: T[] = [];
  try {
    for (const text of texts) rows = (await db.query(text)).rows as T[];
  } finally {
    await db.end();
  }
  return rows;
}
const snapshot = async () => (await sql<{ s: unknown }>(SNAPSHOT))[0]?.s;
const apply = (text: string) => expect(runSql(pg, text).status).toBe(0);
/** Applies `change` in a transaction, returns the check rows that are not ok, rolls back. */
async function notOkWith(change: string): Promise<string[]> {
  const db = clientFor(pg);
  await db.connect();
  try {
    await db.query("begin");
    await db.query(change);
    const rows = (await db.query<{ object: string; ok: boolean }>(CHECK)).rows;
    return rows.filter((row) => !row.ok).map((row) => row.object);
  } finally {
    await db.query("rollback").catch(() => undefined);
    await db.end();
  }
}

beforeAll(async () => {
  pg = await startPgContainer();
  expect(MIGRATIONS.at(-1)).toBe("0008_itsupport_staff_access.sql");
  for (const name of MIGRATIONS.filter((n) => n < "0008")) apply(migration(name));
  await sql(SEED);
  before = await snapshot();
  apply(UP);
}, 300_000);
afterAll(() => removePgContainer(pg));

it("H28b checks each migration before applying the next", async () => {
  const probe = await startPgContainer();
  const db = clientFor(probe);
  try {
    await db.connect();
    for (const name of MIGRATIONS) {
      expect(runSql(probe, migration(name)).status, name).toBe(0);
      if (name < "0006") continue;
      const check = readFileSync(
        new URL(`../../../supabase/checks/${name.replace(".sql", ".check.sql")}`, import.meta.url),
        "utf8",
      );
      const { rows } = await db.query<{ object: string; ok: boolean }>(check);
      expect(rows.length, name).toBeGreaterThan(0);
      expect(
        rows.filter((row) => !row.ok).map((row) => row.object),
        name,
      ).toEqual([]);
    }
  } finally {
    await db.end();
    removePgContainer(probe);
  }
});

describe("migration 0008 staff read access (Postgres)", () => {
  it("is_staff(), is_admin() and current_staff() with no JWT are false and null", async () => {
    expect(
      await sql(
        "set role authenticated",
        "select itsupport.is_staff() as s, itsupport.is_admin() as a, itsupport.current_staff() as c",
      ),
    ).toEqual([{ s: false, a: false, c: null }]);
  });
  it("has seeded rows in every table 0008 grants on", async () => {
    for (const t of GRANTED) {
      const [row] = await sql<{ n: string }>(`select count(*) as n from itsupport.${t}`);
      expect(Number(row?.n), t).toBeGreaterThan(0);
    }
  });
  it("runs up twice, down twice, up again; rows never change, down removes only 0008", async () => {
    const ok = async () => (await sql<{ ok: boolean }>(CHECK)).map((row) => row.ok);
    const up = await snapshot();
    expect((up as { rows: unknown }).rows).toEqual((before as { rows: unknown }).rows);
    expect(up).not.toEqual(before);
    for (const [step, all] of [
      [UP, true],
      [DOWN, false],
      [DOWN, false],
      [UP, true],
      [UP, true],
    ] as const) {
      apply(step);
      expect(new Set(await ok())).toEqual(new Set([all]));
      expect(await snapshot()).toEqual(all ? up : before);
    }
  });
  it.each(WEAKENED)(
    "the check flags %s, and is all ok again after rollback",
    async (_, change, row) => {
      expect(await notOkWith(change)).toEqual([row]);
      expect(await notOkWith("select")).toEqual([]);
    },
  );
});
