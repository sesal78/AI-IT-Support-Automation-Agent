import {
  CAP_REACHED_CHECKER,
  classifySensitive,
  createAiRuntime,
  createLangfuseSink,
  createMeter,
  createTypeSafeChecker,
  errorClassName,
  type AlertFn,
  type SensitiveChecker,
} from "@ai-it-support/ai";
import {
  createDbClient,
  createRepositories,
  dbEnvShape,
  type Repositories,
} from "@ai-it-support/db";
import {
  INTAKE_TICKET_TASK_ID,
  TRIAGE_TICKET_TASK_ID,
  aiBudgetEnvShape,
  e2eEnvShape,
  langfuseEnvShape,
  parseEnv,
  redact,
  sensitiveCheckEnvShape,
  testOverridesSchema,
  type IntakeTicketPayload,
  type TriageTicketPayload,
} from "@ai-it-support/shared";
import { AbortTaskRunError, idempotencyKeys, logger, schemaTask, tasks } from "@trigger.dev/sdk";
import { z } from "zod";
import { createPipelineAlert } from "../pipeline-alert.js";
import type { triageTicket } from "./triage-ticket.js";

// Payload type is shared with the POST /api/tickets caller (packages/shared).
export const intakeTicketPayload = z.object({
  ticketId: z.uuid(),
  testOverrides: testOverridesSchema.optional(),
}) satisfies z.ZodType<IntakeTicketPayload>;

export type { IntakeTicketPayload };

export interface IntakeTicketResult {
  ticketId: string;
  sensitive: boolean;
  flags: string[];
}

type LogFn = (message: string, data?: Record<string, unknown>) => void;

/** Enqueues the triage run; `idempotencyKey` is the same for every attempt on a ticket. */
export type TriggerTriageFn = (
  payload: TriageTicketPayload,
  options: { idempotencyKey: string },
) => Promise<unknown>;

export interface IntakeDeps {
  repos: Pick<
    Repositories,
    "getTicket" | "saveRedaction" | "addEvent" | "saveTriage" | "setTicketStatus" | "listEventTypes"
  >;
  /** Metered and traced (provider `typesafe`, kind `sensitive_check`). */
  checker: SensitiveChecker;
  threshold: number;
  alert: AlertFn;
  triggerTriage: TriggerTriageFn;
  logger: { info: LogFn; warn: LogFn; error: LogFn };
}

/** Key material for the triage trigger: the ticket ID only, so every attempt matches. */
export const triageIdempotencyKey = (ticketId: string) => `${TRIAGE_TICKET_TASK_ID}:${ticketId}`;

/**
 * The real trigger. The key gets scope `global`: in @trigger.dev/sdk 4.6.4 a
 * raw string key is hashed with scope `run` (makeIdempotencyKey), which mixes
 * in the intake run ID. Global keeps the key the ticket's alone, so a retried
 * attempt, and a second intake run for the same ticket, get the first triage
 * run back instead of a new one (for the key's TTL, the server default).
 */
export const triggerTriageTask: TriggerTriageFn = async (payload, { idempotencyKey }) =>
  tasks.trigger<typeof triageTicket>(TRIAGE_TICKET_TASK_ID, payload, {
    idempotencyKey: await idempotencyKeys.create(idempotencyKey, { scope: "global" }),
  });

const intakeEnvShape = {
  ...dbEnvShape,
  ...sensitiveCheckEnvShape,
  ...aiBudgetEnvShape,
  ...langfuseEnvShape,
  ...e2eEnvShape,
};

