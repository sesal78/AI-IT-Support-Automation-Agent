import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  clientFor,
  removePgContainer,
  runSql,
  startPgContainer,
  type PgContainer,
} from "./pg-container.js";

const migrationsDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../supabase/migrations",
);
const read = (file: string): string => readFileSync(resolve(migrationsDir, file), "utf8");
const foundationUp = read("0001_itsupport_foundation.sql");
const foundationDown = read("0001_itsupport_foundation.down.sql");
const upSql = read("0002_itsupport_intake.sql");
const downSql = read("0002_itsupport_intake.down.sql");

const TABLES = ["ticket_redactions", "triage_results"] as const;

let container: PgContainer | undefined;
let db: pg.Client | undefined;

function client(): pg.Client {
  if (!db) throw new Error("database client not connected");
  return db;
}

function applied(sql: string): void {
  if (!container) throw new Error("container not started");
  const run = runSql(container, sql);
  expect(run.stderr).not.toMatch(/ERROR/);
  expect(run.status).toBe(0);
}

async function scalar<T>(sql: string, params: unknown[] = []): Promise<T> {
  const { rows } = await client().query<Record<string, T>>(sql, params);
  return Object.values(rows[0] ?? {})[0] as T;
}

async function count(sql: string, params: unknown[] = []): Promise<number> {
  return Number(await scalar<string>(sql, params));
}

async function tableExists(table: string): Promise<boolean> {
  return (
    (await scalar<string | null>("select to_regclass($1)::text", [`itsupport.${table}`])) !== null
  );
}

type RoleResult = { ok: true; rows: Record<string, unknown>[] } | { ok: false; code: string };

async function queryAs(role: string, sql: string, params: unknown[] = []): Promise<RoleResult> {
  await client().query(`set role ${role}`);
  try {
    const { rows } = await client().query<Record<string, unknown>>(sql, params);
    return { ok: true, rows };
  } catch (error) {
    return { ok: false, code: (error as { code?: string }).code ?? String(error) };
  } finally {
    await client().query("reset role");
  }
}

function rowsOf(result: RoleResult): Record<string, unknown>[] {
  expect(result).toMatchObject({ ok: true });
  return result.ok ? result.rows : [];
}

async function insertTicket(key: string): Promise<string> {
  const result = await queryAs(
    "service_role",
    `insert into itsupport.tickets (source, raw_title, raw_description, requester_email, idempotency_key)
     values ('web', 'VPN down', 'Cannot connect to VPN', 'demo.user@example.test', $1)
     returning id`,
    [key],
  );
  return rowsOf(result)[0]?.id as string;
}

beforeAll(async () => {
  container = await startPgContainer();
  db = clientFor(container);
  await db.connect();
  applied(foundationUp);
});

afterAll(async () => {
  await db?.end().catch(() => undefined);
  removePgContainer(container);
});

