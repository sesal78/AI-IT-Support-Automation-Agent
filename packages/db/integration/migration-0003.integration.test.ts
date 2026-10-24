import { TICKET_STATUSES } from "@ai-it-support/shared";
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
  "checks itsupport.tickets",
  "checks itsupport.triage_results",
].sort();
// Part 2: kb_articles.
const PART2_OBJECTS = [
  ...["id", "slug", "title", "content", "category", "assignment_group", "search"].map(
    (column) => `column itsupport.kb_articles.${column}`,
  ),
  ...["category_check", "pkey", "slug_key"].map(
    (name) => `constraint itsupport.kb_articles.kb_articles_${name}`,
  ),
  "index itsupport.kb_articles.kb_articles_search_idx",
  "function itsupport.kb_search",
  ...["checks", "columns", "grants", "owner", "rls"].map((kind) => `${kind} itsupport.kb_articles`),
  ...["indexes", "triggers", "rules", "publications"].map(
    (kind) => `${kind} itsupport.kb_articles`,
  ),
  "owner itsupport.kb_search",
  "collation itsupport.kb_articles.slug",
];
// Part 3: ai_calls and ai_usage_month.
const PART3_OBJECTS = [
  ...[
    "id",
    "ticket_id",
    "provider",
    "kind",
    "calls",
    "tokens_in",
    "tokens_out",
    "cost_usd",
    "environment",
    "at",
  ].map((column) => `column itsupport.ai_calls.${column}`),
  ...["pkey", "ticket_id_fkey", "provider_check", "calls_check"].map(
    (name) => `constraint itsupport.ai_calls.ai_calls_${name}`,
  ),
  "index itsupport.ai_calls.ai_calls_provider_at_idx",
  ...["checks", "columns", "grants", "owner", "rls"].map((kind) => `${kind} itsupport.ai_calls`),
  "function itsupport.ai_usage_month",
  "owner itsupport.ai_usage_month",
  "function itsupport.ai_budget_reserve",
  "owner itsupport.ai_budget_reserve",
];
// Part 4: security_events and security_event_record.
const PART4_OBJECTS = [
  ...["id", "source", "kind", "window_start", "count", "sample"].map(
    (column) => `column itsupport.security_events.${column}`,
  ),
  ...["pkey", "source_kind_window_start_key", "count_check"].map(
    (name) => `constraint itsupport.security_events.security_events_${name}`,
  ),
  "index itsupport.security_events.security_events_window_start_idx",
  ...["checks", "columns", "grants", "owner", "rls"].map(
    (kind) => `${kind} itsupport.security_events`,
  ),
  "function itsupport.security_event_record",
  "owner itsupport.security_event_record",
  "grants itsupport.security_events_id_seq",
];
const OBJECTS = [...PART1_OBJECTS, ...PART2_OBJECTS, ...PART3_OBJECTS, ...PART4_OBJECTS].sort();

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
    expect(await check()).toEqual(OBJECTS.map((object) => ({ object, ok: true })));
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
        OBJECTS.map((object) => ({ object, ok: !wrong.includes(object) })),
      );
    } finally {
      await client().query("rollback");
    }
    expect(await check()).toEqual(OBJECTS.map((object) => ({ object, ok: true })));
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
    expect(await check()).toEqual(OBJECTS.map((object) => ({ object, ok: false })));
  });

  it("down is idempotent and up works again after down", async () => {
    applied(downSql);
    applied(upSql);
    expect(await snapshot()).toEqual(phase2);
    expect(await check()).toEqual(OBJECTS.map((object) => ({ object, ok: true })));
  });
});

const KB = "itsupport.kb_articles";
const insertKb = (values: string) =>
  `insert into ${KB} (slug, title, content, category, assignment_group) values ${values}`;
const DENIED = { ok: false, code: "42501" };
const count = async () =>
  (await client().query(`select count(*)::int as n from ${KB}`)).rows[0]?.n as number;

