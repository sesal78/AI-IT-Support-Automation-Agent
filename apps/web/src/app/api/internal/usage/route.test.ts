import { internalUsageSchema } from "@ai-it-support/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const repo = vi.hoisted(() => ({
  getAiUsage: vi.fn(),
  recordSecurityEvent: vi.fn(),
}));
vi.mock("@ai-it-support/db", () => ({
  createDbClient: () => ({}),
  createRepositories: () => repo,
}));

const TOKEN = "fakeInternalApiToken0123456789ABCDEF";
const MARKER = "m".repeat(20);
const auth = { authorization: `Bearer ${TOKEN}` };
const QUERY = "?month=2026-10";

type Route = typeof import("./route");
let route: Route;

const request = (query = "", method = "GET", headers: Record<string, string> = auth) =>
  new Request(`http://localhost/api/internal/usage${query}`, { method, headers });
const totals = (calls: number) => ({
  calls,
  tokensIn: calls * 10,
  tokensOut: calls,
  costUsd: null,
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

describe("GET /api/internal/usage", () => {
  it("returns the usage of the month", async () => {
    repo.getAiUsage.mockResolvedValue({ llm: totals(12), typesafe: totals(340) });
    const res = await route.GET(request(QUERY));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = internalUsageSchema.parse(await res.json());
    expect(body).toEqual({ month: "2026-10", llm: totals(12), typesafe: totals(340) });
    expect(repo.getAiUsage).toHaveBeenCalledWith("2026-10-01");
  });

  it("returns zeros and a null cost for a month without rows", async () => {
    repo.getAiUsage.mockResolvedValue({ llm: totals(0), typesafe: totals(0) });
    const body = await (await route.GET(request("?month=2025-01"))).json();
    expect(body.llm).toEqual({ calls: 0, tokensIn: 0, tokensOut: 0, costUsd: null });
    expect(body.typesafe.costUsd).toBeNull();
  });

  it("ignores extra parameters", async () => {
    repo.getAiUsage.mockResolvedValue({ llm: totals(1), typesafe: totals(1) });
    expect((await route.GET(request(`${QUERY}&x=1`))).status).toBe(200);
  });

  it.each([
    "",
    "?month=2026-13",
    "?month=2026-00",
    "?month=26-10",
    "?month=2026-1",
    "?month=2026-10-01",
    "?month=",
    "?month=2026-10&month=2026-11",
    "?month=%202026-10",
    "?Month=2026-10",
  ])("returns 400 invalid_month for %j without a database call", async (query) => {
    const res = await route.GET(request(query));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_month" });
    expect(repo.getAiUsage).not.toHaveBeenCalled();
  });

  it.each([
    ["no token", {}],
    ["wrong token", { authorization: "Bearer wrong" }],
  ])("returns 401 with %s, before validation and any database call", async (_name, headers) => {
    for (const query of [QUERY, "", "?month=bad"]) {
      const res = await route.GET(request(query, "GET", headers));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
      expect(res.headers.get("cache-control")).toBe("no-store");
    }
    expect(repo.getAiUsage).not.toHaveBeenCalled();
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const)(
    "%s: 401 without a token, 405 with one",
    async (method) => {
      expect((await route[method](request(QUERY, method, {}))).status).toBe(401);
      const res = await route[method](request(QUERY, method));
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD");
    },
  );

  it("returns 500 internal_error without detail, logging only the class name", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    repo.getAiUsage.mockRejectedValue(new TypeError(`boom ${MARKER}`));
    const res = await route.GET(request(QUERY));
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"error":"internal_error"}');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(log.mock.calls)).not.toContain(MARKER);
    expect(JSON.stringify(log.mock.calls)).toContain("TypeError");
  });
});
