import { errorClassName, type AlertFn } from "@ai-it-support/ai";
import {
  createDbClient,
  createRepositories,
  dbEnvShape,
  type Repositories,
  type Ticket,
  type Triage,
} from "@ai-it-support/db";
import {
  NOTIFY_REQUESTER_TASK_ID,
  notifyRequesterPayloadSchema,
  parseEnv,
  replyEnvShape,
  type NotificationKind,
  type NotifyRequesterPayload,
} from "@ai-it-support/shared";
import { AbortTaskRunError, logger, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";
import {
  buildReplyEmail,
  createResendClient,
  EmailProviderError,
  isAllowedRecipient,
  parseRecipient,
  type ResendClient,
} from "../email/index.js";
import { createFailureAlert } from "../pipeline-alert.js";

export type { NotifyRequesterPayload };

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
function isEligible(kind: NotificationKind, ticket: Ticket, triage: Triage | null): boolean {
  if (["rejected", "escalated_manual", "failed"].includes(ticket.status)) return false;
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
 * Provider errors follow the task's three-attempt rule. The event follows the
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
    throw new AbortTaskRunError("notify-requester: the saved fix steps have an unexpected shape");
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

const notifyRequesterDepsEnvShape = { ...dbEnvShape, ...replyEnvShape };

/** Validates env and builds the real deps. Invalid variables throw, naming the variable. */
export function createNotifyRequesterDeps(
  source: Record<string, string | undefined>,
): NotifyRequesterDeps {
  const env = parseEnv(notifyRequesterDepsEnvShape, source);
  return {
    repos: createRepositories(createDbClient(source)),
    resend: createResendClient({ apiKey: env.RESEND_API_KEY }),
    from: env.REPLY_FROM,
    allowedRecipients: env.REPLY_ALLOWED_RECIPIENTS,
    logger,
  };
}

export interface NotifyRequesterFailureDeps {
  repos: Pick<Repositories, "getTicket" | "getTriage" | "recordNotification" | "addEvent">;
  alert: AlertFn;
  logger: { info: LogFn; warn: LogFn; error: LogFn };
}

/** The database and the alert sink only: the run may have failed on any other variable. */
export function createNotifyRequesterFailureDeps(
  source: Record<string, string | undefined>,
  repos: NotifyRequesterFailureDeps["repos"] &
    Pick<Repositories, "recordSecurityEvent"> = createRepositories(createDbClient(source)),
): NotifyRequesterFailureDeps {
  return { repos, alert: createFailureAlert("notify-requester", source, repos), logger };
}

/**
 * The task's `onFailure` hook, called once after the last attempt failed. For
 * a ticket the email suits (`isEligible`) it records one `failed` row
 * (`provider_error`), `notification_failed { kind, error }` and
 * `alert:notify_failed`. An existing row, a sent one included, is left as it
 * is and raises nothing. It never changes the ticket's status and never
 * throws; a failure here (the database is down) is logged by class name only.
 */
export async function onNotifyRequesterFailure(
  params: { payload: unknown; error: unknown },
  deps?: NotifyRequesterFailureDeps,
): Promise<void> {
  // Refused input never reached Resend and must not fill the terminal row slot.
  if (params.error instanceof AbortTaskRunError) return;
  const error =
    params.error instanceof EmailProviderError ? params.error.code : errorClassName(params.error);
  const log = deps?.logger ?? logger;
  const safeLog = (message: string, data: object) => {
    try {
      log.error(message, { ...data });
    } catch {
      // The hook must not throw, even when logging fails.
    }
  };
  try {
    const parsed = notifyRequesterPayloadSchema.safeParse(params.payload);
    if (!parsed.success) {
      safeLog("notify-requester: failed run without a valid payload", { error });
      return;
    }
    const { ticketId, kind } = parsed.data;
    const { repos, alert } = deps ?? createNotifyRequesterFailureDeps(process.env);
    const ticket = await repos.getTicket(ticketId);
    const triage = kind === "needs_info" ? await repos.getTriage(ticketId) : null;
    if (!ticket || !isEligible(kind, ticket, triage)) {
      safeLog("notify-requester: failed run, nothing recorded", { ticketId, kind, error });
      return;
    }
    const { created } = await repos.recordNotification({
      ticketId,
      channel: "email",
      kind,
      status: "failed",
      providerId: null,
      reason: "provider_error",
    });
    if (!created) {
      safeLog("notify-requester: failed run, row already recorded", { ticketId, kind, error });
      return;
    }
    await repos.addEvent(ticketId, "notification_failed", { kind, error });
    await alert("notify_failed", { ticketId });
    safeLog("notify-requester: failed", { ticketId, kind, error });
  } catch (hookError) {
    safeLog("notify-requester: could not record the failure", {
      error,
      cause: errorClassName(hookError),
    });
  }
}

/**
 * Task options, exported so a test can assert the wiring. Sends the requester
 * one reply email per ticket and kind. Three attempts with exponential backoff;
 * env is validated at the start of each run.
 */
export const notifyRequesterOptions = {
  id: NOTIFY_REQUESTER_TASK_ID,
  schema: notifyRequesterPayloadSchema,
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 10_000,
    randomize: true,
  },
  run: async (payload: NotifyRequesterPayload) =>
    runNotifyRequester(payload, createNotifyRequesterDeps(process.env)),
  onFailure: onNotifyRequesterFailure,
};

export const notifyRequester = schemaTask(notifyRequesterOptions);
