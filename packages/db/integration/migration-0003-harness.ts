import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { expect } from "vitest";
import {
  clientFor,
  removePgContainer,
  runSql,
  startPgContainer,
  type PgContainer,
} from "./pg-container.js";

// Shared helpers for the migration 0003 integration tests (one container per test file).

const supabaseDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../supabase");
export const read = (file: string): string => readFileSync(resolve(supabaseDir, file), "utf8");

// Phase-2 columns only, so a snapshot is the same before and after 0003.
const PHASE2_COLUMNS: Record<string, string> = {
  tickets:
    "id, source, raw_title, raw_description, requester_email, requester_name, department, status, servicenow_sys_id, servicenow_number, idempotency_key, created_at",
  ticket_redactions: "ticket_id, redacted_title, redacted_description, redaction_log, created_at",
  triage_results: "ticket_id, sensitive, sensitive_flags, checker, created_at",
  ticket_events: "id, ticket_id, type, payload, at",
};

let container: PgContainer | undefined;
let db: pg.Client | undefined;

export function client(): pg.Client {
  if (!db) throw new Error("database client not connected");
  return db;
}

/**
 * Opens one more connection to the test database (for lock and race tests), as
 * `postgres` or another login role of the image (same per-run password); the caller ends it.
 */
export async function connect(user = "postgres"): Promise<pg.Client> {
  if (!container) throw new Error("container not started");
  const extra =
    user === "postgres"
      ? clientFor(container)
      : new pg.Client({ ...clientFor(container), user, password: container.password });
  await extra.connect();
  return extra;
}

/** Runs a SQL file with psql in one transaction and expects it to exit 0. */
export function applied(sql: string): void {
  if (!container) throw new Error("container not started");
  const run = runSql(container, sql);
  expect(run.stderr).not.toMatch(/ERROR/);
  expect(run.status).toBe(0);
}

/** The phase-2 columns of every phase-2 table, in a stable order. */
export async function snapshot(): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const [table, columns] of Object.entries(PHASE2_COLUMNS)) {
    out[table] = (
      await client().query(`select ${columns} from itsupport.${table} order by 1, 2`)
    ).rows;
  }
  return out;
}

export type Outcome = { ok: true } | { ok: false; code: string };

/** Runs one statement in a transaction that is always rolled back, so it leaves no trace. */
export async function inRollback(sql: string, role?: string): Promise<Outcome> {
  await client().query("begin");
  try {
    if (role) await client().query(`set local role ${role}`);
    await client().query(sql);
    return { ok: true };
  } catch (error) {
    return { ok: false, code: (error as { code?: string }).code ?? String(error) };
  } finally {
    await client().query("rollback");
  }
}

/** Runs the check query in a read-only transaction, which proves it writes nothing. */
export async function check(): Promise<{ object: string; ok: boolean }[]> {
  await client().query("begin transaction read only");
  try {
    const { rows } = await client().query<{ object: string; ok: boolean }>(
      read("checks/0003_itsupport_triage_kb.check.sql"),
    );
    return rows.sort((a, b) => (a.object < b.object ? -1 : 1));
  } finally {
    await client().query("commit");
  }
}

/**
 * Starts Postgres 17 with 0001 and 0002 applied and phase-2-shaped rows: two
 * `new` tickets, each with a redaction, a triage result and 3 events.
 * Returns their snapshot. `before` runs first (e.g. default privileges).
 */
export async function startWithPhase2Rows(before?: string): Promise<Record<string, unknown[]>> {
  container = await startPgContainer();
  db = clientFor(container);
  await db.connect();
  if (before) await db.query(before);
  applied(read("migrations/0001_itsupport_foundation.sql"));
  applied(read("migrations/0002_itsupport_intake.sql"));
  await db.query(`
    insert into itsupport.tickets (source, raw_title, raw_description, requester_email, requester_name, department, idempotency_key)
    values ('web', 'VPN down', 'Cannot connect to VPN', 'demo.user@example.test', 'Demo User', 'Finance', 'web:it-0003-a'),
           ('email', 'Printer jam', 'Tray 2 jams', 'demo.other@example.test', null, null, 'email:it-0003-b');
    insert into itsupport.ticket_redactions (ticket_id, redacted_title, redacted_description)
      select id, raw_title, raw_description from itsupport.tickets;
    insert into itsupport.triage_results (ticket_id, sensitive, sensitive_flags, checker)
      select id, false, '[]'::jsonb, 'keywords+typesafe' from itsupport.tickets;
    insert into itsupport.ticket_events (ticket_id, type)
      select id, kind from itsupport.tickets,
        unnest(array['received', 'redacted', 'sensitive_checked']) as kind;
  `);
  return snapshot();
}

/** Closes the client and removes the container. Safe to call twice. */
export async function stop(): Promise<void> {
  await db?.end().catch(() => undefined);
  db = undefined;
  removePgContainer(container);
  container = undefined;
}
