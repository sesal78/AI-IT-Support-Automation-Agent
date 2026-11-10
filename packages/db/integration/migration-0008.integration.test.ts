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
const SNAPSHOT = `select json_build_object(
  'ns', (select nspacl::text from pg_namespace where nspname = 'itsupport'),
  'rel', (select json_agg(json_build_array(relname, relacl::text, relrowsecurity) order by relname)
    from pg_class where relnamespace = 'itsupport'::regnamespace),
  'col', (select json_agg(json_build_array(attrelid::regclass::text, attname, attacl::text) order by 1, 2)
    from pg_attribute where attacl is not null and attrelid::regclass::text like 'itsupport.%'),
  'fn', (select json_agg(json_build_array(oid::regprocedure::text, proacl::text) order by 1)
    from pg_proc where pronamespace = 'itsupport'::regnamespace),
  'pol', (select count(*) from pg_policies where schemaname = 'itsupport'),
  'rows', (select json_object_agg(relname, query_to_xml(format(
    'select md5(string_agg(t::text, %L order by t::text)) from itsupport.%I t', ',', relname), false, false, ''))
    from pg_class where relnamespace = 'itsupport'::regnamespace and relkind = 'r')) as s`;

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

beforeAll(async () => {
  pg = await startPgContainer();
  for (const name of MIGRATIONS) apply(migration(name));
  await sql(SEED);
  before = await snapshot();
  apply(UP);
}, 300_000);
afterAll(() => removePgContainer(pg));

describe("migration 0008 staff read access (Postgres)", () => {
  it("is_staff(), is_admin() and current_staff() with no JWT are false and null", async () => {
    expect(
      await sql(
        "set role authenticated",
        "select itsupport.is_staff() as s, itsupport.is_admin() as a, itsupport.current_staff() as c",
      ),
    ).toEqual([{ s: false, a: false, c: null }]);
  });
  it("runs up twice, down twice, up again; down removes only 0008", async () => {
    const ok = async () => (await sql<{ ok: boolean }>(CHECK)).map((row) => row.ok);
    for (const [step, all] of [
      [UP, true],
      [DOWN, false],
      [DOWN, false],
      [UP, true],
      [UP, true],
    ] as const) {
      apply(step);
      expect(new Set(await ok())).toEqual(new Set([all]));
      if (!all) expect(await snapshot()).toEqual(before);
    }
  });
});
