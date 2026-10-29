import { healthConfigSchema } from "@ai-it-support/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const probeSchema = vi.hoisted(() => vi.fn());
vi.mock("@ai-it-support/db", () => ({
  createDbClient: () => ({}),
  createRepositories: () => ({ probeSchema }),
}));

const INTERNAL_TOKEN = "i".repeat(32);

function stubEnv(overrides: Record<string, string | undefined> = {}) {
  vi.stubEnv("NEXT_PHASE", undefined);
  vi.stubEnv("SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv("SUPABASE_SERVICE_ROLE_KEY", "fake-service-role-key");
  vi.stubEnv("SUPABASE_DB_SCHEMA", undefined);
  vi.stubEnv("TRIGGER_SECRET_KEY", "fake-trigger-secret");
  vi.stubEnv("SHADOW_MODE", undefined);
  vi.stubEnv("ADMIN_HEALTH_TOKEN", "fake-admin-health-token");
  vi.stubEnv("APP_VERSION", "1.4.2-test");
  vi.stubEnv("TURNSTILE_SECRET_KEY", "fake-turnstile-secret");
  vi.stubEnv("TURNSTILE_SITE_KEY", "fake-turnstile-site");
  vi.stubEnv("INTERNAL_API_TOKEN", INTERNAL_TOKEN);
  vi.stubEnv("E2E_MODE", undefined);
  for (const [key, value] of Object.entries(overrides)) vi.stubEnv(key, value);
}

type Route = typeof import("./route");
async function load(overrides?: Record<string, string | undefined>): Promise<Route> {
  stubEnv(overrides);
  return import("./route");
}

beforeEach(() => {
  vi.resetModules();
  probeSchema.mockReset();
  probeSchema.mockResolvedValue({ database: true, migration0003: true, migration0005: true });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GET /api/health/config", () => {
  it("returns 200 with APP_VERSION and every feature true except e2eMode", async () => {
    const { GET } = await load();
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      version: "1.4.2-test",
      features: {
        database: true,
        migration0003: true,
        migration0005: true,
        pipelineTrigger: true,
        turnstile: true,
        internalApi: true,
        e2eMode: false,
      },
    });
  });

  it("follows E2E_MODE=true", async () => {
    const { GET } = await load({ E2E_MODE: "true" });
    const body = await (await GET()).json();
    expect(body.features.e2eMode).toBe(true);
  });

  it("reports migration0003 false but database true when one probe fails, still 200", async () => {
    probeSchema.mockResolvedValue({ database: true, migration0003: false, migration0005: true });
    const { GET } = await load();
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.features.database).toBe(true);
    expect(body.features.migration0003).toBe(false);
  });

  it("reports migration0005 false with status 200 and the other flags unchanged when only the reviews probe fails", async () => {
    probeSchema.mockResolvedValue({ database: true, migration0003: true, migration0005: false });
    const { GET } = await load();
    const res = await GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(healthConfigSchema.safeParse(body).success).toBe(true);
    expect(body.features).toEqual({
      database: true,
      migration0003: true,
      migration0005: false,
      pipelineTrigger: true,
      turnstile: true,
      internalApi: true,
      e2eMode: false,
    });
  });

  it("reports database and migration0003 false, 200, no error text, when the probe throws", async () => {
    probeSchema.mockRejectedValue(new Error("connect ECONNREFUSED marker-db-error"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await load();
    const res = await GET();
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain("marker-db-error");
    expect(text).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(spy.mock.calls)).not.toContain("marker-db-error");
    const body = JSON.parse(text);
    expect(body.features.database).toBe(false);
    expect(body.features.migration0003).toBe(false);
    expect(Object.keys(body).sort()).toEqual(["features", "version"]);
  });

  it("parses with the strict schema: only version and features, booleans only", async () => {
    const { GET } = await load();
    const body = await (await GET()).json();
    expect(healthConfigSchema.safeParse(body).success).toBe(true);
    expect(Object.keys(body).sort()).toEqual(["features", "version"]);
    for (const value of Object.values(body.features)) expect(typeof value).toBe("boolean");
  });

  it("leaks no env value except APP_VERSION, in body or headers", async () => {
    // One repeated letter per variable: unique, low entropy, never a substring of another.
    const markers: Record<string, string> = {
      SUPABASE_URL: `https://${"c".repeat(20)}.example.co`,
      SUPABASE_SERVICE_ROLE_KEY: "a".repeat(24),
      SUPABASE_DB_SCHEMA: "b".repeat(24),
      TRIGGER_SECRET_KEY: "d".repeat(24),
      ADMIN_HEALTH_TOKEN: "e".repeat(24),
      TURNSTILE_SECRET_KEY: "f".repeat(24),
      TURNSTILE_SITE_KEY: "g".repeat(24),
      INTERNAL_API_TOKEN: "q".repeat(32),
      TYPESAFE_API_KEY: "h".repeat(24),
    };
    const version = "v".repeat(10);
    const { GET } = await load({ ...markers, APP_VERSION: version });
    const res = await GET();
    const text = await res.text();
    const headers = JSON.stringify([...res.headers]);
    for (const [name, marker] of Object.entries(markers)) {
      expect(text, name).not.toContain(marker);
      expect(headers, name).not.toContain(marker);
    }
    expect(text).toContain(version);
  });

  it("calls the probe once for ten requests inside 60 seconds, again after 61", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-10-08T10:00:00Z"));
    const { GET } = await load();
    for (let i = 0; i < 10; i++) {
      await GET();
      vi.advanceTimersByTime(5_000);
    }
    expect(probeSchema).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(61_000);
    await GET();
    expect(probeSchema).toHaveBeenCalledTimes(2);
  });

  it("takes no request, so a query string cannot influence the body", async () => {
    const { GET } = await load();
    expect(GET.length).toBe(0);
  });
});

describe("other methods on /api/health/config", () => {
  it.each(["POST", "PUT", "PATCH", "DELETE"] as const)(
    "%s returns 405 with Allow",
    async (method) => {
      const route = await load();
      const res = route[method]();
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
      expect(await res.text()).toBe("");
      expect(probeSchema).not.toHaveBeenCalled();
    },
  );

  it("OPTIONS lists only the allowed methods", async () => {
    const { OPTIONS } = await load();
    const res = OPTIONS();
    expect(res.status).toBe(204);
    expect(res.headers.get("allow")).toBe("GET, HEAD, OPTIONS");
  });
});
