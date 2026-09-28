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

  it.each(migrationFiles)("%s only touches the itsupport and extensions schemas", (file) => {
    const sql = readFileSync(join(migrationsDir, file), "utf8");
    const schemas = referencedSchemas(sql);

    expect(schemas).toContain("itsupport");
    expect(schemas.filter((schema) => !allowedSchemas.includes(schema))).toEqual([]);
    expect(unqualifiedCreates(sql)).toEqual([]);
  });
});
