import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type pg from "pg";
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

// Migration 0003 part 4 (security_events), the isolation guard of
// ai_budget_reserve, and the whole up -> down -> up run (T3.I.11).

const upSql = read("migrations/0003_itsupport_triage_kb.sql");
const downSql = read("migrations/0003_itsupport_triage_kb.down.sql");
const SE = "itsupport.security_events";
const RECORD = "itsupport.security_event_record(text, text, jsonb)";
const RESERVE = "itsupport.ai_budget_reserve(text, numeric, integer, integer, text, text, uuid)";
const FUNCTIONS = ["itsupport.kb_search(text, integer)", "itsupport.ai_usage_month(date)"];
const TABLES = ["tickets", "triage_results", "kb_articles", "ai_calls", "security_events"];
const DENIED = { ok: false, code: "42501" };
const PART4 = [
  ...["id", "source", "kind", "window_start", "count", "sample"].map((c) => `column ${SE}.${c}`),
  ...["pkey", "source_kind_window_start_key", "count_check"].map(
    (name) => `constraint ${SE}.security_events_${name}`,
  ),
  `index ${SE}.security_events_window_start_idx`,
  ...["checks", "columns", "grants", "owner", "rls"].map((kind) => `${kind} ${SE}`),
  "function itsupport.security_event_record",
  "owner itsupport.security_event_record",
];
// The current minute, computed in UTC.
const MINUTE = "date_trunc('minute', now() at time zone 'UTC') at time zone 'UTC'";

const record = async (source: string | null, kind: string | null, sample = {}, on = client()) =>
  (
    await on.query<{ n: number }>("select itsupport.security_event_record($1, $2, $3) as n", [
      source,
      kind,
      sample,
    ])
  ).rows[0]?.n;
const events = async () =>
  (
    await client().query(
      `select source, kind, count, sample, window_start = ${MINUTE} as now from ${SE}
       order by window_start, source, kind`,
    )
  ).rows;

/** Waits until the database clock is at least 15 s before the next minute. */
async function awayFromMinuteEdge(): Promise<void> {
  const second = "select extract(second from clock_timestamp())::float as s";
  while (((await client().query(second)).rows[0]?.s as number) >= 45)
    await new Promise((r) => setTimeout(r, 1000));
}

let phase2: Record<string, unknown[]> = {};

beforeAll(async () => {
  phase2 = await startWithPhase2Rows();
});

afterAll(stop);

describe("migration 0003, T3.I.11 (whole up, down, up with phase-2 rows)", () => {
  it("each step exits 0, keeps the phase-2 rows; the check query is all true, all false, all true", async () => {
    for (const [sql, ok] of [
      [upSql, true],
      [downSql, false],
      [upSql, true],
    ] as const) {
      applied(sql);
      expect(await snapshot()).toEqual(phase2);
      const rows = await check();
      expect(new Set(rows.map((row) => row.object)).size).toBe(rows.length);
      expect(rows.map((row) => row.object)).toEqual(expect.arrayContaining(PART4));
      expect(rows.filter((row) => row.ok !== ok)).toEqual([]);
    }
  });

  it("RLS is on with 0 policies; anon and authenticated hold no table privilege or execute", async () => {
    const { rows } = await client().query(
      `select c.relname, c.relrowsecurity as rls,
         (select count(*)::int from pg_policy p where p.polrelid = c.oid) as policies
       from pg_class c where c.oid = any($1::regclass[]) order by c.relname`,
      [TABLES.map((t) => `itsupport.${t}`)],
    );
    expect(rows).toEqual(
      [...TABLES].sort().map((relname) => ({ relname, rls: true, policies: 0 })),
    );
    const privs = await client().query(
      `select r, t from unnest(array['anon', 'authenticated']) r, unnest($1::text[]) t
       where has_table_privilege(r, t, 'select, insert, update, delete, truncate, references, trigger')
       union all
       select r, f from unnest(array['anon', 'authenticated']) r, unnest($2::text[]) f
       where has_function_privilege(r, f, 'execute')`,
      [TABLES.map((t) => `itsupport.${t}`), [...FUNCTIONS, RESERVE, RECORD]],
    );
    expect(privs.rows).toEqual([]);
    const fks = `select conname from pg_constraint where conrelid = '${SE}'::regclass and contype = 'f'`;
    expect((await client().query(fks)).rows).toEqual([]);
  });
});

