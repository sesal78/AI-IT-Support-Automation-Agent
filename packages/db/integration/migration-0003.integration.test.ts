import { TICKET_STATUSES } from "@ai-it-support/shared";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applied,
  check,
  client,
  inRollback,
  read,
  snapshot,
  startWithPhase2Rows,
  stop,
} from "./migration-0003-harness.js";

const upSql = read("migrations/0003_itsupport_triage_kb.sql");
const downSql = read("migrations/0003_itsupport_triage_kb.down.sql");

// The 13 new triage_results columns and their Postgres type names (udt_name).
const NEW_COLUMNS = [
  ["category", "text"],
  ["subcategory", "text"],
  ["priority", "text"],
  ["urgency", "text"],
  ["assignment_group", "text"],
  ["route", "text"],
  ["probabilities", "jsonb"],
  ["flags", "_text"],
  ["grounding_score", "numeric"],
  ["kb_article_ids", "_uuid"],
  ["suggested_fix", "jsonb"],
  ["model_versions", "jsonb"],
  ["triaged_at", "timestamptz"],
] as const;
// SQL row list of every column part 1 adds, for `(table_name, column_name) in (...)`.
const COLUMN_KEYS = [
  "('tickets', 'is_test')",
  ...NEW_COLUMNS.map(([column]) => `('triage_results', '${column}')`),
].join(", ");
const CHECKS = ["category", "priority", "route", "grounding_score"].map(
  (column) => `constraint itsupport.triage_results.triage_results_${column}_check`,
);
const PART1_OBJECTS = [
  "column itsupport.tickets.is_test",
  "constraint itsupport.tickets.tickets_status_check",
  ...NEW_COLUMNS.map(([column]) => `column itsupport.triage_results.${column}`),
  ...CHECKS,
].sort();

let phase2: Record<string, unknown[]> = {};

beforeAll(async () => {
  phase2 = await startWithPhase2Rows();
});

afterAll(stop);

