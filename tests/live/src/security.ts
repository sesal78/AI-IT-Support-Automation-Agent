import {
  errorClassName,
  LiveContractError,
  LiveTransportError,
  type RawResponse,
} from "./client.ts";
import type { Evidence, Scenario, ScenarioContext, ScenarioResult } from "./runner.ts";

/**
 * The live security scenarios (plan T3.S.02, T3.S.03, T3.S.05, T3.S.07).
 * Evidence carries status codes, counts, check names and paths only.
 */

const MINUTE_MS = 60_000;
/** A well-formed ticket ID that no ticket has; the guard answers before any lookup. */
const NO_TICKET = "00000000-0000-4000-8000-000000000000";
const TICKET_PATH = `/api/internal/tickets/${NO_TICKET}`;

/**
 * A bearer token that is clearly not the configured one. Only its length
 * follows the real token; none of its characters do, so sending it reveals
 * nothing. Never printed.
 */
export function wrongTokenFor(real: string): string {
  const fill = Math.max(18, real.length - 14);
  const candidate = `LiveWrongToken${"x".repeat(fill)}`;
  return candidate === real ? `LiveWrongToken${"y".repeat(fill)}` : candidate;
}

const floorMinute = (ms: number): number => Math.floor(ms / MINUTE_MS) * MINUTE_MS;

const result = (pass: boolean, evidence: Evidence): ScenarioResult => ({
  status: pass ? "pass" : "fail",
  evidence,
});

/** True when the body is JSON (the app's answers are), so not Cloudflare's HTML page. */
function isJson(response: RawResponse): boolean {
  if (/json/i.test(response.contentType)) return true;
  try {
    JSON.parse(response.text);
    return true;
  } catch {
    return false;
  }
}

const ACCESS_LOGIN_HOST_SUFFIX = ".cloudflareaccess.com";
const ACCESS_LOGIN_PATH = "/cdn-cgi/access/login";

/** True for a redirect to the Cloudflare Access login page (https, a team host). */
function isAccessLoginRedirect(response: RawResponse): boolean {
  if (response.status !== 302 && response.status !== 303) return false;
  if (response.location === null) return false;
  let url: URL;
  try {
    url = new URL(response.location);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.hostname.endsWith(ACCESS_LOGIN_HOST_SUFFIX) &&
    url.hostname.length > ACCESS_LOGIN_HOST_SUFFIX.length &&
    (url.pathname === ACCESS_LOGIN_PATH || url.pathname.startsWith(`${ACCESS_LOGIN_PATH}/`))
  );
}

/**
 * The Cloudflare Access refusal: a 403 with a body that is not the app's JSON,
 * or a 302/303 to the Access login page on a `*.cloudflareaccess.com` host.
 */
export const isAccessDenied = (response: RawResponse): boolean =>
  (response.status === 403 && !isJson(response)) || isAccessLoginRedirect(response);

async function rowsSince(context: ScenarioContext, since: number) {
  const { events } = await context.client.securityEvents(new Date(since));
  return events.filter((event) => event.source === "internal_api");
}

/** T3.S.02: no token and a wrong token both get 401, and both refusals are recorded. */
export const internalAuthScenario: Scenario = {
  id: "T3.S.02",
  async run(context) {
    const { client, config } = context;
    const since = floorMinute(context.now());
    const endpoint = "GET /api/internal/tickets/:id";
    const noToken = await client.send(endpoint, TICKET_PATH, { token: null });
    if (noToken.status !== 401) {
      return result(false, { failedCheck: "no-token-401", status: noToken.status });
    }
    const wrong = await client.send(endpoint, TICKET_PATH, {
      token: wrongTokenFor(config.internalApiToken),
    });
    if (wrong.status !== 401) {
      return result(false, { failedCheck: "wrong-token-401", status: wrong.status });
    }
    const rows = await rowsSince(context, since);
    const kinds = new Set(rows.map((row) => row.kind));
    const missing = ["missing_token", "bad_token"].filter((kind) => !kinds.has(kind));
    return result(missing.length === 0, {
      noTokenStatus: noToken.status,
      wrongTokenStatus: wrong.status,
      rows: rows.length,
      ...(missing.length > 0 ? { failedCheck: "security-events", missingKinds: missing } : {}),
    });
  },
};

/**
 * T3.S.02-staging: staging has `test-tickets` turned off, so a POST there
 * answers 404. Sent with no bearer token and no Access headers: staging never
 * receives a credential. Not run when STAGING_BASE_URL is unset.
 */
export const stagingTestTicketsScenario: Scenario = {
  id: "T3.S.02-staging",
  async run(context) {
    const origin = context.config.stagingOrigin;
    if (origin === undefined) {
      return { status: "not_run", evidence: { reason: "STAGING_BASE_URL-unset" } };
    }
    const endpoint = "POST staging /api/internal/test-tickets";
    const url = new URL("/api/internal/test-tickets", origin);
    if (url.origin !== origin) throw new LiveTransportError(endpoint, "OriginRefused");
    let status: number;
    try {
      const response = await context.fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        redirect: "manual",
      });
      await response.text();
      status = response.status;
    } catch (error) {
      // The cause may quote the URL; only its class name survives.
      throw new LiveTransportError(endpoint, errorClassName(error));
    }
    return result(status === 404, {
      status,
      ...(status === 404 ? {} : { failedCheck: "staging-test-tickets-404" }),
    });
  },
};

