import {
  healthConfigSchema,
  internalSecurityEventsSchema,
  internalTicketViewSchema,
  internalUsageSchema,
  type HealthConfig,
  type InternalSecurityEvents,
  type InternalTicketView,
  type InternalUsage,
} from "@ai-it-support/shared";
import { z } from "zod";
import type { LiveConfig } from "./config.ts";

/**
 * Thrown when a response does not have the expected status or does not match
 * its schema. Names the endpoint template (for example
 * `GET /api/internal/tickets/:id`) and the status; never the body.
 */
export class LiveContractError extends Error {
  override readonly name = "LiveContractError";
  readonly endpoint: string;
  readonly status: number;
  constructor(endpoint: string, status: number, problem: "status" | "schema") {
    super(
      problem === "status"
        ? `${endpoint}: unexpected status ${status}`
        : `${endpoint}: response does not match its schema (status ${status})`,
    );
    this.endpoint = endpoint;
    this.status = status;
  }
}

/** Thrown when a request cannot be sent. Carries only the endpoint and the error class. */
export class LiveTransportError extends Error {
  override readonly name = "LiveTransportError";
  readonly endpoint: string;
  constructor(endpoint: string, errorClass: string) {
    super(`${endpoint}: request failed (${errorClass})`);
    this.endpoint = endpoint;
  }
}

export interface SendOptions {
  readonly method?: string;
  /** JSON body. */
  readonly body?: unknown;
  /** Bearer token: the configured one by default, a given (wrong) one, or none (`null`). */
  readonly token?: string | null;
  /** Send the Cloudflare Access headers (default true). */
  readonly access?: boolean;
}

export interface RawResponse {
  readonly status: number;
  readonly contentType: string;
  readonly text: string;
}

export interface InternalClient {
  /** One request to `path` on the E2E origin; redirects are never followed. */
  send(endpoint: string, path: string, options?: SendOptions): Promise<RawResponse>;
  health(): Promise<{ status: "ok"; version: string }>;
  healthConfig(): Promise<HealthConfig>;
  usage(month: string): Promise<InternalUsage>;
  securityEvents(since: Date): Promise<InternalSecurityEvents>;
  ticket(id: string): Promise<InternalTicketView>;
  createTestTicket(body: Record<string, unknown>): Promise<TestTicketCreated>;
}

// No shared schemas exist for these two bodies yet; both mirror apps/web.
const healthSchema = z.strictObject({ status: z.literal("ok"), version: z.string() });
const testTicketCreatedSchema = z.strictObject({
  ticketId: z.uuid(),
  queued: z.boolean(),
  duplicate: z.literal(true).optional(),
});
export type TestTicketCreated = z.infer<typeof testTicketCreatedSchema>;

type FetchLike = (input: URL, init: RequestInit) => Promise<Response>;

/** Class name only; a constructor name is code, never data. */
export function errorClassName(error: unknown): string {
  const name =
    error === null || error === undefined
      ? undefined
      : (error as { constructor?: { name?: unknown } }).constructor?.name;
  return typeof name === "string" && /^[A-Za-z0-9_$]{1,64}$/.test(name) ? name : "Error";
}

/**
 * Client for the e2e app's internal API. Credentials go only to the origin of
 * E2E_BASE_URL: a path that resolves elsewhere is refused before sending, and
 * `redirect: "manual"` means a 30x is returned as-is, never followed.
 */
export function createInternalClient(
  config: LiveConfig,
  options: { fetch?: FetchLike } = {},
): InternalClient {
  const doFetch: FetchLike = options.fetch ?? ((input, init) => fetch(input, init));

  async function send(
    endpoint: string,
    path: string,
    { method = "GET", body, token, access = true }: SendOptions = {},
  ): Promise<RawResponse> {
    const url =
      path.startsWith("/") && !path.startsWith("//") ? new URL(path, config.origin) : null;
    if (url === null || url.origin !== config.origin) {
      throw new LiveTransportError(endpoint, "OriginRefused");
    }
    const headers = new Headers();
    const bearer = token === undefined ? config.internalApiToken : token;
    if (bearer !== null) headers.set("Authorization", `Bearer ${bearer}`);
    if (access) {
      headers.set("CF-Access-Client-Id", config.accessClientId);
      headers.set("CF-Access-Client-Secret", config.accessClientSecret);
    }
    if (body !== undefined) headers.set("Content-Type", "application/json");

    let response: Response;
    let text: string;
    try {
      response = await doFetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "manual",
      });
      text = await response.text();
    } catch (error) {
      // The cause may quote the URL or a header; only its class name survives.
      throw new LiveTransportError(endpoint, errorClassName(error));
    }
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      text,
    };
  }

  async function typed<T>(
    endpoint: string,
    path: string,
    schema: z.ZodType<T>,
    expectStatus: number,
    sendOptions?: SendOptions,
  ): Promise<T> {
    const response = await send(endpoint, path, sendOptions);
    if (response.status !== expectStatus) {
      throw new LiveContractError(endpoint, response.status, "status");
    }
    let json: unknown;
    try {
      json = JSON.parse(response.text);
    } catch {
      throw new LiveContractError(endpoint, response.status, "schema");
    }
    const parsed = schema.safeParse(json);
    if (!parsed.success) throw new LiveContractError(endpoint, response.status, "schema");
    return parsed.data;
  }

  return {
    send,
    health: () => typed("GET /api/health", "/api/health", healthSchema, 200),
    healthConfig: () =>
      typed("GET /api/health/config", "/api/health/config", healthConfigSchema, 200),
    usage: (month) =>
      typed(
        "GET /api/internal/usage",
        `/api/internal/usage?month=${encodeURIComponent(month)}`,
        internalUsageSchema,
        200,
      ),
    securityEvents: (since) =>
      typed(
        "GET /api/internal/security-events",
        `/api/internal/security-events?since=${encodeURIComponent(since.toISOString())}`,
        internalSecurityEventsSchema,
        200,
      ),
    ticket: (id) =>
      typed(
        "GET /api/internal/tickets/:id",
        `/api/internal/tickets/${encodeURIComponent(id)}`,
        internalTicketViewSchema,
        200,
      ),
    createTestTicket: (body) =>
      typed(
        "POST /api/internal/test-tickets",
        "/api/internal/test-tickets",
        testTicketCreatedSchema,
        201,
        { method: "POST", body },
      ),
  };
}
