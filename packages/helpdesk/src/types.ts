export type HelpdeskKind = "servicenow" | "builtin" | "fake";

/** The G3 state names. */
export type HelpdeskTicketState = "new" | "in_progress" | "on_hold" | "resolved" | "closed";
export type HelpdeskUpdateState = Exclude<HelpdeskTicketState, "new">;

export const UPDATE_STATES: readonly HelpdeskUpdateState[] = [
  "in_progress",
  "on_hold",
  "resolved",
  "closed",
];

export interface HelpdeskTicketRef {
  externalId: string;
  number: string;
}

/** Redacted fields only: there is no field for raw text or a requester name. */
export interface CreateHelpdeskTicketInput {
  ticketId: string;
  isTest: boolean;
  redactedTitle: string;
  redactedDescription: string;
  category: string;
  priority: string;
  assignmentGroup: string | null;
  requesterEmail: string | null;
}

/** Returned by a write method when shadow mode skipped the call (P5-T4). */
export interface ShadowSkip {
  skipped: "shadow";
}

export type CreatedHelpdeskTicket = HelpdeskTicketRef & { callerDefaulted: boolean };

export interface HelpdeskHealth {
  status: "ok" | "asleep" | "down";
}

export interface HelpdeskConnector {
  readonly kind: HelpdeskKind;
  createTicket(input: CreateHelpdeskTicketInput): Promise<CreatedHelpdeskTicket | ShadowSkip>;
  findByExternalRef(ticketId: string): Promise<HelpdeskTicketRef | null>;
  addNote(ref: HelpdeskTicketRef, body: string): Promise<void | ShadowSkip>;
  updateTicket(
    ref: HelpdeskTicketRef,
    update: { state: HelpdeskUpdateState },
  ): Promise<void | ShadowSkip>;
  health(): Promise<HelpdeskHealth>;
}
