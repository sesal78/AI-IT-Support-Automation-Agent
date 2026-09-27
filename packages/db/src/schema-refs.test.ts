import { describe, expect, it } from "vitest";
import { referencedSchemas, unqualifiedCreates } from "./schema-refs.js";

describe("referencedSchemas", () => {
  it("finds schema-qualified names and lowercases unquoted ones", () => {
    const sql = "insert into ItSupport.tickets (id) select id from public.users;";
    expect(referencedSchemas(sql)).toEqual(["itsupport", "public"]);
  });

  it("keeps quoted identifiers as written, including escaped quotes", () => {
    expect(referencedSchemas('select * from "My""Schema"."t";')).toEqual(['My"Schema']);
  });

  it("finds schema names in schema clauses", () => {
    const sql = [
      "create schema if not exists itsupport;",
      "drop schema if exists old_stuff cascade;",
      "create extension if not exists vector with schema extensions;",
      "grant usage on schema auth to service_role;",
      "grant select on all tables in schema storage to anon;",
    ].join("\n");
    expect(referencedSchemas(sql)).toEqual([
      "auth",
      "extensions",
      "itsupport",
      "old_stuff",
      "storage",
    ]);
  });

  it("ignores comments, string literals and dollar-quote tags", () => {
    const sql = [
      "-- public.ignored_line_comment",
      "/* auth.ignored_block",
      "   comment */",
      "select 'storage.not_a_ref', 'it''s public.also_not', E'x\\'y';",
      "create function itsupport.f() returns int language sql as $body$ select 1 $body$;",
      "select 1.5, '{}'::jsonb;",
    ].join("\n");
    expect(referencedSchemas(sql)).toEqual(["itsupport"]);
  });

  it("still inspects code inside dollar-quoted function bodies", () => {
    const sql =
      "create function itsupport.f() returns void language plpgsql as $$ begin delete from auth.users; end $$;";
    expect(referencedSchemas(sql)).toEqual(["auth", "itsupport"]);
  });

  it("returns an empty list when nothing is qualified", () => {
    expect(referencedSchemas("select 1;")).toEqual([]);
  });
});

describe("unqualifiedCreates", () => {
  it("lists created objects that have no schema (they would land in search_path)", () => {
    const sql = [
      "create table if not exists tickets (id int);",
      "create or replace function helper() returns int language sql as $$ select 1 $$;",
      "create view itsupport.v as select 1;",
      'create sequence "Seq";',
      "create materialized view mv as select 1;",
      "create type itsupport.kind as enum ('a');",
    ].join("\n");
    expect(unqualifiedCreates(sql)).toEqual(["tickets", "helper", '"Seq"', "mv"]);
  });

  it("does not flag indexes or triggers, which live in their table's schema", () => {
    const sql = [
      "create index if not exists i on itsupport.t (a);",
      "create trigger tr before update on itsupport.t for each row execute function itsupport.f();",
    ].join("\n");
    expect(unqualifiedCreates(sql)).toEqual([]);
  });
});