describe("migration 0002_itsupport_intake", () => {
  it("runs on the Postgres 17 test image", async () => {
    expect(Number(await scalar<string>("show server_version_num"))).toBeGreaterThanOrEqual(170000);
    expect(Number(await scalar<string>("show server_version_num"))).toBeLessThan(180000);
  });

  it("up creates both tables with the listed columns", async () => {
    for (const table of TABLES) expect(await tableExists(table), table).toBe(false);

    applied(upSql);

    const { rows } = await client().query(
      `select table_name, column_name, data_type, is_nullable, column_default
       from information_schema.columns
       where table_schema = 'itsupport' and table_name = any($1)
       order by table_name, ordinal_position`,
      [TABLES],
    );
    const columns = rows.map((row: Record<string, string>) => ({
      table_name: row.table_name,
      column_name: row.column_name,
      data_type: row.data_type,
      is_nullable: row.is_nullable,
    }));
    expect(columns).toEqual([
      {
        table_name: "ticket_redactions",
        column_name: "ticket_id",
        data_type: "uuid",
        is_nullable: "NO",
      },
      {
        table_name: "ticket_redactions",
        column_name: "redacted_title",
        data_type: "text",
        is_nullable: "NO",
      },
      {
        table_name: "ticket_redactions",
        column_name: "redacted_description",
        data_type: "text",
        is_nullable: "NO",
      },
      {
        table_name: "ticket_redactions",
        column_name: "redaction_log",
        data_type: "jsonb",
        is_nullable: "NO",
      },
      {
        table_name: "ticket_redactions",
        column_name: "created_at",
        data_type: "timestamp with time zone",
        is_nullable: "NO",
      },
      {
        table_name: "triage_results",
        column_name: "ticket_id",
        data_type: "uuid",
        is_nullable: "NO",
      },
      {
        table_name: "triage_results",
        column_name: "sensitive",
        data_type: "boolean",
        is_nullable: "NO",
      },
      {
        table_name: "triage_results",
        column_name: "sensitive_flags",
        data_type: "jsonb",
        is_nullable: "NO",
      },
      {
        table_name: "triage_results",
        column_name: "checker",
        data_type: "text",
        is_nullable: "NO",
      },
      {
        table_name: "triage_results",
        column_name: "created_at",
        data_type: "timestamp with time zone",
        is_nullable: "NO",
      },
    ]);
    const defaults = Object.fromEntries(
      rows.map((row: Record<string, string | null>) => [
        `${row.table_name}.${row.column_name}`,
        row.column_default,
      ]),
    );
    expect(defaults["ticket_redactions.redaction_log"]).toBe("'[]'::jsonb");
    expect(defaults["ticket_redactions.created_at"]).toBe("now()");
    expect(defaults["triage_results.created_at"]).toBe("now()");
  });

  it("uses ticket_id as the primary key and a foreign key to itsupport.tickets(id)", async () => {
    const { rows } = await client().query(
      `select c.conrelid::regclass::text as tbl, c.contype, pg_get_constraintdef(c.oid) as def
       from pg_constraint c
       where c.conrelid in ('itsupport.ticket_redactions'::regclass, 'itsupport.triage_results'::regclass)
         and c.contype in ('p', 'f')
       order by tbl, c.contype`,
    );
    expect(rows).toEqual([
      {
        tbl: "itsupport.ticket_redactions",
        contype: "f",
        def: "FOREIGN KEY (ticket_id) REFERENCES itsupport.tickets(id) ON DELETE RESTRICT",
      },
      { tbl: "itsupport.ticket_redactions", contype: "p", def: "PRIMARY KEY (ticket_id)" },
      {
        tbl: "itsupport.triage_results",
        contype: "f",
        def: "FOREIGN KEY (ticket_id) REFERENCES itsupport.tickets(id) ON DELETE RESTRICT",
      },
      { tbl: "itsupport.triage_results", contype: "p", def: "PRIMARY KEY (ticket_id)" },
    ]);
  });

  it("up is idempotent: a second run exits 0", async () => {
    applied(upSql);
    for (const table of TABLES) expect(await tableExists(table), table).toBe(true);
  });

  it("enables RLS with no policies on both tables", async () => {
    const { rows } = await client().query(
      `select c.relname, c.relrowsecurity from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'itsupport' and c.relname = any($1) order by c.relname`,
      [TABLES],
    );
    expect(rows).toEqual([
      { relname: "ticket_redactions", relrowsecurity: true },
      { relname: "triage_results", relrowsecurity: true },
    ]);
    expect(
      await count(
        "select count(*) from pg_policies where schemaname = 'itsupport' and tablename = any($1)",
        [TABLES],
      ),
    ).toBe(0);
  });

  it("grants service_role only select, insert and update, and nothing to public roles", async () => {
    const { rows } = await client().query(
      `select table_name, grantee, privilege_type
       from information_schema.role_table_grants
       where table_schema = 'itsupport' and table_name = any($1)
         and grantee in ('PUBLIC', 'anon', 'authenticated', 'service_role')
       order by table_name, grantee, privilege_type`,
      [TABLES],
    );
    expect(rows).toEqual(
      TABLES.flatMap((table) =>
        ["INSERT", "SELECT", "UPDATE"].map((privilege_type) => ({
          table_name: table,
          grantee: "service_role",
          privilege_type,
        })),
      ),
    );
  });

  it("denies select to anon and authenticated with permission denied", async () => {
    for (const role of ["anon", "authenticated"]) {
      for (const table of TABLES) {
        expect(await queryAs(role, `select * from itsupport.${table}`), `${role} ${table}`).toEqual(
          {
            ok: false,
            code: "42501",
          },
        );
      }
    }
  });

  it("lets service_role insert, select and update both tables, but not delete", async () => {
    const ticketId = await insertTicket("it-0002-service-role");

    expect(
      await queryAs(
        "service_role",
        `insert into itsupport.ticket_redactions (ticket_id, redacted_title, redacted_description)
         values ($1, 'VPN down', 'Cannot connect to VPN from [REDACTED_IPV4]')`,
        [ticketId],
      ),
    ).toMatchObject({ ok: true });
    expect(
      await queryAs(
        "service_role",
        `insert into itsupport.triage_results (ticket_id, sensitive, sensitive_flags, checker)
         values ($1, false, '[]'::jsonb, 'keywords+typesafe')`,
        [ticketId],
      ),
    ).toMatchObject({ ok: true });

    const redaction = await queryAs(
      "service_role",
      "select redacted_title, redaction_log, created_at from itsupport.ticket_redactions where ticket_id = $1",
      [ticketId],
    );
    expect(redaction).toMatchObject({
      ok: true,
      rows: [{ redacted_title: "VPN down", redaction_log: [] }],
    });
    expect(rowsOf(redaction)[0]?.created_at).toBeInstanceOf(Date);

    expect(
      await queryAs(
        "service_role",
        `update itsupport.triage_results set sensitive = true, sensitive_flags = '["termination"]'::jsonb
         where ticket_id = $1 returning sensitive, sensitive_flags`,
        [ticketId],
      ),
    ).toMatchObject({ ok: true, rows: [{ sensitive: true, sensitive_flags: ["termination"] }] });

    for (const table of TABLES) {
      expect(
        await queryAs("service_role", `delete from itsupport.${table} where ticket_id = $1`, [
          ticketId,
        ]),
        table,
      ).toEqual({ ok: false, code: "42501" });
    }
  });

  it("rejects rows that miss a not-null column", async () => {
    const ticketId = await insertTicket("it-0002-not-null");
    expect(
      await queryAs(
        "service_role",
        "insert into itsupport.triage_results (ticket_id, sensitive, checker) values ($1, false, 'keywords')",
        [ticketId],
      ),
    ).toEqual({ ok: false, code: "23502" }); // not_null_violation
  });

  it("rejects a redaction for a ticket id that does not exist with a foreign-key error", async () => {
    for (const sql of [
      `insert into itsupport.ticket_redactions (ticket_id, redacted_title, redacted_description)
       values ($1, 't', 'd')`,
      `insert into itsupport.triage_results (ticket_id, sensitive, sensitive_flags, checker)
       values ($1, false, '[]'::jsonb, 'keywords')`,
    ]) {
      expect(await queryAs("service_role", sql, [randomUUID()])).toEqual({
        ok: false,
        code: "23503", // foreign_key_violation
      });
    }
  });

  it("keeps a ticket from being deleted while it has a redaction (ON DELETE RESTRICT)", async () => {
    const ticketId = await insertTicket("it-0002-restrict");
    await client().query(
      `insert into itsupport.ticket_redactions (ticket_id, redacted_title, redacted_description)
       values ($1, 't', 'd')`,
      [ticketId],
    );
    expect(
      await queryAs("service_role", "delete from itsupport.tickets where id = $1", [ticketId]),
    ).toEqual({ ok: false, code: "23503" });
    expect(await count("select count(*) from itsupport.tickets where id = $1", [ticketId])).toBe(1);
  });

  it("down drops only the 2 tables and keeps itsupport.tickets and its rows", async () => {
    const ticketsBefore = await count("select count(*) from itsupport.tickets");
    expect(ticketsBefore).toBeGreaterThan(0);

    applied(downSql);

    for (const table of TABLES) expect(await tableExists(table), table).toBe(false);
    expect(await tableExists("tickets")).toBe(true);
    expect(await tableExists("ticket_events")).toBe(true);
    expect(await count("select count(*) from itsupport.tickets")).toBe(ticketsBefore);
  });

  it("down is idempotent and up can be re-applied after down", async () => {
    applied(downSql);
    applied(upSql);
    for (const table of TABLES) expect(await tableExists(table), table).toBe(true);
  });

  it("0001 down still removes the whole schema with 0002 applied", async () => {
    applied(foundationDown);
    expect(
      await scalar<boolean>(
        "select exists (select 1 from pg_namespace where nspname = 'itsupport')",
      ),
    ).toBe(false);
  });
});