describe("migration 0003_itsupport_triage_kb, part 2 (kb_articles)", () => {
  beforeAll(async () => {
    await client().query(
      insertKb(`('vpn-connect', 'VPN will not connect', 'Restart the VPN client.', 'network', 'Network'),
        ('printer-jam', 'Clear a printer jam', 'Open tray 2.', 'hardware', 'Hardware')`),
    );
  });

  it("adds the listed columns and a generated search column (index: check query)", async () => {
    const { rows } = await client().query(
      `select concat_ws(' ', column_name, udt_name, is_nullable, column_default, is_generated) as col
       from information_schema.columns
       where table_schema = 'itsupport' and table_name = 'kb_articles' order by ordinal_position`,
    );
    expect(rows.map((row) => row.col)).toEqual([
      "id uuid NO gen_random_uuid() NEVER",
      ...["slug", "title", "content", "category", "assignment_group"].map(
        (c) => `${c} text NO NEVER`,
      ),
      "search tsvector YES ALWAYS",
    ]);
    const search = await client().query(
      `select search::text from ${KB} where slug = 'vpn-connect'`,
    );
    expect(search.rows[0]?.search).toContain("'vpn':");
  });

  it("rejects a duplicate slug with 23505 and a bad category with 23514", async () => {
    const add = (slug: string, category: string) =>
      inRollback(insertKb(`('${slug}', 't', 'c', '${category}', 'g')`));
    expect(await add("vpn-connect", "network")).toEqual({ ok: false, code: "23505" });
    for (const bad of ["printer", "", "Network"]) {
      expect(await add("new", bad), bad).toEqual({ ok: false, code: "23514" });
    }
    for (const good of "database inquiry software hardware password_reset network".split(" ")) {
      expect(await add("new", good), good).toEqual({ ok: true });
    }
  });

  it("public, anon and authenticated hold no privilege; RLS is on with no policies", async () => {
    const { rows } = await client().query(
      `select r, has_table_privilege(r, '${KB}', 'select,insert,update,delete,truncate,references,trigger') as tbl,
         has_any_column_privilege(r, '${KB}', 'select,insert,update,references') as col
       from unnest(array['public', 'anon', 'authenticated']) r`,
    );
    expect(rows.filter((row) => row.tbl || row.col)).toEqual([]);
    for (const role of ["anon", "authenticated"]) {
      expect(await inRollback(`select * from ${KB}`, role), role).toEqual(DENIED);
    }
    const rls = await client().query(
      `select relrowsecurity as rls, (select count(*)::int from pg_policy where polrelid = c.oid) as policies
       from pg_class c where oid = '${KB}'::regclass`,
    );
    expect(rls.rows).toEqual([{ rls: true, policies: 0 }]);
  });

  it("service_role may insert, select and update, but not delete", async () => {
    for (const sql of [
      insertKb("('s', 't', 'c', 'inquiry', 'g')"),
      `select * from ${KB}`,
      `update ${KB} set title = 'VPN fails' where slug = 'vpn-connect'`,
    ]) {
      expect(await inRollback(sql, "service_role"), sql).toEqual({ ok: true });
    }
    expect(await inRollback(`delete from ${KB}`, "service_role")).toEqual(DENIED);
  });

  it("the check query gives ok = false for a wrong category list, generated column, default or index", async () => {
    const variants = [
      [
        `alter table ${KB} drop constraint kb_articles_category_check, add constraint kb_articles_category_check check (category <> 'x')`,
        `constraint ${KB}.kb_articles_category_check`,
      ],
      [`alter table ${KB} alter search drop expression`, `column ${KB}.search`],
      [`alter table ${KB} alter id drop default`, `column ${KB}.id`],
      ["drop index itsupport.kb_articles_search_idx", `index ${KB}.kb_articles_search_idx`],
    ];
    for (const [sql, wrong] of variants) {
      await client().query("begin");
      try {
        await client().query(sql ?? "");
        const { rows } = await client().query(read("checks/0003_itsupport_triage_kb.check.sql"));
        const wrongRows = rows.filter((row) => !row.ok).map((row) => row.object);
        expect(wrongRows, sql).toEqual([wrong]);
      } finally {
        await client().query("rollback");
      }
    }
  });

  it("up again keeps the rows; the part-2 down section comes first and leaves part 1", async () => {
    applied(upSql);
    expect(await count()).toBe(2);
    const part1 = downSql.indexOf("-- Part 1:");
    expect(downSql.indexOf("-- Part 2:")).toBeGreaterThan(-1);
    expect(downSql.indexOf("-- Part 2:")).toBeLessThan(part1);
    applied(downSql.slice(0, part1));
    const left = await client().query(
      `select to_regclass('${KB}') as tbl, to_regclass('itsupport.kb_articles_search_idx') as idx`,
    );
    expect(left.rows).toEqual([{ tbl: null, idx: null }]);
    expect(await check()).toEqual(
      OBJECTS.map((object) => ({ object, ok: PART1_OBJECTS.includes(object) })),
    );
    applied(downSql);
    expect(await check()).toEqual(OBJECTS.map((object) => ({ object, ok: false })));
    applied(upSql);
    expect(await snapshot()).toEqual(phase2);
    expect(await check()).toEqual(OBJECTS.map((object) => ({ object, ok: true })));
    expect(await count()).toBe(0);
  });
});

