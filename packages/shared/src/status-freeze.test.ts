import { describe, expect, expectTypeOf, it } from "vitest";
import {
  canTransition,
  IllegalTransitionError,
  TICKET_STATUSES,
  type TicketStatus,
} from "./index.js";

// Written out by hand from plan §2.6, never built from status.ts.
const SPEC = [
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
] as const;

// Casts that let the test attempt writes the type checker would reject.
const writable = TICKET_STATUSES as unknown as string[];
const can = canTransition as (from: unknown, to: unknown) => boolean;

describe("TICKET_STATUSES is frozen (P3-T2f)", () => {
  it("is frozen", () => {
    expect(Object.isFrozen(TICKET_STATUSES)).toBe(true);
  });

  it("throws a TypeError on push, index assignment and length = 0", () => {
    expect(() => writable.push("bogus")).toThrow(TypeError);
    expect(() => {
      writable[0] = "bogus";
    }).toThrow(TypeError);
    expect(() => {
      writable.length = 0;
    }).toThrow(TypeError);
    expect(TICKET_STATUSES).toEqual(SPEC);
  });

  it("still rejects an unknown status after the failed writes", () => {
    expect(() => writable.push("bogus")).toThrow(TypeError);
    expect(() => can("rejected", "bogus")).toThrow(IllegalTransitionError);
    expect(() => can("bogus", "failed")).toThrow(IllegalTransitionError);
  });

  it("keeps the readonly 12-name tuple type", () => {
    expectTypeOf<TicketStatus>().toEqualTypeOf<(typeof SPEC)[number]>();
    expectTypeOf(TICKET_STATUSES).toEqualTypeOf<typeof SPEC>();
  });
});