describe("migration 0003_itsupport_triage_kb, part 1 (tickets, triage_results)", () => {
  it("up keeps the phase-2 rows and sets is_test to false on both tickets", async () => {
    expect(phase2.tickets).toHaveLength(2);
    expect(phase2.ticket_events).toHaveLength(6);

    applied(upSql);

    expect(await snapshot()).toEqual(phase2);
    const { rows } = await client().query("select is_test from itsupport.tickets");
    expect(rows).toEqual([{ is_test: false }, { is_test: false }]);
    const columns = NEW_COLUMNS.map(([column]) => column).join(", ");
    const triage = await client().query(
      `select num_nonnulls(${columns}) as set from itsupport.triage_results`,
    );
    expect(triage.rows).toEqual([{ set: 0 }, { set: 0 }]);
  });

  it("both 0003 files say to apply them as one transaction", () => {
    for (const sql of [upSql, downSql]) {
      expect(sql).toMatch(/^-- Apply as ONE transaction: .*--single-transaction/m);
    }
  });

  it("adds tickets.is_test as boolean not null default false", async () => {
    const { rows } = await client().query(
      `select udt_name, is_nullable, column_default from information_schema.columns
       where table_schema = 'itsupport' and table_name = 'tickets' and column_name = 'is_test'`,
    );
    expect(rows).toEqual([{ udt_name: "bool", is_nullable: "NO", column_default: "false" }]);
  });

  it("adds the 13 triage_results columns as nullable with no default", async () => {
    const { rows } = await client().query(
      `select column_name, udt_name, is_nullable, column_default from information_schema.columns
       where table_schema = 'itsupport' and (table_name, column_name) in (${COLUMN_KEYS})
         and table_name = 'triage_results'
       order by ordinal_position`,
    );
    expect(rows).toEqual(
      NEW_COLUMNS.map(([column_name, udt_name]) => ({
        column_name,
        udt_name,
        is_nullable: "YES",
        column_default: null,
      })),
    );
  });

  it("the status constraint lists exactly TICKET_STATUSES from packages/shared", async () => {
    const def = (
      await client().query<{ def: string }>(
        `select pg_get_constraintdef(oid) as def from pg_constraint
         where conrelid = 'itsupport.tickets'::regclass and conname = 'tickets_status_check'`,
      )
    ).rows[0]?.def;
    expect(def).toBeDefined();
    expect([...(def ?? "").matchAll(/'([^']*)'::text/g)].map((match) => match[1])).toEqual([
      ...TICKET_STATUSES,
    ]);
  });

  it("accepts every ticket status and rejects bogus or empty ones with 23514", async () => {
    for (const status of TICKET_STATUSES) {
      expect(await inRollback(`update itsupport.tickets set status = '${status}'`), status).toEqual(
        { ok: true },
      );
    }
    for (const status of ["bogus", "", "NEW"]) {
      expect(await inRollback(`update itsupport.tickets set status = '${status}'`), status).toEqual(
        { ok: false, code: "23514" },
      );
    }
  });

  it("rejects out-of-range triage values with 23514 and accepts null and valid values", async () => {
    const set = (assignment: string) =>
      inRollback(`update itsupport.triage_results set ${assignment}`);
    for (const bad of [
      "category = 'printer'",
      "priority = 'P5'",
      "route = 'maybe'",
      "grounding_score = 1.5",
      "grounding_score = -0.01",
    ]) {
      expect(await set(bad), bad).toEqual({ ok: false, code: "23514" });
    }
    for (const good of [
      "category = null, priority = null, route = null, grounding_score = null",
      ...["database", "inquiry", "software", "hardware", "password_reset", "network"].map(
        (category) => `category = '${category}'`,
      ),
      ...["P1", "P2", "P3", "P4"].map((priority) => `priority = '${priority}'`),
      "route = 'auto'",
      "route = 'review'",
      "grounding_score = 0",
      "grounding_score = 1",
    ]) {
      expect(await set(good), good).toEqual({ ok: true });
    }
  });

  it("up is idempotent: a second run exits 0", async () => {
    applied(upSql);
    expect(await snapshot()).toEqual(phase2);
  });

  it("still denies select on tickets and triage_results to anon and authenticated", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const table of ["tickets", "triage_results"]) {
        expect(
          await inRollback(`select * from itsupport.${table}`, role),
          `${role} ${table}`,
        ).toEqual({ ok: false, code: "42501" });
      }
    }
  });

  it("the read-only check query returns ok = true for every part-1 object after up", async () => {
    expect(await check()).toEqual(PART1_OBJECTS.map((object) => ({ object, ok: true })));
  });

  it("the check query gives ok = false for a wrong constraint definition or column default", async () => {
    const wrong = [
      "column itsupport.tickets.is_test",
      "constraint itsupport.tickets.tickets_status_check",
      "constraint itsupport.triage_results.triage_results_priority_check",
    ];
    await client().query("begin");
    try {
      await client().query(`
        alter table itsupport.tickets alter column is_test set default true;
        alter table itsupport.tickets drop constraint tickets_status_check,
          add constraint tickets_status_check check (status in ('new', 'failed'));
        alter table itsupport.triage_results drop constraint triage_results_priority_check,
          add constraint triage_results_priority_check check (priority in ('P1', 'P2', 'P3', 'P4', 'P5'));
      `);
      const { rows } = await client().query<{ object: string; ok: boolean }>(
        read("checks/0003_itsupport_triage_kb.check.sql"),
      );
      expect(rows.sort((a, b) => (a.object < b.object ? -1 : 1))).toEqual(
        PART1_OBJECTS.map((object) => ({ object, ok: !wrong.includes(object) })),
      );
    } finally {
      await client().query("rollback");
    }
    expect(await check()).toEqual(PART1_OBJECTS.map((object) => ({ object, ok: true })));
  });

  it("down removes what part 1 added, keeps the phase-2 rows, and the check query turns false", async () => {
    applied(downSql);

    expect(await snapshot()).toEqual(phase2);
    const leftovers = await client().query(
      `select column_name from information_schema.columns
       where table_schema = 'itsupport' and (table_name, column_name) in (${COLUMN_KEYS})
       union all
       select conname from pg_constraint
       where conrelid in ('itsupport.tickets'::regclass, 'itsupport.triage_results'::regclass)
         and contype = 'c' and conname <> 'tickets_source_check'`,
    );
    expect(leftovers.rows).toEqual([]);
    expect(await check()).toEqual(PART1_OBJECTS.map((object) => ({ object, ok: false })));
  });

  it("down is idempotent and up works again after down", async () => {
    applied(downSql);
    applied(upSql);
    expect(await snapshot()).toEqual(phase2);
    expect(await check()).toEqual(PART1_OBJECTS.map((object) => ({ object, ok: true })));
  });
});