const FN = "itsupport.kb_search(text, integer)";
async function search(query: string | null, limit: number | null = 5) {
  const sql = "select slug, rank from itsupport.kb_search($1, $2)";
  return (await client().query<{ slug: string; rank: number }>(sql, [query, limit])).rows;
}

describe("migration 0003_itsupport_triage_kb, part 2b (kb_search)", () => {
  beforeAll(async () => {
    await client().query(
      insertKb(`('vpn-connect', 'VPN will not connect', 'Restart the VPN client and connect again.', 'network', 'Network'),
        ('password-reset', 'Reset your password', 'Connect to the portal and reset it.', 'password_reset', 'Service Desk'),
        ('printer-jam', 'Clear a printer jam', 'Open tray 2 and remove the paper.', 'hardware', 'Hardware')`),
    );
  });

  it("ranks the VPN row first, in descending rank order", async () => {
    const rows = await search("vpn or connect");
    expect(rows.map((row) => row.slug)).toEqual(["vpn-connect", "password-reset"]);
    expect(rows[0]?.rank).toBeGreaterThan(rows[1]?.rank ?? 1);
  });

  it("returns no rows for blank, whitespace, stop-word or null queries; hostile ones change nothing", async () => {
    for (const query of ["", "   ", "the and of", null]) {
      expect(await search(query), String(query)).toEqual([]);
    }
    const hostile: [string, string[]][] = [
      [`'; drop table ${KB}; --`, []],
      ['vpn "connect', ["vpn-connect"]],
      ["-", []],
      ["<-> & | ! :* ( ) or", []],
      ["x".repeat(5000), []],
      ["vpn ".repeat(1250), ["vpn-connect"]],
    ];
    for (const [query, slugs] of hostile) {
      expect(
        (await search(query)).map((row) => row.slug),
        query.slice(0, 30),
      ).toEqual(slugs);
    }
    expect(await count()).toBe(3);
  });

  it("clamps the limit to 1-20, with null meaning 5", async () => {
    await client().query("begin");
    try {
      await client().query(`insert into ${KB} (slug, title, content, category, assignment_group)
        select 'reboot-' || n, 'Reboot', 'Reboot it.', 'hardware', 'H' from generate_series(1, 25) n`);
      const cases = [
        [5, 5],
        [0, 1],
        [-3, 1],
        [null, 5],
        [100, 20],
        [2 ** 31 - 1, 20],
      ];
      for (const [limit, rows] of cases) {
        expect(await search("reboot", limit ?? null), String(limit)).toHaveLength(rows ?? -1);
      }
    } finally {
      await client().query("rollback");
    }
  });

  it("only service_role may execute it", async () => {
    const { rows } = await client().query(
      `select r, has_function_privilege(r, '${FN}', 'execute') as ok
       from unnest(array['public', 'anon', 'authenticated', 'service_role']) r`,
    );
    expect(rows.filter((row) => row.ok).map((row) => row.r)).toEqual(["service_role"]);
    const call = "select * from itsupport.kb_search('vpn')";
    for (const role of ["anon", "authenticated"]) {
      expect(await inRollback(call, role), role).toEqual(DENIED);
    }
    expect(await inRollback(call, "service_role")).toEqual({ ok: true });
  });

  it("the check row turns false for a wrong volatility, search_path, definer or grant", async () => {
    for (const sql of [
      `alter function ${FN} volatile`,
      `alter function ${FN} set search_path = public`,
      `alter function ${FN} security definer`,
      `grant execute on function ${FN} to anon`,
    ]) {
      await client().query("begin");
      try {
        await client().query(sql);
        const { rows } = await client().query(read("checks/0003_itsupport_triage_kb.check.sql"));
        const wrongRows = rows.filter((row) => !row.ok).map((row) => row.object);
        expect(wrongRows, sql).toEqual(["function itsupport.kb_search"]);
      } finally {
        await client().query("rollback");
      }
    }
  });

  it("the down file drops kb_search before kb_articles", () => {
    const dropFn = downSql.indexOf("drop function if exists itsupport.kb_search(text, integer);");
    expect(dropFn).toBeGreaterThan(-1);
    expect(dropFn).toBeLessThan(downSql.indexOf("drop table if exists itsupport.kb_articles;"));
  });
});

