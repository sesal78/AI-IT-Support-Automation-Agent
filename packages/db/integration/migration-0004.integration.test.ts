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

// Migration 0004: no right on any itsupport sequence for anyone but the owner,
// even when Supabase-like default privileges were set before 0001.

const up = (n: string) => read(`migrations/${n}.sql`);
const down = (n: string) => read(`migrations/${n}.down.sql`);
const M = ["0001_itsupport_foundation", "0002_itsupport_intake", "0003_itsupport_triage_kb"];
const M4 = "0004_itsupport_lock_sequences";
const SEQS = ["itsupport.security_events_id_seq", "itsupport.ticket_events_id_seq"];
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

const check4 = async () => {
  await client().query("begin transaction read only");
  try {
    return (await client().query<{ object: string; ok: boolean }>(read(`checks/${M4}.check.sql`)))
      .rows;
  } finally {
    await client().query("commit");
  }
};
/** Every right any non-owner role (public included) holds on an itsupport sequence. */
const seqRights = async () =>
  (
    await client().query(
      `select r, s from unnest(array['public', 'anon', 'authenticated', 'service_role']) r,
         unnest($1::text[]) s
       where has_sequence_privilege(r, s, 'usage') or has_sequence_privilege(r, s, 'select')
         or has_sequence_privilege(r, s, 'update')`,
      [SEQS],
    )
  ).rows;
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

  it("up (twice), down (twice), up: each exits 0, keeps the rows; the check stays all true", async () => {
    for (const sql of [up(M4), up(M4), down(M4), down(M4), up(M4)]) {
      applied(sql);
      expect(await snapshot()).toEqual(phase2);
      const rows = await check4();
      expect(rows).toHaveLength(3);
      expect(rows.filter((row) => !row.ok)).toEqual([]);
      expect(await seqRights()).toEqual([]);
    }
    expect((await check()).filter((row) => !row.ok)).toEqual([]);
  });

  it("anon and authenticated get 42501 on nextval and setval", async () => {
    for (const role of ["anon", "authenticated"])
      for (const seq of SEQS) {
        expect(await inRollback(`select nextval('${seq}')`, role)).toEqual(DENIED);
        expect(await inRollback(`select setval('${seq}', 1000)`, role)).toEqual(DENIED);
      }
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
      ).toEqual(["grants every itsupport sequence", `grants ${SEQS[1]}`]);
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
});
