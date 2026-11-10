/**
 * Thrown by every repository function on a Supabase error or an unexpected
 * response. The message names the operation and the Postgres/PostgREST error
 * code only: never row data, Supabase error text (it can echo input values)
 * or secrets.
 */
export class DbError extends Error {
  readonly operation: string;
  readonly code: string | undefined;

  constructor(operation: string, reason: string, code?: string) {
    super(`${operation} failed: ${reason}`);
    this.name = "DbError";
    this.operation = operation;
    this.code = code;
  }
}

/**
 * Thrown by setTicketStatus when the ticket's status changed between the read
 * and the conditional update, and the new status is not the target status.
 */
export class StatusConflictError extends DbError {
  constructor(operation: string) {
    super(operation, "status changed concurrently");
    this.name = "StatusConflictError";
  }
}

/**
 * Thrown by setTicketHelpdesk when the ticket already lives in a different
 * helpdesk (plan §6.3.1 G2). The message names no helpdesk.
 */
export class HelpdeskConflictError extends DbError {
  constructor(operation: string) {
    super(operation, "ticket already lives in another helpdesk");
    this.name = "HelpdeskConflictError";
  }
}
