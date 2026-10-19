import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  applied,
  check,
  client,
  connect,
  inRollback,
  read,
  snapshot,
  startWithPhase2Rows,
  stop,
} from "./migration-0003-harness.js";

// Migration 0004: no right on any itsupport sequence for anyone but the owner,
// even when Supabase-like default privileges were set before 0001.

const up = (n: string) => read(`migrations/${n}.sql`);
const down = (n: string) => read(`migrations/${n}.down.sql`);
const M = ["0001_itsupport_foundation", "0002_itsupport_intake", "0003_itsupport_triage_kb"];
const M4 = "0004_itsupport_lock_sequences";
// Every sequence in itsupport; seqRights() fails when one appears that is not listed here.
const SEQS = ["itsupport.security_events_id_seq", "itsupport.ticket_events_id_seq"];
const DENIED = { ok: false, code: "42501" };
// The check rows for default privileges, false while this file's defaults are in place.
const DEFAULT_ROWS = [
  "default privileges in every schema",
  "default privileges in schema itsupport",
];
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

const check4 = async () => {
  await client().query("begin transaction read only");
  try {
    return (await client().query<{ object: string; ok: boolean }>(read(`checks/${M4}.check.sql`)))
      .rows;
  } finally {
    await client().query("commit");
  }
};
/** Every sequence in itsupport (pg_class relkind 'S'), sorted. */
const sequences = async () =>
  (
    await client().query<{ s: string }>(
      `select c.oid::regclass::text as s from pg_catalog.pg_class c
       where c.relnamespace = to_regnamespace('itsupport') and c.relkind = 'S' order by 1`,
    )
  ).rows.map((row) => row.s);
/**
 * Every right any non-owner role (public included) holds on any itsupport
 * sequence. Fails when itsupport has a sequence that SEQS does not cover.
 */
const seqRights = async () => {
  expect(await sequences(), "a new itsupport sequence must be added to SEQS").toEqual(SEQS);
  return (
    await client().query(
      `select r, c.oid::regclass::text as s
       from unnest(array['public', 'anon', 'authenticated', 'service_role']) r, pg_catalog.pg_class c
       where c.relnamespace = to_regnamespace('itsupport') and c.relkind = 'S'
         and has_sequence_privilege(r, c.oid, 'usage, select, update')
       order by 2, 1`,
    )
  ).rows;
};
/**
 * Runs `sql` as `role` in a transaction that is always rolled back, after
 * granting USAGE on the itsupport schema to anon and authenticated, so a 42501
 * can only come from the sequence itself. `undo` runs first, as postgres.
 */
const withSchemaUsage = async (sql: string, role: string, undo = "") => {
  await client().query("begin");
  try {
    await client().query(`grant usage on schema itsupport to anon, authenticated; ${undo}`);
    await client().query(`set local role ${role}`);
    await client().query(sql);
    return { ok: true };
  } catch (error) {
    const { code, message } = error as { code?: string; message?: string };
    return { ok: false, code, message };
  } finally {
    await client().query("rollback");
  }
};
// What 0004 revoked (Supabase-like defaults gave it), for proving the 42501 depends on 0004.
const UNDO_0004 = `grant usage, select, update on sequence ${SEQS.join(", ")} to anon, authenticated;`;
const insertEvent = `insert into itsupport.ticket_events (ticket_id, type, payload)
  select id, 'probe', '{}'::jsonb from itsupport.tickets limit 1 returning *`;

let phase2: Record<string, unknown[]> = {};

beforeAll(async () => {
  phase2 = await startWithPhase2Rows(`create schema itsupport; ${defaults("grant")}`);
  applied(up(M[2]!));
});

afterAll(stop);

