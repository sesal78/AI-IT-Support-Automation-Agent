import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** What the mock saw of one request. Header values are compared, never stored. */
export interface MockRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly accessOk: boolean;
  /** Either Access header was present, right or wrong. */
  readonly hasAccessHeaders: boolean;
  readonly bearerOk: boolean;
  readonly hasBearer: boolean;
  /** Any Authorization header was present. */
  readonly hasAuthorization: boolean;
  readonly body: string;
}

export interface MockReply {
  readonly status: number;
  readonly json?: unknown;
  readonly text?: string;
  readonly contentType?: string;
  readonly headers?: Record<string, string>;
}

/**
 * How refused internal requests become security events: one row per
 * (source, kind, minute) with a count, like the app (`per-minute`), one row
 * per refusal (`per-request`), or none at all (`none`).
 */
export type MockSecurityEvents = "per-minute" | "per-request" | "none";

export interface MockE2eOptions {
  readonly token: string;
  readonly accessClientId: string;
  readonly accessClientSecret: string;
  /** Runs before the Access gate; a reply short-circuits the default routes. */
  readonly override?: (request: MockRequest) => MockReply | undefined;
  /** Default `per-minute`. */
  readonly securityEvents?: MockSecurityEvents;
  /** Clock for security-event windows. Default `Date.now`. */
  readonly now?: () => number;
  /** Delay before each reply, so concurrency shows in `peakInFlight`. */
  readonly delayMs?: number;
  /** Call counts the usage endpoint reports (default 0 and 0). */
  readonly usage?: () => { readonly llm: number; readonly typesafe: number };
  /**
   * Status and triage of a created test ticket's view, by `testId` and the
   * number of times the view was read (1 for the first read). Default: `new`, no triage.
   */
  readonly ticketView?: (testId: string, reads: number) => MockTicketView | undefined;
}

export interface MockTicketView {
  readonly status: string;
  readonly triage: unknown;
}

/** A ticket made through POST /api/internal/test-tickets, keyed by its `testId`. */
export interface MockTestTicket {
  readonly testId: string;
  readonly ticketId: string;
  readonly body: Record<string, unknown>;
  reads: number;
  /** True once a view with the status `failed` or with a triage was served. */
  finished: boolean;
}

export interface MockE2e {
  /** `http://127.0.0.1:<port>` */
  readonly origin: string;
  readonly requests: MockRequest[];
  /** Most requests the mock was handling at one time. */
  readonly peakInFlight: number;
  /** Test tickets by `testId`; a repeated `testId` is a duplicate, not a new ticket. */
  readonly testTickets: Map<string, MockTestTicket>;
  /** Most test tickets that were created and not yet finished at one time. */
  readonly maxOpenTickets: () => number;
  close(): Promise<void>;
}

interface StoredEvent {
  source: string;
  kind: string;
  windowStart: string;
  count: number;
}

const TICKET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MINUTE_MS = 60_000;

/** Cloudflare Access answers an unauthenticated request with an HTML page, not JSON. */
const ACCESS_DENIED: MockReply = {
  status: 403,
  text: "<!DOCTYPE html><html><body><h1>Forbidden</h1><p>Cloudflare Access</p></body></html>",
  contentType: "text/html; charset=utf-8",
};
const NOT_FOUND: MockReply = {
  status: 404,
  text: "<!DOCTYPE html><html><body><h1>404</h1></body></html>",
  contentType: "text/html; charset=utf-8",
};

/** Paths the Access application leaves open (the inbound-mail webhook). */
const ACCESS_BYPASS = new Set(["/api/inbound/email"]);

