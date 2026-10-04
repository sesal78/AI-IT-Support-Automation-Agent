// Ticket status model (plan §2.6). Pure: no I/O, no stored state.

/** The 12 ticket statuses, in spec order. */
export const TICKET_STATUSES = [
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

export type TicketStatus = (typeof TICKET_STATUSES)[number];

/**
 * Forward moves per status. Every status except `failed` can also move to
 * `failed`, and nothing leaves `failed`: that rule is in canTransition, not here.
 */
const NEXT: Record<TicketStatus, readonly TicketStatus[]> = {
  new: ["redacted"],
  redacted: ["triaged"],
  triaged: ["auto", "review_pending"],
  auto: ["helpdesk_pending"],
  helpdesk_pending: ["incident_created", "incident_skipped_shadow"],
  incident_created: [],
  incident_skipped_shadow: [],
  review_pending: ["approved", "rejected", "escalated_manual"],
  approved: ["helpdesk_pending"],
  rejected: [],
  escalated_manual: [],
  failed: [],
};

// A list lookup, not `in`: an inherited key such as "constructor" must not pass.
const isTicketStatus = (value: unknown): value is TicketStatus =>
  (TICKET_STATUSES as readonly unknown[]).includes(value);

/**
 * Thrown for an illegal move and for a value that is not a ticket status.
 * The message names known statuses only. An unknown value is never echoed:
 * it could be anything, including ticket text.
 */
export class IllegalTransitionError extends Error {
  constructor(from: unknown, to: unknown) {
    const label = (value: unknown) => (isTicketStatus(value) ? value : "(unknown status)");
    super(`Illegal ticket status transition: ${label(from)} -> ${label(to)}`);
    this.name = "IllegalTransitionError";
  }
}

/**
 * True when a ticket may move from `from` to `to`. A same-status pair is false.
 * Throws IllegalTransitionError when either value is not a ticket status, so
 * bad input never reads as a plain "no".
 */
export function canTransition(from: TicketStatus, to: TicketStatus): boolean {
  if (!isTicketStatus(from) || !isTicketStatus(to)) throw new IllegalTransitionError(from, to);
  if (to === "failed") return from !== "failed";
  return NEXT[from].includes(to);
}

/** Throws IllegalTransitionError unless `from` → `to` is a legal move. */
export function assertTransition(from: TicketStatus, to: TicketStatus): void {
  if (!canTransition(from, to)) throw new IllegalTransitionError(from, to);
}
