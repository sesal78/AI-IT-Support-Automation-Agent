import type { Repositories } from "@ai-it-support/db";
import {
  INTAKE_TICKET_TASK_ID,
  testOverridesSchema,
  type IntakeTicketPayload,
  type TestOverrides,
} from "@ai-it-support/shared";
import { tasks, type Task } from "@trigger.dev/sdk";

// The intake task lives in services/pipeline (P2-T6); it is triggered by id
// with a locally declared payload type so this module does not import it.
type IntakeTicketTask = Task<typeof INTAKE_TICKET_TASK_ID, IntakeTicketPayload>;

export interface NewIntakeTicket {
  name: string;
  email: string;
  department: string;
  title: string;
  description: string;
  idempotencyKey: string;
  /** Stored as `tickets.is_test`. The caller decides; never taken from a request body. */
  isTest: boolean;
  /** Already gated by `effectiveTestOverrides`; sent in the task payload only for a test ticket. */
  testOverrides?: TestOverrides;
}

export type CreateAndEnqueueResult =
  | { outcome: "store_failed" }
  | { outcome: "duplicate"; ticketId: string }
  | { outcome: "queued"; ticketId: string }
  | { outcome: "enqueue_failed"; ticketId: string };

// Error class name only: messages and stacks can carry request data.
const errorName = (error: unknown) => (error instanceof Error ? error.name : "unknown");

/**
 * Stores a ticket and triggers the intake task. Shared by the form route and
 * the test route. Logs never include request data.
 */
export async function createAndEnqueueTicket(
  db: Pick<Repositories, "createTicket" | "addEvent">,
  input: NewIntakeTicket,
): Promise<CreateAndEnqueueResult> {
  let ticketId: string;
  let created: boolean;
  try {
    const result = await db.createTicket({
      source: "web",
      raw_title: input.title,
      raw_description: input.description,
      requester_email: input.email,
      requester_name: input.name,
      department: input.department,
      idempotency_key: input.idempotencyKey,
      is_test: input.isTest,
    });
    ticketId = result.ticket.id;
    created = result.created;
    if (created) await db.addEvent(ticketId, "received");
  } catch (error) {
    console.error(`[api/tickets] store failed: ${errorName(error)}`);
    return { outcome: "store_failed" };
  }

  // A repeated idempotency key returns the existing ticket; its task was already triggered.
  if (!created) return { outcome: "duplicate", ticketId };

  // Switches travel only on a test ticket and only when non-empty.
  const payload: IntakeTicketPayload = { ticketId };
  if (input.isTest && input.testOverrides) {
    const overrides = testOverridesSchema.parse(input.testOverrides);
    if (Object.keys(overrides).length > 0) payload.testOverrides = overrides;
  }

  try {
    await tasks.trigger<IntakeTicketTask>(INTAKE_TICKET_TASK_ID, payload);
    return { outcome: "queued", ticketId };
  } catch (error) {
    console.error(`[api/tickets] enqueue failed for ticket ${ticketId}: ${errorName(error)}`);
    try {
      await db.addEvent(ticketId, "enqueue_failed", { error: errorName(error) });
    } catch (eventError) {
      console.error(
        `[api/tickets] recording enqueue_failed failed for ticket ${ticketId}: ${errorName(eventError)}`,
      );
    }
    return { outcome: "enqueue_failed", ticketId };
  }
}