describe("migration 0003, part 4 (security_events, security_event_record)", () => {
  beforeEach(() => client().query(`delete from ${SE}`));

  it("50 parallel calls on 50 connections in one minute give 1 row with count 50 (5 runs)", async () => {
    const conns: pg.Client[] = [];
    try {
      for (let i = 0; i < 50; i += 1) conns.push(await connect());
      await Promise.all(conns.map((c) => c.query("set role service_role")));
      for (let run = 0; run < 5; run += 1) {
        await client().query(`delete from ${SE}`);
        await awayFromMinuteEdge();
        const counts = await Promise.all(
          conns.map((c, i) => record("internal_api", "bad_token", { i }, c)),
        );
        expect(counts.sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual(
          Array.from({ length: 50 }, (_, i) => i + 1),
        );
        expect(await events()).toMatchObject([
          { source: "internal_api", kind: "bad_token", count: 50, now: true },
        ]);
      }
    } finally {
      await Promise.all(conns.map((c) => c.end().catch(() => undefined)));
    }
  }, 180_000);

  it("keeps the first sample; another kind and a later minute get their own rows", async () => {
    await awayFromMinuteEdge();
    await client().query(
      `insert into ${SE} (source, kind, window_start, count, sample)
       values ('internal_api', 'bad_token', ${MINUTE} - interval '1 minute', 7, '{"old": 1}')`,
    );
    expect(await record("internal_api", "bad_token", { first: 1 })).toBe(1);
    expect(await record("internal_api", "bad_token", { second: 2 })).toBe(2);
    const plain = "select itsupport.security_event_record('internal_api', 'rate_limited') as n";
    expect((await client().query(plain)).rows).toEqual([{ n: 1 }]);
    expect(await events()).toEqual([
      { source: "internal_api", kind: "bad_token", count: 7, sample: { old: 1 }, now: false },
      { source: "internal_api", kind: "bad_token", count: 2, sample: { first: 1 }, now: true },
      { source: "internal_api", kind: "rate_limited", count: 1, sample: {}, now: true },
    ]);
  });

  it("raises 22023 for a blank or null source or kind and writes nothing", async () => {
    for (const [source, kind] of [
      ["", "k"],
      [" \t", "k"],
      [null, "k"],
      ["s", ""],
      ["s", "  "],
      ["s", null],
    ]) {
      await expect(record(source ?? null, kind ?? null), `${source}/${kind}`).rejects.toMatchObject(
        { code: "22023" },
      );
    }
    expect(await events()).toEqual([]);
  });

  it("the window is the UTC minute in any session time zone", async () => {
    for (const zone of ["UTC", "Asia/Kathmandu", "America/St_Johns", "Pacific/Chatham"]) {
      await client().query(`set time zone '${zone}'`);
      await record("tz", zone);
    }
    await client().query("reset time zone");
    const { rows } = await client().query(
      `select kind, (extract(epoch from window_start)::numeric % 60)::float as sec,
         window_start > now() - interval '2 minutes' and window_start <= now() as recent
       from ${SE} order by kind`,
    );
    expect(rows.map((row) => [row.sec, row.recent])).toEqual(Array(4).fill([0, true]));
  });

  it("anon and authenticated get 42501 on the table and the function; service_role cannot delete", async () => {
    const sqls = [
      `select * from ${SE}`,
      `insert into ${SE} (source, kind, window_start) values ('s', 'k', now())`,
      "select itsupport.security_event_record('s', 'k')",
    ];
    for (const role of ["anon", "authenticated"]) {
      for (const sql of sqls)
        expect(await inRollback(sql, role), `${role}: ${sql}`).toEqual(DENIED);
    }
    expect(await inRollback(sqls[2] ?? "", "service_role")).toEqual({ ok: true });
    expect(await inRollback(`delete from ${SE}`, "service_role")).toEqual(DENIED);
  });

  it("the check query flips only its own row for each wrong variant", async () => {
    const fn = (name: string) =>
      new RegExp(`create or replace function itsupport\\.${name}[\\s\\S]*?\\$\\$;`).exec(
        upSql,
      )?.[0] ?? "";
    expect(fn("security_event_record")).toContain("security_events.count + 1");
    expect(fn("ai_budget_reserve")).toContain("<> 'read committed'");
    const f4 = "function itsupport.security_event_record";
    const variants = [
      [`alter table ${SE} alter id set generated by default`, `column ${SE}.id`],
      [`alter table ${SE} alter count set default 2`, `column ${SE}.count`],
      [`alter table ${SE} alter sample drop not null`, `column ${SE}.sample`],
      [`drop index itsupport.security_events_window_start_idx`, PART4[9]],
      [
        `alter table ${SE} drop constraint security_events_source_kind_window_start_key,
         add constraint security_events_source_kind_window_start_key unique (source, kind)`,
        PART4[7],
      ],
      [`alter table ${SE} add constraint extra check (true)`, `checks ${SE}`],
      [`alter table ${SE} add column extra text`, `columns ${SE}`],
      [`grant select on ${SE} to anon`, `grants ${SE}`],
      [`create policy p_open on ${SE} using (true)`, `rls ${SE}`],
      [`grant create on schema itsupport to anon; alter table ${SE} owner to anon`, `owner ${SE}`],
      [`grant execute on function ${RECORD} to authenticated`, f4],
      [`alter function ${RECORD} security definer`, f4],
      [
        fn("security_event_record").replace(
          "security_events.count + 1",
          "security_events.count + 2",
        ),
        f4,
      ],
      [
        fn("ai_budget_reserve").replace("<> 'read committed'", "= 'serializable'"),
        "function itsupport.ai_budget_reserve",
      ],
    ];
    for (const [sql, wrong] of variants) {
      await client().query("begin");
      try {
        await client().query(sql ?? "");
        const { rows } = await client().query(read("checks/0003_itsupport_triage_kb.check.sql"));
        expect(
          rows.filter((row) => !row.ok).map((row) => row.object),
          sql,
        ).toEqual([wrong]);
      } finally {
        await client().query("rollback");
      }
    }
  });

  it("the down file drops part 4 first: the function, then the table", () => {
    const dropFn = downSql.indexOf(`drop function if exists ${RECORD};`);
    expect(downSql.search(/^drop /m)).toBe(dropFn);
    expect(dropFn).toBeLessThan(downSql.indexOf(`drop table if exists ${SE};`));
    expect(downSql.indexOf(`drop table if exists ${SE};`)).toBeLessThan(
      downSql.indexOf("-- Part 3:"),
    );
  });
});

describe("migration 0003, ai_budget_reserve isolation guard", () => {
  it("REPEATABLE READ and SERIALIZABLE callers get 25001 before the lock and write nothing", async () => {
    const other = await connect();
    const call = "select * from itsupport.ai_budget_reserve('llm', 0, 1, 100, 'e2e', 'k')";
    const held = `select (select count(*)::int from pg_locks where locktype = 'advisory') as locks,
      (select count(*)::int from itsupport.ai_calls) as calls`;
    try {
      for (const level of ["repeatable read", "serializable"]) {
        await other.query(`begin isolation level ${level}; set local role service_role`);
        await expect(other.query(call), level).rejects.toMatchObject({ code: "25001" });
        expect((await client().query(held)).rows, level).toEqual([{ locks: 0, calls: 0 }]);
        await other.query("rollback");
      }
      await other.query("begin isolation level read committed; set local role service_role");
      expect((await other.query(call)).rows).toMatchObject([{ allowed: true, used_calls: 1 }]);
      await other.query("rollback");
    } finally {
      await other.end();
    }
  });
});

describe("migration 0001 down with 0003 applied", () => {
  it("removes the whole itsupport schema", async () => {
    applied(read("migrations/0001_itsupport_foundation.down.sql"));
    const { rows } = await client().query("select to_regnamespace('itsupport') as ns");
    expect(rows).toEqual([{ ns: null }]);
  });
});