/** T3.S.03: the public config endpoint parses with the strict shared schema. */
export const healthConfigScenario: Scenario = {
  id: "T3.S.03",
  async run({ client }) {
    try {
      const body = await client.healthConfig();
      return result(true, { status: 200, features: Object.keys(body.features).length });
    } catch (error) {
      if (!(error instanceof LiveContractError)) throw error;
      return result(false, { failedCheck: "healthConfigSchema", status: error.status });
    }
  },
};

/** Every path the Access application must guard (T3.S.05). */
export const ACCESS_GUARDED_PATHS = [
  "/",
  "/api/health",
  "/api/health/config",
  "/api/tickets",
  "/api/internal/tickets/x",
  "/api/internal/usage",
  "/api/internal/security-events",
  "/api/internal/test-tickets",
] as const;
/** The one path Access leaves open, for the inbound-mail webhook. */
export const ACCESS_BYPASS_PATH = "/api/inbound/email";

/**
 * T3.S.05: without the Access headers (and without a token), every guarded
 * path gets Cloudflare's refusal (403 or the login redirect), and the inbound-mail path does not.
 */
export const accessGateScenario: Scenario = {
  id: "T3.S.05",
  async run({ client }) {
    const bare = { access: false, token: null } as const;
    const statuses: number[] = [];
    const failedPaths: string[] = [];
    for (const path of ACCESS_GUARDED_PATHS) {
      const response = await client.send(`GET ${path}`, path, bare);
      statuses.push(response.status);
      if (!isAccessDenied(response)) failedPaths.push(path);
    }
    const inbound = await client.send(`GET ${ACCESS_BYPASS_PATH}`, ACCESS_BYPASS_PATH, bare);
    if (isAccessDenied(inbound)) failedPaths.push(ACCESS_BYPASS_PATH);
    return result(failedPaths.length === 0, {
      paths: [...ACCESS_GUARDED_PATHS],
      statuses,
      inboundStatus: inbound.status,
      failedPaths,
    });
  },
};

export const FLOOD_REQUESTS = 1000;
export const FLOOD_CONCURRENCY = 20;

/**
 * T3.S.07: 1 000 wrong-token requests, at most 20 at a time, all get 401.
 * Afterwards the `bad_token` rows of the flood window number at most the
 * minutes the flood touched (the app aggregates per minute), their counts add
 * up to at least 1 000, and `/api/health` still answers 200.
 */
export const floodScenario: Scenario = {
  id: "T3.S.07",
  async run(context) {
    const { client, config } = context;
    const token = wrongTokenFor(config.internalApiToken);
    const statusCounts = new Map<number, number>();
    let next = 0;
    let inFlight = 0;
    let maxInFlight = 0;
    let transportErrors = 0;

    async function worker(): Promise<void> {
      while (next < FLOOD_REQUESTS) {
        next += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          const { status } = await client.send("GET /api/internal/tickets/:id", TICKET_PATH, {
            token,
          });
          statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
        } catch {
          transportErrors += 1;
        } finally {
          inFlight -= 1;
        }
      }
    }

    const start = context.now();
    await Promise.all(Array.from({ length: FLOOD_CONCURRENCY }, worker));
    const end = context.now();

    const windowStart = floorMinute(start);
    const windowEnd = floorMinute(end);
    const minutesTouched = (windowEnd - windowStart) / MINUTE_MS + 1;
    const rows = (await rowsSince(context, windowStart)).filter((row) => {
      const at = Date.parse(row.windowStart);
      return row.kind === "bad_token" && at >= windowStart && at <= windowEnd;
    });
    const countSum = rows.reduce((sum, row) => sum + row.count, 0);
    const health = await client.send("GET /api/health", "/api/health");

    const status401 = statusCounts.get(401) ?? 0;
    const failedChecks = [
      ...(status401 === FLOOD_REQUESTS ? [] : ["all-401"]),
      ...(rows.length <= minutesTouched ? [] : ["rows-per-minute"]),
      ...(countSum >= FLOOD_REQUESTS ? [] : ["count-sum"]),
      ...(health.status === 200 ? [] : ["health-200"]),
    ];
    const otherStatuses = [...statusCounts.keys()]
      .filter((status) => status !== 401)
      .sort((a, b) => a - b);
    return result(failedChecks.length === 0, {
      requests: FLOOD_REQUESTS,
      maxConcurrent: maxInFlight,
      status401,
      otherStatuses,
      transportErrors,
      minutesTouched,
      rows: rows.length,
      countSum,
      healthStatus: health.status,
      failedChecks,
    });
  },
};

export const securityScenarios: readonly Scenario[] = [
  internalAuthScenario,
  stagingTestTicketsScenario,
  healthConfigScenario,
  accessGateScenario,
  floodScenario,
];
