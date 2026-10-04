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

const PART1_OBJECTS = [
  "column itsupport.tickets.is_test",
  "constraint itsupport.tickets.tickets_status_check",
];

let phase2: Record<string, unknown[]> = {};

beforeAll(async () => {
  phase2 = await startWithPhase2Rows();
});

afterAll(stop);

describe("migration 0003_itsupport_triage_kb, part 1 (tickets)", () => {
  it("up keeps the phase-2 rows and sets is_test to false on both tickets", async () => {
    expect(phase2.tickets).toHaveLength(2);
    expect(phase2.ticket_events).toHaveLength(6);

    applied(upSql);

    expect(await snapshot()).toEqual(phase2);
    const { rows } = await client().query("select is_test from itsupport.tickets");
    expect(rows).toEqual([{ is_test: false }, { is_test: false }]);
  });

  it("adds tickets.is_test as boolean not null default false", async () => {
    const { rows } = await client().query(
      `select udt_name, is_nullable, column_default from information_schema.columns
       where table_schema = 'itsupport' and table_name = 'tickets' and column_name = 'is_test'`,
    );
    expect(rows).toEqual([{ udt_name: "bool", is_nullable: "NO", column_default: "false" }]);
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

  it("up is idempotent: a second run exits 0", async () => {
    applied(upSql);
    expect(await snapshot()).toEqual(phase2);
  });

  it("still denies select on tickets to anon and authenticated", async () => {
    for (const role of ["anon", "authenticated"]) {
      expect(await inRollback("select * from itsupport.tickets", role), role).toEqual({
        ok: false,
        code: "42501",
      });
    }
  });

  it("the read-only check query returns ok = true for every part-1 object after up", async () => {
    expect(await check()).toEqual(PART1_OBJECTS.map((object) => ({ object, ok: true })));
  });

  it("down removes what part 1 added, keeps the phase-2 rows, and the check query turns false", async () => {
    applied(downSql);

    expect(await snapshot()).toEqual(phase2);
    const leftovers = await client().query(
      `select column_name from information_schema.columns
       where table_schema = 'itsupport' and table_name = 'tickets' and column_name = 'is_test'
       union all
       select conname from pg_constraint
       where conrelid = 'itsupport.tickets'::regclass and contype = 'c'
         and conname <> 'tickets_source_check'`,
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
