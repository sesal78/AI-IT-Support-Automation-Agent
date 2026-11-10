import { z } from "zod";
import type { TestOverrides } from "./test-overrides.js";

const text = (min: number, max: number) => z.string().trim().min(min).max(max);

/** Body of `POST /api/tickets`, shared by the API route and the ticket form. */
export const ticketSubmissionSchema = z.object({
  name: text(1, 100),
  email: z.email(),
  department: text(1, 100),
  title: text(3, 200),
  description: text(10, 5000),
  turnstileToken: z.string().min(1),
});

/**
 * Display number of a ticket: `ITS-` plus 6 digits (phase 5, resolved points
 * 20-22). Display only: it is never an identifier. `$` without the `m` flag
 * matches only at the very end, so a trailing CR or LF fails.
 */
export const TICKET_NUMBER_RE = /^ITS-[0-9]{6}$/;

export const ticketNumberSchema = z.string().regex(TICKET_NUMBER_RE, "must be a ticket number");

export type TicketSubmission = z.infer<typeof ticketSubmissionSchema>;

/**
 * Trigger.dev id of the intake task (built in services/pipeline by P2-T6).
 * Triggered by string id with this payload type, so callers do not import the task.
 */
export const INTAKE_TICKET_TASK_ID = "intake-ticket";

export interface IntakeTicketPayload {
  ticketId: string;
  /** Test switches from the E2E test route only; the pipeline ignores them until P3-T10c. */
  testOverrides?: TestOverrides;
}

/**
 * Trigger.dev id of the triage task (services/pipeline, P3-T10b), triggered
 * by string id with `TriageTicketPayload` once a ticket is `redacted`.
 */
export const TRIAGE_TICKET_TASK_ID = "triage-ticket";

export interface TriageTicketPayload {
  ticketId: string;
  /** Test switches from the E2E test route only; applied from P3-T10c. */
  testOverrides?: TestOverrides;
}

/**
 * Trigger.dev id of the review task (services/pipeline, P4-T4a), triggered
 * by string id with `ReviewTicketPayload` for a ticket routed to `review`.
 */
export const REVIEW_TICKET_TASK_ID = "review-ticket";

export interface ReviewTicketPayload {
  ticketId: string;
  /** Test switches; they take effect only in E2E mode on a test ticket. */
  testOverrides?: TestOverrides;
}

/**
 * Trigger.dev id of the helpdesk sync task (services/pipeline, P5-T5a), triggered
 * by string id with `HelpdeskSyncPayload` for an `auto` or `approved` ticket.
 */
export const HELPDESK_SYNC_TASK_ID = "helpdesk-sync";

export interface HelpdeskSyncPayload {
  ticketId: string;
  /** Test switches; they take effect only in E2E mode on a test ticket. */
  testOverrides?: TestOverrides;
}
