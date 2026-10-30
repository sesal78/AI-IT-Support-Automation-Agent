/** Alert kinds raised by phases 3 and 4. */
export type AlertKind =
  | "slack_update_failed"
  | "llm_cap_80"
  | "typesafe_cap_80"
  | "typesafe_cap_reached"
  | "llm_unavailable"
  | "triage_failed"
  | "triage_enqueue_failed";

export interface AlertOptions {
  ticketId?: string | undefined;
}

export interface AlertLogger {
  error(message: string): void;
}

export interface AlertSinkDeps {
  /** The `recordSecurityEvent` repository function (packages/db), passed in. */
  recordSecurityEvent(
    source: string,
    kind: string,
    sample: Record<string, unknown>,
  ): Promise<unknown>;
  logger: AlertLogger;
  /**
   * Optional delivery of the alert line (phase 4: a Slack post). Called only
   * for the first alert of its (kind, minute) window, the recorder returning
   * 1, or when recording failed (then the post is the only record).
   */
  postAlert?: ((line: string) => Promise<unknown>) | undefined;
  /** Appended to the posted line as ` (<environment>)`. */
  environment?: "e2e" | "staging" | undefined;
}

export type AlertFn = (kind: AlertKind, options?: AlertOptions) => Promise<void>;

/**
 * An alert is a `pipeline` / `alert:<kind>` security event plus one error log
 * line, and, with `postAlert`, one posted line `alert <kind>[ ticket <id>][
 * (<environment>)]`. The returned function never throws: a failed record or
 * post is logged by error class name only (the message of a database or
 * Slack error can echo input), and a failing logger is ignored.
 */
export function createAlertSink(deps: AlertSinkDeps): AlertFn {
  return async (kind, options = {}) => {
    const sample = options.ticketId === undefined ? {} : { ticketId: options.ticketId };
    const base = `alert ${kind}${options.ticketId === undefined ? "" : ` ticket ${options.ticketId}`}`;
    let line = base;
    let count: unknown;
    let recorded = true;
    try {
      count = await deps.recordSecurityEvent("pipeline", `alert:${kind}`, sample);
    } catch (error) {
      recorded = false;
      line += ` (recording failed: ${className(error)})`;
    }
    if (deps.postAlert !== undefined && (!recorded || count === 1)) {
      const env = deps.environment === undefined ? "" : ` (${deps.environment})`;
      try {
        await deps.postAlert(base + env);
      } catch (error) {
        line += ` (post failed: ${className(error)})`;
      }
    }
    try {
      deps.logger.error(line);
    } catch {
      // An alert must never throw, even when logging fails.
    }
  };
}

const className = (error: unknown) => (error instanceof Error ? error.name : typeof error);
