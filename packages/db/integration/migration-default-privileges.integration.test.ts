import { readdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  clientFor,
  removePgContainer,
  startPgContainer,
  type PgContainer,
} from "./pg-container.js";

// Rule (docs/PROJECT.md §10): every migration revokes all rights from public,
// anon and authenticated on each table, sequence and function it creates in
// itsupport, because default privileges (pg_default_acl) may grant them. This
// test applies EVERY up file in supabase/migrations, new ones included, with
// Supabase-like default privileges in place, once as postgres and once as
// supabase_admin, and expects those roles to hold no right on any of them.
// The end state covers every object up to 0007 (itsupport.reviews,
// itsupport.notifications, ticket_number_seq, next_ticket_number(), the 0007
// helpdesk tables, helpdesk_tickets_seq_seq and reject_helpdesk_log_change() included):
// the rights come from has_*_privilege over the catalog, not from the SQL text.
// Then every down file runs in reverse and the schema is gone.

const supabaseDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../supabase");
const read = (file: string) => readFileSync(resolve(supabaseDir, file), "utf8");
// 0008 grants authenticated staff read access on purpose (P5-T11a). It joins
// this test when P5-T11c (P5-B6) turns "no right" into the exact allow-list.
const UPS = readdirSync(resolve(supabaseDir, "migrations"))
  .filter((name) => name.endsWith(".sql") && !name.endsWith(".down.sql") && name < "0008")
  .sort();
const DOWNS = UPS.map((name) => name.replace(/\.sql$/, ".down.sql")).reverse();
const LOCK = "0004_itsupport_lock_sequences.sql";
const REVIEWS = "0005_itsupport_reviews.sql";
const HELPDESK_TABLES = [
  "staff",
  "helpdesk_tickets",
  "helpdesk_notes",
  "helpdesk_assignments",
  "helpdesk_state_transitions",
].map((t) => `itsupport.${t}`);
const OWNERS = ["postgres", "supabase_admin"] as const;
const ROLES = ["anon", "authenticated", "public"];
const DEFAULT_ROWS = [
  "default privileges in every schema",
  "default privileges in schema itsupport",
];

// What a Supabase project sets for `public`, here for itsupport and for every
// schema, for objects created by postgres or supabase_admin; public is added to be strict.
const defaults = (verb: "grant" | "revoke") =>
  OWNERS.flatMap((owner) =>
    ["", "in schema itsupport "].flatMap((scope) =>
      ["tables", "sequences", "functions"].map(
        (o) =>
          `alter default privileges for role ${owner} ${scope}${verb} all on ${o} ` +
          `${verb === "grant" ? "to" : "from"} public, anon, authenticated, service_role;`,
      ),
    ),
  ).join("\n");

/** Every itsupport table, sequence and function, with its owner. */
const OBJECTS = `
  select case c.relkind when 'S' then 'sequence ' else 'table ' end || c.oid::regclass::text as object,
    pg_get_userbyid(c.relowner) as owner
  from pg_catalog.pg_class c
  where c.relnamespace = 'itsupport'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
  union all
  select 'function ' || p.oid::regprocedure::text, pg_get_userbyid(p.proowner)
  from pg_catalog.pg_proc p where p.pronamespace = 'itsupport'::regnamespace
  order by 1`;

/** Every right a role in $1 holds on the itsupport schema or any itsupport object. */
const RIGHTS = `
  select o.object, r.role
  from unnest($1::text[]) as r (role), lateral (
    select 'schema itsupport', has_schema_privilege(r.role, 'itsupport', 'usage, create')
    union all
    select case c.relkind when 'S' then 'sequence ' else 'table ' end || c.oid::regclass::text,
      case c.relkind when 'S' then has_sequence_privilege(r.role, c.oid, 'usage, select, update')
      else has_table_privilege(r.role, c.oid,
          'select, insert, update, delete, truncate, references, trigger, maintain')
        or has_any_column_privilege(r.role, c.oid, 'select, insert, update, references') end
    from pg_catalog.pg_class c
    where c.relnamespace = 'itsupport'::regnamespace and c.relkind in ('r', 'p', 'v', 'm', 'f', 'S')
    union all
    select 'function ' || p.oid::regprocedure::text, has_function_privilege(r.role, p.oid, 'execute')
    from pg_catalog.pg_proc p where p.pronamespace = 'itsupport'::regnamespace
  ) as o (object, has)
  where o.has
  order by 1, 2`;

let container: PgContainer | undefined;
const clients = new Map<string, pg.Client>();
const as = (user: string): pg.Client => {
  const found = clients.get(user);
  if (!found) throw new Error(`no client for ${user}`);
  return found;
};
const rights = async () => (await as("postgres").query(RIGHTS, [ROLES])).rows;
const notOk = async () =>
  (
    await as("postgres").query<{ object: string; ok: boolean }>(
      read("checks/0004_itsupport_lock_sequences.check.sql"),
    )
  ).rows
    .filter((row) => !row.ok)
    .map((row) => row.object);

beforeAll(async () => {
  container = await startPgContainer();
  for (const user of OWNERS) {
    const c = new pg.Client({ ...clientFor(container), user, password: container.password });
    // A dropped connection emits "error"; without a listener it would crash the run.
    c.on("error", (error) => console.error(`default-privileges ${user} client error:`, error));
    await c.connect();
    clients.set(user, c);
  }
});

afterAll(async () => {
  for (const c of clients.values()) await c.end().catch(() => undefined);
  removePgContainer(container);
});