describe("migration 0003_itsupport_triage_kb, check-query hardening", () => {
  it("one wrong change per variant flips only its own row to ok = false", async () => {
    const fnSql = /create or replace function itsupport\.kb_search[\s\S]*?\$\$;/.exec(upSql)?.[0];
    expect(fnSql).toContain("least(coalesce(p_limit, 5), 20)");
    const ownerSql = (role: string) => `grant create on schema itsupport to ${role};`;
    const variants = [
      [`grant select on ${KB} to anon`, `grants ${KB}`],
      [`grant delete on ${KB} to service_role`, `grants ${KB}`],
      [`grant select (title) on ${KB} to authenticated`, `grants ${KB}`],
      [`grant update (title) on ${KB} to service_role`, `grants ${KB}`],
      [`create policy p_open on ${KB} for select using (true)`, `rls ${KB}`],
      [`alter table ${KB} disable row level security`, `rls ${KB}`],
      [`alter table ${KB} add column extra text`, `columns ${KB}`],
      [`alter table ${KB} alter slug type text collate "C"`, `collation ${KB}.slug`],
      [`alter table ${KB} add constraint extra check (true)`, `checks ${KB}`],
      [
        "alter table itsupport.tickets add constraint extra check (true)",
        "checks itsupport.tickets",
      ],
      [
        "alter table itsupport.triage_results add constraint extra check (true)",
        "checks itsupport.triage_results",
      ],
      [
        "alter table itsupport.triage_results alter grounding_score type numeric(5, 2)",
        "column itsupport.triage_results.grounding_score",
      ],
      [`alter function ${FN} strict`, "function itsupport.kb_search"],
      [`grant select on ${KB} to service_role with grant option`, `grants ${KB}`],
      [
        `grant execute on function ${FN} to service_role with grant option`,
        "function itsupport.kb_search",
      ],
      // A new owner needs create on the schema (granted only inside this rolled-back transaction).
      [`${ownerSql("authenticated")} alter table ${KB} owner to authenticated`, `owner ${KB}`],
      [`${ownerSql("anon")} alter function ${FN} owner to anon`, "owner itsupport.kb_search"],
      [
        "create function itsupport.kb_search(p_query text) returns integer language sql as 'select 1'",
        "function itsupport.kb_search",
      ],
      [
        fnSql?.replace("p_limit, 5), 20)", "p_limit, 5), 50)") ?? "",
        "function itsupport.kb_search",
      ],
      [
        "create domain itsupport.d_text as text; " +
          "alter table itsupport.triage_results alter subcategory type itsupport.d_text",
        "column itsupport.triage_results.subcategory",
      ],
      [
        "alter table itsupport.triage_results alter triaged_at type timestamptz(3)",
        "column itsupport.triage_results.triaged_at",
      ],
      [`alter table ${KB} force row level security`, `rls ${KB}`],
      [`create index kb_articles_title_idx on ${KB} (title)`, `indexes ${KB}`],
      [
        "create function itsupport.t_noop() returns trigger language plpgsql as 'begin return new; end'; " +
          `create trigger t_extra before insert on ${KB} for each row execute function itsupport.t_noop()`,
        `triggers ${KB}`,
      ],
      [`create rule r_extra as on update to ${KB} do also notify kb_articles`, `rules ${KB}`],
      [`create publication p_extra for table ${KB}`, `publications ${KB}`],
    ];
    for (const [sql, wrong] of variants) {
      await client().query("begin");
      try {
        await client().query(sql ?? "");
        const { rows } = await client().query(read("checks/0003_itsupport_triage_kb.check.sql"));
        const wrongRows = rows.filter((row) => !row.ok).map((row) => row.object);
        expect(wrongRows, sql).toEqual([wrong]);
      } finally {
        await client().query("rollback");
      }
    }
    expect(await check()).toEqual(OBJECTS.map((object) => ({ object, ok: true })));
  });

  it("the correct database is all true as postgres and supabase_admin, with LF and CRLF", async () => {
    const lf = read("checks/0003_itsupport_triage_kb.check.sql").replace(/\r\n/g, "\n");
    expect(lf).not.toContain("\r");
    for (const user of ["postgres", "supabase_admin"]) {
      const as = await connect(user);
      try {
        expect((await as.query("select current_user as u")).rows).toEqual([{ u: user }]);
        for (const sql of [lf, lf.replace(/\n/g, "\r\n")]) {
          await as.query("begin transaction read only");
          try {
            const { rows } = await as.query<{ object: string; ok: boolean }>(sql);
            rows.sort((a, b) => (a.object < b.object ? -1 : 1));
            expect(rows, user).toEqual(OBJECTS.map((object) => ({ object, ok: true })));
          } finally {
            await as.query("rollback");
          }
        }
      } finally {
        await as.end();
      }
    }
  });
});

