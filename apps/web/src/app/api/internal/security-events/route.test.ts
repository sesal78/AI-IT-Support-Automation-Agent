import { internalSecurityEventsSchema } from "@ai-it-support/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const repo = vi.hoisted(() => ({
  listSecurityEvents: vi.fn(),
  recordSecurityEvent: vi.fn(),
}));
vi.mock("@ai-it-support/db", () => ({
  createDbClient: () => ({}),
  createRepositories: () => repo,
}));

const TOKEN = "fakeInternalApiToken0123456789ABCDEF";
const MARKER = "m".repeat(20);
const auth = { authorization: `Bearer ${TOKEN}` };
const SINCE = "?since=2026-10-01T00:00:00Z";

type Route = typeof import("./route");
let route: Route;

const request = (query = "", method = "GET", headers: Record<string, string> = auth) =>
  new Request(`http://localhost/api/internal/security-events${query}`, { method, headers });
const event = (n: number) => ({
  source: "internal_api",
  kind: "bad_token",
  windowStart: `2026-10-0${n}T10:00:00.000Z`,
  count: n,
});

beforeEach(async () => {
  vi.resetModules();
  vi.unstubAllEnvs();
  vi.stubEnv("NEXT_PHASE", undefined);
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fake-service-role-key");
  vi.stubEnv("TRIGGER_SECRET_KEY", "fake-trigger-secret");
  vi.stubEnv("ADMIN_HEALTH_TOKEN", "fake-admin-health-token");
  vi.stubEnv("APP_VERSION", "1.0.0-test");
  vi.stubEnv("INTERNAL_API_TOKEN", TOKEN);
  for (const fn of Object.values(repo)) fn.mockReset();
  repo.recordSecurityEvent.mockResolvedValue(undefined);
  route = await import("./route");
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/internal/security-events", () => {
  it("returns the events as the repository ordered them, with exactly four keys", async () => {
    repo.listSecurityEvents.mockResolvedValue([event(3), event(2), event(1)]);
    const res = await route.GET(request(SINCE));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = internalSecurityEventsSchema.parse(await res.json());
    expect(body.events.map((e) => e.count)).toEqual([3, 2, 1]);
    for (const e of body.events) {
      expect(Object.keys(e).sort()).toEqual(["count", "kind", "source", "windowStart"]);
    }
    expect(repo.listSecurityEvents).toHaveBeenCalledWith(new Date("2026-10-01T00:00:00Z"), 500);
  });

  it("drops a sample the repository returns anyway", async () => {
    repo.listSecurityEvents.mockResolvedValue([{ ...event(1), sample: { path: MARKER } }]);
    const res = await route.GET(request(SINCE));
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(MARKER);
  });

  it("returns an empty list for a time in the future", async () => {
    repo.listSecurityEvents.mockResolvedValue([]);
    const res = await route.GET(request("?since=2999-01-01T00:00:00Z"));
    expect(await res.json()).toEqual({ events: [] });
  });

  it.each(["?since=2026-10-01T00:00:00.123Z", "?since=2026-10-01T02:00:00%2B02:00"])(
    "accepts %j",
    async (query) => {
      repo.listSecurityEvents.mockResolvedValue([]);
      expect((await route.GET(request(query))).status).toBe(200);
    },
  );

  it.each([
    "",
    "?since=",
    "?since=yesterday",
    "?since=2026-10-01",
    "?since=2026-10-01T00:00:00",
    "?since=2026-13-01T00:00:00Z",
    "?since=1700000000",
    `?since=${"1".repeat(5000)}`,
    "?since=2026-10-01T00:00:00Z&since=2026-10-02T00:00:00Z",
  ])("returns 400 invalid_since for %j without a database call", async (query) => {
    const res = await route.GET(request(query));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_since" });
    expect(repo.listSecurityEvents).not.toHaveBeenCalled();
  });

  it.each([
    ["no token", {}],
    ["wrong token", { authorization: "Bearer wrong" }],
  ])("returns 401 with %s, before validation and any database call", async (_name, headers) => {
    for (const query of [SINCE, "", "?since=bad"]) {
      const res = await route.GET(request(query, "GET", headers));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(repo.listSecurityEvents).not.toHaveBeenCalled();
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const)(
    "%s: 401 without a token, 405 with one",
    async (method) => {
      expect((await route[method](request(SINCE, method, {}))).status).toBe(401);
      const res = await route[method](request(SINCE, method));
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD");
    },
  );

  it("returns 500 internal_error without detail, logging only the class name", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    repo.listSecurityEvents.mockRejectedValue(new TypeError(`boom ${MARKER}`));
    const res = await route.GET(request(SINCE));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"error":"internal_error"}');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(log.mock.calls)).not.toContain(MARKER);
    expect(JSON.stringify(log.mock.calls)).toContain("TypeError");
  });
});