describe("migration 0004 with Supabase-like default privileges set before 0001", () => {
  it("before 0004 the sequences are open and the check returns false rows (wrong variant)", async () => {
    expect(await seqRights()).toEqual(
      expect.arrayContaining(["anon", "authenticated"].map((r) => ({ r, s: SEQS[1] }))),
    );
    const rows = await check4();
    expect(rows.filter((row) => !row.ok).map((row) => row.object)).toEqual(
      expect.arrayContaining([`grants ${SEQS[1]}`, "grants every itsupport sequence"]),
    );
  });

  it("up (twice), down (twice), up: each exits 0, keeps the rows; only the default-privilege rows are false", async () => {
    for (const sql of [up(M4), up(M4), down(M4), down(M4), up(M4)]) {
      applied(sql);
      expect(await snapshot()).toEqual(phase2);
      const rows = await check4();
      expect(rows).toHaveLength(5);
      expect(rows.filter((row) => !row.ok).map((row) => row.object)).toEqual(DEFAULT_ROWS);
      expect(await seqRights()).toEqual([]);
    }
    expect((await check()).filter((row) => !row.ok)).toEqual([]);
  });

  it("with USAGE on the schema, anon and authenticated get 42501 from every sequence on nextval and setval", async () => {
    expect(await sequences()).toEqual(SEQS);
    for (const role of ["anon", "authenticated"])
      for (const seq of SEQS)
        for (const sql of [`select nextval('${seq}')`, `select setval('${seq}', 1000)`]) {
          expect(await withSchemaUsage(sql, role), `${role}: ${sql}`).toEqual({
            ...DENIED,
            message: `permission denied for sequence ${seq.replace("itsupport.", "")}`,
          });
        }
  });

  it("that 42501 depends on 0004: with its revoke undone (rolled back), nextval and setval work", async () => {
    for (const role of ["anon", "authenticated"])
      for (const seq of SEQS) {
        // setval to 1000 is not rolled back; ids stay above the existing rows.
        for (const sql of [`select nextval('${seq}')`, `select setval('${seq}', 1000)`])
          expect(await withSchemaUsage(sql, role, UNDO_0004), `${role}: ${sql}`).toEqual({
            ok: true,
          });
        // Without schema USAGE the old assertion still saw 42501, so it could not catch a missing 0004.
        const old = await inRollback(
          `${UNDO_0004} set local role ${role}; select nextval('${seq}')`,
        );
        expect(old, role).toEqual(DENIED);
      }
    expect(await seqRights()).toEqual([]);
  });

  it("seqRights fails when itsupport has a sequence that SEQS does not cover", async () => {
    await client().query("begin");
    try {
      await client().query(
        "create sequence itsupport.probe_seq; grant usage on sequence itsupport.probe_seq to anon",
      );
      await expect(seqRights()).rejects.toThrow(/a new itsupport sequence must be added to SEQS/);
      expect(await sequences()).toEqual([...SEQS, "itsupport.probe_seq"].sort());
    } finally {
      await client().query("rollback");
    }
    expect(await seqRights()).toEqual([]);
  });

  it("service_role still inserts ticket events and security events (identity needs no sequence right)", async () => {
    expect(await inRollback(insertEvent, "service_role")).toEqual({ ok: true });
    const record = "select itsupport.security_event_record('probe', 'probe')";
    expect(await inRollback(record, "service_role")).toEqual({ ok: true });
  });

  it("the check flips when a sequence right comes back", async () => {
    await client().query("begin");
    try {
      await client().query(`grant usage on sequence ${SEQS[1]} to service_role`);
      const rows = await client().query<{ object: string; ok: boolean }>(
        read(`checks/${M4}.check.sql`),
      );
      expect(
        rows.rows
          .filter((row) => !row.ok)
          .map((row) => row.object)
          .sort(),
      ).toEqual([...DEFAULT_ROWS, "grants every itsupport sequence", `grants ${SEQS[1]}`]);
    } finally {
      await client().query("rollback");
    }
  });
});

describe("migration 0004 without default privileges", () => {
  it("full rebuild 0001 -> 0004 gives an all-true check and no sequence right", async () => {
    await client().query(defaults("revoke"));
    for (const name of [...M, M4].reverse()) applied(down(name));
    for (const name of [...M, M4]) applied(up(name));
    expect((await check4()).filter((row) => !row.ok)).toEqual([]);
    expect((await check()).filter((row) => !row.ok)).toEqual([]);
    expect(await seqRights()).toEqual([]);
  });

  it("the correct database is all true as postgres and supabase_admin, with LF and CRLF", async () => {
    const lf = read(`checks/${M4}.check.sql`).replace(/\r\n/g, "\n");
    expect(lf).not.toContain("\r");
    for (const user of ["postgres", "supabase_admin"]) {
      const as = await connect(user);
      try {
        expect((await as.query("select current_user as u")).rows).toEqual([{ u: user }]);
        for (const sql of [lf, lf.replace(/\n/g, "\r\n")]) {
          await as.query("begin transaction read only");
          try {
            const { rows } = await as.query<{ object: string; ok: boolean }>(sql);
            expect(rows.filter((row) => !row.ok)).toEqual([]);
            expect(rows.map((row) => row.object).sort()).toEqual(
              [
                ...DEFAULT_ROWS,
                "grants every itsupport sequence",
                ...SEQS.map((s) => `grants ${s}`),
              ].sort(),
            );
          } finally {
            await as.query("rollback");
          }
        }
      } finally {
        await as.end();
      }
    }
  });

  it("each default-privilege variant flips only its own row; service_role and built-in rights flip none", async () => {
    const [global, schema] = DEFAULT_ROWS;
    const variants: [string, string[]][] = [
      ["for role postgres in schema itsupport grant select on tables to anon", [schema!]],
      [
        "for role supabase_admin in schema itsupport grant usage on sequences to authenticated",
        [schema!],
      ],
      ["for role postgres in schema itsupport grant execute on functions to anon", [schema!]],
      ["for role postgres in schema itsupport grant usage on types to authenticated", [schema!]],
      ["for role postgres in schema itsupport grant insert on tables to public", [schema!]],
      ["for role postgres grant select on tables to public", [global!]],
      ["for role supabase_admin grant all on sequences to anon", [global!]],
      ["for role postgres grant execute on functions to authenticated", [global!]],
      ["for role postgres in schema itsupport grant all on tables to service_role", []],
      ["for role postgres grant execute on functions to service_role", []],
      ["for role postgres revoke execute on functions from public", []],
    ];
    // supabase_admin may set default privileges for any role.
    const as = await connect("supabase_admin");
    try {
      for (const [variant, wrong] of variants) {
        await as.query("begin");
        try {
          await as.query(`alter default privileges ${variant}`);
          const { rows } = await as.query<{ object: string; ok: boolean }>(
            read(`checks/${M4}.check.sql`),
          );
          expect(
            rows.filter((row) => !row.ok).map((row) => row.object),
            variant,
          ).toEqual(wrong);
        } finally {
          await as.query("rollback");
        }
      }
    } finally {
      await as.end();
    }
    expect((await check4()).filter((row) => !row.ok)).toEqual([]);
  });
});