const AI = "itsupport.ai_calls";
const USAGE = "itsupport.ai_usage_month(date)";
const callUsage = "select * from itsupport.ai_usage_month('2026-10-01')";
const usage = async (month: string) =>
  (await client().query("select * from itsupport.ai_usage_month($1)", [month])).rows;

describe("migration 0003_itsupport_triage_kb, part 3 (ai_calls, ai_usage_month)", () => {
  it("rejects a bad provider or calls with 23514 and an unknown ticket with 23503", async () => {
    const add = (values: string, ticket = "null") =>
      inRollback(`insert into ${AI} (ticket_id, provider, calls, kind, environment)
        values (${ticket}, ${values}, 'k', 'e2e')`);
    for (const bad of ["'openai', 1", "'', 1", "'llm', 0", "'llm', -1"]) {
      expect(await add(bad), bad).toEqual({ ok: false, code: "23514" });
    }
    expect(await add("'llm', 1", "gen_random_uuid()")).toEqual({ ok: false, code: "23503" });
    const ticket = "(select id from itsupport.tickets limit 1)";
    expect(await add("'typesafe', 1", ticket)).toEqual({ ok: true });
  });

  it("ai_usage_month sums one UTC month per provider, in any session time zone", async () => {
    await client().query("begin");
    try {
      await client()
        .query(`insert into ${AI} (provider, kind, calls, tokens_in, tokens_out, cost_usd, environment, at) values
        ('llm', 'fix_steps', 1, 100, 50, null, 'e2e', '2026-10-01 00:00:00+00'),
        ('llm', 'fix_steps', 2, 10, 5, 0.5, 'staging', '2026-10-31 23:59:59.999+00'),
        ('typesafe', 'triage_judgments', 7, null, null, null, 'e2e', '2026-10-15 12:00:00+00'),
        ('typesafe', 'kb_rerank', 5, null, null, null, 'e2e', '2026-09-30 23:59:59.999+00'),
        ('llm', 'fix_steps', 4, 1, 1, null, 'e2e', '2026-11-01 00:00:00+00')`);
      for (const zone of ["UTC", "Pacific/Kiritimati", "America/Los_Angeles"]) {
        await client().query(`set local time zone '${zone}'`);
        expect(await usage("2026-10-01"), zone).toEqual([
          { provider: "llm", calls: "3", tokens_in: "110", tokens_out: "55", cost_usd: "0.5" },
          { provider: "typesafe", calls: "7", tokens_in: null, tokens_out: null, cost_usd: null },
        ]);
      }
      expect(await usage("2026-09-01")).toEqual([
        { provider: "typesafe", calls: "5", tokens_in: null, tokens_out: null, cost_usd: null },
      ]);
      expect(await usage("2000-01-01")).toEqual([]);
    } finally {
      await client().query("rollback");
    }
  });

  it("only service_role may use the table (no delete) and the function", async () => {
    const { rows } = await client().query(
      `select r, has_table_privilege(r, '${AI}', 'select,insert,update,delete,truncate,references,trigger')
          or has_any_column_privilege(r, '${AI}', 'select,insert,update,references')
          or has_function_privilege(r, '${USAGE}', 'execute') as any
       from unnest(array['public', 'anon', 'authenticated']) r`,
    );
    expect(rows.filter((row) => row.any)).toEqual([]);
    for (const role of ["anon", "authenticated"]) {
      for (const sql of [`select * from ${AI}`, callUsage]) {
        expect(await inRollback(sql, role), `${role}: ${sql}`).toEqual(DENIED);
      }
    }
    for (const sql of [
      `insert into ${AI} (provider, kind, environment) values ('llm', 'fix_steps', 'e2e')`,
      `update ${AI} set tokens_in = 1`,
      callUsage,
    ]) {
      expect(await inRollback(sql, "service_role"), sql).toEqual({ ok: true });
    }
    expect(await inRollback(`delete from ${AI}`, "service_role")).toEqual(DENIED);
  });

  it("the check query flips only the row of each wrong variant", async () => {
    const fk = `alter table ${AI} drop constraint ai_calls_ticket_id_fkey, add constraint ai_calls_ticket_id_fkey
      foreign key (ticket_id) references itsupport.tickets (id) on delete cascade`;
    const variants = [
      [
        `alter table ${AI} drop constraint ai_calls_provider_check, add constraint ai_calls_provider_check check (provider <> '')`,
        `constraint ${AI}.ai_calls_provider_check`,
      ],
      [fk, `constraint ${AI}.ai_calls_ticket_id_fkey`],
      ["drop index itsupport.ai_calls_provider_at_idx", `index ${AI}.ai_calls_provider_at_idx`],
      [`alter table ${AI} alter calls set default 2`, `column ${AI}.calls`],
      [`alter table ${AI} add column extra text`, `columns ${AI}`],
      [`alter table ${AI} add constraint extra check (true)`, `checks ${AI}`],
      [`grant delete on ${AI} to service_role`, `grants ${AI}`],
      [`alter table ${AI} disable row level security`, `rls ${AI}`],
      [`grant create on schema itsupport to anon; alter table ${AI} owner to anon`, `owner ${AI}`],
      [`alter function ${USAGE} volatile`, "function itsupport.ai_usage_month"],
    ];
    for (const [sql, wrong] of variants) {
      await client().query("begin");
      try {
        await client().query(sql ?? "");
        const { rows } = await client().query(read("checks/0003_itsupport_triage_kb.check.sql"));
        const wrongRows = rows.filter((row) => !row.ok).map((row) => row.object);
        expect(wrongRows, sql).toEqual([wrong]);
      } finally {
        await client().query("rollback");
      }
    }
  });

  it("the part-3 down section follows part 4 (function, then table) and leaves parts 1-2b", async () => {
    const part3 = downSql.slice(0, downSql.indexOf("-- Part 2b:"));
    const dropFn = part3.indexOf("drop function if exists itsupport.ai_usage_month(date);");
    expect(dropFn).toBeGreaterThan(-1);
    expect(dropFn).toBeLessThan(part3.indexOf(`drop table if exists ${AI};`));
    applied(part3);
    expect(await check()).toEqual(
      OBJECTS.map((object) => ({
        object,
        ok: !PART3_OBJECTS.includes(object) && !PART4_OBJECTS.includes(object),
      })),
    );
    expect(await count()).toBe(3);
    applied(upSql);
    expect(await check()).toEqual(OBJECTS.map((object) => ({ object, ok: true })));
    expect(await snapshot()).toEqual(phase2);
  });
});

