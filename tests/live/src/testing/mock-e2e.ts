import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

/** What the mock saw of one request. Header values are compared, never stored. */
export interface MockRequest {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly accessOk: boolean;
  readonly bearerOk: boolean;
  readonly hasBearer: boolean;
  readonly body: string;
}

export interface MockReply {
  readonly status: number;
  readonly json?: unknown;
  readonly text?: string;
  readonly contentType?: string;
  readonly headers?: Record<string, string>;
}

export interface MockE2eOptions {
  readonly token: string;
  readonly accessClientId: string;
  readonly accessClientSecret: string;
  /** Runs before the Access gate; a reply short-circuits the default routes. */
  readonly override?: (request: MockRequest) => MockReply | undefined;
}

export interface MockE2e {
  /** `http://127.0.0.1:<port>` */
  readonly origin: string;
  readonly requests: MockRequest[];
  close(): Promise<void>;
}

const TICKET_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

function defaultRoute(request: MockRequest): MockReply {
  if (!request.accessOk) return ACCESS_DENIED;
  const { method, path } = request;
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
  if (!request.bearerOk) return { status: 401, json: { error: "unauthorized" } };

  if (method === "GET" && path === "/api/internal/usage") {
    const usage = { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: null };
    return {
      status: 200,
      json: { month: request.query.get("month"), llm: usage, typesafe: usage },
    };
  }
  if (method === "GET" && path === "/api/internal/security-events") {
    return { status: 200, json: { events: [] } };
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
 * without both Access headers), the internal API (401 JSON without the right
 * bearer token) and the health endpoints. Test support only.
 */
export async function startMockE2e(options: MockE2eOptions): Promise<MockE2e> {
  const requests: MockRequest[] = [];
  const server = createServer((incoming, response) => {
    void (async () => {
      const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
      const authorization = incoming.headers["authorization"];
      const request: MockRequest = {
        method: incoming.method ?? "GET",
        path: url.pathname,
        query: url.searchParams,
        accessOk:
          incoming.headers["cf-access-client-id"] === options.accessClientId &&
          incoming.headers["cf-access-client-secret"] === options.accessClientSecret,
        hasBearer: typeof authorization === "string" && authorization.startsWith("Bearer "),
        bearerOk: authorization === `Bearer ${options.token}`,
        body: await readBody(incoming),
      };
      requests.push(request);
      reply(response, options.override?.(request) ?? defaultRoute(request));
    })().catch(() => {
      response.statusCode = 500;
      response.end();
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    origin: `http://127.0.0.1:${port}`,
    requests,
    close: () =>
      new Promise<void>((done, fail) => {
        server.closeAllConnections();
        server.close((error) => (error ? fail(error) : done()));
      }),
  };
}
