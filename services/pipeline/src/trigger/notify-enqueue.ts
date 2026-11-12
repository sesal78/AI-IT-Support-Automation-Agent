import { errorClassName, type AlertFn } from "@ai-it-support/ai";
import type { Repositories } from "@ai-it-support/db";
import {
  NOTIFY_REQUESTER_TASK_ID,
  type NotificationKind,
  type NotifyRequesterPayload,
} from "@ai-it-support/shared";
import { idempotencyKeys, tasks } from "@trigger.dev/sdk";
import type { notifyRequester } from "./notify-requester.js";

// The one door from helpdesk-sync and review-ticket into notify-requester
// (P5-T8b): the trigger, its per-ticket-and-kind key, and what a failed trigger
// does. Unlike the sync hand-off, a failed trigger never fails the caller: the
// reply email is a courtesy, the ticket's work is done.

type LogFn = (message: string, data?: Record<string, unknown>) => void;

/** Triggers `notify-requester`. Replaced in tests. */
export type TriggerNotifyFn = (
  payload: NotifyRequesterPayload,
  options: { idempotencyKey: string },
) => Promise<unknown>;

/**
 * Key material for the trigger: the ticket and the kind, so every call for
 * the same email matches one run, and the two kinds of one ticket never share.
 */
export const notifyRequesterIdempotencyKey = (ticketId: string, kind: NotificationKind) =>
  `${NOTIFY_REQUESTER_TASK_ID}:${ticketId}:${kind}`;

/** The real trigger, with a `global` key as in helpdesk-enqueue. */
export const triggerNotifyRequesterTask: TriggerNotifyFn = async (payload, { idempotencyKey }) =>
  tasks.trigger<typeof notifyRequester>(NOTIFY_REQUESTER_TASK_ID, payload, {
    idempotencyKey: await idempotencyKeys.create(idempotencyKey, { scope: "global" }),
  });

export interface NotifyEnqueueDeps {
  /** The task that is handing off, for the log line. */
  task: "helpdesk-sync" | "review-ticket";
  /** No status writer on purpose: a failed trigger can never move the ticket. */
  repos: Pick<Repositories, "listEventTypes" | "addEvent">;
  triggerNotify: TriggerNotifyFn;
  alert: AlertFn;
  logger: { error: LogFn };
}

/**
 * Starts the reply email of `kind` with the key `notify-requester:<ticketId>:<kind>`
 * (a repeat call is the same run). A failed trigger records `notify_enqueue_failed
 * { kind, error: <class name> }` (once per ticket) and raises
 * `alert:notify_enqueue_failed`; it never throws and never touches the ticket's
 * status, so the caller's run goes on. If recording the failure fails too, only
 * the class name is logged.
 */
export async function enqueueNotify(
  payload: NotifyRequesterPayload,
  deps: NotifyEnqueueDeps,
): Promise<void> {
  const { ticketId, kind } = payload;
  try {
    await deps.triggerNotify(
      { ticketId, kind },
      { idempotencyKey: notifyRequesterIdempotencyKey(ticketId, kind) },
    );
  } catch (triggerError) {
    const error = errorClassName(triggerError);
    try {
      const written = await deps.repos.listEventTypes(ticketId, ["notify_enqueue_failed"]);
      if (!written.includes("notify_enqueue_failed")) {
        await deps.repos.addEvent(ticketId, "notify_enqueue_failed", { kind, error });
      }
    } catch (recordError) {
      deps.logger.error(`${deps.task}: could not record the notify enqueue failure`, {
        ticketId,
        kind,
        cause: errorClassName(recordError),
      });
    }
    // The alert sink never throws, so the alert is raised even if the event was lost.
    await deps.alert("notify_enqueue_failed", { ticketId });
    deps.logger.error(`${deps.task}: notify enqueue failed`, { ticketId, kind, error });
  }
}
