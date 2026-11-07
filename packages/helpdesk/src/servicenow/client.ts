import { HelpdeskError, InstanceAsleepError } from "../errors.js";
import { isHibernationPage, isHibernationRedirect } from "./hibernation.js";
import { DEFAULT_LIMIT, buildParams, sysIdParam, type QueryParams } from "./query.js";

export const DEFAULT_TIMEOUT_MS = 15_000;
const TABLE = /^[a-z][a-z0-9_]{0,79}$/;
const HOSTNAME = /\.service-now\.com$/;
const TABLE_PREFIX = "/api/now/table/";

export interface ServiceNowClientOptions {
  instanceUrl: string;
  username: string;
  password: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export interface ServiceNowClient {
  get(table: string, query: QueryParams): Promise<unknown>;
  post(table: string, body: Record<string, unknown>, fields: readonly string[]): Promise<unknown>;
  patch(table: string, sysId: string, body: Record<string, unknown>): Promise<unknown>;
}

/** The instance URL is fixed: https, a service-now.com host, no port, path or credentials. */
function instanceOrigin(instanceUrl: string): string {
  let url: URL;
  try {
    url = new URL(instanceUrl);
  } catch {
    throw new HelpdeskError("config", "create client");
  }
  const fixed =
    url.origin === instanceUrl &&
    url.protocol === "https:" &&
    HOSTNAME.test(url.hostname) &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.pathname === "/" &&
    url.search === "" &&
    url.hash === "";
  if (!fixed) throw new HelpdeskError("config", "create client");
  return url.origin;
}

function tablePath(table: string): string {
  if (!TABLE.test(table)) throw new TypeError("table name is not allowed");
  return `${TABLE_PREFIX}${table}`;
}

function statusError(status: number, operation: string): HelpdeskError {
  if (status === 401 || status === 403) return new HelpdeskError("auth", operation);
  if (status === 404) return new HelpdeskError("not_found", operation);
  if (status === 429) return new HelpdeskError("rate_limited", operation);
  if (status >= 500) return new HelpdeskError("unavailable", operation);
  return new HelpdeskError("bad_request", operation);
}

export function createServiceNowClient(options: ServiceNowClientOptions): ServiceNowClient {
  const origin = instanceOrigin(options.instanceUrl);
  const { username, password } = options;
  if (username === "" || username.includes(":") || password === "") {
    throw new HelpdeskError("config", "create client");
  }
  const authorization = `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
  const doFetch = options.fetch ?? fetch;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  async function exchange(
    operation: string,
    method: string,
    url: string,
    body: Record<string, unknown> | undefined,
    signal: AbortSignal,
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Authorization: authorization,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    let status: number;
    let location: string | null;
    let text: string;
    try {
      const response = await doFetch(url, {
        method,
        headers,
        redirect: "manual",
        signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      status = response.status;
      location = response.headers.get("location");
      text = status >= 200 && status < 300 ? await response.text() : "";
    } catch {
      // The cause is dropped on purpose: it can carry request details.
      throw new HelpdeskError("unavailable", operation);
    }
    if (status >= 300 && status < 400) {
      if (isHibernationRedirect(location, origin)) throw new InstanceAsleepError(operation);
      throw new HelpdeskError("bad_response", operation);
    }
    if (status < 200 || status >= 300) throw statusError(status, operation);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      if (isHibernationPage(text)) throw new InstanceAsleepError(operation);
      throw new HelpdeskError("bad_response", operation);
    }
    if (typeof parsed !== "object" || parsed === null || !("result" in parsed)) {
      throw new HelpdeskError("bad_response", operation);
    }
    return (parsed as { result: unknown }).result;
  }

  async function request(
    method: string,
    path: string,
    params: URLSearchParams,
    body?: Record<string, unknown>,
  ): Promise<unknown> {
    const operation = `${method} ${path.slice(TABLE_PREFIX.length)}`;
    const query = params.toString();
    const url = `${origin}${path}${query === "" ? "" : `?${query}`}`;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new HelpdeskError("unavailable", operation));
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        exchange(operation, method, url, body, controller.signal),
        timeout,
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    get: async (table, query) =>
      request("GET", tablePath(table), buildParams({ limit: DEFAULT_LIMIT, ...query })),
    post: async (table, body, fields) =>
      request("POST", tablePath(table), buildParams({ fields }), body),
    patch: async (table, sysId, body) =>
      request("PATCH", `${tablePath(table)}/${sysIdParam(sysId)}`, new URLSearchParams(), body),
  };
}
