import { healthConfigSchema } from "@ai-it-support/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const probeSchema = vi.hoisted(() => vi.fn());
const probeBuiltinHelpdesk = vi.hoisted(() => vi.fn());
vi.mock("@ai-it-support/db", () => ({
  createDbClient: () => ({}),
  createRepositories: () => ({ probeSchema, probeBuiltinHelpdesk }),
}));

const runs = vi.hoisted(() => ({ list: vi.fn(), retrieve: vi.fn() }));
vi.mock("@trigger.dev/sdk", () => ({ runs }));

const MIN = 60_000;
type Said = "ok" | "asleep" | "down";
/** The latest completed helpdesk-health run: finished `ageMs` before the clock reads now. */
function latestRun(status: Said, ageMs = 10 * MIN) {
  runs.list.mockImplementation(async () => ({
    data: [
      {
        id: "run_abc123",
        createdAt: new Date(Date.now() - ageMs - 5_000),
        finishedAt: new Date(Date.now() - ageMs),
      },
    ],
  }));
  runs.retrieve.mockResolvedValue({
    output: {
      connector: "servicenow",
      status,
      checkedAt: new Date(Date.now() - ageMs).toISOString(),
    },
  });
}

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
  vi.stubEnv("SLACK_SIGNING_SECRET", "k".repeat(32));
  vi.stubEnv("SLACK_REVIEWER_IDS", "U0000000001");
  vi.stubEnv("SLACK_CHANNEL_ID", "C0000000001");
  vi.stubEnv("HELPDESK", "servicenow");
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
  probeBuiltinHelpdesk.mockReset();
  probeBuiltinHelpdesk.mockResolvedValue(true);
  runs.list.mockReset();
  runs.retrieve.mockReset();
  latestRun("ok");
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
      helpdesk: "servicenow",
      features: {
        database: true,
        migration0003: true,
        migration0005: true,
        pipelineTrigger: true,
        turnstile: true,
        internalApi: true,
        e2eMode: false,
        slackInteractivity: true,
        helpdeskReachable: true,
        helpdeskAsleep: false,
        builtinHelpdesk: false,
      },
    });
    expect(probeBuiltinHelpdesk).not.toHaveBeenCalled();
  });

  it("HELPDESK=builtin: reports the configured value and builtinHelpdesk from the 0007 and 0008 probe", async () => {
    const { GET } = await load({ HELPDESK: "builtin" });
    const body = await (await GET()).json();
    expect(healthConfigSchema.safeParse(body).success).toBe(true);
    expect(body.helpdesk).toBe("builtin");
    expect(body.features.builtinHelpdesk).toBe(true);
    vi.resetModules();
    probeBuiltinHelpdesk.mockResolvedValue(false);
    const missing = await (await (await load({ HELPDESK: "builtin" })).GET()).json();
    expect(missing.features.builtinHelpdesk).toBe(false);
    expect(missing.helpdesk).toBe("builtin");
  });

  it.each([undefined, "", "ServiceNow", "jira"])(
    "HELPDESK %j stops the route at boot, naming it",
    async (value) => {
      await expect(load({ HELPDESK: value })).rejects.toThrow(/HELPDESK/);
    },
  );

  it("reports slackInteractivity true with the Slack env set, and the schema stays strict", async () => {
    const { GET } = await load();
    const body = await (await GET()).json();
    expect(body.features.slackInteractivity).toBe(true);
    expect(healthConfigSchema.safeParse(body).success).toBe(true);
    const extra = { ...body, features: { ...body.features, slackInteractivity: "yes" } };
    expect(healthConfigSchema.safeParse(extra).success).toBe(false);
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
      slackInteractivity: true,
      helpdeskReachable: true,
      helpdeskAsleep: false,
      builtinHelpdesk: false,
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
    expect(Object.keys(body).sort()).toEqual(["features", "helpdesk", "version"]);
  });

  it("parses with the strict schema: version, the helpdesk word and boolean features only", async () => {
    const { GET } = await load();
    const body = await (await GET()).json();
    expect(healthConfigSchema.safeParse(body).success).toBe(true);
    expect(Object.keys(body).sort()).toEqual(["features", "helpdesk", "version"]);
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
      SLACK_SIGNING_SECRET: "j".repeat(32),
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

  it("reports helpdeskReachable true for a fresh ok run and asleep false", async () => {
    const { GET } = await load();
    const body = await (await GET()).json();
    expect(body.features).toMatchObject({ helpdeskReachable: true, helpdeskAsleep: false });
  });

  it("reports helpdeskAsleep true and helpdeskReachable false for a fresh asleep run", async () => {
    latestRun("asleep");
    const { GET } = await load();
    const body = await (await GET()).json();
    expect(healthConfigSchema.safeParse(body).success).toBe(true);
    expect(body.features).toMatchObject({ helpdeskReachable: false, helpdeskAsleep: true });
  });

  it("reports both false for a 46 minute old ok run and for a down run", async () => {
    latestRun("ok", 46 * MIN);
    const old = await (await (await load()).GET()).json();
    expect(old.features).toMatchObject({ helpdeskReachable: false, helpdeskAsleep: false });
    vi.resetModules();
    latestRun("down", 1 * MIN);
    const down = await (await (await load()).GET()).json();
    expect(down.features).toMatchObject({ helpdeskReachable: false, helpdeskAsleep: false });
  });

  it("reports both false when no helpdesk-health run has completed", async () => {
    runs.list.mockResolvedValue({ data: [] });
    const { GET } = await load();
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).features).toMatchObject({
      helpdeskReachable: false,
      helpdeskAsleep: false,
    });
    expect(runs.retrieve).not.toHaveBeenCalled();
  });

  it("answers 200 with both false and no error text when the Trigger.dev SDK throws", async () => {
    const note = "MARKER-sdk-error dev420188.service-now.com INC0010001";
    runs.list.mockRejectedValue(new Error(note));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { GET } = await load();
    const res = await GET();
    const text = await res.text();
    expect(res.status).toBe(200);
    for (const secret of ["MARKER-sdk-error", "service-now.com", "INC0010001"]) {
      expect(text).not.toContain(secret);
      expect(JSON.stringify([...res.headers])).not.toContain(secret);
      expect(JSON.stringify(spy.mock.calls)).not.toContain(secret);
    }
    expect(JSON.stringify(spy.mock.calls)).toContain("Error");
    const body = JSON.parse(text);
    expect(healthConfigSchema.safeParse(body).success).toBe(true);
    expect(body.features).toMatchObject({ helpdeskReachable: false, helpdeskAsleep: false });
    expect(body.features.database).toBe(true);
  });

  it("puts nothing from the run output into the body: booleans only (T3.S.03)", async () => {
    runs.list.mockResolvedValue({ data: [{ id: "run_abc123", createdAt: new Date() }] });
    runs.retrieve.mockResolvedValue({
      output: {
        connector: "servicenow",
        status: "ok",
        checkedAt: new Date().toISOString(),
        host: "dev420188.service-now.com",
        number: "INC0010001",
        error: "MARKER-run-error",
      },
    });
    const { GET } = await load();
    const res = await GET();
    const text = await res.text();
    for (const secret of ["dev420188", "service-now", "INC0010001", "MARKER-run-error"]) {
      expect(text).not.toContain(secret);
    }
    const body = JSON.parse(text);
    expect(healthConfigSchema.safeParse(body).success).toBe(true);
    for (const value of Object.values(body.features)) expect(typeof value).toBe("boolean");
  });

  it("makes one SDK request for ten requests inside 60 seconds, another after 61", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-11-10T10:00:00Z"));
    latestRun("ok");
    const { GET } = await load();
    for (let i = 0; i < 10; i++) {
      await GET();
      vi.advanceTimersByTime(5_000);
    }
    expect(runs.list).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(61_000);
    await GET();
    expect(runs.list).toHaveBeenCalledTimes(2);
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
