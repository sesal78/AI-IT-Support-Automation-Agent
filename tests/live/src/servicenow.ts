// Guarded ServiceNow helper for the live suite. It holds the real integration
// password, so it talks to dev420188 only, sends GET everywhere except one
// PATCH (closeIncident, and only on an [E2E] incident), and puts no response
// body, URL or credential into an error (P5-T7).
import { E2E_SERVICENOW_INSTANCE_URL } from "@ai-it-support/shared";
import { z } from "zod";
import type { ServiceNowConfig } from "./config.ts";

/** Prefix every test incident carries in `short_description`. */
export const E2E_PREFIX = "[E2E]";

export type ServiceNowGuardReason =
  "config_missing" | "wrong_instance" | "bad_argument" | "not_e2e_incident";

/** Thrown for every refused call. Names the reason only, never a value. */
export class ServiceNowGuardError extends Error {
  override readonly name = "ServiceNowGuardError";
  readonly reason: ServiceNowGuardReason;
  constructor(reason: ServiceNowGuardReason) {
    super(`ServiceNow guard: ${reason}`);
    this.reason = reason;
  }
}

/** A call that failed after the guard let it through. Names the operation and a status only. */
export class ServiceNowApiError extends Error {
  override readonly name = "ServiceNowApiError";
  readonly operation: string;
  readonly status: number;
  constructor(operation: string, status: number) {
    super(`${operation}: ${status === 0 ? "bad_response" : `status ${status}`}`);
    this.operation = operation;
    this.status = status;
  }
}

const row = z.record(z.string(), z.string());
const envelope = z.object({ result: z.array(row) });

export interface Incident {
  readonly sys_id: string;
  readonly number: string;
  readonly category: string;
  readonly caller_id: string;
  readonly assignment_group: string;
  readonly short_description: string;
  readonly description: string;
  readonly state: string;
  /** The ticket ID the connector copied in; the reconciliation key. */
  readonly correlation_id: string;
  /** The ticket number the connector copied into `correlation_display` (P5-T5c). */
  readonly correlation_display: string;
  /** Display time, `YYYY-MM-DD HH:MM:SS`, for the run-start window (P5-T5c, T5.O.01). */
  readonly sys_created_on: string;
}
export type UserRow = Readonly<Record<string, string>>;

const INCIDENT_FIELDS = [
  "sys_id",
  "number",
  "category",
  "caller_id",
  "assignment_group",
  "short_description",
  "description",
  "state",
  "correlation_id",
  "correlation_display",
  "sys_created_on",
] as const;

/** The most rows one incident read asks for; a full page is reported as truncated. */
export const INCIDENT_PAGE_LIMIT = 1000;

export interface IncidentPage {
  readonly incidents: Incident[];
  /** The instance returned a full page, so more rows may exist. */
  readonly truncated: boolean;
}

export interface E2eServiceNow {
  incidentsByCorrelationId(ticketId: string): Promise<Incident[]>;
  /**
   * Every `[E2E]` incident with a `sys_created_on` at or after `sinceMs`, by a
   * fixed `STARTSWITH` query. `truncated` is true when the page is full, so a
   * caller never treats a partial list as complete (T5.O.01).
   */
  e2eIncidentsSince(sinceMs: number): Promise<IncidentPage>;
  workNotes(sysId: string): Promise<string[]>;
  userByName(name: string): Promise<UserRow | undefined>;
  /** Names of the roles a user holds directly (not inherited), sorted. */
  userRoles(sysId: string): Promise<string[]>;
  groupByName(name: string): Promise<UserRow | undefined>;
  incidentCategories(): Promise<string[]>;
  /** The one write: re-reads the incident and closes it only if it is an [E2E] incident. */
  closeIncident(sysId: string): Promise<void>;
}

type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;

const SYS_ID = /^[0-9a-f]{32}$/;
const TICKET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Plain names only: no `^`, `=`, `,` or control characters that change an encoded query.
const USER_NAME = /^[A-Za-z0-9._-]{1,60}$/;
const GROUP_NAME = /^[A-Za-z0-9 ._&-]{1,80}$/;

/**
 * A time in the display format an encoded query expects, `YYYY-MM-DD HH:MM:SS`
 * in UTC. Only digits, dashes, colons and one space, so it adds no query syntax.
 */
export function serviceNowStamp(ms: number): string {
  if (!Number.isFinite(ms)) throw new ServiceNowGuardError("bad_argument");
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().slice(0, 19).replace("T", " ");
}

function argument(value: string, rule: RegExp): string {
  if (typeof value !== "string" || !rule.test(value))
    throw new ServiceNowGuardError("bad_argument");
  return value;
}

/**
 * Builds the helper. Nothing is checked until a method runs; then a missing
 * variable or any instance URL other than the dev instance is refused before
 * any request. Requests always go to the fixed origin, never to the configured one.
 */
