export type HelpdeskErrorCode =
  | "asleep"
  | "auth"
  | "not_found"
  | "bad_request"
  | "rate_limited"
  | "unavailable"
  | "bad_response"
  | "config"
  | "duplicate_external_ref";

const RETRYABLE: readonly HelpdeskErrorCode[] = ["asleep", "rate_limited", "unavailable"];

/** The message names the operation and the code only, never a value. */
export class HelpdeskError extends Error {
  readonly code: HelpdeskErrorCode;
  readonly operation: string;
  readonly retryable: boolean;

  constructor(code: HelpdeskErrorCode, operation: string) {
    super(`helpdesk ${operation} failed: ${code}`);
    this.name = "HelpdeskError";
    this.code = code;
    this.operation = operation;
    this.retryable = RETRYABLE.includes(code);
  }
}

export class InstanceAsleepError extends HelpdeskError {
  constructor(operation: string) {
    super("asleep", operation);
    this.name = "InstanceAsleepError";
  }
}
