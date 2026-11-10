import { errorClassName, type AlertFn } from "@ai-it-support/ai";
import {
  IncidentConflictError,
  createDbClient,
  createRepositories,
  dbEnvShape,
  type Repositories,
} from "@ai-it-support/db";
import {
  HelpdeskError,
  InstanceAsleepError,
  ServiceNowConnector,
  createServiceNowClient,
  shadowEnabled,
  withShadowMode,
  type HelpdeskConnector,
  type HelpdeskTicketRef,
} from "@ai-it-support/helpdesk";
import {
  HELPDESK_SYNC_TASK_ID,
  e2eEnvShape,
  effectiveTestOverrides,
  parseEnv,
  phase1EnvShape,
  serviceNowEnvShape,
  testOverridesSchema,
  type HelpdeskSyncPayload,
} from "@ai-it-support/shared";
import { AbortTaskRunError, logger, schemaTask, wait } from "@trigger.dev/sdk";
import { z } from "zod";
import { asleepUntil, withAsleepSwitch } from "../helpdesk/asleep-switch.js";
import { checkSync } from "../helpdesk/sync-guard.js";
import { buildSyncNote } from "../helpdesk/sync-note.js";
import { createFailureAlert, createPipelineAlert } from "../pipeline-alert.js";

// Payload type is shared with the caller that triggers it (packages/shared).
export const helpdeskSyncPayload = z.object({
  ticketId: z.uuid(),
  testOverrides: testOverridesSchema.optional(),
}) satisfies z.ZodType<HelpdeskSyncPayload>;

export type { HelpdeskSyncPayload };

export type HelpdeskSyncResult =
  | { ticketId: string; refused: true }
  | { ticketId: string; skipped: true }
  | { ticketId: string; shadow: true }
  | { ticketId: string; failed: true; error: string }
  | { ticketId: string; incident: HelpdeskTicketRef };

type LogFn = (message: string, data?: Record<string, unknown>) => void;

export interface HelpdeskSyncDeps {
  repos: Pick<
    Repositories,
    | "getTicket"
    | "getTriage"
    | "getRedaction"
    | "getKbArticlesByIds"
    | "setTicketStatus"
    | "setTicketIncident"
    | "listEventTypes"
    | "addEvent"
  >;
  /**
   * Builds the real connector. Called inside the run, so a config error is
   * handled like any other helpdesk error (`alert:helpdesk_config`).
   */
  createConnector: () => HelpdeskConnector;
  /** The Trigger.dev wait; replaced in tests. Checkpointed, not compute time. */
  wait: { for(options: { minutes: number }): Promise<void> };
  /** Epoch ms. Replaced in tests. */
  now: () => number;
  /** SHADOW_MODE. */
  shadowMode: boolean;
  /** E2E_MODE: test switches take effect only with it AND the ticket's is_test. */
  e2eMode: boolean;
  /** Never throws (createAlertSink). */
  alert: AlertFn;
  logger: { info: LogFn; warn: LogFn; error: LogFn };
}

/** Events written once across retries and attempts. */
const ONCE_EVENTS = [
  "helpdesk_sync_started",
  "caller_defaulted",
  "incident_created",
  "helpdesk_note_added",
  "shadow_skipped",
  "helpdesk_sync_failed",
];

/** Resolved point 9: waits between tries while the instance sleeps, then 60 minutes each. */
const ASLEEP_WAIT_MINUTES = [1, 2, 4, 8, 15, 30];
const ASLEEP_LIMIT_MS = 6 * 60 * 60_000;
const asleepWaitMinutes = (tries: number): number => ASLEEP_WAIT_MINUTES[tries - 1] ?? 60;

const fixStepsSchema = z.object({ steps: z.array(z.string()), caveats: z.array(z.string()) });

type FailureAlert =
  "helpdesk_auth_failed" | "helpdesk_config" | "helpdesk_sync_failed" | "helpdesk_asleep_timeout";

/** How a non-retryable error is reported: the event `error` value and the alert kind. */
function classify(error: unknown): { code: string; alert: FailureAlert } | null {
  if (error instanceof IncidentConflictError) {
    return { code: "conflict", alert: "helpdesk_sync_failed" };
  }
  if (!(error instanceof HelpdeskError) || error.retryable) return null;
  if (error.code === "auth") return { code: error.code, alert: "helpdesk_auth_failed" };
  if (error.code === "config" || error.code === "bad_request") {
    return { code: error.code, alert: "helpdesk_config" };
  }
  return { code: error.code, alert: "helpdesk_sync_failed" };
}