describe.each(OWNERS)(
  "every migration applied as %s, with Supabase-like default privileges",
  (owner) => {
    it("public, anon and authenticated end with no right on any itsupport table, sequence or function", async () => {
      await as(owner).query("create schema itsupport");
      await as("supabase_admin").query(defaults("grant"));
      const lock = UPS.indexOf(LOCK);
      expect(lock).toBeGreaterThan(0);
      expect(UPS.indexOf(REVIEWS)).toBeGreaterThan(lock);
      // Up to 0003 the defaults leave ticket_events_id_seq open, so the test can see a missing revoke.
      for (const name of UPS.slice(0, lock)) await as(owner).query(read(`migrations/${name}`));
      expect(await rights()).toEqual(
        ROLES.map((role) => ({ object: "sequence itsupport.ticket_events_id_seq", role })),
      );
      for (const name of UPS.slice(lock)) await as(owner).query(read(`migrations/${name}`));
      expect(await rights()).toEqual([]);

      // Not vacuous: the objects exist and were all created by `owner`.
      const objects = (await as("postgres").query<{ object: string; owner: string }>(OBJECTS)).rows;
      expect(objects.map((o) => o.object)).toEqual(
        expect.arrayContaining([
          ...["tickets", "ticket_events", "ticket_redactions", "triage_results"].map(
            (t) => `table itsupport.${t}`,
          ),
          ...["kb_articles", "ai_calls", "security_events"].map((t) => `table itsupport.${t}`),
          "table itsupport.reviews",
          "table itsupport.notifications",
          ...HELPDESK_TABLES.map((t) => `table ${t}`),
          "sequence itsupport.helpdesk_tickets_seq_seq",
          "function itsupport.reject_helpdesk_log_change()",
          "sequence itsupport.ticket_events_id_seq",
          "sequence itsupport.security_events_id_seq",
          "sequence itsupport.ticket_number_seq",
          "function itsupport.next_ticket_number()",
          "function itsupport.reject_ticket_event_change()",
          "function itsupport.kb_search(text,integer)",
          "function itsupport.security_event_record(text,text,jsonb)",
        ]),
      );
      expect(objects.filter((o) => o.owner !== owner)).toEqual([]);

      // reviews, notifications and the 0007 tables by name: no table or column right for
      // public, anon or authenticated, while the defaults still grant every new table to all three.
      for (const table of ["itsupport.reviews", "itsupport.notifications", ...HELPDESK_TABLES]) {
        const held = await as("postgres").query(
          `select r from unnest($1::text[]) r
           where has_table_privilege(r, $2::regclass,
               'select, insert, update, delete, truncate, references, trigger, maintain')
             or has_any_column_privilege(r, $2::regclass, 'select, insert, update, references')`,
          [ROLES, table],
        );
        expect(held.rows, table).toEqual([]);
      }
      // next_ticket_number() runs for service_role only, and no role (service_role
      // included) holds a right on any itsupport sequence: 0004's lock holds after 0007.
      const execute = await as("postgres").query(
        `select r from unnest($1::text[]) r
         where has_function_privilege(r, 'itsupport.next_ticket_number()', 'execute') order by 1`,
        [[...ROLES, "service_role"]],
      );
      expect(execute.rows).toEqual([{ r: "service_role" }]);
      // The 0007 tables: service_role holds exactly SELECT, INSERT and UPDATE, and no
      // role runs the append-only trigger function directly.
      const helpdesk = await as("postgres").query(
        `select t, p from unnest($1::text[]) t,
           unnest(array['select', 'insert', 'update', 'delete', 'truncate', 'references', 'trigger', 'maintain']) p
         where has_table_privilege('service_role', t::regclass, p) order by 1, 2`,
        [HELPDESK_TABLES],
      );
      expect(helpdesk.rows).toEqual(
        [...HELPDESK_TABLES]
          .sort()
          .flatMap((t) => ["insert", "select", "update"].map((p) => ({ t, p }))),
      );
      const trigger = await as("postgres").query(
        `select r from unnest($1::text[]) r
         where has_function_privilege(r, 'itsupport.reject_helpdesk_log_change()', 'execute')`,
        [[...ROLES, "service_role"]],
      );
      expect(trigger.rows).toEqual([]);
      const sequences = await as("postgres").query(
        `select c.relname, r from pg_catalog.pg_class c, unnest($1::text[]) r
         where c.relnamespace = 'itsupport'::regnamespace and c.relkind = 'S'
           and has_sequence_privilege(r, c.oid, 'usage, select, update')`,
        [[...ROLES, "service_role"]],
      );
      expect(sequences.rows).toEqual([]);
      await as(owner).query("begin");
      try {
        await as(owner).query("create table itsupport.probe (id int)");
        const probe = await as(owner).query(
          `select r from unnest($1::text[]) r where has_table_privilege(r, 'itsupport.probe', 'select')
           order by 1`,
          [ROLES],
        );
        expect(probe.rows.map((row: { r: string }) => row.r)).toEqual([...ROLES].sort());
      } finally {
        await as(owner).query("rollback");
      }
    });

    it("the 0004 check flags exactly its two default-privilege rows, and none once they are removed", async () => {
      expect(await notOk()).toEqual(DEFAULT_ROWS);
      await as("supabase_admin").query(defaults("revoke"));
      expect(await notOk()).toEqual([]);
      for (const name of DOWNS) await as(owner).query(read(`migrations/${name}`));
      expect(
        (await as("postgres").query("select to_regnamespace('itsupport') as ns")).rows,
      ).toEqual([{ ns: null }]);
    });
  },
);
