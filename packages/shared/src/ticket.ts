import { z } from "zod";

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

export type TicketSubmission = z.infer<typeof ticketSubmissionSchema>;

/**
 * Trigger.dev id of the intake task (built in services/pipeline by P2-T6).
 * Triggered by string id with this payload type, so callers do not import the task.
 */
export const INTAKE_TICKET_TASK_ID = "intake-ticket";

export interface IntakeTicketPayload {
  ticketId: string;
}