/**
 * The task body, exported so tests can call it without the Trigger.dev runtime.
 *
 * Order: load the ticket; the sync guard (`refuse`: event `sync_refused`, alert,
 * no connector; `done`: skip); the triage row and the redaction; status
 * `helpdesk_pending` and `helpdesk_sync_started`; the connector (shadow mode
 * wraps it); `findByExternalRef`, else `createTicket`. A `ShadowSkip` ends in
 * `incident_skipped_shadow`. Otherwise the incident is stored
 * (`setTicketIncident`), then `caller_defaulted` (when flagged),
 * `incident_created`, the triage work note, `helpdesk_note_added`, and the
 * status `incident_created`.
 *
 * Every event is written once: a retried attempt reads the event types first.
 * `InstanceAsleepError` writes `helpdesk_asleep { attempt }`, keeps
 * `helpdesk_pending` and waits 1, 2, 4, 8, 15, 30, then 60 minutes between
 * tries, until 6 hours after the first asleep answer; then `helpdesk_sync_failed
 * { error: "asleep" }`, `failed` and `alert:helpdesk_asleep_timeout`. The
 * `helpdeskAsleepMinutes` switch (e2e test ticket only) makes the connector
 * act asleep until that many minutes after `created_at`.
 * Other retryable errors (`unavailable`, `rate_limited`) and unknown errors are
 * thrown, so the task retries. Every other error ends the ticket in `failed`
 * with `helpdesk_sync_failed` and an alert, and the run returns.
 *
 * Privacy: only redacted text, enums, IDs and the incident number leave the
 * task. The requester email goes to the connector's create input only.
 */
