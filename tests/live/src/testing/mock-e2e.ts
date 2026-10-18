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
}

export interface MockE2e {
  /** `http://127.0.0.1:<port>` */
  readonly origin: string;
  readonly requests: MockRequest[];
  /** Most requests the mock was handling at one time. */
  readonly peakInFlight: number;
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

function createDefaultRoute(mode: MockSecurityEvents, now: () => number) {
  const events: StoredEvent[] = [];

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
      const usage = { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: null };
      return {
        status: 200,
        json: { month: request.query.get("month"), llm: usage, typesafe: usage },
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
      return {
        status: 201,
        json: { ticketId: "00000000-0000-4000-8000-000000000001", queued: true },
      };
    }
    const ticket = /^\/api\/internal\/tickets\/([^/]+)$/.exec(path);
    if (method === "GET" && ticket && TICKET_ID.test(ticket[1]!)) {
      return {
        status: 200,
        json: {
          id: ticket[1],
          status: "new",
          isTest: true,
          source: "web",
          createdAt: "2026-10-10T00:00:00.000Z",
          redacted: null,
          triage: null,
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
  const defaultRoute = createDefaultRoute(
    options.securityEvents ?? "per-minute",
    options.now ?? Date.now,
  );
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
    close: () =>
      new Promise<void>((closed, fail) => {
        server.closeAllConnections();
        server.close((error) => (error ? fail(error) : closed()));
      }),
  };
}
