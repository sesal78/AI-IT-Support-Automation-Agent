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