export async function runHelpdeskSync(
  payload: HelpdeskSyncPayload,
  deps: HelpdeskSyncDeps,
  attempt = 1,
): Promise<HelpdeskSyncResult> {
  const { ticketId } = payload;
  const { repos, logger: log } = deps;

  const ticket = await repos.getTicket(ticketId);
  if (!ticket) throw new AbortTaskRunError(`helpdesk-sync: ticket ${ticketId} not found`);
  const decision = checkSync(ticket.status);
  if (decision === "refuse") {
    await repos.addEvent(ticketId, "sync_refused", { status: ticket.status });
    await deps.alert("sync_refused", { ticketId });
    log.warn("helpdesk-sync: refused", { ticketId, status: ticket.status });
    return { ticketId, refused: true };
  }
  if (decision === "done") {
    log.info("helpdesk-sync: skipped", { ticketId, status: ticket.status });
    return { ticketId, skipped: true };
  }

  const triage = await repos.getTriage(ticketId);
  if (!triage || triage.category === null || triage.priority === null) {
    throw new AbortTaskRunError(`helpdesk-sync: ticket ${ticketId} has no triage result`);
  }
  const { category, priority } = triage;
  const redaction = await repos.getRedaction(ticketId);
  if (!redaction) throw new AbortTaskRunError(`helpdesk-sync: ticket ${ticketId} has no redaction`);

  if (ticket.status !== "helpdesk_pending")
    await repos.setTicketStatus(ticketId, "helpdesk_pending");
  const written = new Set(await repos.listEventTypes(ticketId, ONCE_EVENTS));
  const once = async (type: string, data: Record<string, unknown> = {}): Promise<void> => {
    if (written.has(type)) return;
    await repos.addEvent(ticketId, type, data);
    written.add(type);
  };
  await once("helpdesk_sync_started");
  log.info("helpdesk-sync: started", { ticketId, attempt });

  const overrides = effectiveTestOverrides({
    e2eMode: deps.e2eMode,
    isTest: ticket.is_test,
    requested: payload.testOverrides,
  });

  const fail = async (code: string, alert: FailureAlert): Promise<HelpdeskSyncResult> => {
    await once("helpdesk_sync_failed", { error: code });
    await repos.setTicketStatus(ticketId, "failed");
    await deps.alert(alert, { ticketId });
    log.error("helpdesk-sync: failed", { ticketId, attempt, error: code });
    return { ticketId, failed: true, error: code };
  };

  const sync = async (): Promise<HelpdeskSyncResult> => {
    let inner = deps.createConnector();
    if (overrides.helpdeskAsleepMinutes !== undefined) {
      inner = withAsleepSwitch(inner, {
        asleepUntil: asleepUntil(ticket.created_at, overrides.helpdeskAsleepMinutes),
        now: deps.now,
      });
    }
    const connector = withShadowMode(inner, {
      enabled: shadowEnabled({ env: { SHADOW_MODE: deps.shadowMode }, overrides }),
      log: (event, fields) => log.info(`helpdesk-sync: ${event}`, { ticketId, ...fields }),
    });
    let ref = await connector.findByExternalRef(ticketId);
    let callerDefaulted = false;
    if (ref === null) {
      const created = await connector.createTicket({
        ticketId,
        ticketNumber: ticket.ticket_number,
        isTest: ticket.is_test,
        redactedTitle: redaction.redacted_title,
        redactedDescription: redaction.redacted_description,
        category,
        priority,
        assignmentGroup: triage.assignment_group,
        requesterEmail: ticket.requester_email,
      });
      if ("skipped" in created) {
        await once("shadow_skipped", { operation: "create" });
        await repos.setTicketStatus(ticketId, "incident_skipped_shadow");
        return { ticketId, shadow: true };
      }
      ref = { externalId: created.externalId, number: created.number };
      callerDefaulted = created.callerDefaulted;
    }

    await repos.setTicketIncident(ticketId, { sysId: ref.externalId, number: ref.number });
    if (callerDefaulted) await once("caller_defaulted");
    await once("incident_created", { externalId: ref.externalId, number: ref.number });
    if (!written.has("helpdesk_note_added")) {
      const skipped = await connector.addNote(ref, await note());
      if (skipped === undefined) await once("helpdesk_note_added", { externalId: ref.externalId });
    }
    await repos.setTicketStatus(ticketId, "incident_created");
    log.info("helpdesk-sync: incident created", { ticketId, attempt });
    return { ticketId, incident: ref };
  };

  const note = async (): Promise<string> => {
    const articles = await repos.getKbArticlesByIds(triage.kb_article_ids ?? []);
    const fix =
      triage.suggested_fix === null ? null : fixStepsSchema.safeParse(triage.suggested_fix);
    if (fix !== null && !fix.success) {
      throw new Error("helpdesk-sync: the saved fix steps have an unexpected shape");
    }
    return buildSyncNote({
      ticketNumber: ticket.ticket_number,
      category,
      priority,
      assignmentGroup: triage.assignment_group,
      kbSlugs: articles.map((article) => article.slug),
      fixSteps: fix === null ? null : fix.data,
    });
  };

  let asleepTries = 0;
  let firstAsleep = 0;
  for (;;) {
    try {
      return await sync();
    } catch (error) {
      if (error instanceof InstanceAsleepError) {
        asleepTries += 1;
        if (asleepTries === 1) firstAsleep = deps.now();
        await repos.addEvent(ticketId, "helpdesk_asleep", { attempt: asleepTries });
        if (deps.now() - firstAsleep >= ASLEEP_LIMIT_MS) {
          return await fail("asleep", "helpdesk_asleep_timeout");
        }
        const minutes = asleepWaitMinutes(asleepTries);
        log.info("helpdesk-sync: instance asleep, waiting", {
          ticketId,
          attempt,
          asleepTries,
          minutes,
        });
        await deps.wait.for({ minutes });
        continue;
      }
      const failure = classify(error);
      if (failure === null) {
        log.warn("helpdesk-sync: attempt failed", {
          ticketId,
          attempt,
          error: errorClassName(error),
        });
        throw error;
      }
      return await fail(failure.code, failure.alert);
    }
  }
}

const helpdeskSyncDepsEnvShape = {
  ...dbEnvShape,
  ...serviceNowEnvShape,
  ...e2eEnvShape,
  // Unset means `true`: shadow mode is the safe default.
  SHADOW_MODE: phase1EnvShape.SHADOW_MODE,
};

