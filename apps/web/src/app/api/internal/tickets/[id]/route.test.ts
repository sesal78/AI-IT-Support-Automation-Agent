import { internalTicketViewSchema } from "@ai-it-support/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getTicketView = vi.hoisted(() => vi.fn());
const recordSecurityEvent = vi.hoisted(() => vi.fn());
vi.mock("@ai-it-support/db", () => ({
  createDbClient: () => ({}),
  createRepositories: () => ({ getTicketView, recordSecurityEvent }),
}));

const TOKEN = "fakeInternalApiToken0123456789ABCDEF";
const ID = "11111111-1111-4111-8111-111111111111";
const AT = "2026-10-01T10:00:00.000Z";
const MARKER = "m".repeat(20);

const view = {
  id: ID,
  status: "triaged",
  isTest: false,
  source: "web",
  createdAt: AT,
  redacted: { title: "VPN down", description: "Cannot connect" },
  triage: {
    sensitive: false,
    sensitiveFlags: [],
    category: "network",
    subcategory: null,
    priority: "P3",
    urgency: "medium",
    assignmentGroup: "Network",
    route: "auto",
    flags: [],
    probabilities: { network: 0.9 },
    groundingScore: 0.8,
    kbArticleIds: [],
    suggestedFix: null,
    modelVersions: {},
    triagedAt: AT,
  },
  aiCallCount: 2,
  events: [{ type: "received", at: AT }],
  reviews: [],
  notifications: [],
  autofix: [],
};

type Route = typeof import("./route");
let route: Route;

const auth = { authorization: `Bearer ${TOKEN}` };
const request = (method = "GET", headers: Record<string, string> = auth, query = "") =>
  new Request(`http://localhost/api/internal/tickets/x${query}`, { method, headers });
const call = (id: string, req = request()) => route.GET(req, { params: Promise.resolve({ id }) });

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
  getTicketView.mockReset();
  getTicketView.mockResolvedValue(view);
  recordSecurityEvent.mockReset();
  recordSecurityEvent.mockResolvedValue(undefined);
  route = await import("./route");
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe("GET /api/internal/tickets/:id", () => {
  it("returns 200 with a body that parses with internalTicketViewSchema", async () => {
    const res = await call(ID);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(internalTicketViewSchema.parse(await res.json())).toEqual(view);
    expect(getTicketView).toHaveBeenCalledWith(ID);
  });

  it("passes redacted: null, triage: null and aiCallCount: 0 through", async () => {
    getTicketView.mockResolvedValue({ ...view, redacted: null, triage: null, aiCallCount: 0 });
    const body = await (await call(ID)).json();
    expect(body).toMatchObject({ redacted: null, triage: null, aiCallCount: 0 });
  });

  it("drops raw columns a faulty repository returns, never echoing a marker", async () => {
    getTicketView.mockResolvedValue({
      ...view,
      raw_title: MARKER,
      raw_description: MARKER,
      requester_email: MARKER,
      requester_name: MARKER,
      department: MARKER,
    });
    const res = await call(ID);
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(MARKER);
  });

  it("fails with 500 and no marker when a nested object carries a stray key", async () => {
    getTicketView.mockResolvedValue({
      ...view,
      events: [{ type: "received", at: AT, payload: { note: MARKER } }],
    });
    const res = await call(ID);
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain(MARKER);
  });

  it("lowercases an uppercase UUID", async () => {
    expect((await call(ID.toUpperCase())).status).toBe(200);
    expect(getTicketView).toHaveBeenCalledWith(ID);
  });

  it.each([
    "not-a-uuid",
    "..",
    "%2e%2e",
    `{${ID}}`,
    `${ID}/../x`,
    `${ID}%00`,
    ` ${ID}`,
    "",
    "1".repeat(5000),
  ])("returns 400 invalid_id for %j without a database call", async (id) => {
    const res = await call(id);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_id" });
    expect(getTicketView).not.toHaveBeenCalled();
  });

  it("returns 404 not_found for an unknown ID", async () => {
    getTicketView.mockResolvedValue(null);
    const res = await call(ID);
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not_found" });
    expect(res.headers.get("cache-control")).toBe("no-store");
  });

  it("returns 500 internal_error without detail and logs only the class name", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    getTicketView.mockRejectedValue(new TypeError(`boom ${MARKER}`));
    const res = await call(ID);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('{"error":"internal_error"}');
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(JSON.stringify(log.mock.calls)).not.toContain(MARKER);
    expect(JSON.stringify(log.mock.calls)).toContain("TypeError");
  });
});

describe("authentication", () => {
  const bad: Record<string, Record<string, string>> = {
    "no token": {},
    "wrong token": { authorization: "Bearer wrong" },
  };

  it.each(Object.keys(bad))(
    "returns 401 with %s, before any ID check or database call",
    async (name) => {
      for (const id of [ID, "not-a-uuid"]) {
        const res = await call(id, request("GET", bad[name]));
        expect(res.status).toBe(401);
        expect(await res.json()).toEqual({ error: "unauthorized" });
        expect(res.headers.get("cache-control")).toBe("no-store");
      }
      expect(getTicketView).not.toHaveBeenCalled();
    },
  );

  it("returns 401 for a token in the query string", async () => {
    const res = await call(ID, request("GET", auth, `?token=${TOKEN}`));
    expect(res.status).toBe(401);
  });

  it.each(["POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const)(
    "%s: 401 without a token, 405 with one",
    async (method) => {
      const handler = route[method];
      const unauth = await handler(request(method, {}));
      expect(unauth.status).toBe(401);
      const authed = await handler(request(method));
      expect(authed.status).toBe(405);
      expect(authed.headers.get("allow")).toBe("GET, HEAD");
    },
  );
});
