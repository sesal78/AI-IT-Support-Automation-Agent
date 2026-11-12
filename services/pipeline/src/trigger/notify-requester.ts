import { errorClassName } from "@ai-it-support/ai";
import type { Repositories, Ticket, Triage } from "@ai-it-support/db";
import type { NotificationKind, NotifyRequesterPayload } from "@ai-it-support/shared";
import { AbortTaskRunError } from "@trigger.dev/sdk";
import { z } from "zod";
import {
  buildReplyEmail,
  isAllowedRecipient,
  parseRecipient,
  type ResendClient,
} from "../email/index.js";

export type NotifyRequesterResult = {
  ticketId: string;
  kind: NotificationKind;
  /** `already_recorded`: a row for this ticket and kind existed, so nothing was sent. */
  outcome: "sent" | "skipped" | "already_recorded";
};

type LogFn = (message: string, data?: Record<string, unknown>) => void;

export interface NotifyRequesterDeps {
  repos: Pick<
    Repositories,
    | "getTicket"
    | "getTriage"
    | "getHelpdeskTicketByTicketId"
    | "getRequesterEmail"
    | "getNotification"
    | "recordNotification"
    | "addEvent"
  >;
  resend: Pick<ResendClient, "send">;
  /** REPLY_FROM. */
  from: string;
  /** REPLY_ALLOWED_RECIPIENTS: lower-case addresses, matched exactly. */
  allowedRecipients: readonly string[];
  logger: { info: LogFn; warn: LogFn; error: LogFn };
}

const fixStepsSchema = z.object({ steps: z.array(z.string()) });

/**
 * Whether the ticket is in the state this kind of email belongs to: an
 * `incident_reply` needs the status `incident_created`, a `needs_info` needs
 * the triage flag. The run aborts without it; the failure hook records
 * nothing without it, so a refused trigger can never fill the ticket's slot.
 */
export function isEligible(kind: NotificationKind, ticket: Ticket, triage: Triage | null): boolean {
  return kind === "incident_reply"
    ? ticket.status === "incident_created"
    : triage?.flags?.includes("needs_info") === true;
}

/**
 * The stored helpdesk number: the built-in ticket's `HD` number from its own
 * table, otherwise the ServiceNow `INC` number. The two never mix: a built-in
 * ticket ignores the ServiceNow columns.
 */
async function storedNumber(
  repos: NotifyRequesterDeps["repos"],
  ticket: Ticket,
): Promise<string | null> {
  if (ticket.helpdesk === "builtin") {
    return (await repos.getHelpdeskTicketByTicketId(ticket.id))?.number ?? null;
  }
  return ticket.servicenow_number;
}

/**
 * The task body, exported so tests can call it without the Trigger.dev runtime.
 *
 * Order: an existing row for (ticket, email, kind) ends the run (nothing is
 * sent twice); the ticket must exist and suit the kind (`isEligible`), else
 * `AbortTaskRunError` and no request; an `incident_reply` needs the stored
 * helpdesk number; the requester address is read (pipeline only). An address
 * not on `REPLY_ALLOWED_RECIPIENTS` gets a `skipped` row and
 * `notification_skipped`, with no Resend request. Otherwise `buildReplyEmail`
 * (stored ITS number, stored INC or HD number, `[E2E]` for a test ticket) is
 * sent with the key `notify:<ticketId>:<kind>`, then the `sent` row (provider
 * ID) and `notification_sent`.
 *
 * Retries. The Resend client makes up to 3 requests per call (429, 5xx,
 * network and timeout, waiting 1 s then 2 s); the task makes up to 3 attempts.
 * A repeated key makes the provider return its first result, which bridges a
 * lost reply or a failed row write inside the provider's key window (24 hours).
 The event follows the
 * row and is written only by the run that created the row, so a crash between
 * the two leaves the row (the proof) without its event.
 *
 * Privacy: the address goes to Resend's `to` field only. Rows, events and
 * logs hold IDs, the kind and fixed words or error codes, never the address,
 * ticket text or the email body.
 */
export async function runNotifyRequester(
  payload: NotifyRequesterPayload,
  deps: NotifyRequesterDeps,
): Promise<NotifyRequesterResult> {
  const { ticketId, kind } = payload;
  const { repos, logger: log } = deps;
  const done = (outcome: NotifyRequesterResult["outcome"]) => ({ ticketId, kind, outcome });

  if ((await repos.getNotification(ticketId, kind)) !== null) {
    log.info("notify-requester: already recorded", { ticketId, kind });
    return done("already_recorded");
  }

  const ticket = await repos.getTicket(ticketId);
  if (!ticket) throw new AbortTaskRunError(`notify-requester: ticket ${ticketId} not found`);
  const triage = await repos.getTriage(ticketId);
  if (!isEligible(kind, ticket, triage)) {
    throw new AbortTaskRunError(`notify-requester: ticket ${ticketId} is not ready for ${kind}`);
  }
  let number: string | undefined;
  if (kind === "incident_reply") {
    const stored = await storedNumber(repos, ticket);
    if (stored === null) {
      throw new AbortTaskRunError(`notify-requester: ticket ${ticketId} has no helpdesk number`);
    }
    number = stored;
  }
  const requester = await repos.getRequesterEmail(ticketId);
  if (requester === null) {
    throw new AbortTaskRunError(`notify-requester: ticket ${ticketId} has no requester address`);
  }

  if (!isAllowedRecipient(requester, deps.allowedRecipients)) {
    const { created } = await repos.recordNotification({
      ticketId,
      channel: "email",
      kind,
      status: "skipped",
      providerId: null,
      reason: "not_allow_listed",
    });
    if (!created) return done("already_recorded");
    await repos.addEvent(ticketId, "notification_skipped", { kind });
    log.info("notify-requester: skipped, not allow-listed", { ticketId, kind });
    return done("skipped");
  }

  const fix =
    kind === "incident_reply" && triage?.suggested_fix != null
      ? fixStepsSchema.safeParse(triage.suggested_fix)
      : null;
  if (fix !== null && !fix.success) {
    throw new Error("notify-requester: the saved fix steps have an unexpected shape");
  }
  let email: ReturnType<typeof buildReplyEmail>;
  try {
    email = buildReplyEmail({
      kind,
      ticketNumber: ticket.ticket_number,
      ...(number === undefined ? {} : { number }),
      ...(fix === null ? {} : { fixSteps: fix.data.steps }),
      isTest: ticket.is_test,
    });
  } catch (error) {
    // Class name only: the message of a header or number error names no value, but keep it so.
    throw new AbortTaskRunError(
      `notify-requester: ticket ${ticketId} cannot build the email (${errorClassName(error)})`,
    );
  }

  const { id: providerId } = await deps.resend.send({
    from: deps.from,
    to: parseRecipient(requester),
    subject: email.subject,
    text: email.text,
    html: email.html,
    idempotencyKey: `notify:${ticketId}:${kind}`,
  });

  const { created } = await repos.recordNotification({
    ticketId,
    channel: "email",
    kind,
    status: "sent",
    providerId,
    reason: null,
  });
  if (!created) return done("already_recorded");
  await repos.addEvent(ticketId, "notification_sent", { kind });
  log.info("notify-requester: sent", { ticketId, kind });
  return done("sent");
}