export function createE2eServiceNow(config: ServiceNowConfig, fetchImpl: FetchLike): E2eServiceNow {
  function credentials(): string {
    const { instanceUrl, username, password } = config;
    if (instanceUrl === undefined || username === undefined || password === undefined) {
      throw new ServiceNowGuardError("config_missing");
    }
    if (instanceUrl !== E2E_SERVICENOW_INSTANCE_URL)
      throw new ServiceNowGuardError("wrong_instance");
    return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  }

  async function send(
    operation: string,
    method: "GET" | "PATCH",
    path: string,
    params: Record<string, string>,
    body?: Record<string, string>,
  ): Promise<unknown> {
    const authorization = credentials();
    const url = new URL(`/api/now/table/${path}`, E2E_SERVICENOW_INSTANCE_URL);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    const headers: Record<string, string> = {
      Accept: "application/json",
      Authorization: authorization,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let response: Response;
    try {
      response = await fetchImpl(url, {
        method,
        headers,
        redirect: "manual",
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch {
      throw new ServiceNowApiError(operation, 0);
    }
    if (!response.ok) throw new ServiceNowApiError(operation, response.status);
    try {
      return await response.json();
    } catch {
      throw new ServiceNowApiError(operation, 0);
    }
  }

  async function list(
    operation: string,
    table: string,
    query: string,
    fields: readonly string[],
    limit = 100,
  ): Promise<Array<Record<string, string>>> {
    const json = await send(operation, "GET", table, {
      sysparm_query: query,
      sysparm_fields: fields.join(","),
      sysparm_exclude_reference_link: "true",
      sysparm_limit: String(limit),
    });
    const parsed = envelope.safeParse(json);
    if (!parsed.success) throw new ServiceNowApiError(operation, 0);
    return parsed.data.result;
  }

  async function incident(operation: string, sysId: string): Promise<Incident | undefined> {
    const rows = await list(
      operation,
      "incident",
      `sys_id=${argument(sysId, SYS_ID)}`,
      INCIDENT_FIELDS,
    );
    return rows[0] === undefined ? undefined : toIncident(operation, rows[0]);
  }

  return {
    async incidentsByCorrelationId(ticketId) {
      const rows = await list(
        "incidentsByCorrelationId",
        "incident",
        `correlation_id=${argument(ticketId, TICKET_ID)}`,
        INCIDENT_FIELDS,
      );
      return rows.map((r) => toIncident("incidentsByCorrelationId", r));
    },
    async e2eIncidentsSince(sinceMs) {
      const rows = await list(
        "e2eIncidentsSince",
        "incident",
        `short_descriptionSTARTSWITH${E2E_PREFIX}^sys_created_on>=${serviceNowStamp(sinceMs)}`,
        INCIDENT_FIELDS,
        INCIDENT_PAGE_LIMIT,
      );
      return {
        incidents: rows.map((r) => toIncident("e2eIncidentsSince", r)),
        truncated: rows.length >= INCIDENT_PAGE_LIMIT,
      };
    },
    async workNotes(sysId) {
      const rows = await list(
        "workNotes",
        "sys_journal_field",
        `name=incident^element=work_notes^element_id=${argument(sysId, SYS_ID)}`,
        ["value"],
      );
      return rows.map((r) => r["value"] ?? "");
    },
    async userByName(name) {
      const rows = await list("userByName", "sys_user", `user_name=${argument(name, USER_NAME)}`, [
        "sys_id",
        "user_name",
        "active",
        "locked_out",
        "email",
      ]);
      return rows[0];
    },
    async userRoles(sysId) {
      const rows = await list(
        "userRoles",
        "sys_user_has_role",
        `user=${argument(sysId, SYS_ID)}^inherited=false`,
        ["role.name"],
      );
      return rows.map((r) => r["role.name"] ?? "").sort();
    },
    async groupByName(name) {
      const rows = await list(
        "groupByName",
        "sys_user_group",
        `name=${argument(name, GROUP_NAME)}`,
        ["sys_id", "name"],
      );
      return rows[0];
    },
    async incidentCategories() {
      const rows = await list(
        "incidentCategories",
        "sys_choice",
        "name=incident^element=category^inactive=false",
        ["value"],
      );
      return rows.map((r) => r["value"] ?? "");
    },
    async closeIncident(sysId) {
      const current = await incident("closeIncident", sysId);
      if (current === undefined || !current.short_description.startsWith(E2E_PREFIX)) {
        throw new ServiceNowGuardError("not_e2e_incident");
      }
      await send(
        "closeIncident",
        "PATCH",
        `incident/${current.sys_id}`,
        {},
        {
          state: "7",
          close_code: "Closed/Resolved by Caller",
          close_notes: "Closed by the live test suite.",
        },
      );
    },
  };
}

function toIncident(operation: string, record: Record<string, string>): Incident {
  const out: Record<string, string> = {};
  for (const field of INCIDENT_FIELDS) {
    const value = record[field];
    if (value === undefined) throw new ServiceNowApiError(operation, 0);
    out[field] = value;
  }
  return out as unknown as Incident;
}