const RESERVE = "itsupport.ai_budget_reserve(text, numeric, integer, integer, text, text, uuid)";
const callReserve =
  "select allowed, used_calls, call_id from itsupport.ai_budget_reserve($1, $2, $3, $4, $5, $6, $7)";
type Reserved = { allowed: boolean; used_calls: number; call_id: string | null };
async function reserve(
  provider: string | null,
  calls: number | null,
  cap: number | null,
  on = client(),
) {
  const args = [provider, 0.25, calls, cap, "e2e", "triage_judgments", null];
  return (await on.query<Reserved>(callReserve, args)).rows[0];
}
const seed = (provider: string, calls: number, at = new Date()) =>
  client().query(
    `insert into ${AI} (provider, kind, calls, environment, at) values ($1, 'seed', $2, 'staging', $3)`,
    [provider, calls, at],
  );
const total = async (provider = "typesafe") =>
  (
    await client().query(
      `select coalesce(sum(calls), 0)::int as n from ${AI} where provider = $1`,
      [provider],
    )
  ).rows[0]?.n as number;
const REFUSED = { allowed: false, call_id: null };

describe("migration 0003_itsupport_triage_kb, part 3b (ai_budget_reserve)", () => {
  beforeEach(() => client().query(`delete from ${AI}`));

  it("T3.I.09: 20 parallel reservations on 20 connections at 90 of 100 allow exactly 10", async () => {
    const conns: pg.Client[] = [];
    try {
      for (let i = 0; i <= 20; i += 1) conns.push(await connect());
      const [blocker, ...racers] = conns as [pg.Client, ...pg.Client[]];
      for (let run = 0; run < 5; run += 1) {
        await client().query(`delete from ${AI}`);
        await seed("typesafe", 90);
        // The blocker holds the typesafe lock (cap 0 refuses and writes nothing) until all 20 wait.
        await blocker.query("begin");
        expect(await reserve("typesafe", 1, 0, blocker)).toMatchObject(REFUSED);
        const results = racers.map(async (racer) => {
          await racer.query("begin; set local role service_role");
          const row = await reserve("typesafe", 1, 100, racer);
          await racer.query("commit");
          return row;
        });
        const waiting =
          "select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted";
        while ((await client().query(waiting)).rows[0]?.n !== 20)
          await new Promise((r) => setTimeout(r, 20));
        await blocker.query("commit");
        const rows = await Promise.all(results);
        const allowed = rows.filter((row) => row?.allowed);
        expect(allowed.map((row) => row?.used_calls).sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
          91, 92, 93, 94, 95, 96, 97, 98, 99, 100,
        ]);
        expect(rows.filter((row) => !row?.allowed)).toEqual(
          Array(10).fill({ ...REFUSED, used_calls: 100 }),
        );
        expect(await total()).toBe(100);
      }
    } finally {
      await Promise.all(conns.map((c) => c.end().catch(() => undefined)));
    }
  });

  it("refuses over the cap and writes nothing; allows up to exactly the cap", async () => {
    await seed("typesafe", 95);
    expect(await reserve("typesafe", 7, 100)).toEqual({ ...REFUSED, used_calls: 95 });
    expect(await total()).toBe(95);
    const ok = await reserve("typesafe", 5, 100);
    expect(ok).toMatchObject({ allowed: true, used_calls: 100 });
    expect(ok?.call_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await reserve("typesafe", 2 ** 31 - 1, 2 ** 31 - 1)).toEqual({
      ...REFUSED,
      used_calls: 100,
    });
  });

  it("cap 0 refuses every reservation and writes nothing", async () => {
    for (const provider of ["typesafe", "llm"]) {
      expect(await reserve(provider, 1, 0)).toEqual({ ...REFUSED, used_calls: 0 });
    }
    expect((await client().query(`select * from ${AI}`)).rows).toEqual([]);
  });

  it("counts from the UTC month start in any session time zone; providers are independent", async () => {
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
    await seed("typesafe", 50, new Date(start.getTime() - 1));
    await seed("typesafe", 10, start);
    await seed("llm", 100);
    for (const zone of ["UTC", "Pacific/Kiritimati", "America/Los_Angeles"]) {
      await client().query("begin");
      try {
        await client().query(`set local time zone '${zone}'`);
        expect(await reserve("typesafe", 1, 100), zone).toMatchObject({
          allowed: true,
          used_calls: 11,
        });
      } finally {
        await client().query("rollback");
      }
    }
    expect(await reserve("llm", 1, 100)).toEqual({ ...REFUSED, used_calls: 100 });
  });

  it("raises 22023 for a bad provider, call count or cap and writes nothing", async () => {
    for (const args of [
      "'openai', 0, 1, 100",
      "null, 0, 1, 100",
      "'llm', 0, 0, 100",
      "'llm', 0, -1, 100",
      "'llm', 0, null, 100",
      "'llm', 0, 1, -1",
      "'llm', 0, 1, null",
    ]) {
      const sql = `select * from itsupport.ai_budget_reserve(${args}, 'e2e', 'k')`;
      expect(await inRollback(sql, "service_role"), args).toEqual({ ok: false, code: "22023" });
    }
    expect(await total("llm")).toBe(0);
  });

  it("writes one row with the given kind, environment, ticket, calls and cost; tokens null", async () => {
    const ticket = (await client().query("select id from itsupport.tickets limit 1")).rows[0]
      ?.id as string;
    const args = ["llm", 0.125, 3, 10, "staging", "fix_steps", ticket];
    const id = (await client().query<Reserved>(callReserve, args)).rows[0]?.call_id;
    const { rows } = await client().query(
      `select ticket_id, provider, kind, calls, tokens_in, tokens_out, cost_usd, environment from ${AI} where id = $1`,
      [id],
    );
    expect(rows).toEqual([
      {
        ticket_id: ticket,
        provider: "llm",
        kind: "fix_steps",
        calls: 3,
        tokens_in: null,
        tokens_out: null,
        cost_usd: "0.125",
        environment: "staging",
      },
    ]);
  });

  it("locks per provider: llm runs while typesafe is held, a 2nd typesafe waits, bad args do not", async () => {
    const [a, b] = [await connect(), await connect()];
    try {
      await a.query("begin");
      await reserve("typesafe", 1, 0, a);
      await b.query("set lock_timeout = '500ms'");
      expect(await reserve("llm", 1, 0, b)).toMatchObject(REFUSED);
      await expect(reserve("typesafe", 1, 0, b)).rejects.toMatchObject({ code: "55P03" });
      await expect(reserve("typesafe", 0, 0, b)).rejects.toMatchObject({ code: "22023" });
      await a.query("commit");
      const held = "select count(*)::int as n from pg_locks where locktype = 'advisory'";
      expect((await client().query(held)).rows).toEqual([{ n: 0 }]);
    } finally {
      await Promise.all([a.end(), b.end()]);
    }
  });

  it("only service_role may execute it", async () => {
    const { rows } = await client().query(
      `select r, has_function_privilege(r, '${RESERVE}', 'execute') as ok
       from unnest(array['public', 'anon', 'authenticated', 'service_role']) r`,
    );
    expect(rows.filter((row) => row.ok).map((row) => row.r)).toEqual(["service_role"]);
    const sql = "select * from itsupport.ai_budget_reserve('llm', 0, 1, 100, 'e2e', 'k')";
    for (const role of ["anon", "authenticated"]) {
      expect(await inRollback(sql, role), role).toEqual(DENIED);
    }
  });

  it("the check query flips only its own row for each wrong variant", async () => {
    const fnSql = /create or replace function itsupport\.ai_budget_reserve[\s\S]*?\$\$;/.exec(
      upSql,
    )?.[0];
    expect(fnSql).toContain("> p_cap_calls then");
    const fn = "function itsupport.ai_budget_reserve";
    const toAnon = `grant create on schema itsupport to anon; alter function ${RESERVE} owner to anon`;
    const variants = [
      [`alter function ${RESERVE} stable`, fn],
      [`alter function ${RESERVE} security definer`, fn],
      [`alter function ${RESERVE} set search_path = public`, fn],
      [fnSql?.replace("> p_cap_calls then", ">= p_cap_calls then") ?? "", fn],
      [`grant execute on function ${RESERVE} to anon`, fn],
      [toAnon, "owner itsupport.ai_budget_reserve"],
      [
        "create function itsupport.ai_budget_reserve(p text) returns integer language sql as 'select 1'",
        fn,
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

  it("the part-3 down section drops ai_budget_reserve first", () => {
    const part3 = downSql.slice(downSql.indexOf("-- Part 3:"));
    expect(part3.search(/^drop /m)).toBe(part3.indexOf(`drop function if exists ${RESERVE};`));
  });
});