/** Validates env and builds the real deps. Invalid variables throw, naming the variable. */
export function createIntakeDeps(source: Record<string, string | undefined>): IntakeDeps {
  const env = parseEnv(intakeEnvShape, source);
  const repos = createRepositories(createDbClient(source));
  const environment = env.E2E_MODE ? "e2e" : "staging";
  const alert = createPipelineAlert(source, repos);
  const meter = createMeter({
    repos,
    caps: { llm: env.LLM_MONTHLY_CALL_CAP, typesafe: env.TYPESAFE_MONTHLY_CALL_CAP },
    environment,
    alert,
  });
  const runtime = createAiRuntime({
    meter,
    sink: createLangfuseSink(env),
    addEvent: repos.addEvent,
    environment,
  });
  return {
    repos,
    checker: createTypeSafeChecker({ apiKey: env.TYPESAFE_API_KEY, runtime }),
    threshold: env.SENSITIVE_THRESHOLD,
    alert,
    triggerTriage: triggerTriageTask,
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
 *
 * Fail closed: when the TypeSafe budget refuses the check, the triage is
 * saved as sensitive (keyword flags kept, checker `keywords+cap_reached`),
 * and the event and the alert `typesafe_cap_reached` are raised once per
 * ticket, before the trigger (the alert never fails the run). Any other
 * checker error (API, network, answer shape, meter) still throws before any
 * triage row is written.
 *
 * Chaining: the status becomes `redacted` right after the redaction event (a
 * retry finds it already `redacted`, which setTicketStatus accepts). The last
 * step triggers `triage-ticket` with the payload's test switches unchanged
 * and a key built from the ticket ID, so a retried attempt cannot start a
 * second triage run. When the trigger fails: the event triage_enqueue_failed
 * (once per ticket), the status `failed`, the alert triage_enqueue_failed
 * (only with the move to `failed`, so once), then AbortTaskRunError.
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
  await repos.setTicketStatus(ticketId, "redacted");
  log.info("intake-ticket: redacted", { ticketId, attempt, redactions });

  const result = await classifySensitive(
    { title: title.text, description: description.text, ticketId },
    deps.checker,
    deps.threshold,
  );
  const capReached = result.checker === CAP_REACHED_CHECKER;

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
  // Once per ticket: a retry (after a failed enqueue record) skips both.
  if (capReached && !(await hasEvent(deps, ticketId, "typesafe_cap_reached"))) {
    await repos.addEvent(ticketId, "typesafe_cap_reached", { kind: "sensitive_check" });
    await raiseAlert(deps, "typesafe_cap_reached", ticketId);
  }

  await enqueueTriage(payload, deps);
  return { ticketId, sensitive: result.sensitive, flags: result.flags };
}

/** Triggers triage-ticket; a failed trigger marks the ticket failed and aborts the run. */
async function enqueueTriage(payload: IntakeTicketPayload, deps: IntakeDeps): Promise<void> {
  const { ticketId, testOverrides } = payload;
  const { repos, logger: log } = deps;
  try {
    await deps.triggerTriage(
      { ticketId, ...(testOverrides === undefined ? {} : { testOverrides }) },
      { idempotencyKey: triageIdempotencyKey(ticketId) },
    );
  } catch (triggerError) {
    const error = errorClassName(triggerError);
    if (!(await hasEvent(deps, ticketId, "triage_enqueue_failed"))) {
      await repos.addEvent(ticketId, "triage_enqueue_failed", { error });
    }
    const { changed } = await repos.setTicketStatus(ticketId, "failed");
    // Only with the move to `failed`, so once even when a retry gets here again.
    if (changed) await raiseAlert(deps, "triage_enqueue_failed", ticketId);
    log.error("intake-ticket: triage enqueue failed", { ticketId, error });
    throw new AbortTaskRunError(`intake-ticket: could not enqueue triage for ticket ${ticketId}`);
  }
  log.info("intake-ticket: triage enqueued", { ticketId });
}

async function hasEvent(deps: IntakeDeps, ticketId: string, type: string): Promise<boolean> {
  return (await deps.repos.listEventTypes(ticketId, [type])).includes(type);
}

/** The alert must not fail the run, nor hide the outcome it reports. */
async function raiseAlert(
  deps: IntakeDeps,
  kind: "typesafe_cap_reached" | "triage_enqueue_failed",
  ticketId: string,
): Promise<void> {
  try {
    await deps.alert(kind, { ticketId });
  } catch (error) {
    deps.logger.error("intake-ticket: alert failed", { ticketId, error: errorClassName(error) });
  }
}

/** Sums per-type counts from the title and description redaction logs. */
function mergeLogs(...logs: Array<Array<{ type: string; count: number }>>) {
  const totals = new Map<string, number>();
  for (const entry of logs.flat())
    totals.set(entry.type, (totals.get(entry.type) ?? 0) + entry.count);
  return [...totals].map(([type, count]) => ({ type, count }));
}

/**
 * Redacts a new ticket, checks it for sensitive topics and triggers its
 * triage. Triggered by POST /api/tickets (apps/web) by id "intake-ticket"
 * with `{ ticketId }` (plus `testOverrides` from the E2E test route).
 * Env is validated at the start of each run.
 */
export const intakeTicket = schemaTask({
  id: INTAKE_TICKET_TASK_ID,
  schema: intakeTicketPayload,
  run: async (payload, { ctx }) =>
    runIntakeTicket(payload, createIntakeDeps(process.env), ctx.attempt.number),
});
