import { classifySensitive, createTypeSafeChecker, type SensitiveChecker } from "@ai-it-support/ai";
import {
  createDbClient,
  createRepositories,
  dbEnvShape,
  type Repositories,
} from "@ai-it-support/db";
import {
  INTAKE_TICKET_TASK_ID,
  parseEnv,
  redact,
  sensitiveCheckEnvShape,
  type IntakeTicketPayload,
} from "@ai-it-support/shared";
import { AbortTaskRunError, logger, schemaTask } from "@trigger.dev/sdk";
import { z } from "zod";

// Payload type is shared with the POST /api/tickets caller (packages/shared).
export const intakeTicketPayload = z.object({
  ticketId: z.uuid(),
}) satisfies z.ZodType<IntakeTicketPayload>;

export type { IntakeTicketPayload };

export interface IntakeTicketResult {
  ticketId: string;
  sensitive: boolean;
  flags: string[];
}

type LogFn = (message: string, data?: Record<string, unknown>) => void;

export interface IntakeDeps {
  repos: Pick<Repositories, "getTicket" | "saveRedaction" | "addEvent" | "saveTriage">;
  checker: SensitiveChecker;
  threshold: number;
  logger: { info: LogFn; warn: LogFn; error: LogFn };
}

const intakeEnvShape = { ...dbEnvShape, ...sensitiveCheckEnvShape };

/** Validates env and builds the real deps. Invalid variables throw, naming the variable. */
export function createIntakeDeps(source: Record<string, string | undefined>): IntakeDeps {
  const env = parseEnv(intakeEnvShape, source);
  return {
    repos: createRepositories(createDbClient(source)),
    checker: createTypeSafeChecker({ apiKey: env.TYPESAFE_API_KEY }),
    threshold: env.SENSITIVE_THRESHOLD,
    logger,
  };
}

/**
 * The task body, exported so tests can call it without the Trigger.dev runtime.
 *
 * Retry safety: saveRedaction and saveTriage upsert by ticket_id, so a retry
 * (e.g. after a TypeSafe failure) never duplicates rows. The append-only
 * `redacted` event is written once per attempt and carries the attempt
 * number, so a repeat is visible as a retry rather than a second redaction.
 *
 * Privacy: only redacted text reaches the checker. Logs and event payloads
 * carry ids, counts and flag names, never ticket text.
 */
export async function runIntakeTicket(
  payload: IntakeTicketPayload,
  deps: IntakeDeps,
  attempt = 1,
): Promise<IntakeTicketResult> {
  const { ticketId } = payload;
  const { repos, logger: log } = deps;

  const ticket = await repos.getTicket(ticketId);
  if (!ticket) {
    // The API creates the ticket before triggering, so a retry cannot help.
    log.error("intake-ticket: ticket not found", { ticketId });
    throw new AbortTaskRunError(`intake-ticket: ticket ${ticketId} not found`);
  }

  const title = redact(ticket.raw_title);
  const description = redact(ticket.raw_description);
  const redactions = mergeLogs(title.log, description.log);

  await repos.saveRedaction({
    ticket_id: ticketId,
    redacted_title: title.text,
    redacted_description: description.text,
    redaction_log: redactions,
  });
  await repos.addEvent(ticketId, "redacted", { redactions, attempt });
  log.info("intake-ticket: redacted", { ticketId, attempt, redactions });

  const result = await classifySensitive(
    { title: title.text, description: description.text },
    deps.checker,
    deps.threshold,
  );

  await repos.saveTriage({
    ticket_id: ticketId,
    sensitive: result.sensitive,
    sensitive_flags: result.flags,
    checker: result.checker,
  });
  await repos.addEvent(ticketId, "sensitive_checked", {
    sensitive: result.sensitive,
    flags: result.flags,
    checker: result.checker,
  });
  log.info("intake-ticket: sensitive checked", {
    ticketId,
    sensitive: result.sensitive,
    flags: result.flags,
  });

  return { ticketId, sensitive: result.sensitive, flags: result.flags };
}

/** Sums per-type counts from the title and description redaction logs. */
function mergeLogs(...logs: Array<Array<{ type: string; count: number }>>) {
  const totals = new Map<string, number>();
  for (const entry of logs.flat())
    totals.set(entry.type, (totals.get(entry.type) ?? 0) + entry.count);
  return [...totals].map(([type, count]) => ({ type, count }));
}

/**
 * Redacts a new ticket and checks it for sensitive topics. Triggered by
 * POST /api/tickets (apps/web) by id "intake-ticket" with `{ ticketId }`.
 * Env is validated at the start of each run.
 */
export const intakeTicket = schemaTask({
  id: INTAKE_TICKET_TASK_ID,
  schema: intakeTicketPayload,
  run: async (payload, { ctx }) =>
    runIntakeTicket(payload, createIntakeDeps(process.env), ctx.attempt.number),
});
