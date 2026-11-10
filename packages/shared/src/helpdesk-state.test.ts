import { describe, expect, it } from "vitest";
import {
  assertHelpdeskTransition,
  canHelpdeskTransition,
  HELPDESK_STATE_TRANSITIONS,
  HELPDESK_STATES,
  IllegalHelpdeskTransitionError,
  nextHelpdeskStates,
  type HelpdeskState,
} from "./index.js";

// The oracle, written out by hand from plan §6.3.1 G3. Never built from helpdesk-state.ts.
const STATES: HelpdeskState[] = ["new", "in_progress", "on_hold", "resolved", "closed"];
const LEGAL: Array<[HelpdeskState, HelpdeskState]> = [
  ["new", "in_progress"],
  ["new", "on_hold"],
  ["new", "resolved"],
  ["new", "closed"],
  ["in_progress", "on_hold"],
  ["in_progress", "resolved"],
  ["on_hold", "in_progress"],
  ["on_hold", "resolved"],
  ["resolved", "closed"],
  ["resolved", "in_progress"],
];
const legal = new Set(LEGAL.map(([from, to]) => `${from}>${to}`));
const PAIRS = STATES.flatMap((from) =>
  STATES.map((to) => ({ from, to, ok: legal.has(`${from}>${to}`) })),
);

// The second row would pass a check that uses `in` or indexes the table directly.
const UNKNOWN: unknown[] = [
  ...["bogus", "", undefined, null, 0, "New", " new", ["new"]],
  ...["constructor", "__proto__", "toString", "hasOwnProperty"],
];

// The functions take HelpdeskState. These aliases pass values the type checker would reject.
const can = canHelpdeskTransition as (from: unknown, to: unknown) => boolean;
const assert = assertHelpdeskTransition as (from: unknown, to: unknown) => void;
const next = nextHelpdeskStates as (from: unknown) => string[];

describe("HELPDESK_STATES", () => {
  it("has exactly the 5 names of G3, in order, and is frozen", () => {
    expect(HELPDESK_STATES).toEqual(STATES);
    expect(Object.isFrozen(HELPDESK_STATES)).toBe(true);
    const writable = HELPDESK_STATES as unknown as string[];
    expect(() => writable.push("bogus")).toThrow(TypeError);
    expect(() => {
      writable[0] = "bogus";
    }).toThrow(TypeError);
    expect(HELPDESK_STATES).toEqual(STATES);
  });
});

describe("canHelpdeskTransition and assertHelpdeskTransition (G3)", () => {
  it("is checked against an oracle of 5 states and 10 legal pairs", () => {
    expect(PAIRS).toHaveLength(25);
    expect(legal.size).toBe(10);
    expect(PAIRS.filter(({ ok }) => ok)).toHaveLength(10);
  });

  it.each(PAIRS)("$from -> $to is $ok", ({ from, to, ok }) => {
    expect(canHelpdeskTransition(from, to)).toBe(ok);
    if (ok) expect(assertHelpdeskTransition(from, to)).toBeUndefined();
    else expect(() => assertHelpdeskTransition(from, to)).toThrow(IllegalHelpdeskTransitionError);
  });

  it("refuses every same-state pair and every move out of closed", () => {
    for (const state of STATES) expect(canHelpdeskTransition(state, state)).toBe(false);
    for (const to of STATES) expect(canHelpdeskTransition("closed", to)).toBe(false);
  });

  it("names both states in the error for an illegal move", () => {
    const call = () => assertHelpdeskTransition("closed", "new");
    expect(call).toThrow(expect.objectContaining({ name: "IllegalHelpdeskTransitionError" }));
    expect(call).toThrow(/\bclosed\b.*\bnew\b/);
  });

  it.each(UNKNOWN.map((bad) => ({ bad })))("throws for the unknown state $bad", ({ bad }) => {
    for (const fn of [can, assert]) {
      for (const known of STATES) {
        expect(() => fn(bad, known)).toThrow(IllegalHelpdeskTransitionError);
        expect(() => fn(known, bad)).toThrow(IllegalHelpdeskTransitionError);
      }
      expect(() => fn(bad, bad)).toThrow(IllegalHelpdeskTransitionError);
    }
  });

  it("does not echo an unknown value in the error message", () => {
    // Privacy rule: an unknown value could be anything, including ticket text.
    for (const call of [
      () => can("jo@example.com", "closed"),
      () => can("new", "jo@example.com"),
      () => next("jo@example.com"),
    ]) {
      expect(call).toThrow(IllegalHelpdeskTransitionError);
      expect(call).not.toThrow(/jo@example\.com/);
    }
    expect(() => can("jo@example.com", "closed")).toThrow(
      "Illegal helpdesk state transition: (unknown state) -> closed",
    );
    expect(() => can("jo@example.com", "closed")).toThrow(/\bclosed\b/);
    expect(() => can("new", "jo@example.com")).toThrow(/\bnew\b/);
  });
});

describe("nextHelpdeskStates", () => {
  it("returns the G3 moves in order for each state", () => {
    expect(nextHelpdeskStates("new")).toEqual(["in_progress", "on_hold", "resolved", "closed"]);
    expect(nextHelpdeskStates("in_progress")).toEqual(["on_hold", "resolved"]);
    expect(nextHelpdeskStates("on_hold")).toEqual(["in_progress", "resolved"]);
    expect(nextHelpdeskStates("resolved")).toEqual(["closed", "in_progress"]);
    expect(nextHelpdeskStates("closed")).toEqual([]);
  });

  it("agrees with canHelpdeskTransition for every pair", () => {
    for (const { from, to, ok } of PAIRS) {
      expect(nextHelpdeskStates(from).includes(to)).toBe(ok);
    }
  });

  it("returns a list that cannot change the rules", () => {
    for (const from of STATES) {
      const list = nextHelpdeskStates(from) as string[];
      list.push("bogus");
      list.length = 0;
      expect(nextHelpdeskStates(from)).toEqual(
        LEGAL.filter(([f]) => f === from).map(([, to]) => to),
      );
    }
    expect(canHelpdeskTransition("resolved", "closed")).toBe(true);
    expect(canHelpdeskTransition("new", "closed")).toBe(true);
  });

  it.each(UNKNOWN.map((bad) => ({ bad })))("throws for the unknown state $bad", ({ bad }) => {
    expect(() => next(bad)).toThrow(IllegalHelpdeskTransitionError);
  });
});

describe("HELPDESK_STATE_TRANSITIONS", () => {
  it("lists exactly the 10 G3 pairs, in the order migration 0007 seeds them", () => {
    expect(HELPDESK_STATE_TRANSITIONS).toEqual(LEGAL);
  });

  it("is frozen all the way down, so a caller cannot change the rules", () => {
    expect(Object.isFrozen(HELPDESK_STATE_TRANSITIONS)).toBe(true);
    const writable = HELPDESK_STATE_TRANSITIONS as unknown as string[][];
    expect(() => writable.push(["closed", "new"])).toThrow(TypeError);
    for (const pair of writable) {
      expect(Object.isFrozen(pair)).toBe(true);
      expect(() => {
        pair[1] = "closed";
      }).toThrow(TypeError);
    }
    expect(HELPDESK_STATE_TRANSITIONS).toEqual(LEGAL);
    expect(canHelpdeskTransition("closed", "new")).toBe(false);
  });
});
