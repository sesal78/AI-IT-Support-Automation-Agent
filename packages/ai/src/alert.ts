/** Alert kinds raised by phase 3. Delivery to Slack comes in phases 4 and 7. */
export type AlertKind =
  "llm_cap_80" | "typesafe_cap_80" | "typesafe_cap_reached" | "llm_unavailable";

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
}

export type AlertFn = (kind: AlertKind, options?: AlertOptions) => Promise<void>;

/**
 * An alert in phase 3 is a `pipeline` / `alert:<kind>` security event plus one
 * error log line. The returned function never throws: a failed record is
 * logged by error class name only (the message of a database error can echo
 * input), and a failing logger is ignored.
 */
export function createAlertSink(deps: AlertSinkDeps): AlertFn {
  return async (kind, options = {}) => {
    const sample = options.ticketId === undefined ? {} : { ticketId: options.ticketId };
    let line = `alert ${kind}${options.ticketId === undefined ? "" : ` ticket ${options.ticketId}`}`;
    try {
      await deps.recordSecurityEvent("pipeline", `alert:${kind}`, sample);
    } catch (error) {
      const name = error instanceof Error ? error.name : typeof error;
      line += ` (recording failed: ${name})`;
    }
    try {
      deps.logger.error(line);
    } catch {
      // An alert must never throw, even when logging fails.
    }
  };
}
