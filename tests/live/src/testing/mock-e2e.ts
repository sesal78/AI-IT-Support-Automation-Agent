import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { verifySlackRequest, type SlackVerifyResult } from "@ai-it-support/shared";

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
  /** Mock clock time the request arrived. */
  readonly at: number;
  /**
   * The shared verifier's result for `POST /api/slack/interactivity` when
   * `slackSigningSecret` is set; else null.
   */
  readonly slack: SlackVerifyResult | null;
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

/** A ticket the mock created, from the test path or the form path. */
export interface MockTicketInput {
  readonly id: string;
  /** The display number, `ITS-` plus 6 digits, counting up from 1 like the database sequence. */
  readonly number: string;
  readonly path: "test" | "form";
  /** The parsed request body (test support only; never reported). */
  readonly body: Record<string, unknown>;
  readonly createdAt: number;
}

/**
 * How the mock pipeline treats one ticket. Times are ms after creation;
 * `triagedAfterMs: null` means the ticket never reaches `triaged`.
 */
export interface MockTicketOutcome {
  readonly isTest: boolean;
  readonly redactedAfterMs: number;
  readonly triagedAfterMs: number | null;
  /** Set to `failed` (at `failedAfterMs`) instead of being triaged. */
  readonly failedAfterMs: number | null;
  readonly route: "auto" | "review";
  readonly sensitiveFlags: readonly string[];
  readonly fixSteps: number;
  /** Extra events, written together with `triaged`. */
  readonly extraEvents: readonly string[];
  /** AI calls of a triaged ticket; default 1. */
  readonly aiCallCount?: number;
}

/**
 * The default pipeline, like the e2e app: every ticket is a test ticket
 * (E2E_MODE), redacted after 1 s and triaged after 5 s. Test switches count
 * on the test path only: `llmCallCap: 0` gives `llm_cap_reached`, the route
 * `review` and no fix steps; `langfuseDown` gives `trace_export_failed`. A
 * ticket that mentions HR is sensitive (`hr`) and goes to review.
 */
export function defaultTicketOutcome(ticket: MockTicketInput): MockTicketOutcome {
  const requested = ticket.body["testOverrides"];
  const overrides =
    ticket.path === "test" && typeof requested === "object" && requested !== null
      ? (requested as { llmCallCap?: unknown; langfuseDown?: unknown })
      : {};
  const capped = overrides.llmCallCap === 0;
  const text = `${String(ticket.body["title"])} ${String(ticket.body["description"])}`;
  const hr = /\bHR\b/.test(text);
  return {
    isTest: true,
    redactedAfterMs: 1_000,
    triagedAfterMs: 5_000,
    failedAfterMs: null,
    route: capped || hr ? "review" : "auto",
    sensitiveFlags: hr ? ["hr"] : [],
    fixSteps: capped ? 0 : 2,
    extraEvents: [
      ...(capped ? ["llm_cap_reached"] : []),
      ...(overrides.langfuseDown === true ? ["trace_export_failed"] : []),
    ],
  };
}

export interface MockE2eOptions {
  readonly token: string;
  readonly accessClientId: string;
  readonly accessClientSecret: string;
  /** Runs before the Access gate; a reply short-circuits the default routes. */
  readonly override?: (request: MockRequest) => MockReply | undefined;
  /**
   * How the Access gate refuses: `forbidden` is the 403 HTML page (default),
   * `redirect` is the 302 to the Access login page.
   */
  readonly accessDenial?: "forbidden" | "redirect";
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
   * number of times the view was read (1 for the first read). Without it, test
   * tickets follow the mock pipeline (`pipeline`).
   */
  readonly ticketView?: (testId: string, reads: number) => MockTicketView | undefined;
  /** Changes how the mock pipeline treats a ticket; gets the default outcome. */
  readonly pipeline?: (ticket: MockTicketInput, defaults: MockTicketOutcome) => MockTicketOutcome;
  /**
   * The e2e test signing secret. When set, `POST /api/slack/interactivity`
   * (behind Access) verifies with the shared `verifySlackRequest`: 401 on any
   * failure, 200 `{ outcome: "recorded" }` for a `block_actions` payload.
   */
  readonly slackSigningSecret?: string;
}

