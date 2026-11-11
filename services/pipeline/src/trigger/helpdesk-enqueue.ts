import { errorClassName, type AlertFn } from "@ai-it-support/ai";
import type { Repositories } from "@ai-it-support/db";
import {
  HELPDESK_SYNC_TASK_ID,
  type HelpdeskSyncPayload,
  type TestOverrides,
} from "@ai-it-support/shared";
import { AbortTaskRunError, idempotencyKeys, tasks } from "@trigger.dev/sdk";
import type { helpdeskSync } from "./helpdesk-sync.js";

// The one door from triage and review into helpdesk-sync (P5-T5b): the trigger,
// its per-ticket key, and what a failed trigger does to the ticket.

type LogFn = (message: string, data?: Record<string, unknown>) => void;

/** Triggers `helpdesk-sync`. Replaced in tests. */
export type TriggerHelpdeskSyncFn = (
  payload: HelpdeskSyncPayload,
  options: { idempotencyKey: string },
) => Promise<unknown>;

/**
 * Key material for the sync trigger: the ticket ID only, so every attempt of
 * this ticket matches and a second ticket never shares a run.
 */
export const helpdeskSyncIdempotencyKey = (ticketId: string) =>
  `${HELPDESK_SYNC_TASK_ID}:${ticketId}`;

/** The real trigger, with a `global` key as in intake-ticket's triggerTriageTask. */
export const triggerHelpdeskSyncTask: TriggerHelpdeskSyncFn = async (payload, { idempotencyKey }) =>
  tasks.trigger<typeof helpdeskSync>(HELPDESK_SYNC_TASK_ID, payload, {
    idempotencyKey: await idempotencyKeys.create(idempotencyKey, { scope: "global" }),
  });

export interface HelpdeskEnqueueDeps {
  /** The task that is handing off, for the log line and the abort message. */
  task: "triage-ticket" | "review-ticket";
  repos: Pick<Repositories, "listEventTypes" | "addEvent" | "setTicketStatus">;
  triggerHelpdeskSync: TriggerHelpdeskSyncFn;
  alert: AlertFn;
  logger: { error: LogFn };
}

/**
 * Triggers helpdesk-sync with the payload's test switches unchanged and the key
 * `helpdesk-sync:<ticketId>`. A failed trigger records `helpdesk_enqueue_failed
 * { error: <class name> }` (once), sets the status `failed`, raises the alert
 * `helpdesk_sync_failed` with that move, and aborts the run naming the ticket
 * ID. Nothing else is written, so a person can re-run the ticket.
 */
export async function enqueueHelpdeskSync(
  payload: { ticketId: string; testOverrides?: TestOverrides | undefined },
  deps: HelpdeskEnqueueDeps,
): Promise<void> {
  const { ticketId, testOverrides } = payload;
  const { repos } = deps;
  try {
    await deps.triggerHelpdeskSync(
      { ticketId, ...(testOverrides === undefined ? {} : { testOverrides }) },
      { idempotencyKey: helpdeskSyncIdempotencyKey(ticketId) },
    );
  } catch (triggerError) {
    const error = errorClassName(triggerError);
    const written = await repos.listEventTypes(ticketId, ["helpdesk_enqueue_failed"]);
    if (!written.includes("helpdesk_enqueue_failed")) {
      await repos.addEvent(ticketId, "helpdesk_enqueue_failed", { error });
    }
    const { changed } = await repos.setTicketStatus(ticketId, "failed");
    if (changed) await deps.alert("helpdesk_sync_failed", { ticketId });
    deps.logger.error(`${deps.task}: helpdesk sync enqueue failed`, { ticketId, error });
    throw new AbortTaskRunError(
      `${deps.task}: could not enqueue the helpdesk sync for ticket ${ticketId}`,
    );
  }
}
