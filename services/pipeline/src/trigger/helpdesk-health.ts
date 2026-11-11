import { errorClassName, type AlertFn } from "@ai-it-support/ai";
import { createDbClient, createRepositories } from "@ai-it-support/db";
import {
  HelpdeskError,
  ServiceNowConnector,
  createServiceNowClient,
  selectHelpdeskConnector,
  type HelpdeskConnector,
} from "@ai-it-support/helpdesk";
import {
  HELPDESK_HEALTH_TASK_ID,
  helpdeskEnvShape,
  helpdeskHealthOutputSchema,
  parseHelpdeskEnv,
  type HelpdeskHealthOutput,
} from "@ai-it-support/shared";
import { logger, schedules } from "@trigger.dev/sdk";
import { createFailureAlert } from "../pipeline-alert.js";

export type { HelpdeskHealthOutput };

type LogFn = (message: string, data?: Record<string, unknown>) => void;

export interface HelpdeskHealthDeps {
  /** The chosen connector's name for the output; `unknown` when HELPDESK is not valid. */
  helpdesk: HelpdeskHealthOutput["connector"];
  /**
   * Builds the connector. Called inside the run, so a missing or invalid
   * HELPDESK or ServiceNow setting counts as `down` and raises an alert, like
   * any other health failure.
   */
  createConnector: () => HelpdeskConnector;
  /** Epoch ms. Replaced in tests. */
  now: () => number;
  /** Never throws (createAlertSink); a throwing replacement is still caught. */
  alert: AlertFn;
  logger: { error: LogFn };
}

const ALERT_FOR = { asleep: "helpdesk_asleep", down: "helpdesk_down" } as const;
const statusSchema = helpdeskHealthOutputSchema.shape.status;

/**
 * The task body, exported so tests can call it without the Trigger.dev
 * runtime. It asks the connector for its health once and returns
 * `{ connector, status, checkedAt }`, where `connector` is the one `HELPDESK`
 * chose (the built-in helpdesk is `ok` or `down`, never `asleep`). `asleep` raises
 * `alert:helpdesk_asleep` and `down` raises `alert:helpdesk_down`; the alert
 * sink counts them per minute (phase 3 resolved point 7). A health call that
 * throws, a connector that cannot be built, and a status that is not
 * `ok`/`asleep`/`down` all count as `down`. The run never fails: errors are
 * logged by class name only (a message can echo a host or a value) and an
 * alert that throws is logged and ignored.
 */
export async function runHelpdeskHealth(deps: HelpdeskHealthDeps): Promise<HelpdeskHealthOutput> {
  const checkedAt = new Date(deps.now()).toISOString();
  let status: HelpdeskHealthOutput["status"] = "down";
  try {
    const answer = await deps.createConnector().health();
    const parsed = statusSchema.safeParse((answer as { status?: unknown } | null)?.status);
    if (parsed.success) status = parsed.data;
  } catch (error) {
    deps.logger.error("helpdesk-health: health call failed", { error: errorClassName(error) });
  }
  if (status !== "ok") {
    try {
      await deps.alert(ALERT_FOR[status]);
    } catch (error) {
      deps.logger.error("helpdesk-health: alert failed", { error: errorClassName(error) });
    }
  }
  return { connector: deps.helpdesk, status, checkedAt };
}

/** The configured helpdesk, or `unknown`: only a fixed word reaches the output. */
function configuredHelpdesk(
  source: Record<string, string | undefined>,
): HelpdeskHealthOutput["connector"] {
  const parsed = helpdeskEnvShape.HELPDESK.safeParse(source.HELPDESK);
  return parsed.success ? parsed.data : "unknown";
}

/**
 * The database (for the alert record) and the alert sink are built now; the
 * connector is built when the run asks for it. Invalid database variables
 * throw here, naming the variable.
 */
export function createHelpdeskHealthDeps(
  source: Record<string, string | undefined>,
): HelpdeskHealthDeps {
  const repos = createRepositories(createDbClient(source));
  return {
    helpdesk: configuredHelpdesk(source),
    createConnector: () => {
      const env = parseHelpdeskEnv(source);
      return selectHelpdeskConnector(env, {
        store: repos,
        serviceNow: () => {
          if (env.HELPDESK !== "servicenow") throw new HelpdeskError("config", "select");
          return new ServiceNowConnector({
            client: createServiceNowClient({
              instanceUrl: env.SERVICENOW_INSTANCE_URL,
              username: env.SERVICENOW_USERNAME,
              password: env.SERVICENOW_PASSWORD,
            }),
            defaultCaller: env.SERVICENOW_DEFAULT_CALLER,
          });
        },
      });
    },
    now: () => Date.now(),
    alert: createFailureAlert("helpdesk-health", source, repos),
    logger,
  };
}

/**
 * What the scheduled run does. When the deps cannot be built (the database
 * variables are wrong, so there is no way to record an alert) the run still
 * resolves with `down` and logs the error class name.
 */
export async function runHelpdeskHealthTask(
  source: Record<string, string | undefined> = process.env,
  log: { error: LogFn } = logger,
  now: () => number = () => Date.now(),
): Promise<HelpdeskHealthOutput> {
  let deps: HelpdeskHealthDeps;
  try {
    deps = createHelpdeskHealthDeps(source);
  } catch (error) {
    log.error("helpdesk-health: could not build the deps", { error: errorClassName(error) });
    return {
      connector: configuredHelpdesk(source),
      status: "down",
      checkedAt: new Date(now()).toISOString(),
    };
  }
  return runHelpdeskHealth({ ...deps, logger: log, now });
}

/**
 * Task options, exported so a test can assert the wiring. A cron declared in
 * code is registered on deploy. No `retry`: a failed check is reported in the
 * output, and the next run is 30 minutes away.
 */
export const helpdeskHealthOptions = {
  id: HELPDESK_HEALTH_TASK_ID,
  cron: "*/30 * * * *",
  run: () => runHelpdeskHealthTask(),
};

export const helpdeskHealth = schedules.task(helpdeskHealthOptions);