/** Validates env and builds the real deps. Invalid variables throw, naming the variable. */
export function createHelpdeskSyncDeps(
  source: Record<string, string | undefined>,
): HelpdeskSyncDeps {
  const env = parseEnv(helpdeskSyncDepsEnvShape, source);
  const repos = createRepositories(createDbClient(source));
  return {
    repos,
    createConnector: () =>
      new ServiceNowConnector({
        client: createServiceNowClient({
          instanceUrl: env.SERVICENOW_INSTANCE_URL,
          username: env.SERVICENOW_USERNAME,
          password: env.SERVICENOW_PASSWORD,
        }),
        defaultCaller: env.SERVICENOW_DEFAULT_CALLER,
      }),
    wait: { for: (options) => wait.for(options) },
    now: () => Date.now(),
    shadowMode: env.SHADOW_MODE,
    e2eMode: env.E2E_MODE,
    alert: createPipelineAlert(source, repos),
    logger,
  };
}

export interface HelpdeskSyncFailureDeps {
  repos: Pick<Repositories, "getTicket" | "addEvent" | "listEventTypes" | "setTicketStatus">;
  alert: AlertFn;
  logger: { info: LogFn; warn: LogFn; error: LogFn };
}

/** The database and the alert sink only: the run may have failed on any other variable. */
export function createHelpdeskSyncFailureDeps(
  source: Record<string, string | undefined>,
  repos: HelpdeskSyncFailureDeps["repos"] &
    Pick<Repositories, "recordSecurityEvent"> = createRepositories(createDbClient(source)),
): HelpdeskSyncFailureDeps {
  return { repos, alert: createFailureAlert("helpdesk-sync", source, repos), logger };
}

/**
 * The task's `onFailure` hook, called once after the last attempt failed. For
 * a ticket the sync still owns (`auto`, `approved`, `helpdesk_pending`) it
 * records `helpdesk_sync_failed { error }` (a HelpdeskError code or the error
 * class name), sets `failed` and raises `alert:helpdesk_sync_failed`. Any other
 * ticket, finished, refused or failed, is left unchanged. It never throws; a
 * failure here (the database is down) is logged by class name only.
 */
export async function onHelpdeskSyncFailure(
  params: { payload: unknown; error: unknown },
  deps?: HelpdeskSyncFailureDeps,
): Promise<void> {
  const error =
    params.error instanceof HelpdeskError ? params.error.code : errorClassName(params.error);
  const log = deps?.logger ?? logger;
  const safeLog = (message: string, data: object) => {
    try {
      log.error(message, { ...data });
    } catch {
      // The hook must not throw, even when logging fails.
    }
  };
  try {
    const parsed = helpdeskSyncPayload.safeParse(params.payload);
    if (!parsed.success) {
      safeLog("helpdesk-sync: failed run without a valid ticket id", { error });
      return;
    }
    const { ticketId } = parsed.data;
    const { repos, alert } = deps ?? createHelpdeskSyncFailureDeps(process.env);
    const ticket = await repos.getTicket(ticketId);
    if (!ticket || checkSync(ticket.status) !== "run") {
      safeLog("helpdesk-sync: failed run, ticket unchanged", { ticketId, error });
      return;
    }
    const written = await repos.listEventTypes(ticketId, ["helpdesk_sync_failed"]);
    if (!written.includes("helpdesk_sync_failed")) {
      await repos.addEvent(ticketId, "helpdesk_sync_failed", { error });
    }
    await repos.setTicketStatus(ticketId, "failed");
    await alert("helpdesk_sync_failed", { ticketId });
    safeLog("helpdesk-sync: failed", { ticketId, error });
  } catch (hookError) {
    safeLog("helpdesk-sync: could not record the failure", {
      error,
      cause: errorClassName(hookError),
    });
  }
}

/**
 * Task options, exported so a test can assert the wiring. Creates the
 * ServiceNow incident for an `auto` or `approved` ticket. Three attempts with
 * exponential backoff; env is validated at the start of each run.
 */
export const helpdeskSyncOptions = {
  id: HELPDESK_SYNC_TASK_ID,
  schema: helpdeskSyncPayload,
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 1000,
    maxTimeoutInMs: 10_000,
    randomize: true,
  },
  run: async (payload: HelpdeskSyncPayload, { ctx }: { ctx: { attempt: { number: number } } }) =>
    runHelpdeskSync(payload, createHelpdeskSyncDeps(process.env), ctx.attempt.number),
  onFailure: onHelpdeskSyncFailure,
};

export const helpdeskSync = schemaTask(helpdeskSyncOptions);
