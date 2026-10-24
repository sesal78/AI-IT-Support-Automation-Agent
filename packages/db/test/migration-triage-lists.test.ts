import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CATEGORIES, PRIORITIES, ROUTES } from "@ai-it-support/shared";
import { describe, expect, it } from "vitest";

const sql = readFileSync(
  resolve(
    dirname(fileURLToPath(import.meta.url)),
    "../../../supabase/migrations/0003_itsupport_triage_kb.sql",
  ),
  "utf8",
);

/**
 * The members, in order, of `constraint <name> check (<column> in (...))`.
 * Comments are removed first; whitespace and line breaks do not matter.
 * Throws when the constraint is missing, so a rename cannot pass silently.
 */
export function checkList(source: string, constraint: string, column: string): string[] {
  const noComments = source.replace(/--[^\n]*/g, "");
  const match = new RegExp(
    `${constraint}\\s+check\\s*\\(\\s*${column}\\s+in\\s*\\(([^)]*)\\)`,
    "i",
  ).exec(noComments);
  if (!match?.[1]) throw new Error(`constraint ${constraint} not found`);
  return [...match[1].matchAll(/'([^']*)'/g)].map((m) => m[1] as string);
}

describe("migration 0003 lists equal the shared constants", () => {
  it("triage_results category", () => {
    expect(checkList(sql, "triage_results_category_check", "category")).toEqual([...CATEGORIES]);
  });

  it("kb_articles category", () => {
    expect(checkList(sql, "kb_articles_category_check", "category")).toEqual([...CATEGORIES]);
  });

  it("triage_results priority", () => {
    expect(checkList(sql, "triage_results_priority_check", "priority")).toEqual([...PRIORITIES]);
  });

  it("triage_results route", () => {
    expect(checkList(sql, "triage_results_route_check", "route")).toEqual([...ROUTES]);
  });
});

describe("checkList (mutation proof)", () => {
  it("reads a multi-line list, ignoring comments", () => {
    const text = "constraint c_check check (x in (\n  'a', -- one\n  'b'\n))";
    expect(checkList(text, "c_check", "x")).toEqual(["a", "b"]);
  });

  it("sees a reordered, missing or extra member", () => {
    const mutate = (from: string, to: string) =>
      checkList(sql.replace(from, to), "triage_results_priority_check", "priority");
    const original = "check (priority in ('P1', 'P2', 'P3', 'P4'))";
    expect(sql).toContain(original);
    expect(mutate(original, "check (priority in ('P2', 'P1', 'P3', 'P4'))")).not.toEqual([
      ...PRIORITIES,
    ]);
    expect(mutate(original, "check (priority in ('P1', 'P2', 'P3'))")).not.toEqual([...PRIORITIES]);
    expect(mutate(original, "check (priority in ('P1', 'P2', 'P3', 'P4', 'P5'))")).not.toEqual([
      ...PRIORITIES,
    ]);
  });

  it("throws when the constraint is missing", () => {
    expect(() => checkList(sql, "no_such_check", "x")).toThrow();
  });
});
