import { describe, expect, it } from "vitest";
import {
  assertTransition,
  canTransition,
  IllegalTransitionError,
  TICKET_STATUSES,
  type TicketStatus,
} from "./index.js";

// The oracle. Both lists are written out by hand from plan §2.6 and are never
// built from status.ts, so a wrong table there cannot make these tests pass.
const STATUSES: TicketStatus[] = [
  "new",
  "redacted",
  "triaged",
  "auto",
  "helpdesk_pending",
  "incident_created",
  "incident_skipped_shadow",
  "review_pending",
  "approved",
  "rejected",
  "escalated_manual",
  "failed",
];

const LEGAL: Array<[TicketStatus, TicketStatus]> = [
  // new → redacted → triaged → auto | review_pending
  ["new", "redacted"],
  ["redacted", "triaged"],
  ["triaged", "auto"],
  ["triaged", "review_pending"],
  // auto → helpdesk_pending → incident_created | incident_skipped_shadow
  ["auto", "helpdesk_pending"],
  ["helpdesk_pending", "incident_created"],
  ["helpdesk_pending", "incident_skipped_shadow"],
  // review_pending → approved (→ helpdesk_pending) | rejected | escalated_manual
  ["review_pending", "approved"],
  ["review_pending", "rejected"],
  ["review_pending", "escalated_manual"],
  ["approved", "helpdesk_pending"],
  // Any state → failed. `failed` itself is terminal, so it has no row.
  ["new", "failed"],
  ["redacted", "failed"],
  ["triaged", "failed"],
  ["auto", "failed"],
  ["helpdesk_pending", "failed"],
  ["incident_created", "failed"],
  ["incident_skipped_shadow", "failed"],
  ["review_pending", "failed"],
  ["approved", "failed"],
  ["rejected", "failed"],
  ["escalated_manual", "failed"],
];

const legal = new Set(LEGAL.map(([from, to]) => `${from}>${to}`));
const PAIRS = STATUSES.flatMap((from) =>
  STATUSES.map((to) => ({ from, to, ok: legal.has(`${from}>${to}`) })),
);

// Values a caller holding unvalidated data (a database row) could pass. The
// second row would pass a check that uses `in` or indexes the table directly.
const UNKNOWN: unknown[] = [
  ...["bogus", "", undefined, null, 0, "New", " new"],
  ...["constructor", "__proto__", "toString", ["new"]],
];

// The functions take TicketStatus. These aliases pass values the type checker
// would reject.
const can = canTransition as (from: unknown, to: unknown) => boolean;
const assert = assertTransition as (from: unknown, to: unknown) => void;

describe("TICKET_STATUSES", () => {
  it("has exactly the 12 names of plan §2.6, in spec order", () => {
    expect(TICKET_STATUSES).toEqual(STATUSES);
    expect(new Set(TICKET_STATUSES).size).toBe(12);
  });
});

describe("canTransition and assertTransition (T3.U.03)", () => {
  it("is checked against an oracle of 12 statuses and 22 legal pairs", () => {
    expect(new Set(STATUSES).size).toBe(12);
    expect(legal.size).toBe(22);
    expect(PAIRS).toHaveLength(144);
    expect(PAIRS.filter(({ ok }) => ok)).toHaveLength(22);
  });

  it.each(PAIRS)("$from -> $to is $ok", ({ from, to, ok }) => {
    expect(canTransition(from, to)).toBe(ok);
    if (ok) expect(assertTransition(from, to)).toBeUndefined();
    else expect(() => assertTransition(from, to)).toThrow(IllegalTransitionError);
  });

  it("is true for exactly 22 of the 144 pairs", () => {
    const results = STATUSES.flatMap((from) => STATUSES.map((to) => canTransition(from, to)));
    expect(results.filter((ok) => ok === true)).toHaveLength(22);
    expect(results.filter((ok) => ok === false)).toHaveLength(122);
  });

  it("accepts new -> redacted", () => {
    expect(assertTransition("new", "redacted")).toBeUndefined();
  });

  it("rejects new -> triaged with an error that names both statuses", () => {
    const call = () => assertTransition("new", "triaged");
    expect(call).toThrow(IllegalTransitionError);
    expect(call).toThrow(expect.objectContaining({ name: "IllegalTransitionError" }));
    expect(call).toThrow(/\bnew\b.*\btriaged\b/);
  });

  it("treats failed as terminal", () => {
    for (const to of STATUSES) expect(canTransition("failed", to)).toBe(false);
  });

  it("rejects every same-status pair", () => {
    for (const status of STATUSES) expect(canTransition(status, status)).toBe(false);
  });

  it("never lets a rejected ticket reach the helpdesk", () => {
    // helpdesk_pending is entered only from auto and approved, and an end
    // state can move only to failed.
    const into = STATUSES.filter((from) => canTransition(from, "helpdesk_pending"));
    expect(into).toEqual(["auto", "approved"]);
    const ends = ["incident_created", "incident_skipped_shadow", "rejected", "escalated_manual"];
    for (const end of ends as TicketStatus[]) {
      expect(STATUSES.filter((to) => canTransition(end, to))).toEqual(["failed"]);
    }
  });

  it.each(UNKNOWN.map((bad) => ({ bad })))("throws for the unknown status $bad", ({ bad }) => {
    for (const fn of [can, assert]) {
      for (const known of STATUSES) {
        expect(() => fn(bad, known)).toThrow(IllegalTransitionError);
        expect(() => fn(known, bad)).toThrow(IllegalTransitionError);
      }
      expect(() => fn(bad, bad)).toThrow(IllegalTransitionError);
    }
  });

  it("does not echo an unknown value in the error message", () => {
    // Privacy rule: an unknown value could be anything, including ticket text.
    const call = () => can("jo@example.com", "failed");
    expect(call).toThrow(IllegalTransitionError);
    expect(call).toThrow(/\bfailed\b/);
    expect(call).not.toThrow(/jo@example\.com/);
  });
});
