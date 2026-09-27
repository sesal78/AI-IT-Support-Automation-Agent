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
const upSql = readFileSync(resolve(migrationsDir, "0001_itsupport_foundation.sql"), "utf8");
const downSql = readFileSync(resolve(migrationsDir, "0001_itsupport_foundation.down.sql"), "utf8");

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

async function schemaExists(): Promise<boolean> {
  return scalar<boolean>("select exists (select 1 from pg_namespace where nspname = 'itsupport')");
}

async function vectorRows(): Promise<number> {
  const { rowCount } = await client().query(
    "select extversion from pg_extension where extname = 'vector'",
  );
  return rowCount ?? 0;
}

type RoleResult = { ok: true; rows: unknown[] } | { ok: false; code: string };

async function queryAs(role: string, sql: string, params: unknown[] = []): Promise<RoleResult> {
  await client().query(`set role ${role}`);
  try {
    const { rows } = await client().query(sql, params);
    return { ok: true, rows };
  } catch (error) {
    return { ok: false, code: (error as { code?: string }).code ?? String(error) };
  } finally {
    await client().query("reset role");
  }
}

async function insertTicketAsServiceRole(key: string): Promise<string> {
  const ticket = await queryAs(
    "service_role",
    `insert into itsupport.tickets (source, raw_title, raw_description, requester_email, idempotency_key)
     values ('web', 'VPN down', 'Cannot connect to VPN', 'demo.user@example.test', $1)
     returning id`,
    [key],
  );
  expect(ticket).toMatchObject({ ok: true });
  const id = ((ticket as { rows: { id: string }[] }).rows[0] as { id: string }).id;
  const event = await queryAs(
    "service_role",
    "insert into itsupport.ticket_events (ticket_id, type, payload) values ($1, 'ticket.created', '{}'::jsonb)",
    [id],
  );
  expect(event).toMatchObject({ ok: true });
  return id;
}

beforeAll(async () => {
  container = await startPgContainer();
  db = clientFor(container);
  await db.connect();
});

afterAll(async () => {
  await db?.end().catch(() => undefined);
  removePgContainer(container);
});

describe("migration 0001_itsupport_foundation", () => {
  it("up on an empty database creates the schema, tables and vector extension", async () => {
    expect(await schemaExists()).toBe(false);

    applied(upSql);

    expect(await scalar("select to_regclass('itsupport.tickets')::text")).toBe("itsupport.tickets");
    expect(await scalar("select to_regclass('itsupport.ticket_events')::text")).toBe(
      "itsupport.ticket_events",
    );
    expect(await vectorRows()).toBe(1);
    expect(
      await scalar(
        `select n.nspname from pg_extension e
         join pg_namespace n on n.oid = e.extnamespace where e.extname = 'vector'`,
      ),
    ).toBe("extensions");
  });

  it("up is idempotent: a second run exits 0", () => {
    applied(upSql);
  });

  it("enables RLS with no policies on both tables", async () => {
    const { rows } = await client().query(
      `select c.relname, c.relrowsecurity from pg_class c
       join pg_namespace n on n.oid = c.relnamespace
       where n.nspname = 'itsupport' and c.relkind = 'r' order by c.relname`,
    );
    expect(rows).toEqual([
      { relname: "ticket_events", relrowsecurity: true },
      { relname: "tickets", relrowsecurity: true },
    ]);
    expect(await count("select count(*) from pg_policies where schemaname = 'itsupport'")).toBe(0);
  });

  it("lets service_role insert while anon and authenticated read nothing", async () => {
    await insertTicketAsServiceRole("it-rls-1");
    expect(await count("select count(*) from itsupport.tickets")).toBeGreaterThan(0);

    for (const role of ["anon", "authenticated"]) {
      const result = await queryAs(role, "select * from itsupport.tickets");
      if (result.ok) {
        expect(result.rows, role).toEqual([]);
      } else {
        expect(result.code, role).toBe("42501"); // insufficient_privilege
      }
    }
  });

  it("keeps ticket_events append-only for service_role", async () => {
    const ticketId = await insertTicketAsServiceRole("it-append-only-1");
    const before = await count("select count(*) from itsupport.ticket_events");

    for (const sql of [
      "update itsupport.ticket_events set type = 'tampered'",
      "delete from itsupport.ticket_events",
      "truncate itsupport.ticket_events",
    ]) {
      expect(await queryAs("service_role", sql), sql).toMatchObject({ ok: false });
    }

    expect(await count("select count(*) from itsupport.ticket_events")).toBe(before);
    expect(
      await count("select count(*) from itsupport.ticket_events where ticket_id = $1", [ticketId]),
    ).toBe(1);
  });

  it("down drops the itsupport schema but keeps the vector extension", async () => {
    applied(downSql);

    expect(await schemaExists()).toBe(false);
    expect(await vectorRows()).toBe(1);
  });

  it("up can be re-applied after down", async () => {
    applied(upSql);
    expect(await schemaExists()).toBe(true);
  });
});