function parseObject(text: string): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(text);
    return typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function createDefaultRoute(
  options: MockE2eOptions,
  testTickets: Map<string, MockTestTicket>,
  onOpen: (open: number) => void,
) {
  const mode = options.securityEvents ?? "per-minute";
  const now = options.now ?? Date.now;
  const events: StoredEvent[] = [];

  function createTestTicket(request: MockRequest): MockReply {
    const body = parseObject(request.body);
    const testId = typeof body.testId === "string" ? body.testId : "";
    const existing = testTickets.get(testId);
    if (existing) {
      return { status: 201, json: { ticketId: existing.ticketId, queued: true, duplicate: true } };
    }
    const ticketId = randomUUID();
    testTickets.set(testId, { testId, ticketId, body, reads: 0, finished: false });
    onOpen([...testTickets.values()].filter((t) => !t.finished).length);
    return { status: 201, json: { ticketId, queued: true } };
  }

  function record(kind: string): void {
    if (mode === "none") return;
    const windowStart = new Date(Math.floor(now() / MINUTE_MS) * MINUTE_MS).toISOString();
    const existing =
      mode === "per-minute"
        ? events.find(
            (e) => e.source === "internal_api" && e.kind === kind && e.windowStart === windowStart,
          )
        : undefined;
    if (existing) existing.count += 1;
    else events.push({ source: "internal_api", kind, windowStart, count: 1 });
  }

  return function defaultRoute(request: MockRequest): MockReply {
    const { method, path } = request;
    if (ACCESS_BYPASS.has(path)) return NOT_FOUND;
    if (!request.accessOk) return ACCESS_DENIED;
    if (method === "GET" && path === "/api/health") {
      return { status: 200, json: { status: "ok", version: "0.0.0-mock" } };
    }
    if (method === "GET" && path === "/api/health/config") {
      return {
        status: 200,
        json: {
          version: "0.0.0-mock",
          features: {
            database: true,
            migration0003: true,
            pipelineTrigger: true,
            turnstile: true,
            internalApi: true,
            e2eMode: true,
          },
        },
      };
    }
    if (!path.startsWith("/api/internal/")) return NOT_FOUND;
    if (!request.bearerOk) {
      record(request.hasAuthorization ? "bad_token" : "missing_token");
      return { status: 401, json: { error: "unauthorized" } };
    }

    if (method === "GET" && path === "/api/internal/usage") {
      const calls = options.usage?.() ?? { llm: 0, typesafe: 0 };
      const usage = (n: number) => ({ calls: n, tokensIn: 0, tokensOut: 0, costUsd: null });
      return {
        status: 200,
        json: {
          month: request.query.get("month"),
          llm: usage(calls.llm),
          typesafe: usage(calls.typesafe),
        },
      };
    }
    if (method === "GET" && path === "/api/internal/security-events") {
      const values = request.query.getAll("since");
      const since = values.length === 1 ? Date.parse(values[0]!) : Number.NaN;
      if (Number.isNaN(since)) return { status: 400, json: { error: "invalid_since" } };
      const listed = events
        .filter((e) => Date.parse(e.windowStart) >= since)
        .sort((a, b) => b.windowStart.localeCompare(a.windowStart))
        .map((e) => ({ ...e }));
      return { status: 200, json: { events: listed } };
    }
    if (method === "POST" && path === "/api/internal/test-tickets") {
      return createTestTicket(request);
    }
    const ticket = /^\/api\/internal\/tickets\/([^/]+)$/.exec(path);
    if (method === "GET" && ticket && TICKET_ID.test(ticket[1]!)) {
      const known = [...testTickets.values()].find((t) => t.ticketId === ticket[1]);
      let view: MockTicketView | undefined;
      if (known) {
        known.reads += 1;
        view = options.ticketView?.(known.testId, known.reads);
        if (view && (view.status === "failed" || view.triage !== null)) known.finished = true;
      }
      return {
        status: 200,
        json: {
          id: ticket[1],
          status: view?.status ?? "new",
          isTest: true,
          source: "web",
          createdAt: "2026-10-10T00:00:00.000Z",
          redacted: null,
          triage: view?.triage ?? null,
          aiCallCount: 0,
          events: [],
          reviews: [],
          notifications: [],
          autofix: [],
        },
      };
    }
    return NOT_FOUND;
  };
}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString("utf8");
}

function reply(response: ServerResponse, answer: MockReply): void {
  const body = answer.json !== undefined ? JSON.stringify(answer.json) : (answer.text ?? "");
  response.writeHead(answer.status, {
    "Content-Type":
      answer.contentType ?? (answer.json !== undefined ? "application/json" : "text/plain"),
    ...answer.headers,
  });
  response.end(body);
}

/**
 * Local mock of the e2e app on 127.0.0.1: a Cloudflare Access gate (403 HTML
 * without both Access headers, except on `/api/inbound/email`), the internal
 * API (401 JSON without the right bearer token, recorded as a security event)
 * and the health endpoints. Test support only.
 */
export async function startMockE2e(options: MockE2eOptions): Promise<MockE2e> {
  const requests: MockRequest[] = [];
  const testTickets = new Map<string, MockTestTicket>();
  let maxOpen = 0;
  const defaultRoute = createDefaultRoute(options, testTickets, (open) => {
    maxOpen = Math.max(maxOpen, open);
  });
  let inFlight = 0;
  let peakInFlight = 0;
  const server = createServer((incoming, response) => {
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    let done = false;
    const finish = () => {
      if (!done) inFlight -= 1;
      done = true;
    };
    void (async () => {
      const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
      const authorization = incoming.headers["authorization"];
      const accessId = incoming.headers["cf-access-client-id"];
      const accessSecret = incoming.headers["cf-access-client-secret"];
      const request: MockRequest = {
        method: incoming.method ?? "GET",
        path: url.pathname,
        query: url.searchParams,
        accessOk:
          accessId === options.accessClientId && accessSecret === options.accessClientSecret,
        hasAccessHeaders: accessId !== undefined || accessSecret !== undefined,
        hasAuthorization: authorization !== undefined,
        hasBearer: typeof authorization === "string" && authorization.startsWith("Bearer "),
        bearerOk: authorization === `Bearer ${options.token}`,
        body: await readBody(incoming),
      };
      requests.push(request);
      const answer = options.override?.(request) ?? defaultRoute(request);
      if (options.delayMs) await new Promise((wait) => setTimeout(wait, options.delayMs));
      finish();
      reply(response, answer);
    })().catch(() => {
      finish();
      response.statusCode = 500;
      response.end();
    });
  });
  await new Promise<void>((ready) => server.listen(0, "127.0.0.1", ready));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    get peakInFlight() {
      return peakInFlight;
    },
    testTickets,
    maxOpenTickets: () => maxOpen,
    close: () =>
      new Promise<void>((closed, fail) => {
        server.closeAllConnections();
        server.close((error) => (error ? fail(error) : closed()));
      }),
  };
}
