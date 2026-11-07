// sysparm_query is never built from data. Field filters are plain parameters,
// each value one percent-encoded parameter; a value that could act as query
// syntax is refused. Messages never repeat the offending value.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SYS_ID = /^[0-9a-f]{32}$/;
const FIELD_NAME = /^[a-z][a-z0-9_]{0,79}$/;
// One address: letters and digits of any script, no ^ = , quotes, spaces or controls.
const LOOKUP_EMAIL = /^[\p{L}\p{N}._+-]{1,64}@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+$/u;
// ^ separates query terms and = ends a field name; controls break headers and lines.
// eslint-disable-next-line no-control-regex
const UNSAFE_VALUE = /[\^=\u0000-\u001f\u007f]/;

export const DEFAULT_LIMIT = 10;
export const MAX_LIMIT = 100;

export interface QueryParams {
  filters?: Readonly<Record<string, string>>;
  fields: readonly string[];
  limit?: number;
}

export function ticketIdParam(id: unknown): string {
  if (typeof id !== "string" || !UUID.test(id)) throw new TypeError("ticketId must be a UUID");
  return id.toLowerCase();
}

export function sysIdParam(id: unknown): string {
  if (typeof id !== "string" || !SYS_ID.test(id)) {
    throw new TypeError("sys_id must be 32 lower-case hex characters");
  }
  return id;
}

export function isLookupSafeEmail(value: unknown): value is string {
  return typeof value === "string" && value.length <= 254 && LOOKUP_EMAIL.test(value);
}

function assertFieldName(name: string): void {
  if (!FIELD_NAME.test(name) || name.startsWith("sysparm_")) {
    throw new TypeError("field name is not allowed");
  }
}

export function buildParams(query: QueryParams): URLSearchParams {
  const params = new URLSearchParams();
  for (const [name, value] of Object.entries(query.filters ?? {})) {
    assertFieldName(name);
    if (typeof value !== "string" || UNSAFE_VALUE.test(value)) {
      throw new TypeError("filter value is not allowed");
    }
    params.set(name, value);
  }
  for (const name of query.fields) assertFieldName(name);
  params.set("sysparm_fields", query.fields.join(","));
  if (query.limit !== undefined) {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > MAX_LIMIT) {
      throw new TypeError(`limit must be a whole number 1-${MAX_LIMIT}`);
    }
    params.set("sysparm_limit", String(query.limit));
  }
  return params;
}

/** The caller lookup (resolved point 8): one active user by email, nothing else from input. */
export function userLookupParams(email: unknown): QueryParams {
  if (!isLookupSafeEmail(email)) throw new TypeError("email is not safe to look up");
  return { filters: { email, active: "true" }, fields: ["sys_id"], limit: 2 };
}