export interface MockTicketView {
  readonly status: string;
  readonly triage: unknown;
  /** Redacted title and description; null when left out. */
  readonly redacted?: { readonly title: string; readonly description: string } | null;
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
  /** Most requests to one method and path (for example `POST /api/slack/interactivity`) at one time. */
  peakInFlightOf(route: string): number;
  /** Test tickets by `testId`; a repeated `testId` is a duplicate, not a new ticket. */
  readonly testTickets: Map<string, MockTestTicket>;
  /** Most test tickets that were created and not yet finished at one time. */
  readonly maxOpenTickets: () => number;
  /** Parsed payloads of verified interactivity requests, in order. */
  readonly interactions: unknown[];
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
/** The other form of the refusal: a 302 to the Access login page of an example team. */
const ACCESS_LOGIN_REDIRECT: MockReply = {
  status: 302,
  text: "",
  headers: {
    Location:
      "https://team.cloudflareaccess.com/cdn-cgi/access/login/e2e.example.test?kid=0000&redirect_url=%2F",
  },
};
const NOT_FOUND: MockReply = {
  status: 404,
  text: "<!DOCTYPE html><html><body><h1>404</h1></body></html>",
  contentType: "text/html; charset=utf-8",
};

/** Paths the Access application leaves open (the inbound-mail webhook). */
const ACCESS_BYPASS = new Set(["/api/inbound/email"]);

const iso = (ms: number) => new Date(ms).toISOString();

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

/** The internal ticket view of a mock ticket at time `at`. */
function ticketView(ticket: MockTicketInput, outcome: MockTicketOutcome, at: number) {
  const age = at - ticket.createdAt;
  const events: Array<{ type: string; at: string }> = [];
  let status = "new";
  if (age >= outcome.redactedAfterMs) {
    status = "redacted";
    events.push({ type: "redacted", at: iso(ticket.createdAt + outcome.redactedAfterMs) });
  }
  const failed = outcome.failedAfterMs !== null && age >= outcome.failedAfterMs;
  const triagedAfterMs = failed ? null : outcome.triagedAfterMs;
  const triaged = triagedAfterMs !== null && age >= triagedAfterMs;
  if (failed) status = "failed";
  if (triaged) {
    status = "triaged";
    const triagedAt = iso(ticket.createdAt + triagedAfterMs);
    for (const type of outcome.extraEvents) events.push({ type, at: triagedAt });
    events.push({ type: "triaged", at: triagedAt });
  }
  return {
    id: ticket.id,
    number: ticket.number,
    status,
    isTest: outcome.isTest,
    source: "web",
    createdAt: iso(ticket.createdAt),
    redacted:
      age >= outcome.redactedAfterMs ? { title: "[redacted]", description: "[redacted]" } : null,
    triage: triaged
      ? {
          sensitive: outcome.sensitiveFlags.length > 0,
          sensitiveFlags: [...outcome.sensitiveFlags],
          category: "software",
          subcategory: null,
          priority: "P3",
          urgency: "medium",
          assignmentGroup: "Software",
          route: outcome.route,
          flags: [],
          probabilities: null,
          groundingScore: outcome.fixSteps > 0 ? 0.9 : null,
          kbArticleIds: [],
          suggestedFix:
            outcome.fixSteps > 0
              ? {
                  steps: Array.from({ length: outcome.fixSteps }, (_, i) => `step ${i + 1}`),
                  caveats: [],
                }
              : null,
          modelVersions: null,
          triagedAt: iso(ticket.createdAt + triagedAfterMs),
        }
      : null,
    aiCallCount: triaged ? (outcome.aiCallCount ?? 1) : 0,
    events,
    reviews: [],
    notifications: [],
    autofix: [],
    // P5-T5b: a mock ticket has no helpdesk incident yet.
    incident: null,
  };
}

const INTERACTIVITY = "/api/slack/interactivity";
const NO_STORE = { "Cache-Control": "no-store" };

function interactivity(request: MockRequest, interactions: unknown[]): MockReply {
  if (request.slack === null || !request.slack.ok) {
    return { status: 401, json: { error: "unauthorized" }, headers: NO_STORE };
  }
  let payload: unknown;
  try {
    payload = JSON.parse(new URLSearchParams(request.body).get("payload") ?? "");
  } catch {
    payload = undefined;
  }
  if ((payload as { type?: unknown } | undefined)?.type !== "block_actions") {
    return { status: 400, json: { error: "bad_payload" }, headers: NO_STORE };
  }
  interactions.push(payload);
  return { status: 200, json: { outcome: "recorded" }, headers: NO_STORE };
}

function createDefaultRoute(
  options: MockE2eOptions,
  testTickets: Map<string, MockTestTicket>,
  onOpen: (open: number) => void,
  interactions: unknown[],
) {
  const mode = options.securityEvents ?? "per-minute";
  const now = options.now ?? Date.now;
  const pipeline = options.pipeline;
  const events: StoredEvent[] = [];
  /** Every created ticket (test and form path) with its pipeline outcome, by ticket ID. */
  const tickets = new Map<string, { ticket: MockTicketInput; outcome: MockTicketOutcome }>();
  const formKeys = new Map<string, string>();
  let lastNumber = 0;
  const nextNumber = () => `ITS-${String(++lastNumber).padStart(6, "0")}`;

  function track(id: string, path: "test" | "form", body: Record<string, unknown>): string {
    const ticket: MockTicketInput = { id, number: nextNumber(), path, body, createdAt: now() };
    const defaults = defaultTicketOutcome(ticket);
    tickets.set(id, { ticket, outcome: pipeline ? pipeline(ticket, defaults) : defaults });
    return ticket.number;
  }

  /** The form path dedupes like the app's day key; the description stands in for it. */
  function createFormTicket(body: Record<string, unknown>): MockReply {
    const key = `web:b:${String(body["description"])}`;
    const existing = formKeys.get(key);
    if (existing !== undefined) {
      const ticketNumber = tickets.get(existing)!.ticket.number;
      return {
        status: 201,
        json: { ticketId: existing, ticketNumber, queued: true, duplicate: true },
      };
    }
    const ticketId = randomUUID();
    const ticketNumber = track(ticketId, "form", body);
    formKeys.set(key, ticketId);
    return { status: 201, json: { ticketId, ticketNumber, queued: true } };
  }

  function createTestTicket(request: MockRequest): MockReply {
    const body = parseObject(request.body);
    const testId = typeof body.testId === "string" ? body.testId : "";
    const existing = testTickets.get(testId);
    if (existing) {
      const ticketNumber = tickets.get(existing.ticketId)!.ticket.number;
      return {
        status: 201,
        json: { ticketId: existing.ticketId, ticketNumber, queued: true, duplicate: true },
      };
    }
    const ticketId = randomUUID();
    testTickets.set(testId, { testId, ticketId, body, reads: 0, finished: false });
    const ticketNumber = track(ticketId, "test", body);
    onOpen([...testTickets.values()].filter((t) => !t.finished).length);
    return { status: 201, json: { ticketId, ticketNumber, queued: true } };
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
    if (!request.accessOk) {
      return options.accessDenial === "redirect" ? ACCESS_LOGIN_REDIRECT : ACCESS_DENIED;
    }
    if (path === INTERACTIVITY && options.slackSigningSecret !== undefined) {
      if (method !== "POST") return { status: 405, text: "", headers: NO_STORE };
      return interactivity(request, interactions);
    }
    if (method === "GET" && path === "/api/health") {
      return { status: 200, json: { status: "ok", version: "0.0.0-mock" } };
    }
    if (method === "GET" && path === "/api/health/config") {
      return {
        status: 200,
        json: {
          version: "0.0.0-mock",
          helpdesk: "servicenow",
          features: {
            database: true,
            migration0003: true,
            migration0005: true,
            migration0006: true,
            pipelineTrigger: true,
            turnstile: true,
            internalApi: true,
            e2eMode: true,
            slackInteractivity: true,
            helpdeskReachable: true,
            helpdeskAsleep: false,
            builtinHelpdesk: false,
          },
        },
      };
    }
    if (method === "POST" && path === "/api/tickets") {
      // Like the app's form schema: unknown keys (a smuggled `testOverrides`)
      // are dropped, and a missing Turnstile token is a failed challenge.
      const body = parseObject(request.body);
      if (typeof body["turnstileToken"] !== "string" || body["turnstileToken"] === "") {
        return { status: 403, json: { error: "turnstile_failed" } };
      }
      return createFormTicket(body);
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
    const stored = ticket ? tickets.get(ticket[1]!) : undefined;
    // With a `ticketView` callback, test tickets are served by it (below).
    if (method === "GET" && stored && (stored.ticket.path === "form" || !options.ticketView)) {
      return { status: 200, json: ticketView(stored.ticket, stored.outcome, now()) };
    }
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
          number: stored?.ticket.number ?? "ITS-000001",
          status: view?.status ?? "new",
          isTest: true,
          source: "web",
          createdAt: "2026-10-10T00:00:00.000Z",
          redacted: view?.redacted ?? null,
          triage: view?.triage ?? null,
          aiCallCount: 0,
          events: [],
          reviews: [],
          notifications: [],
          autofix: [],
          incident: null,
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
 * API (401 JSON without the right bearer token, recorded as a security event),
 * the health endpoints, the form path `POST /api/tickets`, and a pipeline
 * whose tickets move on the mock clock (`pipeline`). Test support only.
 */
export async function startMockE2e(options: MockE2eOptions): Promise<MockE2e> {
  const requests: MockRequest[] = [];
  const now = options.now ?? Date.now;
  const testTickets = new Map<string, MockTestTicket>();
  let maxOpen = 0;
  const interactions: unknown[] = [];
  const defaultRoute = createDefaultRoute(
    options,
    testTickets,
    (open) => {
      maxOpen = Math.max(maxOpen, open);
    },
    interactions,
  );
  let inFlight = 0;
  let peakInFlight = 0;
  const routes = new Map<string, { inFlight: number; peak: number }>();
  const server = createServer((incoming, response) => {
    inFlight += 1;
    peakInFlight = Math.max(peakInFlight, inFlight);
    const routeKey = `${incoming.method ?? "GET"} ${new URL(incoming.url ?? "/", "http://127.0.0.1").pathname}`;
    const route = routes.get(routeKey) ?? { inFlight: 0, peak: 0 };
    routes.set(routeKey, route);
    route.inFlight += 1;
    route.peak = Math.max(route.peak, route.inFlight);
    let done = false;
    const finish = () => {
      if (!done) {
        inFlight -= 1;
        route.inFlight -= 1;
      }
      done = true;
    };
    void (async () => {
      const url = new URL(incoming.url ?? "/", "http://127.0.0.1");
      const authorization = incoming.headers["authorization"];
      const accessId = incoming.headers["cf-access-client-id"];
      const accessSecret = incoming.headers["cf-access-client-secret"];
      const body = await readBody(incoming);
      const at = now();
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
        body,
        at,
        slack:
          options.slackSigningSecret !== undefined && url.pathname === INTERACTIVITY
            ? verifySlackRequest({
                secret: options.slackSigningSecret,
                headers: incoming.headers,
                body,
                nowSeconds: Math.floor(at / 1000),
              })
            : null,
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
    peakInFlightOf: (key) => routes.get(key)?.peak ?? 0,
    testTickets,
    maxOpenTickets: () => maxOpen,
    interactions,
    close: () =>
      new Promise<void>((closed, fail) => {
        server.closeAllConnections();
        server.close((error) => (error ? fail(error) : closed()));
      }),
  };
}
