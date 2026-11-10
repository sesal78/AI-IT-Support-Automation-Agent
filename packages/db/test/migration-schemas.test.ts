import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { referencedSchemas, unqualifiedCreates } from "../src/schema-refs.js";

const migrationsDir = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../../../supabase/migrations",
);

// The shared Supabase stack hosts other apps: this project may only touch its
// own schema and the shared extensions schema (docs/PROJECT.md §11).
const allowedSchemas = ["extensions", "itsupport"];
// The one allowed use of Supabase's auth schema: 0008 reads the caller's ID
// as `auth_user_id = auth.uid()` (G6). Any other auth reference, and a grant,
// revoke, alter or drop on auth.uid() in any migration, stays foreign.
const AUTH_UID_READ = /\bauth_user_id\s*=\s*auth\.uid\(\)/g;
const foreignSchemas = (file: string, sql: string) =>
  referencedSchemas(
    file === "0008_itsupport_staff_access.sql" ? sql.replace(AUTH_UID_READ, "true") : sql,
  ).filter((schema) => !allowedSchemas.includes(schema));

const migrationFiles = readdirSync(migrationsDir)
  .filter((name) => name.endsWith(".sql"))
  .sort();

describe("supabase migrations", () => {
  it("has the 0001 foundation up and down files", () => {
    expect(migrationFiles).toEqual(
      expect.arrayContaining([
        "0001_itsupport_foundation.sql",
        "0001_itsupport_foundation.down.sql",
      ]),
    );
  });

  it("has the 0002 intake up and down files", () => {
    expect(migrationFiles).toEqual(
      expect.arrayContaining(["0002_itsupport_intake.sql", "0002_itsupport_intake.down.sql"]),
    );
  });

  it("has the 0003 triage-kb up and down files", () => {
    expect(migrationFiles).toEqual(
      expect.arrayContaining(["0003_itsupport_triage_kb.sql", "0003_itsupport_triage_kb.down.sql"]),
    );
  });

  it("has the 0004 lock-sequences up and down files", () => {
    expect(migrationFiles).toEqual(
      expect.arrayContaining([
        "0004_itsupport_lock_sequences.sql",
        "0004_itsupport_lock_sequences.down.sql",
      ]),
    );
  });

  it.each(migrationFiles)("%s only touches the itsupport and extensions schemas", (file) => {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    expect(referencedSchemas(sql)).toContain("itsupport");
    expect(foreignSchemas(file, sql)).toEqual([]);
    expect(unqualifiedCreates(sql)).toEqual([]);
  });

  const read = "select id from itsupport.staff where auth_user_id = auth.uid()";
  it.each([
    ["0008_itsupport_staff_access.sql", "grant execute on function auth.uid() to anon"],
    ["0008_itsupport_staff_access.sql", "revoke all on function auth.uid() from public"],
    ["0008_itsupport_staff_access.sql", "alter function auth.uid() owner to anon"],
    ["0008_itsupport_staff_access.sql", "drop function auth.uid()"],
    ["0008_itsupport_staff_access.sql", "select auth.uid()"],
    ["0008_itsupport_staff_access.sql", "select auth.jwt()"],
    ["0008_itsupport_staff_access.sql", "select id from auth.users"],
    ["0009_itsupport_later.sql", read],
    ["0007_itsupport_builtin_helpdesk.sql", "grant execute on function auth.uid() to anon"],
  ])("flags the auth schema in %s: %s", (file, sql) => {
    expect(foreignSchemas(file, `${read}; ${sql};`)).toEqual(["auth"]);
  });

  it("allows only 0008's auth_user_id = auth.uid() read", () => {
    expect(foreignSchemas("0008_itsupport_staff_access.sql", read)).toEqual([]);
  });
});
