import { readFileSync } from "node:fs";
import { HELPDESK_STATE_TRANSITIONS } from "@ai-it-support/shared";
import { describe, expect, it } from "vitest";

// Plan §6.3.1 G3 (P5-T11c): migration 0007 seeds helpdesk_state_transitions with
// the same pairs, in the same order, as HELPDESK_STATE_TRANSITIONS.
const SQL = readFileSync(
  new URL("../../../supabase/migrations/0007_itsupport_builtin_helpdesk.sql", import.meta.url),
  "utf8",
);
const INSERT = /insert into itsupport\.helpdesk_state_transitions\b[^;]*;/gi;
const PAIR = /\('([a-z_]+)', '([a-z_]+)'\)/g;

/** The "from>to" pairs the one transitions insert in `sql` seeds; throws on anything else. */
function seededPairs(sql: string): string[] {
  const inserts = sql.match(INSERT) ?? [];
  if (inserts.length !== 1)
    throw new Error(`expected 1 transitions insert, found ${inserts.length}`);
  const values = /\bvalues\b([\s\S]*?)\bon conflict do nothing;$/i.exec(inserts[0] as string);
  if (!values) throw new Error("the transitions insert has no values list");
  const list = values[1] as string;
  if (list.replace(PAIR, "").replace(/[\s,]/g, "") !== "") {
    throw new Error("the transitions insert holds something other than pairs");
  }
  return [...list.matchAll(PAIR)].map((m) => `${m[1]}>${m[2]}`);
}
const CODE = HELPDESK_STATE_TRANSITIONS.map(([from, to]) => `${from}>${to}`);

describe("helpdesk state parity: migration 0007 and HELPDESK_STATE_TRANSITIONS", () => {
  it("seeds exactly the code's pairs, in the code's order", () => {
    expect(seededPairs(SQL)).toEqual(CODE);
    expect(CODE).toHaveLength(10);
  });

  it.each([
    [
      "the migration gains a pair",
      "('resolved', 'in_progress')",
      "('resolved', 'in_progress'), ('closed', 'new')",
    ],
    ["the migration loses a pair", "('new', 'closed'),", ""],
  ])("fails when %s", (_, from, to) => {
    expect(SQL).toContain(from);
    expect(seededPairs(SQL.replace(from, to))).not.toEqual(CODE);
  });

  it("fails when the code gains or loses a pair", () => {
    expect(seededPairs(SQL)).not.toEqual([...CODE, "closed>new"]);
    expect(seededPairs(SQL)).not.toEqual(CODE.slice(1));
  });

  it("refuses a second transitions insert or a value that is not a pair", () => {
    const extra = `${SQL}\ninsert into itsupport.helpdesk_state_transitions values ('closed', 'new');`;
    expect(() => seededPairs(extra)).toThrow("found 2");
    const odd = SQL.replace("('new', 'closed')", "('new', 'closed'), (select 'x', 'y')");
    expect(() => seededPairs(odd)).toThrow("other than pairs");
  });
});
